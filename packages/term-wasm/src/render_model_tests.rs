//! Pixel model of the terminal text pass.
//!
//! A CPU rasterizer that follows the WebGPU pipelines' rules: a primitive
//! covers the pixels whose centres fall inside it (left and top edges in,
//! right and bottom out), glyph coverage samples the atlas texel nearest the
//! pixel centre, colours decode from sRGB before blending, and blending is
//! `src * a + dst * (1 - a)`. Each scene's image is hashed so a change to how
//! the geometry is laid out cannot silently change a pixel.

use super::*;

struct Canvas {
    width: usize,
    height: usize,
    pixels: Vec<[f32; 3]>,
}

fn decode(channel: f32) -> f32 {
    if channel <= 0.04045 {
        channel / 12.92
    } else {
        ((channel + 0.055) / 1.055).powf(2.4)
    }
}

fn encode(channel: f32) -> u8 {
    let value = if channel <= 0.003_130_8 {
        channel * 12.92
    } else {
        1.055 * channel.powf(1.0 / 2.4) - 0.055
    };
    (value.clamp(0.0, 1.0) * 255.0).round() as u8
}

fn linear(rgb: [f32; 3]) -> [f32; 3] {
    [decode(rgb[0]), decode(rgb[1]), decode(rgb[2])]
}

impl Canvas {
    fn new(width: usize, height: usize, clear: [u8; 3]) -> Self {
        Self {
            width,
            height,
            pixels: vec![linear(rgb_to_f32(clear)); width * height],
        }
    }

    /// Pixels whose centres lie in `[x0, x1) x [y0, y1)`.
    fn covered(&self, x0: f32, y0: f32, x1: f32, y1: f32) -> impl Iterator<Item = (usize, usize)> {
        let columns = (0..self.width).filter(move |&x| {
            let centre = x as f32 + 0.5;
            centre >= x0 && centre < x1
        });
        let rows: Vec<usize> = (0..self.height)
            .filter(|&y| {
                let centre = y as f32 + 0.5;
                centre >= y0 && centre < y1
            })
            .collect();
        columns.flat_map(move |x| rows.clone().into_iter().map(move |y| (x, y)))
    }

    fn blend(&mut self, x: usize, y: usize, color: [f32; 3], alpha: f32) {
        let pixel = &mut self.pixels[y * self.width + x];
        for channel in 0..3 {
            pixel[channel] = color[channel] * alpha + pixel[channel] * (1.0 - alpha);
        }
    }

    fn fill(&mut self, x0: f32, y0: f32, x1: f32, y1: f32, color: [f32; 3]) {
        let covered: Vec<_> = self.covered(x0, y0, x1, y1).collect();
        for (x, y) in covered {
            self.pixels[y * self.width + x] = color;
        }
    }

    /// One glyph quad: `uv0..uv1` spans the quad, sampled nearest.
    fn glyph(
        &mut self,
        atlas: &atlas::GlyphAtlas,
        origin: [f32; 2],
        size: [f32; 2],
        uv0: [f32; 2],
        uv1: [f32; 2],
        color: [f32; 3],
        alpha: f32,
    ) {
        let covered: Vec<_> = self
            .covered(
                origin[0],
                origin[1],
                origin[0] + size[0],
                origin[1] + size[1],
            )
            .collect();
        for (x, y) in covered {
            let t = [
                (x as f32 + 0.5 - origin[0]) / size[0],
                (y as f32 + 0.5 - origin[1]) / size[1],
            ];
            let u = uv0[0] * (1.0 - t[0]) + uv1[0] * t[0];
            let v = uv0[1] * (1.0 - t[1]) + uv1[1] * t[1];
            let tx = ((u * atlas.atlas_w as f32).floor() as usize).min(atlas.atlas_w as usize - 1);
            let ty = ((v * atlas.atlas_h as f32).floor() as usize).min(atlas.atlas_h as usize - 1);
            let coverage = f32::from(atlas.pixels[ty * atlas.atlas_w as usize + tx]) / 255.0;
            self.blend(x, y, color, coverage * alpha);
        }
    }

    fn cursor(&mut self, rect: [f32; 4], rgb: [f32; 3], shape: f32) {
        let mixed = [rgb[0] * 0.2 + 0.8, rgb[1] * 0.2 + 0.8, rgb[2] * 0.2 + 0.8];
        let color = linear(mixed);
        let covered: Vec<_> = self
            .covered(rect[0], rect[1], rect[0] + rect[2], rect[1] + rect[3])
            .collect();
        for (x, y) in covered {
            let local = [
                (x as f32 + 0.5 - rect[0]) / rect[2],
                (y as f32 + 0.5 - rect[1]) / rect[3],
            ];
            let inside = if (0.5..1.5).contains(&shape) {
                if local[0] <= 0.14 { 1.0 } else { 0.0 }
            } else if shape >= 1.5 {
                if local[1] >= 0.9 { 1.0 } else { 0.0 }
            } else {
                0.55
            };
            self.blend(x, y, color, inside);
        }
    }

    fn digest(&self) -> u64 {
        let mut hash = 0xcbf2_9ce4_8422_2325_u64;
        for pixel in &self.pixels {
            for channel in pixel {
                hash ^= u64::from(encode(*channel));
                hash = hash.wrapping_mul(0x0100_0000_01b3);
            }
        }
        hash
    }
}

fn styled(c: char, fg: [u8; 3], bg: [u8; 3], attrs: CellAttrs) -> CellRepr {
    CellRepr {
        codepoint: c as u32,
        fg,
        bg,
        attrs,
        link: 0,
    }
}

fn put_row(terminal: &mut Terminal, row: u16, cells: &[CellRepr], seq: u32) {
    let cols = terminal.cols();
    let rows = terminal.rows();
    let frame = test_frame_with_entries(
        FrameKind::Delta,
        cols,
        rows,
        0,
        rows - 1,
        &[RowRef {
            graphics: &[],
            row_index: row,
            left: 0,
            cells,
        }],
    );
    assert!(terminal.apply_presented_delta_seq(&frame, seq));
}

fn put_grid_cell(terminal: &mut Terminal, row: usize, col: usize, cell: Cell) {
    terminal.term.grid_mut()[Point::new(Line(row as i32), Column(col))] = cell;
    terminal.note_damaged_row(row as u16);
}

fn text(s: &str, fg: [u8; 3], bg: [u8; 3], attrs: CellAttrs) -> Vec<CellRepr> {
    s.chars().map(|c| styled(c, fg, bg, attrs)).collect()
}

/// Text in every style, colour, background and decoration the wire carries,
/// plus the grid-only dim and strikeout flags.
fn styled_text_scene() -> Terminal {
    let mut terminal = terminal_with_atlas(24, 6);
    let fg = DEFAULT_FOREGROUND;
    let bg = DEFAULT_BACKGROUND;
    let none = CellAttrs::NONE;
    let mut row0 = text("plain ", fg, bg, none);
    row0.extend(text("bold ", [220, 120, 40], bg, CellAttrs::BOLD));
    row0.extend(text("ital ", [40, 200, 120], bg, CellAttrs::ITALIC));
    row0.extend(text(
        "bi",
        fg,
        bg,
        CellAttrs::BOLD.with(CellAttrs::ITALIC, true),
    ));
    put_row(&mut terminal, 0, &row0, 1);
    let mut row1 = text("on red", [250, 250, 250], [180, 20, 20], none);
    row1.extend(text("  ", fg, [180, 20, 20], none));
    row1.extend(text(
        "inverse",
        [30, 60, 200],
        [10, 10, 10],
        CellAttrs::INVERSE,
    ));
    row1.extend(text(" x", fg, bg, CellAttrs::EXPLICIT_DEFAULT_BG));
    put_row(&mut terminal, 1, &row1, 2);
    let mut row2 = text("underline", [200, 200, 40], bg, CellAttrs::UNDERLINE);
    row2.extend(text(
        " inv-ul",
        [90, 10, 140],
        [240, 240, 200],
        CellAttrs::UNDERLINE.with(CellAttrs::INVERSE, true),
    ));
    put_row(&mut terminal, 2, &row2, 3);
    put_row(
        &mut terminal,
        3,
        &text("gyp|_~^`'\"{}[]@#$%&*()!", fg, bg, none),
        4,
    );
    for (col, c) in "dim strike both".chars().enumerate() {
        let flags = match col {
            0..=2 => Flags::DIM,
            4..=9 => Flags::STRIKEOUT,
            11..=14 => Flags::DIM | Flags::STRIKEOUT | Flags::UNDERLINE,
            _ => Flags::empty(),
        };
        let cell = Cell {
            c,
            fg: Color::Spec(Rgb {
                r: 200,
                g: 90,
                b: 90,
            }),
            flags,
            ..Cell::default()
        };
        put_grid_cell(&mut terminal, 4, col, cell);
    }
    terminal
}

/// Wide characters, a lone combining mark, font-drawn box drawing and
/// Powerline, the builtin block elements, quadrants and sextants, and an
/// image placeholder.
fn wide_and_builtin_scene() -> Terminal {
    let mut terminal = terminal_with_atlas(24, 5);
    let fg = DEFAULT_FOREGROUND;
    let bg = DEFAULT_BACKGROUND;
    let wide = CellAttrs::WIDE;
    let mut row0 = vec![
        styled('a', fg, bg, CellAttrs::NONE),
        styled('漢', fg, bg, wide),
        styled(' ', fg, bg, CellAttrs::NONE),
        styled(
            '字',
            [90, 200, 250],
            [40, 40, 90],
            wide.with(CellAttrs::UNDERLINE, true),
        ),
        styled(' ', fg, [90, 40, 40], CellAttrs::NONE),
        styled('e', fg, bg, CellAttrs::NONE),
        styled('\u{301}', fg, bg, CellAttrs::NONE),
        styled('é', fg, bg, CellAttrs::NONE),
    ];
    row0.extend(text(
        " ─│┼╭╯ \u{e0b0}\u{e0a0}",
        [120, 220, 120],
        bg,
        CellAttrs::NONE,
    ));
    put_row(&mut terminal, 0, &row0, 1);
    put_row(
        &mut terminal,
        1,
        &text(
            "▀▁▂▃▄▅▆▇█▉▊▋▌▍▎▏▐▔▕░▒▓",
            [240, 160, 40],
            [20, 30, 120],
            CellAttrs::NONE,
        ),
        2,
    );
    put_row(
        &mut terminal,
        2,
        &text(
            "▖▗▘▙▚▛▜▝▞▟🬀🬁🬂🬃🬞🬻🮂🮃🮄🮅🮆🮇🮋",
            [250, 250, 250],
            bg,
            CellAttrs::NONE,
        ),
        3,
    );
    put_row(
        &mut terminal,
        3,
        &text("▌▀█🬗", [30, 220, 220], bg, CellAttrs::UNDERLINE),
        4,
    );
    let mut placeholder = styled(
        merkur_graphics::placeholder::PLACEHOLDER,
        [0, 0, 42],
        [0, 0, 255],
        CellAttrs::INVERSE.with(CellAttrs::UNDERLINE, true),
    );
    let mut row4 = vec![placeholder];
    placeholder.attrs = CellAttrs::UNDERLINE;
    placeholder.bg = DEFAULT_BACKGROUND;
    row4.push(placeholder);
    row4.extend(text("img", fg, bg, CellAttrs::NONE));
    put_row(&mut terminal, 4, &row4, 5);
    // A wide character written straight into the grid with its spacer, and
    // a builtin glyph made wide the same way.
    put_grid_cell(
        &mut terminal,
        3,
        10,
        Cell {
            c: '界',
            flags: Flags::WIDE_CHAR | Flags::UNDERLINE,
            ..Cell::default()
        },
    );
    put_grid_cell(
        &mut terminal,
        3,
        11,
        Cell {
            c: ' ',
            flags: Flags::WIDE_CHAR_SPACER,
            bg: Color::Spec(Rgb { r: 9, g: 99, b: 9 }),
            ..Cell::default()
        },
    );
    put_grid_cell(
        &mut terminal,
        3,
        14,
        Cell {
            c: '▟',
            flags: Flags::WIDE_CHAR,
            ..Cell::default()
        },
    );
    put_grid_cell(
        &mut terminal,
        3,
        15,
        Cell {
            c: ' ',
            flags: Flags::WIDE_CHAR_SPACER,
            ..Cell::default()
        },
    );
    // The bundled faces lack these; give them the bitmaps the Canvas 2D
    // pass would, two cells wide.
    for (index, c) in ['漢', '字', '界'].into_iter().enumerate() {
        let (width, height) = (14_u16, 16_u16);
        let pixels: Vec<u8> = (0..usize::from(width) * usize::from(height))
            .map(|texel| ((texel * 37 + index * 91) % 256) as u8)
            .collect();
        assert!(terminal.inject_glyph(c as u32, 0, width, height, 1, -13, &pixels));
    }
    terminal
}

fn cursor_scene(shape: u8) -> Terminal {
    let mut terminal = terminal_with_atlas(10, 2);
    put_row(
        &mut terminal,
        0,
        &text(
            "cursor",
            DEFAULT_FOREGROUND,
            DEFAULT_BACKGROUND,
            CellAttrs::NONE,
        ),
        1,
    );
    let frame = test_cursor_frame(10, 2, 3, 0, shape, 1);
    assert!(terminal.apply_presented_delta_seq(&frame, 2));
    terminal
}

/// Predictions drawn over the blank tail: the appended overlay path.
fn tail_prediction_scene() -> Terminal {
    let mut terminal = terminal_with_atlas(12, 2);
    train_shadow_text(&mut terminal, "ab");
    for (index, c) in "cd ef".chars().enumerate() {
        assert_ne!(
            terminal.predict_printable(c as u32, 200.0 + index as f64, 10 + index as u32, true),
            0
        );
    }
    assert!(terminal.has_visible_predictions_internal());
    terminal
}

/// An insertion before echoed styled text: the projected-row path.
fn projected_prediction_scene() -> Terminal {
    let mut terminal = terminal_with_atlas(8, 1);
    assert_ne!(terminal.predict_printable('a' as u32, 0.0, 1, true), 0);
    let mut styled_a = test_cell('a');
    styled_a.fg = [12, 90, 180];
    styled_a.attrs |= CellAttrs::BOLD;
    styled_a.attrs |= CellAttrs::ITALIC;
    styled_a.attrs |= CellAttrs::UNDERLINE;
    let frame = test_frame_with_entries(
        FrameKind::Delta,
        8,
        1,
        1,
        0,
        &[RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &[styled_a],
        }],
    );
    assert!(terminal.apply_presented_delta_seq(&frame, 1));
    terminal.predict_reconcile(10.0, 500.0, 1, 1);
    assert_ne!(terminal.predict_cursor_shift(-1, 11.0, 2), 0);
    assert_ne!(terminal.predict_printable('x' as u32, 12.0, 3, true), 0);
    assert!(terminal.shadow_requires_row_projection());
    terminal
}

fn preedit_scene() -> Terminal {
    let mut terminal = terminal_with_atlas(12, 2);
    put_row(
        &mut terminal,
        0,
        &text(
            "ab",
            DEFAULT_FOREGROUND,
            DEFAULT_BACKGROUND,
            CellAttrs::NONE,
        ),
        1,
    );
    let frame = test_cursor_frame(12, 2, 2, 0, CURSOR_SHAPE_BEAM, 1);
    assert!(terminal.apply_presented_delta_seq(&frame, 2));
    let pixels: Vec<u8> = (0..14 * 16).map(|texel| (texel * 53 % 256) as u8).collect();
    assert!(terminal.inject_glyph('か' as u32, 0, 14, 16, 1, -13, &pixels));
    terminal.set_preedit("か な\u{301}x", 5);
    terminal
}

/// A preedit run longer than the space after the cursor shifts left.
fn shifted_preedit_scene() -> Terminal {
    let mut terminal = terminal_with_atlas(6, 1);
    let frame = test_cursor_frame(6, 1, 4, 0, CURSOR_SHAPE_BLOCK, 1);
    assert!(terminal.apply_presented_delta_seq(&frame, 1));
    terminal.set_preedit("日本語x", 4);
    terminal
}

fn scenes() -> Vec<(&'static str, Terminal)> {
    vec![
        ("styled-text", styled_text_scene()),
        ("wide-and-builtin", wide_and_builtin_scene()),
        ("cursor-block", cursor_scene(CURSOR_SHAPE_BLOCK)),
        ("cursor-beam", cursor_scene(CURSOR_SHAPE_BEAM)),
        ("cursor-underline", cursor_scene(CURSOR_SHAPE_UNDERLINE)),
        ("tail-prediction", tail_prediction_scene()),
        ("projected-prediction", projected_prediction_scene()),
        ("preedit", preedit_scene()),
        ("shifted-preedit", shifted_preedit_scene()),
    ]
}

/// Whether the decoration pass fills the pixel whose centre lies at `local`
/// in a record's `width x ch` quad: the fragment test the shader runs.
fn decoration_covers(record: [u32; 3], local: [f32; 2], width: f32, ch: f32) -> bool {
    let [glyph, color, _] = record;
    let [x, y] = local;
    let inside = |x0: f32, y0: f32, x1: f32, y1: f32| x >= x0 && x < x1 && y >= y0 && y < y1;
    if glyph & CELL_UNDERLINE != 0 && inside(0.0, ch - 1.0, width, ch) {
        return true;
    }
    if glyph & CELL_STRIKEOUT != 0 && inside(0.0, ch * 0.5, width, ch * 0.5 + 1.0) {
        return true;
    }
    if color & CELL_PREEDIT != 0 && inside(0.0, ch - 2.0, width, ch) {
        return true;
    }
    if color & CELL_BUILTIN == 0 {
        return false;
    }
    let shape = glyph & CELL_GLYPH_MASK;
    if shape & builtin_glyph::BUILTIN_MOSAIC != 0 {
        let rows = (shape >> 8) & 0xf;
        let (cell_w, cell_h) = (0.5_f32, 1.0 / rows as f32);
        (0..rows * 2).any(|bit| {
            let (row, col) = ((bit / 2) as f32, (bit % 2) as f32);
            let x0 = col * cell_w * width;
            let y0 = row * cell_h * ch;
            shape & (1 << bit) != 0 && inside(x0, y0, x0 + cell_w * width, y0 + cell_h * ch)
        })
    } else {
        let eighths = |shift: u32| ((shape >> shift) & 0xf) as f32 / 8.0;
        let (x0, y0) = (eighths(0) * width, eighths(4) * ch);
        inside(x0, y0, x0 + eighths(8) * width, y0 + eighths(12) * ch)
    }
}

/// Draw the three text passes over the cell records and then the overlay,
/// as the renderer orders them, then the cursor.
fn render(terminal: &mut Terminal) -> Canvas {
    terminal.build_presented_geometry();
    let atlas = terminal.atlas.as_ref().expect("atlas");
    let [cw, ch, baseline, highlight @ ..] = terminal.geometry_params;
    let width = terminal.presentation_grid.columns() * cw as usize;
    let height = terminal.presentation_grid.screen_lines() * ch as usize;
    let mut canvas = Canvas::new(width, height, terminal.theme.background);
    let records: Vec<[u32; 3]> = terminal
        .cell_buf
        .as_chunks::<CELL_WORDS>()
        .0
        .iter()
        .chain(terminal.overlay_buf.as_chunks::<CELL_WORDS>().0)
        .copied()
        .collect();
    let origin = |record: [u32; 3]| {
        [
            ((record[0] >> CELL_COLUMN_SHIFT) & 0x1ff) as f32 * cw,
            (record[2] >> CELL_ROW_SHIFT) as f32 * ch,
        ]
    };
    let rgb = |word: u32| rgb_to_f32([word as u8, (word >> 8) as u8, (word >> 16) as u8]);
    for record in &records {
        if record[1] & CELL_BACKGROUND != 0 {
            let [x, y] = origin(*record);
            let color = if record[1] & CELL_PREEDIT != 0 {
                highlight
            } else {
                rgb(record[2])
            };
            canvas.fill(x, y, x + cw, y + ch, linear(color));
        }
    }
    for record in &records {
        let id = record[0] & CELL_GLYPH_MASK;
        if id == 0 || record[1] & CELL_BUILTIN != 0 {
            continue;
        }
        let entry = &atlas.table[(id as usize - 1) * atlas::GLYPH_TABLE_WORDS..][..3];
        let at = [(entry[0] & 0xffff) as f32, (entry[0] >> 16) as f32];
        let size = [(entry[1] & 0xffff) as f32, (entry[1] >> 16) as f32];
        let bearing = [
            f32::from(entry[2] as u16 as i16),
            f32::from((entry[2] >> 16) as u16 as i16),
        ];
        let dims = [atlas.atlas_w as f32, atlas.atlas_h as f32];
        let [x, y] = origin(*record);
        let alpha = match record[1] & (3 << 26) {
            CELL_ALPHA_DIM => 0.72,
            CELL_ALPHA_PREDICTION => 0.55,
            _ => 1.0,
        };
        canvas.glyph(
            atlas,
            [x + bearing[0], y + (baseline + bearing[1])],
            size,
            [at[0] / dims[0], at[1] / dims[1]],
            [(at[0] + size[0]) / dims[0], (at[1] + size[1]) / dims[1]],
            linear(rgb(record[1])),
            alpha,
        );
    }
    for record in &records {
        let [x, y] = origin(*record);
        let width = if record[0] & CELL_WIDE != 0 {
            2.0 * cw
        } else {
            cw
        };
        let color = linear(rgb(record[1]));
        let covered: Vec<_> = canvas.covered(x, y, x + width, y + ch).collect();
        for (px, py) in covered {
            let local = [px as f32 + 0.5 - x, py as f32 + 0.5 - y];
            if decoration_covers(*record, local, width, ch) {
                canvas.pixels[py * canvas.width + px] = color;
            }
        }
    }
    for cursor in terminal.cursor_buf.as_chunks::<8>().0 {
        let [x, y, w, h, r, g, b, shape] = *cursor;
        canvas.cursor([x, y, w, h], [r, g, b], shape);
    }
    canvas
}

/// Digests of these scenes as the renderer drew them when every glyph,
/// background span and decoration rectangle was its own instance. Laying the
/// same scenes out as fixed cell records must not move a pixel.
const SCENE_DIGESTS: [(&str, u64); 9] = [
    ("styled-text", 0x10ea_c883_b197_7d5a),
    ("wide-and-builtin", 0xece5_8f21_b040_0008),
    ("cursor-block", 0x7ffe_0584_4c43_0ef3),
    ("cursor-beam", 0x9195_5dfe_07a4_6ce3),
    ("cursor-underline", 0xef0e_bbd8_29c4_3adf),
    ("tail-prediction", 0x39b0_51b3_0dfb_6fe7),
    ("projected-prediction", 0x6dc0_92f8_6a8c_429f),
    ("preedit", 0x4de5_378f_1bb1_50d5),
    ("shifted-preedit", 0xe00b_125a_6d1d_0456),
];

#[test]
fn cell_records_draw_every_scene_pixel_for_pixel() {
    let dump = std::env::var("RENDER_MODEL_DUMP").ok();
    let mut mismatched = Vec::new();
    for ((name, mut terminal), (expected_name, expected)) in scenes().into_iter().zip(SCENE_DIGESTS)
    {
        assert_eq!(name, expected_name);
        let canvas = render(&mut terminal);
        if canvas.digest() != expected {
            mismatched.push(format!("{name}: 0x{:016x}", canvas.digest()));
        }
        // `RENDER_MODEL_DUMP=<dir>` writes each scene as a PPM image.
        if let Some(directory) = dump.as_ref() {
            let mut ppm = format!("P6\n{} {}\n255\n", canvas.width, canvas.height).into_bytes();
            for pixel in &canvas.pixels {
                ppm.extend(pixel.iter().map(|channel| encode(*channel)));
            }
            std::fs::write(format!("{directory}/{name}.ppm"), ppm).expect("dump");
        }
    }
    assert!(
        mismatched.is_empty(),
        "scene images changed: {mismatched:?}"
    );
}
