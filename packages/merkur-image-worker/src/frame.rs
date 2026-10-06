//! Persistent immutable frame regions. Edits replace only intersecting tile
//! leaves and their branch paths; the terminal owner never copies canvas pixels.
//! Construction and hashing belong to the admitted processing owner. Physical
//! destruction uses the same off-owner retirement queue as decoded images.

use std::sync::Arc;

use merkur_graphics::budget::{Lease, Usage};
use merkur_graphics::processing::Pixels;
use merkur_graphics::projection::Content;
use merkur_graphics::tile::TILE_SIDE;

use crate::{DecodedImage, ImageStorage, retirement::Retained};

const SIDE: u32 = TILE_SIDE as u32;
const LEAF_DOMAIN: &[u8] = b"merkur.graphics.frame.leaf.rgba8.srgb.straight-alpha\0";
const BRANCH_DOMAIN: &[u8] = b"merkur.graphics.frame.branch\0";
const ROOT_DOMAIN: &[u8] = b"merkur.graphics.frame.canvas\0";
const NODE_BYTES: usize = size_of::<Node>() + 2 * size_of::<usize>();
const ROOT_BYTES: usize =
    Retained::<Root>::METADATA_BYTES + size_of::<Retained<Root>>() + 2 * size_of::<usize>();

/// A contiguous row run, with no allocation or packing of a complete canvas.
/// The returned slice starts at (x, y), ends no later than the row's end and
/// contains at least one complete pixel. Callers supply validated coordinates.
pub trait Raster {
    fn width(&self) -> u32;
    fn height(&self) -> u32;
    fn run(&self, x: u32, y: u32) -> &[u8];
}

impl Raster for Pixels {
    #[inline]
    fn width(&self) -> u32 {
        self.width()
    }
    #[inline]
    fn height(&self) -> u32 {
        self.height()
    }
    #[inline]
    fn run(&self, x: u32, y: u32) -> &[u8] {
        assert!(x < self.width() && y < self.height());
        let stride = self.width() as usize * 4;
        &self.rgba()[y as usize * stride + x as usize * 4..(y as usize + 1) * stride]
    }
}

struct Leaf {
    image: Arc<Retained<ImageStorage>>,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
}

enum Kind {
    Leaf(Leaf),
    Branch([Arc<Node>; 2]),
}

struct Node {
    kind: Kind,
    hash: [u8; 32],
    // Pixel owners and children are destroyed before their metadata is refunded.
    _lease: Lease,
}

struct Root {
    node: Arc<Node>,
}

#[derive(Clone)]
pub struct Frame {
    content: Content,
    data: Arc<Retained<Root>>,
}

/// A tile-aligned replacement, clipped only at the canvas's right/bottom edge.
#[derive(Clone, Copy)]
struct Tiles {
    columns: u32,
    first_x: u32,
    first_y: u32,
    end_x: u32,
    end_y: u32,
}

impl Tiles {
    /// Whether this contiguous index interval intersects the rectangular edit.
    fn intersects(self, first: u32, end: u32) -> bool {
        let row = (first / self.columns).max(self.first_y);
        if row >= self.end_y {
            return false;
        }
        let candidate = first.max(row * self.columns + self.first_x);
        let candidate = if candidate < row * self.columns + self.end_x {
            candidate
        } else if row + 1 < self.end_y {
            (row + 1) * self.columns + self.first_x
        } else {
            return false;
        };
        candidate < end
    }
}

impl Frame {
    /// The tree `from_image` builds over a `width` x `height` canvas.
    pub fn tree_charge(width: u32, height: u32) -> Usage {
        charge(2 * width.div_ceil(SIDE) * height.div_ceil(SIDE) - 1)
    }

    /// The branch paths and leaves `replace_tiles` builds for a `width` x
    /// `height` region at (x, y) of a `size` canvas, or `None` when the region
    /// is not a tile-aligned replacement.
    pub fn replacement_charge(
        size: [u32; 2],
        x: u32,
        y: u32,
        width: u32,
        height: u32,
    ) -> Option<Usage> {
        let (tiles, count) = replacement(size, x, y, width, height)?;
        Some(charge(changed_nodes(0, count, tiles)))
    }

    /// Conversion borrows the validated original's pixels. It hashes each leaf
    /// once and allocates only tree metadata, never a second full canvas:
    /// `tree_charge`, split from storage its owner admitted.
    pub fn from_image(image: &DecodedImage, batch: &mut Lease) -> Option<Self> {
        let width = image.pixels().width();
        let height = image.pixels().height();
        let columns = width.div_ceil(SIDE);
        let count = columns * height.div_ceil(SIDE);
        let mut lease = batch.split(Self::tree_charge(width, height))?;
        let node = build(0, count, &mut lease, &|index| {
            let x = index % columns * SIDE;
            let y = index / columns * SIDE;
            Leaf {
                image: Arc::clone(&image.data),
                x,
                y,
                width: (width - x).min(SIDE),
                height: (height - y).min(SIDE),
            }
        });
        Self::finish(width, height, node, lease)
    }

    /// The processing helper has already composed these complete tile regions.
    /// Unchanged subtrees and their backing allocations retain their original
    /// leases. No historical frame is retained merely to resolve another frame.
    /// The new nodes are `replacement_charge`, split from admitted storage.
    pub fn replace_tiles(
        &self,
        x: u32,
        y: u32,
        image: &DecodedImage,
        batch: &mut Lease,
    ) -> Option<Self> {
        let width = image.pixels().width();
        let height = image.pixels().height();
        let (tiles, count) = replacement([self.width(), self.height()], x, y, width, height)?;
        let mut lease = batch.split(charge(changed_nodes(0, count, tiles)))?;
        let node = replace(&self.data.node, 0, count, tiles, &mut lease, &|index| {
            let sx = index % tiles.columns * SIDE - x;
            let sy = index / tiles.columns * SIDE - y;
            Leaf {
                image: Arc::clone(&image.data),
                x: sx,
                y: sy,
                width: (width - sx).min(SIDE),
                height: (height - sy).min(SIDE),
            }
        });
        Self::finish(self.width(), self.height(), node, lease)
    }

    fn finish(width: u32, height: u32, node: Arc<Node>, lease: Lease) -> Option<Self> {
        let mut hash = blake3::Hasher::new();
        hash.update(ROOT_DOMAIN);
        hash.update(&width.to_be_bytes());
        hash.update(&height.to_be_bytes());
        hash.update(&node.hash);
        Some(Self {
            content: Content {
                kind: merkur_graphics::projection::ContentKind::Image,
                root: *hash.finalize().as_bytes(),
                width,
                height,
            },
            data: Arc::new(Retained::new(Root { node }, lease)?),
        })
    }

    pub fn content(&self) -> Content {
        self.content
    }

    /// Copies only the requested row span into caller-owned admitted scratch.
    pub fn copy_row(&self, mut x: u32, y: u32, mut out: &mut [u8]) -> bool {
        if !out.len().is_multiple_of(4)
            || y >= self.height()
            || (x as usize)
                .checked_add(out.len() / 4)
                .is_none_or(|end| end > self.width() as usize)
        {
            return false;
        }
        while !out.is_empty() {
            let run = self.run(x, y);
            let count = out.len().min(run.len());
            out[..count].copy_from_slice(&run[..count]);
            x += (count / 4) as u32;
            out = &mut out[count..];
        }
        true
    }
}

impl Raster for Frame {
    fn width(&self) -> u32 {
        self.content.width
    }
    fn height(&self) -> u32 {
        self.content.height
    }
    fn run(&self, x: u32, y: u32) -> &[u8] {
        assert!(x < self.width() && y < self.height());
        let columns = self.width().div_ceil(SIDE);
        let index = y / SIDE * columns + x / SIDE;
        let (mut first, mut end) = (0, columns * self.height().div_ceil(SIDE));
        let mut node = &self.data.node;
        while let Kind::Branch(children) = &node.kind {
            let middle = first + (end - first) / 2;
            if index < middle {
                node = &children[0];
                end = middle;
            } else {
                node = &children[1];
                first = middle;
            }
        }
        let Kind::Leaf(leaf) = &node.kind else {
            unreachable!()
        };
        let local_x = x % SIDE;
        &leaf.image.pixels.run(leaf.x + local_x, leaf.y + y % SIDE)
            [..(leaf.width - local_x) as usize * 4]
    }
}

fn charge(nodes: u32) -> Usage {
    Usage {
        bytes: nodes as usize * NODE_BYTES + ROOT_BYTES,
        objects: nodes as usize + 1,
    }
}

/// The tiles a `width` x `height` region at (x, y) of a `size` canvas replaces
/// and the canvas's tile count, when the region is tile-aligned and clipped
/// only at the canvas's right/bottom edge.
fn replacement(size: [u32; 2], x: u32, y: u32, width: u32, height: u32) -> Option<(Tiles, u32)> {
    let end_x = x.checked_add(width)?;
    let end_y = y.checked_add(height)?;
    if !x.is_multiple_of(SIDE)
        || !y.is_multiple_of(SIDE)
        || end_x > size[0]
        || end_y > size[1]
        || (end_x != size[0] && !end_x.is_multiple_of(SIDE))
        || (end_y != size[1] && !end_y.is_multiple_of(SIDE))
    {
        return None;
    }
    let tiles = Tiles {
        columns: size[0].div_ceil(SIDE),
        first_x: x / SIDE,
        first_y: y / SIDE,
        end_x: end_x.div_ceil(SIDE),
        end_y: end_y.div_ceil(SIDE),
    };
    Some((tiles, tiles.columns * size[1].div_ceil(SIDE)))
}

fn allocate(kind: Kind, hash: [u8; 32], lease: &mut Lease) -> Arc<Node> {
    Arc::new(Node {
        kind,
        hash,
        _lease: lease
            .split(Usage {
                bytes: NODE_BYTES,
                objects: 1,
            })
            .expect("entire changed tree admitted before construction"),
    })
}

fn leaf(value: Leaf, lease: &mut Lease) -> Arc<Node> {
    let mut hash = blake3::Hasher::new();
    hash.update(LEAF_DOMAIN);
    hash.update(&value.width.to_be_bytes());
    hash.update(&value.height.to_be_bytes());
    for y in value.y..value.y + value.height {
        hash.update(&value.image.pixels.run(value.x, y)[..value.width as usize * 4]);
    }
    allocate(Kind::Leaf(value), *hash.finalize().as_bytes(), lease)
}

fn branch(children: [Arc<Node>; 2], lease: &mut Lease) -> Arc<Node> {
    let mut hash = blake3::Hasher::new();
    hash.update(BRANCH_DOMAIN);
    for child in &children {
        hash.update(&child.hash);
    }
    allocate(Kind::Branch(children), *hash.finalize().as_bytes(), lease)
}

fn build(first: u32, end: u32, lease: &mut Lease, source: &impl Fn(u32) -> Leaf) -> Arc<Node> {
    if end - first == 1 {
        return leaf(source(first), lease);
    }
    let middle = first + (end - first) / 2;
    let children = [
        build(first, middle, lease, source),
        build(middle, end, lease, source),
    ];
    branch(children, lease)
}

fn changed_nodes(first: u32, end: u32, tiles: Tiles) -> u32 {
    if !tiles.intersects(first, end) {
        return 0;
    }
    if end - first == 1 {
        return 1;
    }
    let middle = first + (end - first) / 2;
    1 + changed_nodes(first, middle, tiles) + changed_nodes(middle, end, tiles)
}

fn replace(
    node: &Arc<Node>,
    first: u32,
    end: u32,
    tiles: Tiles,
    lease: &mut Lease,
    source: &impl Fn(u32) -> Leaf,
) -> Arc<Node> {
    if !tiles.intersects(first, end) {
        return Arc::clone(node);
    }
    if end - first == 1 {
        return leaf(source(first), lease);
    }
    let Kind::Branch(children) = &node.kind else {
        unreachable!()
    };
    let middle = first + (end - first) / 2;
    let children = [
        replace(&children[0], first, middle, tiles, lease, source),
        replace(&children[1], middle, end, tiles, lease, source),
    ];
    branch(children, lease)
}

#[cfg(test)]
mod tests {
    use super::*;
    use merkur_graphics::budget::Budget;

    fn budget() -> Budget {
        Budget::new(Usage {
            bytes: 32 * 1024 * 1024,
            objects: 4096,
        })
    }

    fn image(budget: &Budget, width: u32, height: u32, bytes: Vec<u8>) -> Arc<DecodedImage> {
        let lease = budget
            .reserve(Usage {
                bytes: bytes.len() + crate::OUTPUT_METADATA_BYTES,
                objects: 1,
            })
            .unwrap();
        Arc::new(
            DecodedImage::new(Pixels::new(width, height, bytes.into()).unwrap(), lease).unwrap(),
        )
    }

    #[test]
    fn rectangle_intersection_matches_each_index_including_partial_last_rows() {
        for columns in 1..=9 {
            for count in 1..=columns * 4 {
                for first_x in 0..columns {
                    for end_x in first_x + 1..=columns {
                        for first_y in 0..4 {
                            let tiles = Tiles {
                                columns,
                                first_x,
                                first_y,
                                end_x,
                                end_y: 4,
                            };
                            for first in 0..count {
                                for end in first + 1..=count {
                                    let expected = (first..end).any(|index| {
                                        index % columns >= first_x
                                            && index % columns < end_x
                                            && index / columns >= first_y
                                            && index / columns < 4
                                    });
                                    assert_eq!(tiles.intersects(first, end), expected);
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn edited_frames_share_untouched_regions_and_have_canonical_pixel_roots() {
        let budget = budget();
        let (width, height) = (SIDE * 3 + 1, SIDE * 2 + 3);
        let mut bytes: Vec<_> = (0..width * height * 4)
            .map(|v| (v * 37 + v / 71) as u8)
            .collect();
        let original = image(&budget, width, height, bytes.clone());
        let tree = || budget.reserve(Frame::tree_charge(width, height)).unwrap();
        let frame = Frame::from_image(&original, &mut tree()).unwrap();
        // Conversion retains pixels instead of packing a canvas copy.
        assert_eq!(
            frame.run(7, 13).as_ptr(),
            original.pixels().run(7, 13).as_ptr()
        );
        let replacement = image(&budget, SIDE, SIDE, vec![42; (SIDE * SIDE * 4) as usize]);
        let before = budget.used().unwrap();
        let mut batch = budget
            .reserve(Frame::replacement_charge([width, height], SIDE, SIDE, SIDE, SIDE).unwrap())
            .unwrap();
        let edited = frame
            .replace_tiles(SIDE, SIDE, &replacement, &mut batch)
            .unwrap();
        // The replacement took exactly the batch its charge admitted.
        assert_eq!(batch.charge().bytes, 0);
        let after = budget.used().unwrap();
        assert_eq!(
            after.bytes - before.bytes,
            charge(changed_nodes(
                0,
                12,
                Tiles {
                    columns: 4,
                    first_x: 1,
                    first_y: 1,
                    end_x: 2,
                    end_y: 2,
                }
            ))
            .bytes
        );
        assert_eq!(frame.run(0, 0).as_ptr(), edited.run(0, 0).as_ptr());
        assert_ne!(
            frame.run(SIDE, SIDE).as_ptr(),
            edited.run(SIDE, SIDE).as_ptr()
        );
        for y in SIDE..2 * SIDE {
            let start = ((y * width + SIDE) * 4) as usize;
            bytes[start..start + SIDE as usize * 4].fill(42);
        }
        let packed =
            Frame::from_image(&image(&budget, width, height, bytes.clone()), &mut tree()).unwrap();
        assert_eq!(edited.content(), packed.content());
        let mut row = vec![0; width as usize * 4];
        for y in 0..height {
            assert!(edited.copy_row(0, y, &mut row));
            assert_eq!(
                row,
                bytes[(y * width * 4) as usize..((y + 1) * width * 4) as usize]
            );
        }
        // Edge edits use their actual clipped dimensions, not padded texels.
        let edge_image = image(&budget, 1, 3, vec![91; 12]);
        let edge = edited
            .replace_tiles(
                3 * SIDE,
                2 * SIDE,
                &edge_image,
                &mut budget
                    .reserve(
                        Frame::replacement_charge([width, height], 3 * SIDE, 2 * SIDE, 1, 3)
                            .unwrap(),
                    )
                    .unwrap(),
            )
            .unwrap();
        drop(edge_image);
        assert_eq!(edge.run(3 * SIDE, 2 * SIDE), &[91; 4]);
        assert_ne!(edge.content(), edited.content());
        assert!(!edge.copy_row(width, 0, &mut [0; 4]));
        assert!(!edge.copy_row(0, height, &mut [0; 4]));
        assert!(!edge.copy_row(0, 0, &mut [0; 3]));
        drop((edge, packed, edited, frame, original, replacement));
        crate::retirement::drain();
        assert_eq!(
            budget.used(),
            Some(Usage {
                bytes: 0,
                objects: 0
            })
        );
    }

    #[test]
    fn refusal_is_atomic_and_shared_allocations_stay_charged_until_their_last_frame() {
        let budget = budget();
        let original = image(&budget, SIDE * 2, SIDE, vec![0; (SIDE * SIDE * 8) as usize]);
        let frame = Frame::from_image(
            &original,
            &mut budget.reserve(Frame::tree_charge(SIDE * 2, SIDE)).unwrap(),
        )
        .unwrap();
        let patch = image(&budget, SIDE, SIDE, vec![1; (SIDE * SIDE * 4) as usize]);
        let charge = Frame::replacement_charge([SIDE * 2, SIDE], 0, 0, SIDE, SIDE).unwrap();
        let mut batch = budget.reserve(charge).unwrap();
        let before = budget.used();
        let mut refused = budget
            .reserve(Usage {
                bytes: charge.bytes - 1,
                objects: charge.objects,
            })
            .unwrap();
        assert!(frame.replace_tiles(0, 0, &patch, &mut refused).is_none());
        assert_eq!(refused.charge().bytes, charge.bytes - 1);
        drop(refused);
        assert!(frame.replace_tiles(1, 0, &patch, &mut batch).is_none());
        assert!(
            frame
                .replace_tiles(SIDE * 2, 0, &patch, &mut batch)
                .is_none()
        );
        assert_eq!(budget.used(), before);
        assert_eq!(batch.charge(), charge);
        let edited = frame.replace_tiles(0, 0, &patch, &mut batch).unwrap();
        drop((frame, original, patch));
        crate::retirement::drain();
        // The old full-image allocation still supplies the second shared tile.
        assert!(budget.used().unwrap().bytes > (SIDE * SIDE * 12) as usize);
        assert_eq!(edited.run(SIDE, 0)[0], 0);
        drop(edited);
        crate::retirement::drain();
        assert_eq!(
            budget.used(),
            Some(Usage {
                bytes: 0,
                objects: 0
            })
        );
    }

    #[test]
    fn region_encoding_matches_packed_pixels_at_every_level_and_gutter() {
        use crate::tile::Encoder;
        use merkur_graphics::tile::TILE_ENCODED_BYTES;

        let budget = budget();
        let mut encoder = Encoder::new(budget.reserve(Encoder::charge()).unwrap()).unwrap();
        let mut actual = vec![0; TILE_ENCODED_BYTES];
        let mut expected = vec![0; TILE_ENCODED_BYTES];
        for (width, height) in [(1, 1), (513, 519), (1, 519), (1027, 1)] {
            let bytes = (0..width * height * 4)
                .map(|v| (v * 37 + v / 91) as u8)
                .collect();
            let original = image(&budget, width, height, bytes);
            let frame = Frame::from_image(
                &original,
                &mut budget.reserve(Frame::tree_charge(width, height)).unwrap(),
            )
            .unwrap();
            for level in 0..=width.max(height).next_power_of_two().ilog2() as u8 {
                for y in 0..height.div_ceil(1 << level).div_ceil(SIDE) {
                    for x in 0..width.div_ceil(1 << level).div_ceil(SIDE) {
                        let a = encoder
                            .encode_level(&frame, level, [x, y], &mut actual, || false)
                            .unwrap();
                        let b = encoder
                            .encode_level(original.pixels(), level, [x, y], &mut expected, || false)
                            .unwrap();
                        assert_eq!(a, b);
                        assert_eq!(actual[..a.1], expected[..b.1]);
                    }
                }
            }
            drop((original, frame));
            crate::retirement::drain();
        }
    }
}
