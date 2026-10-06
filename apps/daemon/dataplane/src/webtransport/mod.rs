mod direct_session;
pub(crate) mod discovery_socket;
pub mod egress;
pub mod pairing;
pub mod portmap;
pub mod side_channel;
pub mod stun;
pub(crate) mod traversal;

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use netdev::ipnet::{IpNet, Ipv4Net};
use serde::Serialize;
use tokio::sync::{OwnedSemaphorePermit, RwLock, Semaphore, mpsc, oneshot};
use tokio::task::JoinHandle;
use tracing::{info, warn};
use wtransport::{Endpoint, ServerConfig};

pub use direct_session::DirectSession;
#[cfg(test)]
pub(crate) use direct_session::{captured_lanes, loopback_pair};

use crate::network::PeerEvent;
use crate::network::peer::{
    ChannelPeerConnection, ChannelSenders, DatagramEnqueueResult, PeerMessage, ReliablePayload,
    next_connection_id, select_channel_sender, spawn_channel_recv_task, spawn_send_task,
    try_enqueue_datagram,
};
use crate::network::protocol::{CHANNEL_CTRL, CHANNEL_DISPLAY_COMMIT, CHANNEL_PTY};

const CERT_VALIDITY_DAYS: u32 = 13;
const CERT_ROTATION_BUFFER_SECS: u64 = 86400;
const SESSION_SETUP_TIMEOUT_MS: u64 = 5_000;
const CHANNEL_BIND_TIMEOUT_MS: u64 = 2_000;
/// Once all direct-WebTransport channels are bound, the browser must complete
/// the authenticated temp-id -> real-id upgrade. A fully bound but silent
/// session otherwise owns one admission permit and seven transport tasks until
/// QUIC's much longer idle timeout.
///
/// This is intentionally longer than the browser's normal challenge + proof +
/// ACK budget, but short enough to reclaim a public-session slot promptly.
const POST_BIND_UPGRADE_TIMEOUT_MS: u64 = 10_000;
/// Direct WebTransport is an opportunistic latency upgrade, not an unbounded
/// public-session worker pool. This is deliberately generous for a single
/// interactive daemon while bounding half-open QUIC handshakes and their tasks.
const MAX_CONCURRENT_SESSIONS: usize = 64;
/// Quinn defaults to a 1 MiB outbound datagram FIFO. At terminal-sized packet
/// rates that can preserve hundreds of milliseconds of obsolete display under
/// congestion. Quinn evicts the oldest unsent datagrams to admit newer ones, so
/// a small window gives us latest-state semantics without a timer or hot-path
/// allocation.
pub const DATAGRAM_SEND_BUFFER_BYTES: usize = 64 * 1024;
/// Input, ACK, and relayed display datagrams are drained continuously. This
/// admits several complete FEC bursts while bounding suspended-consumer memory;
/// Quinn discards the oldest receive backlog first.
const DATAGRAM_RECEIVE_BUFFER_BYTES: usize = 64 * 1024;
const REQUIRED_CHANNELS: [u8; 3] = [CHANNEL_CTRL, CHANNEL_PTY, CHANNEL_DISPLAY_COMMIT];
static INBOUND_DATAGRAM_QUEUE_DROPS: AtomicU64 = AtomicU64::new(0);
static OVER_CAPACITY_SESSION_REJECTIONS: AtomicU64 = AtomicU64::new(0);
static DIRECT_WT_INCOMING_EXPECTED: AtomicU64 = AtomicU64::new(0);
static DIRECT_WT_INCOMING_UNEXPECTED: AtomicU64 = AtomicU64::new(0);
static DIRECT_WT_ADMITTED: AtomicU64 = AtomicU64::new(0);

/// How long a browser stays "expected" after an offer naming it was built.
///
/// Comfortably longer than the browser's whole retry ladder, whose individual
/// races are bounded by `RACE_DEADLINE_MS`. Erring long only ever moves an
/// arrival from `unexpected` into `expected`, which is the direction that
/// cannot manufacture a false filtering verdict.
const EXPECTED_BROWSER_TTL: Duration = Duration::from_secs(60);
/// Fixed capacity, sized well past `MAX_CONCURRENT_SESSIONS`-worth of distinct
/// browsers in one TTL window. A ring rather than a map so this cannot grow
/// under a connection flood, and so the accept path never allocates.
const EXPECTED_BROWSER_CAPACITY: usize = 16;

static EXPECTED_BROWSERS: Mutex<ExpectedBrowserRing> = Mutex::new(ExpectedBrowserRing::new());

/// Addresses this daemon recently told a browser to dial it from.
struct ExpectedBrowserRing {
    entries: [Option<(IpAddr, Instant)>; EXPECTED_BROWSER_CAPACITY],
    next: usize,
}

impl ExpectedBrowserRing {
    const fn new() -> Self {
        Self {
            entries: [None; EXPECTED_BROWSER_CAPACITY],
            next: 0,
        }
    }

    /// Refresh in place when the address is already held, so a browser that
    /// takes several manifests cannot evict every other peer's entry.
    fn record(&mut self, ip: IpAddr, now: Instant) {
        if let Some(slot) = self
            .entries
            .iter_mut()
            .find(|slot| slot.is_some_and(|(held, _)| held == ip))
        {
            *slot = Some((ip, now));
            return;
        }
        self.entries[self.next] = Some((ip, now));
        self.next = (self.next + 1) % EXPECTED_BROWSER_CAPACITY;
    }

    fn holds(&self, ip: IpAddr, now: Instant) -> bool {
        self.entries.iter().flatten().any(|(held, recorded)| {
            *held == ip && now.duration_since(*recorded) < EXPECTED_BROWSER_TTL
        })
    }
}

/// Remember that an offer naming `browser_ip` went out, so an inbound
/// connection from that address can later be told apart from background
/// scanning of a public UDP port.
pub(crate) fn note_offered_browser(browser_ip: IpAddr) {
    if let Ok(mut ring) = EXPECTED_BROWSERS.lock() {
        ring.record(browser_ip, Instant::now());
    }
}

/// Whether an inbound connection is one this daemon has reason to expect.
///
/// Two ways to qualify, and the second is not a fallback but a separate proof:
/// the source matches a browser an offer recently named, **or** the source is
/// not globally routable at all. Internet background scanning arrives from
/// global addresses by construction, so a private, CGNAT or link-local source
/// cannot be it — and that is exactly the same-NAT browser dialling a `host4` /
/// `host6` candidate from a LAN address this daemon was never told.
fn inbound_is_expected(source: IpAddr) -> bool {
    if !side_channel::is_globally_routable(&source) {
        return true;
    }
    EXPECTED_BROWSERS
        .lock()
        .is_ok_and(|ring| ring.holds(source, Instant::now()))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct DatagramSendBudget {
    /// Application payload room for one prospective H3 datagram. The H3
    /// header and first Quinn queue entry are already charged.
    pub first_payload_bytes: usize,
    /// Exact H3 header plus Quinn queue-entry charge for every later datagram
    /// planned against this same snapshot.
    pub additional_entry_overhead: usize,
}

/// Exact advisory application-payload budget for a peer's direct datagram
/// queue, read from its session's delivery view without the registry's or the
/// connection's lock. Final admission is independently atomic and
/// non-dropping, so a concurrent control datagram can only make the later send
/// return backpressure; it can never evict an earlier display row. A peer with
/// no open direct session has nothing queued: its send is what fails.
pub(crate) fn direct_datagram_budget(
    session: Option<&Arc<wtransport::Connection>>,
) -> DatagramSendBudget {
    match session {
        None => DatagramSendBudget {
            first_payload_bytes: DATAGRAM_SEND_BUFFER_BYTES,
            additional_entry_overhead: 0,
        },
        Some(session) => DatagramSendBudget {
            first_payload_bytes: session.datagram_send_buffer_space(),
            additional_entry_overhead: session.datagram_additional_entry_overhead(),
        },
    }
}

/// Take the registry's read lock, charging the wait to the owner's ledger when
/// a writer held or queued ahead of it. Every registry access the owner makes
/// on an input, ACK or display path comes through here, so the ledger's
/// registry wait is the whole of the owner's wait on this lock there.
async fn registry_read(
    state: &Arc<RwLock<WebTransportState>>,
) -> tokio::sync::RwLockReadGuard<'_, WebTransportState> {
    if let Ok(guard) = state.try_read() {
        return guard;
    }
    let waiting = crate::perf_timing::owner::registry_wait();
    let guard = state.read().await;
    drop(waiting);
    guard
}

/// Cumulative inbound datagrams dropped at the direct-WebTransport ingress
/// queue since process start. A `Relaxed` load off the hot path; the increment
/// side already lives on the existing drop branch.
pub(crate) fn inbound_datagram_queue_drops() -> u64 {
    INBOUND_DATAGRAM_QUEUE_DROPS.load(Ordering::Relaxed)
}

/// Cumulative direct-WebTransport sessions refused because the accept slot pool
/// was exhausted.
pub(crate) fn over_capacity_session_rejections() -> u64 {
    OVER_CAPACITY_SESSION_REJECTIONS.load(Ordering::Relaxed)
}

/// Cumulative inbound connections that reached the direct-WebTransport listener
/// **from an address this daemon had reason to expect**.
///
/// This is the daemon half of "was the direct path filtered". The browser can
/// report that it dialled a candidate and heard nothing, but it cannot tell a
/// firewall from a daemon that was not listening. Only this side can.
///
/// It is split from `direct_wt_incoming_unexpected` because the undifferentiated
/// count could not answer that question in practice: an internet-facing UDP port
/// is scanned continuously, and the fleet recorded roughly 300,000 arrivals in a
/// day against about a hundred upgrade attempts. Background noise outweighed the
/// signal by four orders of magnitude, so "browsers dialled and this stayed
/// zero" was never observable. Bucketing restores it.
///
/// This count is a **lower bound**, and deliberately so. A browser dialling a
/// candidate through a NAT that rewrites its source address arrives from an
/// address no offer named; erring toward `unexpected` keeps this number from
/// manufacturing arrivals that never happened.
pub(crate) fn direct_wt_incoming_expected() -> u64 {
    DIRECT_WT_INCOMING_EXPECTED.load(Ordering::Relaxed)
}

/// Cumulative inbound connections from an address no recent offer named and
/// which is globally routable — overwhelmingly internet background scanning.
///
/// Kept rather than discarded so the split stays auditable: the two counters
/// must still sum to every connection that reached the listener, and a sudden
/// collapse in this one is evidence about the *instrument*, not about NAT.
pub(crate) fn direct_wt_incoming_unexpected() -> u64 {
    DIRECT_WT_INCOMING_UNEXPECTED.load(Ordering::Relaxed)
}

/// Cumulative direct-WebTransport peers that completed the authenticated
/// upgrade and took ownership of a real peer id.
///
/// Read against `direct_wt_incoming_expected`: connections arriving but never
/// being admitted is a Merkur bug, not a network verdict, and the two numbers
/// are the only way to tell those apart without guessing.
pub(crate) fn direct_wt_admitted() -> u64 {
    DIRECT_WT_ADMITTED.load(Ordering::Relaxed)
}

/// Count one completed direct-WebTransport admission.
pub(crate) fn note_direct_wt_admitted() {
    DIRECT_WT_ADMITTED.fetch_add(1, Ordering::Relaxed);
}

fn try_reserve_session_slot(slots: &Arc<Semaphore>) -> Option<OwnedSemaphorePermit> {
    Arc::clone(slots).try_acquire_owned().ok()
}

/// Every accepted connection is explicitly closed when its supervisor exits,
/// including setup errors and task cancellation. Merely dropping one
/// `Arc<Connection>` is insufficient while a stream task still owns another.
struct CloseConnectionOnDrop(Arc<wtransport::Connection>);

impl Drop for CloseConnectionOnDrop {
    fn drop(&mut self) {
        self.0.close(
            wtransport::VarInt::from_u32(0),
            b"daemon-session-supervisor-ended",
        );
    }
}

/// Latency-tuned QUIC transport parameters shared by the daemon's QUIC
/// endpoints (direct WT server and the daemon->edge tunnel client).
///
/// - Congestion control stays on quinn's default (Cubic). BBR was tried here
///   (2026-07-02) and produced perceptible TYPING lag: quinn's BBR is
///   experimental, and tiny app-limited terminal flows give it almost no
///   bandwidth samples, so its model can under-pace keystroke echoes.
///   Re-evaluate only with the real-Chrome latency harness on-path.
/// - `initial_rtt` 100ms (default 333ms): first-loss RTO and handshake
///   pacing converge ~3x faster on realistic paths.
/// - ACK-frequency extension with a 5ms max ack delay (default: extension
///   off, 25ms delayed ACKs): quinn<->quinn hops (daemon<->edge) ack
///   promptly, tightening RTT estimates and loss detection for the reliable
///   display lane. A non-quinn peer (browser) simply doesn't negotiate it.
/// - keep-alive/idle mirror the values previously set per-site.
pub(crate) fn tuned_quic_transport_config() -> wtransport::config::QuicTransportConfig {
    let mut config = wtransport::config::QuicTransportConfig::default();
    config
        .initial_rtt(Duration::from_millis(100))
        .datagram_send_buffer_size(DATAGRAM_SEND_BUFFER_BYTES)
        .datagram_receive_buffer_size(Some(DATAGRAM_RECEIVE_BUFFER_BYTES))
        .keep_alive_interval(Some(Duration::from_secs(4)))
        .max_idle_timeout(Some(
            wtransport::quinn::IdleTimeout::try_from(Duration::from_secs(30))
                .expect("30s is a valid idle timeout"),
        ));
    let mut ack_frequency = wtransport::quinn::AckFrequencyConfig::default();
    ack_frequency.max_ack_delay(Some(Duration::from_millis(5)));
    config.ack_frequency_config(Some(ack_frequency));
    config
}

/// Wire-level taxonomy of WebTransport candidates. Serializes as the
/// `kind` field on the offer. The browser uses this for (a) start-order
/// priority in the race, and (b) diagnostics. The daemon decides per-peer
/// whether each address is reachable using `AddressClass` (internal),
/// based on IETF prefix categories (RFC1918, RFC4193, RFC6598, GUA, etc.)
/// rather than naming specific overlays.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CandidateFlavor {
    /// STUN-discovered public IP. Requires hairpinning to work same-NAT.
    Srflx,
    /// An explicit port-mapping lease (PCP or NAT-PMP). The only candidate kind
    /// that does not depend on NAT filter state: the gateway has been told to
    /// forward, so unsolicited inbound is admitted by configuration rather than
    /// by a keepalive and a punch landing in time.
    NatMap,
    /// Any routable IPv4 host (RFC1918 LAN, RFC6598 CGNAT/overlay, GUA).
    Host4,
    /// Any routable IPv6 host (GUA, RFC4193 ULA / overlay).
    Host6,
    /// 127.0.0.1 / ::1, added only for the SameHost selection strategy.
    Loopback,
}

/// Internal classification of an IP address by IETF prefix category. The
/// pairing layer uses this to decide which candidates to emit per peer,
/// without hardcoding the prefixes of any specific overlay (e.g. Tailscale).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AddressClass {
    /// IPv4 RFC1918 private (10/8, 172.16/12, 192.168/16) — true LAN.
    Ipv4Private,
    /// IPv4 RFC6598 shared address space (100.64/10) — CGNAT / overlay.
    Ipv4Cgnat,
    /// IPv4 globally routable.
    Ipv4Global,
    /// IPv6 globally routable (2000::/3).
    Ipv6Global,
    /// IPv6 RFC4193 unique-local (fc00::/7) — overlay / VPN / container bridge.
    Ipv6UniqueLocal,
    /// Loopback (127/8 or ::1).
    Loopback,
    /// Link-local, multicast, unspecified, or otherwise non-routable.
    NonRoutable,
}

pub fn classify_ipv4(addr: &Ipv4Addr) -> AddressClass {
    if addr.is_loopback() {
        return AddressClass::Loopback;
    }
    if addr.is_unspecified() || addr.is_link_local() || addr.is_multicast() || addr.is_broadcast() {
        return AddressClass::NonRoutable;
    }
    let o = addr.octets();
    if addr.is_private() {
        return AddressClass::Ipv4Private;
    }
    // RFC6598 100.64.0.0/10 — shared address space for CGNAT and overlay
    // networks (Tailscale, some ISPs). Not RFC1918 but also not globally
    // routable; treated as overlay for pairing purposes.
    if o[0] == 100 && (o[1] & 0xc0) == 0x40 {
        return AddressClass::Ipv4Cgnat;
    }
    AddressClass::Ipv4Global
}

pub fn classify_ipv6(addr: &Ipv6Addr) -> AddressClass {
    if addr.is_loopback() {
        return AddressClass::Loopback;
    }
    if addr.is_unspecified() || addr.is_multicast() {
        return AddressClass::NonRoutable;
    }
    if is_link_local_v6(addr) {
        return AddressClass::NonRoutable;
    }
    if (addr.octets()[0] & 0xfe) == 0xfc {
        return AddressClass::Ipv6UniqueLocal;
    }
    AddressClass::Ipv6Global
}

pub fn classify_ip(addr: &IpAddr) -> AddressClass {
    match addr {
        IpAddr::V4(v4) => classify_ipv4(v4),
        IpAddr::V6(v6) => classify_ipv6(v6),
    }
}

/// Classify an address as an interface holds it, prefix included. The network
/// and broadcast addresses of a /30 or wider subnet name the subnet, not a
/// host, and netdev occasionally reports the subnet ID (`192.168.97.0/24`) as
/// an interface address. A /31 (RFC 3021) or /32 has neither. Only a local
/// interface carries its prefix: a remote address goes through `classify_ip`,
/// where `.0` and `.255` are ordinary hosts of any block wider than /24.
pub fn classify_interface_ipv4(net: &Ipv4Net) -> AddressClass {
    let addr = net.addr();
    if net.prefix_len() <= 30 && (addr == net.network() || addr == net.broadcast()) {
        return AddressClass::NonRoutable;
    }
    classify_ipv4(&addr)
}

pub fn classify_interface_net(net: &IpNet) -> AddressClass {
    match net {
        IpNet::V4(v4) => classify_interface_ipv4(v4),
        IpNet::V6(v6) => classify_ipv6(&v6.addr()),
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct AddressCandidate {
    pub addr: String,
    pub port: u16,
    pub kind: CandidateFlavor,
}

pub struct CertState {
    pub cert_hash: [u8; 32],
    pub created_at: Instant,
    pub valid_for: Duration,
}

impl CertState {
    pub fn needs_rotation(&self) -> bool {
        self.created_at.elapsed()
            >= self
                .valid_for
                .saturating_sub(Duration::from_secs(CERT_ROTATION_BUFFER_SECS))
    }

    pub fn cert_hash_base64(&self) -> String {
        base64::Engine::encode(&base64::engine::general_purpose::STANDARD, self.cert_hash)
    }
}

pub struct WebTransportState {
    pub discovery_evidence: stun::DiscoveryEvidence,
    pub peer_connections: HashMap<String, ChannelPeerConnection>,
    pub sessions: HashMap<String, Arc<wtransport::Connection>>,
    /// Every live session supervisor, including a connection displaced from
    /// `peer_connections` while its close event is still in flight.
    ///
    /// The certificate-rotation owner drains this bounded registry after
    /// aborting/joining old supervisors. That explicit handoff prevents an
    /// aborted supervisor from orphaning its temp->real lifecycle mapping.
    lifecycle_peers: HashMap<u64, String>,
    /// Exact completion signals for fully-bound sessions that have not yet
    /// authenticated their temp id. The session supervisor owns the receiver;
    /// `upgrade_peer` removes and signals only the connection id it migrated.
    pending_upgrade_deadlines: HashMap<u64, oneshot::Sender<()>>,
    pub cert_state: CertState,
    pub port: u16,
    /// Cached candidate set populated at start_server (and refreshed by the
    /// retained-mapping reprobe). Used by the pairing layer to build per-peer
    /// offers without re-enumerating interfaces on every session_auth.
    pub candidates: Vec<AddressCandidate>,
    /// STUN-derived NAT signature carried on every offer so the browser
    /// can record it in diagnostics.
    pub nat_signature: pairing::NatSignature,
    pub nat_mapping: stun::NatMapping,
    pub daemon_srflx: Option<IpAddr>,
    /// Send-only side channel used for the NAT-mapping keepalive and for
    /// pinhole punches toward an authenticated browser address.
    pub side_channel: Option<Arc<side_channel::SideChannel>>,
    pub traversal_requests: Option<mpsc::Sender<traversal::Request>>,
    pub discovery_socket: Option<Arc<discovery_socket::DiscoverySocket>>,
    /// The live port-mapping lease, when one has been won.
    ///
    /// Held here rather than in the owner loop because both the reprobe (which
    /// must carry it forward rather than retract a candidate it cannot
    /// re-derive) and the renewal read it under the same lock the offer builder
    /// already takes.
    pub port_lease: Option<Arc<portmap::Lease>>,
    /// The live IPv6 firewall pinhole, for the same reasons as `port_lease`.
    pub v6_pinhole: Option<Arc<portmap::Pinhole>>,
    /// The local address that provably reached a STUN observer, from the last
    /// successful probe. The mapping cycle resolves its egress interface from
    /// it; `None` until a probe has answered.
    pub stun_local_ip: Option<IpAddr>,
}

impl WebTransportState {
    /// The global IPv6 address the gateway currently holds a pinhole for.
    pub fn pinholed_v6(&self) -> Option<Ipv6Addr> {
        self.v6_pinhole
            .as_ref()
            .filter(|pinhole| pinhole.expires_at > Instant::now())
            .map(|pinhole| pinhole.address)
    }

    /// The best globally routable `host6` candidate, in emission order — the
    /// address a pinhole is worth opening for.
    pub fn top_global_host6(&self) -> Option<Ipv6Addr> {
        self.candidates.iter().find_map(|candidate| {
            if candidate.kind != CandidateFlavor::Host6 {
                return None;
            }
            let addr: Ipv6Addr = candidate.addr.parse().ok()?;
            matches!(classify_ipv6(&addr), AddressClass::Ipv6Global).then_some(addr)
        })
    }

    pub fn new(
        cert_state: CertState,
        port: u16,
        candidates: Vec<AddressCandidate>,
        nat_signature: pairing::NatSignature,
        nat_mapping: stun::NatMapping,
        daemon_srflx: Option<IpAddr>,
    ) -> Self {
        Self {
            discovery_evidence: stun::DiscoveryEvidence::default(),
            peer_connections: HashMap::new(),
            sessions: HashMap::new(),
            lifecycle_peers: HashMap::new(),
            pending_upgrade_deadlines: HashMap::new(),
            cert_state,
            port,
            candidates,
            nat_signature,
            nat_mapping,
            daemon_srflx,
            side_channel: None,
            traversal_requests: None,
            discovery_socket: None,
            port_lease: None,
            v6_pinhole: None,
            stun_local_ip: None,
        }
    }

    /// Production constructor: carries the side channel across from the freshly
    /// started server. `new` defaults it to `None` for tests, so a real server
    /// must come through here or its NAT mapping is never refreshed.
    pub fn from_server_info(cert_state: CertState, info: &WebTransportServerInfo) -> Self {
        let mut state = Self::new(
            cert_state,
            info.port,
            info.candidates.clone(),
            info.nat_signature.clone(),
            info.nat_mapping,
            info.daemon_srflx,
        );
        state.discovery_evidence = info.discovery_evidence;
        state.side_channel = info.side_channel.clone();
        state.discovery_socket = info.discovery_socket.clone();
        state
    }
}

pub struct WebTransportServerInfo {
    pub discovery_evidence: stun::DiscoveryEvidence,
    pub port: u16,
    pub candidates: Vec<AddressCandidate>,
    pub nat_signature: pairing::NatSignature,
    pub nat_mapping: stun::NatMapping,
    pub daemon_srflx: Option<IpAddr>,
    /// Whether an unsolicited inbound IPv6 datagram was observed reaching the
    /// pinned port, as `Ipv6Reachability::as_str`.
    ///
    /// Observational only — it never suppresses a `host6` candidate, for the
    /// reason recorded on `Ipv6Reachability`. `host6` is the only candidate kind
    /// besides `srflx` that has won a direct upgrade in production, so whether
    /// the rest are firewall-filtered is the open question.
    ///
    /// The TypeScript reader checks an EXACT key set, so this field and its
    /// reader move together or the whole report is rejected.
    pub ipv6_reachability: &'static str,
    /// Send-only handle on quinn's socket. `None` only if the clone failed,
    /// which degrades to the pre-existing behaviour rather than failing start.
    pub side_channel: Option<Arc<side_channel::SideChannel>>,
    pub discovery_socket: Option<Arc<discovery_socket::DiscoverySocket>>,
}

/// Build a fresh self-signed identity and the QUIC server config carrying it.
///
/// Shared by the initial bind and by certificate rotation. Rotation reuses this
/// and then hands the result to [`WebTransportServer::reload_certificate`],
/// which swaps the TLS config on the live socket: the daemon's port is an
/// operator contract (a router forward or firewall rule names it) and quinn sets
/// no `SO_REUSEPORT`, so a second `Endpoint::server` on that port is `EADDRINUSE`
/// while the first still holds it. Rebinding to rotate is therefore not merely
/// disruptive, it cannot succeed at all.
///
/// Bind dual-stack ([::] with V6ONLY off), letting wtransport/quinn create AND
/// configure its own UDP socket (GSO/GRO/ECN/RECVTOS, per-datagram metadata). A
/// pre-made socket handed via `with_bind_socket` left quinn-udp unable to
/// configure the dual-stack socket correctly on macOS (`Ignoring error setting
/// IP_RECVTOS`), which mis-associated inbound 1-RTT packets ("discarding
/// unexpected Data packet") so the server handshake never completed and
/// `endpoint.accept()` never fired. This mirrors the proven edge server
/// (apps/edge/src/relay.rs::with_bind_address). On the initial bind the STUN
/// socket is already dropped, so no `SO_REUSEPORT` overlap is needed to hold the
/// port. `bind_port` is ignored when this config is used to reload rather than
/// to bind.
pub fn build_server_config(bind_port: u16) -> Result<(ServerConfig, CertState), String> {
    let (identity, cert_state) = generate_identity()?;

    let bind_addr = std::net::SocketAddr::V6(std::net::SocketAddrV6::new(
        Ipv6Addr::UNSPECIFIED,
        bind_port,
        0,
        0,
    ));

    let mut tls_config = wtransport::tls::server::build_default_tls_config(identity);
    tls_config.max_early_data_size = u32::MAX;

    let config = ServerConfig::builder()
        .with_bind_address(bind_addr)
        .with_custom_tls_and_transport(tls_config, tuned_quic_transport_config())
        .build();

    Ok((config, cert_state))
}

/// Fresh self-signed identity plus the rotation bookkeeping that tracks it.
fn generate_identity() -> Result<(wtransport::Identity, CertState), String> {
    let identity = wtransport::Identity::self_signed(["localhost", "127.0.0.1"])
        .map_err(|e| format!("failed to generate self-signed identity: {e}"))?;

    let cert = identity
        .certificate_chain()
        .as_slice()
        .first()
        .ok_or("no certificate in chain")?;

    let hash = cert.hash();
    let mut cert_hash = [0u8; 32];
    cert_hash.copy_from_slice(hash.as_ref());

    info!(
        "generated self-signed cert, hash={}",
        base64::Engine::encode(&base64::engine::general_purpose::STANDARD, cert_hash)
    );

    let cert_state = CertState {
        cert_hash,
        created_at: Instant::now(),
        valid_for: Duration::from_secs(CERT_VALIDITY_DAYS as u64 * 86400),
    };

    Ok((identity, cert_state))
}

/// Bind the WebTransport socket ourselves, so a send-only `try_clone` can keep
/// the NAT mapping alive and open pinholes from the *same* 4-tuple quinn uses.
/// See `side_channel` for why that matters and why it is send-only.
///
/// This replicates `wtransport::BindAddressConfig::bind_socket` exactly:
/// `Socket::new(IPV6, DGRAM, UDP)`, dual-stack left at the OS default (no
/// `set_only_v6` call at all), then `bind`. Matching it precisely is the point.
/// The earlier failure recorded on `build_server_config` — quinn-udp unable to
/// configure the socket on macOS ("Ignoring error setting IP_RECVTOS"), 1-RTT
/// packets mis-associated, `accept()` never firing — came from handing over
/// `stun::create_reuseport_socket`, which is **IPv4-only and `SO_REUSEPORT`**.
/// A dual-stack socket built the way wtransport builds it does not reproduce
/// it, and `SO_REUSEPORT` appears nowhere here.
fn bind_wt_socket(bind_port: u16) -> Result<std::net::UdpSocket, String> {
    let socket = socket2::Socket::new(
        socket2::Domain::IPV6,
        socket2::Type::DGRAM,
        Some(socket2::Protocol::UDP),
    )
    .map_err(|e| format!("failed to create WebTransport socket: {e}"))?;

    let bind_addr = std::net::SocketAddr::V6(std::net::SocketAddrV6::new(
        Ipv6Addr::UNSPECIFIED,
        bind_port,
        0,
        0,
    ));
    socket
        .bind(&bind_addr.into())
        .map_err(|e| format!("failed to bind WebTransport socket on port {bind_port}: {e}"))?;

    Ok(std::net::UdpSocket::from(socket))
}

/// Initial bind. Returns the send-only clone alongside the config; the original
/// is moved into the config for quinn.
fn build_server_config_owning_socket(
    bind_port: u16,
) -> Result<
    (
        ServerConfig,
        CertState,
        std::net::UdpSocket,
        Arc<discovery_socket::DiscoverySocket>,
    ),
    String,
> {
    let (identity, cert_state) = generate_identity()?;

    let socket = bind_wt_socket(bind_port)?;
    let side = socket
        .try_clone()
        .map_err(|e| format!("failed to clone WebTransport socket: {e}"))?;

    let mut tls_config = wtransport::tls::server::build_default_tls_config(identity);
    tls_config.max_early_data_size = u32::MAX;

    let discovery = discovery_socket::DiscoverySocket::new(socket)
        .map_err(|e| format!("failed to own WebTransport socket: {e}"))?;
    let config = ServerConfig::builder()
        .with_bind_address(([0, 0, 0, 0], bind_port).into())
        .with_custom_tls_and_transport(tls_config, tuned_quic_transport_config())
        .build();

    Ok((config, cert_state, side, discovery))
}

pub fn start_server(
    pinned_port: u16,
    public_endpoint: Option<std::net::SocketAddr>,
) -> Result<
    (
        Endpoint<wtransport::endpoint::endpoint_side::Server>,
        CertState,
        WebTransportServerInfo,
    ),
    String,
> {
    // Bind once. Quinn owns all reads, including discovery responses, for the
    // entire endpoint lifetime. No bind/drop window or port inference exists.
    let (config, cert_state, side_socket, discovery_socket) =
        build_server_config_owning_socket(pinned_port)?;
    let endpoint = Endpoint::server_with_socket(config, discovery_socket.clone())
        .map_err(|e| format!("failed to start WebTransport server: {e}"))?;
    // Built after the endpoint so a bind failure never leaves a live clone of a
    // socket nothing owns.
    let side_channel = match side_channel::SideChannel::new(side_socket) {
        Ok(channel) => Some(Arc::new(channel)),
        Err(error) => {
            // Not fatal: losing the keepalive costs the srflx candidate its
            // freshness, which is exactly the status quo before this existed.
            warn!("side channel unavailable, NAT mapping will not be refreshed: {error}");
            None
        }
    };

    let local_addr = endpoint
        .local_addr()
        .map_err(|e| format!("failed to get local addr: {e}"))?;
    let port = local_addr.port();

    // Discovery runs only after the accept owner is installed, so its first
    // independent-address callback reaches the real admission handler. No
    // pinhole can exist yet: the v6 lease is acquired by the mapping cycle,
    // which runs only once this server is live.
    let host_candidates = collect_local_candidates(port, None);
    let mut candidates = Vec::with_capacity(host_candidates.len() + 1);
    let nat_signature = pairing::NatSignature {
        public_ip: None,
        nat_type: pairing::NatTypeLabel::from(stun::NatMapping::Unknown),
        hairpin: false,
    };

    // 1. A declared port mapping, when an operator installed one.
    //
    // First because it is the only candidate here that rests on configuration
    // rather than inference: somebody forwarded a port, so unsolicited inbound
    // is admitted by a rule rather than by a keepalive and a punch landing in
    // time. `NatMap` already means exactly that; a PCP lease and a box host's
    // `incus network forward` differ only in who installed the rule.
    if let Some(declared) = public_endpoint {
        info!("publishing declared public endpoint {} (nat_map)", declared);
        candidates.push(AddressCandidate {
            addr: declared.ip().to_string(),
            port: declared.port(),
            kind: CandidateFlavor::NatMap,
        });
    }

    // Host candidates are ready immediately, without waiting for discovery.
    for c in &host_candidates {
        if !candidates
            .iter()
            .any(|e| e.addr == c.addr && e.port == c.port)
        {
            candidates.push(c.clone());
        }
    }

    info!(
        "WebTransport server listening on port {port}, {} candidates",
        candidates.len()
    );
    for c in &candidates {
        info!("  candidate: {}:{} ({:?})", c.addr, c.port, c.kind);
    }

    let info = WebTransportServerInfo {
        discovery_evidence: stun::DiscoveryEvidence::default(),
        port,
        candidates,
        nat_signature,
        nat_mapping: stun::NatMapping::Unknown,
        daemon_srflx: None,
        ipv6_reachability: stun::Ipv6Reachability::Unknown.as_str(),
        side_channel,
        discovery_socket: Some(discovery_socket),
    };

    Ok((endpoint, cert_state, info))
}

/// Serialize one direct-path manifest: every candidate `candidates` names, the
/// certificate they are pinned to, and the browser address the manifest was
/// built for, which is where its punch (if `punch`) was aimed.
///
/// `generation` orders a peer's manifests. A punch outcome names the
/// generation it belongs to, and the browser dials a punched kind only under
/// the manifest whose punch it has heard the outcome of.
pub fn manifest_json(
    wt_state: &WebTransportState,
    candidates: &[AddressCandidate],
    browser_address: IpAddr,
    generation: u64,
    punch: bool,
) -> serde_json::Value {
    let candidates_json: Vec<serde_json::Value> = candidates
        .iter()
        .map(|c| {
            serde_json::json!({
                "addr": c.addr,
                "port": c.port,
                "kind": c.kind,
                "scope": pairing::candidate_scope(&c.addr),
            })
        })
        .collect();
    serde_json::json!({
        "type": "webtransport_manifest",
        "generation": generation,
        "cert_hash": wt_state.cert_state.cert_hash_base64(),
        "candidates": candidates_json,
        "nat": {
            "public_ip": &wt_state.nat_signature.public_ip,
            "nat_type": wt_state.nat_signature.nat_type,
            "hairpin": wt_state.nat_signature.hairpin,
            "nat_filtering": wt_state.discovery_evidence.nat_filtering,
        },
        "browser_address": browser_address,
        "punch": if punch { "pending" } else { "none" },
    })
}

/// Reflexive evidence the live server already published, carried into a reprobe.
///
/// The live socket may temporarily learn nothing because of loss or an expired
/// ticket. Retain the last published mapping until authenticated fresh evidence
/// replaces it; a timeout is not evidence that the existing candidate disappeared.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PriorReflexive {
    /// The reflexive candidate currently published, if any.
    pub srflx: Option<AddressCandidate>,
    pub nat_signature: pairing::NatSignature,
    pub nat_mapping: stun::NatMapping,
    pub daemon_srflx: Option<IpAddr>,
    /// The global IPv6 address the gateway holds a live pinhole for, so the
    /// re-collected host set ranks it first rather than by SLAAC flags alone.
    pub pinholed_v6: Option<Ipv6Addr>,
    /// See `WebTransportState::stun_local_ip`.
    pub stun_local_ip: Option<IpAddr>,
}

impl Default for PriorReflexive {
    /// No reflexive evidence yet: a daemon whose probe has never succeeded. The
    /// retention rules then have nothing to retain and answer exactly as they
    /// did before retention existed.
    fn default() -> Self {
        Self {
            srflx: None,
            nat_signature: pairing::NatSignature {
                public_ip: None,
                nat_type: pairing::NatTypeLabel::None,
                hairpin: false,
            },
            nat_mapping: stun::NatMapping::Unknown,
            daemon_srflx: None,
            pinholed_v6: None,
            stun_local_ip: None,
        }
    }
}

impl PriorReflexive {
    /// Snapshot the reflexive half of the live state.
    pub fn from_state(state: &WebTransportState) -> Self {
        Self {
            srflx: state
                .candidates
                .iter()
                .find(|candidate| candidate.kind == CandidateFlavor::Srflx)
                .cloned(),
            nat_signature: state.nat_signature.clone(),
            nat_mapping: state.nat_mapping,
            daemon_srflx: state.daemon_srflx,
            pinholed_v6: state.pinholed_v6(),
            stun_local_ip: state.stun_local_ip,
        }
    }
}

pub struct ReprobeResult {
    pub discovery_evidence: stun::DiscoveryEvidence,
    pub ipv6_reachability: &'static str,
    pub candidates: Vec<AddressCandidate>,
    pub nat_signature: pairing::NatSignature,
    pub nat_mapping: stun::NatMapping,
    pub daemon_srflx: Option<IpAddr>,
    /// The local address that reached an observer this round, or the prior
    /// one when the probe learned nothing.
    pub stun_local_ip: Option<IpAddr>,
    /// The v4 egress path as of this reprobe, so the run loop can tell whether
    /// the lease it holds still names this gateway and interface. Resolved on
    /// the maintenance task, because it enumerates interfaces.
    pub egress: Option<egress::EgressPath>,
}

/// Whether a reflexive candidate is worth putting in an offer.
///
/// Destination-dependent mapping is positive evidence that an observed endpoint
/// is not transferable. Filtering silence and unknown mapping do not suppress a
/// candidate: the browser's actual WT race remains the reachability authority.
fn srflx_is_dialable(result: &stun::StunResult) -> bool {
    tracing::debug!(
        local_port = result.local_port,
        allocation = result.port_allocation.as_str(),
        "evaluating live reflexive mapping"
    );
    result.nat_mapping != stun::NatMapping::EndpointDependent
}

/// Everything one mapping cycle needs from the live state, snapshotted under
/// one lock by the run loop and moved onto the maintenance task.
pub struct MappingInputs {
    pub port: u16,
    pub stun_local_ip: Option<IpAddr>,
    pub existing_lease: Option<Arc<portmap::Lease>>,
    pub existing_pinhole: Option<Arc<portmap::Pinhole>>,
    /// The reflexive address the lease is published under.
    pub reflexive: Option<IpAddr>,
    /// The global IPv6 address a pinhole is worth opening for.
    pub host6: Option<Ipv6Addr>,
    /// A gateway announcement said the lease is already gone (epoch went
    /// backwards or the external address moved). Renewal is skipped and so is
    /// the delete that would otherwise fence re-acquisition: there is nothing
    /// on the gateway to delete, and RFC 6886 deletion removes every mapping
    /// for the internal port, so sending one after the replacement lands
    /// would destroy the replacement.
    pub gateway_rebooted: bool,
}

/// What one mapping cycle produced: the v4 lease and the v6 pinhole, each with
/// its own reportable outcome, plus the egress paths the cycle used.
pub struct MappingCycle {
    pub lease: LeaseOutcome,
    pub pinhole: portmap::PinholeCycle,
    pub egress: Option<egress::EgressPath>,
}

/// Acquire or renew the port-mapping lease and the IPv6 pinhole.
///
/// Deliberately separate from `start_server` and from the reprobe. Mapping is
/// the one piece of candidate discovery that talks to a device outside this
/// host, and a gateway that neither answers nor refuses costs the full
/// retransmission schedule. Holding the candidate set back for that is what the
/// old startup/full budget split existed to mitigate; running it here instead
/// removes the need for a mitigation, because nothing waits on it. A won lease
/// reaches browsers in the next manifest.
///
/// The v4 lease and the v6 pinhole are independent leases on independent
/// paths, acquired concurrently with source-bound discovery in each family.
pub async fn run_mapping_cycle(inputs: MappingInputs) -> MappingCycle {
    let egress = egress::resolve_egress_path(inputs.stun_local_ip);
    let lease = async {
        let lease = match inputs.existing_lease {
            Some(existing)
                if !inputs.gateway_rebooted
                    && egress.as_ref().is_some_and(|path| {
                        path.gateway == Some(existing.gateway)
                            && path.interface_index == existing.interface_index
                            && path.local_ipv4 == existing.local_ipv4
                    }) =>
            {
                // `Arc` is shared with the offer builder, so renewal needs its own
                // copy to mutate. A lease is a handful of `Copy` fields plus the
                // client handle; cloning it is cheaper than holding the state lock
                // across a gateway round trip.
                let mut lease = (*existing).clone();
                if portmap::renew(&mut lease).await {
                    Some(LeaseOutcome::Renewed(Arc::new(lease)))
                } else {
                    // Renewal failed or the gateway rebooted. Retire explicitly and
                    // in order before re-acquiring: RFC 6886 deletion removes every
                    // mapping for the internal port, so an unfenced delete would
                    // destroy the replacement this is about to create.
                    portmap::release(lease).await;
                    None
                }
            }
            Some(existing) => {
                if !inputs.gateway_rebooted {
                    portmap::release((*existing).clone()).await;
                }
                None
            }
            None => None,
        };
        match lease {
            Some(renewed) => renewed,
            None => match portmap::acquire(inputs.port, egress.as_ref(), inputs.reflexive).await {
                portmap::Outcome::Mapped(lease) => LeaseOutcome::Acquired(Arc::new(*lease)),
                other => LeaseOutcome::None(other),
            },
        }
    };
    let pinhole = async {
        let egress6 = inputs.host6.and_then(egress::resolve_egress_path_v6);
        let pinhole = match inputs.existing_pinhole {
            Some(existing)
                if !inputs.gateway_rebooted
                    && egress6.as_ref().is_some_and(|path| {
                        path.local == existing.address
                            && path.gateway == Some(existing.gateway)
                            && path.interface_index == existing.interface_index
                    }) =>
            {
                let mut pinhole = (*existing).clone();
                if portmap::renew_pinhole(&mut pinhole).await {
                    Some(portmap::PinholeCycle::Renewed(Arc::new(pinhole)))
                } else {
                    portmap::release_pinhole(pinhole).await;
                    None
                }
            }
            Some(existing) => {
                // The address moved out from under the hole (SLAAC rotation, a
                // path edge) or the gateway forgot it. Close what can be closed.
                if !inputs.gateway_rebooted {
                    portmap::release_pinhole((*existing).clone()).await;
                }
                None
            }
            None => None,
        };
        match pinhole {
            Some(renewed) => renewed,
            None => match portmap::acquire_pinhole(inputs.port, egress6.as_ref()).await {
                portmap::PinholeOutcome::Pinholed(pinhole) => {
                    portmap::PinholeCycle::Opened(Arc::new(*pinhole))
                }
                other => portmap::PinholeCycle::None(other),
            },
        }
    };
    let (lease, pinhole) = tokio::join!(lease, pinhole);
    MappingCycle {
        lease,
        pinhole,
        egress,
    }
}

/// What one lease cycle produced. Every arm carries a reportable metric key.
pub enum LeaseOutcome {
    Acquired(Arc<portmap::Lease>),
    Renewed(Arc<portmap::Lease>),
    None(portmap::Outcome),
}

impl LeaseOutcome {
    pub fn metric_key(&self) -> &'static str {
        match self {
            Self::Acquired(lease) => lease.protocol.mapped_key(),
            Self::Renewed(lease) => lease.protocol.renewed_key(),
            Self::None(outcome) => outcome.metric_key(),
        }
    }

    pub fn lease(&self) -> Option<Arc<portmap::Lease>> {
        match self {
            Self::Acquired(lease) | Self::Renewed(lease) => Some(Arc::clone(lease)),
            Self::None(_) => None,
        }
    }
}

/// Move the pinholed `host6` candidate to the front of its family without
/// re-enumerating interfaces. The browser races in emission order, so this is
/// what makes the pinhole worth anything before the next reprobe.
pub fn promote_pinholed_host6(candidates: &mut [AddressCandidate], address: Ipv6Addr) -> bool {
    let Some(first_host6) = candidates
        .iter()
        .position(|candidate| candidate.kind == CandidateFlavor::Host6)
    else {
        return false;
    };
    let Some(at) = candidates.iter().position(|candidate| {
        candidate.kind == CandidateFlavor::Host6
            && candidate
                .addr
                .parse::<Ipv6Addr>()
                .is_ok_and(|addr| addr == address)
    }) else {
        return false;
    };
    if at == first_host6 {
        return false;
    }
    candidates[first_host6..=at].rotate_right(1);
    true
}

/// Reprobe the reflexive candidate after a network change.
pub async fn reprobe_candidates_retaining(
    port: u16,
    public_endpoint: Option<std::net::SocketAddr>,
    discovery: &Arc<discovery_socket::DiscoverySocket>,
    credential: Option<&stun::StunCredential>,
    prior: PriorReflexive,
    prior_lease: Option<portmap::PriorLease>,
) -> ReprobeResult {
    let host_candidates = collect_local_candidates(port, prior.pinholed_v6);
    let (stun_result, ipv6_reachability) = match credential {
        Some(credential) => {
            let (mapping, ipv6) = tokio::join!(
                stun::probe(discovery, credential),
                stun::probe_ipv6_reachability(discovery, credential),
            );
            info!(
                ipv6_reachability = ipv6.as_str(),
                "NAT reachability outcome"
            );
            (mapping, ipv6.as_str())
        }
        None => (Err("no STUN credential yet".to_string()), "unknown"),
    };

    let mut result = build_reprobe_result(
        public_endpoint,
        host_candidates,
        stun_result,
        prior,
        prior_lease,
    );
    result.ipv6_reachability = ipv6_reachability;
    result.egress = egress::resolve_egress_path(result.stun_local_ip);
    result
}

/// Assemble a reprobe's candidate set.
///
/// The governing rule, and the one that was previously only half applied: **only
/// a positive finding may retract reflexive evidence.** A reprobe runs from an
/// ephemeral socket and can fail for reasons that say nothing about the NAT — one
/// lost datagram, a two-second timeout, a spent ticket — while the quinn endpoint
/// has been continuously bound to `expected_port` the whole time and still owns
/// whatever mapping the startup probe created for it. Treating "I learned
/// nothing" as "it is gone" both loses the direct path and, because the caller
/// sends a new manifest on any change, churns every attached browser.
fn build_reprobe_result(
    public_endpoint: Option<std::net::SocketAddr>,
    host_candidates: Vec<AddressCandidate>,
    stun_result: Result<stun::StunResult, String>,
    prior: PriorReflexive,
    prior_lease: Option<portmap::PriorLease>,
) -> ReprobeResult {
    let mut candidates = Vec::with_capacity(host_candidates.len() + 2);
    if let Some(declared) = public_endpoint {
        candidates.push(AddressCandidate {
            addr: declared.ip().to_string(),
            port: declared.port(),
            kind: CandidateFlavor::NatMap,
        });
    }

    // A probe that did not answer is not evidence that the NAT moved, so the
    // whole signature is carried forward unchanged. Keeping it identical is what
    // leaves the caller's `changed` comparison false and suppresses the manifest.
    let (nat_mapping_value, hairpin, daemon_srflx, stun_local_ip) = match &stun_result {
        Ok(r) => (
            r.nat_mapping,
            r.hairpin,
            Some(r.public_addr.ip()),
            r.local_ip.or(prior.stun_local_ip),
        ),
        Err(_) => (
            prior.nat_mapping,
            prior.nat_signature.hairpin,
            prior.daemon_srflx,
            prior.stun_local_ip,
        ),
    };

    match &stun_result {
        // This is the live listener's authenticated mapping, including any
        // translated external port. It replaces the previous observation.
        Ok(result) if srflx_superseded_by_declared(public_endpoint, result.public_addr) => {}
        Ok(result) if srflx_is_dialable(result) => {
            candidates.push(AddressCandidate {
                addr: result.public_addr.ip().to_string(),
                port: result.public_addr.port(),
                kind: CandidateFlavor::Srflx,
            });
        }
        // A positively observed destination-dependent mapping is not a
        // transferable reflexive candidate. Filtering silence is never a veto.
        Ok(result) => {
            info!(
                "reprobe retracting srflx candidate (nat={}, filtering={})",
                result.nat_mapping.as_str(),
                result.nat_filtering.as_str(),
            );
        }
        Err(error) => {
            if let Some(retained) = prior.srflx.as_ref() {
                info!("reprobe failed ({error}); retaining the published srflx candidate");
                candidates.push(retained.clone());
            }
        }
    }

    // The same rule the reflexive arm above follows: only a positive finding
    // retracts. A reprobe cannot re-derive a lease it did not create, so
    // "I learned nothing about the lease" must carry it forward unchanged.
    // Dropping it here would change the candidate set on every network edge and
    // cost each attached browser a fresh N-way race — the exact failure the
    // 2026-08-17 reprobe entry already paid for once on the reflexive side.
    if let Some(lease) = prior_lease.as_ref() {
        if lease.is_live(Instant::now()) {
            let candidate = lease.candidate.clone();
            if !candidates
                .iter()
                .any(|e| e.addr == candidate.addr && e.port == candidate.port)
            {
                candidates.push(candidate);
            }
        } else {
            info!(
                protocol = lease.protocol.as_str(),
                "port-mapping lease has lapsed; withholding its candidate"
            );
        }
    }

    for c in &host_candidates {
        if !candidates
            .iter()
            .any(|e| e.addr == c.addr && e.port == c.port)
        {
            candidates.push(c.clone());
        }
    }

    info!("reprobed {} WebTransport candidates", candidates.len());
    ReprobeResult {
        ipv6_reachability: "unknown",
        discovery_evidence: stun_result
            .as_ref()
            .map(stun::DiscoveryEvidence::from)
            .unwrap_or_default(),
        candidates,
        nat_signature: pairing::NatSignature {
            public_ip: daemon_srflx.map(|ip| ip.to_string()),
            nat_type: pairing::NatTypeLabel::from(nat_mapping_value),
            hairpin,
        },
        nat_mapping: nat_mapping_value,
        daemon_srflx,
        stun_local_ip,
        egress: None,
    }
}

#[cfg(test)]
mod port_lease_tests {
    use super::*;

    #[test]
    fn declared_endpoint_survives_discovery_and_suppresses_same_family_reflexive() {
        let declared = "198.51.100.20:443".parse().unwrap();
        let observed = stun::StunResult {
            local_port: 44300,
            public_addr: "198.51.100.20:50000".parse().unwrap(),
            nat_mapping: stun::NatMapping::EndpointIndependent,
            port_allocation: stun::PortAllocation::Stable,
            nat_filtering: stun::NatFiltering::Unknown,
            hairpin: false,
            local_ip: None,
        };
        for discovery in [Ok(observed), Err("lost response".to_string())] {
            let result = build_reprobe_result(
                Some(declared),
                Vec::new(),
                discovery,
                PriorReflexive::default(),
                None,
            );
            assert_eq!(
                result.candidates,
                vec![AddressCandidate {
                    addr: "198.51.100.20".to_string(),
                    port: 443,
                    kind: CandidateFlavor::NatMap,
                }]
            );
        }
    }

    /// Promotion is an in-place rotation over the existing vector: no
    /// re-enumeration, no allocation, and a no-op when already first.
    #[test]
    fn a_pinholed_host6_is_rotated_to_the_front_of_its_family_without_allocating() {
        let mut candidates = vec![
            AddressCandidate {
                addr: "203.0.113.5".into(),
                port: 44_433,
                kind: CandidateFlavor::Srflx,
            },
            AddressCandidate {
                addr: "2001:db8::1".into(),
                port: 44_433,
                kind: CandidateFlavor::Host6,
            },
            AddressCandidate {
                addr: "2001:db8::2".into(),
                port: 44_433,
                kind: CandidateFlavor::Host6,
            },
            AddressCandidate {
                addr: "192.168.1.10".into(),
                port: 44_433,
                kind: CandidateFlavor::Host4,
            },
        ];
        let pinholed: Ipv6Addr = "2001:db8::2".parse().unwrap();
        crate::edge_tunnel::test_allocations::begin_thread();
        let changed = promote_pinholed_host6(&mut candidates, pinholed);
        let again = promote_pinholed_host6(&mut candidates, pinholed);
        let tally = crate::edge_tunnel::test_allocations::end_thread();
        assert!(changed);
        assert!(!again, "already first: no change to send a manifest for");
        assert_eq!(tally.allocations, 0);
        assert_eq!(
            candidates
                .iter()
                .map(|c| c.addr.as_str())
                .collect::<Vec<_>>(),
            ["203.0.113.5", "2001:db8::2", "2001:db8::1", "192.168.1.10"]
        );
    }

    fn prior_lease(port: u16, expires_in: Duration) -> portmap::PriorLease {
        portmap::PriorLease {
            candidate: AddressCandidate {
                addr: "203.0.113.9".to_string(),
                port,
                kind: CandidateFlavor::NatMap,
            },
            expires_at: Instant::now() + expires_in,
            protocol: portmap::Protocol::Pcp,
        }
    }

    /// The rule the reflexive arm already follows, applied to the lease: **only
    /// a positive finding retracts.**
    ///
    /// A reprobe runs from an ephemeral socket and cannot re-derive a lease it
    /// did not create, so a probe that says nothing about the mapping must
    /// carry it forward. Dropping it instead would change the candidate set on
    /// every network edge, and because the caller sends a new manifest on any
    /// change, churn every attached browser — the exact failure the 2026-08-17
    /// reprobe entry paid for on the reflexive side.
    #[test]
    fn a_live_lease_survives_a_reprobe_that_learned_nothing() {
        let result = build_reprobe_result(
            None,
            Vec::new(),
            Err("all STUN servers failed".to_string()),
            PriorReflexive::default(),
            Some(prior_lease(51_000, Duration::from_secs(600))),
        );
        assert_eq!(
            result
                .candidates
                .iter()
                .filter(|c| c.kind == CandidateFlavor::NatMap)
                .count(),
            1,
            "a failed probe says nothing about the lease and must not retract it"
        );
    }

    /// The one positive finding that does retract: the lease has actually
    /// lapsed. Publishing an expired forward costs the browser's race its full
    /// settle deadline on a candidate the gateway no longer honours.
    #[test]
    fn a_lapsed_lease_is_withheld() {
        let mut lapsed = prior_lease(51_000, Duration::from_secs(1));
        lapsed.expires_at = Instant::now() - Duration::from_secs(1);
        let result = build_reprobe_result(
            None,
            Vec::new(),
            Err("all STUN servers failed".to_string()),
            PriorReflexive::default(),
            Some(lapsed),
        );
        assert!(
            !result
                .candidates
                .iter()
                .any(|c| c.kind == CandidateFlavor::NatMap),
            "an expired lease must not be published"
        );
    }

    /// Two reprobes over an unchanged network must compare equal, or every
    /// reprobe sends a manifest and the lease costs what it was meant to save.
    #[test]
    fn a_carried_lease_reprobes_to_an_equal_candidate_set() {
        let lease = prior_lease(51_000, Duration::from_secs(600));
        let build = || {
            build_reprobe_result(
                None,
                vec![AddressCandidate {
                    addr: "2001:db8::5".to_string(),
                    port: 44_000,
                    kind: CandidateFlavor::Host6,
                }],
                Err("offline STUN test".to_string()),
                PriorReflexive::default(),
                Some(lease.clone()),
            )
        };
        assert_eq!(build().candidates, build().candidates);
    }

    /// The distinction this whole module was rebuilt around: "we never asked"
    /// and "the gateway said no" must not collapse into one value.
    ///
    /// Its predecessor reported three booleans, so a daemon that never
    /// addressed a gateway was indistinguishable from one whose gateway refused
    /// — and thirty days of that ambiguity was read as a verdict on the
    /// protocols, which is what got the stack deleted.
    #[test]
    fn not_attempted_is_distinguishable_from_unsupported() {
        let no_gateway = portmap::Outcome::NotAttempted(portmap::SkipReason::NoGateway);
        let no_path = portmap::Outcome::NotAttempted(portmap::SkipReason::NoEgressPath);
        let refused = portmap::Outcome::Unsupported;

        assert_eq!(no_gateway.metric_key(), "skipped:no_gateway");
        assert_eq!(no_path.metric_key(), "skipped:no_egress_path");
        assert_eq!(refused.metric_key(), "gateway:unsupported");
        assert_ne!(no_gateway.metric_key(), refused.metric_key());
        assert_ne!(no_gateway.metric_key(), no_path.metric_key());
    }

    /// A gateway that grants far less than requested must be renewed on its
    /// terms. A fixed 30-minute timer against an assumed 3600 s lease — the
    /// predecessor's design — lets a 120 s grant lapse twenty-eight times over
    /// before anyone looks.
    #[test]
    fn renewal_follows_the_granted_lifetime_not_the_requested_one() {
        let granted = Duration::from_secs(120);
        assert_eq!(granted / 2, Duration::from_secs(60));
        let hour = Duration::from_secs(3600);
        assert_eq!(hour / 2, Duration::from_secs(1800));
    }
}

#[cfg(test)]
mod expected_browser_tests {
    use super::*;

    const GLOBAL_A: IpAddr = IpAddr::V4(Ipv4Addr::new(203, 0, 113, 7));
    const GLOBAL_B: IpAddr = IpAddr::V4(Ipv4Addr::new(198, 51, 100, 9));

    #[test]
    fn an_offered_address_is_expected_and_an_unoffered_one_is_not() {
        let now = Instant::now();
        let mut ring = ExpectedBrowserRing::new();
        ring.record(GLOBAL_A, now);

        assert!(ring.holds(GLOBAL_A, now));
        assert!(
            !ring.holds(GLOBAL_B, now),
            "an address no offer named must not read as expected"
        );
    }

    #[test]
    fn an_entry_older_than_the_ttl_stops_counting() {
        let recorded = Instant::now();
        let mut ring = ExpectedBrowserRing::new();
        ring.record(GLOBAL_A, recorded);

        assert!(ring.holds(
            GLOBAL_A,
            recorded + EXPECTED_BROWSER_TTL - Duration::from_millis(1)
        ));
        assert!(!ring.holds(GLOBAL_A, recorded + EXPECTED_BROWSER_TTL));
    }

    /// The regression the in-place refresh exists for. A browser that takes
    /// several manifests must not consume a slot per manifest, or one reconnecting
    /// peer evicts every other peer inside a single TTL window and their
    /// arrivals are miscounted as internet scanning.
    #[test]
    fn repeated_offers_to_one_browser_do_not_evict_the_others() {
        let now = Instant::now();
        let mut ring = ExpectedBrowserRing::new();
        ring.record(GLOBAL_B, now);
        for _ in 0..(EXPECTED_BROWSER_CAPACITY * 2) {
            ring.record(GLOBAL_A, now);
        }

        assert!(ring.holds(GLOBAL_B, now));
        assert!(ring.holds(GLOBAL_A, now));
    }

    #[test]
    fn the_ring_evicts_oldest_first_and_never_grows() {
        let now = Instant::now();
        let mut ring = ExpectedBrowserRing::new();
        for index in 0..(EXPECTED_BROWSER_CAPACITY + 1) {
            let octet = u8::try_from(index).expect("fits");
            ring.record(IpAddr::V4(Ipv4Addr::new(203, 0, 113, octet)), now);
        }

        assert_eq!(ring.entries.len(), EXPECTED_BROWSER_CAPACITY);
        assert!(
            !ring.holds(IpAddr::V4(Ipv4Addr::new(203, 0, 113, 0)), now),
            "the first address recorded must be the first evicted"
        );
        let last = u8::try_from(EXPECTED_BROWSER_CAPACITY).expect("fits");
        assert!(ring.holds(IpAddr::V4(Ipv4Addr::new(203, 0, 113, last)), now));
    }

    /// A same-NAT browser dials a `host4`/`host6` candidate from a LAN address
    /// no offer ever named, because offers carry the browser's *public* address.
    /// Counting that as scanning would report a filtering verdict for the one
    /// topology where the direct path works best. Internet background scanning
    /// arrives from global addresses by construction, so a non-global source is
    /// a positive proof rather than a fallback.
    #[test]
    fn an_on_link_source_is_expected_without_ever_having_been_offered() {
        assert!(inbound_is_expected(IpAddr::V4(Ipv4Addr::new(
            192, 168, 1, 40
        ))));
        assert!(inbound_is_expected(IpAddr::V4(Ipv4Addr::new(
            100, 64, 0, 3
        ))));
        assert!(inbound_is_expected(IpAddr::V6(Ipv6Addr::new(
            0xfd00, 0, 0, 0, 0, 0, 0, 1
        ))));
        assert!(
            !inbound_is_expected(GLOBAL_B),
            "an unoffered global source is exactly the scanning case"
        );
    }
}

#[cfg(test)]
mod reprobe_tests {
    use super::*;

    const WT_PORT: u16 = 44300;

    fn srflx(addr: &str, port: u16) -> AddressCandidate {
        AddressCandidate {
            addr: addr.into(),
            port,
            kind: CandidateFlavor::Srflx,
        }
    }

    fn host(addr: &str) -> AddressCandidate {
        AddressCandidate {
            addr: addr.into(),
            port: WT_PORT,
            kind: CandidateFlavor::Host4,
        }
    }

    /// Prior state for a daemon that published a working reflexive candidate on
    /// a NAT that did not preserve the port — external 51000, internal 44300.
    fn prior_with_stable_mapping() -> PriorReflexive {
        PriorReflexive {
            srflx: Some(srflx("203.0.113.5", 51_000)),
            nat_signature: pairing::NatSignature {
                public_ip: Some("203.0.113.5".to_string()),
                nat_type: pairing::NatTypeLabel::EndpointIndependent,
                hairpin: false,
            },
            nat_mapping: stun::NatMapping::EndpointIndependent,
            daemon_srflx: Some("203.0.113.5".parse().unwrap()),
            pinholed_v6: None,
            stun_local_ip: None,
        }
    }

    fn probe(
        public: &str,
        allocation: stun::PortAllocation,
        mapping: stun::NatMapping,
        filtering: stun::NatFiltering,
    ) -> stun::StunResult {
        stun::StunResult {
            local_port: 0,
            public_addr: public.parse().unwrap(),
            nat_mapping: mapping,
            port_allocation: allocation,
            nat_filtering: filtering,
            hairpin: false,
            local_ip: None,
        }
    }

    #[test]
    fn a_live_observation_replaces_both_the_old_port_and_old_address() {
        for public in ["203.0.113.5:60001", "198.51.100.7:60002"] {
            for allocation in [
                stun::PortAllocation::Preserved,
                stun::PortAllocation::Stable,
                stun::PortAllocation::Unknown,
            ] {
                let result = build_reprobe_result(
                    None,
                    vec![host("192.168.1.10")],
                    Ok(probe(
                        public,
                        allocation,
                        stun::NatMapping::EndpointIndependent,
                        stun::NatFiltering::Unknown,
                    )),
                    prior_with_stable_mapping(),
                    None,
                );
                let addr: std::net::SocketAddr = public.parse().unwrap();
                assert_eq!(
                    result.candidates[0],
                    srflx(&addr.ip().to_string(), addr.port())
                );
                assert_eq!(result.candidates[1], host("192.168.1.10"));
                assert_eq!(result.daemon_srflx, Some(addr.ip()));
            }
        }
    }

    #[test]
    fn destination_dependent_mapping_retracts_a_retained_candidate() {
        let result = build_reprobe_result(
            None,
            Vec::new(),
            Ok(probe(
                "203.0.113.5:60001",
                stun::PortAllocation::Stable,
                stun::NatMapping::EndpointDependent,
                stun::NatFiltering::Unknown,
            )),
            prior_with_stable_mapping(),
            None,
        );
        assert!(result.candidates.is_empty());
    }

    /// A probe that never answered says nothing about the NAT. Erasing the
    /// signature here is what made one lost datagram send a manifest to every
    /// attached browser, because the caller sends one on any change.
    #[test]
    fn a_failed_probe_changes_nothing_the_caller_would_reoffer_on() {
        let prior = prior_with_stable_mapping();
        let result = build_reprobe_result(
            None,
            vec![host("192.168.1.10")],
            Err("all STUN servers failed".to_string()),
            prior.clone(),
            None,
        );
        assert_eq!(result.daemon_srflx, prior.daemon_srflx);
        assert_eq!(result.nat_mapping, prior.nat_mapping);
        assert_eq!(result.nat_signature, prior.nat_signature);
        assert_eq!(
            result
                .candidates
                .iter()
                .find(|c| c.kind == CandidateFlavor::Srflx),
            prior.srflx.as_ref(),
        );
    }

    /// A daemon that never had a reflexive candidate must not invent one, and a
    /// failed probe on that daemon stays honestly unknown.
    #[test]
    fn a_failed_probe_without_prior_evidence_stays_unknown() {
        let result = build_reprobe_result(
            None,
            vec![host("192.168.1.10")],
            Err("no STUN credential yet".to_string()),
            PriorReflexive::default(),
            None,
        );
        assert_eq!(result.nat_mapping, stun::NatMapping::Unknown);
        assert_eq!(result.daemon_srflx, None);
        assert_eq!(result.candidates, vec![host("192.168.1.10")]);
    }
}

/// Explicit owner for the endpoint accept loop.
///
/// A certificate rotation replaces the routing state, so old sessions cannot
/// remain useful: outbound sends would target the new state. `shutdown` closes
/// those sessions intentionally and joins the accept task before the old server
/// owner is discarded.
pub struct WebTransportServer {
    shutdown_tx: Option<oneshot::Sender<()>>,
    task: Option<JoinHandle<Vec<RetiredWebTransportConnection>>>,
    /// Shared with the accept loop purely so the TLS config can be swapped in
    /// place. `Endpoint` is not `Clone` and `accept()` only needs `&self`, so an
    /// `Arc` is what lets the owner keep a handle without a second socket.
    endpoint: Arc<Endpoint<wtransport::endpoint::endpoint_side::Server>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RetiredWebTransportConnection {
    pub temp_peer_id: String,
    pub registry_peer_id: String,
    pub connection_id: u64,
}

impl WebTransportServer {
    pub fn spawn(
        endpoint: Endpoint<wtransport::endpoint::endpoint_side::Server>,
        state: Arc<RwLock<WebTransportState>>,
        message_tx: mpsc::Sender<PeerMessage>,
        peer_event_tx: mpsc::Sender<PeerEvent>,
    ) -> Self {
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        let endpoint = Arc::new(endpoint);
        let task = tokio::spawn(accept_loop(
            Arc::clone(&endpoint),
            state,
            message_tx,
            peer_event_tx,
            shutdown_rx,
        ));
        Self {
            shutdown_tx: Some(shutdown_tx),
            task: Some(task),
            endpoint,
        }
    }

    /// Swap the TLS configuration on the live socket.
    ///
    /// `rebind: false` keeps the existing UDP socket, so the pinned port is
    /// never released, no candidate moves, no NAT lease is re-acquired, and
    /// established connections keep the identity they negotiated. Only
    /// connections opened after this point see the new certificate hash, which
    /// is why the caller sends a new manifest.
    pub fn reload_certificate(&self, config: ServerConfig) -> std::io::Result<()> {
        self.endpoint.reload_config(config, false)
    }

    pub async fn shutdown(&mut self) -> Vec<RetiredWebTransportConnection> {
        if let Some(shutdown_tx) = self.shutdown_tx.take() {
            let _ = shutdown_tx.send(());
        }
        if let Some(task) = self.task.take() {
            match task.await {
                Ok(retired) => return retired,
                Err(error) => {
                    if !error.is_cancelled() {
                        warn!("WebTransport accept loop failed during shutdown: {error}");
                    }
                }
            }
        }
        Vec::new()
    }
}

impl Drop for WebTransportServer {
    fn drop(&mut self) {
        if let Some(shutdown_tx) = self.shutdown_tx.take() {
            let _ = shutdown_tx.send(());
        }
        if let Some(task) = self.task.take() {
            // The normal owner path calls and awaits `shutdown`. This fallback
            // still prevents a forgotten owner from orphaning an accept loop.
            task.abort();
        }
    }
}

pub async fn replace_server(
    current: &mut Option<WebTransportServer>,
    replacement: WebTransportServer,
) -> Vec<RetiredWebTransportConnection> {
    if let Some(mut previous) = current.replace(replacement) {
        previous.shutdown().await
    } else {
        Vec::new()
    }
}

async fn accept_loop(
    endpoint: Arc<Endpoint<wtransport::endpoint::endpoint_side::Server>>,
    state: Arc<RwLock<WebTransportState>>,
    message_tx: mpsc::Sender<PeerMessage>,
    peer_event_tx: mpsc::Sender<PeerEvent>,
    mut shutdown_rx: oneshot::Receiver<()>,
) -> Vec<RetiredWebTransportConnection> {
    let discovery_socket = state.read().await.discovery_socket.clone();
    let session_slots = Arc::new(Semaphore::new(MAX_CONCURRENT_SESSIONS));
    let mut session_tasks = tokio::task::JoinSet::new();

    loop {
        let incoming = tokio::select! {
            biased;
            _ = &mut shutdown_rx => {
                endpoint.close(
                    wtransport::VarInt::from_u32(0),
                    b"daemon-webtransport-server-replaced",
                );
                session_tasks.shutdown().await;
                return retire_state_connections(&state).await;
            }
            incoming = endpoint.accept() => incoming,
            completed = session_tasks.join_next(), if !session_tasks.is_empty() => {
                if let Some(Err(error)) = completed {
                    warn!("WebTransport session supervisor task failed: {error}");
                }
                continue;
            }
        };

        // Counted before the capacity check so the number means "reached the
        // listener", not "was accepted" — a daemon rejecting every connection
        // must not look identical to one nothing can reach.
        //
        // `remote_address` is read off the QUIC Initial without awaiting the
        // session, so an unexpected connection costs one ring scan and is then
        // handled exactly as before.
        if let Some(socket) = &discovery_socket {
            socket.record_discovery_contact(incoming.remote_address());
        }
        if inbound_is_expected(incoming.remote_address().ip()) {
            DIRECT_WT_INCOMING_EXPECTED.fetch_add(1, Ordering::Relaxed);
        } else {
            DIRECT_WT_INCOMING_UNEXPECTED.fetch_add(1, Ordering::Relaxed);
        }

        let Some(session_slot) = try_reserve_session_slot(&session_slots) else {
            // Reject before spawning: at most MAX_CONCURRENT_SESSIONS session
            // supervisors can exist even under a public UDP connection flood.
            incoming.refuse();
            let rejected = OVER_CAPACITY_SESSION_REJECTIONS
                .fetch_add(1, Ordering::Relaxed)
                .wrapping_add(1);
            if rejected == 1 || rejected.is_power_of_two() {
                warn!(
                    rejected,
                    max_sessions = MAX_CONCURRENT_SESSIONS,
                    "rejecting WebTransport connection because session capacity is full"
                );
            }
            continue;
        };

        let state = state.clone();
        let message_tx = message_tx.clone();
        let peer_event_tx = peer_event_tx.clone();

        session_tasks.spawn(async move {
            let _session_slot = session_slot;
            let connection = match tokio::time::timeout(
                Duration::from_millis(SESSION_SETUP_TIMEOUT_MS),
                async move {
                    let session_request = incoming.await?;
                    session_request.accept().await
                },
            )
            .await
            {
                Ok(Ok(connection)) => connection,
                Ok(Err(error)) => {
                    warn!("WebTransport session setup failed: {error}");
                    return;
                }
                Err(_) => {
                    warn!("WebTransport session setup timed out");
                    return;
                }
            };

            let connection = Arc::new(connection);
            let _close_connection = CloseConnectionOnDrop(Arc::clone(&connection));
            info!("WebTransport session accepted");

            let conn_id = next_connection_id();
            let temp_peer_id = format!("wt-pending-{conn_id}");

            let accept_futs: Vec<_> = REQUIRED_CHANNELS
                .iter()
                .map(|_| {
                    let conn = connection.clone();
                    async move {
                        let (send_stream, mut recv_stream) = conn.accept_bi().await?;
                        let mut channel_buf = [0u8; 1];
                        recv_stream
                            .read_exact(&mut channel_buf)
                            .await
                            .map_err(|_| wtransport::error::ConnectionError::LocallyClosed)?;
                        Ok::<_, wtransport::error::ConnectionError>((
                            channel_buf[0],
                            send_stream,
                            recv_stream,
                        ))
                    }
                })
                .collect();

            let accept_results = match tokio::time::timeout(
                Duration::from_millis(CHANNEL_BIND_TIMEOUT_MS),
                futures::future::try_join_all(accept_futs),
            )
            .await
            {
                Ok(Ok(results)) => results,
                Ok(Err(error)) => {
                    warn!("WebTransport channel stream accept failed: {error}");
                    return;
                }
                Err(_) => {
                    warn!("WebTransport channel binding timed out");
                    return;
                }
            };

            let mut accepted = Vec::with_capacity(REQUIRED_CHANNELS.len());
            let mut seen_channels = Vec::with_capacity(REQUIRED_CHANNELS.len());
            let mut ctrl_sender = None;
            let mut pty_sender = None;
            let mut display_commit_sender = None;

            for (channel_id, send_stream, recv_stream) in accept_results {
                if !REQUIRED_CHANNELS.contains(&channel_id) || seen_channels.contains(&channel_id) {
                    warn!("WebTransport invalid channel preface: {channel_id}");
                    return;
                }
                seen_channels.push(channel_id);

                let (send_tx, send_rx) = mpsc::channel::<ReliablePayload>(64);
                match channel_id {
                    CHANNEL_CTRL => ctrl_sender = Some(send_tx.clone()),
                    CHANNEL_PTY => pty_sender = Some(send_tx.clone()),
                    CHANNEL_DISPLAY_COMMIT => display_commit_sender = Some(send_tx.clone()),
                    _ => unreachable!(),
                }
                accepted.push((channel_id, send_stream, recv_stream, send_rx));
            }

            let senders = match (ctrl_sender, pty_sender, display_commit_sender) {
                (Some(ctrl), Some(pty), Some(display_commit)) => ChannelSenders {
                    ctrl,
                    pty,
                    display_commit,
                    signaling: None,
                },
                _ => {
                    warn!("WebTransport missing required channel stream");
                    return;
                }
            };

            let (upgrade_completed_tx, mut upgrade_completed_rx) = oneshot::channel();
            {
                let mut s = state.write().await;
                s.lifecycle_peers.insert(conn_id, temp_peer_id.clone());
                s.pending_upgrade_deadlines
                    .insert(conn_id, upgrade_completed_tx);
                s.peer_connections.insert(
                    temp_peer_id.clone(),
                    ChannelPeerConnection {
                        senders,
                        connection_id: conn_id,
                    },
                );
                s.sessions.insert(temp_peer_id.clone(), connection.clone());
            }
            // Display held for this direct path resumes on the acknowledgment
            // that reopens it. The watcher holds no connection handle and ends
            // with the connection's state.
            let mut blocked = connection.quic_connection().send_blocked();
            tokio::spawn(async move {
                while blocked.changed().await.is_ok() {
                    if !*blocked.borrow_and_update() {
                        crate::display::send::CARRIER_UNBLOCKED.notify_one();
                    }
                }
            });

            // Arm at the bind commit, not after the lifecycle event reaches the
            // run loop. A saturated event queue must not turn a silent public
            // session into an unbounded admission-slot owner.
            let upgrade_deadline =
                tokio::time::sleep(Duration::from_millis(POST_BIND_UPGRADE_TIMEOUT_MS));
            tokio::pin!(upgrade_deadline);
            let session_event = peer_event_tx.send(PeerEvent::WebTransportSession {
                temp_peer_id: temp_peer_id.clone(),
                connection_id: conn_id,
            });
            tokio::pin!(session_event);
            tokio::select! {
                result = &mut session_event => {
                    if result.is_err() {
                        remove_session_if_current(&state, &temp_peer_id, conn_id).await;
                        remove_lifecycle_peer(&state, conn_id).await;
                        return;
                    }
                }
                _ = &mut upgrade_deadline => {
                    if claim_pending_upgrade_expiry(&state, &temp_peer_id, conn_id).await {
                        warn!(
                            connection_id = conn_id,
                            "WebTransport post-bind upgrade timed out before lifecycle handoff"
                        );
                    }
                    remove_lifecycle_peer(&state, conn_id).await;
                    return;
                }
            }

            let mut handles = Vec::with_capacity(REQUIRED_CHANNELS.len() * 2 + 1);
            for (channel_id, send_stream, recv_stream, send_rx) in accepted {
                handles.push(spawn_channel_recv_task(
                    recv_stream,
                    Arc::from(temp_peer_id.as_str()),
                    channel_id,
                    conn_id,
                    crate::connection::PeerTransport::WebTransport,
                    message_tx.clone(),
                ));
                handles.push(spawn_send_task(send_stream, send_rx));
            }

            let datagram_connection = connection.clone();
            let datagram_event_tx = peer_event_tx.clone();
            let datagram_peer_id: Arc<str> = Arc::from(temp_peer_id.as_str());
            handles.push(tokio::spawn(async move {
                while let Ok(dgram) = datagram_connection.receive_datagram().await {
                    let data = dgram.payload();
                    if data.is_empty() {
                        continue;
                    }
                    match try_enqueue_datagram(
                        &datagram_event_tx,
                        PeerEvent::Datagram {
                            peer_id: datagram_peer_id.clone(),
                            connection_id: conn_id,
                            data,
                            via_transport: crate::connection::PeerTransport::WebTransport,
                        },
                        &INBOUND_DATAGRAM_QUEUE_DROPS,
                        "direct_webtransport",
                    ) {
                        DatagramEnqueueResult::Enqueued | DatagramEnqueueResult::DroppedFull => {}
                        DatagramEnqueueResult::Closed => break,
                    }
                }
            }));

            // Keep ownership of every child handle in this supervisor. The old
            // unbounded close fan-in was numerically capped at six producers,
            // but its wrapper tasks detached the remaining stream/datagram
            // workers after the first child exited.
            let initial_close_reason = {
                let first_child = join_next_session_task(&mut handles);
                tokio::pin!(first_child);
                tokio::select! {
                    first = &mut first_child => {
                        Some(match first {
                            Ok(()) => "webtransport channel task closed".to_string(),
                            Err(error) => format!("webtransport channel task failed: {error}"),
                        })
                    }
                    error = connection.closed() => {
                        Some(format!("webtransport-closed: {error}"))
                    }
                    result = &mut upgrade_completed_rx => {
                        if result.is_err() {
                            warn!(
                                connection_id = conn_id,
                                "WebTransport post-bind upgrade signal owner disappeared"
                            );
                        }
                        None
                    }
                    _ = &mut upgrade_deadline => {
                        if claim_pending_upgrade_expiry(&state, &temp_peer_id, conn_id).await {
                            Some("webtransport post-bind upgrade timed out".to_string())
                        } else {
                            // A successful exact-id upgrade won the state lock
                            // at the same instant as the timer. Its replacement
                            // routing owner must remain live.
                            None
                        }
                    }
                }
            };
            let close_reason = match initial_close_reason {
                Some(reason) => reason,
                None => {
                    let first_child = join_next_session_task(&mut handles);
                    tokio::pin!(first_child);
                    tokio::select! {
                        first = &mut first_child => {
                            match first {
                                Ok(()) => "webtransport channel task closed".to_string(),
                                Err(error) => format!("webtransport channel task failed: {error}"),
                            }
                        }
                        error = connection.closed() => {
                            format!("webtransport-closed: {error}")
                        }
                    }
                }
            };

            connection.close(
                wtransport::VarInt::from_u32(0),
                b"daemon-session-child-ended",
            );
            abort_and_join_session_tasks(&mut handles).await;
            remove_session_if_current(&state, &temp_peer_id, conn_id).await;

            let _ = peer_event_tx
                .send(PeerEvent::Disconnected {
                    peer_id: temp_peer_id,
                    connection_id: conn_id,
                    reason: close_reason,
                })
                .await;
            // Remove only after the event send resolves. A completed send has
            // transferred lifecycle ownership to the run-loop queue; if
            // rotation aborts before this line, the server-level retirement
            // drain returns the same exact id and duplicate cleanup is harmless.
            remove_lifecycle_peer(&state, conn_id).await;
        });
    }
}

async fn retire_state_connections(
    state: &Arc<RwLock<WebTransportState>>,
) -> Vec<RetiredWebTransportConnection> {
    let (mut registry_connection_ids, lifecycle_peers, sessions) = {
        let mut state = state.write().await;
        state.pending_upgrade_deadlines.clear();
        let registry_connection_ids = state
            .peer_connections
            .drain()
            .map(|(peer_id, connection)| (connection.connection_id, peer_id))
            .collect::<HashMap<_, _>>();
        let lifecycle_peers = state.lifecycle_peers.drain().collect::<Vec<_>>();
        let sessions = state
            .sessions
            .drain()
            .map(|(_, session)| session)
            .collect::<Vec<_>>();
        (registry_connection_ids, lifecycle_peers, sessions)
    };

    // Close after releasing the registry lock. Endpoint shutdown normally
    // closed these already; this is an idempotent wake for any retained Arc.
    for session in sessions {
        session.close(
            wtransport::VarInt::from_u32(0),
            b"daemon-webtransport-server-retired",
        );
    }

    let mut retired = lifecycle_peers
        .into_iter()
        .map(
            |(connection_id, temp_peer_id)| RetiredWebTransportConnection {
                registry_peer_id: registry_connection_ids
                    .remove(&connection_id)
                    .unwrap_or_else(|| temp_peer_id.clone()),
                temp_peer_id,
                connection_id,
            },
        )
        .collect::<Vec<_>>();
    // Defensive union for a future insertion path that publishes routing
    // before registering its supervisor. Production maintains both maps under
    // one lock, but returning the routing owner is safer than silently losing it.
    retired.extend(
        registry_connection_ids
            .into_iter()
            .map(
                |(connection_id, registry_peer_id)| RetiredWebTransportConnection {
                    temp_peer_id: registry_peer_id.clone(),
                    registry_peer_id,
                    connection_id,
                },
            ),
    );
    debug_assert!(
        retired.len() <= MAX_CONCURRENT_SESSIONS,
        "retirement handoff exceeded the session admission bound"
    );
    retired
}

async fn remove_lifecycle_peer(state: &Arc<RwLock<WebTransportState>>, connection_id: u64) {
    state.write().await.lifecycle_peers.remove(&connection_id);
}

async fn abort_and_join_session_tasks(tasks: &mut Vec<JoinHandle<()>>) {
    for task in tasks.iter() {
        task.abort();
    }
    while let Some(task) = tasks.pop() {
        if let Err(error) = task.await
            && !error.is_cancelled()
        {
            warn!("WebTransport child task failed during cleanup: {error}");
        }
    }
}

/// Join and remove exactly one completed child.
///
/// A Tokio `JoinHandle` panics if it is polled after returning `Ready`. The
/// session supervisor subsequently aborts and joins every remaining child, so
/// the winner must leave the ownership vector before that cleanup (and before a
/// second post-upgrade wait) can observe it.
async fn join_next_session_task(
    tasks: &mut Vec<JoinHandle<()>>,
) -> Result<(), tokio::task::JoinError> {
    debug_assert!(!tasks.is_empty());
    let (result, completed_index, remaining) = futures::future::select_all(tasks.iter_mut()).await;
    drop(remaining);
    let completed = tasks.swap_remove(completed_index);
    debug_assert!(completed.is_finished());
    drop(completed);
    result
}

async fn remove_session_if_current(
    state: &Arc<RwLock<WebTransportState>>,
    peer_id: &str,
    connection_id: u64,
) {
    let mut state = state.write().await;
    state.pending_upgrade_deadlines.remove(&connection_id);
    let is_current = state
        .peer_connections
        .get(peer_id)
        .is_some_and(|connection| connection.connection_id == connection_id);
    if is_current {
        state.peer_connections.remove(peer_id);
        state.sessions.remove(peer_id);
    }
}

/// Atomically linearize a post-bind deadline against `upgrade_peer`.
///
/// Returning `true` means the deadline still owned this exact temp-id
/// generation and removed it from routing. Returning `false` means a successful
/// upgrade or a newer generation already won; the caller must not close the
/// connection as a timeout.
async fn claim_pending_upgrade_expiry(
    state: &Arc<RwLock<WebTransportState>>,
    temp_peer_id: &str,
    connection_id: u64,
) -> bool {
    let mut state = state.write().await;
    if state
        .pending_upgrade_deadlines
        .remove(&connection_id)
        .is_none()
    {
        return false;
    }
    let is_current = state
        .peer_connections
        .get(temp_peer_id)
        .is_some_and(|connection| connection.connection_id == connection_id);
    if !is_current {
        return false;
    }
    state.peer_connections.remove(temp_peer_id);
    state.sessions.remove(temp_peer_id);
    true
}

/// Fire-and-forget reliable send of an owned heap record to a session found
/// by id. Only the upgrade handshake uses it, for replies to a session that is
/// not yet the peer's own; every peer-level direct send admits through the
/// peer's `DirectSession`.
pub async fn send_to_peer(
    state: &Arc<RwLock<WebTransportState>>,
    peer_id: &str,
    channel_id: u8,
    payload: Vec<u8>,
) -> bool {
    let state = registry_read(state).await;
    state
        .peer_connections
        .get(peer_id)
        .and_then(|connection| select_channel_sender(&connection.senders, channel_id))
        .is_some_and(|sender| sender.try_send(ReliablePayload::Heap(payload)).is_ok())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UpgradePeerOutcome {
    Added,
    Replaced,
}

/// Move a proven temp-id session under its real peer id. Returns the session
/// now routed there, which the owner installs as the peer's direct carrier in
/// the same turn.
pub async fn upgrade_peer(
    state: &Arc<RwLock<WebTransportState>>,
    temp_peer_id: &str,
    real_peer_id: &str,
) -> Option<(UpgradePeerOutcome, DirectSession)> {
    if temp_peer_id == real_peer_id {
        let (upgrade_completed, session) = {
            let mut state = state.write().await;
            let connection = state.peer_connections.get(real_peer_id);
            let connection_id = connection.map(|connection| connection.connection_id);
            let senders = connection.map(|connection| connection.senders.clone());
            let session = state.sessions.get(real_peer_id).cloned();
            (
                connection_id.and_then(|id| state.pending_upgrade_deadlines.remove(&id)),
                session.zip(senders),
            )
        };
        if let Some(upgrade_completed) = upgrade_completed {
            let _ = upgrade_completed.send(());
            return session.map(|(session, senders)| {
                (
                    UpgradePeerOutcome::Added,
                    DirectSession::new(session, senders),
                )
            });
        }
        let state = state.read().await;
        let senders = state.peer_connections.get(real_peer_id)?.senders.clone();
        return state.sessions.get(real_peer_id).map(|session| {
            (
                UpgradePeerOutcome::Added,
                DirectSession::new(Arc::clone(session), senders),
            )
        });
    }

    let displaced = {
        let mut state = state.write().await;
        let (connection, session) = match (
            state.peer_connections.remove(temp_peer_id),
            state.sessions.remove(temp_peer_id),
        ) {
            (Some(connection), Some(session)) => (connection, session),
            (connection, session) => {
                // Preserve a partial registry entry for its session supervisor
                // to retire; never overwrite a healthy real-id entry with half
                // a lane.
                if let Some(connection) = connection {
                    state
                        .peer_connections
                        .insert(temp_peer_id.to_string(), connection);
                }
                if let Some(session) = session {
                    state.sessions.insert(temp_peer_id.to_string(), session);
                }
                return None;
            }
        };
        let upgrade_completed = state
            .pending_upgrade_deadlines
            .remove(&connection.connection_id);

        let routed = DirectSession::new(Arc::clone(&session), connection.senders.clone());
        let displaced_connection = state
            .peer_connections
            .insert(real_peer_id.to_string(), connection);
        let displaced_session = state.sessions.insert(real_peer_id.to_string(), session);
        (
            displaced_connection,
            displaced_session,
            upgrade_completed,
            routed,
        )
    };

    let outcome = if displaced.0.is_some() || displaced.1.is_some() {
        UpgradePeerOutcome::Replaced
    } else {
        UpgradePeerOutcome::Added
    };
    if let Some(upgrade_completed) = displaced.2 {
        let _ = upgrade_completed.send(());
    }
    // Inserting B under the real id atomically removes A from routing. Explicitly
    // close A outside the lock so its stream/datagram supervisors wake promptly
    // and cannot retain an invisible session Arc.
    drop(displaced.0);
    if let Some(session) = displaced.1 {
        session.close(
            wtransport::VarInt::from_u32(0),
            b"daemon-webtransport-session-replaced",
        );
    }
    Some((outcome, displaced.3))
}

pub async fn is_current_connection(
    state: &Arc<RwLock<WebTransportState>>,
    peer_id: &str,
    connection_id: u64,
) -> bool {
    registry_read(state)
        .await
        .peer_connections
        .get(peer_id)
        .is_some_and(|connection| connection.connection_id == connection_id)
}

/// Remove a peer only when the lifecycle event belongs to its current direct-WT
/// generation. Returns false for a delayed close from a displaced session.
pub async fn remove_peer_if_current(
    state: &Arc<RwLock<WebTransportState>>,
    peer_id: &str,
    connection_id: u64,
) -> bool {
    let session = {
        let mut state = state.write().await;
        let is_current = state
            .peer_connections
            .get(peer_id)
            .is_some_and(|connection| connection.connection_id == connection_id);
        if !is_current {
            return false;
        }
        state.pending_upgrade_deadlines.remove(&connection_id);
        state.peer_connections.remove(peer_id);
        state.sessions.remove(peer_id)
    };
    if let Some(session) = session {
        session.close(
            wtransport::VarInt::from_u32(0),
            b"daemon-peer-current-ownership-ended",
        );
    }
    true
}

pub async fn remove_peer(state: &Arc<RwLock<WebTransportState>>, peer_id: &str) {
    let session = {
        let mut state = state.write().await;
        if let Some(connection_id) = state
            .peer_connections
            .get(peer_id)
            .map(|connection| connection.connection_id)
        {
            state.pending_upgrade_deadlines.remove(&connection_id);
        }
        state.peer_connections.remove(peer_id);
        state.sessions.remove(peer_id)
    };
    // Stream/datagram tasks can retain connection Arcs after both registry
    // entries are gone. Close outside the state lock so every child wakes and
    // exits without holding the owner-visible routing lock across transport I/O.
    if let Some(session) = session {
        session.close(
            wtransport::VarInt::from_u32(0),
            b"daemon-peer-ownership-ended",
        );
    }
}

/// Whether a declared port mapping supersedes the STUN reflexive candidate.
///
/// Pure so it is testable without a socket, in the same spirit as
/// `should_burst_redraw`.
///
/// Same address family is the whole condition. A declared IPv4 mapping says
/// nothing about how the daemon is reached over IPv6 and must not suppress a
/// v6 reflexive candidate, and the reverse likewise — but within one family the
/// declared mapping is authoritative and the reflexive guess is not merely
/// redundant, it is usually wrong. On a host that source-NATs its containers
/// the daemon's egress is masqueraded to an arbitrary port while inbound
/// arrives on the forwarded one, so STUN reports a port nothing forwards. That
/// candidate is dropped rather than refused, which costs the browser its whole
/// race deadline.
pub(crate) fn srflx_superseded_by_declared(
    declared: Option<std::net::SocketAddr>,
    srflx: std::net::SocketAddr,
) -> bool {
    declared.is_some_and(|declared| declared.is_ipv4() == srflx.is_ipv4())
}

/// Host candidates advertised per address family.
///
/// Every candidate the daemon emits costs the browser a concurrent QUIC
/// handshake, and its race only finalizes once *every* attempt settles — a
/// candidate that is silently dropped rather than refused, which is exactly how
/// a stateful firewall treats unsolicited inbound, holds the race to its full
/// deadline. Meanwhile a host with SLAAC privacy extensions plus a container
/// bridge, a VPN, and a mesh overlay enumerates a dozen addresses of which at
/// most one is dialable. Rank them and keep the best few rather than shipping
/// the whole interface table.
const MAX_HOST_CANDIDATES_PER_FAMILY: usize = 3;

/// Preference within a family, lowest first.
///
/// A globally routable address the gateway holds a pinhole for beats
/// everything: it needs no traversal AND no punch landing in time. Then any
/// other globally routable address, which needs no traversal at all. A stable
/// SLAAC address beats a temporary one because the temporary address rotates
/// out from under any cached path the browser holds, and a deprecated address
/// is on its way out entirely. Same-link-only classes rank last but are not
/// dropped — they are the whole answer for a browser sharing the LAN.
fn host6_rank(class: AddressClass, temporary: bool, deprecated: bool, pinholed: bool) -> u8 {
    match class {
        AddressClass::Ipv6Global if pinholed => 0,
        AddressClass::Ipv6Global if !temporary && !deprecated => 1,
        AddressClass::Ipv6Global if !deprecated => 2,
        AddressClass::Ipv6Global => 3,
        AddressClass::Ipv6UniqueLocal if !deprecated => 4,
        _ => 5,
    }
}

fn host4_rank(class: AddressClass) -> u8 {
    match class {
        AddressClass::Ipv4Global => 0,
        AddressClass::Ipv4Cgnat => 1,
        _ => 2,
    }
}

/// Identify secondary bridge interfaces for candidate ranking. A bridge can
/// also be the primary LAN or hold globally reachable addresses, so its type
/// alone never excludes it. Linux exposes bridge masters through sysfs.
fn is_bridge_master(iface: &netdev::Interface) -> bool {
    if iface.if_type == netdev::interface::types::InterfaceType::Bridge {
        return true;
    }
    #[cfg(target_os = "linux")]
    {
        let mut path = String::with_capacity("/sys/class/net/".len() + iface.name.len() + 7);
        path.push_str("/sys/class/net/");
        path.push_str(&iface.name);
        path.push_str("/bridge");
        std::path::Path::new(&path).is_dir()
    }
    #[cfg(not(target_os = "linux"))]
    false
}

/// Collect routable host candidates from network interfaces, best first and
/// bounded per family. Every browser's manifest carries them, except a browser
/// on this host, which gets loopback instead (`pairing::manifest_candidates`).
///
/// `pinholed` is the global IPv6 address the gateway currently holds a firewall
/// pinhole for, when a `portmap` v6 lease is live; it ranks first in its family.
///
/// Order is deterministic and meaningful: the browser races in the order the
/// daemon emits, because the daemon knows the address class and the browser
/// only sees an opaque `kind`.
fn collect_local_candidates(port: u16, pinholed: Option<Ipv6Addr>) -> Vec<AddressCandidate> {
    let interfaces = netdev::get_interfaces();
    if interfaces.is_empty() {
        warn!("netdev: no interfaces found; emitting empty host-candidate list");
        return Vec::new();
    }
    rank_interface_candidates(&interfaces, port, pinholed)
}

/// The pure half of `collect_local_candidates`, over an interface list the
/// caller enumerated — so the ranking and exclusion rules are testable against
/// a fake host rather than whichever machine runs the suite.
fn rank_interface_candidates(
    interfaces: &[netdev::Interface],
    port: u16,
    pinholed: Option<Ipv6Addr>,
) -> Vec<AddressCandidate> {
    let mut host6: Vec<(u8, AddressCandidate)> = Vec::new();
    let mut host4: Vec<(u8, AddressCandidate)> = Vec::new();

    for iface in interfaces {
        if iface.is_loopback() {
            continue;
        }

        for (index, net) in iface.ipv6.iter().enumerate() {
            let addr = net.addr();
            let class = classify_ipv6(&addr);
            if matches!(class, AddressClass::NonRoutable | AddressClass::Loopback) {
                continue;
            }
            // Flags are index-aligned with `ipv6`, but the vector is empty on
            // platforms that do not report them; absent flags mean "assume the
            // address is stable", which only ever ranks it higher.
            let flags = iface.ipv6_addr_flags.get(index);
            let temporary = flags.is_some_and(|f| f.temporary);
            let deprecated = flags.is_some_and(|f| f.deprecated);
            let s = addr.to_string();
            if !host6.iter().any(|(_, c)| c.addr == s) {
                host6.push((
                    host6_rank(class, temporary, deprecated, pinholed == Some(addr)),
                    AddressCandidate {
                        addr: s,
                        port,
                        kind: CandidateFlavor::Host6,
                    },
                ));
            }
        }

        for net in &iface.ipv4 {
            let class = classify_interface_ipv4(net);
            if matches!(class, AddressClass::NonRoutable | AddressClass::Loopback) {
                continue;
            }
            let s = net.addr().to_string();
            if !host4.iter().any(|(_, c)| c.addr == s) {
                host4.push((
                    host4_rank(class)
                        + u8::from(
                            is_bridge_master(iface)
                                && !iface.default
                                && class != AddressClass::Ipv4Global,
                        ),
                    AddressCandidate {
                        addr: s,
                        port,
                        kind: CandidateFlavor::Host4,
                    },
                ));
            }
        }
    }

    // Stable sort so equal-rank addresses keep interface enumeration order and
    // the emitted list does not churn between reprobes.
    host6.sort_by_key(|(rank, _)| *rank);
    host4.sort_by_key(|(rank, _)| *rank);
    host6.truncate(MAX_HOST_CANDIDATES_PER_FAMILY);
    host4.truncate(MAX_HOST_CANDIDATES_PER_FAMILY);

    let mut result = Vec::with_capacity(host6.len() + host4.len());
    result.extend(host6.into_iter().map(|(_, c)| c));
    result.extend(host4.into_iter().map(|(_, c)| c));
    result
}

fn is_link_local_v6(addr: &Ipv6Addr) -> bool {
    let octets = addr.octets();
    octets[0] == 0xfe && (octets[1] & 0xc0) == 0x80
}

#[cfg(test)]
mod lifecycle_tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn test_state() -> Arc<RwLock<WebTransportState>> {
        Arc::new(RwLock::new(WebTransportState::new(
            CertState {
                cert_hash: [0; 32],
                created_at: Instant::now(),
                valid_for: Duration::from_secs(60),
            },
            443,
            Vec::new(),
            pairing::NatSignature {
                public_ip: None,
                nat_type: pairing::NatTypeLabel::None,
                hairpin: false,
            },
            stun::NatMapping::Unknown,
            None,
        )))
    }

    fn test_peer_connection(connection_id: u64) -> ChannelPeerConnection {
        let (ctrl, _) = mpsc::channel(1);
        let (pty, _) = mpsc::channel(1);
        let (display_commit, _) = mpsc::channel(1);
        ChannelPeerConnection {
            senders: ChannelSenders {
                ctrl,
                pty,
                display_commit,
                signaling: None,
            },
            connection_id,
        }
    }

    /// An upgrade that replaces a peer's session hands back the new one, and
    /// installing it moves every direct send there in the same turn: the
    /// displaced session is closed, so its handle refuses, and datagrams and
    /// reliable records reach the replacement alone.
    #[tokio::test]
    async fn a_replacement_moves_every_direct_send_to_the_new_session() {
        let state = test_state();
        let old = direct_session::loopback_pair().await;
        let new = direct_session::loopback_pair().await;
        let (old_senders, mut old_lanes) = direct_session::captured_lanes();
        let (new_senders, mut new_lanes) = direct_session::captured_lanes();
        {
            let mut state = state.write().await;
            state.peer_connections.insert(
                "browser".into(),
                ChannelPeerConnection {
                    senders: old_senders.clone(),
                    connection_id: 1,
                },
            );
            state
                .sessions
                .insert("browser".into(), Arc::clone(&old.daemon));
            state.peer_connections.insert(
                "wt-pending-2".into(),
                ChannelPeerConnection {
                    senders: new_senders,
                    connection_id: 2,
                },
            );
            state
                .sessions
                .insert("wt-pending-2".into(), Arc::clone(&new.daemon));
        }
        let installed = DirectSession::new(Arc::clone(&old.daemon), old_senders);
        assert!(installed.send_datagram_owned(&bytes::Bytes::from_static(&[0xd0, 1])));
        assert_eq!(
            old.browser.receive_datagram().await.unwrap().payload()[..],
            [0xd0, 1]
        );

        let (outcome, routed) = upgrade_peer(&state, "wt-pending-2", "browser")
            .await
            .expect("the proven session is routed");
        assert_eq!(outcome, UpgradePeerOutcome::Replaced);
        assert!(!installed.send_datagram_owned(&bytes::Bytes::from_static(&[0xd0, 2])));
        assert!(
            installed
                .try_send_reliable(CHANNEL_CTRL, ReliablePayload::Heap(vec![2]))
                .is_err()
        );

        let installed = routed;
        assert!(installed.send_datagram_owned(&bytes::Bytes::from_static(&[0xd0, 3])));
        assert_eq!(
            new.browser.receive_datagram().await.unwrap().payload()[..],
            [0xd0, 3]
        );
        assert!(
            installed
                .try_send_reliable(CHANNEL_CTRL, ReliablePayload::Heap(vec![3]))
                .is_ok()
        );
        assert_eq!(new_lanes.ctrl.try_recv().unwrap().into_vec(), vec![3]);
        assert!(old_lanes.ctrl.try_recv().is_err());
        assert!(old_lanes.pty.try_recv().is_err() && new_lanes.pty.try_recv().is_err());
    }

    #[test]
    fn session_admission_has_a_hard_concurrency_cap() {
        let slots = Arc::new(Semaphore::new(MAX_CONCURRENT_SESSIONS));
        let mut permits = Vec::with_capacity(MAX_CONCURRENT_SESSIONS);

        for _ in 0..MAX_CONCURRENT_SESSIONS {
            permits.push(try_reserve_session_slot(&slots).expect("slot below cap"));
        }
        assert!(try_reserve_session_slot(&slots).is_none());

        permits.pop();
        assert!(try_reserve_session_slot(&slots).is_some());
    }

    #[tokio::test(start_paused = true)]
    async fn silent_post_bind_session_expires_exactly_and_releases_admission() {
        let slots = Arc::new(Semaphore::new(1));
        let permit = try_reserve_session_slot(&slots).expect("initial admission");
        let state = test_state();
        let connection_id = 41;
        let temp_peer_id = format!("wt-pending-{connection_id}");
        {
            let mut state = state.write().await;
            let (upgrade_completed, _upgrade_rx) = oneshot::channel();
            state
                .pending_upgrade_deadlines
                .insert(connection_id, upgrade_completed);
            state
                .peer_connections
                .insert(temp_peer_id.clone(), test_peer_connection(connection_id));
        }

        let expiry_state = Arc::clone(&state);
        let expiry_peer_id = temp_peer_id.clone();
        let expiry = tokio::spawn(async move {
            let _permit = permit;
            tokio::time::sleep(Duration::from_millis(POST_BIND_UPGRADE_TIMEOUT_MS)).await;
            claim_pending_upgrade_expiry(&expiry_state, &expiry_peer_id, connection_id).await
        });
        tokio::task::yield_now().await;

        tokio::time::advance(Duration::from_millis(POST_BIND_UPGRADE_TIMEOUT_MS - 1)).await;
        assert!(!expiry.is_finished());
        assert!(
            try_reserve_session_slot(&slots).is_none(),
            "the admission owner must remain live until the exact deadline"
        );

        tokio::time::advance(Duration::from_millis(1)).await;
        assert!(expiry.await.expect("deadline task"));
        assert!(
            try_reserve_session_slot(&slots).is_some(),
            "expiry must release the supervisor-owned admission permit"
        );
        let state = state.read().await;
        assert!(!state.peer_connections.contains_key(&temp_peer_id));
        assert!(!state.pending_upgrade_deadlines.contains_key(&connection_id));
    }

    #[tokio::test]
    async fn stale_post_bind_deadline_cannot_remove_a_replacement_generation() {
        let state = test_state();
        let temp_peer_id = "wt-pending-reused";
        let stale_connection_id = 51;
        let replacement_connection_id = 52;
        let (_stale_rx, _replacement_rx) = {
            let mut state = state.write().await;
            let (stale_tx, stale_rx) = oneshot::channel();
            let (replacement_tx, replacement_rx) = oneshot::channel();
            state
                .pending_upgrade_deadlines
                .insert(stale_connection_id, stale_tx);
            state
                .pending_upgrade_deadlines
                .insert(replacement_connection_id, replacement_tx);
            state.peer_connections.insert(
                temp_peer_id.to_string(),
                test_peer_connection(replacement_connection_id),
            );
            (stale_rx, replacement_rx)
        };

        assert!(
            !claim_pending_upgrade_expiry(&state, temp_peer_id, stale_connection_id).await,
            "a stale exact-id deadline must lose to the replacement owner"
        );
        let state = state.read().await;
        assert_eq!(
            state
                .peer_connections
                .get(temp_peer_id)
                .map(|connection| connection.connection_id),
            Some(replacement_connection_id)
        );
        assert!(
            state
                .pending_upgrade_deadlines
                .contains_key(&replacement_connection_id)
        );
        assert!(
            !state
                .pending_upgrade_deadlines
                .contains_key(&stale_connection_id)
        );
    }

    #[tokio::test]
    async fn successful_exact_id_upgrade_cancels_only_its_own_deadline() {
        let state = test_state();
        let upgraded_connection_id = 61;
        let other_connection_id = 62;
        let (upgraded_rx, mut other_rx) = {
            let mut state = state.write().await;
            let (upgraded_tx, upgraded_rx) = oneshot::channel();
            let (other_tx, other_rx) = oneshot::channel();
            state
                .pending_upgrade_deadlines
                .insert(upgraded_connection_id, upgraded_tx);
            state
                .pending_upgrade_deadlines
                .insert(other_connection_id, other_tx);
            state.peer_connections.insert(
                "browser-upgraded".to_string(),
                test_peer_connection(upgraded_connection_id),
            );
            state.peer_connections.insert(
                "wt-pending-other".to_string(),
                test_peer_connection(other_connection_id),
            );
            (upgraded_rx, other_rx)
        };

        // The fixture registers no session, so there is no carrier to route;
        // the exact deadline completes all the same.
        assert!(
            upgrade_peer(&state, "browser-upgraded", "browser-upgraded")
                .await
                .is_none()
        );
        assert_eq!(upgraded_rx.await, Ok(()));
        assert_eq!(
            other_rx.try_recv(),
            Err(oneshot::error::TryRecvError::Empty),
            "an upgrade must not cancel another exact connection-id deadline"
        );
    }

    #[test]
    fn a_declared_mapping_supersedes_only_the_reflexive_candidate_of_its_own_family() {
        let v4_declared: std::net::SocketAddr = "203.0.113.10:44433".parse().unwrap();
        let v6_declared: std::net::SocketAddr = "[2001:db8::1]:44433".parse().unwrap();
        let v4_srflx: std::net::SocketAddr = "198.51.100.7:51000".parse().unwrap();
        let v6_srflx: std::net::SocketAddr = "[2001:db8::2]:51000".parse().unwrap();

        // Same family: the declared mapping is authoritative. The ports differ
        // on purpose — that is the production shape, where egress masquerades
        // to an arbitrary port while inbound arrives on the forwarded one, so
        // the reflexive candidate names a port nothing forwards.
        assert!(srflx_superseded_by_declared(Some(v4_declared), v4_srflx));
        assert!(srflx_superseded_by_declared(Some(v6_declared), v6_srflx));

        // Cross family: a declared IPv4 mapping says nothing about how the
        // daemon is reached over IPv6. Suppressing there would delete a working
        // candidate on the strength of an unrelated one.
        assert!(!srflx_superseded_by_declared(Some(v4_declared), v6_srflx));
        assert!(!srflx_superseded_by_declared(Some(v6_declared), v4_srflx));

        // Nothing declared: the reflexive candidate is all there is.
        assert!(!srflx_superseded_by_declared(None, v4_srflx));
        assert!(!srflx_superseded_by_declared(None, v6_srflx));
    }

    #[test]
    fn certificate_shorter_than_rotation_buffer_rotates_immediately_without_panicking() {
        let cert = CertState {
            cert_hash: [0; 32],
            created_at: Instant::now(),
            valid_for: Duration::from_secs(CERT_ROTATION_BUFFER_SECS - 1),
        };

        assert!(cert.needs_rotation());
    }

    struct DropCounter(Arc<AtomicUsize>);

    impl Drop for DropCounter {
        fn drop(&mut self) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }

    #[tokio::test]
    async fn session_cleanup_aborts_and_joins_every_remaining_child() {
        const TASKS: usize = 7;
        let started = Arc::new(AtomicUsize::new(0));
        let dropped = Arc::new(AtomicUsize::new(0));
        let mut tasks = Vec::with_capacity(TASKS);

        for _ in 0..TASKS {
            let started = Arc::clone(&started);
            let dropped = Arc::clone(&dropped);
            tasks.push(tokio::spawn(async move {
                let _drop_counter = DropCounter(dropped);
                started.fetch_add(1, Ordering::SeqCst);
                std::future::pending::<()>().await;
            }));
        }

        tokio::time::timeout(Duration::from_secs(1), async {
            while started.load(Ordering::SeqCst) != TASKS {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("children did not start");

        abort_and_join_session_tasks(&mut tasks).await;

        assert!(tasks.is_empty());
        assert_eq!(dropped.load(Ordering::SeqCst), TASKS);
    }

    #[tokio::test]
    async fn completed_session_child_is_removed_before_remaining_cleanup() {
        let dropped = Arc::new(AtomicUsize::new(0));
        let completed_drop = Arc::clone(&dropped);
        let pending_drop = Arc::clone(&dropped);
        let mut tasks = vec![
            tokio::spawn(async move {
                let _drop_counter = DropCounter(completed_drop);
            }),
            tokio::spawn(async move {
                let _drop_counter = DropCounter(pending_drop);
                std::future::pending::<()>().await;
            }),
        ];

        join_next_session_task(&mut tasks)
            .await
            .expect("completed child");
        assert_eq!(tasks.len(), 1);
        assert_eq!(dropped.load(Ordering::SeqCst), 1);

        // Regression: cleanup used to await the already-completed handle a
        // second time and panic with "JoinHandle polled after completion".
        abort_and_join_session_tasks(&mut tasks).await;
        assert!(tasks.is_empty());
        assert_eq!(dropped.load(Ordering::SeqCst), 2);
    }

    fn test_server_owner(stopped: Arc<AtomicUsize>) -> WebTransportServer {
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        let task = tokio::spawn(async move {
            let _ = shutdown_rx.await;
            stopped.fetch_add(1, Ordering::SeqCst);
            Vec::new()
        });
        // A real endpoint on an ephemeral port: the struct owns one, and these
        // tests exercise shutdown/replacement rather than the socket.
        let (config, _cert_state) = build_server_config(0).expect("server config");
        let endpoint = Arc::new(Endpoint::server(config).expect("ephemeral test endpoint"));
        WebTransportServer {
            shutdown_tx: Some(shutdown_tx),
            task: Some(task),
            endpoint,
        }
    }

    /// Certificate rotation must keep the socket.
    ///
    /// The daemon's WebTransport port is pinned by operator contract, and quinn
    /// sets no `SO_REUSEPORT`, so rotating by constructing a second
    /// `Endpoint::server` on that port cannot succeed while the first holds it.
    /// This pins both halves: the rebind genuinely fails, and the in-place
    /// reload genuinely succeeds without moving the port.
    #[tokio::test]
    async fn certificate_rotation_reloads_in_place_and_keeps_the_pinned_port() {
        let (config, first_cert) = build_server_config(0).expect("initial config");
        let endpoint = Endpoint::server(config).expect("initial bind");
        let pinned_port = endpoint.local_addr().expect("local addr").port();
        assert_ne!(pinned_port, 0);

        // The rebind route, which is what rotation used to attempt.
        let (rebind_config, _) = build_server_config(pinned_port).expect("rotation config");
        assert!(
            Endpoint::server(rebind_config).is_err(),
            "a second endpoint on the pinned port must fail while the first holds it"
        );

        // The in-place route.
        let (reload_config, second_cert) = build_server_config(pinned_port).expect("reload config");
        assert_ne!(
            first_cert.cert_hash, second_cert.cert_hash,
            "rotation must produce a different certificate"
        );
        endpoint
            .reload_config(reload_config, false)
            .expect("in-place certificate reload");
        assert_eq!(
            endpoint.local_addr().expect("local addr").port(),
            pinned_port,
            "rotation must not move the port"
        );
    }

    #[tokio::test]
    async fn server_replacement_signals_and_joins_the_previous_owner() {
        let old_stopped = Arc::new(AtomicUsize::new(0));
        let new_stopped = Arc::new(AtomicUsize::new(0));
        let mut current = Some(test_server_owner(Arc::clone(&old_stopped)));

        let retired =
            replace_server(&mut current, test_server_owner(Arc::clone(&new_stopped))).await;

        assert!(retired.is_empty());
        assert_eq!(old_stopped.load(Ordering::SeqCst), 1);
        assert_eq!(new_stopped.load(Ordering::SeqCst), 0);

        let retired = current.as_mut().unwrap().shutdown().await;
        assert!(retired.is_empty());
        assert_eq!(new_stopped.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn retirement_handoff_drains_the_full_bounded_session_cohort() {
        let state = test_state();
        {
            let mut state = state.write().await;
            for connection_id in 1..=MAX_CONCURRENT_SESSIONS as u64 {
                let temp_peer_id = format!("wt-pending-{connection_id}");
                let registry_peer_id = format!("browser-{connection_id}");
                let (ctrl, _) = mpsc::channel(1);
                let (pty, _) = mpsc::channel(1);
                let (display_commit, _) = mpsc::channel(1);
                state.lifecycle_peers.insert(connection_id, temp_peer_id);
                state.peer_connections.insert(
                    registry_peer_id,
                    ChannelPeerConnection {
                        senders: ChannelSenders {
                            ctrl,
                            pty,
                            display_commit,
                            signaling: None,
                        },
                        connection_id,
                    },
                );
            }
        }

        let retired = retire_state_connections(&state).await;

        assert_eq!(retired.len(), MAX_CONCURRENT_SESSIONS);
        assert_eq!(
            retired
                .iter()
                .map(|connection| connection.connection_id)
                .collect::<std::collections::HashSet<_>>()
                .len(),
            MAX_CONCURRENT_SESSIONS
        );
        let state = state.read().await;
        assert!(state.lifecycle_peers.is_empty());
        assert!(state.pending_upgrade_deadlines.is_empty());
        assert!(state.peer_connections.is_empty());
        assert!(state.sessions.is_empty());
    }

    /// The manifest gate compares reprobe output against cached state, so two
    /// reprobes over an unchanged network must compare equal. If they do not,
    /// every reprobe sends each attached browser a manifest — which is the
    /// churn the gate exists to avoid.
    #[test]
    fn an_unchanged_network_reprobes_to_an_equal_candidate_set() {
        let host = vec![AddressCandidate {
            addr: "2001:db8::5".to_string(),
            port: 44_433,
            kind: CandidateFlavor::Host6,
        }];
        let build = || {
            build_reprobe_result(
                None,
                host.clone(),
                Err("offline STUN test".to_string()),
                PriorReflexive::default(),
                None,
            )
        };
        let first = build();
        let second = build();

        assert_eq!(first.candidates, second.candidates);
        assert_eq!(first.nat_signature, second.nat_signature);
        assert_eq!(first.nat_mapping, second.nat_mapping);
        assert_eq!(first.daemon_srflx, second.daemon_srflx);
    }

    /// Cost of building one peer's manifest, which runs **inline on the
    /// dataplane owner loop**.
    ///
    /// `emit_webtransport_manifest` serializes it on the same task that owns
    /// the display-flush timer, the PTY drain, and input ACK flushing, so a peer
    /// connecting or reconnecting delays an existing peer's keystroke-to-paint
    /// by whatever this costs. Nothing gated that before this benchmark existed,
    /// which matters now: every change that widens the candidate set — global
    /// IPv6, more interfaces — pays here, once per peer, on every manifest.
    ///
    /// Swept by candidate count so the per-candidate slope is visible rather
    /// than only the total.
    #[test]
    #[ignore = "production performance workload"]
    fn production_webtransport_offer_build_benchmark() {
        let samples = std::env::var("BENCH_SAMPLES")
            .ok()
            .and_then(|value| value.parse::<usize>().ok())
            .filter(|value| *value > 0)
            .unwrap_or(200);

        // Shaped like a real dual-stack host: one reflexive, a LAN v4, and a
        // spread of v6 host addresses (SLAAC stable plus temporary, plus
        // container/VPN bridges) — the population the cap exists to bound.
        let pool: Vec<AddressCandidate> = vec![
            ("198.51.100.7", CandidateFlavor::Srflx),
            ("2001:db8:1::1", CandidateFlavor::Host6),
            ("2001:db8:1::2", CandidateFlavor::Host6),
            ("fd7a:115c:a1e0::5", CandidateFlavor::Host6),
            ("fd42:600b:9bff::9", CandidateFlavor::Host6),
            ("192.168.1.10", CandidateFlavor::Host4),
            ("100.64.0.5", CandidateFlavor::Host4),
        ]
        .into_iter()
        .map(|(addr, kind)| AddressCandidate {
            addr: addr.to_string(),
            port: 44_000,
            kind,
        })
        .collect();

        let browser_address: IpAddr = "203.0.113.9".parse().expect("browser address");
        let mut checksum = 0usize;

        for count in [2usize, 4, 6, 8] {
            let state = WebTransportState::new(
                CertState {
                    cert_hash: [7; 32],
                    created_at: Instant::now(),
                    valid_for: Duration::from_secs(13 * 86_400),
                },
                44_000,
                pool[..count].to_vec(),
                pairing::NatSignature {
                    public_ip: Some("198.51.100.7".to_string()),
                    nat_type: pairing::NatTypeLabel::EndpointIndependent,
                    hairpin: false,
                },
                stun::NatMapping::EndpointIndependent,
                Some("198.51.100.7".parse().expect("srflx")),
            );

            let mut timings = Vec::with_capacity(samples);
            for _ in 0..samples {
                let started = Instant::now();
                let candidates =
                    pairing::manifest_candidates(&state.candidates, browser_address, state.port);
                let msg = manifest_json(&state, &candidates, browser_address, 1, false);
                timings.push(started.elapsed().as_secs_f64() * 1_000.0);
                // Serialize inside the timed region's shadow: production sends
                // the bytes, so a benchmark that stops at the `Value` would
                // under-report the part that actually allocates.
                checksum = checksum.wrapping_add(msg.to_string().len());
            }

            timings.sort_by(f64::total_cmp);
            let percentile = |ratio: f64| {
                let index = ((timings.len() as f64 * ratio).ceil() as usize)
                    .saturating_sub(1)
                    .min(timings.len().saturating_sub(1));
                timings[index]
            };
            for ratio in [0.50, 0.95, 0.99] {
                let value = percentile(ratio);
                println!(
                    "@@merkur-perf {{\"name\":\"webtransport-offer-build-{count}\",\"value\":{value},\"unit\":\"ms/op\",\"direction\":\"lower\",\"percentile\":{ratio},\"sampleSize\":{samples}}}"
                );
            }
        }

        std::hint::black_box(checksum);
    }

    /// The rank decides which addresses survive the per-family cap, so it is
    /// the thing that decides whether a dual-stack host advertises its usable
    /// GUA or three container-bridge ULAs.
    #[test]
    fn a_stable_global_address_outranks_every_other_ipv6_class() {
        let pinholed = host6_rank(AddressClass::Ipv6Global, true, false, true);
        let stable = host6_rank(AddressClass::Ipv6Global, false, false, false);
        let temporary = host6_rank(AddressClass::Ipv6Global, true, false, false);
        let deprecated = host6_rank(AddressClass::Ipv6Global, false, true, false);
        let ula = host6_rank(AddressClass::Ipv6UniqueLocal, false, false, false);

        assert!(
            pinholed < stable,
            "a gateway pinhole outranks SLAAC stability: it needs no punch either"
        );
        assert!(
            stable < temporary,
            "a rotating address loses any cached path"
        );
        assert!(temporary < deprecated);
        assert!(
            deprecated < ula,
            "even an expiring global address routes off-link, which no ULA does"
        );
        // Absent platform flags must never demote an address: `is_some_and`
        // yields false, which is the stable ranking.
        assert_eq!(
            stable,
            host6_rank(AddressClass::Ipv6Global, false, false, false)
        );
        // A pinhole cannot promote what cannot route: ULA ranks as ULA.
        assert_eq!(
            ula,
            host6_rank(AddressClass::Ipv6UniqueLocal, false, false, true)
        );
    }

    fn fake_interface(
        name: &str,
        if_type: netdev::interface::types::InterfaceType,
        v4: &[&str],
        v6: &[&str],
    ) -> netdev::Interface {
        let mut iface = netdev::Interface::dummy();
        iface.name = name.to_string();
        iface.if_type = if_type;
        iface.ipv4 = v4.iter().map(|net| net.parse().unwrap()).collect();
        iface.ipv6 = v6
            .iter()
            .map(|addr| netdev::ipnet::Ipv6Net::new(addr.parse().unwrap(), 64).unwrap())
            .collect();
        iface
    }

    /// A bridge master's address is its members' gateway, never a host a
    /// browser sits on. `172.17.0.1` was offered from every Linux host running
    /// Docker and could not be dialled from anywhere.
    #[test]
    fn a_primary_bridge_retains_its_lan_and_global_candidates() {
        use netdev::interface::types::InterfaceType;
        let mut bridge = fake_interface(
            "br0",
            InterfaceType::Bridge,
            &["192.168.1.10/24"],
            &["2001:db8::10"],
        );
        bridge.default = true;
        let interfaces = [
            bridge,
            fake_interface(
                "docker0",
                InterfaceType::Bridge,
                &["172.17.0.1/16"],
                &["fd00:d0c::1"],
            ),
        ];
        let candidates = rank_interface_candidates(&interfaces, 44_433, None);
        assert!(candidates.iter().any(|c| c.addr == "192.168.1.10"));
        assert!(candidates.iter().any(|c| c.addr == "2001:db8::10"));
        let v4: Vec<_> = candidates
            .iter()
            .filter(|c| c.kind == CandidateFlavor::Host4)
            .collect();
        assert_eq!(v4[0].addr, "192.168.1.10");
    }

    /// The pinholed address goes first in emission order, which is the order
    /// the browser dials in.
    #[test]
    fn a_pinholed_global_address_is_emitted_before_a_stable_one() {
        use netdev::interface::types::InterfaceType;
        let interfaces = [fake_interface(
            "eth0",
            InterfaceType::Ethernet,
            &[],
            &["2001:db8::1", "2001:db8::2"],
        )];
        let pinholed: Ipv6Addr = "2001:db8::2".parse().unwrap();
        let candidates = rank_interface_candidates(&interfaces, 44_433, Some(pinholed));
        assert_eq!(candidates[0].addr, "2001:db8::2");
        assert_eq!(candidates[1].addr, "2001:db8::1");
        let unpinned = rank_interface_candidates(&interfaces, 44_433, None);
        assert_eq!(
            unpinned[0].addr, "2001:db8::1",
            "without a pinhole, enumeration order holds"
        );
    }

    /// Only the interface's own prefix says which addresses name its subnet.
    /// Carrier and overlay pools are wider than /24, so a `.0` or `.255` inside
    /// one is an ordinary host.
    #[test]
    fn only_the_interface_prefix_withholds_a_subnet_or_broadcast_address() {
        use netdev::interface::types::InterfaceType;
        let interfaces = [
            fake_interface(
                "eth0",
                InterfaceType::Ethernet,
                &[
                    "198.51.100.255/22",
                    "100.64.1.0/16",
                    "192.168.97.0/24",
                    "192.168.97.255/24",
                ],
                &[],
            ),
            fake_interface("p2p0", InterfaceType::Ethernet, &["10.0.0.0/31"], &[]),
        ];
        let v4: Vec<_> = rank_interface_candidates(&interfaces, 44_433, None)
            .into_iter()
            .filter(|c| c.kind == CandidateFlavor::Host4)
            .map(|c| c.addr)
            .collect();
        // A /31 has no subnet or broadcast address (RFC 3021).
        assert_eq!(v4, ["198.51.100.255", "100.64.1.0", "10.0.0.0"]);
    }

    /// A remote address carries no prefix, so the classifier never guesses one.
    #[test]
    fn a_remote_address_ending_in_0_or_255_keeps_its_class() {
        let class = |s: &str| classify_ipv4(&s.parse().unwrap());
        assert_eq!(class("198.51.100.0"), AddressClass::Ipv4Global);
        assert_eq!(class("198.51.100.255"), AddressClass::Ipv4Global);
        assert_eq!(class("100.64.1.0"), AddressClass::Ipv4Cgnat);
        assert_eq!(class("10.1.2.255"), AddressClass::Ipv4Private);
        assert_eq!(class("255.255.255.255"), AddressClass::NonRoutable);
    }

    #[test]
    fn a_globally_routable_ipv4_outranks_overlay_and_private() {
        assert!(host4_rank(AddressClass::Ipv4Global) < host4_rank(AddressClass::Ipv4Cgnat));
        assert!(host4_rank(AddressClass::Ipv4Cgnat) < host4_rank(AddressClass::Ipv4Private));
    }

    /// A reprobe probes from a throwaway ephemeral socket, never from the live
    /// server port — binding that port again with SO_REUSEPORT makes the kernel
    /// split inbound datagrams with quinn and silently starves a live session.
    /// So the reflexive *port* observed always belongs to the probe socket and
    /// must never be advertised; only `expected_port` may be, and only when the
    /// NAT's behaviour makes that transfer sound.
    #[test]
    fn live_mapping_is_published_even_when_the_external_port_was_rewritten() {
        let result = build_reprobe_result(
            None,
            Vec::new(),
            Ok(stun::StunResult {
                local_port: 44300,
                public_addr: "203.0.113.5:51000".parse().unwrap(),
                nat_mapping: stun::NatMapping::Unknown,
                port_allocation: stun::PortAllocation::Stable,
                nat_filtering: stun::NatFiltering::Unknown,
                hairpin: false,
                    local_ip: None,
            }),
            PriorReflexive::default(),
            None,
        );
        assert_eq!(
            result.candidates,
            vec![AddressCandidate {
                addr: "203.0.113.5".to_string(),
                port: 51000,
                kind: CandidateFlavor::Srflx,
            }]
        );
    }
}

/// The owned-socket bind, proven against a real client.
///
/// This is the test that guards the regression recorded on `build_server_config`:
/// a pre-made socket once left quinn-udp unable to configure the dual-stack
/// socket on macOS, so 1-RTT packets were mis-associated and `accept()` never
/// fired. That socket was `stun::create_reuseport_socket` — IPv4-only, with
/// `SO_REUSEPORT`. These tests bind the way `wtransport::bind_socket` does and
/// drive an actual WebTransport handshake over it, which is the only way to
/// know the difference holds.
#[cfg(test)]
mod owned_socket_tests {
    use super::*;
    use wtransport::{ClientConfig, Endpoint};

    /// Bind an owned-socket server on an ephemeral port and complete a real
    /// client handshake against it. If the abstract-socket path were wrong,
    /// `accept()` would never fire and this would hang to the timeout.
    #[tokio::test]
    async fn an_owned_socket_still_completes_a_real_webtransport_handshake() {
        let (config, cert_state, side_socket, discovery_socket) =
            build_server_config_owning_socket(0).expect("owned-socket server config");
        let endpoint = Endpoint::server_with_socket(config, discovery_socket)
            .expect("bind owned-socket endpoint");
        let port = endpoint.local_addr().expect("local addr").port();

        let side = side_channel::SideChannel::new(side_socket).expect("side channel");
        // The whole point: the side channel is the same 4-tuple, so it reports
        // the port quinn is serving on.
        assert_eq!(
            side.local_addr().map(|addr| addr.port()),
            Some(port),
            "side channel must share quinn's port, not bind its own"
        );

        let server = tokio::spawn(async move {
            let incoming = endpoint.accept().await;
            let request = incoming.await.expect("session request");
            let connection = request.accept().await.expect("accept session");
            connection.receive_datagram().await.expect("datagram")
        });

        let client_config = ClientConfig::builder()
            .with_bind_default()
            .with_server_certificate_hashes([wtransport::tls::Sha256Digest::new(
                cert_state.cert_hash,
            )])
            .build();
        let client = Endpoint::client(client_config).expect("client endpoint");
        let connection = tokio::time::timeout(
            Duration::from_secs(10),
            client.connect(format!("https://127.0.0.1:{port}")),
        )
        .await
        .expect("client connect timed out — the owned socket broke the handshake")
        .expect("client connect");

        connection
            .send_datagram(b"merkur".as_slice())
            .expect("send");

        let received = tokio::time::timeout(Duration::from_secs(10), server)
            .await
            .expect("server timed out")
            .expect("server task");
        assert_eq!(&received[..], b"merkur");
    }

    /// A side-channel send must leave from quinn's port and must not disturb a
    /// live session. This is the single assertion separating this from the
    /// deleted `send_nat_punch`, which opened a second `SO_REUSEPORT` socket and
    /// split quinn's inbound datagrams.
    #[tokio::test]
    async fn a_side_channel_send_uses_quinns_port_and_leaves_the_session_intact() {
        let (config, cert_state, side_socket, discovery_socket) =
            build_server_config_owning_socket(0).expect("owned-socket server config");
        let endpoint = Endpoint::server_with_socket(config, discovery_socket)
            .expect("bind owned-socket endpoint");
        let port = endpoint.local_addr().expect("local addr").port();
        let side = side_channel::SideChannel::new(side_socket).expect("side channel");

        let server = tokio::spawn(async move {
            let incoming = endpoint.accept().await;
            let request = incoming.await.expect("session request");
            let connection = request.accept().await.expect("accept session");
            // Two datagrams, straddling the side-channel send below.
            let first = connection.receive_datagram().await.expect("first datagram");
            let second = connection
                .receive_datagram()
                .await
                .expect("second datagram");
            (first, second)
        });

        let client_config = ClientConfig::builder()
            .with_bind_default()
            .with_server_certificate_hashes([wtransport::tls::Sha256Digest::new(
                cert_state.cert_hash,
            )])
            .build();
        let client = Endpoint::client(client_config).expect("client endpoint");
        let connection = tokio::time::timeout(
            Duration::from_secs(10),
            client.connect(format!("https://127.0.0.1:{port}")),
        )
        .await
        .expect("client connect timed out")
        .expect("client connect");

        connection
            .send_datagram(b"before".as_slice())
            .expect("send");

        // Scratch listener stands in for a punch target.
        let scratch = std::net::UdpSocket::bind("127.0.0.1:0").expect("scratch bind");
        scratch
            .set_read_timeout(Some(Duration::from_secs(5)))
            .expect("read timeout");
        let scratch_addr = scratch.local_addr().expect("scratch addr");
        side.keepalive(scratch_addr);

        let mut buf = [0u8; 8];
        let (len, from) = scratch.recv_from(&mut buf).expect("scratch must receive");
        assert_eq!(len, 1, "the inert payload is exactly one byte");
        assert_eq!(buf[0], 0x00);
        assert_eq!(
            from.port(),
            port,
            "the punch must appear to come from quinn's port, or it opens the wrong pinhole"
        );

        // The live session must be entirely unaffected by that send.
        connection.send_datagram(b"after".as_slice()).expect("send");
        let (first, second) = tokio::time::timeout(Duration::from_secs(10), server)
            .await
            .expect("server timed out — the side channel disturbed the session")
            .expect("server task");
        assert_eq!(&first[..], b"before");
        assert_eq!(&second[..], b"after");
    }
}
