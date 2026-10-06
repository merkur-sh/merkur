//! The terminal worker's receive rules, against a grid that records what it
//! was asked to do and refuses on cue. Frames are encoded by `merkur-codec`,
//! as the daemon encodes them.

use merkur_codec::{
    FrameHeader, FrameKind, MSG_TYPE_DISPLAY_PATCH, RowRef, STREAM_HEADER_BYTES, StreamHeader,
    encode_frame_into, parse_frame_header, write_stream_header,
};
use merkur_wire::protocol::{
    CHANNEL_CTRL, CHANNEL_DISPLAY_COMMIT, CHANNEL_DISPLAY_DATAGRAM, encode_input_routing_frame,
    encode_proto_frame,
};

use super::*;

/// What the grid was asked to apply: `(snapshot, generation, seq)`.
type Applied = (bool, u32, u32);

#[derive(Default)]
struct FakeGrid {
    cols: u16,
    rows: u16,
    staged: Vec<Option<Vec<u8>>>,
    applied: Vec<Applied>,
    ordering_resets: usize,
    /// Validation refuses this chunk index.
    invalid_chunk: Option<u16>,
    /// Applying this sequence refuses with this error.
    refuse_seq: Option<(u32, &'static str)>,
    error: Option<String>,
    /// Row hashes by row; a row not listed hashes to 0.
    hashes: Vec<u64>,
    /// Installed dictionaries, `(generation, id, hash, bytes)`.
    dictionaries: Vec<(u32, u32, u32, Vec<u8>)>,
    refuse_dictionaries: bool,
    /// Applies change nothing visible.
    nonvisual: bool,
    /// The grid digests to every claim.
    closure_met: bool,
    mutation_epoch: u64,
    /// What the grid showed at each commit: the applies it held.
    presented: Vec<usize>,
    /// Routing words taken (`Some`) and released (`None`), each after the
    /// applies it followed.
    routing: Vec<(usize, Option<u16>)>,
    /// The sequence of the newest delta that wrote each row: a delta writes
    /// its first `row_count` rows.
    row_versions: Vec<u32>,
    /// The placements the grid exports, and their revision.
    graphics_revision: u32,
    graphics_fragments: Vec<u8>,
    graphics_tile_limit: Option<usize>,
    graphics_admissions: Vec<usize>,
    observations: Vec<[u32; 14]>,
}

impl FakeGrid {
    fn bytes(&self, handle: u32) -> &[u8] {
        self.staged[handle as usize - 1]
            .as_deref()
            .expect("a live staged handle")
    }

    fn outstanding(&self) -> usize {
        self.staged.iter().filter(|slot| slot.is_some()).count()
    }

    fn apply(&mut self, handle: u32, seq: u32, snapshot: bool) -> bool {
        let bytes = self.bytes(handle).to_vec();
        let header = parse_frame_header(&bytes).expect("a staged frame parses");
        let generation = u32::from_be_bytes(bytes[10..14].try_into().expect("u32"));
        if let Some((refused, error)) = self.refuse_seq
            && refused == seq
        {
            self.error = Some(error.to_string());
            return false;
        }
        if snapshot {
            (self.cols, self.rows) = (header.cols, header.rows);
            self.row_versions = vec![0; usize::from(header.rows)];
        } else if (header.cols, header.rows) != (self.cols, self.rows) {
            self.error = Some(DIMENSIONS_MISMATCH.to_string());
            return false;
        } else {
            for version in self
                .row_versions
                .iter_mut()
                .take(usize::from(header.row_count))
            {
                *version = seq;
            }
        }
        self.applied.push((snapshot, generation, seq));
        true
    }
}

impl DisplayGrid for FakeGrid {
    fn trace_display(&mut self, words: &[u32; 14], since_ms: f64) -> f64 {
        self.observations.push(*words);
        since_ms
    }

    fn resize(&mut self, cols: u16, rows: u16) {
        self.cols = cols;
        self.rows = rows;
        self.mutation_epoch += 1;
    }

    fn stage(&mut self, frame: &[u8]) -> u32 {
        self.staged.push(Some(frame.to_vec()));
        self.staged.len() as u32
    }

    fn validate(&mut self, handle: u32) -> bool {
        let header = parse_frame_header(self.bytes(handle)).expect("a staged frame parses");
        Some(header.chunk_index) != self.invalid_chunk
    }

    fn apply_state(&mut self, handle: u32, seq: u32) -> bool {
        self.apply(handle, seq, true)
    }

    fn apply_delta(&mut self, handle: u32, seq: u32) -> bool {
        self.apply(handle, seq, false)
    }

    fn release(&mut self, handle: u32) {
        let slot = &mut self.staged[handle as usize - 1];
        assert!(slot.is_some(), "handle {handle} released twice");
        *slot = None;
    }

    fn reset_ordering(&mut self) {
        self.ordering_resets += 1;
    }

    fn take_error(&mut self) -> Option<String> {
        self.error.take()
    }

    fn rows(&self) -> u16 {
        self.rows
    }

    fn row_hashes(&mut self) -> &[u64] {
        self.hashes.resize(usize::from(self.rows), 0);
        &self.hashes
    }

    fn row_version(&self, row: u16) -> u32 {
        self.row_versions
            .get(usize::from(row))
            .copied()
            .unwrap_or(0)
    }

    fn install_dictionary(&mut self, generation: u32, id: u32, hash: u32, bytes: &[u8]) -> bool {
        if self.refuse_dictionaries {
            return false;
        }
        self.dictionaries
            .push((generation, id, hash, bytes.to_vec()));
        true
    }

    fn clear_dictionaries(&mut self) {
        self.dictionaries.clear();
    }

    fn cols(&self) -> u16 {
        self.cols
    }

    fn last_apply_visually_changed(&self) -> bool {
        !self.nonvisual
    }

    fn closure_digest_matches(&mut self, digest: u64) -> bool {
        digest != 0 && self.closure_met
    }

    fn completion_mutation_epoch(&self) -> u64 {
        self.mutation_epoch
    }

    fn commit_presentation(&mut self) {
        self.presented.push(self.applied.len());
    }

    fn set_input_routing(&mut self, word: u16) {
        self.routing.push((self.applied.len(), Some(word)));
    }

    fn release_input_routing(&mut self) {
        self.routing.push((self.applied.len(), None));
    }

    fn prediction_granted(&self) -> bool {
        false
    }

    fn alt_screen_active(&self) -> bool {
        false
    }

    fn set_editor_anchor(&mut self, _: u32, _: u16, _: u16, _: bool) {}

    fn predict_printable(&mut self, _: u32, _: f64, _: u32, _: bool) -> bool {
        false
    }

    fn predict_backspace(&mut self, _: f64, _: u32) -> bool {
        false
    }

    fn predict_delete(&mut self, _: f64, _: u32) -> bool {
        false
    }

    fn predict_cursor_shift(&mut self, _: i32, _: f64, _: u32) -> bool {
        false
    }

    fn predict_seal(&mut self, _: u32) {}

    fn predict_discard(&mut self) {}

    fn has_predictions(&self) -> bool {
        false
    }

    fn predict_reconcile(&mut self, _: f64, _: f64, _: u32, _: u32) -> [u32; 7] {
        [0; 7]
    }

    fn admit_graphics_scene(&mut self, scene: &Scene) -> bool {
        self.graphics_admissions.push(scene.tiles.len());
        self.graphics_tile_limit
            .is_none_or(|limit| scene.tiles.len() <= limit)
    }

    fn graphics_revision(&self) -> u32 {
        self.graphics_revision
    }

    fn graphics_fragments(&mut self) -> &[u8] {
        &self.graphics_fragments
    }
}

struct Spec {
    snapshot: bool,
    generation: u32,
    seq: u32,
    cols: u16,
    rows: u16,
    frame_id: u32,
    chunk_index: u16,
    chunk_count: u16,
    row_count: u16,
    demand_serial: u32,
    limited: bool,
    prompt: bool,
    /// The stream header's flags byte.
    flags: u8,
    /// `(presentation id, coherent, end, member index, member count)`.
    presentation: (u32, bool, bool, u16, u16),
    awaits_grant: bool,
    closure_digest: u64,
    /// The newest input the daemon applied, by wire sequence.
    input_seq: u32,
}

impl Spec {
    fn snapshot(generation: u32) -> Self {
        Self {
            snapshot: true,
            generation,
            seq: 0,
            cols: 80,
            rows: 24,
            frame_id: 1,
            chunk_index: 0,
            chunk_count: 1,
            row_count: 24,
            demand_serial: 0,
            limited: false,
            prompt: false,
            flags: 0,
            presentation: (0, false, false, 0, 0),
            awaits_grant: false,
            closure_digest: 0,
            input_seq: 0,
        }
    }

    /// A delta that is member `index` of `count` of coherent redraw `id`.
    fn member(generation: u32, seq: u32, id: u32, index: u16, count: u16, end: bool) -> Self {
        Self {
            presentation: (id, true, end, index, count),
            ..Self::delta(generation, seq)
        }
    }

    fn delta(generation: u32, seq: u32) -> Self {
        Self {
            snapshot: false,
            seq,
            frame_id: seq,
            row_count: 1,
            ..Self::snapshot(generation)
        }
    }

    fn encode(&self) -> Vec<u8> {
        let header = FrameHeader {
            kind: if self.snapshot {
                FrameKind::Snapshot
            } else {
                FrameKind::Delta
            },
            memory_only: false,
            cols: self.cols,
            rows: self.rows,
            cursor_col: 0,
            cursor_row: 0,
            cursor_shape: 0,
            cursor_visible: 1,
            mode_flags: 0,
            row_count: self.row_count,
            frame_id: self.frame_id,
            presentation_id: self.presentation.0,
            presentation_member_index: self.presentation.3,
            presentation_member_count: self.presentation.4,
            row_predecessor_presentation_id: 0,
            presentation_coherent: self.presentation.1,
            presentation_end: self.presentation.2,
            chunk_index: self.chunk_index,
            chunk_count: self.chunk_count,
            demand_serial: self.demand_serial,
            demand_limited: self.limited,
            demand_prompt: self.prompt,
            demand_awaits_grant: self.awaits_grant,
            closure_digest: self.closure_digest,
            scroll_serial: 0,
            echo_horizon: 0,
        };
        let mut out = Vec::new();
        encode_frame_into(&mut out, &header, std::iter::empty::<RowRef<'_>>());
        let body_len = (out.len() - STREAM_HEADER_BYTES) as u32;
        write_stream_header(
            &mut out,
            &StreamHeader {
                msg_type: MSG_TYPE_DISPLAY_PATCH,
                flags: self.flags,
                body_len,
                seq: self.seq,
                generation: self.generation,
                input_seq: self.input_seq,
            },
        );
        out
    }
}

fn snapshot(generation: u32) -> Vec<u8> {
    Spec::snapshot(generation).encode()
}

fn delta(generation: u32, seq: u32) -> Vec<u8> {
    Spec::delta(generation, seq).encode()
}

fn viewer() -> Viewer<FakeGrid> {
    Viewer::new(FakeGrid::default())
}

/// A viewer whose session began and whose first snapshot applied.
fn rooted(generation: u32) -> Viewer<FakeGrid> {
    let mut viewer = viewer();
    viewer.fence(0.0, SESSION);
    viewer.receive(
        0.0,
        CHANNEL_DISPLAY_COMMIT,
        &snapshot(generation),
        InputMapping::default(),
    );
    drain(&mut viewer, 0.0);
    viewer
}

/// The first authentication's fence, and the next one's.
const SESSION: DisplayFence = DisplayFence { lineage: 1 };
const SUCCESSOR: DisplayFence = DisplayFence { lineage: 2 };

fn drain(viewer: &mut Viewer<FakeGrid>, now_ms: f64) -> Vec<Output> {
    std::iter::from_fn(|| viewer.poll_output(now_ms)).collect()
}

fn datagram(viewer: &mut Viewer<FakeGrid>, now_ms: f64, frame: &[u8]) {
    viewer.receive(
        now_ms,
        CHANNEL_DISPLAY_DATAGRAM,
        frame,
        InputMapping::default(),
    );
}

fn acks(outputs: &[Output]) -> Vec<(DisplayAckPayload, bool)> {
    outputs
        .iter()
        .filter_map(|output| match output {
            Output::Ack { payload, durable } => Some((*payload, *durable)),
            _ => None,
        })
        .collect()
}

fn requests(outputs: &[Output]) -> usize {
    outputs
        .iter()
        .filter(|output| **output == Output::SnapshotRequest)
        .count()
}

/// What a session fence asks of the session: a snapshot, and dictionaries.
fn fenced() -> [Output; 2] {
    [Output::SnapshotRequest, Output::DictionaryReady(true)]
}

#[test]
fn a_session_asks_for_a_snapshot_and_its_early_deltas_wait_for_it() {
    let mut viewer = viewer();
    viewer.fence(0.0, SESSION);
    assert_eq!(drain(&mut viewer, 0.0), fenced());

    // Deltas that overtook the snapshot wait, whatever their number.
    datagram(&mut viewer, 1.0, &delta(7, 2));
    datagram(&mut viewer, 1.0, &delta(7, 1));
    assert!(viewer.grid().applied.is_empty());

    viewer.receive(
        2.0,
        CHANNEL_DISPLAY_COMMIT,
        &snapshot(7),
        InputMapping::default(),
    );
    assert_eq!(
        viewer.grid().applied,
        [(true, 7, 0), (false, 7, 2), (false, 7, 1)],
        "the snapshot applies, then the waiting deltas in arrival order"
    );
    assert_eq!(viewer.grid().ordering_resets, 1);
    let acks = acks(&drain(&mut viewer, 2.0));
    assert_eq!(acks.len(), 1, "one ACK per generation, the newest window");
    let (ack, durable) = acks[0];
    assert_eq!((ack.generation, ack.largest_seq, durable), (7, 2, false));
    assert_eq!(ack.received[0], 0b11);
    assert_eq!(ack.grant, 1, "a generation opens with its implicit grant");
    assert_eq!(viewer.grid().outstanding(), 0);
}

#[test]
fn a_snapshot_alone_is_not_acknowledged() {
    let mut viewer = viewer();
    viewer.fence(0.0, SESSION);
    viewer.receive(
        1.0,
        CHANNEL_DISPLAY_COMMIT,
        &snapshot(3),
        InputMapping::default(),
    );
    assert_eq!(drain(&mut viewer, 1.0), fenced());
    assert_eq!(viewer.generation(), 3);
    assert_eq!(viewer.stats().snapshots, 1);
}

#[test]
fn a_lost_datagram_is_a_hole_in_the_window_not_a_resync() {
    let mut viewer = rooted(1);
    for seq in [1, 2, 4] {
        datagram(&mut viewer, 10.0, &delta(1, seq));
    }
    let outputs = drain(&mut viewer, 10.0);
    assert_eq!(requests(&outputs), 0);
    let (ack, _) = acks(&outputs)[0];
    assert_eq!((ack.largest_seq, ack.received[0]), (4, 0b1101));
    assert_eq!(viewer.stats().resyncs, 0);
}

#[test]
fn an_older_generation_is_stale_and_sustained_staleness_reroots_the_lineage() {
    let mut viewer = rooted(5);
    datagram(&mut viewer, 10.0, &delta(5, 1));
    drain(&mut viewer, 10.0);

    // Inside the reordering window a stale delta is dropped, nothing more.
    datagram(&mut viewer, 500.0, &delta(4, 9));
    assert_eq!(drain(&mut viewer, 500.0), []);
    assert_eq!(viewer.grid().applied.len(), 2);

    // Past it, with nothing applying, this lineage sits above the daemon's.
    datagram(&mut viewer, 1_011.0, &delta(4, 10));
    assert_eq!(drain(&mut viewer, 1_011.0), [Output::SnapshotRequest]);
    assert_eq!(
        viewer.stats().last_resync,
        Some(Resync::StaleGenerationRecovery)
    );
    // The daemon's lower snapshot is accepted, and its deltas apply.
    viewer.receive(
        1_020.0,
        CHANNEL_DISPLAY_COMMIT,
        &snapshot(4),
        InputMapping::default(),
    );
    datagram(&mut viewer, 1_021.0, &delta(4, 11));
    assert_eq!(viewer.generation(), 4);
    assert_eq!(viewer.grid().applied.last(), Some(&(false, 4, 11)));
    assert_eq!(viewer.grid().outstanding(), 0);
}

#[test]
fn a_newer_generation_waits_for_its_snapshot_without_asking_for_one() {
    let mut viewer = rooted(1);
    datagram(&mut viewer, 1.0, &delta(2, 1));
    // The current generation's deltas stop applying while its successor's
    // snapshot is in flight.
    datagram(&mut viewer, 2.0, &delta(1, 5));
    assert_eq!(
        drain(&mut viewer, 2.0),
        [],
        "a request would roll the generation again"
    );
    assert_eq!(viewer.grid().applied, [(true, 1, 0)]);

    viewer.receive(
        3.0,
        CHANNEL_DISPLAY_COMMIT,
        &snapshot(2),
        InputMapping::default(),
    );
    assert_eq!(
        viewer.grid().applied,
        [(true, 1, 0), (true, 2, 0), (false, 2, 1)]
    );
    datagram(&mut viewer, 4.0, &delta(2, 2));
    assert_eq!(viewer.grid().applied.last(), Some(&(false, 2, 2)));
}

#[test]
fn a_snapshot_that_never_lands_is_asked_for_again_on_the_resync_clock() {
    let mut viewer = rooted(1);
    datagram(&mut viewer, 10.0, &delta(2, 1));
    assert_eq!(viewer.next_deadline(), Some(10.0 + RESYNC_TIMEOUT_MS));
    viewer.handle_timeout(10.0 + RESYNC_TIMEOUT_MS);
    assert_eq!(
        drain(&mut viewer, 10.0 + RESYNC_TIMEOUT_MS),
        [Output::SnapshotRequest]
    );
    viewer.receive(
        6_000.0,
        CHANNEL_DISPLAY_COMMIT,
        &snapshot(2),
        InputMapping::default(),
    );
    assert_eq!(viewer.next_deadline(), None);
}

#[test]
fn a_stale_snapshot_is_dropped_once_the_lineage_is_rooted() {
    let mut viewer = rooted(4);
    viewer.receive(
        1.0,
        CHANNEL_DISPLAY_COMMIT,
        &snapshot(3),
        InputMapping::default(),
    );
    assert_eq!(viewer.generation(), 4);
    assert_eq!(viewer.stats().snapshots, 1);
    // The same generation may snapshot again: a resync reuses it.
    viewer.receive(
        2.0,
        CHANNEL_DISPLAY_COMMIT,
        &snapshot(4),
        InputMapping::default(),
    );
    assert_eq!(viewer.stats().snapshots, 2);
}

#[test]
fn a_delta_for_other_dimensions_is_neither_acknowledged_nor_a_resync() {
    let mut viewer = rooted(1);
    let narrow = Spec {
        cols: 40,
        ..Spec::delta(1, 1)
    }
    .encode();
    datagram(&mut viewer, 1.0, &narrow);
    assert_eq!(drain(&mut viewer, 1.0), []);
    assert_eq!(viewer.stats().dimension_mismatches, 1);
    assert_eq!(viewer.stats().resyncs, 0);
    datagram(&mut viewer, 2.0, &delta(1, 2));
    let (ack, _) = acks(&drain(&mut viewer, 2.0))[0];
    assert_eq!(
        (ack.largest_seq, ack.received[0]),
        (2, 1),
        "seq 1 stays owed"
    );
}

#[test]
fn any_other_refusal_abandons_the_lineage_once() {
    let mut viewer = rooted(1);
    viewer.grid_mut().refuse_seq = Some((2, "display_row_invalid"));
    datagram(&mut viewer, 1.0, &delta(1, 1));
    datagram(&mut viewer, 1.0, &delta(1, 2));
    datagram(&mut viewer, 1.0, &delta(1, 3));
    let outputs = drain(&mut viewer, 1.0);
    assert_eq!(requests(&outputs), 1);
    assert_eq!(viewer.stats().last_resync, Some(Resync::ApplyRejected));
    // Deltas stop until the snapshot: seq 3 was dropped.
    assert_eq!(viewer.grid().applied.last(), Some(&(false, 1, 1)));
    viewer.grid_mut().refuse_seq = None;
    viewer.receive(
        2.0,
        CHANNEL_DISPLAY_COMMIT,
        &snapshot(1),
        InputMapping::default(),
    );
    datagram(&mut viewer, 3.0, &delta(1, 4));
    assert_eq!(viewer.grid().applied.last(), Some(&(false, 1, 4)));
    assert_eq!(viewer.grid().outstanding(), 0);
}

#[test]
fn a_malformed_frame_is_a_resync() {
    let mut viewer = rooted(1);
    let mut truncated = delta(1, 1);
    truncated.pop();
    datagram(&mut viewer, 1.0, &truncated);
    assert_eq!(drain(&mut viewer, 1.0), [Output::SnapshotRequest]);
    assert_eq!(viewer.stats().last_resync, Some(Resync::FrameParseFailed));
}

fn chunk(generation: u32, index: u16, count: u16) -> Vec<u8> {
    Spec {
        chunk_index: index,
        chunk_count: count,
        row_count: 1,
        ..Spec::snapshot(generation)
    }
    .encode()
}

#[test]
fn a_multi_chunk_snapshot_applies_whole_once_its_last_chunk_arrives() {
    let mut viewer = rooted(1);
    viewer.receive(
        1.0,
        CHANNEL_DISPLAY_COMMIT,
        &chunk(2, 1, 3),
        InputMapping::default(),
    );
    viewer.receive(
        1.0,
        CHANNEL_DISPLAY_COMMIT,
        &chunk(2, 1, 3),
        InputMapping::default(),
    );
    viewer.receive(
        1.0,
        CHANNEL_DISPLAY_COMMIT,
        &chunk(2, 0, 3),
        InputMapping::default(),
    );
    assert_eq!(viewer.generation(), 1);
    viewer.receive(
        1.0,
        CHANNEL_DISPLAY_COMMIT,
        &chunk(2, 2, 3),
        InputMapping::default(),
    );
    assert_eq!(viewer.generation(), 2);
    assert_eq!(
        &viewer.grid().applied[1..],
        [(true, 2, 0), (true, 2, 0), (true, 2, 0)]
    );
    assert_eq!(viewer.grid().outstanding(), 0);
}

/// Chunk `index` of `count` of a generation-2 snapshot, `bytes` long on the
/// wire: the frame header and a row region the fake grid never reads.
fn sized_chunk(index: u16, count: u16, bytes: usize) -> Vec<u8> {
    let mut payload = chunk(2, index, count);
    payload.resize(bytes, 0);
    write_stream_header(
        &mut payload,
        &StreamHeader {
            msg_type: MSG_TYPE_DISPLAY_PATCH,
            flags: 0,
            body_len: (bytes - STREAM_HEADER_BYTES) as u32,
            seq: 0,
            generation: 2,
            input_seq: 0,
        },
    );
    payload
}

/// The daemon budgets a snapshot's graphics against the codec's snapshot bound
/// after worst-case text and framing, so the chunks of one snapshot sum to as
/// much as that bound. A viewer that stops short of it refuses a snapshot the
/// daemon keeps re-sending.
#[test]
fn a_snapshot_assembles_up_to_the_codec_snapshot_bound_and_no_further() {
    let quarter = merkur_codec::MAX_DISPLAY_SNAPSHOT_BYTES / 4;
    let mut viewer = rooted(1);
    for index in 0..4 {
        viewer.receive(
            1.0,
            CHANNEL_DISPLAY_COMMIT,
            &sized_chunk(index, 4, quarter),
            InputMapping::default(),
        );
    }
    assert_eq!(viewer.stats().resyncs, 0);
    assert_eq!(
        viewer.generation(),
        2,
        "a snapshot of exactly the bound applies"
    );
    assert_eq!(viewer.grid().outstanding(), 0);

    // One byte past the bound is not a snapshot the daemon sends.
    let mut viewer = rooted(1);
    for index in 0..4 {
        let bytes = quarter + usize::from(index == 3);
        viewer.receive(
            1.0,
            CHANNEL_DISPLAY_COMMIT,
            &sized_chunk(index, 4, bytes),
            InputMapping::default(),
        );
    }
    assert_eq!(viewer.stats().resyncs, 1);
    assert_eq!(viewer.generation(), 1);
    assert_eq!(viewer.grid().outstanding(), 0);
}

#[test]
fn a_chunk_that_fails_validation_leaves_the_grid_untouched() {
    let mut viewer = rooted(1);
    viewer.grid_mut().invalid_chunk = Some(1);
    for index in 0..3 {
        viewer.receive(
            1.0,
            CHANNEL_DISPLAY_COMMIT,
            &chunk(2, index, 3),
            InputMapping::default(),
        );
    }
    assert_eq!(viewer.grid().applied, [(true, 1, 0)]);
    assert_eq!(
        viewer.stats().last_resync,
        Some(Resync::FrameValidationRejected)
    );
    assert_eq!(viewer.grid().outstanding(), 0);
}

#[test]
fn chunks_that_disagree_about_their_frame_are_a_resync() {
    let mut viewer = rooted(1);
    viewer.receive(
        1.0,
        CHANNEL_DISPLAY_COMMIT,
        &chunk(2, 0, 3),
        InputMapping::default(),
    );
    let other = Spec {
        chunk_index: 1,
        chunk_count: 3,
        rows: 30,
        row_count: 1,
        ..Spec::snapshot(2)
    }
    .encode();
    viewer.receive(1.0, CHANNEL_DISPLAY_COMMIT, &other, InputMapping::default());
    assert_eq!(
        viewer.stats().last_resync,
        Some(Resync::PendingFrameMismatch)
    );
    assert_eq!(viewer.grid().outstanding(), 0);
}

#[test]
fn chunks_carrying_more_rows_than_the_grid_are_a_resync() {
    let mut viewer = rooted(1);
    let heavy = |index| {
        Spec {
            chunk_index: index,
            chunk_count: 2,
            row_count: 20,
            ..Spec::snapshot(2)
        }
        .encode()
    };
    viewer.receive(
        1.0,
        CHANNEL_DISPLAY_COMMIT,
        &heavy(0),
        InputMapping::default(),
    );
    viewer.receive(
        1.0,
        CHANNEL_DISPLAY_COMMIT,
        &heavy(1),
        InputMapping::default(),
    );
    assert_eq!(viewer.stats().last_resync, Some(Resync::PendingFrameRows));
    assert_eq!(viewer.grid().outstanding(), 0);
}

#[test]
fn a_fifth_incomplete_assembly_means_one_was_lost() {
    let mut viewer = rooted(1);
    // Newest first, so no arrival supersedes the ones before it.
    for generation in (2..=6).rev() {
        viewer.receive(
            1.0,
            CHANNEL_DISPLAY_COMMIT,
            &chunk(generation, 0, 2),
            InputMapping::default(),
        );
    }
    assert_eq!(
        viewer.stats().last_resync,
        Some(Resync::PendingAssembliesOverflow)
    );
    assert_eq!(viewer.grid().outstanding(), 0);
}

#[test]
fn a_newer_snapshot_supersedes_an_older_incomplete_one() {
    let mut viewer = rooted(1);
    viewer.receive(
        1.0,
        CHANNEL_DISPLAY_COMMIT,
        &chunk(2, 0, 2),
        InputMapping::default(),
    );
    viewer.receive(
        1.0,
        CHANNEL_DISPLAY_COMMIT,
        &snapshot(3),
        InputMapping::default(),
    );
    assert_eq!(viewer.generation(), 3);
    assert_eq!(viewer.grid().outstanding(), 0);
    assert_eq!(viewer.stats().resyncs, 0);
}

#[test]
fn a_grid_it_cannot_claim_drops_the_old_lineage_and_accepts_a_restarted_daemon() {
    let mut viewer = rooted(9);
    datagram(&mut viewer, 1.0, &delta(9, 1));
    viewer.receive(
        1.0,
        CHANNEL_DISPLAY_COMMIT,
        &chunk(9, 0, 2),
        InputMapping::default(),
    );
    // Stale traffic re-rooted the lineage: the grid waits for a snapshot and
    // describes nothing the daemon could match.
    datagram(&mut viewer, 1_002.0, &delta(8, 5));
    drain(&mut viewer, 1_002.0);

    // The claim names only the generation, so that the daemon's next one is
    // newer.
    viewer.fence(1_003.0, SUCCESSOR);
    assert_eq!(
        viewer.grid().outstanding(),
        0,
        "the incomplete assembly is released"
    );
    assert_eq!(
        drain(&mut viewer, 1_003.0),
        [
            Output::Resume(DisplayResume {
                generation: 9,
                applied_seq: 1,
                repair_id: 2,
                cols: 80,
                rows: 24,
                row_hashes: None,
            }),
            Output::SnapshotRequest,
            Output::DictionaryReady(true),
        ]
    );
    // Even the old generation's number waits: no ordering spans the fence.
    datagram(&mut viewer, 1_004.0, &delta(9, 2));
    viewer.receive(
        1_005.0,
        CHANNEL_DISPLAY_COMMIT,
        &snapshot(1),
        InputMapping::default(),
    );
    assert_eq!(viewer.generation(), 1);
    assert_eq!(
        viewer.grid().applied.last(),
        Some(&(true, 1, 0)),
        "the waiting delta of the old lineage never applies"
    );
    datagram(&mut viewer, 1_006.0, &delta(1, 1));
    let (ack, _) = acks(&drain(&mut viewer, 1_006.0))[0];
    assert_eq!((ack.generation, ack.largest_seq), (1, 1));
}

#[test]
fn a_grid_holding_only_its_snapshot_is_claimed_at_sequence_zero() {
    let mut viewer = rooted(4);
    viewer.present_now(0.0);
    viewer.fence(1.0, SUCCESSOR);
    assert_eq!(
        drain(&mut viewer, 1.0),
        [
            Output::Resume(DisplayResume {
                generation: 4,
                applied_seq: 0,
                repair_id: 2,
                cols: 80,
                rows: 24,
                row_hashes: Some(vec![0; 24]),
            }),
            Output::DictionaryReady(true),
        ],
        "the daemon acknowledged the snapshot's rows when it sent it"
    );
}

/// A delta that consumed grant `serial` while the daemon waits on grants.
fn limited(seq: u32, serial: u32) -> Vec<u8> {
    Spec {
        demand_serial: serial,
        limited: true,
        prompt: true,
        ..Spec::delta(1, seq)
    }
    .encode()
}

#[test]
fn a_kept_grid_is_claimed_and_continues_its_generation_with_fresh_grants() {
    let mut viewer = rooted(1);
    viewer.grid_mut().hashes = vec![11, 22];
    datagram(&mut viewer, 10.0, &limited(1, 1));
    drain(&mut viewer, 10.0);
    viewer.frame(16.0, 16.0, true, None);
    let (ack, durable) = acks(&drain(&mut viewer, 16.0))[0];
    assert_eq!(
        (ack.grant, durable),
        (2, false),
        "a waiting daemon's grant is posted"
    );

    viewer.fence(20.0, SUCCESSOR);
    let mut row_hashes = vec![0; 24];
    row_hashes[..2].copy_from_slice(&[11, 22]);
    assert_eq!(
        drain(&mut viewer, 20.0),
        [
            Output::Resume(DisplayResume {
                generation: 1,
                applied_seq: 1,
                repair_id: 2,
                cols: 80,
                rows: 24,
                row_hashes: Some(row_hashes),
            }),
            Output::DictionaryReady(true),
        ],
        "no snapshot: the daemon answers the claim with a repair"
    );
    assert_eq!(viewer.stats().resumes, 1);
    assert_eq!(
        viewer.demand().grant(1),
        1,
        "grants in flight on the old carrier are gone"
    );
    // The daemon grants itself one past its newest; the viewer adopts it.
    datagram(&mut viewer, 30.0, &limited(2, 2));
    assert_eq!(viewer.grid().applied.last(), Some(&(false, 1, 2)));
    assert_eq!(viewer.demand().grant(1), 2);
}

/// The daemon's end of the repair `repair_id` of `generation`.
fn repair_end(generation: u32, repair_id: u32, members: &[(u16, u32)]) -> Vec<u8> {
    let mut body = Vec::new();
    body.extend_from_slice(&generation.to_be_bytes());
    body.extend_from_slice(&repair_id.to_be_bytes());
    body.extend_from_slice(&(members.len() as u16).to_be_bytes());
    for (row, minimum_seq) in members {
        body.extend_from_slice(&row.to_be_bytes());
        body.extend_from_slice(&minimum_seq.to_be_bytes());
    }
    encode_proto_frame(MSG_TYPE_DISPLAY_REPAIR_END, &body)
}

/// A shown grid at generation 1 that kept itself across a rebind.
fn resumed() -> Viewer<FakeGrid> {
    let mut viewer = shown();
    datagram(&mut viewer, 1.0, &delta(1, 1));
    viewer.present_now(1.0);
    viewer.fence(2.0, SUCCESSOR);
    drain(&mut viewer, 2.0);
    viewer
}

#[test]
fn the_gates_name_a_resumed_viewers_repaint_hold() {
    const REPAINT_HOLD: u32 = 1 << 2;
    const READY: u32 = 1 << 7;
    let shown = shown();
    assert_eq!(shown.presentation_gates() & REPAINT_HOLD, 0);
    let resumed = resumed();
    let gates = resumed.presentation_gates();
    assert_ne!(
        gates & REPAINT_HOLD,
        0,
        "the resume holds the paint for its repair"
    );
    assert_ne!(gates & READY, 0);
}

#[test]
fn a_repair_shows_once_every_row_it_names_landed() {
    let mut viewer = resumed();
    datagram(&mut viewer, 3.0, &delta(1, 5));
    assert_eq!(viewer.present_now(3.0), None, "the repair is held");
    viewer.receive(
        4.0,
        CHANNEL_CTRL,
        &repair_end(1, 2, &[(0, 5), (1, 6)]),
        InputMapping::default(),
    );
    assert_eq!(viewer.stats().repairs, 1);
    assert_eq!(viewer.present_now(4.0), None, "row 1 has not landed");
    // Row 1 lands in a frame that writes rows 0 and 1.
    let both = Spec {
        row_count: 2,
        ..Spec::delta(1, 6)
    };
    datagram(&mut viewer, 5.0, &both.encode());
    assert!(viewer.present_now(5.0).is_some());
    assert_eq!(viewer.grid().presented, [1, 2, 4]);
}

#[test]
fn a_marker_of_another_repair_or_lineage_is_ignored() {
    let mut viewer = resumed();
    datagram(&mut viewer, 3.0, &delta(1, 5));
    viewer.receive(
        4.0,
        CHANNEL_CTRL,
        &repair_end(1, 1, &[]),
        InputMapping::default(),
    );
    viewer.receive(
        4.0,
        CHANNEL_CTRL,
        &repair_end(2, 2, &[]),
        InputMapping::default(),
    );
    assert_eq!(viewer.stats().repairs, 0);
    assert_eq!(viewer.present_now(4.0), None);
    viewer.receive(
        5.0,
        CHANNEL_CTRL,
        &repair_end(1, 2, &[]),
        InputMapping::default(),
    );
    assert!(
        viewer.present_now(5.0).is_some(),
        "an empty repair completes"
    );
}

#[test]
fn a_repair_whose_marker_is_lost_shows_after_its_frame_budget() {
    let mut viewer = resumed();
    datagram(&mut viewer, 3.0, &delta(1, 5));
    assert!(viewer.wants_frame(true), "the visual bound counts frames");
    assert_eq!(viewer.frame(16.0, 16.0, true, None), None);
    assert!(viewer.frame(32.0, 16.0, true, None).is_some());
}

#[test]
fn an_unhurried_daemon_is_granted_lazily() {
    let mut viewer = rooted(1);
    datagram(&mut viewer, 10.0, &delta(1, 1));
    drain(&mut viewer, 10.0);
    viewer.frame(16.0, 16.0, true, None);
    assert_eq!(drain(&mut viewer, 16.0), [], "the grant rides the next ACK");
    datagram(&mut viewer, 20.0, &delta(1, 2));
    let (ack, _) = acks(&drain(&mut viewer, 20.0))[0];
    assert_eq!((ack.largest_seq, ack.grant), (2, 2));
}

#[test]
fn a_waiting_daemon_is_granted_each_frame_until_the_window_fills_durably() {
    let mut viewer = rooted(1);
    datagram(&mut viewer, 10.0, &limited(1, 1));
    drain(&mut viewer, 10.0);
    viewer.frame(16.0, 16.0, true, None);
    let (ack, durable) = acks(&drain(&mut viewer, 16.0))[0];
    assert_eq!((ack.largest_seq, ack.grant, durable), (1, 2, false));
    assert!(
        viewer.wants_frame(true),
        "the clock runs while the daemon waits"
    );
    // One frame, one grant: a repeated timestamp is the same frame.
    viewer.frame(16.0, 16.0, true, None);
    assert_eq!(drain(&mut viewer, 16.0), []);

    viewer.frame(32.0, 16.0, true, None);
    let (ack, durable) = acks(&drain(&mut viewer, 32.0))[0];
    assert_eq!(
        (ack.grant, durable),
        (3, true),
        "the grant that fills the window"
    );
    assert!(!viewer.wants_frame(true), "a full window stops the clock");
    viewer.frame(48.0, 16.0, false, None);
    assert_eq!(
        drain(&mut viewer, 48.0),
        [],
        "a hidden terminal grants nothing"
    );
}

#[test]
fn only_the_display_lanes_reach_the_viewer() {
    let mut viewer = rooted(1);
    viewer.receive(1.0, CHANNEL_CTRL, &delta(1, 1), InputMapping::default());
    assert_eq!(viewer.grid().applied, [(true, 1, 0)]);
}

#[test]
fn a_full_ahead_buffer_drops_without_touching_the_lineage() {
    let mut viewer = rooted(1);
    for seq in 1..=(MAX_AHEAD_FRAMES as u32 + 8) {
        datagram(&mut viewer, 1.0, &delta(2, seq));
    }
    viewer.receive(
        2.0,
        CHANNEL_DISPLAY_COMMIT,
        &snapshot(2),
        InputMapping::default(),
    );
    let replayed = viewer
        .grid()
        .applied
        .iter()
        .filter(|(snapshot, generation, _)| !snapshot && *generation == 2)
        .count();
    assert_eq!(replayed, MAX_AHEAD_FRAMES);
    assert_eq!(viewer.stats().resyncs, 0);
}

/// A protected delta, as the daemon marks the datagrams one repair covers.
fn protected_delta(generation: u32, seq: u32) -> Vec<u8> {
    Spec {
        flags: merkur_codec::DISPLAY_HEADER_FLAG_FEC_PROTECTED,
        ..Spec::delta(generation, seq)
    }
    .encode()
}

/// The repair envelope over `frames` with one parity shard.
fn fec_repair(generation: u32, frames: &[Vec<u8>]) -> Vec<u8> {
    use merkur_fec::repair::{RepairHeader, repair_header_bytes};
    let shard_size = frames.iter().map(Vec::len).max().expect("frames");
    let padded: Vec<Vec<u8>> = frames
        .iter()
        .map(|frame| {
            let mut shard = frame.clone();
            shard.resize(shard_size, 0);
            shard
        })
        .collect();
    let data: Vec<&[u8]> = padded.iter().map(Vec::as_slice).collect();
    let mut body = vec![0u8; shard_size];
    merkur_fec::encode(&data, &mut [&mut body[..]]).expect("parity");
    let header = RepairHeader {
        batch_start_seq: parse_stream_header(&frames[0]).expect("a frame").seq,
        data_shards: frames.len() as u8,
        recovery_shards: 1,
        shard_size: shard_size as u16,
        generation,
    };
    let mut envelope =
        repair_header_bytes(MSG_TYPE_DISPLAY_FEC_REPAIR, &header, body.len() as u16).to_vec();
    envelope.extend_from_slice(&body);
    envelope
}

#[test]
fn a_datagram_fec_rebuilds_applies_and_is_acknowledged_as_recovered() {
    let mut viewer = rooted(1);
    let frames: Vec<Vec<u8>> = (1..=3).map(|seq| protected_delta(1, seq)).collect();
    datagram(&mut viewer, 1.0, &frames[0]);
    datagram(&mut viewer, 1.0, &frames[2]);
    datagram(&mut viewer, 2.0, &fec_repair(1, &frames));
    assert_eq!(viewer.grid().applied.last(), Some(&(false, 1, 2)));
    assert_eq!(viewer.stats().recovered, 1);
    let (ack, _) = acks(&drain(&mut viewer, 2.0))[0];
    assert_eq!((ack.largest_seq, ack.received[0]), (3, 0b111));
    assert_eq!(ack.recovered[0], 0b010, "seq 2 is marked rebuilt");
    assert_eq!(viewer.grid().outstanding(), 0);
}

/// Wire 1..=3 names local 100..=102 under epoch `epoch`.
fn numbering(epoch: u32) -> InputMapping {
    InputMapping {
        epoch,
        local_minus_wire: 99,
        wire_min: 1,
        wire_max: 3,
    }
}

#[test]
fn a_frame_names_input_in_the_numbering_it_arrived_under() {
    let mut viewer = rooted(1);
    let applied = |input_seq| {
        Spec {
            input_seq,
            ..Spec::delta(1, input_seq)
        }
        .encode()
    };
    viewer.receive(1.0, CHANNEL_DISPLAY_DATAGRAM, &applied(2), numbering(2));
    assert_eq!(viewer.presentation().display_input_seq(), 101);
    // A wire sequence the session never assigned under it names nothing.
    viewer.receive(2.0, CHANNEL_DISPLAY_DATAGRAM, &applied(4), numbering(2));
    assert_eq!(viewer.grid().applied.last(), Some(&(false, 1, 4)));
    assert_eq!(viewer.presentation().display_input_seq(), 101);
}

#[test]
fn a_frame_under_a_replaced_numbering_is_dropped_and_a_new_one_restarts_fec() {
    let mut viewer = rooted(1);
    let frames: Vec<Vec<u8>> = (1..=3).map(|seq| protected_delta(1, seq)).collect();
    viewer.receive(1.0, CHANNEL_DISPLAY_DATAGRAM, &frames[0], numbering(2));
    viewer.receive(1.0, CHANNEL_DISPLAY_DATAGRAM, &frames[2], numbering(3));
    viewer.receive(
        2.0,
        CHANNEL_DISPLAY_DATAGRAM,
        &fec_repair(1, &frames),
        numbering(3),
    );
    assert_eq!(
        viewer.stats().recovered,
        0,
        "the batch began under another numbering"
    );
    viewer.receive(3.0, CHANNEL_DISPLAY_DATAGRAM, &delta(1, 4), numbering(2));
    assert_eq!(viewer.grid().applied.last(), Some(&(false, 1, 3)));
}

#[test]
fn a_session_fence_forgets_retained_protected_frames() {
    let mut viewer = rooted(1);
    let frames: Vec<Vec<u8>> = (1..=3).map(|seq| protected_delta(1, seq)).collect();
    datagram(&mut viewer, 1.0, &frames[0]);
    datagram(&mut viewer, 1.0, &frames[2]);
    viewer.fence(2.0, SUCCESSOR);
    viewer.receive(
        3.0,
        CHANNEL_DISPLAY_COMMIT,
        &snapshot(1),
        InputMapping::default(),
    );
    datagram(&mut viewer, 4.0, &fec_repair(1, &frames));
    assert_eq!(viewer.stats().recovered, 0);
}

/// A row-hash digest of `generation` at `up_to_seq`, as the daemon sends it
/// on the control lane.
fn digest(generation: u32, up_to_seq: u32, rows: &[(u16, u64)]) -> Vec<u8> {
    let mut body = Vec::new();
    body.extend_from_slice(&generation.to_be_bytes());
    body.extend_from_slice(&up_to_seq.to_be_bytes());
    body.extend_from_slice(&(rows.len() as u16).to_be_bytes());
    for (row, hash) in rows {
        body.extend_from_slice(&row.to_be_bytes());
        body.extend_from_slice(&hash.to_be_bytes());
    }
    merkur_wire::protocol::encode_proto_frame(MSG_TYPE_DISPLAY_HASH_DIGEST, &body)
}

fn resync_rows(outputs: &[Output]) -> Vec<(u32, Vec<u16>)> {
    outputs
        .iter()
        .filter_map(|output| match output {
            Output::ResyncRows { generation, rows } => Some((*generation, rows.clone())),
            _ => None,
        })
        .collect()
}

/// Rows 0..3 hash to 10, 11, 12 on the fake grid.
fn hashed(generation: u32) -> Viewer<FakeGrid> {
    let mut viewer = rooted(generation);
    viewer.grid_mut().hashes = vec![10, 11, 12];
    viewer
}

#[test]
fn a_digest_at_the_applied_position_names_the_rows_that_diverged() {
    let mut viewer = hashed(1);
    datagram(&mut viewer, 1.0, &delta(1, 1));
    drain(&mut viewer, 1.0);
    viewer.receive(
        2.0,
        CHANNEL_CTRL,
        &digest(1, 1, &[(0, 10), (1, 99), (2, 12)]),
        InputMapping::default(),
    );
    assert_eq!(resync_rows(&drain(&mut viewer, 2.0)), [(1, vec![1])]);
    // Agreement asks for nothing.
    viewer.receive(
        3.0,
        CHANNEL_CTRL,
        &digest(1, 1, &[(0, 10), (1, 11)]),
        InputMapping::default(),
    );
    assert_eq!(drain(&mut viewer, 3.0), []);
}

#[test]
fn a_digest_behind_the_grid_is_ignored() {
    let mut viewer = hashed(1);
    datagram(&mut viewer, 1.0, &delta(1, 1));
    datagram(&mut viewer, 1.0, &delta(1, 2));
    drain(&mut viewer, 1.0);
    viewer.receive(
        2.0,
        CHANNEL_CTRL,
        &digest(1, 1, &[(1, 99)]),
        InputMapping::default(),
    );
    assert_eq!(
        drain(&mut viewer, 2.0),
        [],
        "rows changed since would all look diverged"
    );
    assert_eq!(viewer.next_deadline(), None);
}

#[test]
fn a_digest_ahead_of_the_grid_waits_for_exactly_its_position() {
    let mut viewer = hashed(1);
    datagram(&mut viewer, 1.0, &delta(1, 1));
    viewer.receive(
        2.0,
        CHANNEL_CTRL,
        &digest(1, 2, &[(2, 99)]),
        InputMapping::default(),
    );
    assert_eq!(
        viewer.next_deadline(),
        Some(2.0 + DEFERRED_DIGEST_DEADLINE_MS)
    );
    drain(&mut viewer, 2.0);
    datagram(&mut viewer, 3.0, &delta(1, 2));
    assert_eq!(resync_rows(&drain(&mut viewer, 3.0)), [(1, vec![2])]);

    // One the grid passes without landing on is dropped.
    viewer.receive(
        4.0,
        CHANNEL_CTRL,
        &digest(1, 3, &[(2, 99)]),
        InputMapping::default(),
    );
    datagram(&mut viewer, 5.0, &delta(1, 4));
    assert_eq!(resync_rows(&drain(&mut viewer, 5.0)), []);
    viewer.handle_timeout(10_000.0);
    assert_eq!(drain(&mut viewer, 10_000.0), []);
}

#[test]
fn a_digest_of_a_generation_whose_snapshot_never_came_is_a_resync_once_quiet() {
    let mut viewer = hashed(1);
    viewer.receive(
        2.0,
        CHANNEL_CTRL,
        &digest(2, 1, &[(0, 99)]),
        InputMapping::default(),
    );
    let due = viewer.next_deadline().expect("deferred");
    assert_eq!(due, 2.0 + DEFERRED_DIGEST_DEADLINE_MS);
    // Frames still applying inside the quiet period hold the verdict.
    datagram(&mut viewer, due - 10.0, &delta(1, 1));
    drain(&mut viewer, due - 10.0);
    viewer.handle_timeout(due);
    assert_eq!(drain(&mut viewer, due), []);
    let again = viewer.next_deadline().expect("re-armed");
    assert_eq!(again, due + DEFERRED_DIGEST_DEADLINE_MS);

    viewer.handle_timeout(again);
    assert_eq!(drain(&mut viewer, again), [Output::SnapshotRequest]);
    assert_eq!(
        viewer.stats().last_resync,
        Some(Resync::HashDigestGenerationAhead)
    );
}

#[test]
fn a_digest_of_the_snapshot_itself_is_compared_at_once() {
    let mut viewer = hashed(1);
    viewer.receive(
        2.0,
        CHANNEL_CTRL,
        &digest(1, 0, &[(1, 99)]),
        InputMapping::default(),
    );
    assert_eq!(
        resync_rows(&drain(&mut viewer, 2.0)),
        [(1, vec![1])],
        "nothing applied since the snapshot: the digest is at the grid's position"
    );
}

#[test]
fn a_session_awaiting_its_snapshot_compares_no_digest() {
    let mut viewer = viewer();
    viewer.fence(1.0, SESSION);
    drain(&mut viewer, 1.0);
    let armed = viewer.next_deadline();
    viewer.receive(
        2.0,
        CHANNEL_CTRL,
        &digest(1, 0, &[(0, 99)]),
        InputMapping::default(),
    );
    assert_eq!(drain(&mut viewer, 2.0), []);
    assert_eq!(viewer.next_deadline(), armed, "no digest waits");
}

#[test]
fn a_malformed_digest_is_refused_whole() {
    let mut viewer = hashed(1);
    datagram(&mut viewer, 1.0, &delta(1, 1));
    drain(&mut viewer, 1.0);
    // The same row twice.
    viewer.receive(
        2.0,
        CHANNEL_CTRL,
        &digest(1, 1, &[(1, 99), (1, 98)]),
        InputMapping::default(),
    );
    assert_eq!(drain(&mut viewer, 2.0), []);
    // A row past the grid the digest is compared against.
    viewer.receive(
        3.0,
        CHANNEL_CTRL,
        &digest(1, 1, &[(30, 99)]),
        InputMapping::default(),
    );
    assert_eq!(drain(&mut viewer, 3.0), []);
}

/// A dictionary install as the daemon frames it on the control lane.
fn install(generation: u32, id: u32, hash: u32, bytes: &[u8], declared: u16) -> Vec<u8> {
    let mut body = Vec::new();
    body.extend_from_slice(&generation.to_be_bytes());
    body.extend_from_slice(&id.to_be_bytes());
    body.extend_from_slice(&hash.to_be_bytes());
    body.extend_from_slice(&declared.to_be_bytes());
    body.extend_from_slice(bytes);
    merkur_wire::protocol::encode_proto_frame(
        merkur_wire::protocol::MSG_TYPE_DISPLAY_DICT_INSTALL,
        &body,
    )
}

#[test]
fn a_dictionary_the_grid_holds_is_acknowledged_once() {
    let mut viewer = rooted(1);
    viewer.receive(
        1.0,
        CHANNEL_CTRL,
        &install(1, 7, 0xabcd, b"dict", 4),
        InputMapping::default(),
    );
    viewer.receive(
        1.0,
        CHANNEL_CTRL,
        &install(1, 7, 0xabcd, b"dict", 4),
        InputMapping::default(),
    );
    assert_eq!(drain(&mut viewer, 1.0), [Output::DictionaryAck(7)]);
    assert_eq!(
        viewer.grid().dictionaries,
        [
            (1, 7, 0xabcd, b"dict".to_vec()),
            (1, 7, 0xabcd, b"dict".to_vec())
        ],
        "the grid is the one that treats an exact duplicate as idempotent"
    );
}

#[test]
fn a_refused_or_misframed_dictionary_is_never_acknowledged() {
    let mut viewer = rooted(1);
    viewer.receive(
        1.0,
        CHANNEL_CTRL,
        &install(1, 7, 0xabcd, b"dict", 5),
        InputMapping::default(),
    );
    assert!(
        viewer.grid().dictionaries.is_empty(),
        "a length that lies is not installed"
    );
    viewer.grid_mut().refuse_dictionaries = true;
    viewer.receive(
        1.0,
        CHANNEL_CTRL,
        &install(1, 8, 0xabcd, b"dict", 4),
        InputMapping::default(),
    );
    assert_eq!(drain(&mut viewer, 1.0), []);
}

#[test]
fn a_kept_grid_keeps_its_dictionaries_and_a_grid_it_cannot_claim_clears_them() {
    let mut viewer = rooted(1);
    datagram(&mut viewer, 1.0, &delta(1, 1));
    drain(&mut viewer, 1.0);
    viewer.receive(
        1.0,
        CHANNEL_CTRL,
        &install(1, 7, 0xabcd, b"dict", 4),
        InputMapping::default(),
    );
    // The claim carries row hashes, so the daemon keeps its dictionaries too
    // and still wants the acknowledgement.
    viewer.fence(2.0, SUCCESSOR);
    assert_eq!(viewer.grid().dictionaries.len(), 1);
    let outputs = drain(&mut viewer, 2.0);
    assert_eq!(outputs[0], Output::DictionaryAck(7));
    assert_eq!(outputs.last(), Some(&Output::DictionaryReady(true)));

    // A grid still waiting for its first snapshot cannot be claimed.
    let mut waiting = self::viewer();
    waiting.fence(0.0, SESSION);
    waiting.receive(
        1.0,
        CHANNEL_CTRL,
        &install(1, 9, 0xabcd, b"dict", 4),
        InputMapping::default(),
    );
    waiting.fence(2.0, SUCCESSOR);
    assert!(waiting.grid().dictionaries.is_empty());
    assert_eq!(
        drain(&mut waiting, 2.0),
        fenced(),
        "an acknowledgement the last session owed is not carried into this one"
    );
}

/// A viewer rooted at generation 1 whose snapshot is already shown.
fn shown() -> Viewer<FakeGrid> {
    let mut viewer = rooted(1);
    assert_eq!(
        viewer.present_now(0.0),
        Some(Release::Urgent),
        "a snapshot is urgent state"
    );
    viewer
}

#[test]
fn urgent_state_is_shown_at_once() {
    let mut viewer = shown();
    datagram(&mut viewer, 1.0, &delta(1, 1));
    assert_eq!(viewer.present_now(1.0), Some(Release::Urgent));
    assert_eq!(viewer.grid().presented, [1, 2]);
    assert_eq!(viewer.present_now(2.0), None, "nothing new to show");
}

#[test]
fn a_coherent_redraw_is_held_until_its_membership_completes_at_a_frame() {
    let mut viewer = shown();
    datagram(
        &mut viewer,
        1.0,
        &Spec::member(1, 1, 7, 0, 2, false).encode(),
    );
    assert_eq!(
        viewer.present_now(1.0),
        None,
        "half a redraw is never shown"
    );
    assert!(viewer.wants_frame(true), "the hold needs frames");
    assert_eq!(viewer.frame(16.0, 16.0, true, None), None);
    datagram(
        &mut viewer,
        17.0,
        &Spec::member(1, 2, 7, 1, 2, true).encode(),
    );
    assert_eq!(
        viewer.present_now(17.0),
        None,
        "coherent work commits at a frame"
    );
    assert_eq!(
        viewer.frame(32.0, 16.0, true, None),
        Some(Release::EndQuiet)
    );
    assert_eq!(
        viewer.grid().presented,
        [1, 3],
        "one commit covers both members"
    );
}

#[test]
fn an_incomplete_redraw_is_shown_at_the_second_frame() {
    let mut viewer = shown();
    datagram(
        &mut viewer,
        1.0,
        &Spec::member(1, 1, 7, 0, 2, false).encode(),
    );
    assert_eq!(viewer.frame(16.0, 16.0, true, None), None);
    assert_eq!(
        viewer.frame(32.0, 16.0, true, None),
        Some(Release::Deadline)
    );
}

#[test]
fn a_claimed_screen_is_held_until_the_grid_digests_to_it_then_shown_early() {
    let mut viewer = shown();
    let claimed = Spec {
        closure_digest: 0xfeed,
        ..Spec::member(1, 1, 7, 0, 2, false)
    };
    datagram(&mut viewer, 1.0, &claimed.encode());
    for frame in 1..=4 {
        assert_eq!(
            viewer.frame(f64::from(frame) * 16.0, 16.0, true, None),
            None,
            "a pending claim outlasts the frame bound"
        );
    }
    viewer.grid_mut().closure_met = true;
    let completing = Spec {
        closure_digest: 0xfeed,
        ..Spec::member(1, 2, 7, 1, 2, true)
    };
    datagram(&mut viewer, 70.0, &completing.encode());
    assert_eq!(
        viewer.present_now(70.0),
        Some(Release::ClosureComplete),
        "a met claim commits inside the task"
    );
}

#[test]
fn a_claim_noted_before_a_local_change_to_the_grid_is_never_met() {
    let mut viewer = shown();
    let claimed = Spec {
        closure_digest: 0xfeed,
        ..Spec::member(1, 2, 7, 1, 2, false)
    };
    datagram(&mut viewer, 1.0, &claimed.encode());
    assert_eq!(viewer.frame(16.0, 16.0, true, None), None);
    // A local resize, after which the grid happens to digest to the claim.
    viewer.grid_mut().mutation_epoch += 1;
    viewer.grid_mut().closure_met = true;
    // An older frame leaves the newest claim in place and re-judges it.
    datagram(
        &mut viewer,
        20.0,
        &Spec::member(1, 1, 7, 0, 2, false).encode(),
    );
    assert_eq!(viewer.present_now(20.0), None, "a stale claim is not met");
    assert_eq!(viewer.frame(32.0, 16.0, true, None), None);
    assert_eq!(
        viewer.frame(48.0, 16.0, true, None),
        Some(Release::Deadline),
        "the frame rule governs again"
    );
}

#[test]
fn a_complete_paced_state_is_shown_as_it_lands() {
    let mut viewer = shown();
    // A frame opens this frame's early opportunity.
    viewer.frame(16.0, 16.0, true, None);
    let paced = Spec {
        awaits_grant: true,
        demand_serial: 1,
        ..Spec::member(1, 1, 7, 0, 1, false)
    };
    datagram(&mut viewer, 17.0, &paced.encode());
    assert_eq!(viewer.present_now(17.0), Some(Release::PacedComplete));
    let next = Spec {
        awaits_grant: true,
        demand_serial: 2,
        ..Spec::member(1, 2, 8, 0, 1, false)
    };
    datagram(&mut viewer, 18.0, &next.encode());
    assert_eq!(viewer.present_now(18.0), None, "one early commit per frame");
    assert_eq!(
        viewer.frame(32.0, 16.0, true, None),
        Some(Release::PacedComplete)
    );
}

#[test]
fn a_nonvisual_apply_shows_nothing() {
    let mut viewer = shown();
    viewer.grid_mut().nonvisual = true;
    datagram(&mut viewer, 1.0, &delta(1, 1));
    assert_eq!(viewer.present_now(1.0), None);
    assert_eq!(viewer.frame(16.0, 16.0, true, None), None);
    assert_eq!(viewer.grid().presented, [1]);
}

#[test]
fn a_session_fence_drops_the_held_transaction_and_keeps_it_offscreen() {
    let mut viewer = shown();
    datagram(
        &mut viewer,
        1.0,
        &Spec::member(1, 1, 7, 0, 2, false).encode(),
    );
    viewer.fence(2.0, SUCCESSOR);
    assert!(!viewer.presentation().has_pending_transaction());
    assert!(!viewer.presentation().is_held());
    // The kept grid is claimed, but the half transaction it holds may show
    // only once a snapshot replaced it.
    let outputs = drain(&mut viewer, 2.0);
    assert!(matches!(
        outputs[0],
        Output::Resume(DisplayResume {
            row_hashes: Some(_),
            ..
        })
    ));
    assert_eq!(requests(&outputs), 1);
    assert_eq!(viewer.present_now(3.0), None);
    assert_eq!(viewer.frame(16.0, 16.0, true, None), None);
    viewer.receive(
        20.0,
        CHANNEL_DISPLAY_COMMIT,
        &snapshot(1),
        InputMapping::default(),
    );
    assert_eq!(viewer.present_now(20.0), Some(Release::Urgent));
    assert_eq!(viewer.grid().presented, [1, 3]);
}

#[test]
fn a_snapshot_that_never_comes_shows_what_applied_at_its_deadline() {
    let mut viewer = shown();
    datagram(
        &mut viewer,
        1.0,
        &Spec::member(1, 1, 7, 0, 2, false).encode(),
    );
    viewer.fence(2.0, SUCCESSOR);
    let deadline = 2.0 + snapshot_deadline_ms(None);
    assert_eq!(viewer.next_deadline(), Some(deadline));
    viewer.handle_timeout(deadline - 1.0);
    assert_eq!(viewer.present_now(deadline - 1.0), None);
    viewer.handle_timeout(deadline);
    assert!(viewer.present_now(deadline).is_some());
    assert_eq!(viewer.grid().presented, [1, 2]);
}

fn routing(generation: u32, after_seq: u32, serial: u32, word: u16) -> Vec<u8> {
    encode_input_routing_frame(generation, after_seq, serial, word).to_vec()
}

const REPORTS: u16 = 0x00c0;

#[test]
fn a_routing_word_holds_until_a_frame_past_its_position_applies() {
    let mut viewer = rooted(1);
    datagram(&mut viewer, 1.0, &delta(1, 1));
    viewer.receive(
        2.0,
        CHANNEL_CTRL,
        &routing(1, 2, 1, REPORTS),
        InputMapping::default(),
    );
    assert_eq!(viewer.grid().routing, [(2, Some(REPORTS))]);
    // Frame 2 was sent before the word: its header cannot take the bits back.
    datagram(&mut viewer, 3.0, &delta(1, 2));
    assert_eq!(viewer.grid().routing.len(), 1);
    // Frame 3 was captured after it, and releases the bits to its header.
    datagram(&mut viewer, 4.0, &delta(1, 3));
    assert_eq!(viewer.grid().routing, [(2, Some(REPORTS)), (4, None)]);
}

#[test]
fn a_routing_word_an_applied_frame_passed_is_dropped_and_a_misframed_one_ignored() {
    let mut viewer = rooted(1);
    datagram(&mut viewer, 1.0, &delta(1, 2));
    viewer.receive(
        2.0,
        CHANNEL_CTRL,
        &routing(1, 1, 1, REPORTS),
        InputMapping::default(),
    );
    let mut short = routing(1, 5, 2, REPORTS);
    short.pop();
    short[3] -= 1;
    viewer.receive(3.0, CHANNEL_CTRL, &short, InputMapping::default());
    assert_eq!(viewer.grid().routing, []);
}

#[test]
fn a_session_fence_lets_the_next_session_order_its_own_words_and_frames() {
    let mut viewer = rooted(1);
    viewer.receive(
        1.0,
        CHANNEL_CTRL,
        &routing(1, 9, 7, REPORTS),
        InputMapping::default(),
    );
    viewer.fence(2.0, SUCCESSOR);
    // The next session may be another daemon process, whose serials restart.
    viewer.receive(
        3.0,
        CHANNEL_CTRL,
        &routing(1, 9, 1, 0),
        InputMapping::default(),
    );
    assert_eq!(viewer.grid().routing, [(1, Some(REPORTS)), (1, Some(0))]);
    viewer.fence(4.0, DisplayFence { lineage: 3 });
    // Nor need its sequences follow the held word's position: whatever it
    // applies first was captured after that word.
    viewer.receive(
        5.0,
        CHANNEL_DISPLAY_COMMIT,
        &snapshot(1),
        InputMapping::default(),
    );
    assert_eq!(viewer.grid().routing.last(), Some(&(2, None)));
}

#[test]
fn a_stale_generation_recovery_orders_a_word_by_its_own_position() {
    let mut viewer = rooted(5);
    datagram(&mut viewer, 10.0, &delta(5, 1));
    // The applied generation sits above the daemon's, so its word is dropped.
    viewer.receive(
        11.0,
        CHANNEL_CTRL,
        &routing(4, 1, 1, REPORTS),
        InputMapping::default(),
    );
    assert_eq!(viewer.grid().routing, []);
    datagram(&mut viewer, 1_011.0, &delta(4, 10));
    assert_eq!(
        viewer.stats().last_resync,
        Some(Resync::StaleGenerationRecovery)
    );
    viewer.receive(
        1_012.0,
        CHANNEL_CTRL,
        &routing(4, 1, 1, REPORTS),
        InputMapping::default(),
    );
    assert_eq!(viewer.grid().routing, [(2, Some(REPORTS))]);
    // The word came from that daemon: its snapshot and frame 1 precede it.
    viewer.receive(
        1_020.0,
        CHANNEL_DISPLAY_COMMIT,
        &snapshot(4),
        InputMapping::default(),
    );
    assert_eq!(viewer.grid().routing.len(), 1);
    datagram(&mut viewer, 1_021.0, &delta(4, 2));
    assert_eq!(viewer.grid().routing.last(), Some(&(4, None)));
}

mod graphics;

#[test]
fn renderer_capacity_holds_visual_promotion_while_receive_and_ack_continue() {
    let mut viewer = rooted(7);
    let presentations = viewer.stats.presentations;
    viewer.set_presentation_ready(false);
    datagram(&mut viewer, 1.0, &delta(7, 1));
    assert_eq!(viewer.applied_sequence(), 1);
    assert_eq!(viewer.stats.presentations, presentations);
    assert!(!acks(&drain(&mut viewer, 1.0)).is_empty());
    viewer.frame(16.0, 16.0, true, None);
    assert_eq!(viewer.stats.presentations, presentations);
    viewer.set_presentation_ready(true);
    assert!(viewer.present_now(17.0).is_some());
    assert_eq!(viewer.stats.presentations, presentations + 1);
}

#[test]
fn host_row_repair_is_owned_and_bounded_by_the_current_lineage() {
    let mut viewer = rooted(1);
    assert!(!viewer.request_row_repair(2, &[0]));
    assert!(!viewer.request_row_repair(1, &[]));
    assert!(!viewer.request_row_repair(1, &[24]));
    assert!(viewer.request_row_repair(1, &[2, 0, 2]));
    let repairs: Vec<_> = drain(&mut viewer, 0.0)
        .into_iter()
        .filter_map(|output| {
            if let Output::ResyncRows { generation, rows } = output {
                Some((generation, rows))
            } else {
                None
            }
        })
        .collect();
    assert_eq!(repairs, [(1, vec![0, 2])]);
    assert_eq!(viewer.stats().resync_rows, 2);
    viewer.fence(1.0, DisplayFence { lineage: 2 });
    assert!(!viewer.request_row_repair(1, &[0]));
}

#[test]
fn an_empty_matching_resume_repair_commits_without_another_display_frame() {
    let mut viewer = rooted(7);
    assert!(viewer.present_now(0.0).is_some());
    let frames = viewer.stats().frames;
    let presentations = viewer.stats().presentations;
    viewer.fence(1.0, SUCCESSOR);
    let mut body = Vec::new();
    body.extend_from_slice(&7u32.to_be_bytes());
    body.extend_from_slice(&2u32.to_be_bytes());
    body.extend_from_slice(&0u16.to_be_bytes());
    viewer.receive(
        2.0,
        CHANNEL_CTRL,
        &encode_proto_frame(MSG_TYPE_DISPLAY_REPAIR_END, &body),
        InputMapping::default(),
    );
    viewer.set_presentation_ready(false);
    assert!(viewer.present_now(2.0).is_none());
    viewer.set_presentation_ready(true);
    assert!(viewer.present_now(3.0).is_some());
    assert_eq!(viewer.stats().frames, frames);
    assert_eq!(viewer.stats().presentations, presentations + 1);
}

#[test]
fn identical_authenticated_anchors_retire_unsent_preview_authority_but_malformed_input_does_not() {
    let mut viewer = Viewer::new(FakeGrid::default());
    viewer.fence(0.0, DisplayFence { lineage: 1 });
    let initial = viewer.prediction_authority_revision();
    let anchor = [0, 0, 0, 1, 0, 0, 0, 2, 0, 1];
    let bytes = encode_proto_frame(merkur_wire::protocol::MSG_TYPE_EDITOR_ANCHOR, &anchor);
    viewer.receive(1.0, CHANNEL_CTRL, &bytes, InputMapping::default());
    assert_eq!(viewer.prediction_authority_revision(), initial + 1);
    viewer.receive(2.0, CHANNEL_CTRL, &bytes, InputMapping::default());
    assert_eq!(viewer.prediction_authority_revision(), initial + 2);
    let malformed = encode_proto_frame(merkur_wire::protocol::MSG_TYPE_EDITOR_ANCHOR, &anchor[..9]);
    viewer.receive(3.0, CHANNEL_CTRL, &malformed, InputMapping::default());
    viewer.receive(4.0, CHANNEL_DISPLAY_COMMIT, &[0], InputMapping::default());
    assert_eq!(viewer.prediction_authority_revision(), initial + 2);
}

#[test]
fn an_owned_resize_never_claims_or_repairs_the_local_guess() {
    let mut viewer = hashed(1);
    viewer.resize(100, 30);
    viewer.grid_mut().hashes = vec![900, 901, 902];
    viewer.receive(
        1.0,
        CHANNEL_CTRL,
        &digest(1, 0, &[(0, 10)]),
        InputMapping::default(),
    );
    assert!(
        resync_rows(&drain(&mut viewer, 1.0)).is_empty(),
        "the resized grid is not the daemon's row lineage"
    );
    viewer.fence(2.0, SUCCESSOR);
    assert!(matches!(
        drain(&mut viewer, 2.0).first(),
        Some(Output::Resume(DisplayResume {
            row_hashes: None,
            ..
        }))
    ));
}

#[test]
fn an_in_flight_snapshot_cannot_resize_the_controlling_viewport_backwards() {
    let mut viewer = rooted(1);
    viewer.resize(100, 30);
    viewer.receive(
        1.0,
        CHANNEL_DISPLAY_COMMIT,
        &snapshot(2),
        InputMapping::default(),
    );
    assert_eq!((viewer.grid().cols(), viewer.grid().rows()), (100, 30));
}

#[test]
fn only_matching_authority_finishes_a_resize_and_reenables_row_lineage() {
    let mut viewer = hashed(1);
    viewer.set_tracing(true);
    viewer.resize(100, 30);
    viewer.receive(
        1.0,
        CHANNEL_DISPLAY_COMMIT,
        &snapshot(2),
        InputMapping::default(),
    );
    assert!(viewer.resize_pending);
    assert!(!viewer.grid().observations.iter().any(|words| words[0] == 4));
    viewer.grid_mut().hashes = vec![900, 901, 902];
    let matching = Spec {
        cols: 100,
        rows: 30,
        row_count: 30,
        ..Spec::snapshot(3)
    };
    viewer.receive(
        2.0,
        CHANNEL_DISPLAY_COMMIT,
        &matching.encode(),
        InputMapping::default(),
    );
    assert!(!viewer.resize_pending);
    let resize: Vec<_> = viewer
        .grid()
        .observations
        .iter()
        .filter(|words| words[0] == 4)
        .collect();
    assert_eq!(resize.len(), 1);
    assert_eq!(&resize[0][..6], &[4, 100, 30, 1, 3, 30]);
    viewer.receive(
        3.0,
        CHANNEL_CTRL,
        &digest(3, 0, &[(0, 900)]),
        InputMapping::default(),
    );
    assert!(resync_rows(&drain(&mut viewer, 3.0)).is_empty());
    viewer.present_now(3.0);
    viewer.fence(4.0, SUCCESSOR);
    assert!(matches!(
        drain(&mut viewer, 4.0).first(),
        Some(Output::Resume(DisplayResume {
            row_hashes: Some(_),
            ..
        }))
    ));
}

/// A viewer holding member 0 of 2 of a coherent redraw offscreen, at
/// generation 1, sequence 1.
fn holding_offscreen(recording: bool) -> Viewer<FakeGrid> {
    let mut viewer = rooted(1);
    viewer.set_tracing(recording);
    // The rooting snapshot shows, so the transaction holds the member alone.
    viewer.present_now(0.5);
    assert!(!viewer.presentation().has_pending_transaction());
    viewer.grid_mut().observations.clear();
    datagram(
        &mut viewer,
        1.0,
        &Spec::member(1, 1, 7, 0, 2, false).encode(),
    );
    assert!(viewer.presentation().has_pending_transaction());
    viewer
}

/// The discard records a recording host was told: `(generation, first and
/// last sequence, datagrams, reason)`.
fn discards(viewer: &Viewer<FakeGrid>) -> Vec<[u32; 5]> {
    viewer
        .grid()
        .observations
        .iter()
        .filter(|words| words[0] == 5)
        .map(|words| [words[1], words[2], words[3], words[4], words[7]])
        .collect()
}

#[test]
fn a_snapshot_over_an_offscreen_transaction_tells_a_recording_host_what_went_first() {
    let mut viewer = holding_offscreen(true);
    viewer.receive(
        2.0,
        CHANNEL_DISPLAY_COMMIT,
        &snapshot(2),
        InputMapping::default(),
    );
    // Resync: the snapshot continues the lineage.
    assert_eq!(discards(&viewer), [[1, 1, 1, 1, 0]]);
    let observations = &viewer.grid().observations;
    let discarded = observations.iter().position(|words| words[0] == 5);
    let replaced = observations
        .iter()
        .position(|words| words[0] == 3 && words[2] == 2);
    assert!(
        discarded < replaced,
        "the discard precedes the replacement's apply"
    );
}

#[test]
fn a_lineage_boundary_and_the_hosts_end_each_name_their_own_reason() {
    let mut fenced = holding_offscreen(true);
    fenced.fence(2.0, SUCCESSOR);
    assert_eq!(discards(&fenced), [[1, 1, 1, 1, 1]]);

    let mut ended = holding_offscreen(true);
    ended.discard_presentation();
    assert_eq!(discards(&ended), [[1, 1, 1, 1, 2]]);
    // Nothing is left to tell twice.
    ended.discard_presentation();
    assert_eq!(discards(&ended).len(), 1);
}

#[test]
fn a_host_that_does_not_record_is_told_of_no_discard() {
    let mut viewer = holding_offscreen(false);
    viewer.fence(2.0, SUCCESSOR);
    assert!(viewer.grid().observations.is_empty());
}

#[test]
fn a_geometry_transfer_retires_the_requested_viewport_and_waits_for_authority() {
    let mut viewer = hashed(1);
    viewer.resize(100, 30);
    viewer.release_geometry(1.0);
    let outputs = drain(&mut viewer, 1.0);
    assert_eq!(requests(&outputs), 1);
    viewer.receive(
        2.0,
        CHANNEL_CTRL,
        &digest(1, 0, &[(0, 900)]),
        InputMapping::default(),
    );
    assert!(resync_rows(&drain(&mut viewer, 2.0)).is_empty());
    viewer.receive(
        3.0,
        CHANNEL_DISPLAY_COMMIT,
        &snapshot(2),
        InputMapping::default(),
    );
    assert_eq!((viewer.grid().cols(), viewer.grid().rows()), (80, 24));
    assert!(!viewer.resize_pending);
    viewer.receive(
        4.0,
        CHANNEL_CTRL,
        &digest(2, 0, &[(0, 900)]),
        InputMapping::default(),
    );
    assert_eq!(resync_rows(&drain(&mut viewer, 4.0)), [(2, vec![0])]);
}

#[test]
fn a_rebind_does_not_resume_the_local_guess_or_keep_retired_geometry_ownership() {
    let mut viewer = hashed(1);
    viewer.resize(100, 30);
    viewer.fence(1.0, SUCCESSOR);
    let outputs = drain(&mut viewer, 1.0);
    assert!(matches!(
        outputs.first(),
        Some(Output::Resume(DisplayResume {
            row_hashes: None,
            ..
        }))
    ));
    assert_eq!(requests(&outputs), 1);
    assert_eq!(viewer.owned_geometry, None);
    viewer.receive(
        2.0,
        CHANNEL_DISPLAY_COMMIT,
        &snapshot(2),
        InputMapping::default(),
    );
    assert_eq!((viewer.grid().cols(), viewer.grid().rows()), (80, 24));
    // Only a new authenticated geometry-owner edge may install the host's request again.
    viewer.resize(100, 30);
    viewer.receive(
        3.0,
        CHANNEL_DISPLAY_COMMIT,
        &snapshot(3),
        InputMapping::default(),
    );
    assert_eq!((viewer.grid().cols(), viewer.grid().rows()), (100, 30));
    assert!(viewer.resize_pending);
}
