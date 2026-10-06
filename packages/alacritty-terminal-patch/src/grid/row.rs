//! Defines the Row type which makes up lines in the grid.

use std::cmp::{max, min};
use std::ops::{Index, IndexMut, Range, RangeFrom, RangeFull, RangeTo, RangeToInclusive};
use std::{ptr, slice};

#[cfg(feature = "serde")]
use serde::{Deserialize, Serialize};

use super::anchor::Anchors;
use crate::grid::GridCell;
use crate::index::Column;
use crate::term::cell::ResetDiscriminant;

/// A row in the grid.
#[derive(Default, Debug)]
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
pub struct Row<T> {
    inner: Vec<T>,

    /// Maximum number of occupied entries.
    ///
    /// This is the upper bound on the number of elements in the row, which have been modified
    /// since the last reset. All cells after this point are guaranteed to be equal.
    pub(crate) occ: usize,
    #[cfg_attr(feature = "serde", serde(skip))]
    pub(super) anchors: Option<Box<Anchors>>,
}

impl<T: Clone> Clone for Row<T> {
    fn clone(&self) -> Self {
        Self {
            inner: self.inner.clone(),
            occ: self.occ,
            anchors: None,
        }
    }
}

impl<T: PartialEq> PartialEq for Row<T> {
    fn eq(&self, other: &Self) -> bool {
        self.inner == other.inner
    }
}

impl<T: Default> Row<T> {
    /// Create a new terminal row.
    ///
    /// Ideally the `template` should be `Copy` in all performance sensitive scenarios.
    pub fn new(columns: usize) -> Row<T> {
        debug_assert!(columns >= 1);

        let mut inner: Vec<T> = Vec::with_capacity(columns);

        // This is a slightly optimized version of `std::vec::Vec::resize`.
        unsafe {
            let mut ptr = inner.as_mut_ptr();

            for _ in 1..columns {
                ptr::write(ptr, T::default());
                ptr = ptr.offset(1);
            }
            ptr::write(ptr, T::default());

            inner.set_len(columns);
        }

        Row {
            inner,
            occ: 0,
            anchors: None,
        }
    }

    /// Increase the number of columns in the row.
    #[inline]
    pub fn grow(&mut self, columns: usize) {
        if self.inner.len() >= columns {
            return;
        }

        self.inner.resize_with(columns, T::default);
    }

    /// Reduce the number of columns in the row.
    ///
    /// This will return all non-empty cells that were removed.
    pub fn shrink(&mut self, columns: usize) -> Option<Row<T>>
    where
        T: GridCell,
    {
        if self.inner.len() <= columns {
            return None;
        }

        // Split off cells for a new row.
        let mut new_row = self.split_off(columns);
        let index = new_row
            .inner
            .iter()
            .rposition(|c| !c.is_empty())
            .map_or(0, |i| i + 1);
        let extent = new_row
            .anchors
            .as_ref()
            .map_or(0, |anchors| anchors.extent());
        new_row.truncate(max(index, extent));

        self.occ = min(self.occ, columns);

        if new_row.len() == 0 {
            None
        } else {
            Some(new_row)
        }
    }

    /// Reset all cells in the row to the `template` cell.
    #[inline]
    pub fn reset<D>(&mut self, template: &T)
    where
        T: ResetDiscriminant<D> + GridCell,
        D: PartialEq,
    {
        debug_assert!(!self.inner.is_empty());

        // Mark all cells as dirty if template cell changed.
        let len = self.inner.len();
        if self.inner[len - 1].discriminant() != template.discriminant() {
            self.occ = len;
        }

        // Reset every dirty cell in the row.
        for item in &mut self.inner[0..self.occ] {
            item.reset(template);
        }

        self.occ = 0;
    }
}

#[allow(clippy::len_without_is_empty)]
impl<T> Row<T> {
    #[inline]
    pub fn from_vec(vec: Vec<T>, occ: usize) -> Row<T> {
        Row {
            inner: vec,
            occ,
            anchors: None,
        }
    }

    #[inline]
    pub fn len(&self) -> usize {
        self.inner.len()
    }

    #[inline]
    pub fn last(&self) -> Option<&T> {
        self.inner.last()
    }

    #[inline]
    pub fn last_mut(&mut self) -> Option<&mut T> {
        self.occ = self.inner.len();
        self.inner.last_mut()
    }

    #[inline]
    pub fn append(&mut self, row: &mut Row<T>)
    where
        T: GridCell,
    {
        self.occ += row.len();
        if let Some(mut anchors) = row.anchors.take() {
            self.anchors
                .get_or_insert_with(Default::default)
                .append(&mut anchors, self.inner.len());
        }
        self.inner.append(&mut row.inner);
    }

    #[inline]
    pub fn append_front(&mut self, mut row: Row<T>) {
        self.occ += row.len();
        if let Some(mut anchors) = self.anchors.take() {
            row.anchors
                .get_or_insert_with(Default::default)
                .append(&mut anchors, row.inner.len());
        }
        row.inner.append(&mut self.inner);
        self.inner = row.inner;
        self.anchors = row.anchors;
    }

    /// Check if all cells in the row are empty.
    #[inline]
    pub fn is_clear(&self) -> bool
    where
        T: GridCell,
    {
        self.anchors.is_none() && self.inner.iter().all(GridCell::is_empty)
    }

    #[inline]
    pub fn front_split_off(&mut self, at: usize) -> Row<T> {
        let mut tail = self.split_off(at);
        std::mem::swap(self, &mut tail);
        tail
    }

    fn split_off(&mut self, at: usize) -> Row<T> {
        let inner = self.inner.split_off(at);
        let anchors = self.anchors.as_mut().and_then(|anchors| {
            let tail = anchors.split(at);
            (!tail.is_empty()).then(|| Box::new(tail))
        });
        self.prune_anchors();
        let occ = self.occ.saturating_sub(at);
        self.occ = min(self.occ, at);
        Row {
            inner,
            occ,
            anchors,
        }
    }

    pub(super) fn retire_anchors(&mut self) {
        self.anchors = None;
    }

    pub(super) fn prune_anchors(&mut self) {
        if self
            .anchors
            .as_ref()
            .is_some_and(|anchors| anchors.is_empty())
        {
            self.anchors = None;
        }
    }

    pub(super) fn refresh_anchor_slot(&self, slot: usize) {
        if let Some(anchors) = &self.anchors {
            anchors.set_slot(slot);
        }
    }

    /// Move attachments off a reflow-only spacer onto its following wide character.
    pub(super) fn move_tail_anchors(&mut self, column: usize, target: &mut Self) {
        if let Some(anchors) = &mut self.anchors {
            let mut tail = anchors.split(column);
            if !tail.is_empty() {
                target
                    .anchors
                    .get_or_insert_with(Default::default)
                    .append(&mut tail, 0);
            }
        }
        self.prune_anchors();
    }

    pub(super) fn push(&mut self, cell: T) {
        self.inner.push(cell);
        self.occ = self.inner.len();
    }

    pub(super) fn prepend(&mut self, cell: T) {
        if let Some(anchors) = &self.anchors {
            anchors.shift(1);
        }
        self.inner.insert(0, cell);
        self.occ = self.inner.len();
    }

    pub(super) fn truncate(&mut self, columns: usize) {
        if columns < self.inner.len() {
            drop(self.split_off(columns));
        }
    }
}

impl<'a, T> IntoIterator for &'a Row<T> {
    type IntoIter = slice::Iter<'a, T>;
    type Item = &'a T;

    #[inline]
    fn into_iter(self) -> slice::Iter<'a, T> {
        self.inner.iter()
    }
}

impl<'a, T> IntoIterator for &'a mut Row<T> {
    type IntoIter = slice::IterMut<'a, T>;
    type Item = &'a mut T;

    #[inline]
    fn into_iter(self) -> slice::IterMut<'a, T> {
        self.occ = self.len();
        self.inner.iter_mut()
    }
}

impl<T> Index<Column> for Row<T> {
    type Output = T;

    #[inline]
    fn index(&self, index: Column) -> &T {
        &self.inner[index.0]
    }
}

impl<T> IndexMut<Column> for Row<T> {
    #[inline]
    fn index_mut(&mut self, index: Column) -> &mut T {
        self.occ = max(self.occ, *index + 1);
        &mut self.inner[index.0]
    }
}

impl<T> Index<Range<Column>> for Row<T> {
    type Output = [T];

    #[inline]
    fn index(&self, index: Range<Column>) -> &[T] {
        &self.inner[(index.start.0)..(index.end.0)]
    }
}

impl<T> IndexMut<Range<Column>> for Row<T> {
    #[inline]
    fn index_mut(&mut self, index: Range<Column>) -> &mut [T] {
        self.occ = max(self.occ, *index.end);
        &mut self.inner[(index.start.0)..(index.end.0)]
    }
}

impl<T> Index<RangeTo<Column>> for Row<T> {
    type Output = [T];

    #[inline]
    fn index(&self, index: RangeTo<Column>) -> &[T] {
        &self.inner[..(index.end.0)]
    }
}

impl<T> IndexMut<RangeTo<Column>> for Row<T> {
    #[inline]
    fn index_mut(&mut self, index: RangeTo<Column>) -> &mut [T] {
        self.occ = max(self.occ, *index.end);
        &mut self.inner[..(index.end.0)]
    }
}

impl<T> Index<RangeFrom<Column>> for Row<T> {
    type Output = [T];

    #[inline]
    fn index(&self, index: RangeFrom<Column>) -> &[T] {
        &self.inner[(index.start.0)..]
    }
}

impl<T> IndexMut<RangeFrom<Column>> for Row<T> {
    #[inline]
    fn index_mut(&mut self, index: RangeFrom<Column>) -> &mut [T] {
        self.occ = self.len();
        &mut self.inner[(index.start.0)..]
    }
}

impl<T> Index<RangeFull> for Row<T> {
    type Output = [T];

    #[inline]
    fn index(&self, _: RangeFull) -> &[T] {
        &self.inner[..]
    }
}

impl<T> IndexMut<RangeFull> for Row<T> {
    #[inline]
    fn index_mut(&mut self, _: RangeFull) -> &mut [T] {
        self.occ = self.len();
        &mut self.inner[..]
    }
}

impl<T> Index<RangeToInclusive<Column>> for Row<T> {
    type Output = [T];

    #[inline]
    fn index(&self, index: RangeToInclusive<Column>) -> &[T] {
        &self.inner[..=(index.end.0)]
    }
}

impl<T> IndexMut<RangeToInclusive<Column>> for Row<T> {
    #[inline]
    fn index_mut(&mut self, index: RangeToInclusive<Column>) -> &mut [T] {
        self.occ = max(self.occ, *index.end + 1);
        &mut self.inner[..=(index.end.0)]
    }
}
