//! The receiver's history of the complete rows it received, which MZ copies
//! read, and the ledger both ends keep of what it holds.

use super::frame::{MzError, MzItem, MzRow, encode_full_row_entry, entry_items};
use crate::CellRepr;
use std::collections::HashMap;
use std::collections::hash_map::Entry;
use std::hash::{BuildHasherDefault, Hasher};

/// The most datagrams, by sequence, a copy reaches back from the frame
/// carrying it. A wire fact: a copy past it is corrupt.
pub const MZ_REFERENCE_DATAGRAMS: u32 = 512;

/// The datagrams a ledger keeps rows from: twice the reach, so a frame that
/// arrives up to a reach after newer ones still resolves; one later than that
/// was declared lost long before and is resent.
const LEDGER_DATAGRAMS: u32 = 2 * MZ_REFERENCE_DATAGRAMS;

/// A resource bound: the bytes of distinct rows a history holds. 8 MiB, twelve
/// times the most any replayed session held at the full reach.
pub const MZ_HISTORY_BYTES: usize = 8 << 20;

/// A resource bound: released row buffers a history keeps for reuse, one
/// tallest grid of rows.
const SPARE_ROWS: usize = crate::MAX_TERMINAL_ROWS;

/// Whether sequence `a` is older than `b` in the wrapping sequence space.
#[inline]
fn older(a: u32, b: u32) -> bool {
    matches!(b.wrapping_sub(a), 1..0x8000_0000)
}

/// Row hashes are already uniform; one multiply spreads them over the bits
/// the table indexes with, where the default hasher cost more than the rest
/// of recording a row.
#[derive(Default)]
struct KeyHasher(u64);

impl Hasher for KeyHasher {
    fn finish(&self) -> u64 {
        self.0
    }

    #[expect(
        clippy::unreachable,
        reason = "the only key type is `u64`, which hashes through `write_u64`"
    )]
    fn write(&mut self, _: &[u8]) {
        unreachable!("row keys hash as one u64");
    }

    fn write_u64(&mut self, value: u64) {
        let mixed = value.wrapping_mul(0x9e37_79b9_7f4a_7c15);
        self.0 = mixed ^ (mixed >> 32);
    }
}

type KeyMap<V> = HashMap<u64, V, BuildHasherDefault<KeyHasher>>;

/// Where a ledger keeps the rows it counts: the receiver stores each new row,
/// the sender only sizes it.
pub trait MzStore {
    /// Keep the row `key` names, which no record named before, and return the
    /// bytes it takes.
    fn insert(&mut self, key: u64) -> usize;
    /// No record names `key` any longer.
    fn release(&mut self, key: u64);
}

#[derive(Default)]
struct Slot {
    seq: u32,
    live: bool,
    /// Each complete row the datagram carried, by its row hash.
    rows: Vec<(u16, u64)>,
}

struct Held {
    records: u32,
    bytes: usize,
}

/// Which complete rows a history holds, by the datagram that carried them, and
/// the bytes of the distinct ones.
///
/// Both ends keep one and run it the same way. The receiver records the rows it
/// decoded; the sender records every row it sent, a superset of the same rows
/// under the same keys. So for any oldest datagram the sender's distinct bytes
/// are never below the receiver's, its window floor is never older, and it
/// retires a datagram no later than the receiver does: a row the sender's
/// ledger still holds, the receiver holds too.
#[derive(Default)]
pub struct MzLedger {
    /// The window's datagrams, at `seq % LEDGER_DATAGRAMS`.
    slots: Vec<Slot>,
    newest: Option<u32>,
    /// The oldest datagram not yet retired.
    floor: u32,
    held: KeyMap<Held>,
    bytes: usize,
}

#[inline]
fn slot_index(seq: u32) -> usize {
    (seq % LEDGER_DATAGRAMS) as usize
}

/// Drop one retired datagram's rows, releasing each no other record names.
fn release_rows(
    rows: &mut Vec<(u16, u64)>,
    held: &mut KeyMap<Held>,
    bytes: &mut usize,
    store: &mut impl MzStore,
) {
    for (_, key) in rows.drain(..) {
        if let Entry::Occupied(mut entry) = held.entry(key) {
            let row = entry.get_mut();
            row.records -= 1;
            if row.records == 0 {
                *bytes -= row.bytes;
                entry.remove();
                store.release(key);
            }
        }
    }
}

impl MzLedger {
    /// Forget everything: the grid these rows describe is gone.
    pub fn clear(&mut self) {
        for slot in &mut self.slots {
            slot.live = false;
            slot.rows.clear();
        }
        self.held.clear();
        self.bytes = 0;
        self.newest = None;
    }

    /// Datagram `seq` carried the complete row `key` at `row`. Then retires
    /// what the window and [`MZ_HISTORY_BYTES`] no longer hold, oldest
    /// datagram first; the newest is never retired.
    pub fn record(&mut self, seq: u32, row: u16, key: u64, store: &mut impl MzStore) {
        if self.slots.is_empty() {
            self.slots
                .resize_with(LEDGER_DATAGRAMS as usize, Slot::default);
        }
        match self.newest {
            None => {
                // Older datagrams may still arrive: the window reaches back
                // from the first as from any newest.
                self.newest = Some(seq);
                self.floor = seq.wrapping_sub(LEDGER_DATAGRAMS - 1);
            }
            Some(newest) if older(newest, seq) => {
                self.newest = Some(seq);
                self.retire_before(seq.wrapping_sub(LEDGER_DATAGRAMS - 1), store);
            }
            Some(_) => {}
        }
        if older(seq, self.floor) {
            return;
        }
        let Some(slot) = self.slots.get_mut(slot_index(seq)) else {
            return;
        };
        if !slot.live || slot.seq != seq {
            slot.seq = seq;
            slot.live = true;
            slot.rows.clear();
        }
        // A datagram delivered twice records its rows once.
        if slot.rows.iter().any(|&(held, _)| held == row) {
            return;
        }
        slot.rows.push((row, key));
        match self.held.entry(key) {
            Entry::Occupied(mut entry) => entry.get_mut().records += 1,
            Entry::Vacant(entry) => {
                let bytes = store.insert(key);
                self.bytes += bytes;
                entry.insert(Held { records: 1, bytes });
            }
        }
        while self.bytes > MZ_HISTORY_BYTES
            && self.newest.is_some_and(|newest| older(self.floor, newest))
        {
            self.retire_floor(store);
        }
    }

    /// Retire every datagram older than `floor`.
    fn retire_before(&mut self, floor: u32, store: &mut impl MzStore) {
        if !older(self.floor, floor) {
            return;
        }
        if floor.wrapping_sub(self.floor) >= LEDGER_DATAGRAMS {
            for slot in &mut self.slots {
                if slot.live {
                    slot.live = false;
                    release_rows(&mut slot.rows, &mut self.held, &mut self.bytes, store);
                }
            }
            self.floor = floor;
            return;
        }
        while older(self.floor, floor) {
            self.retire_floor(store);
        }
    }

    fn retire_floor(&mut self, store: &mut impl MzStore) {
        let floor = self.floor;
        self.floor = floor.wrapping_add(1);
        if let Some(slot) = self.slots.get_mut(slot_index(floor))
            && slot.live
            && slot.seq == floor
        {
            slot.live = false;
            release_rows(&mut slot.rows, &mut self.held, &mut self.bytes, store);
        }
    }

    /// Whether datagram `seq` is still held.
    pub fn holds(&self, seq: u32) -> bool {
        self.newest
            .is_some_and(|newest| !older(seq, self.floor) && !older(newest, seq))
    }

    /// The key of the complete row datagram `seq` carried at `row`, if held.
    pub fn key(&self, seq: u32, row: u16) -> Option<u64> {
        if !self.holds(seq) {
            return None;
        }
        let slot = self.slots.get(slot_index(seq))?;
        if !slot.live || slot.seq != seq {
            return None;
        }
        slot.rows
            .iter()
            .find(|&&(held, _)| held == row)
            .map(|&(_, key)| key)
    }

    /// Bytes of the distinct rows held.
    pub fn bytes(&self) -> usize {
        self.bytes
    }

    /// The oldest datagram still held, once any is.
    pub fn floor(&self) -> Option<u32> {
        self.newest.map(|_| self.floor)
    }

    /// Retire every datagram, releasing their rows.
    fn retire_all(&mut self, store: &mut impl MzStore) {
        for slot in &mut self.slots {
            if slot.live {
                slot.live = false;
                release_rows(&mut slot.rows, &mut self.held, &mut self.bytes, store);
            }
        }
        self.newest = None;
    }
}

/// Whether generation `a` is older than `b`: generations wrap like sequences.
#[inline]
fn older_generation(a: u32, b: u32) -> bool {
    older(a, b)
}

/// The generation before `generation`, which skips 0 as generations do.
#[inline]
pub fn previous_generation(generation: u32) -> u32 {
    match generation.wrapping_sub(1) {
        0 => u32::MAX,
        previous => previous,
    }
}

/// A ledger per display generation: the current generation's, and the one
/// before it, frozen when the current began, so a frame of the new generation
/// copies rows the old one established.
///
/// Both ends begin a generation before recording or naming anything of it:
/// the sender when it opens the generation, the receiver at the generation's
/// first frame. The sender's frozen ledger saw a superset of the records the
/// receiver's did, so it holds no row the receiver retired, and it retires
/// the generation before it no later than the receiver does.
#[derive(Default)]
pub struct MzGenerations {
    current: u32,
    ledger: MzLedger,
    previous: u32,
    previous_ledger: MzLedger,
}

impl MzGenerations {
    /// Make `generation` current, the current one previous, and retire the
    /// one before that. A generation not newer than the current changes
    /// nothing.
    pub fn begin(&mut self, generation: u32, store: &mut impl MzStore) {
        if generation == self.current || (self.current != 0 && older_generation(generation, self.current)) {
            return;
        }
        self.previous_ledger.retire_all(store);
        std::mem::swap(&mut self.ledger, &mut self.previous_ledger);
        self.previous = if previous_generation(generation) == self.current { self.current } else { 0 };
        if self.previous == 0 {
            self.previous_ledger.retire_all(store);
        }
        self.current = generation;
    }

    /// Datagram `seq` of `generation` carried the complete row `key` at
    /// `row`. A generation newer than the current begins first; an older one
    /// is frozen and records nothing.
    pub fn record(&mut self, generation: u32, seq: u32, row: u16, key: u64, store: &mut impl MzStore) {
        self.begin(generation, store);
        if generation == self.current {
            self.ledger.record(seq, row, key, store);
        }
    }

    fn ledger(&self, generation: u32) -> Option<&MzLedger> {
        if generation == self.current {
            Some(&self.ledger)
        } else if self.previous != 0 && generation == self.previous {
            Some(&self.previous_ledger)
        } else {
            None
        }
    }

    /// The key of the complete row datagram `seq` of `generation` carried at
    /// `row`, if held.
    pub fn key(&self, generation: u32, seq: u32, row: u16) -> Option<u64> {
        self.ledger(generation)?.key(seq, row)
    }

    /// The oldest datagram of `generation` still held, once any is.
    pub fn floor(&self, generation: u32) -> Option<u32> {
        self.ledger(generation)?.floor()
    }

    /// The current generation, 0 before any.
    pub fn current(&self) -> u32 {
        self.current
    }

    /// Forget every generation.
    pub fn clear(&mut self, store: &mut impl MzStore) {
        self.ledger.retire_all(store);
        self.previous_ledger.retire_all(store);
        self.current = 0;
        self.previous = 0;
    }

    /// Bytes of the distinct rows each generation holds, summed.
    pub fn bytes(&self) -> usize {
        self.ledger.bytes() + self.previous_ledger.bytes()
    }
}

/// The receiver's stored rows: each distinct complete row once, as the
/// full-row entry it was carried as (row number zeroed), with its items.
#[derive(Default)]
struct StoredRows {
    by_key: KeyMap<Stored>,
    spare: Vec<Stored>,
}

#[derive(Default)]
struct Stored {
    entry: Vec<u8>,
    items: Vec<MzItem>,
    first: u16,
    mode: u8,
    /// The generations' ledgers that hold it: one or both.
    ledgers: u8,
}

impl StoredRows {
    fn recycle(&mut self, stored: Stored) {
        if self.spare.len() < SPARE_ROWS {
            self.spare.push(stored);
        }
    }
}

/// The receiver's store for one record: the cells it names. A row both
/// generations' ledgers hold is stored once.
struct Storing<'a> {
    rows: &'a mut StoredRows,
    cells: &'a [CellRepr],
}

impl MzStore for Storing<'_> {
    fn insert(&mut self, key: u64) -> usize {
        if let Some(held) = self.rows.by_key.get_mut(&key) {
            held.ledgers += 1;
            return held.entry.len();
        }
        let mut stored = self.rows.spare.pop().unwrap_or_default();
        stored.entry.clear();
        encode_full_row_entry(&mut stored.entry, 0, self.cells);
        let bytes = stored.entry.len();
        // A full-row entry always parses: it is the row layout's own.
        if let Some((first, mode)) = entry_items(&stored.entry, &mut stored.items) {
            stored.first = first;
            stored.mode = mode;
            stored.ledgers = 1;
            self.rows.by_key.insert(key, stored);
        }
        bytes
    }

    fn release(&mut self, key: u64) {
        release_stored(self.rows, key);
    }
}

fn release_stored(rows: &mut StoredRows, key: u64) {
    if let Entry::Occupied(mut held) = rows.by_key.entry(key) {
        held.get_mut().ledgers -= 1;
        if held.get().ledgers == 0 {
            let stored = held.remove();
            rows.recycle(stored);
        }
    }
}

/// The receiver's store when a generation retires: it only releases.
struct Releasing<'a>(&'a mut StoredRows);

impl MzStore for Releasing<'_> {
    fn insert(&mut self, _: u64) -> usize {
        0
    }

    fn release(&mut self, key: u64) {
        release_stored(self.0, key);
    }
}

/// What a receiver received of each row, kept so a copy out of a complete row
/// a datagram carried reads exactly those cells, whatever the grid did with
/// them since.
///
/// A record is the frame's own content, never the grid's: a row the grid
/// skipped as stale is recorded as the datagram carried it, so every
/// acknowledged complete row is a source whatever was sent to that row after
/// it. Rows with links are never recorded, since a link id resolves through a
/// table only the row's own datagram delivered.
///
/// A row keeps its bytes whatever the grid's size became since: a copy is a
/// byte-exact run of items, so a row of another width is as good a source.
#[derive(Default)]
pub struct RowHistory {
    generations: MzGenerations,
    rows: StoredRows,
}

impl RowHistory {
    /// Forget everything: the grid these records describe is gone.
    pub fn clear(&mut self) {
        self.generations.clear(&mut Releasing(&mut self.rows));
        let stored = std::mem::take(&mut self.rows.by_key);
        for (_, entry) in stored {
            self.rows.recycle(entry);
        }
    }

    /// Display generation `generation` began: the current one's rows stay
    /// for its frames to copy, and the one before it retires.
    pub fn begin_generation(&mut self, generation: u32) {
        self.generations.begin(generation, &mut Releasing(&mut self.rows));
    }

    /// Datagram `seq` of `generation` (0: its snapshot), on a grid `cols`
    /// wide, carried `cells` as the complete row `row`, whether or not the
    /// grid applied it.
    /// Return the exact cell hash computed for a complete linkless row, even
    /// when its generation no longer admits history. Linked/incomplete rows
    /// have no history key.
    pub fn record(
        &mut self,
        generation: u32,
        seq: u32,
        row: u16,
        cells: &[CellRepr],
        cols: u16,
    ) -> Option<u64> {
        if cells.len() != usize::from(cols) || cells.iter().any(|cell| cell.link != 0) {
            return None;
        }
        let key = crate::row_hash(cells);
        self.generations.record(
            generation,
            seq,
            row,
            key,
            &mut Storing {
                rows: &mut self.rows,
                cells,
            },
        );
        Some(key)
    }

    /// The complete row a frame of `generation` presented as
    /// `presentation_id` names at `row`, as items: `back` datagrams before
    /// it, or with `previous`, datagram `back` of the generation before.
    pub fn row(
        &self,
        generation: u32,
        presentation_id: u32,
        previous: bool,
        back: u32,
        row: u16,
    ) -> Result<MzRow<'_>, MzError> {
        let (generation, seq) = if previous {
            (previous_generation(generation), back)
        } else {
            if back == 0 || back > MZ_REFERENCE_DATAGRAMS {
                return Err(MzError::Corrupt);
            }
            (generation, presentation_id.wrapping_sub(back))
        };
        let stored = self
            .generations
            .key(generation, seq, row)
            .and_then(|key| self.rows.by_key.get(&key))
            .ok_or(MzError::Unresolved)?;
        Ok(MzRow {
            entry: &stored.entry,
            first: stored.first,
            items: &stored.items,
            mode: stored.mode,
            hashes: &[],
        })
    }

    /// Bytes of the distinct rows held, for tests and memory accounting.
    pub fn held_bytes(&self) -> usize {
        self.generations.bytes()
    }
}
