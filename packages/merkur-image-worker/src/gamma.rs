//! PNG gamma exactly as Kitty decodes it: libpng corrects the file gamma of a
//! gAMA chunk, or the sRGB substitute, for a 2.2 display gamma. The tables
//! reproduce libpng's fixed-point thresholds and quantization, so decoded
//! pixels match the reference bit for bit.

/// libpng fixed point: 100000 is 1.0.
const UNIT: f64 = 100_000.0;
/// Kitty's `png_set_gamma` display gamma.
const SCREEN: f64 = 220_000.0;
/// `PNG_GAMMA_THRESHOLD_FIXED`: libpng skips a correction within 5% of 1.0.
const THRESHOLD: f64 = 5_000.0;
/// `PNG_MAX_GAMMA_8`: input bits a 16-to-8 bit gamma table keeps.
const MAX_GAMMA_8: u32 = 11;

fn significant(gamma: f64) -> bool {
    !(UNIT - THRESHOLD..=UNIT + THRESHOLD).contains(&gamma)
}

/// `png_gamma_threshold`: whether libpng corrects a nonzero file gamma.
pub(crate) fn applies(file: u32) -> bool {
    file != 0 && significant((f64::from(file) * SCREEN / UNIT + 0.5).floor())
}

/// `png_build_8bit_table` for the `png_reciprocal2(file, screen)` exponent.
pub(crate) fn table8(file: u32) -> [u8; 256] {
    let exponent = (1e15 / f64::from(file) / SCREEN + 0.5).floor();
    let mut table: [u8; 256] = std::array::from_fn(|value| value as u8);
    if significant(exponent) {
        for (value, entry) in table.iter_mut().enumerate().take(255).skip(1) {
            *entry = (255.0 * (value as f64 / 255.0).powf(exponent / UNIT) + 0.5).floor() as u8;
        }
    }
    table
}

/// `png_build_16to8_table` for the `png_product2(file, screen)` exponent: the
/// 8-bit result for a 16-bit sample is `table[sample >> shift]`. `bits` is the
/// sBIT depth of the color samples, or 16 when the image declares none.
pub(crate) fn table16(file: u32, bits: u8) -> (u32, Box<[u8]>) {
    let shift = if (1..16).contains(&bits) {
        16 - u32::from(bits)
    } else {
        0
    }
    .clamp(16 - MAX_GAMMA_8, 8);
    let exponent = (f64::from(file) / UNIT * SCREEN + 0.5).floor();
    let max = (1 << (16 - shift)) - 1;
    let mut table = vec![255; 1 << (16 - shift)].into_boxed_slice();
    let mut last = 0;
    for output in 0..255_u32 {
        // The boundary between this output and the next, in input samples.
        let value = f64::from(output * 257 + 128) / 65535.0;
        let bound = (65535.0 * value.powf(exponent / UNIT) + 0.5).floor() as u32;
        let bound = ((bound * max + 32768) / 65535 + 1) as usize;
        while last < bound.min(table.len()) {
            table[last] = output as u8;
            last += 1;
        }
    }
    (shift, table)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn corrections_match_the_pinned_reference_decoder() {
        // Kitty 0.48.2 decodes these gray samples with gAMA 1.0, 0.5 and 0.22727.
        let samples = [0, 1, 2, 16, 32, 64, 100, 128, 150, 200, 254, 255];
        for (file, expected) in [
            (
                100000,
                [0, 21, 28, 72, 99, 136, 167, 186, 200, 228, 255, 255],
            ),
            (50000, [0, 2, 3, 21, 39, 73, 109, 136, 157, 204, 254, 255]),
            (22727, [0, 0, 0, 1, 4, 16, 39, 64, 88, 157, 253, 255]),
        ] {
            assert!(applies(file));
            let table = table8(file);
            assert_eq!(samples.map(|sample| table[sample]), expected, "gAMA {file}");
        }
        // The sRGB substitute and values within 5% of the display gamma are not corrected.
        for file in [45455, 45000, 47000, 0] {
            assert!(!applies(file), "gAMA {file}");
        }
        let (shift, table) = table16(100000, 16);
        assert_eq!(shift, 5);
        let high = [0x8000, 0x4000, 0x2000, 0x80ff, 0x40ff, 0x20ff];
        assert_eq!(
            high.map(|sample: u16| table[usize::from(sample >> shift)]),
            [0xba, 0x88, 0x63, 0xbb, 0x89, 0x64]
        );
    }
}
