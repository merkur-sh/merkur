//! Allocation-free encoding of one validated source region into the tile dialect.
//! The bounded processing owner supplies its reusable compressor and scratch. This
//! module never accepts a compressed source or allocates a retained output object.
use crate::compressor::{ARENA_BYTES, Compressor};
use crate::frame::Raster;
use merkur_graphics::budget::{Lease, Usage};
#[cfg(test)]
use merkur_graphics::processing::Pixels;
use merkur_graphics::tile::{TILE_ENCODED_BYTES, TILE_SIDE, TILE_STORED_SIDE, TileShape};
use zeroize::Zeroize;

/// Resource bound: one PNG filter byte per stored scanline plus RGBA bytes.
pub const SCANLINE_BYTES: usize = (TILE_STORED_SIDE * 4 + 1) * TILE_STORED_SIDE;

/// Resource bound for all retained encoder allocations plus owner metadata.
pub const ENCODER_BYTES: usize =
    ARENA_BYTES + SCANLINE_BYTES + crate::pyramid::ROW_BYTES + size_of::<Encoder>();

/// Validate exact pyramid coordinates before allocating an encoder or transport owner.
pub fn level_shape(source: &impl Raster, level: u8, x: u32, y: u32) -> Option<TileShape> {
    crate::pyramid::shape(source, level, x, y)
}

pub struct Encoder {
    compressor: Compressor,
    scanlines: Box<[u8]>,
    scanlines_used: usize,
    rows: crate::pyramid::Rows,
    _lease: Lease,
}

impl Encoder {
    #[cfg(test)]
    pub(crate) fn scratch_is_clear(&self) -> bool {
        self.scanlines.iter().all(|byte| *byte == 0) && self.rows.is_clear()
    }

    /// Admission precedes every allocation, including the C context's arena.
    pub fn new(lease: Lease) -> Option<Self> {
        let charge = lease.charge();
        if charge.bytes < ENCODER_BYTES || charge.objects < 1 {
            return None;
        }
        Some(Self {
            compressor: Compressor::new()?,
            scanlines: vec![0; SCANLINE_BYTES].into_boxed_slice(),
            scanlines_used: 0,
            rows: crate::pyramid::Rows::new(),
            _lease: lease,
        })
    }

    pub const fn charge() -> Usage {
        Usage {
            bytes: ENCODER_BYTES,
            objects: 1,
        }
    }

    /// Clear only the footprint visited since the last checkout. Marking the
    /// span before encoding also covers cancellation and unwinding mid-row.
    pub(crate) fn clear_scratch(&mut self) {
        crate::encoding::wipe(&mut self.scanlines[..self.scanlines_used]);
        self.scanlines_used = 0;
        self.rows.clear();
    }

    /// Output storage is supplied and charged by the caller.
    pub fn encode(
        &mut self,
        pixels: &impl Raster,
        x: u32,
        y: u32,
        output: &mut [u8],
    ) -> Option<(TileShape, usize)> {
        let shape = shape(pixels, x, y)?;
        self.scanlines_used = self
            .scanlines_used
            .max((shape.stride() + 1) * usize::from(shape.height()));
        encode(
            pixels,
            x,
            y,
            &mut self.compressor,
            &mut self.scanlines,
            output,
        )
    }

    /// Reduction and compression share one admitted context. No mip allocation
    /// or blocking-task handoff occurs between pyramid levels.
    pub fn encode_level(
        &mut self,
        pixels: &impl Raster,
        level: u8,
        tile: [u32; 2],
        output: &mut [u8],
        mut cancelled: impl FnMut() -> bool,
    ) -> Option<(TileShape, usize)> {
        if cancelled() {
            return None;
        }
        if level == 0 {
            return self.encode(pixels, tile[0], tile[1], output);
        }
        let shape = level_shape(pixels, level, tile[0], tile[1])?;
        self.scanlines_used = self
            .scanlines_used
            .max((shape.stride() + 1) * usize::from(shape.height()));
        let shape = self.rows.scanlines(
            pixels,
            level,
            tile[0],
            tile[1],
            &mut self.scanlines,
            &mut cancelled,
        )?;
        if cancelled() {
            return None;
        }
        compress(shape, &mut self.compressor, &self.scanlines, output)
    }
}

impl Drop for Encoder {
    fn drop(&mut self) {
        self.scanlines.zeroize();
    }
}

/// Source tile indices. The final interior is clipped to the source dimensions;
/// gutters sample neighbouring source pixels, clamping only at the source edge.
pub fn shape(pixels: &impl Raster, x: u32, y: u32) -> Option<TileShape> {
    let x = x.checked_mul(TILE_SIDE as u32)?;
    let y = y.checked_mul(TILE_SIDE as u32)?;
    let width = pixels.width().checked_sub(x)?.min(TILE_SIDE as u32);
    let height = pixels.height().checked_sub(y)?.min(TILE_SIDE as u32);
    if width == 0 || height == 0 {
        return None;
    }
    TileShape::new(width + 2, height + 2)
}

/// Encodes directly into the caller's output span, including the PNG envelope.
/// The owner constructs the compressor at the fixed level 1 and reserves its
/// workspace before construction. Output is publishable only after success.
fn encode(
    pixels: &impl Raster,
    x: u32,
    y: u32,
    compressor: &mut Compressor,
    scanlines: &mut [u8],
    output: &mut [u8],
) -> Option<(TileShape, usize)> {
    let shape = shape(pixels, x, y)?;
    let stride = shape.stride();
    let scanlines = scanlines.get_mut(..(stride + 1) * usize::from(shape.height()))?;
    let output = output.get_mut(..TILE_ENCODED_BYTES)?;
    // Populate the Up filter directly from the immutable source. There is no
    // intermediate packed RGBA tile and no copy of the compressed payload.
    let x = x as usize * TILE_SIDE;
    let y = y as usize * TILE_SIDE;
    let width = pixels.width() as usize;
    let height = pixels.height() as usize;
    let interior = usize::from(shape.width()) - 2;
    for (row, out) in scanlines.chunks_exact_mut(stride + 1).enumerate() {
        out[0] = 2;
        let sy = (y + row).saturating_sub(1).min(height - 1) as u32;
        let above_y = (y + row.saturating_sub(1))
            .saturating_sub(1)
            .min(height - 1) as u32;
        filter_span(
            &mut out[1..5],
            pixels,
            x.saturating_sub(1) as u32,
            sy,
            above_y,
            row == 0,
        );
        filter_span(
            &mut out[5..5 + interior * 4],
            pixels,
            x as u32,
            sy,
            above_y,
            row == 0,
        );
        filter_span(
            &mut out[stride - 3..],
            pixels,
            (x + interior).min(width - 1) as u32,
            sy,
            above_y,
            row == 0,
        );
    }
    compress(shape, compressor, scanlines, output)
}

fn compress(
    shape: TileShape,
    compressor: &mut Compressor,
    scanlines: &[u8],
    output: &mut [u8],
) -> Option<(TileShape, usize)> {
    let scanlines = scanlines.get(..(shape.stride() + 1) * usize::from(shape.height()))?;
    let output = output.get_mut(..TILE_ENCODED_BYTES)?;
    let count = compressor.compress(scanlines, &mut output[41..TILE_ENCODED_BYTES - 16])?;
    output[..16].copy_from_slice(b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR");
    output[16..20].copy_from_slice(&u32::from(shape.width()).to_be_bytes());
    output[20..24].copy_from_slice(&u32::from(shape.height()).to_be_bytes());
    output[24..29].copy_from_slice(&[8, 6, 0, 0, 0]);
    let crc = crc32fast::hash(&output[12..29]);
    output[29..33].copy_from_slice(&crc.to_be_bytes());
    output[33..37].copy_from_slice(&(count as u32).to_be_bytes());
    output[37..41].copy_from_slice(b"IDAT");
    let crc = crc32fast::hash(&output[37..41 + count]);
    output[41 + count..45 + count].copy_from_slice(&crc.to_be_bytes());
    output[45 + count..57 + count].copy_from_slice(b"\0\0\0\0IEND\xae\x42\x60\x82");
    Some((shape, count + 57))
}

fn filter_span(
    mut out: &mut [u8],
    pixels: &impl Raster,
    mut x: u32,
    y: u32,
    above_y: u32,
    first: bool,
) {
    while !out.is_empty() {
        let source = pixels.run(x, y);
        let above = pixels.run(x, above_y);
        let count = out.len().min(source.len()).min(above.len());
        up_filter(&mut out[..count], &source[..count], &above[..count], first);
        x += (count / 4) as u32;
        out = &mut out[count..];
    }
}

fn up_filter(out: &mut [u8], source: &[u8], above: &[u8], first: bool) {
    if first {
        out.copy_from_slice(source);
    } else {
        for ((out, source), above) in out.iter_mut().zip(source).zip(above) {
            *out = source.wrapping_sub(*above);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use merkur_graphics::tile::{TileVerifier, object_root};

    #[test]
    fn streamed_mips_match_whole_image_reduction_including_every_gutter() {
        use merkur_graphics::budget::Budget;
        let budget = Budget::new(Encoder::charge());
        let mut streamed = Encoder::new(budget.reserve(Encoder::charge()).unwrap()).unwrap();
        let mut compressor = Compressor::new().unwrap();
        let mut scanlines = vec![0; SCANLINE_BYTES];
        let mut actual = vec![0; TILE_ENCODED_BYTES];
        let mut expected = vec![0; TILE_ENCODED_BYTES];
        for (w, h) in [
            (1, 1),
            (1, 519),
            (513, 1),
            (1027, 519),
            (16384, 1),
            (1, 16384),
        ] {
            let source = Pixels::new(
                w,
                h,
                (0..w * h * 4)
                    .map(|i| (i * 37 + i / 91) as u8)
                    .collect::<Vec<_>>()
                    .into(),
            )
            .unwrap();
            let max_level = w.max(h).next_power_of_two().ilog2() as u8;
            let mut previous = None;
            for level in 0..=max_level {
                if level > 0 {
                    previous = Some(
                        crate::pyramid::reduce(previous.as_ref().unwrap_or(&source), || false)
                            .unwrap(),
                    );
                }
                let reference = previous.as_ref().unwrap_or(&source);
                // Reverse order also proves that memoized scratch from an earlier
                // tile/level/source cannot survive the next request's setup.
                for y in (0..reference.height().div_ceil(TILE_SIDE as u32)).rev() {
                    for x in (0..reference.width().div_ceil(TILE_SIDE as u32)).rev() {
                        let (expected_shape, expected_size) = encode(
                            reference,
                            x,
                            y,
                            &mut compressor,
                            &mut scanlines,
                            &mut expected,
                        )
                        .unwrap();
                        let (actual_shape, actual_size) = streamed
                            .encode_level(&source, level, [x, y], &mut actual, || false)
                            .unwrap();
                        assert_eq!(actual_shape, expected_shape);
                        assert_eq!(
                            &actual[..actual_size],
                            &expected[..expected_size],
                            "{w}x{h}, level {level}, tile {x},{y}"
                        );
                    }
                }
            }
            assert!(
                streamed
                    .encode_level(&source, max_level + 1, [0, 0], &mut actual, || false)
                    .is_none()
            );
            assert!(
                streamed
                    .encode_level(&source, 255, [0, 0], &mut actual, || false)
                    .is_none()
            );
            assert!(
                streamed
                    .encode_level(&source, max_level, [u32::MAX, 0], &mut actual, || false)
                    .is_none()
            );
        }
    }

    #[test]
    fn cancellation_interrupts_reduction_before_visiting_the_whole_source() {
        use merkur_graphics::budget::Budget;
        let budget = Budget::new(Encoder::charge());
        let mut encoder = Encoder::new(budget.reserve(Encoder::charge()).unwrap()).unwrap();
        let source = Pixels::new(2048, 2048, vec![255; 2048 * 2048 * 4].into()).unwrap();
        let mut output = vec![0; TILE_ENCODED_BYTES];
        let mut rows = 0;
        assert!(
            encoder
                .encode_level(&source, 11, [0, 0], &mut output, || {
                    rows += 1;
                    rows == 20
                })
                .is_none()
        );
        assert_eq!(rows, 20);
        assert!(
            encoder
                .encode_level(&source, 1, [3, 3], &mut output, || false)
                .is_some()
        );
    }

    #[test]
    fn clipped_tiles_gutters_and_hidden_rgb_round_trip_exactly() {
        let mut compressor = Compressor::new().unwrap();
        let mut scanlines = vec![0; SCANLINE_BYTES];
        let mut output = vec![0; TILE_ENCODED_BYTES];
        assert!(compressor.bound(SCANLINE_BYTES) + 57 <= output.len());
        for (w, h) in [(1, 1), (1, 519), (513, 1), (256, 256), (513, 519)] {
            let rgba = (0..w * h * 4)
                .map(|i| (i * 37 + i / 91) as u8)
                .collect::<Vec<_>>();
            let pixels = Pixels::new(w, h, rgba.into_boxed_slice()).unwrap();
            for y in 0..h.div_ceil(TILE_SIDE as u32) {
                for x in 0..w.div_ceil(TILE_SIDE as u32) {
                    let (shape, size) =
                        encode(&pixels, x, y, &mut compressor, &mut scanlines, &mut output)
                            .unwrap();
                    let mut verifier = TileVerifier::default();
                    assert!(verifier.begin(size, shape, object_root(&output[..size])));
                    for chunk in output[..size].chunks(17) {
                        assert!(verifier.update(chunk));
                    }
                    assert!(verifier.finish());
                    let mut reader = png::Decoder::new(std::io::Cursor::new(&output[..size]))
                        .read_info()
                        .unwrap();
                    let mut decoded = vec![0; shape.bytes()];
                    reader.next_frame(&mut decoded).unwrap();
                    reader.finish().unwrap();
                    for row in 0..u32::from(shape.height()) {
                        for col in 0..u32::from(shape.width()) {
                            let sy = (y * TILE_SIDE as u32 + row).saturating_sub(1).min(h - 1);
                            let sx = (x * TILE_SIDE as u32 + col).saturating_sub(1).min(w - 1);
                            let src = ((sy * w + sx) * 4) as usize;
                            let dst = row as usize * shape.stride() + col as usize * 4;
                            assert_eq!(&decoded[dst..dst + 4], &pixels.rgba()[src..src + 4]);
                        }
                    }
                }
            }
            for (x, y) in [(w, 0), (0, h), (u32::MAX, u32::MAX)] {
                assert!(
                    encode(&pixels, x, y, &mut compressor, &mut scanlines, &mut output).is_none()
                );
            }
        }
    }
}
