//! Persistent visibility produces canonical rows for every viewer. Admission is a
//! transaction: no row is published until the complete replacement is reserved.

use merkur_codec::{GraphicsEncodeScratch, PreparedGraphics};
use merkur_graphics::budget::Lease;
use merkur_graphics::projection::{
    Content, Fragment, MAX_ROW_FRAGMENTS, PlacementProjection, Stack,
};

use super::*;

const ROWS: usize = crate::pty::dimensions::MAX_TERMINAL_ROWS as usize;
use super::visibility::{Entry as Resolved, Index};

pub(super) struct Workspace {
    visibility: Index,
    geometry: Option<(u16, u16, CellMetrics)>,
    fragments: Vec<Fragment>,
    encoder: GraphicsEncodeScratch,
    staged: Vec<PreparedGraphics>,
    /// `staged`'s charges, in step with it, swapped with the owner's alongside it.
    staged_leases: Vec<Option<Lease>>,
    counts: [usize; ROWS],
    placeholder_counts: [usize; ROWS],
    reusable: [bool; ROWS],
    capacity: usize,
    _lease: Lease,
}

impl Workspace {
    fn receiver_fits(&self, columns: u16, rows: u16) -> bool {
        if self.counts.iter().any(|count| *count > MAX_ROW_FRAGMENTS) {
            return false;
        }
        let Some(wire_budget) = merkur_codec::snapshot_graphics_budget(columns, rows) else {
            return false;
        };
        let wire_bound: usize = self
            .counts
            .iter()
            .map(|count| {
                PreparedGraphics::reservation_bound(*count)
                    .expect("bounded placement count")
                    .bytes
            })
            .sum();
        wire_bound <= wire_budget
            && self
                .counts
                .iter()
                .map(|count| {
                    merkur_graphics::projection::retained_usage(*count)
                        .expect("bounded placement count")
                        .bytes
                })
                .sum::<usize>()
                <= merkur_graphics::projection::MAX_VIEWPORT_GRAPHICS_BYTES
    }
    fn new(budget: &Budget, count: usize) -> Option<Box<Self>> {
        if count > MAX_ROW_FRAGMENTS {
            return None;
        }
        let lease = budget.reserve(Usage {
            bytes: size_of::<Self>()
                + ROWS * (size_of::<PreparedGraphics>() + size_of::<Option<Lease>>())
                + Index::reservation_bytes(count)
                + count * (size_of::<Fragment>() + size_of::<Content>()),
            objects: 8,
        })?;
        Some(Box::new(Self {
            visibility: Index::new(count),
            geometry: None,
            fragments: Vec::with_capacity(count),
            encoder: GraphicsEncodeScratch::with_capacity(count),
            staged: Vec::with_capacity(ROWS),
            staged_leases: Vec::with_capacity(ROWS),
            counts: [0; ROWS],
            placeholder_counts: [0; ROWS],
            reusable: [false; ROWS],
            capacity: count,
            _lease: lease,
        }))
    }

    pub(super) fn remove(&mut self, id: PlacementId) {
        self.visibility.remove(id);
        for row in 0..ROWS {
            self.counts[row] = self.visibility.counts[row] + self.placeholder_counts[row];
            self.reusable[row] &= !self.visibility.dirty[row];
        }
    }

    fn sync_placeholders(&mut self, index: Option<&placeholders::Index>) {
        for row in 0..ROWS {
            let count = index.map_or(0, |index| index.row(row).len());
            self.counts[row] = self.visibility.counts[row] + count;
            if index.is_some_and(|index| index.changed[row])
                || self.placeholder_counts[row] != count
            {
                self.reusable[row] = false;
            }
            self.placeholder_counts[row] = count;
        }
    }

    fn required(&self) -> Usage {
        let mut required = Usage {
            bytes: 0,
            objects: 0,
        };
        for (count, reusable) in self.counts.iter().zip(self.reusable) {
            if reusable {
                continue;
            }
            let usage =
                PreparedGraphics::reservation_bound(*count).expect("bounded placement count");
            required.bytes += usage.bytes;
            required.objects += usage.objects;
        }
        required
    }

    /// Query only invalidated rows, in canonical stacking order. Exact subtree
    /// row masks skip unrelated placements without sorting or allocating.
    /// Staging moves a reused row's charge out of `previous_leases`, so it keeps
    /// its version; what stays behind belongs to superseded rows.
    fn sweep(
        &mut self,
        columns: u16,
        rows: u16,
        previous: &[PreparedGraphics],
        previous_leases: &mut [Option<Lease>],
        mut reservation: Option<&mut Lease>,
        placeholders: Option<&placeholders::Index>,
    ) {
        self.staged.clear();
        self.staged_leases.clear();
        for row in 0..rows {
            let old = previous
                .get(usize::from(row))
                .unwrap_or(&PreparedGraphics::EMPTY);
            if self.reusable[usize::from(row)] {
                if reservation.is_some() {
                    self.staged.push(old.clone());
                    self.staged_leases.push(
                        previous_leases
                            .get_mut(usize::from(row))
                            .and_then(Option::take),
                    );
                }
                continue;
            }
            self.fragments.clear();
            let mut placeholders = placeholders
                .map_or(&[][..], |index| index.row(usize::from(row)))
                .iter()
                .peekable();
            self.visibility.visit(usize::from(row), |projection| {
                let position = projection.position;
                let slice = match projection.clip {
                    Some(clip) => projection.geometry.project_row_clipped(
                        position.column,
                        position.line,
                        u32::from(columns),
                        i64::from(row),
                        clip,
                    ),
                    None => projection.geometry.project_row(
                        position.column,
                        position.line,
                        u32::from(columns),
                        i64::from(row),
                    ),
                }
                .expect("visible interval contains intersecting rows");
                let fragment = Fragment {
                    content: projection.content,
                    stack: projection.stack,
                    slice,
                };
                while placeholders
                    .peek()
                    .is_some_and(|next| next.compare(&fragment).is_lt())
                {
                    self.fragments
                        .push(*placeholders.next().expect("peeked fragment"));
                }
                self.fragments.push(fragment);
            });
            self.fragments.extend(placeholders.copied());
            if let Some(reservation) = reservation.as_deref_mut() {
                let (prepared, lease) = PreparedGraphics::new_reserved(
                    reservation,
                    columns,
                    &self.fragments,
                    &mut self.encoder,
                )
                .expect("complete canonical projection was admitted before allocation");
                self.staged.push(prepared);
                self.staged_leases.push(lease);
            } else {
                self.reusable[usize::from(row)] = old.matches(columns, &self.fragments);
            }
        }
    }
}

impl Graphics {
    /// Evicts the oldest source, only once every release already in flight has landed: the
    /// shortfall may be one those releases cover, and a refund on the retirement thread is
    /// never synchronous. False when nothing was evicted: the scene is empty, or a release
    /// is still in flight (the projection is then deferred until the owner loop observes it).
    pub(super) fn evict_projection_source(&mut self, term: &mut Term<EventForwarder>) -> bool {
        if self.release_pending() {
            self.projection_deferred = true;
            self.projection_dirty = true;
            return false;
        }
        let Some(image) = self.scene.oldest() else {
            return false;
        };
        self.remove_image_placements(term, image);
        if let Some(source) = self.scene.remove(image) {
            retire(&mut self.releases, source);
        }
        true
    }

    pub(super) fn clear_projection(&mut self) {
        self.projection_reset |= !self.projected.is_empty();
        self.projected = Vec::new();
        self.projected_leases = Vec::new();
        self.projected_storage = None;
        self.projection_workspace = None;
    }

    pub(in crate::pty::terminal) fn project(
        &mut self,
        term: &mut Term<EventForwarder>,
        columns: u16,
        rows: u16,
    ) -> [u64; ROWS.div_ceil(64)] {
        let mut damage = [0; ROWS.div_ceil(64)];
        // A full placeholder rebuild waits with a deferred projection; commands rebuild
        // on demand, and an existing index still consumes this chunk's grid damage.
        if !self.projection_deferred || self.placeholders.is_some() {
            self.refresh_placeholders(term);
        }
        if std::mem::take(&mut self.projection_reset) {
            damage.fill(u64::MAX);
        }
        // A deferred projection stays dirty: later chunks neither rerun its failed
        // admission nor refill damage before the owner loop resumes it.
        if !self.projection_dirty || self.projection_deferred {
            return damage;
        }
        self.projection_dirty = false;
        // Geometry authority exists before any placement can be admitted.
        let Some(viewport) = term.event_listener().viewport else {
            return damage;
        };
        // A viewport that states no cell pixels projects nothing, as an empty
        // scene does.
        let cell = match viewport.cell {
            Some(cell) if !self.placements.is_empty() && !self.scene.is_empty() => cell,
            _ => {
                for (row, previous) in self.projected.iter().enumerate() {
                    if !previous.is_empty() {
                        damage[row / 64] |= 1 << (row % 64);
                    }
                }
                self.clear_projection();
                return damage;
            }
        };
        assert!(usize::from(rows) <= ROWS, "validated terminal dimensions");
        let mut released = false;
        loop {
            let capacity = (self.placements.len()
                + self
                    .placeholders
                    .as_ref()
                    .map_or(0, |index| index.max_row()))
            .min(MAX_ROW_FRAGMENTS);
            if self.projected_storage.is_none()
                && let Some(lease) = self.storage.reserve(Usage {
                    bytes: ROWS * (size_of::<PreparedGraphics>() + size_of::<Option<Lease>>()),
                    objects: 2,
                })
            {
                self.projected = Vec::with_capacity(ROWS);
                self.projected_leases = Vec::with_capacity(ROWS);
                self.projected_storage = Some(lease);
            }
            if self
                .projection_workspace
                .as_ref()
                .is_some_and(|work| work.capacity < capacity)
            {
                self.projection_workspace = None;
            }
            if self.projection_workspace.is_none() {
                self.projection_workspace = Workspace::new(&self.storage, capacity);
            }
            if self.projected_storage.is_some() && self.projection_workspace.is_some() {
                break;
            }
            if !released {
                self.clear_projection();
                damage.fill(u64::MAX);
                released = true;
            } else if !self.evict_projection_source(term) || self.placements.is_empty() {
                self.clear_projection();
                damage.fill(u64::MAX);
                return damage;
            }
        }
        let mut work = self
            .projection_workspace
            .take()
            .expect("admitted workspace");
        let geometry = (columns, rows, cell);
        if work.geometry != Some(geometry) {
            work.geometry = Some(geometry);
            work.visibility.dirty.fill(true);
            self.placements.invalidate_all();
        }
        for id in self.placements.take_dirty() {
            let resolved = (|| {
                let placement = self.placements.get(id)?;
                if placement.origin == Origin::Virtual {
                    return None;
                }
                let source = self.scene.image(placement.image)?;
                let position = self.position(term, placement.id)?;
                let Ok(Some(geometry)) =
                    placement.layout.geometry(source.width, source.height, cell)
                else {
                    return None;
                };
                let clip = if let Origin::Direct(id) = placement.origin {
                    let clip = self.anchors.get(&id).and_then(GridAnchor::image_clip);
                    clip.and_then(|clip| {
                        CellRect::fixed(
                            0,
                            i128::from(position.line) * i128::from(CELL_UNIT)
                                + i128::from(clip.top),
                            i128::from(columns) * i128::from(CELL_UNIT),
                            i128::from(position.line) * i128::from(CELL_UNIT)
                                + i128::from(clip.bottom),
                        )
                    })
                } else {
                    None
                };
                let range =
                    geometry.visible_rows(position.column, position.line, columns, rows, clip);
                if range.is_empty() {
                    return None;
                }
                Some(Resolved {
                    id: placement.id,
                    projection: PlacementProjection {
                        content: merkur_graphics::scene::SceneContent::descriptor(&source.content),
                        stack: Stack {
                            z: placement.layout.z,
                            image_id: source.client_id,
                            placement: placement.id.0.get(),
                        },
                        geometry,
                        position,
                        clip,
                    },
                    first: range.start,
                    end: range.end,
                })
            })();
            match resolved {
                Some(entry) => work.visibility.put(entry),
                None => work.visibility.remove(id),
            }
        }
        for row in 0..ROWS {
            work.reusable[row] = !work.visibility.dirty[row];
        }
        work.sync_placeholders(self.placeholders.as_deref());
        if work.receiver_fits(columns, rows) {
            work.sweep(
                columns,
                rows,
                &self.projected,
                &mut self.projected_leases,
                None,
                self.placeholders.as_deref(),
            );
        }
        self.projection_workspace = Some(work);
        let mut reservation = loop {
            self.projection_workspace
                .as_mut()
                .expect("workspace")
                .sync_placeholders(self.placeholders.as_deref());
            if self
                .projection_workspace
                .as_ref()
                .expect("workspace")
                .receiver_fits(columns, rows)
                && let Some(reservation) = self.storage.reserve(
                    self.projection_workspace
                        .as_ref()
                        .expect("workspace")
                        .required(),
                )
            {
                break reservation;
            }
            if !released {
                // The projector's own rows go first: their charges are the only
                // storage a reproducible row holds, whoever still reads its bytes.
                self.projected.clear();
                self.projected_leases.clear();
                // Unused peak workspace is reproducible too. Rebuild it at the
                // current population before retiring any original source.
                if self
                    .projection_workspace
                    .as_ref()
                    .expect("workspace")
                    .capacity
                    > (self.placements.len()
                        + self
                            .placeholders
                            .as_ref()
                            .map_or(0, |index| index.max_row()))
                    .min(MAX_ROW_FRAGMENTS)
                {
                    self.projection_workspace = None;
                    self.projection_dirty = true;
                    self.project(term, columns, rows);
                    damage.fill(u64::MAX);
                    return damage;
                }
                self.projection_workspace
                    .as_mut()
                    .expect("workspace")
                    .reusable
                    .fill(false);
                damage.fill(u64::MAX);
                released = true;
            } else if !self.evict_projection_source(term) || self.placements.is_empty() {
                self.clear_projection();
                damage.fill(u64::MAX);
                return damage;
            }
        };
        let work = self.projection_workspace.as_mut().expect("workspace");
        work.sweep(
            columns,
            rows,
            &self.projected,
            &mut self.projected_leases,
            Some(&mut reservation),
            self.placeholders.as_deref(),
        );
        for row in 0..usize::from(rows) {
            if !work.reusable[row] {
                damage[row / 64] |= 1 << (row % 64);
            }
        }
        std::mem::swap(&mut self.projected, &mut work.staged);
        std::mem::swap(&mut self.projected_leases, &mut work.staged_leases);
        work.staged.clear();
        // Superseded rows refund here, while captures of them may still be in flight.
        work.staged_leases.clear();
        work.visibility.dirty.fill(false);
        if let Some(index) = &mut self.placeholders {
            index.changed.fill(false);
        }
        self.projection_dirty = false;
        self.projection_reset = false;
        damage
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use merkur_graphics::placements::Layout;

    fn entry(id: u64, z: i32, line: i64, height: u32) -> Resolved {
        let geometry = Layout {
            columns: 3,
            rows: height,
            z,
            ..Layout::default()
        }
        .geometry(4, 4, CellMetrics::new(8 << 16, 16 << 16).unwrap())
        .unwrap()
        .unwrap();
        let position = Position { column: 1, line };
        let range = geometry.visible_rows(1, line, 16, 8, None);
        Resolved {
            id: PlacementId(NonZeroU64::new(id).unwrap()),
            projection: PlacementProjection {
                content: Content {
                    kind: merkur_graphics::projection::ContentKind::Image,
                    root: [id as u8; 32],
                    width: 4,
                    height: 4,
                },
                stack: Stack {
                    z,
                    image_id: id as u32,
                    placement: id,
                },
                geometry,
                position,
                clip: None,
            },
            first: range.start,
            end: range.end,
        }
    }

    #[test]
    fn sweep_matches_independent_projection_and_reuses_unchanged_rows() {
        let budget = Budget::new(Usage {
            bytes: 1 << 20,
            objects: 128,
        });
        let mut workspace = Workspace::new(&budget, 4).unwrap();
        let mut entries = vec![
            entry(1, 4, 0, 3),
            entry(2, -1, -1, 5),
            entry(3, 4, 5, 2),
            entry(4, 0, 3, 5),
        ];
        entries.sort_unstable_by_key(|entry| entry.projection.stack);
        for entry in &entries {
            workspace.visibility.put(*entry);
        }
        workspace.sync_placeholders(None);
        workspace.sweep(16, 8, &[], &mut [], None, None);
        let mut reservation = budget.reserve(workspace.required()).unwrap();
        workspace.sweep(16, 8, &[], &mut [], Some(&mut reservation), None);
        drop(reservation);
        for row in 0..8 {
            let mut expected = Vec::new();
            for entry in &entries {
                expected.extend(
                    entry
                        .projection
                        .rows(16, 8)
                        .unwrap()
                        .filter(|(index, _)| *index == row)
                        .map(|(_, fragment)| fragment),
                );
            }
            assert!(workspace.staged[usize::from(row)].matches(16, &expected));
        }
        let _output = budget
            .reserve(Usage {
                bytes: ROWS * (size_of::<PreparedGraphics>() + size_of::<Option<Lease>>()),
                objects: 2,
            })
            .unwrap();
        let mut current = Vec::with_capacity(ROWS);
        let mut current_leases = Vec::with_capacity(ROWS);
        std::mem::swap(&mut current, &mut workspace.staged);
        std::mem::swap(&mut current_leases, &mut workspace.staged_leases);
        crate::edge_tunnel::test_allocations::begin_thread();
        workspace.sweep(16, 8, &current, &mut current_leases, None, None);
        let allocations = crate::edge_tunnel::test_allocations::end_thread();
        assert_eq!(allocations.allocations, 0);
        assert_eq!(
            workspace.required(),
            Usage {
                bytes: 0,
                objects: 0
            }
        );
        let mut reservation = budget.reserve(workspace.required()).unwrap();
        let charged = budget.used();
        workspace.sweep(16, 8, &current, &mut current_leases, Some(&mut reservation), None);
        // A reused row is the same allocation, version and charge: nothing is
        // re-minted and nothing is charged twice.
        for (old, new) in current.iter().zip(&workspace.staged) {
            assert_eq!(old.bytes().as_ptr(), new.bytes().as_ptr());
            assert_eq!(old.version(), new.version());
        }
        assert!(current_leases.iter().all(Option::is_none));
        assert_eq!(budget.used(), charged);
        workspace.staged.clear();
        workspace.visibility.dirty.fill(false);
        workspace.remove(PlacementId(NonZeroU64::new(2).unwrap()));
        entries.retain(|entry| entry.id.0.get() != 2);
        let bound = workspace.required();
        assert!(bound.bytes > 0);
        assert!(workspace.reusable[4..8].iter().all(|value| *value));
        let mut reservation = budget.reserve(bound).unwrap();
        workspace.sweep(16, 8, &current, &mut current_leases, Some(&mut reservation), None);
        for row in 0..8 {
            let expected: Vec<_> = entries
                .iter()
                .flat_map(|entry| entry.projection.rows(16, 8).unwrap())
                .filter(|(index, _)| *index == row)
                .map(|(_, fragment)| fragment)
                .collect();
            assert!(workspace.staged[usize::from(row)].matches(16, &expected));
        }
    }

    #[test]
    fn complete_snapshot_admission_limits_total_rows() {
        let budget = Budget::new(Usage {
            bytes: 1 << 20,
            objects: 128,
        });
        let mut workspace = Workspace::new(&budget, 1).unwrap();
        workspace.counts[0] = MAX_ROW_FRAGMENTS;
        assert!(workspace.receiver_fits(384, 256));
        workspace.counts.fill(MAX_ROW_FRAGMENTS);
        assert!(!workspace.receiver_fits(384, 256));
        assert!(!workspace.receiver_fits(513, 1));
    }

    #[test]
    fn maximum_population_sweep_handles_bitset_boundaries_and_retired_slots() {
        let budget = Budget::new(Usage {
            bytes: 32 << 20,
            objects: 1024,
        });
        let mut workspace = Workspace::new(&budget, MAX_ROW_FRAGMENTS).unwrap();
        let mut entries: Vec<_> = (1..=MAX_ROW_FRAGMENTS as u64)
            .map(|id| entry(id, (id % 7) as i32 - 3, (id % 8) as i64, 1))
            .collect();
        entries.sort_unstable_by_key(|entry| entry.projection.stack);
        for entry in &entries {
            workspace.visibility.put(*entry);
        }
        for slot in [0, 63, 64, 127, 128, 4095, 4096, 8190, 8191] {
            let id = entries[slot].id;
            workspace.remove(id);
            workspace.remove(id);
        }
        entries = entries
            .into_iter()
            .enumerate()
            .filter(|(slot, _)| ![0, 63, 64, 127, 128, 4095, 4096, 8190, 8191].contains(slot))
            .map(|(_, entry)| entry)
            .collect();
        workspace.sync_placeholders(None);
        workspace.sweep(16, 8, &[], &mut [], None, None);
        assert!(workspace.receiver_fits(16, 8));
        let mut reservation = budget.reserve(workspace.required()).unwrap();
        workspace.sweep(16, 8, &[], &mut [], Some(&mut reservation), None);
        for row in 0..8 {
            let expected: Vec<_> = entries
                .iter()
                .flat_map(|entry| entry.projection.rows(16, 8).unwrap())
                .filter(|(index, _)| *index == row)
                .map(|(_, fragment)| fragment)
                .collect();
            assert_eq!(expected.len(), workspace.counts[usize::from(row)]);
            assert!(workspace.staged[usize::from(row)].matches(16, &expected));
        }
        drop(reservation);
        drop(workspace);
        assert_eq!(
            budget.used(),
            Some(Usage {
                bytes: 0,
                objects: 0
            })
        );
    }
}
