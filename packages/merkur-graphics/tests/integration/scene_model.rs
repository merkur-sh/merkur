//! Exhaustive state comparison against a deliberately unindexed reference graph.
//! The oracle scans parent chains and the whole scene after every operation; it
//! shares identities and public values, but none of the production reverse indices.
use std::collections::{BTreeMap, BTreeSet};
use std::num::NonZeroU64;

use merkur_graphics::budget::{Budget, Usage};
use merkur_graphics::placements::{
    AnchorId, Layout, Origin, PLACEMENT_METADATA_BYTES, Placement, PlacementError, PlacementId,
    Placements, Position,
};
use merkur_graphics::publication::ImageIncarnation;

const LIMIT: usize = 24;

fn number(n: u64) -> NonZeroU64 {
    NonZeroU64::new(n).unwrap()
}

fn next(state: &mut u64) -> u64 {
    *state ^= *state << 13;
    *state ^= *state >> 7;
    *state ^= *state << 17;
    *state
}

#[derive(Default)]
struct Model {
    rows: BTreeMap<PlacementId, Placement>,
    last: u64,
    dirty: BTreeSet<PlacementId>,
}

impl Model {
    fn depends(&self, mut id: PlacementId, root: PlacementId) -> bool {
        loop {
            if id == root {
                return true;
            }
            match self.rows.get(&id).map(|p| p.origin) {
                Some(Origin::Relative { parent, .. }) => id = parent,
                _ => return false,
            }
        }
    }

    fn invalidate(&mut self, root: PlacementId) {
        self.dirty.extend(
            self.rows
                .keys()
                .copied()
                .filter(|id| self.depends(*id, root))
                .collect::<Vec<_>>(),
        );
    }

    fn put(
        &mut self,
        image: ImageIncarnation,
        client_id: u32,
        origin: Origin,
        layout: Layout,
    ) -> Result<PlacementId, PlacementError> {
        let existing = self
            .rows
            .values()
            .find(|p| client_id != 0 && p.image == image && p.client_id == client_id)
            .map(|p| p.id);
        if let Origin::Relative { parent, .. } = origin {
            if existing.is_some_and(|id| self.depends(parent, id)) {
                return Err(PlacementError::Cycle);
            }
            if !self.rows.contains_key(&parent) {
                return Err(PlacementError::MissingParent);
            }
        }
        let id = match existing {
            Some(id) => id,
            None if self.rows.len() == LIMIT => return Err(PlacementError::Quota),
            None => {
                self.last += 1;
                PlacementId(number(self.last))
            }
        };
        self.rows.insert(
            id,
            Placement {
                id,
                image,
                client_id,
                origin,
                layout,
            },
        );
        self.invalidate(id);
        Ok(id)
    }

    fn remove(&mut self, root: PlacementId) -> BTreeSet<PlacementId> {
        let removed: BTreeSet<_> = self
            .rows
            .keys()
            .copied()
            .filter(|id| self.depends(*id, root))
            .collect();
        self.rows.retain(|id, _| !removed.contains(id));
        self.dirty.retain(|id| !removed.contains(id));
        removed
    }

    fn position(&self, mut id: PlacementId, tick: u64) -> Option<Position> {
        let mut x = 0i128;
        let mut y = 0i128;
        loop {
            let root = match self.rows.get(&id)?.origin {
                Origin::Relative {
                    parent,
                    columns,
                    rows,
                } => {
                    x += i128::from(columns);
                    y += i128::from(rows);
                    id = parent;
                    continue;
                }
                Origin::Direct(anchor) => root_position(anchor.0.get(), tick)?,
                Origin::Virtual => root_position(id.0.get(), tick + 1)?,
            };
            return Some(Position {
                column: i64::try_from(x + i128::from(root.column)).ok()?,
                line: i64::try_from(y + i128::from(root.line)).ok()?,
            });
        }
    }
}

fn root_position(id: u64, tick: u64) -> Option<Position> {
    if (id + tick).is_multiple_of(7) {
        return None;
    }
    Some(Position {
        column: match tick % 3 {
            0 => i64::MAX,
            1 => i64::MIN,
            _ => id as i64 - 16,
        },
        line: tick as i64 % 41 - 20,
    })
}

#[test]
fn dependency_indices_and_authority_match_full_scene_scans_under_mutation() {
    let mut outcomes = [0usize; 5];
    for seed in 1..=16 {
        let mut random = seed;
        let budget = Budget::new(Usage {
            bytes: LIMIT * PLACEMENT_METADATA_BYTES,
            objects: LIMIT,
        });
        let mut scene = Placements::new(budget.clone());
        let mut model = Model::default();
        for step in 0..2000 {
            let r = next(&mut random);
            let image = ImageIncarnation(number(1 + r % 5));
            let anchor = AnchorId(number(1 + (r >> 8) % 7));
            let chosen = model
                .rows
                .keys()
                .copied()
                .nth((r as usize >> 16) % model.rows.len().max(1))
                .unwrap_or(PlacementId(number(model.last + 1)));
            match r % 16 {
                0..=9 => {
                    let client = ((r >> 24) % 5) as u32;
                    let origin = match (r >> 32) % 4 {
                        0 => Origin::Direct(anchor),
                        1 => Origin::Virtual,
                        _ => Origin::Relative {
                            parent: chosen,
                            columns: (r >> 40) as i16 as i32,
                            rows: (r >> 48) as i16 as i32,
                        },
                    };
                    let layout = Layout {
                        columns: 1 + (r % 33) as u32,
                        rows: 1 + (r % 17) as u32,
                        z: r as i32,
                        ..Layout::default()
                    };
                    let expected = model.put(image, client, origin, layout);
                    let actual = scene.put(image, client, origin, layout);
                    assert_eq!(actual, expected, "seed={seed} step={step}");
                    outcomes[match actual {
                        Ok(_) => 0,
                        Err(PlacementError::Quota) => 1,
                        Err(PlacementError::Cycle) => 2,
                        Err(PlacementError::MissingParent) => 3,
                        _ => unreachable!(),
                    }] += 1;
                }
                10 | 11 => {
                    let expected = model.remove(chosen);
                    let mut actual = BTreeSet::new();
                    scene.remove(chosen, |p, _| {
                        assert!(actual.insert(p.id));
                    });
                    assert_eq!(actual, expected, "seed={seed} step={step}");
                    outcomes[4] += actual.len();
                }
                12 => {
                    scene.invalidate_anchor(anchor);
                    let roots: Vec<_> = model
                        .rows
                        .values()
                        .filter(|p| p.origin == Origin::Direct(anchor))
                        .map(|p| p.id)
                        .collect();
                    for root in roots {
                        model.invalidate(root);
                    }
                }
                13 => {
                    scene.invalidate_image(image);
                    model.dirty.extend(
                        model
                            .rows
                            .values()
                            .filter(|p| p.image == image)
                            .map(|p| p.id),
                    );
                }
                14 => {
                    scene.invalidate(chosen);
                    model.invalidate(chosen);
                }
                _ if step % 31 == 0 => {
                    scene.clear();
                    model.rows.clear();
                    model.dirty.clear();
                }
                _ => {
                    scene.invalidate_all();
                    model.dirty.extend(model.rows.keys().copied());
                }
            }
            assert_eq!(
                scene.iter().copied().collect::<Vec<_>>(),
                model.rows.values().copied().collect::<Vec<_>>(),
                "seed={seed} step={step}"
            );
            assert_eq!(
                scene.take_dirty(),
                std::mem::take(&mut model.dirty),
                "seed={seed} step={step}"
            );
            assert_eq!(
                budget.used(),
                Some(Usage {
                    bytes: model.rows.len() * PLACEMENT_METADATA_BYTES,
                    objects: model.rows.len()
                })
            );
            assert_eq!(
                scene.virtuals().collect::<Vec<_>>(),
                model
                    .rows
                    .values()
                    .filter(|p| p.origin == Origin::Virtual)
                    .map(|p| p.id)
                    .collect::<Vec<_>>()
            );
            for image_id in 1..=5 {
                let image = ImageIncarnation(number(image_id));
                let all: Vec<_> = model.rows.values().filter(|p| p.image == image).collect();
                assert_eq!(
                    scene.image_placements(image).collect::<Vec<_>>(),
                    all.iter().map(|p| p.id).collect::<Vec<_>>()
                );
                for client in 0..=5 {
                    let select = |virtual_only: bool| {
                        all.iter()
                            .rev()
                            .find(|p| {
                                (client == 0 || p.client_id == client)
                                    && (!virtual_only || p.origin == Origin::Virtual)
                            })
                            .map(|p| p.id)
                    };
                    assert_eq!(scene.resolve(image, client), select(false));
                    assert_eq!(scene.resolve_virtual(image, client), select(true));
                }
            }
            for p in model.rows.values() {
                assert_eq!(
                    scene.position(
                        p.id,
                        |a| root_position(a.0.get(), step),
                        |id| root_position(id.0.get(), step + 1)
                    ),
                    model.position(p.id, step),
                    "seed={seed} step={step} placement={p:?}"
                );
            }
            for a in 1..=7 {
                let anchor = AnchorId(number(a));
                assert_eq!(
                    scene.anchored(anchor).collect::<Vec<_>>(),
                    model
                        .rows
                        .values()
                        .filter(|p| p.origin == Origin::Direct(anchor))
                        .map(|p| p.id)
                        .collect::<Vec<_>>()
                );
            }
        }
        drop(scene);
        assert_eq!(
            budget.used(),
            Some(Usage {
                bytes: 0,
                objects: 0
            })
        );
    }
    assert!(
        outcomes.iter().all(|count| *count > 100),
        "operation populations {outcomes:?}"
    );
}
