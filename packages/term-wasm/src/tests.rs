use merkur_codec::CellAttrs;
include!("presentation_tests.rs");
#[cfg(not(target_arch = "wasm32"))]
mod geometry_allocations {
    use std::alloc::{GlobalAlloc, Layout, System};
    use std::cell::Cell;

    thread_local! {
        static ENABLED: Cell<bool> = const { Cell::new(false) };
        static COUNT: Cell<usize> = const { Cell::new(0) };
    }
    struct CountingAllocator;
    #[global_allocator]
    static ALLOCATOR: CountingAllocator = CountingAllocator;

    fn record() {
        let _ = ENABLED.try_with(|enabled| {
            if enabled.get() {
                let _ = COUNT.try_with(|count| count.set(count.get() + 1));
            }
        });
    }

    // SAFETY: test-only delegation preserves System's allocation layout and
    // ownership: every method hands its arguments unchanged to `System`.
    // `record` reads and bumps const thread-local `Cell`s through `try_with`,
    // so it never allocates.
    unsafe impl GlobalAlloc for CountingAllocator {
        unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
            record();
            // SAFETY: the caller's `layout` reaches `System` unchanged, so the
            // caller's obligations are exactly `System`'s.
            unsafe { System.alloc(layout) }
        }
        unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
            record();
            // SAFETY: the caller's `layout` reaches `System` unchanged, so the
            // caller's obligations are exactly `System`'s.
            unsafe { System.alloc_zeroed(layout) }
        }
        unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
            // SAFETY: every block this allocator hands out is `System`'s, so
            // `ptr` and `layout` name a block `System` allocated.
            unsafe { System.dealloc(ptr, layout) }
        }
        unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, size: usize) -> *mut u8 {
            record();
            // SAFETY: `ptr` and `layout` name a block `System` allocated, and
            // the caller's new size reaches it unchanged.
            unsafe { System.realloc(ptr, layout, size) }
        }
    }

    pub fn count(run: impl FnOnce()) -> usize {
        struct Reset;
        impl Drop for Reset {
            fn drop(&mut self) {
                ENABLED.set(false);
            }
        }
        COUNT.set(0);
        ENABLED.set(true);
        let reset = Reset;
        run();
        drop(reset);
        COUNT.get()
    }
}

use super::*;
use merkur_codec::{
    DISPLAY_GENERATION_OFFSET, DISPLAY_HEADER_BODY_LENGTH_OFFSET,
    DISPLAY_HEADER_FLAG_FEC_PROTECTED, DISPLAY_MSG_TYPE_OFFSET, DISPLAY_SEQ_OFFSET, FrameHeader,
    FrameKind, RowRef, STREAM_HEADER_BYTES, encode_frame_into,
};

// Existing semantic/geometry fixtures model already-eligible transactions.
// Receive-only isolation tests below deliberately use the real apply APIs.
impl Terminal {
    fn apply_presented_state_seq(&mut self, data: &[u8], seq: u32) -> bool {
        let applied = self.apply_state_seq(data, seq);
        if applied {
            self.commit_presentation_state();
        }
        applied
    }

    fn apply_presented_delta_seq(&mut self, data: &[u8], seq: u32) -> bool {
        let applied = self.apply_delta_seq(data, seq);
        if applied {
            self.commit_presentation_state();
        }
        applied
    }

    fn apply_presented_staged_state_seq(&mut self, handle: u32, seq: u32) -> bool {
        let applied = self.apply_staged_state_seq(handle, seq);
        if applied {
            self.commit_presentation_state();
        }
        applied
    }

    fn apply_presented_staged_delta_seq(&mut self, handle: u32, seq: u32) -> bool {
        let applied = self.apply_staged_delta_seq(handle, seq);
        if applied {
            self.commit_presentation_state();
        }
        applied
    }

    fn set_presented_editor_anchor(&mut self, generation: u32, row: u16, col: u16, flags: u32) {
        self.set_editor_anchor(generation, row, col, flags);
        self.commit_presentation_state();
    }

    fn build_presented_geometry(&mut self) {
        // Some geometry fixtures mutate the received cells directly rather
        // than encoding a frame; carry their explicit damage into eligibility.
        for row in self.damaged_rows.iter().copied() {
            let index = usize::from(row);
            if self.presentation_dirty_set[index] == 0 {
                self.presentation_dirty_rows.push(row);
            }
            self.presentation_dirty_set[index] = 2;
        }
        self.presentation_full_pending |= self.full_damage;
        let received = self.term.renderable_content();
        self.presentation_header_pending |= received.cursor.point
            != self.presentation_grid.cursor.point
            || received.cursor.shape != self.presentation_cursor_shape;
        self.commit_presentation_state();
        self.build_geometry();
    }
}

#[test]
fn explicit_default_background_is_ordered_hashed_and_presented() {
    let mut terminal = terminal_with_atlas(4, 1);
    let implicit = test_cell(' ');
    let explicit = CellRepr {
        attrs: CellAttrs::EXPLICIT_DEFAULT_BG,
        ..implicit
    };
    let mut cells = [implicit; 4];
    let initial = test_frame(
        FrameKind::Snapshot,
        4,
        RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &cells,
        },
    );
    assert!(terminal.apply_presented_state_seq(&initial, 1));
    terminal.build_geometry();
    assert_eq!(terminal.bg_count(), 0);
    let initial_hash = terminal.row_hash(0);
    cells[1..3].fill(explicit);
    let painted = test_frame(
        FrameKind::Delta,
        4,
        RowRef {
            graphics: &[],
            row_index: 0,
            left: 1,
            cells: &cells[1..3],
        },
    );
    assert!(terminal.apply_delta_seq(&painted, 3));
    assert!(terminal.last_apply_visually_changed());
    assert_ne!(terminal.row_hash(0), initial_hash);
    assert_eq!(terminal.row_hash(0), merkur_codec::row_hash(&cells));
    let point = Point::new(Line(0), Column(1));
    assert!(CellRepr::from_alacritty(&terminal.term.grid()[point]).has_explicit_background());
    assert!(
        !CellRepr::from_alacritty(&terminal.presentation_grid[point]).has_explicit_background()
    );
    terminal.build_geometry();
    assert_eq!(terminal.bg_count(), 0);
    terminal.commit_presentation_state();
    assert!(CellRepr::from_alacritty(&terminal.presentation_grid[point]).has_explicit_background());
    terminal.build_geometry();
    assert_eq!(
        terminal.bg_count(),
        1,
        "explicit equal-RGB paint needs a background span"
    );
    let cleared = test_frame(
        FrameKind::Delta,
        4,
        RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &[implicit; 4],
        },
    );
    assert!(terminal.apply_delta_seq(&cleared, 2));
    assert!(!terminal.last_apply_visually_changed());
    assert_eq!(terminal.row_hash(0), merkur_codec::row_hash(&cells));
    assert!(terminal.apply_presented_delta_seq(&cleared, 4));
    assert!(terminal.last_apply_visually_changed());
    assert_eq!(terminal.row_hash(0), initial_hash);
    assert!(
        !CellRepr::from_alacritty(&terminal.presentation_grid[point]).has_explicit_background()
    );
    terminal.build_geometry();
    assert_eq!(terminal.bg_count(), 0);
    let inverse = [CellRepr {
        fg: DEFAULT_BACKGROUND,
        attrs: CellAttrs::INVERSE,
        ..implicit
    }; 4];
    let reversed = test_frame(
        FrameKind::Delta,
        4,
        RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &inverse,
        },
    );
    assert!(terminal.apply_presented_delta_seq(&reversed, 5));
    terminal.build_geometry();
    assert_eq!(
        terminal.bg_count(),
        1,
        "inverse paint cannot disappear on RGB equality"
    );
}

#[test]
fn display_receiver_calibration_terminal_is_headless_and_isolated() {
    let terminal = init_display_receiver_calibration(120, 29);
    assert_eq!(terminal.cols(), 120);
    assert_eq!(terminal.rows(), 29);
    assert!(terminal.atlas.is_none());
    assert!(
        terminal
            .display_dictionaries
            .iter()
            .all(|slot| slot.bytes.is_empty())
    );
    assert!(!terminal.has_predictions());
}

// Pinned against `computeTerminalGrid` in `packages/shared/src/terminal.ts`.
// Both suites carry this same table because nothing at runtime detects
// drift between the two implementations of the rule.
#[test]
fn terminal_grid_matches_the_shared_typescript_vectors() {
    assert_eq!(
        terminal_grid_from_css_cells(960.0, 640.0, 8.0, 16.0),
        (120, 40)
    );
    assert_eq!(
        terminal_grid_from_css_cells(967.0, 640.0, 8.0, 16.0),
        (120, 40)
    );
    assert_eq!(
        terminal_grid_from_css_cells(960.0, 647.0, 8.0, 16.0),
        (120, 40)
    );
    assert_eq!(
        terminal_grid_from_css_cells(960.0, 649.0, 8.0, 16.0),
        (120, 40)
    );
    assert_eq!(
        terminal_grid_from_css_cells(100_000.0, 100_000.0, 8.0, 16.0),
        (512, 192)
    );
    assert_eq!(terminal_grid_from_css_cells(0.0, 0.0, 8.0, 16.0), (1, 1));
    assert_eq!(terminal_grid_from_css_cells(960.0, 640.0, 0.0, 0.0), (1, 1));
}

#[test]
fn terminal_grid_never_exceeds_the_viewport_that_measured_it() {
    for height in 200..=260 {
        for width in 400..=420 {
            let (cols, rows) =
                terminal_grid_from_css_cells(width as f32, height as f32, 8.5, 17.25);
            assert!(f32::from(cols) * 8.5 <= width as f32);
            assert!(f32::from(rows) * 17.25 <= height as f32);
        }
    }
}

fn test_cell(c: char) -> CellRepr {
    CellRepr {
        codepoint: c as u32,
        fg: DEFAULT_FOREGROUND,
        bg: DEFAULT_BACKGROUND,
        attrs: CellAttrs::NONE,
        link: 0,
    }
}

fn test_frame(kind: FrameKind, cols: u16, row: RowRef<'_>) -> Vec<u8> {
    test_frame_with_rows(kind, cols, 1, row)
}

fn test_frame_with_rows(kind: FrameKind, cols: u16, rows: u16, row: RowRef<'_>) -> Vec<u8> {
    test_frame_with_row_refs(kind, cols, rows, &[row])
}

fn test_frame_with_row_refs<'a>(
    kind: FrameKind,
    cols: u16,
    rows: u16,
    row_refs: &[RowRef<'a>],
) -> Vec<u8> {
    test_frame_with_entries(kind, cols, rows, 0, 0, row_refs)
}

fn test_frame_with_entries<'a>(
    kind: FrameKind,
    cols: u16,
    rows: u16,
    cursor_col: u16,
    cursor_row: u16,
    entries: &[RowRef<'a>],
) -> Vec<u8> {
    test_frame_chunk_with_entries(kind, cols, rows, cursor_col, cursor_row, 0, 0, 1, entries)
}

fn test_frame_chunk_with_entries<'a>(
    kind: FrameKind,
    cols: u16,
    rows: u16,
    cursor_col: u16,
    cursor_row: u16,
    frame_id: u32,
    chunk_index: u16,
    chunk_count: u16,
    entries: &[RowRef<'a>],
) -> Vec<u8> {
    let header = FrameHeader {
        memory_only: false,
        kind,
        cols,
        rows,
        cursor_col,
        cursor_row,
        cursor_shape: CURSOR_SHAPE_BLOCK,
        cursor_visible: 1,
        mode_flags: DISPLAY_MODE_PREDICTION_SAFE as u16,
        row_count: u16::try_from(entries.len()).expect("test row count"),
        frame_id,
        presentation_id: 0,
        presentation_member_index: 0,
        presentation_member_count: 0,
        row_predecessor_presentation_id: 0,
        presentation_coherent: false,
        presentation_end: false,
        chunk_index,
        chunk_count,
        demand_serial: 0,
        demand_limited: false,
        demand_prompt: false,
        demand_awaits_grant: false,
        closure_digest: 0,
        scroll_serial: 0,
        echo_horizon: 0,
    };
    let mut out = Vec::new();
    encode_frame_into(&mut out, &header, entries.iter().copied());
    out[DISPLAY_MSG_TYPE_OFFSET] = MSG_TYPE_DISPLAY_PATCH;
    out[DISPLAY_GENERATION_OFFSET..DISPLAY_GENERATION_OFFSET + 4]
        .copy_from_slice(&1u32.to_be_bytes());
    let seq = if matches!(kind, FrameKind::Snapshot) {
        0u32
    } else {
        1u32
    };
    out[DISPLAY_SEQ_OFFSET..DISPLAY_SEQ_OFFSET + 4].copy_from_slice(&seq.to_be_bytes());
    let body_len = u32::try_from(out.len() - STREAM_HEADER_BYTES).unwrap();
    out[DISPLAY_HEADER_BODY_LENGTH_OFFSET..DISPLAY_HEADER_BODY_LENGTH_OFFSET + 4]
        .copy_from_slice(&body_len.to_be_bytes());
    out
}

/// Build a row-entry frame from a `(row, fill)` list.
///
/// Callers give every row a DIFFERENT fill on purpose: a fixture where all
/// rows carry the same bytes hides any bug that copies the wrong row or
/// fails to notice a row moved, because every hash is already equal.
fn text_rows_frame(kind: FrameKind, cols: u16, rows: u16, fill: &[(u16, char)]) -> Vec<u8> {
    let cells: Vec<Vec<CellRepr>> = fill
        .iter()
        .map(|(_, c)| (0..cols).map(|_| test_cell(*c)).collect())
        .collect();
    let entries: Vec<RowRef<'_>> = fill
        .iter()
        .zip(cells.iter())
        .map(|((row, _), cells)| RowRef {
            graphics: &[],
            row_index: *row,
            left: 0,
            cells,
        })
        .collect();
    test_frame_chunk_with_entries(kind, cols, rows, 0, 0, 1, 0, 1, &entries)
}

/// One distinct fill per row, so every row hash differs from every other.
fn distinct_rows(rows: u16) -> Vec<(u16, char)> {
    (0..rows)
        .map(|row| (row, char::from(b'a' + (row % 26) as u8)))
        .collect()
}

/// Every row of the live vector equals the direct per-row hash.
fn assert_row_hashes_match_oracle(terminal: &mut Terminal, context: &str) {
    let _ = terminal.refresh_row_hashes();
    let rows = terminal.rows();
    assert_eq!(terminal.row_hashes_len(), rows, "{context}: vector length");
    let live: Vec<u64> = terminal.row_hashes.clone();
    for row in 0..rows {
        assert_eq!(
            live[usize::from(row)],
            terminal.row_hash(row),
            "{context}: row {row}"
        );
    }
}

/// Guard the fixtures themselves: if rows ever stop being distinguishable,
/// the oracle assertions above go quiet without failing.
#[test]
fn linked_rows_hash_like_the_daemon_and_a_link_only_change_dirties_the_hash() {
    const COLS: u16 = 8;
    const ROWS: u16 = 2;
    let mut terminal = Terminal::new(COLS, ROWS);
    let mut cells: Vec<CellRepr> = "link x".chars().map(test_cell).collect();
    cells.resize(usize::from(COLS), test_cell(' '));
    for cell in &mut cells[0..4] {
        cell.link = 41;
    }
    let snapshot = test_frame_with_rows(
        FrameKind::Snapshot,
        COLS,
        ROWS,
        RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &cells,
        },
    );
    assert!(terminal.apply_presented_state_seq(&snapshot, 1));
    let _ = terminal.refresh_row_hashes();
    assert_eq!(terminal.row_hashes[0], merkur_codec::row_hash(&cells));
    assert_eq!(&terminal.viewport_links()[..5], &[41, 41, 41, 41, 0]);

    // Same glyphs, different link: no damage, but the hash must follow.
    for cell in &mut cells[0..4] {
        cell.link = 42;
    }
    let delta = test_frame_with_rows(
        FrameKind::Delta,
        COLS,
        ROWS,
        RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &cells,
        },
    );
    assert!(terminal.apply_presented_delta_seq(&delta, 2));
    let _ = terminal.refresh_row_hashes();
    assert_eq!(terminal.row_hashes[0], merkur_codec::row_hash(&cells));
    assert_row_hashes_match_oracle(&mut terminal, "link-only change");
}

#[test]
fn viewport_text_columns_map_code_units_past_wide_and_astral_characters() {
    let mut terminal = Terminal::new(6, 1);
    let mut cells = vec![
        test_cell('界'),
        test_cell(' '),
        test_cell('😀'),
        test_cell('a'),
    ];
    cells[0].attrs |= CellAttrs::WIDE;
    cells.resize(6, test_cell(' '));
    let snapshot = test_frame_with_rows(
        FrameKind::Snapshot,
        6,
        1,
        RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &cells,
        },
    );
    assert!(terminal.apply_presented_state_seq(&snapshot, 1));
    let text = terminal.viewport_rows();
    let columns = terminal.viewport_text_columns();
    assert_eq!(text.encode_utf16().count(), columns.len());
    assert_eq!(&columns[..4], &[0, 2, 2, 3]);
}

#[test]
fn the_row_hash_fixture_gives_every_row_a_distinct_hash() {
    const COLS: u16 = 16;
    const ROWS: u16 = 8;
    let mut terminal = Terminal::new(COLS, ROWS);
    let snapshot = text_rows_frame(FrameKind::Snapshot, COLS, ROWS, &distinct_rows(ROWS));
    assert!(terminal.apply_presented_state_seq(&snapshot, 1));
    let _ = terminal.refresh_row_hashes();
    let mut seen: Vec<u64> = terminal.row_hashes.clone();
    seen.sort_unstable();
    seen.dedup();
    assert_eq!(seen.len(), usize::from(ROWS));
}

/// The live vector is what the resume claim and the digest comparison read,
/// so it has to agree with the direct hash after every kind of grid
/// mutation — otherwise the browser asserts a screen it does not have.
#[test]
fn incremental_row_hashes_track_every_grid_mutation() {
    const COLS: u16 = 16;
    const ROWS: u16 = 8;
    let mut terminal = Terminal::new(COLS, ROWS);
    assert_row_hashes_match_oracle(&mut terminal, "fresh");

    let snapshot = text_rows_frame(FrameKind::Snapshot, COLS, ROWS, &distinct_rows(ROWS));
    assert!(terminal.apply_presented_state_seq(&snapshot, 1));
    assert_row_hashes_match_oracle(&mut terminal, "snapshot");

    let delta = text_rows_frame(FrameKind::Delta, COLS, ROWS, &[(2, 'X'), (5, 'Y')]);
    assert!(terminal.apply_presented_delta_seq(&delta, 2));
    assert_row_hashes_match_oracle(&mut terminal, "delta");

    // A second delta touching one already-dirty row and one clean row.
    let delta = text_rows_frame(FrameKind::Delta, COLS, ROWS, &[(2, 'Z'), (7, 'W')]);
    assert!(terminal.apply_presented_delta_seq(&delta, 3));
    assert_row_hashes_match_oracle(&mut terminal, "second delta");

    // Columns only: the row count is unchanged, so the vector length check
    // inside the refresh cannot be what rebuilds this one.
    terminal.resize(COLS + 4, ROWS);
    assert_row_hashes_match_oracle(&mut terminal, "resize columns only");

    terminal.resize(COLS + 4, ROWS + 2);
    assert_row_hashes_match_oracle(&mut terminal, "resize rows");

    let snapshot = text_rows_frame(
        FrameKind::Snapshot,
        COLS + 4,
        ROWS + 2,
        &distinct_rows(ROWS + 2),
    );
    assert!(terminal.apply_presented_state_seq(&snapshot, 4));
    assert_row_hashes_match_oracle(&mut terminal, "snapshot after resize");
}

/// Two frames in one drain must hash the row they share exactly once, and
/// still leave it correct. This is the property that makes per-drain
/// refreshing cheaper than the per-heartbeat full-grid pass it replaces.
#[test]
fn one_refresh_covers_every_frame_of_a_drain() {
    const COLS: u16 = 16;
    const ROWS: u16 = 8;
    let mut terminal = Terminal::new(COLS, ROWS);
    let snapshot = text_rows_frame(FrameKind::Snapshot, COLS, ROWS, &distinct_rows(ROWS));
    assert!(terminal.apply_presented_state_seq(&snapshot, 1));
    let _ = terminal.refresh_row_hashes();

    for (index, fill) in ['X', 'Y', 'Z'].into_iter().enumerate() {
        let delta = text_rows_frame(FrameKind::Delta, COLS, ROWS, &[(3, fill)]);
        assert!(terminal.apply_presented_delta_seq(&delta, 2 + index as u32));
    }
    // One row was touched three times; the dirty list must hold it once.
    assert_eq!(terminal.row_hash_dirty_list, vec![3]);

    assert_row_hashes_match_oracle(&mut terminal, "coalesced drain");
}

/// All rows validate before any authoritative state is mutated.
#[test]
fn a_rejected_frame_leaves_grid_versions_damage_and_revision_unchanged() {
    const COLS: u16 = 16;
    const ROWS: u16 = 8;
    let mut terminal = Terminal::new(COLS, ROWS);
    let snapshot = text_rows_frame(FrameKind::Snapshot, COLS, ROWS, &distinct_rows(ROWS));
    assert!(terminal.apply_presented_state_seq(&snapshot, 1));
    assert_row_hashes_match_oracle(&mut terminal, "before");
    let before_hashes: Vec<u64> = (0..ROWS).map(|row| terminal.row_hash(row)).collect();
    let before_row_versions = terminal.display_row_versions.clone();
    let before_cell_versions = terminal.display_cell_versions.clone();
    let before_cell_revisions = terminal.authoritative_cell_revisions.clone();
    let before_revision = terminal.authoritative_revision;
    let before_damaged_rows = terminal.damaged_rows.clone();
    let before_full_damage = terminal.full_damage;

    // The last row is out of range, after two valid row payloads.
    let frame = text_rows_frame(
        FrameKind::Delta,
        COLS,
        ROWS,
        &[(0, 'X'), (1, 'Y'), (ROWS, 'Z')],
    );
    assert!(!terminal.apply_presented_delta_seq(&frame, 2));

    // A false result hands control to browser resynchronization. It must not
    // expose a partially applied authoritative state to prediction, resize,
    // font refresh, or any other render trigger while the snapshot is in
    // flight.
    assert_row_hashes_match_oracle(&mut terminal, "after rejection");
    let after_hashes: Vec<u64> = (0..ROWS).map(|row| terminal.row_hash(row)).collect();
    assert_eq!(after_hashes, before_hashes);
    assert_eq!(terminal.display_row_versions, before_row_versions);
    assert_eq!(terminal.display_cell_versions, before_cell_versions);
    assert_eq!(terminal.authoritative_cell_revisions, before_cell_revisions);
    assert_eq!(terminal.authoritative_revision, before_revision);
    assert_eq!(terminal.damaged_rows, before_damaged_rows);
    assert_eq!(terminal.full_damage, before_full_damage);
}

/// Predictions are a shadow overlay, never the grid. If they reached the
/// grid the browser's hashes would stop being comparable with the daemon's
/// and every keystroke would look like divergence.
#[test]
fn predictions_do_not_move_the_row_hashes() {
    const COLS: u16 = 16;
    const ROWS: u16 = 8;
    let mut terminal = Terminal::new(COLS, ROWS);
    let snapshot = text_rows_frame(FrameKind::Snapshot, COLS, ROWS, &distinct_rows(ROWS));
    assert!(terminal.apply_presented_state_seq(&snapshot, 1));
    let _ = terminal.refresh_row_hashes();
    let before = terminal.row_hashes.clone();

    terminal.predict_printable(u32::from(b'z'), 0.0, 1, true);
    let _ = terminal.refresh_row_hashes();

    assert_eq!(terminal.row_hashes, before);
}

fn test_cursor_frame(
    cols: u16,
    rows: u16,
    cursor_col: u16,
    cursor_row: u16,
    cursor_shape: u8,
    cursor_visible: u8,
) -> Vec<u8> {
    let header = FrameHeader {
        memory_only: false,
        kind: FrameKind::Delta,
        cols,
        rows,
        cursor_col,
        cursor_row,
        cursor_shape,
        cursor_visible,
        mode_flags: DISPLAY_MODE_PREDICTION_SAFE as u16,
        row_count: 0,
        frame_id: 0,
        presentation_id: 0,
        presentation_member_index: 0,
        presentation_member_count: 0,
        row_predecessor_presentation_id: 0,
        presentation_coherent: false,
        presentation_end: false,
        chunk_index: 0,
        chunk_count: 1,
        demand_serial: 0,
        demand_limited: false,
        demand_prompt: false,
        demand_awaits_grant: false,
        closure_digest: 0,
        scroll_serial: 0,
        echo_horizon: 0,
    };
    let mut out = Vec::new();
    encode_frame_into(&mut out, &header, std::iter::empty());
    out
}

fn terminal_with_atlas(cols: u16, rows: u16) -> Terminal {
    let regular = include_bytes!("../../../apps/web/public/fonts/JetBrainsMonoNF-Regular.ttf");
    let bold = include_bytes!("../../../apps/web/public/fonts/JetBrainsMonoNF-Bold.ttf");
    let italic = include_bytes!("../../../apps/web/public/fonts/JetBrainsMonoNF-Italic.ttf");
    let bold_italic =
        include_bytes!("../../../apps/web/public/fonts/JetBrainsMonoNF-BoldItalic.ttf");
    let mut atlas = atlas::GlyphAtlas::new(load_fonts(regular, bold, italic, bold_italic));
    apply_cell_metrics_to_atlas(&mut atlas, 14.0, 1.2);
    let mut terminal = Terminal::new_with_atlas(cols, rows, atlas, 1.0);
    terminal.display_mode = DISPLAY_MODE_PREDICTION_SAFE;
    terminal
}

/// The per-buffer reads the packed `geometry_state` replaced, kept only as the
/// oracle it is checked against: each reads one field the direct way.
impl Terminal {
    fn bg_ptr(&self) -> *const f32 {
        self.bg_buf.as_ptr()
    }
    fn bg_count(&self) -> u32 {
        (self.bg_buf.len() / 7) as u32
    }
    fn bg_version(&self) -> u32 {
        self.bg_version
    }
    fn bg_dirty_offset(&self) -> u32 {
        self.bg_dirty.0
    }
    fn bg_dirty_count(&self) -> u32 {
        self.bg_dirty.1
    }
    fn glyph_ptr(&self) -> *const f32 {
        self.glyph_buf.as_ptr()
    }
    fn glyph_count(&self) -> u32 {
        (self.glyph_buf.len() / 14) as u32
    }
    fn glyph_version(&self) -> u32 {
        self.glyph_version
    }
    fn glyph_dirty_offset(&self) -> u32 {
        self.glyph_dirty.0
    }
    fn glyph_dirty_count(&self) -> u32 {
        self.glyph_dirty.1
    }
    fn deco_ptr(&self) -> *const f32 {
        self.deco_buf.as_ptr()
    }
    fn deco_count(&self) -> u32 {
        (self.deco_buf.len() / 7) as u32
    }
    fn deco_version(&self) -> u32 {
        self.deco_version
    }
    fn deco_dirty_offset(&self) -> u32 {
        self.deco_dirty.0
    }
    fn deco_dirty_count(&self) -> u32 {
        self.deco_dirty.1
    }
    fn cursor_ptr(&self) -> *const f32 {
        self.cursor_buf.as_ptr()
    }
    fn cursor_count(&self) -> u32 {
        (self.cursor_buf.len() / 8) as u32
    }
    fn cursor_version(&self) -> u32 {
        self.cursor_version
    }
    fn cursor_dirty_offset(&self) -> u32 {
        self.cursor_dirty.0
    }
    fn cursor_dirty_count(&self) -> u32 {
        self.cursor_dirty.1
    }
}

fn legacy_geometry_state(terminal: &Terminal) -> [u32; GEOMETRY_STATE_LEN] {
    [
        terminal.bg_ptr() as usize as u32,
        terminal.bg_count(),
        terminal.bg_version(),
        terminal.bg_dirty_offset(),
        terminal.bg_dirty_count(),
        terminal.glyph_ptr() as usize as u32,
        terminal.glyph_count(),
        terminal.glyph_version(),
        terminal.glyph_dirty_offset(),
        terminal.glyph_dirty_count(),
        terminal.deco_ptr() as usize as u32,
        terminal.deco_count(),
        terminal.deco_version(),
        terminal.deco_dirty_offset(),
        terminal.deco_dirty_count(),
        terminal.cursor_ptr() as usize as u32,
        terminal.cursor_count(),
        terminal.cursor_version(),
        terminal.cursor_dirty_offset(),
        terminal.cursor_dirty_count(),
        terminal
            .graphics
            .as_ref()
            .map_or(0, graphics::GraphicsRows::revision),
    ]
}

fn assert_packed_geometry_state_matches_legacy(terminal: &Terminal) {
    assert_eq!(terminal.geometry_state_len(), GEOMETRY_STATE_LEN);
    // SAFETY: the pointer and the length are `as_ptr()` and `len()` of the
    // terminal's own `geometry_state`, which `terminal` keeps alive and
    // unchanged while this shared borrow of it lasts.
    let packed = unsafe {
        std::slice::from_raw_parts(terminal.geometry_state_ptr(), terminal.geometry_state_len())
    };
    assert_eq!(packed, legacy_geometry_state(terminal));
}

#[test]
fn packed_geometry_state_matches_legacy_across_render_lifecycle() {
    let uninitialized = Terminal::new(8, 2);
    assert_packed_geometry_state_matches_legacy(&uninitialized);

    let mut terminal = terminal_with_atlas(8, 2);
    let packed_ptr = terminal.geometry_state_ptr();
    assert_packed_geometry_state_matches_legacy(&terminal);

    terminal.build_presented_geometry();
    assert_eq!(terminal.geometry_state_ptr(), packed_ptr);
    assert_packed_geometry_state_matches_legacy(&terminal);

    // Change all three row-buffer cardinalities in one dirty-row rebuild.
    let mut decorated = test_cell('x');
    decorated.bg = [1, 2, 3];
    decorated.attrs |= CellAttrs::UNDERLINE;
    write_cell(
        &mut terminal.term.grid_mut()[Point::new(Line(0), Column(0))],
        decorated,
    );
    terminal.note_damaged_row(0);
    terminal.build_presented_geometry();
    assert!(terminal.bg_count() > 0);
    assert!(terminal.glyph_count() > 0);
    assert!(terminal.deco_count() > 0);
    assert_packed_geometry_state_matches_legacy(&terminal);

    // A no-damage build takes the early return and must leave a coherent,
    // stable snapshot rather than publishing partially reset dirty ranges.
    let no_damage_state = terminal.geometry_state;
    terminal.build_presented_geometry();
    assert_eq!(terminal.geometry_state, no_damage_state);
    assert_packed_geometry_state_matches_legacy(&terminal);

    let cursor_frame = test_cursor_frame(8, 2, 2, 1, CURSOR_SHAPE_BEAM, 1);
    assert!(terminal.apply_presented_delta_seq(&cursor_frame, 1));
    terminal.build_presented_geometry();
    assert_eq!(terminal.cursor_count(), 1);
    assert_packed_geometry_state_matches_legacy(&terminal);

    terminal.resize(12, 3);
    terminal.build_presented_geometry();
    assert_eq!((terminal.cols(), terminal.rows()), (12, 3));
    assert_eq!(terminal.geometry_state_ptr(), packed_ptr);
    assert_packed_geometry_state_matches_legacy(&terminal);

    let mut predicted = terminal_with_atlas(8, 1);
    train_shadow_text(&mut predicted, "a");
    assert_ne!(predicted.predict_printable('x' as u32, 101.0, 2, true), 0);
    predicted.build_presented_geometry();
    assert_packed_geometry_state_matches_legacy(&predicted);

    predicted.set_preedit("xy", 2);
    predicted.build_presented_geometry();
    assert_packed_geometry_state_matches_legacy(&predicted);
}

#[test]
fn packed_geometry_state_is_published_after_atlas_growth_retry() {
    let mut terminal = terminal_with_atlas(1, 1);
    write_cell(
        &mut terminal.term.grid_mut()[Point::new(Line(0), Column(0))],
        test_cell('x'),
    );
    terminal
        .atlas
        .as_mut()
        .expect("atlas")
        .force_next_pack_to_grow();
    let generation = terminal.atlas_generation();

    terminal.build_presented_geometry();

    assert_eq!(terminal.atlas_generation(), generation + 1);
    assert_eq!(terminal.geometry_atlas_generation, generation + 1);
    assert_eq!(terminal.glyph_count(), 1);
    assert_packed_geometry_state_matches_legacy(&terminal);
}

/// Build a real zstd dictionary whose identity is derived from `seed`.
///
/// The decode path selects a dictionary by the id zstd stamped into it, so
/// tests cannot use arbitrary byte strings the way the LZ4 path allowed —
/// an unparseable dictionary is now refused at install.
fn test_dictionary(seed: &str) -> Vec<u8> {
    let mut data = Vec::new();
    let mut sizes = Vec::new();
    for index in 0..96 {
        let sample = format!("{seed} row {index:03} terminal rows shell output prompt state ");
        let sample = sample.repeat(3);
        sizes.push(sample.len());
        data.extend_from_slice(sample.as_bytes());
    }
    zstd::dict::from_continuous(&data, &sizes, 4096).expect("test dictionary")
}

/// A compressor writing the display payload's zstd frame, as the daemon's
/// does: level 3, magicless, no frame content size.
fn display_test_compressor(dictionary: Option<&[u8]>) -> zstd::bulk::Compressor<'static> {
    use zstd::zstd_safe::{CParameter, FrameFormat};
    let mut compressor = zstd::bulk::Compressor::new(3).expect("compressor");
    compressor
        .set_parameter(CParameter::Format(FrameFormat::Magicless))
        .unwrap();
    compressor
        .set_parameter(CParameter::ContentSizeFlag(false))
        .unwrap();
    if let Some(dictionary) = dictionary {
        compressor
            .set_dictionary(3, dictionary)
            .expect("dictionary");
    }
    compressor
}

fn compressed_test_frame(frame: &[u8], dictionary: Option<(u32, u32, &[u8])>) -> Vec<u8> {
    let rows_offset = STREAM_HEADER_BYTES + FRAME_HEADER_BODY_BYTES;
    let rows = &frame[rows_offset..];
    let mut splitter = merkur_codec::RowSplitter::default();
    let split = splitter
        .split(rows, parse_frame_header(frame).unwrap().row_count)
        .expect("split rows");
    let compressed = display_test_compressor(dictionary.map(|(_, _, bytes)| bytes))
        .compress(split)
        .expect("compress");

    let mut wire = frame[..rows_offset].to_vec();
    wire[0] = MSG_TYPE_DISPLAY_PATCH;
    wire[DISPLAY_GENERATION_OFFSET..DISPLAY_GENERATION_OFFSET + 4]
        .copy_from_slice(&1u32.to_be_bytes());
    let seq = if matches!(parse_frame_header(frame).unwrap().kind, FrameKind::Snapshot) {
        0u32
    } else {
        1u32
    };
    wire[DISPLAY_SEQ_OFFSET..DISPLAY_SEQ_OFFSET + 4].copy_from_slice(&seq.to_be_bytes());
    wire[DISPLAY_HEADER_FLAGS_OFFSET] |= DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD;
    wire.extend_from_slice(&(rows.len() as u32).to_be_bytes());
    if let Some((id, hash, _)) = dictionary {
        wire[DISPLAY_HEADER_FLAGS_OFFSET] |= DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD_DICT;
        wire.extend_from_slice(&id.to_be_bytes());
        wire.extend_from_slice(&hash.to_be_bytes());
    }
    wire.extend_from_slice(&compressed);
    restamp_test_body_len(&mut wire);
    wire
}

#[cfg(merkur_fuzz)]
mod fuzz {
    include!("../../../tools/bolero/display.rs");
}

fn restamp_test_body_len(wire: &mut [u8]) {
    let body_len = u32::try_from(wire.len() - STREAM_HEADER_BYTES).unwrap();
    wire[DISPLAY_HEADER_BODY_LENGTH_OFFSET..DISPLAY_HEADER_BODY_LENGTH_OFFSET + 4]
        .copy_from_slice(&body_len.to_be_bytes());
}

#[test]
fn staged_ingress_returns_the_full_allocation_address() {
    let mut terminal = Terminal::new(1, 1);
    let pointer = terminal.reserve_display_frame_input(128);
    assert_eq!(pointer, terminal.staged_frame_input.as_mut_ptr() as usize);
    assert!(terminal.take_last_error().is_none());
}

#[test]
fn oversized_ingress_is_refused_before_growing_or_acquiring_a_slot() {
    let mut terminal = Terminal::new(1, 1);
    assert_ne!(terminal.reserve_display_frame_input(128), 0);
    let capacity = terminal.staged_frame_input.capacity();
    assert_eq!(
        terminal.reserve_display_frame_input(MAX_DISPLAY_FRAME_BYTES as u32 + 1),
        0
    );
    assert_eq!(terminal.staged_frame_input.capacity(), capacity);
    assert!(terminal.staged_frames.is_empty());
    assert_eq!(terminal.staged_active_wire_bytes, 0);
    assert_eq!(terminal.staged_active_decoded_bytes, 0);
}

#[test]
fn wide_raw_and_compressed_envelopes_stage_and_apply_identical_authority() {
    const COLS: u16 = 512;
    const ROWS: u16 = 64;
    let cells: Vec<_> = (0..ROWS)
        .map(|row| {
            (0..COLS)
                .map(|col| CellRepr {
                    codepoint: u32::from(b'A') + u32::from(col % 26),
                    fg: [(col % 255) as u8, row as u8, 17],
                    ..CellRepr::BLANK
                })
                .collect::<Vec<_>>()
        })
        .collect();
    let entries: Vec<_> = cells
        .iter()
        .enumerate()
        .map(|(row, cells)| RowRef {
            graphics: &[],
            row_index: row as u16,
            left: 0,
            cells,
        })
        .collect();
    let raw =
        test_frame_chunk_with_entries(FrameKind::Snapshot, COLS, ROWS, 0, 0, 1, 0, 1, &entries);
    assert!(raw.len() > usize::from(u16::MAX) + STREAM_HEADER_BYTES);
    assert!(raw.len() < MAX_DISPLAY_FRAME_BYTES);
    let wire = compressed_test_frame(&raw, None);
    let mut expected = Terminal::new(COLS, ROWS);
    assert!(expected.apply_state_seq(&raw, 0));
    for bytes in [&raw, &wire] {
        let mut terminal = Terminal::new(COLS, ROWS);
        let handle = stage_test_frame(&mut terminal, bytes);
        assert_ne!(handle, 0, "{:?}", terminal.last_error);
        assert!(terminal.validate_staged_frame(handle));
        assert!(terminal.apply_staged_state_seq(handle, 0));
        for row in 0..ROWS {
            assert_eq!(terminal.row_hash(row), expected.row_hash(row));
        }
        terminal.release_staged_frame(handle);
        assert_eq!(terminal.staged_active_decoded_bytes, 0);
        assert_eq!(terminal.staged_active_wire_bytes, 0);
    }
}

fn replace_plain_compressed_payload(wire: &mut Vec<u8>, payload: &[u8]) {
    wire.truncate(DISPLAY_COMPRESSED_PAYLOAD_OFFSET);
    wire.extend_from_slice(payload);
    restamp_test_body_len(wire);
}

fn dictionary_test_frame(
    frame: &[u8],
    generation: u32,
    id: u32,
    dictionary: &[u8],
) -> (Vec<u8>, u32) {
    let hash = (merkur_codec::hash_bytes(dictionary) >> 32) as u32;
    let mut wire = compressed_test_frame(frame, Some((id, hash, dictionary)));
    wire[DISPLAY_GENERATION_OFFSET..DISPLAY_GENERATION_OFFSET + 4]
        .copy_from_slice(&generation.to_be_bytes());
    (wire, hash)
}

fn stage_test_frame(terminal: &mut Terminal, wire: &[u8]) -> u32 {
    if terminal.reserve_display_frame_input(wire.len() as u32) == 0 {
        return 0;
    }
    terminal.staged_frame_input[..wire.len()].copy_from_slice(wire);
    terminal.stage_display_frame_input(wire.len() as u32)
}

fn assert_dictionary_stage(terminal: &mut Terminal, wire: &[u8], expected: bool) {
    let handle = stage_test_frame(terminal, wire);
    if expected {
        assert_ne!(handle, 0, "{:?}", terminal.last_error);
        terminal.release_staged_frame(handle);
    } else {
        assert_eq!(handle, 0);
        assert_eq!(
            terminal.last_error.as_deref(),
            Some("compressed_display_dictionary_missing")
        );
    }
}

fn assert_terminal_authority_eq(left: &Terminal, right: &Terminal, cols: u16, rows: u16) {
    for row in 0..rows {
        for col in 0..cols {
            let point = Point::new(Line(i32::from(row)), Column(usize::from(col)));
            assert_eq!(
                CellRepr::from_alacritty(&left.term.grid()[point]),
                CellRepr::from_alacritty(&right.term.grid()[point]),
                "authority differs at ({col}, {row})"
            );
        }
    }
    assert_eq!(left.display_mode, right.display_mode);
    assert_eq!(left.display_header_version, right.display_header_version);
    assert_eq!(left.display_row_versions, right.display_row_versions);
    assert_eq!(left.display_cell_versions, right.display_cell_versions);
    assert_eq!(
        left.authoritative_cell_revisions,
        right.authoritative_cell_revisions
    );
    assert_eq!(left.authoritative_revision, right.authoritative_revision);
    assert_eq!(
        left.authoritative_header_revision,
        right.authoritative_header_revision
    );
    assert_eq!(
        left.last_applied_display_header,
        right.last_applied_display_header
    );
    assert_eq!(
        left.authoritative_cursor_visible,
        right.authoritative_cursor_visible
    );
    assert_eq!(left.damaged_rows, right.damaged_rows);
    assert_eq!(left.full_damage, right.full_damage);
    assert_eq!(
        left.last_apply_visually_changed,
        right.last_apply_visually_changed
    );
}

#[test]
fn compressed_stage_fuses_decode_and_validation_then_applies_without_reparse() {
    let cells = [
        test_cell('f'),
        test_cell('a'),
        test_cell('s'),
        test_cell('t'),
    ];
    let frame = test_frame(
        FrameKind::Delta,
        4,
        RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &cells,
        },
    );
    let wire = compressed_test_frame(&frame, None);
    let mut direct = Terminal::new(4, 1);
    let mut staged = Terminal::new(4, 1);
    let handle = stage_test_frame(&mut staged, &wire);
    assert_ne!(handle, 0, "{:?}", staged.last_error);
    let slot = usize::try_from(handle).unwrap() - 1;

    let owned = staged.staged_frames[slot].as_ref().unwrap();
    assert!(owned.data.is_empty());
    assert_eq!(owned.validation.as_ref().unwrap().decoded.cells, cells);
    assert!(staged.staged_validation_pool.is_empty());
    assert_eq!(staged.staged_validation_pool_cell_capacity, 0);

    assert!(direct.apply_presented_delta_seq(&frame, 1));
    assert!(staged.apply_presented_staged_delta_seq(handle, 1));
    assert_eq!(direct.display_frame_decode_count, 1);
    assert_eq!(staged.display_frame_decode_count, 1);
    assert_terminal_authority_eq(&direct, &staged, 4, 1);

    // Staging owns the one and only decode. Apply swaps its validated
    // vectors through the terminal scratch and release returns them to the
    // bounded pool; no normalized byte buffer exists.
    assert!(
        staged.staged_frames[slot]
            .as_ref()
            .unwrap()
            .validation
            .is_some()
    );
    assert!(staged.staged_validation_pool.is_empty());
    assert_eq!(staged.staged_validation_pool_cell_capacity, 0);
    staged.release_staged_frame(handle);
    assert!(staged.staged_frames[slot].is_none());
    assert_eq!(staged.staged_validation_pool.len(), 1);
}

#[test]
fn slice_and_fused_reader_preserve_identical_authority_across_wrap_and_rejection() {
    const COLS: u16 = 8;
    const ROWS: u16 = 3;
    let mut slice = Terminal::new(COLS, ROWS);
    let mut fused = Terminal::new(COLS, ROWS);

    let apply_both = |slice: &mut Terminal,
                      fused: &mut Terminal,
                      frame: &[u8],
                      snapshot: bool,
                      seq: u32|
     -> (bool, bool) {
        let wire = compressed_test_frame(frame, None);
        let handle = stage_test_frame(fused, &wire);
        let slice_result = if snapshot {
            slice.apply_presented_state_seq(frame, seq)
        } else {
            slice.apply_presented_delta_seq(frame, seq)
        };
        let fused_result = if handle == 0 {
            false
        } else if snapshot {
            fused.apply_presented_staged_state_seq(handle, seq)
        } else {
            fused.apply_presented_staged_delta_seq(handle, seq)
        };
        fused.release_staged_frame(handle);
        (slice_result, fused_result)
    };

    let initial = text_rows_frame(FrameKind::Snapshot, COLS, ROWS, &distinct_rows(ROWS));
    assert_eq!(
        apply_both(&mut slice, &mut fused, &initial, true, u32::MAX - 1),
        (true, true)
    );
    assert_terminal_authority_eq(&slice, &fused, COLS, ROWS);

    for (seq, row, fill) in [(u32::MAX, 0, 'M'), (1, 1, 'W')] {
        let delta = text_rows_frame(FrameKind::Delta, COLS, ROWS, &[(row, fill)]);
        assert_eq!(
            apply_both(&mut slice, &mut fused, &delta, false, seq),
            (true, true)
        );
        assert_terminal_authority_eq(&slice, &fused, COLS, ROWS);
        assert!(slice.last_apply_visually_changed());
    }

    // A pre-wrap stale frame and a duplicate are valid idempotent
    // transformations, but neither may advance damage or visual state.
    for seq in [u32::MAX, 1] {
        let stale = text_rows_frame(FrameKind::Delta, COLS, ROWS, &[(1, 'S')]);
        assert_eq!(
            apply_both(&mut slice, &mut fused, &stale, false, seq),
            (true, true)
        );
        assert_terminal_authority_eq(&slice, &fused, COLS, ROWS);
        assert!(!slice.last_apply_visually_changed());
    }

    let literal = text_rows_frame(FrameKind::Delta, COLS, ROWS, &[(0, 'x'), (2, 'z')]);
    assert_eq!(
        apply_both(&mut slice, &mut fused, &literal, false, 2),
        (true, true)
    );
    assert_terminal_authority_eq(&slice, &fused, COLS, ROWS);

    // A malformed final row must reject before any earlier row lands.
    let rejected = text_rows_frame(
        FrameKind::Delta,
        COLS,
        ROWS,
        &[(0, 'q'), (1, 'r'), (ROWS, 's')],
    );
    assert_eq!(
        apply_both(&mut slice, &mut fused, &rejected, false, 3),
        (false, false)
    );
    assert_terminal_authority_eq(&slice, &fused, COLS, ROWS);
    assert_eq!(
        slice.last_error.as_deref(),
        Some("display_row_range_invalid")
    );
    assert_eq!(slice.last_error, fused.last_error);
}

#[test]
fn slice_and_fused_reader_reject_the_same_decoded_payload_corpus_atomically() {
    let cells = [test_cell('a'), test_cell('b'), test_cell('c')];
    let valid = test_frame(
        FrameKind::Delta,
        3,
        RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &cells,
        },
    );
    let mut truncated = valid.clone();
    truncated.pop();
    let mut trailing = valid.clone();
    trailing.push(0);
    let duplicate = test_frame_with_entries(
        FrameKind::Delta,
        3,
        1,
        0,
        0,
        &[
            RowRef {
                graphics: &[],
                row_index: 0,
                left: 0,
                cells: &cells,
            },
            RowRef {
                graphics: &[],
                row_index: 0,
                left: 0,
                cells: &cells,
            },
        ],
    );

    // A body whose rows do not parse cannot be split, so its compressed
    // counterpart is the split payload damaged the same way: the join, not
    // the row reader, refuses it.
    let rows_offset = STREAM_HEADER_BYTES + FRAME_HEADER_BODY_BYTES;
    let valid_split = merkur_codec::RowSplitter::default()
        .split(&valid[rows_offset..], 1)
        .unwrap()
        .to_vec();
    let damaged_wire = |damage: fn(&mut Vec<u8>)| {
        let mut split = valid_split.clone();
        damage(&mut split);
        let mut wire = compressed_test_frame(&valid, None);
        replace_plain_compressed_payload(
            &mut wire,
            &display_test_compressor(None).compress(&split).unwrap(),
        );
        wire
    };
    let cases = [
        (
            &truncated,
            damaged_wire(|split| split.truncate(split.len() - 1)),
        ),
        (&trailing, damaged_wire(|split| split.push(0))),
        (&duplicate, compressed_test_frame(&duplicate, None)),
    ];
    for (malformed, wire) in cases {
        let mut slice = Terminal::new(3, 1);
        let mut fused = Terminal::new(3, 1);
        assert!(!slice.apply_presented_delta_seq(malformed, 1));
        assert_eq!(stage_test_frame(&mut fused, &wire), 0);
        assert_terminal_authority_eq(&slice, &fused, 3, 1);
        // The slice validator can identify a malformed cell while the fused
        // reader reports the enclosing row. The public contract is rejection
        // before mutation, not identical internal diagnostic granularity.
        assert!(slice.last_error.is_some());
        assert!(fused.last_error.is_some());
        assert_eq!(slice.authoritative_revision, 0);
        assert!(slice.damaged_rows.is_empty());
    }
}

#[test]
fn staged_delta_sequence_zero_is_rejected_before_decode() {
    let cells = [test_cell('z')];
    let frame = test_frame(
        FrameKind::Delta,
        1,
        RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &cells,
        },
    );
    let mut wire = compressed_test_frame(&frame, None);
    wire[DISPLAY_SEQ_OFFSET..DISPLAY_SEQ_OFFSET + 4].fill(0);
    let mut terminal = Terminal::new(1, 1);
    let before_decode = terminal.display_frame_decode_count;

    assert_eq!(stage_test_frame(&mut terminal, &wire), 0);
    assert_eq!(
        terminal.last_error.as_deref(),
        Some("display_stage_sequence_invalid")
    );
    assert_eq!(terminal.display_frame_decode_count, before_decode);
    assert!(!terminal.apply_presented_delta_seq(&frame, 0));
    assert_eq!(
        terminal.last_error.as_deref(),
        Some("display_sequence_invalid")
    );
    assert!(!terminal.last_apply_visually_changed());
}

#[test]
fn explicitly_prevalidated_staged_apply_reuses_one_cached_decode() {
    let cells = [
        test_cell('c'),
        test_cell('a'),
        test_cell('c'),
        test_cell('h'),
    ];
    let frame = test_frame(
        FrameKind::Delta,
        4,
        RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &cells,
        },
    );
    let wire = compressed_test_frame(&frame, None);
    let mut direct = Terminal::new(4, 1);
    let mut staged = Terminal::new(4, 1);
    let handle = stage_test_frame(&mut staged, &wire);
    assert_ne!(handle, 0, "{:?}", staged.last_error);
    let slot = usize::try_from(handle).unwrap() - 1;

    assert!(staged.validate_staged_frame(handle));
    assert!(staged.validate_staged_frame(handle));
    assert_eq!(staged.display_frame_decode_count, 1);
    let validation = staged.staged_frames[slot]
        .as_ref()
        .unwrap()
        .validation
        .as_ref()
        .unwrap();
    let cached_cells_ptr = validation.decoded.cells.as_ptr() as usize;
    let cached_cell_capacity = validation.decoded.cells.capacity();
    assert!(cached_cell_capacity >= cells.len());
    assert!(staged.staged_validation_pool.is_empty());
    assert_eq!(staged.staged_validation_pool_cell_capacity, 0);

    assert!(direct.apply_presented_delta_seq(&frame, 1));
    assert!(staged.apply_presented_staged_delta_seq(handle, 1));
    assert_eq!(staged.display_frame_decode_count, 1);
    let validation = staged.staged_frames[slot]
        .as_ref()
        .unwrap()
        .validation
        .as_ref()
        .unwrap();
    assert_eq!(validation.decoded.cells.as_ptr() as usize, cached_cells_ptr);
    assert_eq!(validation.decoded.cells.capacity(), cached_cell_capacity);
    assert_terminal_authority_eq(&direct, &staged, 4, 1);

    staged.release_staged_frame(handle);
    assert!(staged.staged_frames[slot].is_none());
    assert_eq!(staged.staged_validation_pool.len(), 1);
    assert_eq!(
        staged.staged_validation_pool_cell_capacity,
        cached_cell_capacity
    );
}

#[test]
fn malformed_compressed_snapshot_is_rejected_during_fused_staging() {
    let cells = [test_cell('b'), test_cell('a'), test_cell('d')];
    let valid = test_frame(
        FrameKind::Snapshot,
        3,
        RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &cells,
        },
    );
    // A surrogate is no Unicode scalar value: the row splits and joins as
    // bytes, and only the row validator can refuse it.
    let surrogate = [
        test_cell('b'),
        CellRepr {
            codepoint: 0xd800,
            ..test_cell('a')
        },
        test_cell('d'),
    ];
    let malformed = test_frame(
        FrameKind::Snapshot,
        3,
        RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &surrogate,
        },
    );
    let malformed_wire = compressed_test_frame(&malformed, None);
    let valid_wire = compressed_test_frame(&valid, None);
    let mut raw = Terminal::new(3, 1);
    assert!(!raw.apply_state_seq(&malformed, 0));
    let mut terminal = Terminal::new(3, 1);
    let before_row = terminal.row_hash(0);
    let handle = stage_test_frame(&mut terminal, &malformed_wire);
    assert_eq!(handle, 0);
    // Compressed and uncompressed rows share one validator, so the row is
    // refused with the same error on both paths.
    assert_eq!(terminal.last_error, raw.last_error);
    let prediction_epoch = terminal.prediction_epoch;
    assert_eq!(terminal.display_frame_decode_count, 1);
    assert_eq!(terminal.row_hash(0), before_row);
    assert_eq!(terminal.prediction_epoch, prediction_epoch);
    // A failed stage owns no handle, and releasing zero is idempotent.
    terminal.release_staged_frame(handle);
    assert!(terminal.staged_frames.is_empty());

    // The rejected decode scratch is pooled for the next valid frame.
    let reused = stage_test_frame(&mut terminal, &valid_wire);
    assert_eq!(reused, 1);
    assert!(terminal.apply_presented_staged_state_seq(reused, 2));
    assert_eq!(terminal.display_frame_decode_count, 2);
    assert_eq!(terminal.term.grid()[Point::new(Line(0), Column(0))].c, 'b');
    terminal.release_staged_frame(reused);
}

#[test]
fn raw_multichunk_staging_reuses_the_validated_decode_byte_exactly() {
    let row_a = [test_cell('a'), test_cell('b'), test_cell('c')];
    let row_b = [test_cell('x'), test_cell('y'), test_cell('z')];
    let chunks = [
        test_frame_chunk_with_entries(
            FrameKind::Delta,
            3,
            2,
            0,
            0,
            77,
            0,
            2,
            &[RowRef {
                graphics: &[],
                row_index: 0,
                left: 0,
                cells: &row_a,
            }],
        ),
        test_frame_chunk_with_entries(
            FrameKind::Delta,
            3,
            2,
            0,
            0,
            77,
            1,
            2,
            &[RowRef {
                graphics: &[],
                row_index: 1,
                left: 0,
                cells: &row_b,
            }],
        ),
    ];
    let mut direct = Terminal::new(3, 2);
    let mut staged = Terminal::new(3, 2);
    let handles = chunks
        .iter()
        .map(|chunk| stage_test_frame(&mut staged, chunk))
        .collect::<Vec<_>>();
    assert!(handles.iter().all(|handle| *handle != 0));

    // The reusable ingress may be overwritten as soon as staging returns;
    // every queued slot must still own the exact bytes it accepted.
    staged.staged_frame_input.fill(0xa5);
    for (index, handle) in handles.iter().copied().enumerate() {
        let slot = usize::try_from(handle).unwrap() - 1;
        assert_eq!(
            staged.staged_frames[slot].as_ref().unwrap().data,
            chunks[index]
        );
    }

    for chunk in &chunks {
        assert!(direct.validate_frame(chunk));
    }
    for handle in &handles {
        assert!(staged.validate_staged_frame(*handle));
        assert!(staged.validate_staged_frame(*handle));
    }
    // Cached structural validation is independent of mutable terminal
    // dimensions/order state: after a local resize the staged frames are
    // still valid, and apply still enforces its live gates — a delta for
    // the old grid is refused, not fitted, until the grid is that size.
    staged.resize(5, 3);
    staged.reset_display_ordering();
    for handle in &handles {
        assert!(staged.validate_staged_frame(*handle));
        assert!(!staged.apply_presented_staged_delta_seq(*handle, 1));
        assert_eq!(
            staged.take_last_error().as_deref(),
            Some("display_dimensions_mismatch")
        );
    }
    assert_eq!((staged.cols(), staged.rows()), (5, 3));
    staged.resize(3, 2);
    staged.reset_display_ordering();
    for (index, chunk) in chunks.iter().enumerate() {
        assert!(direct.apply_presented_delta_seq(chunk, (index + 1) as u32));
    }
    for (index, handle) in handles.iter().copied().enumerate() {
        assert!(staged.apply_presented_staged_delta_seq(handle, (index + 1) as u32));
    }

    assert_terminal_authority_eq(&direct, &staged, 3, 2);
    assert_eq!(direct.display_frame_decode_count, 4);
    assert_eq!(staged.display_frame_decode_count, 2);
    for handle in handles {
        staged.release_staged_frame(handle);
    }
}

#[test]
fn staged_validation_pool_has_an_aggregate_decoded_cell_capacity_budget() {
    let mut terminal = Terminal::new(1, 1);
    let per_scratch_capacity = MAX_TERMINAL_CELLS / 8;
    for _ in 0..=STAGED_VALIDATION_POOL_MAX {
        let decoded = DisplayFrameDecodeScratch {
            cells: Vec::with_capacity(per_scratch_capacity),
            ..DisplayFrameDecodeScratch::default()
        };
        terminal.recycle_staged_validation(decoded);
    }

    assert!(terminal.staged_validation_pool.len() <= STAGED_VALIDATION_POOL_MAX);
    assert!(
        terminal.staged_validation_pool_cell_capacity <= STAGED_VALIDATION_POOL_MAX_CELL_CAPACITY
    );
    assert_eq!(
        terminal.staged_validation_pool_cell_capacity,
        terminal
            .staged_validation_pool
            .iter()
            .map(|decoded| decoded.cells.capacity())
            .sum::<usize>()
    );

    while !terminal.staged_validation_pool.is_empty() {
        let _ = terminal.take_staged_validation();
    }
    assert_eq!(terminal.staged_validation_pool_cell_capacity, 0);
}

#[test]
fn corrupt_later_chunk_keeps_the_atomic_validation_barrier_non_mutating() {
    let initial_a = [test_cell('a'), test_cell('a')];
    let initial_b = [test_cell('b'), test_cell('b')];
    let initial = test_frame_with_row_refs(
        FrameKind::Snapshot,
        2,
        2,
        &[
            RowRef {
                graphics: &[],
                row_index: 0,
                left: 0,
                cells: &initial_a,
            },
            RowRef {
                graphics: &[],
                row_index: 1,
                left: 0,
                cells: &initial_b,
            },
        ],
    );
    let next_a = [test_cell('x'), test_cell('x')];
    let next_b = [test_cell('y'), test_cell('y')];
    let valid = test_frame_chunk_with_entries(
        FrameKind::Delta,
        2,
        2,
        0,
        0,
        91,
        0,
        2,
        &[RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &next_a,
        }],
    );
    let mut corrupt = test_frame_chunk_with_entries(
        FrameKind::Delta,
        2,
        2,
        0,
        0,
        91,
        1,
        2,
        &[RowRef {
            graphics: &[],
            row_index: 1,
            left: 0,
            cells: &next_b,
        }],
    );
    corrupt.pop();
    let body_len = u32::try_from(corrupt.len() - STREAM_HEADER_BYTES).unwrap();
    corrupt[DISPLAY_HEADER_BODY_LENGTH_OFFSET..DISPLAY_HEADER_BODY_LENGTH_OFFSET + 4]
        .copy_from_slice(&body_len.to_be_bytes());

    let mut terminal = Terminal::new(2, 2);
    assert!(terminal.apply_presented_state_seq(&initial, 0));
    let before_decode_count = terminal.display_frame_decode_count;
    let before_rows = [terminal.row_hash(0), terminal.row_hash(1)];
    let handles = [
        stage_test_frame(&mut terminal, &valid),
        stage_test_frame(&mut terminal, &corrupt),
    ];
    let accepted = handles
        .iter()
        .copied()
        .all(|handle| terminal.validate_staged_frame(handle));
    if accepted {
        // Mirror the production all-chunks barrier: application is entered
        // only after every chunk validates.
        for (index, handle) in handles.iter().copied().enumerate() {
            assert!(terminal.apply_presented_staged_delta_seq(handle, (index + 1) as u32));
        }
    }

    assert!(!accepted);
    assert_eq!(terminal.display_frame_decode_count, before_decode_count + 2);
    assert_eq!([terminal.row_hash(0), terminal.row_hash(1)], before_rows);
    assert_eq!(terminal.term.grid()[Point::new(Line(0), Column(0))].c, 'a');
    assert_eq!(terminal.term.grid()[Point::new(Line(1), Column(0))].c, 'b');
    for handle in handles {
        terminal.release_staged_frame(handle);
    }
}

#[test]
fn dictionary_and_fec_envelope_streams_into_exact_validated_cells() {
    let cells = [test_cell('d'), test_cell('i'), test_cell('c')];
    let frame = test_frame_chunk_with_entries(
        FrameKind::Delta,
        3,
        1,
        0,
        0,
        101,
        0,
        1,
        &[RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &cells,
        }],
    );
    let dictionary = &test_dictionary("terminal rows")[..];
    let (mut wire, hash) = dictionary_test_frame(&frame, 9, 7, dictionary);
    wire[DISPLAY_HEADER_FLAGS_OFFSET] |= DISPLAY_HEADER_FLAG_FEC_PROTECTED;
    let mut terminal = Terminal::new(3, 1);
    assert!(terminal.install_display_dictionary(9, 7, hash, dictionary));

    let handle = stage_test_frame(&mut terminal, &wire);
    assert_ne!(handle, 0, "{:?}", terminal.last_error);
    let slot = usize::try_from(handle).unwrap() - 1;
    let staged = terminal.staged_frames[slot].as_ref().unwrap();
    assert!(staged.data.is_empty());
    assert_eq!(staged.validation.as_ref().unwrap().decoded.cells, cells);
    assert!(terminal.validate_staged_frame(handle));
    assert!(terminal.apply_presented_staged_delta_seq(handle, 1));
    assert_eq!(terminal.display_frame_decode_count, 1);
    terminal.release_staged_frame(handle);
}

#[test]
fn compressed_frame_stages_applies_and_reuses_its_handle_slot() {
    let cells = [test_cell('a'), test_cell('b'), test_cell('c')];
    let frame = test_frame(
        FrameKind::Snapshot,
        3,
        RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &cells,
        },
    );
    let wire = compressed_test_frame(&frame, None);
    let mut terminal = Terminal::new(3, 1);

    let handle = stage_test_frame(&mut terminal, &wire);
    assert_ne!(handle, 0, "{:?}", terminal.last_error);
    assert!(terminal.validate_staged_frame(handle));
    assert!(terminal.apply_presented_staged_state_seq(handle, 1));
    assert_eq!(terminal.display_frame_decode_count, 1);
    assert_eq!(terminal.term.grid()[Point::new(Line(0), Column(0))].c, 'a');
    assert_eq!(terminal.term.grid()[Point::new(Line(0), Column(2))].c, 'c');
    terminal.release_staged_frame(handle);

    let reused = stage_test_frame(&mut terminal, &wire);
    assert_eq!(reused, handle);
    terminal.release_staged_frame(reused);
}

#[test]
fn dictionary_compressed_frame_requires_the_exact_installed_dictionary() {
    let cells = [test_cell('x'), test_cell('x'), test_cell('x')];
    let frame = test_frame(
        FrameKind::Delta,
        3,
        RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &cells,
        },
    );
    let dictionary = &test_dictionary("encoded terminal rows")[..];
    let (wire, hash) = dictionary_test_frame(&frame, 9, 7, dictionary);
    let mut terminal = Terminal::new(3, 1);

    assert_dictionary_stage(&mut terminal, &wire, false);
    assert!(terminal.install_display_dictionary(9, 7, hash, dictionary));
    let handle = stage_test_frame(&mut terminal, &wire);
    assert_ne!(handle, 0, "{:?}", terminal.last_error);
    assert!(terminal.validate_staged_frame(handle));
    assert!(terminal.apply_presented_staged_delta_seq(handle, 1));
    assert_eq!(terminal.display_frame_decode_count, 1);
    terminal.release_staged_frame(handle);
}

#[test]
fn dictionary_slot_zeroes_shrunk_and_cleared_allocation_bytes() {
    // Byte patterns without the dictionary magic load as raw content,
    // which is all this allocation test needs from the decoder form.
    let mut slot = DisplayDictionarySlot::empty();
    slot.replace(
        1,
        1,
        1,
        11,
        &[0xaa; 64],
        zstd_safe::DDict::create(&[0xaa; 64]),
    );
    slot.replace(
        1,
        2,
        2,
        22,
        &[0xbb; 8],
        zstd_safe::DDict::create(&[0xbb; 8]),
    );

    const PRIOR_LEN: usize = 64;
    assert!(slot.bytes.capacity() >= PRIOR_LEN);
    // SAFETY: all PRIOR_LEN bytes were initialized by the first replacement,
    // and the capacity asserted above shows the smaller second replacement
    // retains an allocation at least that long.
    let allocation = unsafe { std::slice::from_raw_parts(slot.bytes.as_ptr(), PRIOR_LEN) };
    assert!(allocation[..8].iter().all(|byte| *byte == 0xbb));
    assert!(allocation[8..].iter().all(|byte| *byte == 0));

    slot.clear();
    // SAFETY: `clear` wipes the bytes and keeps the allocation the assertion
    // above measured, whose first PRIOR_LEN bytes stay initialized.
    let cleared = unsafe { std::slice::from_raw_parts(slot.bytes.as_ptr(), PRIOR_LEN) };
    assert!(cleared.iter().all(|byte| *byte == 0));
}

#[test]
fn dictionary_slots_have_exact_current_previous_and_generation_lifecycle() {
    let cells = [test_cell('x'), test_cell('y'), test_cell('z')];
    let frame = test_frame(
        FrameKind::Delta,
        3,
        RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &cells,
        },
    );
    let dictionary_a = &test_dictionary("A terminal rows")[..];
    let dictionary_b = &test_dictionary("B shell output")[..];
    let dictionary_c = &test_dictionary("C prompt state")[..];
    let dictionary_d = &test_dictionary("D next session")[..];
    let (wire_a, hash_a) = dictionary_test_frame(&frame, 9, 1, dictionary_a);
    let (wire_b, hash_b) = dictionary_test_frame(&frame, 9, 2, dictionary_b);
    let (wire_c, hash_c) = dictionary_test_frame(&frame, 9, 3, dictionary_c);
    let (wire_d, hash_d) = dictionary_test_frame(&frame, 10, 4, dictionary_d);
    let mut terminal = Terminal::new(3, 1);

    assert!(terminal.install_display_dictionary(9, 1, hash_a, dictionary_a));
    assert_dictionary_stage(&mut terminal, &wire_a, true);

    assert!(terminal.install_display_dictionary(9, 2, hash_b, dictionary_b));
    assert_dictionary_stage(&mut terminal, &wire_a, true);
    assert_dictionary_stage(&mut terminal, &wire_b, true);

    // The boot -> regular -> styled atlas promotion path must not replace
    // codec ownership. Exercise the actual production font APIs with the
    // bundled faces, then prove both retained dictionary slots still decode.
    let regular = include_bytes!("../../../apps/web/public/fonts/JetBrainsMonoNF-Regular.ttf");
    let bold = include_bytes!("../../../apps/web/public/fonts/JetBrainsMonoNF-Bold.ttf");
    let italic = include_bytes!("../../../apps/web/public/fonts/JetBrainsMonoNF-Italic.ttf");
    let bold_italic =
        include_bytes!("../../../apps/web/public/fonts/JetBrainsMonoNF-BoldItalic.ttf");
    terminal.set_regular_font_bytes(regular);
    assert_dictionary_stage(&mut terminal, &wire_a, true);
    assert_dictionary_stage(&mut terminal, &wire_b, true);
    terminal.set_style_font_bytes(bold, italic, bold_italic);
    assert_dictionary_stage(&mut terminal, &wire_a, true);
    assert_dictionary_stage(&mut terminal, &wire_b, true);

    // Repeated control delivery for either retained slot is idempotent and
    // cannot demote the active dictionary or perturb eviction order.
    assert!(terminal.install_display_dictionary(9, 1, hash_a, dictionary_a));
    assert!(terminal.install_display_dictionary(9, 2, hash_b, dictionary_b));
    assert_dictionary_stage(&mut terminal, &wire_a, true);
    assert_dictionary_stage(&mut terminal, &wire_b, true);

    // A rejected install leaves both valid slots untouched.
    assert!(!terminal.install_display_dictionary(9, 3, hash_c ^ 1, dictionary_c));
    assert_dictionary_stage(&mut terminal, &wire_a, true);
    assert_dictionary_stage(&mut terminal, &wire_b, true);

    // The third dictionary evicts exactly the oldest slot.
    assert!(terminal.install_display_dictionary(9, 3, hash_c, dictionary_c));
    assert_dictionary_stage(&mut terminal, &wire_a, false);
    assert_dictionary_stage(&mut terminal, &wire_b, true);
    assert_dictionary_stage(&mut terminal, &wire_c, true);

    // A session-generation change hard-cuts both prior dictionaries.
    assert!(terminal.install_display_dictionary(10, 4, hash_d, dictionary_d));
    assert_dictionary_stage(&mut terminal, &wire_b, false);
    assert_dictionary_stage(&mut terminal, &wire_c, false);
    assert_dictionary_stage(&mut terminal, &wire_d, true);

    // Authenticated epoch ownership is stricter than grid preservation:
    // even the current dictionary becomes unavailable immediately.
    terminal.clear_display_dictionaries();
    assert_dictionary_stage(&mut terminal, &wire_d, false);
}

#[test]
fn compressed_frame_rejects_oversized_advertised_rows_before_allocating() {
    let cells = [test_cell('z')];
    let frame = test_frame(
        FrameKind::Delta,
        1,
        RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &cells,
        },
    );
    let mut wire = compressed_test_frame(&frame, None);
    wire[DISPLAY_COMPRESSED_LENGTH_OFFSET..DISPLAY_COMPRESSED_LENGTH_OFFSET + 4]
        .copy_from_slice(&u32::MAX.to_be_bytes());
    let mut terminal = Terminal::new(1, 1);

    assert_eq!(stage_test_frame(&mut terminal, &wire), 0);
    assert_eq!(
        terminal.last_error.as_deref(),
        Some("compressed_display_rows_too_large")
    );
    assert!(
        terminal
            .staged_frame_pool
            .iter()
            .all(|buffer| buffer.capacity() <= wire.len())
    );
}

#[test]
fn compressed_frame_requires_one_exact_zstd_source() {
    let cells = [test_cell('e'), test_cell('o'), test_cell('f')];
    let frame = test_frame(
        FrameKind::Delta,
        3,
        RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &cells,
        },
    );
    let wire = compressed_test_frame(&frame, None);
    let compressed = wire[DISPLAY_COMPRESSED_PAYLOAD_OFFSET..].to_vec();

    let mut appended = wire.clone();
    appended.push(0xa5);
    restamp_test_body_len(&mut appended);
    let mut terminal = Terminal::new(3, 1);
    assert_eq!(stage_test_frame(&mut terminal, &appended), 0);
    assert_eq!(
        terminal.last_error.as_deref(),
        Some("compressed_display_trailing_or_checksum")
    );

    let mut concatenated = wire;
    concatenated.extend_from_slice(&compressed);
    restamp_test_body_len(&mut concatenated);
    assert_eq!(stage_test_frame(&mut terminal, &concatenated), 0);
    assert_eq!(
        terminal.last_error.as_deref(),
        Some("compressed_display_trailing_or_checksum")
    );
}

#[test]
fn compressed_frame_rejects_a_truncated_payload_before_decode() {
    let cells = [test_cell('c'); 64];
    let frame = test_frame(
        FrameKind::Delta,
        64,
        RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &cells,
        },
    );
    let mut wire = compressed_test_frame(&frame, None);
    let mut payload = wire[DISPLAY_COMPRESSED_PAYLOAD_OFFSET..].to_vec();
    assert!(parse_zstd_frame_metadata(&payload).is_some());
    payload.pop();
    replace_plain_compressed_payload(&mut wire, &payload);
    let mut terminal = Terminal::new(64, 1);
    assert_eq!(stage_test_frame(&mut terminal, &wire), 0);
    assert_eq!(
        terminal.last_error.as_deref(),
        Some("compressed_display_trailing_or_checksum")
    );
    assert_eq!(terminal.display_frame_decode_count, 0);
}

#[test]
fn compressed_frame_rejects_more_than_the_merkur_window_before_decode() {
    let cells = [test_cell('w')];
    let frame = test_frame(
        FrameKind::Delta,
        1,
        RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &cells,
        },
    );
    let mut wire = compressed_test_frame(&frame, None);
    // Magicless, no single-segment/content-size/dictionary, and window
    // descriptor exponent 12 => 2^(10+12) = 4 MiB.
    replace_plain_compressed_payload(&mut wire, &[0x00, 0x60]);
    let before_decode = {
        let terminal = Terminal::new(1, 1);
        terminal.display_frame_decode_count
    };
    let mut terminal = Terminal::new(1, 1);
    assert_eq!(stage_test_frame(&mut terminal, &wire), 0);
    assert_eq!(
        terminal.last_error.as_deref(),
        Some("compressed_display_window_too_large")
    );
    assert_eq!(terminal.display_frame_decode_count, before_decode);
}

#[test]
fn merkur_maximum_legal_rows_fit_the_decoder_window_with_or_without_dictionary() {
    let maximum_rows_bytes = usize::from(u16::MAX) - FRAME_HEADER_BODY_BYTES;
    let input: Vec<u8> = (0..maximum_rows_bytes)
        .map(|index| ((index * 31 + index / 97) & 0xff) as u8)
        .collect();
    let dictionary = test_dictionary("maximum legal receiver window");
    let plain = display_test_compressor(None).compress(&input).unwrap();
    let dictionary_compressed = display_test_compressor(Some(&dictionary))
        .compress(&input)
        .unwrap();

    for payload in [&plain, &dictionary_compressed] {
        let metadata = parse_zstd_frame_metadata(payload).expect("libzstd frame metadata");
        assert_eq!(
            zstd_frame_size(payload, metadata.header_len),
            Some(payload.len())
        );
        assert!(
            metadata.window_size <= DISPLAY_ZSTD_MAX_WINDOW_BYTES,
            "window={} cap={DISPLAY_ZSTD_MAX_WINDOW_BYTES}",
            metadata.window_size
        );
    }
}

#[test]
fn a_payload_with_a_magic_content_size_or_checksum_is_refused_before_decode() {
    use zstd::zstd_safe::CParameter;
    let cells = [test_cell('s'); 32];
    let frame = test_frame(
        FrameKind::Delta,
        32,
        RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &cells,
        },
    );
    let rows = &frame[STREAM_HEADER_BYTES + FRAME_HEADER_BODY_BYTES..];
    let split = merkur_codec::RowSplitter::default()
        .split(rows, 1)
        .unwrap()
        .to_vec();
    let standard = zstd::bulk::compress(&split, 3).unwrap();
    let mut sized = display_test_compressor(None);
    sized
        .set_parameter(CParameter::ContentSizeFlag(true))
        .unwrap();
    let mut checksummed = display_test_compressor(None);
    checksummed
        .set_parameter(CParameter::ChecksumFlag(true))
        .unwrap();
    for payload in [
        standard,
        sized.compress(&split).unwrap(),
        checksummed.compress(&split).unwrap(),
    ] {
        assert_eq!(parse_zstd_frame_metadata(&payload), None);
        let mut wire = compressed_test_frame(&frame, None);
        replace_plain_compressed_payload(&mut wire, &payload);
        let mut terminal = Terminal::new(32, 1);
        assert_eq!(stage_test_frame(&mut terminal, &wire), 0);
        assert_eq!(
            terminal.last_error.as_deref(),
            Some("compressed_display_metadata_mismatch")
        );
        assert_eq!(terminal.display_frame_decode_count, 0);
    }
}

#[test]
fn the_split_payload_must_join_to_exactly_the_declared_rows() {
    let cells = [test_cell('j'); 24];
    let frame = test_frame(
        FrameKind::Delta,
        24,
        RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &cells,
        },
    );
    let mut wire = compressed_test_frame(&frame, None);
    let length_offset = DISPLAY_COMPRESSED_PAYLOAD_OFFSET - 4;
    let declared = u32::from_be_bytes(
        wire[length_offset..DISPLAY_COMPRESSED_PAYLOAD_OFFSET]
            .try_into()
            .unwrap(),
    );
    wire[length_offset..DISPLAY_COMPRESSED_PAYLOAD_OFFSET]
        .copy_from_slice(&(declared + 1).to_be_bytes());
    let mut terminal = Terminal::new(24, 1);
    assert_eq!(stage_test_frame(&mut terminal, &wire), 0);
    assert_eq!(
        terminal.last_error.as_deref(),
        Some("compressed_display_split_invalid")
    );
}

#[test]
fn outer_dictionary_tuple_must_name_the_embedded_zstd_dictionary() {
    let cells = [test_cell('d'); 16];
    let frame = test_frame(
        FrameKind::Delta,
        16,
        RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &cells,
        },
    );
    let dictionary_a = test_dictionary("outer A");
    let dictionary_b = test_dictionary("outer B");
    let (mut wire, hash_a) = dictionary_test_frame(&frame, 9, 11, &dictionary_a);
    let hash_b = (merkur_codec::hash_bytes(&dictionary_b) >> 32) as u32;
    let mut terminal = Terminal::new(16, 1);
    assert!(terminal.install_display_dictionary(9, 11, hash_a, &dictionary_a));
    assert!(terminal.install_display_dictionary(9, 12, hash_b, &dictionary_b));

    // The authenticated outer tuple selects B, while the zstd frame still
    // embeds A's dictionary id. The reusable decoder has both dictionaries,
    // so only the explicit identity comparison prevents silent cross-use.
    wire[DISPLAY_COMPRESSED_LENGTH_OFFSET + 4..DISPLAY_COMPRESSED_LENGTH_OFFSET + 8]
        .copy_from_slice(&12u32.to_be_bytes());
    wire[DISPLAY_COMPRESSED_LENGTH_OFFSET + 8..DISPLAY_COMPRESSED_LENGTH_OFFSET + 12]
        .copy_from_slice(&hash_b.to_be_bytes());
    assert_eq!(stage_test_frame(&mut terminal, &wire), 0);
    assert_eq!(
        terminal.last_error.as_deref(),
        Some("compressed_display_metadata_mismatch")
    );
}

#[test]
fn outer_dictionary_flag_must_match_embedded_zstd_state() {
    let cells = [test_cell('m'); 16];
    let frame = test_frame(
        FrameKind::Delta,
        16,
        RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &cells,
        },
    );
    let dictionary = test_dictionary("outer dictionary state");
    let hash = (merkur_codec::hash_bytes(&dictionary) >> 32) as u32;
    let mut terminal = Terminal::new(16, 1);
    assert!(terminal.install_display_dictionary(1, 7, hash, &dictionary));

    let mut plain_claiming_dictionary = compressed_test_frame(&frame, None);
    plain_claiming_dictionary[DISPLAY_HEADER_FLAGS_OFFSET] |=
        DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD_DICT;
    plain_claiming_dictionary.splice(
        DISPLAY_COMPRESSED_PAYLOAD_OFFSET..DISPLAY_COMPRESSED_PAYLOAD_OFFSET,
        [7u32.to_be_bytes(), hash.to_be_bytes()].concat(),
    );
    restamp_test_body_len(&mut plain_claiming_dictionary);
    assert_eq!(
        stage_test_frame(&mut terminal, &plain_claiming_dictionary),
        0
    );
    assert_eq!(
        terminal.last_error.as_deref(),
        Some("compressed_display_metadata_mismatch")
    );

    let (mut dictionary_without_outer_flag, _) = dictionary_test_frame(&frame, 1, 7, &dictionary);
    dictionary_without_outer_flag[DISPLAY_HEADER_FLAGS_OFFSET] &=
        !DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD_DICT;
    assert_eq!(
        stage_test_frame(&mut terminal, &dictionary_without_outer_flag),
        0
    );
    // Without the flag the payload is read eight bytes early, from the
    // dictionary tuple. A magicless frame has no magic number to refuse
    // there, so the refusal is whichever check that misread first fails:
    // the frame header or the block walk. Nothing is decoded either way.
    assert!(
        matches!(
            terminal.last_error.as_deref(),
            Some("compressed_display_metadata_mismatch")
                | Some("compressed_display_trailing_or_checksum")
        ),
        "{:?}",
        terminal.last_error
    );
    assert_eq!(terminal.display_frame_decode_count, 0);
}

#[test]
fn expanded_staging_budget_and_handle_arena_plateau() {
    const COLS: u16 = 512;
    const ROWS: u16 = 192;
    let fill: Vec<(u16, char)> = (0..ROWS).map(|row| (row, 'r')).collect();
    let frame = text_rows_frame(FrameKind::Delta, COLS, ROWS, &fill);
    let wire = compressed_test_frame(&frame, None);
    let mut terminal = Terminal::new(COLS, ROWS);
    let first = stage_test_frame(&mut terminal, &wire);
    let second = stage_test_frame(&mut terminal, &wire);
    assert_ne!(first, 0);
    assert_ne!(second, 0);
    assert_eq!(terminal.staged_active_decoded_cells, MAX_TERMINAL_CELLS * 2);
    let before_rejected_decode = terminal.display_frame_decode_count;
    assert_eq!(stage_test_frame(&mut terminal, &wire), 0);
    assert_eq!(
        terminal.last_error.as_deref(),
        Some("display_stage_active_budget_exceeded")
    );
    assert_eq!(terminal.display_frame_decode_count, before_rejected_decode);

    let retained_cells = |terminal: &Terminal| {
        terminal
            .staged_frames
            .iter()
            .filter_map(Option::as_ref)
            .filter_map(|frame| frame.validation.as_ref())
            .map(|validation| validation.decoded.cells.capacity())
            .sum::<usize>()
            + terminal
                .staged_validation_pool
                .iter()
                .map(|decoded| decoded.cells.capacity())
                .sum::<usize>()
    };
    let plateau = retained_cells(&terminal);
    for _ in 0..32 {
        terminal.release_staged_frame(first);
        assert_eq!(stage_test_frame(&mut terminal, &wire), first);
        assert_eq!(retained_cells(&terminal), plateau);
        assert_eq!(terminal.staged_frames.len(), 2);
    }
    terminal.release_staged_frame(first);
    terminal.release_staged_frame(second);
    assert_eq!(terminal.staged_active_wire_bytes, 0);
    assert_eq!(terminal.staged_active_decoded_bytes, 0);
    assert_eq!(terminal.staged_active_decoded_cells, 0);
}

#[test]
fn invalid_staged_handles_report_the_failed_ownership_boundary() {
    for compressed in [false, true] {
        for snapshot in [false, true] {
            let mut terminal = Terminal::new(4, 3);
            let frame = text_rows_frame(FrameKind::Delta, 4, 3, &[(0, 'x')]);
            let frame = if compressed {
                compressed_test_frame(&frame, None)
            } else {
                frame
            };
            // Zero and an arena-out-of-range handle are malformed, not a
            // decoded frame rejection.
            for handle in [0, 1, u32::MAX] {
                assert!(!terminal.validate_staged_frame(handle));
                assert_eq!(
                    terminal.take_last_error().as_deref(),
                    Some("display_stage_handle_invalid")
                );
                assert!(!terminal.apply_staged_frame(handle, snapshot, 2));
                assert_eq!(
                    terminal.take_last_error().as_deref(),
                    Some("display_stage_handle_invalid")
                );
            }
            let handle = stage_test_frame(&mut terminal, &frame);
            assert_ne!(handle, 0);
            terminal.release_staged_frame(handle);
            assert!(!terminal.validate_staged_frame(handle));
            assert_eq!(
                terminal.take_last_error().as_deref(),
                Some("display_stage_handle_missing")
            );
            assert!(!terminal.apply_staged_frame(handle, snapshot, 2));
            assert_eq!(
                terminal.take_last_error().as_deref(),
                Some("display_stage_handle_missing")
            );
            terminal.release_staged_frame(handle);
            assert_eq!(
                terminal.take_last_error(),
                None,
                "release remains idempotent"
            );
        }
    }
}

#[test]
fn released_staging_slot_cannot_alias_two_queued_datagrams() {
    // This must also run under `cargo test --release`: debug assertions
    // used to own the free-list pop, so debug-only testing hid corruption.
    for compressed in [false, true] {
        let first = text_rows_frame(FrameKind::Delta, 8, 2, &[(0, 'a')]);
        let second = text_rows_frame(FrameKind::Delta, 8, 2, &[(1, 'b')]);
        let first = if compressed {
            compressed_test_frame(&first, None)
        } else {
            first
        };
        let second = if compressed {
            compressed_test_frame(&second, None)
        } else {
            second
        };
        let mut terminal = Terminal::new(8, 2);
        let warm = stage_test_frame(&mut terminal, &first);
        assert_ne!(warm, 0);
        terminal.release_staged_frame(warm);
        for round in 0..16 {
            // Both queue owners must stay alive before either applies.
            let a = stage_test_frame(&mut terminal, &first);
            let b = stage_test_frame(&mut terminal, &second);
            assert_ne!(a, 0);
            assert_ne!(b, 0);
            assert_ne!(a, b, "two queued datagrams aliased one staging slot");
            assert!(terminal.staged_frame_free_slots.is_empty());
            assert_eq!(terminal.staged_frames.len(), 2);
            let seq = round * 2 + 1;
            assert!(terminal.apply_presented_staged_delta_seq(b, seq + 1));
            terminal.release_staged_frame(b);
            assert!(terminal.apply_presented_staged_delta_seq(a, seq));
            terminal.release_staged_frame(a);
            assert_eq!(terminal.term.grid()[Point::new(Line(0), Column(0))].c, 'a');
            assert_eq!(terminal.term.grid()[Point::new(Line(1), Column(0))].c, 'b');
            assert_eq!(terminal.display_row_versions, [seq, seq + 1]);
            assert_eq!(terminal.staged_active_wire_bytes, 0);
            assert_eq!(terminal.staged_active_decoded_bytes, 0);
            assert_eq!(terminal.staged_active_decoded_cells, 0);
            assert!(terminal.staged_frames.iter().all(Option::is_none));
            assert_eq!(terminal.staged_frame_free_slots.len(), 2);
        }
    }
}

#[test]
fn staged_handles_use_a_bounded_lifo_free_slot_stack() {
    let frame = test_frame_with_entries(FrameKind::Delta, 1, 1, 0, 0, &[]);
    let mut terminal = Terminal::new(1, 1);
    let handles: Vec<u32> = (0..STAGED_FRAME_MAX)
        .map(|_| stage_test_frame(&mut terminal, &frame))
        .collect();
    assert!(handles.iter().all(|handle| *handle != 0));
    assert_eq!(terminal.staged_frames.len(), STAGED_FRAME_MAX);
    assert_eq!(stage_test_frame(&mut terminal, &frame), 0);
    assert_eq!(
        terminal.last_error.as_deref(),
        Some("display_stage_slot_limit")
    );

    for handle in handles.iter().copied() {
        terminal.release_staged_frame(handle);
    }
    assert_eq!(terminal.staged_frame_free_slots.len(), STAGED_FRAME_MAX);
    // Ascending release order makes the final slot the LIFO head.
    assert_eq!(
        stage_test_frame(&mut terminal, &frame),
        STAGED_FRAME_MAX as u32
    );
    assert_eq!(terminal.staged_frames.len(), STAGED_FRAME_MAX);
}

#[test]
fn regular_font_slots_share_one_parsed_font() {
    let regular = include_bytes!("../../../apps/web/public/fonts/JetBrainsMonoNF-Regular.ttf");
    let fonts = regular_font_aliases(load_font(regular));

    for font in &fonts[1..] {
        assert!(Rc::ptr_eq(&fonts[0], font));
    }
}

#[test]
fn invalid_style_faces_alias_the_regular_fallback() {
    let regular = include_bytes!("../../../apps/web/public/fonts/JetBrainsMonoNF-Regular.ttf");
    let fonts = load_fonts(regular, b"invalid", b"invalid", b"invalid");

    for font in &fonts[1..] {
        assert!(Rc::ptr_eq(&fonts[0], font));
    }
}

#[test]
fn terminal_font_parsing_skips_substitutions_but_keeps_direct_glyphs() {
    let regular = include_bytes!("../../../apps/web/public/fonts/JetBrainsMonoNF-Regular.ttf");
    assert!(!terminal_font_settings().load_substitutions);

    let font = load_font(regular);
    for character in ['M', '\u{e0b0}'] {
        assert_ne!(font.lookup_glyph_index(character), 0);
        let (metrics, bitmap) = font.rasterize(character, 14.0);
        assert!(metrics.width > 0);
        assert!(metrics.height > 0);
        assert_eq!(bitmap.len(), metrics.width * metrics.height);
    }
}

/// The eligible/predicted base cursor and journal, sampled as the worker
/// reads them; this does not include its UNSENT provisional cursor pass.
fn drawn_cursor(terminal: &mut Terminal) -> (u16, u16) {
    let _ = terminal.cursor_info_ptr();
    (terminal.cursor_info_buf[1], terminal.cursor_info_buf[0])
}

/// One journalled step: what caused it, where the cursor was, where it went.
type CursorStep = (CursorCause, (u16, u16), (u16, u16));

fn drain_cursor_motion(terminal: &mut Terminal) -> Vec<CursorStep> {
    let records: Vec<CursorStep> = terminal
        .cursor_motion
        .chunks_exact(CURSOR_MOTION_RECORD_WORDS)
        .map(|record| {
            let cause = *CursorCause::ALL
                .iter()
                .find(|cause| **cause as u32 == record[1])
                .expect("every journalled cause is nameable");
            (
                cause,
                ((record[2] >> 16) as u16, record[2] as u16),
                ((record[3] >> 16) as u16, record[3] as u16),
            )
        })
        .collect();
    terminal.clear_cursor_motion();
    records
}

/// A shell that refills the column an erase vacated still confirms it.
///
/// Every shell with autosuggestions does this: the frame that echoes the
/// Backspace also draws the recomputed suggestion, so the vacated column
/// holds the suggestion's first character rather than a blank — in the
/// worst case the very character that was erased, which is what the erased
/// one was completing. Requiring a blank there made that echo a
/// contradiction, and one Backspace ended speculative echo for the rest of
/// the line. What proves the erase happened is the typed prefix and the
/// cursor, and both are still checked exactly.
#[test]
fn an_erase_confirms_even_when_the_shell_refills_the_column_it_vacated() {
    let mut terminal = prediction_terminal(20, 2);
    train_shadow_text(&mut terminal, "ab");
    assert_ne!(terminal.predict_backspace(200.0, 3), 0);
    assert_eq!(terminal.predicted_cursor, (0, 1));

    // The echo: "a", then the suggestion redrawn from the cursor. Its first
    // character is the one just erased, so nothing about the cell contents
    // distinguishes "the erase happened" from "it did not" — only the
    // cursor does.
    let echoed: Vec<CellRepr> = "ab".chars().map(test_cell).collect();
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
            cells: &echoed,
        }],
    );
    assert!(terminal.apply_presented_delta_seq(&frame, 2));
    terminal.predict_reconcile(300.0, 500.0, 3, 3);
    assert_eq!(
        terminal.reconcile_stats[0], 1,
        "the erase was not confirmed: {:?}",
        terminal.reconcile_stats
    );
    assert!(
        terminal.shadow_line.is_some(),
        "the model was dropped by an echo that agreed with it"
    );

    // And the model stops claiming the column it vacated, so it cannot
    // paint a blank over the suggestion the shell put there.
    let line = terminal.shadow_line.as_ref().expect("line");
    assert_eq!(line.base.extent, line.base.cells.len());
    assert!(
        terminal
            .predictions
            .iter()
            .all(|prediction| prediction.col < 1),
        "the model still paints over a column the shell owns"
    );

    // The next keystroke models from that base rather than being refused.
    assert_ne!(terminal.predict_printable('c' as u32, 400.0, 4, true), 0);
}

/// An erase authority never performs is never credited, and is retired by
/// the lifetime.
///
/// The relaxation above gives up one thing and it is stated here rather
/// than left to be discovered: the vacated column used to escalate this
/// case to a contradiction at the grace deadline. It cannot be relied on
/// for that, because a shell that refills the column with the character it
/// just erased — the ordinary autosuggestion case, where the erased
/// character is the one the suggestion completes — is byte-identical to a
/// shell that never erased at all. Only the cursor separates them, and the
/// cursor branch deliberately waits rather than retracting, because a newer
/// header routinely precedes the terminal's echo. So the erase is held,
/// credited to nothing, and retired by its lifetime.
#[test]
fn an_erase_that_authority_never_performed_is_never_credited() {
    let mut terminal = prediction_terminal(20, 2);
    train_shadow_text(&mut terminal, "ab");
    assert_ne!(terminal.predict_backspace(200.0, 3), 0);

    // Authority echoes nothing: both characters still there, cursor still
    // past them. The erase did not happen.
    let echoed: Vec<CellRepr> = "ab".chars().map(test_cell).collect();
    let frame = test_frame_with_entries(
        FrameKind::Delta,
        20,
        2,
        2,
        0,
        &[RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &echoed,
        }],
    );
    assert!(terminal.apply_presented_delta_seq(&frame, 2));
    terminal.predict_reconcile(300.0, 500.0, 3, 3);
    assert_eq!(
        terminal.reconcile_stats[0], 0,
        "an unperformed erase was credited"
    );
    assert_eq!(
        terminal.reconcile_stats[5], 1,
        "an unperformed erase must be held for its own deadline, not resolved: {:?}",
        terminal.reconcile_stats
    );
    terminal.predict_reconcile(300.0 + PREDICTION_MISMATCH_GRACE_MS * 2.0, 500.0, 3, 3);
    assert_eq!(
        terminal.reconcile_stats[0], 0,
        "an unperformed erase was credited at the grace deadline"
    );

    // Past the lifetime, with authority having covered the input: retired
    // as evidence against it, which is what resets the worker's trust gate.
    terminal.predict_reconcile(200.0 + 501.0, 500.0, 3, 3);
    assert_eq!(
        terminal.reconcile_stats[2], 1,
        "the lifetime did not retire it as covered: {:?}",
        terminal.reconcile_stats
    );
    assert!(
        terminal.shadow_line.is_none(),
        "an unperformed erase left its projection standing past its lifetime"
    );
}

/// The journal is the only instrument that can tell a retraction from a
/// frame carrying the wrong cursor, so it needs its own oracle: one that
/// stops recording is indistinguishable from a bug that stopped happening.
#[test]
fn a_flush_while_a_prediction_is_outstanding_journals_the_site_that_flushed() {
    let mut terminal = prediction_terminal(20, 2);
    terminal.set_cursor_motion_journal(true);
    // Confirm one prediction so the model is the thing drawing the cursor.
    train_shadow_text(&mut terminal, "ab");
    assert_ne!(terminal.predict_printable('c' as u32, 3.0, 3, true), 0);
    assert_eq!(drawn_cursor(&mut terminal), (0, 3), "the model draws ahead");
    assert!(
        drain_cursor_motion(&mut terminal).is_empty(),
        "typing moved forwards"
    );

    terminal.predict_discard();
    assert_eq!(
        drawn_cursor(&mut terminal),
        (0, 2),
        "authority draws behind"
    );
    assert_eq!(
        drain_cursor_motion(&mut terminal),
        vec![(CursorCause::FlushExternal, (0, 3), (0, 2))],
        "the step must name the flush, not whatever ran after it"
    );
}

/// Authority moving its own cursor back is a different event with the same
/// pixel, and the journal has to separate them or it answers nothing.
#[test]
fn an_authoritative_cursor_that_moves_back_is_not_blamed_on_the_model() {
    let mut terminal = prediction_terminal(20, 2);
    terminal.set_cursor_motion_journal(true);
    let cells: Vec<CellRepr> = "abcd".chars().map(test_cell).collect();
    let ahead = test_frame_with_entries(
        FrameKind::Delta,
        20,
        2,
        4,
        0,
        &[RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &cells,
        }],
    );
    assert!(terminal.apply_presented_delta_seq(&ahead, 1));
    assert_eq!(drawn_cursor(&mut terminal), (0, 4));
    assert!(drain_cursor_motion(&mut terminal).is_empty());

    // The same row, with the cursor where a half-written repaint left it.
    let behind = test_frame_with_entries(
        FrameKind::Delta,
        20,
        2,
        0,
        0,
        &[RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &cells,
        }],
    );
    assert!(terminal.apply_presented_delta_seq(&behind, 2));
    assert_eq!(drawn_cursor(&mut terminal), (0, 0));
    assert_eq!(
        drain_cursor_motion(&mut terminal),
        vec![(CursorCause::AuthorityHeader, (0, 4), (0, 0))]
    );
}

fn with_scroll_serial(mut frame: Vec<u8>, serial: u32) -> Vec<u8> {
    frame[merkur_codec::DISPLAY_SCROLL_SERIAL_OFFSET
        ..merkur_codec::DISPLAY_SCROLL_SERIAL_OFFSET + 4]
        .copy_from_slice(&serial.to_be_bytes());
    frame
}

/// A line submitted on the bottom row scrolls the screen, and the next
/// prompt lands on the same row at a lower column. In content that is the
/// line below, which the journal must not report; the same motion with no
/// scroll is a step back, and a cursor whose line scrolled away has
/// nothing left to be behind.
#[test]
fn the_journal_reads_order_in_content_across_a_scroll() {
    let mut terminal = prediction_terminal(20, 2);
    terminal.set_cursor_motion_journal(true);
    let submitted: Vec<CellRepr> = "$ echo ok".chars().map(test_cell).collect();
    let prompt: Vec<CellRepr> = "$ ".chars().map(test_cell).collect();
    let row = |index: u16, cells: &'static [CellRepr]| RowRef {
        graphics: &[],
        row_index: index,
        left: 0,
        cells,
    };
    let submitted: &'static [CellRepr] = Box::leak(submitted.into_boxed_slice());
    let prompt: &'static [CellRepr] = Box::leak(prompt.into_boxed_slice());

    let typed = test_frame_with_entries(FrameKind::Delta, 20, 2, 9, 1, &[row(1, submitted)]);
    assert!(terminal.apply_presented_delta_seq(&with_scroll_serial(typed, 7), 1));
    assert_eq!(drawn_cursor(&mut terminal), (1, 9));

    let scrolled = test_frame_with_entries(
        FrameKind::Delta,
        20,
        2,
        2,
        1,
        &[row(0, submitted), row(1, prompt)],
    );
    assert!(terminal.apply_presented_delta_seq(&with_scroll_serial(scrolled, 8), 2));
    assert_eq!(drawn_cursor(&mut terminal), (1, 2));
    assert!(drain_cursor_motion(&mut terminal).is_empty());

    let back = test_frame_with_entries(FrameKind::Delta, 20, 2, 0, 1, &[row(1, prompt)]);
    assert!(terminal.apply_presented_delta_seq(&with_scroll_serial(back, 8), 3));
    assert_eq!(drawn_cursor(&mut terminal), (1, 0));
    assert_eq!(
        drain_cursor_motion(&mut terminal),
        vec![(CursorCause::AuthorityHeader, (1, 2), (1, 0))]
    );

    let away = test_frame_with_entries(FrameKind::Delta, 20, 2, 0, 0, &[row(0, prompt)]);
    assert!(terminal.apply_presented_delta_seq(&with_scroll_serial(away, 10), 4));
    assert_eq!(drawn_cursor(&mut terminal), (0, 0));
    assert!(drain_cursor_motion(&mut terminal).is_empty());
}

/// Off is off: the journal is a diagnostic and must cost nothing to a
/// session that has not asked for it, and arming it must not invent a step
/// out of a cursor position from before it was armed.
#[test]
fn a_disabled_journal_records_nothing_and_arming_it_starts_from_the_next_read() {
    let mut terminal = prediction_terminal(20, 2);
    train_shadow_text(&mut terminal, "ab");
    assert_ne!(terminal.predict_printable('c' as u32, 3.0, 3, true), 0);
    assert_eq!(drawn_cursor(&mut terminal), (0, 3));
    terminal.predict_discard();
    assert_eq!(drawn_cursor(&mut terminal), (0, 2));
    assert!(
        terminal.cursor_motion.is_empty(),
        "a disabled journal recorded a step"
    );

    // Arming it mid-session must not report the step that already happened,
    // and must report the next one.
    terminal.set_cursor_motion_journal(true);
    let cells: Vec<CellRepr> = "ab".chars().map(test_cell).collect();
    let row = |cursor_col: u16, seq: u32| {
        (
            test_frame_with_entries(
                FrameKind::Delta,
                20,
                2,
                cursor_col,
                0,
                &[RowRef {
                    graphics: &[],
                    row_index: 0,
                    left: 0,
                    cells: &cells,
                }],
            ),
            seq,
        )
    };
    let (ahead, ahead_seq) = row(2, 9);
    assert!(terminal.apply_presented_delta_seq(&ahead, ahead_seq));
    let _ = drawn_cursor(&mut terminal);
    assert!(terminal.cursor_motion.is_empty());
    let (behind, behind_seq) = row(0, 10);
    assert!(terminal.apply_presented_delta_seq(&behind, behind_seq));
    let _ = drawn_cursor(&mut terminal);
    assert_eq!(terminal.cursor_motion.len(), CURSOR_MOTION_RECORD_WORDS);
}

fn prediction_terminal(cols: u16, rows: u16) -> Terminal {
    let mut terminal = Terminal::new(cols, rows);
    terminal.display_mode = DISPLAY_MODE_PREDICTION_SAFE;
    terminal.commit_presentation_state();
    terminal
}

fn train_shadow_text(terminal: &mut Terminal, text: &str) {
    terminal.display_mode = DISPLAY_MODE_PREDICTION_SAFE;
    let cells: Vec<CellRepr> = text.chars().map(test_cell).collect();
    for (index, character) in text.chars().enumerate() {
        assert_ne!(
            terminal.predict_printable(character as u32, index as f64, index as u32 + 1, true),
            0
        );
    }
    let frame = test_frame_with_entries(
        FrameKind::Delta,
        terminal.cols(),
        terminal.rows(),
        clamp_usize_to_u16(cells.len()),
        0,
        &[RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &cells,
        }],
    );
    assert!(terminal.apply_presented_delta_seq(&frame, 1));
    terminal.predict_reconcile(100.0, 500.0, cells.len() as u32, cells.len() as u32);
    assert_eq!(terminal.reconcile_stats[0], cells.len() as u32);
    assert!(!terminal.has_predictions());
}

#[test]
fn hidden_mismatch_invalidates_epoch_before_later_matches_can_promote_it() {
    let mut terminal = prediction_terminal(6, 1);
    for (index, codepoint) in ['a', 'b', 'c', 'd', 'e'].into_iter().enumerate() {
        assert_ne!(
            terminal.predict_printable(codepoint as u32, 0.0, index as u32 + 1, true),
            0
        );
    }

    let authoritative = [
        test_cell('x'),
        test_cell('b'),
        test_cell('c'),
        test_cell('d'),
    ];
    let frame = test_frame_with_entries(
        FrameKind::Delta,
        6,
        1,
        4,
        0,
        &[RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &authoritative,
        }],
    );
    assert!(terminal.apply_presented_delta_seq(&frame, 1));

    terminal.predict_reconcile(100.0, 500.0, 4, 4);
    assert_eq!(terminal.reconcile_stats, [0, 0, 0, 0, 0, 1, 0]);
    assert!(terminal.has_predictions());
    terminal.predict_reconcile(119.0, 500.0, 4, 4);

    assert!(!terminal.has_predictions());
    assert!(!terminal.has_visible_predictions_internal());
    // The covered prefix contradicted authority, so the dependent shadow
    // suffix is abandoned as one localized rollback.
    assert_eq!(terminal.reconcile_stats, [0, 1, 0, 0, 4, 0, 0]);
    assert_eq!(terminal.confirmed_epoch, 0);
}

#[test]
fn hidden_matches_train_epoch_without_claiming_a_visible_render() {
    let mut terminal = prediction_terminal(6, 1);
    for (index, codepoint) in ['a', 'b', 'c', 'd', 'e'].into_iter().enumerate() {
        assert_ne!(
            terminal.predict_printable(codepoint as u32, 0.0, index as u32 + 1, false),
            0
        );
    }

    let authoritative = [
        test_cell('a'),
        test_cell('b'),
        test_cell('c'),
        test_cell('d'),
    ];
    let frame = test_frame_with_entries(
        FrameKind::Delta,
        6,
        1,
        4,
        0,
        &[RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &authoritative,
        }],
    );
    assert!(terminal.apply_presented_delta_seq(&frame, 1));

    terminal.predict_reconcile(100.0, 500.0, 4, 4);

    assert_eq!(terminal.reconcile_stats, [4, 0, 0, 0, 0, 0, 0]);
    assert!(terminal.has_predictions());
    assert!(!terminal.has_visible_predictions_internal());
    assert!(!terminal.prediction_render_dirty());

    // The gate gets its next say when the line is flushed, which every
    // non-predictable key already does. A line admitted visible then paints
    // — the trained epoch is not what was withholding it.
    terminal.predict_discard();
    terminal.confirmed_epoch = terminal.prediction_epoch;
    assert_ne!(terminal.predict_printable('z' as u32, 0.0, 6, true), 0);
    assert!(terminal.has_visible_predictions_internal());
    assert!(terminal.prediction_render_dirty());
}

#[test]
fn same_geometry_snapshot_flushes_shadow_lineage() {
    let mut terminal = prediction_terminal(6, 1);
    for (index, codepoint) in ['a', 'b', 'c', 'd', 'e'].into_iter().enumerate() {
        assert_ne!(
            terminal.predict_printable(codepoint as u32, 0.0, index as u32 + 1, true),
            0
        );
    }

    let prediction_epoch = terminal.prediction_epoch;
    let authoritative = [
        test_cell('a'),
        test_cell('b'),
        test_cell('c'),
        test_cell('d'),
        test_cell(' '),
    ];
    let frame = test_frame_with_entries(
        FrameKind::Snapshot,
        6,
        1,
        4,
        0,
        &[RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &authoritative,
        }],
    );
    terminal.reset_display_ordering();
    assert!(terminal.apply_presented_state_seq(&frame, 0));

    assert!(!terminal.has_predictions());
    assert!(terminal.shadow_line.is_none());
    assert_ne!(terminal.prediction_epoch, prediction_epoch);
}

#[test]
fn sparse_unrelated_row_cannot_contradict_prediction_via_global_cursor() {
    let mut terminal = prediction_terminal(6, 2);
    assert_ne!(terminal.predict_printable('a' as u32, 0.0, 1, true), 0);
    assert_ne!(terminal.predict_printable('b' as u32, 1.0, 2, true), 0);

    // This models a reliable repair of stale text on another row. Display
    // headers necessarily carry the current global cursor, but row 0 is
    // absent and therefore provides no evidence about either prediction.
    let repaired_row = [test_cell(' ')];
    let repair = test_frame_with_entries(
        FrameKind::Delta,
        6,
        2,
        2,
        0,
        &[RowRef {
            graphics: &[],
            row_index: 1,
            left: 0,
            cells: &repaired_row,
        }],
    );
    assert!(terminal.apply_presented_delta_seq(&repair, 1));
    terminal.predict_reconcile(100.0, 500.0, 0, 0);
    assert_eq!(terminal.reconcile_stats, [0, 0, 0, 0, 0, 0, 0]);
    assert_eq!(terminal.predictions.len(), 2);

    let authoritative = [test_cell('a')];
    let echo = test_frame_with_entries(
        FrameKind::Delta,
        6,
        2,
        1,
        0,
        &[RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &authoritative,
        }],
    );
    assert!(terminal.apply_presented_delta_seq(&echo, 2));
    terminal.predict_reconcile(110.0, 500.0, 1, 1);
    assert_eq!(terminal.reconcile_stats, [1, 0, 0, 0, 0, 0, 0]);
    assert_eq!(terminal.predictions.len(), 1);
    assert_eq!(terminal.predictions[0].input_seq, 2);
}

#[test]
fn exact_cell_match_clears_overlay_without_noncausal_trust_credit() {
    let mut terminal = Terminal::new(6, 1);
    let initial = [test_cell(' '); 6];
    let initial_frame = test_frame_with_entries(
        FrameKind::Snapshot,
        6,
        1,
        2,
        0,
        &[RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &initial,
        }],
    );
    assert!(terminal.apply_presented_state_seq(&initial_frame, 1));

    let epoch = terminal.predict_printable('x' as u32, 0.0, 7, true);
    assert_ne!(epoch, 0);
    terminal.confirmed_epoch = epoch;
    assert!(terminal.has_visible_predictions_internal());
    terminal.prediction_render_dirty = false;

    // The exact cell may remove a redundant glyph overlay, but it is not
    // causal confirmation until the authenticated input high-water covers
    // input 7 and the authoritative cursor matches the full shadow state.
    let matched = [test_cell('x')];
    let matched_frame = test_frame_with_entries(
        FrameKind::Delta,
        6,
        1,
        2,
        0,
        &[RowRef {
            graphics: &[],
            row_index: 0,
            left: 2,
            cells: &matched,
        }],
    );
    assert!(terminal.apply_presented_delta_seq(&matched_frame, 2));
    terminal.predict_reconcile(100.0, 500.0, 0, 0);

    assert_eq!(terminal.reconcile_stats, [0, 0, 0, 0, 0, 0, 0]);
    assert!(terminal.has_predictions());
    assert!(terminal.has_visible_predictions_internal());
    assert!(terminal.prediction_render_dirty());

    // A later cursor-only update becomes exact only when its frame's
    // authenticated input high-water covers the edit.
    let unrelated = [test_cell(' ')];
    let unrelated_frame = test_frame_with_entries(
        FrameKind::Delta,
        6,
        1,
        3,
        0,
        &[RowRef {
            graphics: &[],
            row_index: 0,
            left: 5,
            cells: &unrelated,
        }],
    );
    assert!(terminal.apply_presented_delta_seq(&unrelated_frame, 3));
    terminal.predict_reconcile(110.0, 500.0, 7, 7);
    assert_eq!(terminal.reconcile_stats, [1, 0, 0, 0, 0, 0, 0]);
    assert!(!terminal.has_predictions());
}

#[test]
fn high_water_ahead_of_echo_holds_without_confirming_or_rolling_back() {
    let mut terminal = terminal_with_atlas(6, 1);
    terminal.confirmed_epoch = terminal.prediction_epoch;
    assert_ne!(terminal.predict_printable('x' as u32, 0.0, 1, true), 0);
    terminal.build_presented_geometry();
    assert_eq!(terminal.visible_prediction_input_seqs, [1]);
    assert_eq!(terminal.predicted_cursor, (0, 1));

    // PTY master write completion can advance input high-water before the
    // slave emits echo. This header-only frame is coverage, not cell or
    // cursor authority for the edit — and coverage contradicts nothing, so
    // the glyph and the cursor stay exactly where they are.
    let header_only = test_frame_with_entries(FrameKind::Delta, 6, 1, 0, 0, &[]);
    assert!(terminal.apply_presented_delta_seq(&header_only, 1));
    terminal.predict_reconcile(10.0, 500.0, 1, 1);
    // Deferred, not credited and not rolled back: the worker re-examines at
    // its own deadline so the lifetime stays the exact bound.
    assert_eq!(terminal.reconcile_stats, [0, 0, 0, 0, 0, 1, 0]);
    assert!(terminal.has_predictions());
    assert!(terminal.has_visible_predictions_internal());
    terminal.build_presented_geometry();
    assert_eq!(terminal.visible_prediction_input_seqs, [1]);
    assert_eq!(terminal.predicted_cursor, (0, 1));
    terminal.cursor_info_ptr();
    assert_eq!(&terminal.cursor_info_buf[..2], &[1, 0]);

    let echoed = [test_cell('x')];
    let echo = test_frame_with_entries(
        FrameKind::Delta,
        6,
        1,
        1,
        0,
        &[RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &echoed,
        }],
    );
    assert!(terminal.apply_presented_delta_seq(&echo, 2));
    terminal.predict_reconcile(20.0, 500.0, 1, 1);
    assert_eq!(terminal.reconcile_stats, [1, 0, 0, 0, 0, 0, 0]);
    assert!(!terminal.has_predictions());
}

#[test]
fn coverage_without_echo_still_admits_the_next_keystroke() {
    let mut terminal = terminal_with_atlas(6, 1);
    terminal.confirmed_epoch = terminal.prediction_epoch;
    assert_ne!(terminal.predict_printable('x' as u32, 0.0, 1, true), 0);

    let header_only = test_frame_with_entries(FrameKind::Delta, 6, 1, 0, 0, &[]);
    assert!(terminal.apply_presented_delta_seq(&header_only, 1));
    terminal.predict_reconcile(10.0, 500.0, 1, 1);

    // Refusing to seed here rejected the key, which opens the browser's
    // causal barrier and withdraws the wire provenance the daemon reads as
    // "unmodelled" — losing prediction for the rest of the line over a
    // frame that proved nothing.
    assert_ne!(terminal.predict_printable('y' as u32, 1.0, 2, true), 0);
    assert_eq!(terminal.predicted_cursor, (0, 2));
}

/// Accepting an autosuggestion one character at a time: the glyph is
/// already on the row, so its echo changes no cell and the daemon sends
/// only the cursor move. That move, at exactly the projected column with
/// the row reading as projected, is the echo and confirms the op.
#[test]
fn an_echo_that_only_moves_the_cursor_over_an_identical_glyph_confirms_the_op() {
    let mut terminal = terminal_with_atlas(8, 1);
    let suggested = [test_cell('a'), test_cell('b'), test_cell('c')];
    let suggestion = test_frame_with_entries(
        FrameKind::Delta,
        8,
        1,
        0,
        0,
        &[RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &suggested,
        }],
    );
    assert!(terminal.apply_presented_delta_seq(&suggestion, 1));
    // The prompt-end anchor is what lets a line with a non-blank tail seed.
    terminal.set_editor_anchor(1, 0, 0, 1);
    terminal.commit_presentation_state();
    terminal.confirmed_epoch = terminal.prediction_epoch;
    assert_ne!(
        terminal.predict_printable('a' as u32, 0.0, 1, true),
        0,
        "refused: {} :: {}",
        cursor_cause_name(terminal.last_flush_cause()),
        terminal.shadow_debug()
    );
    assert_eq!(terminal.predicted_cursor, (0, 1));

    // The watermark advertisement that can overtake the echo: a newer
    // header, cursor still at the old column. Coverage, not evidence.
    let advertised = test_frame_with_entries(FrameKind::Delta, 8, 1, 0, 0, &[]);
    assert!(terminal.apply_presented_delta_seq(&advertised, 2));
    terminal.predict_reconcile(10.0, 500.0, 1, 1);
    assert_eq!(terminal.reconcile_stats, [0, 0, 0, 0, 0, 1, 0]);
    assert!(terminal.has_predictions());

    // The echo: no cell changed, the cursor moved past the glyph.
    let echoed = test_frame_with_entries(FrameKind::Delta, 8, 1, 1, 0, &[]);
    assert!(terminal.apply_presented_delta_seq(&echoed, 3));
    terminal.predict_reconcile(20.0, 500.0, 1, 1);
    assert_eq!(terminal.reconcile_stats, [1, 0, 0, 0, 0, 0, 0]);
    assert!(!terminal.has_predictions());

    // And the next key seeds onto the confirmed base without a flush.
    assert_ne!(terminal.predict_printable('b' as u32, 30.0, 2, true), 0);
    assert_eq!(terminal.predicted_cursor, (0, 2));
}

/// A prompt anchor that lands after the prompt's own frame was presented.
///
/// The anchor rides the reliable lane; the frame that drew the prompt is a
/// datagram. Under delay the order routinely flips, and nothing presents
/// the late anchor until the next display frame, so the first key of the
/// line was refused and — typed faster than the path — every key behind it
/// was fenced. With nothing held the anchor is presented on arrival.
#[test]
fn an_anchor_arriving_after_its_presented_frame_seeds_at_once() {
    let mut terminal = terminal_with_atlas(8, 1);
    let prompt = [test_cell('$'), test_cell(' ')];
    let frame = test_frame_with_entries(
        FrameKind::Delta,
        8,
        1,
        2,
        0,
        &[RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &prompt,
        }],
    );
    assert!(terminal.apply_presented_delta_seq(&frame, 1));
    terminal.set_editor_anchor(1, 0, 2, 1);
    terminal.confirmed_epoch = terminal.prediction_epoch;
    assert_ne!(
        terminal.predict_printable('a' as u32, 0.0, 1, true),
        0,
        "refused: {}",
        cursor_cause_name(terminal.last_flush_cause())
    );
    assert_eq!(terminal.predicted_cursor, (0, 3));

    // But an anchor that arrives while its own row is still held waits for
    // the commit that presents it.
    let mut held = terminal_with_atlas(8, 1);
    assert!(held.apply_delta_seq(&frame, 1));
    held.set_editor_anchor(1, 0, 2, 1);
    held.confirmed_epoch = held.prediction_epoch;
    assert_eq!(held.predict_printable('a' as u32, 0.0, 1, true), 0);
    assert_eq!(
        held.last_flush_cause(),
        CursorCause::FlushAnchorNotPresented as u32
    );
    held.commit_presentation_state();
    assert_ne!(held.predict_printable('a' as u32, 1.0, 2, true), 0);

    // A row held elsewhere — a status line whose datagram is in repair —
    // does not hold the prompt hostage.
    let mut status = terminal_with_atlas(8, 2);
    let prompt_frame = test_frame_with_entries(
        FrameKind::Delta,
        8,
        2,
        2,
        0,
        &[RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &prompt,
        }],
    );
    assert!(status.apply_presented_delta_seq(&prompt_frame, 1));
    let status_cells = [test_cell('['), test_cell('0'), test_cell(']')];
    let status_frame = test_frame_with_entries(
        FrameKind::Delta,
        8,
        2,
        2,
        0,
        &[RowRef {
            graphics: &[],
            row_index: 1,
            left: 0,
            cells: &status_cells,
        }],
    );
    assert!(status.apply_delta_seq(&status_frame, 2));
    status.set_editor_anchor(1, 0, 2, 1);
    status.confirmed_epoch = status.prediction_epoch;
    assert_ne!(
        status.predict_printable('a' as u32, 0.0, 1, true),
        0,
        "refused: {}",
        cursor_cause_name(status.last_flush_cause())
    );
}

#[test]
fn a_gate_that_closes_mid_line_retracts_nothing() {
    let mut terminal = terminal_with_atlas(8, 1);
    terminal.confirmed_epoch = terminal.prediction_epoch;
    assert_ne!(terminal.predict_printable('x' as u32, 0.0, 1, true), 0);
    terminal.build_presented_geometry();
    assert_eq!(terminal.visible_prediction_input_seqs, [1]);
    assert_eq!(terminal.predicted_cursor, (0, 1));

    // The gate closed between keystrokes. Its inputs — a smoothed rtt, a
    // paint floor, a trust window — say nothing about the glyph already on
    // screen, so the line keeps the decision it was seeded with and the
    // cursor does not walk backwards over text the user can see.
    assert_ne!(terminal.predict_printable('y' as u32, 1.0, 2, false), 0);
    terminal.build_presented_geometry();
    assert_eq!(terminal.visible_prediction_input_seqs, [1, 2]);
    assert_eq!(terminal.predicted_cursor, (0, 2));
    terminal.cursor_info_ptr();
    assert_eq!(&terminal.cursor_info_buf[..2], &[2, 0]);
}

#[test]
fn placeholder_cells_keep_backgrounds_without_rasterizing_ids_or_decorations() {
    let mut terminal = terminal_with_atlas(2, 1);
    let mut cell = test_cell(merkur_graphics::placeholder::PLACEHOLDER);
    cell.fg = [0, 0, 42];
    cell.bg = [0, 0, 255];
    cell.attrs = cell
        .attrs
        .with(merkur_codec::CellAttrs::INVERSE, true)
        .with(merkur_codec::CellAttrs::UNDERLINE, true);
    let frame = test_frame_with_entries(
        FrameKind::Delta,
        2,
        1,
        0,
        0,
        &[RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &[cell],
        }],
    );
    assert!(terminal.apply_presented_delta_seq(&frame, 1));
    terminal.build_presented_geometry();
    assert!(terminal.row_geometry[0].glyph.is_empty());
    assert!(terminal.row_geometry[0].deco.is_empty());
    assert_eq!(terminal.row_geometry[0].bg.len(), 7);
    assert_eq!(&terminal.row_geometry[0].bg[4..7], &[0.0, 0.0, 1.0]);
    assert_eq!(
        terminal.row_hash(0),
        merkur_codec::row_hash(&[cell, test_cell(' ')])
    );
}

/// A submission seals the line and the echo still confirms it.
///
/// Enter is never modelled, and it used to flush the line: every glyph
/// whose echo was still in flight came off the screen and the cursor
/// followed it back, for one round trip. The 2026-09-07 report. Sealed,
/// the line admits nothing further, publishes nothing admissible to main,
/// and keeps its glyphs until the row reads as projected — wherever the
/// shell has since put the cursor.
#[test]
fn a_submission_seals_the_line_and_the_echo_still_confirms_it() {
    let mut terminal = terminal_with_atlas(8, 1);
    terminal.set_presented_editor_anchor(1, 0, 0, 1);
    terminal.confirmed_epoch = terminal.prediction_epoch;
    assert_ne!(terminal.predict_printable('a' as u32, 0.0, 1, true), 0);
    assert_ne!(terminal.predict_printable('b' as u32, 1.0, 2, true), 0);
    terminal.build_presented_geometry();
    assert_eq!(terminal.visible_prediction_input_seqs, [1, 2]);
    assert_eq!(terminal.predicted_cursor, (0, 2));

    terminal.predict_seal(3);
    assert!(terminal.has_predictions());
    assert_eq!(
        terminal.shadow_line.as_ref().and_then(|line| line.sealed),
        Some(CursorCause::SealExternal)
    );
    // Nothing typed behind the submission is modelled, and the refusal
    // takes nothing back either.
    assert_eq!(terminal.predict_printable('c' as u32, 2.0, 4, true), 0);
    assert_eq!(terminal.last_flush_cause(), CursorCause::LineSealed as u32);
    terminal.build_presented_geometry();
    assert_eq!(terminal.visible_prediction_input_seqs, [1, 2]);
    assert_eq!(terminal.predicted_cursor, (0, 2));
    terminal.cursor_info_ptr();
    assert_eq!(&terminal.cursor_info_buf[..2], &[2, 0]);
    terminal.prediction_model_ptr();
    assert_eq!(terminal.prediction_model_buf[0], 0);

    // CTRL anchor withdrawal can overtake both the display grant change
    // and the final echo. Neither its arrival nor presentation can retract
    // glyphs already painted before the submission sealed the line.
    terminal.set_editor_anchor(2, 0, 0, 0);
    terminal.build_presented_geometry();
    assert_eq!(terminal.visible_prediction_input_seqs, [1, 2]);
    assert_eq!(terminal.predicted_cursor, (0, 2));
    assert!(terminal.has_predictions());
    assert_eq!(terminal.predict_printable('c' as u32, 3.0, 4, true), 0);

    // A new prompt on CTRL can overtake that same display echo too. It
    // changes future admission, never the already sealed projected row.
    terminal.set_editor_anchor(3, 0, 4, 1);
    terminal.build_presented_geometry();
    assert_eq!(terminal.visible_prediction_input_seqs, [1, 2]);
    assert_eq!(terminal.predicted_cursor, (0, 2));
    assert_eq!(terminal.predict_printable('c' as u32, 4.0, 4, true), 0);

    // The daemon's revocation on the unmodelled key overtakes the echo: a
    // header with the grant withdrawn and nothing else. Sealed, the line
    // keeps its glyphs for the echo it is still owed.
    terminal.apply_display_header(PendingDisplayHeader {
        seq: 1,
        cursor_col: 2,
        cursor_row: 0,
        cursor_shape: CURSOR_SHAPE_BLOCK,
        cursor_visible: 1,
        mode_flags: 0,
        scroll_serial: 0,
    });
    assert!(terminal.has_predictions());
    terminal.predict_reconcile(10.0, 500.0, 3, 3);
    assert!(terminal.has_predictions());

    // The echo, with the cursor wherever the shell put it after the
    // submission: the cells are the evidence and both ops confirm.
    let echoed = [test_cell('a'), test_cell('b')];
    let echo = test_frame_with_entries(
        FrameKind::Delta,
        8,
        1,
        0,
        0,
        &[RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &echoed,
        }],
    );
    assert!(terminal.apply_presented_delta_seq(&echo, 2));
    terminal.predict_reconcile(20.0, 500.0, 3, 3);
    assert_eq!(terminal.reconcile_stats, [2, 0, 0, 0, 0, 0, 0]);
    assert!(!terminal.has_predictions());
    assert!(terminal.shadow_line.is_none());
}

/// A sealed line the shell transforms is finished, not contradicted.
///
/// Ctrl-U, a paste, a completion: the input that sealed the line rewrites
/// the row, and authority already shows the result. That is not a wrong
/// prediction and must not reset the trust gate the way a real mismatch does.
#[test]
fn a_sealed_line_the_shell_transforms_is_finished_without_a_contradiction() {
    let mut terminal = terminal_with_atlas(8, 1);
    terminal.confirmed_epoch = terminal.prediction_epoch;
    assert_ne!(terminal.predict_printable('a' as u32, 0.0, 1, true), 0);
    assert_ne!(terminal.predict_printable('b' as u32, 1.0, 2, true), 0);
    terminal.predict_seal(3);
    let cleared = [test_cell(' '), test_cell(' ')];
    let frame = test_frame_with_entries(
        FrameKind::Delta,
        8,
        1,
        0,
        0,
        &[RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &cleared,
        }],
    );
    assert!(terminal.apply_presented_delta_seq(&frame, 1));
    terminal.predict_reconcile(10.0, 500.0, 3, 3);
    assert_eq!(terminal.reconcile_stats, [0, 0, 0, 0, 2, 0, 0]);
    assert!(!terminal.has_predictions());
    assert_eq!(
        terminal.last_flush_cause(),
        CursorCause::FlushSealResolved as u32
    );
}

/// A sealed line reads authority as an open one until a grid could show
/// what the sealing input did.
///
/// The last glyph and Enter leave in one burst, and a frame captured after
/// both writes completed but before the shell echoed the glyph covers
/// Enter by the input watermark. Only its echo horizon says the grid
/// cannot show Enter's result yet: taking the glyph back then stepped the
/// cursor back one column until the echo landed, which is
/// `terminal-cursor-motion`'s submit spec. Once the horizon covers Enter,
/// the same row is Enter's result, or Ctrl-W's, and the line is finished.
#[test]
fn a_sealed_line_reads_a_lagging_echo_as_lag_until_the_seal_is_answerable() {
    for answerable in [false, true] {
        let mut terminal = terminal_with_atlas(8, 1);
        terminal.confirmed_epoch = terminal.prediction_epoch;
        assert_ne!(terminal.predict_printable('a' as u32, 0.0, 1, true), 0);
        assert_ne!(terminal.predict_printable('b' as u32, 1.0, 2, true), 0);
        terminal.predict_seal(3);

        // The first echo, delivered with the second glyph's cell still
        // blank. Every write is complete; the echo of `b` is not.
        let first = [test_cell('a'), test_cell(' ')];
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
                cells: &first,
            }],
        );
        assert!(terminal.apply_presented_delta_seq(&frame, 1));
        let horizon = if answerable { 3 } else { 2 };
        terminal.predict_reconcile(10.0, 500.0, 3, horizon);
        if answerable {
            assert_eq!(terminal.reconcile_stats, [0, 0, 0, 0, 2, 0, 0]);
            assert!(!terminal.has_predictions());
            assert_eq!(
                terminal.last_flush_cause(),
                CursorCause::FlushSealResolved as u32
            );
            continue;
        }
        assert_eq!(terminal.reconcile_stats, [1, 0, 0, 0, 0, 0, 0]);
        // Reading the same frame again waits on the unechoed glyph.
        terminal.predict_reconcile(15.0, 500.0, 3, 2);
        assert_eq!(terminal.reconcile_stats, [0, 0, 0, 0, 0, 1, 0]);
        terminal.build_presented_geometry();
        assert_eq!(terminal.visible_prediction_input_seqs, [2]);
        assert_eq!(terminal.predicted_cursor, (0, 2));
        terminal.cursor_info_ptr();
        assert_eq!(&terminal.cursor_info_buf[..2], &[2, 0]);

        // The echo and the submission: wherever the cursor went, the
        // cells confirm the glyph and the line is finished.
        let echoed = [test_cell('b')];
        let echo = test_frame_with_entries(
            FrameKind::Delta,
            8,
            1,
            0,
            0,
            &[RowRef {
                graphics: &[],
                row_index: 0,
                left: 1,
                cells: &echoed,
            }],
        );
        assert!(terminal.apply_presented_delta_seq(&echo, 2));
        terminal.predict_reconcile(20.0, 500.0, 3, 3);
        assert_eq!(terminal.reconcile_stats, [1, 0, 0, 0, 0, 0, 0]);
        assert!(!terminal.has_predictions());
        assert!(terminal.shadow_line.is_none());
    }
}

/// A sealed line the shell transforms is finished when the result is
/// drawn, not when it is received.
///
/// Finishing it on received authority put the presented row back on
/// screen, the one without the glyphs, until the transformed row's
/// presentation committed, with the cursor stepping back to match.
#[test]
fn a_transformed_sealed_line_is_finished_only_once_its_row_is_drawn() {
    let mut terminal = terminal_with_atlas(8, 1);
    terminal.confirmed_epoch = terminal.prediction_epoch;
    assert_ne!(terminal.predict_printable('a' as u32, 0.0, 1, true), 0);
    assert_ne!(terminal.predict_printable('b' as u32, 1.0, 2, true), 0);
    terminal.predict_seal(3);
    let cleared = [test_cell(' '), test_cell(' ')];
    let frame = test_frame_with_entries(
        FrameKind::Delta,
        8,
        1,
        0,
        0,
        &[RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &cleared,
        }],
    );
    assert!(terminal.apply_delta_seq(&frame, 1));
    terminal.predict_reconcile(10.0, 500.0, 3, 3);
    assert_eq!(terminal.reconcile_stats, [0, 0, 0, 0, 0, 1, 0]);
    assert!(terminal.has_predictions());
    terminal.build_presented_geometry();
    assert_eq!(terminal.visible_prediction_input_seqs, [1, 2]);
    assert_eq!(terminal.predicted_cursor, (0, 2));

    terminal.commit_presentation_state();
    terminal.predict_reconcile(20.0, 500.0, 3, 3);
    assert_eq!(terminal.reconcile_stats, [0, 0, 0, 0, 2, 0, 0]);
    assert!(!terminal.has_predictions());
    assert_eq!(
        terminal.last_flush_cause(),
        CursorCause::FlushSealResolved as u32
    );
}

/// A withdrawn grant this browser did not cause still drops an open line.
#[test]
fn a_revocation_drops_an_open_line_and_keeps_a_sealed_one() {
    for sealed in [false, true] {
        let mut terminal = terminal_with_atlas(8, 1);
        terminal.confirmed_epoch = terminal.prediction_epoch;
        assert_ne!(terminal.predict_printable('a' as u32, 0.0, 1, true), 0);
        if sealed {
            terminal.predict_seal(2);
        }
        terminal.apply_display_header(PendingDisplayHeader {
            seq: 1,
            cursor_col: 1,
            cursor_row: 0,
            cursor_shape: CURSOR_SHAPE_BLOCK,
            cursor_visible: 1,
            mode_flags: 0,
            scroll_serial: 0,
        });
        assert_eq!(terminal.has_predictions(), sealed, "sealed={sealed}");
        if !sealed {
            assert_eq!(
                terminal.last_flush_cause(),
                CursorCause::FlushModeRevoked as u32
            );
        }
    }
}

/// Sealing a line with nothing on screen just drops it.
#[test]
fn sealing_a_line_with_nothing_painted_drops_it() {
    let mut terminal = terminal_with_atlas(8, 1);
    terminal.confirmed_epoch = terminal.prediction_epoch;
    // Admitted hidden: modelled, never painted.
    assert_ne!(terminal.predict_printable('a' as u32, 0.0, 1, false), 0);
    terminal.predict_seal(2);
    assert!(terminal.shadow_line.is_none());
    assert_eq!(
        terminal.last_flush_cause(),
        CursorCause::SealExternal as u32
    );
}

#[test]
fn a_caught_up_line_re_takes_the_gate_without_moving_a_pixel() {
    let mut terminal = terminal_with_atlas(8, 1);
    terminal.confirmed_epoch = terminal.prediction_epoch;
    assert_ne!(terminal.predict_printable('x' as u32, 0.0, 1, false), 0);
    terminal.build_presented_geometry();
    assert!(terminal.visible_prediction_input_seqs.is_empty());

    // Authority catches up: the op drains, the line holds nothing
    // outstanding, and what is on screen is authority's own row.
    let echoed = [test_cell('x')];
    let echo = test_frame_with_entries(
        FrameKind::Delta,
        8,
        1,
        1,
        0,
        &[RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &echoed,
        }],
    );
    assert!(terminal.apply_presented_delta_seq(&echo, 1));
    terminal.predict_reconcile(10.0, 500.0, 1, 1);
    assert!(!terminal.has_predictions());

    // Nothing is displayed at that instant, so admitting the line costs no
    // visual step — the gate does not have to wait for a flush.
    terminal.confirmed_epoch = terminal.prediction_epoch;
    assert_ne!(terminal.predict_printable('y' as u32, 1.0, 2, true), 0);
    terminal.build_presented_geometry();
    assert_eq!(terminal.visible_prediction_input_seqs, [2]);
}

#[test]
fn a_line_seeded_while_the_gate_is_closed_stays_hidden() {
    let mut terminal = terminal_with_atlas(8, 1);
    terminal.confirmed_epoch = terminal.prediction_epoch;
    assert_ne!(terminal.predict_printable('x' as u32, 0.0, 1, false), 0);
    // The model still runs — hidden predictions are what train the trust
    // window — but nothing is painted and the cursor stays authoritative.
    assert!(terminal.has_predictions());
    terminal.build_presented_geometry();
    assert!(terminal.visible_prediction_input_seqs.is_empty());
    terminal.cursor_info_ptr();
    assert_eq!(&terminal.cursor_info_buf[..2], &[0, 0]);

    // Re-opening mid-line does not reveal it either: revealing is a jump in
    // the other direction, and the flush that ends the line is the boundary
    // the gate acts on.
    assert_ne!(terminal.predict_printable('y' as u32, 1.0, 2, true), 0);
    terminal.build_presented_geometry();
    assert!(terminal.visible_prediction_input_seqs.is_empty());
}

#[test]
fn an_unsafe_mode_still_retracts_everything_immediately() {
    let mut terminal = terminal_with_atlas(6, 1);
    terminal.confirmed_epoch = terminal.prediction_epoch;
    assert_ne!(terminal.predict_printable('x' as u32, 0.0, 1, true), 0);
    assert!(terminal.has_visible_predictions_internal());

    // The daemon's prediction-safe grant is the security boundary, and it
    // is the one signal that still drops painted predictions on sight.
    terminal.apply_display_header(PendingDisplayHeader {
        seq: 1,
        cursor_col: 0,
        cursor_row: 0,
        cursor_shape: CURSOR_SHAPE_BLOCK,
        cursor_visible: 1,
        mode_flags: 0,
        scroll_serial: 0,
    });
    assert!(!terminal.has_predictions());
    assert!(terminal.shadow_line.is_none());
}

#[test]
fn stale_recovery_row_gets_one_grace_window_for_the_real_echo() {
    let mut terminal = terminal_with_atlas(6, 1);
    terminal.confirmed_epoch = terminal.prediction_epoch;
    assert_ne!(terminal.predict_printable('x' as u32, 0.0, 1, true), 0);
    terminal.build_presented_geometry();
    assert!(terminal.has_visible_predictions_internal());

    // PTY completion stamped input 1, but this recovered row was encoded
    // from the pre-echo blank terminal state. Its fresh cell/header
    // revisions are not sufficient to call the model wrong immediately.
    let stale = [test_cell(' ')];
    let stale_frame = test_frame_with_entries(
        FrameKind::Delta,
        6,
        1,
        0,
        0,
        &[RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &stale,
        }],
    );
    assert!(terminal.apply_presented_delta_seq(&stale_frame, 1));
    terminal.predict_reconcile(10.0, 500.0, 1, 1);
    assert_eq!(terminal.reconcile_stats, [0, 0, 0, 0, 0, 1, 0]);
    assert!(terminal.has_predictions());
    assert!(terminal.has_visible_predictions_internal());

    // The correcting echo arrives inside the bounded grace window and
    // confirms the same action without a transient rollback.
    let echoed = [test_cell('x')];
    let echo_frame = test_frame_with_entries(
        FrameKind::Delta,
        6,
        1,
        1,
        0,
        &[RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &echoed,
        }],
    );
    assert!(terminal.apply_presented_delta_seq(&echo_frame, 2));
    terminal.predict_reconcile(20.0, 500.0, 1, 1);
    assert_eq!(terminal.reconcile_stats, [1, 0, 0, 0, 0, 0, 0]);
    assert!(!terminal.has_predictions());
}

#[test]
fn post_flush_password_input_and_unknown_modes_never_become_visible() {
    let mut terminal = terminal_with_atlas(8, 1);
    train_shadow_text(&mut terminal, "a");

    // Enter and every other unsupported input flushes into a new tentative
    // epoch. A following password character cannot use trust learned by
    // the preceding line editor session.
    terminal.predict_discard();
    assert!(terminal.prediction_epoch > terminal.confirmed_epoch);
    assert_ne!(terminal.predict_printable('s' as u32, 101.0, 10, true), 0);
    assert!(!terminal.has_visible_predictions_internal());
    terminal.cursor_info_ptr();
    assert_eq!(&terminal.cursor_info_buf[..2], &[1, 0]);
    terminal.build_presented_geometry();
    assert!(terminal.visible_prediction_input_seqs.is_empty());

    // PTY write completion without echo keeps that input hidden.
    let header_only = test_frame_with_entries(FrameKind::Delta, 8, 1, 1, 0, &[]);
    assert!(terminal.apply_presented_delta_seq(&header_only, 2));
    terminal.predict_reconcile(110.0, 500.0, 10, 10);
    assert!(terminal.has_predictions());
    assert!(!terminal.has_visible_predictions_internal());
    terminal.build_presented_geometry();
    assert!(terminal.visible_prediction_input_seqs.is_empty());

    let unknown_header = FrameHeader {
        memory_only: false,
        kind: FrameKind::Delta,
        cols: 8,
        rows: 1,
        cursor_col: 1,
        cursor_row: 0,
        cursor_shape: CURSOR_SHAPE_BLOCK,
        cursor_visible: 1,
        mode_flags: (DISPLAY_MODE_PREDICTION_SAFE | (1 << 15)) as u16,
        row_count: 0,
        frame_id: 0,
        presentation_id: 0,
        presentation_member_index: 0,
        presentation_member_count: 0,
        row_predecessor_presentation_id: 0,
        presentation_coherent: false,
        presentation_end: false,
        chunk_index: 0,
        chunk_count: 1,
        demand_serial: 0,
        demand_limited: false,
        demand_prompt: false,
        demand_awaits_grant: false,
        closure_digest: 0,
        scroll_serial: 0,
        echo_horizon: 0,
    };
    let mut unknown_frame = Vec::new();
    encode_frame_into(&mut unknown_frame, &unknown_header, std::iter::empty());
    assert!(terminal.apply_presented_delta_seq(&unknown_frame, 3));
    assert!(!terminal.has_predictions());
    assert!(terminal.shadow_line.is_none());
    assert_eq!(terminal.predict_printable('x' as u32, 120.0, 11, true), 0);
}

#[test]
fn hidden_authoritative_cursor_flushes_and_blocks_shadow_prediction() {
    let mut terminal = terminal_with_atlas(8, 1);
    train_shadow_text(&mut terminal, "a");
    assert_ne!(terminal.predict_printable('x' as u32, 101.0, 2, true), 0);
    terminal.build_presented_geometry();
    terminal.clear_prediction_render_dirty();
    assert_eq!(terminal.glyph_count(), 2);

    let hidden_header = FrameHeader {
        memory_only: false,
        kind: FrameKind::Delta,
        cols: 8,
        rows: 1,
        cursor_col: 1,
        cursor_row: 0,
        cursor_shape: CURSOR_SHAPE_BLOCK,
        cursor_visible: 0,
        mode_flags: DISPLAY_MODE_PREDICTION_SAFE as u16,
        row_count: 0,
        frame_id: 0,
        presentation_id: 0,
        presentation_member_index: 0,
        presentation_member_count: 0,
        row_predecessor_presentation_id: 0,
        presentation_coherent: false,
        presentation_end: false,
        chunk_index: 0,
        chunk_count: 1,
        demand_serial: 0,
        demand_limited: false,
        demand_prompt: false,
        demand_awaits_grant: false,
        closure_digest: 0,
        scroll_serial: 0,
        echo_horizon: 0,
    };
    let mut hidden_frame = Vec::new();
    encode_frame_into(&mut hidden_frame, &hidden_header, std::iter::empty());
    assert!(terminal.apply_presented_delta_seq(&hidden_frame, 2));
    assert!(terminal.shadow_line.is_none());
    assert!(!terminal.has_predictions());

    terminal.build_presented_geometry();
    assert_eq!(terminal.glyph_count(), 1);
    assert_eq!(terminal.cursor_count(), 0);
    assert_eq!(terminal.predict_printable('s' as u32, 102.0, 3, true), 0);
    assert!(terminal.shadow_line.is_none());
}

/// A delta cannot change the grid's dimensions, whatever its sequence: a
/// snapshot is the only frame that describes a whole grid, and a delta
/// that names another one is applied to nothing and leaves the grid alone.
#[test]
fn a_delta_with_foreign_dimensions_is_rejected_without_resizing() {
    let mut terminal = prediction_terminal(8, 2);
    let header = |cols: u16, rows: u16| FrameHeader {
        memory_only: false,
        kind: FrameKind::Delta,
        cols,
        rows,
        cursor_col: 0,
        cursor_row: 0,
        cursor_shape: CURSOR_SHAPE_BLOCK,
        cursor_visible: 1,
        mode_flags: DISPLAY_MODE_PREDICTION_SAFE as u16,
        row_count: 0,
        frame_id: 0,
        presentation_id: 0,
        presentation_member_index: 0,
        presentation_member_count: 0,
        row_predecessor_presentation_id: 0,
        presentation_coherent: false,
        presentation_end: false,
        chunk_index: 0,
        chunk_count: 1,
        demand_serial: 0,
        demand_limited: false,
        demand_prompt: false,
        demand_awaits_grant: false,
        closure_digest: 0,
        scroll_serial: 0,
        echo_horizon: 0,
    };
    let mut frame = Vec::new();
    encode_frame_into(&mut frame, &header(8, 2), std::iter::empty());
    assert!(terminal.apply_presented_delta_seq(&frame, 5));

    for seq in [3, 6] {
        frame.clear();
        encode_frame_into(&mut frame, &header(4, 1), std::iter::empty());
        assert!(!terminal.apply_presented_delta_seq(&frame, seq));
        assert_eq!(
            terminal.take_last_error().as_deref(),
            Some("display_dimensions_mismatch")
        );
        assert_eq!((terminal.cols(), terminal.rows()), (8, 2));
    }

    // A snapshot is the frame that carries the geometry.
    let mut snapshot = header(4, 1);
    snapshot.kind = FrameKind::Snapshot;
    frame.clear();
    encode_frame_into(&mut frame, &snapshot, std::iter::empty());
    assert!(terminal.apply_state_seq(&frame, 7));
    assert_eq!((terminal.cols(), terminal.rows()), (4, 1));
}

/// A header that hides the cursor, or changes its shape, leaves a record
/// naming the header that did it — the evidence a "the cursor flickered
/// into a beam" report needs, which the backwards-step journal alone
/// cannot supply because the cursor did not move.
#[test]
fn a_header_that_hides_or_reshapes_the_cursor_journals_the_change() {
    let mut terminal = prediction_terminal(8, 1);
    terminal.set_cursor_motion_journal(true);
    let mut header = FrameHeader {
        memory_only: false,
        kind: FrameKind::Delta,
        cols: 8,
        rows: 1,
        cursor_col: 0,
        cursor_row: 0,
        cursor_shape: CURSOR_SHAPE_BLOCK,
        cursor_visible: 1,
        mode_flags: DISPLAY_MODE_PREDICTION_SAFE as u16,
        row_count: 0,
        frame_id: 0,
        presentation_id: 0,
        presentation_member_index: 0,
        presentation_member_count: 0,
        row_predecessor_presentation_id: 0,
        presentation_coherent: false,
        presentation_end: false,
        chunk_index: 0,
        chunk_count: 1,
        demand_serial: 0,
        demand_limited: false,
        demand_prompt: false,
        demand_awaits_grant: false,
        closure_digest: 0,
        scroll_serial: 0,
        echo_horizon: 0,
    };
    let mut frame = Vec::new();
    encode_frame_into(&mut frame, &header, std::iter::empty());
    assert!(terminal.apply_presented_delta_seq(&frame, 1));
    assert!(
        drain_cursor_motion(&mut terminal).is_empty(),
        "the first header has no predecessor to differ from"
    );
    let packed = |shape: u8, visible: u8| (0u16, (u16::from(shape) << 8) | u16::from(visible));

    header.cursor_visible = 0;
    frame.clear();
    encode_frame_into(&mut frame, &header, std::iter::empty());
    assert!(terminal.apply_presented_delta_seq(&frame, 2));
    assert_eq!(
        drain_cursor_motion(&mut terminal),
        vec![(
            CursorCause::AuthorityShape,
            packed(CURSOR_SHAPE_BLOCK, 1),
            packed(CURSOR_SHAPE_BLOCK, 0)
        )]
    );

    header.cursor_visible = 1;
    header.cursor_shape = CURSOR_SHAPE_BEAM;
    frame.clear();
    encode_frame_into(&mut frame, &header, std::iter::empty());
    assert!(terminal.apply_presented_delta_seq(&frame, 3));
    assert_eq!(
        drain_cursor_motion(&mut terminal),
        vec![(
            CursorCause::AuthorityShape,
            packed(CURSOR_SHAPE_BLOCK, 0),
            packed(CURSOR_SHAPE_BEAM, 1)
        )]
    );

    // An identical header is not a change.
    frame.clear();
    encode_frame_into(&mut frame, &header, std::iter::empty());
    assert!(terminal.apply_presented_delta_seq(&frame, 4));
    assert!(drain_cursor_motion(&mut terminal).is_empty());
}

#[test]
fn missing_daemon_prediction_capability_flushes_and_blocks_shadow_prediction() {
    let mut terminal = terminal_with_atlas(8, 1);
    train_shadow_text(&mut terminal, "a");
    assert_ne!(terminal.predict_printable('x' as u32, 101.0, 2, true), 0);

    let no_echo_header = FrameHeader {
        memory_only: false,
        kind: FrameKind::Delta,
        cols: 8,
        rows: 1,
        cursor_col: 1,
        cursor_row: 0,
        cursor_shape: CURSOR_SHAPE_BLOCK,
        cursor_visible: 1,
        mode_flags: 0,
        row_count: 0,
        frame_id: 0,
        presentation_id: 0,
        presentation_member_index: 0,
        presentation_member_count: 0,
        row_predecessor_presentation_id: 0,
        presentation_coherent: false,
        presentation_end: false,
        chunk_index: 0,
        chunk_count: 1,
        demand_serial: 0,
        demand_limited: false,
        demand_prompt: false,
        demand_awaits_grant: false,
        closure_digest: 0,
        scroll_serial: 0,
        echo_horizon: 0,
    };
    let mut no_echo_frame = Vec::new();
    encode_frame_into(&mut no_echo_frame, &no_echo_header, std::iter::empty());
    assert!(terminal.apply_presented_delta_seq(&no_echo_frame, 2));
    assert!(terminal.shadow_line.is_none());
    assert!(!terminal.has_predictions());
    assert_eq!(terminal.predict_printable('s' as u32, 102.0, 3, true), 0);
}

#[test]
fn pointer_and_screen_routing_keep_ordinary_shadow_prediction_enabled() {
    // tmux with `mouse on` sets every routing bit at once, while the shell
    // inside it has an ordinary line editor: none of them may withhold
    // prediction the daemon granted.
    let mut terminal = Terminal::new(8, 1);
    let mode_flags = DISPLAY_MODE_PREDICTION_SAFE
        | DISPLAY_MODE_POINTER_CLICKS
        | DISPLAY_MODE_POINTER_DRAG
        | DISPLAY_MODE_POINTER_HOVER
        | DISPLAY_MODE_WHEEL
        | DISPLAY_MODE_ALT_SCREEN;
    let header = FrameHeader {
        memory_only: false,
        kind: FrameKind::Delta,
        cols: 8,
        rows: 1,
        cursor_col: 0,
        cursor_row: 0,
        cursor_shape: CURSOR_SHAPE_BLOCK,
        cursor_visible: 1,
        mode_flags: mode_flags as u16,
        row_count: 0,
        frame_id: 0,
        presentation_id: 0,
        presentation_member_index: 0,
        presentation_member_count: 0,
        row_predecessor_presentation_id: 0,
        presentation_coherent: false,
        presentation_end: false,
        chunk_index: 0,
        chunk_count: 1,
        demand_serial: 0,
        demand_limited: false,
        demand_prompt: false,
        demand_awaits_grant: false,
        closure_digest: 0,
        scroll_serial: 0,
        echo_horizon: 0,
    };
    let mut frame = Vec::new();
    encode_frame_into(&mut frame, &header, std::iter::empty());

    assert!(terminal.apply_presented_delta_seq(&frame, 1));
    assert_eq!(terminal.mouse_mode(), mode_flags);
    assert!(!terminal.prediction_mode_is_unsafe());
    assert_ne!(terminal.predict_printable('x' as u32, 1.0, 1, true), 0);
}

/// The routing word a paused synchronized update sends on the control lane
/// joins the same mode word the headers set. Its routing bits survive every
/// header applied while it is held, since those can be frames sent before
/// it, and the release hands them to the header that let it go.
#[test]
fn an_input_routing_word_holds_routing_bits_until_released_to_a_header() {
    assert_eq!(DISPLAY_MODE_INPUT_ROUTING, 0x1cf);
    let mut terminal = Terminal::new(8, 1);
    let frame = |mode_flags: u32| {
        let header = FrameHeader {
            memory_only: false,
            kind: FrameKind::Delta,
            cols: 8,
            rows: 1,
            cursor_col: 0,
            cursor_row: 0,
            cursor_shape: CURSOR_SHAPE_BLOCK,
            cursor_visible: 1,
            mode_flags: mode_flags as u16,
            row_count: 0,
            frame_id: 0,
            presentation_id: 0,
            presentation_member_index: 0,
            presentation_member_count: 0,
            row_predecessor_presentation_id: 0,
            presentation_coherent: false,
            presentation_end: false,
            chunk_index: 0,
            chunk_count: 1,
            demand_serial: 0,
            demand_limited: false,
            demand_prompt: false,
            demand_awaits_grant: false,
            closure_digest: 0,
            scroll_serial: 0,
            echo_horizon: 0,
        };
        let mut frame = Vec::new();
        encode_frame_into(&mut frame, &header, std::iter::empty());
        frame
    };
    let committed = DISPLAY_MODE_PREDICTION_SAFE | DISPLAY_MODE_POINTER_CLICKS;
    assert!(terminal.apply_presented_delta_seq(&frame(committed), 2));

    // Inside the paused update the application dropped mouse tracking and
    // pushed Kitty flags 1|2|8. Routing bits follow the word; the grant and
    // the alternate screen stay the committed header's whatever it carries.
    let reports = DISPLAY_MODE_KEY_RELEASES | DISPLAY_MODE_MODIFIER_KEYS;
    let paused = DISPLAY_MODE_PREDICTION_SAFE | reports;
    terminal.set_input_routing(reports | DISPLAY_MODE_ALT_SCREEN);
    assert_eq!(terminal.mouse_mode(), paused);
    assert!(!terminal.prediction_mode_is_unsafe());

    // A header the display ordering refuses cannot take the word back.
    terminal.apply_presented_delta_seq(&frame(committed), 1);
    assert_eq!(terminal.mouse_mode(), paused);

    // A frame sent before the pause and delayed past the word applies its
    // grant, but the routing bits stay the word's.
    assert!(terminal.apply_presented_delta_seq(&frame(DISPLAY_MODE_POINTER_CLICKS), 3));
    assert_eq!(terminal.mouse_mode(), reports);
    assert!(terminal.prediction_mode_is_unsafe());

    // The header the drain commits comes after the word and releases it.
    // Here the rest of the transaction popped the Kitty flags again, and
    // the routing bits follow that header, not the word.
    assert!(terminal.apply_presented_delta_seq(&frame(committed), 4));
    assert_eq!(terminal.mouse_mode(), paused);
    terminal.release_input_routing();
    assert_eq!(terminal.mouse_mode(), committed);

    // Released, every header carries the whole word again.
    assert!(terminal.apply_presented_delta_seq(&frame(paused), 5));
    assert_eq!(terminal.mouse_mode(), paused);
}

#[test]
fn settled_shadow_skips_display_rescan_until_the_next_input() {
    let mut terminal = Terminal::new(8, 1);
    train_shadow_text(&mut terminal, "abc");
    let sync_count = terminal.shadow_sync_count;
    assert!(
        terminal
            .shadow_line
            .as_ref()
            .is_some_and(|line| line.ops.is_empty())
    );

    let header_only = test_frame_with_entries(FrameKind::Delta, 8, 1, 3, 0, &[]);
    assert!(terminal.apply_presented_delta_seq(&header_only, 2));
    assert_eq!(terminal.shadow_sync_count, sync_count);
    assert!(
        terminal
            .shadow_line
            .as_ref()
            .is_some_and(|line| line.ops.is_empty())
    );
}

#[test]
fn bounded_shadow_supports_insert_delete_backspace_and_cursor() {
    let mut terminal = Terminal::new(10, 1);
    train_shadow_text(&mut terminal, "abc");
    let authoritative_hash = terminal.row_hash(0);

    assert_ne!(terminal.predict_cursor_shift(-1, 101.0, 4), 0);
    assert_eq!(terminal.predicted_cursor, (0, 2));
    assert_ne!(terminal.predict_printable('X' as u32, 102.0, 5, true), 0);
    assert_eq!(terminal.predicted_cursor, (0, 3));
    assert_ne!(terminal.predict_delete(103.0, 6), 0);
    assert_ne!(terminal.predict_backspace(104.0, 7), 0);

    let line = terminal.shadow_line.as_ref().expect("shadow line");
    let projected: String = line
        .projected
        .cells
        .iter()
        .map(|cell| char::from_u32(cell.codepoint).expect("codepoint"))
        .collect();
    assert_eq!(projected, "ab");
    assert_eq!(line.projected.cursor, 2);
    assert_eq!(line.projected.extent, 4);
    assert_eq!(terminal.predicted_cursor, (0, 2));
    // Prediction never mutates authenticated terminal state or its hash.
    assert_eq!(terminal.row_hash(0), authoritative_hash);
    assert_eq!(terminal.row_text(0), "abc");

    let authoritative = [
        test_cell('a'),
        test_cell('b'),
        test_cell(' '),
        test_cell(' '),
    ];
    let frame = test_frame_with_entries(
        FrameKind::Delta,
        10,
        1,
        2,
        0,
        &[RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &authoritative,
        }],
    );
    assert!(terminal.apply_presented_delta_seq(&frame, 2));
    terminal.predict_reconcile(110.0, 500.0, 7, 7);
    assert_eq!(terminal.reconcile_stats, [4, 0, 0, 0, 0, 0, 0]);
    assert!(!terminal.has_predictions());
    assert_eq!(
        terminal
            .shadow_line
            .as_ref()
            .expect("owned line")
            .base
            .cells
            .len(),
        2
    );
}

#[test]
fn confirmed_shadow_rebases_authoritative_foreground_and_style() {
    let mut terminal = terminal_with_atlas(8, 1);
    assert_ne!(terminal.predict_printable('a' as u32, 0.0, 1, true), 0);

    let mut styled = test_cell('a');
    styled.fg = [12, 90, 180];
    styled.attrs |= CellAttrs::BOLD;
    styled.attrs |= CellAttrs::ITALIC;
    styled.attrs |= CellAttrs::UNDERLINE;
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
            cells: &[styled],
        }],
    );
    assert!(terminal.apply_presented_delta_seq(&frame, 1));
    terminal.predict_reconcile(10.0, 500.0, 1, 1);
    let base_cell = terminal
        .shadow_line
        .as_ref()
        .and_then(|line| line.base.cells.first())
        .copied()
        .expect("confirmed shadow base cell");
    assert_eq!(base_cell.fg, styled.fg);
    assert_eq!(base_cell.font_style, 3);
    assert!(base_cell.underline);

    assert_ne!(terminal.predict_cursor_shift(-1, 11.0, 2), 0);
    assert_ne!(terminal.predict_printable('x' as u32, 12.0, 3, true), 0);
    terminal.build_presented_geometry();

    let cell_w = terminal
        .atlas
        .as_ref()
        .map(|atlas| atlas.cell_w)
        .expect("atlas");
    let shifted_glyph = terminal.row_geometry[0]
        .glyph
        .chunks_exact(14)
        .find(|glyph| (glyph[0] - cell_w).abs() < f32::EPSILON)
        .expect("shifted styled glyph");
    let expected_fg = rgb_to_f32(styled.fg);
    assert!((shifted_glyph[10] - expected_fg[0]).abs() < f32::EPSILON);
    assert!((shifted_glyph[11] - expected_fg[1]).abs() < f32::EPSILON);
    assert!((shifted_glyph[12] - expected_fg[2]).abs() < f32::EPSILON);
    assert!((shifted_glyph[13] - PREDICTION_ALPHA).abs() < f32::EPSILON);
    assert!(
        terminal.row_geometry[0]
            .deco
            .chunks_exact(7)
            .any(|decoration| (decoration[0] - cell_w).abs() < f32::EPSILON)
    );
}

#[test]
fn shadow_repeated_base_before_write_advertisement_waits_for_echo() {
    for pending in [1u32, 2] {
        let mut terminal = Terminal::new(8, 2);
        train_shadow_text(&mut terminal, "abc");
        for index in 0..pending {
            assert_ne!(
                terminal.predict_printable(u32::from('d') + index, 101.0, 4 + index, true),
                0
            );
        }
        let mut cells = vec![test_cell(' '); 8];
        cells[..3].copy_from_slice(&[test_cell('a'), test_cell('b'), test_cell('c')]);
        let repeated = test_frame_with_entries(
            FrameKind::Delta,
            8,
            2,
            3,
            0,
            &[RowRef {
                graphics: &[],
                row_index: 0,
                left: 0,
                cells: &cells,
            }],
        );
        assert!(terminal.apply_presented_delta_seq(&repeated, 2));
        let advertisement = test_frame_with_entries(FrameKind::Delta, 8, 2, 3, 0, &[]);
        assert!(terminal.apply_presented_delta_seq(&advertisement, 3));
        for now_ms in [110.0, 129.0, 200.0] {
            terminal.predict_reconcile(now_ms, 500.0, 3 + pending, 3 + pending);
            assert_eq!(terminal.reconcile_stats, [0, 0, 0, 0, 0, 1, 0]);
            assert!(terminal.has_predictions());
        }
        for index in 0..pending {
            cells[3 + index as usize] = test_cell(char::from_u32(u32::from('d') + index).unwrap());
        }
        let echo = test_frame_with_entries(
            FrameKind::Delta,
            8,
            2,
            3 + pending as u16,
            0,
            &[RowRef {
                graphics: &[],
                row_index: 0,
                left: 0,
                cells: &cells,
            }],
        );
        assert!(terminal.apply_presented_delta_seq(&echo, 4));
        terminal.predict_reconcile(210.0, 500.0, 3 + pending, 3 + pending);
        assert_eq!(terminal.reconcile_stats, [pending, 0, 0, 0, 0, 0, 0]);
        assert!(!terminal.has_predictions());
    }
}

#[test]
fn shadow_unchanged_cursor_does_not_hide_a_changed_pending_cell() {
    let mut terminal = Terminal::new(8, 2);
    train_shadow_text(&mut terminal, "abc");
    assert_ne!(
        terminal.predict_printable(u32::from('d'), 101.0, 4, true),
        0
    );
    let cells = [
        test_cell('a'),
        test_cell('b'),
        test_cell('c'),
        test_cell('Y'),
    ];
    let contradiction = test_frame_with_entries(
        FrameKind::Delta,
        8,
        2,
        3,
        0,
        &[RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &cells,
        }],
    );
    assert!(terminal.apply_presented_delta_seq(&contradiction, 2));
    terminal.predict_reconcile(110.0, 500.0, 4, 4);
    terminal.predict_reconcile(129.0, 500.0, 4, 4);
    assert_eq!(terminal.reconcile_stats, [0, 1, 0, 0, 0, 0, 0]);
    assert!(!terminal.has_predictions());
}

#[test]
fn shadow_repeated_base_still_expires_without_echo() {
    let mut terminal = Terminal::new(8, 2);
    train_shadow_text(&mut terminal, "abc");
    assert_ne!(
        terminal.predict_printable(u32::from('d'), 101.0, 4, true),
        0
    );
    let cells = [
        test_cell('a'),
        test_cell('b'),
        test_cell('c'),
        test_cell(' '),
    ];
    let repeated = test_frame_with_entries(
        FrameKind::Delta,
        8,
        2,
        3,
        0,
        &[RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &cells,
        }],
    );
    assert!(terminal.apply_presented_delta_seq(&repeated, 2));
    terminal.predict_reconcile(110.0, 500.0, 4, 4);
    terminal.predict_reconcile(602.0, 500.0, 4, 4);
    assert_eq!(terminal.reconcile_stats, [0, 0, 1, 0, 0, 0, 0]);
    assert!(!terminal.has_predictions());
}

#[test]
fn shadow_mismatch_rolls_back_only_the_owned_projection() {
    let mut terminal = Terminal::new(8, 2);
    train_shadow_text(&mut terminal, "abc");
    let untouched_row_hash = terminal.row_hash(1);
    assert_ne!(terminal.predict_cursor_shift(-1, 101.0, 4), 0);
    assert_ne!(terminal.predict_printable('x' as u32, 102.0, 5, true), 0);

    let authoritative = [
        test_cell('a'),
        test_cell('b'),
        test_cell('Y'),
        test_cell('c'),
    ];
    let frame = test_frame_with_entries(
        FrameKind::Delta,
        8,
        2,
        3,
        0,
        &[RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &authoritative,
        }],
    );
    assert!(terminal.apply_presented_delta_seq(&frame, 2));
    terminal.predict_reconcile(110.0, 500.0, 5, 5);
    assert_eq!(terminal.reconcile_stats, [0, 0, 0, 0, 0, 1, 0]);
    assert!(terminal.shadow_line.is_some());
    terminal.predict_reconcile(129.0, 500.0, 5, 5);

    assert_eq!(terminal.reconcile_stats, [0, 1, 0, 0, 1, 0, 0]);
    assert!(terminal.shadow_line.is_none());
    assert!(!terminal.has_predictions());
    assert_eq!(terminal.row_text(0), "abYc");
    assert_eq!(terminal.row_hash(1), untouched_row_hash);
}

#[test]
fn shadow_rejects_wrap_wide_combining_and_outside_owned_cursor() {
    let mut combining = Terminal::new(6, 1);
    assert_eq!(
        combining.predict_printable('\u{301}' as u32, 0.0, 1, true),
        0
    );
    assert!(combining.shadow_line.is_none());

    let mut wrap = Terminal::new(6, 1);
    let blank = [test_cell(' '); 6];
    let wrap_frame = test_frame_with_entries(
        FrameKind::Snapshot,
        6,
        1,
        5,
        0,
        &[RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &blank,
        }],
    );
    assert!(wrap.apply_presented_state_seq(&wrap_frame, 1));
    assert_eq!(wrap.predict_printable('x' as u32, 0.0, 1, true), 0);

    let mut wide = Terminal::new(6, 1);
    let mut wide_blank = test_cell(' ');
    wide_blank.attrs |= CellAttrs::WIDE;
    let wide_frame = test_frame_with_entries(
        FrameKind::Snapshot,
        6,
        1,
        0,
        0,
        &[RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &[wide_blank],
        }],
    );
    assert!(wide.apply_presented_state_seq(&wide_frame, 1));
    assert_eq!(wide.predict_printable('x' as u32, 0.0, 1, true), 0);

    let mut owned = Terminal::new(6, 1);
    train_shadow_text(&mut owned, "a");
    assert_ne!(owned.predict_cursor_shift(-1, 101.0, 2), 0);
    assert_eq!(owned.predict_cursor_shift(-1, 102.0, 3), 0);
    // The rejected move seals the line rather than entering the prompt:
    // the accepted step stays modelled, the predicted cursor never goes
    // left of the line start, and nothing further is admitted.
    assert_eq!(
        owned.shadow_line.as_ref().and_then(|line| line.sealed),
        Some(CursorCause::FlushLineFull)
    );
    assert_eq!(owned.predicted_cursor, (0, 0));
    assert_eq!(owned.predict_printable('x' as u32, 103.0, 4, true), 0);
    assert_eq!(owned.last_flush_cause(), CursorCause::LineSealed as u32);
    owned.prediction_model_ptr();
    assert_eq!(owned.prediction_model_buf[0], 0);
}

#[test]
fn cursor_info_exports_the_same_safe_append_rule_as_prediction() {
    let mut terminal = prediction_terminal(6, 1);
    terminal.cursor_info_ptr();
    assert_eq!(terminal.cursor_info_buf[4], 1);
    assert_eq!(
        &terminal.cursor_info_buf[5..8],
        &DEFAULT_FOREGROUND.map(u16::from)
    );
    assert_eq!(
        &terminal.cursor_info_buf[8..11],
        &DEFAULT_BACKGROUND.map(u16::from)
    );

    let occupied_tail = [test_cell(' '), test_cell('z')];
    let frame = test_frame_with_entries(
        FrameKind::Snapshot,
        6,
        1,
        0,
        0,
        &[RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &occupied_tail,
        }],
    );
    assert!(terminal.apply_presented_state_seq(&frame, 1));
    terminal.cursor_info_ptr();
    assert_eq!(terminal.cursor_info_buf[4], 0);
    assert_eq!(terminal.predict_printable('x' as u32, 0.0, 1, true), 0);

    let mut styled = prediction_terminal(6, 1);
    let mut alternate_background = test_cell(' ');
    alternate_background.bg = [40, 50, 60];
    let styled_tail = [test_cell(' '), alternate_background];
    let styled_frame = test_frame_with_entries(
        FrameKind::Snapshot,
        6,
        1,
        0,
        0,
        &[RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &styled_tail,
        }],
    );
    assert!(styled.apply_presented_state_seq(&styled_frame, 1));
    styled.cursor_info_ptr();
    assert_eq!(styled.cursor_info_buf[4], 0);

    let mut midline = prediction_terminal(8, 1);
    train_shadow_text(&mut midline, "ab");
    assert_ne!(midline.predict_cursor_shift(-1, 101.0, 3), 0);
    midline.cursor_info_ptr();
    assert_eq!(midline.cursor_info_buf[4], 0);
}

#[test]
fn predicted_cursor_geometry_and_row_projection_do_not_accumulate() {
    let mut terminal = terminal_with_atlas(8, 1);
    train_shadow_text(&mut terminal, "abc");
    terminal.build_presented_geometry();
    terminal.clear_prediction_render_dirty();

    assert_ne!(terminal.predict_cursor_shift(-1, 101.0, 4), 0);
    assert_ne!(terminal.predict_printable('x' as u32, 102.0, 5, true), 0);
    terminal.build_presented_geometry();
    terminal.clear_prediction_render_dirty();
    assert_eq!(terminal.glyph_count(), 4);
    terminal.cursor_info_ptr();
    assert_eq!(&terminal.cursor_info_buf[..2], &[3, 0]);

    assert_ne!(terminal.predict_delete(103.0, 6), 0);
    terminal.build_presented_geometry();
    terminal.clear_prediction_render_dirty();
    assert_eq!(terminal.glyph_count(), 3);

    assert_ne!(terminal.predict_printable('c' as u32, 104.0, 7, true), 0);
    terminal.build_presented_geometry();
    terminal.clear_prediction_render_dirty();
    assert_eq!(terminal.glyph_count(), 4);
    assert_ne!(terminal.predict_backspace(105.0, 8), 0);
    terminal.build_presented_geometry();
    terminal.clear_prediction_render_dirty();
    assert_eq!(terminal.glyph_count(), 3);
}

#[test]
fn unchanged_cursor_geometry_does_not_advance_version_or_dirty_range() {
    let mut terminal = terminal_with_atlas(4, 1);
    terminal.build_presented_geometry();
    let version = terminal.cursor_version();
    let geometry = terminal.cursor_buf.clone();

    // A newer header-only frame forces a geometry pass by damaging the
    // cursor cell, but carries the exact cursor already on screen.
    let frame = test_cursor_frame(4, 1, 0, 0, CURSOR_SHAPE_BLOCK, 1);
    assert!(terminal.apply_presented_delta_seq(&frame, 1));
    assert!(terminal.presentation_cursor_dirty);
    terminal.build_presented_geometry();

    assert_eq!(terminal.cursor_buf, geometry);
    assert_eq!(terminal.cursor_version(), version);
    assert_eq!(terminal.cursor_dirty_offset(), 0);
    assert_eq!(terminal.cursor_dirty_count(), 0);
}

#[test]
fn moved_cursor_geometry_advances_version_and_marks_instance_dirty() {
    let mut terminal = terminal_with_atlas(4, 1);
    terminal.build_presented_geometry();
    let version = terminal.cursor_version();
    let geometry = terminal.cursor_buf.clone();

    let frame = test_cursor_frame(4, 1, 1, 0, CURSOR_SHAPE_BLOCK, 1);
    assert!(terminal.apply_presented_delta_seq(&frame, 1));
    terminal.build_presented_geometry();

    assert_eq!(terminal.cursor_version(), version + 1);
    assert_eq!(terminal.cursor_dirty_offset(), 0);
    assert_eq!(terminal.cursor_dirty_count(), 1);
    assert_eq!(terminal.cursor_count(), 1);
    assert_eq!(terminal.cursor_buf[0], geometry[2]);
    assert_eq!(&terminal.cursor_buf[1..], &geometry[1..]);
}

#[test]
fn hidden_cursor_advances_version_once_without_an_upload_range() {
    let mut terminal = terminal_with_atlas(4, 1);
    terminal.build_presented_geometry();
    let visible_version = terminal.cursor_version();

    let frame = test_cursor_frame(4, 1, 0, 0, CURSOR_SHAPE_BLOCK, 0);
    assert!(terminal.apply_presented_delta_seq(&frame, 1));
    terminal.build_presented_geometry();

    let hidden_version = terminal.cursor_version();
    assert_eq!(hidden_version, visible_version + 1);
    assert_eq!(terminal.cursor_count(), 0);
    assert_eq!(terminal.cursor_dirty_offset(), 0);
    assert_eq!(terminal.cursor_dirty_count(), 0);

    // Reapplying the same hidden geometry must not keep invalidating the
    // version while unrelated headers arrive.
    assert!(terminal.apply_presented_delta_seq(&frame, 2));
    terminal.build_presented_geometry();
    assert_eq!(terminal.cursor_version(), hidden_version);
    assert_eq!(terminal.cursor_dirty_count(), 0);
}

#[test]
fn cursor_style_change_advances_version_and_marks_instance_dirty() {
    let mut terminal = terminal_with_atlas(4, 1);
    terminal.build_presented_geometry();
    let version = terminal.cursor_version();
    let block_geometry = terminal.cursor_buf.clone();

    let frame = test_cursor_frame(4, 1, 0, 0, CURSOR_SHAPE_BEAM, 1);
    assert!(terminal.apply_presented_delta_seq(&frame, 1));
    terminal.build_presented_geometry();

    assert_eq!(terminal.cursor_version(), version + 1);
    assert_eq!(terminal.cursor_dirty_offset(), 0);
    assert_eq!(terminal.cursor_dirty_count(), 1);
    assert_eq!(&terminal.cursor_buf[..7], &block_geometry[..7]);
    assert_eq!(terminal.cursor_buf[7], 1.0);
}

#[test]
fn visible_prediction_membership_reports_only_post_gate_effects_without_diagnostics() {
    let mut terminal = terminal_with_atlas(3, 1);
    let epoch = terminal.predict_printable('x' as u32, 0.0, 7, false);
    terminal.confirmed_epoch = epoch;

    terminal.build_presented_geometry();
    assert!(terminal.visible_prediction_input_seqs.is_empty());

    terminal.predict_discard();
    terminal.confirmed_epoch = terminal.predict_printable('y' as u32, 0.0, 8, true);
    assert_ne!(terminal.predict_printable('z' as u32, 0.0, 9, true), 0);
    terminal.build_presented_geometry();
    assert_eq!(terminal.visible_prediction_input_seqs, [8, 9]);
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn visible_prediction_membership_initial_storage_moves_to_construction() {
    let mut constructed = None;
    let construction_allocations = geometry_allocations::count(|| {
        constructed = Some(Terminal::new(4, 1));
    });
    let terminal = constructed.unwrap();
    let storage = |terminal: &Terminal| {
        (
            terminal.pending_prediction_clear_effects.as_ptr(),
            terminal.pending_prediction_clear_effects.capacity(),
            terminal.visible_prediction_input_seqs.as_ptr(),
            terminal.visible_prediction_input_seqs.capacity(),
            terminal.visible_prediction_clear_effect_pairs.as_ptr(),
            terminal.visible_prediction_clear_effect_pairs.capacity(),
        )
    };
    let (_, pending, _, visible, _, pairs) = storage(&terminal);
    assert_eq!((pending, visible, pairs), (4, 4, 4));
    let retained_bytes = pending * std::mem::size_of::<PredictionClearEffect>()
        + (visible + pairs) * std::mem::size_of::<u32>();
    assert_eq!(retained_bytes, 96);
    // These allocations moved to initialization; they were not eliminated.
    assert!(construction_allocations >= 3);

    // The real first glyph/clear may allocate unrelated shadow, atlas, and
    // geometry storage. Count that cold work honestly, and separately prove
    // none of the three effect vectors allocate or move during either input.
    let mut terminal = terminal_with_atlas(4, 1);
    terminal.build_presented_geometry();
    terminal.confirmed_epoch = terminal.prediction_epoch;
    let initialized_storage = storage(&terminal);
    let glyph_allocations = geometry_allocations::count(|| {
        assert_ne!(terminal.predict_printable('x' as u32, 0.0, 1, true), 0);
        terminal.build_presented_geometry();
    });
    assert_eq!(storage(&terminal), initialized_storage);
    assert_eq!(terminal.visible_prediction_input_seqs, [1]);
    let clear_allocations = geometry_allocations::count(|| {
        assert_ne!(terminal.predict_backspace(1.0, 2), 0);
        terminal.build_presented_geometry();
    });
    assert_eq!(storage(&terminal), initialized_storage);
    assert_eq!(terminal.visible_prediction_clear_effect_pairs, [2, 1]);
    eprintln!(
        "prediction membership cold: terminal construction={construction_allocations} allocations (includes 3 effect allocations/{retained_bytes} retained bytes); first glyph={glyph_allocations}, first clear={clear_allocations} total allocations, effect-vector growth=0/0"
    );
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn visible_prediction_membership_reuses_warmed_geometry_without_allocations() {
    let mut terminal = terminal_with_atlas(4, 1);
    terminal.build_presented_geometry();
    for round in 0..128u32 {
        terminal.predict_discard();
        terminal.confirmed_epoch = terminal.prediction_epoch;
        let glyph_seq = round * 2 + 1;
        assert_ne!(
            terminal.predict_printable('x' as u32, 0.0, glyph_seq, true),
            0
        );
        let glyph_allocations = geometry_allocations::count(|| terminal.build_geometry());
        assert_eq!(terminal.visible_prediction_input_seqs, [glyph_seq]);
        assert!(terminal.visible_prediction_clear_effect_pairs.is_empty());

        assert_ne!(terminal.predict_backspace(1.0, glyph_seq + 1), 0);
        let clear_allocations = geometry_allocations::count(|| terminal.build_geometry());
        assert!(terminal.visible_prediction_input_seqs.is_empty());
        assert_eq!(
            terminal.visible_prediction_clear_effect_pairs,
            [glyph_seq + 1, glyph_seq]
        );
        if round > 0 {
            assert_eq!((glyph_allocations, clear_allocations), (0, 0));
        }
        assert!(
            terminal.visible_prediction_input_seqs.capacity() <= MAX_VISIBLE_PREDICTION_EFFECTS
        );
        assert!(
            terminal.visible_prediction_clear_effect_pairs.capacity()
                <= MAX_VISIBLE_PREDICTION_EFFECTS * 2
        );
        assert!(
            terminal.pending_prediction_clear_effects.capacity() <= MAX_VISIBLE_PREDICTION_EFFECTS
        );
    }
}

#[test]
fn visible_prediction_membership_does_not_claim_a_hidden_cursor_pixel() {
    for (shape, visible) in [(CURSOR_SHAPE_HIDDEN, 1), (CURSOR_SHAPE_BLOCK, 0)] {
        for glyph in [false, true] {
            let mut terminal = terminal_with_atlas(4, 1);
            terminal.confirmed_epoch = terminal.prediction_epoch;
            assert_ne!(terminal.predict_printable(' ' as u32, 0.0, 7, true), 0);
            if glyph {
                assert_ne!(terminal.predict_printable('x' as u32, 1.0, 8, true), 0);
            }
            // Isolate the renderer's visibility predicate from admission:
            // membership must not count a cursor instance geometry omits.
            terminal.term.set_cursor_shape_direct(CursorShape::Hidden);
            terminal.build_presented_geometry();
            assert_eq!(terminal.cursor_count(), 0);
            // Independently visible glyphs keep their existing rendering
            // predicates; a hidden cursor alone never claims a pixel.
            assert_eq!(
                terminal.visible_prediction_input_seqs.as_slice(),
                if glyph { &[8][..] } else { &[] }
            );
            // Production authority hiding a cursor is additionally a
            // fail-closed admission boundary and retracts the whole line.
            assert!(
                terminal
                    .apply_presented_delta_seq(&test_cursor_frame(4, 1, 0, 0, shape, visible), 1)
            );
            terminal.build_presented_geometry();
            assert!(!terminal.has_predictions());
            assert!(terminal.visible_prediction_input_seqs.is_empty());
        }
    }
}

#[test]
fn visible_prediction_clear_membership_survives_an_atlas_growth_retry() {
    let mut terminal = terminal_with_atlas(4, 1);
    terminal.confirmed_epoch = terminal.prediction_epoch;
    assert_ne!(terminal.predict_printable('x' as u32, 0.0, 1, true), 0);
    terminal.build_presented_geometry();
    assert_ne!(terminal.predict_backspace(1.0, 2), 0);
    // An unrelated authoritative glyph needs new atlas space during the
    // same clear-effect build. Only the final geometry owns the effect.
    write_cell(
        &mut terminal.term.grid_mut()[Point::new(Line(0), Column(3))],
        test_cell('z'),
    );
    terminal.full_damage = true;
    terminal.atlas.as_mut().unwrap().force_next_pack_to_grow();
    let generation = terminal.atlas_generation();
    terminal.build_presented_geometry();
    assert_eq!(terminal.atlas_generation(), generation + 1);
    assert_eq!(terminal.visible_prediction_clear_effect_pairs, [2, 1]);
    assert!(terminal.pending_prediction_clear_effects.is_empty());
}

#[test]
fn visible_prediction_membership_overflow_is_bounded_and_unknown_not_partial() {
    let mut terminal = prediction_terminal(512, 1);
    terminal.confirmed_epoch = terminal.prediction_epoch;
    assert_ne!(terminal.predict_printable('x' as u32, 0.0, 1, true), 0);
    let mut prediction = terminal.predictions[0];
    terminal.predict_discard();
    for column in 0..=MAX_VISIBLE_PREDICTION_EFFECTS {
        prediction.col = column as u16;
        prediction.input_seq = column as u32 * 2 + 1;
        terminal.record_prediction_clear_effect(prediction.input_seq + 1, prediction);
    }
    assert!(terminal.pending_prediction_clear_effects_truncated);
    assert!(terminal.pending_prediction_clear_effects.is_empty());
    assert!(terminal.pending_prediction_clear_effects.capacity() <= MAX_VISIBLE_PREDICTION_EFFECTS);
    terminal.build_presented_geometry();
    assert!(terminal.visible_prediction_input_seqs_truncated());
    assert_eq!(terminal.visible_prediction_input_seqs_len(), 0);
    assert_eq!(terminal.visible_prediction_clear_effect_pairs_len(), 0);
    terminal.prediction_render_dirty = true;
    terminal.build_presented_geometry();
    assert!(!terminal.visible_prediction_input_seqs_truncated());
}

#[test]
fn predicted_space_advances_model_without_claiming_visible_geometry() {
    let mut terminal = terminal_with_atlas(4, 1);

    let space_epoch = terminal.predict_printable(' ' as u32, 0.0, 7, true);
    terminal.confirmed_epoch = space_epoch;
    assert!(terminal.has_predictions());
    assert!(terminal.has_visible_predictions_internal());
    terminal.build_presented_geometry();
    assert_eq!(terminal.visible_prediction_input_seqs, [7]);

    // The invisible space remains part of the cursor model, so the next
    // printable prediction is placed after it and is the only visible
    // effect attributed to a local input.
    let glyph_epoch = terminal.predict_printable('x' as u32, 1.0, 8, true);
    terminal.confirmed_epoch = glyph_epoch;
    assert!(terminal.has_visible_predictions_internal());
    terminal.build_presented_geometry();
    assert_eq!(terminal.visible_prediction_input_seqs, [8]);
    assert_eq!(terminal.predictions[0].col, 1);
}

#[test]
fn expiry_splits_by_whether_authority_ever_covered_the_input() {
    // Authority never reached seq 11: a stalled link, evidence of nothing.
    let mut stalled = prediction_terminal(3, 1);
    stalled.confirmed_epoch = stalled.prediction_epoch;
    assert_ne!(stalled.predict_printable('x' as u32, 0.0, 11, true), 0);
    stalled.predict_reconcile(501.0, 500.0, 0, 0);
    assert_eq!(stalled.reconcile_stats, [0, 0, 0, 0, 0, 0, 1]);

    // Authority covered seq 11 and still left the glyph unconfirmed: a
    // contradiction wearing an expiry's clothes.
    let mut covered = prediction_terminal(3, 1);
    covered.confirmed_epoch = covered.prediction_epoch;
    assert_ne!(covered.predict_printable('x' as u32, 0.0, 11, true), 0);
    covered.predict_reconcile(501.0, 500.0, 11, 11);
    assert_eq!(covered.reconcile_stats, [0, 0, 1, 0, 0, 0, 0]);
}

#[test]
fn visible_prediction_membership_drops_expired_and_mismatched_inputs() {
    let mut expired = prediction_terminal(3, 1);
    expired.confirmed_epoch = expired.prediction_epoch;
    assert_ne!(expired.predict_printable('x' as u32, 0.0, 11, true), 0);
    expired.build_presented_geometry();
    assert_eq!(expired.visible_prediction_input_seqs, [11]);

    expired.predict_reconcile(501.0, 500.0, 0, 0);
    expired.build_presented_geometry();
    assert!(expired.visible_prediction_input_seqs.is_empty());

    let mut mismatched = prediction_terminal(3, 1);
    mismatched.confirmed_epoch = mismatched.prediction_epoch;
    assert_ne!(mismatched.predict_printable('x' as u32, 0.0, 13, true), 0);
    mismatched.build_presented_geometry();
    assert_eq!(mismatched.visible_prediction_input_seqs, [13]);

    let authoritative = [test_cell('y')];
    let frame = test_frame_with_entries(
        FrameKind::Delta,
        3,
        1,
        1,
        0,
        &[RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &authoritative,
        }],
    );
    assert!(mismatched.apply_presented_delta_seq(&frame, 1));
    mismatched.predict_reconcile(100.0, 500.0, 13, 13);
    mismatched.predict_reconcile(119.0, 500.0, 13, 13);
    mismatched.build_presented_geometry();
    assert!(mismatched.visible_prediction_input_seqs.is_empty());
}

#[test]
fn visible_backspace_is_an_exact_clear_effect_after_reconciliation() {
    let mut terminal = prediction_terminal(3, 1);
    terminal.confirmed_epoch = terminal.prediction_epoch;
    assert_ne!(terminal.predict_printable('x' as u32, 0.0, 21, true), 0);
    terminal.build_presented_geometry();
    assert_eq!(terminal.visible_prediction_input_seqs, [21]);

    assert_ne!(terminal.predict_backspace(1.0, 22), 0);
    terminal.build_presented_geometry();
    assert!(terminal.visible_prediction_input_seqs.is_empty());
    assert_eq!(terminal.visible_prediction_clear_effect_pairs, [22, 21]);
}

#[test]
fn coalesced_retype_does_not_claim_an_intermediate_backspace_clear() {
    let mut terminal = prediction_terminal(3, 1);
    terminal.confirmed_epoch = terminal.prediction_epoch;
    assert_ne!(terminal.predict_printable('x' as u32, 0.0, 31, true), 0);
    assert_ne!(terminal.predict_backspace(1.0, 32), 0);
    assert_ne!(terminal.predict_printable('y' as u32, 2.0, 33, true), 0);

    terminal.build_presented_geometry();
    assert_eq!(terminal.visible_prediction_input_seqs, [33]);
    assert!(terminal.visible_prediction_clear_effect_pairs.is_empty());
}

#[test]
fn coalesced_clear_keeps_only_the_latest_effect_for_a_cell() {
    let mut terminal = prediction_terminal(3, 1);
    terminal.confirmed_epoch = terminal.prediction_epoch;
    assert_ne!(terminal.predict_printable('x' as u32, 0.0, 41, true), 0);
    assert_ne!(terminal.predict_backspace(1.0, 42), 0);
    assert_ne!(terminal.predict_printable('y' as u32, 2.0, 43, true), 0);
    assert_ne!(terminal.predict_backspace(3.0, 44), 0);

    terminal.build_presented_geometry();
    assert!(terminal.visible_prediction_input_seqs.is_empty());
    assert_eq!(terminal.visible_prediction_clear_effect_pairs, [44, 43]);
}

#[test]
fn prediction_glyph_dirty_range_covers_appended_instances() {
    let mut terminal = terminal_with_atlas(3, 1);
    terminal.build_presented_geometry();
    terminal.confirmed_epoch = terminal.prediction_epoch;

    let epoch = terminal.predict_printable('x' as u32, 0.0, 1, true);
    terminal.confirmed_epoch = epoch;
    terminal.build_presented_geometry();

    assert_eq!(terminal.glyph_count(), 1);
    assert!(terminal.glyph_dirty_offset() <= terminal.glyph_count());
    assert!(terminal.glyph_dirty_offset() + terminal.glyph_dirty_count() >= terminal.glyph_count());
}

#[test]
fn speculative_ascii_metadata_uses_the_terminal_atlas_entry_exactly() {
    let mut terminal = terminal_with_atlas(1, 1);
    assert!(terminal.prepare_speculative_ascii_atlas());

    let space_offset =
        (u32::from(' ') - SPECULATIVE_ASCII_FIRST) as usize * SPECULATIVE_GLYPH_ENTRY_WORDS;
    assert_eq!(
        &terminal.speculative_ascii_entries
            [space_offset..space_offset + SPECULATIVE_GLYPH_ENTRY_WORDS],
        &[0; SPECULATIVE_GLYPH_ENTRY_WORDS]
    );

    let key = atlas::GlyphKey {
        codepoint: u32::from('A'),
        style: PREDICTION_STYLE_NORMAL,
    };
    let entry = terminal
        .atlas
        .as_ref()
        .expect("atlas")
        .rasterized(&key)
        .expect("ASCII glyph");
    let offset =
        (u32::from('A') - SPECULATIVE_ASCII_FIRST) as usize * SPECULATIVE_GLYPH_ENTRY_WORDS;
    assert_eq!(
        &terminal.speculative_ascii_entries[offset..offset + SPECULATIVE_GLYPH_ENTRY_WORDS],
        &[
            i32::from(entry.atlas_x),
            i32::from(entry.atlas_y),
            i32::from(entry.width),
            i32::from(entry.height),
            i32::from(entry.offset_x),
            i32::from(entry.offset_y),
        ]
    );

    let atlas = terminal.atlas.as_ref().expect("atlas");
    let covered = (0..usize::from(entry.height)).flat_map(|row| {
        let start = (usize::from(entry.atlas_y) + row) * atlas.atlas_w as usize
            + usize::from(entry.atlas_x);
        &atlas.pixels[start..start + usize::from(entry.width)]
    });
    assert!(covered.into_iter().any(|pixel| *pixel > 0));
}

#[test]
fn speculative_ascii_metadata_refreshes_after_raster_metric_change() {
    let mut terminal = terminal_with_atlas(1, 1);
    assert!(terminal.prepare_speculative_ascii_atlas());
    let offset =
        (u32::from('W') - SPECULATIVE_ASCII_FIRST) as usize * SPECULATIVE_GLYPH_ENTRY_WORDS;
    let old_width = terminal.speculative_ascii_entries[offset + 2];

    terminal.set_cell_metrics(28.0, 1.2, 1.0);
    assert!(terminal.prepare_speculative_ascii_atlas());

    assert!(terminal.speculative_ascii_entries[offset + 2] > old_width);
}

#[test]
fn atlas_growth_invalidates_cached_normalized_uvs() {
    let mut terminal = terminal_with_atlas(1, 1);
    write_cell(
        &mut terminal.term.grid_mut()[Point::new(Line(0), Column(0))],
        test_cell('x'),
    );
    terminal.full_damage = true;
    terminal.build_presented_geometry();
    assert_eq!(terminal.glyph_count(), 1);
    let old_uv = terminal.glyph_buf[6..10].to_vec();
    let old_generation = terminal.atlas_generation();

    assert!(terminal.atlas.as_mut().expect("atlas").grow());
    assert_eq!(terminal.atlas_generation(), old_generation + 1);
    terminal.full_damage = false;
    terminal.clear_damaged_rows();
    terminal.build_presented_geometry();

    assert_eq!(
        terminal.geometry_atlas_generation,
        terminal.atlas_generation()
    );
    assert_eq!(terminal.glyph_count(), 1);
    let new_uv = &terminal.glyph_buf[6..10];
    for (old, new) in old_uv.iter().zip(new_uv) {
        assert!((new * 2.0 - old).abs() < f32::EPSILON);
    }
}

#[test]
fn glyph_bitmaps_land_on_physical_pixels_at_every_font_size_and_density() {
    let mut terminal = terminal_with_atlas(8, 2);
    for (col, ch) in "HEmwx_gy".chars().enumerate() {
        for row in 0..2 {
            write_cell(
                &mut terminal.term.grid_mut()[Point::new(Line(row), Column(col))],
                test_cell(ch),
            );
        }
    }
    for size in 10..=24 {
        for dpr in [0.8, 1.0, 1.25, 1.5, 1.75, 2.0, 3.0] {
            terminal.set_cell_metrics(size as f32 * dpr, 1.0, dpr);
            terminal.build_presented_geometry();
            assert_eq!(terminal.glyph_count(), 16);
            for glyph in terminal.glyph_buf.chunks_exact(14) {
                for value in [glyph[0] + glyph[2], glyph[1] + glyph[3], glyph[4], glyph[5]] {
                    assert_eq!(
                        value.fract(),
                        0.0,
                        "size={size}, dpr={dpr}, glyph={glyph:?}"
                    );
                }
            }
        }
    }
}

#[test]
fn cell_metric_change_resets_raster_and_geometry_caches() {
    let mut terminal = terminal_with_atlas(1, 1);
    let key = atlas::GlyphKey {
        codepoint: u32::from('x'),
        style: 0,
    };
    write_cell(
        &mut terminal.term.grid_mut()[Point::new(Line(0), Column(0))],
        test_cell('x'),
    );
    terminal.build_presented_geometry();
    terminal.atlas_mark_clean();

    let old_generation = terminal.atlas_generation();
    let old_entry = terminal
        .atlas
        .as_ref()
        .expect("atlas")
        .rasterized(&key)
        .expect("rasterized glyph");

    terminal.set_cell_metrics(28.0, 1.2, 1.0);

    let atlas = terminal.atlas.as_ref().expect("atlas");
    assert_eq!(atlas.generation(), old_generation + 1);
    assert!(atlas.glyphs.is_empty());
    assert_eq!(atlas.pending_len(), 0);
    assert!(atlas.pixels.iter().all(|pixel| *pixel == 0));
    assert!(atlas.dirty);
    assert_eq!(atlas.dirty_rect, [0, 0, atlas.atlas_w, atlas.atlas_h]);
    assert!(terminal.row_geometry.is_empty());
    assert!(!terminal.geometry_buffers_initialized);
    assert!(terminal.full_damage);

    terminal.build_presented_geometry();
    let atlas = terminal.atlas.as_ref().expect("atlas");
    let new_entry = atlas.rasterized(&key).expect("rerasterized glyph");
    assert!(new_entry.width > old_entry.width);
    assert_eq!(terminal.geometry_atlas_generation, atlas.generation());
}

#[test]
fn line_height_change_reuses_raster_but_invalidates_geometry() {
    let mut terminal = terminal_with_atlas(1, 1);
    write_cell(
        &mut terminal.term.grid_mut()[Point::new(Line(0), Column(0))],
        test_cell('x'),
    );
    terminal.build_presented_geometry();
    terminal.atlas_mark_clean();
    let generation = terminal.atlas_generation();
    let glyph_count = terminal.atlas.as_ref().expect("atlas").glyphs.len();

    terminal.set_cell_metrics(14.0, 2.0, 1.0);

    let atlas = terminal.atlas.as_ref().expect("atlas");
    assert_eq!(atlas.generation(), generation);
    assert_eq!(atlas.glyphs.len(), glyph_count);
    assert!(!atlas.dirty);
    assert!(terminal.row_geometry.is_empty());
    assert!(!terminal.geometry_buffers_initialized);
    assert!(terminal.full_damage);
}

#[test]
fn damage_accumulates_across_chunks_before_render() {
    let mut terminal = Terminal::new(3, 2);
    terminal.commit_presentation_state();
    let top = [test_cell('A')];
    let bottom = [test_cell('B')];
    let top_chunk = test_frame_with_rows(
        FrameKind::Delta,
        3,
        2,
        RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &top,
        },
    );
    let bottom_chunk = test_frame_with_rows(
        FrameKind::Delta,
        3,
        2,
        RowRef {
            graphics: &[],
            row_index: 1,
            left: 0,
            cells: &bottom,
        },
    );

    assert!(terminal.apply_presented_delta_seq(&top_chunk, 1));
    assert!(terminal.apply_presented_delta_seq(&bottom_chunk, 2));
    assert_eq!(terminal.damaged_rows, vec![0, 1]);
}

#[test]
fn validation_pass_does_not_mutate_terminal_or_display_ordering() {
    let mut terminal = Terminal::new(3, 1);
    let cells = [test_cell('a'), test_cell('b'), test_cell('c')];
    let frame = test_frame(
        FrameKind::Snapshot,
        3,
        RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &cells,
        },
    );
    assert!(terminal.apply_presented_state_seq(&frame, 7));
    let before_text = terminal.row_text(0);
    let before_version = terminal.display_header_version;
    let before_damage = terminal.damaged_rows.clone();

    let mut malformed = frame;
    malformed.pop();
    assert!(!terminal.validate_frame(&malformed));
    assert_eq!(terminal.row_text(0), before_text);
    assert_eq!(terminal.display_header_version, before_version);
    assert_eq!(terminal.damaged_rows, before_damage);
}

#[test]
fn malformed_late_row_is_atomic() {
    let mut terminal = Terminal::new(3, 2);
    let initial_top = [test_cell('a'), test_cell('b'), test_cell('c')];
    let initial_bottom = [test_cell('d'), test_cell('e'), test_cell('f')];
    let initial = test_frame_with_row_refs(
        FrameKind::Snapshot,
        3,
        2,
        &[
            RowRef {
                graphics: &[],
                row_index: 0,
                left: 0,
                cells: &initial_top,
            },
            RowRef {
                graphics: &[],
                row_index: 1,
                left: 0,
                cells: &initial_bottom,
            },
        ],
    );
    assert!(terminal.apply_presented_state_seq(&initial, 1));
    terminal.clear_damaged_rows();
    terminal.full_damage = false;

    let before_row_versions = terminal.display_row_versions.clone();
    let before_cell_versions = terminal.display_cell_versions.clone();
    let before_header_version = terminal.display_header_version;
    let patch_top = [test_cell('A')];
    let patch_bottom = [test_cell('D')];
    let mut malformed = test_frame_with_row_refs(
        FrameKind::Delta,
        3,
        2,
        &[
            RowRef {
                graphics: &[],
                row_index: 0,
                left: 0,
                cells: &patch_top,
            },
            RowRef {
                graphics: &[],
                row_index: 1,
                left: 0,
                cells: &patch_bottom,
            },
        ],
    );
    malformed.pop();

    assert!(!terminal.apply_presented_delta_seq(&malformed, 2));
    assert_eq!(terminal.term.grid()[Point::new(Line(0), Column(0))].c, 'a');
    assert_eq!(terminal.term.grid()[Point::new(Line(1), Column(0))].c, 'd');
    assert_eq!(terminal.display_row_versions, before_row_versions);
    assert_eq!(terminal.display_cell_versions, before_cell_versions);
    assert_eq!(terminal.display_header_version, before_header_version);
    assert!(terminal.damaged_rows.is_empty());
    assert!(!terminal.full_damage);
    assert_eq!(terminal.last_error.as_deref(), Some("display_row_invalid"));
}

#[test]
fn oversized_frame_dimensions_are_rejected_before_resize() {
    for (cols, rows) in [(513, 1), (1, 257), (512, 193)] {
        let mut terminal = Terminal::new(3, 2);
        let frame = test_frame_with_row_refs(FrameKind::Snapshot, cols, rows, &[]);

        assert!(!terminal.apply_presented_state_seq(&frame, 1));
        assert_eq!(terminal.term.grid().columns(), 3);
        assert_eq!(terminal.term.grid().screen_lines(), 2);
        assert!(terminal.display_row_versions.is_empty());
        assert!(terminal.display_cell_versions.is_empty());
        assert_eq!(terminal.display_header_version, 0);
        assert_eq!(
            terminal.last_error.as_deref(),
            Some("display_dimensions_invalid")
        );
    }
}

#[test]
fn trailing_frame_payload_is_rejected_atomically() {
    let mut terminal = Terminal::new(3, 1);
    let cells = [test_cell('x')];
    let mut frame = test_frame(
        FrameKind::Delta,
        3,
        RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &cells,
        },
    );
    frame.push(0);

    assert!(!terminal.apply_presented_delta_seq(&frame, 1));
    assert_eq!(terminal.term.grid()[Point::new(Line(0), Column(0))].c, ' ');
    assert!(terminal.display_row_versions.is_empty());
    assert!(terminal.display_cell_versions.is_empty());
    assert_eq!(terminal.display_header_version, 0);
    assert!(terminal.damaged_rows.is_empty());
    assert_eq!(
        terminal.last_error.as_deref(),
        Some("display_payload_shape_invalid")
    );
}

#[test]
fn out_of_order_partial_deltas_do_not_merge_across_row_versions() {
    let mut terminal = Terminal::new(6, 1);
    let initial = [
        test_cell('a'),
        test_cell('b'),
        test_cell('c'),
        test_cell('d'),
        test_cell('e'),
        test_cell('f'),
    ];
    let snapshot = test_frame(
        FrameKind::Snapshot,
        6,
        RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &initial,
        },
    );
    assert!(terminal.apply_presented_state_seq(&snapshot, 1));

    let left = [test_cell('A')];
    let right = [test_cell('Z')];
    let delta_left = test_frame(
        FrameKind::Delta,
        6,
        RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &left,
        },
    );
    let delta_right = test_frame(
        FrameKind::Delta,
        6,
        RowRef {
            graphics: &[],
            row_index: 0,
            left: 5,
            cells: &right,
        },
    );

    assert!(terminal.apply_presented_delta_seq(&delta_right, 3));
    assert!(terminal.apply_presented_delta_seq(&delta_left, 2));
    // The seq-2 entry is stale and is discarded WHOLE. The sender may only
    // build a sparse delta on a baseline the browser explicitly ACKed, so
    // either the older frame provably arrived (and cannot be late), or the
    // sender advanced this row's baseline from an explicit selective ACK
    // and the newer frame is full width anyway. Neither case needs the
    // older entry, and accepting it is exactly how a reverted cell gets
    // resurrected.
    assert_eq!(terminal.row_text(0), "abcdeZ");
    assert_eq!(terminal.display_row_versions[0], 3);
}

#[test]
fn display_sequence_ordering_treats_zero_as_reset_and_one_as_max_successor() {
    assert!(display_sequence_is_newer(u32::MAX - 1, 0));
    assert!(display_sequence_is_newer(u32::MAX, u32::MAX - 1));
    assert!(display_sequence_is_newer(1, u32::MAX));
    assert!(display_sequence_is_newer(1, u32::MAX - 1));

    assert!(!display_sequence_is_newer(0, u32::MAX));
    assert!(!display_sequence_is_newer(u32::MAX, 1));
    assert!(!display_sequence_is_newer(1, 1));
    assert!(!display_sequence_is_newer(
        1u32.wrapping_add(0x8000_0000),
        1
    ));
}

#[test]
fn wrapped_literal_rows_cells_and_header_reject_stale_and_duplicate_frames() {
    let mut terminal = Terminal::new(4, 1);
    let initial = [test_cell('a'); 4];
    let before_wrap = test_frame_with_entries(
        FrameKind::Snapshot,
        4,
        1,
        0,
        0,
        &[RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &initial,
        }],
    );
    assert!(terminal.apply_presented_state_seq(&before_wrap, u32::MAX - 1));

    let at_max_cells = [test_cell('b'); 4];
    let at_max = test_frame_with_entries(
        FrameKind::Delta,
        4,
        1,
        1,
        0,
        &[RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &at_max_cells,
        }],
    );
    assert!(terminal.apply_presented_delta_seq(&at_max, u32::MAX));

    let after_wrap_cells = [test_cell('c'); 4];
    let after_wrap = test_frame_with_entries(
        FrameKind::Delta,
        4,
        1,
        2,
        0,
        &[RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &after_wrap_cells,
        }],
    );
    assert!(terminal.apply_presented_delta_seq(&after_wrap, 1));
    assert_eq!(terminal.row_text(0), "cccc");
    assert_eq!(terminal.display_row_versions, vec![1]);
    assert!(
        terminal
            .display_cell_versions
            .iter()
            .all(|version| *version == 1)
    );
    assert_eq!(terminal.display_header_version, 1);
    assert_eq!(
        terminal
            .last_applied_display_header
            .expect("wrapped header")
            .cursor_col,
        2,
    );

    terminal.clear_damaged_rows();
    let stale_cells = [test_cell('s'); 4];
    let stale = test_frame_with_entries(
        FrameKind::Delta,
        4,
        1,
        3,
        0,
        &[RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &stale_cells,
        }],
    );
    assert!(terminal.apply_presented_delta_seq(&stale, u32::MAX));
    assert!(!terminal.last_apply_visually_changed());
    assert_eq!(terminal.row_text(0), "cccc");
    assert_eq!(terminal.display_header_version, 1);
    assert!(terminal.damaged_rows.is_empty());

    let duplicate_cells = [test_cell('d'); 4];
    let duplicate = test_frame_with_entries(
        FrameKind::Delta,
        4,
        1,
        0,
        0,
        &[RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &duplicate_cells,
        }],
    );
    assert!(terminal.apply_presented_delta_seq(&duplicate, 1));
    assert!(!terminal.last_apply_visually_changed());
    assert_eq!(terminal.row_text(0), "cccc");
    assert_eq!(terminal.display_row_versions, vec![1]);
    assert!(
        terminal
            .display_cell_versions
            .iter()
            .all(|version| *version == 1)
    );
    assert_eq!(terminal.display_header_version, 1);
}

#[test]
fn sequence_zero_snapshot_after_ordering_reset_replaces_a_wrapped_grid() {
    let mut terminal = Terminal::new(3, 1);
    let old_cells = [test_cell('x'); 3];
    let old = test_frame(
        FrameKind::Snapshot,
        3,
        RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &old_cells,
        },
    );
    assert!(terminal.apply_presented_state_seq(&old, u32::MAX));

    terminal.reset_display_ordering();
    let replacement_cells = [test_cell('n'); 3];
    let replacement = test_frame(
        FrameKind::Snapshot,
        3,
        RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &replacement_cells,
        },
    );
    assert!(terminal.apply_presented_state_seq(&replacement, 0));
    assert_eq!(terminal.row_text(0), "nnn");
    assert_eq!(terminal.display_row_versions, vec![0]);
    assert!(
        terminal
            .display_cell_versions
            .iter()
            .all(|version| *version == 0)
    );
    assert_eq!(terminal.display_header_version, 0);

    let first_delta_cells = [test_cell('w'); 3];
    let first_delta = test_frame(
        FrameKind::Delta,
        3,
        RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &first_delta_cells,
        },
    );
    assert!(terminal.apply_presented_delta_seq(&first_delta, 1));
    assert_eq!(terminal.row_text(0), "www");
}

#[test]
fn seq_zero_snapshot_does_not_block_first_delta() {
    let mut terminal = Terminal::new(3, 1);
    let initial = [test_cell('a'), test_cell('b'), test_cell('c')];
    let snapshot = test_frame(
        FrameKind::Snapshot,
        3,
        RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &initial,
        },
    );
    assert!(terminal.apply_presented_state_seq(&snapshot, 0));
    assert_eq!(terminal.row_text(0), "abc");

    let blank = [test_cell(' '), test_cell(' '), test_cell(' ')];
    let delta = test_frame(
        FrameKind::Delta,
        3,
        RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &blank,
        },
    );
    assert!(terminal.apply_presented_delta_seq(&delta, 1));
    assert_eq!(terminal.row_text(0), "");
}

#[test]
fn viewport_rows_keeps_the_blank_tail_a_selection_can_cover() {
    let mut terminal = Terminal::new(6, 1);
    let cells = [
        test_cell('a'),
        test_cell('b'),
        test_cell(' '),
        test_cell(' '),
        test_cell(' '),
        test_cell(' '),
    ];
    let snapshot = test_frame(
        FrameKind::Snapshot,
        6,
        RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &cells,
        },
    );
    assert!(terminal.apply_presented_state_seq(&snapshot, 0));

    // Untrimmed: a selection dragged past the last glyph must be able to
    // pick up the blanks it covered. Trimming here would silently shorten
    // the copy, and the layer has no way to put the spaces back.
    assert_eq!(terminal.viewport_rows(), "ab    ");
    assert_eq!(terminal.row_text(0), "ab");
}

#[test]
fn viewport_wrap_bits_marks_only_the_row_that_continues() {
    let mut terminal = Terminal::new(4, 2);
    let mut wrapped_tail = test_cell('d');
    wrapped_tail.set_wrapped(true);
    let first = [test_cell('a'), test_cell('b'), test_cell('c'), wrapped_tail];
    let second = [
        test_cell('e'),
        test_cell('f'),
        test_cell('g'),
        test_cell('h'),
    ];
    let snapshot = test_frame_with_row_refs(
        FrameKind::Snapshot,
        4,
        2,
        &[
            RowRef {
                graphics: &[],
                row_index: 0,
                left: 0,
                cells: &first,
            },
            RowRef {
                graphics: &[],
                row_index: 1,
                left: 0,
                cells: &second,
            },
        ],
    );
    assert!(terminal.apply_presented_state_seq(&snapshot, 0));

    assert_eq!(terminal.viewport_rows(), "abcd\nefgh");
    // Row 0 continues onto row 1; row 1 ends the logical line. Copying the
    // pair must join them without a newline, or the pasted command breaks.
    let bits = terminal.viewport_wrap_bits();
    assert_eq!(bits.len(), 1);
    assert_eq!(bits[0] & 0b01, 0b01);
    assert_eq!(bits[0] & 0b10, 0);
}

#[test]
fn newer_headers_apply_across_sequence_gaps() {
    let mut terminal = Terminal::new(6, 6);
    let initial = [
        test_cell('a'),
        test_cell('b'),
        test_cell('c'),
        test_cell('d'),
        test_cell('e'),
        test_cell('f'),
    ];
    let snapshot = test_frame_with_rows(
        FrameKind::Snapshot,
        6,
        6,
        RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &initial,
        },
    );
    assert!(terminal.apply_presented_state_seq(&snapshot, 1));

    let patch = [test_cell('A')];
    let mut seq2 = test_frame_with_rows(
        FrameKind::Delta,
        6,
        6,
        RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &patch,
        },
    );
    seq2[STREAM_HEADER_BYTES + 9] = 2;
    let mut seq3 = seq2.clone();
    seq3[STREAM_HEADER_BYTES + 9] = 5;

    assert!(terminal.apply_presented_delta_seq(&seq3, 3));
    terminal.cursor_info_ptr();
    assert_eq!(terminal.cursor_info_buf[1], 5);
    assert!(terminal.apply_presented_delta_seq(&seq2, 2));
    terminal.cursor_info_ptr();
    assert_eq!(terminal.cursor_info_buf[1], 5);
}

#[test]
fn identical_newer_rows_advance_authority_without_damage_across_wrap() {
    for compressed in [false, true] {
        let mut terminal = Terminal::new(6, 2);
        let cells = [test_cell('a'); 6];
        let frame = test_frame_with_rows(
            FrameKind::Delta,
            6,
            2,
            RowRef {
                graphics: &[],
                row_index: 1,
                left: 0,
                cells: &cells,
            },
        );
        terminal.reset_display_ordering();
        let initial = test_frame_with_rows(
            FrameKind::Snapshot,
            6,
            2,
            RowRef {
                graphics: &[],
                row_index: 1,
                left: 0,
                cells: &cells,
            },
        );
        assert!(terminal.apply_presented_state_seq(&initial, u32::MAX - 1));
        for seq in [u32::MAX, 1] {
            terminal.clear_damaged_rows();
            terminal.full_damage = false;
            terminal.refresh_row_hashes();
            let revision = terminal.authoritative_revision;
            if compressed {
                let wire = compressed_test_frame(&frame, None);
                let handle = stage_test_frame(&mut terminal, &wire);
                assert_ne!(handle, 0);
                assert!(terminal.apply_presented_staged_delta_seq(handle, seq));
                terminal.release_staged_frame(handle);
            } else {
                assert!(terminal.apply_presented_delta_seq(&frame, seq));
            }
            assert_eq!(terminal.display_row_version(1), seq);
            assert_eq!(&terminal.display_cell_versions[6..12], &[seq; 6]);
            assert_eq!(
                &terminal.authoritative_cell_revisions[6..12],
                &[revision + 1; 6]
            );
            assert_eq!(terminal.authoritative_header_revision, revision + 1);
            assert_eq!(terminal.display_header_version, seq);
            assert!(!terminal.last_apply_visually_changed());
            assert!(terminal.damaged_rows.is_empty());
            assert!(!terminal.row_hash_all_dirty);
            assert!(terminal.row_hash_dirty_list.is_empty());
            assert!(!terminal.full_damage);
        }
        // A snapshot still obliges a full presentation even if identical.
        assert!(terminal.apply_presented_state_seq(&initial, 2));
        assert!(terminal.full_damage);
        assert!(terminal.last_apply_visually_changed());
    }
}

#[test]
fn damage_stays_bounded_by_the_rows_when_nothing_builds_geometry() {
    // A native host never builds geometry, so nothing ever drains its damage
    // list: each row may appear in it at most once however many frames apply.
    let mut terminal = Terminal::new(6, 2);
    for seq in 1..=64u32 {
        let cells = [test_cell(char::from(b'a' + (seq % 26) as u8)); 6];
        let frame = test_frame_with_rows(
            FrameKind::Delta,
            6,
            2,
            RowRef {
                graphics: &[],
                row_index: (seq % 2) as u16,
                left: 0,
                cells: &cells,
            },
        );
        assert!(terminal.apply_presented_delta_seq(&frame, seq));
    }
    let mut damaged = terminal.damaged_rows.clone();
    damaged.sort_unstable();
    assert_eq!(damaged, [0, 1]);
}

#[test]
fn row_damage_bounds_exclude_identical_cells_but_authority_covers_the_span() {
    let mut terminal = Terminal::new(6, 1);
    let cells = [test_cell('a'); 6];
    let frame = test_frame(
        FrameKind::Delta,
        6,
        RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &cells,
        },
    );
    assert!(terminal.apply_presented_delta_seq(&frame, 1));
    terminal.clear_damaged_rows();
    let mut changed = cells;
    changed[2].attrs |= CellAttrs::BOLD;
    changed[3].codepoint = u32::from('b');
    let frame = test_frame(
        FrameKind::Delta,
        6,
        RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &changed,
        },
    );
    assert!(terminal.apply_presented_delta_seq(&frame, 2));
    assert_eq!(terminal.damaged_rows, [0]);
    assert_eq!(terminal.display_cell_versions, [2; 6]);
    assert_eq!(terminal.authoritative_cell_revisions, [2; 6]);
    assert!(terminal.last_apply_visually_changed());
}

#[test]
fn canonical_cell_damage_compares_colors_flags_and_removed_extra_state() {
    let mut cell = Cell::default();
    let blank = test_cell(' ');
    assert!(!write_cell(&mut cell, blank));
    cell.fg = Color::Spec(Rgb {
        r: DEFAULT_FOREGROUND[0],
        g: DEFAULT_FOREGROUND[1],
        b: DEFAULT_FOREGROUND[2],
    });
    assert!(!write_cell(&mut cell, blank));
    cell.bg = Color::Spec(Rgb {
        r: DEFAULT_BACKGROUND[0],
        g: DEFAULT_BACKGROUND[1],
        b: DEFAULT_BACKGROUND[2],
    });
    // Equal background RGB can still change image coverage.
    assert!(write_cell(&mut cell, blank));
    assert_eq!(
        cell,
        Cell::default(),
        "canonical defaults remain reflow-empty"
    );
    for flag in [Flags::WIDE_CHAR_SPACER, Flags::LEADING_WIDE_CHAR_SPACER] {
        cell.flags = flag;
        assert!(write_cell(&mut cell, blank));
    }
    cell.push_zerowidth('\u{301}');
    assert!(write_cell(&mut cell, blank));
    assert!(cell.extra.is_none());
    for field in 0..10 {
        let mut changed = blank;
        match field {
            0 => changed.codepoint = u32::from('a'),
            1 => changed.fg = [1, 2, 3],
            2 => changed.bg = [3, 2, 1],
            3 => changed.attrs |= CellAttrs::WIDE,
            4 => changed.attrs |= CellAttrs::BOLD,
            5 => changed.attrs |= CellAttrs::ITALIC,
            6 => changed.attrs |= CellAttrs::UNDERLINE,
            7 => changed.attrs |= CellAttrs::INVERSE,
            8 => changed.attrs |= CellAttrs::WRAPPED,
            _ => changed.attrs |= CellAttrs::EXPLICIT_DEFAULT_BG,
        }
        assert!(write_cell(&mut cell, changed));
        assert!(!write_cell(&mut cell, changed));
        assert!(write_cell(&mut cell, blank));
    }
}

#[test]
fn identical_authority_reconciles_confirmation_and_bounds_an_unechoed_prediction() {
    for unechoed in [false, true] {
        let mut terminal = terminal_with_atlas(8, 1);
        train_shadow_text(&mut terminal, "ab");
        if unechoed {
            assert_ne!(
                terminal.predict_printable(u32::from('x'), 101.0, 3, true),
                0
            );
        } else {
            assert_ne!(terminal.predict_backspace(101.0, 3), 0);
            assert_ne!(
                terminal.predict_printable(u32::from('b'), 102.0, 4, true),
                0
            );
        }
        terminal.build_presented_geometry();
        terminal.clear_prediction_render_dirty();
        // Refresh the predicted column too: freshness without changed cells
        // and cursor still cannot distinguish a missing echo from PTY write
        // coverage that arrived before the echo.
        let mut authority = [test_cell(' '); 8];
        authority[0] = test_cell('a');
        authority[1] = test_cell('b');
        let frame = test_frame_with_entries(
            FrameKind::Delta,
            8,
            1,
            2,
            0,
            &[RowRef {
                graphics: &[],
                row_index: 0,
                left: 0,
                cells: &authority,
            }],
        );
        let revision = terminal.authoritative_revision;
        assert!(terminal.apply_presented_delta_seq(&frame, 2));
        assert_eq!(terminal.display_row_version(0), 2);
        assert_eq!(
            &terminal.authoritative_cell_revisions[..2],
            &[revision + 1; 2]
        );
        let input_high_water = if unechoed { 3 } else { 4 };
        terminal.predict_reconcile(120.0, 500.0, input_high_water, input_high_water);
        terminal.predict_reconcile(140.0, 500.0, input_high_water, input_high_water);
        if unechoed {
            assert!(terminal.has_predictions());
            assert_eq!(terminal.reconcile_stats, [0, 0, 0, 0, 0, 1, 0]);
            terminal.predict_reconcile(602.0, 500.0, input_high_water, input_high_water);
            assert_eq!(terminal.reconcile_stats, [0, 0, 1, 0, 0, 0, 0]);
        }
        assert!(!terminal.has_predictions());
        assert!(terminal.prediction_render_dirty());
        assert_eq!(drawn_cursor(&mut terminal), (0, 2));
        assert_eq!(terminal.viewport_rows(), "ab      ");
        terminal.build_presented_geometry();
        assert!(terminal.visible_prediction_input_seqs.is_empty());
    }
}

#[test]
fn identical_row_with_new_cursor_still_damages_and_presents_the_cursor() {
    let mut terminal = Terminal::new(6, 1);
    let cells = [test_cell('a'); 6];
    for cursor_col in [0, 2] {
        terminal.clear_damaged_rows();
        let frame = test_frame_with_entries(
            FrameKind::Delta,
            6,
            1,
            cursor_col,
            0,
            &[RowRef {
                graphics: &[],
                row_index: 0,
                left: 0,
                cells: &cells,
            }],
        );
        assert!(terminal.apply_presented_delta_seq(&frame, u32::from(cursor_col) + 1));
        assert!(terminal.last_apply_visually_changed());
        assert_eq!(drawn_cursor(&mut terminal), (0, cursor_col));
    }
}

#[test]
fn identical_newer_header_advances_ordering_without_visual_mutation() {
    let mut terminal = Terminal::new(6, 6);
    let header = test_cursor_frame(6, 6, 2, 3, CURSOR_SHAPE_BLOCK, 1);

    assert!(terminal.apply_presented_delta_seq(&header, 1));
    assert!(terminal.last_apply_visually_changed());
    terminal.clear_damaged_rows();
    assert!(terminal.apply_presented_delta_seq(&header, 2));
    assert!(!terminal.last_apply_visually_changed());
    assert!(terminal.damaged_rows.is_empty());

    let moved = test_cursor_frame(6, 6, 3, 3, CURSOR_SHAPE_BLOCK, 1);
    assert!(terminal.apply_presented_delta_seq(&moved, 3));
    assert!(terminal.last_apply_visually_changed());
}

#[test]
fn display_header_applies_cursor_visibility() {
    let mut terminal = Terminal::new(3, 1);
    let cells = [test_cell('a')];
    let mut frame = test_frame(
        FrameKind::Delta,
        3,
        RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &cells,
        },
    );
    frame[STREAM_HEADER_BYTES + 10] = CURSOR_SHAPE_BLOCK;

    assert!(terminal.apply_presented_delta_seq(&frame, 1));
    terminal.cursor_info_ptr();
    assert_eq!(terminal.cursor_info_buf[3], 0);
}

#[test]
fn preedit_appends_overlay_geometry_and_clears() {
    let mut terminal = terminal_with_atlas(10, 2);
    terminal.build_presented_geometry();
    let base_glyphs = terminal.glyph_count();
    let base_bg = terminal.bg_count();
    let base_deco = terminal.deco_count();

    terminal.set_preedit("ab", 2);
    terminal.build_presented_geometry();
    // Two glyphs plus one bg highlight quad and one underline quad.
    assert_eq!(terminal.glyph_count(), base_glyphs + 2);
    assert_eq!(terminal.bg_count(), base_bg + 1);
    assert_eq!(terminal.deco_count(), base_deco + 1);

    terminal.set_preedit("", 0);
    terminal.build_presented_geometry();
    assert_eq!(terminal.glyph_count(), base_glyphs);
    assert_eq!(terminal.bg_count(), base_bg);
    assert_eq!(terminal.deco_count(), base_deco);
}

#[test]
fn preedit_overflow_keeps_tail_visible() {
    let mut terminal = terminal_with_atlas(4, 1);
    terminal.build_presented_geometry();
    let base_glyphs = terminal.glyph_count();

    // Six cells into a four-column row: the run is trimmed from the front
    // so the most recently composed tail stays visible.
    terminal.set_preedit("abcdef", 6);
    terminal.build_presented_geometry();
    assert_eq!(terminal.glyph_count(), base_glyphs + 4);
}

#[test]
fn preedit_wider_than_grid_draws_nothing() {
    let mut terminal = terminal_with_atlas(1, 1);
    terminal.build_presented_geometry();
    let base_bg = terminal.bg_count();
    let base_deco = terminal.deco_count();

    // A double-width char cannot fit a one-column row: the trim consumes
    // the whole run, and no zero-width quads may be pushed.
    terminal.set_preedit("あ", 1);
    terminal.build_presented_geometry();
    assert_eq!(terminal.bg_count(), base_bg);
    assert_eq!(terminal.deco_count(), base_deco);
}

#[test]
fn preedit_noop_set_does_not_mark_dirty() {
    let mut terminal = terminal_with_atlas(10, 2);
    terminal.build_presented_geometry();
    terminal.set_preedit("xy", 2);
    terminal.build_presented_geometry();
    let glyphs = terminal.glyph_count();

    // Re-setting identical preedit must not dirty or rebuild.
    terminal.set_preedit("xy", 2);
    assert!(!terminal.preedit_dirty);
    terminal.build_presented_geometry();
    assert_eq!(terminal.glyph_count(), glyphs);
}

#[test]
fn preedit_converts_dom_utf16_caret_to_unicode_scalar_index() {
    let mut terminal = Terminal::new(10, 2);

    terminal.set_preedit("🙂a", 2);
    assert_eq!(terminal.preedit_caret, 1);

    terminal.set_preedit("🙂a", 3);
    assert_eq!(terminal.preedit_caret, 2);

    // A defensive direct-WASM caller cannot place the caret inside the
    // emoji's surrogate pair; clamp to the preceding scalar boundary.
    terminal.set_preedit("🙂a", 1);
    assert_eq!(terminal.preedit_caret, 0);

    terminal.set_preedit("🙂a", u32::MAX);
    assert_eq!(terminal.preedit_caret, 2);
}

#[test]
fn preedit_missing_glyph_stays_dirty_until_injected() {
    let mut terminal = terminal_with_atlas(10, 2);
    terminal.build_presented_geometry();

    // 'あ' is not in the bundled font: it is queued for JS rasterization
    // and the overlay stays dirty so the post-injection build re-appends.
    terminal.set_preedit("あ", 1);
    terminal.build_presented_geometry();
    assert!(terminal.preedit_dirty);
    terminal.missing_codepoints_ptr();
    // Flat (codepoint, style) pairs.
    assert_eq!(terminal.missing_buf, vec![0x3042u32, 0]);
}

#[test]
fn preedit_space_does_not_pin_the_overlay_dirty() {
    // A space is in the font but rasterizes to zero area. Treating that as
    // "queued for rasterization" kept `preedit_dirty` set forever, which
    // defeats the damage early-return and re-runs the whole build on every
    // render for the life of the composition.
    let mut terminal = terminal_with_atlas(10, 2);
    terminal.build_presented_geometry();

    terminal.set_preedit("a b", 3);
    terminal.build_presented_geometry();

    terminal.missing_codepoints_ptr();
    assert!(terminal.missing_buf.is_empty());
    assert!(!terminal.preedit_dirty);
}

#[test]
fn a_declined_glyph_is_offered_once_not_every_build() {
    // Nothing injects during this test, so the codepoint is declined. It
    // must not be re-queued: the JS pass runs a canvas readback per entry
    // per build, so re-queuing is a permanent per-frame cost.
    let mut terminal = terminal_with_atlas(10, 2);
    terminal.set_preedit("あ", 1);
    terminal.build_presented_geometry();

    terminal.missing_codepoints_ptr();
    assert_eq!(terminal.missing_buf, vec![0x3042u32, 0]);
    terminal.finish_missing_pass();

    terminal.full_damage = true;
    terminal.build_presented_geometry();
    terminal.missing_codepoints_ptr();
    assert!(terminal.missing_buf.is_empty());
    assert!(!terminal.preedit_dirty);
}

#[test]
fn an_injected_glyph_resolves_every_style() {
    // The Canvas 2D stack has no bold or italic variant, so one bitmap
    // answers all four styles. Without aliasing, a bold cell would miss at
    // style 1, be answered at style 0, and re-queue forever.
    let mut terminal = terminal_with_atlas(10, 2);
    terminal.set_preedit("あ", 1);
    terminal.build_presented_geometry();

    assert!(terminal.inject_glyph(0x3042, 0, 2, 2, 0, 0, &[9u8; 4]));

    let atlas = terminal.atlas.as_ref().expect("atlas");
    for style in 0..4u8 {
        let key = atlas::GlyphKey {
            codepoint: 0x3042,
            style,
        };
        assert!(
            atlas.rasterized(&key).is_some(),
            "style {style} unresolved after injection"
        );
    }
}

// ── Editor anchor ────────────────────────────────────────────────────────

/// A terminal showing `prompt> typed` with an autosuggestion filling the
/// rest of the row — the shape a real shell produces, and the shape that
/// defeats the ordinary re-seed path.
fn terminal_with_prompt_and_autosuggestion() -> Terminal {
    let mut terminal = Terminal::new(40, 2);
    let text = "prompt> typed";
    let suggestion = "-suggestion-rest";
    let mut cells: Vec<CellRepr> = text.chars().map(test_cell).collect();
    cells.extend(suggestion.chars().map(test_cell));
    cells.resize(40, test_cell(' '));

    let frame = test_frame_with_entries(
        FrameKind::Snapshot,
        40,
        2,
        text.len() as u16, // cursor sits after "typed"
        0,
        &[RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &cells,
        }],
    );
    assert!(terminal.apply_presented_state_seq(&frame, 1));
    terminal
}

#[test]
fn without_an_anchor_a_non_blank_row_tail_blocks_re_seeding() {
    // This is the behaviour the anchor exists to fix: after any mid-line
    // flush, a shell autosuggestion keeps the shadow permanently dead.
    let mut terminal = terminal_with_prompt_and_autosuggestion();
    assert_eq!(terminal.predict_printable(u32::from('x'), 0.0, 1, true), 0);
}

#[test]
fn an_anchor_lets_the_shadow_re_seed_across_a_non_blank_tail() {
    let mut terminal = terminal_with_prompt_and_autosuggestion();
    terminal.set_presented_editor_anchor(1, 0, 8, 1); // prompt ends at column 8

    assert_ne!(terminal.predict_printable(u32::from('x'), 0.0, 1, true), 0);
    let line = terminal.shadow_line.as_ref().expect("seeded");
    assert_eq!(line.start_col, 8);
    // "typed" is adopted as already-typed base, so a backspace can reach
    // back into it rather than only to where typing resumed.
    assert_eq!(line.projected.cells.len(), "typed".len() + 1);
}

#[test]
fn a_backspace_can_delete_into_authority_the_anchor_seeded() {
    // Backspace never seeds a line itself; a printable does. The win is
    // that once seeded, deletion reaches back through text typed before
    // this browser was even modelling the line.
    let mut terminal = terminal_with_prompt_and_autosuggestion();
    terminal.set_presented_editor_anchor(1, 0, 8, 1);
    assert_ne!(terminal.predict_printable(u32::from('x'), 0.0, 1, true), 0);
    assert_eq!(
        terminal
            .shadow_line
            .as_ref()
            .expect("seeded")
            .projected
            .cells
            .len(),
        "typed".len() + 1
    );

    // Delete the 'x', then keep going into the seeded authority.
    assert_ne!(terminal.predict_backspace(0.0, 2), 0);
    assert_ne!(terminal.predict_backspace(0.0, 3), 0);
    assert_eq!(
        terminal
            .shadow_line
            .as_ref()
            .expect("seeded")
            .projected
            .cells
            .len(),
        "typed".len() - 1
    );
}

#[test]
fn an_anchor_on_another_row_or_past_the_cursor_is_refused() {
    for (row, col) in [(1u16, 8u16), (0, 20)] {
        let mut terminal = terminal_with_prompt_and_autosuggestion();
        terminal.set_presented_editor_anchor(1, row, col, 1);
        assert_eq!(
            terminal.predict_printable(u32::from('x'), 0.0, 1, true),
            0,
            "anchor ({row},{col}) must be refused"
        );
    }
}

#[test]
fn a_wide_glyph_at_the_cursor_refuses_anchor_seeding() {
    // The cell at the cursor is the first one a prediction overwrites, and
    // seeding is the only path that reaches a paint without
    // `shadow_state_matches_authority` having vetted it. Painting a
    // single-width glyph over a wide one strands its spacer.
    let mut terminal = Terminal::new(40, 2);
    let mut cells: Vec<CellRepr> = "prompt> ".chars().map(test_cell).collect();
    let mut wide = test_cell('\u{65e5}'); // CJK: two columns
    wide.attrs |= CellAttrs::WIDE;
    cells.push(wide);
    cells.resize(40, test_cell(' '));

    let frame = test_frame_with_entries(
        FrameKind::Snapshot,
        40,
        2,
        8, // cursor sits on the wide glyph
        0,
        &[RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &cells,
        }],
    );
    assert!(terminal.apply_presented_state_seq(&frame, 1));
    terminal.set_presented_editor_anchor(1, 0, 8, 1);

    assert_eq!(terminal.predict_printable(u32::from('x'), 0.0, 1, true), 0);
}

#[test]
fn an_anchor_at_the_last_column_refuses_seeding() {
    // `cursor` is indexed directly, so the one-past-the-end position must
    // not be accepted.
    let mut terminal = terminal_with_prompt_and_autosuggestion();
    terminal.set_presented_editor_anchor(1, 0, 39, 1);
    assert_eq!(terminal.predict_printable(u32::from('x'), 0.0, 1, true), 0);
}

#[test]
fn a_closed_editor_boundary_voids_the_anchor() {
    let mut terminal = terminal_with_prompt_and_autosuggestion();
    terminal.set_presented_editor_anchor(1, 0, 8, 1);
    assert_ne!(terminal.predict_printable(u32::from('x'), 0.0, 1, true), 0);

    // flags bit 0 clear: the shell left the line editor.
    terminal.set_presented_editor_anchor(2, 0, 8, 0);
    assert!(terminal.shadow_line.is_none());
    assert_eq!(terminal.predict_printable(u32::from('y'), 0.0, 2, true), 0);
}

#[test]
fn a_moved_anchor_discards_a_shadow_seeded_from_the_previous_prompt() {
    let mut terminal = terminal_with_prompt_and_autosuggestion();
    terminal.set_presented_editor_anchor(1, 0, 8, 1);
    assert_ne!(terminal.predict_printable(u32::from('x'), 0.0, 1, true), 0);
    assert!(terminal.shadow_line.is_some());

    terminal.set_presented_editor_anchor(2, 0, 3, 1);
    assert!(terminal.shadow_line.is_none());
}

#[test]
fn seeded_cells_are_not_reported_as_speculative_glyphs() {
    // They already equal authority, so painting them would be wrong.
    let mut terminal = terminal_with_prompt_and_autosuggestion();
    terminal.set_presented_editor_anchor(1, 0, 8, 1);
    assert_ne!(terminal.predict_printable(u32::from('x'), 0.0, 1, true), 0);
    assert_eq!(terminal.predictions.len(), 1);
    assert_eq!(terminal.predictions[0].codepoint, u32::from('x'));
}

#[test]
fn an_anchor_is_ignored_while_the_prediction_mode_is_unsafe() {
    // A withdrawn daemon grant fails closed regardless of how good the
    // anchor is. This is the whole gate now: no terminal mode withholds
    // prediction on its own.
    let mut terminal = terminal_with_prompt_and_autosuggestion();
    terminal.set_presented_editor_anchor(1, 0, 8, 1);
    terminal.display_mode = 0;
    assert_eq!(terminal.predict_printable(u32::from('x'), 0.0, 1, true), 0);

    // An unmodelled future mode bit still fails closed.
    let mut terminal = terminal_with_prompt_and_autosuggestion();
    terminal.set_presented_editor_anchor(1, 0, 8, 1);
    terminal.display_mode = DISPLAY_MODE_PREDICTION_SAFE | (DISPLAY_MODE_KNOWN_MASK + 1);
    assert_eq!(terminal.predict_printable(u32::from('x'), 0.0, 1, true), 0);
}

#[test]
fn mouse_tracking_alone_no_longer_withholds_prediction() {
    // The other half of the tmux case, and the reason removing the
    // alternate-screen proxy alone changed nothing for real users: tmux
    // with `mouse on` sets the mouse bits and the alternate screen
    // together, so vetoing on either one withheld local echo from the same
    // sessions. Mouse tracking governs pointer-event encoding and says
    // nothing about whether the shell echoes typed characters; the
    // authenticated prompt-boundary grant is what decides.
    for mouse_bit in [1u32, 2, 4] {
        let mut terminal = terminal_with_prompt_and_autosuggestion();
        terminal.set_presented_editor_anchor(1, 0, 8, 1);
        terminal.display_mode = DISPLAY_MODE_PREDICTION_SAFE | DISPLAY_MODE_ALT_SCREEN | mouse_bit;

        assert_ne!(
            terminal.predict_printable(u32::from('x'), 0.0, 1, true),
            0,
            "a multiplexer pane with mouse bit {mouse_bit} must still predict"
        );
    }
}

#[test]
fn the_alternate_screen_alone_no_longer_withholds_prediction() {
    // This is the tmux case. The multiplexer holds the alternate screen for
    // its entire lifetime while the shell inside it has an ordinary line
    // editor, so treating the alternate screen as unsafe withheld local echo
    // from every tmux session permanently. The daemon's authenticated
    // prompt-boundary grant is what decides now.
    let mut terminal = terminal_with_prompt_and_autosuggestion();
    terminal.set_presented_editor_anchor(1, 0, 8, 1);
    terminal.display_mode = DISPLAY_MODE_PREDICTION_SAFE | DISPLAY_MODE_ALT_SCREEN;

    assert_ne!(
        terminal.predict_printable(u32::from('x'), 0.0, 1, true),
        0,
        "an alternate-screen shell with a live grant must still predict"
    );
}

// ── Row copies ───────────────────────────────────────────────────────────

// ── Reflow ───────────────────────────────────────────────────────────────

/// Snapshot a terminal from `(text, wrapped)` rows, space-padded to `cols`.
fn terminal_with_wrapped_rows(cols: u16, rows: &[(&str, bool)]) -> Terminal {
    let mut terminal = Terminal::new(cols, rows.len() as u16);
    let row_cells: Vec<Vec<CellRepr>> = rows
        .iter()
        .map(|(text, wrapped)| {
            let mut cells: Vec<CellRepr> = text
                .chars()
                .chain(std::iter::repeat(' '))
                .take(usize::from(cols))
                .map(test_cell)
                .collect();
            if let Some(last) = cells.last_mut() {
                last.set_wrapped(*wrapped);
            }
            cells
        })
        .collect();
    let refs: Vec<RowRef<'_>> = row_cells
        .iter()
        .enumerate()
        .map(|(row, cells)| RowRef {
            graphics: &[],
            row_index: row as u16,
            left: 0,
            cells: cells.as_slice(),
        })
        .collect();
    let frame = test_frame_with_row_refs(FrameKind::Snapshot, cols, rows.len() as u16, &refs);
    assert!(terminal.apply_presented_state_seq(&frame, 1));
    terminal
}

fn all_row_text(terminal: &Terminal) -> Vec<String> {
    (0..terminal.rows())
        .map(|row| row_text(terminal, row))
        .collect()
}

/// Widening rejoins a row with its continuation, which is the whole point
/// of carrying the wrap bit: without it this grid pads every row with
/// blanks and shows a break the daemon is about to close.
#[test]
fn a_column_grow_rejoins_a_wrapped_row() {
    let mut terminal =
        terminal_with_wrapped_rows(8, &[("abcdefgh", true), ("ijkl", false), ("", false)]);
    terminal.resize(16, 3);

    assert_eq!(
        all_row_text(&terminal),
        vec![
            " ".repeat(16),
            "abcdefghijkl    ".to_string(),
            " ".repeat(16),
        ],
        "the freed row must land at the top, above content that stays put",
    );
}

/// Narrowing pushes the overflow onto a new row and marks the row it came
/// from as wrapped, so a second narrowing keeps splitting in the same
/// place rather than truncating.
#[test]
fn a_column_shrink_wraps_the_overflow_onto_the_next_row() {
    let mut terminal =
        terminal_with_wrapped_rows(16, &[("", false), ("", false), ("abcdefghijklmnop", false)]);
    terminal.resize(8, 3);

    assert_eq!(
        all_row_text(&terminal),
        vec![
            " ".repeat(8),
            "abcdefgh".to_string(),
            "ijklmnop".to_string()
        ],
    );
}

/// Adding rows lands them above the content, not below it. The daemon
/// fills them from scrollback and leaves the prompt on the bottom line;
/// pushing content up instead would move the one row the user is looking
/// at, and move it back a round trip later.
#[test]
fn a_row_grow_keeps_the_last_line_on_the_bottom() {
    let mut terminal = terminal_with_wrapped_rows(4, &[("ab", false), ("cd", false)]);
    terminal.resize(4, 4);

    assert_eq!(
        all_row_text(&terminal),
        vec![
            "    ".to_string(),
            "    ".to_string(),
            "ab  ".to_string(),
            "cd  ".to_string(),
        ],
    );
}

/// The blank history a growing reflow borrows is handed straight back, and
/// a shrinking one parks nothing in it. Otherwise every drag of a window
/// edge would leave rows behind in a buffer nothing can scroll to and
/// nothing frees.
#[test]
fn resizing_leaves_no_scrollback_behind() {
    let mut terminal = terminal_with_wrapped_rows(
        16,
        &[("abcdefghijklmnop", true), ("qrstuvwx", false), ("", false)],
    );
    for (cols, rows) in [(8u16, 3u16), (24, 3), (8, 6), (16, 3), (40, 3)] {
        terminal.resize(cols, rows);
        assert_eq!(
            terminal.term.grid().history_size(),
            0,
            "{cols}x{rows} left scrollback behind",
        );
        assert_eq!(terminal.term.grid().display_offset(), 0);
    }
}

/// A row without the wrap bit is a row that ends there. Rejoining it would
/// glue two unrelated lines together — the failure the bit exists to
/// prevent, and the one a receiver that assumed every full row wraps would
/// hit constantly.
#[test]
fn a_grow_leaves_an_unwrapped_row_alone() {
    let mut terminal =
        terminal_with_wrapped_rows(8, &[("abcdefgh", false), ("ijkl", false), ("", false)]);
    terminal.resize(16, 3);

    assert_eq!(
        all_row_text(&terminal),
        vec![
            "abcdefgh        ".to_string(),
            "ijkl            ".to_string(),
            " ".repeat(16),
        ],
    );
}

/// The alternate screen resizes without reflow, because that is what the
/// daemon's alacritty does with it. This grid is told which screen is
/// active rather than entering it, so the mode has to reach the decision
/// by hand — and if it stops doing so, a full-width row in `less` splits
/// here and stays split until the next authoritative frame.
#[test]
fn the_alternate_screen_resizes_without_reflow() {
    let mut terminal =
        terminal_with_wrapped_rows(16, &[("", false), ("", false), ("abcdefghijklmnop", true)]);
    terminal.display_mode = DISPLAY_MODE_PREDICTION_SAFE | DISPLAY_MODE_ALT_SCREEN;
    terminal.resize(8, 3);

    assert_eq!(
        all_row_text(&terminal),
        vec![" ".repeat(8), " ".repeat(8), "abcdefgh".to_string()],
    );
}

/// A snapshot applied after a resize overwrites rows the terminal already
/// holds at a higher seq.
///
/// This is the precondition the reflow oracles in `display/viewer.rs` rest
/// on, and it is not obvious: the per-cell ordering gate refuses cells at
/// or below the version already stored, so in a settled session a snapshot
/// can be almost entirely discarded — which is how a snapshot that had
/// dropped every wrap bit once passed an oracle that measured after one.
/// `resize` clears those versions, so the snapshot lands whole. If that
/// ever stops being true, those oracles quietly go back to comparing
/// whatever the deltas left behind, and this fails first.
#[test]
fn a_snapshot_after_a_resize_overwrites_a_higher_seq_grid() {
    let mut terminal = terminal_with_wrapped_rows(8, &[("old", false), ("rows", false)]);
    // Advance the ordering well past anything the snapshot will carry.
    let bump: Vec<CellRepr> = "zzzzzzzz".chars().map(test_cell).collect();
    for row in 0..2u16 {
        let frame = test_frame_with_rows(
            FrameKind::Delta,
            8,
            2,
            RowRef {
                graphics: &[],
                row_index: row,
                left: 0,
                cells: &bump,
            },
        );
        assert!(terminal.apply_presented_delta_seq(&frame, 500));
    }
    assert_eq!(all_row_text(&terminal), vec!["zzzzzzzz", "zzzzzzzz"]);

    terminal.resize(8, 2);

    // A snapshot at a far lower seq than the grid already carries.
    let fresh: Vec<CellRepr> = "abcdefgh".chars().map(test_cell).collect();
    let refs = [
        RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &fresh,
        },
        RowRef {
            graphics: &[],
            row_index: 1,
            left: 0,
            cells: &fresh,
        },
    ];
    let frame = test_frame_with_row_refs(FrameKind::Snapshot, 8, 2, &refs);
    assert!(terminal.apply_presented_state_seq(&frame, 1));

    assert_eq!(
        all_row_text(&terminal),
        vec!["abcdefgh", "abcdefgh"],
        "the snapshot was swallowed by the ordering gate the resize should \
         have cleared",
    );
}

/// A replicated row is only "clear" if its cells compare equal to the
/// default, which `Cell::is_empty` decides on the color *discriminant*.
/// Restating a default color as an equal `Color::Spec` makes every row
/// permanently non-empty — invisible everywhere except reflow, where it
/// stops cleared rows from collapsing and pushes content off the screen.
#[test]
fn a_replicated_blank_row_is_clear_to_the_grid() {
    let terminal = terminal_with_wrapped_rows(8, &[("ab", false), ("", false)]);
    let grid = terminal.term.grid();
    assert!(!grid[Line(0)].is_clear(), "row 0 holds content");
    assert!(
        grid[Line(1)].is_clear(),
        "row 1 is blank and must read clear"
    );
}

fn row_text(terminal: &Terminal, row: u16) -> String {
    let grid = terminal.term.grid();
    (0..grid.columns())
        .map(|col| grid[Point::new(Line(i32::from(row)), Column(col))].c)
        .collect()
}
