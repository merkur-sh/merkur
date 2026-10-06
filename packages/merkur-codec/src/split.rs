//! The stream-split layout of a compressed display payload.
//!
//! A compressed frame does not carry its rows as the row layout writes them. The
//! daemon splits the row body into streams of like fields and compresses those;
//! the receiver joins them back into the exact row bytes before the one row
//! validator reads them. A field kept with its own kind gives the entropy coder
//! one distribution per field instead of one interleaved distribution. Measured
//! through the whole display pipeline on recorded sessions, against compressing
//! the row layout itself: 20% fewer wire bytes on repaints and snapshots, and
//! 6% fewer on delta datagrams weighted to production's size mix.
//!
//! For `R` rows and `T` cell runs:
//!
//! ```text
//! varint T | varint L | varint G
//! row index u16 ×R | left u16 ×R | cell count u16 ×R   (big-endian, as in the row prefix)
//! colour mode u8 ×R
//! link tables, L bytes   (each linked row's table, verbatim: count u16, then spans)
//! graphics, G bytes      (each graphics row's section, verbatim: length u32, then bytes)
//! tag u8 ×T
//! per run: codepoint varint, then run length varint when the tag has RLE
//! colours: the rest, each colour exactly as the row layout writes it
//! ```
//!
//! The row prefix's byte count is not carried; the join recomputes it. A split
//! payload is therefore exactly `rows.len() - 2R` plus its three varints, and the
//! joined body is byte-identical to the body the daemon encoded.

use crate::cell::{HAS_BG, HAS_FG, RLE};
use crate::decode::CodecErr;
use crate::encode::{COLOR_LITERAL_ESCAPE, COLOR_MODE_INDEXED, COLOR_MODE_LITERAL};
use crate::varint::{decode_varint_u32, encode_varint_u32};
use crate::{
    LINK_SPAN_BYTES, LINK_TABLE_COUNT_BYTES, MAX_GRAPHICS_SECTION_BYTES, ROW_CELL_COUNT_MASK,
    ROW_FLAG_GRAPHICS, ROW_FLAG_LINKS, ROW_PREFIX_BYTES,
};

/// Upper bound of the split header: three u32 varints.
pub const SPLIT_HEADER_MAX_BYTES: usize = 15;

/// Bytes of a row-prefix field carried per row (index, left, cell count).
const PREFIX_FIELD_BYTES: usize = 2;
/// The fixed per-row region: three prefix fields and the colour mode.
const FIXED_ROW_BYTES: usize = 3 * PREFIX_FIELD_BYTES + 1;
/// Bytes of a graphics section's length.
const GRAPHICS_LENGTH_BYTES: usize = 4;
/// The longest u32 varint.
const VARINT_MAX_BYTES: usize = 5;

/// Splits row bodies in one pass, keeping its buffers across calls.
///
/// The walk writes each field straight into its region's buffer, then the
/// regions are concatenated behind the header. Every byte a region holds was
/// read from a distinct byte of the body, so each run region is at most the
/// body's length; those buffers only ever grow, and a steady sender splits
/// without allocating or clearing.
#[derive(Default)]
pub struct RowSplitter {
    fixed: Vec<u8>,
    links: Vec<u8>,
    graphics: Vec<u8>,
    tags: Vec<u8>,
    runs: Vec<u8>,
    colors: Vec<u8>,
    payload: Vec<u8>,
}

impl RowSplitter {
    /// The split layout of the row-layout body `rows` of `row_count` rows.
    pub fn split(&mut self, rows: &[u8], row_count: u16) -> Result<&[u8], CodecErr> {
        let Self {
            fixed,
            links,
            graphics,
            tags,
            runs,
            colors,
            payload,
        } = self;
        let count = usize::from(row_count);
        fixed.clear();
        fixed.resize(FIXED_ROW_BYTES * count, 0);
        links.clear();
        graphics.clear();
        for region in [&mut *tags, &mut *runs, &mut *colors] {
            if region.len() < rows.len() {
                region.resize(rows.len(), 0);
            }
        }
        let (left_at, count_at, mode_at) = (
            PREFIX_FIELD_BYTES * count,
            2 * PREFIX_FIELD_BYTES * count,
            3 * PREFIX_FIELD_BYTES * count,
        );
        let (mut tag, mut run, mut color) = (0usize, 0usize, 0usize);
        let mut at = 0usize;
        for row in 0..count {
            let prefix = rows
                .get(at..at + ROW_PREFIX_BYTES)
                .ok_or(CodecErr::Truncated)?;
            let field = PREFIX_FIELD_BYTES * row;
            fixed[field..field + 2].copy_from_slice(&prefix[0..2]);
            fixed[left_at + field..left_at + field + 2].copy_from_slice(&prefix[2..4]);
            fixed[count_at + field..count_at + field + 2].copy_from_slice(&prefix[4..6]);
            let left = u16::from_be_bytes([prefix[2], prefix[3]]);
            let cells =
                usize::from(u16::from_be_bytes([prefix[4], prefix[5]]) & ROW_CELL_COUNT_MASK);
            let start = at + ROW_PREFIX_BYTES;
            let end = start + usize::from(u16::from_be_bytes([prefix[6], prefix[7]]));
            let body = rows.get(start..end).ok_or(CodecErr::Truncated)?;
            let mut cursor = 0usize;
            if left & ROW_FLAG_LINKS != 0 {
                let spans = usize::from(u16::from_be_bytes(read_u16(body, 0)?));
                let table_end = LINK_TABLE_COUNT_BYTES + spans * LINK_SPAN_BYTES;
                if spans == 0 || table_end > body.len() {
                    return Err(CodecErr::InvalidLinkTable);
                }
                links.extend_from_slice(&body[..table_end]);
                cursor = table_end;
            }
            let mode = *body.get(cursor).ok_or(CodecErr::Truncated)?;
            if mode != COLOR_MODE_INDEXED && mode != COLOR_MODE_LITERAL {
                return Err(CodecErr::InvalidColorMode);
            }
            fixed[mode_at + row] = mode;
            cursor += 1;
            let mut covered = 0usize;
            while cursor < body.len() {
                let cell_tag = body[cursor];
                tags[tag] = cell_tag;
                tag += 1;
                cursor += 1;
                cursor = copy_varint(body, cursor, runs, &mut run)?.0;
                for flag in [HAS_FG, HAS_BG] {
                    if cell_tag & flag != 0 {
                        let width = color_width(body, cursor, mode)?;
                        copy_short(&body[cursor..cursor + width], colors, &mut color);
                        cursor += width;
                    }
                }
                let length = if cell_tag & RLE != 0 {
                    let (next, length) = copy_varint(body, cursor, runs, &mut run)?;
                    cursor = next;
                    length as usize
                } else {
                    1
                };
                if length > cells - covered {
                    return Err(CodecErr::InvalidRunLength);
                }
                covered += length;
            }
            if covered != cells {
                return Err(CodecErr::InvalidRunLength);
            }
            at = end;
            if left & ROW_FLAG_GRAPHICS != 0 {
                let length = rows
                    .get(at..at + GRAPHICS_LENGTH_BYTES)
                    .ok_or(CodecErr::Truncated)?;
                let length =
                    u32::from_be_bytes([length[0], length[1], length[2], length[3]]) as usize;
                let section_end = at + GRAPHICS_LENGTH_BYTES + length;
                if length == 0 || length > MAX_GRAPHICS_SECTION_BYTES || section_end > rows.len() {
                    return Err(CodecErr::RowLengthOverflow);
                }
                graphics.extend_from_slice(&rows[at..section_end]);
                at = section_end;
            }
        }
        if at != rows.len() {
            return Err(CodecErr::RowLengthOverflow);
        }
        payload.clear();
        payload.reserve(
            SPLIT_HEADER_MAX_BYTES + fixed.len() + links.len() + graphics.len() + tag + run + color,
        );
        encode_varint_u32(payload, tag as u32);
        encode_varint_u32(payload, links.len() as u32);
        encode_varint_u32(payload, graphics.len() as u32);
        for region in [
            fixed.as_slice(),
            links,
            graphics,
            &tags[..tag],
            &runs[..run],
            &colors[..color],
        ] {
            payload.extend_from_slice(region);
        }
        Ok(payload)
    }
}

#[inline]
fn read_u16(buf: &[u8], at: usize) -> Result<[u8; 2], CodecErr> {
    buf.get(at..at + 2)
        .map(|bytes| [bytes[0], bytes[1]])
        .ok_or(CodecErr::Truncated)
}

/// The bytes one colour occupies at `at`, in a row of colour mode `mode`.
#[inline]
fn color_width(buf: &[u8], at: usize, mode: u8) -> Result<usize, CodecErr> {
    let width = if mode == COLOR_MODE_LITERAL {
        3
    } else if *buf.get(at).ok_or(CodecErr::Truncated)? == COLOR_LITERAL_ESCAPE {
        4
    } else {
        1
    };
    if at + width > buf.len() {
        return Err(CodecErr::Truncated);
    }
    Ok(width)
}

/// Copy a field of at most four bytes to `out[*at..]`. Per-byte stores, not a
/// `memcpy` call: almost every field here is one byte.
#[inline]
fn copy_short(field: &[u8], out: &mut [u8], at: &mut usize) {
    for &byte in field {
        out[*at] = byte;
        *at += 1;
    }
}

/// Copy the varint at `src[from..]` to `out[*at..]`, returning where it ends
/// and its value. Canonical form is not checked here: the daemon's encoder
/// writes canonical varints, and the receiver's row validator checks the
/// joined bytes, which carry these unchanged, before anything is applied.
#[inline]
fn copy_varint(
    src: &[u8],
    from: usize,
    out: &mut [u8],
    at: &mut usize,
) -> Result<(usize, u32), CodecErr> {
    let mut value = 0u32;
    for index in 0..VARINT_MAX_BYTES {
        let byte = *src.get(from + index).ok_or(CodecErr::Truncated)?;
        *out.get_mut(*at).ok_or(CodecErr::Truncated)? = byte;
        *at += 1;
        value |= u32::from(byte & 0x7f).wrapping_shl(7 * index as u32);
        if byte & 0x80 == 0 {
            return Ok((from + index + 1, value));
        }
    }
    Err(CodecErr::InvalidVarint)
}

/// The end of the run region that starts at `from`: the byte after its
/// `terminators`-th varint terminator. Whole eight-byte words are counted at
/// once while the remaining terminators cannot all fall inside one.
#[inline]
fn runs_end(split: &[u8], mut from: usize, mut terminators: usize) -> Result<usize, CodecErr> {
    const HIGH_BITS: u64 = 0x8080_8080_8080_8080;
    while terminators > 8 {
        let Some(word) = split.get(from..from + 8) else {
            break;
        };
        let word = u64::from_le_bytes(word.try_into().map_err(|_| CodecErr::Truncated)?);
        terminators -= (!word & HIGH_BITS).count_ones() as usize;
        from += 8;
    }
    while terminators > 0 {
        let byte = *split.get(from).ok_or(CodecErr::Truncated)?;
        from += 1;
        terminators -= usize::from(byte & 0x80 == 0);
    }
    Ok(from)
}

/// Join a split payload back into the row-layout body of `row_count` rows,
/// replacing the contents of `out`. Every region must be consumed exactly.
///
/// Each byte written comes from a distinct payload byte, plus each row's
/// recomputed byte count, so a valid payload joins to exactly
/// `split.len() - header + 2R` bytes; `out` is sized to that once and written
/// through a cursor.
pub fn join_rows_into(split: &[u8], row_count: u16, out: &mut Vec<u8>) -> Result<(), CodecErr> {
    out.clear();
    let mut offset = 0usize;
    let tag_count = decode_varint_u32(split, &mut offset)? as usize;
    let links_len = decode_varint_u32(split, &mut offset)? as usize;
    let graphics_len = decode_varint_u32(split, &mut offset)? as usize;
    let rows = usize::from(row_count);
    let index_at = offset;
    let left_at = index_at + PREFIX_FIELD_BYTES * rows;
    let count_at = left_at + PREFIX_FIELD_BYTES * rows;
    let mode_at = count_at + PREFIX_FIELD_BYTES * rows;
    let links_at = mode_at + rows;
    let graphics_at = links_at.checked_add(links_len).ok_or(CodecErr::Truncated)?;
    let tags_at = graphics_at
        .checked_add(graphics_len)
        .ok_or(CodecErr::Truncated)?;
    let runs_at = tags_at.checked_add(tag_count).ok_or(CodecErr::Truncated)?;
    if runs_at > split.len() {
        return Err(CodecErr::Truncated);
    }
    let tags = &split[tags_at..runs_at];
    // The run region holds one codepoint varint per run and one length varint
    // per RLE run, so its end is the position of that many terminating bytes.
    let rle_runs = tags.iter().filter(|&&tag| tag & RLE != 0).count();
    let colors_at = runs_end(split, runs_at, tag_count + rle_runs)?;
    let runs = &split[..colors_at];

    out.resize(split.len() - index_at + PREFIX_FIELD_BYTES * rows, 0);
    let dst = out.as_mut_slice();
    let mut w = 0usize;
    let (mut links, mut graphics, mut tag, mut run, mut color) =
        (links_at, graphics_at, 0usize, runs_at, colors_at);
    for row in 0..rows {
        let field = |at: usize| {
            let at = at + PREFIX_FIELD_BYTES * row;
            [split[at], split[at + 1]]
        };
        let left = field(left_at);
        let count = field(count_at);
        let left_field = u16::from_be_bytes(left);
        let cells = usize::from(u16::from_be_bytes(count) & ROW_CELL_COUNT_MASK);
        let prefix = dst
            .get_mut(w..w + ROW_PREFIX_BYTES)
            .ok_or(CodecErr::RowLengthOverflow)?;
        prefix[0..2].copy_from_slice(&field(index_at));
        prefix[2..4].copy_from_slice(&left);
        prefix[4..6].copy_from_slice(&count);
        let length_at = w + 6;
        w += ROW_PREFIX_BYTES;
        let row_at = w;
        if left_field & ROW_FLAG_LINKS != 0 {
            let spans = usize::from(u16::from_be_bytes(read_u16(split, links)?));
            let table_end = links + LINK_TABLE_COUNT_BYTES + spans * LINK_SPAN_BYTES;
            if spans == 0 || table_end > graphics_at {
                return Err(CodecErr::InvalidLinkTable);
            }
            let table = &split[links..table_end];
            dst.get_mut(w..w + table.len())
                .ok_or(CodecErr::RowLengthOverflow)?
                .copy_from_slice(table);
            w += table.len();
            links = table_end;
        }
        let mode = split[mode_at + row];
        if mode != COLOR_MODE_INDEXED && mode != COLOR_MODE_LITERAL {
            return Err(CodecErr::InvalidColorMode);
        }
        *dst.get_mut(w).ok_or(CodecErr::RowLengthOverflow)? = mode;
        w += 1;
        let mut covered = 0usize;
        while covered < cells {
            let cell_tag = *tags.get(tag).ok_or(CodecErr::Truncated)?;
            tag += 1;
            *dst.get_mut(w).ok_or(CodecErr::RowLengthOverflow)? = cell_tag;
            w += 1;
            run = copy_varint(runs, run, dst, &mut w)?.0;
            for flag in [HAS_FG, HAS_BG] {
                if cell_tag & flag != 0 {
                    let width = color_width(split, color, mode)?;
                    if w + width > dst.len() {
                        return Err(CodecErr::RowLengthOverflow);
                    }
                    copy_short(&split[color..color + width], dst, &mut w);
                    color += width;
                }
            }
            if cell_tag & RLE != 0 {
                let (next, length) = copy_varint(runs, run, dst, &mut w)?;
                run = next;
                if length as usize > cells - covered {
                    return Err(CodecErr::InvalidRunLength);
                }
                covered += length as usize;
            } else {
                covered += 1;
            }
        }
        let row_bytes = u16::try_from(w - row_at).map_err(|_| CodecErr::RowLengthOverflow)?;
        dst[length_at..length_at + 2].copy_from_slice(&row_bytes.to_be_bytes());
        if left_field & ROW_FLAG_GRAPHICS != 0 {
            let length = split
                .get(graphics..graphics + GRAPHICS_LENGTH_BYTES)
                .filter(|_| graphics + GRAPHICS_LENGTH_BYTES <= tags_at)
                .ok_or(CodecErr::Truncated)?;
            let length = u32::from_be_bytes([length[0], length[1], length[2], length[3]]) as usize;
            // Bound the length before adding it: on wasm32 a hostile u32 would
            // wrap the sum.
            if length == 0 || length > MAX_GRAPHICS_SECTION_BYTES {
                return Err(CodecErr::RowLengthOverflow);
            }
            let section_end = graphics + GRAPHICS_LENGTH_BYTES + length;
            if section_end > tags_at {
                return Err(CodecErr::RowLengthOverflow);
            }
            let section = &split[graphics..section_end];
            dst.get_mut(w..w + section.len())
                .ok_or(CodecErr::RowLengthOverflow)?
                .copy_from_slice(section);
            w += section.len();
            graphics = section_end;
        }
    }
    if links != graphics_at
        || graphics != tags_at
        || tag != tag_count
        || run != colors_at
        || color != split.len()
        || w != dst.len()
    {
        return Err(CodecErr::RowLengthOverflow);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        ANSI_PALETTE, CellAttrs, CellRepr, DEFAULT_BACKGROUND, DEFAULT_FOREGROUND,
        FRAME_HEADER_BODY_BYTES, FrameHeader, FrameKind, RowRef, STREAM_HEADER_BYTES,
        encode_frame_into,
    };

    fn header(row_count: u16) -> FrameHeader {
        FrameHeader {
            memory_only: false,
            kind: FrameKind::Delta,
            cols: 200,
            rows: 60,
            cursor_col: 0,
            cursor_row: 0,
            cursor_shape: 1,
            cursor_visible: 1,
            mode_flags: 0,
            row_count,
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
        }
    }

    /// xorshift, so every case is reproducible.
    fn next(state: &mut u32) -> u32 {
        *state ^= *state << 13;
        *state ^= *state >> 17;
        *state ^= *state << 5;
        *state
    }

    fn random_row(state: &mut u32, width: usize) -> Vec<CellRepr> {
        let style = next(state) % 4;
        let mut cells = Vec::with_capacity(width);
        while cells.len() < width {
            let random = next(state);
            let cell = CellRepr {
                codepoint: [' ', 'a', 'Z', '界', '🦀', '─', '\u{e0b0}'][random as usize % 7] as u32,
                link: if style == 3 && random.is_multiple_of(5) {
                    1 + random % 3
                } else {
                    0
                },
                fg: match style {
                    0 => DEFAULT_FOREGROUND,
                    1 => ANSI_PALETTE[random as usize % 16],
                    _ => [
                        (random >> 8) as u8,
                        (random >> 16) as u8,
                        (random >> 24) as u8,
                    ],
                },
                bg: if random.is_multiple_of(7) {
                    ANSI_PALETTE[(random as usize >> 4) % 16]
                } else {
                    DEFAULT_BACKGROUND
                },
                attrs: if random.is_multiple_of(11) {
                    CellAttrs::BOLD
                } else {
                    CellAttrs::NONE
                },
            };
            // Runs of equal cells exercise the RLE tag.
            let repeat = 1 + (next(state) % 9) as usize * usize::from(random.is_multiple_of(3));
            for _ in 0..repeat.min(width - cells.len()) {
                cells.push(cell);
            }
        }
        cells
    }

    /// A frame body of `rows` random rows, as the daemon encodes it.
    fn body(seed: u32, rows: usize) -> (Vec<u8>, u16) {
        let mut state = seed;
        let rows_cells: Vec<(u16, u16, Vec<CellRepr>)> = (0..rows)
            .map(|row| {
                let width = 1 + (next(&mut state) % 200) as usize;
                let left = (next(&mut state) % (200 - width as u32 + 1)) as u16;
                (row as u16, left, random_row(&mut state, width))
            })
            .collect();
        let mut frame = Vec::new();
        encode_frame_into(
            &mut frame,
            &header(rows as u16),
            rows_cells.iter().map(|(row, left, cells)| RowRef {
                graphics: &[],
                row_index: *row,
                left: *left,
                cells,
            }),
        );
        (
            frame[STREAM_HEADER_BYTES + FRAME_HEADER_BODY_BYTES..].to_vec(),
            rows as u16,
        )
    }

    fn varints_len(split: &[u8]) -> usize {
        let mut offset = 0;
        for _ in 0..3 {
            decode_varint_u32(split, &mut offset).expect("header varint");
        }
        offset
    }

    #[test]
    fn split_then_join_is_the_identity_and_drops_exactly_the_row_byte_counts() {
        let mut splitter = RowSplitter::default();
        let mut joined = Vec::new();
        for seed in 1..400u32 {
            let (rows, row_count) =
                body(seed.wrapping_mul(0x9e37_79b9) | 1, 1 + seed as usize % 40);
            let split = splitter.split(&rows, row_count).expect("split");
            assert_eq!(
                split.len(),
                rows.len() - 2 * usize::from(row_count) + varints_len(split),
                "seed {seed}"
            );
            join_rows_into(split, row_count, &mut joined).expect("join");
            assert_eq!(joined, rows, "seed {seed}");
        }
    }

    #[test]
    fn a_splitter_reuses_its_buffers_across_frames() {
        let (large, large_rows) = body(0x1234_5679, 40);
        let (small, small_rows) = body(0x0bad_cafe, 3);
        let mut splitter = RowSplitter::default();
        splitter.split(&large, large_rows).expect("split");
        let capacities = |splitter: &RowSplitter| {
            [
                splitter.fixed.capacity(),
                splitter.tags.capacity(),
                splitter.runs.capacity(),
                splitter.colors.capacity(),
                splitter.payload.capacity(),
            ]
        };
        let retained = capacities(&splitter);
        for (rows, row_count) in [(&small, small_rows), (&large, large_rows)] {
            splitter.split(rows, row_count).expect("split");
            assert_eq!(capacities(&splitter), retained);
        }
    }

    #[test]
    fn graphics_sections_and_link_tables_travel_verbatim() {
        let (rows, row_count) = body(0x5eed, 3);
        // Give the middle row a graphics section after its row bytes.
        let mut with_graphics = Vec::new();
        let mut at = 0;
        for row in 0..row_count {
            let len = usize::from(u16::from_be_bytes([rows[at + 6], rows[at + 7]]));
            let mut entry = rows[at..at + ROW_PREFIX_BYTES + len].to_vec();
            at += ROW_PREFIX_BYTES + len;
            if row == 1 {
                let left = u16::from_be_bytes([entry[2], entry[3]]) | ROW_FLAG_GRAPHICS;
                entry[2..4].copy_from_slice(&left.to_be_bytes());
                entry.extend_from_slice(&5u32.to_be_bytes());
                entry.extend_from_slice(b"pixel");
            }
            with_graphics.extend_from_slice(&entry);
        }
        let mut splitter = RowSplitter::default();
        let mut joined = Vec::new();
        let split = splitter.split(&with_graphics, row_count).expect("split");
        join_rows_into(split, row_count, &mut joined).expect("join");
        assert_eq!(joined, with_graphics);
    }

    #[test]
    fn a_damaged_split_payload_is_refused_rather_than_misjoined() {
        let (rows, row_count) = body(0xc0ffee, 12);
        let mut splitter = RowSplitter::default();
        let split = splitter.split(&rows, row_count).expect("split").to_vec();
        let mut joined = Vec::new();
        for cut in [0, 1, 3, split.len() / 2, split.len() - 1] {
            assert!(
                join_rows_into(&split[..cut], row_count, &mut joined).is_err(),
                "cut {cut}"
            );
        }
        let mut longer = split.clone();
        longer.push(0);
        assert!(join_rows_into(&longer, row_count, &mut joined).is_err());
        assert!(join_rows_into(&split, row_count + 1, &mut joined).is_err());
        assert!(join_rows_into(&split, row_count - 1, &mut joined).is_err());
    }

    #[test]
    fn a_body_whose_runs_disagree_with_its_cell_count_is_not_split() {
        let (mut rows, row_count) = body(0xbad, 1);
        let count = u16::from_be_bytes([rows[4], rows[5]]);
        rows[4..6].copy_from_slice(&(count + 1).to_be_bytes());
        assert_eq!(
            RowSplitter::default().split(&rows, row_count),
            Err(CodecErr::InvalidRunLength)
        );
    }
}
