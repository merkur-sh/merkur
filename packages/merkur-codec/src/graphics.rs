//! Independently decodable graphics replacement for one display row.
//!
//! A section interns immutable content domains locally, never through another
//! packet. All integers are big endian. The section is `content_count:u16 |
//! fragment_count:u16 | contents:[root:32,kind:u16,width:u16,height:u32] |
//! fragments:[content_index:u16,stack:16,slice:64]`. The enclosing row prefixes
//! this with its exact u32 byte length. Absence means the complete empty set.

use std::io::Read;
use std::num::NonZeroU64;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use merkur_graphics::budget::{Budget, Lease, Usage};
use merkur_graphics::geometry::CELL_UNIT;
use merkur_graphics::projection::{
    Content, FRAGMENT_BYTES, Fragment, MAX_ROW_FRAGMENTS, validate_row,
};

const CONTENT_BYTES: usize = 40;
const INDEXED_FRAGMENT_BYTES: usize = FRAGMENT_BYTES - CONTENT_BYTES + 2;
pub const MAX_GRAPHICS_SECTION_BYTES: usize =
    4 + MAX_ROW_FRAGMENTS * (CONTENT_BYTES + INDEXED_FRAGMENT_BYTES);

/// Reused by the producer across rows and frames. Text rows never touch it.
#[derive(Default)]
pub struct GraphicsEncodeScratch {
    contents: Vec<Content>,
}

impl GraphicsEncodeScratch {
    /// The owner admits `capacity * size_of::<Content>()` before this allocation.
    pub fn with_capacity(capacity: usize) -> Self {
        Self {
            contents: Vec::with_capacity(capacity),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GraphicsWireError;

/// Native captures share one canonical encoding through preparation and send.
/// Empty rows carry no allocation. Pixels are never retained here, and neither
/// is a storage charge: the owner that created a row holds its charge
/// separately, so a capture a slow consumer still holds never keeps storage.
#[derive(Clone, Default)]
pub struct PreparedGraphics(Option<Arc<RetainedGraphics>>);

struct RetainedGraphics {
    bytes: Box<[u8]>,
    digest: u64,
    right: u64,
    version: GraphicsVersion,
}

/// Identity of one retained row allocation, for bookkeeping that must not hold
/// its bytes: selective ACK records a version where it once held the row.
/// Equal versions are one allocation, so their bytes are equal; equal bytes in
/// two allocations compare unequal, which costs one conservative re-send.
/// Process-local, never on the wire, never a content digest.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GraphicsVersion(NonZeroU64);

static NEXT_VERSION: AtomicU64 = AtomicU64::new(1);

impl GraphicsVersion {
    fn next() -> Self {
        Self(
            NonZeroU64::new(NEXT_VERSION.fetch_add(1, Ordering::Relaxed))
                .expect("graphics row versions exhausted"),
        )
    }
}

impl PreparedGraphics {
    pub const EMPTY: Self = Self(None);

    /// Conservative reservation for one row, including all retained allocations.
    /// Content interning can make the final charge smaller, never larger.
    pub fn reservation_bound(fragments: usize) -> Option<Usage> {
        if fragments == 0 {
            return Some(Usage {
                bytes: 0,
                objects: 0,
            });
        }
        if fragments > MAX_ROW_FRAGMENTS {
            return None;
        }
        Some(Self::allocation_usage(
            8 + fragments * (CONTENT_BYTES + INDEXED_FRAGMENT_BYTES),
        ))
    }

    fn allocation_usage(len: usize) -> Usage {
        Usage {
            bytes: len + size_of::<RetainedGraphics>() + 2 * size_of::<usize>(),
            objects: 2,
        }
    }

    /// Consume a pre-admitted batch without another budget lock or admission race.
    /// The returned lease is the row's charge, `None` for an empty row; it is the
    /// caller's to hold for as long as the row is its own, whatever clones remain.
    pub fn new_reserved(
        reservation: &mut Lease,
        columns: u16,
        fragments: &[Fragment],
        scratch: &mut GraphicsEncodeScratch,
    ) -> Result<(Self, Option<Lease>), GraphicsWireError> {
        if fragments.is_empty() {
            return Ok((Self::EMPTY, None));
        }
        let len = prepare(columns, fragments, scratch)?;
        let lease = reservation
            .split(Self::allocation_usage(len))
            .ok_or(GraphicsWireError)?;
        Ok((Self::retain(len, fragments, scratch), Some(lease)))
    }

    /// One row admitted on its own; the charge is returned as for [`Self::new_reserved`].
    pub fn new(
        budget: &Budget,
        columns: u16,
        fragments: &[Fragment],
        scratch: &mut GraphicsEncodeScratch,
    ) -> Result<(Self, Option<Lease>), GraphicsWireError> {
        if fragments.is_empty() {
            return Ok((Self::EMPTY, None));
        }
        let len = prepare(columns, fragments, scratch)?;
        let lease = budget
            .reserve(Self::allocation_usage(len))
            .ok_or(GraphicsWireError)?;
        Ok((Self::retain(len, fragments, scratch), Some(lease)))
    }

    fn retain(len: usize, fragments: &[Fragment], scratch: &GraphicsEncodeScratch) -> Self {
        let mut bytes = Vec::with_capacity(len);
        append(&mut bytes, fragments, scratch);
        let mut digest = xxhash_rust::xxh3::Xxh3::new();
        digest.update(&(fragments.len() as u16).to_be_bytes());
        let mut right = 0;
        for fragment in fragments {
            digest.update(&fragment.encode());
            right = right.max(fragment.slice.right);
        }
        Self(Some(Arc::new(RetainedGraphics {
            bytes: bytes.into_boxed_slice(),
            digest: digest.digest(),
            right,
            version: GraphicsVersion::next(),
        })))
    }

    /// Exact comparison against canonical retained bytes, without allocation,
    /// sorting or hashing. A digest is never used as equality authority.
    pub fn matches(&self, columns: u16, fragments: &[Fragment]) -> bool {
        let Some(row) = &self.0 else {
            return fragments.is_empty();
        };
        if !self.fits_columns(columns) {
            return false;
        }
        let bytes = &row.bytes;
        let contents = usize::from(u16::from_be_bytes([bytes[4], bytes[5]]));
        let count = usize::from(u16::from_be_bytes([bytes[6], bytes[7]]));
        if count != fragments.len() {
            return false;
        }
        let start = 8 + contents * CONTENT_BYTES;
        for (fragment, encoded) in fragments
            .iter()
            .zip(bytes[start..].chunks_exact(INDEXED_FRAGMENT_BYTES))
        {
            let content =
                8 + usize::from(u16::from_be_bytes([encoded[0], encoded[1]])) * CONTENT_BYTES;
            let canonical = fragment.encode();
            if bytes[content..content + CONTENT_BYTES] != canonical[..CONTENT_BYTES]
                || encoded[2..] != canonical[CONTENT_BYTES..]
            {
                return false;
            }
        }
        true
    }

    pub fn bytes(&self) -> &[u8] {
        self.0.as_ref().map_or(&[], |row| &row.bytes)
    }

    pub fn digest(&self) -> Option<u64> {
        self.0.as_ref().map(|row| row.digest)
    }

    /// `None` exactly for the empty row.
    pub fn version(&self) -> Option<GraphicsVersion> {
        self.0.as_ref().map(|row| row.version)
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_none()
    }

    pub fn fits_columns(&self, columns: u16) -> bool {
        self.0
            .as_ref()
            .is_none_or(|row| row.right <= u64::from(columns) * CELL_UNIT)
    }

    /// Exact content equality between two rows that both hold their bytes. ACK
    /// bookkeeping holds only versions and compares those instead.
    pub fn same(&self, other: &Self) -> bool {
        match (&self.0, &other.0) {
            (None, None) => true,
            (Some(a), Some(b)) => Arc::ptr_eq(a, b) || (a.digest == b.digest && a.bytes == b.bytes),
            _ => false,
        }
    }
}

impl core::fmt::Debug for PreparedGraphics {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str("PreparedGraphics { .. }")
    }
}

/// Exact canonical encoding. No output is appended on semantic rejection.
pub fn encode_graphics(
    out: &mut Vec<u8>,
    columns: u16,
    fragments: &[Fragment],
    scratch: &mut GraphicsEncodeScratch,
) -> Result<(), GraphicsWireError> {
    let len = prepare(columns, fragments, scratch)?;
    out.reserve(len);
    append(out, fragments, scratch);
    Ok(())
}

fn prepare(
    columns: u16,
    fragments: &[Fragment],
    scratch: &mut GraphicsEncodeScratch,
) -> Result<usize, GraphicsWireError> {
    validate_row(columns, fragments).map_err(|_| GraphicsWireError)?;
    if fragments.is_empty() {
        return Err(GraphicsWireError);
    }
    scratch.contents.clear();
    scratch
        .contents
        .extend(fragments.iter().map(|fragment| fragment.content));
    scratch.contents.sort_unstable();
    scratch.contents.dedup();
    Ok(8 + scratch.contents.len() * CONTENT_BYTES + fragments.len() * INDEXED_FRAGMENT_BYTES)
}

fn append(out: &mut Vec<u8>, fragments: &[Fragment], scratch: &GraphicsEncodeScratch) {
    let len = 4 + scratch.contents.len() * CONTENT_BYTES + fragments.len() * INDEXED_FRAGMENT_BYTES;
    out.extend_from_slice(&(len as u32).to_be_bytes());
    out.extend_from_slice(&(scratch.contents.len() as u16).to_be_bytes());
    out.extend_from_slice(&(fragments.len() as u16).to_be_bytes());
    for content in &scratch.contents {
        out.extend_from_slice(&content.encode());
    }
    for fragment in fragments {
        let index = scratch
            .contents
            .binary_search(&fragment.content)
            .expect("interned content");
        out.extend_from_slice(&(index as u16).to_be_bytes());
        out.extend_from_slice(&fragment.encode()[CONTENT_BYTES..]);
    }
}

/// Validate before retained authority can observe anything. The enclosing frame
/// owns rollback on error. Table scratch is reused after lowering the link table;
/// neither raw nor compressed receivers allocate a dictionary per row.
pub fn decode_graphics<R: Read>(
    input: &mut R,
    len: usize,
    columns: u16,
    fragments: &mut Vec<Fragment>,
    table: &mut Vec<u8>,
) -> Result<(), GraphicsWireError> {
    if !(4..=MAX_GRAPHICS_SECTION_BYTES).contains(&len) {
        return Err(GraphicsWireError);
    }
    let mut counts = [0; 4];
    input
        .read_exact(&mut counts)
        .map_err(|_| GraphicsWireError)?;
    let contents = usize::from(u16::from_be_bytes([counts[0], counts[1]]));
    let count = usize::from(u16::from_be_bytes([counts[2], counts[3]]));
    if contents == 0
        || contents > count
        || count > MAX_ROW_FRAGMENTS
        || len != 4 + contents * CONTENT_BYTES + count * INDEXED_FRAGMENT_BYTES
    {
        return Err(GraphicsWireError);
    }
    table.resize(contents * CONTENT_BYTES, 0);
    input.read_exact(table).map_err(|_| GraphicsWireError)?;
    let mut previous_content: Option<&[u8]> = None;
    for content in table.chunks_exact(CONTENT_BYTES) {
        if Content::decode(content.try_into().expect("fixed content")).is_none()
            || previous_content.is_some_and(|previous| previous >= content)
        {
            return Err(GraphicsWireError);
        }
        previous_content = Some(content);
    }
    let mut used = [0u64; MAX_ROW_FRAGMENTS.div_ceil(64)];
    let mut previous: Option<Fragment> = None;
    fragments.reserve(count);
    for _ in 0..count {
        let mut encoded = [0; FRAGMENT_BYTES];
        let mut index = [0; 2];
        input
            .read_exact(&mut index)
            .map_err(|_| GraphicsWireError)?;
        let index = usize::from(u16::from_be_bytes(index));
        if index >= contents {
            return Err(GraphicsWireError);
        }
        used[index / 64] |= 1 << (index % 64);
        encoded[..CONTENT_BYTES]
            .copy_from_slice(&table[index * CONTENT_BYTES..(index + 1) * CONTENT_BYTES]);
        input
            .read_exact(&mut encoded[CONTENT_BYTES..])
            .map_err(|_| GraphicsWireError)?;
        let fragment = Fragment::decode(&encoded, columns).ok_or(GraphicsWireError)?;
        if previous.is_some_and(|previous| !previous.compare(&fragment).is_lt()) {
            return Err(GraphicsWireError);
        }
        previous = Some(fragment);
        fragments.push(fragment);
    }
    if (0..contents).any(|index| used[index / 64] & (1 << (index % 64)) == 0) {
        return Err(GraphicsWireError);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use merkur_graphics::geometry::{CELL_UNIT, RowSlice};
    use merkur_graphics::projection::RowFragments;
    use merkur_graphics::projection::Stack;

    fn fragment(index: usize, unique: bool) -> Fragment {
        let mut root = [0; 32];
        if unique {
            root[..8].copy_from_slice(&(index as u64).to_be_bytes());
        }
        Fragment {
            content: Content {
                kind: merkur_graphics::projection::ContentKind::Image,
                root,
                width: 16,
                height: 16,
            },
            stack: Stack {
                z: 0,
                image_id: 1,
                placement: index as u64 + 1,
            },
            slice: RowSlice {
                left: 0,
                right: CELL_UNIT,
                top: 0,
                bottom: CELL_UNIT,
                source_left: 0,
                source_right: 16 * CELL_UNIT,
                source_top: 0,
                source_bottom: 16 * CELL_UNIT,
            },
        }
    }

    #[test]
    fn maximum_rows_intern_locally_and_reencode_canonically() {
        for unique in [false, true] {
            let fragments: Vec<_> = (0..MAX_ROW_FRAGMENTS)
                .map(|index| fragment(index, unique))
                .collect();
            let mut wire = Vec::new();
            let mut scratch = GraphicsEncodeScratch::default();
            encode_graphics(&mut wire, 1, &fragments, &mut scratch).unwrap();
            let contents = if unique { MAX_ROW_FRAGMENTS } else { 1 };
            assert_eq!(
                wire.len(),
                8 + contents * CONTENT_BYTES + MAX_ROW_FRAGMENTS * INDEXED_FRAGMENT_BYTES
            );
            assert!(wire.len() > usize::from(u16::MAX));
            let mut decoded = Vec::new();
            let mut table = Vec::new();
            decode_graphics(&mut &wire[4..], wire.len() - 4, 1, &mut decoded, &mut table).unwrap();
            assert_eq!(decoded, fragments);
            let mut encoded = Vec::new();
            encode_graphics(&mut encoded, 1, &decoded, &mut scratch).unwrap();
            assert_eq!(encoded, wire);
            let budget = Budget::new(Usage {
                bytes: 4 * 1024 * 1024,
                objects: 4,
            });
            let mut retained = RowFragments::default();
            retained.replace(&budget, 1, &fragments).unwrap();
            let (prepared, _charge) =
                PreparedGraphics::new(&budget, 1, &fragments, &mut scratch).unwrap();
            assert_eq!(prepared.digest(), retained.digest());
            assert_eq!(prepared.bytes(), wire);
            let pointers = (encoded.as_ptr(), scratch.contents.as_ptr());
            for _ in 0..8 {
                encoded.clear();
                encode_graphics(&mut encoded, 1, &decoded, &mut scratch).unwrap();
                assert_eq!((encoded.as_ptr(), scratch.contents.as_ptr()), pointers);
            }
        }
    }

    #[test]
    fn prepared_rows_share_exact_bytes_but_only_their_owner_holds_the_charge() {
        let budget = Budget::new(Usage {
            bytes: 4 * 1024 * 1024,
            objects: 16,
        });
        let fragments = [fragment(0, true), fragment(1, true)];
        let mut retained = RowFragments::default();
        retained.replace(&budget, 1, &fragments).unwrap();
        let mut scratch = GraphicsEncodeScratch::default();
        let (prepared, charge) =
            PreparedGraphics::new(&budget, 1, &fragments, &mut scratch).unwrap();
        let mut expected = Vec::new();
        encode_graphics(&mut expected, 1, &fragments, &mut scratch).unwrap();
        assert_eq!(prepared.bytes(), expected);
        assert!(prepared.matches(1, &fragments));
        assert!(!prepared.matches(0, &fragments));
        assert!(!prepared.matches(1, &fragments[..1]));
        let mut changed = fragments;
        changed[0].content.root[0] ^= 1;
        assert!(!prepared.matches(1, &changed));
        let mut changed = fragments;
        changed[0].stack.z += 1;
        assert!(!prepared.matches(1, &changed));
        assert_eq!(prepared.digest(), retained.digest());
        drop(retained);
        assert!(prepared.fits_columns(1));
        assert!(!prepared.fits_columns(0));
        let usage = budget.used().unwrap();
        assert_eq!(usage.objects, 2);
        // A capture shares the bytes and the version, never the charge: the owner
        // superseding its row refunds it while the capture still reads every byte.
        let capture = prepared.clone();
        assert_eq!(capture.bytes().as_ptr(), prepared.bytes().as_ptr());
        assert_eq!(capture.version(), prepared.version());
        assert!(capture.same(&prepared));
        drop(prepared);
        assert_eq!(budget.used(), Some(usage));
        drop(charge);
        assert_eq!(
            budget.used(),
            Some(Usage {
                bytes: 0,
                objects: 0
            })
        );
        assert_eq!(capture.bytes(), expected);
        // The same content in another allocation is equal, never the same version.
        let (again, _charge) = PreparedGraphics::new(&budget, 1, &fragments, &mut scratch).unwrap();
        assert!(again.same(&capture));
        assert_ne!(again.version(), capture.version());
        assert_eq!(PreparedGraphics::EMPTY.version(), None);
    }

    #[test]
    fn preparation_refuses_quota_without_leaking_and_empty_rows_allocate_nothing() {
        let source_budget = Budget::new(Usage {
            bytes: 4096,
            objects: 2,
        });
        let denied = Budget::new(Usage {
            bytes: 0,
            objects: 0,
        });
        let mut retained = RowFragments::default();
        retained
            .replace(&source_budget, 1, &[fragment(0, false)])
            .unwrap();
        let mut scratch = GraphicsEncodeScratch::default();
        assert!(PreparedGraphics::new(&denied, 1, retained.as_slice(), &mut scratch).is_err());
        drop(retained);
        assert_eq!(
            source_budget.used(),
            Some(Usage {
                bytes: 0,
                objects: 0
            })
        );
        let (empty, charge) = PreparedGraphics::new(&denied, 0, &[], &mut scratch).unwrap();
        assert!(charge.is_none());
        assert!(empty.is_empty());
        assert!(empty.bytes().is_empty());
        assert_eq!(empty.digest(), None);
        assert!(empty.same(&PreparedGraphics::EMPTY));
        assert_eq!(
            denied.used(),
            Some(Usage {
                bytes: 0,
                objects: 0
            })
        );
    }

    #[test]
    fn batch_admission_consumes_only_exact_validated_retained_bytes() {
        let bound = PreparedGraphics::reservation_bound(2).unwrap();
        let budget = Budget::new(bound);
        let mut reservation = budget.reserve(bound).unwrap();
        let mut scratch = GraphicsEncodeScratch::with_capacity(2);
        let mut fragments = [fragment(0, false), fragment(1, false)];
        fragments[1].content = fragments[0].content;
        assert!(
            PreparedGraphics::new_reserved(&mut reservation, 0, &fragments, &mut scratch).is_err()
        );
        assert_eq!(reservation.charge(), bound);
        let (prepared, charge) =
            PreparedGraphics::new_reserved(&mut reservation, 1, &fragments, &mut scratch).unwrap();
        // The upper bound assumes distinct source domains; interning refunds the
        // duplicate domain only when the batch owner releases its remainder.
        assert_eq!(
            reservation.charge(),
            Usage {
                bytes: CONTENT_BYTES,
                objects: 0
            }
        );
        assert_eq!(budget.used(), Some(bound));
        assert!(prepared.matches(1, &fragments));
        drop(reservation);
        assert_eq!(
            budget.used(),
            Some(Usage {
                bytes: bound.bytes - CONTENT_BYTES,
                objects: 2
            })
        );
        // The row's split charge is the owner's, apart from the row itself.
        drop(charge);
        assert_eq!(
            budget.used(),
            Some(Usage {
                bytes: 0,
                objects: 0
            })
        );
        assert!(prepared.matches(1, &fragments));
    }

    #[test]
    fn independent_prepared_rows_compare_exact_bytes_even_if_digests_collide() {
        let budget = Budget::new(Usage {
            bytes: 4096,
            objects: 6,
        });
        let mut scratch = GraphicsEncodeScratch::default();
        let (first, _first) =
            PreparedGraphics::new(&budget, 1, &[fragment(0, true)], &mut scratch).unwrap();
        let (same, _same) =
            PreparedGraphics::new(&budget, 1, &[fragment(0, true)], &mut scratch).unwrap();
        assert_ne!(first.bytes().as_ptr(), same.bytes().as_ptr());
        assert!(first.same(&same));
        let (mut different, _different) =
            PreparedGraphics::new(&budget, 1, &[fragment(1, true)], &mut scratch).unwrap();
        assert!(!first.same(&different));
        Arc::get_mut(different.0.as_mut().unwrap()).unwrap().digest = first.digest().unwrap();
        assert!(!first.same(&different));
    }

    #[test]
    fn malformed_tables_indices_order_geometry_and_truncations_fail_closed() {
        let fragments = [fragment(0, true), fragment(1, true)];
        let mut encoded = Vec::new();
        encode_graphics(
            &mut encoded,
            1,
            &fragments,
            &mut GraphicsEncodeScratch::default(),
        )
        .unwrap();
        let valid = &encoded[4..];
        let reject = |bytes: &[u8]| {
            assert!(
                decode_graphics(
                    &mut &bytes[..],
                    bytes.len(),
                    1,
                    &mut Vec::new(),
                    &mut Vec::new()
                )
                .is_err()
            );
        };
        for end in 0..valid.len() {
            reject(&valid[..end]);
        }
        let first = 4 + 2 * CONTENT_BYTES;
        for (offset, value) in [(0, 0xff), (2, 0xff), (first, 0xff), (first + 2 + 16, 0xff)] {
            let mut bad = valid.to_vec();
            bad[offset] = value;
            reject(&bad);
        }
        let mut duplicate_content = valid.to_vec();
        duplicate_content.copy_within(4..4 + CONTENT_BYTES, 4 + CONTENT_BYTES);
        reject(&duplicate_content);
        let mut unused_content = valid.to_vec();
        unused_content[first + INDEXED_FRAGMENT_BYTES..first + INDEXED_FRAGMENT_BYTES + 2]
            .copy_from_slice(&0u16.to_be_bytes());
        reject(&unused_content);
        let mut duplicate_fragment = valid.to_vec();
        duplicate_fragment.copy_within(
            first..first + INDEXED_FRAGMENT_BYTES,
            first + INDEXED_FRAGMENT_BYTES,
        );
        reject(&duplicate_fragment);
        let mut trailing = valid.to_vec();
        trailing.push(0);
        reject(&trailing);
    }
}
