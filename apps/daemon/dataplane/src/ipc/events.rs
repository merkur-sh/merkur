use crossbeam_channel::{Receiver, Sender, TrySendError};
use serde::Serialize;
use std::io::{self, BufWriter, Write};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::Arc;
#[cfg(test)]
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU8, AtomicUsize, Ordering};
use std::thread::JoinHandle;
use std::time::Duration;
use tokio::sync::{mpsc, oneshot};

use super::write_frame;

pub const EVT_PTY_READY: u8 = 0x82;
pub const EVT_PTY_CLOSED: u8 = 0x83;
pub const EVT_BELL: u8 = 0x85;
pub const EVT_PEER_DISCONNECTED: u8 = 0x88;
pub const EVT_ERROR: u8 = 0x8A;
pub const EVT_WEBTRANSPORT_READY: u8 = 0x8D;
pub const EVT_PEER_AUTHENTICATED: u8 = 0x8E;
pub const EVT_COMMAND_ACK: u8 = 0x8F;
/// One coalesced OS network-path transition. Keeps the network/topology band
/// contiguous with `EVT_WEBTRANSPORT_READY`.
pub const EVT_NETWORK_PATH_CHANGED: u8 = 0x8C;
/// Periodic transport/display statistics. Deliberately outside the 0x82..=0x8F
/// lifecycle band: this is the first observational event kind, and unlike every
/// other event it is droppable — see [`EventSink::send_diagnostic_json`].
pub const EVT_TRANSPORT_STATS: u8 = 0x90;
/// One completed port-mapping cycle: acquired, renewed, refused, or never
/// attempted. Emitted per cycle rather than sampled, because it is an event
/// with an outcome and not a rate.
pub const EVT_NAT_MAPPING_OUTCOME: u8 = 0x91;
/// One carrier-rebind attempt outcome: admitted, committed, refused with its
/// reason, or ended without either. Per attempt rather than sampled, for the
/// same reason as the mapping outcome above — a rebind has an outcome, not a
/// rate, and the reason is the whole diagnostic value.
///
/// Droppable, and additionally RATE-BOUNDED at the emitter: `UnknownPeer` is
/// drivable by anyone holding the rendezvous id, so an unbounded emit here
/// would let an unauthenticated caller flood the event channel this process
/// depends on. See `session::rebind_flow::RebindEventBudget`.
pub const EVT_SESSION_REBIND: u8 = 0x92;
/// Explicit cold native trace capture chunk. Diagnostic and droppable.
pub const EVT_PERF_TRACE: u8 = 0x93;
pub const EVT_DAEMON_PROOF: u8 = 0x94;

#[derive(Serialize)]
pub struct DaemonProofEvt<'a> {
    pub command_id: &'a str,
    pub signature: String,
    pub p256_signature: String,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum CommandAckEvt<'a> {
    Accepted {
        command_id: &'a str,
    },
    Rejected {
        command_id: &'a str,
        reason: &'a str,
    },
}

/// Entry and byte admission are intentionally independent. A tiny lifecycle
/// burst gets enough entry headroom to avoid a false fatal overload, while the
/// atomic payload budget preserves the original hard 16 MiB queue-memory cap.
/// The writer thread can own one additional 512 KiB payload while writing it.
pub const EVENT_QUEUE_DEPTH: usize = 1_024;
pub const MAX_EVENT_PAYLOAD_BYTES: usize = super::MAX_PAYLOAD_BYTES;
pub const MAX_EVENT_QUEUE_PAYLOAD_BYTES: usize = 16 * 1024 * 1024;

const PHASE_OPEN: u8 = 0;
const PHASE_FAILED: u8 = 1;
const PHASE_CLOSED: u8 = 2;
const WRITER_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(1);

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EventSinkFailure {
    QueueFull,
    QueuePayloadFull {
        queued: usize,
        attempted: usize,
        maximum: usize,
    },
    QueueClosed,
    PayloadTooLarge {
        actual: usize,
        maximum: usize,
    },
    Serialization(String),
    WriterIo(String),
    WriterPanicked,
    WriterStopped,
    ShutdownTimeout,
    Unavailable,
}

impl std::fmt::Display for EventSinkFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::QueueFull => formatter.write_str("stdout event queue is full"),
            Self::QueuePayloadFull {
                queued,
                attempted,
                maximum,
            } => write!(
                formatter,
                "stdout event payload budget is full ({queued} bytes queued, \
                 {attempted} bytes attempted, {maximum} bytes maximum)"
            ),
            Self::QueueClosed => formatter.write_str("stdout event queue is closed"),
            Self::PayloadTooLarge { actual, maximum } => write!(
                formatter,
                "stdout event payload is too large ({actual} bytes, maximum {maximum})"
            ),
            Self::Serialization(error) => write!(formatter, "event serialization failed: {error}"),
            Self::WriterIo(error) => write!(formatter, "stdout event writer failed: {error}"),
            Self::WriterPanicked => formatter.write_str("stdout event writer panicked"),
            Self::WriterStopped => formatter.write_str("stdout event writer stopped unexpectedly"),
            Self::ShutdownTimeout => formatter.write_str("stdout event writer shutdown timed out"),
            Self::Unavailable => formatter.write_str("stdout event sink is unavailable"),
        }
    }
}

impl std::error::Error for EventSinkFailure {}

struct EventFrame {
    kind: u8,
    payload: Vec<u8>,
}

struct EventSinkState {
    phase: AtomicU8,
    admissions: AtomicUsize,
    queued_payload_bytes: AtomicUsize,
    max_queued_payload_bytes: usize,
    failure_reported: AtomicBool,
    failure_tx: mpsc::Sender<EventSinkFailure>,
    writer_wake_tx: Sender<()>,
    /// Wakes the network simulator's reader, which stands in for the writer
    /// thread (`crate::sim`): on every admitted frame and every state change.
    #[cfg(merkur_sim)]
    arrived: tokio::sync::Notify,
}

impl EventSinkState {
    fn begin_admission(&self) -> bool {
        if self.phase.load(Ordering::Acquire) != PHASE_OPEN {
            return false;
        }
        self.admissions.fetch_add(1, Ordering::AcqRel);
        if self.phase.load(Ordering::Acquire) == PHASE_OPEN {
            true
        } else {
            self.end_admission();
            false
        }
    }

    fn end_admission(&self) {
        let previous = self.admissions.fetch_sub(1, Ordering::AcqRel);
        debug_assert!(previous > 0, "stdout event admission accounting underflow");
        if previous == 1 && self.phase.load(Ordering::Acquire) != PHASE_OPEN {
            self.wake_writer();
        }
    }

    fn try_reserve_payload(&self, byte_len: usize) -> Result<(), usize> {
        let mut queued = self.queued_payload_bytes.load(Ordering::Acquire);
        loop {
            let Some(next) = queued.checked_add(byte_len) else {
                return Err(queued);
            };
            if next > self.max_queued_payload_bytes {
                return Err(queued);
            }
            match self.queued_payload_bytes.compare_exchange_weak(
                queued,
                next,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => return Ok(()),
                Err(observed) => queued = observed,
            }
        }
    }

    fn release_payload(&self, byte_len: usize) {
        let previous = self
            .queued_payload_bytes
            .fetch_sub(byte_len, Ordering::AcqRel);
        debug_assert!(previous >= byte_len, "stdout payload accounting underflow");
    }

    fn fail(&self, failure: EventSinkFailure) {
        self.phase.store(PHASE_FAILED, Ordering::Release);
        self.wake_writer();
        if !self.failure_reported.swap(true, Ordering::AcqRel) {
            // Capacity one plus the atomic latch guarantees a single bounded
            // notification. Failure reporting itself must never block.
            let _ = self.failure_tx.try_send(failure);
        }
    }

    fn close(&self) {
        let _ = self.phase.compare_exchange(
            PHASE_OPEN,
            PHASE_CLOSED,
            Ordering::AcqRel,
            Ordering::Acquire,
        );
        self.wake_writer();
    }

    fn wake_writer(&self) {
        // Capacity one coalesces concurrent close/failure/admission-complete
        // notifications. The writer always re-checks the complete state.
        let _ = self.writer_wake_tx.try_send(());
        #[cfg(merkur_sim)]
        self.arrived.notify_one();
    }

    fn should_drain_and_stop(&self, receiver: &Receiver<EventFrame>) -> bool {
        self.phase.load(Ordering::Acquire) != PHASE_OPEN
            && self.admissions.load(Ordering::Acquire) == 0
            && receiver.is_empty()
    }
}

/// Cloneable, nonblocking producer for the dedicated stdout writer.
///
/// # Two delivery contracts, one implementation
///
/// [`EventSink::admit`] holds the only copy of the bounds checks. Two public
/// entry points wrap it with different failure contracts:
///
/// - **Lifecycle frames must be delivered.** `send_raw` and `send_json`
///   performs one bounded `try_send`; queue saturation or writer loss
///   atomically poisons the sink and notifies the owner loop, which shuts the
///   dataplane down instead of dropping a state transition or growing memory.
///   Losing a `EVT_PEER_DISCONNECTED` would desynchronise the daemon's model of
///   the world, so the process dies instead.
///
/// - **Diagnostic frames may be dropped.** `send_diagnostic_json` runs the same
///   bounds and drops on failure, leaving the sink open. This exists because a
///   periodic diagnostic has a fundamentally different risk profile from a
///   lifecycle event: lifecycle frames are bursty and rare, so they only
///   *might* land in a transient stdout stall, whereas a fixed-cadence frame is
///   *certain* to eventually land in one. A monitoring frame must never be able
///   to shut down the process it monitors.
///
/// This is not a fallback path or dual behaviour for one operation — it is two
/// operations with two documented contracts over a single shared bounds check.
#[derive(Clone)]
pub struct EventSink {
    sender: Sender<EventFrame>,
    state: Arc<EventSinkState>,
}

impl EventSink {
    /// Bounds-check and enqueue one frame. Never poisons the sink; the caller
    /// decides what a failure means.
    fn admit(&self, kind: u8, payload: Vec<u8>) -> Result<(), EventSinkFailure> {
        if payload.len() > MAX_EVENT_PAYLOAD_BYTES {
            return Err(EventSinkFailure::PayloadTooLarge {
                actual: payload.len(),
                maximum: MAX_EVENT_PAYLOAD_BYTES,
            });
        }
        if !self.state.begin_admission() {
            return Err(EventSinkFailure::Unavailable);
        }
        let payload_len = payload.len();
        if let Err(queued) = self.state.try_reserve_payload(payload_len) {
            self.state.end_admission();
            return Err(EventSinkFailure::QueuePayloadFull {
                queued,
                attempted: payload_len,
                maximum: self.state.max_queued_payload_bytes,
            });
        }
        let result = self.sender.try_send(EventFrame { kind, payload });
        self.state.end_admission();
        match result {
            Ok(()) => {
                #[cfg(merkur_sim)]
                self.state.arrived.notify_one();
                Ok(())
            }
            Err(TrySendError::Full(frame)) => {
                self.state.release_payload(frame.payload.len());
                Err(EventSinkFailure::QueueFull)
            }
            Err(TrySendError::Disconnected(frame)) => {
                self.state.release_payload(frame.payload.len());
                Err(EventSinkFailure::QueueClosed)
            }
        }
    }

    pub fn send_raw(&self, kind: u8, payload: Vec<u8>) -> Result<(), EventSinkFailure> {
        self.admit(kind, payload).inspect_err(|failure| {
            // `Unavailable` means the sink is already failed or closed; re-failing
            // it would overwrite the original cause with a downstream symptom.
            if !matches!(failure, EventSinkFailure::Unavailable) {
                self.state.fail(failure.clone());
            }
        })
    }

    pub fn send_json<T: Serialize>(&self, kind: u8, value: &T) -> Result<(), EventSinkFailure> {
        let payload = serde_json::to_vec(value).map_err(|error| {
            let failure = EventSinkFailure::Serialization(error.to_string());
            self.state.fail(failure.clone());
            failure
        })?;
        self.send_raw(kind, payload)
    }

    /// Best-effort delivery for observational frames. Returns the failure so the
    /// caller can count the drop, but leaves the sink open and the process alive.
    ///
    /// Serialization failure is *not* treated as droppable here — that is a bug
    /// in the payload type, not backpressure, and it should surface loudly. The
    /// stats payload is integers only precisely so this branch is unreachable.
    pub fn send_diagnostic_json<T: Serialize>(
        &self,
        kind: u8,
        value: &T,
    ) -> Result<(), EventSinkFailure> {
        let payload = serde_json::to_vec(value).map_err(|error| {
            let failure = EventSinkFailure::Serialization(error.to_string());
            self.state.fail(failure.clone());
            failure
        })?;
        self.admit(kind, payload)
    }
}

/// Owner for the blocking writer thread. Dropping it closes producer admission;
/// `shutdown` additionally waits a bounded time for all admitted FIFO entries to
/// drain and flush.
pub struct EventOutput {
    state: Arc<EventSinkState>,
    done_rx: Option<oneshot::Receiver<Result<(), EventSinkFailure>>>,
    writer_thread: Option<JoinHandle<()>>,
}

impl EventOutput {
    pub async fn shutdown(&mut self) -> Result<(), EventSinkFailure> {
        self.state.close();
        let Some(mut done_rx) = self.done_rx.take() else {
            return Ok(());
        };
        let result = match tokio::time::timeout(WRITER_SHUTDOWN_TIMEOUT, &mut done_rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(EventSinkFailure::WriterStopped),
            Err(_) => Err(EventSinkFailure::ShutdownTimeout),
        };

        if !matches!(result, Err(EventSinkFailure::ShutdownTimeout))
            && let Some(writer_thread) = self.writer_thread.take()
            && writer_thread.join().is_err()
        {
            return Err(EventSinkFailure::WriterPanicked);
        }
        result
    }
}

impl Drop for EventOutput {
    fn drop(&mut self) {
        self.state.close();
    }
}

pub fn start_stdout_event_output()
-> io::Result<(EventSink, mpsc::Receiver<EventSinkFailure>, EventOutput)> {
    tracing::info!(
        queue_depth = EVENT_QUEUE_DEPTH,
        max_payload_bytes = MAX_EVENT_PAYLOAD_BYTES,
        max_queued_payload_bytes = MAX_EVENT_QUEUE_PAYLOAD_BYTES,
        "starting bounded stdout event sink"
    );
    start_event_output(io::stdout(), EVENT_QUEUE_DEPTH)
}

#[cfg(test)]
pub(crate) fn test_event_sink() -> (EventSink, EventOutput) {
    let (sink, _failure_rx, output) =
        start_event_output(io::sink(), EVENT_QUEUE_DEPTH).expect("spawn test event writer");
    (sink, output)
}

#[cfg(test)]
#[derive(Clone)]
struct CapturingEventWriter {
    bytes: Arc<Mutex<Vec<u8>>>,
}

#[cfg(test)]
impl Write for CapturingEventWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.bytes.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
pub(crate) fn test_capturing_event_sink() -> (EventSink, EventOutput, Arc<Mutex<Vec<u8>>>) {
    let bytes = Arc::new(Mutex::new(Vec::new()));
    let writer = CapturingEventWriter {
        bytes: Arc::clone(&bytes),
    };
    let (sink, _failure_rx, output) =
        start_event_output(writer, EVENT_QUEUE_DEPTH).expect("spawn capturing test event writer");
    (sink, output, bytes)
}

fn start_event_output<W>(
    writer: W,
    queue_depth: usize,
) -> io::Result<(EventSink, mpsc::Receiver<EventSinkFailure>, EventOutput)>
where
    W: Write + Send + 'static,
{
    if queue_depth == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "event queue must have positive capacity",
        ));
    }
    let (sender, receiver) = crossbeam_channel::bounded(queue_depth);
    let (writer_wake_tx, writer_wake_rx) = crossbeam_channel::bounded(1);
    let (failure_tx, failure_rx) = mpsc::channel(1);
    let (done_tx, done_rx) = oneshot::channel();
    let state = Arc::new(EventSinkState {
        phase: AtomicU8::new(PHASE_OPEN),
        admissions: AtomicUsize::new(0),
        queued_payload_bytes: AtomicUsize::new(0),
        max_queued_payload_bytes: MAX_EVENT_QUEUE_PAYLOAD_BYTES,
        failure_reported: AtomicBool::new(false),
        failure_tx,
        writer_wake_tx,
        #[cfg(merkur_sim)]
        arrived: tokio::sync::Notify::new(),
    });

    let writer_state = Arc::clone(&state);
    let writer_thread = std::thread::Builder::new()
        .name("merkur-event-writer".to_string())
        .spawn(move || {
            let result = match catch_unwind(AssertUnwindSafe(|| {
                run_event_writer(writer, receiver, writer_wake_rx, &writer_state)
            })) {
                Ok(result) => result,
                Err(_) => Err(EventSinkFailure::WriterPanicked),
            };
            if let Err(failure) = &result {
                writer_state.fail(failure.clone());
            }
            let _ = done_tx.send(result);
        })?;

    Ok((
        EventSink {
            sender,
            state: Arc::clone(&state),
        },
        failure_rx,
        EventOutput {
            state,
            done_rx: Some(done_rx),
            writer_thread: Some(writer_thread),
        },
    ))
}

/// The network simulator's end of the sink: the frames a writer thread would
/// write, in admission order, read on the host's runtime (`crate::sim`).
#[cfg(merkur_sim)]
pub(crate) struct SimEvents {
    receiver: Receiver<EventFrame>,
    state: Arc<EventSinkState>,
}

#[cfg(merkur_sim)]
impl SimEvents {
    pub(crate) async fn recv(&mut self) -> Option<(u8, Vec<u8>)> {
        loop {
            match self.receiver.try_recv() {
                Ok(frame) => {
                    self.state.release_payload(frame.payload.len());
                    return Some((frame.kind, frame.payload));
                }
                Err(crossbeam_channel::TryRecvError::Disconnected) => return None,
                Err(crossbeam_channel::TryRecvError::Empty) => {
                    if self.state.should_drain_and_stop(&self.receiver) {
                        return None;
                    }
                    self.state.arrived.notified().await;
                }
            }
        }
    }
}

/// The sink with no writer thread: its frames go to the simulator's reader.
#[cfg(merkur_sim)]
pub(crate) fn start_sim_event_output() -> (
    EventSink,
    mpsc::Receiver<EventSinkFailure>,
    EventOutput,
    SimEvents,
) {
    let (sender, receiver) = crossbeam_channel::bounded(EVENT_QUEUE_DEPTH);
    let (writer_wake_tx, _) = crossbeam_channel::bounded(1);
    let (failure_tx, failure_rx) = mpsc::channel(1);
    let state = Arc::new(EventSinkState {
        phase: AtomicU8::new(PHASE_OPEN),
        admissions: AtomicUsize::new(0),
        queued_payload_bytes: AtomicUsize::new(0),
        max_queued_payload_bytes: MAX_EVENT_QUEUE_PAYLOAD_BYTES,
        failure_reported: AtomicBool::new(false),
        failure_tx,
        writer_wake_tx,
        arrived: tokio::sync::Notify::new(),
    });
    (
        EventSink {
            sender,
            state: Arc::clone(&state),
        },
        failure_rx,
        EventOutput {
            state: Arc::clone(&state),
            done_rx: None,
            writer_thread: None,
        },
        SimEvents { receiver, state },
    )
}

#[derive(Serialize)]
pub struct PtyReadyEvt {
    pub pid: u32,
}

#[derive(Serialize)]
pub struct PtyClosedEvt {
    pub exit_code: i32,
    pub signal: i32,
}

#[derive(Serialize)]
pub struct PeerDisconnectedEvt {
    pub peer_node_id: String,
    pub reason: String,
}

#[derive(Serialize)]
pub struct ErrorEvt {
    pub message: String,
}

#[derive(Serialize)]
pub struct WebTransportCandidateEvt {
    pub addr: String,
    pub port: u16,
    pub kind: crate::webtransport::CandidateFlavor,
}

#[derive(Serialize)]
pub struct WebTransportReadyEvt {
    pub port: u16,
    pub cert_hash: String,
    pub candidates: Vec<WebTransportCandidateEvt>,
    /// Whether an unsolicited inbound IPv6 datagram was observed reaching the
    /// pinned port, as `Ipv6Reachability::as_str`.
    ///
    /// Observational only; it never suppresses a `host6` candidate. A reprobe
    /// always reports `unknown`, because the test must bind the pinned port and
    /// quinn has owned it since startup.
    pub ipv6_reachability: &'static str,
}

/// Outcome of one port-mapping cycle.
///
/// `outcome` is `"<who>:<what>"` over a closed set — `pcp:mapped`,
/// `natpmp:renewed`, `gateway:unsupported`, `skipped:no_gateway`, and so on.
/// The reader validates against that set, so a new variant is a coordinated
/// change on both sides rather than an unbounded metric label.
///
/// The `skipped:*` half is the reason this event exists at all. Its predecessor
/// reported three booleans, so "we never addressed a gateway" and "the gateway
/// refused" were the same `false` — and thirty days of that ambiguity was read
/// as a verdict on the protocols.
#[derive(Serialize)]
pub struct NatMappingOutcomeEvt {
    pub outcome: &'static str,
}

/// One carrier-rebind attempt outcome.
///
/// `session_id` is the server-issued rendezvous id, which already crosses this
/// boundary in `PeerAuthenticatedEvt`. It reaches the span and the log and
/// must NEVER reach a metric label: Effect's metric registry has no eviction
/// path, so a per-session label leaks a registry entry for the life of the
/// daemon. Only `outcome` — a closed set, see `RebindRefusal::metric_key` — is
/// safe to aggregate on.
///
/// `attempt_ms` is the proof-to-commit duration on `committed`, and 0 on every
/// other outcome. It is the figure that was missing when a production incident
/// had to be diagnosed from the browser's side.
#[derive(Serialize)]
pub struct SessionRebindEvt {
    pub session_id: String,
    pub outcome: String,
    pub generation: u64,
    pub attempt_ms: u32,
    /// Events this emitter suppressed since the last one it admitted. A gap in
    /// the series is visible rather than silent, the same self-reporting the
    /// stats sample uses for its own drops.
    pub events_suppressed: u64,
}

#[derive(Serialize)]
pub struct NetworkPathChangedEvt {
    /// How many OS events collapsed into this edge. Diagnostic only: the
    /// control client needs the edge, not the address list, and shipping local
    /// topology would put it in daemon logs for no consumer.
    pub coalesced_events: u32,
}

#[derive(Serialize)]
pub struct PeerAuthenticatedEvt {
    pub peer_node_id: String,
    pub browser_node_id: String,
    pub session_id: String,
}

/// Per-transport aggregate for one reporting interval.
///
/// Every field is an unsigned integer. No `f64` appears anywhere in the stats
/// payload because `serde_json` writes `null` for `NaN`/`Infinity`, a `null`
/// fails the TypeScript validator, and `dataplane-client.ts` treats an invalid
/// event payload as a fatal protocol error. An EWMA that briefly goes non-finite
/// must never be able to kill the dataplane, so all of them are clamped to
/// integer microseconds on the way in.
#[derive(Debug, Default, Serialize)]
pub struct PathStatsEvt {
    /// Peers whose path for this transport is marked available.
    pub paths_available: u32,
    /// Peers whose path for this transport is still within the staleness bound.
    pub paths_live: u32,
    /// Worst round-trip EWMA across peers, in microseconds. This one folds in
    /// display-ACK round trips, so it includes browser frame-apply time.
    pub rtt_ewma_us_max: u32,
    /// Worst heartbeat-only round-trip EWMA, in microseconds. The divergence
    /// between this and `rtt_ewma_us_max` is the browser's apply/render cost.
    pub network_rtt_ewma_us_max: u32,
    /// Worst jitter EWMA across peers, in microseconds.
    pub jitter_ewma_us_max: u32,
    /// Worst consecutive send-failure streak across peers.
    pub send_failures_max: u32,
    /// Oldest time since an authenticated inbound frame, in milliseconds.
    pub last_ack_age_ms_max: u32,
    /// Successfully admitted, sole-path display datagrams the browser applied
    /// without FEC reconstruction during the interval.
    pub display_datagrams_received: u64,
    /// Successfully admitted, sole-path display datagrams the browser applied
    /// after FEC reconstruction during the interval.
    pub display_datagrams_recovered_by_fec: u64,
    /// Successfully admitted, sole-path display datagrams a selective ACK
    /// classified Lost during the interval.
    pub display_datagrams_declared_lost: u64,
    /// Eligible display datagrams whose bounded outcome provenance expired or
    /// was pruned before classification during the interval.
    pub display_datagrams_outcome_unknown: u64,
    /// QUIC packets sent on this transport during the interval.
    pub quic_sent_packets: u64,
    /// QUIC packets declared lost during the interval. This is transport-layer
    /// evidence and is distinct from the application-level selective-ACK
    /// display outcomes above.
    pub quic_lost_packets: u64,
    /// QUIC bytes declared lost during the interval.
    pub quic_lost_bytes: u64,
    /// Congestion events during the interval, distinguishing congestion-driven
    /// loss from random loss.
    pub quic_congestion_events: u64,
    /// Black holes detected during the interval.
    pub quic_black_holes: u64,
    /// DATAGRAM frames put on the wire during the interval.
    pub quic_datagrams_tx: u64,
    /// DATAGRAM frames received during the interval.
    pub quic_datagrams_rx: u64,
    /// UDP payload bytes sent during the interval, including retransmits.
    pub quic_udp_tx_bytes: u64,
    /// UDP payload bytes received during the interval.
    pub quic_udp_rx_bytes: u64,
    /// Smallest current path MTU across peers, in bytes.
    pub quic_mtu_min: u32,
    /// Smallest current congestion window across peers, in bytes.
    pub quic_cwnd_bytes_min: u64,
    /// Largest current QUIC path RTT across peers, in microseconds.
    pub quic_rtt_us_max: u32,
}

/// One periodic transport/display statistics sample.
///
/// The shape is fixed and the size is independent of peer count: per-transport
/// values are aggregated with `max` or `sum` rather than emitted per peer. That
/// removes the multi-peer growth problem by construction — there is no array to
/// bound or truncate — and keeps peer identity off the wire entirely, so nothing
/// downstream can turn it into an unbounded metric label.
#[derive(Debug, Default, Serialize)]
pub struct TransportStatsEvt {
    /// Milliseconds covered by this sample's interval deltas.
    pub window_ms: u32,
    /// Peers attached at sample time.
    pub peers: u32,
    /// Peers parked for resume at sample time.
    pub parked_peers: u32,
    pub webtransport: PathStatsEvt,
    pub edge: PathStatsEvt,

    // ── Display quality (interval deltas) ──────────────────────────────────
    /// Row versions put on the wire. The denominator for everything below.
    pub row_versions_sent: u64,
    /// Row versions replaced before the browser reported applying them. This is
    /// the "sent and never seen" number — bandwidth that bought nothing.
    pub row_versions_superseded_unapplied: u64,
    /// Row versions replaced after the browser applied them. Not waste.
    pub row_versions_superseded_applied: u64,
    /// Re-sends of byte-identical content, paced by the resend deadline.
    pub row_resends_identical: u64,
    /// Frames known-stale at their own send.
    pub stale_prepared_flushes_sent: u64,
    /// Paced bursts abandoned before their tail reached a transport.
    pub bursts_abandoned: u64,
    /// Superseded bursts kept because the sequence rewind was not provable.
    pub bursts_unsafe_to_rewind: u64,
    /// Datagram sends that the transport refused.
    pub datagram_send_failures: u64,
    /// FEC repair frames the transport accepted.
    pub fec_repairs_sent: u64,
    /// FEC repair frames the transport refused, leaving that group unprotected.
    pub fec_repairs_refused: u64,
    /// Rows the browser asked to be resynchronised.
    pub resync_rows_requested: u64,
    /// Rows disowned because their carrying datagram was declared lost.
    pub rows_declared_lost: u64,

    // ── Flow and backpressure (instantaneous maxima) ───────────────────────
    /// Largest unacknowledged sent-datagram backlog across peers.
    pub unacked_datagrams_max: u32,
    /// Largest reliable-lane queue depth on the edge tunnel, in bytes.
    pub edge_reliable_queued_bytes_max: u32,

    // ── Process-global drop counters (cumulative since process start) ──────
    /// Inbound datagrams dropped at the direct WebTransport ingress queue.
    pub inbound_datagram_drops_wt: u64,
    /// Inbound datagrams the edge tunnels dropped at the owner's ingress queue.
    pub inbound_datagram_drops_edge: u64,
    /// Direct WebTransport sessions rejected over capacity.
    pub over_capacity_session_rejections: u64,
    /// Inbound connections that reached the direct-WebTransport listener, split
    /// by whether an offer recently named the source address, and how many
    /// completed the authenticated upgrade. Cumulative since process start, like
    /// the counters above.
    ///
    /// The split is what makes the filtering question answerable at all: a
    /// public UDP port is scanned continuously, and an undifferentiated arrival
    /// count is dominated by that noise rather than by browsers.
    pub direct_wt_incoming_expected: u64,
    pub direct_wt_incoming_unexpected: u64,
    pub direct_wt_admitted: u64,
    /// NAT side-channel activity since process start: keepalives that hold the
    /// reflexive mapping open, punch bursts that open filter state toward a
    /// browser, and the refusals that mean neither happened.
    pub nat_keepalives_sent: u64,
    pub nat_punch_bursts_sent: u64,
    pub nat_punch_refused_not_global: u64,
    pub nat_punch_refused_rate_limited: u64,
    pub nat_side_channel_send_failed: u64,
    pub nat_side_channel_would_block: u64,
    /// Stats frames this emitter failed to enqueue and dropped. Self-reported so
    /// a gap in the series is visible rather than silent.
    pub stats_events_dropped: u64,
    /// Carrier-rebind tallies since process start.
    ///
    /// `EVT_SESSION_REBIND` carries the diagnosis — which reason, which
    /// session, how long from proof to commit — but it is rate-bounded, so a
    /// flood erases exactly the evidence that a flood happened. These five
    /// carry the rate and survive that. `requests` is the denominator:
    /// `accepted + refused` sums to it, and `requests - accepted - refused`
    /// is the number that reached no outcome at all.
    pub rebind_requests: u64,
    pub rebind_accepted: u64,
    pub rebind_committed: u64,
    pub rebind_refused: u64,
    /// Rebind frames the signaling envelope validator rejected before any
    /// handler saw them — the one refusal path upstream of the flow itself.
    pub rebind_envelopes_rejected: u64,
    /// Outcome events the emitter's rate bound suppressed. Self-reported for
    /// the same reason as `stats_events_dropped` above.
    pub rebind_events_suppressed: u64,
}

struct EventWriter<W: Write> {
    writer: BufWriter<W>,
}

impl<W: Write> EventWriter<W> {
    fn new(writer: W) -> Self {
        Self {
            writer: BufWriter::with_capacity(64 * 1024, writer),
        }
    }

    fn write_event(&mut self, kind: u8, payload: &[u8]) -> io::Result<()> {
        write_frame(&mut self.writer, kind, payload)?;
        if should_flush(kind) {
            self.writer.flush()?;
        }
        Ok(())
    }

    fn flush(&mut self) -> io::Result<()> {
        self.writer.flush()
    }
}

fn run_event_writer<W: Write>(
    writer: W,
    receiver: Receiver<EventFrame>,
    writer_wake_rx: Receiver<()>,
    state: &EventSinkState,
) -> Result<(), EventSinkFailure> {
    let mut writer = EventWriter::new(writer);
    loop {
        if state.should_drain_and_stop(&receiver) {
            break;
        }
        crossbeam_channel::select! {
            recv(receiver) -> result => match result {
                Ok(frame) => {
                // The queue budget excludes the single frame currently owned by
                // the writer, matching the documented +512 KiB allowance.
                    state.release_payload(frame.payload.len());
                    writer
                        .write_event(frame.kind, &frame.payload)
                        .map_err(|error| EventSinkFailure::WriterIo(error.to_string()))?;
                }
                Err(_) => {
                    if state.phase.load(Ordering::Acquire) == PHASE_OPEN {
                        return Err(EventSinkFailure::QueueClosed);
                    }
                    break;
                }
            },
            recv(writer_wake_rx) -> _ => {}
        }
    }
    writer
        .flush()
        .map_err(|error| EventSinkFailure::WriterIo(error.to_string()))
}

fn should_flush(kind: u8) -> bool {
    kind == EVT_PTY_READY
        || kind == EVT_PTY_CLOSED
        || kind == EVT_BELL
        || kind == EVT_ERROR
        || kind == EVT_PEER_DISCONNECTED
        || kind == EVT_PEER_AUTHENTICATED
        || kind == EVT_WEBTRANSPORT_READY
        || kind == EVT_COMMAND_ACK
        // Omitting a kind here leaves it sitting in the 64 KiB BufWriter until
        // some unrelated event happens to flush it, which surfaces as a
        // latency-dependent, near-unreproducible delay.
        || kind == EVT_NETWORK_PATH_CHANGED
        // At roughly 1 KiB per frame and one frame per 10 s, up to ~64 stats
        // frames (over ten minutes of telemetry) would otherwise sit unflushed
        // on an idle-but-attached daemon.
        || kind == EVT_TRANSPORT_STATS
        // A rebind outcome is the diagnostic for a path that only runs during a
        // reconnect, so an unflushed one sits in the BufWriter until the next
        // unrelated event — which on a recovering-but-idle daemon can be long
        // after the window it explains has closed.
        || kind == EVT_SESSION_REBIND
        || kind == EVT_DAEMON_PROOF
        || kind == EVT_PERF_TRACE
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Mutex;

    fn sink_without_writer(
        depth: usize,
        max_queued_payload_bytes: usize,
    ) -> (
        EventSink,
        Receiver<EventFrame>,
        mpsc::Receiver<EventSinkFailure>,
    ) {
        let (sender, receiver) = crossbeam_channel::bounded(depth);
        let (writer_wake_tx, _writer_wake_rx) = crossbeam_channel::bounded(1);
        let (failure_tx, failure_rx) = mpsc::channel(1);
        let state = Arc::new(EventSinkState {
            phase: AtomicU8::new(PHASE_OPEN),
            admissions: AtomicUsize::new(0),
            queued_payload_bytes: AtomicUsize::new(0),
            max_queued_payload_bytes,
            failure_reported: AtomicBool::new(false),
            failure_tx,
            writer_wake_tx,
        });
        (EventSink { sender, state }, receiver, failure_rx)
    }

    /// A `TransportStatsEvt` with every field at its maximum, i.e. the widest
    /// JSON this event kind can ever produce.
    fn saturated_transport_stats() -> TransportStatsEvt {
        TransportStatsEvt {
            window_ms: u32::MAX,
            peers: u32::MAX,
            parked_peers: u32::MAX,
            webtransport: saturated_path(),
            edge: saturated_path(),
            row_versions_sent: u64::MAX,
            row_versions_superseded_unapplied: u64::MAX,
            row_versions_superseded_applied: u64::MAX,
            row_resends_identical: u64::MAX,
            stale_prepared_flushes_sent: u64::MAX,
            bursts_abandoned: u64::MAX,
            bursts_unsafe_to_rewind: u64::MAX,
            datagram_send_failures: u64::MAX,
            fec_repairs_sent: u64::MAX,
            fec_repairs_refused: u64::MAX,
            resync_rows_requested: u64::MAX,
            rows_declared_lost: u64::MAX,
            unacked_datagrams_max: u32::MAX,
            edge_reliable_queued_bytes_max: u32::MAX,
            inbound_datagram_drops_wt: u64::MAX,
            inbound_datagram_drops_edge: u64::MAX,
            over_capacity_session_rejections: u64::MAX,
            direct_wt_incoming_expected: u64::MAX,
            direct_wt_incoming_unexpected: u64::MAX,
            direct_wt_admitted: u64::MAX,
            nat_keepalives_sent: u64::MAX,
            nat_punch_bursts_sent: u64::MAX,
            nat_punch_refused_not_global: u64::MAX,
            nat_punch_refused_rate_limited: u64::MAX,
            nat_side_channel_send_failed: u64::MAX,
            nat_side_channel_would_block: u64::MAX,
            stats_events_dropped: u64::MAX,
            rebind_requests: u64::MAX,
            rebind_accepted: u64::MAX,
            rebind_committed: u64::MAX,
            rebind_refused: u64::MAX,
            rebind_envelopes_rejected: u64::MAX,
            rebind_events_suppressed: u64::MAX,
        }
    }

    fn saturated_path() -> PathStatsEvt {
        PathStatsEvt {
            paths_available: u32::MAX,
            paths_live: u32::MAX,
            rtt_ewma_us_max: u32::MAX,
            network_rtt_ewma_us_max: u32::MAX,
            jitter_ewma_us_max: u32::MAX,
            send_failures_max: u32::MAX,
            last_ack_age_ms_max: u32::MAX,
            display_datagrams_received: u64::MAX,
            display_datagrams_recovered_by_fec: u64::MAX,
            display_datagrams_declared_lost: u64::MAX,
            display_datagrams_outcome_unknown: u64::MAX,
            quic_sent_packets: u64::MAX,
            quic_lost_packets: u64::MAX,
            quic_lost_bytes: u64::MAX,
            quic_congestion_events: u64::MAX,
            quic_black_holes: u64::MAX,
            quic_datagrams_tx: u64::MAX,
            quic_datagrams_rx: u64::MAX,
            quic_udp_tx_bytes: u64::MAX,
            quic_udp_rx_bytes: u64::MAX,
            quic_mtu_min: u32::MAX,
            quic_cwnd_bytes_min: u64::MAX,
            quic_rtt_us_max: u32::MAX,
        }
    }

    /// The anti-poisoning proof: the widest possible stats frame is far below
    /// every sink bound, so `PayloadTooLarge` and `QueuePayloadFull` are
    /// unreachable for this event kind.
    #[test]
    fn transport_stats_payload_is_bounded_well_below_the_sink_limits() {
        let payload = serde_json::to_vec(&saturated_transport_stats()).unwrap();
        assert!(
            payload.len() < 4096,
            "saturated stats payload is {} bytes, expected < 4096",
            payload.len()
        );
        assert!(payload.len() < MAX_EVENT_PAYLOAD_BYTES / 128);
    }

    /// Locks the `NaN` hazard shut. `serde_json` writes `null` for a non-finite
    /// float, a `null` fails the TypeScript validator, and an invalid payload is
    /// fatal on the daemon side — so no float may ever enter this payload.
    #[test]
    fn transport_stats_json_is_integers_only_with_no_nulls() {
        let value = serde_json::to_value(saturated_transport_stats()).unwrap();

        fn assert_all_unsigned_integers(value: &serde_json::Value, path: &str) {
            match value {
                serde_json::Value::Object(map) => {
                    for (key, entry) in map {
                        assert_all_unsigned_integers(entry, &format!("{path}.{key}"));
                    }
                }
                serde_json::Value::Number(number) => {
                    assert!(number.is_u64(), "{path} is not an unsigned integer");
                }
                other => panic!("{path} is {other:?}, expected an unsigned integer"),
            }
        }

        assert_all_unsigned_integers(&value, "stats");
    }

    #[test]
    fn transport_stats_is_flushed_rather_than_buffered() {
        assert!(
            should_flush(EVT_TRANSPORT_STATS),
            "a periodic diagnostic left in the BufWriter surfaces as minutes of \
             missing telemetry on an otherwise-quiet daemon"
        );
    }

    /// The two delivery contracts, asserted against one another on the same
    /// saturated sink: a diagnostic drops and leaves the sink usable, a
    /// lifecycle frame poisons it.
    #[test]
    fn a_diagnostic_drops_on_a_full_sink_while_a_lifecycle_frame_poisons_it() {
        let (sink, _receiver, mut failure_rx) =
            sink_without_writer(1, MAX_EVENT_QUEUE_PAYLOAD_BYTES);
        sink.send_raw(EVT_BELL, b"first".to_vec()).unwrap();

        // The queue is now full. A diagnostic must fail without poisoning.
        let failure = sink
            .send_diagnostic_json(EVT_TRANSPORT_STATS, &saturated_transport_stats())
            .expect_err("a full queue must reject the diagnostic");
        assert_eq!(failure, EventSinkFailure::QueueFull);
        assert_eq!(sink.state.phase.load(Ordering::Acquire), PHASE_OPEN);
        assert_eq!(
            failure_rx.try_recv().ok(),
            None,
            "a dropped diagnostic must not publish a sink failure"
        );

        // The lifecycle contract is unchanged: the same condition is fatal.
        let failure = sink
            .send_raw(EVT_BELL, b"second".to_vec())
            .expect_err("a full queue must reject the lifecycle frame");
        assert_eq!(failure, EventSinkFailure::QueueFull);
        assert_eq!(sink.state.phase.load(Ordering::Acquire), PHASE_FAILED);
        assert_eq!(
            failure_rx.try_recv().ok(),
            Some(EventSinkFailure::QueueFull)
        );
    }

    #[test]
    fn command_ack_json_has_the_exact_control_contract_shape() {
        assert_eq!(
            serde_json::to_value(CommandAckEvt::Accepted {
                command_id: "command-1",
            })
            .unwrap(),
            json!({
                "status": "accepted",
                "command_id": "command-1",
            }),
        );
        assert_eq!(
            serde_json::to_value(CommandAckEvt::Rejected {
                command_id: "command-2",
                reason: "backpressure",
            })
            .unwrap(),
            json!({
                "status": "rejected",
                "command_id": "command-2",
                "reason": "backpressure",
            }),
        );
    }

    #[test]
    fn bounded_admission_preserves_fifo_and_reports_exactly_one_overflow() {
        let (sink, receiver, mut failure_rx) =
            sink_without_writer(2, MAX_EVENT_QUEUE_PAYLOAD_BYTES);
        sink.send_raw(1, b"first".to_vec()).unwrap();
        sink.send_raw(2, b"second".to_vec()).unwrap();

        assert_eq!(
            sink.send_raw(3, b"overflow".to_vec()),
            Err(EventSinkFailure::QueueFull)
        );
        assert_eq!(
            sink.send_raw(4, b"after-failure".to_vec()),
            Err(EventSinkFailure::Unavailable)
        );

        let first = receiver.try_recv().unwrap();
        let second = receiver.try_recv().unwrap();
        assert_eq!((first.kind, first.payload), (1, b"first".to_vec()));
        assert_eq!((second.kind, second.payload), (2, b"second".to_vec()));
        assert!(receiver.try_recv().is_err());
        assert_eq!(failure_rx.try_recv(), Ok(EventSinkFailure::QueueFull));
        assert!(failure_rx.try_recv().is_err());
    }

    #[test]
    fn oversized_payload_poisoning_happens_before_queue_admission() {
        let (sink, receiver, mut failure_rx) =
            sink_without_writer(1, MAX_EVENT_QUEUE_PAYLOAD_BYTES);
        let oversized = vec![0u8; MAX_EVENT_PAYLOAD_BYTES + 1];

        assert_eq!(
            sink.send_raw(1, oversized),
            Err(EventSinkFailure::PayloadTooLarge {
                actual: MAX_EVENT_PAYLOAD_BYTES + 1,
                maximum: MAX_EVENT_PAYLOAD_BYTES,
            })
        );
        assert!(receiver.is_empty());
        assert_eq!(
            failure_rx.try_recv(),
            Ok(EventSinkFailure::PayloadTooLarge {
                actual: MAX_EVENT_PAYLOAD_BYTES + 1,
                maximum: MAX_EVENT_PAYLOAD_BYTES,
            })
        );
    }

    #[test]
    fn closed_writer_queue_is_a_single_supervised_failure() {
        let (sink, receiver, mut failure_rx) =
            sink_without_writer(1, MAX_EVENT_QUEUE_PAYLOAD_BYTES);
        drop(receiver);

        assert_eq!(
            sink.send_raw(1, b"closed".to_vec()),
            Err(EventSinkFailure::QueueClosed)
        );
        assert_eq!(failure_rx.try_recv(), Ok(EventSinkFailure::QueueClosed));
        assert_eq!(
            sink.send_raw(2, b"after-failure".to_vec()),
            Err(EventSinkFailure::Unavailable)
        );
        assert!(failure_rx.try_recv().is_err());
    }

    struct FailingSerialize;

    impl Serialize for FailingSerialize {
        fn serialize<S>(&self, _serializer: S) -> Result<S::Ok, S::Error>
        where
            S: serde::Serializer,
        {
            Err(serde::ser::Error::custom("forced serialization failure"))
        }
    }

    #[test]
    fn serialization_failure_poisoning_is_supervised() {
        let (sink, receiver, mut failure_rx) =
            sink_without_writer(1, MAX_EVENT_QUEUE_PAYLOAD_BYTES);
        let failure = sink.send_json(1, &FailingSerialize).unwrap_err();

        assert!(
            matches!(failure, EventSinkFailure::Serialization(ref error) if error.contains("forced serialization failure"))
        );
        assert!(receiver.is_empty());
        assert!(matches!(
            failure_rx.try_recv(),
            Ok(EventSinkFailure::Serialization(ref error)) if error.contains("forced serialization failure")
        ));
    }

    #[test]
    fn tiny_event_burst_gets_entry_headroom_without_spending_payload_budget() {
        let (sink, receiver, mut failure_rx) =
            sink_without_writer(EVENT_QUEUE_DEPTH, MAX_EVENT_QUEUE_PAYLOAD_BYTES);

        for kind in 0..64 {
            sink.send_raw(kind, Vec::new()).unwrap();
        }

        assert_eq!(receiver.len(), 64);
        assert_eq!(sink.state.queued_payload_bytes.load(Ordering::Acquire), 0);
        assert!(failure_rx.try_recv().is_err());
    }

    #[test]
    fn payload_budget_remains_hard_even_with_free_entry_slots() {
        let (sink, receiver, mut failure_rx) = sink_without_writer(8, 5);
        sink.send_raw(1, vec![0; 3]).unwrap();

        let expected = EventSinkFailure::QueuePayloadFull {
            queued: 3,
            attempted: 3,
            maximum: 5,
        };
        assert_eq!(sink.send_raw(2, vec![0; 3]), Err(expected.clone()));
        assert_eq!(receiver.len(), 1, "second frame must not enter the queue");
        assert_eq!(failure_rx.try_recv(), Ok(expected));
    }

    #[test]
    fn close_and_last_admission_notify_the_writer_without_polling() {
        let (writer_wake_tx, writer_wake_rx) = crossbeam_channel::bounded(1);
        let (failure_tx, _failure_rx) = mpsc::channel(1);
        let state = EventSinkState {
            phase: AtomicU8::new(PHASE_OPEN),
            admissions: AtomicUsize::new(0),
            queued_payload_bytes: AtomicUsize::new(0),
            max_queued_payload_bytes: MAX_EVENT_QUEUE_PAYLOAD_BYTES,
            failure_reported: AtomicBool::new(false),
            failure_tx,
            writer_wake_tx,
        };

        assert!(state.begin_admission());
        state.close();
        assert_eq!(writer_wake_rx.try_recv(), Ok(()));
        state.end_admission();
        assert_eq!(
            writer_wake_rx.try_recv(),
            Ok(()),
            "the last in-flight producer must wake the drain-and-stop check"
        );
    }

    #[derive(Clone)]
    struct RecordingWriter {
        bytes: Arc<Mutex<Vec<u8>>>,
    }

    impl Write for RecordingWriter {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.bytes.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[tokio::test]
    async fn clean_shutdown_drains_and_flushes_every_frame_in_fifo_order() {
        let bytes = Arc::new(Mutex::new(Vec::new()));
        let writer = RecordingWriter {
            bytes: Arc::clone(&bytes),
        };
        let (sink, mut failure_rx, mut output) = start_event_output(writer, 4).unwrap();

        sink.send_raw(EVT_BELL, b"one".to_vec()).unwrap();
        sink.send_raw(EVT_PTY_READY, b"two".to_vec()).unwrap();
        sink.send_raw(EVT_BELL, b"three".to_vec()).unwrap();
        output.shutdown().await.unwrap();
        assert!(failure_rx.try_recv().is_err());

        let captured = bytes.lock().unwrap().clone();
        let mut cursor = io::Cursor::new(captured);
        assert_eq!(
            crate::ipc::read_frame(&mut cursor).unwrap(),
            Some((EVT_BELL, b"one".to_vec()))
        );
        assert_eq!(
            crate::ipc::read_frame(&mut cursor).unwrap(),
            Some((EVT_PTY_READY, b"two".to_vec()))
        );
        assert_eq!(
            crate::ipc::read_frame(&mut cursor).unwrap(),
            Some((EVT_BELL, b"three".to_vec()))
        );
        assert_eq!(crate::ipc::read_frame(&mut cursor).unwrap(), None);
    }

    #[tokio::test]
    async fn lone_bell_is_visible_without_shutdown_or_a_followup_event() {
        let bytes = Arc::new(Mutex::new(Vec::new()));
        let writer = RecordingWriter {
            bytes: Arc::clone(&bytes),
        };
        let (sink, mut failure_rx, mut output) = start_event_output(writer, 4).unwrap();

        sink.send_raw(EVT_BELL, Vec::new()).unwrap();
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if !bytes.lock().unwrap().is_empty() {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("isolated bell stayed buffered");

        let captured = bytes.lock().unwrap().clone();
        let mut cursor = io::Cursor::new(captured);
        assert_eq!(
            crate::ipc::read_frame(&mut cursor).unwrap(),
            Some((EVT_BELL, Vec::new()))
        );
        assert!(failure_rx.try_recv().is_err());
        output.shutdown().await.unwrap();
    }

    struct FailingWriter;

    impl Write for FailingWriter {
        fn write(&mut self, _bytes: &[u8]) -> io::Result<usize> {
            Err(io::Error::new(io::ErrorKind::BrokenPipe, "forced failure"))
        }

        fn flush(&mut self) -> io::Result<()> {
            Err(io::Error::new(io::ErrorKind::BrokenPipe, "forced failure"))
        }
    }

    #[tokio::test]
    async fn writer_error_is_reported_once_and_shutdown_does_not_hang() {
        let (sink, mut failure_rx, mut output) = start_event_output(FailingWriter, 2).unwrap();
        sink.send_raw(EVT_PTY_READY, b"trigger".to_vec()).unwrap();

        let failure = tokio::time::timeout(Duration::from_secs(1), failure_rx.recv())
            .await
            .expect("writer failure notification timed out")
            .expect("failure channel closed");
        assert!(
            matches!(failure, EventSinkFailure::WriterIo(ref error) if error.contains("forced failure"))
        );
        assert!(failure_rx.try_recv().is_err());
        assert!(matches!(
            output.shutdown().await,
            Err(EventSinkFailure::WriterIo(ref error)) if error.contains("forced failure")
        ));
    }
}
