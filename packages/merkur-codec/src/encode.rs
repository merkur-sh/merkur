use crate::cell::{CellRepr, HAS_BG, HAS_FG, RLE};
use crate::varint::encode_varint_u32;
use crate::{
    LINK_SPAN_BYTES, LINK_TABLE_COUNT_BYTES, PATCH_FLAG_RESET, ROW_CELL_COUNT_MASK, ROW_FLAG_LINKS,
    ROW_FLAG_WRAPPED, STREAM_HEADER_BYTES, VERSION,
};

#[inline]
fn write_u32(out: &mut Vec<u8>, value: u32) {
    out.extend_from_slice(&value.to_be_bytes());
}

/// Wire sentinel for "this cell uses the terminal's default colors", which lets
/// the tag omit six RGB bytes per cell.
///
/// These MUST equal the colors `theme::resolve_color` produces for
/// `NamedColor::Foreground`/`NamedColor::Background`. An unstyled cell — the
/// overwhelming majority of every terminal screen — is what the omission is for,
/// and it only ever matches when these two definitions of "default" agree.
pub const DEFAULT_FG: [u8; 3] = crate::theme::DEFAULT_FOREGROUND;
pub const DEFAULT_BG: [u8; 3] = crate::theme::DEFAULT_BACKGROUND;

/// Per-row color representation: the first byte of every row payload, applying
/// to every color in that row.
///
/// A discriminant carried per *cell* costs a byte on every colored cell, which
/// is a measured regression for 24-bit color. Carrying it per row costs one byte
/// per row instead.
///
/// It is written unconditionally, including for rows that have no colors at all.
/// Emitting it lazily — immediately before a row's first color, so unstyled rows
/// paid nothing — was tried and measured **worse**: rows are highly similar to
/// one another, and a byte at an offset that varies per row shifts their
/// payloads out of alignment and shortens the cross-row matches the compressor
/// depends on. A fixed offset is worth more than the byte it costs.
pub const COLOR_MODE_INDEXED: u8 = 0;
pub const COLOR_MODE_LITERAL: u8 = 1;

/// In [`COLOR_MODE_INDEXED`], this index escapes to a literal 24-bit color in
/// the three bytes that follow, so a row that is mostly palette colors does not
/// have to abandon indices for the sake of one true color.
///
/// It costs palette slot 255 a byte — that slot encodes as an escaped literal —
/// which is the whole price of making the other 255 slots cost a third of what
/// a literal does.
pub const COLOR_LITERAL_ESCAPE: u8 = 0xff;

/// Whether the terminal's palette can produce `color` in a single index byte.
#[inline]
fn is_palette_color(color: [u8; 3]) -> bool {
    matches!(crate::theme::indexed_color_for(color), Some(index) if index != COLOR_LITERAL_ESCAPE)
}

/// Write one non-default color. Returns whether it was written as a palette
/// index, which is what the caller counts to decide the row's mode.
#[inline]
fn encode_color(out: &mut Vec<u8>, color: [u8; 3], literal_mode: bool) -> bool {
    if !literal_mode {
        if let Some(index) = crate::theme::indexed_color_for(color)
            && index != COLOR_LITERAL_ESCAPE
        {
            out.push(index);
            return true;
        }
        out.push(COLOR_LITERAL_ESCAPE);
    }
    out.extend_from_slice(&color);
    false
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum FrameKind {
    Snapshot = 0x01,
    Delta = 0x02,
}

impl FrameKind {
    #[inline]
    pub fn patch_flags(self) -> u8 {
        match self {
            Self::Snapshot => PATCH_FLAG_RESET,
            Self::Delta => 0,
        }
    }

    #[inline]
    pub fn from_patch_flags(flags: u8) -> Self {
        if flags & PATCH_FLAG_RESET != 0 {
            Self::Snapshot
        } else {
            Self::Delta
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FrameHeader {
    pub kind: FrameKind,
    /// Prevent disk persistence. The encoder also sets this for every graphics row.
    pub memory_only: bool,
    pub cols: u16,
    pub rows: u16,
    pub cursor_col: u16,
    pub cursor_row: u16,
    pub cursor_shape: u8,
    pub cursor_visible: u8,
    pub mode_flags: u16,
    pub row_count: u16,
    pub frame_id: u32,
    /// Presentation-only transaction identity. It never participates in frame
    /// assembly, ordering, application, acknowledgement, loss, or repair.
    pub presentation_id: u32,
    /// Timing-only metadata. Zero count means completion is unknown. Neither
    /// invalid indices nor missing members make a grid transformation invalid.
    pub presentation_member_index: u16,
    pub presentation_member_count: u16,
    /// Presentation-only row dependency. Zero permits an independent/root
    /// presentation, never a different grid application or ACK decision.
    pub row_predecessor_presentation_id: u32,
    pub presentation_coherent: bool,
    pub presentation_end: bool,
    pub chunk_index: u16,
    pub chunk_count: u16,
    /// The browser display grant this state consumed. Repairs, continuations
    /// and grant-exempt frames repeat the newest consumed serial; zero before
    /// the generation's first admitted state.
    pub demand_serial: u32,
    /// See [`crate::PATCH_FLAG_DEMAND_LIMITED`].
    pub demand_limited: bool,
    /// See [`crate::PATCH_FLAG_DEMAND_PROMPT`].
    pub demand_prompt: bool,
    /// See [`crate::PATCH_FLAG_DEMAND_AWAITS_GRANT`].
    pub demand_awaits_grant: bool,
    /// The complete application frame this capture is, as
    /// [`crate::viewport_closure_digest`] names it: stamped only on a capture
    /// taken exactly at an explicit synchronized-update end. Zero claims
    /// nothing and leaves presentation to the ordinary hold.
    pub closure_digest: u64,
    /// Single-line scrolls of the whole screen the terminal had made when it
    /// was captured, wrapping. Between two states the difference is how far
    /// every row's content moved up; a scroll region is not counted.
    pub scroll_serial: u32,
    /// The newest input of this frame's peer the daemon had queued for the
    /// PTY before the last output this capture applied, in the peer's input
    /// sequence space; zero when there is none. The capture cannot show any
    /// program's answer to a later input: that input had not reached the PTY
    /// when the output it shows was produced. Written once at capture; a
    /// re-send of the same state carries it unchanged.
    pub echo_horizon: u32,
}

#[derive(Clone, Copy)]
pub struct RowRef<'a> {
    pub row_index: u16,
    pub left: u16,
    pub cells: &'a [CellRepr],
    pub graphics: &'a [merkur_graphics::projection::Fragment],
}

#[derive(Clone, Copy)]
pub struct PreparedRowRef<'a> {
    pub row_index: u16,
    pub left: u16,
    pub cells: &'a [CellRepr],
    pub encoding: CellEncoding,
    pub graphics: &'a crate::PreparedGraphics,
}

struct EncodingRow<'a, G> {
    row_index: u16,
    left: u16,
    cells: &'a [CellRepr],
    encoding: Option<CellEncoding>,
    graphics: G,
}

trait GraphicsSource {
    fn is_empty(&self) -> bool;
    fn append(
        self,
        out: &mut Vec<u8>,
        columns: u16,
        scratch: &mut crate::GraphicsEncodeScratch,
    ) -> Result<(), EncodeError>;
}

impl GraphicsSource for &[merkur_graphics::projection::Fragment] {
    fn is_empty(&self) -> bool {
        <[merkur_graphics::projection::Fragment]>::is_empty(self)
    }
    fn append(
        self,
        out: &mut Vec<u8>,
        columns: u16,
        scratch: &mut crate::GraphicsEncodeScratch,
    ) -> Result<(), EncodeError> {
        crate::encode_graphics(out, columns, self, scratch)
            .map_err(|_| EncodeError::InvalidGraphics)
    }
}

impl GraphicsSource for &crate::PreparedGraphics {
    fn is_empty(&self) -> bool {
        crate::PreparedGraphics::is_empty(self)
    }
    fn append(
        self,
        out: &mut Vec<u8>,
        columns: u16,
        _: &mut crate::GraphicsEncodeScratch,
    ) -> Result<(), EncodeError> {
        if !self.fits_columns(columns) {
            return Err(EncodeError::InvalidGraphics);
        }
        out.extend_from_slice(self.bytes());
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EncodeError {
    RowCountMismatch,
    WrapFlagOffRowEnd,
    EmptyRow,
    RowRangeOverflow,
    TooManyCells,
    RowPayloadTooLarge,
    InvalidCodepoint,
    InvalidGraphics,
}

/// The row prefix's `cell_count` field for one span of cells, with
/// [`ROW_FLAG_WRAPPED`] folded into its spare top bit.
///
/// One owner for the derivation, because there is more than one row encoder:
/// [`encode_frame_into`] builds a whole frame, and the daemon's snapshot path
/// writes row prefixes directly into a reused buffer. A span carries the flag
/// exactly when its final cell does, which is exactly when the span reaches the
/// row's last column — the only cell the bit can live on.
#[inline]
pub fn row_cell_count_field(cells: &[CellRepr]) -> u16 {
    let count = cells.len() as u16;
    if cells.last().is_some_and(CellRepr::wrapped) {
        count | ROW_FLAG_WRAPPED
    } else {
        count
    }
}

/// The row prefix's `left` field for one span of cells, with
/// [`ROW_FLAG_LINKS`] folded into its spare top bit when any cell of the span
/// carries a link — exactly when [`encode_cells`] opens the row bytes with a
/// link table.
#[inline]
pub fn row_left_field(left: u16, cells: &[CellRepr]) -> u16 {
    if row_has_links(cells) {
        left | ROW_FLAG_LINKS
    } else {
        left
    }
}

#[inline]
fn row_has_links(cells: &[CellRepr]) -> bool {
    cells.iter().any(|cell| cell.link != 0)
}

/// Encode a frame for trusted callers that already enforce frame invariants.
///
/// This is the validation-free hot path. Call [`try_encode_frame_into`] for
/// data that has not already been bounded to the wire's u16 row fields.
pub fn encode_frame_into<'a>(
    out: &mut Vec<u8>,
    header: &FrameHeader,
    rows: impl Iterator<Item = RowRef<'a>>,
) {
    let _ = encode_frame_impl::<false, _>(
        out,
        header,
        rows.map(|row| EncodingRow {
            row_index: row.row_index,
            left: row.left,
            cells: row.cells,
            encoding: None,
            graphics: row.graphics,
        }),
    );
}

/// Encode admitted immutable row graphics without sorting, validation walks or
/// temporary dictionaries per viewer/frame. The wire format is identical.
pub fn encode_prepared_frame_into<'a>(
    out: &mut Vec<u8>,
    header: &FrameHeader,
    rows: impl Iterator<Item = PreparedRowRef<'a>>,
) {
    encode_frame_impl::<false, _>(
        out,
        header,
        rows.map(|row| EncodingRow {
            row_index: row.row_index,
            left: row.left,
            cells: row.cells,
            encoding: Some(row.encoding),
            graphics: row.graphics,
        }),
    )
    .expect("prepared graphics match the authoritative grid");
}

/// Encode a frame after validating every value narrowed into the wire's u16
/// row prefix. The output is empty on error.
pub fn try_encode_frame_into<'a>(
    out: &mut Vec<u8>,
    header: &FrameHeader,
    rows: impl Iterator<Item = RowRef<'a>>,
) -> Result<(), EncodeError> {
    let result = encode_frame_impl::<true, _>(
        out,
        header,
        rows.map(|row| EncodingRow {
            row_index: row.row_index,
            left: row.left,
            cells: row.cells,
            encoding: None,
            graphics: row.graphics,
        }),
    );

    if result.is_err() {
        out.clear();
    }
    result
}

fn encode_frame_impl<'a, const VALIDATE: bool, G: GraphicsSource>(
    out: &mut Vec<u8>,
    header: &FrameHeader,
    rows: impl Iterator<Item = EncodingRow<'a, G>>,
) -> Result<(), EncodeError> {
    out.clear();
    out.resize(STREAM_HEADER_BYTES, 0);
    let mut graphics_scratch = crate::GraphicsEncodeScratch::default();
    out.push(VERSION);
    let mut patch_flags = header.kind.patch_flags();
    if header.presentation_coherent {
        patch_flags |= crate::PATCH_FLAG_PRESENTATION_COHERENT;
    }
    if header.presentation_end {
        patch_flags |= crate::PATCH_FLAG_PRESENTATION_END;
    }
    if header.memory_only {
        patch_flags |= crate::PATCH_FLAG_MEMORY_ONLY;
    }
    if header.demand_limited {
        patch_flags |= crate::PATCH_FLAG_DEMAND_LIMITED;
    }
    if header.demand_prompt {
        patch_flags |= crate::PATCH_FLAG_DEMAND_PROMPT;
    }
    if header.demand_awaits_grant {
        patch_flags |= crate::PATCH_FLAG_DEMAND_AWAITS_GRANT;
    }
    out.push(patch_flags);
    write_u16(out, header.cols);
    write_u16(out, header.rows);
    write_u16(out, header.cursor_col);
    write_u16(out, header.cursor_row);
    out.push((header.cursor_shape & 0x0f) | ((header.cursor_visible & 0x01) << 4));
    write_u16(out, header.mode_flags);
    write_u32(out, header.frame_id);
    write_u32(out, header.presentation_id);
    write_u16(out, header.chunk_index);
    write_u16(out, header.chunk_count);
    write_u16(out, header.row_count);
    write_u16(out, header.presentation_member_index);
    write_u16(out, header.presentation_member_count);
    write_u32(out, header.row_predecessor_presentation_id);
    write_u32(out, header.demand_serial);
    write_u32(out, (header.closure_digest >> 32) as u32);
    write_u32(out, header.closure_digest as u32);
    write_u32(out, header.scroll_serial);
    write_u32(out, header.echo_horizon);

    let mut encoded_row_count = 0usize;
    for row in rows {
        if VALIDATE && encoded_row_count >= usize::from(header.row_count) {
            return Err(EncodeError::RowCountMismatch);
        }
        let cell_count = if VALIDATE {
            match u16::try_from(row.cells.len()) {
                Ok(count) if count <= ROW_CELL_COUNT_MASK => count,
                _ => return Err(EncodeError::TooManyCells),
            }
        } else {
            row.cells.len() as u16
        };
        // A partial delta that stops short of the last column omits the wrap
        // bit, which is correct rather than lossy: a row whose wrap state
        // changed differs from the receiver's baseline *at* the last column, so
        // the changed-cell range always reaches it.
        let cell_count_field = row_cell_count_field(row.cells);
        let wrapped = cell_count_field & ROW_FLAG_WRAPPED != 0;
        if VALIDATE {
            if cell_count == 0 {
                return Err(EncodeError::EmptyRow);
            }
            let right = row
                .left
                .checked_add(cell_count - 1)
                .ok_or(EncodeError::RowRangeOverflow)?;
            if wrapped && usize::from(right) + 1 != usize::from(header.cols) {
                return Err(EncodeError::WrapFlagOffRowEnd);
            }
        }

        write_u16(out, row.row_index);
        let graphics_flag = if row.graphics.is_empty() {
            0
        } else {
            crate::ROW_FLAG_GRAPHICS
        };
        write_u16(out, row_left_field(row.left, row.cells) | graphics_flag);
        write_u16(out, cell_count_field);
        let row_byte_count_offset = out.len();
        write_u16(out, 0);
        let row_bytes_offset = out.len();

        if VALIDATE {
            try_encode_cells(out, row.cells)?;
        } else if let Some(encoding) = row.encoding {
            encoding.encode(out, row.cells);
        } else {
            encode_cells(out, row.cells);
        }
        let row_bytes_len = out.len() - row_bytes_offset;
        let row_byte_count = if VALIDATE {
            u16::try_from(row_bytes_len).map_err(|_| EncodeError::RowPayloadTooLarge)?
        } else {
            row_bytes_len as u16
        };
        out[row_byte_count_offset..row_byte_count_offset + 2]
            .copy_from_slice(&row_byte_count.to_be_bytes());
        if !row.graphics.is_empty() {
            out[STREAM_HEADER_BYTES + 1] |= crate::PATCH_FLAG_MEMORY_ONLY;
            row.graphics
                .append(out, header.cols, &mut graphics_scratch)?;
        }
        encoded_row_count += 1;
    }
    if VALIDATE && encoded_row_count != usize::from(header.row_count) {
        return Err(EncodeError::RowCountMismatch);
    }
    Ok(())
}

/// The color and link decisions for an immutable captured span. Retaining
/// this census avoids a speculative larger encoding and a second color pass.
#[derive(Clone, Copy, Debug, Default)]
pub struct CellEncoding {
    literal: bool,
    links: bool,
}

impl CellEncoding {
    fn encode(self, out: &mut Vec<u8>, cells: &[CellRepr]) {
        if self.links {
            encode_link_table(out, cells);
        }
        out.push(if self.literal {
            COLOR_MODE_LITERAL
        } else {
            COLOR_MODE_INDEXED
        });
        if self.literal {
            encode_cells_body::<false, true>(out, cells).expect("trusted codepoints");
        } else {
            encode_cells_body::<false, false>(out, cells).expect("trusted codepoints");
        }
    }
}

/// Exact encoded size of a row, in one pass.
pub fn encoded_cells_size(cells: &[CellRepr]) -> usize {
    plan_cell_encoding(cells).0
}

/// Census the immutable span once for both admission size and final encoding.
///
/// The color mode depends on totals only known at the end of the row, so colors
/// are counted here and priced once, rather than walking the cells twice to
/// decide the mode first. This must agree with [`encode_cells`] byte for byte:
/// the display scheduler sizes datagram batches with it.
pub fn plan_cell_encoding(cells: &[CellRepr]) -> (usize, CellEncoding) {
    let mut size = 1usize; // per-row color mode
    // `wrapped` is not encoded per cell — it rides the row prefix — but it does
    // participate in cell equality, so a wrapped final cell ends whatever run
    // preceded it. The run walk below sees that for free.
    let mut colors = 0usize;
    let mut literals = 0usize;
    // Links are part of cell equality, so a run never straddles a link
    // boundary and counting spans needs only the previous run's id.
    let mut link_spans = 0usize;
    let mut previous_link = 0u32;

    let mut index = 0usize;
    while index < cells.len() {
        let cell = cells[index];
        let mut run_len = 1usize;
        while index + run_len < cells.len() && cells[index + run_len] == cell {
            run_len += 1;
        }
        if cell.link != 0 && cell.link != previous_link {
            link_spans += 1;
        }
        previous_link = cell.link;
        let tag = cell.tag(DEFAULT_FG, DEFAULT_BG) | if run_len > 1 { RLE } else { 0 };
        size += 1; // tag byte
        size += varint_u32_size(cell.codepoint);
        if tag & HAS_FG != 0 {
            colors += 1;
            if !is_palette_color(cell.fg) {
                literals += 1;
            }
        }
        if tag & HAS_BG != 0 {
            colors += 1;
            if !is_palette_color(cell.bg) {
                literals += 1;
            }
        }
        if run_len > 1 {
            size += varint_u32_size(run_len as u32);
        }
        index += run_len;
    }
    let link_table = if link_spans == 0 {
        0
    } else {
        LINK_TABLE_COUNT_BYTES + link_spans * LINK_SPAN_BYTES
    };
    let indexed = indexed_color_bytes(colors, literals);
    let literal = literal_color_bytes(colors);
    (
        size + link_table + indexed.min(literal),
        CellEncoding {
            literal: literal < indexed,
            links: link_spans != 0,
        },
    )
}

/// Write a row's link span table: `count: u16` then one
/// `offset: u16 | len: u16 | link: u32` span per maximal run of equal non-zero
/// link ids, offsets relative to the first cell. Big-endian like every other
/// wire field.
fn encode_link_table(out: &mut Vec<u8>, cells: &[CellRepr]) {
    let count_offset = out.len();
    write_u16(out, 0);
    let mut count = 0u16;
    let mut index = 0usize;
    while index < cells.len() {
        let link = cells[index].link;
        let mut len = 1usize;
        while index + len < cells.len() && cells[index + len].link == link {
            len += 1;
        }
        if link != 0 {
            write_u16(out, index as u16);
            write_u16(out, len as u16);
            write_u32(out, link);
            count += 1;
        }
        index += len;
    }
    out[count_offset..count_offset + LINK_TABLE_COUNT_BYTES].copy_from_slice(&count.to_be_bytes());
}

#[inline]
fn varint_u32_size(mut value: u32) -> usize {
    let mut size = 1;
    while value >= 0x80 {
        size += 1;
        value >>= 7;
    }
    size
}

pub fn encode_cells(out: &mut Vec<u8>, cells: &[CellRepr]) {
    // Terminal cells originate as Rust `char`s, so the hot production path
    // does not pay to revalidate every codepoint.
    let _ = encode_cells_impl::<false>(out, cells);
}

fn try_encode_cells(out: &mut Vec<u8>, cells: &[CellRepr]) -> Result<(), EncodeError> {
    encode_cells_impl::<true>(out, cells)
}

/// Encode a row, choosing its color mode without a separate classification
/// pass over the cells.
///
/// Deciding the mode up front would mean walking every row twice, and that cost
/// falls on unstyled rows too — which are the majority and have no colors to
/// classify. Instead this encodes optimistically in indexed mode, counting what
/// it sees, and re-encodes only in the rare case that literal mode would have
/// been smaller. An unstyled or palette-colored row is therefore a single pass;
/// only a row dominated by 24-bit color pays the retry.
fn encode_cells_impl<const VALIDATE_CODEPOINTS: bool>(
    out: &mut Vec<u8>,
    cells: &[CellRepr],
) -> Result<(), EncodeError> {
    if row_has_links(cells) {
        encode_link_table(out, cells);
    }
    let start = out.len();
    out.push(COLOR_MODE_INDEXED);
    let (colors, literals) = encode_cells_body::<VALIDATE_CODEPOINTS, false>(out, cells)?;
    if literal_color_bytes(colors) < indexed_color_bytes(colors, literals) {
        out.truncate(start);
        out.push(COLOR_MODE_LITERAL);
        encode_cells_body::<VALIDATE_CODEPOINTS, true>(out, cells)?;
    }
    Ok(())
}

/// Returns `(colors, literals)`: how many non-default colors the row carries,
/// and how many of those the palette cannot express.
fn encode_cells_body<const VALIDATE_CODEPOINTS: bool, const LITERAL: bool>(
    out: &mut Vec<u8>,
    cells: &[CellRepr],
) -> Result<(usize, usize), EncodeError> {
    let mut colors = 0usize;
    let mut literals = 0usize;
    let mut index = 0usize;
    while index < cells.len() {
        let cell = cells[index];
        if VALIDATE_CODEPOINTS && char::from_u32(cell.codepoint).is_none() {
            return Err(EncodeError::InvalidCodepoint);
        }
        let mut run_len = 1usize;
        while index + run_len < cells.len() && cells[index + run_len] == cell {
            run_len += 1;
        }
        let mut tag = cell.tag(DEFAULT_FG, DEFAULT_BG);
        if run_len > 1 {
            tag |= RLE;
        }
        out.push(tag);
        encode_varint_u32(out, cell.codepoint);
        if tag & HAS_FG != 0 {
            colors += 1;
            if !encode_color(out, cell.fg, LITERAL) {
                literals += 1;
            }
        }
        if tag & HAS_BG != 0 {
            colors += 1;
            if !encode_color(out, cell.bg, LITERAL) {
                literals += 1;
            }
        }
        if run_len > 1 {
            encode_varint_u32(out, run_len as u32);
        }
        index += run_len;
    }
    Ok((colors, literals))
}

#[inline]
fn indexed_color_bytes(colors: usize, literals: usize) -> usize {
    (colors - literals) + literals * 4
}

#[inline]
fn literal_color_bytes(colors: usize) -> usize {
    colors * 3
}

#[inline]
fn write_u16(out: &mut Vec<u8>, value: u16) {
    out.extend_from_slice(&value.to_be_bytes());
}

#[cfg(test)]
mod prepared_cell_tests {
    use super::*;

    #[test]
    fn captured_color_decision_is_byte_identical_without_transient_buffer_growth() {
        let mut random = 0x9876_abcd_u32;
        for case in 0..512 {
            let mut cells = Vec::new();
            for index in 0..=case {
                random ^= random << 13;
                random ^= random >> 17;
                random ^= random << 5;
                let mut cell = CellRepr {
                    codepoint: [' ', 'x', '界', '🦀'][random as usize % 4] as u32,
                    fg: match case % 4 {
                        0 => DEFAULT_FG,
                        1 => crate::ANSI_PALETTE[random as usize % 16],
                        _ => [(random >> 16) as u8, (random >> 8) as u8, random as u8],
                    },
                    link: if case % 3 == 0 {
                        (index / 5 % 3) as u32
                    } else {
                        0
                    },
                    ..CellRepr::BLANK
                };
                if case % 7 == 0 && index > 0 {
                    cell = cells[index - 1];
                }
                cells.push(cell);
            }
            let (bytes, plan) = plan_cell_encoding(&cells);
            let mut expected = vec![0x5a; 13];
            encode_cells(&mut expected, &cells);
            assert_eq!(expected.len(), 13 + bytes);
            let mut actual = Vec::with_capacity(expected.len());
            actual.resize(13, 0x5a);
            let capacity = actual.capacity();
            plan.encode(&mut actual, &cells);
            assert_eq!(actual, expected, "case {case}");
            assert_eq!(
                actual.capacity(),
                capacity,
                "case {case} grew past its exact final size"
            );
        }
    }
}
