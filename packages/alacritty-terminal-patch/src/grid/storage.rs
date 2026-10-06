use std::cmp::max;
use std::mem;
use std::mem::MaybeUninit;
use std::ops::{Index, IndexMut};
use std::sync::Arc;
use std::sync::atomic::Ordering;

#[cfg(feature = "serde")]
use serde::{Deserialize, Serialize};

use super::Row;
use super::anchor::{
    AnchorDomain, AnchorEvent, AnchorState, GridAnchor, ImageAnchorBounds, ImageAnchorState,
};
use super::image_motion::ImageMotion;
use crate::index::{Column, Line, Point};

/// Maximum number of buffered lines outside of the grid for performance optimization.
const MAX_CACHE_SIZE: usize = 1_000;

/// A ring buffer for optimizing indexing and rotation.
///
/// The [`Storage::rotate`] and [`Storage::rotate_down`] functions are fast modular additions on
/// the internal [`zero`] field. As compared with [`slice::rotate_left`] which must rearrange items
/// in memory.
///
/// As a consequence, both [`Index`] and [`IndexMut`] are reimplemented for this type to account
/// for the zeroth element not always being at the start of the allocation.
///
/// Because certain [`Vec`] operations are no longer valid on this type, no [`Deref`]
/// implementation is provided. Anything from [`Vec`] that should be exposed must be done so
/// manually.
///
/// [`slice::rotate_left`]: https://doc.rust-lang.org/std/primitive.slice.html#method.rotate_left
/// [`Deref`]: std::ops::Deref
/// [`zero`]: #structfield.zero
#[derive(Debug)]
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
pub struct Storage<T> {
    inner: Vec<Row<T>>,

    /// Starting point for the storage of rows.
    ///
    /// This value represents the starting line offset within the ring buffer. The value of this
    /// offset may be larger than the `len` itself, and will wrap around to the start to form the
    /// ring buffer. It represents the bottommost line of the terminal.
    zero: usize,

    /// Number of visible lines.
    visible_lines: usize,

    /// Total number of lines currently active in the terminal (scrollback + visible)
    ///
    /// Shrinking this length allows reducing the number of lines in the scrollback buffer without
    /// having to truncate the raw `inner` buffer.
    /// As long as `len` is bigger than `inner`, it is also possible to grow the scrollback buffer
    /// without any additional insertions.
    len: usize,
    #[cfg_attr(feature = "serde", serde(skip))]
    anchor_domain: Option<Arc<AnchorDomain>>,
}

impl<T: Clone> Clone for Storage<T> {
    fn clone(&self) -> Self {
        Self {
            inner: self.inner.clone(),
            zero: self.zero,
            visible_lines: self.visible_lines,
            len: self.len,
            anchor_domain: None,
        }
    }
}

impl<T: PartialEq> PartialEq for Storage<T> {
    fn eq(&self, other: &Self) -> bool {
        // Both storage buffers need to be truncated and zeroed.
        assert_eq!(self.zero, 0);
        assert_eq!(other.zero, 0);

        self.inner == other.inner && self.len == other.len
    }
}

impl<T> Storage<T> {
    #[inline]
    pub fn with_capacity(visible_lines: usize, columns: usize) -> Storage<T>
    where
        T: Default,
    {
        // Initialize visible lines; the scrollback buffer is initialized dynamically.
        let mut inner = Vec::with_capacity(visible_lines);
        inner.resize_with(visible_lines, || Row::new(columns));

        Storage {
            inner,
            zero: 0,
            visible_lines,
            len: visible_lines,
            anchor_domain: None,
        }
    }

    /// Increase the number of lines in the buffer.
    #[inline]
    pub fn grow_visible_lines(&mut self, next: usize)
    where
        T: Default,
    {
        // Number of lines the buffer needs to grow.
        let additional_lines = next - self.visible_lines;

        let columns = self[Line(0)].len();
        self.initialize(additional_lines, columns);

        // Update visible lines.
        self.visible_lines = next;
        if additional_lines != 0 {
            self.remap_anchors();
        }
    }

    /// Decrease the number of lines in the buffer.
    #[inline]
    pub fn shrink_visible_lines(&mut self, next: usize) {
        // Shrink the size without removing any lines.
        let shrinkage = self.visible_lines - next;
        self.shrink_lines(shrinkage);

        // Update visible lines.
        self.visible_lines = next;
        if shrinkage != 0 {
            self.remap_anchors();
        }
    }

    /// Shrink the number of lines in the buffer.
    #[inline]
    pub fn shrink_lines(&mut self, shrinkage: usize) {
        let images =
            self.preserve_image_tails(self.visible_lines as i64 - (self.len - shrinkage) as i64, 0);
        self.restore_images(images);
        if self.anchor_domain.is_some() {
            for positive in self.len - shrinkage..self.len {
                let slot = (self.zero + positive) % self.inner.len();
                self.inner[slot].retire_anchors();
            }
        }
        self.len -= shrinkage;

        // Free memory.
        if self.inner.len() > self.len + MAX_CACHE_SIZE {
            self.truncate();
        }
    }

    /// Truncate the invisible elements from the raw buffer.
    #[inline]
    pub fn truncate(&mut self) {
        self.rezero();

        self.inner.truncate(self.len);
    }

    /// Dynamically grow the storage buffer at runtime.
    #[inline]
    pub fn initialize(&mut self, additional_rows: usize, columns: usize)
    where
        T: Default,
    {
        if self.len + additional_rows > self.inner.len() {
            self.rezero();

            let realloc_size = self.inner.len() + max(additional_rows, MAX_CACHE_SIZE);
            self.inner.resize_with(realloc_size, || Row::new(columns));
        }

        self.len += additional_rows;
    }

    #[inline]
    pub fn len(&self) -> usize {
        self.len
    }

    /// Swap whole rows, including attachment ownership.
    pub fn swap(&mut self, a: Line, b: Line) {
        const { assert!(mem::size_of::<Row<T>>() % mem::size_of::<usize>() == 0) };

        let a = self.compute_index(a);
        let b = self.compute_index(b);

        unsafe {
            // Cast to a qword array to opt out of copy restrictions and avoid
            // drop hazards. Byte array is no good here since for whatever
            // reason LLVM won't optimized it.
            let a_ptr = self.inner.as_mut_ptr().add(a) as *mut MaybeUninit<usize>;
            let b_ptr = self.inner.as_mut_ptr().add(b) as *mut MaybeUninit<usize>;

            // Copy 1 qword at a time.
            //
            // The optimizer unrolls this loop and vectorizes it.
            let mut tmp: MaybeUninit<usize>;
            for i in 0..(mem::size_of::<Row<T>>() / mem::size_of::<usize>()) as isize {
                tmp = *a_ptr.offset(i);
                *a_ptr.offset(i) = *b_ptr.offset(i);
                *b_ptr.offset(i) = tmp;
            }
        }
        self.inner[a].refresh_anchor_slot(a);
        self.inner[b].refresh_anchor_slot(b);
    }

    /// Rotate the grid, moving all lines up/down in history.
    #[inline]
    pub fn rotate(&mut self, count: isize) {
        debug_assert!(count.unsigned_abs() <= self.inner.len());

        let len = self.inner.len();
        let previous = self.zero;
        self.zero = (self.zero as isize + count + len as isize) as usize % len;
        if self.zero != previous {
            self.retire_rotated_anchors(previous, count);
            self.remap_anchors();
        }
    }

    /// Rotate all existing lines down in history.
    ///
    /// This is a faster, specialized version of [`rotate_left`].
    ///
    /// [`rotate_left`]: https://doc.rust-lang.org/std/vec/struct.Vec.html#method.rotate_left
    #[inline]
    pub fn rotate_down(&mut self, count: usize) {
        let previous = self.zero;
        self.zero = (self.zero + count) % self.inner.len();
        if self.zero != previous {
            self.retire_rotated_anchors(previous, count as isize);
            self.remap_anchors();
        }
    }

    /// Allocated cache rows are outside live history. Retire attachments when
    /// their rows leave that history, not later when their storage is recycled.
    /// Surviving image tails have already been detached by the grid owner.
    fn retire_rotated_anchors(&mut self, previous: usize, count: isize) {
        if self.anchor_domain.is_none() || self.len == self.inner.len() {
            return;
        }
        let amount = count.unsigned_abs().min(self.len);
        let start = if count < 0 { self.len - amount } else { 0 };
        for positive in start..start + amount {
            let slot = (previous + positive) % self.inner.len();
            let mapped = (slot + self.inner.len() - self.zero) % self.inner.len();
            if mapped >= self.len {
                self.inner[slot].retire_anchors();
            }
        }
    }

    /// Update the raw storage buffer.
    #[inline]
    pub fn replace_inner(&mut self, vec: Vec<Row<T>>) {
        self.len = vec.len();
        self.inner = vec;
        self.zero = 0;
        self.refresh_anchor_slots();
    }

    /// Remove all rows from storage.
    #[inline]
    pub fn take_all(&mut self) -> Vec<Row<T>> {
        self.truncate();

        let mut buffer = Vec::new();

        mem::swap(&mut buffer, &mut self.inner);
        self.len = 0;

        buffer
    }

    /// Compute actual index in underlying storage given the requested index.
    #[inline]
    fn compute_index(&self, requested: Line) -> usize {
        debug_assert!(requested.0 < self.visible_lines as i32);

        let positive = -(requested - self.visible_lines).0 as usize - 1;

        debug_assert!(positive < self.len);

        let zeroed = self.zero + positive;

        // Use if/else instead of remainder here to improve performance.
        //
        // Requires `zeroed` to be smaller than `self.inner.len() * 2`,
        // but both `self.zero` and `requested` are always smaller than `self.inner.len()`.
        if zeroed >= self.inner.len() {
            zeroed - self.inner.len()
        } else {
            zeroed
        }
    }

    /// Rotate the ringbuffer to reset `self.zero` back to index `0`.
    #[inline]
    fn rezero(&mut self) {
        if self.zero == 0 {
            return;
        }

        self.inner.rotate_left(self.zero);
        self.zero = 0;
        self.refresh_anchor_slots();
    }

    fn refresh_anchor_slots(&self) {
        if self.anchor_domain.is_some() {
            for (slot, row) in self.inner.iter().enumerate() {
                row.refresh_anchor_slot(slot);
            }
        }
    }

    pub(super) fn anchor(
        &mut self,
        point: Point,
        tag: Option<std::num::NonZeroU64>,
    ) -> Option<GridAnchor> {
        self.anchor_inner(point, tag, None)
    }

    fn anchor_inner(
        &mut self,
        point: Point,
        tag: Option<std::num::NonZeroU64>,
        image: Option<ImageAnchorState>,
    ) -> Option<GridAnchor> {
        let positive = self.visible_lines as i64 - i64::from(point.line.0) - 1;
        if positive < 0 || positive as usize >= self.len || point.column.0 > u32::MAX as usize {
            return None;
        }
        let slot = self.compute_index(point.line);
        let row = &mut self.inner[slot];
        if point.column.0 >= row.len() {
            return None;
        }
        let slot = u32::try_from(slot).ok()?;
        let domain = self
            .anchor_domain
            .get_or_insert_with(|| Arc::new(AnchorDomain::default()))
            .clone();
        let mut state = AnchorState::new(slot, point.column.0 as u32, &domain, tag);
        if let Some(image) = image {
            state.image = Some(parking_lot::Mutex::new(image));
            domain.images.fetch_add(1, Ordering::Relaxed);
        }
        let state = Arc::new(state);
        row.anchors
            .get_or_insert_with(Default::default)
            .add(state.clone());
        Some(GridAnchor { domain, state })
    }

    pub(super) fn take_anchor_event(&self) -> Option<AnchorEvent> {
        self.anchor_domain.as_ref()?.take_event()
    }

    pub(super) fn remap_anchors(&self) {
        if let Some(domain) = &self.anchor_domain {
            domain.remapped.store(true, Ordering::Release);
        }
    }

    pub(super) fn image_anchor(
        &mut self,
        point: Point,
        tag: std::num::NonZeroU64,
        bounds: ImageAnchorBounds,
    ) -> Option<GridAnchor> {
        let image = ImageAnchorState::new(bounds)?;
        self.anchor_inner(point, Some(tag), Some(image))
    }

    pub(super) fn has_images(&self) -> bool {
        self.anchor_domain
            .as_ref()
            .is_some_and(|domain| domain.images.load(Ordering::Relaxed) != 0)
    }

    pub(super) fn resize_image(&mut self, anchor: &GridAnchor, bounds: ImageAnchorBounds) -> bool {
        if self.resolve_anchor(anchor).is_none() {
            return false;
        }
        let Some(image) = &anchor.state.image else {
            return false;
        };
        let mut image = image.lock();
        let previous = (image.bounds, image.clip);
        if !image.resize(bounds) {
            return false;
        }
        let changed = previous != (image.bounds, image.clip);
        drop(image);
        if changed {
            anchor.state.changed();
        }
        true
    }

    /// Save surviving portions before the oldest rows lose their storage. The
    /// first surviving row becomes the attachment; its clip retains the original
    /// sampling origin. Work is proportional to discarded rows and their images.
    /// The cutoff may lie below the screen: a scroll longer than every retained
    /// row still carries a taller image's tail the whole distance.
    pub(super) fn preserve_image_tails(&mut self, cutoff: i64, shift: i64) -> ImageMotion {
        let mut motion = ImageMotion::default();
        if !self.has_images() {
            return motion;
        }
        let oldest = self.visible_lines as i32 - self.len as i32;
        let end = cutoff.min(self.visible_lines as i64) as i32;
        let target = cutoff + shift;
        let has_target = target < self.visible_lines as i64;
        for line in oldest..end {
            let row = &mut self[Line(line)];
            if let Some(anchors) = &mut row.anchors {
                anchors.extract_images(|state| {
                    let survives = {
                        let mut image = state.image.as_ref().expect("image attachment").lock();
                        let (_, bottom) = image.vertical(line);
                        if bottom <= (i128::from(cutoff) << 32) {
                            false
                        } else {
                            let origin = i64::from(line) - (image.clip.top >> 32) as i64;
                            image.clip.top = ((cutoff - origin) as u64) << 32;
                            image.record_clip();
                            true
                        }
                    };
                    if survives && has_target {
                        state.changed();
                        motion.push(Arc::clone(state), target as i32);
                    } else {
                        state.retire(true);
                    }
                    true
                });
            }
            row.prune_anchors();
        }
        motion
    }

    /// Images straddling a page margin stay fixed even when their anchor cell
    /// scrolls. Contained images move and acquire a permanent destination scissor.
    pub(super) fn prepare_image_scroll(
        &mut self,
        start: i32,
        end: i32,
        delta: i32,
        full_screen: bool,
    ) -> ImageMotion {
        let mut motion = ImageMotion::default();
        if !self.has_images() {
            return motion;
        }
        // A top-aligned partial page scroll rotates text history as well. Images
        // outside that page must remain fixed, including a visible tail whose
        // attachment is in history. Preserve them before the ring retires rows.
        let first = if !full_screen && start == 0 && delta < 0 {
            self.visible_lines as i32 - self.len as i32
        } else {
            start
        };
        for line in first..end {
            let row = &mut self[Line(line)];
            if let Some(anchors) = &mut row.anchors {
                anchors.extract_images(|state| {
                    let target = {
                        let mut image = state.image.as_ref().expect("image attachment").lock();
                        let (top, bottom) = image.vertical(line);
                        if !full_screen
                            && (top < (i128::from(start) << 32) || bottom > (i128::from(end) << 32))
                        {
                            Some(line)
                        } else {
                            let origin =
                                i64::from(line) - (image.clip.top >> 32) as i64 + i64::from(delta);
                            let first = i128::from(image.clip.top)
                                .max(i128::from(i64::from(start) - origin) << 32);
                            let last = i128::from(image.clip.bottom)
                                .min(i128::from(i64::from(end) - origin) << 32);
                            if first < last {
                                let changed = image.clip.top != first as u64
                                    || image.clip.bottom != last as u64;
                                image.clip.top = first as u64;
                                image.clip.bottom = last as u64;
                                if changed {
                                    image.record_clip();
                                    state.changed();
                                }
                                Some((origin + (image.clip.top >> 32) as i64) as i32)
                            } else {
                                None
                            }
                        }
                    };
                    if let Some(target) = target {
                        // The existing row movement already does exactly this.
                        // Keep the admitted row/tree storage and avoid even an
                        // Arc increment for ordinary movement inside the margins.
                        if target == line + delta {
                            return false;
                        }
                        motion.push(Arc::clone(state), target);
                    } else {
                        state.retire(true);
                    }
                    true
                });
            }
            row.prune_anchors();
        }
        motion
    }

    pub(super) fn restore_images(&mut self, mut motion: ImageMotion) {
        while let Some((state, line)) = motion.pop() {
            let slot = self.compute_index(Line(line));
            state.set_slot(slot as u32);
            self.inner[slot]
                .anchors
                .get_or_insert_with(Default::default)
                .add(state);
        }
    }

    pub(super) fn retire_images_intersecting(&mut self, top: i32, bottom: i32) {
        if !self.has_images() {
            return;
        }
        let oldest = self.visible_lines as i32 - self.len as i32;
        for line in oldest..bottom.min(self.visible_lines as i32) {
            let row = &mut self[Line(line)];
            if let Some(anchors) = &mut row.anchors {
                anchors.retire_intersecting_images(line, top, bottom);
            }
            row.prune_anchors();
        }
    }

    pub(super) fn resolve_anchor(&self, anchor: &GridAnchor) -> Option<Point> {
        if !Arc::ptr_eq(self.anchor_domain.as_ref()?, &anchor.domain) {
            return None;
        }
        let (slot, column) = anchor.state.position()?;
        if slot >= self.inner.len() {
            return None;
        }
        let positive = if slot >= self.zero {
            slot - self.zero
        } else {
            slot + self.inner.len() - self.zero
        };
        if positive >= self.len {
            return None;
        }
        let line = i32::try_from(self.visible_lines as i64 - positive as i64 - 1).ok()?;
        Some(Point::new(Line(line), Column(column)))
    }

    pub(super) fn remove_anchor(&mut self, anchor: &GridAnchor) -> bool {
        let Some(point) = self.resolve_anchor(anchor) else {
            return false;
        };
        let row = &mut self[point.line];
        let removed = row
            .anchors
            .as_mut()
            .is_some_and(|anchors| anchors.remove(&anchor.state));
        row.prune_anchors();
        removed
    }
}

impl<T> Index<Line> for Storage<T> {
    type Output = Row<T>;

    #[inline]
    fn index(&self, index: Line) -> &Self::Output {
        let index = self.compute_index(index);
        &self.inner[index]
    }
}

impl<T> IndexMut<Line> for Storage<T> {
    #[inline]
    fn index_mut(&mut self, index: Line) -> &mut Self::Output {
        let index = self.compute_index(index);
        &mut self.inner[index]
    }
}

#[cfg(test)]
mod tests {
    use crate::grid::GridCell;
    use crate::grid::row::Row;
    use crate::grid::storage::{MAX_CACHE_SIZE, Storage};
    use crate::index::{Column, Line};
    use crate::term::cell::Flags;

    impl GridCell for char {
        fn is_empty(&self) -> bool {
            *self == ' ' || *self == '\t'
        }

        fn reset(&mut self, template: &Self) {
            *self = *template;
        }

        fn flags(&self) -> &Flags {
            unimplemented!();
        }

        fn flags_mut(&mut self) -> &mut Flags {
            unimplemented!();
        }
    }

    #[test]
    fn with_capacity() {
        let storage = Storage::<char>::with_capacity(3, 1);

        assert_eq!(storage.inner.len(), 3);
        assert_eq!(storage.len, 3);
        assert_eq!(storage.zero, 0);
        assert_eq!(storage.visible_lines, 3);
    }

    #[test]
    fn indexing() {
        let mut storage = Storage::<char>::with_capacity(3, 1);

        storage[Line(0)] = filled_row('0');
        storage[Line(1)] = filled_row('1');
        storage[Line(2)] = filled_row('2');

        storage.zero += 1;

        assert_eq!(storage[Line(0)], filled_row('2'));
        assert_eq!(storage[Line(1)], filled_row('0'));
        assert_eq!(storage[Line(2)], filled_row('1'));
    }

    #[test]
    #[should_panic]
    #[cfg(debug_assertions)]
    fn indexing_above_inner_len() {
        let storage = Storage::<char>::with_capacity(1, 1);
        let _ = &storage[Line(-1)];
    }

    #[test]
    fn rotate() {
        let mut storage = Storage::<char>::with_capacity(3, 1);
        storage.rotate(2);
        assert_eq!(storage.zero, 2);
        storage.shrink_lines(2);
        assert_eq!(storage.len, 1);
        assert_eq!(storage.inner.len(), 3);
        assert_eq!(storage.zero, 2);
    }

    /// Grow the buffer one line at the end of the buffer.
    ///
    /// Before:
    ///   0: 0 <- Zero
    ///   1: 1
    ///   2: -
    /// After:
    ///   0: 0 <- Zero
    ///   1: 1
    ///   2: -
    ///   3: \0
    ///   ...
    ///   MAX_CACHE_SIZE: \0
    #[test]
    fn grow_after_zero() {
        // Setup storage area.
        let mut storage: Storage<char> = Storage {
            inner: vec![filled_row('0'), filled_row('1'), filled_row('-')],
            zero: 0,
            visible_lines: 3,
            len: 3,
            anchor_domain: None,
        };

        // Grow buffer.
        storage.grow_visible_lines(4);

        // Make sure the result is correct.
        let mut expected = Storage {
            inner: vec![filled_row('0'), filled_row('1'), filled_row('-')],
            zero: 0,
            visible_lines: 4,
            len: 4,
            anchor_domain: None,
        };
        expected
            .inner
            .append(&mut vec![filled_row('\0'); MAX_CACHE_SIZE]);

        assert_eq!(storage.visible_lines, expected.visible_lines);
        assert_eq!(storage.inner, expected.inner);
        assert_eq!(storage.zero, expected.zero);
        assert_eq!(storage.len, expected.len);
    }

    /// Grow the buffer one line at the start of the buffer.
    ///
    /// Before:
    ///   0: -
    ///   1: 0 <- Zero
    ///   2: 1
    /// After:
    ///   0: 0 <- Zero
    ///   1: 1
    ///   2: -
    ///   3: \0
    ///   ...
    ///   MAX_CACHE_SIZE: \0
    #[test]
    fn grow_before_zero() {
        // Setup storage area.
        let mut storage: Storage<char> = Storage {
            inner: vec![filled_row('-'), filled_row('0'), filled_row('1')],
            zero: 1,
            visible_lines: 3,
            len: 3,
            anchor_domain: None,
        };

        // Grow buffer.
        storage.grow_visible_lines(4);

        // Make sure the result is correct.
        let mut expected = Storage {
            inner: vec![filled_row('0'), filled_row('1'), filled_row('-')],
            zero: 0,
            visible_lines: 4,
            len: 4,
            anchor_domain: None,
        };
        expected
            .inner
            .append(&mut vec![filled_row('\0'); MAX_CACHE_SIZE]);

        assert_eq!(storage.visible_lines, expected.visible_lines);
        assert_eq!(storage.inner, expected.inner);
        assert_eq!(storage.zero, expected.zero);
        assert_eq!(storage.len, expected.len);
    }

    /// Shrink the buffer one line at the start of the buffer.
    ///
    /// Before:
    ///   0: 2
    ///   1: 0 <- Zero
    ///   2: 1
    /// After:
    ///   0: 2 <- Hidden
    ///   0: 0 <- Zero
    ///   1: 1
    #[test]
    fn shrink_before_zero() {
        // Setup storage area.
        let mut storage: Storage<char> = Storage {
            inner: vec![filled_row('2'), filled_row('0'), filled_row('1')],
            zero: 1,
            visible_lines: 3,
            len: 3,
            anchor_domain: None,
        };

        // Shrink buffer.
        storage.shrink_visible_lines(2);

        // Make sure the result is correct.
        let expected = Storage {
            inner: vec![filled_row('2'), filled_row('0'), filled_row('1')],
            zero: 1,
            visible_lines: 2,
            len: 2,
            anchor_domain: None,
        };
        assert_eq!(storage.visible_lines, expected.visible_lines);
        assert_eq!(storage.inner, expected.inner);
        assert_eq!(storage.zero, expected.zero);
        assert_eq!(storage.len, expected.len);
    }

    /// Shrink the buffer one line at the end of the buffer.
    ///
    /// Before:
    ///   0: 0 <- Zero
    ///   1: 1
    ///   2: 2
    /// After:
    ///   0: 0 <- Zero
    ///   1: 1
    ///   2: 2 <- Hidden
    #[test]
    fn shrink_after_zero() {
        // Setup storage area.
        let mut storage: Storage<char> = Storage {
            inner: vec![filled_row('0'), filled_row('1'), filled_row('2')],
            zero: 0,
            visible_lines: 3,
            len: 3,
            anchor_domain: None,
        };

        // Shrink buffer.
        storage.shrink_visible_lines(2);

        // Make sure the result is correct.
        let expected = Storage {
            inner: vec![filled_row('0'), filled_row('1'), filled_row('2')],
            zero: 0,
            visible_lines: 2,
            len: 2,
            anchor_domain: None,
        };
        assert_eq!(storage.visible_lines, expected.visible_lines);
        assert_eq!(storage.inner, expected.inner);
        assert_eq!(storage.zero, expected.zero);
        assert_eq!(storage.len, expected.len);
    }

    /// Shrink the buffer at the start and end of the buffer.
    ///
    /// Before:
    ///   0: 4
    ///   1: 5
    ///   2: 0 <- Zero
    ///   3: 1
    ///   4: 2
    ///   5: 3
    /// After:
    ///   0: 4 <- Hidden
    ///   1: 5 <- Hidden
    ///   2: 0 <- Zero
    ///   3: 1
    ///   4: 2 <- Hidden
    ///   5: 3 <- Hidden
    #[test]
    fn shrink_before_and_after_zero() {
        // Setup storage area.
        let mut storage: Storage<char> = Storage {
            inner: vec![
                filled_row('4'),
                filled_row('5'),
                filled_row('0'),
                filled_row('1'),
                filled_row('2'),
                filled_row('3'),
            ],
            zero: 2,
            visible_lines: 6,
            len: 6,
            anchor_domain: None,
        };

        // Shrink buffer.
        storage.shrink_visible_lines(2);

        // Make sure the result is correct.
        let expected = Storage {
            inner: vec![
                filled_row('4'),
                filled_row('5'),
                filled_row('0'),
                filled_row('1'),
                filled_row('2'),
                filled_row('3'),
            ],
            zero: 2,
            visible_lines: 2,
            len: 2,
            anchor_domain: None,
        };
        assert_eq!(storage.visible_lines, expected.visible_lines);
        assert_eq!(storage.inner, expected.inner);
        assert_eq!(storage.zero, expected.zero);
        assert_eq!(storage.len, expected.len);
    }

    /// Check that when truncating all hidden lines are removed from the raw buffer.
    ///
    /// Before:
    ///   0: 4 <- Hidden
    ///   1: 5 <- Hidden
    ///   2: 0 <- Zero
    ///   3: 1
    ///   4: 2 <- Hidden
    ///   5: 3 <- Hidden
    /// After:
    ///   0: 0 <- Zero
    ///   1: 1
    #[test]
    fn truncate_invisible_lines() {
        // Setup storage area.
        let mut storage: Storage<char> = Storage {
            inner: vec![
                filled_row('4'),
                filled_row('5'),
                filled_row('0'),
                filled_row('1'),
                filled_row('2'),
                filled_row('3'),
            ],
            zero: 2,
            visible_lines: 1,
            len: 2,
            anchor_domain: None,
        };

        // Truncate buffer.
        storage.truncate();

        // Make sure the result is correct.
        let expected = Storage {
            inner: vec![filled_row('0'), filled_row('1')],
            zero: 0,
            visible_lines: 1,
            len: 2,
            anchor_domain: None,
        };
        assert_eq!(storage.visible_lines, expected.visible_lines);
        assert_eq!(storage.inner, expected.inner);
        assert_eq!(storage.zero, expected.zero);
        assert_eq!(storage.len, expected.len);
    }

    /// Truncate buffer only at the beginning.
    ///
    /// Before:
    ///   0: 1
    ///   1: 2 <- Hidden
    ///   2: 0 <- Zero
    /// After:
    ///   0: 1
    ///   0: 0 <- Zero
    #[test]
    fn truncate_invisible_lines_beginning() {
        // Setup storage area.
        let mut storage: Storage<char> = Storage {
            inner: vec![filled_row('1'), filled_row('2'), filled_row('0')],
            zero: 2,
            visible_lines: 1,
            len: 2,
            anchor_domain: None,
        };

        // Truncate buffer.
        storage.truncate();

        // Make sure the result is correct.
        let expected = Storage {
            inner: vec![filled_row('0'), filled_row('1')],
            zero: 0,
            visible_lines: 1,
            len: 2,
            anchor_domain: None,
        };
        assert_eq!(storage.visible_lines, expected.visible_lines);
        assert_eq!(storage.inner, expected.inner);
        assert_eq!(storage.zero, expected.zero);
        assert_eq!(storage.len, expected.len);
    }

    /// First shrink the buffer and then grow it again.
    ///
    /// Before:
    ///   0: 4
    ///   1: 5
    ///   2: 0 <- Zero
    ///   3: 1
    ///   4: 2
    ///   5: 3
    /// After Shrinking:
    ///   0: 4 <- Hidden
    ///   1: 5 <- Hidden
    ///   2: 0 <- Zero
    ///   3: 1
    ///   4: 2
    ///   5: 3 <- Hidden
    /// After Growing:
    ///   0: 4
    ///   1: 5
    ///   2: -
    ///   3: 0 <- Zero
    ///   4: 1
    ///   5: 2
    ///   6: 3
    #[test]
    fn shrink_then_grow() {
        // Setup storage area.
        let mut storage: Storage<char> = Storage {
            inner: vec![
                filled_row('4'),
                filled_row('5'),
                filled_row('0'),
                filled_row('1'),
                filled_row('2'),
                filled_row('3'),
            ],
            zero: 2,
            visible_lines: 0,
            len: 6,
            anchor_domain: None,
        };

        // Shrink buffer.
        storage.shrink_lines(3);

        // Make sure the result after shrinking is correct.
        let shrinking_expected = Storage {
            inner: vec![
                filled_row('4'),
                filled_row('5'),
                filled_row('0'),
                filled_row('1'),
                filled_row('2'),
                filled_row('3'),
            ],
            zero: 2,
            visible_lines: 0,
            len: 3,
            anchor_domain: None,
        };
        assert_eq!(storage.inner, shrinking_expected.inner);
        assert_eq!(storage.zero, shrinking_expected.zero);
        assert_eq!(storage.len, shrinking_expected.len);

        // Grow buffer.
        storage.initialize(1, 1);

        // Make sure the previously freed elements are reused.
        let growing_expected = Storage {
            inner: vec![
                filled_row('4'),
                filled_row('5'),
                filled_row('0'),
                filled_row('1'),
                filled_row('2'),
                filled_row('3'),
            ],
            zero: 2,
            visible_lines: 0,
            len: 4,
            anchor_domain: None,
        };

        assert_eq!(storage.inner, growing_expected.inner);
        assert_eq!(storage.zero, growing_expected.zero);
        assert_eq!(storage.len, growing_expected.len);
    }

    #[test]
    fn initialize() {
        // Setup storage area.
        let mut storage: Storage<char> = Storage {
            inner: vec![
                filled_row('4'),
                filled_row('5'),
                filled_row('0'),
                filled_row('1'),
                filled_row('2'),
                filled_row('3'),
            ],
            zero: 2,
            visible_lines: 0,
            len: 6,
            anchor_domain: None,
        };

        // Initialize additional lines.
        let init_size = 3;
        storage.initialize(init_size, 1);

        // Generate expected grid.
        let mut expected_inner = vec![
            filled_row('0'),
            filled_row('1'),
            filled_row('2'),
            filled_row('3'),
            filled_row('4'),
            filled_row('5'),
        ];
        let expected_init_size = std::cmp::max(init_size, MAX_CACHE_SIZE);
        expected_inner.append(&mut vec![filled_row('\0'); expected_init_size]);
        let expected_storage = Storage {
            inner: expected_inner,
            zero: 0,
            visible_lines: 0,
            len: 9,
            anchor_domain: None,
        };

        assert_eq!(storage.len, expected_storage.len);
        assert_eq!(storage.zero, expected_storage.zero);
        assert_eq!(storage.inner, expected_storage.inner);
    }

    #[test]
    fn rotate_wrap_zero() {
        let mut storage: Storage<char> = Storage {
            inner: vec![filled_row('-'), filled_row('-'), filled_row('-')],
            zero: 2,
            visible_lines: 0,
            len: 3,
            anchor_domain: None,
        };

        storage.rotate(2);

        assert!(storage.zero < storage.inner.len());
    }

    fn filled_row(content: char) -> Row<char> {
        let mut row = Row::new(1);
        row[Column(0)] = content;
        row
    }
}
