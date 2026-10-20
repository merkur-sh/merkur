use super::*;
use crate::{
    CellAttrs, CellRepr, FrameHeader, FrameKind, RowRef, encode_frame_into, iter_rows,
    validate_display_frame,
};
use proptest::prelude::*;

const COLS: u16 = 40;

fn header(row_count: u16) -> FrameHeader {
    FrameHeader {
        memory_only: false,
        kind: FrameKind::Delta,
        cols: COLS,
        rows: 24,
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
        &header(entries.len() as u16),
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
        .map(|i| cell('#', [i as u8 * 6, 200, 17], [3, i as u8, 9]))
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
    let section: Vec<u8> = (0..300u32).map(|i| (i * 7 + i / 13) as u8).collect();
    rows.extend_from_slice(&(section.len() as u32).to_be_bytes());
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
fn references_rebuild_the_row_the_receiver_applied_and_are_taken_only_when_smaller() {
    let mut history = RowHistory::default();
    let original = text_row(
        "fn main() { println!(\"hello, world\"); }",
        [0xa6, 0xe3, 0xa1],
    );
    // Seq 10 wrote the full row at row 5; seq 11 changed a span of it.
    history.record(10, 5, 0, &original, COLS);
    let mut edited = original.clone();
    for (offset, c) in "goodbye".chars().enumerate() {
        edited[22 + offset].codepoint = u32::from(c);
    }
    history.record(11, 5, 22, &edited[22..29], COLS);
    // Seq 12 moves the edited row to row 4: a reference to (11, 5).
    let rows = rows_of(&[(4, 0, &edited)]);
    let reference = MzReference {
        seq_delta: 1,
        source_row: 5,
        hash: reference_hash(&edited),
        full_row_bytes: full_row_entry_bytes(&edited) as u32,
    };
    let mut payload = Vec::new();
    let rows_len = MzEncoder::default()
        .encode(&rows, 1, &[Some(reference)], &mut payload)
        .expect("encodes");
    assert_eq!(
        rows_len,
        rows.len(),
        "the reference is a full row, as the literal is"
    );
    let literal_only = MzEncoder::default()
        .encode(&rows, 1, &[], &mut Vec::new())
        .expect("encodes");
    assert_eq!(literal_only, rows.len());
    assert!(
        payload.len() < 12,
        "a reference codes in a handful of bytes: {}",
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

    // A short literal is cheaper than any reference, and is kept.
    let short = rows_of(&[(4, 0, &edited[..1])]);
    let mut payload = Vec::new();
    let rows_len = MzEncoder::default()
        .encode(
            &short,
            1,
            &[Some(MzReference {
                full_row_bytes: 999,
                ..reference
            })],
            &mut payload,
        )
        .expect("encodes");
    assert_eq!(rows_len, short.len());
}

#[test]
fn a_reference_the_receiver_cannot_rebuild_exactly_is_refused() {
    let mut history = RowHistory::default();
    let row = text_row(
        "the daemon believes this row arrived",
        crate::DEFAULT_FOREGROUND,
    );
    history.record(20, 2, 0, &row, COLS);
    let reference = |hash, seq_delta| MzReference {
        seq_delta,
        source_row: 2,
        hash,
        full_row_bytes: full_row_entry_bytes(&row) as u32,
    };
    let rows = rows_of(&[(3, 0, &row)]);
    let mut out = Vec::new();
    for (bad, seq) in [
        (reference(reference_hash(&row) ^ 1, 1), 21),
        (reference(reference_hash(&row), 2), 21),
    ] {
        let mut payload = Vec::new();
        let rows_len = MzEncoder::default()
            .encode(&rows, 1, &[Some(bad)], &mut payload)
            .expect("encodes");
        assert_eq!(
            decode_mz_rows(
                &payload,
                1,
                rows_len,
                &mut Resolver {
                    history: &mut history,
                    seq,
                },
                &mut out,
            ),
            Err(MzError::Unresolved)
        );
    }
}

#[test]
fn history_rebuilds_rows_in_apply_order_across_retirement() {
    let mut history = RowHistory::default();
    let mut expected = text_row("0123456789", crate::DEFAULT_FOREGROUND);
    history.record(1, 0, 0, &expected, COLS);
    // Many span updates, enough to retire the anchor and every early record.
    let updates = MZ_HISTORY_DATAGRAMS + 300;
    for seq in 2..updates {
        let column = (seq % 30) as usize;
        expected[column].codepoint = u32::from(b'a' + (seq % 26) as u8);
        history.record(seq, 0, column as u16, &expected[column..column + 1], COLS);
    }
    let last = updates - 1;
    let mut out = Vec::new();
    history
        .resolve(
            last + 1,
            7,
            MzReference {
                seq_delta: 1,
                source_row: 0,
                hash: reference_hash(&expected),
                full_row_bytes: 0,
            },
            &mut out,
        )
        .expect("the newest version rebuilds after its anchor retired");
    let mut want = Vec::new();
    encode_full_row_entry(&mut want, 7, &expected);
    assert_eq!(out, want);
    // A span per datagram, and a complete row at most every 33 spans.
    assert!(history.held_cells() <= 3 * MZ_HISTORY_DATAGRAMS as usize);
    // A retired record no longer resolves.
    assert_eq!(
        history.resolve(
            last + 1,
            7,
            MzReference {
                seq_delta: MZ_REFERENCE_DATAGRAMS,
                source_row: 0,
                hash: 0,
                full_row_bytes: 0,
            },
            &mut Vec::new(),
        ),
        Err(MzError::Unresolved)
    );
}

#[test]
fn an_invalidated_row_does_not_resolve_until_it_is_written_whole() {
    let mut history = RowHistory::default();
    let row = text_row("abc", crate::DEFAULT_FOREGROUND);
    history.record(1, 0, 0, &row, COLS);
    history.invalidate_row(0);
    history.record(2, 0, 1, &row[1..2], COLS);
    let reference = MzReference {
        seq_delta: 1,
        source_row: 0,
        hash: reference_hash(&row),
        full_row_bytes: 0,
    };
    assert_eq!(
        history.resolve(3, 1, reference, &mut Vec::new()),
        Err(MzError::Unresolved)
    );
    history.record(3, 0, 0, &row, COLS);
    assert_eq!(history.resolve(4, 1, reference, &mut Vec::new()), Ok(()));
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
    let body_len = (frame.len() - crate::STREAM_HEADER_BYTES) as u32;
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
