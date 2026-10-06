//! One session to one machine, sans-IO.
//!
//! The driver starts it with [`Session::connect`], performs every [`Action`]
//! it returns from [`Session::poll_action`], feeds back every [`Event`] with
//! the monotonic time, and calls [`Session::handle_timeout`] at
//! [`Session::next_deadline`]. It also answers every
//! [`Session::take_signature_request`] with [`Session::signed`]: the delegate
//! key is the host's, and a hardware key signs for milliseconds the session
//! spends dialing. The session never blocks and never reads a clock.
//!
//! It covers issuance, the three edge attachments, the three authentication
//! flights, the data-attachment handshake, input, the liveness ladder,
//! handing opened terminal frames to the viewer and carrying its display ACKs
//! and snapshot requests back, then recovery: only proof
//! displaces a carrier. Evidence against the incumbent (a lapsed pong
//! deadline, or its close) starts one candidate signaling attachment that
//! rebinds with the chaining secret while the incumbent keeps serving.
//! Incumbent progress cancels the candidate until its final flight is sent;
//! after that only the daemon's authenticated commit acknowledgement decides,
//! and it publishes the candidate. A refusal, or an edge that no longer holds
//! the daemon, falls back to a fresh issuance. A candidate the edge does not
//! take asks the server, through a renewal, for the certificate hashes the edge
//! serves now; every renewal's answer replaces the pins. The direct path and
//! renewal build on it.

use std::collections::VecDeque;
use std::sync::Arc;

use merkur_authorization::encode;
use merkur_e2e::{NoiseTransport, RebindKeeper};
use merkur_edge_protocol::{
    PREFACE_VERSION, Role, RoutingAttachment, RoutingPreface, SpliceControlEvent,
};
use merkur_wire::protocol::{
    CHANNEL_CTRL, CHANNEL_DATA_HELLO, CHANNEL_DISPLAY_ACK, CHANNEL_DISPLAY_COMMIT,
    CHANNEL_DISPLAY_DATAGRAM, CHANNEL_PTY, CHANNEL_SIGNALING, DATA_HANDSHAKE_NONCE_BYTES,
    DataHandshakeKind, DisplayAckPayload, EdgeLane, MSG_TYPE_DISPLAY_ACK,
    MSG_TYPE_DISPLAY_DICT_ACK, MSG_TYPE_DISPLAY_DICT_READY, MSG_TYPE_DISPLAY_HASH_DIGEST,
    MSG_TYPE_DISPLAY_LINK_TABLE, MSG_TYPE_DISPLAY_REPAIR_END, MSG_TYPE_DISPLAY_RESUME,
    MSG_TYPE_DISPLAY_RESYNC_ROWS, MSG_TYPE_DISPLAY_SNAPSHOT_REQUEST, MSG_TYPE_GEOMETRY_STATE,
    MSG_TYPE_GRAPHICS_UNAVAILABLE, MSG_TYPE_HEARTBEAT_PING, MSG_TYPE_HEARTBEAT_PONG,
    MSG_TYPE_INPUT_ACK, MSG_TYPE_OPEN_URL, MSG_TYPE_OPEN_URL_ACK, OpenUrlId,
    decode_data_handshake_frame, decode_proto_frame, encode_data_handshake_frame,
    encode_probed_input_run_into, encode_proto_frame, parse_open_url,
};
use merkur_wire::signaling::{ClientSignal, DaemonSignal, DataClaim, DataLane};
use merkur_wire::{protocol::MSG_TYPE_TERMINAL_UI, terminal_ui::TerminalUi};
use zeroize::{Zeroize, Zeroizing};

use self::display_ack::ReliableAcks;
use self::outbox::Outbox;
use crate::auth::{AuthError, BoundAuth, Delegation, PendingAuth, UnsignedAuth};
use crate::input_sequence::InputMapping;
use crate::issuance::{Issuance, IssuanceRequest, RenewalCapability, RenewalRequest};
use crate::liveness::{Heartbeat, LivenessLink, PathKind, Verdict};
use crate::rebind::{Lineage, RebindFlight, Reconcile, Successor};
use crate::renewal::Renewal;
use crate::{Entropy, hex, uuid_v4};

/// One of the session's three edge connections.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ConnId(pub u64);

/// Heartbeat cadence, mirrored from `TRANSPORT_HEARTBEAT_INTERVAL_MS`.
pub const HEARTBEAT_INTERVAL_MS: u64 = 2_000;
/// Spacing between data-attachment HELLO retries, and how many are sent.
const HELLO_RETRY_MS: u64 = 250;
const HELLO_ATTEMPTS: u8 = 3;
/// A data lane is redialed this many times before the session recovers
/// instead, a failed dial after the delay; a pairing that held this long
/// earns its redials back. Mirrored from `DATA_REDIAL_MAX_ATTEMPTS`,
/// `DATA_REDIAL_DELAY_MS` and `DATA_CONFIRMED_STABLE_MS`.
const DATA_REDIAL_ATTEMPTS: u8 = 3;
const DATA_REDIAL_DELAY_MS: u64 = 2_000;
const DATA_CONFIRMED_STABLE_MS: u64 = 10_000;
/// A data attachment whose HELLO nothing acknowledged this long after the
/// first is dead. Mirrored from `DATA_ATTACHMENT_TIMEOUT_MS`.
const DATA_ATTACHMENT_TIMEOUT_MS: u64 = 35_000;
/// Entries one input-run datagram may carry, mirrored from `INPUT_RUN_MAX_ENTRIES`.
const INPUT_RUN_MAX_ENTRIES: usize = 255;
/// Plaintext budget of one input-run datagram, mirrored from
/// `INPUT_RUN_DATAGRAM_BUDGET_BYTES`: it must fit one datagram after sealing.
const INPUT_RUN_DATAGRAM_BUDGET_BYTES: usize = 1_100;
/// Bound on one candidate's request and answer, mirrored from
/// `AUTH_PHASE_WATCHDOG_MS`; above the daemon's own 8 s authentication timeout.
const AUTH_PHASE_WATCHDOG_MS: u64 = 10_000;
/// Recovery retry spacing, mirrored from `SIGNALING_RECONNECT_BASE_MS` and
/// `SIGNALING_RECONNECT_CEIL_MS`: exponential with full jitter, reset by
/// authenticated readiness.
const RECONNECT_BASE_MS: u64 = 500;
const RECONNECT_CEIL_MS: u64 = 5_000;
/// Refusals the daemon gives because the authorization epoch ran out: a
/// renewal lets the same lineage continue, once per candidate.
const RENEWABLE_REFUSALS: [&str; 2] = ["lineage_expired", "generation_budget_exhausted"];

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Action {
    /// `POST` the request to [`crate::issuance::ISSUANCE_PATH`] with the account
    /// access token and answer with [`Event::Issued`], [`Event::IssuanceFailed`],
    /// [`Event::AuthorizationDenied`], or [`Event::DaemonUnlinked`].
    RequestIssuance(IssuanceRequest),
    /// `POST` the request to [`crate::issuance::RENEWAL_PATH`] with the account
    /// access token and answer with [`Event::Renewed`].
    RequestRenewal(RenewalRequest),
    /// Open a WebTransport connection to `url`, pinned to `cert_hashes`, write
    /// `preface` on its first bidirectional stream, and report splice events
    /// read from that stream's reverse direction. A `candidate` then opens a
    /// second bidirectional stream for proof records ([`Action::SendProof`],
    /// [`Event::Proof`]).
    Dial {
        conn: ConnId,
        lane: EdgeLane,
        url: String,
        cert_hashes: Vec<[u8; 32]>,
        preface: Vec<u8>,
        candidate: bool,
    },
    /// Open a WebTransport connection straight to the daemon at `addr`,
    /// pinned to `cert_hash`, with a bidirectional stream per channel that
    /// carries records both ways. Reported as a data attachment is.
    DialDirect {
        conn: ConnId,
        addr: std::net::SocketAddr,
        cert_hash: [u8; 32],
    },
    /// One record on the connection's persistent stream for `channel`.
    SendReliable {
        conn: ConnId,
        channel: u8,
        payload: Vec<u8>,
    },
    /// One `[u32 BE len][record]` on a candidate's proof stream.
    SendProof {
        conn: ConnId,
        payload: Vec<u8>,
    },
    /// One datagram, channel byte included.
    SendDatagram {
        conn: ConnId,
        payload: Vec<u8>,
    },
    /// A cumulative input run, timed only when the host admits it to a carrier.
    SendInputDatagram {
        conn: ConnId,
        payload: Vec<u8>,
        top_seq: u32,
    },
    Close {
        conn: ConnId,
    },
    /// An opened terminal frame for the viewer, with the input numbering it
    /// arrived under: a display header names inputs by wire sequence.
    Terminal {
        channel: u8,
        datagram: bool,
        payload: Vec<u8>,
        input: InputMapping,
    },
    /// An authenticated reliable program request. The host acknowledges only
    /// after retaining it; output itself never authorizes opening a browser.
    TerminalUi(TerminalUi),
    /// Read-only, authenticated performance evidence for the host recorder.
    Observation(Box<observation::Observation>),
    OpenUrl {
        id: OpenUrlId,
        url: String,
    },
    /// A display lineage boundary for the viewer, ahead of any frame after it.
    DisplayFence(DisplayFence),
    /// Who owns the shared terminal's size, as the daemon last stated it.
    GeometryState(geometry::GeometryStatus),
    /// The daemon's animation clock, read within a round trip of `rtt_ms`
    /// that just ended.
    GraphicsClock {
        monotonic_us: u64,
        rtt_ms: u64,
    },
    /// A verified graphics asset of the scene of display lineage `epoch`.
    /// `job` names the job that fetched it when the host records that job:
    /// the host retires it once it has taken the asset.
    GraphicsAsset {
        epoch: u32,
        key: String,
        asset: graphics::GraphicsAsset,
        job: Option<u64>,
        bytes: Vec<u8>,
    },
    /// One transition of a graphics job, while the host records performance
    /// evidence. It is I/O, not host output, so the time the host reads it at
    /// never waits behind a display the host has yet to take. `bytes` is the
    /// object's size at `Fin`; `failed` marks a job retired without its asset.
    GraphicsJob {
        phase: graphics::GraphicsPhase,
        job: u64,
        bytes: u32,
        failed: bool,
    },
    Status(Status),
    /// Which path now carries the session's sealed frames.
    Path(PathKind),
    /// Proven source address of the committed signaling carrier.
    ObservedPath(std::net::IpAddr),
}

impl Action {
    /// Resident storage of a host output, including retained vector capacities.
    /// I/O actions do not spend host admission credit.
    pub fn host_resident_bytes(&self) -> usize {
        if !self.is_host_output() {
            return 0;
        }
        std::mem::size_of::<Self>()
            + match self {
                Self::Terminal { payload, .. } => payload.capacity(),
                Self::TerminalUi(effect) => match effect {
                    TerminalUi::Title(title) => title.capacity(),
                    TerminalUi::Notification { title, body } => title.capacity() + body.capacity(),
                    TerminalUi::Clipboard { text, .. } => text.capacity(),
                    TerminalUi::Bell => 0,
                },
                Self::OpenUrl { url, .. } => url.capacity(),
                Self::GraphicsAsset { key, bytes, .. } => key.capacity() + bytes.capacity(),
                Self::Observation(value) => value.resident_bytes(),
                _ => 0,
            }
    }

    fn is_host_output(&self) -> bool {
        matches!(
            self,
            Self::Terminal { .. }
                | Self::TerminalUi(_)
                | Self::Observation(_)
                | Self::OpenUrl { .. }
                | Self::DisplayFence(_)
                | Self::GeometryState(_)
                | Self::GraphicsClock { .. }
                | Self::GraphicsAsset { .. }
                | Self::Status(_)
                | Self::Path(_)
                | Self::ObservedPath(_)
        )
    }
}

/// An authenticated session began: the first, or the successor a rebind
/// committed. Every frame after it belongs to `lineage`, a nonzero number of
/// this client's authentications, which the viewer's resume claim names as
/// its repair and the daemon echoes on the repair it sends back.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DisplayFence {
    pub lineage: u32,
}

/// The viewer's claim about its grid, answered by the daemon with a repair of
/// the rows that diverged or with a snapshot. `row_hashes` is present exactly
/// when the viewer kept its grid, one `merkur_codec::row_hash` per row; the
/// daemon keeps its compression dictionaries under the same condition.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DisplayResume {
    pub generation: u32,
    pub applied_seq: u32,
    pub repair_id: u32,
    pub cols: u16,
    pub rows: u16,
    pub row_hashes: Option<Vec<u64>>,
}

/// The row-hash block's version, mirrored from the daemon's
/// `DISPLAY_RESUME_HASHES_VERSION`.
const DISPLAY_RESUME_HASHES_VERSION: u8 = 2;

impl DisplayResume {
    /// `generation:u32 | last_seq:u32 | repair_id:u32 | cols:u16 | rows:u16`,
    /// then, for a kept grid, `version:u8 | 0 | rows:u16 | rows * hash:u64`.
    fn encode(&self) -> Vec<u8> {
        let hashes = self.row_hashes.as_deref().unwrap_or_default();
        debug_assert!(
            self.row_hashes.is_none() || hashes.len() == usize::from(self.rows),
            "a claim covers exactly its rows"
        );
        let mut body = Vec::with_capacity(20 + hashes.len() * 8);
        body.extend_from_slice(&self.generation.to_be_bytes());
        body.extend_from_slice(&self.applied_seq.to_be_bytes());
        body.extend_from_slice(&self.repair_id.to_be_bytes());
        body.extend_from_slice(&self.cols.to_be_bytes());
        body.extend_from_slice(&self.rows.to_be_bytes());
        if self.row_hashes.is_some() {
            body.extend_from_slice(&[DISPLAY_RESUME_HASHES_VERSION, 0]);
            body.extend_from_slice(&self.rows.to_be_bytes());
            for hash in hashes {
                body.extend_from_slice(&hash.to_be_bytes());
            }
        }
        encode_proto_frame(MSG_TYPE_DISPLAY_RESUME, &body)
    }
}

/// A resume nothing answers (no display frame, digest or repair end) falls
/// back to a snapshot request. Mirrored from `DISPLAY_RESUME_WATCHDOG_MS`.
const DISPLAY_RESUME_WATCHDOG_MS: u64 = 1_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    Connecting,
    Authenticating,
    Ready,
    /// The incumbent failed to answer twice, or closed; a candidate or a
    /// fresh issuance is replacing it. Input is held, not dropped.
    Reconnecting,
    /// The edge paused relay data: the relay egress budget is spent. The
    /// data attachments wait for it to resume, then pair again (`Ready`).
    RelayPaused,
    Closed(CloseReason),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CloseReason {
    InputOverflow,
    IssuanceFailed,
    DaemonUnlinked,
    Auth(AuthError),
    AuthRejected,
    EdgeLost,
}

pub enum Event<'a> {
    /// A successful response, or None when its shape or identity is invalid.
    Issued(Option<Box<Issuance>>),
    /// The account request failed without an authoritative refusal.
    IssuanceFailed,
    /// The account API authoritatively reports that the daemon was unlinked.
    DaemonUnlinked,
    /// The authenticated account API refused authorization after token renewal.
    /// Carrier loss and network errors must never be converted to this event.
    AuthorizationDenied,
    Renewed(Option<RenewalCapability>),
    Connected(ConnId),
    DialFailed(ConnId),
    Splice(ConnId, SpliceControlEvent),
    /// One record from a persistent stream. The edge names its source
    /// attachment once per stream; the driver passes it with every record.
    Reliable {
        conn: ConnId,
        source: u64,
        channel: u8,
        payload: &'a [u8],
    },
    Datagram {
        conn: ConnId,
        payload: &'a [u8],
    },
    InputDatagramSent {
        conn: ConnId,
        top_seq: u32,
    },
    /// One record from a candidate's proof stream, the edge's selection byte
    /// already stripped.
    Proof {
        conn: ConnId,
        payload: &'a [u8],
    },
    /// The attachment ended; `egress_budget` when the edge closed it because
    /// the relay egress budget is spent.
    Closed {
        conn: ConnId,
        egress_budget: bool,
    },
    /// One part of a finite stream: graphics content, one transfer per
    /// stream. `stream` is unique within its attachment.
    Finite {
        conn: ConnId,
        stream: u64,
        part: graphics::FinitePart<'a>,
    },
}

pub struct Config {
    pub browser_node_id: String,
    /// Never race the daemon's direct path: every frame crosses the edge
    /// relay. Only the e2e harness sets it, so that its impairment proxy
    /// sees every frame, as the browser's `VITE_FORCE_EDGE` build does.
    pub relay_only: bool,
}

/// One proof the host's delegate key signs, under the session delegation
/// context, answered through [`Session::signed`] with the same `id`.
#[derive(Debug)]
pub struct SignatureRequest {
    pub id: u64,
    pub proof: Vec<u8>,
}

enum Phase {
    Idle,
    Issuing {
        pending: Box<PendingAuth>,
    },
    /// The lanes dial while the delegate signs; flight 1 leaves on the
    /// signaling lane once both are done.
    Dialing {
        unsigned: Option<Unsigned>,
        bound: Option<Box<BoundAuth>>,
        flight: Option<ClientSignal>,
    },
    Established(Box<Established>),
    Closed,
}

/// Flight 1 waiting on the host's signature for request `id`. A signer that
/// never answers (a wedged chip) ends the attempt at `deadline_ms`, as any
/// authentication phase that stops progressing does.
struct Unsigned {
    id: u64,
    deadline_ms: u64,
    auth: Box<UnsignedAuth>,
}

struct Established {
    transport: NoiseTransport,
    rebind: RebindKeeper,
    /// The direct path's upgrade key for the current generation.
    direct_upgrade_secret: Zeroizing<[u8; 32]>,
    /// The successor of a candidate that closed after its final flight: the
    /// daemon may have committed it, and only reconcile says which.
    uncertain: Option<Box<Successor>>,
}

/// One authenticated candidate signaling attachment racing the incumbent.
struct Candidate {
    conn: ConnId,
    /// The routing nonce the edge forwards to the daemon; the rebind request
    /// MAC covers it.
    nonce: [u8; 32],
    stage: CandidateStage,
    /// Once `rebind_final` left, incumbent progress can no longer retire the
    /// candidate: the daemon may already have committed it.
    final_sent: bool,
    /// When the attempt is abandoned if nothing decided it.
    deadline_ms: Option<u64>,
    /// When the outstanding reconcile is sent again.
    retransmit_ms: Option<u64>,
    /// A renewable refusal renews the epoch once per candidate.
    renewed: bool,
    /// The edge's relay-data pause as this attachment last heard it; the
    /// lanes it publishes start in it.
    relay_paused: bool,
    /// The address the edge observed this attachment at, which becomes the
    /// carrier's once it is published.
    observed_address: Option<std::net::IpAddr>,
    /// Direct-path manifests and punch outcomes the daemon answered on the
    /// proof stream, for the successor lineage they belong to.
    direct: Vec<DaemonSignal>,
}

enum CandidateStage {
    Dialing,
    /// Resolving an earlier attempt's uncertain commit before rebinding.
    Reconciling(Reconcile),
    Rebinding(Box<RebindFlight>),
    /// Refused for its epoch; the renewal decides whether it rebinds again.
    Renewing,
    /// The final flight left; the reconcile asks for the commit acknowledgement.
    Committing {
        reconcile: Reconcile,
        successor: Box<Successor>,
    },
}

struct Lanes {
    signaling: ConnId,
    interactive: ConnId,
    bulk: ConnId,
    signaling_up: bool,
    data: [DataAttachment; 2],
    /// The edge paused relay data: no data attachment is dialed until it
    /// resumes.
    relay_paused: bool,
}

/// One data attachment, owned apart from the signaling attachment as the
/// browser's `manageDataEdgeConnection` owns it: it is redialed on its own,
/// and the session recovers only once its redials are spent.
#[derive(Default)]
struct DataAttachment {
    up: bool,
    nonce: [u8; DATA_HANDSHAKE_NONCE_BYTES],
    /// HELLOs sent on the current attachment.
    attempts: u8,
    next_hello_ms: Option<u64>,
    /// The daemon attachment this lane is paired with, once its ACK arrived.
    counterpart: Option<u64>,
    /// Attachments dialed for this lane in this issuance.
    dials: u32,
    /// Redials since the lane last held a stable pairing.
    redials: u8,
    /// A redial waiting out its delay.
    redial_at_ms: Option<u64>,
    /// When the current attachment's HELLO was first acknowledged.
    confirmed_ms: Option<u64>,
    /// Unacknowledged past this, the current attachment is dead.
    deadline_ms: Option<u64>,
}

impl DataAttachment {
    /// The current attachment ended: nothing it paired or proved carries over.
    fn end_attachment(&mut self) {
        self.up = false;
        self.attempts = 0;
        self.next_hello_ms = None;
        self.counterpart = None;
        self.confirmed_ms = None;
        self.deadline_ms = None;
    }
}

pub struct Session {
    config: Config,
    perf_epoch: Option<u32>,
    input_retry: input_retry::Retry,
    quality: quality::Quality,
    delegation: Arc<Delegation>,
    daemon_id: String,
    issued: Option<Box<Issuance>>,
    phase: Phase,
    lanes: Option<Lanes>,
    next_conn: u64,
    outbox: Outbox,
    /// The plaintext input-run frame, reused for every send and wiped after it.
    input_frame: Zeroizing<Vec<u8>>,
    heartbeat: Heartbeat,
    candidate: Option<Box<Candidate>>,
    /// The incumbent closed or failed to answer twice.
    incumbent_lost: bool,
    /// An authenticated refusal ended rebinding this lineage.
    rebind_refused: bool,
    /// Whether a fresh issuance is recovery (retried) rather than the first
    /// connect (a failure closes the session).
    recovering: bool,
    /// Consecutive failed recovery attempts, and when the next one starts.
    failures: u32,
    retry_at_ms: Option<u64>,
    issuance_id: Option<String>,
    renewal: Option<Box<RenewalState>>,
    /// When the epoch is renewed ahead of its expiry, at half the lifetime
    /// the server stated. It schedules work; only the daemon's proof grants.
    maintenance_ms: Option<u64>,
    /// The first generation of the current authorization epoch.
    generation_base: u64,
    display_acks: ReliableAcks,
    /// Viewer control frames sent before the carrier could take them.
    display_owed: Vec<Vec<u8>>,
    /// The newest authentication's display lineage; 0 before the first.
    display_lineage: u32,
    direct: direct::Direct,
    paths: path_selection::Selection,
    primary_path: Option<PathKind>,
    primary_revision: u32,
    reliable_blocked: Vec<(ConnId, u8)>,
    display_ack_owed: Option<(DisplayAckPayload, bool)>,
    pong_owed: Vec<(ConnId, [u8; 16])>,
    host_observation_owed: [Option<Vec<u8>>; 4],
    resync_rows_owed: Option<(u32, Box<[u64; 1024]>)>,
    graphics: graphics::Graphics,
    geometry: geometry::Geometry,
    /// When a resume the daemon has not answered falls back to a snapshot.
    resume_watchdog_ms: Option<u64>,
    buffers: Buffers,
    actions: VecDeque<Action>,
    signature_requests: VecDeque<SignatureRequest>,
    /// Request ids are never reused, so a late answer cannot sign a newer proof.
    next_signature: u64,
}

/// The one renewal in flight.
struct RenewalState {
    renewal: Renewal,
    /// The signature request its proof waits on.
    signature: Option<u64>,
    /// Sent on a candidate refused for its epoch, else on signaling.
    via_candidate: bool,
    started_ms: u64,
    retransmit_ms: Option<u64>,
}

/// Byte buffers between frames. Opening a received frame and sealing one to
/// send each take a buffer here. It comes back when the session consumed the
/// frame itself, or when the host returns the payload of an action it has
/// finished with ([`Session::recycle`]); a host that keeps a payload costs the
/// allocation that payload always cost.
#[derive(Default)]
struct Buffers(Vec<Vec<u8>>);

impl Buffers {
    /// A host drains its actions as it feeds events, so a few buffers
    /// circulate; the rest cover a burst handled before the host polls.
    const KEPT: usize = 16;

    /// A zeroed buffer of exactly `len` bytes.
    fn take(&mut self, len: usize) -> Vec<u8> {
        let mut buffer = self.0.pop().unwrap_or_default();
        buffer.clear();
        buffer.resize(len, 0);
        buffer
    }

    fn put(&mut self, buffer: Vec<u8>) {
        if self.0.len() < Self::KEPT {
            self.0.push(buffer);
        }
    }
}

/// The incumbent carrier as the liveness ladder sees it: sealed CTRL pings on
/// the path that carries the session (the direct path once adopted, else the
/// interactive connection), and the input watermarks.
struct IncumbentLink<'a> {
    phase: &'a mut Phase,
    lanes: Option<&'a Lanes>,
    direct: Option<ConnId>,
    outbox: &'a Outbox,
    buffers: &'a mut Buffers,
    actions: &'a mut VecDeque<Action>,
    blocked: &'a [(ConnId, u8)],
}

impl LivenessLink for IncumbentLink<'_> {
    fn control_open(&self) -> bool {
        matches!(self.phase, Phase::Established(_))
            && (self.direct.is_some()
                || self
                    .lanes
                    .is_some_and(|lanes| lanes.data[0].counterpart.is_some()))
    }

    fn send_ping(&mut self, frame: &[u8]) -> bool {
        let (Phase::Established(established), Some(lanes)) = (&mut *self.phase, self.lanes) else {
            return false;
        };
        if writer_lane_blocked(self.blocked, lanes.interactive, CHANNEL_CTRL) {
            return false;
        }
        // Each provider gets its own seal: copied stream ciphertext would
        // be replayed on the second path and could not yield its RTT sample.
        let mut sent = false;
        if lanes.data[0].counterpart.is_some()
            && !self.blocked.contains(&(lanes.interactive, CHANNEL_CTRL))
        {
            sent |= seal_reliable(
                established,
                self.buffers,
                lanes.interactive,
                CHANNEL_CTRL,
                frame,
                self.actions,
            );
        }
        if let Some(direct) = self
            .direct
            .filter(|conn| !self.blocked.contains(&(*conn, CHANNEL_CTRL)))
        {
            sent |= seal_reliable(
                established,
                self.buffers,
                direct,
                CHANNEL_CTRL,
                frame,
                self.actions,
            );
        }
        sent
    }

    fn progress_seq(&self) -> u32 {
        self.outbox.acked()
    }

    fn emit_top_seq(&self) -> u32 {
        self.outbox.top()
    }
}

impl Session {
    pub fn new(config: Config, delegation: impl Into<Arc<Delegation>>) -> Self {
        Self {
            config,
            perf_epoch: None,
            input_retry: input_retry::Retry::default(),
            quality: quality::Quality::default(),
            delegation: delegation.into(),
            daemon_id: String::new(),
            issued: None,
            phase: Phase::Idle,
            lanes: None,
            next_conn: 1,
            outbox: Outbox::new(),
            input_frame: Zeroizing::new(Vec::new()),
            heartbeat: Heartbeat::new(HEARTBEAT_INTERVAL_MS),
            candidate: None,
            incumbent_lost: false,
            rebind_refused: false,
            recovering: false,
            failures: 0,
            retry_at_ms: None,
            issuance_id: None,
            renewal: None,
            maintenance_ms: None,
            generation_base: 0,
            display_acks: ReliableAcks::default(),
            display_owed: Vec::new(),
            display_lineage: 0,
            direct: direct::Direct::default(),
            paths: path_selection::Selection::default(),
            primary_path: None,
            primary_revision: 0,
            reliable_blocked: Vec::new(),
            display_ack_owed: None,
            pong_owed: Vec::new(),
            host_observation_owed: std::array::from_fn(|_| None),
            resync_rows_owed: None,
            graphics: graphics::Graphics::default(),
            geometry: geometry::Geometry::default(),
            resume_watchdog_ms: None,
            buffers: Buffers::default(),
            actions: VecDeque::new(),
            signature_requests: VecDeque::new(),
            next_signature: 1,
        }
    }

    pub fn poll_action(&mut self) -> Option<Action> {
        self.actions.pop_front()
    }

    /// Return the payload of an action the host has finished with, so the next
    /// frame the session opens or seals reuses its storage. Optional: a host
    /// whose payloads leave its thread simply keeps them.
    pub fn recycle(&mut self, payload: Vec<u8>) {
        self.buffers.put(payload);
    }

    /// The next proof the host's delegate key must sign.
    pub fn take_signature_request(&mut self) -> Option<SignatureRequest> {
        self.signature_requests.pop_front()
    }

    fn request_signature(&mut self, proof: Vec<u8>) -> u64 {
        let id = self.next_signature;
        self.next_signature += 1;
        self.signature_requests
            .push_back(SignatureRequest { id, proof });
        id
    }

    /// The host's answer to request `id`; `None` when its signer failed. An
    /// answer to a request no attempt still waits on is dropped; one that does
    /// not verify under the delegation fails what waited on it.
    pub fn signed(
        &mut self,
        now_ms: u64,
        id: u64,
        signature: Option<&[u8; merkur_authorization::SIGNATURE_BYTES]>,
        entropy: &mut impl Entropy,
    ) {
        if let Phase::Dialing { unsigned, .. } = &mut self.phase
            && unsigned.as_ref().is_some_and(|waiting| waiting.id == id)
        {
            let pending = unsigned.take().expect("checked above").auth;
            let signed = signature.ok_or(AuthError::InvalidRequest).and_then(|signature| {
                pending.sign(&self.delegation, signature)
            });
            let (bound, flight) = match signed {
                Ok(signed) => signed,
                Err(error) => return self.fail(CloseReason::Auth(error)),
            };
            if let Some(lanes) = self.lanes.as_ref().filter(|lanes| lanes.signaling_up) {
                self.actions.push_back(Action::SendReliable {
                    conn: lanes.signaling,
                    channel: CHANNEL_SIGNALING,
                    payload: flight.to_json().into_bytes(),
                });
                self.actions
                    .push_back(Action::Status(Status::Authenticating));
            }
            self.phase = Phase::Dialing {
                unsigned: None,
                bound: Some(Box::new(bound)),
                flight: Some(flight),
            };
            return;
        }
        let Some(state) = self.renewal.as_mut() else {
            return;
        };
        if state.signature != Some(id) {
            return;
        }
        state.signature = None;
        if signature.is_some_and(|signature| state.renewal.signed(&self.delegation, signature)) {
            self.send_renewal(now_ms, entropy);
        } else {
            self.settle_renewal(now_ms, None, entropy);
        }
    }

    /// The oldest host output, without transferring its ownership. An adapter
    /// reserves its destination's memory before removing this action.
    pub fn peek_host_action(&self) -> Option<&Action> {
        self.actions.iter().find(|action| action.is_host_output())
    }

    /// Host outputs preserve their own FIFO, including every display fence.
    pub fn poll_host_action(&mut self) -> Option<Action> {
        let index = self.actions.iter().position(Action::is_host_output)?;
        self.actions.remove(index)
    }

    /// I/O must continue while the host's receive queue is backpressured.
    /// This preserves I/O order and leaves the host-output FIFO untouched.
    pub fn poll_io_action(&mut self) -> Option<Action> {
        let index = self
            .actions
            .iter()
            .position(|action| !action.is_host_output())?;
        self.actions.remove(index)
    }

    /// The first I/O action whose own writer has not refused admission.
    /// Datagram retries and other writers bypass an independently stalled lane.
    pub fn poll_available_io_action(&mut self) -> Option<Action> {
        let mut preceding_lanes = 0u8;
        let index = self.actions.iter().position(|action| {
            if action.is_host_output() {
                return false;
            }
            match action {
                Action::SendReliable { conn, channel, .. } => {
                    let lane = merkur_e2e::lane_for_channel(*channel);
                    let earlier = lane.is_some_and(|lane| preceding_lanes & (1 << lane) != 0);
                    if let Some(lane) = lane {
                        preceding_lanes |= 1 << lane;
                    }
                    !earlier && !writer_lane_blocked(&self.reliable_blocked, *conn, *channel)
                }
                Action::SendProof { conn, .. } => {
                    !self.reliable_blocked.contains(&(*conn, CHANNEL_SIGNALING))
                }
                _ => true,
            }
        })?;
        self.actions.remove(index)
    }

    /// Exact write custody: encrypted lane counters stay pinned until the owning
    /// writer completes or its carrier retires. Datagram counters are independent.
    pub fn set_reliable_blocked(&mut self, now_ms: u64, conn: ConnId, channel: u8, blocked: bool) {
        if self.is_closed() {
            return;
        }
        let owned =
            self.lanes.as_ref().is_some_and(|lanes| {
                [lanes.signaling, lanes.interactive, lanes.bulk].contains(&conn)
            }) || self.direct.owns(conn)
                || self
                    .candidate
                    .as_ref()
                    .is_some_and(|candidate| candidate.conn == conn);
        if !owned {
            self.reliable_blocked.retain(|writer| writer.0 != conn);
            self.pong_owed.retain(|(owner, _)| *owner != conn);
            return;
        }
        if blocked {
            if !self.reliable_blocked.contains(&(conn, channel)) {
                self.reliable_blocked.push((conn, channel));
            }
        } else {
            self.reliable_blocked
                .retain(|writer| *writer != (conn, channel));
            self.flush_reliable_owed(now_ms, channel);
        }
    }

    fn flush_reliable_owed(&mut self, now_ms: u64, channel: u8) {
        if channel == CHANNEL_PTY && self.outbox.reliable_sent < self.outbox.len() {
            self.flush_input(now_ms);
        }
        if channel == CHANNEL_CTRL && self.has_reliable_capacity(CHANNEL_CTRL) {
            for (owner, pong) in std::mem::take(&mut self.pong_owed) {
                if let Phase::Established(established) = &mut self.phase {
                    seal_reliable(
                        established,
                        &mut self.buffers,
                        owner,
                        CHANNEL_CTRL,
                        &encode_proto_frame(MSG_TYPE_HEARTBEAT_PONG, &pong),
                        &mut self.actions,
                    );
                }
            }
        }

        if channel == CHANNEL_CTRL && self.has_reliable_capacity(CHANNEL_CTRL) {
            if let Some((generation, bitmap)) = self.resync_rows_owed.take() {
                let rows: Vec<u16> = bitmap
                    .iter()
                    .enumerate()
                    .flat_map(|(word, bits)| {
                        (0..64).filter_map(move |bit| {
                            (bits & (1u64 << bit) != 0).then_some((word * 64 + bit) as u16)
                        })
                    })
                    .collect();
                for rows in rows.chunks(u16::MAX as usize) {
                    self.send_display_resync_rows(generation, rows);
                }
            }
            for frame in std::mem::replace(
                &mut self.host_observation_owed,
                std::array::from_fn(|_| None),
            )
            .into_iter()
            .flatten()
            {
                self.send_sealed_reliable(CHANNEL_CTRL, &frame);
            }
            for frame in std::mem::take(&mut self.display_owed) {
                self.send_sealed_reliable(CHANNEL_CTRL, &frame);
            }
            if let Some((ack, durable)) = self.display_ack_owed.take() {
                self.send_display_ack(now_ms, &ack, durable);
            }
        }
    }

    pub fn has_reliable_capacity(&self, channel: u8) -> bool {
        self.reliable_conn(channel).is_some()
    }

    fn reliable_conn(&self, channel: u8) -> Option<ConnId> {
        self.primary_conn()
            .filter(|conn| !writer_lane_blocked(&self.reliable_blocked, *conn, channel))
    }

    /// Repeating a still-queued idempotent proof/signaling request cannot grow
    /// state while its writer is stalled. These records carry no Noise counter.
    fn coalesce_io_retries(&mut self) {
        let mut index = 0;
        while index < self.actions.len() {
            let retry = matches!(
                &self.actions[index],
                Action::SendProof { .. }
                    | Action::SendReliable {
                        channel: CHANNEL_SIGNALING,
                        ..
                    }
            );
            if retry
                && self
                    .actions
                    .iter()
                    .take(index)
                    .any(|action| action == &self.actions[index])
            {
                self.actions.remove(index);
            } else {
                index += 1;
            }
        }
    }

    /// Carrier retirement must not wait behind a backpressured writer.
    pub fn poll_close_action(&mut self, now_ms: u64) -> Option<Action> {
        let index = self
            .actions
            .iter()
            .position(|action| matches!(action, Action::Close { .. }))?;
        let action = self.actions.remove(index)?;
        if let Action::Close { conn } = &action {
            self.reliable_blocked.retain(|writer| writer.0 != *conn);
            self.pong_owed.retain(|(owner, _)| *owner != *conn);
            self.actions.retain(|action| {
                !matches!(action,
                Action::SendReliable { conn: owner, .. } | Action::SendProof { conn: owner, .. }
                if owner == conn)
            });
            self.flush_reliable_owed(now_ms, CHANNEL_CTRL);
            self.flush_reliable_owed(now_ms, CHANNEL_PTY);
        }
        Some(action)
    }

    /// How many ordered host actions still own session resident state.
    pub fn host_actions_len(&self) -> usize {
        self.actions
            .iter()
            .filter(|action| action.is_host_output())
            .count()
    }

    /// Bytes owned by queued host outputs, excluding independent I/O actions.
    pub fn host_actions_bytes(&self) -> usize {
        self.actions.iter().map(Action::host_resident_bytes).sum()
    }

    /// Producer credits exclude the one bounded, coalesced clock projection.
    pub fn host_bearing_actions_len(&self) -> usize {
        self.actions
            .iter()
            .filter(|action| {
                action.is_host_output() && !matches!(action, Action::GraphicsClock { .. })
            })
            .count()
    }
    pub fn host_bearing_actions_bytes(&self) -> usize {
        self.actions
            .iter()
            .filter(|action| !matches!(action, Action::GraphicsClock { .. }))
            .map(Action::host_resident_bytes)
            .sum()
    }

    pub fn is_closed(&self) -> bool {
        matches!(self.phase, Phase::Closed)
    }

    pub fn is_ready(&self) -> bool {
        matches!(self.phase, Phase::Established(_))
            && (self.direct.path().is_some()
                || self
                    .lanes
                    .as_ref()
                    .is_some_and(|lanes| lanes.data[0].counterpart.is_some()))
    }

    /// Current authentication boundary, including one not yet drained by its host.
    pub fn display_lineage(&self) -> u32 {
        self.display_lineage
    }

    /// Host telemetry reads the one authenticated heartbeat estimator.
    pub fn rtt_ms(&self) -> Option<f64> {
        self.primary_path.and_then(|path| self.paths.rtt_ms(path))
    }

    pub fn quality(&self, now_ms: u64) -> quality::Snapshot {
        let mut snapshot = self.quality.snapshot(now_ms, self.input_retry.srtt());
        snapshot.network_rtt_ms = self.network_rtt_ms();
        snapshot
    }
    pub fn network_rtt_ms(&self) -> Option<f64> {
        self.primary_path.and_then(|path| self.quality.floor(path))
    }
    /// The primary is ranked from authenticated per-provider datagram RTTs.
    pub fn primary_path(&self) -> Option<PathKind> {
        self.primary_path
    }

    fn primary_conn(&self) -> Option<ConnId> {
        match self.primary_path {
            Some(PathKind::Direct) => self.direct.path(),
            Some(PathKind::Relay) => self
                .lanes
                .as_ref()
                .filter(|lanes| lanes.data[0].counterpart.is_some())
                .map(|lanes| lanes.interactive),
            None => None,
        }
    }

    fn refresh_primary(&mut self) {
        let selected = self.paths.primary();
        if self.primary_path == selected {
            return;
        }
        self.primary_path = selected;
        self.primary_revision = self.primary_revision.wrapping_add(1);
        if let Some(path) = selected {
            self.quality.path(path);
            // Provider choice is latest state within this authentication fence.
            if let Some(action) = self
                .actions
                .iter_mut()
                .rev()
                .take_while(|action| !matches!(action, Action::DisplayFence(_)))
                .find(|action| matches!(action, Action::Path(_)))
            {
                *action = Action::Path(path);
            } else {
                self.actions.push_back(Action::Path(path));
            }
        }
    }

    pub fn quality_revision(&self) -> u32 {
        self.quality
            .rtt_revision()
            .wrapping_add(self.primary_revision)
    }
    pub fn input_ack_projection(&self) -> (u32, u64) {
        self.quality.ack_projection()
    }
    pub fn input_sent_projection(&self) -> (u32, u64) {
        self.quality.sent_projection()
    }

    /// The current server-issued routing identity, for host telemetry only.
    pub fn session_id(&self) -> Option<&str> {
        self.issued
            .as_ref()
            .map(|issued| issued.session_id.as_str())
    }

    /// The host stopped its driver. Unacknowledged input remains for a later
    /// connect, but no queued output, attempt, key or timer crosses the stop.
    pub fn suspend(&mut self) {
        self.input_retry.restart();
        self.close_lanes();
        self.cancel_candidate();
        self.reset_direct(false);
        self.heartbeat.stop();
        self.phase = Phase::Idle;
        self.issued = None;
        self.renewal = None;
        self.retry_at_ms = None;
        self.maintenance_ms = None;
        self.resume_watchdog_ms = None;
        self.display_acks.reset();
        self.display_owed.clear();
        self.display_ack_owed = None;
        self.resync_rows_owed = None;
        self.pong_owed.clear();
        self.host_observation_owed = std::array::from_fn(|_| None);
        self.outbox.revoke_provenance();
        self.graphics.restart();
        self.geometry.reset();
        self.actions.clear();
    }

    /// Start a fresh issuance for `daemon_id`.
    pub fn connect(&mut self, daemon_id: &str, entropy: &mut impl Entropy) {
        self.perf_epoch = None;
        self.input_retry.cancel();
        self.quality = quality::Quality::default();
        self.daemon_id = daemon_id.to_string();
        self.recovering = false;
        self.failures = 0;
        self.issue(entropy);
    }

    /// A fresh issuance for the current daemon. It supersedes the last one, and
    /// unacknowledged input carries over.
    fn issue(&mut self, entropy: &mut impl Entropy) {
        // A new session: its daemon may be another process, on another
        // network for all this one knows.
        self.reset_direct(false);
        self.close_lanes();
        self.cancel_candidate();
        self.heartbeat.stop();
        self.geometry.reset();
        // Every authentication rotates the viewer's model: what it painted
        // for a held record belongs to the lineage that is ending.
        self.input_retry.restart();
        self.outbox.revoke_provenance();
        self.retry_at_ms = None;
        self.incumbent_lost = false;
        self.rebind_refused = false;
        self.renewal = None;
        self.maintenance_ms = None;
        self.resume_watchdog_ms = None;
        self.generation_base = 0;
        let pending = PendingAuth::new(entropy);
        let (client_nonce, encapsulation_key) = pending.request_fields();
        let issuance_id = uuid_v4(entropy);
        let supersedes_issuance_id = self.issuance_id.replace(issuance_id.clone());
        self.actions.push_back(Action::Status(if self.recovering {
            Status::Reconnecting
        } else {
            Status::Connecting
        }));
        self.actions
            .push_back(Action::RequestIssuance(IssuanceRequest {
                delegation_id: self.delegation.certificate.delegation_id.clone(),
                daemon_id: self.daemon_id.clone(),
                browser_node_id: self.config.browser_node_id.clone(),
                issuance_id,
                supersedes_issuance_id,
                client_nonce,
                encapsulation_key,
            }));
        self.phase = Phase::Issuing {
            pending: Box::new(pending),
        };
    }

    pub fn handle(&mut self, now_ms: u64, event: Event<'_>, entropy: &mut impl Entropy) {
        if self.is_closed() {
            return;
        }
        let retiring = matches!(event, Event::Closed { .. } | Event::DialFailed(_));
        if let Event::Closed { conn, .. } | Event::DialFailed(conn) = &event {
            self.reliable_blocked.retain(|writer| writer.0 != *conn);
            self.pong_owed.retain(|(owner, _)| *owner != *conn);
            self.actions.retain(|action| {
                !matches!(action,
                Action::SendReliable { conn: owner, .. } | Action::SendProof { conn: owner, .. }
                if owner == conn)
            });
        }
        match event {
            Event::AuthorizationDenied => self.fail(CloseReason::AuthRejected),
            Event::DaemonUnlinked => self.fail(CloseReason::DaemonUnlinked),
            Event::IssuanceFailed => {
                if matches!(self.phase, Phase::Issuing { .. }) {
                    self.attempt_failed(now_ms, entropy);
                }
            }
            Event::Issued(issuance) => self.on_issued(now_ms, issuance, entropy),
            Event::Renewed(capability) => self.on_renewed(now_ms, capability, entropy),
            Event::Connected(conn) if self.direct.owns(conn) => {
                self.on_direct_connected(now_ms, conn)
            }
            Event::DialFailed(conn) | Event::Closed { conn, .. } if self.direct.owns(conn) => {
                self.on_direct_closed(now_ms, conn)
            }
            Event::Reliable {
                conn,
                channel: CHANNEL_CTRL,
                payload,
                ..
            } if self.direct.upgrading(conn) => self.on_direct_control(now_ms, conn, payload),
            Event::Connected(conn) => self.on_connected(now_ms, conn, entropy),
            Event::DialFailed(conn) => self.on_closed(now_ms, conn, false, false, entropy),
            Event::Closed {
                conn,
                egress_budget,
            } => self.on_closed(now_ms, conn, true, egress_budget, entropy),
            Event::Splice(conn, event) => self.on_splice(now_ms, conn, event, entropy),
            Event::Reliable {
                conn,
                source,
                channel,
                payload,
            } => self.on_reliable(now_ms, conn, source, channel, payload, entropy),
            Event::Datagram { conn, payload } => self.on_datagram(now_ms, conn, payload),
            Event::InputDatagramSent { conn, top_seq } => {
                let current = self.direct.path() == Some(conn)
                    || self
                        .lanes
                        .as_ref()
                        .is_some_and(|lanes| lanes.interactive == conn);
                if self.is_ready()
                    && current
                    && top_seq != 0
                    && self.outbox.mapping().local_for_wire(top_seq).is_some()
                {
                    self.input_retry
                        .emitted(now_ms, top_seq, !self.outbox.is_empty());
                    if let Some(local) = self.outbox.mapping().local_for_wire(top_seq) {
                        self.quality.sent(now_ms, local);
                    }
                }
            }
            Event::Proof { conn, payload } => self.on_proof(now_ms, conn, payload, entropy),
            Event::Finite { conn, stream, part } => {
                let ready = self.is_ready();
                if let Phase::Established(established) = &mut self.phase {
                    self.graphics.on_finite(
                        &mut established.transport,
                        conn.0,
                        stream,
                        part,
                        ready,
                    );
                }
                self.drain_graphics();
            }
        }
        if retiring {
            self.flush_reliable_owed(now_ms, CHANNEL_CTRL);
            self.flush_reliable_owed(now_ms, CHANNEL_PTY);
        }
        self.drain_verdicts(now_ms, entropy);
        self.coalesce_io_retries();
    }

    pub fn next_deadline(&self) -> Option<u64> {
        if self.is_closed() {
            return None;
        }
        let hello = self
            .lanes
            .iter()
            .flat_map(|lanes| lanes.data.iter())
            .flat_map(|lane| [lane.next_hello_ms, lane.redial_at_ms, lane.deadline_ms])
            .flatten();
        let candidate = self
            .candidate
            .iter()
            .flat_map(|candidate| [candidate.deadline_ms, candidate.retransmit_ms])
            .flatten();
        let renewal = self
            .renewal
            .as_ref()
            .and_then(|renewal| renewal.retransmit_ms);
        let signing = match &self.phase {
            Phase::Dialing {
                unsigned: Some(waiting),
                ..
            } => Some(waiting.deadline_ms),
            _ => None,
        };
        hello
            .chain(candidate)
            .chain(signing)
            .chain(self.heartbeat.next_deadline())
            .chain(self.input_retry.deadline())
            .chain(self.retry_at_ms)
            .chain(self.maintenance_ms)
            .chain(renewal)
            .chain(self.resume_watchdog_ms)
            .chain(self.direct.next_deadline())
            .min()
    }

    pub fn handle_timeout(&mut self, now_ms: u64, entropy: &mut impl Entropy) {
        if self.is_closed() {
            return;
        }
        if let Phase::Dialing {
            unsigned: Some(waiting),
            ..
        } = &self.phase
            && waiting.deadline_ms <= now_ms
        {
            // The host's signer never answered; its late answer is dropped.
            self.attempt_failed(now_ms, entropy);
        }
        if self.input_retry.fire(now_ms) {
            self.flush_input(now_ms);
        }
        if self.retry_at_ms.is_some_and(|at| at <= now_ms) {
            self.retry_at_ms = None;
            self.recover(now_ms, entropy);
        }
        if self.resume_watchdog_ms.is_some_and(|at| at <= now_ms) {
            self.resume_watchdog_ms = None;
            self.request_display_snapshot(now_ms);
        }
        self.handle_direct_timeout(now_ms);
        if self.maintenance_ms.is_some_and(|at| at <= now_ms) {
            self.maintenance_ms = None;
            self.start_renewal(now_ms, false, entropy);
        }
        if self
            .renewal
            .as_ref()
            .and_then(|renewal| renewal.retransmit_ms)
            .is_some_and(|at| at <= now_ms)
        {
            self.send_renewal(now_ms, entropy);
        }
        if let Some(candidate) = self.candidate.as_mut() {
            if candidate.deadline_ms.is_some_and(|at| at <= now_ms) {
                // Nothing decided the attempt in time: it ends, and a later one
                // reconciles whatever it left uncertain.
                self.candidate_ended(now_ms, entropy);
            } else if candidate.retransmit_ms.is_some_and(|at| at <= now_ms) {
                let flight = match &candidate.stage {
                    CandidateStage::Reconciling(reconcile)
                    | CandidateStage::Committing { reconcile, .. } => {
                        Some(reconcile.flight.to_json())
                    }
                    _ => None,
                };
                candidate.retransmit_ms = Some(now_ms + self.heartbeat.rto_ms().ceil() as u64);
                if let Some(flight) = flight {
                    self.actions.push_back(Action::SendProof {
                        conn: candidate.conn,
                        payload: flight.into_bytes(),
                    });
                }
            }
        }
        if let Some(lanes) = self.lanes.as_mut() {
            let conns = [lanes.interactive, lanes.bulk];
            for (index, lane) in lanes.data.iter_mut().enumerate() {
                if lane.next_hello_ms.is_some_and(|at| at <= now_ms) {
                    lane.next_hello_ms = None;
                    if lane.counterpart.is_none() && lane.attempts < HELLO_ATTEMPTS {
                        Self::push_hello(
                            &mut self.actions,
                            lanes.signaling,
                            conns[index],
                            index,
                            lane,
                            now_ms,
                        );
                    }
                }
            }
        }
        for index in 0..2 {
            let Some(lanes) = self.lanes.as_mut() else {
                break;
            };
            let conn = if index == 0 {
                lanes.interactive
            } else {
                lanes.bulk
            };
            let lane = &mut lanes.data[index];
            if lane.redial_at_ms.is_some_and(|at| at <= now_ms) {
                self.redial_data_attachment(index, entropy);
            } else if lane.deadline_ms.is_some_and(|at| at <= now_ms) {
                // Nothing acknowledged its HELLO: the attachment is dead.
                self.actions.push_back(Action::Close { conn });
                self.data_attachment_ended(now_ms, index, true, false, entropy);
            }
        }
        let (heartbeat, mut link) = self.liveness();
        heartbeat.handle_timeout(now_ms, &mut link);
        self.drain_verdicts(now_ms, entropy);
        self.coalesce_io_retries();
    }

    /// The operating system reports a network path change. It is a hint, not
    /// proof: on an established session it adds one probe without restarting
    /// the ladder and starts one candidate beside the incumbent, and during a
    /// backoff it wakes the wait without resetting its exponent. It never
    /// interrupts an attempt.
    pub fn connectivity_hint(&mut self, now_ms: u64, entropy: &mut impl Entropy) {
        if self.retry_at_ms.is_some() {
            self.retry_at_ms = Some(now_ms);
        } else if matches!(self.phase, Phase::Established(_)) {
            let (heartbeat, mut link) = self.liveness();
            heartbeat.probe_without_resetting(now_ms, &mut link);
            self.start_candidate(now_ms, entropy);
        }
        self.handle_timeout(now_ms, entropy);
    }

    /// Queue one input record and send the cumulative run. The host numbers
    /// records contiguously from its own counter, `local_seq`; `modelled`
    /// says the viewer's speculative model painted this record's effect.
    pub fn send_input(&mut self, now_ms: u64, local_seq: u32, mut record: Vec<u8>, modelled: bool) {
        if self.is_closed() {
            use zeroize::Zeroize;
            record.zeroize();
            return;
        }
        if self.outbox.admit(local_seq, record, modelled) {
            self.flush_input(now_ms);
        } else {
            self.fail(CloseReason::InputOverflow);
        }
    }

    pub fn input_released_local(&self) -> u32 {
        self.outbox.released_local()
    }

    /// One display ACK from the viewer, on the ACK datagram lane and, when it
    /// carries what a lost datagram would strand, on the reliable control
    /// lane too. Without a carrier it is dropped: the next ACK restates it.
    pub fn send_display_ack(&mut self, now_ms: u64, ack: &DisplayAckPayload, durable: bool) {
        if !self.is_ready() {
            return;
        }
        let body = ack.encode();
        self.send_sealed_datagram(CHANNEL_DISPLAY_ACK, &body);
        if !self.has_reliable_capacity(CHANNEL_CTRL) {
            self.display_ack_owed = Some((*ack, durable));
        } else if self.display_acks.admit(now_ms, ack, durable) {
            self.send_sealed_reliable(
                CHANNEL_CTRL,
                &encode_proto_frame(MSG_TYPE_DISPLAY_ACK, &body),
            );
        }
    }

    /// Name rows of `generation` the daemon's digest showed diverged; it
    /// disowns and re-sends them. Without a carrier the next digest asks again.
    pub fn send_display_resync_rows(&mut self, generation: u32, rows: &[u16]) {
        if !self.is_ready() || rows.is_empty() {
            return;
        }
        if !self.has_reliable_capacity(CHANNEL_CTRL) {
            if self
                .resync_rows_owed
                .as_ref()
                .is_none_or(|(owed_generation, _)| *owed_generation != generation)
            {
                self.resync_rows_owed = Some((generation, Box::new([0u64; 1024])));
            }
            if let Some((_, bitmap)) = &mut self.resync_rows_owed {
                for &row in rows {
                    bitmap[usize::from(row) / 64] |= 1u64 << (usize::from(row) % 64);
                }
            }
            return;
        }
        let Ok(count) = u16::try_from(rows.len()) else {
            return;
        };
        let mut body = Vec::with_capacity(6 + rows.len() * 2);
        body.extend_from_slice(&generation.to_be_bytes());
        body.extend_from_slice(&count.to_be_bytes());
        for row in rows {
            body.extend_from_slice(&row.to_be_bytes());
        }
        self.send_sealed_reliable(
            CHANNEL_CTRL,
            &encode_proto_frame(MSG_TYPE_DISPLAY_RESYNC_ROWS, &body),
        );
    }

    /// Ask the daemon for a complete snapshot.
    pub fn request_display_snapshot(&mut self, now_ms: u64) {
        self.quality.resync(now_ms);
        self.send_display_control(encode_proto_frame(MSG_TYPE_DISPLAY_SNAPSHOT_REQUEST, &[]));
    }

    /// Tell the daemon whether the grid takes compression dictionaries.
    pub fn send_display_dictionary_ready(&mut self, ready: bool) {
        self.send_display_control(encode_proto_frame(
            MSG_TYPE_DISPLAY_DICT_READY,
            &[u8::from(ready)],
        ));
    }

    /// The grid holds dictionary `id`. The daemon never re-sends an install,
    /// so this is owed until a carrier takes it.
    pub fn send_display_dictionary_ack(&mut self, id: u32) {
        self.send_display_control(encode_proto_frame(
            MSG_TYPE_DISPLAY_DICT_ACK,
            &id.to_be_bytes(),
        ));
    }

    /// Cold host measurement/policy controls. Authority-bearing viewer and
    /// input messages have typed methods and can never enter through this path.
    pub fn send_host_observation(&mut self, frame: &[u8]) -> bool {
        let Some((kind, _)) = decode_proto_frame(frame) else {
            return false;
        };
        let Some((_, body)) = decode_proto_frame(frame) else {
            return false;
        };
        let slot = match kind {
            merkur_wire::protocol::MSG_TYPE_TRANSPORT_HINT if body.len() == 11 => 0,
            merkur_wire::protocol::MSG_TYPE_DISPLAY_RECEIVER_PROFILE
                if body.len() >= 13
                    && body[12] <= 48
                    && body.len() == 13 + usize::from(body[12]) * 20
                    && u32::from_be_bytes(body[..4].try_into().expect("profile revision")) != 0
                    && u32::from_be_bytes(body[4..8].try_into().expect("profile age"))
                        <= 30 * 24 * 60 * 60 * 1_000 =>
            {
                1
            }
            merkur_wire::protocol::MSG_TYPE_PERF_ENABLE
                if merkur_wire::protocol::parse_perf_timing_config(body).is_some() =>
            {
                2
            }
            merkur_wire::protocol::MSG_TYPE_PERF_GRID_CONVERGENCE_REQUEST
                if merkur_wire::protocol::parse_perf_grid_convergence_request(body).is_some() =>
            {
                3
            }
            _ => return false,
        };
        if !self.is_ready() {
            return false;
        }
        if kind == merkur_wire::protocol::MSG_TYPE_PERF_ENABLE {
            let Some((_, body)) = decode_proto_frame(frame) else {
                return false;
            };
            let Some(config) = merkur_wire::protocol::parse_perf_timing_config(body) else {
                return false;
            };
            self.perf_epoch = config.enabled.then_some(config.observation_epoch);
            self.graphics.observe(config.enabled);
        }
        if self.has_reliable_capacity(CHANNEL_CTRL) {
            self.send_sealed_reliable(CHANNEL_CTRL, frame);
        } else {
            self.host_observation_owed[slot] = Some(frame.to_vec());
        }
        true
    }

    /// The host retained a program request. The daemon can stop re-offering it.
    pub fn acknowledge_open_url(&mut self, id: OpenUrlId) {
        self.send_display_control(encode_proto_frame(MSG_TYPE_OPEN_URL_ACK, &id.encode()));
    }

    /// The viewer's claim about its grid, for the lineage its fence opened.
    /// Unanswered once it has left, it falls back to a snapshot request.
    pub fn send_display_resume(&mut self, now_ms: u64, resume: &DisplayResume) {
        if self.is_ready() {
            self.resume_watchdog_ms = Some(now_ms + DISPLAY_RESUME_WATCHDOG_MS);
        }
        self.send_display_control(resume.encode());
    }

    /// The graphics assets the viewer's scene of display lineage `epoch`
    /// needs, largest first. A scene of another lineage is the viewer's last
    /// session's and is dropped.
    pub fn graphics_demand(&mut self, epoch: u32, demands: Vec<graphics::GraphicsDemand>) {
        if !matches!(self.phase, Phase::Established(_)) || epoch != self.display_lineage {
            return;
        }
        let ready = self.is_ready();
        self.graphics.replace(epoch, demands, ready);
        self.drain_graphics();
    }

    fn drain_graphics(&mut self) {
        for frame in self.geometry.take_out() {
            self.send_display_control(frame);
        }
        for out in self.graphics.take_out() {
            match out {
                graphics::Out::Control(frame) => self.send_display_control(frame),
                graphics::Out::Asset {
                    epoch,
                    key,
                    asset,
                    job,
                    bytes,
                } => self.actions.push_back(Action::GraphicsAsset {
                    epoch,
                    key,
                    asset,
                    job,
                    bytes,
                }),
                graphics::Out::Phase {
                    phase,
                    job,
                    bytes,
                    failed,
                } => self.actions.push_back(Action::GraphicsJob {
                    phase,
                    job,
                    bytes,
                    failed,
                }),
            }
        }
    }

    /// A carrier came: graphics refusals it may have caused are asked again,
    /// and the geometry's state is learned again.
    fn graphics_admit(&mut self) {
        let ready = self.is_ready();
        self.graphics.readmit(ready);
        self.geometry.refresh(ready);
        self.drain_graphics();
    }

    /// A carrier went: whatever graphics exchange it may have carried is
    /// asked again, and so is the geometry's state.
    fn graphics_interrupt(&mut self) {
        let ready = self.is_ready();
        self.graphics.interrupt(ready);
        self.geometry.refresh(ready);
        self.drain_graphics();
    }

    /// The host's viewport: cells, and one cell in logical pixels when the
    /// host knows them. Sent when this client owns the shared geometry, or
    /// claimed with while focused.
    pub fn set_viewport(&mut self, cols: u16, rows: u16, cell: Option<(f64, f64)>) {
        let fixed = |pixels: f64| (pixels * 65_536.0).round() as u32;
        let (cell_width, cell_height) =
            cell.map_or((0, 0), |(width, height)| (fixed(width), fixed(height)));
        let viewport = geometry::Viewport {
            cols,
            rows,
            cell_width,
            cell_height,
        };
        let ready = self.is_ready();
        self.geometry.set_viewport(viewport, ready);
        self.drain_graphics();
    }

    /// Whether the host's window is the focused one, which claims the shared
    /// geometry for its viewport.
    pub fn set_focused(&mut self, focused: bool) {
        let ready = self.is_ready();
        self.geometry.set_focused(focused, ready);
        self.drain_graphics();
    }

    /// The user asked for the shared geometry.
    pub fn take_geometry(&mut self) {
        let ready = self.is_ready();
        self.geometry.take_control(ready);
        self.drain_graphics();
    }

    /// One viewer control frame on the reliable control lane, held in order
    /// until the carrier can take it. A new session drops what the last one
    /// owed.
    fn send_display_control(&mut self, frame: Vec<u8>) {
        if self.is_ready() && self.has_reliable_capacity(CHANNEL_CTRL) {
            self.send_sealed_reliable(CHANNEL_CTRL, &frame);
        } else if !self.display_owed.contains(&frame) {
            self.display_owed.push(frame);
        }
    }

    /// The ladder and the incumbent it probes, borrowed apart.
    fn liveness(&mut self) -> (&mut Heartbeat, IncumbentLink<'_>) {
        (
            &mut self.heartbeat,
            IncumbentLink {
                phase: &mut self.phase,
                lanes: self.lanes.as_ref(),
                direct: self.direct.path(),
                outbox: &self.outbox,
                buffers: &mut self.buffers,
                actions: &mut self.actions,
                blocked: &self.reliable_blocked,
            },
        )
    }

    /// Incumbent progress cannot settle a final that may have committed remotely.
    fn final_unresolved(&self) -> bool {
        self.candidate.as_ref().is_some_and(|c| c.final_sent)
            || matches!(&self.phase, Phase::Established(e) if e.uncertain.is_some())
    }

    /// Recovery reads the ladder's conclusions after every event and timeout.
    fn drain_verdicts(&mut self, now_ms: u64, entropy: &mut impl Entropy) {
        while let Some(verdict) = self.heartbeat.poll_verdict() {
            match verdict {
                // Weak evidence: start paying for a candidate, evict nothing.
                Verdict::Escalated => self.start_candidate(now_ms, entropy),
                Verdict::Failed => {
                    if !self.incumbent_lost {
                        self.incumbent_lost = true;
                        self.actions.push_back(Action::Status(Status::Reconnecting));
                    }
                    self.recover(now_ms, entropy);
                }
                // A round trip ended the suspicion that bought the candidate.
                Verdict::Progress => {
                    // Data progress can settle a suspicion, but cannot restore
                    // a signaling attachment whose close was already observed.
                    let signaling_up = self.lanes.as_ref().is_some_and(|lanes| lanes.signaling_up);
                    if signaling_up
                        && self
                            .candidate
                            .as_ref()
                            .is_some_and(|candidate| !candidate.final_sent)
                    {
                        self.cancel_candidate();
                    }
                    if signaling_up
                        && !self.final_unresolved()
                        && self.incumbent_lost
                        && self.is_ready()
                    {
                        self.incumbent_lost = false;
                        self.actions.push_back(Action::Status(Status::Ready));
                        self.graphics_admit();
                    }
                }
            }
        }
    }

    fn next_conn_id(&mut self) -> ConnId {
        let conn = ConnId(self.next_conn);
        self.next_conn += 1;
        conn
    }

    /// One edge attachment for the current issuance.
    fn dial(&mut self, lane: EdgeLane, attachment: RoutingAttachment) -> ConnId {
        let conn = self.next_conn_id();
        let issuance = self.issued.as_ref().expect("an issuance names the edge");
        let candidate = matches!(attachment, RoutingAttachment::Candidate { .. });
        let preface = RoutingPreface {
            session_id: lane.routing_id(&issuance.session_id),
            role: Role::Browser,
            version: PREFACE_VERSION,
            attachment,
            daemon_id: issuance.daemon_id.clone(),
            ticket: issuance.edge_attach_ticket.clone(),
        };
        self.actions.push_back(Action::Dial {
            conn,
            lane,
            url: issuance.edge_wt_url.clone(),
            cert_hashes: issuance.cert_hashes(),
            preface: preface.encode(),
            candidate,
        });
        conn
    }

    fn on_issued(
        &mut self,
        now_ms: u64,
        issuance: Option<Box<Issuance>>,
        entropy: &mut impl Entropy,
    ) {
        let Phase::Issuing { .. } = self.phase else {
            return;
        };
        let Phase::Issuing { pending, .. } = std::mem::replace(&mut self.phase, Phase::Idle) else {
            unreachable!()
        };
        let Some(issuance) = issuance.filter(|issued| issued.daemon_id == self.daemon_id) else {
            return self.fail(CloseReason::IssuanceFailed);
        };
        let unsigned =
            match pending.bind(&issuance, &self.delegation, &self.config.browser_node_id) {
                Ok(unsigned) => unsigned,
                Err(error) => return self.fail(CloseReason::Auth(error)),
            };
        let signature = self.request_signature(unsigned.proof().to_vec());
        self.issued = Some(issuance);
        // All three dials start in the same turn as the signature request,
        // signaling first; authentication never waits for the data dials.
        let signaling = self.dial(EdgeLane::Signaling, RoutingAttachment::Primary);
        let interactive = self.dial(EdgeLane::Interactive, RoutingAttachment::Primary);
        let bulk = self.dial(EdgeLane::Bulk, RoutingAttachment::Primary);
        let mut data = [DataAttachment::default(), DataAttachment::default()];
        for lane in &mut data {
            lane.nonce = entropy.array();
            lane.dials = 1;
        }
        self.lanes = Some(Lanes {
            signaling,
            interactive,
            bulk,
            signaling_up: false,
            data,
            relay_paused: false,
        });
        self.phase = Phase::Dialing {
            unsigned: Some(Unsigned {
                id: signature,
                deadline_ms: now_ms + AUTH_PHASE_WATCHDOG_MS,
                auth: Box::new(unsigned),
            }),
            bound: None,
            flight: None,
        };
    }

    fn on_connected(&mut self, now_ms: u64, conn: ConnId, entropy: &mut impl Entropy) {
        if self
            .candidate
            .as_ref()
            .is_some_and(|candidate| candidate.conn == conn)
        {
            return self.on_candidate_connected(now_ms, entropy);
        }
        let Some(lanes) = self.lanes.as_mut() else {
            return;
        };
        if conn == lanes.signaling {
            lanes.signaling_up = true;
            if let Phase::Dialing {
                flight: Some(flight),
                ..
            } = &self.phase
            {
                self.actions.push_back(Action::SendReliable {
                    conn,
                    channel: CHANNEL_SIGNALING,
                    payload: flight.to_json().into_bytes(),
                });
                self.actions
                    .push_back(Action::Status(Status::Authenticating));
            }
            return;
        }
        let index = if conn == lanes.interactive {
            0
        } else if conn == lanes.bulk {
            1
        } else {
            return;
        };
        if matches!(self.phase, Phase::Established(_)) && !lanes.signaling_up {
            return;
        }
        lanes.data[index].up = true;
        if matches!(self.phase, Phase::Established(_)) {
            let data_conn = conn;
            Self::push_hello(
                &mut self.actions,
                lanes.signaling,
                data_conn,
                index,
                &mut lanes.data[index],
                now_ms,
            );
        }
    }

    fn on_reliable(
        &mut self,
        now_ms: u64,
        conn: ConnId,
        source: u64,
        channel: u8,
        payload: &[u8],
        entropy: &mut impl Entropy,
    ) {
        let Some(lanes) = self.lanes.as_ref() else {
            return;
        };
        if channel == CHANNEL_SIGNALING {
            if conn == lanes.signaling {
                self.on_signal(now_ms, payload, entropy);
            }
            return;
        }
        if channel == CHANNEL_DATA_HELLO {
            self.on_data_handshake(now_ms, conn, source, payload);
            return;
        }
        let Phase::Established(established) = &mut self.phase else {
            return;
        };
        let Some(lane) = merkur_e2e::lane_for_channel(channel) else {
            return;
        };
        let Some(plaintext) = open_pooled(established, &mut self.buffers, lane, false, payload)
        else {
            return;
        };
        self.on_terminal(now_ms, conn, channel, false, plaintext);
    }

    fn on_datagram(&mut self, now_ms: u64, conn: ConnId, payload: &[u8]) {
        let Some((&channel, sealed)) = payload.split_first() else {
            return;
        };
        let Phase::Established(established) = &mut self.phase else {
            return;
        };
        let Some(lane) = merkur_e2e::lane_for_channel(channel) else {
            return;
        };
        let Some(plaintext) = open_pooled(established, &mut self.buffers, lane, true, sealed)
        else {
            return;
        };
        self.on_terminal(now_ms, conn, channel, true, plaintext);
    }

    /// One opened frame: the viewer's, with its buffer, or the session's own,
    /// whose buffer then serves the next frame.
    fn on_terminal(
        &mut self,
        now_ms: u64,
        conn: ConnId,
        channel: u8,
        datagram: bool,
        mut plaintext: Vec<u8>,
    ) {
        if self.consume_terminal(now_ms, conn, channel, datagram, &mut plaintext) {
            return self.buffers.put(plaintext);
        }
        self.actions.push_back(Action::Terminal {
            channel,
            datagram,
            payload: plaintext,
            input: self.outbox.mapping(),
        });
    }

    /// Handle an opened frame that is the session's own, or that no lane may
    /// carry. False leaves it for the viewer.
    fn consume_terminal(
        &mut self,
        now_ms: u64,
        conn: ConnId,
        channel: u8,
        datagram: bool,
        plaintext: &mut Vec<u8>,
    ) -> bool {
        // The opcode owns sensitive clipboard bytes even when its frame is
        // malformed or arrives on a lane that cannot authorize UI effects.
        if plaintext.first() == Some(&MSG_TYPE_TERMINAL_UI) {
            if !datagram
                && channel == CHANNEL_CTRL
                && let Some((_, body)) = decode_proto_frame(plaintext)
                && let Some(effect) = TerminalUi::decode(body)
            {
                self.actions.push_back(Action::TerminalUi(effect));
            }
            plaintext.zeroize();
            return true;
        }
        if datagram && matches!(channel, CHANNEL_CTRL | CHANNEL_PTY) {
            // These lanes have only bounded liveness/input pulse datagrams.
            // Display and authority-bearing control use their own contracts.
            let Some((kind, body)) = decode_proto_frame(plaintext) else {
                return true;
            };
            let valid = match kind {
                MSG_TYPE_INPUT_ACK => body.len() == 4,
                MSG_TYPE_HEARTBEAT_PING => body.len() == 8,
                MSG_TYPE_HEARTBEAT_PONG => body.len() == 16,
                _ => false,
            };
            if !valid {
                return true;
            }
        }
        if plaintext.first().is_some_and(|kind| {
            matches!(
                *kind,
                merkur_wire::protocol::MSG_TYPE_PERF_TIMING
                    | merkur_wire::protocol::MSG_TYPE_PERF_EGRESS
                    | merkur_wire::protocol::MSG_TYPE_PERF_GRID_CONVERGENCE_RESPONSE
            )
        }) {
            if !datagram
                && channel == CHANNEL_CTRL
                && let Some(epoch) = self.perf_epoch
                && let Some((kind, body)) = decode_proto_frame(plaintext)
                && let Some(value) = observation::Observation::decode(kind, body, epoch)
            {
                self.actions.push_back(Action::Observation(Box::new(value)));
            }
            return true;
        }
        if (channel == CHANNEL_CTRL || channel == CHANNEL_PTY)
            && let Some((kind, body)) = decode_proto_frame(plaintext)
        {
            match kind {
                MSG_TYPE_DISPLAY_LINK_TABLE if datagram || channel != CHANNEL_CTRL => {
                    return true;
                }
                MSG_TYPE_OPEN_URL => {
                    if !datagram
                        && channel == CHANNEL_CTRL
                        && let Some((id, url)) = parse_open_url(body)
                    {
                        self.actions.push_back(Action::OpenUrl {
                            id,
                            url: url.to_owned(),
                        });
                    }
                    return true;
                }
                MSG_TYPE_INPUT_ACK => {
                    if let Ok(seq) = <[u8; 4]>::try_from(body) {
                        let seq = u32::from_be_bytes(seq);
                        // Proof first: the ladder compares against the
                        // watermark this ACK is about to advance.
                        self.heartbeat.record_input_ack_proof(seq);
                        self.acknowledge_input(now_ms, seq);
                    }
                    return true;
                }
                // Answered on the carrier it came by, so the daemon's liveness
                // for that exact path advances. It proves only our downlink.
                MSG_TYPE_HEARTBEAT_PING => {
                    if let Ok(token) = <[u8; 8]>::try_from(body) {
                        let mut pong = [0u8; 16];
                        pong[..8].copy_from_slice(&token);
                        pong[8..].copy_from_slice(&now_ms.saturating_mul(1_000).to_be_bytes());
                        if writer_lane_blocked(&self.reliable_blocked, conn, CHANNEL_CTRL) {
                            if let Some((_, owed)) =
                                self.pong_owed.iter_mut().find(|(owner, _)| *owner == conn)
                            {
                                *owed = pong;
                            } else {
                                self.pong_owed.push((conn, pong));
                            }
                        } else if let Phase::Established(established) = &mut self.phase {
                            seal_reliable(
                                established,
                                &mut self.buffers,
                                conn,
                                CHANNEL_CTRL,
                                &encode_proto_frame(MSG_TYPE_HEARTBEAT_PONG, &pong),
                                &mut self.actions,
                            );
                        }
                    }
                    return true;
                }
                MSG_TYPE_GEOMETRY_STATE => {
                    let ready = self.is_ready();
                    if let Some(status) = self.geometry.accept_state(body, ready) {
                        self.actions.push_back(Action::GeometryState(status));
                    }
                    self.drain_graphics();
                    return true;
                }
                MSG_TYPE_GRAPHICS_UNAVAILABLE => {
                    if let Ok(request) = <[u8; 8]>::try_from(body) {
                        let ready = self.is_ready();
                        self.graphics
                            .unavailable(u64::from_be_bytes(request), ready);
                        self.drain_graphics();
                    }
                    return true;
                }
                // Both copies are proof; only the datagram copy is a time
                // sample, since the stream twin carries queueing and
                // retransmission.
                MSG_TYPE_HEARTBEAT_PONG => {
                    if body.len() != 16 {
                        return true;
                    }
                    if datagram && let Some(token) = body.get(..8) {
                        let token = u64::from_be_bytes(token.try_into().expect("eight bytes"));
                        let path = if self.direct.path() == Some(conn) {
                            PathKind::Direct
                        } else {
                            PathKind::Relay
                        };
                        // The daemon read its animation clock while answering,
                        // within this round trip.
                        if let Some(rtt_ms) = self.heartbeat.resolve_pong_rtt(token, path, now_ms) {
                            self.paths.observe(path, rtt_ms);
                            self.refresh_primary();
                            if self.primary_path == Some(path) {
                                self.quality.rtt(now_ms, path, rtt_ms);
                            }
                            let clock = &body[8..16];
                            let clock = Action::GraphicsClock {
                                monotonic_us: u64::from_be_bytes(
                                    clock.try_into().expect("eight bytes"),
                                ),
                                rtt_ms: rtt_ms as u64,
                            };
                            // A pulse has exact latest-state semantics. A fence
                            // prevents a predecessor sample replacing its successor.
                            if let Some(pending) = self
                                .actions
                                .iter_mut()
                                .rev()
                                .take_while(|action| !matches!(action, Action::DisplayFence(_)))
                                .find(|action| matches!(action, Action::GraphicsClock { .. }))
                            {
                                *pending = clock;
                            } else {
                                self.actions.push_back(clock);
                            }
                        }
                    }
                    self.heartbeat.record_pong_proof();
                    return true;
                }
                _ => {}
            }
        }
        if !matches!(
            channel,
            CHANNEL_CTRL
                | CHANNEL_PTY
                | CHANNEL_DISPLAY_DATAGRAM
                | CHANNEL_DISPLAY_COMMIT
                | CHANNEL_DISPLAY_ACK
        ) {
            return true;
        }
        // Display, a digest or a repair's end answers a resume.
        if matches!(channel, CHANNEL_DISPLAY_DATAGRAM | CHANNEL_DISPLAY_COMMIT)
            || (channel == CHANNEL_CTRL
                && matches!(
                    plaintext.first(),
                    Some(&(MSG_TYPE_DISPLAY_HASH_DIGEST | MSG_TYPE_DISPLAY_REPAIR_END))
                ))
        {
            self.resume_watchdog_ms = None;
        }
        false
    }

    fn on_signal(&mut self, now_ms: u64, json: &[u8], entropy: &mut impl Entropy) {
        let Some(signal) = DaemonSignal::parse(json) else {
            return;
        };
        match signal {
            // The daemon's answer to flight 1, and unsigned: it ends an attempt
            // the daemon has not yet proved itself to, never a session it has.
            DaemonSignal::AuthFailed { .. } if matches!(self.phase, Phase::Dialing { .. }) => {
                return self.fail(CloseReason::AuthRejected);
            }
            DaemonSignal::SessionRenewed { .. } => {
                return self.on_renewal_answer(now_ms, &signal, entropy);
            }
            DaemonSignal::WebtransportManifest { .. } => {
                return self.on_direct_manifest(now_ms, signal);
            }
            DaemonSignal::WebtransportPunch {
                generation,
                outcome,
            } => return self.on_direct_punch(now_ms, generation, outcome),
            _ => {}
        }
        if let (Phase::Dialing { bound, .. }, DaemonSignal::SessionReady { .. }) =
            (&mut self.phase, &signal)
        {
            let Some(bound) = bound.take() else { return };
            match bound.complete(&signal) {
                Ok(done) => {
                    let lanes = self.lanes.as_mut().expect("dialing owns lanes");
                    self.actions.push_back(Action::SendReliable {
                        conn: lanes.signaling,
                        channel: CHANNEL_SIGNALING,
                        payload: done.noise_final.to_json().into_bytes(),
                    });
                    // Unacknowledged input is rebased onto the new
                    // session's wire sequence, never dropped.
                    self.input_retry.restart();
                    self.outbox.rebase(done.next_expected_input_seq);
                    self.outbox.reliable_sent = 0;
                    // New keys: nothing asked under the last can be answered.
                    self.graphics.restart();
                    // No carrier yet: its readiness acquires.
                    self.geometry.begin_epoch(false);
                    self.failures = 0;
                    // Renew at half the capability's stated lifetime.
                    self.maintenance_ms = self
                        .issued
                        .as_ref()
                        .map(|issued| now_ms + (issued.session_token_expires_in_ms / 2).max(1));
                    self.generation_base = 0;
                    self.phase = Phase::Established(Box::new(Established {
                        transport: done.transport,
                        rebind: done.rebind,
                        direct_upgrade_secret: done.direct_upgrade_secret,
                        uncertain: None,
                    }));
                    self.display_acks.reset();
                    self.display_owed.clear();
                    self.display_ack_owed = None;
                    self.resync_rows_owed = None;
                    self.pong_owed.clear();
                    self.host_observation_owed = std::array::from_fn(|_| None);
                    self.resume_watchdog_ms = None;
                    self.display_lineage = self.display_lineage.wrapping_add(1).max(1);
                    self.actions.push_back(Action::DisplayFence(DisplayFence {
                        lineage: self.display_lineage,
                    }));
                    let conns = [lanes.interactive, lanes.bulk];
                    for (index, lane) in lanes.data.iter_mut().enumerate() {
                        if lane.up {
                            Self::push_hello(
                                &mut self.actions,
                                lanes.signaling,
                                conns[index],
                                index,
                                lane,
                                now_ms,
                            );
                        }
                    }
                }
                Err(error) => self.fail(CloseReason::Auth(error)),
            }
        }
    }

    /// Recovery's one entry: rebind on a candidate while the lineage can,
    /// otherwise a fresh issuance.
    fn recover(&mut self, now_ms: u64, entropy: &mut impl Entropy) {
        match self.phase {
            Phase::Established(_) if !self.rebind_refused => self.start_candidate(now_ms, entropy),
            Phase::Established(_) => {
                self.recovering = true;
                self.issue(entropy);
            }
            Phase::Idle | Phase::Issuing { .. } | Phase::Dialing { .. } if self.recovering => {
                self.issue(entropy)
            }
            _ => {}
        }
    }

    /// Start one candidate signaling attachment beside the incumbent. It
    /// displaces nothing until the daemon acknowledges its commit.
    fn start_candidate(&mut self, now_ms: u64, entropy: &mut impl Entropy) {
        if self.candidate.is_some()
            || self.rebind_refused
            || !matches!(self.phase, Phase::Established(_))
        {
            return;
        }
        let nonce: [u8; 32] = entropy.array();
        let conn = self.dial(
            EdgeLane::Signaling,
            RoutingAttachment::Candidate {
                nonce: encode(&nonce),
            },
        );
        self.candidate = Some(Box::new(Candidate {
            conn,
            nonce,
            stage: CandidateStage::Dialing,
            final_sent: false,
            deadline_ms: Some(now_ms + AUTH_PHASE_WATCHDOG_MS),
            retransmit_ms: None,
            renewed: false,
            relay_paused: false,
            observed_address: None,
            direct: Vec::new(),
        }));
    }

    /// The candidate is attached: settle an earlier uncertain commit first,
    /// then rebind.
    fn on_candidate_connected(&mut self, now_ms: u64, entropy: &mut impl Entropy) {
        let rto_ms = self.heartbeat.rto_ms().ceil() as u64;
        let (Some(candidate), Phase::Established(established), Some(issued)) = (
            self.candidate.as_mut(),
            &mut self.phase,
            self.issued.as_ref(),
        ) else {
            return;
        };
        if !matches!(candidate.stage, CandidateStage::Dialing) {
            return;
        }
        let lineage = Lineage {
            session_id: &issued.session_id,
            browser_node_id: &self.config.browser_node_id,
            daemon_id: &self.daemon_id,
        };
        if let Some(reconcile) = Reconcile::new(&established.rebind, lineage, entropy) {
            self.actions.push_back(Action::SendProof {
                conn: candidate.conn,
                payload: reconcile.flight.to_json().into_bytes(),
            });
            candidate.deadline_ms = Some(now_ms + AUTH_PHASE_WATCHDOG_MS);
            candidate.retransmit_ms = Some(now_ms + rto_ms);
            candidate.stage = CandidateStage::Reconciling(reconcile);
            return;
        }
        self.send_rebind(now_ms, entropy);
    }

    fn send_rebind(&mut self, now_ms: u64, entropy: &mut impl Entropy) {
        let request = {
            let (Some(candidate), Phase::Established(established), Some(issued)) = (
                self.candidate.as_mut(),
                &mut self.phase,
                self.issued.as_ref(),
            ) else {
                return;
            };
            let lineage = Lineage {
                session_id: &issued.session_id,
                browser_node_id: &self.config.browser_node_id,
                daemon_id: &self.daemon_id,
            };
            RebindFlight::new(&established.rebind, lineage, &candidate.nonce, entropy).map(
                |(flight, request)| {
                    candidate.stage = CandidateStage::Rebinding(Box::new(flight));
                    candidate.deadline_ms = Some(now_ms + AUTH_PHASE_WATCHDOG_MS);
                    candidate.retransmit_ms = None;
                    (candidate.conn, request)
                },
            )
        };
        match request {
            Ok((conn, request)) => self.actions.push_back(Action::SendProof {
                conn,
                payload: request.to_json().into_bytes(),
            }),
            Err(_) => self.candidate_ended(now_ms, entropy),
        }
    }

    fn on_proof(&mut self, now_ms: u64, conn: ConnId, payload: &[u8], entropy: &mut impl Entropy) {
        if self
            .candidate
            .as_ref()
            .is_none_or(|candidate| candidate.conn != conn)
        {
            return;
        }
        // Anything else on the proof stream (a manifest, a punch outcome) is
        // for the direct path, which reads it once the candidate is published.
        let Some(signal) = DaemonSignal::parse(payload) else {
            return;
        };
        match signal {
            DaemonSignal::SessionRenewed { .. } => {
                return self.on_renewal_answer(now_ms, &signal, entropy);
            }
            DaemonSignal::WebtransportManifest { .. } | DaemonSignal::WebtransportPunch { .. } => {
                if let Some(candidate) = self.candidate.as_mut() {
                    candidate.direct.push(signal);
                }
                return;
            }
            _ => {}
        }
        let rto_ms = self.heartbeat.rto_ms().ceil() as u64;
        let (Some(candidate), Phase::Established(established), Some(issued)) = (
            self.candidate.as_mut(),
            &mut self.phase,
            self.issued.as_ref(),
        ) else {
            return;
        };
        let lineage = Lineage {
            session_id: &issued.session_id,
            browser_node_id: &self.config.browser_node_id,
            daemon_id: &self.daemon_id,
        };
        match std::mem::replace(&mut candidate.stage, CandidateStage::Dialing) {
            CandidateStage::Reconciling(reconcile) => {
                match reconcile.answer(&mut established.rebind, &signal) {
                    None => candidate.stage = CandidateStage::Reconciling(reconcile),
                    Some(promoted) => {
                        // The daemon holds exactly one of the two generations;
                        // the carrier keys follow it.
                        let uncertain = established.uncertain.take();
                        if promoted && let Some(successor) = uncertain {
                            established.transport = successor.transport;
                            established.direct_upgrade_secret = successor.direct_upgrade_secret;
                        }
                        self.send_rebind(now_ms, entropy);
                    }
                }
            }
            CandidateStage::Rebinding(mut flight) => {
                if let Some(reason) = flight.refusal(&established.rebind, &signal) {
                    if RENEWABLE_REFUSALS.contains(&reason) && !candidate.renewed {
                        // The epoch ran out, not the lineage: renew it on this
                        // candidate, then rebind with a fresh key and the same
                        // routing nonce.
                        candidate.renewed = true;
                        candidate.stage = CandidateStage::Renewing;
                        candidate.deadline_ms = Some(now_ms + AUTH_PHASE_WATCHDOG_MS);
                        return self.start_renewal(now_ms, true, entropy);
                    }
                    // Any other authenticated refusal ends this lineage; a
                    // fresh issuance restores the session.
                    self.rebind_refused = true;
                    self.cancel_candidate();
                    return self.recover(now_ms, entropy);
                }
                match flight.complete(&mut established.rebind, &signal) {
                    Ok(None) => candidate.stage = CandidateStage::Rebinding(flight),
                    Ok(Some(successor)) => {
                        self.actions.push_back(Action::SendProof {
                            conn,
                            payload: successor.final_flight.to_json().into_bytes(),
                        });
                        candidate.final_sent = true;
                        let reconcile = Reconcile::new(&established.rebind, lineage, entropy)
                            .expect("a completed rebind leaves its successor pending");
                        self.actions.push_back(Action::SendProof {
                            conn,
                            payload: reconcile.flight.to_json().into_bytes(),
                        });
                        candidate.deadline_ms = Some(now_ms + AUTH_PHASE_WATCHDOG_MS);
                        candidate.retransmit_ms = Some(now_ms + rto_ms);
                        candidate.stage = CandidateStage::Committing {
                            reconcile,
                            successor: Box::new(successor),
                        };
                    }
                    Err(_) => {
                        established.rebind.abandon();
                        self.candidate_ended(now_ms, entropy);
                    }
                }
            }
            CandidateStage::Committing {
                reconcile,
                successor,
            } => match reconcile.answer(&mut established.rebind, &signal) {
                None => {
                    candidate.stage = CandidateStage::Committing {
                        reconcile,
                        successor,
                    }
                }
                Some(true) => self.publish(now_ms, *successor, entropy),
                // The daemon kept the predecessor; the keeper dropped the
                // successor with it.
                Some(false) => self.candidate_ended(now_ms, entropy),
            },
            stage @ (CandidateStage::Dialing | CandidateStage::Renewing) => candidate.stage = stage,
        }
    }

    /// Retire the candidate. A successor whose final flight left stays as the
    /// uncertain one the next candidate reconciles.
    fn cancel_candidate(&mut self) {
        let Some(candidate) = self.candidate.take() else {
            return;
        };
        self.actions.push_back(Action::Close {
            conn: candidate.conn,
        });
        if let CandidateStage::Committing { successor, .. } = candidate.stage
            && let Phase::Established(established) = &mut self.phase
        {
            established.uncertain = Some(successor);
        }
    }

    /// The candidate closed, failed or ran out of time without a verdict.
    fn candidate_ended(&mut self, now_ms: u64, entropy: &mut impl Entropy) {
        self.cancel_candidate();
        // A final that left must be reconciled even when predecessor progress
        // settled the ladder. That progress cannot prove which keys the daemon
        // installed, and a failed reconciliation dial cannot abandon the owner.
        if self.incumbent_lost || self.final_unresolved() {
            self.schedule_retry(now_ms, entropy);
        }
    }

    /// The daemon acknowledged the commit and the edge selected the candidate:
    /// it becomes the signaling attachment, the incumbent's three close, and
    /// fresh data attachments replace them. Input keeps its sequence
    /// namespace and replays from the unacknowledged base.
    fn publish(&mut self, now_ms: u64, successor: Successor, entropy: &mut impl Entropy) {
        let Some(mut candidate) = self.candidate.take() else {
            return;
        };
        let Phase::Established(established) = &mut self.phase else {
            return;
        };
        established.transport = successor.transport;
        established.direct_upgrade_secret = successor.direct_upgrade_secret;
        established.uncertain = None;
        // The direct path was keyed to the lineage that just ended; the
        // network it was dialled from carries over.
        self.reset_direct(true);
        self.close_lanes();
        self.heartbeat.stop();
        // A paused relay takes no data attachment until it resumes.
        let paused = candidate.relay_paused;
        let (interactive, bulk) = if paused {
            (self.next_conn_id(), self.next_conn_id())
        } else {
            (
                self.dial(EdgeLane::Interactive, RoutingAttachment::Primary),
                self.dial(EdgeLane::Bulk, RoutingAttachment::Primary),
            )
        };
        let mut data = [DataAttachment::default(), DataAttachment::default()];
        for lane in &mut data {
            lane.nonce = entropy.array();
            lane.dials = u32::from(!paused);
        }
        self.lanes = Some(Lanes {
            signaling: candidate.conn,
            interactive,
            bulk,
            signaling_up: true,
            data,
            relay_paused: paused,
        });
        if paused {
            self.actions.push_back(Action::Status(Status::RelayPaused));
        }
        self.outbox.reliable_sent = 0;
        // The daemon's input numbering carries over a rebind; the viewer's
        // model does not, and nothing asked under the old keys is answered.
        self.input_retry.restart();
        self.outbox.revoke_provenance();
        self.graphics.restart();
        let ready = self.is_ready();
        self.geometry.begin_epoch(ready);
        self.drain_graphics();
        self.failures = 0;
        self.retry_at_ms = None;
        self.rebind_refused = false;
        self.display_acks.reset();
        // The successor is a new authenticated lineage to the same daemon,
        // which keeps its display for the viewer's resume claim and waits for
        // it before sending anything.
        self.resume_watchdog_ms = None;
        self.display_lineage = self.display_lineage.wrapping_add(1).max(1);
        self.actions.push_back(Action::DisplayFence(DisplayFence {
            lineage: self.display_lineage,
        }));
        // The address the edge saw the candidate at is the carrier's now, and
        // what the daemon offered it is the successor's direct path.
        if let Some(address) = candidate.observed_address {
            self.on_carrier_address(now_ms, address);
        }
        for signal in std::mem::take(&mut candidate.direct) {
            match signal {
                DaemonSignal::WebtransportManifest { .. } => {
                    self.on_direct_manifest(now_ms, signal);
                }
                DaemonSignal::WebtransportPunch {
                    generation,
                    outcome,
                } => self.on_direct_punch(now_ms, generation, outcome),
                _ => {}
            }
        }
        // A renewal in flight follows the key cut onto the new signaling
        // attachment; otherwise an epoch near its generation budget is
        // renewed now, ahead of the rebind that would be refused.
        if let Some(renewal) = self.renewal.as_mut() {
            renewal.via_candidate = false;
            self.send_renewal(now_ms, entropy);
        } else if let Phase::Established(established) = &self.phase
            && established.rebind.counter() - self.generation_base
                >= crate::renewal::MAX_REBIND_GENERATIONS - 1
        {
            self.start_renewal(now_ms, false, entropy);
        }
    }

    /// One renewal at a time. A candidate that needs the one already in
    /// flight takes its route.
    fn start_renewal(&mut self, now_ms: u64, via_candidate: bool, entropy: &mut impl Entropy) {
        if let Some(renewal) = self.renewal.as_mut() {
            if via_candidate && !renewal.via_candidate {
                renewal.via_candidate = true;
                self.send_renewal(now_ms, entropy);
            }
            return;
        }
        let started = {
            let (Phase::Established(established), Some(issued)) =
                (&self.phase, self.issued.as_ref())
            else {
                return;
            };
            let lineage = Lineage {
                session_id: &issued.session_id,
                browser_node_id: &self.config.browser_node_id,
                daemon_id: &self.daemon_id,
            };
            Renewal::new(
                &established.rebind,
                lineage,
                &self.delegation.certificate.delegation_id,
                &issued.edge_wt_url,
                entropy,
            )
        };
        let Some((renewal, request)) = started else {
            return self.settle_renewal(now_ms, None, entropy);
        };
        self.actions.push_back(Action::RequestRenewal(request));
        self.renewal = Some(Box::new(RenewalState {
            renewal,
            signature: None,
            via_candidate,
            started_ms: now_ms,
            // Checks the attempt's bound even before the capability arrives.
            retransmit_ms: Some(now_ms + AUTH_PHASE_WATCHDOG_MS),
        }));
    }

    fn on_renewed(
        &mut self,
        now_ms: u64,
        capability: Option<RenewalCapability>,
        entropy: &mut impl Entropy,
    ) {
        if self.renewal.is_none() {
            return;
        }
        // The server's newest statement of this session's edge certificates,
        // whatever the daemon says of the epoch: every later dial pins them.
        if let (Some(hashes), Some(issued)) = (
            capability
                .as_ref()
                .and_then(|capability| capability.edge_cert_hashes.clone()),
            self.issued.as_mut(),
        ) {
            issued.edge_cert_hashes = hashes;
        }
        let Some(state) = self.renewal.as_mut() else {
            return;
        };
        let proof = capability
            .and_then(|capability| state.renewal.prepare(capability, &self.delegation))
            .map(<[u8]>::to_vec);
        match proof {
            Some(proof) => {
                let id = self.request_signature(proof);
                if let Some(state) = self.renewal.as_mut() {
                    state.signature = Some(id);
                }
            }
            None => self.settle_renewal(now_ms, None, entropy),
        }
    }

    /// Sends the renewal for the current generation on its route, again at
    /// every RTO, within the authentication bound.
    fn send_renewal(&mut self, now_ms: u64, entropy: &mut impl Entropy) {
        let rto_ms = self.heartbeat.rto_ms().ceil() as u64;
        let Some(state) = self.renewal.as_mut() else {
            return;
        };
        if now_ms.saturating_sub(state.started_ms) >= AUTH_PHASE_WATCHDOG_MS {
            return self.settle_renewal(now_ms, None, entropy);
        }
        let (Phase::Established(established), Some(issued)) = (&self.phase, self.issued.as_ref())
        else {
            return;
        };
        let lineage = Lineage {
            session_id: &issued.session_id,
            browser_node_id: &self.config.browser_node_id,
            daemon_id: &self.daemon_id,
        };
        let Some(flight) = state.renewal.flight(&established.rebind, lineage) else {
            return;
        };
        state.retransmit_ms = Some(now_ms + rto_ms);
        let payload = flight.to_json().into_bytes();
        match (
            state.via_candidate,
            self.candidate.as_ref(),
            self.lanes.as_ref(),
        ) {
            (true, Some(candidate), _) => self.actions.push_back(Action::SendProof {
                conn: candidate.conn,
                payload,
            }),
            // Without a live signaling attachment the flight waits for the
            // retransmit, or for the candidate that publishes one.
            (false, _, Some(lanes)) if lanes.signaling_up => {
                self.actions.push_back(Action::SendReliable {
                    conn: lanes.signaling,
                    channel: CHANNEL_SIGNALING,
                    payload,
                })
            }
            _ => {}
        }
    }

    fn on_renewal_answer(
        &mut self,
        now_ms: u64,
        signal: &DaemonSignal,
        entropy: &mut impl Entropy,
    ) {
        let (Some(state), Phase::Established(established)) = (self.renewal.as_ref(), &self.phase)
        else {
            return;
        };
        if let Some(verdict) = state.renewal.answer(&established.rebind, signal) {
            self.settle_renewal(now_ms, Some(verdict), entropy);
        }
    }

    /// An accepted verdict opens the epoch and schedules the next renewal
    /// from the capability's remaining lifetime. A candidate refused for its
    /// epoch rebinds on the renewed one, or ends with the lineage.
    fn settle_renewal(
        &mut self,
        now_ms: u64,
        verdict: Option<crate::renewal::Verdict>,
        entropy: &mut impl Entropy,
    ) {
        let started_ms = self
            .renewal
            .take()
            .map_or(now_ms, |renewal| renewal.started_ms);
        let accepted = verdict.filter(|verdict| verdict.accepted);
        if let Some(verdict) = accepted {
            self.generation_base = verdict.generation_base;
            let remaining = verdict
                .lifetime_ms
                .saturating_sub(now_ms.saturating_sub(started_ms));
            self.maintenance_ms = Some(now_ms + (remaining / 2).max(1));
        }
        if self
            .candidate
            .as_ref()
            .is_some_and(|candidate| matches!(candidate.stage, CandidateStage::Renewing))
        {
            if accepted.is_some() {
                self.send_rebind(now_ms, entropy);
            } else {
                self.rebind_refused = true;
                self.cancel_candidate();
                self.recover(now_ms, entropy);
            }
        }
    }

    /// Exponential backoff with full jitter.
    fn schedule_retry(&mut self, now_ms: u64, entropy: &mut impl Entropy) {
        if self.retry_at_ms.is_some() {
            return;
        }
        let exponent = self.failures.min(4);
        self.failures = self.failures.saturating_add(1);
        let ceiling = (RECONNECT_BASE_MS << exponent).min(RECONNECT_CEIL_MS);
        let jitter = u64::from(u32::from_be_bytes(entropy.array())) % (ceiling + 1);
        self.retry_at_ms = Some(now_ms + jitter);
    }

    /// Initial and resumed connection attempts share one recovery owner.
    /// Validation and authority failures call `fail` directly.
    fn attempt_failed(&mut self, now_ms: u64, entropy: &mut impl Entropy) {
        if !self.recovering {
            self.recovering = true;
            self.actions.push_back(Action::Status(Status::Reconnecting));
        }
        self.close_lanes();
        self.phase = Phase::Idle;
        self.schedule_retry(now_ms, entropy);
    }

    /// An attachment ended: `connected` when it had been up, `egress_budget`
    /// when the edge closed it because the relay egress budget is spent.
    fn on_closed(
        &mut self,
        now_ms: u64,
        conn: ConnId,
        connected: bool,
        egress_budget: bool,
        entropy: &mut impl Entropy,
    ) {
        if self
            .candidate
            .as_ref()
            .is_some_and(|candidate| candidate.conn == conn)
        {
            self.candidate_ended(now_ms, entropy);
            if !connected {
                // The edge did not take the dial. A browser cannot tell a
                // certificate it no longer pins from an unreachable edge, so
                // the server, which holds the edge's registration, is asked:
                // the renewal's answer carries the hashes the edge serves now,
                // and the next candidate pins them.
                self.start_renewal(now_ms, false, entropy);
            }
            return;
        }
        let Some(lanes) = self.lanes.as_mut() else {
            return;
        };
        if conn == lanes.interactive || conn == lanes.bulk {
            let index = usize::from(conn == lanes.bulk);
            return self.data_attachment_ended(now_ms, index, connected, egress_budget, entropy);
        }
        if conn == lanes.signaling {
            let retire_unconfirmed =
                matches!(self.phase, Phase::Established(_)) && lanes.signaling_up;
            lanes.signaling_up = false;
            // A new data attachment needs its claim on signaling. Once that
            // carrier is gone, only recovery can provide one; spending dials
            // on the incumbent delays the candidate in browser admission.
            for (data_conn, lane) in [lanes.interactive, lanes.bulk]
                .into_iter()
                .zip(lanes.data.iter_mut())
            {
                lane.next_hello_ms = None;
                lane.redial_at_ms = None;
                lane.deadline_ms = None;
                if retire_unconfirmed && lane.counterpart.is_none() {
                    // An unpaired incumbent cannot finish its signaling claim.
                    // Remove unstarted dials before retirement is polled first.
                    self.actions.retain(|action| {
                        !matches!(action, Action::Dial { conn: owner, .. } if *owner == data_conn)
                    });
                    lane.end_attachment();
                    self.actions.push_back(Action::Close { conn: data_conn });
                }
            }
            self.incumbent_ended(now_ms, entropy);
        }
    }

    /// The attachment the session stands on is gone.
    fn incumbent_ended(&mut self, now_ms: u64, entropy: &mut impl Entropy) {
        if matches!(self.phase, Phase::Established(_)) {
            // The carrier is gone, which no probe needs to establish; its
            // ladder has nothing left to measure.
            self.heartbeat.stop();
            if !self.incumbent_lost {
                self.incumbent_lost = true;
                self.actions.push_back(Action::Status(Status::Reconnecting));
            }
            return self.recover(now_ms, entropy);
        }
        self.attempt_failed(now_ms, entropy);
    }

    /// A data attachment ended. The lane is redialed on its own, at once
    /// when the attachment had been up or was the lane's first, else after
    /// the delay; once its redials are spent, the session recovers.
    fn data_attachment_ended(
        &mut self,
        now_ms: u64,
        index: usize,
        connected: bool,
        egress_budget: bool,
        entropy: &mut impl Entropy,
    ) {
        if egress_budget {
            return self.set_relay_paused(true, entropy);
        }
        let Some(lanes) = self.lanes.as_mut() else {
            return;
        };
        let lane = &mut lanes.data[index];
        if lane
            .confirmed_ms
            .is_some_and(|at| now_ms.saturating_sub(at) >= DATA_CONFIRMED_STABLE_MS)
        {
            lane.redials = 0;
        }
        lane.end_attachment();
        let paused = lanes.relay_paused;
        let signaling_lost = !lanes.signaling_up && matches!(self.phase, Phase::Established(_));
        if index == 0 {
            self.paths.retire(PathKind::Relay);
            self.refresh_primary();
            // What the interactive stream carried is gone with it: unacknowledged
            // input goes out again on the next one.
            self.outbox.reliable_sent = 0;
        }
        // Whatever graphics exchange it carried is asked again.
        self.graphics_interrupt();
        if paused || signaling_lost {
            return;
        }
        let Some(lanes) = self.lanes.as_mut() else {
            return;
        };
        let lane = &mut lanes.data[index];
        if lane.redials >= DATA_REDIAL_ATTEMPTS {
            return self.incumbent_ended(now_ms, entropy);
        }
        if connected || lane.dials == 1 {
            self.redial_data_attachment(index, entropy);
        } else {
            lane.redial_at_ms = Some(now_ms + DATA_REDIAL_DELAY_MS);
        }
    }

    /// A fresh attachment for data lane `index`, with a fresh HELLO nonce.
    fn redial_data_attachment(&mut self, index: usize, entropy: &mut impl Entropy) {
        // Established data repair requires a live signaling claim owner.
        // Initial dials may precede signaling's connection/authentication.
        if matches!(self.phase, Phase::Established(_))
            && self.lanes.as_ref().is_none_or(|lanes| !lanes.signaling_up)
        {
            return;
        }
        let kind = if index == 0 {
            EdgeLane::Interactive
        } else {
            EdgeLane::Bulk
        };
        let conn = self.dial(kind, RoutingAttachment::Primary);
        let Some(lanes) = self.lanes.as_mut() else {
            return;
        };
        if index == 0 {
            lanes.interactive = conn;
        } else {
            lanes.bulk = conn;
        }
        let lane = &mut lanes.data[index];
        lane.end_attachment();
        lane.nonce = entropy.array();
        lane.dials += 1;
        lane.redials += 1;
        lane.redial_at_ms = None;
    }

    /// The edge paused relay data, or resumed it. A pause closes both data
    /// attachments and stops their redials; a resume redials both at once,
    /// their redials restored, and they pair again as at the start.
    fn set_relay_paused(&mut self, paused: bool, entropy: &mut impl Entropy) {
        let Some(lanes) = self.lanes.as_mut() else {
            return;
        };
        if lanes.relay_paused == paused {
            return;
        }
        lanes.relay_paused = paused;
        if !paused {
            for index in 0..2 {
                if let Some(lanes) = self.lanes.as_mut() {
                    lanes.data[index].redials = 0;
                }
                self.redial_data_attachment(index, entropy);
            }
            return;
        }
        for (conn, lane) in [lanes.interactive, lanes.bulk]
            .into_iter()
            .zip(lanes.data.iter_mut())
        {
            self.actions.push_back(Action::Close { conn });
            lane.end_attachment();
            lane.redial_at_ms = None;
        }
        self.outbox.reliable_sent = 0;
        self.graphics_interrupt();
        // Nothing answers a display resume through a paused relay.
        self.resume_watchdog_ms = None;
        self.actions.push_back(Action::Status(Status::RelayPaused));
    }

    fn on_splice(
        &mut self,
        now_ms: u64,
        conn: ConnId,
        event: SpliceControlEvent,
        entropy: &mut impl Entropy,
    ) {
        if let Some(candidate) = self
            .candidate
            .as_mut()
            .filter(|candidate| candidate.conn == conn)
        {
            match event {
                // A candidate's presence is final: no later daemon attachment
                // can reach it, so the daemon leg needs a new issuance.
                SpliceControlEvent::CounterpartPresent { present: false, .. } => {
                    self.cancel_candidate();
                    self.recovering = true;
                    self.issue(entropy);
                }
                SpliceControlEvent::RelayDataPaused { paused } => candidate.relay_paused = paused,
                SpliceControlEvent::ObservedPath { address } => {
                    candidate.observed_address = Some(address);
                }
                _ => {}
            }
            return;
        }
        if !self
            .lanes
            .as_ref()
            .is_some_and(|lanes| lanes.signaling == conn && lanes.signaling_up)
        {
            return;
        }
        match event {
            SpliceControlEvent::RelayDataPaused { paused } => {
                self.set_relay_paused(paused, entropy)
            }
            SpliceControlEvent::ObservedPath { address } => {
                self.on_carrier_address(now_ms, address);
            }
            _ => {}
        }
    }

    fn on_data_handshake(&mut self, now_ms: u64, conn: ConnId, source: u64, payload: &[u8]) {
        let final_unresolved = self.final_unresolved();
        let Some(lanes) = self.lanes.as_mut() else {
            return;
        };
        // A delayed incumbent ACK cannot complete its signaling claim after
        // that carrier closed, nor restart the stopped recovery heartbeat.
        if !lanes.signaling_up {
            return;
        }
        let index = if conn == lanes.interactive {
            0
        } else if conn == lanes.bulk {
            1
        } else {
            return;
        };
        let lane = &mut lanes.data[index];
        let Some((DataHandshakeKind::Ack, nonce)) = decode_data_handshake_frame(payload) else {
            return;
        };
        if nonce != lane.nonce || lane.attempts == 0 {
            return;
        }
        let genesis = lane.counterpart.is_none();
        lane.counterpart = Some(source);
        lane.next_hello_ms = None;
        lane.confirmed_ms.get_or_insert(now_ms);
        lane.deadline_ms = None;
        // A round trip of our fresh nonce proves this pairing delivers.
        self.actions.push_back(Action::SendReliable {
            conn: lanes.signaling,
            channel: CHANNEL_SIGNALING,
            payload: ClientSignal::DataReceived(DataClaim {
                lane: data_lane(index),
                nonce: hex(&lane.nonce),
            })
            .to_json()
            .into_bytes(),
        });
        if genesis && index == 0 {
            self.paths.register(PathKind::Relay);
            self.refresh_primary();
            if !final_unresolved {
                self.incumbent_lost = false;
                self.actions.push_back(Action::Status(Status::Ready));
            }
            self.graphics_admit();
            let (heartbeat, mut link) = self.liveness();
            heartbeat.start(now_ms, &mut link);
            self.flush_input(now_ms);
            for frame in std::mem::take(&mut self.display_owed) {
                if frame.first() == Some(&MSG_TYPE_DISPLAY_RESUME) {
                    self.resume_watchdog_ms = Some(now_ms + DISPLAY_RESUME_WATCHDOG_MS);
                }
                self.send_sealed_reliable(CHANNEL_CTRL, &frame);
            }
        }
    }

    fn push_hello(
        actions: &mut VecDeque<Action>,
        signaling: ConnId,
        data_conn: ConnId,
        index: usize,
        lane: &mut DataAttachment,
        now_ms: u64,
    ) {
        if lane.counterpart.is_some() || lane.attempts >= HELLO_ATTEMPTS {
            return;
        }
        lane.attempts += 1;
        // Same-flight rendezvous: the claim and the HELLO leave together.
        actions.push_back(Action::SendReliable {
            conn: signaling,
            channel: CHANNEL_SIGNALING,
            payload: ClientSignal::DataAttach(DataClaim {
                lane: data_lane(index),
                nonce: hex(&lane.nonce),
            })
            .to_json()
            .into_bytes(),
        });
        actions.push_back(Action::SendReliable {
            conn: data_conn,
            channel: CHANNEL_DATA_HELLO,
            payload: encode_data_handshake_frame(DataHandshakeKind::Hello, &lane.nonce),
        });
        if lane.attempts < HELLO_ATTEMPTS {
            lane.next_hello_ms = Some(now_ms + HELLO_RETRY_MS);
        }
        if lane.confirmed_ms.is_none() {
            lane.deadline_ms
                .get_or_insert(now_ms + DATA_ATTACHMENT_TIMEOUT_MS);
        }
    }

    fn acknowledge_input(&mut self, now_ms: u64, seq: u32) {
        if let Some(local) = self.outbox.mapping().local_for_wire(seq) {
            self.quality.acknowledged(now_ms, local);
        }
        self.outbox.ack(seq);
        if let Some(sample) = self.input_retry.ack(now_ms, seq, !self.outbox.is_empty()) {
            self.quality.input_ack(sample);
        }
    }

    fn flush_input(&mut self, now_ms: u64) {
        if !self.is_ready() || self.outbox.is_empty() {
            return;
        }
        // The cumulative datagram: everything unacknowledged that fits.
        let mut budget = INPUT_RUN_DATAGRAM_BUDGET_BYTES;
        let count = self
            .outbox
            .records()
            .take(INPUT_RUN_MAX_ENTRIES)
            .take_while(|record| {
                let cost = 2 + record.len();
                let fits = cost <= budget;
                budget = budget.saturating_sub(cost);
                fits
            })
            .count();
        if count > 0 {
            let top_seq = self.outbox.wire(count - 1);
            self.send_input_run(0, count, |session, frame| {
                session.send_sealed_datagram_inner(CHANNEL_PTY, frame, Some(top_seq));
            });
        }
        // The reliable backstop, from its own cursor.
        let from = self.outbox.reliable_sent;
        if from < self.outbox.len() && self.has_reliable_capacity(CHANNEL_PTY) {
            self.send_input_run(from, self.outbox.len() - from, |session, frame| {
                session.send_sealed_reliable(CHANNEL_PTY, frame);
            });
            self.outbox.reliable_sent = self.outbox.len();
        }
        // Detection is clocked by what we send, not by the next steady ping.
        let (heartbeat, mut link) = self.liveness();
        heartbeat.arm_on_emit(now_ms, &mut link);
    }

    /// Encode `count` held records from `from` into the reusable input frame,
    /// hand it to `send`, then wipe it, so no keystroke is left in plaintext.
    fn send_input_run(&mut self, from: usize, count: usize, send: impl FnOnce(&mut Self, &[u8])) {
        let mut frame = std::mem::take(&mut self.input_frame);
        encode_probed_input_run_into(
            &mut frame,
            self.outbox.wire(from),
            false,
            None,
            self.outbox.run(from, count),
        );
        send(self, &frame);
        frame.as_mut_slice().zeroize();
        frame.clear();
        self.input_frame = frame;
    }

    fn send_sealed_datagram(&mut self, channel: u8, plaintext: &[u8]) {
        self.send_sealed_datagram_inner(channel, plaintext, None);
    }

    fn send_sealed_datagram_inner(&mut self, channel: u8, plaintext: &[u8], top_seq: Option<u32>) {
        let primary = self.primary_conn();
        let (Phase::Established(established), Some(lanes)) = (&mut self.phase, self.lanes.as_ref())
        else {
            return;
        };
        let Some(lane) = merkur_e2e::lane_for_channel(channel) else {
            return;
        };
        // Seal straight behind the channel byte, into a buffer an earlier
        // frame left: the ciphertext is never copied.
        let mut payload = self
            .buffers
            .take(1 + plaintext.len() + merkur_e2e::FRAME_OVERHEAD);
        payload[0] = channel;
        let Ok(sealed) = established
            .transport
            .seal_into(lane, true, plaintext, &mut payload[1..])
        else {
            return self.buffers.put(payload);
        };
        payload.truncate(1 + sealed);
        let conn = primary.unwrap_or(lanes.interactive);
        self.actions.push_back(match top_seq {
            Some(top_seq) => Action::SendInputDatagram {
                conn,
                payload,
                top_seq,
            },
            None => Action::SendDatagram { conn, payload },
        });
    }

    fn send_sealed_reliable(&mut self, channel: u8, plaintext: &[u8]) {
        let Some(primary) = self.reliable_conn(channel) else {
            return;
        };
        let Phase::Established(established) = &mut self.phase else {
            return;
        };
        seal_reliable(
            established,
            &mut self.buffers,
            primary,
            channel,
            plaintext,
            &mut self.actions,
        );
    }

    fn fail(&mut self, reason: CloseReason) {
        if self.is_closed() {
            return;
        }
        self.reset_direct(false);
        self.cancel_candidate();
        self.close_lanes();
        self.phase = Phase::Closed;
        // Retirement is the only remaining I/O obligation. In particular, a
        // queued issuance must not mint authority after a terminal refusal.
        self.actions
            .retain(|action| action.is_host_output() || matches!(action, Action::Close { .. }));
        self.heartbeat.stop();
        self.input_retry.cancel();
        self.outbox.discard();
        self.actions
            .push_back(Action::Status(Status::Closed(reason)));
    }

    fn close_lanes(&mut self) {
        self.paths.retire(PathKind::Relay);
        self.refresh_primary();
        if let Some(lanes) = self.lanes.take() {
            for conn in [lanes.signaling, lanes.interactive, lanes.bulk] {
                self.actions.push_back(Action::Close { conn });
            }
        }
    }
}

/// A reliable Noise lane has one in-flight owner across all providers. Channel
/// aliases sharing the same cipher must share this custody; proof has no cipher.
fn writer_lane_blocked(blocked: &[(ConnId, u8)], conn: ConnId, channel: u8) -> bool {
    match merkur_e2e::lane_for_channel(channel) {
        Some(lane) => blocked
            .iter()
            .any(|(_, other)| merkur_e2e::lane_for_channel(*other) == Some(lane)),
        None => blocked.contains(&(conn, channel)),
    }
}

/// Seal `plaintext` on `channel`'s stream lane and queue it on `conn`; false
/// when the channel has no lane or the seal fails.
fn seal_reliable(
    established: &mut Established,
    buffers: &mut Buffers,
    conn: ConnId,
    channel: u8,
    plaintext: &[u8],
    actions: &mut VecDeque<Action>,
) -> bool {
    let Some(lane) = merkur_e2e::lane_for_channel(channel) else {
        return false;
    };
    let mut payload = buffers.take(plaintext.len() + merkur_e2e::FRAME_OVERHEAD);
    let Ok(sealed) = established
        .transport
        .seal_into(lane, false, plaintext, &mut payload)
    else {
        buffers.put(payload);
        return false;
    };
    payload.truncate(sealed);
    actions.push_back(Action::SendReliable {
        conn,
        channel,
        payload,
    });
    true
}

/// Open one sealed frame into a buffer an earlier frame left. A frame no
/// transport frame can be takes no buffer, and a refused one returns its own.
fn open_pooled(
    established: &mut Established,
    buffers: &mut Buffers,
    lane: usize,
    datagram: bool,
    sealed: &[u8],
) -> Option<Vec<u8>> {
    if !(merkur_e2e::FRAME_OVERHEAD..=merkur_e2e::MAX_TRANSPORT_FRAME_BYTES).contains(&sealed.len())
    {
        return None;
    }
    // The opener writes the plaintext and its tag behind the 8-byte counter.
    let mut plaintext = buffers.take(sealed.len() - 8);
    match established
        .transport
        .open_into(lane, datagram, sealed, &mut plaintext)
    {
        Ok(len) => {
            plaintext.truncate(len);
            Some(plaintext)
        }
        Err(_) => {
            buffers.put(plaintext);
            None
        }
    }
}

fn data_lane(index: usize) -> DataLane {
    if index == 0 {
        DataLane::Interactive
    } else {
        DataLane::Bulk
    }
}

mod direct;
mod display_ack;
pub mod geometry;
pub mod graphics;
mod input_retry;
pub mod observation;
mod outbox;
mod path_selection;
pub mod quality;
#[cfg(test)]
mod tests;
