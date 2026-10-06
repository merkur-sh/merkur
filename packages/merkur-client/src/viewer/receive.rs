//! The viewer's receive path: opened display frames in, grid applications and
//! display ACKs out. Native and browser adapters share this exclusive owner.
//!
//! - Every generation begins with a reliable snapshot. A delta of an older
//!   generation is stale. One of a newer generation overtook its own snapshot
//!   (datagrams have no order against the reliable lane) and waits for it
//!   without asking for another: a request would roll the daemon's generation
//!   again, and its deltas would overtake that snapshot too.
//! - A datagram is one complete, order-independent frame and applies on
//!   arrival. Only the reliable lane carries multi-chunk frames, and those
//!   validate whole before the first chunk mutates the grid.
//! - Any refusal abandons the lineage for a snapshot, except a delta for other
//!   dimensions: it was in flight across a resize, is never acknowledged, and
//!   the daemon re-sends its rows.
//! - After a session begins, the first snapshot roots the generation space
//!   whatever its number: a restarted daemon counts from 1 again.
//! - FEC rebuilds lost datagrams from their batch's repair, and the daemon's
//!   row-hash digest names the rows that diverged anyway, which it re-sends.

use std::collections::{HashSet, VecDeque};

use merkur_codec::{
    FrameKind, MAX_DISPLAY_FRAME_BYTES, MAX_DISPLAY_SNAPSHOT_BYTES, MAX_TERMINAL_CELLS,
    MAX_TERMINAL_COLUMNS, MAX_TERMINAL_ROWS, MSG_TYPE_DISPLAY_FEC_REPAIR, MSG_TYPE_DISPLAY_PATCH,
    STREAM_HEADER_BYTES, parse_frame_header, parse_stream_header,
};
use merkur_wire::protocol::{
    CHANNEL_CTRL, CHANNEL_DISPLAY_COMMIT, CHANNEL_DISPLAY_DATAGRAM, DISPLAY_ACK_MASK_WORDS,
    DisplayAckPayload, MSG_TYPE_DISPLAY_DICT_INSTALL, MSG_TYPE_DISPLAY_HASH_DIGEST,
    MSG_TYPE_DISPLAY_LINK_TABLE, MSG_TYPE_DISPLAY_REPAIR_END, MSG_TYPE_EDITOR_ANCHOR,
    MSG_TYPE_INPUT_ROUTING, decode_proto_frame,
};

use super::ack_window::AckWindow;
use super::demand::{Demand, FrameGrant};
use super::fec::{FecDecoder, Rebuilt};
use super::graphics::Scene;
use super::input_routing::InputRoutingHold;
use super::playback::Playback;
use super::prediction::{Prediction, PredictionStats};
use super::presentation::{
    Application, ApplyAction, Closure, Member, PresentationCoordinator, Release,
};
use super::repaint_hold::{RepaintHold, RepairEnd, snapshot_deadline_ms};
use super::{display_serial_is_newer, display_serial_reached};
use crate::input_sequence::{EpochDecision, InputMapping, classify_epoch};
use crate::session::graphics::GraphicsDemand;
use crate::session::{DisplayFence, DisplayResume};

/// The terminal grid frames apply to: term-wasm's `Terminal`, on every client.
/// A trait so that term-wasm can carry the viewer itself.
pub trait DisplayGrid {
    /// Host-clock observation at decode, queue, apply, resize-authority or
    /// transaction-discard boundaries.
    /// Called only while tracing. Returns the observation's timestamp so a
    /// buffered frame retains its measured decode-to-apply interval.
    fn trace_display(&mut self, _words: &[u32; 14], _since_ms: f64) -> f64 {
        f64::NAN
    }
    /// Reflow a locally owned viewport. Hosts call `Viewer::resize` so that
    /// input modelled against the old geometry is fenced first.
    fn resize(&mut self, cols: u16, rows: u16);
    /// Stage one display frame, decompressing it; 0 refuses it.
    fn stage(&mut self, frame: &[u8]) -> u32;
    /// Validate a staged frame without touching the grid.
    fn validate(&mut self, handle: u32) -> bool;
    /// Apply a staged snapshot chunk.
    fn apply_state(&mut self, handle: u32, seq: u32) -> bool;
    /// Apply a staged delta.
    fn apply_delta(&mut self, handle: u32, seq: u32) -> bool;
    fn release(&mut self, handle: u32);
    /// A snapshot replaces what a delta of any older sequence wrote.
    fn reset_ordering(&mut self);
    /// Why the last refused call refused.
    fn take_error(&mut self) -> Option<String>;
    fn rows(&self) -> u16;
    /// `merkur_codec::row_hash` of every row, as the daemon hashes its own,
    /// one per row. Kept up to date incrementally: only rows changed since the
    /// last call are hashed again.
    fn row_hashes(&mut self) -> &[u64];
    /// The sequence of the newest frame that wrote this row; 0 for none.
    fn row_version(&self, row: u16) -> u32;
    /// Install a finalized zstd dictionary whose bytes hash to `hash`; false
    /// refuses it, and the daemon then never compresses against it.
    fn install_dictionary(&mut self, generation: u32, id: u32, hash: u32, bytes: &[u8]) -> bool;
    /// An authenticated session boundary: codec state never follows the grid.
    fn clear_dictionaries(&mut self);
    fn cols(&self) -> u16;
    /// Whether the last apply changed what the grid would show.
    fn last_apply_visually_changed(&self) -> bool;
    /// Whether the grid and its applied header are exactly the complete
    /// application frame `digest` names; zero names nothing.
    fn closure_digest_matches(&mut self, digest: u64) -> bool;
    /// Advances at every local change to the canonical grid (a reset of
    /// ordering, a resize, a theme): a claim noted before one no longer
    /// describes the grid.
    fn completion_mutation_epoch(&self) -> u64;
    /// Take the applied grid as the one shown.
    fn commit_presentation(&mut self);
    /// Adopt the routing and input-report bits of the daemon's input-routing
    /// word, and keep them across every header applied until released.
    fn set_input_routing(&mut self, word: u16);
    /// The routing bits are the last applied header's, and every later one's.
    fn release_input_routing(&mut self);
    /// Whether the mode word carries the daemon's authenticated prompt grant
    /// (`terminalModeAllowsPrediction`).
    fn prediction_granted(&self) -> bool;
    fn alt_screen_active(&self) -> bool;
    /// The daemon's prompt anchor; closed voids it.
    fn set_editor_anchor(&mut self, generation: u32, row: u16, col: u16, open: bool);
    /// Model one input on the speculative line; false refuses it. A
    /// printable latches whether it may show.
    fn predict_printable(
        &mut self,
        codepoint: u32,
        sent_at_ms: f64,
        input_seq: u32,
        visible: bool,
    ) -> bool;
    fn predict_backspace(&mut self, sent_at_ms: f64, input_seq: u32) -> bool;
    fn predict_delete(&mut self, sent_at_ms: f64, input_seq: u32) -> bool;
    fn predict_cursor_shift(&mut self, delta: i32, sent_at_ms: f64, input_seq: u32) -> bool;
    /// An input the model does not project ended the line.
    fn predict_seal(&mut self, input_seq: u32);
    /// Drop the model: the grid it was drawn over is gone.
    fn predict_discard(&mut self);
    fn has_predictions(&self) -> bool;
    /// Compare the model against applied authority: `[confirmed,
    /// mismatched, expired_covered, _, discarded, deferred_mismatch,
    /// expired_stalled]`.
    fn predict_reconcile(
        &mut self,
        now_ms: f64,
        ttl_ms: f64,
        input_high_water: u32,
        echo_horizon: u32,
    ) -> [u32; 7];
    /// Advances whenever a presentation commit changes a placement.
    fn graphics_revision(&self) -> u32;
    /// The presented scene's placement fragments, 124 bytes each.
    fn graphics_fragments(&mut self) -> &[u8];
    /// Reserve the real host renderer's working set before any assets are requested.
    fn admit_graphics_scene(&mut self, _scene: &Scene) -> bool {
        true
    }
}

/// The one refusal that is not a lineage fault.
const DIMENSIONS_MISMATCH: &str = "display_dimensions_mismatch";

/// Resource bounds on retained frames: at
/// most one reliable snapshot is incomplete at a time, so four assemblies is
/// headroom. One assembly holds a whole snapshot, and the bound on a snapshot
/// is the codec's: the daemon budgets a snapshot's graphics against it after
/// worst-case text and one envelope per row, so its chunks sum to at most that.
const MAX_PENDING_ASSEMBLIES: usize = 4;
const MAX_ASSEMBLY_BYTES: usize = MAX_DISPLAY_SNAPSHOT_BYTES;
const MAX_PENDING_ASSEMBLY_BYTES: usize = 4 * 1024 * 1024;
/// Resource bounds on deltas waiting for their snapshot. One dropped here
/// was never acknowledged, so the
/// daemon still owes its rows.
const MAX_AHEAD_FRAMES: usize = 64;
const MAX_AHEAD_BYTES: usize = 2 * 1024 * 1024;
/// How often a pending resync asks again, mirrored from
/// `DISPLAY_RESYNC_TIMEOUT_MS`: the backstop for a snapshot that never lands.
const RESYNC_TIMEOUT_MS: f64 = 5_000.0;
/// Mirrored from `STALE_GENERATION_DESYNC_MS`: the paced burst plus
/// cross-lane reordering in which an old generation's datagrams still
/// legitimately arrive. Stale traffic past it, with nothing applying, means
/// this lineage sits above the daemon's.
const STALE_GENERATION_DESYNC_MS: f64 = 1_000.0;
/// How long a digest ahead of the applied sequences waits for them, mirrored
/// from `DEFERRED_HEARTBEAT_DEADLINE_MS`: frames lost for good (their repair
/// failed too) would otherwise wedge it.
const DEFERRED_DIGEST_DEADLINE_MS: f64 = 400.0;
/// Mirrored from `DEFERRED_HEARTBEAT_QUIESCENT_MS`: while frames still apply,
/// catching up exactly (or the next digest) settles it.
const DEFERRED_DIGEST_QUIESCENT_MS: f64 = 150.0;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Output {
    /// A display ACK for the session to seal: on the ACK datagram lane, and
    /// on the reliable control lane as well when `durable`.
    Ack {
        payload: DisplayAckPayload,
        durable: bool,
    },
    /// Ask the daemon for a complete snapshot.
    SnapshotRequest,
    /// Rows of `generation` whose hashes disagree with the daemon's digest:
    /// it disowns them and re-sends them complete.
    ResyncRows { generation: u32, rows: Vec<u16> },
    /// Whether the grid takes compression dictionaries, once per session.
    DictionaryReady(bool),
    /// The grid holds dictionary `id`: the daemon may compress against it.
    /// The daemon never re-sends an install, so this must reach it.
    DictionaryAck(u32),
    /// What the grid can tell a new session's daemon about itself.
    Resume(DisplayResume),
    /// The assets the presented scene of display lineage `epoch` needs.
    GraphicsDemand {
        epoch: u32,
        demands: Vec<GraphicsDemand>,
    },
}

/// Why the viewer abandoned its lineage for a snapshot: the terminal worker's
/// resync reasons.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Resync {
    HostRequest,
    FrameParseFailed,
    FrameStageFailed,
    PendingFrameMetadata,
    PendingFrameBytes,
    PendingAssembliesOverflow,
    PendingFrameMismatch,
    PendingFrameRows,
    FrameValidationRejected,
    ApplyRejected,
    StaleGenerationRecovery,
    HashDigestGenerationAhead,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Stats {
    /// Frames applied; a multi-chunk snapshot counts once.
    pub frames: u64,
    pub snapshots: u64,
    pub rows: u64,
    pub resyncs: u64,
    pub last_resync: Option<Resync>,
    /// Deltas refused for other dimensions.
    pub dimension_mismatches: u64,
    /// Frames FEC rebuilt that then applied.
    pub recovered: u64,
    /// Rows a digest showed diverged, asked for again.
    pub resync_rows: u64,
    /// Compression dictionaries the grid accepted.
    pub dictionaries: u64,
    /// Applied states the grid committed for the host to show.
    pub presentations: u64,
    /// Sessions that kept the grid and claimed it to their daemon.
    pub resumes: u64,
    /// Repair markers of the held repair that the grid took.
    pub repairs: u64,
}

/// An immutable transaction record captured before the owner consumes its ledger.
#[derive(Clone, Copy, Debug)]
pub struct PresentationTrace {
    pub words: [u32; 18],
    pub times: [f64; 5],
}

/// Why an offscreen transaction went uncommitted, as the display trace's
/// discard record (stage 5) numbers it: the browser's
/// `PRESENTATION_DISCARD_REASONS`.
#[derive(Clone, Copy)]
enum Discard {
    /// A snapshot of the same lineage replaced the rows it held.
    Resync = 0,
    /// A lineage boundary, or the snapshot that roots the new lineage.
    EpochReset = 1,
    /// The host is done with the viewer.
    Teardown = 2,
}

/// The daemon's row hashes at one applied position of one generation.
#[derive(Clone, Debug)]
struct Digest {
    generation: u32,
    up_to_seq: u32,
    rows: Vec<(u16, u64)>,
}

impl Digest {
    /// `[generation:4][up_to_seq:4][count:2]([row:2][hash:8])*`, canonical
    /// only: exact length, and each row once and inside the protocol's grid,
    /// so a malformed digest cannot amplify hashing. A digest ahead of the
    /// grid may describe other dimensions, so the live grid is checked only
    /// when it is compared.
    fn parse(body: &[u8]) -> Option<Self> {
        let u32_at = |at: usize| u32::from_be_bytes(body[at..at + 4].try_into().expect("u32"));
        if body.len() < 10 {
            return None;
        }
        let generation = u32_at(0);
        let count = usize::from(u16::from_be_bytes([body[8], body[9]]));
        if generation == 0 || count > MAX_TERMINAL_ROWS || body.len() != 10 + count * 10 {
            return None;
        }
        let mut seen = [false; MAX_TERMINAL_ROWS];
        let mut rows = Vec::with_capacity(count);
        for entry in body[10..].chunks_exact(10) {
            let row = u16::from_be_bytes([entry[0], entry[1]]);
            if usize::from(row) >= MAX_TERMINAL_ROWS
                || std::mem::replace(&mut seen[usize::from(row)], true)
            {
                return None;
            }
            rows.push((
                row,
                u64::from_be_bytes(entry[2..10].try_into().expect("u64")),
            ));
        }
        Some(Self {
            generation,
            up_to_seq: u32_at(4),
            rows,
        })
    }
}

enum DigestDisposition {
    Compare,
    Stale,
    AwaitSnapshot,
}

/// The header fields receipt reads, from one parse.
#[derive(Clone, Copy)]
struct Frame {
    snapshot: bool,
    seq: u32,
    generation: u32,
    input_seq: u32,
    echo_horizon: u32,
    frame_id: u32,
    presentation_id: u32,
    presentation_member_index: u16,
    presentation_member_count: u16,
    row_predecessor_presentation_id: u32,
    presentation_coherent: bool,
    presentation_end: bool,
    cols: u16,
    rows: u16,
    row_count: u16,
    chunk_index: u16,
    chunk_count: u16,
    demand_serial: u32,
    demand_limited: bool,
    demand_prompt: bool,
    demand_awaits_grant: bool,
    closure_digest: u64,
}

/// What every chunk of one frame shares: its presentation identity and the
/// grid it describes.
#[derive(Clone, Copy)]
struct Shape {
    frame_id: u32,
    presentation_id: u32,
    member_index: u16,
    member_count: u16,
    row_predecessor: u32,
    dims: (u16, u16),
}

impl Frame {
    /// A display patch whose declared body is exactly its bytes, from a
    /// daemon generation, naming a grid and a chunk inside its frame.
    fn parse(payload: &[u8]) -> Option<Self> {
        if payload.len() > MAX_DISPLAY_FRAME_BYTES {
            return None;
        }
        let stream = parse_stream_header(payload)?;
        if stream.msg_type != MSG_TYPE_DISPLAY_PATCH
            || stream.body_len as usize != payload.len() - STREAM_HEADER_BYTES
        {
            return None;
        }
        let header = parse_frame_header(payload).ok()?;
        let snapshot = matches!(header.kind, FrameKind::Snapshot);
        // Generation zero is never a daemon's, and sequence zero belongs to
        // the reliable snapshot alone.
        if stream.generation == 0 || (!snapshot && stream.seq == 0) {
            return None;
        }
        if header.cols == 0
            || header.rows == 0
            || header.chunk_count == 0
            || header.chunk_index >= header.chunk_count
        {
            return None;
        }
        Some(Self {
            snapshot,
            seq: stream.seq,
            generation: stream.generation,
            input_seq: stream.input_seq,
            echo_horizon: header.echo_horizon,
            frame_id: header.frame_id,
            presentation_id: header.presentation_id,
            presentation_member_index: header.presentation_member_index,
            presentation_member_count: header.presentation_member_count,
            row_predecessor_presentation_id: header.row_predecessor_presentation_id,
            presentation_coherent: header.presentation_coherent,
            presentation_end: header.presentation_end,
            cols: header.cols,
            rows: header.rows,
            row_count: header.row_count,
            chunk_index: header.chunk_index,
            chunk_count: header.chunk_count,
            demand_serial: header.demand_serial,
            demand_limited: header.demand_limited,
            demand_prompt: header.demand_prompt,
            demand_awaits_grant: header.demand_awaits_grant,
            closure_digest: header.closure_digest,
        })
    }

    fn shape(&self) -> Shape {
        Shape {
            frame_id: self.frame_id,
            presentation_id: self.presentation_id,
            member_index: self.presentation_member_index,
            member_count: self.presentation_member_count,
            row_predecessor: self.row_predecessor_presentation_id,
            dims: (self.cols, self.rows),
        }
    }

    /// The frame's advice as the presentation ledger observes it.
    fn member(&self) -> Member {
        Member {
            presentation_id: self.presentation_id,
            coherent: self.presentation_coherent,
            end: self.presentation_end,
            member_index: self.presentation_member_index,
            member_count: self.presentation_member_count,
            display_seq: self.seq,
            generation: self.generation,
            row_predecessor_presentation_id: self.row_predecessor_presentation_id,
            row_bearing: self.row_count > 0,
            demand_serial: self.demand_serial,
            awaits_grant: self.demand_awaits_grant,
        }
    }

    /// The fields that size retained work stay inside the protocol's grid.
    fn bounded(&self, bytes: usize) -> bool {
        let (cols, rows) = (usize::from(self.cols), usize::from(self.rows));
        cols <= MAX_TERMINAL_COLUMNS
            && rows <= MAX_TERMINAL_ROWS
            && cols * rows <= MAX_TERMINAL_CELLS
            && self.chunk_count <= self.rows
            && self.row_count <= self.rows
            && bytes <= MAX_DISPLAY_FRAME_BYTES
    }
}

/// One staged chunk and what applying it records.
#[derive(Clone, Copy)]
struct Chunk {
    handle: u32,
    seq: u32,
    input_seq: u32,
    echo_horizon: u32,
    rows: u16,
    bytes: usize,
    coherent: bool,
    end: bool,
    demand_serial: u32,
    demand_limited: bool,
    demand_prompt: bool,
    demand_awaits_grant: bool,
    closure_digest: u64,
    recovered: bool,
    decoded_at_ms: f64,
}

/// A multi-chunk frame waiting for its last chunk.
struct Assembly {
    generation: u32,
    frame_id: u32,
    snapshot: bool,
    presentation_id: u32,
    presentation_member_index: u16,
    presentation_member_count: u16,
    row_predecessor_presentation_id: u32,
    cols: u16,
    rows: u16,
    chunks: Vec<Option<Chunk>>,
    received: usize,
    received_rows: u32,
    bytes: usize,
}

impl Assembly {
    fn new(frame: &Frame) -> Self {
        Self {
            generation: frame.generation,
            frame_id: frame.frame_id,
            snapshot: frame.snapshot,
            presentation_id: frame.presentation_id,
            presentation_member_index: frame.presentation_member_index,
            presentation_member_count: frame.presentation_member_count,
            row_predecessor_presentation_id: frame.row_predecessor_presentation_id,
            cols: frame.cols,
            rows: frame.rows,
            chunks: vec![None; usize::from(frame.chunk_count)],
            received: 0,
            received_rows: 0,
            bytes: 0,
        }
    }

    /// Every chunk of one frame names the same frame.
    fn matches(&self, frame: &Frame) -> bool {
        self.generation == frame.generation
            && self.frame_id == frame.frame_id
            && self.snapshot == frame.snapshot
            && self.presentation_id == frame.presentation_id
            && self.presentation_member_index == frame.presentation_member_index
            && self.presentation_member_count == frame.presentation_member_count
            && self.row_predecessor_presentation_id == frame.row_predecessor_presentation_id
            && self.cols == frame.cols
            && self.rows == frame.rows
            && self.chunks.len() == usize::from(frame.chunk_count)
    }

    fn shape(&self) -> Shape {
        Shape {
            frame_id: self.frame_id,
            presentation_id: self.presentation_id,
            member_index: self.presentation_member_index,
            member_count: self.presentation_member_count,
            row_predecessor: self.row_predecessor_presentation_id,
            dims: (self.cols, self.rows),
        }
    }
}

/// The newest applied frame's complete-screen claim. Only the newest applied
/// sequence speaks for the grid: term-wasm applies rows and headers only from
/// newer sequences, so a late older frame can neither change the grid nor
/// revive an older claim.
#[derive(Default)]
struct ClosureClaim {
    generation: u32,
    seq: u32,
    /// Zero claims nothing.
    digest: u64,
    /// The grid's canonical mutation epoch when noted.
    mutation_epoch: u64,
    /// The grid does not digest to the claim yet: nothing may be shown.
    pending: bool,
}

/// A delta that overtook its generation's snapshot, in its encoded form and
/// under the input numbering it arrived with.
struct Ahead {
    generation: u32,
    recovered: bool,
    input: InputMapping,
    bytes: Vec<u8>,
}

enum Admission {
    Apply,
    Ahead,
    Drop,
}

/// An ACK the session is owed for one generation. `applied` comes from a
/// frame that applied and carries nothing until its window holds a sequence;
/// `grant` comes from the grant clock and carries the grant even with an
/// empty window.
struct Owed {
    generation: u32,
    applied: bool,
    grant: bool,
    durable: bool,
}

pub struct Viewer<G> {
    grid: G,
    links: super::links::Links,
    /// Geometry belongs to the controlling host until it yields ownership.
    owned_geometry: Option<(u16, u16)>,
    /// Local reflow has no authoritative row lineage until a complete matching frame.
    resize_pending: bool,
    /// Profiling only: the local guess, before any authoritative frame replaces it.
    resize_guess_hashes: Vec<u64>,
    /// The generation deltas apply in; 0 before the first snapshot.
    generation: u32,
    /// A session began and no snapshot has applied since: no ordering relates
    /// the new daemon's generations to the old, so every delta waits.
    epoch_reset: bool,
    /// The next snapshot roots the generation space whatever its number.
    lineage_unrooted: bool,
    /// A snapshot is owed; deltas of the current generation are dropped.
    resync_pending: bool,
    resync_at_ms: Option<f64>,
    last_applied_ms: Option<f64>,
    assemblies: Vec<Assembly>,
    assembly_bytes: usize,
    ahead: Vec<Ahead>,
    ahead_bytes: usize,
    /// Deltas released by the snapshot they waited for, applied after it.
    replay: VecDeque<Ahead>,
    /// Applied sequences per generation, retired by the snapshot that
    /// supersedes them.
    windows: Vec<(u32, AckWindow)>,
    demand: Demand,
    fec: FecDecoder,
    /// Storage for the frames one arrival rebuilds, reused by the next.
    rebuilt: Rebuilt,
    /// A digest ahead of what has applied, and when it stops waiting.
    deferred: Option<Digest>,
    deferred_at_ms: Option<f64>,
    owed: Vec<Owed>,
    snapshot_owed: bool,
    /// Control messages for the session, in order.
    control: VecDeque<Output>,
    presentation: PresentationCoordinator,
    closure: ClosureClaim,
    /// Applied authoritative state not yet taken as the shown grid.
    render_pending: bool,
    /// The grid's dimensions when last applied: a change is visual.
    applied_dims: (u16, u16),
    /// One early commit per presented frame, besides the frame's own.
    completion_opportunity: bool,
    completion_last_frame_ms: f64,
    completion_last_submit_ms: f64,
    /// The host's display period, as its last frame reported it.
    period_ms: f64,
    /// The host's network RTT, as its last frame reported it.
    network_rtt_ms: Option<f64>,
    input_routing: InputRoutingHold,
    repaint_hold: RepaintHold,
    /// The epoch of the input numbering frames last arrived under; 0 after a
    /// fence.
    input_epoch: u32,
    prediction: Prediction,
    /// The display lineage the last fence opened.
    lineage: u32,
    /// The host's cell in pixels; nothing is projected until it is known.
    cell_size: Option<(f64, f64)>,
    /// The graphics revision the scene was projected at; `None` owes a
    /// projection.
    graphics_revision: Option<u32>,
    playback: Playback,
    /// The tiles the host holds, as it reported them this lineage.
    resident: HashSet<String>,
    /// The assets the session was last asked for this lineage.
    graphics_demands: Vec<GraphicsDemand>,
    /// Whether the host's last frame reported its view hidden.
    hidden: bool,
    stats: Stats,
    applied_identity: (u32, u32, bool),
    presentation_ready: bool,
    tracing: bool,
    presentation_trace: Option<PresentationTrace>,
}

impl<G: DisplayGrid> Viewer<G> {
    pub fn new(grid: G) -> Self {
        Self {
            grid,
            links: super::links::Links::default(),
            owned_geometry: None,
            resize_pending: false,
            resize_guess_hashes: Vec::new(),
            generation: 0,
            epoch_reset: false,
            lineage_unrooted: false,
            resync_pending: false,
            resync_at_ms: None,
            last_applied_ms: None,
            assemblies: Vec::new(),
            assembly_bytes: 0,
            ahead: Vec::new(),
            ahead_bytes: 0,
            replay: VecDeque::new(),
            windows: Vec::new(),
            demand: Demand::default(),
            fec: FecDecoder::default(),
            rebuilt: Rebuilt::default(),
            deferred: None,
            deferred_at_ms: None,
            owed: Vec::new(),
            snapshot_owed: false,
            control: VecDeque::new(),
            presentation: PresentationCoordinator::new(0),
            closure: ClosureClaim::default(),
            render_pending: false,
            applied_dims: (0, 0),
            completion_opportunity: false,
            completion_last_frame_ms: f64::NEG_INFINITY,
            completion_last_submit_ms: f64::NEG_INFINITY,
            period_ms: 0.0,
            network_rtt_ms: None,
            input_routing: InputRoutingHold::default(),
            repaint_hold: RepaintHold::default(),
            input_epoch: 0,
            prediction: Prediction::default(),
            lineage: 0,
            cell_size: None,
            graphics_revision: None,
            playback: Playback::default(),
            resident: HashSet::new(),
            graphics_demands: Vec::new(),
            hidden: false,
            stats: Stats::default(),
            applied_identity: (0, 0, false),
            presentation_ready: true,
            tracing: false,
            presentation_trace: None,
        }
    }

    /// The presentation transaction, for the host's telemetry.
    pub fn presentation(&self) -> &PresentationCoordinator {
        &self.presentation
    }

    pub fn links(&self) -> &super::links::Links {
        &self.links
    }

    pub fn grid(&self) -> &G {
        &self.grid
    }

    pub fn grid_mut(&mut self) -> &mut G {
        &mut self.grid
    }

    /// The controlling host changed its viewport. Preserve the input barrier
    /// across the local reflow until authoritative display covers it, exactly
    /// as the terminal worker's `handleResize` does.
    pub fn resize(&mut self, cols: u16, rows: u16) {
        self.owned_geometry = Some((cols, rows));
        if (self.grid.cols(), self.grid.rows()) == (cols, rows) {
            return;
        }
        self.prediction.fence_for_resize(&mut self.grid);
        self.grid.resize(cols, rows);
        self.resize_pending = true;
        self.deferred = None;
        self.deferred_at_ms = None;
        self.resize_guess_hashes.clear();
        if self.tracing && (self.grid.cols(), self.grid.rows()) == (cols, rows) {
            self.resize_guess_hashes
                .extend_from_slice(self.grid.row_hashes());
        }
    }

    /// A geometry transfer retires the local request. An unanswered local
    /// reflow must be replaced by authority before it can claim or compare rows.
    pub fn release_geometry(&mut self, now_ms: f64) {
        self.owned_geometry = None;
        self.resize_guess_hashes.clear();
        if self.resize_pending {
            self.resync(now_ms, Resync::HostRequest);
        }
    }

    /// The generation the grid holds; 0 before the first snapshot.
    /// Exact renderer capacity, supplied before a host attempts a presentation.
    pub fn set_presentation_ready(&mut self, ready: bool) {
        self.presentation_ready = ready;
    }
    pub fn set_tracing(&mut self, enabled: bool) {
        self.tracing = enabled;
    }
    /// The host is done with the viewer: what it held offscreen is never shown.
    pub fn discard_presentation(&mut self) {
        self.reset_presentation_transaction(Discard::Teardown);
    }

    pub fn take_presentation_trace(&mut self) -> Option<PresentationTrace> {
        self.presentation_trace.take()
    }

    pub fn applied_identity(&self) -> (u32, u32, bool) {
        self.applied_identity
    }

    pub fn applied_sequence(&self) -> u32 {
        self.applied_high_water(self.generation)
    }

    /// An explicit host refresh follows the same snapshot fence as a failed lineage.
    pub fn request_snapshot(&mut self, now_ms: f64) {
        self.resync(now_ms, Resync::HostRequest);
    }

    /// A host convergence observation may ask for specific current-lineage rows.
    /// It cannot issue repair for an unrooted, abandoned or different generation.
    pub fn request_row_repair(&mut self, generation: u32, rows: &[u16]) -> bool {
        if self.lineage_unrooted
            || self.resync_pending
            || generation != self.generation
            || rows.is_empty()
            || rows.iter().any(|row| *row >= self.grid.rows())
        {
            return false;
        }
        let mut rows = rows.to_vec();
        rows.sort_unstable();
        rows.dedup();
        self.stats.resync_rows += rows.len() as u64;
        self.control
            .push_back(Output::ResyncRows { generation, rows });
        true
    }

    pub fn generation(&self) -> u32 {
        self.generation
    }

    pub fn stats(&self) -> Stats {
        self.stats
    }

    pub fn demand(&self) -> &Demand {
        &self.demand
    }

    /// An authenticated session began: the first, or the successor a rebind
    /// committed. Its daemon may be another process, so no generation orders
    /// across the fence and its first snapshot roots the lineage. The grid is
    /// kept when it can be claimed: the claim goes to the daemon, which
    /// repairs only the rows that diverged, and the paint is held until they
    /// all landed. A grid that cannot be claimed waits for a snapshot.
    pub fn fence(&mut self, now_ms: f64, fence: DisplayFence) {
        self.links.clear();
        // A transaction the old lineage left offscreen: its membership ends
        // here, so its rows may not show until a snapshot replaces them.
        let superseded = self.presentation.has_pending_transaction();
        let retain_paint = self.repaint_hold.is_held() || superseded || self.render_pending;
        let resume = self.resume_claim(fence.lineage);
        let preserve = resume
            .as_ref()
            .is_some_and(|resume| resume.row_hashes.is_some());
        self.reset_presentation_transaction(Discard::EpochReset);
        self.release_retained();
        self.fec.reset();
        // The new session numbers input afresh.
        self.input_epoch = 0;
        self.prediction.reset_session(&mut self.grid);
        // Its daemon holds none of the scene's assets for this client yet, and
        // its clock is another's: the scene is stated again below.
        self.lineage = fence.lineage;
        self.playback.clear();
        self.resident.clear();
        self.graphics_demands.clear();
        self.graphics_revision = None;
        self.deferred = None;
        self.deferred_at_ms = None;
        self.owed.clear();
        // The daemon keeps its dictionaries exactly when the claim carries row
        // hashes, so a kept grid keeps its dictionaries and the acks it still
        // owes for them.
        if preserve {
            self.control
                .retain(|output| matches!(output, Output::DictionaryAck(_)));
        } else {
            self.grid.clear_dictionaries();
            self.control.clear();
        }
        // States in flight on the replaced carrier never arrive; the daemon
        // grants itself one state past its newest across the same boundary.
        self.demand.reset_session();
        // A kept grid keeps its generation, and the daemon continues the same
        // sequence space into it.
        if !preserve {
            self.windows.clear();
        }
        self.owned_geometry = None;
        self.resize_guess_hashes.clear();
        self.epoch_reset = !preserve;
        self.lineage_unrooted = true;
        if preserve {
            self.presentation.adopt_generation(self.generation);
            self.stats.resumes += 1;
        }
        // For the same reason, a held routing word's position orders nothing
        // the new session sends.
        self.input_routing.fence();
        self.resync_pending = !preserve || superseded;
        self.resync_at_ms = self.resync_pending.then_some(now_ms + RESYNC_TIMEOUT_MS);
        self.snapshot_owed = false;
        if let Some(resume) = resume {
            self.control.push_back(Output::Resume(resume));
        }
        if self.resync_pending {
            self.control.push_back(Output::SnapshotRequest);
        }
        self.control.push_back(Output::DictionaryReady(true));
        self.project_graphics(now_ms);
        if preserve && !superseded {
            self.repaint_hold.arm(fence.lineage);
        } else if retain_paint {
            // The grid stays the visible authority until the snapshot
            // replaces it.
            self.repaint_hold
                .await_snapshot(now_ms + snapshot_deadline_ms(self.network_rtt_ms));
        } else {
            self.repaint_hold.release();
        }
    }

    /// What the grid can tell a new session's daemon: its row hashes when it
    /// holds a snapshot of its generation, else only the generation, so that
    /// the daemon's next one is newer.
    ///
    /// A grid holding only the snapshot is claimed at sequence zero. The
    /// daemon primed its acknowledged rows from that snapshot when it sent
    /// it, so the claim matches and nothing is repainted. The terminal worker
    /// withdraws that claim (`publishDisplayClaim` wants an ACK window), which
    /// turns a rebind right after a snapshot into another snapshot.
    fn resume_claim(&mut self, lineage: u32) -> Option<DisplayResume> {
        let (cols, rows) = (self.grid.cols(), self.grid.rows());
        if self.generation == 0 || cols == 0 || rows == 0 {
            return None;
        }
        let claimed =
            !self.epoch_reset && !self.resize_pending && usize::from(rows) <= MAX_TERMINAL_ROWS;
        let row_hashes = claimed.then(|| self.grid.row_hashes().to_vec());
        Some(DisplayResume {
            generation: self.generation,
            applied_seq: self.applied_high_water(self.generation),
            repair_id: lineage,
            cols,
            rows,
            row_hashes,
        })
    }

    /// One opened frame from the session: the display lanes, and the
    /// control-lane messages that are the viewer's. `input` is the numbering
    /// the session sent input under when the frame arrived, which is how its
    /// header's input sequence reads as the host's.
    pub fn receive(&mut self, now_ms: f64, channel: u8, payload: &[u8], input: InputMapping) {
        if channel == CHANNEL_CTRL {
            match decode_proto_frame(payload) {
                Some((MSG_TYPE_DISPLAY_LINK_TABLE, body)) => {
                    self.links.receive(body);
                }
                Some((MSG_TYPE_DISPLAY_HASH_DIGEST, body)) => self.on_digest(now_ms, body),
                Some((MSG_TYPE_DISPLAY_DICT_INSTALL, body)) => self.on_dictionary_install(body),
                Some((MSG_TYPE_INPUT_ROUTING, body)) => self.on_input_routing(body),
                Some((MSG_TYPE_DISPLAY_REPAIR_END, body)) => self.on_repair_end(now_ms, body),
                Some((MSG_TYPE_EDITOR_ANCHOR, body)) => {
                    self.prediction.editor_anchor(&mut self.grid, body);
                }
                _ => {}
            }
            return;
        }
        if channel != CHANNEL_DISPLAY_DATAGRAM && channel != CHANNEL_DISPLAY_COMMIT {
            return;
        }
        // A frame that arrived under a numbering the session has since
        // replaced names inputs in none; a new numbering starts FEC afresh.
        match classify_epoch(self.input_epoch, input.epoch) {
            EpochDecision::Stale => return,
            EpochDecision::Advance => {
                self.input_epoch = input.epoch;
                self.fec.reset();
            }
            EpochDecision::Current => {}
        }
        // Protected frames are kept whatever their fate below, and a frame
        // that completes a batch lets the ones it rebuilds apply first.
        let mut rebuilt = std::mem::take(&mut self.rebuilt);
        self.fec.receive(payload, &mut rebuilt);
        for frame in rebuilt.iter() {
            let applied = self.stats.frames;
            self.admit(now_ms, frame, true, input);
            self.stats.recovered += self.stats.frames - applied;
        }
        self.rebuilt = rebuilt;
        self.admit(now_ms, payload, false, input);
        while let Some(ahead) = self.replay.pop_front() {
            self.admit(now_ms, &ahead.bytes, ahead.recovered, ahead.input);
        }
    }

    /// One frame of the host's display, at `frame_ms` on the viewer's clock:
    /// it issues the display grant and releases a held transaction whose rule
    /// allows. True when the grid committed a new presentation to show.
    pub fn frame(
        &mut self,
        frame_ms: f64,
        period_ms: f64,
        visible: bool,
        network_rtt_ms: Option<f64>,
    ) -> Option<Release> {
        self.prediction
            .reconcile_applied(&mut self.grid, self.epoch_reset, frame_ms);
        self.set_visible(frame_ms, visible);
        self.period_ms = period_ms;
        if network_rtt_ms.is_some() {
            self.network_rtt_ms = network_rtt_ms;
        }
        if frame_ms > self.completion_last_frame_ms && frame_ms > self.completion_last_submit_ms {
            self.completion_last_frame_ms = frame_ms;
            self.completion_opportunity = true;
        }
        let grant = self
            .demand
            .on_frame(frame_ms, period_ms, visible, network_rtt_ms);
        self.post_grant(grant);
        // A repair's visual bound counts the frames the host delivered.
        if self.repaint_hold.awaiting_frames() {
            self.repaint_hold.note_frame(frame_ms);
        }
        if self.presentation.is_held()
            && self.presentation.release_at_frame(frame_ms) == Release::None
        {
            return None;
        }
        let release = self.commit_presentation();
        self.note_presented(frame_ms, release)
    }

    /// Visibility changes without presenting a frame or issuing a grant. A
    /// background host continues receiving state, but samples no animation.
    pub fn set_visible(&mut self, now_ms: f64, visible: bool) {
        if visible == self.hidden {
            self.hidden = !visible;
            if self.playback.suspend(self.hidden) {
                self.render_graphics(now_ms);
            }
        }
    }

    /// The host can show a state now, between frames: after a drained batch,
    /// urgent state, and a held transaction that closed early (a met claim, or
    /// a complete paced state), once per frame. `Some` names why the grid
    /// committed a new presentation to show.
    pub fn present_now(&mut self, now_ms: f64) -> Option<Release> {
        // The drain ended: compare the model against everything it applied
        // once, not against the transient authority between its frames.
        self.prediction
            .reconcile_applied(&mut self.grid, self.epoch_reset, now_ms);
        let release = self.present_applied(now_ms);
        self.note_presented(now_ms, release)
    }

    /// The model confirms an echo only once it is shown, so a verdict it
    /// deferred is due again the moment a presentation commits: the event the
    /// terminal worker's mismatch grace waits for.
    fn note_presented(&mut self, now_ms: f64, release: Option<Release>) -> Option<Release> {
        if release.is_some() {
            self.prediction
                .presented(&mut self.grid, self.epoch_reset, now_ms);
            self.project_graphics(now_ms);
        }
        release
    }

    /// The host's cell in pixels, which sizes every placement's footprint.
    pub fn set_cell_size(&mut self, now_ms: f64, width: f64, height: f64) {
        if self.cell_size != Some((width, height)) {
            self.cell_size = Some((width, height));
            self.graphics_revision = None;
            self.project_graphics(now_ms);
        }
    }

    /// The presented scene's images, for the host to draw: each quad's key is
    /// a binding, which an animation's group maps to its current frame's
    /// tile.
    pub fn reproject_graphics(&mut self, now_ms: f64) {
        self.graphics_revision = None;
        self.project_graphics(now_ms);
    }

    pub fn graphics_scene(&self) -> &Scene {
        self.playback.scene()
    }

    /// Whether the host holds tile `key` of lineage `epoch`. A frame whose
    /// tiles are not all held stays on screen.
    pub fn set_graphics_resident(&mut self, now_ms: f64, epoch: u32, key: &str, resident: bool) {
        if epoch != self.lineage {
            return;
        }
        let changed = if resident {
            self.resident.insert(key.to_string())
        } else {
            self.resident.remove(key)
        };
        if changed && self.playback.active() {
            self.render_graphics(now_ms);
        }
    }

    /// A verified animation manifest of lineage `epoch`, which starts its
    /// timeline.
    pub fn graphics_manifest(&mut self, now_ms: f64, epoch: u32, key: &str, mut bytes: Vec<u8>) {
        if epoch != self.lineage {
            bytes.fill(0);
            return;
        }
        if self.playback.accept(key, bytes) {
            self.render_graphics(now_ms);
        }
    }

    /// The daemon's monotonic clock read `monotonic_us` within the round trip
    /// `rtt_ms` that just ended.
    pub fn graphics_clock(&mut self, now_ms: f64, monotonic_us: u64, rtt_ms: f64) {
        if self
            .playback
            .calibrate(monotonic_us, now_ms, rtt_ms * 500.0)
        {
            self.render_graphics(now_ms);
        }
    }

    /// A commit changed the placements, or the cell changed: project the
    /// scene again.
    fn project_graphics(&mut self, now_ms: f64) {
        let Some((cell_width, cell_height)) = self.cell_size else {
            return;
        };
        let revision = self.grid.graphics_revision();
        if self.graphics_revision == Some(revision) {
            return;
        }
        self.graphics_revision = Some(revision);
        self.playback
            .replace(self.grid.graphics_fragments(), cell_width, cell_height);
        self.render_graphics(now_ms);
    }

    /// Samples the timelines and asks the session for what the scene now
    /// needs, when that changed.
    fn render_graphics(&mut self, now_ms: f64) {
        let resident = &self.resident;
        let grid = &mut self.grid;
        let demands = self.playback.render(
            now_ms,
            &mut |scene| grid.admit_graphics_scene(scene),
            &|key| resident.contains(key),
        );
        if demands != self.graphics_demands {
            self.graphics_demands = demands.clone();
            self.control.push_back(Output::GraphicsDemand {
                epoch: self.lineage,
                demands,
            });
        }
    }

    fn present_applied(&mut self, now_ms: f64) -> Option<Release> {
        if self.presentation_ready
            && self.render_pending
            && self.presentation.is_held()
            && self.completion_opportunity
            && !self.repaint_hold.is_held()
            && !self.resync_pending
            && !self.lineage_unrooted
            && (self.presentation.closure() != Closure::Met || self.closure_claim_current())
            && self.presentation.early_release_eligible()
        {
            let grid = &mut self.grid;
            let committed = self.presentation.with_early_release(|| {
                grid.commit_presentation();
                true
            });
            if committed {
                let reason = self.presentation.last_release_reason();
                self.capture_presentation_trace(reason);
                self.completion_opportunity = false;
                self.completion_last_submit_ms = now_ms;
                self.presentation.consume_committed();
                self.render_pending = false;
                self.stats.presentations += 1;
                return Some(reason);
            }
        }
        self.commit_presentation()
    }

    /// The terminal became visible: fresh state is requested at once.
    pub fn resume_visible(&mut self) {
        let grant = self.demand.resume_visible();
        self.post_grant(grant);
    }

    /// Whether the host must deliver another frame: the grant clock runs, or
    /// a transaction, or the repair's visual bound, is held for one.
    pub fn wants_frame(&self, visible: bool) -> bool {
        self.demand.wants_frame(visible)
            || self.presentation.is_held()
            || self.repaint_hold_gates_presentation()
    }

    /// The resume repair's visual bound is what keeps applied rows offscreen.
    fn repaint_hold_gates_presentation(&self) -> bool {
        self.repaint_hold.awaiting_frames() && self.presentation.has_pending_transaction()
    }

    /// The repaint hold keeps applied rows offscreen. A snapshot wait keeps
    /// all of them, which the terminal worker gets from rendering only when
    /// something schedules it; a host that presents after every batch needs
    /// it stated. A repair keeps the transactions that opened while it holds.
    fn repaint_hold_keeps_paint(&self) -> bool {
        self.repaint_hold.awaits_snapshot()
            || (self.repaint_hold.is_held() && self.presentation.has_pending_transaction())
    }

    /// Take applied state as the shown grid, unless something holds it.
    fn commit_presentation(&mut self) -> Option<Release> {
        if !self.presentation_ready
            || !self.render_pending
            || self.presentation.is_held()
            || self.closure_holds_presentation()
            || self.repaint_hold_keeps_paint()
        {
            return None;
        }
        let reason = self.presentation.last_release_reason();
        self.capture_presentation_trace(reason);
        self.grid.commit_presentation();
        self.render_pending = false;
        if self.presentation.has_pending_transaction() {
            self.presentation.consume_committed();
        }
        self.stats.presentations += 1;
        Some(reason)
    }

    fn capture_presentation_trace(&mut self, reason: Release) {
        if self.tracing && self.presentation.has_pending_transaction() {
            let p = &self.presentation;
            let rows = p.accumulated_rows();
            let bytes = p.accumulated_bytes();
            self.presentation_trace = Some(PresentationTrace {
                words: [
                    p.generation(),
                    p.first_display_seq(),
                    p.last_display_seq(),
                    p.display_input_seq(),
                    p.first_presentation_id(),
                    p.latest_presentation_id(),
                    p.applied_datagram_count(),
                    rows as u32,
                    (rows >> 32) as u32,
                    bytes as u32,
                    (bytes >> 32) as u32,
                    p.queue_high_water(),
                    u32::from(p.coherent()),
                    u32::from(p.end_seen()),
                    p.membership_release_disable_bits(),
                    p.release_frame_count(),
                    match reason {
                        Release::None => 0,
                        Release::EndQuiet => 1,
                        Release::Deadline => 2,
                        Release::Urgent => 3,
                        Release::MembershipComplete => 4,
                        Release::ClosureComplete => 5,
                        Release::PacedComplete => 6,
                    },
                    p.display_echo_horizon(),
                ],
                times: [
                    p.first_applied_at_ms(),
                    p.last_applied_at_ms(),
                    p.transaction_deadline_at_ms(),
                    p.transaction_refresh_period_ms(),
                    p.release_frame_time_ms(),
                ],
            });
        }
    }

    pub fn next_deadline(&self) -> Option<f64> {
        [
            self.resync_at_ms,
            self.deferred_at_ms,
            self.repaint_hold.deadline_ms(),
            self.prediction.next_deadline(),
            self.playback.deadline_ms(),
        ]
        .into_iter()
        .flatten()
        .reduce(f64::min)
    }

    pub fn handle_timeout(&mut self, now_ms: f64) {
        // A snapshot that never replaced the held paint: what applied shows.
        self.repaint_hold.expire(now_ms);
        if self.resync_at_ms.is_some_and(|at| at <= now_ms) {
            if self.resync_pending {
                self.snapshot_owed = true;
                self.resync_at_ms = Some(now_ms + RESYNC_TIMEOUT_MS);
            } else {
                self.resync_at_ms = None;
            }
        }
        if self.deferred_at_ms.is_some_and(|at| at <= now_ms) {
            self.deferred_at_ms = None;
            self.deferred_digest_due(now_ms);
        }
        self.prediction
            .handle_timeout(&mut self.grid, self.epoch_reset, now_ms);
        // An animation reached its next boundary.
        if self.playback.deadline_ms().is_some_and(|at| at <= now_ms) {
            self.render_graphics(now_ms);
        }
    }

    /// One input record the host is about to send as its local input
    /// `input_seq`, shown to the speculative model first. True when the model
    /// took it: the record's modelled bit, which the daemon reads as a
    /// capability, so it goes out exactly as answered.
    pub fn input(&mut self, now_ms: f64, input_seq: u32, record: &[u8]) -> bool {
        self.prediction
            .input(&mut self.grid, self.epoch_reset, now_ms, input_seq, record)
    }

    /// Execute a synchronous input owner's frozen command and visibility bit.
    /// A newer authority, grant, or causal fence may refuse it; a later trust
    /// change must never change the visibility this particular key captured.
    pub fn prediction_command(
        &mut self,
        now_ms: f64,
        input_seq: u32,
        command: super::PredictionCommand,
        visible: bool,
    ) -> bool {
        self.prediction.command(
            &mut self.grid,
            self.epoch_reset,
            now_ms,
            input_seq,
            (command, visible),
        )
    }

    /// Exact admission authority for a host's synchronous mirror.
    pub fn prediction_armed(&self) -> bool {
        self.prediction.armed(&self.grid, self.epoch_reset)
    }

    pub fn authoritative_input(&self) -> u32 {
        self.prediction.authoritative_input()
    }

    /// Received state may still be held while the committed grid is drawable.
    pub fn presentation_held(&mut self) -> bool {
        self.presentation.is_held()
            || self.closure_holds_presentation()
            || self.repaint_hold_keeps_paint()
    }

    /// Every gate between applied and shown state, one bit each, for a host's
    /// diagnostics: which of them held a presentation the display never got.
    /// Reads only; a stale claim is reported as not pending rather than cleared.
    pub fn presentation_gates(&self) -> u32 {
        let closure_pending = self.closure.pending
            && self.closure.digest != 0
            && self.closure.mutation_epoch == self.grid.completion_mutation_epoch();
        [
            self.presentation.is_held(),
            closure_pending,
            self.repaint_hold.is_held(),
            self.repaint_hold.awaits_snapshot(),
            self.repaint_hold.awaiting_frames(),
            self.presentation.has_pending_transaction(),
            self.completion_opportunity,
            self.presentation_ready,
            self.render_pending,
            self.resync_pending,
            self.lineage_unrooted,
            self.epoch_reset,
            self.presentation.closure() == Closure::Met,
            self.hidden,
            self.presentation.early_release_eligible(),
        ]
        .into_iter()
        .enumerate()
        .fold(0, |bits, (bit, set)| bits | (u32::from(set) << bit))
    }

    /// An exact authority/retirement edge, including a repeated editor anchor.
    /// Hosts use this only to retire unsent pointer previews, never captured keys.
    pub fn prediction_authority_revision(&self) -> u32 {
        self.prediction.authority_revision()
    }

    pub fn prediction(&self) -> PredictionStats {
        self.prediction.stats()
    }

    /// The input owner ended. Keep authoritative presentation, drop every
    /// speculative cell and its pending reconciliation deadline.
    pub fn discard_input(&mut self) {
        self.prediction.reset_session(&mut self.grid);
    }

    /// The next message for the session. Handing an ACK over is sending the
    /// grants it carries.
    pub fn poll_output(&mut self, now_ms: f64) -> Option<Output> {
        if std::mem::take(&mut self.snapshot_owed) {
            return Some(Output::SnapshotRequest);
        }
        if let Some(message) = self.control.pop_front() {
            return Some(message);
        }
        while !self.owed.is_empty() {
            let owed = self.owed.remove(0);
            let grant = self.demand.grant(owed.generation);
            let window = self.windows.iter().find(|(generation, window)| {
                *generation == owed.generation && window.has_applied()
            });
            let payload = match window {
                Some((_, window)) => window.payload(owed.generation, grant),
                None if owed.grant && grant != 0 => DisplayAckPayload {
                    generation: owed.generation,
                    largest_seq: 0,
                    received: [0; DISPLAY_ACK_MASK_WORDS],
                    recovered: [0; DISPLAY_ACK_MASK_WORDS],
                    grant,
                },
                None => continue,
            };
            self.demand.note_grant_sent(now_ms);
            return Some(Output::Ack {
                payload,
                durable: owed.durable,
            });
        }
        None
    }

    fn admit(&mut self, now_ms: f64, payload: &[u8], recovered: bool, input: InputMapping) {
        if payload.first() == Some(&MSG_TYPE_DISPLAY_FEC_REPAIR) {
            // FEC repair is the decoder's; this lane only carries it.
            return;
        }
        let Some(mut frame) = Frame::parse(payload) else {
            return self.resync(now_ms, Resync::FrameParseFailed);
        };
        frame.input_seq = input.normalize_display(frame.input_seq);
        frame.echo_horizon = input.normalize_display(frame.echo_horizon);
        match self.pre_admit(now_ms, &frame) {
            Admission::Drop => {}
            Admission::Ahead => self.retain_ahead(frame.generation, payload, recovered, input),
            Admission::Apply => {
                // Membership observation only, and never a new hold.
                self.presentation.note_queued(&frame.member());
                self.buffer(now_ms, &frame, payload, recovered);
            }
        }
    }

    /// The generation gate, decided from the authenticated header before any
    /// decompression.
    fn pre_admit(&mut self, now_ms: f64, frame: &Frame) -> Admission {
        if frame.snapshot {
            return if self.lineage_unrooted
                || display_serial_reached(frame.generation, self.generation)
            {
                Admission::Apply
            } else {
                Admission::Drop
            };
        }
        if self.epoch_reset {
            return Admission::Ahead;
        }
        if frame.generation == self.generation {
            return if self.resync_pending {
                Admission::Drop
            } else {
                Admission::Apply
            };
        }
        if display_serial_is_newer(frame.generation, self.generation) {
            self.await_in_flight_snapshot(now_ms);
            return Admission::Ahead;
        }
        self.note_stale_generation(now_ms);
        Admission::Drop
    }

    fn buffer(&mut self, now_ms: f64, frame: &Frame, payload: &[u8], recovered: bool) {
        let epoch_snapshot = self.lineage_unrooted && frame.snapshot;
        if !epoch_snapshot && !display_serial_reached(frame.generation, self.generation) {
            return;
        }
        if !frame.bounded(payload.len()) {
            return self.resync(now_ms, Resync::PendingFrameMetadata);
        }
        if self.resync_pending && !frame.snapshot {
            return;
        }
        if frame.snapshot {
            // Superseded work goes before this snapshot stages its own cells.
            self.prune_for_snapshot(frame.generation, frame.frame_id);
        }
        let handle = self.grid.stage(payload);
        if handle == 0 {
            return self.resync(now_ms, Resync::FrameStageFailed);
        }
        let decoded_at_ms = if self.tracing {
            let mut words = [
                1,
                frame.seq,
                frame.generation,
                frame.input_seq,
                frame.frame_id,
                u32::from(frame.chunk_index),
                u32::from(frame.chunk_count),
                frame.presentation_id,
                u32::from(frame.presentation_member_index),
                u32::from(frame.presentation_member_count),
                frame.row_predecessor_presentation_id,
                u32::from(frame.presentation_coherent)
                    | (u32::from(frame.presentation_end) << 1)
                    | (u32::from(recovered) << 2)
                    | (u32::from(frame.snapshot) << 4),
                payload.len() as u32,
                u32::from(frame.row_count),
            ];
            let decoded = self.grid.trace_display(&words, now_ms);
            words[0] = 2;
            self.grid.trace_display(&words, decoded);
            decoded
        } else {
            f64::NAN
        };
        let chunk = Chunk {
            handle,
            seq: frame.seq,
            input_seq: frame.input_seq,
            echo_horizon: frame.echo_horizon,
            rows: frame.row_count,
            bytes: payload.len(),
            coherent: frame.presentation_coherent,
            end: frame.presentation_end,
            demand_serial: frame.demand_serial,
            demand_limited: frame.demand_limited,
            demand_prompt: frame.demand_prompt,
            demand_awaits_grant: frame.demand_awaits_grant,
            closure_digest: frame.closure_digest,
            recovered,
            decoded_at_ms,
        };
        if frame.chunk_count == 1 {
            // Complete on arrival: never an assembly, so a lost datagram
            // costs one datagram.
            return self.apply(
                now_ms,
                frame.generation,
                frame.snapshot,
                frame.shape(),
                std::slice::from_ref(&chunk),
            );
        }
        self.assemble(now_ms, frame, chunk);
    }

    fn assemble(&mut self, now_ms: f64, frame: &Frame, chunk: Chunk) {
        let found = self.assemblies.iter().position(|assembly| {
            assembly.generation == frame.generation && assembly.frame_id == frame.frame_id
        });
        let index = match found {
            Some(index) => index,
            None => {
                if self.assembly_bytes + chunk.bytes > MAX_PENDING_ASSEMBLY_BYTES {
                    self.grid.release(chunk.handle);
                    return self.resync(now_ms, Resync::PendingFrameBytes);
                }
                if self.assemblies.len() >= MAX_PENDING_ASSEMBLIES {
                    // At least one incomplete atomic frame was lost. Restart
                    // from a complete snapshot rather than let a frame detached
                    // from it become authoritative.
                    self.grid.release(chunk.handle);
                    return self.resync(now_ms, Resync::PendingAssembliesOverflow);
                }
                self.assemblies.push(Assembly::new(frame));
                self.assemblies.len() - 1
            }
        };
        let assembly = &self.assemblies[index];
        let slot = usize::from(frame.chunk_index);
        let refusal = if !assembly.matches(frame) {
            Some(Resync::PendingFrameMismatch)
        } else if assembly.chunks[slot].is_some() {
            // A duplicate chunk: the first copy stands.
            self.grid.release(chunk.handle);
            return;
        } else if assembly.received_rows + u32::from(chunk.rows) > u32::from(assembly.rows) {
            Some(Resync::PendingFrameRows)
        } else if assembly.bytes + chunk.bytes > MAX_ASSEMBLY_BYTES
            || self.assembly_bytes + chunk.bytes > MAX_PENDING_ASSEMBLY_BYTES
        {
            Some(Resync::PendingFrameBytes)
        } else {
            None
        };
        if let Some(reason) = refusal {
            self.grid.release(chunk.handle);
            return self.resync(now_ms, reason);
        }
        let assembly = &mut self.assemblies[index];
        assembly.chunks[slot] = Some(chunk);
        assembly.received += 1;
        assembly.received_rows += u32::from(chunk.rows);
        assembly.bytes += chunk.bytes;
        self.assembly_bytes += chunk.bytes;
        if assembly.received < assembly.chunks.len() {
            return;
        }
        let assembly = self.assemblies.remove(index);
        self.assembly_bytes -= assembly.bytes;
        let shape = assembly.shape();
        let chunks: Vec<Chunk> = assembly.chunks.into_iter().flatten().collect();
        self.apply(
            now_ms,
            assembly.generation,
            assembly.snapshot,
            shape,
            &chunks,
        );
    }

    /// Apply one complete frame; every staged chunk is released on every path.
    fn apply(
        &mut self,
        now_ms: f64,
        generation: u32,
        snapshot: bool,
        shape: Shape,
        chunks: &[Chunk],
    ) {
        self.apply_owned(now_ms, generation, snapshot, shape, chunks);
        for chunk in chunks {
            self.grid.release(chunk.handle);
        }
    }

    fn apply_owned(
        &mut self,
        now_ms: f64,
        generation: u32,
        snapshot: bool,
        shape: Shape,
        chunks: &[Chunk],
    ) {
        let epoch_snapshot = self.lineage_unrooted && snapshot;
        if !epoch_snapshot && !display_serial_reached(generation, self.generation) {
            return;
        }
        // The whole frame validates before its first chunk touches the grid,
        // or a failed chunk would leave half a frame applied.
        if chunks.len() > 1 && !chunks.iter().all(|chunk| self.grid.validate(chunk.handle)) {
            return self.resync(now_ms, Resync::FrameValidationRejected);
        }
        if snapshot {
            self.grid.reset_ordering();
            if epoch_snapshot {
                // Windows and digests above a new lineage's snapshot may
                // belong to the previous daemon.
                self.windows.clear();
                self.deferred = None;
            } else {
                self.windows
                    .retain(|(recorded, _)| !display_serial_reached(generation, *recorded));
                if self
                    .deferred
                    .as_ref()
                    .is_some_and(|digest| display_serial_reached(generation, digest.generation))
                {
                    self.deferred = None;
                }
            }
        }
        // A snapshot that replaces the base predictions were drawn over fences
        // them; one of the same shape on the same lineage does not.
        let reset_base = snapshot
            && self.grid.has_predictions()
            && (epoch_snapshot || (self.grid.cols(), self.grid.rows()) != shape.dims);
        let mut visual = false;
        let mut max_seq = 0u32;
        let mut input_seq = 0u32;
        let mut echo_horizon = 0u32;
        for chunk in chunks {
            let applied = if snapshot {
                self.grid.apply_state(chunk.handle, chunk.seq)
            } else {
                self.grid.apply_delta(chunk.handle, chunk.seq)
            };
            if !applied {
                if self.grid.take_error().as_deref() == Some(DIMENSIONS_MISMATCH) {
                    // In flight across a resize: never acknowledged, so the
                    // daemon re-sends its rows. Not a lineage fault.
                    self.stats.dimension_mismatches += 1;
                    return;
                }
                return self.resync(now_ms, Resync::ApplyRejected);
            }
            visual |= self.grid.last_apply_visually_changed();
            // Snapshot chunks ride sequence zero: they reset the baseline
            // rather than enter the loss domain.
            if chunk.seq != 0 {
                self.window_for(generation).note(chunk.seq, chunk.recovered);
            }
            self.note_closure_claim(generation, chunk.seq, chunk.closure_digest);
            self.demand.note_applied(
                generation,
                chunk.demand_serial,
                chunk.demand_limited,
                chunk.demand_prompt,
                now_ms,
            );
            if display_serial_is_newer(chunk.seq, max_seq) {
                max_seq = chunk.seq;
            }
            if display_serial_is_newer(chunk.input_seq, input_seq) {
                input_seq = chunk.input_seq;
            }
            if display_serial_is_newer(chunk.echo_horizon, echo_horizon) {
                echo_horizon = chunk.echo_horizon;
            }
        }
        // A frame sent before the host's resize may still replace canonical
        // cells. It cannot take back the controlling host's requested viewport.
        if let Some(dims) = self.owned_geometry {
            if shape.dims == dims {
                if self.resize_pending {
                    if self.tracing {
                        let corrected = if self.resize_guess_hashes.len() == usize::from(dims.1) {
                            let hashes = self.grid.row_hashes();
                            self.resize_guess_hashes
                                .iter()
                                .zip(hashes)
                                .filter(|(guess, hash)| guess != hash)
                                .count() as u32
                        } else {
                            u32::MAX
                        };
                        let mut words = [0; 14];
                        words[..6].copy_from_slice(&[
                            4,
                            u32::from(dims.0),
                            u32::from(dims.1),
                            u32::from(snapshot),
                            corrected,
                            u32::from(dims.1),
                        ]);
                        self.grid.trace_display(&words, now_ms);
                    }
                    self.resize_pending = false;
                    self.resize_guess_hashes.clear();
                }
            } else {
                self.grid.resize(dims.0, dims.1);
            }
        } else if snapshot {
            self.resize_pending = false;
        }
        if reset_base {
            self.prediction.fence_for_snapshot(&mut self.grid);
        }
        self.prediction.note_applied(input_seq, echo_horizon);
        // A frame past a held routing word hands its routing bits back to the
        // header it just applied.
        if self.input_routing.note_applied(generation, max_seq) {
            self.grid.release_input_routing();
        }
        if snapshot {
            // A snapshot opens the daemon's fresh grant sequence even when it
            // reuses the generation number, and closes the old offscreen
            // transaction before opening its own.
            self.demand.reset_generation(generation);
            self.reset_presentation_transaction(if epoch_snapshot {
                Discard::EpochReset
            } else {
                Discard::Resync
            });
            self.presentation.adopt_generation(generation);
        }
        self.generation = generation;
        self.last_applied_ms = Some(now_ms);
        self.stats.frames += 1;
        self.stats.rows += chunks
            .iter()
            .map(|chunk| u64::from(chunk.rows))
            .sum::<u64>();
        self.applied_identity = (generation, shape.frame_id, snapshot);
        let dims = (self.grid.cols(), self.grid.rows());
        visual |= dims != self.applied_dims;
        self.applied_dims = dims;
        if self.tracing {
            let words = [
                3,
                max_seq,
                generation,
                input_seq,
                shape.frame_id,
                0,
                chunks.len() as u32,
                shape.presentation_id,
                u32::from(shape.member_index),
                u32::from(shape.member_count),
                shape.row_predecessor,
                u32::from(chunks.iter().any(|c| c.coherent))
                    | (u32::from(chunks.iter().any(|c| c.end)) << 1)
                    | (u32::from(chunks.iter().any(|c| c.recovered)) << 2)
                    | (u32::from(visual) << 3)
                    | (u32::from(snapshot) << 4),
                chunks.iter().map(|c| c.bytes as u32).sum(),
                chunks.iter().map(|c| u32::from(c.rows)).sum(),
            ];
            self.grid.trace_display(
                &words,
                chunks
                    .iter()
                    .map(|c| c.decoded_at_ms)
                    .fold(f64::NAN, f64::min),
            );
        }
        self.settle_deferred_digest(generation);
        if snapshot {
            self.stats.snapshots += 1;
            self.epoch_reset = false;
            self.lineage_unrooted = false;
            self.resync_pending = false;
            self.resync_at_ms = None;
            self.replay_ahead(generation, epoch_snapshot);
            // The complete snapshot now owns every row an abandoned repair
            // touched.
            self.repaint_hold.release();
        }
        self.owe(generation, true, false, false);

        // Every transformation of this frame applied: judge the newest claim
        // against exactly this grid, then place the frame in its transaction.
        let closure = self.evaluate_closure();
        self.presentation.set_closure(closure);
        let first = chunks.first().copied();
        let member = Member {
            presentation_id: shape.presentation_id,
            coherent: chunks.iter().any(|chunk| chunk.coherent),
            end: chunks.iter().any(|chunk| chunk.end),
            member_index: shape.member_index,
            member_count: shape.member_count,
            display_seq: max_seq,
            generation,
            row_predecessor_presentation_id: shape.row_predecessor,
            row_bearing: chunks.iter().any(|chunk| chunk.rows > 0),
            demand_serial: first.map_or(0, |chunk| chunk.demand_serial),
            awaits_grant: chunks.iter().all(|chunk| chunk.demand_awaits_grant),
        };
        if visual {
            self.render_pending = true;
            let application = Application {
                now_ms,
                refresh_period_ms: self.period_ms,
                input_seq,
                echo_horizon,
                rows: chunks.iter().map(|chunk| u32::from(chunk.rows)).sum(),
                bytes: chunks.iter().map(|chunk| chunk.bytes as u64).sum(),
                queued_frames: self.replay.len() as u32,
            };
            if self.presentation.note_applied(&application, &member) != ApplyAction::Now {
                // The member that completes a transaction releases it now, not
                // at the end of the batch.
                self.presentation.release_completed_at_pump();
            }
        } else {
            self.presentation.note_nonvisual_applied(&member);
        }
        // Only once the frame joined its transaction: exact membership comes
        // from the grid's row versions, and any visual mutation anchors the
        // repair's frame-counted bound.
        let grid = &self.grid;
        self.repaint_hold
            .note_applied(generation, max_seq, visual, now_ms, |row| {
                grid.row_version(row)
            });
        self.prediction
            .observe_mode(&mut self.grid, self.epoch_reset);
    }

    /// An applied frame of `generation` at `seq` carried the claim `digest`.
    fn note_closure_claim(&mut self, generation: u32, seq: u32, digest: u64) {
        if generation != self.closure.generation {
            self.closure.generation = generation;
            self.closure.seq = 0;
        }
        if self.closure.seq != 0 && !display_serial_is_newer(seq, self.closure.seq) {
            return;
        }
        self.closure.seq = seq;
        self.closure.digest = digest;
        self.closure.mutation_epoch = self.grid.completion_mutation_epoch();
    }

    fn clear_closure_claim(&mut self) {
        self.closure = ClosureClaim::default();
        self.presentation.set_closure(Closure::None);
    }

    /// A claim exists and still describes this grid.
    fn closure_claim_current(&mut self) -> bool {
        if self.closure.digest == 0 {
            return false;
        }
        if self.closure.mutation_epoch == self.grid.completion_mutation_epoch() {
            return true;
        }
        self.clear_closure_claim();
        false
    }

    /// Judge the newest claim against the grid as it stands now.
    fn evaluate_closure(&mut self) -> Closure {
        if !self.closure_claim_current() {
            self.closure.pending = false;
            return Closure::None;
        }
        self.closure.pending = !self.grid.closure_digest_matches(self.closure.digest);
        if self.closure.pending {
            Closure::Pending
        } else {
            Closure::Met
        }
    }

    /// The claimed complete screen still owes rows: nothing may be shown.
    fn closure_holds_presentation(&mut self) -> bool {
        self.closure.pending && self.closure_claim_current()
    }

    /// The offscreen transaction and its claim go: at a lineage boundary, under
    /// the snapshot that replaces its rows, or with the host. A recording host
    /// is told what went, before anything the replacement applies: those
    /// members were applied and are never committed, and a record that holds
    /// neither a commit nor this for them cannot be read as complete.
    fn reset_presentation_transaction(&mut self, reason: Discard) {
        self.clear_closure_claim();
        if self.tracing && self.presentation.has_pending_transaction() {
            let p = &self.presentation;
            let mut words = [0; 14];
            words[..8].copy_from_slice(&[
                5,
                p.generation(),
                p.first_display_seq(),
                p.last_display_seq(),
                p.applied_datagram_count(),
                u32::try_from(p.accumulated_rows()).unwrap_or(u32::MAX),
                u32::try_from(p.accumulated_bytes()).unwrap_or(u32::MAX),
                reason as u32,
            ]);
            self.grid.trace_display(&words, f64::NAN);
        }
        self.presentation.reset();
    }

    fn window_for(&mut self, generation: u32) -> &mut AckWindow {
        let index = match self
            .windows
            .iter()
            .position(|(recorded, _)| *recorded == generation)
        {
            Some(index) => index,
            None => {
                self.windows.push((generation, AckWindow::default()));
                self.windows.len() - 1
            }
        };
        &mut self.windows[index].1
    }

    fn post_grant(&mut self, grant: FrameGrant) {
        let durable = match grant {
            FrameGrant::Post => false,
            FrameGrant::PostDurable => true,
            FrameGrant::None | FrameGrant::Lazy => return,
        };
        if self.demand.grant(self.generation) == 0 {
            // Nothing can carry it: the grant stays counted, and its durable
            // copy is owed again.
            self.demand.note_post_failed();
            return;
        }
        self.owe(self.generation, false, true, durable);
    }

    /// One owed ACK per generation; the session is handed the newest window.
    fn owe(&mut self, generation: u32, applied: bool, grant: bool, durable: bool) {
        if let Some(owed) = self
            .owed
            .iter_mut()
            .find(|owed| owed.generation == generation)
        {
            owed.applied |= applied;
            owed.grant |= grant;
            owed.durable |= durable;
            return;
        }
        self.owed.push(Owed {
            generation,
            applied,
            grant,
            durable,
        });
    }

    fn retain_ahead(
        &mut self,
        generation: u32,
        payload: &[u8],
        recovered: bool,
        input: InputMapping,
    ) {
        if self.ahead.len() >= MAX_AHEAD_FRAMES
            || self.ahead_bytes + payload.len() > MAX_AHEAD_BYTES
        {
            return;
        }
        self.ahead_bytes += payload.len();
        self.ahead.push(Ahead {
            generation,
            recovered,
            input,
            bytes: payload.to_vec(),
        });
    }

    /// The deltas that waited for `generation`'s snapshot apply after it, in
    /// arrival order. Older ones can no longer apply; after a new lineage's
    /// snapshot no retained number is comparable at all.
    fn replay_ahead(&mut self, generation: u32, epoch_snapshot: bool) {
        for ahead in std::mem::take(&mut self.ahead) {
            if ahead.generation == generation {
                self.replay.push_back(ahead);
            } else if !epoch_snapshot && !display_serial_is_newer(generation, ahead.generation) {
                self.ahead.push(ahead);
            }
        }
        self.ahead_bytes = self.ahead.iter().map(|ahead| ahead.bytes.len()).sum();
    }

    /// Superseded assemblies go before a snapshot of `generation` applies.
    fn prune_for_snapshot(&mut self, generation: u32, frame_id: u32) {
        let grid = &mut self.grid;
        let mut released = 0;
        self.assemblies.retain(|assembly| {
            let same = assembly.generation == generation && assembly.frame_id == frame_id;
            if same || !display_serial_reached(generation, assembly.generation) {
                return true;
            }
            for chunk in assembly.chunks.iter().flatten() {
                grid.release(chunk.handle);
            }
            released += assembly.bytes;
            false
        });
        self.assembly_bytes -= released;
    }

    fn release_retained(&mut self) {
        for assembly in self.assemblies.drain(..) {
            for chunk in assembly.chunks.into_iter().flatten() {
                self.grid.release(chunk.handle);
            }
        }
        self.assembly_bytes = 0;
        self.ahead.clear();
        self.ahead_bytes = 0;
        self.replay.clear();
    }

    /// Abandon the lineage for a snapshot; one request while one is pending.
    fn resync(&mut self, now_ms: f64, reason: Resync) {
        // A failed repair may already have written rows its hold kept
        // offscreen, and a transaction may have applied before a later frame
        // proved the lineage unusable: both stay offscreen until the snapshot
        // replaces them, or its deadline shows what applied.
        if self.repaint_hold.is_held()
            || self.presentation.has_pending_transaction()
            || self.render_pending
        {
            self.repaint_hold
                .await_snapshot(now_ms + snapshot_deadline_ms(self.network_rtt_ms));
        } else {
            self.repaint_hold.release();
        }
        self.stats.resyncs += 1;
        self.stats.last_resync = Some(reason);
        self.release_retained();
        if self.resync_pending {
            return;
        }
        self.resync_pending = true;
        self.resync_at_ms = Some(now_ms + RESYNC_TIMEOUT_MS);
        self.snapshot_owed = true;
    }

    /// A newer generation's delta proves its snapshot is in flight: drop the
    /// current generation's deltas and wait, asking for nothing.
    fn await_in_flight_snapshot(&mut self, now_ms: f64) {
        if self.resync_pending {
            return;
        }
        self.resync_pending = true;
        self.resync_at_ms = Some(now_ms + RESYNC_TIMEOUT_MS);
    }

    /// Stale deltas that keep arriving while nothing applies mean this
    /// lineage sits above the daemon's: accept its lower snapshot.
    fn note_stale_generation(&mut self, now_ms: f64) {
        let Some(last_applied_ms) = self.last_applied_ms else {
            return;
        };
        if self.resync_pending || now_ms - last_applied_ms <= STALE_GENERATION_DESYNC_MS {
            return;
        }
        self.epoch_reset = true;
        self.lineage_unrooted = true;
        self.input_routing.unroot();
        self.resync(now_ms, Resync::StaleGenerationRecovery);
    }

    /// The daemon's incremental resume repair names each repaired row and the
    /// first sequence it admitted for it. Row versions carry no generation,
    /// so the marker must belong to the lineage the grid holds; the hold's
    /// repair id rejects an older reconnect of the same generation.
    fn on_repair_end(&mut self, now_ms: f64, body: &[u8]) {
        let Some(marker) = RepairEnd::parse(body) else {
            return;
        };
        if self.epoch_reset || marker.generation != self.generation {
            return;
        }
        if self.repaint_hold.awaits_repair(marker.repair_id) {
            self.stats.repairs += 1;
        }
        let grid = &self.grid;
        if self
            .repaint_hold
            .note_repair_end(&marker, now_ms, |row| grid.row_version(row))
        {
            // An empty matching repair is an eligible resumed presentation too:
            // no display frame need arrive to mark it dirty or earn host readiness.
            self.render_pending = true;
        }
    }

    /// `[generation:4][after_seq:4][serial:4][word:2]`: the routing bits of
    /// the mode word, sent while a synchronized update is paused and no
    /// display header can leave, and read after every frame up to its
    /// position. The host reads the mode word from the grid, as it does after
    /// a header.
    fn on_input_routing(&mut self, body: &[u8]) {
        let Ok(body) = <&[u8; 14]>::try_from(body) else {
            return;
        };
        let field = |at: usize| u32::from_be_bytes(body[at..at + 4].try_into().expect("u32"));
        let applied_seq = self.applied_high_water(self.generation);
        if self
            .input_routing
            .admit(field(0), field(4), field(8), self.generation, applied_seq)
        {
            self.grid
                .set_input_routing(u16::from_be_bytes([body[12], body[13]]));
            self.prediction
                .observe_mode(&mut self.grid, self.epoch_reset);
        }
    }

    /// `[generation:4][id:4][hash:4][len:2][bytes]`. The grid verifies the
    /// hash and that the bytes are a finalized dictionary before it holds
    /// them, and only then may the daemon compress against it.
    fn on_dictionary_install(&mut self, body: &[u8]) {
        let Some((header, bytes)) = body.split_at_checked(14) else {
            return;
        };
        let field = |at: usize| u32::from_be_bytes(header[at..at + 4].try_into().expect("u32"));
        if usize::from(u16::from_be_bytes([header[12], header[13]])) != bytes.len() {
            return;
        }
        let id = field(4);
        if !self.grid.install_dictionary(field(0), id, field(8), bytes) {
            return;
        }
        self.stats.dictionaries += 1;
        if !self.control.contains(&Output::DictionaryAck(id)) {
            self.control.push_back(Output::DictionaryAck(id));
        }
    }

    /// The daemon's row hashes at an applied position. Compared only when the
    /// grid sits exactly there: past it the digest describes an older grid and
    /// would flag every row changed since; short of it, it waits.
    fn on_digest(&mut self, now_ms: f64, body: &[u8]) {
        let Some(digest) = Digest::parse(body) else {
            return;
        };
        // The session fence already asked for a snapshot: a digest held now
        // would only let its deadline discard the new lineage's deltas.
        if self.epoch_reset || self.resize_pending {
            return;
        }
        match self.classify_digest(digest.generation) {
            DigestDisposition::Stale => return,
            DigestDisposition::AwaitSnapshot => return self.defer_digest(now_ms, digest),
            DigestDisposition::Compare => {}
        }
        let applied = self.applied_high_water(digest.generation);
        if display_serial_is_newer(digest.up_to_seq, applied) {
            return self.defer_digest(now_ms, digest);
        }
        if digest.up_to_seq == applied {
            self.compare_digest(&digest);
        }
    }

    fn classify_digest(&self, generation: u32) -> DigestDisposition {
        if generation == 0 {
            DigestDisposition::Stale
        } else if self.epoch_reset
            || (generation != self.generation
                && display_serial_is_newer(generation, self.generation))
        {
            DigestDisposition::AwaitSnapshot
        } else if generation == self.generation {
            DigestDisposition::Compare
        } else {
            DigestDisposition::Stale
        }
    }

    fn applied_high_water(&self, generation: u32) -> u32 {
        self.windows
            .iter()
            .find(|(recorded, _)| *recorded == generation)
            .map_or(0, |(_, window)| window.largest())
    }

    fn defer_digest(&mut self, now_ms: f64, digest: Digest) {
        self.deferred = Some(digest);
        if self.deferred_at_ms.is_none() {
            self.deferred_at_ms = Some(now_ms + DEFERRED_DIGEST_DEADLINE_MS);
        }
    }

    /// A frame of `generation` applied: a deferred digest compares if the
    /// grid reached exactly its position, and is dropped once passed or once
    /// its generation is older than the grid's.
    fn settle_deferred_digest(&mut self, generation: u32) {
        let Some(digest) = self.deferred.as_ref() else {
            return;
        };
        if digest.generation == generation {
            let applied = self.applied_high_water(generation);
            if digest.up_to_seq == applied {
                if let Some(digest) = self.deferred.take() {
                    self.compare_digest(&digest);
                }
            } else if display_serial_reached(applied, digest.up_to_seq) {
                self.deferred = None;
            }
        } else if display_serial_is_newer(self.generation, digest.generation) {
            self.deferred = None;
        }
    }

    /// The deferred digest's deadline. While frames still apply, catching up
    /// settles it; otherwise one still ahead of the grid's generation means a
    /// snapshot never came, and one of the grid's own is compared now.
    fn deferred_digest_due(&mut self, now_ms: f64) {
        if self.deferred.is_none() {
            return;
        }
        if self
            .last_applied_ms
            .is_some_and(|at| now_ms - at < DEFERRED_DIGEST_QUIESCENT_MS)
        {
            self.deferred_at_ms = Some(now_ms + DEFERRED_DIGEST_DEADLINE_MS);
            return;
        }
        let Some(digest) = self.deferred.take() else {
            return;
        };
        if self.epoch_reset || self.resize_pending {
            return;
        }
        match self.classify_digest(digest.generation) {
            DigestDisposition::AwaitSnapshot => {
                self.resync(now_ms, Resync::HashDigestGenerationAhead)
            }
            DigestDisposition::Compare => self.compare_digest(&digest),
            DigestDisposition::Stale => {}
        }
    }

    /// Name the rows whose hashes disagree; the daemon re-sends them whole.
    fn compare_digest(&mut self, digest: &Digest) {
        let rows = self.grid.rows();
        if digest.generation != self.generation || digest.rows.iter().any(|(row, _)| *row >= rows) {
            return;
        }
        let hashes = self.grid.row_hashes();
        let mismatched: Vec<u16> = digest
            .rows
            .iter()
            .filter(|(row, hash)| hashes.get(usize::from(*row)) != Some(hash))
            .map(|(row, _)| *row)
            .collect();
        if mismatched.is_empty() {
            return;
        }
        self.stats.resync_rows += mismatched.len() as u64;
        self.control.push_back(Output::ResyncRows {
            generation: digest.generation,
            rows: mismatched,
        });
    }
}

#[cfg(test)]
mod tests;
