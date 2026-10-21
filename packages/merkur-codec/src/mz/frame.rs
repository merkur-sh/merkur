//! The frame walk: every field of the row layout coded in its own adaptive
//! context, in the order the decoder rebuilds the bytes, with copies of items
//! the receiver already holds — earlier in the same frame, or in a complete row
//! of an acknowledged datagram.
//!
//! One generic walk serves the encoder, its cost estimate and the decoder, so
//! the two ends cannot disagree on what a field is or where it is coded.

use super::model::{
    F_BACK, F_BLOCK, F_BLOCK_MTF, F_COLOR_MTF, F_COUNT, F_DCOLOR, F_GRAPHICS, F_ITEMS, F_LEFT,
    F_LINK, F_LOW7, F_MODE, F_PALETTE, F_ROW, F_RUN, F_SAME_BLOCK, F_SEG, F_SEQ, F_SRC_ITEM,
    F_SRC_KIND, F_SRC_ROW, F_TAG, Prior, key, static_model,
};
use super::nibble::{self, Coder, Decoder, Tables};
use super::session::{Layered, MzEpochDeclaration, SessionModel};
use crate::varint::{decode_varint_u32, encode_varint_u32};
use crate::{
    LINK_SPAN_BYTES, LINK_TABLE_COUNT_BYTES, MAX_GRAPHICS_SECTION_BYTES, MAX_TERMINAL_COLUMNS,
    ROW_CELL_COUNT_MASK, ROW_FLAG_GRAPHICS, ROW_FLAG_LINKS, ROW_PREFIX_BYTES,
};

/// Decoded row bytes from which a frame codes with two interleaved states.
/// Below it the second state's four bytes cost more than the overlap buys.
pub const MZ_TWO_STATE_MIN_ROW_BYTES: usize = 128;

const HAS_FG: u8 = crate::cell::HAS_FG;
const HAS_BG: u8 = crate::cell::HAS_BG;
const RLE: u8 = crate::cell::RLE;
const COLOR_LITERAL_ESCAPE: u8 = crate::encode::COLOR_LITERAL_ESCAPE;
const COLOR_MODE_LITERAL: u8 = crate::encode::COLOR_MODE_LITERAL;
/// The bytes of a graphics section's length, which the row layout writes
/// after the row's cells.
const GRAPHICS_LENGTH_BYTES: usize = 4;

const SEG_ITEM: u8 = 0;
const SEG_COPY: u8 = 1;
const SEG_REPCOPY: u8 = 2;
/// The segment context at the start of a row.
const SEG_START: u32 = 3;
/// The prior byte's flag: an epoch declaration follows it.
const DECLARATION: u8 = 0x80;
const SRC_FRAME: u8 = 0;
const SRC_HISTORY: u8 = 1;
/// A colour's recency hit is its position; these are its misses.
const COLOR_RECENT: usize = 8;
const COLOR_MISS_PALETTE: u8 = 8;
const COLOR_MISS_RGB: u8 = 9;
/// Recent character blocks a new block is coded against; 15 is a miss.
const BLOCKS_RECENT: usize = 15;
const BLOCK_MISS: u8 = 15;
/// The fewest items a copy covers.
const COPY_MIN_ITEMS: usize = 2;

/// Why a payload did not decode.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MzError {
    /// The payload is not one the encoder writes.
    Corrupt,
    /// A copy or prior names something this receiver does not hold: a row
    /// whose datagram retired, or a session epoch it never built. The frame is
    /// refused like a lost one.
    Unresolved,
}

/// One item of a row-layout entry: where its bytes end within the entry, and
/// how many cells the entry's items through it cover.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MzItem {
    pub end: u16,
    pub cells: u16,
}

/// A row-layout entry seen as items, for copies out of it.
#[derive(Clone, Copy)]
pub struct MzRow<'a> {
    pub entry: &'a [u8],
    /// Where the first item starts.
    pub first: u16,
    pub items: &'a [MzItem],
    pub mode: u8,
    /// Each item's [`item_hash`], where the encoder keeps them; empty where a
    /// row is only read.
    pub hashes: &'a [u64],
}

impl MzRow<'_> {
    #[inline]
    fn item_start(&self, item: usize) -> usize {
        if item == 0 {
            usize::from(self.first)
        } else {
            self.items.get(item - 1).map_or(usize::MAX, |it| usize::from(it.end))
        }
    }

    #[inline]
    fn cells_before(&self, item: usize) -> u16 {
        if item == 0 { 0 } else { self.items.get(item - 1).map_or(0, |it| it.cells) }
    }

    /// The bytes and cells of items `from..from + count`, or `None` past the
    /// row's items.
    #[inline]
    fn span(&self, from: usize, count: usize) -> Option<(&[u8], u16)> {
        let last = self.items.get((from + count).checked_sub(1)?)?;
        let start = self.item_start(from);
        let bytes = self.entry.get(start..usize::from(last.end))?;
        Some((bytes, last.cells - self.cells_before(from)))
    }

    #[inline]
    fn item_bytes(&self, item: usize) -> Option<&[u8]> {
        self.entry.get(self.item_start(item)..usize::from(self.items.get(item)?.end))
    }
}

/// Parse `entry`'s items into `items` (cleared first): `(first item offset,
/// mode)`, or `None` for bytes that are not a row-layout entry.
pub fn entry_items(entry: &[u8], items: &mut Vec<MzItem>) -> Option<(u16, u8)> {
    items.clear();
    let prefix: &[u8; ROW_PREFIX_BYTES] = entry.get(..ROW_PREFIX_BYTES)?.try_into().ok()?;
    let left_field = u16::from_be_bytes([prefix[2], prefix[3]]);
    let cells = usize::from(u16::from_be_bytes([prefix[4], prefix[5]]) & ROW_CELL_COUNT_MASK);
    let body_end = ROW_PREFIX_BYTES + usize::from(u16::from_be_bytes([prefix[6], prefix[7]]));
    let mut at = ROW_PREFIX_BYTES;
    if left_field & ROW_FLAG_LINKS != 0 {
        let spans = usize::from(u16::from_be_bytes([*entry.get(at)?, *entry.get(at + 1)?]));
        at += LINK_TABLE_COUNT_BYTES + spans * LINK_SPAN_BYTES;
    }
    let mode = *entry.get(at)?;
    if mode > COLOR_MODE_LITERAL {
        return None;
    }
    at += 1;
    let first = u16::try_from(at).ok()?;
    let mut covered = 0usize;
    while covered < cells {
        let tag = *entry.get(at)?;
        at += 1;
        decode_varint_u32(entry, &mut at).ok()?;
        for flag in [HAS_FG, HAS_BG] {
            if tag & flag != 0 {
                at += color_width(mode, *entry.get(at)?);
            }
        }
        covered += if tag & RLE != 0 {
            decode_varint_u32(entry, &mut at).ok()? as usize
        } else {
            1
        };
        items.push(MzItem {
            end: u16::try_from(at).ok()?,
            cells: u16::try_from(covered).ok()?,
        });
    }
    (covered == cells && at == body_end && at <= entry.len()).then_some((first, mode))
}

#[inline]
fn color_width(mode: u8, first: u8) -> usize {
    if mode == COLOR_MODE_LITERAL {
        3
    } else if first == COLOR_LITERAL_ESCAPE {
        4
    } else {
        1
    }
}

/// Pair hashes are already uniform: the map keys on them as they are.
#[derive(Default)]
struct PairHasher(u64);

impl std::hash::Hasher for PairHasher {
    fn finish(&self) -> u64 {
        self.0
    }

    fn write(&mut self, bytes: &[u8]) {
        for &byte in bytes {
            self.0 = self.0.rotate_left(8) ^ u64::from(byte);
        }
    }

    fn write_u64(&mut self, value: u64) {
        self.0 = value;
    }
}

type BuildPair = std::hash::BuildHasherDefault<PairHasher>;

/// The hash a copy is found by: of one item's bytes.
#[inline]
pub fn item_hash(bytes: &[u8]) -> u64 {
    xxhash_rust::xxh3::xxh3_64(bytes)
}

/// The hash of two consecutive items, which every copy starts with.
#[inline]
pub fn pair_hash(first: u64, second: u64) -> u64 {
    first ^ second.rotate_left(29).wrapping_mul(0x9e37_79b9_7f4a_7c15)
}

/// What a receiver holds for copies and priors.
pub trait MzSources {
    /// The complete row datagram `presentation_id - seq_delta` carried at
    /// `row`, as items; `Unresolved` when it is not held.
    fn row(&self, seq_delta: u32, row: u16) -> Result<MzRow<'_>, MzError>;
    /// Session epoch `id`, when held.
    fn epoch(&self, id: u8) -> Option<&SessionModel>;
}

/// A place a run of items might be copied from: item `item` of the complete
/// row datagram `seq_delta` back carried at `row`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MzCandidate {
    pub seq_delta: u32,
    pub row: u16,
    pub item: u16,
}

/// What the encoder may copy from beyond its own frame: complete rows the
/// receiver holds, found by the pair hash of the items a copy starts with.
pub trait MzMatches {
    fn candidates(&self, pair: u64, out: &mut Vec<MzCandidate>);
    fn row(&self, seq_delta: u32, row: u16) -> Option<MzRow<'_>>;
}

/// No history: copies come only from the frame itself.
pub struct NoHistory;

impl MzMatches for NoHistory {
    fn candidates(&self, _: u64, _: &mut Vec<MzCandidate>) {}
    fn row(&self, _: u32, _: u16) -> Option<MzRow<'_>> {
        None
    }
}

#[inline]
fn ways(rows_len: usize) -> usize {
    if rows_len >= MZ_TWO_STATE_MIN_ROW_BYTES { 2 } else { 1 }
}

#[inline]
fn zigzag(value: i32) -> u32 {
    ((value << 1) ^ (value >> 31)).cast_unsigned()
}

#[inline]
fn unzigzag(value: u32) -> i32 {
    (value >> 1).cast_signed() ^ -(value & 1).cast_signed()
}

/// A colour channel's wrapping difference, zigzagged into a byte.
#[inline]
fn zigzag8(value: i8) -> u8 {
    ((value << 1) ^ (value >> 7)).cast_unsigned()
}

#[inline]
fn unzigzag8(value: u8) -> i8 {
    (value >> 1).cast_signed() ^ -(value & 1).cast_signed()
}

/// The class of a 128-character block: ASCII, alphabets, CJK and Hangul,
/// and symbols (punctuation, box drawing, braille, emoji).
#[inline]
fn block_class(block: u32) -> u32 {
    match block {
        0 => 0,
        0x01..=0x3f => 1,
        0x60..=0x1ff => 2,
        _ => 3,
    }
}

/// A colour as a slot remembers it: a palette index, or 24-bit with bit 24.
type Color = u32;
const RGB: Color = 1 << 24;

/// One colour slot's recent colours, most recent first.
#[derive(Clone, Copy)]
struct Slot {
    recent: [Color; COLOR_RECENT],
    len: u8,
    last_rgb: [u8; 3],
    prev_symbol: u8,
}

#[expect(
    clippy::indexing_slicing,
    reason = "`len` never exceeds `COLOR_RECENT`, the array's length, and a promoted \
              colour's position is below it"
)]
impl Slot {
    const fn new() -> Self {
        Self {
            recent: [0; COLOR_RECENT],
            len: 0,
            last_rgb: [0; 3],
            prev_symbol: COLOR_MISS_RGB + 1,
        }
    }

    #[inline]
    fn position(&self, color: Color) -> Option<usize> {
        self.recent[..usize::from(self.len)].iter().position(|&c| c == color)
    }

    #[inline]
    fn promote(&mut self, color: Color, at: Option<usize>) {
        let end = at.unwrap_or_else(|| {
            if usize::from(self.len) < COLOR_RECENT {
                self.len += 1;
            }
            usize::from(self.len) - 1
        });
        self.recent.copy_within(0..end, 1);
        self.recent[0] = color;
    }
}

/// A copy's displacement: what a repeated copy reuses.
#[derive(Clone, Copy, PartialEq, Eq)]
struct Displacement {
    kind: u8,
    /// Entries back within the frame, or datagrams back.
    back: u32,
    /// Source row minus target row (history only).
    row_offset: i32,
    /// Source item minus target item.
    item_offset: i32,
}

impl Displacement {
    const NONE: Self = Self { kind: 0, back: 0, row_offset: 0, item_offset: 0 };
}

/// Contexts carried through a frame.
#[derive(Clone, Copy)]
struct Walk {
    prev_row: u16,
    prev_mode: u32,
    prev_tag: u32,
    prev_cp: u32,
    prev_same: u32,
    blocks: [u32; BLOCKS_RECENT],
    blocks_len: u8,
    slots: [Slot; 2],
    prev_seg: u32,
    prev_kind: u32,
    last_copy: Option<Displacement>,
}

impl Walk {
    fn new() -> Self {
        Self {
            prev_row: u16::MAX,
            prev_mode: 2,
            prev_tag: 0x100,
            prev_cp: u32::from(b' '),
            prev_same: 2,
            blocks: [0; BLOCKS_RECENT],
            blocks_len: 1,
            slots: [Slot::new(); 2],
            prev_seg: SEG_START,
            prev_kind: 2,
            last_copy: None,
        }
    }
}

/// How the walk codes a value: the encoder codes the value it is given, the
/// estimate prices it, the decoder decodes one. `ENCODE` says whether the
/// walk reads values from the source bytes or writes them to the output.
trait Io {
    const ENCODE: bool;
    fn nibble(&mut self, key: u32, v: u8) -> u8;
    fn byte(&mut self, key: u32, v: u8) -> u8;
}

/// Pack a coded symbol for a session fold: `key << 9 | low << 8 | h << 4 | s`.
#[inline]
fn trace_entry(key: u32, low: bool, h: u8, s: u8) -> u32 {
    key << 9 | u32::from(low) << 8 | u32::from(h) << 4 | u32::from(s)
}

struct EncodeIo<'c, 'p, P: Prior> {
    coder: &'c mut Coder<'p, P>,
    trace: Option<&'c mut Vec<u32>>,
}

impl<P: Prior> Io for EncodeIo<'_, '_, P> {
    const ENCODE: bool = true;

    #[inline]
    fn nibble(&mut self, key: u32, v: u8) -> u8 {
        self.coder.nibble(key, v);
        if let Some(trace) = self.trace.as_deref_mut() {
            trace.push(trace_entry(key, false, 0, v));
        }
        v
    }

    #[inline]
    fn byte(&mut self, key: u32, v: u8) -> u8 {
        self.coder.byte(key, v);
        if let Some(trace) = self.trace.as_deref_mut() {
            trace.push(trace_entry(key, false, 0, v >> 4));
            trace.push(trace_entry(key, true, v >> 4, v & 15));
        }
        v
    }
}

/// Prices values against the tables as they stand, changing nothing.
struct EstimateIo<'c, 'p, P: Prior> {
    coder: &'c mut Coder<'p, P>,
    bits: u64,
}

impl<P: Prior> Io for EstimateIo<'_, '_, P> {
    const ENCODE: bool = true;

    #[inline]
    fn nibble(&mut self, key: u32, v: u8) -> u8 {
        self.bits += u64::from(self.coder.nibble_cost(key, v));
        v
    }

    #[inline]
    fn byte(&mut self, key: u32, v: u8) -> u8 {
        self.bits += u64::from(self.coder.byte_cost(key, v));
        v
    }
}

struct DecodeIo<'d, 'p, 'b, P: Prior> {
    decoder: &'d mut Decoder<'p, 'b, P>,
    trace: Option<&'d mut Vec<u32>>,
}

impl<P: Prior> Io for DecodeIo<'_, '_, '_, P> {
    const ENCODE: bool = false;

    #[inline]
    fn nibble(&mut self, key: u32, _: u8) -> u8 {
        let v = self.decoder.nibble(key);
        if let Some(trace) = self.trace.as_deref_mut() {
            trace.push(trace_entry(key, false, 0, v));
        }
        v
    }

    #[inline]
    fn byte(&mut self, key: u32, _: u8) -> u8 {
        let v = self.decoder.byte(key);
        if let Some(trace) = self.trace.as_deref_mut() {
            trace.push(trace_entry(key, false, 0, v >> 4));
            trace.push(trace_entry(key, true, v >> 4, v & 15));
        }
        v
    }
}

/// Where the walk reads values (encoding) and writes bytes (decoding).
struct Cursor<'s> {
    src: &'s [u8],
    at: usize,
}

impl Cursor<'_> {
    #[inline]
    fn next(&mut self) -> Result<u8, MzError> {
        let byte = *self.src.get(self.at).ok_or(MzError::Corrupt)?;
        self.at += 1;
        Ok(byte)
    }
}

/// Code a varint, its bytes in `field` by index from `aux`.
#[inline]
fn varint<I: Io>(io: &mut I, field: u32, aux: u32, value: u32) -> Result<u32, MzError> {
    let mut out = 0u32;
    let mut remaining = value;
    for index in 0..5u32 {
        let v = if I::ENCODE {
            let low = (remaining & 0x7f) as u8;
            remaining >>= 7;
            if remaining != 0 { low | 0x80 } else { low }
        } else {
            0
        };
        let byte = io.byte(key(field, aux | index), v);
        out |= u32::from(byte & 0x7f) << (7 * index);
        if byte & 0x80 == 0 {
            return Ok(out);
        }
    }
    Err(MzError::Corrupt)
}

/// Walk one literal item: from `cur` when encoding, onto `out` when decoding.
/// Returns the cells it covers.
#[inline]
#[expect(
    clippy::indexing_slicing,
    reason = "`blocks_len` never exceeds `BLOCKS_RECENT`, the array's length"
)]
fn item<I: Io>(io: &mut I, walk: &mut Walk, mode: u8, cur: &mut Cursor<'_>, out: &mut Vec<u8>) -> Result<u16, MzError> {
    let tag = io.byte(key(F_TAG, walk.prev_tag), if I::ENCODE { cur.next()? } else { 0 });
    walk.prev_tag = u32::from(tag);
    if !I::ENCODE {
        out.push(tag);
    }
    // The character: whether it stays in its predecessor's block, which block
    // if not, then its low seven bits.
    let cp = if I::ENCODE {
        decode_varint_u32(cur.src, &mut cur.at).ok().ok_or(MzError::Corrupt)?
    } else {
        0
    };
    let (block, low7) = (cp >> 7, (cp & 0x7f) as u8);
    let prev_block = walk.prev_cp >> 7;
    let same = io.nibble(
        key(F_SAME_BLOCK, walk.prev_same | block_class(prev_block) << 2),
        u8::from(block == prev_block),
    );
    if same > 1 {
        return Err(MzError::Corrupt);
    }
    let block = if same == 1 {
        prev_block
    } else {
        let recent = &walk.blocks[..usize::from(walk.blocks_len)];
        let position = if I::ENCODE {
            recent
                .iter()
                .position(|&b| b == block)
                .and_then(|p| u8::try_from(p).ok())
                .unwrap_or(BLOCK_MISS)
        } else {
            0
        };
        let position = io.nibble(key(F_BLOCK_MTF, block_class(prev_block)), position);
        if position == BLOCK_MISS {
            varint(io, F_BLOCK, 0, block)?
        } else {
            *recent.get(usize::from(position)).ok_or(MzError::Corrupt)?
        }
    };
    let low7 = io.byte(
        key(F_LOW7, block_class(block) << 8 | u32::from(same) << 7 | (walk.prev_cp & 0x7f)),
        low7,
    );
    if low7 > 0x7f || block > 0x10ffff >> 7 {
        return Err(MzError::Corrupt);
    }
    let cp = block << 7 | u32::from(low7);
    if !I::ENCODE {
        encode_varint_u32(out, cp);
    }
    // Move the block to the front of the recent blocks.
    let end = walk.blocks[..usize::from(walk.blocks_len)]
        .iter()
        .position(|&b| b == block)
        .unwrap_or_else(|| {
            if usize::from(walk.blocks_len) < BLOCKS_RECENT {
                walk.blocks_len += 1;
            }
            usize::from(walk.blocks_len) - 1
        });
    walk.blocks.copy_within(0..end, 1);
    walk.blocks[0] = block;
    walk.prev_same = u32::from(same);
    walk.prev_cp = cp;
    // Colours.
    for (slot_index, flag) in [(0u32, HAS_FG), (1, HAS_BG)] {
        if tag & flag != 0 {
            color(io, walk, slot_index, mode, cur, out)?;
        }
    }
    // A run's length.
    if tag & RLE == 0 {
        return Ok(1);
    }
    let run = if I::ENCODE {
        decode_varint_u32(cur.src, &mut cur.at).ok().ok_or(MzError::Corrupt)?
    } else {
        0
    };
    let run = varint(io, F_RUN, 0, run)?;
    if !I::ENCODE {
        encode_varint_u32(out, run);
    }
    match u16::try_from(run) {
        Ok(run) if run != 0 && usize::from(run) <= MAX_TERMINAL_COLUMNS => Ok(run),
        _ => Err(MzError::Corrupt),
    }
}

#[inline]
fn color<I: Io>(io: &mut I, walk: &mut Walk, slot_index: u32, mode: u8, cur: &mut Cursor<'_>, out: &mut Vec<u8>) -> Result<(), MzError> {
    let slot = walk.slots.get_mut(slot_index as usize).ok_or(MzError::Corrupt)?;
    let value: Color = if I::ENCODE {
        let first = cur.next()?;
        if mode == COLOR_MODE_LITERAL {
            RGB | u32::from(first) << 16 | u32::from(cur.next()?) << 8 | u32::from(cur.next()?)
        } else if first == COLOR_LITERAL_ESCAPE {
            RGB | u32::from(cur.next()?) << 16 | u32::from(cur.next()?) << 8 | u32::from(cur.next()?)
        } else {
            u32::from(first)
        }
    } else {
        0
    };
    let position = slot.position(value);
    let symbol = match position.and_then(|p| u8::try_from(p).ok()) {
        Some(p) => p,
        None if value & RGB != 0 => COLOR_MISS_RGB,
        None => COLOR_MISS_PALETTE,
    };
    let symbol = io.nibble(
        key(F_COLOR_MTF, slot_index | u32::from(mode) << 1 | u32::from(slot.prev_symbol) << 2),
        symbol,
    );
    slot.prev_symbol = symbol;
    let held = (symbol < slot.len).then(|| slot.recent.get(usize::from(symbol)).copied()).flatten();
    let (value, at) = match (held, symbol) {
        (Some(color), hit) => (color, Some(usize::from(hit))),
        (None, COLOR_MISS_PALETTE) => {
            let index = io.byte(key(F_PALETTE, slot_index), value.to_be_bytes()[3]);
            if mode == COLOR_MODE_LITERAL || index == COLOR_LITERAL_ESCAPE {
                return Err(MzError::Corrupt);
            }
            (u32::from(index), None)
        }
        (None, COLOR_MISS_RGB) => {
            let [_, red, green, blue] = value.to_be_bytes();
            let mut rgb = [0u8; 3];
            let mut prev_class = 0u32;
            for (((channel, &v), last), out) in (0u32..).zip(&[red, green, blue]).zip(slot.last_rgb).zip(&mut rgb) {
                let zz = io.byte(
                    key(F_DCOLOR, slot_index | channel << 1 | prev_class << 3),
                    zigzag8(v.wrapping_sub(last).cast_signed()),
                );
                prev_class = u32::from(zz).min(15);
                *out = last.wrapping_add(unzigzag8(zz).cast_unsigned());
            }
            slot.last_rgb = rgb;
            let [red, green, blue] = rgb;
            (u32::from_be_bytes([1, red, green, blue]), None)
        }
        _ => return Err(MzError::Corrupt),
    };
    slot.promote(value, at);
    if !I::ENCODE {
        let [_, red, green, blue] = value.to_be_bytes();
        if value & RGB == 0 {
            if mode == COLOR_MODE_LITERAL {
                return Err(MzError::Corrupt);
            }
            out.push(blue);
        } else {
            if mode != COLOR_MODE_LITERAL {
                out.push(COLOR_LITERAL_ESCAPE);
            }
            out.extend_from_slice(&[red, green, blue]);
        }
    }
    Ok(())
}

/// A copy the encoder found: `count` items from the frame's entry `back`
/// entries before this one, or from a held row, from source item `item`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Seg {
    Copy { kind: u8, back: u32, row: u16, item: u16, count: u16 },
}

/// Code a copy's segment and fields. `target_row` and `target_item` place
/// the target; the returned displacement is what a repeated copy reuses.
#[inline]
fn copy_fields<I: Io>(
    io: &mut I,
    walk: &mut Walk,
    target_row: u16,
    target_item: usize,
    planned: Option<(u8, u32, u16, u16, u16)>,
) -> Result<(Displacement, usize), MzError> {
    let (kind, back, row, item, count) = planned.unwrap_or((0, 0, 0, 0, 0));
    let item_offset = i32::from(item) - i32::try_from(target_item).ok().ok_or(MzError::Corrupt)?;
    let displacement = Displacement {
        kind,
        back,
        row_offset: if kind == SRC_HISTORY { i32::from(row) - i32::from(target_row) } else { 0 },
        item_offset,
    };
    let repeat = I::ENCODE && walk.last_copy == Some(displacement);
    let seg_symbol = if repeat { SEG_REPCOPY } else { SEG_COPY };
    let seg = io.nibble(key(F_SEG, walk.prev_seg | u32::from(walk.last_copy.is_some()) << 2), seg_symbol);
    debug_assert!(!I::ENCODE || seg == seg_symbol);
    copy_after_seg(io, walk, seg, displacement, count)
}

/// The fields after a copy's segment symbol.
#[inline]
fn copy_after_seg<I: Io>(io: &mut I, walk: &mut Walk, seg: u8, planned: Displacement, count: u16) -> Result<(Displacement, usize), MzError> {
    let displacement = if seg == SEG_REPCOPY {
        walk.last_copy.ok_or(MzError::Corrupt)?
    } else {
        let kind = io.nibble(key(F_SRC_KIND, walk.prev_kind), planned.kind);
        walk.prev_kind = u32::from(kind);
        match kind {
            SRC_FRAME => {
                let back = varint(io, F_BACK, 0, planned.back)?;
                let item_offset = unzigzag(varint(io, F_SRC_ITEM, 0, zigzag(planned.item_offset))?);
                Displacement { kind, back, row_offset: 0, item_offset }
            }
            SRC_HISTORY => {
                let back = varint(io, F_SEQ, 0, planned.back)?;
                let row_offset = unzigzag(varint(io, F_SRC_ROW, 0, zigzag(planned.row_offset))?);
                let item_offset = unzigzag(varint(io, F_SRC_ITEM, 8, zigzag(planned.item_offset))?);
                Displacement { kind, back, row_offset, item_offset }
            }
            _ => return Err(MzError::Corrupt),
        }
    };
    if displacement.back == 0 {
        return Err(MzError::Corrupt);
    }
    let count = varint(
        io,
        F_ITEMS,
        u32::from(seg == SEG_REPCOPY) << 3,
        usize::from(count).saturating_sub(COPY_MIN_ITEMS).try_into().unwrap_or(0),
    )?;
    let count = (count as usize).checked_add(COPY_MIN_ITEMS).ok_or(MzError::Corrupt)?;
    walk.last_copy = Some(displacement);
    walk.prev_seg = u32::from(seg);
    Ok((displacement, count))
}

/// The frame's own entries, as items, for copies within it.
#[derive(Default)]
struct FrameRows {
    /// Per entry: start in the frame's bytes, first item offset, mode, and
    /// where its items start in `items`.
    entries: Vec<(usize, u16, u8, usize)>,
    items: Vec<MzItem>,
    /// Each item's hash, beside `items`, where the encoder keeps them.
    hashes: Vec<u64>,
    /// A copy's items, relative to where the copy starts.
    scratch: Vec<MzItem>,
}

impl FrameRows {
    fn clear(&mut self) {
        self.entries.clear();
        self.items.clear();
        self.hashes.clear();
    }

    /// Entry `back` entries before the newest pushed one, plus one: the entry
    /// a copy coded at entry `entries.len()` names.
    fn row<'a>(&'a self, bytes: &'a [u8], back: u32) -> Option<MzRow<'a>> {
        let index = self.entries.len().checked_sub(back as usize)?;
        let &(start, first, mode, items_from) = self.entries.get(index)?;
        let items_to = self.entries.get(index + 1).map_or(self.items.len(), |next| next.3);
        let items = self.items.get(items_from..items_to)?;
        let hashes = self.hashes.get(items_from..items_to).unwrap_or(&[]);
        let end = start + usize::from(items.last().map_or(first, |it| it.end));
        Some(MzRow { entry: bytes.get(start..end)?, first, items, mode, hashes })
    }
}

/// Reusable MZ encoder state.
#[derive(Default)]
pub struct MzEncoder {
    tables: Tables,
    coded: Vec<u32>,
    scratch: Vec<u8>,
    frame: FrameRows,
    entry_items: Vec<MzItem>,
    hashes: Vec<u64>,
    /// The frame's item pairs by pair hash: the newest link of each hash's
    /// chain in `links`, plus one.
    pairs: std::collections::HashMap<u64, u32, BuildPair>,
    /// `(entry, item, previous link plus one)`, so the frame's pair index
    /// reuses its storage and allocates nothing once warm.
    links: Vec<(u32, u16, u32)>,
    candidates: Vec<MzCandidate>,
    /// The chosen encoding's symbol trace, for the session fold.
    trace: Vec<u32>,
    trial: Vec<u8>,
    trial_trace: Vec<u32>,
    /// The epoch declaration the next payloads carry.
    declaration: Option<MzEpochDeclaration>,
}

/// What one encode produced.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MzEncoded {
    /// Row-layout bytes the payload decodes to.
    pub rows_len: usize,
    /// The prior it names: 0 for the static model, else the session epoch.
    pub prior: u8,
    /// Whether any copy names a held row of an earlier datagram.
    pub history_copies: bool,
}

impl MzEncoder {
    /// Code `rows`, `row_count` row-layout entries, into `out` (appended):
    /// the prior byte, any declaration, then the stream. With `session`, the
    /// frame is coded against the session epoch, and against the static model
    /// too when its trace prices smaller there, the smaller kept. Copies come
    /// from the frame itself and from `history`. `None` when the rows do not
    /// parse.
    pub fn encode(
        &mut self,
        rows: &[u8],
        row_count: u16,
        history: &impl MzMatches,
        session: Option<(u8, &SessionModel)>,
        declaration: Option<&MzEpochDeclaration>,
        out: &mut Vec<u8>,
    ) -> Option<MzEncoded> {
        self.declaration = declaration.copied();
        let model = static_model();
        let Some((epoch, session)) = session else {
            let (rows_len, history_copies, _) = self.encode_with(rows, row_count, history, model, 0, out)?;
            return Some(MzEncoded { rows_len, prior: 0, history_copies });
        };
        // Coded against the session epoch, then priced from the static model
        // by its trace alone; recoded against the static model only when that
        // prices smaller, and the smaller payload kept.
        let base = out.len();
        let layered = Layered { session, base: model };
        let (rows_len, history_copies, session_bits) =
            self.encode_with(rows, row_count, history, &layered, epoch, out)?;
        let encoded = MzEncoded { rows_len, prior: epoch, history_copies };
        if nibble::price(model, &mut self.tables, &self.trace) >= session_bits {
            return Some(encoded);
        }
        let mut trial = std::mem::take(&mut self.trial);
        trial.clear();
        let session_trace = std::mem::take(&mut self.trace);
        let result = self.encode_with(rows, row_count, history, model, 0, &mut trial);
        let chosen = match result {
            Some((_, copies, _)) if trial.len() < out.len() - base => {
                out.truncate(base);
                out.extend_from_slice(&trial);
                self.trial_trace = session_trace;
                MzEncoded { rows_len, prior: 0, history_copies: copies }
            }
            _ => {
                self.trial_trace = std::mem::replace(&mut self.trace, session_trace);
                encoded
            }
        };
        self.trial = trial;
        Some(chosen)
    }

    /// The symbol trace of the last encode's chosen payload: what a session
    /// fold of its datagram applies.
    pub fn trace(&self) -> &[u32] {
        &self.trace
    }

    fn encode_with<P: Prior>(
        &mut self,
        rows: &[u8],
        row_count: u16,
        history: &impl MzMatches,
        prior: &P,
        prior_id: u8,
        out: &mut Vec<u8>,
    ) -> Option<(usize, bool, u64)> {
        self.tables.begin();
        self.coded.clear();
        self.trace.clear();
        self.frame.clear();
        self.pairs.clear();
        self.links.clear();
        let mut coder = Coder {
            prior,
            tables: &mut self.tables,
            coded: &mut self.coded,
            bits: 0,
        };
        let mut walk = Walk::new();
        let mut at = 0usize;
        let mut history_copies = false;
        for _ in 0..row_count {
            let start = at;
            let entry_rest = rows.get(start..)?;
            let (first, mode) = entry_items(entry_rest, &mut self.entry_items)?;
            let mut len = usize::from(self.entry_items.last().map_or(first, |it| it.end));
            let &[_, _, left_high, left_low, ..] = rows.get(start..start + ROW_PREFIX_BYTES)? else {
                return None;
            };
            let left_field = u16::from_be_bytes([left_high, left_low]);
            if left_field & ROW_FLAG_GRAPHICS != 0 {
                let length = rows.get(start + len..start + len + GRAPHICS_LENGTH_BYTES)?;
                let length = u32::from_be_bytes(length.try_into().ok()?) as usize;
                if length == 0 || length > MAX_GRAPHICS_SECTION_BYTES {
                    return None;
                }
                len += GRAPHICS_LENGTH_BYTES + length;
            }
            let entry = rows.get(start..start + len)?;
            // Hashes of this entry's items, and the plan of its segments.
            self.hashes.clear();
            let unhashed = MzRow { entry, first, items: &self.entry_items, mode, hashes: &[] };
            for index in 0..self.entry_items.len() {
                self.hashes.push(item_hash(unhashed.item_bytes(index)?));
            }
            let entry_row = MzRow { entry, first, items: &self.entry_items, mode, hashes: &self.hashes };
            let &[row_high, row_low, ..] = entry else {
                return None;
            };
            let target_row = u16::from_be_bytes([row_high, row_low]);
            let mut io = EncodeIo { coder: &mut coder, trace: Some(&mut self.trace) };
            let sources = FrameSources {
                pairs: &self.pairs,
                links: &self.links,
                frame: &self.frame,
                rows,
            };
            history_copies |= encode_entry(
                &mut io,
                &mut walk,
                &entry_row,
                &self.hashes,
                target_row,
                &sources,
                history,
                &mut self.candidates,
            )?;
            // This entry becomes a source for the rest of the frame.
            let index = u32::try_from(self.frame.entries.len()).ok()?;
            self.frame.entries.push((start, first, mode, self.frame.items.len()));
            self.frame.items.extend_from_slice(&self.entry_items);
            self.frame.hashes.extend_from_slice(&self.hashes);
            for (pair, window) in (0u16..).zip(self.hashes.windows(2)) {
                let &[first_hash, second_hash] = window else {
                    break;
                };
                let head = self.pairs.entry(pair_hash(first_hash, second_hash)).or_insert(0);
                self.links.push((index, pair, *head));
                *head = u32::try_from(self.links.len()).ok()?;
            }
            at = start + len;
        }
        if at != rows.len() {
            return None;
        }
        match &self.declaration {
            Some(declaration) => {
                out.push(prior_id | DECLARATION);
                declaration.write(out);
            }
            None => out.push(prior_id),
        }
        let bits = coder.bits;
        nibble::encode(&self.coded, ways(rows.len()), &mut self.scratch, out);
        Some((rows.len(), history_copies, bits))
    }

}

/// Keep the longest run of items from `from` in `source` that equals the
/// target's from `index`, at least `COPY_MIN_ITEMS` long: extended by item
/// hash, then the run's bytes compared once.
#[inline]
fn consider(best: &mut Option<(Seg, usize)>, target: &MzRow<'_>, index: usize, seg: Seg, source: &MzRow<'_>, from: usize) {
    if source.mode != target.mode {
        return;
    }
    let (Some(source_hashes), Some(target_hashes)) = (source.hashes.get(from..), target.hashes.get(index..)) else {
        return;
    };
    let mut len = source_hashes
        .iter()
        .zip(target_hashes)
        .take_while(|(a, b)| a == b)
        .count();
    // A hash collision shortens the run to where the bytes agree.
    while len >= COPY_MIN_ITEMS {
        match (source.span(from, len), target.span(index, len)) {
            (Some((a, _)), Some((b, _))) if a == b => break,
            _ => len -= 1,
        }
    }
    if len >= COPY_MIN_ITEMS
        && best.is_none_or(|(_, best_len)| len > best_len)
        && let Ok(count) = u16::try_from(len)
    {
        let Seg::Copy { kind, back, row, item, .. } = seg;
        *best = Some((Seg::Copy { kind, back, row, item, count }, len));
    }
}

/// The frame's own entries, for copies within it.
struct FrameSources<'a> {
    pairs: &'a std::collections::HashMap<u64, u32, BuildPair>,
    links: &'a [(u32, u16, u32)],
    frame: &'a FrameRows,
    rows: &'a [u8],
}

/// The longest copy of items from `index` the frame or the history holds.
fn best_copy(
    target: &MzRow<'_>,
    hashes: &[u64],
    index: usize,
    sources: &FrameSources<'_>,
    history: &impl MzMatches,
    candidates: &mut Vec<MzCandidate>,
) -> Option<(Seg, usize)> {
    let (Some(&first), Some(&second)) = (hashes.get(index), hashes.get(index + 1)) else {
        return None;
    };
    let mut best = None;
    let pair = pair_hash(first, second);
    let entry_index = u32::try_from(sources.frame.entries.len()).ok()?;
    let mut link = sources.pairs.get(&pair).copied().unwrap_or(0);
    for _ in 0..8 {
        let Some(&(entry, item, previous)) = link.checked_sub(1).and_then(|at| sources.links.get(at as usize)) else {
            break;
        };
        let back = entry_index - entry;
        if let Some(source) = sources.frame.row(sources.rows, back) {
            consider(&mut best, target, index, Seg::Copy { kind: SRC_FRAME, back, row: 0, item, count: 0 }, &source, usize::from(item));
        }
        link = previous;
    }
    candidates.clear();
    history.candidates(pair, candidates);
    for candidate in candidates.iter().take(8) {
        if let Some(source) = history.row(candidate.seq_delta, candidate.row) {
            consider(
                &mut best,
                target,
                index,
                Seg::Copy { kind: SRC_HISTORY, back: candidate.seq_delta, row: candidate.row, item: candidate.item, count: 0 },
                &source,
                usize::from(candidate.item),
            );
        }
    }
    best
}

/// Code one entry, deciding each copy as it goes: at each item, the longest
/// copy from the frame or the history, taken exactly when its fields cost
/// less than its items as literals on the tables as they stand. Returns
/// whether it copied from history.
#[expect(clippy::too_many_arguments, reason = "the entry coder reads the encoder's split borrows")]
fn encode_entry<P: Prior>(
    io: &mut EncodeIo<'_, '_, P>,
    walk: &mut Walk,
    target: &MzRow<'_>,
    hashes: &[u64],
    row: u16,
    sources: &FrameSources<'_>,
    history: &impl MzMatches,
    candidates: &mut Vec<MzCandidate>,
) -> Option<bool> {
    let entry = target.entry;
    let &[_, _, left_high, left_low, count_high, count_low, _, _, ..] = entry else {
        return None;
    };
    let expected = walk.prev_row.wrapping_add(1);
    varint(io, F_ROW, 0, zigzag(i32::from(row.wrapping_sub(expected).cast_signed()))).ok()?;
    walk.prev_row = row;
    io.byte(key(F_LEFT, 0), left_high);
    io.byte(key(F_LEFT, 1 | u32::from(left_high) << 1), left_low);
    io.byte(key(F_COUNT, 0), count_high);
    io.byte(key(F_COUNT, 1 | u32::from(count_high) << 1), count_low);
    let left_field = u16::from_be_bytes([left_high, left_low]);
    let at = ROW_PREFIX_BYTES;
    if left_field & ROW_FLAG_LINKS != 0 {
        let &[spans_high, spans_low] = entry.get(at..at + LINK_TABLE_COUNT_BYTES)? else {
            return None;
        };
        let spans = usize::from(u16::from_be_bytes([spans_high, spans_low]));
        for (index, &byte) in entry.get(at..at + LINK_TABLE_COUNT_BYTES + spans * LINK_SPAN_BYTES)?.iter().enumerate() {
            io.byte(key(F_LINK, link_aux(index)), byte);
        }
    }
    let mode = io.byte(key(F_MODE, walk.prev_mode), target.mode);
    walk.prev_mode = u32::from(mode);
    walk.prev_seg = SEG_START;
    let mut copied_history = false;
    let mut index = 0usize;
    let mut sink = Vec::new();
    while index < target.items.len() {
        if let Some((Seg::Copy { kind, back, row: source_row, item: source_item, count }, len)) =
            best_copy(target, hashes, index, sources, history, candidates)
        {
            let fields = Some((kind, back, source_row, source_item, count));
            let mut estimate = EstimateIo { coder: &mut *io.coder, bits: 0 };
            let mut trial = *walk;
            let copy_bits = copy_fields(&mut estimate, &mut trial, row, index, fields).ok().map(|_| estimate.bits);
            let literal_bits = target.span(index, len).and_then(|(bytes, _)| {
                let mut literal = EstimateIo { coder: &mut *io.coder, bits: 0 };
                let mut lit_walk = *walk;
                let mut cur = Cursor { src: bytes, at: 0 };
                (0..len)
                    .all(|_| {
                        literal.nibble(key(F_SEG, lit_walk.prev_seg | u32::from(lit_walk.last_copy.is_some()) << 2), SEG_ITEM);
                        lit_walk.prev_seg = u32::from(SEG_ITEM);
                        item(&mut literal, &mut lit_walk, mode, &mut cur, &mut sink).is_ok()
                    })
                    .then_some(literal.bits)
            });
            if let (Some(copy_bits), Some(literal_bits)) = (copy_bits, literal_bits)
                && copy_bits < literal_bits
            {
                copy_fields(io, walk, row, index, fields).ok()?;
                copied_history |= kind == SRC_HISTORY;
                index += len;
                continue;
            }
        }
        io.nibble(key(F_SEG, walk.prev_seg | u32::from(walk.last_copy.is_some()) << 2), SEG_ITEM);
        walk.prev_seg = u32::from(SEG_ITEM);
        let bytes = target.item_bytes(index)?;
        let mut cur = Cursor { src: bytes, at: 0 };
        item(io, walk, mode, &mut cur, &mut sink).ok()?;
        index += 1;
    }
    let end = usize::from(target.items.last().map_or(target.first, |it| it.end));
    for (index, &byte) in entry.get(end..)?.iter().enumerate() {
        io.byte(key(F_GRAPHICS, graphics_aux(index)), byte);
    }
    Some(copied_history)
}

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

/// The context of byte `index` of a link table, its count included: its
/// offset within a span.
#[inline]
#[expect(
    clippy::cast_possible_truncation,
    reason = "the context is below `LINK_TABLE_COUNT_BYTES + LINK_SPAN_BYTES`"
)]
fn link_aux(index: usize) -> u32 {
    if index < LINK_TABLE_COUNT_BYTES {
        index as u32
    } else {
        (LINK_TABLE_COUNT_BYTES + (index - LINK_TABLE_COUNT_BYTES) % LINK_SPAN_BYTES) as u32
    }
}

/// Reusable MZ decoder state.
#[derive(Default)]
pub struct MzDecoder {
    tables: Tables,
    frame: FrameRows,
    /// The last decode's symbol trace, for the session fold.
    trace: Vec<u32>,
    /// The epoch declaration the last decoded payload carried.
    declaration: Option<MzEpochDeclaration>,
}

impl MzDecoder {
    /// The symbol trace of the last successful decode.
    pub fn trace(&self) -> &[u32] {
        &self.trace
    }

    /// The epoch declaration the last decoded payload carried.
    pub fn declaration(&self) -> Option<MzEpochDeclaration> {
        self.declaration
    }

    /// A payload's prior and declaration, without decoding it.
    pub fn peek(payload: &[u8]) -> Result<(u8, Option<MzEpochDeclaration>), MzError> {
        let (&prior, rest) = payload.split_first().ok_or(MzError::Corrupt)?;
        if prior & DECLARATION == 0 {
            return Ok((prior, None));
        }
        let declaration = MzEpochDeclaration::read(rest).ok_or(MzError::Corrupt)?;
        Ok((prior & !DECLARATION, Some(declaration)))
    }

    /// Decode an MZ payload of `row_count` entries into `out` (cleared first),
    /// which must come to exactly `rows_len` row-layout bytes. Copies and the
    /// prior resolve through `sources`. The output is not validated: the
    /// caller's row validator reads it as it reads any frame.
    pub fn decode(
        &mut self,
        payload: &[u8],
        row_count: u16,
        rows_len: usize,
        sources: &impl MzSources,
        out: &mut Vec<u8>,
    ) -> Result<(), MzError> {
        out.clear();
        out.reserve(rows_len);
        self.trace.clear();
        let (prior_id, declaration) = Self::peek(payload)?;
        self.declaration = declaration;
        let stream = payload
            .get(1 + declaration.map_or(0, |_| MzEpochDeclaration::BYTES)..)
            .ok_or(MzError::Corrupt)?;
        let model = static_model();
        if prior_id == 0 {
            self.decode_with(model, stream, row_count, rows_len, sources, out)
        } else {
            let session = sources.epoch(prior_id).ok_or(MzError::Unresolved)?;
            let layered = Layered { session, base: model };
            self.decode_with(&layered, stream, row_count, rows_len, sources, out)
        }
    }

    fn decode_with<P: Prior>(
        &mut self,
        prior: &P,
        stream: &[u8],
        row_count: u16,
        rows_len: usize,
        sources: &impl MzSources,
        out: &mut Vec<u8>,
    ) -> Result<(), MzError> {
        let mut decoder = Decoder::new(prior, &mut self.tables, stream, ways(rows_len)).ok_or(MzError::Corrupt)?;
        let mut io = DecodeIo { decoder: &mut decoder, trace: Some(&mut self.trace) };
        let mut walk = Walk::new();
        self.frame.clear();
        let mut cur = Cursor { src: &[], at: 0 };
        for _ in 0..row_count {
            decode_entry(&mut io, &mut walk, &mut self.frame, sources, rows_len, &mut cur, out)?;
            if out.len() > rows_len {
                return Err(MzError::Corrupt);
            }
        }
        if out.len() != rows_len || !io.decoder.finish() {
            return Err(MzError::Corrupt);
        }
        Ok(())
    }
}

/// Items `from..from + count` of `source` for a copy into a row of `mode`:
/// their byte range in the source entry and the cells they cover, with each
/// item, relative to the copy's start, appended to `items`.
#[inline]
fn copy_items(
    source: &MzRow<'_>,
    mode: u8,
    from: usize,
    count: usize,
    items: &mut Vec<MzItem>,
) -> Result<(std::ops::Range<usize>, u16), MzError> {
    if source.mode != mode {
        return Err(MzError::Corrupt);
    }
    let last = source.items.get(from + count - 1).ok_or(MzError::Corrupt)?;
    let start = source.item_start(from);
    let before = source.cells_before(from);
    if start > usize::from(last.end) {
        return Err(MzError::Corrupt);
    }
    for it in source.items.get(from..from + count).ok_or(MzError::Corrupt)? {
        let start = u16::try_from(start).ok().ok_or(MzError::Corrupt)?;
        items.push(MzItem { end: it.end - start, cells: it.cells - before });
    }
    Ok((start..usize::from(last.end), last.cells - before))
}

#[expect(
    clippy::too_many_lines,
    reason = "one entry's fields in the order the encoder codes them"
)]
fn decode_entry<P: Prior>(
    io: &mut DecodeIo<'_, '_, '_, P>,
    walk: &mut Walk,
    frame: &mut FrameRows,
    sources: &impl MzSources,
    rows_len: usize,
    cur: &mut Cursor<'_>,
    out: &mut Vec<u8>,
) -> Result<(), MzError> {
    let start = out.len();
    let expected = walk.prev_row.wrapping_add(1);
    let Ok(delta) = i16::try_from(unzigzag(varint(io, F_ROW, 0, 0)?)) else {
        return Err(MzError::Corrupt);
    };
    let row = expected.wrapping_add(delta.cast_unsigned());
    walk.prev_row = row;
    out.extend_from_slice(&row.to_be_bytes());
    let left_high = io.byte(key(F_LEFT, 0), 0);
    let left_low = io.byte(key(F_LEFT, 1 | u32::from(left_high) << 1), 0);
    let count_high = io.byte(key(F_COUNT, 0), 0);
    let count_low = io.byte(key(F_COUNT, 1 | u32::from(count_high) << 1), 0);
    out.extend_from_slice(&[left_high, left_low, count_high, count_low, 0, 0]);
    let left_field = u16::from_be_bytes([left_high, left_low]);
    let cells = usize::from(u16::from_be_bytes([count_high, count_low]) & ROW_CELL_COUNT_MASK);
    if cells == 0 || cells > MAX_TERMINAL_COLUMNS {
        return Err(MzError::Corrupt);
    }
    let body_start = out.len();
    if left_field & ROW_FLAG_LINKS != 0 {
        let high = io.byte(key(F_LINK, link_aux(0)), 0);
        let low = io.byte(key(F_LINK, link_aux(1)), 0);
        out.extend_from_slice(&[high, low]);
        let spans = usize::from(u16::from_be_bytes([high, low]));
        if spans > cells {
            return Err(MzError::Corrupt);
        }
        for index in LINK_TABLE_COUNT_BYTES..LINK_TABLE_COUNT_BYTES + spans * LINK_SPAN_BYTES {
            out.push(io.byte(key(F_LINK, link_aux(index)), 0));
        }
    }
    let mode = io.byte(key(F_MODE, walk.prev_mode), 0);
    walk.prev_mode = u32::from(mode);
    if mode > COLOR_MODE_LITERAL {
        return Err(MzError::Corrupt);
    }
    out.push(mode);
    let first = u16::try_from(out.len() - start).ok().ok_or(MzError::Corrupt)?;
    let entry_index = frame.entries.len();
    let items_from = frame.items.len();
    walk.prev_seg = SEG_START;
    let mut covered = 0usize;
    while covered < cells {
        if out.len() > rows_len {
            return Err(MzError::Corrupt);
        }
        let seg = io.nibble(key(F_SEG, walk.prev_seg | u32::from(walk.last_copy.is_some()) << 2), 0);
        let item_index = frame.items.len() - items_from;
        match seg {
            SEG_ITEM => {
                walk.prev_seg = u32::from(SEG_ITEM);
                covered += usize::from(item(io, walk, mode, cur, out)?);
                frame.items.push(MzItem {
                    end: u16::try_from(out.len() - start).ok().ok_or(MzError::Corrupt)?,
                    cells: u16::try_from(covered).ok().ok_or(MzError::Corrupt)?,
                });
            }
            SEG_COPY | SEG_REPCOPY => {
                let (displacement, count) = copy_after_seg(io, walk, seg, Displacement::NONE, 0)?;
                let source_item = item_index
                    .checked_add_signed(displacement.item_offset as isize)
                    .ok_or(MzError::Corrupt)?;
                let at = out.len() - start;
                frame.scratch.clear();
                let cells = if displacement.kind == SRC_FRAME {
                    let index = entry_index.checked_sub(displacement.back as usize).ok_or(MzError::Corrupt)?;
                    let &(source_start, source_first, source_mode, source_items_from) =
                        frame.entries.get(index).ok_or(MzError::Corrupt)?;
                    let source_items_to = frame.entries.get(index + 1).map_or(items_from, |next| next.3);
                    let items = frame.items.get(source_items_from..source_items_to).ok_or(MzError::Corrupt)?;
                    let source = MzRow { entry: out.get(source_start..).ok_or(MzError::Corrupt)?, first: source_first, items, mode: source_mode, hashes: &[] };
                    let (range, cells) = copy_items(&source, mode, source_item, count, &mut frame.scratch)?;
                    out.extend_from_within(source_start + range.start..source_start + range.end);
                    cells
                } else {
                    let source_row = u16::try_from(i32::from(row) + displacement.row_offset).ok().ok_or(MzError::Corrupt)?;
                    let source = sources.row(displacement.back, source_row)?;
                    let (range, cells) = copy_items(&source, mode, source_item, count, &mut frame.scratch)?;
                    out.extend_from_slice(source.entry.get(range).ok_or(MzError::Corrupt)?);
                    cells
                };
                for it in &frame.scratch {
                    frame.items.push(MzItem {
                        end: u16::try_from(at + usize::from(it.end)).ok().ok_or(MzError::Corrupt)?,
                        cells: u16::try_from(covered + usize::from(it.cells)).ok().ok_or(MzError::Corrupt)?,
                    });
                }
                covered += usize::from(cells);
            }
            _ => return Err(MzError::Corrupt),
        }
    }
    if covered != cells {
        return Err(MzError::Corrupt);
    }
    let body_len = u16::try_from(out.len() - body_start).ok().ok_or(MzError::Corrupt)?;
    out.get_mut(start + 6..start + 8).ok_or(MzError::Corrupt)?.copy_from_slice(&body_len.to_be_bytes());
    frame.entries.push((start, first, mode, items_from));
    if left_field & ROW_FLAG_GRAPHICS != 0 {
        let mut length = [0u8; GRAPHICS_LENGTH_BYTES];
        for (index, byte) in length.iter_mut().enumerate() {
            *byte = io.byte(key(F_GRAPHICS, graphics_aux(index)), 0);
        }
        out.extend_from_slice(&length);
        let length = u32::from_be_bytes(length) as usize;
        if length == 0 || length > MAX_GRAPHICS_SECTION_BYTES || out.len() + length > rows_len {
            return Err(MzError::Corrupt);
        }
        for _ in 0..length {
            out.push(io.byte(key(F_GRAPHICS, graphics_aux(GRAPHICS_LENGTH_BYTES)), 0));
        }
    }
    Ok(())
}

/// Append the full-row entry for `cells` at row `row`: the bytes a reference
/// to the complete row writes, exactly as the row layout writes it.
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
