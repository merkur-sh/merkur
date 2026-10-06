//! Receiver-side validation of a display frame.
//!
//! This lived privately inside `term-wasm`, which meant the browser half of the
//! display format could only be exercised through a browser. Every rejection
//! arm — a bad row range, a duplicate row, an overlong row, malformed literal
//! cells — was unreachable from a host test. It lives here now, beside the
//! encoder that produces the frames it checks, so both sides of the format have
//! one owner and the rejection arms are ordinary `cargo test` territory.
//!
//! Validation is separate from application: every independent datagram is
//! checked completely before it mutates the grid. Only reliable snapshots may
//! have multiple chunks; their owner validates every chunk before applying any.
//! Browser presentation transactions are separate from both boundaries.

use crate::{
    CellRepr, FrameHeader, cell_iter, iter_rows_at, link_spans, parse_frame_header_and_rows_start,
};

/// Receiver grid caps. A frame claiming more than this is refused before any
/// allocation is sized from it.
pub const MAX_TERMINAL_COLUMNS: usize = 512;
pub const MAX_TERMINAL_ROWS: usize = 256;
pub const MAX_TERMINAL_CELLS: usize = 96 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ValidatedDisplayRow {
    pub row_index: u16,
    pub left: u16,
    pub cells_start: usize,
    pub cells_end: usize,
    pub graphics_start: usize,
    pub graphics_end: usize,
}

/// Allocation-free limits derived from a validated fixed display header.
///
/// Receivers use this before touching a compressed row payload so a tiny zstd
/// frame cannot reserve more aggregate decoded scratch than the authenticated
/// terminal shape permits. `max_decoded_cells` is deliberately conservative:
/// every advertised row may cover the complete terminal width.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DisplayFrameValidationBounds {
    pub rows: usize,
    pub max_decoded_cells: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DisplayFrameValidationError {
    Header,
    Dimensions,
    Row,
    RowRange,
    Cell,
    RowWidth,
    PayloadShape,
    DuplicateRow,
    WrapFlagOffRowEnd,
    LinkTable,
    Graphics,
}

impl DisplayFrameValidationError {
    pub fn code(self) -> &'static str {
        match self {
            Self::Header => "display_header_invalid",
            Self::Dimensions => "display_dimensions_invalid",
            Self::Row => "display_row_invalid",
            Self::RowRange => "display_row_range_invalid",
            Self::Cell => "display_cell_invalid",
            Self::RowWidth => "display_row_width_mismatch",
            Self::PayloadShape => "display_payload_shape_invalid",
            Self::DuplicateRow => "display_duplicate_row",
            Self::WrapFlagOffRowEnd => "display_wrap_flag_off_row_end",
            Self::LinkTable => "display_link_table_invalid",
            Self::Graphics => "display_graphics_invalid",
        }
    }
}

pub fn validate_display_frame(
    data: &[u8],
    rows_out: &mut Vec<ValidatedDisplayRow>,
    cells_out: &mut Vec<CellRepr>,
    row_seen: &mut Vec<bool>,
    graphics_out: &mut Vec<merkur_graphics::projection::Fragment>,
    row_table: &mut Vec<u8>,
) -> Result<FrameHeader, DisplayFrameValidationError> {
    rows_out.clear();
    cells_out.clear();
    graphics_out.clear();

    if data.len() > crate::MAX_DISPLAY_FRAME_BYTES {
        return Err(DisplayFrameValidationError::PayloadShape);
    }

    let (header, rows_start) =
        parse_frame_header_and_rows_start(data).map_err(|_| DisplayFrameValidationError::Header)?;
    validate_display_rows(
        header,
        &data[rows_start..],
        rows_out,
        cells_out,
        row_seen,
        graphics_out,
        row_table,
    )?;
    Ok(header)
}

/// Validate a frame's row region against its already parsed fixed header.
///
/// The fixed display header stays outside zstd so the transport can route and
/// assemble a frame without decoding it, so a compressed receiver parses that
/// header from the envelope, decompresses the rows into one buffer, and passes
/// that buffer here; an uncompressed frame passes the region after its header.
/// Both therefore take the same slice path. `data` must be exactly the row
/// region: a short, overlong, or trailing-byte region is refused.
pub fn validate_display_rows(
    header: FrameHeader,
    data: &[u8],
    rows_out: &mut Vec<ValidatedDisplayRow>,
    cells_out: &mut Vec<CellRepr>,
    row_seen: &mut Vec<bool>,
    graphics_out: &mut Vec<merkur_graphics::projection::Fragment>,
    row_table: &mut Vec<u8>,
) -> Result<(), DisplayFrameValidationError> {
    rows_out.clear();
    cells_out.clear();
    graphics_out.clear();

    if data.len()
        > crate::MAX_DISPLAY_FRAME_BYTES - crate::STREAM_HEADER_BYTES - crate::FRAME_HEADER_BODY_BYTES
    {
        return Err(DisplayFrameValidationError::PayloadShape);
    }
    let bounds = validate_display_frame_header(header)?;
    let cols = usize::from(header.cols);
    let rows = bounds.rows;

    rows_out.reserve(usize::from(header.row_count));
    row_seen.clear();
    row_seen.resize(rows, false);
    let mut payload_end = 0;
    for entry in iter_rows_at(data, 0, header.row_count) {
        let entry = entry.map_err(|_| DisplayFrameValidationError::Row)?;
        if entry.offset != payload_end {
            return Err(DisplayFrameValidationError::PayloadShape);
        }
        payload_end = entry
            .offset
            .checked_add(entry.len)
            .ok_or(DisplayFrameValidationError::PayloadShape)?;

        // One row may be written at most once per frame. The daemon never
        // emits duplicates; enforcing it here prevents ambiguous writes at
        // the same sequence.
        let claimed = usize::from(entry.row_index);
        if claimed >= rows {
            return Err(DisplayFrameValidationError::RowRange);
        }
        if row_seen[claimed] {
            return Err(DisplayFrameValidationError::DuplicateRow);
        }
        row_seen[claimed] = true;

        let row = entry;

        let left = usize::from(row.left);
        let right = usize::from(row.right);
        if left > right || right >= cols {
            return Err(DisplayFrameValidationError::RowRange);
        }
        // The wrap bit belongs to the row's final cell. An entry that stops
        // short of the last column has no final cell to put it on, so a flag
        // there is malformed — and accepting it would stamp `WRAPLINE` mid-row,
        // where reflow cannot see it but the row hash can, which is divergence
        // with no way back except a resync.
        if row.wrapped && right + 1 != cols {
            return Err(DisplayFrameValidationError::WrapFlagOffRowEnd);
        }

        let expected_cells = right - left + 1;
        let Some(staged_end) = cells_out.len().checked_add(expected_cells) else {
            return Err(DisplayFrameValidationError::PayloadShape);
        };
        if staged_end > MAX_TERMINAL_CELLS {
            return Err(DisplayFrameValidationError::PayloadShape);
        }
        // A row names its colour mode in its first byte whether or not a cell
        // reads a colour. The stream splitter refuses any other value, so a row
        // it cannot represent is refused here too, before a cell is staged.
        if row.cells.first().is_some_and(|&mode| {
            mode != crate::encode::COLOR_MODE_INDEXED && mode != crate::encode::COLOR_MODE_LITERAL
        }) {
            return Err(DisplayFrameValidationError::Cell);
        }
        cells_out.reserve(expected_cells);
        let cells_start = cells_out.len();
        for cell in cell_iter(row.cells) {
            let cell = cell.map_err(|_| DisplayFrameValidationError::Cell)?;
            if cells_out.len() == staged_end {
                return Err(DisplayFrameValidationError::RowWidth);
            }
            cells_out.push(cell);
        }
        if cells_out.len() != staged_end {
            return Err(DisplayFrameValidationError::RowWidth);
        }
        // Lower the row prefix's bit back onto the cell that owns it, so an
        // applied row and a row read straight off a grid produce the same
        // `CellRepr` — and therefore the same row hash.
        if row.wrapped
            && let Some(last) = cells_out.last_mut()
        {
            last.set_wrapped(true);
        }
        // Lower link ids the same way: the table is row-scoped wire shape, the
        // id is a cell fact that diffing and hashing read per cell.
        lower_link_spans(row.links, &mut cells_out[cells_start..staged_end])?;
        let graphics_start = graphics_out.len();
        if !row.graphics.is_empty() {
            if !header.memory_only {
                return Err(DisplayFrameValidationError::Graphics);
            }
            crate::decode_graphics(
                &mut &row.graphics[..],
                row.graphics.len(),
                header.cols,
                graphics_out,
                row_table,
            )
            .map_err(|_| DisplayFrameValidationError::Graphics)?;
        }
        rows_out.push(ValidatedDisplayRow {
            row_index: row.row_index,
            left: row.left,
            cells_start,
            cells_end: staged_end,
            graphics_start,
            graphics_end: graphics_out.len(),
        });
    }
    if payload_end != data.len() {
        return Err(DisplayFrameValidationError::PayloadShape);
    }
    Ok(())
}

/// Write each span's link id onto the cells it covers, rejecting a malformed
/// table before any cell of it is trusted.
#[inline]
fn lower_link_spans(
    links: &[u8],
    cells: &mut [CellRepr],
) -> Result<(), DisplayFrameValidationError> {
    for span in link_spans(links, cells.len()) {
        let span = span.map_err(|_| DisplayFrameValidationError::LinkTable)?;
        let start = usize::from(span.offset);
        for cell in &mut cells[start..start + usize::from(span.len)] {
            cell.link = span.link;
        }
    }
    Ok(())
}

/// Validate only the fixed header and return conservative decode bounds.
///
/// This performs no allocation and reads no row payload. It is therefore safe
/// to call before constructing a decompressor or retaining a staging slot.
pub fn validate_display_frame_header(
    header: FrameHeader,
) -> Result<DisplayFrameValidationBounds, DisplayFrameValidationError> {
    let cols = usize::from(header.cols);
    let rows = usize::from(header.rows);
    let Some(cell_count) = cols.checked_mul(rows) else {
        return Err(DisplayFrameValidationError::Dimensions);
    };
    if cols == 0
        || rows == 0
        || cols > MAX_TERMINAL_COLUMNS
        || rows > MAX_TERMINAL_ROWS
        || cell_count > MAX_TERMINAL_CELLS
    {
        return Err(DisplayFrameValidationError::Dimensions);
    }
    if header.chunk_count == 0
        || header.chunk_index >= header.chunk_count
        || usize::from(header.row_count) > rows
    {
        return Err(DisplayFrameValidationError::Header);
    }
    let max_decoded_cells = usize::from(header.row_count)
        .checked_mul(cols)
        .ok_or(DisplayFrameValidationError::Dimensions)?;
    Ok(DisplayFrameValidationBounds {
        rows,
        max_decoded_cells,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{FrameKind, RowRef, STREAM_HEADER_BYTES, encode_frame_into};

    struct Scratch {
        rows: Vec<ValidatedDisplayRow>,
        cells: Vec<CellRepr>,
        row_seen: Vec<bool>,
    }

    impl Scratch {
        fn new() -> Self {
            Self {
                rows: Vec::new(),
                cells: Vec::new(),
                row_seen: Vec::new(),
            }
        }
        fn run(&mut self, frame: &[u8]) -> Result<FrameHeader, DisplayFrameValidationError> {
            validate_display_frame(
                frame,
                &mut self.rows,
                &mut self.cells,
                &mut self.row_seen,
                &mut Vec::new(),
                &mut Vec::new(),
            )
        }
    }

    fn frame(cols: u16, rows: u16, entries: &[RowRef<'_>]) -> Vec<u8> {
        let mut out = vec![0u8; STREAM_HEADER_BYTES];
        let header = FrameHeader {
            memory_only: false,
            kind: FrameKind::Delta,
            cols,
            rows,
            cursor_col: 0,
            cursor_row: 0,
            cursor_shape: 0,
            cursor_visible: 1,
            mode_flags: 0,
            row_count: entries.len() as u16,
            frame_id: 1,
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
        encode_frame_into(&mut out, &header, entries.iter().cloned());
        out
    }

    fn cells(text: &str) -> Vec<CellRepr> {
        text.chars()
            .map(|ch| CellRepr {
                codepoint: ch as u32,
                ..CellRepr::BLANK
            })
            .collect()
    }

    #[test]
    fn explicit_default_background_survives_the_frame_and_row_region_paths_and_rle() {
        use crate::{CellAttrs, encoded_cells_size, parse_frame_header_and_rows_start, row_hash};

        let implicit = CellRepr {
            codepoint: ' ' as u32,
            ..CellRepr::BLANK
        };
        let explicit = CellRepr {
            attrs: CellAttrs::EXPLICIT_DEFAULT_BG,
            ..implicit
        };
        // The all-default row retains its existing one-byte mode, tag, glyph,
        // and RLE count. An explicit default uses the existing color token.
        assert_eq!(encoded_cells_size(&[implicit; 120]), 4);
        assert!(encoded_cells_size(&[explicit; 120]) > 4);
        for literal_colors in [false, true] {
            let mut cells = vec![implicit; 120];
            cells[8..32].fill(explicit);
            cells[32..64].fill(CellRepr {
                link: 9,
                ..explicit
            });
            if literal_colors {
                // Dominant truecolor cells force the other row color encoding.
                for (index, cell) in cells[64..].iter_mut().enumerate() {
                    cell.fg = [index as u8, 137, 241];
                    cell.bg = [67, index as u8, 139];
                }
            }
            let data = frame(
                120,
                1,
                &[RowRef {
                    graphics: &[],
                    row_index: 0,
                    left: 0,
                    cells: &cells,
                }],
            );
            let mut scratch = Scratch::new();
            scratch.run(&data).unwrap();
            assert_eq!(scratch.cells, cells);
            assert_eq!(row_hash(&scratch.cells), row_hash(&cells));
            let (header, offset) = parse_frame_header_and_rows_start(&data).unwrap();
            validate_display_rows(
                header,
                &data[offset..],
                &mut scratch.rows,
                &mut scratch.cells,
                &mut scratch.row_seen,
                &mut Vec::new(),
                &mut Vec::new(),
            )
            .unwrap();
            assert_eq!(scratch.cells, cells);
            assert_eq!(row_hash(&scratch.cells), row_hash(&cells));
        }
    }

    /// A well-formed frame validates, and reports what it carried.
    ///
    /// The control for everything below: without it, a validator that rejected
    /// everything would pass every rejection test in this module.
    #[test]
    fn a_well_formed_frame_validates() {
        let row = cells("hello");
        let encoded = frame(
            8,
            2,
            &[RowRef {
                graphics: &[],
                row_index: 0,
                left: 0,
                cells: &row,
            }],
        );
        let mut scratch = Scratch::new();
        let header = scratch.run(&encoded).expect("valid frame");
        assert_eq!(header.cols, 8);
        assert_eq!(header.rows, 2);
        assert_eq!(scratch.rows.len(), 1);
        assert_eq!(scratch.cells.len(), row.len());
    }

    #[test]
    fn presentation_advisories_never_gate_grid_validation() {
        let row = cells("hello");
        let mut encoded = frame(
            8,
            2,
            &[RowRef {
                graphics: &[],
                row_index: 0,
                left: 0,
                cells: &row,
            }],
        );
        encoded[crate::DISPLAY_PATCH_FLAGS_OFFSET] |= crate::PATCH_FLAG_PRESENTATION_COHERENT;
        for (index, count) in [(0u16, 0u16), (u16::MAX, 0), (2, 1), (0, u16::MAX)] {
            encoded[crate::DISPLAY_PRESENTATION_MEMBER_INDEX_OFFSET
                ..crate::DISPLAY_PRESENTATION_MEMBER_INDEX_OFFSET + 2]
                .copy_from_slice(&index.to_be_bytes());
            encoded[crate::DISPLAY_PRESENTATION_MEMBER_COUNT_OFFSET
                ..crate::DISPLAY_PRESENTATION_MEMBER_COUNT_OFFSET + 2]
                .copy_from_slice(&count.to_be_bytes());
            let mut scratch = Scratch::new();
            let header = scratch
                .run(&encoded)
                .expect("only presentation timing is uncertain");
            assert_eq!(header.presentation_member_index, index);
            assert_eq!(header.presentation_member_count, count);
            assert_eq!(scratch.cells, row);
        }
        for predecessor in [0u32, 1, 0x8000_0001, u32::MAX] {
            encoded[crate::DISPLAY_ROW_PREDECESSOR_PRESENTATION_ID_OFFSET
                ..crate::DISPLAY_ROW_PREDECESSOR_PRESENTATION_ID_OFFSET + 4]
                .copy_from_slice(&predecessor.to_be_bytes());
            let mut scratch = Scratch::new();
            let header = scratch
                .run(&encoded)
                .expect("lineage is timing advice only");
            assert_eq!(header.row_predecessor_presentation_id, predecessor);
            assert_eq!(scratch.cells, row);
        }
    }

    #[test]
    fn fixed_header_validation_returns_a_conservative_allocation_bound() {
        let row = cells("hello");
        let encoded = frame(
            512,
            192,
            &[RowRef {
                graphics: &[],
                row_index: 0,
                left: 0,
                cells: &row,
            }],
        );
        let (header, _) = parse_frame_header_and_rows_start(&encoded).unwrap();
        assert_eq!(
            validate_display_frame_header(header),
            Ok(DisplayFrameValidationBounds {
                rows: 192,
                max_decoded_cells: 512,
            })
        );

        let mut malformed = header;
        malformed.row_count = 193;
        assert_eq!(
            validate_display_frame_header(malformed),
            Err(DisplayFrameValidationError::Header)
        );
    }

    /// A row past the frame's own row count is refused.
    ///
    /// This arm, and every arm below, was previously reachable only from a
    /// browser: the validator was private to term-wasm.
    #[test]
    fn a_row_outside_the_grid_is_refused() {
        let row = cells("x");
        let encoded = frame(
            8,
            2,
            &[RowRef {
                graphics: &[],
                row_index: 9,
                left: 0,
                cells: &row,
            }],
        );
        let mut scratch = Scratch::new();
        assert_eq!(
            scratch.run(&encoded),
            Err(DisplayFrameValidationError::RowRange)
        );
    }

    /// A row whose cells run past the last column is refused, not clipped.
    ///
    /// The validator reports this as `RowRange` rather than `RowWidth`: the
    /// span check fires before the width check. Asserting the exact arm, rather
    /// than merely "some error", is what makes this test able to notice if the
    /// two ever swap and a receiver starts reporting the wrong cause.
    #[test]
    fn a_row_running_past_the_last_column_is_refused() {
        let row = cells("far too wide for four columns");
        let encoded = frame(
            4,
            2,
            &[RowRef {
                graphics: &[],
                row_index: 0,
                left: 0,
                cells: &row,
            }],
        );
        let mut scratch = Scratch::new();
        assert_eq!(
            scratch.run(&encoded),
            Err(DisplayFrameValidationError::RowRange)
        );
    }

    /// The same row twice in one frame is refused: the second write would
    /// silently win, and which one is correct is undefined.
    #[test]
    fn a_duplicate_row_is_refused() {
        let row = cells("ab");
        let encoded = frame(
            8,
            2,
            &[
                RowRef {
                    graphics: &[],
                    row_index: 1,
                    left: 0,
                    cells: &row,
                },
                RowRef {
                    graphics: &[],
                    row_index: 1,
                    left: 2,
                    cells: &row,
                },
            ],
        );
        let mut scratch = Scratch::new();
        assert_eq!(
            scratch.run(&encoded),
            Err(DisplayFrameValidationError::DuplicateRow)
        );
    }

    /// A truncated frame is refused at the header rather than read past.
    #[test]
    fn a_truncated_frame_is_refused() {
        let row = cells("hello");
        let encoded = frame(
            8,
            2,
            &[RowRef {
                graphics: &[],
                row_index: 0,
                left: 0,
                cells: &row,
            }],
        );
        let mut scratch = Scratch::new();
        for len in 0..encoded.len() {
            assert!(
                scratch.run(&encoded[..len]).is_err(),
                "a {len}-byte prefix of a {}-byte frame validated",
                encoded.len()
            );
        }
    }

    /// Every rejection carries a distinct code, so a receiver can report which
    /// arm fired rather than a generic failure.
    /// The wrap bit costs nothing on the wire and comes back on the cell that
    /// owns it, so a row read off a grid and the same row applied from a frame
    /// hash identically. That equality is the whole reason the bit is in the
    /// hash at all.
    #[test]
    fn a_wrapped_row_round_trips_onto_its_final_cell_for_free() {
        let mut row = cells("wrapped");
        let plain = frame(
            7,
            2,
            &[RowRef {
                graphics: &[],
                row_index: 0,
                left: 0,
                cells: &row,
            }],
        );
        row.last_mut().expect("row is not empty").set_wrapped(true);
        let wrapped = frame(
            7,
            2,
            &[RowRef {
                graphics: &[],
                row_index: 0,
                left: 0,
                cells: &row,
            }],
        );
        assert_eq!(wrapped.len(), plain.len(), "the wrap bit cost bytes");

        let mut scratch = Scratch::new();
        scratch.run(&wrapped).expect("frame validates");
        assert_eq!(scratch.cells, row);
        assert!(scratch.cells.last().is_some_and(|cell| cell.wrapped()));

        scratch.run(&plain).expect("frame validates");
        assert!(scratch.cells.iter().all(|cell| !cell.wrapped()));
    }

    /// A wrap bit on a span that stops short of the last column would stamp
    /// `WRAPLINE` on a cell reflow never reads but the row hash does — a
    /// divergence with no exit but a resync. The encoder refuses to write one
    /// and the receiver refuses to accept one.
    #[test]
    fn a_wrap_flag_that_misses_the_last_column_is_refused_at_both_ends() {
        let mut row = cells("mid");
        row.last_mut().expect("row is not empty").set_wrapped(true);
        let entries = [RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &row,
        }];
        let header = FrameHeader {
            memory_only: false,
            kind: FrameKind::Delta,
            cols: 8,
            rows: 2,
            cursor_col: 0,
            cursor_row: 0,
            cursor_shape: 0,
            cursor_visible: 1,
            mode_flags: 0,
            row_count: 1,
            frame_id: 1,
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
        let mut checked = vec![0u8; STREAM_HEADER_BYTES];
        assert_eq!(
            crate::try_encode_frame_into(&mut checked, &header, entries.iter().cloned()),
            Err(crate::EncodeError::WrapFlagOffRowEnd),
        );

        // The unchecked encoder is the daemon's hot path and does not pay for
        // that test, so the receiver has to make the same call on its own.
        let forged = frame(8, 2, &entries);
        assert_eq!(
            Scratch::new().run(&forged),
            Err(DisplayFrameValidationError::WrapFlagOffRowEnd),
        );
    }

    #[test]
    fn every_rejection_has_its_own_code() {
        let all = [
            DisplayFrameValidationError::Header,
            DisplayFrameValidationError::Dimensions,
            DisplayFrameValidationError::Row,
            DisplayFrameValidationError::RowRange,
            DisplayFrameValidationError::Cell,
            DisplayFrameValidationError::RowWidth,
            DisplayFrameValidationError::PayloadShape,
            DisplayFrameValidationError::DuplicateRow,
            DisplayFrameValidationError::WrapFlagOffRowEnd,
            DisplayFrameValidationError::LinkTable,
            DisplayFrameValidationError::Graphics,
        ];
        let mut codes: Vec<&str> = all.iter().map(|error| error.code()).collect();
        codes.sort_unstable();
        let unique = codes.len();
        codes.dedup();
        assert_eq!(codes.len(), unique, "two rejection arms share a code");
    }
}
