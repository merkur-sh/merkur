use hashbrown::{HashMap, HashSet};
use std::rc::Rc;

pub const ATLAS_INITIAL_SIZE: u32 = 2048; // R8 = 4MB VRAM
const ATLAS_MAX_SIZE: u32 = 4096;
/// Codepoints below this resolve through `GlyphAtlas::ascii`, a dense
/// mirror of their `glyphs` slots, so the row builder's per-cell lookup for
/// the common case is an index rather than a hash probe.
const DENSE_CODEPOINTS: u32 = 0x80;
const STYLES: usize = 4;

#[derive(Clone, Copy, Hash, PartialEq, Eq)]
pub struct GlyphKey {
    pub codepoint: u32,
    pub style: u8, // 0=normal 1=bold 2=italic 3=boldItalic
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GlyphEntry {
    pub atlas_x: u16,
    pub atlas_y: u16,
    pub width: u16,
    pub height: u16,
    pub offset_x: i16, // bearing from cell left edge (physical px)
    pub offset_y: i16, // bearing from cell top edge (physical px)
}

/// What is known about one (codepoint, style) pair.
///
/// Every outcome of a lookup is recorded, so a glyph is attempted at most once
/// per atlas generation. The states are mutually exclusive by construction:
/// without that, a codepoint absent from the bold face re-enters the
/// rasterization queue on every build and the Canvas 2D pass runs forever.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum GlyphSlot {
    Rasterized(GlyphEntry),
    /// Present in the font but zero-area — a space and friends. Nothing to
    /// draw, and nothing to escalate.
    Blank,
    /// Absent from the font, queued for the JS Canvas 2D pass.
    Pending,
    /// Escalated to Canvas 2D, which declined to draw it. Never retried: both
    /// a font swap and a metric change rebuild the atlas wholesale.
    Unrenderable,
}

pub struct GlyphAtlas {
    pub fonts: [Rc<fontdue::Font>; 4],
    pub pixels: Vec<u8>, // R8, row-major, atlas_w × atlas_h
    pub atlas_w: u32,
    pub atlas_h: u32,
    pub glyphs: HashMap<GlyphKey, GlyphSlot>,
    /// `glyphs[key]` for every key with `codepoint < DENSE_CODEPOINTS`,
    /// indexed `codepoint * STYLES + style`. Every slot write updates both,
    /// so they stay identical and `glyphs` stays complete for its readers.
    ascii: [Option<GlyphSlot>; DENSE_CODEPOINTS as usize * STYLES],
    shelf_x: u32,
    shelf_y: u32,
    shelf_h: u32,
    pub dirty: bool,
    pub dirty_rect: [u32; 4], // [x_min, y_min, x_max, y_max]; valid when dirty=true
    /// Index of the keys currently in `GlyphSlot::Pending`, so exporting the
    /// queue to JS stays proportional to the queue rather than the atlas.
    pending: HashSet<GlyphKey>,
    pub px_per_em: f32,
    pub cell_w: f32, // physical pixels
    pub cell_h: f32,
    pub baseline: f32,
    /// Changes whenever existing normalized UVs must be rebuilt.
    generation: u32,
}

impl GlyphAtlas {
    pub fn new(fonts: [Rc<fontdue::Font>; 4]) -> Self {
        let sz = ATLAS_INITIAL_SIZE;
        GlyphAtlas {
            fonts,
            pixels: vec![0u8; (sz * sz) as usize],
            atlas_w: sz,
            atlas_h: sz,
            glyphs: HashMap::new(),
            ascii: [None; DENSE_CODEPOINTS as usize * STYLES],
            shelf_x: 0,
            shelf_y: 0,
            shelf_h: 0,
            dirty: false,
            dirty_rect: [u32::MAX, u32::MAX, 0, 0],
            pending: HashSet::new(),
            px_per_em: 14.0,
            cell_w: 8.0,
            cell_h: 16.0,
            baseline: 13.0,
            generation: 1,
        }
    }

    pub fn generation(&self) -> u32 {
        self.generation
    }

    /// Drop every rasterized glyph while retaining the allocated atlas tier.
    ///
    /// Glyph bitmaps, bearings, advances, and missing-glyph fallbacks are all
    /// tied to the active font metrics. Keeping any of them across a metric
    /// change would mix incompatible geometry and pixels.
    pub fn reset_raster_cache(&mut self) {
        self.pixels.fill(0);
        self.glyphs.clear();
        self.ascii.fill(None);
        self.shelf_x = 0;
        self.shelf_y = 0;
        self.shelf_h = 0;
        // `Unrenderable` goes too: Canvas 2D rasterization is size-dependent, so
        // zero coverage at one cell size is not a verdict at another.
        self.pending.clear();
        self.generation = self.generation.wrapping_add(1).max(1);
        self.dirty = true;
        self.dirty_rect = [0, 0, self.atlas_w, self.atlas_h];
    }

    /// Attempt to pack a rect of size (w, h). Returns top-left (x, y) or None if atlas full.
    pub fn pack(&mut self, w: u32, h: u32) -> Option<(u32, u32)> {
        if self.shelf_x + w > self.atlas_w {
            self.shelf_y += self.shelf_h + 1;
            self.shelf_x = 0;
            self.shelf_h = 0;
        }
        if self.shelf_y + h > self.atlas_h {
            return None;
        }
        let pos = (self.shelf_x, self.shelf_y);
        self.shelf_x += w + 1;
        if h > self.shelf_h {
            self.shelf_h = h;
        }
        Some(pos)
    }

    /// Grow atlas to the next tier while preserving every existing glyph's
    /// pixel coordinates. Repacking here would invalidate geometry that was
    /// built earlier in the same frame; keeping coordinates stable limits the
    /// required invalidation to the normalized UV denominator.
    pub fn grow(&mut self) -> bool {
        let Some(new_sz) = self.atlas_w.checked_mul(2) else {
            return false;
        };
        if new_sz > ATLAS_MAX_SIZE {
            return false;
        }

        let old_w = self.atlas_w as usize;
        let old_h = self.atlas_h as usize;
        let new_w = new_sz as usize;
        let Some(new_len) = new_w.checked_mul(new_sz as usize) else {
            return false;
        };
        let mut pixels = vec![0u8; new_len];
        for row in 0..old_h {
            let old_start = row * old_w;
            let new_start = row * new_w;
            pixels[new_start..new_start + old_w]
                .copy_from_slice(&self.pixels[old_start..old_start + old_w]);
        }

        self.atlas_w = new_sz;
        self.atlas_h = new_sz;
        self.pixels = pixels;
        self.generation = self.generation.wrapping_add(1).max(1);
        // The WebGL texture must be reallocated and populated in full after a
        // dimension change, including the zeroed portion of the larger atlas.
        self.dirty = true;
        self.dirty_rect = [0, 0, new_sz, new_sz];
        true
    }

    #[cfg(test)]
    pub fn force_next_pack_to_grow(&mut self) {
        self.shelf_x = self.atlas_w;
        self.shelf_y = self.atlas_h;
        self.shelf_h = 1;
    }

    /// Look up or rasterize a glyph. Returns the GlyphEntry, or None when there
    /// is nothing to draw — whether because the glyph is blank, is queued for
    /// the Canvas 2D pass, or was already found to be unrenderable.
    pub fn get_or_rasterize(&mut self, key: GlyphKey) -> Option<GlyphEntry> {
        match self.slot(key) {
            Some(GlyphSlot::Rasterized(entry)) => return Some(entry),
            // Already resolved to "draws nothing". Returning early is what stops
            // the Canvas 2D pass from being re-queued on every build.
            Some(GlyphSlot::Blank | GlyphSlot::Pending | GlyphSlot::Unrenderable) => return None,
            None => {}
        }
        let ch = char::from_u32(key.codepoint)?;
        let font = self.fonts.get(key.style as usize)?;
        // Index 0 is .notdef — not in this font; queue for JS Canvas 2D rasterization
        if font.lookup_glyph_index(ch) == 0 {
            self.set_slot(key, GlyphSlot::Pending);
            self.pending.insert(key);
            return None;
        }
        let (metrics, bitmap) = font.rasterize(ch, self.px_per_em);
        if metrics.width == 0 || metrics.height == 0 {
            // In the font, but no ink. Record it rather than falling through to
            // an escalation it does not need.
            self.set_slot(key, GlyphSlot::Blank);
            return None;
        }
        let w = metrics.width as u32;
        let h = metrics.height as u32;
        let (ax, ay) = match self.pack(w, h) {
            Some(pos) => pos,
            None => {
                if self.grow() {
                    self.pack(w, h)?
                } else {
                    return None;
                }
            }
        };
        // Blit bitmap into atlas
        let atlas_w = self.atlas_w as usize;
        for row in 0..metrics.height {
            let src = &bitmap[row * metrics.width..(row + 1) * metrics.width];
            let dst_off = (ay as usize + row) * atlas_w + ax as usize;
            self.pixels[dst_off..dst_off + metrics.width].copy_from_slice(src);
        }
        // Update dirty rect
        self.dirty = true;
        if ax < self.dirty_rect[0] {
            self.dirty_rect[0] = ax;
        }
        if ay < self.dirty_rect[1] {
            self.dirty_rect[1] = ay;
        }
        let x2 = ax + w;
        let y2 = ay + h;
        if x2 > self.dirty_rect[2] {
            self.dirty_rect[2] = x2;
        }
        if y2 > self.dirty_rect[3] {
            self.dirty_rect[3] = y2;
        }

        let entry = GlyphEntry {
            atlas_x: ax as u16,
            atlas_y: ay as u16,
            width: metrics.width as u16,
            height: metrics.height as u16,
            offset_x: metrics.xmin as i16,
            offset_y: -(metrics.height as i16 + metrics.ymin as i16),
        };
        self.set_slot(key, GlyphSlot::Rasterized(entry));
        self.pending.remove(&key);
        Some(entry)
    }

    /// Dense index of a key the `ascii` mirror covers.
    #[inline]
    fn dense_index(key: GlyphKey) -> Option<usize> {
        (key.codepoint < DENSE_CODEPOINTS && usize::from(key.style) < STYLES)
            .then(|| key.codepoint as usize * STYLES + usize::from(key.style))
    }

    #[inline]
    fn slot(&self, key: GlyphKey) -> Option<GlyphSlot> {
        match Self::dense_index(key) {
            Some(index) => self.ascii[index],
            None => self.glyphs.get(&key).copied(),
        }
    }

    fn set_slot(&mut self, key: GlyphKey, slot: GlyphSlot) {
        if let Some(index) = Self::dense_index(key) {
            self.ascii[index] = Some(slot);
        }
        self.glyphs.insert(key, slot);
    }

    /// The packed entry for a key that has actually been rasterized, if any.
    #[cfg(test)]
    pub fn rasterized(&self, key: &GlyphKey) -> Option<GlyphEntry> {
        match self.glyphs.get(key) {
            Some(GlyphSlot::Rasterized(entry)) => Some(*entry),
            _ => None,
        }
    }

    /// True while this key is queued for the Canvas 2D pass.
    ///
    /// Callers that keep themselves dirty until a glyph resolves must ask this
    /// rather than treating every `None` as pending: a blank or unrenderable
    /// slot also returns `None` and will never resolve.
    pub fn is_pending(&self, key: GlyphKey) -> bool {
        matches!(self.slot(key), Some(GlyphSlot::Pending))
    }

    pub fn pending_keys(&self) -> impl Iterator<Item = GlyphKey> + '_ {
        self.pending.iter().copied()
    }

    pub fn pending_len(&self) -> usize {
        self.pending.len()
    }

    /// Close a Canvas 2D pass: anything still queued was declined and must not
    /// be offered again.
    pub fn finish_missing_pass(&mut self) {
        for key in self.pending.drain() {
            if let Some(slot) = self.glyphs.get_mut(&key)
                && matches!(slot, GlyphSlot::Pending)
            {
                *slot = GlyphSlot::Unrenderable;
                if let Some(index) = Self::dense_index(key) {
                    self.ascii[index] = Some(GlyphSlot::Unrenderable);
                }
            }
        }
    }

    /// Inject a Canvas-2D-rasterized glyph (R8 pixels) into the atlas.
    /// Used for emoji and other characters not covered by the bundled fonts.
    pub fn inject_extern(
        &mut self,
        key: GlyphKey,
        r8: &[u8],
        w: u16,
        h: u16,
        ox: i16,
        oy: i16,
    ) -> bool {
        if matches!(self.slot(key), Some(GlyphSlot::Rasterized(_))) {
            return true;
        }
        let Some(pixel_len) = usize::from(w).checked_mul(usize::from(h)) else {
            return false;
        };
        if w == 0 || h == 0 || r8.len() != pixel_len {
            return false;
        }
        let (ax, ay) = match self.pack(w as u32, h as u32) {
            Some(pos) => pos,
            None => {
                if self.grow() {
                    match self.pack(w as u32, h as u32) {
                        Some(p) => p,
                        None => return false,
                    }
                } else {
                    return false;
                }
            }
        };
        let aw = self.atlas_w as usize;
        for row in 0..h as usize {
            let src = &r8[row * w as usize..(row + 1) * w as usize];
            let dst = (ay as usize + row) * aw + ax as usize;
            self.pixels[dst..dst + w as usize].copy_from_slice(src);
        }
        self.dirty = true;
        if (ax) < self.dirty_rect[0] {
            self.dirty_rect[0] = ax;
        }
        if (ay) < self.dirty_rect[1] {
            self.dirty_rect[1] = ay;
        }
        let x2 = ax + w as u32;
        let y2 = ay + h as u32;
        if x2 > self.dirty_rect[2] {
            self.dirty_rect[2] = x2;
        }
        if y2 > self.dirty_rect[3] {
            self.dirty_rect[3] = y2;
        }
        let entry = GlyphEntry {
            atlas_x: ax as u16,
            atlas_y: ay as u16,
            width: w,
            height: h,
            offset_x: ox,
            offset_y: oy,
        };
        // The Canvas 2D font stack carries no bold or italic variant, so this
        // one bitmap is exact for all four styles. Aliasing it costs no pixels
        // and stops the same codepoint being re-queued at a different style —
        // which would otherwise loop forever, since injection resolves only the
        // style it was asked for.
        for style in 0..4u8 {
            let alias = GlyphKey {
                codepoint: key.codepoint,
                style,
            };
            self.set_slot(alias, GlyphSlot::Rasterized(entry));
            self.pending.remove(&alias);
        }
        true
    }

    pub fn mark_clean(&mut self) {
        self.dirty = false;
        self.dirty_rect = [u32::MAX, u32::MAX, 0, 0];
    }
}

#[cfg(test)]
#[path = "atlas_profile.rs"]
mod profile;

#[cfg(test)]
mod tests {
    use super::*;

    fn boot_font() -> fontdue::Font {
        let boot = include_bytes!("../../../apps/web/public/fonts/JetBrainsMonoNF-Boot.ttf");
        fontdue::Font::from_bytes(boot.as_slice(), crate::terminal_font_settings()).expect("boot")
    }

    #[test]
    fn boot_face_metrics_match_the_promoted_regular_face() {
        // Cell size comes from the 'M' advance and ascent-descent, so a boot
        // face with different metrics would reflow the grid the instant
        // promotion swapped it out — a PTY resize and a visible jump, on every
        // cold start.
        const EPSILON: f32 = 1e-3;
        let boot = boot_font();
        let regular = &test_atlas().fonts[0];

        let (boot_m, _) = boot.rasterize('M', 14.0);
        let (regular_m, _) = regular.rasterize('M', 14.0);
        assert!((boot_m.advance_width - regular_m.advance_width).abs() < EPSILON);

        let boot_line = boot.horizontal_line_metrics(14.0).expect("boot metrics");
        let regular_line = regular
            .horizontal_line_metrics(14.0)
            .expect("regular metrics");
        assert!((boot_line.ascent - regular_line.ascent).abs() < EPSILON);
        assert!((boot_line.descent - regular_line.descent).abs() < EPSILON);
        assert!((boot_line.line_gap - regular_line.line_gap).abs() < EPSILON);
    }

    #[test]
    fn boot_face_covers_the_required_glyph_floor() {
        let boot = boot_font();
        for &codepoint in REQUIRED_CODEPOINTS {
            let ch = char::from_u32(codepoint).expect("required codepoint is a scalar value");
            assert_ne!(
                boot.lookup_glyph_index(ch),
                0,
                "boot face is missing U+{codepoint:04X}"
            );
        }
    }

    #[test]
    fn boot_coverage_is_a_subset_of_the_regular_face() {
        // Promotion replaces boot with regular. A codepoint present only in boot
        // would therefore be *lost* at promotion — the terminal would render it
        // before first paint and stop afterwards.
        let boot = boot_font();
        let atlas = test_atlas();
        let regular: std::collections::HashSet<char> =
            atlas.fonts[0].chars().keys().copied().collect();
        let extra: Vec<char> = boot
            .chars()
            .keys()
            .copied()
            .filter(|ch| !regular.contains(ch))
            .collect();
        assert!(
            extra.is_empty(),
            "boot face has {} codepoints the regular face lacks",
            extra.len()
        );
        assert!(
            boot.chars().len() < regular.len(),
            "boot face is not reduced"
        );
    }

    fn test_atlas() -> GlyphAtlas {
        let regular = include_bytes!("../../../apps/web/public/fonts/JetBrainsMonoNF-Regular.ttf");
        let bold = include_bytes!("../../../apps/web/public/fonts/JetBrainsMonoNF-Bold.ttf");
        let italic = include_bytes!("../../../apps/web/public/fonts/JetBrainsMonoNF-Italic.ttf");
        let bold_italic =
            include_bytes!("../../../apps/web/public/fonts/JetBrainsMonoNF-BoldItalic.ttf");
        let settings = crate::terminal_font_settings();
        GlyphAtlas::new([
            Rc::new(fontdue::Font::from_bytes(regular.as_slice(), settings).expect("regular font")),
            Rc::new(fontdue::Font::from_bytes(bold.as_slice(), settings).expect("bold font")),
            Rc::new(fontdue::Font::from_bytes(italic.as_slice(), settings).expect("italic font")),
            Rc::new(
                fontdue::Font::from_bytes(bold_italic.as_slice(), settings)
                    .expect("bold italic font"),
            ),
        ])
    }

    /// Codepoints the terminal cannot render any other way.
    ///
    /// The bundled fonts are re-emitted with `hb-subset` (see
    /// `apps/web/public/fonts/SUBSET.json`). Anything absent here falls through to
    /// the worker's Canvas 2D path, which only carries system emoji faces — so a
    /// dropped box-drawing or Powerline glyph becomes a permanently blank cell.
    const REQUIRED_CODEPOINTS: &[u32] = &[
        0x0041, // 'A'
        0x00E9, // 'é', precomposed Latin-1
        0x0301, // combining acute; IME and accented input compose with these
        0x00A0, // no-break space
        0x200B, // zero-width space
        0xFEFF, // BOM / zero-width no-break space
        0xFFFD, // replacement character: every invalid UTF-8 byte renders as this
        0x2500, 0x257F, // box drawing, font-only (not builtin)
        0x2591, 0x2593, // shade blocks, deliberately routed through the font
        0x2580, 0x259F, // block elements: builtin in the cell loop, but the preedit
        //         and prediction builders call get_or_rasterize directly
        0x2400, // control pictures, for `cat`ing a binary
        0xE0A0, 0xE0B0, 0xE0D4, // Powerline and Powerline Extra
    ];

    #[test]
    fn every_face_rasterizes_the_required_glyph_floor() {
        let atlas = test_atlas();
        for (style, font) in atlas.fonts.iter().enumerate() {
            for &codepoint in REQUIRED_CODEPOINTS {
                let ch = char::from_u32(codepoint).expect("required codepoint is a scalar value");
                assert_ne!(
                    font.lookup_glyph_index(ch),
                    0,
                    "style {style} is missing U+{codepoint:04X}"
                );
            }
        }
    }

    #[test]
    fn all_four_faces_expose_identical_coverage() {
        // `missing` is keyed by codepoint alone while `glyphs` is keyed by
        // (codepoint, style), so a glyph present in one face but not another
        // re-enters the missing set on every build. Divergent subsetting is the
        // way that would happen, so the coverage sets must stay identical.
        let atlas = test_atlas();
        let baseline: std::collections::HashSet<char> =
            atlas.fonts[0].chars().keys().copied().collect();
        // Guard against the comparison passing because both sides are empty.
        assert_eq!(
            baseline.len(),
            12_226,
            "regular face coverage changed; update SUBSET.json if this was intended"
        );
        for (style, font) in atlas.fonts.iter().enumerate().skip(1) {
            let coverage: std::collections::HashSet<char> = font.chars().keys().copied().collect();
            let missing: Vec<char> = baseline.difference(&coverage).copied().collect();
            let extra: Vec<char> = coverage.difference(&baseline).copied().collect();
            assert!(
                missing.is_empty() && extra.is_empty(),
                "style {style} coverage diverges: {} missing, {} extra",
                missing.len(),
                extra.len()
            );
        }
    }

    #[test]
    fn cell_metrics_match_pinned_upstream_values() {
        // Cell size comes from the 'M' advance and ascent-descent
        // (`apply_cell_metrics_to_atlas`). hb-subset recomputes the head bbox and
        // hhea, so a subsetting mistake would silently resize every terminal
        // rather than fail visibly. These are the upstream v2.304 values.
        // One font unit at 1000 upem and 14 px is 0.014 px, so this tolerance is
        // far tighter than the smallest drift the font could actually express.
        const EPSILON: f32 = 1e-3;
        fn assert_close(actual: f32, expected: f32, style: usize, label: &str) {
            assert!(
                (actual - expected).abs() < EPSILON,
                "style {style} {label}: expected {expected}, got {actual}"
            );
        }

        let atlas = test_atlas();
        for (style, font) in atlas.fonts.iter().enumerate() {
            let (metrics, _) = font.rasterize('M', 14.0);
            assert_close(metrics.advance_width, 8.4, style, "'M' advance");
            let line = font
                .horizontal_line_metrics(14.0)
                .expect("horizontal line metrics");
            assert_close(line.ascent, 14.28, style, "ascent");
            assert_close(line.descent, -4.2, style, "descent");
            assert_close(line.line_gap, 0.0, style, "line gap");
        }
    }

    #[test]
    fn grow_preserves_pixels_entries_and_advances_generation() {
        let mut atlas = test_atlas();
        atlas.atlas_w = 2;
        atlas.atlas_h = 2;
        atlas.pixels = vec![1, 2, 3, 4];
        atlas.shelf_x = 1;
        atlas.shelf_y = 1;
        atlas.shelf_h = 1;
        let key = GlyphKey {
            codepoint: u32::from('x'),
            style: 0,
        };
        let entry = GlyphEntry {
            atlas_x: 1,
            atlas_y: 1,
            width: 1,
            height: 1,
            offset_x: 0,
            offset_y: 0,
        };
        atlas.set_slot(key, GlyphSlot::Rasterized(entry));
        let generation = atlas.generation();

        assert!(atlas.grow());
        assert_eq!((atlas.atlas_w, atlas.atlas_h), (4, 4));
        assert_eq!(atlas.generation(), generation + 1);
        assert_eq!(atlas.rasterized(&key), Some(entry));
        assert_eq!(
            atlas.pixels,
            vec![1, 2, 0, 0, 3, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
        );
        assert_eq!((atlas.shelf_x, atlas.shelf_y, atlas.shelf_h), (1, 1, 1));
        assert!(atlas.dirty);
        assert_eq!(atlas.dirty_rect, [0, 0, 4, 4]);
    }

    /// Every dense key's mirror slot equals its `glyphs` slot.
    fn assert_dense_mirror(atlas: &GlyphAtlas) {
        for codepoint in 0..DENSE_CODEPOINTS {
            for style in 0..STYLES as u8 {
                let key = GlyphKey { codepoint, style };
                let index = GlyphAtlas::dense_index(key).expect("dense key");
                assert_eq!(
                    atlas.ascii[index],
                    atlas.glyphs.get(&key).copied(),
                    "U+{codepoint:04X} style {style}"
                );
            }
        }
    }

    #[test]
    fn dense_mirror_tracks_every_slot_transition() {
        let mut atlas = test_atlas();
        // Rasterized, Blank (space) and Pending (a control code the faces
        // lack) through the lookup path, in all four styles.
        for codepoint in 0..DENSE_CODEPOINTS {
            for style in 0..STYLES as u8 {
                atlas.get_or_rasterize(GlyphKey { codepoint, style });
            }
        }
        let control = GlyphKey {
            codepoint: 0x01,
            style: 2,
        };
        assert!(atlas.is_pending(control));
        assert_eq!(
            atlas.slot(GlyphKey {
                codepoint: u32::from(' '),
                style: 1,
            }),
            Some(GlyphSlot::Blank)
        );
        assert!(matches!(
            atlas.slot(GlyphKey {
                codepoint: u32::from('A'),
                style: 3,
            }),
            Some(GlyphSlot::Rasterized(_))
        ));
        assert_dense_mirror(&atlas);

        // Injection resolves one control code in all four styles; the pass
        // then declines every other one.
        assert!(atlas.inject_extern(control, &[7; 4], 2, 2, 0, 0));
        atlas.finish_missing_pass();
        assert!(matches!(atlas.slot(control), Some(GlyphSlot::Rasterized(_))));
        assert_eq!(
            atlas.slot(GlyphKey {
                codepoint: 0x02,
                style: 0,
            }),
            Some(GlyphSlot::Unrenderable)
        );
        assert_dense_mirror(&atlas);

        atlas.reset_raster_cache();
        assert!(atlas.glyphs.is_empty());
        assert_dense_mirror(&atlas);
    }

    #[test]
    fn rejected_external_glyph_does_not_consume_atlas_space() {
        let mut atlas = test_atlas();
        let shelf = (atlas.shelf_x, atlas.shelf_y, atlas.shelf_h);
        let key = GlyphKey {
            codepoint: 0x1f600,
            style: 0,
        };

        assert!(!atlas.inject_extern(key, &[1, 2, 3], 2, 2, 0, 0));
        assert_eq!((atlas.shelf_x, atlas.shelf_y, atlas.shelf_h), shelf);
        assert!(!atlas.glyphs.contains_key(&key));
    }
}
