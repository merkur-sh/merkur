use merkur_graphics::budget::{Aggregate, Budget, Usage};
use merkur_graphics::geometry::{
    CELL_UNIT as U, CellMetrics, CellRect, Layer, PIXEL_UNIT, RowSlice,
};
use merkur_graphics::placements::{Layout, Position};
use merkur_graphics::projection::{
    Content, FRAGMENT_BYTES, Fragment, MAX_ROW_FRAGMENTS, PlacementProjection, ProjectionError,
    RowFragments, Stack, retained_usage, validate_row,
};
use proptest::prelude::*;

fn fragment() -> Fragment {
    Fragment {
        content: Content {
            kind: merkur_graphics::projection::ContentKind::Image,
            root: [7; 32],
            width: 100,
            height: 200,
        },
        stack: Stack {
            z: 0,
            image_id: 42,
            placement: 1,
        },
        slice: RowSlice {
            left: U / 2,
            right: 5 * U / 2,
            top: U / 4,
            bottom: 3 * U / 4,
            source_left: 10 * U,
            source_right: 90 * U,
            source_top: 50 * U,
            source_bottom: 150 * U,
        },
    }
}

#[test]
fn canonical_descriptor_vector_has_no_padding_or_host_endian_fields() {
    let f = Fragment {
        content: Content {
            kind: merkur_graphics::projection::ContentKind::Image,
            root: std::array::from_fn(|i| i as u8),
            width: 321,
            height: 123,
        },
        stack: Stack {
            z: -1_073_741_825,
            image_id: 0x12345678,
            placement: 0x0102030405060708,
        },
        slice: RowSlice {
            left: 1,
            right: 2,
            top: 3,
            bottom: 4,
            source_left: 5,
            source_right: 6,
            source_top: 7,
            source_bottom: 8,
        },
    };
    let expected = concat!(
        "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
        "000001410000007bbfffffff123456780102030405060708",
        "0000000000000001000000000000000200000000000000030000000000000004",
        "0000000000000005000000000000000600000000000000070000000000000008",
    );
    let encoded = f.encode();
    assert_eq!(encoded.len(), FRAGMENT_BYTES);
    assert_eq!(
        encoded
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>(),
        expected
    );
    assert_eq!(Fragment::decode(&encoded, 1), Some(f));
    // No wire byte is ignored: every accepted mutation has distinct authority.
    for i in 0..FRAGMENT_BYTES {
        let mut changed = encoded;
        changed[i] ^= 1;
        if let Some(decoded) = Fragment::decode(&changed, 1) {
            assert_ne!(decoded, f);
            assert_eq!(decoded.encode(), changed);
        }
    }
}

#[test]
fn invalid_geometry_never_allocates_or_replaces_a_retained_row() {
    let budget = Budget::new(Usage {
        bytes: 1 << 20,
        objects: 20,
    });
    let f = fragment();
    let mut row = RowFragments::default();
    row.replace(&budget, 80, &[f]).unwrap();
    let before = budget.used();
    let mut bad = vec![];
    let mut b = f;
    b.content.width = 0;
    bad.push(b);
    b = f;
    b.content.width = u32::MAX;
    bad.push(b);
    b = f;
    b.content.width = 16384;
    b.content.height = 16384;
    bad.push(b);
    b = f;
    b.stack.placement = 0;
    bad.push(b);
    b = f;
    b.slice.right = 80 * U + 1;
    bad.push(b);
    b = f;
    b.slice.left = b.slice.right;
    bad.push(b);
    b = f;
    b.slice.bottom = U + 1;
    bad.push(b);
    b = f;
    b.slice.top = b.slice.bottom;
    bad.push(b);
    b = f;
    b.slice.source_left = b.slice.source_right + 1;
    bad.push(b);
    b = f;
    b.slice.source_right = 100 * U + 1;
    bad.push(b);
    b = f;
    b.slice.source_top = b.slice.source_bottom + 1;
    bad.push(b);
    b = f;
    b.slice.source_bottom = 200 * U + 1;
    bad.push(b);
    for b in bad {
        assert_eq!(
            row.replace(&budget, 80, &[b]),
            Err(ProjectionError::InvalidFragment)
        );
        assert_eq!(Fragment::decode(&b.encode(), 80), None);
        assert_eq!(row.as_slice(), &[f]);
        assert_eq!(budget.used(), before);
    }
    assert_eq!(
        row.replace(&budget, 2, &[f]),
        Err(ProjectionError::InvalidFragment)
    );
}

#[test]
fn canonical_stacking_preserves_numeric_order_across_text_strata() {
    let mut fragments: Vec<_> = [0, i32::MIN, i32::MAX, -1, -1_073_741_824, -1_073_741_825]
        .into_iter()
        .flat_map(|z| {
            [99, 1].into_iter().map(move |image_id| {
                let mut f = fragment();
                f.stack.z = z;
                f.stack.image_id = image_id;
                f
            })
        })
        .collect();
    fragments.sort_unstable_by(Fragment::compare);
    validate_row(80, &fragments).unwrap();
    assert_eq!(
        fragments
            .iter()
            .map(|f| f.stack.layer())
            .collect::<Vec<_>>(),
        [
            Layer::BelowBackground,
            Layer::BelowBackground,
            Layer::BelowBackground,
            Layer::BelowBackground,
            Layer::BelowText,
            Layer::BelowText,
            Layer::BelowText,
            Layer::BelowText,
            Layer::AboveText,
            Layer::AboveText,
            Layer::AboveText,
            Layer::AboveText,
        ]
    );
    for pair in fragments.chunks_exact(2) {
        assert_eq!(pair[0].stack.image_id, 1);
        assert_eq!(pair[1].stack.image_id, 99);
    }
    assert_eq!(
        validate_row(80, &[fragment(), fragment()]),
        Err(ProjectionError::NonCanonicalOrder)
    );
    fragments.reverse();
    assert_eq!(
        validate_row(80, &fragments),
        Err(ProjectionError::NonCanonicalOrder)
    );
    let mut adjacent = fragment();
    adjacent.slice.left = adjacent.slice.right;
    adjacent.slice.right += U;
    // Multiple placeholder cells share their placement's order but not geometry.
    validate_row(80, &[fragment(), adjacent]).unwrap();
}

#[test]
fn retained_versions_outlive_the_owner_and_quota_refusal_is_atomic() {
    let charge = retained_usage(1).unwrap();
    let limit = Usage {
        bytes: charge.bytes * 2,
        objects: charge.objects * 2,
    };
    let aggregate = Aggregate::new(limit);
    let budget = aggregate.partition(limit);
    let mut row = RowFragments::default();
    let f = fragment();
    assert!(row.replace(&budget, 80, &[f]).unwrap());
    let old = row.clone();
    let mut next = f;
    next.content.root = [8; 32];
    assert!(row.replace(&budget, 80, &[next]).unwrap());
    assert_eq!(aggregate.used(), Some(limit));
    assert_eq!(old.as_slice(), &[f]);
    assert!(!row.same(&old));
    assert!(row.same(&row.clone()));
    assert!(!row.replace(&budget, 80, &[next]).unwrap());
    let mut third = next;
    third.stack.z = -1;
    assert_eq!(
        row.replace(&budget, 80, &[third]),
        Err(ProjectionError::Quota)
    );
    assert_eq!(row.as_slice(), &[next]);
    drop(old);
    assert!(row.replace(&budget, 80, &[third]).unwrap());
    assert_eq!(aggregate.used(), Some(charge));
    let repair = row.clone();
    assert!(row.replace(&budget, 80, &[]).unwrap());
    assert!(row.is_empty());
    assert_eq!(aggregate.used(), Some(charge));
    drop(budget);
    drop(row);
    assert_eq!(repair.as_slice(), &[third]);
    drop(repair);
    assert_eq!(
        aggregate.used(),
        Some(Usage {
            bytes: 0,
            objects: 0
        })
    );
}

#[test]
fn object_limits_and_fragment_limits_are_independent_of_byte_space() {
    let budget = Budget::new(Usage {
        bytes: usize::MAX,
        objects: 1,
    });
    let mut row = RowFragments::default();
    assert_eq!(
        row.replace(&budget, 80, &[fragment()]),
        Err(ProjectionError::Quota)
    );
    assert!(row.is_empty());
    let excessive = vec![fragment(); MAX_ROW_FRAGMENTS + 1];
    assert_eq!(
        row.replace(&budget, 80, &excessive),
        Err(ProjectionError::TooManyFragments)
    );
    assert_eq!(retained_usage(usize::MAX), None);
    assert_eq!(
        retained_usage(0),
        Some(Usage {
            bytes: 0,
            objects: 0
        })
    );
    assert_eq!(
        budget.used(),
        Some(Usage {
            bytes: 0,
            objects: 0
        })
    );
}

#[test]
fn coverage_uses_fractional_half_open_cells_even_without_pixels() {
    let budget = Budget::new(Usage {
        bytes: 1 << 20,
        objects: 20,
    });
    let mut row = RowFragments::default();
    assert!(!row.intersects_cells(0, 80));
    row.replace(&budget, 80, &[fragment()]).unwrap();
    assert!(row.intersects_cells(0, 1));
    assert!(row.intersects_cells(2, 3));
    assert!(!row.intersects_cells(3, 80));
    assert!(!row.intersects_cells(1, 1));
    assert!(!row.intersects_cells(80, 0));
    let mut f = fragment();
    f.slice.right = 2 * U;
    row.replace(&budget, 80, &[f]).unwrap();
    assert!(!row.intersects_cells(2, 3));
}

#[test]
fn projection_visits_only_visible_rows_and_keeps_original_source_edges() {
    let f = fragment();
    let geometry = Layout {
        columns: 4,
        rows: 8,
        ..Layout::default()
    }
    .geometry(
        100,
        200,
        CellMetrics::new(8 * PIXEL_UNIT, 16 * PIXEL_UNIT).unwrap(),
    )
    .unwrap()
    .unwrap();
    let unit = i128::from(U);
    let projection = PlacementProjection {
        content: f.content,
        stack: f.stack,
        geometry,
        position: Position {
            column: -1,
            line: -3,
        },
        clip: CellRect::fixed(unit / 3, unit / 2, 2 * unit, 2 * unit + unit / 4),
    };
    let rows = projection.rows(80, 24).unwrap();
    assert_eq!(rows.len(), 3);
    let rows: Vec<_> = rows.collect();
    assert_eq!(
        rows.iter().map(|(row, _)| *row).collect::<Vec<_>>(),
        [0, 1, 2]
    );
    assert_eq!(rows[0].1.slice.top, U / 2);
    assert_eq!(rows[2].1.slice.bottom, U / 4);
    for (_, f) in &rows {
        assert!(f.valid(80));
        assert_eq!(f.slice.left, U / 3);
        assert_eq!(f.slice.right, 2 * U);
    }
    for pair in rows.windows(2) {
        assert_eq!(pair[0].1.slice.source_bottom, pair[1].1.slice.source_top);
    }
    for position in [
        Position {
            column: i64::MIN,
            line: 0,
        },
        Position {
            column: i64::MAX,
            line: 0,
        },
        Position {
            column: 0,
            line: i64::MIN,
        },
        Position {
            column: 0,
            line: i64::MAX,
        },
    ] {
        assert_eq!(
            PlacementProjection {
                position,
                ..projection
            }
            .rows(80, 24)
            .unwrap()
            .len(),
            0
        );
    }
    let mismatch = PlacementProjection {
        content: Content {
            kind: merkur_graphics::projection::ContentKind::Image,
            width: 99,
            ..f.content
        },
        ..projection
    };
    assert!(matches!(
        mismatch.rows(80, 24),
        Err(ProjectionError::InvalidFragment)
    ));
}

proptest! {
    #[test]
    fn visible_interval_matches_exhaustive_row_projection(
        width in 1u32..16385,
        height in 1u32..1025,
        columns in 1u16..513,
        rows in 1u16..257,
        placement_cols in 1u32..600,
        placement_rows in 1u32..400,
        column in -700i64..700,
        line in -500i64..500,
        clip_left in -100i64..600,
        clip_top in -100i64..300,
        fractional in 0u64..U,
    ) {
        let geometry = Layout { columns: placement_cols, rows: placement_rows, ..Layout::default() }
            .geometry(width, height, CellMetrics::new(8 * PIXEL_UNIT, 16 * PIXEL_UNIT).unwrap())
            .unwrap().unwrap();
        let u = i128::from(U);
        let clip = CellRect::fixed(
            i128::from(clip_left) * u + i128::from(fractional),
            i128::from(clip_top) * u + i128::from(fractional),
            i128::from(clip_left + 20) * u,
            i128::from(clip_top + 40) * u,
        );
        for clip in [None, clip] {
            let expected: Vec<_> = (0..rows).filter_map(|row| {
                let slice = match clip {
                    Some(c) => geometry.project_row_clipped(column, line, u32::from(columns), i64::from(row), c),
                    None => geometry.project_row(column, line, u32::from(columns), i64::from(row)),
                };
                slice.map(|slice| (row, slice))
            }).collect();
            let projection = PlacementProjection {
                content: Content {
            kind: merkur_graphics::projection::ContentKind::Image, root: [0; 32], width, height },
                stack: fragment().stack,
                geometry, position: Position { column, line }, clip,
            };
            let actual = projection.rows(columns, rows).unwrap();
            prop_assert_eq!(actual.len(), expected.len());
            let actual: Vec<_> = actual.map(|(row, f)| {
                assert!(f.valid(columns));
                assert_eq!(Fragment::decode(&f.encode(), columns), Some(f));
                (row, f.slice)
            }).collect();
            prop_assert_eq!(actual, expected);
        }
    }
}

#[test]
fn retained_digest_matches_canonical_bytes_and_survives_replacement() {
    let budget = Budget::new(Usage {
        bytes: 1 << 20,
        objects: 8,
    });
    let mut row = RowFragments::default();
    assert_eq!(row.digest(), None);
    let original = fragment();
    row.replace(&budget, 8, &[original]).unwrap();
    let mut canonical = 1u16.to_be_bytes().to_vec();
    canonical.extend_from_slice(&original.encode());
    let expected = xxhash_rust::xxh3::xxh3_64(&canonical);
    assert_eq!(row.digest(), Some(expected));
    let held = row.clone();
    let mut changed = original;
    changed.slice.left += 1;
    row.replace(&budget, 8, &[changed]).unwrap();
    assert_ne!(row.digest(), held.digest());
    assert_eq!(held.digest(), Some(expected));
    row.replace(&budget, 8, &[]).unwrap();
    assert_eq!(row.digest(), None);
    assert_eq!(held.digest(), Some(expected));
}
