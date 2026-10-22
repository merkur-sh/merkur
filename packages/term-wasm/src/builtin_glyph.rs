// Adapted from Alacritty's builtin_font block-element coverage. Alacritty
// rasterizes these into a bitmap canvas; here each glyph is a shape the
// decoration pass fills exactly, encoded into the glyph bits of a cell record.

/// A builtin glyph's shape. Every one is a rectangle on the cell's eighths or
/// a mosaic of parts of a two-column division of it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum BuiltinCellGlyph {
    /// `x`, `y`, `w`, `h` in eighths of the cell (`0..=8`).
    Block { x: u8, y: u8, w: u8, h: u8 },
    /// A quadrant or sextant mosaic: bit `row * 2 + col` set for each filled
    /// part of a two-column, `rows`-row division of the cell.
    Mosaic { mask: u8, rows: u8 },
}

/// Set in a shape for [`BuiltinCellGlyph::Mosaic`]; a block leaves it clear.
pub(crate) const BUILTIN_MOSAIC: u32 = 1 << 16;

impl BuiltinCellGlyph {
    /// The 17-bit shape the decoration shader decodes: a block's `x | y << 4 |
    /// w << 8 | h << 12`, or a mosaic's `mask | rows << 8 | BUILTIN_MOSAIC`.
    pub(crate) fn shape(self) -> u32 {
        match self {
            Self::Block { x, y, w, h } => {
                u32::from(x) | u32::from(y) << 4 | u32::from(w) << 8 | u32::from(h) << 12
            }
            Self::Mosaic { mask, rows } => u32::from(mask) | u32::from(rows) << 8 | BUILTIN_MOSAIC,
        }
    }
}

pub(crate) fn builtin_cell_glyph(cp: u32) -> Option<BuiltinCellGlyph> {
    // Every builtin lies in one of these two blocks. The row builder asks for
    // every printable cell, so one range test answers ordinary text before
    // any scalar-value validation or per-range dispatch.
    if !matches!(cp, 0x2580..=0x259f | 0x1fb00..=0x1fb8b) {
        return None;
    }
    builtin_char_glyph(char::from_u32(cp)?)
}

fn builtin_char_glyph(character: char) -> Option<BuiltinCellGlyph> {
    match character {
        // Parts of full block: '▀', '▁'..'▇', '▉'..'▐', '▔', '▕', and Symbols for Legacy
        // Computing partial blocks. Mirrors Alacritty's builtin block-element dimensions.
        '\u{2580}'..='\u{2590}' | '\u{2594}' | '\u{2595}' | '\u{1fb82}'..='\u{1fb8b}' => {
            partial_block(character)
        }
        // Quadrants: '▖'..'▟'.
        '\u{2596}'..='\u{259f}' => quadrants(character),
        // Sextants: '🬀'..'🬻'.
        '\u{1fb00}'..='\u{1fb3b}' => sextants(character),
        _ => None,
    }
}

fn partial_block(character: char) -> Option<BuiltinCellGlyph> {
    // Let shaded blocks continue through the font path. The decoration pass
    // fills opaquely, while Alacritty renders shades with reduced intensity.
    if matches!(character, '\u{2591}'..='\u{2593}') {
        return None;
    }

    let w = match character {
        '\u{2589}' | '\u{1fb8b}' => 7,
        '\u{258a}' | '\u{1fb8a}' => 6,
        '\u{258b}' | '\u{1fb89}' => 5,
        '\u{258c}' => 4,
        '\u{258d}' | '\u{1fb88}' => 3,
        '\u{258e}' | '\u{1fb87}' => 2,
        '\u{258f}' | '\u{2595}' => 1,
        '\u{2590}' => 4,
        _ => 8,
    };

    let (h, y) = match character {
        '\u{2580}' => (4, 0),
        '\u{2581}' => (1, 7),
        '\u{2582}' => (2, 6),
        '\u{2583}' => (3, 5),
        '\u{2584}' => (4, 4),
        '\u{2585}' => (5, 3),
        '\u{2586}' => (6, 2),
        '\u{2587}' => (7, 1),
        '\u{2594}' => (1, 0),
        '\u{1fb82}' => (2, 0),
        '\u{1fb83}' => (3, 0),
        '\u{1fb84}' => (5, 0),
        '\u{1fb85}' => (6, 0),
        '\u{1fb86}' => (7, 0),
        _ => (8, 0),
    };

    let x = match character {
        '\u{2590}' => 4,
        '\u{2595}' | '\u{1fb87}'..='\u{1fb8b}' => 8 - w,
        _ => 0,
    };

    Some(BuiltinCellGlyph::Block { x, y, w, h })
}

fn quadrants(character: char) -> Option<BuiltinCellGlyph> {
    let mask = match character {
        '\u{2596}' => 0b0100,
        '\u{2597}' => 0b1000,
        '\u{2598}' => 0b0001,
        '\u{2599}' => 0b1101,
        '\u{259a}' => 0b1001,
        '\u{259b}' => 0b0111,
        '\u{259c}' => 0b1011,
        '\u{259d}' => 0b0010,
        '\u{259e}' => 0b0110,
        '\u{259f}' => 0b1110,
        _ => return None,
    };

    Some(BuiltinCellGlyph::Mosaic { mask, rows: 2 })
}

fn sextants(character: char) -> Option<BuiltinCellGlyph> {
    let offset = character as u32 - 0x1fb00;
    if offset > 0x3b {
        return None;
    }

    // U+1FB00..U+1FB3B encode all non-empty 2x3 sextant combinations except the full block.
    // Alacritty's tables are equivalent to these bit positions:
    // top-left, top-right, middle-left, middle-right, bottom-left, bottom-right.
    Some(BuiltinCellGlyph::Mosaic {
        mask: (offset + 1) as u8,
        rows: 3,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_builtin_lies_inside_the_guarded_blocks() {
        // `builtin_cell_glyph` rejects everything outside the two blocks
        // before dispatch, so a builtin added outside them must widen that
        // range test too.
        for character in ('\0'..='\u{2579}')
            .chain('\u{25a0}'..='\u{1faff}')
            .chain('\u{1fb8c}'..=char::MAX)
        {
            assert!(
                builtin_char_glyph(character).is_none(),
                "U+{:04X}",
                u32::from(character)
            );
        }
    }

    #[test]
    fn covers_alacritty_block_ranges() {
        for character in ('\u{2580}'..='\u{2590}')
            .chain('\u{2594}'..='\u{2595}')
            .chain('\u{2596}'..='\u{259f}')
            .chain('\u{1fb00}'..='\u{1fb3b}')
            .chain('\u{1fb82}'..='\u{1fb8b}')
        {
            if matches!(character, '\u{2591}'..='\u{2593}') {
                continue;
            }
            assert!(
                builtin_cell_glyph(character as u32).is_some(),
                "{character}"
            );
        }
    }
}
