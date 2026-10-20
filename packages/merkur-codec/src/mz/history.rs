//! The receiver's history of the rows it applied, which MZ references read.

use super::frame::{MzError, MzReference, encode_full_row_entry, reference_hash};
use crate::CellRepr;
use std::collections::{HashMap, VecDeque};
use std::hash::{BuildHasherDefault, Hasher};

/// The most datagrams, by sequence, a reference reaches back from the frame
/// carrying it, on any grid. A wire fact: a reference past it is corrupt.
pub const MZ_REFERENCE_DATAGRAMS: u32 = 512;

/// A resource bound: the cells a receiver's history holds across its window,
/// 32 MiB of them. A datagram writes each row at most once, so a window of `w`
/// datagrams holds at most `w` grids of cells, plus one chain per row from
/// before it.
pub const MZ_HISTORY_CELLS: u64 = (32 << 20) / std::mem::size_of::<CellRepr>() as u64;

/// The datagrams a reference may reach back on a `cols` by `rows` grid: the
/// most whose history, twice this window, fits [`MZ_HISTORY_CELLS`], up to
/// [`MZ_REFERENCE_DATAGRAMS`]. Both ends compute it from the grid's geometry.
///
/// The receiver keeps twice the window ([`mz_history_datagrams`]), so a frame
/// that arrives up to a window after newer ones still resolves; one later than
/// that was declared lost long before and is resent.
pub fn mz_reference_datagrams(cols: u16, rows: u16) -> u32 {
    let grid = u64::from(cols.max(1)) * u64::from(rows.max(1));
    u32::try_from(MZ_HISTORY_CELLS / (2 * grid)).map_or(MZ_REFERENCE_DATAGRAMS, |window| {
        window.clamp(1, MZ_REFERENCE_DATAGRAMS)
    })
}

/// The datagrams a receiver keeps rows from on a `cols` by `rows` grid.
pub fn mz_history_datagrams(cols: u16, rows: u16) -> u32 {
    2 * mz_reference_datagrams(cols, rows)
}

/// Spans a row's chain may hold past its last complete row before the next
/// span is stored complete instead. A resource bound on the work one
/// reference costs (rebuilding a row applies at most this many spans) and on
/// what a row keeps past the history window (one chain).
const CHAIN_SPANS: u8 = 32;

/// Whether sequence `a` is older than `b` in the wrapping sequence space.
#[inline]
fn older(a: u32, b: u32) -> bool {
    matches!(b.wrapping_sub(a), 1..0x8000_0000)
}

/// Entry keys are a sequence and a row; one multiply spreads both over the
/// bits the table indexes with, where the default hasher cost more than the
/// rest of recording an entry.
#[derive(Default)]
struct EntryHasher(u64);

impl Hasher for EntryHasher {
    fn finish(&self) -> u64 {
        self.0
    }

    #[expect(
        clippy::unreachable,
        reason = "the only key type is `u64`, which hashes through `write_u64`"
    )]
    fn write(&mut self, _: &[u8]) {
        unreachable!("entry keys hash as one u64");
    }

    fn write_u64(&mut self, value: u64) {
        let mixed = value.wrapping_mul(0x9e37_79b9_7f4a_7c15);
        self.0 = mixed ^ (mixed >> 32);
    }
}

#[inline]
fn entry_key(seq: u32, row: u16) -> u64 {
    u64::from(seq) << 16 | u64::from(row)
}

struct Record {
    seq: u32,
    left: u16,
    len: u16,
    /// Global offset of this record's cells in its row's arena.
    at: u64,
    /// The cells are the complete row.
    full: bool,
    /// The record before this one in its row's list is the state it applied
    /// over. False after something the history did not see changed the row.
    linked: bool,
    /// Spans since the chain's last complete row, this one included.
    depth: u8,
    /// Where this record's cells began when it was recorded. Offsets grow with
    /// record order, so the arena may drop everything before the oldest
    /// record's.
    arena_at: u64,
}

/// One row's records, in the order the grid applied them.
#[derive(Default)]
struct Row {
    records: VecDeque<Record>,
    /// Id of `records[0]`; ids count this row's records.
    base: u64,
    arena: VecDeque<CellRepr>,
    arena_base: u64,
    /// The next record applies over the newest one, whose chain reaches a
    /// complete row.
    chained: bool,
}

impl Row {
    fn get(&self, id: u64) -> Option<&Record> {
        id.checked_sub(self.base)
            .and_then(|index| usize::try_from(index).ok())
            .and_then(|index| self.records.get(index))
    }

    fn end(&self) -> u64 {
        self.arena_base + self.arena.len() as u64
    }

    /// Rebuild record `id`'s complete row into `cells`.
    fn materialize(&self, id: u64, cols: u16, cells: &mut Vec<CellRepr>) -> bool {
        let mut start = id;
        loop {
            let Some(record) = self.get(start) else {
                return false;
            };
            if record.full {
                break;
            }
            if !record.linked {
                return false;
            }
            start -= 1;
        }
        cells.clear();
        for id in start..=id {
            let Some(record) = self.get(id) else {
                return false;
            };
            let Ok(at) = usize::try_from(record.at - self.arena_base) else {
                return false;
            };
            let len = usize::from(record.len);
            if record.full {
                cells.clear();
                cells.extend(self.arena.range(at..at + len).copied());
                continue;
            }
            let left = usize::from(record.left);
            let Some(span) = cells.get_mut(left..left + len) else {
                return false;
            };
            for (cell, recorded) in span.iter_mut().zip(self.arena.range(at..at + len)) {
                *cell = *recorded;
            }
        }
        cells.len() == usize::from(cols)
    }
}

/// What a receiver applied to each row, kept so a reference to a row as one of
/// its datagrams left it can be rebuilt whatever arrived since.
///
/// Recording is a copy of the cells an entry wrote. Each row's records chain
/// in the order they were applied, back to a complete row: a full-row entry, a
/// row the caller read back, or one the chain bound or a reference already
/// rebuilt. A reference rebuilds exactly what the grid held after that
/// datagram. A row retires a whole chain once no reference can name any of it,
/// so retiring never rebuilds a row.
#[derive(Default)]
pub struct RowHistory {
    cols: u16,
    grid_rows: u16,
    /// [`mz_reference_datagrams`] of the grid.
    window: u32,
    rows: Vec<Row>,
    by_entry: HashMap<u64, u64, BuildHasherDefault<EntryHasher>>,
    newest: Option<u32>,
    cells: Vec<CellRepr>,
}

impl RowHistory {
    /// Forget everything: the grid these records describe is gone.
    pub fn clear(&mut self) {
        self.rows.clear();
        self.by_entry.clear();
        self.newest = None;
        self.cols = 0;
        self.grid_rows = 0;
        self.window = 0;
    }

    /// The grid applied `cells` at column `left` of `row`, from the frame with
    /// sequence `seq`, on a grid `cols` by `rows`. Every cell of the entry
    /// must have been written; a row an entry wrote only partly is
    /// [`Self::invalidate_row`]. A span on a row that is not
    /// [`Self::row_chained`] is recorded but never rebuilds, and leaves the row
    /// unchained.
    pub fn record(
        &mut self,
        seq: u32,
        row: u16,
        left: u16,
        cells: &[CellRepr],
        cols: u16,
        rows: u16,
    ) {
        if cols != self.cols || rows != self.grid_rows {
            self.clear();
            self.cols = cols;
            self.grid_rows = rows;
            self.window = mz_reference_datagrams(cols, rows);
        }
        // No row holds more cells than a `u16` counts.
        let Ok(len) = u16::try_from(cells.len()) else {
            self.invalidate_row(row);
            return;
        };
        if self.newest.is_none_or(|newest| older(newest, seq)) {
            self.newest = Some(seq);
        }
        let row_index = usize::from(row);
        if self.rows.len() <= row_index {
            self.rows.resize_with(row_index + 1, Row::default);
        }
        self.retire_row(row);
        #[expect(
            clippy::indexing_slicing,
            reason = "the rows were extended to `row` above"
        )]
        let entry = &mut self.rows[row_index];
        let id = entry.base + entry.records.len() as u64;
        let at = entry.end();
        let mut record = Record {
            seq,
            left,
            len,
            at,
            full: left == 0 && cells.len() == usize::from(cols),
            linked: entry.chained,
            depth: 0,
            arena_at: at,
        };
        if record.full {
            entry.arena.extend(cells.iter().copied());
        } else {
            let previous = entry.records.back().filter(|_| entry.chained);
            record.depth = previous.map_or(1, |previous| previous.depth.saturating_add(1));
            let start = usize::from(left);
            if record.depth > CHAIN_SPANS
                && entry.materialize(id - 1, cols, &mut self.cells)
                && let Some(span) = self.cells.get_mut(start..start + cells.len())
            {
                span.copy_from_slice(cells);
                entry.arena.extend(self.cells.iter().copied());
                record.full = true;
                record.depth = 0;
                record.left = 0;
                record.len = cols;
            } else {
                entry.arena.extend(cells.iter().copied());
            }
        }
        entry.chained = record.full || record.linked;
        entry.records.push_back(record);
        self.by_entry.insert(entry_key(seq, row), id);
    }

    /// Whether `row`'s records chain back to a complete row, so a span the
    /// grid writes next can be recorded as a span. When they do not, the
    /// caller records the complete row the grid holds after the write.
    pub fn row_chained(&self, row: u16) -> bool {
        self.rows
            .get(usize::from(row))
            .is_some_and(|row| row.chained)
    }

    /// Something other than a recorded entry changed `row`: what it holds can
    /// no longer be rebuilt from the records, until a full row is written.
    pub fn invalidate_row(&mut self, row: u16) {
        if let Some(row) = self.rows.get_mut(usize::from(row)) {
            row.chained = false;
        }
    }

    /// Drop the chains of `row` no reference can still name: every record
    /// older than the window before the chain the rest builds on.
    fn retire_row(&mut self, row: u16) {
        let Some(newest) = self.newest else {
            return;
        };
        let floor = newest.wrapping_sub(2 * self.window);
        let Some(entry) = self.rows.get_mut(usize::from(row)) else {
            return;
        };
        if entry.records.is_empty() {
            return;
        }
        let old = entry
            .records
            .iter()
            .take_while(|record| older(record.seq, floor))
            .count();
        // Up to the newest complete row at or before the first record still in
        // the window, which the rest of the window builds on. When every record
        // is older, the newest chain is what the row holds now and what its
        // next span applies over, so it stays while the row is chained.
        let keep = if old == entry.records.len() && !entry.chained {
            old
        } else {
            (0..=old.min(entry.records.len() - 1))
                .rev()
                .find(|&index| entry.records.get(index).is_some_and(|record| record.full))
                .unwrap_or(0)
        };
        if keep == 0 {
            return;
        }
        for record in entry.records.drain(..keep) {
            let id = entry.base;
            entry.base += 1;
            if self.by_entry.get(&entry_key(record.seq, row)) == Some(&id) {
                self.by_entry.remove(&entry_key(record.seq, row));
            }
        }
        if entry.records.is_empty() {
            entry.chained = false;
        }
        let keep_from = entry
            .records
            .front()
            .map_or(entry.end(), |front| front.arena_at);
        // The front record's cells are in the arena, so this never passes its end.
        let drop = usize::try_from(keep_from.saturating_sub(entry.arena_base))
            .map_or(entry.arena.len(), |drop| drop.min(entry.arena.len()));
        entry.arena.drain(..drop);
        entry.arena_base += drop as u64;
    }

    /// Resolve `reference`, carried by the frame with presentation id
    /// `presentation_id`, into the full-row entry for `target_row`.
    pub fn resolve(
        &mut self,
        presentation_id: u32,
        target_row: u16,
        reference: MzReference,
        out: &mut Vec<u8>,
    ) -> Result<(), MzError> {
        if reference.seq_delta > MZ_REFERENCE_DATAGRAMS {
            return Err(MzError::Corrupt);
        }
        // Past this grid's window the source may be retired.
        if reference.seq_delta > self.window {
            return Err(MzError::Unresolved);
        }
        let source_seq = presentation_id.wrapping_sub(reference.seq_delta);
        let id = *self
            .by_entry
            .get(&entry_key(source_seq, reference.source_row))
            .ok_or(MzError::Unresolved)?;
        let row = self
            .rows
            .get_mut(usize::from(reference.source_row))
            .ok_or(MzError::Unresolved)?;
        if !row.materialize(id, self.cols, &mut self.cells) {
            return Err(MzError::Unresolved);
        }
        // Links resolve through a table the row's own datagram delivered, so
        // a linked row never stands in for another.
        if self.cells.iter().any(|cell| cell.link != 0)
            || reference_hash(&self.cells) != reference.hash
        {
            return Err(MzError::Unresolved);
        }
        encode_full_row_entry(out, target_row, &self.cells);
        Ok(())
    }

    /// Cells held, for tests and memory accounting.
    pub fn held_cells(&self) -> usize {
        self.rows.iter().map(|row| row.arena.len()).sum()
    }
}
