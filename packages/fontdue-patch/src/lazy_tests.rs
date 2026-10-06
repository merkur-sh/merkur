use super::*;

// Golden metrics and grayscale/subpixel bitmap hashes from unmodified registry
// fontdue 0.9.4, default features, load_substitutions=false. Cover every bundled
// face at 14/28/42px, Latin, non-Latin, box drawing, Nerd icons and .notdef.
fn fingerprint(font: &Font) -> u64 {
    let mut hash = 0xcbf29ce484222325u64;
    let mut feed = |bytes: &[u8]| {
        for byte in bytes {
            hash = (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3);
        }
    };
    for size in [14.0, 28.0, 42.0] {
        for ch in " Aaz09gMWéΩЖ中\u{2500}\u{2502}\u{253c}\u{2588}\u{e0b0}\u{e0b2}\u{f013}\u{f120}\u{f418}\u{f1d3}\u{f0308}\u{10ffff}".chars() {
            for subpixel in [false, true] {
                let index = font.lookup_glyph_index(ch);
                feed(&index.to_le_bytes());
                let (metrics, bitmap) = if subpixel { font.rasterize_indexed_subpixel(index, size) } else { font.rasterize_indexed(index, size) };
                feed(&metrics.xmin.to_le_bytes()); feed(&metrics.ymin.to_le_bytes());
                feed(&(metrics.width as u64).to_le_bytes()); feed(&(metrics.height as u64).to_le_bytes());
                for value in [metrics.advance_width, metrics.advance_height, metrics.bounds.xmin, metrics.bounds.ymin, metrics.bounds.width, metrics.bounds.height] { feed(&value.to_bits().to_le_bytes()); }
                feed(&bitmap);
            }
        }
    }
    hash
}

#[test]
fn lazy_rasterization_matches_eager_fontdue() {
    for (bytes, expected) in [
        (
            include_bytes!("../../../apps/web/public/fonts/JetBrainsMonoNF-Boot.ttf").as_slice(),
            0xf69377699f739abd,
        ),
        (
            include_bytes!("../../../apps/web/public/fonts/JetBrainsMonoNF-Regular.ttf").as_slice(),
            0xcfed3de7cd0d0911,
        ),
        (
            include_bytes!("../../../apps/web/public/fonts/JetBrainsMonoNF-Bold.ttf").as_slice(),
            0xb96ab4716ecb891d,
        ),
        (
            include_bytes!("../../../apps/web/public/fonts/JetBrainsMonoNF-Italic.ttf").as_slice(),
            0xfb9fa982f1b9595e,
        ),
        (
            include_bytes!("../../../apps/web/public/fonts/JetBrainsMonoNF-BoldItalic.ttf").as_slice(),
            0x00511cb782a4ee85,
        ),
    ] {
        let font = Font::from_bytes(
            bytes,
            FontSettings {
                load_substitutions: false,
                ..FontSettings::default()
            },
        )
        .unwrap();
        assert!(font.glyphs.iter().all(|glyph| glyph.get().is_none()));
        assert_eq!(fingerprint(&font), expected);
        let prepared = font.glyphs.iter().filter(|glyph| glyph.get().is_some()).count();
        assert!(prepared > 0 && prepared < 30);
        assert_eq!(fingerprint(&font), expected);
        assert_eq!(font.glyphs.iter().filter(|glyph| glyph.get().is_some()).count(), prepared);
        assert_eq!(fingerprint(&font.clone()), expected);
    }
}

#[test]
fn concurrent_first_use_retains_one_outline() {
    let font = Arc::new(
        Font::from_bytes(
            include_bytes!("../../../apps/web/public/fonts/JetBrainsMonoNF-Regular.ttf").as_slice(),
            FontSettings::default(),
        )
        .unwrap(),
    );
    let barrier = Arc::new(std::sync::Barrier::new(4));
    let handles: Vec<_> = (0..4)
        .map(|_| {
            let font = Arc::clone(&font);
            let barrier = Arc::clone(&barrier);
            std::thread::spawn(move || {
                barrier.wait();
                let index = font.lookup_glyph_index('W');
                (font.glyph(index) as *const Glyph as usize, font.rasterize('W', 28.0))
            })
        })
        .collect();
    let values: Vec<_> = handles.into_iter().map(|handle| handle.join().unwrap()).collect();
    assert!(values.windows(2).all(|pair| pair[0] == pair[1]));
    assert_eq!(font.glyphs.iter().filter(|glyph| glyph.get().is_some()).count(), 1);
}
