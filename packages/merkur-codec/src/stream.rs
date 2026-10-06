//! The 18-byte stream header that wraps every display frame.
//!
//! This header had three implementations and no shared owner: the daemon
//! stamped it with private constants in `display/encoder.rs`, term-wasm read
//! parts of it while validating, and the browser read it again in TypeScript.
//! A wire format with three implementations and no single definition is exactly
//! what `merkur-e2e` exists to prevent for crypto, so it lives here now and
//! the writer and reader sit beside each other.
//!
//! Layout, all big-endian:
//!
//! ```text
//! 0      msg_type   u8    MSG_TYPE_DISPLAY_PATCH
//! 1      flags      u8
//! 2..6   body_len   u32   bytes following this header
//! 6..10  seq        u32   display sequence; the browser applies frames by it
//! 10..14 generation u32   resets seq space on rollover
//! 14..18 input_seq  u32   input this frame is the echo of, for attribution
//! ```

use crate::STREAM_HEADER_BYTES;

pub const DISPLAY_MSG_TYPE_OFFSET: usize = 0;
pub const DISPLAY_STREAM_FLAGS_OFFSET: usize = 1;
pub const DISPLAY_BODY_LENGTH_OFFSET: usize = 2;
pub const DISPLAY_SEQ_OFFSET: usize = 6;
pub const DISPLAY_GENERATION_OFFSET: usize = 10;
pub const DISPLAY_BASE_SEQ_OFFSET: usize = 14;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StreamHeader {
    pub msg_type: u8,
    pub flags: u8,
    pub body_len: u32,
    pub seq: u32,
    pub generation: u32,
    pub input_seq: u32,
}

#[inline]
fn u32_at(payload: &[u8], offset: usize) -> u32 {
    u32::from_be_bytes(
        payload[offset..offset + 4]
            .try_into()
            .expect("slice is four bytes"),
    )
}

/// Read the stream header, or `None` if the payload is too short to hold one.
#[inline]
pub fn parse_stream_header(payload: &[u8]) -> Option<StreamHeader> {
    if payload.len() < STREAM_HEADER_BYTES {
        return None;
    }
    Some(StreamHeader {
        msg_type: payload[DISPLAY_MSG_TYPE_OFFSET],
        flags: payload[DISPLAY_STREAM_FLAGS_OFFSET],
        body_len: u32_at(payload, DISPLAY_BODY_LENGTH_OFFSET),
        seq: u32_at(payload, DISPLAY_SEQ_OFFSET),
        generation: u32_at(payload, DISPLAY_GENERATION_OFFSET),
        input_seq: u32_at(payload, DISPLAY_BASE_SEQ_OFFSET),
    })
}

/// Stamp the stream header over the first [`STREAM_HEADER_BYTES`] of `payload`.
#[inline]
pub fn write_stream_header(payload: &mut [u8], header: &StreamHeader) {
    debug_assert!(payload.len() >= STREAM_HEADER_BYTES);
    payload[DISPLAY_MSG_TYPE_OFFSET] = header.msg_type;
    payload[DISPLAY_STREAM_FLAGS_OFFSET] = header.flags;
    payload[DISPLAY_BODY_LENGTH_OFFSET..DISPLAY_BODY_LENGTH_OFFSET + 4]
        .copy_from_slice(&header.body_len.to_be_bytes());
    payload[DISPLAY_SEQ_OFFSET..DISPLAY_SEQ_OFFSET + 4].copy_from_slice(&header.seq.to_be_bytes());
    payload[DISPLAY_GENERATION_OFFSET..DISPLAY_GENERATION_OFFSET + 4]
        .copy_from_slice(&header.generation.to_be_bytes());
    payload[DISPLAY_BASE_SEQ_OFFSET..DISPLAY_BASE_SEQ_OFFSET + 4]
        .copy_from_slice(&header.input_seq.to_be_bytes());
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Writer and reader agree, field for field. They are now the only two
    /// implementations of this layout, and they name the same constants.
    #[test]
    fn a_written_header_reads_back_unchanged() {
        let header = StreamHeader {
            msg_type: 0x20,
            flags: 0x02,
            body_len: 0x0001_2345,
            seq: 0xDEAD_BEEF,
            generation: 7,
            input_seq: 0x1234_5678,
        };
        let mut payload = vec![0u8; STREAM_HEADER_BYTES + 4];
        write_stream_header(&mut payload, &header);
        assert_eq!(parse_stream_header(&payload), Some(header));
    }

    /// A payload shorter than the header is refused, not read past.
    #[test]
    fn a_truncated_header_is_refused() {
        for len in 0..STREAM_HEADER_BYTES {
            assert!(
                parse_stream_header(&vec![0u8; len]).is_none(),
                "a {len}-byte payload was accepted as a stream header"
            );
        }
    }

    /// Every field occupies its own bytes: changing one moves nothing else.
    #[test]
    fn each_field_is_independent() {
        let base = StreamHeader {
            msg_type: 1,
            flags: 2,
            body_len: 3,
            seq: 4,
            generation: 5,
            input_seq: 6,
        };
        let mut payload = vec![0u8; STREAM_HEADER_BYTES];
        write_stream_header(&mut payload, &base);
        for (label, mutated) in [
            ("seq", StreamHeader { seq: 99, ..base }),
            (
                "generation",
                StreamHeader {
                    generation: 99,
                    ..base
                },
            ),
            (
                "input_seq",
                StreamHeader {
                    input_seq: 99,
                    ..base
                },
            ),
        ] {
            let mut other = vec![0u8; STREAM_HEADER_BYTES];
            write_stream_header(&mut other, &mutated);
            let differing = payload
                .iter()
                .zip(other.iter())
                .filter(|(a, b)| a != b)
                .count();
            assert!(
                differing > 0 && differing <= 4,
                "changing {label} touched {differing} bytes; fields overlap"
            );
        }
    }
}
