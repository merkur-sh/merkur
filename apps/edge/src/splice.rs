//! Splice core: the blind relay's session registry and bidirectional
//! datagram, durable-lane and finite-transfer forwarding engine.
//!
//! # BLIND RELAY INVARIANT (security-critical)
//!
//! The edge relay is a *blind* splice. It pairs a browser WebTransport
//! session with the matching daemon HTTP/3 tunnel session and copies opaque
//! frames between them. It holds **no Noise secret keys, ML-KEM secret material,
//! daemon identity signing seed, or session-token signing key**. Terminal-channel
//! payloads are Noise-AEAD ciphertext end-to-end (browser <-> daemon); the edge
//! cannot and does not decrypt them.
//!
//! Concretely, NOTHING in this module (or this crate) inspects, transforms, or
//! branches on the application *contents* of a data frame. The edge reads only
//! transport envelopes: the [`RoutingPreface`], a stream-lifecycle flag and each
//! record/transfer's declared length for bounded retained-byte accounting.
//! It never interprets channel/tag bits or application body bytes.
//! Do not add a code path that interprets data-frame contents — doing so breaks
//! the end-to-end confidentiality property of the live protocol.

// A latency path: forwarding waits on the event itself, never on a clock. `clippy.toml` lists
// the timer calls this denies.
#![cfg_attr(not(test), deny(clippy::disallowed_methods))]

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering, Ordering as AtomicOrdering};

use crate::metrics;
use std::sync::Arc;
use std::time::{Duration, Instant};

#[cfg(test)]
use bytes::Bytes;
use parking_lot::{RwLock, RwLockReadGuard, RwLockWriteGuard};
use serde::{Deserialize, Serialize};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, mpsc, oneshot, watch};
use wtransport::quinn::ProbeGroup;
use wtransport::datagram::DatagramBatch;
use wtransport::{Connection, RecvStream, SendStream};

/// The routing preface and splice-control events are the edge's contract with
/// both peers, one definition shared with the daemon and the client. After the
/// preface, channel ids and bodies stay opaque and are forwarded verbatim: the
/// edge reads only each reliable record's declared body length for bounds and
/// in-progress-byte accounting.
pub use merkur_edge_protocol::{
    MAX_PREFACE_LEN, PREFACE_VERSION, Role, RoutingAttachment, RoutingPreface, SpliceControlEvent,
};

impl From<Role> for crate::attach_ticket::TicketRole {
    /// The attach-ticket role this end must present.
    fn from(role: Role) -> Self {
        match role {
            Role::Browser => Self::Browser,
            Role::Daemon => Self::Daemon,
        }
    }
}

/// Bounded datagram mailbox depth for each side of a spliced session.
pub const SPLICE_MAILBOX_DEPTH: usize = 256;

/// Persistent reliable streams begin with one opaque channel byte, followed by
/// zero or more `[u32 big-endian body length][opaque body]` records.
pub const RELIABLE_CHANNEL_PREFIX_BYTES: usize = 1;
pub const RELIABLE_RECORD_HEADER_BYTES: usize = 4;

/// Preserve the existing reliable record ceiling across the hard cut. The
/// channel prefix is now paid once per stream rather than once per record.
pub const MAX_RELIABLE_FRAME: usize = 8 * 1024 * 1024;

/// Maximum opaque body declared by a reliable transport envelope.
pub const MAX_RELIABLE_BODY: usize =
    MAX_RELIABLE_FRAME - RELIABLE_CHANNEL_PREFIX_BYTES - RELIABLE_RECORD_HEADER_BYTES;

/// Current logical reliable channels are signaling, PTY, control, display
/// commit, and bulk ownership. The edge never reads their ids, but this fixed
/// count bounds accepted, pending, and attached persistent stream ownership.
pub const MAX_RELIABLE_LANES_PER_PEER: usize = 5;

/// High bit of the stream prefix selects finite ownership. The remaining seven
/// bits are opaque to the edge, just like durable channel identities.
pub const FINITE_STREAM_FLAG: u8 = 0x80;
pub const MAX_FINITE_STREAMS_PER_PEER: usize = 32;
/// Whole sealed transfer ceiling, including its endpoint-owned framing.
pub const MAX_FINITE_STREAM_BYTES: usize = 16 * 1024 * 1024;
/// Separate from durable record credit, so blocked content cannot reserve it.
pub const SPLICE_FINITE_BYTES_PER_DIRECTION: usize = 64 * 1024 * 1024;
pub const SPLICE_FINITE_BYTES_GLOBAL: usize = 256 * 1024 * 1024;

/// Reliable frame bytes retained for one session in one destination direction,
/// shared by the unattached-peer queue, attached mailbox, and active writes.
/// This admits two maximum-size frames without allowing a 256-frame mailbox to
/// retain gigabytes.
pub const SPLICE_RELIABLE_BYTES_PER_DIRECTION: usize = 16 * 1024 * 1024;

/// Registry-wide ceiling across queued and actively-written reliable frames.
/// Directional permits enforce fairness; this cap bounds aggregate host memory
/// even when many routing labels are active.
pub const SPLICE_RELIABLE_BYTES_GLOBAL: usize = 256 * 1024 * 1024;

/// Global bound across paired and half-paired sessions. The edge is not an
/// authentication boundary, so random routing labels must not grow the registry
/// without limit.
pub const MAX_SPLICE_SESSIONS: usize = 4096;

/// Extra transport-session tasks allowed beyond the maximum 2 peers per
/// registry slot. This absorbs reconnect overlap and in-flight prefaces without
/// leaving handshake/session task creation unbounded.
pub const SPLICE_SESSION_TASK_HEADROOM: usize = 1024;

/// Process-wide ceiling for accepted WebTransport session tasks. A fully paired
/// registry uses at most `2 * MAX_SPLICE_SESSIONS`; the additional headroom
/// keeps reconnect admission off the steady-state capacity boundary.
pub const MAX_SPLICE_SESSION_TASKS: usize = 2 * MAX_SPLICE_SESSIONS + SPLICE_SESSION_TASK_HEADROOM;

/// A lone peer has ample time to survive server signaling and daemon dial
/// retries, but cannot reserve a registry slot forever.
pub const UNPAIRED_SESSION_TTL: Duration = Duration::from_secs(60);

/// Opaque datagrams one read took together. Reliable traffic transfers stream
/// ownership through [`AcceptedReliableLane`] instead of materializing a frame here.
#[derive(Clone, Debug)]
pub struct Frame {
    pub lane: Lane,
    /// Opaque bytes. NEVER interpreted by the edge. See the blind-relay
    /// invariant at the top of this module. The datagrams one QUIC packet
    /// carried arrive in one batch, and egress admits a batch under one hold, so
    /// they leave in one packet too. Reference-counted storage lets the
    /// datagram ingress path retain wtransport's receive allocation directly
    /// instead of copying every packet into a second heap allocation.
    pub datagrams: DatagramBatch,
    /// The source attachment's receipt of this datagram, the origin of its
    /// relay residence, while the session's daemon asks for contention
    /// evidence. Transport metadata, never part of its identity.
    pub received_at: Option<Instant>,
}

impl Frame {
    /// One datagram whose relay residence nobody asked for.
    #[cfg(test)]
    pub fn datagram(payload: Bytes) -> Self {
        Self::datagrams(DatagramBatch::single(payload))
    }

    /// Datagrams received together, whose relay residence nobody asked for.
    pub fn datagrams(datagrams: DatagramBatch) -> Self {
        Self {
            lane: Lane::Datagram,
            datagrams,
            received_at: None,
        }
    }

    /// Datagrams received together now, their residence to be recorded.
    pub fn timed_datagrams(datagrams: DatagramBatch) -> Self {
        Self {
            lane: Lane::Datagram,
            datagrams,
            received_at: Some(Instant::now()),
        }
    }
}

/// A frame is its lane and bytes; when the relay received it is not.
impl PartialEq for Frame {
    fn eq(&self, other: &Self) -> bool {
        self.lane == other.lane && self.datagrams.payloads() == other.datagrams.payloads()
    }
}
impl Eq for Frame {}

/// Whether a session's daemon asks for contention evidence, owned by the
/// daemon attachment that spoke last: `attachment << 1 | asking`. A successor
/// states its own request on its quote stream before anything else, so a
/// predecessor whose stream ends afterwards cannot withdraw it.
#[derive(Clone, Default)]
pub struct ContentionRequests(Arc<AtomicU64>);

impl ContentionRequests {
    pub fn asked(&self) -> bool {
        self.0.load(AtomicOrdering::Relaxed) & 1 != 0
    }

    pub fn set(&self, attachment: AttachmentId, asking: bool) {
        self.0.store(
            attachment.as_u64() << 1 | u64::from(asking),
            AtomicOrdering::Relaxed,
        );
    }

    /// This attachment's requests ended; withdraw them unless a successor
    /// has spoken since.
    pub fn end(&self, attachment: AttachmentId) {
        let _ = self
            .0
            .fetch_update(AtomicOrdering::Relaxed, AtomicOrdering::Relaxed, |word| {
                (word >> 1 == attachment.as_u64()).then_some(attachment.as_u64() << 1)
            });
    }
}

/// Log2 microsecond buckets of daemon-to-browser datagram residence: bucket 0
/// is below 16 us, bucket `i` covers `[2^(i+3), 2^(i+4))` us, and the last is
/// open at 16.384 ms. A wire fact: the daemon mirror reads this many buckets.
pub const FORWARD_RESIDENCE_BUCKETS: usize = 12;

/// Per-session histogram of the relay's datagram residence: the source
/// attachment's receipt to admission on this connection. Written by the
/// outbound pump with one relaxed increment and read by the quote tick.
#[derive(Default)]
pub struct ForwardResidence([AtomicU32; FORWARD_RESIDENCE_BUCKETS]);

impl ForwardResidence {
    pub fn record(&self, residence: Duration) {
        let micros = u64::try_from(residence.as_micros()).unwrap_or(u64::MAX);
        let bucket = ((u64::BITS - micros.leading_zeros()) as usize)
            .saturating_sub(4)
            .min(FORWARD_RESIDENCE_BUCKETS - 1);
        self.0[bucket].fetch_add(1, AtomicOrdering::Relaxed);
    }

    pub fn snapshot(&self) -> [u32; FORWARD_RESIDENCE_BUCKETS] {
        std::array::from_fn(|bucket| self.0[bucket].load(AtomicOrdering::Relaxed))
    }
}

/// Transport lane an opaque frame travels on. Mirrors WebTransport's two
/// delivery modes so the relay forwards reliable-as-reliable and
/// datagram-as-datagram.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Lane {
    /// Unreliable datagram (low-latency display deltas / input).
    Datagram,
}

/// Validate only a reliable record's declared body length. Channel identity and
/// body bytes remain opaque to the edge.
pub fn reliable_body_len_from_header(header: &[u8]) -> Option<usize> {
    if header.len() != RELIABLE_RECORD_HEADER_BYTES {
        return None;
    }
    let body_len = u32::from_be_bytes(header.try_into().ok()?) as usize;
    (body_len <= MAX_RELIABLE_BODY).then_some(body_len)
}

/// A newly accepted reliable stream before lifecycle classification. Its permit
/// bounds all pending and admitted streams; classification additionally enforces
/// the separate durable/finite limits for their complete lifetimes.
pub struct AcceptedReliableLane {
    pub(crate) recv: RecvStream,
    pub(crate) source_connection: Arc<Connection>,
    pub(crate) _lane_permit: OwnedSemaphorePermit,
}

impl AcceptedReliableLane {
    pub fn new(
        recv: RecvStream,
        source_connection: Arc<Connection>,
        lane_permit: OwnedSemaphorePermit,
    ) -> Self {
        Self {
            recv,
            source_connection,
            _lane_permit: lane_permit,
        }
    }
}

/// A source-owned reliable stream. Durable lanes follow the destination watch;
/// finite transfers pin its current attachment and terminate on any change.
/// Neither path allocates a complete record or object at the edge.
pub struct RoutedReliableLane {
    pub(crate) source_attachment_id: AttachmentId,
    pub(crate) recv: RecvStream,
    pub(crate) source_connection: Arc<Connection>,
    pub(crate) _lane_permit: OwnedSemaphorePermit,
    pub(crate) direction_budget: Arc<Semaphore>,
    pub(crate) global_budget: Arc<Semaphore>,
    pub(crate) finite_budgets: [Arc<Semaphore>; 2],
    pub(crate) destinations: watch::Receiver<Option<ReliableDestination>>,
}

impl RoutedReliableLane {
    fn new(
        lane: AcceptedReliableLane,
        source_attachment_id: AttachmentId,
        direction_budget: Arc<Semaphore>,
        global_budget: Arc<Semaphore>,
        finite_budgets: [Arc<Semaphore>; 2],
        destinations: watch::Receiver<Option<ReliableDestination>>,
    ) -> Self {
        Self {
            recv: lane.recv,
            source_attachment_id,
            source_connection: lane.source_connection,
            _lane_permit: lane._lane_permit,
            direction_budget,
            global_budget,
            finite_budgets,
            destinations,
        }
    }
}

/// A newly opened destination stream and the exact attachment that owns it.
/// The connection handle lets the source-owned actor retire a destination whose
/// stream fails instead of accidentally blaming or closing the source.
pub(crate) struct ReliableOpenedStream {
    pub(crate) send: SendStream,
    pub(crate) connection: Arc<Connection>,
}

/// One request to open a QUIC stream on the destination connection. The source
/// lane actor owns the returned stream; the destination pump only performs the
/// connection operation so the registry never has to retain a transport handle.
pub(crate) struct ReliableOpenRequest {
    pub(crate) finite: bool,
    pub(crate) reply: oneshot::Sender<Option<ReliableOpenedStream>>,
    /// Told, before `reply`, when the destination has no stream credit and the
    /// open must wait for another stream to close.
    pub(crate) waiting: Option<oneshot::Sender<()>>,
}

/// Weak, generation-qualified route to the currently attached destination.
///
/// The weak sender is essential: a source lane may retain this value while a
/// destination is detached, but it must not keep that destination's outbound
/// pump alive. The slot's `watch` value rotates atomically on attach/detach.
#[derive(Clone)]
pub(crate) struct ReliableDestination {
    pub(crate) attachment_id: AttachmentId,
    open_tx: mpsc::WeakSender<ReliableOpenRequest>,
}

impl ReliableDestination {
    pub(crate) fn upgrade(&self) -> Option<mpsc::Sender<ReliableOpenRequest>> {
        self.open_tx.upgrade()
    }
}

/// Drop-owned accounting for one record currently moving through the relay.
pub struct ReliableRecordBudget {
    _direction: OwnedSemaphorePermit,
    _global: OwnedSemaphorePermit,
}

impl ReliableRecordBudget {
    pub(crate) async fn acquire(
        direction_budget: &Arc<Semaphore>,
        global_budget: &Arc<Semaphore>,
        body_len: usize,
    ) -> Option<Self> {
        if body_len > MAX_RELIABLE_BODY {
            return None;
        }
        let record_len = RELIABLE_RECORD_HEADER_BYTES.checked_add(body_len)?;
        Self::acquire_bytes(direction_budget, global_budget, record_len).await
    }

    pub(crate) async fn acquire_finite(
        budgets: &[Arc<Semaphore>; 2],
        bytes: usize,
    ) -> Option<Self> {
        if bytes == 0 || bytes > MAX_FINITE_STREAM_BYTES {
            return None;
        }
        // Reserve the complete possible queue, not just the current read batch.
        // Includes attachment + lifecycle + length; held through delivery/RESET.
        Self::acquire_bytes(&budgets[0], &budgets[1], bytes + 13).await
    }

    /// `acquire_finite` without waiting: `None` when either budget, or the
    /// size, cannot admit the transfer now.
    pub(crate) fn try_acquire_finite(budgets: &[Arc<Semaphore>; 2], bytes: usize) -> Option<Self> {
        if bytes == 0 || bytes > MAX_FINITE_STREAM_BYTES {
            return None;
        }
        let permits = u32::try_from(bytes + 13).ok()?;
        Some(ReliableRecordBudget {
            _direction: budgets[0].clone().try_acquire_many_owned(permits).ok()?,
            _global: budgets[1].clone().try_acquire_many_owned(permits).ok()?,
        })
    }

    /// `acquire` without waiting: `None` when either budget, or the size,
    /// cannot admit the record now.
    pub(crate) fn try_acquire(
        direction_budget: &Arc<Semaphore>,
        global_budget: &Arc<Semaphore>,
        body_len: usize,
    ) -> Option<Self> {
        if body_len > MAX_RELIABLE_BODY {
            return None;
        }
        let permits = u32::try_from(RELIABLE_RECORD_HEADER_BYTES.checked_add(body_len)?).ok()?;
        Some(ReliableRecordBudget {
            _direction: direction_budget.clone().try_acquire_many_owned(permits).ok()?,
            _global: global_budget.clone().try_acquire_many_owned(permits).ok()?,
        })
    }

    async fn acquire_bytes(
        direction_budget: &Arc<Semaphore>,
        global_budget: &Arc<Semaphore>,
        bytes: usize,
    ) -> Option<Self> {
        let permits = u32::try_from(bytes).ok()?;
        let direction = direction_budget
            .clone()
            .acquire_many_owned(permits)
            .await
            .ok()?;
        let global = global_budget
            .clone()
            .acquire_many_owned(permits)
            .await
            .ok()?;
        Some(ReliableRecordBudget {
            _direction: direction,
            _global: global,
        })
    }
}

/// One attached peer's send handle: opaque frames pushed here are delivered to
/// that peer's outbound transport task.
#[derive(Clone)]
pub struct PeerSink {
    pub role: Role,
    attachment_id: AttachmentId,
    transport: Option<wtransport::quinn::Connection>,
    candidate_target: Option<std::sync::Weak<Connection>>,
    candidate_slots: Arc<Semaphore>,
    datagram_tx: mpsc::Sender<Frame>,
    reliable_open_tx: mpsc::Sender<ReliableOpenRequest>,
    lifecycle_tx: watch::Sender<Option<AttachmentLifecycle>>,
    delivery_quote_tx: watch::Sender<Option<SpliceDeliveryQuote>>,
}

impl PeerSink {
    fn new(role: Role, attachment_id: AttachmentId) -> (PeerSink, PeerReceivers) {
        let (datagram_tx, datagram_rx) = mpsc::channel(SPLICE_MAILBOX_DEPTH);
        let (reliable_open_tx, reliable_open_rx) = mpsc::channel(MAX_RELIABLE_LANES_PER_PEER);
        let (lifecycle_tx, lifecycle_rx) = watch::channel(None);
        let (delivery_quote_tx, delivery_quote_rx) = watch::channel(None);
        (
            PeerSink {
                role,
                attachment_id,
                transport: None,
                candidate_target: None,
                // One candidate plus one racing successor; neither owns terminal lanes.
                candidate_slots: Arc::new(Semaphore::new(2)),
                datagram_tx,
                reliable_open_tx,
                lifecycle_tx,
                delivery_quote_tx,
            },
            PeerReceivers {
                datagram_rx,
                reliable_open_rx,
                lifecycle_rx,
                delivery_quote_rx,
            },
        )
    }

    /// Hand this replaced transport's demonstrated capacity to its successor
    /// (RFC 9959 Careful Resume), so the successor's first large send starts
    /// near the window this one earned rather than the initial window. Quinn
    /// resumes only on the same local and peer address, and validates the
    /// capacity before keeping it. Returns whether the successor resumes.
    pub fn resume_successor(&self, successor: &wtransport::quinn::Connection) -> bool {
        let Some(observation) = self
            .transport
            .as_ref()
            .and_then(wtransport::quinn::Connection::take_careful_resume_observation)
        else {
            return false;
        };
        successor.careful_resume(observation)
    }

    /// Retire an explicitly replaced concrete transport before its successor
    /// binds packet admission. Closing drops its aggregate flight owner now,
    /// rather than waiting for the displaced outbound task to observe EOF.
    pub fn retire_replaced(self) {
        if let Some(connection) = &self.transport {
            connection.close(
                wtransport::quinn::VarInt::from_u32(0),
                b"replaced-attachment",
            );
        }
    }

    fn forward_datagram(&self, frame: Frame) -> bool {
        debug_assert!(matches!(frame.lane, Lane::Datagram));
        self.datagram_tx.try_send(frame).is_ok()
    }

    fn reliable_destination(&self) -> ReliableDestination {
        ReliableDestination {
            attachment_id: self.attachment_id,
            open_tx: self.reliable_open_tx.downgrade(),
        }
    }

    /// Terminal: queue the signal, then drop the frame senders. Ordering
    /// matters so the relay can distinguish ownership retirement from an
    /// ordinary transport failure.
    fn retire(self, reason: RetireReason) {
        self.lifecycle_tx
            .send_replace(Some(AttachmentLifecycle::Retire(reason)));
    }

    /// Non-terminal: the attachment stays live and keeps its senders.
    fn signal(&self, event: AttachmentLifecycle) {
        debug_assert!(
            !matches!(event, AttachmentLifecycle::Retire(_)),
            "terminal retirement must consume the sink"
        );
        // Quotes are attachment-generation scoped. Clear the newest-value
        // cell before publishing the lifecycle edge so the next browser sample
        // is never suppressed as timer noise against its predecessor.
        self.delivery_quote_tx.send_replace(None);
        self.lifecycle_tx.send_replace(Some(event));
    }

    /// Publish lossy path telemetry with bounded newest-value ownership.
    /// Repeated timer samples must never queue ahead of pairing lifecycle.
    fn publish_delivery_quote(&self, quote: SpliceDeliveryQuote) {
        self.delivery_quote_tx.send_if_modified(|current| {
            if current.is_some_and(|previous| !quote.materially_differs(previous)) {
                return false;
            }
            *current = Some(quote);
            true
        });
    }
}

struct PeerReceivers {
    datagram_rx: mpsc::Receiver<Frame>,
    reliable_open_rx: mpsc::Receiver<ReliableOpenRequest>,
    lifecycle_rx: watch::Receiver<Option<AttachmentLifecycle>>,
    delivery_quote_rx: watch::Receiver<Option<SpliceDeliveryQuote>>,
}

/// The single authoritative peer pair. Routing holds only this session's read
/// guard through source validation, destination selection and mailbox admission.
#[derive(Default)]
struct SessionPeers {
    browser: Option<PeerSink>,
    daemon: Option<PeerSink>,
}

impl SessionPeers {
    fn sink_for(&self, role: Role) -> Option<&PeerSink> {
        match role {
            Role::Browser => self.browser.as_ref(),
            Role::Daemon => self.daemon.as_ref(),
        }
    }
}

/// A source attachment's stable route, resolved once at attach. It never owns a
/// cached destination sender: replacement and detach update the same peer pair.
/// Routing needs no registry lookup or Arc clone and moves the payload unchanged.
pub struct DatagramRoute {
    peers: Arc<RwLock<SessionPeers>>,
    from_role: Role,
    attachment_id: AttachmentId,
}

impl DatagramRoute {
    pub fn route(&self, frame: Frame) -> bool {
        let datagrams = frame.datagrams.len() as u64;
        let peers = self.peers.read();
        if !peers
            .sink_for(self.from_role)
            .is_some_and(|current| current.attachment_id == self.attachment_id)
        {
            return false;
        }
        // Keep the guard through try_send: a lifecycle writer cannot replace a
        // selected destination or source between validation and admission.
        match peers.sink_for(self.from_role.peer()) {
            Some(peer) if peer.forward_datagram(frame) => true,
            Some(_) => {
                // Full/closed mailboxes count; an absent counterpart does not.
                // Exporters run outside this hot-path critical section.
                metrics::route_drop_counter(self.from_role)
                    .fetch_add(datagrams, AtomicOrdering::Relaxed);
                false
            }
            None => false,
        }
    }
}

struct SessionSlot {
    peers: Arc<RwLock<SessionPeers>>,
    browser_destination: watch::Sender<Option<ReliableDestination>>,
    daemon_destination: watch::Sender<Option<ReliableDestination>>,
    reliable_bytes_for_browser: Arc<Semaphore>,
    reliable_bytes_for_daemon: Arc<Semaphore>,
    finite_bytes_for_browser: Arc<Semaphore>,
    finite_bytes_for_daemon: Arc<Semaphore>,
    /// Whether this session's daemon, while profiling, asked for contention
    /// evidence. Shared by both attachments; see [`AttachHandle::contention`].
    contention: ContentionRequests,
    /// Each role's host, shared with the session's other two routing labels:
    /// a packet one attachment hears proves its host reachable for the other
    /// two. Indexed browser, then daemon.
    probe_groups: [ProbeGroup; 2],
    unpaired_since: Option<Instant>,
    /// The daemon every attachment to this label must name, fixed by the first
    /// verified attachment. A ticket proves which daemon a peer serves; this is
    /// what stops two valid tickets for different daemons pairing.
    daemon_id: Box<str>,
    /// The current browser attachment's proven address. State rather than a
    /// lifecycle event, so a daemon that attaches later still reads it and a
    /// latest-value lifecycle signal can never displace it.
    browser_path: watch::Sender<Option<BrowserPath>>,
    /// The dataplane process whose tunnel last joined this label. Kept after
    /// that tunnel detaches: the half-paired slot waits for that process.
    incarnation: Option<Box<str>>,
}

impl SessionSlot {
    fn new(
        reliable_bytes_per_direction: usize,
        probe_groups: [ProbeGroup; 2],
        daemon_id: &str,
    ) -> Self {
        let (browser_destination, _) = watch::channel(None);
        let (daemon_destination, _) = watch::channel(None);
        Self {
            browser_path: watch::channel(None).0,
            peers: Arc::new(RwLock::new(SessionPeers::default())),
            browser_destination,
            daemon_destination,
            reliable_bytes_for_browser: Arc::new(Semaphore::new(reliable_bytes_per_direction)),
            reliable_bytes_for_daemon: Arc::new(Semaphore::new(reliable_bytes_per_direction)),
            finite_bytes_for_browser: Arc::new(Semaphore::new(SPLICE_FINITE_BYTES_PER_DIRECTION)),
            finite_bytes_for_daemon: Arc::new(Semaphore::new(SPLICE_FINITE_BYTES_PER_DIRECTION)),
            contention: ContentionRequests::default(),
            probe_groups,
            unpaired_since: Some(Instant::now()),
            daemon_id: daemon_id.into(),
            incarnation: None,
        }
    }

    fn probe_group_for(&self, role: Role) -> &ProbeGroup {
        match role {
            Role::Browser => &self.probe_groups[0],
            Role::Daemon => &self.probe_groups[1],
        }
    }

    fn set(&mut self, sink: PeerSink) -> (Option<PeerSink>, bool, Option<AttachmentId>) {
        let mut peers = self.peers.write();
        let role = sink.role;
        let attachment_id = sink.attachment_id;
        self.destination_for(role)
            .send_replace(Some(sink.reliable_destination()));
        let replaced = match role {
            Role::Browser => peers.browser.replace(sink),
            Role::Daemon => peers.daemon.replace(sink),
        };
        let both_attached = peers.browser.is_some() && peers.daemon.is_some();
        if both_attached {
            self.unpaired_since = None;
        }
        let counterpart = peers.sink_for(role.peer());
        if let Some(counterpart) = counterpart {
            counterpart.signal(AttachmentLifecycle::CounterpartAttached { attachment_id });
        }
        (
            replaced,
            both_attached,
            counterpart.map(|peer| peer.attachment_id),
        )
    }

    fn destination_for(&self, role: Role) -> &watch::Sender<Option<ReliableDestination>> {
        match role {
            Role::Browser => &self.browser_destination,
            Role::Daemon => &self.daemon_destination,
        }
    }

    fn reliable_budget_for(&self, role: Role) -> &Arc<Semaphore> {
        match role {
            Role::Browser => &self.reliable_bytes_for_browser,
            Role::Daemon => &self.reliable_bytes_for_daemon,
        }
    }

    /// Return whether the slot is empty after exact-generation detach.
    fn detach(&mut self, role: Role, attachment_id: AttachmentId, ttl: Duration) -> bool {
        let mut peers = self.peers.write();
        let sink = match role {
            Role::Browser => &mut peers.browser,
            Role::Daemon => &mut peers.daemon,
        };
        if sink
            .as_ref()
            .is_some_and(|current| current.attachment_id == attachment_id)
        {
            *sink = None;
            self.destination_for(role).send_replace(None);
            self.unpaired_since.get_or_insert_with(Instant::now);
            if let Some(counterpart) = peers.sink_for(role.peer()) {
                counterpart.signal(AttachmentLifecycle::CounterpartDetached {
                    attachment_id,
                    rebind_window_remaining_ms: ttl.as_millis() as u64,
                });
            }
        }
        peers.browser.is_none() && peers.daemon.is_none()
    }

    fn retire(&self, reason: RetireReason) {
        let mut peers = self.peers.write();
        for sink in [peers.browser.take(), peers.daemon.take()]
            .into_iter()
            .flatten()
        {
            if reason == RetireReason::EgressBudget
                && let Some(transport) = &sink.transport
            {
                transport.close(
                    wtransport::quinn::VarInt::from_u32(crate::relay::EGRESS_BUDGET_CLOSE_CODE),
                    crate::relay::EGRESS_BUDGET_CLOSE_REASON,
                );
            }
            sink.retire(reason);
        }
    }

    fn is_expired_unpaired(&self, now: Instant, ttl: Duration) -> bool {
        self.unpaired_since
            .is_some_and(|unpaired_since| now.duration_since(unpaired_since) >= ttl)
    }
}

// The registry owns membership; route handles only keep the empty routing cell
// alive after removal. Clear senders even on registry shutdown, so retained old
// handles cannot keep outbound pumps alive or reach a reused routing label.
impl Drop for SessionSlot {
    fn drop(&mut self) {
        *self.peers.write() = SessionPeers::default();
    }
}

/// Session registry keyed by session id. Matches a browser peer to a daemon
/// peer and routes opaque frames between them. Cloneable handle over shared
/// state.
#[derive(Clone)]
pub struct SpliceRegistry {
    // Cold membership, reliable binding and quote operations only. Lock order is
    // registry then session peers; routing takes only the session read lock.
    // No critical section crosses an await.
    sessions: Arc<RwLock<HashMap<String, SessionSlot>>>,
    expiration_changes: watch::Sender<u64>,
    next_attachment_id: Arc<AtomicU64>,
    egress_state: Arc<AtomicU64>,
    egress_changes: watch::Sender<crate::egress_budget::BudgetState>,
    max_sessions: usize,
    unpaired_ttl: Duration,
    reliable_bytes_per_direction: usize,
    global_reliable_bytes: Arc<Semaphore>,
    global_finite_bytes: Arc<Semaphore>,
    global_session_tasks: Arc<Semaphore>,
    candidate_tasks: Arc<Semaphore>,
    /// Each daemon's newest dataplane incarnation, taken under the registry
    /// write guard (registry, then this). One entry per daemon id that ever
    /// attached: a daemon ticket names its id, so the server bounds it.
    daemon_incarnations: Arc<parking_lot::Mutex<HashMap<Box<str>, Box<str>>>>,
}

pub(crate) struct CandidateTarget {
    pub(crate) attachment_id: AttachmentId,
    pub(crate) connection: Arc<Connection>,
    // Both credits live until the proof bridge closes or promotes.
    pub(crate) permits: [OwnedSemaphorePermit; 2],
}

impl SpliceRegistry {
    pub fn new() -> Self {
        let (expiration_changes, _) = watch::channel(0);
        SpliceRegistry {
            sessions: Arc::new(RwLock::new(HashMap::with_capacity(MAX_SPLICE_SESSIONS))),
            expiration_changes,
            next_attachment_id: Arc::new(AtomicU64::new(1)),
            egress_state: Arc::new(AtomicU64::new(0)),
            egress_changes: watch::channel(crate::egress_budget::BudgetState::Open).0,
            max_sessions: MAX_SPLICE_SESSIONS,
            unpaired_ttl: UNPAIRED_SESSION_TTL,
            reliable_bytes_per_direction: SPLICE_RELIABLE_BYTES_PER_DIRECTION,
            global_reliable_bytes: Arc::new(Semaphore::new(SPLICE_RELIABLE_BYTES_GLOBAL)),
            global_finite_bytes: Arc::new(Semaphore::new(SPLICE_FINITE_BYTES_GLOBAL)),
            global_session_tasks: Arc::new(Semaphore::new(MAX_SPLICE_SESSION_TASKS)),
            // At most 64 proof bridges, each holding two bounded 64 KiB records.
            candidate_tasks: Arc::new(Semaphore::new(64)),
            daemon_incarnations: Arc::default(),
        }
    }

    /// A dataplane process of `daemon_id` stated its incarnation before holding
    /// a tunnel here. Returns how many slots another incarnation held, all now
    /// retired: that process is gone, and its sessions with it.
    pub fn announce_incarnation(&self, daemon_id: &str, incarnation: &str) -> usize {
        let mut sessions = self.write_sessions();
        let retired = self.supersede_incarnations(&mut sessions, daemon_id, incarnation);
        publish_session_gauges(&sessions);
        drop(sessions);
        self.signal_expiration_change();
        retired
    }

    /// Record `incarnation` as `daemon_id`'s newest and, when it is new, retire
    /// every slot another incarnation of that daemon holds, half-paired ones
    /// included: their browsers learn at once that no tunnel will return, where
    /// a dead process's connection would hold them until the idle timeout.
    /// Called under the registry write guard.
    fn supersede_incarnations(
        &self,
        sessions: &mut HashMap<String, SessionSlot>,
        daemon_id: &str,
        incarnation: &str,
    ) -> usize {
        {
            let mut newest = self.daemon_incarnations.lock();
            if newest
                .get(daemon_id)
                .is_some_and(|known| **known == *incarnation)
            {
                return 0;
            }
            newest.insert(daemon_id.into(), incarnation.into());
        }
        let before = sessions.len();
        sessions.retain(|_, slot| {
            let superseded = *slot.daemon_id == *daemon_id
                && slot
                    .incarnation
                    .as_deref()
                    .is_some_and(|held| held != incarnation);
            if superseded {
                slot.retire(RetireReason::IncarnationSuperseded);
            }
            !superseded
        });
        before - sessions.len()
    }

    /// Serialize budget admission with membership, including attach/bind races.
    pub fn apply_egress_state(&self, state: crate::egress_budget::BudgetState) {
        use crate::egress_budget::BudgetState;
        let mut sessions = self.write_sessions();
        self.egress_state.store(state as u64, Ordering::Relaxed);
        // Publish before retiring data; every signaling reader retains the latest state.
        self.egress_changes.send_if_modified(|current| {
            if *current == state {
                return false;
            }
            *current = state;
            true
        });
        sessions.retain(|label, slot| {
            if state == BudgetState::Open
                || (state == BudgetState::SignalingOnly && label.ends_with("#signaling"))
            {
                return true;
            }
            slot.retire(RetireReason::EgressBudget);
            false
        });
        publish_session_gauges(&sessions);
        drop(sessions);
        self.signal_expiration_change();
    }

    pub(crate) fn egress_changes(&self) -> watch::Receiver<crate::egress_budget::BudgetState> {
        self.egress_changes.subscribe()
    }

    fn read_sessions(&self) -> RwLockReadGuard<'_, HashMap<String, SessionSlot>> {
        self.sessions.read()
    }

    fn write_sessions(&self) -> RwLockWriteGuard<'_, HashMap<String, SessionSlot>> {
        self.sessions.write()
    }

    /// Admit one accepted transport session for its complete task lifetime.
    /// Acquisition never holds the session-registry lock. The returned permit
    /// must outlive all per-session pumps and their child tasks.
    pub async fn acquire_session_task(&self) -> Option<OwnedSemaphorePermit> {
        self.global_session_tasks.clone().acquire_owned().await.ok()
    }

    /// Attach a peer (identified by its routing preface) to a session slot,
    /// returning the receiver the caller's outbound task drains to deliver
    /// frames to this peer.
    ///
    /// If the slot already had a peer of the same role (e.g. a reconnect before
    /// the old one was reaped), the previous sink is replaced and returned so
    /// the caller can tear the stale peer down.
    ///
    /// A daemon in production attaches through [`Self::attach_tunnel`], which
    /// names its incarnation; this form leaves the slot's unknown.
    pub fn attach(
        &self,
        session_id: &str,
        role: Role,
        daemon_id: &str,
    ) -> Result<AttachHandle, AttachError> {
        self.attach_checked(session_id, role, daemon_id, None, None)
    }

    /// Attach a daemon tunnel dialed by the dataplane process `incarnation`,
    /// first retiring every slot another incarnation of the daemon holds.
    pub fn attach_tunnel(
        &self,
        session_id: &str,
        daemon_id: &str,
        incarnation: &str,
    ) -> Result<AttachHandle, AttachError> {
        self.attach_checked(session_id, Role::Daemon, daemon_id, None, Some(incarnation))
    }

    pub(crate) fn promote_candidate(
        &self,
        session_id: &str,
        daemon_id: &str,
        daemon: AttachmentId,
    ) -> Result<AttachHandle, AttachError> {
        self.attach_checked(session_id, Role::Browser, daemon_id, Some(daemon), None)
    }

    fn attach_checked(
        &self,
        session_id: &str,
        role: Role,
        daemon_id: &str,
        expected_daemon: Option<AttachmentId>,
        incarnation: Option<&str>,
    ) -> Result<AttachHandle, AttachError> {
        let attachment_id = AttachmentId(self.next_attachment_id.fetch_add(1, Ordering::Relaxed));
        let (sink, receivers) = PeerSink::new(role, attachment_id);
        let mut sessions = self.write_sessions();
        let state = self.egress_state.load(Ordering::Relaxed);
        if state == crate::egress_budget::BudgetState::Stopped as u64
            || (state == crate::egress_budget::BudgetState::SignalingOnly as u64
                && !session_id.ends_with("#signaling"))
        {
            return Err(AttachError::EgressBudget);
        }
        if let Some(incarnation) = incarnation {
            self.supersede_incarnations(&mut sessions, daemon_id, incarnation);
        }
        let now = Instant::now();
        // Do not let a just-arriving counterpart revive an expired half-pair
        // before the deadline worker runs. This is an O(1) check on the exact
        // routing label instead of the old full-registry scan on every attach.
        if sessions
            .get(session_id)
            .is_some_and(|slot| slot.is_expired_unpaired(now, self.unpaired_ttl))
            && let Some(expired) = sessions.remove(session_id)
        {
            expired.retire(RetireReason::RebindWindowExpired);
        }
        if sessions
            .get(session_id)
            .is_some_and(|slot| *slot.daemon_id != *daemon_id)
        {
            return Err(AttachError::DaemonMismatch);
        }
        if let Some(expected) = expected_daemon
            && !sessions.get(session_id).is_some_and(|slot| {
                slot.peers
                    .read()
                    .daemon
                    .as_ref()
                    .is_some_and(|sink| sink.attachment_id == expected)
            })
        {
            return Err(AttachError::CounterpartChanged);
        }
        // The deadline worker owns unrelated routine expiry. Only pay the
        // O(session-count) scan when a new label would otherwise hit capacity.
        if !sessions.contains_key(session_id) && sessions.len() >= self.max_sessions {
            prune_expired_slots(&mut sessions, now, self.unpaired_ttl);
            if sessions.len() >= self.max_sessions {
                return Err(AttachError::Capacity);
            }
        }
        if !sessions.contains_key(session_id) {
            let probe_groups = sibling_probe_groups(&sessions, session_id);
            sessions.insert(
                session_id.to_string(),
                SessionSlot::new(self.reliable_bytes_per_direction, probe_groups, daemon_id),
            );
        }
        let slot = sessions
            .get_mut(session_id)
            .expect("the slot was just ensured under this write guard");
        if let Some(incarnation) = incarnation {
            slot.incarnation = Some(incarnation.into());
        }
        let (replaced, both_attached, counterpart_attachment_id) = slot.set(sink);
        let datagram_route = DatagramRoute {
            peers: Arc::clone(&slot.peers),
            from_role: role,
            attachment_id,
        };
        let counterpart_destinations = slot.destination_for(role.peer()).subscribe();
        let contention = slot.contention.clone();
        let browser_path = slot.browser_path.subscribe();
        publish_session_gauges(&sessions);
        let handle = AttachHandle {
            datagram_route,
            counterpart_destinations,
            browser_path,
            datagram_rx: receivers.datagram_rx,
            reliable_open_rx: receivers.reliable_open_rx,
            lifecycle_rx: receivers.lifecycle_rx,
            delivery_quote_rx: receivers.delivery_quote_rx,
            contention,
            replaced,
            both_attached,
            counterpart_attachment_id,
            attachment_id,
        };
        drop(sessions);
        self.signal_expiration_change();
        Ok(handle)
    }

    /// Publish the proven address of the browser attachment now seated under
    /// `session_id`. A displaced attachment's report changes nothing.
    pub(crate) fn publish_browser_path(
        &self,
        session_id: &str,
        attachment_id: AttachmentId,
        address: IpAddr,
    ) {
        let sessions = self.read_sessions();
        let Some(slot) = sessions.get(session_id) else {
            return;
        };
        let current = slot
            .peers
            .read()
            .browser
            .as_ref()
            .is_some_and(|sink| sink.attachment_id == attachment_id);
        if !current {
            return;
        }
        let path = BrowserPath {
            attachment_id,
            address: canonical_peer_address(address),
        };
        slot.browser_path.send_if_modified(|published| {
            let changed = *published != Some(path);
            *published = Some(path);
            changed
        });
    }

    pub(crate) fn bind_candidate_target(
        &self,
        session_id: &str,
        attachment: AttachmentId,
        connection: &Arc<Connection>,
    ) {
        let sessions = self.read_sessions();
        let Some(slot) = sessions.get(session_id) else {
            return;
        };
        let mut peers = slot.peers.write();
        if let Some(sink) = peers
            .daemon
            .as_mut()
            .filter(|sink| sink.attachment_id == attachment)
        {
            sink.candidate_target = Some(Arc::downgrade(connection));
        }
    }

    pub(crate) fn candidate_target(
        &self,
        session_id: &str,
        daemon_id: &str,
    ) -> Result<Option<CandidateTarget>, ()> {
        let sessions = self.read_sessions();
        let Some(slot) = sessions.get(session_id) else {
            return Ok(None);
        };
        if *slot.daemon_id != *daemon_id {
            return Err(());
        }
        if slot.is_expired_unpaired(Instant::now(), self.unpaired_ttl) {
            return Ok(None);
        }
        let peers = slot.peers.read();
        let Some(sink) = peers.daemon.as_ref() else {
            return Ok(None);
        };
        let Some(target) = sink
            .candidate_target
            .as_ref()
            .and_then(std::sync::Weak::upgrade)
        else {
            return Ok(None);
        };
        let global = self
            .candidate_tasks
            .clone()
            .try_acquire_owned()
            .map_err(|_| ())?;
        let local = sink
            .candidate_slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| ())?;
        Ok(Some(CandidateTarget {
            attachment_id: sink.attachment_id,
            connection: target,
            permits: [global, local],
        }))
    }

    /// Cold binding of the concrete transport to its non-reused attachment.
    /// Image-free sessions do not create aggregate packet state.
    pub fn bind_transport(
        &self,
        session_id: &str,
        role: Role,
        attachment_id: AttachmentId,
        connection: &wtransport::quinn::Connection,
    ) {
        {
            let sessions = self.read_sessions();
            let state = self.egress_state.load(Ordering::Relaxed);
            if state == crate::egress_budget::BudgetState::Stopped as u64
                || (state == crate::egress_budget::BudgetState::SignalingOnly as u64
                    && !session_id.ends_with("#signaling"))
            {
                connection.close(
                    wtransport::quinn::VarInt::from_u32(crate::relay::EGRESS_BUDGET_CLOSE_CODE),
                    crate::relay::EGRESS_BUDGET_CLOSE_REASON,
                );
                return;
            }
            let Some(slot) = sessions.get(session_id) else {
                return;
            };
            let mut peers = slot.peers.write();
            let sink = match role {
                Role::Browser => &mut peers.browser,
                Role::Daemon => &mut peers.daemon,
            };
            let Some(sink) = sink
                .as_mut()
                .filter(|sink| sink.attachment_id == attachment_id)
            else {
                return;
            };
            sink.transport = Some(connection.clone());
            // Refused only for a connection already closed, or for a host
            // already holding 32 live attachments under these labels.
            if let Err(error) = connection.join_probe_group(slot.probe_group_for(role)) {
                tracing::warn!(session_id, ?role, %error, "edge: attachment joined no probe group");
            }
        }
        // Replacement imports the current concrete pair's outstanding packet
        // debt. A stale group never starts accounting for a successor implicitly.
        self.coordinate_egress(session_id, role, attachment_id, false);
    }

    /// Activate packet scheduling before opening a finite destination stream.
    /// Routing labels select priority only; they grant no content authority.
    pub fn coordinate_egress(
        &self,
        session_id: &str,
        role: Role,
        attachment_id: AttachmentId,
        activate: bool,
    ) -> bool {
        if session_id.ends_with("#signaling") {
            return false;
        }
        let base = session_id.strip_suffix("#bulk").unwrap_or(session_id);
        let sessions = self.read_sessions();
        let Some(target) = sessions.get(session_id) else {
            return false;
        };
        if !target
            .peers
            .read()
            .sink_for(role)
            .is_some_and(|sink| sink.attachment_id == attachment_id)
        {
            return false;
        }
        let Some(interactive) = sessions.get(base) else {
            return false;
        };
        let interactive_peers = interactive.peers.read();
        let Some(interactive) = interactive_peers
            .sink_for(role)
            .and_then(|sink| sink.transport.as_ref())
        else {
            return false;
        };
        let bulk_label = format!("{base}#bulk");
        let bulk_peers = sessions.get(&bulk_label).map(|slot| slot.peers.read());
        let bulk = bulk_peers
            .as_ref()
            .and_then(|peers| peers.sink_for(role))
            .and_then(|sink| sink.transport.as_ref());
        if !activate
            && interactive.egress_group().is_none()
            && bulk.is_none_or(|conn| conn.egress_group().is_none())
        {
            return true;
        }
        let Ok(group) = interactive.start_egress_group() else {
            return false;
        };
        bulk.is_none_or(|conn| {
            conn.join_egress_group(&group, wtransport::quinn::EgressClass::Bulk)
                .is_ok()
        })
    }

    /// Publish one browser-facing QUIC quote to the daemon attachment paired
    /// with this exact browser generation. Latest-value semantics are provided
    /// by the control stream and daemon-side watch cell; the registry performs
    /// no buffering and learns nothing about application frames.
    pub fn report_delivery_quote(
        &self,
        session_id: &str,
        from_role: Role,
        attachment_id: AttachmentId,
        quote: SpliceDeliveryQuote,
    ) {
        if from_role != Role::Browser {
            return;
        }
        let sessions = self.read_sessions();
        let Some(slot) = sessions.get(session_id) else {
            return;
        };
        let peers = slot.peers.read();
        if !peers
            .sink_for(from_role)
            .is_some_and(|current| current.attachment_id == attachment_id)
        {
            return;
        }
        if let Some(daemon) = peers.sink_for(Role::Daemon) {
            daemon.publish_delivery_quote(SpliceDeliveryQuote {
                browser_attachment_id: attachment_id.as_u64(),
                ..quote
            });
        }
    }

    /// Bind one accepted persistent stream to the role-stable destination
    /// watch. The caller remains the lane's owner for its entire source
    /// connection; destination churn only rotates the writer it obtains.
    pub fn bind_reliable_lane(
        &self,
        session_id: &str,
        from_role: Role,
        attachment_id: AttachmentId,
        lane: AcceptedReliableLane,
    ) -> Option<RoutedReliableLane> {
        let peer_role = from_role.peer();
        let mut sessions = self.write_sessions();
        let slot = sessions.get_mut(session_id)?;
        let peers = slot.peers.read();
        if !peers
            .sink_for(from_role)
            .is_some_and(|current| current.attachment_id == attachment_id)
        {
            return None;
        }
        Some(RoutedReliableLane::new(
            lane,
            attachment_id,
            slot.reliable_budget_for(peer_role).clone(),
            self.global_reliable_bytes.clone(),
            [
                match peer_role {
                    Role::Browser => slot.finite_bytes_for_browser.clone(),
                    Role::Daemon => slot.finite_bytes_for_daemon.clone(),
                },
                self.global_finite_bytes.clone(),
            ],
            slot.destination_for(peer_role).subscribe(),
        ))
    }

    /// Detach a peer when its transport session closes.
    ///
    /// The *slot*, not the browser attachment, owns the pairing lifetime. A
    /// departing peer demotes the slot to half-paired and the counterpart is
    /// told so, but keeps its transport: a browser whose carrier died can
    /// re-attach within `unpaired_ttl` and resume against the daemon tunnel
    /// that never left, which is what makes reconnect a carrier swap rather
    /// than a session rebuild. The deadline is enforced by the ordinary
    /// unpaired-expiry path, which retires the survivor explicitly.
    ///
    /// A stale attachment id still cannot touch either current side.
    pub fn detach(&self, session_id: &str, role: Role, attachment_id: AttachmentId) {
        let mut sessions = self.write_sessions();
        if let Some(slot) = sessions.get_mut(session_id)
            && slot.detach(role, attachment_id, self.unpaired_ttl)
        {
            sessions.remove(session_id);
        }
        publish_session_gauges(&sessions);
        drop(sessions);
        self.signal_expiration_change();
    }

    /// Drop half-paired sessions whose grace period elapsed. Dropping their
    /// sinks closes the outbound pumps, which closes the stale transports.
    #[cfg(test)]
    pub fn prune_expired_unpaired(&self) -> usize {
        let mut sessions = self.write_sessions();
        prune_expired_slots(&mut sessions, Instant::now(), self.unpaired_ttl)
    }

    /// Wait until the next half-paired session actually expires, pruning all
    /// sessions due at that instant. Attach/detach transitions wake this
    /// deadline worker through a versioned watch channel, so an earlier
    /// deadline cannot be lost between inspecting the registry and sleeping.
    #[expect(
        clippy::disallowed_methods,
        reason = "the registry's own worker waits for the instant the oldest half-paired session expires, beside the notification that moves it; no frame is forwarded from here"
    )]
    pub async fn wait_and_prune_expired_unpaired(&self) -> usize {
        let mut expiration_changes = self.expiration_changes.subscribe();
        loop {
            let next_deadline = {
                let mut sessions = self.write_sessions();
                let now = Instant::now();
                let pruned = prune_expired_slots(&mut sessions, now, self.unpaired_ttl);
                if pruned > 0 {
                    return pruned;
                }
                sessions
                    .values()
                    .filter_map(|slot| slot.unpaired_since)
                    .map(|unpaired_since| unpaired_since + self.unpaired_ttl)
                    .min()
            };

            match next_deadline {
                Some(deadline) => {
                    tokio::select! {
                        _ = tokio::time::sleep_until(deadline.into()) => {}
                        changed = expiration_changes.changed() => {
                            debug_assert!(changed.is_ok(), "registry owns the watch sender");
                        }
                    }
                }
                None => {
                    let changed = expiration_changes.changed().await;
                    debug_assert!(changed.is_ok(), "registry owns the watch sender");
                }
            }
        }
    }

    fn signal_expiration_change(&self) {
        self.expiration_changes
            .send_modify(|version| *version = version.wrapping_add(1));
    }

    #[cfg(test)]
    fn with_limits(max_sessions: usize, unpaired_ttl: Duration) -> Self {
        Self::with_limits_and_byte_budgets(
            max_sessions,
            unpaired_ttl,
            SPLICE_RELIABLE_BYTES_PER_DIRECTION,
            SPLICE_RELIABLE_BYTES_GLOBAL,
        )
    }

    /// The finite byte budget every session's transfers draw on.
    #[cfg(test)]
    pub(crate) fn global_finite_budget(&self) -> Arc<Semaphore> {
        Arc::clone(&self.global_finite_bytes)
    }

    /// Accepted-session admissions no session task holds.
    #[cfg(test)]
    pub(crate) fn available_session_tasks(&self) -> usize {
        self.global_session_tasks.available_permits()
    }

    /// The edge's end of the connection attached for `role` under `session_id`.
    #[cfg(test)]
    pub(crate) fn transport_for_test(
        &self,
        session_id: &str,
        role: Role,
    ) -> Option<wtransport::quinn::Connection> {
        let sessions = self.read_sessions();
        let peers = sessions.get(session_id)?.peers.read();
        peers.sink_for(role)?.transport.clone()
    }

    /// The durable record budget every session's lanes draw on.
    #[cfg(test)]
    pub(crate) fn global_reliable_budget(&self) -> Arc<Semaphore> {
        Arc::clone(&self.global_reliable_bytes)
    }

    #[cfg(test)]
    fn with_limits_and_byte_budgets(
        max_sessions: usize,
        unpaired_ttl: Duration,
        reliable_bytes_per_direction: usize,
        global_reliable_bytes: usize,
    ) -> Self {
        let (expiration_changes, _) = watch::channel(0);
        Self {
            sessions: Arc::new(RwLock::new(HashMap::with_capacity(max_sessions))),
            expiration_changes,
            next_attachment_id: Arc::new(AtomicU64::new(1)),
            egress_state: Arc::new(AtomicU64::new(0)),
            egress_changes: watch::channel(crate::egress_budget::BudgetState::Open).0,
            max_sessions,
            unpaired_ttl,
            reliable_bytes_per_direction,
            global_reliable_bytes: Arc::new(Semaphore::new(global_reliable_bytes)),
            global_finite_bytes: Arc::new(Semaphore::new(SPLICE_FINITE_BYTES_GLOBAL)),
            global_session_tasks: Arc::new(Semaphore::new(MAX_SPLICE_SESSION_TASKS)),
            candidate_tasks: Arc::new(Semaphore::new(64)),
            daemon_incarnations: Arc::default(),
        }
    }
}

/// The probe groups a new slot for `session_id` joins: those of any live slot
/// among the session's interactive, bulk and signaling labels, which reach the
/// same browser host and the same daemon host.
fn sibling_probe_groups(
    sessions: &HashMap<String, SessionSlot>,
    session_id: &str,
) -> [ProbeGroup; 2] {
    let base = session_id
        .strip_suffix("#bulk")
        .or_else(|| session_id.strip_suffix("#signaling"))
        .unwrap_or(session_id);
    [
        base.to_string(),
        format!("{base}#bulk"),
        format!("{base}#signaling"),
    ]
    .iter()
    .find_map(|label| sessions.get(label.as_str()))
    .map_or_else(
        || [ProbeGroup::new(), ProbeGroup::new()],
        |slot| slot.probe_groups.clone(),
    )
}

/// Drop half-paired slots past their grace period, retiring the surviving
/// attachment with a typed reason first.
///
/// The reason has to be explicit. Dropping the sink alone closes the outbound
/// pumps, which a daemon reads as an ordinary transport failure and answers by
/// redialling — resurrecting a tunnel for a browser that is never coming back
/// and re-arming the half-paired slot for another full window. Naming the
/// expiry is what lets the far side park instead of loop.
fn prune_expired_slots(
    sessions: &mut HashMap<String, SessionSlot>,
    now: Instant,
    ttl: Duration,
) -> usize {
    let before = sessions.len();
    sessions.retain(|_, slot| {
        if !slot.is_expired_unpaired(now, ttl) {
            return true;
        }
        slot.retire(RetireReason::RebindWindowExpired);
        false
    });
    publish_session_gauges(sessions);
    before - sessions.len()
}

/// Refresh the exported session gauges from the registry.
///
/// Called only while the write guard is already held, and only on attach,
/// detach and expiry — never on the datagram path. `unpaired_since` is cleared
/// exactly when both peers are attached, so it is the pairing predicate. The
/// scan is O(session count), bounded by `MAX_SPLICE_SESSIONS`; the alternative,
/// incremental counters at every mutation site, has far more ways to drift.
fn publish_session_gauges(sessions: &HashMap<String, SessionSlot>) {
    let paired = sessions
        .values()
        .filter(|slot| slot.unpaired_since.is_none())
        .count();
    metrics::ACTIVE_SESSIONS.store(sessions.len() as i64, AtomicOrdering::Relaxed);
    metrics::PAIRED_SESSIONS.store(paired as i64, AtomicOrdering::Relaxed);
}

impl Default for SpliceRegistry {
    fn default() -> Self {
        Self::new()
    }
}

const _: () = assert!(SPLICE_MAILBOX_DEPTH > 0);
const _: () = assert!(MAX_RELIABLE_FRAME <= SPLICE_RELIABLE_BYTES_PER_DIRECTION);
const _: () = assert!(SPLICE_RELIABLE_BYTES_PER_DIRECTION <= u32::MAX as usize);
const _: () = assert!(SPLICE_RELIABLE_BYTES_GLOBAL <= u32::MAX as usize);
const _: () = assert!(MAX_RELIABLE_LANES_PER_PEER > 0);
const _: () = assert!(MAX_SPLICE_SESSION_TASKS > 2 * MAX_SPLICE_SESSIONS);

/// Identifies one concrete transport attachment within a session and role.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AttachmentId(u64);

impl AttachmentId {
    pub const fn as_u64(self) -> u64 {
        self.0
    }
}

/// The proven source address of the browser's signaling attachment: the
/// validated QUIC path this relay observes, never a value either peer asserted.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct BrowserPath {
    pub(crate) attachment_id: AttachmentId,
    pub(crate) address: IpAddr,
}

impl BrowserPath {
    /// Wire form for the daemon.
    pub(crate) fn control_event(self) -> SpliceControlEvent {
        SpliceControlEvent::CounterpartPath {
            counterpart_attachment_id: self.attachment_id.as_u64(),
            address: self.address,
        }
    }
}

/// A peer's address as one network identity: a dual-stack listener reports an
/// IPv4 peer as its IPv4-mapped IPv6 form, which is the same host.
pub(crate) fn canonical_peer_address(address: IpAddr) -> IpAddr {
    address.to_canonical()
}

/// Profiling snapshot. Gauges are bytes/second, microseconds or bytes; counters
/// are modular u32 within the model epoch, which changes on a path reset.
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct EgressModelQuote {
    pub epoch: u32,
    pub bw: u64,
    pub rtprop_us: u64,
    pub pacing_rate: u64,
    pub bulk_cap: u64,
    pub quantum: u64,
    pub phase: u32,
    pub probes_gated: u32,
    pub probes_aborted: u32,
    pub interactive_in_probe: u32,
    pub queue_growth_cuts: u32,
    pub loss_rounds: u32,
    pub ce_rounds: u32,
    pub probe_rtts: u32,
}

impl EgressModelQuote {
    fn from_stats(stats: wtransport::quinn::EgressStats) -> Self {
        Self {
            epoch: stats.model_epoch as u32,
            bw: stats.bw,
            rtprop_us: stats.rtprop_us,
            pacing_rate: stats.pacing_rate,
            bulk_cap: stats.bulk_cap,
            quantum: stats.quantum,
            phase: stats.phase as u32,
            probes_gated: stats.model.probes_gated as u32,
            probes_aborted: stats.model.probes_aborted as u32,
            interactive_in_probe: stats.model.interactive_in_probe as u32,
            queue_growth_cuts: stats.model.queue_growth_cuts as u32,
            loss_rounds: stats.model.loss_rounds as u32,
            ce_rounds: stats.model.ce_rounds as u32,
            probe_rtts: stats.model.probe_rtts as u32,
        }
    }
}

/// Browser-facing edge QUIC state, reported only to the paired daemon on the
/// dedicated quote stream. Keeping it out of [`SpliceControlEvent`] makes the
/// transport separation structural rather than a scheduler convention.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SpliceDeliveryQuoteEvent {
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
        forward_residence: [u32; FORWARD_RESIDENCE_BUCKETS],
        #[serde(skip_serializing_if = "Option::is_none")]
        model: Option<EgressModelQuote>,
        pto_count: u32,
        send_blocked: bool,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SpliceDeliveryQuote {
    pub browser_attachment_id: u64,
    pub rtt_us: u64,
    pub congestion_window_bytes: u64,
    pub bytes_in_flight: u64,
    pub send_buffer_occupied_bytes: u64,
    pub mtu_bytes: u16,
    pub pacing_rate_bps: u64,
    pub sent_packets: u64,
    pub lost_packets: u64,
    /// Where this browser attachment's packets waited at the relay.
    pub contention: SpliceContention,
    /// Probe timeouts expired since this leg's last acknowledgment.
    pub pto_count: u32,
    /// Only probes may leave this leg: a probe timeout expired with no
    /// acknowledgment since and the window admits no packet.
    pub send_blocked: bool,
}

/// Cumulative contention evidence for one browser attachment: refusals by the
/// aggregate packet group its interactive and bulk connections share (zero
/// until images activate one), and its daemon-to-browser datagram residence.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SpliceContention {
    pub interactive_blocked: u64,
    pub interactive_paced: u64,
    pub interactive_waited_us: u64,
    pub bulk_blocked: u64,
    pub bulk_paced: u64,
    pub bulk_waited_us: u64,
    pub forward_residence: [u32; FORWARD_RESIDENCE_BUCKETS],
    pub model: Option<EgressModelQuote>,
}

impl SpliceContention {
    pub fn new(
        egress: Option<wtransport::quinn::EgressStats>,
        forward_residence: [u32; FORWARD_RESIDENCE_BUCKETS],
    ) -> Self {
        let waited_us = |waited: Duration| u64::try_from(waited.as_micros()).unwrap_or(u64::MAX);
        let (interactive, bulk) = egress.map_or_else(Default::default, |stats| {
            (stats.interactive, stats.bulk)
        });
        Self {
            interactive_blocked: interactive.blocked,
            interactive_paced: interactive.paced,
            interactive_waited_us: waited_us(interactive.waited),
            bulk_blocked: bulk.blocked,
            bulk_paced: bulk.paced,
            bulk_waited_us: waited_us(bulk.waited),
            forward_residence,
            model: egress.map(EgressModelQuote::from_stats),
        }
    }
}

impl SpliceDeliveryQuote {
    /// Suppress timer noise while publishing every change that can materially
    /// alter delivery planning. Packet loss, MTU changes, entering or leaving
    /// probe backoff and the blocked state itself are immediate;
    /// continuously varying estimates use one packet, 0.5 ms, or 5% as their
    /// resolution. Contention counters are exact events, so any change is
    /// material; they move only on the tick's cadence. The watch cell still
    /// retains exactly one quote.
    fn materially_differs(self, previous: Self) -> bool {
        self.browser_attachment_id != previous.browser_attachment_id
            || self.send_blocked != previous.send_blocked
            || (self.pto_count == 0) != (previous.pto_count == 0)
            || self.mtu_bytes != previous.mtu_bytes
            || self.lost_packets != previous.lost_packets
            || self.contention != previous.contention
            || self.sent_packets.abs_diff(previous.sent_packets) >= 32
            || materially_different(self.rtt_us, previous.rtt_us, 500)
            || materially_different(
                self.congestion_window_bytes,
                previous.congestion_window_bytes,
                u64::from(self.mtu_bytes.max(previous.mtu_bytes)),
            )
            || materially_different(
                self.bytes_in_flight,
                previous.bytes_in_flight,
                u64::from(self.mtu_bytes.max(previous.mtu_bytes)),
            )
            || materially_different(
                self.send_buffer_occupied_bytes,
                previous.send_buffer_occupied_bytes,
                u64::from(self.mtu_bytes.max(previous.mtu_bytes)),
            )
            || materially_different(self.pacing_rate_bps, previous.pacing_rate_bps, 64_000)
    }
}

impl From<SpliceDeliveryQuote> for SpliceDeliveryQuoteEvent {
    fn from(quote: SpliceDeliveryQuote) -> Self {
        let contention = quote.contention;
        Self::CounterpartDeliveryQuote {
            browser_attachment_id: quote.browser_attachment_id,
            rtt_us: quote.rtt_us,
            congestion_window_bytes: quote.congestion_window_bytes,
            bytes_in_flight: quote.bytes_in_flight,
            send_buffer_occupied_bytes: quote.send_buffer_occupied_bytes,
            mtu_bytes: quote.mtu_bytes,
            pacing_rate_bps: quote.pacing_rate_bps,
            sent_packets: quote.sent_packets,
            lost_packets: quote.lost_packets,
            interactive_blocked: contention.interactive_blocked,
            interactive_paced: contention.interactive_paced,
            interactive_waited_us: contention.interactive_waited_us,
            bulk_blocked: contention.bulk_blocked,
            bulk_paced: contention.bulk_paced,
            bulk_waited_us: contention.bulk_waited_us,
            forward_residence: contention.forward_residence,
            model: contention.model,
            pto_count: quote.pto_count,
            send_blocked: quote.send_blocked,
        }
    }
}

#[inline]
fn materially_different(current: u64, previous: u64, absolute_floor: u64) -> bool {
    let difference = current.abs_diff(previous);
    difference >= absolute_floor && difference.saturating_mul(20) >= current.max(previous)
}

/// Registry-owned lifecycle signal for one concrete attached transport.
///
/// Only [`Self::Retire`] is terminal. The pairing signals exist because a
/// browser carrier dying is no longer the end of a session: the slot stays
/// half-paired for the unpaired TTL so the browser can re-attach and resume,
/// and the daemon needs to know to stop writing during that window without
/// tearing its tunnel down.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AttachmentLifecycle {
    /// A counterpart attached and the slot is now fully paired.
    CounterpartAttached { attachment_id: AttachmentId },
    /// The counterpart detached. Non-terminal: the slot is held half-paired
    /// for this long, and an attach within the window re-pairs to this exact
    /// attachment.
    CounterpartDetached {
        attachment_id: AttachmentId,
        rebind_window_remaining_ms: u64,
    },
    /// This attachment is finished and its transport should close.
    Retire(RetireReason),
}

impl AttachmentLifecycle {
    /// The wire event for a non-terminal signal, or `None` when this is the
    /// terminal retirement (which closes the connection instead).
    pub fn control_event(self) -> Option<SpliceControlEvent> {
        match self {
            Self::CounterpartAttached { attachment_id } => {
                Some(SpliceControlEvent::CounterpartAttached {
                    counterpart_attachment_id: attachment_id.as_u64(),
                })
            }
            Self::CounterpartDetached {
                attachment_id,
                rebind_window_remaining_ms,
            } => Some(SpliceControlEvent::CounterpartDetached {
                counterpart_attachment_id: attachment_id.as_u64(),
                rebind_window_remaining_ms,
            }),
            Self::Retire(_) => None,
        }
    }
}

/// Why a still-attached transport is being retired.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RetireReason {
    /// The half-paired grace period elapsed without the counterpart returning.
    RebindWindowExpired,
    EgressBudget,
    /// Another dataplane process of the slot's daemon attached or announced:
    /// the process that held it is gone.
    IncarnationSuperseded,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AttachError {
    EgressBudget,
    Capacity,
    CounterpartChanged,
    /// The label is already bound to a different daemon.
    DaemonMismatch,
}

/// Returned by [`SpliceRegistry::attach`]: the per-peer outbound receiver plus
/// metadata about the slot at attach time.
pub struct AttachHandle {
    /// Move into this attachment's datagram ingress pump; resolved once at attach.
    pub datagram_route: DatagramRoute,
    /// Exact destination generations for a fresh, transport-only reachability proof.
    pub(crate) counterpart_destinations: watch::Receiver<Option<ReliableDestination>>,
    /// The slot's browser signaling path, which a daemon attachment reports on.
    pub(crate) browser_path: watch::Receiver<Option<BrowserPath>>,
    /// Independent lane receivers keep datagrams moving while reliable egress
    /// is flow-controlled.
    pub datagram_rx: mpsc::Receiver<Frame>,
    pub reliable_open_rx: mpsc::Receiver<ReliableOpenRequest>,
    /// Registry lifecycle signal, distinct from an ordinary transport failure.
    pub lifecycle_rx: watch::Receiver<Option<AttachmentLifecycle>>,
    /// Latest browser-facing QUIC quote. It is intentionally separate from
    /// lifecycle so periodic telemetry cannot queue ahead of detach/rebind.
    pub delivery_quote_rx: watch::Receiver<Option<SpliceDeliveryQuote>>,
    /// Set while the session's daemon profiles and asks, on its delivery-quote
    /// stream, for contention evidence. Off, relayed datagrams read no clock
    /// and quotes carry no contention, so it never makes a quote material.
    pub contention: ContentionRequests,
    /// A stale same-role sink that was displaced (reconnect race), if any.
    pub replaced: Option<PeerSink>,
    /// Whether, after this attach, both ends of the splice are present.
    pub both_attached: bool,
    /// Concrete counterpart generation at the instant this peer was seated.
    /// It tags the synchronous presence verdict and fences independently
    /// scheduled delivery quotes at the daemon.
    pub counterpart_attachment_id: Option<AttachmentId>,
    /// Required for routing and detach so a displaced connection cannot affect
    /// the newer connection that replaced it.
    pub attachment_id: AttachmentId,
}

#[cfg(test)]
#[path = "splice_routing_tests.rs"]
mod routing_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_new_incarnation_retires_every_slot_an_earlier_one_held() {
        let registry = SpliceRegistry::new();
        let daemon = crate::attach_ticket::TEST_DAEMON_ID;
        let (earlier, later) = ("AAAAAAAAAAAAAAAAAAAAAA", "BBBBBBBBBBBBBBBBBBBBBB");
        let _paired_tunnel = registry.attach_tunnel("paired", daemon, earlier).unwrap();
        let paired_browser = registry.attach("paired", Role::Browser, daemon).unwrap();
        let half_browser = registry
            .attach("half#signaling", Role::Browser, daemon)
            .unwrap();
        let half_tunnel = registry
            .attach_tunnel("half#signaling", daemon, earlier)
            .unwrap();
        registry.detach("half#signaling", Role::Daemon, half_tunnel.attachment_id);
        let _other = registry
            .attach_tunnel("other", "another-daemon", earlier)
            .unwrap();

        assert_eq!(registry.announce_incarnation(daemon, later), 2);
        for browser in [&paired_browser, &half_browser] {
            assert_eq!(
                *browser.lifecycle_rx.borrow(),
                Some(AttachmentLifecycle::Retire(
                    RetireReason::IncarnationSuperseded
                ))
            );
        }
        {
            let sessions = registry.read_sessions();
            assert!(!sessions.contains_key("paired"));
            assert!(!sessions.contains_key("half#signaling"));
            assert!(sessions.contains_key("other"), "another daemon's slot stays");
        }
        // The newest incarnation's own tunnels retire nothing.
        assert_eq!(registry.announce_incarnation(daemon, later), 0);
        let _fresh = registry.attach_tunnel("fresh", daemon, later).unwrap();
        assert!(registry.read_sessions().contains_key("fresh"));
    }

    #[tokio::test]
    async fn a_tunnel_of_a_new_incarnation_supersedes_like_an_announcement() {
        let registry = SpliceRegistry::new();
        let daemon = crate::attach_ticket::TEST_DAEMON_ID;
        let _earlier = registry
            .attach_tunnel("earlier", daemon, "AAAAAAAAAAAAAAAAAAAAAA")
            .unwrap();
        let _later = registry
            .attach_tunnel("later", daemon, "BBBBBBBBBBBBBBBBBBBBBB")
            .unwrap();
        let sessions = registry.read_sessions();
        assert!(!sessions.contains_key("earlier"));
        assert!(sessions.contains_key("later"));
    }

    #[tokio::test]
    async fn candidate_promotion_is_bound_to_the_exact_daemon_attachment() {
        let registry = SpliceRegistry::new();
        let browser = registry
            .attach("proof#signaling", Role::Browser, crate::attach_ticket::TEST_DAEMON_ID)
            .unwrap();
        let daemon = registry
            .attach("proof#signaling", Role::Daemon, crate::attach_ticket::TEST_DAEMON_ID)
            .unwrap();
        let successor = registry
            .attach("proof#signaling", Role::Daemon, crate::attach_ticket::TEST_DAEMON_ID)
            .unwrap();
        assert!(matches!(
            registry.promote_candidate("proof#signaling", crate::attach_ticket::TEST_DAEMON_ID, daemon.attachment_id),
            Err(AttachError::CounterpartChanged)
        ));
        let promoted = registry
            .promote_candidate("proof#signaling", crate::attach_ticket::TEST_DAEMON_ID, successor.attachment_id)
            .unwrap();
        assert_eq!(
            promoted.replaced.unwrap().attachment_id,
            browser.attachment_id
        );
        assert!(promoted.both_attached);
    }

    /// A daemon that attaches after the browser reads the address the browser's
    /// attachment already proved: the path is slot state, not an event it missed.
    #[tokio::test]
    async fn a_daemon_reads_the_browser_path_published_before_it_attached() {
        let registry = SpliceRegistry::new();
        let browser = registry
            .attach(
                "path#signaling",
                Role::Browser,
                crate::attach_ticket::TEST_DAEMON_ID,
            )
            .unwrap();
        let address: IpAddr = "203.0.113.9".parse().unwrap();
        registry.publish_browser_path("path#signaling", browser.attachment_id, address);
        let daemon = registry
            .attach(
                "path#signaling",
                Role::Daemon,
                crate::attach_ticket::TEST_DAEMON_ID,
            )
            .unwrap();
        assert_eq!(
            *daemon.browser_path.borrow(),
            Some(BrowserPath {
                attachment_id: browser.attachment_id,
                address,
            })
        );
    }

    /// Only the browser attachment seated now speaks for the slot's path.
    #[tokio::test]
    async fn a_displaced_browser_attachment_cannot_publish_a_path() {
        let registry = SpliceRegistry::new();
        let first = registry
            .attach(
                "displaced#signaling",
                Role::Browser,
                crate::attach_ticket::TEST_DAEMON_ID,
            )
            .unwrap();
        let second = registry
            .attach(
                "displaced#signaling",
                Role::Browser,
                crate::attach_ticket::TEST_DAEMON_ID,
            )
            .unwrap();
        let daemon = registry
            .attach(
                "displaced#signaling",
                Role::Daemon,
                crate::attach_ticket::TEST_DAEMON_ID,
            )
            .unwrap();
        registry.publish_browser_path(
            "displaced#signaling",
            first.attachment_id,
            "198.51.100.1".parse().unwrap(),
        );
        assert_eq!(*daemon.browser_path.borrow(), None);
        registry.publish_browser_path(
            "displaced#signaling",
            second.attachment_id,
            "198.51.100.2".parse().unwrap(),
        );
        assert_eq!(
            daemon.browser_path.borrow().map(|path| path.attachment_id),
            Some(second.attachment_id)
        );
    }

    /// A dual-stack listener reports an IPv4 browser in its mapped form; the
    /// daemon must see the one address the browser's network has.
    #[tokio::test]
    async fn an_ipv4_mapped_browser_address_is_published_as_ipv4() {
        let registry = SpliceRegistry::new();
        let browser = registry
            .attach(
                "mapped#signaling",
                Role::Browser,
                crate::attach_ticket::TEST_DAEMON_ID,
            )
            .unwrap();
        registry.publish_browser_path(
            "mapped#signaling",
            browser.attachment_id,
            "::ffff:203.0.113.9".parse().unwrap(),
        );
        assert_eq!(
            browser.browser_path.borrow().map(|path| path.address),
            Some("203.0.113.9".parse().unwrap())
        );
    }

    /// Mirrors `SpliceControlEvent` in the daemon's `edge_tunnel.rs` and
    /// `parseSpliceControlEvent` in `packages/shared/src/edge-signaling.ts`.
    #[test]
    fn path_events_have_the_mirrored_wire_shape() {
        assert_eq!(
            serde_json::to_string(&SpliceControlEvent::ObservedPath {
                address: "2001:db8::7".parse().unwrap(),
            })
            .unwrap(),
            r#"{"type":"observed_path","address":"2001:db8::7"}"#
        );
        assert_eq!(
            serde_json::to_string(&SpliceControlEvent::CounterpartPath {
                counterpart_attachment_id: 7,
                address: "203.0.113.9".parse().unwrap(),
            })
            .unwrap(),
            r#"{"type":"counterpart_path","counterpart_attachment_id":7,"address":"203.0.113.9"}"#
        );
    }

    #[tokio::test]
    async fn candidate_cannot_resurrect_an_expired_daemon_half_pair() {
        let registry = SpliceRegistry::with_limits_and_byte_budgets(4, Duration::ZERO, 1024, 4096);
        let daemon = registry
            .attach("expired#signaling", Role::Daemon, crate::attach_ticket::TEST_DAEMON_ID)
            .unwrap();
        assert!(matches!(
            registry.promote_candidate("expired#signaling", crate::attach_ticket::TEST_DAEMON_ID, daemon.attachment_id),
            Err(AttachError::CounterpartChanged)
        ));
        assert!(!registry.read_sessions().contains_key("expired#signaling"));
    }

    // The production counters are process-global, while Rust tests in this
    // module execute concurrently. Serialize the two exact-delta assertions so
    // one test cannot make the other's otherwise-local observation appear to
    // have dropped a datagram.
    static ROUTE_DROP_COUNTER_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    async fn next_lifecycle(
        receiver: &mut watch::Receiver<Option<AttachmentLifecycle>>,
    ) -> AttachmentLifecycle {
        receiver.changed().await.expect("lifecycle sender");
        receiver
            .borrow_and_update()
            .expect("lifecycle value after notification")
    }

    fn delivery_quote(sent_packets: u64, lost_packets: u64) -> SpliceDeliveryQuote {
        SpliceDeliveryQuote {
            browser_attachment_id: 9,
            rtt_us: 120_000,
            congestion_window_bytes: 64 * 1024,
            bytes_in_flight: 8 * 1024,
            send_buffer_occupied_bytes: 4 * 1024,
            mtu_bytes: 1_200,
            pacing_rate_bps: 8_000_000,
            sent_packets,
            lost_packets,
            contention: SpliceContention::default(),
            pto_count: 0,
            send_blocked: false,
        }
    }

    #[tokio::test]
    async fn delivery_quotes_are_bounded_newest_wins_and_never_hide_lifecycle() {
        let (sink, mut receivers) = PeerSink::new(Role::Daemon, AttachmentId(7));
        let first = delivery_quote(32, 0);
        sink.publish_delivery_quote(first);
        assert!(receivers.delivery_quote_rx.has_changed().unwrap());
        assert_eq!(
            *receivers.delivery_quote_rx.borrow_and_update(),
            Some(first)
        );

        // Timer noise below every material threshold is suppressed entirely.
        sink.publish_delivery_quote(first);
        assert!(!receivers.delivery_quote_rx.has_changed().unwrap());

        let mut newest = first;
        for sample in 2..=10_000 {
            newest = delivery_quote(sample * 32, sample / 1_000);
            sink.publish_delivery_quote(newest);
        }
        // A watch cell owns one value regardless of producer/consumer skew.
        assert_eq!(
            *receivers.delivery_quote_rx.borrow_and_update(),
            Some(newest)
        );

        sink.signal(AttachmentLifecycle::CounterpartDetached {
            attachment_id: AttachmentId(9),
            rebind_window_remaining_ms: 30_000,
        });
        for sample in 10_001..=20_000 {
            sink.publish_delivery_quote(delivery_quote(sample * 32, sample / 1_000));
        }
        assert_eq!(
            next_lifecycle(&mut receivers.lifecycle_rx).await,
            AttachmentLifecycle::CounterpartDetached {
                attachment_id: AttachmentId(9),
                rebind_window_remaining_ms: 30_000,
            },
            "quote churn must not occupy or delay the independent lifecycle cell"
        );
    }

    #[test]
    fn delivery_quote_json_is_the_daemon_mirror_shape() {
        // Byte-identical to `EDGE_QUOTE_JSON` in the daemon's edge_tunnel tests.
        let quote = SpliceDeliveryQuote {
            browser_attachment_id: 42,
            rtt_us: 4_000,
            congestion_window_bytes: 64_000,
            bytes_in_flight: 11_000,
            send_buffer_occupied_bytes: 12_000,
            mtu_bytes: 1_400,
            pacing_rate_bps: 10_000_000,
            sent_packets: 6_000,
            lost_packets: 2,
            contention: SpliceContention {
                interactive_blocked: 3,
                interactive_paced: 4,
                interactive_waited_us: 5,
                bulk_blocked: 6,
                bulk_paced: 7,
                bulk_waited_us: 8,
                forward_residence: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
                model: Some(EgressModelQuote {
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
            },
            pto_count: 3,
            send_blocked: true,
        };
        assert_eq!(
            serde_json::to_string(&SpliceDeliveryQuoteEvent::from(quote)).unwrap(),
            r#"{"type":"counterpart_delivery_quote","browser_attachment_id":42,"rtt_us":4000,"congestion_window_bytes":64000,"bytes_in_flight":11000,"send_buffer_occupied_bytes":12000,"mtu_bytes":1400,"pacing_rate_bps":10000000,"sent_packets":6000,"lost_packets":2,"interactive_blocked":3,"interactive_paced":4,"interactive_waited_us":5,"bulk_blocked":6,"bulk_paced":7,"bulk_waited_us":8,"forward_residence":[1,2,3,4,5,6,7,8,9,10,11,12],"model":{"epoch":17,"bw":4294967311,"rtprop_us":120000,"pacing_rate":8589934609,"bulk_cap":65536,"quantum":1200,"phase":5,"probes_gated":1,"probes_aborted":2,"interactive_in_probe":3,"queue_growth_cuts":4,"loss_rounds":5,"ce_rounds":6,"probe_rtts":7},"pto_count":3,"send_blocked":true}"#
        );
    }

    #[test]
    fn absent_profiling_adds_no_model_fields_to_delivery_quotes() {
        let mut quote = delivery_quote(1, 0);
        quote.contention = SpliceContention::new(None, [0; FORWARD_RESIDENCE_BUCKETS]);
        let encoded = serde_json::to_value(SpliceDeliveryQuoteEvent::from(quote)).unwrap();
        assert!(encoded.get("model").is_none());
    }

    #[test]
    fn forward_residence_buckets_are_log2_microseconds_from_sixteen() {
        let residence = ForwardResidence::default();
        for micros in [0, 15, 16, 31, 32, 1_023, 1_024, 16_383, 16_384, 900_000] {
            residence.record(Duration::from_micros(micros));
        }
        assert_eq!(
            residence.snapshot(),
            [2, 2, 1, 0, 0, 0, 1, 1, 0, 0, 1, 2],
            "[0,16) [16,32) [32,64) .. [8192,16384) [16384,inf)"
        );
    }

    #[test]
    fn contention_changes_are_material_on_the_next_tick() {
        let quiet = delivery_quote(32, 0);
        let mut refused = quiet;
        refused.contention.interactive_blocked = 1;
        assert!(refused.materially_differs(quiet));
        let mut slow = quiet;
        slow.contention.forward_residence[9] = 1;
        assert!(slow.materially_differs(quiet));
        assert!(!quiet.materially_differs(quiet));
    }

    #[test]
    fn blocking_and_entering_or_leaving_backoff_are_material_and_deeper_backoff_is_not() {
        let quiet = delivery_quote(32, 0);
        let mut probing = quiet;
        probing.pto_count = 1;
        assert!(probing.materially_differs(quiet));
        assert!(quiet.materially_differs(probing));
        let mut deeper = probing;
        deeper.pto_count = 4;
        assert!(!deeper.materially_differs(probing));
        let mut blocked = probing;
        blocked.send_blocked = true;
        assert!(blocked.materially_differs(probing));
        assert!(probing.materially_differs(blocked));
    }

    #[test]
    fn a_replaced_daemons_requests_never_withdraw_its_successors() {
        let requests = ContentionRequests::default();
        let (old, new) = (AttachmentId(1), AttachmentId(2));
        requests.set(old, true);
        // The successor states its request first; the predecessor's stream
        // ends afterwards and must not withdraw it.
        requests.set(new, true);
        requests.end(old);
        assert!(requests.asked());
        requests.end(new);
        assert!(!requests.asked());
    }

    #[test]
    fn frame_clones_share_payload_storage() {
        let frame = Frame::datagram(Bytes::copy_from_slice(b"opaque-datagram"));
        let cloned = frame.clone();

        assert_eq!(frame, cloned);
        assert_eq!(
            frame.datagrams.payloads()[0].as_ptr(),
            cloned.datagrams.payloads()[0].as_ptr()
        );
    }

    fn reliable_header(body_len: usize) -> [u8; RELIABLE_RECORD_HEADER_BYTES] {
        (body_len as u32).to_be_bytes()
    }

    fn datagram(payload: &'static [u8]) -> Frame {
        Frame::datagram(Bytes::from_static(payload))
    }

    #[tokio::test]
    async fn a_full_destination_mailbox_counts_a_drop_for_the_source_role() {
        let registry = SpliceRegistry::new();
        let sid = "mailbox-full";

        let daemon = registry
            .attach(sid, Role::Daemon, crate::attach_ticket::TEST_DAEMON_ID)
            .expect("daemon attach");
        let browser = registry
            .attach(sid, Role::Browser, crate::attach_ticket::TEST_DAEMON_ID)
            .expect("browser attach");

        let _counter_guard = ROUTE_DROP_COUNTER_TEST_LOCK
            .lock()
            .expect("route-drop counter test lock");

        // The counters are process-global statics shared with every other test
        // in this binary, so assert on a delta rather than an absolute value.
        let before = metrics::route_drop_counter(Role::Browser).load(AtomicOrdering::Relaxed);

        // Fill the daemon's inbound mailbox to its bound. Nothing reads
        // `daemon.datagram_rx`, so every one of these stays queued.
        for _ in 0..SPLICE_MAILBOX_DEPTH {
            assert!(browser.datagram_route.route(datagram(b"queued")));
        }
        assert_eq!(
            metrics::route_drop_counter(Role::Browser).load(AtomicOrdering::Relaxed),
            before,
            "frames accepted into the mailbox must not count as drops"
        );

        // The next frame has nowhere to go.
        assert!(!browser.datagram_route.route(datagram(b"dropped")));
        assert_eq!(
            metrics::route_drop_counter(Role::Browser).load(AtomicOrdering::Relaxed),
            before + 1
        );

        drop(daemon);
    }

    #[tokio::test]
    async fn an_unpaired_counterpart_is_not_counted_as_a_drop() {
        let registry = SpliceRegistry::new();
        let sid = "half-paired";

        // Only the browser attaches; the daemon never arrives. Every session
        // passes through this state while the second peer dials in, so counting
        // it as a drop would swamp the real signal.
        let browser = registry
            .attach(sid, Role::Browser, crate::attach_ticket::TEST_DAEMON_ID)
            .expect("browser attach");

        let _counter_guard = ROUTE_DROP_COUNTER_TEST_LOCK
            .lock()
            .expect("route-drop counter test lock");

        let before = metrics::route_drop_counter(Role::Browser).load(AtomicOrdering::Relaxed);
        assert!(!browser.datagram_route.route(datagram(b"unpaired")));
        assert_eq!(
            metrics::route_drop_counter(Role::Browser).load(AtomicOrdering::Relaxed),
            before
        );
    }

    #[tokio::test]
    async fn splices_datagrams_in_both_directions_unchanged() {
        let registry = SpliceRegistry::new();
        let sid = "session-abc";

        let mut daemon = registry
            .attach(sid, Role::Daemon, crate::attach_ticket::TEST_DAEMON_ID)
            .expect("daemon attach");
        assert!(!daemon.both_attached);
        let mut browser = registry
            .attach(sid, Role::Browser, crate::attach_ticket::TEST_DAEMON_ID)
            .expect("browser attach");
        assert!(browser.both_attached);

        let up = Frame::datagram(Bytes::from_static(b"opaque-noise-ciphertext-up"));
        assert!(browser.datagram_route.route(up.clone()));
        assert_eq!(daemon.datagram_rx.recv().await, Some(up));

        let down = Frame::datagram(Bytes::from_static(b"opaque-noise-ciphertext-down"));
        assert!(daemon.datagram_route.route(down.clone()));
        assert_eq!(browser.datagram_rx.recv().await, Some(down));
    }

    /// A browser departure demotes the slot to half-paired and tells the
    /// daemon, but must NOT retire the daemon's transport: the whole point is
    /// that a browser whose carrier died can come back to a tunnel that never
    /// left. The generation-safety half of the old behaviour is unchanged and
    /// still pinned below.
    #[tokio::test]
    async fn three_splices_fence_every_role_and_generation_independently() {
        for order in [
            [0, 1, 2],
            [0, 2, 1],
            [1, 0, 2],
            [1, 2, 0],
            [2, 0, 1],
            [2, 1, 0],
        ] {
            for role in [Role::Browser, Role::Daemon] {
                let registry = SpliceRegistry::with_limits(3, Duration::from_secs(60));
                let labels = ["session#signaling", "session", "session#bulk"];
                let mut sources = Vec::new();
                let mut destinations = Vec::new();
                for label in labels {
                    sources.push(registry.attach(label, role, crate::attach_ticket::TEST_DAEMON_ID).expect("source"));
                    destinations.push(
                        registry
                            .attach(label, role.peer(), crate::attach_ticket::TEST_DAEMON_ID)
                            .expect("destination"),
                    );
                }
                for replaced in order {
                    let old_id = sources[replaced].attachment_id;
                    let replacement = registry
                        .attach(labels[replaced], role, crate::attach_ticket::TEST_DAEMON_ID)
                        .expect("replacement");
                    // Delayed cleanup must not cross either the attachment fence
                    // or the opaque routing label, regardless of replacement order.
                    registry.detach(labels[replaced], role, old_id);
                    assert!(!sources[replaced].datagram_route.route(datagram(b"stale")));
                    sources[replaced] = replacement;
                    for index in 0..3 {
                        assert!(sources[index].datagram_route.route(datagram(b"current")));
                        assert_eq!(
                            destinations[index].datagram_rx.recv().await,
                            Some(datagram(b"current"))
                        );
                        for (other, destination) in destinations.iter_mut().enumerate() {
                            if index != other {
                                assert!(destination.datagram_rx.try_recv().is_err());
                            }
                        }
                    }
                }
            }
        }
    }

    #[tokio::test]
    async fn browser_detach_holds_the_daemon_half_paired_for_rebind() {
        let registry = SpliceRegistry::with_limits(1, Duration::from_secs(60));
        let sid = "ephemeral";

        // Daemon first, as in production: it attaches ahead of the browser.
        let mut daemon = registry
            .attach(sid, Role::Daemon, crate::attach_ticket::TEST_DAEMON_ID)
            .expect("daemon attach");
        let browser = registry
            .attach(sid, Role::Browser, crate::attach_ticket::TEST_DAEMON_ID)
            .expect("browser attach");
        assert_eq!(
            next_lifecycle(&mut daemon.lifecycle_rx).await,
            AttachmentLifecycle::CounterpartAttached {
                attachment_id: browser.attachment_id
            }
        );

        registry.detach(sid, Role::Browser, browser.attachment_id);
        assert_eq!(
            next_lifecycle(&mut daemon.lifecycle_rx).await,
            AttachmentLifecycle::CounterpartDetached {
                attachment_id: browser.attachment_id,
                rebind_window_remaining_ms: 60_000
            }
        );

        // The daemon sink survives, so a returning browser re-pairs to the very
        // same daemon attachment and traffic resumes without a new session.
        let rebound_browser = registry
            .attach(sid, Role::Browser, crate::attach_ticket::TEST_DAEMON_ID)
            .expect("rebound browser");
        assert_eq!(
            next_lifecycle(&mut daemon.lifecycle_rx).await,
            AttachmentLifecycle::CounterpartAttached {
                attachment_id: rebound_browser.attachment_id
            }
        );
        let resumed = Frame::datagram(Bytes::from_static(b"after-rebind"));
        assert!(rebound_browser.datagram_route.route(resumed.clone()));
        assert_eq!(daemon.datagram_rx.recv().await, Some(resumed));

        // The displaced browser attachment cannot route into the live pairing.
        assert!(!browser.datagram_route.route(Frame::datagram(Bytes::from_static(
            b"stale"
        ))));
    }

    /// A stale attachment id may not disturb the current generation. Unchanged
    /// by the rebind work, and now load-bearing for it.
    #[tokio::test]
    async fn detach_affects_only_the_exact_paired_generation() {
        let registry = SpliceRegistry::with_limits(1, Duration::from_secs(60));
        let sid = "ephemeral";

        let browser = registry
            .attach(sid, Role::Browser, crate::attach_ticket::TEST_DAEMON_ID)
            .expect("browser attach");
        let daemon = registry
            .attach(sid, Role::Daemon, crate::attach_ticket::TEST_DAEMON_ID)
            .expect("daemon attach");

        registry.detach(sid, Role::Browser, browser.attachment_id);

        let replacement_browser = registry
            .attach(sid, Role::Browser, crate::attach_ticket::TEST_DAEMON_ID)
            .expect("replacement browser");
        let mut replacement_daemon = registry
            .attach(sid, Role::Daemon, crate::attach_ticket::TEST_DAEMON_ID)
            .expect("replacement daemon");

        registry.detach(sid, Role::Daemon, daemon.attachment_id);
        let datagram = Frame::datagram(Bytes::from_static(b"current-generation"));
        assert!(replacement_browser.datagram_route.route(datagram.clone()));
        assert_eq!(replacement_daemon.datagram_rx.recv().await, Some(datagram));
    }

    #[tokio::test]
    async fn reconnect_displaces_stale_same_role_peer() {
        let registry = SpliceRegistry::new();
        let sid = "reconnect";

        let mut first = registry
            .attach(sid, Role::Browser, crate::attach_ticket::TEST_DAEMON_ID)
            .expect("first browser");
        let mut second = registry
            .attach(sid, Role::Browser, crate::attach_ticket::TEST_DAEMON_ID)
            .expect("second browser");
        assert!(second.replaced.is_some());

        let daemon = registry.attach(sid, Role::Daemon, crate::attach_ticket::TEST_DAEMON_ID).expect("daemon");
        let current = Frame::datagram(Bytes::from_static(b"current"));
        assert!(daemon.datagram_route.route(current.clone()));
        assert_eq!(second.datagram_rx.recv().await, Some(current));
        assert!(matches!(
            first.datagram_rx.try_recv(),
            Err(tokio::sync::mpsc::error::TryRecvError::Empty)
        ));

        assert!(!first.datagram_route.route(Frame::datagram(Bytes::from_static(
            b"stale"
        ))));
    }

    #[tokio::test]
    async fn record_budget_is_held_until_record_copy_finishes() {
        let direction = Arc::new(Semaphore::new(8));
        let global = Arc::new(Semaphore::new(8));
        let first = ReliableRecordBudget::acquire(&direction, &global, 4)
            .await
            .expect("first record budget");
        assert_eq!(direction.available_permits(), 0);
        assert_eq!(global.available_permits(), 0);

        let waiting_direction = direction.clone();
        let waiting_global = global.clone();
        let waiter = tokio::spawn(async move {
            ReliableRecordBudget::acquire(&waiting_direction, &waiting_global, 0).await
        });
        tokio::task::yield_now().await;
        assert!(!waiter.is_finished());

        drop(first);
        let second = tokio::time::timeout(Duration::from_secs(1), waiter)
            .await
            .expect("budget waiter did not resume")
            .expect("budget waiter task")
            .expect("second record budget");
        assert_eq!(direction.available_permits(), 4);
        assert_eq!(global.available_permits(), 4);
        drop(second);
        assert_eq!(direction.available_permits(), 8);
        assert_eq!(global.available_permits(), 8);
    }

    #[tokio::test]
    async fn record_budgets_are_directional_and_global() {
        let global = Arc::new(Semaphore::new(12));
        let to_browser = Arc::new(Semaphore::new(8));
        let to_daemon = Arc::new(Semaphore::new(8));

        let browser_record = ReliableRecordBudget::acquire(&to_browser, &global, 4)
            .await
            .expect("browser record");
        assert_eq!(to_browser.available_permits(), 0);
        assert_eq!(to_daemon.available_permits(), 8);
        assert_eq!(global.available_permits(), 4);

        let daemon_wait_direction = to_daemon.clone();
        let daemon_wait_global = global.clone();
        let waiter = tokio::spawn(async move {
            ReliableRecordBudget::acquire(&daemon_wait_direction, &daemon_wait_global, 1).await
        });
        tokio::task::yield_now().await;
        assert!(!waiter.is_finished(), "global budget was bypassed");

        drop(browser_record);
        let daemon_record = tokio::time::timeout(Duration::from_secs(1), waiter)
            .await
            .expect("global waiter did not resume")
            .expect("global waiter task")
            .expect("daemon record");
        assert_eq!(to_daemon.available_permits(), 3);
        drop(daemon_record);
        assert_eq!(global.available_permits(), 12);
    }
    #[tokio::test]
    async fn session_task_admission_exhausts_and_recovers_across_registry_clones() {
        let mut registry = SpliceRegistry::with_limits(1, Duration::from_secs(60));
        registry.global_session_tasks = Arc::new(Semaphore::new(1));
        let first = registry
            .acquire_session_task()
            .await
            .expect("first session task");
        assert_eq!(registry.global_session_tasks.available_permits(), 0);

        let waiting_registry = registry.clone();
        let waiter = tokio::spawn(async move { waiting_registry.acquire_session_task().await });
        tokio::task::yield_now().await;
        assert!(
            !waiter.is_finished(),
            "session task bypassed exhausted admission"
        );

        drop(first);
        let recovered = tokio::time::timeout(Duration::from_secs(1), waiter)
            .await
            .expect("session task admission did not recover")
            .expect("waiter task")
            .expect("recovered session task permit");
        assert_eq!(registry.global_session_tasks.available_permits(), 0);
        drop(recovered);
        assert_eq!(registry.global_session_tasks.available_permits(), 1);
    }

    #[tokio::test]
    async fn session_capacity_rejects_new_routing_labels() {
        let registry = SpliceRegistry::with_limits(1, Duration::from_secs(60));
        registry
            .attach("first", Role::Browser, crate::attach_ticket::TEST_DAEMON_ID)
            .expect("first session");

        assert!(matches!(
            registry.attach("second", Role::Browser, crate::attach_ticket::TEST_DAEMON_ID),
            Err(AttachError::Capacity)
        ));
    }

    #[tokio::test]
    async fn expired_same_label_cannot_be_revived_before_cleanup_runs() {
        let registry = SpliceRegistry::with_limits(1, Duration::ZERO);
        let mut expired_browser = registry
            .attach("same-label", Role::Browser, crate::attach_ticket::TEST_DAEMON_ID)
            .expect("browser half-pair");

        let daemon = registry
            .attach("same-label", Role::Daemon, crate::attach_ticket::TEST_DAEMON_ID)
            .expect("fresh daemon half-pair");

        assert!(!daemon.both_attached);
        assert_eq!(expired_browser.datagram_rx.recv().await, None);
    }

    #[tokio::test]
    async fn concurrent_datagram_routes_preserve_both_directions() {
        const FRAME_COUNT: usize = 128;

        let registry = SpliceRegistry::new();
        let mut browser = registry
            .attach("concurrent", Role::Browser, crate::attach_ticket::TEST_DAEMON_ID)
            .expect("browser");
        let mut daemon = registry
            .attach("concurrent", Role::Daemon, crate::attach_ticket::TEST_DAEMON_ID)
            .expect("daemon");
        let start = Arc::new(std::sync::Barrier::new(3));

        let browser_route = browser.datagram_route;
        let browser_start = Arc::clone(&start);
        let browser_sender = std::thread::spawn(move || {
            browser_start.wait();
            for _ in 0..FRAME_COUNT {
                assert!(browser_route.route(Frame::datagram(Bytes::from_static(&[1]))));
            }
        });

        let daemon_route = daemon.datagram_route;
        let daemon_start = Arc::clone(&start);
        let daemon_sender = std::thread::spawn(move || {
            daemon_start.wait();
            for _ in 0..FRAME_COUNT {
                assert!(daemon_route.route(Frame::datagram(Bytes::from_static(&[2]))));
            }
        });

        start.wait();
        browser_sender.join().expect("browser route thread");
        daemon_sender.join().expect("daemon route thread");

        for _ in 0..FRAME_COUNT {
            assert_eq!(
                daemon.datagram_rx.recv().await.unwrap().datagrams.payloads()[0].as_ref(),
                &[1]
            );
            assert_eq!(
                browser.datagram_rx.recv().await.unwrap().datagrams.payloads()[0].as_ref(),
                &[2]
            );
        }
    }

    #[tokio::test]
    async fn expired_half_pair_is_pruned_but_complete_pair_survives() {
        let registry = SpliceRegistry::with_limits(2, Duration::from_millis(5));
        let mut lone = registry
            .attach("half", Role::Browser, crate::attach_ticket::TEST_DAEMON_ID)
            .expect("half session");
        let paired_browser = registry
            .attach("paired", Role::Browser, crate::attach_ticket::TEST_DAEMON_ID)
            .expect("paired browser");
        let mut paired_daemon = registry
            .attach("paired", Role::Daemon, crate::attach_ticket::TEST_DAEMON_ID)
            .expect("paired daemon");

        tokio::time::sleep(Duration::from_millis(10)).await;
        assert_eq!(registry.prune_expired_unpaired(), 1);
        // Expiry must be NAMED, not merely a dropped sink. A bare drop reads to
        // the far side as an ordinary transport failure, which it answers by
        // redialling — resurrecting a tunnel for a peer that is gone and
        // re-arming the half-paired slot for another full window.
        assert_eq!(
            next_lifecycle(&mut lone.lifecycle_rx).await,
            AttachmentLifecycle::Retire(RetireReason::RebindWindowExpired)
        );
        assert!(
            paired_browser
                .datagram_route
                .route(Frame::datagram(Bytes::from_static(&[1])))
        );
        assert_eq!(
            paired_daemon
                .datagram_rx
                .recv()
                .await
                .expect("paired datagram")
                .datagrams
                .payloads()[0]
                .as_ref(),
            &[1]
        );
    }

    #[tokio::test]
    async fn expiration_worker_wakes_when_an_unpaired_session_is_attached() {
        let registry = SpliceRegistry::with_limits(1, Duration::ZERO);
        let cleanup_registry = registry.clone();
        let cleanup =
            tokio::spawn(async move { cleanup_registry.wait_and_prune_expired_unpaired().await });
        tokio::task::yield_now().await;
        assert!(
            !cleanup.is_finished(),
            "expiration worker polled instead of waiting for a state transition"
        );

        registry
            .attach("event-driven-expiry", Role::Browser, crate::attach_ticket::TEST_DAEMON_ID)
            .expect("half session");

        assert_eq!(
            tokio::time::timeout(Duration::from_secs(1), cleanup)
                .await
                .expect("expiration worker missed the attach transition")
                .expect("expiration worker task"),
            1
        );
        registry
            .attach("replacement", Role::Browser, crate::attach_ticket::TEST_DAEMON_ID)
            .expect("expired slot capacity was reclaimed");
    }

    #[test]
    fn role_peer_is_involutive() {
        assert_eq!(Role::Browser.peer(), Role::Daemon);
        assert_eq!(Role::Daemon.peer(), Role::Browser);
        assert_eq!(Role::Browser.peer().peer(), Role::Browser);
    }

    #[test]
    fn reliable_header_length_is_bounded_without_inspecting_opaque_bytes() {
        assert_eq!(
            reliable_body_len_from_header(&reliable_header(123)),
            Some(123)
        );
        assert_eq!(
            reliable_body_len_from_header(&reliable_header(MAX_RELIABLE_BODY)),
            Some(MAX_RELIABLE_BODY)
        );
        assert_eq!(
            reliable_body_len_from_header(&reliable_header(MAX_RELIABLE_BODY + 1)),
            None
        );
        assert_eq!(reliable_body_len_from_header(&[0; 4]), Some(0));
        assert_eq!(reliable_body_len_from_header(&[0; 3]), None);
        assert_eq!(reliable_body_len_from_header(&[0; 5]), None);
    }

    #[test]
    fn preface_roundtrips_as_json() {
        let preface = RoutingPreface {
            session_id: "abc".to_string(),
            role: Role::Daemon,
            version: PREFACE_VERSION,
            attachment: RoutingAttachment::Tunnel {
                incarnation: "AAAAAAAAAAAAAAAAAAAAAA".to_string(),
            },
            daemon_id: "daemon-1".to_string(),
            ticket: "ticket".to_string(),
        };
        let json = serde_json::to_vec(&preface).expect("serialize");
        let back: RoutingPreface = serde_json::from_slice(&json).expect("deserialize");
        assert_eq!(back.session_id, "abc");
        assert_eq!(back.role, Role::Daemon);
        assert_eq!(back.version, PREFACE_VERSION);
    }

    #[test]
    fn preface_requires_an_explicit_current_version() {
        let missing = br#"{"session_id":"abc","role":"daemon"}"#;
        assert!(serde_json::from_slice::<RoutingPreface>(missing).is_err());

        let current = br#"{"session_id":"abc","role":"daemon","version":8,"attachment":{"kind":"tunnel","incarnation":"AAAAAAAAAAAAAAAAAAAAAA"},"daemon_id":"daemon-1","ticket":"ticket"}"#;
        let decoded = serde_json::from_slice::<RoutingPreface>(current).expect("current preface");
        assert_eq!(decoded.version, PREFACE_VERSION);
        assert!(crate::relay::validate_routing_preface(decoded).is_ok());

        // A daemon carrier names its incarnation; a client's never does.
        let anonymous_tunnel = br#"{"session_id":"abc","role":"daemon","version":8,"attachment":{"kind":"primary"},"daemon_id":"daemon-1","ticket":"ticket"}"#;
        let anonymous_tunnel =
            serde_json::from_slice::<RoutingPreface>(anonymous_tunnel).expect("envelope");
        assert!(crate::relay::validate_routing_preface(anonymous_tunnel).is_err());
        let client_tunnel = br#"{"session_id":"abc","role":"browser","version":8,"attachment":{"kind":"tunnel","incarnation":"AAAAAAAAAAAAAAAAAAAAAA"},"daemon_id":"daemon-1","ticket":"ticket"}"#;
        let client_tunnel =
            serde_json::from_slice::<RoutingPreface>(client_tunnel).expect("envelope");
        assert!(crate::relay::validate_routing_preface(client_tunnel).is_err());
        // An announcement names no session, and only an announcement may not.
        let announce = br#"{"session_id":"","role":"daemon","version":8,"attachment":{"kind":"announce","incarnation":"AAAAAAAAAAAAAAAAAAAAAA"},"daemon_id":"daemon-1","ticket":"ticket"}"#;
        let announce = serde_json::from_slice::<RoutingPreface>(announce).expect("envelope");
        assert!(crate::relay::validate_routing_preface(announce).is_ok());
        let session_announce = br#"{"session_id":"abc","role":"daemon","version":8,"attachment":{"kind":"announce","incarnation":"AAAAAAAAAAAAAAAAAAAAAA"},"daemon_id":"daemon-1","ticket":"ticket"}"#;
        let session_announce =
            serde_json::from_slice::<RoutingPreface>(session_announce).expect("envelope");
        assert!(crate::relay::validate_routing_preface(session_announce).is_err());
        let short_incarnation = br#"{"session_id":"","role":"daemon","version":8,"attachment":{"kind":"announce","incarnation":"AAAA"},"daemon_id":"daemon-1","ticket":"ticket"}"#;
        let short_incarnation =
            serde_json::from_slice::<RoutingPreface>(short_incarnation).expect("envelope");
        assert!(crate::relay::validate_routing_preface(short_incarnation).is_err());

        // There is exactly one version of Merkur: the superseded envelope is
        // decoded but rejected, never accepted alongside the current one.
        let superseded = br#"{"session_id":"abc","role":"daemon","version":5,"attachment":{"kind":"primary"},"daemon_id":"daemon-1","ticket":"ticket"}"#;
        let superseded =
            serde_json::from_slice::<RoutingPreface>(superseded).expect("well-formed envelope");
        assert!(crate::relay::validate_routing_preface(superseded).is_err());

        let removed_field =
            br#"{"session_id":"abc","role":"daemon","version":2,"capabilities":[]}"#;
        assert!(serde_json::from_slice::<RoutingPreface>(removed_field).is_err());

        // The v5 envelope, with no ticket at all, does not decode.
        let unticketed =
            br#"{"session_id":"abc","role":"daemon","version":5,"attachment":{"kind":"primary"}}"#;
        assert!(serde_json::from_slice::<RoutingPreface>(unticketed).is_err());
    }

    #[tokio::test]
    async fn a_label_pairs_only_attachments_naming_one_daemon() {
        let registry = SpliceRegistry::new();
        registry
            .attach("pinned", Role::Browser, "daemon-1")
            .expect("first attachment binds the label");
        assert!(matches!(
            registry.attach("pinned", Role::Daemon, "daemon-2"),
            Err(AttachError::DaemonMismatch)
        ));
        assert!(
            registry
                .attach("pinned", Role::Daemon, "daemon-1")
                .expect("the named daemon pairs")
                .both_attached
        );
        assert_eq!(
            registry.candidate_target("pinned", "daemon-2").err(),
            Some(())
        );
    }
}

#[cfg(test)]
mod egress_tests {
    use super::*;
    use crate::egress_budget::BudgetState;

    #[tokio::test]
    async fn budget_retires_only_data_lanes_then_every_lane() {
        let registry = SpliceRegistry::new();
        let data = registry.attach("budget", Role::Browser, "daemon").unwrap();
        let bulk = registry
            .attach("budget#bulk", Role::Daemon, "daemon")
            .unwrap();
        let signaling = registry
            .attach("budget#signaling", Role::Browser, "daemon")
            .unwrap();
        registry.apply_egress_state(BudgetState::SignalingOnly);
        for handle in [data, bulk] {
            assert_eq!(
                *handle.lifecycle_rx.borrow(),
                Some(AttachmentLifecycle::Retire(RetireReason::EgressBudget)),
            );
        }
        assert!(signaling.lifecycle_rx.borrow().is_none());
        assert_eq!(registry.read_sessions().len(), 1);
        assert!(matches!(
            registry.attach("budget", Role::Browser, "daemon"),
            Err(AttachError::EgressBudget),
        ));
        registry.apply_egress_state(BudgetState::Stopped);
        assert_eq!(
            *signaling.lifecycle_rx.borrow(),
            Some(AttachmentLifecycle::Retire(RetireReason::EgressBudget)),
        );
        assert!(registry.read_sessions().is_empty());
        assert!(matches!(
            registry.attach("new#signaling", Role::Browser, "daemon"),
            Err(AttachError::EgressBudget),
        ));
        registry.apply_egress_state(BudgetState::Open);
        assert!(registry.attach("new", Role::Browser, "daemon").is_ok());
    }
}
