use super::*;
use crate::{
    CellAttrs, CellRepr, FrameHeader, FrameKind, RowRef, encode_frame_into, iter_rows,
    validate_display_frame,
};
use proptest::prelude::*;

const COLS: u16 = 40;
const ROWS: u16 = 24;

fn header(row_count: u16) -> FrameHeader {
    FrameHeader {
        memory_only: false,
        kind: FrameKind::Delta,
        cols: COLS,
        rows: ROWS,
        cursor_col: 0,
        cursor_row: 0,
        cursor_shape: 1,
        cursor_visible: 1,
        mode_flags: 0,
        row_count,
        frame_id: 0,
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
    }
}

fn cell(codepoint: char, fg: [u8; 3], bg: [u8; 3]) -> CellRepr {
    CellRepr {
        codepoint: u32::from(codepoint),
        link: 0,
        fg,
        bg,
        attrs: CellAttrs::NONE,
    }
}

fn text_row(text: &str, fg: [u8; 3]) -> Vec<CellRepr> {
    let mut cells: Vec<CellRepr> = text
        .chars()
        .chain(std::iter::repeat(' '))
        .take(usize::from(COLS))
        .map(|c| cell(c, fg, crate::DEFAULT_BACKGROUND))
        .collect();
    if text.len() > 30 {
        cells[usize::from(COLS) - 1].attrs = CellAttrs::WRAPPED;
    }
    cells
}

/// The row-layout payload of `entries`: `(row, left, cells)`.
fn rows_of(entries: &[(u16, u16, &[CellRepr])]) -> Vec<u8> {
    let mut frame = Vec::new();
    encode_frame_into(
        &mut frame,
        &header(u16::try_from(entries.len()).expect("a grid of rows")),
        entries.iter().map(|&(row_index, left, cells)| RowRef {
            row_index,
            left,
            cells,
            graphics: &[],
        }),
    );
    frame[crate::STREAM_HEADER_BYTES + crate::FRAME_HEADER_BODY_BYTES..].to_vec()
}

/// The display generation the tests' frames belong to.
const GENERATION: u32 = 1;

/// What a receiver holds: its row history at a frame's generation and
/// presentation id, and its session epochs.
struct Held<'a> {
    history: &'a RowHistory,
    presentation_id: u32,
    session: Option<&'a MzSession>,
}

impl MzSources for Held<'_> {
    fn row(&self, previous: bool, back: u32, row: u16) -> Result<MzRow<'_>, MzError> {
        self.history.row(GENERATION, self.presentation_id, previous, back, row)
    }

    fn epoch(&self, id: u8) -> Option<&SessionModel> {
        self.session?.epoch(id)
    }
}

/// A row the sender recorded: datagram, row, entry, items, first item offset,
/// mode and item hashes.
type SentEntry = (u32, u16, Vec<u8>, Vec<MzItem>, u16, u8, Vec<u64>);

/// The sender's view of the same rows: every recorded complete row, found by
/// brute force, named from the frame's presentation id, or with `previous`,
/// as rows of the generation before the frame's.
#[derive(Default)]
struct Sent {
    rows: Vec<SentEntry>,
    presentation_id: u32,
    previous: bool,
}

impl Sent {
    fn record(&mut self, seq: u32, row: u16, cells: &[CellRepr]) {
        let mut entry = Vec::new();
        encode_full_row_entry(&mut entry, 0, cells);
        let mut items = Vec::new();
        let (first, mode) = entry_items(&entry, &mut items).expect("a full row");
        let hashes = (0..items.len())
            .map(|i| {
                let start = if i == 0 { usize::from(first) } else { usize::from(items[i - 1].end) };
                item_hash(&entry[start..usize::from(items[i].end)])
            })
            .collect();
        self.rows.push((seq, row, entry, items, first, mode, hashes));
    }
}

impl MzMatches for Sent {
    fn candidates(&self, pair: u64, mut visit: impl FnMut(MzCandidate, MzRow<'_>) -> bool) {
        for (seq, row, entry, items, first, mode, hashes) in self.rows.iter().rev() {
            let source = MzRow { entry, first: *first, items, mode: *mode, hashes };
            for index in 0..items.len().saturating_sub(1) {
                let bytes = |i: usize| {
                    let start = if i == 0 { usize::from(source.first) } else { usize::from(items[i - 1].end) };
                    &entry[start..usize::from(items[i].end)]
                };
                if pair_hash(item_hash(bytes(index)), item_hash(bytes(index + 1))) == pair
                    && !visit(MzCandidate {
                        previous: self.previous,
                        back: if self.previous { *seq } else { self.presentation_id.wrapping_sub(*seq) },
                        row: *row,
                        item: u16::try_from(index).expect("an item"),
                    }, source)
                {
                    return;
                }
            }
        }
    }
}

fn round_trip(rows: &[u8], row_count: u16) -> usize {
    let mut encoder = MzEncoder::default();
    let mut payload = Vec::new();
    let encoded = encoder
        .encode_rows(rows, row_count, &NoHistory, None, None, &mut payload)
        .expect("encodes");
    assert_eq!(encoded.rows_len, rows.len());
    assert_eq!(encoded.prior, 0);
    let history = RowHistory::default();
    let held = Held { history: &history, presentation_id: 1, session: None };
    let mut decoder = MzDecoder::default();
    let mut decoded = Vec::new();
    decoder.decode(&payload, row_count, encoded.rows_len, &held, &mut decoded).expect("decodes");
    assert_eq!(decoded, rows);
    assert_eq!(decoder.trace(), encoder.trace(), "both ends traced the same symbols");
    payload.len()
}

#[test]
fn literal_frames_round_trip_and_code_smaller_than_their_rows() {
    let prompt = text_row(
        "user@host:~/merkur$ cargo test -p merkur-codec",
        [0x89, 0xb4, 0xfa],
    );
    let log = text_row(
        "   Compiling merkur-codec v0.1.0 (/home/user)",
        crate::DEFAULT_FOREGROUND,
    );
    let colored: Vec<CellRepr> = (0..COLS)
        .map(|i| {
            let i = u8::try_from(i).expect("a column");
            cell('#', [i * 6, 200, 17], [3, i, 9])
        })
        .collect();
    let text = rows_of(&[(3, 0, &prompt), (4, 0, &log)]);
    let coded = round_trip(&text, 2);
    assert!(coded < text.len() * 2 / 3, "{coded} of {}", text.len());
    // A gradient codes as small differences.
    let rows = rows_of(&[(3, 0, &prompt), (4, 0, &log), (5, 7, &colored[7..30])]);
    let coded = round_trip(&rows, 3);
    assert!(coded < rows.len() / 2, "{coded} of {}", rows.len());
    // A single short row codes with one state.
    let one = rows_of(&[(0, 2, &prompt[2..5])]);
    round_trip(&one, 1);
}

#[test]
fn foreign_scripts_round_trip() {
    for text in [
        "Привет, мир — это строка на русском языке",
        "日本語のテキストと中文的文字混在している行です",
        "안녕하세요 세계, 한국어 문장입니다",
        "مرحبا بالعالم هذه جملة عربية",
        "⠁⠃⠉⠙ ╔══╗ ║ok║ ╚══╝ 🎉🚀✨",
    ] {
        let row = text_row(text, [200, 100, 50]);
        let rows = rows_of(&[(0, 0, &row), (1, 0, &row)]);
        let coded = round_trip(&rows, 2);
        assert!(coded < rows.len() / 2, "{text}: {coded} of {}", rows.len());
    }
}

#[test]
fn a_repeated_row_copies_from_earlier_in_the_frame() {
    let row = text_row("the same line, scrolled into view twice in one frame", [10, 20, 30]);
    let other = text_row("something else between them", crate::DEFAULT_FOREGROUND);
    let once = round_trip(&rows_of(&[(0, 0, &row)]), 1);
    let twice = round_trip(&rows_of(&[(0, 0, &row), (1, 0, &other), (2, 0, &row)]), 3);
    let other_alone = round_trip(&rows_of(&[(1, 0, &other)]), 1);
    assert!(twice < once + other_alone, "the second copy of the row costs a copy: {twice} vs {once} + {other_alone}");
}

#[test]
fn linked_and_wide_rows_round_trip() {
    let mut cells = text_row(
        "see https://example.com for more",
        crate::DEFAULT_FOREGROUND,
    );
    for cell in &mut cells[4..23] {
        cell.link = 9;
    }
    cells[30] = CellRepr {
        codepoint: u32::from('界'),
        attrs: CellAttrs::WIDE,
        ..cells[30]
    };
    cells[31] = CellRepr {
        codepoint: 0,
        ..cells[31]
    };
    let rows = rows_of(&[(10, 0, &cells), (11, 3, &cells[3..9])]);
    round_trip(&rows, 2);
}

/// A graphics row codes its section after its cells, and the rows around it
/// code as they would alone; a flag without a section, or a section without
/// the flag, is not a row.
#[test]
fn graphics_rows_round_trip_with_their_sections() {
    let row = text_row("image below", crate::DEFAULT_FOREGROUND);
    let mut rows = rows_of(&[(1, 0, &row)]);
    rows[2] |= (crate::ROW_FLAG_GRAPHICS >> 8) as u8;
    let section: Vec<u8> = (0..300u32)
        .map(|i| (i * 7 + i / 13).to_le_bytes()[0])
        .collect();
    rows.extend_from_slice(
        &u32::try_from(section.len())
            .expect("a section")
            .to_be_bytes(),
    );
    rows.extend_from_slice(&section);
    rows.extend_from_slice(&rows_of(&[(2, 0, &row)]));
    round_trip(&rows, 2);

    let mut flag_only = rows_of(&[(1, 0, &row)]);
    flag_only[2] |= (crate::ROW_FLAG_GRAPHICS >> 8) as u8;
    let mut empty_section = flag_only.clone();
    empty_section.extend_from_slice(&0u32.to_be_bytes());
    let mut section_only = rows_of(&[(1, 0, &row)]);
    section_only.extend_from_slice(&1u32.to_be_bytes());
    section_only.push(9);
    for rows in [flag_only, empty_section, section_only] {
        assert_eq!(
            MzEncoder::default().encode_rows(&rows, 1, &NoHistory, None, None, &mut Vec::new()),
            None
        );
    }
}

/// Rows a datagram carried whole are copied from the receiver's history; a
/// receiver that does not hold the source refuses the frame.
#[test]
fn history_copies_read_rows_the_receiver_holds() {
    let lines: Vec<Vec<CellRepr>> = [
        "fn main() { println!(\"hello, world\"); }",
        "    let rows = rows_of(&[(0, 0, &row)]);",
        "// a comment that scrolls up the screen",
    ]
    .iter()
    .map(|text| text_row(text, [0xa6, 0xe3, 0xa1]))
    .collect();
    let mut history = RowHistory::default();
    let mut sent = Sent::default();
    for (row, line) in (0u16..).zip(&lines) {
        history.record(GENERATION, 40, row, line, COLS);
        sent.record(40, row, line);
    }
    // Datagram 45 scrolls them up a row.
    sent.presentation_id = 45;
    let rows = rows_of(&[(0, 0, &lines[1]), (1, 0, &lines[2])]);
    let mut encoder = MzEncoder::default();
    let mut payload = Vec::new();
    let encoded = encoder.encode_rows(&rows, 2, &sent, None, None, &mut payload).expect("encodes");
    assert!(encoded.history_copies);
    let plain = round_trip(&rows, 2);
    assert!(payload.len() * 2 < plain, "copies: {} of {plain}", payload.len());
    let held = Held { history: &history, presentation_id: 45, session: None };
    let mut decoder = MzDecoder::default();
    let mut decoded = Vec::new();
    decoder.decode(&payload, 2, encoded.rows_len, &held, &mut decoded).expect("decodes");
    assert_eq!(decoded, rows);
    // A receiver without the source refuses it as unresolved, never as corrupt.
    let empty = RowHistory::default();
    let missing = Held { history: &empty, presentation_id: 45, session: None };
    assert_eq!(
        decoder.decode(&payload, 2, encoded.rows_len, &missing, &mut decoded),
        Err(MzError::Unresolved)
    );
}

/// A session epoch built from the traces of earlier frames codes a frame like
/// them in fewer bytes, both ends building the same tables; a receiver
/// without the epoch refuses the frame.
#[test]
fn session_epochs_learn_the_sessions_screens() {
    let mut sender = MzSession::default();
    let mut receiver = MzSession::default();
    let mut encoder = MzEncoder::default();
    let mut decoder = MzDecoder::default();
    let history = RowHistory::default();
    let text = |n: usize| text_row(&format!("Строка номер {n} с кириллицей и цифрами {}", n * 7), [180, 190, 254]);
    let mut payload = Vec::new();
    let mut decoded = Vec::new();
    for seq in 1..=20u32 {
        let row = text(seq as usize);
        let rows = rows_of(&[(0, 0, &row)]);
        payload.clear();
        let encoded = encoder.encode_rows(&rows, 1, &NoHistory, None, None, &mut payload).expect("encodes");
        sender.keep(seq, encoder.trace());
        let held = Held { history: &history, presentation_id: seq, session: Some(&receiver) };
        decoder.decode(&payload, 1, encoded.rows_len, &held, &mut decoded).expect("decodes");
        receiver.keep(seq, decoder.trace());
    }
    let declaration = MzEpochDeclaration { id: 1, base: 0, first: 1, datagrams: (1 << 20) - 1 };
    sender.build(&declaration).expect("sender builds");
    receiver.build(&declaration).expect("receiver builds");
    let rows = rows_of(&[(0, 0, &text(99))]);
    let mut without = Vec::new();
    let plain = encoder.encode_rows(&rows, 1, &NoHistory, None, None, &mut without).expect("encodes");
    let (id, model) = sender.current().expect("an epoch");
    payload.clear();
    let encoded = encoder.encode_rows(&rows, 1, &NoHistory, Some((id, model)), None, &mut payload).expect("encodes");
    assert_eq!(encoded.prior, 1);
    assert!(payload.len() < without.len(), "session {} vs static {}", payload.len(), without.len());
    let held = Held { history: &history, presentation_id: 30, session: Some(&receiver) };
    decoder.decode(&payload, 1, plain.rows_len, &held, &mut decoded).expect("decodes");
    assert_eq!(decoded, rows);
    let none = Held { history: &history, presentation_id: 30, session: None };
    assert_eq!(decoder.decode(&payload, 1, plain.rows_len, &none, &mut decoded), Err(MzError::Unresolved));
    // An epoch over a trace the receiver never kept cannot be built.
    let missing = MzEpochDeclaration { id: 2, base: 1, first: 500, datagrams: 1 };
    assert_eq!(receiver.build(&missing), Err(MzEpochError::Trace));
}

/// Traces retire by sequence distance, whatever arrived between: a
/// declaration within its reach of the frame carrying it always finds them.
#[test]
fn traces_retire_by_sequence_distance() {
    let mut session = MzSession::default();
    session.keep(10, &[1, 2, 3]);
    // Few traces arrived since, but the sequence moved a whole window.
    session.keep(10 + 2 * MZ_REFERENCE_DATAGRAMS, &[4]);
    assert!(!session.holds_trace(10));
    session.keep(20 + 2 * MZ_REFERENCE_DATAGRAMS, &[5]);
    assert!(session.holds_trace(10 + 2 * MZ_REFERENCE_DATAGRAMS));
    // Within the declaration reach of the newest, every trace is held.
    let newest = 30 + 2 * MZ_REFERENCE_DATAGRAMS;
    for seq in newest - MZ_DECLARATION_REACH..=newest {
        session.keep(seq, &[6]);
    }
    assert!((newest - MZ_DECLARATION_REACH..=newest).all(|seq| session.holds_trace(seq)));
}

/// A receiver refuses a frame declaring an epoch it cannot build, so the
/// sender never takes that epoch for held.
#[test]
fn an_unbuildable_declaration_refuses_its_frame() {
    let row = text_row("a frame that declares an epoch", [7, 7, 7]);
    let rows = rows_of(&[(0, 0, &row)]);
    let declaration = MzEpochDeclaration { id: 1, base: 0, first: 900, datagrams: 0b11 };
    let mut payload = Vec::new();
    let encoded = MzEncoder::default()
        .encode_rows(&rows, 1, &NoHistory, None, Some(&declaration), &mut payload)
        .expect("encodes");
    let mut receiver = MzReceiver::default();
    let mut out = Vec::new();
    assert_eq!(
        receiver.decode(GENERATION, 1000, 1000, &payload, 1, encoded.rows_len, &mut out),
        Err(MzError::Unresolved),
        "the receiver holds no trace of datagram 900"
    );
    // With both traces held it accepts the declaration and builds the epoch.
    let mut sender = MzEncoder::default();
    for seq in [900u32, 901] {
        let mut frame = Vec::new();
        let plain = sender.encode_rows(&rows, 1, &NoHistory, None, None, &mut frame).expect("encodes");
        receiver.decode(GENERATION, seq, seq, &frame, 1, plain.rows_len, &mut out).expect("decodes");
    }
    receiver.decode(GENERATION, 1000, 1000, &payload, 1, encoded.rows_len, &mut out).expect("decodes");
    assert_eq!(out, rows);
    receiver.build_pending();
    assert_eq!(receiver.epoch(), Some(1));
}

/// One row of `n`, in a script the static model codes poorly, so a session
/// epoch built over such rows codes the next one smaller.
fn session_row(n: usize) -> Vec<CellRepr> {
    text_row(&format!("Строка номер {n} с кириллицей и цифрами {}", n * 7), [180, 190, 254])
}

/// Code `rows` (`row_count` entries) against `session` and `history`,
/// carrying `declaration`: the payload and its row-layout length.
fn coded(
    encoder: &mut MzEncoder,
    rows: &[u8],
    row_count: u16,
    history: &impl MzMatches,
    session: Option<(u8, &SessionModel)>,
    declaration: Option<&MzEpochDeclaration>,
) -> (Vec<u8>, usize) {
    let mut payload = Vec::new();
    let encoded = encoder
        .encode_rows(rows, row_count, history, session, declaration, &mut payload)
        .expect("encodes");
    (payload, encoded.rows_len)
}

/// Sequences restart at every generation: both ends drop their traces there,
/// so a declaration can only name the generation it travels in. Before, a
/// lost datagram of the new generation left the receiver folding the old
/// trace its sequence named and the sender the new one, and every frame
/// coded against that epoch failed as corrupt.
#[test]
fn a_generation_change_drops_both_ends_traces() {
    let mut sender = MzSession::default();
    let mut receiver = MzReceiver::default();
    let mut encoder = MzEncoder::default();
    let mut out = Vec::new();
    for seq in 1..=20u32 {
        let rows = rows_of(&[(0, 0, &session_row(seq as usize))]);
        let (payload, rows_len) = coded(&mut encoder, &rows, 1, &NoHistory, None, None);
        sender.keep(seq, encoder.trace());
        receiver.decode(1, seq, seq, &payload, 1, rows_len, &mut out).expect("decodes");
    }
    let old = MzEpochDeclaration { id: 1, base: 0, first: 1, datagrams: (1 << 20) - 1 };
    assert!(sender.can_build(&old));
    sender.begin_generation();
    assert!(!sender.can_build(&old), "the sender keeps no trace across the boundary");
    // The new generation's first frame begins it at the receiver too.
    let rows = rows_of(&[(0, 0, &session_row(5))]);
    let (payload, rows_len) = coded(&mut encoder, &rows, 1, &NoHistory, None, None);
    receiver.decode(2, 1, 1, &payload, 1, rows_len, &mut out).expect("decodes");
    assert_eq!(receiver.refusals(), 0);
    let (carrier, rows_len) = coded(&mut encoder, &rows, 1, &NoHistory, None, Some(&old));
    assert_eq!(
        receiver.decode(2, 2, 2, &carrier, 1, rows_len, &mut out),
        Err(MzError::Unresolved),
        "a declaration of the old generation's datagrams cannot build"
    );
    assert_eq!(receiver.refusals(), 1, "a refused frame of the current generation is counted");
    // A late frame of the old generation is refused without counting.
    assert_eq!(
        receiver.decode(1, 21, 21, &carrier, 1, rows_len, &mut out),
        Err(MzError::Unresolved)
    );
    assert_eq!(receiver.refusals(), 1);
}

/// The epochs survive a generation; a declaration the receiver took but had
/// not built is built at the boundary, since the sender may already count it
/// held.
#[test]
fn epochs_survive_a_generation_and_pending_ones_are_built_at_its_boundary() {
    let mut sender = MzSession::default();
    let mut receiver = MzReceiver::default();
    let mut encoder = MzEncoder::default();
    let mut out = Vec::new();
    for seq in 1..=20u32 {
        let rows = rows_of(&[(0, 0, &session_row(seq as usize))]);
        let (payload, rows_len) = coded(&mut encoder, &rows, 1, &NoHistory, None, None);
        sender.keep(seq, encoder.trace());
        receiver.decode(1, seq, seq, &payload, 1, rows_len, &mut out).expect("decodes");
    }
    let declaration = MzEpochDeclaration { id: 1, base: 0, first: 1, datagrams: (1 << 20) - 1 };
    sender.build(&declaration).expect("sender builds");
    let rows = rows_of(&[(0, 0, &session_row(21))]);
    let (carrier, rows_len) = coded(&mut encoder, &rows, 1, &NoHistory, None, Some(&declaration));
    receiver.decode(1, 21, 21, &carrier, 1, rows_len, &mut out).expect("takes the declaration");
    assert_eq!(receiver.epoch(), None, "taken, not yet built");
    sender.begin_generation();
    // The new generation's snapshot, coded against the epoch.
    let snapshot = rows_of(&[(0, 0, &session_row(22)), (1, 0, &session_row(23))]);
    let (payload, rows_len) = coded(&mut encoder, &snapshot, 2, &NoHistory, sender.current(), None);
    assert_eq!(payload[0], 1, "coded against epoch 1");
    receiver.decode(2, 0, 0, &payload, 2, rows_len, &mut out).expect("decodes against the built epoch");
    assert_eq!(out, snapshot);
    assert_eq!(receiver.epoch(), Some(1));
}

/// Building an epoch keeps exactly its base beside it: an epoch the sender
/// declared and then abandoned is never a base, and the next build drops it
/// instead of the base frames are still coded against.
#[test]
fn a_built_epoch_the_sender_abandoned_never_evicts_its_base() {
    let mut session = MzSession::default();
    for seq in 1..=3 {
        session.keep(seq, &[seq << 9]);
    }
    let declare = |id, base, first| MzEpochDeclaration { id, base, first, datagrams: 1 };
    session.build(&declare(1, 0, 1)).expect("builds 1");
    // Epoch 2 is declared over 1 and built, but the sender abandons it.
    session.build(&declare(2, 1, 2)).expect("builds 2");
    // Epoch 3 is declared over 1 again.
    session.build(&declare(3, 1, 3)).expect("builds 3");
    assert!(session.epoch(1).is_some(), "the base frames still name");
    assert!(session.epoch(3).is_some());
    assert!(session.epoch(2).is_none());
}

/// A snapshot copies the rows the generation before it established, its own
/// rows are then copied by the frames that follow, and two generations back
/// retires. A row keeps its bytes whatever the grid's width became since.
#[test]
fn a_snapshot_copies_the_previous_generation_and_is_copied_in_its_own() {
    let lines: Vec<Vec<CellRepr>> = [
        "fn main() { println!(\"hello, world\"); }",
        "    let rows = rows_of(&[(0, 0, &row)]);",
        "// a comment that scrolls up the screen",
    ]
    .iter()
    .map(|text| text_row(text, [0xa6, 0xe3, 0xa1]))
    .collect();
    let mut receiver = MzReceiver::default();
    let mut sent = Sent::default();
    for (row, line) in (0u16..).zip(&lines) {
        receiver.history.record(1, 40, row, line, COLS);
        sent.record(40, row, line);
    }
    // A row of another width, recorded after them, retires nothing.
    let wide: Vec<CellRepr> = text_row("wider", [1, 2, 3]).into_iter().chain(text_row("", [1, 2, 3])).collect();
    receiver.history.record(1, 41, 0, &wide, 2 * COLS);
    // Generation 2's snapshot names generation 1's rows by sequence.
    sent.previous = true;
    let snapshot = rows_of(&[(0, 0, &lines[1]), (1, 0, &lines[2]), (2, 0, &lines[0])]);
    let mut encoder = MzEncoder::default();
    let (payload, rows_len) = coded(&mut encoder, &snapshot, 3, &sent, None, None);
    let mut out = Vec::new();
    receiver.decode(2, 0, 0, &payload, 3, rows_len, &mut out).expect("decodes");
    assert_eq!(out, snapshot);
    let plain = round_trip(&snapshot, 3);
    assert!(payload.len() * 2 < plain, "copies: {} of {plain}", payload.len());
    // Its rows are generation 2's datagram 0, which its frames copy.
    for (row, line) in (0u16..).zip([&lines[1], &lines[2], &lines[0]]) {
        receiver.history.record(2, 0, row, line, COLS);
    }
    let mut own = Sent { presentation_id: 3, ..Sent::default() };
    for (row, line) in (0u16..).zip([&lines[1], &lines[2], &lines[0]]) {
        own.record(0, row, line);
    }
    let delta = rows_of(&[(0, 0, &lines[2]), (1, 0, &lines[0])]);
    let (payload, rows_len) = coded(&mut encoder, &delta, 2, &own, None, None);
    receiver.decode(2, 3, 3, &payload, 2, rows_len, &mut out).expect("decodes");
    assert_eq!(out, delta);
    // Generation 3 begins: generation 2 is its previous, generation 1 is gone.
    receiver.history.begin_generation(3);
    assert!(receiver.history.row(3, 0, true, 0, 0).is_ok());
    assert_eq!(receiver.history.row(2, 0, true, 40, 0).err(), Some(MzError::Unresolved));
}

/// A store that sizes each row from its key, as the sender's does.
struct Sizes {
    released: usize,
}

impl MzStore for Sizes {
    fn insert(&mut self, key: u64) -> usize {
        usize::try_from(key % 7 + 1).expect("small") << 18
    }

    fn release(&mut self, _: u64) {
        self.released += 1;
    }
}

#[test]
fn a_ledger_retires_past_its_window_and_past_its_budget_oldest_first() {
    let mut ledger = MzLedger::default();
    let mut store = Sizes { released: 0 };
    ledger.record(1, 0, 3, &mut store);
    assert!(ledger.holds(1));
    ledger.record(1 + 2 * MZ_REFERENCE_DATAGRAMS, 0, 4, &mut store);
    assert!(!ledger.holds(1), "past the window");
    assert_eq!(store.released, 1);
    // Distinct rows past the budget retire the oldest datagrams first; one
    // row named twice is held once.
    let mut ledger = MzLedger::default();
    let mut seq = 100u32;
    while ledger.bytes() <= MZ_HISTORY_BYTES - (1 << 20) {
        ledger.record(seq, 0, u64::from(seq), &mut store);
        ledger.record(seq, 1, 6, &mut store);
        seq += 1;
    }
    ledger.record(seq, 0, u64::from(seq) + 3, &mut store);
    assert!(ledger.bytes() <= MZ_HISTORY_BYTES);
    assert!(!ledger.holds(100));
    assert!(ledger.holds(seq));
    assert_eq!(ledger.key(seq - 1, 1), Some(6));
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]

    /// The sender records every datagram it sends, the receiver those that
    /// arrive, late or never: whatever the sender's ledger still holds of a
    /// datagram that arrived, the receiver's holds too.
    #[test]
    fn the_senders_ledger_never_holds_a_row_the_receivers_retired(
        datagrams in proptest::collection::vec(
            (proptest::collection::vec(0u64..40, 1..6), 0u8..10, 0u32..4),
            1..1500,
        ),
    ) {
        let mut sender = MzLedger::default();
        let mut receiver = MzLedger::default();
        let mut store = Sizes { released: 0 };
        let mut in_flight: Vec<(u32, u32, &[u64])> = Vec::new();
        let mut arrived = std::collections::HashSet::new();
        for (seq, (keys, fate, delay)) in (1u32..).zip(&datagrams) {
            for (row, &key) in (0u16..).zip(keys) {
                sender.record(seq, row, key, &mut store);
            }
            // Fates 0..2 are lost; the rest arrive after `delay` sends.
            if *fate > 1 {
                in_flight.push((seq, *delay, keys));
            }
            in_flight.retain(|&(sent, delay, keys)| {
                if seq - sent < delay {
                    return true;
                }
                for (row, &key) in (0u16..).zip(keys) {
                    receiver.record(sent, row, key, &mut store);
                }
                arrived.insert(sent);
                false
            });
            for &held in &arrived {
                for (row, _) in (0u16..).zip(&datagrams[(held - 1) as usize].0) {
                    if sender.key(held, row).is_some() {
                        prop_assert!(receiver.key(held, row).is_some(), "seq {held} row {row}");
                    }
                }
            }
        }
    }
}

#[test]
fn decoded_frames_pass_the_row_validator() {
    let row = text_row("validated", [1, 2, 3]);
    let rows = rows_of(&[(0, 0, &row), (1, 4, &row[4..9])]);
    let mut payload = Vec::new();
    let encoded = MzEncoder::default()
        .encode_rows(&rows, 2, &NoHistory, None, None, &mut payload)
        .expect("encodes");
    let history = RowHistory::default();
    let held = Held { history: &history, presentation_id: 1, session: None };
    let mut decoded = Vec::new();
    MzDecoder::default().decode(&payload, 2, encoded.rows_len, &held, &mut decoded).expect("decodes");
    let mut frame = Vec::new();
    encode_frame_into(&mut frame, &header(2), std::iter::empty());
    frame.truncate(crate::STREAM_HEADER_BYTES + crate::FRAME_HEADER_BODY_BYTES);
    frame.extend_from_slice(&decoded);
    let body_len = u32::try_from(frame.len() - crate::STREAM_HEADER_BYTES).expect("a frame");
    frame[crate::DISPLAY_BODY_LENGTH_OFFSET..crate::DISPLAY_BODY_LENGTH_OFFSET + 4]
        .copy_from_slice(&body_len.to_be_bytes());
    let parsed = validate_display_frame(
        &frame,
        &mut Vec::new(),
        &mut Vec::new(),
        &mut Vec::new(),
        &mut Vec::new(),
        &mut Vec::new(),
    )
    .expect("valid");
    assert_eq!(parsed.row_count, 2);
    assert_eq!(iter_rows(&frame).count(), 2);
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(512))]

    /// Arbitrary bytes never panic, loop or overrun the declared length.
    #[test]
    fn arbitrary_payloads_decode_or_refuse(
        payload in proptest::collection::vec(any::<u8>(), 0..256),
        row_count in 0u16..8,
        rows_len in 0usize..2048,
    ) {
        let history = RowHistory::default();
        let held = Held { history: &history, presentation_id: 1, session: None };
        let mut out = Vec::new();
        if MzDecoder::default().decode(&payload, row_count, rows_len, &held, &mut out).is_ok() {
            prop_assert_eq!(out.len(), rows_len);
        }
    }

    /// Every truncation and every single-byte change of a real payload is
    /// refused or decodes to exactly the declared length.
    #[test]
    fn corrupted_payloads_are_refused(at in 0usize..64, flip in 1u8..=255) {
        let row = text_row("corruption must not decode quietly", [9, 9, 9]);
        let rows = rows_of(&[(2, 0, &row), (3, 5, &row[5..20]), (4, 0, &row)]);
        let mut payload = Vec::new();
        let encoded = MzEncoder::default().encode_rows(&rows, 3, &NoHistory, None, None, &mut payload).expect("encodes");
        let history = RowHistory::default();
        let held = Held { history: &history, presentation_id: 1, session: None };
        let mut decoder = MzDecoder::default();
        let mut out = Vec::new();
        let truncated = &payload[..at.min(payload.len().saturating_sub(1))];
        prop_assert!(decoder.decode(truncated, 3, encoded.rows_len, &held, &mut out).is_err());
        let mut changed = payload.clone();
        let index = at % changed.len();
        changed[index] ^= flip;
        if decoder.decode(&changed, 3, encoded.rows_len, &held, &mut out).is_ok() {
            prop_assert_eq!(out.len(), encoded.rows_len);
        }
    }

    /// Random rows of text, colour, runs and wide characters round-trip.
    #[test]
    fn random_rows_round_trip(
        rows in proptest::collection::vec(
            proptest::collection::vec((0u32..0x3_0000, 0u8..4, 0u8..3), 1..40),
            1..6,
        ),
    ) {
        let built: Vec<Vec<CellRepr>> = rows
            .iter()
            .map(|cells| {
                cells
                    .iter()
                    .map(|&(cp, fg, bg)| {
                        let cp = char::from_u32(cp).map_or(u32::from('?'), u32::from);
                        cell(
                            char::from_u32(cp).unwrap_or('?'),
                            [[1, 2, 3], [200, 100, 50], crate::DEFAULT_FOREGROUND, [cp.to_le_bytes()[0], 9, 9]][usize::from(fg)],
                            [crate::DEFAULT_BACKGROUND, [5, 5, 5], [cp.to_le_bytes()[0], 0, 0]][usize::from(bg)],
                        )
                    })
                    .collect()
            })
            .collect();
        let entries: Vec<(u16, u16, &[CellRepr])> = built
            .iter()
            .enumerate()
            .map(|(row, cells)| (u16::try_from(row).expect("a row"), 0, cells.as_slice()))
            .collect();
        let bytes = rows_of(&entries);
        round_trip(&bytes, u16::try_from(entries.len()).expect("rows"));
    }
}

/// Offline checkpoint over frames the production pipeline offered MZ
/// (`u16 row_count | u32 len | rows` dumps): v2 bytes with the static model
/// alone, and with session epochs every 32 frames lagging 64, every frame
/// round-tripped through a receiver that builds the same epochs. With
/// `MERKUR_MZ_TRAIN_OUT`, the static encodes' traces of the recordings whose
/// names contain `MERKUR_MZ_TRAIN_ONLY` train a model written there.
#[test]
#[ignore = "reads MERKUR_MZ_FRAMES"]
fn v2_checkpoint() {
    let dir = std::env::var("MERKUR_MZ_FRAMES").expect("MERKUR_MZ_FRAMES");
    let train_out = std::env::var("MERKUR_MZ_TRAIN_OUT").ok();
    let train_only = std::env::var("MERKUR_MZ_TRAIN_ONLY").ok();
    let mut trainer = train::MzTrainer::default();
    let mut paths: Vec<_> = std::fs::read_dir(&dir).expect("dir").map(|e| e.expect("entry").path()).collect();
    paths.sort();
    let (mut total_raw, mut total_static, mut total_session) = (0usize, 0usize, 0usize);
    println!("V2 {:<26} {:>6} {:>9} {:>9} {:>9}", "recording", "frames", "raw", "static", "session");
    for path in paths {
        let name = path.file_stem().expect("stem").to_string_lossy().into_owned();
        let data = std::fs::read(&path).expect("dump");
        let mut frames = Vec::new();
        let mut at = 0;
        while at + 6 <= data.len() {
            let rows = u16::from_le_bytes([data[at], data[at + 1]]);
            let len = u32::from_le_bytes(data[at + 2..at + 6].try_into().expect("len")) as usize;
            frames.push((rows, &data[at + 6..at + 6 + len]));
            at += 6 + len;
        }
        let train = train_out.is_some() && train_only.as_deref().is_none_or(|only| name.contains(only));
        let mut encoder = MzEncoder::default();
        let mut decoder = MzDecoder::default();
        let mut sender = MzSession::default();
        let mut receiver = MzSession::default();
        let history = RowHistory::default();
        let (mut raw, mut plain, mut with_session) = (0usize, 0usize, 0usize);
        let mut folded = 1u32;
        let mut held: Option<u8> = None;
        let mut epoch = 0u8;
        let (mut payload, mut decoded) = (Vec::new(), Vec::new());
        for (index, &(row_count, rows)) in frames.iter().enumerate() {
            let seq = u32::try_from(index).expect("a frame index") + 1;
            payload.clear();
            let Some(_) = encoder.encode_rows(rows, row_count, &NoHistory, None, None, &mut payload) else {
                continue;
            };
            raw += rows.len();
            plain += payload.len().min(rows.len());
            if train {
                trainer.add_trace(encoder.trace());
            }
            // Epochs: every 32 frames, fold what is 64 frames old.
            if index % 32 == 0 && seq > 64 && folded + 64 <= seq {
                let first = folded;
                let count = (seq - 64 - first).min(MZ_EPOCH_DATAGRAMS);
                if count > 0 {
                    let next = next_epoch_id(epoch);
                    let declaration = MzEpochDeclaration {
                        id: next,
                        base: held.unwrap_or(0),
                        first,
                        datagrams: if count == 64 { u64::MAX } else { (1u64 << count) - 1 },
                    };
                    sender.build(&declaration).expect("sender builds");
                    receiver.build(&declaration).expect("receiver builds");
                    folded = first + count;
                    epoch = next;
                    held = Some(next);
                }
            }
            payload.clear();
            let session = held.and_then(|id| sender.epoch(id).map(|model| (id, model)));
            let encoded = encoder.encode_rows(rows, row_count, &NoHistory, session, None, &mut payload).expect("encodes");
            with_session += payload.len().min(rows.len());
            sender.keep(seq, encoder.trace());
            let sources = Held { history: &history, presentation_id: seq, session: Some(&receiver) };
            decoder.decode(&payload, row_count, encoded.rows_len, &sources, &mut decoded).expect("decodes");
            assert_eq!(decoded, rows, "{name} frame {index}");
            receiver.keep(seq, decoder.trace());
        }
        total_raw += raw;
        total_static += plain;
        total_session += with_session;
        println!("V2 {name:<26} {:>6} {raw:>9} {plain:>9} {with_session:>9}", frames.len());
    }
    println!("V2 TOTAL raw {total_raw} static {total_static} session {total_session}");
    if let Some(out) = train_out {
        let data = trainer.model_data(256 * 1024);
        std::fs::write(&out, train::MzTrainer::model_source(&data)).expect("write model");
        println!("V2 wrote {} bytes of model data to {out}", data.len());
    }
}

#[test]
#[ignore = "P3 row-price attribution over MERKUR_MZ_FRAMES"]
fn p3_row_price_attribution() {
    use super::{model::static_model, nibble, session::Layered};
    let directory = std::env::var("MERKUR_MZ_FRAMES").expect("frames");
    let mut paths: Vec<_> =
        std::fs::read_dir(directory).unwrap().map(|p| p.unwrap().path()).collect();
    paths.sort();
    let (mut frames, mut entries, mut symbols, mut sessions) = (0u64, 0u64, 0u64, 0u64);
    let mut encoder = MzEncoder::default();
    let mut output = Vec::new();
    let mut tables = nibble::Tables::default();
    for path in paths {
        let data = std::fs::read(path).unwrap();
        let mut at = 0;
        let mut session = SessionModel::default();
        while at < data.len() {
            let count = u16::from_le_bytes(data[at..at + 2].try_into().unwrap());
            let len = u32::from_le_bytes(data[at + 2..at + 6].try_into().unwrap()) as usize;
            let rows = &data[at + 6..at + 6 + len];
            at += 6 + len;
            for with_session in [false, true] {
                output.clear();
                let prior = with_session.then_some((1, &session));
                let encoded =
                    encoder.encode_rows(rows, count, &NoHistory, prior, None, &mut output).unwrap();
                assert_eq!(encoder.row_costs().len(), usize::from(count));
                assert_eq!(
                    encoder.row_costs().iter().map(|r| r.raw_bytes).sum::<usize>(),
                    rows.len()
                );
                let expected = if encoded.prior == 0 {
                    nibble::price(static_model(), &mut tables, encoder.trace())
                } else {
                    sessions += 1;
                    nibble::price(
                        &Layered { session: &session, base: static_model() },
                        &mut tables,
                        encoder.trace(),
                    )
                };
                assert_eq!(encoder.row_costs().iter().map(|r| r.bits).sum::<u64>(), expected);
                frames += 1;
                entries += u64::from(count);
                symbols += encoder.trace().len() as u64;
            }
            session.fold(encoder.trace());
        }
    }
    println!(
        "P3_PRICES frames={frames} entries={entries} symbols={symbols} session_chosen={sessions}"
    );
}

/// Allocator requests on this thread, leaving parallel tests out of the tally.
mod allocation_profile {
    use std::alloc::{GlobalAlloc, Layout, System};
    use std::cell::Cell;

    thread_local! {
        static TALLY: Cell<Option<(usize, usize)>> = const { Cell::new(None) };
    }

    struct Allocator;

    #[global_allocator]
    static ALLOCATOR: Allocator = Allocator;

    fn record(bytes: usize) {
        TALLY.with(|tally| {
            if let Some((calls, requested)) = tally.get() {
                tally.set(Some((calls + 1, requested + bytes)));
            }
        });
    }

    // SAFETY: pointers and layouts are forwarded unchanged to System; the
    // thread-local tally neither allocates nor accesses the allocated block.
    unsafe impl GlobalAlloc for Allocator {
        unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
            record(layout.size());
            // SAFETY: the caller's allocation layout is passed unchanged.
            unsafe { System.alloc(layout) }
        }

        unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
            record(layout.size());
            // SAFETY: the caller's allocation layout is passed unchanged.
            unsafe { System.alloc_zeroed(layout) }
        }

        unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
            // SAFETY: System allocated this pointer with this layout.
            unsafe { System.dealloc(pointer, layout) }
        }

        unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, size: usize) -> *mut u8 {
            record(size);
            // SAFETY: the caller's pointer, layout and new size are unchanged.
            unsafe { System.realloc(pointer, layout, size) }
        }
    }

    pub(super) fn count<T>(run: impl FnOnce() -> T) -> (T, (usize, usize)) {
        TALLY.with(|tally| tally.set(Some((0, 0))));
        let result = run();
        let tally = TALLY
            .with(|tally| tally.replace(None))
            .expect("active tally");
        (result, tally)
    }
}

fn proof_bytes(name: &str, bytes: &[u8]) {
    println!(
        "{name}: bytes={} hash={:016x}",
        bytes.len(),
        xxhash_rust::xxh3::xxh3_64(bytes)
    );
    if let Some(directory) = std::env::var_os("MERKUR_MZ_PROOF_DIR") {
        let directory = std::path::PathBuf::from(directory);
        std::fs::create_dir_all(&directory).expect("proof directory");
        std::fs::write(directory.join(name), bytes).expect("proof bytes");
    }
}

fn logical_trace(trace: &[u32]) -> Vec<u8> {
    use super::model::{AUX, field_of};
    trace
        .iter()
        .flat_map(|&entry| {
            let key = entry >> 9;
            let logical = (u32::try_from(field_of(key)).expect("field") << 10)
                | (key & u32::try_from(AUX - 1).expect("context mask"));
            (logical << 9 | (entry & 511)).to_le_bytes()
        })
        .collect()
}

/// Canonical keys let the same oracle run before and after a storage change.
fn logical_model(data: &[u8]) -> Vec<u8> {
    use super::model::{AUX, FIELDS, field_of};
    let mut out = data.to_vec();
    let count = u32::from_le_bytes(data[..4].try_into().expect("context count"));
    let mut at = 4;
    for index in 0..FIELDS + count as usize {
        if index >= FIELDS {
            let key = u32::from_le_bytes(data[at..at + 4].try_into().expect("key"));
            let aux = key & u32::try_from(AUX - 1).expect("mask");
            assert!(aux < 1024, "compiled context {key} exceeds ten bits");
            let logical = u32::try_from(field_of(key)).expect("field") << 10 | aux;
            out[at..at + 4].copy_from_slice(&logical.to_le_bytes());
            at += 4;
        }
        let mask = u16::from_le_bytes(data[at + 33..at + 35].try_into().expect("low mask"));
        at += 35 + 32 * mask.count_ones() as usize;
    }
    assert_eq!(at, data.len());
    out
}

fn context_corpus() -> Vec<(&'static str, Vec<u8>, u16)> {
    let ascii = text_row(
        "user@host:~/merkur$ cargo test --release",
        crate::DEFAULT_FOREGROUND,
    );
    let unicode = text_row("日本語 한글 Привет مرحبا 🎉⠃╔══╗", [180, 190, 254]);
    let colors: Vec<_> = (0..COLS)
        .map(|i| {
            let byte = u8::try_from(i).expect("column");
            cell(char::from(b'!' + byte), [byte * 6, 200, 17], [3, byte, 9])
        })
        .collect();
    let mut links = unicode.clone();
    for cell in &mut links[2..23] {
        cell.link = 9;
    }
    links[30].codepoint = u32::from('界');
    links[30].attrs = CellAttrs::WIDE;
    links[31].codepoint = 0;
    let mut graphics = rows_of(&[(1, 0, &ascii)]);
    graphics[2] |= (crate::ROW_FLAG_GRAPHICS >> 8) as u8;
    graphics.extend_from_slice(&300u32.to_be_bytes());
    graphics.extend((0..300u32).map(|i| (i * 7 + i / 13).to_le_bytes()[0]));
    vec![
        ("ascii", rows_of(&[(0, 0, &ascii)]), 1),
        ("unicode", rows_of(&[(1, 0, &unicode)]), 1),
        ("colors", rows_of(&[(2, 0, &colors)]), 1),
        ("links", rows_of(&[(3, 0, &links)]), 1),
        ("graphics", graphics, 1),
        (
            "frame-copy",
            rows_of(&[(0, 0, &colors), (1, 0, &unicode), (2, 0, &colors)]),
            3,
        ),
        ("rle", rows_of(&[(0, 0, &vec![CellRepr::BLANK; 512])]), 1),
        ("tiny", rows_of(&[(0, 0, &ascii[..1])]), 1),
    ]
}

/// Runs on either index layout. The exported bytes include rejected decodes'
/// partial output and traces, not just the accepted corpus.
#[test]
#[ignore = "context storage, allocation and byte-equivalence profile"]
#[expect(
    clippy::too_many_lines,
    reason = "the profile checks complete valid fixtures and mutates only in-bounds bytes"
)]
fn context_stride_equivalence_profile() {
    use super::model::{FIELDS, KEYS, Prior, StaticModel, key, static_model};
    use super::session::Layered;
    let (_, parse) =
        allocation_profile::count(|| StaticModel::parse(super::model_data::MODEL).expect("prior"));
    let (_, tables) = allocation_profile::count(super::nibble::Tables::default);
    let (mut session, session_alloc) = allocation_profile::count(SessionModel::default);
    assert_eq!(tables, (1, KEYS * size_of::<u32>()));
    assert_eq!(session_alloc, tables);
    println!(
        "index_bytes={} tables={tables:?} session={session_alloc:?} parse={parse:?}",
        KEYS * size_of::<u32>()
    );
    proof_bytes("prior.bin", &logical_model(super::model_data::MODEL));
    let history = RowHistory::default();
    let held = Held {
        history: &history,
        presentation_id: 1,
        session: None,
    };
    let mut encoder = MzEncoder::default();
    let mut decoder = MzDecoder::default();
    let mut decoded = Vec::new();
    let mut malformed = Vec::new();
    let mut trainer = train::MzTrainer::default();
    for (name, rows, count) in context_corpus() {
        let (payload, rows_len) = coded(&mut encoder, &rows, count, &NoHistory, None, None);
        decoder
            .decode(&payload, count, rows_len, &held, &mut decoded)
            .expect("decodes");
        assert_eq!(decoded, rows);
        assert_eq!(decoder.trace(), encoder.trace());
        proof_bytes(&format!("{name}-static.bin"), &payload);
        proof_bytes(
            &format!("{name}-trace.bin"),
            &logical_trace(encoder.trace()),
        );
        session.fold(encoder.trace());
        if name == "tiny" {
            trainer.add_trace(encoder.trace());
        }
        let mut reuse = Vec::new();
        encoder
            .encode_rows(&rows, count, &NoHistory, None, None, &mut reuse)
            .expect("warm");
        let (_, warm) = allocation_profile::count(|| {
            for _ in 0..128 {
                reuse.clear();
                std::hint::black_box(
                    encoder.encode_rows(&rows, count, &NoHistory, None, None, &mut reuse),
                );
                std::hint::black_box(
                    decoder.decode(&reuse, count, rows_len, &held, &mut decoded),
                )
                .expect("warm decode");
            }
        });
        assert_eq!(warm, (0, 0), "{name}");
        println!("{name}: warm_128={warm:?}");
        for at in 0..payload.len() {
            for xor in [1, 127, 255] {
                let mut corrupt = payload.clone();
                corrupt[at] ^= xor;
                let result = decoder.decode(&corrupt, count, rows_len, &held, &mut decoded);
                malformed.push(match result {
                    Ok(()) => 0,
                    Err(MzError::Corrupt) => 1,
                    Err(MzError::Unresolved) => 2,
                });
                malformed.extend_from_slice(&(decoded.len() as u64).to_le_bytes());
                malformed.extend_from_slice(&decoded);
                malformed.extend_from_slice(&logical_trace(decoder.trace()));
            }
            let result = decoder.decode(&payload[..at], count, rows_len, &held, &mut decoded);
            assert!(result.is_err());
        }
    }
    proof_bytes("malformed.bin", &malformed);
    let (clone, cloned) = allocation_profile::count(|| session.clone());
    println!("folded_table_bytes={} clone={cloned:?}", session.bytes());
    let layered = Layered {
        session: &clone,
        base: static_model(),
    };
    let mut folded = Vec::new();
    for field in 0..u32::try_from(FIELDS).expect("field count") {
        for aux in 0..1024 {
            let key = key(field, aux);
            folded.push(layered.rate(key));
            for freq in layered
                .hi(key)
                .freqs()
                .into_iter()
                .chain((0..16).flat_map(|h| layered.lo(key, h).freqs()))
            {
                folded.extend_from_slice(&freq.to_le_bytes());
            }
        }
    }
    proof_bytes("folded.bin", &folded);
    let session_rows = rows_of(&[(0, 0, &session_row(99))]);
    let (payload, rows_len) = coded(
        &mut encoder,
        &session_rows,
        1,
        &NoHistory,
        Some((1, &session)),
        None,
    );
    proof_bytes("session.bin", &payload);
    println!("session_rows_len={rows_len}");
    proof_bytes("trained.bin", &logical_model(&trainer.model_data(1024)));
    // Wrapping the working-table generation clears every index slot.
    let (_, wraps) = allocation_profile::count(|| {
        let mut tables = super::nibble::Tables::default();
        for _ in 0..65_537 {
            tables.begin();
        }
        std::hint::black_box(tables);
    });
    println!("generation_wrap={wraps:?}");
}

#[test]
#[ignore = "isolated instruction and allocation profile"]
fn context_workload_profile() {
    let name = std::env::var("MERKUR_MZ_WORKLOAD").expect("a corpus workload name");
    let (_, rows, count) = context_corpus()
        .into_iter()
        .find(|(case, _, _)| *case == name)
        .expect("workload");
    let mut encoder = MzEncoder::default();
    let mut decoder = MzDecoder::default();
    let mut payload = Vec::new();
    let mut decoded = Vec::new();
    let history = RowHistory::default();
    let mut session = MzSession::default();
    for seq in 1..=20 {
        encoder
            .encode_rows(&rows, count, &NoHistory, None, None, &mut payload)
            .expect("training frame");
        session.keep(seq, encoder.trace());
        payload.clear();
    }
    session
        .build(&MzEpochDeclaration {
            id: 1,
            base: 0,
            first: 1,
            datagrams: (1 << 20) - 1,
        })
        .expect("epoch");
    let held = Held {
        history: &history,
        presentation_id: 21,
        session: Some(&session),
    };
    let mut run = || {
        for prior in [None, session.current()] {
            payload.clear();
            let encoded = encoder
                .encode_rows(&rows, count, &NoHistory, prior, None, &mut payload)
                .expect("encode");
            decoder
                .decode(&payload, count, encoded.rows_len, &held, &mut decoded)
                .expect("decode");
            assert_eq!(decoded, rows);
            std::hint::black_box(&payload);
        }
    };
    for _ in 0..128 {
        run();
    }
    let (_, tally) = allocation_profile::count(|| {
        for _ in 0..10_000 {
            run();
        }
    });
    assert_eq!(tally, (0, 0));
    println!("{name}: static_and_session_pairs=10000 warm={tally:?}");
}

fn copy_corpus() -> Vec<(&'static str, Vec<u8>, u16, Sent, RowHistory)> {
    let colors: Vec<_> = (0..512u32)
        .map(|i| {
            let [a, b, c, _] = i.wrapping_mul(0x79b9).to_le_bytes();
            cell(char::from(b'!' + (i % 80) as u8), [a, b, c], [c, a, b])
        })
        .collect();
    let mut linked = colors.clone();
    for (i, cell) in linked.iter_mut().enumerate() {
        cell.link = u32::try_from(i % 2 + 1).expect("link id");
    }
    let mut runs = vec![CellRepr::BLANK; 512];
    for cell in &mut runs[..256] {
        cell.codepoint = u32::from('x');
    }
    let mut cases = vec![
        (
            "literal",
            rows_of(&[(0, 0, &colors)]),
            1,
            Sent::default(),
            RowHistory::default(),
        ),
        (
            "frame",
            rows_of(&[(0, 0, &colors), (1, 0, &colors)]),
            2,
            Sent::default(),
            RowHistory::default(),
        ),
        (
            "chained",
            rows_of(&[
                (0, 0, &colors),
                (1, 0, &colors[100..400]),
                (2, 0, &colors[180..300]),
            ]),
            3,
            Sent::default(),
            RowHistory::default(),
        ),
        (
            "rle",
            rows_of(&[(0, 0, &runs), (1, 0, &runs)]),
            2,
            Sent::default(),
            RowHistory::default(),
        ),
        (
            "links-offset",
            rows_of(&[(0, 0, &linked), (1, 0, &colors[100..400])]),
            2,
            Sent::default(),
            RowHistory::default(),
        ),
    ];
    for (name, previous, source, target) in [
        ("history", false, &colors, &colors[..]),
        ("previous", true, &colors, &colors[..]),
        ("offset", false, &colors, &colors[100..400]),
    ] {
        let mut sent = Sent {
            presentation_id: 45,
            previous,
            ..Sent::default()
        };
        sent.record(40, 7, source);
        let mut history = RowHistory::default();
        history.record(
            if previous {
                previous_generation(GENERATION)
            } else {
                GENERATION
            },
            40,
            7,
            source,
            512,
        );
        cases.push((name, rows_of(&[(0, 0, target)]), 1, sent, history));
    }
    cases
}

fn copy_item_count(trace: &[u32]) -> usize {
    use super::model::{F_ITEMS, field_of};
    let mut value = 0usize;
    let mut total = 0usize;
    for &entry in trace {
        let key = entry >> 9;
        if field_of(key) != F_ITEMS as usize || entry & 256 == 0 {
            continue;
        }
        let index = key & 7;
        if index == 0 {
            value = 0;
        }
        let byte = entry & 255;
        value |= (byte as usize & 127) << (7 * index);
        if byte & 128 == 0 {
            total += value + 2;
        }
    }
    total
}

#[test]
#[ignore = "copy metadata traffic, allocation and byte-equivalence profile"]
#[expect(
    clippy::too_many_lines,
    reason = "the profile checks valid fixtures, then mutates their bounded payloads"
)]
fn copy_metadata_profile() {
    let selected = std::env::var("MERKUR_MZ_COPY_WORKLOAD").ok();
    let mut malformed = Vec::new();
    for (name, rows, count, sent, history) in copy_corpus() {
        if selected.as_ref().is_some_and(|selected| selected != name) {
            continue;
        }
        let mut encoder = MzEncoder::default();
        let (payload, rows_len) = coded(&mut encoder, &rows, count, &sent, None, None);
        let items = copy_item_count(encoder.trace());
        assert_eq!(items == 0, name == "literal");
        let held = Held {
            history: &history,
            presentation_id: 45,
            session: None,
        };
        let mut decoded = Vec::new();
        let ((mut decoder, result), cold) = allocation_profile::count(|| {
            let mut decoder = MzDecoder::default();
            let result = decoder.decode(&payload, count, rows_len, &held, &mut decoded);
            (decoder, result)
        });
        result.expect("cold decode");
        assert_eq!(decoded, rows);
        assert_eq!(encoder.trace(), decoder.trace());
        let storage = decoder.copy_storage();
        println!(
            "{name}: copied_items={items} intermediate_bytes={} cold={cold:?} storage={storage:?} encoder_size={} decoder_size={}",
            if storage.0 == 0 { 0 } else { items * 8 },
            size_of::<MzEncoder>(),
            size_of::<MzDecoder>()
        );
        let (_, warm) = allocation_profile::count(|| {
            for _ in 0..10_000 {
                decoder
                    .decode(&payload, count, rows_len, &held, &mut decoded)
                    .expect("warm decode");
                std::hint::black_box(&decoded);
            }
        });
        assert_eq!(warm, (0, 0));
        println!("{name}: warm_10000={warm:?}");
        proof_bytes(&format!("{name}-payload.bin"), &payload);
        proof_bytes(&format!("{name}-decoded.bin"), &decoded);
        proof_bytes(
            &format!("{name}-trace.bin"),
            &logical_trace(decoder.trace()),
        );
        if selected.is_some() {
            continue;
        }
        for at in 0..payload.len() {
            for xor in [1, 127, 255] {
                let mut corrupt = payload.clone();
                corrupt[at] ^= xor;
                let result = decoder.decode(&corrupt, count, rows_len, &held, &mut decoded);
                malformed.push(match result {
                    Ok(()) => 0,
                    Err(MzError::Corrupt) => 1,
                    Err(MzError::Unresolved) => 2,
                });
                malformed.extend_from_slice(&(decoded.len() as u64).to_le_bytes());
                malformed.extend_from_slice(&xxhash_rust::xxh3::xxh3_64(&decoded).to_le_bytes());
                malformed.extend_from_slice(
                    &xxhash_rust::xxh3::xxh3_64(&logical_trace(decoder.trace())).to_le_bytes(),
                );
            }
        }
        if matches!(name, "history" | "previous") {
            let source = held
                .row(
                    name == "previous",
                    if name == "previous" { 40 } else { 5 },
                    7,
                )
                .expect("source");
            for (source_item, copy_count, cells, mode) in [
                (u16::MAX, 2, 512, source.mode),
                (0, u16::MAX, 512, source.mode),
                (0, 512, 2, source.mode),
                (0, 512, 512, source.mode ^ 1),
            ] {
                let payload = super::frame::copy_profile_payload(
                    if name == "previous" { 2 } else { 1 },
                    if name == "previous" { 40 } else { 5 },
                    source_item,
                    copy_count,
                    cells,
                    mode,
                );
                let result = decoder.decode(&payload, 1, rows_len, &held, &mut decoded);
                assert_eq!(result, Err(MzError::Corrupt));
                malformed.extend_from_slice(&(decoded.len() as u64).to_le_bytes());
                malformed.extend_from_slice(&xxhash_rust::xxh3::xxh3_64(&decoded).to_le_bytes());
                malformed.extend_from_slice(
                    &xxhash_rust::xxh3::xxh3_64(&logical_trace(decoder.trace())).to_le_bytes(),
                );
            }
        }
    }
    if selected.is_none() {
        proof_bytes("copy-malformed.bin", &malformed);
    }
}

#[test]
#[ignore = "encoder allocation and instruction control for copy metadata storage"]
fn copy_encoder_profile() {
    let selected = std::env::var("MERKUR_MZ_COPY_WORKLOAD").ok();
    for (name, rows, count, sent, _) in copy_corpus() {
        if selected.as_ref().is_some_and(|selected| selected != name) {
            continue;
        }
        let mut payload = Vec::new();
        let ((mut encoder, result), cold) = allocation_profile::count(|| {
            let mut encoder = MzEncoder::default();
            let result = encoder.encode_rows(&rows, count, &sent, None, None, &mut payload);
            (encoder, result)
        });
        result.expect("cold encode");
        let expected = payload.clone();
        let (_, warm) = allocation_profile::count(|| {
            for _ in 0..10_000 {
                payload.clear();
                encoder
                    .encode_rows(&rows, count, &sent, None, None, &mut payload)
                    .expect("warm encode");
                std::hint::black_box(&payload);
            }
        });
        assert_eq!(warm, (0, 0));
        assert_eq!(payload, expected);
        println!("{name}: encoder_cold={cold:?} encoder_warm_10000={warm:?}");
    }
}

#[test]
#[ignore = "session encoder allocation and instruction control for copy metadata storage"]
fn copy_session_encoder_profile() {
    let selected = std::env::var("MERKUR_MZ_COPY_WORKLOAD").ok();
    for (name, rows, count, sent, history) in copy_corpus() {
        if selected.as_ref().is_some_and(|selected| selected != name) {
            continue;
        }
        let mut training = MzEncoder::default();
        let mut session = MzSession::default();
        let mut payload = Vec::new();
        for seq in 1..=20 {
            payload.clear();
            training
                .encode_rows(&rows, count, &sent, None, None, &mut payload)
                .expect("training encode");
            session.keep(seq, training.trace());
        }
        session
            .build(&MzEpochDeclaration {
                id: 1,
                base: 0,
                first: 1,
                datagrams: (1 << 20) - 1,
            })
            .expect("epoch");
        let prior = session.current().expect("trained prior");
        payload.clear();
        let ((mut encoder, result), cold) = allocation_profile::count(|| {
            let mut encoder = MzEncoder::default();
            let result = encoder.encode_rows(&rows, count, &sent, Some(prior), None, &mut payload);
            (encoder, result)
        });
        let encoded = result.expect("cold encode");
        let expected = payload.clone();
        if selected.is_none() {
            let held = Held {
                history: &history,
                presentation_id: 45,
                session: Some(&session),
            };
            let mut decoder = MzDecoder::default();
            let mut decoded = Vec::new();
            decoder
                .decode(&payload, count, encoded.rows_len, &held, &mut decoded)
                .expect("session decode");
            assert_eq!(decoded, rows);
            assert_eq!(encoder.trace(), decoder.trace());
        }
        let (_, warm) = allocation_profile::count(|| {
            for _ in 0..10_000 {
                payload.clear();
                encoder
                    .encode_rows(&rows, count, &sent, Some(prior), None, &mut payload)
                    .expect("warm encode");
                std::hint::black_box(&payload);
            }
        });
        assert_eq!(warm, (0, 0));
        assert_eq!(payload, expected);
        proof_bytes(&format!("{name}-session-copy.bin"), &payload);
        println!("{name}: session_encoder_cold={cold:?} session_encoder_warm_10000={warm:?}");
    }
}
