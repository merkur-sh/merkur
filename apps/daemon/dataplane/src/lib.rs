//! The Merkur dataplane: the PTY, the terminal, display encoding, and the
//! carriers to browsers. `main.rs` only runs [`main`]; the network simulator
//! (`tools/sim`) links the library too.
// Under the network simulator the process entry point is not compiled in, so
// the stdio, PTY and image-helper plumbing only it reaches is dead there.
#![cfg_attr(merkur_sim, allow(dead_code, unused_imports))]

mod assets;
mod auth;
mod connection;
mod display;
mod edge_candidate;
mod geometry;
// Mandatory Noise E2E framing for every browser-facing terminal channel. The
// implementation lives in `packages/merkur-e2e` so the browser can compile the
// same code to WebAssembly instead of maintaining a second one in TypeScript.
pub(crate) use merkur_e2e as e2e;
// Daemon outbound edge tunnel. It is the primary browser dataplane carrier,
// with direct WebTransport as the latency upgrade.
mod edge_tunnel;
mod identity_cli;
mod identity_signer;
use merkur_identity_seal as identity_seal;
mod input;
#[cfg(test)]
mod input_ack_lab;
mod ipc;
mod network;
mod perf_timing;
mod perf_trace;
mod pty;
mod session;
#[cfg(merkur_sim)]
pub mod sim;
mod telemetry;
mod transport;
mod webtransport;
mod wt_upgrade;

use std::collections::{HashMap, HashSet};
use std::io;
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::Engine as _;
use crossbeam_channel::unbounded;
use merkur_wire::signaling::{ClientSignal, DataLane};
use tokio::sync::{RwLock, mpsc};
use tracing::{debug, error, info, trace, warn};
use zeroize::{Zeroize, Zeroizing};

use auth::{
    DaemonIdentity, PendingSessionRequest, SessionAuthority, UserAuthorization,
    decode_canonical_array, decode_canonical_bytes,
};

use connection::{PeerDisplayState, PeerMap, PeerTransport, PendingInputAck};
use display::recv::{
    handle_display_ack, handle_display_receiver_profile, handle_display_resync_rows,
    handle_reliable_display_ack, handle_transport_hint, parse_display_ack,
};
use display::send::{
    DisplayFlushCursor, DisplayPrepareWorker, DisplayScratch, arm_expired_resume_snapshots,
    compute_next_flush_delay_ms, fence_dictionary_preparation_without_consumers,
    fence_display_dictionary_withdrawal, finish_dictionary_prepare, finish_display_prepare,
    finish_snapshot_prepare, flush_display, has_active_display_peers, has_runnable_display_work,
    send_due_perf_timing_batches, send_open_url_requests, send_terminal_ui, start_display_prepare_worker,
};
use ipc::commands::*;
use ipc::events::*;
use network::NetworkState;
use network::input_record::{self, InputRecord};
use network::path_watch::{NetworkPathEdge, spawn_network_path_watcher};
use network::peer::{
    DeliveryMode, EdgeIngressIdentity, INLINE_RELIABLE_PAYLOAD_BYTES, PeerMessage, ReliablePayload,
};
use network::protocol::*;
use perf_timing::PerfTimingTracker;
use pty::{
    CapturedRow, PtyWriteCompletion, PtyWritePayload, PtyWriteSource, PtyWriter, TerminalEvent,
    TerminalState, input_encoder,
};
use session::auth_flow::{handle_session_auth, is_authenticated_peer};
use session::liveness::{handle_heartbeat_ping, handle_heartbeat_pong, heartbeat_tick};
use session::resume::{
    ParkedPeers, handle_display_resume, handle_display_snapshot_request, handle_peer_disconnect,
    park_disconnected_peer,
};
use session::wt_upgrade_flow::{
    WtUpgradePending, handle_wt_upgrade_init, handle_wt_upgrade_proof,
    is_webtransport_upgrade_ctrl_message,
};
use transport::{transport_send_datagram, transport_send_reliable_with_fallback};
use webtransport::WebTransportState;

const DEFAULT_COLUMNS: u16 = 120;
const DEFAULT_ROWS: u16 = 40;
const CERT_ROTATION_CHECK_SECS: u64 = 3600;
const DISPLAY_DIAGNOSTIC_LARGE_FRAME_BYTES: usize = 32 * 1024;
/// profile | chunk target | snapshot target | receive queue depth |
/// presentation period (us). Mirrored by `TRANSPORT_HINT_BYTES` in
/// `packages/protocol`.
const TRANSPORT_HINT_PAYLOAD_BYTES: usize = 11;
const BELL_EVENT_MIN_INTERVAL_MS: u64 = 50;
/// Commands are read on a blocking thread. Once this queue fills, that thread
/// stops draining stdin so the parent process and OS pipe provide backpressure.
const IPC_COMMAND_QUEUE_DEPTH: usize = 32;
/// Each session produces at most one interactive and one bulk dial result. A
/// bounded handoff prevents a burst of completed dials retaining tunnels while
/// the run loop is busy.
const EDGE_ATTACH_QUEUE_DEPTH: usize = 32;
/// A daemon-side rendezvous owner must not outlive the edge's unpaired-session
/// window. This is deliberately independent from cancellation tombstones and
/// the longer parked-peer lifetime.
const EDGE_PREAUTH_LEASE_TTL_MS: f64 = 60_000.0;
/// Bound only unauthenticated rendezvous owners. Authenticated/parked sessions
/// have their own liveness and parked-state bounds and must never be displaced by
/// a pre-auth admission burst.
const EDGE_PREAUTH_LEASE_CAP: usize = 64;
/// A terminal cancellation can overtake a previously-issued session_start in
/// the daemon/server handoff. Remember exact tuples long enough to reject that
/// late delivery, while bounding memory under adversarial control traffic.
const CANCELLED_SESSION_TOMBSTONE_TTL_MS: f64 = 60_000.0;
const CANCELLED_SESSION_TOMBSTONE_CAP: usize = 256;
/// WebTransport discovery and gateway maintenance are external network work.
/// The owner loop only consumes generation-tagged completions from this small
/// queue, keeping PTY/input work responsive while a gateway or STUN server is
/// slow.
const WT_MAINTENANCE_COMPLETION_QUEUE_DEPTH: usize = 4;
/// Heartbeat ticks between NAT-mapping keepalives. The heartbeat is 2 s, so
/// this is 14 s.
///
/// Sized against the shortest UDP mapping timeout worth defending: RFC 4787
/// REQ-5 mandates only 2 minutes, but real NATs commonly use 30 s, so this
/// keeps roughly a 2x margin against the aggressive end. Riding the heartbeat
/// rather than owning a timer keeps this out of the fiber budget entirely.
const NAT_KEEPALIVE_HEARTBEAT_TICKS: u32 = 7;

/// Send one inert datagram from quinn's own socket to a STUN vantage point.
///
/// Deliberately not a STUN Binding Request. A Binding Response would arrive on
/// quinn's socket, and STUN's leading `0x01` clears the QUIC fixed bit, so
/// `quinn-proto` would fall through to its stateless-reset path and fire an
/// unsolicited reset at our own vantage point. The vantage point silently drops
/// anything that is not a valid authenticated STUN message, so an inert byte
/// refreshes the mapping and provokes nothing.
///
/// This also means an expired ticket is irrelevant here: the mapping must not
/// be allowed to lapse merely because a ticket rotated late. The credential is
/// read only to learn *where* to send.
async fn send_nat_keepalive(
    wt_state: &Option<Arc<RwLock<webtransport::WebTransportState>>>,
    credential: Option<&webtransport::stun::StunCredential>,
    cached_vantage: &mut Option<std::net::SocketAddr>,
) {
    let Some(wt) = wt_state else {
        return;
    };
    let side_channel = {
        let guard = wt.read().await;
        let Some(channel) = guard.side_channel.clone() else {
            return;
        };
        channel
    };

    if cached_vantage.is_none() {
        let Some(credential) = credential else {
            return;
        };
        for server in credential.servers.iter() {
            if let Some(addr) = webtransport::stun::resolve_observer_for(server, true).await {
                *cached_vantage = Some(addr);
                break;
            }
        }
    }

    let Some(vantage) = *cached_vantage else {
        return;
    };
    side_channel.keepalive(vantage);

    // The keepalive is otherwise entirely silent, which would make "is the
    // mapping still being refreshed" unanswerable without a packet capture.
    // Every ~64 keepalives is roughly every 15 minutes.
    let stats = side_channel.stats();
    let sent = stats
        .keepalives_sent
        .load(std::sync::atomic::Ordering::Relaxed);
    if sent.is_multiple_of(64) {
        info!(
            keepalives = sent,
            packets = stats
                .packets_sent
                .load(std::sync::atomic::Ordering::Relaxed),
            would_block = stats
                .send_would_block
                .load(std::sync::atomic::Ordering::Relaxed),
            failed = stats.send_failed.load(std::sync::atomic::Ordering::Relaxed),
            punch_bursts = stats.bursts_sent.load(std::sync::atomic::Ordering::Relaxed),
            punch_refused_not_global = stats
                .refused_not_global
                .load(std::sync::atomic::Ordering::Relaxed),
            punch_refused_rate_limited = stats
                .refused_rate_limited
                .load(std::sync::atomic::Ordering::Relaxed),
            vantage = %vantage,
            "nat_side_channel_stats"
        );
    }
}
/// Reliable browser ingress is backpressured at this boundary. Frames are capped
/// at 64 KiB on either carrier; the direct and edge readers both deliver here
/// themselves, and an edge datagram that finds it full is dropped and counted.
const PEER_MESSAGE_QUEUE_DEPTH: usize = 64;
/// Lifecycle events await capacity while best-effort datagrams are dropped when
/// this queue is full. Keeping it modest bounds datagram memory and crowd-out.
const PEER_EVENT_QUEUE_DEPTH: usize = 256;
/// Completion handling can refill the PTY input queue, so an unbounded drain
/// could monopolize the owner loop while network/timer branches are ready.
const PTY_WRITE_COMPLETIONS_PER_TURN: usize = 64;
// The reader emits at most 32 KiB per event. Bounding both sides of the
// crossbeam -> Tokio bridge caps queued PTY output around 512 KiB; once full,
// the reader blocks and lets the kernel PTY apply natural backpressure to the
// child instead of allocating an unbounded Vec per unread chunk.
const PTY_OUTPUT_QUEUE_DEPTH: usize = 8;

type WtMaintenanceGeneration = u64;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum WtMaintenanceKind {
    Startup,
    Rotation,
    Reprobe,
    /// Acquire or renew the port-mapping lease. Never blocks candidate
    /// publication; a won lease arrives in the next manifest.
    Mapping,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct WtMaintenanceRequest {
    generation: WtMaintenanceGeneration,
    kind: WtMaintenanceKind,
}

struct WtMaintenanceCompletion<T> {
    generation: WtMaintenanceGeneration,
    kind: WtMaintenanceKind,
    result: T,
}

struct AcceptedWtMaintenance<T> {
    kind: WtMaintenanceKind,
    result: T,
}

#[derive(Default)]
struct WtMaintenanceQueue {
    startup: bool,
    rotation: bool,
    reprobe: bool,
    mapping: bool,
}

impl WtMaintenanceQueue {
    fn insert(&mut self, kind: WtMaintenanceKind) {
        match kind {
            WtMaintenanceKind::Startup => self.startup = true,
            WtMaintenanceKind::Rotation => self.rotation = true,
            WtMaintenanceKind::Reprobe => self.reprobe = true,
            WtMaintenanceKind::Mapping => self.mapping = true,
        }
    }

    fn take_next(&mut self) -> Option<WtMaintenanceKind> {
        // A server must exist before any candidate maintenance. Once it does,
        // replacing an expiring certificate takes priority over topology
        // refresh.
        if std::mem::take(&mut self.startup) {
            Some(WtMaintenanceKind::Startup)
        } else if std::mem::take(&mut self.rotation) {
            Some(WtMaintenanceKind::Rotation)
        } else if std::mem::take(&mut self.reprobe) {
            Some(WtMaintenanceKind::Reprobe)
        } else if std::mem::take(&mut self.mapping) {
            Some(WtMaintenanceKind::Mapping)
        } else {
            None
        }
    }

    fn clear(&mut self) {
        *self = Self::default();
    }

    fn take(&mut self, kind: WtMaintenanceKind) -> bool {
        match kind {
            WtMaintenanceKind::Startup => std::mem::take(&mut self.startup),
            WtMaintenanceKind::Rotation => std::mem::take(&mut self.rotation),
            WtMaintenanceKind::Reprobe => std::mem::take(&mut self.reprobe),
            WtMaintenanceKind::Mapping => std::mem::take(&mut self.mapping),
        }
    }
}

#[derive(Default)]
struct WtMaintenanceOwner {
    next_generation: WtMaintenanceGeneration,
    pending: Option<WtMaintenanceRequest>,
    queued: WtMaintenanceQueue,
    /// A gateway announcement said the held lease is already gone. Consumed by
    /// the next `Mapping` cycle, which then skips renewal and the delete that
    /// would otherwise fence re-acquisition — see `MappingInputs`.
    gateway_rebooted: bool,
}

impl WtMaintenanceOwner {
    /// Request a mapping cycle because the gateway announced a reset.
    fn request_mapping_after_reboot(&mut self) {
        self.gateway_rebooted = true;
        self.request(WtMaintenanceKind::Mapping);
    }

    fn take_gateway_rebooted(&mut self) -> bool {
        std::mem::take(&mut self.gateway_rebooted)
    }

    fn request(&mut self, kind: WtMaintenanceKind) {
        if self.pending.is_some_and(|pending| pending.kind == kind) {
            // Network changes are edge-triggered. Preserve one trailing reprobe
            // if another change arrives while discovery is in flight so the
            // published candidates reflect the newest interface state.
            if kind == WtMaintenanceKind::Reprobe {
                self.queued.insert(kind);
            }
            return;
        }
        self.queued.insert(kind);
    }

    fn request_trailing(&mut self, kind: WtMaintenanceKind) {
        if self.pending.is_some_and(|pending| pending.kind == kind) {
            self.queued.insert(kind);
        } else {
            self.request(kind);
        }
    }

    fn take_queued(&mut self, kind: WtMaintenanceKind) -> bool {
        self.queued.take(kind)
    }

    fn begin_next(&mut self) -> Option<WtMaintenanceRequest> {
        if self.pending.is_some() {
            return None;
        }
        let kind = self.queued.take_next()?;
        let request = WtMaintenanceRequest {
            generation: self.allocate_generation(),
            kind,
        };
        self.pending = Some(request);
        Some(request)
    }

    fn accept<T>(
        &mut self,
        completion: WtMaintenanceCompletion<T>,
    ) -> Option<AcceptedWtMaintenance<T>> {
        if self.pending
            != Some(WtMaintenanceRequest {
                generation: completion.generation,
                kind: completion.kind,
            })
        {
            // Dropping a stale server endpoint or NAT owner here is deliberate:
            // only the current generation is allowed to publish resources.
            return None;
        }
        self.pending = None;
        Some(AcceptedWtMaintenance {
            kind: completion.kind,
            result: completion.result,
        })
    }

    fn cancel_pending(&mut self) {
        self.queued.clear();
        if self.pending.take().is_some() {
            self.allocate_generation();
        }
    }

    fn allocate_generation(&mut self) -> WtMaintenanceGeneration {
        self.next_generation = self.next_generation.wrapping_add(1);
        if self.next_generation == 0 {
            self.next_generation = 1;
        }
        self.next_generation
    }
}

/// Which maintenance the *first* STUN credential drives.
///
/// Only meaningful for the first one; a refresh landing on a live credential
/// must not probe at all, and the caller gates on that before asking.
///
/// `listener_held` means a `configure` asked for a WebTransport listener and was
/// deferred because no credential existed yet. That listener has never bound the
/// pinned port, so `Startup` can still run the IPv6 reachability probe on it —
/// the one opportunity there is, since `Rotation` and `Reprobe` deliberately
/// never re-run `start_server` and quinn holds the port with no `SO_REUSEPORT`.
/// Without the hold, a server is already live and `Reprobe` is all that is
/// available: it recovers the reflexive candidate without touching the port.
fn wt_maintenance_for_first_credential(listener_held: bool) -> WtMaintenanceKind {
    if listener_held {
        WtMaintenanceKind::Startup
    } else {
        WtMaintenanceKind::Reprobe
    }
}

fn request_wt_network_change_maintenance(owner: &mut WtMaintenanceOwner, has_live_server: bool) {
    if has_live_server {
        owner.request(WtMaintenanceKind::Reprobe);
    } else {
        // An external topology edge is also the bounded recovery path for a
        // failed initial startup. Preserve one trailing edge if startup is
        // already in flight; never poll/retry blindly.
        owner.request_trailing(WtMaintenanceKind::Startup);
    }
}

/// Re-evaluate display scheduling after a carrier lifecycle mutation.
///
/// Retirement can turn an otherwise deadline-free header-only attempt into
/// immediately runnable work. The timer is earlier-only: unrelated lifecycle
/// events may expose work, but may never postpone a deadline already owned by
/// another peer.
fn arm_display_flush_no_later(
    mut flush_sleep: Pin<&mut tokio::time::Sleep>,
    flush_armed: &mut bool,
    flush_at: tokio::time::Instant,
) {
    if !*flush_armed || flush_at < flush_sleep.deadline() {
        flush_sleep.as_mut().reset(flush_at);
        *flush_armed = true;
    }
}

/// An unterminated application's sync update cannot extend its safety deadline
/// indefinitely by repeating BSU. A real ESU ends that lifetime; a following
/// BSU may own a new deadline. This is not display coalescing: ordinary closed
/// application updates never arm this timer.
#[derive(Default)]
struct SynchronizedUpdateDeadline {
    deadline: Option<Instant>,
    completed_epoch: u64,
}

impl SynchronizedUpdateDeadline {
    fn update(&mut self, parser_deadline: Option<Instant>, completed_epoch: u64) {
        self.deadline = match (self.deadline, parser_deadline) {
            (_, None) => None,
            (Some(old), Some(new)) if completed_epoch <= self.completed_epoch => Some(old.min(new)),
            (_, Some(new)) => Some(new),
        };
        self.completed_epoch = self.completed_epoch.max(completed_epoch);
    }
}

/// Route one scheduling decision. `None` parks; `Some(0)` runs the flush at the
/// bottom of this same owner turn, because a zero-delay tokio rearm is not a
/// same-turn continuation — it rounds up to the next whole-millisecond tick,
/// measured in this repo at ~1.2 ms — and a positive delay arms the earlier-only
/// timer. Every wait that reaches the timer is evidence of an actual refusal
/// (snapshot backoff, zero-progress admission) or a row's re-send deadline;
/// nothing coalesces against a clock any more.
fn schedule_display_flush(
    delay: Option<u64>,
    flush_sleep: Pin<&mut tokio::time::Sleep>,
    flush_armed: &mut bool,
    flush_now: &mut bool,
) {
    match delay {
        None => {}
        Some(0) => *flush_now = true,
        Some(delay) => {
            let flush_at = tokio::time::Instant::now() + Duration::from_millis(delay);
            arm_display_flush_no_later(flush_sleep, flush_armed, flush_at);
        }
    }
}

fn advance_display_flush_after_lifecycle(
    flush_sleep: Pin<&mut tokio::time::Sleep>,
    flush_armed: &mut bool,
    flush_now: &mut bool,
    peers: &PeerMap,
    terminal_damage: crate::pty::PendingDisplayDamage,
    header_signal: u128,
    current_row_hashes: &[u64],
    now_ms: f64,
) {
    schedule_display_flush(
        compute_next_flush_delay_ms(
            peers,
            terminal_damage,
            header_signal,
            current_row_hashes,
            now_ms,
        ),
        flush_sleep,
        flush_armed,
        flush_now,
    );
}

/// Control-only shell evidence may need a kernel sample without any display
/// damage yet. Reuse an existing flush deadline; only wake an otherwise parked
/// owner, and consume the pending bit at that wake before considering emission.
fn include_prediction_sample_wake(
    display_delay: Option<u64>,
    sample_pending: bool,
    active_peers: bool,
) -> Option<u64> {
    display_delay.or_else(|| (sample_pending && active_peers).then_some(0))
}

#[cfg(test)]
#[path = "main_tests/display_flush_deadline_tests.rs"]
mod display_flush_deadline_tests;

enum WtMaintenanceResult {
    Server(
        Result<
            (
                wtransport::Endpoint<wtransport::endpoint::endpoint_side::Server>,
                webtransport::CertState,
                webtransport::WebTransportServerInfo,
            ),
            String,
        >,
    ),
    Reprobe(webtransport::ReprobeResult),
    Mapping(webtransport::MappingCycle),
    /// A freshly generated identity for the live endpoint to adopt in place.
    ///
    /// Keygen happens on the maintenance task; the swap itself is a pointer
    /// store the run loop performs directly.
    Rotation(Result<(wtransport::ServerConfig, webtransport::CertState), String>),
    Failed(String),
}

/// How the WebTransport server binds and publishes itself.
///
/// One value because the two never travel apart: the pinned port is what an
/// operator's firewall rule names, and the declared endpoint is where that same
/// rule publishes it. Only the startup path reads the endpoint — a rotation
/// reuses the candidate set it already published, and a reprobe re-derives only
/// what STUN can tell it — but both are decided once, before the endpoint binds.
#[derive(Clone, Copy, Debug)]
struct WtBinding {
    pinned_port: u16,
    public_endpoint: Option<std::net::SocketAddr>,
}

impl Args {
    fn wt_binding(&self) -> WtBinding {
        WtBinding {
            pinned_port: self.pinned_wt_port,
            public_endpoint: self.public_wt_endpoint,
        }
    }
}

/// The live-state snapshot a `Mapping` cycle runs on, taken under one lock.
struct MappingSnapshot {
    lease: Option<Arc<webtransport::portmap::Lease>>,
    pinhole: Option<Arc<webtransport::portmap::Pinhole>>,
    host6: Option<std::net::Ipv6Addr>,
    gateway_rebooted: bool,
}

fn spawn_wt_maintenance(
    request: WtMaintenanceRequest,
    binding: WtBinding,
    discovery_socket: Option<Arc<webtransport::discovery_socket::DiscoverySocket>>,
    stun_credential: Option<webtransport::stun::StunCredential>,
    prior_reflexive: Option<webtransport::PriorReflexive>,
    prior_lease: Option<Arc<webtransport::portmap::Lease>>,
    mapping: Option<MappingSnapshot>,
    completion_tx: mpsc::Sender<WtMaintenanceCompletion<WtMaintenanceResult>>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let credential = stun_credential.as_ref();
        let wt_port = discovery_socket.as_ref().and_then(|discovery| {
            wtransport::quinn::AsyncUdpSocket::local_addr(discovery.as_ref())
                .ok()
                .map(|addr| addr.port())
        });
        let result = match request.kind {
            WtMaintenanceKind::Startup => WtMaintenanceResult::Server(
                webtransport::start_server(binding.pinned_port, binding.public_endpoint),
            ),
            // Rotation deliberately does NOT re-run `start_server`. The pinned
            // port is still held by the live endpoint and quinn sets no
            // SO_REUSEPORT, so every bind in that path — the STUN probe, the v6
            // reachability probe, and `Endpoint::server` itself — would fail with
            // EADDRINUSE and the daemon would serve an expired certificate
            // forever. Nothing that `start_server` gathers can have changed
            // either: the port is the same, so the candidate set and the NAT
            // leases are the same, and re-acquiring the leases would hand the
            // previous guards to a drop that deletes the mapping the new ones
            // just made. Only the certificate is new.
            WtMaintenanceKind::Rotation => WtMaintenanceResult::Rotation(
                webtransport::build_server_config(binding.pinned_port),
            ),
            WtMaintenanceKind::Reprobe => match (wt_port, prior_reflexive, discovery_socket) {
                (Some(port), Some(prior), Some(socket)) => WtMaintenanceResult::Reprobe(
                    webtransport::reprobe_candidates_retaining(
                        port,
                        binding.public_endpoint,
                        &socket,
                        credential,
                        prior,
                        // The reprobe only decides whether to carry a candidate
                        // forward; it has no business holding the gateway
                        // handle that could renew or delete the lease.
                        prior_lease.as_ref().map(|lease| lease.prior()),
                    )
                    .await,
                ),
                _ => WtMaintenanceResult::Failed(
                    "WebTransport reprobe requested without a live server".to_string(),
                ),
            },
            WtMaintenanceKind::Mapping => match (wt_port, mapping) {
                (Some(port), Some(snapshot)) => WtMaintenanceResult::Mapping(
                    webtransport::run_mapping_cycle(webtransport::MappingInputs {
                        port,
                        stun_local_ip: prior_reflexive
                            .as_ref()
                            .and_then(|prior| prior.stun_local_ip),
                        existing_lease: snapshot.lease,
                        existing_pinhole: snapshot.pinhole,
                        reflexive: prior_reflexive
                            .as_ref()
                            .and_then(|prior| prior.daemon_srflx),
                        host6: snapshot.host6,
                        gateway_rebooted: snapshot.gateway_rebooted,
                    })
                    .await,
                ),
                _ => WtMaintenanceResult::Failed(
                    "port mapping requested without a live server".to_string(),
                ),
            },
        };
        let _ = completion_tx
            .send(WtMaintenanceCompletion {
                generation: request.generation,
                kind: request.kind,
                result,
            })
            .await;
    })
}

async fn start_next_wt_maintenance(
    owner: &mut WtMaintenanceOwner,
    task: &mut Option<(WtMaintenanceGeneration, tokio::task::JoinHandle<()>)>,
    wt_state: &Option<Arc<RwLock<WebTransportState>>>,
    binding: WtBinding,
    stun_credential: Option<&webtransport::stun::StunCredential>,
    completion_tx: &mpsc::Sender<WtMaintenanceCompletion<WtMaintenanceResult>>,
) {
    let Some(request) = owner.begin_next() else {
        return;
    };
    // One read for all three: the reprobe needs the live port *and* the
    // reflexive evidence already published from it, so a probe that fails or
    // cannot re-derive the server's external port retains rather than erases
    // it; the mapping cycle needs the port, the reflexive address to publish
    // the lease against, and the existing lease to renew rather than duplicate.
    //
    // The spawned task is `'static` and cannot borrow `wt_state`, so everything
    // it needs is snapshotted here under one lock rather than reached for later.
    let needs_state = matches!(
        request.kind,
        WtMaintenanceKind::Reprobe | WtMaintenanceKind::Mapping
    );
    let (prior_reflexive, prior_lease, discovery_socket, mapping) = if needs_state {
        match wt_state {
            Some(state) => {
                let state = state.read().await;
                let mapping =
                    (request.kind == WtMaintenanceKind::Mapping).then(|| MappingSnapshot {
                        lease: state.port_lease.clone(),
                        pinhole: state.v6_pinhole.clone(),
                        host6: state.top_global_host6(),
                        gateway_rebooted: owner.take_gateway_rebooted(),
                    });
                (
                    Some(webtransport::PriorReflexive::from_state(&state)),
                    state.port_lease.clone(),
                    state.discovery_socket.clone(),
                    mapping,
                )
            }
            None => (None, None, None, None),
        }
    } else {
        (None, None, None, None)
    };
    let generation = request.generation;
    let handle = spawn_wt_maintenance(
        request,
        binding,
        discovery_socket,
        stun_credential.cloned(),
        prior_reflexive,
        prior_lease,
        mapping,
        completion_tx.clone(),
    );
    *task = Some((generation, handle));
}

/// Takes the fields it publishes rather than a `WebTransportServerInfo`, so the
/// reprobe path can re-announce a candidate set without fabricating one.
fn emit_webtransport_ready(
    event_tx: &EventSink,
    cert_state: &webtransport::CertState,
    port: u16,
    candidates: &[webtransport::AddressCandidate],
    ipv6_reachability: &'static str,
) {
    send_json_event(
        event_tx,
        EVT_WEBTRANSPORT_READY,
        &WebTransportReadyEvt {
            port,
            cert_hash: cert_state.cert_hash_base64(),
            candidates: candidates
                .iter()
                .map(|candidate| WebTransportCandidateEvt {
                    addr: candidate.addr.clone(),
                    port: candidate.port,
                    kind: candidate.kind,
                })
                .collect(),
            ipv6_reachability,
        },
    );
}

/// The gateway-announcement listener: one socket on the egress link, read by
/// a detached task into a capacity-1 channel. Rebound whenever a mapping cycle
/// reports a different egress interface, and never before the first cycle,
/// because until then there is no interface to join on.
struct AnnounceListener {
    egress: webtransport::egress::EgressPath,
    task: tokio::task::JoinHandle<()>,
}

impl AnnounceListener {
    fn bind(
        egress: &webtransport::egress::EgressPath,
        tx: mpsc::Sender<webtransport::portmap::announce::Announcement>,
    ) -> Option<Self> {
        let gateway = egress.gateway?;
        let socket = match webtransport::portmap::announce::bind(egress.local_ipv4) {
            Ok(socket) => socket,
            Err(error) => {
                debug!(interface = %egress.interface_name, "gateway announcement socket unavailable: {error}");
                return None;
            }
        };
        let task = tokio::spawn(async move {
            let mut buf = [0u8; webtransport::portmap::announce::MAX_ANNOUNCEMENT_LEN];
            loop {
                let Ok((len, sender)) = socket.recv_from(&mut buf).await else {
                    return;
                };
                if sender.ip() != std::net::IpAddr::V4(gateway) {
                    continue;
                }
                if let Some(announcement) = webtransport::portmap::announce::decode(&buf[..len]) {
                    // Sliding: a burst of announcements is one fact.
                    let _ = tx.try_send(announcement);
                }
            }
        });
        Some(Self {
            egress: egress.clone(),
            task,
        })
    }

    fn abort(self) {
        self.task.abort();
    }
}

async fn send_webtransport_manifest(
    wt_state: &Option<Arc<RwLock<WebTransportState>>>,
    network_state: &Arc<RwLock<NetworkState>>,
    peers: &mut PeerMap,
    peer_id: &str,
    reason: &'static str,
) -> bool {
    let Some(peer) = peers.get_mut(peer_id) else {
        return false;
    };
    if !peer.authenticated {
        return false;
    }
    debug!("webtransport_manifest ({reason}): peer={peer_id}");
    session::wt_upgrade_flow::emit_webtransport_manifest(wt_state, network_state, peer, None).await
}

/// The daemon's candidates or certificate changed: every peer still without a
/// direct path hears the new manifest. A live direct path needs none.
async fn broadcast_webtransport_manifests(
    wt_state: &Option<Arc<RwLock<WebTransportState>>>,
    network_state: &Arc<RwLock<NetworkState>>,
    peers: &mut PeerMap,
    reason: &'static str,
) {
    for peer in peers
        .values_mut()
        .filter(|peer| peer.authenticated && !peer.paths.webtransport.available)
    {
        debug!("webtransport_manifest ({reason}): peer={}", peer.peer_id);
        crate::session::wt_upgrade_flow::emit_webtransport_manifest(
            wt_state,
            network_state,
            peer,
            None,
        )
        .await;
    }
}

async fn is_current_ingress_generation(
    wt_state: &Option<Arc<RwLock<WebTransportState>>>,
    edge_dials: &HashMap<String, EdgeDialState>,
    peer_id: &str,
    via_transport: PeerTransport,
    connection_id: u64,
    edge_ingress: Option<&EdgeIngressIdentity>,
) -> bool {
    if let Some(edge_ingress) = edge_ingress {
        if via_transport != PeerTransport::Edge
            || connection_id == 0
            || connection_id != edge_ingress.generation
        {
            return false;
        }
        let Some(state) = edge_dials.get(peer_id) else {
            return false;
        };
        if state.session_id != *edge_ingress.session_id {
            return false;
        }
        let lane = state.lane(edge_ingress.lane);
        return lane.generation == edge_ingress.generation
            && lane.state == EdgeDialLaneState::Succeeded;
    }

    match via_transport {
        PeerTransport::WebTransport => match wt_state {
            Some(state) => webtransport::is_current_connection(state, peer_id, connection_id).await,
            None => false,
        },
        // Production edge messages always carry `edge_ingress` and returned
        // through the generation-fenced branch above.
        PeerTransport::Edge => false,
    }
}

/// Apply the exact lifecycle identities returned by a replaced WT server.
///
/// Old supervisors are aborted during certificate rotation, so they cannot be
/// relied on to enqueue their normal disconnect event. The returned identities
/// are capped by the server's session semaphore and include displaced sessions
/// that are no longer visible in its routing map. A current-registry snapshot
/// protects a newer direct connection for the same logical peer from demotion.
async fn retire_replaced_webtransport_connections(
    retired: Vec<webtransport::RetiredWebTransportConnection>,
    wt_state: &Option<Arc<RwLock<WebTransportState>>>,
    wt_temp_to_real: &mut HashMap<String, Arc<str>>,
    wt_upgrade_pending: &mut HashMap<String, WtUpgradePending>,
    peers: &mut PeerMap,
) -> usize {
    if retired.is_empty() {
        return 0;
    }
    let current_connection_ids = match wt_state {
        Some(state) => {
            let state = state.read().await;
            state
                .peer_connections
                .iter()
                .map(|(peer_id, connection)| (peer_id.clone(), connection.connection_id))
                .collect::<HashMap<_, _>>()
        }
        None => HashMap::new(),
    };

    let retired_count = retired.len();
    for retired in retired {
        wt_upgrade_pending.remove(&retired.temp_peer_id);
        let real_peer_id = wt_temp_to_real
            .remove(&retired.temp_peer_id)
            .unwrap_or_else(|| Arc::from(retired.registry_peer_id.as_str()));

        // The new endpoint may already own B under the same authenticated id.
        // Any current generation wins, regardless of whether an impossible
        // connection-id collision occurred after u64 wrap.
        if current_connection_ids.contains_key(&*real_peer_id) {
            continue;
        }

        if let Some(peer) = peers.get_mut(&*real_peer_id) {
            // Rotation retires whole server cohorts whose supervisors can no
            // longer emit the normal connection-scoped disconnect event. This
            // is therefore the exact direct-carrier retirement boundary: drop
            // sole-direct display provenance before exposing only the survivor.
            peer.retire_display_attempts(PeerTransport::WebTransport);
            peer.paths.webtransport.consecutive_send_failures = 0;
            peer.paths.webtransport.available = false;
            peer.direct_session = None;
        }
    }
    retired_count
}

#[cfg(test)]
#[path = "main_tests/wt_maintenance_owner_tests.rs"]
mod wt_maintenance_owner_tests;

#[derive(Debug)]
struct Args {
    shell: String,
    /// Path to the file holding the shell-integration token.
    ///
    /// The PATH travels on the command line, never the token itself. The token
    /// is not a secret against other local processes of this user, but there is
    /// no reason to publish it to every `ps` on the machine either.
    shell_token_path: Option<String>,
    /// Directory holding the daemon-written `merkur-open` helper, named as
    /// `$BROWSER` in the PTY environment (and prepended to `PATH` on Linux for
    /// its `xdg-open` stand-in).
    open_url_bin_dir: Option<String>,
    cols: u16,
    rows: u16,
    /// Configured UDP port for the direct WebTransport server, or 0 for
    /// ephemeral. Distinct from the *live* server port threaded through
    /// maintenance, which is whatever the endpoint actually bound.
    ///
    /// A pinned port is what makes a NAT mapping outlive a daemon restart, what
    /// lets a router forward be written down at all, and what lets the box-host
    /// firewall name one port instead of the whole ephemeral range.
    pinned_wt_port: u16,
    /// A `SocketAddr` an operator-installed port mapping publishes this daemon
    /// on, or `None` when nothing has told it.
    ///
    /// This is the one candidate the daemon cannot discover for itself. STUN
    /// reports the mapping the daemon's *egress* happens to get, which on a
    /// host that source-NATs its containers is a different port from the one
    /// the inbound DNAT uses — so the reflexive candidate is wrong there in a
    /// way no probe can detect. Being told is the only correct answer, and it
    /// is published as `CandidateFlavor::NatMap`, whose definition already
    /// covers exactly this: admitted by configuration rather than by a
    /// keepalive and a punch landing in time.
    public_wt_endpoint: Option<std::net::SocketAddr>,
}

/// The `merkur-dataplane` process: the identity CLI, or the owner loop. The
/// network simulator builds its own host instead (`sim`).
#[cfg(not(merkur_sim))]
pub fn main() {
    if identity_seal::disable_core_dumps().is_err() {
        std::process::exit(identity_seal::IDENTITY_UNSEALABLE_EXIT_CODE);
    }
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().is_some_and(|arg| arg == "identity-seal") {
        std::process::exit(identity_cli::run(&args[1..]));
    }
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("merkur_dataplane=info".parse().unwrap()),
        )
        .with_writer(io::stderr)
        .init();

    info!("merkur-dataplane starting");

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("dataplane runtime");
    // The owner loop: each poll is one busy period, accounted while profiled.
    let result = runtime.block_on(perf_timing::owner::Turns(Box::pin(async {
        run(Host::process()?).await
    })));
    // Runtime teardown joins detached processing owners. Only then is the
    // reclaimer's empty queue a proof that every released image was wiped.
    drop(runtime);
    merkur_image_worker::retirement::drain();
    if let Err(e) = result {
        error!("fatal: {e}");
        std::process::exit(if e.is::<identity_seal::SealError>() {
            identity_seal::IDENTITY_UNSEALABLE_EXIT_CODE
        } else {
            1
        });
    }

    info!("merkur-dataplane shut down");
}

#[derive(Debug)]
enum IpcInput {
    Frame(u8, Vec<u8>),
    ReadError(io::Error),
}

fn read_ipc_commands(reader: &mut impl io::Read, tx: &mpsc::Sender<IpcInput>) {
    loop {
        match ipc::read_frame(reader) {
            Ok(Some(frame)) => {
                if tx.blocking_send(IpcInput::Frame(frame.0, frame.1)).is_err() {
                    break;
                }
            }
            Ok(None) => break,
            Err(error) => {
                let _ = tx.blocking_send(IpcInput::ReadError(error));
                break;
            }
        }
    }
}

/// What the process hands the owner loop: its arguments, its parent's commands
/// and the sink its events go to. The network simulator builds one from
/// channels, with the program its PTY runs (`sim`).
struct Host {
    args: Args,
    ipc: mpsc::Receiver<IpcInput>,
    events: (EventSink, mpsc::Receiver<EventSinkFailure>, EventOutput),
    #[cfg(merkur_sim)]
    pty: pty::sim::Pty,
}

#[cfg(not(merkur_sim))]
impl Host {
    /// Command-line arguments, stdin read on its own thread, and stdout.
    fn process() -> Result<Self, Box<dyn std::error::Error>> {
        let args = parse_args(std::env::args().skip(1))?;
        let (ipc_tx, ipc) = mpsc::channel::<IpcInput>(IPC_COMMAND_QUEUE_DEPTH);
        std::thread::Builder::new()
            .name("merkur-ipc-reader".to_string())
            .spawn(move || {
                let mut stdin = io::stdin().lock();
                read_ipc_commands(&mut stdin, &ipc_tx);
            })?;
        Ok(Self {
            args,
            ipc,
            events: start_stdout_event_output()?,
        })
    }
}

async fn run(host: Host) -> Result<(), Box<dyn std::error::Error>> {
    let Host {
        args,
        ipc: mut ipc_rx,
        events: (event_tx, mut event_failure_rx, mut event_output),
        #[cfg(merkur_sim)]
        pty: simulated_pty,
    } = host;
    let (identity_completion_tx, mut identity_completion_rx) =
        mpsc::channel::<session::auth_flow::IdentitySignDone>(32);
    let mut management_signatures: tokio::task::JoinSet<(
        String,
        Result<identity_signer::SignaturePair, identity_seal::SealError>,
    )> = tokio::task::JoinSet::new();
    let mut fatal_identity_failure = None;

    let network_state = Arc::new(RwLock::new(NetworkState::new()));
    let (peer_msg_tx, mut peer_msg_rx) = mpsc::channel::<PeerMessage>(PEER_MESSAGE_QUEUE_DEPTH);
    let (peer_event_tx, mut peer_event_rx) =
        mpsc::channel::<network::PeerEvent>(PEER_EVENT_QUEUE_DEPTH);
    let (wt_maintenance_completion_tx, mut wt_maintenance_completion_rx) =
        mpsc::channel::<WtMaintenanceCompletion<WtMaintenanceResult>>(
            WT_MAINTENANCE_COMPLETION_QUEUE_DEPTH,
        );
    let mut wt_maintenance_owner = WtMaintenanceOwner::default();
    let mut wt_maintenance_task: Option<(WtMaintenanceGeneration, tokio::task::JoinHandle<()>)> =
        None;

    // Only already-counted PTY read buffers travel back on this recycling
    // queue, to the reader thread alone. A read creates one returnable buffer
    // and must cross the output stage before it can be returned, so the number
    // of live 32 KiB buffers (and therefore return entries) is
    // pipeline-bounded. Keep this nonblocking: buffer reuse must never stall
    // the latency-critical loop.
    let (buffer_return_tx, buffer_return_rx) = unbounded::<Vec<u8>>();
    // The reader thread publishes here directly. There is deliberately no
    // crossbeam queue and no bridging thread in front of it: that pair added a
    // hop to every PTY read without adding an ordering or backpressure
    // property this bounded channel does not already provide.
    let (pty_event_tx, mut pty_async_rx) = mpsc::channel::<TerminalEvent>(PTY_OUTPUT_QUEUE_DEPTH);

    // Read once, and use the same bytes for both halves of the contract: the
    // value exported into the shell's environment, and the value an
    // `OSC 133;B;merkur=` must match. Reading it twice would make a rewritten
    // file mid-startup produce a shell that can never authenticate.
    //
    // A missing or unreadable file is not fatal. It costs the authenticated
    // form of the boundary and nothing else, so the daemon behaves exactly as
    // it did before the token existed.
    let shell_token = args.shell_token_path.as_deref().and_then(read_shell_token);

    // Parser callbacks are synchronously drained by the terminal owner. Native
    // descriptor ingress exists before the shell receives its private authority.
    let (terminal_event_tx, terminal_event_rx) = unbounded::<TerminalEvent>();
    let mut terminal = TerminalState::new(args.cols, args.rows, terminal_event_tx);
    #[cfg(not(merkur_sim))]
    let pty_handle = {
        let native_images = terminal.enable_native_graphics()?;
        let pty_handle = pty::spawn_pty(
            &args.shell,
            args.cols,
            args.rows,
            &pty::PtyEnvironment {
                shell_token: shell_token.as_deref(),
                open_url_bin_dir: args.open_url_bin_dir.as_deref(),
                image_endpoint: &native_images.path,
                image_credential: &native_images.credential,
            },
            pty_event_tx,
            buffer_return_rx,
        )?;
        drop(native_images);
        pty_handle
    };
    // The simulated program is a task on this host; it reads no environment
    // and sends no images.
    #[cfg(merkur_sim)]
    let pty_handle = {
        // The simulated program owns the bytes it writes; nothing recycles.
        drop(buffer_return_rx);
        simulated_pty.spawn(pty_event_tx)
    };
    let (mut pty_writer, mut pty_write_completion_rx) = PtyWriter::new(pty_handle.writer)?;
    let pty_master = pty_handle.master;
    let mut pty_child = pty_handle.child;

    let pid = pty_child
        .process_id()
        .ok_or("spawned PTY did not expose a process id")?;
    send_json_event(&event_tx, EVT_PTY_READY, &PtyReadyEvt { pid });

    if let Some(token) = shell_token.as_deref() {
        terminal.set_shell_token(token.as_bytes().into());
    }
    // Termios + foreground-pgrp sampling costs two syscalls. Coalesce it with
    // the next display flush instead of paying it for every 32 KiB PTY read;
    // retain the pending bit while no peer can consume display state.
    // One owner for every display allocation the flush chain borrows; see
    // `DisplayScratch`.
    let mut display_scratch = DisplayScratch::new(4);
    let (
        mut display_prepare_worker,
        mut display_prepare_completion_rx,
        mut snapshot_prepare_completion_rx,
        mut dictionary_prepare_completion_rx,
    ) = start_display_prepare_worker();
    // One owner for every browser-identity-keyed registry; see `PeerRegistry`.
    let mut registry = PeerRegistry::new();
    // Owner-loop-owned destination for inbound terminal opens. Kept here rather
    // than on the peer so the opened plaintext borrows something disjoint from
    // the peer map, leaving dispatch free to take that map mutably. It grows to
    // the largest frame the session has seen and is never truncated, so a
    // steady inbound frame is opened with no allocation and no zero-fill.
    // Keep every buffer in the retention/scratch rotation at full ingress capacity.
    let mut inbound_plaintext_scratch = vec![0; network::peer::MAX_INBOUND_FRAME_BYTES];
    let mut last_bell_event_at: Option<Instant> = None;

    let (traversal_tx, mut traversal_rx) = webtransport::traversal::channel();
    let mut traversal = webtransport::traversal::Owner::new();
    let mut wt_state: Option<Arc<RwLock<WebTransportState>>> = None;
    let mut wt_server: Option<webtransport::WebTransportServer> = None;
    let mut session_authority: Option<SessionAuthority> = None;
    let mut daemon_identity: Option<DaemonIdentity> = None;
    let mut user_authorization: Option<UserAuthorization> = None;
    // Completed per-session edge dials are handed back over `edge_attach_rx`
    // and generation-checked against the dial registry. Primary and bulk complete
    // independently, so neither lane may clear or overwrite the other.
    let (edge_attach_tx, mut edge_attach_rx) = mpsc::channel::<EdgeAttach>(EDGE_ATTACH_QUEUE_DEPTH);
    let (edge_lane_closed_tx, mut edge_lane_closed_rx) =
        mpsc::channel::<EdgeLaneEvent>(EDGE_ATTACH_QUEUE_DEPTH);
    let mut cancelled_sessions = CancelledSessions::default();
    let mut next_edge_lane_generation: EdgeLaneGeneration = 0;
    // Monotonic time of the most recent server-lease-derived command. Negative
    // infinity until the first one lands, so a daemon that has never completed
    // a lease refuses rebinds outright rather than admitting them on an
    // unproven control link.
    let mut last_control_lease_at_ms = f64::NEG_INFINITY;
    // Noise E2E is mandatory. Every peer receives a fresh PSK derived from its
    // successful pairwise hybrid authentication; no process-wide PSK exists.
    let daemon_static = match e2e::generate_static_keypair() {
        Ok((private, _public)) => Zeroizing::new(private),
        Err(e) => {
            error!("failed to mint daemon Noise static key: {e}");
            return Err(Box::new(e));
        }
    };

    // Event-driven flush: one-shot sleep armed only when terminal is dirty
    // and peers need display updates. Replaces the 1ms polling interval.
    let flush_sleep = tokio::time::sleep(Duration::from_secs(86400));
    tokio::pin!(flush_sleep);
    let mut prediction_safety_sample_pending = false;
    let mut flush_armed = false;
    let synchronized_update_sleep = tokio::time::sleep(Duration::from_secs(86400));
    tokio::pin!(synchronized_update_sleep);
    let mut synchronized_update_timer = SynchronizedUpdateDeadline::default();
    let mut display_flush_cursor = DisplayFlushCursor::default();
    // One tracker for the daemon rather than one per peer: there is a single
    // PTY, so the shell-turnaround term is shared by definition. A browser
    // enabling profiling enables it for the process; with one viewer, which is
    // the profiling case, that distinction does not arise.
    let mut perf_timing = PerfTimingTracker::default();
    // Profiling records never write CTRL inline from display flush/completion.
    // A full batch arms `now`; a partial tail arms at +20 ms, and this separate
    // owner turn offers exactly one batch before rearming any remainder.
    let perf_timing_sleep = tokio::time::sleep(Duration::from_secs(86_400));
    tokio::pin!(perf_timing_sleep);
    let mut perf_timing_armed = false;
    let mut perf_timing_maintenance = PerfTimingMaintenanceGate::default();

    // Level, not timer: set by any turn that queues an input ack on a peer,
    // consumed by the flush at the bottom of that same turn. It lives outside
    // the loop so an arm that `continue`s past the bottom leaves it set and
    // the next turn flushes — an ack is never stranded and never deferred.
    let mut input_ack_pending = false;
    // Same shape for the display flush: set by any arm whose scheduling
    // decision came back as `Some(0)` — a drained PTY read, a completed
    // prepare, a peer that just became display-ready — or by the flush timer
    // when a carried wait elapses, and consumed by the flush at the bottom of
    // the same turn. There is no zero-delay timer rearm on this path at all.
    let mut flush_now = false;

    // One owner-loop timer tracks the earliest pre-auth rendezvous deadline.
    // Deadlines carry session + generation identity; no detached expiry task can
    // race a replacement session or retain state past run-loop shutdown.
    let edge_preauth_sleep = tokio::time::sleep(Duration::from_secs(86_400));
    tokio::pin!(edge_preauth_sleep);
    let mut edge_preauth_timer_owner: Option<EdgePreauthDeadline> = None;

    let mut cert_rotation_timer = tokio::time::interval_at(
        tokio::time::Instant::now() + Duration::from_secs(CERT_ROTATION_CHECK_SECS),
        Duration::from_secs(CERT_ROTATION_CHECK_SECS),
    );
    cert_rotation_timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    let mut heartbeat_timer = tokio::time::interval(Duration::from_secs(2));
    heartbeat_timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    // Telemetry sampling is a subdivision of the heartbeat tick; see the
    // emission site in the heartbeat arm below.
    let mut stats_tick: u32 = 0;
    let mut stats_window_started_at = Instant::now();
    let mut stats_events_dropped: u64 = 0;
    // Keepalive rides the same tick. The resolved vantage address is cached
    // because it never changes for a given credential and a DNS lookup every
    // 14 s would be pure waste.
    let mut nat_keepalive_tick: u32 = 0;
    let mut nat_keepalive_vantage: Option<std::net::SocketAddr> = None;
    // When the port-mapping lease next needs attention. A deadline rather than
    // an interval, because the cadence is the gateway's to choose: renewal is
    // half the lifetime it actually granted, which a fixed timer cannot
    // express. `None` means no lease and no pending retry.
    let mut nat_mapping_renew_at: Option<tokio::time::Instant> = None;
    // Gateway reboot announcements. The listener exists only once a mapping
    // cycle has named an egress interface; the receiver pends until then, and
    // the sender is held here so the arm never observes a closed channel.
    let (announce_tx, mut announce_rx) =
        mpsc::channel::<webtransport::portmap::announce::Announcement>(1);
    let mut announce_listener: Option<AnnounceListener> = None;

    // One-shot renewal starts only after a server has installed mapping owners.
    // Keeping it disarmed avoids Tokio interval's immediate first tick.
    // Capacity 1: "the path changed recently" is idempotent, so a full channel
    // already carries the only signal a consumer needs.
    let (network_path_tx, mut network_path_rx) = mpsc::channel::<NetworkPathEdge>(1);
    let network_path_task = spawn_network_path_watcher(network_path_tx);
    let mut network_path_watch_active = network_path_task.is_some();

    // Replaced on every control heartbeat. `None` until the daemon registers,
    // so the very first credential is the one that lets the listener start.
    let mut stun_credential: Option<webtransport::stun::StunCredential> = None;
    // The daemon id (from configure) and the newest attach ticket (from each
    // control lease); every edge dial reads it when it connects.
    let edge_admission = edge_tunnel::EdgeAdmission::default();

    // `configure` asked for a WebTransport listener before any STUN credential
    // existed, so the listener is waiting for one.
    //
    // The IPv6 reachability probe binds the pinned port and must run *before*
    // quinn takes it, and `start_server` is the only place that runs it —
    // `Rotation` and `Reprobe` deliberately never re-run it, because quinn
    // holds that port with no `SO_REUSEPORT` and a second bind would be
    // `EADDRINUSE`. So the single `Startup` a daemon performs is the only
    // chance to answer the question at all.
    //
    // Starting on `configure` spends that chance blind every time: the daemon
    // spawns and configures the dataplane synchronously, while the credential
    // only arrives with control registration a few hundred milliseconds later.
    // Production showed `no STUN credential yet` followed by
    // `ipv6_reachability="unknown"` on every boot, with the credential landing
    // ~205 ms after the probe had already given up.
    //
    // Waiting costs nothing that can be served anyway. Every session is issued
    // over the control connection, so a daemon that has not registered has no
    // session to carry, no edge tunnel, and no direct carrier to upgrade — and
    // readiness is published from `pty_ready`, never from `webtransport_ready`,
    // so the watchdog is unaffected. A registration that succeeds always
    // carries a credential: the fields are mandatory in the `registered`
    // message and a malformed list is a protocol violation, not an omission.
    //
    // Tracked explicitly rather than inferred from `wt_state.is_none()`,
    // because a *rejected* configure must not start a listener that has no
    // session authority behind it.
    let mut wt_start_awaiting_credential = false;

    let mut running = true;
    let mut fatal_event_failure: Option<EventSinkFailure> = None;
    let mut fatal_ipc_failure: Option<io::Error> = None;
    let start_instant = Instant::now();
    let mut rebind_telemetry = session::rebind_flow::RebindTelemetry::new(event_tx.clone());
    // The display path's only source of scheduling time. `now_ms_since` reads
    // the same epoch, so the two can never disagree.
    let display_clock = crate::display::clock::FlushClock::Epoch(start_instant);
    let graphics_wake = terminal.graphics_wake();
    // One owned reader buffer survives a semantic pause. The bounded reader
    // channel is not drained until its suffix has been accepted; no copy or
    // growing side queue can bypass PTY backpressure.
    let mut pending_pty_read: Option<(pty::PtyRead, usize, Option<pty::PtyTraceStamp>)> = None;

    while running {
        // The network simulator's stand-in for the PTY writer and display
        // preparation threads: what they would have done by now happens here,
        // before this turn selects (`sim`).
        #[cfg(merkur_sim)]
        {
            pty_writer.run_inline();
            display_prepare_worker.run_inline();
        }
        // Parked state can become unreachable in several branches (TTL expiry,
        // cap eviction, or revocation clear). Reconcile those removals before
        // selecting another event so no queued ingress or lane-close event can
        // resurrect transport ownership for an identity that can no longer
        // resume.
        let removed_parked_peer_ids = registry
            .parked
            .take_removed_peer_ids()
            .into_iter()
            .filter(|peer_id| !registry.peers.contains_key(peer_id))
            .collect();
        retire_peer_transport_ownership(
            removed_parked_peer_ids,
            &mut registry,
            &network_state,
            &wt_state,
        )
        .await;

        let perf_owner_is_live = perf_timing.owner_peer_id().is_none_or(|peer_id| {
            registry
                .peers
                .get(peer_id.as_ref())
                .is_some_and(|peer| perf_timing.owns(peer_id.as_ref(), &peer.signal_session_id))
        });
        if !perf_owner_is_live {
            perf_timing.clear_owner();
            perf_timing_maintenance.clear();
        }
        match (
            perf_timing_maintenance.is_due(),
            perf_timing.next_wire_deadline(),
        ) {
            (false, Some(deadline)) => {
                let deadline = tokio::time::Instant::from_std(deadline);
                if !perf_timing_armed || perf_timing_sleep.deadline() != deadline {
                    perf_timing_sleep.as_mut().reset(deadline);
                }
                perf_timing_armed = true;
            }
            _ => perf_timing_armed = false,
        }

        let edge_now_ms = now_ms_since(start_instant);
        let expired_edge_owners = take_expired_edge_preauth(&mut registry.edge_dials, edge_now_ms);
        if !expired_edge_owners.is_empty() {
            retire_edge_preauth_ownership(expired_edge_owners, &mut registry.peers, &network_state)
                .await;
        }
        let next_edge_owner = next_edge_preauth_deadline(&registry.edge_dials);
        if next_edge_owner != edge_preauth_timer_owner {
            if let Some(owner) = next_edge_owner.as_ref() {
                let delay_ms = (owner.lease.expires_at_ms - edge_now_ms).max(0.0);
                edge_preauth_sleep.as_mut().reset(
                    tokio::time::Instant::now() + Duration::from_secs_f64(delay_ms / 1_000.0),
                );
            }
            edge_preauth_timer_owner = next_edge_owner;
        }

        synchronized_update_timer.update(
            terminal.synchronized_update_deadline(),
            terminal.synchronized_update_lifetime_epoch(),
        );
        // A browser that left while focused never sent its focus-out; the
        // turn that finds it gone reports it, once, for the terminal.
        if let Some(report) =
            terminal.release_departed_focus(|peer| registry.peers.contains_key(peer))
            && let Err(error) = pty_writer.try_enqueue_terminal_reply(report.to_vec())
        {
            error!("failed to queue focus report: {error:?}");
            running = false;
        }
        if let Some(deadline) = synchronized_update_timer.deadline {
            let deadline = tokio::time::Instant::from_std(deadline);
            if synchronized_update_sleep.deadline() != deadline {
                synchronized_update_sleep.as_mut().reset(deadline);
            }
        }
        // Any arm that advances the parser can publish a source root: the PTY
        // read, the graphics wake, and a forced synchronized-update drain.
        if terminal.take_published_roots() {
            assets::unpark(&mut registry.peers, &terminal, now_ms_since(start_instant));
        }
        // The removed source's physical release a waiting graphics admission or a
        // deferred projection needs, owned outside the select futures so none of
        // them borrows the terminal.
        let graphics_release = terminal.graphics_release();

        tokio::select! {
            Some(completion) = identity_completion_rx.recv() => {
                let peer_id = Arc::clone(&completion.peer_id);
                let Some(pending) = registry.peers.get(&*peer_id).and_then(|peer| peer.pending_identity_signature.as_ref()).filter(|pending| completion.matches(pending)) else { continue; };
                let ingress = pending.ingress.clone();
                if let Some(ingress) = &ingress
                    && !is_current_ingress_generation(&wt_state, &registry.edge_dials, &peer_id, PeerTransport::Edge, ingress.generation, Some(ingress)).await {
                    if let Some(peer) = registry.peers.get_mut(&*peer_id) { peer.pending_identity_signature = None; }
                    continue;
                }
                let authenticated = session::auth_flow::finish_identity_signature(
                    completion, &wt_state, &network_state, &event_tx, &mut registry.peers,
                    &mut registry.parked, now_ms_since(start_instant), &daemon_static,
                ).await;
                release_edge_preauth_lease(&mut registry.edge_dials, &peer_id, ingress.as_ref(), authenticated);
            }
            _ = assets::COMPLETED.notified() => {
                assets::reap(&mut registry.peers, &terminal, now_ms_since(start_instant));
            }
            _ = display::send::CARRIER_UNBLOCKED.notified() => {
                // A carrier only probes could leave has reopened. Re-read every
                // peer's carriers, so held display resumes exactly where its
                // own carrier reopened, then schedule as after any lifecycle.
                display::send::observe_all_carrier_blocks(&mut registry.peers);
                advance_display_flush_after_lifecycle(
                    flush_sleep.as_mut(),
                    &mut flush_armed,
                    &mut flush_now,
                    &registry.peers,
                    terminal.pending_display_damage(),
                    terminal.current_display_header_signal(),
                    &display_scratch.current_row_hashes,
                    now_ms_since(start_instant),
                );
            }
            () = async { if let Some(release) = &graphics_release { release.wait().await } }, if graphics_release.is_some() => {
                // Observing drops the landed releases and clears both waits, so
                // this arm cannot spin: a projection still short defers again, and
                // a waiting admission, woken on the PTY arm, waits again.
                terminal.observe_graphics_release();
                advance_display_flush_after_lifecycle(
                    flush_sleep.as_mut(),
                    &mut flush_armed,
                    &mut flush_now,
                    &registry.peers,
                    terminal.pending_display_damage(),
                    terminal.current_display_header_signal(),
                    &display_scratch.current_row_hashes,
                    now_ms_since(start_instant),
                );
            }
            Some(completion) = management_signatures.join_next(), if !management_signatures.is_empty() => {
                if let Ok((command_id, result)) = completion {
                    match result {
                        Ok(pair) => {
                            send_json_event(&event_tx, EVT_DAEMON_PROOF, &DaemonProofEvt {
                                command_id: &command_id,
                                signature: base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(pair.mldsa),
                                p256_signature: base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(pair.p256),
                            });
                            accept_command(&event_tx, &command_id);
                        }
                        Err(_) => reject_command(&event_tx, &command_id, "identity_signing_failed"),
                    }
                }
            }
            Some(request) = traversal_rx.recv() => {
                traversal.enqueue(request, &registry.peers);
            }
            _ = traversal.ready(), if traversal.active() => {
                traversal.advance(&registry.peers);
            }
            () = std::future::ready(()), if traversal.has_dispositions() => {
                // Each punch's outcome, addressed to the manifest it served.
                let dispositions: Vec<_> = traversal.take_dispositions().collect();
                for disposition in &dispositions {
                    session::wt_upgrade_flow::send_punch_outcome(&network_state, disposition).await;
                }
            }

            _ = &mut synchronized_update_sleep, if synchronized_update_timer.deadline.is_some() => {
                if terminal.stop_synchronized_update() {
                    if !enqueue_terminal_events(&terminal_event_rx, &mut pty_writer) {
                        running = false;
                    }
                    // Forced release revokes editor evidence in TerminalState.
                    // Normal physical admission/capacity gates still run at flush.
                    arm_display_flush_no_later(
                        flush_sleep.as_mut(),
                        &mut flush_armed,
                        tokio::time::Instant::now(),
                    );
                }
            }
            _ = &mut perf_timing_sleep, if perf_timing_armed => {
                perf_timing_armed = false;
                // Waking the maintenance level performs no encoding, locking,
                // or transport work. The bottom of the turn re-derives the
                // level from the tracker's deadline, so this arm only exists
                // to wake an otherwise idle loop for a partial tail.
                perf_timing_maintenance.mark_due(Instant::now());
            }
            completion = dictionary_prepare_completion_rx.recv() => {
                let Some(completion) = completion else {
                    // The `merkur-display-dict` thread exits only when this
                    // loop's handle on it is gone, so a closed channel here is
                    // a bug, not a state to run on without dictionaries. What
                    // keeps a dictionary build from ever costing a keystroke
                    // is that it runs on its own thread, not a degraded mode
                    // entered from here.
                    error!("display dictionary worker completion channel closed");
                    running = false;
                    continue;
                };
                finish_dictionary_prepare(completion, &mut display_prepare_worker);
                // Installing a prepared dictionary may expose work. Re-enter
                // through the same scheduling decision as every other
                // lifecycle completion.
                advance_display_flush_after_lifecycle(
                    flush_sleep.as_mut(),
                    &mut flush_armed,
                    &mut flush_now,
                    &registry.peers,
                    terminal.pending_display_damage(),
                    terminal.current_display_header_signal(),
                    &display_scratch.current_row_hashes,
                    now_ms_since(start_instant),
                );
            }
            completion = display_prepare_completion_rx.recv() => {
                let Some(completion) = completion else {
                    error!("display preparation worker completion channel closed");
                    running = false;
                    continue;
                };
                finish_display_prepare(
                    completion,
                    terminal.display_revision(),
                    &mut registry.peers,
                    &mut display_prepare_worker,
                    now_ms_since(start_instant),
                    Some(&mut perf_timing),
                ).await;
                // The prepare that just completed was what held its peer out
                // of scheduling. Re-enter through the same scheduling decision
                // as a PTY read; with nothing left to coalesce against, a
                // peer that now has work flushes at the bottom of this turn.
                schedule_display_flush(
                    compute_next_flush_delay_ms(
                        &registry.peers,
                        terminal.pending_display_damage(),
                        terminal.current_display_header_signal(),
                        &display_scratch.current_row_hashes,
                        now_ms_since(start_instant),
                    ),
                    flush_sleep.as_mut(),
                    &mut flush_armed,
                    &mut flush_now,
                );
            }

            completion = snapshot_prepare_completion_rx.recv() => {
                let Some(completion) = completion else {
                    error!("display snapshot preparation worker completion channel closed");
                    running = false;
                    continue;
                };
                finish_snapshot_prepare(
                    completion,
                    terminal.display_revision(),
                    &mut display_scratch.buffers,
                    &mut registry.peers,
                    now_ms_since(start_instant),
                ).await;
                flush_sleep.as_mut().reset(tokio::time::Instant::now());
                flush_armed = true;
            }

            _ = &mut edge_preauth_sleep, if edge_preauth_timer_owner.is_some() => {
                // Expire at the top of the next owner turn. Removing every map
                // owner happens before cleanup awaits, making queued attach and
                // lane-close completions stale by construction.
                edge_preauth_timer_owner = None;
                continue;
            }

            failure = event_failure_rx.recv() => {
                let failure = failure.unwrap_or(EventSinkFailure::WriterStopped);
                error!("fatal stdout event sink failure: {failure}");
                fatal_event_failure = Some(failure);
                let _ = pty_child.kill();
                running = false;
            }

            completion = pty_write_completion_rx.recv() => {
                let Some(completion) = completion else {
                    error!("PTY writer completion channel closed");
                    running = false;
                    continue;
                };
                match handle_pty_write_completions(
                    completion,
                    &mut pty_write_completion_rx,
                    &mut pty_writer,
                    &mut terminal,
                    &mut registry.peers,
                    &mut registry.parked,
                    &mut registry.input_refill,
                    &mut perf_timing,
                ) {
                    Ok(turn) => input_ack_pending |= turn.input_ack_queued,
                    Err(()) => running = false,
                }
                // A reordered line submission can enter the PTY FIFO while a
                // prior write completion drains the peer buffer. Its
                // prediction-safety revocation is display metadata and must
                // arm the same prompt flush as direct input admission.
                schedule_display_flush(
                    compute_next_flush_delay_ms(
                        &registry.peers,
                        terminal.pending_display_damage(),
                        terminal.current_display_header_signal(),
                        &display_scratch.current_row_hashes,
                        now_ms_since(start_instant),
                    ),
                    flush_sleep.as_mut(),
                    &mut flush_armed,
                    &mut flush_now,
                );
            }

            completion = wt_maintenance_completion_rx.recv() => {
                let Some(completion) = completion else {
                    error!("WebTransport maintenance completion channel closed");
                    running = false;
                    continue;
                };
                let completion_generation = completion.generation;
                let Some(accepted) = wt_maintenance_owner.accept(completion) else {
                    trace!(
                        generation = completion_generation,
                        "discarded stale WebTransport maintenance completion"
                    );
                    continue;
                };
                if wt_maintenance_task
                    .as_ref()
                    .is_some_and(|(generation, _)| *generation == completion_generation)
                {
                    wt_maintenance_task.take();
                }

                match (accepted.kind, accepted.result) {
                    (
                        WtMaintenanceKind::Startup,
                        WtMaintenanceResult::Server(Ok((endpoint, cert_state, info))),
                    ) => {
                        wt_maintenance_owner.take_queued(WtMaintenanceKind::Startup);
                        let new_state = Arc::new(RwLock::new(
                            WebTransportState::from_server_info(cert_state, &info),
                        ));
                        new_state.write().await.traversal_requests = Some(traversal_tx.clone());
                        let new_server = webtransport::WebTransportServer::spawn(
                            endpoint,
                            new_state.clone(),
                            peer_msg_tx.clone(),
                            peer_event_tx.clone(),
                        );
                        wt_state = Some(new_state);
                        let retired_connections =
                            webtransport::replace_server(&mut wt_server, new_server).await;
                        let retired_count = retire_replaced_webtransport_connections(
                            retired_connections,
                            &wt_state,
                            &mut registry.wt_temp_to_real,
                            &mut registry.wt_upgrade_pending,
                            &mut registry.peers,
                        )
                        .await;
                        advance_display_flush_after_lifecycle(
                            flush_sleep.as_mut(),
                            &mut flush_armed,
                            &mut flush_now,
                            &registry.peers,
                            terminal.pending_display_damage(),
                            terminal.current_display_header_signal(),
                            &display_scratch.current_row_hashes,
                            now_ms_since(start_instant),
                        );
                        if retired_count > 0 {
                            info!(
                                retired_connections = retired_count,
                                "retired replaced WebTransport server lifecycle ownership"
                            );
                        }
                        if let Some(state) = wt_state.as_ref() {
                            let state = state.read().await;
                            emit_webtransport_ready(
                                &event_tx,
                                &state.cert_state,
                                info.port,
                                &info.candidates,
                                info.ipv6_reachability,
                            );
                        }
                        // The first probe must follow accept-loop installation:
                        // otherwise its independent observer is contacted before
                        // a WT callback can be admitted. One queued reprobe also
                        // absorbs any network edge that arrived during startup.
                        wt_maintenance_owner.request(WtMaintenanceKind::Reprobe);
                        // Arm the first mapping cycle. Deliberately *after* the
                        // candidate set is published and the ready event is out:
                        // a gateway that neither answers nor refuses costs the
                        // full retransmission schedule, and nothing about that
                        // should delay a session reaching the edge relay. A won
                        // lease arrives later in a new manifest.
                        nat_mapping_renew_at = Some(tokio::time::Instant::now());
                        info!(
                            port = info.port,
                            operation = ?accepted.kind,
                            "WebTransport server maintenance committed"
                        );
                    }
                    (
                        WtMaintenanceKind::Startup,
                        WtMaintenanceResult::Server(Err(message)),
                    ) => {
                        warn!(operation = ?accepted.kind, "WebTransport server maintenance failed: {message}");
                    }
                    (WtMaintenanceKind::Rotation, WtMaintenanceResult::Rotation(Ok((config, cert_state)))) => {
                        // Swap the TLS config on the live socket, then publish the
                        // hash it produced. Publishing first would advertise a
                        // certificate the endpoint is not yet serving, and every
                        // browser that raced the gap would be refused for a hash
                        // mismatch it can do nothing about.
                        match wt_server.as_ref() {
                            Some(server) => match server.reload_certificate(config) {
                                Ok(()) => {
                                    traversal.invalidate();
                                    let cert_b64 = cert_state.cert_hash_base64();
                                    if let Some(state) = wt_state.as_ref() {
                                        state.write().await.cert_state = cert_state;
                                    }
                                    info!(
                                        cert_hash = %cert_b64,
                                        "WebTransport certificate rotated in place"
                                    );
                                    // Established connections keep the identity
                                    // they negotiated; only new dials need the new
                                    // hash, so the new manifest is the whole handoff.
                                    broadcast_webtransport_manifests(
                                        &wt_state,
                                        &network_state,
                                        &mut registry.peers,
                                        "certificate rotation",
                                    )
                                    .await;
                                }
                                Err(error) => {
                                    error!("WebTransport certificate reload failed: {error}");
                                }
                            },
                            None => {
                                error!("certificate rotation completed with no live WebTransport server");
                            }
                        }
                    }
                    (WtMaintenanceKind::Rotation, WtMaintenanceResult::Rotation(Err(message))) => {
                        // Past `CERT_VALIDITY_DAYS` the endpoint serves an expired
                        // self-signed certificate and every browser dial pinning
                        // `serverCertificateHashes` is refused, so this is the
                        // direct path going away rather than a degraded one.
                        error!("WebTransport certificate rotation failed: {message}");
                    }
                    (
                        WtMaintenanceKind::Reprobe,
                        WtMaintenanceResult::Reprobe(reprobe),
                    ) => {
                        // A new manifest reaches every attached browser, and each
                        // endpoint new to one joins its race as a fresh QUIC
                        // handshake. That is worth it when the reachable set actually moved and is
                        // pure waste when it did not — and reprobes are no longer
                        // rare, since a daemon whose gateway maps nothing now asks
                        // for one at startup and on every failed renewal. Compare
                        // before publishing.
                        let mut changed = false;
                        // A path edge the lease did not see: the egress
                        // interface or first hop moved out from under it, or a
                        // gateway appeared where there was none. Renewal
                        // would only re-assert a mapping on the wrong device.
                        let mut remap = false;
                        if let Some(state) = wt_state.as_ref() {
                            let mut state = state.write().await;
                            state.discovery_evidence = reprobe.discovery_evidence;
                            state.stun_local_ip = reprobe.stun_local_ip;
                            changed = state.candidates != reprobe.candidates
                                || state.nat_signature != reprobe.nat_signature
                                || state.nat_mapping != reprobe.nat_mapping
                                || state.daemon_srflx != reprobe.daemon_srflx;
                            if changed {
                                state.candidates = reprobe.candidates.clone();
                                state.nat_signature = reprobe.nat_signature.clone();
                                state.nat_mapping = reprobe.nat_mapping;
                                state.daemon_srflx = reprobe.daemon_srflx;
                            }
                            remap = match (&state.port_lease, &reprobe.egress) {
                                (Some(lease), Some(egress)) => {
                                    egress.interface_index != lease.interface_index
                                        || egress.gateway != Some(lease.gateway)
                                        || egress.local_ipv4 != lease.local_ipv4
                                }
                                (None, Some(egress)) => {
                                    egress.gateway.is_some() && nat_mapping_renew_at.is_none()
                                }
                                (_, None) => false,
                            };
                            // Startup no longer waits for probes. Carry completed
                            // IPv6 evidence through the existing IPC/metric path.
                            emit_webtransport_ready(
                                &event_tx,
                                &state.cert_state,
                                state.port,
                                &state.candidates,
                                reprobe.ipv6_reachability,
                            );
                        }
                        if changed {
                            broadcast_webtransport_manifests(
                                &wt_state,
                                &network_state,
                                &mut registry.peers,
                                "network reprobe",
                            )
                            .await;
                        } else {
                            info!("reprobe produced an identical candidate set; no new manifest");
                        }
                        if remap {
                            info!("egress path moved under the port-mapping lease; re-mapping");
                            nat_mapping_renew_at = None;
                            wt_maintenance_owner.request(WtMaintenanceKind::Mapping);
                        }
                    }
                    (WtMaintenanceKind::Mapping, WtMaintenanceResult::Mapping(cycle)) => {
                        let lease_key = cycle.lease.metric_key();
                        let pinhole_key = cycle.pinhole.metric_key();
                        let lease = cycle.lease.lease();
                        let pinhole = cycle.pinhole.pinhole();
                        // Every arm is reported, including the ones that sent no
                        // request. "Not attempted, and why" must stay separable
                        // from "the gateway refused" — collapsing them is what
                        // let thirty days of zeroes read as a protocol verdict
                        // when it was a routing one. The v4 lease and the v6
                        // pinhole are separate leases, so two outcomes.
                        send_json_event(
                            &event_tx,
                            EVT_NAT_MAPPING_OUTCOME,
                            &NatMappingOutcomeEvt { outcome: lease_key },
                        );
                        send_json_event(
                            &event_tx,
                            EVT_NAT_MAPPING_OUTCOME,
                            &NatMappingOutcomeEvt { outcome: pinhole_key },
                        );

                        let changed = if let Some(state) = wt_state.as_ref() {
                            let mut state = state.write().await;
                            let previous = state
                                .port_lease
                                .as_ref()
                                .map(|lease| lease.candidate());
                            let next = lease.as_ref().map(|lease| lease.candidate());
                            state.port_lease = lease.clone();
                            let mut changed = false;
                            if previous != next {
                                state
                                    .candidates
                                    .retain(|c| c.kind != webtransport::CandidateFlavor::NatMap);
                                if let Some(candidate) = next.clone() {
                                    // Ahead of the host candidates: the browser
                                    // races in emission order, and a mapped
                                    // port needs no traversal at all.
                                    let at = state
                                        .candidates
                                        .iter()
                                        .position(|c| {
                                            !matches!(
                                                c.kind,
                                                webtransport::CandidateFlavor::Srflx
                                            )
                                        })
                                        .unwrap_or(state.candidates.len());
                                    state.candidates.insert(at, candidate);
                                }
                                changed = true;
                            }
                            let previous_pinhole = state.pinholed_v6();
                            state.v6_pinhole = pinhole.clone();
                            if let Some(address) = state.pinholed_v6()
                                && previous_pinhole != Some(address)
                                && webtransport::promote_pinholed_host6(
                                    &mut state.candidates,
                                    address,
                                )
                            {
                                changed = true;
                            }
                            changed
                        } else {
                            false
                        };

                        // Renew at half the lifetime the gateway actually
                        // granted, whichever of the two leases comes first. A
                        // fixed interval against an assumed 3600 s lets a
                        // gateway that grants 120 s lapse twenty-eight times
                        // over before anyone notices.
                        let renew_after = match (lease.as_ref(), pinhole.as_ref()) {
                            (Some(lease), Some(pinhole)) => {
                                Some(lease.renew_after().min(pinhole.renew_after()))
                            }
                            (Some(lease), None) => Some(lease.renew_after()),
                            (None, Some(pinhole)) => Some(pinhole.renew_after()),
                            (None, None) => None,
                        };
                        nat_mapping_renew_at =
                            renew_after.map(|after| tokio::time::Instant::now() + after);

                        // The announcement listener follows the egress link the
                        // cycle actually used.
                        if let Some(egress) = cycle.egress.as_ref()
                            && announce_listener
                                .as_ref()
                                .is_none_or(|held| held.egress != *egress)
                        {
                            if let Some(previous) = announce_listener.take() {
                                previous.abort();
                            }
                            announce_listener = AnnounceListener::bind(egress, announce_tx.clone());
                        }

                        info!(
                            lease = %lease_key,
                            pinhole = %pinhole_key,
                            reoffer = changed,
                            "port-mapping cycle complete"
                        );
                        if changed {
                            broadcast_webtransport_manifests(
                                &wt_state,
                                &network_state,
                                &mut registry.peers,
                                "port mapping",
                            )
                            .await;
                        }
                    }
                    (_, WtMaintenanceResult::Failed(message)) => {
                        warn!(operation = ?accepted.kind, "WebTransport maintenance skipped: {message}");
                    }
                    (expected, _) => {
                        error!(operation = ?expected, "mismatched WebTransport maintenance completion");
                    }
                }

                start_next_wt_maintenance(
                    &mut wt_maintenance_owner,
                    &mut wt_maintenance_task,
                    &wt_state,
                    args.wt_binding(),
                    stun_credential.as_ref(),
                    &wt_maintenance_completion_tx,
                )
                .await;
            }

            event = async {
                if terminal.graphics_pending() {
                    graphics_wake.notified().await;
                    None
                } else {
                    Some(pty_async_rx.recv().await)
                }
            } => {
                macro_rules! advance_pty_read {
                    () => {
                        // Draining only once at arm entry misses completions
                        // published between the reads in this bounded batch.
                        // Confirm queued writes before *each* parser advance,
                        // including a read resumed after image-worker work.
                        if let Ok(completion) = pty_write_completion_rx.try_recv() {
                            match handle_pty_write_completions(
                                completion,
                                &mut pty_write_completion_rx,
                                &mut pty_writer,
                                &mut terminal,
                                &mut registry.peers,
                                &mut registry.parked,
                                &mut registry.input_refill,
                                &mut perf_timing,
                            ) {
                                Ok(turn) => input_ack_pending |= turn.input_ack_queued,
                                Err(()) => running = false,
                            }
                        }
                        if let Some((bytes, offset, _)) = &mut pending_pty_read {
                            *offset += terminal.apply_bytes(&bytes[*offset..]);
                        } else {
                            // A forced synchronized-output drain can pause on an
                            // image command without a physical read to retain.
                            terminal.apply_bytes(&[]);
                        }
                        if !terminal.graphics_pending()
                            && let Some((bytes, offset, trace)) = pending_pty_read.take()
                        {
                            debug_assert_eq!(offset, bytes.len());
                            if let Some(trace) = trace {
                                trace.record(Instant::now(), pty::PtyTraceEvent::ReadGridApplied { read_ordinal: trace.ordinal });
                            }
                            if perf_timing.is_enabled() {
                                perf_timing.note_grid_applied(Instant::now());
                            }
                            let _ = buffer_return_tx.send(bytes.into_buffer());
                        }
                        // Output timing decides which display states consume a
                        // browser grant (`display::credit`).
                        display::send::note_display_output(
                            &mut registry.peers,
                            now_ms_since(start_instant),
                        );
                        prediction_safety_sample_pending = true;
                        if !enqueue_terminal_events(&terminal_event_rx, &mut pty_writer) {
                            running = false;
                        }
                        if terminal.take_bell() {
                            terminal.terminal_ui().push(merkur_wire::terminal_ui::TerminalUi::Bell);
                            let now = Instant::now();
                            if last_bell_event_at.is_none_or(|last| {
                                now.duration_since(last) >= Duration::from_millis(BELL_EVENT_MIN_INTERVAL_MS)
                            }) {
                                last_bell_event_at = Some(now);
                                let _ = event_tx.send_raw(EVT_BELL, Vec::new());
                            }
                        }
                    };
                }
                // One terminal event, applied in place. A macro rather than a
                // function because the body owns a dozen loop locals; it is
                // expanded twice, for the event that woke this arm and for
                // every event the reader thread had already queued behind it.
                macro_rules! apply_terminal_event {
                    ($event:expr) => {
                        match $event {
                            Some(TerminalEvent::PtyBytes(bytes, trace)) => {
                                if let Some(trace) = trace {
                                    trace.record(Instant::now(), pty::PtyTraceEvent::ReadOwnerHandled { read_ordinal: trace.ordinal });
                                }
                                // `apply_bytes` observes canonical shell boundaries as
                                // part of applying, so a bracketed-paste disable in
                                // this chunk is visible to the coalesced point-in-time
                                // termios/process-group sample below.
                                // The existing wire term ends at owner handling, not
                                // physical read or shell response. The native trace
                                // independently measures the reader/owner boundary.
                                // The clock is read only when someone is listening —
                                // `PerfTimingTracker`'s own contract.
                                if perf_timing.is_enabled() {
                                    perf_timing.note_pty_read(Instant::now());
                                }
                                debug_assert!(pending_pty_read.is_none());
                                pending_pty_read = Some((bytes, 0, trace));
                                advance_pty_read!();
                            }
                            Some(TerminalEvent::PtyWrite(bytes)) => {
                                if let Err(error) = pty_writer.try_enqueue_terminal_reply(bytes) {
                                    error!("failed to queue PTY response: {error:?}");
                                    running = false;
                                }
                            }
                            Some(TerminalEvent::PtyReadClosed) | None => {
                                info!("PTY read closed");
                                running = false;
                            }
                            Some(TerminalEvent::PtyReadError(e)) => {
                                warn!("PTY read error: {e}");
                                running = false;
                            }
                        }
                    };
                }
                if let Some(event) = event {
                    apply_terminal_event!(event);
                } else {
                    advance_pty_read!();
                }
                // Everything the reader thread had already queued behind the
                // read that woke this arm is applied into the same flush. This
                // is the exact signal the old 1 ms and 10 ms coalescing tails
                // were guessing at: output that exists is drained, output that
                // does not exist is not waited for. Bounded by what was queued
                // at entry, so a saturating producer cannot starve the other
                // arms of this loop; anything it queues meanwhile wakes the
                // arm again.
                let queued_behind = pty_async_rx.len();
                for _ in 0..queued_behind {
                    if !running || terminal.graphics_pending() {
                        break;
                    }
                    match pty_async_rx.try_recv() {
                        Ok(event) => apply_terminal_event!(Some(event)),
                        Err(tokio::sync::mpsc::error::TryRecvError::Empty) => break,
                        Err(tokio::sync::mpsc::error::TryRecvError::Disconnected) => {
                            apply_terminal_event!(None);
                            break;
                        }
                    }
                }

                schedule_display_flush(
                    include_prediction_sample_wake(
                        compute_next_flush_delay_ms(
                            &registry.peers,
                            terminal.pending_display_damage(),
                            terminal.current_display_header_signal(),
                            &display_scratch.current_row_hashes,
                            now_ms_since(start_instant),
                        ),
                        prediction_safety_sample_pending,
                        has_active_display_peers(&registry.peers),
                    ),
                    flush_sleep.as_mut(),
                    &mut flush_armed,
                    &mut flush_now,
                );
            }

            cmd = ipc_rx.recv() => {
                let Some(input) = cmd else {
                    info!("IPC stdin closed");
                    running = false;
                    continue;
                };
                let (kind, mut payload) = match input {
                    IpcInput::Frame(kind, payload) => (kind, payload),
                    IpcInput::ReadError(error) => {
                        error!("IPC stdin read failed: {error}");
                        fatal_ipc_failure = Some(error);
                        running = false;
                        continue;
                    }
                };
                match kind {
                    CMD_CONFIGURE => {
                        // Identity is immutable for this process. Reopening hardware
                        // during live terminal work would stall the owner and let
                        // queued signatures cross an authority replacement.
                        if daemon_identity.is_some() {
                            payload.zeroize();
                            warn!("refusing repeated daemon configuration");
                            continue;
                        }
                        let (new_auth, new_daemon_identity, new_user_authorization, start_webtransport) =
                            match handle_configure(&event_tx, &payload, wt_state.is_some()).await {
                                Ok(configured) => configured,
                                Err(error) => {
                                    payload.zeroize();
                                    fatal_identity_failure = Some(error);
                                    running = false;
                                    continue;
                                }
                            };
                        // The configure frame contains the daemon's long-lived
                        // sealed material (a seed only for explicit software custody). Wipe
                        // the raw JSON frame as soon as identity opening finishes.
                        payload.zeroize();
                        if let Some(a) = new_auth {
                            session_authority = Some(a);
                        }
                        if let Some(da) = new_daemon_identity {
                            edge_admission.set_daemon_id(da.daemon_id());
                            daemon_identity = Some(da);
                        }
                        if let Some(authorization) = new_user_authorization {
                            user_authorization = Some(authorization);
                        }
                        if start_webtransport {
                            if stun_credential.is_some() {
                                // Server preparation includes STUN, gateway probes,
                                // certificate generation, and a UDP bind. Run it
                                // outside this owner branch so configure commits its
                                // auth/edge state without adding seconds of latency.
                                wt_maintenance_owner.request(WtMaintenanceKind::Startup);
                                start_next_wt_maintenance(
                                    &mut wt_maintenance_owner,
                                    &mut wt_maintenance_task,
                                    &wt_state,
                                    args.wt_binding(),
                                    stun_credential.as_ref(),
                                    &wt_maintenance_completion_tx,
                                )
                                .await;
                            } else {
                                // See `wt_start_awaiting_credential`: starting here
                                // would spend the daemon's only IPv6 reachability
                                // probe before a credential exists to authenticate
                                // it, and nothing re-runs it afterwards.
                                info!(
                                    "configure: holding the WebTransport listener until the first STUN credential"
                                );
                                wt_start_awaiting_credential = true;
                            }
                        } else {
                            info!("configure: WebTransport server already healthy; not restarting it");
                        }
                    }
                    CMD_SIGN_DAEMON_PROOF => {
                        let parsed = serde_json::from_slice::<SignDaemonProofCmd>(&payload);
                        let Ok(cmd) = parsed else {
                            reject_command_from_payload(&event_tx, &payload, "invalid_command");
                            continue;
                        };
                        let transcript = decode_canonical_bytes(&cmd.transcript);
                        let Ok(transcript) = transcript else {
                            reject_command(&event_tx, &cmd.command_id, "invalid_command");
                            continue;
                        };
                        if !is_valid_command_id(&cmd.command_id) || transcript.is_empty()
                            || transcript.len() > identity_signer::MAX_TRANSCRIPT_BYTES {
                            reject_command(&event_tx, &cmd.command_id, "invalid_command");
                            continue;
                        }
                        let Some(identity) = daemon_identity.as_ref() else {
                            reject_command(&event_tx, &cmd.command_id, "identity_unconfigured");
                            continue;
                        };
                        if management_signatures.len() >= 32 {
                            reject_command(&event_tx, &cmd.command_id, "identity_busy");
                            continue;
                        }
                        match identity.request_signature(cmd.purpose.context(), transcript) {
                            Ok(receiver) => { management_signatures.spawn(async move {
                                let result = receiver.await.unwrap_or(Err(identity_seal::SealError::Closed));
                                (cmd.command_id, result)
                            }); }
                            Err(_) => reject_command(&event_tx, &cmd.command_id, "identity_busy"),
                        }
                    }
                    CMD_START_SESSION => {
                        // The Bun runtime accepted this command over its
                        // authenticated WebSocket control plane. Dial the edge
                        // and bring up the browser-facing carrier before auth.
                        handle_start_session(
                            &mut registry.edge_dials,
                            &mut cancelled_sessions,
                            &mut next_edge_lane_generation,
                            &edge_attach_tx,
                            &edge_admission,
                            &event_tx,
                            &payload,
                            now_ms_since(start_instant),
                        );
                    }
                    CMD_CANCEL_SESSION => {
                        handle_cancel_session(
                            &payload,
                            &mut cancelled_sessions,
                            &mut registry,
                            &network_state,
                            &wt_state,
                            &event_tx,
                            now_ms_since(start_instant),
                        ).await;
                    }
                    CMD_UPDATE_STUN => {
                        // The server answers every Redis lease renewal (~20 s)
                        // with a fresh STUN ticket, so this is the daemon's
                        // proof that its control link — and therefore the
                        // revocation tombstones it enforces — is current. No
                        // new IPC surface is needed for the rebind freshness
                        // gate; this command already carries the fact.
                        last_control_lease_at_ms = now_ms_since(start_instant);
                        let cmd: UpdateStunCmd = match serde_json::from_slice(&payload) {
                            Ok(command) => command,
                            Err(error) => {
                                warn!(%error, "invalid STUN credential command");
                                continue;
                            }
                        };
                        let Ok(secret) =
                            base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(cmd.secret.as_bytes())
                        else {
                            warn!("STUN credential secret is not canonical base64url");
                            continue;
                        };
                        // Two vantage points is the minimum that lets
                        // `infer_nat_behavior` conclude anything; one would
                        // yield `Unknown` and silently drop the reflexive
                        // candidate, so refuse rather than accept a credential
                        // that cannot work.
                        if cmd.servers.len() < 2 {
                            warn!(
                                count = cmd.servers.len(),
                                "refusing a STUN credential with too few vantage points"
                            );
                            continue;
                        }
                        // A credential with no usable life is refused rather
                        // than stored: it could only replace a live one with a
                        // dead one, and the daemon has no way to ask for a
                        // replacement out of band.
                        let now = tokio::time::Instant::now();
                        let Some(expires_at) = Some(Duration::from_millis(cmd.lifetime_ms))
                            .filter(|lifetime| !lifetime.is_zero())
                            .and_then(|lifetime| now.checked_add(lifetime))
                        else {
                            // Naming the consequence rather than leaving it
                            // silent: with a listener held for this credential,
                            // refusing it keeps the listener down rather than
                            // merely costing a reflexive candidate.
                            warn!(
                                lifetime_ms = cmd.lifetime_ms,
                                webtransport_listener_held = wt_start_awaiting_credential,
                                "refusing a STUN credential with no usable lifetime"
                            );
                            continue;
                        };
                        let had_credential = stun_credential
                            .as_ref()
                            .is_some_and(|credential| !credential.is_expired(now));
                        stun_credential = Some(webtransport::stun::StunCredential {
                            servers: std::sync::Arc::new(cmd.servers),
                            ticket: std::sync::Arc::new(cmd.ticket),
                            integrity_key: std::sync::Arc::new(ring::hmac::Key::new(
                                ring::hmac::HMAC_SHA256,
                                &secret,
                            )),
                            expires_at,
                        });
                        // Regaining the ability to probe is what makes a
                        // reflexive candidate possible at all: startup ran
                        // without a credential, and a daemon whose control
                        // connection stayed down long enough for its ticket to
                        // lapse is in the same position. A refresh that lands on
                        // top of a live credential replaces the ticket in place
                        // and must not probe, or every heartbeat would.
                        if !had_credential {
                            // Two different situations, told apart by whether a
                            // listener exists yet. A configure that was held for
                            // this credential starts the server now, so the one
                            // `start_server` this daemon runs carries a credential
                            // and its IPv6 reachability probe can authenticate.
                            // A credential regained under a *live* server can only
                            // reprobe: quinn holds the pinned port, so re-running
                            // `start_server` there would be `EADDRINUSE`.
                            let kind =
                                wt_maintenance_for_first_credential(wt_start_awaiting_credential);
                            if wt_start_awaiting_credential {
                                wt_start_awaiting_credential = false;
                                info!(
                                    "STUN credential arrived; starting the WebTransport listener with a probe-capable credential"
                                );
                            } else {
                                info!(
                                    "STUN credential regained; reprobing for a reflexive candidate"
                                );
                            }
                            wt_maintenance_owner.request(kind);
                            start_next_wt_maintenance(
                                &mut wt_maintenance_owner,
                                &mut wt_maintenance_task,
                                &wt_state,
                                args.wt_binding(),
                                stun_credential.as_ref(),
                                &wt_maintenance_completion_tx,
                            )
                            .await;
                        }
                    }
                    CMD_UPDATE_EDGE_ADMISSION => {
                        match serde_json::from_slice::<UpdateEdgeAdmissionCmd>(&payload) {
                            Ok(cmd) if !cmd.ticket.is_empty() => {
                                apply_edge_admission(&edge_admission, cmd);
                            }
                            Ok(_) => warn!("refusing an empty edge attach ticket"),
                            Err(error) => warn!(%error, "invalid edge admission command"),
                        }
                    }
                    CMD_REVOKE_DELEGATION => {
                        let cmd: RevokeDelegationCmd = match serde_json::from_slice(&payload) {
                            Ok(command) => command,
                            Err(error) => {
                                warn!(%error, "invalid delegation revocation command");
                                reject_command_from_payload(&event_tx, &payload, "invalid_command");
                                continue;
                            }
                        };
                        if !is_valid_command_id(&cmd.command_id) {
                            reject_command(&event_tx, &cmd.command_id, "invalid_command");
                            continue;
                        }
                        let Some(authorization) = user_authorization.as_mut() else {
                            reject_command(&event_tx, &cmd.command_id, "not_configured");
                            continue;
                        };
                        let targets = match authorization
                            .apply_revocation(&cmd.actor_certificate, &cmd.revocation)
                        {
                            Ok(targets) => targets,
                            Err(error) => {
                                warn!(%error, "delegation revocation rejected");
                                reject_command(&event_tx, &cmd.command_id, "invalid_revocation");
                                continue;
                            }
                        };
                        let delegation_ids = targets
                            .into_iter()
                            .map(|target| target.delegation_id)
                            .collect::<HashSet<_>>();
                        let mut affected_peers = registry.peers
                            .iter()
                            .filter(|(_, peer)| delegation_ids.contains(&peer.delegation_id))
                            .map(|(peer_id, _)| Arc::clone(peer_id))
                            .collect::<HashSet<Arc<str>>>();
                        affected_peers.extend(
                            registry.edge_dials
                                .iter()
                                .filter(|(_, state)| {
                                    delegation_ids
                                        .contains(state.pending_request.delegation_id())
                                })
                                .map(|(peer_id, _)| Arc::from(peer_id.as_str())),
                        );
                        affected_peers.extend(
                            registry.parked.remove_revoked_delegations(&delegation_ids),
                        );
                        for peer_id in affected_peers {
                            evict_revoked_peer(
                                &peer_id,
                                &mut registry,
                                &network_state,
                            )
                            .await;
                            send_json_event(
                                &event_tx,
                                EVT_PEER_DISCONNECTED,
                                &PeerDisconnectedEvt {
                                    peer_node_id: peer_id.to_string(),
                                    reason: "delegation_revoked".to_string(),
                                },
                            );
                        }
                        accept_command(&event_tx, &cmd.command_id);
                    }
                    CMD_UPDATE_REVOCATION => {
                        last_control_lease_at_ms = now_ms_since(start_instant);
                        // Exactly four bytes; try_from rejects any other length.
                        let Ok(gen_bytes) = <[u8; 4]>::try_from(payload.as_slice()) else {
                            warn!("CMD_UPDATE_REVOCATION expected 4-byte payload");
                            continue;
                        };
                        let new_gen = u32::from_be_bytes(gen_bytes);
                        let Some(ref mut da) = daemon_identity else { continue; };
                        if !da.set_revocation_generation(new_gen) {
                            continue;
                        }
                        info!("revocation generation bumped to {new_gen}; evicting stale registry.peers");
                        // Revocation invalidates every live pairwise-authorized
                        // connection and any parked display state. A client must
                        // obtain a new token and run a fresh hybrid exchange.
                        let _cleared_peer_ids = registry.parked.clear();
                        let stale_peers: Vec<Arc<str>> = registry.peers.keys().cloned().collect();
                        for peer_id in stale_peers {
                            evict_revoked_peer(
                                &peer_id,
                                &mut registry,
                                &network_state,
                            )
                            .await;
                            send_json_event(
                                &event_tx,
                                EVT_PEER_DISCONNECTED,
                                &PeerDisconnectedEvt {
                                    peer_node_id: peer_id.to_string(),
                                    reason: "revoked".to_string(),
                                },
                            );
                        }
                    }
                    CMD_CAPTURE_PERF_TRACE => {
                        let cmd: CapturePerfTraceCmd = match serde_json::from_slice(&payload) {
                            Ok(command) => command,
                            Err(_) => {
                                reject_command_from_payload(&event_tx, &payload, "invalid_command");
                                continue;
                            }
                        };
                        if !is_valid_command_id(&cmd.command_id) {
                            reject_command(&event_tx, &cmd.command_id, "invalid_command");
                            continue;
                        }
                        let Some(snapshot) = perf_trace::capture() else {
                            reject_command(&event_tx, &cmd.command_id, "profiling_not_started");
                            continue;
                        };
                        let mut complete = true;
                        for index in 0..snapshot.chunk_count() {
                            if event_tx.send_diagnostic_json(
                                EVT_PERF_TRACE,
                                &snapshot.chunk(&cmd.command_id, index),
                            ).is_err() {
                                complete = false;
                                break;
                            }
                        }
                        if complete {
                            accept_command(&event_tx, &cmd.command_id);
                        } else {
                            reject_command(&event_tx, &cmd.command_id, "telemetry_backpressure");
                        }
                    }
                    CMD_CAPTURE_TRANSPORT_STATS => {
                        let cmd: CaptureTransportStatsCmd = match serde_json::from_slice(&payload) {
                            Ok(command) => command,
                            Err(error) => {
                                warn!(%error, "invalid transport capture command");
                                reject_command_from_payload(&event_tx, &payload, "invalid_command");
                                continue;
                            }
                        };
                        if !is_valid_command_id(&cmd.command_id) {
                            reject_command(&event_tx, &cmd.command_id, "invalid_command");
                            continue;
                        }

                        let capture_at = Instant::now();
                        let window_ms = positive_interval_ms(stats_window_started_at, capture_at);
                        stats_window_started_at = capture_at;
                        stats_tick = 0;
                        let (next_dropped, emitted) = telemetry::emit_final_transport_stats(
                            &mut registry.peers,
                            &registry.parked,
                            &wt_state,
                            &event_tx,
                            now_ms_since(start_instant),
                            window_ms,
                            stats_events_dropped,
                            rebind_telemetry.tallies(),
                        )
                        .await;
                        stats_events_dropped = next_dropped;
                        if emitted {
                            // The stats frame and acknowledgement share one FIFO
                            // sink, so acceptance proves the requested sample was
                            // admitted first.
                            accept_command(&event_tx, &cmd.command_id);
                        } else {
                            reject_command(&event_tx, &cmd.command_id, "telemetry_backpressure");
                        }
                    }
                    CMD_SHUTDOWN => {
                        info!("shutdown requested");
                        running = false;
                    }
                    _ => {
                        warn!("unknown IPC command: 0x{kind:02x}");
                    }
                }
            }

            msg = peer_msg_rx.recv() => {
                if let Some(msg) = msg {
                    let effective_peer_id = registry.wt_temp_to_real
                        .get(&*msg.peer_node_id)
                        .cloned()
                        .unwrap_or_else(|| Arc::clone(&msg.peer_node_id));
                    if !is_current_ingress_generation(
                        &wt_state,
                        &registry.edge_dials,
                        &effective_peer_id,
                        msg.via_transport,
                        msg.connection_id,
                        msg.edge_ingress.as_ref(),
                    )
                    .await
                    {
                        trace!(
                            peer_id = %effective_peer_id,
                            connection_id = msg.connection_id,
                            "dropping stream frame from a stale carrier generation"
                        );
                        continue;
                    }

                    if msg.channel_id == CHANNEL_DATA_HELLO {
                        let Some(ingress) = msg.edge_ingress.as_ref() else { continue; };
                        if msg.delivery != DeliveryMode::Stream || ingress.lane == EdgeLane::Signaling {
                            continue;
                        }
                        let Some(nonce) = parse_data_hello_generation(&msg.payload) else { continue; };
                        {
                            let network = network_state.read().await;
                            let tunnel = if ingress.lane == EdgeLane::Bulk {
                                network.edge_bulk.get(&*effective_peer_id)
                            } else {
                                network.edge_interactive.get(&*effective_peer_id)
                            };
                            let Some(tunnel) = tunnel else { continue; };
                            tunnel.observe_browser_hello(nonce);
                        }
                        flush_now |= link_data_tunnel(
                            &network_state, &mut registry.peers, &effective_peer_id,
                            ingress.lane, now_ms_since(start_instant),
                        ).await;
                    } else if is_signaling_message(&msg)
                        || is_webtransport_upgrade_ctrl_message(&msg, &registry.wt_temp_to_real)
                    {
                        let pending_session_request = registry.edge_dials
                            .get(&*effective_peer_id)
                            .map(|state| state.pending_request.clone());
                        let signaling_action = handle_signaling_message(
                            &effective_peer_id,
                            &msg.peer_node_id,
                            &msg.payload,
                            &session_authority,
                            &user_authorization,
                            &wt_state,
                            &network_state,
                            &event_tx,
                            &mut rebind_telemetry,
                            &mut registry,
                            &mut terminal,
                            now_ms_since(start_instant),
                            &daemon_identity,
                            pending_session_request.as_ref(),
                            &daemon_static,
                            now_ms_since(start_instant) - last_control_lease_at_ms
                                < crate::session::policy::SessionPolicy::REBIND_CONTROL_FRESHNESS_MS as f64,
                            &identity_completion_tx,
                         None).await;
                        if let Some(pending) = registry.peers.get_mut(&*effective_peer_id).and_then(|peer| peer.pending_identity_signature.as_mut())
                            && pending.ingress.is_none() { pending.ingress = msg.edge_ingress.clone(); }
                        for mut retained in signaling_action.noise_ready_frames {
                            if !is_current_ingress_generation(
                                &wt_state,
                                &registry.edge_dials,
                                &retained.peer_node_id,
                                retained.via_transport,
                                retained.connection_id,
                                retained.edge_ingress.as_ref(),
                            ).await {
                                continue;
                            }
                            input_ack_pending |= handle_peer_message(
                                &mut retained,
                                &mut pty_writer,
                                pty_master.as_ref(),
                                &mut terminal,
                                &event_tx,
                                &mut registry,
                                &mut display_prepare_worker,
                                start_instant,
                                &network_state,
                                &display_scratch.current_row_hashes,
                                &display_scratch.flush_row_capture,
                                &mut inbound_plaintext_scratch,
                                &mut perf_timing,
                            ).await;
                        }
                        if release_edge_preauth_lease(
                            &mut registry.edge_dials,
                            &effective_peer_id,
                            msg.edge_ingress.as_ref(),
                            signaling_action.authenticated_edge_session,
                        ) {
                            info!(
                                peer = %effective_peer_id,
                                "edge rendezvous ownership transferred to authenticated session"
                            );
                        }
                        if signaling_action.wake_display_flush
                            && compute_next_flush_delay_ms(
                                &registry.peers,
                                terminal.pending_display_damage(),
                                terminal.current_display_header_signal(),
                                &display_scratch.current_row_hashes,
                                now_ms_since(start_instant),
                            )
                            .is_some()
                        {
                            // Authentication arms the initial snapshot before
                            // Noise exists, so it deliberately does not keep a
                            // timer alive. Noise completion and DATA rendezvous
                            // both wake the bottom-of-turn flush when ready.
                            flush_now = true;
                        }
                        if signaling_action.request_reprobe {
                            traversal.invalidate_peer(&effective_peer_id);
                            // Give the browser a usable cached offer immediately,
                            // while a coalesced background reprobe refreshes it.
                            send_webtransport_manifest(
                                &wt_state,
                                &network_state,
                                &mut registry.peers,
                                &effective_peer_id,
                                "network change cached",
                            )
                            .await;
                            request_wt_network_change_maintenance(
                                &mut wt_maintenance_owner,
                                wt_state.is_some(),
                            );
                            start_next_wt_maintenance(
                                &mut wt_maintenance_owner,
                                &mut wt_maintenance_task,
                                &wt_state,
                                args.wt_binding(),
                                stun_credential.as_ref(),
                                &wt_maintenance_completion_tx,
                            )
                            .await;
                        }
                        if signaling_action.rearm_edge_dials {
                            for request in rearm_failed_edge_lanes_for_peer(
                                &mut registry.edge_dials,
                                &effective_peer_id,
                                &mut next_edge_lane_generation,
                            ) {
                                spawn_edge_dial(request, &edge_attach_tx);
                            }
                        }
                    } else if msg.channel_id == CHANNEL_SIGNALING {
                        // Signaling is reliable-lane only — the browser drops
                        // channel-0x00 datagrams on its side. A 0x00 frame on
                        // the unreliable lane is malformed or hostile (the edge
                        // is blind), and an out-of-order/replayed handshake frame
                        // could corrupt the bootstrap. Drop it rather than feed
                        // it to the auth/Noise flow.
                    } else {
                        let mut translated = PeerMessage {
                            input_permit: msg.input_permit,
                            peer_node_id: Arc::clone(&effective_peer_id),
                            channel_id: msg.channel_id,
                            payload: msg.payload,
                            via_transport: msg.via_transport,
                            delivery: msg.delivery,
                            connection_id: msg.connection_id,
                            edge_ingress: msg.edge_ingress.clone(),
                        };
                        input_ack_pending |= handle_peer_message(
                            &mut translated,
                            &mut pty_writer,
                            pty_master.as_ref(),
                            &mut terminal,
                            &event_tx,
                            &mut registry,
                            &mut display_prepare_worker,
                            start_instant,
                            &network_state,
                            &display_scratch.current_row_hashes,
                            &display_scratch.flush_row_capture,
                            &mut inbound_plaintext_scratch,
                            &mut perf_timing,
                        ).await;
                        // Peer message may have dirtied terminal (ACK unthrottle,
                        // resync) or made a peer interactive (keystroke). Ensure
                        // the flush timer is armed/rescheduled accordingly. Always
                        // recompute the candidate: DISPLAY_RESUME can clear a
                        // future safety gate and make snapshot/diff work runnable
                        // before the previously armed deadline. The shared delay
                        // calculation preserves snapshot retry backoff.
                        schedule_display_flush(
                            compute_next_flush_delay_ms(
                                &registry.peers,
                                terminal.pending_display_damage(),
                                terminal.current_display_header_signal(),
                                &display_scratch.current_row_hashes,
                                now_ms_since(start_instant),
                            ),
                            flush_sleep.as_mut(),
                            &mut flush_armed,
                            &mut flush_now,
                        );
                    }
                }
            }

            evt = peer_event_rx.recv() => {
                if let Some(evt) = evt {
                    match evt {
                        network::PeerEvent::Disconnected {
                            peer_id,
                            connection_id,
                            reason,
                        } => {
                            let path_survived = handle_direct_webtransport_disconnected_event(
                                peer_id,
                                connection_id,
                                reason,
                                &mut registry,
                                &wt_state,
                                &network_state,
                                &event_tx,
                                start_instant,
                            )
                            .await;
                            advance_display_flush_after_lifecycle(
                                flush_sleep.as_mut(),
                                &mut flush_armed,
                                &mut flush_now,
                                &registry.peers,
                                terminal.pending_display_damage(),
                                terminal.current_display_header_signal(),
                                &display_scratch.current_row_hashes,
                                now_ms_since(start_instant),
                            );
                            if path_survived {
                                continue;
                            }
                        }
                        network::PeerEvent::WebTransportSession {
                            temp_peer_id,
                            connection_id,
                        } => {
                            info!("WebTransport session pending upgrade: {temp_peer_id} connection={connection_id}");
                        }
                        network::PeerEvent::Datagram {
                            peer_id,
                            connection_id,
                            data,
                            via_transport,
                        } => {
                            if data.is_empty() {
                                continue;
                            }
                            // Interned end to end: the carrier stamps an
                            // `Arc<str>`, the temp -> real mapping hands back
                            // another, and the message takes ownership of it.
                            // Nothing on this path mints a String or an
                            // `Arc<str>` per datagram.
                            let real_id = registry.wt_temp_to_real
                                .get(&*peer_id)
                                .cloned()
                                .unwrap_or(peer_id);
                            if !is_current_ingress_generation(
                                &wt_state,
                                &registry.edge_dials,
                                &real_id,
                                via_transport,
                                connection_id,
                                None,
                            )
                            .await
                            {
                                trace!(
                                    real_id = %real_id,
                                    connection_id,
                                    "dropping datagram from stale WebTransport session"
                                );
                                continue;
                            }
                            let channel_id = data[0];
                            let payload = data.slice(1..);
                            let mut msg = PeerMessage {
                                input_permit: None,
                                peer_node_id: real_id,
                                channel_id,
                                payload,
                                via_transport,
                                delivery: DeliveryMode::Datagram,
                                connection_id,
                                edge_ingress: None,
                            };
                            input_ack_pending |= handle_peer_message(
                                &mut msg,
                                &mut pty_writer,
                                pty_master.as_ref(),
                                &mut terminal,
                                &event_tx,
                                &mut registry,
                                &mut display_prepare_worker,
                                start_instant,
                                &network_state,
                                &display_scratch.current_row_hashes,
                                &display_scratch.flush_row_capture,
                                &mut inbound_plaintext_scratch,
                                &mut perf_timing,
                            ).await;
                            // Direct-WT input can expose display work on an
                            // already-dirty peer. Same scheduling decision as
                            // the edge-ingress path; never postpone an earlier
                            // owner.
                            schedule_display_flush(
                                compute_next_flush_delay_ms(
                                    &registry.peers,
                                    terminal.pending_display_damage(),
                                    terminal.current_display_header_signal(),
                                    &display_scratch.current_row_hashes,
                                    now_ms_since(start_instant),
                                ),
                                flush_sleep.as_mut(),
                                &mut flush_armed,
                                &mut flush_now,
                            );
                        }
                    }
                }
            }

            attach = edge_attach_rx.recv() => {
                if let Some(attach) = attach {
                    let succeeded = attach.result.is_ok();
                    if !accept_edge_attach(&mut registry.edge_dials, &attach, succeeded) {
                        if let Ok(tunnel) = attach.result {
                            tunnel.close();
                        }
                        continue;
                    }
                    if attach.lane == EdgeLane::Signaling {
                        match attach.result {
                            Ok(tunnel) => {
                                if let Some(replaced) = network::register_edge_signaling(
                                    &network_state, &attach.peer_id, tunnel.clone(),
                                ).await {
                                    replaced.close();
                                }
                                spawn_edge_tunnel_lifecycle(
                                    tunnel, attach.peer_id.clone(), attach.session_id,
                                    attach.generation, EdgeLane::Signaling,
                                    peer_msg_tx.clone(), edge_lane_closed_tx.clone(),
                                );
                                if let Some(peer) = registry.peers.get_mut(attach.peer_id.as_str()) {
                                    session::rebind_flow::flush_pending_rebind_response(
                                        peer, &attach.peer_id, &network_state, &mut rebind_telemetry,
                                    ).await;
                                }
                            }
                            Err(error) => {
                                warn!(peer = attach.peer_id, %error, "edge signaling dial failed");
                                if let Some(request) = restart_failed_edge_lane(
                                    &mut registry.edge_dials, &attach.peer_id, &attach.session_id,
                                    EdgeLane::Signaling, &mut next_edge_lane_generation, false,
                                ) {
                                    spawn_edge_dial(request, &edge_attach_tx);
                                } else {
                                    schedule_background_edge_redial(
                                        &mut registry.edge_dials, &registry.peers,
                                        &attach.peer_id, &attach.session_id, now_ms_since(start_instant),
                                    );
                                }
                            }
                        }
                        continue;
                    }
                    if attach.lane == EdgeLane::Bulk {
                        // Register this durable bulk attachment under the same
                        // peer. Linking requires the authenticated nonce claim
                        // and matching HELLO; eligibility also requires receipt.
                        match attach.result {
                            Ok(tunnel) => {
                                let replaced = network::register_edge_bulk(
                                    &network_state,
                                    &attach.peer_id,
                                    tunnel.clone(),
                                ).await;
                                if let Some(replaced) = replaced {
                                    replaced.close();
                                }
                                // A new bulk carrier must prove this specific
                                // connection works before display can prefer it.
                                if let Some(peer) =
                                    registry.peers.get_mut(attach.peer_id.as_str())
                                {
                                    if let Some(replaced) = peer.edge_tunnel_bulk.take() {
                                        replaced.close();
                                    }
                                    peer.bulk_delivery_confirmed = false;
                                }
                                spawn_edge_tunnel_lifecycle(
                                    tunnel.clone(),
                                    attach.peer_id.clone(),
                                    attach.session_id.clone(),
                                    attach.generation,
                                    EdgeLane::Bulk,
                                    peer_msg_tx.clone(),
                                    edge_lane_closed_tx.clone(),
                                );
                                info!(
                                    "edge BULK tunnel up: peer={} session_id={}#bulk",
                                    attach.peer_id, attach.session_id,
                                );
                            }
                            Err(e) => {
                                warn!(
                                    "edge BULK dial failed for peer={} session_id={}#bulk: {e} (reliable display stays on interactive tunnel)",
                                    attach.peer_id, attach.session_id,
                                );
                                if let Some(request) = restart_failed_edge_lane(
                                    &mut registry.edge_dials,
                                    &attach.peer_id,
                                    &attach.session_id,
                                    EdgeLane::Bulk,
                                    &mut next_edge_lane_generation,
                                    false,
                                ) {
                                    spawn_edge_dial(request, &edge_attach_tx);
                                }
                            }
                        }
                        continue;
                    }
                    match attach.result {
                        Ok(tunnel) => {
                            // Interactive DATA dials concurrently with signaling.
                            // Registration does not authenticate it: the matching
                            // generation nonce links it after Noise commits.
                            let replaced = network::register_edge_interactive(
                                &network_state,
                                &attach.peer_id,
                                tunnel.clone(),
                            ).await;
                            if let Some(replaced) = replaced {
                                replaced.close();
                            }
                            spawn_edge_tunnel_lifecycle(
                                tunnel.clone(),
                                attach.peer_id.clone(),
                                attach.session_id.clone(),
                                attach.generation,
                                EdgeLane::Interactive,
                                peer_msg_tx.clone(),
                                edge_lane_closed_tx.clone(),
                            );
                            // Installing the carrier is a display-readiness
                            // edge: a peer with no counterpart is not
                            // schedulable, so if this attach is what gave it one
                            // back, nothing else will schedule it.
                            schedule_display_flush(
                                compute_next_flush_delay_ms(
                                    &registry.peers,
                                    terminal.pending_display_damage(),
                                    terminal.current_display_header_signal(),
                                    &display_scratch.current_row_hashes,
                                    now_ms_since(start_instant),
                                ),
                                flush_sleep.as_mut(),
                                &mut flush_armed,
                                &mut flush_now,
                            );
                            info!(
                                "edge tunnel up: peer={} session_id={}",
                                attach.peer_id, attach.session_id,
                            );
                        }
                        Err(e) => {
                            warn!(
                                "edge dial failed for peer={} session_id={}: {e}",
                                attach.peer_id, attach.session_id,
                            );
                            if let Some(request) = restart_failed_edge_lane(
                                &mut registry.edge_dials,
                                &attach.peer_id,
                                &attach.session_id,
                                EdgeLane::Interactive,
                                &mut next_edge_lane_generation,
                                false,
                            ) {
                                spawn_edge_dial(request, &edge_attach_tx);
                            } else if attach.lane == EdgeLane::Interactive {
                                // The permit is spent. Latching Failed here is
                                // what left the daemon unable to dial while a
                                // browser waited at the edge, so schedule the
                                // next attempt instead — bounded by the carrier
                                // gap, which is the only thing that makes this
                                // session worth dialling for at all.
                                if let Some(due_at_ms) = schedule_background_edge_redial(
                                    &mut registry.edge_dials,
                                    &registry.peers,
                                    &attach.peer_id,
                                    &attach.session_id,
                                    now_ms_since(start_instant),
                                ) {
                                    info!(
                                        "edge dial failed; background redial scheduled: peer={} due_in_ms={:.0}",
                                        attach.peer_id,
                                        due_at_ms - now_ms_since(start_instant),
                                    );
                                }
                            }
                        }
                    }
                }
            }

            closed = edge_lane_closed_rx.recv() => {
                if let Some(closed) = closed {
                    'lane_event: {
                    let closed = match closed {
                        EdgeLaneEvent::Candidate { peer_id, identity, message } => {
                            let current = registry.edge_dials.get(peer_id.as_ref()).is_some_and(|state| {
                                state.session_id == identity.session_id.as_ref()
                                    && state.signaling.generation == identity.generation
                                    && state.signaling.state == EdgeDialLaneState::Succeeded
                            });
                            if !current { break 'lane_event; }
                            match message.payload {
                                None => {
                                    if let Some(peer) = registry.peers.get_mut(peer_id.as_ref())
                                        && peer.rebind.as_ref().and_then(|r| r.in_flight.as_ref())
                                            .and_then(|f| f.candidate.as_ref()).and_then(std::sync::Weak::upgrade)
                                            .is_some_and(|owner| Arc::ptr_eq(&owner, &message.reply)) {
                                        if let Some(rebind) = peer.rebind.as_mut() { rebind.in_flight = None; }
                                        peer.noise_handshake = None;
                                    }
                                }
                                Some(payload) if !message.reply.is_closed() => {
                                    let now_ms = now_ms_since(start_instant);
                                    let action = handle_signaling_message(
                                        &peer_id, &peer_id, &payload, &session_authority, &user_authorization,
                                        &wt_state, &network_state, &event_tx, &mut rebind_telemetry,
                                        &mut registry, &mut terminal, now_ms, &daemon_identity, None, &daemon_static,
                                        now_ms - last_control_lease_at_ms < session::policy::SessionPolicy::REBIND_CONTROL_FRESHNESS_MS as f64,
                                        &identity_completion_tx, Some(&message.reply),
                                    ).await;
                                    flush_now |= action.wake_display_flush;
                                }
                                Some(_) => {},
                            }
                            break 'lane_event;
                        }
                        EdgeLaneEvent::RelayDataPaused { peer_id, identity, paused } => {
                            let current = registry.edge_dials.get(&peer_id).is_some_and(|state| {
                                state.session_id == identity.session_id.as_ref()
                                    && state.signaling.generation == identity.generation
                                    && state.signaling.state == EdgeDialLaneState::Succeeded
                            });
                            if current {
                                for request in apply_relay_data_paused(
                                    &mut registry.edge_dials, &mut registry.peers, &network_state,
                                    &peer_id, paused, &mut next_edge_lane_generation,
                                ).await {
                                    spawn_edge_dial(request, &edge_attach_tx);
                                }
                            }
                            break 'lane_event;
                        }
                        EdgeLaneEvent::Closed(closed) => closed,
                        EdgeLaneEvent::BrowserPath { peer_id, identity } => {
                            let current = registry.edge_dials.get(&peer_id).is_some_and(|state| {
                                state.session_id == identity.session_id.as_ref()
                                    && state.signaling.generation == identity.generation
                                    && state.signaling.state == EdgeDialLaneState::Succeeded
                            });
                            let address = if current {
                                network::signaling_browser_address(&network_state, &peer_id).await
                            } else {
                                None
                            };
                            // The other side of the manifest's join, and the
                            // browser moving networks without a new carrier: the
                            // committed carrier proved an address the peer's
                            // manifest was not built for.
                            if let (Some(address), Some(peer)) =
                                (address, registry.peers.get_mut(peer_id.as_str()))
                                && peer.authenticated
                                && peer.browser_address != Some(address)
                            {
                                info!(
                                    peer = %peer_id,
                                    previous = ?peer.browser_address,
                                    %address,
                                    "browser signaling path moved"
                                );
                                peer.browser_address = Some(address);
                                session::wt_upgrade_flow::emit_webtransport_manifest(
                                    &wt_state, &network_state, peer, None,
                                ).await;
                            }
                            break 'lane_event;
                        }
                        EdgeLaneEvent::CounterpartAttached { peer_id, identity } => {
                            let current = registry.edge_dials.get(&peer_id).is_some_and(|state| {
                                state.session_id == identity.session_id.as_ref()
                                    && state.lane(identity.lane).generation == identity.generation
                                    && state.lane(identity.lane).state == EdgeDialLaneState::Succeeded
                            });
                            if current {
                                if identity.lane == EdgeLane::Signaling {
                                    if let Some(peer) = registry.peers.get_mut(peer_id.as_str()) {
                                        session::rebind_flow::flush_pending_rebind_response(
                                            peer, &peer_id, &network_state, &mut rebind_telemetry,
                                        ).await;
                                    }
                                } else if link_data_tunnel(
                                    &network_state, &mut registry.peers, &peer_id,
                                    identity.lane, now_ms_since(start_instant),
                                ).await {
                                    flush_now = true;
                                }
                            }
                            break 'lane_event;
                        }
                    };
                    let peer_id = closed.peer_id.clone();
                    let lane = closed.lane;
                    let alternate = if lane != EdgeLane::Interactive {
                        AlternateTransportOwnership::default()
                    } else {
                        current_alternate_transport_ownership(
                            &peer_id,
                            &wt_state,
                        )
                        .await
                    };
                    let mut action = handle_edge_lane_closed(
                        closed,
                        &mut registry.edge_dials,
                        &mut next_edge_lane_generation,
                        &mut registry.peers,
                        &network_state,
                        true,
                        now_ms_since(start_instant),
                    )
                    .await;
                    if let Some(retired) = action.retired_unresumable.take() {
                        // Invalidate dial ownership before closing the remaining
                        // lane(s). Their close events are then stale and
                        // cannot resurrect an unauthenticated/uninitialized peer.
                        if !alternate.direct_webtransport {
                            park_edge_counterpart_detached_peer(
                                &peer_id,
                                &mut registry.peers,
                                &mut registry.parked,
                                &event_tx,
                                start_instant,
                            );
                        }
                        retire_edge_preauth_ownership(
                            vec![retired],
                            &mut registry.peers,
                            &network_state,
                        )
                        .await;
                        break 'lane_event;
                    }
                    if action.park_peer {
                        if should_park_after_edge_detach(&action, alternate) {
                            park_edge_counterpart_detached_peer(
                                &peer_id,
                                &mut registry.peers,
                                &mut registry.parked,
                                &event_tx,
                                start_instant,
                            );
                        } else if !alternate.direct_webtransport
                            && let Some(peer) = registry.peers.get_mut(peer_id.as_str()) {
                                peer.paths.edge.available = false;
                            }
                    }
                    if let Some(redial) = action.redial {
                        info!(
                            "edge lane closed; redialing immediately: peer={} lane={:?}",
                            peer_id,
                            lane,
                        );
                        spawn_edge_dial(redial, &edge_attach_tx);
                    } else if let Some(state) = registry.edge_dials.get(&peer_id) {
                        let session_id = state.session_id.clone();
                        schedule_background_edge_redial(
                            &mut registry.edge_dials, &registry.peers,
                            &peer_id, &session_id, now_ms_since(start_instant),
                        );
                    }
                    advance_display_flush_after_lifecycle(
                        flush_sleep.as_mut(),
                        &mut flush_armed,
                        &mut flush_now,
                        &registry.peers,
                        terminal.pending_display_damage(),
                        terminal.current_display_header_signal(),
                        &display_scratch.current_row_hashes,
                        now_ms_since(start_instant),
                    );
                }
            }

            }

            _ = &mut flush_sleep, if flush_armed => {
                // The timer only ever carries a wait that was evidence of a
                // refusal or a re-send deadline; the flush itself runs at the
                // bottom of this turn, the same place a same-turn wake runs.
                flush_armed = false;
                flush_now = true;
            }

            _ = cert_rotation_timer.tick() => {
                if let Some(wt) = wt_state.as_ref() {
                    let needs_rotation = {
                        let s = wt.read().await;
                        s.cert_state.needs_rotation()
                    };
                    if needs_rotation {
                        wt_maintenance_owner.request(WtMaintenanceKind::Rotation);
                        start_next_wt_maintenance(
                            &mut wt_maintenance_owner,
                            &mut wt_maintenance_task,
                            &wt_state,
                            args.wt_binding(),
                            stun_credential.as_ref(),
                            &wt_maintenance_completion_tx,
                        )
                        .await;
                    }
                }
            }

            announcement = announce_rx.recv() => {
                // The sender lives in this scope, so `None` is unreachable;
                // handled rather than unwrapped because a spin here would be
                // the owner loop's.
                let Some(announcement) = announcement else {
                    continue;
                };
                let lost = match wt_state.as_ref() {
                    Some(state) => {
                        let state = state.read().await;
                        state
                            .port_lease
                            .as_ref()
                            .is_some_and(|lease| lease.lost_to(&announcement))
                            || state
                                .v6_pinhole
                                .as_ref()
                                .is_some_and(|pinhole| announcement.epoch < pinhole.epoch)
                    }
                    None => false,
                };
                if lost {
                    info!(
                        epoch = announcement.epoch,
                        external = ?announcement.external,
                        "gateway announced a reset; the port-mapping lease is gone"
                    );
                    nat_mapping_renew_at = None;
                    wt_maintenance_owner.request_mapping_after_reboot();
                    start_next_wt_maintenance(
                        &mut wt_maintenance_owner,
                        &mut wt_maintenance_task,
                        &wt_state,
                        args.wt_binding(),
                        stun_credential.as_ref(),
                        &wt_maintenance_completion_tx,
                    )
                    .await;
                }
            }

            edge = network_path_rx.recv(), if network_path_watch_active => {
                // The guard matters: `recv()` on a closed channel returns None
                // forever and would spin this loop.
                let Some(edge) = edge else {
                    network_path_watch_active = false;
                    continue;
                };
                info!(
                    coalesced_events = edge.coalesced_events,
                    "OS network path change"
                );
                // Publish to the control plane first: it is the latency-sensitive
                // consumer and must not wait behind a candidate reprobe.
                send_json_event(
                    &event_tx,
                    EVT_NETWORK_PATH_CHANGED,
                    &NetworkPathChangedEvt {
                        coalesced_events: edge.coalesced_events,
                    },
                );
                // Move every live edge tunnel onto a socket bound under the NEW
                // routing table, keeping its QUIC connection.
                //
                // Without this the old socket still holds an address the new
                // path may not own, every write is lost, and the tunnel is only
                // recovered by `connect_with_backoff` — a full handshake, and
                // then a Merkur rebind on top of it. The edge permits
                // migration (quinn's default, never overridden here), so the
                // rebound socket's first packet is answered with RFC 9000 path
                // validation instead: one round trip, no new keys, and the
                // splice stays seated because the connection never died.
                //
                // Measured with `cargo run -p merkur-edge --bin migration_probe`
                // at 84 ms RTT: 89 ms to carry data again versus 442 ms for the
                // redial it replaces. The saving is round trips, so it grows
                // with RTT — which is exactly the mobile case this fires on.
                //
                // Best-effort per tunnel: a rebind that fails leaves the tunnel
                // exactly as it was, and the existing close/redial path still
                // owns the outcome.
                let network = network_state.read().await;
                // Signaling first, including durable/unlinked pre-auth sources.
                // Socket migration never waits for any other lane's handshake.
                for (label, tunnels) in [
                    ("signaling", &network.edge_signaling),
                    ("interactive", &network.edge_interactive),
                    ("bulk", &network.edge_bulk),
                ] {
                    for (peer_id, tunnel) in tunnels {
                        match tunnel.rebind_local_socket() {
                            Ok(true) => {
                                info!(
                                    peer_id = &**peer_id,
                                    lane = label,
                                    "edge tunnel socket rebound"
                                )
                            }
                            Ok(false) => {}
                            Err(error) => {
                                warn!(
                                    peer_id = &**peer_id,
                                    lane = label,
                                    %error,
                                    "edge tunnel rebind failed"
                                )
                            }
                        }
                    }
                }
                drop(network);
                // Deliberately emitted here rather than inside
                // `request_wt_network_change_maintenance`: that function is
                // shared with the browser-pushed `network_change` path, which
                // reports the *browser's* network moving and says nothing about
                // this daemon's control socket.
                traversal.invalidate();
                request_wt_network_change_maintenance(
                    &mut wt_maintenance_owner,
                    wt_state.is_some(),
                );
                start_next_wt_maintenance(
                    &mut wt_maintenance_owner,
                    &mut wt_maintenance_task,
                    &wt_state,
                    args.wt_binding(),
                    stun_credential.as_ref(),
                    &wt_maintenance_completion_tx,
                )
                .await;
            }


            _ = heartbeat_timer.tick() => {
                let evicted_edge_sessions = heartbeat_tick(
                    &mut registry.peers,
                    &mut registry.wt_upgrade_pending,
                    &mut registry.parked,
                    &daemon_identity,
                    &network_state,
                    &event_tx,
                    &mut rebind_telemetry,
                    &display_scratch.current_row_hashes,
                    start_instant,
                ).await;
                retire_peer_transport_ownership(
                    evicted_edge_sessions,
                    &mut registry,
                    &network_state,
                    &wt_state,
                )
                .await;

                // The background redial ladder rides this tick rather than
                // owning a timer: it already runs on a 2 s cadence and already
                // holds the carrier-gap deadline that terminates the ladder.
                for request in take_due_edge_redials(
                    &mut registry.edge_dials,
                    &registry.peers,
                    now_ms_since(start_instant),
                    &mut next_edge_lane_generation,
                ) {
                    info!(
                        "carrier gap still armed; background edge redial: peer={} session_id={}",
                        request.peer_id, request.session_id,
                    );
                    spawn_edge_dial(request, &edge_attach_tx);
                }

                // Refresh the NAT mapping quinn inherited from the startup STUN
                // probe. Without this it ages out on the NAT's idle timer and
                // the published srflx candidate stops existing — see
                // `webtransport::side_channel` for why that alone is enough to
                // explain srflx never winning a direct upgrade.
                nat_keepalive_tick += 1;
                if nat_keepalive_tick >= NAT_KEEPALIVE_HEARTBEAT_TICKS {
                    nat_keepalive_tick = 0;
                    send_nat_keepalive(
                        &wt_state,
                        stun_credential.as_ref(),
                        &mut nat_keepalive_vantage,
                    )
                    .await;
                }

                // The port-mapping lease rides the same tick rather than owning
                // a timer. Checking a deadline costs one comparison, and the
                // owner loop is already awake here — the argument the keepalive
                // above makes for itself.
                if wt_state.is_some()
                    && nat_mapping_renew_at
                        .is_some_and(|deadline| tokio::time::Instant::now() >= deadline)
                {
                    // Cleared before dispatch, not after: the completion arm
                    // sets the next deadline from whatever the gateway grants,
                    // and leaving it set would re-request every tick until then.
                    nat_mapping_renew_at = None;
                    wt_maintenance_owner.request(WtMaintenanceKind::Mapping);
                    start_next_wt_maintenance(
                        &mut wt_maintenance_owner,
                        &mut wt_maintenance_task,
                        &wt_state,
                        args.wt_binding(),
                        stun_credential.as_ref(),
                        &wt_maintenance_completion_tx,
                    )
                    .await;
                }

                // Telemetry rides the heartbeat timer rather than a timer of its
                // own: this one already wakes the owner loop, already walks every
                // peer, and already has `MissedTickBehavior::Skip`, so a suspended
                // laptop cannot produce a catch-up burst of stats frames.
                stats_tick += 1;
                if stats_tick >= telemetry::STATS_TICKS_PER_SAMPLE {
                    stats_tick = 0;
                    let sample_at = Instant::now();
                    let window_ms = positive_interval_ms(stats_window_started_at, sample_at);
                    stats_window_started_at = sample_at;
                    let now_ms = start_instant.elapsed().as_secs_f64() * 1000.0;
                    stats_events_dropped = telemetry::emit_transport_stats(
                        &mut registry.peers,
                        &registry.parked,
                        &wt_state,
                        &event_tx,
                        now_ms,
                        window_ms,
                        stats_events_dropped,
                        rebind_telemetry.tallies(),
                    )
                    .await;
                }
            }
        }

        // The input ack goes out on the turn that queued it. Coalescing is the
        // newest-wins slot on the peer plus the bounded completion drain above
        // (at most `PTY_WRITE_COMPLETIONS_PER_TURN` confirmations fold into one
        // record); nothing coalesces across turns, and nothing waits on a clock.
        // It goes out before the display flush below so it never queues behind
        // a burst. On the edge its packet waits only for the flush to admit this
        // peer's header-only or echo frame, which then shares it; the flush
        // releases that hold before any other work.
        if input_ack_pending {
            input_ack_pending = false;
            flush_input_acks(
                &mut registry.peers,
                now_ms_since(start_instant),
                &mut perf_timing,
            );
        }

        // UI effects do not depend on row damage, display credit, or a pending
        // synchronized-output release. Canonical parsing already owns their boundary.
        send_terminal_ui(&mut terminal, &mut registry.peers, now_ms_since(start_instant));

        // The display flush for this turn, whether an arm above asked for it
        // in the same turn (`Some(0)`) or the timer carried a wait here. It
        // runs after the arm returned, so every mutation the arm made — grid
        // apply, ACK, resume, attach, drained PTY reads — is visible to row
        // selection, and a keystroke's echo leaves in the turn that applied it
        // rather than after a timer rearm.
        if flush_now {
            flush_now = false;
            let now_ms = now_ms_since(start_instant);
            if terminal.display_commit_pending() {
                // The completion/capacity event will schedule the next flush.
                // Do not spin a display timer against a held synchronized grid.
                // Reliable editor revocation and the input-routing word are
                // independent of grid capture.
                flush_armed = false;
                display::send::send_paused_drain_metadata(&terminal, &mut registry.peers, now_ms);
            } else {
                arm_expired_resume_snapshots(&mut registry.peers, now_ms);
                if prediction_safety_sample_pending && has_active_display_peers(&registry.peers) {
                    terminal.set_prediction_safe(pty::pty_prediction_safe(
                        pty_master.as_ref(),
                        pid,
                        terminal.shell_integration_input_active(),
                        terminal.shell_integration_authenticated(),
                    ));
                    prediction_safety_sample_pending = false;
                }
                send_open_url_requests(&terminal, &mut registry.peers, now_ms).await;
                let terminal_dirty = terminal.has_dirty();
                if has_runnable_display_work(
                    &registry.peers,
                    terminal_dirty,
                    terminal.current_display_header_signal(),
                    &display_scratch.current_row_hashes,
                    now_ms,
                ) {
                    flush_display(
                        &mut terminal,
                        &mut display_scratch,
                        &mut display_prepare_worker,
                        &mut registry.peers,
                        &display_clock,
                        &mut display_flush_cursor,
                        &mut perf_timing,
                    )
                    .await;
                }
                let schedule_now_ms = now_ms_since(start_instant);
                // A cohort the flush just put off is served on the next turn, so
                // the other arms get their chance in between: that yield is the
                // whole point of the owner-turn budget. Otherwise one evaluation
                // says whether to sleep, for how long, or to park. Newly runnable
                // work discovered here also takes the timer rather than looping
                // in this turn, for the same fairness reason.
                let delay = if display_flush_cursor.has_deferred_peers(
                    &registry.peers,
                    terminal.current_display_header_signal(),
                    &display_scratch.current_row_hashes,
                    schedule_now_ms,
                ) {
                    Some(0)
                } else {
                    compute_next_flush_delay_ms(
                        &registry.peers,
                        terminal.pending_display_damage(),
                        terminal.current_display_header_signal(),
                        &display_scratch.current_row_hashes,
                        schedule_now_ms,
                    )
                };
                if let Some(delay) = delay {
                    flush_sleep
                        .as_mut()
                        .reset(tokio::time::Instant::now() + Duration::from_millis(delay));
                    flush_armed = true;
                }
            }
        }
        // No hold outlives the turn that took it, whether or not a flush ran.
        display::send::release_egress_holds(&mut registry.peers);
        // Level, not event: a full batch's deadline is "now", and routing that
        // through the timer arm made service depend on the timer winning the
        // select against every hot source. The deadline is read directly so a
        // due batch counts its deferred hot turns from the turn it became due.
        if perf_timing
            .next_wire_deadline()
            .is_some_and(|deadline| deadline <= Instant::now())
        {
            perf_timing_maintenance.mark_due(Instant::now());
        }
        if perf_timing_maintenance.is_due() {
            let perf_hot_work = PerfTimingHotWork {
                peer_message: !peer_msg_rx.is_empty(),
                pty_output: !pty_async_rx.is_empty(),
                pty_write_completion: !pty_write_completion_rx.is_empty(),
                display_prepare_completion: !display_prepare_completion_rx.is_empty(),
                snapshot_prepare_completion: !snapshot_prepare_completion_rx.is_empty(),
                display_flush: flush_armed && flush_sleep.deadline() <= tokio::time::Instant::now(),
            };
            if perf_timing_maintenance.should_offer(Instant::now(), perf_hot_work) {
                perf_timing_maintenance.clear();
                let owner_peer_id = perf_timing.owner_peer_id().cloned();
                if let Some(owner_peer_id) = owner_peer_id
                    && let Some(peer) = registry.peers.get_mut(owner_peer_id.as_ref())
                {
                    send_due_perf_timing_batches(
                        peer,
                        &mut perf_timing,
                        now_ms_since(start_instant),
                        Instant::now(),
                    );
                } else {
                    perf_timing.clear_owner();
                }
            }
        }
    }

    // Retire publication authority and reap image workers before the runtime or
    // the terminal's reservations disappear, including IPC/read-error exits.
    terminal.shutdown_graphics().await;

    // Invalidate WebTransport maintenance ownership before endpoint teardown.
    // A late preparation result owns its endpoint/mapping guards and is safely
    // dropped after the completion receiver closes.
    wt_maintenance_owner.cancel_pending();
    if let Some((_, task)) = wt_maintenance_task.take() {
        task.abort();
        let _ = task.await;
    }
    wt_maintenance_completion_rx.close();
    while let Ok(completion) = wt_maintenance_completion_rx.try_recv() {
        drop(completion);
    }

    // On Apple targets the watcher owns a thread running a CFRunLoop, which may
    // outlive the abort until process exit. The process is exiting.
    if let Some(task) = network_path_task {
        task.abort();
        let _ = task.await;
    }
    network_path_rx.close();
    traversal.shutdown().await;
    if let Some(listener) = announce_listener.take() {
        listener.abort();
    }
    announce_rx.close();

    // Invalidate lifecycle ownership before closing transports. Dial tasks that
    // complete after this point observe the closed result channel and close their
    // own tunnel; lane-closed events likewise cannot schedule a redial.
    registry.edge_dials.clear();
    edge_attach_rx.close();
    while let Ok(attach) = edge_attach_rx.try_recv() {
        if let Ok(tunnel) = attach.result {
            tunnel.close();
        }
    }
    edge_lane_closed_rx.close();
    while edge_lane_closed_rx.try_recv().is_ok() {}
    network::remove_all_edge_connections(&network_state).await;

    // Every exit path must release an interactive shell before the blocking
    // wait. `kill` is idempotent for an already-exited child and prevents
    // CMD_SHUTDOWN, IPC EOF, or a supervised subsystem failure from hanging
    // dataplane shutdown forever.
    let _ = pty_child.kill();
    let pty_wait_result = pty_child.wait();
    if let Ok(status) = &pty_wait_result {
        let exit_code = i32::try_from(status.exit_code()).unwrap_or(-1);
        send_json_event(
            &event_tx,
            EVT_PTY_CLOSED,
            &PtyClosedEvt {
                exit_code,
                signal: -1,
            },
        );
    }

    if let Some(mut server) = wt_server.take() {
        let _ = server.shutdown().await;
    }

    management_signatures.abort_all();
    let output_result = event_output.shutdown().await;
    if let Some(failure) = fatal_identity_failure {
        return Err(Box::new(failure));
    }
    capture_pending_event_failure(&mut fatal_event_failure, &mut event_failure_rx);
    if let Some(failure) = fatal_event_failure {
        return Err(Box::new(failure));
    }
    if let Some(failure) = fatal_ipc_failure {
        return Err(Box::new(failure));
    }
    if let Err(failure) = output_result {
        return Err(Box::new(failure));
    }
    pty_wait_result?;
    Ok(())
}

fn capture_pending_event_failure(
    fatal: &mut Option<EventSinkFailure>,
    failures: &mut mpsc::Receiver<EventSinkFailure>,
) {
    if fatal.is_none()
        && let Ok(failure) = failures.try_recv()
    {
        *fatal = Some(failure);
    }
}

/// Start one edge tunnel's readers and supervise its lifecycle. The readers
/// hand their frames to the owner's ingress queue themselves; this task carries
/// only lifecycle. Closure is a signal, not something inferred by a timer: the
/// owner gets one generation-tagged event when the tunnel's connection closes,
/// and no ingress backpressure can delay it.
fn spawn_edge_tunnel_lifecycle(
    tunnel: Arc<edge_tunnel::EdgeTunnel>,
    peer_id: String,
    session_id: String,
    generation: EdgeLaneGeneration,
    lane: EdgeLane,
    peer_msg_tx: mpsc::Sender<PeerMessage>,
    edge_lane_closed_tx: mpsc::Sender<EdgeLaneEvent>,
) {
    let ingress_peer_id: Arc<str> = Arc::from(peer_id.as_str());
    let edge_ingress = EdgeIngressIdentity {
        session_id: Arc::from(session_id.as_str()),
        generation,
        lane,
    };
    tunnel.spawn_receivers(edge_tunnel::EdgeIngress {
        tx: peer_msg_tx,
        peer_node_id: ingress_peer_id.clone(),
        identity: edge_ingress.clone(),
    });
    if let Some(mut candidates) = tunnel.spawn_candidate_receivers() {
        let events = edge_lane_closed_tx.clone();
        let peer = ingress_peer_id;
        let identity = edge_ingress.clone();
        tokio::spawn(async move {
            while let Some(message) = candidates.recv().await {
                if events
                    .send(EdgeLaneEvent::Candidate {
                        peer_id: peer.clone(),
                        identity: identity.clone(),
                        message,
                    })
                    .await
                    .is_err()
                {
                    break;
                }
            }
        });
    }
    tokio::spawn(async move {
        let close_tunnel = tunnel.clone();
        let mut tunnel_closed = Box::pin(close_tunnel.closed_reason());
        let mut counterpart = tunnel.counterpart_changes();
        // Inspect the initial value too: registration and the edge's presence
        // response can race this task's startup. Subsequent changes wake immediately.
        counterpart.mark_changed();
        let mut lifecycle_open = true;
        let mut relay_data = tunnel.relay_data_changes();
        relay_data.mark_changed();
        let mut relay_data_open = lane == EdgeLane::Signaling;
        // Signaling tunnels carry the browser's proven address. Inspect the
        // initial value too, for the same registration race as above.
        let mut browser_path = tunnel.browser_path_changes();
        browser_path.mark_changed();
        let mut browser_path_open = lane == EdgeLane::Signaling;
        let close_reason = loop {
            tokio::select! {
                biased;
                reason = &mut tunnel_closed => break reason,
                changed = relay_data.changed(), if relay_data_open => {
                    if changed.is_err() { relay_data_open = false; }
                    else {
                        let paused = (*relay_data.borrow_and_update()).unwrap_or(false);
                        let event = EdgeLaneEvent::RelayDataPaused {
                            peer_id: peer_id.clone(),
                            identity: edge_ingress.clone(),
                            paused,
                        };
                        if edge_lane_closed_tx.send(event).await.is_err() { return; }
                    }
                }
                changed = browser_path.changed(), if browser_path_open => {
                    if changed.is_err() { browser_path_open = false; }
                    else if browser_path.borrow_and_update().is_some() {
                        let event = EdgeLaneEvent::BrowserPath {
                            peer_id: peer_id.clone(),
                            identity: edge_ingress.clone(),
                        };
                        tokio::select! {
                            biased;
                            reason = &mut tunnel_closed => break reason,
                            sent = edge_lane_closed_tx.send(event) => {
                                if sent.is_err() { return; }
                            }
                        }
                    }
                }
                changed = counterpart.changed(), if lifecycle_open => {
                    if changed.is_err() { lifecycle_open = false; }
                    else if matches!(*counterpart.borrow_and_update(), edge_tunnel::CounterpartState::Attached { .. }) {
                        let event = EdgeLaneEvent::CounterpartAttached {
                            peer_id: peer_id.clone(), identity: edge_ingress.clone(),
                        };
                        tokio::select! {
                            biased;
                            reason = &mut tunnel_closed => break reason,
                            sent = edge_lane_closed_tx.send(event) => {
                                if sent.is_err() { return; }
                            }
                        }
                    }
                }
            }
        };
        let _ = edge_lane_closed_tx
            .send(EdgeLaneEvent::Closed(EdgeLaneClosed {
                peer_id,
                session_id,
                generation,
                lane,
                tunnel,
                close_reason,
            }))
            .await;
    });
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct SessionCancelOutcome {
    tombstoned: bool,
    dial_retired: bool,
    active_retired: bool,
}

/// Terminally retract one exact browser/session owner.
///
/// Each registry is guarded by the strongest session-bearing owner available:
/// `EdgeDialState` for pre-auth edge lanes, and `signal_session_id` for active
/// peer state. A peer-id match alone is never sufficient because a replacement
/// session can reuse the browser identity before this command is delivered.
/// Parked state is never touched: it carries no session, only the browser's
/// display and input continuity, and the successor's own resume claim is what
/// decides whether that continuity is still worth anything.
async fn handle_cancel_session(
    payload: &[u8],
    cancelled_sessions: &mut CancelledSessions,
    registry: &mut PeerRegistry,
    network_state: &Arc<RwLock<NetworkState>>,
    wt_state: &Option<Arc<RwLock<WebTransportState>>>,
    event_tx: &EventSink,
    now_ms: f64,
) -> SessionCancelOutcome {
    let PeerRegistry {
        peers,
        parked: parked_peers,
        edge_dials,
        wt_temp_to_real,
        wt_upgrade_pending,
        ..
    } = registry;
    let cmd: CancelSessionCmd = match serde_json::from_slice(payload) {
        Ok(cmd) => cmd,
        Err(error) => {
            warn!("invalid cancel_session payload: {error}");
            reject_command_from_payload(event_tx, payload, "invalid_command");
            return SessionCancelOutcome::default();
        }
    };
    if !is_valid_command_id(&cmd.command_id)
        || cmd.session_id.is_empty()
        || cmd.browser_node_id.is_empty()
    {
        warn!("cancel_session requires a valid command_id, session_id, and browser_node_id");
        reject_command(event_tx, &cmd.command_id, "invalid_command");
        return SessionCancelOutcome::default();
    }

    // Only unfinished issuance is cancellable. The owner loop serializes this
    // check with Noise completion: an established session (including a tentative
    // rebind with an incumbent Noise transport) ends through authenticated close
    // or revocation, never a delayed coordinator cancellation.
    if peers
        .get(cmd.browser_node_id.as_str())
        .is_some_and(|peer| peer.signal_session_id == cmd.session_id && peer.noise.is_some())
    {
        accept_command(event_tx, &cmd.command_id);
        return SessionCancelOutcome::default();
    }

    // This happens before ownership inspection so cancel-before-start still
    // rejects the delayed start callback for the exact tuple.
    cancelled_sessions.insert(&cmd.browser_node_id, &cmd.session_id, now_ms);
    let mut outcome = SessionCancelOutcome {
        tombstoned: true,
        ..SessionCancelOutcome::default()
    };

    let current_dial_session = edge_dials
        .get(&cmd.browser_node_id)
        .map(|state| state.session_id.as_str());
    let dial_matches = current_dial_session.is_some_and(|session| session == cmd.session_id);
    let replacement_dial_owns_identity =
        current_dial_session.is_some_and(|session| session != cmd.session_id);
    let active_matches = peers
        .get(cmd.browser_node_id.as_str())
        .is_some_and(|peer| peer.signal_session_id == cmd.session_id)
        // session_start installs the new dial owner before re-auth replaces the
        // old PeerDisplayState. In that interval the dial generation is the
        // stronger owner fence: an old cancel must be a total transport no-op.
        && !replacement_dial_owns_identity;
    let retired_dial = dial_matches
        .then(|| edge_dials.remove(&cmd.browser_node_id))
        .flatten();
    outcome.dial_retired = retired_dial.is_some();

    let mut active_interactive = None;
    let mut active_bulk = None;
    if active_matches && let Some(mut peer) = peers.remove(cmd.browser_node_id.as_str()) {
        active_interactive = peer.edge_tunnel.take();
        active_bulk = peer.edge_tunnel_bulk.take();
        outcome.active_retired = true;
        // A cancel retires the session's carriers and keys, never the browser's
        // display continuity. The server sends this same command when a
        // successor issuance supersedes the session -- the reconnect a user is
        // waiting on -- and it usually lands one control message before the
        // successor's `session_start`. Dropping the display cache here made that
        // successor authenticate as a fresh peer: a new generation counter, a
        // full snapshot at a generation the browser had already passed, and on
        // 2026-09-08 a browser that dropped that snapshot as stale and never
        // painted again. Parking is exactly what a dead carrier does, and the
        // browser's resume claim decides what the spliced cache is worth.
        park_disconnected_peer(parked_peers, peer, now_ms);
    }

    // Remove peer-held lanes by pointer identity. This protects a replacement
    // registry lane if session_start for it was accepted before cancellation of
    // the older active peer.
    if let Some(tunnel) = active_interactive {
        let _ = network::remove_edge_lane_if_current(
            network_state,
            &cmd.browser_node_id,
            EdgeLane::Interactive,
            &tunnel,
        )
        .await;
        tunnel.close();
    }
    if let Some(tunnel) = active_bulk {
        let _ = network::remove_edge_lane_if_current(
            network_state,
            &cmd.browser_node_id,
            EdgeLane::Bulk,
            &tunnel,
        )
        .await;
        tunnel.close();
    }

    // Pending/failed lanes do not own a registry entry; removing those by peer
    // id could close a predecessor still serving an older active session.
    if let Some(dial) = retired_dial {
        network::remove_edge_lanes(
            network_state,
            &cmd.browser_node_id,
            dial.signaling.state == EdgeDialLaneState::Succeeded,
            dial.interactive.state == EdgeDialLaneState::Succeeded,
            dial.bulk.state == EdgeDialLaneState::Succeeded,
        )
        .await;
    }

    if outcome.active_retired {
        for wt_peer_id in take_wt_ownership_ids(&cmd.browser_node_id, wt_temp_to_real) {
            wt_upgrade_pending.remove(&wt_peer_id);
            if let Some(wt) = wt_state.as_ref() {
                webtransport::remove_peer(wt, &wt_peer_id).await;
            }
        }
        send_json_event(
            event_tx,
            EVT_PEER_DISCONNECTED,
            &PeerDisconnectedEvt {
                peer_node_id: cmd.browser_node_id.clone(),
                reason: "session cancelled".to_string(),
            },
        );
    }

    if outcome.active_retired || outcome.dial_retired {
        info!(
            "session cancelled: peer={} session_id={} active={} dial={}",
            cmd.browser_node_id, cmd.session_id, outcome.active_retired, outcome.dial_retired,
        );
    } else {
        trace!(
            "recorded cancellation tombstone with no matching current owner: peer={} session_id={}",
            cmd.browser_node_id, cmd.session_id,
        );
    }
    accept_command(event_tx, &cmd.command_id);
    outcome
}

/// Fully retire a peer invalidated by a revocation-generation bump.
///
/// The dial supervisor is invalidated first. Both peer-held and registry-held
/// tunnel Arcs are then explicitly closed; the latter matters for pre-auth peers
/// whose tunnel has not yet been linked into `PeerDisplayState`.
async fn evict_revoked_peer(
    peer_id: &str,
    registry: &mut PeerRegistry,
    network_state: &Arc<RwLock<NetworkState>>,
) {
    let PeerRegistry {
        peers,
        edge_dials,
        wt_temp_to_real,
        ..
    } = registry;
    edge_dials.remove(peer_id);
    if let Some(mut state) = peers.remove(peer_id) {
        if let Some(tunnel) = state.edge_tunnel.take() {
            tunnel.close();
        }
        if let Some(tunnel) = state.edge_tunnel_bulk.take() {
            tunnel.close();
        }
    }
    wt_temp_to_real.retain(|_, real| &**real != peer_id);
    network::remove_edge_connections(network_state, peer_id).await;
}

/// Retire every carrier registry and dial generation owned by identities whose
/// active/parked session state is gone.
///
/// `edge_dials` is invalidated before registry tunnels are closed, so the close
/// events emitted by those tunnels are stale by construction and cannot start
/// another redial. Both the authenticated and temporary direct-WT spellings are
/// removed as well.
async fn retire_peer_transport_ownership(
    peer_ids: Vec<Arc<str>>,
    registry: &mut PeerRegistry,
    network_state: &Arc<RwLock<NetworkState>>,
    wt_state: &Option<Arc<RwLock<WebTransportState>>>,
) {
    let PeerRegistry {
        edge_dials,
        wt_temp_to_real,
        wt_upgrade_pending,
        ..
    } = registry;
    for peer_id in peer_ids {
        edge_dials.remove(&*peer_id);
        network::remove_edge_connections(network_state, &peer_id).await;

        for wt_peer_id in take_wt_ownership_ids(&peer_id, wt_temp_to_real) {
            wt_upgrade_pending.remove(&wt_peer_id);
            if let Some(wt) = wt_state.as_ref() {
                webtransport::remove_peer(wt, &wt_peer_id).await;
            }
        }
    }
}

/// Close only registry lanes actually installed by expired pre-auth owners.
///
/// Pending/failed replacement lanes may coexist with an older authenticated
/// predecessor under the same peer id, so peer-id-wide teardown would violate
/// the replacement fence. The retired lane states are the commit record:
/// `Succeeded` means this owner replaced the corresponding registry slot.
async fn retire_edge_preauth_ownership(
    retired: Vec<RetiredEdgeDial>,
    peers: &mut PeerMap,
    network_state: &Arc<RwLock<NetworkState>>,
) {
    for retired in retired {
        let peer_id = retired.peer_id;
        let session_id = retired.state.session_id.clone();
        let interactive_succeeded = retired.state.interactive.state == EdgeDialLaneState::Succeeded;
        let bulk_succeeded = retired.state.bulk.state == EdgeDialLaneState::Succeeded;

        // A challenge-created peer is exact only when it still names this
        // rendezvous session. Preserve an authenticated predecessor while its
        // replacement lease expires.
        let remove_preauth_peer = peers
            .get(peer_id.as_str())
            .is_some_and(|peer| !peer.authenticated && peer.signal_session_id == session_id);
        if remove_preauth_peer && let Some(mut peer) = peers.remove(peer_id.as_str()) {
            if let Some(tunnel) = peer.edge_tunnel.take() {
                tunnel.close();
            }
            if let Some(tunnel) = peer.edge_tunnel_bulk.take() {
                tunnel.close();
            }
        }

        network::remove_edge_lanes(
            network_state,
            &peer_id,
            retired.state.signaling.state == EdgeDialLaneState::Succeeded,
            interactive_succeeded,
            bulk_succeeded,
        )
        .await;
        warn!(
            peer = peer_id,
            session_id, "retired abandoned edge rendezvous owner"
        );
    }
}

/// Remove every WebTransport registry identity owned by one logical peer.
///
/// Upgrade events rename the live WT registry entry from its raw temporary id
/// to the authenticated id but retain the temp->real relation for late
/// lifecycle messages. An auth/liveness eviction must therefore close both
/// spellings and erase that relation atomically from the owner map.
fn take_wt_ownership_ids(
    peer_id: &str,
    wt_temp_to_real: &mut HashMap<String, Arc<str>>,
) -> Vec<String> {
    let mut ids = vec![peer_id.to_string()];
    wt_temp_to_real.retain(|temp_id, real_id| {
        if &**real_id == peer_id {
            ids.push(temp_id.clone());
            false
        } else {
            true
        }
    });
    ids.sort_unstable();
    ids.dedup();
    ids
}

/// Apply a transport lifecycle event directly in the run loop.
///
/// Keeping this separate from the bounded ingress queue lets events originating
/// inside the run loop (notably the reliable-stream sentinel) preserve lifecycle
/// semantics without awaiting a send to the same queue it is responsible for
/// draining.
async fn handle_direct_webtransport_disconnected_event(
    peer_id: String,
    wt_connection_id: u64,
    reason: String,
    registry: &mut PeerRegistry,
    wt_state: &Option<Arc<RwLock<WebTransportState>>>,
    network_state: &Arc<RwLock<NetworkState>>,
    event_tx: &EventSink,
    start_instant: Instant,
) -> bool {
    let PeerRegistry {
        wt_temp_to_real,
        wt_upgrade_pending,
        peers,
        parked: parked_peers,
        edge_dials,
        ..
    } = registry;
    let real_id = wt_temp_to_real
        .remove(&peer_id)
        .unwrap_or_else(|| Arc::from(peer_id.as_str()));
    // Both maps are keyed by the same temporary id and describe the same
    // connection. Dropping one without the other leaves a challenge that no
    // proof can ever claim, held until the sweep collects it — and the two maps
    // disagreeing about which upgrades are in flight is the shape every
    // ownership bug in this path has taken.
    wt_upgrade_pending.remove(&peer_id);

    let removed_current = match wt_state {
        Some(wt) => webtransport::remove_peer_if_current(wt, &real_id, wt_connection_id).await,
        None => false,
    };
    if !removed_current {
        trace!(
            peer_id,
            real_id = %real_id,
            connection_id = wt_connection_id,
            "ignored stale WebTransport disconnect"
        );
        return true;
    }
    let still_alive = if let Some(peer) = peers.get_mut(&*real_id) {
        // This event passed the exact connection-id fence above, so no ACK can
        // now arrive solely from that direct owner. Retire its display attempts
        // before the edge-alive fast return; edge and dual provenance remains
        // valid and the rest is immediately sendable on the surviving edge.
        peer.retire_display_attempts(PeerTransport::WebTransport);
        peer.paths.webtransport.consecutive_send_failures = 0;
        peer.paths.webtransport.available = false;
        peer.direct_session = None;
        let edge_alive = peer.paths.edge.available && peer.edge_tunnel.is_some();
        info!(
            "direct WebTransport lane down: {peer_id} (real: {real_id}, reason: {reason}); edge_alive={edge_alive}"
        );
        edge_alive
    } else {
        false
    };
    if still_alive {
        return true;
    }

    // No path remains: park resume state and drop the edge registry entry.
    if let Some(state) = peers.remove(&*real_id) {
        park_disconnected_peer(parked_peers, state, now_ms_since(start_instant));
    }
    edge_dials.remove(&*real_id);
    network::remove_edge_connections(network_state, &real_id).await;
    send_json_event(
        event_tx,
        EVT_PEER_DISCONNECTED,
        &PeerDisconnectedEvt {
            peer_node_id: real_id.to_string(),
            reason,
        },
    );
    false
}

#[derive(Default)]
struct SignalingAction {
    noise_ready_frames: std::collections::VecDeque<PeerMessage>,
    request_reprobe: bool,
    rearm_edge_dials: bool,
    wake_display_flush: bool,
    /// True only when this exact signaling message completed authentication.
    /// The run loop combines it with the edge ingress session/generation before
    /// releasing the rendezvous lease.
    authenticated_edge_session: bool,
}

/// Session authentication and Noise bootstrap belong only to the interactive
/// carrier. The bulk carrier reuses the established session and is deliberately
/// receive-oriented; accepting a replayed `session_auth` there could consume the
/// one-use request commitment without releasing the interactive pre-auth owner.
fn is_signaling_message(message: &PeerMessage) -> bool {
    message.channel_id == CHANNEL_SIGNALING
        && message.delivery == DeliveryMode::Stream
        && message
            .edge_ingress
            .as_ref()
            .is_none_or(|ingress| ingress.lane == EdgeLane::Signaling)
}

async fn handle_signaling_message(
    effective_peer_id: &Arc<str>,
    raw_peer_id: &str,
    payload: &[u8],
    session_authority: &Option<SessionAuthority>,
    user_authorization: &Option<UserAuthorization>,
    wt_state: &Option<Arc<RwLock<WebTransportState>>>,
    network_state: &Arc<RwLock<NetworkState>>,
    event_tx: &EventSink,
    rebind_telemetry: &mut session::rebind_flow::RebindTelemetry,
    registry: &mut PeerRegistry,
    terminal: &mut TerminalState,
    now_ms: f64,
    daemon_identity: &Option<DaemonIdentity>,
    pending_session_request: Option<&PendingSessionRequest>,
    daemon_static: &[u8],
    control_link_fresh: bool,
    identity_completion_tx: &mpsc::Sender<session::auth_flow::IdentitySignDone>,
    candidate: Option<&Arc<edge_candidate::CandidateReply>>,
) -> SignalingAction {
    // Session authentication keys the peer map with this exact allocation;
    // every other use below only reads the id.
    let peer_key = effective_peer_id;
    let effective_peer_id: &str = effective_peer_id;
    let PeerRegistry {
        peers,
        wt_temp_to_real,
        wt_upgrade_pending,
        parked,
        ..
    } = registry;
    // The one parse and the one envelope check: `merkur-wire` holds the exact
    // shape and bounds of every message a client may send, and a handler below
    // gets exactly its own message.
    let signal = match ClientSignal::admit(payload) {
        Ok(signal) => signal,
        Err(refused) => {
            static MALFORMED_ENVELOPES: WarningCount = WarningCount::new(0);
            if within_warning_budget(&MALFORMED_ENVELOPES) {
                warn!(
                    peer = %effective_peer_id,
                    "dropping malformed or unknown browser signaling envelope"
                );
            }
            // Gated on the type: the envelope check rejects every signaling
            // shape, and an untyped counter here would drown the rebind signal
            // in unrelated drops. A rebind rejected at the door and one refused
            // inside are indistinguishable to the browser (both are silence),
            // so the difference has to be visible here or nowhere. The parser
            // hands over the session id only when it is one the validator
            // admits; nothing else of an unauthenticated envelope is reported.
            if let merkur_wire::signaling::RefusedEnvelope::SessionRebind { session_id } = refused {
                rebind_telemetry.report_envelope_rejected(session_id.as_deref());
            }
            return SignalingAction::default();
        }
    };
    if candidate.is_some()
        && !matches!(
            signal,
            ClientSignal::SessionRebind(_)
                | ClientSignal::SessionRebindReconcile(_)
                | ClientSignal::SessionRenew(_)
                | ClientSignal::RebindFinal(_)
        )
    {
        return SignalingAction::default();
    }
    // Rebind traffic belongs to an exact tentative attachment. Accepting it on
    // the primary signaling lane would bypass the nondisplacing handover.
    if candidate.is_none()
        && matches!(
            signal,
            ClientSignal::SessionRebind(_)
                | ClientSignal::SessionRebindReconcile(_)
                | ClientSignal::RebindFinal(_)
        )
    {
        return SignalingAction::default();
    }
    let mut action = SignalingAction::default();

    match &signal {
        ClientSignal::SessionRebindReconcile(request) => {
            if let Some(identity) = daemon_identity.as_ref() {
                crate::session::reconcile_flow::reconcile(
                    effective_peer_id,
                    identity.daemon_id(),
                    request,
                    peers,
                    network_state,
                    candidate,
                )
                .await;
            }
        }
        ClientSignal::SessionRenew(request) => {
            crate::session::renewal_flow::handle_session_renewal(
                effective_peer_id,
                request,
                peers,
                daemon_identity,
                session_authority,
                user_authorization,
                network_state,
                control_link_fresh,
                now_ms,
                candidate,
            )
            .await;
        }
        ClientSignal::SessionRebind(message) => {
            let parsed = (|| {
                Some(crate::session::rebind_flow::RebindRequest {
                    session_id: message.session_id.clone(),
                    browser_node_id: message.browser_node_id.clone(),
                    counter: message.rebind_counter,
                    client_nonce: decode_canonical_array::<{ merkur_e2e::SESSION_NONCE_BYTES }>(
                        &message.client_nonce,
                    )
                    .ok()?,
                    encapsulation_key: Box::new(
                        decode_canonical_array::<{ merkur_e2e::ML_KEM_ENCAPSULATION_KEY_BYTES }>(
                            &message.encapsulation_key,
                        )
                        .ok()?,
                    ),
                    noise_msg1: decode_canonical_bytes(&message.noise_msg1).ok()?,
                    mac: decode_canonical_array::<{ merkur_e2e::SESSION_REBIND_MAC_BYTES }>(
                        &message.mac,
                    )
                    .ok()?,
                })
            })();
            if let Some(request) = parsed {
                let daemon_id = daemon_identity
                    .as_ref()
                    .map(|identity| identity.daemon_id().to_string())
                    .unwrap_or_default();
                let _admission = crate::session::rebind_flow::handle_session_rebind(
                    effective_peer_id,
                    request,
                    peers,
                    daemon_identity,
                    &daemon_id,
                    network_state,
                    rebind_telemetry,
                    control_link_fresh,
                    now_ms,
                    daemon_static,
                    candidate,
                )
                .await;
            }
        }
        ClientSignal::SessionAuth(message) => {
            action.authenticated_edge_session = handle_session_auth(
                peer_key,
                message,
                session_authority,
                user_authorization,
                wt_state,
                network_state,
                event_tx,
                peers,
                terminal,
                now_ms,
                daemon_identity,
                pending_session_request,
                parked,
                daemon_static,
                identity_completion_tx,
            )
            .await;
        }

        ClientSignal::WebtransportUpgradeInit(message) => {
            handle_wt_upgrade_init(
                raw_peer_id,
                message,
                wt_state,
                daemon_identity,
                peers,
                wt_upgrade_pending,
                now_ms,
            )
            .await;
        }

        ClientSignal::WebtransportUpgradeProof(message) => {
            handle_wt_upgrade_proof(
                raw_peer_id,
                message,
                wt_state,
                daemon_identity,
                peers,
                wt_temp_to_real,
                wt_upgrade_pending,
                now_ms,
            )
            .await;
        }

        // Noise E2E handshake (browser = initiator), fused into the auth
        // flights. The browser writes message 1 inside `session_auth` /
        // `session_rebind`, the daemon answers with message 2 inside
        // `session_ready` / `session_rebound`, and only message 3 needs a frame
        // of its own. There is no `noise_init` / `noise_resp` any more: they
        // were a whole round trip spent carrying bytes that fit in flights
        // already on the wire.
        ClientSignal::NoiseFinal(_) | ClientSignal::RebindFinal(_) => {
            let completed = handle_noise_final(
                effective_peer_id,
                &signal,
                peers,
                wt_state,
                network_state,
                rebind_telemetry,
                now_ms,
                candidate,
            )
            .await;
            action.wake_display_flush = completed.is_some();
            action.noise_ready_frames = completed.unwrap_or_default();
        }

        ClientSignal::NetworkChange(message) => {
            let accepted = handle_network_change(effective_peer_id, message, peers);
            action.request_reprobe = accepted;
            action.rearm_edge_dials = accepted;
        }

        ClientSignal::DataAttach(claim) => {
            if let Some(peer) = peers.get_mut(effective_peer_id)
                && peer.authenticated
                && peer.is_e2e_ready()
                && peer.noise_handshake.is_none()
                && peer
                    .rebind
                    .as_ref()
                    .is_none_or(|rebind| rebind.in_flight.is_none())
            {
                let lane = match claim.lane {
                    DataLane::Interactive => EdgeLane::Interactive,
                    DataLane::Bulk => EdgeLane::Bulk,
                };
                let index = usize::from(lane == EdgeLane::Bulk);
                let nonce = decode_data_attachment_nonce(&claim.nonce);
                if peer.data_attachment_nonces[index] != nonce {
                    peer.data_attachment_nonces[index] = nonce;
                    if lane == EdgeLane::Interactive {
                        peer.edge_tunnel = None;
                        peer.paths.edge.available = false;
                        peer.data_rendezvous_pending = true;
                    } else {
                        peer.edge_tunnel_bulk = None;
                        peer.bulk_delivery_confirmed = false;
                    }
                }
                action.wake_display_flush =
                    link_data_tunnel(network_state, peers, effective_peer_id, lane, now_ms).await;
            }
        }

        ClientSignal::DataReceived(claim) => {
            if claim.lane == DataLane::Bulk
                && let Some(peer) = peers.get_mut(effective_peer_id)
            {
                action.wake_display_flush =
                    confirm_bulk_delivery(peer, decode_data_attachment_nonce(&claim.nonce));
            }
        }

        ClientSignal::SignalingPong {} => {}

        ClientSignal::WebtransportOutcome(report) => {
            if !is_authenticated_peer(peers, effective_peer_id) {
                warn!(
                    "webtransport_outcome from unauthenticated peer {effective_peer_id}; dropping"
                );
            } else {
                info!(
                    peer = %effective_peer_id,
                    outcome = report.outcome,
                    nat_type = report.nat_type,
                    winner_kind = report.winner_kind.as_deref().unwrap_or("none"),
                    admission_stage = report.admission_stage,
                    admission_reason = report.admission_reason,
                    candidates = ?report.candidates,
                    "webtransport NAT outcome"
                );
            }
        }
    }
    action
}

/// Browser → daemon: `noise_final` carries Noise message 3 and completes the
/// XXpsk3 handshake. On completion the responder is converted into the live
/// `NoiseTransport` and stored in `peer.noise`; from then on terminal channels
/// are E2E-ready (the inbound gate opens, outbound producers seal). For a
/// rebind, the incumbent Noise/direct pair remains installed until the complete
/// successor has been validated. The direct carrier is then retired and the
/// successor is committed in one owner-loop turn; any earlier failure leaves
/// the incumbent untouched.
async fn handle_noise_final(
    effective_peer_id: &str,
    final_flight: &ClientSignal,
    peers: &mut PeerMap,
    wt_state: &Option<Arc<RwLock<WebTransportState>>>,
    network_state: &Arc<RwLock<NetworkState>>,
    rebind_telemetry: &mut session::rebind_flow::RebindTelemetry,
    now_ms: f64,
    candidate: Option<&Arc<edge_candidate::CandidateReply>>,
) -> Option<std::collections::VecDeque<PeerMessage>> {
    // A genesis `noise_final`, or a rebind's `rebind_final` with its MAC.
    let (data, rebind_mac) = match final_flight {
        ClientSignal::NoiseFinal(message) => (&message.data, None),
        ClientSignal::RebindFinal(message) => (&message.data, Some(&message.mac)),
        _ => return None,
    };
    if !is_authenticated_peer(peers, effective_peer_id) {
        warn!("noise_final from unauthenticated peer {effective_peer_id}; dropping");
        return None;
    }
    // Canonical base64url, the one encoding the signaling channel uses.
    let Ok(msg3) = decode_canonical_bytes(data) else {
        warn!("noise_final from {effective_peer_id} with malformed base64 data; dropping");
        return None;
    };
    // Authenticate before taking the one-use Noise state. Junk and stale final
    // flights cannot consume the real browser's pending responder.
    if let Some(flight) = peers
        .get(effective_peer_id)
        .and_then(|p| p.rebind.as_ref())
        .and_then(|r| r.in_flight.as_ref())
    {
        match (
            flight.candidate.as_ref().and_then(std::sync::Weak::upgrade),
            candidate,
        ) {
            (Some(owner), Some(candidate))
                if Arc::ptr_eq(&owner, candidate) && !candidate.is_closed() => {}
            (None, None) if flight.candidate.is_none() => {}
            _ => return None,
        }
        let mac = rebind_mac.and_then(|mac| decode_canonical_array::<64>(mac).ok());
        if rebind_mac.is_none()
            || mac.is_none_or(|mac| {
                merkur_e2e::verify_rebind_final_mac(
                    flight.successor.rebind_secret(),
                    &flight.request_digest,
                    &msg3,
                    &mac,
                )
                .is_err()
            })
        {
            return None;
        }
    } else if rebind_mac.is_some() {
        return None;
    }
    let Some(pending) = peers
        .get_mut(effective_peer_id)
        .and_then(|peer| peer.noise_handshake.take())
    else {
        warn!("noise_final from {effective_peer_id} with no in-flight handshake; dropping");
        return None;
    };
    let mut handshake = pending.handshake;
    if let Err(e) = handshake.read_message(&msg3) {
        warn!("noise_final msg3 read failed for {effective_peer_id}: {e}");
        return None;
    }
    if !handshake.is_complete() {
        warn!("noise_final from {effective_peer_id} did not complete handshake; dropping");
        return None;
    }
    if handshake.remote_static().is_none() {
        // XX always transmits the initiator static; its absence means the
        // handshake is malformed. Refuse rather than install a transport.
        warn!("noise_final from {effective_peer_id} missing remote static; dropping");
        return None;
    }
    let transport = match handshake.into_transport() {
        Ok(transport) => transport,
        Err(e) => {
            warn!("noise_final transport install failed for {effective_peer_id}: {e}");
            return None;
        }
    };
    let is_rebind = peers
        .get(effective_peer_id)
        .and_then(|peer| peer.rebind.as_ref())
        .is_some_and(|rebind| rebind.in_flight.is_some());

    // Both peers have now validated the successor, but neither has published
    // it yet. Retire the predecessor direct carrier before the Noise swap so a
    // queued old-provider callback cannot consume a successor nonce. This await
    // is still atomic with respect to peer state: the dataplane owner loop does
    // not process another message while this handler is running.
    if is_rebind && let Some(wt) = wt_state {
        webtransport::remove_peer(wt, effective_peer_id).await;
    }

    let Some(peer) = peers.get_mut(effective_peer_id) else {
        warn!("noise_final for missing peer {effective_peer_id}; dropping");
        return None;
    };
    if is_rebind {
        peer.paths.webtransport.available = false;
        peer.direct_session = None;
        crate::session::rebind_flow::splice_rebound_peer(peer, now_ms);
    }
    peer.graphics_requests = None;
    peer.geometry_reply = None;
    peer.noise = Some(transport);
    // A new Noise session replaces the carrier: display states sealed under
    // the predecessor may never arrive, and the browser's session fence has
    // just forgotten the grants it spent on them.
    let generation = peer.generation;
    peer.display_credit.bootstrap(generation);
    // Link definitions sealed under the predecessor session are unopenable;
    // the successor starts from the whole live table.
    peer.link_table_sent = None;
    peer.open_url_sent = 0;
    peer.terminal_title_sent = None;
    // Transient effects already admitted under the predecessor are not replayed.
    // The existing peer keeps its cursor; a new peer begins at attachment.
    peer.resume_waiting_for_data = peer.awaiting_resume_until_ms.is_some();
    peer.data_attachment_nonces = [None; 2];
    peer.data_rendezvous_pending = true;
    peer.paths.forget_input_probes();
    // Data readiness follows its own same-flight rendezvous. Do not attempt a
    // snapshot before then: a synthetic send failure would arm refusal backoff
    // and make genesis pay a delay despite adding no handshake RTT.
    peer.paths.edge.available = false;
    peer.edge_tunnel = None;
    peer.edge_tunnel_bulk = None;
    peer.bulk_delivery_confirmed = false;
    peer.auth_timeout_at_ms = None;
    // This is the rebind commit point, and the only one. `RS_n` is spent here
    // rather than when its proof verified, so a replayed request creates an
    // in-flight attempt that expires instead of permanently burning the chain
    // on a handshake the attacker cannot finish.
    let committed = crate::session::rebind_flow::commit_rebind(
        peer,
        effective_peer_id,
        rebind_telemetry,
        now_ms,
    );
    info!("E2E established for peer {effective_peer_id}");

    if committed {
        if let Some(candidate) = candidate {
            candidate.commit();
            // The committed carrier is this candidate, and the edge proved its
            // address before the rebind could begin. A carrier that moved
            // networks is offered against where it is now, not where the
            // session started.
            peer.browser_address = Some(candidate.browser_address);
        }
        // `commit_rebind` installed the successor direct-upgrade secret. Send the
        // manifest at once over the retained edge lane; waiting for a later
        // change would strand a previously-direct session on the relay.
        crate::session::wt_upgrade_flow::emit_webtransport_manifest(
            wt_state,
            network_state,
            peer,
            candidate,
        )
        .await;
    }
    Some(pending.frames)
}

fn handle_network_change(
    effective_peer_id: &str,
    message: &merkur_wire::signaling::NetworkChange,
    peers: &mut PeerMap,
) -> bool {
    // Client moved between networks. Force fresh heartbeat round-trips on every
    // carrier so RTT recalibrates against the new conditions.
    let browser_node_id = message.browser_node_id.as_str();
    if browser_node_id != effective_peer_id {
        warn!(
            "network_change identity mismatch: signaling_peer={effective_peer_id} payload_peer={browser_node_id}"
        );
        return false;
    }
    if let Some(peer) = peers.get_mut(browser_node_id) {
        if !peer.authenticated {
            warn!("network_change from unauthenticated peer {browser_node_id}; dropping");
            return false;
        }
        // This authenticated signaling edge asks each exact carrier to prove
        // itself again. It is not terminal E2E activity and therefore grants
        // no ACK credit or availability by itself.
        peer.paths.webtransport.heartbeat_probe_requested = true;
        peer.paths.edge.heartbeat_probe_requested = true;
        // The new network may not carry bulk; use interactive reliable until
        // bulk re-proves inbound delivery on the re-dialed connection. The
        // datagram-lossy window lapses on its own.
        peer.bulk_delivery_confirmed = false;
        return true;
    }
    false
}

async fn handle_peer_message(
    msg: &mut PeerMessage,
    pty_writer: &mut PtyWriter,
    pty_master: &(dyn portable_pty::MasterPty + Send),
    terminal: &mut TerminalState,
    event_tx: &EventSink,
    registry: &mut PeerRegistry,
    display_prepare_worker: &mut DisplayPrepareWorker,
    start_instant: Instant,
    network_state: &Arc<RwLock<NetworkState>>,
    current_row_hashes: &[u64],
    current_row_captures: &HashMap<u16, CapturedRow>,
    plaintext_scratch: &mut Vec<u8>,
    perf_timing: &mut PerfTimingTracker,
) -> bool {
    // One lookup serves the authentication check, the open and the activity
    // update below: the id is a ~45-byte string, hashed once per inbound frame.
    let Some(peer) = registry
        .peers
        .get_mut(&*msg.peer_node_id)
        .filter(|peer| peer.authenticated)
    else {
        // Signaling is the only accepted browser lane before authentication.
        // Terminal traffic requires an authenticated E2E state.
        static UNAUTHENTICATED_FRAMES: WarningCount = WarningCount::new(0);
        if within_warning_budget(&UNAUTHENTICATED_FRAMES) {
            warn!(
                "dropping unauthenticated peer message: peer={} channel={}",
                msg.peer_node_id, msg.channel_id
            );
        }
        return false;
    };

    // E2E gate: terminal channels (PTY/CTRL/DISPLAY_ACK) are mandatory-encrypted.
    // Before the Noise handshake completes no plaintext terminal frame is ever
    // accepted; once it does, every inbound terminal frame is opened here at the
    // single dispatch convergence point and the DECRYPTED payload flows on. The
    // Successful open consumes the explicit per-lane replay counter exactly
    // once. A pending handshake can retain unopened ciphertext for its own cut.
    let opened_len = match open_inbound_terminal(peer, msg, plaintext_scratch) {
        OpenOutcome::Plaintext => None,
        OpenOutcome::Opened(plaintext_len) => Some(plaintext_len),
        OpenOutcome::Drop => return false,
    };
    let authenticated_terminal_frame = opened_len.is_some();

    // Only an authenticated E2E open is carrier evidence. Updating before the
    // open allowed invalid ciphertext to keep a path alive. Expected multipath
    // replays are deliberately ignored here: the first successfully opened copy
    // credits its actual carrier, while independent heartbeat probes continue to
    // measure the carrier whose duplicate lost the race.
    //
    // DOWNLINK evidence only. This frame came FROM the browser, so it proves
    // nothing about whether the frames this daemon sends still arrive — and
    // crediting it as a round trip meant a typing user kept a blackholed
    // downlink looking healthy indefinitely.
    if authenticated_terminal_frame {
        if peer.resume_waiting_for_data {
            peer.begin_resume_receive_budget(now_ms_since(start_instant), msg.via_transport);
        }
        peer.paths
            .get_mut(msg.via_transport)
            .record_inbound_activity();
    }

    // Borrow the plaintext rather than rebinding `msg` around an owned copy of
    // it. The opened bytes never outlive this dispatch, so owning them bought
    // nothing and cost a buffer handoff plus a message rebind that cloned the
    // peer id and the edge identity on every inbound terminal frame. Identity
    // and transport fields are identical either way, so the handlers keep
    // reading them from the original `msg`.
    let payload: &[u8] = match opened_len {
        Some(plaintext_len) => &plaintext_scratch[..plaintext_len],
        None => &msg.payload,
    };

    // The PTY lane is the only one that can queue an input ack; the two arms
    // below never apply to it, so its verdict is the function's.
    if msg.channel_id == CHANNEL_PTY {
        // Whether an input ACK can be promised for this frame's probe starts
        // with the writer: a write offered to an idle one completes next.
        let writer_idle = pty_writer.is_idle();
        if msg.delivery == DeliveryMode::Stream {
            let Some(plaintext_len) = opened_len else {
                return false;
            };
            let outcome = handle_reliable_input(
                msg,
                plaintext_scratch,
                plaintext_len,
                pty_writer,
                terminal,
                &mut registry.peers,
                &mut registry.input_refill,
                start_instant,
                perf_timing,
            );
            // After the entries were offered to the PTY: the keystroke first.
            if let Some(run) = outcome.probe {
                let probe = session::liveness::InputProbe {
                    token: run.token,
                    ack_follows: writer_idle && run.taken,
                };
                session::liveness::answer_input_probe(msg, probe, &mut registry.peers);
            }
            return outcome.ack_pending;
        }
        let outcome = handle_pty_channel(
            msg,
            payload,
            pty_writer,
            terminal,
            &mut registry.peers,
            start_instant,
            perf_timing,
        );
        if let Some(peer) = registry.peers.get_mut(&*msg.peer_node_id)
            && peer.reliable_inputs.has_pending()
        {
            resume_peer_input(peer, pty_writer, terminal, perf_timing);
            registry.input_refill.pending |= peer.reliable_inputs.has_pending();
        }
        if let Some(run) = outcome.probe {
            // Decided after the resume above, which may have filled a gap.
            let taken = registry
                .peers
                .get(&*msg.peer_node_id)
                .is_some_and(|peer| peer.has_queued_through(run.top_seq));
            let probe = session::liveness::InputProbe {
                token: run.token,
                ack_follows: writer_idle && taken,
            };
            session::liveness::answer_input_probe(msg, probe, &mut registry.peers);
        }
        return outcome.ack_pending;
    }

    if msg.channel_id == CHANNEL_DISPLAY_ACK {
        let Some(ack) = parse_display_ack(payload) else {
            return false;
        };
        let now_ms = now_ms_since(start_instant);
        if let Some(peer) = registry.peers.get_mut(&*msg.peer_node_id) {
            handle_display_ack(
                peer,
                ack,
                now_ms,
                msg.via_transport,
                current_row_hashes,
                terminal.has_dirty(),
            );
        }
        return false;
    }

    if msg.channel_id == CHANNEL_CTRL {
        handle_ctrl_channel(
            msg,
            payload,
            pty_master,
            terminal,
            event_tx,
            registry,
            display_prepare_worker,
            start_instant,
            network_state,
            current_row_hashes,
            current_row_captures,
            perf_timing,
        )
        .await;
    }
    false
}

/// Outcome of the inbound E2E gate at the `handle_peer_message` dispatch point.
enum OpenOutcome {
    /// Not a sealed terminal channel (e.g. the `0xFF` stream-close sentinel);
    /// dispatch the frame as-is.
    Plaintext,
    /// A terminal frame that opened successfully. The plaintext is the first
    /// `usize` bytes of the scratch buffer the caller passed in.
    Opened(usize),
    /// No dispatch: either retained by the pending handshake or rejected.
    /// A failed open (bad tag / replay) never falls back to plaintext.
    Drop,
}

/// Gate + open for inbound terminal channels. PTY/CTRL/DISPLAY_ACK require an
/// established E2E transport and are opened on the Noise sub-lane selected by
/// `msg.delivery` (a logical channel may arrive on BOTH the reliable stream and
/// the datagram lane). Every other channel — including the internal `0xFF`
/// connection-close sentinel — is passed through untouched. This is the single
/// inbound decrypt site; it is factored out so the open is unit-testable against
/// a browser-initiator-sealed frame.
fn open_inbound_terminal(
    peer: &mut PeerDisplayState,
    msg: &mut PeerMessage,
    plaintext_scratch: &mut Vec<u8>,
) -> OpenOutcome {
    match msg.channel_id {
        CHANNEL_PTY | CHANNEL_CTRL | CHANNEL_DISPLAY_ACK => {}
        _ => return OpenOutcome::Plaintext,
    }
    if !peer.is_e2e_ready() {
        if retain_pending_noise_frame(peer, msg) {
            return OpenOutcome::Drop;
        }
        warn!(
            "dropping terminal frame before E2E established: peer={} channel={}",
            msg.peer_node_id, msg.channel_id
        );
        return OpenOutcome::Drop;
    }
    match peer.open_terminal_into(
        msg.channel_id,
        msg.delivery,
        &msg.payload,
        plaintext_scratch,
    ) {
        Ok(plaintext_len) => OpenOutcome::Opened(plaintext_len),
        // Replay is the EXPECTED, benign case for a frame fanned over more than
        // one transport (edge + direct WT): the first copy opens and the
        // per-lane sliding window rejects the duplicate(s). Keep it at trace so
        // it does not masquerade as an error in the logs.
        Err(crate::e2e::OpenReject::Replay) => {
            if retain_pending_noise_frame(peer, msg) {
                return OpenOutcome::Drop;
            }
            trace!(
                "dropping duplicate terminal frame (multi-path replay): peer={} channel={} delivery={:?}",
                msg.peer_node_id, msg.channel_id, msg.delivery
            );
            OpenOutcome::Drop
        }
        Err(crate::e2e::OpenReject::Auth) => {
            if retain_pending_noise_frame(peer, msg) {
                return OpenOutcome::Drop;
            }
            warn!(
                "dropping terminal frame that failed E2E open: peer={} channel={} delivery={:?}",
                msg.peer_node_id, msg.channel_id, msg.delivery
            );
            OpenOutcome::Drop
        }
    }
}

/// Only the pending responder may retain unauthenticated ciphertext. A live
/// incumbent still opens normally; successor records can hit either its replay
/// window or its tag check, neither of which consumes a nonce on rejection.
fn retain_pending_noise_frame(peer: &mut PeerDisplayState, msg: &mut PeerMessage) -> bool {
    if !peer.authenticated || msg.via_transport != PeerTransport::Edge {
        return false;
    }
    let Some(pending) = peer.noise_handshake.as_mut() else {
        return false;
    };
    if !pending.retain(msg) {
        // Never silently lose an accepted reliable record and continue that
        // carrier. Retire the failed attempt; incumbent direct/Noise survives.
        warn!(peer = %msg.peer_node_id, "pending Noise ingress bound exceeded");
        peer.clear_noise_bootstrap_material();
        if let Some(tunnel) = &peer.edge_tunnel {
            tunnel.close();
        }
        if let Some(tunnel) = &peer.edge_tunnel_bulk {
            tunnel.close();
        }
    }
    true
}

/// Bounded warn for an unrecognized / unhandled wire message type on a sealed
/// channel. This is the only breadcrumb for browser↔daemon protocol version
/// skew between peers, mirroring the "unknown IPC command" diagnostic.
/// Rate-limited so a buggy or hostile client can't flood the log from the hot
/// path.
fn warn_unhandled_wire_type(channel: &str, msg_type: u8, body_len: usize) {
    static N: WarningCount = WarningCount::new(0);
    if within_warning_budget(&N) {
        warn!(
            "unhandled {channel} message: type=0x{msg_type:02x} body_len={body_len} (unknown type or short body — version skew?)"
        );
    }
}

/// How often one kind of warning has been asked for, process-wide.
pub(crate) type WarningCount = std::sync::atomic::AtomicU32;

/// Resource bound on the log lines one kind of rejected frame can cost. A peer
/// can send such frames at will, several kinds before it authenticates, so the
/// first sixteen of a kind are logged and the rest are not.
const WARNINGS_PER_KIND: u32 = 16;

/// Whether this occurrence of a warning, counted in `seen`, is still logged.
pub(crate) fn within_warning_budget(seen: &WarningCount) -> bool {
    seen.fetch_add(1, std::sync::atomic::Ordering::Relaxed) < WARNINGS_PER_KIND
}

fn enqueue_terminal_events(
    terminal_event_rx: &crossbeam_channel::Receiver<TerminalEvent>,
    pty_writer: &mut PtyWriter,
) -> bool {
    while let Ok(event) = terminal_event_rx.try_recv() {
        match event {
            TerminalEvent::PtyWrite(bytes) => {
                if let Err(error) = pty_writer.try_enqueue_terminal_reply(bytes) {
                    error!("failed to queue PTY response: {error:?}");
                    return false;
                }
            }
            TerminalEvent::PtyBytes(_, _)
            | TerminalEvent::PtyReadClosed
            | TerminalEvent::PtyReadError(_) => {
                error!("unexpected PTY reader event from terminal emulator");
                return false;
            }
        }
    }
    true
}

fn confirm_and_refill_pty_input(
    peer: &mut PeerDisplayState,
    pty_writer: &mut PtyWriter,
    terminal: &mut TerminalState,
    peer_id: &Arc<str>,
    seq: u32,
    via_transport: PeerTransport,
    perf: &mut PerfTimingTracker,
) -> Option<u32> {
    let ack_seq = peer.confirm_keystroke_delivery(seq)?;
    let perf_owner = perf.owns(peer_id, &peer.signal_session_id);
    let mut enqueue = |queued_seq: u32, bytes: &[u8], shadow_modelled: bool| {
        let trace_token = if perf_owner {
            perf.trace_token_for_pending_input(queued_seq)
        } else {
            None
        };
        let admitted = admit_user_record(
            pty_writer,
            terminal,
            peer_id,
            queued_seq,
            via_transport,
            bytes,
            shadow_modelled,
            trace_token,
        );
        if perf_owner {
            match admitted {
                Some(true) => perf.note_pty_write_owned(queued_seq, Instant::now()),
                Some(false) => perf.note_input_silent_owned(queued_seq),
                None => {}
            }
        }
        admitted.is_some()
    };
    peer.drain_keystroke_reorder(&mut enqueue);
    Some(ack_seq)
}

/// Admits one browser input record to the PTY: the only place input becomes
/// PTY bytes, whichever lane or buffer the record waited in.
///
/// The record is encoded here, on the owner task, against the modes of the
/// terminal this task owns, so an application that switched keyboard modes
/// gets its next key in the new mode however late the browser learns of it.
/// A record that encodes to nothing (a release no flag asked for) still takes
/// its FIFO slot, which is what confirms and acknowledges its sequence in
/// order, and it never touches the speculative-echo boundary.
///
/// Returns `None` when a full queue refused the record (the caller retries on
/// a later completion, re-encoding it then), otherwise whether it wrote bytes.
fn admit_user_record(
    writer: &mut PtyWriter,
    terminal: &mut TerminalState,
    peer_id: &Arc<str>,
    seq: u32,
    via: PeerTransport,
    record: &[u8],
    shadow_modelled: bool,
    trace_token: Option<perf_trace::TraceToken>,
) -> Option<bool> {
    let decoded = input_record::decode(record);
    debug_assert!(
        decoded.is_some(),
        "input records are validated when their frame is parsed"
    );
    // A browser's focus is reported only when it changes whether the terminal
    // has focus at all; any other focus record takes its slot and writes nothing.
    let focus = match decoded {
        Some(InputRecord::Focus(focused)) => Some(focused),
        _ => None,
    };
    let reported = focus.is_none_or(|focused| terminal.focus_changes_terminal_focus(peer_id, focused));
    let mut payload = PtyWritePayload::with_capacity(input_encoder::encoded_len_hint(record));
    if reported && let Some(decoded) = &decoded {
        input_encoder::encode(decoded, terminal.input_modes(), &mut payload);
    }
    let wrote = !payload.is_empty();
    if writer
        .try_enqueue_user(Arc::clone(peer_id), seq, via, payload, trace_token)
        .is_err()
    {
        return None;
    }
    if let Some(focused) = focus {
        terminal.set_peer_focus(peer_id, focused);
    }
    if wrote && let Some(decoded) = &decoded {
        terminal.observe_user_input(
            TerminalState::record_is_modelled(decoded, shadow_modelled),
            TerminalState::record_leaves_line_editor(decoded),
        );
    }
    Some(wrote)
}

/// What one owner turn's bounded completion drain did. `input_ack_queued` is
/// reported however the drain ended — the chain ran dry or the per-turn budget
/// was consumed — so a turn that confirms exactly the budget cannot strand its
/// ack behind the `break`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct PtyCompletionTurn {
    handled: usize,
    input_ack_queued: bool,
}

fn handle_pty_write_completions(
    first: PtyWriteCompletion,
    completion_rx: &mut mpsc::UnboundedReceiver<PtyWriteCompletion>,
    pty_writer: &mut PtyWriter,
    terminal: &mut TerminalState,
    peers: &mut PeerMap,
    parked_peers: &mut ParkedPeers,
    input_refill: &mut input::InputRefill,
    perf_timing: &mut PerfTimingTracker,
) -> Result<PtyCompletionTurn, ()> {
    let mut next = Some(first);
    let mut handled = 0;
    let mut input_ack_queued = false;

    while let Some(completion) = next.take() {
        // A profiled input's write carries its trace stamp; the profiler times
        // the acknowledgment from this same owner-handled observation.
        let owner_handled = completion.trace().map(|trace| {
            trace.record_now(pty::PtyTraceEvent::WriteOwnerHandled {
                write_ordinal: trace.ordinal,
            })
        });
        pty_writer.finish(&completion);
        let wrote_nothing = completion.byte_len() == 0;
        match completion {
            PtyWriteCompletion::Delivered {
                source:
                    PtyWriteSource::UserInput {
                        peer_id,
                        seq,
                        via_transport,
                    },
                ..
            } => {
                if let Some(peer) = peers.get_mut(&*peer_id) {
                    if let Some(ack_seq) = confirm_and_refill_pty_input(
                        peer,
                        pty_writer,
                        terminal,
                        &peer_id,
                        seq,
                        via_transport,
                        perf_timing,
                    ) {
                        if let Some(owner_handled) = owner_handled
                            && perf_timing.owns(&peer_id, &peer.signal_session_id)
                        {
                            perf_timing.note_pty_write_completed_owned(seq, owner_handled);
                        }
                        // A record that wrote nothing (a release riding in the
                        // run of the key after it) reached no program, so while
                        // a later record of the same peer is still in the FIFO
                        // its confirmation tells the browser nothing: that
                        // record's ack and advertisement cover it. Answering it
                        // alone cost an ack pair and a header-only display
                        // frame per keystroke.
                        if !(wrote_nothing && peer.has_unconfirmed_keystrokes()) {
                            // The peer is already borrowed here, so the
                            // confirmed high-water and the pending ack are each
                            // one store — no id clone, no hash.
                            peer.latest_input_seq = ack_seq;
                            peer.latest_input_display_revision = terminal.display_revision();
                            peer.queue_input_ack(ack_seq, via_transport);
                            input_ack_queued = true;
                        }
                    } else {
                        warn!("out-of-order PTY input completion: peer={peer_id} seq={seq}");
                    }
                } else if let Some(peer) = parked_peers.get_mut(&peer_id)
                    && confirm_and_refill_pty_input(
                        peer,
                        pty_writer,
                        terminal,
                        &peer_id,
                        seq,
                        via_transport,
                        perf_timing,
                    )
                    .is_none()
                {
                    warn!("out-of-order parked PTY input completion: peer={peer_id} seq={seq}");
                }
            }
            PtyWriteCompletion::Delivered {
                source: PtyWriteSource::TerminalReply,
                ..
            } => {}
            PtyWriteCompletion::Failed { source, error, .. } => {
                error!("PTY write failed for {source:?}: {error}");
                return Err(());
            }
        }
        handled += 1;
        if handled >= PTY_WRITE_COMPLETIONS_PER_TURN {
            break;
        }
        next = completion_rx.try_recv().ok();
    }
    if input_refill.pending {
        refill_waiting_input(
            peers,
            parked_peers,
            input_refill,
            pty_writer,
            terminal,
            perf_timing,
        );
    }
    Ok(PtyCompletionTurn {
        handled,
        input_ack_queued,
    })
}

/// Send every peer's pending input ack. Runs at the bottom of an owner turn
/// whose level flag is set; a peer with nothing queued costs one `Option`
/// read. No id list, no clone, no hash lookup and no clock: the slot is on the
/// peer and the walk is the peer map itself.
fn flush_input_acks(peers: &mut PeerMap, now_ms: f64, perf: &mut PerfTimingTracker) {
    for (peer_id, peer) in peers.iter_mut() {
        if let Some(pending) = peer.pending_input_ack.take() {
            send_input_ack(peer_id, peer, pending, now_ms, perf);
        }
    }
}

fn send_input_ack(
    peer_id: &str,
    peer: &mut PeerDisplayState,
    pending: PendingInputAck,
    now_ms: f64,
    perf: &mut PerfTimingTracker,
) {
    let frame = encode_input_ack(pending.ack_seq);
    // 0. Hold packet construction on the arriving carrier before the first
    //    copy is queued: the display flush that follows in this turn admits the
    //    header-only or echo frame this completion owes, and all three leave in
    //    one packet. The flush releases the hold before any other work, and the
    //    turn's end releases it in any case (`release_egress_holds`).
    if peer.egress_hold.is_none() {
        peer.egress_hold = match pending.via_transport {
            PeerTransport::Edge => peer
                .edge_tunnel
                .as_ref()
                .and_then(|tunnel| tunnel.hold_egress()),
            PeerTransport::WebTransport => peer
                .direct_session
                .as_ref()
                .and_then(crate::webtransport::DirectSession::hold_egress),
        };
    }
    // 1. The DATAGRAM copy, on the exact carrier the input arrived on. The
    //    reliable PTY stream carries the input records themselves, so an ack
    //    behind them waits on QUIC retransmission and head-of-line blocking
    //    that the ack has no part in; production measured sent→ack at p50
    //    RTT + 24-80 ms. A datagram twin arrives one network trip after the PTY
    //    write completed, and the browser's ack is cumulative and idempotent,
    //    so receiving both copies is harmless by construction. Sealed on the
    //    datagram sub-lane, because Noise nonces are per sub-lane. A refused
    //    datagram costs this one copy and nothing else: the reliable twin
    //    below still delivers.
    if let Some(wire) = peer.seal_control_wire(CHANNEL_PTY, &frame) {
        // Watched before any carrier holds it: a connection driver can
        // packetize the datagram before the send call returns.
        if perf.owns(peer_id, &peer.signal_session_id)
            && let Some(tag) = perf_timing::ack_datagram_tag(&wire[1..])
        {
            perf.note_input_ack_sent(pending.ack_seq, tag);
        }
        transport_send_datagram(
            pending.via_transport,
            &wire,
            peer.direct_session.as_ref(),
            peer.edge_tunnel.as_ref(),
        );
    }
    // 2. The reliable twin is the guaranteed copy. Frame and ciphertext both
    //    fit fixed stack arrays, and the sealed record rides the reliable lane
    //    inline: nothing allocated here, nothing freed on the send task.
    let mut sealed = [0u8; INLINE_RELIABLE_PAYLOAD_BYTES];
    let Some(sealed_len) = peer.seal_stream_into(CHANNEL_PTY, &frame, &mut sealed) else {
        return;
    };
    // `paths` and the carriers are disjoint fields, so both carrier handles are
    // borrowed rather than cloned per ack.
    let _ = transport_send_reliable_with_fallback(
        &mut peer.paths,
        pending.via_transport,
        CHANNEL_PTY,
        ReliablePayload::inline(sealed_len, sealed),
        peer.direct_session.as_ref(),
        peer.edge_tunnel.as_ref(),
        now_ms,
    );
}

/// Called only after PTY credit returns. Rotate the first peer and bound each
/// peer's work so one blocked paste cannot monopolize another browser's input.
fn refill_waiting_input(
    peers: &mut PeerMap,
    parked: &mut ParkedPeers,
    refill: &mut input::InputRefill,
    writer: &mut PtyWriter,
    terminal: &mut TerminalState,
    perf: &mut PerfTimingTracker,
) {
    let count = peers.len() + parked.len();
    refill.pending = false;
    if count == 0 {
        return;
    }
    let start = refill.next_peer % count;
    refill.next_peer = (start + 1) % count;
    for range in [start..count, 0..start] {
        for (index, peer) in peers.values_mut().chain(parked.states_mut()).enumerate() {
            if !range.contains(&index) || !peer.reliable_inputs.has_pending() {
                continue;
            }
            resume_peer_input(peer, writer, terminal, perf);
            refill.pending |= peer.reliable_inputs.has_pending();
        }
    }
}

fn resume_peer_input(
    peer: &mut PeerDisplayState,
    writer: &mut PtyWriter,
    terminal: &mut TerminalState,
    perf: &mut PerfTimingTracker,
) {
    const ADMISSIONS_PER_PEER: usize = 64;
    let mut remaining = ADMISSIONS_PER_PEER;
    let peer_id = Arc::clone(&peer.peer_id);
    let perf_owner = perf.owns(&peer_id, &peer.signal_session_id);
    input::drain_reliable(peer, &mut |origin, seq, bytes, modelled| {
        if remaining == 0 {
            return false;
        }
        let accepted = enqueue_reliable_input(
            writer, terminal, perf, perf_owner, &peer_id, origin, seq, bytes, modelled,
        );
        if accepted {
            remaining -= 1;
        }
        accepted
    });
}

fn enqueue_reliable_input(
    writer: &mut PtyWriter,
    terminal: &mut TerminalState,
    perf: &mut PerfTimingTracker,
    perf_owner: bool,
    peer_id: &Arc<str>,
    origin: input::InputOrigin,
    seq: u32,
    bytes: &[u8],
    modelled: bool,
) -> bool {
    let observed = perf_owner && origin.observation_epoch == perf.observation_epoch();
    let trace_token = if observed { perf.trace_token() } else { None };
    let Some(wrote) = admit_user_record(
        writer,
        terminal,
        peer_id,
        seq,
        origin.via,
        bytes,
        modelled,
        trace_token,
    ) else {
        return false;
    };
    if wrote
        && observed
        && let Some(received) = origin.received_at
    {
        perf.note_input_received_owned(seq, received);
        perf.note_pty_write_owned(seq, Instant::now());
    }
    true
}

fn handle_reliable_input(
    msg: &mut PeerMessage,
    plaintext: &mut Vec<u8>,
    plaintext_len: usize,
    writer: &mut PtyWriter,
    terminal: &mut TerminalState,
    peers: &mut PeerMap,
    refill: &mut input::InputRefill,
    start: Instant,
    perf: &mut PerfTimingTracker,
) -> ReliableInputOutcome {
    let Some(mut cursor) = input::InputCursor::parse(&plaintext[..plaintext_len]) else {
        return ReliableInputOutcome::default();
    };
    let Some(peer) = peers.get_mut(&*msg.peer_node_id) else {
        return ReliableInputOutcome::default();
    };
    peer.last_input_at_ms = now_ms_since(start);
    let perf_owner = perf.owns(&msg.peer_node_id, &peer.signal_session_id);
    let origin = input::InputOrigin {
        via: msg.via_transport,
        received_at: perf_owner.then(Instant::now),
        observation_epoch: if perf_owner {
            perf.observation_epoch()
        } else {
            None
        },
    };
    let advanced = input::admit_reliable(
        peer,
        &mut cursor,
        plaintext,
        origin,
        &mut |origin, seq, bytes, modelled| {
            enqueue_reliable_input(
                writer,
                terminal,
                perf,
                perf_owner,
                &msg.peer_node_id,
                origin,
                seq,
                bytes,
                modelled,
            )
        },
    );
    let ack_pending = cursor.retransmit && !advanced;
    if ack_pending {
        peer.queue_input_ack(
            peer.keystroke_next_expected_seq.wrapping_sub(1),
            msg.via_transport,
        );
    }
    if advanced && peer.reliable_inputs.has_pending() {
        // A new carrier's prefix can fill a gap held by the other carrier.
        // Capacity resumes are owned by PTY completion, never an input timer.
        resume_peer_input(peer, writer, terminal, perf);
    }
    // Everything this record carried reached the FIFO (or was already there)
    // exactly when the cursor is exhausted; a retained remainder has no ACK
    // coming until the PTY takes it.
    let probe = cursor.probe.map(|token| RecordProbe {
        token,
        taken: cursor.is_empty(),
    });
    if !cursor.is_empty() {
        peer.reliable_inputs.retain(msg, cursor, origin, plaintext);
    }
    refill.pending |= peer.reliable_inputs.has_pending();
    ReliableInputOutcome { ack_pending, probe }
}

/// What a reliable PTY record left for the dispatcher: whether it queued an
/// input ACK, and the liveness probe it carried.
#[derive(Default)]
struct ReliableInputOutcome {
    ack_pending: bool,
    probe: Option<RecordProbe>,
}

struct RecordProbe {
    token: u64,
    /// The FIFO took everything the record carried.
    taken: bool,
}

/// What a PTY datagram left for the dispatcher: whether it queued an input
/// ACK, and the liveness probe its run carried with the run's last seq, which
/// decides whether an ACK will cover a lost pong.
#[derive(Default)]
struct PtyLaneOutcome {
    ack_pending: bool,
    probe: Option<RunProbe>,
}

struct RunProbe {
    token: u64,
    top_seq: u32,
}

fn handle_pty_channel(
    msg: &PeerMessage,
    payload: &[u8],
    pty_writer: &mut PtyWriter,
    terminal: &mut TerminalState,
    peers: &mut PeerMap,
    start_instant: Instant,
    perf_timing: &mut PerfTimingTracker,
) -> PtyLaneOutcome {
    let Some((msg_type, body)) = decode_proto_frame(payload) else {
        warn!("malformed protocol frame on pty lane; dropping");
        return PtyLaneOutcome::default();
    };
    match msg_type {
        MSG_TYPE_SEQUENCED_KEYSTROKE => {
            if body.len() >= 4 {
                let seq = u32::from_be_bytes([body[0], body[1], body[2], body[3]]);
                let keystroke_data = &body[4..];
                if !input_record::validate(keystroke_data) {
                    warn!("malformed input record on pty lane; dropping");
                    return PtyLaneOutcome::default();
                }

                let Some(peer) = peers.get_mut(&*msg.peer_node_id) else {
                    return PtyLaneOutcome::default();
                };
                peer.last_input_at_ms = now_ms_since(start_instant);
                let perf_owner = perf_timing.owns(&msg.peer_node_id, &peer.signal_session_id);
                // Clock reads are gated on a listener — `PerfTimingTracker`'s
                // own contract — so the common case pays none.
                if perf_owner {
                    perf_timing.note_input_received_owned(seq, Instant::now());
                }
                let peer_id = Arc::clone(&msg.peer_node_id);
                let mut enqueue = |queued_seq: u32, bytes: &[u8], shadow_modelled: bool| {
                    let trace_token = if perf_owner {
                        perf_timing.trace_token_for_pending_input(queued_seq)
                    } else {
                        None
                    };
                    let admitted = admit_user_record(
                        pty_writer,
                        terminal,
                        &peer_id,
                        queued_seq,
                        msg.via_transport,
                        bytes,
                        shadow_modelled,
                        trace_token,
                    );
                    // The reorder buffer means the seq entering the FIFO is
                    // not necessarily the seq that arrived, so stamp the one
                    // actually written.
                    if perf_owner {
                        match admitted {
                            Some(true) => {
                                perf_timing.note_pty_write_owned(queued_seq, Instant::now());
                            }
                            Some(false) => perf_timing.note_input_silent_owned(queued_seq),
                            None => {}
                        }
                    }
                    admitted.is_some()
                };
                // A sequenced keystroke rides only the reliable stream and the
                // browser never re-emits it, so a copy that advanced nothing is
                // a replay of input already confirmed (or already in the FIFO)
                // and is owed nothing: the completion that confirmed it queued
                // its ack, and its retry — if any — arrives as a marked
                // `input_run`. Acknowledging here produced a second ack record
                // for the same keystroke and nothing consumed it.
                peer.apply_keystroke(seq, keystroke_data, false, &mut enqueue);
            }
        }
        MSG_TYPE_INPUT_RUN => {
            let Some((run, entries)) = parse_input_run(body) else {
                // Malformed runs are rejected before any PTY mutation, and a
                // probe they carry is answered with nothing.
                return PtyLaneOutcome::default();
            };
            let Some(peer) = peers.get_mut(&*msg.peer_node_id) else {
                return PtyLaneOutcome::default();
            };
            let probe = run.probe.map(|token| RunProbe {
                token,
                top_seq: run.top_seq(),
            });
            peer.last_input_at_ms = now_ms_since(start_instant);
            let perf_owner = perf_timing.owns(&msg.peer_node_id, &peer.signal_session_id);
            // Sampled only when a browser is profiling: `PerfTimingTracker`
            // discards the stamp otherwise, so the clock read would be waste.
            let run_received_at = perf_owner.then(Instant::now);
            let trace_token = if perf_owner {
                perf_timing.trace_token()
            } else {
                None
            };
            let peer_id = Arc::clone(&msg.peer_node_id);
            let mut enqueue = |seq: u32, bytes: &[u8], shadow_modelled: bool| {
                let admitted = admit_user_record(
                    pty_writer,
                    terminal,
                    &peer_id,
                    seq,
                    msg.via_transport,
                    bytes,
                    shadow_modelled,
                    trace_token,
                );
                // Every entry in a run shares the run's arrival instant: they
                // arrived in one datagram, so they genuinely did. A record
                // that wrote nothing has no turnaround to time.
                if admitted == Some(true)
                    && let Some(received_at) = run_received_at
                {
                    perf_timing.note_input_received_owned(seq, received_at);
                    perf_timing.note_pty_write_owned(seq, Instant::now());
                }
                admitted.is_some()
            };
            let applied = peer.apply_input_run(
                run.base_seq,
                entries.map(|entry| (entry.payload, entry.shadow_modelled)),
                &mut enqueue,
            );
            // A run that advanced nothing is one of five things: the dual-send
            // twin of every keystroke, the idle retry's re-emission, a
            // queued-but-unconfirmed replay, a backpressured FIFO rejection, or
            // a reorder-gap insert. Only the retry needs an answer — its
            // suffix is exactly what the browser has not heard about — and
            // only the browser knows it is retrying, so it marks the run.
            // Everything else is either answered by the completion that
            // confirms it or by the marked retry that follows.
            let ack_pending = run.retransmit && !applied.advanced;
            if ack_pending {
                peer.queue_input_ack(applied.ack_seq, msg.via_transport);
            }
            return PtyLaneOutcome { ack_pending, probe };
        }
        _ => warn_unhandled_wire_type("pty", msg_type, body.len()),
    }
    PtyLaneOutcome::default()
}

async fn handle_ctrl_channel(
    msg: &PeerMessage,
    payload: &[u8],
    pty_master: &(dyn portable_pty::MasterPty + Send),
    terminal: &mut TerminalState,
    event_tx: &EventSink,
    registry: &mut PeerRegistry,
    display_prepare_worker: &mut DisplayPrepareWorker,
    start_instant: Instant,
    network_state: &Arc<RwLock<NetworkState>>,
    current_row_hashes: &[u64],
    current_row_captures: &HashMap<u16, CapturedRow>,
    perf_timing: &mut PerfTimingTracker,
) {
    let peers = &mut registry.peers;
    let Some((msg_type, body)) = decode_proto_frame(payload) else {
        warn!("malformed protocol frame on ctrl lane; dropping");
        return;
    };
    if matches!(
        msg_type,
        MSG_TYPE_GRAPHICS_REQUEST | MSG_TYPE_GRAPHICS_CANCEL
    ) {
        if let Some(peer) = peers.get_mut(&*msg.peer_node_id) {
            assets::handle(
                msg,
                msg_type,
                body,
                peer,
                terminal,
                now_ms_since(start_instant),
            );
        }
        return;
    }
    if msg_type == network::protocol::MSG_TYPE_GEOMETRY_CLAIM {
        geometry::handle(
            msg,
            body,
            pty_master,
            terminal,
            peers,
            now_ms_since(start_instant),
        );
        return;
    }
    if msg_type == MSG_TYPE_OPEN_URL_ACK {
        // Only an authenticated browser on the reliable lane retires a request;
        // a malformed id retires nothing.
        let authenticated = peers
            .get(&*msg.peer_node_id)
            .is_some_and(|peer| peer.authenticated);
        if msg.delivery == DeliveryMode::Stream
            && authenticated
            && let Ok(id) = <[u8; OPEN_URL_ID_BYTES]>::try_from(body)
        {
            terminal.acknowledge_open_url(
                u32::from_be_bytes([id[0], id[1], id[2], id[3]]),
                u32::from_be_bytes([id[4], id[5], id[6], id[7]]),
            );
        }
        return;
    }
    if msg_type == MSG_TYPE_PERF_ENABLE {
        // Profiling configuration is an ordered control record. Accepting it
        // from the datagram nonce lane would let loss/reordering cut an
        // observation boundary even though the wire contract assigns it to
        // reliable CTRL.
        if msg.delivery != DeliveryMode::Stream {
            return;
        }
        // A malformed or zero observation epoch changes nothing. In particular,
        // it cannot switch profiling on or cut the current owner's samples.
        if let (Some(peer), Some(config)) = (
            peers.get_mut(&*msg.peer_node_id),
            parse_perf_timing_config(body),
        ) {
            perf_timing.configure(
                Arc::clone(&msg.peer_node_id),
                &peer.signal_session_id,
                config.enabled,
                config.observation_epoch,
            );
            // Ignored configuration from another peer/session leaves the
            // tracker owner unchanged; it must not lend that owner's token
            // to the caller's display path.
            peer.perf_trace_token = if perf_timing.owns(&peer.peer_id, &peer.signal_session_id) {
                perf_timing.trace_token()
            } else {
                None
            };
        }
        return;
    }
    if msg_type == MSG_TYPE_PERF_GRID_CONVERGENCE_REQUEST {
        handle_perf_grid_convergence_request(
            msg,
            body,
            terminal,
            peers,
            perf_timing,
            now_ms_since(start_instant),
        );
    } else if msg_type == MSG_TYPE_DISPLAY_RESYNC_ROWS && body.len() >= 6 {
        handle_display_resync_rows(msg, body, peers, current_row_hashes);
    } else if msg_type == MSG_TYPE_DISPLAY_ACK && body.len() == DISPLAY_ACK_PAYLOAD_BYTES {
        // Reliable selective display ACK: the loss-proof backstop to the
        // datagram displayAck. On the reliable ctrl lane it credits the baseline
        // even when every datagram ACK is lost. Same body as the datagram, so
        // one parser serves both lanes.
        let Some(ack) = parse_display_ack(body) else {
            return;
        };
        let now_ms = now_ms_since(start_instant);
        if let Some(peer) = peers.get_mut(&*msg.peer_node_id) {
            handle_reliable_display_ack(
                peer,
                ack,
                now_ms,
                msg.via_transport,
                current_row_hashes,
                terminal.has_dirty(),
            );
        }
    } else if msg_type == MSG_TYPE_TRANSPORT_HINT && body.len() == TRANSPORT_HINT_PAYLOAD_BYTES {
        handle_transport_hint(msg, body, peers);
    } else if msg_type == MSG_TYPE_DISPLAY_RECEIVER_PROFILE {
        handle_display_receiver_profile(msg, body, peers);
    } else if msg_type == MSG_TYPE_HEARTBEAT_PING && body.len() == 8 {
        handle_heartbeat_ping(msg, body, peers).await;
    } else if msg_type == MSG_TYPE_HEARTBEAT_PONG && body.len() == 16 {
        handle_heartbeat_pong(msg, body, peers, start_instant);
    } else if msg_type == MSG_TYPE_DISPLAY_SNAPSHOT_REQUEST && body.is_empty() {
        handle_display_snapshot_request(msg, peers);
    } else if msg_type == MSG_TYPE_DISPLAY_RESUME && body.len() >= 12 {
        handle_display_resume(msg, body, peers, current_row_hashes, current_row_captures);
    } else if msg_type == MSG_TYPE_DISCONNECT && body.len() == 1 {
        if msg.delivery != DeliveryMode::Stream {
            return;
        }
        if let Some(peer) = peers.get(&*msg.peer_node_id)
            && terminal.geometry_authority.release(peer)
        {
            geometry::publish(
                &terminal.geometry_authority,
                peers,
                now_ms_since(start_instant),
            );
        }
        handle_explicit_peer_disconnect(msg, body, registry, network_state, event_tx).await;
    } else if msg_type == MSG_TYPE_RESIZE && body.len() == 24 {
        if msg.delivery == DeliveryMode::Stream {
            handle_resize_request(&msg.peer_node_id, body, pty_master, terminal, peers);
        }
    } else if msg_type == MSG_TYPE_DISPLAY_DICT_READY && body.len() == 1 {
        handle_display_dict_ready(msg, body, peers, display_prepare_worker);
    } else if msg_type == MSG_TYPE_DISPLAY_DICT_ACK && body.len() == 4 {
        handle_display_dict_ack(msg, body, peers);
    } else {
        warn_unhandled_wire_type("ctrl", msg_type, body.len());
    }
}

#[cfg(test)]
#[path = "main_tests/perf_ctrl_owner_tests.rs"]
mod perf_ctrl_owner_tests;

/// Answer one authenticated, measurement-only full-grid observation.
///
/// The outer dispatch has already opened the CTRL frame through this peer's
/// Noise session. Profiling ownership and observation epoch provide the second
/// gate before the O(rows * cols) terminal traversal, so an ordinary terminal
/// client cannot turn this diagnostic into hot-path work. The response is
/// evidence only: it changes no display baseline, ACK, loss, repair, or
/// presentation state. Browser mismatch handling remains the ordinary
/// selective row-resynchronization protocol.
fn handle_perf_grid_convergence_request(
    msg: &PeerMessage,
    body: &[u8],
    terminal: &mut TerminalState,
    peers: &mut PeerMap,
    perf_timing: &PerfTimingTracker,
    now_ms: f64,
) {
    // The convergence oracle is an ordered, measurement-only CTRL exchange.
    // Do not let an authenticated client move it onto the datagram sub-lane:
    // that would bypass the reliable-lane ordering assumed by its epoch fence.
    if msg.delivery != DeliveryMode::Stream {
        return;
    }
    let Some(request) = parse_perf_grid_convergence_request(body) else {
        return;
    };
    let Some(peer) = peers.get(msg.peer_node_id.as_ref()) else {
        return;
    };
    if !perf_timing.owns(&msg.peer_node_id, &peer.signal_session_id)
        || perf_timing.observation_epoch() != Some(request.observation_epoch)
    {
        return;
    }

    // Recompute from the terminal itself instead of reusing the incremental
    // flush cache. A request can arrive before the display timer consumes a
    // just-mutated dirty range; the convergence oracle must describe the
    // authoritative grid at this exact owner-loop turn, not its last display
    // scheduling snapshot.
    let mut row_hashes = Vec::with_capacity(usize::from(terminal.rows));
    terminal.current_row_hashes_into(&mut row_hashes);

    let Some(peer) = peers.get_mut(msg.peer_node_id.as_ref()) else {
        return;
    };
    // No await occurs between the two ownership checks, but keep the second
    // check beside the response construction: this is the invariant a future
    // off-owner hash worker would otherwise accidentally lose.
    if !perf_timing.owns(&msg.peer_node_id, &peer.signal_session_id)
        || perf_timing.observation_epoch() != Some(request.observation_epoch)
    {
        return;
    }
    let Some(frame) = encode_perf_grid_convergence_response(
        request.observation_epoch,
        request.probe_id,
        peer.generation,
        peer.last_display_seq_sent,
        terminal.cols,
        terminal.rows,
        &row_hashes,
    ) else {
        return;
    };
    let Some(sealed) = peer.seal_stream(CHANNEL_CTRL, &frame) else {
        return;
    };
    let primary = peer.primary_path(now_ms);
    let edge = peer.edge_tunnel.clone();
    let _ = transport_send_reliable_with_fallback(
        &mut peer.paths,
        primary,
        CHANNEL_CTRL,
        ReliablePayload::Heap(sealed),
        peer.direct_session.as_ref(),
        edge.as_ref(),
        now_ms,
    );
}

/// Record whether this peer's terminal worker currently holds the compression
/// dictionary.
///
/// Readiness is per-connection and edge-triggered: a replacement terminal
/// worker clears it before the daemon can send another dictionary-compressed
/// frame, so a resumed or replaced browser cannot inherit a predecessor's
/// dictionary. Withdrawal fences the peer's own state and then discards the
/// shared preparation if no ready consumer is left.
fn handle_display_dict_ready(
    msg: &PeerMessage,
    body: &[u8],
    peers: &mut PeerMap,
    display_prepare_worker: &mut DisplayPrepareWorker,
) {
    let ready = match body[0] {
        0 => false,
        1 => true,
        // Non-canonical readiness is malformed, not a hint. Dropping it leaves
        // the peer on its last acknowledged state rather than guessing.
        _ => return,
    };
    let withdrew_dictionary = {
        let Some(peer) = peers.get_mut(msg.peer_node_id.as_ref()) else {
            return;
        };
        let withdrew = peer.display_dictionary_ready && !ready;
        peer.display_dictionary_ready = ready;
        if withdrew {
            fence_display_dictionary_withdrawal(peer);
        }
        withdrew
    };
    if withdrew_dictionary {
        fence_dictionary_preparation_without_consumers(display_prepare_worker, peers);
    }
}

/// Promote a pending compression dictionary once the peer confirms it stored
/// the exact bytes. A stale or unknown id is ignored rather than treated as an
/// error: a late acknowledgement from a superseded install must not resurrect
/// a dictionary the daemon has already replaced.
fn handle_display_dict_ack(msg: &PeerMessage, body: &[u8], peers: &mut PeerMap) {
    let Some(peer) = peers.get_mut(msg.peer_node_id.as_ref()) else {
        return;
    };
    let Ok(dict_id) = body[..4].try_into().map(u32::from_be_bytes) else {
        return;
    };
    peer.dictionary.acknowledge(dict_id);
}

async fn handle_explicit_peer_disconnect(
    msg: &PeerMessage,
    body: &[u8],
    registry: &mut PeerRegistry,
    network_state: &Arc<RwLock<NetworkState>>,
    event_tx: &EventSink,
) {
    let PeerRegistry {
        peers, edge_dials, ..
    } = registry;
    // Retire dial ownership before closing either registry tunnel. The lane's
    // close event is then stale by construction and cannot redial an
    // explicitly disconnected peer.
    edge_dials.remove(msg.peer_node_id.as_ref());
    handle_peer_disconnect(msg, body, peers, event_tx);
    network::remove_edge_connections(network_state, &msg.peer_node_id).await;
}

#[cfg(test)]
#[path = "main_tests/resize_order_tests.rs"]
mod resize_order_tests;

fn handle_resize_request(
    peer_id: &str,
    body: &[u8],
    pty_master: &(dyn portable_pty::MasterPty + Send),
    terminal: &mut TerminalState,
    peers: &mut PeerMap,
) {
    let Some(viewport) = pty::Viewport::decode(body) else {
        return;
    };
    let pty::Viewport {
        cols,
        rows,
        seq,
        pixel_width,
        pixel_height,
        ..
    } = viewport;
    let Some(peer) = peers.get_mut(peer_id) else {
        return;
    };
    if !terminal
        .geometry_authority
        .permits(peer, viewport.geometry_generation)
        || seq == 0
        || (peer.last_resize_seq != 0
            && (seq == peer.last_resize_seq
                || seq.wrapping_sub(peer.last_resize_seq) >= (1_u32 << 31)))
    {
        return;
    }
    // A late edge resize must not revert a newer direct viewport, even if the
    // newest request's PTY operation failed. This records intent, not delivery.
    peer.last_resize_seq = seq;
    // Reconnect may carry a fresh intent for the already committed viewport.
    // Acknowledge it without an ioctl, prediction reset, or full-grid snapshot.
    if terminal.viewport_matches(viewport) {
        return;
    }
    if let Err(e) = pty_master.resize(portable_pty::PtySize {
        rows,
        cols,
        pixel_width,
        pixel_height,
    }) {
        warn!("PTY resize failed: {e}");
    } else {
        commit_viewport(terminal, peers, viewport);
    }
}

/// Commit a viewport the PTY accepted. Grid and pixel geometry change together,
/// and only a snapshot carries geometry, so every viewer needs one.
fn commit_viewport(terminal: &mut TerminalState, peers: &mut PeerMap, viewport: pty::Viewport) {
    terminal.resize_viewport(viewport);
    for peer in peers.values_mut() {
        peer.needs_snapshot = true;
        // The caller's generic post-message scheduler treats
        // `needs_full_diff` as an urgent edge, bringing the bounded
        // snapshot turn forward even if an older flush timer was armed.
        peer.needs_full_diff = true;
    }
}

/// Every registry keyed by a browser identity, owned as one value.
///
/// These six were separate locals threaded through the owner loop as up to six
/// parameters each. They are kept as distinct fields rather than merged into one
/// map because their lifetimes genuinely differ — `edge_dials` exists before any
/// peer does, and the two direct-WebTransport maps are keyed by temporary connection id rather than
/// by peer id. What they share is that a retirement touching one almost always
/// has to touch the others, and getting that set wrong is the failure mode this
/// grouping exists to prevent: the cross-map retirements (such as
/// `retire_peer_transport_ownership`) take the whole registry, so a call site
/// cannot forget one.
///
/// The convention, so this does not drift into "some functions take it, some
/// don't, nobody remembers why": **dispatchers and retirements that span more
/// than one registry take `&mut PeerRegistry`; leaf helpers that touch a fixed
/// two or three registries keep explicit parameters**, because there the named
/// list is the clearer contract and the whole-registry borrow would only widen
/// what the callee may reach. Handlers that take the registry destructure it at
/// the top, which yields exactly the disjoint field borrows the old parameter
/// list did, at no runtime cost.
struct PeerRegistry {
    input_refill: input::InputRefill,
    /// Authenticated and pre-auth peers with live display state.
    peers: PeerMap,
    /// Display state of disconnected peers, retained for resume.
    parked: ParkedPeers,
    /// Pre-auth edge dial supervisors, keyed by browser identity. Present
    /// before the peer exists and after it is gone.
    edge_dials: HashMap<String, EdgeDialState>,
    /// Temporary direct-WebTransport connection id -> owning peer identity.
    /// Values are interned because this is consulted on every inbound direct
    /// frame and must not mint a `String` each time.
    wt_temp_to_real: HashMap<String, Arc<str>>,
    /// In-flight direct-WebTransport upgrades, keyed by temporary id.
    wt_upgrade_pending: HashMap<String, WtUpgradePending>,
}

impl PeerRegistry {
    fn new() -> Self {
        Self {
            input_refill: input::InputRefill::default(),
            peers: HashMap::new(),
            parked: ParkedPeers::new(),
            edge_dials: HashMap::new(),
            wt_temp_to_real: HashMap::new(),
            wt_upgrade_pending: HashMap::new(),
        }
    }
}

/// A completed per-session edge dial handed from a spawned dial task back to the
/// run loop. `peer_id` is the browser identity label (the Noise prologue id) the
/// dial was bound to; `session_id` is the rendezvous key the daemon spliced on.
/// `result` is `Err` only after the dial's bounded external-failure backoff is
/// exhausted. `generation` rejects both old-session and same-session late results.
struct EdgeAttach {
    peer_id: String,
    session_id: String,
    generation: EdgeLaneGeneration,
    result: Result<Arc<edge_tunnel::EdgeTunnel>, String>,
    /// Which of the dial's lanes completed. `session_id` always carries the BASE
    /// session id (never a lane suffix such as `#bulk`), so the authenticated-peer
    /// match is identical for every lane.
    lane: EdgeLane,
}

/// What one edge tunnel's lifecycle task reports to the owner. It emits exactly
/// one `Closed` for its tunnel, when the tunnel's connection has closed.
///
/// `generation` is allocated by the owner loop for one lane dial. `tunnel`
/// provides a second identity check at the registry boundary, preventing a
/// delayed close from detaching a replacement even if session ids are reused.
enum EdgeLaneEvent {
    Candidate {
        peer_id: Arc<str>,
        identity: EdgeIngressIdentity,
        message: edge_candidate::CandidateMessage,
    },
    Closed(EdgeLaneClosed),
    RelayDataPaused {
        peer_id: String,
        identity: EdgeIngressIdentity,
        paused: bool,
    },
    CounterpartAttached {
        peer_id: String,
        identity: EdgeIngressIdentity,
    },
    /// The edge reported a proven address for a browser signaling attachment.
    /// The owner reads it back through the tunnel, which applies it only to
    /// the attachment paired now.
    BrowserPath {
        peer_id: String,
        identity: EdgeIngressIdentity,
    },
}

struct EdgeLaneClosed {
    peer_id: String,
    session_id: String,
    generation: EdgeLaneGeneration,
    lane: EdgeLane,
    tunnel: Arc<edge_tunnel::EdgeTunnel>,
    close_reason: edge_tunnel::EdgeTunnelCloseReason,
}

type EdgeLaneGeneration = u64;

#[derive(Default)]
struct CancelledSessions {
    /// Exact `(browser_node_id, session_id)` tuples and their monotonic expiry.
    entries: HashMap<(String, String), f64>,
}

impl CancelledSessions {
    fn prune(&mut self, now_ms: f64) {
        self.entries
            .retain(|_, expires_at_ms| *expires_at_ms > now_ms);
    }

    fn contains(&mut self, browser_node_id: &str, session_id: &str, now_ms: f64) -> bool {
        self.prune(now_ms);
        self.entries
            .contains_key(&(browser_node_id.to_string(), session_id.to_string()))
    }

    fn insert(&mut self, browser_node_id: &str, session_id: &str, now_ms: f64) {
        self.prune(now_ms);
        let key = (browser_node_id.to_string(), session_id.to_string());
        if self.entries.len() >= CANCELLED_SESSION_TOMBSTONE_CAP && !self.entries.contains_key(&key)
        {
            let oldest = self
                .entries
                .iter()
                .min_by(|(left_key, left_expiry), (right_key, right_expiry)| {
                    left_expiry
                        .total_cmp(right_expiry)
                        .then_with(|| left_key.cmp(right_key))
                })
                .map(|(key, _)| key.clone());
            if let Some(oldest) = oldest {
                self.entries.remove(&oldest);
            }
        }
        self.entries
            .insert(key, now_ms + CANCELLED_SESSION_TOMBSTONE_TTL_MS);
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.entries.len()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct EdgeDialLane {
    generation: EdgeLaneGeneration,
    state: EdgeDialLaneState,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct EdgePreauthLease {
    /// The interactive generation allocated for the session_start that created
    /// this owner. A replacement session therefore cannot be expired by a stale
    /// deadline captured for its predecessor.
    generation: EdgeLaneGeneration,
    expires_at_ms: f64,
}

#[derive(Debug)]
struct EdgeDialLifecycle {
    preauth_lease: Option<EdgePreauthLease>,
    signaling_redial_available: bool,
    /// One autonomous fallback is permitted per concrete session/auth event.
    /// A successful socket attach does not replenish it: otherwise a relay that
    /// repeatedly accepts then closes can create an unbounded RTT-speed storm.
    interactive_redial_available: bool,
    bulk_redial_available: bool,
    /// Backoff for the BACKGROUND redial ladder, which retries the interactive
    /// lane for as long as a carrier gap is worth repairing.
    ///
    /// Per peer, not per call. `connect_with_backoff` builds its own
    /// `EdgeConnectBackoff` inside the invocation, so that ceiling dies with the
    /// call and can bound nothing across lane closes — which is why raising its
    /// `max_attempts` is the wrong lever. It would give an uncancellable ladder
    /// inside a detached task, invisible to the run loop and unable to see the
    /// window deadline that should terminate it.
    redial_backoff: edge_tunnel::EdgeConnectBackoff,
    /// When the next background redial is due, if one is scheduled.
    redial_due_at_ms: Option<f64>,
    /// The peer's three tunnels to its edge, across redials: a packet one
    /// hears reopens the others' backed-off probes, and a verified reset of
    /// one makes the others verify their own state.
    probe_group: wtransport::quinn::ProbeGroup,
}

impl Default for EdgeDialLifecycle {
    fn default() -> Self {
        Self {
            preauth_lease: None,
            signaling_redial_available: true,
            interactive_redial_available: true,
            bulk_redial_available: true,
            redial_backoff: edge_tunnel::EdgeConnectBackoff::new(),
            redial_due_at_ms: None,
            probe_group: wtransport::quinn::ProbeGroup::new(),
        }
    }
}

struct EdgeDialState {
    session_id: String,
    pending_request: PendingSessionRequest,
    config: edge_tunnel::EdgeConfig,
    signaling: EdgeDialLane,
    interactive: EdgeDialLane,
    bulk: EdgeDialLane,
    lifecycle: EdgeDialLifecycle,
}

impl EdgeDialState {
    fn lane(&self, lane: EdgeLane) -> EdgeDialLane {
        match lane {
            EdgeLane::Signaling => self.signaling,
            EdgeLane::Interactive => self.interactive,
            EdgeLane::Bulk => self.bulk,
        }
    }

    fn lane_mut(&mut self, lane: EdgeLane) -> &mut EdgeDialLane {
        match lane {
            EdgeLane::Signaling => &mut self.signaling,
            EdgeLane::Interactive => &mut self.interactive,
            EdgeLane::Bulk => &mut self.bulk,
        }
    }

    fn redial_lane_mut(&mut self, lane: EdgeLane) -> (&mut EdgeDialLane, &mut bool) {
        match lane {
            EdgeLane::Signaling => (
                &mut self.signaling,
                &mut self.lifecycle.signaling_redial_available,
            ),
            EdgeLane::Interactive => (
                &mut self.interactive,
                &mut self.lifecycle.interactive_redial_available,
            ),
            EdgeLane::Bulk => (&mut self.bulk, &mut self.lifecycle.bulk_redial_available),
        }
    }
}

#[cfg(test)]
fn test_pending_session_request(session_id: &str, seed: u8) -> PendingSessionRequest {
    PendingSessionRequest::from_encoded(
        "user-1",
        "delegation-1",
        session_id,
        &base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode([seed; merkur_e2e::SESSION_NONCE_BYTES]),
        &base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode([seed; merkur_e2e::ML_KEM_ENCAPSULATION_KEY_BYTES]),
    )
    .expect("valid test pending session request")
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum EdgeDialLaneState {
    Paused,
    Pending,
    Succeeded,
    Failed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct EdgeDialPlan {
    signaling: Option<EdgeLaneGeneration>,
    interactive: Option<EdgeLaneGeneration>,
    bulk: Option<EdgeLaneGeneration>,
}

#[derive(Clone)]
struct EdgeDialRequest {
    peer_id: String,
    session_id: String,
    config: edge_tunnel::EdgeConfig,
    generation: EdgeLaneGeneration,
    lane: EdgeLane,
    probe_group: wtransport::quinn::ProbeGroup,
}

#[derive(Clone, Debug, PartialEq)]
struct EdgePreauthDeadline {
    peer_id: String,
    session_id: String,
    lease: EdgePreauthLease,
}

struct RetiredEdgeDial {
    peer_id: String,
    state: EdgeDialState,
}

fn allocate_edge_lane_generation(next_generation: &mut EdgeLaneGeneration) -> EdgeLaneGeneration {
    *next_generation = next_generation.wrapping_add(1);
    if *next_generation == 0 {
        *next_generation = 1;
    }
    *next_generation
}

fn edge_preauth_owner_count(edge_dials: &HashMap<String, EdgeDialState>) -> usize {
    edge_dials
        .values()
        .filter(|state| state.lifecycle.preauth_lease.is_some())
        .count()
}

/// A same-owner command consumes no additional capacity. Replacing another
/// leased session for the same peer also keeps the count flat; replacing an
/// authenticated owner creates one new pre-auth owner and therefore needs room.
fn edge_preauth_capacity_available(
    edge_dials: &HashMap<String, EdgeDialState>,
    peer_id: &str,
    session_id: &str,
) -> bool {
    let adds_owner = match edge_dials.get(peer_id) {
        None => true,
        Some(state) if state.session_id == session_id => false,
        Some(state) => state.lifecycle.preauth_lease.is_none(),
    };
    !adds_owner || edge_preauth_owner_count(edge_dials) < EDGE_PREAUTH_LEASE_CAP
}

fn arm_new_edge_preauth_lease(
    edge_dials: &mut HashMap<String, EdgeDialState>,
    peer_id: &str,
    session_id: &str,
    now_ms: f64,
) -> bool {
    let Some(state) = edge_dials.get_mut(peer_id) else {
        return false;
    };
    if state.session_id != session_id {
        return false;
    }
    state.lifecycle.preauth_lease = Some(EdgePreauthLease {
        generation: state.signaling.generation,
        expires_at_ms: now_ms + EDGE_PREAUTH_LEASE_TTL_MS,
    });
    true
}

fn next_edge_preauth_deadline(
    edge_dials: &HashMap<String, EdgeDialState>,
) -> Option<EdgePreauthDeadline> {
    edge_dials
        .iter()
        .filter_map(|(peer_id, state)| {
            state
                .lifecycle
                .preauth_lease
                .map(|lease| EdgePreauthDeadline {
                    peer_id: peer_id.clone(),
                    session_id: state.session_id.clone(),
                    lease,
                })
        })
        .min_by(|left, right| {
            left.lease
                .expires_at_ms
                .total_cmp(&right.lease.expires_at_ms)
                .then_with(|| left.peer_id.cmp(&right.peer_id))
                .then_with(|| left.session_id.cmp(&right.session_id))
        })
}

fn retire_edge_preauth_if_current(
    edge_dials: &mut HashMap<String, EdgeDialState>,
    owner: &EdgePreauthDeadline,
    now_ms: f64,
) -> Option<RetiredEdgeDial> {
    let current = edge_dials.get(&owner.peer_id)?;
    if current.session_id != owner.session_id
        || current.lifecycle.preauth_lease != Some(owner.lease)
        || now_ms < owner.lease.expires_at_ms
    {
        return None;
    }
    edge_dials
        .remove(&owner.peer_id)
        .map(|state| RetiredEdgeDial {
            peer_id: owner.peer_id.clone(),
            state,
        })
}

fn take_expired_edge_preauth(
    edge_dials: &mut HashMap<String, EdgeDialState>,
    now_ms: f64,
) -> Vec<RetiredEdgeDial> {
    let mut retired = Vec::new();
    while let Some(owner) = next_edge_preauth_deadline(edge_dials) {
        if owner.lease.expires_at_ms > now_ms {
            break;
        }
        let Some(expired) = retire_edge_preauth_if_current(edge_dials, &owner, now_ms) else {
            break;
        };
        retired.push(expired);
    }
    retired
}

/// Authentication may release only the exact interactive edge generation that
/// carried a positive auth result. An older authenticated PeerDisplayState is
/// insufficient: session_start can install a replacement dial before re-auth.
fn release_edge_preauth_lease(
    edge_dials: &mut HashMap<String, EdgeDialState>,
    peer_id: &str,
    ingress: Option<&EdgeIngressIdentity>,
    authenticated: bool,
) -> bool {
    if !authenticated {
        return false;
    }
    let Some(ingress) = ingress.filter(|ingress| ingress.lane == EdgeLane::Signaling) else {
        return false;
    };
    let Some(state) = edge_dials.get_mut(peer_id) else {
        return false;
    };
    if state.session_id != ingress.session_id.as_ref()
        || state.signaling.generation != ingress.generation
        || state.signaling.state != EdgeDialLaneState::Succeeded
        || state.lifecycle.preauth_lease.is_none()
    {
        return false;
    }
    state.lifecycle.preauth_lease = None;
    state.lifecycle.signaling_redial_available = true;
    state.lifecycle.interactive_redial_available = true;
    state.lifecycle.bulk_redial_available = true;
    // A fresh authentication is a new lifecycle event, so the ladder starts over
    // rather than inheriting a ceiling grown during the gap it just closed.
    state.lifecycle.redial_backoff = edge_tunnel::EdgeConnectBackoff::new();
    state.lifecycle.redial_due_at_ms = None;
    true
}

fn accept_edge_attach(
    edge_dials: &mut HashMap<String, EdgeDialState>,
    attach: &EdgeAttach,
    succeeded: bool,
) -> bool {
    let Some(state) = edge_dials.get_mut(&attach.peer_id) else {
        return false;
    };
    if state.session_id != attach.session_id {
        return false;
    }
    let lane = state.lane_mut(attach.lane);
    if lane.generation != attach.generation || lane.state != EdgeDialLaneState::Pending {
        return false;
    }
    lane.state = if succeeded {
        EdgeDialLaneState::Succeeded
    } else {
        EdgeDialLaneState::Failed
    };
    true
}

/// A failed dial completion is itself a concrete lifecycle event. Consume at
/// most one generation-owned fallback permit; a second consecutive failure
/// remains Failed until session_start/network_change explicitly rearms it.
fn restart_failed_edge_lane(
    edge_dials: &mut HashMap<String, EdgeDialState>,
    peer_id: &str,
    session_id: &str,
    lane: EdgeLane,
    next_generation: &mut EdgeLaneGeneration,
    rearm: bool,
) -> Option<EdgeDialRequest> {
    let state = edge_dials.get_mut(peer_id)?;
    if state.session_id != session_id {
        return None;
    }
    let (dial, redial_available) = state.redial_lane_mut(lane);
    if dial.state != EdgeDialLaneState::Failed {
        return None;
    }
    if rearm {
        *redial_available = true;
    }
    if !*redial_available {
        return None;
    }
    *redial_available = false;
    let generation = allocate_edge_lane_generation(next_generation);
    *dial = EdgeDialLane {
        generation,
        state: EdgeDialLaneState::Pending,
    };
    Some(EdgeDialRequest {
        peer_id: peer_id.to_string(),
        session_id: session_id.to_string(),
        config: state.config.clone(),
        generation,
        lane,
        probe_group: state.lifecycle.probe_group.clone(),
    })
}

fn rearm_failed_edge_lanes_for_peer(
    edge_dials: &mut HashMap<String, EdgeDialState>,
    peer_id: &str,
    next_generation: &mut EdgeLaneGeneration,
) -> Vec<EdgeDialRequest> {
    let Some(session_id) = edge_dials
        .get(peer_id)
        .map(|state| state.session_id.clone())
    else {
        return Vec::new();
    };
    EdgeLane::ALL
        .into_iter()
        .filter_map(|lane| {
            restart_failed_edge_lane(
                edge_dials,
                peer_id,
                &session_id,
                lane,
                next_generation,
                true,
            )
        })
        .collect()
}

fn begin_edge_dial(
    edge_dials: &mut HashMap<String, EdgeDialState>,
    peer_id: &str,
    session_id: &str,
    pending_request: &PendingSessionRequest,
    config: &edge_tunnel::EdgeConfig,
    next_generation: &mut EdgeLaneGeneration,
) -> EdgeDialPlan {
    if let Some(state) = edge_dials.get_mut(peer_id)
        && state.session_id == session_id
    {
        // Production admission rejects this conflict before reaching the
        // dial planner. Keep the invariant here too so a future caller
        // cannot silently re-bind an existing rendezvous id.
        if !state.pending_request.same_offer(pending_request) {
            return EdgeDialPlan {
                signaling: None,
                interactive: None,
                bulk: None,
            };
        }
        state.config = config.clone();
        state.lifecycle.signaling_redial_available = true;
        // A concrete session_start is the only event, besides successful
        // authentication, that replenishes autonomous fallback ownership.
        state.lifecycle.interactive_redial_available = true;
        state.lifecycle.bulk_redial_available = true;
        state.lifecycle.redial_backoff = edge_tunnel::EdgeConnectBackoff::new();
        state.lifecycle.redial_due_at_ms = None;
        let interactive = if state.interactive.state == EdgeDialLaneState::Failed {
            let generation = allocate_edge_lane_generation(next_generation);
            state.interactive = EdgeDialLane {
                generation,
                state: EdgeDialLaneState::Pending,
            };
            Some(generation)
        } else {
            None
        };
        let bulk = if state.bulk.state == EdgeDialLaneState::Failed {
            let generation = allocate_edge_lane_generation(next_generation);
            state.bulk = EdgeDialLane {
                generation,
                state: EdgeDialLaneState::Pending,
            };
            Some(generation)
        } else {
            None
        };
        let signaling = if state.signaling.state == EdgeDialLaneState::Failed {
            let generation = allocate_edge_lane_generation(next_generation);
            state.signaling = EdgeDialLane {
                generation,
                state: EdgeDialLaneState::Pending,
            };
            Some(generation)
        } else {
            None
        };
        return EdgeDialPlan {
            signaling,
            interactive,
            bulk,
        };
    }

    let signaling_generation = allocate_edge_lane_generation(next_generation);
    let interactive_generation = allocate_edge_lane_generation(next_generation);
    let bulk_generation = allocate_edge_lane_generation(next_generation);
    edge_dials.insert(
        peer_id.to_string(),
        EdgeDialState {
            session_id: session_id.to_string(),
            pending_request: pending_request.clone(),
            config: config.clone(),
            signaling: EdgeDialLane {
                generation: signaling_generation,
                state: EdgeDialLaneState::Pending,
            },
            interactive: EdgeDialLane {
                generation: interactive_generation,
                state: EdgeDialLaneState::Pending,
            },
            bulk: EdgeDialLane {
                generation: bulk_generation,
                state: EdgeDialLaneState::Pending,
            },
            lifecycle: EdgeDialLifecycle::default(),
        },
    );
    EdgeDialPlan {
        signaling: Some(signaling_generation),
        interactive: Some(interactive_generation),
        bulk: Some(bulk_generation),
    }
}

fn set_relay_data_paused(
    state: &mut EdgeDialState,
    peer_id: &str,
    paused: bool,
    next_generation: &mut EdgeLaneGeneration,
) -> Vec<EdgeDialRequest> {
    let mut requests = Vec::new();
    for lane in [EdgeLane::Interactive, EdgeLane::Bulk] {
        if paused {
            state.lane_mut(lane).state = EdgeDialLaneState::Paused;
        } else if state.lane(lane).state == EdgeDialLaneState::Paused {
            let generation = allocate_edge_lane_generation(next_generation);
            *state.lane_mut(lane) = EdgeDialLane {
                generation,
                state: EdgeDialLaneState::Pending,
            };
            *state.redial_lane_mut(lane).1 = true;
            requests.push(EdgeDialRequest {
                peer_id: peer_id.to_string(),
                session_id: state.session_id.clone(),
                config: state.config.clone(),
                generation,
                lane,
                probe_group: state.lifecycle.probe_group.clone(),
            });
        }
    }
    requests
}

async fn apply_relay_data_paused(
    edge_dials: &mut HashMap<String, EdgeDialState>,
    peers: &mut PeerMap,
    network_state: &Arc<RwLock<NetworkState>>,
    peer_id: &str,
    paused: bool,
    next_generation: &mut EdgeLaneGeneration,
) -> Vec<EdgeDialRequest> {
    let Some(state) = edge_dials.get_mut(peer_id) else {
        return Vec::new();
    };
    let requests = set_relay_data_paused(state, peer_id, paused, next_generation);
    if paused {
        network::remove_edge_lanes(network_state, peer_id, false, true, true).await;
        if let Some(peer) = peers.get_mut(peer_id) {
            peer.edge_tunnel.take();
            peer.edge_tunnel_bulk.take();
            peer.bulk_delivery_confirmed = false;
            peer.paths.edge.available = false;
            peer.paths.edge.consecutive_send_failures = 0;
            peer.retire_display_attempts(PeerTransport::Edge);
            peer.edge_rebind = None;
        }
    }
    requests
}

fn edge_lane_is_current(
    edge_dials: &HashMap<String, EdgeDialState>,
    closed: &EdgeLaneClosed,
) -> bool {
    let Some(state) = edge_dials.get(&closed.peer_id) else {
        return false;
    };
    if state.session_id != closed.session_id {
        return false;
    }
    let lane = state.lane(closed.lane);
    lane.generation == closed.generation && lane.state == EdgeDialLaneState::Succeeded
}

fn retire_or_restart_edge_lane(
    edge_dials: &mut HashMap<String, EdgeDialState>,
    closed: &EdgeLaneClosed,
    next_generation: &mut EdgeLaneGeneration,
    redial: bool,
) -> Option<EdgeDialRequest> {
    let state = edge_dials.get_mut(&closed.peer_id)?;
    if state.session_id != closed.session_id {
        return None;
    }
    let (lane, redial_available) = state.redial_lane_mut(closed.lane);
    if lane.generation != closed.generation || lane.state != EdgeDialLaneState::Succeeded {
        return None;
    }
    lane.state = EdgeDialLaneState::Failed;
    if !redial || !*redial_available {
        return None;
    }
    *redial_available = false;
    let generation = allocate_edge_lane_generation(next_generation);
    *lane = EdgeDialLane {
        generation,
        state: EdgeDialLaneState::Pending,
    };
    Some(EdgeDialRequest {
        peer_id: closed.peer_id.clone(),
        session_id: closed.session_id.clone(),
        config: state.config.clone(),
        generation,
        lane: closed.lane,
        probe_group: state.lifecycle.probe_group.clone(),
    })
}

/// Schedule the next background redial after a failed dial, while the peer
/// still has a carrier gap worth repairing.
///
/// The permit model alone was a deadlock. It granted one autonomous redial per
/// session/auth event and a successful attach never replenished it, so a second
/// consecutive failure left the lane `Failed` until a server-dispatched
/// `session_start` — the one rearm a browser cannot reach, because the
/// `network_change` frame that also rearms rides the carrier that is gone. The
/// daemon would know its lane was dead, have a browser waiting at the edge, and
/// be unable to dial. Reconnecting by hand was the only way out.
///
/// The ladder is bounded by the peer's own carrier-gap deadline rather than by
/// an attempt count: while that window is armed the browser is still out there
/// and the session is still repairable, and once it lapses the liveness sweep
/// parks the peer and there is nothing left to dial for. The storm guard is the
/// per-peer backoff ceiling above, which persists across closes.
fn schedule_background_edge_redial(
    edge_dials: &mut HashMap<String, EdgeDialState>,
    peers: &connection::PeerMap,
    peer_id: &str,
    session_id: &str,
    now_ms: f64,
) -> Option<f64> {
    let peer = peers.get(peer_id)?;
    let deadline = peer.edge_rebind.map(|window| window.deadline_ms);
    let state = edge_dials.get_mut(peer_id)?;
    let signaling_gap = peer.authenticated && state.signaling.state == EdgeDialLaneState::Failed;
    if state.session_id != session_id
        || (!signaling_gap && !deadline.is_some_and(|deadline| now_ms < deadline))
        || !EdgeLane::ALL
            .into_iter()
            .any(|lane| state.lane(lane).state == EdgeDialLaneState::Failed)
    {
        return None;
    }
    if state.lifecycle.redial_due_at_ms.is_some() {
        return state.lifecycle.redial_due_at_ms;
    }
    let delay_ms = state.lifecycle.redial_backoff.next_delay().as_secs_f64() * 1_000.0;
    // Never past the deadline that terminates the ladder: a retry scheduled
    // beyond it would fire against a peer the sweep has already parked.
    let due_at_ms = if signaling_gap {
        now_ms + delay_ms
    } else {
        (now_ms + delay_ms).min(deadline?)
    };
    state.lifecycle.redial_due_at_ms = Some(due_at_ms);
    Some(due_at_ms)
}

/// Take the background redials that have come due, rearming each lane.
///
/// Driven by the heartbeat tick, which already runs on its own 2 s cadence and
/// already holds the deadline this ladder terminates on, so the retry needs no
/// timer of its own.
fn take_due_edge_redials(
    edge_dials: &mut HashMap<String, EdgeDialState>,
    peers: &connection::PeerMap,
    now_ms: f64,
    next_generation: &mut EdgeLaneGeneration,
) -> Vec<EdgeDialRequest> {
    let mut due = Vec::new();
    for (peer_id, state) in edge_dials.iter_mut() {
        let Some(due_at_ms) = state.lifecycle.redial_due_at_ms else {
            continue;
        };
        if now_ms < due_at_ms {
            continue;
        }
        state.lifecycle.redial_due_at_ms = None;
        let Some(peer) = peers.get(peer_id.as_str()) else {
            continue;
        };
        let armed = peer
            .edge_rebind
            .is_some_and(|window| now_ms < window.deadline_ms);
        let signaling_gap =
            peer.authenticated && state.signaling.state == EdgeDialLaneState::Failed;
        if !armed && !signaling_gap {
            continue;
        }
        for lane in EdgeLane::ALL {
            if state.lane(lane).state != EdgeDialLaneState::Failed {
                continue;
            }
            let generation = allocate_edge_lane_generation(next_generation);
            *state.lane_mut(lane) = EdgeDialLane {
                generation,
                state: EdgeDialLaneState::Pending,
            };
            due.push(EdgeDialRequest {
                peer_id: peer_id.clone(),
                session_id: state.session_id.clone(),
                config: state.config.clone(),
                generation,
                lane,
                probe_group: state.lifecycle.probe_group.clone(),
            });
        }
    }
    due
}

fn spawn_edge_dial(request: EdgeDialRequest, edge_attach_tx: &mpsc::Sender<EdgeAttach>) {
    let attach_tx = edge_attach_tx.clone();
    tokio::spawn(async move {
        let routed_session_id = request.lane.routing_id(&request.session_id);
        let result = edge_tunnel::EdgeTunnel::connect_with_backoff(
            &request.config.url,
            &routed_session_id,
            request.lane,
            &request.probe_group,
            &request.config.admission,
            // One UI-budgeted foreground attempt. Established-lane close and
            // network/session lifecycle edges own subsequent redials; a blind
            // three-attempt loop used to hide failure for ~30 seconds.
            1,
        )
        .await
        .map(Arc::new);
        let attach = EdgeAttach {
            peer_id: request.peer_id,
            session_id: request.session_id,
            generation: request.generation,
            result,
            lane: request.lane,
        };
        if let Err(error) = attach_tx.send(attach).await
            && let Ok(tunnel) = error.0.result
        {
            tunnel.close();
        }
    });
}

struct EdgeLaneCloseAction {
    redial: Option<EdgeDialRequest>,
    park_peer: bool,
    retired_unresumable: Option<RetiredEdgeDial>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct AlternateTransportOwnership {
    direct_webtransport: bool,
}

async fn current_alternate_transport_ownership(
    peer_id: &str,
    wt_state: &Option<Arc<RwLock<WebTransportState>>>,
) -> AlternateTransportOwnership {
    let direct_webtransport = match wt_state {
        Some(state) => state.read().await.peer_connections.contains_key(peer_id),
        None => false,
    };
    AlternateTransportOwnership {
        direct_webtransport,
    }
}

fn should_park_after_edge_detach(
    action: &EdgeLaneCloseAction,
    alternate: AlternateTransportOwnership,
) -> bool {
    action.park_peer && !alternate.direct_webtransport
}

impl EdgeLaneCloseAction {
    fn none() -> Self {
        Self {
            redial: None,
            park_peer: false,
            retired_unresumable: None,
        }
    }

    #[cfg(test)]
    fn is_none(&self) -> bool {
        self.redial.is_none() && self.retired_unresumable.is_none()
    }

    #[cfg(test)]
    fn expect(self, message: &str) -> EdgeDialRequest {
        self.redial.expect(message)
    }
}

async fn handle_edge_lane_closed(
    closed: EdgeLaneClosed,
    edge_dials: &mut HashMap<String, EdgeDialState>,
    next_generation: &mut EdgeLaneGeneration,
    peers: &mut PeerMap,
    network_state: &Arc<RwLock<NetworkState>>,
    redial_enabled: bool,
    now_ms: f64,
) -> EdgeLaneCloseAction {
    // Reject stale generations before touching shared transport ownership.
    if !edge_lane_is_current(edge_dials, &closed) {
        return EdgeLaneCloseAction::none();
    }

    if closed.lane != EdgeLane::Signaling
        && closed.close_reason == edge_tunnel::EdgeTunnelCloseReason::EgressBudget
    {
        if let Some(signaling) = network_state
            .read()
            .await
            .edge_signaling
            .get(&closed.peer_id)
        {
            signaling.note_relay_data_paused();
        }
        apply_relay_data_paused(
            edge_dials,
            peers,
            network_state,
            &closed.peer_id,
            true,
            next_generation,
        )
        .await;
        return EdgeLaneCloseAction::none();
    }

    let owned_current = network::remove_edge_lane_if_current(
        network_state,
        &closed.peer_id,
        closed.lane,
        &closed.tunnel,
    )
    .await;
    if !owned_current {
        // Intentional peer teardown removes the registry entry before closing
        // the tunnel. Retire the lane so a future explicit session_start can
        // dial it, but suppress autonomous resurrection of that torn-down peer.
        return EdgeLaneCloseAction {
            redial: retire_or_restart_edge_lane(edge_dials, &closed, next_generation, false),
            park_peer: false,
            retired_unresumable: None,
        };
    }

    if closed.lane == EdgeLane::Signaling {
        if let Some(peer) = peers.get_mut(closed.peer_id.as_str()) {
            peer.data_rendezvous_pending = false;
        }
        return EdgeLaneCloseAction {
            redial: retire_or_restart_edge_lane(
                edge_dials,
                &closed,
                next_generation,
                redial_enabled,
            ),
            park_peer: false,
            retired_unresumable: None,
        };
    }
    let resumable_interactive_owner = closed.lane == EdgeLane::Interactive
        && peers
            .get(closed.peer_id.as_str())
            .is_some_and(|peer| peer.authenticated && peer.display_cache.initialized);
    let mut owned_peer_lane = false;
    if let Some(peer) = peers.get_mut(closed.peer_id.as_str()) {
        if closed.lane == EdgeLane::Bulk {
            let matches = peer
                .edge_tunnel_bulk
                .as_ref()
                .is_some_and(|current| Arc::ptr_eq(current, &closed.tunnel));
            if matches {
                peer.edge_tunnel_bulk.take();
                peer.bulk_delivery_confirmed = false;
                owned_peer_lane = true;
            }
        } else {
            let matches = peer
                .edge_tunnel
                .as_ref()
                .is_some_and(|current| Arc::ptr_eq(current, &closed.tunnel));
            if matches {
                peer.edge_tunnel.take();
                peer.paths.edge.available = false;
                peer.paths.edge.consecutive_send_failures = 0;
                peer.retire_display_attempts(PeerTransport::Edge);
                owned_peer_lane = true;
                // Losing OUR OWN tunnel is a carrier gap, not the end of the
                // session — the browser is still out there and the redial below
                // re-attaches under the same routing label. Arm the gap window
                // here so the liveness sweep's park guard can see it.
                //
                // Without this the peer is unreachable to that guard by
                // construction: the window is only ever armed from the edge's
                // `CounterpartDetached`, which needs a tunnel we just took, and
                // `reconcile_rebind_windows` clears it whenever the tunnel is
                // gone. So both paths go unavailable, the blanket all-paths-down
                // check fires on the next tick, and parking destroys the Noise
                // session and the rebind lineage — turning a carrier swap into a
                // full server-mediated re-authentication. That cascade is the
                // reconnect p90.
                if resumable_interactive_owner && peer.edge_rebind.is_none() {
                    let window_ms = crate::session::policy::SessionPolicy::carrier_gap_window_ms();
                    peer.edge_rebind = Some(crate::connection::EdgeRebindWindow {
                        deadline_ms: now_ms + window_ms,
                        rebinds_used: peer.rebind.as_ref().map_or(0, |state| state.counter),
                    });
                }
            }
        }
    }

    let counterpart_detached =
        closed.close_reason == edge_tunnel::EdgeTunnelCloseReason::CounterpartDetached;
    let retire_unresumable = closed.lane == EdgeLane::Interactive
        && counterpart_detached
        && !resumable_interactive_owner;
    if retire_unresumable {
        return EdgeLaneCloseAction {
            redial: None,
            park_peer: true,
            retired_unresumable: edge_dials
                .remove(&closed.peer_id)
                .map(|state| RetiredEdgeDial {
                    peer_id: closed.peer_id,
                    state,
                }),
        };
    }

    EdgeLaneCloseAction {
        redial: retire_or_restart_edge_lane(edge_dials, &closed, next_generation, redial_enabled),
        park_peer: owned_peer_lane && closed.lane == EdgeLane::Interactive && counterpart_detached,
        retired_unresumable: None,
    }
}

fn park_edge_counterpart_detached_peer(
    peer_id: &str,
    peers: &mut PeerMap,
    parked: &mut ParkedPeers,
    event_tx: &EventSink,
    start_instant: Instant,
) {
    if let Some(mut state) = peers.remove(peer_id) {
        // The interactive lane already proved its own close. Leave any bulk
        // carrier owned by the network registry until its independent typed
        // close event arrives, so that lane retains its own generation/redial
        // decision instead of being preemptively demoted here.
        state.edge_tunnel.take();
        state.edge_tunnel_bulk.take();
        park_disconnected_peer(parked, state, now_ms_since(start_instant));
    }
    send_json_event(
        event_tx,
        EVT_PEER_DISCONNECTED,
        &PeerDisconnectedEvt {
            peer_node_id: peer_id.to_string(),
            reason: "edge browser counterpart detached".to_string(),
        },
    );
}

/// Apply a lease's edge admission, then state this process's incarnation to
/// every edge it has not yet: one an earlier process of this daemon held
/// sessions at retires them, so their clients re-issue at once. An edge whose
/// statement fails hears it again with the next lease.
fn apply_edge_admission(admission: &edge_tunnel::EdgeAdmission, cmd: UpdateEdgeAdmissionCmd) {
    let mut edges = Vec::with_capacity(cmd.edges.len());
    for edge in cmd.edges {
        let url = edge.url.trim();
        match edge_tunnel::decode_cert_hashes(&edge.cert_hashes) {
            Some(hashes) if !url.is_empty() => edges.push((url.to_string(), hashes)),
            _ => warn!(url, "refusing a malformed edge in the lease"),
        }
    }
    let pending = admission.update(&cmd.ticket, edges);
    let Some(credential) = admission.current() else {
        return;
    };
    for (url, pins) in pending {
        let admission = admission.clone();
        let credential = credential.clone();
        tokio::spawn(async move {
            let result = edge_tunnel::announce_incarnation(&url, &pins, &credential).await;
            if let Err(error) = &result {
                warn!(url, %error, "edge incarnation announcement failed; retrying with the next lease");
            }
            admission.announced(&url, result.is_ok());
        });
    }
}

/// Handle CMD_START_SESSION: parse `{session_id, browser_node_id}` and spawn the
/// per-session edge dial (bounded backoff) that becomes the PRIMARY browser-facing
/// carrier. Returns immediately — the dial runs detached and hands its tunnel back
/// over `edge_attach_tx`, where the run loop registers it as the signaling lane and
/// wires its inbound receivers (BEFORE auth). `edge_dials` retains the latest
/// rendezvous generation so late results cannot replace a newer session.
fn handle_start_session(
    edge_dials: &mut HashMap<String, EdgeDialState>,
    cancelled_sessions: &mut CancelledSessions,
    next_edge_lane_generation: &mut EdgeLaneGeneration,
    edge_attach_tx: &mpsc::Sender<EdgeAttach>,
    edge_admission: &edge_tunnel::EdgeAdmission,
    event_tx: &EventSink,
    payload: &[u8],
    now_ms: f64,
) -> bool {
    let cmd: StartSessionCmd = match serde_json::from_slice(payload) {
        Ok(c) => c,
        Err(e) => {
            send_json_event(
                event_tx,
                EVT_ERROR,
                &ErrorEvt {
                    message: format!("invalid start_session payload: {e}"),
                },
            );
            reject_command_from_payload(event_tx, payload, "invalid_command");
            return false;
        }
    };
    if !is_valid_command_id(&cmd.command_id) || cmd.session_id.is_empty() {
        warn!("start_session with invalid command_id or empty session_id; ignoring");
        reject_command(event_tx, &cmd.command_id, "invalid_command");
        return false;
    }
    // The daemon stamps `browser_node_id` as the per-session peer identity. It
    // is the Noise prologue label only — never a dial target (the daemon dials
    // the edge by session_id).
    if cmd.browser_node_id.is_empty() {
        warn!("start_session with empty browser_node_id; ignoring");
        reject_command(event_tx, &cmd.command_id, "invalid_command");
        return false;
    }
    let pending_request = match PendingSessionRequest::from_encoded(
        &cmd.user_id,
        &cmd.delegation_id,
        &cmd.session_id,
        &cmd.client_nonce,
        &cmd.encapsulation_key,
    ) {
        Ok(request) => request,
        Err(error) => {
            warn!(%error, "start_session has invalid PQ request binding; ignoring");
            reject_command(event_tx, &cmd.command_id, "invalid_command");
            return false;
        }
    };
    let peer_id = cmd.browser_node_id;
    if cancelled_sessions.contains(&peer_id, &cmd.session_id, now_ms) {
        info!(
            "rejecting terminally cancelled late session_start: peer={} session_id={}",
            peer_id, cmd.session_id
        );
        reject_command(event_tx, &cmd.command_id, "cancelled_session");
        return false;
    }
    if edge_dials.get(&peer_id).is_some_and(|state| {
        state.session_id == cmd.session_id && !state.pending_request.same_offer(&pending_request)
    }) {
        warn!(
            peer = peer_id,
            session_id = cmd.session_id,
            "rejecting reused session id with changed user or PQ binding"
        );
        reject_command(event_tx, &cmd.command_id, "session_binding_mismatch");
        return false;
    }

    let cfg = match edge_tunnel::EdgeConfig::from_hashes(
        &cmd.edge_wt_url,
        &cmd.edge_cert_hashes,
        edge_admission,
    ) {
        Some(config) => config,
        None => {
            warn!(
                "rejecting start_session for session_id={}: malformed URL or certificate hash set",
                cmd.session_id
            );
            send_json_event(
                event_tx,
                EVT_ERROR,
                &ErrorEvt {
                    message: "invalid start_session edge coordinates: malformed URL or certificate hash set"
                        .to_string(),
                },
            );
            reject_command(event_tx, &cmd.command_id, "invalid_edge_coordinates");
            return false;
        }
    };
    let session_id = cmd.session_id;
    if !edge_preauth_capacity_available(edge_dials, &peer_id, &session_id) {
        warn!(
            peer = peer_id,
            session_id,
            cap = EDGE_PREAUTH_LEASE_CAP,
            "rejecting session_start because pre-auth edge capacity is full"
        );
        send_json_event(
            event_tx,
            EVT_ERROR,
            &ErrorEvt {
                message: format!(
                    "edge pre-auth session capacity is full ({EDGE_PREAUTH_LEASE_CAP})"
                ),
            },
        );
        reject_command(event_tx, &cmd.command_id, "backpressure");
        return false;
    }
    let creates_new_owner = edge_dials
        .get(&peer_id)
        .is_none_or(|state| state.session_id != session_id);
    let plan = begin_edge_dial(
        edge_dials,
        &peer_id,
        &session_id,
        &pending_request,
        &cfg,
        next_edge_lane_generation,
    );
    if creates_new_owner {
        let armed = arm_new_edge_preauth_lease(edge_dials, &peer_id, &session_id, now_ms);
        debug_assert!(armed, "begin_edge_dial installed this owner");
    }
    if plan.signaling.is_none() && plan.interactive.is_none() && plan.bulk.is_none() {
        accept_command(event_tx, &cmd.command_id);
        return true;
    }
    let probe_group = edge_dials
        .get(&peer_id)
        .expect("the dial plan was made under this peer's owner")
        .lifecycle
        .probe_group
        .clone();

    // Dispatch signaling first, then both data dials in this same owner turn.
    // Authentication never waits for either data connection to finish dialing.
    if let Some(generation) = plan.signaling {
        spawn_edge_dial(
            EdgeDialRequest {
                peer_id: peer_id.clone(),
                session_id: session_id.clone(),
                config: cfg.clone(),
                generation,
                lane: EdgeLane::Signaling,
                probe_group: probe_group.clone(),
            },
            edge_attach_tx,
        );
    }
    // Interactive data retains its own congestion controller.
    if let Some(generation) = plan.interactive {
        spawn_edge_dial(
            EdgeDialRequest {
                peer_id: peer_id.clone(),
                session_id: session_id.clone(),
                config: cfg.clone(),
                generation,
                lane: EdgeLane::Interactive,
                probe_group: probe_group.clone(),
            },
            edge_attach_tx,
        );
    }

    // BULK lane: a second edge connection under the derived `<session>#bulk` id,
    // dedicated to reliable display frames so a recovery burst can't head-of-line-
    // block the interactive datagram lane. Opportunistic — a bulk-dial failure is
    // logged and the peer keeps working with the interactive tunnel as the reliable
    // fallback; it is NOT on the auth-critical path. Carries the BASE session id in
    // the attach so the authenticated-peer match is identical to the interactive lane.
    if let Some(generation) = plan.bulk {
        spawn_edge_dial(
            EdgeDialRequest {
                peer_id,
                session_id,
                config: cfg,
                generation,
                lane: EdgeLane::Bulk,
                probe_group,
            },
            edge_attach_tx,
        );
    }
    accept_command(event_tx, &cmd.command_id);
    true
}

#[cfg(test)]
#[path = "main_tests/start_session_edge_config_tests.rs"]
mod start_session_edge_config_tests;

#[cfg(test)]
#[path = "main_tests/edge_path_estimate_tests.rs"]
mod edge_path_estimate_tests;

/// Parse the browser's DATA HELLO into the attachment generation we keep
/// beside the linked tunnel. Every hello carries a nonce. ACK payloads
/// arriving in the daemon direction are invalid and never mutate ownership.
fn parse_data_hello_generation(payload: &[u8]) -> Option<DataHandshakeGeneration> {
    match decode_data_handshake_frame(payload) {
        Some((DataHandshakeKind::Hello, nonce)) => Some(nonce),
        _ => None,
    }
}

fn decode_data_attachment_nonce(encoded: &str) -> Option<[u8; DATA_HANDSHAKE_NONCE_BYTES]> {
    let encoded = encoded.as_bytes();
    if encoded.len() != DATA_HANDSHAKE_NONCE_BYTES * 2 {
        return None;
    }
    fn decode_nibble(value: u8) -> Option<u8> {
        match value {
            b'0'..=b'9' => Some(value - b'0'),
            b'a'..=b'f' => Some(value - b'a' + 10),
            b'A'..=b'F' => Some(value - b'A' + 10),
            _ => None,
        }
    }
    let mut nonce = [0u8; DATA_HANDSHAKE_NONCE_BYTES];
    for (byte, encoded_pair) in nonce.iter_mut().zip(encoded.chunks_exact(2)) {
        *byte = (decode_nibble(encoded_pair[0])? << 4) | decode_nibble(encoded_pair[1])?;
    }
    Some(nonce)
}

/// Match the post-Noise signaling claim to the exact data attachment's HELLO.
/// ACK and first display can leave together; this rendezvous adds no serial RTT.
async fn link_data_tunnel(
    network_state: &Arc<RwLock<NetworkState>>,
    peers: &mut PeerMap,
    peer_id: &str,
    lane: EdgeLane,
    now_ms: f64,
) -> bool {
    let index = match lane {
        EdgeLane::Interactive => 0,
        EdgeLane::Bulk => 1,
        EdgeLane::Signaling => return false,
    };
    let Some(peer) = peers.get_mut(peer_id) else {
        return false;
    };
    if !peer.authenticated
        || !peer.is_e2e_ready()
        || peer.noise_handshake.is_some()
        || peer
            .rebind
            .as_ref()
            .is_some_and(|state| state.in_flight.is_some())
    {
        return false;
    }
    let Some(nonce) = peer.data_attachment_nonces[index] else {
        return false;
    };
    let network = network_state.read().await;
    let tunnel = match lane {
        EdgeLane::Interactive => network.edge_interactive.get(peer_id),
        EdgeLane::Bulk => network.edge_bulk.get(peer_id),
        EdgeLane::Signaling => unreachable!(),
    };
    let Some(tunnel) = tunnel else {
        return false;
    };
    if !tunnel.matches_browser_hello(Some(nonce)) {
        // A browser-only replacement can arrive on the durable daemon Arc.
        // Its HELLO must revoke the displaced attachment's eligibility even
        // when it overtakes the claim on the separate signaling connection.
        if lane == EdgeLane::Bulk {
            peer.bulk_delivery_confirmed = false;
        } else if peer
            .edge_tunnel
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, tunnel))
        {
            peer.paths.edge.available = false;
            peer.retire_display_attempts(PeerTransport::Edge);
        }
        return false;
    }
    let ack = encode_data_generation_frame(DataHandshakeKind::Ack, nonce);
    if tunnel
        .send_reliable(CHANNEL_DATA_HELLO, ReliablePayload::Heap(ack))
        .is_err()
    {
        return false;
    }
    if lane == EdgeLane::Bulk {
        if peer
            .edge_tunnel_bulk
            .as_ref()
            .is_none_or(|current| !Arc::ptr_eq(current, tunnel))
        {
            peer.bulk_delivery_confirmed = false;
        }
        peer.edge_tunnel_bulk = Some(Arc::clone(tunnel));
        // Only the browser's receipt of this ACK proves downstream delivery.
        // First display uses interactive in the meantime.
    } else {
        let changed = peer
            .edge_tunnel
            .as_ref()
            .is_none_or(|current| !Arc::ptr_eq(current, tunnel));
        peer.edge_tunnel = Some(Arc::clone(tunnel));
        // A data-only carrier replacement keeps the installed Noise session.
        // Matching both attachments closes the resource-management gap; it
        // neither authorizes a rebind nor changes any cryptographic generation.
        peer.edge_rebind = None;
        peer.data_rendezvous_pending = false;
        peer.paths.edge.available = true;
        if changed {
            peer.retire_display_attempts(PeerTransport::Edge);
            peer.carrier_blocks.replaced(PeerTransport::Edge);
            peer.paths.edge.last_ack_at_ms = now_ms;
        }
    }
    if lane == EdgeLane::Interactive {
        geometry::edge_ready(peer);
        assets::edge_ready(peer);
    }
    true
}

fn confirm_bulk_delivery(
    peer: &mut PeerDisplayState,
    nonce: Option<DataHandshakeGeneration>,
) -> bool {
    if !peer.authenticated
        || !peer.is_e2e_ready()
        || peer.noise_handshake.is_some()
        || peer
            .rebind
            .as_ref()
            .is_some_and(|state| state.in_flight.is_some())
        || nonce.is_none()
        || nonce != peer.data_attachment_nonces[1]
        || !peer
            .edge_tunnel_bulk
            .as_ref()
            .is_some_and(|tunnel| tunnel.matches_browser_hello(nonce))
    {
        return false;
    }
    peer.bulk_delivery_confirmed = true;
    true
}

#[cfg(test)]
#[path = "main_tests/data_handshake_tests.rs"]
mod data_handshake_tests;

async fn handle_configure(
    event_tx: &EventSink,
    payload: &[u8],
    wt_already_running: bool,
) -> Result<
    (
        Option<SessionAuthority>,
        Option<DaemonIdentity>,
        Option<UserAuthorization>,
        bool,
    ),
    identity_seal::SealError,
> {
    let cmd: ConfigureCmd = match serde_json::from_slice(payload) {
        Ok(c) => c,
        Err(_) => {
            send_json_event(
                event_tx,
                EVT_ERROR,
                &ErrorEvt {
                    message: "invalid configure payload".to_string(),
                },
            );
            return Ok((None, None, None, false));
        }
    };

    if cmd.daemon_id.trim().is_empty() {
        send_json_event(
            event_tx,
            EVT_ERROR,
            &ErrorEvt {
                message: "invalid configure payload: daemon_id is empty".to_string(),
            },
        );
        return Ok((None, None, None, false));
    }

    let session_auth = match SessionAuthority::new(&cmd.session_token_verify_key, &cmd.daemon_id) {
        Ok(auth) => auth,
        Err(e) => {
            send_json_event(
                event_tx,
                EVT_ERROR,
                &ErrorEvt {
                    message: format!("invalid configure session authority: {e}"),
                },
            );
            return Ok((None, None, None, false));
        }
    };

    let seal = cmd.daemon_identity_seal.clone();
    let backend = seal.backend;
    let daemon_id = cmd.daemon_id.clone();
    let started = Instant::now();
    let new_daemon_identity =
        match tokio::task::spawn_blocking(move || DaemonIdentity::open(&seal, &daemon_id)).await {
            Ok(Ok(identity)) => identity,
            _ => {
                send_json_event(
                    event_tx,
                    EVT_ERROR,
                    &ErrorEvt {
                        message: "identity_unsealable: re-link this machine".to_string(),
                    },
                );
                return Err(identity_seal::SealError::Hardware);
            }
        };
    info!(
        backend = backend.as_str(),
        duration_ms = started.elapsed().as_millis() as u64,
        "daemon identity opened"
    );

    let user_authorization = match UserAuthorization::new(
        &cmd.user_root_public_key,
        cmd.root_epoch,
        &cmd.server_origin,
        &cmd.daemon_binding,
        &cmd.daemon_id,
        &new_daemon_identity.public_key_hash(),
        &cmd.revoked_delegations,
    ) {
        Ok(authorization) => authorization,
        Err(error) => {
            send_json_event(
                event_tx,
                EVT_ERROR,
                &ErrorEvt {
                    message: format!("invalid configure user authorization: {error}"),
                },
            );
            return Ok((None, None, None, false));
        }
    };

    info!("session authority configured for daemon {}", cmd.daemon_id);

    Ok((
        Some(session_auth),
        Some(new_daemon_identity),
        Some(user_authorization),
        !wt_already_running,
    ))
}

fn send_json_event<T: serde::Serialize>(tx: &EventSink, kind: u8, value: &T) {
    let _ = tx.send_json(kind, value);
}

const MAX_COMMAND_ID_BYTES: usize = 128;

fn is_valid_command_id(command_id: &str) -> bool {
    !command_id.is_empty()
        && command_id.len() <= MAX_COMMAND_ID_BYTES
        && command_id.trim() == command_id
}

fn command_id_from_payload(payload: &[u8]) -> Option<String> {
    let value: serde_json::Value = serde_json::from_slice(payload).ok()?;
    let command_id = value.get("command_id")?.as_str()?;
    is_valid_command_id(command_id).then(|| command_id.to_string())
}

fn accept_command(event_tx: &EventSink, command_id: &str) {
    send_json_event(
        event_tx,
        EVT_COMMAND_ACK,
        &CommandAckEvt::Accepted { command_id },
    );
}

fn reject_command(event_tx: &EventSink, command_id: &str, reason: &'static str) {
    if !is_valid_command_id(command_id) {
        return;
    }
    send_json_event(
        event_tx,
        EVT_COMMAND_ACK,
        &CommandAckEvt::Rejected { command_id, reason },
    );
}

fn reject_command_from_payload(event_tx: &EventSink, payload: &[u8], reason: &'static str) {
    if let Some(command_id) = command_id_from_payload(payload) {
        reject_command(event_tx, &command_id, reason);
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct PerfTimingHotWork {
    peer_message: bool,
    pty_output: bool,
    pty_write_completion: bool,
    display_prepare_completion: bool,
    snapshot_prepare_completion: bool,
    display_flush: bool,
}

impl PerfTimingHotWork {
    #[inline]
    fn any(self) -> bool {
        self.peer_message
            || self.pty_output
            || self.pty_write_completion
            || self.display_prepare_completion
            || self.snapshot_prepare_completion
            || self.display_flush
    }
}

/// A ready profiling batch yields to production work, but only for one bounded
/// browser-frame interval or four owner turns. Without this fence, a continuously
/// readable PTY or display completion source could keep both 256-record queues
/// growing until telemetry itself became incomplete. Offering is synchronous
/// try-admission and remains after the selected production arm, so the forced
/// turn never awaits a transport lock ahead of input/display/ACK work. An offer
/// drains every full batch the lane admits, so the fence bounds latency to the
/// wire, never throughput: four hot turns add a handful of records, and the
/// offer that follows removes all of them.
const PERF_TIMING_MAX_MAINTENANCE_DEFERRAL: Duration = Duration::from_millis(16);
const PERF_TIMING_MAX_MAINTENANCE_HOT_TURNS: u8 = 4;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct PerfTimingMaintenanceGate {
    due_since: Option<Instant>,
    deferred_hot_turns: u8,
}

impl PerfTimingMaintenanceGate {
    #[inline]
    fn is_due(self) -> bool {
        self.due_since.is_some()
    }

    #[inline]
    fn mark_due(&mut self, now: Instant) {
        self.due_since.get_or_insert(now);
    }

    #[inline]
    fn clear(&mut self) {
        *self = Self::default();
    }

    fn should_offer(&mut self, now: Instant, hot_work: PerfTimingHotWork) -> bool {
        let Some(due_since) = self.due_since else {
            return false;
        };
        if !hot_work.any()
            || now.saturating_duration_since(due_since) >= PERF_TIMING_MAX_MAINTENANCE_DEFERRAL
            || self.deferred_hot_turns >= PERF_TIMING_MAX_MAINTENANCE_HOT_TURNS.saturating_sub(1)
        {
            return true;
        }
        self.deferred_hot_turns = self.deferred_hot_turns.saturating_add(1);
        false
    }
}

fn now_ms_since(start: Instant) -> f64 {
    start.elapsed().as_secs_f64() * 1000.0
}

fn positive_interval_ms(start: Instant, end: Instant) -> u32 {
    end.saturating_duration_since(start)
        .as_millis()
        .clamp(1, u128::from(u32::MAX)) as u32
}

/// Load the shell-integration token, or `None` if it cannot be used.
///
/// Everything unusable is treated the same way — absent, unreadable, empty, or
/// containing a byte that could not survive an OSC round trip. The last of
/// those matters most: the token is compared against bytes lifted out of an OSC
/// payload, so a token containing `;`, a terminator, or a control byte could
/// never match anyway and would fail in a way that looks like a bug rather than
/// like a malformed file.
fn read_shell_token(path: &str) -> Option<String> {
    let token = std::fs::read_to_string(path)
        .map_err(|error| warn!("shell token at {path} is unreadable: {error}"))
        .ok()?;
    let token = token.trim();
    if token.is_empty() {
        warn!("shell token at {path} is empty; authenticated prompt boundaries are disabled");
        return None;
    }
    if !token
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        warn!(
            "shell token at {path} contains bytes that cannot survive an OSC payload; \
             authenticated prompt boundaries are disabled"
        );
        return None;
    }
    Some(token.to_string())
}

fn parse_args<I>(args: I) -> Result<Args, Box<dyn std::error::Error>>
where
    I: Iterator<Item = String>,
{
    let mut shell = None;
    let mut cols = DEFAULT_COLUMNS;
    let mut rows = DEFAULT_ROWS;
    let mut wt_port = 0u16;
    let mut shell_token_path = None;
    let mut open_url_bin_dir = None;
    let mut public_wt_endpoint = None;
    let mut tokens = args;

    while let Some(key) = tokens.next() {
        match key.as_str() {
            "--shell" => {
                shell = Some(tokens.next().ok_or("missing value for --shell")?);
            }
            "--cols" => {
                let value = tokens.next().ok_or("missing value for --cols")?;
                cols = value.parse::<u16>().map_err(|_| "invalid --cols")?;
            }
            "--rows" => {
                let value = tokens.next().ok_or("missing value for --rows")?;
                rows = value.parse::<u16>().map_err(|_| "invalid --rows")?;
            }
            "--wt-port" => {
                let value = tokens.next().ok_or("missing value for --wt-port")?;
                wt_port = value.parse::<u16>().map_err(|_| "invalid --wt-port")?;
                // A privileged port would need capabilities the daemon does not
                // have, and 0 already means "ephemeral" — accepting either
                // silently would produce a server on a port nothing forwards.
                if wt_port != 0 && wt_port < 1024 {
                    return Err("--wt-port must be 0 or >= 1024".into());
                }
            }
            "--shell-token-path" => {
                shell_token_path = Some(
                    tokens
                        .next()
                        .ok_or("missing value for --shell-token-path")?,
                );
            }
            "--open-url-bin-dir" => {
                open_url_bin_dir = Some(
                    tokens
                        .next()
                        .ok_or("missing value for --open-url-bin-dir")?,
                );
            }
            "--public-wt-endpoint" => {
                let value = tokens
                    .next()
                    .ok_or("missing value for --public-wt-endpoint")?;
                // Rejected rather than ignored. A malformed value here means an
                // operator or box host believes this daemon is published somewhere
                // it is not, and starting anyway would offer browsers a
                // candidate that can never answer — which costs each one its
                // whole race deadline while looking exactly like a candidate
                // that can.
                public_wt_endpoint = Some(
                    value
                        .parse::<std::net::SocketAddr>()
                        .map_err(|_| "invalid --public-wt-endpoint (want host:port)")?,
                );
            }
            "--help" | "-h" => {
                eprintln!(
                    "usage: merkur-dataplane --shell <path> [--cols <u16>] [--rows <u16>] [--wt-port <u16>] [--shell-token-path <path>] [--open-url-bin-dir <path>] [--public-wt-endpoint <host:port>]"
                );
                std::process::exit(0);
            }
            unknown => {
                return Err(format!("unknown argument: {unknown}").into());
            }
        }
    }

    let shell = shell.ok_or("missing required --shell")?;
    if shell.is_empty() {
        return Err("--shell must not be empty".into());
    }

    Ok(Args {
        shell,
        shell_token_path,
        open_url_bin_dir,
        cols,
        rows,
        pinned_wt_port: wt_port,
        public_wt_endpoint,
    })
}

#[cfg(test)]
#[path = "main_tests/args_tests.rs"]
mod args_tests;

#[cfg(test)]
#[path = "main_tests/ingress_allocation_oracle.rs"]
mod ingress_allocation_oracle;

#[cfg(test)]
#[path = "main_tests/bounded_ingress_tests.rs"]
mod bounded_ingress_tests;

#[cfg(test)]
#[path = "main_tests/e2e_dispatch_tests.rs"]
mod e2e_dispatch_tests;

#[cfg(test)]
#[path = "main_tests/signaling_ingress_tests.rs"]
mod signaling_ingress_tests;
