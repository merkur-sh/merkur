//! Speculative echo over the real terminal: the viewer asks term-wasm's
//! shadow model before each record, and applied authority confirms or
//! contradicts what it modelled.

use merkur_client::input_sequence::InputMapping;
use merkur_client::session::DisplayFence;
use merkur_client::viewer::{PredictionCommand, PredictionState, PredictionStats, Viewer};
use merkur_codec::{
    CellRepr, FrameHeader, FrameKind, MSG_TYPE_DISPLAY_PATCH, RowRef, STREAM_HEADER_BYTES,
    StreamHeader, encode_frame_into, write_stream_header,
};
use merkur_wire::input_record::build;
use merkur_wire::protocol::{
    CHANNEL_CTRL, CHANNEL_DISPLAY_COMMIT, CHANNEL_DISPLAY_DATAGRAM, EDITOR_ANCHOR_FLAG_OPEN,
    MSG_TYPE_EDITOR_ANCHOR, encode_proto_frame,
};

use super::super::NativeGrid;
use super::PREDICTION_SAFE;

const COLS: u16 = 20;
const ROWS: u16 = 2;
const GENERATION: u32 = 1;
const PROMPT: &str = "$ ";
const ENTER: u32 = 0xE001;
/// Local input `n` went out as wire `n`.
const NUMBERING: InputMapping = InputMapping {
    epoch: 2,
    local_minus_wire: 0,
    wire_min: 1,
    wire_max: 64,
};

/// Row 0 reading `text` with the cursor after it, covering input through
/// `input_seq`.
fn screen(seq: u32, text: &str, mode_flags: u32, input_seq: u32) -> Vec<u8> {
    let cells: Vec<CellRepr> = text
        .chars()
        .map(|ch| CellRepr {
            codepoint: u32::from(ch),
            ..CellRepr::BLANK
        })
        .collect();
    let row = RowRef {
        row_index: 0,
        left: 0,
        cells: &cells,
        graphics: &[],
    };
    let snapshot = seq == 0;
    let header = FrameHeader {
        kind: if snapshot {
            FrameKind::Snapshot
        } else {
            FrameKind::Delta
        },
        memory_only: false,
        cols: COLS,
        rows: ROWS,
        cursor_col: text.chars().count() as u16,
        cursor_row: 0,
        // A block: shape 0 is the hidden cursor, under which nothing predicts.
        cursor_shape: 1,
        cursor_visible: 1,
        mode_flags: mode_flags as u16,
        row_count: 1,
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
        echo_horizon: input_seq,
    };
    let mut out = Vec::new();
    encode_frame_into(&mut out, &header, std::iter::once(row));
    let body_len = (out.len() - STREAM_HEADER_BYTES) as u32;
    write_stream_header(
        &mut out,
        &StreamHeader {
            msg_type: MSG_TYPE_DISPLAY_PATCH,
            flags: 0,
            body_len,
            seq,
            generation: GENERATION,
            input_seq,
        },
    );
    out
}

struct Prompt {
    viewer: Viewer<NativeGrid>,
    seq: u32,
    local: u32,
    now: f64,
    line: String,
}

impl Prompt {
    /// A session whose snapshot shows `PROMPT` under `mode_flags`, anchored
    /// after it.
    fn new(mode_flags: u32) -> Self {
        let mut viewer = Viewer::new(NativeGrid::new(COLS, ROWS));
        viewer.fence(0.0, DisplayFence { lineage: 1 });
        viewer.receive(
            0.0,
            CHANNEL_DISPLAY_COMMIT,
            &screen(0, PROMPT, mode_flags, 0),
            NUMBERING,
        );
        let mut anchor = Vec::new();
        anchor.extend_from_slice(&GENERATION.to_be_bytes());
        anchor.extend_from_slice(&0u16.to_be_bytes());
        anchor.extend_from_slice(&(PROMPT.len() as u16).to_be_bytes());
        anchor.extend_from_slice(&EDITOR_ANCHOR_FLAG_OPEN.to_be_bytes());
        viewer.receive(
            0.0,
            CHANNEL_CTRL,
            &encode_proto_frame(MSG_TYPE_EDITOR_ANCHOR, &anchor),
            NUMBERING,
        );
        viewer.present_now(0.0);
        Self {
            viewer,
            seq: 0,
            local: 0,
            now: 0.0,
            line: String::from(PROMPT),
        }
    }

    /// Type one record; whether the model took it.
    fn key(&mut self, record: &[u8]) -> bool {
        self.local += 1;
        self.now += 1.0;
        self.viewer.input(self.now, self.local, record)
    }

    fn typed(&mut self, c: char) -> bool {
        let modelled = self.key(&build::press(c));
        self.line.push(c);
        modelled
    }

    /// The daemon's echo of everything typed so far, reading `line`.
    fn echo(&mut self, line: &str) {
        self.seq += 1;
        self.now += 1.0;
        let frame = screen(self.seq, line, PREDICTION_SAFE, self.local);
        self.viewer
            .receive(self.now, CHANNEL_DISPLAY_DATAGRAM, &frame, NUMBERING);
        self.viewer.present_now(self.now);
    }

    fn echo_line(&mut self) {
        let line = self.line.clone();
        self.echo(&line);
    }

    fn stats(&self) -> PredictionStats {
        self.viewer.prediction()
    }
}

#[test]
fn typed_keys_are_modelled_confirmed_by_their_echo_and_then_shown() {
    let mut prompt = Prompt::new(PREDICTION_SAFE);
    assert!(prompt.typed('l'));
    assert!(prompt.typed('s'));
    prompt.echo_line();
    let stats = prompt.stats();
    assert_eq!((stats.modelled, stats.confirmed), (2, 2), "{stats:?}");
    // Two confirmations are not yet trust.
    assert_eq!(stats.state, PredictionState::Learning);

    assert!(prompt.typed(' '));
    prompt.echo_line();
    let stats = prompt.stats();
    assert_eq!((stats.confirmed, stats.mismatched), (3, 0));
    assert_eq!(stats.state, PredictionState::Visible);
}

#[test]
fn enter_fences_the_next_key_until_authority_covers_it() {
    let mut prompt = Prompt::new(PREDICTION_SAFE);
    assert!(prompt.typed('l'));
    prompt.echo_line();
    // Enter is never modelled, and what follows it predicts from nothing
    // until display shows what it did.
    assert!(!prompt.key(&build::functional(ENTER, 0, 0)));
    assert!(!prompt.typed('x'), "behind unmodelled input");
    prompt.line = String::from(PROMPT);
    prompt.echo_line();
    assert!(prompt.typed('y'), "authority covered the fence");
}

#[test]
fn a_resize_fences_the_discarded_overlay_until_authority_covers_it() {
    let mut prompt = Prompt::new(PREDICTION_SAFE);
    assert!(prompt.typed('a'));
    prompt.viewer.resize(COLS + 1, ROWS);
    assert!(
        !prompt.typed('b'),
        "the resized cursor is not a new causal base"
    );
    // The daemon's snapshot restores canonical geometry and covers both keys.
    prompt.viewer.receive(
        prompt.now,
        CHANNEL_DISPLAY_COMMIT,
        &screen(0, "$ ab", PREDICTION_SAFE, prompt.local),
        NUMBERING,
    );
    prompt.viewer.present_now(prompt.now);
    assert!(prompt.typed('c'), "authority covered every fenced input");
}

#[test]
fn a_contradicting_echo_is_a_mismatch_and_resets_trust() {
    let mut prompt = Prompt::new(PREDICTION_SAFE);
    assert!(prompt.typed('a'));
    prompt.echo("$ b");
    // Half an echo may still be in flight: the verdict waits out the grace.
    assert_eq!(prompt.stats().mismatched, 0);
    let grace = prompt.viewer.next_deadline().expect("the mismatch grace");
    prompt.viewer.handle_timeout(grace);
    let stats = prompt.stats();
    assert_eq!((stats.confirmed, stats.mismatched), (0, 1), "{stats:?}");
    assert_eq!(stats.state, PredictionState::Learning);
}

#[test]
fn nothing_is_modelled_on_a_prompt_the_daemon_has_not_granted() {
    let mut prompt = Prompt::new(0);
    assert!(!prompt.typed('a'));
    assert_eq!(prompt.stats().state, PredictionState::Suppressed);
    assert_eq!(prompt.stats().modelled, 0);
}

#[test]
fn a_kept_grid_goes_on_modelling_but_earns_its_trust_again() {
    let mut prompt = Prompt::new(PREDICTION_SAFE);
    for c in "abc".chars() {
        assert!(prompt.typed(c));
    }
    prompt.echo_line();
    assert_eq!(prompt.stats().state, PredictionState::Visible);

    // A rebind keeps the grid its successor repairs; the model it drew from
    // belonged to the lineage that ended.
    prompt.viewer.fence(prompt.now, DisplayFence { lineage: 2 });
    assert_eq!(prompt.stats().state, PredictionState::Learning);
    assert!(prompt.typed('d'));
}

#[test]
fn nothing_is_modelled_before_a_session_has_a_grid() {
    let mut viewer = Viewer::new(NativeGrid::new(COLS, ROWS));
    viewer.fence(0.0, DisplayFence { lineage: 1 });
    assert!(!viewer.input(1.0, 1, &build::press('a')), "no snapshot yet");
    // The snapshot shows what the daemon did with that key.
    viewer.receive(
        2.0,
        CHANNEL_DISPLAY_COMMIT,
        &screen(0, "$ a", PREDICTION_SAFE, 1),
        NUMBERING,
    );
    viewer.present_now(2.0);
    assert!(viewer.input(3.0, 2, &build::press('b')));
}

#[test]
fn a_native_host_is_shown_the_trusted_echo_before_the_daemon_answers() {
    let mut prompt = Prompt::new(PREDICTION_SAFE);
    for c in ['l', 's', ' '] {
        assert!(prompt.typed(c));
        prompt.echo_line();
    }
    assert_eq!(prompt.stats().state, PredictionState::Visible);
    assert!(prompt.typed('x'));
    let terminal = prompt.viewer.grid().terminal();
    let mut row = Vec::new();
    terminal.displayed_row(0, &mut row);
    let text: String = row.iter().map(|cell| cell.c).collect();
    assert_eq!(text.trim_end(), "$ ls x");
    // The daemon's default colours stay the host's.
    assert!(
        row.iter()
            .all(|cell| cell.fg.is_none() && cell.bg.is_none())
    );
    let cursor = terminal.displayed_cursor().expect("a shown cursor");
    assert_eq!((cursor.row, cursor.col), (0, 6));
    // The presentation itself has not changed: only the echo is ahead of it.
    assert_eq!(prompt.viewer.grid().screen()[0], "$ ls");
}

#[test]
fn a_captured_visible_key_remains_visible_when_worker_trust_is_learning() {
    let mut prompt = Prompt::new(PREDICTION_SAFE);
    assert!(prompt.typed('a'));
    prompt.echo_line();
    assert_eq!(prompt.stats().state, PredictionState::Learning);
    assert!(prompt.viewer.prediction_command(
        prompt.now + 1.0,
        prompt.local + 1,
        PredictionCommand::Printable(u32::from('x')),
        true,
    ));
    let mut row = Vec::new();
    prompt.viewer.grid().terminal().displayed_row(0, &mut row);
    let text: String = row.iter().map(|cell| cell.c).collect();
    assert_eq!(text.trim_end(), "$ ax");
}

#[test]
fn a_captured_hidden_key_remains_hidden_after_worker_trust_became_visible() {
    let mut prompt = Prompt::new(PREDICTION_SAFE);
    for ch in "abc".chars() {
        assert!(prompt.typed(ch));
        prompt.echo_line();
    }
    assert_eq!(prompt.stats().state, PredictionState::Visible);
    assert!(prompt.viewer.prediction_command(
        prompt.now + 1.0,
        prompt.local + 1,
        PredictionCommand::Printable(u32::from('x')),
        false,
    ));
    let mut row = Vec::new();
    prompt.viewer.grid().terminal().displayed_row(0, &mut row);
    let text: String = row.iter().map(|cell| cell.c).collect();
    assert_eq!(text.trim_end(), "$ abc");
    assert!(prompt.viewer.grid().terminal().has_predictions());
}

#[test]
fn newer_authority_revokes_a_captured_command_and_extends_its_causal_barrier() {
    let mut prompt = Prompt::new(0);
    assert!(!prompt.viewer.prediction_command(
        1.0,
        1,
        PredictionCommand::Printable(u32::from('x')),
        true,
    ));
    // A grant by itself cannot repair the unmodelled key's cursor base.
    prompt.viewer.receive(
        2.0,
        CHANNEL_DISPLAY_DATAGRAM,
        &screen(1, PROMPT, PREDICTION_SAFE, 0),
        NUMBERING,
    );
    assert!(!prompt.viewer.prediction_command(
        3.0,
        2,
        PredictionCommand::Printable(u32::from('y')),
        true,
    ));
    // Authority must cover the entire refused run.
    prompt.viewer.receive(
        4.0,
        CHANNEL_DISPLAY_DATAGRAM,
        &screen(2, "$ xy", PREDICTION_SAFE, 2),
        NUMBERING,
    );
    prompt.viewer.present_now(4.0);
    assert!(
        !prompt.viewer.prediction_command(
            5.0,
            2,
            PredictionCommand::Printable(u32::from('y')),
            true,
        ),
        "a command whose real echo won the race is no longer paint"
    );
    assert!(prompt.viewer.prediction_command(
        6.0,
        3,
        PredictionCommand::Printable(u32::from('z')),
        true,
    ));
}
