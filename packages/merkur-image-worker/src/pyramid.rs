//! Deterministic linear-light, alpha-weighted 2x reduction. Source pixels are
//! already normalized RGBA8; no decoder or untrusted file format runs here.
use crate::frame::Raster;
use merkur_graphics::processing::MAX_DIMENSION;
#[cfg(test)]
use merkur_graphics::processing::Pixels;
use merkur_graphics::tile::{TILE_SIDE, TileShape};
use zeroize::Zeroize;

const LEVELS: usize = MAX_DIMENSION.ilog2() as usize;
// Two rows at each reduced width form a geometric series smaller than two
// source rows. Rounding each odd width adds at most one pixel per level.
pub(crate) const ROW_BYTES: usize = (MAX_DIMENSION as usize + LEVELS) * 8;

#[derive(Clone, Copy, Default)]
struct Region {
    first: usize,
    width: usize,
    offset: usize,
    height: u32,
    rows: [Option<u32>; 2],
}

/// A depth-first row pipeline. Only the requested tile's source footprint is
/// visited; two memoized rows per level suffice, including neighboring gutters.
/// Scratch belongs to the admitted encoder and is reused across every request.
pub(crate) struct Rows {
    bytes: Box<[u8]>,
    used: usize,
    regions: [Region; LEVELS],
}

impl Rows {
    #[cfg(test)]
    pub(crate) fn is_clear(&self) -> bool {
        self.bytes.iter().all(|byte| *byte == 0)
    }

    pub(crate) fn new() -> Self {
        Self {
            bytes: vec![0; ROW_BYTES].into_boxed_slice(),
            used: 0,
            regions: [Region::default(); LEVELS],
        }
    }

    pub(crate) fn clear(&mut self) {
        crate::encoding::wipe(&mut self.bytes[..self.used]);
        self.used = 0;
        self.regions.fill(Region::default());
    }

    pub(crate) fn scanlines(
        &mut self,
        source: &impl Raster,
        level: u8,
        x: u32,
        y: u32,
        scanlines: &mut [u8],
        mut cancelled: impl FnMut() -> bool,
    ) -> Option<TileShape> {
        let shape = shape(source, level, x, y)?;
        if level == 0 {
            return None;
        }
        let level = usize::from(level);
        let width = source.width().div_ceil(1 << level) as usize;
        let height = source.height().div_ceil(1 << level);
        let x = x as usize * TILE_SIDE;
        let y = y * TILE_SIDE as u32;
        let mut first = x.saturating_sub(1);
        let mut end = (x + usize::from(shape.width()) - 1).min(width);
        for index in (0..level).rev() {
            self.regions[index] = Region {
                first,
                width: end - first,
                height: source.height().div_ceil(1 << (index + 1)),
                ..Region::default()
            };
            first *= 2;
            end = (end * 2).min(source.width().div_ceil(1 << index) as usize);
        }
        let mut offset = 0;
        for region in &mut self.regions[..level] {
            region.offset = offset;
            offset += region.width * 8;
        }
        if offset > self.bytes.len() {
            return None;
        }
        self.used = self.used.max(offset);
        let stride = shape.stride() + 1;
        let scanlines = scanlines.get_mut(..stride * usize::from(shape.height()))?;
        for (row, out) in scanlines.chunks_exact_mut(stride).enumerate() {
            let sy = (y + row as u32).saturating_sub(1).min(height - 1);
            if !self.row(source, level - 1, sy, &mut cancelled) {
                return None;
            }
            let region = self.regions[level - 1];
            let offset = region.offset + (sy as usize % 2) * region.width * 4;
            let pixels = &self.bytes[offset..offset + region.width * 4];
            out[0] = 2;
            for (col, pixel) in out[1..].chunks_exact_mut(4).enumerate() {
                let sx = (x + col).saturating_sub(1).min(width - 1) - region.first;
                pixel.copy_from_slice(&pixels[sx * 4..sx * 4 + 4]);
            }
        }
        // Apply Up bottom-to-top so each predecessor still contains exact RGBA.
        for row in (1..usize::from(shape.height())).rev() {
            let (above, current) = scanlines.split_at_mut(row * stride);
            for (out, previous) in current[1..stride]
                .iter_mut()
                .zip(&above[(row - 1) * stride + 1..row * stride])
            {
                *out = out.wrapping_sub(*previous);
            }
        }
        Some(shape)
    }

    fn row(
        &mut self,
        source: &impl Raster,
        index: usize,
        y: u32,
        cancelled: &mut impl FnMut() -> bool,
    ) -> bool {
        let region = self.regions[index];
        let slot = y as usize % 2;
        if region.rows[slot] == Some(y) {
            return true;
        }
        if cancelled() {
            return false;
        }
        let child_height = if index == 0 {
            source.height()
        } else {
            self.regions[index - 1].height
        };
        let second = y * 2 + 1 < child_height;
        if index > 0
            && (!self.row(source, index - 1, y * 2, cancelled)
                || (second && !self.row(source, index - 1, y * 2 + 1, cancelled)))
        {
            return false;
        }
        let (input, output) = self.bytes.split_at_mut(region.offset);
        let out = &mut output[slot * region.width * 4..(slot + 1) * region.width * 4];
        if index == 0 {
            let mut x = region.first as u32 * 2;
            let mut out = out;
            while !out.is_empty() {
                let first = source.run(x, y * 2);
                let next = second.then(|| source.run(x, y * 2 + 1));
                let input_bytes = (out.len() * 2)
                    .min(first.len())
                    .min(next.map_or(usize::MAX, <[u8]>::len));
                let output_bytes = input_bytes.div_ceil(8) * 4;
                reduce_row(
                    &first[..input_bytes],
                    next.map(|row| &row[..input_bytes]),
                    &mut out[..output_bytes],
                );
                x += (input_bytes / 4) as u32;
                out = &mut out[output_bytes..];
            }
        } else {
            let child = self.regions[index - 1];
            let stride = child.width * 4;
            reduce_row(
                &input[child.offset..child.offset + stride],
                second.then(|| &input[child.offset + stride..child.offset + stride * 2]),
                out,
            );
        }
        self.regions[index].rows[slot] = Some(y);
        true
    }
}

fn reduce_row(first: &[u8], next: Option<&[u8]>, out: &mut [u8]) {
    for (x, pixel) in out.chunks_exact_mut(4).enumerate() {
        let start = x * 8;
        let end = (start + 8).min(first.len());
        let mut alpha = 0;
        let mut channels = [0; 3];
        let mut samples = 0;
        for row in [Some(first), next].into_iter().flatten() {
            for pixel in row[start..end].chunks_exact(4) {
                let a = u32::from(pixel[3]);
                alpha += a;
                samples += 1;
                for channel in 0..3 {
                    channels[channel] += LINEAR[usize::from(pixel[channel])] * a;
                }
            }
        }
        pixel.fill(0);
        if let Some(alpha) = std::num::NonZeroU32::new(alpha) {
            for channel in 0..3 {
                pixel[channel] = encoded((channels[channel] + alpha.get() / 2) / alpha);
            }
        }
        pixel[3] = ((alpha + samples / 2) / samples) as u8;
    }
}

impl Drop for Rows {
    fn drop(&mut self) {
        self.bytes.zeroize();
    }
}

pub(crate) fn shape(source: &impl Raster, level: u8, x: u32, y: u32) -> Option<TileShape> {
    let max_level = source
        .width()
        .max(source.height())
        .next_power_of_two()
        .ilog2();
    if u32::from(level) > max_level {
        return None;
    }
    let width = source.width().div_ceil(1 << level);
    let height = source.height().div_ceil(1 << level);
    let width = width
        .checked_sub(x.checked_mul(TILE_SIDE as u32)?)?
        .min(TILE_SIDE as u32);
    let height = height
        .checked_sub(y.checked_mul(TILE_SIDE as u32)?)?
        .min(TILE_SIDE as u32);
    if width == 0 || height == 0 {
        return None;
    }
    TileShape::new(width + 2, height + 2)
}

// IEC sRGB decode, quantized once to 16-bit linear light. Keeping the table in
// source gives every platform exactly the same derived object bytes.
const LINEAR: [u32; 256] = [
    0, 20, 40, 60, 80, 99, 119, 139, 159, 179, 199, 219, 241, 264, 288, 313, 340, 367, 396, 427,
    458, 491, 526, 562, 599, 637, 677, 718, 761, 805, 851, 898, 947, 997, 1048, 1101, 1156, 1212,
    1270, 1330, 1391, 1453, 1517, 1583, 1651, 1720, 1790, 1863, 1937, 2013, 2090, 2170, 2250, 2333,
    2418, 2504, 2592, 2681, 2773, 2866, 2961, 3058, 3157, 3258, 3360, 3464, 3570, 3678, 3788, 3900,
    4014, 4129, 4247, 4366, 4488, 4611, 4736, 4864, 4993, 5124, 5257, 5392, 5530, 5669, 5810, 5953,
    6099, 6246, 6395, 6547, 6700, 6856, 7014, 7174, 7335, 7500, 7666, 7834, 8004, 8177, 8352, 8528,
    8708, 8889, 9072, 9258, 9445, 9635, 9828, 10022, 10219, 10417, 10619, 10822, 11028, 11235,
    11446, 11658, 11873, 12090, 12309, 12530, 12754, 12980, 13209, 13440, 13673, 13909, 14146,
    14387, 14629, 14874, 15122, 15371, 15623, 15878, 16135, 16394, 16656, 16920, 17187, 17456,
    17727, 18001, 18277, 18556, 18837, 19121, 19407, 19696, 19987, 20281, 20577, 20876, 21177,
    21481, 21787, 22096, 22407, 22721, 23038, 23357, 23678, 24002, 24329, 24658, 24990, 25325,
    25662, 26001, 26344, 26688, 27036, 27386, 27739, 28094, 28452, 28813, 29176, 29542, 29911,
    30282, 30656, 31033, 31412, 31794, 32179, 32567, 32957, 33350, 33745, 34143, 34544, 34948,
    35355, 35764, 36176, 36591, 37008, 37429, 37852, 38278, 38706, 39138, 39572, 40009, 40449,
    40891, 41337, 41785, 42236, 42690, 43147, 43606, 44069, 44534, 45002, 45473, 45947, 46423,
    46903, 47385, 47871, 48359, 48850, 49344, 49841, 50341, 50844, 51349, 51858, 52369, 52884,
    53401, 53921, 54445, 54971, 55500, 56032, 56567, 57105, 57646, 58190, 58737, 59287, 59840,
    60396, 60955, 61517, 62082, 62650, 63221, 63795, 64372, 64952, 65535,
];

fn encoded(value: u32) -> u8 {
    let upper = LINEAR.partition_point(|&sample| sample < value);
    if upper == 0 {
        return 0;
    }
    if upper == 256 {
        return 255;
    }
    if value - LINEAR[upper - 1] <= LINEAR[upper] - value {
        (upper - 1) as u8
    } else {
        upper as u8
    }
}

#[cfg(test)]
pub(crate) fn reduce(source: &Pixels, mut cancelled: impl FnMut() -> bool) -> Option<Pixels> {
    let width = source.width().div_ceil(2);
    let height = source.height().div_ceil(2);
    let mut rgba = vec![0; width as usize * height as usize * 4];
    for y in 0..height {
        if cancelled() {
            return None;
        }
        for x in 0..width {
            let mut alpha = 0u32;
            let mut channels = [0u32; 3];
            let mut samples = 0;
            for sy in y * 2..(y * 2 + 2).min(source.height()) {
                for sx in x * 2..(x * 2 + 2).min(source.width()) {
                    let index = (sy as usize * source.width() as usize + sx as usize) * 4;
                    let pixel = &source.rgba()[index..index + 4];
                    let a = u32::from(pixel[3]);
                    alpha += a;
                    samples += 1;
                    for channel in 0..3 {
                        channels[channel] += LINEAR[usize::from(pixel[channel])] * a;
                    }
                }
            }
            let index = (y as usize * width as usize + x as usize) * 4;
            if let Some(alpha) = std::num::NonZeroU32::new(alpha) {
                for channel in 0..3 {
                    rgba[index + channel] = encoded((channels[channel] + alpha.get() / 2) / alpha);
                }
            }
            rgba[index + 3] = ((alpha + samples / 2) / samples) as u8;
        }
    }
    Pixels::new(width, height, rgba.into_boxed_slice())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reduction_uses_linear_light_and_alpha_not_hidden_rgb() {
        let image = Pixels::new(2, 1, vec![0, 0, 0, 255, 255, 255, 255, 255].into()).unwrap();
        assert_eq!(
            reduce(&image, || false).unwrap().rgba(),
            &[188, 188, 188, 255]
        );
        let image = Pixels::new(2, 1, vec![255, 0, 0, 0, 0, 255, 0, 255].into()).unwrap();
        assert_eq!(reduce(&image, || false).unwrap().rgba(), &[0, 255, 0, 128]);
        assert!(reduce(&image, || true).is_none());
    }
    #[test]
    fn odd_edges_and_unit_axes_have_exact_extents() {
        let image = Pixels::new(
            3,
            1,
            vec![255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 255, 255].into(),
        )
        .unwrap();
        let mip = reduce(&image, || false).unwrap();
        assert_eq!((mip.width(), mip.height()), (2, 1));
        assert_eq!(mip.rgba(), &[255, 0, 0, 255, 0, 0, 255, 255]);
    }
}
