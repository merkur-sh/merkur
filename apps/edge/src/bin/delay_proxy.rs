//! merkur-edge-delay-proxy — a deterministic UDP network impairment relay.
//!
//! Both the browser and daemon connect through this relay. A terminal input and
//! its display response therefore cross four proxy legs; `BASE_DELAY_US` is one
//! quarter of the requested application RTT. Each leg also receives seeded,
//! centred jitter. The sum of two leg ranges equals the profile's advertised
//! one-way jitter span without biasing its median RTT upward.
//!
//! Usage:
//!   PROFILE=fast TARGET_RTT_MS=50 BASE_DELAY_US=12500 \
//!   JITTER_RADIUS_US=1250 DATAGRAM_LOSS_PERCENT=3 REORDER=light \
//!   SCENARIO=steady SEED=1296388675 \
//!   LISTEN_DAEMON=[::1]:4434 LISTEN_BROWSER=[::1]:4436 UPSTREAM=[::1]:4433 \
//!   BOTTLENECK_DAEMON_UP=10000000:262144 \
//!   cargo run -p merkur-edge --bin delay_proxy
//!
//! Each peer role owns a listener, and a relay's role is the listener it
//! arrived on: the edge registers the daemon listener, and the browser's
//! transport worker is pointed at the browser listener. At least one listener
//! is required. `LISTEN_COMPETITOR_<DAEMON|BROWSER>` adds a listener whose
//! relays reach `COMPETITOR_UPSTREAM` instead of the edge and cross that role's
//! links, so a competing flow shares the bottleneck with the session.
//!
//! `BOTTLENECK_<DAEMON|BROWSER>_<UP|DOWN>=<bit/s>:<bytes>[:fq][@<ms>=<bit/s>]`
//! gives a role one capacity link per direction, shared by every relay of that
//! role (see `link`). An uplink sits at ingress, before the leg's delay; a
//! downlink sits where the leg's delay releases a packet, before the loss site,
//! so a packet the loss site selects still occupies the link. `@<ms>=<bit/s>`
//! changes the rate that long after each trace mark or reset.
//!
//! Delay and centred jitter apply on both proxy directions, which gives four
//! delayed legs per browser -> daemon -> browser round trip. Destructive
//! impairments have exactly one site per logical application direction: the
//! edge-to-client downstream leg. Loss and reorder selections there are
//! seed-shuffled exact-rate traces over 100-packet windows, rather than
//! every-Nth patterns that can never lose two adjacent packets. `burst-loss`
//! adds a deterministic four-packet downstream loss burst; `congestion` adds
//! bounded downstream egress serialization windows on one shared bottleneck;
//! and `handshake-split` preserves the deliberately adversarial QUIC
//! coalescing split used by the 0.5-RTT regression gate.
//!
//! Every client relay (one UDP source, so one QUIC connection) owns its trace:
//! per-direction packet ordinals and a seed mixed from its admission sequence
//! and the current trace key. A relay's loss, jitter and reorder decisions
//! depend only on its own packets, never on another connection's volume. The
//! control verb `mark:<nonce>:<key>` restarts every relay's ordinals at its
//! next decision under that key, so two windows marked with one key replay the
//! same decisions relay by relay; `reset` does the same under key 0 and clears
//! the epoch's aggregate counters. Each relay keeps an exact since-mark ledger,
//! reported by `settle`, `mark` and `stats`. The trace keeps one more for every
//! relay together, which a relay that detaches cannot take with it; `settle`
//! and `mark` report it.
//!
//! The delay line itself never drops for capacity: only a declared link does,
//! and it counts those as `bottleneckDrops`. Each relay direction is an
//! unbounded channel into the task that releases every packet at its deadline,
//! and the relay's packet lease (65,535 packets across both directions,
//! including what its links hold) is the only bound. A packet refused by an
//! exhausted lease is counted and logged as a drop, which fails a harness run:
//! the proxy was overloaded, not the configured network.
//!
//! `source:<nonce>:<configured|ipv4-loopback>` moves every session browser
//! relay to a fresh upstream socket leaving from that source, and admits later
//! ones from it: to the edge, the browser's connections changed address, as a
//! phone's do when it moves networks under a connection that migrates. The old
//! socket stays read. `ipv4-loopback` needs a dual-stack upstream listener.

#[path = "delay_proxy/link.rs"]
mod link;

use std::collections::{HashMap, VecDeque};
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
use serde::ser::SerializeSeq;
use serde::{Serialize, Serializer};
use tokio::net::UdpSocket;
use tokio::sync::Notify;
use tokio::sync::mpsc;
use tokio::sync::mpsc::error::TryRecvError;
use tokio::sync::watch;
use tokio::task::JoinHandle;
use tokio::time::Instant;

use link::{
    Arrival, LINK_HEADER_BYTES, Link, LinkConfig, LinkDirection, LinkStatus, RelayLinkStatus, Role,
};

const MAX_PROXY_PACKET_BYTES: usize = 16 * 1024;
/// Relays the proxy holds at once: one per live connection through it.
///
/// Reclaiming a relay whose connection is still alive hands the edge a new
/// source address mid-connection, a migration no network profile configures.
/// The worker-scoped daemon keeps each finished spec's peer for its 60 s rebind
/// window with three connections (interactive, bulk, signaling). At 16 slots the
/// carrier-rebind suite held 21 live daemon connections by its sixth spec,
/// re-admitted them 109 times, and overflowed the admission handoff. Sized for
/// what the harness itself holds live, with room; the handoff guard still
/// invalidates a run that exceeds it.
const MAX_PROXY_CLIENTS: usize = 64;
/// Keep a compact, bounded history of sources that already proved they speak
/// QUIC by sending a valid Initial. If an active relay is reclaimed, a later
/// short-header packet from that exact source may recreate the upstream socket
/// and let QUIC's normal NAT-rebinding path recover the connection.
const MAX_KNOWN_SOURCE_TOMBSTONES: usize = 4096;
const QUIC_V1: u32 = 0x0000_0001;
const QUIC_V2: u32 = 0x6b33_43cf;
const RELAY_PENDING_BITS: u32 = 16;
const RELAY_PENDING_MASK: u64 = (1 << RELAY_PENDING_BITS) - 1;
const RELAY_ACTIVITY_MASK: u64 = (1 << (63 - RELAY_PENDING_BITS)) - 1;
const RELAY_RECLAIMING: u64 = 1 << 63;
static OVERSIZED_PACKET_DROPS: AtomicU64 = AtomicU64::new(0);
static CLIENT_ADMISSION_DROPS: AtomicU64 = AtomicU64::new(0);
static RELAY_LEASE_EXHAUSTIONS: AtomicU64 = AtomicU64::new(0);
static ORPHAN_PACKET_IGNORES: AtomicU64 = AtomicU64::new(0);
static IMPAIRMENT_PACKET_DROPS: AtomicU64 = AtomicU64::new(0);
static DOWNSTREAM_REORDER_INJECTIONS: AtomicU64 = AtomicU64::new(0);
static DOWNSTREAM_COALESCED_SPLITS: AtomicU64 = AtomicU64::new(0);
static CLIENT_RELAY_RECLAIMS: AtomicU64 = AtomicU64::new(0);
static CLIENT_RELAY_REACTIVATIONS: AtomicU64 = AtomicU64::new(0);
static TOMBSTONE_EVICTIONS: AtomicU64 = AtomicU64::new(0);

const LOSS_WINDOW_PACKETS: u64 = 100;
const BURST_LOSS_CYCLE_PACKETS: u64 = 400;
const BURST_LOSS_PACKETS: u64 = 4;
const CONGESTION_CYCLE_PACKETS: u64 = 256;
const CONGESTION_WINDOW_PACKETS: u64 = 48;
const CONGESTION_PACKET_SPACING_US: u64 = 1_000;
const CONGESTION_MAX_QUEUE_DELAY_US: u64 = 32_000;
const DELAY_HISTOGRAM_BUCKET_US: u64 = 500;
const DELAY_HISTOGRAM_BUCKETS: usize = 512;
const IMPAIRMENT_STATS_SCHEMA_VERSION: u8 = 9;
/// Trace keys cross the control plane as JSON numbers, so they stay exact in a
/// JavaScript double. Key 0 belongs to `reset`.
const MAX_TRACE_MARK_KEY: u64 = 1 << 53;
/// macOS defaults `net.inet.udp.maxdgram` to 9,216 bytes. Full statistics
/// snapshots contain eight fixed 512-bucket histograms, so a single JSON UDP
/// response is not portable even when every bucket is zero. Keep each encoded
/// control chunk comfortably below that kernel boundary.
const CONTROL_RESPONSE_CHUNK_PAYLOAD_BYTES: usize = 4 * 1024;
const MAX_CONTROL_RESPONSE_DATAGRAM_BYTES: usize = 8 * 1024;
const MAX_CONTROL_RESPONSE_CHUNKS: usize = 64;
const CONTROL_RESPONSE_CACHE_CAPACITY: usize = 16;
const CONTROL_RESPONSE_CACHE_TTL: Duration = Duration::from_secs(5);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum ReorderMode {
    None,
    Light,
    Moderate,
}

impl ReorderMode {
    fn rate_percent(self) -> u64 {
        match self {
            Self::None => 0,
            Self::Light => 1,
            Self::Moderate => 5,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum ImpairmentScenario {
    Steady,
    BurstLoss,
    Congestion,
    HandshakeSplit,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum ImpairmentFaultSite {
    EdgeToClient,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImpairmentConfig {
    profile: String,
    target_rtt_ms: u64,
    base_delay_us: u64,
    jitter_radius_us: u64,
    datagram_loss_percent: u64,
    fault_site: ImpairmentFaultSite,
    fault_sites_per_logical_direction: u8,
    reorder: ReorderMode,
    scenario: ImpairmentScenario,
    seed: u64,
}

impl ImpairmentConfig {
    fn from_env() -> Self {
        let profile = required_env("PROFILE");
        let target_rtt_ms = required_u64_env("TARGET_RTT_MS");
        let base_delay_us = required_u64_env("BASE_DELAY_US");
        let jitter_radius_us = required_u64_env("JITTER_RADIUS_US");
        let datagram_loss_percent = required_u64_env("DATAGRAM_LOSS_PERCENT");
        assert!(
            matches!(datagram_loss_percent, 0 | 1 | 3 | 9),
            "DATAGRAM_LOSS_PERCENT must be one of 0, 1, 3, 9"
        );
        let expected_shape = match profile.as_str() {
            "fast" => (50, 12_500, 1_250),
            "typical" => (120, 30_000, 3_750),
            "difficult" => (200, 50_000, 7_500),
            _ => panic!("PROFILE must be one of fast, typical, difficult"),
        };
        assert_eq!(
            (target_rtt_ms, base_delay_us, jitter_radius_us),
            expected_shape,
            "profile target RTT, four-leg hop delay, and jitter radius must match"
        );
        let reorder = match required_env("REORDER").as_str() {
            "none" => ReorderMode::None,
            "light" => ReorderMode::Light,
            "moderate" => ReorderMode::Moderate,
            _ => panic!("REORDER must be one of none, light, moderate"),
        };
        let scenario = match required_env("SCENARIO").as_str() {
            "steady" => ImpairmentScenario::Steady,
            "burst-loss" => ImpairmentScenario::BurstLoss,
            "congestion" => ImpairmentScenario::Congestion,
            "handshake-split" => ImpairmentScenario::HandshakeSplit,
            _ => panic!("SCENARIO must be one of steady, burst-loss, congestion, handshake-split"),
        };
        let seed = required_u64_env("SEED");
        assert!(seed <= u64::from(u32::MAX), "SEED must fit in u32");
        Self {
            profile,
            target_rtt_ms,
            base_delay_us,
            jitter_radius_us,
            datagram_loss_percent,
            fault_site: ImpairmentFaultSite::EdgeToClient,
            fault_sites_per_logical_direction: 1,
            reorder,
            scenario,
            seed,
        }
    }

    fn split_one_rtt(&self) -> bool {
        self.scenario == ImpairmentScenario::HandshakeSplit
    }
}

/// Whose relays a listener admits, and whether they are a competing flow
/// rather than the session's own connections.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct ListenerId {
    role: Role,
    competitor: bool,
}

struct Listener {
    id: ListenerId,
    socket: Arc<UdpSocket>,
    /// Where its relays forward: the edge, or the competitor's server.
    upstream: SocketAddr,
}

fn role_env(role: Role) -> &'static str {
    match role {
        Role::Daemon => "DAEMON",
        Role::Browser => "BROWSER",
    }
}

fn direction_env(direction: LinkDirection) -> &'static str {
    match direction {
        LinkDirection::Up => "UP",
        LinkDirection::Down => "DOWN",
    }
}

/// Every declared link, in role then direction order.
fn links_from_env() -> Vec<LinkConfig> {
    let mut links = Vec::new();
    for role in [Role::Daemon, Role::Browser] {
        for direction in [LinkDirection::Up, LinkDirection::Down] {
            let name = format!("BOTTLENECK_{}_{}", role_env(role), direction_env(direction));
            if let Ok(spec) = std::env::var(&name) {
                links.push(
                    LinkConfig::parse(role, direction, &spec)
                        .unwrap_or_else(|error| panic!("{name}: {error}")),
                );
            }
        }
    }
    links
}

/// A packet inside a link, and where it goes when it departs.
struct LinkPacket {
    packet: DelayedPacket,
    exit: LinkExit,
}

enum LinkExit {
    /// An uplink hands the packet to its relay's delay line, which releases it
    /// the leg's delay after its departure.
    DelayLine {
        tx: mpsc::UnboundedSender<DelayedPacket>,
        delay: Duration,
    },
    /// A downlink sends it to the client, unless the loss site behind the link
    /// selected it.
    Client {
        socket: Arc<UdpSocket>,
        client: SocketAddr,
    },
}

async fn release_link_packet(link_packet: LinkPacket, departure: Instant) -> bool {
    let LinkPacket { mut packet, exit } = link_packet;
    match exit {
        LinkExit::DelayLine { tx, delay } => {
            packet.deadline = departure + delay;
            packet.target_residence_us = u64::try_from(
                packet
                    .deadline
                    .saturating_duration_since(packet.enqueued_at)
                    .as_micros(),
            )
            .unwrap_or(u64::MAX);
            // A relay that ended meanwhile takes the packet (and its lease)
            // with it.
            let _ = tx.send(packet);
            true
        }
        LinkExit::Client { socket, client } => {
            if packet.lost {
                return false;
            }
            let _ = socket.send_to(&packet.data, client).await;
            true
        }
    }
}

fn spawn_links(configs: &[LinkConfig]) -> Vec<Link<LinkPacket>> {
    configs
        .iter()
        .map(|config| Link::spawn(*config, MAX_PROXY_CLIENTS, release_link_packet))
        .collect()
}

fn required_env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("{name} is required"))
}

fn required_u64_env(name: &str) -> u64 {
    required_env(name)
        .parse()
        .unwrap_or_else(|_| panic!("{name} must be an unsigned integer"))
}

struct RelayState {
    /// One CAS domain prevents a packet from refreshing activity between an
    /// LRU snapshot and its zero-pending reclaim claim:
    /// [ reclaim bit | 47-bit activity ordinal | 16-bit pending count ].
    state: AtomicU64,
    quiescence: Arc<Notify>,
    /// `[upstream, downstream]` packets in this relay's delay lines right now.
    in_flight: [AtomicU64; 2],
    /// The most each delay line has held at once since the trace mark,
    /// counting what it held at the mark.
    max_in_flight: [AtomicU64; 2],
}

/// Why a relay refused a packet lease.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LeaseRefusal {
    /// Reclaimed or closed: its tasks are ending, and the packet goes nowhere.
    Closed,
    /// All 65,535 of its packet leases are held. Only an overloaded proxy gets
    /// here; the relay stays and loses this one packet.
    Exhausted,
}

impl Default for RelayState {
    fn default() -> Self {
        Self::with_quiescence(Arc::new(Notify::new()))
    }
}

impl RelayState {
    fn with_quiescence(quiescence: Arc<Notify>) -> Self {
        Self {
            state: AtomicU64::new(0),
            quiescence,
            in_flight: [AtomicU64::new(0), AtomicU64::new(0)],
            max_in_flight: [AtomicU64::new(0), AtomicU64::new(0)],
        }
    }

    fn snapshot(&self) -> u64 {
        self.state.load(Ordering::Acquire)
    }

    fn last_activity(snapshot: u64) -> u64 {
        (snapshot >> RELAY_PENDING_BITS) & RELAY_ACTIVITY_MASK
    }

    fn try_acquire_packet(
        self: &Arc<Self>,
        activity_clock: &AtomicU64,
    ) -> Result<PendingPacketGuard, LeaseRefusal> {
        loop {
            let current = self.state.load(Ordering::Acquire);
            if current & RELAY_RECLAIMING != 0 {
                return Err(LeaseRefusal::Closed);
            }
            let pending = current & RELAY_PENDING_MASK;
            if pending == RELAY_PENDING_MASK {
                return Err(LeaseRefusal::Exhausted);
            }
            let activity = activity_clock
                .fetch_add(1, Ordering::Relaxed)
                .wrapping_add(1)
                & RELAY_ACTIVITY_MASK;
            let next = (activity << RELAY_PENDING_BITS) | (pending + 1);
            if self
                .state
                .compare_exchange_weak(current, next, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
            {
                return Ok(PendingPacketGuard {
                    relay: self.clone(),
                });
            }
        }
    }

    // The occupancy counters are sequentially consistent so that a mark
    // restarting the maximum while a packet enters can never leave it below
    // what the line holds: whichever comes first in the one total order, the
    // other sees it.
    fn enter_delay_line(&self, direction: ImpairmentDirection) {
        let held = self.in_flight[direction.index()].fetch_add(1, Ordering::SeqCst) + 1;
        self.max_in_flight[direction.index()].fetch_max(held, Ordering::SeqCst);
    }

    fn leave_delay_line(&self, direction: ImpairmentDirection) {
        let previous = self.in_flight[direction.index()].fetch_sub(1, Ordering::SeqCst);
        debug_assert!(previous > 0);
    }

    fn max_in_flight(&self, direction: ImpairmentDirection) -> u64 {
        self.max_in_flight[direction.index()].load(Ordering::SeqCst)
    }

    /// Starts each line's maximum again at what it holds now.
    fn restart_max_in_flight(&self) {
        for (held, max) in self.in_flight.iter().zip(&self.max_in_flight) {
            max.store(0, Ordering::SeqCst);
            max.fetch_max(held.load(Ordering::SeqCst), Ordering::SeqCst);
        }
    }

    /// Atomically claims an exactly quiescent relay. Once claimed, concurrent
    /// edge readers cannot admit another delayed packet before its tasks stop.
    fn try_claim_reclaim(&self, expected: u64) -> bool {
        if expected & (RELAY_RECLAIMING | RELAY_PENDING_MASK) != 0 {
            return false;
        }
        self.state
            .compare_exchange(
                expected,
                expected | RELAY_RECLAIMING,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .is_ok()
    }

    fn close(&self) {
        self.state.fetch_or(RELAY_RECLAIMING, Ordering::AcqRel);
    }

    fn pending_packets(&self) -> usize {
        (self.state.load(Ordering::Acquire) & RELAY_PENDING_MASK) as usize
    }
}

struct PendingPacketGuard {
    relay: Arc<RelayState>,
}

impl Drop for PendingPacketGuard {
    fn drop(&mut self) {
        let previous = self.relay.state.fetch_sub(1, Ordering::AcqRel);
        debug_assert!(previous & RELAY_PENDING_MASK > 0);
        if previous & RELAY_PENDING_MASK == 1 {
            self.relay.quiescence.notify_one();
        }
    }
}

struct UnadmittedDelayedPacket {
    deadline: Instant,
    trace_epoch: u64,
    trace_generation: u64,
    trace_sequence: u64,
    trace_reorder_selected: bool,
    /// Selected by the loss site. Only a relay whose role has a downlink
    /// carries such a packet: it still occupies the link, and the link's
    /// release drops it.
    lost: bool,
    data: Vec<u8>,
}

struct DelayedPacket {
    deadline: Instant,
    enqueued_at: Instant,
    target_residence_us: u64,
    trace_epoch: u64,
    /// With `trace_sequence`, the packet's decision order on its relay: a mark
    /// restarts the sequence but advances the generation.
    trace_generation: u64,
    trace_sequence: u64,
    trace_reorder_selected: bool,
    lost: bool,
    data: Vec<u8>,
    _place: DelayLinePlace,
}

/// A packet's place in one direction's delay line. It holds the relay's packet
/// lease and counts toward the line's occupancy until the packet is sent or
/// dropped.
struct DelayLinePlace {
    lease: PendingPacketGuard,
    direction: ImpairmentDirection,
}

impl Drop for DelayLinePlace {
    fn drop(&mut self) {
        self.lease.relay.leave_delay_line(self.direction);
    }
}

impl DelayedPacket {
    fn new(
        scheduled: UnadmittedDelayedPacket,
        lease: PendingPacketGuard,
        direction: ImpairmentDirection,
    ) -> DelayedPacket {
        let UnadmittedDelayedPacket {
            deadline,
            trace_epoch,
            trace_generation,
            trace_sequence,
            trace_reorder_selected,
            lost,
            data,
        } = scheduled;
        let enqueued_at = Instant::now();
        let target_residence_us =
            u64::try_from(deadline.saturating_duration_since(enqueued_at).as_micros())
                .unwrap_or(u64::MAX);
        lease.relay.enter_delay_line(direction);
        DelayedPacket {
            deadline,
            enqueued_at,
            target_residence_us,
            trace_epoch,
            trace_generation,
            trace_sequence,
            trace_reorder_selected,
            lost,
            data,
            _place: DelayLinePlace { lease, direction },
        }
    }
}

/// Orders a `BinaryHeap` of [`DelayedPacket`] as a min-heap on `deadline`
/// (std's `BinaryHeap` is a max-heap), so the earliest-due packet pops first
/// regardless of arrival order. `Vec<u8>` and `DelayLinePlace` are not
/// comparable, so this wraps the packet purely to carry an `Ord` impl scoped
/// to the one field that determines release order.
struct HeapEntry(DelayedPacket);

impl PartialEq for HeapEntry {
    fn eq(&self, other: &Self) -> bool {
        self.0.deadline == other.0.deadline
    }
}

impl Eq for HeapEntry {}

impl PartialOrd for HeapEntry {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for HeapEntry {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        other.0.deadline.cmp(&self.0.deadline)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ImpairmentDirection {
    Upstream,
    Downstream,
}

impl ImpairmentDirection {
    fn index(self) -> usize {
        match self {
            Self::Upstream => 0,
            Self::Downstream => 1,
        }
    }
}

struct NetworkImpairment {
    config: ImpairmentConfig,
    /// Every declared link. A link's own state is behind its own lock, which
    /// its task never holds while taking this one's.
    links: Vec<Link<LinkPacket>>,
    state: Mutex<NetworkImpairmentState>,
}

/// The trace every relay follows. `generation` advances on each `mark` and
/// `reset`; `key` seeds the decisions after it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct TraceMark {
    generation: u64,
    key: u64,
}

struct NetworkImpairmentState {
    epoch: u64,
    mark: TraceMark,
    /// Every relay's decisions since the mark together. A relay's own ledger
    /// leaves with its slot when it detaches; its packets stay counted here.
    since_mark: RelayLedger,
    /// One fixed slot per admissible client relay: a decision never allocates.
    relays: [Option<RelayTrace>; MAX_PROXY_CLIENTS],
    upstream: DirectionCounters,
    downstream: DirectionCounters,
    /// The one downstream bottleneck every relay's congestion windows share.
    congestion_release_cursor: Option<Instant>,
    exact_loss_windows_completed: u64,
    exact_loss_dropped_in_completed_windows: u64,
}

// By hand: `Default` is derived for arrays of at most 32 elements.
impl Default for NetworkImpairmentState {
    fn default() -> Self {
        Self {
            epoch: 0,
            mark: TraceMark::default(),
            since_mark: RelayLedger::default(),
            relays: std::array::from_fn(|_| None),
            upstream: DirectionCounters::default(),
            downstream: DirectionCounters::default(),
            congestion_release_cursor: None,
            exact_loss_windows_completed: 0,
            exact_loss_dropped_in_completed_windows: 0,
        }
    }
}

/// One client relay's deterministic trace.
struct RelayTrace {
    admission_seq: u64,
    /// The listener it arrived on: its role's links apply to it.
    listener: ListenerId,
    /// Its socket's port toward the upstream, which is the address the edge
    /// sees for this connection.
    upstream_port: u16,
    /// The relay's own packet lease, so a status reports its exact pending count.
    state: Arc<RelayState>,
    /// The mark this trace last restarted at. A decision under a newer mark
    /// restarts the trace first, so a mark costs nothing per idle relay.
    mark_generation: u64,
    /// `[upstream, downstream]` ordinals since the mark.
    sequence: [u64; 2],
    /// Exact-loss drops in the current downstream 100-packet window.
    window_exact_drops: u64,
    since_mark: RelayLedger,
}

/// Packets decided since a trace mark: one relay's, or every relay's together.
#[derive(Clone, Copy, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct RelayLedger {
    up_seen: u64,
    down_seen: u64,
    down_dropped: u64,
    down_reordered: u64,
}

impl RelayLedger {
    fn record(&mut self, direction: ImpairmentDirection, dropped: bool, reordered: bool) {
        match direction {
            ImpairmentDirection::Upstream => self.up_seen = self.up_seen.wrapping_add(1),
            ImpairmentDirection::Downstream => {
                self.down_seen = self.down_seen.wrapping_add(1);
                if dropped {
                    self.down_dropped = self.down_dropped.wrapping_add(1);
                }
                if reordered {
                    self.down_reordered = self.down_reordered.wrapping_add(1);
                }
            }
        }
    }
}

#[derive(Default)]
struct DirectionCounters {
    seen: u64,
    forwarded: u64,
    dropped: u64,
    exact_loss_dropped: u64,
    burst_loss_dropped: u64,
    burst_loss_runs_completed: u64,
    jittered: u64,
    reorder_inversions: u64,
    reordered: u64,
    congested: u64,
    congested_forwarded: u64,
    congestion_clamped: u64,
    max_congestion_queue_delay_us: u64,
    max_forwarded_congestion_queue_delay_us: u64,
    scheduled_delay: DelaySamples,
    release_target_residence: DelaySamples,
    actual_residence: DelaySamples,
    release_overshoot: DelaySamples,
    release_early_count: u64,
    max_release_early_us: u64,
}

struct DelaySamples {
    count: u64,
    sum_us: u128,
    min_us: u64,
    max_us: u64,
    histogram: [u64; DELAY_HISTOGRAM_BUCKETS],
}

impl Default for DelaySamples {
    fn default() -> Self {
        Self {
            count: 0,
            sum_us: 0,
            min_us: u64::MAX,
            max_us: 0,
            histogram: [0; DELAY_HISTOGRAM_BUCKETS],
        }
    }
}

#[derive(Clone, Copy)]
struct PacketDecision {
    deadline: Instant,
    trace_epoch: u64,
    trace_generation: u64,
    trace_sequence: u64,
    dropped: bool,
    reordered: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NetworkImpairmentStats {
    schema_version: u8,
    epoch: u64,
    config: ImpairmentConfig,
    upstream: DirectionStats,
    downstream: DirectionStats,
    logical_path_impairment: LogicalPathImpairmentStats,
    harness_drops: HarnessDropStats,
    split_datagrams: u64,
    /** Delayed UDP packets still owned by any live relay at sample time. */
    pending_scheduled_packets: u64,
    /** Downstream 100-packet loss windows completed on any relay this epoch. */
    exact_loss_windows_completed: u64,
    /** Exact-loss drops inside those windows: always the percent times the count. */
    exact_loss_dropped_in_completed_windows: u64,
    relays: RelayStatuses,
    /** Every declared link since the reset. */
    links: Vec<LinkStatus>,
    /** Each live relay's use of its role's links since the mark. */
    relay_links: Vec<RelayLinks>,
}

/// One live relay's links since the mark, keyed like its `RelayStatus`.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RelayLinks {
    admission_seq: u64,
    listener: ListenerId,
    upstream_port: u16,
    links: Vec<RelayLinkStatus>,
}

/// Constant-size control-plane snapshot used only by settle polling.
///
/// Full impairment statistics contain eight 512-bucket histograms. Serializing
/// those on the biased forwarding task every 25 ms made the measurement oracle
/// perturb the packet schedule it was measuring. These monotonic high-waters
/// are sufficient to detect ingress, loss, and actual userspace release; the
/// full histogram snapshot remains the one artifact captured after quiescence.
/// At most sixteen fixed relay entries keep it bounded as well.
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProxySettleStatus {
    schema_version: u8,
    epoch: u64,
    mark: TraceMark,
    /// Every relay's ledger since `mark` together, a detached relay's included.
    since_mark: RelayLedger,
    upstream: SettleDirectionStatus,
    downstream: SettleDirectionStatus,
    harness_drops: HarnessDropStats,
    split_datagrams: u64,
    pending_scheduled_packets: u64,
    relays: RelayStatuses,
}

/// One live relay's pending packets, its ledger since the current mark, and
/// the most packets each of its delay lines has held at once since the mark.
#[derive(Clone, Copy, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct RelayStatus {
    admission_seq: u64,
    /// Whose relay it is, so a consumer can tell the daemon's connections from
    /// the browser's and a competitor's.
    listener: ListenerId,
    /// The address the edge sees for this connection is this port on the
    /// proxy's host.
    upstream_port: u16,
    pending: u64,
    up_seen: u64,
    down_seen: u64,
    down_dropped: u64,
    down_reordered: u64,
    up_max_in_flight: u64,
    down_max_in_flight: u64,
    /// Dropped by its role's links since the mark: capacity, not impairment.
    bottleneck_drops: u64,
}

impl Default for ListenerId {
    /// Only the unused slots of a fixed status array hold this; it is never
    /// serialized.
    fn default() -> Self {
        Self {
            role: Role::Daemon,
            competitor: false,
        }
    }
}

/// Live relays in admission order, held in a fixed array so a settle poll
/// formats them without building a list.
#[derive(Clone, Copy, Debug)]
struct RelayStatuses {
    len: usize,
    entries: [RelayStatus; MAX_PROXY_CLIENTS],
}

impl Serialize for RelayStatuses {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut sequence = serializer.serialize_seq(Some(self.len))?;
        for relay in &self.entries[..self.len] {
            sequence.serialize_element(relay)?;
        }
        sequence.end()
    }
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SettleDirectionStatus {
    seen: u64,
    forwarded: u64,
    dropped: u64,
    /** Delayed UDP units whose userspace release deadline was observed. */
    released: u64,
    reorder_inversions: u64,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DirectionStats {
    seen: u64,
    forwarded: u64,
    dropped: u64,
    exact_loss_dropped: u64,
    burst_loss_dropped: u64,
    burst_loss_runs_completed: u64,
    jittered: u64,
    /** Packets actually released after a later trace sequence. */
    reorder_inversions: u64,
    /** Packets selected for deterministic reorder holdback. */
    reordered: u64,
    congested: u64,
    /** Congestion-window packets that survived loss and entered the scheduler. */
    congested_forwarded: u64,
    congestion_clamped: u64,
    max_congestion_queue_delay_us: u64,
    /** Maximum congestion queue delay among packets actually scheduled. */
    max_forwarded_congestion_queue_delay_us: u64,
    achieved_packet_loss_percent: f64,
    /** Controller-selected delay for each non-dropped ingress UDP packet. */
    scheduled_delay_us: DelayDistribution,
    /** Per released UDP unit's enqueue-to-deadline target (split units included). */
    release_target_residence_us: DelayDistribution,
    /** Observed userspace enqueue-to-release residence, before the socket send. */
    actual_residence_us: DelayDistribution,
    /** `actualResidenceUs - releaseTargetResidenceUs`, saturating at zero. */
    release_overshoot_us: DelayDistribution,
    release_early_count: u64,
    max_release_early_us: u64,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LogicalPathImpairmentStats {
    fault_site: ImpairmentFaultSite,
    fault_sites_per_logical_direction: u8,
    requested_datagram_loss_percent: u64,
    observed_fault_site_packets: u64,
    dropped_at_fault_site: u64,
    achieved_packet_loss_percent: f64,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DelayDistribution {
    count: u64,
    mean: f64,
    min: u64,
    p50: u64,
    p95: u64,
    p99: u64,
    max: u64,
    histogram_bucket_us: u64,
    #[serde(serialize_with = "serialize_delay_histogram")]
    histogram: [u64; DELAY_HISTOGRAM_BUCKETS],
}

fn serialize_delay_histogram<S>(
    histogram: &[u64; DELAY_HISTOGRAM_BUCKETS],
    serializer: S,
) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    let mut sequence = serializer.serialize_seq(Some(histogram.len()))?;
    for count in histogram {
        sequence.serialize_element(count)?;
    }
    sequence.end()
}

/// Packets the proxy dropped outside the configured impairment, process-wide.
/// Any of them means the proxy was not the configured network.
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HarnessDropStats {
    /** A datagram above `MAX_PROXY_PACKET_BYTES`. */
    oversized: u64,
    /** A new source displaced from, or refused by, the one-packet admission handoff. */
    admission: u64,
    /** A packet refused by a relay whose whole packet lease was held. */
    lease_exhausted: u64,
}

impl NetworkImpairment {
    fn new(config: ImpairmentConfig, links: Vec<Link<LinkPacket>>) -> Self {
        Self {
            config,
            links,
            state: Mutex::new(NetworkImpairmentState::default()),
        }
    }

    /// The link a relay of `role` crosses in `direction`, if one is declared.
    fn link(&self, role: Role, direction: LinkDirection) -> Option<&Link<LinkPacket>> {
        self.links.iter().find(|link| {
            let config = link.config();
            config.role == role && config.direction == direction
        })
    }

    /// Gives a new relay its trace slot. Admission never holds more relays
    /// than slots, so a free one always exists.
    fn attach_relay(
        &self,
        admission_seq: u64,
        relay: Arc<RelayState>,
        listener: ListenerId,
        upstream_port: u16,
    ) -> usize {
        let mut state = self
            .state
            .lock()
            .expect("network impairment state poisoned");
        let mark_generation = state.mark.generation;
        let slot = state
            .relays
            .iter()
            .position(Option::is_none)
            .expect("relay admission never exceeds the trace slots");
        state.relays[slot] = Some(RelayTrace {
            admission_seq,
            listener,
            upstream_port,
            state: relay,
            mark_generation,
            sequence: [0; 2],
            window_exact_drops: 0,
            since_mark: RelayLedger::default(),
        });
        slot
    }

    fn detach_relay(&self, slot: usize, admission_seq: u64) {
        let mut state = self
            .state
            .lock()
            .expect("network impairment state poisoned");
        if let Some(entry) = state.relays.get_mut(slot)
            && entry
                .as_ref()
                .is_some_and(|trace| trace.admission_seq == admission_seq)
        {
            *entry = None;
        }
    }

    /// Restarts every relay's trace under `key` at its next decision, and
    /// reports the relays as that mark found them.
    fn mark(&self, key: u64) -> ProxySettleStatus {
        let mut state = self
            .state
            .lock()
            .expect("network impairment state poisoned");
        state.mark = TraceMark {
            generation: state.mark.generation.wrapping_add(1),
            key,
        };
        state.since_mark = RelayLedger::default();
        restart_relays_max_in_flight(&state);
        let now = Instant::now();
        for link in &self.links {
            link.mark(now);
        }
        self.settle_status_locked(&state)
    }

    /// `None` when `slot` no longer holds `admission_seq`: the caller is a
    /// task that outlived its relay.
    fn decide(
        &self,
        slot: usize,
        admission_seq: u64,
        direction: ImpairmentDirection,
        now: Instant,
    ) -> Option<PacketDecision> {
        let mut guard = self
            .state
            .lock()
            .expect("network impairment state poisoned");
        let state = &mut *guard;
        let mark = state.mark;
        let trace = state
            .relays
            .get_mut(slot)?
            .as_mut()
            .filter(|trace| trace.admission_seq == admission_seq)?;
        if trace.mark_generation != mark.generation {
            trace.mark_generation = mark.generation;
            trace.sequence = [0; 2];
            trace.window_exact_drops = 0;
            trace.since_mark = RelayLedger::default();
        }
        let sequence = trace.sequence[direction.index()];
        trace.sequence[direction.index()] = sequence.wrapping_add(1);
        let counters = match direction {
            ImpairmentDirection::Upstream => &mut state.upstream,
            ImpairmentDirection::Downstream => &mut state.downstream,
        };
        counters.seen = counters.seen.wrapping_add(1);

        let direction_salt = match direction {
            ImpairmentDirection::Upstream => 0x7a91_324d_63e5_b8f1,
            ImpairmentDirection::Downstream => 0xc4b2_a917_580d_36ef,
        };
        let trace_seed =
            self.config.seed ^ direction_salt ^ mix64(trace.admission_seq) ^ mix64(mark.key);
        let jitter_span = self.config.jitter_radius_us.saturating_mul(2);
        let jitter_sample = if jitter_span == 0 {
            0
        } else {
            mix64(trace_seed ^ sequence.wrapping_mul(0x9e37_79b9_7f4a_7c15))
                % jitter_span.saturating_add(1)
        };
        let signed_jitter_us = i128::from(jitter_sample) - i128::from(self.config.jitter_radius_us);
        if signed_jitter_us != 0 {
            counters.jittered = counters.jittered.wrapping_add(1);
        }

        // A browser<->daemon logical direction enters one proxy and exits the
        // other. Impairing both ingress and egress silently compounds a nominal
        // p into 1-(1-p)^2. Keep exactly one destructive fault site: the
        // edge-to-client leg. Upstream still receives its independent centred
        // jitter sample and base delay, so the calibrated four-leg RTT remains
        // intact.
        let destructive_impairment = direction == ImpairmentDirection::Downstream;
        let exact_loss = destructive_impairment
            && selected_exact_rate(
                sequence,
                self.config.datagram_loss_percent,
                trace_seed ^ 0x2e6a_f147_9d35_c08b,
            );
        let burst_position = (destructive_impairment
            && self.config.scenario == ImpairmentScenario::BurstLoss)
            .then(|| burst_position(sequence, trace_seed ^ 0x915f_a724_3bc8_d06e))
            .flatten();
        let burst_loss = burst_position.is_some();
        if exact_loss {
            counters.exact_loss_dropped = counters.exact_loss_dropped.wrapping_add(1);
            trace.window_exact_drops = trace.window_exact_drops.wrapping_add(1);
        }
        if burst_loss {
            counters.burst_loss_dropped = counters.burst_loss_dropped.wrapping_add(1);
            if burst_position == Some(BURST_LOSS_PACKETS - 1) {
                counters.burst_loss_runs_completed =
                    counters.burst_loss_runs_completed.wrapping_add(1);
            }
        }
        let dropped = exact_loss || burst_loss;
        if dropped {
            counters.dropped = counters.dropped.wrapping_add(1);
        }

        let reordered = destructive_impairment
            && selected_exact_rate(
                sequence,
                self.config.reorder.rate_percent(),
                trace_seed ^ 0x18d4_7ca9_b263_05ef,
            );
        let reorder_hold_us = if reordered {
            counters.reordered = counters.reordered.wrapping_add(1);
            self.config.jitter_radius_us.saturating_mul(4)
        } else {
            0
        };

        let base_delay_us = i128::from(self.config.base_delay_us) + signed_jitter_us;
        let mut scheduled_delay_us = u64::try_from(base_delay_us)
            .expect("validated base delay remains positive after centred jitter")
            .saturating_add(reorder_hold_us);

        let congested = destructive_impairment
            && self.config.scenario == ImpairmentScenario::Congestion
            && selected_congestion_window(sequence, trace_seed ^ 0x6f08_d132_a95c_47be);
        let mut congestion_queue_delay_us = 0;
        if congested {
            // The bottleneck queue holds only congested packets and drains one
            // per spacing interval. A drained queue is forgotten by the `max`
            // below, so packets outside a window neither wait nor reset it.
            counters.congested = counters.congested.wrapping_add(1);
            let base_deadline = now + Duration::from_micros(scheduled_delay_us);
            let next_release = state
                .congestion_release_cursor
                .map(|cursor| cursor.max(base_deadline))
                .unwrap_or(base_deadline)
                + Duration::from_micros(CONGESTION_PACKET_SPACING_US);
            let ceiling = base_deadline + Duration::from_micros(CONGESTION_MAX_QUEUE_DELAY_US);
            let release = if next_release > ceiling {
                counters.congestion_clamped = counters.congestion_clamped.wrapping_add(1);
                ceiling
            } else {
                next_release
            };
            state.congestion_release_cursor = Some(release);
            let queue_delay_us =
                u64::try_from(release.saturating_duration_since(base_deadline).as_micros())
                    .unwrap_or(u64::MAX);
            congestion_queue_delay_us = queue_delay_us;
            counters.max_congestion_queue_delay_us =
                counters.max_congestion_queue_delay_us.max(queue_delay_us);
            scheduled_delay_us = u64::try_from(release.saturating_duration_since(now).as_micros())
                .unwrap_or(u64::MAX);
        }

        if !dropped {
            counters.forwarded = counters.forwarded.wrapping_add(1);
            if congested {
                counters.congested_forwarded = counters.congested_forwarded.wrapping_add(1);
                counters.max_forwarded_congestion_queue_delay_us = counters
                    .max_forwarded_congestion_queue_delay_us
                    .max(congestion_queue_delay_us);
            }
            counters.record_delay(scheduled_delay_us);
        }

        trace.since_mark.record(direction, dropped, reordered);
        state.since_mark.record(direction, dropped, reordered);
        // The selector permutes each complete downstream window, so its drop
        // count is exact by construction; the totals let a consumer check that
        // equality without knowing any relay's phase.
        if direction == ImpairmentDirection::Downstream
            && sequence % LOSS_WINDOW_PACKETS == LOSS_WINDOW_PACKETS - 1
        {
            debug_assert_eq!(trace.window_exact_drops, self.config.datagram_loss_percent);
            state.exact_loss_windows_completed = state.exact_loss_windows_completed.wrapping_add(1);
            state.exact_loss_dropped_in_completed_windows = state
                .exact_loss_dropped_in_completed_windows
                .wrapping_add(trace.window_exact_drops);
            trace.window_exact_drops = 0;
        }

        Some(PacketDecision {
            deadline: now + Duration::from_micros(scheduled_delay_us),
            trace_epoch: state.epoch,
            trace_generation: mark.generation,
            trace_sequence: sequence,
            dropped,
            reordered,
        })
    }

    fn record_reorder_inversion(&self, direction: ImpairmentDirection, trace_epoch: u64) {
        let mut state = self
            .state
            .lock()
            .expect("network impairment state poisoned");
        if state.epoch != trace_epoch {
            return;
        }
        let counters = match direction {
            ImpairmentDirection::Upstream => &mut state.upstream,
            ImpairmentDirection::Downstream => &mut state.downstream,
        };
        counters.reorder_inversions = counters.reorder_inversions.wrapping_add(1);
    }

    fn record_release_timing(
        &self,
        direction: ImpairmentDirection,
        trace_epoch: u64,
        target_residence_us: u64,
        actual_residence_us: u64,
    ) {
        let mut state = self
            .state
            .lock()
            .expect("network impairment state poisoned");
        if state.epoch != trace_epoch {
            return;
        }
        let counters = match direction {
            ImpairmentDirection::Upstream => &mut state.upstream,
            ImpairmentDirection::Downstream => &mut state.downstream,
        };
        counters
            .release_target_residence
            .record(target_residence_us);
        counters.actual_residence.record(actual_residence_us);
        if actual_residence_us >= target_residence_us {
            counters
                .release_overshoot
                .record(actual_residence_us - target_residence_us);
        } else {
            let early_us = target_residence_us - actual_residence_us;
            counters.release_early_count = counters.release_early_count.wrapping_add(1);
            counters.max_release_early_us = counters.max_release_early_us.max(early_us);
            counters.release_overshoot.record(0);
        }
    }

    fn reset(&self) -> NetworkImpairmentStats {
        let mut state = self
            .state
            .lock()
            .expect("network impairment state poisoned");
        state.epoch = state.epoch.wrapping_add(1);
        // Key 0 restarts every relay from ordinal zero under the one trace
        // every reset shares, so a spec that resets before each window keeps
        // replaying identical decisions per relay.
        state.mark = TraceMark {
            generation: state.mark.generation.wrapping_add(1),
            key: 0,
        };
        state.since_mark = RelayLedger::default();
        restart_relays_max_in_flight(&state);
        state.upstream = DirectionCounters::default();
        state.downstream = DirectionCounters::default();
        state.congestion_release_cursor = None;
        state.exact_loss_windows_completed = 0;
        state.exact_loss_dropped_in_completed_windows = 0;
        let now = Instant::now();
        for link in &self.links {
            link.reset(now);
        }
        self.stats_locked(&state)
    }

    fn stats(&self) -> NetworkImpairmentStats {
        let state = self
            .state
            .lock()
            .expect("network impairment state poisoned");
        self.stats_locked(&state)
    }

    fn settle_status(&self) -> ProxySettleStatus {
        let state = self
            .state
            .lock()
            .expect("network impairment state poisoned");
        self.settle_status_locked(&state)
    }

    fn settle_status_locked(&self, state: &NetworkImpairmentState) -> ProxySettleStatus {
        let (relays, pending_scheduled_packets) = self.relay_statuses(state);
        ProxySettleStatus {
            schema_version: IMPAIRMENT_STATS_SCHEMA_VERSION,
            epoch: state.epoch,
            mark: state.mark,
            since_mark: state.since_mark,
            upstream: SettleDirectionStatus::from(&state.upstream),
            downstream: SettleDirectionStatus::from(&state.downstream),
            harness_drops: harness_drop_stats(),
            split_datagrams: DOWNSTREAM_COALESCED_SPLITS.load(Ordering::Relaxed),
            pending_scheduled_packets,
            relays,
        }
    }

    /// Every live relay in admission order, and the pending packets they own.
    fn relay_statuses(&self, state: &NetworkImpairmentState) -> (RelayStatuses, u64) {
        let mut statuses = RelayStatuses {
            len: 0,
            entries: [RelayStatus::default(); MAX_PROXY_CLIENTS],
        };
        let mut pending_total = 0u64;
        for (slot, trace) in state
            .relays
            .iter()
            .enumerate()
            .filter_map(|(slot, trace)| Some((slot, trace.as_ref()?)))
        {
            let pending = u64::try_from(trace.state.pending_packets()).unwrap_or(u64::MAX);
            pending_total = pending_total.saturating_add(pending);
            // A trace restarts lazily, so a ledger from an earlier mark counts
            // nothing that happened since the current one.
            let ledger = if trace.mark_generation == state.mark.generation {
                trace.since_mark
            } else {
                RelayLedger::default()
            };
            let bottleneck_drops = self
                .links
                .iter()
                .filter(|link| link.config().role == trace.listener.role)
                .map(|link| link.relay_drops(slot, trace.admission_seq))
                .sum();
            statuses.entries[statuses.len] = RelayStatus {
                admission_seq: trace.admission_seq,
                listener: trace.listener,
                upstream_port: trace.upstream_port,
                pending,
                up_seen: ledger.up_seen,
                down_seen: ledger.down_seen,
                down_dropped: ledger.down_dropped,
                down_reordered: ledger.down_reordered,
                up_max_in_flight: trace.state.max_in_flight(ImpairmentDirection::Upstream),
                down_max_in_flight: trace.state.max_in_flight(ImpairmentDirection::Downstream),
                bottleneck_drops,
            };
            statuses.len += 1;
        }
        statuses.entries[..statuses.len].sort_unstable_by_key(|relay| relay.admission_seq);
        (statuses, pending_total)
    }

    fn relay_links(&self, state: &NetworkImpairmentState) -> Vec<RelayLinks> {
        let mut relays: Vec<RelayLinks> = state
            .relays
            .iter()
            .enumerate()
            .filter_map(|(slot, trace)| {
                let trace = trace.as_ref()?;
                Some(RelayLinks {
                    admission_seq: trace.admission_seq,
                    listener: trace.listener,
                    upstream_port: trace.upstream_port,
                    links: self
                        .links
                        .iter()
                        .filter(|link| link.config().role == trace.listener.role)
                        .filter_map(|link| link.relay_status(slot, trace.admission_seq))
                        .collect(),
                })
            })
            .collect();
        relays.sort_unstable_by_key(|relay| relay.admission_seq);
        relays
    }

    fn stats_locked(&self, state: &NetworkImpairmentState) -> NetworkImpairmentStats {
        let downstream = state.downstream.stats();
        let (relays, pending_scheduled_packets) = self.relay_statuses(state);
        NetworkImpairmentStats {
            schema_version: IMPAIRMENT_STATS_SCHEMA_VERSION,
            epoch: state.epoch,
            config: self.config.clone(),
            upstream: state.upstream.stats(),
            downstream,
            logical_path_impairment: LogicalPathImpairmentStats {
                fault_site: self.config.fault_site,
                fault_sites_per_logical_direction: self.config.fault_sites_per_logical_direction,
                requested_datagram_loss_percent: self.config.datagram_loss_percent,
                observed_fault_site_packets: downstream.seen,
                dropped_at_fault_site: downstream.dropped,
                achieved_packet_loss_percent: downstream.achieved_packet_loss_percent,
            },
            harness_drops: harness_drop_stats(),
            split_datagrams: DOWNSTREAM_COALESCED_SPLITS.load(Ordering::Relaxed),
            pending_scheduled_packets,
            exact_loss_windows_completed: state.exact_loss_windows_completed,
            exact_loss_dropped_in_completed_windows: state.exact_loss_dropped_in_completed_windows,
            relays,
            links: self.links.iter().map(Link::status).collect(),
            relay_links: self.relay_links(state),
        }
    }
}

/// A mark or reset starts every live relay's delay-line maxima again; the
/// state lock orders it against the status it reports.
fn restart_relays_max_in_flight(state: &NetworkImpairmentState) {
    for trace in state.relays.iter().flatten() {
        trace.state.restart_max_in_flight();
    }
}

fn harness_drop_stats() -> HarnessDropStats {
    HarnessDropStats {
        oversized: OVERSIZED_PACKET_DROPS.load(Ordering::Relaxed),
        admission: CLIENT_ADMISSION_DROPS.load(Ordering::Relaxed),
        lease_exhausted: RELAY_LEASE_EXHAUSTIONS.load(Ordering::Relaxed),
    }
}

impl From<&DirectionCounters> for SettleDirectionStatus {
    fn from(counters: &DirectionCounters) -> Self {
        Self {
            seen: counters.seen,
            forwarded: counters.forwarded,
            dropped: counters.dropped,
            released: counters.actual_residence.count,
            reorder_inversions: counters.reorder_inversions,
        }
    }
}

impl DirectionCounters {
    fn record_delay(&mut self, delay_us: u64) {
        self.scheduled_delay.record(delay_us);
    }

    fn stats(&self) -> DirectionStats {
        DirectionStats {
            seen: self.seen,
            forwarded: self.forwarded,
            dropped: self.dropped,
            exact_loss_dropped: self.exact_loss_dropped,
            burst_loss_dropped: self.burst_loss_dropped,
            burst_loss_runs_completed: self.burst_loss_runs_completed,
            jittered: self.jittered,
            reorder_inversions: self.reorder_inversions,
            reordered: self.reordered,
            congested: self.congested,
            congested_forwarded: self.congested_forwarded,
            congestion_clamped: self.congestion_clamped,
            max_congestion_queue_delay_us: self.max_congestion_queue_delay_us,
            max_forwarded_congestion_queue_delay_us: self.max_forwarded_congestion_queue_delay_us,
            achieved_packet_loss_percent: if self.seen == 0 {
                0.0
            } else {
                self.dropped as f64 * 100.0 / self.seen as f64
            },
            scheduled_delay_us: self.scheduled_delay.stats(),
            release_target_residence_us: self.release_target_residence.stats(),
            actual_residence_us: self.actual_residence.stats(),
            release_overshoot_us: self.release_overshoot.stats(),
            release_early_count: self.release_early_count,
            max_release_early_us: self.max_release_early_us,
        }
    }
}

impl DelaySamples {
    fn record(&mut self, delay_us: u64) {
        self.count = self.count.wrapping_add(1);
        self.sum_us = self.sum_us.saturating_add(u128::from(delay_us));
        self.min_us = self.min_us.min(delay_us);
        self.max_us = self.max_us.max(delay_us);
        let bucket = usize::try_from(delay_us / DELAY_HISTOGRAM_BUCKET_US)
            .unwrap_or(usize::MAX)
            .min(DELAY_HISTOGRAM_BUCKETS - 1);
        self.histogram[bucket] = self.histogram[bucket].wrapping_add(1);
    }

    fn stats(&self) -> DelayDistribution {
        DelayDistribution {
            count: self.count,
            mean: if self.count == 0 {
                0.0
            } else {
                self.sum_us as f64 / self.count as f64
            },
            min: if self.count == 0 { 0 } else { self.min_us },
            p50: self.quantile(50, 100),
            p95: self.quantile(95, 100),
            p99: self.quantile(99, 100),
            max: self.max_us,
            histogram_bucket_us: DELAY_HISTOGRAM_BUCKET_US,
            histogram: self.histogram,
        }
    }

    fn quantile(&self, numerator: u64, denominator: u64) -> u64 {
        if self.count == 0 {
            return 0;
        }
        let target = self
            .count
            .saturating_mul(numerator)
            .saturating_add(denominator - 1)
            / denominator;
        let mut cumulative = 0u64;
        for (index, count) in self.histogram.iter().enumerate() {
            cumulative = cumulative.saturating_add(*count);
            if cumulative >= target {
                let bucket_ceil = (index as u64 + 1).saturating_mul(DELAY_HISTOGRAM_BUCKET_US);
                return bucket_ceil.min(self.max_us);
            }
        }
        self.max_us
    }
}

fn mix64(mut value: u64) -> u64 {
    value = value.wrapping_add(0x9e37_79b9_7f4a_7c15);
    value = (value ^ (value >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    value = (value ^ (value >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    value ^ (value >> 31)
}

fn selected_exact_rate(sequence: u64, percent: u64, seed: u64) -> bool {
    if percent == 0 {
        return false;
    }
    let window = sequence / LOSS_WINDOW_PACKETS;
    let slot = sequence % LOSS_WINDOW_PACKETS;
    let shuffled = mix64(seed ^ window.wrapping_mul(0xd6e8_feb8_6659_fd93));
    // Every value is coprime with 100, so `a*x+b mod 100` is a permutation:
    // every complete window contains the exact requested number of selections.
    const COPRIME_TO_100: [u64; 40] = [
        1, 3, 7, 9, 11, 13, 17, 19, 21, 23, 27, 29, 31, 33, 37, 39, 41, 43, 47, 49, 51, 53, 57, 59,
        61, 63, 67, 69, 71, 73, 77, 79, 81, 83, 87, 89, 91, 93, 97, 99,
    ];
    let multiplier = COPRIME_TO_100[(shuffled as usize) % COPRIME_TO_100.len()];
    let offset = mix64(shuffled ^ 0xa076_1d64_78bd_642f) % LOSS_WINDOW_PACKETS;
    (slot.wrapping_mul(multiplier).wrapping_add(offset) % LOSS_WINDOW_PACKETS) < percent
}

fn burst_position(sequence: u64, seed: u64) -> Option<u64> {
    let offset = mix64(seed) % BURST_LOSS_CYCLE_PACKETS;
    let position = sequence.wrapping_add(offset) % BURST_LOSS_CYCLE_PACKETS;
    (position < BURST_LOSS_PACKETS).then_some(position)
}

fn release_may_reorder(direction: ImpairmentDirection, mode: ReorderMode) -> bool {
    direction == ImpairmentDirection::Downstream && mode != ReorderMode::None
}

fn selected_congestion_window(sequence: u64, seed: u64) -> bool {
    let offset = mix64(seed) % CONGESTION_CYCLE_PACKETS;
    sequence.wrapping_add(offset) % CONGESTION_CYCLE_PACKETS < CONGESTION_WINDOW_PACKETS
}

/// Upper bound on a requested partition, so a malformed control message cannot
/// wedge the proxy for the rest of a run.
const MAX_PARTITION_MS: u64 = 120_000;

/// Which connections a partition blackholes.
///
/// Whole-path, both-endpoint and browser-only faults have different recovery
/// paths. A browser-only break preserves the daemon attachment needed by rebind.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PartitionScope {
    /// Every packet in both directions, for every client, new ones included.
    /// The path to the edge is simply gone: nothing can be dialled while it
    /// lasts, so recovery is bounded by the outage rather than by any decision
    /// the browser makes.
    Everything,
    /// Only the connections that existed when the partition was armed. A client
    /// that dials afterwards passes through untouched.
    ///
    /// This is the interface-change case, and it is the one that exercises the
    /// recovery decision rather than waiting one out: the carrier in use is
    /// dead for good while a fresh dial would succeed immediately. Under
    /// `Everything` a speculative dial can never complete, so the promotion
    /// path is unreachable and only the liveness ladder is ever measured.
    Established { admitted_through: u64 },
    /// Existing browser connections only; the daemon remains reachable at the
    /// edge, as it does when the browser changes network interfaces.
    BrowserEstablished { admitted_through: u64 },
    /// No connection that exists; only what a browser dials while it lasts,
    /// which is not admitted.
    ///
    /// The stalled-path case: the flow the path already carries answers again
    /// while a fresh one cannot be set up yet. Armed over a whole-path
    /// partition, it lets the incumbent carrier's answer be the first thing a
    /// recovering browser sees, which no pair of timers can promise once both
    /// are free to race.
    BrowserDials,
}

/// A timed blackhole, symmetric in both directions, over the connections named
/// by its scope.
///
/// Periodic loss models a degraded path; it cannot model the case reconnect
/// actually exists for, which is a carrier that stops entirely and then comes
/// back. Expressed as an absolute deadline rather than a flag so a test arms it
/// once and does not have to race a second control message to end it.
#[derive(Default)]
struct Partition {
    state: Mutex<Option<(Instant, PartitionScope)>>,
}

impl Partition {
    fn arm(&self, duration: Duration, scope: PartitionScope) -> Instant {
        let until = Instant::now() + duration;
        *self.state.lock().expect("partition state poisoned") = Some((until, scope));
        until
    }

    /// Whether the connection admitted at `admission_seq` is currently cut.
    ///
    /// Takes the sequence rather than the address because the downstream reader
    /// task owns only its own connection, and because an address can be reused
    /// by a later dial — which under `Established` is exactly the connection
    /// that must NOT be cut.
    fn blocks(&self, admission_seq: u64, role: Role) -> bool {
        let mut guard = self.state.lock().expect("partition state poisoned");
        match *guard {
            Some((until, scope)) if Instant::now() < until => match scope {
                PartitionScope::Everything => true,
                PartitionScope::BrowserEstablished { admitted_through } => {
                    role == Role::Browser && admission_seq <= admitted_through
                }
                PartitionScope::Established { admitted_through } => {
                    admission_seq <= admitted_through
                }
                PartitionScope::BrowserDials => false,
            },
            Some(_) => {
                *guard = None;
                false
            }
            None => false,
        }
    }

    /// Whether a not-yet-admitted client of `role` is refused relay state.
    ///
    /// Under `Everything` every one is: admitting one would leave the harness
    /// holding relay state for a connection the partition is meant to have
    /// prevented entirely. Under `BrowserDials` a browser's is, and that
    /// refusal is the whole partition.
    fn blocks_admission(&self, role: Role) -> bool {
        let mut guard = self.state.lock().expect("partition state poisoned");
        match *guard {
            Some((until, PartitionScope::Everything)) if Instant::now() < until => true,
            Some((until, PartitionScope::BrowserDials)) if Instant::now() < until => {
                role == Role::Browser
            }
            Some((until, _)) if Instant::now() < until => false,
            Some(_) => {
                *guard = None;
                false
            }
            None => false,
        }
    }
}

/// Reads a QUIC variable-length integer, returning its value and encoded width.
fn read_quic_varint(bytes: &[u8]) -> Option<(u64, usize)> {
    let first = *bytes.first()?;
    let width = 1usize << (first >> 6);
    let encoded = bytes.get(..width)?;
    let mut value = u64::from(first & 0x3f);
    for byte in &encoded[1..] {
        value = (value << 8) | u64::from(*byte);
    }
    Some((value, width))
}

/// Byte offset of the first 1-RTT (short-header) packet in a datagram that also
/// carries at least one long-header packet ahead of it.
///
/// This is what makes a 0.5-RTT regression reproducible at all. QUIC coalesces
/// packets of different encryption levels into one UDP datagram, and the edge
/// does exactly that: every server flight measured here was a single 1200-byte
/// datagram carrying `Initial + Handshake + 1-RTT`. The 0.5-RTT application
/// data therefore travels in the *same datagram* as the Handshake CRYPTO that
/// installs the keys to decrypt it, so no amount of datagram loss or reordering
/// can separate them — dropping loses both, delaying moves both, and the client
/// always installs keys before it reaches the 1-RTT bytes. Packet-level loss
/// and reorder traces are structurally incapable of reproducing the deadlock in
/// PERF.md, 2026-08-30, and a sweep over them proves nothing.
///
/// Splitting the datagram here is the instrument that can: the 1-RTT suffix is
/// released one `delay` ahead of the crypto prefix, so the client sees
/// application data protected by keys it has not installed yet — precisely the
/// production condition. Splitting is legal in the other direction too: a QUIC
/// receiver must accept packets that arrive in separate datagrams, and
/// coalescing is a sender-side optimization, not a guarantee.
///
/// Returns `None` when the datagram is not a coalesced crypto+application mix:
/// a pure 1-RTT datagram, a pure handshake datagram, a Retry or Version
/// Negotiation packet (neither carries a Length field), or anything that does
/// not parse. Those are forwarded whole.
fn one_rtt_split_offset(datagram: &[u8]) -> Option<usize> {
    let mut offset = 0usize;
    let mut saw_long_header = false;
    loop {
        let rest = datagram.get(offset..)?;
        let first = *rest.first()?;
        if first & 0x80 == 0 {
            // Short header: consumes the remainder, so there is exactly one
            // split point in any datagram.
            return saw_long_header.then_some(offset);
        }
        let version =
            u32::from_be_bytes([*rest.get(1)?, *rest.get(2)?, *rest.get(3)?, *rest.get(4)?]);
        if version == 0 {
            // Version Negotiation: no Length field, no packets after it.
            return None;
        }
        let packet_type = (first >> 4) & 0x03;
        if packet_type == 3 {
            // Retry: no Length field, consumes the remainder.
            return None;
        }
        let mut cursor = 5usize;
        let dcid_len = usize::from(*rest.get(cursor)?);
        cursor = cursor.checked_add(1)?.checked_add(dcid_len)?;
        let scid_len = usize::from(*rest.get(cursor)?);
        cursor = cursor.checked_add(1)?.checked_add(scid_len)?;
        if packet_type == 0 {
            let (token_len, width) = read_quic_varint(rest.get(cursor..)?)?;
            cursor = cursor
                .checked_add(width)?
                .checked_add(usize::try_from(token_len).ok()?)?;
        }
        let (length, width) = read_quic_varint(rest.get(cursor..)?)?;
        cursor = cursor
            .checked_add(width)?
            .checked_add(usize::try_from(length).ok()?)?;
        if cursor > rest.len() {
            return None;
        }
        saw_long_header = true;
        offset = offset.checked_add(cursor)?;
    }
}

/// UDP flows are scoped to their destination listener as well as their source.
type ClientKey = (usize, SocketAddr);

/// Where a relay's upstream socket leaves from. The harness is loopback-only,
/// so a source names one address.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum UpstreamSource {
    /// The dual-stack wildcard, reaching the configured upstream from whatever
    /// address the kernel picks for it: `::1` in every harness.
    Configured,
    /// `127.0.0.1`, reaching the upstream's port on the IPv4 loopback, which a
    /// dual-stack upstream listener sees as another peer address.
    Ipv4Loopback,
}

impl UpstreamSource {
    fn parse(raw: &str) -> Option<Self> {
        match raw {
            "configured" => Some(Self::Configured),
            "ipv4-loopback" => Some(Self::Ipv4Loopback),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Configured => "configured",
            Self::Ipv4Loopback => "ipv4-loopback",
        }
    }
}

/// A fresh upstream socket leaving from `source`, connected to `upstream`.
async fn bind_upstream(source: UpstreamSource, upstream: SocketAddr) -> Arc<UdpSocket> {
    let (local, remote) = match source {
        UpstreamSource::Configured => (SocketAddr::from((Ipv6Addr::UNSPECIFIED, 0)), upstream),
        UpstreamSource::Ipv4Loopback => (
            SocketAddr::from((Ipv4Addr::LOCALHOST, 0)),
            SocketAddr::from((Ipv4Addr::LOCALHOST, upstream.port())),
        ),
    };
    let socket = UdpSocket::bind(local).await.expect("bind upstream");
    socket.connect(remote).await.expect("connect upstream");
    Arc::new(socket)
}

/// A session browser relay's upstream source, which the `source` control verb
/// moves. Daemon and competitor relays keep theirs.
struct RelaySource {
    /// The socket upstream sends leave from.
    socket: watch::Sender<Arc<UdpSocket>>,
    reader: UpstreamReader,
    /// The listener's upstream, as configured.
    upstream: SocketAddr,
}

/// Everything a relay's edge-to-client reader needs besides its socket, so a
/// source switch can start one for the replacement.
#[derive(Clone)]
struct UpstreamReader {
    relay_state: Arc<RelayState>,
    activity_clock: Arc<AtomicU64>,
    impairment: Arc<NetworkImpairment>,
    partition: Arc<Partition>,
    split_one_rtt: bool,
    admission_seq: u64,
    slot: usize,
    role: Role,
    /// Behind a downlink the loss site follows the link, so a selected packet
    /// still crosses it.
    lose_after_link: bool,
    downstream_tx: mpsc::UnboundedSender<DelayedPacket>,
}

impl UpstreamReader {
    /// Reader: edge -> (delay) -> client, for one upstream socket.
    fn spawn(self, socket: Arc<UdpSocket>) -> JoinHandle<()> {
        let UpstreamReader {
            relay_state,
            activity_clock,
            impairment,
            partition,
            split_one_rtt,
            admission_seq,
            slot,
            role,
            lose_after_link,
            downstream_tx,
        } = self;
        tokio::spawn(async move {
            let mut rbuf = vec![0u8; 65535];
            while let Ok(m) = socket.recv(&mut rbuf).await {
                let pending = match relay_state.try_acquire_packet(&activity_clock) {
                    Ok(pending) => pending,
                    Err(LeaseRefusal::Closed) => break,
                    Err(LeaseRefusal::Exhausted) => {
                        record_lease_exhaustion();
                        continue;
                    }
                };
                // A partition blackholes both directions of the connections in
                // its scope, for its whole duration.
                if partition.blocks(admission_seq, role) {
                    continue;
                }
                if m > MAX_PROXY_PACKET_BYTES {
                    record_drop(
                        &OVERSIZED_PACKET_DROPS,
                        "oversized UDP packet",
                        MAX_PROXY_PACKET_BYTES,
                    );
                    continue;
                }
                // `None` means this reader outlived its relay.
                let Some(decision) = impairment.decide(
                    slot,
                    admission_seq,
                    ImpairmentDirection::Downstream,
                    Instant::now(),
                ) else {
                    break;
                };
                if decision.dropped {
                    record_impairment();
                    if !lose_after_link {
                        continue;
                    }
                }
                if decision.reordered {
                    record_reorder();
                }
                // Release a coalesced datagram's 1-RTT suffix ahead of the
                // crypto prefix that carries the keys to decrypt it. This is
                // the only shape that reproduces the deadlock in PERF.md,
                // 2026-08-30; see `one_rtt_split_offset`.
                if split_one_rtt
                    && !decision.dropped
                    && let Some(offset) = one_rtt_split_offset(&rbuf[..m])
                {
                    // Two datagrams leave the proxy, so the prefix needs a
                    // second lease, and a refusal loses the whole datagram
                    // exactly as a refused first lease would.
                    let prefix_pending = match relay_state.try_acquire_packet(&activity_clock) {
                        Ok(prefix_pending) => prefix_pending,
                        Err(LeaseRefusal::Closed) => break,
                        Err(LeaseRefusal::Exhausted) => {
                            record_lease_exhaustion();
                            continue;
                        }
                    };
                    record_coalesced_split();
                    let suffix = enqueue_admitted_delayed_packet(
                        &downstream_tx,
                        UnadmittedDelayedPacket {
                            deadline: decision.deadline,
                            trace_epoch: decision.trace_epoch,
                            trace_generation: decision.trace_generation,
                            trace_sequence: decision.trace_sequence,
                            trace_reorder_selected: decision.reordered,
                            lost: false,
                            data: rbuf[offset..m].to_vec(),
                        },
                        pending,
                        ImpairmentDirection::Downstream,
                    );
                    if matches!(suffix, PacketEnqueueResult::Closed) {
                        break;
                    }
                    let prefix = enqueue_admitted_delayed_packet(
                        &downstream_tx,
                        UnadmittedDelayedPacket {
                            deadline: decision.deadline
                                + Duration::from_micros(impairment.config.base_delay_us),
                            trace_epoch: decision.trace_epoch,
                            trace_generation: decision.trace_generation,
                            trace_sequence: decision.trace_sequence,
                            trace_reorder_selected: decision.reordered,
                            lost: false,
                            data: rbuf[..offset].to_vec(),
                        },
                        prefix_pending,
                        ImpairmentDirection::Downstream,
                    );
                    if matches!(prefix, PacketEnqueueResult::Closed) {
                        break;
                    }
                    continue;
                }
                let packet = rbuf[..m].to_vec();
                match enqueue_admitted_delayed_packet(
                    &downstream_tx,
                    UnadmittedDelayedPacket {
                        deadline: decision.deadline,
                        trace_epoch: decision.trace_epoch,
                        trace_generation: decision.trace_generation,
                        trace_sequence: decision.trace_sequence,
                        trace_reorder_selected: decision.reordered,
                        lost: decision.dropped,
                        data: packet,
                    },
                    pending,
                    ImpairmentDirection::Downstream,
                ) {
                    PacketEnqueueResult::Enqueued => {}
                    PacketEnqueueResult::Closed => break,
                }
            }
        })
    }
}

struct ClientRelay {
    upstream_tx: mpsc::UnboundedSender<DelayedPacket>,
    state: Arc<RelayState>,
    tasks: Vec<JoinHandle<()>>,
    /// Monotonic order of admission, so an `Established` partition can name the
    /// connections that existed when it was armed without holding addresses
    /// (which a later dial can reuse). It also seeds the relay's trace.
    admission_seq: u64,
    /// This relay's trace slot, released when the relay drops.
    slot: usize,
    impairment: Arc<NetworkImpairment>,
    /// Present for the session's browser relays, the ones a source switch moves.
    source: Option<RelaySource>,
}

/// Inactive sources that previously passed QUIC Initial validation.
///
/// UDP cannot reveal whether an encrypted short-header tail belongs to a live
/// idle connection or a connection that just closed. Reactivation deliberately
/// favors recovery; dead late tails can create a transient relay, while this
/// LRU bound prevents that unavoidable ambiguity from growing memory.
///
/// A scan on insertion keeps the hot lookup/refresh path O(1) without an
/// auxiliary heap whose stale nodes could grow without bound. Insertions happen
/// only when a relay ends or is reclaimed, and the scan is capped at 4096 tiny
/// entries.
struct KnownSourceTombstones {
    entries: HashMap<ClientKey, u64>,
    activity_clock: u64,
    capacity: usize,
}

impl Default for KnownSourceTombstones {
    fn default() -> Self {
        Self::with_capacity(MAX_KNOWN_SOURCE_TOMBSTONES)
    }
}

impl KnownSourceTombstones {
    fn with_capacity(capacity: usize) -> Self {
        assert!(capacity > 0, "tombstone capacity must be positive");
        Self {
            entries: HashMap::with_capacity(capacity),
            activity_clock: 0,
            capacity,
        }
    }

    fn contains(&self, address: &ClientKey) -> bool {
        self.entries.contains_key(address)
    }

    fn remove(&mut self, address: &ClientKey) -> bool {
        self.entries.remove(address).is_some()
    }

    fn touch(&mut self, address: &ClientKey) -> bool {
        if !self.entries.contains_key(address) {
            return false;
        }
        let activity = self.next_activity();
        self.entries.insert(*address, activity);
        true
    }

    /// Remember `address`, returning the least-recently-active tombstone that
    /// had to be forgotten to preserve the strict bound.
    fn remember(&mut self, address: ClientKey) -> Option<ClientKey> {
        let activity = self.next_activity();
        self.entries.insert(address, activity);
        if self.entries.len() <= self.capacity {
            return None;
        }

        let oldest = self
            .entries
            .iter()
            .min_by_key(|(_, activity)| **activity)
            .map(|(candidate, _)| *candidate)
            .expect("an over-capacity tombstone table is non-empty");
        self.entries.remove(&oldest);
        Some(oldest)
    }

    fn next_activity(&mut self) -> u64 {
        if self.activity_clock == u64::MAX {
            // This is unreachable in a practical harness run, but preserving
            // ordering here avoids a theoretical wraparound turning newest
            // entries into eviction victims.
            let mut ordered: Vec<(ClientKey, u64)> = self
                .entries
                .iter()
                .map(|(address, activity)| (*address, *activity))
                .collect();
            ordered.sort_unstable_by_key(|(_, activity)| *activity);
            for (index, (address, _)) in ordered.into_iter().enumerate() {
                self.entries.insert(address, index as u64 + 1);
            }
            self.activity_clock = self.entries.len() as u64;
        }
        self.activity_clock += 1;
        self.activity_clock
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.entries.len()
    }
}

impl ClientRelay {
    fn has_finished_task(&self) -> bool {
        self.tasks.iter().any(JoinHandle::is_finished)
    }
}

impl Drop for ClientRelay {
    fn drop(&mut self) {
        self.impairment.detach_relay(self.slot, self.admission_seq);
        self.state.close();
        for task in &self.tasks {
            task.abort();
        }
    }
}

/// A delay line has no capacity to run out of: it takes the packet, or its
/// release task has ended with the relay.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PacketEnqueueResult {
    Enqueued,
    Closed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum PendingAdmissionKind {
    NewInitial,
    KnownSource,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ClientAdmission {
    Admit {
        reclaimed: Option<ClientKey>,
        reactivated: bool,
    },
    Orphan,
    CapacityBusy {
        kind: PendingAdmissionKind,
    },
}

struct PendingAdmission {
    /// Index of the listener it arrived on.
    listener: usize,
    client: SocketAddr,
    packet: Vec<u8>,
    kind: PendingAdmissionKind,
}

#[derive(Default)]
struct AdmissionHandoff {
    pending: Option<PendingAdmission>,
}

enum HandoffOffer {
    Stored,
    Duplicate(PendingAdmission),
    Replaced { displaced: PendingAdmission },
    Full(PendingAdmission),
}

impl AdmissionHandoff {
    fn is_pending(&self) -> bool {
        self.pending.is_some()
    }

    fn source_is_pending(&self, listener: usize, client: SocketAddr) -> bool {
        self.pending
            .as_ref()
            .is_some_and(|pending| pending.listener == listener && pending.client == client)
    }

    fn offer(&mut self, candidate: PendingAdmission) -> HandoffOffer {
        let Some(current) = self.pending.as_ref() else {
            self.pending = Some(candidate);
            return HandoffOffer::Stored;
        };
        if current.listener == candidate.listener && current.client == candidate.client {
            return HandoffOffer::Duplicate(candidate);
        }
        if candidate.kind > current.kind {
            let displaced = self
                .pending
                .replace(candidate)
                .expect("a checked full handoff contains a packet");
            return HandoffOffer::Replaced { displaced };
        }
        HandoffOffer::Full(candidate)
    }

    fn take(&mut self) -> Option<PendingAdmission> {
        self.pending.take()
    }

    fn restore(&mut self, pending: PendingAdmission) {
        debug_assert!(self.pending.is_none());
        self.pending = Some(pending);
    }

    #[cfg(test)]
    fn pending(&self) -> Option<&PendingAdmission> {
        self.pending.as_ref()
    }
}

enum ForwardResult {
    Handled,
    Orphan,
    CapacityBusy { kind: PendingAdmissionKind },
}

struct ProxyRuntime {
    listeners: Vec<Listener>,
    clients: HashMap<ClientKey, ClientRelay>,
    tombstones: KnownSourceTombstones,
    activity_clock: Arc<AtomicU64>,
    network_impairment: Arc<NetworkImpairment>,
    split_one_rtt: bool,
    partition: Arc<Partition>,
    quiescence: Arc<Notify>,
    /// Monotonic admission counter. Never reset, so a partition armed at one
    /// value can never be satisfied by a later connection reusing an address.
    admission_seq: u64,
    /// Where the session's browser relays leave from, admitted ones included.
    browser_source: UpstreamSource,
}

impl ProxyRuntime {
    fn prune_finished_relays(&mut self) {
        let mut removed = false;
        self.clients.retain(|client, relay| {
            if !relay.has_finished_task() {
                return true;
            }
            remember_tombstone(&mut self.tombstones, *client);
            removed = true;
            false
        });
        if removed {
            self.quiescence.notify_one();
        }
    }

    async fn forward_client_packet(
        &mut self,
        listener: usize,
        client: SocketAddr,
        data: &[u8],
        authorization: Option<PendingAdmissionKind>,
    ) -> ForwardResult {
        let listener_id = self.listeners[listener].id;
        let key = (listener, client);
        // A partition is symmetric: a real carrier loss does not politely keep
        // delivering one direction.
        if let Some(relay) = self.clients.get(&key)
            && self.partition.blocks(relay.admission_seq, listener_id.role)
        {
            return ForwardResult::Handled;
        }
        // Checked before admission so a whole-path partition cannot have relay
        // state created underneath it. An `Established` partition deliberately
        // does NOT block here: admitting the replacement dial is the entire
        // point of that scope.
        if !self.clients.contains_key(&key)
            && self.partition.blocks_admission(listener_id.role)
        {
            return ForwardResult::Handled;
        }
        let (upstream_tx, relay_state, slot, admission_seq) = match self.clients.get_mut(&key) {
            Some(relay) => (
                relay.upstream_tx.clone(),
                relay.state.clone(),
                relay.slot,
                relay.admission_seq,
            ),
            None => {
                let admission = match authorization {
                    Some(kind) => prepare_authorized_client_admission(
                        &mut self.clients,
                        &mut self.tombstones,
                        key,
                        kind,
                    ),
                    None => {
                        prepare_client_admission(&mut self.clients, &mut self.tombstones, key, data)
                    }
                };
                match admission {
                    ClientAdmission::Orphan => return ForwardResult::Orphan,
                    ClientAdmission::CapacityBusy { kind } => {
                        return ForwardResult::CapacityBusy { kind };
                    }
                    ClientAdmission::Admit {
                        reclaimed,
                        reactivated,
                    } => {
                        if reclaimed.is_some() {
                            record_reclaim();
                        }
                        if reactivated {
                            record_reactivation();
                        }
                    }
                }

                let upstream = self.listeners[listener].upstream;
                let switchable = listener_id.role == Role::Browser && !listener_id.competitor;
                let up = bind_upstream(
                    if switchable {
                        self.browser_source
                    } else {
                        UpstreamSource::Configured
                    },
                    upstream,
                )
                .await;
                let upstream_port = up.local_addr().expect("bound upstream socket").port();
                let relay_state = Arc::new(RelayState::with_quiescence(self.quiescence.clone()));
                self.admission_seq += 1;
                let admission_seq = self.admission_seq;
                // With the edge's own attachment log this names the lane each
                // relay carries: the edge sees this relay at `upstream_port`.
                eprintln!(
                    "delay_proxy: relay admission_seq={admission_seq} role={} competitor={} client={client} upstream_port={upstream_port}",
                    role_env(listener_id.role).to_ascii_lowercase(),
                    listener_id.competitor,
                );
                let slot = self.network_impairment.attach_relay(
                    admission_seq,
                    relay_state.clone(),
                    listener_id,
                    upstream_port,
                );
                let (upstream_tx, upstream_rx) = mpsc::unbounded_channel();
                let (upstream_socket, upstream_sockets) = watch::channel(up.clone());
                let upstream_sender = tokio::spawn(send_delayed_connected(
                    upstream_sockets,
                    upstream_rx,
                    self.network_impairment.clone(),
                ));

                let downlink = self
                    .network_impairment
                    .link(listener_id.role, LinkDirection::Down)
                    .cloned()
                    .map(|link| (link, slot, admission_seq));
                let lose_after_link = downlink.is_some();
                let (downstream_tx, downstream_rx) = mpsc::unbounded_channel();
                let downstream_sender = tokio::spawn(send_delayed_to_client(
                    self.listeners[listener].socket.clone(),
                    client,
                    downstream_rx,
                    self.network_impairment.clone(),
                    downlink,
                ));

                let reader = UpstreamReader {
                    relay_state: relay_state.clone(),
                    activity_clock: self.activity_clock.clone(),
                    impairment: self.network_impairment.clone(),
                    partition: self.partition.clone(),
                    split_one_rtt: self.split_one_rtt,
                    admission_seq,
                    slot,
                    role: listener_id.role,
                    lose_after_link,
                    downstream_tx,
                };
                let upstream_reader = reader.clone().spawn(up);
                self.clients.insert(
                    key,
                    ClientRelay {
                        upstream_tx: upstream_tx.clone(),
                        state: relay_state.clone(),
                        tasks: vec![upstream_sender, downstream_sender, upstream_reader],
                        admission_seq,
                        slot,
                        impairment: self.network_impairment.clone(),
                        source: switchable.then_some(RelaySource {
                            socket: upstream_socket,
                            reader,
                            upstream,
                        }),
                    },
                );
                (upstream_tx, relay_state, slot, admission_seq)
            }
        };

        // Forward: client -> (impairment trace) -> edge. Acquire the packet
        // lease before a deliberate drop so receipt still refreshes the LRU
        // activity ordinal, exactly as the downstream reader does.
        let pending = match relay_state.try_acquire_packet(&self.activity_clock) {
            Ok(pending) => pending,
            Err(LeaseRefusal::Closed) => {
                self.remove_closed_client(key);
                return ForwardResult::Handled;
            }
            // Only this packet is lost: the relay and every packet it already
            // holds stay, and the drop line fails the harness run.
            Err(LeaseRefusal::Exhausted) => {
                record_lease_exhaustion();
                return ForwardResult::Handled;
            }
        };
        // The map owns this relay, so its trace slot is attached: `None` is the
        // same closed relay as a failed lease.
        let now = Instant::now();
        let Some(decision) =
            self.network_impairment
                .decide(slot, admission_seq, ImpairmentDirection::Upstream, now)
        else {
            self.remove_closed_client(key);
            return ForwardResult::Handled;
        };
        if decision.dropped {
            record_impairment();
            return ForwardResult::Handled;
        }
        if decision.reordered {
            record_reorder();
        }
        let scheduled = UnadmittedDelayedPacket {
            deadline: decision.deadline,
            trace_epoch: decision.trace_epoch,
            trace_generation: decision.trace_generation,
            trace_sequence: decision.trace_sequence,
            trace_reorder_selected: decision.reordered,
            lost: false,
            data: data.to_vec(),
        };
        // An uplink sits before the leg's delay: the packet enters its delay
        // line when the link departs it, and waits the leg's delay from there.
        if let Some(uplink) = self
            .network_impairment
            .link(listener_id.role, LinkDirection::Up)
        {
            let bytes = data.len() as u64 + LINK_HEADER_BYTES;
            let packet = DelayedPacket::new(scheduled, pending, ImpairmentDirection::Upstream);
            let offered = uplink.offer(Arrival {
                at: now,
                slot,
                admission_seq,
                bytes,
                payload: LinkPacket {
                    packet,
                    exit: LinkExit::DelayLine {
                        tx: upstream_tx,
                        delay: decision.deadline.saturating_duration_since(now),
                    },
                },
            });
            debug_assert!(offered, "a link lives as long as the proxy");
            return ForwardResult::Handled;
        }
        if enqueue_admitted_delayed_packet(
            &upstream_tx,
            scheduled,
            pending,
            ImpairmentDirection::Upstream,
        ) == PacketEnqueueResult::Closed
        {
            self.remove_closed_client(key);
        }
        ForwardResult::Handled
    }

    fn remove_closed_client(&mut self, client: ClientKey) {
        if self.clients.remove(&client).is_some() {
            remember_tombstone(&mut self.tombstones, client);
            self.quiescence.notify_one();
        }
    }

    /// Move every session browser relay to a fresh upstream socket leaving
    /// from `source`, and admit later ones from it. The old socket stays read,
    /// so what the edge still sends to the old address arrives, as it does
    /// while a migrated path is being validated. Returns how many relays moved.
    async fn switch_browser_source(&mut self, source: UpstreamSource) -> usize {
        self.browser_source = source;
        let mut moved = 0;
        for relay in self.clients.values_mut() {
            let Some(switchable) = relay.source.as_ref() else {
                continue;
            };
            let socket = bind_upstream(source, switchable.upstream).await;
            let upstream_port = socket.local_addr().map_or(0, |address| address.port());
            relay
                .tasks
                .push(switchable.reader.clone().spawn(socket.clone()));
            switchable.socket.send_replace(socket);
            eprintln!(
                "delay_proxy: relay source admission_seq={} source={} upstream_port={upstream_port}",
                relay.admission_seq,
                source.as_str(),
            );
            moved += 1;
        }
        moved
    }
}

/// The listeners `LISTEN_DAEMON`, `LISTEN_BROWSER` and
/// `LISTEN_COMPETITOR_<DAEMON|BROWSER>` declare, bound, in that order.
async fn listeners_from_env(upstream: SocketAddr) -> Vec<Listener> {
    let competitor_upstream: Option<SocketAddr> = std::env::var("COMPETITOR_UPSTREAM")
        .ok()
        .map(|raw| raw.parse().expect("COMPETITOR_UPSTREAM addr"));
    let mut listeners = Vec::new();
    for (name, role, competitor) in [
        ("LISTEN_DAEMON", Role::Daemon, false),
        ("LISTEN_BROWSER", Role::Browser, false),
        ("LISTEN_COMPETITOR_DAEMON", Role::Daemon, true),
        ("LISTEN_COMPETITOR_BROWSER", Role::Browser, true),
    ] {
        let Ok(raw) = std::env::var(name) else {
            continue;
        };
        let address: SocketAddr = raw
            .parse()
            .unwrap_or_else(|_| panic!("{name} must be a socket address"));
        let upstream = if competitor {
            competitor_upstream
                .unwrap_or_else(|| panic!("{name} requires COMPETITOR_UPSTREAM"))
        } else {
            upstream
        };
        let socket = UdpSocket::bind(address)
            .await
            .unwrap_or_else(|error| panic!("bind {name} {address}: {error}"));
        listeners.push(Listener {
            id: ListenerId { role, competitor },
            socket: Arc::new(socket),
            upstream,
        });
    }
    assert!(
        listeners.iter().any(|listener| !listener.id.competitor),
        "LISTEN_DAEMON or LISTEN_BROWSER is required"
    );
    assert!(
        listeners.len() <= 4,
        "one listener per role and competitor at most"
    );
    listeners
}

/// Receives on listener `index`, or never when there is no such listener.
async fn recv_on(
    listeners: &[Listener],
    index: usize,
    buf: &mut [u8],
) -> std::io::Result<(usize, SocketAddr)> {
    match listeners.get(index) {
        Some(listener) => listener.socket.recv_from(buf).await,
        None => std::future::pending().await,
    }
}

#[tokio::main]
async fn main() {
    let upstream: SocketAddr = std::env::var("UPSTREAM")
        .unwrap_or_else(|_| "[::1]:4433".into())
        .parse()
        .expect("UPSTREAM addr");
    let impairment_config = ImpairmentConfig::from_env();
    let split_one_rtt = impairment_config.split_one_rtt();
    // Harness-only control socket. The latency fixture resets every relay's
    // trace immediately before a measurement window, and a paired measurement
    // marks one key before each of its members, so relay by relay they replay
    // identical loss, jitter, reorder, burst, and congestion-window decisions
    // instead of inheriting a phase from other connections' traffic.
    let control_listen: SocketAddr = std::env::var("CONTROL_LISTEN")
        .unwrap_or_else(|_| "[::1]:0".into())
        .parse()
        .expect("CONTROL_LISTEN addr");

    let listeners = listeners_from_env(upstream).await;
    let link_configs = links_from_env();
    for config in &link_configs {
        assert!(
            listeners.iter().any(|listener| listener.id.role == config.role),
            "a {:?} link needs a {:?} listener",
            config.direction,
            config.role
        );
    }
    let control = UdpSocket::bind(control_listen)
        .await
        .expect("bind CONTROL_LISTEN");
    let listening: Vec<String> = listeners
        .iter()
        .map(|listener| {
            let local = listener
                .socket
                .local_addr()
                .expect("bound listener has an address");
            let role = match listener.id.role {
                Role::Daemon => "daemon",
                Role::Browser => "browser",
            };
            if listener.id.competitor {
                format!("competitor-{role}={local}->{}", listener.upstream)
            } else {
                format!("{role}={local}")
            }
        })
        .collect();
    let declared_links: Vec<String> = link_configs
        .iter()
        .map(|link| {
            format!(
                "{}-{}:{}:{}{}{}",
                role_env(link.role).to_ascii_lowercase(),
                direction_env(link.direction).to_ascii_lowercase(),
                link.rate_bps,
                link.buffer_bytes,
                if link.fq { ":fq" } else { "" },
                link.step.map_or(String::new(), |step| format!(
                    "@{}={}",
                    step.after_mark_ms, step.rate_bps
                )),
            )
        })
        .collect();
    println!(
        "delay_proxy: ready {} -> {upstream} profile={} target_rtt_ms={} four_leg_hop_us={} jitter_radius_us={} datagram_loss_percent={} fault_site=edge-to-client reorder={:?} scenario={:?} seed={} links=[{}]",
        listening.join(" "),
        impairment_config.profile,
        impairment_config.target_rtt_ms,
        impairment_config.base_delay_us,
        impairment_config.jitter_radius_us,
        impairment_config.datagram_loss_percent,
        impairment_config.reorder,
        impairment_config.scenario,
        impairment_config.seed,
        declared_links.join(","),
    );

    let quiescence = Arc::new(Notify::new());
    let network_impairment = Arc::new(NetworkImpairment::new(
        impairment_config,
        spawn_links(&link_configs),
    ));
    let mut runtime = ProxyRuntime {
        listeners,
        clients: HashMap::new(),
        tombstones: KnownSourceTombstones::default(),
        activity_clock: Arc::new(AtomicU64::new(0)),
        network_impairment,
        split_one_rtt,
        partition: Arc::new(Partition::default()),
        quiescence: quiescence.clone(),
        admission_seq: 0,
        browser_source: UpstreamSource::Configured,
    };
    let mut handoff = AdmissionHandoff::default();
    // One receive buffer per listener: each select branch owns its own.
    let receivers: Vec<Listener> = runtime
        .listeners
        .iter()
        .map(|listener| Listener {
            id: listener.id,
            socket: listener.socket.clone(),
            upstream: listener.upstream,
        })
        .collect();
    let mut bufs: [Vec<u8>; 4] = std::array::from_fn(|_| vec![0u8; 65535]);
    let [buf0, buf1, buf2, buf3] = &mut bufs;
    let mut control_buf = [0u8; 512];
    let mut control_response_cache = ControlResponseCache::default();
    let mut control_response_id = 0u32;

    loop {
        tokio::select! {
            biased;
            control_received = control.recv_from(&mut control_buf) => {
                let Ok((n, source)) = control_received else {
                    continue;
                };
                let Ok(request) = std::str::from_utf8(&control_buf[..n]) else {
                    let _ = control.send_to(b"error:invalid_utf8", source).await;
                    continue;
                };
                let mut fields = request.split(':');
                match (fields.next(), fields.next(), fields.next(), fields.next()) {
                    (Some("reset"), Some(nonce), None, None) if !nonce.is_empty() => {
                        if let Some(responses) =
                            control_response_cache.get(request, Instant::now())
                        {
                            send_control_responses(&control, responses, source).await;
                            continue;
                        }
                        let stats = runtime.network_impairment.reset();
                        control_response_id = control_response_id.wrapping_add(1).max(1);
                        let responses = proxy_control_response_chunks(
                            "reset",
                            nonce,
                            control_response_id,
                            &stats,
                        );
                        send_control_responses(&control, &responses, source).await;
                        control_response_cache.insert(
                            request.to_owned(),
                            responses,
                            Instant::now(),
                        );
                        eprintln!(
                            "delay_proxy: deterministic impairment trace reset epoch={} seed={}",
                            stats.epoch,
                            stats.config.seed,
                        );
                    }
                    // `partition:<nonce>:<duration_ms>` blackholes both
                    // directions for that long, then restores automatically.
                    // A carrier that stops and comes back is the case reconnect
                    // exists for, and periodic loss cannot express it.
                    (Some("partition"), Some(nonce), Some(raw_duration), None)
                        if !nonce.is_empty() =>
                    {
                        let Ok(duration_ms) = raw_duration.parse::<u64>() else {
                            let _ = control.send_to(b"error:invalid_duration", source).await;
                            continue;
                        };
                        if duration_ms == 0 || duration_ms > MAX_PARTITION_MS {
                            let _ = control.send_to(b"error:duration_out_of_range", source).await;
                            continue;
                        }
                        runtime
                            .partition
                            .arm(Duration::from_millis(duration_ms), PartitionScope::Everything);
                        let response = format!("partitioned:{nonce}:{duration_ms}");
                        let _ = control.send_to(response.as_bytes(), source).await;
                    }
                    // `partition-established:<nonce>:<duration_ms>` cuts only
                    // the connections that exist right now, and lets a fresh
                    // dial straight through.
                    //
                    // A separate verb rather than a fourth field on `partition`
                    // deliberately: the control parser splits on ':' and matches
                    // an exact three-field shape, and every candidate for a
                    // fourth field (a scope name today, a socket address later)
                    // would either break that shape or, for IPv6, be split apart
                    // by its own colons.
                    (Some(verb @ ("partition-established" | "partition-browser-established")), Some(nonce), Some(raw_duration), None)
                        if !nonce.is_empty() =>
                    {
                        let Ok(duration_ms) = raw_duration.parse::<u64>() else {
                            let _ = control.send_to(b"error:invalid_duration", source).await;
                            continue;
                        };
                        if duration_ms == 0 || duration_ms > MAX_PARTITION_MS {
                            let _ = control.send_to(b"error:duration_out_of_range", source).await;
                            continue;
                        }
                        let admitted_through = runtime.admission_seq;
                        runtime.partition.arm(
                            Duration::from_millis(duration_ms),
                            if verb == "partition-browser-established" { PartitionScope::BrowserEstablished { admitted_through } } else { PartitionScope::Established { admitted_through } },
                        );
                        let response =
                            format!("partitioned:{nonce}:{duration_ms}:{admitted_through}");
                        let _ = control.send_to(response.as_bytes(), source).await;
                    }
                    // `partition-browser-dials:<nonce>:<duration_ms>` admits
                    // nothing a browser dials for that long and cuts nothing
                    // that exists. Armed over a running partition it replaces
                    // it, as every arming does.
                    (Some("partition-browser-dials"), Some(nonce), Some(raw_duration), None)
                        if !nonce.is_empty() =>
                    {
                        let Ok(duration_ms) = raw_duration.parse::<u64>() else {
                            let _ = control.send_to(b"error:invalid_duration", source).await;
                            continue;
                        };
                        if duration_ms == 0 || duration_ms > MAX_PARTITION_MS {
                            let _ = control.send_to(b"error:duration_out_of_range", source).await;
                            continue;
                        }
                        runtime
                            .partition
                            .arm(Duration::from_millis(duration_ms), PartitionScope::BrowserDials);
                        let response = format!("partitioned:{nonce}:{duration_ms}");
                        let _ = control.send_to(response.as_bytes(), source).await;
                    }
                    // `source:<nonce>:<configured|ipv4-loopback>`. A repeat
                    // of the current source is a new port on the same
                    // address. The reply is cached by request, so a retried
                    // request moves nothing twice.
                    (Some("source"), Some(nonce), Some(raw_source), None) if !nonce.is_empty() => {
                        if let Some(responses) =
                            control_response_cache.get(request, Instant::now())
                        {
                            send_control_responses(&control, responses, source).await;
                            continue;
                        }
                        let Some(upstream_source) = UpstreamSource::parse(raw_source) else {
                            let _ = control.send_to(b"error:invalid_source", source).await;
                            continue;
                        };
                        let moved = runtime.switch_browser_source(upstream_source).await;
                        let response = format!("sourced:{nonce}:{raw_source}:{moved}").into_bytes();
                        let _ = control.send_to(&response, source).await;
                        control_response_cache.insert(
                            request.to_owned(),
                            vec![response],
                            Instant::now(),
                        );
                    }
                    (Some("stats"), Some(nonce), None, None) if !nonce.is_empty() => {
                        if let Some(responses) =
                            control_response_cache.get(request, Instant::now())
                        {
                            send_control_responses(&control, responses, source).await;
                            continue;
                        }
                        let stats = runtime.network_impairment.stats();
                        control_response_id = control_response_id.wrapping_add(1).max(1);
                        let responses = proxy_control_response_chunks(
                            "stats",
                            nonce,
                            control_response_id,
                            &stats,
                        );
                        send_control_responses(&control, &responses, source).await;
                        control_response_cache.insert(
                            request.to_owned(),
                            responses,
                            Instant::now(),
                        );
                    }
                    (Some("settle"), Some(nonce), None, None) if !nonce.is_empty() => {
                        // Cached by request like `stats`: a retry replays the
                        // same snapshot, never a newer one mixed into its chunks.
                        if let Some(responses) =
                            control_response_cache.get(request, Instant::now())
                        {
                            send_control_responses(&control, responses, source).await;
                            continue;
                        }
                        let status = runtime.network_impairment.settle_status();
                        control_response_id = control_response_id.wrapping_add(1).max(1);
                        let responses = proxy_control_response_chunks(
                            "settle",
                            nonce,
                            control_response_id,
                            &status,
                        );
                        send_control_responses(&control, &responses, source).await;
                        control_response_cache.insert(
                            request.to_owned(),
                            responses,
                            Instant::now(),
                        );
                    }
                    // `mark:<nonce>:<key>` restarts every relay's trace under
                    // `key` at its next decision. Its reply is cached by
                    // request, so a retried request cannot mark twice.
                    (Some("mark"), Some(nonce), Some(raw_key), None) if !nonce.is_empty() => {
                        let Ok(key) = raw_key.parse::<u64>() else {
                            let _ = control.send_to(b"error:invalid_key", source).await;
                            continue;
                        };
                        if !(1..MAX_TRACE_MARK_KEY).contains(&key) {
                            let _ = control.send_to(b"error:key_out_of_range", source).await;
                            continue;
                        }
                        let responses = cached_mark_response(
                            &runtime.network_impairment,
                            &mut control_response_cache,
                            &mut control_response_id,
                            request,
                            nonce,
                            key,
                            Instant::now(),
                        );
                        send_control_responses(&control, &responses, source).await;
                    }
                    _ => {
                        let _ = control.send_to(b"error:invalid_command", source).await;
                    }
                }
            }
            _ = quiescence.notified(), if handoff.is_pending() => {
                let pending = handoff
                    .take()
                    .expect("the guarded handoff contains one packet");
                match runtime
                    .forward_client_packet(
                        pending.listener,
                        pending.client,
                        &pending.packet,
                        Some(pending.kind),
                    )
                    .await
                {
                    ForwardResult::Handled => {}
                    ForwardResult::Orphan => {
                        debug_assert!(false, "authorized pending admission became orphaned");
                    }
                    ForwardResult::CapacityBusy { .. } => handoff.restore(pending),
                }
            }
            received = recv_on(&receivers, 0, buf0) => {
                on_client_datagram(&mut runtime, &mut handoff, &quiescence, 0, received, buf0).await;
            }
            received = recv_on(&receivers, 1, buf1) => {
                on_client_datagram(&mut runtime, &mut handoff, &quiescence, 1, received, buf1).await;
            }
            received = recv_on(&receivers, 2, buf2) => {
                on_client_datagram(&mut runtime, &mut handoff, &quiescence, 2, received, buf2).await;
            }
            received = recv_on(&receivers, 3, buf3) => {
                on_client_datagram(&mut runtime, &mut handoff, &quiescence, 3, received, buf3).await;
            }
        }
    }
}

async fn on_client_datagram(
    runtime: &mut ProxyRuntime,
    handoff: &mut AdmissionHandoff,
    quiescence: &Notify,
    listener: usize,
    received: std::io::Result<(usize, SocketAddr)>,
    buf: &[u8],
) {
    let Ok((n, client)) = received else {
        return;
    };
    if n > MAX_PROXY_PACKET_BYTES {
        record_drop(
            &OVERSIZED_PACKET_DROPS,
            "oversized UDP packet",
            MAX_PROXY_PACKET_BYTES,
        );
        return;
    }
    runtime.prune_finished_relays();
    let data = &buf[..n];

    // Retain the exact first packet already owned by this source's handoff;
    // retransmissions cannot grow memory or replace it.
    if handoff.source_is_pending(listener, client) {
        return;
    }

    // A single pending admission is the hard ownership bound. Existing relays
    // continue normally; another unseen candidate is offered to the
    // deterministic priority policy below.
    if handoff.is_pending() && !runtime.clients.contains_key(&(listener, client)) {
        match classify_pending_admission(&runtime.tombstones, (listener, client), data) {
            Some(kind) => offer_pending_admission(
                handoff,
                PendingAdmission {
                    listener,
                    client,
                    packet: data.to_vec(),
                    kind,
                },
                quiescence,
            ),
            None => record_orphan(),
        }
        return;
    }

    match runtime
        .forward_client_packet(listener, client, data, None)
        .await
    {
        ForwardResult::Handled => {}
        ForwardResult::Orphan => record_orphan(),
        ForwardResult::CapacityBusy { kind } => offer_pending_admission(
            handoff,
            PendingAdmission {
                listener,
                client,
                packet: data.to_vec(),
                kind,
            },
            quiescence,
        ),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProxyControlChunkResponse<'a> {
    kind: &'static str,
    nonce: &'a str,
    response_id: u32,
    chunk_index: u16,
    chunk_count: u16,
    payload_byte_length: usize,
    payload_base64: String,
}

#[derive(Default)]
struct ControlResponseCache {
    entries: VecDeque<CachedControlResponse>,
}

struct CachedControlResponse {
    request: String,
    created_at: Instant,
    responses: Vec<Vec<u8>>,
}

impl ControlResponseCache {
    fn get(&mut self, request: &str, now: Instant) -> Option<&[Vec<u8>]> {
        while self.entries.front().is_some_and(|entry| {
            now.saturating_duration_since(entry.created_at) > CONTROL_RESPONSE_CACHE_TTL
        }) {
            self.entries.pop_front();
        }
        self.entries
            .iter()
            .find(|entry| entry.request == request)
            .map(|entry| entry.responses.as_slice())
    }

    fn insert(&mut self, request: String, responses: Vec<Vec<u8>>, now: Instant) {
        if self.entries.len() == CONTROL_RESPONSE_CACHE_CAPACITY {
            self.entries.pop_front();
        }
        self.entries.push_back(CachedControlResponse {
            request,
            created_at: now,
            responses,
        });
    }
}

/// One control reply, JSON-encoded and split into portable datagrams. Every
/// reply that carries relay state takes this form: the relay table is sized
/// for the live connections through the proxy, not for one datagram.
fn proxy_control_response_chunks<T: Serialize>(
    kind: &'static str,
    nonce: &str,
    response_id: u32,
    body: &T,
) -> Vec<Vec<u8>> {
    let payload = serde_json::to_vec(body)
        .expect("control replies contain only serializable finite values");
    let chunk_count = payload.len().div_ceil(CONTROL_RESPONSE_CHUNK_PAYLOAD_BYTES);
    assert!(
        chunk_count > 0 && chunk_count <= MAX_CONTROL_RESPONSE_CHUNKS,
        "a bounded control reply exceeds the control response chunk limit"
    );
    let chunk_count = u16::try_from(chunk_count).expect("control chunk count fits u16");
    payload
        .chunks(CONTROL_RESPONSE_CHUNK_PAYLOAD_BYTES)
        .enumerate()
        .map(|(chunk_index, chunk)| {
            let response = serde_json::to_vec(&ProxyControlChunkResponse {
                kind,
                nonce,
                response_id,
                chunk_index: u16::try_from(chunk_index).expect("control chunk index fits u16"),
                chunk_count,
                payload_byte_length: payload.len(),
                payload_base64: BASE64_STANDARD.encode(chunk),
            })
            .expect("control response chunk contains only serializable values");
            assert!(
                response.len() <= MAX_CONTROL_RESPONSE_DATAGRAM_BYTES,
                "control response chunk exceeds the portable UDP datagram ceiling"
            );
            response
        })
        .collect()
}

async fn send_control_responses(control: &UdpSocket, responses: &[Vec<u8>], source: SocketAddr) {
    for response in responses {
        if let Err(error) = control.send_to(response, source).await {
            eprintln!("delay_proxy: control response send failed: {error}");
            break;
        }
    }
}

/// Applies one `mark` request exactly once: a retry of the same request string
/// replays the cached reply instead of advancing the generation again.
fn cached_mark_response(
    impairment: &NetworkImpairment,
    cache: &mut ControlResponseCache,
    response_id: &mut u32,
    request: &str,
    nonce: &str,
    key: u64,
    now: Instant,
) -> Vec<Vec<u8>> {
    if let Some(cached) = cache.get(request, now) {
        return cached.to_vec();
    }
    *response_id = response_id.wrapping_add(1).max(1);
    let responses = proxy_control_response_chunks("mark", nonce, *response_id, &impairment.mark(key));
    cache.insert(request.to_owned(), responses.clone(), now);
    responses
}

fn enqueue_admitted_delayed_packet(
    tx: &mpsc::UnboundedSender<DelayedPacket>,
    packet: UnadmittedDelayedPacket,
    pending: PendingPacketGuard,
    direction: ImpairmentDirection,
) -> PacketEnqueueResult {
    match tx.send(DelayedPacket::new(packet, pending, direction)) {
        Ok(()) => PacketEnqueueResult::Enqueued,
        Err(_) => PacketEnqueueResult::Closed,
    }
}

fn record_orphan() {
    let count = ORPHAN_PACKET_IGNORES
        .fetch_add(1, Ordering::Relaxed)
        .wrapping_add(1);
    if count == 1 || count.is_power_of_two() {
        eprintln!(
            "delay_proxy: ignored {count} orphan client packet(s): unseen source without QUIC Initial"
        );
    }
}

fn record_drop(counter: &AtomicU64, reason: &'static str, limit: usize) {
    let count = counter.fetch_add(1, Ordering::Relaxed).wrapping_add(1);
    if count == 1 || count.is_power_of_two() {
        eprintln!("delay_proxy: dropped {count} packet(s): {reason} limit={limit}");
    }
}

/// An exhausted relay lease is proxy overload, never impairment; the harness
/// fails the run on the drop line this prints.
fn record_lease_exhaustion() {
    record_drop(
        &RELAY_LEASE_EXHAUSTIONS,
        "relay packet lease exhausted",
        RELAY_PENDING_MASK as usize,
    );
}

fn record_impairment() {
    let count = IMPAIRMENT_PACKET_DROPS
        .fetch_add(1, Ordering::Relaxed)
        .wrapping_add(1);
    if count == 1 || count.is_power_of_two() {
        eprintln!("delay_proxy: impaired {count} packet(s): seeded edge-to-client downstream loss");
    }
}

fn record_reorder() {
    let count = DOWNSTREAM_REORDER_INJECTIONS
        .fetch_add(1, Ordering::Relaxed)
        .wrapping_add(1);
    if count == 1 || count.is_power_of_two() {
        eprintln!(
            "delay_proxy: reordered {count} packet(s): seeded edge-to-client downstream holdback"
        );
    }
}

fn record_coalesced_split() {
    let count = DOWNSTREAM_COALESCED_SPLITS
        .fetch_add(1, Ordering::Relaxed)
        .wrapping_add(1);
    if count == 1 || count.is_power_of_two() {
        eprintln!(
            "delay_proxy: split {count} coalesced datagram(s): 1-RTT suffix released ahead of its crypto prefix"
        );
    }
}

fn record_reclaim() {
    let count = CLIENT_RELAY_RECLAIMS
        .fetch_add(1, Ordering::Relaxed)
        .wrapping_add(1);
    if count == 1 || count.is_power_of_two() {
        eprintln!(
            "delay_proxy: reclaimed {count} quiescent least-recently-used client relay(s): capacity={MAX_PROXY_CLIENTS}"
        );
    }
}

fn record_reactivation() {
    let count = CLIENT_RELAY_REACTIVATIONS
        .fetch_add(1, Ordering::Relaxed)
        .wrapping_add(1);
    if count == 1 || count.is_power_of_two() {
        eprintln!(
            "delay_proxy: reactivated {count} known client relay(s) through QUIC address rebinding"
        );
    }
}

fn remember_tombstone(tombstones: &mut KnownSourceTombstones, address: ClientKey) {
    let Some(forgotten) = tombstones.remember(address) else {
        return;
    };
    let count = TOMBSTONE_EVICTIONS
        .fetch_add(1, Ordering::Relaxed)
        .wrapping_add(1);
    if count == 1 || count.is_power_of_two() {
        eprintln!(
            "delay_proxy: forgot {count} least-recently-active source tombstone(s): \
             capacity={MAX_KNOWN_SOURCE_TOMBSTONES}, last={forgotten:?}"
        );
    }
}

fn offer_pending_admission(
    handoff: &mut AdmissionHandoff,
    candidate: PendingAdmission,
    quiescence: &Notify,
) {
    match handoff.offer(candidate) {
        HandoffOffer::Stored => {}
        HandoffOffer::Duplicate(duplicate) => {
            drop(duplicate);
            return;
        }
        HandoffOffer::Replaced { displaced } => {
            drop(displaced);
            record_drop(
                &CLIENT_ADMISSION_DROPS,
                "pending admission replaced by known-source recovery",
                1,
            );
        }
        HandoffOffer::Full(rejected) => {
            drop(rejected);
            record_drop(&CLIENT_ADMISSION_DROPS, "pending admission handoff", 1);
            return;
        }
    }
    // Audit once immediately to close a notify-before-store race. If all
    // relays remain busy, the packet is restored and the next pending->zero
    // transition supplies the only subsequent wake.
    quiescence.notify_one();
}

fn classify_pending_admission(
    tombstones: &KnownSourceTombstones,
    client: ClientKey,
    packet: &[u8],
) -> Option<PendingAdmissionKind> {
    let valid_initial = is_quic_initial(packet);
    if tombstones.contains(&client)
        && (valid_initial || is_structurally_plausible_quic_short_header(packet))
    {
        return Some(PendingAdmissionKind::KnownSource);
    }
    valid_initial.then_some(PendingAdmissionKind::NewInitial)
}

fn prepare_client_admission(
    clients: &mut HashMap<ClientKey, ClientRelay>,
    tombstones: &mut KnownSourceTombstones,
    client: ClientKey,
    packet: &[u8],
) -> ClientAdmission {
    let Some(kind) = classify_pending_admission(tombstones, client, packet) else {
        return ClientAdmission::Orphan;
    };
    prepare_authorized_client_admission(clients, tombstones, client, kind)
}

fn prepare_authorized_client_admission(
    clients: &mut HashMap<ClientKey, ClientRelay>,
    tombstones: &mut KnownSourceTombstones,
    client: ClientKey,
    kind: PendingAdmissionKind,
) -> ClientAdmission {
    if clients.len() < MAX_PROXY_CLIENTS {
        tombstones.remove(&client);
        return ClientAdmission::Admit {
            reclaimed: None,
            reactivated: kind == PendingAdmissionKind::KnownSource,
        };
    }
    match reclaim_oldest_quiescent_client(clients) {
        Some(address) => {
            // Consume the source being resumed before recording the victim. At
            // the tombstone bound this keeps a rebind swap lossless: the known
            // live source cannot be selected as the LRU entry being forgotten.
            tombstones.remove(&client);
            remember_tombstone(tombstones, address);
            ClientAdmission::Admit {
                reclaimed: Some(address),
                reactivated: kind == PendingAdmissionKind::KnownSource,
            }
        }
        None => {
            if kind == PendingAdmissionKind::KnownSource {
                tombstones.touch(&client);
            }
            ClientAdmission::CapacityBusy { kind }
        }
    }
}

/// Short-header packets encrypt all connection metadata except the invariant
/// header-form bit. The QUIC fixed bit may be greased after negotiation, so it
/// is not a valid discriminator here. A source tombstone supplies the missing
/// trust boundary: only an address that previously sent a fully validated
/// Initial may use this relaxed shape check to create a fresh proxy socket.
fn is_structurally_plausible_quic_short_header(packet: &[u8]) -> bool {
    // Header protection samples 16 bytes starting four bytes after the packet
    // number offset. Even with a zero-length destination CID, a protected short
    // packet therefore needs at least 1 + 4 + 16 bytes. Real packets usually
    // carry a destination CID too; the proxy cannot assume its negotiated size.
    packet.len() >= 21 && packet[0] & 0x80 == 0
}

/// An unseen source is admitted only by a QUIC v1/v2 Initial datagram. Initial
/// datagrams are at least 1200 bytes; requiring the invariant header and the
/// version-specific packet type prevents late short-header close/ACK packets
/// from resurrecting dead Chromium relays and churning the bounded table.
fn is_quic_initial(packet: &[u8]) -> bool {
    if packet.len() < 1200 {
        return false;
    }
    let first = packet[0];
    if first & 0xc0 != 0xc0 {
        return false;
    }
    let version = u32::from_be_bytes([packet[1], packet[2], packet[3], packet[4]]);
    let packet_type = first & 0x30;
    let initial_type = match version {
        QUIC_V1 => packet_type == 0x00,
        QUIC_V2 => packet_type == 0x10,
        _ => false,
    };
    if !initial_type {
        return false;
    }

    let mut offset = 5;
    let destination_id_len = usize::from(packet[offset]);
    offset += 1;
    if destination_id_len > 20 || offset + destination_id_len >= packet.len() {
        return false;
    }
    offset += destination_id_len;

    let source_id_len = usize::from(packet[offset]);
    offset += 1;
    if source_id_len > 20 || offset + source_id_len > packet.len() {
        return false;
    }
    offset += source_id_len;

    let Some((token_len, next_offset)) = decode_quic_varint(packet, offset) else {
        return false;
    };
    let Ok(token_len) = usize::try_from(token_len) else {
        return false;
    };
    let Some(payload_len_offset) = next_offset.checked_add(token_len) else {
        return false;
    };
    if payload_len_offset >= packet.len() {
        return false;
    }

    let Some((payload_len, payload_offset)) = decode_quic_varint(packet, payload_len_offset) else {
        return false;
    };
    let Ok(payload_len) = usize::try_from(payload_len) else {
        return false;
    };
    let packet_number_len = usize::from(first & 0x03) + 1;
    if payload_len < packet_number_len + 16 {
        return false;
    }
    payload_offset
        .checked_add(payload_len)
        .is_some_and(|packet_end| packet_end <= packet.len())
}

fn decode_quic_varint(packet: &[u8], offset: usize) -> Option<(u64, usize)> {
    let first = *packet.get(offset)?;
    let encoded_len = 1usize << (first >> 6);
    let end = offset.checked_add(encoded_len)?;
    let encoded = packet.get(offset..end)?;
    let mut value = u64::from(first & 0x3f);
    for byte in &encoded[1..] {
        value = (value << 8) | u64::from(*byte);
    }
    Some((value, end))
}

fn reclaim_oldest_quiescent_client(
    clients: &mut HashMap<ClientKey, ClientRelay>,
) -> Option<ClientKey> {
    let mut candidates: Vec<(ClientKey, u64, u64)> = clients
        .iter()
        .map(|(address, relay)| {
            let snapshot = relay.state.snapshot();
            (*address, snapshot, RelayState::last_activity(snapshot))
        })
        .collect();
    candidates.sort_unstable_by_key(|(_, _, activity)| *activity);

    for (address, snapshot, _) in candidates {
        let Some(relay) = clients.get(&address) else {
            continue;
        };
        if !relay.state.try_claim_reclaim(snapshot) {
            continue;
        }
        clients.remove(&address);
        return Some(address);
    }
    None
}

async fn send_delayed_connected(
    sockets: watch::Receiver<Arc<UdpSocket>>,
    packets: mpsc::UnboundedReceiver<DelayedPacket>,
    impairment: Arc<NetworkImpairment>,
) {
    let allow_reordering =
        release_may_reorder(ImpairmentDirection::Upstream, impairment.config.reorder);
    drain_reordered(
        packets,
        Some((impairment, ImpairmentDirection::Upstream)),
        allow_reordering,
        |packet| {
            // Read at release, so a packet already in the delay line when the
            // source moves leaves from the new address, as it would from a
            // host that changed networks.
            let socket = sockets.borrow().clone();
            async move {
                let _ = socket.send(&packet.data).await;
            }
        },
    )
    .await;
}

/// Releases a relay's downstream packets at their leg's deadlines: to the
/// client, or into its role's downlink, which sends it on (or loses it) at its
/// departure.
async fn send_delayed_to_client(
    socket: Arc<UdpSocket>,
    client: SocketAddr,
    packets: mpsc::UnboundedReceiver<DelayedPacket>,
    impairment: Arc<NetworkImpairment>,
    downlink: Option<(Link<LinkPacket>, usize, u64)>,
) {
    let allow_reordering =
        release_may_reorder(ImpairmentDirection::Downstream, impairment.config.reorder);
    drain_reordered(
        packets,
        Some((impairment, ImpairmentDirection::Downstream)),
        allow_reordering,
        |packet| {
            let socket = socket.clone();
            let downlink = downlink.clone();
            async move {
                let Some((link, slot, admission_seq)) = downlink else {
                    let _ = socket.send_to(&packet.data, client).await;
                    return;
                };
                let bytes = packet.data.len() as u64 + LINK_HEADER_BYTES;
                let offered = link.offer(Arrival {
                    at: Instant::now(),
                    slot,
                    admission_seq,
                    bytes,
                    payload: LinkPacket {
                        packet,
                        exit: LinkExit::Client { socket, client },
                    },
                });
                debug_assert!(offered, "a link lives as long as the proxy");
            }
        },
    )
    .await;
}

/// How far ahead of a packet's true deadline the coarse phase in
/// [`drain_reordered`] hands off to a precise busy-wait.
///
/// Tokio's timer wheel has an inherent bucket resolution: measured directly
/// (a throwaway `sleep_until` probe, no proxy code involved) at ~1.15-1.34ms
/// median on the Hetzner box host (Debian/KVM, `kvm-clock`) and ~2.0-2.9ms
/// median-to-p99 on macOS, converging to almost exactly 1.000ms under CPU
/// load on Linux — the wheel's own granularity — with the rest being
/// idle-vCPU wake cost on top. A tool whose entire purpose is a precise,
/// deterministic delay cannot silently add 4-8% to every configured delay,
/// nor can it add a source of jitter that *changes with system load*, which
/// a plain `sleep_until` release did. See PERF.md, 2026-08-30.
const SPIN_MARGIN: Duration = Duration::from_millis(3);

/// Releases queued packets by earliest deadline rather than arrival order.
///
/// A plain `while let Some(packet) = packets.recv().await { sleep_until(...);
/// send(...) }` loop — what this first replaced — cannot express reordering
/// at all: it sleeps to each packet's own deadline strictly in the order
/// packets arrived, and since deadlines are `enqueue time + delay` with
/// enqueue time monotonic, that is mathematically equivalent to perfect order
/// preservation no matter what any one packet's deadline is. Buffering in a
/// min-heap and racing the earliest deadline against new arrivals lets a
/// packet whose deadline was pushed out by the impairment trace be
/// legitimately overtaken by one enqueued after it.
///
/// The wait itself is two-phase for the same reason the heap exists: fidelity
/// to the configured delay. The coarse phase still races `sleep_until`
/// against `packets.recv()` — cancel-safe, so reordering preemption keeps
/// working — but only down to [`SPIN_MARGIN`] of the deadline. Inside that
/// margin the packet is committed (popped) and the wait moves to a hardware
/// spin on a dedicated blocking-pool thread via `spawn_blocking`, isolated
/// from the async scheduler so it can neither starve another client's task
/// nor be starved by one. `Instant::now()` on that thread costs tens of
/// nanoseconds, so the spin closes the remaining ~1-3ms to sub-microsecond
/// precision.
///
/// Before choosing what to release, every iteration takes in whatever the
/// channel already holds. A dense run of commits never reaches the coarse
/// `select!`, and an arrival left in the channel through that run would miss
/// its turn behind packets due after it. A newly arrived, earlier-deadline
/// packet therefore waits at most for the one packet already committed, less
/// than one margin's width — smaller than the jitter this replaced, and
/// negligible next to a full `delay` unit.
///
/// In FIFO mode the channel itself is the delay line: every packet is released
/// at the later of its own deadline and its predecessor's release.
async fn drain_reordered<F, Fut>(
    mut packets: mpsc::UnboundedReceiver<DelayedPacket>,
    release_observer: Option<(Arc<NetworkImpairment>, ImpairmentDirection)>,
    allow_reordering: bool,
    mut send: F,
) where
    F: FnMut(DelayedPacket) -> Fut,
    Fut: std::future::Future<Output = ()>,
{
    if !allow_reordering {
        while let Some(packet) = packets.recv().await {
            wait_until_precise(packet.deadline).await;
            record_packet_release(&packet, release_observer.as_ref());
            send(packet).await;
        }
        return;
    }
    let mut heap: std::collections::BinaryHeap<HeapEntry> = std::collections::BinaryHeap::new();
    let mut channel_closed = false;
    // Decision order on this relay: a mark restarts the sequence but advances
    // the generation, so the pair orders packets across marks exactly.
    let mut highest_released: Option<(u64, u64)> = None;
    loop {
        while !channel_closed {
            match packets.try_recv() {
                Ok(packet) => heap.push(HeapEntry(packet)),
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => channel_closed = true,
            }
        }
        let Some(deadline) = heap.peek().map(|top| top.0.deadline) else {
            if channel_closed {
                return;
            }
            match packets.recv().await {
                Some(packet) => heap.push(HeapEntry(packet)),
                None => channel_closed = true,
            }
            continue;
        };

        if let Some(coarse_deadline) = deadline
            .checked_sub(SPIN_MARGIN)
            .filter(|&coarse| coarse > Instant::now())
        {
            if channel_closed {
                tokio::time::sleep_until(coarse_deadline).await;
            } else {
                // `recv` is cancel-safe: if the sleep branch wins, no message
                // is lost from the channel, and a later iteration observes
                // it. Reordering preemption is only meaningful before a
                // packet is committed to the precise phase below, so racing
                // stops once nothing coarse is left to wait out.
                tokio::select! {
                    biased;
                    _ = tokio::time::sleep_until(coarse_deadline) => {}
                    received = packets.recv() => {
                        match received {
                            Some(packet) => heap.push(HeapEntry(packet)),
                            None => channel_closed = true,
                        }
                        continue;
                    }
                }
            }
            continue;
        }

        // Within SPIN_MARGIN of the true deadline (or already past it): the
        // packet is committed. Close the remainder with a hardware spin
        // rather than a second, equally coarse `sleep_until`.
        let entry = heap.pop().expect("heap peeked as non-empty above");
        wait_until_precise(deadline).await;
        record_packet_release(&entry.0, release_observer.as_ref());
        let position = (entry.0.trace_generation, entry.0.trace_sequence);
        if entry.0.trace_reorder_selected
            && highest_released.is_some_and(|highest| position < highest)
            && let Some((impairment, direction)) = &release_observer
        {
            impairment.record_reorder_inversion(*direction, entry.0.trace_epoch);
        }
        if highest_released.is_none_or(|highest| position > highest) {
            highest_released = Some(position);
        }
        send(entry.0).await;
    }
}

fn record_packet_release(
    packet: &DelayedPacket,
    observer: Option<&(Arc<NetworkImpairment>, ImpairmentDirection)>,
) {
    let Some((impairment, direction)) = observer else {
        return;
    };
    // A packet the loss site selected is counted as dropped, not released,
    // even while it crosses the link in front of that site.
    if packet.lost {
        return;
    }
    let actual_residence_us = u64::try_from(
        Instant::now()
            .saturating_duration_since(packet.enqueued_at)
            .as_micros(),
    )
    .unwrap_or(u64::MAX);
    impairment.record_release_timing(
        *direction,
        packet.trace_epoch,
        packet.target_residence_us,
        actual_residence_us,
    );
}

async fn wait_until_precise(deadline: Instant) {
    if let Some(coarse_deadline) = deadline
        .checked_sub(SPIN_MARGIN)
        .filter(|&coarse| coarse > Instant::now())
    {
        tokio::time::sleep_until(coarse_deadline).await;
    }
    if deadline <= Instant::now() {
        return;
    }
    let _ = tokio::task::spawn_blocking(move || {
        while Instant::now() < deadline {
            std::hint::spin_loop();
        }
    })
    .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decode_proxy_control_response_chunks(
        responses: &[Vec<u8>],
        expected_kind: &str,
        expected_nonce: &str,
        expected_response_id: u32,
    ) -> serde_json::Value {
        let mut chunks = vec![None; responses.len()];
        let mut payload_byte_length = None;
        for response in responses.iter().rev() {
            let envelope: serde_json::Value = serde_json::from_slice(response)
                .expect("control response chunk must be valid JSON");
            assert_eq!(envelope["kind"], expected_kind);
            assert_eq!(envelope["nonce"], expected_nonce);
            assert_eq!(envelope["responseId"], expected_response_id);
            assert_eq!(envelope["chunkCount"], responses.len());
            let chunk_index = usize::try_from(
                envelope["chunkIndex"]
                    .as_u64()
                    .expect("chunk index must be u64"),
            )
            .expect("chunk index must fit usize");
            let encoded = envelope["payloadBase64"]
                .as_str()
                .expect("chunk payload must be a string");
            chunks[chunk_index] = Some(
                BASE64_STANDARD
                    .decode(encoded)
                    .expect("chunk payload must be canonical base64"),
            );
            let length = envelope["payloadByteLength"]
                .as_u64()
                .expect("payload byte length must be u64");
            assert!(payload_byte_length.is_none_or(|prior| prior == length));
            payload_byte_length = Some(length);
        }
        let payload: Vec<u8> = chunks
            .into_iter()
            .flat_map(|chunk| chunk.expect("all chunks must be present"))
            .collect();
        assert_eq!(
            u64::try_from(payload.len()).expect("payload length fits u64"),
            payload_byte_length.expect("response has at least one chunk")
        );
        serde_json::from_slice(&payload).expect("reassembled stats must be valid JSON")
    }

    fn impairment_config(
        datagram_loss_percent: u64,
        reorder: ReorderMode,
        scenario: ImpairmentScenario,
    ) -> ImpairmentConfig {
        ImpairmentConfig {
            profile: "fast".to_string(),
            target_rtt_ms: 50,
            base_delay_us: 12_500,
            jitter_radius_us: 1_250,
            datagram_loss_percent,
            fault_site: ImpairmentFaultSite::EdgeToClient,
            fault_sites_per_logical_direction: 1,
            reorder,
            scenario,
            seed: 0x4d45_5243,
        }
    }

    fn valid_initial(version: u32) -> Vec<u8> {
        let mut packet = vec![0u8; 1200];
        packet[0] = match version {
            QUIC_V1 => 0xc0,
            QUIC_V2 => 0xd0,
            _ => panic!("test helper only supports QUIC v1/v2"),
        };
        packet[1..5].copy_from_slice(&version.to_be_bytes());
        packet[5] = 8;
        packet[6..14].copy_from_slice(&[1; 8]);
        packet[14] = 8;
        packet[15..23].copy_from_slice(&[2; 8]);
        // Zero-length token followed by a two-byte QUIC varint: the remaining
        // 1174 bytes are packet number, encrypted payload, tag, and padding.
        packet[23] = 0;
        packet[24] = 0x44;
        packet[25] = 0x96;
        packet
    }

    /// No link: these tests drive the trace alone.
    fn test_network_impairment(config: ImpairmentConfig) -> NetworkImpairment {
        NetworkImpairment::new(config, Vec::new())
    }

    const TEST_LISTENER: ListenerId = ListenerId {
        role: Role::Browser,
        competitor: false,
    };

    fn test_impairment() -> Arc<NetworkImpairment> {
        Arc::new(test_network_impairment(impairment_config(
            0,
            ReorderMode::None,
            ImpairmentScenario::Steady,
        )))
    }

    fn insert_test_relay(
        clients: &mut HashMap<ClientKey, ClientRelay>,
        clock: &AtomicU64,
        impairment: &Arc<NetworkImpairment>,
        port: u16,
    ) -> Arc<RelayState> {
        let address = (0, SocketAddr::from(([127, 0, 0, 1], port)));
        let state = Arc::new(RelayState::default());
        drop(
            state
                .try_acquire_packet(clock)
                .expect("new test relay must accept an activity lease"),
        );
        let (upstream_tx, _upstream_rx) = mpsc::unbounded_channel();
        // Admission ordering is exercised by `partition_tests`, which drives
        // `Partition` directly; these fixtures only need a distinct value.
        let admission_seq = u64::from(port);
        clients.insert(
            address,
            ClientRelay {
                upstream_tx,
                state: state.clone(),
                tasks: Vec::new(),
                admission_seq,
                slot: impairment.attach_relay(admission_seq, state.clone(), TEST_LISTENER, port),
                impairment: impairment.clone(),
                source: None,
            },
        );
        state
    }

    fn full_test_table(
        clock: &AtomicU64,
        impairment: &Arc<NetworkImpairment>,
    ) -> (HashMap<ClientKey, ClientRelay>, Vec<Arc<RelayState>>) {
        let mut clients = HashMap::new();
        let mut states = Vec::with_capacity(MAX_PROXY_CLIENTS);
        for index in 0..MAX_PROXY_CLIENTS {
            states.push(insert_test_relay(
                &mut clients,
                clock,
                impairment,
                10_000 + index as u16,
            ));
        }
        (clients, states)
    }

    /// One attached relay's view of the trace, for tests that drive decisions.
    struct TestRelay<'a> {
        impairment: &'a NetworkImpairment,
        slot: usize,
        admission_seq: u64,
    }

    impl TestRelay<'_> {
        fn decide(&self, direction: ImpairmentDirection, now: Instant) -> PacketDecision {
            self.impairment
                .decide(self.slot, self.admission_seq, direction, now)
                .expect("an attached test relay always owns its slot")
        }

        /// `(dropped, scheduled delay, reordered)` for `count` downstream packets.
        fn downstream_trace(&self, count: usize, now: Instant) -> Vec<(bool, u128, bool)> {
            (0..count)
                .map(|_| {
                    let decision = self.decide(ImpairmentDirection::Downstream, now);
                    (
                        decision.dropped,
                        decision.deadline.saturating_duration_since(now).as_micros(),
                        decision.reordered,
                    )
                })
                .collect()
        }
    }

    fn test_relay(impairment: &NetworkImpairment, admission_seq: u64) -> TestRelay<'_> {
        TestRelay {
            impairment,
            slot: impairment.attach_relay(
                admission_seq,
                Arc::new(RelayState::default()),
                TEST_LISTENER,
                0,
            ),
            admission_seq,
        }
    }

    fn pending_admission(port: u16, kind: PendingAdmissionKind, packet: &[u8]) -> PendingAdmission {
        PendingAdmission {
            listener: 0,
            client: SocketAddr::from(([127, 0, 0, 1], port)),
            packet: packet.to_vec(),
            kind,
        }
    }

    #[test]
    fn pending_scheduled_packet_total_tracks_every_live_relay_exactly() {
        let clock = AtomicU64::new(0);
        let impairment = test_impairment();
        let mut clients = HashMap::new();
        let first = insert_test_relay(&mut clients, &clock, &impairment, 20_000);
        let second = insert_test_relay(&mut clients, &clock, &impairment, 20_001);
        let pending = || {
            let status = impairment.settle_status();
            let relays: Vec<(u64, u64)> = status.relays.entries[..status.relays.len]
                .iter()
                .map(|relay| (relay.admission_seq, relay.pending))
                .collect();
            (status.pending_scheduled_packets, relays)
        };

        let first_packet = first
            .try_acquire_packet(&clock)
            .expect("first relay accepts its first pending packet");
        let second_packet = second
            .try_acquire_packet(&clock)
            .expect("second relay accepts its first pending packet");
        let second_packet_2 = second
            .try_acquire_packet(&clock)
            .expect("second relay accepts its second pending packet");

        assert_eq!(pending(), (3, vec![(20_000, 1), (20_001, 2)]));
        drop(second_packet_2);
        assert_eq!(pending(), (2, vec![(20_000, 1), (20_001, 1)]));
        drop(first_packet);
        drop(second_packet);
        assert_eq!(pending(), (0, vec![(20_000, 0), (20_001, 0)]));
        clients.clear();
        assert_eq!(pending(), (0, vec![]), "a dropped relay releases its slot");
    }

    #[test]
    fn admission_handoff_is_one_packet_bounded_and_prioritizes_recovery() {
        let mut handoff = AdmissionHandoff::default();
        assert!(matches!(
            handoff.offer(pending_admission(
                20_000,
                PendingAdmissionKind::NewInitial,
                b"first",
            )),
            HandoffOffer::Stored,
        ));
        assert_eq!(handoff.pending().expect("stored packet").packet, b"first");

        let HandoffOffer::Duplicate(duplicate) = handoff.offer(pending_admission(
            20_000,
            PendingAdmissionKind::NewInitial,
            b"duplicate",
        )) else {
            panic!("same-source packet must not replace owned bytes");
        };
        assert_eq!(duplicate.packet, b"duplicate");
        assert_eq!(handoff.pending().expect("first retained").packet, b"first");

        let HandoffOffer::Full(rejected) = handoff.offer(pending_admission(
            20_001,
            PendingAdmissionKind::NewInitial,
            b"second-new",
        )) else {
            panic!("second new source must observe the hard one-packet bound");
        };
        assert_eq!(rejected.packet, b"second-new");

        let HandoffOffer::Replaced { displaced } = handoff.offer(pending_admission(
            20_002,
            PendingAdmissionKind::KnownSource,
            b"recovery",
        )) else {
            panic!("known-source recovery must cancel a pending new admission");
        };
        assert_eq!(displaced.packet, b"first");
        assert_eq!(
            handoff.take().expect("replacement packet").packet,
            b"recovery",
        );
        assert!(!handoff.is_pending());
    }

    #[test]
    fn pending_admission_deduplicates_only_the_same_listener_and_source() {
        let mut handoff = AdmissionHandoff::default();
        let first = pending_admission(20_000, PendingAdmissionKind::NewInitial, b"first");
        let source = first.client;
        assert!(matches!(handoff.offer(first), HandoffOffer::Stored));
        assert!(handoff.source_is_pending(0, source));
        assert!(!handoff.source_is_pending(1, source));
        let mut other = pending_admission(20_000, PendingAdmissionKind::NewInitial, b"other");
        other.listener = 1;
        assert!(matches!(handoff.offer(other), HandoffOffer::Full(_)));
        assert_eq!(handoff.pending().expect("original packet").packet, b"first");
    }

    #[test]
    fn a_source_tombstone_cannot_authorize_another_listener() {
        let source = SocketAddr::from(([127, 0, 0, 1], 20_000));
        let mut tombstones = KnownSourceTombstones::default();
        tombstones.remember((0, source));
        assert_eq!(
            classify_pending_admission(&tombstones, (0, source), &[0x40; 64]),
            Some(PendingAdmissionKind::KnownSource),
        );
        assert_eq!(
            classify_pending_admission(&tombstones, (1, source), &[0x40; 64]),
            None
        );
        assert_eq!(
            classify_pending_admission(&tombstones, (1, source), &valid_initial(QUIC_V1)),
            Some(PendingAdmissionKind::NewInitial),
        );
        assert!(tombstones.contains(&(0, source)));
    }

    #[tokio::test]
    async fn pending_packet_zero_transition_wakes_admission_once() {
        let quiescence = Arc::new(Notify::new());
        let state = Arc::new(RelayState::with_quiescence(quiescence.clone()));
        let clock = AtomicU64::new(0);
        let first = state.try_acquire_packet(&clock).expect("first lease");
        let second = state.try_acquire_packet(&clock).expect("second lease");

        drop(first);
        assert!(
            tokio::time::timeout(Duration::from_millis(1), quiescence.notified())
                .await
                .is_err(),
            "pending 2->1 must not wake admission",
        );
        drop(second);
        tokio::time::timeout(Duration::from_millis(100), quiescence.notified())
            .await
            .expect("pending 1->0 must wake admission");
        assert_eq!(state.pending_packets(), 0);
    }

    #[test]
    fn a_closed_delay_line_hands_back_the_packet_lease() {
        let (tx, rx) = mpsc::unbounded_channel();
        let relay = Arc::new(RelayState::default());
        let clock = AtomicU64::new(0);
        drop(rx);

        assert_eq!(
            enqueue_admitted_delayed_packet(
                &tx,
                UnadmittedDelayedPacket {
                    deadline: Instant::now(),
                    trace_epoch: 0,
                    trace_generation: 0,
                    trace_sequence: 0,
                    trace_reorder_selected: false,
                    lost: false,
                    data: vec![1],
                },
                relay
                    .try_acquire_packet(&clock)
                    .expect("an open relay grants a lease"),
                ImpairmentDirection::Upstream,
            ),
            PacketEnqueueResult::Closed
        );
        assert_eq!(relay.pending_packets(), 0);
        assert_eq!(relay.in_flight[0].load(Ordering::SeqCst), 0);
    }

    #[test]
    fn quic_initial_admission_requires_a_structurally_valid_v1_or_v2_initial() {
        assert!(is_quic_initial(&valid_initial(QUIC_V1)));
        assert!(is_quic_initial(&valid_initial(QUIC_V2)));

        let mut short_header = valid_initial(QUIC_V1);
        short_header[0] = 0x40;
        assert!(!is_quic_initial(&short_header));

        let mut handshake = valid_initial(QUIC_V1);
        handshake[0] = 0xe0;
        assert!(!is_quic_initial(&handshake));

        let mut unknown_version = valid_initial(QUIC_V1);
        unknown_version[1..5].copy_from_slice(&0x1234_5678u32.to_be_bytes());
        assert!(!is_quic_initial(&unknown_version));

        let mut invalid_cid = valid_initial(QUIC_V1);
        invalid_cid[5] = 21;
        assert!(!is_quic_initial(&invalid_cid));

        assert!(!is_quic_initial(&valid_initial(QUIC_V1)[..1199]));
    }

    #[test]
    fn orphan_short_header_at_capacity_does_not_mutate_or_reclaim_the_table() {
        let clock = AtomicU64::new(0);
        let impairment = test_impairment();
        let (mut clients, states) = full_test_table(&clock, &impairment);
        let mut tombstones = KnownSourceTombstones::default();
        let addresses: Vec<ClientKey> = clients.keys().copied().collect();
        let orphan = (0, SocketAddr::from(([127, 0, 0, 1], 20_000)));
        let short_header = vec![0x40; 1200];

        assert_eq!(
            prepare_client_admission(&mut clients, &mut tombstones, orphan, &short_header),
            ClientAdmission::Orphan
        );
        assert_eq!(clients.len(), MAX_PROXY_CLIENTS);
        assert_eq!(tombstones.len(), 0);
        assert!(
            addresses
                .iter()
                .all(|address| clients.contains_key(address))
        );
        assert!(
            states
                .iter()
                .all(|state| state.snapshot() & RELAY_RECLAIMING == 0)
        );
    }

    #[test]
    fn evicted_known_source_short_header_reactivates_via_a_fresh_relay_slot() {
        let clock = AtomicU64::new(0);
        let impairment = test_impairment();
        let (mut clients, _states) = full_test_table(&clock, &impairment);
        // Capacity one exercises the consume-before-replace ordering at the
        // exact tombstone bound.
        let mut tombstones = KnownSourceTombstones::with_capacity(1);
        let evicted = (0, SocketAddr::from(([127, 0, 0, 1], 10_000)));
        let next_oldest = (0, SocketAddr::from(([127, 0, 0, 1], 10_001)));
        let newcomer = (0, SocketAddr::from(([127, 0, 0, 1], 20_000)));

        assert_eq!(
            prepare_client_admission(
                &mut clients,
                &mut tombstones,
                newcomer,
                &valid_initial(QUIC_V1),
            ),
            ClientAdmission::Admit {
                reclaimed: Some(evicted),
                reactivated: false,
            }
        );
        insert_test_relay(&mut clients, &clock, &impairment, newcomer.1.port());
        assert!(tombstones.contains(&evicted));

        // The triggering short-header datagram is admitted, not consumed by
        // tombstone lookup. The caller creates the fresh socket and forwards
        // this same packet, which initiates QUIC NAT rebinding at the edge.
        let short_header = vec![0x40; 64];
        assert_eq!(
            prepare_client_admission(&mut clients, &mut tombstones, evicted, &short_header,),
            ClientAdmission::Admit {
                reclaimed: Some(next_oldest),
                reactivated: true,
            }
        );
        assert!(!tombstones.contains(&evicted));
        assert!(tombstones.contains(&next_oldest));
        assert_eq!(clients.len(), MAX_PROXY_CLIENTS - 1);
    }

    #[test]
    fn known_source_does_not_reactivate_from_a_malformed_short_header() {
        let mut clients = HashMap::new();
        let mut tombstones = KnownSourceTombstones::default();
        let known = (0, SocketAddr::from(([127, 0, 0, 1], 20_000)));
        tombstones.remember(known);

        for length in 0..21 {
            assert_eq!(
                prepare_client_admission(&mut clients, &mut tombstones, known, &vec![0x40; length],),
                ClientAdmission::Orphan,
                "accepted an undersized {length}-byte short header",
            );
            assert!(tombstones.contains(&known));
        }

        let long_header = [0x80; 64];
        assert_eq!(
            prepare_client_admission(&mut clients, &mut tombstones, known, &long_header),
            ClientAdmission::Orphan
        );
        assert!(tombstones.contains(&known));
    }

    #[test]
    fn known_source_short_header_accepts_negotiated_fixed_bit_greasing() {
        for first in [0x00, 0x20, 0x40, 0x60, 0x7f] {
            let mut packet = [0u8; 21];
            packet[0] = first;
            assert!(
                is_structurally_plausible_quic_short_header(&packet),
                "rejected greased short-header first byte {first:#04x}",
            );
        }
        for first in [0x80, 0xc0, 0xff] {
            let mut packet = [0u8; 21];
            packet[0] = first;
            assert!(
                !is_structurally_plausible_quic_short_header(&packet),
                "accepted long-header first byte {first:#04x}",
            );
        }
    }

    #[test]
    fn busy_table_preserves_and_refreshes_a_reactivation_tombstone() {
        let clock = AtomicU64::new(0);
        let impairment = test_impairment();
        let (mut clients, states) = full_test_table(&clock, &impairment);
        let mut tombstones = KnownSourceTombstones::with_capacity(2);
        let known = (0, SocketAddr::from(([127, 0, 0, 1], 20_000)));
        let other = (0, SocketAddr::from(([127, 0, 0, 1], 20_001)));
        tombstones.remember(known);
        tombstones.remember(other);
        let pending: Vec<PendingPacketGuard> = states
            .iter()
            .map(|state| {
                state
                    .try_acquire_packet(&clock)
                    .expect("test relay must accept a pending lease")
            })
            .collect();

        assert_eq!(
            prepare_client_admission(&mut clients, &mut tombstones, known, &[0x40; 64],),
            ClientAdmission::CapacityBusy {
                kind: PendingAdmissionKind::KnownSource,
            }
        );
        // Refreshing `known` makes `other` the deterministic LRU victim.
        let newcomer = (0, SocketAddr::from(([127, 0, 0, 1], 20_002)));
        assert_eq!(tombstones.remember(newcomer), Some(other));
        assert!(tombstones.contains(&known));
        assert!(tombstones.contains(&newcomer));
        assert_eq!(tombstones.len(), 2);

        drop(pending);
    }

    #[test]
    fn known_source_tombstones_are_strictly_bounded_lru() {
        let mut tombstones = KnownSourceTombstones::with_capacity(2);
        let first = (0, SocketAddr::from(([127, 0, 0, 1], 10_000)));
        let second = (0, SocketAddr::from(([127, 0, 0, 1], 10_001)));
        let third = (0, SocketAddr::from(([127, 0, 0, 1], 10_002)));

        assert_eq!(tombstones.remember(first), None);
        assert_eq!(tombstones.remember(second), None);
        assert!(tombstones.touch(&first));
        assert_eq!(tombstones.remember(third), Some(second));
        assert_eq!(tombstones.len(), 2);
        assert!(tombstones.contains(&first));
        assert!(tombstones.contains(&third));
        assert!(!tombstones.contains(&second));
    }

    #[test]
    fn full_client_table_replaces_the_exact_quiescent_lru_without_growing() {
        let clock = AtomicU64::new(0);
        let impairment = test_impairment();
        let (mut clients, _states) = full_test_table(&clock, &impairment);
        let mut tombstones = KnownSourceTombstones::default();
        let oldest = (0, SocketAddr::from(([127, 0, 0, 1], 10_000)));
        let newcomer = (0, SocketAddr::from(([127, 0, 0, 1], 20_000)));

        assert_eq!(
            prepare_client_admission(
                &mut clients,
                &mut tombstones,
                newcomer,
                &valid_initial(QUIC_V1),
            ),
            ClientAdmission::Admit {
                reclaimed: Some(oldest),
                reactivated: false,
            }
        );
        assert_eq!(clients.len(), MAX_PROXY_CLIENTS - 1);
        assert!(tombstones.contains(&oldest));

        insert_test_relay(&mut clients, &clock, &impairment, newcomer.1.port());

        assert!(!clients.contains_key(&oldest));
        assert!(clients.contains_key(&newcomer));
        assert_eq!(clients.len(), MAX_PROXY_CLIENTS);
    }

    #[test]
    fn relay_with_pending_delayed_packet_is_never_reclaimed() {
        let clock = AtomicU64::new(0);
        let impairment = test_impairment();
        let (mut clients, states) = full_test_table(&clock, &impairment);
        let mut tombstones = KnownSourceTombstones::default();
        let oldest = (0, SocketAddr::from(([127, 0, 0, 1], 10_000)));
        let next_oldest = (0, SocketAddr::from(([127, 0, 0, 1], 10_001)));
        let newcomer = (0, SocketAddr::from(([127, 0, 0, 1], 20_000)));
        let pending = states[0]
            .try_acquire_packet(&clock)
            .expect("oldest relay must accept a pending lease");

        assert_eq!(
            prepare_client_admission(
                &mut clients,
                &mut tombstones,
                newcomer,
                &valid_initial(QUIC_V1),
            ),
            ClientAdmission::Admit {
                reclaimed: Some(next_oldest),
                reactivated: false,
            }
        );
        assert!(clients.contains_key(&oldest));
        assert!(!clients.contains_key(&next_oldest));
        assert!(tombstones.contains(&next_oldest));
        assert_eq!(states[0].pending_packets(), 1);

        drop(pending);
        assert_eq!(states[0].pending_packets(), 0);
    }

    #[test]
    fn saturated_table_with_only_busy_relays_rejects_admission_without_eviction() {
        let clock = AtomicU64::new(0);
        let impairment = test_impairment();
        let (mut clients, states) = full_test_table(&clock, &impairment);
        let mut tombstones = KnownSourceTombstones::default();
        let addresses: Vec<ClientKey> = clients.keys().copied().collect();
        let newcomer = (0, SocketAddr::from(([127, 0, 0, 1], 20_000)));
        let pending: Vec<PendingPacketGuard> = states
            .iter()
            .map(|state| {
                state
                    .try_acquire_packet(&clock)
                    .expect("test relay must accept a pending lease")
            })
            .collect();

        assert_eq!(
            prepare_client_admission(
                &mut clients,
                &mut tombstones,
                newcomer,
                &valid_initial(QUIC_V1),
            ),
            ClientAdmission::CapacityBusy {
                kind: PendingAdmissionKind::NewInitial,
            }
        );
        assert_eq!(clients.len(), MAX_PROXY_CLIENTS);
        assert_eq!(tombstones.len(), 0);
        assert!(
            addresses
                .iter()
                .all(|address| clients.contains_key(address))
        );

        drop(pending);
    }

    #[test]
    fn downstream_activity_refreshes_the_relay_lru_order() {
        let clock = AtomicU64::new(0);
        let impairment = test_impairment();
        let (mut clients, states) = full_test_table(&clock, &impairment);
        let mut tombstones = KnownSourceTombstones::default();
        let refreshed = (0, SocketAddr::from(([127, 0, 0, 1], 10_000)));
        let next_oldest = (0, SocketAddr::from(([127, 0, 0, 1], 10_001)));
        let newcomer = (0, SocketAddr::from(([127, 0, 0, 1], 20_000)));

        // The edge-reader path acquires this activity lease before applying
        // delay/loss, so server-only traffic keeps a relay live.
        drop(
            states[0]
                .try_acquire_packet(&clock)
                .expect("downstream receipt must atomically refresh activity"),
        );

        assert_eq!(
            prepare_client_admission(
                &mut clients,
                &mut tombstones,
                newcomer,
                &valid_initial(QUIC_V2),
            ),
            ClientAdmission::Admit {
                reclaimed: Some(next_oldest),
                reactivated: false,
            }
        );
        assert!(clients.contains_key(&refreshed));
        assert!(!clients.contains_key(&next_oldest));
        assert!(tombstones.contains(&next_oldest));
    }

    #[test]
    fn stale_lru_snapshot_cannot_claim_a_relay_after_packet_activity() {
        let clock = AtomicU64::new(0);
        let relay = Arc::new(RelayState::default());
        drop(
            relay
                .try_acquire_packet(&clock)
                .expect("relay must accept initial activity"),
        );
        let stale_snapshot = relay.snapshot();

        drop(
            relay
                .try_acquire_packet(&clock)
                .expect("concurrent packet must atomically refresh activity"),
        );

        assert!(!relay.try_claim_reclaim(stale_snapshot));
        assert!(relay.try_claim_reclaim(relay.snapshot()));
        assert_eq!(
            relay.try_acquire_packet(&clock).err(),
            Some(LeaseRefusal::Closed)
        );
    }

    #[test]
    fn exact_rate_loss_hits_each_requested_matrix_percentage() {
        for percent in [0, 1, 3, 9] {
            for seed in [0, 1, 0x4d45_5243, u64::from(u32::MAX)] {
                let selected = (0..10_000)
                    .filter(|sequence| selected_exact_rate(*sequence, percent, seed))
                    .count();
                assert_eq!(
                    selected,
                    percent as usize * 100,
                    "percent={percent} seed={seed}"
                );
            }
            // The same exactness per relay: uneven interleaving, a relay left
            // mid-window, and the epoch's window totals still agree.
            let impairment = test_network_impairment(impairment_config(
                percent,
                ReorderMode::None,
                ImpairmentScenario::Steady,
            ));
            let busy = test_relay(&impairment, 1);
            let sparse = test_relay(&impairment, 2);
            let now = Instant::now();
            for index in 0..1_000 {
                busy.decide(ImpairmentDirection::Downstream, now);
                busy.decide(ImpairmentDirection::Downstream, now);
                if index % 4 == 0 {
                    sparse.decide(ImpairmentDirection::Downstream, now);
                }
            }
            let stats = impairment.stats();
            assert_eq!(stats.exact_loss_windows_completed, 22, "percent={percent}");
            assert_eq!(
                stats.exact_loss_dropped_in_completed_windows,
                22 * percent,
                "percent={percent}"
            );
            assert!(stats.downstream.exact_loss_dropped >= 22 * percent);
        }
    }

    #[test]
    fn exact_rate_trace_is_seeded_irregular_and_can_drop_adjacent_packets() {
        let first: Vec<u64> = (0..1_000)
            .filter(|sequence| selected_exact_rate(*sequence, 9, 1))
            .collect();
        let repeat: Vec<u64> = (0..1_000)
            .filter(|sequence| selected_exact_rate(*sequence, 9, 1))
            .collect();
        let other_seed: Vec<u64> = (0..1_000)
            .filter(|sequence| selected_exact_rate(*sequence, 9, 2))
            .collect();
        assert_eq!(first, repeat);
        assert_ne!(first, other_seed);
        assert!(
            first.windows(2).any(|pair| pair[1] == pair[0] + 1),
            "the trace must express adjacent losses that every-Nth injection could not"
        );
        // A relay's admission sequence is part of its seed: two connections
        // under one key never share a loss pattern.
        let impairment = test_network_impairment(impairment_config(
            9,
            ReorderMode::None,
            ImpairmentScenario::Steady,
        ));
        let now = Instant::now();
        let one = test_relay(&impairment, 1).downstream_trace(1_000, now);
        let two = test_relay(&impairment, 2).downstream_trace(1_000, now);
        assert_ne!(one, two);
    }

    #[test]
    fn reset_replays_the_exact_downstream_trace_while_upstream_keeps_only_jitter() {
        let impairment = test_network_impairment(impairment_config(
            9,
            ReorderMode::Moderate,
            ImpairmentScenario::Steady,
        ));
        let relay = test_relay(&impairment, 1);
        let now = Instant::now();
        let first = relay.downstream_trace(300, now);
        let upstream: Vec<(bool, u128)> = (0..300)
            .map(|_| {
                let decision = relay.decide(ImpairmentDirection::Upstream, now);
                (
                    decision.dropped,
                    decision.deadline.saturating_duration_since(now).as_micros(),
                )
            })
            .collect();
        // A marked window in between must not change what the reset replays.
        impairment.mark(7);
        assert_ne!(relay.downstream_trace(300, now), first);
        let reset = impairment.reset();
        assert_eq!(reset.epoch, 1);
        let repeat = relay.downstream_trace(300, now);
        assert_eq!(first, repeat);
        assert_ne!(
            first
                .iter()
                .map(|(dropped, delay, _)| (*dropped, *delay))
                .collect::<Vec<_>>(),
            upstream
        );
        assert!(upstream.iter().all(|(dropped, _)| !dropped));
    }

    #[test]
    fn a_relay_trace_does_not_change_with_another_relays_packet_volume() {
        let impairment = test_network_impairment(impairment_config(
            9,
            ReorderMode::Moderate,
            ImpairmentScenario::Steady,
        ));
        let now = Instant::now();
        let measured = test_relay(&impairment, 1);
        let other = test_relay(&impairment, 2);
        let alone = measured.downstream_trace(400, now);
        for other_packets in [1, 3, 17] {
            impairment.reset();
            let mut interleaved = Vec::with_capacity(alone.len());
            for _ in 0..alone.len() {
                for _ in 0..other_packets {
                    other.decide(ImpairmentDirection::Downstream, now);
                    other.decide(ImpairmentDirection::Upstream, now);
                }
                interleaved.extend(measured.downstream_trace(1, now));
            }
            assert_eq!(
                interleaved, alone,
                "other relay packets per packet={other_packets}"
            );
        }
    }

    #[test]
    fn a_mark_restarts_every_relays_ordinals_at_its_next_decision() {
        let impairment = test_network_impairment(impairment_config(
            3,
            ReorderMode::Moderate,
            ImpairmentScenario::Steady,
        ));
        let now = Instant::now();
        let relays = [test_relay(&impairment, 1), test_relay(&impairment, 2)];
        for (index, relay) in relays.iter().enumerate() {
            for _ in 0..=index * 5 {
                relay.decide(ImpairmentDirection::Downstream, now);
                relay.decide(ImpairmentDirection::Upstream, now);
            }
        }
        let marked = impairment.mark(11);
        assert_eq!(
            marked.mark,
            TraceMark {
                generation: 1,
                key: 11
            }
        );
        assert_eq!(marked.relays.len, 2);
        assert!(
            marked.relays.entries[..2]
                .iter()
                .all(|relay| relay.up_seen == 0 && relay.down_seen == 0),
            "a relay that has not decided since the mark reports nothing since it",
        );
        for relay in &relays {
            let downstream = relay.decide(ImpairmentDirection::Downstream, now);
            let upstream = relay.decide(ImpairmentDirection::Upstream, now);
            assert_eq!(
                (downstream.trace_generation, downstream.trace_sequence),
                (1, 0)
            );
            assert_eq!((upstream.trace_generation, upstream.trace_sequence), (1, 0));
        }
        let status = impairment.settle_status();
        assert!(
            status.relays.entries[..2]
                .iter()
                .all(|relay| relay.up_seen == 1 && relay.down_seen == 1)
        );
    }

    #[test]
    fn the_same_key_and_admission_sequence_replay_the_same_decisions() {
        let impairment = test_network_impairment(impairment_config(
            9,
            ReorderMode::Moderate,
            ImpairmentScenario::Steady,
        ));
        let now = Instant::now();
        let relay = test_relay(&impairment, 5);
        impairment.mark(42);
        let first = relay.downstream_trace(300, now);
        impairment.mark(43);
        let other_key = relay.downstream_trace(300, now);
        impairment.mark(42);
        let repeat = relay.downstream_trace(300, now);
        assert_eq!(first, repeat);
        assert_ne!(first, other_key);
        // A new occupant with the same admission sequence replays it too.
        let replacement = test_network_impairment(impairment_config(
            9,
            ReorderMode::Moderate,
            ImpairmentScenario::Steady,
        ));
        let same = test_relay(&replacement, 5);
        replacement.mark(42);
        assert_eq!(same.downstream_trace(300, now), first);
    }

    #[test]
    fn a_retried_mark_request_advances_the_generation_once() {
        let impairment = test_network_impairment(impairment_config(
            0,
            ReorderMode::None,
            ImpairmentScenario::Steady,
        ));
        let relay = test_relay(&impairment, 1);
        let now = Instant::now();
        let mut cache = ControlResponseCache::default();
        let mut response_id = 0;
        let first = cached_mark_response(
            &impairment,
            &mut cache,
            &mut response_id,
            "mark:n-1:9",
            "n-1",
            9,
            now,
        );
        relay.decide(ImpairmentDirection::Downstream, now);
        let retry = cached_mark_response(
            &impairment,
            &mut cache,
            &mut response_id,
            "mark:n-1:9",
            "n-1",
            9,
            now,
        );
        assert_eq!(first, retry, "a retry replays the original reply");
        let status = impairment.settle_status();
        assert_eq!(
            status.mark,
            TraceMark {
                generation: 1,
                key: 9
            }
        );
        assert_eq!(
            status.relays.entries[0].down_seen, 1,
            "the retry did not restart the relay"
        );
        let value = decode_proxy_control_response_chunks(&first, "mark", "n-1", 1);
        assert_eq!(value["mark"]["generation"], 1);
        assert_eq!(value["mark"]["key"], 9);
        assert_eq!(value["relays"][0]["admissionSeq"], 1);
        cached_mark_response(
            &impairment,
            &mut cache,
            &mut response_id,
            "mark:n-2:9",
            "n-2",
            9,
            now,
        );
        assert_eq!(impairment.settle_status().mark.generation, 2);
    }

    #[test]
    fn every_completed_window_drops_exactly_the_configured_percent_per_relay() {
        let impairment = test_network_impairment(impairment_config(
            3,
            ReorderMode::Moderate,
            ImpairmentScenario::Steady,
        ));
        let now = Instant::now();
        let relays = [
            test_relay(&impairment, 1),
            test_relay(&impairment, 2),
            test_relay(&impairment, 3),
        ];
        let mut windows = 0u64;
        for (index, relay) in relays.iter().enumerate() {
            // Marks land mid-window: the abandoned partial window never counts.
            for round in 0..3 {
                let packets = 100 * (index + 1) + 37 * round;
                let trace = relay.downstream_trace(packets, now);
                for window in trace.chunks_exact(100) {
                    assert_eq!(window.iter().filter(|(dropped, _, _)| *dropped).count(), 3);
                    windows += 1;
                }
                impairment.mark(100 + round as u64);
            }
        }
        let stats = impairment.stats();
        assert_eq!(stats.exact_loss_windows_completed, windows);
        assert_eq!(stats.exact_loss_dropped_in_completed_windows, 3 * windows);
    }

    #[test]
    fn a_stale_slot_decides_nothing_and_its_next_occupant_starts_at_ordinal_zero() {
        let impairment = test_network_impairment(impairment_config(
            3,
            ReorderMode::None,
            ImpairmentScenario::Steady,
        ));
        let now = Instant::now();
        let departed = test_relay(&impairment, 1);
        for _ in 0..50 {
            departed.decide(ImpairmentDirection::Downstream, now);
        }
        impairment.detach_relay(departed.slot, departed.admission_seq);
        assert!(
            impairment
                .decide(departed.slot, 1, ImpairmentDirection::Downstream, now)
                .is_none()
        );
        let occupant = test_relay(&impairment, 2);
        assert_eq!(occupant.slot, departed.slot);
        assert!(
            impairment
                .decide(departed.slot, 1, ImpairmentDirection::Upstream, now)
                .is_none(),
            "a task that outlived its relay cannot decide on the slot's new occupant",
        );
        let first = occupant.decide(ImpairmentDirection::Downstream, now);
        assert_eq!(first.trace_sequence, 0);
        // Detaching with a stale admission sequence leaves the occupant alone.
        impairment.detach_relay(departed.slot, 1);
        assert_eq!(
            occupant
                .decide(ImpairmentDirection::Downstream, now)
                .trace_sequence,
            1
        );
    }

    #[test]
    fn a_detached_relays_packets_since_the_mark_stay_in_the_trace_ledger() {
        let impairment = test_network_impairment(impairment_config(
            9,
            ReorderMode::Moderate,
            ImpairmentScenario::Steady,
        ));
        let now = Instant::now();
        let departing = test_relay(&impairment, 1);
        let staying = test_relay(&impairment, 2);
        // Decided before the mark, so neither ledger counts them.
        departing.downstream_trace(40, now);
        impairment.mark(7);
        let departed = departing.downstream_trace(100, now);
        departing.decide(ImpairmentDirection::Upstream, now);
        let stayed = staying.downstream_trace(60, now);
        let dropped = |trace: &[(bool, u128, bool)]| {
            trace.iter().filter(|(dropped, _, _)| *dropped).count() as u64
        };
        let reordered = |trace: &[(bool, u128, bool)]| {
            trace.iter().filter(|(_, _, reordered)| *reordered).count() as u64
        };
        // One complete window since the mark: exactly the requested drops.
        assert_eq!(dropped(&departed), 9);
        impairment.detach_relay(departing.slot, departing.admission_seq);

        let status = impairment.settle_status();
        assert_eq!(
            status.relays.len, 1,
            "the departed relay's own ledger left with it"
        );
        assert_eq!(status.relays.entries[0].down_dropped, dropped(&stayed));
        assert_eq!(status.since_mark.up_seen, 1);
        assert_eq!(status.since_mark.down_seen, 160);
        assert_eq!(status.since_mark.down_dropped, 9 + dropped(&stayed));
        assert_eq!(
            status.since_mark.down_reordered,
            reordered(&departed) + reordered(&stayed)
        );
        let value = decode_proxy_control_response_chunks(
            &proxy_control_response_chunks("settle", "s-1", 1, &status),
            "settle",
            "s-1",
            1,
        );
        assert_eq!(
            value["sinceMark"],
            serde_json::json!({
                "upSeen": 1,
                "downSeen": 160,
                "downDropped": status.since_mark.down_dropped,
                "downReordered": status.since_mark.down_reordered,
            })
        );

        // A mark and a reset each start the trace-wide ledger again.
        assert_eq!(impairment.mark(8).since_mark.down_seen, 0);
        staying.decide(ImpairmentDirection::Downstream, now);
        assert_eq!(impairment.settle_status().since_mark.down_seen, 1);
        impairment.reset();
        assert_eq!(impairment.settle_status().since_mark.down_seen, 0);
    }

    #[test]
    fn trace_reports_exact_loss_and_bounded_centered_jitter() {
        let impairment = test_network_impairment(impairment_config(
            3,
            ReorderMode::None,
            ImpairmentScenario::Steady,
        ));
        let relay = test_relay(&impairment, 1);
        let now = Instant::now();
        for _ in 0..10_000 {
            relay.decide(ImpairmentDirection::Downstream, now);
        }
        let stats = impairment.stats();
        assert_eq!(stats.downstream.seen, 10_000);
        assert_eq!(stats.downstream.dropped, 300);
        assert_eq!(stats.downstream.exact_loss_dropped, 300);
        assert_eq!(stats.downstream.burst_loss_dropped, 0);
        assert_eq!(stats.downstream.achieved_packet_loss_percent, 3.0);
        assert!(stats.downstream.scheduled_delay_us.p50 >= 12_000);
        assert!(stats.downstream.scheduled_delay_us.p50 <= 13_000);
        assert!(stats.downstream.scheduled_delay_us.max <= 13_750);
        assert!(stats.downstream.scheduled_delay_us.count > 9_000);
        assert_eq!(stats.upstream.seen, 0);
    }

    #[test]
    fn control_response_exposes_seed_profile_and_achieved_impairment_schema() {
        let impairment = test_network_impairment(impairment_config(
            3,
            ReorderMode::Moderate,
            ImpairmentScenario::Steady,
        ));
        let relay = test_relay(&impairment, 4);
        let now = Instant::now();
        for _ in 0..100 {
            relay.decide(ImpairmentDirection::Downstream, now);
        }

        let responses =
            proxy_control_response_chunks("stats", "fixture-17", 17, &impairment.stats());
        assert!(responses.len() > 1);
        assert!(
            responses
                .iter()
                .all(|response| response.len() <= MAX_CONTROL_RESPONSE_DATAGRAM_BYTES)
        );
        let value = decode_proxy_control_response_chunks(&responses, "stats", "fixture-17", 17);
        assert_eq!(value["schemaVersion"], 9);
        assert_eq!(value["exactLossWindowsCompleted"], 1);
        assert_eq!(value["exactLossDroppedInCompletedWindows"], 3);
        assert_eq!(
            value["relays"],
            serde_json::json!([{
                "admissionSeq": 4,
                "listener": { "role": "browser", "competitor": false },
                "upstreamPort": 0,
                "pending": 0,
                "upSeen": 0,
                "downSeen": 100,
                "downDropped": 3,
                "downReordered": 5,
                "upMaxInFlight": 0,
                "downMaxInFlight": 0,
                "bottleneckDrops": 0,
            }])
        );
        // No link is declared, so none is reported and no relay crossed one.
        assert_eq!(value["links"], serde_json::json!([]));
        assert_eq!(
            value["relayLinks"],
            serde_json::json!([{
                "admissionSeq": 4,
                "listener": { "role": "browser", "competitor": false },
                "upstreamPort": 0,
                "links": [],
            }])
        );
        assert_eq!(value["pendingScheduledPackets"], 0);
        assert_eq!(value["config"]["profile"], "fast");
        assert_eq!(value["config"]["targetRttMs"], 50);
        assert_eq!(value["config"]["baseDelayUs"], 12_500);
        assert_eq!(value["config"]["seed"], 0x4d45_5243_u64);
        assert_eq!(value["config"]["datagramLossPercent"], 3);
        assert_eq!(value["config"]["faultSite"], "edge-to-client");
        assert_eq!(value["config"]["faultSitesPerLogicalDirection"], 1);
        assert_eq!(value["downstream"]["seen"], 100);
        assert_eq!(value["downstream"]["exactLossDropped"], 3);
        assert_eq!(value["downstream"]["reordered"], 5);
        assert_eq!(value["downstream"]["reorderInversions"], 0);
        assert_eq!(value["downstream"]["achievedPacketLossPercent"], 3.0);
        assert_eq!(
            value["logicalPathImpairment"]["faultSite"],
            "edge-to-client"
        );
        assert_eq!(
            value["logicalPathImpairment"]["faultSitesPerLogicalDirection"],
            1
        );
        assert_eq!(
            value["logicalPathImpairment"]["requestedDatagramLossPercent"],
            3
        );
        assert_eq!(
            value["logicalPathImpairment"]["observedFaultSitePackets"],
            100
        );
        assert_eq!(value["logicalPathImpairment"]["droppedAtFaultSite"], 3);
        assert_eq!(value["downstream"]["scheduledDelayUs"]["count"], 97);
        assert_eq!(value["downstream"]["actualResidenceUs"]["count"], 0);
        assert_eq!(value["downstream"]["releaseOvershootUs"]["count"], 0);
    }

    #[tokio::test]
    async fn full_control_snapshot_round_trips_as_portable_loopback_udp_chunks() {
        let server = UdpSocket::bind("[::1]:0").await.expect("bind server");
        let client = UdpSocket::bind("[::1]:0").await.expect("bind client");
        let responses = proxy_control_response_chunks(
            "stats",
            "udp-fixture",
            23,
            &test_network_impairment(impairment_config(
                0,
                ReorderMode::None,
                ImpairmentScenario::Steady,
            ))
            .stats(),
        );
        assert!(responses.len() > 1);
        send_control_responses(
            &server,
            &responses,
            client.local_addr().expect("client address"),
        )
        .await;

        let mut received = Vec::with_capacity(responses.len());
        let mut buffer = [0u8; MAX_CONTROL_RESPONSE_DATAGRAM_BYTES];
        for _ in 0..responses.len() {
            let (length, source) = client.recv_from(&mut buffer).await.expect("receive chunk");
            assert_eq!(source, server.local_addr().expect("server address"));
            received.push(buffer[..length].to_vec());
        }
        let value = decode_proxy_control_response_chunks(&received, "stats", "udp-fixture", 23);
        assert_eq!(value["schemaVersion"], IMPAIRMENT_STATS_SCHEMA_VERSION);
        assert_eq!(value["config"]["profile"], "fast");
    }

    #[test]
    fn control_response_cache_is_nonce_exact_bounded_and_expires() {
        let now = Instant::now();
        let mut cache = ControlResponseCache::default();
        for index in 0..=CONTROL_RESPONSE_CACHE_CAPACITY {
            cache.insert(
                format!("stats:nonce-{index}"),
                vec![vec![u8::try_from(index).expect("test index fits u8")]],
                now,
            );
        }
        assert!(cache.get("stats:nonce-0", now).is_none());
        assert_eq!(cache.entries.len(), CONTROL_RESPONSE_CACHE_CAPACITY);
        assert_eq!(
            cache.get("stats:nonce-16", now),
            Some([vec![16]].as_slice())
        );
        assert!(
            cache
                .get(
                    "stats:nonce-16",
                    now + CONTROL_RESPONSE_CACHE_TTL + Duration::from_millis(1),
                )
                .is_none()
        );
        assert!(cache.entries.is_empty());
    }

    #[test]
    fn compact_settle_response_never_serializes_delay_histograms() {
        let impairment = test_network_impairment(impairment_config(
            0,
            ReorderMode::None,
            ImpairmentScenario::Steady,
        ));
        let initial =
            proxy_control_response_chunks("settle", "settle-1", 1, &impairment.settle_status());
        {
            let mut state = impairment
                .state
                .lock()
                .expect("network impairment state poisoned");
            state.upstream.scheduled_delay.histogram.fill(u64::MAX);
            state.downstream.release_overshoot.histogram.fill(u64::MAX);
        }
        let after_histogram_growth =
            proxy_control_response_chunks("settle", "settle-1", 1, &impairment.settle_status());
        assert_eq!(initial, after_histogram_growth);
        let body = decode_proxy_control_response_chunks(&initial, "settle", "settle-1", 1);
        let text = body.to_string();
        assert!(text.len() < 1_024);
        assert!(!text.contains("histogram"));
        assert!(!text.contains("scheduledDelayUs"));
    }

    #[test]
    fn a_full_relay_table_status_fits_the_control_chunk_limit() {
        let impairment = test_network_impairment(impairment_config(
            9,
            ReorderMode::Moderate,
            ImpairmentScenario::Steady,
        ));
        let now = Instant::now();
        for admission_seq in (0..MAX_PROXY_CLIENTS as u64).rev() {
            test_relay(&impairment, u64::MAX - admission_seq)
                .decide(ImpairmentDirection::Downstream, now);
        }
        {
            let mut state = impairment
                .state
                .lock()
                .expect("network impairment state poisoned");
            state.epoch = u64::MAX;
            state.mark = TraceMark {
                generation: u64::MAX,
                key: MAX_TRACE_MARK_KEY - 1,
            };
            let widest = RelayLedger {
                up_seen: u64::MAX,
                down_seen: u64::MAX,
                down_dropped: u64::MAX,
                down_reordered: u64::MAX,
            };
            state.since_mark = widest;
            for trace in state.relays.iter_mut().flatten() {
                trace.mark_generation = u64::MAX;
                trace.since_mark = widest;
                // A delay line holds at most the relay's whole packet lease.
                for max in &trace.state.max_in_flight {
                    max.store(RELAY_PENDING_MASK, Ordering::SeqCst);
                }
            }
        }
        let status = impairment.settle_status();
        // The chunker asserts every datagram against the portable ceiling and
        // the chunk count against its limit.
        let nonce = "00000000-0000-0000-0000-000000000000";
        let responses = proxy_control_response_chunks("settle", nonce, u32::MAX, &status);
        let value = decode_proxy_control_response_chunks(&responses, "settle", nonce, u32::MAX);
        let relays = value["relays"]
            .as_array()
            .expect("relays must be an array");
        assert_eq!(relays.len(), MAX_PROXY_CLIENTS);
        assert!(
            relays
                .windows(2)
                .all(|pair| pair[0]["admissionSeq"].as_u64() < pair[1]["admissionSeq"].as_u64()),
            "relays are reported in admission order",
        );
    }

    #[test]
    fn compact_settle_status_tracks_actual_release_and_reset_epoch() {
        let impairment = test_network_impairment(impairment_config(
            0,
            ReorderMode::None,
            ImpairmentScenario::Steady,
        ));
        let relay = test_relay(&impairment, 1);
        let now = Instant::now();
        let decision = relay.decide(ImpairmentDirection::Downstream, now);
        let scheduled = impairment.settle_status();
        assert_eq!(scheduled.epoch, 0);
        assert_eq!(scheduled.downstream.seen, 1);
        assert_eq!(scheduled.downstream.forwarded, 1);
        assert_eq!(scheduled.downstream.dropped, 0);
        assert_eq!(scheduled.downstream.released, 0);
        assert_eq!(scheduled.relays.len, 1);
        assert_eq!(scheduled.relays.entries[0].down_seen, 1);

        impairment.record_release_timing(
            ImpairmentDirection::Downstream,
            decision.trace_epoch,
            12_500,
            12_750,
        );
        assert_eq!(impairment.settle_status().downstream.released, 1);

        impairment.mark(3);
        impairment.reset();
        let reset = impairment.settle_status();
        assert_eq!(reset.epoch, 1);
        assert_eq!(
            reset.mark,
            TraceMark {
                generation: 2,
                key: 0
            }
        );
        assert_eq!(reset.upstream.seen, 0);
        assert_eq!(reset.downstream.seen, 0);
        assert_eq!(reset.downstream.released, 0);
        assert_eq!(reset.relays.len, 1);
        assert_eq!(reset.relays.entries[0].down_seen, 0);
        assert_eq!(
            relay
                .decide(ImpairmentDirection::Downstream, now)
                .trace_sequence,
            0,
            "a reset restarts every relay from ordinal zero",
        );
    }

    #[test]
    fn burst_loss_contains_short_adjacent_runs_and_is_strictly_bounded() {
        let impairment = test_network_impairment(impairment_config(
            0,
            ReorderMode::None,
            ImpairmentScenario::BurstLoss,
        ));
        let relay = test_relay(&impairment, 1);
        let now = Instant::now();
        let decisions: Vec<bool> = (0..800)
            .map(|_| relay.decide(ImpairmentDirection::Downstream, now).dropped)
            .collect();
        let stats = impairment.stats();
        assert_eq!(stats.downstream.dropped, BURST_LOSS_PACKETS * 2);
        assert_eq!(stats.downstream.burst_loss_dropped, BURST_LOSS_PACKETS * 2);
        assert!(
            decisions
                .windows(BURST_LOSS_PACKETS as usize)
                .any(|run| run.iter().all(|drop| *drop))
        );
    }

    #[test]
    fn congestion_serializes_temporarily_without_unbounded_delay() {
        let impairment = test_network_impairment(impairment_config(
            0,
            ReorderMode::None,
            ImpairmentScenario::Congestion,
        ));
        let relay = test_relay(&impairment, 1);
        let now = Instant::now();
        for _ in 0..1_024 {
            relay.decide(ImpairmentDirection::Downstream, now);
        }
        let stats = impairment.stats();
        assert_eq!(stats.downstream.congested, CONGESTION_WINDOW_PACKETS * 4,);
        assert_eq!(
            stats.downstream.congested_forwarded,
            stats.downstream.congested
        );
        assert_eq!(
            stats.downstream.max_forwarded_congestion_queue_delay_us,
            stats.downstream.max_congestion_queue_delay_us
        );
        assert!(stats.downstream.scheduled_delay_us.max <= 46_000);
        assert!(stats.downstream.scheduled_delay_us.p99 > 13_750);
    }

    #[test]
    fn congestion_evidence_counts_only_packets_that_survive_overlapping_loss() {
        let impairment = test_network_impairment(impairment_config(
            9,
            ReorderMode::Moderate,
            ImpairmentScenario::Congestion,
        ));
        let relay = test_relay(&impairment, 1);
        let now = Instant::now();
        for _ in 0..1_024 {
            relay.decide(ImpairmentDirection::Downstream, now);
        }
        let stats = impairment.stats().downstream;
        assert!(stats.congested_forwarded > 0);
        assert!(stats.congested_forwarded < stats.congested);
        assert!(stats.congested_forwarded <= stats.forwarded);
        assert!(stats.max_forwarded_congestion_queue_delay_us >= 2_000);
        assert!(
            stats.max_forwarded_congestion_queue_delay_us <= stats.max_congestion_queue_delay_us
        );
    }

    #[test]
    fn upstream_never_drops_reorders_or_congests_under_any_impairment_scenario() {
        for (scenario, loss, reorder) in [
            (ImpairmentScenario::Steady, 9, ReorderMode::Moderate),
            (ImpairmentScenario::BurstLoss, 9, ReorderMode::Moderate),
            (ImpairmentScenario::Congestion, 9, ReorderMode::Moderate),
            (ImpairmentScenario::HandshakeSplit, 9, ReorderMode::Moderate),
        ] {
            let impairment = test_network_impairment(impairment_config(loss, reorder, scenario));
            let relay = test_relay(&impairment, 1);
            let now = Instant::now();
            for _ in 0..10_000 {
                let decision = relay.decide(ImpairmentDirection::Upstream, now);
                assert!(!decision.dropped, "scenario={scenario:?}");
                assert!(!decision.reordered, "scenario={scenario:?}");
            }
            let stats = impairment.stats().upstream;
            assert_eq!(stats.seen, 10_000, "scenario={scenario:?}");
            assert_eq!(stats.forwarded, 10_000, "scenario={scenario:?}");
            assert_eq!(stats.dropped, 0, "scenario={scenario:?}");
            assert_eq!(stats.exact_loss_dropped, 0, "scenario={scenario:?}");
            assert_eq!(stats.burst_loss_dropped, 0, "scenario={scenario:?}");
            assert_eq!(stats.reordered, 0, "scenario={scenario:?}");
            assert_eq!(stats.congested, 0, "scenario={scenario:?}");
            assert_eq!(stats.congested_forwarded, 0, "scenario={scenario:?}");
            assert_eq!(
                stats.max_forwarded_congestion_queue_delay_us, 0,
                "scenario={scenario:?}"
            );
            assert_eq!(stats.congestion_clamped, 0, "scenario={scenario:?}");
            assert_eq!(
                stats.achieved_packet_loss_percent, 0.0,
                "scenario={scenario:?}"
            );
            assert_eq!(stats.scheduled_delay_us.count, 10_000);
            assert!(stats.scheduled_delay_us.max <= 13_750);
        }
    }

    #[test]
    fn logical_application_direction_crosses_exactly_one_nine_percent_fault_site() {
        let impairment = test_network_impairment(impairment_config(
            9,
            ReorderMode::None,
            ImpairmentScenario::Steady,
        ));
        let relay = test_relay(&impairment, 1);
        let now = Instant::now();
        for _ in 0..10_000 {
            // One logical browser->daemon or daemon->browser path has one
            // ingress/upstream proxy leg and one egress/downstream proxy leg.
            relay.decide(ImpairmentDirection::Upstream, now);
            relay.decide(ImpairmentDirection::Downstream, now);
        }
        let stats = impairment.stats();
        assert_eq!(stats.upstream.exact_loss_dropped, 0);
        assert_eq!(stats.downstream.exact_loss_dropped, 900);
        assert_eq!(
            stats
                .logical_path_impairment
                .fault_sites_per_logical_direction,
            1
        );
        assert_eq!(
            stats.logical_path_impairment.fault_site,
            ImpairmentFaultSite::EdgeToClient
        );
        assert_eq!(
            stats
                .logical_path_impairment
                .requested_datagram_loss_percent,
            9
        );
        assert_eq!(
            stats.logical_path_impairment.achieved_packet_loss_percent,
            9.0
        );
        // This is the erroneous two-site rate the hard cut removes.
        let compounded_two_site_percent = 100.0 * (1.0 - 0.91_f64.powi(2));
        assert!((compounded_two_site_percent - 17.19).abs() < 1e-10);
        assert_ne!(
            stats.logical_path_impairment.achieved_packet_loss_percent,
            compounded_two_site_percent
        );
    }

    /// Builds one QUIC long-header packet. Payload bytes are arbitrary: the
    /// splitter only walks header lengths, it never decrypts.
    fn long_header_packet(packet_type: u8, payload_len: usize) -> Vec<u8> {
        assert!(
            payload_len < 64,
            "test helper keeps Length a one-byte varint"
        );
        let mut packet = vec![0x80 | 0x40 | (packet_type << 4)];
        packet.extend_from_slice(&1u32.to_be_bytes()); // version 1
        packet.push(4); // DCID length
        packet.extend_from_slice(&[0xAA; 4]);
        packet.push(4); // SCID length
        packet.extend_from_slice(&[0xBB; 4]);
        if packet_type == 0 {
            packet.push(0); // Initial token length, varint 0
        }
        packet.push(u8::try_from(payload_len).expect("payload_len < 64"));
        packet.extend(std::iter::repeat_n(0xCD, payload_len));
        packet
    }

    fn one_rtt_packet(len: usize) -> Vec<u8> {
        let mut packet = vec![0x40]; // short header: form bit clear, fixed bit set
        packet.extend(std::iter::repeat_n(0xEF, len - 1));
        packet
    }

    #[test]
    fn one_rtt_split_offset_finds_the_application_suffix_of_a_coalesced_flight() {
        // The exact shape the edge sends: Initial + Handshake + 1-RTT in one
        // datagram, measured on every connection of a real Chromium dial.
        let initial = long_header_packet(0, 20);
        let handshake = long_header_packet(2, 40);
        let application = one_rtt_packet(30);
        let mut datagram = Vec::new();
        datagram.extend_from_slice(&initial);
        datagram.extend_from_slice(&handshake);
        datagram.extend_from_slice(&application);

        let offset = one_rtt_split_offset(&datagram).expect("coalesced mix must split");
        assert_eq!(offset, initial.len() + handshake.len());
        assert_eq!(&datagram[offset..], &application[..]);
        // The prefix must contain the crypto packets, entire.
        assert_eq!(&datagram[..offset], &[initial, handshake].concat()[..]);
    }

    #[test]
    fn one_rtt_split_offset_refuses_datagrams_with_nothing_to_separate() {
        // Pure application data: no crypto ahead of it, so nothing to hold back.
        assert_eq!(one_rtt_split_offset(&one_rtt_packet(40)), None);
        // Pure handshake: no application suffix to release early.
        assert_eq!(one_rtt_split_offset(&long_header_packet(2, 30)), None);
        assert_eq!(
            one_rtt_split_offset(&[long_header_packet(0, 10), long_header_packet(2, 10)].concat()),
            None
        );
        // Retry (type 3) and Version Negotiation (version 0) carry no Length
        // field, so the walk cannot find a following packet and must not guess.
        assert_eq!(one_rtt_split_offset(&long_header_packet(3, 20)), None);
        let mut version_negotiation = vec![0x80];
        version_negotiation.extend_from_slice(&0u32.to_be_bytes());
        version_negotiation.extend_from_slice(&[0; 12]);
        assert_eq!(one_rtt_split_offset(&version_negotiation), None);
        // Empty and truncated input must be refused rather than panic.
        assert_eq!(one_rtt_split_offset(&[]), None);
        assert_eq!(one_rtt_split_offset(&[0x80, 0x00]), None);
        let truncated = &long_header_packet(2, 40)[..12];
        assert_eq!(one_rtt_split_offset(truncated), None);
    }

    #[test]
    fn one_rtt_split_offset_never_panics_on_arbitrary_bytes() {
        // The proxy parses whatever the edge emits, including bytes it has no
        // reason to understand. A panic here would take the harness down and
        // present as an unexplained transport failure.
        let mut value = 0x1234_5678_9abc_def0u64;
        for _ in 0..5_000 {
            value = value
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1);
            let len = usize::try_from(value % 64).expect("small") + 1;
            let bytes: Vec<u8> = (0..len)
                .map(|i| u8::try_from((value >> (i % 8 * 8)) & 0xff).expect("masked"))
                .collect();
            let _ = one_rtt_split_offset(&bytes);
        }
    }

    #[test]
    fn reorder_modes_select_exact_bounded_rates() {
        for (mode, expected) in [
            (ReorderMode::None, 0),
            (ReorderMode::Light, 100),
            (ReorderMode::Moderate, 500),
        ] {
            let impairment =
                test_network_impairment(impairment_config(0, mode, ImpairmentScenario::Steady));
            let relay = test_relay(&impairment, 1);
            let now = Instant::now();
            for _ in 0..10_000 {
                relay.decide(ImpairmentDirection::Downstream, now);
            }
            let stats = impairment.stats();
            assert_eq!(stats.downstream.reordered, expected, "mode={mode:?}");
            assert!(stats.downstream.scheduled_delay_us.max <= 18_750);
        }
    }

    #[test]
    fn release_order_is_fifo_upstream_and_for_downstream_none() {
        for mode in [ReorderMode::None, ReorderMode::Light, ReorderMode::Moderate] {
            assert!(!release_may_reorder(ImpairmentDirection::Upstream, mode));
        }
        assert!(!release_may_reorder(
            ImpairmentDirection::Downstream,
            ReorderMode::None,
        ));
        assert!(release_may_reorder(
            ImpairmentDirection::Downstream,
            ReorderMode::Light,
        ));
        assert!(release_may_reorder(
            ImpairmentDirection::Downstream,
            ReorderMode::Moderate,
        ));
    }

    fn test_delayed_packet(
        deadline: Instant,
        trace_sequence: u64,
        trace_reorder_selected: bool,
        data: &[u8],
        relay: &Arc<RelayState>,
        clock: &AtomicU64,
    ) -> DelayedPacket {
        marked_test_delayed_packet(
            deadline,
            (0, trace_sequence),
            trace_reorder_selected,
            data,
            relay,
            clock,
        )
    }

    /// A packet at `(trace_generation, trace_sequence)` on its relay's trace.
    fn marked_test_delayed_packet(
        deadline: Instant,
        (trace_generation, trace_sequence): (u64, u64),
        trace_reorder_selected: bool,
        data: &[u8],
        relay: &Arc<RelayState>,
        clock: &AtomicU64,
    ) -> DelayedPacket {
        let pending = relay
            .try_acquire_packet(clock)
            .expect("test relay has capacity");
        DelayedPacket::new(
            UnadmittedDelayedPacket {
                deadline,
                trace_epoch: 0,
                trace_generation,
                trace_sequence,
                trace_reorder_selected,
                lost: false,
                data: data.to_vec(),
            },
            pending,
            ImpairmentDirection::Downstream,
        )
    }

    /// The property the whole reorder buffer exists for: a packet whose
    /// deadline was pushed out must be legitimately overtaken by one enqueued
    /// after it with a sooner deadline — proving a plain FIFO drain (what this
    /// replaced) cannot reproduce the client-side handshake-key race that
    /// deadlocked production in v0.30.0.
    #[tokio::test]
    async fn drain_reordered_releases_earliest_deadline_not_arrival_order() {
        let relay = Arc::new(RelayState::default());
        let clock = AtomicU64::new(0);
        let (tx, rx) = mpsc::unbounded_channel();

        let now = Instant::now();
        // Enqueued first, but jittered to a deadline far in the future — the
        // same shape `should_delay_extra` produces for a marked packet.
        let held_back = test_delayed_packet(
            now + Duration::from_millis(40),
            0,
            true,
            b"held-back",
            &relay,
            &clock,
        );
        // Enqueued second, with no jitter: an ordinary packet that must be
        // free to overtake the one ahead of it.
        let overtakes = test_delayed_packet(
            now + Duration::from_millis(5),
            1,
            false,
            b"overtakes",
            &relay,
            &clock,
        );
        tx.send(held_back).expect("delay line is open");
        tx.send(overtakes).expect("delay line is open");
        drop(tx);

        let (result_tx, mut result_rx) = mpsc::channel(4);
        let impairment = Arc::new(test_network_impairment(impairment_config(
            0,
            ReorderMode::Moderate,
            ImpairmentScenario::Steady,
        )));
        drain_reordered(
            rx,
            Some((impairment.clone(), ImpairmentDirection::Downstream)),
            true,
            move |packet: DelayedPacket| {
                let result_tx = result_tx.clone();
                async move {
                    let _ = result_tx.send(packet.data).await;
                }
            },
        )
        .await;

        let first = tokio::time::timeout(Duration::from_millis(500), result_rx.recv())
            .await
            .expect("first send did not happen in time")
            .expect("channel open");
        let second = tokio::time::timeout(Duration::from_millis(500), result_rx.recv())
            .await
            .expect("second send did not happen in time")
            .expect("channel open");

        assert_eq!(
            first, b"overtakes",
            "the sooner deadline must be released first despite arriving second"
        );
        assert_eq!(second, b"held-back");
        assert_eq!(impairment.stats().downstream.reorder_inversions, 1);
    }

    /// Decision order is `(generation, sequence)`: a mark restarts the
    /// sequence, so a packet decided after it is not an inversion merely
    /// because its restarted sequence is smaller, while a packet decided before
    /// it and released after a later one is.
    #[tokio::test]
    async fn reorder_inversions_follow_decision_order_across_a_mark() {
        let relay = Arc::new(RelayState::default());
        let clock = AtomicU64::new(0);
        let (tx, rx) = mpsc::unbounded_channel();
        let now = Instant::now();
        for (deadline_ms, position, data) in [
            (2, (1, 40), b"before-mark".as_slice()),
            (4, (2, 0), b"after-mark".as_slice()),
            (6, (1, 39), b"held-across-mark".as_slice()),
        ] {
            tx.send(marked_test_delayed_packet(
                now + Duration::from_millis(deadline_ms),
                position,
                true,
                data,
                &relay,
                &clock,
            ))
            .expect("delay line is open");
        }
        drop(tx);
        let impairment = Arc::new(test_network_impairment(impairment_config(
            0,
            ReorderMode::Moderate,
            ImpairmentScenario::Steady,
        )));
        drain_reordered(
            rx,
            Some((impairment.clone(), ImpairmentDirection::Downstream)),
            true,
            |_data| async {},
        )
        .await;
        assert_eq!(impairment.stats().downstream.reorder_inversions, 1);
    }

    #[tokio::test]
    async fn no_reorder_mode_preserves_arrival_order_despite_inverted_jitter_deadlines() {
        let relay = Arc::new(RelayState::default());
        let clock = AtomicU64::new(0);
        let (tx, rx) = mpsc::unbounded_channel();
        let now = Instant::now();
        tx.send(test_delayed_packet(
            now + Duration::from_millis(20),
            0,
            false,
            b"first",
            &relay,
            &clock,
        ))
        .expect("delay line is open");
        tx.send(test_delayed_packet(
            now + Duration::from_millis(2),
            1,
            false,
            b"second",
            &relay,
            &clock,
        ))
        .expect("delay line is open");
        drop(tx);

        let (result_tx, mut result_rx) = mpsc::channel(4);
        drain_reordered(rx, None, false, move |packet: DelayedPacket| {
            let result_tx = result_tx.clone();
            async move {
                let _ = result_tx.send(packet.data).await;
            }
        })
        .await;
        assert_eq!(result_rx.recv().await.as_deref(), Some(b"first".as_slice()));
        assert_eq!(
            result_rx.recv().await.as_deref(),
            Some(b"second".as_slice())
        );
    }

    /// A `sleep_until`-only release lands ~1-2ms late on every measured
    /// platform (tokio's timer wheel resolution plus OS/hypervisor wake
    /// cost; see PERF.md, 2026-08-30) — large enough on a shared CI runner
    /// that a tight bound would be flaky, but `SPIN_MARGIN` (3ms) is chosen
    /// specifically to swallow that whole measured range, so a regression
    /// back to a single coarse sleep must overshoot this bound, while the
    /// working spin phase has comfortable headroom under it.
    #[tokio::test]
    async fn drain_reordered_delivers_within_spin_margin_of_deadline() {
        let relay = Arc::new(RelayState::default());
        let clock = AtomicU64::new(0);
        let (tx, rx) = mpsc::unbounded_channel();

        let now = Instant::now();
        let deadlines: Vec<Instant> = (1..=5)
            .map(|n| now + Duration::from_millis(n * 4))
            .collect();
        for (index, deadline) in deadlines.iter().enumerate() {
            let packet = test_delayed_packet(
                *deadline,
                index as u64,
                false,
                index.to_string().as_bytes(),
                &relay,
                &clock,
            );
            tx.send(packet).expect("delay line is open");
        }
        drop(tx);

        let (result_tx, mut result_rx) = mpsc::channel(8);
        let impairment = Arc::new(test_network_impairment(impairment_config(
            0,
            ReorderMode::Moderate,
            ImpairmentScenario::Steady,
        )));
        drain_reordered(
            rx,
            Some((impairment.clone(), ImpairmentDirection::Downstream)),
            true,
            move |packet: DelayedPacket| {
                let result_tx = result_tx.clone();
                async move {
                    let _ = result_tx.send((Instant::now(), packet.data)).await;
                }
            },
        )
        .await;

        let mut overshoots = Vec::with_capacity(deadlines.len());
        for expected_deadline in deadlines {
            let (delivered_at, _data) =
                tokio::time::timeout(Duration::from_millis(500), result_rx.recv())
                    .await
                    .expect("delivery did not happen in time")
                    .expect("channel open");
            // No tolerance on this one: delivering early is a correctness bug in
            // the injector, not a scheduling artifact.
            assert!(
                delivered_at >= expected_deadline,
                "a delay injector must never deliver before its configured deadline"
            );
            overshoots.push(delivered_at.saturating_duration_since(expected_deadline));
        }

        // The MEDIAN, because the claim above is distributional: a regression to
        // a single coarse sleep lands late on every packet, so the median moves
        // with it and this keeps full sensitivity to the thing being asserted.
        // One sample, by contrast, is a noisy estimator of a microsecond-scale
        // property — `bun run verify` runs `test:unit` concurrently with this,
        // and a starved wake pushed exactly one of five to 3.07ms against a 3ms
        // bound, which says nothing about whether the spin phase engaged.
        let mut sorted = overshoots.clone();
        sorted.sort_unstable();
        let median = sorted[sorted.len() / 2];
        assert!(
            median < SPIN_MARGIN,
            "median overshoot {median:?} did not beat SPIN_MARGIN — the precise phase \
             did not engage, or a regression reintroduced a sleep_until-only release \
             (all samples: {overshoots:?})"
        );
        let timing = impairment.stats().downstream;
        assert_eq!(timing.release_target_residence_us.count, 5);
        assert_eq!(timing.actual_residence_us.count, 5);
        assert_eq!(timing.release_overshoot_us.count, 5);
        assert_eq!(timing.release_early_count, 0);
        assert_eq!(timing.max_release_early_us, 0);
        assert!(timing.release_target_residence_us.min > 0);
        assert!(timing.actual_residence_us.min >= timing.release_target_residence_us.min);
        let spin_margin_us = u64::try_from(SPIN_MARGIN.as_micros()).expect("margin fits in u64");
        assert!(timing.release_overshoot_us.p50 < spin_margin_us);
    }

    /// A dense run of commits never reaches the coarse `select!`, so the heap
    /// takes in arrivals before each commit instead. One that arrives mid-run
    /// with a deadline ahead of the rest of the run is released in its turn,
    /// not after the run drains.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn earlier_deadline_arrival_is_released_before_a_committed_run() {
        const RUN: u64 = 300;
        const SPACING: Duration = Duration::from_micros(100);
        let relay = Arc::new(RelayState::default());
        let clock = AtomicU64::new(0);
        let (tx, rx) = mpsc::unbounded_channel();
        let start = Instant::now() + Duration::from_millis(10);
        let run_deadline = |index: u64| start + SPACING * u32::try_from(index).expect("small");
        for index in 0..RUN {
            tx.send(test_delayed_packet(
                run_deadline(index),
                index,
                false,
                &index.to_be_bytes(),
                &relay,
                &clock,
            ))
            .expect("delay line is open");
        }
        let (released_tx, mut released_rx) = mpsc::unbounded_channel();
        let drain = tokio::spawn(drain_reordered(
            rx,
            None,
            true,
            move |packet: DelayedPacket| {
                let released_tx = released_tx.clone();
                async move {
                    let _ = released_tx.send(packet.data);
                }
            },
        ));

        tokio::time::sleep_until(start + Duration::from_millis(5)).await;
        // Later than anything the drain can have committed by now, which is at
        // most one spin margin ahead of the clock, and earlier than the rest.
        let arrival_deadline = Instant::now() + SPIN_MARGIN + Duration::from_millis(5);
        assert!(
            arrival_deadline + Duration::from_millis(5) < run_deadline(RUN - 1),
            "the arrival came too late in the run to test anything",
        );
        tx.send(test_delayed_packet(
            arrival_deadline,
            RUN,
            false,
            b"arrival",
            &relay,
            &clock,
        ))
        .expect("delay line is open");
        drop(tx);
        drain.await.expect("drain task completes");

        let mut released = Vec::new();
        while let Ok(data) = released_rx.try_recv() {
            released.push(data);
        }
        assert_eq!(released.len(), usize::try_from(RUN + 1).expect("small"));
        let position = released
            .iter()
            .position(|data| data == b"arrival")
            .expect("the arrival was released");
        for (order, data) in released.iter().enumerate() {
            if order == position {
                continue;
            }
            let index = u64::from_be_bytes(data[..8].try_into().expect("run index"));
            if order < position {
                assert!(
                    run_deadline(index) <= arrival_deadline,
                    "run packet {index} due after the arrival was released before it",
                );
            } else {
                assert!(
                    run_deadline(index) >= arrival_deadline,
                    "run packet {index} due before the arrival was released after it",
                );
            }
        }
    }

    fn typical_impairment(reorder: ReorderMode) -> Arc<NetworkImpairment> {
        Arc::new(test_network_impairment(ImpairmentConfig {
            profile: "typical".to_string(),
            target_rtt_ms: 120,
            base_delay_us: 30_000,
            jitter_radius_us: 3_750,
            datagram_loss_percent: 0,
            fault_site: ImpairmentFaultSite::EdgeToClient,
            fault_sites_per_logical_direction: 1,
            reorder,
            scenario: ImpairmentScenario::Steady,
            seed: 0x4d45_5243,
        }))
    }

    /// The runtime `main` builds with one browser listener relaying to `edge`,
    /// with no client yet.
    async fn test_runtime(edge: SocketAddr, impairment: Arc<NetworkImpairment>) -> ProxyRuntime {
        ProxyRuntime {
            listeners: vec![Listener {
                id: TEST_LISTENER,
                socket: Arc::new(UdpSocket::bind("[::1]:0").await.expect("bind proxy listen")),
                upstream: edge,
            }],
            clients: HashMap::new(),
            tombstones: KnownSourceTombstones::default(),
            activity_clock: Arc::new(AtomicU64::new(0)),
            network_impairment: impairment,
            split_one_rtt: false,
            partition: Arc::new(Partition::default()),
            quiescence: Arc::new(Notify::new()),
            admission_seq: 0,
            browser_source: UpstreamSource::Configured,
        }
    }

    /// Receives until `count` datagrams arrived or none came for a second.
    async fn receive_datagrams(socket: &UdpSocket, count: usize) -> Vec<Vec<u8>> {
        let mut received = Vec::with_capacity(count);
        let mut buffer = vec![0u8; 2_048];
        while received.len() < count {
            let Ok(Ok((length, _))) =
                tokio::time::timeout(Duration::from_secs(1), socket.recv_from(&mut buffer)).await
            else {
                break;
            };
            received.push(buffer[..length].to_vec());
        }
        received
    }

    /// A source switch is a network change the edge can see: the relay's next
    /// packet leaves from the new address, what the edge still sends to the old
    /// one arrives, and repeating the current source moves only the port.
    #[tokio::test]
    async fn a_source_switch_moves_the_browser_relay_and_keeps_reading_the_old_socket() {
        // Dual-stack, as the harness edge binds: `ipv4-loopback` reaches it.
        let edge = UdpSocket::bind("[::]:0").await.expect("bind edge");
        let edge_port = edge.local_addr().expect("edge address").port();
        let browser = UdpSocket::bind("[::1]:0").await.expect("bind browser");
        let mut runtime = test_runtime(
            SocketAddr::from((Ipv6Addr::LOCALHOST, edge_port)),
            test_impairment(),
        )
        .await;
        let client = browser.local_addr().expect("browser address");
        let mut buffer = vec![0u8; 2_048];
        let mut forward = async |runtime: &mut ProxyRuntime, packet: &[u8]| -> SocketAddr {
            runtime.forward_client_packet(0, client, packet, None).await;
            let (_, from) =
                tokio::time::timeout(Duration::from_secs(1), edge.recv_from(&mut buffer))
                    .await
                    .expect("the packet crossed")
                    .expect("edge receive");
            from
        };

        let first = forward(&mut runtime, &valid_initial(QUIC_V1)).await;
        assert_eq!(
            first.ip().to_canonical(),
            std::net::IpAddr::V6(Ipv6Addr::LOCALHOST)
        );

        assert_eq!(
            runtime
                .switch_browser_source(UpstreamSource::Ipv4Loopback)
                .await,
            1
        );
        let second = forward(&mut runtime, &[0x40, 1, 2, 3]).await;
        assert_eq!(
            second.ip().to_canonical(),
            std::net::IpAddr::V4(Ipv4Addr::LOCALHOST)
        );

        // Both sockets are read: the edge's late reply to the old address and
        // its reply to the new one both reach the browser.
        edge.send_to(b"old", first).await.expect("edge send old");
        edge.send_to(b"new", second).await.expect("edge send new");
        let mut replies = receive_datagrams(&browser, 2).await;
        replies.sort();
        assert_eq!(replies, vec![b"new".to_vec(), b"old".to_vec()]);

        assert_eq!(
            runtime
                .switch_browser_source(UpstreamSource::Ipv4Loopback)
                .await,
            1
        );
        let third = forward(&mut runtime, &[0x40, 4, 5, 6]).await;
        assert_eq!(third.ip(), second.ip());
        assert_ne!(third.port(), second.port());
    }

    /// The upstream leg is a FIFO delay line with no capacity of its own. A
    /// burst far above the channel's old 256 packets crosses whole and in
    /// order, and the relay reports holding all of it at once. The runtime is
    /// single-threaded and nothing yields while the burst is enqueued, so no
    /// packet leaves before the last one enters.
    #[tokio::test]
    async fn upstream_leg_carries_a_2048_packet_burst_in_order() {
        const PACKETS: u32 = 2_048;
        let edge = UdpSocket::bind("[::1]:0").await.expect("bind edge");
        let impairment = typical_impairment(ReorderMode::Moderate);
        let mut runtime =
            test_runtime(edge.local_addr().expect("edge address"), impairment.clone()).await;
        let client = SocketAddr::from((std::net::Ipv6Addr::LOCALHOST, 40_000));
        let exhausted_before = RELAY_LEASE_EXHAUSTIONS.load(Ordering::Relaxed);
        // The Initial that admits the source carries index 0 in its padding.
        let mut initial = valid_initial(QUIC_V1);
        initial[1_196..].copy_from_slice(&0u32.to_be_bytes());
        assert!(matches!(
            runtime.forward_client_packet(0, client, &initial, None).await,
            ForwardResult::Handled
        ));
        for index in 1..PACKETS {
            runtime
                .forward_client_packet(0, client, &index.to_be_bytes(), None)
                .await;
        }
        let relay = impairment.settle_status().relays.entries[0];
        assert_eq!(relay.up_max_in_flight, u64::from(PACKETS));
        assert_eq!(relay.pending, u64::from(PACKETS));

        let received = receive_datagrams(&edge, PACKETS as usize).await;
        let indices: Vec<u32> = received
            .iter()
            .map(|data| u32::from_be_bytes(data[data.len() - 4..].try_into().expect("index")))
            .collect();
        assert_eq!(indices, (0..PACKETS).collect::<Vec<_>>());
        let stats = impairment.stats();
        assert_eq!(stats.upstream.seen, u64::from(PACKETS));
        assert_eq!(stats.upstream.forwarded, u64::from(PACKETS));
        assert_eq!(stats.upstream.actual_residence_us.count, u64::from(PACKETS));
        assert_eq!(stats.upstream.release_early_count, 0);
        assert_eq!(
            RELAY_LEASE_EXHAUSTIONS.load(Ordering::Relaxed),
            exhausted_before
        );
    }

    /// The downstream reorder heap keeps taking arrivals while it releases a
    /// dense run. A stream of 32 packets a millisecond keeps the earliest
    /// deadline inside the spin margin from about 26 ms on; while the heap
    /// took arrivals only between runs, the 256-packet channel filled behind
    /// that run and dropped.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn downstream_heap_accepts_arrivals_during_a_dense_release_run() {
        const TICKS: u32 = 60;
        const PER_TICK: u32 = 32;
        const PACKETS: u32 = TICKS * PER_TICK;
        let edge = UdpSocket::bind("[::1]:0").await.expect("bind edge");
        let browser = UdpSocket::bind("[::1]:0").await.expect("bind browser");
        let impairment = typical_impairment(ReorderMode::Moderate);
        let mut runtime =
            test_runtime(edge.local_addr().expect("edge address"), impairment.clone()).await;
        let client = browser.local_addr().expect("browser address");
        runtime
            .forward_client_packet(0, client, &valid_initial(QUIC_V1), None)
            .await;
        // The edge learns the relay's own socket from the Initial it carried.
        let mut buffer = vec![0u8; 2_048];
        let (_, relay_socket) =
            tokio::time::timeout(Duration::from_secs(1), edge.recv_from(&mut buffer))
                .await
                .expect("the Initial crossed")
                .expect("edge receive");
        let receiver =
            tokio::spawn(async move { receive_datagrams(&browser, PACKETS as usize).await });

        let mut ticker = tokio::time::interval(Duration::from_millis(1));
        for tick in 0..TICKS {
            ticker.tick().await;
            for offset in 0..PER_TICK {
                let index = tick * PER_TICK + offset;
                edge.send_to(&index.to_be_bytes(), relay_socket)
                    .await
                    .expect("edge send");
            }
        }
        let received = receiver.await.expect("receiver completes");
        let mut indices: Vec<u32> = received
            .iter()
            .map(|data| u32::from_be_bytes(data[..4].try_into().expect("index")))
            .collect();
        indices.sort_unstable();
        assert_eq!(indices, (0..PACKETS).collect::<Vec<_>>());
        let stats = impairment.stats();
        assert_eq!(stats.downstream.seen, u64::from(PACKETS));
        assert_eq!(stats.downstream.forwarded, u64::from(PACKETS));
        assert_eq!(
            stats.downstream.actual_residence_us.count,
            u64::from(PACKETS)
        );
        assert!(stats.relays.entries[0].down_max_in_flight > 256);
    }

    /// The relay lease is the delay line's only bound. Exhausting it loses one
    /// packet, counted where the harness fails the run, and keeps the relay
    /// and everything it already holds.
    #[tokio::test]
    async fn lease_exhaustion_is_counted_and_keeps_the_relay() {
        let edge = UdpSocket::bind("[::1]:0").await.expect("bind edge");
        let impairment = test_impairment();
        let mut runtime =
            test_runtime(edge.local_addr().expect("edge address"), impairment.clone()).await;
        let client = SocketAddr::from((std::net::Ipv6Addr::LOCALHOST, 40_001));
        runtime
            .forward_client_packet(0, client, &valid_initial(QUIC_V1), None)
            .await;
        let relay = runtime
            .clients
            .get(&(0, client))
            .expect("the Initial admitted the source")
            .state
            .clone();
        let clock = AtomicU64::new(0);
        let held: Vec<PendingPacketGuard> = (relay.pending_packets()..RELAY_PENDING_MASK as usize)
            .map(|_| relay.try_acquire_packet(&clock).expect("a lease is free"))
            .collect();
        assert_eq!(relay.pending_packets(), RELAY_PENDING_MASK as usize);
        let exhausted_before = RELAY_LEASE_EXHAUSTIONS.load(Ordering::Relaxed);

        runtime
            .forward_client_packet(0, client, b"refused", None)
            .await;
        assert_eq!(
            RELAY_LEASE_EXHAUSTIONS.load(Ordering::Relaxed),
            exhausted_before + 1
        );
        assert_eq!(
            impairment.stats().harness_drops.lease_exhausted,
            exhausted_before + 1
        );
        assert!(
            runtime.clients.contains_key(&(0, client)),
            "the relay stays"
        );
        assert_eq!(
            impairment.stats().upstream.seen,
            1,
            "a refused packet takes no trace decision",
        );

        drop(held);
        runtime.forward_client_packet(0, client, b"after", None).await;
        let received = receive_datagrams(&edge, 2).await;
        assert_eq!(received.len(), 2);
        assert_eq!(received[0].len(), 1_200, "the Initial the relay held");
        assert_eq!(received[1], b"after");
    }

    /// Each delay line's maximum counts the packets it held at once, outlives
    /// them, and a mark or reset starts it again at what the line holds.
    #[test]
    fn delay_line_maxima_count_each_direction_and_restart_at_a_mark() {
        let impairment = test_impairment();
        let relay = Arc::new(RelayState::default());
        impairment.attach_relay(1, relay.clone(), TEST_LISTENER, 0);
        let clock = AtomicU64::new(0);
        let enter = |direction| {
            DelayedPacket::new(
                UnadmittedDelayedPacket {
                    deadline: Instant::now(),
                    trace_epoch: 0,
                    trace_generation: 0,
                    trace_sequence: 0,
                    trace_reorder_selected: false,
                    lost: false,
                    data: vec![0],
                },
                relay.try_acquire_packet(&clock).expect("a lease is free"),
                direction,
            )
        };
        let maxima = |status: &ProxySettleStatus| {
            let relay = status.relays.entries[0];
            (relay.up_max_in_flight, relay.down_max_in_flight)
        };
        let upstream: Vec<DelayedPacket> = (0..3)
            .map(|_| enter(ImpairmentDirection::Upstream))
            .collect();
        let mut downstream: Vec<DelayedPacket> = (0..5)
            .map(|_| enter(ImpairmentDirection::Downstream))
            .collect();
        assert_eq!(maxima(&impairment.settle_status()), (3, 5));
        drop(upstream);
        downstream.truncate(2);
        assert_eq!(
            maxima(&impairment.settle_status()),
            (3, 5),
            "a maximum outlives the packets that set it",
        );
        assert_eq!(maxima(&impairment.mark(9)), (0, 2));
        downstream.push(enter(ImpairmentDirection::Downstream));
        assert_eq!(maxima(&impairment.settle_status()), (0, 3));
        downstream.clear();
        let reset = impairment.reset().relays.entries[0];
        assert_eq!((reset.up_max_in_flight, reset.down_max_in_flight), (0, 0));
        assert_eq!(relay.pending_packets(), 0);
    }

    #[test]
    fn impairment_reset_is_one_boundary_amid_packet_decisions() {
        const WORKERS: usize = 4;
        const ROUNDS: usize = 2_000;

        let impairment = Arc::new(test_network_impairment(impairment_config(
            0,
            ReorderMode::None,
            ImpairmentScenario::Steady,
        )));
        let start_round = Arc::new(std::sync::Barrier::new(WORKERS + 1));
        let finish_round = Arc::new(std::sync::Barrier::new(WORKERS + 1));

        std::thread::scope(|scope| {
            for worker in 0..WORKERS as u64 {
                let impairment = impairment.clone();
                let start_round = start_round.clone();
                let finish_round = finish_round.clone();
                // One relay per worker, as every relay has its own tasks.
                let slot = impairment.attach_relay(
                    worker + 1,
                    Arc::new(RelayState::default()),
                    TEST_LISTENER,
                    0,
                );
                scope.spawn(move || {
                    for _ in 0..ROUNDS {
                        start_round.wait();
                        impairment
                            .decide(
                                slot,
                                worker + 1,
                                ImpairmentDirection::Downstream,
                                Instant::now(),
                            )
                            .expect("the worker's relay stays attached");
                        finish_round.wait();
                    }
                });
            }

            for expected_epoch in 1..=ROUNDS as u64 {
                start_round.wait();
                let reset_stats = impairment.reset();
                assert_eq!(reset_stats.epoch, expected_epoch);
                finish_round.wait();

                let stats = impairment.stats();
                assert_eq!(stats.epoch, expected_epoch);
                assert_eq!(
                    stats.downstream.seen, stats.downstream.forwarded,
                    "reset split a packet decision at epoch {expected_epoch}",
                );
                assert!(
                    stats.downstream.seen <= WORKERS as u64,
                    "only decisions linearized after reset remain in its epoch",
                );
            }
        });
    }

    /// A jitter-free trace with `links` running: link arithmetic alone
    /// decides when a packet leaves.
    fn linked_impairment(loss_percent: u64, links: &[LinkConfig]) -> Arc<NetworkImpairment> {
        Arc::new(NetworkImpairment::new(
            ImpairmentConfig {
                profile: "fast".to_string(),
                target_rtt_ms: 50,
                base_delay_us: 12_500,
                jitter_radius_us: 0,
                datagram_loss_percent: loss_percent,
                fault_site: ImpairmentFaultSite::EdgeToClient,
                fault_sites_per_logical_direction: 1,
                reorder: ReorderMode::None,
                scenario: ImpairmentScenario::Steady,
                seed: 0x4d45_5243,
            },
            spawn_links(links),
        ))
    }

    fn relay_link(stats: &NetworkImpairmentStats, admission_seq: u64) -> RelayLinkStatus {
        stats
            .relay_links
            .iter()
            .find(|relay| relay.admission_seq == admission_seq)
            .and_then(|relay| relay.links.first().cloned())
            .expect("the relay crossed its role's link")
    }

    /// Both relays of one role queue in the one uplink: what they send at once
    /// leaves one packet time apart, whoever sent it, and what the buffer
    /// cannot hold is a bottleneck drop, never a harness drop.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn one_uplink_queues_every_relay_of_its_role_and_drops_past_its_buffer() {
        // 1,200-byte payloads occupy 1,248 bytes: 9.984 ms at 1 Mbit/s, and
        // four of them fill the buffer.
        let uplink = LinkConfig::parse(Role::Browser, LinkDirection::Up, "1000000:4992")
            .expect("uplink");
        let impairment = linked_impairment(0, &[uplink]);
        let edge = UdpSocket::bind("[::1]:0").await.expect("bind edge");
        let mut runtime =
            test_runtime(edge.local_addr().expect("edge address"), impairment.clone()).await;
        let first = SocketAddr::from((std::net::Ipv6Addr::LOCALHOST, 40_100));
        let second = SocketAddr::from((std::net::Ipv6Addr::LOCALHOST, 40_101));
        let harness_drops = harness_drop_stats().lease_exhausted;
        for client in [first, second] {
            runtime
                .forward_client_packet(0, client, &valid_initial(QUIC_V1), None)
                .await;
        }
        for client in [first, second] {
            for _ in 0..2 {
                runtime
                    .forward_client_packet(0, client, &[7; 1_200], None)
                    .await;
            }
        }
        let received = receive_datagrams(&edge, 6).await;
        assert_eq!(received.len(), 4, "the buffer held four packets");
        let stats = impairment.stats();
        let totals = stats.links[0].totals;
        assert_eq!(
            (totals.arrivals, totals.departures, totals.bottleneck_drops),
            (6, 4, 2)
        );
        // Admission order: first's Initial, second's Initial, first's two,
        // then second's two find the buffer full. Residence is departure less
        // arrival on the virtual clock: four packet times after the burst,
        // less however long after the first offer the packet was offered.
        let first_link = relay_link(&stats, 1);
        let second_link = relay_link(&stats, 2);
        assert_eq!(
            (first_link.stats.packets, first_link.stats.bottleneck_drops),
            (3, 0)
        );
        assert_eq!(
            (second_link.stats.packets, second_link.stats.bottleneck_drops),
            (1, 2)
        );
        assert!(
            (38_936..=39_936).contains(&first_link.stats.max_residence_us),
            "first's last packet left four packet times after the burst: {}",
            first_link.stats.max_residence_us
        );
        assert!(
            (18_968..=19_968).contains(&second_link.stats.max_residence_us),
            "second's Initial left second: {}",
            second_link.stats.max_residence_us
        );
        let settle = impairment.settle_status();
        let drops: Vec<u64> = settle.relays.entries[..settle.relays.len]
            .iter()
            .map(|relay| relay.bottleneck_drops)
            .collect();
        assert_eq!(drops, vec![0, 2]);
        assert_eq!(harness_drop_stats().lease_exhausted, harness_drops);
    }

    /// Behind a downlink the loss site comes after the link: a selected packet
    /// still takes its packet time, and only then disappears.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_packet_lost_behind_a_downlink_still_occupies_it() {
        let downlink = LinkConfig::parse(Role::Browser, LinkDirection::Down, "10000000:1000000")
            .expect("downlink");
        let impairment = linked_impairment(9, &[downlink]);
        let edge = UdpSocket::bind("[::1]:0").await.expect("bind edge");
        let browser = UdpSocket::bind("[::1]:0").await.expect("bind browser");
        let mut runtime =
            test_runtime(edge.local_addr().expect("edge address"), impairment.clone()).await;
        runtime
            .forward_client_packet(
                0,
                browser.local_addr().expect("browser address"),
                &valid_initial(QUIC_V1),
                None,
            )
            .await;
        let mut buffer = vec![0u8; 2_048];
        let (_, relay) = tokio::time::timeout(Duration::from_secs(1), edge.recv_from(&mut buffer))
            .await
            .expect("the Initial reaches the edge")
            .expect("edge receive");
        for index in 0..100u32 {
            let mut packet = vec![0u8; 200];
            packet[..4].copy_from_slice(&index.to_be_bytes());
            edge.send_to(&packet, relay).await.expect("edge send");
        }
        let delivered = receive_datagrams(&browser, 100).await;
        assert_eq!(delivered.len(), 91, "the loss site took exactly 9 of 100");
        let totals = impairment.stats().links[0].totals;
        assert_eq!(totals.arrivals, 100);
        assert_eq!(totals.departures, 100);
        assert_eq!(totals.lost_after_link, 9);
        assert_eq!(totals.departed_bytes, 100 * (200 + LINK_HEADER_BYTES));
        assert_eq!(totals.bottleneck_drops, 0);
    }

    /// A relay's role is the listener it arrived on: only the daemon's relays
    /// cross the daemon's link. Reusing a source on another destination listener
    /// creates an independent flow, even while the first relay remains live.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_relays_role_is_the_listener_it_arrived_on() {
        let uplink = LinkConfig::parse(Role::Daemon, LinkDirection::Up, "100000000:1000000")
            .expect("uplink");
        let impairment = linked_impairment(0, &[uplink]);
        let edge = UdpSocket::bind("[::1]:0").await.expect("bind edge");
        let edge_address = edge.local_addr().expect("edge address");
        let mut runtime = test_runtime(edge_address, impairment.clone()).await;
        runtime.listeners.insert(
            0,
            Listener {
                id: ListenerId {
                    role: Role::Daemon,
                    competitor: false,
                },
                socket: Arc::new(UdpSocket::bind("[::1]:0").await.expect("bind daemon")),
                upstream: edge_address,
            },
        );
        let daemon = SocketAddr::from((std::net::Ipv6Addr::LOCALHOST, 40_200));
        let browser = SocketAddr::from((std::net::Ipv6Addr::LOCALHOST, 40_201));
        runtime
            .forward_client_packet(0, daemon, &valid_initial(QUIC_V1), None)
            .await;
        runtime
            .forward_client_packet(1, browser, &valid_initial(QUIC_V1), None)
            .await;
        runtime
            .forward_client_packet(1, daemon, &valid_initial(QUIC_V1), None)
            .await;
        assert_eq!(receive_datagrams(&edge, 3).await.len(), 3);
        let stats = impairment.stats();
        assert_eq!(stats.links[0].totals.arrivals, 1);
        let roles: Vec<(u64, Role, usize)> = stats
            .relay_links
            .iter()
            .map(|relay| (relay.admission_seq, relay.listener.role, relay.links.len()))
            .collect();
        assert_eq!(
            roles,
            vec![
                (1, Role::Daemon, 1),
                (2, Role::Browser, 0),
                (3, Role::Browser, 0)
            ]
        );
        let settle = impairment.settle_status();
        let ports: Vec<bool> = settle.relays.entries[..settle.relays.len]
            .iter()
            .map(|relay| relay.upstream_port != 0)
            .collect();
        assert_eq!(
            ports,
            vec![true, true, true],
            "each relay reports its upstream port"
        );
    }
}

#[cfg(test)]
mod partition_tests {
    use super::*;

    /// Any connection, for the whole-path scope.
    const ANY: u64 = 1;

    #[test]
    fn browser_partition_preserves_daemon_and_new_browser_connections() {
        let partition = Partition::default();
        partition.arm(
            Duration::from_secs(60),
            PartitionScope::BrowserEstablished {
                admitted_through: 7,
            },
        );
        assert!(partition.blocks(7, Role::Browser));
        assert!(!partition.blocks(8, Role::Browser));
        assert!(!partition.blocks(1, Role::Daemon));
        assert!(!partition.blocks(8, Role::Daemon));
        assert!(!partition.blocks_admission(Role::Browser));
    }

    /// The stalled-path scope: what exists answers again, and a browser cannot
    /// dial around it.
    #[tokio::test]
    async fn a_browser_dial_partition_admits_no_browser_and_cuts_nothing() {
        let partition = Partition::default();
        partition.arm(Duration::from_millis(40), PartitionScope::BrowserDials);

        assert!(!partition.blocks(ANY, Role::Browser), "the incumbent passes");
        assert!(!partition.blocks(ANY, Role::Daemon));
        assert!(partition.blocks_admission(Role::Browser));
        assert!(
            !partition.blocks_admission(Role::Daemon),
            "a daemon that lost its tunnel dials again"
        );

        tokio::time::sleep(Duration::from_millis(80)).await;
        assert!(
            !partition.blocks_admission(Role::Browser),
            "clears itself at the deadline"
        );
    }

    /// A partition must be symmetric and self-clearing. Expressed as a deadline
    /// rather than a flag precisely so a test arms it once and does not have to
    /// race a second control message to end it — the shape that made timed
    /// impairment reliable in the first place.
    #[tokio::test]
    async fn a_partition_blackholes_until_its_deadline_then_clears() {
        let partition = Partition::default();
        assert!(!partition.blocks(ANY, Role::Browser), "idle by default");

        partition.arm(Duration::from_millis(40), PartitionScope::Everything);
        assert!(partition.blocks(ANY, Role::Browser));

        tokio::time::sleep(Duration::from_millis(80)).await;
        assert!(
            !partition.blocks(ANY, Role::Browser),
            "clears itself at the deadline"
        );
        assert!(!partition.blocks(ANY, Role::Browser), "and stays clear");
    }

    #[tokio::test]
    async fn re_arming_extends_rather_than_stacking() {
        let partition = Partition::default();
        partition.arm(Duration::from_millis(30), PartitionScope::Everything);
        tokio::time::sleep(Duration::from_millis(15)).await;
        // The later deadline replaces the earlier one rather than queueing
        // behind it, so a repeated control message is idempotent-ish rather
        // than cumulative.
        partition.arm(Duration::from_millis(60), PartitionScope::Everything);
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert!(
            partition.blocks(ANY, Role::Browser),
            "the later deadline wins"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!partition.blocks(ANY, Role::Browser));
    }

    /// The scope that makes the recovery decision observable.
    ///
    /// Under `Everything` a replacement dial can never complete, so recovery is
    /// bounded by the outage and the promotion path is unreachable. `Established`
    /// is the interface-change case: the carrier in use is dead for good while a
    /// fresh dial succeeds at once.
    #[tokio::test]
    async fn an_established_partition_cuts_only_what_existed_when_it_was_armed() {
        let partition = Partition::default();
        partition.arm(
            Duration::from_millis(60),
            PartitionScope::Established {
                admitted_through: 7,
            },
        );

        assert!(
            partition.blocks(7, Role::Browser),
            "the carrier in use is cut"
        );
        assert!(partition.blocks(1, Role::Daemon), "so is every older one");
        assert!(
            !partition.blocks(8, Role::Browser),
            "a dial that happens after the break must get through, or nothing can recover"
        );
        assert!(
            !partition.blocks_admission(Role::Browser),
            "the replacement has to be able to create relay state"
        );

        tokio::time::sleep(Duration::from_millis(80)).await;
        assert!(
            !partition.blocks(7, Role::Browser),
            "clears itself at the deadline"
        );
    }

    /// A whole-path partition must refuse admission too. Admitting a new client
    /// would leave relay state for a connection the partition exists to prevent.
    #[tokio::test]
    async fn a_whole_path_partition_refuses_new_connections() {
        let partition = Partition::default();
        assert!(
            !partition.blocks_admission(Role::Browser),
            "idle by default"
        );
        partition.arm(Duration::from_millis(40), PartitionScope::Everything);
        assert!(partition.blocks_admission(Role::Browser));
        assert!(partition.blocks_admission(Role::Daemon));
        tokio::time::sleep(Duration::from_millis(80)).await;
        assert!(
            !partition.blocks_admission(Role::Browser),
            "clears itself at the deadline"
        );
    }
}
