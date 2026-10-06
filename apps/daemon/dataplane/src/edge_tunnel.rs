//! Daemon outbound edge tunnel.
//!
//! A WebTransport CLIENT connection from the daemon to the anycast edge
//! (`apps/edge`). The daemon dials the edge and sends a `{role:"daemon"}` routing
//! preface; the edge blindly splices it to the matching browser session (which
//! sends `{role:"browser"}` for the same `session_id`). This is the relay path
//! used by the browser dataplane.
//!
//! Frames carried here are ALREADY Noise-sealed by the E2E layer (`merkur-e2e`) that
//! sits above the transport — the tunnel NEVER decrypts. The framing mirrors the
//! browser edge provider (`apps/web/src/session/connect-webtransport-edge.ts`)
//! and the daemon's existing recv framing so relayed frames demux identically to
//! the direct path:
//!   - datagram lane:  `[1-byte channel id][payload]`, one WebTransport datagram.
//!   - reliable lanes: one persistent uni-stream per logical channel, carrying
//!     `[1-byte channel id]` once and then `[u32 BE len][payload]` records.
//!
//! Reference: the proven `apps/edge/src/bin/probe.rs` client and the live-edge
//! integration test below.

use std::future::Future;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

// The edge relay's typed splice-ownership and egress-budget close contract.
use merkur_edge_protocol::{
    COUNTERPART_DETACHED_CLOSE_CODE, COUNTERPART_DETACHED_CLOSE_REASON, EGRESS_BUDGET_CLOSE_CODE,
    EGRESS_BUDGET_CLOSE_REASON, INCARNATION_ANNOUNCED_CLOSE_CODE,
    INCARNATION_ANNOUNCED_CLOSE_REASON, MAX_PREFACE_LEN, PREFACE_VERSION, Role, RoutingAttachment,
    RoutingPreface, SpliceControlEvent,
};
use ring::rand::{SecureRandom, SystemRandom};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, mpsc, watch};
use tokio::task::{AbortHandle, JoinError, JoinSet};
use tracing::{trace, warn};
use wtransport::endpoint::endpoint_side;
use wtransport::error::{ConnectionError, StreamReadError, StreamReadExactError};
use wtransport::tls::Sha256Digest;
use wtransport::{ClientConfig, Connection, Endpoint};

use crate::connection::PeerTransport;
use crate::network::peer::{
    DatagramEnqueueResult, DeliveryMode, EdgeIngressIdentity, MAX_INBOUND_FRAME_BYTES, PeerMessage,
    ReliablePayload, try_enqueue_datagram,
};
use crate::network::protocol::{
    CHANNEL_CTRL, CHANNEL_DATA_HELLO, CHANNEL_DISPLAY_COMMIT, CHANNEL_PTY, CHANNEL_SIGNALING,
    DataHandshakeGeneration, EdgeLane,
};
use crate::session::policy::SessionPolicy;

/// Opens the daemon-only bidirectional stream whose reverse direction carries
/// advisory browser-facing delivery state. Lifecycle remains on the routing
/// preface stream so a flow-controlled quote can never delay detach/rebind.
const DELIVERY_QUOTE_STREAM_PREFACE: &[u8] = b"merkur-edge-quote-v1";

/// Reliable logical channels each own one persistent uni-stream. Datagram-only
/// channels are deliberately absent and therefore fail closed if presented as a
/// reliable stream preface.
const RELIABLE_STREAM_CHANNELS: [u8; 5] = [
    CHANNEL_SIGNALING,
    CHANNEL_PTY,
    CHANNEL_CTRL,
    CHANNEL_DISPLAY_COMMIT,
    CHANNEL_DATA_HELLO,
];

/// Bounded depth of the reliable-lane send queue drained by the writer task.
/// `send_reliable` enqueues here instead of opening a uni-stream inline (which
/// would block the single run-loop `select!` arm for a full edge RTT — see
/// `send_reliable`). A full queue means the edge is badly backed up; the frame
/// is dropped and the display layer recovers it by re-selecting the row on a
/// later flush (or via resync).
const EDGE_RELIABLE_QUEUE_CAP: usize = 512;
/// Payload-byte ceiling across queued/in-progress reliable frames for one edge
/// connection. The count bound alone allowed 512 near-64KiB snapshot chunks to
/// retain >32MiB per lane. Four MiB still covers roughly one 64-stream credit
/// window of maximum-size chunks without permitting pathological per-session
/// retention.
const EDGE_RELIABLE_QUEUE_MAX_BYTES: usize = 4 * 1024 * 1024;

/// One operation on the live reliable lane gets one RFC-6298 RTO ceiling.
/// [`SessionPolicy::RTO_CEIL_MS`] is the point at which this interactive path is
/// already considered unusable; waiting until QUIC's 30-second idle timeout
/// would visibly wedge the terminal instead of handing recovery to the existing
/// generation-fenced edge redial path.
const EDGE_RELIABLE_OPERATION_TIMEOUT: Duration =
    Duration::from_millis(SessionPolicy::RTO_CEIL_MS as u64);

static INBOUND_DATAGRAM_QUEUE_DROPS: AtomicU64 = AtomicU64::new(0);

/// Cumulative datagrams an edge tunnel dropped because the owner's ingress
/// queue was full, since process start.
pub(crate) fn inbound_datagram_queue_drops() -> u64 {
    INBOUND_DATAGRAM_QUEUE_DROPS.load(Ordering::Relaxed)
}

/// The five live lane readers plus one inspection slot. Keeping one extra slot
/// lets the acceptor observe and fail a duplicate/unknown sixth stream instead
/// of silently leaving it blocked behind stream credit forever.
const MAX_CONCURRENT_INBOUND_RELIABLE: usize = RELIABLE_STREAM_CHANNELS.len() + 1;

/// Deadline for a lane preface or a record that has already started. Waiting for
/// the first byte of the next record is intentionally unbounded: an idle channel
/// is healthy and connection keepalive owns transport liveness.
const INBOUND_RELIABLE_PARTIAL_TIMEOUT: Duration = Duration::from_secs(30);

/// Each dial attempt is bounded independently so an unreachable edge cannot
/// leave the session bootstrap parked forever inside one nominally bounded
/// attempt.
const EDGE_CONNECT_ATTEMPT_TIMEOUT: Duration = Duration::from_secs(4);
/// Fixed exponential ceilings are preserved, but each fallback wait is sampled
/// uniformly within its current ceiling so a fleet does not redial in lockstep.
const EDGE_BACKOFF_INITIAL_CEILING_MS: u64 = 250;
const EDGE_BACKOFF_MAX_CEILING_MS: u64 = 5_000;
static EDGE_BACKOFF_FALLBACK_SEQUENCE: AtomicU64 = AtomicU64::new(0);
const RELIABLE_LANE_FAILED_CLOSE_CODE: u32 = 0x4d02;
const RELIABLE_LANE_FAILED_CLOSE_REASON: &[u8] = b"reliable-lane-failed";

/// One already-sealed reliable payload. Its original value — a heap
/// allocation for a display record, an inline array for an input ack — moves
/// from the caller into the selected persistent-channel queue; immediate
/// rejection returns that exact value for carrier fallback.
struct ReliableFrame {
    payload: ReliablePayload,
    reserved_bytes: usize,
    queued_bytes: Option<Arc<AtomicUsize>>,
    _queued_slot: Option<OwnedSemaphorePermit>,
}

/// Capacity acquired off the terminal owner. Seal only after this is returned,
/// then publish synchronously so later CTRL counters cannot overtake the reply.
pub(crate) struct ReliablePermit {
    queue: mpsc::OwnedPermit<ReliableFrame>,
    frame: ReliableFrame,
}

impl ReliablePermit {
    pub(crate) fn send(mut self, payload: ReliablePayload) {
        assert_eq!(payload.as_slice().len() + 5, self.frame.reserved_bytes);
        self.frame.payload = payload;
        self.queue.send(self.frame);
    }
}

async fn reserve_reliable_reply(
    sender: mpsc::Sender<ReliableFrame>,
    queued_bytes: Arc<AtomicUsize>,
    queued_slots: Arc<Semaphore>,
    payload_bytes: usize,
) -> Option<ReliablePermit> {
    let reserved_bytes = payload_bytes.checked_add(5)?;
    if reserved_bytes > EDGE_RELIABLE_QUEUE_MAX_BYTES {
        return None;
    }
    let mut slots = Arc::clone(&queued_slots).acquire_owned().await.ok()?;
    while !try_reserve_reliable_bytes(&queued_bytes, reserved_bytes) {
        drop(slots);
        // Reserve the currently free slots plus one: completion of an actual
        // queued frame is the wake signal. No polling, new per-frame notifier,
        // or changes to text-only admission/retirement are needed. Holding the
        // free slots while waiting also prevents producers from starving CTRL.
        let count = (queued_slots.available_permits() + 1).min(EDGE_RELIABLE_QUEUE_CAP);
        slots = Arc::clone(&queued_slots)
            .acquire_many_owned(count as u32)
            .await
            .ok()?;
    }
    let queued_slot = slots.split(1)?;
    drop(slots);
    let frame = ReliableFrame {
        payload: ReliablePayload::Heap(Vec::new()),
        reserved_bytes,
        queued_bytes: Some(queued_bytes),
        _queued_slot: Some(queued_slot),
    };
    // The frame owns both leases across this await and on cancellation.
    let queue = sender.reserve_owned().await.ok()?;
    Some(ReliablePermit { queue, frame })
}

#[cfg(test)]
mod reliable_reply_tests {
    use super::*;
    use std::task::{Context, Poll, Waker};

    #[tokio::test]
    async fn refusal_waits_for_physical_credit_and_retains_accounting_until_written() {
        let bytes = Arc::new(AtomicUsize::new(0));
        let slots = Arc::new(Semaphore::new(EDGE_RELIABLE_QUEUE_CAP));
        let occupying = ReliableFrame::accounted(
            ReliablePayload::Heap(vec![0; EDGE_RELIABLE_QUEUE_MAX_BYTES - 5]),
            Arc::clone(&bytes),
            Arc::clone(&slots),
        )
        .ok()
        .unwrap();
        let (sender, mut receiver) = mpsc::channel(EDGE_RELIABLE_QUEUE_CAP);
        let mut reserved = Box::pin(reserve_reliable_reply(
            sender,
            Arc::clone(&bytes),
            Arc::clone(&slots),
            35,
        ));
        let mut cx = Context::from_waker(Waker::noop());
        assert!(matches!(reserved.as_mut().poll(&mut cx), Poll::Pending));
        assert_eq!(bytes.load(Ordering::Acquire), EDGE_RELIABLE_QUEUE_MAX_BYTES);
        drop(occupying);
        let permit = reserved.await.unwrap();
        assert_eq!(bytes.load(Ordering::Acquire), 40);
        assert_eq!(slots.available_permits(), EDGE_RELIABLE_QUEUE_CAP - 1);
        permit.send(ReliablePayload::Heap(vec![7; 35]));
        let frame = receiver.recv().await.unwrap();
        assert_eq!(frame.payload.as_slice(), &[7; 35]);
        assert_eq!(bytes.load(Ordering::Acquire), 40);
        drop(frame);
        assert_eq!(bytes.load(Ordering::Acquire), 0);
        assert_eq!(slots.available_permits(), EDGE_RELIABLE_QUEUE_CAP);
    }

    #[tokio::test]
    async fn cancelled_waiter_and_closed_writer_return_every_reservation() {
        let bytes = Arc::new(AtomicUsize::new(0));
        let slots = Arc::new(Semaphore::new(EDGE_RELIABLE_QUEUE_CAP));
        let (sender, receiver) = mpsc::channel(1);
        // Occupy channel capacity independently so cancellation occurs after
        // byte/slot acquisition, at the final writer-capacity wait.
        sender.send(ReliableFrame::unaccounted(&[])).await.unwrap();
        let mut pending = Box::pin(reserve_reliable_reply(
            sender.clone(),
            Arc::clone(&bytes),
            Arc::clone(&slots),
            35,
        ));
        let mut cx = Context::from_waker(Waker::noop());
        assert!(matches!(pending.as_mut().poll(&mut cx), Poll::Pending));
        assert_eq!(bytes.load(Ordering::Acquire), 40);
        drop(pending);
        assert_eq!(bytes.load(Ordering::Acquire), 0);
        assert_eq!(slots.available_permits(), EDGE_RELIABLE_QUEUE_CAP);
        drop(receiver);
        assert!(
            reserve_reliable_reply(sender, Arc::clone(&bytes), Arc::clone(&slots), 35)
                .await
                .is_none()
        );
        assert_eq!(bytes.load(Ordering::Acquire), 0);
        assert_eq!(slots.available_permits(), EDGE_RELIABLE_QUEUE_CAP);
    }
}

impl ReliableFrame {
    fn accounted(
        payload: ReliablePayload,
        queued_bytes: Arc<AtomicUsize>,
        queued_slots: Arc<Semaphore>,
    ) -> Result<Self, ReliablePayload> {
        let payload_len = payload.as_slice().len();
        if u32::try_from(payload_len).is_err() {
            return Err(payload);
        }
        // Retain the previous `[channel][length][payload]` accounting even
        // though a persistent lane writes its channel byte only once. This
        // keeps the established connection-wide byte bound strictly no looser.
        let Some(reserved_bytes) = payload_len.checked_add(1 + size_of::<u32>()) else {
            return Err(payload);
        };
        let Ok(queued_slot) = queued_slots.try_acquire_owned() else {
            return Err(payload);
        };
        if !try_reserve_reliable_bytes(&queued_bytes, reserved_bytes) {
            return Err(payload);
        }
        Ok(Self {
            payload,
            reserved_bytes,
            queued_bytes: Some(queued_bytes),
            _queued_slot: Some(queued_slot),
        })
    }

    #[cfg(test)]
    fn unaccounted(payload: &[u8]) -> Self {
        Self {
            payload: ReliablePayload::Heap(payload.to_vec()),
            reserved_bytes: 0,
            queued_bytes: None,
            _queued_slot: None,
        }
    }

    fn into_payload(mut self) -> ReliablePayload {
        self.release_reservation();
        // An empty `Vec` does not allocate, so handing the payload back costs
        // nothing beyond the move.
        std::mem::replace(&mut self.payload, ReliablePayload::Heap(Vec::new()))
    }

    fn release_reservation(&mut self) {
        if let Some(queued_bytes) = self.queued_bytes.take() {
            queued_bytes.fetch_sub(self.reserved_bytes, Ordering::AcqRel);
        }
        self._queued_slot.take();
    }
}

impl Drop for ReliableFrame {
    fn drop(&mut self) {
        self.release_reservation();
    }
}

fn try_reserve_reliable_bytes(queued_bytes: &AtomicUsize, frame_len: usize) -> bool {
    queued_bytes
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
            current
                .checked_add(frame_len)
                .filter(|next| *next <= EDGE_RELIABLE_QUEUE_MAX_BYTES)
        })
        .is_ok()
}

struct ReliableSenders {
    signaling: mpsc::Sender<ReliableFrame>,
    pty: mpsc::Sender<ReliableFrame>,
    ctrl: mpsc::Sender<ReliableFrame>,
    display_commit: mpsc::Sender<ReliableFrame>,
    bulk_hello: mpsc::Sender<ReliableFrame>,
}

impl ReliableSenders {
    fn sender(&self, channel_id: u8) -> Option<&mpsc::Sender<ReliableFrame>> {
        match channel_id {
            CHANNEL_SIGNALING => Some(&self.signaling),
            CHANNEL_PTY => Some(&self.pty),
            CHANNEL_CTRL => Some(&self.ctrl),
            CHANNEL_DISPLAY_COMMIT => Some(&self.display_commit),
            CHANNEL_DATA_HELLO => Some(&self.bulk_hello),
            _ => None,
        }
    }
}

type ReliableReceivers = Vec<(u8, mpsc::Receiver<ReliableFrame>)>;

/// The reliable lanes of a `new_test_pairing` tunnel, read by the test.
#[cfg(test)]
pub(crate) struct TestReliableLanes(ReliableReceivers);

#[cfg(test)]
impl TestReliableLanes {
    /// The next record queued on `channel_id`, if any.
    pub(crate) fn try_recv(&mut self, channel_id: u8) -> Option<Vec<u8>> {
        let (_, receiver) = self.0.iter_mut().find(|(id, _)| *id == channel_id)?;
        let frame = receiver.try_recv().ok()?;
        Some(frame.into_payload().into_vec())
    }
}

fn reliable_channel_queues() -> (ReliableSenders, ReliableReceivers) {
    let (signaling, signaling_rx) = mpsc::channel(EDGE_RELIABLE_QUEUE_CAP);
    let (pty, pty_rx) = mpsc::channel(EDGE_RELIABLE_QUEUE_CAP);
    let (ctrl, ctrl_rx) = mpsc::channel(EDGE_RELIABLE_QUEUE_CAP);
    let (display_commit, display_commit_rx) = mpsc::channel(EDGE_RELIABLE_QUEUE_CAP);
    let (bulk_hello, bulk_hello_rx) = mpsc::channel(EDGE_RELIABLE_QUEUE_CAP);
    (
        ReliableSenders {
            signaling,
            pty,
            ctrl,
            display_commit,
            bulk_hello,
        },
        vec![
            (CHANNEL_SIGNALING, signaling_rx),
            (CHANNEL_PTY, pty_rx),
            (CHANNEL_CTRL, ctrl_rx),
            (CHANNEL_DISPLAY_COMMIT, display_commit_rx),
            (CHANNEL_DATA_HELLO, bulk_hello_rx),
        ],
    )
}

fn reliable_channel_bit(channel_id: u8) -> Option<u8> {
    RELIABLE_STREAM_CHANNELS
        .iter()
        .position(|candidate| *candidate == channel_id)
        .map(|index| 1_u8 << index)
}

fn try_enqueue_reliable_payload(
    senders: &ReliableSenders,
    queued_bytes: &Arc<AtomicUsize>,
    queued_slots: &Arc<Semaphore>,
    channel_id: u8,
    payload: ReliablePayload,
) -> Result<(), ReliablePayload> {
    let Some(sender) = senders.sender(channel_id) else {
        return Err(payload);
    };
    let frame =
        ReliableFrame::accounted(payload, Arc::clone(queued_bytes), Arc::clone(queued_slots))?;
    sender
        .try_send(frame)
        .map_err(|error| error.into_inner().into_payload())
}

/// Exponential fallback with full jitter. The network attempt remains
/// event-first and immediate; this schedule is consulted only after it fails.
#[derive(Debug)]
pub(crate) struct EdgeConnectBackoff {
    ceiling_ms: u64,
}

impl EdgeConnectBackoff {
    pub(crate) fn new() -> Self {
        Self {
            ceiling_ms: EDGE_BACKOFF_INITIAL_CEILING_MS,
        }
    }

    pub(crate) fn next_delay(&mut self) -> Duration {
        self.next_delay_from_sample(system_jitter_sample(&EDGE_BACKOFF_FALLBACK_SEQUENCE))
    }

    /// Deterministic injection seam for validating the complete jitter range.
    fn next_delay_from_sample(&mut self, sample: u64) -> Duration {
        // Retain sub-millisecond entropy here; the runtime may then honor or
        // coalesce it according to the host timer's actual resolution.
        let ceiling_ns = self.ceiling_ms * 1_000_000;
        let range = ceiling_ns + 1;
        let delay_ns = ((u128::from(sample) * u128::from(range)) >> 64) as u64;
        self.ceiling_ms = self
            .ceiling_ms
            .saturating_mul(2)
            .min(EDGE_BACKOFF_MAX_CEILING_MS);
        Duration::from_nanos(delay_ns)
    }
}

/// Jitter is not security-sensitive, so an entropy failure must not make an
/// already-degraded network path crash. The fallback mixes process-local state,
/// wall-clock entropy, and ASLR while preserving the same schedule contract.
fn system_jitter_sample(fallback_sequence: &AtomicU64) -> u64 {
    let mut bytes = [0_u8; size_of::<u64>()];
    if SystemRandom::new().fill(&mut bytes).is_ok() {
        return u64::from_ne_bytes(bytes);
    }

    let sequence =
        fallback_sequence.fetch_add(0x9e37_79b9_7f4a_7c15, std::sync::atomic::Ordering::Relaxed);
    let elapsed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let mut value = (elapsed as u64)
        ^ ((elapsed >> 64) as u64)
        ^ sequence
        ^ (std::process::id() as u64).rotate_left(32)
        ^ (fallback_sequence as *const AtomicU64 as usize as u64);
    value ^= value >> 30;
    value = value.wrapping_mul(0xbf58_476d_1ce4_e5b9);
    value ^= value >> 27;
    value = value.wrapping_mul(0x94d0_49bb_1331_11eb);
    value ^ (value >> 31)
}

/// What admits this daemon to an edge: its id, the attach ticket the server
/// minted for it (`apps/edge/src/attach_ticket.rs`), and this process's
/// incarnation, which every tunnel names.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EdgeCredential {
    pub daemon_id: Arc<str>,
    pub ticket: Arc<str>,
    pub incarnation: Arc<str>,
}

#[derive(Debug, Default)]
struct EdgeAdmissionParts {
    daemon_id: Option<Arc<str>>,
    ticket: Option<Arc<str>>,
    /// Each edge's certificate hashes as the server last stated them: a
    /// session start states its edge's, a lease every registered edge's. One
    /// entry per edge the registry ever named.
    pins: std::collections::HashMap<String, Arc<[[u8; 32]]>>,
    /// Edges this process has stated its incarnation to, and edges a statement
    /// is on its way to.
    announced: std::collections::HashSet<String>,
    announcing: std::collections::HashSet<String>,
}

/// What every dial presents and pins, shared by all of them.
///
/// A replacement ticket and every edge's current certificate hashes arrive
/// with each control lease while dials and redials are in flight, so a dial
/// reads them when it connects rather than when it was planned: a redial after
/// a network change presents the newest ticket and pins the certificate the
/// edge serves now, not the ones current when its session started.
#[derive(Clone, Debug)]
pub struct EdgeAdmission {
    parts: Arc<std::sync::RwLock<EdgeAdmissionParts>>,
    /// Drawn once per process. An edge that sees another incarnation of this
    /// daemon retires every session the earlier process held there.
    incarnation: Arc<str>,
}

impl Default for EdgeAdmission {
    fn default() -> Self {
        use base64::Engine;
        let mut incarnation = [0u8; 16];
        SystemRandom::new()
            .fill(&mut incarnation)
            .expect("operating system randomness for the dataplane incarnation");
        Self {
            parts: Arc::default(),
            incarnation: base64::engine::general_purpose::URL_SAFE_NO_PAD
                .encode(incarnation)
                .into(),
        }
    }
}

impl EdgeAdmission {
    /// Configure fixes the daemon id once per process.
    pub fn set_daemon_id(&self, daemon_id: &str) {
        self.parts_mut().daemon_id = Some(Arc::from(daemon_id));
    }

    #[cfg(test)]
    pub fn set_ticket(&self, ticket: &str) {
        self.parts_mut().ticket = Some(Arc::from(ticket));
    }

    /// A lease: the newest ticket and every registered edge's hashes. Returns
    /// the edges this process has not yet stated its incarnation to, each now
    /// marked as on its way; [`Self::announced`] settles each.
    pub fn update(
        &self,
        ticket: &str,
        edges: Vec<(String, Vec<[u8; 32]>)>,
    ) -> Vec<(String, Arc<[[u8; 32]]>)> {
        let mut parts = self.parts_mut();
        parts.ticket = Some(Arc::from(ticket));
        let configured = parts.daemon_id.is_some();
        let mut pending = Vec::new();
        for (url, hashes) in edges {
            let hashes: Arc<[[u8; 32]]> = hashes.into();
            if configured
                && !parts.announced.contains(&url)
                && parts.announcing.insert(url.clone())
            {
                pending.push((url.clone(), Arc::clone(&hashes)));
            }
            parts.pins.insert(url, hashes);
        }
        pending
    }

    /// The statement to `url` ended; one that failed is made again at the
    /// next lease.
    pub fn announced(&self, url: &str, acknowledged: bool) {
        let mut parts = self.parts_mut();
        parts.announcing.remove(url);
        if acknowledged {
            parts.announced.insert(url.to_string());
        }
    }

    /// The certificate hashes `url` is pinned by: the server's newest
    /// statement of them.
    pub fn pins(&self, url: &str) -> Option<Arc<[[u8; 32]]>> {
        self.parts().pins.get(url).cloned()
    }

    /// Every part, or none: a preface without each is refused by every edge.
    pub fn current(&self) -> Option<EdgeCredential> {
        let parts = self.parts();
        Some(EdgeCredential {
            daemon_id: parts.daemon_id.clone()?,
            ticket: parts.ticket.clone()?,
            incarnation: Arc::clone(&self.incarnation),
        })
    }

    fn parts(&self) -> std::sync::RwLockReadGuard<'_, EdgeAdmissionParts> {
        self.parts
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn parts_mut(&self) -> std::sync::RwLockWriteGuard<'_, EdgeAdmissionParts> {
        self.parts
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    #[cfg(test)]
    pub(crate) fn for_test() -> Self {
        let admission = Self::default();
        admission.set_daemon_id("test-daemon");
        admission.set_ticket("test-ticket");
        admission
    }
}

/// Standard-base64 SHA-256 certificate hashes as the server writes them: one or
/// two, each exactly 32 bytes.
pub fn decode_cert_hashes(cert_hashes_b64: &[String]) -> Option<Vec<[u8; 32]>> {
    use base64::Engine;
    if cert_hashes_b64.is_empty() || cert_hashes_b64.len() > 2 {
        return None;
    }
    cert_hashes_b64
        .iter()
        .map(|encoded| {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(encoded.trim())
                .ok()?;
            bytes.as_slice().try_into().ok()
        })
        .collect()
}

/// Exact per-session edge dial parameters supplied by the server.
#[derive(Debug, Clone)]
pub struct EdgeConfig {
    pub url: String,
    /// The process-wide admission, carried so every dial and redial of this
    /// session reads the newest ticket and pins.
    pub admission: EdgeAdmission,
}

impl EdgeConfig {
    /// A session start's edge. Its hashes are the server's newest statement of
    /// that edge's certificates, so they replace the admission's.
    pub fn from_hashes(
        url: &str,
        cert_hashes_b64: &[String],
        admission: &EdgeAdmission,
    ) -> Option<Self> {
        let url = url.trim();
        if url.is_empty() {
            return None;
        }
        let cert_hashes = decode_cert_hashes(cert_hashes_b64)?;
        admission
            .parts_mut()
            .pins
            .insert(url.to_string(), cert_hashes.into());
        Some(Self {
            url: url.to_string(),
            admission: admission.clone(),
        })
    }

    /// The hashes this session's edge is pinned by now.
    #[cfg(test)]
    pub fn pins(&self) -> Arc<[[u8; 32]]> {
        self.admission
            .pins(&self.url)
            .expect("a session start states its edge's hashes")
    }
}

/// Where one edge tunnel's readers deliver: the owner's ingress queue, and the
/// identity every frame relayed from the browser is stamped with. The edge has
/// no peer id — the tunnel is per-session — so the dial-time peer id is carried
/// in, beside the exact session, generation and lane the owner fences queued
/// work by. The readers hand each frame to the owner themselves, as the direct
/// path's readers do; no task sits between them.
#[derive(Clone)]
pub struct EdgeIngress {
    pub tx: mpsc::Sender<PeerMessage>,
    pub peer_node_id: Arc<str>,
    pub identity: EdgeIngressIdentity,
}

impl EdgeIngress {
    /// One frame received from the edge as the daemon's internal
    /// [`PeerMessage`]. Edge is an explicit carrier identity so its liveness
    /// and RTT do not overwrite those of direct WebTransport, and `delivery`
    /// names the lane the frame arrived on. The payload is a refcounted slice
    /// of the QUIC datagram or a reliable record's exact-size read buffer,
    /// never a copy, and stays Noise-sealed — the edge and tunnel never decrypt
    /// — so the standard E2E open handles it unchanged.
    pub(crate) fn message(
        &self,
        channel_id: u8,
        payload: bytes::Bytes,
        delivery: DeliveryMode,
        input_permit: Option<OwnedSemaphorePermit>,
    ) -> PeerMessage {
        PeerMessage {
            input_permit,
            peer_node_id: Arc::clone(&self.peer_node_id),
            channel_id,
            payload,
            via_transport: PeerTransport::Edge,
            delivery,
            connection_id: self.identity.generation,
            edge_ingress: Some(self.identity.clone()),
        }
    }

    /// Hand one `[1-byte channel id][payload]` datagram to the owner. Best
    /// effort: a full queue drops it, so a datagram never waits and never
    /// holds up the reader behind it.
    fn enqueue_datagram(&self, datagram: bytes::Bytes) -> DatagramEnqueueResult {
        try_enqueue_datagram(
            &self.tx,
            self.message(
                datagram[0],
                datagram.slice(1..),
                DeliveryMode::Datagram,
                None,
            ),
            &INBOUND_DATAGRAM_QUEUE_DROPS,
            "edge_webtransport",
        )
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EdgeTunnelCloseReason {
    CounterpartDetached,
    EgressBudget,
    ReliableLaneFailed(EdgeReliableLaneFailure),
    Other,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EdgeReliableLaneDirection {
    Send,
    Receive,
}

/// Exact persistent-lane operation that made a tunnel generation unusable.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EdgeReliableLaneOperation {
    OpenUni,
    Open,
    Bind,
    Write,
    Stopped,
    AcceptUni,
    ReadChannel,
    ReadHeader,
    ReadPayload,
    Enqueue,
}

/// Stable failure class returned to the tunnel owner. Error strings remain in
/// logs; lifecycle decisions use this bounded taxonomy.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EdgeReliableLaneFailureKind {
    TimedOut,
    Transport,
    Reset,
    WorkerTerminated,
    Finished,
    Malformed,
    DuplicateChannel,
    UnknownChannel,
    ConsumerClosed,
    Allocation,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EdgeReliableLaneFailure {
    pub direction: EdgeReliableLaneDirection,
    pub channel_id: Option<u8>,
    pub operation: EdgeReliableLaneOperation,
    pub kind: EdgeReliableLaneFailureKind,
}

fn classify_application_close(code: wtransport::VarInt, reason: &[u8]) -> EdgeTunnelCloseReason {
    if code == wtransport::VarInt::from_u32(COUNTERPART_DETACHED_CLOSE_CODE)
        && reason == COUNTERPART_DETACHED_CLOSE_REASON
    {
        EdgeTunnelCloseReason::CounterpartDetached
    } else if code == wtransport::VarInt::from_u32(EGRESS_BUDGET_CLOSE_CODE)
        && reason == EGRESS_BUDGET_CLOSE_REASON
    {
        EdgeTunnelCloseReason::EgressBudget
    } else {
        EdgeTunnelCloseReason::Other
    }
}

fn classify_connection_close(error: &ConnectionError) -> EdgeTunnelCloseReason {
    match error {
        ConnectionError::ApplicationClosed(close) => {
            classify_application_close(close.code(), close.reason())
        }
        _ => EdgeTunnelCloseReason::Other,
    }
}

/// Build the length-delimited JSON routing preface the edge reads first: a
/// tunnel of this process's incarnation for `session_id`.
fn build_preface(session_id: &str, credential: &EdgeCredential) -> Vec<u8> {
    RoutingPreface {
        session_id: session_id.to_string(),
        role: Role::Daemon,
        version: PREFACE_VERSION,
        attachment: RoutingAttachment::Tunnel {
            incarnation: credential.incarnation.to_string(),
        },
        daemon_id: credential.daemon_id.to_string(),
        ticket: credential.ticket.to_string(),
    }
    .encode()
}

/// State this process's incarnation at `url`, where it may hold no tunnel: the
/// edge retires every session an earlier process of this daemon left there,
/// and their clients learn at once that no tunnel will return, where the dead
/// process's connections would hold them until the edge's idle timeout. `Ok`
/// once the edge acknowledged.
pub async fn announce_incarnation(
    url: &str,
    pins: &[[u8; 32]],
    credential: &EdgeCredential,
) -> Result<(), String> {
    let config = ClientConfig::builder()
        .with_bind_default()
        .with_server_certificate_hashes(pins.iter().copied().map(Sha256Digest::new))
        .build();
    let endpoint = Endpoint::client(config).map_err(|e| format!("announce endpoint: {e}"))?;
    let announce = async {
        let conn = endpoint
            .connect(url)
            .await
            .map_err(|e| format!("announce connect: {e}"))?;
        let (mut send, _events) = conn
            .open_bi()
            .await
            .map_err(|e| format!("announce open_bi: {e}"))?
            .await
            .map_err(|e| format!("announce open_bi await: {e}"))?;
        let preface = RoutingPreface {
            session_id: String::new(),
            role: Role::Daemon,
            version: PREFACE_VERSION,
            attachment: RoutingAttachment::Announce {
                incarnation: credential.incarnation.to_string(),
            },
            daemon_id: credential.daemon_id.to_string(),
            ticket: credential.ticket.to_string(),
        };
        send.write_all(&preface.encode())
            .await
            .map_err(|e| format!("announce preface write: {e}"))?;
        match conn.closed().await {
            ConnectionError::ApplicationClosed(close)
                if close.code() == wtransport::VarInt::from_u32(INCARNATION_ANNOUNCED_CLOSE_CODE)
                    && close.reason() == INCARNATION_ANNOUNCED_CLOSE_REASON =>
            {
                Ok(())
            }
            other => Err(format!("announcement unacknowledged: {other}")),
        }
    };
    tokio::time::timeout(EDGE_CONNECT_ATTEMPT_TIMEOUT, announce)
        .await
        .map_err(|_| "announcement timed out".to_string())?
}

/// A live tunnel to the edge for one relayed session.
/// Read the edge's splice control events for as long as the tunnel lives.
///
/// Same `[u32 BE len][JSON]` envelope as the preface, in the reverse direction.
/// The stream ending is not a session failure — it only means the edge stopped
/// reporting — so the task exits quietly and the owner loop falls back to its
/// ordinary liveness reconciliation.
fn spawn_lifecycle_reader(
    mut recv: wtransport::RecvStream,
    state: watch::Sender<CounterpartState>,
    relay_data_paused: watch::Sender<Option<bool>>,
    browser_path: watch::Sender<Option<EdgeBrowserPath>>,
    delivery_quote: Arc<Mutex<DeliveryQuoteFence>>,
    absent: Arc<AtomicBool>,
    session_id: String,
) -> AbortHandle {
    tokio::spawn(async move {
        let mut len_buf = [0u8; 4];
        // One body buffer for the reader's life, grown to the largest event
        // seen (at most `MAX_PREFACE_LEN`); each event is read over the last.
        let mut body_buf = Vec::new();
        loop {
            if recv.read_exact(&mut len_buf).await.is_err() {
                return;
            }
            let len = u32::from_be_bytes(len_buf) as usize;
            if len == 0 || len > MAX_PREFACE_LEN {
                warn!(session_id = %session_id, "edge control event length out of bounds");
                return;
            }
            if body_buf.len() < len {
                body_buf.resize(len, 0u8);
            }
            let body = &mut body_buf[..len];
            if recv.read_exact(body).await.is_err() {
                return;
            }
            let Ok(event) = serde_json::from_slice::<SpliceControlEvent>(body) else {
                warn!(session_id = %session_id, "unparsable edge control event");
                return;
            };
            if let SpliceControlEvent::RelayDataPaused { paused } = event {
                relay_data_paused.send_replace(Some(paused));
                continue;
            }
            // Path state, not pairing state: it names its own attachment, and
            // the owner applies it only to the attachment it reports on.
            if let SpliceControlEvent::CounterpartPath {
                counterpart_attachment_id,
                address,
            } = event
            {
                if counterpart_attachment_id == 0 {
                    warn!(session_id = %session_id, "edge path report names no attachment");
                    return;
                }
                browser_path.send_replace(Some(EdgeBrowserPath {
                    attachment_id: counterpart_attachment_id,
                    address: address.to_canonical(),
                }));
                continue;
            }
            let Some((next, browser_attachment_id)) = counterpart_state(event) else {
                warn!(session_id = %session_id, "invalid edge lifecycle attachment epoch");
                return;
            };
            absent.store(
                !matches!(next, CounterpartState::Attached { .. }),
                Ordering::Release,
            );
            // A quote belongs to one paired carrier generation. Clear it on
            // every lifecycle observation, including repeated presence, so a
            // redial/rebind never plans against the predecessor's path state.
            {
                let mut fence = delivery_quote
                    .lock()
                    .expect("edge delivery-quote fence poisoned");
                fence.change_browser_attachment(browser_attachment_id);
            }
            // send_replace, not send: a repeated identical state must still be
            // observable, and there is never a reason to keep an older one.
            let _ = state.send_replace(next);
        }
    })
    .abort_handle()
}

/// Read newest-value browser delivery quotes from their dedicated advisory
/// stream. Malformed or stalled quote traffic ends only this reader; terminal
/// data and lifecycle continue on independent QUIC streams.
fn spawn_delivery_quote_reader(
    mut recv: wtransport::RecvStream,
    delivery_quote: Arc<Mutex<DeliveryQuoteFence>>,
    session_id: String,
) -> AbortHandle {
    tokio::spawn(async move {
        let mut len_buf = [0u8; 4];
        // One body buffer for the reader's life, as the lifecycle reader keeps:
        // a quote arrives with every change in the browser leg's delivery state.
        let mut body_buf = Vec::new();
        let mut blocked = false;
        loop {
            if recv.read_exact(&mut len_buf).await.is_err() {
                clear_delivery_quote(&delivery_quote);
                return;
            }
            let len = u32::from_be_bytes(len_buf) as usize;
            if len == 0 || len > MAX_PREFACE_LEN {
                warn!(session_id = %session_id, "edge delivery quote length out of bounds");
                clear_delivery_quote(&delivery_quote);
                return;
            }
            if body_buf.len() < len {
                body_buf.resize(len, 0u8);
            }
            let body = &mut body_buf[..len];
            if recv.read_exact(body).await.is_err() {
                clear_delivery_quote(&delivery_quote);
                return;
            }
            let Ok(event) = serde_json::from_slice::<SpliceDeliveryQuoteEvent>(body) else {
                warn!(session_id = %session_id, "unparsable edge delivery quote");
                clear_delivery_quote(&delivery_quote);
                return;
            };
            let (browser_attachment_id, quote) = event.downstream_quote();
            let published = delivery_quote
                .lock()
                .expect("edge delivery-quote fence poisoned")
                .publish_if_current(browser_attachment_id, quote);
            // Display held for this browser leg resumes on the quote that
            // reopens it, not on a later tick.
            if published {
                let reopened = blocked && !quote.send_blocked;
                blocked = quote.send_blocked;
                if reopened {
                    crate::display::send::CARRIER_UNBLOCKED.notify_one();
                }
            }
        }
    })
    .abort_handle()
}

/// Wake the display owner when this tunnel's own connection reopens: a probe
/// timeout had expired with its window full, and an acknowledgment arrived.
/// Returns the connection's blocked state as the driver republishes it. The
/// watcher holds no connection handle; it ends with the connection's state.
fn spawn_unblock_watcher(conn: &Connection) -> (watch::Receiver<bool>, AbortHandle) {
    let blocked = conn.quic_connection().send_blocked();
    let mut watched = blocked.clone();
    let task = tokio::spawn(async move {
        while watched.changed().await.is_ok() {
            if !*watched.borrow_and_update() {
                crate::display::send::CARRIER_UNBLOCKED.notify_one();
            }
        }
    });
    (blocked, task.abort_handle())
}

/// Ask the edge for contention evidence exactly while this process profiles:
/// after the quote stream's preface, one byte per profiling change, the
/// current state first. Off, the edge reads no clock for this session's
/// datagrams and its quotes carry none.
fn spawn_contention_requests(
    mut send: wtransport::SendStream,
    mut profiling: watch::Receiver<bool>,
) -> AbortHandle {
    tokio::spawn(async move {
        loop {
            let enabled = *profiling.borrow_and_update();
            if send.write_all(&[u8::from(enabled)]).await.is_err()
                || profiling.changed().await.is_err()
            {
                break;
            }
        }
        // Dropping the request half would reset the quotes coming back; the
        // tunnel's teardown aborts this task and releases it.
        std::future::pending::<()>().await;
        drop(send);
    })
    .abort_handle()
}

fn clear_delivery_quote(delivery_quote: &Mutex<DeliveryQuoteFence>) {
    let fence = delivery_quote
        .lock()
        .expect("edge delivery-quote fence poisoned");
    let _ = fence.sender.send_replace(None);
}

/// Pairing state of the browser half of this splice, as reported by the edge
/// over the reverse direction of the preface stream.
///
/// A detach is NOT a close. The edge holds the slot half-paired for the window
/// it names, so the daemon keeps this tunnel and stops writing rather than
/// tearing down and redialling — which is what makes a browser reconnect a
/// carrier swap instead of a full session rebuild.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CounterpartState {
    /// Dialed but never paired. Distinct from `Detached` on purpose: a freshly
    /// redialed tunnel has no browser yet, and treating that as "the browser
    /// left" would arm a rebind window against a session that never had one —
    /// with zero time remaining, so the next liveness tick would park a peer
    /// that is simply still connecting.
    Pending,
    Attached {
        attachment_id: u64,
    },
    Detached {
        rebind_window_remaining_ms: u64,
    },
}

/// The proven source address of the browser's signaling attachment, as the
/// edge validated it on that QUIC connection. Signaling tunnels only.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct EdgeBrowserPath {
    pub(crate) attachment_id: u64,
    pub(crate) address: std::net::IpAddr,
}

#[derive(Debug, serde::Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum SpliceDeliveryQuoteEvent {
    CounterpartDeliveryQuote {
        browser_attachment_id: u64,
        rtt_us: u64,
        congestion_window_bytes: u64,
        bytes_in_flight: u64,
        send_buffer_occupied_bytes: u64,
        mtu_bytes: u16,
        pacing_rate_bps: u64,
        sent_packets: u64,
        lost_packets: u64,
        interactive_blocked: u64,
        interactive_paced: u64,
        interactive_waited_us: u64,
        bulk_blocked: u64,
        bulk_paced: u64,
        bulk_waited_us: u64,
        forward_residence: [u32; EDGE_FORWARD_RESIDENCE_BUCKETS],
        model: Option<crate::perf_timing::PerfEgressModel>,
        pto_count: u32,
        send_blocked: bool,
    },
}

impl SpliceDeliveryQuoteEvent {
    /// The browser generation a quote belongs to, and the quote itself.
    fn downstream_quote(self) -> (u64, EdgeDownstreamDeliveryQuote) {
        let Self::CounterpartDeliveryQuote {
            browser_attachment_id,
            rtt_us,
            congestion_window_bytes,
            bytes_in_flight,
            send_buffer_occupied_bytes,
            mtu_bytes,
            pacing_rate_bps,
            sent_packets,
            lost_packets,
            interactive_blocked,
            interactive_paced,
            interactive_waited_us,
            bulk_blocked,
            bulk_paced,
            bulk_waited_us,
            forward_residence,
            model,
            pto_count,
            send_blocked,
        } = self;
        let quote = EdgeDownstreamDeliveryQuote {
            rtt_us,
            congestion_window_bytes,
            bytes_in_flight,
            send_buffer_occupied_bytes,
            mtu_bytes,
            pacing_rate_bps,
            sent_packets,
            lost_packets,
            pto_count,
            send_blocked,
            contention: EdgeContention {
                attachment: browser_attachment_id,
                interactive: EdgeAdmissions {
                    blocked: interactive_blocked,
                    paced: interactive_paced,
                    waited_us: interactive_waited_us,
                },
                bulk: EdgeAdmissions {
                    blocked: bulk_blocked,
                    paced: bulk_paced,
                    waited_us: bulk_waited_us,
                },
                forward_residence,
                model,
            },
        };
        (browser_attachment_id, quote)
    }
}

/// The pairing fact a splice event carries for this daemon tunnel, if any.
/// Relay state, paths and the client-only events carry none.
fn counterpart_state(event: SpliceControlEvent) -> Option<(CounterpartState, u64)> {
    match event {
        // Arriving alone is `Pending`, never `Detached`. A detach arms the
        // rebind window, and a window armed on a tunnel that never had a
        // browser is satisfied by nothing — the next liveness tick converts
        // it straight into a park. "Nobody here yet" and "my peer left" are
        // different facts and only one of them is a carrier gap.
        SpliceControlEvent::CounterpartPresent {
            present,
            counterpart_attachment_id,
        } => match (present, counterpart_attachment_id) {
            (true, Some(attachment_id)) if attachment_id != 0 => {
                Some((CounterpartState::Attached { attachment_id }, attachment_id))
            }
            (false, None) => Some((CounterpartState::Pending, 0)),
            _ => None,
        },
        SpliceControlEvent::CounterpartAttached {
            counterpart_attachment_id,
        } if counterpart_attachment_id != 0 => Some((
            CounterpartState::Attached {
                attachment_id: counterpart_attachment_id,
            },
            counterpart_attachment_id,
        )),
        SpliceControlEvent::CounterpartDetached {
            counterpart_attachment_id,
            rebind_window_remaining_ms,
        } if counterpart_attachment_id != 0 => Some((
            CounterpartState::Detached {
                rebind_window_remaining_ms,
            },
            0,
        )),
        _ => None,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct EdgeDownstreamDeliveryQuote {
    pub rtt_us: u64,
    pub congestion_window_bytes: u64,
    pub bytes_in_flight: u64,
    pub send_buffer_occupied_bytes: u64,
    pub mtu_bytes: u16,
    pub pacing_rate_bps: u64,
    pub sent_packets: u64,
    pub lost_packets: u64,
    /// Probe timeouts expired since the browser leg's last acknowledgment.
    pub pto_count: u32,
    /// Only probes may leave the browser leg: a probe timeout expired with no
    /// acknowledgment since and its window admits no packet. The relay
    /// publishes each change of this at once.
    pub send_blocked: bool,
    /// Diagnostic only: where this browser's packets waited at the relay.
    pub contention: EdgeContention,
}

/// Datagram residence buckets in the edge's quote. A wire fact mirrored from
/// `FORWARD_RESIDENCE_BUCKETS` in `apps/edge/src/splice.rs`.
pub(crate) const EDGE_FORWARD_RESIDENCE_BUCKETS: usize = 12;

/// The edge's cumulative contention evidence for one browser attachment: its
/// aggregate packet group's refusals by traffic class, and log2 microsecond
/// buckets of daemon-to-browser datagram residence at the relay. The edge
/// reports it only while this daemon profiles; see `write_contention_requests`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct EdgeContention {
    /// The browser attachment these counters belong to: they start at zero
    /// with it and accumulate only within it.
    pub attachment: u64,
    pub interactive: EdgeAdmissions,
    pub bulk: EdgeAdmissions,
    pub forward_residence: [u32; EDGE_FORWARD_RESIDENCE_BUCKETS],
    pub model: Option<crate::perf_timing::PerfEgressModel>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct EdgeAdmissions {
    pub blocked: u64,
    pub paced: u64,
    pub waited_us: u64,
}

struct DeliveryQuoteFence {
    browser_attachment_id: u64,
    sender: watch::Sender<Option<EdgeDownstreamDeliveryQuote>>,
}

impl DeliveryQuoteFence {
    fn change_browser_attachment(&mut self, browser_attachment_id: u64) {
        self.browser_attachment_id = browser_attachment_id;
        let _ = self.sender.send_replace(None);
    }

    fn publish_if_current(
        &self,
        browser_attachment_id: u64,
        quote: EdgeDownstreamDeliveryQuote,
    ) -> bool {
        if browser_attachment_id == 0 || self.browser_attachment_id != browser_attachment_id {
            return false;
        }
        let _ = self.sender.send_replace(Some(quote));
        true
    }
}

pub struct EdgeTunnel {
    lane: EdgeLane,
    browser_hello: Mutex<Option<DataHandshakeGeneration>>,
    /// The live WebTransport connection. Always `Some` in production; `None` only
    /// for the test-capture tunnel (which has no socket and observes sends via
    /// `capture`).
    conn: Option<Arc<Connection>>,
    /// The endpoint owning this tunnel's UDP socket, retained solely so the
    /// socket can be replaced under the live connection when the host's network
    /// path changes (`rebind_local_socket`). Dropping it would still leave the
    /// connection working — quinn's driver outlives the handle — but would make
    /// a path change unrecoverable except by a full redial.
    endpoint: Option<Endpoint<endpoint_side::Client>>,
    /// One bounded queue per persistent logical channel. A shared slot semaphore
    /// and byte counter preserve the old connection-wide bounds across them.
    reliable_senders: Option<ReliableSenders>,
    reliable_queued_bytes: Arc<AtomicUsize>,
    reliable_queued_slots: Arc<Semaphore>,
    /// First typed send/receive failure for this exact connection generation.
    /// The winner publishes before closing `conn`; counterpart detach still has
    /// precedence when `closed_reason` classifies the connection close.
    reliable_failure_tx: Option<watch::Sender<Option<EdgeReliableLaneFailure>>>,
    reliable_failure_rx: Option<watch::Receiver<Option<EdgeReliableLaneFailure>>>,
    /// Cancellation handle for the generation-owned per-channel writer tree.
    reliable_writer_abort: Option<AbortHandle>,
    /// Installed when `spawn_receivers` binds the generation-owned acceptor and
    /// its per-channel readers. Setup/teardown only; never touched per frame.
    reliable_receiver_abort: Mutex<Option<AbortHandle>>,
    /// Suppresses a synthetic lane failure when the owner deliberately closes.
    closing: Arc<AtomicBool>,
    /// Latest browser pairing state. A latest-value cell rather than a queue on
    /// purpose: the owner loop reconciles against it on every liveness tick, so
    /// a dropped notification degrades to a late transition instead of a peer
    /// stuck in a window nobody disarms.
    counterpart: watch::Receiver<CounterpartState>,
    relay_data_paused: watch::Sender<Option<bool>>,
    /// Latest proven address of the browser's signaling attachment, which the
    /// edge reports on signaling tunnels. A latest-value cell like
    /// `counterpart`: it exists before the peer authenticates, so an address
    /// that arrives first is read when authentication completes.
    browser_path: watch::Receiver<Option<EdgeBrowserPath>>,
    /// Test-only sender for `browser_path`, standing in for the edge's reports.
    #[cfg(test)]
    browser_path_control: Option<watch::Sender<Option<EdgeBrowserPath>>>,
    /// Latest edge-to-browser QUIC scheduling state reported by the blind edge.
    downstream_delivery_quote: watch::Receiver<Option<EdgeDownstreamDeliveryQuote>>,
    /// Whether only probes may leave this tunnel's own connection, as its
    /// driver republishes it on each change.
    upstream_blocked: watch::Receiver<bool>,
    /// Cancellation handle for the task that wakes the display owner when
    /// this connection reopens.
    unblock_watcher_abort: Option<AbortHandle>,
    /// Test-only senders for the two blocked states a capture tunnel models.
    #[cfg(test)]
    blocked_controls: Option<BlockedControls>,
    /// True while the browser half is absent. Read on the reliable admission
    /// path, so it is an atomic rather than a watch borrow.
    counterpart_absent: Arc<AtomicBool>,
    /// Cancellation handles for the independent lifecycle and advisory quote
    /// reader tasks owned by this carrier generation, and for the writer of
    /// its contention requests, which owns the quote stream's request half.
    lifecycle_reader_abort: Option<AbortHandle>,
    delivery_quote_reader_abort: Option<AbortHandle>,
    contention_requests_abort: Option<AbortHandle>,
    /// Keep the request direction of the lifecycle stream alive. WTransport
    /// resets the whole WebTransport stream when a send half is dropped without
    /// an acknowledged finish; the edge intentionally stops reading after the
    /// fixed preface, so a graceful FIN races STOP_SENDING.
    control_request_sender: Mutex<Option<wtransport::SendStream>>,
    /// Test-only capture of reliable-lane sends, so signaling-flow unit tests can
    /// observe channel-0x00 frames without a real edge connection. `None` in
    /// production (the field is compiled out entirely in non-test builds).
    #[cfg(test)]
    capture: Option<mpsc::UnboundedSender<(u8, Vec<u8>)>>,
    #[cfg(test)]
    capture_reliable_remaining: AtomicUsize,
}

/// What a capture tunnel's tests drive in place of a connection and an edge.
#[cfg(test)]
struct BlockedControls {
    upstream: watch::Sender<bool>,
    downstream: watch::Sender<Option<EdgeDownstreamDeliveryQuote>>,
}

#[derive(Debug)]
struct ReliableLaneTaskError {
    failure: EdgeReliableLaneFailure,
    detail: String,
}

impl ReliableLaneTaskError {
    fn new(
        direction: EdgeReliableLaneDirection,
        channel_id: Option<u8>,
        operation: EdgeReliableLaneOperation,
        kind: EdgeReliableLaneFailureKind,
        detail: String,
    ) -> Self {
        Self {
            failure: EdgeReliableLaneFailure {
                direction,
                channel_id,
                operation,
                kind,
            },
            detail,
        }
    }

    fn writer_timed_out(channel_id: u8, operation: EdgeReliableLaneOperation) -> Self {
        Self::new(
            EdgeReliableLaneDirection::Send,
            Some(channel_id),
            operation,
            EdgeReliableLaneFailureKind::TimedOut,
            format!(
                "{operation:?} exceeded the {}ms RTO ceiling",
                EDGE_RELIABLE_OPERATION_TIMEOUT.as_millis()
            ),
        )
    }

    fn writer_transport(
        channel_id: u8,
        operation: EdgeReliableLaneOperation,
        detail: String,
    ) -> Self {
        Self::new(
            EdgeReliableLaneDirection::Send,
            Some(channel_id),
            operation,
            EdgeReliableLaneFailureKind::Transport,
            detail,
        )
    }

    fn worker_terminated(direction: EdgeReliableLaneDirection, error: JoinError) -> Self {
        Self::new(
            direction,
            None,
            EdgeReliableLaneOperation::Write,
            EdgeReliableLaneFailureKind::WorkerTerminated,
            error.to_string(),
        )
    }

    fn reader(
        channel_id: Option<u8>,
        operation: EdgeReliableLaneOperation,
        kind: EdgeReliableLaneFailureKind,
        detail: impl Into<String>,
    ) -> Self {
        Self::new(
            EdgeReliableLaneDirection::Receive,
            channel_id,
            operation,
            kind,
            detail.into(),
        )
    }
}

trait ReliableWriterStream: Send + 'static {
    fn write_all<'a>(
        &'a mut self,
        bytes: &'a [u8],
    ) -> impl Future<Output = Result<(), String>> + Send + 'a;

    /// Write one `[u32 length][payload]` record as a single admission into the
    /// stream: one state lock and one driver wake, and the length never leaves
    /// in a packet of its own. A heap payload moves into the stream uncopied.
    fn write_record<'a>(
        &'a mut self,
        length: [u8; 4],
        payload: &'a mut ReliablePayload,
    ) -> impl Future<Output = Result<(), String>> + Send + 'a;

    fn stopped(&self) -> impl Future<Output = ReliableWriterStop> + Send + 'static;

    /// Declare how this lane competes for the connection's send capacity.
    ///
    /// Set once, before the channel prefix, so the very first record already
    /// carries the class: quinn queues a stream at the priority it held when
    /// its data was queued, so a lane raised after the fact keeps competing at
    /// the old level until that data drains.
    fn set_send_priority(&self, priority: i32);
}

struct ReliableWriterStop {
    kind: EdgeReliableLaneFailureKind,
    detail: String,
}

trait ReliableWriterOpening: Send + 'static {
    type Stream: ReliableWriterStream;

    fn open(self) -> impl Future<Output = Result<Self::Stream, String>> + Send;
}

trait ReliableWriterIo: Send + Sync + 'static {
    type Opening: ReliableWriterOpening;

    fn open_uni(
        &self,
        channel_id: u8,
    ) -> impl Future<Output = Result<Self::Opening, String>> + Send + '_;

    fn close_failed_generation(&self);
}

struct ConnectionReliableWriterIo {
    conn: Arc<Connection>,
}

#[expect(
    clippy::manual_async_fn,
    reason = "a trait `async fn` cannot state the Send bound the spawned supervisor needs"
)]
impl ReliableWriterStream for wtransport::SendStream {
    fn set_send_priority(&self, priority: i32) {
        wtransport::SendStream::set_priority(self, priority);
    }

    fn write_all<'a>(
        &'a mut self,
        bytes: &'a [u8],
    ) -> impl Future<Output = Result<(), String>> + Send + 'a {
        async move {
            self.write_all(bytes)
                .await
                .map_err(|error| error.to_string())
        }
    }

    fn write_record<'a>(
        &'a mut self,
        length: [u8; 4],
        payload: &'a mut ReliablePayload,
    ) -> impl Future<Output = Result<(), String>> + Send + 'a {
        async move {
            match payload {
                ReliablePayload::Inline { len, bytes } => {
                    let len = usize::from(*len);
                    let mut record = [0; 4 + crate::network::peer::INLINE_RELIABLE_PAYLOAD_BYTES];
                    record[..4].copy_from_slice(&length);
                    record[4..4 + len].copy_from_slice(&bytes[..len]);
                    self.write_all(&record[..4 + len])
                        .await
                        .map_err(|error| error.to_string())
                }
                ReliablePayload::Heap(body) => self
                    .quic_stream_mut()
                    .write_all_chunks(&mut [
                        bytes::Bytes::copy_from_slice(&length),
                        bytes::Bytes::from(std::mem::take(body)),
                    ])
                    .await
                    .map_err(|error| error.to_string()),
            }
        }
    }

    fn stopped(&self) -> impl Future<Output = ReliableWriterStop> + Send + 'static {
        // Quinn's future owns the connection handle and stream ID. Construct it
        // once per persistent lane so record boundaries do not repeatedly lock
        // the connection state, look up the stream, and clone its notification.
        let stopped = self.quic_stream().stopped();
        async move {
            match stopped.await {
                Ok(Some(code)) => ReliableWriterStop {
                    kind: EdgeReliableLaneFailureKind::Reset,
                    detail: format!("stream stopped (code: {code})"),
                },
                Ok(None) => ReliableWriterStop {
                    kind: EdgeReliableLaneFailureKind::Finished,
                    detail: "stream closed".to_string(),
                },
                Err(wtransport::quinn::StoppedError::ConnectionLost(error)) => ReliableWriterStop {
                    kind: EdgeReliableLaneFailureKind::Transport,
                    detail: error.to_string(),
                },
                Err(wtransport::quinn::StoppedError::ZeroRttRejected) => ReliableWriterStop {
                    kind: EdgeReliableLaneFailureKind::Transport,
                    detail: "0-RTT rejected".to_string(),
                },
            }
        }
    }
}

#[expect(
    clippy::manual_async_fn,
    reason = "a trait `async fn` cannot state the Send bound the spawned supervisor needs"
)]
impl ReliableWriterOpening for wtransport::stream::OpeningUniStream {
    type Stream = wtransport::SendStream;

    fn open(self) -> impl Future<Output = Result<Self::Stream, String>> + Send {
        async move { self.await.map_err(|error| error.to_string()) }
    }
}

#[expect(
    clippy::manual_async_fn,
    reason = "a trait `async fn` cannot state the Send bound the spawned supervisor needs"
)]
impl ReliableWriterIo for ConnectionReliableWriterIo {
    type Opening = wtransport::stream::OpeningUniStream;

    fn open_uni(
        &self,
        _channel_id: u8,
    ) -> impl Future<Output = Result<Self::Opening, String>> + Send + '_ {
        async move {
            self.conn
                .open_uni()
                .await
                .map_err(|error| error.to_string())
        }
    }

    fn close_failed_generation(&self) {
        self.conn.close(
            wtransport::VarInt::from_u32(RELIABLE_LANE_FAILED_CLOSE_CODE),
            RELIABLE_LANE_FAILED_CLOSE_REASON,
        );
    }
}

async fn await_operation<T>(
    channel_id: u8,
    operation: EdgeReliableLaneOperation,
    future: impl Future<Output = Result<T, String>>,
) -> Result<T, ReliableLaneTaskError> {
    // `timeout` polls the operation first, so one that completes at once never
    // registers its timer with the driver.
    tokio::time::timeout(EDGE_RELIABLE_OPERATION_TIMEOUT, future)
        .await
        .map_err(|_| ReliableLaneTaskError::writer_timed_out(channel_id, operation))?
        .map_err(|detail| ReliableLaneTaskError::writer_transport(channel_id, operation, detail))
}

async fn run_reliable_channel_writer<I>(
    io: &I,
    channel_id: u8,
    mut rx: mpsc::Receiver<ReliableFrame>,
) -> Result<(), ReliableLaneTaskError>
where
    I: ReliableWriterIo,
{
    let Some(first) = rx.recv().await else {
        return Ok(());
    };
    let opening = await_operation(
        channel_id,
        EdgeReliableLaneOperation::OpenUni,
        io.open_uni(channel_id),
    )
    .await?;
    let mut send =
        await_operation(channel_id, EdgeReliableLaneOperation::Open, opening.open()).await?;
    // Before the prefix: this stream's first bytes must already compete at its
    // own class rather than inherit the default and be re-levelled later.
    send.set_send_priority(crate::network::protocol::reliable_stream_priority(
        channel_id,
    ));
    await_operation(
        channel_id,
        EdgeReliableLaneOperation::Bind,
        send.write_all(&[channel_id]),
    )
    .await?;
    let stopped = send.stopped();
    tokio::pin!(stopped);

    let mut next = Some(first);
    while let Some(mut frame) = next.take() {
        let bytes = frame.payload.as_slice().len();
        let length = u32::try_from(bytes)
            .expect("reliable admission rejects payloads that do not fit u32")
            .to_be_bytes();
        await_operation(
            channel_id,
            EdgeReliableLaneOperation::Write,
            send.write_record(length, &mut frame.payload),
        )
        .await?;
        trace!(channel_id, bytes, "edge persistent reliable record written");
        next = tokio::select! {
            biased;
            stopped = &mut stopped => {
                return Err(ReliableLaneTaskError::new(
                    EdgeReliableLaneDirection::Send,
                    Some(channel_id),
                    EdgeReliableLaneOperation::Stopped,
                    stopped.kind,
                    stopped.detail,
                ));
            }
            frame = rx.recv() => frame,
        };
    }
    Ok(())
}

async fn run_reliable_writer<I>(
    io: Arc<I>,
    receivers: ReliableReceivers,
) -> Result<(), ReliableLaneTaskError>
where
    I: ReliableWriterIo,
{
    let mut lanes = JoinSet::new();
    for (channel_id, rx) in receivers {
        let io = Arc::clone(&io);
        lanes.spawn(async move {
            (
                channel_id,
                run_reliable_channel_writer(io.as_ref(), channel_id, rx).await,
            )
        });
    }

    while let Some(completion) = lanes.join_next().await {
        match completion {
            Ok((_channel_id, Ok(()))) => {}
            Ok((_channel_id, Err(error))) => {
                lanes.shutdown().await;
                return Err(error);
            }
            Err(error) => {
                lanes.shutdown().await;
                return Err(ReliableLaneTaskError::worker_terminated(
                    EdgeReliableLaneDirection::Send,
                    error,
                ));
            }
        }
    }
    Ok(())
}

fn publish_reliable_failure(
    failure_tx: &watch::Sender<Option<EdgeReliableLaneFailure>>,
    closing: &AtomicBool,
    failure: EdgeReliableLaneFailure,
) -> bool {
    // This transition is also the reliable-admission fence. The failure owner
    // publishes its typed cause and closes the transport only after future
    // sends are guaranteed to reject this generation.
    if closing
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return false;
    }
    failure_tx.send_if_modified(|current| {
        if current.is_some() {
            false
        } else {
            *current = Some(failure);
            true
        }
    })
}

fn spawn_reliable_writer_io<I>(
    io: I,
    receivers: ReliableReceivers,
    lane: String,
    failure_tx: watch::Sender<Option<EdgeReliableLaneFailure>>,
    closing: Arc<AtomicBool>,
) -> AbortHandle
where
    I: ReliableWriterIo,
{
    let io = Arc::new(io);
    let task_io = Arc::clone(&io);
    let task = tokio::spawn(async move {
        if let Err(error) = run_reliable_writer(task_io, receivers).await {
            warn!(
                "edge reliable writer failed (generation closing): lane={lane} channel={:?} operation={:?} kind={:?} err={}",
                error.failure.channel_id, error.failure.operation, error.failure.kind, error.detail,
            );
            if publish_reliable_failure(&failure_tx, &closing, error.failure) {
                io.close_failed_generation();
            }
        }
    });
    let abort = task.abort_handle();
    drop(task);
    abort
}

/// Own one persistent uni-stream task per logical reliable channel. Each task
/// opens lazily on its first queued record, so unused channels consume neither
/// stream credit nor a transport allocation.
fn spawn_reliable_writer(
    conn: Arc<Connection>,
    receivers: ReliableReceivers,
    lane: String,
    failure_tx: watch::Sender<Option<EdgeReliableLaneFailure>>,
    closing: Arc<AtomicBool>,
) -> AbortHandle {
    spawn_reliable_writer_io(
        ConnectionReliableWriterIo { conn },
        receivers,
        lane,
        failure_tx,
        closing,
    )
}

fn reader_error_kind(error: &std::io::Error) -> EdgeReliableLaneFailureKind {
    match error.kind() {
        std::io::ErrorKind::UnexpectedEof => EdgeReliableLaneFailureKind::Finished,
        std::io::ErrorKind::ConnectionReset
        | std::io::ErrorKind::ConnectionAborted
        | std::io::ErrorKind::BrokenPipe => EdgeReliableLaneFailureKind::Reset,
        _ => EdgeReliableLaneFailureKind::Transport,
    }
}

fn reader_io_error(
    channel_id: Option<u8>,
    operation: EdgeReliableLaneOperation,
    error: std::io::Error,
) -> ReliableLaneTaskError {
    ReliableLaneTaskError::reader(
        channel_id,
        operation,
        reader_error_kind(&error),
        error.to_string(),
    )
}

fn stream_read_exact_error(
    channel_id: Option<u8>,
    operation: EdgeReliableLaneOperation,
    error: StreamReadExactError,
) -> ReliableLaneTaskError {
    let kind = match &error {
        StreamReadExactError::FinishedEarly(_) => EdgeReliableLaneFailureKind::Finished,
        StreamReadExactError::Read(StreamReadError::Reset(_)) => EdgeReliableLaneFailureKind::Reset,
        StreamReadExactError::Read(StreamReadError::NotConnected | StreamReadError::QuicProto) => {
            EdgeReliableLaneFailureKind::Transport
        }
    };
    ReliableLaneTaskError::reader(channel_id, operation, kind, error.to_string())
}

async fn read_started_reliable_record<R>(
    recv: &mut R,
    channel_id: u8,
    first_header_byte: u8,
) -> Result<Vec<u8>, ReliableLaneTaskError>
where
    R: AsyncRead + Unpin,
{
    let deadline = tokio::time::Instant::now() + INBOUND_RELIABLE_PARTIAL_TIMEOUT;
    let timed_out = |operation| {
        ReliableLaneTaskError::reader(
            Some(channel_id),
            operation,
            EdgeReliableLaneFailureKind::TimedOut,
            format!(
                "partial reliable record exceeded {}ms",
                INBOUND_RELIABLE_PARTIAL_TIMEOUT.as_millis()
            ),
        )
    };

    let mut header = [0_u8; size_of::<u32>()];
    header[0] = first_header_byte;
    tokio::time::timeout_at(deadline, recv.read_exact(&mut header[1..]))
        .await
        .map_err(|_| timed_out(EdgeReliableLaneOperation::ReadHeader))?
        .map_err(|error| {
            reader_io_error(
                Some(channel_id),
                EdgeReliableLaneOperation::ReadHeader,
                error,
            )
        })?;
    let payload_len = u32::from_be_bytes(header) as usize;
    if payload_len > MAX_INBOUND_FRAME_BYTES {
        return Err(ReliableLaneTaskError::reader(
            Some(channel_id),
            EdgeReliableLaneOperation::ReadHeader,
            EdgeReliableLaneFailureKind::Malformed,
            format!("reliable payload length {payload_len} exceeds ingress bound"),
        ));
    }

    let mut payload = Vec::new();
    payload.try_reserve_exact(payload_len).map_err(|error| {
        ReliableLaneTaskError::reader(
            Some(channel_id),
            EdgeReliableLaneOperation::ReadPayload,
            EdgeReliableLaneFailureKind::Allocation,
            error.to_string(),
        )
    })?;
    // Initialize the final payload allocation directly from QUIC. Resizing to
    // `payload_len` here would zero every byte immediately before the network
    // overwrites it, which is measurable for jumbo reliable records.
    let read_payload = async {
        while payload.len() < payload_len {
            let remaining = payload_len - payload.len();
            let mut limited = (&mut *recv).take(remaining as u64);
            if limited.read_buf(&mut payload).await? == 0 {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    format!(
                        "persistent reliable lane finished after {} of {payload_len} payload bytes",
                        payload.len()
                    ),
                ));
            }
        }
        Ok::<(), std::io::Error>(())
    };
    tokio::time::timeout_at(deadline, read_payload)
        .await
        .map_err(|_| timed_out(EdgeReliableLaneOperation::ReadPayload))?
        .map_err(|error| {
            reader_io_error(
                Some(channel_id),
                EdgeReliableLaneOperation::ReadPayload,
                error,
            )
        })?;
    Ok(payload)
}

async fn run_reliable_reader<R>(
    mut recv: R,
    channel_id: u8,
    ingress: EdgeIngress,
) -> Result<(), ReliableLaneTaskError>
where
    R: AsyncRead + Unpin,
{
    let input_credit = (channel_id == CHANNEL_PTY).then(|| Arc::new(Semaphore::new(1)));
    loop {
        // Wait at a record boundary, outside the partial-record deadline.
        let input_permit = match &input_credit {
            Some(credit) => Some(Arc::clone(credit).acquire_owned().await.map_err(|_| {
                ReliableLaneTaskError::reader(
                    Some(channel_id),
                    EdgeReliableLaneOperation::Enqueue,
                    EdgeReliableLaneFailureKind::ConsumerClosed,
                    "input reader closed",
                )
            })?),
            None => None,
        };
        // No timeout here. An idle persistent channel at a record boundary is
        // healthy; only a record that has started owns the partial-read deadline.
        let mut first_header_byte = [0_u8; 1];
        let read = recv.read(&mut first_header_byte).await.map_err(|error| {
            reader_io_error(
                Some(channel_id),
                EdgeReliableLaneOperation::ReadHeader,
                error,
            )
        })?;
        if read == 0 {
            return Err(ReliableLaneTaskError::reader(
                Some(channel_id),
                EdgeReliableLaneOperation::ReadHeader,
                EdgeReliableLaneFailureKind::Finished,
                "persistent reliable lane finished",
            ));
        }

        let payload =
            read_started_reliable_record(&mut recv, channel_id, first_header_byte[0]).await?;
        // A reliable record waits for the owner's bounded queue, in order. The
        // acceptor aborts this wait when its connection closes or a successor
        // source displaces the reader, so the record never enters after either.
        ingress
            .tx
            .send(ingress.message(
                channel_id,
                // Zero-copy: the exact-size read buffer becomes the frame body.
                bytes::Bytes::from(payload),
                DeliveryMode::Stream,
                input_permit,
            ))
            .await
            .map_err(|_| {
                ReliableLaneTaskError::reader(
                    Some(channel_id),
                    EdgeReliableLaneOperation::Enqueue,
                    EdgeReliableLaneFailureKind::ConsumerClosed,
                    "edge ingress consumer closed",
                )
            })?;
    }
}

async fn read_reliable_channel_preface(
    mut recv: wtransport::RecvStream,
    permit: OwnedSemaphorePermit,
) -> Result<Option<(u64, u8, wtransport::RecvStream, OwnedSemaphorePermit)>, ReliableLaneTaskError>
{
    let mut prefix = [0_u8; 9];
    let result = tokio::time::timeout(
        INBOUND_RELIABLE_PARTIAL_TIMEOUT,
        recv.read_exact(&mut prefix),
    )
    .await
    .map_err(|_| {
        ReliableLaneTaskError::reader(
            None,
            EdgeReliableLaneOperation::ReadChannel,
            EdgeReliableLaneFailureKind::TimedOut,
            "persistent reliable channel preface timed out",
        )
    })?;
    // A FIN before any application byte is the edge's transport-only probe.
    // It claims no logical channel and consumes no session state.
    if matches!(result, Err(StreamReadExactError::FinishedEarly(0))) {
        return Ok(None);
    }
    result.map_err(|error| {
        stream_read_exact_error(None, EdgeReliableLaneOperation::ReadChannel, error)
    })?;
    let generation = u64::from_be_bytes(prefix[..8].try_into().expect("fixed generation prefix"));
    Ok(Some((generation, prefix[8], recv, permit)))
}

/// Free a channel binding so a returning browser can claim it again.
fn release_reliable_channel(seen_channels: &mut u8, channel_id: u8) {
    if let Some(bit) = reliable_channel_bit(channel_id) {
        *seen_channels &= !bit;
    }
}

fn register_reliable_channel(
    seen_channels: &mut u8,
    channel_id: u8,
) -> Result<(), ReliableLaneTaskError> {
    let Some(channel_bit) = reliable_channel_bit(channel_id) else {
        return Err(ReliableLaneTaskError::reader(
            Some(channel_id),
            EdgeReliableLaneOperation::Bind,
            EdgeReliableLaneFailureKind::UnknownChannel,
            format!("unknown persistent reliable channel 0x{channel_id:02x}"),
        ));
    };
    if *seen_channels & channel_bit != 0 {
        return Err(ReliableLaneTaskError::reader(
            Some(channel_id),
            EdgeReliableLaneOperation::Bind,
            EdgeReliableLaneFailureKind::DuplicateChannel,
            format!("duplicate persistent reliable channel 0x{channel_id:02x}"),
        ));
    }
    *seen_channels |= channel_bit;
    Ok(())
}

/// Accept and pump this generation's inbound reliable channels.
///
/// A lane that ends cleanly releases its channel instead of failing the
/// generation, so a returning browser can bind the same channel again. The
/// generation is owned by the QUIC connection; only a connection failure, or a
/// lane fault that indicts the peer's framing, ends it.
async fn run_reliable_acceptor(
    conn: Arc<Connection>,
    ingress: EdgeIngress,
    lane: EdgeLane,
) -> Result<(), ReliableLaneTaskError> {
    let stream_slots = Arc::new(Semaphore::new(MAX_CONCURRENT_INBOUND_RELIABLE));
    let mut binders = JoinSet::new();
    let mut readers: JoinSet<(u8, Result<(), ReliableLaneTaskError>)> = JoinSet::new();
    let mut seen_channels = 0_u8;
    let mut source_generation = 0_u64;

    let result = async {
        loop {
            tokio::select! {
                biased;
                completion = readers.join_next(), if !readers.is_empty() => {
                    match completion {
                        // A reader returning `Ok` rather than a typed
                        // `Finished` reaches the same conclusion: that channel
                        // is free for a replacement stream.
                        Some(Ok((channel_id, Ok(())))) => {
                            release_reliable_channel(&mut seen_channels, channel_id);
                            continue;
                        }
                        Some(Ok((channel_id, Err(error)))) => {
                            // A lane ending cleanly is the edge retiring that
                            // lane, not this connection failing. It happens on
                            // every carrier loss: the browser's source streams
                            // die, the edge's forwarder drops its destination
                            // handle, and this side sees a FIN. Failing the
                            // generation there would close the tunnel being
                            // held open for the browser's return — taking the
                            // rebind's own signaling channel with it, and
                            // forcing a redial at exactly the moment a rebind
                            // is in flight.
                            //
                            // The generation is owned by the QUIC connection,
                            // so a connection failure is still fatal. Anything
                            // that indicts the peer's framing stays fatal too;
                            // only a clean end releases the channel for a
                            // replacement stream to claim.
                            if error.failure.kind == EdgeReliableLaneFailureKind::Finished {
                                release_reliable_channel(&mut seen_channels, channel_id);
                                continue;
                            }
                            return Err(error);
                        }
                        Some(Err(error)) => {
                            return Err(ReliableLaneTaskError::worker_terminated(
                                EdgeReliableLaneDirection::Receive,
                                error,
                            ));
                        }
                        None => {}
                    }
                }
                completion = binders.join_next(), if !binders.is_empty() => {
                    match completion {
                        Some(Ok(Ok(Some((generation, channel_id, recv, permit))))) => {
                            if generation < source_generation || generation == 0 {
                                continue;
                            }
                            if generation > source_generation {
                                // Discard displaced readers, including a partial
                                // record or an input reader waiting on credit.
                                // A late old-generation prefix cannot reclaim a
                                // channel after this cut.
                                readers.shutdown().await;
                                seen_channels = 0;
                                source_generation = generation;
                            }
                            if !lane.allows_reliable(channel_id) {
                                return Err(ReliableLaneTaskError::reader(
                                    Some(channel_id), EdgeReliableLaneOperation::ReadChannel,
                                    EdgeReliableLaneFailureKind::UnknownChannel,
                                    "channel forbidden on this edge connection",
                                ));
                            }
                            register_reliable_channel(&mut seen_channels, channel_id)?;
                            let ingress = ingress.clone();
                            readers.spawn(async move {
                                let _permit = permit;
                                (channel_id, run_reliable_reader(recv, channel_id, ingress).await)
                            });
                        }
                        Some(Ok(Ok(None))) => {},
                        Some(Ok(Err(error))) => return Err(error),
                        Some(Err(error)) => {
                            return Err(ReliableLaneTaskError::worker_terminated(
                                EdgeReliableLaneDirection::Receive,
                                error,
                            ));
                        }
                        None => {}
                    }
                }
                accepted = async {
                    let permit = Arc::clone(&stream_slots).acquire_owned().await.map_err(|_| {
                        ReliableLaneTaskError::reader(
                            None,
                            EdgeReliableLaneOperation::AcceptUni,
                            EdgeReliableLaneFailureKind::ConsumerClosed,
                            "persistent reliable stream admission closed",
                        )
                    })?;
                    let recv = conn.accept_uni().await.map_err(|error| {
                        ReliableLaneTaskError::reader(
                            None,
                            EdgeReliableLaneOperation::AcceptUni,
                            EdgeReliableLaneFailureKind::Transport,
                            error.to_string(),
                        )
                    })?;
                    Ok::<_, ReliableLaneTaskError>((recv, permit))
                } => {
                    let (recv, permit) = accepted?;
                    binders.spawn(read_reliable_channel_preface(recv, permit));
                }
            }
        }
    }
    .await;

    binders.shutdown().await;
    readers.shutdown().await;
    result
}

fn spawn_reliable_receivers(
    conn: Arc<Connection>,
    ingress: EdgeIngress,
    failure_tx: watch::Sender<Option<EdgeReliableLaneFailure>>,
    closing: Arc<AtomicBool>,
    lane: EdgeLane,
) -> AbortHandle {
    let task_conn = Arc::clone(&conn);
    let task = tokio::spawn(async move {
        if let Err(error) = run_reliable_acceptor(task_conn, ingress, lane).await {
            warn!(
                channel = ?error.failure.channel_id,
                operation = ?error.failure.operation,
                kind = ?error.failure.kind,
                detail = %error.detail,
                "edge reliable receiver failed (generation closing)"
            );
            if publish_reliable_failure(&failure_tx, &closing, error.failure) {
                conn.close(
                    wtransport::VarInt::from_u32(RELIABLE_LANE_FAILED_CLOSE_CODE),
                    RELIABLE_LANE_FAILED_CLOSE_REASON,
                );
            }
        }
    });
    let abort = task.abort_handle();
    drop(task);
    abort
}

impl EdgeTunnel {
    /// Current reliable-lane queue depth in bytes. One `Relaxed` load of a
    /// counter the reliable writer already maintains.
    pub(crate) fn reliable_queued_bytes(&self) -> usize {
        self.reliable_queued_bytes.load(Ordering::Relaxed)
    }

    /// This tunnel's delivery view: lock-free, as of its connection's most
    /// recent change, with datagram room net of the H3 header.
    pub(crate) fn quic_delivery_state(&self) -> Option<wtransport::quinn::DeliveryState> {
        Some(self.conn.as_ref()?.delivery_state())
    }

    /// The full statistics report, under the connection's state lock: for cold
    /// telemetry, never a flush.
    /// The connection's `stable_id` with its statistics, so a reader can tell
    /// a replaced connection's counters from the one it read before.
    pub(crate) fn quic_stats(&self) -> Option<(usize, wtransport::quinn::ConnectionStats)> {
        let quic = self.conn.as_ref()?.quic_connection();
        Some((quic.stable_id(), quic.stats()))
    }

    pub(crate) fn downstream_delivery_quote(&self) -> Option<EdgeDownstreamDeliveryQuote> {
        *self.downstream_delivery_quote.borrow()
    }

    /// Refusals of the aggregate packet group admitting this carrier's
    /// packets; `None` until image work activates one.
    pub(crate) fn egress_stats(&self) -> Option<wtransport::quinn::EgressStats> {
        self.conn
            .as_ref()?
            .quic_connection()
            .egress_group()
            .map(|group| group.stats())
    }

    /// Whether only probes may leave either hop of this carrier: this tunnel's
    /// own connection, or the browser leg the edge last quoted. A carrier that
    /// stops delivering stays open; the planner routes around it until the
    /// acknowledgment that reopens it, and a replacement or the peer's close
    /// ends it.
    pub(crate) fn send_blocked(&self) -> bool {
        *self.upstream_blocked.borrow()
            || self
                .downstream_delivery_quote
                .borrow()
                .is_some_and(|quote| quote.send_blocked)
    }

    /// Dial the edge, pin its cert via `serverCertificateHashes`, and send the
    /// daemon-role routing preface for `session_id`. The connection joins
    /// `probe_group`, which holds the peer's other tunnels to the same edge.
    pub async fn connect(
        url: &str,
        cert_hashes: &[[u8; 32]],
        session_id: &str,
        lane: EdgeLane,
        probe_group: &wtransport::quinn::ProbeGroup,
        credential: &EdgeCredential,
    ) -> Result<Self, String> {
        let mut config = ClientConfig::builder()
            .with_bind_default()
            .with_server_certificate_hashes(cert_hashes.iter().copied().map(Sha256Digest::new))
            .build();
        // Tuned initial_rtt/ack-frequency/keep-alive/datagram buffers (this
        // tunnel had NO transport config at all — quinn's defaults, including a
        // 333 ms initial_rtt, on the lossy edge path). The congestion
        // controller is deliberately left alone: Cubic is what
        // `tuned_quic_transport_config` uses everywhere, because BBR measured
        // as perceptible typing lag. Set post-build to keep the
        // cert-hash-pinned TLS.
        let mut transport = crate::webtransport::tuned_quic_transport_config();
        if lane == EdgeLane::Signaling {
            // The owner heartbeat supplies PING, not another keepalive timer.
            transport.keep_alive_interval(None);
        }
        config
            .quic_config_mut()
            .transport_config(Arc::new(transport));
        let endpoint =
            Endpoint::client(config).map_err(|e| format!("edge client endpoint: {e}"))?;
        let conn = endpoint
            .connect(url)
            .await
            .map_err(|e| format!("edge connect: {e}"))?;
        // A packet one tunnel hears from the edge reopens the others at once,
        // and a verified reset of one makes the others verify their own state.
        conn.quic_connection()
            .join_probe_group(probe_group)
            .map_err(|e| format!("edge probe group: {e}"))?;

        let (mut send, control_recv) = conn
            .open_bi()
            .await
            .map_err(|e| format!("edge preface open_bi: {e}"))?
            .await
            .map_err(|e| format!("edge preface open_bi await: {e}"))?;
        send.write_all(&build_preface(session_id, credential))
            .await
            .map_err(|e| format!("edge preface write: {e}"))?;

        let (mut quote_send, quote_recv) = conn
            .open_bi()
            .await
            .map_err(|e| format!("edge delivery-quote open_bi: {e}"))?
            .await
            .map_err(|e| format!("edge delivery-quote open_bi await: {e}"))?;
        quote_send
            .write_all(DELIVERY_QUOTE_STREAM_PREFACE)
            .await
            .map_err(|e| format!("edge delivery-quote preface write: {e}"))?;

        let conn = Arc::new(conn);
        let (reliable_senders, reliable_receivers) = reliable_channel_queues();
        let reliable_queued_bytes = Arc::new(AtomicUsize::new(0));
        let reliable_queued_slots = Arc::new(Semaphore::new(EDGE_RELIABLE_QUEUE_CAP));
        let (reliable_failure_tx, reliable_failure_rx) = watch::channel(None);
        let closing = Arc::new(AtomicBool::new(false));
        // The browser has not attached yet at dial time. Starting Attached
        // would let the first display flush race ahead of the splice.
        let (counterpart_tx, counterpart_rx) = watch::channel(CounterpartState::Pending);
        let (delivery_quote_tx, downstream_delivery_quote) = watch::channel(None);
        let delivery_quote_fence = Arc::new(Mutex::new(DeliveryQuoteFence {
            browser_attachment_id: 0,
            sender: delivery_quote_tx,
        }));
        let counterpart_absent = Arc::new(AtomicBool::new(true));
        let (relay_data_paused, _) = watch::channel(None);
        let (browser_path_tx, browser_path) = watch::channel(None);
        let lifecycle_reader_abort = spawn_lifecycle_reader(
            control_recv,
            counterpart_tx,
            relay_data_paused.clone(),
            browser_path_tx,
            Arc::clone(&delivery_quote_fence),
            Arc::clone(&counterpart_absent),
            session_id.to_string(),
        );
        let delivery_quote_reader_abort =
            spawn_delivery_quote_reader(quote_recv, delivery_quote_fence, session_id.to_string());
        let contention_requests_abort =
            spawn_contention_requests(quote_send, crate::perf_timing::profiling());
        let reliable_writer_abort = spawn_reliable_writer(
            conn.clone(),
            reliable_receivers,
            session_id.to_string(),
            reliable_failure_tx.clone(),
            Arc::clone(&closing),
        );
        let (upstream_blocked, unblock_watcher_abort) = spawn_unblock_watcher(&conn);

        Ok(Self {
            lane,
            browser_hello: Mutex::new(None),
            conn: Some(conn),
            endpoint: Some(endpoint),
            reliable_senders: Some(reliable_senders),
            reliable_queued_bytes,
            reliable_queued_slots,
            reliable_failure_tx: Some(reliable_failure_tx),
            reliable_failure_rx: Some(reliable_failure_rx),
            reliable_writer_abort: Some(reliable_writer_abort),
            reliable_receiver_abort: Mutex::new(None),
            closing,
            counterpart: counterpart_rx,
            relay_data_paused,
            browser_path,
            #[cfg(test)]
            browser_path_control: None,
            downstream_delivery_quote,
            upstream_blocked,
            unblock_watcher_abort: Some(unblock_watcher_abort),
            #[cfg(test)]
            blocked_controls: None,
            counterpart_absent,
            lifecycle_reader_abort: Some(lifecycle_reader_abort),
            delivery_quote_reader_abort: Some(delivery_quote_reader_abort),
            contention_requests_abort: Some(contention_requests_abort),
            control_request_sender: Mutex::new(Some(send)),
            #[cfg(test)]
            capture: None,
            #[cfg(test)]
            capture_reliable_remaining: AtomicUsize::new(usize::MAX),
        })
    }

    /// Latest browser pairing state reported by the edge.
    pub fn counterpart_state(&self) -> CounterpartState {
        *self.counterpart.borrow()
    }

    pub(crate) fn relay_data_changes(&self) -> watch::Receiver<Option<bool>> {
        self.relay_data_paused.subscribe()
    }

    pub(crate) fn note_relay_data_paused(&self) {
        self.relay_data_paused.send_replace(Some(true));
    }

    pub(crate) fn relay_data_is_paused(&self) -> bool {
        *self.relay_data_paused.borrow() == Some(true)
            && !self.closing.load(Ordering::Acquire)
            && self
                .conn
                .as_ref()
                .is_none_or(|conn| conn.quic_connection().close_reason().is_none())
            && matches!(self.counterpart_state(), CounterpartState::Attached { .. })
    }

    pub(crate) fn counterpart_changes(&self) -> watch::Receiver<CounterpartState> {
        self.counterpart.clone()
    }

    /// The proven address of the browser attachment now paired with this
    /// signaling tunnel, or `None` while the edge has reported none for it. A
    /// report for an attachment that is no longer the paired one is not it.
    pub(crate) fn browser_address(&self) -> Option<std::net::IpAddr> {
        let path = (*self.browser_path.borrow())?;
        let CounterpartState::Attached { attachment_id } = self.counterpart_state() else {
            return None;
        };
        (path.attachment_id == attachment_id).then_some(path.address)
    }

    pub(crate) fn browser_path_changes(&self) -> watch::Receiver<Option<EdgeBrowserPath>> {
        self.browser_path.clone()
    }

    pub(crate) fn content_carrier(&self) -> Option<crate::assets::Carrier> {
        if self.lane == EdgeLane::Signaling || self.closing.load(Ordering::Acquire) {
            return None;
        }
        let CounterpartState::Attached { attachment_id } = *self.counterpart.borrow() else {
            return None;
        };
        Some(crate::assets::Carrier {
            connection: Arc::clone(self.conn.as_ref()?),
            counterpart: Some((self.counterpart.clone(), attachment_id)),
        })
    }

    /// Whether a browser half can still pair with this tunnel: it is open and
    /// the edge's pairing reports still reach it. Waiting for a pairing on a
    /// tunnel that cannot pair would never end; its successor's link does.
    pub(crate) fn can_pair(&self) -> bool {
        !self.closing.load(Ordering::Acquire)
            && self.conn.as_ref().is_some_and(|conn| !conn.is_closed())
            && self.counterpart.has_changed().is_ok()
    }

    pub fn observe_browser_hello(&self, nonce: DataHandshakeGeneration) {
        *self
            .browser_hello
            .lock()
            .expect("edge attachment mutex poisoned") = Some(nonce);
    }

    pub fn matches_browser_hello(&self, nonce: Option<DataHandshakeGeneration>) -> bool {
        nonce.is_some()
            && *self
                .browser_hello
                .lock()
                .expect("edge attachment mutex poisoned")
                == nonce
    }

    pub fn heartbeat_signaling(&self) {
        if self.lane == EdgeLane::Signaling
            && let Some(conn) = &self.conn
        {
            conn.quic_connection().ping();
        }
    }

    /// Move this tunnel's live QUIC connection onto a freshly bound local
    /// socket, without redialing.
    ///
    /// Called when the OS reports the host's network path changed. The old
    /// socket is bound to an address the new path may no longer own, so every
    /// packet written to it is lost — but the *connection* is not gone: the edge
    /// still holds its half, the keys are still valid, and the splice is still
    /// seated. Rebinding lets the next packet leave over the new interface, and
    /// the edge (a quinn server, which permits migration by default) answers a
    /// new 4-tuple with RFC 9000 path validation rather than a close.
    ///
    /// A fresh `0.0.0.0:0` dual-stack bind is deliberate: it re-runs source
    /// selection against the *current* routing table rather than reasserting an
    /// address chosen under the old one.
    ///
    /// Returns `false` when there is nothing to rebind (the test-capture
    /// tunnel), so a caller sweeping every peer can treat it as a no-op.
    pub fn rebind_local_socket(&self) -> Result<bool, String> {
        let Some(ref endpoint) = self.endpoint else {
            return Ok(false);
        };
        let socket = std::net::UdpSocket::bind((std::net::Ipv6Addr::UNSPECIFIED, 0))
            .or_else(|_| std::net::UdpSocket::bind((std::net::Ipv4Addr::UNSPECIFIED, 0)))
            .map_err(|e| format!("edge rebind socket: {e}"))?;
        endpoint
            .rebind(socket)
            .map_err(|e| format!("edge rebind: {e}"))?;
        Ok(true)
    }

    /// Build a test-capture tunnel with no real connection: every datagram or
    /// reliable send is delivered to `capture` as `(channel_id, payload)`.
    /// Tests use this to observe exact edge-lane admission without a socket.
    #[cfg(test)]
    pub fn new_capture(capture: mpsc::UnboundedSender<(u8, Vec<u8>)>) -> Self {
        let (upstream, upstream_blocked) = watch::channel(false);
        let (downstream, downstream_delivery_quote) = watch::channel(None);
        let (browser_path_tx, browser_path_rx) = watch::channel(None);
        Self {
            lane: EdgeLane::Interactive,
            browser_hello: Mutex::new(None),
            conn: None,
            endpoint: None,
            reliable_senders: None,
            reliable_queued_bytes: Arc::new(AtomicUsize::new(0)),
            reliable_queued_slots: Arc::new(Semaphore::new(EDGE_RELIABLE_QUEUE_CAP)),
            reliable_failure_tx: None,
            reliable_failure_rx: None,
            reliable_writer_abort: None,
            reliable_receiver_abort: Mutex::new(None),
            closing: Arc::new(AtomicBool::new(false)),
            counterpart: watch::channel(CounterpartState::Attached { attachment_id: 1 }).1,
            relay_data_paused: watch::channel(None).0,
            browser_path: browser_path_rx,
            browser_path_control: Some(browser_path_tx),
            downstream_delivery_quote,
            upstream_blocked,
            unblock_watcher_abort: None,
            blocked_controls: Some(BlockedControls {
                upstream,
                downstream,
            }),
            counterpart_absent: Arc::new(AtomicBool::new(false)),
            lifecycle_reader_abort: None,
            delivery_quote_reader_abort: None,
            contention_requests_abort: None,
            control_request_sender: Mutex::new(None),
            capture: Some(capture),
            capture_reliable_remaining: AtomicUsize::new(usize::MAX),
        }
    }

    /// A tunnel over a live connection whose pairing the test drives through
    /// `counterpart`. Its reliable records queue for the test instead of a writer.
    #[cfg(test)]
    pub(crate) fn new_test_pairing(
        conn: Arc<Connection>,
        lane: EdgeLane,
        counterpart: watch::Receiver<CounterpartState>,
    ) -> (Self, TestReliableLanes) {
        let (reliable_senders, reliable_receivers) = reliable_channel_queues();
        let upstream_blocked = conn.quic_connection().send_blocked();
        let (browser_path_tx, browser_path_rx) = watch::channel(None);
        let tunnel = Self {
            lane,
            browser_hello: Mutex::new(None),
            conn: Some(conn),
            endpoint: None,
            reliable_senders: Some(reliable_senders),
            reliable_queued_bytes: Arc::new(AtomicUsize::new(0)),
            reliable_queued_slots: Arc::new(Semaphore::new(EDGE_RELIABLE_QUEUE_CAP)),
            reliable_failure_tx: None,
            reliable_failure_rx: None,
            reliable_writer_abort: None,
            reliable_receiver_abort: Mutex::new(None),
            closing: Arc::new(AtomicBool::new(false)),
            counterpart,
            relay_data_paused: watch::channel(None).0,
            browser_path: browser_path_rx,
            browser_path_control: Some(browser_path_tx),
            downstream_delivery_quote: watch::channel(None).1,
            upstream_blocked,
            unblock_watcher_abort: None,
            blocked_controls: None,
            counterpart_absent: Arc::new(AtomicBool::new(false)),
            lifecycle_reader_abort: None,
            delivery_quote_reader_abort: None,
            contention_requests_abort: None,
            control_request_sender: Mutex::new(None),
            capture: None,
            capture_reliable_remaining: AtomicUsize::new(usize::MAX),
        };
        (tunnel, TestReliableLanes(reliable_receivers))
    }

    /// Model the edge reporting the browser attachment's proven address.
    #[cfg(test)]
    pub(crate) fn set_browser_path_for_test(&self, path: Option<EdgeBrowserPath>) {
        self.browser_path_control
            .as_ref()
            .expect("a test tunnel")
            .send_replace(path);
    }

    /// Model the capture tunnel's own connection blocking or reopening.
    #[cfg(test)]
    pub(crate) fn set_upstream_blocked_for_test(&self, blocked: bool) {
        self.blocked_controls
            .as_ref()
            .expect("a capture tunnel")
            .upstream
            .send_replace(blocked);
    }

    /// Model the edge quoting the capture tunnel's browser leg.
    #[cfg(test)]
    pub(crate) fn set_downstream_quote_for_test(&self, quote: Option<EdgeDownstreamDeliveryQuote>) {
        self.blocked_controls
            .as_ref()
            .expect("a capture tunnel")
            .downstream
            .send_replace(quote);
    }

    /// Deterministically refuse the reliable suffix after `records` admitted
    /// records, without introducing an await into the production send loop.
    #[cfg(test)]
    pub fn new_capture_with_reliable_limit(
        capture: mpsc::UnboundedSender<(u8, Vec<u8>)>,
        records: usize,
    ) -> Self {
        let tunnel = Self::new_capture(capture);
        tunnel
            .capture_reliable_remaining
            .store(records, Ordering::Relaxed);
        tunnel
    }

    /// Dial immediately, then use bounded full-jitter fallback waits. Returns the
    /// first successful tunnel or the last error after `max_attempts`.
    pub async fn connect_with_backoff(
        url: &str,
        session_id: &str,
        lane: EdgeLane,
        probe_group: &wtransport::quinn::ProbeGroup,
        admission: &EdgeAdmission,
        max_attempts: u32,
    ) -> Result<Self, String> {
        if max_attempts == 0 {
            return Err("edge tunnel requires at least one connection attempt".to_string());
        }
        let mut backoff = EdgeConnectBackoff::new();
        let mut last_err = String::new();
        for attempt in 0..max_attempts {
            // Read per attempt: a lease may have replaced the ticket, or the
            // edge's certificate hashes, during the previous attempt's backoff.
            let Some(credential) = admission.current() else {
                return Err(
                    "edge admission: no attach ticket from the control plane yet".to_string(),
                );
            };
            let Some(pins) = admission.pins(url) else {
                return Err(format!("edge admission: no certificate hashes for {url}"));
            };
            match tokio::time::timeout(
                EDGE_CONNECT_ATTEMPT_TIMEOUT,
                Self::connect(
                    url,
                    &pins,
                    session_id,
                    lane,
                    probe_group,
                    &credential,
                ),
            )
            .await
            {
                Ok(Ok(tunnel)) => return Ok(tunnel),
                Ok(Err(error)) => last_err = error,
                Err(_) => {
                    last_err = format!(
                        "edge connect attempt timed out after {}s",
                        EDGE_CONNECT_ATTEMPT_TIMEOUT.as_secs()
                    );
                }
            }
            if attempt + 1 < max_attempts {
                tokio::time::sleep(backoff.next_delay()).await;
            }
        }
        Err(format!(
            "edge tunnel failed after {max_attempts} attempts: {last_err}"
        ))
    }

    /// Bytes this tunnel's QUIC datagram send buffer can still accept.
    ///
    /// Exact, local, and synchronous application-payload room for one
    /// prospective H3 datagram. The first H3 header and Quinn queue entry are
    /// already charged by WTransport.
    pub fn datagram_send_space(&self) -> usize {
        #[cfg(test)]
        if self.capture.is_some() {
            // Model a real idle connection rather than infinite room: a harness
            // that reports unbounded space never exercises the clipped flush.
            return crate::webtransport::DATAGRAM_SEND_BUFFER_BYTES;
        }
        match self.conn {
            // Nothing is queued on a tunnel that cannot send, so the whole
            // buffer is free; the send itself is what fails.
            None => crate::webtransport::DATAGRAM_SEND_BUFFER_BYTES,
            Some(ref conn) => conn.datagram_send_buffer_space(),
        }
    }

    /// Exact H3-header plus Quinn-entry charge for every datagram after the
    /// first planned against [`Self::datagram_send_space`].
    pub fn datagram_additional_entry_overhead(&self) -> usize {
        self.conn
            .as_ref()
            .map_or(0, |conn| conn.datagram_additional_entry_overhead())
    }

    /// Keep this tunnel's QUIC connection from building packets until the guard
    /// drops, so the datagrams and records admitted meanwhile share packets.
    /// `None` for a tunnel with no connection, whose sends fail anyway.
    pub(crate) fn hold_egress(&self) -> Option<wtransport::quinn::EgressHold> {
        self.conn.as_ref().map(|conn| conn.hold_egress())
    }

    /// Send a datagram whose channel byte is already present. Display and
    /// control datagrams are sealed directly into this immutable owner; direct,
    /// edge and replicas share its ciphertext. WTransport queues its carrier-local prefix separately,
    /// and the pool cannot reuse this storage until all queued owners retire.
    pub fn send_framed_datagram(&self, wire: &bytes::Bytes) -> bool {
        if wire.is_empty()
            || self.closing.load(Ordering::Acquire)
            || self.counterpart_absent.load(Ordering::Acquire)
            || self.lane != EdgeLane::Interactive
            || wire[0] == CHANNEL_SIGNALING
        {
            return false;
        }
        #[cfg(test)]
        if let Some(ref capture) = self.capture {
            let (&channel_id, payload) = wire
                .split_first()
                .expect("non-empty display datagram checked above");
            return capture.send((channel_id, payload.to_vec())).is_ok();
        }
        let Some(ref conn) = self.conn else {
            return false;
        };
        conn.send_datagram_owned(wire.clone()).is_ok()
    }

    /// The same exact lifecycle facts used by reliable admission. Selectors use
    /// this before cloning or sealing for a tunnel whose browser half is gone.
    pub(crate) fn has_reliable_counterpart(&self) -> bool {
        !self.closing.load(Ordering::Acquire)
            && !self.counterpart_absent.load(Ordering::Acquire)
            && self.conn.as_ref().is_none_or(|conn| !conn.is_closed())
    }

    /// Enqueue one owned payload for its persistent reliable channel. The first
    /// accepted payload lazily opens a stream and writes `[channel]`; every
    /// accepted payload then writes `[u32 BE len][payload]` on that same stream.
    ///
    /// Non-blocking: success transfers the allocation to the bounded lane;
    /// rejection returns the exact allocation for immediate direct-carrier
    /// fallback. A later writer failure closes this exact tunnel generation so
    /// the existing redial/resync owner can recover accepted but unacknowledged
    /// records.
    pub fn send_reliable(
        &self,
        channel_id: u8,
        payload: ReliablePayload,
    ) -> Result<(), ReliablePayload> {
        // While the browser half is detached the edge has nowhere to deliver
        // this, and the tunnel is being deliberately held open for its return.
        // Reject to the caller for carrier fallback rather than filling the
        // bounded queue against a peer that cannot drain it — otherwise the
        // queue saturates and the write timeout fires, ending the very
        // generation the rebind window exists to preserve.
        if !self.has_reliable_counterpart() {
            return Err(payload);
        }
        #[cfg(test)]
        if let Some(ref capture) = self.capture {
            if reliable_channel_bit(channel_id).is_none() {
                return Err(payload);
            }
            if self
                .capture_reliable_remaining
                .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |remaining| {
                    remaining.checked_sub(1)
                })
                .is_err()
            {
                return Err(payload);
            }
            // Captures keep their `(channel, Vec<u8>)` shape; an inline record
            // is copied out here, in test code only.
            return capture
                .send((channel_id, payload.into_vec()))
                .map_err(|error| ReliablePayload::Heap(error.0.1));
        }
        let Some(senders) = self.reliable_senders.as_ref() else {
            return Err(payload);
        };
        if !self.lane.allows_reliable(channel_id) {
            return Err(payload);
        }
        try_enqueue_reliable_payload(
            senders,
            &self.reliable_queued_bytes,
            &self.reliable_queued_slots,
            channel_id,
            payload,
        )
    }

    pub(crate) async fn reserve_control_reply(&self, bytes: usize) -> Option<ReliablePermit> {
        if self.closing.load(Ordering::Acquire) || !self.lane.allows_reliable(CHANNEL_CTRL) {
            return None;
        }
        let sender = self.reliable_senders.as_ref()?.ctrl.clone();
        reserve_reliable_reply(
            sender,
            Arc::clone(&self.reliable_queued_bytes),
            Arc::clone(&self.reliable_queued_slots),
            bytes,
        )
        .await
    }

    /// Close the exact WebTransport generation and stop both persistent-lane
    /// supervisors. The deliberate-close marker is set first so cancellation or
    /// connection errors cannot overwrite the owner's close reason.
    pub fn close(&self) {
        self.closing.store(true, Ordering::Release);
        if let Some(ref conn) = self.conn {
            conn.close(wtransport::VarInt::from_u32(0), b"daemon-detach");
        }
        if let Some(ref abort) = self.reliable_writer_abort {
            abort.abort();
        }
        if let Some(ref abort) = self.lifecycle_reader_abort {
            abort.abort();
        }
        if let Some(ref abort) = self.delivery_quote_reader_abort {
            abort.abort();
        }
        if let Some(ref abort) = self.contention_requests_abort {
            abort.abort();
        }
        if let Some(ref abort) = self.unblock_watcher_abort {
            abort.abort();
        }
        self.control_request_sender
            .lock()
            .expect("edge control sender ownership mutex poisoned")
            .take();
        if let Some(abort) = self
            .reliable_receiver_abort
            .lock()
            .expect("edge receiver ownership mutex poisoned")
            .as_ref()
        {
            abort.abort();
        }
    }

    /// Wait for the tunnel transport to close. Registry ownership detach remains
    /// distinct from a typed persistent-lane failure; all other network/edge
    /// failures follow the existing generic redial path.
    ///
    /// Connection close remains the sole lifecycle wake. The first lane failure
    /// publishes its typed cause before closing the connection, then this method
    /// reads that cause after closure. A simultaneous counterpart-detach keeps
    /// precedence.
    pub async fn closed_reason(&self) -> EdgeTunnelCloseReason {
        let Some(ref conn) = self.conn else {
            return EdgeTunnelCloseReason::Other;
        };
        let reason = classify_connection_close(&conn.closed().await);
        if matches!(
            reason,
            EdgeTunnelCloseReason::CounterpartDetached | EdgeTunnelCloseReason::EgressBudget
        ) {
            return reason;
        }
        self.reliable_failure_rx
            .as_ref()
            .and_then(|failure| *failure.borrow())
            .map_or(reason, EdgeTunnelCloseReason::ReliableLaneFailed)
    }

    /// Spawn the datagram reader and one generation-owned reliable acceptor,
    /// each delivering to `ingress` itself. The acceptor owns exactly one
    /// persistent reader per logical channel and closes the generation on FIN,
    /// RESET, malformed, duplicate, or unknown lanes.
    pub fn spawn_receivers(&self, ingress: EdgeIngress) {
        let Some(ref conn) = self.conn else {
            return;
        };
        let Some(ref failure_tx) = self.reliable_failure_tx else {
            return;
        };
        let mut receiver_owner = self
            .reliable_receiver_abort
            .lock()
            .expect("edge receiver ownership mutex poisoned");
        if receiver_owner.is_some() {
            return;
        }

        let dgram_conn = conn.clone();
        let lane = self.lane;
        let dgram_ingress = ingress.clone();
        tokio::spawn(async move {
            while let Ok(d) = dgram_conn.receive_datagram().await {
                let bytes = d.payload();
                if bytes.is_empty()
                    || lane != EdgeLane::Interactive
                    || bytes[0] == CHANNEL_SIGNALING
                {
                    continue;
                }
                match dgram_ingress.enqueue_datagram(bytes) {
                    DatagramEnqueueResult::Enqueued | DatagramEnqueueResult::DroppedFull => {}
                    DatagramEnqueueResult::Closed => break,
                }
            }
        });

        *receiver_owner = Some(spawn_reliable_receivers(
            conn.clone(),
            ingress,
            failure_tx.clone(),
            Arc::clone(&self.closing),
            self.lane,
        ));
    }

    pub(crate) fn spawn_candidate_receivers(
        &self,
    ) -> Option<mpsc::Receiver<crate::edge_candidate::CandidateMessage>> {
        (self.lane == EdgeLane::Signaling)
            .then(|| {
                self.conn
                    .as_ref()
                    .map(|conn| crate::edge_candidate::spawn(conn.clone()))
            })
            .flatten()
    }
}

#[cfg(test)]
#[path = "edge_tunnel_congestion_tests.rs"]
mod congestion_tests;

/// A real interactive tunnel to a minimal in-process edge that admits it and
/// reports its counterpart present, with the edge's end of the connection. The
/// third value keeps the edge endpoint and its control streams alive.
#[cfg(test)]
pub(crate) async fn connected_interactive_test_tunnel()
-> (Arc<EdgeTunnel>, Connection, Box<dyn std::any::Any + Send>) {
    let (config, cert) = crate::webtransport::build_server_config(0).expect("server config");
    let server = wtransport::Endpoint::server(config).expect("server");
    let url = format!("https://127.0.0.1:{}", server.local_addr().unwrap().port());
    let credential = EdgeAdmission::for_test()
        .current()
        .expect("test credential");
    let probes = wtransport::quinn::ProbeGroup::new();
    let hashes = [cert.cert_hash];
    let accept = async {
        let conn = server
            .accept()
            .await
            .await
            .expect("request")
            .accept()
            .await
            .expect("accept");
        let (mut lifecycle, mut routing) = conn.accept_bi().await.expect("routing stream");
        let mut length = [0; 4];
        routing.read_exact(&mut length).await.expect("routing header");
        let mut body = vec![0; u32::from_be_bytes(length) as usize];
        routing.read_exact(&mut body).await.expect("routing body");
        let (quote_send, mut quote_recv) = conn.accept_bi().await.expect("quote stream");
        let mut preface = vec![0; DELIVERY_QUOTE_STREAM_PREFACE.len()];
        quote_recv
            .read_exact(&mut preface)
            .await
            .expect("quote preface");
        let present =
            br#"{"type":"counterpart_present","present":true,"counterpart_attachment_id":1}"#;
        lifecycle
            .write_all(&(present.len() as u32).to_be_bytes())
            .await
            .expect("lifecycle header");
        lifecycle.write_all(present).await.expect("lifecycle body");
        (conn, (lifecycle, routing, quote_send, quote_recv))
    };
    let ((edge, streams), tunnel) = tokio::join!(
        accept,
        EdgeTunnel::connect(
            &url,
            &hashes,
            "test",
            EdgeLane::Interactive,
            &probes,
            &credential,
        )
    );
    let tunnel = Arc::new(tunnel.expect("tunnel"));
    while tunnel.counterpart_absent.load(Ordering::Acquire) {
        tokio::task::yield_now().await;
    }
    (tunnel, edge, Box::new((server, streams, probes)))
}

/// Process-wide allocation counter for the test binary. It is installed as
/// the `#[global_allocator]`, so any workload in the crate can bracket a
/// region and read back exact allocation counts and requested bytes; the
/// A separate constant-initialized thread-local scope isolates actual worker
/// service from concurrent owner/channel allocations. These counters observe
/// Rust's allocator requests, not allocations internal to the C zstd library.
#[cfg(test)]
pub(crate) mod test_allocations {
    use std::alloc::{GlobalAlloc, Layout, System};
    use std::cell::Cell;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub(crate) struct Tally {
        pub(crate) allocations: usize,
        pub(crate) allocated_bytes: usize,
    }

    struct CountingAllocator;

    static ENABLED: AtomicBool = AtomicBool::new(false);
    static ALLOCATIONS: AtomicUsize = AtomicUsize::new(0);
    static ALLOCATED_BYTES: AtomicUsize = AtomicUsize::new(0);
    thread_local! {
        static THREAD_TALLY: Cell<Option<Tally>> = const { Cell::new(None) };
    }

    fn record(bytes: usize) {
        if ENABLED.load(Ordering::Relaxed) {
            ALLOCATIONS.fetch_add(1, Ordering::Relaxed);
            ALLOCATED_BYTES.fetch_add(bytes, Ordering::Relaxed);
        }
        // Const TLS requires neither allocation nor a destructor. `try_with`
        // also lets allocations during thread teardown bypass a retired slot.
        let _ = THREAD_TALLY.try_with(|slot| {
            if let Some(mut tally) = slot.get() {
                tally.allocations += 1;
                tally.allocated_bytes += bytes;
                slot.set(Some(tally));
            }
        });
    }

    #[global_allocator]
    static TEST_ALLOCATOR: CountingAllocator = CountingAllocator;

    // SAFETY: every method hands its arguments unchanged to `System` and
    // returns `System`'s answer, so `System`'s own `GlobalAlloc` guarantees
    // hold. `record` only bumps atomics and a const thread-local `Cell`, so it
    // never re-enters the allocator, and it could unwind only by overflowing a
    // `usize` tally, which one test's allocations cannot reach.
    unsafe impl GlobalAlloc for CountingAllocator {
        unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
            // SAFETY: this wrapper forwards the allocator contract and layout
            // unchanged to the process system allocator.
            let pointer = unsafe { System.alloc(layout) };
            if !pointer.is_null() {
                record(layout.size());
            }
            pointer
        }

        unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
            // SAFETY: this wrapper forwards the allocator contract and layout
            // unchanged to the process system allocator.
            let pointer = unsafe { System.alloc_zeroed(layout) };
            if !pointer.is_null() {
                record(layout.size());
            }
            pointer
        }

        unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
            // SAFETY: `pointer` and `layout` came from the forwarded system
            // allocator and are returned without modification.
            unsafe { System.dealloc(pointer, layout) };
        }

        unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
            // SAFETY: this wrapper forwards the original allocation identity,
            // layout, and requested size unchanged to the system allocator.
            let next = unsafe { System.realloc(pointer, layout, new_size) };
            if !next.is_null() {
                record(new_size);
            }
            next
        }
    }

    pub(crate) fn begin() {
        assert!(!ENABLED.swap(false, Ordering::SeqCst));
        ALLOCATIONS.store(0, Ordering::Relaxed);
        ALLOCATED_BYTES.store(0, Ordering::Relaxed);
        ENABLED.store(true, Ordering::SeqCst);
    }

    pub(crate) fn end() -> Tally {
        assert!(ENABLED.swap(false, Ordering::SeqCst));
        Tally {
            allocations: ALLOCATIONS.load(Ordering::Relaxed),
            allocated_bytes: ALLOCATED_BYTES.load(Ordering::Relaxed),
        }
    }

    pub(crate) fn begin_thread() {
        THREAD_TALLY.with(|slot| {
            assert!(
                slot.replace(Some(Tally {
                    allocations: 0,
                    allocated_bytes: 0
                }))
                .is_none()
            );
        });
    }

    pub(crate) fn end_thread() -> Tally {
        THREAD_TALLY.with(|slot| {
            slot.replace(None)
                .expect("thread allocation scope is active")
        })
    }

    #[test]
    fn allocation_scopes_count_only_their_own_worker_thread() {
        let ready = AtomicUsize::new(0);
        std::thread::scope(|scope| {
            let measure = |size| {
                begin_thread();
                ready.fetch_add(1, Ordering::Release);
                while ready.load(Ordering::Acquire) != 2 {
                    std::hint::spin_loop();
                }
                let bytes = std::hint::black_box(vec![0u8; size]);
                let tally = end_thread();
                assert_eq!(bytes.len(), size);
                tally
            };
            let first = scope.spawn(move || measure(13));
            let second = scope.spawn(move || measure(31));
            assert_eq!(
                first.join().expect("first allocation worker"),
                Tally {
                    allocations: 1,
                    allocated_bytes: 13,
                }
            );
            assert_eq!(
                second.join().expect("second allocation worker"),
                Tally {
                    allocations: 1,
                    allocated_bytes: 31,
                }
            );
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_delivery_quote(sent_packets: u64) -> EdgeDownstreamDeliveryQuote {
        EdgeDownstreamDeliveryQuote {
            rtt_us: 120_000,
            congestion_window_bytes: 64 * 1024,
            bytes_in_flight: 8 * 1024,
            send_buffer_occupied_bytes: 1_200,
            mtu_bytes: 1_200,
            pacing_rate_bps: 8_000_000,
            sent_packets,
            lost_packets: 0,
            pto_count: 0,
            send_blocked: false,
            contention: EdgeContention::default(),
        }
    }

    #[test]
    fn relay_data_budget_contract() {
        for (code, reason, expected) in [
            (
                0x4d03,
                b"egress-budget".as_slice(),
                EdgeTunnelCloseReason::EgressBudget,
            ),
            (0, b"egress-budget".as_slice(), EdgeTunnelCloseReason::Other),
            (
                0x4d03,
                b"egress-budget ".as_slice(),
                EdgeTunnelCloseReason::Other,
            ),
            (
                0x4d01,
                b"egress-budget".as_slice(),
                EdgeTunnelCloseReason::Other,
            ),
        ] {
            assert_eq!(
                classify_application_close(wtransport::VarInt::from_u32(code), reason),
                expected
            );
        }
        for paused in [true, false] {
            let json = format!(r#"{{"type":"relay_data_paused","paused":{paused}}}"#);
            assert!(
                matches!(serde_json::from_str::<SpliceControlEvent>(&json).unwrap(),
                SpliceControlEvent::RelayDataPaused { paused: value } if value == paused)
            );
        }
        for json in [
            r#"{"type":"relay_data_paused"}"#,
            r#"{"type":"relay_data_paused","paused":1}"#,
        ] {
            assert!(serde_json::from_str::<SpliceControlEvent>(json).is_err());
        }
    }

    #[test]
    fn either_hop_blocks_bulk_selection_without_retiring_the_tunnel() {
        use crate::connection::{PeerDisplayState, PeerTransport};
        let (tx, _rx) = mpsc::unbounded_channel();
        let interactive = Arc::new(EdgeTunnel::new_capture(tx.clone()));
        let bulk = Arc::new(EdgeTunnel::new_capture(tx));
        let mut peer = PeerDisplayState::new("capacity".into(), PeerTransport::Edge);
        peer.edge_tunnel = Some(Arc::clone(&interactive));
        peer.edge_tunnel_bulk = Some(Arc::clone(&bulk));
        peer.bulk_delivery_confirmed = true;
        assert!(Arc::ptr_eq(&peer.reliable_edge_tunnel().unwrap(), &bulk));
        bulk.set_upstream_blocked_for_test(true);
        assert!(Arc::ptr_eq(&peer.reliable_edge_tunnel().unwrap(), &interactive));
        bulk.set_upstream_blocked_for_test(false);
        let mut quote = test_delivery_quote(10);
        quote.send_blocked = true;
        bulk.set_downstream_quote_for_test(Some(quote));
        assert!(Arc::ptr_eq(&peer.reliable_edge_tunnel().unwrap(), &interactive));
        // A probe count is diagnostic; only the actual capacity state selects.
        quote.send_blocked = false;
        quote.pto_count = 9;
        bulk.set_downstream_quote_for_test(Some(quote));
        assert!(Arc::ptr_eq(&peer.reliable_edge_tunnel().unwrap(), &bulk));
        assert!(!bulk.closing.load(Ordering::Acquire));
    }

    #[test]
    fn reliable_selection_tracks_pairing_and_close_without_a_new_bulk_claim() {
        use crate::connection::{PeerDisplayState, PeerTransport};
        let (tx, mut rx) = mpsc::unbounded_channel();
        let interactive = Arc::new(EdgeTunnel::new_capture(tx.clone()));
        let bulk = Arc::new(EdgeTunnel::new_capture(tx));
        let mut peer = PeerDisplayState::new("pairing".into(), PeerTransport::Edge);
        peer.edge_tunnel = Some(Arc::clone(&interactive));
        peer.edge_tunnel_bulk = Some(Arc::clone(&bulk));
        peer.bulk_delivery_confirmed = true;
        assert!(Arc::ptr_eq(&peer.reliable_edge_tunnel().unwrap(), &bulk));

        bulk.counterpart_absent.store(true, Ordering::Release);
        let selected = peer.reliable_edge_tunnel().unwrap();
        assert!(Arc::ptr_eq(&selected, &interactive));
        selected
            .send_reliable(CHANNEL_CTRL, ReliablePayload::Heap(vec![7]))
            .unwrap();
        assert_eq!(rx.try_recv().unwrap(), (CHANNEL_CTRL, vec![7]));

        interactive
            .counterpart_absent
            .store(true, Ordering::Release);
        assert!(peer.reliable_edge_tunnel().is_none());
        // Reattachment restores the previously confirmed lane immediately.
        bulk.counterpart_absent.store(false, Ordering::Release);
        assert!(Arc::ptr_eq(&peer.reliable_edge_tunnel().unwrap(), &bulk));
        bulk.closing.store(true, Ordering::Release);
        assert!(peer.reliable_edge_tunnel().is_none());
        interactive
            .counterpart_absent
            .store(false, Ordering::Release);
        assert!(Arc::ptr_eq(
            &peer.reliable_edge_tunnel().unwrap(),
            &interactive
        ));
        // Admission rechecks the fact if a detach raced selection.
        interactive
            .counterpart_absent
            .store(true, Ordering::Release);
        assert!(
            selected
                .send_reliable(CHANNEL_CTRL, ReliablePayload::Heap(vec![8]))
                .is_err()
        );
        assert!(rx.try_recv().is_err());
    }

    /// Byte-identical to `delivery_quote_json_is_the_daemon_mirror_shape` in
    /// the edge's splice tests: the two ends of the quote stream agree.
    const EDGE_QUOTE_JSON: &str = r#"{"type":"counterpart_delivery_quote","browser_attachment_id":42,"rtt_us":4000,"congestion_window_bytes":64000,"bytes_in_flight":11000,"send_buffer_occupied_bytes":12000,"mtu_bytes":1400,"pacing_rate_bps":10000000,"sent_packets":6000,"lost_packets":2,"interactive_blocked":3,"interactive_paced":4,"interactive_waited_us":5,"bulk_blocked":6,"bulk_paced":7,"bulk_waited_us":8,"forward_residence":[1,2,3,4,5,6,7,8,9,10,11,12],"model":{"epoch":17,"bw":4294967311,"rtprop_us":120000,"pacing_rate":8589934609,"bulk_cap":65536,"quantum":1200,"phase":5,"probes_gated":1,"probes_aborted":2,"interactive_in_probe":3,"queue_growth_cuts":4,"loss_rounds":5,"ce_rounds":6,"probe_rtts":7},"pto_count":3,"send_blocked":true}"#;

    #[test]
    fn the_edge_quote_carries_its_contention_evidence_to_the_daemon() {
        let event = serde_json::from_str::<SpliceDeliveryQuoteEvent>(EDGE_QUOTE_JSON)
            .expect("the edge's quote shape");
        let (browser_attachment_id, quote) = event.downstream_quote();
        assert_eq!(browser_attachment_id, 42);
        assert_eq!(quote.sent_packets, 6_000);
        assert_eq!(quote.pto_count, 3);
        assert!(quote.send_blocked, "the browser leg's blocked state reaches the planner");
        assert_eq!(
            quote.contention,
            EdgeContention {
                attachment: 42,
                interactive: EdgeAdmissions {
                    blocked: 3,
                    paced: 4,
                    waited_us: 5,
                },
                bulk: EdgeAdmissions {
                    blocked: 6,
                    paced: 7,
                    waited_us: 8,
                },
                forward_residence: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
                model: Some(crate::perf_timing::PerfEgressModel {
                    epoch: 17,
                    bw: 4294967311,
                    rtprop_us: 120000,
                    pacing_rate: 8589934609,
                    bulk_cap: 65536,
                    quantum: 1200,
                    phase: 5,
                    probes_gated: 1,
                    probes_aborted: 2,
                    interactive_in_probe: 3,
                    queue_growth_cuts: 4,
                    loss_rounds: 5,
                    ce_rounds: 6,
                    probe_rtts: 7,
                }),
            }
        );
        // deny_unknown_fields: an edge that grows a field without the daemon
        // is a parse failure, which clears the quote rather than misreading it.
        let extended = EDGE_QUOTE_JSON.replace("}", r#","extra":1}"#);
        assert!(serde_json::from_str::<SpliceDeliveryQuoteEvent>(&extended).is_err());
    }

    #[test]
    fn delivery_quotes_are_fenced_by_browser_attachment_generation() {
        let (sender, mut receiver) = watch::channel(None);
        let mut fence = DeliveryQuoteFence {
            browser_attachment_id: 1,
            sender,
        };
        let old_quote = test_delivery_quote(10);
        assert!(fence.publish_if_current(1, old_quote));
        assert_eq!(*receiver.borrow_and_update(), Some(old_quote));

        // New lifecycle wins even when an old-stream record is delivered
        // afterwards: its epoch cannot repopulate the cleared newest value.
        fence.change_browser_attachment(2);
        assert!(!fence.publish_if_current(1, test_delivery_quote(11)));
        assert_eq!(*receiver.borrow_and_update(), None);

        let new_quote = test_delivery_quote(12);
        assert!(fence.publish_if_current(2, new_quote));
        assert_eq!(*receiver.borrow_and_update(), Some(new_quote));

        // Cross-stream delivery may put a new quote before its Attached event;
        // it is discarded until lifecycle installs that exact epoch.
        fence.change_browser_attachment(0);
        assert!(!fence.publish_if_current(3, test_delivery_quote(13)));
        assert_eq!(*receiver.borrow_and_update(), None);
        fence.change_browser_attachment(3);
        assert!(fence.publish_if_current(3, test_delivery_quote(14)));
    }

    #[test]
    fn lifecycle_attachment_epochs_are_positive_and_presence_is_consistent() {
        assert_eq!(
            counterpart_state(SpliceControlEvent::CounterpartPresent {
                present: false,
                counterpart_attachment_id: None,
            }),
            Some((CounterpartState::Pending, 0))
        );
        assert!(
            counterpart_state(SpliceControlEvent::CounterpartPresent {
                present: true,
                counterpart_attachment_id: None,
            })
            .is_none()
        );
        assert!(
            counterpart_state(SpliceControlEvent::CounterpartAttached {
                counterpart_attachment_id: 0,
            })
            .is_none()
        );
        assert_eq!(
            counterpart_state(SpliceControlEvent::CounterpartDetached {
                counterpart_attachment_id: 9,
                rebind_window_remaining_ms: 30_000,
            }),
            Some((
                CounterpartState::Detached {
                    rebind_window_remaining_ms: 30_000,
                },
                0,
            ))
        );
    }
    use crate::network::peer::INLINE_RELIABLE_PAYLOAD_BYTES;
    use std::pin::Pin;
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
    use std::task::{Context, Poll};
    use tokio::io::{AsyncWriteExt, ReadBuf};

    struct MockReliableReader<'a> {
        bytes: &'a [u8],
        cursor: usize,
        fragment_bytes: usize,
    }

    impl<'a> MockReliableReader<'a> {
        fn new(bytes: &'a [u8], fragment_bytes: usize) -> Self {
            Self {
                bytes,
                cursor: 0,
                fragment_bytes: fragment_bytes.max(1),
            }
        }
    }

    impl AsyncRead for MockReliableReader<'_> {
        fn poll_read(
            mut self: Pin<&mut Self>,
            _context: &mut Context<'_>,
            destination: &mut ReadBuf<'_>,
        ) -> Poll<std::io::Result<()>> {
            let remaining = self.bytes.len().saturating_sub(self.cursor);
            if remaining == 0 {
                return Poll::Ready(Ok(()));
            }
            let copied = remaining
                .min(destination.remaining())
                .min(self.fragment_bytes);
            destination.put_slice(&self.bytes[self.cursor..self.cursor + copied]);
            self.cursor += copied;
            Poll::Ready(Ok(()))
        }
    }

    type MockWriterEvent = (u8, EdgeReliableLaneOperation, Vec<u8>);
    type MockWriterWrites = Arc<Mutex<Vec<(u8, Vec<u8>)>>>;

    #[derive(Clone)]
    struct MockReliableWriterIo {
        stall_on: Option<(u8, EdgeReliableLaneOperation)>,
        fail_on: Option<(u8, EdgeReliableLaneOperation)>,
        events: mpsc::UnboundedSender<MockWriterEvent>,
        writes: MockWriterWrites,
        priorities: Arc<Mutex<Vec<(u8, i32)>>>,
        close_count: Arc<AtomicUsize>,
    }

    impl MockReliableWriterIo {
        fn new(
            stall_on: Option<(u8, EdgeReliableLaneOperation)>,
            fail_on: Option<(u8, EdgeReliableLaneOperation)>,
        ) -> (Self, mpsc::UnboundedReceiver<MockWriterEvent>) {
            let (events, event_rx) = mpsc::unbounded_channel();
            (
                Self {
                    stall_on,
                    fail_on,
                    events,
                    writes: Arc::new(Mutex::new(Vec::new())),
                    priorities: Arc::new(Mutex::new(Vec::new())),
                    close_count: Arc::new(AtomicUsize::new(0)),
                },
                event_rx,
            )
        }

        async fn run_operation(
            &self,
            channel_id: u8,
            operation: EdgeReliableLaneOperation,
        ) -> Result<(), String> {
            if self.stall_on == Some((channel_id, operation)) {
                return std::future::pending().await;
            }
            if self.fail_on == Some((channel_id, operation)) {
                return Err("injected transport failure".to_string());
            }
            Ok(())
        }
    }

    struct MockReliableWriterOpening {
        io: MockReliableWriterIo,
        channel_id: u8,
    }

    struct MockReliableWriterStream {
        io: MockReliableWriterIo,
        channel_id: u8,
        bound: bool,
    }

    #[expect(
    clippy::manual_async_fn,
    reason = "a trait `async fn` cannot state the Send bound the spawned supervisor needs"
)]
    impl ReliableWriterStream for MockReliableWriterStream {
        fn set_send_priority(&self, priority: i32) {
            assert!(!self.bound, "send priority must precede the channel prefix");
            self.io
                .priorities
                .lock()
                .unwrap()
                .push((self.channel_id, priority));
        }

        fn write_all<'a>(
            &'a mut self,
            bytes: &'a [u8],
        ) -> impl Future<Output = Result<(), String>> + Send + 'a {
            async move {
                let operation = if self.bound {
                    EdgeReliableLaneOperation::Write
                } else {
                    EdgeReliableLaneOperation::Bind
                };
                let _ = self
                    .io
                    .events
                    .send((self.channel_id, operation, bytes.to_vec()));
                self.io.run_operation(self.channel_id, operation).await?;
                self.io
                    .writes
                    .lock()
                    .unwrap()
                    .push((self.channel_id, bytes.to_vec()));
                self.bound = true;
                Ok(())
            }
        }

        fn write_record<'a>(
            &'a mut self,
            length: [u8; 4],
            payload: &'a mut ReliablePayload,
        ) -> impl Future<Output = Result<(), String>> + Send + 'a {
            async move {
                let record = [length.as_slice(), payload.as_slice()].concat();
                self.write_all(&record).await
            }
        }

        fn stopped(&self) -> impl Future<Output = ReliableWriterStop> + Send + 'static {
            let io = self.io.clone();
            let channel_id = self.channel_id;
            async move {
                if io.fail_on == Some((channel_id, EdgeReliableLaneOperation::Stopped)) {
                    return ReliableWriterStop {
                        kind: EdgeReliableLaneFailureKind::Reset,
                        detail: "injected peer stop".to_string(),
                    };
                }
                std::future::pending().await
            }
        }
    }

    #[expect(
    clippy::manual_async_fn,
    reason = "a trait `async fn` cannot state the Send bound the spawned supervisor needs"
)]
    impl ReliableWriterOpening for MockReliableWriterOpening {
        type Stream = MockReliableWriterStream;

        fn open(self) -> impl Future<Output = Result<Self::Stream, String>> + Send {
            async move {
                let _ = self.io.events.send((
                    self.channel_id,
                    EdgeReliableLaneOperation::Open,
                    Vec::new(),
                ));
                self.io
                    .run_operation(self.channel_id, EdgeReliableLaneOperation::Open)
                    .await?;
                Ok(MockReliableWriterStream {
                    io: self.io,
                    channel_id: self.channel_id,
                    bound: false,
                })
            }
        }
    }

    #[expect(
    clippy::manual_async_fn,
    reason = "a trait `async fn` cannot state the Send bound the spawned supervisor needs"
)]
    impl ReliableWriterIo for MockReliableWriterIo {
        type Opening = MockReliableWriterOpening;

        fn open_uni(
            &self,
            channel_id: u8,
        ) -> impl Future<Output = Result<Self::Opening, String>> + Send + '_ {
            async move {
                let _ =
                    self.events
                        .send((channel_id, EdgeReliableLaneOperation::OpenUni, Vec::new()));
                self.run_operation(channel_id, EdgeReliableLaneOperation::OpenUni)
                    .await?;
                Ok(MockReliableWriterOpening {
                    io: self.clone(),
                    channel_id,
                })
            }
        }

        fn close_failed_generation(&self) {
            self.close_count.fetch_add(1, Ordering::SeqCst);
        }
    }

    #[derive(Clone, Default)]
    struct BenchmarkReliableWriterIo {
        open_uni: Arc<AtomicUsize>,
        open: Arc<AtomicUsize>,
        writes: Arc<AtomicUsize>,
        finishes: Arc<AtomicUsize>,
        written_bytes: Arc<AtomicUsize>,
        checksum: Arc<AtomicU64>,
    }

    struct BenchmarkReliableWriterOpening {
        io: BenchmarkReliableWriterIo,
    }

    struct BenchmarkReliableWriterStream {
        io: BenchmarkReliableWriterIo,
    }

    #[expect(
    clippy::manual_async_fn,
    reason = "a trait `async fn` cannot state the Send bound the spawned supervisor needs"
)]
    impl ReliableWriterStream for BenchmarkReliableWriterStream {
        fn set_send_priority(&self, _priority: i32) {}

        fn write_all<'a>(
            &'a mut self,
            bytes: &'a [u8],
        ) -> impl Future<Output = Result<(), String>> + Send + 'a {
            async move {
                self.io.writes.fetch_add(1, Ordering::Relaxed);
                self.io
                    .written_bytes
                    .fetch_add(bytes.len(), Ordering::Relaxed);
                let first = bytes.first().copied().unwrap_or_default() as u64;
                let last = bytes.last().copied().unwrap_or_default() as u64;
                self.io.checksum.fetch_xor(
                    first ^ last.rotate_left(8) ^ (bytes.len() as u64).rotate_left(24),
                    Ordering::Relaxed,
                );
                Ok(())
            }
        }

        fn write_record<'a>(
            &'a mut self,
            length: [u8; 4],
            payload: &'a mut ReliablePayload,
        ) -> impl Future<Output = Result<(), String>> + Send + 'a {
            async move {
                let payload = payload.as_slice();
                self.io.writes.fetch_add(1, Ordering::Relaxed);
                self.io
                    .written_bytes
                    .fetch_add(length.len() + payload.len(), Ordering::Relaxed);
                let first = length[0] as u64;
                let last = payload.last().copied().unwrap_or(length[3]) as u64;
                self.io.checksum.fetch_xor(
                    first
                        ^ last.rotate_left(8)
                        ^ ((length.len() + payload.len()) as u64).rotate_left(24),
                    Ordering::Relaxed,
                );
                Ok(())
            }
        }

        fn stopped(&self) -> impl Future<Output = ReliableWriterStop> + Send + 'static {
            std::future::pending()
        }
    }

    #[expect(
    clippy::manual_async_fn,
    reason = "a trait `async fn` cannot state the Send bound the spawned supervisor needs"
)]
    impl ReliableWriterOpening for BenchmarkReliableWriterOpening {
        type Stream = BenchmarkReliableWriterStream;

        fn open(self) -> impl Future<Output = Result<Self::Stream, String>> + Send {
            async move {
                self.io.open.fetch_add(1, Ordering::Relaxed);
                Ok(BenchmarkReliableWriterStream { io: self.io })
            }
        }
    }

    #[expect(
    clippy::manual_async_fn,
    reason = "a trait `async fn` cannot state the Send bound the spawned supervisor needs"
)]
    impl ReliableWriterIo for BenchmarkReliableWriterIo {
        type Opening = BenchmarkReliableWriterOpening;

        fn open_uni(
            &self,
            _channel_id: u8,
        ) -> impl Future<Output = Result<Self::Opening, String>> + Send + '_ {
            async move {
                self.open_uni.fetch_add(1, Ordering::Relaxed);
                Ok(BenchmarkReliableWriterOpening { io: self.clone() })
            }
        }

        fn close_failed_generation(&self) {}
    }

    struct ReliableWriterBenchmarkResult {
        elapsed_ns_per_frame: f64,
        open_uni: usize,
        open: usize,
        writes: usize,
        finishes: usize,
        written_bytes: usize,
        checksum: u64,
    }

    async fn run_reliable_writer_benchmark_batch(
        frame_count: usize,
        channel_count: usize,
    ) -> ReliableWriterBenchmarkResult {
        const CHANNELS: [u8; 3] = [0x00, 0x02, 0x04];
        assert!((1..=CHANNELS.len()).contains(&channel_count));
        let io = BenchmarkReliableWriterIo::default();
        let (senders, receivers) = reliable_channel_queues();
        for sequence in 0..frame_count {
            let channel_id = CHANNELS[sequence % channel_count];
            let payload = [sequence as u8; 32];
            senders
                .sender(channel_id)
                .expect("benchmark channel is reliable")
                .send(ReliableFrame::unaccounted(&payload))
                .await
                .expect("benchmark writer owns its receiver");
        }
        drop(senders);

        let started = std::time::Instant::now();
        run_reliable_writer(Arc::new(io.clone()), receivers)
            .await
            .expect("benchmark writer completes");
        let elapsed_ns_per_frame = started.elapsed().as_nanos() as f64 / frame_count as f64;

        ReliableWriterBenchmarkResult {
            elapsed_ns_per_frame,
            open_uni: io.open_uni.load(Ordering::Relaxed),
            open: io.open.load(Ordering::Relaxed),
            writes: io.writes.load(Ordering::Relaxed),
            finishes: io.finishes.load(Ordering::Relaxed),
            written_bytes: io.written_bytes.load(Ordering::Relaxed),
            checksum: io.checksum.load(Ordering::Relaxed),
        }
    }

    fn emit_reliable_writer_latency(name: &str, samples: &mut [f64], sample_size: usize) {
        samples.sort_by(f64::total_cmp);
        for percentile in [0.50, 0.95, 0.99] {
            let index = ((samples.len() as f64 * percentile).ceil() as usize)
                .saturating_sub(1)
                .min(samples.len().saturating_sub(1));
            println!(
                "@@merkur-perf {{\"name\":\"edge-reliable-writer-{name}\",\"value\":{},\"unit\":\"ns/frame\",\"direction\":\"lower\",\"percentile\":{percentile},\"sampleSize\":{sample_size}}}",
                samples[index]
            );
        }
    }

    fn emit_reliable_writer_exact(name: &str, suffix: &str, value: f64, unit: &str) {
        println!(
            "@@merkur-perf {{\"name\":\"edge-reliable-writer-{name}-{suffix}\",\"value\":{value},\"unit\":\"{unit}\",\"direction\":\"lower\",\"sampleSize\":1}}"
        );
    }

    /// Component profile for production reliable-writer ownership. The mock I/O
    /// completes synchronously so the timer isolates queue draining, stream/task
    /// orchestration, and framing rather than network RTT.
    #[tokio::test(flavor = "current_thread")]
    #[ignore = "production performance workload"]
    async fn production_reliable_writer_benchmark() {
        let samples = std::env::var("BENCH_SAMPLES")
            .ok()
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(300)
            .max(3);
        let frame_count = std::env::var("BENCH_BATCH_SIZE")
            .ok()
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(512)
            .max(3);
        assert!(
            frame_count <= EDGE_RELIABLE_QUEUE_CAP,
            "benchmark preloads frames before starting the writer; BENCH_BATCH_SIZE must not exceed {EDGE_RELIABLE_QUEUE_CAP}"
        );
        let warmups = samples.div_ceil(10);

        for (name, channel_count) in [("one-channel", 1), ("three-channel", 3)] {
            for _ in 0..warmups {
                std::hint::black_box(
                    run_reliable_writer_benchmark_batch(frame_count, channel_count).await,
                );
            }

            let mut latency_samples = Vec::with_capacity(samples);
            let mut last = None;
            for _ in 0..samples {
                let result = run_reliable_writer_benchmark_batch(frame_count, channel_count).await;
                latency_samples.push(result.elapsed_ns_per_frame);
                last = Some(result);
            }
            let result = last.expect("benchmark has at least three samples");
            assert_eq!(result.open_uni, channel_count);
            assert_eq!(result.open_uni, result.open);
            assert_eq!(result.finishes, 0);
            assert_eq!(result.writes, channel_count + frame_count);
            assert_eq!(result.written_bytes, channel_count + frame_count * (4 + 32));
            std::hint::black_box(result.checksum);

            emit_reliable_writer_latency(name, &mut latency_samples, samples);
            emit_reliable_writer_exact(
                name,
                "stream-opens",
                result.open_uni as f64 / frame_count as f64,
                "opens/frame",
            );
            emit_reliable_writer_exact(
                name,
                "writes",
                result.writes as f64 / frame_count as f64,
                "writes/frame",
            );
            emit_reliable_writer_exact(
                name,
                "finishes",
                result.finishes as f64 / frame_count as f64,
                "finishes/frame",
            );
        }
    }

    /// The reliable display lane must yield the connection to every control
    /// lane, and must do so before its first byte.
    ///
    /// Asserted on the writer rather than only on the classifier because the
    /// bug this prevents is not a wrong table — it is a stream that never asks.
    /// The order matters too: quinn queues a stream at the priority it held
    /// when its data was queued, so a class declared after the prefix would
    /// leave the opening record competing at the wrong level.
    #[tokio::test(start_paused = true)]
    async fn every_reliable_lane_declares_its_send_class_before_its_first_byte() {
        let channels = [
            CHANNEL_SIGNALING,
            CHANNEL_PTY,
            CHANNEL_CTRL,
            CHANNEL_DISPLAY_COMMIT,
            CHANNEL_DATA_HELLO,
        ];
        let (io, mut events) = MockReliableWriterIo::new(None, None);
        let priorities = Arc::clone(&io.priorities);
        let writes = Arc::clone(&io.writes);
        let (failure_tx, _failure_rx) = watch::channel(None);
        let mut senders = Vec::new();
        let mut receivers = Vec::new();
        for channel_id in channels {
            let (frame_tx, frame_rx) = mpsc::channel(1);
            senders.push((channel_id, frame_tx));
            receivers.push((channel_id, frame_rx));
        }
        let _abort = spawn_reliable_writer_io(
            io,
            receivers,
            "priority-test".to_string(),
            failure_tx,
            Arc::new(AtomicBool::new(false)),
        );
        for (_, frame_tx) in &senders {
            frame_tx
                .send(ReliableFrame::unaccounted(b"sealed"))
                .await
                .unwrap();
        }

        // Drain until every lane has written its record; the bind precedes it.
        let mut written = 0usize;
        while written < channels.len() {
            let (_, operation, _) = events.recv().await.expect("writer operation starts");
            if operation == EdgeReliableLaneOperation::Write {
                written += 1;
            }
        }

        let observed = priorities.lock().unwrap().clone();
        assert_eq!(
            observed.len(),
            channels.len(),
            "every lane declares its class exactly once"
        );
        for channel_id in channels {
            let declared = observed
                .iter()
                .find(|(candidate, _)| *candidate == channel_id)
                .map(|(_, priority)| *priority);
            assert_eq!(
                declared,
                Some(crate::network::protocol::reliable_stream_priority(
                    channel_id
                )),
                "channel {channel_id:#04x} must declare its classified send priority",
            );
        }
        assert_eq!(
            observed
                .iter()
                .find(|(channel_id, _)| *channel_id == CHANNEL_DISPLAY_COMMIT)
                .map(|(_, priority)| *priority),
            Some(crate::network::protocol::RELIABLE_PRIORITY_BULK),
            "the reliable display lane is the one that yields",
        );

        // The class is declared before the channel prefix, which is the first
        // thing written on every lane.
        let first_writes = writes.lock().unwrap().clone();
        for channel_id in channels {
            let first = first_writes
                .iter()
                .find(|(candidate, _)| *candidate == channel_id)
                .expect("lane wrote");
            assert_eq!(
                first.1,
                vec![channel_id],
                "the first write on a lane is its channel prefix",
            );
        }
    }

    async fn assert_writer_operation_times_out(target: EdgeReliableLaneOperation) {
        let channel_id = CHANNEL_DISPLAY_COMMIT;
        let (io, mut events) = MockReliableWriterIo::new(Some((channel_id, target)), None);
        let close_count = Arc::clone(&io.close_count);
        let (frame_tx, frame_rx) = mpsc::channel(1);
        let (failure_tx, mut failure_rx) = watch::channel(None);
        let _abort = spawn_reliable_writer_io(
            io,
            vec![(channel_id, frame_rx)],
            "timeout-test".to_string(),
            failure_tx,
            Arc::new(AtomicBool::new(false)),
        );
        frame_tx
            .send(ReliableFrame::unaccounted(b"sealed"))
            .await
            .unwrap();

        loop {
            let (_, operation, _) = events.recv().await.expect("writer operation starts");
            if operation == target {
                break;
            }
        }

        tokio::time::advance(EDGE_RELIABLE_OPERATION_TIMEOUT - Duration::from_millis(1)).await;
        tokio::task::yield_now().await;
        assert_eq!(
            *failure_rx.borrow(),
            None,
            "operation must own the full RTO budget"
        );

        tokio::time::advance(Duration::from_millis(1)).await;
        failure_rx
            .changed()
            .await
            .expect("typed writer failure published");
        assert_eq!(
            *failure_rx.borrow(),
            Some(EdgeReliableLaneFailure {
                direction: EdgeReliableLaneDirection::Send,
                channel_id: Some(channel_id),
                operation: target,
                kind: EdgeReliableLaneFailureKind::TimedOut,
            })
        );
        assert_eq!(
            close_count.load(Ordering::SeqCst),
            1,
            "the failed generation closes exactly once"
        );
        assert!(
            frame_tx
                .send(ReliableFrame::unaccounted(b"later"))
                .await
                .is_err(),
            "the failed writer must drop its bounded queue receiver"
        );
    }

    #[test]
    fn counterpart_detach_requires_the_exact_close_code_and_reason() {
        let code = wtransport::VarInt::from_u32(COUNTERPART_DETACHED_CLOSE_CODE);
        assert_eq!(
            classify_application_close(code, COUNTERPART_DETACHED_CLOSE_REASON),
            EdgeTunnelCloseReason::CounterpartDetached
        );
        assert_eq!(
            classify_application_close(
                wtransport::VarInt::from_u32(0),
                COUNTERPART_DETACHED_CLOSE_REASON
            ),
            EdgeTunnelCloseReason::Other
        );
        assert_eq!(
            classify_application_close(code, b"splice-ended"),
            EdgeTunnelCloseReason::Other
        );
    }

    #[tokio::test(start_paused = true)]
    async fn reliable_writer_stalled_open_uni_fails_at_the_rto_ceiling() {
        assert_writer_operation_times_out(EdgeReliableLaneOperation::OpenUni).await;
    }

    #[tokio::test(start_paused = true)]
    async fn reliable_writer_stalled_stream_open_fails_at_the_rto_ceiling() {
        assert_writer_operation_times_out(EdgeReliableLaneOperation::Open).await;
    }

    #[tokio::test(start_paused = true)]
    async fn reliable_writer_stalled_write_fails_at_the_rto_ceiling() {
        assert_writer_operation_times_out(EdgeReliableLaneOperation::Write).await;
    }

    #[tokio::test(start_paused = true)]
    async fn reliable_writer_stalled_channel_bind_fails_at_the_rto_ceiling() {
        assert_writer_operation_times_out(EdgeReliableLaneOperation::Bind).await;
    }

    #[tokio::test]
    async fn reliable_writer_transport_error_closes_once_without_retry() {
        let channel_id = CHANNEL_DISPLAY_COMMIT;
        let (io, mut events) =
            MockReliableWriterIo::new(None, Some((channel_id, EdgeReliableLaneOperation::OpenUni)));
        let close_count = Arc::clone(&io.close_count);
        let (frame_tx, frame_rx) = mpsc::channel(1);
        let (failure_tx, mut failure_rx) = watch::channel(None);
        let _abort = spawn_reliable_writer_io(
            io,
            vec![(channel_id, frame_rx)],
            "transport-error-test".to_string(),
            failure_tx,
            Arc::new(AtomicBool::new(false)),
        );
        frame_tx
            .send(ReliableFrame::unaccounted(b"sealed"))
            .await
            .unwrap();
        assert_eq!(
            events.recv().await,
            Some((channel_id, EdgeReliableLaneOperation::OpenUni, Vec::new()))
        );
        failure_rx.changed().await.unwrap();
        assert_eq!(
            *failure_rx.borrow(),
            Some(EdgeReliableLaneFailure {
                direction: EdgeReliableLaneDirection::Send,
                channel_id: Some(channel_id),
                operation: EdgeReliableLaneOperation::OpenUni,
                kind: EdgeReliableLaneFailureKind::Transport,
            })
        );
        assert_eq!(close_count.load(Ordering::SeqCst), 1);
        assert!(
            frame_tx
                .send(ReliableFrame::unaccounted(b"later"))
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn reliable_writer_peer_stop_while_idle_closes_the_generation() {
        let channel_id = CHANNEL_CTRL;
        let (io, _events) =
            MockReliableWriterIo::new(None, Some((channel_id, EdgeReliableLaneOperation::Stopped)));
        let close_count = Arc::clone(&io.close_count);
        let (frame_tx, frame_rx) = mpsc::channel(1);
        let (failure_tx, mut failure_rx) = watch::channel(None);
        let _abort = spawn_reliable_writer_io(
            io,
            vec![(channel_id, frame_rx)],
            "peer-stop-test".to_string(),
            failure_tx,
            Arc::new(AtomicBool::new(false)),
        );
        frame_tx
            .send(ReliableFrame::unaccounted(b"first-and-only"))
            .await
            .unwrap();

        failure_rx.changed().await.unwrap();
        assert_eq!(
            *failure_rx.borrow(),
            Some(EdgeReliableLaneFailure {
                direction: EdgeReliableLaneDirection::Send,
                channel_id: Some(channel_id),
                operation: EdgeReliableLaneOperation::Stopped,
                kind: EdgeReliableLaneFailureKind::Reset,
            })
        );
        assert_eq!(close_count.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn reliable_writer_peer_stop_wins_over_an_already_queued_record() {
        let channel_id = CHANNEL_CTRL;
        let (io, _events) =
            MockReliableWriterIo::new(None, Some((channel_id, EdgeReliableLaneOperation::Stopped)));
        let writes = Arc::clone(&io.writes);
        let (frame_tx, frame_rx) = mpsc::channel(2);
        let (failure_tx, mut failure_rx) = watch::channel(None);
        let _abort = spawn_reliable_writer_io(
            io,
            vec![(channel_id, frame_rx)],
            "queued-peer-stop-test".to_string(),
            failure_tx,
            Arc::new(AtomicBool::new(false)),
        );
        frame_tx
            .send(ReliableFrame::unaccounted(b"first"))
            .await
            .unwrap();
        frame_tx
            .send(ReliableFrame::unaccounted(b"must-not-write"))
            .await
            .unwrap();

        failure_rx.changed().await.unwrap();
        assert_eq!(
            *writes.lock().unwrap(),
            vec![
                (channel_id, vec![channel_id]),
                (channel_id, [&5_u32.to_be_bytes()[..], b"first"].concat()),
            ],
            "a ready peer stop must beat the next queued record"
        );
    }

    #[tokio::test]
    async fn reliable_writer_reuses_one_stream_for_multiple_records() {
        let (io, _events) = MockReliableWriterIo::new(None, None);
        let writes = Arc::clone(&io.writes);
        let (senders, receivers) = reliable_channel_queues();
        let sender = senders.sender(CHANNEL_DISPLAY_COMMIT).unwrap();
        sender
            .send(ReliableFrame::unaccounted(b"first"))
            .await
            .unwrap();
        sender
            .send(ReliableFrame::unaccounted(b"second"))
            .await
            .unwrap();
        drop(senders);
        run_reliable_writer(Arc::new(io), receivers)
            .await
            .expect("all persistent writers drain");
        assert_eq!(
            *writes.lock().unwrap(),
            vec![
                (CHANNEL_DISPLAY_COMMIT, vec![CHANNEL_DISPLAY_COMMIT]),
                (
                    CHANNEL_DISPLAY_COMMIT,
                    [&5_u32.to_be_bytes()[..], b"first"].concat()
                ),
                (
                    CHANNEL_DISPLAY_COMMIT,
                    [&6_u32.to_be_bytes()[..], b"second"].concat()
                ),
            ],
            "channel binds once, records retain FIFO on that stream, one write per record"
        );
    }

    #[tokio::test]
    async fn stalled_reliable_channel_does_not_block_another_channel() {
        let (io, mut events) = MockReliableWriterIo::new(
            Some((CHANNEL_DISPLAY_COMMIT, EdgeReliableLaneOperation::Write)),
            None,
        );
        let (senders, receivers) = reliable_channel_queues();
        senders
            .sender(CHANNEL_DISPLAY_COMMIT)
            .unwrap()
            .send(ReliableFrame::unaccounted(b"stalled"))
            .await
            .unwrap();
        senders
            .sender(CHANNEL_SIGNALING)
            .unwrap()
            .send(ReliableFrame::unaccounted(b"independent"))
            .await
            .unwrap();
        drop(senders);
        let writer = tokio::spawn(run_reliable_writer(Arc::new(io), receivers));

        tokio::time::timeout(Duration::from_millis(100), async {
            loop {
                let (channel_id, operation, bytes) =
                    events.recv().await.expect("writer remains alive");
                if channel_id == CHANNEL_SIGNALING
                    && operation == EdgeReliableLaneOperation::Write
                    && bytes[4..] == *b"independent"
                {
                    break;
                }
            }
        })
        .await
        .expect("signaling must pass a stalled display lane");
        writer.abort();
    }

    #[test]
    fn reliable_queues_share_global_frame_and_byte_bounds_and_return_ownership() {
        let (senders, receivers) = reliable_channel_queues();
        let queued_bytes = Arc::new(AtomicUsize::new(0));
        let queued_slots = Arc::new(Semaphore::new(EDGE_RELIABLE_QUEUE_CAP));
        for sequence in 0..EDGE_RELIABLE_QUEUE_CAP {
            let channel = RELIABLE_STREAM_CHANNELS[sequence % RELIABLE_STREAM_CHANNELS.len()];
            try_enqueue_reliable_payload(
                &senders,
                &queued_bytes,
                &queued_slots,
                channel,
                ReliablePayload::Heap(Vec::new()),
            )
            .expect("shared global slot remains");
        }
        let rejected = vec![7_u8; 32];
        let rejected_ptr = rejected.as_ptr();
        let returned = try_enqueue_reliable_payload(
            &senders,
            &queued_bytes,
            &queued_slots,
            CHANNEL_SIGNALING,
            ReliablePayload::Heap(rejected),
        )
        .expect_err("the 513th cross-lane frame exceeds the global bound");
        let ReliablePayload::Heap(returned) = returned else {
            panic!("a rejected heap record comes back as the same heap record");
        };
        assert_eq!(returned.as_ptr(), rejected_ptr);
        assert_eq!(
            queued_bytes.load(Ordering::Acquire),
            5 * EDGE_RELIABLE_QUEUE_CAP
        );
        drop(senders);
        drop(receivers);
        assert_eq!(queued_bytes.load(Ordering::Acquire), 0);

        let (senders, receivers) = reliable_channel_queues();
        let queued_bytes = Arc::new(AtomicUsize::new(EDGE_RELIABLE_QUEUE_MAX_BYTES - 6));
        let queued_slots = Arc::new(Semaphore::new(EDGE_RELIABLE_QUEUE_CAP));
        try_enqueue_reliable_payload(
            &senders,
            &queued_bytes,
            &queued_slots,
            CHANNEL_CTRL,
            ReliablePayload::Heap(vec![1]),
        )
        .expect("the final six accounted bytes fit exactly");
        let rejected = vec![2];
        let rejected_ptr = rejected.as_ptr();
        let returned = try_enqueue_reliable_payload(
            &senders,
            &queued_bytes,
            &queued_slots,
            CHANNEL_PTY,
            ReliablePayload::Heap(rejected),
        )
        .expect_err("another lane cannot exceed the shared byte cap");
        let ReliablePayload::Heap(returned) = returned else {
            panic!("a rejected heap record comes back as the same heap record");
        };
        assert_eq!(returned.as_ptr(), rejected_ptr);
        drop(senders);
        drop(receivers);
        assert_eq!(
            queued_bytes.load(Ordering::Acquire),
            EDGE_RELIABLE_QUEUE_MAX_BYTES - 6
        );
    }

    /// An inline record is accounted like any other — the same slot, the same
    /// byte reservation — and is handed back whole on rejection.
    #[test]
    fn an_inline_reliable_record_is_accounted_and_returned_whole() {
        let (senders, mut receivers) = reliable_channel_queues();
        let queued_bytes = Arc::new(AtomicUsize::new(0));
        let queued_slots = Arc::new(Semaphore::new(1));
        let record = ReliablePayload::inline(
            INLINE_RELIABLE_PAYLOAD_BYTES,
            [0x3C; INLINE_RELIABLE_PAYLOAD_BYTES],
        );
        try_enqueue_reliable_payload(&senders, &queued_bytes, &queued_slots, CHANNEL_PTY, record)
            .expect("one slot admits one record");
        assert_eq!(
            queued_bytes.load(Ordering::Acquire),
            INLINE_RELIABLE_PAYLOAD_BYTES + 5,
            "an inline record reserves its bytes plus the channel/length accounting"
        );
        let returned = try_enqueue_reliable_payload(
            &senders,
            &queued_bytes,
            &queued_slots,
            CHANNEL_PTY,
            ReliablePayload::inline(4, [0x7E; INLINE_RELIABLE_PAYLOAD_BYTES]),
        )
        .expect_err("the single slot is taken");
        assert!(
            matches!(returned, ReliablePayload::Inline { len: 4, .. }),
            "a rejected inline record comes back inline"
        );
        assert_eq!(returned.as_slice(), &[0x7E; 4]);
        let (channel_id, rx) = receivers
            .iter_mut()
            .find(|(channel_id, _)| *channel_id == CHANNEL_PTY)
            .expect("the PTY lane has a queue");
        assert_eq!(*channel_id, CHANNEL_PTY);
        let queued = rx.try_recv().expect("the admitted record is queued");
        assert_eq!(
            queued.payload.as_slice(),
            &[0x3C; INLINE_RELIABLE_PAYLOAD_BYTES]
        );
        assert_eq!(
            queued.into_payload().as_slice(),
            &[0x3C; INLINE_RELIABLE_PAYLOAD_BYTES]
        );
        assert_eq!(queued_bytes.load(Ordering::Acquire), 0);
    }

    /// Exact allocation oracle for the inline arm: admitting an input-ack-sized
    /// record onto a persistent lane allocates nothing. Bracketed by the
    /// process-wide counting allocator, so it runs alone (`--exact`).
    #[test]
    #[ignore = "exact allocation oracle; the counting allocator is process-wide"]
    fn an_inline_reliable_record_is_admitted_without_allocating() {
        let (senders, receivers) = reliable_channel_queues();
        let queued_bytes = Arc::new(AtomicUsize::new(0));
        let queued_slots = Arc::new(Semaphore::new(EDGE_RELIABLE_QUEUE_CAP));
        let record = || {
            ReliablePayload::inline(
                INLINE_RELIABLE_PAYLOAD_BYTES,
                [0x5A; INLINE_RELIABLE_PAYLOAD_BYTES],
            )
        };
        // Warm the lane so first-touch queue growth is not attributed to the
        // steady state.
        try_enqueue_reliable_payload(
            &senders,
            &queued_bytes,
            &queued_slots,
            CHANNEL_PTY,
            record(),
        )
        .expect("warm admission");

        test_allocations::begin();
        for _ in 0..8 {
            try_enqueue_reliable_payload(
                &senders,
                &queued_bytes,
                &queued_slots,
                CHANNEL_PTY,
                record(),
            )
            .expect("steady admission");
        }
        let tally = test_allocations::end();
        assert_eq!(
            tally,
            test_allocations::Tally {
                allocations: 0,
                allocated_bytes: 0,
            },
            "admitting an inline reliable record must not touch the heap"
        );

        test_allocations::begin();
        try_enqueue_reliable_payload(
            &senders,
            &queued_bytes,
            &queued_slots,
            CHANNEL_PTY,
            ReliablePayload::Heap(vec![0x5A; INLINE_RELIABLE_PAYLOAD_BYTES]),
        )
        .expect("heap admission");
        let superseded = test_allocations::end();
        assert_eq!(
            superseded.allocations, 1,
            "the superseded arm allocates the record it moves"
        );
        drop(senders);
        drop(receivers);
    }

    #[test]
    fn first_reliable_lane_failure_wins_the_generation() {
        let (failure_tx, failure_rx) = watch::channel(None);
        let closing = AtomicBool::new(false);
        let first = EdgeReliableLaneFailure {
            direction: EdgeReliableLaneDirection::Receive,
            channel_id: Some(CHANNEL_PTY),
            operation: EdgeReliableLaneOperation::ReadPayload,
            kind: EdgeReliableLaneFailureKind::Reset,
        };
        let later = EdgeReliableLaneFailure {
            direction: EdgeReliableLaneDirection::Send,
            channel_id: Some(CHANNEL_CTRL),
            operation: EdgeReliableLaneOperation::Write,
            kind: EdgeReliableLaneFailureKind::Transport,
        };
        assert!(publish_reliable_failure(&failure_tx, &closing, first));
        assert!(closing.load(Ordering::Acquire));
        assert!(!publish_reliable_failure(&failure_tx, &closing, later));
        assert_eq!(*failure_rx.borrow(), Some(first));

        let (failure_tx, failure_rx) = watch::channel(None);
        closing.store(true, Ordering::Release);
        assert!(!publish_reliable_failure(&failure_tx, &closing, later));
        assert_eq!(*failure_rx.borrow(), None);
    }

    #[test]
    fn reliable_send_after_close_returns_the_original_allocation() {
        let (capture_tx, mut capture_rx) = mpsc::unbounded_channel();
        let tunnel = EdgeTunnel::new_capture(capture_tx);
        tunnel.close();
        let payload = vec![0xA5; 32];
        let payload_ptr = payload.as_ptr();

        let returned = tunnel
            .send_reliable(CHANNEL_CTRL, ReliablePayload::Heap(payload))
            .expect_err("a closed generation cannot admit reliable payloads");

        let ReliablePayload::Heap(returned) = returned else {
            panic!("a rejected heap record comes back as the same heap record");
        };
        assert_eq!(returned.as_ptr(), payload_ptr);
        assert!(capture_rx.try_recv().is_err());
    }

    #[test]
    fn receiver_failure_fences_later_reliable_admission() {
        let (capture_tx, mut capture_rx) = mpsc::unbounded_channel();
        let tunnel = EdgeTunnel::new_capture(capture_tx);
        let (failure_tx, failure_rx) = watch::channel(None);
        let failure = EdgeReliableLaneFailure {
            direction: EdgeReliableLaneDirection::Receive,
            channel_id: Some(CHANNEL_PTY),
            operation: EdgeReliableLaneOperation::ReadPayload,
            kind: EdgeReliableLaneFailureKind::Reset,
        };
        assert!(publish_reliable_failure(
            &failure_tx,
            &tunnel.closing,
            failure
        ));
        assert_eq!(*failure_rx.borrow(), Some(failure));

        let payload = vec![0x5A; 32];
        let payload_ptr = payload.as_ptr();
        let returned = tunnel
            .send_reliable(CHANNEL_PTY, ReliablePayload::Heap(payload))
            .expect_err("receive failure closes this generation's admission");
        let ReliablePayload::Heap(returned) = returned else {
            panic!("a rejected heap record comes back as the same heap record");
        };
        assert_eq!(returned.as_ptr(), payload_ptr);
        assert!(capture_rx.try_recv().is_err());
    }

    /// An owner ingress queue of `depth` and the identity a tunnel stamps on
    /// what it delivers there.
    fn test_ingress(depth: usize) -> (EdgeIngress, mpsc::Receiver<PeerMessage>) {
        let (tx, rx) = mpsc::channel(depth);
        let ingress = EdgeIngress {
            tx,
            peer_node_id: Arc::from("peer"),
            identity: EdgeIngressIdentity {
                session_id: Arc::from("session"),
                generation: 7,
                lane: EdgeLane::Interactive,
            },
        };
        (ingress, rx)
    }

    /// What already occupies the owner's queue when a test needs it full.
    fn queued_message(ingress: &EdgeIngress, payload: &'static [u8]) -> PeerMessage {
        ingress.message(
            CHANNEL_CTRL,
            bytes::Bytes::from_static(payload),
            DeliveryMode::Stream,
            None,
        )
    }

    fn reliable_record(payload: &[u8]) -> Vec<u8> {
        let mut record = (payload.len() as u32).to_be_bytes().to_vec();
        record.extend_from_slice(payload);
        record
    }

    #[tokio::test]
    async fn reliable_reader_waits_for_owner_capacity_and_preserves_order() {
        let (ingress, mut rx) = test_ingress(1);
        ingress
            .tx
            .send(queued_message(&ingress, b"first"))
            .await
            .unwrap();
        let (mut send, recv) = tokio::io::duplex(64);
        let mut reader = tokio::spawn(run_reliable_reader(recv, CHANNEL_CTRL, ingress));
        send.write_all(&reliable_record(b"second")).await.unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(20), &mut reader)
                .await
                .is_err(),
            "a reliable record waits while the owner's bounded queue is full"
        );
        assert!(
            rx.try_recv()
                .is_ok_and(|message| &message.payload[..] == b"first")
        );
        assert_eq!(&rx.recv().await.unwrap().payload[..], b"second");
        reader.abort();
    }

    #[tokio::test]
    async fn reliable_reader_reports_a_closed_owner() {
        let (ingress, rx) = test_ingress(1);
        drop(rx);
        let (mut send, recv) = tokio::io::duplex(64);
        let reader = tokio::spawn(run_reliable_reader(recv, CHANNEL_CTRL, ingress));
        send.write_all(&reliable_record(b"closed")).await.unwrap();
        let failure = reader.await.unwrap().unwrap_err();
        assert_eq!(
            failure.failure,
            EdgeReliableLaneFailure {
                direction: EdgeReliableLaneDirection::Receive,
                channel_id: Some(CHANNEL_CTRL),
                operation: EdgeReliableLaneOperation::Enqueue,
                kind: EdgeReliableLaneFailureKind::ConsumerClosed,
            }
        );
    }

    /// The acceptor ends its readers this way when the tunnel's connection
    /// closes or a successor source displaces them. A record that was waiting
    /// for the owner then never arrives, and the owner's queue is released.
    #[tokio::test]
    async fn a_retired_reader_blocked_on_owner_capacity_enqueues_nothing() {
        let (ingress, mut rx) = test_ingress(1);
        ingress
            .tx
            .send(queued_message(&ingress, b"first"))
            .await
            .unwrap();
        let (mut send, recv) = tokio::io::duplex(64);
        let mut readers = JoinSet::new();
        readers.spawn(run_reliable_reader(recv, CHANNEL_CTRL, ingress));
        send.write_all(&reliable_record(b"must-not-enqueue"))
            .await
            .unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(20), readers.join_next())
                .await
                .is_err(),
            "the record is waiting on the full queue"
        );

        readers.shutdown().await;
        assert_eq!(&rx.recv().await.unwrap().payload[..], b"first");
        assert!(
            rx.recv().await.is_none(),
            "the retired reader's record never enters the owner's queue"
        );
    }

    #[tokio::test]
    async fn edge_datagram_never_waits_behind_a_full_owner_queue() {
        let (ingress, mut rx) = test_ingress(1);
        ingress
            .tx
            .send(queued_message(&ingress, b"first"))
            .await
            .unwrap();
        let dropped_before = inbound_datagram_queue_drops();

        assert!(
            matches!(
                ingress.enqueue_datagram(bytes::Bytes::from_static(b"\x05dropped")),
                DatagramEnqueueResult::DroppedFull
            ),
            "a full queue is lossy, not a closed consumer"
        );
        assert!(inbound_datagram_queue_drops() > dropped_before);
        assert_eq!(&rx.recv().await.unwrap().payload[..], b"first");
        assert!(
            rx.try_recv().is_err(),
            "full-queue datagram must be dropped"
        );
    }

    #[test]
    fn edge_datagram_reports_a_closed_owner() {
        let (ingress, rx) = test_ingress(1);
        drop(rx);
        assert!(matches!(
            ingress.enqueue_datagram(bytes::Bytes::from_static(b"\x05closed")),
            DatagramEnqueueResult::Closed
        ));
    }

    #[test]
    fn preface_is_length_delimited_json() {
        let credential = EdgeAdmission::for_test().current().expect("test credential");
        let framed = build_preface("sess-1", &credential);
        let len = u32::from_be_bytes([framed[0], framed[1], framed[2], framed[3]]) as usize;
        assert_eq!(len, framed.len() - 4);
        let json = std::str::from_utf8(&framed[4..]).unwrap();
        assert!(json.contains(r#""role":"daemon""#));
        assert!(json.contains(r#""session_id":"sess-1""#));
        assert!(json.contains(&format!(r#""version":{PREFACE_VERSION}"#)));
        let v: serde_json::Value = serde_json::from_str(json).expect("valid JSON");
        assert_eq!(v["daemon_id"], "test-daemon");
        assert_eq!(v["ticket"], "test-ticket");
        assert_eq!(v["attachment"]["kind"], "tunnel");
        assert_eq!(v["attachment"]["incarnation"], &*credential.incarnation);
    }

    #[test]
    fn admission_requires_both_the_daemon_id_and_a_ticket() {
        let admission = EdgeAdmission::default();
        assert_eq!(admission.current(), None);
        admission.set_ticket("ticket-1");
        assert_eq!(admission.current(), None, "no daemon id yet");
        admission.set_daemon_id("daemon-1");
        admission.set_ticket("ticket-2");
        let credential = admission.current().expect("both halves");
        assert_eq!(&*credential.daemon_id, "daemon-1");
        assert_eq!(&*credential.ticket, "ticket-2", "the newest ticket wins");
        assert_eq!(credential.incarnation.len(), 22);
        assert_ne!(
            EdgeAdmission::default().current().map(|c| c.incarnation),
            Some(credential.incarnation),
            "every process draws its own incarnation"
        );
    }

    #[test]
    fn a_lease_replaces_pins_and_announces_once_per_edge() {
        let admission = EdgeAdmission::default();
        let edge = "https://edge.example:4433".to_string();
        assert!(
            admission
                .update("ticket-1", vec![(edge.clone(), vec![[1; 32], [2; 32]])])
                .is_empty(),
            "no daemon id yet: nothing can be announced"
        );
        assert_eq!(admission.pins(&edge).as_deref(), Some(&[[1; 32], [2; 32]][..]));
        admission.set_daemon_id("daemon-1");
        let pending = admission.update("ticket-2", vec![(edge.clone(), vec![[2; 32], [3; 32]])]);
        assert_eq!(pending.len(), 1);
        assert_eq!(admission.pins(&edge).as_deref(), Some(&[[2; 32], [3; 32]][..]));
        assert!(
            admission
                .update("ticket-3", vec![(edge.clone(), vec![[2; 32], [3; 32]])])
                .is_empty(),
            "a statement on its way is not made twice"
        );
        admission.announced(&edge, false);
        assert_eq!(
            admission
                .update("ticket-4", vec![(edge.clone(), vec![[2; 32], [3; 32]])])
                .len(),
            1,
            "a failed statement is made again with the next lease"
        );
        admission.announced(&edge, true);
        assert!(
            admission
                .update("ticket-5", vec![(edge.clone(), vec![[2; 32], [3; 32]])])
                .is_empty()
        );
        // A session start is the newest statement of its edge's hashes.
        let config = EdgeConfig::from_hashes(
            &edge,
            &[base64::Engine::encode(
                &base64::engine::general_purpose::STANDARD,
                [9u8; 32],
            )],
            &admission,
        )
        .expect("session edge");
        assert_eq!(&*config.pins(), &[[9; 32]]);
    }

    #[test]
    fn preface_escapes_special_chars_in_session_id() {
        // A server-supplied session_id containing JSON metacharacters must be
        // escaped, not interpolated raw (which corrupted the preface or injected
        // sibling fields). The framed body must parse back as one field set.
        let credential = EdgeAdmission::for_test().current().expect("test credential");
        let framed = build_preface("a\"b\\c\nd\te", &credential);
        let len = u32::from_be_bytes([framed[0], framed[1], framed[2], framed[3]]) as usize;
        assert_eq!(len, framed.len() - 4);
        let json = std::str::from_utf8(&framed[4..]).unwrap();
        let v: serde_json::Value = serde_json::from_str(json).expect("valid JSON");
        assert_eq!(v["session_id"], "a\"b\\c\nd\te");
        assert_eq!(v["role"], "daemon");
        assert_eq!(v["version"], PREFACE_VERSION);
    }

    #[tokio::test]
    async fn reliable_reader_parses_fragmented_multiple_records_on_one_lane() {
        let (mut send, recv) = tokio::io::duplex(64);
        let (ingress, mut rx) = test_ingress(2);
        let reader = tokio::spawn(run_reliable_reader(recv, CHANNEL_PTY, ingress));

        let mut records = Vec::new();
        for payload in [b"first".as_slice(), b"second-record".as_slice()] {
            records.extend_from_slice(&(payload.len() as u32).to_be_bytes());
            records.extend_from_slice(payload);
        }
        for fragment in records.chunks(3) {
            send.write_all(fragment).await.unwrap();
            tokio::task::yield_now().await;
        }

        assert_eq!(&rx.recv().await.unwrap().payload[..], b"first");
        assert_eq!(&rx.recv().await.unwrap().payload[..], b"second-record");
        assert!(
            !reader.is_finished(),
            "a record commits without waiting for stream FIN"
        );
        drop(send);
        let failure = reader
            .await
            .unwrap()
            .expect_err("FIN closes the generation");
        assert_eq!(
            failure.failure,
            EdgeReliableLaneFailure {
                direction: EdgeReliableLaneDirection::Receive,
                channel_id: Some(CHANNEL_PTY),
                operation: EdgeReliableLaneOperation::ReadHeader,
                kind: EdgeReliableLaneFailureKind::Finished,
            }
        );
    }

    #[tokio::test(start_paused = true)]
    async fn input_admission_credit_reaches_the_owner_and_has_no_partial_record_timeout() {
        let (mut send, recv) = tokio::io::duplex(64);
        let (ingress, mut rx) = test_ingress(4);
        let reader = tokio::spawn(run_reliable_reader(recv, CHANNEL_PTY, ingress));
        send.write_all(b"\0\0\0\x01a\0\0\0\x01b").await.unwrap();
        let message = rx.recv().await.unwrap();
        assert!(message.input_permit.is_some());
        tokio::time::advance(INBOUND_RELIABLE_PARTIAL_TIMEOUT * 2).await;
        assert!(
            !reader.is_finished(),
            "PTY backpressure is not a partial-record fault"
        );
        assert!(rx.try_recv().is_err());
        drop(message);
        let second = rx.recv().await.unwrap();
        assert_eq!(second.payload.as_ref(), b"b");
        drop(second);
        drop(send);
        let failure = reader.await.unwrap().unwrap_err();
        assert_eq!(failure.failure.kind, EdgeReliableLaneFailureKind::Finished);
    }

    #[tokio::test(start_paused = true)]
    async fn reliable_reader_idle_record_boundary_has_no_timeout() {
        let (mut send, recv) = tokio::io::duplex(64);
        let (ingress, mut rx) = test_ingress(1);
        let reader = tokio::spawn(run_reliable_reader(recv, CHANNEL_CTRL, ingress));
        send.write_all(&3_u32.to_be_bytes()).await.unwrap();
        send.write_all(b"one").await.unwrap();
        assert_eq!(&rx.recv().await.unwrap().payload[..], b"one");

        tokio::time::advance(INBOUND_RELIABLE_PARTIAL_TIMEOUT + Duration::from_secs(1)).await;
        tokio::task::yield_now().await;
        assert!(
            !reader.is_finished(),
            "idle time between complete records is transport-owned"
        );
        drop(send);
        let failure = reader
            .await
            .unwrap()
            .expect_err("FIN closes the generation");
        assert_eq!(failure.failure.kind, EdgeReliableLaneFailureKind::Finished);
    }

    #[tokio::test(start_paused = true)]
    async fn reliable_reader_partial_header_times_out_the_generation() {
        let (mut send, recv) = tokio::io::duplex(64);
        let (ingress, _rx) = test_ingress(1);
        let reader = tokio::spawn(run_reliable_reader(recv, CHANNEL_CTRL, ingress));
        send.write_all(&[0]).await.unwrap();
        tokio::task::yield_now().await;
        tokio::time::advance(INBOUND_RELIABLE_PARTIAL_TIMEOUT).await;
        let failure = reader
            .await
            .unwrap()
            .expect_err("started header owns a deadline");
        assert_eq!(
            failure.failure,
            EdgeReliableLaneFailure {
                direction: EdgeReliableLaneDirection::Receive,
                channel_id: Some(CHANNEL_CTRL),
                operation: EdgeReliableLaneOperation::ReadHeader,
                kind: EdgeReliableLaneFailureKind::TimedOut,
            }
        );
    }

    #[tokio::test]
    async fn reliable_reader_rejects_oversized_record_before_payload_allocation() {
        let (mut send, recv) = tokio::io::duplex(64);
        let (ingress, _rx) = test_ingress(1);
        let reader = tokio::spawn(run_reliable_reader(recv, CHANNEL_PTY, ingress));
        let oversized = u32::try_from(MAX_INBOUND_FRAME_BYTES + 1).unwrap();
        send.write_all(&oversized.to_be_bytes()).await.unwrap();
        let failure = reader
            .await
            .unwrap()
            .expect_err("oversized length is malformed");
        assert_eq!(
            failure.failure.operation,
            EdgeReliableLaneOperation::ReadHeader
        );
        assert_eq!(failure.failure.kind, EdgeReliableLaneFailureKind::Malformed);
    }

    #[test]
    fn reliable_channel_binding_rejects_duplicate_and_unknown_lanes() {
        let mut seen = 0;
        register_reliable_channel(&mut seen, CHANNEL_SIGNALING).unwrap();
        let duplicate = register_reliable_channel(&mut seen, CHANNEL_SIGNALING).unwrap_err();
        assert_eq!(
            duplicate.failure.kind,
            EdgeReliableLaneFailureKind::DuplicateChannel
        );
        let unknown = register_reliable_channel(&mut seen, 0xff).unwrap_err();
        assert_eq!(
            unknown.failure.kind,
            EdgeReliableLaneFailureKind::UnknownChannel
        );
        assert_eq!(unknown.failure.channel_id, Some(0xff));
    }

    #[test]
    fn reliable_reader_distinguishes_fin_reset_and_transport_errors() {
        assert_eq!(
            reader_error_kind(&std::io::Error::from(std::io::ErrorKind::UnexpectedEof)),
            EdgeReliableLaneFailureKind::Finished
        );
        assert_eq!(
            reader_error_kind(&std::io::Error::from(std::io::ErrorKind::ConnectionReset)),
            EdgeReliableLaneFailureKind::Reset
        );
        assert_eq!(
            reader_error_kind(&std::io::Error::from(std::io::ErrorKind::Other)),
            EdgeReliableLaneFailureKind::Transport
        );
    }

    async fn read_benchmark_reliable_record(
        framed_record: &[u8],
        fragment_bytes: usize,
    ) -> Vec<u8> {
        let mut reader = MockReliableReader::new(framed_record, fragment_bytes);
        let mut first_header_byte = [0_u8; 1];
        reader
            .read_exact(&mut first_header_byte)
            .await
            .expect("benchmark record length prefix");
        read_started_reliable_record(&mut reader, CHANNEL_DISPLAY_COMMIT, first_header_byte[0])
            .await
            .expect("valid benchmark record")
    }

    fn emit_reliable_ingress_latency(name: &str, samples: &mut [f64], sample_size: usize) {
        samples.sort_by(f64::total_cmp);
        for ratio in [0.50, 0.95, 0.99] {
            let index = ((samples.len() as f64 * ratio).ceil() as usize)
                .saturating_sub(1)
                .min(samples.len().saturating_sub(1));
            println!(
                "@@merkur-perf {{\"name\":\"edge-reliable-ingress-{name}\",\"value\":{},\"unit\":\"ns/frame\",\"direction\":\"lower\",\"percentile\":{ratio},\"sampleSize\":{sample_size}}}",
                samples[index]
            );
        }
    }

    fn emit_reliable_ingress_exact(
        name: &str,
        suffix: &str,
        value: usize,
        unit: &str,
        sample_size: usize,
    ) {
        println!(
            "@@merkur-perf {{\"name\":\"edge-reliable-ingress-{name}-{suffix}\",\"value\":{value},\"unit\":\"{unit}\",\"direction\":\"lower\",\"sampleSize\":{sample_size}}}"
        );
    }

    /// Invokes the production persistent-record reader through a deterministic
    /// fragmented `AsyncRead`, including length-header and direct-to-final-buffer
    /// body polls. Test-only allocator instrumentation measures every successful
    /// allocation request made while complete records are constructed.
    #[tokio::test(flavor = "current_thread")]
    #[ignore = "production performance workload"]
    async fn production_reliable_ingress_staging_benchmark() {
        let samples = std::env::var("BENCH_SAMPLES")
            .ok()
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(1_000)
            .max(3);
        let cases = [
            ("64b", 64usize, 16 * 1024usize, 512usize),
            ("1kib", 1024, 16 * 1024, 256),
            // Keep large-frame batches above roughly 200us on the candidate so
            // micro-mode p95/p99 do not collapse into scheduler noise.
            ("64kib", MAX_INBOUND_FRAME_BYTES, 16 * 1024, 256),
            ("64kib-fragmented", MAX_INBOUND_FRAME_BYTES, 257, 128),
        ];
        let mut checksum = 0usize;
        const ALLOCATION_SAMPLES: usize = 128;

        for (name, payload_bytes, fragment_bytes, batch_size) in cases {
            let payload = vec![0xa5; payload_bytes];
            let mut framed = Vec::with_capacity(payload_bytes + size_of::<u32>());
            framed.extend_from_slice(&(payload_bytes as u32).to_be_bytes());
            framed.extend_from_slice(&payload);

            for _ in 0..samples.div_ceil(10) {
                let payload = read_benchmark_reliable_record(&framed, fragment_bytes).await;
                checksum ^= payload.len();
            }

            let mut latency_samples = Vec::with_capacity(samples);
            for _ in 0..samples {
                let started = std::time::Instant::now();
                for _ in 0..batch_size {
                    let payload = read_benchmark_reliable_record(&framed, fragment_bytes).await;
                    checksum ^= payload.len();
                    std::hint::black_box(payload);
                }
                latency_samples.push(started.elapsed().as_nanos() as f64 / batch_size as f64);
            }

            emit_reliable_ingress_latency(name, &mut latency_samples, samples);
            test_allocations::begin();
            for _ in 0..ALLOCATION_SAMPLES {
                let payload = read_benchmark_reliable_record(&framed, fragment_bytes).await;
                checksum ^= payload.len();
                std::hint::black_box(payload);
            }
            let tally = test_allocations::end();
            assert_eq!(tally.allocations % ALLOCATION_SAMPLES, 0);
            assert_eq!(tally.allocated_bytes % ALLOCATION_SAMPLES, 0);
            emit_reliable_ingress_exact(
                name,
                "allocations",
                tally.allocations / ALLOCATION_SAMPLES,
                "allocations/frame",
                ALLOCATION_SAMPLES,
            );
            emit_reliable_ingress_exact(
                name,
                "allocated-bytes",
                tally.allocated_bytes / ALLOCATION_SAMPLES,
                "bytes/frame",
                ALLOCATION_SAMPLES,
            );
        }

        std::hint::black_box(checksum);
    }

    #[tokio::test]
    async fn edge_readers_stamp_their_tunnel_identity_on_what_they_deliver() {
        // What a reader delivers must reach the owner with the right channel +
        // delivery, the dial-time peer id stamped on, and via_transport = Edge
        // so carrier health stays independent from direct WT at the existing
        // inbound decrypt site.
        let (tx, mut rx) = mpsc::channel(2);
        let datagram_identity = EdgeIngressIdentity {
            session_id: Arc::from("session-1"),
            generation: 17,
            lane: crate::network::protocol::EdgeLane::Interactive,
        };
        let datagrams = EdgeIngress {
            tx: tx.clone(),
            peer_node_id: Arc::from("browser-1"),
            identity: datagram_identity.clone(),
        };
        assert!(matches!(
            datagrams.enqueue_datagram(bytes::Bytes::from_static(b"\x05sealed-display-frame")),
            DatagramEnqueueResult::Enqueued
        ));
        let msg = rx.recv().await.unwrap();
        assert_eq!(&*msg.peer_node_id, "browser-1");
        assert_eq!(msg.channel_id, 0x05);
        assert_eq!(&msg.payload[..], b"sealed-display-frame");
        assert_eq!(msg.delivery, DeliveryMode::Datagram);
        assert_eq!(msg.via_transport, PeerTransport::Edge);
        assert_eq!(msg.connection_id, 17);
        assert_eq!(msg.edge_ingress, Some(datagram_identity));

        // Reliable lane rides through as Stream delivery (the open side picks the
        // matching Noise sub-lane from this).
        let reliable_identity = EdgeIngressIdentity {
            session_id: Arc::from("session-2"),
            generation: 18,
            lane: crate::network::protocol::EdgeLane::Bulk,
        };
        let (mut send, recv) = tokio::io::duplex(64);
        let reader = tokio::spawn(run_reliable_reader(
            recv,
            CHANNEL_DISPLAY_COMMIT,
            EdgeIngress {
                tx,
                peer_node_id: Arc::from("browser-2"),
                identity: reliable_identity.clone(),
            },
        ));
        send.write_all(&reliable_record(b"sealed-reliable-commit"))
            .await
            .unwrap();
        let msg = rx.recv().await.unwrap();
        assert_eq!(&*msg.peer_node_id, "browser-2");
        assert_eq!(msg.channel_id, CHANNEL_DISPLAY_COMMIT);
        assert_eq!(&msg.payload[..], b"sealed-reliable-commit");
        assert_eq!(msg.delivery, DeliveryMode::Stream);
        assert_eq!(msg.via_transport, PeerTransport::Edge);
        assert_eq!(msg.connection_id, 18);
        assert_eq!(msg.edge_ingress, Some(reliable_identity));
        reader.abort();
    }

    #[test]
    fn edge_config_requires_exact_current_session_coordinates() {
        use base64::Engine;
        let hash32_b64 = base64::engine::general_purpose::STANDARD.encode([7u8; 32]);

        let cfg = EdgeConfig::from_hashes(
            "https://edge.example:4433",
            std::slice::from_ref(&hash32_b64),
            &EdgeAdmission::for_test(),
        )
        .expect("valid url + 32-byte hash");
        assert_eq!(cfg.url, "https://edge.example:4433");
        assert_eq!(&*cfg.pins(), &[[7u8; 32]]);

        let second_hash_b64 = base64::engine::general_purpose::STANDARD.encode([8u8; 32]);
        let cfg = EdgeConfig::from_hashes(
            "https://edge.example:4433",
            &[hash32_b64.clone(), second_hash_b64],
            &EdgeAdmission::for_test(),
        )
        .expect("rotation overlap hashes");
        assert_eq!(&*cfg.pins(), &[[7u8; 32], [8u8; 32]]);
        assert!(EdgeConfig::from_hashes("https://edge.example:4433", &[], &EdgeAdmission::for_test()).is_none());

        let padded = format!("  {hash32_b64}\n");
        let cfg = EdgeConfig::from_hashes("  https://e:4433 ", &[padded], &EdgeAdmission::for_test()).expect("trimmed");
        assert_eq!(cfg.url, "https://e:4433");
        assert_eq!(&*cfg.pins(), &[[7u8; 32]]);

        assert!(EdgeConfig::from_hashes("", std::slice::from_ref(&hash32_b64), &EdgeAdmission::for_test()).is_none());
        assert!(EdgeConfig::from_hashes("https://e:4433", &[], &EdgeAdmission::for_test()).is_none());
        assert!(EdgeConfig::from_hashes("https://e:4433", &["   ".to_string()], &EdgeAdmission::for_test()).is_none());

        let hash16_b64 = base64::engine::general_purpose::STANDARD.encode([1u8; 16]);
        assert!(EdgeConfig::from_hashes("https://e:4433", &[hash16_b64], &EdgeAdmission::for_test()).is_none());
        assert!(
            EdgeConfig::from_hashes("https://e:4433", &["not base64 !!!".to_string()], &EdgeAdmission::for_test()).is_none()
        );
    }

    #[tokio::test]
    async fn connect_backoff_rejects_zero_attempts() {
        let result = EdgeTunnel::connect_with_backoff(
            "https://edge.invalid:4433",
            "session",
            EdgeLane::Interactive,
            &wtransport::quinn::ProbeGroup::new(),
            &EdgeAdmission::for_test(),
            0,
        )
        .await;
        let Err(error) = result else {
            panic!("zero attempts must fail immediately");
        };
        assert!(error.contains("at least one"));
    }

    #[test]
    fn connect_backoff_full_jitter_preserves_every_ceiling() {
        let expected_ceilings_ms = [250, 500, 1_000, 2_000, 4_000, 5_000, 5_000];
        let mut minimum = EdgeConnectBackoff::new();
        let mut maximum = EdgeConnectBackoff::new();

        for expected_ceiling_ms in expected_ceilings_ms {
            assert_eq!(
                minimum.next_delay_from_sample(0),
                Duration::ZERO,
                "full jitter must include the lower bound"
            );
            assert_eq!(
                maximum.next_delay_from_sample(u64::MAX),
                Duration::from_millis(expected_ceiling_ms),
                "full jitter must never exceed the exponential ceiling"
            );
        }
    }

    #[test]
    fn connect_backoff_samples_have_nonzero_dispersion() {
        let delays: std::collections::HashSet<_> = [
            0,
            u64::MAX / 4,
            u64::MAX / 2,
            u64::MAX - (u64::MAX / 4),
            u64::MAX,
        ]
        .into_iter()
        .map(|sample| {
            EdgeConnectBackoff::new()
                .next_delay_from_sample(sample)
                .as_millis()
        })
        .collect();

        assert_eq!(
            delays.len(),
            5,
            "independent samples must disperse fallback attempts across the window"
        );
    }

    #[tokio::test]
    async fn connect_backoff_sleep_is_promptly_cancellation_safe() {
        let mut backoff = EdgeConnectBackoff::new();
        for _ in 0..5 {
            let _ = backoff.next_delay_from_sample(u64::MAX);
        }
        let sleeper = tokio::spawn(tokio::time::sleep(backoff.next_delay_from_sample(u64::MAX)));
        tokio::task::yield_now().await;
        sleeper.abort();

        let result = tokio::time::timeout(Duration::from_millis(100), sleeper)
            .await
            .expect("aborted fallback sleep must resolve promptly");
        assert!(
            result
                .expect_err("aborted fallback sleep must not complete")
                .is_cancelled(),
            "dropping the dial future must cancel its fallback wait"
        );
    }

    /// Live integration test against a running edge (local or the deployed Fly
    /// app). Set MERKUR_EDGE_URL + MERKUR_EDGE_CERT_HASH (base64), plus the
    /// attach tickets that edge admits: MERKUR_EDGE_DAEMON_ID,
    /// MERKUR_EDGE_DAEMON_TICKET and MERKUR_EDGE_BROWSER_TICKET for session
    /// `edge-tunnel-live`. When any is unset it returns early so the normal
    /// `cargo test` run is offline-safe.
    ///
    /// It connects this tunnel as the daemon role and a second wtransport client
    /// as the browser role (same session id), then proves a framed frame
    /// round-trips THROUGH THE EDGE in both directions on both lanes — i.e. the
    /// tunnel speaks the edge protocol and the daemon framing correctly.
    #[tokio::test]
    async fn live_edge_roundtrip() {
        let Ok(url) = std::env::var("MERKUR_EDGE_URL") else {
            return;
        };
        let Ok(hash_b64) = std::env::var("MERKUR_EDGE_CERT_HASH") else {
            return;
        };
        let (Ok(daemon_id), Ok(daemon_ticket), Ok(browser_ticket)) = (
            std::env::var("MERKUR_EDGE_DAEMON_ID"),
            std::env::var("MERKUR_EDGE_DAEMON_TICKET"),
            std::env::var("MERKUR_EDGE_BROWSER_TICKET"),
        ) else {
            return;
        };
        let daemon_credential = EdgeCredential {
            daemon_id: Arc::from(daemon_id.as_str()),
            ticket: Arc::from(daemon_ticket.as_str()),
            incarnation: Arc::from("bGl2ZWVkZ2Vyb3VuZHRyaQ"),
        };
        use base64::Engine;
        let hash_bytes = base64::engine::general_purpose::STANDARD
            .decode(hash_b64.trim())
            .expect("cert hash base64");
        let hash: [u8; 32] = hash_bytes.as_slice().try_into().expect("32-byte hash");
        let session_id = "edge-tunnel-live".to_string();

        // Daemon role = this tunnel.
        let tunnel = EdgeTunnel::connect(
            &url,
            &[hash],
            &session_id,
            EdgeLane::Interactive,
            &wtransport::quinn::ProbeGroup::new(),
            &daemon_credential,
        )
            .await
            .expect("daemon tunnel connect");
        let (ingress, mut rx) = test_ingress(64);
        tunnel.spawn_receivers(ingress);

        // Browser role = a second wtransport client (mirrors the probe).
        let browser_config = ClientConfig::builder()
            .with_bind_default()
            .with_server_certificate_hashes([Sha256Digest::new(hash)])
            .build();
        let browser = Endpoint::client(browser_config)
            .expect("browser client")
            .connect(&url)
            .await
            .expect("browser connect");
        let (mut bsend, _brecv) = browser
            .open_bi()
            .await
            .expect("browser open_bi")
            .await
            .expect("browser open_bi await");
        bsend
            .write_all(
                &RoutingPreface {
                    session_id: session_id.clone(),
                    role: Role::Browser,
                    version: PREFACE_VERSION,
                    attachment: RoutingAttachment::Primary,
                    daemon_id: daemon_id.clone(),
                    ticket: browser_ticket.clone(),
                }
                .encode(),
            )
            .await
            .expect("browser preface");

        // browser -> daemon: framed datagram on CHANNEL_DISPLAY_ACK (0x05).
        let payload = b"sealed-input-frame".to_vec();
        let mut datagram_ok = false;
        for _ in 0..25 {
            let mut framed = vec![0x05u8];
            framed.extend_from_slice(&payload);
            let _ = browser.send_datagram(framed);
            if tokio::time::timeout(Duration::from_millis(200), rx.recv())
                .await
                .is_ok_and(|frame| {
                    frame.is_some_and(|frame| {
                        frame.channel_id == 0x05
                            && frame.payload == payload
                            && frame.delivery == DeliveryMode::Datagram
                    })
                })
            {
                datagram_ok = true;
                break;
            }
        }
        assert!(
            datagram_ok,
            "browser->daemon framed datagram did not arrive via edge"
        );

        // daemon -> browser: framed datagram, browser reads [channel][payload].
        let reply = b"sealed-display-frame".to_vec();
        let mut reply_ok = false;
        for _ in 0..25 {
            tunnel.send_framed_datagram(&bytes::Bytes::from([&[0x03][..], &reply].concat()));
            if tokio::time::timeout(Duration::from_millis(200), browser.receive_datagram())
                .await
                .is_ok_and(|received| {
                    received.is_ok_and(|d| {
                        let bytes = d.payload();
                        bytes.first() == Some(&0x03) && &bytes[1..] == reply.as_slice()
                    })
                })
            {
                reply_ok = true;
                break;
            }
        }
        assert!(
            reply_ok,
            "daemon->browser framed datagram did not arrive via edge"
        );

        // browser -> daemon: two records reuse one persistent channel-bound
        // reliable lane.
        let reliable = b"sealed-reliable-commit".to_vec();
        let reliable_second = b"sealed-reliable-commit-second".to_vec();
        let mut reliable_stream = browser.open_uni().await.unwrap().await.unwrap();
        reliable_stream
            .write_all(&[CHANNEL_DISPLAY_COMMIT])
            .await
            .unwrap();
        reliable_stream
            .write_all(&(reliable.len() as u32).to_be_bytes())
            .await
            .unwrap();
        reliable_stream.write_all(&reliable).await.unwrap();
        reliable_stream
            .write_all(&(reliable_second.len() as u32).to_be_bytes())
            .await
            .unwrap();
        reliable_stream.write_all(&reliable_second).await.unwrap();
        for expected in [&reliable, &reliable_second] {
            let frame = tokio::time::timeout(Duration::from_secs(3), rx.recv())
                .await
                .expect("browser reliable record timed out")
                .expect("daemon reliable receiver closed");
            assert_eq!(frame.channel_id, CHANNEL_DISPLAY_COMMIT);
            assert_eq!(&frame.payload[..], &expected[..]);
            assert_eq!(frame.delivery, DeliveryMode::Stream);
        }

        // daemon -> browser: the production writer moves both payloads through
        // one persistent CTRL lane, and the browser accepts that lane once.
        let ctrl_first = b"sealed-reliable-control".to_vec();
        let ctrl_second = b"sealed-reliable-control-second".to_vec();
        tunnel
            .send_reliable(CHANNEL_CTRL, ReliablePayload::Heap(ctrl_first.clone()))
            .expect("daemon reliable admission");
        tunnel
            .send_reliable(CHANNEL_CTRL, ReliablePayload::Heap(ctrl_second.clone()))
            .expect("daemon second reliable admission");
        let mut daemon_lane = tokio::time::timeout(Duration::from_secs(3), browser.accept_uni())
            .await
            .expect("daemon reliable lane timed out")
            .expect("browser reliable lane accept");
        let mut channel = [0_u8; 9];
        daemon_lane
            .read_exact(&mut channel)
            .await
            .expect("daemon reliable channel prefix");
        assert_eq!(channel[8], CHANNEL_CTRL);
        for expected in [&ctrl_first, &ctrl_second] {
            let mut header = [0_u8; size_of::<u32>()];
            daemon_lane
                .read_exact(&mut header)
                .await
                .expect("daemon reliable record header");
            assert_eq!(u32::from_be_bytes(header) as usize, expected.len());
            let mut body = vec![0_u8; expected.len()];
            daemon_lane
                .read_exact(&mut body)
                .await
                .expect("daemon reliable record body");
            assert_eq!(&body, expected);
        }
        tunnel.close();
    }
}

#[cfg(test)]
mod lane_lifetime_tests {
    use super::*;

    /// A clean lane end frees its channel; a fault does not.
    ///
    /// This is what lets a tunnel outlive the carrier on the other side of the
    /// splice. Every browser carrier loss ends these readers, and failing the
    /// generation there would close the tunnel being held for that browser's
    /// return — taking the rebind's own signaling channel with it.
    #[test]
    fn a_released_channel_can_be_claimed_again() {
        let mut seen = 0_u8;
        register_reliable_channel(&mut seen, CHANNEL_CTRL).expect("first bind");
        assert!(
            register_reliable_channel(&mut seen, CHANNEL_CTRL).is_err(),
            "a live channel cannot be bound twice"
        );

        release_reliable_channel(&mut seen, CHANNEL_CTRL);
        register_reliable_channel(&mut seen, CHANNEL_CTRL)
            .expect("a released channel is claimable by the returning peer");
    }

    #[test]
    fn releasing_one_channel_leaves_the_others_bound() {
        let mut seen = 0_u8;
        register_reliable_channel(&mut seen, CHANNEL_CTRL).expect("ctrl");
        register_reliable_channel(&mut seen, CHANNEL_PTY).expect("pty");
        release_reliable_channel(&mut seen, CHANNEL_CTRL);
        assert!(
            register_reliable_channel(&mut seen, CHANNEL_PTY).is_err(),
            "an untouched channel stays bound"
        );
        register_reliable_channel(&mut seen, CHANNEL_CTRL).expect("ctrl rebinds");
    }

    /// An unknown channel is not silently released either.
    #[test]
    fn releasing_an_unknown_channel_is_inert() {
        let mut seen = 0_u8;
        register_reliable_channel(&mut seen, CHANNEL_CTRL).expect("ctrl");
        release_reliable_channel(&mut seen, 0xfe);
        assert!(register_reliable_channel(&mut seen, CHANNEL_CTRL).is_err());
    }
}

#[cfg(test)]
mod browser_path_tests {
    use super::*;

    /// Mirrors `SpliceControlEvent::CounterpartPath` in `apps/edge/src/splice.rs`.
    #[test]
    fn the_edges_path_report_parses_with_its_attachment() {
        let event: SpliceControlEvent = serde_json::from_str(
            r#"{"type":"counterpart_path","counterpart_attachment_id":7,"address":"203.0.113.9"}"#,
        )
        .expect("the edge's wire shape");
        assert!(matches!(
            event,
            SpliceControlEvent::CounterpartPath {
                counterpart_attachment_id: 7,
                address,
            } if address == "203.0.113.9".parse::<std::net::IpAddr>().unwrap()
        ));
    }

    /// A report names its attachment. Until the browser attachment it names is
    /// the paired one, the tunnel has no browser address to offer against.
    #[test]
    fn a_path_report_counts_only_for_the_paired_attachment() {
        let (capture, _captured) = mpsc::unbounded_channel();
        let tunnel = EdgeTunnel::new_capture(capture);
        assert_eq!(tunnel.browser_address(), None);
        let address: std::net::IpAddr = "198.51.100.23".parse().unwrap();
        tunnel.set_browser_path_for_test(Some(EdgeBrowserPath {
            attachment_id: 2,
            address,
        }));
        assert_eq!(
            tunnel.browser_address(),
            None,
            "a report for an attachment that is not paired"
        );
        tunnel.set_browser_path_for_test(Some(EdgeBrowserPath {
            attachment_id: 1,
            address,
        }));
        assert_eq!(tunnel.browser_address(), Some(address));
    }
}
