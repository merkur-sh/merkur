use alacritty_terminal::vte::ansi::{Color, NamedColor, Rgb};

pub struct TerminalTheme {
    pub foreground: [u8; 3],
    pub background: [u8; 3],
    pub cursor: [u8; 3],
    pub palette: [[u8; 3]; 16],
}

const COLOR_CUBE: [u8; 6] = [0, 95, 135, 175, 215, 255];

pub const CATPPUCCIN_MOCHA: TerminalTheme = TerminalTheme {
    foreground: [205, 214, 244],
    background: [30, 30, 46],
    cursor: [245, 224, 220],
    palette: [
        [69, 71, 90],
        [243, 139, 168],
        [166, 227, 161],
        [249, 226, 175],
        [137, 180, 250],
        [245, 194, 231],
        [148, 226, 213],
        [186, 194, 222],
        [88, 91, 112],
        [243, 139, 168],
        [166, 227, 161],
        [249, 226, 175],
        [137, 180, 250],
        [245, 194, 231],
        [148, 226, 213],
        [166, 173, 200],
    ],
};

pub const DEFAULT_FOREGROUND: [u8; 3] = CATPPUCCIN_MOCHA.foreground;
pub const DEFAULT_BACKGROUND: [u8; 3] = CATPPUCCIN_MOCHA.background;
pub const DEFAULT_CURSOR: [u8; 3] = CATPPUCCIN_MOCHA.cursor;
pub const DEFAULT_DIM_FOREGROUND: [u8; 3] = [147, 153, 178];
pub const DIM_PALETTE: [[u8; 3]; 8] = [
    [49, 50, 68],
    [180, 105, 127],
    [125, 171, 122],
    [187, 170, 132],
    [103, 135, 188],
    [184, 146, 174],
    [111, 170, 160],
    [147, 153, 178],
];
pub const ANSI_PALETTE: [[u8; 3]; 16] = CATPPUCCIN_MOCHA.palette;
pub const INDEXED_COLOR_TABLE: [[u8; 3]; 256] = build_indexed_color_table();

#[inline]
pub fn resolve_color(color: Color) -> [u8; 3] {
    match color {
        Color::Spec(Rgb { r, g, b }) => [r, g, b],
        Color::Indexed(index) => INDEXED_COLOR_TABLE[usize::from(index)],
        Color::Named(named) => named_color(named),
    }
}

#[inline]
pub fn named_color(named: NamedColor) -> [u8; 3] {
    match named {
        NamedColor::Black => ANSI_PALETTE[0],
        NamedColor::Red => ANSI_PALETTE[1],
        NamedColor::Green => ANSI_PALETTE[2],
        NamedColor::Yellow => ANSI_PALETTE[3],
        NamedColor::Blue => ANSI_PALETTE[4],
        NamedColor::Magenta => ANSI_PALETTE[5],
        NamedColor::Cyan => ANSI_PALETTE[6],
        NamedColor::White => ANSI_PALETTE[7],
        NamedColor::BrightBlack => ANSI_PALETTE[8],
        NamedColor::BrightRed => ANSI_PALETTE[9],
        NamedColor::BrightGreen => ANSI_PALETTE[10],
        NamedColor::BrightYellow => ANSI_PALETTE[11],
        NamedColor::BrightBlue => ANSI_PALETTE[12],
        NamedColor::BrightMagenta => ANSI_PALETTE[13],
        NamedColor::BrightCyan => ANSI_PALETTE[14],
        NamedColor::BrightWhite => ANSI_PALETTE[15],
        NamedColor::Foreground | NamedColor::BrightForeground => DEFAULT_FOREGROUND,
        NamedColor::Background => DEFAULT_BACKGROUND,
        NamedColor::Cursor => DEFAULT_CURSOR,
        NamedColor::DimBlack => DIM_PALETTE[0],
        NamedColor::DimRed => DIM_PALETTE[1],
        NamedColor::DimGreen => DIM_PALETTE[2],
        NamedColor::DimYellow => DIM_PALETTE[3],
        NamedColor::DimBlue => DIM_PALETTE[4],
        NamedColor::DimMagenta => DIM_PALETTE[5],
        NamedColor::DimCyan => DIM_PALETTE[6],
        NamedColor::DimWhite => DIM_PALETTE[7],
        NamedColor::DimForeground => DEFAULT_DIM_FOREGROUND,
    }
}

/// Inverse of [`INDEXED_COLOR_TABLE`]: the palette slot that produces `color`,
/// if any. Returns an index `i` for which `INDEXED_COLOR_TABLE[i] == color`.
///
/// The wire carries palette colors as one byte instead of three. The terminal
/// has already resolved its colors to RGB by the time a cell reaches the
/// encoder, so this recovers the compact form rather than threading a colour
/// enum through capture. It runs for every coloured run the encoder writes
/// and again for every one it sizes, so it is branch-light: three table loads
/// decide cube membership, the grey ramp is arithmetic, and the 16 ANSI slots
/// are one branch-free packed comparison.
///
/// Several palette slots share an RGB value (the bright ANSI colors repeat the
/// normal ones in this theme), so this is not a bijection. The lowest matching
/// ANSI slot wins. That is harmless: every returned index maps back to exactly
/// the RGB it was asked about, which is the only property the wire needs.
#[inline]
pub fn indexed_color_for(color: [u8; 3]) -> Option<u8> {
    // The cube is tested first because it covers 216 of the 256 slots.
    let red = CUBE_LEVEL[usize::from(color[0])];
    let green = CUBE_LEVEL[usize::from(color[1])];
    let blue = CUBE_LEVEL[usize::from(color[2])];
    if red != NOT_A_CUBE_LEVEL && green != NOT_A_CUBE_LEVEL && blue != NOT_A_CUBE_LEVEL {
        return Some(16 + 36 * red + 6 * green + blue);
    }

    if color[0] == color[1] && color[1] == color[2] {
        let level = color[0];
        if (8..=238).contains(&level) && (level - 8).is_multiple_of(10) {
            return Some(232 + (level - 8) / 10);
        }
    }

    let packed = pack_rgb(color);
    let mut matches = 0u32;
    for (index, slot) in ANSI_PACKED.iter().enumerate() {
        matches |= u32::from(*slot == packed) << index;
    }
    (matches != 0).then(|| matches.trailing_zeros() as u8)
}

const NOT_A_CUBE_LEVEL: u8 = u8::MAX;

/// The cube level of each byte value, or `NOT_A_CUBE_LEVEL`.
const CUBE_LEVEL: [u8; 256] = {
    let mut table = [NOT_A_CUBE_LEVEL; 256];
    let mut level = 0;
    while level < COLOR_CUBE.len() {
        table[COLOR_CUBE[level] as usize] = level as u8;
        level += 1;
    }
    table
};

const fn pack_rgb(color: [u8; 3]) -> u32 {
    color[0] as u32 | (color[1] as u32) << 8 | (color[2] as u32) << 16
}

/// `ANSI_PALETTE`, one `u32` per slot for the packed comparison.
const ANSI_PACKED: [u32; 16] = {
    let mut packed = [0u32; 16];
    let mut index = 0;
    while index < 16 {
        packed[index] = pack_rgb(ANSI_PALETTE[index]);
        index += 1;
    }
    packed
};

const fn build_indexed_color_table() -> [[u8; 3]; 256] {
    let mut table = [[0u8; 3]; 256];
    let mut index = 0usize;
    while index < 256 {
        table[index] = compute_indexed_color(index as u8);
        index += 1;
    }
    table
}

const fn compute_indexed_color(index: u8) -> [u8; 3] {
    if index < 16 {
        return ANSI_PALETTE[index as usize];
    }
    if index < 232 {
        let cube_index = index as usize - 16;
        let red = cube_index / 36;
        let green = (cube_index % 36) / 6;
        let blue = cube_index % 6;
        return [COLOR_CUBE[red], COLOR_CUBE[green], COLOR_CUBE[blue]];
    }
    let gray = 8u8.saturating_add(index.saturating_sub(232).saturating_mul(10));
    [gray, gray, gray]
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The slot `indexed_color_for` must return for a palette colour: the cube
    /// or grey slot when there is one, otherwise the lowest ANSI slot.
    fn expected_slot(color: [u8; 3]) -> Option<u8> {
        (16..=255u8)
            .chain(0..16)
            .find(|&index| INDEXED_COLOR_TABLE[usize::from(index)] == color)
    }

    #[test]
    fn every_palette_colour_resolves_to_its_expected_slot() {
        for color in INDEXED_COLOR_TABLE {
            assert_eq!(indexed_color_for(color), expected_slot(color), "{color:?}");
        }
    }

    #[test]
    fn no_other_colour_resolves_to_a_slot() {
        // Every `Some` must map back to the colour asked about, so together
        // with the test above this pins the result for all 2^24 inputs. The
        // sweep is split by red across threads to keep the debug test short.
        let threads = std::thread::available_parallelism().map_or(1, |count| count.get());
        let hits: usize = std::thread::scope(|scope| {
            let workers: Vec<_> = (0..threads)
                .map(|first| {
                    scope.spawn(move || {
                        let mut hits = 0usize;
                        for red in (first..256).step_by(threads) {
                            for green in 0..=255u8 {
                                for blue in 0..=255u8 {
                                    let color = [red as u8, green, blue];
                                    if let Some(index) = indexed_color_for(color) {
                                        assert_eq!(INDEXED_COLOR_TABLE[usize::from(index)], color);
                                        hits += 1;
                                    }
                                }
                            }
                        }
                        hits
                    })
                })
                .collect();
            workers
                .into_iter()
                .map(|worker| worker.join().expect("sweep worker"))
                .sum()
        });
        let mut distinct = INDEXED_COLOR_TABLE.to_vec();
        distinct.sort_unstable();
        distinct.dedup();
        assert_eq!(hits, distinct.len());
    }
}
