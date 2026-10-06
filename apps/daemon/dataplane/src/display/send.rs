//! Display send path: flush scheduling, row classification, datagram
//! batching/pacing, FEC grouping, reliable/jumbo frames, and snapshots.

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use arrayvec::ArrayVec;
#[cfg(test)]
use merkur_codec::{RowRef, encoded_cells_size};

use tokio::sync::mpsc;
use tracing::{info, trace, warn};

use merkur_codec::{
    CellEncoding, CellRepr, DISPLAY_FEC_HEADER_BYTES, DISPLAY_HEADER_FLAG_FEC_PROTECTED,
    DISPLAY_PATCH_FLAGS_OFFSET, DISPLAY_PRESENTATION_ID_OFFSET,
    DISPLAY_PRESENTATION_MEMBER_COUNT_OFFSET, DISPLAY_PRESENTATION_MEMBER_INDEX_OFFSET,
    DISPLAY_ROW_PREDECESSOR_PRESENTATION_ID_OFFSET, FRAME_HEADER_BODY_BYTES, FrameHeader,
    GraphicsVersion, PATCH_FLAG_DEMAND_AWAITS_GRANT, PATCH_FLAG_PRESENTATION_COHERENT,
    PATCH_FLAG_PRESENTATION_END, PreparedGraphics, PreparedRowRef, ROW_PREFIX_BYTES, STREAM_HEADER_BYTES, encode_frame_into,
    encode_prepared_frame_into, plan_cell_encoding,
};

use crate::connection::{
    DisplayDatagramProtection, FecEvidenceByPath, K1ProtectionDecision, PathTargets,
    PeerDisplayState, PeerMap, PeerPaths, PeerTransport, PerPeerDisplayCache, SelectableRowShape,
    SendIntent, SentDatagram, SentPaths, SentRow, SentRows, display_row_is_selectable, pick_path,
};
#[cfg(test)]
use crate::connection::{SimDatagramMetadata, SimDatagramRole};
use crate::display::clock::FlushClock;
use crate::display::compressor::{
    Compressor, DictionaryScratch, DisplayDictionary, dictionary_hash, finalize_display_dictionary,
};

use crate::DISPLAY_DIAGNOSTIC_LARGE_FRAME_BYTES;
use crate::display::credit::{DemandStamp, DisplayAdmission, PreparedDemand};
use crate::display::encoder::{
    chunk_snapshot_frame, mark_presentation_continues, patch_stream_header, stamp_display_demand,
};
use crate::display::planner::{
    BatchPartitionPlan, CarrierDeliveryQuote, ContentClass, ContentEvidence, DictionaryClass,
    ExecutionLane, GlobalDisplayPlanningModel, PeerPlanningSnapshot, PlannedRow, PlannerWorkspace,
    PlanningContext, Representation, choose_after_compression, content_class_by_bytes,
    encoded_record_cost_us, fec_recovery_shard_count, group_close_cost_us, plan_batch_partitions,
    should_attempt_compression as planner_should_attempt_compression,
};
use crate::display::policy::{DisplayPolicy, DisplayWorkload, compute_display_workload};
use crate::network::peer::ReliablePayload;
use crate::network::protocol::*;
use crate::perf_timing::{
    DisplaySendStamps, FlushStart, PerfEgressSnapshot, PerfTimingTracker, encode_perf_egress,
    encode_perf_timing_batch,
};
use crate::perf_trace::{self, TraceEvent, TraceToken};
use crate::pty::{
    BufferPool, CapturedRow, DisplayRowRequest, PendingDisplayDamage, PendingRowDamage,
    RowCaptureScratch, TerminalState,
};
use crate::session::liveness::{send_heartbeat_if_due, send_resume_repair_end_if_complete};
use crate::session::policy::SessionPolicy;
use crate::transport::{
    record_send_outcome, send_display_wire_on_transport, transport_send_reliable_with_fallback,
    transport_try_send_maintenance_reliable_with_fallback,
};
#[cfg(test)]
use crate::webtransport::DATAGRAM_SEND_BUFFER_BYTES;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct PreparedPhysicalDatagramPlan {
    /// Every path whose carrier bytes and receiver slot were reserved for this
    /// data frame. The primary preserves latency-ranked send order.
    data_paths: SentPaths,
    data_primary: Option<PeerTransport>,
    /// Per-path evidence controller that required two physical copies for this
    /// singleton. Kept separate from their representation: the second copy is
    /// either another bit in `data_paths` (cross-carrier) or `replica_path`
    /// (same carrier). ACK provenance and probe cadence must not depend on that
    /// encoding detail.
    k1_protection_path: Option<PeerTransport>,
    /// Same-path k=1 protection selected from attributable loss evidence.
    replica_path: Option<PeerTransport>,
    /// Optional evidence probe, admitted only after the complete logical
    /// prefix and all required protection have been reserved.
    probe_path: Option<PeerTransport>,
    /// FEC parity paths, carried only by the final member of a protected group.
    repair_paths: SentPaths,
    repair_primary: Option<PeerTransport>,
}

pub(crate) struct PreparedDisplayDatagram {
    seq: u32,
    frame_id: u32,
    raw_bytes: usize,
    encoded_rows: u16,
    utility: DisplayUtility,
    header_signal: u128,
    /// A pooled buffer: taken from the flush's `PrepareBuffers::frames` when the
    /// frame is encoded and returned there once the burst has sealed it.
    frame: Vec<u8>,
    rows: SentRows,
    /// Whether the compression path actually ran for this datagram. Only
    /// attempted frames update the achieved-ratio posterior.
    compression_attempted: bool,
    /// Class of the rows the frame carries, from their summed census; the
    /// class whose ratio posterior this frame's achieved compression feeds.
    content_class: ContentClass,
    /// Parity for the group this datagram closes, computed on the CPU worker
    /// into a pooled buffer that returns to the pool once the shard is sealed.
    precomputed_fec_repair: Option<Vec<u8>>,
    /// Exact post-encode physical admission, embedded in the pooled prepared
    /// record rather than allocated as a parallel per-burst plan vector.
    physical_plan: PreparedPhysicalDatagramPlan,
}
// One complete owner-loop cohort fits without pushing planning/compression
// back onto that loop. Each peer owns at most one in-flight request.
const DISPLAY_PREPARE_QUEUE_DEPTH: usize = DISPLAY_PEERS_PER_FLUSH;
const DISPLAY_ASYNC_PREPARE_MIN_ROWS: usize = 2;
const DISPLAY_BULK_PREPARE_MIN_ROWS: usize = 8;

#[inline]
fn display_prepare_is_interactive(row_count: usize) -> bool {
    (DISPLAY_ASYNC_PREPARE_MIN_ROWS..DISPLAY_BULK_PREPARE_MIN_ROWS).contains(&row_count)
}

#[derive(Clone, Copy)]
struct DisplayCompressionPolicy {
    terminal_rows: u16,
    chunk_target_bytes: usize,
    snapshot_target_bytes: usize,
    backpressure_score: u32,
    recently_interactive: bool,
    fit_relay_critical_datagram: bool,
    /// Content-conditioned snapshots captured while the owner holds the peer.
    /// The planner prices every candidate span with the profile of the class
    /// its summed census selects, and each emitted batch feeds its evidence
    /// back into that same class, so a compressible text tail cannot inherit a
    /// high-entropy color prefix's ratio merely because both encoded sizes
    /// occupy the same bucket. Class never cuts a batch; only cost does.
    planning_profiles: [PeerPlanningSnapshot; 3],
    planning_context: PlanningContext,
    execution_lane: ExecutionLane,
}

/// One selected row as captured for a flush: the immutable cells that will go
/// on the wire, the acknowledged baseline they are diffed against, and the two
/// facts the batcher reads per row — its delivery domain and its encoded size.
/// Capture never produces a row that encodes to zero bytes.
#[derive(Clone)]
struct DisplayPrepareRow {
    request: DisplayRowRequest,
    sent: CapturedRow,
    baseline: Arc<[CellRepr]>,
    baseline_revision: u64,
    utility: DisplayUtility,
    encoded_size: usize,
    encoding: CellEncoding,
    content: ContentEvidence,
    /// The columns this row's entry carries, found once at capture.
    span: RowSpan,
}

/// Where a row entry starts and how many cells it carries; no cells is a row
/// with nothing to send.
#[derive(Clone, Copy, Default)]
struct RowSpan {
    left: u16,
    cells: u16,
}

/// Frame buffers one `PrepareBuffers` keeps parked between flushes.
///
/// A batch emits at most one record per viewport row. Each protected group
/// needs at least two data records and owns one parity buffer, even when that
/// buffer contains two recovery shards. Retain enough slots for that complete
/// maximum burst; fitting needs only one additional raw/compressed candidate
/// beside the accepted prefix. Payload capacity grows only when used.
const DISPLAY_FRAME_POOL_DEPTH: usize =
    merkur_codec::MAX_TERMINAL_ROWS + merkur_codec::MAX_TERMINAL_ROWS / 2;

/// Everything a flush fills: captured rows in, prepared datagrams out, and the
/// frame buffers those datagrams are encoded into.
///
/// The set rides the request to the prepare thread and the completion back,
/// and returns to `DisplayPrepareWorker::spare` once the burst is on the wire,
/// so a steady offloaded flush allocates none of it. `frames` is the pool both
/// arms encode into: the thread takes its frames, compressed outputs and
/// repairs from it while it prepares the burst, the owner loop returns them as
/// the burst seals each one, and the pool travels with the pair — the round
/// trip the request already makes is the recycle channel. The inline arm
/// borrows a set the same way and recycles it in the same turn.
struct PrepareBuffers {
    rows: Vec<DisplayPrepareRow>,
    datagrams: Vec<PreparedDisplayDatagram>,
    frames: BufferPool,
}

impl Default for PrepareBuffers {
    fn default() -> Self {
        Self {
            rows: Vec::new(),
            datagrams: Vec::new(),
            frames: BufferPool::new(DISPLAY_FRAME_POOL_DEPTH),
        }
    }
}

/// Retained batching state for one packer: the prepare thread owns one beside
/// its `Compressor`, the owner loop one on `DisplayScratch` for the inline arm.
/// `batches` is drained into datagrams by every caller, so it never carries
/// state between flushes — only capacity.
#[derive(Default)]
pub(crate) struct PrepareScratch {
    batches: Vec<PackedBatch>,
    planner: GlobalDisplayPlanningModel,
    partition: BatchPartitionPlan,
    planner_workspace: PlannerWorkspace,
    #[cfg(test)]
    partition_time: Duration,
    #[cfg(test)]
    first_partition_time: Duration,
    #[cfg(test)]
    largest_partition_time: Duration,
    #[cfg(test)]
    partition_calls: usize,
    #[cfg(test)]
    first_partition_gain_us: f64,
    #[cfg(test)]
    first_partition_gap_us: f64,
    /// Comparison experiments are absent from production builds. The shipped
    /// path always keeps the measured adaptive replan.
    #[cfg(test)]
    experiment: PackingExperiment,
}

#[cfg(test)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum PackingExperiment {
    #[default]
    Adaptive,
    FirstPartition,
    WholeSpan,
}

#[cfg(test)]
#[derive(Clone, Copy)]
struct OriginalAdmissionTiming {
    first: Option<Instant>,
    last: Option<Instant>,
    originals: usize,
}

#[cfg(test)]
std::thread_local! {
    // Captured once when a comparison creates its worker. Thread-local rather
    // than process-global so unrelated parallel correctness tests cannot
    // silently change another worker's packing policy.
    static TEST_PACKING_EXPERIMENT: std::cell::Cell<PackingExperiment> = const { std::cell::Cell::new(PackingExperiment::Adaptive) };
    // Enabled only by the actual-owner experiment. These timestamps bracket
    // successful original submission returns, not QUIC transit or pixels.
    static TEST_ORIGINAL_ADMISSION_TIMING: std::cell::Cell<Option<OriginalAdmissionTiming>> = const { std::cell::Cell::new(None) };
}

/// A packed batch: its wire payload, the rows it carries for ACK provenance,
/// the encoded row count, and the delivery domain it belongs to.
type PackedBatch = (BatchPayload, SentRows, u16, DisplayUtility);

#[derive(Clone, Copy, Debug)]
struct PreparedDisplayTiming {
    flush_started_at: Instant,
    flush_owner: crate::perf_timing::owner::OwnerStamp,
    selection_finished_at: Instant,
    prepare_queued_at: Instant,
    prepare_started_at: Instant,
    prepare_finished_at: Instant,
    compression_time: Duration,
    #[cfg(test)]
    partition_time: Duration,
    #[cfg(test)]
    first_partition_time: Duration,
    #[cfg(test)]
    largest_partition_time: Duration,
    #[cfg(test)]
    partition_calls: usize,
    #[cfg(test)]
    first_partition_gain_us: f64,
    #[cfg(test)]
    first_partition_gap_us: f64,
    #[cfg(test)]
    allocations: crate::edge_tunnel::test_allocations::Tally,
}

struct DisplayPrepareRequest {
    token: u64,
    prepare_epoch: u64,
    prepare_epoch_fence: Arc<AtomicU64>,
    submitted_at: Instant,
    /// Present only while a browser requested fine-grained attribution. The
    /// worker carries these monotonic boundaries, and the owner's accounts at
    /// the flush's start, back to the owner so a record closes after actual
    /// carrier submission rather than at queue admission.
    perf_flush_started_at: Option<FlushStart>,
    generation: u32,
    display_revision: u64,
    completed_sync_update_epoch: u64,
    start_seq: u32,
    start_frame_id: u32,
    /// This flush was clipped to the carrier's current free datagram budget,
    /// so more independently applicable rows are already known to follow.
    presentation_continues: bool,
    /// Captured while `last_row_advertised_input_seq` still names the last
    /// row-bearing frame actually admitted to a carrier. Only a one-row cursor
    /// delta causally answering new input may bypass presentation hold.
    causal_input_advanced: bool,
    input_seq: u32,
    header_signal: u128,
    header_changed: bool,
    header: FrameHeader,
    /// `rows` filled by capture, `datagrams` empty, both taken from the pool.
    buffers: PrepareBuffers,
    compression: DisplayCompressionPolicy,
    /// Exact acknowledged dictionary visible when the owner admitted this
    /// request. Keeping the Arc alive lets the worker compress without copying
    /// the 16 KiB dictionary and gives completion admission an identity fence.
    compression_dictionary: Option<Arc<DisplayDictionary>>,
    burst_group_max_size: usize,
    summary: DisplayFlushSummary,
}

struct SnapshotPeerPlan {
    peer_id: Arc<str>,
    prepare_epoch: u64,
    prepare_epoch_fence: Arc<AtomicU64>,
    profile: PeerPlanningSnapshot,
    context: PlanningContext,
}

struct SnapshotPrepareRequest {
    token: u64,
    submitted_at: Instant,
    display_revision: u64,
    completed_sync_update_epoch: u64,
    cols: u16,
    rows: u16,
    header_signal: u128,
    content_class: ContentClass,
    snapshot: Vec<u8>,
    snapshot_grid: Vec<CellRepr>,
    snapshot_graphics: Vec<Option<GraphicsVersion>>,
    row_hashes: Vec<u64>,
    peers: Vec<SnapshotPeerPlan>,
}

/// Earliest-deadline ordering for the single prepare thread. These are
/// priorities, not holds: a request never waits for its deadline, the worker
/// merely serves the one whose deadline is nearest first, so an interactive
/// delta overtakes a queued snapshot or passive-viewer redraw.
const PREPARE_PRIORITY_INTERACTIVE_MS: u64 = 1;
const PREPARE_PRIORITY_NORMAL_MS: u64 = 10;

impl SnapshotPrepareRequest {
    #[inline]
    fn deadline_at(&self) -> Instant {
        self.submitted_at + Duration::from_millis(PREPARE_PRIORITY_NORMAL_MS)
    }
}

pub(crate) struct SnapshotPrepareCompletion {
    token: u64,
    submitted_at: Instant,
    cpu_time: Duration,
    display_revision: u64,
    completed_sync_update_epoch: u64,
    cols: u16,
    rows: u16,
    header_signal: u128,
    content_class: ContentClass,
    snapshot: Vec<u8>,
    snapshot_grid: Vec<CellRepr>,
    snapshot_graphics: Vec<Option<GraphicsVersion>>,
    row_hashes: Vec<u64>,
    raw_chunks: Vec<Vec<u8>>,
    compressed_chunks: Vec<Option<Vec<u8>>>,
    compression_attempted: Vec<bool>,
    peers: Vec<SnapshotPeerPlan>,
}

impl DisplayPrepareRequest {
    #[inline]
    fn is_current(&self) -> bool {
        self.prepare_epoch_fence.load(Ordering::Acquire) == self.prepare_epoch
    }

    fn deadline_at(&self) -> Instant {
        let critical = self
            .buffers
            .rows
            .iter()
            .any(|row| row.utility == DisplayUtility::Critical);
        self.submitted_at
            + if critical || self.compression.recently_interactive {
                Duration::from_millis(PREPARE_PRIORITY_INTERACTIVE_MS)
            } else {
                Duration::from_millis(PREPARE_PRIORITY_NORMAL_MS)
            }
    }

    fn utility_rank(&self) -> u8 {
        if self
            .buffers
            .rows
            .iter()
            .any(|row| row.utility == DisplayUtility::Critical)
        {
            0
        } else {
            1
        }
    }
}

impl SnapshotPeerPlan {
    #[inline]
    fn is_current(&self) -> bool {
        self.prepare_epoch_fence.load(Ordering::Acquire) == self.prepare_epoch
    }
}

const MAX_INTERACTIVE_PREPARE_STREAK: u8 = 4;
const MAX_DELTA_PREPARE_STREAK: u8 = 4;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct PrepareFairness {
    consecutive_interactive: u8,
    consecutive_deltas: u8,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PrepareSelection {
    Delta(usize),
    Snapshot(usize),
}

impl PrepareFairness {
    fn record_delta(&mut self, lane: ExecutionLane) {
        self.consecutive_deltas = self.consecutive_deltas.saturating_add(1);
        if lane == ExecutionLane::Interactive {
            self.consecutive_interactive = self.consecutive_interactive.saturating_add(1);
        } else {
            self.consecutive_interactive = 0;
        }
    }

    fn record_snapshot(&mut self) {
        self.consecutive_deltas = 0;
        // Preserve the interactive streak. If both a snapshot and an old bulk
        // repaint waited behind four cursors, the snapshot gets one bounded
        // recovery slot and the bulk repaint is forced on the following turn.
    }
}

fn select_prepare_work(
    pending: &[DisplayPrepareRequest],
    pending_snapshots: &[SnapshotPrepareRequest],
    fairness: PrepareFairness,
    delta_output_has_room: bool,
    snapshot_output_has_room: bool,
) -> Option<PrepareSelection> {
    let delta = delta_output_has_room
        .then(|| {
            pending.iter().enumerate().min_by(|(_, left), (_, right)| {
                left.deadline_at()
                    .cmp(&right.deadline_at())
                    .then_with(|| left.utility_rank().cmp(&right.utility_rank()))
            })
        })
        .flatten();
    let bulk = delta_output_has_room
        .then(|| {
            pending
                .iter()
                .enumerate()
                .filter(|(_, request)| request.compression.execution_lane == ExecutionLane::Bulk)
                .min_by_key(|(_, request)| request.deadline_at())
        })
        .flatten();
    let snapshot = snapshot_output_has_room
        .then(|| {
            pending_snapshots
                .iter()
                .enumerate()
                .min_by_key(|(_, request)| request.deadline_at())
        })
        .flatten();

    if fairness.consecutive_deltas >= MAX_DELTA_PREPARE_STREAK
        && let Some((index, _)) = snapshot
    {
        return Some(PrepareSelection::Snapshot(index));
    }
    if fairness.consecutive_interactive >= MAX_INTERACTIVE_PREPARE_STREAK
        && let Some((index, _)) = bulk
    {
        return Some(PrepareSelection::Delta(index));
    }
    match (delta, snapshot) {
        (Some((delta_index, delta_request)), Some((snapshot_index, snapshot_request))) => {
            if snapshot_request.deadline_at() < delta_request.deadline_at() {
                Some(PrepareSelection::Snapshot(snapshot_index))
            } else {
                Some(PrepareSelection::Delta(delta_index))
            }
        }
        (Some((index, _)), None) => Some(PrepareSelection::Delta(index)),
        (None, Some((index, _))) => Some(PrepareSelection::Snapshot(index)),
        (None, None) => None,
    }
}

/// Keep one lane from filling the other lane's pending slots. Scheduling
/// fairness only helps requests the scheduler can see: draining interactive
/// arrivals into every newly freed slot otherwise strands a bulk request in
/// its channel indefinitely, before the four-job fairness rule can inspect it.
fn drain_prepare_lane(
    pending: &mut ArrayVec<DisplayPrepareRequest, { 2 * DISPLAY_PREPARE_QUEUE_DEPTH }>,
    receiver: &crossbeam_channel::Receiver<DisplayPrepareRequest>,
    lane: ExecutionLane,
    open: &mut bool,
) -> bool {
    let mut lane_len = pending
        .iter()
        .filter(|request| request.compression.execution_lane == lane)
        .count();
    let mut progressed = false;
    while *open && lane_len < DISPLAY_PREPARE_QUEUE_DEPTH && !pending.is_full() {
        match receiver.try_recv() {
            Ok(request) => {
                debug_assert_eq!(request.compression.execution_lane, lane);
                pending.push(request);
                lane_len += 1;
                progressed = true;
            }
            Err(crossbeam_channel::TryRecvError::Empty) => break,
            Err(crossbeam_channel::TryRecvError::Disconnected) => {
                *open = false;
                break;
            }
        }
    }
    progressed
}

fn forward_prepared_completion<T>(
    pending: &mut VecDeque<T>,
    destination: &mpsc::Sender<T>,
) -> Result<bool, ()> {
    let Some(completion) = pending.pop_front() else {
        return Ok(false);
    };
    match destination.try_send(completion) {
        Ok(()) => Ok(true),
        Err(mpsc::error::TrySendError::Full(completion)) => {
            pending.push_front(completion);
            Ok(false)
        }
        Err(mpsc::error::TrySendError::Closed(_)) => Err(()),
    }
}

struct DictionaryPrepareRequest {
    token: u64,
    display_revision: u64,
    header: FrameHeader,
    rows: Vec<CapturedRow>,
}

pub(crate) struct DictionaryPrepareCompletion {
    token: u64,
    display_revision: u64,
    cpu_time: Duration,
    source: Arc<[u8]>,
    hash: u32,
}

pub(crate) struct DisplayPrepareCompletion {
    token: u64,
    submitted_at: Instant,
    cpu_time: Duration,
    perf_timing: Option<PreparedDisplayTiming>,
    generation: u32,
    display_revision: u64,
    completed_sync_update_epoch: u64,
    start_seq: u32,
    start_frame_id: u32,
    next_seq: u32,
    next_frame_id: u32,
    dictionary_class: DictionaryClass,
    /// Retained only when at least one prepared frame actually references it.
    /// Dictionary-free completions remain independent of dictionary rotation.
    compression_dictionary: Option<Arc<DisplayDictionary>>,
    /// The request's buffers, back: `rows` still carries every captured
    /// baseline, which is the completion's identity fence, and `datagrams`
    /// carries the burst.
    buffers: PrepareBuffers,
    summary: DisplayFlushSummary,
}

#[cfg(test)]
impl DisplayPrepareCompletion {
    /// How many datagrams this completion carries.
    ///
    /// Exposed for the deterministic display simulator, which needs proof that
    /// a flush actually built frames: an assertion that only checks damage was
    /// cleared passes just as happily against a pipeline that emitted nothing.
    pub(crate) fn datagram_count(&self) -> usize {
        self.buffers.datagrams.len()
    }
}

/// Spare `PrepareBuffers` the owner loop keeps: one per lane slot, so a full
/// lane plus a completion draining behind it never leaves a flush without a
/// pair to take.
const DISPLAY_PREPARE_SPARE_BUFFERS: usize = 2 * DISPLAY_PREPARE_QUEUE_DEPTH;

/// The owner loop's handle on the two preparation threads.
///
/// `merkur-display-prepare` schedules both delta lanes and cohort-shared
/// snapshots by deadline, with row utility breaking equal delta deadlines;
/// `merkur-display-dict` finalizes compression dictionaries. They are
/// separate threads because the two workloads have nothing in common but a
/// CPU: a dictionary finalize is milliseconds of speculative work, while a
/// display preparation job is on a browser's time-to-applied path. Sharing one
/// thread meant a dictionary build that had been picked up first ran to
/// completion ahead of every display job queued behind it, and a build parked
/// on a full completion channel stalled display preparation outright.
pub(crate) struct DisplayPrepareWorker {
    interactive_tx: crossbeam_channel::Sender<DisplayPrepareRequest>,
    bulk_tx: crossbeam_channel::Sender<DisplayPrepareRequest>,
    snapshot_tx: crossbeam_channel::Sender<SnapshotPrepareRequest>,
    /// One slot. A dictionary is a whole-screen capture, so a second request
    /// behind an unfinished one would only describe an older screen than the
    /// one the next flush can capture; `schedule_dictionary_prepare_if_due`
    /// skips the capture entirely while the slot is occupied.
    dictionary_tx: crossbeam_channel::Sender<DictionaryPrepareRequest>,
    next_token: u64,
    dictionary_in_flight: Option<u64>,
    dictionary_ready: Option<DictionaryPrepareCompletion>,
    /// Emptied `PrepareBuffers` waiting for the next flush; see `take_buffers`.
    spare: Vec<PrepareBuffers>,
    /// The network simulator prepares on the owner loop, at the top of each
    /// turn, so a completion's arrival is ordered by simulated time and not by
    /// a thread's (`crate::sim`).
    #[cfg(merkur_sim)]
    lanes: PrepareLanes,
    #[cfg(merkur_sim)]
    dictionaries: DictionaryLane,
}

impl DisplayPrepareWorker {
    /// Runs every queued preparation, as the two threads would have by now.
    #[cfg(merkur_sim)]
    pub(crate) fn run_inline(&mut self) {
        self.lanes.run_inline();
        self.dictionaries.run_inline();
    }

    fn next_token(&mut self) -> u64 {
        self.next_token = self.next_token.wrapping_add(1).max(1);
        self.next_token
    }

    /// A pair of emptied buffers for one flush, keeping whatever capacity the
    /// last flush that used them grew to. A pool miss builds an empty pair,
    /// which only happens while the pool is warming.
    fn take_buffers(&mut self) -> PrepareBuffers {
        self.spare.pop().unwrap_or_default()
    }

    /// Return a flush's buffers once nothing references them. Cleared here so
    /// the row captures' `Arc`s are released now rather than on the next take;
    /// the `BufferPool::put` shape, bounded the same way. A burst that never
    /// went out — a completion nobody claimed, a fenced one — still hands its
    /// frames back to the pool rather than the allocator.
    fn recycle(&mut self, mut buffers: PrepareBuffers) {
        buffers.rows.clear();
        for datagram in buffers.datagrams.drain(..) {
            buffers.frames.put(datagram.frame);
            if let Some(repair) = datagram.precomputed_fec_repair {
                buffers.frames.put(repair);
            }
        }
        if self.spare.len() < DISPLAY_PREPARE_SPARE_BUFFERS {
            self.spare.push(buffers);
        }
    }

    /// Frame buffers parked across every spare set, for the oracle that proves
    /// a burst returns each one it took.
    #[cfg(test)]
    pub(crate) fn parked_frame_buffers(&self) -> usize {
        self.spare
            .iter()
            .map(|buffers| buffers.frames.parked())
            .sum()
    }

    /// Fence both queued/running dictionary work and a completion waiting for
    /// the next flush. The dictionary thread may still return the old token,
    /// but `finish_dictionary_prepare` will reject it by identity.
    fn invalidate_dictionary_preparation(&mut self) {
        self.dictionary_in_flight = None;
        self.dictionary_ready = None;
    }

    /// Whether a dictionary build this owner still wants is outstanding.
    ///
    /// Exposed for the deterministic display simulator, which waits on this
    /// instead of polling the completion channel: a build that has been
    /// submitted but not finished is the one state a `try_recv` drain cannot
    /// tell apart from "nothing was submitted".
    #[cfg(test)]
    pub(crate) fn has_dictionary_prepare_in_flight(&self) -> bool {
        self.dictionary_in_flight.is_some()
    }
}

pub(crate) fn start_display_prepare_worker() -> (
    DisplayPrepareWorker,
    mpsc::Receiver<DisplayPrepareCompletion>,
    mpsc::Receiver<SnapshotPrepareCompletion>,
    mpsc::Receiver<DictionaryPrepareCompletion>,
) {
    #[cfg(test)]
    let experiment = TEST_PACKING_EXPERIMENT.get();
    let (interactive_tx, interactive_rx) =
        crossbeam_channel::bounded::<DisplayPrepareRequest>(DISPLAY_PREPARE_QUEUE_DEPTH);
    let (bulk_tx, bulk_rx) =
        crossbeam_channel::bounded::<DisplayPrepareRequest>(DISPLAY_PREPARE_QUEUE_DEPTH);
    let (snapshot_tx, snapshot_rx) =
        crossbeam_channel::bounded::<SnapshotPrepareRequest>(DISPLAY_PREPARE_QUEUE_DEPTH);
    let (dictionary_tx, dictionary_rx) = crossbeam_channel::bounded::<DictionaryPrepareRequest>(1);
    let (completion_tx, completion_rx) = mpsc::channel(DISPLAY_PREPARE_QUEUE_DEPTH);
    let (snapshot_completion_tx, snapshot_completion_rx) =
        mpsc::channel(DISPLAY_PREPARE_QUEUE_DEPTH);
    // Not one slot: a build fenced mid-flight by `invalidate_dictionary_preparation`
    // still returns its (rejected) completion, and the owner loop may have
    // submitted the live replacement before it drained that one. Capacity for
    // both keeps the dictionary thread off the owner loop's heels.
    let (dictionary_completion_tx, dictionary_completion_rx) =
        mpsc::channel(DISPLAY_PREPARE_QUEUE_DEPTH);
    let channels = PrepareChannels {
        interactive_rx,
        bulk_rx,
        snapshot_rx,
        completion_tx,
        snapshot_completion_tx,
    };
    #[cfg(not(merkur_sim))]
    {
        thread::Builder::new()
            .name("merkur-display-prepare".to_owned())
            .spawn(move || {
                #[cfg(test)]
                let lanes = {
                    let mut lanes = PrepareLanes::new(channels);
                    lanes.scratch.experiment = experiment;
                    lanes
                };
                #[cfg(not(test))]
                let lanes = PrepareLanes::new(channels);
                lanes.run();
            })
            .expect("display preparation worker must start");
        thread::Builder::new()
            .name("merkur-display-dict".to_owned())
            .spawn(move || DictionaryLane::new(dictionary_rx, dictionary_completion_tx).run())
            .expect("display dictionary worker must start");
    }
    (
        DisplayPrepareWorker {
            interactive_tx,
            bulk_tx,
            snapshot_tx,
            dictionary_tx,
            next_token: 0,
            dictionary_in_flight: None,
            dictionary_ready: None,
            spare: Vec::with_capacity(DISPLAY_PREPARE_SPARE_BUFFERS),
            #[cfg(merkur_sim)]
            lanes: PrepareLanes::new(channels),
            #[cfg(merkur_sim)]
            dictionaries: DictionaryLane::new(dictionary_rx, dictionary_completion_tx),
        },
        completion_rx,
        snapshot_completion_rx,
        dictionary_completion_rx,
    )
}

/// The preparation lane's ends of its channels.
struct PrepareChannels {
    interactive_rx: crossbeam_channel::Receiver<DisplayPrepareRequest>,
    bulk_rx: crossbeam_channel::Receiver<DisplayPrepareRequest>,
    snapshot_rx: crossbeam_channel::Receiver<SnapshotPrepareRequest>,
    completion_tx: mpsc::Sender<DisplayPrepareCompletion>,
    snapshot_completion_tx: mpsc::Sender<SnapshotPrepareCompletion>,
}

/// `merkur-display-prepare`'s state between turns: the requests it has taken
/// from the lanes, the completions the owner has not yet taken, and its
/// compression state.
struct PrepareLanes {
    channels: PrepareChannels,
    compressor: Compressor,
    fec_encoder: crate::display::fec::FecEncoder,
    scratch: PrepareScratch,
    pending: ArrayVec<DisplayPrepareRequest, { 2 * DISPLAY_PREPARE_QUEUE_DEPTH }>,
    pending_snapshots: ArrayVec<SnapshotPrepareRequest, DISPLAY_PREPARE_QUEUE_DEPTH>,
    completed: VecDeque<DisplayPrepareCompletion>,
    completed_snapshots: VecDeque<SnapshotPrepareCompletion>,
    fairness: PrepareFairness,
    interactive_open: bool,
    bulk_open: bool,
    snapshot_open: bool,
}

/// What one turn of the preparation lanes leaves the thread to do.
enum PrepareTurn {
    /// Work moved: take another turn.
    Progressed,
    /// Nothing is held and every lane is open: wait for a request.
    Idle,
    /// Held work waits on a full completion channel or a closing lane.
    Stalled,
    /// Every lane closed with nothing held, or the owner is gone.
    Finished,
}

impl PrepareLanes {
    fn new(channels: PrepareChannels) -> Self {
        Self {
            channels,
            compressor: Compressor::new(),
            fec_encoder: crate::display::fec::FecEncoder::new(),
            scratch: PrepareScratch::default(),
            pending: ArrayVec::new(),
            pending_snapshots: ArrayVec::new(),
            completed: VecDeque::with_capacity(2 * DISPLAY_PREPARE_QUEUE_DEPTH),
            completed_snapshots: VecDeque::with_capacity(DISPLAY_PREPARE_QUEUE_DEPTH),
            fairness: PrepareFairness::default(),
            interactive_open: true,
            bulk_open: true,
            snapshot_open: true,
        }
    }

    #[cfg(not(merkur_sim))]
    #[expect(
        clippy::disallowed_methods,
        reason = "held work waits for room in a Tokio completion channel, which this plain thread cannot block on beside its crossbeam lanes; it polls only while the owner is behind or a lane is closing"
    )]
    fn run(mut self) {
        loop {
            match self.turn() {
                PrepareTurn::Progressed => {}
                PrepareTurn::Idle => self.wait_for_request(),
                // Only output backpressure or partial shutdown reaches here.
                // The retained queues are bounded and lane-local, so a full
                // snapshot consumer cannot stall interactive CPU preparation.
                // Polling is confined to this exceptional state; the idle path
                // blocks with zero wakeups.
                PrepareTurn::Stalled => thread::park_timeout(Duration::from_micros(100)),
                PrepareTurn::Finished => return,
            }
        }
    }

    /// Blocks until a lane yields a request or closes.
    #[cfg(not(merkur_sim))]
    fn wait_for_request(&mut self) {
        crossbeam_channel::select_biased! {
            recv(self.channels.interactive_rx) -> request => match request {
                Ok(request) => self.pending.push(request),
                Err(_) => self.interactive_open = false,
            },
            recv(self.channels.bulk_rx) -> request => match request {
                Ok(request) => self.pending.push(request),
                Err(_) => self.bulk_open = false,
            },
            recv(self.channels.snapshot_rx) -> request => match request {
                Ok(request) => self.pending_snapshots.push(request),
                Err(_) => self.snapshot_open = false,
            },
        }
    }

    /// Every turn the thread would have taken by now, without blocking
    /// (`crate::sim`).
    #[cfg(merkur_sim)]
    fn run_inline(&mut self) {
        loop {
            match self.turn() {
                PrepareTurn::Progressed => {}
                PrepareTurn::Idle => {
                    if !self.take_request() {
                        return;
                    }
                }
                PrepareTurn::Stalled | PrepareTurn::Finished => return,
            }
        }
    }

    /// `wait_for_request`'s lane order, without the wait.
    #[cfg(merkur_sim)]
    fn take_request(&mut self) -> bool {
        use crossbeam_channel::TryRecvError;
        match self.channels.interactive_rx.try_recv() {
            Ok(request) => self.pending.push(request),
            Err(TryRecvError::Disconnected) => self.interactive_open = false,
            Err(TryRecvError::Empty) => match self.channels.bulk_rx.try_recv() {
                Ok(request) => self.pending.push(request),
                Err(TryRecvError::Disconnected) => self.bulk_open = false,
                Err(TryRecvError::Empty) => match self.channels.snapshot_rx.try_recv() {
                    Ok(request) => self.pending_snapshots.push(request),
                    Err(TryRecvError::Disconnected) => self.snapshot_open = false,
                    Err(TryRecvError::Empty) => return false,
                },
            },
        }
        true
    }

    fn turn(&mut self) -> PrepareTurn {
        let mut progressed = false;
        match forward_prepared_completion(&mut self.completed, &self.channels.completion_tx) {
            Ok(forwarded) => progressed |= forwarded,
            Err(()) => return PrepareTurn::Finished,
        }
        match forward_prepared_completion(
            &mut self.completed_snapshots,
            &self.channels.snapshot_completion_tx,
        ) {
            Ok(forwarded) => progressed |= forwarded,
            Err(()) => return PrepareTurn::Finished,
        }

        // With no retained work, wait for a request. Partial channel closure
        // is a shutdown-only state; once observed the bounded nonblocking
        // drains below finish the remaining lanes.
        if self.pending.is_empty()
            && self.pending_snapshots.is_empty()
            && self.completed.is_empty()
            && self.completed_snapshots.is_empty()
            && self.interactive_open
            && self.bulk_open
            && self.snapshot_open
        {
            return PrepareTurn::Idle;
        }

        progressed |= drain_prepare_lane(
            &mut self.pending,
            &self.channels.interactive_rx,
            ExecutionLane::Interactive,
            &mut self.interactive_open,
        );
        progressed |= drain_prepare_lane(
            &mut self.pending,
            &self.channels.bulk_rx,
            ExecutionLane::Bulk,
            &mut self.bulk_open,
        );
        while !self.pending_snapshots.is_full() && self.snapshot_open {
            match self.channels.snapshot_rx.try_recv() {
                Ok(request) => {
                    self.pending_snapshots.push(request);
                    progressed = true;
                }
                Err(crossbeam_channel::TryRecvError::Empty) => break,
                Err(crossbeam_channel::TryRecvError::Disconnected) => {
                    self.snapshot_open = false;
                    break;
                }
            }
        }

        let selection = select_prepare_work(
            &self.pending,
            &self.pending_snapshots,
            self.fairness,
            self.completed.len() < 2 * DISPLAY_PREPARE_QUEUE_DEPTH,
            self.completed_snapshots.len() < DISPLAY_PREPARE_QUEUE_DEPTH,
        );
        if let Some(PrepareSelection::Snapshot(index)) = selection {
            let completion = prepare_snapshot_off_loop(
                self.pending_snapshots.swap_remove(index),
                &mut self.compressor,
                &mut self.scratch.planner,
            );
            self.completed_snapshots.push_back(completion);
            self.fairness.record_snapshot();
            return PrepareTurn::Progressed;
        }
        if let Some(PrepareSelection::Delta(index)) = selection {
            let mut request = self.pending.swap_remove(index);
            let lane = request.compression.execution_lane;
            // The queued higher-utility work is the opportunity cost of
            // occupying this single preparation lane with compression.
            let higher_priority_jobs = self
                .pending
                .iter()
                .filter(|other| other.utility_rank() < request.utility_rank())
                .count();
            request
                .compression
                .planning_context
                .higher_priority_preparation_jobs = higher_priority_jobs;
            let completion = if request.is_current() {
                prepare_display_off_loop(
                    request,
                    &mut self.compressor,
                    &mut self.fec_encoder,
                    &mut self.scratch,
                )
            } else {
                cancelled_display_prepare(request)
            };
            self.completed.push_back(completion);
            self.fairness.record_delta(lane);
            return PrepareTurn::Progressed;
        }

        if self.pending.is_empty()
            && self.pending_snapshots.is_empty()
            && self.completed.is_empty()
            && self.completed_snapshots.is_empty()
            && !self.interactive_open
            && !self.bulk_open
            && !self.snapshot_open
        {
            return PrepareTurn::Finished;
        }
        if progressed {
            PrepareTurn::Progressed
        } else {
            PrepareTurn::Stalled
        }
    }
}

/// `merkur-display-dict`: finalizes each requested dictionary in turn.
struct DictionaryLane {
    requests: crossbeam_channel::Receiver<DictionaryPrepareRequest>,
    completions: mpsc::Sender<DictionaryPrepareCompletion>,
    /// The whole-screen encode buffer outlives every build, so a steady
    /// session finalizes into the same allocation each time.
    frame: Vec<u8>,
    scratch: DictionaryScratch,
}

impl DictionaryLane {
    fn new(
        requests: crossbeam_channel::Receiver<DictionaryPrepareRequest>,
        completions: mpsc::Sender<DictionaryPrepareCompletion>,
    ) -> Self {
        Self {
            requests,
            completions,
            frame: Vec::new(),
            scratch: DictionaryScratch::default(),
        }
    }

    #[cfg(not(merkur_sim))]
    fn run(mut self) {
        while let Ok(request) = self.requests.recv() {
            let completion =
                prepare_dictionary_off_loop(request, &mut self.frame, &mut self.scratch);
            if self.completions.blocking_send(completion).is_err() {
                return;
            }
        }
    }

    /// Every build requested so far (`crate::sim`).
    #[cfg(merkur_sim)]
    fn run_inline(&mut self) {
        while let Ok(request) = self.requests.try_recv() {
            let completion =
                prepare_dictionary_off_loop(request, &mut self.frame, &mut self.scratch);
            match self.completions.try_send(completion) {
                Ok(()) => {}
                Err(mpsc::error::TrySendError::Closed(_)) => return,
                // One build in flight and one fenced is the most the owner
                // ever leaves unread; the channel holds more.
                Err(mpsc::error::TrySendError::Full(_)) => {
                    unreachable!("the dictionary completion channel holds every build in flight")
                }
            }
        }
    }
}

/// Local-only delivery domain. Critical and noncritical data use independent
/// frame ids and FEC groups; Valuable/Ordinary are ordering ranks within the
/// one NonCritical domain, not extra browser-side assemblies.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DisplayUtility {
    Critical,
    NonCritical,
}

impl DisplayUtility {
    #[inline]
    const fn send_intent(self) -> SendIntent {
        match self {
            Self::Critical => SendIntent::Redundant,
            Self::NonCritical => SendIntent::SinglePath,
        }
    }
}

/// Presentation urgency is semantic, not a proxy for packet count.
///
/// A header-only cursor/input fence and the first cursor-row content answering
/// a newly confirmed input need the earliest paint. Everything else — notably
/// one-row TUI writes that happen to leave the cursor on that row — joins the
/// bounded browser presentation transaction so a sequence of drained PTY reads
/// cannot become a visible sweep.
fn presentation_is_coherent(
    batches: &[PackedBatch],
    cursor_row: u16,
    causal_input_advanced: bool,
    presentation_continues: bool,
) -> bool {
    if presentation_continues || batches.len() != 1 {
        return true;
    }
    let (_, sent_rows, encoded_rows, utility) = &batches[0];
    if *encoded_rows == 0 {
        return false;
    }
    !(*encoded_rows == 1
        && *utility == DisplayUtility::Critical
        && causal_input_advanced
        && sent_rows
            .iter()
            .next()
            .is_some_and(|row| row.row == cursor_row))
}

#[inline]
fn take_wrapping_nonzero(cursor: &mut u32) -> u32 {
    let value = *cursor;
    *cursor = cursor.wrapping_add(1);
    if *cursor == 0 {
        *cursor = 1;
    }
    if value == 0 {
        take_wrapping_nonzero(cursor)
    } else {
        value
    }
}

/// The cells a literal row entry carries: the whole row when forced, otherwise
/// the span between the first and last cell that differ from the baseline.
/// `None` when nothing differs — the row would encode to zero bytes.
fn row_span<'a>(
    force_full: bool,
    baseline: &[CellRepr],
    cells: &'a [CellRepr],
) -> Option<(u16, &'a [CellRepr])> {
    if force_full {
        return Some((0, cells));
    }
    let left = baseline
        .iter()
        .zip(cells.iter())
        .position(|(previous, current)| previous != current)?;
    let right_from_end = baseline
        .iter()
        .rev()
        .zip(cells.iter().rev())
        .position(|(previous, current)| previous != current)
        .unwrap_or(0);
    let right = cells.len().saturating_sub(1 + right_from_end);
    Some((left.min(u16::MAX as usize) as u16, &cells[left..=right]))
}

fn captured_row_span(row: &DisplayPrepareRow) -> Option<(u16, &[CellRepr])> {
    let RowSpan { left, cells } = row.span;
    let start = usize::from(left);
    (cells != 0).then(|| (left, &row.sent.cells[start..start + usize::from(cells)]))
}

fn captured_row_encoded_size(row: &DisplayPrepareRow) -> usize {
    row.encoded_size
}

/// Bytes one row entry adds to a frame, computed from borrowed cells so capture
/// can decide whether a row is worth retaining before it clones anything.
fn encoded_row_size(
    request: &DisplayRowRequest,
    baseline: &[CellRepr],
    cells: &[CellRepr],
    baseline_graphics: Option<GraphicsVersion>,
    graphics: &PreparedGraphics,
) -> (usize, CellEncoding, ContentEvidence, RowSpan) {
    row_span(request.force_full, baseline, cells)
        .or_else(|| (baseline_graphics != graphics.version()).then(|| (0, &cells[..1])))
        .map(|(left, cells)| {
            let mut content = ContentEvidence::default();
            content.observe(cells);
            let (bytes, encoding) = plan_cell_encoding(cells);
            (
                ROW_PREFIX_BYTES + bytes + graphics.bytes().len(),
                encoding,
                content,
                RowSpan {
                    left,
                    cells: cells.len() as u16,
                },
            )
        })
        .unwrap_or_default()
}

/// Encode `rows` into `frame` — a pooled buffer, cleared and grown to the
/// frame's exact size — and return the rows it carries as ACK provenance,
/// inline when they fit a datagram batch.
fn encode_captured_rows<'a, I>(header: FrameHeader, rows: I, frame: &mut Vec<u8>) -> SentRows
where
    I: Iterator<Item = &'a DisplayPrepareRow> + Clone,
{
    let (encoded_rows, encoded_row_bytes) =
        rows.clone().fold((0usize, 0usize), |(count, bytes), row| {
            let row_bytes = captured_row_encoded_size(row);
            if row_bytes == 0 {
                (count, bytes)
            } else {
                (count + 1, bytes.saturating_add(row_bytes))
            }
        });
    frame.clear();
    frame.reserve(
        STREAM_HEADER_BYTES
            .saturating_add(FRAME_HEADER_BODY_BYTES)
            .saturating_add(encoded_row_bytes),
    );
    let entries = rows.clone().filter_map(|row| {
        let (left, cells) = captured_row_span(row)?;
        Some(PreparedRowRef {
            graphics: &row.sent.graphics,
            row_index: row.sent.row,
            left,
            cells,
            encoding: row.encoding,
        })
    });
    let mut header = header;
    header.row_count = encoded_rows.min(u16::MAX as usize) as u16;
    encode_prepared_frame_into(frame, &header, entries);
    let mut sent_rows = SentRows::with_capacity(encoded_rows);
    for row in rows.filter(|row| captured_row_encoded_size(row) > 0) {
        sent_rows.push(SentRow::from(&row.sent));
    }
    sent_rows
}

/// Replace `frame` with the compressed form in `compressed` when `used`,
/// returning whichever buffer the frame no longer needs to the pool.
#[inline]
fn choose_compressed_frame(
    frame: Vec<u8>,
    compressed: Vec<u8>,
    used: bool,
    frames: &mut BufferPool,
) -> Vec<u8> {
    if used {
        frames.put(frame);
        compressed
    } else {
        frames.put(compressed);
        frame
    }
}

fn prepare_captured_frame(
    payload: BatchPayload,
    rows: SentRows,
    seq: u32,
    generation: u32,
    input_seq: u32,
    frame_id: u32,
    presentation_id: u32,
    presentation_coherent: bool,
    presentation_end: bool,
    chunk_index: u16,
    chunk_count: u16,
    presentation_member_index: u16,
    presentation_member_count: u16,
    utility: DisplayUtility,
    header_signal: u128,
) -> PreparedDisplayDatagram {
    let BatchPayload {
        mut frame,
        raw_bytes,
        compression,
        content_class,
    } = payload;
    patch_stream_header(
        &mut frame,
        seq,
        generation,
        input_seq,
        frame_id,
        presentation_id,
        presentation_coherent,
        presentation_end,
        chunk_index,
        chunk_count,
        if presentation_coherent {
            presentation_member_index
        } else {
            0
        },
        if presentation_coherent {
            presentation_member_count
        } else {
            0
        },
    )
    .expect("captured display frame must fit the u16 stream body length");
    let encoded_rows = rows.len().min(u16::MAX as usize) as u16;
    let compression_attempted = compression != BatchCompression::NotAttempted;

    PreparedDisplayDatagram {
        seq,
        frame_id,
        raw_bytes,
        encoded_rows,
        utility,
        header_signal,
        frame,
        rows,
        compression_attempted,
        content_class,
        precomputed_fec_repair: None,
        physical_plan: PreparedPhysicalDatagramPlan::default(),
    }
}

/// Fold one attempted datagram's achieved `compressed / raw` into the peer's
/// bounded empirical posterior.
///
/// Only frames that actually reached the compression path may be sampled;
/// `Interactive` frames bypass it by design and would report 1.0 for a decision
/// compression never made.
#[inline]
fn observe_display_compression_outcome(
    peer: &mut PeerDisplayState,
    wire_bytes: usize,
    raw_bytes: usize,
    attempted: bool,
    content_class: ContentClass,
    dictionary_class: DictionaryClass,
) {
    if !attempted || raw_bytes == 0 {
        return;
    }
    let sample = (wire_bytes as f64 / raw_bytes as f64).clamp(0.01, 1.0);
    peer.display_planning
        .observe_ratio(raw_bytes, content_class, dictionary_class, sample);
}

/// A batch as it will ride the wire, together with the size it was encoded from.
///
/// The batcher compresses a batch at the moment it decides that batch's size,
/// because those are the same question: a batch is correctly sized exactly when
/// its compressed form fits a datagram. Carrying `raw_bytes` alongside keeps
/// every downstream consumer — workload classification, the ratio estimate,
/// telemetry — reading the uncompressed size it has always read.
struct BatchPayload {
    frame: Vec<u8>,
    raw_bytes: usize,
    compression: BatchCompression,
    /// Class of the rows the frame carries, from their summed census; the
    /// class whose ratio posterior this frame's achieved compression feeds.
    content_class: ContentClass,
}

/// What the batch-sizing pass already learned about this payload.
///
/// `AttemptedRejected` is materially different from `NotAttempted`: the former
/// means zstd already ran and the post-attempt packet plan selected raw. The
/// subsequent prepare pass cannot make that identical frame more compressible,
/// so retrying only repeats the most expensive part of preparation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BatchCompression {
    NotAttempted,
    AttemptedRejected,
    Compressed,
}

impl BatchPayload {
    #[inline]
    fn plain(frame: Vec<u8>, content_class: ContentClass) -> Self {
        let raw_bytes = frame.len();
        Self {
            frame,
            raw_bytes,
            compression: BatchCompression::NotAttempted,
            content_class,
        }
    }

    #[inline]
    fn len(&self) -> usize {
        self.frame.len()
    }
}

impl BatchCompression {
    #[inline]
    fn from_outcome(outcome: &DisplayCompressionOutcome) -> Self {
        if outcome.used {
            Self::Compressed
        } else if outcome.achieved_ratio.is_some() {
            Self::AttemptedRejected
        } else {
            Self::NotAttempted
        }
    }
}

/// Compress a candidate batch under the same rules the prepare step would use.
///
/// `achieved_ratio: None` means compression did not apply and leaves the frame
/// for the prepare step to handle exactly as before — in particular the
/// `Interactive` bypass and its relay-critical MTU fit. `Some` records that
/// zstd did run, even when the result was not worth retaining.
fn compress_batch_candidate(
    planner: &mut GlobalDisplayPlanningModel,
    compressor: &mut Compressor,
    frame: &[u8],
    encoded_rows: u16,
    interactive_compression_allowed: bool,
    policy: &DisplayCompressionPolicy,
    presentation_workload: DisplayWorkload,
    dictionary: Option<&DisplayDictionary>,
    planned_representation: Representation,
    content_class: ContentClass,
    profile: PeerPlanningSnapshot,
    out: &mut Vec<u8>,
) -> DisplayCompressionOutcome {
    let raw_bytes = frame.len();
    let batch_workload = compute_display_workload(
        raw_bytes,
        policy.terminal_rows,
        encoded_rows,
        policy.chunk_target_bytes,
        policy.snapshot_target_bytes,
        policy.recently_interactive,
        policy.backpressure_score > 0,
    );
    // Workload is a property of the logical terminal mutation, not of the
    // datagram-sized piece currently being evaluated. Without this promotion a
    // cold full-screen redraw is split into one-row candidates first; every
    // candidate then looks "interactive", zstd never gets a cross-row window,
    // and an initial QUIC congestion window visibly delivers the screen in RTT-
    // separated flights. Keep genuinely small interaction uncompressed, but do
    // not let packetization reclassify a bulk presentation as one.
    let workload = if presentation_workload != DisplayWorkload::Interactive
        && batch_workload == DisplayWorkload::Interactive
    {
        presentation_workload
    } else {
        batch_workload
    };
    if workload == DisplayWorkload::Interactive && !interactive_compression_allowed {
        return DisplayCompressionOutcome::NOTHING;
    }
    let dictionary_class = if dictionary.is_some() {
        DictionaryClass::Finalized
    } else {
        DictionaryClass::Plain
    };
    if planned_representation == Representation::Raw {
        return DisplayCompressionOutcome::NOTHING;
    }
    let started = Instant::now();
    let Some(saved_bytes) = compressor.compress_display_frame_into(frame, dictionary, out) else {
        let service_us = started.elapsed().as_secs_f64() * 1_000_000.0;
        planner.observe_sender_service(
            policy.execution_lane,
            raw_bytes,
            content_class,
            dictionary_class,
            service_us,
        );
        return DisplayCompressionOutcome {
            used: false,
            achieved_ratio: Some(1.0),
        };
    };
    let service_us = started.elapsed().as_secs_f64() * 1_000_000.0;
    planner.observe_sender_service(
        policy.execution_lane,
        raw_bytes,
        content_class,
        dictionary_class,
        service_us,
    );
    DisplayCompressionOutcome {
        used: choose_after_compression(
            profile,
            raw_bytes,
            raw_bytes - saved_bytes,
            dictionary_class,
            policy.planning_context,
        ) == Representation::Compressed,
        achieved_ratio: Some(out.len() as f64 / raw_bytes.max(1) as f64),
    }
}

/// Encode one candidate batch, compress it, and split until every piece fits a
/// datagram.
///
/// Returns the `compressed / raw` ratio the batch achieved, so the caller can
/// size the *next* batch from it. That feedback is what lets a repaint converge
/// within a single flush: the first batch is one row wide because no evidence
/// exists yet, and each batch after it packs the larger unit the previous one
/// proved was affordable.
///
/// The split ratio comes from what the batch actually achieved rather than a
/// blind halving, so a mispredicted budget normally costs exactly one
/// correction. In the steady state the estimate is right and this emits one
/// batch per call with no re-encode at all.
fn emit_fitted_batches(
    header: FrameHeader,
    rows: &[DisplayPrepareRow],
    utility: DisplayUtility,
    policy: &DisplayCompressionPolicy,
    profiles: &[PeerPlanningSnapshot; 3],
    presentation_workload: DisplayWorkload,
    dictionary: Option<&DisplayDictionary>,
    compressor: &mut Compressor,
    planner: &mut GlobalDisplayPlanningModel,
    frames: &mut BufferPool,
    out: &mut Vec<PackedBatch>,
    wire_cap: usize,
    planned_representation: Representation,
) -> Option<f64> {
    if rows.is_empty() {
        return None;
    }
    // Classified from exactly these rows. A fitter split re-classifies each
    // half, so a piece's ratio and sender-service evidence land in its own
    // class rather than its parent span's. `profiles` carries the ratios this
    // flush has already learned, so the post-attempt decision sees the same
    // evidence the planner used.
    let content_class = classify_captured_content(rows);
    let profile = profiles[content_class.index()];
    let mut frame = frames.take(0);
    let sent_rows = encode_captured_rows(header, rows.iter(), &mut frame);
    if frame.is_empty() {
        frames.put(frame);
        return None;
    }
    // `encode_captured_rows` leaves the stream header zeroed for the prepare
    // step to stamp, but the compressor refuses any frame that is not marked a
    // display patch. Stamp the one byte it checks; `patch_stream_header` writes
    // the same value again later.
    frame[merkur_codec::DISPLAY_MSG_TYPE_OFFSET] = merkur_codec::MSG_TYPE_DISPLAY_PATCH;
    let raw_bytes = frame.len();
    let encoded_rows = sent_rows.len().min(u16::MAX as usize) as u16;
    let mut compressed = frames.take(0);
    let outcome = compress_batch_candidate(
        planner,
        compressor,
        &frame,
        encoded_rows,
        policy.fit_relay_critical_datagram && utility == DisplayUtility::Critical,
        policy,
        presentation_workload,
        dictionary,
        planned_representation,
        content_class,
        profile,
        &mut compressed,
    );
    let wire_bytes = if outcome.used {
        compressed.len()
    } else {
        raw_bytes
    };

    if wire_bytes <= wire_cap || rows.len() == 1 {
        let payload = BatchPayload {
            frame: choose_compressed_frame(frame, compressed, outcome.used, frames),
            raw_bytes,
            compression: BatchCompression::from_outcome(&outcome),
            content_class,
        };
        out.push((payload, sent_rows, encoded_rows, utility));
        return outcome.achieved_ratio;
    }
    // Too big for one datagram: both buffers go back and the halves re-encode.
    frames.put(frame);
    frames.put(compressed);

    let keep = (rows.len() * wire_cap / wire_bytes).clamp(1, rows.len() - 1);
    let first = emit_fitted_batches(
        header,
        &rows[..keep],
        utility,
        policy,
        profiles,
        presentation_workload,
        dictionary,
        compressor,
        planner,
        frames,
        out,
        wire_cap,
        planned_representation,
    );
    let second = emit_fitted_batches(
        header,
        &rows[keep..],
        utility,
        policy,
        profiles,
        presentation_workload,
        dictionary,
        compressor,
        planner,
        frames,
        out,
        wire_cap,
        planned_representation,
    );
    second.or(first).or(outcome.achieved_ratio)
}

/// Classify the complete captured terminal mutation before it is divided into
/// transport units. Packet-sized classification creates a bootstrap trap: a
/// cold redraw whose individual rows fit the MTU is mistaken for a sequence of
/// latency-sensitive one-row interactions, so no batch ever attempts the
/// cross-row compression that would put the redraw in one QUIC flight.
fn captured_presentation_workload(
    rows: &[DisplayPrepareRow],
    policy: &DisplayCompressionPolicy,
) -> DisplayWorkload {
    let raw_bytes = rows.iter().fold(
        STREAM_HEADER_BYTES + FRAME_HEADER_BODY_BYTES,
        |total, row| total.saturating_add(captured_row_encoded_size(row)),
    );
    compute_display_workload(
        raw_bytes,
        policy.terminal_rows,
        rows.len().min(u16::MAX as usize) as u16,
        policy.chunk_target_bytes,
        policy.snapshot_target_bytes,
        policy.recently_interactive,
        policy.backpressure_score > 0,
    )
}

/// Open FEC group already emitted by adaptive sizing. `pack_captured_rows`
/// replans after each measured compression result, while parity is computed
/// once over the final adjacent output; feeding this exact tail into the next
/// search keeps the two boundaries identical. A reliable jumbo or utility
/// change closes the group, exactly as `fec_group_end` does later.
fn pending_packed_fec_group(
    batches: &[PackedBatch],
    utility: DisplayUtility,
    group_max: usize,
) -> (usize, usize) {
    let mut group_len = 0usize;
    let mut group_max_bytes = 0usize;
    for (payload, _, _, batch_utility) in batches {
        if *batch_utility != utility || payload.len() > DisplayPolicy::DATAGRAM_MAX_PAYLOAD_BYTES {
            group_len = 0;
            group_max_bytes = 0;
            continue;
        }
        group_len += 1;
        group_max_bytes = group_max_bytes.max(payload.len());
        if group_len == group_max.max(1) {
            group_len = 0;
            group_max_bytes = 0;
        }
    }
    (group_len, group_max_bytes)
}

/// Compute parity for every datagram group off the owner loop, marking each
/// covered datagram FEC-protected and hanging the shard on the group's last
/// member for the send loop to emit.
fn precompute_fec_repairs(
    prepared: &mut [PreparedDisplayDatagram],
    group_max: usize,
    generation: u32,
    encoder: &mut crate::display::fec::FecEncoder,
    frames: &mut BufferPool,
) {
    let mut index = 0usize;
    while index < prepared.len() {
        if !uses_display_datagram(&prepared[index]) {
            index += 1;
            continue;
        }
        let group_start = index;
        index = fec_group_end(prepared, group_start, group_max);
        let group = &mut prepared[group_start..index];
        let shard_size = group
            .iter()
            .map(|datagram| datagram.frame.len())
            .max()
            .unwrap_or(0);
        let recovery_shards = fec_recovery_shard_count(group.len(), shard_size);
        if recovery_shards == 0 {
            continue;
        }
        let group_len = group.len();
        for datagram in group.iter_mut() {
            datagram.frame[1] |= DISPLAY_HEADER_FLAG_FEC_PROTECTED;
        }
        let mut payloads = [&[][..]; merkur_fec::FEC_MAX_DATA];
        for (slot, datagram) in payloads.iter_mut().zip(group.iter()) {
            *slot = &datagram.frame;
        }
        let mut repair = frames.take(0);
        if encoder.encode_borrowed_group_into(
            generation,
            group[0].seq,
            &payloads[..group_len],
            recovery_shards,
            &mut repair,
        ) {
            group
                .last_mut()
                .expect("non-empty FEC group")
                .precomputed_fec_repair = Some(repair);
        } else {
            frames.put(repair);
        }
    }
}

/// Seal one parity shard for the datagram lane. Oversize repair is a caller
/// bug: width selection must return zero before encoding a shard that cannot
/// fit, and there is intentionally no reliable repair fallback.
///
/// It used to return `()` and the caller counted an attempt, so
/// `fec_repairs_sent` reported parity the transport had refused — which made
/// coverage under congestion, the one condition parity exists for, both zero
/// and unmeasurable.
#[cfg(test)]
fn send_repair_frame(
    peer: &mut PeerDisplayState,
    repair: &[u8],
    batch_start_seq: u32,
    now_ms: f64,
    budget: &mut DatagramPhysicalBudget,
) -> BudgetedSendResult {
    if repair.len() > DisplayPolicy::DATAGRAM_MAX_PAYLOAD_BYTES {
        return BudgetedSendResult {
            budget_refused: true,
            ..BudgetedSendResult::default()
        };
    }
    let Some(wire) = peer.seal_display_wire(repair) else {
        return BudgetedSendResult::default();
    };
    send_display_wire_budgeted(
        peer,
        &wire,
        now_ms,
        SendIntent::LatencySensitive,
        PhysicalDatagramKind::Repair { batch_start_seq },
        budget,
    )
}

fn send_reserved_repair_frame(
    peer: &mut PeerDisplayState,
    repair: &[u8],
    admission: ReservedPathSend,
    now_ms: f64,
    spare_budget: &mut DatagramPhysicalBudget,
) -> BudgetedSendResult {
    let expected_wire_len = sealed_display_datagram_wire_len(repair.len());
    if repair.len() > DisplayPolicy::DATAGRAM_MAX_PAYLOAD_BYTES {
        release_reserved_paths(spare_budget, admission.paths, expected_wire_len);
        return BudgetedSendResult::default();
    }
    let Some(wire) = peer.seal_display_wire(repair) else {
        release_reserved_paths(spare_budget, admission.paths, expected_wire_len);
        return BudgetedSendResult::default();
    };
    debug_assert_eq!(wire.len(), expected_wire_len);
    send_reserved_paths(peer, &wire, admission, now_ms, spare_budget)
}

/// Pack captured rows into datagram-sized batches, compressing each batch as it
/// is sized, and promote one batch to the Critical domain when the header
/// changed but no cursor-row batch is there to carry it.
///
/// This is the one batcher. The owner loop's inline arm and the prepare
/// thread both call it, so an offloaded flush and a synchronous one chunk the
/// same screen identically. `rows` must be ranked by `prioritize_display_rows`
/// and free of zero-size rows — capture guarantees the latter — and the output
/// lands in `scratch.batches`, cleared first, for the caller to drain.
///
/// Rows are packed against their *compressed* size. A datagram carries
/// compressed bytes, so the dynamic program uses the peer/content/dictionary
/// ratio posterior when it compares candidate partitions.
fn pack_captured_rows(
    rows: &[DisplayPrepareRow],
    header: FrameHeader,
    policy: &DisplayCompressionPolicy,
    dictionary: Option<&DisplayDictionary>,
    header_changed: bool,
    compressor: &mut Compressor,
    scratch: &mut PrepareScratch,
    frames: &mut BufferPool,
) {
    let presentation_workload = captured_presentation_workload(rows, policy);
    let PrepareScratch {
        batches,
        planner,
        partition,
        planner_workspace,
        #[cfg(test)]
        partition_time,
        #[cfg(test)]
        first_partition_time,
        #[cfg(test)]
        largest_partition_time,
        #[cfg(test)]
        partition_calls,
        #[cfg(test)]
        first_partition_gain_us,
        #[cfg(test)]
        first_partition_gap_us,
        #[cfg(test)]
        experiment,
    } = scratch;
    // The comparison arm deliberately freezes the first partition, not just
    // the ratio prior. Actual fitting may split any selected span, but it does
    // not move subsequent row boundaries or infer new compression evidence.
    #[cfg(test)]
    let adaptive_refinement = *experiment != PackingExperiment::FirstPartition;
    #[cfg(not(test))]
    let adaptive_refinement = true;
    #[cfg(test)]
    {
        *partition_time = Duration::ZERO;
        *first_partition_time = Duration::ZERO;
        *largest_partition_time = Duration::ZERO;
        *partition_calls = 0;
        *first_partition_gain_us = 0.0;
        *first_partition_gap_us = 0.0;
    }
    batches.clear();
    let mut batch_start = 0usize;
    #[cfg(test)]
    if *experiment == PackingExperiment::WholeSpan
        && presentation_workload != DisplayWorkload::Interactive
    {
        pack_whole_span_candidate(rows, header, dictionary, compressor, batches, frames);
        // Only the partition differs. Header promotion below is shared with
        // production, including changes with no captured cursor-row damage.
        batch_start = rows.len();
    }
    let cap = DisplayPolicy::FEC_PROTECTED_DATAGRAM_PAYLOAD_BYTES;
    let header_overhead = STREAM_HEADER_BYTES + FRAME_HEADER_BODY_BYTES;
    let mut local_profiles = policy.planning_profiles;
    while batch_start < rows.len() {
        // A domain is one utility run. Content class is a property of each
        // planned span, never of a boundary between rows: the planner
        // classifies every candidate span from its summed census and prices it
        // with that class's profile. Cutting at every class change was measured
        // on 2026-09-07 to emit one datagram per row for mixed shell output.
        let utility = rows[batch_start].utility;
        let mut domain_end = batch_start;
        while domain_end < rows.len() && rows[domain_end].utility == utility {
            domain_end += 1;
        }

        let domain = &rows[batch_start..domain_end];
        let mut planned_rows = [PlannedRow::EMPTY; merkur_codec::MAX_TERMINAL_ROWS];
        for (slot, row) in planned_rows.iter_mut().zip(domain) {
            *slot = PlannedRow {
                bytes: captured_row_encoded_size(row),
                class: row.content.class(),
            };
        }
        let dictionary_class = if dictionary.is_some() {
            DictionaryClass::Finalized
        } else {
            DictionaryClass::Plain
        };
        let mut planned_start = 0usize;
        let mut partition_origin = 0usize;
        let mut partition_cursor = 0usize;
        let mut partition_valid = false;
        while planned_start < domain.len() {
            let mut planning_context = policy.planning_context;
            let (open_group_len, open_group_max) =
                pending_packed_fec_group(batches, utility, planning_context.fec_group_size);
            planning_context.initial_fec_group_len = open_group_len;
            planning_context.initial_fec_group_max_bytes = open_group_max;
            if !partition_valid {
                #[cfg(test)]
                let partition_started = Instant::now();
                partition_origin = planned_start;
                partition_cursor = 0;
                plan_batch_partitions(
                    planner,
                    &local_profiles,
                    policy.execution_lane,
                    dictionary_class,
                    planning_context,
                    &planned_rows[planned_start..domain.len()],
                    header_overhead,
                    cap,
                    planner_workspace,
                    partition,
                );
                #[cfg(test)]
                {
                    let elapsed = partition_started.elapsed();
                    *partition_time += elapsed;
                    if *partition_calls == 0 {
                        *first_partition_time = elapsed;
                        *first_partition_gain_us = partition.refinement_gain_us;
                        *first_partition_gap_us = partition.relaxed_gap_us;
                    }
                    *largest_partition_time = (*largest_partition_time).max(elapsed);
                    *partition_calls += 1;
                }
            }
            let (planned_offset, planned_representation) = partition
                .get(partition_cursor)
                .expect("every nonempty row domain has a feasible partition");
            let planned_end = partition_origin + planned_offset;
            let content_class = classify_captured_content(&domain[planned_start..planned_end]);
            let emitted_before = batches.len();
            let actual_ratio = emit_fitted_batches(
                header,
                &domain[planned_start..planned_end],
                utility,
                policy,
                &local_profiles,
                presentation_workload,
                dictionary,
                compressor,
                planner,
                frames,
                batches,
                cap,
                planned_representation,
            );
            let predicted_raw_bytes = header_overhead
                + planned_rows[planned_start..planned_end]
                    .iter()
                    .map(|row| row.bytes)
                    .sum::<usize>();
            if adaptive_refinement && let Some(ratio) = actual_ratio {
                local_profiles[content_class.index()]
                    .observe_actual_ratio(predicted_raw_bytes, ratio);
            }
            // An exact raw record changes neither representation evidence nor
            // the planned FEC width. Consume the already-optimal suffix rather
            // than re-solving it after every singleton (cubic work on jumbo
            // color rows). Any compression attempt, split or size discrepancy
            // invalidates the suffix and triggers the full measured replan.
            partition_cursor += 1;
            partition_valid = planned_representation == Representation::Raw
                && actual_ratio.is_none()
                && batches.len() == emitted_before + 1
                && batches[emitted_before].0.len() == predicted_raw_bytes
                && partition.get(partition_cursor).is_some();
            #[cfg(test)]
            if !adaptive_refinement {
                partition_valid = partition.get(partition_cursor).is_some();
            }
            planned_start = planned_end;
        }
        batch_start = domain_end;
    }

    // Cursor/mode state lives in every frame header but is not part of row
    // hashes. When it changed alongside only non-cursor rows, promote an
    // existing packet instead of allocating a header-only seq. Choosing the
    // smallest batch bounds redundant bytes; moving it to the front keeps the
    // remaining Valuable-first row order intact. If every batch is jumbo, the
    // smallest guaranteed-reliable batch is promoted and sent first.
    if header_changed
        && !batches
            .iter()
            .any(|(_, _, _, utility)| *utility == DisplayUtility::Critical)
    {
        let promotion_index = batches
            .iter()
            .enumerate()
            .min_by_key(|(_, (payload, _, _, _))| payload.len())
            .map(|(index, _)| index);
        if let Some(index) = promotion_index {
            batches[..=index].rotate_right(1);
            batches[0].3 = DisplayUtility::Critical;
        }
    }
}

/// Test-only measured contender, not a production policy. Cross-row compression
/// runs once per largest legal independent display body; no ratio extrapolation,
/// discarded scout, multi-chunk delta or new reliable lane is introduced.
#[cfg(test)]
fn pack_whole_span_candidate(
    rows: &[DisplayPrepareRow],
    header: FrameHeader,
    dictionary: Option<&DisplayDictionary>,
    compressor: &mut Compressor,
    out: &mut Vec<PackedBatch>,
    frames: &mut BufferPool,
) {
    let mut start = 0;
    while start < rows.len() {
        let mut body_bytes = FRAME_HEADER_BODY_BYTES;
        let mut end = start;
        let mut utility = DisplayUtility::NonCritical;
        while end < rows.len() && body_bytes + rows[end].encoded_size <= usize::from(u16::MAX) {
            body_bytes += rows[end].encoded_size;
            if rows[end].utility == DisplayUtility::Critical {
                utility = DisplayUtility::Critical;
            }
            end += 1;
        }
        assert!(end > start, "a legitimate single row fits a display body");
        let mut raw = frames.take(STREAM_HEADER_BYTES + body_bytes);
        let sent = encode_captured_rows(header, rows[start..end].iter(), &mut raw);
        assert_eq!(raw.len(), STREAM_HEADER_BYTES + body_bytes);
        raw[merkur_codec::DISPLAY_MSG_TYPE_OFFSET] = merkur_codec::MSG_TYPE_DISPLAY_PATCH;
        let raw_bytes = raw.len();
        let mut compressed = frames.take(0);
        let used = compressor
            .compress_display_frame_into(&raw, dictionary, &mut compressed)
            .is_some();
        let frame = choose_compressed_frame(raw, compressed, used, frames);
        out.push((
            BatchPayload {
                frame,
                raw_bytes,
                compression: if used {
                    BatchCompression::Compressed
                } else {
                    BatchCompression::AttemptedRejected
                },
                content_class: classify_captured_content(&rows[start..end]),
            },
            sent,
            (end - start) as u16,
            utility,
        ));
        start = end;
    }
}

fn prepare_display_off_loop(
    request: DisplayPrepareRequest,
    compressor: &mut Compressor,
    fec_encoder: &mut crate::display::fec::FecEncoder,
    scratch: &mut PrepareScratch,
) -> DisplayPrepareCompletion {
    #[cfg(test)]
    if request.perf_flush_started_at.is_some() {
        crate::edge_tunnel::test_allocations::begin_thread();
    }
    let cpu_started_at = Instant::now();
    let DisplayPrepareRequest {
        token,
        prepare_epoch: _,
        prepare_epoch_fence: _,
        submitted_at,
        perf_flush_started_at,
        generation,
        display_revision,
        completed_sync_update_epoch,
        start_seq,
        start_frame_id,
        presentation_continues,
        causal_input_advanced,
        input_seq,
        header_signal,
        header_changed,
        header,
        mut buffers,
        compression,
        compression_dictionary,
        burst_group_max_size,
        mut summary,
    } = request;
    compressor.begin_timing(perf_flush_started_at.is_some());
    let mut next_seq = start_seq;
    let mut next_frame_id = start_frame_id;
    let dictionary = compression_dictionary.as_deref();
    let PrepareBuffers {
        rows,
        datagrams,
        frames,
        ..
    } = &mut buffers;
    pack_captured_rows(
        rows,
        header,
        &compression,
        dictionary,
        header_changed,
        compressor,
        scratch,
        frames,
    );

    // One datagram, one independently applicable frame. Presentation identity
    // is deliberately separate: all transport units prepared by this flush
    // may be committed together by the browser without making application,
    // ACK, loss, or repair depend on the group.
    let batch_count = scratch.batches.len();
    assert!(batch_count <= merkur_codec::MAX_TERMINAL_ROWS);
    let presentation_id = {
        let mut cursor = start_frame_id;
        take_wrapping_nonzero(&mut cursor)
    };
    let presentation_coherent = header.presentation_coherent
        || presentation_is_coherent(
            &scratch.batches,
            header.cursor_row,
            causal_input_advanced,
            presentation_continues,
        );
    for (index, (payload, sent_rows, _, utility)) in scratch.batches.drain(..).enumerate() {
        let seq = take_wrapping_nonzero(&mut next_seq);
        datagrams.push(prepare_captured_frame(
            payload,
            sent_rows,
            seq,
            generation,
            input_seq,
            take_wrapping_nonzero(&mut next_frame_id),
            presentation_id,
            presentation_coherent,
            index + 1 == batch_count && !presentation_continues,
            0,
            1,
            index as u16,
            u16::try_from(batch_count).expect("prepared display member count fits u16"),
            utility,
            header_signal,
        ));
    }
    precompute_fec_repairs(
        datagrams,
        burst_group_max_size,
        generation,
        fec_encoder,
        frames,
    );

    let prepare_finished_at = Instant::now();
    let compression_time = compressor.take_timed_compression();

    if perf_log_enabled() {
        summary.perf_wire_bytes = datagrams.iter().map(|frame| frame.frame.len() + 1).sum();
    }
    let dictionary_class = if compression_dictionary.is_some() {
        DictionaryClass::Finalized
    } else {
        DictionaryClass::Plain
    };
    let compression_dictionary = retain_referenced_dictionary(datagrams, compression_dictionary);
    #[cfg(test)]
    let allocations =
        perf_flush_started_at.map(|_| crate::edge_tunnel::test_allocations::end_thread());
    DisplayPrepareCompletion {
        token,
        submitted_at,
        cpu_time: prepare_finished_at.saturating_duration_since(cpu_started_at),
        perf_timing: perf_flush_started_at.map(|flush| PreparedDisplayTiming {
            flush_started_at: flush.at,
            flush_owner: flush.owner,
            selection_finished_at: submitted_at,
            prepare_queued_at: submitted_at,
            prepare_started_at: cpu_started_at,
            prepare_finished_at,
            compression_time,
            #[cfg(test)]
            partition_time: scratch.partition_time,
            #[cfg(test)]
            first_partition_time: scratch.first_partition_time,
            #[cfg(test)]
            largest_partition_time: scratch.largest_partition_time,
            #[cfg(test)]
            partition_calls: scratch.partition_calls,
            #[cfg(test)]
            first_partition_gain_us: scratch.first_partition_gain_us,
            #[cfg(test)]
            first_partition_gap_us: scratch.first_partition_gap_us,
            #[cfg(test)]
            allocations: allocations.expect("instrumented prepare allocation scope"),
        }),
        generation,
        display_revision,
        completed_sync_update_epoch,
        start_seq,
        start_frame_id,
        next_seq,
        next_frame_id,
        dictionary_class,
        compression_dictionary,
        buffers,
        summary,
    }
}

fn cancelled_display_prepare(request: DisplayPrepareRequest) -> DisplayPrepareCompletion {
    let DisplayPrepareRequest {
        token,
        prepare_epoch: _,
        prepare_epoch_fence: _,
        submitted_at,
        perf_flush_started_at: _,
        generation,
        display_revision,
        completed_sync_update_epoch,
        start_seq,
        start_frame_id,
        presentation_continues: _,
        causal_input_advanced: _,
        input_seq: _,
        header_signal: _,
        header_changed: _,
        header: _,
        buffers,
        compression: _,
        compression_dictionary,
        burst_group_max_size: _,
        summary,
    } = request;
    DisplayPrepareCompletion {
        token,
        submitted_at,
        cpu_time: Duration::ZERO,
        perf_timing: None,
        generation,
        display_revision,
        completed_sync_update_epoch,
        start_seq,
        start_frame_id,
        next_seq: start_seq,
        next_frame_id: start_frame_id,
        dictionary_class: if compression_dictionary.is_some() {
            DictionaryClass::Finalized
        } else {
            DictionaryClass::Plain
        },
        compression_dictionary,
        buffers,
        summary,
    }
}

fn prepare_snapshot_off_loop(
    request: SnapshotPrepareRequest,
    compressor: &mut Compressor,
    planner: &mut GlobalDisplayPlanningModel,
) -> SnapshotPrepareCompletion {
    let cpu_started_at = Instant::now();
    let SnapshotPrepareRequest {
        token,
        submitted_at,
        display_revision,
        completed_sync_update_epoch,
        cols,
        rows,
        header_signal,
        content_class,
        snapshot,
        snapshot_grid,
        snapshot_graphics,
        row_hashes,
        mut peers,
    } = request;
    peers.retain(SnapshotPeerPlan::is_current);
    let mut raw_chunks = chunk_snapshot_frame(&snapshot)
        .expect("owner-produced snapshot must be valid and row-chunkable");
    let chunk_count = u16::try_from(raw_chunks.len()).expect("snapshot chunk count must fit u16");
    for (chunk_index, raw) in raw_chunks.iter_mut().enumerate() {
        patch_stream_header(
            raw,
            0,
            0,
            0,
            0,
            0,
            false,
            true,
            chunk_index as u16,
            chunk_count,
            0,
            0,
        )
        .expect("snapshot chunk must fit the stream body length");
    }
    let mut compressed_chunks = Vec::with_capacity(raw_chunks.len());
    let mut compression_attempted = Vec::with_capacity(raw_chunks.len());
    for raw in &raw_chunks {
        let should_attempt = peers.iter().any(|peer| {
            planner_should_attempt_compression(
                planner,
                peer.profile,
                ExecutionLane::Bulk,
                raw.len(),
                content_class,
                DictionaryClass::Plain,
                peer.context,
            )
        });
        compression_attempted.push(should_attempt);
        if !should_attempt {
            compressed_chunks.push(None);
            continue;
        }
        let started = Instant::now();
        let mut compressed = Vec::new();
        let saved = compressor.compress_display_frame_into(raw, None, &mut compressed);
        planner.observe_sender_service(
            ExecutionLane::Bulk,
            raw.len(),
            content_class,
            DictionaryClass::Plain,
            started.elapsed().as_secs_f64() * 1_000_000.0,
        );
        compressed_chunks.push(saved.map(|_| compressed));
    }
    SnapshotPrepareCompletion {
        token,
        submitted_at,
        cpu_time: cpu_started_at.elapsed(),
        display_revision,
        completed_sync_update_epoch,
        cols,
        rows,
        header_signal,
        content_class,
        snapshot,
        snapshot_grid,
        snapshot_graphics,
        row_hashes,
        raw_chunks,
        compressed_chunks,
        compression_attempted,
        peers,
    }
}

/// Finalize one dictionary source on the `merkur-display-dict` thread.
///
/// `frame` is that thread's retained whole-screen encode buffer; it is cleared
/// and refilled here, never reallocated once it has seen the largest screen.
fn prepare_dictionary_off_loop(
    request: DictionaryPrepareRequest,
    frame: &mut Vec<u8>,
    scratch: &mut DictionaryScratch,
) -> DictionaryPrepareCompletion {
    let cpu_started_at = Instant::now();
    let mut header = request.header;
    header.row_count = request.rows.len().min(u16::MAX as usize) as u16;
    let entries = request.rows.iter().map(|row| PreparedRowRef {
        encoding: plan_cell_encoding(&row.cells).1,
        graphics: &row.graphics,
        row_index: row.row,
        left: 0,
        cells: &row.cells,
    });
    frame.clear();
    encode_prepared_frame_into(frame, &header, entries);

    // All splitting, grouping, finalizing and hashing happen on this worker.
    let body_start = (STREAM_HEADER_BYTES + merkur_codec::FRAME_HEADER_BODY_BYTES).min(frame.len());
    let source: Arc<[u8]> = Arc::from(finalize_display_dictionary(
        &frame[body_start..],
        header.row_count,
        scratch,
    ));
    let hash = dictionary_hash(&source);
    DictionaryPrepareCompletion {
        token: request.token,
        display_revision: request.display_revision,
        cpu_time: cpu_started_at.elapsed(),
        source,
        hash,
    }
}

pub(crate) fn finish_dictionary_prepare(
    completion: DictionaryPrepareCompletion,
    worker: &mut DisplayPrepareWorker,
) {
    if worker.dictionary_in_flight != Some(completion.token) {
        return;
    }
    trace!(
        revision = completion.display_revision,
        cpu_us = completion.cpu_time.as_micros(),
        bytes = completion.source.len(),
        "display dictionary prepared off owner loop"
    );
    worker.dictionary_in_flight = None;
    worker.dictionary_ready = Some(completion);
}

/// Revoke this peer's owners created while its dictionary was ready.
///
/// Per-peer display work cannot identify a worker request's compression choice
/// until completion, so it is invalidated conservatively. A queued
/// dictionary-bearing burst has already reserved sequence numbers and crosses
/// a generation boundary instead of leaving an unfillable gap. Dictionary-free
/// paced work survives. The shared dictionary-source worker is fenced by the
/// readiness owner only when no ready peer remains.
pub(crate) fn fence_display_dictionary_withdrawal(peer: &mut PeerDisplayState) {
    peer.cancel_display_prepare();
    if peer.dictionary.has_wire_state() {
        peer.next_generation();
    } else {
        peer.dictionary.reset();
    }
}

/// Discard a shared source preparation only when a readiness withdrawal leaves
/// no eligible consumer. A remaining ready peer can safely consume the same
/// screen-derived bytes, so preserving the work avoids a cross-peer rebuild.
pub(crate) fn fence_dictionary_preparation_without_consumers(
    worker: &mut DisplayPrepareWorker,
    peers: &PeerMap,
) {
    let has_consumer = peers
        .values()
        .any(|peer| peer.authenticated && peer.is_e2e_ready() && peer.display_dictionary_ready);
    if !has_consumer {
        worker.invalidate_dictionary_preparation();
    }
}

#[inline]
fn uses_display_datagram(datagram: &PreparedDisplayDatagram) -> bool {
    datagram.frame.len() <= DisplayPolicy::DATAGRAM_MAX_PAYLOAD_BYTES
}

fn retain_referenced_dictionary(
    prepared: &[PreparedDisplayDatagram],
    dictionary: Option<Arc<DisplayDictionary>>,
) -> Option<Arc<DisplayDictionary>> {
    dictionary.filter(|_| prepared_references_dictionary(prepared))
}

fn prepared_references_dictionary(prepared: &[PreparedDisplayDatagram]) -> bool {
    prepared.iter().any(|datagram| {
        datagram
            .frame
            .get(merkur_codec::DISPLAY_HEADER_FLAGS_OFFSET)
            .is_some_and(|flags| {
                flags & merkur_codec::DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD_DICT != 0
            })
    })
}

/// Keep the current prompt context and shell's newest output ahead of ordinary
/// full-screen updates. The cursor row itself is always Critical.
const VALUABLE_PROMPT_ROWS_ABOVE_CURSOR: u16 = 2;
const VALUABLE_BOTTOM_ROW_COUNT: u16 = 3;

#[derive(Clone, Copy)]
struct DisplayFlushSummary {
    selected_count: u32,
    force_full_count: u32,
    perf_wire_bytes: usize,
    input_seq: u32,
    /// Captured when this logical redraw starts. Reading `last_input_at_ms`
    /// again after cooperative yields can pair this old `input_seq` with a
    /// newer keystroke and corrupt the latency profile.
    input_to_flush_ms: Option<f64>,
}

/// Persistent round-robin position for bounded display work. Peer ids are
/// sorted before applying the cursor, so HashMap iteration order and
/// remove/reinsert operations cannot starve a peer.
///
/// `eligible` and `selected` are scratch retained across flushes: the sorted
/// runnable cohort a damaged flush rebuilds, and the peers the current flush
/// serves in wire order. Both are cleared and refilled in place, and every id
/// held here is a refcount bump on the peer map's own key, so a steady flush
/// selects its cohort without allocating.
#[derive(Default)]
pub(crate) struct DisplayFlushCursor {
    after_peer_id: Option<Arc<str>>,
    deferred_peer_ids: VecDeque<Arc<str>>,
    eligible: Vec<Arc<str>>,
    selected: Vec<Arc<str>>,
}

impl DisplayFlushCursor {
    pub(crate) fn has_deferred_peers(
        &self,
        peers: &PeerMap,
        header_signal: u128,
        current_row_hashes: &[u64],
        now_ms: f64,
    ) -> bool {
        self.deferred_peer_ids.iter().any(|peer_id| {
            peers.get(peer_id).is_some_and(|peer| {
                peer_has_runnable_display_work(
                    peer,
                    false,
                    header_signal,
                    current_row_hashes,
                    now_ms,
                )
            })
        })
    }
}

/// Begin a fresh display generation before the nonzero u32 sequence would wrap.
///
/// The browser's cell/header ordering is intentionally simple numeric ordering
/// within one generation. Reusing low sequence numbers in that generation would
/// therefore make otherwise-valid frames look stale. One flush can allocate at
/// most one sequence per terminal row plus a reliable/header frame (the terminal
/// row cap is 256), so reserving u16::MAX sequence numbers leaves ample room for
/// the flush immediately before this guard is observed.
const DISPLAY_SEQ_ROLLOVER_AT: u32 = u32::MAX - u16::MAX as u32;

fn display_seq_rollover_required(peer: &PeerDisplayState) -> bool {
    peer.next_datagram_seq >= DISPLAY_SEQ_ROLLOVER_AT
}

fn arm_display_seq_rollover_snapshots(peers: &mut PeerMap) -> usize {
    let mut armed = 0usize;
    for peer in peers.values_mut() {
        if peer.needs_snapshot || !display_seq_rollover_required(peer) {
            continue;
        }
        // Snapshot transmission calls next_generation(), which resets every
        // display ordering/cache field before any low sequence can be emitted.
        // Until that reliable snapshot succeeds, needs_snapshot excludes this
        // peer from the delta loop.
        peer.needs_snapshot = true;
        peer.snapshot_retry_at_ms = 0.0;
        armed += 1;
    }
    armed
}

/// Latency-debugging harness. `MERKUR_PERF_LOG=1` logs one line per flush
/// that sent datagrams: the latest input seq, the time from that peer's last
/// input arrival to flush start, and the rows/bytes sent. Correlated with the
/// browser's input_seq-stamped perf events, this splits daemon-interior time
/// from network+apply time without any wire change. Off by default.
pub(crate) fn perf_log_enabled() -> bool {
    use std::sync::atomic::{AtomicI32, Ordering};
    static ENABLED: AtomicI32 = AtomicI32::new(-1);
    let enabled = ENABLED.load(Ordering::Relaxed);
    if enabled < 0 {
        let parsed = i32::from(std::env::var("MERKUR_PERF_LOG").is_ok_and(|s| s == "1"));
        ENABLED.store(parsed, Ordering::Relaxed);
        return parsed == 1;
    }
    enabled == 1
}

/// Aggregate peer-work cap for one owner-loop display turn. Per-peer pacing
/// limits are not sufficient when many viewers become runnable together.
const DISPLAY_PEERS_PER_FLUSH: usize = 8;
/// CPU/wall-clock fairness budget across peers in one owner turn. Work for one
/// peer remains atomic with respect to Noise/display ownership, but after that
/// peer the loop yields so PTY input, ACK/NACK, and teardown events can run.
const DISPLAY_OWNER_TURN_BUDGET_MS: f64 = 2.0;

#[inline]
fn display_owner_should_defer(
    peers_offered: usize,
    snapshots_offered: usize,
    elapsed_ms: f64,
) -> bool {
    peers_offered > 0 && (snapshots_offered > 0 || elapsed_ms >= DISPLAY_OWNER_TURN_BUDGET_MS)
}

/// Requeue `cursor.selected[from..]` — the peers this turn's budget did not
/// reach — at the head of the deferred cohort, keeping their wire order.
fn defer_display_peers(peers: &mut PeerMap, cursor: &mut DisplayFlushCursor, from: usize) {
    for peer_id in cursor.selected.drain(from..).rev() {
        if let Some(peer) = peers.get_mut(&peer_id) {
            // Terminal-wide dirty ranges are cleared once per flush. Preserve a
            // peer-local edge so this viewer compares against the newest hashes
            // on the immediate follow-up turn.
            if !peer.needs_snapshot {
                peer.needs_full_diff = true;
            }
        }
        cursor.deferred_peer_ids.push_front(peer_id);
    }
}

/// Select the peers this flush serves into `cursor.selected`, in wire order.
fn take_display_peer_batch(
    peers: &mut PeerMap,
    has_display_damage: bool,
    header_signal: u128,
    current_row_hashes: &[u64],
    cursor: &mut DisplayFlushCursor,
    now_ms: f64,
) {
    cursor.selected.clear();
    if !has_display_damage && !cursor.deferred_peer_ids.is_empty() {
        while cursor.selected.len() < DISPLAY_PEERS_PER_FLUSH {
            let Some(peer_id) = cursor.deferred_peer_ids.pop_front() else {
                break;
            };
            if peers.get(&peer_id).is_some_and(|peer| {
                peer_has_runnable_display_work(
                    peer,
                    false,
                    header_signal,
                    current_row_hashes,
                    now_ms,
                )
            }) {
                cursor.selected.push(peer_id);
            }
        }
        if let Some(last) = cursor.selected.last() {
            cursor.after_peer_id = Some(Arc::clone(last));
        }
        if !cursor.selected.is_empty() || !cursor.deferred_peer_ids.is_empty() {
            return;
        }
    }

    // New terminal damage supersedes any older deferred cohort: every peer
    // needs the newest terminal state, including peers already serviced for the
    // older state. Rebuild one exact round-robin cohort instead of allowing
    // duplicate cursor cycles to turn suppression windows into a busy loop.
    cursor.deferred_peer_ids.clear();
    cursor.eligible.clear();
    cursor.eligible.extend(
        peers
            .iter()
            .filter(|(_, peer)| {
                peer_has_runnable_display_work(
                    peer,
                    has_display_damage,
                    header_signal,
                    current_row_hashes,
                    now_ms,
                )
            })
            .map(|(id, _)| Arc::clone(id)),
    );
    cursor.eligible.sort_unstable();

    if cursor.eligible.is_empty() {
        cursor.after_peer_id = None;
        return;
    }

    let start = cursor
        .after_peer_id
        .as_ref()
        .and_then(|after| cursor.eligible.iter().position(|peer_id| peer_id > after))
        .unwrap_or(0);
    cursor.eligible.rotate_left(start);
    let served = cursor.eligible.len().min(DISPLAY_PEERS_PER_FLUSH);
    // Hash collection clears the terminal-wide dirty bits below. Preserve a
    // per-peer edge for every deferred delta so the next immediate turn
    // cannot strand that peer's copy.
    for peer_id in cursor.eligible.drain(served..) {
        if let Some(peer) = peers.get_mut(&peer_id)
            && !peer.needs_snapshot
        {
            peer.needs_full_diff = true;
        }
        cursor.deferred_peer_ids.push_back(peer_id);
    }
    cursor.selected.append(&mut cursor.eligible);
    if let Some(last) = cursor.selected.last() {
        cursor.after_peer_id = Some(Arc::clone(last));
    }
}

/// Release every peer's egress hold but `keep`'s. An input ACK already admitted
/// on a held carrier waits only for its own peer's header-only or echo frame
/// (see `send_input_ack`): never another peer's display work, a snapshot, a hash
/// pass over many rows, or a jumbo frame.
fn release_egress_holds_except(peers: &mut PeerMap, keep: Option<&str>) {
    for (peer_id, peer) in peers.iter_mut() {
        if keep != Some(&**peer_id) {
            peer.egress_hold = None;
        }
    }
}

/// Release every egress hold: the owner turn's end, whatever it flushed.
pub(crate) fn release_egress_holds(peers: &mut PeerMap) {
    release_egress_holds_except(peers, None);
}

pub(crate) async fn flush_display(
    terminal: &mut TerminalState,
    scratch: &mut DisplayScratch,
    prepare_worker: &mut DisplayPrepareWorker,
    peers: &mut PeerMap,
    clock: &FlushClock,
    cursor: &mut DisplayFlushCursor,
    perf_timing: &mut PerfTimingTracker,
) {
    // A parser pause within a synchronized drain leaves a partial grid. Input
    // ACKs and reliable editor revocation still run in the owner; no snapshot,
    // repair, hash baseline or row capture may publish that partial transaction.
    if terminal.display_commit_pending() {
        return;
    }
    // Destructured once here so the body below borrows exactly the disjoint
    // fields the old parameter list named, and the leaf calls it makes keep
    // taking the narrow references they already took.
    let DisplayScratch {
        buffers,
        compressor,
        current_row_hashes,
        flush_row_capture: flush_row_cache,
        rows: flush_row_scratch,
        prepare: prepare_scratch,
    } = scratch;
    // One read anchors the whole turn. Every later `now_ms` in this function is
    // either this value or a fresh read from the same clock, so there is no
    // second time source to disagree with it.
    let now_ms = clock.now_ms();
    let flush_started_ms = now_ms;
    // Kept only to attribute real CPU in `perf_timing`, which must stay real
    // even under simulation. Sampled once per flush rather than per peer, and
    // only when a browser has actually asked for the attribution.
    let flush_started_at = perf_timing.is_enabled().then(FlushStart::now);
    // Captures persist across flushes and are replaced only for dirty rows.
    // This makes the hash pass the one terminal-to-CellRepr conversion point
    // and lets retries/dictionary builds reuse unchanged rows without touching
    // the terminal grid.
    flush_row_cache.retain(|row, _| *row < terminal.rows);
    let damage = terminal.pending_display_damage();
    let has_display_damage = damage.any;

    // A snapshot is the protocol boundary for display sequence rollover.
    // Arm it before snapshot selection so this same flush either sends the
    // next generation's reliable snapshot or emits no more deltas for the peer.
    arm_display_seq_rollover_snapshots(peers);

    // Selection runs before this turn's hash refresh below, so this is the same
    // vector the owner loop's own scheduling check just read. That is the point:
    // a row the previous flush clipped is already behind the baseline here.
    take_display_peer_batch(
        peers,
        has_display_damage,
        terminal.current_display_header_signal(),
        &current_row_hashes[..],
        cursor,
        now_ms,
    );

    // A held ACK waits for the hash pass only when it is bounded: no damage, or
    // the cursor row alone, as a keystroke's echo is.
    if damage.rows == PendingRowDamage::Coherent {
        release_egress_holds(peers);
    }
    refresh_flush_row_captures(
        terminal,
        current_row_hashes,
        &mut flush_row_scratch.dirty_captures,
        flush_row_cache,
    );

    // The cohort is read in place: an id is borrowed from the cursor for the
    // turn it is served, never cloned out of it, and the tail the budget does
    // not reach is drained straight back into the deferred queue.
    let mut peers_offered = 0usize;
    let mut snapshots_offered = 0usize;
    let mut next_peer = 0usize;
    while let Some(peer_id) = cursor.selected.get(next_peer) {
        next_peer += 1;
        // One read serves both the turn budget and this peer's timestamp. They
        // were two reads of the same instant, separated by an increment.
        let peer_now_ms = clock.now_ms();
        if display_owner_should_defer(
            peers_offered,
            snapshots_offered,
            peer_now_ms - flush_started_ms,
        ) {
            defer_display_peers(peers, cursor, next_peer - 1);
            break;
        }
        peers_offered = peers_offered.saturating_add(1);
        release_egress_holds_except(peers, Some(peer_id));
        let snapshot_due = peers
            .get(peer_id)
            .is_some_and(|peer| peer_snapshot_due(peer, peer_now_ms));
        if snapshot_due {
            release_egress_holds(peers);
            schedule_pending_snapshots(
                terminal,
                buffers,
                peers,
                peer_now_ms,
                current_row_hashes,
                prepare_worker,
            );
            snapshots_offered = snapshots_offered.saturating_add(1);
            continue;
        }
        let can_send_delta = peers.get(peer_id).is_some_and(|peer| {
            peer.authenticated
                && peer.is_e2e_ready()
                && peer.awaiting_resume_until_ms.is_none()
                && !peer.needs_snapshot
                && peer.display_cache.initialized
        });
        if !can_send_delta {
            continue;
        }
        send_peer_datagram_delta_with_worker(
            terminal,
            compressor,
            prepare_worker,
            prepare_scratch,
            peers,
            peer_id,
            peer_now_ms,
            current_row_hashes,
            flush_row_scratch,
            flush_row_cache,
            has_display_damage,
            perf_timing,
            flush_started_at,
        );

        if let Some(peer) = peers.get_mut(peer_id) {
            // Its header-only or echo frame, if the flush owed one, is admitted.
            peer.egress_hold = None;
            peer.dictionary.observe_flush();
            send_editor_anchor_if_changed(terminal, peer, peer_now_ms);
        }

        // One clock read shared by both tail sends. The owner-turn budget is
        // measured in clock reads, so taking a second one here would shorten
        // every turn by a peer.
        let tail_now_ms = clock.now_ms();

        // Before the heartbeat: the browser is holding its paint on this, and
        // the digest is a second frame on the same lane.
        send_resume_repair_end_if_complete(peers, peer_id, tail_now_ms).await;

        send_heartbeat_if_due(peers, peer_id, current_row_hashes, tail_now_ms).await;
    }
    // A deferred or undeliverable peer's hold ends here, before the tail below.
    release_egress_holds(peers);

    // After every capture this turn made, so an id a row just carried is
    // defined in the same turn. Order against the datagrams is immaterial: the
    // browser resolves an id only when the user points at it.
    let links_now_ms = clock.now_ms();
    for peer in peers.values_mut() {
        send_link_table_if_changed(terminal, peer, links_now_ms);
    }

    install_prepared_dictionaries_if_due(prepare_worker, peers, clock.now_ms());
    schedule_dictionary_prepare_if_due(
        terminal,
        prepare_worker,
        peers,
        &mut flush_row_scratch.capture,
        flush_row_cache,
    );
}

/// The flush's hash pass: refresh the per-row hash baseline for every dirty
/// row and replace those rows' captures in the per-flush cache.
///
/// This is the one terminal-to-`CellRepr` conversion point of a flush; every
/// consumer downstream — selection, capture, dictionary builds — reads the
/// captures made here rather than the grid. Each capture moves into the cache;
/// its storage comes from the terminal's two-version row pool. Returns how many
/// rows it re-captured, so the simulator's allocation oracle can attribute this
/// stage by name.
pub(crate) fn refresh_flush_row_captures(
    terminal: &mut TerminalState,
    current_row_hashes: &mut Vec<u64>,
    dirty_captures: &mut Vec<CapturedRow>,
    flush_row_cache: &mut HashMap<u16, CapturedRow>,
) -> usize {
    terminal.update_hashes_for_dirty_rows(current_row_hashes, dirty_captures);
    let recaptured = dirty_captures.len();
    for capture in dirty_captures.drain(..) {
        flush_row_cache.insert(capture.row, capture);
    }
    recaptured
}

/// Reused row-selection output. Owned by the daemon owner loop so a steady
/// flush allocates nothing: the vector is cleared and refilled each tick and
/// keeps the capacity of the largest redraw the session has seen.
#[derive(Default)]
pub(crate) struct FlushRowSelection {
    pub(crate) selected_rows: Vec<DisplayRowRequest>,
}

/// Reused row-capture and selection buffers owned by the daemon owner loop.
#[derive(Default)]
pub(crate) struct FlushRowScratch {
    capture: RowCaptureScratch,
    pub(crate) dirty_captures: Vec<CapturedRow>,
    /// Row selection for the peer currently being flushed. Owner-loop-owned so
    /// the steady state reuses one allocation across every peer and tick.
    pub(crate) selection: FlushRowSelection,
}

/// The owner loop's display allocations, held together so the flush chain
/// threads one reference instead of eight parameters. These were separate
/// locals in `run()`, passed down in lists long enough that adding a buffer
/// meant editing every signature between the loop and the encoder.
///
/// They are grouped because they are acquired and lent as a unit: every entry
/// point into the display path needs most of them, and none is meaningful to a
/// caller outside it. They are *not* merged into fewer fields, because their
/// reset lifecycles genuinely differ — two of them carry state between flushes
/// and the rest do not. That difference is the reason there is deliberately no
/// blanket `clear()` or `reset()` here: a single sweep would silently force a
/// full redraw, which is exactly the failure mode this grouping must not
/// introduce. Each field is cleared by the code that owns its cadence.
///
/// The convention, matching `PeerRegistry`: **the flush entry points take
/// `&mut DisplayScratch` and destructure it at the top; leaf helpers that touch
/// a fixed one or two buffers keep explicit parameters**, because there the
/// named list is the clearer contract and the whole-struct borrow would only
/// widen what the callee may reach. `send_peer_datagram_delta_with_worker` is
/// deliberately left explicit for that reason: it takes the row hashes as
/// `&[u64]`, and passing this struct would hand it a mutable baseline it must
/// not have. Destructuring yields exactly the disjoint field borrows the old
/// parameter lists spelled out, at no runtime cost.
pub(crate) struct DisplayScratch {
    /// Snapshot buffer pool; a snapshot returns its buffer when it is sent.
    pub(crate) buffers: BufferPool,
    pub(crate) compressor: Compressor,
    /// **Persists across flushes.** The per-row hash baseline every delta is
    /// computed against. Refreshed for dirty rows only; clearing it wholesale
    /// would silently promote the next flush to a full redraw.
    pub(crate) current_row_hashes: Vec<u64>,
    /// **Persists across flushes.** Row captures replaced only for dirty rows,
    /// so retries and dictionary builds reuse unchanged rows without going back
    /// to the terminal grid. Pruned by row index on resize, never emptied.
    pub(crate) flush_row_capture: HashMap<u16, CapturedRow>,
    pub(crate) rows: FlushRowScratch,
    /// Batching state for the inline prepare arm; drained within every flush
    /// that uses it. The prepare thread owns its own beside its compressor.
    pub(crate) prepare: PrepareScratch,
}

impl DisplayScratch {
    pub(crate) fn new(pool_depth: usize) -> Self {
        Self {
            buffers: BufferPool::new(pool_depth),
            compressor: Compressor::new(),
            current_row_hashes: Vec::new(),
            flush_row_capture: HashMap::new(),
            rows: FlushRowScratch::default(),
            prepare: PrepareScratch::default(),
        }
    }
}

/// Select the rows this flush must carry.
///
/// The invariant is idempotency: a row is skipped only when the peer has
/// CONFIRMED the current content and nothing speculative is outstanding for it,
/// or when this exact content is already in flight inside its pacing window.
/// Every other row is re-encoded against the ACKed baseline on every flush.
/// `display_row_is_selectable` is that rule, and it carries the reasoning;
/// the scheduler asks the same function through `has_selectable_rows`, so a
/// peer is woken for a row if and only if this loop would select it.
///
/// That single rule is what takes loss recovery out of the display path. No
/// datagram is ever irreplaceable — if one is lost, its rows still differ from
/// the ACKed baseline at the next flush and are simply re-sent, complete, one
/// flush interval later instead of one round trip. There is nothing to NACK,
/// nothing to repair, and no timer that can hold a row off the wire.
///
/// The caller's `dims_ok` check guarantees the cache row vectors match
/// `current_row_hashes` in length; lengths are clamped defensively anyway.
pub(crate) fn classify_flush_rows(
    cache: &PerPeerDisplayCache,
    current_row_hashes: &[u64],
    now_ms: f64,
    selection: &mut FlushRowSelection,
) {
    let selected_rows = &mut selection.selected_rows;
    selected_rows.clear();

    let acked_hashes = cache.acked_row_hashes.as_slice();
    let acked_seqs = cache.acked_row_seq.as_slice();
    let acked_exact = cache.acked_row_exact.as_slice();
    let sent_hashes = cache.sent_row_hashes.as_slice();
    let sent_confirmed = cache.sent_row_confirmed.as_slice();
    let force_full_until_confirmed = cache.sent_row_force_full_until_confirmed.as_slice();
    let latest_seqs = cache.sent_row_latest_seq.as_slice();
    let has_reliable_attempt = cache.sent_row_has_reliable_attempt.as_slice();
    let resend_after = cache.sent_row_resend_after_ms.as_slice();
    let row_count = current_row_hashes
        .len()
        .min(acked_hashes.len())
        .min(acked_seqs.len())
        .min(acked_exact.len())
        .min(sent_hashes.len())
        .min(sent_confirmed.len())
        .min(force_full_until_confirmed.len())
        .min(latest_seqs.len())
        .min(has_reliable_attempt.len())
        .min(resend_after.len());

    // Reserving once keeps the worst case (full-screen redraw) to a single
    // growth, and the vector is owner-loop-owned so the capacity persists
    // across flushes: a steady session allocates nothing here.
    selected_rows.reserve(row_count);

    for row in 0..row_count {
        let hash = current_row_hashes[row];
        let acked_hash = acked_hashes[row];

        if !display_row_is_selectable(
            hash,
            acked_hash,
            acked_exact[row],
            sent_hashes[row],
            sent_confirmed[row],
            latest_seqs[row],
            has_reliable_attempt[row],
            resend_after[row],
            now_ms,
        ) {
            continue;
        }

        let row_u16 = row as u16;
        // Widen to a full row when a sparse delta could leave the peer holding
        // cells from a version that nothing will ever correct.
        //
        // 1. The baseline was credited without a per-sequence proof that the
        //    browser applied the datagram carrying it, so it may not be what
        //    the peer actually has.
        //
        // 2. A DIFFERENT version of this row is outstanding. Deltas diff against
        //    the ACKed baseline A, so with a speculative B in flight and the
        //    live row now C, a sparse A->C delta carries only cells where A and
        //    C differ. Cells that changed A->B but are back at A in C are absent
        //    from it — and once B applies IN ORDER nothing repaints them, so B's
        //    glyphs persist. The receiver's row-version gate does not help: it
        //    discards frames that arrive LATE, not ones that arrived on time and
        //    were superseded afterwards.
        //
        //    Beyond the visible staleness, leftover glyphs right of the cursor
        //    make the browser's speculative shadow unseedable
        //    (`row_tail_is_predictable`), so the next keystroke is unmodelled
        //    and the daemon revokes prediction for the rest of the line.
        //
        //    Restating only the superseded cells (poisoning them in the encode
        //    baseline) was measured and is WORSE: at this RTT `sent` differs
        //    from `acked` across everything typed since the last ACK, so the
        //    span is wide anyway and gets re-sent every flush. A full row is
        //    both simpler and faster here.
        let sent_hash = sent_hashes[row];
        let supersedes_unacked_version = sent_hash != acked_hash && sent_hash != hash;
        let force_full = (acked_seqs[row] != 0 && !acked_exact[row])
            || supersedes_unacked_version
            || force_full_until_confirmed[row];
        selected_rows.push(DisplayRowRequest {
            row: row_u16,
            force_full,
        });
    }
}

#[inline]
fn display_row_utility(row: u16, cursor_row: Option<u16>, _terminal_rows: u16) -> DisplayUtility {
    if cursor_row == Some(row) {
        DisplayUtility::Critical
    } else {
        DisplayUtility::NonCritical
    }
}

#[inline]
fn display_row_priority(row: u16, cursor_row: Option<u16>, terminal_rows: u16) -> u8 {
    if cursor_row == Some(row) {
        return 0;
    }
    let prompt_adjacent = cursor_row.is_some_and(|cursor| {
        row < cursor && row >= cursor.saturating_sub(VALUABLE_PROMPT_ROWS_ABOVE_CURSOR)
    });
    let valuable_start = terminal_rows.saturating_sub(VALUABLE_BOTTOM_ROW_COUNT);
    if row < terminal_rows && (prompt_adjacent || row >= valuable_start) {
        1
    } else {
        2
    }
}

/// Clip one flush's row list to `FLUSH_ROW_BUDGET_BYTES`, keeping the prefix.
///
/// `selected_rows` must already be ranked, so the prefix is the highest-utility
/// content and the cursor row is never the row that gets dropped. Returns
/// whether anything was clipped.
///
/// The first row is always kept regardless of size: a single oversize row still
/// has to go somewhere, and the jumbo path handles it. This guarantees forward
/// progress — a budget that could select nothing would stall the peer forever.
#[cfg(test)]
fn apply_flush_row_budget(
    terminal: &mut TerminalState,
    acked_grid: &[CellRepr],
    selected_rows: &mut Vec<DisplayRowRequest>,
    wire_budget_bytes: usize,
) -> bool {
    let mut spent = STREAM_HEADER_BYTES + FRAME_HEADER_BODY_BYTES;
    let mut kept = 0usize;
    for request in selected_rows.iter() {
        let size = terminal.estimate_row_delta_size(acked_grid, *request);
        if kept > 0 && spent.saturating_add(size) > wire_budget_bytes {
            break;
        }
        spent = spent.saturating_add(size);
        kept += 1;
    }
    if kept >= selected_rows.len() {
        return false;
    }
    selected_rows.truncate(kept);
    true
}

/// Wakes the owner loop when a carrier only probes could leave reopens, so
/// display held for it resumes on the acknowledgment rather than a timer.
pub(crate) static CARRIER_UNBLOCKED: std::sync::LazyLock<tokio::sync::Notify> =
    std::sync::LazyLock::new(tokio::sync::Notify::new);

/// Read each carrier's blocked state: the edge tunnel's own connection or the
/// browser leg its edge last quoted, and the direct connection.
pub(crate) fn observe_carrier_blocks(peer: &mut PeerDisplayState) {
    let edge = carrier_blocked_now(peer, PeerTransport::Edge);
    let direct = carrier_blocked_now(peer, PeerTransport::WebTransport);
    peer.carrier_blocks.observe(PeerTransport::Edge, edge);
    peer.carrier_blocks
        .observe(PeerTransport::WebTransport, direct);
}

/// Whether the connection serving `carrier` right now admits only probes:
/// lock-free reads of the edge tunnel's view and the direct connection's.
fn carrier_blocked_now(peer: &PeerDisplayState, carrier: PeerTransport) -> bool {
    match carrier {
        PeerTransport::Edge => peer
            .edge_tunnel
            .as_ref()
            .is_some_and(|tunnel| tunnel.send_blocked()),
        PeerTransport::WebTransport => peer
            .open_direct_session()
            .is_some_and(|session| *session.quic_connection().send_blocked().borrow()),
    }
}

/// A carrier reopened somewhere: re-read every peer's carriers, so each held
/// display resumes exactly where its own carrier reopened.
pub(crate) fn observe_all_carrier_blocks(peers: &mut PeerMap) {
    for peer in peers.values_mut() {
        observe_carrier_blocks(peer);
    }
}

/// Every live carrier is blocked and already holds its one frame, so new
/// display coalesces in the cache until one reopens.
///
/// Blocked is read from the connection serving each carrier now, not only from
/// the record: the record is refreshed on the flush path this gates, so a
/// record read from a connection since replaced would hold display until an
/// unrelated wake, and an open successor never fires the reopening that would
/// correct it.
fn display_held(peer: &PeerDisplayState, now_ms: f64) -> bool {
    let mut live = [PeerTransport::WebTransport, PeerTransport::Edge]
        .into_iter()
        .filter(|carrier| {
            peer.paths
                .get(*carrier)
                .is_live(now_ms, SessionPolicy::PATH_STALE_THRESHOLD_MS)
        })
        .peekable();
    live.peek().is_some()
        && live.all(|carrier| {
            peer.carrier_blocks.is_closed(carrier) && carrier_blocked_now(peer, carrier)
        })
}

/// Free datagram-buffer space in the carrier(s) this peer's display path may
/// use right now.
///
/// The maximum across live carriers. Redundant sends admit each physical copy
/// independently, so a full carrier must not hide capacity on the other one.
///
/// Every carrier state here is a lock-free delivery view, never the registry
/// or a connection's state lock: a flush reads it without waiting on anything.
fn refresh_display_delivery_quotes(peer: &mut PeerDisplayState) -> (Option<usize>, Option<usize>) {
    observe_carrier_blocks(peer);
    let edge_state = peer
        .edge_tunnel
        .as_ref()
        .and_then(|tunnel| tunnel.quic_delivery_state());
    let edge_tunnel = peer
        .paths
        .edge
        .available
        .then_some(peer.edge_tunnel.as_ref())
        .flatten();
    let edge_attached = edge_tunnel.is_some_and(|tunnel| {
        matches!(
            tunnel.counterpart_state(),
            crate::edge_tunnel::CounterpartState::Attached { .. }
        )
    });
    let edge_state = edge_tunnel.and(edge_state);
    let edge_downstream = edge_tunnel.and_then(|tunnel| tunnel.downstream_delivery_quote());
    let edge = edge_tunnel.map(|tunnel| {
        edge_state.map_or_else(
            || tunnel.datagram_send_space(),
            |state| state.datagram_send_buffer_space,
        )
    });
    let current_edge_quote = match (edge_attached, edge_state, edge_downstream) {
        (true, Some(upstream), Some(downstream)) => Some(crate::telemetry::serial_delivery_quote(
            crate::telemetry::delivery_quote(upstream),
            crate::telemetry::edge_downstream_quote(downstream),
        )),
        _ => None,
    };
    if let Some(state) = edge_state {
        trace_quic_state(peer, 1, state);
    }
    refresh_planner_carrier_quote(&mut peer.display_planning, 1, current_edge_quote);

    let direct = match (
        peer.paths.webtransport.available,
        peer.direct_session.is_some(),
    ) {
        (true, true) => {
            let state = peer
                .open_direct_session()
                .map(|session| session.delivery_state());
            if let Some(state) = state {
                trace_quic_state(peer, 0, state);
                refresh_planner_carrier_quote(
                    &mut peer.display_planning,
                    0,
                    Some(crate::telemetry::delivery_quote(state)),
                );
                Some(state.datagram_send_buffer_space)
            } else {
                refresh_planner_carrier_quote(&mut peer.display_planning, 0, None);
                Some(crate::webtransport::direct_datagram_budget(None).first_payload_bytes)
            }
        }
        (false, _) | (_, false) => {
            refresh_planner_carrier_quote(&mut peer.display_planning, 0, None);
            None
        }
    };
    (edge, direct)
}

#[inline]
fn refresh_planner_carrier_quote(
    planning: &mut crate::display::planner::PeerDisplayPlanningModel,
    carrier: usize,
    quote: Option<CarrierDeliveryQuote>,
) {
    if let Some(quote) = quote {
        planning.observe_carrier_quote(carrier, quote);
    } else {
        // `None` is attachment-fenced, not merely a missing sample: the edge
        // clears its watch before Pending/Detached or a replacement can publish
        // a quote. Forget both loss and delivery history at that exact boundary
        // so the successor cannot inherit a lifetime-smoothed clean path.
        planning.reset_carrier_observations(carrier);
    }
}

/// One burst's remaining physical datagram capacity.
///
/// Sender bytes are carrier-specific because a dual send occupies both QUIC
/// queues. Receiver capacity is packets because that is the unit the browser's
/// queue reports. Every physical enqueue reserves its path and one receiver
/// slot before touching the transport; a transport refusal restores both.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct DatagramPhysicalBudget {
    webtransport_bytes: usize,
    edge_bytes: usize,
    receiver_packets: usize,
    webtransport_additional_entry_overhead: usize,
    edge_additional_entry_overhead: usize,
    webtransport_reserved_datagrams: usize,
    edge_reserved_datagrams: usize,
}

#[cfg(test)]
const QUINN_DATAGRAM_ENTRY_OVERHEAD_BYTES: usize = 24;

impl DatagramPhysicalBudget {
    /// Both carriers' room from their published state, excluding carriers
    /// already holding display while blocked.
    fn capture(peer: &PeerDisplayState, now_ms: f64) -> Self {
        let carriers = display_carriers(peer, now_ms);
        let edge_budget = peer
            .edge_tunnel
            .as_ref()
            .filter(|_| carriers.contains(&PeerTransport::Edge))
            .map(|tunnel| {
                (
                    tunnel.datagram_send_space(),
                    tunnel.datagram_additional_entry_overhead(),
                )
            })
            .unwrap_or((0, 0));
        let webtransport_budget = match &peer.direct_session {
            Some(_) if carriers.contains(&PeerTransport::WebTransport) => {
                let budget =
                    crate::webtransport::direct_datagram_budget(peer.open_direct_session());
                (budget.first_payload_bytes, budget.additional_entry_overhead)
            }
            _ => (0, 0),
        };
        Self {
            webtransport_bytes: webtransport_budget.0,
            edge_bytes: edge_budget.0,
            receiver_packets: usize::from(peer.adaptive.receive_queue_datagrams),
            webtransport_additional_entry_overhead: webtransport_budget.1,
            edge_additional_entry_overhead: edge_budget.1,
            webtransport_reserved_datagrams: 0,
            edge_reserved_datagrams: 0,
        }
    }

    #[cfg(test)]
    fn exact(webtransport_bytes: usize, edge_bytes: usize, receiver_packets: usize) -> Self {
        Self {
            webtransport_bytes,
            edge_bytes,
            receiver_packets,
            webtransport_additional_entry_overhead: QUINN_DATAGRAM_ENTRY_OVERHEAD_BYTES,
            edge_additional_entry_overhead: QUINN_DATAGRAM_ENTRY_OVERHEAD_BYTES,
            webtransport_reserved_datagrams: 0,
            edge_reserved_datagrams: 0,
        }
    }

    #[cfg(test)]
    fn with_reserved_datagrams(mut self, webtransport: usize, edge: usize) -> Self {
        self.webtransport_reserved_datagrams = webtransport;
        self.edge_reserved_datagrams = edge;
        self
    }

    fn path_bytes(&self, path: PeerTransport) -> usize {
        match path {
            PeerTransport::WebTransport => self.webtransport_bytes,
            PeerTransport::Edge => self.edge_bytes,
        }
    }

    fn path_bytes_mut(&mut self, path: PeerTransport) -> &mut usize {
        match path {
            PeerTransport::WebTransport => &mut self.webtransport_bytes,
            PeerTransport::Edge => &mut self.edge_bytes,
        }
    }

    fn path_reserved_datagrams(&self, path: PeerTransport) -> usize {
        match path {
            PeerTransport::WebTransport => self.webtransport_reserved_datagrams,
            PeerTransport::Edge => self.edge_reserved_datagrams,
        }
    }

    fn path_reserved_datagrams_mut(&mut self, path: PeerTransport) -> &mut usize {
        match path {
            PeerTransport::WebTransport => &mut self.webtransport_reserved_datagrams,
            PeerTransport::Edge => &mut self.edge_reserved_datagrams,
        }
    }

    fn path_additional_entry_overhead(&self, path: PeerTransport) -> usize {
        match path {
            PeerTransport::WebTransport => self.webtransport_additional_entry_overhead,
            PeerTransport::Edge => self.edge_additional_entry_overhead,
        }
    }

    fn reserve(&mut self, path: PeerTransport, wire_len: usize) -> bool {
        let additional_entry = if self.path_reserved_datagrams(path) > 0 {
            self.path_additional_entry_overhead(path)
        } else {
            0
        };
        let reservation_bytes = wire_len.saturating_add(additional_entry);
        if self.receiver_packets == 0 || self.path_bytes(path) < reservation_bytes {
            return false;
        }
        *self.path_bytes_mut(path) -= reservation_bytes;
        *self.path_reserved_datagrams_mut(path) += 1;
        self.receiver_packets -= 1;
        true
    }

    fn release(&mut self, path: PeerTransport, wire_len: usize) {
        let reserved = self.path_reserved_datagrams(path);
        debug_assert!(reserved > 0, "cannot release an unreserved datagram");
        let additional_entry = if reserved > 1 {
            self.path_additional_entry_overhead(path)
        } else {
            0
        };
        let restored = self
            .path_bytes(path)
            .saturating_add(wire_len)
            .saturating_add(additional_entry);
        *self.path_bytes_mut(path) = restored;
        *self.path_reserved_datagrams_mut(path) = reserved.saturating_sub(1);
        self.receiver_packets = self.receiver_packets.saturating_add(1);
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PhysicalDatagramKind {
    Data { seq: u32 },
    Replica { seq: u32 },
    Repair { batch_start_seq: u32 },
    Probe { seq: u32 },
}

#[derive(Clone, Copy)]
struct ReservedPathSend {
    primary: Option<PeerTransport>,
    paths: SentPaths,
    kind: PhysicalDatagramKind,
}

#[derive(Default)]
struct BudgetedSendResult {
    sent_via: SentPaths,
    budget_refused: bool,
}

#[cfg(test)]
fn assign_sim_datagram_metadata(
    peer: &mut PeerDisplayState,
    path: PeerTransport,
    kind: PhysicalDatagramKind,
) -> SimDatagramMetadata {
    let (wire_seq, role, role_tag) = match kind {
        PhysicalDatagramKind::Data { seq } => (seq, SimDatagramRole::Data, 0),
        PhysicalDatagramKind::Replica { seq } => (seq, SimDatagramRole::Replica, 1),
        PhysicalDatagramKind::Repair { batch_start_seq } => {
            (batch_start_seq, SimDatagramRole::Repair, 2)
        }
        PhysicalDatagramKind::Probe { seq } => (seq, SimDatagramRole::Probe, 3),
    };
    let logical_ordinal = if role == SimDatagramRole::Probe {
        let ordinal = peer.sim_next_probe_ordinal;
        peer.sim_next_probe_ordinal = peer.sim_next_probe_ordinal.wrapping_add(1);
        ordinal
    } else if let Some(ordinal) = peer
        .sim_data_ordinals
        .get(&(peer.generation, wire_seq))
        .copied()
    {
        ordinal
    } else {
        let ordinal = peer.sim_next_data_ordinal;
        peer.sim_next_data_ordinal = peer.sim_next_data_ordinal.wrapping_add(1);
        peer.sim_data_ordinals
            .insert((peer.generation, wire_seq), ordinal);
        ordinal
    };
    let path_tag = match path {
        PeerTransport::WebTransport => 0,
        PeerTransport::Edge => 1,
    };
    let role_index = 0;
    let key = (
        peer.generation,
        logical_ordinal,
        path_tag,
        role_tag,
        role_index,
    );
    let retransmit_attempt = *peer.sim_datagram_attempts.entry(key).or_insert(0);
    *peer.sim_datagram_attempts.get_mut(&key).expect("inserted") =
        retransmit_attempt.saturating_add(1);
    SimDatagramMetadata {
        generation: peer.generation,
        wire_seq,
        logical_ordinal,
        path,
        role,
        role_index,
        retransmit_attempt,
    }
}

fn send_exact_path_budgeted(
    peer: &mut PeerDisplayState,
    wire: &bytes::Bytes,
    path: PeerTransport,
    kind: PhysicalDatagramKind,
    budget: &mut DatagramPhysicalBudget,
) -> BudgetedSendResult {
    let trace = native_trace_token(peer).map(|token| (token, Instant::now()));
    let trace_space = budget.path_bytes(path);
    if !budget.reserve(path, wire.len()) {
        trace_physical_attempt(peer, trace, path, kind, wire, false, trace_space, true);
        return BudgetedSendResult {
            budget_refused: true,
            ..BudgetedSendResult::default()
        };
    }
    #[cfg(test)]
    let sim_metadata = assign_sim_datagram_metadata(peer, path, kind);
    let sent = send_display_wire_on_transport(
        path,
        wire,
        peer.direct_session.as_ref(),
        peer.edge_tunnel.as_ref(),
    );
    trace_physical_attempt(peer, trace, path, kind, wire, sent, trace_space, false);
    record_send_outcome(&mut peer.paths, path, sent);
    if sent {
        #[cfg(test)]
        peer.sim_datagram_metadata.push_back(sim_metadata);
        BudgetedSendResult {
            sent_via: SentPaths::single(path),
            budget_refused: false,
        }
    } else {
        budget.release(path, wire.len());
        BudgetedSendResult::default()
    }
}

/// Submit one datagram against capacity reserved by the post-encode burst
/// plan. A transport refusal returns that reservation to the burst's spare
/// budget, where the ordinary immediate fallback may consume it without ever
/// borrowing bytes or receiver slots reserved for a later data/parity unit.
fn send_exact_path_reserved(
    peer: &mut PeerDisplayState,
    wire: &bytes::Bytes,
    path: PeerTransport,
    kind: PhysicalDatagramKind,
    spare_budget: &mut DatagramPhysicalBudget,
) -> bool {
    let trace = native_trace_token(peer).map(|token| (token, Instant::now()));
    let trace_space = spare_budget.path_bytes(path);
    #[cfg(test)]
    let sim_metadata = assign_sim_datagram_metadata(peer, path, kind);
    let sent = send_display_wire_on_transport(
        path,
        wire,
        peer.direct_session.as_ref(),
        peer.edge_tunnel.as_ref(),
    );
    trace_physical_attempt(peer, trace, path, kind, wire, sent, trace_space, false);
    record_send_outcome(&mut peer.paths, path, sent);
    if sent {
        #[cfg(test)]
        peer.sim_datagram_metadata.push_back(sim_metadata);
    } else {
        spare_budget.release(path, wire.len());
    }
    sent
}

fn release_reserved_paths(budget: &mut DatagramPhysicalBudget, paths: SentPaths, wire_len: usize) {
    if paths.webtransport {
        budget.release(PeerTransport::WebTransport, wire_len);
    }
    if paths.edge {
        budget.release(PeerTransport::Edge, wire_len);
    }
}

fn native_trace_token(peer: &PeerDisplayState) -> Option<TraceToken> {
    peer.perf_trace_token
        .filter(|token| perf_trace::active_token() == Some(*token))
}

fn trace_quic_state(
    peer: &PeerDisplayState,
    carrier: u64,
    state: wtransport::quinn::DeliveryState,
) {
    let Some(token) = native_trace_token(peer) else {
        return;
    };
    perf_trace::record_at(
        token,
        Instant::now(),
        TraceEvent::CarrierState([
            carrier,
            u64::try_from(state.rtt.as_micros()).unwrap_or(u64::MAX),
            state.cwnd,
            state.bytes_in_flight,
            crate::webtransport::DATAGRAM_SEND_BUFFER_BYTES
                .saturating_sub(state.datagram_send_buffer_space) as u64,
            u64::from(state.current_mtu),
            state.pacing_rate.unwrap_or(0),
            state.sent_packets,
            state.lost_packets,
            state.datagram_send_buffer_space as u64,
            0,
            0,
            0,
            0,
            0,
            0,
        ]),
    );
}

fn trace_carrier(path: PeerTransport) -> u64 {
    u64::from(path == PeerTransport::Edge)
}

/// The authenticated ciphertext tag identifies an exact sealed record without
/// retaining plaintext, key material, or requiring a payload traversal/hash.
fn trace_sealed_tag(wire: &[u8]) -> [u64; 2] {
    let Some(tag) = wire
        .get(wire.len().saturating_sub(16)..)
        .filter(|tag| tag.len() == 16)
    else {
        return [0; 2];
    };
    [
        u64::from_le_bytes(tag[..8].try_into().expect("tag half")),
        u64::from_le_bytes(tag[8..].try_into().expect("tag half")),
    ]
}

fn trace_physical_attempt(
    peer: &PeerDisplayState,
    trace: Option<(TraceToken, Instant)>,
    path: PeerTransport,
    kind: PhysicalDatagramKind,
    wire: &[u8],
    accepted: bool,
    remaining_budget: usize,
    budget_refused: bool,
) {
    let Some((token, started)) = trace else {
        return;
    };
    let completed = Instant::now();
    let (seq, role) = match kind {
        PhysicalDatagramKind::Data { seq } => (seq, 0),
        PhysicalDatagramKind::Replica { seq } => (seq, 1),
        PhysicalDatagramKind::Repair { batch_start_seq } => (batch_start_seq, 2),
        PhysicalDatagramKind::Probe { seq } => (seq, 3),
    };
    let tag = trace_sealed_tag(wire);
    perf_trace::record_at(
        token,
        completed,
        TraceEvent::DisplayAttempt([
            u64::from(seq),
            u64::from(peer.generation),
            role,
            trace_carrier(path),
            perf_trace::elapsed_us(token, started),
            u64::from(accepted),
            wire.len() as u64,
            remaining_budget as u64,
            u64::from(budget_refused),
            0,
            // Four uint32 words preserve the complete 128-bit tag in JSON numbers.
            tag[0] & 0xffff_ffff,
            tag[0] >> 32,
            tag[1] & 0xffff_ffff,
            tag[1] >> 32,
            0,
            0,
        ]),
    );
}

fn trace_prepared_member(
    peer: &PeerDisplayState,
    datagram: &PreparedDisplayDatagram,
    wire_len: usize,
) {
    let Some(token) = native_trace_token(peer) else {
        return;
    };
    let read_u16 = |offset| {
        u16::from_be_bytes(
            datagram.frame[offset..offset + 2]
                .try_into()
                .expect("display header"),
        )
    };
    let read_u32 = |offset| {
        u32::from_be_bytes(
            datagram.frame[offset..offset + 4]
                .try_into()
                .expect("display header"),
        )
    };
    let plan = datagram.physical_plan;
    perf_trace::record_at(
        token,
        Instant::now(),
        TraceEvent::DisplayMember([
            u64::from(datagram.seq),
            u64::from(peer.generation),
            u64::from(datagram.frame_id),
            u64::from(read_u32(DISPLAY_PRESENTATION_ID_OFFSET)),
            u64::from(read_u16(DISPLAY_PRESENTATION_MEMBER_INDEX_OFFSET)),
            u64::from(read_u16(DISPLAY_PRESENTATION_MEMBER_COUNT_OFFSET)),
            u64::from(datagram.frame[DISPLAY_PATCH_FLAGS_OFFSET]),
            u64::from(datagram.encoded_rows),
            plan.data_primary.map_or(2, trace_carrier),
            u64::from(plan.data_paths.webtransport) | (u64::from(plan.data_paths.edge) << 1),
            wire_len as u64,
            u64::from(read_u32(DISPLAY_ROW_PREDECESSOR_PRESENTATION_ID_OFFSET)),
            0,
            0,
            0,
            0,
        ]),
    );
}

/// Send exactly the paths selected and prepaid by physical admission.
///
/// If a sole planned carrier rejects the actual enqueue, its returned
/// reservation may fund the same immediate fallback as the old send path. A
/// dual plan has already named every live carrier and therefore has no third
/// fallback to discover.
fn send_reserved_paths(
    peer: &mut PeerDisplayState,
    wire: &bytes::Bytes,
    admission: ReservedPathSend,
    now_ms: f64,
    spare_budget: &mut DatagramPhysicalBudget,
) -> BudgetedSendResult {
    let Some(primary) = admission.primary else {
        return BudgetedSendResult::default();
    };
    let mut result = BudgetedSendResult::default();
    if sent_paths_contains(admission.paths, primary)
        && send_exact_path_reserved(peer, wire, primary, admission.kind, spare_budget)
    {
        result.sent_via.mark(primary);
    }
    for path in [PeerTransport::WebTransport, PeerTransport::Edge] {
        if path == primary || !sent_paths_contains(admission.paths, path) {
            continue;
        }
        if send_exact_path_reserved(peer, wire, path, admission.kind, spare_budget) {
            result.sent_via.mark(path);
        }
    }

    if !result.sent_via.any()
        && let Some(fallback) =
            peer.paths
                .fallback_for(primary, now_ms, SessionPolicy::PATH_STALE_THRESHOLD_MS)
        && !sent_paths_contains(admission.paths, fallback)
    {
        let fallback_result =
            send_exact_path_budgeted(peer, wire, fallback, admission.kind, spare_budget);
        result.budget_refused = fallback_result.budget_refused;
        result.sent_via = fallback_result.sent_via;
    }
    result
}

#[cfg(test)]
fn send_display_wire_budgeted(
    peer: &mut PeerDisplayState,
    wire: &bytes::Bytes,
    now_ms: f64,
    intent: SendIntent,
    kind: PhysicalDatagramKind,
    budget: &mut DatagramPhysicalBudget,
) -> BudgetedSendResult {
    let health_targets = pick_path(
        &peer.paths,
        intent,
        now_ms,
        SessionPolicy::PATH_STALE_THRESHOLD_MS,
    );
    let targets = match health_targets {
        PathTargets::Single(_) => {
            PathTargets::Single(planned_display_transport(peer, now_ms, wire.len(), 0))
        }
        dual @ PathTargets::Dual(_, _) => dual,
    };
    let edge = peer.edge_tunnel.clone();
    let mut result = BudgetedSendResult::default();
    for target in targets.iter() {
        // Redundant path selection tolerates partial failures. Budget pressure
        // is the same kind of per-path admission failure: a full primary must
        // not prevent the healthy secondary from carrying this logical send,
        // and a single remaining browser queue slot must still be useful.
        if !budget.reserve(target, wire.len()) {
            result.budget_refused = true;
            continue;
        }
        #[cfg(test)]
        let sim_metadata = assign_sim_datagram_metadata(peer, target, kind);
        let sent = send_display_wire_on_transport(
            target,
            wire,
            peer.direct_session.as_ref(),
            edge.as_ref(),
        );
        record_send_outcome(&mut peer.paths, target, sent);
        if sent {
            result.sent_via.mark(target);
            #[cfg(test)]
            peer.sim_datagram_metadata.push_back(sim_metadata);
        } else {
            budget.release(target, wire.len());
        }
    }
    #[cfg(not(test))]
    let _ = kind;

    if !result.sent_via.any() && !targets.is_dual() {
        let primary = targets.primary();
        if let Some(fallback) =
            peer.paths
                .fallback_for(primary, now_ms, SessionPolicy::PATH_STALE_THRESHOLD_MS)
        {
            let fallback_result = send_exact_path_budgeted(peer, wire, fallback, kind, budget);
            result.budget_refused |= fallback_result.budget_refused;
            if fallback_result.sent_via.any() {
                result.sent_via = fallback_result.sent_via;
            }
        }
    }
    result
}

/// Bound one flush against the carrier's current free datagram buffer using
/// the same peer/content/dictionary posterior as the partition planner.
///
/// `wire_budget_bytes` is read from the carrier immediately before the flush is
/// built, so it is the exact number of compressed bytes the send buffer can
/// still accept. That is what the budget always meant — the old constant's own
/// doc comment derived 36 KiB from the 64 KiB buffer — but a constant cannot see
/// a buffer that is already half full, and `quinn::Connection::send_datagram`
/// answers an overflow by evicting the OLDEST queued datagram and returning
/// `Ok(())`. A flush sized past the free space therefore deleted the head of its
/// own burst, silently, while every send reported success and
/// `record_backpressure` saw a clean flush.
///
fn prioritize_display_rows(
    selected_rows: &mut [DisplayRowRequest],
    cursor_row: Option<u16>,
    terminal_rows: u16,
    sent_row_hashes: &[u64],
    current_row_hashes: &[u64],
) {
    selected_rows.sort_unstable_by_key(|request| {
        (
            display_row_priority(request.row, cursor_row, terminal_rows),
            // A row whose current content has never been on the wire outranks
            // one that has and is merely waiting to be acknowledged.
            //
            // Without this the flush budget is spent, every flush, re-sending an
            // already-delivered-but-unacknowledged prefix, and the rows past the
            // budget are never reached. Progress then advances only as ACKs
            // retire that prefix — about one row per round trip — so a
            // full-screen repaint of incompressible content costs ~N round trips
            // and re-sends the whole budget in between. That is what a person
            // sees as the screen filling in line by line.
            //
            // The test is `sent_row_hashes[row] != current_row_hashes[row]`, not
            // "was this row ever sent": on a *repaint* every row has been sent
            // before, so a never-sent test gives no discrimination at all and
            // the same prefix wins again. Comparing content versions is what
            // makes this work for the second screen as well as the first.
            sent_row_hashes
                .get(usize::from(request.row))
                .zip(current_row_hashes.get(usize::from(request.row)))
                .is_some_and(|(sent, current)| sent == current),
            request.row,
        )
    });
}

/// Encode the selected rows into size-capped datagram batches — or a single
/// header-only delta (cursor/input-seq update) when no rows were selected.
#[cfg(test)]
pub(crate) fn build_datagram_batches(
    terminal: &mut TerminalState,
    peer: &mut PeerDisplayState,
    selected_rows: &mut [DisplayRowRequest],
    input_seq: u32,
    now_ms: f64,
    compressor: &mut Compressor,
    row_capture_scratch: &mut RowCaptureScratch,
    flush_row_cache: &mut HashMap<u16, CapturedRow>,
) -> Vec<PreparedDisplayDatagram> {
    let cursor_row = terminal.current_cursor_row();
    prioritize_display_rows(
        selected_rows,
        cursor_row,
        terminal.rows,
        &peer.display_cache.sent_row_hashes,
        // The test helper does not track current hashes; an empty slice makes
        // the term uniformly false, preserving this path's original ordering.
        &[],
    );
    let mut captured_rows = Vec::new();
    capture_prepare_rows(
        terminal,
        peer,
        selected_rows,
        cursor_row,
        row_capture_scratch,
        flush_row_cache,
        &mut captured_rows,
    );
    let mut scratch = PrepareScratch::default();
    // Test packet choices against an exact CPU cost, independently of runner contention.
    scratch.planner.sender_service_us_for_test = Some(20.0);
    let mut frames = BufferPool::new(DISPLAY_FRAME_POOL_DEPTH);
    let mut prepared = Vec::new();
    let causal_input_advanced = input_seq != peer.last_row_advertised_input_seq;
    build_captured_datagram_batches(
        terminal.display_header_state(),
        terminal,
        peer,
        &captured_rows,
        0,
        true,
        false,
        causal_input_advanced,
        input_seq,
        now_ms,
        compressor,
        &mut scratch,
        &mut frames,
        &mut prepared,
    );
    prepared
}

/// Encode batches from the exact immutable row captures used for sizing and
/// ACK provenance, appending the datagrams to `out`. No operation below rereads
/// or reconverts the terminal grid.
///
/// With no rows to carry, `emit_header_only` decides whether the header alone
/// goes out: it is the caller's statement that this flush has a reason to emit
/// — a changed header, a stale `input_seq` advertisement the browser is
/// waiting on, or an owed END — and it applies whether the selection was
/// empty or every selected row encoded to zero bytes. Damage alone is not a
/// reason; see the caller.
fn build_captured_datagram_batches(
    head: crate::pty::terminal::DisplayHeaderState,
    terminal: &mut TerminalState,
    peer: &mut PeerDisplayState,
    captured_rows: &[DisplayPrepareRow],
    closure_digest: u64,
    emit_header_only: bool,
    presentation_continues: bool,
    causal_input_advanced: bool,
    input_seq: u32,
    now_ms: f64,
    compressor: &mut Compressor,
    scratch: &mut PrepareScratch,
    frames: &mut BufferPool,
    out: &mut Vec<PreparedDisplayDatagram>,
) {
    let header_signal = head.signal;
    // Freeze only the compression decision at encode time. Carrier admission
    // remains dynamic, while the resulting frame is always valid on either
    // path and never exceeds the ordinary datagram cap.
    let fit_relay_critical_datagram = display_primary_is_edge(peer, now_ms);
    if captured_rows.is_empty() {
        if !emit_header_only {
            return;
        }
        let payload = terminal.encode_header_only_delta_into(
            frames.take(0),
            closure_digest,
            peer.echo_horizon,
        );
        if payload.is_empty() {
            frames.put(payload);
            return;
        }
        let frame_id = peer.next_frame_id();
        out.push(prepare_display_datagram(
            BatchPayload::plain(payload, ContentClass::Sparse),
            SentRows::default(),
            terminal.rows,
            peer,
            input_seq,
            now_ms,
            0,
            frame_id,
            frame_id,
            presentation_continues || peer.presentation_end_owed,
            !presentation_continues,
            0,
            1,
            0,
            1,
            DisplayUtility::Critical,
            header_signal,
        ));
        return;
    }

    let policy = display_compression_policy(
        peer,
        now_ms,
        fit_relay_critical_datagram,
        ExecutionLane::Inline,
        0,
    );
    let dictionary = peer.dictionary.active();
    let mut header = head.header;
    header.closure_digest = closure_digest;
    header.echo_horizon = peer.echo_horizon;
    pack_captured_rows(
        captured_rows,
        header,
        &policy,
        dictionary.map(|dictionary| &**dictionary),
        header_signal != peer.last_admitted_critical_header_signal,
        compressor,
        scratch,
        frames,
    );

    // One datagram, one frame.
    //
    // Every batch here is already a complete, independently decodable display
    // payload: it carries its own stream header and is compressed on its own
    // against the peer's dictionary. Grouping several of them under one frame id
    // added nothing to the wire and one property to the receiver — that it must
    // hold every chunk before applying any — and that property is what turned
    // ordinary datagram loss into screen-scale loss. A 33-datagram frame on a
    // path dropping 9% of datagrams completes about 4% of the time; measured in
    // production, frames of 32 chunks or more were never applied 72% of the
    // time, each failure pinning one of the receiver's four assembly slots until
    // the fourth forced a full-screen snapshot, whose own datagrams then
    // stranded the same way.
    //
    // Each literal row transformation contains its complete changed span and
    // is protected by the receiver's per-row sequence gate. No entry reads a
    // different mutable grid row, so reordering and loss cannot invalidate
    // another datagram's transformation.
    let batch_count = scratch.batches.len();
    assert!(batch_count <= merkur_codec::MAX_TERMINAL_ROWS);
    let presentation_id = {
        let mut cursor = peer.next_frame_id;
        take_wrapping_nonzero(&mut cursor)
    };
    let presentation_coherent = peer.presentation_end_owed
        || presentation_is_coherent(
            &scratch.batches,
            header.cursor_row,
            causal_input_advanced,
            presentation_continues,
        );
    for (index, (payload, sent_rows, encoded_rows, utility)) in
        scratch.batches.drain(..).enumerate()
    {
        let frame_id = peer.next_frame_id();
        out.push(prepare_display_datagram(
            payload,
            sent_rows,
            terminal.rows,
            peer,
            input_seq,
            now_ms,
            encoded_rows,
            frame_id,
            presentation_id,
            presentation_coherent,
            index + 1 == batch_count && !presentation_continues,
            0,
            1,
            index as u16,
            u16::try_from(batch_count).expect("prepared display member count fits u16"),
            utility,
            header_signal,
        ));
    }
}

/// Advisory small-record path hint for compression policy. Final dispatch
/// compares the actual complete encoded schedule; no inter-group pacing exists.
fn display_primary_is_edge(peer: &PeerDisplayState, now_ms: f64) -> bool {
    planned_display_transport(
        peer,
        now_ms,
        DisplayPolicy::FEC_PROTECTED_DATAGRAM_PAYLOAD_BYTES,
        0,
    ) == PeerTransport::Edge
}

fn fallback_carrier_quote(
    peer: &PeerDisplayState,
    transport: PeerTransport,
    send_buffer_occupied_bytes: usize,
) -> CarrierDeliveryQuote {
    let path = peer.paths.get(transport);
    let mtu = DisplayPolicy::DATAGRAM_MAX_PAYLOAD_BYTES;
    CarrierDeliveryQuote {
        one_way_us: path.network_rtt_ewma_ms.max(0.1) * 500.0,
        // The heartbeat RTT and its own jitter describe the same carrier.
        // Mixed confirmation jitter would charge reverse ACK transit/cadence
        // to a forward quote whenever exact QUIC state is unavailable.
        jitter_upper_us: path.network_jitter_ewma_ms.max(0.0) * 1_645.0,
        congestion_window_bytes: 10 * mtu as u64,
        bytes_in_flight: 0,
        send_buffer_occupied_bytes,
        mtu_bytes: mtu,
        pacing_rate_bps: 0,
        loss_upper: (f64::from(path.consecutive_send_failures) * 0.05).min(0.5),
        serial_hops: None,
    }
}

/// The carriers new display may take: live ones, and while any live carrier
/// can still send, only those that can. With every live carrier blocked, each
/// that does not yet hold its one frame may take it.
fn display_carriers(peer: &PeerDisplayState, now_ms: f64) -> ArrayVec<PeerTransport, 2> {
    let live = [PeerTransport::WebTransport, PeerTransport::Edge]
        .into_iter()
        .filter(|carrier| {
            peer.paths
                .get(*carrier)
                .is_live(now_ms, SessionPolicy::PATH_STALE_THRESHOLD_MS)
        })
        .collect::<ArrayVec<_, 2>>();
    let open = live
        .iter()
        .any(|carrier| !peer.carrier_blocks.is_blocked(*carrier));
    live.into_iter()
        .filter(|carrier| {
            if open {
                !peer.carrier_blocks.is_blocked(*carrier)
            } else {
                !peer.carrier_blocks.is_closed(*carrier)
            }
        })
        .collect()
}

fn planned_display_transport(
    peer: &PeerDisplayState,
    now_ms: f64,
    plan_bytes: usize,
    send_buffer_occupied_bytes: usize,
) -> PeerTransport {
    let packets = plan_bytes.div_ceil(DisplayPolicy::FEC_PROTECTED_DATAGRAM_PAYLOAD_BYTES);
    display_carriers(peer, now_ms)
        .into_iter()
        .min_by(|left, right| {
            let delivery = |transport: PeerTransport| {
                let index = usize::from(transport == PeerTransport::Edge);
                peer.display_planning
                    .carrier_quote(
                        index,
                        fallback_carrier_quote(peer, transport, send_buffer_occupied_bytes),
                    )
                    .earliest_delivery_us(plan_bytes, packets)
            };
            delivery(*left).total_cmp(&delivery(*right))
        })
        .unwrap_or(PeerTransport::Edge)
}

/// Build the planner's immutable view while the owner loop has the peer.
/// Preparation threads never touch peer state; they receive this compact
/// snapshot with the captured rows and can therefore plan without a lock.
fn display_planning_context(
    peer: &PeerDisplayState,
    now_ms: f64,
    send_buffer_occupied_bytes: usize,
) -> PlanningContext {
    let primary = planned_display_transport(
        peer,
        now_ms,
        DisplayPolicy::FEC_PROTECTED_DATAGRAM_PAYLOAD_BYTES,
        send_buffer_occupied_bytes,
    );
    let fallback = fallback_carrier_quote(peer, primary, send_buffer_occupied_bytes);
    let carrier_index = usize::from(primary == PeerTransport::Edge);
    let carrier = peer.display_planning.carrier_quote(carrier_index, fallback);
    let other = match primary {
        PeerTransport::WebTransport => PeerTransport::Edge,
        PeerTransport::Edge => PeerTransport::WebTransport,
    };
    let alternate_carrier = display_carriers(peer, now_ms).contains(&other).then(|| {
        peer.display_planning.carrier_quote(
            usize::from(other == PeerTransport::Edge),
            fallback_carrier_quote(peer, other, send_buffer_occupied_bytes),
        )
    });
    PlanningContext {
        earliest_uncompressed_send_us: carrier.preparation_slack_us(),
        carrier,
        alternate_carrier,
        datagram_max_payload_bytes: DisplayPolicy::DATAGRAM_MAX_PAYLOAD_BYTES,
        fec_group_size: DisplayPolicy::FEC_GROUP_MAX_SIZE,
        fec_enabled: true,
        initial_fec_group_len: 0,
        initial_fec_group_max_bytes: 0,
        receiver_service_debt_us: peer.display_planning.receiver_service_debt_us(),
        higher_priority_preparation_jobs: 0,
    }
}

/// The class of a batch: the one whose encoded bytes dominate it, exactly as
/// the planner priced the span. A single row is simply its own class.
fn classify_captured_content(rows: &[DisplayPrepareRow]) -> ContentClass {
    let mut bytes = [0usize; 3];
    for row in rows {
        bytes[row.content.class().index()] += row.encoded_size;
    }
    content_class_by_bytes(bytes)
}

fn classify_snapshot_content(cells: &[CellRepr]) -> ContentClass {
    let mut content = ContentEvidence::default();
    content.observe(cells);
    content.class()
}

fn display_compression_policy(
    peer: &PeerDisplayState,
    now_ms: f64,
    fit_relay_critical_datagram: bool,
    execution_lane: ExecutionLane,
    send_buffer_occupied_bytes: usize,
) -> DisplayCompressionPolicy {
    let dictionary_class = if peer.dictionary.active().is_some() {
        DictionaryClass::Finalized
    } else {
        DictionaryClass::Plain
    };
    DisplayCompressionPolicy {
        terminal_rows: peer.display_cache.rows,
        chunk_target_bytes: peer.adaptive.chunk_target_bytes,
        snapshot_target_bytes: peer.adaptive.snapshot_target_bytes,
        backpressure_score: peer.backpressure_score,
        recently_interactive: peer.is_recently_interactive(now_ms),
        fit_relay_critical_datagram,
        planning_profiles: [
            peer.display_planning
                .snapshot(ContentClass::Sparse, dictionary_class),
            peer.display_planning
                .snapshot(ContentClass::Text, dictionary_class),
            peer.display_planning
                .snapshot(ContentClass::Color, dictionary_class),
        ],
        planning_context: display_planning_context(peer, now_ms, send_buffer_occupied_bytes),
        execution_lane,
    }
}

/// Re-send pacing for this peer, derived from its measured confirmation delay.
///
/// Not from path health: no RTT on `PathHealth` measures how long this peer
/// takes to confirm a datagram, which is the only thing the deadline needs to
/// beat. See `DisplayConfirmDelay`.
#[inline]
pub(crate) fn peer_row_resend_interval_ms(peer: &PeerDisplayState, now_ms: f64) -> f64 {
    let path = peer.paths.get(peer.primary_path(now_ms));
    DisplayPolicy::row_resend_interval_ms(
        peer.display_confirm.ewma_ms,
        peer.display_confirm.jitter_ewma_ms,
        path.network_rtt_ewma_ms,
        path.network_jitter_ewma_ms,
    )
}

/// Where the datagram-lane group that starts at `start` ends, as an exclusive
/// index into `prepared`.
///
/// A group is a run of consecutive datagram-lane frames sharing a utility
/// domain, capped at `group_max`; a jumbo frame takes the reliable lane and
/// ends whatever group precedes it. The group is also the FEC parity unit, so
/// this is the shape of a burst's repair coverage — one pure function that the
/// worker's parity precompute, the owner loop's burst and the tests all read,
/// so the parity shape a test asserts is the parity shape the wire gets.
/// `prepared[start]` must be a datagram-lane frame.
fn fec_group_end(prepared: &[PreparedDisplayDatagram], start: usize, group_max: usize) -> usize {
    debug_assert!(uses_display_datagram(&prepared[start]));
    let utility = prepared[start].utility;
    let cap = group_max.max(1);
    let mut end = start + 1;
    while end < prepared.len()
        && end - start < cap
        && uses_display_datagram(&prepared[end])
        && prepared[end].utility == utility
    {
        end += 1;
    }
    end
}

#[inline]
const fn sealed_display_datagram_wire_len(plaintext_len: usize) -> usize {
    1 + plaintext_len + crate::e2e::FRAME_OVERHEAD
}

#[inline]
fn sent_paths_contains(paths: SentPaths, path: PeerTransport) -> bool {
    match path {
        PeerTransport::WebTransport => paths.webtransport,
        PeerTransport::Edge => paths.edge,
    }
}

/// Reserve one usable carrier from `targets`, retaining path preference while
/// allowing the same immediate fallback the real send would use.
fn reserve_preferred_physical_path(
    budget: &mut DatagramPhysicalBudget,
    paths: &PeerPaths,
    targets: PathTargets,
    wire_len: usize,
    now_ms: f64,
) -> Option<PeerTransport> {
    for target in targets.iter() {
        if budget.reserve(target, wire_len) {
            return Some(target);
        }
    }
    if !targets.is_dual()
        && let Some(fallback) = paths.fallback_for(
            targets.primary(),
            now_ms,
            SessionPolicy::PATH_STALE_THRESHOLD_MS,
        )
        && budget.reserve(fallback, wire_len)
    {
        return Some(fallback);
    }
    None
}

fn other_target(targets: PathTargets, selected: SentPaths) -> Option<PeerTransport> {
    targets
        .iter()
        .find(|target| !sent_paths_contains(selected, *target))
}

/// Exact required physical shape for one candidate FEC group.
///
/// The caller trials this against copies of the burst budget and FEC evidence;
/// no transport state is mutated until the largest fitting prefix is known.
/// One data copy per logical frame and a protectable group's parity are
/// mandatory. Evidence-selected k=1 protection is mandatory as well. A second
/// healthy carrier and a k=1 evidence probe are useful but may consume only
/// capacity left after the complete required prefix has been admitted.
/// Preserve explicit/health-triggered replication, but execute the display
/// planner's size-, queue- and loss-aware winner rather than ranking RTT again.
fn display_path_targets(
    paths: &PeerPaths,
    intent: SendIntent,
    preferred: PeerTransport,
    now_ms: f64,
) -> PathTargets {
    let targets = pick_path(
        paths,
        intent,
        now_ms,
        SessionPolicy::PATH_STALE_THRESHOLD_MS,
    );
    match targets {
        PathTargets::Dual(first, second) if second == preferred => PathTargets::Dual(second, first),
        PathTargets::Dual(..) => targets,
        PathTargets::Single(_) => PathTargets::Single(preferred),
    }
}

fn plan_required_physical_group(
    paths: &PeerPaths,
    preferred: PeerTransport,
    evidence: &mut FecEvidenceByPath,
    group: &[PreparedDisplayDatagram],
    now_ms: f64,
    budget: &mut DatagramPhysicalBudget,
    plans: &mut [PreparedPhysicalDatagramPlan; merkur_fec::FEC_MAX_DATA],
) -> bool {
    debug_assert!(!group.is_empty());
    debug_assert!(group.len() <= merkur_fec::FEC_MAX_DATA);
    plans.fill(PreparedPhysicalDatagramPlan::default());

    let shard_size = group
        .iter()
        .map(|datagram| datagram.frame.len())
        .max()
        .unwrap_or(0);
    let recovery_shards = fec_recovery_shard_count(group.len(), shard_size);

    // Reserve parity first. Critical data can use either carrier, whereas a
    // healthy latency-sensitive repair normally has one preferred carrier;
    // consuming that carrier with optional copies first could manufacture a
    // repair refusal even though the complete group fit.
    if recovery_shards > 0 {
        let repair_plaintext_len = DISPLAY_FEC_HEADER_BYTES + recovery_shards * shard_size;
        let repair_wire_len = sealed_display_datagram_wire_len(repair_plaintext_len);
        let targets = display_path_targets(paths, SendIntent::LatencySensitive, preferred, now_ms);
        let Some(path) =
            reserve_preferred_physical_path(budget, paths, targets, repair_wire_len, now_ms)
        else {
            return false;
        };
        let closer = &mut plans[group.len() - 1];
        closer.repair_paths.mark(path);
        closer.repair_primary = Some(path);
    }

    for (index, datagram) in group.iter().enumerate() {
        let wire_len = sealed_display_datagram_wire_len(datagram.frame.len());
        let targets =
            display_path_targets(paths, datagram.utility.send_intent(), preferred, now_ms);
        let Some(path) = reserve_preferred_physical_path(budget, paths, targets, wire_len, now_ms)
        else {
            return false;
        };
        plans[index].data_paths.mark(path);
        plans[index].data_primary = Some(path);

        if group.len() != 1 || recovery_shards > 0 {
            continue;
        }

        let decision = evidence.get_mut(path).decide_k1();
        if decision == K1ProtectionDecision::Single {
            continue;
        }
        plans[index].k1_protection_path = Some(path);

        // A cross-carrier second copy is strictly stronger than replaying on
        // one lossy carrier and costs the same receiver slot. When it is not
        // available, reserve the evidence controller's exact same-path replay.
        if let Some(secondary) = other_target(targets, plans[index].data_paths)
            && budget.reserve(secondary, wire_len)
        {
            plans[index].data_paths.mark(secondary);
        } else if budget.reserve(path, wire_len) {
            plans[index].replica_path = Some(path);
        } else {
            return false;
        }
        // Probes are optional and are planned in the capacity-left pass;
        // advancing this trial copy makes later singleton requirements exact
        // whether the second copy is cross-carrier or same-path.
        evidence.get_mut(path).record_k1_replica_admitted(false);
    }
    true
}

/// Largest logical prefix whose REQUIRED physical sends fit both carrier byte
/// queues and the browser's reported receive-packet queue.
///
/// A group is at most four data frames, so trying its candidate tail lengths
/// from largest to smallest is bounded constant work. This matters because a
/// shortened group has a different parity width (and a singleton may need a
/// k=1 replica); subtracting an average overhead cannot determine the maximal
/// prefix exactly.
fn plan_required_physical_prefix(
    peer: &PeerDisplayState,
    preferred: PeerTransport,
    prepared: &mut [PreparedDisplayDatagram],
    group_max: usize,
    now_ms: f64,
    budget: &mut DatagramPhysicalBudget,
) -> usize {
    for datagram in prepared.iter_mut() {
        datagram.physical_plan = PreparedPhysicalDatagramPlan::default();
    }

    let paths = peer.paths;
    let mut evidence = peer.display_cache.fec_evidence;
    let mut index = 0usize;
    while index < prepared.len() {
        if !uses_display_datagram(&prepared[index]) {
            prepared[index].physical_plan.data_primary = Some(preferred);
            index += 1;
            continue;
        }

        let group_end = fec_group_end(prepared, index, group_max);
        let group_len = group_end - index;
        let mut admitted_len = 0usize;
        let mut admitted_budget = *budget;
        let mut admitted_evidence = evidence;
        let mut admitted_plans =
            [PreparedPhysicalDatagramPlan::default(); merkur_fec::FEC_MAX_DATA];

        for candidate_len in (1..=group_len).rev() {
            let mut candidate_budget = *budget;
            let mut candidate_evidence = evidence;
            let mut candidate_plans =
                [PreparedPhysicalDatagramPlan::default(); merkur_fec::FEC_MAX_DATA];
            if plan_required_physical_group(
                &paths,
                preferred,
                &mut candidate_evidence,
                &prepared[index..index + candidate_len],
                now_ms,
                &mut candidate_budget,
                &mut candidate_plans,
            ) {
                admitted_len = candidate_len;
                admitted_budget = candidate_budget;
                admitted_evidence = candidate_evidence;
                admitted_plans = candidate_plans;
                break;
            }
        }

        if admitted_len == 0 {
            break;
        }
        for (datagram, plan) in prepared[index..index + admitted_len]
            .iter_mut()
            .zip(admitted_plans)
        {
            datagram.physical_plan = plan;
        }
        *budget = admitted_budget;
        evidence = admitted_evidence;
        index += admitted_len;
        if admitted_len < group_len {
            break;
        }
    }
    index
}

/// Spend only the capacity left AFTER the complete required prefix on
/// redundant path copies and due evidence probes.
fn plan_optional_physical_sends(
    peer: &PeerDisplayState,
    prepared: &mut [PreparedDisplayDatagram],
    group_max: usize,
    now_ms: f64,
    budget: &mut DatagramPhysicalBudget,
) {
    let paths = peer.paths;
    let mut evidence = peer.display_cache.fec_evidence;
    let probe_wire_len =
        sealed_display_datagram_wire_len(STREAM_HEADER_BYTES + FRAME_HEADER_BODY_BYTES);
    let mut index = 0usize;
    while index < prepared.len() {
        if !uses_display_datagram(&prepared[index]) {
            index += 1;
            continue;
        }
        let end = fec_group_end(prepared, index, group_max);

        for datagram in &mut prepared[index..end] {
            // Do not turn a required same-path replay into a third copy. If a
            // cross-path copy fit when protection was planned, it is already
            // represented in data_paths instead of replica_path.
            if datagram.physical_plan.replica_path.is_none() {
                let targets = pick_path(
                    &paths,
                    datagram.utility.send_intent(),
                    now_ms,
                    SessionPolicy::PATH_STALE_THRESHOLD_MS,
                );
                if targets.is_dual()
                    && let Some(path) = other_target(targets, datagram.physical_plan.data_paths)
                    && budget.reserve(path, sealed_display_datagram_wire_len(datagram.frame.len()))
                {
                    datagram.physical_plan.data_paths.mark(path);
                }
            }
        }

        if end - index == 1 {
            let datagram = &mut prepared[index];
            if let Some(path) = datagram.physical_plan.k1_protection_path {
                let decision = evidence.get_mut(path).decide_k1();
                debug_assert_ne!(decision, K1ProtectionDecision::Single);
                let probe_admitted = decision == K1ProtectionDecision::ReplicateAndProbe
                    && budget.reserve(path, probe_wire_len);
                if probe_admitted {
                    datagram.physical_plan.probe_path = Some(path);
                }
                evidence
                    .get_mut(path)
                    .record_k1_replica_admitted(probe_admitted);
            }
        } else {
            let repair_paths = prepared[end - 1].physical_plan.repair_paths;
            if repair_paths.any() {
                let shard_size = prepared[index..end]
                    .iter()
                    .map(|datagram| datagram.frame.len())
                    .max()
                    .unwrap_or(0);
                let recovery_shards = fec_recovery_shard_count(end - index, shard_size);
                let repair_wire_len = sealed_display_datagram_wire_len(
                    DISPLAY_FEC_HEADER_BYTES + recovery_shards * shard_size,
                );
                let targets = pick_path(
                    &paths,
                    SendIntent::LatencySensitive,
                    now_ms,
                    SessionPolicy::PATH_STALE_THRESHOLD_MS,
                );
                if targets.is_dual()
                    && let Some(path) = other_target(targets, repair_paths)
                    && budget.reserve(path, repair_wire_len)
                {
                    prepared[end - 1].physical_plan.repair_paths.mark(path);
                }
            }
        }
        index = end;
    }
}

/// Score the complete actual partition, not a surrogate datagram: data record
/// framing, reliable packetization, each utility-bounded FEC group's actual
/// width/count, all serial carrier hops and recovery tails. Encoding is sunk;
/// browser work is carrier-independent and therefore cancels between routes.
fn prepared_carrier_delivery_us(
    peer: &PeerDisplayState,
    prepared: &[PreparedDisplayDatagram],
    group_max: usize,
) -> f64 {
    let quotes = [PeerTransport::WebTransport, PeerTransport::Edge].map(|carrier| {
        peer.display_planning.carrier_quote(
            usize::from(carrier == PeerTransport::Edge),
            fallback_carrier_quote(peer, carrier, 0),
        )
    });
    let context = PlanningContext {
        datagram_max_payload_bytes: DisplayPolicy::DATAGRAM_MAX_PAYLOAD_BYTES,
        fec_group_size: group_max,
        fec_enabled: true,
        ..PlanningContext::default()
    };
    let mut costs = [0.0f64; 2];
    let mut used = [false; 2];
    let mut recovery_tail_us = 0.0;
    let mut index = 0;
    while index < prepared.len() {
        if !uses_display_datagram(&prepared[index]) {
            let path = usize::from(
                prepared[index].physical_plan.data_primary == Some(PeerTransport::Edge),
            );
            used[path] = true;
            costs[path] +=
                encoded_record_cost_us(prepared[index].frame.len(), quotes[path], context);
            index += 1;
            continue;
        }
        let end = fec_group_end(prepared, index, group_max);
        let mut shard_size = 0;
        let mut loss_upper = 0.0f64;
        let mut one_way_us = 0.0f64;
        for datagram in &prepared[index..end] {
            let path =
                usize::from(datagram.physical_plan.data_primary == Some(PeerTransport::Edge));
            let quote = quotes[path];
            used[path] = true;
            loss_upper = loss_upper.max(quote.loss_upper);
            one_way_us = one_way_us.max(quote.one_way_us);
            shard_size = shard_size.max(datagram.frame.len());
            costs[path] += encoded_record_cost_us(datagram.frame.len(), quote, context);
            // An evidence-mandated same-path replay occupies the primary pacer
            // too. Cross-carrier copies use an independent queue; optional
            // replication cannot postpone the first primary presentation.
            if let Some(replica) = datagram.physical_plan.replica_path {
                let path = usize::from(replica == PeerTransport::Edge);
                used[path] = true;
                costs[path] += quotes[path]
                    .serialization_us(sealed_display_datagram_wire_len(datagram.frame.len()));
            }
        }
        let repair = prepared[end - 1].physical_plan.repair_primary;
        let path = usize::from(
            repair.unwrap_or_else(|| {
                prepared[index]
                    .physical_plan
                    .data_primary
                    .expect("admitted data has a primary")
            }) == PeerTransport::Edge,
        );
        let quote = quotes[path];
        let recovery = fec_recovery_shard_count(end - index, shard_size);
        let repair_bytes = if recovery == 0 {
            0
        } else {
            sealed_display_datagram_wire_len(DISPLAY_FEC_HEADER_BYTES + recovery * shard_size)
        };
        if repair.is_some() {
            used[path] = true;
            costs[path] += quote.serialization_us(repair_bytes);
            loss_upper = loss_upper.max(quote.loss_upper);
            one_way_us = one_way_us.max(quote.one_way_us);
        }
        // A mixed group uses the worst member loss/repair RTT as a conservative
        // tail bound, while its bytes use the actual independently paced paths.
        let tail_quote = CarrierDeliveryQuote {
            loss_upper,
            one_way_us,
            ..quote
        };
        recovery_tail_us += group_close_cost_us(tail_quote, context, end - index, shard_size)
            - tail_quote.serialization_us(repair_bytes);
        index = end;
    }
    (0..2)
        .filter(|path| used[*path])
        .map(|path| quotes[path].fixed_delivery_us() + costs[path])
        .fold(0.0, f64::max)
        + recovery_tail_us
}

/// The actual encoded burst can cross the size knee in either direction. Test
/// both live paths against the exact required-byte/receiver-slot reservation
/// before selecting: a faster quote with insufficient capacity must not scatter
/// the head across paths while a complete schedule fits on the other carrier.
fn prepared_display_transport(
    peer: &PeerDisplayState,
    prepared: &mut [PreparedDisplayDatagram],
    group_max: usize,
    now_ms: f64,
    budget: &DatagramPhysicalBudget,
) -> PeerTransport {
    let mut winner: Option<(PeerTransport, usize, bool, f64)> = None;
    for carrier in display_carriers(peer, now_ms) {
        let mut trial_budget = *budget;
        let admitted = plan_required_physical_prefix(
            peer,
            carrier,
            prepared,
            group_max,
            now_ms,
            &mut trial_budget,
        );
        let complete_on_primary = admitted == prepared.len()
            && prepared.iter().all(|datagram| {
                datagram.physical_plan.data_primary == Some(carrier)
                    && datagram
                        .physical_plan
                        .repair_primary
                        .is_none_or(|path| path == carrier)
            });
        let cost = prepared_carrier_delivery_us(peer, &prepared[..admitted], group_max);
        let candidate = (carrier, admitted, complete_on_primary, cost);
        if winner.is_none_or(|(_, best_admitted, best_complete, best_cost)| {
            admitted > best_admitted
                || (admitted == best_admitted
                    && (complete_on_primary && !best_complete
                        || complete_on_primary == best_complete && cost < best_cost))
        }) {
            winner = Some(candidate);
        }
    }
    // The peer owns an edge coordinate even while both attachments are down;
    // the existing final enqueue/refusal path handles that lifecycle state.
    winner.map_or(PeerTransport::Edge, |(carrier, _, _, _)| carrier)
}

/// Complete post-encode admission for one burst.
///
/// The logical row budget deliberately remains an estimate: compression and
/// utility splitting determine the physical shape only after encoding. This
/// pass is exact. It reserves every physical packet that will actually be
/// submitted, chooses the maximal complete-data prefix, and restamps a clipped
/// presentation as an open continuation before any byte reaches a carrier.
///
/// It also settles `PATCH_FLAG_DEMAND_AWAITS_GRANT` at the send instant. The
/// stamp predicted it at admission, but a grant can land, or the run's free
/// window close, while the worker encodes; and a clipped prefix never carries
/// it, because its remainder follows without a grant.
fn admit_prepared_physical_prefix(
    peer: &mut PeerDisplayState,
    prepared: &mut [PreparedDisplayDatagram],
    frames: &mut BufferPool,
    group_max: usize,
    now_ms: f64,
    budget: &mut DatagramPhysicalBudget,
) -> usize {
    let preferred = prepared_display_transport(peer, prepared, group_max, now_ms, budget);
    let admitted =
        plan_required_physical_prefix(peer, preferred, prepared, group_max, now_ms, budget);
    reclaim_unadmitted_display_suffix(peer, prepared, admitted);
    let awaits_grant = admitted == prepared.len()
        && peer.display_credit.awaits_grant(
            peer.generation,
            now_ms,
            peer.adaptive.presentation_period_ms,
        );
    settle_prepared_awaits_grant(prepared, frames, awaits_grant);
    if admitted < prepared.len() {
        // A precomputed repair covers the old group boundary and exact old
        // plaintext. Clipping may turn k=4 into k=2 or k=1, and opening the
        // presentation changes advisory header bytes. Return every old shard,
        // clear every old FEC mark, then encode only the admitted regrouping.
        for (index, datagram) in prepared.iter_mut().enumerate() {
            if let Some(repair) = datagram.precomputed_fec_repair.take() {
                frames.put(repair);
            }
            datagram.frame[1] &= !DISPLAY_HEADER_FLAG_FEC_PROTECTED;
            mark_presentation_continues(&mut datagram.frame)
                .expect("prepared display datagram has a complete frame header");
            if index < admitted {
                // Unsent rows belong to the next flush's presentation, not
                // phantom missing members of this admitted prefix. Reuse this
                // existing reopen traversal; parity is rebuilt below over the
                // exact restamped bytes before any physical packet is sent.
                datagram.frame[DISPLAY_PRESENTATION_MEMBER_INDEX_OFFSET
                    ..DISPLAY_PRESENTATION_MEMBER_INDEX_OFFSET + 2]
                    .copy_from_slice(&(index as u16).to_be_bytes());
                datagram.frame[DISPLAY_PRESENTATION_MEMBER_COUNT_OFFSET
                    ..DISPLAY_PRESENTATION_MEMBER_COUNT_OFFSET + 2]
                    .copy_from_slice(&(admitted as u16).to_be_bytes());
            }
        }
        precompute_fec_repairs(
            &mut prepared[..admitted],
            group_max,
            peer.generation,
            &mut peer.display_cache.fec_encoder,
            frames,
        );
    }
    plan_optional_physical_sends(peer, &mut prepared[..admitted], group_max, now_ms, budget);
    admitted
}

/// Stamp every prepared frame with the send instant's awaits-grant fact.
/// Parity authenticates the flag byte, so a frame whose flag changes gives up
/// its precomputed repair and the send loop rebuilds parity over the exact
/// restamped bytes. The prediction almost always holds, and then nothing moves.
fn settle_prepared_awaits_grant(
    prepared: &mut [PreparedDisplayDatagram],
    frames: &mut BufferPool,
    awaits_grant: bool,
) {
    let stamped = |datagram: &PreparedDisplayDatagram| {
        datagram.frame[DISPLAY_PATCH_FLAGS_OFFSET] & PATCH_FLAG_DEMAND_AWAITS_GRANT != 0
    };
    if prepared.iter().all(|datagram| stamped(datagram) == awaits_grant) {
        return;
    }
    for datagram in prepared.iter_mut() {
        if let Some(repair) = datagram.precomputed_fec_repair.take() {
            frames.put(repair);
        }
        if awaits_grant {
            datagram.frame[DISPLAY_PATCH_FLAGS_OFFSET] |= PATCH_FLAG_DEMAND_AWAITS_GRANT;
        } else {
            datagram.frame[DISPLAY_PATCH_FLAGS_OFFSET] &= !PATCH_FLAG_DEMAND_AWAITS_GRANT;
        }
    }
}

/// Release only the untouched tail of this exact sequence reservation, before
/// any subsequent reservation or evidence-probe allocation. The preserved
/// prefix includes EVERY attempted frame, including sealing/physical failures.
/// Its data/FEC bytes never change. A post-stop reclaim therefore excludes the
/// complete stopped group, and cannot cross an intervening reservation or an
/// identity that was already admitted to a carrier.
/// The caller owns this reservation linearly: after surrendering its suffix it
/// must not invoke this helper on that suffix again. Both private call sites
/// run before the probe tail can reserve any successor identity.
fn reclaim_unadmitted_display_suffix(
    peer: &mut PeerDisplayState,
    prepared: &[PreparedDisplayDatagram],
    preserved_prefix: usize,
) {
    if preserved_prefix >= prepared.len() {
        return;
    }
    let untouched = &prepared[preserved_prefix..];
    let first = untouched[0].seq;
    let last = untouched[untouched.len() - 1].seq;
    let next = last.wrapping_add(1).max(1);
    let span = last.wrapping_sub(first).wrapping_add(1) - u32::from(last < first);
    let first_is_unsent = peer.last_display_seq_sent == 0
        || (first != peer.last_display_seq_sent
            && first.wrapping_sub(peer.last_display_seq_sent) < 0x8000_0000);
    if peer.next_datagram_seq == next
        && span as usize == untouched.len()
        && first_is_unsent
        && untouched
            .windows(2)
            .all(|pair| pair[0].seq.wrapping_add(1).max(1) == pair[1].seq)
    {
        peer.next_datagram_seq = first;
    }
}

/// Datagram-lane group lengths one burst will emit, in wire order — the shape
/// `fec_group_end` walks, collected for the tests that assert it.
#[cfg(test)]
fn fec_group_lengths(prepared: &[PreparedDisplayDatagram], group_max: usize) -> Vec<usize> {
    let mut lengths = Vec::new();
    let mut index = 0usize;
    while index < prepared.len() {
        if !uses_display_datagram(&prepared[index]) {
            index += 1;
            continue;
        }
        let end = fec_group_end(prepared, index, group_max);
        lengths.push(end - index);
        index = end;
    }
    lengths
}

/// Send every original group without an inter-group scheduling delay. This
/// avoids artificial arrival spread; coherent browser presentation remains a
/// separate receiver transaction, not a promise made by transport batching.
///
/// Groups are sent as contiguous slices of `prepared`, so no datagram is moved
/// into a group vector and no group-length vector is built; the burst walks
/// the same `fec_group_end` boundaries the worker's parity precompute walked.
/// Every frame — and every precomputed repair — goes back to `frames` as it
/// is drained, whether or not the carrier took it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct DisplayBurstOutcome {
    all_sent: bool,
    /// Only new original data/header/jumbo transformations count. Parity,
    /// optional probes and same-sequence replicas cannot consume app epochs.
    original_admitted: bool,
    /// At least one successfully admitted data/jumbo frame carried the
    /// presentation END advisory. FEC parity and k=1 probes never manufacture
    /// this bit.
    presentation_end_admitted: bool,
}

#[inline]
fn prepared_frame_ends_presentation(datagram: &PreparedDisplayDatagram) -> bool {
    datagram
        .frame
        .get(DISPLAY_PATCH_FLAGS_OFFSET)
        .is_some_and(|flags| flags & PATCH_FLAG_PRESENTATION_END != 0)
}

/// A new original became deliverable, either directly or through admitted FEC
/// that can reconstruct it. A coherent positive-member non-END leaves the peer
/// owing an END; an admitted END discharges it. A repair's own envelope, probes
/// and replayed repair records never reach this hook. Physical admission
/// counters stay separate.
fn note_admitted_original_presentation(
    peer: &mut PeerDisplayState,
    datagram: &PreparedDisplayDatagram,
) {
    let flags = datagram
        .frame
        .get(DISPLAY_PATCH_FLAGS_OFFSET)
        .copied()
        .unwrap_or(0);
    if flags & PATCH_FLAG_PRESENTATION_COHERENT == 0 {
        return;
    }
    let count = u16::from_be_bytes(
        datagram.frame[DISPLAY_PRESENTATION_MEMBER_COUNT_OFFSET
            ..DISPLAY_PRESENTATION_MEMBER_COUNT_OFFSET + 2]
            .try_into()
            .unwrap(),
    );
    if count == 0 {
        return;
    }
    peer.presentation_end_owed = flags & PATCH_FLAG_PRESENTATION_END == 0;
}

/// Physical original timing stays separate from logical repair exposure.
fn note_admitted_row_presentation(peer: &mut PeerDisplayState, frame: &PreparedDisplayDatagram) {
    #[cfg(test)]
    if let Some(mut timing) = TEST_ORIGINAL_ADMISSION_TIMING.get() {
        let now = Instant::now();
        timing.first.get_or_insert(now);
        timing.last = Some(now);
        timing.originals += 1;
        TEST_ORIGINAL_ADMISSION_TIMING.set(Some(timing));
    }
    note_exposed_row_presentation(peer, frame);
}

/// Own every row that can reach the receiver, including a refused original
/// made reconstructible by admitted parity. Capture before the ACK record
/// takes the rows. Header-only frames, probes and replicas add no row owner.
fn note_exposed_row_presentation(peer: &mut PeerDisplayState, frame: &PreparedDisplayDatagram) {
    if frame.rows.is_empty() {
        return;
    }
    peer.row_presentation_head = u32::from_be_bytes(
        frame.frame[DISPLAY_PRESENTATION_ID_OFFSET..DISPLAY_PRESENTATION_ID_OFFSET + 4]
            .try_into()
            .expect("an original has a complete display header"),
    );
    for row in frame.rows.iter() {
        let index = usize::from(row.row);
        if index < merkur_codec::MAX_TERMINAL_ROWS {
            peer.unresolved_presentation_rows[index / 64] |= 1u64 << (index % 64);
        } else {
            peer.presentation_row_coverage_overflow = true;
        }
    }
}

/// An exact ACK of the current content's attempt lineage proves state is now
/// owned locally by the receiver, not that it painted. The browser retains any
/// active presentation hold even when a later packet has no unseen predecessor.
fn prune_applied_presentation_rows(peer: &mut PeerDisplayState) {
    for (word_index, word) in peer.unresolved_presentation_rows.iter_mut().enumerate() {
        let mut pending = *word;
        while pending != 0 {
            let bit = pending.trailing_zeros() as usize;
            let row = word_index * 64 + bit;
            if peer.display_cache.sent_row_confirmed.get(row) == Some(&true) {
                *word &= !(1u64 << bit);
            }
            pending &= pending - 1;
        }
    }
}

/// Stamp after carrier-prefix clipping, before sealing. Membership still names
/// the entire prefix if a later physical send fails, so an absent replacement
/// cannot falsely satisfy early supersession. The anchored deadline is unchanged.
fn stamp_row_presentation_predecessor(
    peer: &mut PeerDisplayState,
    prepared: &mut [PreparedDisplayDatagram],
    absolute_rows: &[u64; 4],
    frames: &mut BufferPool,
) {
    if prepared.is_empty() {
        return;
    }
    prune_applied_presentation_rows(peer);
    let mut uncovered = peer.unresolved_presentation_rows;
    for frame in prepared.iter() {
        for row in frame.rows.iter() {
            let index = usize::from(row.row);
            if index < merkur_codec::MAX_TERMINAL_ROWS {
                let bit = 1u64 << (index % 64);
                uncovered[index / 64] &= !(absolute_rows[index / 64] & bit);
            }
        }
    }
    let predecessor = if !peer.presentation_row_coverage_overflow && uncovered == [0; 4] {
        0
    } else {
        peer.row_presentation_head
    };
    let bytes = predecessor.to_be_bytes();
    let promote_singleton = predecessor != 0
        && prepared.iter().any(|frame| {
            frame.frame[DISPLAY_PATCH_FLAGS_OFFSET] & PATCH_FLAG_PRESENTATION_COHERENT == 0
        });
    debug_assert!(!promote_singleton || prepared.len() == 1);
    let changed = prepared.iter().any(|frame| {
        frame.frame[DISPLAY_ROW_PREDECESSOR_PRESENTATION_ID_OFFSET
            ..DISPLAY_ROW_PREDECESSOR_PRESENTATION_ID_OFFSET + 4]
            != bytes
    });
    if !changed && !promote_singleton {
        return;
    }
    // Parity authenticates these exact header bytes too. Invalidate before
    // mutation; the existing send loop rebuilds only physically admitted groups.
    for frame in prepared {
        if let Some(repair) = frame.precomputed_fec_repair.take() {
            frames.put(repair);
        }
        frame.frame[DISPLAY_ROW_PREDECESSOR_PRESENTATION_ID_OFFSET
            ..DISPLAY_ROW_PREDECESSOR_PRESENTATION_ID_OFFSET + 4]
            .copy_from_slice(&bytes);
        if promote_singleton {
            // Unlike a 0/0 K1 probe, this is a complete original whose global
            // cursor/header must wait for unseen rows. Keep it an explicit
            // positive member even when no transport protection was selected.
            frame.frame[DISPLAY_PATCH_FLAGS_OFFSET] |=
                PATCH_FLAG_PRESENTATION_COHERENT | PATCH_FLAG_PRESENTATION_END;
            frame.frame[DISPLAY_PRESENTATION_MEMBER_INDEX_OFFSET
                ..DISPLAY_PRESENTATION_MEMBER_INDEX_OFFSET + 2]
                .copy_from_slice(&0u16.to_be_bytes());
            frame.frame[DISPLAY_PRESENTATION_MEMBER_COUNT_OFFSET
                ..DISPLAY_PRESENTATION_MEMBER_COUNT_OFFSET + 2]
                .copy_from_slice(&1u16.to_be_bytes());
        }
    }
}

fn admission_retry_delay_ms(
    peer: &PeerDisplayState,
    now_ms: f64,
    header_signal: u128,
    urgent: bool,
) -> u64 {
    let retry = &peer.display_admission_retry;
    let fresh_feedback = urgent
        && (peer.latest_input_seq != retry.input_seq || header_signal != retry.header_signal);
    if fresh_feedback {
        0
    } else {
        (retry.until_ms - now_ms).max(0.0).ceil() as u64
    }
}

fn note_zero_progress_admission(peer: &mut PeerDisplayState, now_ms: f64, header_signal: u128) {
    let retry = &mut peer.display_admission_retry;
    retry.failures = retry.failures.saturating_add(1);
    let delay = f64::from(1u32 << retry.failures.saturating_sub(1).min(4))
        .min(peer.adaptive.presentation_period_ms.max(1.0));
    retry.until_ms = now_ms + delay;
    retry.input_seq = peer.latest_input_seq;
    retry.header_signal = header_signal;
}

fn send_unpaced_display_burst(
    peer: &mut PeerDisplayState,
    prepared: &mut Vec<PreparedDisplayDatagram>,
    frames: &mut BufferPool,
    group_max: usize,
    now_ms: f64,
    absolute_rows: &[u64; 4],
) -> DisplayBurstOutcome {
    let last_sent_before = peer.last_display_seq_sent;
    let attempted_header = prepared.first().map_or(0, |frame| frame.header_signal);
    let mut budget = DatagramPhysicalBudget::capture(peer, now_ms);
    let admitted =
        admit_prepared_physical_prefix(peer, prepared, frames, group_max, now_ms, &mut budget);
    stamp_row_presentation_predecessor(peer, &mut prepared[..admitted], absolute_rows, frames);
    let mut all_sent = admitted == prepared.len();
    let mut original_admitted = false;
    let mut presentation_end_admitted = false;
    let mut index = 0usize;
    while index < admitted {
        if !uses_display_datagram(&prepared[index]) {
            let ends_presentation = prepared_frame_ends_presentation(&prepared[index]);
            // A jumbo frame is sealed and queued whole; the ACK does not wait for it.
            peer.egress_hold = None;
            let sent = send_jumbo_display_frame(peer, &mut prepared[index], now_ms);
            all_sent &= sent;
            original_admitted |= sent;
            presentation_end_admitted |= sent && ends_presentation;
            if sent {
                note_admitted_original_presentation(peer, &prepared[index]);
            }
            index += 1;
            continue;
        }
        let end = fec_group_end(&prepared[..admitted], index, group_max);
        let outcome = send_prepared_datagram_group_inner(
            peer,
            &mut prepared[index..end],
            frames,
            now_ms,
            &mut budget,
        );
        all_sent &= outcome.all_sent;
        original_admitted |= outcome.original_admitted;
        presentation_end_admitted |= outcome.presentation_end_admitted;
        // Only an actually protected singleton earns its reserved probe. Keep
        // that ownership in its existing record until ALL original identities
        // have finished admission; a higher probe ID must never overtake a
        // later group and become false packet-threshold evidence against it.
        prepared[index].physical_plan.probe_path = outcome.probe_path;
        index = end;
        if outcome.stop {
            break;
        }
    }
    // A blocked carrier that took any of this burst has taken its one frame.
    for carrier in [PeerTransport::WebTransport, PeerTransport::Edge] {
        if budget.path_reserved_datagrams(carrier) != 0 {
            peer.carrier_blocks.admitted(carrier);
        }
    }
    // A late refusal may stop after preflight reserved more groups. Preserve
    // the entire stopped group (including failures), reclaim only groups never
    // attempted, and do so before any deferred probe consumes a successor ID.
    reclaim_unadmitted_display_suffix(peer, &prepared[..admitted], index);
    // Drained, not consumed: the vector goes back to the prepare pool with its
    // capacity intact, and every frame goes back to the frame pool.
    for (drained_index, mut datagram) in prepared.drain(..).enumerate() {
        if drained_index < index && datagram.physical_plan.probe_path.is_some() {
            send_prepared_k1_probe_tail(peer, &mut datagram, frames, &mut budget, now_ms);
        }
        frames.put(datagram.frame);
        if let Some(repair) = datagram.precomputed_fec_repair {
            frames.put(repair);
        }
    }
    if peer.last_display_seq_sent != last_sent_before {
        // Partial progress and successful alternate-carrier admission both
        // invalidate the observation that this peer cannot enter a carrier.
        peer.display_admission_retry = Default::default();
    } else if !all_sent {
        note_zero_progress_admission(peer, now_ms, attempted_header);
    }
    DisplayBurstOutcome {
        all_sent,
        original_admitted,
        presentation_end_admitted,
    }
}

/// Put one logical redraw on the wire in this turn.
///
/// There is no pacing decision left to make. Inter-group spacing existed as a
/// courtesy to shallow, non-flow-controlled receive queues, expressed as a fixed
/// sleep between groups of four — and a fixed sleep is a guess about a quantity
/// nobody measured. The two queues that actually bind are now both accounted
/// for: this flush was sized against the carrier's real free datagram buffer, so
/// the sender cannot evict its own burst, and the browser's receive queue is
/// declared in `packages/shared` at a depth no legal burst can exceed.
///
/// Inter-group pacing formerly smeared a redraw across network-read turns:
/// each resume rearmed the owner loop's timer, Tokio rounded the deadline up to
/// the next 1 ms tick, and four datagrams per ~1.2 ms arrived separately. Remove
/// that sender-induced spread without coupling datagram correctness or state
/// application to the browser's independently bounded presentation boundary.
fn send_display_burst(
    peer: &mut PeerDisplayState,
    prepared: &mut Vec<PreparedDisplayDatagram>,
    captured_rows: &[DisplayPrepareRow],
    frames: &mut BufferPool,
    now_ms: f64,
) -> DisplayBurstOutcome {
    let mut absolute_rows = [0; 4];
    for row in captured_rows {
        if row.request.force_full && usize::from(row.sent.row) < merkur_codec::MAX_TERMINAL_ROWS {
            let index = usize::from(row.sent.row);
            absolute_rows[index / 64] |= 1u64 << (index % 64);
        }
    }
    send_unpaced_display_burst(
        peer,
        prepared,
        frames,
        DisplayPolicy::FEC_GROUP_MAX_SIZE,
        now_ms,
        &absolute_rows,
    )
}

fn finish_peer_display_flush(
    peer: &mut PeerDisplayState,
    summary: DisplayFlushSummary,
    all_sent: bool,
    had_datagram_sends: bool,
    now_ms: f64,
) {
    peer.record_backpressure(!all_sent);
    peer.display_cache.heartbeat_frames_since_last = peer
        .display_cache
        .heartbeat_frames_since_last
        .saturating_add(1);
    // Only whether there is work to do RIGHT NOW. Rows sent on this flush are
    // unconfirmed but still inside their pacing window, so they deliberately do
    // not raise this flag. What keeps them reachable is `peer_next_flush_delay_ms`
    // reading the cache directly — their re-send deadline when nothing is
    // selectable, `has_selectable_rows` once it passes — so recovery never
    // depends on an edge; the edges that used to supply it (NACK, fence) are
    // gone.
    peer.needs_full_diff = !all_sent || peer.display_cache.has_sendable_rows(now_ms);

    if summary.selected_count > 0 {
        trace!(
            "display delta: peer={} rows={} force_full={}",
            peer.peer_id, summary.selected_count, summary.force_full_count,
        );
    }

    if had_datagram_sends && perf_log_enabled() {
        if let Some(input_to_flush_ms) = summary.input_to_flush_ms {
            info!(
                "perf flush: peer={} input_seq={} input_to_flush_ms={:.1} rows={} bytes={}",
                peer.peer_id,
                summary.input_seq,
                input_to_flush_ms,
                summary.selected_count,
                summary.perf_wire_bytes,
            );
        }
        // Running lifetime totals, so a session answers "how much of what this
        // peer sent was replaced before the browser saw it" without a teardown
        // hook. `superseded_unapplied/sent` is the headline: it is the fraction
        // of row versions that occupied the link and were never rendered.
        let waste = peer.display_cache.waste;
        info!(
            "perf waste: peer={} row_versions_sent={} superseded_unapplied={} \
             superseded_applied={} identical_resends={} stale_prepared_flushes={} \
             bursts_abandoned={} bursts_unsafe_to_rewind={} unapplied_ratio={:.4}",
            peer.peer_id,
            waste.row_versions_sent,
            waste.row_versions_superseded_unapplied,
            waste.row_versions_superseded_applied,
            waste.row_resends_identical,
            waste.stale_prepared_flushes_sent,
            waste.bursts_abandoned,
            waste.bursts_unsafe_to_rewind,
            waste.superseded_unapplied_ratio().unwrap_or(0.0),
        );
    }
}

pub(crate) fn send_peer_datagram_delta_with_worker(
    terminal: &mut TerminalState,
    compressor: &mut Compressor,
    prepare_worker: &mut DisplayPrepareWorker,
    prepare_scratch: &mut PrepareScratch,
    peers: &mut PeerMap,
    peer_id: &str,
    now_ms: f64,
    current_row_hashes: &[u64],
    flush_row_scratch: &mut FlushRowScratch,
    flush_row_cache: &mut HashMap<u16, CapturedRow>,
    allow_header_only_delta: bool,
    perf_timing: &mut PerfTimingTracker,
    perf_flush_started_at: Option<FlushStart>,
) {
    // Borrowed in place rather than taken out and put back. Nothing between
    // here and the end of this function touches `peers`, so the old
    // remove/re-insert pair was pure borrow ceremony that moved the whole
    // multi-kilobyte peer twice and hashed its id twice on every flush — and
    // left the peer missing from the map for the duration, so a future dropped
    // at one of the awaits below would have lost it outright.
    let Some(peer) = peers.get_mut(peer_id) else {
        return;
    };
    if peer.display_prepare_in_flight.is_some() {
        peer.needs_full_diff |= allow_header_only_delta;
        return;
    }
    let dims_ok =
        peer.display_cache.cols == terminal.cols && peer.display_cache.rows == terminal.rows;
    if !dims_ok {
        peer.needs_snapshot = true;
        return;
    }

    peer.display_cache.prune_expired_sent_datagrams(now_ms);

    peer.needs_full_diff = false;
    // A resumed Critical burst can have acknowledged the current header just
    // above. Compare after it finishes so we do not manufacture a redundant
    // header-only packet from the stale pre-resume signal state.
    //
    // One read of the terminal's header serves this whole peer flush: nothing
    // below applies PTY bytes, so the header, its signal and the cursor row
    // cannot change before the frames that carry them are built.
    let head = terminal.display_header_state();
    let header_signal = head.signal;
    let header_changed = header_signal != peer.last_admitted_critical_header_signal;
    let waits_on_grant = peer_waits_on_grant(peer, now_ms);
    let header_exempt = header_changed
        && (!waits_on_grant || header_change_is_grant_exempt(peer, header_signal, current_row_hashes, now_ms));
    // A peer waiting on its browser's next grant with no input to answer, no
    // overdue repair and rows still to send has nothing grant-exempt to do:
    // during a flood this is every PTY read, so it ends before carrier quotes,
    // row selection or capture.
    if waits_on_grant
        && peer.latest_input_seq == peer.last_row_advertised_input_seq
        && peer.latest_input_seq == peer.last_advertised_input_seq
        && !peer.display_cache.has_repair_due_rows(now_ms)
        && !header_exempt
    {
        return;
    }
    let completed_sync_update_epoch = terminal.completed_sync_update_epoch();
    // Refresh attachment-fenced delivery evidence once before selecting the
    // carrier. Exact byte/entry/receiver admission is intentionally deferred
    // until the sealed physical burst exists; turning this advisory free-space
    // value into a synthetic occupancy made an idle queue look busy by its H3
    // header and first Quinn entry, and could rank the wrong carrier.
    let _ = refresh_display_delivery_quotes(peer);
    if display_held(peer, now_ms) {
        // Every live carrier is blocked and holds its one frame. The rows
        // coalesce in the display cache and leave when a carrier reopens.
        peer.needs_full_diff = true;
        return;
    }
    // Relay-specific datagram sizing follows the selected primary carrier, not
    // the mere existence of a standby Edge handle.
    let relayed = display_primary_is_edge(peer, now_ms);
    classify_flush_rows(
        &peer.display_cache,
        current_row_hashes,
        now_ms,
        &mut flush_row_scratch.selection,
    );
    let selected_rows = &mut flush_row_scratch.selection.selected_rows;

    // Rank before budgeting so the budget is spent on the most valuable rows.
    // Both send paths below consume the list already ordered.
    prioritize_display_rows(
        selected_rows,
        head.cursor_row,
        terminal.rows,
        &peer.display_cache.sent_row_hashes,
        current_row_hashes,
    );

    let urgent_shape = selected_rows.is_empty()
        || (selected_rows.len() == 1 && Some(selected_rows[0].row) == head.cursor_row);
    let urgent_feedback = (peer.latest_input_seq != peer.last_row_advertised_input_seq
        && urgent_shape)
        || (header_changed && selected_rows.is_empty());
    if admission_retry_delay_ms(peer, now_ms, header_signal, urgent_feedback) > 0 {
        peer.needs_full_diff = true;
        selected_rows.clear();
        return;
    }

    // The advertised `input_seq` is the browser's causal barrier release: after
    // an unmodelled keystroke it refuses to predict again until authoritative
    // display covers that input. Going silent while it is stale therefore
    // deadlocks prediction — the browser waits for coverage, cannot model the
    // next key, and the daemon reads that as more unmodelled input and revokes
    // prediction safety for the rest of the line.
    //
    // Re-send pacing makes "every row is paced, nothing to send" a routine
    // outcome, which is exactly when this bites. A stale advertisement is
    // itself a reason to emit, and the frame it produces is header-only.
    let input_seq = peer.latest_input_seq;
    let input_seq_stale = input_seq != peer.last_advertised_input_seq;
    // Not `input_seq_stale`: the header-only advertisement that releases the
    // barrier is admitted before the shell's echo is even read, and the echo
    // is still the causal answer to that input.
    let causal_input_advanced = input_seq != peer.last_row_advertised_input_seq;

    // Presentation-bounded delivery (`display::credit`): decided before any
    // capture, so a peer waiting on its browser costs one row census, never a
    // capture, an encode or a datagram. Work that is not a new screen state,
    // and a free output run with nothing banked, is admitted without a grant
    // and stamped with the newest consumed serial.
    let generation = peer.generation;
    let free = peer
        .display_credit
        .run_is_free(now_ms, peer.adaptive.presentation_period_ms);
    let admission = peer.display_credit.admission(
        generation,
        urgent_feedback || selected_rows.is_empty(),
        free,
        peer.presentation_end_owed,
    );
    let causal_cursor_row = causal_input_advanced.then_some(head.cursor_row).flatten();
    match admission {
        DisplayAdmission::State | DisplayAdmission::Exempt => {}
        DisplayAdmission::Continuation { state_first_seq } => {
            retain_rows_unsent_in_state(
                selected_rows,
                &peer.display_cache,
                state_first_seq,
                causal_cursor_row,
            );
        }
        DisplayAdmission::Repair => {
            retain_repair_due_rows(
                selected_rows,
                &peer.display_cache,
                now_ms,
                causal_cursor_row,
            );
            if selected_rows.is_empty() && !header_exempt && !input_seq_stale {
                // Bulk rows wait for the next grant, but their presence must
                // not suppress input coverage or a header change that answers
                // input. Any other header change leaves with the paid state
                // that carries those rows. Do not emit an END solely because
                // blocked rows still owe one.
                return;
            }
        }
    }
    if selected_rows.is_empty()
        && !header_changed
        && !input_seq_stale
        && !peer.presentation_end_owed
    {
        if admission == DisplayAdmission::State {
            peer.display_credit.note_idle();
        }
        return;
    }

    let cursor_row = head.cursor_row;

    // Every exit above this line pops nothing: the buffers are taken only once
    // this flush is going to build something, and returned by whichever arm
    // finishes it — the completion path for an offloaded flush, the end of
    // this function for an inline one.
    let mut buffers = prepare_worker.take_buffers();

    // Convert every selected terminal row exactly once. The same Arc-backed
    // cells drive budget estimation, batch encoding, worker handoff, and ACK
    // provenance; the per-flush cache shares them across peers as well. Rows
    // that would encode to zero bytes are not captured at all.
    capture_prepare_rows(
        terminal,
        peer,
        selected_rows,
        cursor_row,
        &mut flush_row_scratch.capture,
        flush_row_cache,
        &mut buffers.rows,
    );
    // The complete-screen claim of exactly this capture: the rows above and the
    // header every frame of it carries were read from the same terminal state
    // as `current_row_hashes`.
    let closure_digest = terminal.closure_digest(&head.header, current_row_hashes);
    // A grant buys a row-bearing state. Rows that encode to nothing leave a
    // header-only update, which is grant-exempt: a lost one has no row the
    // re-send deadline could repair, so it must never be the state a grant
    // was spent on.
    let new_state = admission == DisplayAdmission::State && !buffers.rows.is_empty();
    let admission = if admission == DisplayAdmission::State && !new_state {
        DisplayAdmission::Exempt
    } else {
        admission
    };
    let demand = if new_state {
        peer.display_credit
            .admit_state(generation, peer.next_datagram_seq, !free)
    } else {
        peer.display_credit.exempt_stamp(generation, !free)
    };
    peer.display_credit.set_current(demand);
    peer.display_credit.note_state_seq(peer.next_datagram_seq);
    // Physical admission happens after exact encode/compression/FEC shape is
    // known. A pre-encode row clip can only guess and used to split a redraw
    // that its compressed representation fit. If exact admission clips the
    // prepared prefix, it restamps the last admitted transform as a bounded
    // continuation and `all_sent=false` re-arms the omitted rows.
    let presentation_continues = false;
    let force_full_count: u32 = buffers
        .rows
        .iter()
        .filter(|row| row.request.force_full)
        .count()
        .min(u32::MAX as usize) as u32;

    let summary = DisplayFlushSummary {
        selected_count: buffers.rows.len().min(u32::MAX as usize) as u32,
        force_full_count,
        perf_wire_bytes: 0,
        input_seq,
        input_to_flush_ms: (peer.last_input_at_ms > 0.0)
            .then_some((now_ms - peer.last_input_at_ms).max(0.0)),
    };

    // The benchmark shows queueing costs more than direct preparation for a
    // one-row update. Keep header-only/one-row work inline and offload the rest.
    if buffers.rows.len() >= DISPLAY_ASYNC_PREPARE_MIN_ROWS {
        let token = prepare_worker.next_token();
        let execution_lane = if display_prepare_is_interactive(buffers.rows.len()) {
            ExecutionLane::Interactive
        } else {
            ExecutionLane::Bulk
        };
        let compression = display_compression_policy(peer, now_ms, relayed, execution_lane, 0);
        let mut header = head.header;
        header.closure_digest = closure_digest;
        header.echo_horizon = peer.echo_horizon;
        header.presentation_coherent = peer.presentation_end_owed;
        header.demand_serial = demand.serial;
        header.demand_limited = demand.limited;
        header.demand_prompt = demand.prompt;
        header.demand_awaits_grant = demand.awaits_grant;
        let request = DisplayPrepareRequest {
            token,
            prepare_epoch: peer.display_prepare_epoch.load(Ordering::Acquire),
            prepare_epoch_fence: Arc::clone(&peer.display_prepare_epoch),
            submitted_at: Instant::now(),
            perf_flush_started_at,
            generation: peer.generation,
            display_revision: terminal.display_revision(),
            completed_sync_update_epoch,
            start_seq: peer.next_datagram_seq,
            start_frame_id: peer.next_frame_id,
            presentation_continues,
            causal_input_advanced,
            input_seq,
            header_signal,
            header_changed,
            header,
            buffers,
            compression,
            compression_dictionary: peer.dictionary.active().cloned(),
            burst_group_max_size: DisplayPolicy::FEC_GROUP_MAX_SIZE,
            summary,
        };
        let send_result = match execution_lane {
            ExecutionLane::Interactive => prepare_worker.interactive_tx.try_send(request),
            ExecutionLane::Bulk => prepare_worker.bulk_tx.try_send(request),
            ExecutionLane::Inline => unreachable!("inline work is not queued"),
        };
        match send_result {
            Ok(()) => {
                peer.display_prepare_in_flight = Some(token);
                peer.display_credit.hold_for_prepare(PreparedDemand {
                    admission,
                    stamp: demand,
                });
                return;
            }
            // Full preparation capacity is scheduling backpressure, not
            // permission to move an O(n²) plan and zstd onto the owner loop.
            // Nothing was admitted, so keep the input/header edge stale and
            // reselect these rows on the next flush.
            Err(refused) => {
                prepare_worker.recycle(refused.into_inner().buffers);
                if new_state {
                    peer.display_credit.refund(generation, demand);
                }
                peer.needs_full_diff = true;
                note_zero_progress_admission(peer, now_ms, header_signal);
                return;
            }
        }
    }

    // With every selected row encoded to zero bytes — or none selected — the
    // header alone goes out when something is waiting on it: the changed
    // header, the `input_seq` advertisement the browser holds its prediction
    // barrier on, or an owed END. Terminal damage is deliberately not a
    // reason: `record_damage` marks the cursor cell dirty on every PTY read,
    // so a read that changed nothing visible — every chunk an application
    // buffers behind BSU, a control reply, an escape the grid ignores —
    // still arrives here as damage with an empty selection, and a header
    // carrying the same header, the same advertisement and no END tells the
    // browser nothing it does not already hold. That was one wasted datagram
    // and one browser apply per PTY read for the whole of a synchronized
    // update. The watermark advances below only after a carrier admits at
    // least one frame; encoding or queueing work is not authoritative
    // feedback.
    let emit_header_only = header_changed || input_seq_stale || peer.presentation_end_owed;
    let prepare_started_at = perf_flush_started_at.map(|_| Instant::now());
    compressor.begin_timing(prepare_started_at.is_some());
    let start_seq = peer.next_datagram_seq;
    build_captured_datagram_batches(
        head,
        terminal,
        peer,
        &buffers.rows,
        closure_digest,
        emit_header_only,
        presentation_continues,
        causal_input_advanced,
        input_seq,
        now_ms,
        compressor,
        prepare_scratch,
        &mut buffers.frames,
        &mut buffers.datagrams,
    );
    let prepare_finished_at = prepare_started_at.map(|_| Instant::now());
    let compression_time = compressor.take_timed_compression();
    let had_datagram_sends = !buffers.datagrams.is_empty();
    let perf_wire_bytes: usize = if perf_log_enabled() {
        buffers.datagrams.iter().map(|d| d.frame.len() + 1).sum()
    } else {
        0
    };
    let summary = DisplayFlushSummary {
        perf_wire_bytes,
        ..summary
    };

    let feedback_row = changed_feedback_row(&buffers.rows, peer, terminal.display_revision());
    if had_datagram_sends {
        let burst_outcome = send_display_burst(
            peer,
            &mut buffers.datagrams,
            &buffers.rows,
            &mut buffers.frames,
            now_ms,
        );
        let actually_sent = burst_outcome.original_admitted;
        note_demand_outcome(peer, generation, admission, demand, &burst_outcome);
        if actually_sent {
            // This is a carrier-admission watermark, not an encode/admission
            // intent watermark. Advancing it before the first successful send
            // makes a zero-budget/refused burst suppress its own retry and can
            // leave the browser's causal prediction fence closed forever.
            peer.last_advertised_input_seq = input_seq;
            if feedback_row.is_some_and(|row| {
                peer.display_cache.sent_row_latest_seq[usize::from(row)] >= start_seq
            }) {
                peer.last_row_advertised_input_seq = input_seq;
            }
            peer.last_admitted_sync_epoch = peer
                .last_admitted_sync_epoch
                .max(completed_sync_update_epoch);
        }
        if actually_sent
            && let (Some(flush), Some(prepare_started_at), Some(prepare_finished_at)) = (
                perf_flush_started_at,
                prepare_started_at,
                prepare_finished_at,
            )
        {
            let sent_at = Instant::now();
            perf_timing.note_display_sent_for(
                &peer.peer_id,
                &peer.signal_session_id,
                input_seq,
                DisplaySendStamps {
                    flush_started_at: flush.at,
                    selection_finished_at: prepare_started_at,
                    prepare_queued_at: prepare_started_at,
                    prepare_started_at,
                    prepare_finished_at,
                    completion_started_at: prepare_finished_at,
                    sent_at,
                    compression_time,
                    presentation_end_admitted: burst_outcome.presentation_end_admitted,
                    flush_owner: flush.owner,
                    sent_owner: crate::perf_timing::owner::stamp(sent_at),
                },
            );
        }
        finish_peer_display_flush(peer, summary, burst_outcome.all_sent, true, now_ms);
    } else {
        if new_state {
            peer.display_credit.refund(generation, demand);
        }
        finish_peer_display_flush(peer, summary, true, false, now_ms);
    }
    prepare_worker.recycle(buffers);
}

/// Settle a burst's grant: refund a new state no carrier admitted, and record
/// whether an admitted state still owes its clipped remainder. The peer's END
/// obligation, read after the burst, is the exact signal that it does.
fn note_demand_outcome(
    peer: &mut PeerDisplayState,
    generation: u32,
    admission: DisplayAdmission,
    stamp: DemandStamp,
    outcome: &DisplayBurstOutcome,
) {
    if !outcome.original_admitted {
        if admission == DisplayAdmission::State {
            peer.display_credit.refund(generation, stamp);
        }
        return;
    }
    let end_owed = peer.presentation_end_owed;
    peer.display_credit
        .note_open_state(generation, admission, !outcome.all_sent, end_owed);
}

/// Keep only rows the open state has not carried yet (its clipped
/// remainder), plus the cursor row when it answers new input. A row the state
/// already carried and that changed since is a new screen state's work.
fn retain_rows_unsent_in_state(
    selected_rows: &mut Vec<DisplayRowRequest>,
    cache: &PerPeerDisplayCache,
    state_first_seq: u32,
    causal_cursor_row: Option<u16>,
) {
    selected_rows.retain(|request| {
        if causal_cursor_row == Some(request.row) {
            return true;
        }
        let latest = cache
            .sent_row_latest_seq
            .get(usize::from(request.row))
            .copied()
            .unwrap_or(0);
        latest == 0 || crate::display::recv::display_seq_is_older(latest, state_first_seq)
    });
}

/// Keep only rows whose newest admitted send is unconfirmed past its measured
/// re-send deadline — repairs of states already admitted against a grant —
/// and the cursor row when it answers new input, which never waits for one.
fn retain_repair_due_rows(
    selected_rows: &mut Vec<DisplayRowRequest>,
    cache: &PerPeerDisplayCache,
    now_ms: f64,
    causal_cursor_row: Option<u16>,
) {
    selected_rows.retain(|request| {
        causal_cursor_row == Some(request.row)
            || cache.row_repair_due(usize::from(request.row), now_ms)
    });
}

/// Only a changed cursor row can consume the cursor-feedback exemption.
/// Background rows and a replay of the pre-input cursor row are not echoes.
/// The caller separately verifies that this row actually entered a carrier.
fn changed_feedback_row(
    rows: &[DisplayPrepareRow],
    peer: &PeerDisplayState,
    display_revision: u64,
) -> Option<u16> {
    if peer.latest_input_seq == peer.last_row_advertised_input_seq
        || display_revision <= peer.latest_input_display_revision
    {
        return None;
    }
    rows.iter()
        .find(|row| {
            row.utility == DisplayUtility::Critical
                && peer
                    .display_cache
                    .sent_row_hashes
                    .get(usize::from(row.sent.row))
                    != Some(&row.sent.hash)
        })
        .map(|row| row.sent.row)
}

/// Open a worker-prepared presentation when newer owner-loop state became
/// known while the worker was encoding it.
///
/// FEC protects the exact plaintext bytes. A frame whose advice changes must
/// therefore relinquish its precomputed parity so the send path regenerates
/// the group from the patched bytes. An already-open transaction retains all
/// of its parity and stays allocation-free here.
fn mark_prepared_datagrams_presentation_continues(
    datagrams: &mut [PreparedDisplayDatagram],
    frames: &mut BufferPool,
) {
    let needs_patch = datagrams.iter().any(|datagram| {
        let flags = datagram.frame[DISPLAY_PATCH_FLAGS_OFFSET];
        flags & PATCH_FLAG_PRESENTATION_COHERENT == 0 || flags & PATCH_FLAG_PRESENTATION_END != 0
    });
    if !needs_patch {
        return;
    }
    // A repair attached to one group closer covers every data frame in that
    // group. Once any member changes, conservatively invalidate all prepared
    // groups; this late-state path is rare and the send loop recomputes only
    // the groups it actually admits.
    let member_count = u16::try_from(datagrams.len())
        .expect("prepared original count is bounded by the terminal row limit");
    for (index, datagram) in datagrams.iter_mut().enumerate() {
        if let Some(repair) = datagram.precomputed_fec_repair.take() {
            frames.put(repair);
        }
        mark_presentation_continues(&mut datagram.frame)
            .expect("prepared display datagram has a complete frame header");
        // A formerly urgent original had 0/0 (no presentation membership).
        // Once newer work opens a coherent continuation it is a real member,
        // not a K1 probe. Stamp all originals in this existing parity-invalidating
        // traversal; exact prefix admission may narrow the membership later.
        datagram.frame[DISPLAY_PRESENTATION_MEMBER_INDEX_OFFSET
            ..DISPLAY_PRESENTATION_MEMBER_INDEX_OFFSET + 2]
            .copy_from_slice(&(index as u16).to_be_bytes());
        datagram.frame[DISPLAY_PRESENTATION_MEMBER_COUNT_OFFSET
            ..DISPLAY_PRESENTATION_MEMBER_COUNT_OFFSET + 2]
            .copy_from_slice(&member_count.to_be_bytes());
    }
}

fn mark_prepared_presentation_continues(buffers: &mut PrepareBuffers) {
    mark_prepared_datagrams_presentation_continues(&mut buffers.datagrams, &mut buffers.frames);
}

pub(crate) async fn finish_display_prepare(
    completion: DisplayPrepareCompletion,
    terminal_revision: u64,
    peers: &mut PeerMap,
    worker: &mut DisplayPrepareWorker,
    now_ms: f64,
    perf_timing_tracker: Option<&mut PerfTimingTracker>,
) {
    let completion_started_at = completion.perf_timing.map(|_| Instant::now());
    let DisplayPrepareCompletion {
        token,
        submitted_at,
        cpu_time,
        perf_timing,
        generation,
        display_revision,
        completed_sync_update_epoch,
        start_seq,
        start_frame_id,
        next_seq,
        next_frame_id,
        dictionary_class,
        compression_dictionary,
        mut buffers,
        summary,
    } = completion;
    // The token names the peer: it is unique across peers and a peer holds at
    // most one, so the scan is bounded by `MAX_CONCURRENT_SESSIONS` and the
    // completion carries no id to hash. A completion nobody claims — the peer
    // was fenced, re-authenticated, or removed while the thread worked — has
    // nothing to do but return its buffers.
    let Some(peer) = peers
        .values_mut()
        .find(|peer| peer.display_prepare_in_flight == Some(token))
    else {
        worker.recycle(buffers);
        return;
    };
    peer.display_prepare_in_flight = None;
    let prepared = peer.display_credit.take_prepare();
    trace!(
        peer = %peer.peer_id,
        cpu_us = cpu_time.as_micros(),
        queue_and_cpu_us = submitted_at.elapsed().as_micros(),
        "display preparation completed off owner loop"
    );

    // The captured baselines are the completion's identity fence. Arc identity
    // detects cell replacement; the revision also detects a loss/resync
    // invalidation that deliberately retains the same immutable cell storage.
    let baseline_matches = buffers.rows.iter().all(|row| {
        let row_index = usize::from(row.sent.row);
        peer.display_cache
            .acked_row_cells
            .get(row_index)
            .zip(peer.display_cache.acked_row_revisions.get(row_index))
            .is_some_and(|(current, revision)| {
                Arc::ptr_eq(current, &row.baseline) && *revision == row.baseline_revision
            })
    });
    let current_ordering_matches = peer.generation == generation
        && peer.next_datagram_seq == start_seq
        && peer.next_frame_id == start_frame_id;
    let dictionary_matches = compression_dictionary
        .as_ref()
        .is_none_or(|prepared| peer.dictionary.retains(prepared));
    if !current_ordering_matches
        || !baseline_matches
        || !dictionary_matches
        || peer.needs_snapshot
        || !peer.is_e2e_ready()
    {
        if let Some(prepared) = prepared
            && prepared.admission == DisplayAdmission::State
        {
            peer.display_credit.refund(generation, prepared.stamp);
        }
        if !peer.needs_snapshot {
            peer.needs_full_diff = true;
        }
        worker.recycle(buffers);
        return;
    }

    let input_seq_advanced = peer.latest_input_seq != summary.input_seq;
    if peer.needs_full_diff || terminal_revision > display_revision || input_seq_advanced {
        // State application remains per datagram. This only prevents the last
        // already-prepared packet from inviting an early browser commit while
        // a follow-up flush is known to be pending. A follow-up that waits for
        // the browser's next grant is still pending: the frame that holds this
        // state issues that grant. A closure-claimed capture is unaffected:
        // its viewer publishes on the claimed content, never on END.
        mark_prepared_presentation_continues(&mut buffers);
    }

    peer.next_datagram_seq = next_seq;
    peer.next_frame_id = next_frame_id;

    if let Some(last) = buffers.datagrams.last() {
        peer.last_wire_bytes = last.frame.len();
        peer.last_compression_ratio = last.frame.len() as f64 / last.raw_bytes.max(1) as f64;
    }
    for datagram in &buffers.datagrams {
        observe_display_compression_outcome(
            peer,
            datagram.frame.len(),
            datagram.raw_bytes,
            datagram.compression_attempted,
            datagram.content_class,
            dictionary_class,
        );
    }

    let had_datagram_sends = !buffers.datagrams.is_empty();
    let input_seq = summary.input_seq;
    let mut actually_sent = false;
    let mut sent_at = None;
    let mut presentation_end_admitted = false;
    let feedback_row = changed_feedback_row(&buffers.rows, peer, display_revision);
    if had_datagram_sends {
        let burst_outcome = send_display_burst(
            peer,
            &mut buffers.datagrams,
            &buffers.rows,
            &mut buffers.frames,
            now_ms,
        );
        actually_sent = burst_outcome.original_admitted;
        presentation_end_admitted = burst_outcome.presentation_end_admitted;
        if let Some(prepared) = prepared {
            note_demand_outcome(
                peer,
                generation,
                prepared.admission,
                prepared.stamp,
                &burst_outcome,
            );
        }
        // This boundary is carrier admission. Keep logging/accounting below
        // outside the measured term, matching the inline path exactly.
        sent_at = perf_timing.map(|_| Instant::now());
        finish_peer_display_flush(peer, summary, burst_outcome.all_sent, true, now_ms);
    } else {
        if let Some(prepared) = prepared
            && prepared.admission == DisplayAdmission::State
        {
            peer.display_credit.refund(generation, prepared.stamp);
        }
        finish_peer_display_flush(peer, summary, true, false, now_ms);
    }
    if actually_sent {
        // A worker completion is only advertised once at least one of its
        // independently applicable frames entered a carrier. The in-flight
        // token suppresses duplicate preparation while encoding; retaining the
        // old watermark here makes an entirely refused completion retryable.
        peer.last_advertised_input_seq = input_seq;
        if feedback_row.is_some_and(|row| {
            peer.display_cache.sent_row_latest_seq[usize::from(row)] >= start_seq
        }) {
            peer.last_row_advertised_input_seq = input_seq;
        }
        if terminal_revision == display_revision {
            peer.last_admitted_sync_epoch = peer
                .last_admitted_sync_epoch
                .max(completed_sync_update_epoch);
        }
    }
    if actually_sent
        && let (Some(timing), Some(completion_started_at), Some(sent_at), Some(tracker)) = (
            perf_timing,
            completion_started_at,
            sent_at,
            perf_timing_tracker,
        )
    {
        tracker.note_display_sent_for(
            &peer.peer_id,
            &peer.signal_session_id,
            input_seq,
            DisplaySendStamps {
                flush_started_at: timing.flush_started_at,
                selection_finished_at: timing.selection_finished_at,
                prepare_queued_at: timing.prepare_queued_at,
                prepare_started_at: timing.prepare_started_at,
                prepare_finished_at: timing.prepare_finished_at,
                completion_started_at,
                sent_at,
                compression_time: timing.compression_time,
                presentation_end_admitted,
                flush_owner: timing.flush_owner,
                sent_owner: crate::perf_timing::owner::stamp(sent_at),
            },
        );
    }
    worker.recycle(buffers);

    if had_datagram_sends && terminal_revision > display_revision {
        // The frames above were built off-loop from a terminal state a later
        // PTY read has already replaced, and they went out regardless — the
        // only response is to re-arm a full diff behind them. Counting it here
        // is the difference between "the pipeline is fast" and "the pipeline is
        // fast at sending work the browser will immediately overwrite".
        peer.display_cache.waste.stale_prepared_flushes_sent += 1;
    }
    if (terminal_revision > display_revision || input_seq_advanced) && !peer.needs_snapshot {
        peer.needs_full_diff = true;
    }
}

/// Publish the prompt anchor when it changes.
///
/// The anchor is the first editable column of the current prompt, captured by
/// the daemon's own emulator at the byte where the shell's OSC 133;B
/// terminated. It exists so the browser can re-seed its speculative line after
/// a mid-line flush: without it, a shell that draws an autosuggestion to the
/// right of the cursor makes the row tail non-blank, and the speculative model
/// cannot re-seed until the next prompt.
///
/// Geometry only. No command text crosses this boundary.
/// Offer every due daemon-interior attribution batch to its exact owner.
///
/// On the CTRL lane rather than a new channel: profiling records are low-rate
/// and a new channel id would have to be agreed across browser, TypeScript
/// protocol, Rust and WASM for no benefit the existing reliable control lane
/// does not already give. One call drains every full batch the reliable lane
/// admits: the tracker's deadline is immediate while a full batch remains and
/// a partial tail rearms for a later maintenance turn, so the only things that
/// bound this loop are the ready queues and actual carrier admission. Offering
/// one batch per turn instead let sustained typing outrun the offer cadence
/// and overflow the display queue. Admission on either carrier is
/// non-awaiting: a full lane restores the exact batch and ends the loop instead
/// of parking the owner loop behind profiling.
pub(crate) fn send_due_perf_timing_batches(
    peer: &mut PeerDisplayState,
    perf_timing: &mut PerfTimingTracker,
    now_ms: f64,
    now: Instant,
) {
    if !perf_timing.owns(&peer.peer_id, &peer.signal_session_id) {
        perf_timing.clear_owner();
        return;
    }
    // Accepting a batch re-arms the deadline at the acceptance instant, so the
    // loop must advance its clock with it or the second batch reads as not
    // yet due and the loop degrades to one batch per offer.
    let mut now = now;
    while let Some(batch) = perf_timing.take_due_wire_batch(now) {
        let body = encode_perf_timing_batch(&batch);
        let Ok(body_len) = u8::try_from(body.len()) else {
            perf_timing.restore_wire_batch(batch, Instant::now());
            return;
        };

        let mut payload: Vec<u8> = Vec::with_capacity(PROTO_HEADER_BYTES + body.len());
        payload.push(MSG_TYPE_PERF_TIMING);
        payload.push(0);
        payload.push(0);
        payload.push(body_len);
        payload.extend_from_slice(&body);

        let Some(payload) = peer.seal_stream(CHANNEL_CTRL, &payload) else {
            perf_timing.restore_wire_batch(batch, Instant::now());
            return;
        };
        let primary = peer.primary_path(now_ms);
        let edge = peer.edge_tunnel.clone();
        let accepted = transport_try_send_maintenance_reliable_with_fallback(
            &peer.paths,
            primary,
            CHANNEL_CTRL,
            ReliablePayload::Heap(payload),
            peer.direct_session.as_ref(),
            edge.as_ref(),
            now_ms,
        );
        let completed_at = Instant::now();
        if !accepted {
            // Admission failed before either persistent reliable lane owned the
            // bytes. Restore the same records in FIFO order and retry after one
            // bounded tail; never spin or silently truncate the distribution.
            perf_timing.restore_wire_batch(batch, completed_at);
            return;
        }
        perf_timing.accept_wire_batch(&batch, completed_at);
        now = completed_at;
    }
    send_perf_egress_if_changed(peer, perf_timing, now_ms);
}

/// Offer the owner's egress snapshot when it changed since the last one a
/// carrier admitted. Rides the same maintenance turn as the timing batches,
/// so each profiled keystroke's batch is followed by the refusals and relay
/// residence accumulated through it. A refused offer retries on the next.
fn send_perf_egress_if_changed(
    peer: &mut PeerDisplayState,
    perf_timing: &mut PerfTimingTracker,
    now_ms: f64,
) {
    let Some(observation_epoch) = perf_timing.observation_epoch() else {
        return;
    };
    let primary = peer.primary_path(now_ms);
    let daemon = match primary {
        PeerTransport::Edge => peer
            .edge_tunnel
            .as_ref()
            .and_then(|tunnel| tunnel.egress_stats()),
        PeerTransport::WebTransport => peer
            .open_direct_session()
            .and_then(|session| session.quic_connection().egress_group())
            .map(|group| group.stats()),
    };
    let edge = peer
        .edge_tunnel
        .as_ref()
        .and_then(|tunnel| tunnel.downstream_delivery_quote())
        .map(|quote| quote.contention);
    let snapshot = PerfEgressSnapshot::new(daemon, edge);
    if !perf_timing.egress_changed(&snapshot) {
        return;
    }
    let body = encode_perf_egress(&snapshot, observation_epoch);
    let payload = encode_proto_frame(MSG_TYPE_PERF_EGRESS, &body);
    let Some(payload) = peer.seal_stream(CHANNEL_CTRL, &payload) else {
        return;
    };
    let edge_tunnel = peer.edge_tunnel.clone();
    if transport_try_send_maintenance_reliable_with_fallback(
        &peer.paths,
        primary,
        CHANNEL_CTRL,
        ReliablePayload::Heap(payload),
        peer.direct_session.as_ref(),
        edge_tunnel.as_ref(),
        now_ms,
    ) {
        perf_timing.accept_egress(snapshot);
    }
}

/// Deliver the link definitions this peer has not received.
///
/// Admission to the persistent reliable lane is the delivery evidence, as for
/// the editor anchor: an undelivered definition costs a link that does not
/// open, never a wrong one, because ids are never reused. The two boundaries
/// that can strand one — a new Noise session and a display snapshot — clear
/// `link_table_sent`, and the next call replaces the browser's table.
pub(crate) fn send_link_table_if_changed(
    terminal: &TerminalState,
    peer: &mut PeerDisplayState,
    now_ms: f64,
) {
    if !peer.authenticated || !peer.is_e2e_ready() || !peer.has_display_counterpart() {
        return;
    }
    let frames = {
        let table = terminal.link_table();
        let current = (table.generation(), table.newest_id());
        let (reset, links) = match peer.link_table_sent {
            Some(sent) if sent == current => return,
            Some((generation, newest)) if generation == current.0 => {
                (false, table.issued_after(newest))
            }
            _ => (true, table.live()),
        };
        // An empty extension is nothing to say. An empty reset is not: it is
        // what stops a browser resolving this daemon's ids against definitions
        // an earlier session left behind.
        if links.is_empty() && !reset {
            peer.link_table_sent = Some(current);
            return;
        }
        (current, encode_link_table_frames(reset, links))
    };
    let (current, frames) = frames;
    for frame in frames {
        let Some(sealed) = peer.seal_stream(CHANNEL_CTRL, &frame) else {
            peer.link_table_sent = None;
            return;
        };
        let primary = peer.primary_path(now_ms);
        let edge = peer.edge_tunnel.clone();
        let sent = transport_send_reliable_with_fallback(
            &mut peer.paths,
            primary,
            CHANNEL_CTRL,
            ReliablePayload::Heap(sealed),
            peer.direct_session.as_ref(),
            edge.as_ref(),
            now_ms,
        );
        if sent.is_none() {
            // A partial extension would leave a gap the next extension skips;
            // a reset cannot.
            peer.link_table_sent = None;
            return;
        }
    }
    peer.link_table_sent = Some(current);
}


/// Current title is repeated at authentication. Transient effects begin at a
/// peer's first ready attachment and are never replayed after reauthentication.
/// With no ready consumers they retire immediately; no offline clipboard history.
pub(crate) fn send_terminal_ui(terminal: &mut TerminalState, peers: &mut PeerMap, now_ms: f64) {
    let ui = terminal.terminal_ui();
    let mut retired = ui.newest;
    for peer in peers.values_mut() {
        if !peer.authenticated || !peer.is_e2e_ready() || !peer.has_display_counterpart() {
            peer.terminal_ui_sent = Some(ui.newest);
            peer.terminal_title_sent = None;
            continue;
        }
        let cursor = *peer.terminal_ui_sent.get_or_insert(ui.newest);
        let send = |peer: &mut crate::connection::PeerDisplayState,
                    effect: &merkur_wire::terminal_ui::TerminalUi| {
            let frame = effect.encode()?;
            let sealed = peer.seal_stream(CHANNEL_CTRL, &frame)?;
            let primary = peer.primary_path(now_ms);
            let edge = peer.edge_tunnel.clone();
            transport_send_reliable_with_fallback(
                &mut peer.paths,
                primary,
                CHANNEL_CTRL,
                ReliablePayload::Heap(sealed),
                peer.direct_session.as_ref(),
                edge.as_ref(),
                now_ms,
            )
        };
        if peer.terminal_title_sent != Some(ui.title_revision) && send(peer, &ui.title).is_some() {
            peer.terminal_title_sent = Some(ui.title_revision);
        }
        for (sequence, effect) in ui.after(cursor) {
            if send(peer, effect).is_none() {
                break;
            }
            peer.terminal_ui_sent = Some(*sequence);
        }
        retired = retired.min(peer.terminal_ui_sent.unwrap_or(cursor));
    }
    ui.retire(retired);
}

/// Offer each browser that can hear it every `merkur open` request it has not
/// been sent and no browser has acknowledged.
///
/// A browser that attaches while a request is unacknowledged is offered it, so
/// a reload or a network switch does not strand a program waiting on a login
/// page; once any browser acknowledges it, no later one is. `open_url_sent` is
/// the newest id sent to the peer, and a new Noise session clears it, because
/// what was sealed under the old one may never have arrived. Called once per
/// owner turn, so a URL printed with no visible output still leaves in the turn
/// that parsed it; with nothing waiting it is one comparison.
pub(crate) async fn send_open_url_requests(
    terminal: &TerminalState,
    peers: &mut PeerMap,
    now_ms: f64,
) {
    let queue = terminal.open_urls();
    let Some(newest) = queue.newest_seq() else {
        return;
    };
    for peer in peers.values_mut() {
        if peer.open_url_sent >= newest
            || !peer.authenticated
            || !peer.is_e2e_ready()
            || !peer.has_display_counterpart()
        {
            continue;
        }
        for request in queue.after(peer.open_url_sent) {
            let body_len = OPEN_URL_ID_BYTES + request.url.len();
            let mut frame = Vec::with_capacity(PROTO_HEADER_BYTES + body_len);
            frame.push(MSG_TYPE_OPEN_URL);
            frame.extend_from_slice(&(body_len as u32).to_be_bytes()[1..]);
            frame.extend_from_slice(&queue.epoch().to_be_bytes());
            frame.extend_from_slice(&request.seq.to_be_bytes());
            frame.extend_from_slice(request.url.as_bytes());
            let Some(sealed) = peer.seal_stream(CHANNEL_CTRL, &frame) else {
                break;
            };
            let primary = peer.primary_path(now_ms);
            let edge = peer.edge_tunnel.clone();
            let sent = transport_send_reliable_with_fallback(
                &mut peer.paths,
                primary,
                CHANNEL_CTRL,
                ReliablePayload::Heap(sealed),
                peer.direct_session.as_ref(),
                edge.as_ref(),
                now_ms,
            );
            if sent.is_none() {
                break;
            }
            peer.open_url_sent = request.seq;
        }
    }
}

/// Encode link definitions into as few CTRL frames as the 24-bit body length
/// allows, flagging only the first frame of a reset. A URI too long for any
/// frame body cannot be defined and its link stays inert in the browser.
fn encode_link_table_frames(reset: bool, links: &[crate::pty::links::LiveLink]) -> Vec<Vec<u8>> {
    const RECORD_HEADER_BYTES: usize = 4 + 4;
    let mut frames = Vec::new();
    let mut frame: Vec<u8> = Vec::new();
    for live in links {
        let uri = live.uri.as_bytes();
        let record_bytes = RECORD_HEADER_BYTES + uri.len();
        if 1 + record_bytes > PROTO_MAX_BODY_BYTES {
            continue;
        }
        if !frame.is_empty()
            && frame.len() - PROTO_HEADER_BYTES + record_bytes > PROTO_MAX_BODY_BYTES
        {
            frames.push(finish_link_table_frame(std::mem::take(&mut frame)));
        }
        if frame.is_empty() {
            frame.extend_from_slice(&[MSG_TYPE_DISPLAY_LINK_TABLE, 0, 0, 0]);
            frame.push(if reset && frames.is_empty() {
                DISPLAY_LINK_TABLE_FLAG_RESET
            } else {
                0
            });
        }
        frame.extend_from_slice(&live.id.to_be_bytes());
        frame.extend_from_slice(&(uri.len() as u32).to_be_bytes());
        frame.extend_from_slice(uri);
    }
    if frame.is_empty() && reset && frames.is_empty() {
        frame.extend_from_slice(&[
            MSG_TYPE_DISPLAY_LINK_TABLE,
            0,
            0,
            0,
            DISPLAY_LINK_TABLE_FLAG_RESET,
        ]);
    }
    if !frame.is_empty() {
        frames.push(finish_link_table_frame(frame));
    }
    frames
}

fn finish_link_table_frame(mut frame: Vec<u8>) -> Vec<u8> {
    let body = (frame.len() - PROTO_HEADER_BYTES) as u32;
    frame[1..PROTO_HEADER_BYTES].copy_from_slice(&body.to_be_bytes()[1..]);
    frame
}

#[cfg(test)]
mod link_table_frame_tests;

pub(crate) fn send_editor_anchor_if_changed(
    terminal: &TerminalState,
    peer: &mut PeerDisplayState,
    now_ms: f64,
) {
    let generation = terminal.editor_anchor_generation();
    if generation == peer.last_editor_anchor_generation {
        return;
    }

    let (row, col, flags) = match terminal.editor_anchor() {
        Some((row, col)) => (row, col, EDITOR_ANCHOR_FLAG_OPEN),
        None => (0, 0, 0),
    };
    const ANCHOR_BODY_LEN: usize = 4 + 2 + 2 + 2;
    let mut payload: Vec<u8> = Vec::with_capacity(PROTO_HEADER_BYTES + ANCHOR_BODY_LEN);
    payload.push(MSG_TYPE_EDITOR_ANCHOR);
    payload.push(0);
    payload.push(0);
    payload.push(ANCHOR_BODY_LEN as u8);
    payload.extend_from_slice(&generation.to_be_bytes());
    payload.extend_from_slice(&row.to_be_bytes());
    payload.extend_from_slice(&col.to_be_bytes());
    payload.extend_from_slice(&flags.to_be_bytes());

    let Some(payload) = peer.seal_stream(CHANNEL_CTRL, &payload) else {
        return;
    };
    let primary = peer.primary_path(now_ms);
    let edge = peer.edge_tunnel.clone();
    let sent = transport_send_reliable_with_fallback(
        &mut peer.paths,
        primary,
        CHANNEL_CTRL,
        ReliablePayload::Heap(payload),
        peer.direct_session.as_ref(),
        edge.as_ref(),
        now_ms,
    );
    if sent.is_some() {
        // Only advance on success: a dropped anchor must be re-offered, or the
        // browser would seed from a prompt that has since moved.
        peer.last_editor_anchor_generation = generation;
    }
}

/// The owner loop's flush turn while a synchronized drain is paused on a partial
/// grid. No display frame may leave until the transaction commits, so only
/// control metadata that describes no grid goes: editor-anchor revocation, and
/// the input-routing word the encoder already uses.
pub(crate) fn send_paused_drain_metadata(
    terminal: &TerminalState,
    peers: &mut PeerMap,
    now_ms: f64,
) {
    for peer in peers.values_mut() {
        send_editor_anchor_if_changed(terminal, peer, now_ms);
        send_input_routing_if_changed(terminal, peer, now_ms);
    }
}

/// Send the input-routing word when it differs from the one this peer holds.
///
/// `admit_user_record` encodes against every mode the paused drain has applied,
/// while the browser learns the mode word from display headers, none of which
/// may leave until the drain commits. Without this, a release pressed under
/// Kitty reporting the drain just enabled waits in the browser's input ring for
/// the whole image validation.
pub(crate) fn send_input_routing_if_changed(
    terminal: &TerminalState,
    peer: &mut PeerDisplayState,
    now_ms: f64,
) {
    // A frame prepared before the pause reserves its sequence when it
    // completes, above the position this word would name, with a header
    // captured before the word: it would release the word to the old modes.
    // The completion schedules the flush turn that sends the word after it.
    if peer.display_prepare_in_flight.is_some() {
        return;
    }
    let word = terminal.input_routing_word();
    if input_routing_delivered(peer) == Some(word) {
        return;
    }
    // Every frame this generation has reserved was captured before the word.
    // No capture runs until the drain commits, so anything captured after it
    // takes a higher sequence or, as a snapshot, opens a newer generation.
    let serial = peer.input_routing_serial.wrapping_add(1).max(1);
    let frame = encode_input_routing_frame(
        peer.generation,
        peer.next_datagram_seq.wrapping_sub(1),
        serial,
        word,
    );
    let Some(payload) = peer.seal_stream(CHANNEL_CTRL, &frame) else {
        return;
    };
    let primary = peer.primary_path(now_ms);
    let edge = peer.edge_tunnel.clone();
    let sent = transport_send_reliable_with_fallback(
        &mut peer.paths,
        primary,
        CHANNEL_CTRL,
        ReliablePayload::Heap(payload),
        peer.direct_session.as_ref(),
        edge.as_ref(),
        now_ms,
    );
    if let Some(path) = sent {
        peer.input_routing_sent = Some((word, path));
        peer.input_routing_serial = serial;
        // The browser's word no longer matches the last admitted header, so the
        // first committed flush re-admits the whole header. That releases the
        // word, and restores the old modes if the rest of the transaction turns
        // these back off.
        peer.last_admitted_critical_header_signal = 0;
    }
}

/// The input-routing word this peer ends up holding, or `None` when nothing
/// says: the last admitted header's, or a routing word sent after it. The
/// browser orders the two by display position, whatever order they land in.
fn input_routing_delivered(peer: &PeerDisplayState) -> Option<u16> {
    match peer.last_admitted_critical_header_signal {
        // Unsent: a routing word superseded the header, or a boundary retired both.
        0 => peer.input_routing_sent.map(|(word, _)| word),
        header => {
            Some(TerminalState::display_header_signal_mode_flags(header) & INPUT_ROUTING_MASK)
        }
    }
}

/// Queue one shared dictionary source for every peer that is currently due.
/// Rows already captured by delta preparation are reused from `flush_row_cache`;
/// only missing rows touch the terminal, and the encode, truncate, finalize and
/// hash all run on the `merkur-display-dict` thread.
///
/// The request slot is checked before anything is captured: while a fenced
/// build still occupies it, the whole-screen capture would only be dropped on
/// the floor by `try_send`. The stale build is consumed by the thread and its
/// completion rejected by token in `finish_dictionary_prepare`.
fn schedule_dictionary_prepare_if_due(
    terminal: &TerminalState,
    worker: &mut DisplayPrepareWorker,
    peers: &PeerMap,
    scratch: &mut RowCaptureScratch,
    flush_row_cache: &mut HashMap<u16, CapturedRow>,
) {
    if worker.dictionary_in_flight.is_some()
        || worker.dictionary_ready.is_some()
        || worker.dictionary_tx.is_full()
    {
        return;
    }
    let any_due = peers.values().any(|peer| {
        peer.authenticated
            && peer.is_e2e_ready()
            && peer.display_dictionary_ready
            && peer.dictionary.build_due()
    });
    if !any_due {
        return;
    }

    let rows = capture_rows(terminal, 0..terminal.rows, scratch, flush_row_cache);
    let token = worker.next_token();
    let request = DictionaryPrepareRequest {
        token,
        display_revision: terminal.display_revision(),
        header: terminal.current_display_header(merkur_codec::FrameKind::Snapshot),
        rows,
    };
    if worker.dictionary_tx.try_send(request).is_ok() {
        worker.dictionary_in_flight = Some(token);
    }
}

fn install_prepared_dictionaries_if_due(
    worker: &mut DisplayPrepareWorker,
    peers: &mut PeerMap,
    now_ms: f64,
) {
    let Some(prepared) = worker.dictionary_ready.take() else {
        return;
    };
    for peer in peers.values_mut() {
        install_display_dictionary_if_due(
            peer,
            Arc::clone(&prepared.source),
            prepared.hash,
            now_ms,
        );
    }
}

/// Install a worker-prepared compression dictionary for this peer, if due.
///
/// The dictionary is not used for compression until the browser acknowledges
/// its id. Reliable display records share a persistent channel stream, but a
/// successful admission/write still proves nothing about browser application,
/// and compression cannot begin until the receiver has installed the exact
/// finalized dictionary named by the frame.
pub(crate) fn install_display_dictionary_if_due(
    peer: &mut PeerDisplayState,
    source: Arc<[u8]>,
    source_hash: u32,
    now_ms: f64,
) {
    if !peer.authenticated
        || !peer.is_e2e_ready()
        || !peer.display_dictionary_ready
        || !peer.dictionary.build_due()
    {
        return;
    }
    let generation = peer.generation;
    let Some(dictionary) = peer
        .dictionary
        .build_next_prepared(generation, source, source_hash)
    else {
        return;
    };

    // [msg_type:1, length_be24:3, generation:4, dict_id:4, dict_hash:4, dict_len:2, bytes]
    let body_len = 4 + 4 + 4 + 2 + dictionary.bytes.len();
    let Ok(dict_len) = u16::try_from(dictionary.bytes.len()) else {
        peer.dictionary.abandon_pending();
        return;
    };
    let mut payload: Vec<u8> = Vec::with_capacity(PROTO_HEADER_BYTES + body_len);
    payload.push(MSG_TYPE_DISPLAY_DICT_INSTALL);
    payload.extend_from_slice(&(body_len as u32).to_be_bytes()[1..4]);
    payload.extend_from_slice(&generation.to_be_bytes());
    payload.extend_from_slice(&dictionary.id.to_be_bytes());
    payload.extend_from_slice(&dictionary.hash.to_be_bytes());
    payload.extend_from_slice(&dict_len.to_be_bytes());
    payload.extend_from_slice(&dictionary.bytes);

    let Some(payload) = peer.seal_stream(CHANNEL_CTRL, &payload) else {
        peer.dictionary.abandon_pending();
        return;
    };
    let primary = peer.primary_path(now_ms);
    let edge = peer.reliable_edge_tunnel();
    let sent = transport_send_reliable_with_fallback(
        &mut peer.paths,
        primary,
        CHANNEL_CTRL,
        ReliablePayload::Heap(payload),
        peer.direct_session.as_ref(),
        edge.as_ref(),
        now_ms,
    );
    if sent.is_none() {
        // Never leave a pending install stranded: without this the peer would
        // hold a dictionary slot forever and never receive another offer.
        peer.dictionary.abandon_pending();
    }
}

fn prepare_display_datagram(
    payload: BatchPayload,
    rows: SentRows,
    terminal_rows: u16,
    peer: &mut PeerDisplayState,
    input_seq: u32,
    now_ms: f64,
    encoded_rows: u16,
    frame_id: u32,
    presentation_id: u32,
    presentation_coherent: bool,
    presentation_end: bool,
    chunk_index: u16,
    chunk_count: u16,
    presentation_member_index: u16,
    presentation_member_count: u16,
    utility: DisplayUtility,
    header_signal: u128,
) -> PreparedDisplayDatagram {
    let seq = peer.next_datagram_seq();
    let BatchPayload {
        mut frame,
        raw_bytes,
        compression,
        content_class,
    } = payload;
    patch_stream_header(
        &mut frame,
        seq,
        peer.generation,
        input_seq,
        frame_id,
        presentation_id,
        presentation_coherent,
        presentation_end,
        chunk_index,
        chunk_count,
        if presentation_coherent {
            presentation_member_index
        } else {
            0
        },
        if presentation_coherent {
            presentation_member_count
        } else {
            0
        },
    )
    .expect("datagram display frame must fit the u16 stream body length");
    let demand = peer.display_credit.current();
    stamp_display_demand(
        &mut frame,
        demand.serial,
        demand.limited,
        demand.prompt,
        demand.awaits_grant,
    )
        .expect("prepared display datagram has a complete frame header");
    let compression_attempted = compression != BatchCompression::NotAttempted;
    // The batcher made the only representation decision while sizing this
    // frame. Never retry compression after the schedule has been chosen.
    peer.last_wire_bytes = frame.len();
    peer.last_compression_ratio = frame.len() as f64 / raw_bytes.max(1) as f64;
    let dictionary_class = if peer.dictionary.active().is_some() {
        DictionaryClass::Finalized
    } else {
        DictionaryClass::Plain
    };
    observe_display_compression_outcome(
        peer,
        frame.len(),
        raw_bytes,
        compression_attempted,
        content_class,
        dictionary_class,
    );

    if raw_bytes >= DISPLAY_DIAGNOSTIC_LARGE_FRAME_BYTES
        || frame.len() >= DISPLAY_DIAGNOSTIC_LARGE_FRAME_BYTES
    {
        let workload = compute_display_workload(
            raw_bytes,
            terminal_rows,
            encoded_rows,
            peer.adaptive.chunk_target_bytes,
            peer.adaptive.snapshot_target_bytes,
            peer.is_recently_interactive(now_ms),
            peer.backpressure_score > 0,
        );
        trace!(
            "display datagram large: peer={} primary_path={:?} rows={} raw_bytes={} wire_bytes={} seq={} frame_id={} workload={:?} compression_ratio={:.3}",
            peer.peer_id,
            peer.primary_path(now_ms),
            encoded_rows,
            raw_bytes,
            frame.len(),
            seq,
            frame_id,
            workload,
            peer.last_compression_ratio,
        );
    }

    PreparedDisplayDatagram {
        seq,
        frame_id,
        raw_bytes,
        encoded_rows,
        utility,
        header_signal,
        frame,
        rows,
        compression_attempted,
        content_class,
        precomputed_fec_repair: None,
        physical_plan: PreparedPhysicalDatagramPlan::default(),
    }
}

/// Capture the requested rows, cells and graphics bytes, for a dictionary build.
/// `flush_row_cache` is refreshed from the terminal's dirty-row hash pass and
/// retained across flushes. A row captured for one peer/batch is therefore
/// shared (refcounted) by every peer, retry, and dictionary build until that
/// row is dirtied and atomically replaced; ACK records keep only its `SentRow`.
pub(crate) fn capture_rows(
    terminal: &TerminalState,
    rows: impl IntoIterator<Item = u16>,
    scratch: &mut RowCaptureScratch,
    flush_row_cache: &mut HashMap<u16, CapturedRow>,
) -> Vec<CapturedRow> {
    let rows = rows.into_iter();
    let mut sent_rows = Vec::with_capacity(rows.size_hint().0);
    for row in rows {
        let sent = flush_row_cache
            .entry(row)
            .or_insert_with(|| terminal.capture_row(row, scratch))
            .clone();
        sent_rows.push(sent);
    }
    sent_rows
}

/// Capture the selected rows for one peer into `out`, cleared first.
///
/// Each row is looked up in the per-flush cache (or converted from the grid
/// once and cached), sized against the peer's acknowledged baseline, and kept
/// only if it would put bytes on the wire. A row whose cells the baseline
/// already matches is dropped here, before either `Arc` is cloned, rather than
/// carried through batching for every consumer to skip again; the delivery
/// domain is stamped now so the batcher never needs the cursor.
fn capture_prepare_rows(
    terminal: &TerminalState,
    peer: &PeerDisplayState,
    rows: &[DisplayRowRequest],
    cursor_row: Option<u16>,
    scratch: &mut RowCaptureScratch,
    flush_row_cache: &mut HashMap<u16, CapturedRow>,
    out: &mut Vec<DisplayPrepareRow>,
) {
    out.clear();
    let cols = usize::from(terminal.cols);
    for request in rows {
        let Some((baseline, &baseline_revision)) = peer
            .display_cache
            .acked_row_cells
            .get(usize::from(request.row))
            .zip(
                peer.display_cache
                    .acked_row_revisions
                    .get(usize::from(request.row)),
            )
        else {
            continue;
        };
        debug_assert_eq!(baseline.len(), cols);
        let sent = flush_row_cache
            .entry(request.row)
            .or_insert_with(|| terminal.capture_row(request.row, scratch));
        let baseline_graphics = peer.display_cache.acked_row_graphics[usize::from(request.row)];
        let (encoded_size, encoding, content, span) = encoded_row_size(
            request,
            baseline,
            &sent.cells,
            baseline_graphics,
            &sent.graphics,
        );
        if encoded_size == 0 {
            continue;
        }
        out.push(DisplayPrepareRow {
            request: *request,
            sent: sent.clone(),
            baseline: Arc::clone(baseline),
            baseline_revision,
            utility: display_row_utility(request.row, cursor_row, terminal.rows),
            encoded_size,
            encoding,
            content,
            span,
        });
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct GroupSendOutcome {
    all_sent: bool,
    original_admitted: bool,
    stop: bool,
    presentation_end_admitted: bool,
    /// Reservation earned by an admitted singleton and its protection. The
    /// burst owner sends it only after the original-send phase has ended.
    probe_path: Option<PeerTransport>,
}

fn build_k1_probe_frame(
    peer: &mut PeerDisplayState,
    template: &PreparedDisplayDatagram,
    frames: &mut BufferPool,
) -> Option<(u32, Vec<u8>)> {
    merkur_codec::parse_stream_header(&template.frame)?;
    let template_header = merkur_codec::parse_frame_header(&template.frame).ok()?;
    let signal = template.header_signal;
    let frame_id = peer.next_frame_id();
    let header = FrameHeader {
        memory_only: template_header.memory_only,
        kind: merkur_codec::FrameKind::Delta,
        cols: (signal >> 80) as u16,
        rows: (signal >> 64) as u16,
        cursor_col: (signal >> 48) as u16,
        cursor_row: (signal >> 32) as u16,
        cursor_shape: (signal >> 24) as u8,
        cursor_visible: (signal >> 16) as u8,
        mode_flags: signal as u16,
        row_count: 0,
        frame_id,
        presentation_id: template_header.presentation_id,
        presentation_member_index: 0,
        presentation_member_count: 0,
        row_predecessor_presentation_id: template_header.row_predecessor_presentation_id,
        // A probe is transport evidence, not latency-sensitive user output.
        // It retains the protected frame's presentation identity and row
        // predecessor, but its 0/0 nonmember pair cannot open or close a
        // transaction. A protected standalone original is stamped as its
        // complete coherent singleton before sealing.
        // Existing multi-member/continuation metadata stays intact. Inheriting
        // the template's END bit would let the header-only probe paint first.
        presentation_coherent: true,
        presentation_end: false,
        chunk_index: 0,
        chunk_count: 1,
        demand_serial: 0,
        demand_limited: false,
        demand_prompt: false,
        demand_awaits_grant: false,
        closure_digest: 0,
        scroll_serial: template_header.scroll_serial,
        echo_horizon: template_header.echo_horizon,
    };
    let mut probe = frames.take(0);
    encode_frame_into(&mut probe, &header, std::iter::empty());
    let seq = peer.next_datagram_seq();
    patch_stream_header(
        &mut probe,
        seq,
        peer.generation,
        0,
        frame_id,
        template_header.presentation_id,
        true,
        false,
        0,
        1,
        0,
        0,
    )
    .expect("fresh k=1 probe frame has a complete stream header");
    Some((seq, probe))
}

fn send_reserved_k1_probe(
    peer: &mut PeerDisplayState,
    template: &PreparedDisplayDatagram,
    path: PeerTransport,
    frames: &mut BufferPool,
    spare_budget: &mut DatagramPhysicalBudget,
    now_ms: f64,
) -> bool {
    let expected_wire_len =
        sealed_display_datagram_wire_len(STREAM_HEADER_BYTES + FRAME_HEADER_BODY_BYTES);
    let Some((seq, probe)) = build_k1_probe_frame(peer, template, frames) else {
        spare_budget.release(path, expected_wire_len);
        return false;
    };
    debug_assert_eq!(probe.len(), STREAM_HEADER_BYTES + FRAME_HEADER_BODY_BYTES);
    let result = match peer.seal_display_wire(&probe) {
        Some(wire) => {
            debug_assert_eq!(wire.len(), expected_wire_len);
            send_exact_path_reserved(
                peer,
                &wire,
                path,
                PhysicalDatagramKind::Probe { seq },
                spare_budget,
            )
        }
        None => {
            spare_budget.release(path, expected_wire_len);
            false
        }
    };
    if result {
        peer.last_datagram_seq = seq;
        peer.note_display_seq_sent(seq);
        peer.display_cache.insert_sent_datagram(
            seq,
            SentDatagram {
                sent_at_ms: now_ms,
                rows: SentRows::default(),
                sent_via: SentPaths::single(path),
                reliable: false,
                header_only: true,
                protection: DisplayDatagramProtection::K1Probe,
            },
        );
    }
    frames.put(probe);
    result
}

/// Complete an earned probe during the burst's existing buffer-recycle pass.
/// This is optional evidence, not user data: refusal leaves its cadence due,
/// without backpressuring originals and replicas that were already admitted.
fn send_prepared_k1_probe_tail(
    peer: &mut PeerDisplayState,
    datagram: &mut PreparedDisplayDatagram,
    frames: &mut BufferPool,
    budget: &mut DatagramPhysicalBudget,
    now_ms: f64,
) {
    if let Some(path) = datagram.physical_plan.probe_path.take()
        && !send_reserved_k1_probe(peer, datagram, path, frames, budget, now_ms)
    {
        peer.display_cache.fec_evidence.get_mut(path).defer_probe();
    }
}

/// Seal and send one FEC group — a contiguous slice of a burst — and the parity
/// behind it. The datagrams' frames stay in `group` for the burst to return to
/// the pool once it has drained; the repair, precomputed or encoded here into
/// a buffer taken from `frames`, goes back to `frames` before this returns.
fn send_prepared_datagram_group_inner(
    peer: &mut PeerDisplayState,
    group: &mut [PreparedDisplayDatagram],
    frames: &mut BufferPool,
    now_ms: f64,
    budget: &mut DatagramPhysicalBudget,
) -> GroupSendOutcome {
    if group.is_empty() {
        return GroupSendOutcome {
            all_sent: true,
            original_admitted: false,
            stop: false,
            presentation_end_admitted: false,
            probe_path: None,
        };
    }
    // The burst plans every admitted datagram before its first send, so later
    // groups' reservations cannot be consumed by an early fallback.
    let planned: &[PreparedDisplayDatagram] = group;
    debug_assert!(
        planned
            .iter()
            .all(|datagram| datagram.physical_plan.data_paths.any()),
        "a group is sent only after the burst planned it"
    );
    debug_assert!(
        group
            .iter()
            .all(|datagram| datagram.utility == group[0].utility),
        "a FEC group must not span utility domains"
    );
    // Parity for this group. The worker precomputes it when it prepared the
    // batch; the inline path computes it here. Either way it goes out
    // immediately behind the data it protects, which is what makes it a
    // zero-round-trip repair rather than another recovery round trip.
    let group_len = group.len();
    let shard_size = group
        .iter()
        .map(|datagram| datagram.frame.len())
        .max()
        .unwrap_or(0);
    let recovery_shard_count = fec_recovery_shard_count(group_len, shard_size);
    let protect_with_fec = recovery_shard_count > 0;
    const { assert!(merkur_fec::FEC_MAX_DATA <= u32::BITS as usize) };
    debug_assert!(
        group_len <= merkur_fec::FEC_MAX_DATA,
        "a FEC group is capped at DisplayPolicy::FEC_GROUP_MAX_SIZE"
    );
    let precomputed_fec_repair = group
        .last_mut()
        .and_then(|datagram| datagram.precomputed_fec_repair.take());
    let mut all_sent = true;
    let mut stop = false;
    let mut original_admitted = false;
    let mut presentation_end_admitted = false;
    let mut original_admitted_mask = 0u32;
    let mut probe_path = None;
    let probe_wire_len =
        sealed_display_datagram_wire_len(STREAM_HEADER_BYTES + FRAME_HEADER_BODY_BYTES);
    for (index, datagram) in group.iter_mut().enumerate() {
        let plan = datagram.physical_plan;
        debug_assert!(plan.data_paths.any());
        if plan.k1_protection_path.is_some()
            && datagram.frame[DISPLAY_PATCH_FLAGS_OFFSET] & PATCH_FLAG_PRESENTATION_COHERENT == 0
        {
            // A reordered K1 probe can open this presentation before its data
            // arrives. Make the standalone original a complete positive member
            // so either arrival order releases at the earliest opportunity.
            // This fixed, uncompressed header is shared by both sealed copies;
            // neither a refused optional probe nor a refused replica can turn
            // the original into an incomplete presentation. A physical K1 group
            // may also belong to a larger coherent presentation: never replace
            // its global membership or reopen/END semantics with singleton ids.
            debug_assert_eq!(group_len, 1);
            debug_assert!(!protect_with_fec);
            datagram.frame[DISPLAY_PATCH_FLAGS_OFFSET] |=
                PATCH_FLAG_PRESENTATION_COHERENT | PATCH_FLAG_PRESENTATION_END;
            datagram.frame[DISPLAY_PRESENTATION_MEMBER_INDEX_OFFSET
                ..DISPLAY_PRESENTATION_MEMBER_INDEX_OFFSET + 2]
                .copy_from_slice(&0u16.to_be_bytes());
            datagram.frame[DISPLAY_PRESENTATION_MEMBER_COUNT_OFFSET
                ..DISPLAY_PRESENTATION_MEMBER_COUNT_OFFSET + 2]
                .copy_from_slice(&1u16.to_be_bytes());
        }
        if protect_with_fec {
            datagram.frame[1] |= DISPLAY_HEADER_FLAG_FEC_PROTECTED;
        }
        // Seal ONCE directly into the final `[channel || counter || ciphertext]`
        // wire bytes so every path in a Redundant race borrows identical bytes.
        // If E2E is not ready the seal returns None and the frame is skipped —
        // no plaintext terminal data is ever emitted.
        let expected_wire_len = sealed_display_datagram_wire_len(datagram.frame.len());
        let Some(wire) = peer.seal_display_wire(&datagram.frame) else {
            release_reserved_paths(budget, plan.data_paths, expected_wire_len);
            if let Some(path) = plan.replica_path {
                budget.release(path, expected_wire_len);
            }
            if let Some(path) = plan.probe_path {
                budget.release(path, probe_wire_len);
            }
            all_sent = false;
            continue;
        };
        let wire_len = wire.len();
        debug_assert_eq!(wire_len, expected_wire_len);
        trace_prepared_member(peer, datagram, wire_len);
        // Critical (cursor row + header) resolves to `SendIntent::Redundant`,
        // which races every live path unconditionally. Duplicating ~200 bytes
        // is far cheaper than any recovery scheme, and combined with idempotent
        // frames it makes cursor echo survive single-path loss with zero
        // recovery latency.
        let send_result = send_reserved_paths(
            peer,
            &wire,
            ReservedPathSend {
                primary: plan.data_primary,
                paths: plan.data_paths,
                kind: PhysicalDatagramKind::Data { seq: datagram.seq },
            },
            now_ms,
            budget,
        );
        let sent_via = send_result.sent_via;
        let sent = sent_via.any();
        all_sent &= sent;
        if !sent {
            warn!(
                "display datagram send failed: peer={} primary_path={:?} edge_present={} seq={} frame_id={} wire_bytes={} raw_bytes={} dirty_rows={}",
                peer.peer_id,
                peer.primary_path(now_ms),
                display_primary_is_edge(peer, now_ms),
                datagram.seq,
                datagram.frame_id,
                datagram.frame.len(),
                datagram.raw_bytes,
                datagram.encoded_rows,
            );
            peer.display_cache.waste.datagram_send_failures += 1;
            stop |= send_result.budget_refused;
            if let Some(path) = plan.replica_path {
                budget.release(path, wire_len);
            }
            if let Some(path) = plan.probe_path {
                budget.release(path, probe_wire_len);
            }
            continue;
        }
        original_admitted = true;
        original_admitted_mask |= 1 << index;
        note_admitted_row_presentation(peer, datagram);
        presentation_end_admitted |= prepared_frame_ends_presentation(datagram);
        note_admitted_original_presentation(peer, datagram);
        let mut protection = if protect_with_fec {
            DisplayDatagramProtection::Fec
        } else {
            DisplayDatagramProtection::Unprotected
        };

        // k=1 protection was selected and prepaid before this burst started.
        // Its evidence owner is independent of how the two copies are sent:
        // `data_paths` carries a cross-carrier pair, while `replica_path`
        // carries an exact same-carrier replay. Only two successful physical
        // copies advance that owner's probe cadence.
        if let Some(k1_protection_path) = plan.k1_protection_path {
            let two_copies_sent = if let Some(planned_replica_path) = plan.replica_path {
                if let Some(actual_path) = sent_via.sole_path() {
                    // A sole planned carrier can fail after admission. Its
                    // released reservation may be transferred to replay the
                    // successful fallback without borrowing a later group's
                    // capacity.
                    let replica_path = if actual_path == planned_replica_path {
                        Some(actual_path)
                    } else {
                        budget.release(planned_replica_path, wire_len);
                        budget.reserve(actual_path, wire_len).then_some(actual_path)
                    };
                    if let Some(replica_path) = replica_path {
                        send_exact_path_reserved(
                            peer,
                            &wire,
                            replica_path,
                            PhysicalDatagramKind::Replica { seq: datagram.seq },
                            budget,
                        )
                    } else {
                        false
                    }
                } else {
                    budget.release(planned_replica_path, wire_len);
                    false
                }
            } else {
                // A cross-carrier k=1 pair is represented entirely in
                // `data_paths`. `any()` is insufficient: one successful leg
                // delivers user data but does not satisfy protection.
                plan.data_paths.sole_path().is_none() && sent_via == plan.data_paths
            };

            if two_copies_sent {
                protection = DisplayDatagramProtection::K1Replicated {
                    owner: k1_protection_path,
                };
                peer.display_cache
                    .fec_evidence
                    .get_mut(k1_protection_path)
                    .record_k1_replica_admitted(plan.probe_path.is_some());
                probe_path = plan.probe_path;
            } else {
                if let Some(path) = plan.probe_path {
                    budget.release(path, probe_wire_len);
                }
                peer.display_cache
                    .fec_evidence
                    .get_mut(k1_protection_path)
                    .defer_probe();
                all_sent = false;
                stop = true;
            }
        }
        record_sent_datagram_with_protection(peer, datagram, now_ms, sent_via, protection);
    }
    // Parity is an admitted member of the group, not a best-effort tail. A
    // transport refusal may still make a data frame an erasure, in which case
    // the already-reserved parity is precisely what repairs it; budget pressure
    // can no longer send FEC-marked data and then refuse its repair.
    if protect_with_fec {
        // The worker's parity, or this turn's, encoded into a pooled buffer
        // either way; it is borrowed for the seal and returned before this
        // group is done with.
        let repair = match precomputed_fec_repair {
            Some(repair) => Some(repair),
            None => {
                let generation = peer.generation;
                let start_seq = group[0].seq;
                let mut payloads = [&[][..]; merkur_fec::FEC_MAX_DATA];
                for (slot, datagram) in payloads.iter_mut().zip(group.iter()) {
                    *slot = &datagram.frame;
                }
                let mut repair = frames.take(0);
                if peer.display_cache.fec_encoder.encode_borrowed_group_into(
                    generation,
                    start_seq,
                    &payloads[..group_len],
                    recovery_shard_count,
                    &mut repair,
                ) {
                    Some(repair)
                } else {
                    frames.put(repair);
                    None
                }
            }
        };
        if let Some(repair) = repair {
            let repair_plan = group[group_len - 1].physical_plan;
            debug_assert!(repair_plan.repair_paths.any());
            let sent = send_reserved_repair_frame(
                peer,
                &repair,
                ReservedPathSend {
                    primary: repair_plan.repair_primary,
                    paths: repair_plan.repair_paths,
                    kind: PhysicalDatagramKind::Repair {
                        batch_start_seq: group[0].seq,
                    },
                },
                now_ms,
                budget,
            );
            if sent.sent_via.any() {
                peer.display_cache.waste.fec_repairs_sent += 1;
                let failed_count = group_len - original_admitted_mask.count_ones() as usize;
                if failed_count != 0 && failed_count <= recovery_shard_count {
                    // Parity carries the failed originals too. Once it makes
                    // them reconstructible, their exact row snapshots must
                    // survive a newer diff/reversion and recovered selective
                    // ACK. These are logical exposures, not fictitious data
                    // sends or path-local loss/RTT evidence.
                    for (index, datagram) in group.iter_mut().enumerate() {
                        if original_admitted_mask & (1 << index) == 0 {
                            record_repair_exposed_original(peer, datagram, now_ms);
                        }
                    }
                    // Replay logical membership in its original order: an
                    // earlier failed non-END must not reopen a later directly
                    // admitted END. The physical outcome flags remain intact.
                    for datagram in group.iter() {
                        note_admitted_original_presentation(peer, datagram);
                    }
                }
            } else {
                peer.display_cache.waste.fec_repairs_refused += 1;
                all_sent = false;
                stop = true;
            }
            frames.put(repair);
        } else {
            let repair_plan = group[group_len - 1].physical_plan;
            let repair_wire_len = sealed_display_datagram_wire_len(
                DISPLAY_FEC_HEADER_BYTES + recovery_shard_count * shard_size,
            );
            release_reserved_paths(budget, repair_plan.repair_paths, repair_wire_len);
            peer.display_cache.waste.fec_repairs_refused += 1;
            all_sent = false;
            stop = true;
        }
    }
    GroupSendOutcome {
        all_sent,
        original_admitted,
        stop,
        presentation_end_admitted,
        probe_path,
    }
}

/// ACK bookkeeping for a frame too large to ride a datagram.
///
/// Jumbo frames are the one remaining display send on the reliable lane: an
/// oversize snapshot chunk physically cannot fit the datagram cap. They record
/// exactly the same `sent_*` state as a datagram so the ACK advances the
/// baseline identically — and so `classify_flush_rows` keeps their rows
/// selected until that ACK lands.
fn record_reliable_display_send(
    peer: &mut PeerDisplayState,
    seq: u32,
    sent_rows: SentRows,
    sent_path: PeerTransport,
    now_ms: f64,
) {
    let resend_interval_ms = peer_row_resend_interval_ms(peer, now_ms);
    peer.display_cache.record_reliable_sent_rows_on_path(
        seq,
        &sent_rows,
        now_ms,
        sent_path,
        resend_interval_ms,
    );
    peer.display_cache.insert_sent_datagram(
        seq,
        SentDatagram {
            sent_at_ms: now_ms,
            rows: sent_rows,
            sent_via: SentPaths::single(sent_path),
            header_only: false,
            reliable: true,
            protection: DisplayDatagramProtection::Unprotected,
        },
    );
    peer.note_display_seq_sent(seq);
}

/// Commit one oversize frame on the reliable lane. The frame buffer stays in
/// `datagram` for the burst to return to the pool; the rows move into the
/// datagram record.
pub(crate) fn send_jumbo_display_frame(
    peer: &mut PeerDisplayState,
    datagram: &mut PreparedDisplayDatagram,
    now_ms: f64,
) -> bool {
    let wire_bytes = datagram.frame.len();
    let seq = datagram.seq;
    let row_count = datagram.rows.len();
    let utility = datagram.utility;
    let header_signal = datagram.header_signal;
    let preferred = datagram
        .physical_plan
        .data_primary
        .expect("jumbo dispatch requires the burst-wide physical admission plan");
    let primary =
        display_path_targets(&peer.paths, SendIntent::Reliable, preferred, now_ms).primary();
    // Jumbo (oversize) delta also rides CHANNEL_DISPLAY_COMMIT (stream lane):
    // seal before send, drop rather than emit plaintext when E2E is not ready.
    // Prefer the confirmed bulk tunnel, else conn1 (see reliable_edge_tunnel).
    let edge = peer.reliable_edge_tunnel();
    let Some(sealed) = peer.seal_stream(CHANNEL_DISPLAY_COMMIT, &datagram.frame) else {
        return false;
    };
    let sent_path = transport_send_reliable_with_fallback(
        &mut peer.paths,
        primary,
        CHANNEL_DISPLAY_COMMIT,
        ReliablePayload::Heap(sealed),
        peer.direct_session.as_ref(),
        edge.as_ref(),
        now_ms,
    );
    if let Some(sent_path) = sent_path {
        peer.carrier_blocks.admitted(sent_path);
        note_admitted_row_presentation(peer, datagram);
        record_reliable_display_send(
            peer,
            datagram.seq,
            std::mem::take(&mut datagram.rows),
            sent_path,
            now_ms,
        );
        if utility == DisplayUtility::Critical {
            // Oversize critical work cannot use a datagram, so the ordered,
            // retransmitted commit lane is its guaranteed-delivery exception
            // to cross-carrier replication.
            peer.last_admitted_critical_header_signal = header_signal;
        }
    } else {
        warn!(
            "display jumbo send failed: peer={} via={:?} seq={} wire_bytes={} rows={}",
            peer.peer_id, primary, seq, wire_bytes, row_count,
        );
    }
    sent_path.is_some()
}

#[cfg(test)]
pub(crate) fn record_sent_datagram(
    peer: &mut PeerDisplayState,
    datagram: &mut PreparedDisplayDatagram,
    now_ms: f64,
    sent_via: SentPaths,
) {
    record_sent_datagram_with_protection(
        peer,
        datagram,
        now_ms,
        sent_via,
        DisplayDatagramProtection::Unprotected,
    );
}

fn record_sent_datagram_with_protection(
    peer: &mut PeerDisplayState,
    datagram: &mut PreparedDisplayDatagram,
    now_ms: f64,
    sent_via: SentPaths,
    protection: DisplayDatagramProtection,
) {
    peer.last_datagram_seq = datagram.seq;
    peer.note_display_seq_sent(datagram.seq);
    if datagram.utility == DisplayUtility::Critical {
        peer.last_admitted_critical_header_signal = datagram.header_signal;
    }
    record_display_datagram_snapshot(peer, datagram, now_ms, sent_via, protection);
}

/// The repair actually entered a carrier and can reconstruct this original,
/// whose own send failed. Preserve state/ACK/high-water ownership without
/// inventing original bytes, original-carrier evidence or physical admission.
fn record_repair_exposed_original(
    peer: &mut PeerDisplayState,
    datagram: &mut PreparedDisplayDatagram,
    now_ms: f64,
) {
    note_exposed_row_presentation(peer, datagram);
    peer.note_display_seq_sent(datagram.seq);
    record_display_datagram_snapshot(
        peer,
        datagram,
        now_ms,
        SentPaths::default(),
        DisplayDatagramProtection::Fec,
    );
}

fn record_display_datagram_snapshot(
    peer: &mut PeerDisplayState,
    datagram: &mut PreparedDisplayDatagram,
    now_ms: f64,
    sent_via: SentPaths,
    protection: DisplayDatagramProtection,
) {
    let resend_interval_ms = peer_row_resend_interval_ms(peer, now_ms);
    let header_only = datagram.rows.is_empty();
    // The rows move into the record as they are — inline for a datagram
    // batch — so the send side allocates nothing for them and the ACK side
    // frees nothing.
    let rows = std::mem::take(&mut datagram.rows);
    peer.display_cache.record_sent_rows_on_paths(
        datagram.seq,
        &rows,
        now_ms,
        sent_via,
        resend_interval_ms,
    );
    peer.display_cache.insert_sent_datagram(
        datagram.seq,
        SentDatagram {
            sent_at_ms: now_ms,
            header_only,
            rows,
            sent_via,
            reliable: false,
            protection,
        },
    );
}

/// What one compression attempt produced. The compressed frame itself lives in
/// the `out` buffer the attempt was given.
struct DisplayCompressionOutcome {
    /// Whether the admission policy decided to use the compressed frame.
    used: bool,
    /// `compressed / raw` actually achieved, when compression ran at all.
    ///
    /// Reported even when admission rejected the result. The batcher sizes the
    /// next batch from what compression *achieves*, not from what admission
    /// *keeps* — otherwise the estimate cannot bootstrap: a single wide
    /// coloured row is all the window the compressor gets, it saves too little
    /// to be worth sending, the ratio never leaves 1.0, and the batcher never
    /// packs the larger unit that would have compressed well.
    achieved_ratio: Option<f64>,
}

impl DisplayCompressionOutcome {
    /// Compression did not run: nothing to use, nothing learned.
    const NOTHING: Self = Self {
        used: false,
        achieved_ratio: None,
    };
}

pub(crate) fn schedule_pending_snapshots(
    terminal: &mut TerminalState,
    buffers: &mut BufferPool,
    peers: &mut PeerMap,
    now_ms: f64,
    current_row_hashes: &mut Vec<u64>,
    worker: &mut DisplayPrepareWorker,
) {
    let mut needs: Vec<Arc<str>> = peers
        .values()
        .filter(|peer| peer_snapshot_due(peer, now_ms))
        .map(|peer| Arc::clone(&peer.peer_id))
        .collect();
    needs.sort_unstable();
    needs.truncate(DISPLAY_PEERS_PER_FLUSH);
    if needs.is_empty() {
        return;
    }
    let buffer = buffers.take(terminal.rows as usize * terminal.cols as usize * 4);
    let mut snapshot_grid: Vec<CellRepr> = Vec::new();
    let mut snapshot_graphics = Vec::new();
    // Captured with the grid, from the same exclusive hold on terminal state
    // that produces the frame, so it describes the header this snapshot
    // actually carries rather than whatever the header is by the time the last
    // chunk is acknowledged.
    let snapshot_header_signal = terminal.current_display_header_signal();
    let (snapshot, _encoded_rows) = terminal.encode_snapshot_state_into(
        buffer,
        &mut snapshot_grid,
        current_row_hashes,
        &mut snapshot_graphics,
    );
    let content_class = classify_snapshot_content(&snapshot_grid);
    let token = worker.next_token();
    let mut peer_plans = Vec::with_capacity(needs.len());
    for peer_id in &needs {
        let Some(peer) = peers.get_mut(peer_id) else {
            continue;
        };
        // Reliable snapshots have no datagram-budget read to piggyback on, so
        // refresh their complete carrier quote explicitly before planning.
        let _ = refresh_display_delivery_quotes(peer);
        let mut context = display_planning_context(peer, now_ms, 0);
        context.fec_enabled = false;
        peer_plans.push(SnapshotPeerPlan {
            peer_id: Arc::clone(peer_id),
            prepare_epoch: peer.display_prepare_epoch.load(Ordering::Acquire),
            prepare_epoch_fence: Arc::clone(&peer.display_prepare_epoch),
            profile: peer
                .display_planning
                .snapshot(content_class, DictionaryClass::Plain),
            context,
        });
    }
    if peer_plans.is_empty() {
        buffers.put(snapshot);
        return;
    }
    let request = SnapshotPrepareRequest {
        token,
        submitted_at: Instant::now(),
        display_revision: terminal.display_revision(),
        completed_sync_update_epoch: terminal.completed_sync_update_epoch(),
        cols: terminal.cols,
        rows: terminal.rows,
        header_signal: snapshot_header_signal,
        content_class,
        snapshot,
        snapshot_grid,
        snapshot_graphics,
        row_hashes: current_row_hashes.clone(),
        peers: peer_plans,
    };
    match worker.snapshot_tx.try_send(request) {
        Ok(()) => {
            for peer_id in needs {
                if let Some(peer) = peers.get_mut(&peer_id)
                    && peer_snapshot_due(peer, now_ms)
                {
                    peer.display_prepare_in_flight = Some(token);
                    // The snapshot re-roots every row this peer shows, so the
                    // link table it resolves them against is re-rooted too.
                    peer.link_table_sent = None;
                }
            }
        }
        Err(refused) => buffers.put(refused.into_inner().snapshot),
    }
}

#[inline]
fn peer_snapshot_due(peer: &PeerDisplayState, now_ms: f64) -> bool {
    peer.authenticated
        && peer.is_e2e_ready()
        && peer.needs_snapshot
        && peer.display_prepare_in_flight.is_none()
        && now_ms >= peer.snapshot_retry_at_ms
        && !peer.resume_waiting_for_data
        && peer
            .awaiting_resume_until_ms
            .is_none_or(|deadline| now_ms >= deadline)
        && !display_held(peer, now_ms)
}

#[cfg(test)]
enum SnapshotPeerSelection<'a> {
    One(&'a str),
    Many(&'a [Arc<str>]),
}

#[cfg(test)]
fn pending_snapshot_peer_ids(
    peers: &PeerMap,
    now_ms: f64,
    allowed_peer_ids: SnapshotPeerSelection<'_>,
) -> Vec<Arc<str>> {
    let allowed: Vec<&str> = match allowed_peer_ids {
        SnapshotPeerSelection::One(peer_id) => vec![peer_id],
        SnapshotPeerSelection::Many(peer_ids) => peer_ids.iter().map(AsRef::as_ref).collect(),
    };
    allowed
        .into_iter()
        .filter_map(|peer_id| {
            peers
                .get(peer_id)
                .filter(|peer| peer_snapshot_due(peer, now_ms))
                .map(|peer| Arc::clone(&peer.peer_id))
        })
        .collect()
}

pub(crate) async fn finish_snapshot_prepare(
    completion: SnapshotPrepareCompletion,
    terminal_revision: u64,
    buffers: &mut BufferPool,
    peers: &mut PeerMap,
    now_ms: f64,
) {
    let SnapshotPrepareCompletion {
        token,
        submitted_at,
        cpu_time,
        display_revision,
        completed_sync_update_epoch,
        cols,
        rows,
        header_signal,
        content_class,
        snapshot,
        snapshot_grid,
        snapshot_graphics,
        row_hashes,
        raw_chunks,
        compressed_chunks,
        compression_attempted,
        peers: peer_plans,
    } = completion;
    trace!(
        cpu_us = cpu_time.as_micros(),
        queue_and_cpu_us = submitted_at.elapsed().as_micros(),
        peer_count = peer_plans.len(),
        "shared display snapshot prepared off owner loop"
    );
    let chunk_count = u16::try_from(raw_chunks.len()).expect("snapshot chunk count must fit u16");
    for plan in peer_plans {
        let Some(peer) = peers.get_mut(&plan.peer_id) else {
            continue;
        };
        if peer.display_prepare_in_flight != Some(token) {
            continue;
        }
        peer.display_prepare_in_flight = None;
        if !peer.authenticated || !peer.is_e2e_ready() || !peer.needs_snapshot {
            continue;
        }
        if terminal_revision > display_revision {
            // Never replace the browser with a stale full-grid image merely
            // because preparation lost a race with a PTY mutation. Keep the
            // snapshot armed for the next owner turn; no sequence, frame id,
            // generation, or carrier byte was consumed.
            peer.snapshot_retry_at_ms = 0.0;
            continue;
        }

        let mut selected_bytes = 0usize;
        for (index, raw) in raw_chunks.iter().enumerate() {
            let compressed = compressed_chunks.get(index).and_then(Option::as_ref);
            if compression_attempted.get(index).copied().unwrap_or(false) {
                peer.display_planning.observe_ratio(
                    raw.len(),
                    content_class,
                    DictionaryClass::Plain,
                    compressed.map_or(1.0, |frame| frame.len() as f64 / raw.len().max(1) as f64),
                );
            }
            let use_compressed = compressed.is_some_and(|frame| {
                choose_after_compression(
                    plan.profile,
                    raw.len(),
                    frame.len(),
                    DictionaryClass::Plain,
                    plan.context,
                ) == Representation::Compressed
            });
            selected_bytes = selected_bytes.saturating_add(if use_compressed {
                compressed.map_or(raw.len(), Vec::len)
            } else {
                raw.len()
            });
        }

        let input_seq = peer.latest_input_seq;
        let generation = peer.next_generation();
        // Reliable snapshot chunks are one assembled display frame. Give that
        // frame one non-zero identity, shared by every chunk, just like the
        // generation and causal input watermark. Zero is the browser's
        // no-provenance sentinel; stamping it here made every real recovery
        // snapshot poison presentation telemetry and weakened the assembly key.
        // Presentation identity remains advisory and does not change reliable
        // chunk assembly, application, ACK, repair, or loss semantics.
        let snapshot_frame_id = peer.next_frame_id();
        peer.display_cache.resize(cols, rows);
        let mut preferred = planned_display_transport(peer, now_ms, selected_bytes, 0);
        let mut accepted_path = None;
        let edge = peer.reliable_edge_tunnel();
        let mut sent = true;
        let mut plaintext = Vec::new();
        for (chunk_index, raw) in raw_chunks.iter().enumerate() {
            let compressed = compressed_chunks.get(chunk_index).and_then(Option::as_ref);
            let selected = compressed
                .filter(|frame| {
                    choose_after_compression(
                        plan.profile,
                        raw.len(),
                        frame.len(),
                        DictionaryClass::Plain,
                        plan.context,
                    ) == Representation::Compressed
                })
                .unwrap_or(raw);
            plaintext.clear();
            plaintext.extend_from_slice(selected);
            patch_stream_header(
                &mut plaintext,
                0,
                generation,
                input_seq,
                snapshot_frame_id,
                snapshot_frame_id,
                false,
                true,
                chunk_index as u16,
                chunk_count,
                0,
                0,
            )
            .expect("prepared snapshot chunk must fit the stream body length");
            let mut frame = vec![0; plaintext.len() + crate::e2e::FRAME_OVERHEAD];
            let Some(sealed_len) =
                peer.seal_stream_into(CHANNEL_DISPLAY_COMMIT, &plaintext, &mut frame)
            else {
                sent = false;
                break;
            };
            frame.truncate(sealed_len);
            let chunk_sent = transport_send_reliable_with_fallback(
                &mut peer.paths,
                preferred,
                CHANNEL_DISPLAY_COMMIT,
                ReliablePayload::Heap(frame),
                peer.direct_session.as_ref(),
                edge.as_ref(),
                now_ms,
            );
            let Some(path) = chunk_sent else {
                sent = false;
                break;
            };
            preferred = path;
            accepted_path = Some(path);
        }
        if let Some(path) = accepted_path {
            peer.carrier_blocks.admitted(path);
        }
        peer.record_backpressure(!sent);
        if sent {
            let was_failing = peer.snapshot_consecutive_failures > 0;
            peer.snapshot_consecutive_failures = 0;
            peer.snapshot_retry_at_ms = 0.0;
            peer.display_cache
                .prime_from_snapshot(&snapshot_grid, &row_hashes, &snapshot_graphics);
            peer.last_admitted_critical_header_signal = header_signal;
            peer.last_admitted_sync_epoch = peer
                .last_admitted_sync_epoch
                .max(completed_sync_update_epoch);
            peer.needs_snapshot = false;
            peer.needs_full_diff = terminal_revision > display_revision;
            peer.awaiting_resume_until_ms = None;
            info!(
                "display snapshot sent: peer={} via={:?} bytes={} chunks={}{}",
                peer.peer_id,
                accepted_path.unwrap_or(preferred),
                selected_bytes,
                chunk_count,
                if was_failing { " (recovered)" } else { "" },
            );
        } else {
            peer.snapshot_consecutive_failures =
                peer.snapshot_consecutive_failures.saturating_add(1);
            let exp = peer.snapshot_consecutive_failures.min(5);
            let backoff_ms = (250.0 * (1u32 << (exp - 1)) as f64).min(5000.0);
            peer.snapshot_retry_at_ms = now_ms + backoff_ms;
            if peer.snapshot_consecutive_failures == 1 {
                warn!(
                    "display snapshot send failing: peer={} via={:?} bytes={} chunks={}",
                    peer.peer_id, preferred, selected_bytes, chunk_count,
                );
            }
        }
    }
    buffers.put(snapshot);
}

/// Milliseconds until the owner loop's flush timer must next fire, or `None`
/// when no E2E-ready peer has anything now or later and the timer may park.
///
/// One evaluation per peer, from which the owner loop takes three readings:
/// `None` means park, `Some(0)` means wake now, `Some(delay)` means sleep
/// exactly that long. The minimum across peers wins, so the most eager peer
/// sets the deadline.
pub(crate) fn compute_next_flush_delay_ms(
    peers: &PeerMap,
    terminal_damage: PendingDisplayDamage,
    header_signal: u128,
    current_row_hashes: &[u64],
    now_ms: f64,
) -> Option<u64> {
    peers
        .values()
        .filter_map(|peer| {
            peer_next_flush_delay_ms(
                peer,
                terminal_damage,
                header_signal,
                current_row_hashes,
                now_ms,
            )
        })
        .min()
}

/// One peer's next flush deadline, or `None` when it has nothing now or later.
///
/// The three outcomes are readings of one evaluation, not three predicates:
///
/// - not display-ready → `None`, whatever state it holds. `needs_snapshot` is
///   armed during authentication, before Noise completes, and treating it as
///   scheduled made the owner wake every normal flush interval merely to
///   rediscover the E2E gate. A successful `noise_final` is the one explicit
///   wake edge for a peer becoming display-ready.
/// - awaiting the client's DISPLAY_RESUME decision → its deadline. The gate
///   is a one-shot scheduling edge: the loop must not wake at display cadence
///   while it is closed, and at the deadline the owner converts it into
///   ordinary snapshot work whose retry backoff then governs.
/// - a reason to emit → the coalescing delay, floored by what the enforcers
///   published. This is where the resend deadline used to be `.max()`ed in:
///   a row already on the wire and inside its pacing window stretched the
///   delay of a peer that had something ELSE to send — a clipped repaint's
///   remainder, a header-only advertisement, damage raised without a PTY
///   read — to that row's deadline, so a large screen advanced one flush
///   budget per `ROW_RESEND_MIN_MS` and painted in visible blocks. A paced
///   row is skipped by selection; it is never a reason to wait.
/// - nothing to emit → the earliest re-send deadline among unconfirmed rows,
///   if any. That row becomes selectable the instant it passes, with no ACK,
///   NACK, damage or flag required, and it is the deadline that keeps a
///   just-flushed peer scheduled: every row it sent is unconfirmed and paced,
///   so nothing is selectable, and without this arm a lost datagram stranded
///   the row until the digest backstop.
///
/// The coalescing delay is `compute_display_flush_delay_ms` — 0 for drained
/// causal/header feedback, the normal interval for later output in the same
/// interactive window — or, for a
/// passive peer that published a transport hint, the hint's REMAINDER since
/// the last flush. A hint is a minimum spacing between flushes, not a sleep
/// from now: sleeping the whole interval from the moment the timer is armed
/// held every passive flush a full hint late.
///
/// The floors are the rate enforcer's published `rate_defer_until_ms` (or the
/// rate interval's remainder when it has not deferred; this call has no
/// selected row set and passes 0, which is the one input
/// `datagram_rate_interval_ms` branches on for an interactive peer, so the
/// interval cannot be re-derived here) and the snapshot retry backoff. Both
/// apply to the re-send deadline too, so a deferred peer is never woken
/// inside its own deferral.
fn peer_next_flush_delay_ms(
    peer: &PeerDisplayState,
    terminal_damage: PendingDisplayDamage,
    header_signal: u128,
    current_row_hashes: &[u64],
    now_ms: f64,
) -> Option<u64> {
    if !peer_display_ready(peer) {
        return None;
    }
    // Held display waits for the exact reopening, which wakes the owner
    // (`CARRIER_UNBLOCKED`); no clock stands in for it.
    if display_held(peer, now_ms) {
        return None;
    }
    if let Some(deadline_ms) = peer.awaiting_resume_until_ms {
        if peer.resume_waiting_for_data {
            return None;
        }
        return Some((deadline_ms - now_ms).max(0.0).ceil() as u64);
    }
    let snapshot_backoff_delay = if peer.needs_snapshot && peer.snapshot_retry_at_ms > now_ms {
        (peer.snapshot_retry_at_ms - now_ms).ceil() as u64
    } else {
        0
    };
    if !peer.needs_snapshot && peer_waits_on_grant(peer, now_ms) {
        // Waiting on the browser's next display grant, which is itself the
        // wakeup for new screen states. Only grant-exempt work wakes the owner:
        // input-caused urgent feedback, a header change the paid state will
        // not carry, and repair of a row whose newest admitted send is overdue.
        if (header_signal != peer.last_admitted_critical_header_signal
            && header_change_is_grant_exempt(peer, header_signal, current_row_hashes, now_ms))
            || peer.latest_input_seq != peer.last_advertised_input_seq
            || scheduler_urgent_feedback(
                peer,
                terminal_damage,
                header_signal,
                current_row_hashes,
                now_ms,
            )
        {
            return Some(admission_retry_delay_ms(peer, now_ms, header_signal, true));
        }
        // Input whose echo may be among bulk rows: the flush sends the
        // input-caused cursor row without a grant. New row damage or a cursor
        // row already selectable is what it could send; a flush consumes the
        // damage, so this cannot re-arm itself.
        if peer.latest_input_seq != peer.last_row_advertised_input_seq
            && (terminal_damage.rows != PendingRowDamage::None
                || terminal_damage.cursor_row.is_some_and(|row| {
                    peer.display_cache
                        .row_selectable(usize::from(row), current_row_hashes, now_ms)
                }))
        {
            return Some(admission_retry_delay_ms(peer, now_ms, header_signal, true));
        }
        if peer.display_cache.has_repair_due_rows(now_ms) {
            return Some(admission_retry_delay_ms(peer, now_ms, header_signal, false));
        }
        return peer
            .display_cache
            .next_row_resend_due_ms(now_ms)
            .map(|due_ms| (due_ms - now_ms).max(0.0).ceil() as u64);
    }
    if peer_has_display_emit_reason(
        peer,
        terminal_damage.any,
        header_signal,
        current_row_hashes,
        now_ms,
    ) {
        // There is no coalescing arm and no rate floor here any more. Output
        // that is already queued behind this read is drained into the same
        // flush by the owner loop before it gets here (`pty_drained`), which
        // is the exact signal the old 1 ms and 10 ms tails were guessing at;
        // a redraw the application declared atomic is held by BSU/ESU, not
        // by a clock. The only waits left are evidence of an actual refusal:
        // snapshot retry backoff after a failed send, and the zero-progress
        // admission retry after the carrier refused a whole burst. Both are
        // waived for fresh input feedback and a bare header change, exactly
        // as before.
        let urgent_feedback = scheduler_urgent_feedback(
            peer,
            terminal_damage,
            header_signal,
            current_row_hashes,
            now_ms,
        );
        let floors = snapshot_backoff_delay.max(admission_retry_delay_ms(
            peer,
            now_ms,
            header_signal,
            urgent_feedback,
        ));
        return Some(floors);
    }
    peer.display_cache
        .next_row_resend_due_ms(now_ms)
        .map(|due_ms| ((due_ms - now_ms).max(0.0).ceil() as u64).max(snapshot_backoff_delay))
}

pub(crate) fn has_active_display_peers(peers: &PeerMap) -> bool {
    peers
        .values()
        .any(|peer| peer.authenticated && peer.is_e2e_ready())
}

/// Whether this peer may be offered display work at all.
///
/// `has_display_counterpart` is a first-class term, not an optimization. A
/// browser that closes its page without a disconnect leaves the daemon holding
/// an edge tunnel whose browser half is gone; the sweep marks the path
/// unavailable and arms the carrier-gap window, and for the length of that
/// window every one of this peer's rows is unacknowledged and past its re-send
/// deadline. Without this term the peer stays schedulable throughout, so the
/// owner loop diffs, compresses, seals and discards the whole screen every
/// flush interval for a minute — on the same round-robin cursor and the same
/// prepare worker a live peer is contending for.
fn peer_display_ready(peer: &PeerDisplayState) -> bool {
    peer.authenticated
        && peer.is_e2e_ready()
        && peer.display_prepare_in_flight.is_none()
        && peer.has_display_counterpart()
}

/// Whether a flush right now would emit something for this peer.
///
/// Flags first, the O(rows) scan last: the PTY-read re-arm asks this with
/// `terminal_dirty` set and pays no scan at all. `has_selectable_rows` is a
/// first-class term, not an optimization. Selection in `classify_flush_rows`
/// is derived purely from state (current vs sent vs acked vs deadline), so
/// scheduling has to be derived from the same state through the same rule or
/// the two disagree. `needs_full_diff` is edge-triggered wakeup state, and the
/// edges that used to raise it for an unconfirmed row — the client NACK and
/// the end-of-burst fence — no longer exist. Asking the cache directly keeps
/// the invariant that a row past its re-send deadline, or one the terminal
/// has moved past, is always reachable with no event required from anyone.
/// Only grant-exempt work can leave this peer until its browser's next grant.
#[inline]
fn peer_waits_on_grant(peer: &PeerDisplayState, now_ms: f64) -> bool {
    let credit = &peer.display_credit;
    credit.is_blocked(
        peer.generation,
        credit.run_is_free(now_ms, peer.adaptive.presentation_period_ms),
        peer.presentation_end_owed,
    )
}

/// Whether a header change may leave a peer that waits on its browser's grant
/// without one: it answers input, it changes what the browser does with input
/// (the routing word the browser holds, or prediction safety), or it is the
/// whole change and no row waits.
///
/// Otherwise the paid state that carries the waiting rows carries the header
/// too. Sent alone, a flood's cursor moved on every PTY read: each flush put a
/// header-only datagram on the wire, showed the cursor over rows that had not
/// arrived, and spent the browser's early commit on it.
#[inline]
fn header_change_is_grant_exempt(
    peer: &PeerDisplayState,
    header_signal: u128,
    current_row_hashes: &[u64],
    now_ms: f64,
) -> bool {
    let modes = TerminalState::display_header_signal_mode_flags(header_signal);
    let admitted_modes =
        TerminalState::display_header_signal_mode_flags(peer.last_admitted_critical_header_signal);
    peer.latest_input_seq != peer.last_row_advertised_input_seq
        || input_routing_delivered(peer) != Some(modes & INPUT_ROUTING_MASK)
        || (modes ^ admitted_modes) & crate::pty::terminal::DISPLAY_MODE_PREDICTION_SAFE != 0
        || !peer
            .display_cache
            .has_selectable_rows(current_row_hashes, now_ms)
}

/// Terminal output was applied: advance every peer's output run, which decides
/// whether its display states consume browser grants (`display::credit`), and
/// its echo horizon, the newest input the grid can now show an answer to.
pub(crate) fn note_display_output(peers: &mut PeerMap, now_ms: f64) {
    for peer in peers.values_mut() {
        let period_ms = peer.adaptive.presentation_period_ms;
        peer.display_credit.note_output(now_ms, period_ms);
        peer.echo_horizon = peer.keystroke_next_queued_seq.wrapping_sub(1);
    }
}

/// The scheduler's reading of the flush's urgent-feedback classification,
/// from pending terminal damage and the cached rows before this turn's hash
/// refresh: fresh input answered by at most the cursor row, or a bare header
/// change.
fn scheduler_urgent_feedback(
    peer: &PeerDisplayState,
    terminal_damage: PendingDisplayDamage,
    header_signal: u128,
    current_row_hashes: &[u64],
    now_ms: f64,
) -> bool {
    let causal_input_advanced = peer.latest_input_seq != peer.last_row_advertised_input_seq;
    let header_changed = header_signal != peer.last_admitted_critical_header_signal;
    let cached_rows = peer.display_cache.selectable_row_shape(
        current_row_hashes,
        now_ms,
        terminal_damage.cursor_row,
    );
    let row_bearing_work =
        terminal_damage.rows != PendingRowDamage::None || cached_rows != SelectableRowShape::None;
    let urgent_row_shape = matches!(
        (terminal_damage.rows, cached_rows),
        (
            PendingRowDamage::None,
            SelectableRowShape::None | SelectableRowShape::CursorOnly
        ) | (
            PendingRowDamage::CursorOnly,
            SelectableRowShape::None | SelectableRowShape::CursorOnly
        )
    );
    (causal_input_advanced
        && urgent_row_shape
        && (row_bearing_work
            || header_changed
            || peer.latest_input_seq != peer.last_advertised_input_seq))
        || (header_changed && !row_bearing_work)
}

fn peer_has_display_emit_reason(
    peer: &PeerDisplayState,
    terminal_dirty: bool,
    header_signal: u128,
    current_row_hashes: &[u64],
    now_ms: f64,
) -> bool {
    if !peer.needs_snapshot && peer_waits_on_grant(peer, now_ms) {
        // Grant-exempt work only (see `peer_next_flush_delay_ms`). Fresh
        // terminal damage, input to answer, an owed END and a header change the
        // paid state will not carry earn the flush a look, because only its
        // refreshed rows can tell an urgent echo from bulk output; it sends the
        // input-caused cursor row either way, so the scheduler's urgent reading
        // and this one cannot disagree into a spin.
        return terminal_dirty
            || peer.latest_input_seq != peer.last_row_advertised_input_seq
            || peer.latest_input_seq != peer.last_advertised_input_seq
            || peer.presentation_end_owed
            || (header_signal != peer.last_admitted_critical_header_signal
                && header_change_is_grant_exempt(peer, header_signal, current_row_hashes, now_ms))
            || peer.display_cache.has_repair_due_rows(now_ms);
    }
    terminal_dirty
        || peer.needs_snapshot
        || peer.needs_full_diff
        || peer_has_header_only_reason(peer, header_signal)
        || peer
            .display_cache
            .has_selectable_rows(current_row_hashes, now_ms)
}

/// Whether this peer has display work to run RIGHT NOW: the "emit" reading of
/// `peer_next_flush_delay_ms`, without its floors, which the flush enforces
/// itself.
fn peer_has_runnable_display_work(
    peer: &PeerDisplayState,
    terminal_dirty: bool,
    header_signal: u128,
    current_row_hashes: &[u64],
    now_ms: f64,
) -> bool {
    peer_display_ready(peer)
        && peer.awaiting_resume_until_ms.is_none()
        && peer_has_display_emit_reason(
            peer,
            terminal_dirty,
            header_signal,
            current_row_hashes,
            now_ms,
        )
}

/// The two reasons a flush emits a header-only delta with no rows selected.
///
/// Scheduling has to derive from the same state as selection or the two
/// disagree, and this pair is where they used to. `flush_display` treats a
/// stale advertised `input_seq` and a changed critical header as first-class
/// reasons to emit — but neither predicate below contained either term, so on a
/// quiesced, fully-acked screen nothing scheduled the flush that would carry
/// them.
///
/// For `input_seq` that is not a delay, it is a deadlock: the advertisement IS
/// the browser's causal barrier release, so a keystroke that changes nothing
/// visible (an arrow at a line edge, Tab with no completion, a key the line
/// editor swallows) advanced `latest_input_seq`, armed nothing, and left local
/// echo dead until unrelated output happened to dirty the terminal. The digest
/// heartbeat is not a backstop for it — that frame carries generation, row
/// hashes and an up-to sequence, and no `input_seq` at all.
fn peer_has_header_only_reason(peer: &PeerDisplayState, header_signal: u128) -> bool {
    peer.latest_input_seq != peer.last_advertised_input_seq
        || header_signal != peer.last_admitted_critical_header_signal
        || peer.presentation_end_owed
}

/// Convert elapsed cache-resume gates into normal snapshot ownership exactly
/// once. Deliberately preserve `snapshot_retry_at_ms`: if a snapshot is already
/// backing off, the existing retry deadline remains authoritative.
pub(crate) fn arm_expired_resume_snapshots(peers: &mut PeerMap, now_ms: f64) -> usize {
    let mut armed = 0;
    for peer in peers.values_mut() {
        // HELLO proves attachment ownership, not browser DATA admission.
        if peer.resume_waiting_for_data
            || (!peer.paths.edge.available && !peer.paths.webtransport.available)
        {
            continue;
        }
        if !peer
            .awaiting_resume_until_ms
            .is_some_and(|deadline_ms| now_ms >= deadline_ms)
        {
            continue;
        }
        peer.awaiting_resume_until_ms = None;
        peer.needs_snapshot = true;
        // No claim arrived, so the daemon never learned whether this peer kept
        // its grid — and a snapshot is what it is about to get. Fail closed:
        // compressing against a dictionary the peer may have discarded produces
        // frames it refuses by id, on the recovery path of all places.
        peer.discard_dictionary_for_snapshot();
        armed += 1;
    }
    armed
}

/// Whether an event-driven flush has work that can make progress now.
///
/// `needs_snapshot` is armed during authentication, before Noise completes.
/// Treating that flag as runnable caused the owner to wake every normal flush
/// interval merely to rediscover the E2E gate. A successful `noise_final`
/// supplies the one explicit wake edge when the peer becomes display-ready.
pub(crate) fn has_runnable_display_work(
    peers: &PeerMap,
    terminal_dirty: bool,
    header_signal: u128,
    current_row_hashes: &[u64],
    now_ms: f64,
) -> bool {
    peers.values().any(|peer| {
        peer_has_runnable_display_work(
            peer,
            terminal_dirty,
            header_signal,
            current_row_hashes,
            now_ms,
        )
    })
}

#[cfg(test)]
mod tests;
