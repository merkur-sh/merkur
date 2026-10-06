use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell as Counter;

use alacritty_terminal::grid::{AnchorEvent, Grid, ImageAnchorBounds};
use alacritty_terminal::index::{Column, Line, Point};
use alacritty_terminal::term::cell::Cell;

thread_local! {
    static TRACK: Counter<bool> = const { Counter::new(false) };
    static ALLOCATIONS: Counter<usize> = const { Counter::new(0) };
    static LIVE_BYTES: Counter<isize> = const { Counter::new(0) };
}

struct CountingAllocator;

// Test-only instrumentation delegates every allocation unchanged to System.
unsafe impl GlobalAlloc for CountingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        if TRACK.get() {
            ALLOCATIONS.set(ALLOCATIONS.get() + 1);
            LIVE_BYTES.set(LIVE_BYTES.get() + layout.size() as isize);
        }
        unsafe { System.alloc(layout) }
    }
    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        if TRACK.get() {
            ALLOCATIONS.set(ALLOCATIONS.get() + 1);
            LIVE_BYTES.set(LIVE_BYTES.get() + size as isize - layout.size() as isize);
        }
        unsafe { System.realloc(pointer, layout, size) }
    }
    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        if TRACK.get() {
            LIVE_BYTES.set(LIVE_BYTES.get() - layout.size() as isize);
        }
        unsafe { System.dealloc(pointer, layout) }
    }
}

#[test]
fn deleting_attachments_releases_peak_row_metadata_capacity() {
    let mut grid = Grid::<Cell>::new(2, 80, 0);
    let mut handles = Vec::with_capacity(1024);
    LIVE_BYTES.set(0);
    TRACK.set(true);
    for _ in 0..1024 {
        handles.push(grid.anchor(Point::new(Line(0), Column(0))).unwrap());
    }
    assert!(LIVE_BYTES.get() > 1024 * 8);
    while handles.len() > 1 {
        let handle = handles.pop().unwrap();
        assert!(grid.remove_anchor(&handle));
    }
    // One live placement's metadata reservation covers its attachment and the
    // row/domain bookkeeping. Deleted placements cannot leave uncharged slack.
    assert!(LIVE_BYTES.get() > 0);
    assert!(LIVE_BYTES.get() < 2048);
    TRACK.set(false);
}

#[global_allocator]
static ALLOCATOR: CountingAllocator = CountingAllocator;

#[test]
fn contained_image_motion_and_retirement_reuse_all_admitted_storage() {
    let mut grid = Grid::<Cell>::new(8, 80, 1000);
    let bounds = ImageAnchorBounds {
        left: 0,
        top: 0,
        right: 1 << 32,
        bottom: 2 << 32,
    };
    let mut handles = Vec::with_capacity(8192);
    for tag in 1..=8192 {
        handles.push(
            grid.image_anchor(
                Point::new(Line(2), Column(0)),
                std::num::NonZeroU64::new(tag).unwrap(),
                bounds,
            )
            .unwrap(),
        );
    }
    ALLOCATIONS.set(0);
    TRACK.set(true);
    for _ in 0..32 {
        grid.scroll_down(&(Line(1)..Line(7)), 1);
        grid.scroll_up(&(Line(1)..Line(7)), 1);
    }
    grid.retire_visible_anchors();
    let mut retired = 0;
    while let Some(event) = grid.take_anchor_event() {
        assert!(matches!(event, AnchorEvent::Retired(_)));
        retired += 1;
    }
    TRACK.set(false);
    assert_eq!(retired, handles.len());
    assert!(handles.iter().all(|handle| handle.is_retired()));
    assert_eq!(ALLOCATIONS.get(), 0);
}

#[test]
fn warmed_text_scroll_and_anchor_rotation_have_no_allocations() {
    let mut grid = Grid::<Cell>::new(24, 80, 1000);
    for _ in 0..1100 {
        grid.scroll_up(&(Line(0)..Line(24)), 1);
    }
    ALLOCATIONS.set(0);
    TRACK.set(true);
    for _ in 0..1100 {
        grid.scroll_up(&(Line(0)..Line(24)), 1);
    }
    TRACK.set(false);
    assert_eq!(ALLOCATIONS.get(), 0);

    let anchor = grid.anchor(Point::new(Line(0), Column(5))).unwrap();
    ALLOCATIONS.set(0);
    TRACK.set(true);
    for line in 1..=1000 {
        grid.scroll_up(&(Line(0)..Line(24)), 1);
        assert_eq!(
            grid.resolve_anchor(&anchor),
            Some(Point::new(Line(-line), Column(5)))
        );
    }
    grid.scroll_up(&(Line(0)..Line(24)), 1);
    assert_eq!(grid.resolve_anchor(&anchor), None);
    TRACK.set(false);
    assert_eq!(ALLOCATIONS.get(), 0);
}

#[test]
fn retirement_queue_reuses_admitted_nodes_and_reports_each_tag_once() {
    use std::num::NonZeroU64;
    let mut grid = Grid::<Cell>::new(2, 80, 0);
    let mut handles = Vec::with_capacity(8192);
    for tag in 1..=8192 {
        handles.push(
            grid.anchor_tagged(
                Point::new(Line(0), Column(0)),
                NonZeroU64::new(tag).unwrap(),
            )
            .unwrap(),
        );
    }
    let mut seen = [false; 8192];
    drop(std::sync::Mutex::new(()).lock().unwrap());
    ALLOCATIONS.set(0);
    TRACK.set(true);
    grid.retire_visible_anchors();
    while let Some(event) = grid.take_anchor_event() {
        let AnchorEvent::Retired(tag) = event else {
            panic!("unexpected {event:?}")
        };
        let entry = &mut seen[tag.get() as usize - 1];
        assert!(!*entry);
        *entry = true;
    }
    assert!(seen.into_iter().all(|seen| seen));
    assert!(handles.iter().all(|handle| handle.is_retired()));
    grid.retire_visible_anchors();
    assert!(grid.take_anchor_event().is_none());
    drop(handles);
    TRACK.set(false);
    assert_eq!(ALLOCATIONS.get(), 0);
}

#[test]
fn retired_queue_destruction_is_iterative_on_a_small_stack() {
    std::thread::Builder::new()
        .stack_size(128 * 1024)
        .spawn(|| {
            let mut grid = Grid::<Cell>::new(2, 80, 0);
            let handle = grid
                .anchor_tagged(
                    Point::new(Line(0), Column(0)),
                    std::num::NonZeroU64::new(8193).unwrap(),
                )
                .unwrap();
            for tag in 1..=8192 {
                grid.anchor_tagged(
                    Point::new(Line(0), Column(0)),
                    std::num::NonZeroU64::new(tag).unwrap(),
                )
                .unwrap();
            }
            grid.retire_visible_anchors();
            assert!(format!("{handle:?}").len() < 1024);
            drop(handle);
            // Notifications deliberately remain pending when the last domain dies.
            drop(grid);
        })
        .unwrap()
        .join()
        .unwrap();
}

#[test]
fn explicit_removal_and_clones_cannot_fabricate_retirement_events() {
    let mut grid = Grid::<Cell>::new(2, 80, 0);
    let tag = std::num::NonZeroU64::new(1).unwrap();
    let handle = grid
        .anchor_tagged(Point::new(Line(0), Column(0)), tag)
        .unwrap();
    let mut copy = grid.clone();
    copy.retire_visible_anchors();
    assert!(copy.take_anchor_event().is_none());
    assert!(!handle.is_retired());
    assert!(grid.remove_anchor(&handle));
    assert!(handle.is_retired());
    assert!(grid.take_anchor_event().is_none());
}

#[test]
fn movement_coalesces_rearms_and_explicit_removal_suppresses_pending_changes() {
    let mut grid = Grid::<Cell>::new(8, 80, 1000);
    let mut handles = Vec::with_capacity(8192);
    for tag in 1..=8192 {
        handles.push(
            grid.anchor_tagged(
                Point::new(Line(2), Column(0)),
                std::num::NonZeroU64::new(tag).unwrap(),
            )
            .unwrap(),
        );
    }
    ALLOCATIONS.set(0);
    TRACK.set(true);
    for _ in 0..2 {
        for _ in 0..32 {
            grid.scroll_down(&(Line(1)..Line(7)), 1);
            grid.scroll_up(&(Line(1)..Line(7)), 1);
        }
        let mut seen = [false; 8192];
        while let Some(event) = grid.take_anchor_event() {
            let AnchorEvent::Changed(tag) = event else {
                panic!("unexpected {event:?}")
            };
            let index = tag.get() as usize - 1;
            assert!(!seen[index]);
            seen[index] = true;
            assert_eq!(grid.resolve_anchor(&handles[index]).unwrap().line, Line(2));
        }
        assert!(seen.into_iter().all(|seen| seen));
    }
    grid.scroll_down(&(Line(1)..Line(7)), 1);
    for handle in &handles {
        assert!(grid.remove_anchor(handle));
    }
    assert_eq!(grid.take_anchor_event(), None);
    TRACK.set(false);
    assert_eq!(ALLOCATIONS.get(), 0);
}

#[test]
fn ring_motion_is_one_remap_event_independent_of_attachment_count() {
    let mut grid = Grid::<Cell>::new(8, 80, 1000);
    for _ in 0..1100 {
        grid.scroll_up(&(Line(0)..Line(8)), 1);
    }
    for tag in 1..=8192 {
        grid.anchor_tagged(
            Point::new(Line(2), Column(0)),
            std::num::NonZeroU64::new(tag).unwrap(),
        )
        .unwrap();
    }
    ALLOCATIONS.set(0);
    TRACK.set(true);
    for _ in 0..32 {
        grid.scroll_up(&(Line(0)..Line(8)), 1);
    }
    assert_eq!(grid.take_anchor_event(), Some(AnchorEvent::Remapped));
    assert_eq!(grid.take_anchor_event(), None);
    TRACK.set(false);
    assert_eq!(ALLOCATIONS.get(), 0);
}

#[test]
fn image_resize_notifies_only_successful_geometry_changes() {
    let mut grid = Grid::<Cell>::new(8, 80, 0);
    let tag = std::num::NonZeroU64::new(1).unwrap();
    let bounds = ImageAnchorBounds {
        left: 0,
        top: 0,
        right: 1 << 32,
        bottom: 2 << 32,
    };
    let handle = grid
        .image_anchor(Point::new(Line(2), Column(0)), tag, bounds)
        .unwrap();
    assert!(grid.resize_image(&handle, bounds));
    assert_eq!(grid.take_anchor_event(), None);
    assert!(!grid.resize_image(
        &handle,
        ImageAnchorBounds {
            bottom: 0,
            ..bounds
        }
    ));
    assert_eq!(grid.take_anchor_event(), None);
    assert!(grid.resize_image(
        &handle,
        ImageAnchorBounds {
            right: 2 << 32,
            ..bounds
        }
    ));
    assert_eq!(grid.take_anchor_event(), Some(AnchorEvent::Changed(tag)));
    assert_eq!(grid.take_anchor_event(), None);
    assert_eq!(grid.resolve_anchor(&handle).unwrap().line, Line(2));
}

#[test]
fn surviving_tail_notifies_when_a_whole_screen_scroll_keeps_the_anchor_fixed() {
    let mut grid = Grid::<Cell>::new(6, 80, 0);
    let tag = std::num::NonZeroU64::new(1).unwrap();
    let handle = grid
        .image_anchor(
            Point::new(Line(0), Column(0)),
            tag,
            ImageAnchorBounds {
                left: 0,
                top: 0,
                right: 1 << 32,
                bottom: 10 << 32,
            },
        )
        .unwrap();
    let before = grid.resolve_anchor(&handle);
    grid.scroll_up(&(Line(0)..Line(6)), 6);
    assert_eq!(grid.resolve_anchor(&handle), before);
    assert_eq!(handle.image_clip().unwrap().top, 6 << 32);
    assert_eq!(grid.take_anchor_event(), Some(AnchorEvent::Changed(tag)));
    assert_eq!(grid.take_anchor_event(), None);
}

#[test]
fn anchors_retire_when_leaving_live_history_even_with_unused_ring_capacity() {
    let mut grid = Grid::<Cell>::new(8, 3, 3);
    let tag = std::num::NonZeroU64::new(1).unwrap();
    let anchor = grid
        .anchor_tagged(Point::new(Line(0), Column(2)), tag)
        .unwrap();
    for line in 1..=3 {
        grid.scroll_up(&(Line(0)..Line(8)), 1);
        assert_eq!(grid.resolve_anchor(&anchor).unwrap().line, Line(-line));
        while let Some(event) = grid.take_anchor_event() {
            assert!(!matches!(event, AnchorEvent::Retired(_)));
        }
    }
    grid.scroll_up(&(Line(0)..Line(8)), 1);
    assert!(anchor.is_retired());
    assert_eq!(grid.resolve_anchor(&anchor), None);
    assert_eq!(grid.take_anchor_event(), Some(AnchorEvent::Remapped));
    assert_eq!(grid.take_anchor_event(), Some(AnchorEvent::Retired(tag)));
    assert_eq!(grid.take_anchor_event(), None);
    grid.update_history(1000);
    for _ in 0..1100 {
        grid.scroll_up(&(Line(0)..Line(8)), 1);
        assert!(anchor.is_retired());
        assert_eq!(grid.resolve_anchor(&anchor), None);
    }
}
