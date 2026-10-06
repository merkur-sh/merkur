//! Persistent, stack-ordered AVL index with exact subtree row membership.
//! A row query skips every subtree with no member on that row. Updates visit
//! only the changed placement's search path; unchanged geometry is never resolved.

use super::*;
use merkur_graphics::projection::{PlacementProjection, Stack};

pub(super) const ROWS: usize = crate::pty::dimensions::MAX_TERMINAL_ROWS as usize;
const WORDS: usize = ROWS.div_ceil(64);
const NONE: usize = usize::MAX;

#[derive(Clone, Copy)]
pub(super) struct Entry {
    pub id: PlacementId,
    pub projection: PlacementProjection,
    pub first: u16,
    pub end: u16,
}

struct Node {
    entry: Entry,
    children: [usize; 2],
    height: u8,
    own_rows: [u64; WORDS],
    rows: [u64; WORDS],
}

pub(super) struct Index {
    nodes: Vec<Node>,
    free: Vec<usize>,
    by_id: BTreeMap<PlacementId, usize>,
    root: usize,
    capacity: usize,
    pub counts: [usize; ROWS],
    pub dirty: [bool; ROWS],
}

impl Index {
    pub fn reservation_bytes(capacity: usize) -> usize {
        // Three pre-admitted stores. 512 bytes per map entry covers even sparse
        // B-tree nodes, including the root; no per-edit workspace is allocated.
        capacity * (size_of::<Node>() + size_of::<usize>() + 512)
    }

    pub fn new(capacity: usize) -> Self {
        Self {
            nodes: Vec::with_capacity(capacity),
            free: Vec::with_capacity(capacity),
            by_id: BTreeMap::new(),
            root: NONE,
            capacity,
            counts: [0; ROWS],
            dirty: [true; ROWS],
        }
    }

    fn height(&self, slot: usize) -> u8 {
        if slot == NONE {
            0
        } else {
            self.nodes[slot].height
        }
    }

    fn refresh(&mut self, slot: usize) {
        let [left, right] = self.nodes[slot].children;
        let height = self.height(left).max(self.height(right)) + 1;
        let mut rows = self.nodes[slot].own_rows;
        for child in [left, right] {
            if child != NONE {
                for (out, value) in rows.iter_mut().zip(self.nodes[child].rows) {
                    *out |= value;
                }
            }
        }
        self.nodes[slot].height = height;
        self.nodes[slot].rows = rows;
    }

    fn rotate(&mut self, root: usize, side: usize) -> usize {
        let next = self.nodes[root].children[side];
        self.nodes[root].children[side] = self.nodes[next].children[1 - side];
        self.nodes[next].children[1 - side] = root;
        self.refresh(root);
        self.refresh(next);
        next
    }

    fn balance(&mut self, root: usize) -> usize {
        self.refresh(root);
        let [left, right] = self.nodes[root].children;
        let side = if self.height(left) > self.height(right) + 1 {
            0
        } else if self.height(right) > self.height(left) + 1 {
            1
        } else {
            return root;
        };
        let child = self.nodes[root].children[side];
        let links = self.nodes[child].children;
        if self.height(links[side]) < self.height(links[1 - side]) {
            self.nodes[root].children[side] = self.rotate(child, 1 - side);
        }
        self.rotate(root, side)
    }

    fn insert_at(&mut self, root: usize, slot: usize) -> usize {
        if root == NONE {
            self.refresh(slot);
            return slot;
        }
        let side = usize::from(
            self.nodes[slot].entry.projection.stack > self.nodes[root].entry.projection.stack,
        );
        self.nodes[root].children[side] = self.insert_at(self.nodes[root].children[side], slot);
        self.balance(root)
    }

    fn take_first(&mut self, root: usize) -> (usize, usize) {
        let left = self.nodes[root].children[0];
        if left == NONE {
            return (self.nodes[root].children[1], root);
        }
        let (left, first) = self.take_first(left);
        self.nodes[root].children[0] = left;
        (self.balance(root), first)
    }

    fn remove_at(&mut self, root: usize, key: Stack) -> usize {
        debug_assert_ne!(root, NONE, "reverse-indexed member");
        let entry = self.nodes[root].entry;
        if key != entry.projection.stack {
            let side = usize::from(key > entry.projection.stack);
            self.nodes[root].children[side] = self.remove_at(self.nodes[root].children[side], key);
            return self.balance(root);
        }
        let [left, right] = self.nodes[root].children;
        if right == NONE {
            return left;
        }
        let (right, successor) = self.take_first(right);
        self.nodes[successor].children = [left, right];
        self.balance(successor)
    }

    fn subtract(&mut self, slot: usize) {
        let entry = self.nodes[slot].entry;
        self.root = self.remove_at(self.root, entry.projection.stack);
        for row in usize::from(entry.first)..usize::from(entry.end) {
            self.counts[row] -= 1;
            self.dirty[row] = true;
        }
    }

    pub fn remove(&mut self, id: PlacementId) {
        if let Some(slot) = self.by_id.remove(&id) {
            self.subtract(slot);
            self.free.push(slot);
        }
    }

    pub fn put(&mut self, entry: Entry) {
        assert!(entry.first < entry.end && usize::from(entry.end) <= ROWS);
        let slot = if let Some(slot) = self.by_id.get(&entry.id).copied() {
            self.subtract(slot);
            slot
        } else {
            let slot = self.free.pop().unwrap_or(self.nodes.len());
            assert!(slot < self.capacity, "pre-admitted visibility population");
            self.by_id.insert(entry.id, slot);
            slot
        };
        let mut own_rows = [0; WORDS];
        for row in usize::from(entry.first)..usize::from(entry.end) {
            own_rows[row / 64] |= 1 << (row % 64);
        }
        let node = Node {
            entry,
            children: [NONE; 2],
            height: 1,
            own_rows,
            rows: [0; WORDS],
        };
        if slot == self.nodes.len() {
            self.nodes.push(node);
        } else {
            self.nodes[slot] = node;
        }
        self.root = self.insert_at(self.root, slot);
        for row in usize::from(entry.first)..usize::from(entry.end) {
            self.counts[row] += 1;
            self.dirty[row] = true;
        }
    }

    pub fn visit(&self, row: usize, mut emit: impl FnMut(PlacementProjection)) {
        self.visit_at(self.root, row, &mut emit);
    }

    fn visit_at(&self, slot: usize, row: usize, emit: &mut impl FnMut(PlacementProjection)) {
        if slot == NONE {
            return;
        }
        let node = &self.nodes[slot];
        if node.rows[row / 64] & (1 << (row % 64)) == 0 {
            return;
        }
        self.visit_at(node.children[0], row, emit);
        if usize::from(node.entry.first) <= row && row < usize::from(node.entry.end) {
            emit(node.entry.projection);
        }
        self.visit_at(node.children[1], row, emit);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use merkur_graphics::placements::Layout;
    use merkur_graphics::projection::{Content, MAX_ROW_FRAGMENTS};

    fn entry(id: u64, z: i32, row: u16) -> Entry {
        Entry {
            id: PlacementId(NonZeroU64::new(id).unwrap()),
            projection: PlacementProjection {
                content: Content {
                    kind: merkur_graphics::projection::ContentKind::Image,
                    root: [0; 32],
                    width: 1,
                    height: 1,
                },
                stack: Stack {
                    z,
                    image_id: id as u32,
                    placement: id,
                },
                geometry: Layout {
                    columns: 1,
                    rows: 1,
                    ..Layout::default()
                }
                .geometry(1, 1, CellMetrics::new(8 << 16, 16 << 16).unwrap())
                .unwrap()
                .unwrap(),
                position: Position {
                    column: 0,
                    line: i64::from(row),
                },
                clip: None,
            },
            first: row,
            end: row + 1,
        }
    }

    fn audit(index: &Index, slot: usize) -> (u8, [u64; WORDS]) {
        if slot == NONE {
            return (0, [0; WORDS]);
        }
        let node = &index.nodes[slot];
        let (left, a) = audit(index, node.children[0]);
        let (right, b) = audit(index, node.children[1]);
        assert!(left.abs_diff(right) <= 1);
        assert_eq!(node.height, left.max(right) + 1);
        let mut rows = std::array::from_fn(|word| a[word] | b[word]);
        for row in node.entry.first..node.entry.end {
            rows[usize::from(row) / 64] |= 1 << (row % 64);
        }
        assert_eq!(node.rows, rows);
        (node.height, rows)
    }

    #[test]
    fn all_physical_index_allocations_fit_the_admitted_storage() {
        for capacity in [1, 12, 64, MAX_ROW_FRAGMENTS] {
            crate::edge_tunnel::test_allocations::begin_thread();
            let mut index = Index::new(capacity);
            for id in 1..=capacity as u64 {
                index.put(entry(id, 0, 0));
            }
            let allocations = crate::edge_tunnel::test_allocations::end_thread();
            assert!(allocations.allocated_bytes <= Index::reservation_bytes(capacity));
            audit(&index, index.root);
        }
    }

    #[test]
    fn maximum_population_updates_keep_exact_order_masks_and_zero_edit_allocations() {
        let mut index = Index::new(MAX_ROW_FRAGMENTS);
        let mut expected = BTreeMap::new();
        for id in 1..=MAX_ROW_FRAGMENTS as u64 {
            let entry = entry(id, (id % 17) as i32 - 8, (id % ROWS as u64) as u16);
            index.put(entry);
            expected.insert(entry.id, entry);
        }
        audit(&index, index.root);
        // Change both z order and row membership without changing population.
        crate::edge_tunnel::test_allocations::begin_thread();
        for id in 1..=1024 {
            let entry = entry(id, 20 - id as i32, ((id * 7) % ROWS as u64) as u16);
            index.put(entry);
            *expected.get_mut(&entry.id).unwrap() = entry;
        }
        let allocations = crate::edge_tunnel::test_allocations::end_thread();
        assert_eq!(allocations.allocations, 0);
        audit(&index, index.root);
        // Remove internal nodes and recycle their slots, exercising successor
        // extraction, rotations, and stale reverse-index removal together.
        for id in (1..=MAX_ROW_FRAGMENTS as u64).step_by(3) {
            let id = PlacementId(NonZeroU64::new(id).unwrap());
            index.remove(id);
            index.remove(id);
            expected.remove(&id);
        }
        audit(&index, index.root);
        for id in 1..=500 {
            let entry = entry(
                MAX_ROW_FRAGMENTS as u64 + id,
                id as i32,
                (id % ROWS as u64) as u16,
            );
            index.put(entry);
            expected.insert(entry.id, entry);
        }
        audit(&index, index.root);
        for row in 0..ROWS {
            let mut actual = Vec::new();
            index.visit(row, |projection| actual.push(projection.stack));
            let mut wanted: Vec<_> = expected
                .values()
                .filter(|entry| usize::from(entry.first) <= row && row < usize::from(entry.end))
                .map(|entry| entry.projection.stack)
                .collect();
            wanted.sort_unstable();
            assert_eq!(actual, wanted);
            assert_eq!(actual.len(), index.counts[row]);
        }
    }

    #[test]
    fn mutations_damage_only_old_and_new_visibility_and_reject_over_admission() {
        let mut index = Index::new(2);
        index.put(entry(1, 0, 3));
        index.put(entry(2, 1, 90));
        index.dirty.fill(false);
        index.put(entry(1, -1, 65));
        let changed: Vec<_> = index
            .dirty
            .iter()
            .enumerate()
            .filter_map(|(row, dirty)| dirty.then_some(row))
            .collect();
        assert_eq!(changed, [3, 65]);
        assert!(
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                index.put(entry(3, 0, 1));
            }))
            .is_err()
        );
        // Refused admission must not mutate the existing search tree.
        audit(&index, index.root);
        assert_eq!(index.by_id.len(), 2);
    }
}
