//! Tests for the Grid.

use super::*;

use crate::term::cell::Cell;

fn take_retirement(grid: &Grid<Cell>) -> Option<std::num::NonZeroU64> {
    while let Some(event) = grid.take_anchor_event() {
        if let AnchorEvent::Retired(tag) = event {
            return Some(tag);
        }
    }
    None
}

fn image(grid: &mut Grid<Cell>, line: i32, rows: u64, id: u64) -> GridAnchor {
    grid.image_anchor(
        Point::new(Line(line), Column(1)),
        std::num::NonZeroU64::new(id).unwrap(),
        ImageAnchorBounds {
            left: 0,
            top: 0,
            right: 1 << 32,
            bottom: rows << 32,
        },
    )
    .unwrap()
}

#[test]
fn image_tail_survives_top_left_retirement_until_last_pixel_leaves_history() {
    for history in [0, 2, 1001] {
        let mut grid = Grid::<Cell>::new(6, 4, history);
        let image = image(&mut grid, 0, 4, 1);
        for amount in 1..history + 4 {
            grid.scroll_up(&(Line(0)..Line(6)), 1);
            let point = grid.resolve_anchor(&image).unwrap();
            let clip = image.image_clip().unwrap();
            assert_eq!(
                i64::from(point.line.0) - (clip.top >> 32) as i64,
                -(amount as i64)
            );
            assert_eq!(clip.top, (amount.saturating_sub(history) as u64) << 32);
            assert_eq!(take_retirement(&grid), None);
        }
        grid.scroll_up(&(Line(0)..Line(6)), 1);
        assert!(image.is_retired());
        assert_eq!(take_retirement(&grid).unwrap().get(), 1);
        assert_eq!(take_retirement(&grid), None);
    }
}

#[test]
fn image_margin_scroll_clips_permanently_and_leaves_crossing_images_fixed() {
    for history in [0, 8] {
        let mut grid = Grid::<Cell>::new(8, 4, history);
        let clipped = image(&mut grid, 2, 3, 1);
        let crossing_bottom = image(&mut grid, 4, 4, 2);
        let crossing_top = image(&mut grid, 0, 4, 3);
        let outside = image(&mut grid, 7, 1, 4);
        grid.scroll_up(&(Line(1)..Line(6)), 3);
        assert_eq!(grid.resolve_anchor(&clipped).unwrap().line, Line(1));
        assert_eq!(
            clipped.image_clip(),
            Some(ImageAnchorClip {
                top: 2 << 32,
                bottom: 3 << 32
            })
        );
        for (anchor, expected) in [(&crossing_bottom, 4), (&crossing_top, 0), (&outside, 7)] {
            assert_eq!(grid.resolve_anchor(anchor).unwrap().line, Line(expected));
            assert_eq!(anchor.image_clip().unwrap().top, 0);
        }
        // Reverse direction cannot bring the cropped pixels back.
        grid.scroll_down(&(Line(1)..Line(6)), 2);
        assert_eq!(grid.resolve_anchor(&clipped).unwrap().line, Line(3));
        assert_eq!(
            clipped.image_clip(),
            Some(ImageAnchorClip {
                top: 2 << 32,
                bottom: 3 << 32
            })
        );
        grid.scroll_down(&(Line(1)..Line(6)), 3);
        assert!(clipped.is_retired());
    }
}

#[test]
fn bottom_margin_clips_extent_without_changing_sampling_origin() {
    let mut grid = Grid::<Cell>::new(8, 4, 8);
    let anchor = image(&mut grid, 2, 3, 1);
    grid.scroll_down(&(Line(1)..Line(6)), 3);
    assert_eq!(grid.resolve_anchor(&anchor).unwrap().line, Line(5));
    assert_eq!(
        anchor.image_clip(),
        Some(ImageAnchorClip {
            top: 0,
            bottom: 1 << 32
        })
    );
    grid.scroll_up(&(Line(1)..Line(6)), 2);
    assert_eq!(grid.resolve_anchor(&anchor).unwrap().line, Line(3));
    assert_eq!(
        anchor.image_clip(),
        Some(ImageAnchorClip {
            top: 0,
            bottom: 1 << 32
        })
    );
}

#[test]
fn top_aligned_partial_page_scroll_keeps_history_images_fixed() {
    for (history, repeated) in [(2, false), (8, false), (2, true), (8, true)] {
        for amount in [1, 5, usize::MAX] {
            let mut grid = Grid::<Cell>::new(8, 4, history);
            let crossing = image(&mut grid, 0, 5, 1);
            let offscreen = image(&mut grid, 0, 1, 2);
            grid.scroll_up(&(Line(0)..Line(8)), 2);
            let before_crossing = grid.resolve_anchor(&crossing);
            let before_offscreen = grid.resolve_anchor(&offscreen);
            let before_clip = crossing.image_clip();
            let contained = image(&mut grid, 0, 1, 3);
            if repeated {
                grid.scroll_up_repeated(&(Line(0)..Line(5)), amount as u64);
            } else {
                grid.scroll_up(&(Line(0)..Line(5)), amount);
            }
            assert_eq!(grid.resolve_anchor(&crossing), before_crossing);
            assert_eq!(grid.resolve_anchor(&offscreen), before_offscreen);
            assert_eq!(crossing.image_clip(), before_clip);
            assert!(contained.is_retired());
            assert_eq!(take_retirement(&grid).unwrap().get(), 3);
            assert_eq!(take_retirement(&grid), None);
            // Full-screen motion resumes normal history movement and eventual
            // whole-image retirement; retaining a page never resurrects pixels.
            grid.scroll_up(&(Line(0)..Line(8)), 8);
            grid.scroll_up(&(Line(0)..Line(8)), 8);
            assert!(crossing.is_retired());
            assert!(offscreen.is_retired());
        }
    }
}

#[test]
fn clear_screen_includes_images_starting_in_history_but_preserves_offscreen_images() {
    let mut grid = Grid::<Cell>::new(6, 4, 10);
    let visible = image(&mut grid, 0, 4, 1);
    let offscreen = image(&mut grid, 0, 1, 2);
    grid.scroll_up(&(Line(0)..Line(6)), 2);
    grid.retire_visible_anchors();
    assert!(visible.is_retired());
    assert!(!offscreen.is_retired());
    assert_eq!(take_retirement(&grid).unwrap().get(), 1);
    assert_eq!(take_retirement(&grid), None);
}

#[test]
fn clearing_history_preserves_visible_image_tail() {
    let mut grid = Grid::<Cell>::new(6, 4, 10);
    let anchor = image(&mut grid, 0, 4, 1);
    grid.scroll_up(&(Line(0)..Line(6)), 2);
    grid.clear_history();
    assert_eq!(grid.resolve_anchor(&anchor).unwrap().line, Line(0));
    assert_eq!(
        anchor.image_clip(),
        Some(ImageAnchorClip {
            top: 2 << 32,
            bottom: 4 << 32
        })
    );
    assert_eq!(take_retirement(&grid), None);
}

#[test]
fn whole_margin_erasure_keeps_images_that_cross_the_margin() {
    for history in [0, 8] {
        for down in [false, true] {
            let mut grid = Grid::<Cell>::new(8, 4, history);
            let inside = image(&mut grid, 2, 2, 1);
            let crossing = image(&mut grid, 4, 4, 2);
            if down {
                grid.scroll_down(&(Line(1)..Line(6)), usize::MAX);
            } else {
                grid.scroll_up(&(Line(1)..Line(6)), usize::MAX);
            }
            assert!(inside.is_retired());
            assert_eq!(grid.resolve_anchor(&crossing).unwrap().line, Line(4));
        }
    }
}

#[test]
fn image_larger_than_screen_survives_a_whole_screen_scroll() {
    let mut grid = Grid::<Cell>::new(6, 4, 0);
    let anchor = image(&mut grid, 0, 10, 1);
    grid.scroll_up(&(Line(0)..Line(6)), 6);
    assert_eq!(grid.resolve_anchor(&anchor).unwrap().line, Line(0));
    assert_eq!(
        anchor.image_clip(),
        Some(ImageAnchorClip {
            top: 6 << 32,
            bottom: 10 << 32
        })
    );
    grid.scroll_up(&(Line(0)..Line(6)), 4);
    assert!(anchor.is_retired());
}

#[test]
fn repeated_scroll_carries_images_the_whole_distance() {
    for history in [0, 3, 40] {
        for count in [9, 14, 60] {
            let mut grid = Grid::<Cell>::new(6, 4, history);
            grid[Line(0)][Column(0)].c = 'a';
            let tall = image(&mut grid, 0, 70, 1);
            let short = image(&mut grid, 2, 1, 2);
            let moved = grid.scroll_up_repeated(&(Line(0)..Line(6)), count);
            assert_eq!(moved as u64, count.min(6 + history as u64));
            // Rows stop at the history limit; the tall image's tail attaches to
            // the oldest retained row and still samples from `count` lines up.
            let kept = count.min(history as u64);
            assert_eq!(grid.history_size() as u64, kept);
            let line = Line(-(kept as i32));
            assert_eq!(grid.resolve_anchor(&tall).unwrap().line, line);
            let clip = tall.image_clip().unwrap();
            assert_eq!(
                clip,
                ImageAnchorClip {
                    top: (count - kept) << 32,
                    bottom: 70 << 32
                }
            );
            if count < history as u64 + 3 {
                let line = Line(2 - count as i32);
                assert_eq!(grid.resolve_anchor(&short).unwrap().line, line);
            } else {
                assert!(short.is_retired());
            }
            for line in -(kept as i32)..6 {
                let text = if i64::from(line) == -(count as i64) {
                    'a'
                } else {
                    ' '
                };
                assert_eq!(grid[Line(line)][Column(0)].c, text);
            }
        }
    }
    // Counts past 32 bits keep the exact sampling origin of a surviving tail.
    let mut grid = Grid::<Cell>::new(6, 4, 3);
    let tall = image(&mut grid, 0, u64::from(u32::MAX), 1);
    let count = u64::from(u32::MAX) - 2;
    assert_eq!(grid.scroll_up_repeated(&(Line(0)..Line(6)), count), 9);
    assert_eq!(grid.resolve_anchor(&tall).unwrap().line, Line(-3));
    assert_eq!(tall.image_clip().unwrap().top, (count - 3) << 32);
    grid.scroll_up_repeated(&(Line(0)..Line(6)), 6);
    assert!(tall.is_retired());
    // No image outlasts the largest count.
    let tall = image(&mut grid, 0, u64::from(u32::MAX), 1);
    assert_eq!(grid.scroll_up_repeated(&(Line(0)..Line(6)), u64::MAX), 9);
    assert!(tall.is_retired());
}

#[test]
fn repeated_top_aligned_scroll_adds_blank_history_after_its_lines() {
    for history in [2, 5, 20] {
        for count in [3, 7, 40] {
            let mut grid = Grid::<Cell>::new(6, 4, history);
            for line in 0..6 {
                grid[Line(line)][Column(0)].c = char::from(b'a' + line as u8);
            }
            let crossing = image(&mut grid, 1, 4, 1);
            let below = image(&mut grid, 4, 1, 2);
            let moved = grid.scroll_up_repeated(&(Line(0)..Line(3)), count);
            assert_eq!(moved as u64, count.min(3 + history as u64));
            assert_eq!(grid.history_size() as u64, count.min(history as u64));
            // History ends with the region's lines and then one blank line per
            // further line; the region is blank and the lines below it stay.
            for line in -(grid.history_size() as i32)..6 {
                let pushed = count as i64 + i64::from(line);
                let text = match line {
                    3.. => char::from(b'a' + line as u8),
                    0.. => ' ',
                    _ if pushed < 3 => char::from(b'a' + pushed as u8),
                    _ => ' ',
                };
                assert_eq!(grid[Line(line)][Column(0)].c, text);
            }
            // Images crossing the region's bottom or below it stay in place.
            assert_eq!(grid.resolve_anchor(&crossing).unwrap().line, Line(1));
            assert_eq!(grid.resolve_anchor(&below).unwrap().line, Line(4));
        }
    }
}

#[test]
fn fractional_source_crop_survives_metric_roundtrips_without_drift() {
    let mut grid = Grid::<Cell>::new(8, 4, 0);
    let bounds = ImageAnchorBounds {
        left: 0,
        right: 1 << 32,
        top: 1 << 30,
        bottom: (3 << 32) + (1 << 30),
    };
    let anchor = grid
        .image_anchor(
            Point::new(Line(1), Column(1)),
            std::num::NonZeroU64::new(1).unwrap(),
            bounds,
        )
        .unwrap();
    grid.scroll_up(&(Line(1)..Line(6)), 1);
    let clipped = anchor.image_clip().unwrap();
    assert_eq!(clipped.top, 1 << 32);
    assert_eq!(clipped.bottom, bounds.bottom);
    let smaller = ImageAnchorBounds {
        top: 1 << 29,
        bottom: (1 << 32) + 97,
        ..bounds
    };
    let mut copy = grid.clone();
    assert!(!copy.resize_image(&anchor, smaller));
    for _ in 0..1000 {
        assert!(grid.resize_image(&anchor, smaller));
        let small_clip = anchor.image_clip().unwrap();
        // Inward rounding cannot expose a previously discarded source sample.
        assert!(
            u128::from(small_clip.top - smaller.top) * u128::from(bounds.bottom - bounds.top)
                >= u128::from(clipped.top - bounds.top) * u128::from(smaller.bottom - smaller.top)
        );
        assert!(grid.resize_image(&anchor, bounds));
        assert_eq!(anchor.image_clip(), Some(clipped));
    }
}

#[test]
fn anchors_follow_ring_rotation_and_retire_before_cached_row_reuse() {
    let mut grid = Grid::<Cell>::new(3, 5, 2);
    let point = Point::new(Line(0), Column(3));
    let anchor = grid.anchor(point).unwrap();
    grid.scroll_up(&(Line(0)..Line(3)), 1);
    assert_eq!(
        grid.resolve_anchor(&anchor),
        Some(Point::new(Line(-1), Column(3)))
    );
    grid.scroll_up(&(Line(0)..Line(3)), 1);
    assert_eq!(
        grid.resolve_anchor(&anchor),
        Some(Point::new(Line(-2), Column(3)))
    );
    grid.update_history(1);
    assert_eq!(grid.resolve_anchor(&anchor), None);
    grid.update_history(100);
    for _ in 0..1100 {
        grid.scroll_up(&(Line(0)..Line(3)), 1);
    }
    assert_eq!(grid.resolve_anchor(&anchor), None);
}

#[test]
fn anchors_follow_margins_in_both_storage_modes() {
    for history in [0, 8] {
        for down in [false, true] {
            let mut grid = Grid::<Cell>::new(6, 3, history);
            let anchors: Vec<_> = (0..6)
                .map(|line| grid.anchor(Point::new(Line(line), Column(1))).unwrap())
                .collect();
            if down {
                grid.scroll_down(&(Line(1)..Line(5)), 2);
            } else {
                grid.scroll_up(&(Line(1)..Line(5)), 2);
            }
            let expected = if down {
                [Some(0), Some(3), Some(4), None, None, Some(5)]
            } else {
                [Some(0), None, None, Some(1), Some(2), Some(5)]
            };
            for (anchor, line) in anchors.iter().zip(expected) {
                assert_eq!(
                    grid.resolve_anchor(anchor),
                    line.map(|line| Point::new(Line(line), Column(1)))
                );
            }
        }
    }
}

#[test]
fn anchors_preserve_blank_cells_during_reflow() {
    let mut grid = Grid::<Cell>::new(1, 9, 20);
    let anchor = grid.anchor(Point::new(Line(0), Column(7))).unwrap();
    grid.reset_region(..);
    assert_eq!(
        grid.resolve_anchor(&anchor),
        Some(Point::new(Line(0), Column(7)))
    );
    grid.resize(true, 1, 3);
    assert_eq!(
        grid.resolve_anchor(&anchor),
        Some(Point::new(Line(0), Column(1)))
    );
    grid.resize(true, 1, 9);
    // The terminal preserves a blank cursor row below the merged content.
    assert_eq!(
        grid.resolve_anchor(&anchor),
        Some(Point::new(Line(-1), Column(7)))
    );
    grid.reset();
    assert_eq!(grid.resolve_anchor(&anchor), None);
}

#[test]
fn clearing_viewport_retires_attachments_before_text_enters_history() {
    let mut grid = Grid::<Cell>::new(3, 5, 10);
    grid[Line(0)][Column(0)] = cell('x');
    let text = grid.anchor(Point::new(Line(0), Column(0))).unwrap();
    let blank = grid.anchor(Point::new(Line(2), Column(4))).unwrap();
    grid.clear_viewport();
    assert_eq!(grid.resolve_anchor(&text), None);
    assert_eq!(grid.resolve_anchor(&blank), None);
}

#[test]
fn anchors_track_each_cell_through_repeated_reflow() {
    let mut grid = Grid::<Cell>::new(4, 9, 100);
    let mut anchors = Vec::new();
    for line in 0..4 {
        for column in 0..9 {
            let point = Point::new(Line(line), Column(column));
            let c = char::from_u32(0x100 + line as u32 * 9 + column as u32).unwrap();
            grid[point] = cell(c);
            anchors.push((grid.anchor(point).unwrap(), c));
        }
        if line < 3 {
            grid[Line(line)][Column(8)].flags.insert(Flags::WRAPLINE);
        }
    }
    for columns in [3, 7, 2, 13, 4, 9, 1, 36, 9] {
        grid.resize(true, 4, columns);
        for (anchor, c) in &anchors {
            let point = grid
                .resolve_anchor(anchor)
                .expect("reflow retains every attached cell");
            assert_eq!(grid[point].c, *c, "width {columns}, anchor {point:?}");
        }
    }
}

#[test]
fn anchors_follow_wide_characters_across_inserted_spacers() {
    let mut grid = Grid::<Cell>::new(2, 4, 10);
    grid[Line(0)][Column(0)] = cell('a');
    grid[Line(0)][Column(1)] = cell('界');
    grid[Line(0)][Column(1)].flags.insert(Flags::WIDE_CHAR);
    grid[Line(0)][Column(2)]
        .flags
        .insert(Flags::WIDE_CHAR_SPACER);
    let anchor = grid.anchor(Point::new(Line(0), Column(1))).unwrap();
    for columns in [2, 4, 3, 2, 8] {
        grid.resize(true, 2, columns);
        let point = grid.resolve_anchor(&anchor).unwrap();
        assert_eq!(grid[point].c, '界', "width {columns}, anchor {point:?}");
    }
}

#[test]
fn anchors_on_removed_wide_spacers_follow_their_character() {
    for initial_width in [3, 4] {
        let mut grid = Grid::<Cell>::new(2, initial_width, 10);
        for column in 0..initial_width - 1 {
            grid[Line(0)][Column(column)] = cell('a');
        }
        grid[Line(0)][Column(initial_width - 1)].flags =
            Flags::LEADING_WIDE_CHAR_SPACER | Flags::WRAPLINE;
        grid[Line(1)][Column(0)] = cell('界');
        grid[Line(1)][Column(0)].flags.insert(Flags::WIDE_CHAR);
        grid[Line(1)][Column(1)]
            .flags
            .insert(Flags::WIDE_CHAR_SPACER);
        let anchor = grid
            .anchor(Point::new(Line(0), Column(initial_width - 1)))
            .unwrap();
        for width in [2, 5, 3, 7] {
            grid.resize(true, 2, width);
            let point = grid.resolve_anchor(&anchor).unwrap();
            assert_eq!(
                grid[point].c, '界',
                "initial width {initial_width}, width {width}"
            );
        }
    }
}

#[test]
fn anchor_authority_is_not_copied_or_reused() {
    let mut grid = Grid::<Cell>::new(2, 5, 10);
    let anchor = grid.anchor(Point::new(Line(0), Column(4))).unwrap();
    let mut other = grid.clone();
    assert_eq!(other.resolve_anchor(&anchor), None);
    assert!(!other.remove_anchor(&anchor));
    other.reset();
    assert!(grid.resolve_anchor(&anchor).is_some());
    let cloned = anchor.clone();
    assert!(grid.remove_anchor(&anchor));
    assert_eq!(grid.resolve_anchor(&cloned), None);
    assert!(!grid.remove_anchor(&anchor));
    let replacement = grid.anchor(Point::new(Line(0), Column(4))).unwrap();
    assert_eq!(grid.resolve_anchor(&anchor), None);
    grid.resize(false, 2, 3);
    assert_eq!(grid.resolve_anchor(&replacement), None);
    assert!(grid.anchor(Point::new(Line(-1), Column(0))).is_none());
    assert!(grid.anchor(Point::new(Line(2), Column(0))).is_none());
    assert!(grid.anchor(Point::new(Line(0), Column(3))).is_none());
}

#[test]
fn anchor_positions_match_cell_identity_under_terminal_operation_traces() {
    use std::collections::BTreeMap;

    for seed in [1_u32, 17, 0xfedc_ba98] {
        let mut random = seed;
        let mut next = || {
            random ^= random << 13;
            random ^= random >> 17;
            random ^= random << 5;
            random as usize
        };
        let mut grid = Grid::<Cell>::new(5, 11, 12);
        let mut attachments = Vec::new();
        let mut identity = 0x1000;
        for step in 0..500 {
            // Attach to blank cells only: terminal writes do not move attachments.
            let point = Point::new(
                Line((next() % grid.lines) as i32),
                Column(next() % grid.columns),
            );
            if grid[point].c == ' ' {
                let character = char::from_u32(identity).unwrap();
                identity += 1;
                grid[point] = cell(character);
                let tag = std::num::NonZeroU64::new(u64::from(character as u32)).unwrap();
                attachments.push((grid.anchor_tagged(point, tag).unwrap(), character));
            }
            let before: Vec<_> = attachments
                .iter()
                .map(|(anchor, _)| grid.resolve_anchor(anchor))
                .collect();
            let operation = next() % 7;
            let dimensions_before = (grid.lines, grid.columns, grid.history_size());
            match operation {
                0 => grid.scroll_up(&(Line(0)..Line(grid.lines as i32)), 1),
                1 => grid.scroll_down(&(Line(0)..Line(grid.lines as i32)), 1),
                2 if grid.lines > 2 => grid.scroll_up(&(Line(1)..Line(grid.lines as i32 - 1)), 1),
                3 if grid.lines > 2 => grid.scroll_down(&(Line(1)..Line(grid.lines as i32 - 1)), 1),
                4 => grid.resize(true, 1 + next() % 9, 2 + next() % 19),
                5 => grid.update_history(next() % 20),
                _ => grid.resize(false, 1 + next() % 9, 2 + next() % 19),
            }
            let mut positions = BTreeMap::new();
            for line in grid.topmost_line().0..grid.lines as i32 {
                for column in 0..grid.columns {
                    let point = Point::new(Line(line), Column(column));
                    if grid[point].c != ' ' {
                        positions.insert(grid[point].c, point);
                    }
                }
            }
            let mut remapped = false;
            let mut events = BTreeMap::new();
            while let Some(event) = grid.take_anchor_event() {
                let tag = match event {
                    AnchorEvent::Remapped => {
                        assert!(!remapped);
                        remapped = true;
                        continue;
                    }
                    AnchorEvent::Changed(tag) | AnchorEvent::Retired(tag) => tag,
                };
                assert!(events.insert(tag.get(), event).is_none());
            }
            for ((anchor, character), before) in attachments.iter().zip(before) {
                let after = grid.resolve_anchor(anchor);
                let tag = std::num::NonZeroU64::new(u64::from(*character as u32)).unwrap();
                if before.is_some() && after.is_none() {
                    assert_eq!(
                        events.get(&tag.get()),
                        Some(&AnchorEvent::Retired(tag)),
                        "seed {seed} step {step} op {operation} dimensions {dimensions_before:?} -> {:?} before {before:?} retired {} events {events:?}",
                        (grid.lines, grid.columns, grid.history_size()),
                        anchor.is_retired()
                    );
                } else if before != after && !remapped {
                    assert_eq!(events.get(&tag.get()), Some(&AnchorEvent::Changed(tag)));
                }
                assert_eq!(
                    after,
                    positions.get(character).copied(),
                    "seed {seed}, step {step}, character {character:?}"
                );
            }
        }
    }
}

impl GridCell for usize {
    fn is_empty(&self) -> bool {
        *self == 0
    }

    fn reset(&mut self, template: &Self) {
        *self = *template;
    }

    fn flags(&self) -> &Flags {
        unimplemented!();
    }

    fn flags_mut(&mut self) -> &mut Flags {
        unimplemented!();
    }
}

// Scroll up moves lines upward.
#[test]
fn scroll_up() {
    let mut grid = Grid::<usize>::new(10, 1, 0);
    for i in 0..10 {
        grid[Line(i as i32)][Column(0)] = i;
    }

    grid.scroll_up::<usize>(&(Line(0)..Line(10)), 2);

    assert_eq!(grid[Line(0)][Column(0)], 2);
    assert_eq!(grid[Line(0)].occ, 1);
    assert_eq!(grid[Line(1)][Column(0)], 3);
    assert_eq!(grid[Line(1)].occ, 1);
    assert_eq!(grid[Line(2)][Column(0)], 4);
    assert_eq!(grid[Line(2)].occ, 1);
    assert_eq!(grid[Line(3)][Column(0)], 5);
    assert_eq!(grid[Line(3)].occ, 1);
    assert_eq!(grid[Line(4)][Column(0)], 6);
    assert_eq!(grid[Line(4)].occ, 1);
    assert_eq!(grid[Line(5)][Column(0)], 7);
    assert_eq!(grid[Line(5)].occ, 1);
    assert_eq!(grid[Line(6)][Column(0)], 8);
    assert_eq!(grid[Line(6)].occ, 1);
    assert_eq!(grid[Line(7)][Column(0)], 9);
    assert_eq!(grid[Line(7)].occ, 1);
    assert_eq!(grid[Line(8)][Column(0)], 0); // was 0.
    assert_eq!(grid[Line(8)].occ, 0);
    assert_eq!(grid[Line(9)][Column(0)], 0); // was 1.
    assert_eq!(grid[Line(9)].occ, 0);
}

// Merkur: every whole-screen scroll counts, however far past history; a
// subregion scroll moves only some rows and does not.
#[test]
fn screen_scrolls_count_whole_screen_scrolls_only() {
    let mut grid = Grid::<usize>::new(10, 1, 3);
    grid.scroll_up::<usize>(&(Line(0)..Line(10)), 2);
    assert_eq!(grid.screen_scrolls(), 2);
    grid.scroll_up::<usize>(&(Line(2)..Line(10)), 4);
    grid.scroll_up::<usize>(&(Line(0)..Line(8)), 1);
    assert_eq!(grid.screen_scrolls(), 2);
    assert_eq!(grid.scroll_up_repeated::<usize>(&(Line(0)..Line(10)), 1_000), 13);
    assert_eq!(grid.screen_scrolls(), 1_002);
}

// Scroll down moves lines downward.
#[test]
fn scroll_down() {
    let mut grid = Grid::<usize>::new(10, 1, 0);
    for i in 0..10 {
        grid[Line(i as i32)][Column(0)] = i;
    }

    grid.scroll_down::<usize>(&(Line(0)..Line(10)), 2);

    assert_eq!(grid[Line(0)][Column(0)], 0); // was 8.
    assert_eq!(grid[Line(0)].occ, 0);
    assert_eq!(grid[Line(1)][Column(0)], 0); // was 9.
    assert_eq!(grid[Line(1)].occ, 0);
    assert_eq!(grid[Line(2)][Column(0)], 0);
    assert_eq!(grid[Line(2)].occ, 1);
    assert_eq!(grid[Line(3)][Column(0)], 1);
    assert_eq!(grid[Line(3)].occ, 1);
    assert_eq!(grid[Line(4)][Column(0)], 2);
    assert_eq!(grid[Line(4)].occ, 1);
    assert_eq!(grid[Line(5)][Column(0)], 3);
    assert_eq!(grid[Line(5)].occ, 1);
    assert_eq!(grid[Line(6)][Column(0)], 4);
    assert_eq!(grid[Line(6)].occ, 1);
    assert_eq!(grid[Line(7)][Column(0)], 5);
    assert_eq!(grid[Line(7)].occ, 1);
    assert_eq!(grid[Line(8)][Column(0)], 6);
    assert_eq!(grid[Line(8)].occ, 1);
    assert_eq!(grid[Line(9)][Column(0)], 7);
    assert_eq!(grid[Line(9)].occ, 1);
}

#[test]
fn scroll_down_with_history() {
    let mut grid = Grid::<usize>::new(10, 1, 1);
    grid.increase_scroll_limit(1);
    for i in 0..10 {
        grid[Line(i as i32)][Column(0)] = i;
    }

    grid.scroll_down::<usize>(&(Line(0)..Line(10)), 2);

    assert_eq!(grid[Line(0)][Column(0)], 0); // was 8.
    assert_eq!(grid[Line(0)].occ, 0);
    assert_eq!(grid[Line(1)][Column(0)], 0); // was 9.
    assert_eq!(grid[Line(1)].occ, 0);
    assert_eq!(grid[Line(2)][Column(0)], 0);
    assert_eq!(grid[Line(2)].occ, 1);
    assert_eq!(grid[Line(3)][Column(0)], 1);
    assert_eq!(grid[Line(3)].occ, 1);
    assert_eq!(grid[Line(4)][Column(0)], 2);
    assert_eq!(grid[Line(4)].occ, 1);
    assert_eq!(grid[Line(5)][Column(0)], 3);
    assert_eq!(grid[Line(5)].occ, 1);
    assert_eq!(grid[Line(6)][Column(0)], 4);
    assert_eq!(grid[Line(6)].occ, 1);
    assert_eq!(grid[Line(7)][Column(0)], 5);
    assert_eq!(grid[Line(7)].occ, 1);
    assert_eq!(grid[Line(8)][Column(0)], 6);
    assert_eq!(grid[Line(8)].occ, 1);
    assert_eq!(grid[Line(9)][Column(0)], 7);
    assert_eq!(grid[Line(9)].occ, 1);
}

// Test that GridIterator works.
#[test]
fn test_iter() {
    let assert_indexed = |value: usize, indexed: Option<Indexed<&usize>>| {
        assert_eq!(Some(&value), indexed.map(|indexed| indexed.cell));
    };

    let mut grid = Grid::<usize>::new(5, 5, 0);
    for i in 0..5 {
        for j in 0..5 {
            grid[Line(i)][Column(j)] = i as usize * 5 + j;
        }
    }

    let mut iter = grid.iter_from(Point::new(Line(0), Column(0)));

    assert_eq!(None, iter.prev());
    assert_indexed(1, iter.next());
    assert_eq!(Column(1), iter.point().column);
    assert_eq!(0, iter.point().line);

    assert_indexed(2, iter.next());
    assert_indexed(3, iter.next());
    assert_indexed(4, iter.next());

    // Test line-wrapping.
    assert_indexed(5, iter.next());
    assert_eq!(Column(0), iter.point().column);
    assert_eq!(1, iter.point().line);

    assert_indexed(4, iter.prev());
    assert_eq!(Column(4), iter.point().column);
    assert_eq!(0, iter.point().line);

    // Make sure iter.cell() returns the current iterator position.
    assert_eq!(&4, iter.cell());

    // Test that iter ends at end of grid.
    let mut final_iter = grid.iter_from(Point {
        line: Line(4),
        column: Column(4),
    });
    assert_eq!(None, final_iter.next());
    assert_indexed(23, final_iter.prev());
}

#[test]
fn shrink_reflow() {
    let mut grid = Grid::<Cell>::new(1, 5, 2);
    grid[Line(0)][Column(0)] = cell('1');
    grid[Line(0)][Column(1)] = cell('2');
    grid[Line(0)][Column(2)] = cell('3');
    grid[Line(0)][Column(3)] = cell('4');
    grid[Line(0)][Column(4)] = cell('5');

    grid.resize(true, 1, 2);

    assert_eq!(grid.total_lines(), 3);

    assert_eq!(grid[Line(-2)].len(), 2);
    assert_eq!(grid[Line(-2)][Column(0)], cell('1'));
    assert_eq!(grid[Line(-2)][Column(1)], wrap_cell('2'));

    assert_eq!(grid[Line(-1)].len(), 2);
    assert_eq!(grid[Line(-1)][Column(0)], cell('3'));
    assert_eq!(grid[Line(-1)][Column(1)], wrap_cell('4'));

    assert_eq!(grid[Line(0)].len(), 2);
    assert_eq!(grid[Line(0)][Column(0)], cell('5'));
    assert_eq!(grid[Line(0)][Column(1)], Cell::default());
}

#[test]
fn shrink_reflow_twice() {
    let mut grid = Grid::<Cell>::new(1, 5, 2);
    grid[Line(0)][Column(0)] = cell('1');
    grid[Line(0)][Column(1)] = cell('2');
    grid[Line(0)][Column(2)] = cell('3');
    grid[Line(0)][Column(3)] = cell('4');
    grid[Line(0)][Column(4)] = cell('5');

    grid.resize(true, 1, 4);
    grid.resize(true, 1, 2);

    assert_eq!(grid.total_lines(), 3);

    assert_eq!(grid[Line(-2)].len(), 2);
    assert_eq!(grid[Line(-2)][Column(0)], cell('1'));
    assert_eq!(grid[Line(-2)][Column(1)], wrap_cell('2'));

    assert_eq!(grid[Line(-1)].len(), 2);
    assert_eq!(grid[Line(-1)][Column(0)], cell('3'));
    assert_eq!(grid[Line(-1)][Column(1)], wrap_cell('4'));

    assert_eq!(grid[Line(0)].len(), 2);
    assert_eq!(grid[Line(0)][Column(0)], cell('5'));
    assert_eq!(grid[Line(0)][Column(1)], Cell::default());
}

#[test]
fn shrink_reflow_empty_cell_inside_line() {
    let mut grid = Grid::<Cell>::new(1, 5, 3);
    grid[Line(0)][Column(0)] = cell('1');
    grid[Line(0)][Column(1)] = Cell::default();
    grid[Line(0)][Column(2)] = cell('3');
    grid[Line(0)][Column(3)] = cell('4');
    grid[Line(0)][Column(4)] = Cell::default();

    grid.resize(true, 1, 2);

    assert_eq!(grid.total_lines(), 2);

    assert_eq!(grid[Line(-1)].len(), 2);
    assert_eq!(grid[Line(-1)][Column(0)], cell('1'));
    assert_eq!(grid[Line(-1)][Column(1)], wrap_cell(' '));

    assert_eq!(grid[Line(0)].len(), 2);
    assert_eq!(grid[Line(0)][Column(0)], cell('3'));
    assert_eq!(grid[Line(0)][Column(1)], cell('4'));

    grid.resize(true, 1, 1);

    assert_eq!(grid.total_lines(), 4);

    assert_eq!(grid[Line(-3)].len(), 1);
    assert_eq!(grid[Line(-3)][Column(0)], wrap_cell('1'));

    assert_eq!(grid[Line(-2)].len(), 1);
    assert_eq!(grid[Line(-2)][Column(0)], wrap_cell(' '));

    assert_eq!(grid[Line(-1)].len(), 1);
    assert_eq!(grid[Line(-1)][Column(0)], wrap_cell('3'));

    assert_eq!(grid[Line(0)].len(), 1);
    assert_eq!(grid[Line(0)][Column(0)], cell('4'));
}

#[test]
fn grow_reflow() {
    let mut grid = Grid::<Cell>::new(2, 2, 0);
    grid[Line(0)][Column(0)] = cell('1');
    grid[Line(0)][Column(1)] = wrap_cell('2');
    grid[Line(1)][Column(0)] = cell('3');
    grid[Line(1)][Column(1)] = Cell::default();

    grid.resize(true, 2, 3);

    assert_eq!(grid.total_lines(), 2);

    assert_eq!(grid[Line(0)].len(), 3);
    assert_eq!(grid[Line(0)][Column(0)], cell('1'));
    assert_eq!(grid[Line(0)][Column(1)], cell('2'));
    assert_eq!(grid[Line(0)][Column(2)], cell('3'));

    // Make sure rest of grid is empty.
    assert_eq!(grid[Line(1)].len(), 3);
    assert_eq!(grid[Line(1)][Column(0)], Cell::default());
    assert_eq!(grid[Line(1)][Column(1)], Cell::default());
    assert_eq!(grid[Line(1)][Column(2)], Cell::default());
}

#[test]
fn grow_reflow_multiline() {
    let mut grid = Grid::<Cell>::new(3, 2, 0);
    grid[Line(0)][Column(0)] = cell('1');
    grid[Line(0)][Column(1)] = wrap_cell('2');
    grid[Line(1)][Column(0)] = cell('3');
    grid[Line(1)][Column(1)] = wrap_cell('4');
    grid[Line(2)][Column(0)] = cell('5');
    grid[Line(2)][Column(1)] = cell('6');

    grid.resize(true, 3, 6);

    assert_eq!(grid.total_lines(), 3);

    assert_eq!(grid[Line(0)].len(), 6);
    assert_eq!(grid[Line(0)][Column(0)], cell('1'));
    assert_eq!(grid[Line(0)][Column(1)], cell('2'));
    assert_eq!(grid[Line(0)][Column(2)], cell('3'));
    assert_eq!(grid[Line(0)][Column(3)], cell('4'));
    assert_eq!(grid[Line(0)][Column(4)], cell('5'));
    assert_eq!(grid[Line(0)][Column(5)], cell('6'));

    // Make sure rest of grid is empty.
    for r in (1..3).map(Line::from) {
        assert_eq!(grid[r].len(), 6);
        for c in 0..6 {
            assert_eq!(grid[r][Column(c)], Cell::default());
        }
    }
}

#[test]
fn grow_reflow_disabled() {
    let mut grid = Grid::<Cell>::new(2, 2, 0);
    grid[Line(0)][Column(0)] = cell('1');
    grid[Line(0)][Column(1)] = wrap_cell('2');
    grid[Line(1)][Column(0)] = cell('3');
    grid[Line(1)][Column(1)] = Cell::default();

    grid.resize(false, 2, 3);

    assert_eq!(grid.total_lines(), 2);

    assert_eq!(grid[Line(0)].len(), 3);
    assert_eq!(grid[Line(0)][Column(0)], cell('1'));
    assert_eq!(grid[Line(0)][Column(1)], wrap_cell('2'));
    assert_eq!(grid[Line(0)][Column(2)], Cell::default());

    assert_eq!(grid[Line(1)].len(), 3);
    assert_eq!(grid[Line(1)][Column(0)], cell('3'));
    assert_eq!(grid[Line(1)][Column(1)], Cell::default());
    assert_eq!(grid[Line(1)][Column(2)], Cell::default());
}

#[test]
fn shrink_reflow_disabled() {
    let mut grid = Grid::<Cell>::new(1, 5, 2);
    grid[Line(0)][Column(0)] = cell('1');
    grid[Line(0)][Column(1)] = cell('2');
    grid[Line(0)][Column(2)] = cell('3');
    grid[Line(0)][Column(3)] = cell('4');
    grid[Line(0)][Column(4)] = cell('5');

    grid.resize(false, 1, 2);

    assert_eq!(grid.total_lines(), 1);

    assert_eq!(grid[Line(0)].len(), 2);
    assert_eq!(grid[Line(0)][Column(0)], cell('1'));
    assert_eq!(grid[Line(0)][Column(1)], cell('2'));
}

#[test]
fn accurate_size_hint() {
    let grid = Grid::<Cell>::new(5, 5, 2);

    size_hint_matches_count(grid.iter_from(Point::new(Line(0), Column(0))));
    size_hint_matches_count(grid.iter_from(Point::new(Line(2), Column(3))));
    size_hint_matches_count(grid.iter_from(Point::new(Line(4), Column(4))));
    size_hint_matches_count(grid.iter_from(Point::new(Line(4), Column(2))));
    size_hint_matches_count(grid.iter_from(Point::new(Line(10), Column(10))));
    size_hint_matches_count(grid.iter_from(Point::new(Line(2), Column(10))));

    let mut iterator = grid.iter_from(Point::new(Line(3), Column(1)));
    iterator.next();
    iterator.next();
    size_hint_matches_count(iterator);

    size_hint_matches_count(grid.display_iter());
}

fn size_hint_matches_count<T>(iter: impl Iterator<Item = T>) {
    let iterator = iter.into_iter();
    let (lower, upper) = iterator.size_hint();
    let count = iterator.count();
    assert_eq!(lower, count);
    assert_eq!(upper, Some(count));
}

// https://github.com/rust-lang/rust-clippy/pull/6375
#[allow(clippy::all)]
fn cell(c: char) -> Cell {
    let mut cell = Cell::default();
    cell.c = c;
    cell
}

fn wrap_cell(c: char) -> Cell {
    let mut cell = cell(c);
    cell.flags.insert(Flags::WRAPLINE);
    cell
}
