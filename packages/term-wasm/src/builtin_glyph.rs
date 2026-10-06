// Adapted from Alacritty's builtin_font block-element coverage for Merkur's
// WebGL primitive renderer. Alacritty rasterizes these into a bitmap canvas;
// here we emit normalized cell rectangles for the existing solid-rect pass.

#[derive(Clone, Copy)]
pub(crate) struct CellRect {
    pub(crate) x: f32,
    pub(crate) y: f32,
    pub(crate) w: f32,
    pub(crate) h: f32,
}

#[derive(Clone, Copy)]
pub(crate) struct BuiltinCellGlyph {
    rects: [CellRect; 6],
    len: usize,
}

impl BuiltinCellGlyph {
    pub(crate) fn rects(&self) -> &[CellRect] {
        &self.rects[..self.len]
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
    if character == '\u{2588}' {
        return Some(glyph1(CellRect::full()));
    }

    // Let shaded blocks continue through the font path. Our primitive pass is opaque RGB, while
    // Alacritty renders shades with reduced fill intensity.
    if matches!(character, '\u{2591}'..='\u{2593}') {
        return None;
    }

    let width = match character {
        '\u{2589}' | '\u{1fb8b}' => 7.0 / 8.0,
        '\u{258a}' | '\u{1fb8a}' => 6.0 / 8.0,
        '\u{258b}' | '\u{1fb89}' => 5.0 / 8.0,
        '\u{258c}' => 4.0 / 8.0,
        '\u{258d}' | '\u{1fb88}' => 3.0 / 8.0,
        '\u{258e}' | '\u{1fb87}' => 2.0 / 8.0,
        '\u{258f}' | '\u{2595}' => 1.0 / 8.0,
        '\u{2590}' => 4.0 / 8.0,
        _ => 1.0,
    };

    let (height, y) = match character {
        '\u{2580}' => (4.0 / 8.0, 0.0),
        '\u{2581}' => (1.0 / 8.0, 7.0 / 8.0),
        '\u{2582}' => (2.0 / 8.0, 6.0 / 8.0),
        '\u{2583}' => (3.0 / 8.0, 5.0 / 8.0),
        '\u{2584}' => (4.0 / 8.0, 4.0 / 8.0),
        '\u{2585}' => (5.0 / 8.0, 3.0 / 8.0),
        '\u{2586}' => (6.0 / 8.0, 2.0 / 8.0),
        '\u{2587}' => (7.0 / 8.0, 1.0 / 8.0),
        '\u{2594}' => (1.0 / 8.0, 0.0),
        '\u{1fb82}' => (2.0 / 8.0, 0.0),
        '\u{1fb83}' => (3.0 / 8.0, 0.0),
        '\u{1fb84}' => (5.0 / 8.0, 0.0),
        '\u{1fb85}' => (6.0 / 8.0, 0.0),
        '\u{1fb86}' => (7.0 / 8.0, 0.0),
        _ => (1.0, 0.0),
    };

    let x = match character {
        '\u{2590}' => 0.5,
        '\u{2595}' | '\u{1fb87}'..='\u{1fb8b}' => 1.0 - width,
        _ => 0.0,
    };

    Some(glyph1(CellRect {
        x,
        y,
        w: width,
        h: height,
    }))
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

    Some(grid_glyph(mask, 2, 2))
}

fn sextants(character: char) -> Option<BuiltinCellGlyph> {
    let offset = character as u32 - 0x1fb00;
    if offset > 0x3b {
        return None;
    }

    // U+1FB00..U+1FB3B encode all non-empty 2x3 sextant combinations except the full block.
    // Alacritty's tables are equivalent to these bit positions:
    // top-left, top-right, middle-left, middle-right, bottom-left, bottom-right.
    Some(grid_glyph((offset + 1) as u8, 2, 3))
}

fn grid_glyph(mask: u8, cols: u8, rows: u8) -> BuiltinCellGlyph {
    let mut glyph = empty_glyph();
    let cell_w = 1.0 / cols as f32;
    let cell_h = 1.0 / rows as f32;

    for row in 0..rows {
        for col in 0..cols {
            let bit = row * cols + col;
            if mask & (1 << bit) == 0 {
                continue;
            }

            glyph.rects[glyph.len] = CellRect {
                x: col as f32 * cell_w,
                y: row as f32 * cell_h,
                w: cell_w,
                h: cell_h,
            };
            glyph.len += 1;
        }
    }

    glyph
}

fn glyph1(rect: CellRect) -> BuiltinCellGlyph {
    let mut glyph = empty_glyph();
    glyph.rects[0] = rect;
    glyph.len = 1;
    glyph
}

fn empty_glyph() -> BuiltinCellGlyph {
    BuiltinCellGlyph {
        rects: [CellRect::empty(); 6],
        len: 0,
    }
}

impl CellRect {
    const fn empty() -> Self {
        Self {
            x: 0.0,
            y: 0.0,
            w: 0.0,
            h: 0.0,
        }
    }

    const fn full() -> Self {
        Self {
            x: 0.0,
            y: 0.0,
            w: 1.0,
            h: 1.0,
        }
    }
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
            assert!(builtin_char_glyph(character).is_none(), "U+{:04X}", u32::from(character));
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
