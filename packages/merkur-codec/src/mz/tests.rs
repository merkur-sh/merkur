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

struct NoReferences;

impl MzResolve for NoReferences {
    fn resolve(&mut self, _: u16, _: MzReference, _: &mut Vec<u8>) -> Result<(), MzError> {
        Err(MzError::Unresolved)
    }
}

struct Resolver<'a> {
    history: &'a mut RowHistory,
    seq: u32,
}

impl MzResolve for Resolver<'_> {
    fn resolve(
        &mut self,
        target_row: u16,
        reference: MzReference,
        out: &mut Vec<u8>,
    ) -> Result<(), MzError> {
        self.history.resolve(self.seq, target_row, reference, out)
    }
}

fn round_trip(rows: &[u8], row_count: u16) -> usize {
    let mut encoder = MzEncoder::default();
    let mut payload = Vec::new();
    let rows_len = encoder
        .encode(rows, row_count, &[], &mut payload)
        .expect("encodes");
    assert_eq!(rows_len, rows.len());
    let mut decoded = Vec::new();
    decode_mz_rows(
        &payload,
        row_count,
        rows_len,
        &mut NoReferences,
        &mut decoded,
    )
    .expect("decodes");
    assert_eq!(decoded, rows);
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
    // Per-cell truecolor carries little the model can predict, but still codes.
    let rows = rows_of(&[(3, 0, &prompt), (4, 0, &log), (5, 7, &colored[7..30])]);
    let coded = round_trip(&rows, 3);
    assert!(coded < rows.len(), "{coded} of {}", rows.len());
    // A single short row codes with one state.
    let one = rows_of(&[(0, 2, &prompt[2..5])]);
    round_trip(&one, 1);
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
            MzEncoder::default().encode(&rows, 1, &[], &mut Vec::new()),
            None
        );
    }
}

#[test]
fn references_name_rows_the_receiver_received_and_are_taken_only_when_smaller() {
    let mut history = RowHistory::default();
    let original = text_row(
        "fn main() { println!(\"hello, world\"); }",
        [0xa6, 0xe3, 0xa1],
    );
    let mut newer = original.clone();
    newer[3].codepoint = u32::from(b'X');
    // Seq 11 rewrote row 5 before seq 10's copy arrived: the grid skips the
    // older one, the history still holds it as seq 10 carried it.
    history.record(11, 5, &newer, COLS, ROWS);
    history.record(10, 5, &original, COLS, ROWS);
    // Seq 12 writes the original at row 4: a reference to (10, 5).
    let rows = rows_of(&[(4, 0, &original)]);
    let reference = MzReference {
        seq_delta: 2,
        source_row: 5,
        full_row_bytes: u32::try_from(full_row_entry_bytes(&original)).expect("a row"),
    };
    let mut encoder = MzEncoder::default();
    let mut payload = Vec::new();
    let rows_len = encoder
        .encode(&rows, 1, &[Some(reference)], &mut payload)
        .expect("encodes");
    assert_eq!(encoder.taken(), [true]);
    assert_eq!(
        rows_len,
        rows.len(),
        "the reference is a full row, as the literal is"
    );
    assert!(
        payload.len() < 8,
        "a reference codes in a few bytes: {}",
        payload.len()
    );
    let mut decoded = Vec::new();
    decode_mz_rows(
        &payload,
        1,
        rows_len,
        &mut Resolver {
            history: &mut history,
            seq: 12,
        },
        &mut decoded,
    )
    .expect("resolves");
    assert_eq!(decoded, rows);

    // A one-cell literal is cheaper than a reference far back and far away,
    // and is kept.
    let short = rows_of(&[(4, 0, &original[..1])]);
    let rows_len = encoder
        .encode(
            &short,
            1,
            &[Some(MzReference {
                seq_delta: MZ_REFERENCE_DATAGRAMS - 3,
                source_row: 300,
                full_row_bytes: 999,
            })],
            &mut Vec::new(),
        )
        .expect("encodes");
    assert_eq!(rows_len, short.len());
    assert_eq!(encoder.taken(), [false]);
}

#[test]
fn a_reference_to_a_row_the_receiver_does_not_hold_is_refused() {
    let mut history = RowHistory::default();
    let row = text_row(
        "the daemon believes this row arrived",
        crate::DEFAULT_FOREGROUND,
    );
    history.record(20, 2, &row, COLS, ROWS);
    let reference = |seq_delta, source_row| MzReference {
        seq_delta,
        source_row,
        full_row_bytes: 0,
    };
    let mut out = Vec::new();
    assert_eq!(history.resolve(21, 3, reference(1, 2), &mut out), Ok(()));
    assert_eq!(
        history.resolve(21, 3, reference(2, 2), &mut out),
        Err(MzError::Unresolved)
    );
    assert_eq!(
        history.resolve(21, 3, reference(1, 1), &mut out),
        Err(MzError::Unresolved)
    );
    assert_eq!(
        history.resolve(21, 3, reference(MZ_REFERENCE_DATAGRAMS + 1, 2), &mut out),
        Err(MzError::Corrupt)
    );
    // A row with a link is never a source.
    let mut linked = row.clone();
    linked[0].link = 4;
    history.record(22, 6, &linked, COLS, ROWS);
    assert_eq!(
        history.resolve(23, 3, reference(1, 6), &mut out),
        Err(MzError::Unresolved)
    );
}

#[test]
fn a_range_codes_consecutive_references_as_one_op() {
    let mut history = RowHistory::default();
    let lines: Vec<Vec<CellRepr>> = (0..6)
        .map(|line| text_row(&format!("log line {line} of a scrolling build"), [9, 9, 9]))
        .collect();
    for (row, cells) in (0u16..).zip(&lines) {
        history.record(30, row, cells, COLS, ROWS);
    }
    // Seq 31 scrolls every line up two rows.
    let entries: Vec<(u16, u16, &[CellRepr])> = (0u16..)
        .zip(&lines[2..])
        .map(|(row, cells)| (row, 0, cells.as_slice()))
        .collect();
    let rows = rows_of(&entries);
    let references: Vec<Option<MzReference>> = (2u16..)
        .zip(&lines[2..])
        .map(|(source_row, cells)| {
            Some(MzReference {
                seq_delta: 1,
                source_row,
                full_row_bytes: u32::try_from(full_row_entry_bytes(cells)).expect("a row"),
            })
        })
        .collect();
    let mut encoder = MzEncoder::default();
    let mut payload = Vec::new();
    let rows_len = encoder
        .encode(&rows, 4, &references, &mut payload)
        .expect("encodes");
    assert_eq!(encoder.taken(), [true; 4]);
    let mut literals = Vec::new();
    encoder
        .encode(&rows, 4, &[], &mut literals)
        .expect("encodes");
    assert!(
        payload.len() * 4 < literals.len(),
        "four rows by reference: {} bytes, as literals {}",
        payload.len(),
        literals.len()
    );
    let mut decoded = Vec::new();
    decode_mz_rows(
        &payload,
        4,
        rows_len,
        &mut Resolver {
            history: &mut history,
            seq: 31,
        },
        &mut decoded,
    )
    .expect("resolves");
    assert_eq!(decoded, rows);
    // A range past the frame's rows is corrupt.
    assert_eq!(
        decode_mz_rows(
            &payload,
            3,
            rows_len,
            &mut Resolver {
                history: &mut history,
                seq: 31,
            },
            &mut decoded,
        ),
        Err(MzError::Corrupt)
    );
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
    let rows_len = MzEncoder::default()
        .encode(&rows, 2, &[], &mut payload)
        .expect("encodes");
    let mut decoded = Vec::new();
    decode_mz_rows(&payload, 2, rows_len, &mut NoReferences, &mut decoded).expect("decodes");
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
        let mut out = Vec::new();
        if decode_mz_rows(&payload, row_count, rows_len, &mut NoReferences, &mut out).is_ok() {
            prop_assert_eq!(out.len(), rows_len);
        }
    }

    /// Every truncation and every single-byte change of a real payload is
    /// refused or decodes to exactly the declared length.
    #[test]
    fn corrupted_payloads_are_refused(at in 0usize..64, flip in 1u8..=255) {
        let row = text_row("corruption must not decode quietly", [9, 9, 9]);
        let rows = rows_of(&[(2, 0, &row), (3, 5, &row[5..20])]);
        let mut payload = Vec::new();
        let rows_len = MzEncoder::default().encode(&rows, 2, &[], &mut payload).expect("encodes");
        let mut out = Vec::new();
        let truncated = &payload[..at.min(payload.len().saturating_sub(1))];
        prop_assert!(decode_mz_rows(truncated, 2, rows_len, &mut NoReferences, &mut out).is_err());
        let mut changed = payload.clone();
        let index = at % changed.len();
        changed[index] ^= flip;
        if decode_mz_rows(&changed, 2, rows_len, &mut NoReferences, &mut out).is_ok() {
            prop_assert_eq!(out.len(), rows_len);
        }
    }
}
