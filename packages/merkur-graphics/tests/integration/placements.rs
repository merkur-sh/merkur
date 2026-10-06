use merkur_graphics::budget::{Budget, Usage};
use merkur_graphics::command::{Control, Error};
use merkur_graphics::placements::{
    AnchorId, Layout, MAX_DEPENDENCY_DEPTH, Origin, PLACEMENT_METADATA_BYTES, PlacementError,
    PlacementOrigin, PlacementRequest, Placements, Position,
};
use merkur_graphics::publication::ImageIncarnation;
use std::num::NonZeroU64;

fn image(id: u64) -> ImageIncarnation {
    ImageIncarnation(NonZeroU64::new(id).unwrap())
}
fn direct(line: u64) -> Origin {
    Origin::Direct(AnchorId(NonZeroU64::new(line).unwrap()))
}
fn placements(objects: usize) -> (Placements, Budget) {
    let budget = Budget::new(Usage {
        bytes: objects * PLACEMENT_METADATA_BYTES,
        objects,
    });
    (Placements::new(budget.clone()), budget)
}

#[test]
fn placeholder_selection_tracks_virtual_replacement_and_removal() {
    let (mut placements, budget) = placements(3);
    let virtual_id = placements
        .put(image(1), 7, Origin::Virtual, Layout::default())
        .unwrap();
    placements
        .put(image(1), 8, direct(1), Layout::default())
        .unwrap();
    assert_eq!(placements.resolve_virtual(image(1), 0), Some(virtual_id));
    assert_eq!(placements.resolve_virtual(image(1), 7), Some(virtual_id));
    assert_eq!(placements.resolve_virtual(image(1), 8), None);
    assert_eq!(placements.virtuals().collect::<Vec<_>>(), [virtual_id]);
    placements
        .put(image(1), 7, direct(2), Layout::default())
        .unwrap();
    assert_eq!(placements.virtuals().len(), 0);
    assert_eq!(placements.resolve_virtual(image(1), 0), None);
    placements
        .put(image(1), 7, Origin::Virtual, Layout::default())
        .unwrap();
    placements.remove(virtual_id, |_, _| {});
    assert_eq!(placements.virtuals().len(), 0);
    placements.clear();
    assert_eq!(
        budget.used(),
        Some(Usage {
            bytes: 0,
            objects: 0
        })
    );
}

#[test]
fn anchor_changes_invalidate_all_attached_subtrees_and_no_unrelated_roots() {
    let (mut placements, _) = placements(5);
    let root = placements
        .put(image(1), 1, direct(1), Layout::default())
        .unwrap();
    let sibling = placements
        .put(image(2), 1, direct(1), Layout::default())
        .unwrap();
    let other = placements
        .put(image(3), 1, direct(2), Layout::default())
        .unwrap();
    let child = placements
        .put(
            image(4),
            1,
            Origin::Relative {
                parent: root,
                columns: 1,
                rows: 1,
            },
            Layout::default(),
        )
        .unwrap();
    let leaf = placements
        .put(
            image(5),
            1,
            Origin::Relative {
                parent: child,
                columns: 1,
                rows: 1,
            },
            Layout::default(),
        )
        .unwrap();
    placements.take_dirty();
    placements.invalidate_anchor(AnchorId(NonZeroU64::new(1).unwrap()));
    assert_eq!(placements.take_dirty(), [root, sibling, child, leaf].into());
    placements.invalidate_anchor(AnchorId(NonZeroU64::new(3).unwrap()));
    assert!(placements.take_dirty().is_empty());
    placements.invalidate_all();
    assert_eq!(
        placements.take_dirty(),
        [root, sibling, other, child, leaf].into()
    );
}

#[test]
fn placement_intent_keeps_relative_and_virtual_commands_off_the_cursor_path() {
    let request = |bytes: &[u8]| PlacementRequest::from_control(&Control::parse(bytes).unwrap());
    assert!(request(b"a=p,i=1").unwrap().move_cursor);
    assert!(!request(b"a=p,i=1,C=1").unwrap().move_cursor);
    let relative = request(b"a=T,i=1,p=2,P=3,Q=4,H=-2147483648,V=2147483647,C=0").unwrap();
    assert!(!relative.move_cursor);
    assert_eq!(relative.client_id, 2);
    assert_eq!(
        relative.origin,
        PlacementOrigin::Relative {
            image_id: 3,
            placement_id: 4,
            columns: i32::MIN,
            rows: i32::MAX,
        }
    );
    let virtual_placement = request(b"a=p,I=2,U=1,c=4,r=2").unwrap();
    assert_eq!(virtual_placement.origin, PlacementOrigin::Virtual);
    assert!(!virtual_placement.move_cursor);
    assert_eq!(
        (
            virtual_placement.layout.columns,
            virtual_placement.layout.rows
        ),
        (4, 2)
    );
    for control in [
        b"a=p,U=1,P=1".as_slice(),
        b"a=p,U=2",
        b"a=p,C=2",
        b"a=p,i=1,I=2",
    ] {
        assert_eq!(request(control), Err(Error::InvalidControl));
    }
    assert_eq!(request(b"a=t"), Err(Error::UnsupportedAction));
}

#[test]
fn relative_positions_resolve_both_coordinates_from_the_current_grid_anchor() {
    let (mut placements, _) = placements(4);
    let root = placements
        .put(image(1), 1, direct(1), Layout::default())
        .unwrap();
    let child = placements
        .put(
            image(2),
            1,
            Origin::Relative {
                parent: root,
                columns: -4,
                rows: 3,
            },
            Layout {
                offset_x: 3,
                offset_y: 7,
                ..Layout::default()
            },
        )
        .unwrap();
    let tail = placements
        .put(
            image(3),
            1,
            Origin::Relative {
                parent: child,
                columns: 2,
                rows: -1,
            },
            Layout::default(),
        )
        .unwrap();
    for (column, line) in [(8, 0), (1, -6), (0, 9)] {
        let position = placements.position(
            tail,
            |anchor| {
                assert_eq!(anchor, AnchorId(NonZeroU64::new(1).unwrap()));
                Some(Position { column, line })
            },
            |_| panic!("direct root"),
        );
        assert_eq!(
            position,
            Some(Position {
                column: column - 2,
                line: line + 2
            })
        );
    }
    assert_eq!(
        placements.position(tail, |_| None, |_| panic!("direct root")),
        None
    );
    // A virtual prototype can parent the existing subtree without changing IDs.
    placements
        .put(image(1), 1, Origin::Virtual, Layout::default())
        .unwrap();
    assert_eq!(
        placements.position(
            tail,
            |_| panic!("virtual root"),
            |id| {
                assert_eq!(id, root);
                Some(Position {
                    column: 4,
                    line: -8,
                })
            }
        ),
        Some(Position {
            column: 2,
            line: -6
        })
    );
    assert_eq!(
        placements.position(tail, |_| panic!("virtual root"), |_| None),
        None
    );
}

#[test]
fn relative_position_overflow_is_invisible_and_never_wraps_onto_screen() {
    let (mut placements, _) = placements(2);
    let root = placements
        .put(image(1), 1, direct(1), Layout::default())
        .unwrap();
    let child = placements
        .put(
            image(2),
            1,
            Origin::Relative {
                parent: root,
                columns: 1,
                rows: -1,
            },
            Layout::default(),
        )
        .unwrap();
    for position in [
        Position {
            column: i64::MAX,
            line: 0,
        },
        Position {
            column: 0,
            line: i64::MIN,
        },
    ] {
        assert_eq!(
            placements.position(child, |_| Some(position), |_| None),
            None
        );
    }
}

#[test]
fn retained_removal_geometry_keeps_its_metadata_reservation() {
    let (mut placements, budget) = placements(1);
    let root = placements
        .put(image(1), 1, direct(1), Layout::default())
        .unwrap();
    let mut removed = Vec::new();
    placements.remove(root, |placement, _| removed.push(placement));
    assert_eq!(removed[0].image, image(1));
    assert_eq!(budget.used().unwrap().objects, 1);
    assert_eq!(
        placements.put(image(2), 1, direct(2), Layout::default()),
        Err(PlacementError::Quota)
    );
    drop(removed);
    assert_eq!(budget.used().unwrap().bytes, 0);
    assert!(
        placements
            .put(image(2), 1, direct(2), Layout::default())
            .is_ok()
    );
}

#[test]
fn an_admitted_placement_is_never_refused_storage_and_its_lease_is_the_metadata() {
    let (mut placements, budget) = placements(1);
    let metadata = budget
        .reserve(Usage {
            bytes: PLACEMENT_METADATA_BYTES,
            objects: 1,
        })
        .unwrap();
    // The partition is full: only the admitted lease can place.
    assert_eq!(
        placements.put(image(1), 1, direct(1), Layout::default()),
        Err(PlacementError::Quota)
    );
    let id = placements
        .put_admitted(image(1), 1, direct(1), Layout::default(), metadata)
        .unwrap();
    assert_eq!(budget.used().unwrap().objects, 1);
    placements.remove(id, |_, _| {});
    assert_eq!(budget.used().unwrap().objects, 0);
    // Replacing a named placement needs no metadata: the admitted lease returns.
    let id = placements
        .put(image(2), 1, direct(2), Layout::default())
        .unwrap();
    let spare = Budget::new(Usage {
        bytes: PLACEMENT_METADATA_BYTES,
        objects: 1,
    });
    let replacement = spare
        .reserve(Usage {
            bytes: PLACEMENT_METADATA_BYTES,
            objects: 1,
        })
        .unwrap();
    assert_eq!(
        placements.put_admitted(image(2), 1, direct(3), Layout::default(), replacement),
        Ok(id)
    );
    assert_eq!(spare.used().unwrap().objects, 0);
    assert_eq!(budget.used().unwrap().objects, 1);
}

#[test]
fn replacing_named_placement_keeps_children_and_invalidates_only_its_subtree() {
    let (mut placements, _) = placements(8);
    let root = placements
        .put(image(1), 7, direct(1), Layout::default())
        .unwrap();
    let child = placements
        .put(
            image(2),
            8,
            Origin::Relative {
                parent: root,
                columns: -1,
                rows: 2,
            },
            Layout::default(),
        )
        .unwrap();
    let unrelated = placements
        .put(image(3), 9, direct(2), Layout::default())
        .unwrap();
    placements.take_dirty();
    assert_eq!(
        placements.put(image(1), 7, direct(3), Layout::default()),
        Ok(root)
    );
    assert_eq!(
        placements.take_dirty().into_iter().collect::<Vec<_>>(),
        vec![root, child]
    );
    assert_eq!(
        placements
            .anchored(AnchorId(NonZeroU64::new(1).unwrap()))
            .count(),
        0
    );
    assert_eq!(
        placements
            .anchored(AnchorId(NonZeroU64::new(3).unwrap()))
            .collect::<Vec<_>>(),
        vec![root]
    );
    let mut removed = Vec::new();
    placements.remove(root, |placement, _| removed.push(placement));
    assert_eq!(removed.len(), 2);
    assert!(placements.get(child).is_none());
    assert!(placements.get(unrelated).is_some());
}

#[test]
fn cycles_and_reparenting_too_deep_subtrees_are_rejected_atomically() {
    let (mut placements, _) = placements(MAX_DEPENDENCY_DEPTH + 3);
    let root = placements
        .put(image(1), 1, direct(1), Layout::default())
        .unwrap();
    let mut tail = root;
    for id in 2..=MAX_DEPENDENCY_DEPTH {
        tail = placements
            .put(
                image(id as u64),
                1,
                Origin::Relative {
                    parent: tail,
                    columns: 0,
                    rows: 0,
                },
                Layout::default(),
            )
            .unwrap();
    }
    assert_eq!(
        placements.put(
            image(1),
            1,
            Origin::Relative {
                parent: tail,
                columns: 0,
                rows: 0
            },
            Layout::default()
        ),
        Err(PlacementError::Cycle)
    );
    assert_eq!(
        placements.put(
            image(1000),
            1,
            Origin::Relative {
                parent: tail,
                columns: 0,
                rows: 0
            },
            Layout::default()
        ),
        Err(PlacementError::TooDeep)
    );
    let other = placements
        .put(image(1001), 1, direct(2), Layout::default())
        .unwrap();
    assert_eq!(
        placements.put(
            image(1),
            1,
            Origin::Relative {
                parent: other,
                columns: 0,
                rows: 0
            },
            Layout::default()
        ),
        Err(PlacementError::TooDeep)
    );
    assert_eq!(placements.get(root).unwrap().origin, direct(1));
    assert_eq!(placements.len(), MAX_DEPENDENCY_DEPTH + 1);
}

#[test]
fn height_accounting_recovers_after_detach_and_parent_deletion() {
    let (mut placements, budget) = placements(MAX_DEPENDENCY_DEPTH + 2);
    let root = placements
        .put(image(1), 1, direct(1), Layout::default())
        .unwrap();
    let mut tail = root;
    let mut chain = vec![root];
    for id in 2..=MAX_DEPENDENCY_DEPTH {
        tail = placements
            .put(
                image(id as u64),
                1,
                Origin::Relative {
                    parent: tail,
                    columns: 0,
                    rows: 0,
                },
                Layout::default(),
            )
            .unwrap();
        chain.push(tail);
    }
    // Detaching the entire suffix updates all ancestor height counts.
    assert_eq!(
        placements.put(image(2), 1, direct(2), Layout::default()),
        Ok(chain[1])
    );
    let mut removed = 0;
    placements.remove(root, |_, _| removed += 1);
    assert_eq!(removed, 1);
    placements.remove(chain[1], |_, _| removed += 1);
    assert_eq!(removed, MAX_DEPENDENCY_DEPTH);
    assert_eq!(
        budget.used(),
        Some(Usage {
            bytes: 0,
            objects: 0
        })
    );
    let fresh = placements
        .put(image(1), 1, direct(3), Layout::default())
        .unwrap();
    assert!(fresh > tail);
}

#[test]
fn anonymous_placements_are_distinct_and_budget_failure_preserves_existing_state() {
    let (mut placements, budget) = placements(2);
    let a = placements
        .put(image(1), 0, direct(1), Layout::default())
        .unwrap();
    let b = placements
        .put(image(1), 0, direct(1), Layout::default())
        .unwrap();
    assert_ne!(a, b);
    assert_eq!(
        placements.put(image(1), 1, Origin::Virtual, Layout::default()),
        Err(PlacementError::Quota)
    );
    assert_eq!(placements.image_placements(image(1)).count(), 2);
    placements.clear();
    assert_eq!(
        budget.used(),
        Some(Usage {
            bytes: 0,
            objects: 0
        })
    );
    let c = placements
        .put(image(1), 0, direct(1), Layout::default())
        .unwrap();
    assert!(c > b);
}
