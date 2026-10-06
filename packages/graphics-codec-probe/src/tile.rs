//! Selection-only zstd candidate; never used by the application.
//!
//! A tile has a four-byte big-endian width/height header and one zstd frame of
//! Up-filtered straight-alpha RGBA8 sRGB pixels. One texel of source-neighbour
//! gutter surrounds the interior. The object commitment covers shape and bytes.
use std::io::{Cursor, Read};

/// Proposed wire geometry under browser measurement; no runtime negotiation.
pub const TILE_SIDE: usize = 256;
pub const TILE_GUTTER: usize = 1;
pub const TILE_STORED_SIDE: usize = TILE_SIDE + TILE_GUTTER * 2;
pub const TILE_HEADER_BYTES: usize = 4;
pub const TILE_RGBA_BYTES: usize = TILE_STORED_SIDE * TILE_STORED_SIDE * 4;
/// Resource bound larger than libzstd's compressBound for the largest tile.
pub const TILE_ENCODED_BYTES: usize = 264 * 1024;
const DOMAIN: &[u8] = b"merkur.graphics.tile.rgba8.srgb.straight-alpha.up-zstd\0";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TileShape {
    width: u16,
    height: u16,
}

impl TileShape {
    pub fn new(width: u16, height: u16) -> Option<Self> {
        let valid = 1 + 2 * TILE_GUTTER..=TILE_STORED_SIDE;
        (valid.contains(&usize::from(width)) && valid.contains(&usize::from(height)))
            .then_some(Self { width, height })
    }

    pub fn width(self) -> u16 {
        self.width
    }
    pub fn height(self) -> u16 {
        self.height
    }
    pub fn stride(self) -> usize {
        usize::from(self.width) * 4
    }
    pub fn bytes(self) -> usize {
        self.stride() * usize::from(self.height)
    }
    pub fn header(self) -> [u8; TILE_HEADER_BYTES] {
        let [a, b] = self.width.to_be_bytes();
        let [c, d] = self.height.to_be_bytes();
        [a, b, c, d]
    }
}

pub fn object_root(encoded: &[u8]) -> [u8; 32] {
    let mut hash = blake3::Hasher::new();
    hash.update(DOMAIN);
    hash.update(encoded);
    *hash.finalize().as_bytes()
}

/// Encoding scratch is supplied by the bounded processing owner. No allocation.
pub fn filter(shape: TileShape, rgba: &[u8], output: &mut [u8]) -> bool {
    let size = shape.bytes();
    if rgba.len() != size || output.len() != size {
        return false;
    }
    let stride = shape.stride();
    output[..stride].copy_from_slice(&rgba[..stride]);
    for ((out, byte), above) in output[stride..].iter_mut().zip(&rgba[stride..]).zip(rgba) {
        *out = byte.wrapping_sub(*above);
    }
    true
}

fn unfilter(shape: TileShape, bytes: &mut [u8]) {
    let stride = shape.stride();
    for offset in (stride..bytes.len()).step_by(stride) {
        let (before, after) = bytes.split_at_mut(offset);
        for (out, above) in after[..stride].iter_mut().zip(&before[offset - stride..]) {
            *out = out.wrapping_add(*above);
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TileError {
    Shape,
    Commitment,
    Frame,
}

/// One asset worker's reusable decoder. Neither its input nor its result is
/// scene authority. The caller owns admission for this workspace and both buffers.
pub struct TileDecoder {
    decoder: ruzstd::decoding::FrameDecoder,
}

impl Default for TileDecoder {
    fn default() -> Self {
        let mut decoder = ruzstd::decoding::FrameDecoder::new();
        // Checked by ruzstd before allocating frame history, including on reset.
        decoder.set_max_window_size(TILE_RGBA_BYTES as u64);
        Self { decoder }
    }
}

impl TileDecoder {
    /// On failure, output may contain partial scratch and must not be published.
    /// Exact shape and content commitment are checked before decoder allocation.
    pub fn decode(
        &mut self,
        encoded: &[u8],
        expected: &[u8; 32],
        shape: TileShape,
        output: &mut [u8],
    ) -> Result<(), TileError> {
        if encoded.len() > TILE_ENCODED_BYTES
            || encoded.get(..TILE_HEADER_BYTES) != Some(&shape.header())
            || output.len() != shape.bytes()
        {
            return Err(TileError::Shape);
        }
        if &object_root(encoded) != expected {
            return Err(TileError::Commitment);
        }
        let mut input = Cursor::new(&encoded[TILE_HEADER_BYTES..]);
        {
            let mut reader =
                ruzstd::decoding::StreamingDecoder::new_with_decoder(&mut input, &mut self.decoder)
                    .map_err(|_| TileError::Frame)?;
            reader.read_exact(output).map_err(|_| TileError::Frame)?;
            // Reject both underproduction and overproduction, not just a matching prefix.
            if reader.read(&mut [0]).map_err(|_| TileError::Frame)? != 0 {
                return Err(TileError::Frame);
            }
        }
        // One complete frame, no concatenated frame or trailing garbage.
        if input.position() as usize != encoded.len() - TILE_HEADER_BYTES {
            return Err(TileError::Frame);
        }
        unfilter(shape, output);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encoded(shape: TileShape, rgba: &[u8]) -> Vec<u8> {
        let mut filtered = vec![0; shape.bytes()];
        assert!(filter(shape, rgba, &mut filtered));
        let mut bytes = shape.header().to_vec();
        bytes.extend(zstd::bulk::compress(&filtered, 3).unwrap());
        bytes
    }

    #[test]
    fn shapes_round_trip_with_reused_decoder_and_exact_hidden_rgb() {
        let mut decoder = TileDecoder::default();
        for (w, h) in [(258, 258), (3, 3), (31, 97), (258, 3), (3, 258), (258, 258)] {
            let shape = TileShape::new(w, h).unwrap();
            let input: Vec<u8> = (0..shape.bytes())
                .map(|i| ((i * 37 + i / 91) & 255) as u8)
                .collect();
            let bytes = encoded(shape, &input);
            assert!(bytes.len() <= TILE_ENCODED_BYTES);
            let mut output = vec![0; input.len()];
            decoder
                .decode(&bytes, &object_root(&bytes), shape, &mut output)
                .unwrap();
            assert_eq!(output, input);
        }
    }

    #[test]
    fn hostile_shape_commitment_length_and_frames_are_refused() {
        for (w, h) in [(0, 3), (3, 0), (2, 3), (3, 259), (u16::MAX, u16::MAX)] {
            assert!(TileShape::new(w, h).is_none());
        }
        let shape = TileShape::new(3, 3).unwrap();
        let bytes = encoded(shape, &[17; 36]);
        let root = object_root(&bytes);
        let mut decoder = TileDecoder::default();
        let mut output = [99; 36];
        let mut corrupt = bytes.clone();
        *corrupt.last_mut().unwrap() ^= 1;
        assert_eq!(
            decoder.decode(&corrupt, &root, shape, &mut output),
            Err(TileError::Commitment)
        );
        assert_eq!(output, [99; 36]);
        for end in 0..bytes.len() {
            let truncated = &bytes[..end];
            assert!(
                decoder
                    .decode(truncated, &object_root(truncated), shape, &mut output)
                    .is_err()
            );
        }
        for size in [35, 37, 100000] {
            let mut over = shape.header().to_vec();
            over.extend(zstd::bulk::compress(&vec![0; size], 3).unwrap());
            assert_eq!(
                decoder.decode(&over, &object_root(&over), shape, &mut output),
                Err(TileError::Frame)
            );
        }
        for suffix in [vec![0], bytes[4..].to_vec()] {
            let mut trailing = bytes.clone();
            trailing.extend(suffix);
            assert_eq!(
                decoder.decode(&trailing, &object_root(&trailing), shape, &mut output),
                Err(TileError::Frame)
            );
        }
        let mut huge = shape.header().to_vec();
        // zstd, non-single segment, 1 GiB window: reject before history allocation.
        huge.extend([0x28, 0xb5, 0x2f, 0xfd, 0, 0xa0, 1, 0, 0]);
        assert_eq!(
            decoder.decode(&huge, &object_root(&huge), shape, &mut output),
            Err(TileError::Frame)
        );
        decoder.decode(&bytes, &root, shape, &mut output).unwrap();
        assert_eq!(output, [17; 36]);
    }
}
