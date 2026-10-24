// Receive and eligibility deliberately use different calls in these tests.
// Do not use the apply_presented_* fixture helpers for the held update.

#[test]
fn presentation_selection_reads_only_eligible_text_and_wrap_flags() {
    let mut terminal = prediction_terminal(4, 2);
    let before = test_frame_with_entries(
        FrameKind::Snapshot,
        4,
        2,
        1,
        0,
        &[RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &[test_cell('a')],
        }],
    );
    assert!(terminal.apply_presented_state_seq(&before, 1));
    let selected = terminal.presentation_viewport_rows();
    let wraps = terminal.presentation_viewport_wrap_bits();
    let mut wrapped = test_cell('X');
    wrapped.set_wrapped(true);
    let held = test_frame_with_entries(
        FrameKind::Delta,
        4,
        2,
        1,
        0,
        &[RowRef {
            graphics: &[],
            row_index: 0,
            left: 3,
            cells: &[wrapped],
        }],
    );
    assert!(terminal.apply_delta_seq(&held, 2));
    assert_ne!(terminal.viewport_rows(), selected);
    assert_ne!(terminal.viewport_wrap_bits(), wraps);
    assert_eq!(terminal.presentation_viewport_rows(), selected);
    assert_eq!(terminal.presentation_viewport_wrap_bits(), wraps);
    terminal.commit_presentation_state();
    assert_eq!(
        terminal.presentation_viewport_rows(),
        terminal.viewport_rows()
    );
    assert_eq!(
        terminal.presentation_viewport_wrap_bits(),
        terminal.viewport_wrap_bits()
    );
}

#[test]
fn presentation_hold_keeps_received_rows_and_cursor_out_of_forced_geometry_rebuilds() {
    let mut terminal = terminal_with_atlas(8, 2);
    let before = test_frame_with_entries(
        FrameKind::Snapshot,
        8,
        2,
        1,
        0,
        &[RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &[test_cell('a')],
        }],
    );
    assert!(terminal.apply_presented_state_seq(&before, 1));
    terminal.build_geometry();
    let glyphs = terminal.drawn_text();
    let cursor = terminal.cursor_buf.clone();
    let revision = terminal.presentation_revision();

    let held = test_frame_with_entries(
        FrameKind::Delta,
        8,
        2,
        3,
        1,
        &[RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &[test_cell('x')],
        }],
    );
    assert!(terminal.apply_delta_seq(&held, 2));
    assert_eq!(terminal.row_text(0), "x");
    assert_eq!(terminal.display_row_version(0), 2);
    assert_eq!(terminal.presentation_row_version(0), 1);
    terminal.received_cursor_info_ptr();
    assert_eq!(&terminal.received_cursor_info_buf[..2], &[3, 1]);
    terminal.cursor_info_ptr();
    assert_eq!(&terminal.cursor_info_buf[..2], &[1, 0]);

    // Font/theme refresh and local overlay work can force a rebuild during a
    // hold. It must still read only the retained eligible cells/header.
    terminal.full_damage = true;
    terminal.build_geometry();
    assert_eq!(terminal.drawn_text(), glyphs);
    assert_eq!(terminal.cursor_buf, cursor);
    assert_eq!(terminal.presentation_revision(), revision);
    assert_eq!(terminal.presentation_dirty_rows, [0]);

    terminal.commit_presentation_state();
    terminal.build_geometry();
    assert_ne!(terminal.drawn_text(), glyphs);
    assert_ne!(terminal.cursor_buf, cursor);
    assert_eq!(terminal.presentation_row_version(0), 2);
    assert!(terminal.presentation_dirty_rows.is_empty());
}

#[test]
fn presentation_hold_keeps_confirmed_prefix_visible_and_accepts_the_next_keystroke() {
    let mut terminal = terminal_with_atlas(20, 2);
    train_shadow_text(&mut terminal, "a");
    terminal.build_geometry();
    assert_ne!(terminal.predict_printable('b' as u32, 101.0, 2, true), 0);
    terminal.build_geometry();
    let before_echo = terminal.drawn_text();
    let held_echo = test_frame_with_entries(
        FrameKind::Delta,
        20,
        2,
        2,
        0,
        &[RowRef {
            graphics: &[],
            row_index: 0,
            left: 1,
            cells: &[test_cell('b')],
        }],
    );
    assert!(terminal.apply_delta_seq(&held_echo, 2));
    terminal.predict_reconcile(110.0, 500.0, 2, 2);
    assert_eq!(terminal.reconcile_stats, [0, 0, 0, 0, 0, 1, 0]);
    assert!(terminal.has_predictions());
    terminal.build_geometry();
    assert_eq!(terminal.drawn_text(), before_echo);
    assert_eq!(terminal.visible_prediction_input_seqs, [2]);

    assert_ne!(terminal.predict_printable('c' as u32, 111.0, 3, true), 0);
    terminal.build_geometry();
    assert_eq!(terminal.glyph_count(), 3);
    assert_eq!(terminal.visible_prediction_input_seqs, [2, 3]);
    terminal.cursor_info_ptr();
    assert_eq!(&terminal.cursor_info_buf[..2], &[3, 0]);

    terminal.commit_presentation_state();
    terminal.predict_reconcile(112.0, 500.0, 2, 2);
    assert_eq!(terminal.reconcile_stats[0], 1);
    terminal.build_geometry();
    assert_eq!(terminal.glyph_count(), 3);
    assert_eq!(terminal.visible_prediction_input_seqs, [3]);
    terminal.cursor_info_ptr();
    assert_eq!(&terminal.cursor_info_buf[..2], &[3, 0]);
}

#[test]
fn presentation_reconciles_the_echoed_prefix_when_input_coverage_runs_ahead() {
    let mut terminal = terminal_with_atlas(20, 2);
    train_shadow_text(&mut terminal, "a");
    terminal.build_geometry();
    assert_ne!(terminal.predict_printable('b' as u32, 101.0, 2, true), 0);
    terminal.build_geometry();
    let before_echo = terminal.drawn_text();
    let held_echo = test_frame_with_entries(
        FrameKind::Delta,
        20,
        2,
        2,
        0,
        &[RowRef {
            graphics: &[],
            row_index: 0,
            left: 1,
            cells: &[test_cell('b')],
        }],
    );
    assert!(terminal.apply_delta_seq(&held_echo, 2));
    terminal.predict_reconcile(110.0, 500.0, 2, 2);
    assert_eq!(terminal.reconcile_stats, [0, 0, 0, 0, 0, 1, 0]);
    assert!(terminal.has_predictions());
    terminal.build_geometry();
    assert_eq!(terminal.drawn_text(), before_echo);
    assert_eq!(terminal.visible_prediction_input_seqs, [2]);

    assert_ne!(terminal.predict_printable('c' as u32, 111.0, 3, true), 0);
    terminal.build_geometry();
    assert_eq!(terminal.glyph_count(), 3);
    assert_eq!(terminal.visible_prediction_input_seqs, [2, 3]);
    terminal.cursor_info_ptr();
    assert_eq!(&terminal.cursor_info_buf[..2], &[3, 0]);

    terminal.commit_presentation_state();
    // PTY write completion covers c before its echo exists. The eligible
    // image already contains b, so b must leave the speculative base now.
    terminal.predict_reconcile(112.0, 500.0, 3, 3);
    assert_eq!(terminal.reconcile_stats[0], 1);
    terminal.build_geometry();
    assert_eq!(terminal.glyph_count(), 3);
    assert_eq!(terminal.visible_prediction_input_seqs, [3]);
    terminal.cursor_info_ptr();
    assert_eq!(&terminal.cursor_info_buf[..2], &[3, 0]);
    assert_ne!(terminal.predict_printable('d' as u32, 113.0, 4, true), 0);
}

#[test]
fn presentation_received_contradiction_refuses_new_input_before_visual_grace_expires() {
    for (row_cells, cursor_col) in [
        (vec![test_cell('X'), test_cell('b')], 2),
        (vec![test_cell('a'), test_cell('b')], 7),
    ] {
        let mut terminal = terminal_with_atlas(20, 2);
        train_shadow_text(&mut terminal, "a");
        terminal.build_geometry();
        let eligible = terminal.drawn_text();
        assert_ne!(terminal.predict_printable('b' as u32, 101.0, 2, true), 0);
        let held = test_frame_with_entries(
            FrameKind::Delta,
            20,
            2,
            cursor_col,
            0,
            &[RowRef {
                graphics: &[],
                row_index: 0,
                left: 0,
                cells: &row_cells,
            }],
        );
        assert!(terminal.apply_delta_seq(&held, 2));
        terminal.predict_reconcile(102.0, 500.0, 2, 2);
        assert!(!terminal.shadow_received_compatible);
        terminal.prediction_model_ptr();
        assert_eq!(terminal.prediction_model_buf[0], 0);
        assert_eq!(terminal.predict_printable('c' as u32, 103.0, 3, true), 0);
        // The refusal seals the line. The glyph already painted is not taken
        // back for a contradiction still inside its grace — the same grace the
        // reconciliation itself waits — and comes off when the grace expires,
        // as a contradiction this refusal was itself provoked by.
        assert!(terminal.has_predictions());
        terminal.build_geometry();
        assert_ne!(terminal.drawn_text(), eligible);
        terminal.predict_reconcile(103.0 + PREDICTION_MISMATCH_GRACE_MS, 500.0, 2, 2);
        if cursor_col == 7 {
            // Only the cursor disagreed, and the refused `c` is not written
            // yet, so the row cannot be its result: the line waits for exact
            // cursor authority as an open one does. Once `c` is written the
            // sealed line expects no cursor and the row confirms the glyph —
            // but a confirmation is not a visual replacement until the
            // received row is presented, and the painted glyph stays until
            // then rather than blinking off first.
            assert!(terminal.has_predictions());
            terminal.predict_reconcile(103.5 + PREDICTION_MISMATCH_GRACE_MS, 500.0, 3, 3);
            assert!(terminal.has_predictions());
            terminal.commit_presentation_state();
            terminal.predict_reconcile(104.0 + PREDICTION_MISMATCH_GRACE_MS, 500.0, 3, 3);
        }
        assert!(!terminal.has_predictions());
        terminal.build_geometry();
        assert_eq!(
            terminal.drawn_text(),
            if cursor_col == 7 {
                terminal.drawn_text()
            } else {
                eligible
            }
        );
        assert_eq!(
            terminal.presentation_row_version(0),
            if cursor_col == 7 { 2 } else { 1 }
        );
    }
}

#[test]
fn presentation_unseeded_input_cannot_start_against_a_held_received_row() {
    let mut terminal = prediction_terminal(20, 2);
    let held = test_frame_with_entries(
        FrameKind::Delta,
        20,
        2,
        1,
        0,
        &[RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &[test_cell('X')],
        }],
    );
    assert!(terminal.apply_delta_seq(&held, 1));
    assert_eq!(terminal.predict_printable('c' as u32, 101.0, 1, true), 0);
    terminal.commit_presentation_state();
    assert_ne!(terminal.predict_printable('c' as u32, 102.0, 1, true), 0);
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn presentation_matching_prefix_compatibility_reuses_replay_storage() {
    let mut terminal = prediction_terminal(20, 2);
    train_shadow_text(&mut terminal, "a");
    assert_ne!(terminal.predict_printable('b' as u32, 101.0, 2, true), 0);
    let held = test_frame_with_entries(
        FrameKind::Delta,
        20,
        2,
        2,
        0,
        &[RowRef {
            graphics: &[],
            row_index: 0,
            left: 1,
            cells: &[test_cell('b')],
        }],
    );
    assert!(terminal.apply_delta_seq(&held, 2));
    terminal.refresh_shadow_received_compatibility();
    let allocations = geometry_allocations::count(|| {
        for _ in 0..256 {
            terminal.refresh_shadow_received_compatibility();
        }
    });
    assert!(terminal.shadow_received_compatible);
    assert_eq!(allocations, 0);
}

#[test]
fn presentation_security_revocation_clears_prediction_without_exposing_held_authority() {
    let mut terminal = terminal_with_atlas(20, 2);
    train_shadow_text(&mut terminal, "a");
    terminal.build_geometry();
    let baseline_glyphs = terminal.drawn_text();
    let baseline_cursor = terminal.cursor_buf.clone();
    assert_ne!(terminal.predict_printable('b' as u32, 101.0, 2, true), 0);
    terminal.build_geometry();
    assert_eq!(terminal.glyph_count(), 2);

    // A hidden authoritative cursor immediately revokes prediction through the
    // normal decoded header, without a direct security-state mutation.
    let revoked = test_cursor_frame(20, 2, 4, 1, CURSOR_SHAPE_HIDDEN, 0);
    assert!(terminal.apply_delta_seq(&revoked, 2));
    let held_row = test_frame_with_entries(
        FrameKind::Delta,
        20,
        2,
        4,
        1,
        &[RowRef {
            graphics: &[],
            row_index: 1,
            left: 0,
            cells: &[test_cell('X')],
        }],
    );
    // Older header cannot reopen the received security gate, but its independent
    // row transformation still applies.
    assert!(terminal.apply_delta_seq(&held_row, 1));
    assert!(!terminal.has_predictions());
    assert_eq!(terminal.predict_printable('c' as u32, 102.0, 3, true), 0);
    assert_eq!(terminal.row_text(1), "X");
    terminal.build_geometry();
    assert_eq!(terminal.drawn_text(), baseline_glyphs);
    assert_eq!(terminal.cursor_buf, baseline_cursor);
    assert!(terminal.visible_prediction_input_seqs.is_empty());
    assert!(terminal.presentation_header_pending);
    assert_eq!(terminal.presentation_dirty_rows, [1]);
}

#[test]
fn presentation_resize_is_not_visible_until_explicit_commit() {
    let mut terminal = terminal_with_atlas(8, 2);
    terminal.commit_presentation_state();
    terminal.build_geometry();
    let cursor = terminal.cursor_buf.clone();
    let resized = test_frame_with_entries(
        FrameKind::Snapshot,
        12,
        3,
        7,
        2,
        &[RowRef {
            graphics: &[],
            row_index: 2,
            left: 0,
            cells: &[test_cell('R')],
        }],
    );
    assert!(terminal.apply_state_seq(&resized, 1));
    assert_eq!((terminal.cols(), terminal.rows()), (12, 3));
    assert_eq!(
        (terminal.presentation_cols(), terminal.presentation_rows()),
        (8, 2)
    );
    terminal.build_geometry();
    assert_eq!(terminal.glyph_count(), 0);
    assert_eq!(terminal.cursor_buf, cursor);
    terminal.commit_presentation_state();
    terminal.build_geometry();
    assert_eq!(
        (terminal.presentation_cols(), terminal.presentation_rows()),
        (12, 3)
    );
    assert_eq!(terminal.glyph_count(), 1);
    assert_ne!(terminal.cursor_buf, cursor);
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn presentation_sparse_commit_reuses_rows_and_copies_no_unchanged_row() {
    let mut terminal = terminal_with_atlas(20, 2);
    terminal.commit_presentation_state();
    terminal.build_geometry();
    let storage = terminal.presentation_grid[Line(0)][..].as_ptr();
    for sequence in 1..=64 {
        let cell = test_cell(if sequence % 2 == 0 { 'a' } else { 'b' });
        let frame = test_frame_with_entries(
            FrameKind::Delta,
            20,
            2,
            1,
            0,
            &[RowRef {
                graphics: &[],
                row_index: 0,
                left: 0,
                cells: &[cell],
            }],
        );
        assert!(terminal.apply_delta_seq(&frame, sequence));
        // A newer repeat updates metadata but never creates another list entry.
        assert!(terminal.apply_delta_seq(&frame, sequence + 100));
        assert_eq!(terminal.presentation_dirty_rows, [0]);
        if sequence > 1 {
            let allocations = geometry_allocations::count(|| {
                terminal.commit_presentation_state();
            });
            assert_eq!(allocations, 0);
        } else {
            terminal.commit_presentation_state();
        }
        assert_eq!(terminal.presentation_grid[Line(0)][..].as_ptr(), storage);
        assert_eq!(terminal.presentation_row_version(0), sequence + 100);
        terminal.build_geometry();
        let unchanged = test_frame_with_entries(
            FrameKind::Delta,
            20,
            2,
            1,
            0,
            &[RowRef {
                graphics: &[],
                row_index: 0,
                left: 0,
                cells: &[cell],
            }],
        );
        assert!(terminal.apply_delta_seq(&unchanged, sequence + 200));
        assert!(terminal.presentation_dirty_set[0]);
        assert!(terminal.presentation_dirty_cells[0].is_none());
        terminal.commit_presentation_state();
        assert!(terminal.damaged_rows.is_empty());
        assert_eq!(terminal.presentation_row_version(0), sequence + 200);
        // Each iteration begins a fresh receive ordering epoch; presentation
        // storage remains retained and its values are deliberately not reset.
        terminal.reset_display_ordering();
    }
}

#[test]
fn presentation_reordered_header_and_row_prefixes_do_not_reject_continued_typing() {
    let mut terminal = prediction_terminal(20, 2);
    train_shadow_text(&mut terminal, "a");
    for (seq, ch) in [(2, 'b'), (3, 'c'), (4, 'd')] {
        assert_ne!(
            terminal.predict_printable(ch as u32, 100.0 + f64::from(seq), seq, true),
            0
        );
    }
    // Cursor after c overtakes every row since a. Both are known prefixes,
    // but there is no single echo to confirm and no contradictory character.
    let header = test_frame_with_entries(FrameKind::Delta, 20, 2, 3, 0, &[]);
    assert!(terminal.apply_delta_seq(&header, 4));
    assert!(terminal.shadow_received_split);
    terminal.predict_reconcile(110.0, 500.0, 4, 4);
    terminal.predict_reconcile(150.0, 500.0, 4, 4);
    assert_eq!(terminal.reconcile_stats, [0, 0, 0, 0, 0, 1, 0]);
    assert_ne!(terminal.predict_printable('e' as u32, 151.0, 5, true), 0);
    terminal.commit_presentation_state();
    terminal.prediction_model_ptr();
    assert_ne!(terminal.prediction_model_buf[0] & 1, 0);
    assert_ne!(terminal.predict_printable('f' as u32, 152.0, 6, true), 0);
    assert_eq!(terminal.predicted_cursor, (0, 6));

    // Another receipt must not invalidate the certificate for the still-visible
    // split grid while its successor is held.
    let partial = test_frame_with_entries(
        FrameKind::Delta,
        20,
        2,
        4,
        0,
        &[RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &[test_cell('a'), test_cell('b')],
        }],
    );
    assert!(terminal.apply_delta_seq(&partial, 5));
    assert!(terminal.shadow_received_split);
    terminal.prediction_model_ptr();
    assert_ne!(terminal.prediction_model_buf[0] & 1, 0);
    assert_ne!(terminal.predict_printable('g' as u32, 153.0, 7, true), 0);

    let cells: Vec<_> = "abcdefg".chars().map(test_cell).collect();
    let echo = test_frame_with_entries(
        FrameKind::Delta,
        20,
        2,
        7,
        0,
        &[RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &cells,
        }],
    );
    assert!(terminal.apply_delta_seq(&echo, 6));
    assert!(!terminal.shadow_received_split);
    terminal.commit_presentation_state();
    terminal.predict_reconcile(200.0, 500.0, 7, 7);
    assert_eq!(terminal.reconcile_stats[0], 6);
    assert_eq!(terminal.reconcile_stats[1], 0);
    assert!(!terminal.has_predictions());
}

#[test]
fn presentation_split_prefix_evidence_never_hides_a_changed_pending_character() {
    let mut terminal = prediction_terminal(20, 2);
    train_shadow_text(&mut terminal, "a");
    assert_ne!(terminal.predict_printable('b' as u32, 101.0, 2, true), 0);
    assert_ne!(terminal.predict_printable('c' as u32, 102.0, 3, true), 0);
    let changed = test_frame_with_entries(
        FrameKind::Delta,
        20,
        2,
        3,
        0,
        &[RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &[test_cell('a'), test_cell('X'), test_cell(' ')],
        }],
    );
    assert!(terminal.apply_delta_seq(&changed, 3));
    assert!(!terminal.shadow_received_compatible);
    assert!(!terminal.shadow_received_split);
    assert_eq!(terminal.predict_printable('d' as u32, 110.0, 4, true), 0);
    terminal.predict_reconcile(110.0, 500.0, 3, 3);
    terminal.predict_reconcile(130.0, 500.0, 3, 3);
    assert_eq!(terminal.reconcile_stats[1], 1);
}

#[test]
fn presentation_split_prefix_wait_is_bounded_by_the_original_prediction_lifetime() {
    let mut terminal = prediction_terminal(20, 2);
    train_shadow_text(&mut terminal, "a");
    assert_ne!(terminal.predict_printable('b' as u32, 101.0, 2, true), 0);
    assert_ne!(terminal.predict_printable('c' as u32, 102.0, 3, true), 0);
    let header = test_frame_with_entries(FrameKind::Delta, 20, 2, 3, 0, &[]);
    assert!(terminal.apply_delta_seq(&header, 3));
    assert!(terminal.shadow_received_split);
    terminal.predict_reconcile(601.0, 500.0, 3, 3);
    assert_eq!(terminal.reconcile_stats, [0, 0, 0, 0, 0, 1, 0]);
    terminal.predict_reconcile(603.0, 500.0, 3, 3);
    assert_eq!(terminal.reconcile_stats[2], 2);
    assert!(!terminal.has_predictions());
    assert!(!terminal.shadow_received_split);
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn presentation_split_prefix_compatibility_reuses_replay_storage() {
    let mut terminal = prediction_terminal(20, 2);
    train_shadow_text(&mut terminal, "a");
    assert_ne!(terminal.predict_printable('b' as u32, 101.0, 2, true), 0);
    assert_ne!(terminal.predict_printable('c' as u32, 102.0, 3, true), 0);
    let header = test_frame_with_entries(FrameKind::Delta, 20, 2, 3, 0, &[]);
    assert!(terminal.apply_delta_seq(&header, 3));
    terminal.refresh_shadow_received_compatibility();
    let allocations = geometry_allocations::count(|| {
        for _ in 0..256 {
            terminal.refresh_shadow_received_compatibility();
        }
    });
    assert!(terminal.shadow_received_split);
    assert_eq!(allocations, 0);
}

#[test]
fn presentation_split_prefix_certificate_cannot_outlive_security_revocation() {
    let mut terminal = prediction_terminal(20, 2);
    train_shadow_text(&mut terminal, "a");
    assert_ne!(terminal.predict_printable('b' as u32, 101.0, 2, true), 0);
    let header = test_frame_with_entries(FrameKind::Delta, 20, 2, 2, 0, &[]);
    assert!(terminal.apply_delta_seq(&header, 2));
    terminal.commit_presentation_state();
    assert!(terminal.shadow_presentation_split);
    let revoked = test_cursor_frame(20, 2, 2, 0, CURSOR_SHAPE_HIDDEN, 0);
    assert!(terminal.apply_delta_seq(&revoked, 3));
    assert!(!terminal.has_predictions());
    assert!(!terminal.shadow_received_split);
    assert!(!terminal.shadow_presentation_split);
    assert_eq!(terminal.predict_printable('c' as u32, 102.0, 3, true), 0);
}

#[test]
fn presentation_links_change_only_with_the_cells_they_name() {
    let mut terminal = prediction_terminal(4, 2);
    let mut cell = test_cell('a');
    cell.link = 17;
    let frame = |kind, cell| {
        test_frame_with_entries(
            kind,
            4,
            2,
            1,
            0,
            &[RowRef {
                graphics: &[],
                row_index: 0,
                left: 0,
                cells: &[cell],
            }],
        )
    };
    assert!(terminal.apply_presented_state_seq(&frame(FrameKind::Snapshot, cell), 1));
    let mut links = Vec::new();
    terminal.displayed_links(0, &mut links);
    assert_eq!(links, [17, 0, 0, 0]);
    // Link-only changes have no glyph damage, but remain held with their row.
    cell.link = 23;
    assert!(terminal.apply_delta_seq(&frame(FrameKind::Delta, cell), 2));
    terminal.displayed_links(0, &mut links);
    assert_eq!(links, [17, 0, 0, 0]);
    terminal.commit_presentation_state();
    terminal.displayed_links(0, &mut links);
    assert_eq!(links, [23, 0, 0, 0]);
    terminal.resize(2, 2);
    terminal.commit_presentation_state();
    terminal.displayed_links(0, &mut links);
    assert_eq!(links, [0, 0]);
}

#[test]
fn a_commit_stamps_exactly_the_rows_it_rewrote() {
    let mut terminal = prediction_terminal(4, 3);
    let frame = |kind, row_index, cell| {
        test_frame_with_entries(
            kind,
            4,
            3,
            0,
            0,
            &[RowRef {
                graphics: &[],
                row_index,
                left: 0,
                cells: &[cell],
            }],
        )
    };
    let stamps = |terminal: &Terminal| -> Vec<u64> {
        (0..3)
            .map(|row| {
                terminal
                    .presentation_row_commit(row)
                    .expect("a committed row")
            })
            .collect()
    };
    assert!(terminal.apply_presented_state_seq(&frame(FrameKind::Snapshot, 0, test_cell('a')), 1));
    let whole = stamps(&terminal);
    assert!(whole.iter().all(|stamp| *stamp == whole[0]));
    assert_eq!(terminal.presentation_row_commit(3), None);

    // A commit that changes nothing stamps nothing.
    terminal.commit_presentation_state();
    assert_eq!(stamps(&terminal), whole);

    // A changed row is stamped alone, and only once it is presented.
    assert!(terminal.apply_delta_seq(&frame(FrameKind::Delta, 1, test_cell('b')), 2));
    assert_eq!(stamps(&terminal), whole);
    terminal.commit_presentation_state();
    let sparse = stamps(&terminal);
    assert!(sparse[1] > whole[1]);
    assert_eq!((sparse[0], sparse[2]), (whole[0], whole[2]));

    // A link is part of what a host shows on the row, though no glyph changed.
    let mut linked = test_cell('b');
    linked.link = 17;
    assert!(terminal.apply_presented_delta_seq(&frame(FrameKind::Delta, 1, linked), 3));
    assert!(stamps(&terminal)[1] > sparse[1]);
    assert_eq!(stamps(&terminal)[0], whole[0]);

    // A grid that lost a row and regained it shows a new row there.
    let before = stamps(&terminal);
    terminal.resize(4, 2);
    terminal.commit_presentation_state();
    assert_eq!(terminal.presentation_row_commit(2), None);
    terminal.resize(4, 3);
    terminal.commit_presentation_state();
    assert!(
        stamps(&terminal)
            .iter()
            .zip(&before)
            .all(|(after, before)| after > before)
    );
}

#[test]
fn a_row_under_a_speculative_echo_says_so_until_the_echo_is_gone() {
    let mut terminal = prediction_terminal(20, 2);
    train_shadow_text(&mut terminal, "a");
    assert!(!terminal.row_holds_prediction(0));
    assert_ne!(terminal.predict_printable('b' as u32, 101.0, 2, true), 0);
    assert!(terminal.row_holds_prediction(0));
    assert!(!terminal.row_holds_prediction(1));
    let revoked = test_cursor_frame(20, 2, 2, 0, CURSOR_SHAPE_HIDDEN, 0);
    assert!(terminal.apply_delta_seq(&revoked, 2));
    assert!(!terminal.row_holds_prediction(0));
}

#[test]
fn presentation_sparse_damage_matches_full_record_rebuilds() {
    let mut terminal = terminal_with_atlas(32, 3);
    let snapshot = test_frame_with_entries(FrameKind::Snapshot, 32, 3, 0, 0, &[]);
    assert!(terminal.apply_presented_state_seq(&snapshot, 1));
    terminal.build_geometry();
    let mut seq = 2;
    // Independent absolute cell writes include wide flags with and without
    // their partner, edges, disjoint held spans, and wrapping metadata.
    for round in 0..96usize {
        let mut changed = test_cell(if round % 2 == 0 { 'a' } else { '界' });
        if round % 3 == 0 {
            changed.attrs |= CellAttrs::WIDE;
        }
        if round % 5 == 0 {
            changed.attrs |= CellAttrs::UNDERLINE;
        }
        let col = u16::try_from(round * 13 % 32).expect("bounded column");
        changed.set_wrapped(col == 31 && round % 7 == 0);
        let row = u16::try_from(round % 3).expect("bounded row");
        let held = test_frame_with_entries(
            FrameKind::Delta,
            32,
            3,
            0,
            0,
            &[RowRef {
                graphics: &[],
                row_index: row,
                left: col,
                cells: &[changed],
            }],
        );
        let before = terminal.cell_buf.clone();
        assert!(
            terminal.apply_delta_seq(&held, seq),
            "{:?}",
            terminal.last_error
        );
        seq += 1;
        terminal.full_damage = true;
        terminal.build_geometry();
        assert_eq!(
            before, terminal.cell_buf,
            "received pixels escaped the hold"
        );
        let mut distant = test_cell('\u{301}');
        distant.link = u32::try_from(round).expect("bounded test round") + 1;
        let other = test_frame_with_entries(
            FrameKind::Delta,
            32,
            3,
            0,
            0,
            &[RowRef {
                graphics: &[],
                row_index: row,
                left: (col + 17) % 32,
                cells: &[distant],
            }],
        );
        assert!(terminal.apply_delta_seq(&other, seq));
        seq += 1;
        terminal.commit_presentation_state();
        terminal.build_geometry();
        let incremental = terminal.cell_buf.clone();
        terminal.full_damage = true;
        terminal.build_geometry();
        assert_eq!(incremental, terminal.cell_buf, "round {round}");
        assert_received_matches_presentation(&terminal);
        // A link-only change advances authority without repainting the row.
        distant.link += 1000;
        let link_only = test_frame_with_entries(
            FrameKind::Delta,
            32,
            3,
            0,
            0,
            &[RowRef {
                graphics: &[],
                row_index: row,
                left: (col + 17) % 32,
                cells: &[distant],
            }],
        );
        assert!(terminal.apply_delta_seq(&link_only, seq));
        seq += 1;
        terminal.commit_presentation_state();
        terminal.build_geometry();
        assert_eq!(incremental, terminal.cell_buf);
        assert_received_matches_presentation(&terminal);
    }
}

fn assert_received_matches_presentation(terminal: &Terminal) {
    assert_eq!(
        terminal.presentation_viewport_rows(),
        terminal.viewport_rows()
    );
    assert_eq!(
        terminal.presentation_viewport_wrap_bits(),
        terminal.viewport_wrap_bits()
    );
    for row in 0..terminal.term.grid().screen_lines() {
        let line = Line(i32::try_from(row).expect("bounded test row"));
        assert_eq!(
            terminal.presentation_grid[line][..],
            terminal.term.grid()[line][..]
        );
    }
    assert_eq!(
        terminal.presentation_cell_links,
        terminal.display_cell_links
    );
}

#[test]
fn presentation_damage_follows_wide_carry_until_it_converges() {
    for cols in 2..18u16 {
        let mut terminal = terminal_with_atlas(cols, 1);
        let mut wide = test_cell('a');
        wide.attrs |= CellAttrs::WIDE;
        let cells = vec![wide; usize::from(cols)];
        let snapshot = test_frame_with_entries(
            FrameKind::Snapshot,
            cols,
            1,
            0,
            0,
            &[RowRef {
                graphics: &[],
                row_index: 0,
                left: 0,
                cells: &cells,
            }],
        );
        let mut sequence = 1;
        for col in 0..cols {
            assert!(terminal.apply_presented_state_seq(&snapshot, sequence));
            sequence += 1;
            terminal.build_geometry();
            let before = terminal.cell_buf.clone();
            let patch = test_frame_with_entries(
                FrameKind::Delta,
                cols,
                1,
                0,
                0,
                &[RowRef {
                    graphics: &[],
                    row_index: 0,
                    left: col,
                    cells: &[test_cell('b')],
                }],
            );
            assert!(terminal.apply_presented_delta_seq(&patch, sequence));
            sequence += 1;
            terminal.build_geometry();
            let incremental = terminal.cell_buf.clone();
            assert_eq!(
                &incremental[..usize::from(col) * CELL_WORDS],
                &before[..usize::from(col) * CELL_WORDS]
            );
            terminal.full_damage = true;
            terminal.build_geometry();
            assert_eq!(incremental, terminal.cell_buf, "wide carry {cols}/{col}");
        }
    }
}

#[test]
fn presentation_damage_unions_commits_and_rejects_older_disjoint_rows() {
    let mut terminal = terminal_with_atlas(32, 2);
    let snapshot = test_frame_with_entries(FrameKind::Snapshot, 32, 2, 0, 0, &[]);
    assert!(terminal.apply_presented_state_seq(&snapshot, 1));
    terminal.build_geometry();
    for (col, character, sequence) in [(0, 'a', 2), (31, 'b', 3), (15, 'X', 2)] {
        let frame = test_frame_with_entries(
            FrameKind::Delta,
            32,
            2,
            0,
            0,
            &[RowRef {
                graphics: &[],
                row_index: 0,
                left: col,
                cells: &[test_cell(character)],
            }],
        );
        assert!(terminal.apply_delta_seq(&frame, sequence));
        terminal.commit_presentation_state();
    }
    terminal.build_geometry();
    assert_eq!(terminal.presentation_grid[Line(0)][Column(0)].c, 'a');
    assert_eq!(terminal.presentation_grid[Line(0)][Column(31)].c, 'b');
    assert_eq!(terminal.presentation_grid[Line(0)][Column(15)].c, ' ');
    let incremental = terminal.cell_buf.clone();
    terminal.full_damage = true;
    terminal.build_geometry();
    assert_eq!(incremental, terminal.cell_buf);
}

#[test]
fn presentation_damage_removes_only_the_replaced_combining_payload() {
    let mut terminal = terminal_with_atlas(8, 1);
    let snapshot = test_frame_with_entries(
        FrameKind::Snapshot,
        8,
        1,
        0,
        0,
        &[RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &[test_cell('a'); 8],
        }],
    );
    assert!(terminal.apply_presented_state_seq(&snapshot, 1));
    for col in [2, 6] {
        terminal.term.grid_mut()[Point::new(Line(0), Column(col))].push_zerowidth('\u{301}');
    }
    terminal.note_damaged_row(0);
    terminal.build_presented_geometry();
    assert!(
        terminal.presentation_grid[Line(0)][Column(2)]
            .extra
            .is_some()
    );
    assert!(
        terminal.presentation_grid[Line(0)][Column(6)]
            .extra
            .is_some()
    );
    let patch = test_frame_with_entries(
        FrameKind::Delta,
        8,
        1,
        0,
        0,
        &[RowRef {
            graphics: &[],
            row_index: 0,
            left: 2,
            cells: &[test_cell('a')],
        }],
    );
    assert!(terminal.apply_presented_delta_seq(&patch, 2));
    terminal.build_geometry();
    assert!(
        terminal.presentation_grid[Line(0)][Column(2)]
            .extra
            .is_none()
    );
    assert!(
        terminal.presentation_grid[Line(0)][Column(6)]
            .extra
            .is_some()
    );
    let incremental = terminal.cell_buf.clone();
    terminal.full_damage = true;
    terminal.build_geometry();
    assert_eq!(incremental, terminal.cell_buf);
}

#[test]
fn presentation_damage_seeds_wide_carry_from_unchanged_prefix() {
    let mut terminal = terminal_with_atlas(16, 1);
    let mut wide = test_cell('a');
    wide.attrs |= CellAttrs::WIDE;
    let mut cells = vec![wide; 16];
    cells[4] = test_cell('a');
    let snapshot = test_frame_with_entries(
        FrameKind::Snapshot,
        16,
        1,
        0,
        0,
        &[RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &cells,
        }],
    );
    assert!(terminal.apply_presented_state_seq(&snapshot, 1));
    terminal.build_geometry();
    let before = terminal.cell_buf.clone();
    for (column, character, sequence) in [(1, 'b', 2), (4, 'a', 3)] {
        let mut cell = test_cell(character);
        cell.attrs |= CellAttrs::WIDE;
        let patch = test_frame_with_entries(
            FrameKind::Delta,
            16,
            1,
            0,
            0,
            &[RowRef {
                graphics: &[],
                row_index: 0,
                left: column,
                cells: &[cell],
            }],
        );
        assert!(terminal.apply_delta_seq(&patch, sequence));
    }
    terminal.commit_presentation_state();
    terminal.build_geometry();
    let incremental = terminal.cell_buf.clone();
    assert_eq!(&incremental[..CELL_WORDS], &before[..CELL_WORDS]);
    terminal.full_damage = true;
    terminal.build_geometry();
    assert_eq!(incremental, terminal.cell_buf);
}

fn projected_damage_terminal() -> Terminal {
    let mut terminal = terminal_with_atlas(20, 2);
    train_shadow_text(&mut terminal, "a");
    assert_ne!(terminal.predict_cursor_shift(-1, 101.0, 2), 0);
    assert_ne!(terminal.predict_printable('x' as u32, 102.0, 3, true), 0);
    assert!(terminal.shadow_requires_row_projection());
    terminal.build_geometry();
    assert!(terminal.shadow_row_projected);
    assert!(terminal.damaged_rows.is_empty());
    terminal
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ProjectionEnd {
    Discard,
    ExpiredStalled,
    ExpiredCovered,
    SealedExpiry,
    RevokedMode,
    AnchorChanged,
    Resize,
    Snapshot,
    ReconcileMatch,
    SealedMatch,
    ReconcileMismatch,
    ReconcileAppendTail,
}

fn end_projected_damage(terminal: &mut Terminal, transition: ProjectionEnd) {
    use ProjectionEnd::*;
    match transition {
        Discard => terminal.predict_discard(),
        ExpiredStalled => terminal.predict_reconcile(1000.0, 500.0, 1, 1),
        ExpiredCovered => terminal.predict_reconcile(1000.0, 500.0, 3, 3),
        SealedExpiry => {
            terminal.predict_seal(4);
            terminal.predict_reconcile(1000.0, 500.0, 1, 1);
        }
        RevokedMode => {
            let revoked = test_cursor_frame(20, 2, 1, 0, CURSOR_SHAPE_HIDDEN, 0);
            assert!(terminal.apply_delta_seq(&revoked, 2));
        }
        AnchorChanged => terminal.set_editor_anchor(1, 1, 0, 1),
        Resize => terminal.resize(21, 2),
        Snapshot => {
            let frame = test_frame_with_entries(FrameKind::Snapshot, 20, 2, 1, 1, &[]);
            assert!(terminal.apply_state_seq(&frame, 2));
        }
        ReconcileMatch | SealedMatch | ReconcileMismatch | ReconcileAppendTail => {
            if transition == ReconcileAppendTail {
                assert_ne!(terminal.predict_cursor_shift(1, 103.0, 4), 0);
                assert_ne!(terminal.predict_printable('b' as u32, 104.0, 5, true), 0);
                terminal.build_geometry();
                assert!(terminal.shadow_row_projected);
            }
            if transition == SealedMatch {
                terminal.predict_seal(4);
            }
            let cells = if transition == ReconcileMismatch {
                [test_cell('q'), test_cell('a')]
            } else {
                [test_cell('x'), test_cell('a')]
            };
            let echo = test_frame_with_entries(
                FrameKind::Delta,
                20,
                2,
                1,
                0,
                &[RowRef {
                    graphics: &[],
                    row_index: 0,
                    left: 0,
                    cells: &cells,
                }],
            );
            assert!(terminal.apply_delta_seq(&echo, 2));
            terminal.commit_presentation_state();
            let covered = if transition == ReconcileAppendTail {
                3
            } else {
                4
            };
            terminal.predict_reconcile(110.0, 500.0, covered, covered);
            terminal.predict_reconcile(
                110.0 + PREDICTION_MISMATCH_GRACE_MS,
                500.0,
                covered,
                covered,
            );
        }
    }
}

#[test]
fn presentation_damage_clears_old_projection_before_sparse_authority() {
    use ProjectionEnd::*;
    for transition in [
        Discard,
        ExpiredStalled,
        ExpiredCovered,
        SealedExpiry,
        RevokedMode,
        AnchorChanged,
        Resize,
        Snapshot,
        ReconcileMatch,
        SealedMatch,
        ReconcileMismatch,
        ReconcileAppendTail,
    ] {
        let mut terminal = projected_damage_terminal();
        end_projected_damage(&mut terminal, transition);
        assert!(!terminal.shadow_requires_row_projection(), "{transition:?}");
        // Nothing is built between ending the projection and a distant one-cell
        // authority commit. Its sparse span cannot erase the old projection.
        let frame = test_frame_with_entries(
            FrameKind::Delta,
            terminal.cols(),
            terminal.rows(),
            1,
            0,
            &[RowRef {
                graphics: &[],
                row_index: 0,
                left: 15,
                cells: &[test_cell('z')],
            }],
        );
        assert!(terminal.apply_delta_seq(&frame, 3));
        terminal.commit_presentation_state();
        terminal.build_geometry();
        assert!(!terminal.shadow_row_projected, "{transition:?}");
        let incremental = terminal.cell_buf.clone();
        terminal.full_damage = true;
        terminal.build_geometry();
        assert_eq!(incremental, terminal.cell_buf, "{transition:?}");
        assert_received_matches_presentation(&terminal);
    }
}

#[test]
fn presentation_benchmark_wide_chain_carries_single_cell_damage_to_row_end() {
    for cols in [80, 240, 512] {
        let (snapshot, frames) = damage_benchmark_frames(cols, ("widechain", cols, 1, 0));
        let mut terminal = terminal_with_atlas(cols, 40);
        assert!(terminal.apply_presented_state_seq(&snapshot, 1));
        assert!(terminal.apply_presented_delta_seq(&frames[0][0], 2));
        terminal.build_geometry();
        // The wire row is dense; only the first cell differs canonically.
        assert!(terminal.apply_delta_seq(&frames[1][0], 3));
        assert_eq!(terminal.presentation_dirty_cells[0], Some((0, 0)));
        terminal.commit_presentation_state();
        assert_eq!(terminal.damaged_cells[0], Some((0, 0)));
        assert_eq!(
            close_cell_damage(
                &terminal.presentation_grid[Line(0)][..],
                0,
                0,
                &terminal.cell_buf[..usize::from(cols) * CELL_WORDS],
            ),
            usize::from(cols) - 1,
        );
        terminal.build_geometry();
        let incremental = terminal.cell_buf.clone();
        terminal.full_damage = true;
        terminal.build_geometry();
        assert_eq!(incremental, terminal.cell_buf);
    }
}
