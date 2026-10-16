//! The wire form of a display frame's header.
//!
//! Display frames live in memory in the staged layout: the 18-byte stream
//! header, the fixed 55-byte frame header every reader patches and parses at
//! fixed offsets, [`MAX_WIRE_HEADER_BYTES`] of headroom, then the body. The
//! headroom is where the wire header goes. The daemon writes it at seal time,
//! right-aligned against the body, so the wire frame is the contiguous tail
//! `staged[start..]` and the body is never copied. The receiver turns a wire
//! frame back into the staged layout in the copy it already makes into its
//! staging buffer.
//!
//! The wire header carries every field of the staged one. Each is either at its
//! fixed width, packed to the width its bound allows, encoded relative to a
//! correlated field of the same frame (a zigzag varint of the wrapping
//! difference), or omitted at its default value behind a presence bit. No field
//! depends on another datagram or on receiver state, so every datagram stays
//! complete, order-independent and idempotent, and the worst case of the
//! relative encodings costs bytes, never correctness.
//!
//! Layout, all big-endian:
//!
//! ```text
//! 0      msg_type        u8    MSG_TYPE_DISPLAY_PATCH
//! 1      version         u8    VERSION
//! 2      stream flags    u8    compression/FEC bits | presence bits 3..6
//! 3      patch flags     u8
//! 4..8   generation      u32
//! 8..12  seq             u32
//! 12..16 input_seq       u32
//! 16..23 geometry        u56   0:4 | cols:10 | rows:9 | cursor col:10 |
//!                              cursor row:9 | shape:4 | visible:1 | mode:9
//! 23..27 scroll_serial   u32
//! 27..   varints: zz(frame_id - seq), zz(seq - presentation_id),
//!        member_index, member_count, [zz(presentation_id - predecessor)],
//!        row_count, demand_serial, [zz(input_seq - echo_horizon)],
//!        [chunk_index, chunk_count], [closure_digest u64]
//! ```
//!
//! The body length is not carried: a datagram's length is its opened length, a
//! reliable record's is its stream framing, and FEC rebuilds each member's
//! length from its parity (see `merkur_fec::repair`).

use crate::decode::{CodecErr, parse_frame_header};
use crate::encode::{FrameHeader, FrameKind, frame_header_fixed};
use crate::stream::{StreamHeader, parse_stream_header, write_stream_header};
use crate::varint::decode_varint_u32;
use crate::{
    DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD, DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD_DICT,
    DISPLAY_HEADER_FLAG_FEC_PROTECTED, FRAME_HEADER_BODY_BYTES, MSG_TYPE_DISPLAY_PATCH,
    STREAM_HEADER_BYTES, VERSION,
};

/// Bytes of the wire header that every frame carries at fixed offsets.
pub const WIRE_FIXED_HEADER_BYTES: usize = 27;
/// The longest wire header: every varint at its widest and every optional
/// field present.
pub const MAX_WIRE_HEADER_BYTES: usize =
    WIRE_FIXED_HEADER_BYTES + 5 + 5 + 3 + 3 + 5 + 3 + 5 + 5 + 3 + 3 + 8;
/// The longest wire header of a frame that is not a snapshot chunk: no chunk
/// fields. Datagram fitting budgets against it, so a field restamped after
/// planning can never push a datagram past its ceiling.
pub const MAX_UNCHUNKED_WIRE_HEADER_BYTES: usize = MAX_WIRE_HEADER_BYTES - 6;
/// Where a staged frame's body begins.
pub const STAGED_BODY_OFFSET: usize = STREAM_HEADER_BYTES + FRAME_HEADER_BODY_BYTES;

/// Stream-flags presence bit: the closure digest follows.
pub const WIRE_PRESENT_CLOSURE: u8 = 1 << 3;
/// Stream-flags presence bit: the echo horizon follows.
pub const WIRE_PRESENT_ECHO_HORIZON: u8 = 1 << 4;
/// Stream-flags presence bit: chunk index and count follow.
pub const WIRE_PRESENT_CHUNK: u8 = 1 << 5;
/// Stream-flags presence bit: the row predecessor follows.
pub const WIRE_PRESENT_PREDECESSOR: u8 = 1 << 6;

const STREAM_FLAG_BITS: u8 = DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD
    | DISPLAY_HEADER_FLAG_FEC_PROTECTED
    | DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD_DICT;
const PRESENCE_BITS: u8 = WIRE_PRESENT_CLOSURE
    | WIRE_PRESENT_ECHO_HORIZON
    | WIRE_PRESENT_CHUNK
    | WIRE_PRESENT_PREDECESSOR;
/// The one patch flag bit no version defines.
const PATCH_FLAG_UNDEFINED: u8 = 1 << 6;

/// Widths of the packed geometry word's fields. Columns and the cursor column
/// fit ten bits and rows and the cursor row nine, because the grid is bounded
/// at 512 by 256; the mode word defines nine bits (`encode_terminal_mode`).
const COL_BITS: u32 = 10;
const ROW_BITS: u32 = 9;
const SHAPE_BITS: u32 = 4;
const MODE_BITS: u32 = 9;
/// Bits of the 56-bit geometry word in use; the rest must be zero.
const GEOMETRY_BITS: u32 = 2 * COL_BITS + 2 * ROW_BITS + SHAPE_BITS + 1 + MODE_BITS;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WireError {
    /// The frame ends inside its header.
    Truncated,
    /// Not a display patch.
    MessageType,
    /// Another codec version.
    Version,
    /// A bit this version does not define is set.
    ReservedBits,
    /// A present optional field holds its default value, or a varint is not in
    /// its one canonical encoding.
    NonCanonical,
    /// A field exceeds its wire width.
    Range,
}

impl From<CodecErr> for WireError {
    fn from(error: CodecErr) -> Self {
        match error {
            CodecErr::Truncated => Self::Truncated,
            _ => Self::NonCanonical,
        }
    }
}

/// A wire frame's header, read back.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WireFrame {
    /// The stream header. `body_len` is the body length the frame has once
    /// staged: the staged frame header body plus the wire body.
    pub stream: StreamHeader,
    pub header: FrameHeader,
    /// Where the body begins in the wire frame.
    pub body_offset: usize,
}

/// The fields a wire frame carries at fixed offsets, which a receiver reads to
/// route a frame before parsing the rest.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WirePrefix {
    /// The stream flags: compression and FEC bits, without presence bits.
    pub flags: u8,
    pub generation: u32,
    pub seq: u32,
    pub input_seq: u32,
}

impl From<core::num::TryFromIntError> for WireError {
    fn from(_: core::num::TryFromIntError) -> Self {
        Self::Range
    }
}

#[inline]
fn zigzag(value: u32) -> u32 {
    (value << 1) ^ 0u32.wrapping_sub(value >> 31)
}

#[inline]
fn unzigzag(value: u32) -> u32 {
    (value >> 1) ^ 0u32.wrapping_sub(value & 1)
}

fn pack_geometry(header: &FrameHeader) -> Result<[u8; 7], WireError> {
    if u32::from(header.cols) >= 1 << COL_BITS
        || u32::from(header.rows) >= 1 << ROW_BITS
        || u32::from(header.cursor_col) >= 1 << COL_BITS
        || u32::from(header.cursor_row) >= 1 << ROW_BITS
        || u32::from(header.mode_flags) >= 1 << MODE_BITS
    {
        return Err(WireError::Range);
    }
    let mut word = u64::from(header.cols);
    word = (word << ROW_BITS) | u64::from(header.rows);
    word = (word << COL_BITS) | u64::from(header.cursor_col);
    word = (word << ROW_BITS) | u64::from(header.cursor_row);
    word = (word << SHAPE_BITS) | u64::from(header.cursor_shape & 0x0f);
    word = (word << 1) | u64::from(header.cursor_visible & 0x01);
    word = (word << MODE_BITS) | u64::from(header.mode_flags);
    let [_, b0, b1, b2, b3, b4, b5, b6] = word.to_be_bytes();
    Ok([b0, b1, b2, b3, b4, b5, b6])
}

struct Geometry {
    cols: u16,
    rows: u16,
    cursor_col: u16,
    cursor_row: u16,
    cursor_shape: u8,
    cursor_visible: u8,
    mode_flags: u16,
}

#[expect(
    clippy::cast_possible_truncation,
    reason = "each field is masked to at most ten bits"
)]
fn unpack_geometry(bytes: [u8; 7]) -> Result<Geometry, WireError> {
    let [b0, b1, b2, b3, b4, b5, b6] = bytes;
    let mut word = u64::from_be_bytes([0, b0, b1, b2, b3, b4, b5, b6]);
    if word >> GEOMETRY_BITS != 0 {
        return Err(WireError::ReservedBits);
    }
    let mut take = |bits: u32| {
        let value = word & ((1 << bits) - 1);
        word >>= bits;
        value
    };
    let mode_flags = take(MODE_BITS) as u16;
    let cursor_visible = take(1) as u8;
    let cursor_shape = take(SHAPE_BITS) as u8;
    let cursor_row = take(ROW_BITS) as u16;
    let cursor_col = take(COL_BITS) as u16;
    let rows = take(ROW_BITS) as u16;
    let cols = take(COL_BITS) as u16;
    Ok(Geometry {
        cols,
        rows,
        cursor_col,
        cursor_row,
        cursor_shape,
        cursor_visible,
        mode_flags,
    })
}

/// The fields a wire frame carries at fixed offsets, in wire order.
struct Fixed {
    msg_type: u8,
    version: u8,
    flags: u8,
    patch_flags: u8,
    generation: u32,
    seq: u32,
    input_seq: u32,
    geometry: [u8; 7],
    scroll_serial: u32,
}

#[inline]
fn fixed_fields(wire: &[u8]) -> Option<Fixed> {
    let &[
        msg_type,
        version,
        flags,
        patch_flags,
        g0,
        g1,
        g2,
        g3,
        s0,
        s1,
        s2,
        s3,
        i0,
        i1,
        i2,
        i3,
        x0,
        x1,
        x2,
        x3,
        x4,
        x5,
        x6,
        c0,
        c1,
        c2,
        c3,
    ] = wire.first_chunk::<WIRE_FIXED_HEADER_BYTES>()?;
    Some(Fixed {
        msg_type,
        version,
        flags,
        patch_flags,
        generation: u32::from_be_bytes([g0, g1, g2, g3]),
        seq: u32::from_be_bytes([s0, s1, s2, s3]),
        input_seq: u32::from_be_bytes([i0, i1, i2, i3]),
        geometry: [x0, x1, x2, x3, x4, x5, x6],
        scroll_serial: u32::from_be_bytes([c0, c1, c2, c3]),
    })
}

/// Writes a wire header. Every write is bounded by the output array, and
/// [`MAX_WIRE_HEADER_BYTES`] counts every field at its widest, so a refused
/// write is a codec bug reported as [`WireError::Range`], never a panic.
struct Cursor<'a> {
    slots: core::slice::IterMut<'a, u8>,
    len: usize,
}

impl Cursor<'_> {
    #[inline]
    fn byte(&mut self, value: u8) -> Result<(), WireError> {
        *self.slots.next().ok_or(WireError::Range)? = value;
        self.len += 1;
        Ok(())
    }

    #[inline]
    fn bytes(&mut self, value: &[u8]) -> Result<(), WireError> {
        value.iter().try_for_each(|&byte| self.byte(byte))
    }

    #[inline]
    fn varint(&mut self, mut value: u32) -> Result<(), WireError> {
        loop {
            let [low, ..] = value.to_le_bytes();
            value >>= 7;
            if value == 0 {
                return self.byte(low);
            }
            self.byte(low | 0x80)?;
        }
    }
}

/// Write the wire header of a staged frame into `out`, returning its length.
pub fn wire_header(
    staged: &[u8],
    out: &mut [u8; MAX_WIRE_HEADER_BYTES],
) -> Result<usize, WireError> {
    let stream = parse_stream_header(staged).ok_or(WireError::Truncated)?;
    let header = parse_frame_header(staged)?;
    encode_wire_header(&stream, &header, out)
}

/// Write the wire header of `stream` and `header` into `out`, returning its
/// length.
pub fn encode_wire_header(
    stream: &StreamHeader,
    header: &FrameHeader,
    out: &mut [u8; MAX_WIRE_HEADER_BYTES],
) -> Result<usize, WireError> {
    if stream.msg_type != MSG_TYPE_DISPLAY_PATCH {
        return Err(WireError::MessageType);
    }
    if stream.flags & !STREAM_FLAG_BITS != 0 {
        return Err(WireError::ReservedBits);
    }
    let geometry = pack_geometry(header)?;
    let chunked = header.chunk_index != 0 || header.chunk_count != 1;
    let mut presence = 0;
    if header.closure_digest != 0 {
        presence |= WIRE_PRESENT_CLOSURE;
    }
    if header.echo_horizon != 0 {
        presence |= WIRE_PRESENT_ECHO_HORIZON;
    }
    if chunked {
        presence |= WIRE_PRESENT_CHUNK;
    }
    if header.row_predecessor_presentation_id != 0 {
        presence |= WIRE_PRESENT_PREDECESSOR;
    }

    let mut w = Cursor {
        slots: out.iter_mut(),
        len: 0,
    };
    w.bytes(&[
        MSG_TYPE_DISPLAY_PATCH,
        VERSION,
        stream.flags | presence,
        header.patch_flags(),
    ])?;
    w.bytes(&stream.generation.to_be_bytes())?;
    w.bytes(&stream.seq.to_be_bytes())?;
    w.bytes(&stream.input_seq.to_be_bytes())?;
    w.bytes(&geometry)?;
    w.bytes(&header.scroll_serial.to_be_bytes())?;
    w.varint(zigzag(header.frame_id.wrapping_sub(stream.seq)))?;
    w.varint(zigzag(stream.seq.wrapping_sub(header.presentation_id)))?;
    w.varint(u32::from(header.presentation_member_index))?;
    w.varint(u32::from(header.presentation_member_count))?;
    if presence & WIRE_PRESENT_PREDECESSOR != 0 {
        w.varint(zigzag(
            header
                .presentation_id
                .wrapping_sub(header.row_predecessor_presentation_id),
        ))?;
    }
    w.varint(u32::from(header.row_count))?;
    w.varint(header.demand_serial)?;
    if presence & WIRE_PRESENT_ECHO_HORIZON != 0 {
        w.varint(zigzag(stream.input_seq.wrapping_sub(header.echo_horizon)))?;
    }
    if chunked {
        w.varint(u32::from(header.chunk_index))?;
        w.varint(u32::from(header.chunk_count))?;
    }
    if presence & WIRE_PRESENT_CLOSURE != 0 {
        w.bytes(&header.closure_digest.to_be_bytes())?;
    }
    Ok(w.len)
}

/// Write a staged frame's wire header into its headroom, right-aligned against
/// the body, and return where the wire frame begins: the frame to seal is
/// `staged[start..]`. The staged header is left intact, so the frame stays
/// readable and patchable; patching it again means writing the wire header
/// again.
pub fn write_wire_header_in_place(staged: &mut [u8]) -> Result<usize, WireError> {
    let mut header = [0u8; MAX_WIRE_HEADER_BYTES];
    let len = wire_header(staged, &mut header)?;
    let start = STAGED_BODY_OFFSET
        .checked_sub(len)
        .ok_or(WireError::Range)?;
    staged
        .get_mut(start..STAGED_BODY_OFFSET)
        .ok_or(WireError::Truncated)?
        .copy_from_slice(header.get(..len).ok_or(WireError::Range)?);
    Ok(start)
}

/// The exact length a staged frame has on the wire.
pub fn wire_frame_len(staged: &[u8]) -> Result<usize, WireError> {
    let mut header = [0u8; MAX_WIRE_HEADER_BYTES];
    let len = wire_header(staged, &mut header)?;
    staged
        .len()
        .checked_sub(STAGED_BODY_OFFSET)
        .map(|body| body + len)
        .ok_or(WireError::Truncated)
}

/// Read a wire frame's fixed-offset fields, or `None` for anything that is not
/// a display patch of this version.
#[inline]
pub fn parse_wire_prefix(wire: &[u8]) -> Option<WirePrefix> {
    let fixed = fixed_fields(wire)?;
    if fixed.msg_type != MSG_TYPE_DISPLAY_PATCH || fixed.version != VERSION {
        return None;
    }
    Some(WirePrefix {
        flags: fixed.flags & STREAM_FLAG_BITS,
        generation: fixed.generation,
        seq: fixed.seq,
        input_seq: fixed.input_seq,
    })
}

struct Reader<'a> {
    buf: &'a [u8],
    offset: usize,
}

impl Reader<'_> {
    #[inline]
    fn varint(&mut self) -> Result<u32, WireError> {
        Ok(decode_varint_u32(self.buf, &mut self.offset)?)
    }

    #[inline]
    fn varint_u16(&mut self) -> Result<u16, WireError> {
        Ok(u16::try_from(self.varint()?)?)
    }

    /// A present relative field: `base` less its zigzag difference, which is
    /// never the field's default `0`.
    #[inline]
    fn present_relative(&mut self, base: u32) -> Result<u32, WireError> {
        match base.wrapping_sub(unzigzag(self.varint()?)) {
            0 => Err(WireError::NonCanonical),
            value => Ok(value),
        }
    }

    #[inline]
    fn u64(&mut self) -> Result<u64, WireError> {
        let bytes = self
            .buf
            .get(self.offset..)
            .and_then(<[u8]>::first_chunk::<8>)
            .ok_or(WireError::Truncated)?;
        self.offset += 8;
        Ok(u64::from_be_bytes(*bytes))
    }
}

/// Read a wire frame's header. The result is canonical: re-encoding it yields
/// exactly the bytes read.
pub fn parse_wire(wire: &[u8]) -> Result<WireFrame, WireError> {
    let fixed = fixed_fields(wire).ok_or(WireError::Truncated)?;
    if fixed.msg_type != MSG_TYPE_DISPLAY_PATCH {
        return Err(WireError::MessageType);
    }
    if fixed.version != VERSION {
        return Err(WireError::Version);
    }
    let presence = fixed.flags & PRESENCE_BITS;
    let patch_flags = fixed.patch_flags;
    if fixed.flags & !(STREAM_FLAG_BITS | PRESENCE_BITS) != 0
        || patch_flags & PATCH_FLAG_UNDEFINED != 0
    {
        return Err(WireError::ReservedBits);
    }
    let seq = fixed.seq;
    let geometry = unpack_geometry(fixed.geometry)?;

    let mut r = Reader {
        buf: wire,
        offset: WIRE_FIXED_HEADER_BYTES,
    };
    let frame_id = seq.wrapping_add(unzigzag(r.varint()?));
    let presentation_id = seq.wrapping_sub(unzigzag(r.varint()?));
    let presentation_member_index = r.varint_u16()?;
    let presentation_member_count = r.varint_u16()?;
    let row_predecessor_presentation_id = if presence & WIRE_PRESENT_PREDECESSOR != 0 {
        r.present_relative(presentation_id)?
    } else {
        0
    };
    let row_count = r.varint_u16()?;
    let demand_serial = r.varint()?;
    let echo_horizon = if presence & WIRE_PRESENT_ECHO_HORIZON != 0 {
        r.present_relative(fixed.input_seq)?
    } else {
        0
    };
    let (chunk_index, chunk_count) = if presence & WIRE_PRESENT_CHUNK != 0 {
        match (r.varint_u16()?, r.varint_u16()?) {
            (0, 1) => return Err(WireError::NonCanonical),
            chunk => chunk,
        }
    } else {
        (0, 1)
    };
    let closure_digest = if presence & WIRE_PRESENT_CLOSURE != 0 {
        match r.u64()? {
            0 => return Err(WireError::NonCanonical),
            digest => digest,
        }
    } else {
        0
    };

    let body_offset = r.offset;
    let body_len = wire.len().saturating_sub(body_offset);
    Ok(WireFrame {
        stream: StreamHeader {
            msg_type: MSG_TYPE_DISPLAY_PATCH,
            flags: fixed.flags & STREAM_FLAG_BITS,
            body_len: u32::try_from(FRAME_HEADER_BODY_BYTES + body_len)?,
            seq,
            generation: fixed.generation,
            input_seq: fixed.input_seq,
        },
        header: FrameHeader {
            kind: FrameKind::from_patch_flags(patch_flags),
            memory_only: patch_flags & crate::PATCH_FLAG_MEMORY_ONLY != 0,
            cols: geometry.cols,
            rows: geometry.rows,
            cursor_col: geometry.cursor_col,
            cursor_row: geometry.cursor_row,
            cursor_shape: geometry.cursor_shape,
            cursor_visible: geometry.cursor_visible,
            mode_flags: geometry.mode_flags,
            row_count,
            frame_id,
            presentation_id,
            presentation_member_index,
            presentation_member_count,
            row_predecessor_presentation_id,
            presentation_coherent: patch_flags & crate::PATCH_FLAG_PRESENTATION_COHERENT != 0,
            presentation_end: patch_flags & crate::PATCH_FLAG_PRESENTATION_END != 0,
            chunk_index,
            chunk_count,
            demand_serial,
            demand_limited: patch_flags & crate::PATCH_FLAG_DEMAND_LIMITED != 0,
            demand_prompt: patch_flags & crate::PATCH_FLAG_DEMAND_PROMPT != 0,
            demand_awaits_grant: patch_flags & crate::PATCH_FLAG_DEMAND_AWAITS_GRANT != 0,
            closure_digest,
            scroll_serial: fixed.scroll_serial,
            echo_horizon,
        },
        body_offset,
    })
}

/// A wire frame's staged header: the stream header, the fixed frame header and
/// zeroed headroom. The staged frame is this followed by the wire body.
pub fn staged_header(frame: &WireFrame) -> [u8; STAGED_BODY_OFFSET] {
    let mut stream = [0u8; STREAM_HEADER_BYTES];
    write_stream_header(&mut stream, &frame.stream);
    let fixed = frame_header_fixed(&frame.header);
    let mut out = [0u8; STAGED_BODY_OFFSET];
    for (slot, byte) in out.iter_mut().zip(stream.iter().chain(&fixed)) {
        *slot = *byte;
    }
    out
}

/// Stage a wire frame into `out`, which is cleared first: its staged header,
/// then its body.
pub fn stage_wire_frame(frame: &WireFrame, body: &[u8], out: &mut Vec<u8>) {
    out.clear();
    out.reserve(STAGED_BODY_OFFSET + body.len());
    out.extend_from_slice(&staged_header(frame));
    out.extend_from_slice(body);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::RowRef;
    use crate::encode::encode_frame_into;

    fn header(kind: FrameKind) -> FrameHeader {
        FrameHeader {
            kind,
            memory_only: false,
            cols: 120,
            rows: 40,
            cursor_col: 7,
            cursor_row: 39,
            cursor_shape: 2,
            cursor_visible: 1,
            mode_flags: 0x1cf,
            row_count: 0,
            frame_id: 12,
            presentation_id: 9,
            presentation_member_index: 0,
            presentation_member_count: 1,
            row_predecessor_presentation_id: 8,
            presentation_coherent: true,
            presentation_end: true,
            chunk_index: 0,
            chunk_count: 1,
            demand_serial: 300,
            demand_limited: true,
            demand_prompt: false,
            demand_awaits_grant: true,
            closure_digest: 0,
            scroll_serial: 0x0102_0304,
            echo_horizon: 41,
        }
    }

    fn stream(seq: u32) -> StreamHeader {
        StreamHeader {
            msg_type: MSG_TYPE_DISPLAY_PATCH,
            flags: DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD,
            body_len: 0,
            seq,
            generation: 3,
            input_seq: 42,
        }
    }

    fn staged(stream: &StreamHeader, header: &FrameHeader, body: &[u8]) -> Vec<u8> {
        let mut frame = Vec::new();
        encode_frame_into(&mut frame, header, std::iter::empty::<RowRef<'_>>());
        frame.extend_from_slice(body);
        let mut stream = *stream;
        stream.body_len = u32::try_from(frame.len() - STREAM_HEADER_BYTES).unwrap();
        write_stream_header(&mut frame, &stream);
        frame
    }

    /// A staged frame survives the wire: staged → wire → staged is identity,
    /// for every combination of optional fields and for extreme values.
    #[test]
    fn every_header_round_trips_through_the_wire() {
        let mut cases = 0;
        for kind in [FrameKind::Delta, FrameKind::Snapshot] {
            for closure in [0, 0x8000_0000_0000_0001u64] {
                for horizon in [0, 41, 43, 1, u32::MAX] {
                    for (chunk_index, chunk_count) in [(0, 1), (0, 3), (2, 3), (0, 0)] {
                        for predecessor in [0, 8, 9, 10, u32::MAX] {
                            for (frame_id, presentation_id) in
                                [(12, 9), (5, 5), (0, 0), (u32::MAX, 1), (1, u32::MAX)]
                            {
                                for seq in [10, 0, u32::MAX] {
                                    let mut h = header(kind);
                                    h.closure_digest = closure;
                                    h.echo_horizon = horizon;
                                    h.chunk_index = chunk_index;
                                    h.chunk_count = chunk_count;
                                    h.row_predecessor_presentation_id = predecessor;
                                    h.frame_id = frame_id;
                                    h.presentation_id = presentation_id;
                                    h.cols = 1023;
                                    h.rows = 511;
                                    h.cursor_col = 1023;
                                    h.cursor_row = 511;
                                    h.cursor_shape = 15;
                                    h.mode_flags = 511;
                                    h.presentation_member_index = u16::MAX;
                                    h.demand_serial = u32::MAX;
                                    let body = [0xa5u8; 13];
                                    let mut frame = staged(&stream(seq), &h, &body);
                                    let expected = frame.clone();
                                    let start = write_wire_header_in_place(&mut frame).unwrap();
                                    let wire = &frame[start..];
                                    assert!(start >= STREAM_HEADER_BYTES + 55);
                                    assert_eq!(wire_frame_len(&expected).unwrap(), wire.len());
                                    let parsed = parse_wire(wire).unwrap();
                                    assert_eq!(&wire[parsed.body_offset..], &body);
                                    let mut restaged = Vec::new();
                                    stage_wire_frame(
                                        &parsed,
                                        &wire[parsed.body_offset..],
                                        &mut restaged,
                                    );
                                    assert_eq!(restaged, expected);
                                    cases += 1;
                                }
                            }
                        }
                    }
                }
            }
        }
        assert_eq!(cases, 2 * 2 * 5 * 4 * 5 * 5 * 3);
    }

    /// The bounds hold: no header is longer than the bound its fitting uses.
    #[test]
    fn the_longest_header_fits_its_bounds() {
        let mut h = header(FrameKind::Snapshot);
        h.closure_digest = u64::MAX;
        h.echo_horizon = 0x8000_0000;
        // Each relative field at the distance whose zigzag needs five bytes.
        h.presentation_id = 0x8000_0000;
        h.row_predecessor_presentation_id = 1;
        h.frame_id = 0x8000_0000;
        h.presentation_member_index = u16::MAX;
        h.presentation_member_count = u16::MAX;
        h.row_count = u16::MAX;
        h.demand_serial = u32::MAX;
        let mut s = stream(0);
        s.input_seq = 0;
        let mut out = [0u8; MAX_WIRE_HEADER_BYTES];
        assert_eq!(
            encode_wire_header(&s, &h, &mut out).unwrap(),
            MAX_UNCHUNKED_WIRE_HEADER_BYTES
        );
        h.chunk_index = u16::MAX;
        h.chunk_count = u16::MAX;
        assert_eq!(
            encode_wire_header(&s, &h, &mut out).unwrap(),
            MAX_WIRE_HEADER_BYTES
        );
    }

    /// The header a typed echo carries: what the cutover is for.
    #[test]
    fn a_typed_echo_header_is_small() {
        let s = StreamHeader {
            flags: 0,
            seq: 1_000,
            input_seq: 812,
            ..stream(0)
        };
        let mut h = header(FrameKind::Delta);
        h.frame_id = 1_003;
        h.presentation_id = 998;
        h.row_predecessor_presentation_id = 997;
        h.echo_horizon = 812;
        h.row_count = 1;
        h.demand_serial = 90;
        let mut out = [0u8; MAX_WIRE_HEADER_BYTES];
        assert_eq!(encode_wire_header(&s, &h, &mut out).unwrap(), 35);
    }

    /// A bit this version does not define, and a present field at its
    /// default, are refused: one logical frame has exactly one encoding.
    #[test]
    fn non_canonical_and_reserved_encodings_are_refused() {
        let frame = staged(&stream(10), &header(FrameKind::Delta), &[]);
        let mut wire = [0u8; MAX_WIRE_HEADER_BYTES];
        let len = wire_header(&frame, &mut wire).unwrap();
        let wire = &wire[..len];
        assert!(parse_wire(wire).is_ok());

        let mut reserved = wire.to_vec();
        reserved[2] |= 1 << 7;
        assert_eq!(parse_wire(&reserved), Err(WireError::ReservedBits));
        let mut reserved = wire.to_vec();
        reserved[3] |= PATCH_FLAG_UNDEFINED;
        assert_eq!(parse_wire(&reserved), Err(WireError::ReservedBits));
        let mut reserved = wire.to_vec();
        reserved[16] |= 0x10;
        assert_eq!(parse_wire(&reserved), Err(WireError::ReservedBits));
        let mut version = wire.to_vec();
        version[1] = VERSION - 1;
        assert_eq!(parse_wire(&version), Err(WireError::Version));

        // A chunk pair present at its default value. With no closure present
        // the chunk pair is the last field, so it can be appended.
        let mut chunk = wire.to_vec();
        chunk[2] |= WIRE_PRESENT_CHUNK;
        chunk.extend_from_slice(&[0, 1]);
        assert_eq!(parse_wire(&chunk), Err(WireError::NonCanonical));

        for len in 0..wire.len() {
            assert!(
                parse_wire(&wire[..len]).is_err(),
                "a {len}-byte header was accepted"
            );
        }
    }

    /// The packed geometry word refuses a value it cannot hold rather than
    /// truncating it.
    #[test]
    fn geometry_out_of_range_is_refused() {
        for field in 0..5 {
            let mut h = header(FrameKind::Delta);
            match field {
                0 => h.cols = 1024,
                1 => h.rows = 512,
                2 => h.cursor_col = 1024,
                3 => h.cursor_row = 512,
                _ => h.mode_flags = 512,
            }
            let mut out = [0u8; MAX_WIRE_HEADER_BYTES];
            assert_eq!(
                encode_wire_header(&stream(1), &h, &mut out),
                Err(WireError::Range)
            );
        }
    }

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|byte| format!("{byte:02x}")).collect()
    }

    /// The interop vector `packages/shared/src/display-wire.test.ts` pins its
    /// mirror to: staged frames and the wire frames this encoder makes of them.
    fn vector_json() -> String {
        let mut cases = Vec::new();
        let echo = {
            let mut h = header(FrameKind::Delta);
            h.frame_id = 1_003;
            h.presentation_id = 998;
            h.row_predecessor_presentation_id = 997;
            h.echo_horizon = 812;
            h.row_count = 0;
            h.demand_serial = 90;
            let s = StreamHeader {
                flags: 0,
                seq: 1_000,
                input_seq: 812,
                ..stream(0)
            };
            ("typed echo", s, h, vec![1u8, 2, 3])
        };
        let snapshot_chunk = {
            let mut h = header(FrameKind::Snapshot);
            h.chunk_index = 2;
            h.chunk_count = 5;
            h.closure_digest = 0x0123_4567_89ab_cdef;
            h.echo_horizon = 0;
            h.row_predecessor_presentation_id = 0;
            h.memory_only = true;
            ("snapshot chunk", stream(0), h, vec![9u8; 4])
        };
        let extremes = {
            let mut h = header(FrameKind::Delta);
            h.cols = 512;
            h.rows = 256;
            h.cursor_col = 511;
            h.cursor_row = 255;
            h.cursor_shape = 15;
            h.mode_flags = 0x1ff;
            h.frame_id = 0;
            h.presentation_id = u32::MAX;
            h.row_predecessor_presentation_id = 1;
            h.echo_horizon = u32::MAX;
            h.presentation_member_index = 300;
            h.presentation_member_count = 301;
            h.demand_serial = u32::MAX;
            h.scroll_serial = u32::MAX;
            let s = StreamHeader {
                flags: DISPLAY_HEADER_FLAG_FEC_PROTECTED | DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD,
                seq: 7,
                input_seq: 3,
                generation: u32::MAX,
                ..stream(0)
            };
            ("extremes", s, h, Vec::new())
        };
        for (name, s, h, body) in [echo, snapshot_chunk, extremes] {
            let mut frame = staged(&s, &h, &body);
            let staged_hex = hex(&frame);
            let start = write_wire_header_in_place(&mut frame).expect("a wire header");
            cases.push(format!(
                "    {{\n      \"name\": \"{name}\",\n      \"staged\": \"{staged_hex}\",\n      \"wire\": \"{}\",\n      \"generation\": {},\n      \"seq\": {},\n      \"frameId\": {},\n      \"chunkIndex\": {},\n      \"chunkCount\": {}\n    }}",
                hex(&frame[start..]),
                s.generation,
                s.seq,
                h.frame_id,
                h.chunk_index,
                h.chunk_count,
            ));
        }
        format!(
            "{{\n  \"version\": {VERSION},\n  \"maxUnchunkedHeaderBytes\": {MAX_UNCHUNKED_WIRE_HEADER_BYTES},\n  \"cases\": [\n{}\n  ]\n}}\n",
            cases.join(",\n")
        )
    }

    fn vector_path() -> std::path::PathBuf {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../shared/test-vectors/display-wire.json")
    }

    #[test]
    fn the_encoder_reproduces_the_committed_wire_vector() {
        let committed =
            std::fs::read_to_string(vector_path()).expect("the display wire vector is committed");
        assert_eq!(
            committed,
            vector_json(),
            "the wire encoder drifted from its vector"
        );
    }

    // Run with: MERKUR_WRITE_DISPLAY_WIRE_VECTOR=1 cargo test -p merkur-codec write_wire_vector -- --ignored
    #[test]
    #[ignore = "writes the committed vector"]
    fn write_wire_vector() {
        if std::env::var("MERKUR_WRITE_DISPLAY_WIRE_VECTOR").is_ok() {
            std::fs::write(vector_path(), vector_json()).expect("vector written");
        }
    }

    /// The prefix reads exactly the fixed fields a full parse reads.
    #[test]
    fn the_prefix_agrees_with_the_full_parse() {
        let frame = staged(&stream(77), &header(FrameKind::Delta), &[1, 2, 3]);
        let mut out = [0u8; MAX_WIRE_HEADER_BYTES];
        let len = wire_header(&frame, &mut out).unwrap();
        let parsed = parse_wire(&out[..len]).unwrap();
        let prefix = parse_wire_prefix(&out[..len]).unwrap();
        assert_eq!(prefix.flags, parsed.stream.flags);
        assert_eq!(prefix.generation, parsed.stream.generation);
        assert_eq!(prefix.seq, parsed.stream.seq);
        assert_eq!(prefix.input_seq, parsed.stream.input_seq);
    }
}
