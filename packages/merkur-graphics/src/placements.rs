//! Placement dependencies and reverse indices, owned by the terminal scene.
//!
//! No viewport coordinate is an identity. Grid mutation supplies stable cell
//! anchors; projection resolves those anchors and emits immutable row fragments.

use std::collections::{BTreeMap, BTreeSet};
use std::num::NonZeroU64;

use crate::budget::{Budget, Lease, Usage};
use crate::command::{Action, Control, Error, Key};
use crate::publication::ImageIncarnation;

/// Resource limit, including the root. Kitty requires at least eight levels.
pub const MAX_DEPENDENCY_DEPTH: usize = 64;
/// Includes the node, reverse indices, child-height counts, edges and temporary
/// traversal storage. Each parent edge is charged to its child exactly once.
pub const PLACEMENT_METADATA_BYTES: usize = 4096;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct PlacementId(pub NonZeroU64);

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct AnchorId(pub NonZeroU64);

/// Resolved at projection time from the grid-owned attachment. Both coordinates
/// can change during reflow; storing a column alongside an identity goes stale.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Position {
    pub column: i64,
    pub line: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Origin {
    Direct(AnchorId),
    Virtual,
    Relative {
        parent: PlacementId,
        columns: i32,
        rows: i32,
    },
}

impl Origin {
    fn parent(self) -> Option<PlacementId> {
        match self {
            Self::Relative { parent, .. } => Some(parent),
            _ => None,
        }
    }
    fn anchor(self) -> Option<AnchorId> {
        match self {
            Self::Direct(anchor) => Some(anchor),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Layout {
    pub source_x: u32,
    pub source_y: u32,
    /// Zero selects the remaining source extent.
    pub source_width: u32,
    pub source_height: u32,
    /// Zero preserves the source size/aspect ratio along this dimension.
    pub columns: u32,
    pub rows: u32,
    pub offset_x: u32,
    pub offset_y: u32,
    pub z: i32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PlacementOrigin {
    Cursor,
    Virtual,
    Relative {
        image_id: u32,
        placement_id: u32,
        columns: i32,
        rows: i32,
    },
}

/// Validated command intent, before allocating a grid attachment or mutating the
/// dependency graph. Image/parent lookup and geometry use the owner's live state.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PlacementRequest {
    pub client_id: u32,
    pub origin: PlacementOrigin,
    pub layout: Layout,
    pub move_cursor: bool,
}

impl PlacementRequest {
    pub fn from_control(control: &Control) -> Result<Self, Error> {
        if !matches!(control.action()?, Action::Place | Action::TransmitAndPlace) {
            return Err(Error::UnsupportedAction);
        }
        if control.get(Key::ImageId).is_some() && control.get(Key::ImageNumber).is_some() {
            return Err(Error::InvalidControl);
        }
        let virtual_placement = match control.get(Key::Virtual).unwrap_or(0) {
            0 => false,
            1 => true,
            _ => return Err(Error::InvalidControl),
        };
        let move_cursor = match control.get(Key::Cursor).unwrap_or(0) {
            0 => true,
            1 => false,
            _ => return Err(Error::InvalidControl),
        };
        let parent_image = control.get(Key::ParentImage).unwrap_or(0);
        let origin = match (virtual_placement, parent_image) {
            (true, 0) => PlacementOrigin::Virtual,
            (true, _) => return Err(Error::InvalidControl),
            (false, 0) => PlacementOrigin::Cursor,
            (false, image_id) => PlacementOrigin::Relative {
                image_id,
                placement_id: control.get(Key::ParentPlacement).unwrap_or(0),
                columns: control.signed(Key::ParentX).unwrap_or(0),
                rows: control.signed(Key::ParentY).unwrap_or(0),
            },
        };
        Ok(Self {
            client_id: control.get(Key::PlacementId).unwrap_or(0),
            origin,
            move_cursor: move_cursor && origin == PlacementOrigin::Cursor,
            layout: Layout {
                source_x: control.get(Key::SourceX).unwrap_or(0),
                source_y: control.get(Key::SourceY).unwrap_or(0),
                source_width: control.get(Key::SourceWidth).unwrap_or(0),
                source_height: control.get(Key::SourceHeight).unwrap_or(0),
                columns: control.get(Key::Columns).unwrap_or(0),
                rows: control.get(Key::Rows).unwrap_or(0),
                offset_x: control.get(Key::CellX).unwrap_or(0),
                offset_y: control.get(Key::CellY).unwrap_or(0),
                z: control.signed(Key::Z).unwrap_or(0),
            },
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Placement {
    pub id: PlacementId,
    pub image: ImageIncarnation,
    pub client_id: u32,
    pub origin: Origin,
    pub layout: Layout,
}

struct Node {
    placement: Placement,
    children: BTreeSet<PlacementId>,
    /// Height counts avoid rescanning a large sibling set when one child moves.
    child_heights: [u32; MAX_DEPENDENCY_DEPTH + 1],
    height: usize,
    _metadata: Lease,
}

/// Retired geometry retains its metadata reservation until damage propagation
/// consumes it. A held removal batch cannot admit an uncharged successor batch.
pub struct RemovedPlacement {
    placement: Placement,
    metadata: Lease,
}

impl RemovedPlacement {
    /// The reservation, handed to the successor placement it already admits
    /// (`Placements::put_admitted`) instead of being refunded.
    pub fn into_metadata(self) -> Lease {
        self.metadata
    }
}

impl std::ops::Deref for RemovedPlacement {
    type Target = Placement;
    fn deref(&self) -> &Placement {
        &self.placement
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PlacementError {
    MissingParent,
    Cycle,
    TooDeep,
    Quota,
    IdentityExhausted,
}

pub struct Placements {
    // Box large nodes: spare B-tree slots must not each reserve the complete
    // dependency-height array. The 4 KiB charge covers the box, sparse tree
    // nodes for all indices/edges, a grid attachment and traversal/removal work.
    nodes: BTreeMap<PlacementId, Box<Node>>,
    clients: BTreeMap<(ImageIncarnation, u32), PlacementId>,
    images: BTreeMap<ImageIncarnation, BTreeSet<PlacementId>>,
    anchors: BTreeMap<AnchorId, BTreeSet<PlacementId>>,
    virtuals: BTreeSet<PlacementId>,
    dirty: BTreeSet<PlacementId>,
    budget: Budget,
    last_id: u64,
}

impl Placements {
    pub fn new(budget: Budget) -> Self {
        Self {
            nodes: BTreeMap::new(),
            clients: BTreeMap::new(),
            images: BTreeMap::new(),
            anchors: BTreeMap::new(),
            virtuals: BTreeSet::new(),
            dirty: BTreeSet::new(),
            budget,
            last_id: 0,
        }
    }

    pub fn get(&self, id: PlacementId) -> Option<&Placement> {
        self.nodes.get(&id).map(|node| &node.placement)
    }
    pub fn len(&self) -> usize {
        self.nodes.len()
    }
    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty()
    }
    pub fn iter(&self) -> impl Iterator<Item = &Placement> {
        self.nodes.values().map(|node| &node.placement)
    }

    pub fn virtuals(&self) -> impl ExactSizeIterator<Item = PlacementId> + '_ {
        self.virtuals.iter().copied()
    }

    /// An omitted placeholder placement ID selects only among virtual prototypes,
    /// even when the image also has newer direct or relative placements.
    pub fn resolve_virtual(&self, image: ImageIncarnation, client_id: u32) -> Option<PlacementId> {
        if client_id != 0 {
            self.resolve(image, client_id)
                .filter(|id| self.virtuals.contains(id))
        } else {
            self.images
                .get(&image)?
                .iter()
                .rev()
                .copied()
                .find(|id| self.virtuals.contains(id))
        }
    }

    pub fn image_placements(
        &self,
        image: ImageIncarnation,
    ) -> impl Iterator<Item = PlacementId> + '_ {
        self.images
            .get(&image)
            .into_iter()
            .flat_map(|entries| entries.iter().copied())
    }
    pub fn anchored(&self, anchor: AnchorId) -> impl Iterator<Item = PlacementId> + '_ {
        self.anchors
            .get(&anchor)
            .into_iter()
            .flat_map(|entries| entries.iter().copied())
    }
    pub fn resolve(&self, image: ImageIncarnation, client_id: u32) -> Option<PlacementId> {
        if client_id != 0 {
            self.clients.get(&(image, client_id)).copied()
        } else {
            // Kitty leaves selection among anonymous placements unspecified.
            // Resolve the newest live placement deterministically.
            self.images
                .get(&image)
                .and_then(|entries| entries.last().copied())
        }
    }

    /// Resolve one dependency chain without allocating or consulting cached
    /// viewport coordinates. A virtual parent's position is the independent
    /// minimum column and line of its current placeholder instances, supplied
    /// by the owner of the placeholder reverse index. An absent/retired root
    /// makes the whole chain invisible. Pixel padding does not shift this cell
    /// origin, including through intermediate relative placements.
    pub fn position(
        &self,
        mut id: PlacementId,
        direct: impl FnOnce(AnchorId) -> Option<Position>,
        virtual_origin: impl FnOnce(PlacementId) -> Option<Position>,
    ) -> Option<Position> {
        let mut columns = 0i64;
        let mut rows = 0i64;
        let root = loop {
            match self.get(id)?.origin {
                Origin::Direct(anchor) => break direct(anchor)?,
                Origin::Virtual => break virtual_origin(id)?,
                Origin::Relative {
                    parent,
                    columns: x,
                    rows: y,
                } => {
                    columns = columns.checked_add(i64::from(x))?;
                    rows = rows.checked_add(i64::from(y))?;
                    id = parent;
                }
            }
        };
        Some(Position {
            column: root.column.checked_add(columns)?,
            line: root.line.checked_add(rows)?,
        })
    }

    /// Replacing (image, nonzero placement ID) keeps descendants attached. All
    /// validation precedes mutation, including the depth of the existing subtree.
    pub fn put(
        &mut self,
        image: ImageIncarnation,
        client_id: u32,
        origin: Origin,
        layout: Layout,
    ) -> Result<PlacementId, PlacementError> {
        self.insert(image, client_id, origin, layout, None)
    }

    /// `put`, with a new placement's metadata admitted by the caller beforehand:
    /// a caller that must not be refused storage after an irreversible step admits
    /// it first. A replaced placement needs none, and the lease returns.
    pub fn put_admitted(
        &mut self,
        image: ImageIncarnation,
        client_id: u32,
        origin: Origin,
        layout: Layout,
        metadata: Lease,
    ) -> Result<PlacementId, PlacementError> {
        self.insert(image, client_id, origin, layout, Some(metadata))
    }

    fn insert(
        &mut self,
        image: ImageIncarnation,
        client_id: u32,
        origin: Origin,
        layout: Layout,
        admitted: Option<Lease>,
    ) -> Result<PlacementId, PlacementError> {
        let existing = (client_id != 0)
            .then(|| self.clients.get(&(image, client_id)).copied())
            .flatten();
        let height = existing
            .and_then(|id| self.nodes.get(&id).map(|node| node.height))
            .unwrap_or(1);
        let mut parent = origin.parent();
        let mut depth = 0;
        while let Some(id) = parent {
            if Some(id) == existing {
                return Err(PlacementError::Cycle);
            }
            let node = self.nodes.get(&id).ok_or(PlacementError::MissingParent)?;
            depth += 1;
            parent = node.placement.origin.parent();
        }
        if depth + height > MAX_DEPENDENCY_DEPTH {
            return Err(PlacementError::TooDeep);
        }
        let id = if let Some(id) = existing {
            let old = self.nodes[&id].placement;
            self.detach(id, old.origin, height);
            let node = self.nodes.get_mut(&id).expect("existing placement");
            node.placement.origin = origin;
            node.placement.layout = layout;
            id
        } else {
            let metadata = match admitted {
                Some(metadata) => metadata,
                None => self
                    .budget
                    .reserve(Usage {
                        bytes: PLACEMENT_METADATA_BYTES,
                        objects: 1,
                    })
                    .ok_or(PlacementError::Quota)?,
            };
            let next = self
                .last_id
                .checked_add(1)
                .and_then(NonZeroU64::new)
                .ok_or(PlacementError::IdentityExhausted)?;
            self.last_id = next.get();
            let id = PlacementId(next);
            self.nodes.insert(
                id,
                Box::new(Node {
                    placement: Placement {
                        id,
                        image,
                        client_id,
                        origin,
                        layout,
                    },
                    children: BTreeSet::new(),
                    child_heights: [0; MAX_DEPENDENCY_DEPTH + 1],
                    height: 1,
                    _metadata: metadata,
                }),
            );
            self.images.entry(image).or_default().insert(id);
            if client_id != 0 {
                self.clients.insert((image, client_id), id);
            }
            id
        };
        self.attach(id, origin, height);
        self.invalidate(id);
        Ok(id)
    }

    fn detach(&mut self, id: PlacementId, origin: Origin, height: usize) {
        if origin == Origin::Virtual {
            self.virtuals.remove(&id);
        }
        if let Some(parent) = origin.parent() {
            if let Some(node) = self.nodes.get_mut(&parent) {
                node.children.remove(&id);
            }
            self.adjust_height(parent, Some(height), None);
        }
        if let Some(anchor) = origin.anchor() {
            remove_index(&mut self.anchors, anchor, id);
        }
    }

    fn attach(&mut self, id: PlacementId, origin: Origin, height: usize) {
        if origin == Origin::Virtual {
            self.virtuals.insert(id);
        }
        if let Some(parent) = origin.parent() {
            self.nodes
                .get_mut(&parent)
                .expect("validated parent")
                .children
                .insert(id);
            self.adjust_height(parent, None, Some(height));
        }
        if let Some(anchor) = origin.anchor() {
            self.anchors.entry(anchor).or_default().insert(id);
        }
    }

    fn adjust_height(
        &mut self,
        mut id: PlacementId,
        mut old: Option<usize>,
        mut new: Option<usize>,
    ) {
        loop {
            let Some(node) = self.nodes.get_mut(&id) else {
                return;
            };
            if let Some(height) = old {
                node.child_heights[height] -= 1;
            }
            if let Some(height) = new {
                node.child_heights[height] += 1;
            }
            let previous = node.height;
            node.height = node
                .child_heights
                .iter()
                .rposition(|count| *count != 0)
                .unwrap_or(0)
                + 1;
            if previous == node.height {
                return;
            }
            let Some(parent) = node.placement.origin.parent() else {
                return;
            };
            old = Some(previous);
            new = Some(node.height);
            id = parent;
        }
    }

    /// Geometry changes invalidate exactly this dependency subtree.
    pub fn invalidate(&mut self, id: PlacementId) {
        Self::invalidate_subtree(&self.nodes, &mut self.dirty, id);
    }

    /// A grid attachment can own several roots, each with relative descendants.
    pub fn invalidate_anchor(&mut self, anchor: AnchorId) {
        if let Some(roots) = self.anchors.get(&anchor) {
            for id in roots {
                Self::invalidate_subtree(&self.nodes, &mut self.dirty, *id);
            }
        }
    }

    /// Content edits affect the image's projections, without moving its anchors.
    pub fn invalidate_image(&mut self, image: ImageIncarnation) {
        if let Some(placements) = self.images.get(&image) {
            self.dirty.extend(placements.iter().copied());
        }
    }

    pub fn invalidate_all(&mut self) {
        self.dirty.extend(self.nodes.keys().copied());
    }

    fn invalidate_subtree(
        nodes: &BTreeMap<PlacementId, Box<Node>>,
        dirty: &mut BTreeSet<PlacementId>,
        id: PlacementId,
    ) {
        let Some(root) = nodes.get(&id) else {
            return;
        };
        // Depth is checked on admission; width needs no traversal allocation.
        let mut stack = [const { None }; MAX_DEPENDENCY_DEPTH];
        let mut depth = 1;
        stack[0] = Some(root.children.iter());
        dirty.insert(id);
        while depth != 0 {
            match stack[depth - 1].as_mut().and_then(Iterator::next) {
                Some(id) => {
                    // An already-dirty parent can have a newly attached child.
                    dirty.insert(*id);
                    let node = nodes.get(id).expect("indexed child");
                    if !node.children.is_empty() {
                        stack[depth] = Some(node.children.iter());
                        depth += 1;
                    }
                }
                None => depth -= 1,
            }
        }
    }

    /// Inspect the shared dependency damage before the projector consumes it.
    pub fn dirty(&self) -> impl Iterator<Item = PlacementId> + '_ {
        self.dirty.iter().copied()
    }

    pub fn take_dirty(&mut self) -> BTreeSet<PlacementId> {
        std::mem::take(&mut self.dirty)
    }

    /// Removes a dependency subtree without allocating traversal or result storage.
    /// The callback owns each removed geometry's lease and learns whether that
    /// image still has a placement after this removal. Parents precede children.
    pub fn remove(&mut self, root: PlacementId, mut removed: impl FnMut(RemovedPlacement, bool)) {
        let Some(node) = self.nodes.get(&root) else {
            return;
        };
        let origin = node.placement.origin;
        let height = node.height;
        self.detach(root, origin, height);
        // Move each admitted child set onto the bounded stack. Every parent edge
        // remains charged to its child until that child is removed.
        let mut stack: [BTreeSet<PlacementId>; MAX_DEPENDENCY_DEPTH] =
            std::array::from_fn(|_| BTreeSet::new());
        let mut depth = 0;
        let mut next = Some(root);
        while let Some(id) = next {
            let node = *self.nodes.remove(&id).expect("indexed child");
            if !node.children.is_empty() {
                stack[depth] = node.children;
                depth += 1;
            }
            let placement = node.placement;
            if placement.client_id != 0 {
                self.clients.remove(&(placement.image, placement.client_id));
            }
            remove_index(&mut self.images, placement.image, id);
            if let Some(anchor) = placement.origin.anchor() {
                remove_index(&mut self.anchors, anchor, id);
            }
            self.dirty.remove(&id);
            removed(
                RemovedPlacement {
                    placement,
                    metadata: node._metadata,
                },
                self.images.contains_key(&placement.image),
            );
            next = None;
            while depth != 0 {
                if let Some(id) = stack[depth - 1].pop_first() {
                    next = Some(id);
                    break;
                }
                depth -= 1;
            }
        }
        if self.nodes.is_empty() {
            self.clear();
        }
    }

    /// Identity counters survive a screen reset, so old projections cannot be
    /// mistaken for a newly created placement in the same terminal incarnation.
    pub fn clear(&mut self) {
        // Release sparse/empty tree storage before refunding the owning leases.
        self.clients = BTreeMap::new();
        self.images = BTreeMap::new();
        self.anchors = BTreeMap::new();
        self.virtuals = BTreeSet::new();
        self.dirty = BTreeSet::new();
        self.nodes = BTreeMap::new();
    }
}

impl Drop for Placements {
    fn drop(&mut self) {
        self.clear();
    }
}

fn remove_index<K: Ord + Copy>(
    index: &mut BTreeMap<K, BTreeSet<PlacementId>>,
    key: K,
    id: PlacementId,
) {
    if let Some(entries) = index.get_mut(&key) {
        entries.remove(&id);
        if entries.is_empty() {
            index.remove(&key);
        }
    }
}
