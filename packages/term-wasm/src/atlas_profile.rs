//! Ignored profiles of the glyph atlas as the row geometry builder drives it.
//!
//! `append_row_geometry_into` calls `GlyphAtlas::get_or_rasterize` once for
//! every printable cell it does not draw as a builtin block element, spaces
//! included, on every dirty-row rebuild. After first paint every one of those
//! calls is a hit. The lookup profile replays a deterministic full screen of
//! cells through the production method on a warmed atlas built from the four
//! bundled faces, and reports the lookups a rebuild issues and their cost.
//! The builtin profile times `builtin_cell_glyph`, which the same loop calls
//! first for every printable cell. The raster profile measures the cold path
//! a metric change takes: `reset_raster_cache` and re-rasterizing the
//! printable ASCII floor.
//!
//! Run with:
//! `cargo test --release --locked -p term-wasm atlas::profile -- --ignored --nocapture --test-threads=1`

use std::hint::black_box;
use std::rc::Rc;
use std::time::Instant;

use super::{GlyphAtlas, GlyphKey, GlyphSlot};
use crate::builtin_glyph::builtin_cell_glyph;

const COLS: usize = 200;
const ROWS: usize = 50;
/// Retina cell metrics: 14 px text at DPR 2.
const PX_PER_EM: f32 = 28.0;

fn production_atlas() -> GlyphAtlas {
    let regular = include_bytes!("../../../apps/web/public/fonts/JetBrainsMonoNF-Regular.ttf");
    let bold = include_bytes!("../../../apps/web/public/fonts/JetBrainsMonoNF-Bold.ttf");
    let italic = include_bytes!("../../../apps/web/public/fonts/JetBrainsMonoNF-Italic.ttf");
    let bold_italic =
        include_bytes!("../../../apps/web/public/fonts/JetBrainsMonoNF-BoldItalic.ttf");
    let settings = crate::terminal_font_settings();
    let face = |bytes: &[u8]| Rc::new(fontdue::Font::from_bytes(bytes, settings).expect("face"));
    let mut atlas = GlyphAtlas::new([
        face(regular.as_slice()),
        face(bold.as_slice()),
        face(italic.as_slice()),
        face(bold_italic.as_slice()),
    ]);
    atlas.px_per_em = PX_PER_EM;
    atlas
}

/// A deterministic screen shaped like shell and editor output: mostly
/// spaces and printable ASCII, some box drawing, Powerline separators and
/// block elements, and a style mix weighted to regular text.
fn screen() -> Vec<GlyphKey> {
    let mut state = 0x5eed_u64;
    let mut next = move || {
        state = state
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        (state >> 33) as u32
    };
    (0..COLS * ROWS)
        .map(|_| {
            let class = next() % 100;
            let codepoint = match class {
                0..=37 => u32::from(' '),
                38..=91 => 0x21 + next() % 94,
                92..=95 => 0x2500 + next() % 0x80,
                96..=97 => [0xE0B0, 0xE0B2, 0xE0A0][(next() % 3) as usize],
                _ => 0x2580 + next() % 0x20,
            };
            let style = match next() % 100 {
                0..=74 => 0,
                75..=89 => 1,
                90..=96 => 2,
                _ => 3,
            };
            GlyphKey { codepoint, style }
        })
        .collect()
}

/// A deterministic screen shaped like source code in an editor: indented
/// rows of identifier-like words and punctuation, trailing spaces to the
/// width, and comment rows in italics. Runs make its branch pattern closer to
/// real output than `screen`'s independent cells.
fn text_screen() -> Vec<GlyphKey> {
    let mut state = 0x7e47_u64;
    let mut next = move |bound: u32| {
        state = state
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        (state >> 33) as u32 % bound
    };
    const PUNCTUATION: &[u8] = b"(){}[].,;:=&<>!?-+*/#'\"";
    let mut cells = Vec::with_capacity(COLS * ROWS);
    for _ in 0..ROWS {
        let style = if next(6) == 0 { 2 } else { 0 };
        let indent = 4 * next(4) as usize;
        let content = indent + 20 + next(70) as usize;
        let mut row: Vec<u32> = vec![u32::from(' '); indent];
        while row.len() < content {
            for _ in 0..2 + next(8) {
                row.push(u32::from(b'a' + next(26) as u8));
            }
            if next(3) == 0 {
                row.push(u32::from(
                    PUNCTUATION[next(PUNCTUATION.len() as u32) as usize],
                ));
            }
            row.push(u32::from(' '));
        }
        row.resize(COLS, u32::from(' '));
        cells.extend(
            row.into_iter()
                .map(|codepoint| GlyphKey { codepoint, style }),
        );
    }
    cells
}

fn time_per_call(samples: usize, mut run: impl FnMut() -> usize) -> (f64, f64, usize) {
    let mut work = 0;
    for _ in 0..8 {
        work = run();
    }
    let mut per_call: Vec<f64> = (0..samples)
        .map(|_| {
            let start = Instant::now();
            black_box(run());
            start.elapsed().as_nanos() as f64
        })
        .collect();
    per_call.sort_by(f64::total_cmp);
    (
        per_call[per_call.len() / 2],
        per_call[(per_call.len() * 95) / 100],
        work,
    )
}

fn lookup_workload(label: &str, cells: &[GlyphKey]) {
    let mut atlas = production_atlas();
    // What the row builder sends to the atlas: printable, not a builtin block.
    let lookups: Vec<GlyphKey> = cells
        .iter()
        .copied()
        .filter(|key| {
            key.codepoint > 31
                && key.codepoint != 127
                && builtin_cell_glyph(key.codepoint).is_none()
        })
        .collect();
    for key in &lookups {
        let _ = atlas.get_or_rasterize(*key);
    }
    let distinct = atlas.glyphs.len();
    let rasterized = atlas
        .glyphs
        .values()
        .filter(|slot| matches!(slot, GlyphSlot::Rasterized(_)))
        .count();
    let ascii = lookups.iter().filter(|key| key.codepoint < 0x80).count();

    let (median, p95, drawn) = time_per_call(401, || {
        let mut drawn = 0usize;
        for key in black_box(&lookups) {
            if let Some(entry) = atlas.get_or_rasterize(*key) {
                drawn += usize::from(entry.width);
            }
        }
        drawn
    });
    println!(
        "{label}: screen={COLS}x{ROWS} cells={} atlas_lookups={} ascii_lookups={ascii} \
         distinct_keys={distinct} rasterized={rasterized} drawn_width_sum={drawn}",
        cells.len(),
        lookups.len(),
    );
    println!(
        "{label}: full-screen lookups median={median:.0}ns p95={p95:.0}ns \
         per_lookup_median={:.2}ns",
        median / lookups.len() as f64
    );
}

#[test]
#[ignore = "profile; run explicitly with --ignored --nocapture"]
fn glyph_lookup_profile() {
    println!("glyph_lookup_profile: production GlyphAtlas::get_or_rasterize, warmed, 401 screens");
    lookup_workload("mixed", &screen());
    lookup_workload("text", &text_screen());
}

#[test]
#[ignore = "profile; run explicitly with --ignored --nocapture"]
fn builtin_glyph_profile() {
    println!(
        "builtin_glyph_profile: production builtin_cell_glyph per printable cell, 401 screens"
    );
    for (label, cells) in [("mixed", screen()), ("text", text_screen())] {
        let codepoints: Vec<u32> = cells
            .iter()
            .map(|key| key.codepoint)
            .filter(|codepoint| *codepoint > 31 && *codepoint != 127)
            .collect();
        let (median, p95, rects) = time_per_call(401, || {
            let mut rects = 0usize;
            for codepoint in black_box(&codepoints) {
                if let Some(glyph) = builtin_cell_glyph(*codepoint) {
                    rects += glyph.rects().len();
                }
            }
            rects
        });
        println!(
            "{label}: cells={} builtin_rects={rects} full-screen median={median:.0}ns p95={p95:.0}ns \
             per_cell_median={:.2}ns",
            codepoints.len(),
            median / codepoints.len() as f64
        );
    }
}

#[test]
#[ignore = "profile; run explicitly with --ignored --nocapture"]
fn glyph_raster_profile() {
    let mut atlas = production_atlas();
    let floor: Vec<GlyphKey> = (0u8..4)
        .flat_map(|style| (0x20u32..0x7f).map(move |codepoint| GlyphKey { codepoint, style }))
        .collect();

    let (reset_median, reset_p95, _) = time_per_call(41, || {
        atlas.reset_raster_cache();
        atlas.pixels.len()
    });
    let (raster_median, raster_p95, glyphs) = time_per_call(41, || {
        atlas.reset_raster_cache();
        for key in &floor {
            let _ = atlas.get_or_rasterize(*key);
        }
        atlas.glyphs.len()
    });
    println!(
        "glyph_raster_profile: production reset_raster_cache + get_or_rasterize cold, 41 runs"
    );
    println!(
        "atlas={}x{} reset: median={reset_median:.0}ns p95={reset_p95:.0}ns",
        atlas.atlas_w, atlas.atlas_h
    );
    println!(
        "reset+ascii floor ({glyphs} keys): median={raster_median:.0}ns p95={raster_p95:.0}ns \
         per_glyph_after_reset={:.0}ns",
        (raster_median - reset_median) / glyphs as f64
    );
}
