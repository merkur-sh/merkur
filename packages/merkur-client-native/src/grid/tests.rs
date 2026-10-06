//! The viewer over the real terminal. The routing path is the port of
//! `terminal-worker-input-routing.test.ts`: the host reads the mode word from
//! the grid after each message, and releases the input it holds on the rising
//! edge of a report bit, as the browser's main thread does. A resume repair
//! is released by the terminal's own row versions.

use merkur_client::input_sequence::InputMapping;
use merkur_client::session::DisplayFence;
use merkur_client::viewer::{DisplayGrid, Output, Viewer};
use merkur_codec::{
    CellRepr, FrameHeader, FrameKind, MSG_TYPE_DISPLAY_PATCH, RowRef, STREAM_HEADER_BYTES,
    StreamHeader, encode_frame_into, write_stream_header,
};
use merkur_wire::protocol::{
    CHANNEL_CTRL, CHANNEL_DISPLAY_COMMIT, CHANNEL_DISPLAY_DATAGRAM, MSG_TYPE_DISPLAY_REPAIR_END,
    encode_input_routing_frame, encode_proto_frame,
};

use super::NativeGrid;

const COLS: u16 = 8;
const ROWS: u16 = 2;
const GENERATION: u32 = 1;
// The mode word's bits, as the dataplane's `encode_terminal_mode` sets them.
const PREDICTION_SAFE: u32 = 1 << 5;
const KEY_RELEASES: u32 = 1 << 6;
const MODIFIER_KEYS: u32 = 1 << 7;
const FOCUS: u32 = 1 << 8;
const INPUT_REPORTS: u32 = KEY_RELEASES | MODIFIER_KEYS | FOCUS;
const REPORTS: u32 = KEY_RELEASES | MODIFIER_KEYS;
const PAUSED: u32 = PREDICTION_SAFE | REPORTS;

/// A display frame whose header carries `mode_flags`.
fn frame(seq: u32, mode_flags: u32, snapshot: bool) -> Vec<u8> {
    encode(seq, mode_flags, snapshot, &[])
}

/// A delta writing `text` at the start of `row`.
fn row_delta(seq: u32, row: u16, text: &str) -> Vec<u8> {
    let cells: Vec<CellRepr> = text
        .chars()
        .map(|ch| CellRepr {
            codepoint: u32::from(ch),
            ..CellRepr::BLANK
        })
        .collect();
    let written = RowRef {
        row_index: row,
        left: 0,
        cells: &cells,
        graphics: &[],
    };
    encode(seq, PREDICTION_SAFE, false, &[written])
}

fn encode(seq: u32, mode_flags: u32, snapshot: bool, rows: &[RowRef<'_>]) -> Vec<u8> {
    let header = FrameHeader {
        kind: if snapshot {
            FrameKind::Snapshot
        } else {
            FrameKind::Delta
        },
        memory_only: false,
        cols: COLS,
        rows: ROWS,
        cursor_col: 0,
        cursor_row: 0,
        cursor_shape: 0,
        cursor_visible: 1,
        mode_flags: mode_flags as u16,
        row_count: rows.len() as u16,
        frame_id: seq + 1,
        presentation_id: 0,
        presentation_member_index: 0,
        presentation_member_count: 0,
        row_predecessor_presentation_id: 0,
        presentation_coherent: false,
        presentation_end: false,
        chunk_index: 0,
        chunk_count: 1,
        demand_serial: 0,
        demand_limited: false,
        demand_prompt: false,
        demand_awaits_grant: false,
        closure_digest: 0,
        scroll_serial: 0,
        echo_horizon: 0,
    };
    let mut out = Vec::new();
    encode_frame_into(&mut out, &header, rows.iter().copied());
    let body_len = (out.len() - STREAM_HEADER_BYTES) as u32;
    write_stream_header(
        &mut out,
        &StreamHeader {
            msg_type: MSG_TYPE_DISPLAY_PATCH,
            flags: 0,
            body_len,
            seq,
            generation: GENERATION,
            input_seq: 0,
        },
    );
    out
}

struct Harness {
    viewer: Viewer<NativeGrid>,
    /// The mode word the host last read.
    mode: u32,
    releases: usize,
}

impl Harness {
    /// A session whose snapshot committed `committed`.
    fn new(committed: u32) -> Self {
        let mut viewer = Viewer::new(NativeGrid::new(COLS, ROWS));
        viewer.fence(0.0, DisplayFence { lineage: 1 });
        viewer.receive(
            0.0,
            CHANNEL_DISPLAY_COMMIT,
            &frame(0, committed, true),
            InputMapping::default(),
        );
        assert_eq!(viewer.generation(), GENERATION);
        let mut harness = Self {
            viewer,
            mode: 0,
            releases: 0,
        };
        harness.observe();
        harness
    }

    /// The host reads the mode word; `Some` when it changed.
    fn observe(&mut self) -> Option<u32> {
        let mode = self.viewer.grid().terminal().mouse_mode();
        if mode == self.mode {
            return None;
        }
        if mode & !self.mode & INPUT_REPORTS != 0 {
            self.releases += 1;
        }
        self.mode = mode;
        Some(mode)
    }

    /// The control lane hands the viewer a routing word.
    fn route(&mut self, after_seq: u32, serial: u32, word: u32) -> Option<u32> {
        let message = encode_input_routing_frame(GENERATION, after_seq, serial, word as u16);
        self.viewer
            .receive(0.0, CHANNEL_CTRL, &message, InputMapping::default());
        self.observe()
    }

    fn apply_delta(&mut self, seq: u32, mode_flags: u32) {
        let applied = self.viewer.stats().frames;
        let delta = frame(seq, mode_flags, false);
        self.viewer.receive(
            0.0,
            CHANNEL_DISPLAY_DATAGRAM,
            &delta,
            InputMapping::default(),
        );
        assert_eq!(
            self.viewer.stats().frames,
            applied + 1,
            "delta {seq} applies"
        );
        self.observe();
    }
}

#[test]
fn the_routing_word_releases_held_input_once_and_the_committed_header_releases_nothing_twice() {
    // The last committed header: a granted prompt, no key reports.
    let mut harness = Harness::new(PREDICTION_SAFE);
    assert_eq!(harness.mode, PREDICTION_SAFE);
    assert_eq!(harness.releases, 0);

    // `CSI > 11 u` inside a synchronized update paused on an image: the daemon
    // sends the routing word, read after frame 1, and the host holds input no
    // longer.
    assert_eq!(harness.route(1, 1, REPORTS), Some(PAUSED));
    assert_eq!(harness.releases, 1);

    // The header the drain commits carries the same word: no second edge.
    harness.apply_delta(2, PAUSED);
    assert_eq!(harness.releases, 1);
    assert_eq!(harness.mode, PAUSED);
}

#[test]
fn a_frame_sent_before_the_routing_word_cannot_take_its_routing_bits_back() {
    let mut harness = Harness::new(PREDICTION_SAFE);
    // Frame 2 left before the pause and is still in flight when the word, read
    // after it, overtakes it on the control lane.
    harness.route(2, 1, REPORTS);
    assert_eq!(harness.mode, PAUSED);
    harness.apply_delta(2, PREDICTION_SAFE);
    assert_eq!(harness.mode, PAUSED);
    assert_eq!(harness.releases, 1);

    // The committed header, captured after the word, releases it. The rest of
    // the transaction popped the flags again, and that header's word wins.
    harness.apply_delta(3, PREDICTION_SAFE);
    assert_eq!(harness.mode, PREDICTION_SAFE);
    // Released: every later header carries the whole word.
    harness.apply_delta(4, PAUSED);
    assert_eq!(harness.mode, PAUSED);
    assert_eq!(harness.releases, 2);
}

#[test]
fn a_routing_word_a_later_header_already_applied_past_is_dropped() {
    let mut harness = Harness::new(PREDICTION_SAFE);
    // The committed header lands first; the word read after frame 1 arrives
    // late.
    harness.apply_delta(2, PREDICTION_SAFE);
    assert_eq!(harness.route(1, 1, REPORTS), None);
    assert_eq!(harness.mode, PREDICTION_SAFE);
    assert_eq!(harness.releases, 0);
    // Not held: the next header still owns the whole word.
    harness.apply_delta(3, PAUSED);
    assert_eq!(harness.mode, PAUSED);
}

#[test]
fn two_words_at_one_position_keep_their_serial_order_across_carriers() {
    let mut harness = Harness::new(PAUSED);
    assert_eq!(harness.releases, 1);
    // Two pauses of one transaction, the second switching the reports off. Its
    // word (serial 2) crossed the first on another carrier.
    assert_eq!(harness.route(2, 2, 0), Some(PREDICTION_SAFE));
    assert_eq!(harness.route(2, 1, REPORTS), None);
    // Nor can the frame both words were read after, landing last.
    harness.apply_delta(2, PAUSED);
    assert_eq!(harness.mode, PREDICTION_SAFE);
    assert_eq!(harness.releases, 1);
}

#[test]
fn a_session_fence_lets_the_next_session_order_its_own_words_and_frames() {
    let mut harness = Harness::new(PREDICTION_SAFE);
    harness.route(9, 7, REPORTS);
    harness.viewer.fence(0.0, DisplayFence { lineage: 2 });
    // The next session may be another daemon process, whose serials restart...
    assert_eq!(harness.route(9, 1, 0), Some(PREDICTION_SAFE));
    assert_eq!(harness.route(9, 2, REPORTS), Some(PAUSED));
    harness.viewer.fence(0.0, DisplayFence { lineage: 3 });
    // ...and whose sequences need not follow the held word's position, yet
    // whatever it applies first was captured after that word.
    let snapshot = frame(0, PREDICTION_SAFE, true);
    harness.viewer.receive(
        0.0,
        CHANNEL_DISPLAY_COMMIT,
        &snapshot,
        InputMapping::default(),
    );
    harness.observe();
    assert_eq!(harness.mode, PREDICTION_SAFE);
}

fn repair_end(repair_id: u32, members: &[(u16, u32)]) -> Vec<u8> {
    let mut body = Vec::new();
    body.extend_from_slice(&GENERATION.to_be_bytes());
    body.extend_from_slice(&repair_id.to_be_bytes());
    body.extend_from_slice(&(members.len() as u16).to_be_bytes());
    for (row, minimum_seq) in members {
        body.extend_from_slice(&row.to_be_bytes());
        body.extend_from_slice(&minimum_seq.to_be_bytes());
    }
    encode_proto_frame(MSG_TYPE_DISPLAY_REPAIR_END, &body)
}

#[test]
fn a_kept_grid_shows_its_repair_only_once_every_named_row_landed() {
    let mut viewer = Viewer::new(NativeGrid::new(COLS, ROWS));
    viewer.fence(0.0, DisplayFence { lineage: 1 });
    viewer.receive(
        0.0,
        CHANNEL_DISPLAY_COMMIT,
        &frame(0, PREDICTION_SAFE, true),
        InputMapping::default(),
    );
    viewer.receive(
        1.0,
        CHANNEL_DISPLAY_DATAGRAM,
        &row_delta(1, 0, "old"),
        InputMapping::default(),
    );
    viewer.present_now(1.0);
    assert_eq!(viewer.grid().screen(), ["old", ""]);
    std::iter::from_fn(|| viewer.poll_output(1.0)).for_each(drop);

    // A rebind: the grid is claimed with the terminal's own row hashes.
    viewer.fence(2.0, DisplayFence { lineage: 2 });
    let hashes: Vec<u64> = viewer.grid_mut().row_hashes().to_vec();
    assert_eq!(hashes.len(), usize::from(ROWS));
    let outputs: Vec<Output> = std::iter::from_fn(|| viewer.poll_output(2.0)).collect();
    let [Output::Resume(resume), Output::DictionaryReady(true)] = &outputs[..] else {
        panic!("a kept grid is claimed, not snapshotted: {outputs:?}");
    };
    assert_eq!(
        (resume.generation, resume.applied_seq, resume.repair_id),
        (GENERATION, 1, 2)
    );
    assert_eq!(resume.row_hashes.as_ref(), Some(&hashes));

    // The repair lands row by row; the old screen stays until it is whole.
    viewer.receive(
        3.0,
        CHANNEL_DISPLAY_DATAGRAM,
        &row_delta(5, 0, "new"),
        InputMapping::default(),
    );
    assert_eq!(viewer.present_now(3.0), None);
    viewer.receive(
        4.0,
        CHANNEL_CTRL,
        &repair_end(2, &[(0, 5), (1, 6)]),
        InputMapping::default(),
    );
    assert_eq!(viewer.present_now(4.0), None);
    assert_eq!(viewer.grid().screen(), ["old", ""]);
    viewer.receive(
        5.0,
        CHANNEL_DISPLAY_DATAGRAM,
        &row_delta(6, 1, "two"),
        InputMapping::default(),
    );
    assert!(viewer.present_now(5.0).is_some());
    assert_eq!(viewer.grid().screen(), ["new", "two"]);
    assert_eq!((viewer.stats().resumes, viewer.stats().repairs), (1, 1));
}

mod prediction;
