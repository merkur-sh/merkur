use super::*;
use crate::{CellAttrs, CellRepr, FrameHeader, FrameKind, PreparedGraphics, PreparedRowRef};

fn header(row_count: u16) -> FrameHeader {
    FrameHeader {
        memory_only: false,
        kind: FrameKind::Delta,
        cols: u16::try_from(crate::MAX_TERMINAL_COLUMNS).unwrap(),
        rows: 40,
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

fn cells(width: u16, shape: u8) -> Vec<CellRepr> {
    (0..width)
        .map(|col| {
            let mut cell = CellRepr::BLANK;
            match shape {
                0 => {}
                1 => cell.codepoint = 0x20 + u32::from(col % 95),
                2 => {
                    cell.codepoint = 0x20 + u32::from(col % 95);
                    cell.fg = [17, col.to_le_bytes()[0], 53];
                    cell.bg = [31, 73, col.to_le_bytes()[0]];
                    cell.attrs = CellAttrs::BOLD;
                }
                3 => cell.codepoint = 0x410 + u32::from(col % 32),
                4 => cell.codepoint = 0x10000 + u32::from(col % 256),
                5..=7 => {
                    cell.codepoint = 0x20 + u32::from(col % 95);
                    if shape == 5 && col == 0 || shape == 6 && col + 1 == width || shape == 7 {
                        cell.link = 9;
                    }
                }
                8 => {
                    cell.codepoint = if col % 2 == 0 { u32::from('界') } else { 0 };
                    cell.attrs = CellAttrs::NONE.with(CellAttrs::WIDE, col % 2 == 0);
                }
                _ => {}
            }
            if col + 1 == width {
                cell.attrs = cell.attrs.with(CellAttrs::WRAPPED, true);
            }
            cell
        })
        .collect()
}

fn compare(
    prepared: &mut MzEncoder,
    parsed: &mut MzEncoder,
    lines: &[&[CellRepr]],
    graphics: &PreparedGraphics,
    history: &impl MzMatches,
    session: Option<(u8, &SessionModel)>,
    declaration: Option<&MzEpochDeclaration>,
) -> MzEncoded {
    let header = header(u16::try_from(lines.len()).unwrap());
    let rows = || {
        lines
            .iter()
            .enumerate()
            .map(|(index, cells)| PreparedRowRef {
                row_index: u16::try_from(index).unwrap(),
                left: 0,
                cells,
                encoding: crate::plan_cell_encoding(cells).1,
                graphics,
            })
    };
    let mut raw = Vec::new();
    let metadata = prepared.encode_prepared_frame_into(&mut raw, &header, rows());
    let mut reference = Vec::new();
    crate::encode_prepared_frame_into(&mut reference, &header, rows());
    assert_eq!(raw, reference);
    let rows = &raw[crate::STREAM_HEADER_BYTES + crate::FRAME_HEADER_BODY_BYTES..];
    let mut expected = vec![31, 41];
    let mut actual = expected.clone();
    let baseline = parsed
        .encode_rows(
            rows,
            header.row_count,
            history,
            session,
            declaration,
            &mut expected,
        )
        .unwrap();
    let result = prepared
        .encode_prepared(rows, metadata, history, session, declaration, &mut actual)
        .unwrap();
    assert_eq!(actual, expected);
    assert_eq!(result, baseline);
    assert_eq!(prepared.trace(), parsed.trace());
    assert_eq!(prepared.row_costs(), parsed.row_costs());
    result
}

#[test]
fn emitted_items_match_parsed_frames_and_reuse_storage() {
    let mut prepared = MzEncoder::default();
    let mut parsed = MzEncoder::default();
    for width in [1, 8, 40, 120, 384, 512] {
        for shape in 0..=8 {
            let line = cells(width, shape);
            let short = &line[..line.len().min(8)];
            for lines in [
                vec![],
                vec![line.as_slice()],
                vec![line.as_slice(), short, line.as_slice()],
            ] {
                compare(
                    &mut prepared,
                    &mut parsed,
                    &lines,
                    &PreparedGraphics::default(),
                    &NoHistory,
                    None,
                    None,
                );
                assert_eq!(
                    prepared.frame.items.capacity(),
                    parsed.frame.items.capacity()
                );
                assert_eq!(
                    prepared.entry_items.capacity(),
                    parsed.entry_items.capacity()
                );
            }
        }
    }
}

#[test]
fn emitted_items_survive_both_session_prior_trials() {
    let mut prepared = MzEncoder::default();
    let mut parsed = MzEncoder::default();
    let mut session = SessionModel::default();
    let training = cells(120, 3);
    compare(
        &mut prepared,
        &mut parsed,
        &[&training, &training],
        &PreparedGraphics::default(),
        &NoHistory,
        None,
        None,
    );
    for _ in 0..64 {
        session.fold(parsed.trace());
    }
    let declaration = MzEpochDeclaration {
        id: 2,
        base: 1,
        first: 1,
        datagrams: 3,
    };
    let (mut session_wins, mut static_wins, mut trials, mut retained_trials) = (0, 0, 0, 0);
    for shape in 0..=8 {
        let line = cells(120, shape);
        for width in [1, 8, 120] {
            let line = &line[..width];
            parsed.trial.clear();
            let result = compare(
                &mut prepared,
                &mut parsed,
                &[line, line, line],
                &PreparedGraphics::default(),
                &NoHistory,
                Some((1, &session)),
                Some(&declaration),
            );
            if result.prior == 0 {
                static_wins += 1;
            } else {
                session_wins += 1;
            }
            trials += usize::from(!parsed.trial.is_empty());
            retained_trials += usize::from(!parsed.trial.is_empty() && result.prior != 0);
        }
    }
    assert!(session_wins > 0);
    assert!(static_wins > 0);
    assert!(trials > 0);
    assert!(retained_trials > 0);
}

struct History<'a>(MzRow<'a>);

impl MzMatches for History<'_> {
    fn candidates(&self, pair: u64, mut visit: impl FnMut(MzCandidate, MzRow<'_>) -> bool) {
        for item in 0..self.0.items.len().saturating_sub(1) {
            if pair_hash(self.0.hashes[item], self.0.hashes[item + 1]) == pair
                && !visit(
                    MzCandidate {
                        previous: false,
                        back: 1,
                        row: 3,
                        item: u16::try_from(item).unwrap(),
                    },
                    self.0,
                )
            {
                break;
            }
        }
    }
}

#[test]
fn emitted_items_preserve_acknowledged_history_copies() {
    let line = cells(120, 1);
    let mut entry = Vec::new();
    encode_full_row_entry(&mut entry, 3, &line);
    let mut items = Vec::new();
    let (first, mode) = entry_items(&entry, &mut items).unwrap();
    let mut row = MzRow {
        entry: &entry,
        first,
        items: &items,
        mode,
        hashes: &[],
    };
    let hashes: Vec<_> = (0..items.len())
        .map(|item| item_hash(row.item_bytes(item).unwrap()))
        .collect();
    row.hashes = &hashes;
    let mut prepared = MzEncoder::default();
    let mut parsed = MzEncoder::default();
    let result = compare(
        &mut prepared,
        &mut parsed,
        &[&line, &line],
        &PreparedGraphics::default(),
        &History(row),
        None,
        None,
    );
    assert!(result.history_copies);
}

#[test]
fn emitted_items_preserve_graphics_sections() {
    use merkur_graphics::budget::{Budget, Usage};
    use merkur_graphics::geometry::{CELL_UNIT, RowSlice};
    use merkur_graphics::projection::{Fragment, Stack};
    use merkur_graphics::source::SourceManifest;

    let pixels =
        merkur_graphics::processing::Pixels::new(1, 1, vec![20, 40, 60, 255].into_boxed_slice())
            .unwrap();
    let fragment = Fragment {
        content: SourceManifest::from_pixels(&pixels).content(),
        stack: Stack {
            z: -1,
            image_id: 1,
            placement: 1,
        },
        slice: RowSlice {
            left: 0,
            right: CELL_UNIT,
            top: 0,
            bottom: CELL_UNIT,
            source_left: 0,
            source_right: CELL_UNIT,
            source_top: 0,
            source_bottom: CELL_UNIT,
        },
    };
    let (graphics, _charge) = PreparedGraphics::new(
        &Budget::new(Usage {
            bytes: 4096,
            objects: 4,
        }),
        header(1).cols,
        &[fragment],
        &mut Default::default(),
    )
    .unwrap();
    let mut prepared = MzEncoder::default();
    let mut parsed = MzEncoder::default();
    for shape in 0..=8 {
        let line = cells(120, shape);
        compare(
            &mut prepared,
            &mut parsed,
            &[&line, &line, &line],
            &graphics,
            &NoHistory,
            None,
            None,
        );
    }
}
