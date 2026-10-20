//! The frame walk: every field of the row layout coded in its own context, in
//! the order the decoder rebuilds the bytes, and references to rows the
//! receiver already holds.

use super::model::{
    AUX, DecodeModel, ESC, EncodeModel, F_BG, F_CODEPOINT, F_COUNT, F_FG, F_GRAPHICS, F_HASH,
    F_LEFT, F_LINK, F_MODE, F_OP, F_ROW, F_RUN, F_SAME_COLOR, F_SEQ, F_SOURCE, F_TAG, decode_model,
    encode_model, key,
};
use super::rans;
use crate::{
    LINK_SPAN_BYTES, LINK_TABLE_COUNT_BYTES, MAX_GRAPHICS_SECTION_BYTES, MAX_TERMINAL_COLUMNS,
    ROW_CELL_COUNT_MASK, ROW_FLAG_GRAPHICS, ROW_FLAG_LINKS, ROW_PREFIX_BYTES,
};

/// Decoded row bytes from which a frame codes with two interleaved states.
/// Below it the second state's four bytes cost more than the overlap buys.
pub const MZ_TWO_STATE_MIN_ROW_BYTES: usize = 128;

const OP_LITERAL: u8 = 0;
const OP_REFERENCE: u8 = 1;
/// The context of a frame's first operation, and a row's first cell tag.
const OP_START: u32 = 2;
const MODE_START: u32 = 2;
const TAG_START: u32 = 0x100;
const HAS_FG: u8 = 1 << 0;
const HAS_BG: u8 = 1 << 1;
const RUN: u8 = 1 << 7;
const COLOR_LITERAL_ESCAPE: u8 = crate::encode::COLOR_LITERAL_ESCAPE;
const COLOR_MODE_LITERAL: u8 = crate::encode::COLOR_MODE_LITERAL;
/// The bytes of a graphics section's length, which the row layout writes
/// after the row's cells.
const GRAPHICS_LENGTH_BYTES: usize = 4;

/// The context of byte `index` of a graphics section, its length included:
/// each length byte its own, then the section's bytes.
#[inline]
#[expect(
    clippy::cast_possible_truncation,
    reason = "the context is at most `GRAPHICS_LENGTH_BYTES`"
)]
fn graphics_aux(index: usize) -> u32 {
    index.min(GRAPHICS_LENGTH_BYTES) as u32
}

/// A row the receiver already holds, standing in for a literal entry: the
/// complete row the entry at `source_row` of the datagram `seq_delta` before
/// this one left behind, which the receiver writes as a full-row entry for the
/// target row. `hash` is [`reference_hash`] of those cells, which the receiver
/// checks before it writes anything, and `full_row_bytes` is the size of that
/// full-row entry in the row layout.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MzReference {
    pub seq_delta: u32,
    pub source_row: u16,
    pub hash: u32,
    pub full_row_bytes: u32,
}

/// Why a payload did not decode.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MzError {
    /// The payload is not one the encoder writes.
    Corrupt,
    /// A reference names a row this receiver does not hold as named: a
    /// datagram that arrived after its sources retired, or a row whose history
    /// the receiver could not keep. The frame is refused like a lost one.
    Unresolved,
}

/// Resolves a reference into a complete row entry.
pub trait MzResolve {
    /// Append the full-row entry for `target_row` holding the cells the
    /// reference names, or refuse it.
    fn resolve(
        &mut self,
        target_row: u16,
        reference: MzReference,
        out: &mut Vec<u8>,
    ) -> Result<(), MzError>;
}

/// The digest a reference carries: the low 32 bits of [`crate::row_hash`].
#[inline]
pub fn reference_hash(cells: &[crate::CellRepr]) -> u32 {
    let [a, b, c, d, ..] = crate::row_hash(cells).to_le_bytes();
    u32::from_le_bytes([a, b, c, d])
}

/// The two-state threshold, decided from what both ends know before decoding.
#[inline]
fn ways(rows_len: usize) -> usize {
    if rows_len >= MZ_TWO_STATE_MIN_ROW_BYTES {
        2
    } else {
        1
    }
}

#[inline]
fn zigzag(value: i32) -> u32 {
    ((value << 1) ^ (value >> 31)).cast_unsigned()
}

#[inline]
fn unzigzag(value: u32) -> i32 {
    (value >> 1).cast_signed() ^ -(value & 1).cast_signed()
}

/// One colour slot's previous colour, carried from cell to cell.
#[derive(Clone, Copy, Default)]
struct SlotColor {
    bytes: [u8; 4],
    /// How many of `bytes` the colour has; zero before the first.
    width: u8,
    /// Whether it repeated the colour before it.
    same: u8,
}

/// The foreground and background slots: their slot context, tag flag and
/// field.
const COLOR_SLOTS: [(u32, u8, u32); 2] = [(0, HAS_FG, F_FG), (1, HAS_BG, F_BG)];

/// Contexts carried from one entry to the next. A reference changes only the
/// operation and row contexts, because the receiver resolves it without
/// walking cells.
#[derive(Clone, Copy)]
pub(super) struct Walk {
    prev_row: u16,
    prev_op: u32,
    prev_mode: u32,
    prev_codepoint: u32,
    colors: [SlotColor; 2],
}

impl Walk {
    pub(super) fn new() -> Self {
        Self {
            prev_row: u16::MAX,
            prev_op: OP_START,
            prev_mode: MODE_START,
            prev_codepoint: 0,
            colors: [SlotColor::default(); 2],
        }
    }
}

#[inline]
fn codepoint_aux(index: u32, first: u32, prev: u32) -> u32 {
    if index == 0 {
        prev << 3
    } else {
        index | first << 3
    }
}

/// The context of whether a slot's colour repeats its previous one: the
/// slot, the colour mode, whether the previous colour repeated too, and that
/// colour's first byte, since some colours repeat far more than others.
#[inline]
fn same_color_aux(slot: u32, mode: u8, prev: &SlotColor) -> u32 {
    slot | u32::from(mode) << 1 | u32::from(prev.same) << 2 | u32::from(prev.bytes[0]) << 3
}

#[inline]
fn color_aux(index: u32, prev: u8, mode: u8, escaped: bool) -> u32 {
    index | u32::from(prev) << 2 | u32::from(mode) << 10 | u32::from(escaped) << 11
}

const _: () = assert!(AUX == 1 << 12, "every context above fits twelve bits");

/// Where a walk's symbols go: coded against the model, or counted.
pub(super) trait Sink {
    fn put(&mut self, key: u32, symbol: u8);
}

fn put_varint(sink: &mut impl Sink, field: u32, mut value: u32) {
    let mut index = 0;
    loop {
        let low = (value & 0x7f) as u8;
        value >>= 7;
        sink.put(key(field, index), if value != 0 { low | 0x80 } else { low });
        index += 1;
        if value == 0 {
            return;
        }
    }
}

fn put_row(walk: &mut Walk, sink: &mut impl Sink, op: u8, row: u16) {
    sink.put(key(F_OP, walk.prev_op), op);
    walk.prev_op = u32::from(op);
    let expected = walk.prev_row.wrapping_add(1);
    put_varint(
        sink,
        F_ROW,
        zigzag(i32::from(row.wrapping_sub(expected).cast_signed())),
    );
    walk.prev_row = row;
}

pub(super) fn put_reference(
    walk: &mut Walk,
    sink: &mut impl Sink,
    row: u16,
    reference: &MzReference,
) {
    put_row(walk, sink, OP_REFERENCE, row);
    put_varint(sink, F_SEQ, reference.seq_delta);
    put_varint(
        sink,
        F_SOURCE,
        zigzag(i32::from(reference.source_row) - i32::from(row)),
    );
    for (index, byte) in (0..).zip(reference.hash.to_be_bytes()) {
        sink.put(key(F_HASH, index), byte);
    }
}

/// Walk the colour at `at` of `body` for one slot, `None` past the body's end.
fn put_color(
    color: &mut SlotColor,
    sink: &mut impl Sink,
    (slot, field): (u32, u32),
    mode: u8,
    body: &[u8],
    at: &mut usize,
) -> Option<()> {
    let width: u8 = if mode == COLOR_MODE_LITERAL {
        3
    } else if *body.get(*at)? == COLOR_LITERAL_ESCAPE {
        4
    } else {
        1
    };
    let bytes = body.get(*at..*at + usize::from(width))?;
    *at += usize::from(width);
    // A colour that repeats the slot's previous one, the common case for a
    // styled run of differing glyphs, is one decision whatever its value; any
    // other is coded byte by byte.
    if color.width != 0 {
        let same = color.width == width && bytes.iter().zip(color.bytes).all(|(&a, b)| a == b);
        sink.put(
            key(F_SAME_COLOR, same_color_aux(slot, mode, color)),
            u8::from(same),
        );
        color.same = u8::from(same);
        if same {
            return Some(());
        }
    }
    for ((index, prev), &byte) in (0..).zip(&mut color.bytes).zip(bytes) {
        let aux = color_aux(index, *prev, mode, index > 0 && width == 4);
        sink.put(key(field, aux), byte);
        *prev = byte;
    }
    color.width = width;
    Some(())
}

/// Walk one literal entry, `entry` its complete row-layout bytes, a graphics
/// section included. `None` when the bytes are not a row the encoder can
/// carry.
pub(super) fn put_literal(walk: &mut Walk, sink: &mut impl Sink, entry: &[u8]) -> Option<()> {
    let prefix: [u8; ROW_PREFIX_BYTES] = entry.get(..ROW_PREFIX_BYTES)?.try_into().ok()?;
    let [
        row_high,
        row_low,
        left_high,
        left_low,
        count_high,
        count_low,
        len_high,
        len_low,
    ] = prefix;
    let left_field = u16::from_be_bytes([left_high, left_low]);
    let count_field = u16::from_be_bytes([count_high, count_low]);
    let body_len = usize::from(u16::from_be_bytes([len_high, len_low]));
    let body = entry.get(ROW_PREFIX_BYTES..ROW_PREFIX_BYTES + body_len)?;
    let graphics = entry.get(ROW_PREFIX_BYTES + body_len..)?;
    if (left_field & ROW_FLAG_GRAPHICS != 0) == graphics.is_empty() {
        return None;
    }
    put_row(
        walk,
        sink,
        OP_LITERAL,
        u16::from_be_bytes([row_high, row_low]),
    );
    sink.put(key(F_LEFT, 0), left_high);
    sink.put(key(F_LEFT, 1 | u32::from(left_high) << 1), left_low);
    sink.put(key(F_COUNT, 0), count_high);
    sink.put(key(F_COUNT, 1 | u32::from(count_high) << 1), count_low);
    let mut at = 0usize;
    if left_field & ROW_FLAG_LINKS != 0 {
        let spans = usize::from(u16::from_be_bytes([*body.first()?, *body.get(1)?]));
        let table = body.get(..LINK_TABLE_COUNT_BYTES + spans * LINK_SPAN_BYTES)?;
        for (aux, &byte) in link_aux().zip(table) {
            sink.put(key(F_LINK, aux), byte);
        }
        at = table.len();
    }
    let mode = *body.get(at)?;
    if mode > COLOR_MODE_LITERAL {
        return None;
    }
    at += 1;
    sink.put(key(F_MODE, walk.prev_mode), mode);
    walk.prev_mode = u32::from(mode);
    let cells = usize::from(count_field & ROW_CELL_COUNT_MASK);
    let mut covered = 0usize;
    let mut prev_tag = TAG_START;
    while covered < cells {
        let tag = *body.get(at)?;
        at += 1;
        sink.put(key(F_TAG, prev_tag), tag);
        prev_tag = u32::from(tag);
        let first = u32::from(*body.get(at)?);
        let mut index = 0u32;
        loop {
            let byte = *body.get(at)?;
            at += 1;
            sink.put(
                key(
                    F_CODEPOINT,
                    codepoint_aux(index, first, walk.prev_codepoint),
                ),
                byte,
            );
            index += 1;
            if byte & 0x80 == 0 {
                break;
            }
        }
        walk.prev_codepoint = first;
        for (color, (slot, flag, field)) in walk.colors.iter_mut().zip(COLOR_SLOTS) {
            if tag & flag != 0 {
                put_color(color, sink, (slot, field), mode, body, &mut at)?;
            }
        }
        covered += if tag & RUN != 0 {
            put_run(sink, body, &mut at)?
        } else {
            1
        };
    }
    if at != body.len() || covered != cells {
        return None;
    }
    for (index, &byte) in graphics.iter().enumerate() {
        sink.put(key(F_GRAPHICS, graphics_aux(index)), byte);
    }
    Some(())
}

/// Walk the run length at `at` of `body`, returning it; `None` for a length
/// the row layout never writes.
fn put_run(sink: &mut impl Sink, body: &[u8], at: &mut usize) -> Option<usize> {
    let (mut value, mut shift, mut index) = (0usize, 0u32, 0u32);
    loop {
        let byte = *body.get(*at)?;
        *at += 1;
        sink.put(key(F_RUN, index), byte);
        value |= usize::from(byte & 0x7f) << shift;
        index += 1;
        if byte & 0x80 == 0 {
            break;
        }
        shift += 7;
        if shift > 28 {
            return None;
        }
    }
    (value != 0).then_some(value)
}

/// The context of each byte of a link table, its count included: its offset
/// within a span.
fn link_aux() -> impl Iterator<Item = u32> {
    (0..).take(LINK_SPAN_BYTES).cycle()
}

/// Split a row-layout payload into its `row_count` entries, each with its
/// graphics section.
pub(super) fn entries(rows: &[u8], row_count: u16) -> impl Iterator<Item = Option<&[u8]>> {
    let mut at = 0usize;
    (0..row_count).map(move |_| {
        let prefix: [u8; ROW_PREFIX_BYTES] =
            rows.get(at..at + ROW_PREFIX_BYTES)?.try_into().ok()?;
        let mut len = ROW_PREFIX_BYTES + usize::from(u16::from_be_bytes([prefix[6], prefix[7]]));
        if u16::from_be_bytes([prefix[2], prefix[3]]) & ROW_FLAG_GRAPHICS != 0 {
            let length = rows.get(at + len..at + len + GRAPHICS_LENGTH_BYTES)?;
            let length = u32::from_be_bytes(length.try_into().ok()?) as usize;
            if length == 0 || length > MAX_GRAPHICS_SECTION_BYTES {
                return None;
            }
            len += GRAPHICS_LENGTH_BYTES + length;
        }
        let entry = rows.get(at..at + len)?;
        at += len;
        Some(entry)
    })
}

struct Coder<'m> {
    model: &'m EncodeModel,
    coded: Vec<u32>,
    /// Running cost of `coded`, in 1/256 bit.
    bits: u64,
}

impl Coder<'_> {
    #[inline(always)]
    #[expect(
        clippy::indexing_slicing,
        clippy::cast_possible_truncation,
        reason = "every position is one `EncodeModel::context` or `field` gave into its arena, \
                  which holds far fewer than 4 Gi symbols"
    )]
    fn push(&mut self, at: usize) -> bool {
        let symbol = &self.model.symbols[at];
        if symbol.x_max == 0 {
            return false;
        }
        self.coded.push(at as u32);
        self.bits += u64::from(symbol.cost);
        true
    }
}

impl Sink for Coder<'_> {
    #[inline]
    fn put(&mut self, key: u32, symbol: u8) {
        let model = self.model;
        if let Some(at) = model.context(key, usize::from(symbol)) {
            if self.push(at) {
                return;
            }
            let escaped = self.push(at - usize::from(symbol) + ESC);
            debug_assert!(escaped, "every context table can escape");
        }
        let coded = self.push(model.field(key, usize::from(symbol)));
        debug_assert!(coded, "a field table codes every byte");
    }
}

/// Reusable MZ encoder state.
#[derive(Default)]
pub struct MzEncoder {
    coded: Vec<u32>,
    scratch: Vec<u8>,
    references_taken: usize,
}

impl MzEncoder {
    /// Code the `row_count` row-layout entries of `rows` into `out`
    /// (appended). `references[i]`, when present, may stand in for entry `i`;
    /// each is taken exactly when it codes smaller than the literal. Returns
    /// the row-layout length the payload decodes to, or `None` when the rows
    /// do not parse.
    pub fn encode(
        &mut self,
        rows: &[u8],
        row_count: u16,
        references: &[Option<MzReference>],
        out: &mut Vec<u8>,
    ) -> Option<usize> {
        let mut coder = Coder {
            model: encode_model(),
            coded: std::mem::take(&mut self.coded),
            bits: 0,
        };
        coder.coded.clear();
        self.references_taken = 0;
        let result = Self::walk(
            &mut coder,
            rows,
            row_count,
            references,
            &mut self.references_taken,
        );
        self.coded = coder.coded;
        let rows_len = result?;
        rans::encode(
            &encode_model().symbols,
            &self.coded,
            ways(rows_len),
            &mut self.scratch,
            out,
        );
        Some(rows_len)
    }

    /// How many entries the last [`Self::encode`] coded as references.
    pub fn references_taken(&self) -> usize {
        self.references_taken
    }

    fn walk(
        coder: &mut Coder<'_>,
        rows: &[u8],
        row_count: u16,
        references: &[Option<MzReference>],
        taken: &mut usize,
    ) -> Option<usize> {
        let mut walk = Walk::new();
        let mut rows_len = 0usize;
        let mut consumed = 0usize;
        for (index, entry) in entries(rows, row_count).enumerate() {
            let entry = entry?;
            consumed += entry.len();
            let row = u16::from_be_bytes([*entry.first()?, *entry.get(1)?]);
            let Some(reference) = references.get(index).copied().flatten() else {
                put_literal(&mut walk, coder, entry)?;
                rows_len += entry.len();
                continue;
            };
            // Exact choice: code the reference, then the literal, and keep the
            // cheaper one. A reference is a handful of symbols, so the retry
            // is the reference, not the row.
            let (start, before, cost_before) = (coder.coded.len(), walk, coder.bits);
            put_reference(&mut walk, coder, row, &reference);
            let (reference_cost, reference_walk) = (coder.bits - cost_before, walk);
            coder.coded.truncate(start);
            coder.bits = cost_before;
            walk = before;
            put_literal(&mut walk, coder, entry)?;
            if coder.bits - cost_before <= reference_cost {
                rows_len += entry.len();
                continue;
            }
            coder.coded.truncate(start);
            coder.bits = cost_before;
            walk = before;
            put_reference(&mut walk, coder, row, &reference);
            debug_assert_eq!(coder.bits - cost_before, reference_cost);
            debug_assert_eq!(walk.prev_op, reference_walk.prev_op);
            rows_len += reference.full_row_bytes as usize;
            *taken += 1;
        }
        // Bytes past the last entry are not a row.
        (consumed == rows.len()).then_some(rows_len)
    }
}

struct Reader<'m, 'b> {
    model: &'m DecodeModel,
    rans: rans::Decoder<'b>,
}

impl Reader<'_, '_> {
    #[inline(always)]
    #[expect(
        clippy::cast_possible_truncation,
        reason = "a context table's symbols are bytes or `ESC`, and a field table's bytes"
    )]
    fn get(&mut self, key: u32) -> u8 {
        let context = self.model.context(key);
        if context != 0 {
            let symbol = self.rans.get(&self.model.slots, context);
            if symbol != ESC {
                return symbol as u8;
            }
        }
        // A field table holds byte symbols only.
        self.rans.get(&self.model.slots, self.model.field(key)) as u8
    }

    fn varint(&mut self, field: u32) -> Result<u32, MzError> {
        let (mut value, mut shift, mut index) = (0u32, 0u32, 0u32);
        loop {
            let byte = self.get(key(field, index));
            value |= u32::from(byte & 0x7f)
                .checked_shl(shift)
                .ok_or(MzError::Corrupt)?;
            index += 1;
            if byte & 0x80 == 0 {
                return Ok(value);
            }
            shift += 7;
            if shift > 28 {
                return Err(MzError::Corrupt);
            }
        }
    }
}

/// Decode an MZ payload of `row_count` entries into `out` (cleared first),
/// which must come to exactly `rows_len` row-layout bytes. References resolve
/// through `resolve`. The output is not validated: the caller's row validator
/// reads it as it reads any frame.
pub fn decode_mz_rows(
    payload: &[u8],
    row_count: u16,
    rows_len: usize,
    resolve: &mut impl MzResolve,
    out: &mut Vec<u8>,
) -> Result<(), MzError> {
    out.clear();
    out.reserve(rows_len);
    decode(payload, row_count, rows_len, rows_len, resolve, out)?;
    if out.len() != rows_len {
        return Err(MzError::Corrupt);
    }
    Ok(())
}

/// An MZ payload's literal entries, decoded into `literals` (cleared first)
/// as the row layout writes them, and the target rows of its references in
/// `references` (cleared first), without resolving them: what a reader that
/// only inspects the rows a frame carries needs. `literals` holds
/// `row_count - references.len()` entries.
pub fn mz_literal_entries(
    payload: &[u8],
    row_count: u16,
    rows_len: usize,
    references: &mut Vec<u16>,
    literals: &mut Vec<u8>,
) -> Result<(), MzError> {
    struct Skip<'a>(&'a mut Vec<u16>);
    impl MzResolve for Skip<'_> {
        fn resolve(&mut self, row: u16, _: MzReference, _: &mut Vec<u8>) -> Result<(), MzError> {
            self.0.push(row);
            Ok(())
        }
    }
    references.clear();
    literals.clear();
    decode(
        payload,
        row_count,
        rows_len,
        rows_len,
        &mut Skip(references),
        literals,
    )
}

fn decode(
    payload: &[u8],
    row_count: u16,
    rows_len: usize,
    limit: usize,
    resolve: &mut impl MzResolve,
    out: &mut Vec<u8>,
) -> Result<(), MzError> {
    let mut reader = Reader {
        model: decode_model(),
        rans: rans::Decoder::new(payload, ways(rows_len)).ok_or(MzError::Corrupt)?,
    };
    let mut walk = Walk::new();
    for _ in 0..row_count {
        let op = reader.get(key(F_OP, walk.prev_op));
        walk.prev_op = u32::from(op);
        let expected = walk.prev_row.wrapping_add(1);
        // The encoder codes a row as its 16-bit wrapping distance.
        let Ok(delta) = i16::try_from(unzigzag(reader.varint(F_ROW)?)) else {
            return Err(MzError::Corrupt);
        };
        let row = expected.wrapping_add(delta.cast_unsigned());
        walk.prev_row = row;
        match op {
            OP_REFERENCE => {
                let seq_delta = reader.varint(F_SEQ)?;
                let source = i32::from(row) + unzigzag(reader.varint(F_SOURCE)?);
                let Ok(source_row) = u16::try_from(source) else {
                    return Err(MzError::Corrupt);
                };
                let mut hash = [0u8; 4];
                for (index, byte) in (0..).zip(&mut hash) {
                    *byte = reader.get(key(F_HASH, index));
                }
                if seq_delta == 0 {
                    return Err(MzError::Corrupt);
                }
                resolve.resolve(
                    row,
                    MzReference {
                        seq_delta,
                        source_row,
                        hash: u32::from_be_bytes(hash),
                        full_row_bytes: 0,
                    },
                    out,
                )?;
            }
            OP_LITERAL => decode_literal(&mut reader, &mut walk, row, limit, out)?,
            _ => return Err(MzError::Corrupt),
        }
        if out.len() > limit {
            return Err(MzError::Corrupt);
        }
    }
    if !reader.rans.finish() {
        return Err(MzError::Corrupt);
    }
    Ok(())
}

fn decode_literal(
    reader: &mut Reader<'_, '_>,
    walk: &mut Walk,
    row: u16,
    rows_len: usize,
    out: &mut Vec<u8>,
) -> Result<(), MzError> {
    let start = out.len();
    out.extend_from_slice(&row.to_be_bytes());
    let left_high = reader.get(key(F_LEFT, 0));
    let left_low = reader.get(key(F_LEFT, 1 | u32::from(left_high) << 1));
    let count_high = reader.get(key(F_COUNT, 0));
    let count_low = reader.get(key(F_COUNT, 1 | u32::from(count_high) << 1));
    out.extend_from_slice(&[left_high, left_low, count_high, count_low, 0, 0]);
    let left_field = u16::from_be_bytes([left_high, left_low]);
    let count_field = u16::from_be_bytes([count_high, count_low]);
    let cells = usize::from(count_field & ROW_CELL_COUNT_MASK);
    if cells == 0 || cells > MAX_TERMINAL_COLUMNS {
        return Err(MzError::Corrupt);
    }
    let body_start = out.len();
    if left_field & ROW_FLAG_LINKS != 0 {
        let high = reader.get(key(F_LINK, 0));
        let low = reader.get(key(F_LINK, 1));
        out.extend_from_slice(&[high, low]);
        let spans = usize::from(u16::from_be_bytes([high, low]));
        // A span covers at least one cell.
        if spans > cells {
            return Err(MzError::Corrupt);
        }
        for aux in link_aux()
            .skip(LINK_TABLE_COUNT_BYTES)
            .take(spans * LINK_SPAN_BYTES)
        {
            out.push(reader.get(key(F_LINK, aux)));
        }
    }
    let mode = reader.get(key(F_MODE, walk.prev_mode));
    walk.prev_mode = u32::from(mode);
    if mode > COLOR_MODE_LITERAL {
        return Err(MzError::Corrupt);
    }
    out.push(mode);
    let mut covered = 0usize;
    let mut prev_tag = TAG_START;
    while covered < cells {
        if out.len() > rows_len {
            return Err(MzError::Corrupt);
        }
        let tag = reader.get(key(F_TAG, prev_tag));
        prev_tag = u32::from(tag);
        out.push(tag);
        let mut first = 0u32;
        let mut index = 0u32;
        loop {
            let byte = reader.get(key(
                F_CODEPOINT,
                codepoint_aux(index, first, walk.prev_codepoint),
            ));
            if index == 0 {
                first = u32::from(byte);
            }
            out.push(byte);
            index += 1;
            if byte & 0x80 == 0 {
                break;
            }
            if index == 5 {
                return Err(MzError::Corrupt);
            }
        }
        walk.prev_codepoint = first;
        for (color, (slot, flag, field)) in walk.colors.iter_mut().zip(COLOR_SLOTS) {
            if tag & flag != 0 {
                decode_color(reader, color, (slot, field), mode, out)?;
            }
        }
        let length = if tag & RUN != 0 {
            decode_run(reader, out)?
        } else {
            1
        };
        covered += length;
    }
    if covered != cells {
        return Err(MzError::Corrupt);
    }
    let Ok(body_len) = u16::try_from(out.len() - body_start) else {
        return Err(MzError::Corrupt);
    };
    out.get_mut(start + 6..start + 8)
        .ok_or(MzError::Corrupt)?
        .copy_from_slice(&body_len.to_be_bytes());
    if left_field & ROW_FLAG_GRAPHICS != 0 {
        decode_graphics(reader, rows_len, out)?;
    }
    Ok(())
}

/// Decode one slot's colour into `out`.
fn decode_color(
    reader: &mut Reader<'_, '_>,
    color: &mut SlotColor,
    (slot, field): (u32, u32),
    mode: u8,
    out: &mut Vec<u8>,
) -> Result<(), MzError> {
    if color.width != 0 {
        let same = reader.get(key(F_SAME_COLOR, same_color_aux(slot, mode, color)));
        if same > 1 {
            return Err(MzError::Corrupt);
        }
        color.same = same;
        if same == 1 {
            out.extend(color.bytes.iter().take(usize::from(color.width)));
            return Ok(());
        }
    }
    let mut width: u8 = if mode == COLOR_MODE_LITERAL { 3 } else { 1 };
    for (index, prev) in (0..).zip(&mut color.bytes) {
        if index == u32::from(width) {
            break;
        }
        let byte = reader.get(key(field, color_aux(index, *prev, mode, width == 4)));
        if index == 0 && mode != COLOR_MODE_LITERAL && byte == COLOR_LITERAL_ESCAPE {
            width = 4;
        }
        *prev = byte;
        out.push(byte);
    }
    color.width = width;
    Ok(())
}

/// Decode a run's length into `out`, returning it.
fn decode_run(reader: &mut Reader<'_, '_>, out: &mut Vec<u8>) -> Result<usize, MzError> {
    let (mut value, mut shift, mut index) = (0usize, 0u32, 0u32);
    loop {
        let byte = reader.get(key(F_RUN, index));
        out.push(byte);
        value |= usize::from(byte & 0x7f) << shift;
        index += 1;
        if byte & 0x80 == 0 {
            break;
        }
        shift += 7;
        if shift > 14 {
            return Err(MzError::Corrupt);
        }
    }
    if value == 0 {
        return Err(MzError::Corrupt);
    }
    Ok(value)
}

/// Decode a row's graphics section, its length first, into `out`.
fn decode_graphics(
    reader: &mut Reader<'_, '_>,
    rows_len: usize,
    out: &mut Vec<u8>,
) -> Result<(), MzError> {
    let mut length = [0u8; GRAPHICS_LENGTH_BYTES];
    for (index, byte) in length.iter_mut().enumerate() {
        *byte = reader.get(key(F_GRAPHICS, graphics_aux(index)));
    }
    out.extend_from_slice(&length);
    let length = u32::from_be_bytes(length) as usize;
    // Bound the section before decoding it: the bytes come from the payload,
    // and a length past the frame is corrupt.
    if length == 0 || length > MAX_GRAPHICS_SECTION_BYTES || out.len() + length > rows_len {
        return Err(MzError::Corrupt);
    }
    for index in GRAPHICS_LENGTH_BYTES..GRAPHICS_LENGTH_BYTES + length {
        out.push(reader.get(key(F_GRAPHICS, graphics_aux(index))));
    }
    Ok(())
}

/// Append the complete full-row entry for `row` holding `cells`, as the row
/// layout writes it.
#[expect(
    clippy::indexing_slicing,
    clippy::cast_possible_truncation,
    reason = "the length slot was just written, and a row's cells fit the layout's \
              16-bit body length, as every row encoder relies on"
)]
pub fn encode_full_row_entry(out: &mut Vec<u8>, row: u16, cells: &[crate::CellRepr]) {
    out.extend_from_slice(&row.to_be_bytes());
    out.extend_from_slice(&crate::row_left_field(0, cells).to_be_bytes());
    out.extend_from_slice(&crate::row_cell_count_field(cells).to_be_bytes());
    let count_at = out.len();
    out.extend_from_slice(&[0, 0]);
    let body_start = out.len();
    crate::encode_cells(out, cells);
    let body_len = (out.len() - body_start) as u16;
    out[count_at..count_at + 2].copy_from_slice(&body_len.to_be_bytes());
}

/// The size [`encode_full_row_entry`] writes for `cells`.
pub fn full_row_entry_bytes(cells: &[crate::CellRepr]) -> usize {
    ROW_PREFIX_BYTES + crate::encoded_cells_size(cells)
}
