use crate::cell::{CellAttrs, CellRepr, HAS_BG, HAS_FG, RLE};
use crate::encode::{DEFAULT_BG, DEFAULT_FG, FrameHeader, FrameKind};
use crate::varint::decode_varint_u32;
use crate::{
    FRAME_HEADER_BODY_BYTES, LINK_SPAN_BYTES, LINK_TABLE_COUNT_BYTES, ROW_CELL_COUNT_MASK,
    ROW_FLAG_LINKS, ROW_FLAG_WRAPPED, ROW_LEFT_MASK, ROW_PREFIX_BYTES, STREAM_HEADER_BYTES,
    VERSION,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CodecErr {
    Truncated,
    InvalidVersion,
    InvalidVarint,
    InvalidCodepoint,
    InvalidRunLength,
    RowLengthOverflow,
    InvalidRowRange,
    InvalidColorMode,
    InvalidLinkTable,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RowView<'a> {
    pub row_index: u16,
    pub left: u16,
    pub right: u16,
    pub cells_byte_len: u32,
    pub cells: &'a [u8],
    pub offset: usize,
    pub len: usize,
    /// The row continues onto the next row. Row-scoped, so it belongs to this
    /// entry's final cell — which is the row's final cell, because the encoder
    /// only sets the flag for a span that reaches it.
    pub wrapped: bool,
    /// The row's link spans, [`LINK_SPAN_BYTES`] each, without the table's
    /// count. Empty for a row without [`ROW_FLAG_LINKS`]. Structural bounds are
    /// checked by [`link_spans`]; `cells` never includes these bytes.
    pub links: &'a [u8],
    /// Complete graphics replacement, locally interned and independently owned.
    pub graphics: &'a [u8],
}

/// One decoded link span: `len` cells starting `offset` cells after the row
/// entry's `left` carry `link`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LinkSpan {
    pub offset: u16,
    pub len: u16,
    pub link: u32,
}

/// Iterate a row's link spans, rejecting any span that is empty, names link 0,
/// overlaps or precedes its predecessor, or reaches past `cell_count` cells.
pub fn link_spans(
    links: &[u8],
    cell_count: usize,
) -> impl Iterator<Item = Result<LinkSpan, CodecErr>> + '_ {
    let mut next_free = 0usize;
    links.chunks_exact(LINK_SPAN_BYTES).map(move |span| {
        let offset = u16::from_be_bytes([span[0], span[1]]);
        let len = u16::from_be_bytes([span[2], span[3]]);
        let link = u32::from_be_bytes([span[4], span[5], span[6], span[7]]);
        let start = usize::from(offset);
        let end = start + usize::from(len);
        if len == 0 || link == 0 || start < next_free || end > cell_count {
            return Err(CodecErr::InvalidLinkTable);
        }
        next_free = end;
        Ok(LinkSpan { offset, len, link })
    })
}

#[derive(Clone)]
pub struct RowIter<'a> {
    buf: &'a [u8],
    offset: usize,
    remaining: u16,
}

pub struct CellIter<'a> {
    buf: &'a [u8],
    offset: usize,
    pending: Option<(CellRepr, u32)>,
    emitted: u32,
    /// Read from the byte preceding this row's first color, then reused for
    /// every later color in the row. `None` until that first color is reached,
    /// which is why an unstyled row never carries the byte at all.
    color_mode: Option<u8>,
}

pub fn parse_frame_header(buf: &[u8]) -> Result<FrameHeader, CodecErr> {
    parse_frame_header_and_rows_start(buf).map(|(header, _)| header)
}

pub fn parse_frame_header_and_rows_start(buf: &[u8]) -> Result<(FrameHeader, usize), CodecErr> {
    if buf.len() < STREAM_HEADER_BYTES + FRAME_HEADER_BODY_BYTES {
        return Err(CodecErr::Truncated);
    }

    let b = STREAM_HEADER_BYTES;
    if buf[b] != VERSION {
        return Err(CodecErr::InvalidVersion);
    }
    let flags = buf[b + 1];
    let kind = FrameKind::from_patch_flags(flags);
    let cols = read_u16_at(buf, b + 2);
    let rows = read_u16_at(buf, b + 4);
    let cursor_col = read_u16_at(buf, b + 6);
    let cursor_row = read_u16_at(buf, b + 8);
    let cursor = buf[b + 10];
    let mode_flags = read_u16_at(buf, b + 11);
    let frame_id = read_u32_at(buf, b + 13);
    let presentation_id = read_u32_at(buf, b + 17);
    let chunk_index = read_u16_at(buf, b + 21);
    let chunk_count = read_u16_at(buf, b + 23);
    let row_count = read_u16_at(buf, b + 25);
    let presentation_member_index = read_u16_at(buf, b + 27);
    let presentation_member_count = read_u16_at(buf, b + 29);
    let row_predecessor_presentation_id = read_u32_at(buf, b + 31);
    let demand_serial = read_u32_at(buf, b + 35);
    let closure_digest =
        (u64::from(read_u32_at(buf, b + 39)) << 32) | u64::from(read_u32_at(buf, b + 43));
    let scroll_serial = read_u32_at(buf, b + 47);
    let echo_horizon = read_u32_at(buf, b + 51);

    Ok((
        FrameHeader {
            memory_only: flags & crate::PATCH_FLAG_MEMORY_ONLY != 0,
            kind,
            cols,
            rows,
            cursor_col,
            cursor_row,
            cursor_shape: cursor & 0x0f,
            cursor_visible: (cursor >> 4) & 0x01,
            mode_flags,
            row_count,
            frame_id,
            presentation_id,
            presentation_member_index,
            presentation_member_count,
            row_predecessor_presentation_id,
            presentation_coherent: flags & crate::PATCH_FLAG_PRESENTATION_COHERENT != 0,
            presentation_end: flags & crate::PATCH_FLAG_PRESENTATION_END != 0,
            chunk_index,
            chunk_count,
            demand_serial,
            demand_limited: flags & crate::PATCH_FLAG_DEMAND_LIMITED != 0,
            demand_prompt: flags & crate::PATCH_FLAG_DEMAND_PROMPT != 0,
            demand_awaits_grant: flags & crate::PATCH_FLAG_DEMAND_AWAITS_GRANT != 0,
            closure_digest,
            scroll_serial,
            echo_horizon,
        },
        STREAM_HEADER_BYTES + FRAME_HEADER_BODY_BYTES,
    ))
}

pub fn iter_rows(buf: &[u8]) -> RowIter<'_> {
    let (remaining, offset) = parse_frame_header_and_rows_start(buf)
        .map(|(header, offset)| (header.row_count, offset))
        .unwrap_or((0, buf.len()));
    RowIter {
        buf,
        offset,
        remaining,
    }
}

pub fn iter_rows_at(buf: &[u8], offset: usize, row_count: u16) -> RowIter<'_> {
    RowIter {
        buf,
        offset,
        remaining: row_count,
    }
}

pub fn cell_iter(row_bytes: &[u8]) -> CellIter<'_> {
    // A row's color mode is its first byte, at a position identical for every
    // row, so row payloads stay mutually aligned for the compressor.
    let (color_mode, offset) = match row_bytes.first() {
        Some(&mode) => (Some(mode), 1),
        None => (None, 0),
    };
    CellIter {
        buf: row_bytes,
        offset,
        pending: None,
        emitted: 0,
        color_mode,
    }
}

impl<'a> Iterator for RowIter<'a> {
    type Item = Result<RowView<'a>, CodecErr>;

    fn next(&mut self) -> Option<Self::Item> {
        if self.remaining == 0 {
            return None;
        }
        self.remaining -= 1;
        let Some(prefix_end) = self.offset.checked_add(ROW_PREFIX_BYTES) else {
            self.remaining = 0;
            return Some(Err(CodecErr::RowLengthOverflow));
        };
        if prefix_end > self.buf.len() {
            self.remaining = 0;
            return Some(Err(CodecErr::Truncated));
        }
        let start = self.offset;
        let row_index = read_u16_at(self.buf, self.offset);
        let left_field = read_u16_at(self.buf, self.offset + 2);
        let left = left_field & ROW_LEFT_MASK;
        let has_links = left_field & ROW_FLAG_LINKS != 0;
        let cell_count_field = read_u16_at(self.buf, self.offset + 4);
        let cell_count = u32::from(cell_count_field & ROW_CELL_COUNT_MASK);
        let wrapped = cell_count_field & ROW_FLAG_WRAPPED != 0;
        let cells_byte_len = u32::from(read_u16_at(self.buf, self.offset + 6));
        self.offset += ROW_PREFIX_BYTES;
        if cell_count == 0 {
            self.remaining = 0;
            return Some(Err(CodecErr::InvalidRowRange));
        }
        let right = match u32::from(left).checked_add(cell_count - 1) {
            Some(value) if value <= u32::from(u16::MAX) => value as u16,
            _ => {
                self.remaining = 0;
                return Some(Err(CodecErr::InvalidRowRange));
            }
        };
        let cells_len = cells_byte_len as usize;
        let mut end = match self.offset.checked_add(cells_len) {
            Some(value) => value,
            None => {
                self.remaining = 0;
                return Some(Err(CodecErr::RowLengthOverflow));
            }
        };
        if end > self.buf.len() {
            self.remaining = 0;
            return Some(Err(CodecErr::Truncated));
        }
        let mut cells = &self.buf[self.offset..end];
        let mut links: &[u8] = &[];
        if has_links {
            let Some(count) = cells.get(..LINK_TABLE_COUNT_BYTES) else {
                self.remaining = 0;
                return Some(Err(CodecErr::InvalidLinkTable));
            };
            let count = usize::from(u16::from_be_bytes([count[0], count[1]]));
            let table_end = LINK_TABLE_COUNT_BYTES + count * LINK_SPAN_BYTES;
            if count == 0 || table_end > cells.len() {
                self.remaining = 0;
                return Some(Err(CodecErr::InvalidLinkTable));
            }
            links = &cells[LINK_TABLE_COUNT_BYTES..table_end];
            cells = &cells[table_end..];
        }
        let mut graphics = &[][..];
        if left_field & crate::ROW_FLAG_GRAPHICS != 0 {
            let Some(length) = self.buf.get(end..end + 4) else {
                self.remaining = 0;
                return Some(Err(CodecErr::Truncated));
            };
            let len = u32::from_be_bytes(length.try_into().expect("fixed length")) as usize;
            let start = end + 4;
            let Some(graphics_end) = start.checked_add(len) else {
                self.remaining = 0;
                return Some(Err(CodecErr::RowLengthOverflow));
            };
            if len == 0 || len > crate::MAX_GRAPHICS_SECTION_BYTES || graphics_end > self.buf.len()
            {
                self.remaining = 0;
                return Some(Err(CodecErr::RowLengthOverflow));
            }
            graphics = &self.buf[start..graphics_end];
            end = graphics_end;
        }
        self.offset = end;
        Some(Ok(RowView {
            row_index,
            left,
            right,
            cells_byte_len,
            cells,
            offset: start,
            len: end - start,
            wrapped,
            links,
            graphics,
        }))
    }
}

impl Iterator for CellIter<'_> {
    type Item = Result<CellRepr, CodecErr>;

    fn next(&mut self) -> Option<Self::Item> {
        if let Some((cell, left)) = self.pending {
            if left > 1 {
                self.pending = Some((cell, left - 1));
            } else {
                self.pending = None;
            }
            self.emitted += 1;
            return Some(Ok(cell));
        }
        if self.offset >= self.buf.len() {
            return None;
        }
        let tag = self.buf[self.offset];
        self.offset += 1;
        let codepoint = match decode_varint_u32(self.buf, &mut self.offset) {
            Ok(value) => value,
            Err(err) => return Some(Err(self.fail(err))),
        };
        if char::from_u32(codepoint).is_none() {
            return Some(Err(self.fail(CodecErr::InvalidCodepoint)));
        }
        let mut fg = DEFAULT_FG;
        let mut bg = DEFAULT_BG;
        if tag & HAS_FG != 0 {
            match self.read_color() {
                Ok(color) => fg = color,
                Err(error) => return Some(Err(self.fail(error))),
            }
        }
        if tag & HAS_BG != 0 {
            match self.read_color() {
                Ok(color) => bg = color,
                Err(error) => return Some(Err(self.fail(error))),
            }
        }
        let run_len = if tag & RLE != 0 {
            match decode_varint_u32(self.buf, &mut self.offset) {
                Ok(value) if value > 0 && value <= u32::from(u16::MAX) => value,
                Ok(_) => return Some(Err(self.fail(CodecErr::InvalidRunLength))),
                Err(err) => return Some(Err(self.fail(err))),
            }
        } else {
            1
        };
        if run_len > u32::from(u16::MAX) - self.emitted {
            return Some(Err(self.fail(CodecErr::InvalidRunLength)));
        }
        let cell = CellRepr {
            codepoint,
            // Row-scoped: the link table lowers ids onto their cells.
            link: 0,
            fg,
            bg,
            // Never the wrap bit, which is row-scoped and carried by the row
            // prefix rather than the tag. `validate_display_frame` lowers it
            // back onto the row's final cell, the only cell that can hold it.
            attrs: CellAttrs::from_tag_and_background(tag, bg),
        };
        if run_len > 1 {
            self.pending = Some((cell, run_len - 1));
        }
        self.emitted += 1;
        Some(Ok(cell))
    }
}

impl CellIter<'_> {
    /// Read one non-default color, reading this row's color mode first if this
    /// is the row's first color.
    ///
    /// Resolving palette indices here — rather than carrying them outward — is
    /// what keeps `CellRepr` and every consumer of it unchanged: the daemon and
    /// the browser both decode through this iterator, so both see resolved RGB
    /// exactly as before.
    #[inline]
    fn read_color(&mut self) -> Result<[u8; 3], CodecErr> {
        let mode = self.color_mode.ok_or(CodecErr::Truncated)?;
        if mode != crate::encode::COLOR_MODE_INDEXED && mode != crate::encode::COLOR_MODE_LITERAL {
            return Err(CodecErr::InvalidColorMode);
        }
        if mode == crate::encode::COLOR_MODE_INDEXED {
            let first = *self.buf.get(self.offset).ok_or(CodecErr::Truncated)?;
            self.offset += 1;
            if first != crate::encode::COLOR_LITERAL_ESCAPE {
                return Ok(crate::theme::INDEXED_COLOR_TABLE[usize::from(first)]);
            }
        }
        let literal = self
            .buf
            .get(self.offset..self.offset + 3)
            .ok_or(CodecErr::Truncated)?;
        let color = [literal[0], literal[1], literal[2]];
        self.offset += 3;
        Ok(color)
    }

    #[inline]
    fn fail(&mut self, error: CodecErr) -> CodecErr {
        // Make malformed-input iterators fused. A caller that elects to keep
        // polling after an error must not reinterpret the remaining bytes.
        self.offset = self.buf.len();
        self.pending = None;
        error
    }
}

#[inline]
fn read_u16_at(buf: &[u8], offset: usize) -> u16 {
    u16::from_be_bytes([buf[offset], buf[offset + 1]])
}

#[inline]
fn read_u32_at(buf: &[u8], offset: usize) -> u32 {
    u32::from_be_bytes([
        buf[offset],
        buf[offset + 1],
        buf[offset + 2],
        buf[offset + 3],
    ])
}
