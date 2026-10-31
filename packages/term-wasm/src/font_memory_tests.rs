use super::*;

fn fresh_replace(terminal: &mut Terminal, fonts: [Rc<fontdue::Font>; 4]) {
    terminal.atlas = Some(atlas::GlyphAtlas::new(fonts));
    terminal.full_damage = true;
}

fn reuse_replace(terminal: &mut Terminal, fonts: [Rc<fontdue::Font>; 4]) {
    terminal.atlas.as_mut().expect("atlas").replace_fonts(fonts);
    terminal.full_damage = true;
}

fn draw(terminal: &mut Terminal) {
    for (row, flags) in [
        Flags::empty(),
        Flags::BOLD,
        Flags::ITALIC,
        Flags::BOLD_ITALIC,
    ]
    .into_iter()
    .enumerate()
    {
        for (col, ch) in "HéλЖ─█\u{e0b0}\u{f013} _gy".chars().enumerate() {
            let mut cell = test_cell(ch);
            cell.attrs = cell
                .attrs
                .with(CellAttrs::BOLD, flags.contains(Flags::BOLD))
                .with(CellAttrs::ITALIC, flags.contains(Flags::ITALIC));
            write_cell(
                &mut terminal.term.grid_mut()
                    [Point::new(Line(i32::try_from(row).expect("four rows")), Column(col))],
                cell,
            );
        }
    }
    terminal.build_presented_geometry();
    terminal.atlas_mark_clean();
}

fn assert_same(actual: &Terminal, expected: &Terminal) {
    let a = actual.atlas.as_ref().expect("actual atlas");
    let b = expected.atlas.as_ref().expect("reference atlas");
    assert_eq!(a.pixels, b.pixels);
    assert_eq!(a.table, b.table);
    assert!(a.glyphs == b.glyphs);
    assert_eq!((a.atlas_w, a.atlas_h), (b.atlas_w, b.atlas_h));
    assert_eq!(a.generation(), b.generation());
    assert_eq!((a.dirty, a.dirty_rect), (b.dirty, b.dirty_rect));
    assert_eq!(actual.cell_buf, expected.cell_buf);
    assert_eq!(actual.overlay_buf, expected.overlay_buf);
    assert_eq!(actual.geometry_params, expected.geometry_params);
}

#[test]
fn font_replacement_matches_fresh_atlas() {
    type ReplaceFonts = fn(&mut Terminal, [Rc<fontdue::Font>; 4]);
    let replacements: [ReplaceFonts; 2] = [Terminal::replace_fonts, reuse_replace];
    for replace in replacements {
        let mut actual = terminal_with_atlas(24, 4);
        let mut expected = terminal_with_atlas(24, 4);
        let styled = actual.atlas.as_ref().expect("atlas").fonts.clone();
        for step in 0..5 {
            draw(&mut actual);
            draw(&mut expected);
            if step == 1 {
                for terminal in [&mut actual, &mut expected] {
                    assert!(terminal.atlas.as_mut().expect("atlas").grow());
                }
            }
            // The installed family changes from four faces to regular-only aliases,
            // then back, without compiling another set of outlines for the reference.
            let fonts = if step == 2 {
                regular_font_aliases(Rc::clone(&styled[0]))
            } else {
                styled.clone()
            };
            let old_epoch = actual.atlas.as_ref().expect("atlas").table_epoch();
            replace(&mut actual, fonts.clone());
            fresh_replace(&mut expected, fonts);
            assert_ne!(
                actual.atlas.as_ref().expect("atlas").table_epoch(),
                old_epoch
            );
            assert_same(&actual, &expected);
            for dpr in [1.0, 1.25, 2.0, 3.0] {
                for terminal in [&mut actual, &mut expected] {
                    terminal.set_cell_metrics(14.0 * dpr, 1.2, dpr);
                    draw(terminal);
                }
                assert_same(&actual, &expected);
                // Device recovery republishes the same resident pixels and records.
                actual.full_damage = true;
                actual.build_geometry();
                assert_same(&actual, &expected);
            }
        }
    }
}

#[test]
fn invalid_style_replacement_matches_regular_aliases() {
    let mut actual = terminal_with_atlas(24, 4);
    draw(&mut actual);
    let normal = Rc::clone(&actual.atlas.as_ref().expect("atlas").fonts[0]);
    let mut expected = terminal_with_atlas(24, 4);
    draw(&mut expected);
    actual.set_style_font_bytes(b"invalid", b"", b"invalid");
    fresh_replace(&mut expected, regular_font_aliases(normal));
    for terminal in [&mut actual, &mut expected] {
        terminal.set_cell_metrics(28.0, 1.2, 2.0);
        draw(terminal);
    }
    assert_same(&actual, &expected);
}

#[test]
fn invalid_regular_replacement_leaves_the_atlas_unchanged() {
    let mut actual = terminal_with_atlas(24, 4);
    let mut expected = terminal_with_atlas(24, 4);
    draw(&mut actual);
    draw(&mut expected);
    let epoch = actual.atlas.as_ref().expect("atlas").table_epoch();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        actual.set_regular_font_bytes(b"invalid");
    }));
    assert!(result.is_err());
    assert_eq!(actual.atlas.as_ref().expect("atlas").table_epoch(), epoch);
    assert_same(&actual, &expected);
}

#[test]
fn atlas_replacement_reuses_only_initial_pixel_capacity() {
    let mut terminal = terminal_with_atlas(24, 4);
    draw(&mut terminal);
    let fonts = terminal.atlas.as_ref().expect("atlas").fonts.clone();
    let mut atlas = terminal.atlas.take().expect("atlas");
    let pointer = atlas.pixels.as_ptr();
    let stats = geometry_allocations::measure(|| {
        atlas.replace_fonts(fonts.clone());
    });
    println!("FONT_MEMORY replacement={stats:?}");
    assert_eq!(
        (stats.allocations, stats.allocated_bytes, stats.peak_bytes),
        (0, 0, 0)
    );
    assert_eq!(atlas.pixels.as_ptr(), pointer);
    assert!(atlas.pixels.iter().all(|&pixel| pixel == 0));
    assert!(atlas.glyphs.is_empty());
    assert!(atlas.table.is_empty());
    assert_eq!(atlas.pending_len(), 0);
    let pixels = vec![127; (atlas::ATLAS_INITIAL_SIZE * atlas::ATLAS_INITIAL_SIZE) as usize];
    assert!(atlas.inject_extern(
        atlas::GlyphKey {
            codepoint: 0x10ffff,
            style: 0
        },
        &pixels,
        2048,
        2048,
        0,
        0,
    ));
    atlas.replace_fonts(fonts.clone());
    assert_eq!(atlas.pixels.as_ptr(), pointer);
    assert!(atlas.pixels.iter().all(|&pixel| pixel == 0));
    atlas.force_next_pack_to_grow();
    atlas.replace_fonts(fonts.clone());
    assert!(atlas.pixels.iter().all(|&pixel| pixel == 0));
    assert!(atlas.grow());
    let stats = geometry_allocations::measure(|| {
        atlas.replace_fonts(fonts);
    });
    assert_eq!(stats.allocations, 1);
    assert_eq!(
        stats.allocated_bytes,
        (atlas::ATLAS_INITIAL_SIZE * atlas::ATLAS_INITIAL_SIZE) as usize
    );
    assert_eq!(
        stats.peak_bytes, 0,
        "grown storage retires before allocation"
    );
    assert_eq!(atlas.atlas_w, atlas::ATLAS_INITIAL_SIZE);
    assert_eq!(atlas.pixels.capacity(), stats.allocated_bytes);
    assert!(atlas.pixels.iter().all(|&pixel| pixel == 0));
}

#[test]
#[ignore = "allocation and instruction-count profile; run with --nocapture --test-threads=1"]
fn atlas_replacement_profile() {
    let iterations: usize = std::env::var("FONT_MEMORY_ITERATIONS")
        .unwrap_or_else(|_| "200".into())
        .parse()
        .expect("iteration count");
    let arm = std::env::var("FONT_MEMORY_ARM").unwrap_or_else(|_| "production".into());
    let workload = std::env::var("FONT_MEMORY_WORKLOAD").unwrap_or_else(|_| "used".into());
    assert!(matches!(arm.as_str(), "production" | "fresh"));
    assert!(matches!(
        workload.as_str(),
        "empty" | "used" | "grown" | "dpr" | "steady"
    ));
    let mut terminal = terminal_with_atlas(24, 4);
    let fonts = terminal.atlas.as_ref().expect("atlas").fonts.clone();
    if workload != "empty" {
        draw(&mut terminal);
    }
    if workload == "dpr" {
        terminal.set_cell_metrics(42.0, 1.2, 3.0);
        draw(&mut terminal);
    }
    if workload == "grown" {
        assert!(terminal.atlas.as_mut().expect("atlas").grow());
    }
    let replace = |terminal: &mut Terminal| {
        if arm == "fresh" {
            fresh_replace(terminal, fonts.clone());
        } else {
            terminal.replace_fonts(fonts.clone());
        }
    };
    let stats = geometry_allocations::measure(|| {
        if workload == "steady" {
            terminal.build_geometry();
        } else {
            replace(&mut terminal);
        }
    });
    println!(
        "FONT_MEMORY arm={arm} workload={workload} allocations={} allocated_bytes={} peak_bytes={}",
        stats.allocations, stats.allocated_bytes, stats.peak_bytes,
    );
    let start = std::time::Instant::now();
    for _ in 0..iterations {
        if workload == "steady" {
            terminal.build_geometry();
        } else {
            if workload != "empty" {
                terminal.set_cell_metrics(if workload == "dpr" { 42.0 } else { 14.0 }, 1.2, 1.0);
                draw(&mut terminal);
            }
            if workload == "grown" {
                assert!(terminal.atlas.as_mut().expect("atlas").grow());
            }
            replace(&mut terminal);
        }
        std::hint::black_box(&terminal);
    }
    println!(
        "FONT_MEMORY iterations={iterations} elapsed_ns={}",
        start.elapsed().as_nanos()
    );
}
