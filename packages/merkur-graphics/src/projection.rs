//! Immutable, independently applicable graphics row descriptions.
//!
//! These describe authority, never texture residency. A retained row owns only
//! descriptors: keeping repair or presentation state alive cannot pin pixels.
//! Asset authorization and availability are separate from this representation.

use std::sync::Arc;

use crate::budget::{Budget, Lease, Usage};
use crate::geometry::{CELL_UNIT, CellRect, Geometry, Layer, RowSlice};
use crate::placements::Position;
use crate::processing::pixel_bytes;

/// Resource bound on one absolute row replacement. This admits 8192 overlapping
/// placements; it is not a datagram budget. The display owner must also charge
/// aggregate retained bytes and route oversized replacements atomically.
pub const MAX_ROW_FRAGMENTS: usize = 8192;

/// One viewport can coexist as received, presentation-eligible and newly prepared
/// authority. Native admission and receiver accounting use the same resource fact.
pub const RETAINED_GRAPHICS_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_VIEWPORT_GRAPHICS_BYTES: usize = RETAINED_GRAPHICS_BYTES / 3;

/// Canonical descriptor encoding: root[32], kind:u16, width:u16, height:u32, z:i32,
/// image_id:u32, placement:u64, then the eight RowSlice u64 fields. Integers
/// are big-endian. There is no native padding, pointer, asset or cache state.
pub const FRAGMENT_BYTES: usize = 120;

/// An immutable manifest commitment and its sampling domain. The asset owner
/// must verify the manifest's dimensions against these before supplying pixels.
/// A digest is an identity, not permission to fetch another terminal's content.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Content {
    pub root: [u8; 32],
    pub kind: ContentKind,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[repr(u16)]
pub enum ContentKind {
    Image = 0,
    Animation = 1,
}

impl Content {
    pub fn encode(self) -> [u8; 40] {
        let mut bytes = [0; 40];
        bytes[..32].copy_from_slice(&self.root);
        bytes[32..34].copy_from_slice(&(self.kind as u16).to_be_bytes());
        bytes[34..36].copy_from_slice(&(self.width as u16).to_be_bytes());
        bytes[36..40].copy_from_slice(&self.height.to_be_bytes());
        bytes
    }

    pub fn decode(bytes: &[u8; 40]) -> Option<Self> {
        let kind = match u16::from_be_bytes(bytes[32..34].try_into().ok()?) {
            0 => ContentKind::Image,
            1 => ContentKind::Animation,
            _ => return None,
        };
        let width = u32::from(u16::from_be_bytes(bytes[34..36].try_into().ok()?));
        let height = u32::from_be_bytes(bytes[36..40].try_into().ok()?);
        pixel_bytes(width, height, 4)?;
        Some(Self {
            root: bytes[..32].try_into().ok()?,
            width,
            height,
            kind,
        })
    }
}

/// Kitty orders equal-z images by image ID. Equal-z, equal-image order is
/// unspecified by Kitty; Merkur uses its non-reused placement identity.
/// Placeholder cells belonging to one placement share this key.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Stack {
    pub z: i32,
    pub image_id: u32,
    pub placement: u64,
}

impl Stack {
    pub fn layer(self) -> Layer {
        Layer::from_z(self.z)
    }
}

/// An absolute row fragment. Cell coordinates are unsigned 32.32, with vertical
/// coordinates relative to this row. Source coordinates are 32.32 pixels.
/// No lookup in a mutable placement table is needed to apply this descriptor.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Fragment {
    pub content: Content,
    pub stack: Stack,
    pub slice: RowSlice,
}

/// A resolved placement at one authoritative revision. Its iterator does work
/// proportional to emitted rows, with no per-row search through other images.
/// Resolve the anchor and dependency chain once before constructing this value.
#[derive(Clone, Copy, Debug)]
pub struct PlacementProjection {
    pub content: Content,
    pub stack: Stack,
    pub geometry: Geometry,
    pub position: Position,
    pub clip: Option<CellRect>,
}

impl PlacementProjection {
    pub fn rows(
        self,
        columns: u16,
        rows: u16,
    ) -> Result<impl ExactSizeIterator<Item = (u16, Fragment)>, ProjectionError> {
        let source = self.geometry.source();
        if self.stack.placement == 0
            || pixel_bytes(self.content.width, self.content.height, 4).is_none()
            || source
                .x
                .checked_add(source.width)
                .is_none_or(|right| right > self.content.width)
            || source
                .y
                .checked_add(source.height)
                .is_none_or(|bottom| bottom > self.content.height)
        {
            return Err(ProjectionError::InvalidFragment);
        }
        let Position { column, line } = self.position;
        Ok(self
            .geometry
            .visible_rows(column, line, columns, rows, self.clip)
            .map(move |row| {
                let slice = match self.clip {
                    Some(clip) => self.geometry.project_row_clipped(
                        column,
                        line,
                        u32::from(columns),
                        i64::from(row),
                        clip,
                    ),
                    None => {
                        self.geometry
                            .project_row(column, line, u32::from(columns), i64::from(row))
                    }
                }
                .expect("visible interval contains only intersecting rows");
                (
                    row,
                    Fragment {
                        content: self.content,
                        stack: self.stack,
                        slice,
                    },
                )
            }))
    }
}

impl Fragment {
    /// Validate before allocating retained storage. No floating point, narrowing
    /// arithmetic or untrusted multiplications participate in these bounds.
    pub fn valid(self, columns: u16) -> bool {
        let s = self.slice;
        self.stack.placement != 0
            && pixel_bytes(self.content.width, self.content.height, 4).is_some()
            && s.left < s.right
            && s.right <= u64::from(columns) * CELL_UNIT
            && s.top < s.bottom
            && s.bottom <= CELL_UNIT
            // Sub-32.32 source intervals can round both endpoints to the same
            // value at extreme magnification. Their destination is still real.
            && s.source_left <= s.source_right
            && s.source_right <= u64::from(self.content.width) * CELL_UNIT
            && s.source_top <= s.source_bottom
            && s.source_bottom <= u64::from(self.content.height) * CELL_UNIT
    }

    pub fn encode(self) -> [u8; FRAGMENT_BYTES] {
        let mut bytes = [0; FRAGMENT_BYTES];
        bytes[..40].copy_from_slice(&self.content.encode());
        bytes[40..44].copy_from_slice(&self.stack.z.to_be_bytes());
        bytes[44..48].copy_from_slice(&self.stack.image_id.to_be_bytes());
        bytes[48..56].copy_from_slice(&self.stack.placement.to_be_bytes());
        for (out, word) in bytes[56..].chunks_exact_mut(8).zip(slice_words(self.slice)) {
            out.copy_from_slice(&word.to_be_bytes());
        }
        bytes
    }

    pub fn decode(bytes: &[u8; FRAGMENT_BYTES], columns: u16) -> Option<Self> {
        let word = |offset| {
            u64::from_be_bytes(
                bytes[offset..offset + 8]
                    .try_into()
                    .expect("fixed descriptor"),
            )
        };
        let fragment = Self {
            content: Content::decode(bytes[..40].try_into().expect("fixed content"))?,
            stack: Stack {
                z: i32::from_be_bytes(bytes[40..44].try_into().expect("fixed z")),
                image_id: u32::from_be_bytes(bytes[44..48].try_into().expect("fixed image id")),
                placement: word(48),
            },
            slice: RowSlice {
                left: word(56),
                right: word(64),
                top: word(72),
                bottom: word(80),
                source_left: word(88),
                source_right: word(96),
                source_top: word(104),
                source_bottom: word(112),
            },
        };
        fragment.valid(columns).then_some(fragment)
    }

    /// Stable total ordering for canonical row equality, independent of index
    /// traversal order. Disjoint placeholder slices can share a stacking key.
    pub fn compare(&self, other: &Self) -> std::cmp::Ordering {
        self.stack
            .cmp(&other.stack)
            .then_with(|| self.content.cmp(&other.content))
            .then_with(|| slice_words(self.slice).cmp(&slice_words(other.slice)))
    }

    /// Exact half-open coverage for prediction admission and damaged-cell tests.
    /// Asset absence cannot make an authoritative covered cell safe to predict.
    pub fn intersects_cells(self, left: u16, right: u16) -> bool {
        left < right
            && self.slice.left < u64::from(right) * CELL_UNIT
            && self.slice.right > u64::from(left) * CELL_UNIT
    }
}

fn slice_words(slice: RowSlice) -> [u64; 8] {
    [
        slice.left,
        slice.right,
        slice.top,
        slice.bottom,
        slice.source_left,
        slice.source_right,
        slice.source_top,
        slice.source_bottom,
    ]
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProjectionError {
    TooManyFragments,
    InvalidFragment,
    NonCanonicalOrder,
    Quota,
}

struct Retained {
    fragments: Box<[Fragment]>,
    right: u64,
    digest: u64,
    _lease: Lease,
}

/// Empty rows have no heap allocation or reference count. Nonempty captures,
/// sends, repairs and eligible presentations share one immutable descriptor slice.
/// The lease remains charged until the last consumer releases it, even after
/// the originating terminal or its row pool is gone.
#[derive(Clone, Default)]
pub struct RowFragments(Option<Arc<Retained>>);

impl RowFragments {
    pub fn as_slice(&self) -> &[Fragment] {
        self.0.as_ref().map_or(&[], |row| &row.fragments)
    }

    /// Canonical graphics digest, computed once per immutable replacement.
    /// Empty rows omit the graphics suffix entirely, preserving text-only hashes.
    pub fn digest(&self) -> Option<u64> {
        self.0.as_ref().map(|row| row.digest)
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_none()
    }

    /// Replace the complete row, including clearing it with an empty slice.
    /// Reject the entire operation before mutation on invalid input or pressure.
    /// Exact unchanged content reuses its allocation; no hash collision can
    /// suppress a scene change. Callers sort their bounded scratch in place with
    /// `Fragment::compare` before publication.
    pub fn replace(
        &mut self,
        budget: &Budget,
        columns: u16,
        fragments: &[Fragment],
    ) -> Result<bool, ProjectionError> {
        if self.as_slice() == fragments {
            // The retained bytes already passed all structural checks. A new
            // viewport width is the only constraint that can invalidate them.
            if self
                .0
                .as_ref()
                .is_some_and(|row| row.right > u64::from(columns) * CELL_UNIT)
            {
                return Err(ProjectionError::InvalidFragment);
            }
            return Ok(false);
        }
        if fragments.is_empty() {
            self.0 = None;
            return Ok(true);
        }
        let right = validate_row_extent(columns, fragments)?;
        let lease = budget
            .reserve(retained_usage(fragments.len()).ok_or(ProjectionError::TooManyFragments)?)
            .ok_or(ProjectionError::Quota)?;
        let mut digest = xxhash_rust::xxh3::Xxh3::new();
        digest.update(&(fragments.len() as u16).to_be_bytes());
        for fragment in fragments {
            digest.update(&fragment.encode());
        }
        let next = Arc::new(Retained {
            fragments: fragments.into(),
            digest: digest.digest(),
            right,
            _lease: lease,
        });
        self.0 = Some(next);
        Ok(true)
    }

    pub fn intersects_cells(&self, left: u16, right: u16) -> bool {
        self.as_slice()
            .iter()
            .any(|fragment| fragment.intersects_cells(left, right))
    }

    /// Equality fast path for shared captures, followed by exact descriptor
    /// equality for independently reconstructed copies.
    pub fn same(&self, other: &Self) -> bool {
        match (&self.0, &other.0) {
            (None, None) => true,
            (Some(a), Some(b)) => Arc::ptr_eq(a, b) || a.fragments == b.fragments,
            _ => false,
        }
    }
}

pub fn validate_row(columns: u16, fragments: &[Fragment]) -> Result<(), ProjectionError> {
    validate_row_extent(columns, fragments).map(|_| ())
}

fn validate_row_extent(columns: u16, fragments: &[Fragment]) -> Result<u64, ProjectionError> {
    if fragments.len() > MAX_ROW_FRAGMENTS {
        return Err(ProjectionError::TooManyFragments);
    }
    let mut previous: Option<&Fragment> = None;
    let mut right = 0;
    for fragment in fragments {
        if !fragment.valid(columns) {
            return Err(ProjectionError::InvalidFragment);
        }
        if previous.is_some_and(|previous| !previous.compare(fragment).is_lt()) {
            return Err(ProjectionError::NonCanonicalOrder);
        }
        previous = Some(fragment);
        right = right.max(fragment.slice.right);
    }
    Ok(right)
}

/// Exact requested allocation bytes, including Arc counters and retained lease
/// metadata. Allocator-internal bookkeeping is outside the application quota.
/// Both allocations count: the descriptor slice and its shared ownership node.
pub fn retained_usage(count: usize) -> Option<Usage> {
    if count > MAX_ROW_FRAGMENTS {
        return None;
    }
    Some(if count == 0 {
        Usage {
            bytes: 0,
            objects: 0,
        }
    } else {
        Usage {
            bytes: count
                .checked_mul(size_of::<Fragment>())?
                .checked_add(size_of::<Retained>() + 2 * size_of::<usize>())?,
            objects: 2,
        }
    })
}
