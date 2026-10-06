use merkur_graphics::geometry::{
    CELL_UNIT as U, CellMetrics, CellRect, Geometry, GeometryError, Layer, PIXEL_UNIT,
};
use merkur_graphics::placements::Layout;

fn cell(width: u32, height: u32) -> CellMetrics {
    CellMetrics::new(width * PIXEL_UNIT, height * PIXEL_UNIT).unwrap()
}

#[test]
fn fractional_scissors_preserve_source_edges_and_half_open_intersections() {
    let geometry = Layout {
        columns: 4,
        rows: 4,
        source_x: 3,
        source_y: 7,
        source_width: 40,
        source_height: 40,
        ..Layout::default()
    }
    .geometry(50, 50, cell(10, 10))
    .unwrap()
    .unwrap();
    let unit = i128::from(U);
    let clip = CellRect::fixed(unit / 4, -unit / 2, 3 * unit / 2, 3 * unit / 4).unwrap();
    let above = geometry.project_row_clipped(0, -2, 80, -1, clip).unwrap();
    let below = geometry.project_row_clipped(0, -2, 80, 0, clip).unwrap();
    assert_eq!((above.left, above.right), (U / 4, 3 * U / 2));
    assert_eq!((above.top, above.bottom), (U / 2, U));
    assert_eq!((below.top, below.bottom), (0, 3 * U / 4));
    assert_eq!(
        (above.source_left, above.source_right),
        (11 * U / 2, 18 * U)
    );
    assert_eq!(above.source_top, 22 * U);
    assert_eq!(above.source_bottom, below.source_top);
    assert_eq!(below.source_bottom, 69 * U / 2);
    assert!(geometry.project_row_clipped(0, -2, 80, -2, clip).is_none());
    assert!(geometry.project_row_clipped(0, -2, 80, 1, clip).is_none());
    for column in [-2, -1, 2, i64::MIN, i64::MAX] {
        assert!(!clip.intersects_column(column));
    }
    assert!(clip.intersects_column(0));
    assert!(clip.intersects_column(1));
    assert!(clip.intersects_row(-1));
    assert!(clip.intersects_row(0));
    assert!(!clip.intersects_row(-2));
    assert!(!clip.intersects_row(1));
    assert!(!clip.intersects(CellRect::fixed(3 * unit / 2, -unit, 2 * unit, unit).unwrap()));
    assert!(clip.intersects(CellRect::fixed(3 * unit / 2 - 1, -unit, 2 * unit, unit).unwrap()));
    assert!(CellRect::fixed(0, 0, 0, unit).is_none());
    assert!(CellRect::fixed(0, unit, unit, 0).is_none());
    // Clip arithmetic only compares bounds, so hostile extremes cannot wrap.
    let all = CellRect::fixed(i128::MIN, i128::MIN, i128::MAX, i128::MAX).unwrap();
    assert_eq!(
        geometry.project_row_clipped(0, -2, 80, 0, all),
        geometry.project_row(0, -2, 80, 0),
    );
}

#[test]
fn margin_scissors_preserve_the_original_sampling_transform() {
    let geometry = Layout {
        columns: 4,
        rows: 4,
        source_x: 3,
        source_y: 7,
        source_width: 40,
        source_height: 40,
        ..Layout::default()
    }
    .geometry(50, 50, cell(10, 10))
    .unwrap()
    .unwrap();
    let page = CellRect::new(1, -2, 3, 1).unwrap();
    // The anchor is within the page, but the whole image crosses its right and
    // bottom margins and must not be mistaken for a fully contained placement.
    assert!(!geometry.contained_by(1, -2, page));
    assert!(geometry.contained_by(1, -2, CellRect::new(1, -2, 5, 2).unwrap()));
    let slice = geometry.project_row_clipped(0, -3, 80, -1, page).unwrap();
    assert_eq!(
        (slice.left, slice.right, slice.top, slice.bottom),
        (U, 3 * U, 0, U)
    );
    assert_eq!((slice.source_left, slice.source_right), (13 * U, 33 * U));
    assert_eq!((slice.source_top, slice.source_bottom), (27 * U, 37 * U));
    let before = geometry.project_row_clipped(0, -3, 80, -2, page).unwrap();
    assert_eq!(before.source_bottom, slice.source_top);
    assert!(geometry.project_row_clipped(0, -3, 80, -3, page).is_none());
    assert!(geometry.project_row_clipped(0, -3, 80, 1, page).is_none());
    // A second, narrower scissor derives from the same source transform.
    let narrow = geometry
        .project_row_clipped(0, -3, 80, -1, CellRect::new(2, -2, 3, 0).unwrap())
        .unwrap();
    assert_eq!(narrow.source_left, 23 * U);
    assert_eq!(narrow.source_right, slice.source_right);
    assert_eq!(narrow.source_top, slice.source_top);
    assert_eq!(narrow.source_bottom, slice.source_bottom);
}

#[test]
fn margin_containment_includes_fractional_extents_and_extreme_coordinates_do_not_wrap() {
    let geometry = Layout {
        offset_x: 1,
        offset_y: 1,
        ..Layout::default()
    }
    .geometry(20, 20, cell(10, 10))
    .unwrap()
    .unwrap();
    assert!(!geometry.contained_by(0, 0, CellRect::new(0, 0, 2, 2).unwrap()));
    assert!(geometry.contained_by(0, 0, CellRect::new(0, 0, 3, 3).unwrap()));
    assert!(CellRect::new(0, 0, 0, 1).is_none());
    assert!(CellRect::new(0, 1, 1, 0).is_none());
    let clip = CellRect::new(i64::MIN, i64::MIN, i64::MAX, i64::MAX).unwrap();
    for position in [i64::MIN, i64::MAX] {
        assert!(
            geometry
                .project_row_clipped(position, position, 80, 0, clip)
                .is_none()
        );
    }
    let at_end = geometry.project_row(0, i64::MAX, 80, i64::MAX).unwrap();
    assert_eq!(at_end.top, U / 10);
}

#[test]
fn virtual_placements_center_without_distorting_or_filling_padding_cells() {
    let geometry = Geometry::virtual_placement(20, 10, 4, 4, cell(10, 10)).unwrap();
    assert_eq!(geometry.extent(), (4 * U, 2 * U));
    assert_eq!(geometry.offset(), (0, U));
    assert!(geometry.project_cell(0, 0, 5, 80).is_none());
    let first = geometry.project_cell(0, 1, 5, 80).unwrap();
    assert_eq!(
        (first.left, first.right, first.top, first.bottom),
        (5 * U, 6 * U, 0, U)
    );
    assert_eq!(
        (
            first.source_left,
            first.source_right,
            first.source_top,
            first.source_bottom
        ),
        (0, 5 * U, 0, 5 * U)
    );
    let next = geometry.project_cell(1, 1, 6, 80).unwrap();
    assert_eq!(first.source_right, next.source_left);
    assert!(geometry.project_cell(0, 3, 5, 80).is_none());
    let geometry = Geometry::virtual_placement(10, 20, 4, 4, cell(10, 10)).unwrap();
    assert_eq!(geometry.offset(), (U, 0));
    assert!(geometry.project_cell(0, 0, 5, 80).is_none());
    assert!(geometry.project_cell(1, 0, 80, 80).is_none());
}

#[test]
fn explicit_rectangles_include_offsets_and_source_crops_intersect_without_overflow() {
    let layout = Layout {
        source_x: 7,
        source_y: 3,
        source_width: u32::MAX,
        source_height: u32::MAX,
        columns: 4,
        rows: 3,
        offset_x: 2,
        offset_y: 5,
        ..Layout::default()
    };
    let geometry = layout.geometry(17, 13, cell(8, 10)).unwrap().unwrap();
    assert_eq!(
        (geometry.source().width, geometry.source().height),
        (10, 10)
    );
    assert_eq!((geometry.offset().0, geometry.offset().1), (U / 4, U / 2));
    assert_eq!(
        (geometry.extent().0, geometry.extent().1),
        (4 * U - U / 4, 3 * U - U / 2)
    );
    assert_eq!(geometry.cursor_advance(), Some((4, 3)));
    let last = geometry.project_row(0, 0, 80, 2).unwrap();
    assert_eq!(last.bottom, U);
    assert_eq!(last.source_bottom, 13 * U);
    assert_eq!(last.source_right, 17 * U);
}

#[test]
fn aspect_ratio_uses_actual_fractional_cell_metrics() {
    let metric = CellMetrics::new(15 * PIXEL_UNIT / 2, 15 * PIXEL_UNIT).unwrap();
    let geometry = Layout {
        columns: 4,
        offset_x: 1,
        ..Layout::default()
    }
    .geometry(58, 29, metric)
    .unwrap()
    .unwrap();
    // Width is 29 pixels, height 14.5; rounding occurs once at 32.32 cell precision.
    let ideal_height = u128::from(29 * U) / 30;
    assert!(u128::from(geometry.extent().1).abs_diff(ideal_height) <= 1);
    let native = Layout::default().geometry(15, 30, metric).unwrap().unwrap();
    assert_eq!((native.extent().0, native.extent().1), (2 * U, 2 * U));
}

#[test]
fn clipped_rows_share_source_boundaries_exactly() {
    for height in [1, 7, 19, 16384] {
        let geometry = Layout {
            columns: 11,
            rows: 13,
            offset_x: 1,
            offset_y: 3,
            ..Layout::default()
        }
        .geometry(101, height, cell(7, 19))
        .unwrap()
        .unwrap();
        let mut previous = None;
        for row in -5..8 {
            let slice = geometry.project_row(-3, -5, 6, row).unwrap();
            assert_eq!(slice.left, 0);
            assert_eq!(slice.right, 6 * U);
            if let Some(bottom) = previous {
                assert_eq!(slice.source_top, bottom);
                assert_eq!(slice.top, 0);
            }
            previous = Some(slice.source_bottom);
        }
        assert_eq!(previous, Some(u64::from(height) * U));
        assert!(geometry.project_row(-3, -5, 6, 8).is_none());
    }
}

#[test]
fn hostile_extents_and_far_offscreen_chains_do_not_overflow() {
    let layout = Layout {
        columns: u32::MAX,
        rows: u32::MAX,
        ..Layout::default()
    };
    let geometry = layout.geometry(1, 1, cell(1, 1)).unwrap().unwrap();
    assert!(geometry.project_row(i64::MAX, i64::MIN, 80, 0).is_none());
    assert!(geometry.project_row(i64::MIN, i64::MAX, 80, 0).is_none());
    let slice = geometry.project_row(-1, -1, 80, 0).unwrap();
    assert_eq!(
        (slice.left, slice.right, slice.top, slice.bottom),
        (0, 80 * U, 0, U)
    );
    let too_wide = Layout {
        rows: u32::MAX,
        ..Layout::default()
    };
    assert_eq!(
        too_wide.geometry(16384, 1, cell(1, 65535)),
        Err(GeometryError::UnrepresentableExtent)
    );
    assert_eq!(
        Layout {
            offset_x: 8,
            ..Layout::default()
        }
        .geometry(1, 1, cell(8, 16)),
        Err(GeometryError::InvalidOffset)
    );
    assert_eq!(
        Layout {
            source_x: u32::MAX,
            ..Layout::default()
        }
        .geometry(1, 1, cell(8, 16)),
        Ok(None)
    );
}

#[test]
fn layer_boundaries_match_the_protocol() {
    assert_eq!(Layer::from_z(i32::MIN), Layer::BelowBackground);
    assert_eq!(Layer::from_z(i32::MIN / 2 - 1), Layer::BelowBackground);
    assert_eq!(Layer::from_z(i32::MIN / 2), Layer::BelowText);
    assert_eq!(Layer::from_z(-1), Layer::BelowText);
    assert_eq!(Layer::from_z(0), Layer::AboveText);
}
