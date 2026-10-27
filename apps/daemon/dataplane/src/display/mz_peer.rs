//! One peer's MZ state on the encoding side: the acknowledged rows its frames
//! may copy from, and its session epochs.
//!
//! The owner loop decides what the browser holds — acknowledgements, display
//! generations, the ledger's floor, reported refusals — and queues those facts
//! here; whoever encodes the peer's next frame (the prepare thread, or the
//! owner loop inline when no request is in flight) drains them first. Each peer
//! has at most one encode at a time, so the state lock is never contended; the
//! fact queue's lock is held only to push or swap a vector.

use crate::connection::SentRow;
use merkur_codec::CellRepr;
use merkur_codec::mz::{
    MZ_DECLARATION_REACH, MZ_EPOCH_DATAGRAMS, MZ_REFERENCE_DATAGRAMS, MzCandidate, MzEpochDeclaration, MzItem,
    MzMatches, MzRow, MzSession, MzTracePool, SessionModel, encode_full_row_entry, entry_items, item_hash,
    next_epoch_id, pair_hash, previous_generation,
};
use std::collections::{HashMap, VecDeque};
use std::hash::{BuildHasherDefault, Hasher};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

/// A fact the owner loop learned about what the browser holds.
pub(crate) enum MzFact {
    /// The browser applied datagram `seq` of the current generation (0: its
    /// snapshot), which carried `rows`; `coded` when it was MZ, `declared`
    /// the epoch it declared.
    Applied {
        seq: u32,
        rows: Vec<(u16, Arc<[CellRepr]>)>,
        coded: bool,
        declared: Option<u8>,
    },
    /// Display generation `generation` began. The current one's rows become
    /// the previous generation's, `previous_floor` the oldest datagram of it
    /// the browser's ledger may still hold; its traces and any declaration in
    /// flight go, and the epochs stay.
    Generation {
        generation: u32,
        previous_floor: Option<u32>,
    },
    /// The browser reported a frame it could not resolve: no row is copied and
    /// no epoch is coded against until new ones are acknowledged.
    Refused,
    /// The browser discarded every row and epoch it held.
    Cleared,
}

/// A peer's shared MZ state.
#[derive(Default)]
pub(crate) struct PeerMz {
    facts: Mutex<Vec<MzFact>>,
    /// The oldest datagram of the current generation the browser's history may
    /// still hold, plus one (zero: none recorded yet).
    floor: AtomicU32,
    /// Last captured grid hashes and frame header, owned by the capture loop.
    capture: Mutex<(Vec<u64>, u128)>,
    /// Whether a changed, permitted successor is waiting behind preparation.
    successor: AtomicBool,
    state: Mutex<MzPeerState>,
}

impl PeerMz {
    /// Exact captured grid/header identity. Only the owner writes this buffer;
    /// the worker reads the successor fact without taking its lock.
    pub(crate) fn capture(&self, hashes: &[u64], header: u128) {
        let mut capture = self.capture.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        capture.0.clear();
        capture.0.extend_from_slice(hashes);
        capture.1 = header;
        self.successor.store(false, Ordering::Release);
    }

    /// Publish whether demand permits the changed grid/header to follow this frame.
    pub(crate) fn pending(&self, hashes: &[u64], header: u128, permitted: bool) {
        let capture = self.capture.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        self.successor
            .store(permitted && (capture.0 != hashes || capture.1 != header), Ordering::Release);
    }

    /// Read the successor fact without taking the capture lock.
    pub(crate) fn successor_waiting(&self) -> bool {
        self.successor.load(Ordering::Acquire)
    }

    pub(crate) fn push(&self, fact: MzFact) {
        if let Ok(mut facts) = self.facts.lock() {
            // A refusal or discard repeated before the encoder drains changes
            // nothing the first did not, so an idle peer's reports queue once.
            let repeated = match (facts.last(), &fact) {
                (Some(MzFact::Refused), MzFact::Refused) | (Some(MzFact::Cleared), MzFact::Cleared) => true,
                _ => false,
            };
            if !repeated {
                facts.push(fact);
            }
        }
    }

    /// The ledger's floor after a send.
    pub(crate) fn set_floor(&self, floor: Option<u32>) {
        self.floor
            .store(floor.map_or(0, |floor| floor.wrapping_add(1)).max(1), Ordering::Release);
    }

    /// The encoder's state, with every queued fact applied.
    pub(crate) fn lock(&self) -> std::sync::MutexGuard<'_, MzPeerState> {
        let mut state = self.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut facts = std::mem::take(&mut state.fact_spare);
        if let Ok(mut queued) = self.facts.lock() {
            std::mem::swap(&mut *queued, &mut facts);
        }
        for fact in facts.drain(..) {
            state.apply(fact);
        }
        // Read after the facts: a generation fact precedes the floor of the
        // generation it opens.
        let floor = self.floor.load(Ordering::Acquire);
        state.floor = floor.checked_sub(1).filter(|_| floor != 0);
        // A floor raised since the last fact retires its sources now, not at
        // the next acknowledgement.
        state.retire();
        state.fact_spare = facts;
        state
    }
}

struct Source {
    entry: Vec<u8>,
    items: Vec<MzItem>,
    hashes: Vec<u64>,
    first: u16,
    mode: u8,
}

/// A source's name: display generation, datagram, row.
type SourceKey = (u32, u32, u16);

/// Pair keys already contain the item hashes. Source keys are three integers;
/// combine their words without hashing their byte representation. Map traversal
/// never orders candidates: `pairs` owns ordered lists and `order` owns retirement.
#[derive(Default)]
struct SourceHasher(u64);

impl Hasher for SourceHasher {
    fn finish(&self) -> u64 {
        let mixed = self.0.wrapping_mul(0x9e37_79b9_7f4a_7c15);
        mixed ^ (mixed >> 32)
    }

    #[expect(clippy::unreachable, reason = "SourceKey hashes as two u32s and one u16")]
    fn write(&mut self, _: &[u8]) {
        unreachable!("source keys hash as integers");
    }

    fn write_u32(&mut self, value: u32) {
        self.0 = self.0.rotate_left(32) ^ u64::from(value);
    }

    fn write_u16(&mut self, value: u16) {
        self.0 ^= u64::from(value).wrapping_mul(0x517c_c1b7_2722_0a95);
    }
}

#[derive(Default)]
struct PairHasher(u64);

impl Hasher for PairHasher {
    fn finish(&self) -> u64 {
        self.0
    }

    #[expect(clippy::unreachable, reason = "pair keys hash as one u64")]
    fn write(&mut self, _: &[u8]) {
        unreachable!("pair keys hash as one u64");
    }

    fn write_u64(&mut self, value: u64) {
        self.0 = value;
    }
}

/// The encoder's view of one peer.
#[derive(Default)]
pub(crate) struct MzPeerState {
    fact_spare: Vec<MzFact>,
    /// Encoding-regime and content-conditioned entropy observations for this peer.
    pub(crate) row_cost_model: super::planner::RowCostModel,
    /// The current display generation, and the one before it whose rows are
    /// still copied (0: none).
    generation: u32,
    previous: u32,
    floor: Option<u32>,
    previous_floor: Option<u32>,
    /// Acknowledged complete rows, by generation, datagram and row.
    sources: HashMap<SourceKey, Source, BuildHasherDefault<SourceHasher>>,
    /// Live source item pairs → `(source, item)` in admission order, newest last;
    /// no list holds stale names or is empty.
    pairs: HashMap<u64, PairSources, BuildHasherDefault<PairHasher>>,
    /// The current generation's sources in sequence order, so they retire
    /// oldest first however their acknowledgements arrived, and the previous
    /// generation's, which retire with it.
    order: VecDeque<SourceKey>,
    previous_order: VecDeque<SourceKey>,
    spare: Vec<Source>,
    newest: Option<u32>,
    session: MzSession,
    /// The newest epoch the browser holds.
    usable: Option<u8>,
    /// The newest epoch declared.
    declared: u8,
    /// A declared epoch whose declaration the browser has not yet
    /// acknowledged, and the presentation that first carried it: every MZ
    /// frame carries it until one is acknowledged, or until it is a copy's
    /// reach old, when the traces it names may be gone from the browser and
    /// it is abandoned.
    declaring: Option<(MzEpochDeclaration, u32)>,
    /// Acknowledged MZ datagrams of the current generation not yet folded,
    /// oldest first.
    unfolded: VecDeque<u32>,
    trace_spare: MzTracePool,
    /// Advances whenever the browser refused or discarded what frames were
    /// coded against, so a frame prepared before it can be told apart.
    trust: u32,
}

/// Datagrams whose traces one declaration folds: once this many acknowledged
/// MZ frames wait, the next epoch is declared. One declaration's bitmap holds
/// at most `MZ_EPOCH_DATAGRAMS`.
const EPOCH_FOLD_DATAGRAMS: usize = 32;
/// Sources one item pair lists at most; the newest are kept.
const PAIR_SOURCES: usize = 4;

/// One pair occurrence, flat so an entry is 12 bytes rather than a padded
/// `(SourceKey, u16)`'s 16.
#[derive(Clone, Copy, Default)]
struct PairSource {
    generation: u32,
    seq: u32,
    row: u16,
    item: u16,
}

const _: () = assert!(std::mem::size_of::<PairSource>() == 12);

/// A pair's occurrences inline, so admitting and retiring never allocate.
#[derive(Default)]
struct PairSources {
    entries: [PairSource; PAIR_SOURCES],
    len: u8,
}

impl PairSources {
    fn iter(&self) -> impl DoubleEndedIterator<Item = (SourceKey, u16)> + '_ {
        self.entries[..usize::from(self.len)]
            .iter()
            .map(|entry| ((entry.generation, entry.seq, entry.row), entry.item))
    }

    fn push(&mut self, (generation, seq, row): SourceKey, item: u16) {
        if usize::from(self.len) == PAIR_SOURCES {
            self.entries.copy_within(1..PAIR_SOURCES, 0);
            self.len -= 1;
        }
        self.entries[usize::from(self.len)] = PairSource { generation, seq, row, item };
        self.len += 1;
    }

    fn remove_source(&mut self, (generation, seq, row): SourceKey) {
        let mut kept = 0;
        for index in 0..usize::from(self.len) {
            let entry = self.entries[index];
            if (entry.generation, entry.seq, entry.row) != (generation, seq, row) {
                self.entries[usize::from(kept)] = entry;
                kept += 1;
            }
        }
        self.len = kept;
    }
}

#[inline]
fn older(a: u32, b: u32) -> bool {
    matches!(b.wrapping_sub(a), 1..0x8000_0000)
}

impl MzPeerState {
    /// Identify the history/epoch regime used by the next encode.
    pub(crate) fn row_regime(&self) -> usize {
        usize::from(!self.sources.is_empty()) | (usize::from(self.session().is_some()) << 1)
    }

    /// Apply this peer's observed row costs to the planning profiles.
    pub(crate) fn row_profiles(&self, profiles: &mut [super::planner::PeerPlanningSnapshot; 3]) {
        self.row_cost_model.apply(self.row_regime(), profiles);
    }

    fn apply(&mut self, fact: MzFact) {
        match fact {
            MzFact::Applied { seq, rows, coded, declared } => {
                let generation = self.generation;
                for (row, cells) in rows {
                    self.add_source((generation, seq, row), &cells);
                }
                if self.newest.is_none_or(|newest| older(newest, seq)) {
                    self.newest = Some(seq);
                }
                if coded && self.session.holds_trace(seq) {
                    self.unfolded.push_back(seq);
                }
                if let Some(id) = declared
                    && self.declaring.is_some_and(|(declaring, _)| declaring.id == id)
                {
                    self.declaring = None;
                    self.usable = Some(id);
                }
                self.retire();
            }
            MzFact::Generation { generation, previous_floor } => {
                while let Some(key) = self.previous_order.pop_front() {
                    self.remove_source(key);
                }
                self.previous = if previous_generation(generation) == self.generation {
                    self.generation
                } else {
                    0
                };
                std::mem::swap(&mut self.order, &mut self.previous_order);
                self.previous_floor = previous_floor;
                // What the frozen floor retired, or a skipped generation's
                // rows, no frame can name.
                let (previous, floor) = (self.previous, previous_floor);
                for _ in 0..self.previous_order.len() {
                    let Some(key) = self.previous_order.pop_front() else {
                        break;
                    };
                    if previous != 0 && floor.is_none_or(|floor| !older(key.1, floor)) {
                        self.previous_order.push_back(key);
                    } else {
                        self.remove_source(key);
                    }
                }
                self.spare.truncate(merkur_codec::MAX_TERMINAL_ROWS);
                self.generation = generation;
                self.newest = None;
                self.session.begin_generation();
                self.unfolded.clear();
                self.declaring = None;
            }
            MzFact::Refused => {
                self.clear_sources();
                self.usable = None;
                self.declaring = None;
                self.trust = self.trust.wrapping_add(1);
            }
            MzFact::Cleared => {
                self.clear_sources();
                self.session.clear();
                self.usable = None;
                self.declaring = None;
                self.unfolded.clear();
                self.trust = self.trust.wrapping_add(1);
            }
        }
    }

    /// Every source goes, so the pair index goes whole rather than pair by pair.
    fn clear_sources(&mut self) {
        for (_, source) in self.sources.drain() {
            self.spare.push(source);
        }
        self.spare.truncate(merkur_codec::MAX_TERMINAL_ROWS);
        self.pairs.clear();
        self.order.clear();
        self.previous_order.clear();
    }

    fn add_source(&mut self, key: SourceKey, cells: &[CellRepr]) {
        if self.sources.contains_key(&key) {
            self.remove_source(key);
            self.order.retain(|&held| held != key);
            self.previous_order.retain(|&held| held != key);
        }
        let mut source = self.spare.pop().unwrap_or(Source {
            entry: Vec::new(),
            items: Vec::new(),
            hashes: Vec::new(),
            first: 0,
            mode: 0,
        });
        source.entry.clear();
        encode_full_row_entry(&mut source.entry, 0, cells);
        let Some((first, mode)) = entry_items(&source.entry, &mut source.items) else {
            self.spare.push(source);
            return;
        };
        source.first = first;
        source.mode = mode;
        source.hashes.clear();
        let row_view = MzRow { entry: &source.entry, first, items: &source.items, mode, hashes: &[] };
        let mut previous = None;
        for index in 0..source.items.len() {
            let Some(hash) = item_bytes(&row_view, index).map(item_hash) else {
                break;
            };
            source.hashes.push(hash);
            if let Some(prior) = previous {
                let Ok(item) = u16::try_from(index - 1) else {
                    break;
                };
                self.pairs
                    .entry(pair_hash(prior, hash))
                    .or_default()
                    .push(key, item);
            }
            previous = Some(hash);
        }
        self.sources.insert(key, source);
        // Sequence order, not acknowledgement order: reach and floor are
        // sequence bounds, so retirement stops at the first held source. A
        // reordered acknowledgement lands its distance from the back.
        let at = self.order.iter().rposition(|held| !older(key.1, held.1)).map_or(0, |at| at + 1);
        self.order.insert(at, key);
    }

    /// Retire the current generation's sources no frame can copy from: past
    /// the reach of the newest acknowledged datagram, or below the ledger's
    /// floor.
    fn retire(&mut self) {
        let Some(newest) = self.newest else { return };
        let reach = newest.wrapping_sub(MZ_REFERENCE_DATAGRAMS);
        while let Some(&key) = self.order.front() {
            let below_floor = self.floor.is_some_and(|floor| older(key.1, floor));
            if !older(key.1, reach) && !below_floor {
                break;
            }
            self.order.pop_front();
            self.remove_source(key);
        }
    }

    /// Remove exactly the pairs this source admitted, then recycle its buffers.
    fn remove_source(&mut self, key: SourceKey) {
        let Some(source) = self.sources.remove(&key) else {
            return;
        };
        for hashes in source.hashes.windows(2).take(usize::from(u16::MAX) + 1) {
            if let std::collections::hash_map::Entry::Occupied(mut entry) =
                self.pairs.entry(pair_hash(hashes[0], hashes[1]))
            {
                entry.get_mut().remove_source(key);
                if entry.get().len == 0 {
                    entry.remove();
                }
            }
        }
        self.spare.push(source);
    }

    /// What frames are coded against, as a count of the browser's refusals
    /// and discards.
    pub(crate) fn trust(&self) -> u32 {
        self.trust
    }

    /// How many acknowledged rows the peer's frames may copy from.
    #[cfg(test)]
    pub(crate) fn sources(&self) -> usize {
        self.sources.len()
    }

    /// The copy sources for a delta of the current generation presented as
    /// `presentation_id`.
    pub(crate) fn history(&self, presentation_id: u32) -> History<'_> {
        History { state: self, presentation_id, snapshot: false }
    }

    /// The copy sources for the snapshot that opens the next generation: the
    /// current generation's rows, which that one names as its previous.
    pub(crate) fn snapshot_history(&self) -> History<'_> {
        History { state: self, presentation_id: 0, snapshot: true }
    }

    /// The epoch the next frame may be coded against.
    pub(crate) fn session(&self) -> Option<(u8, &SessionModel)> {
        let id = self.usable?;
        self.session.epoch(id).map(|model| (id, model))
    }

    /// The declaration a frame of `presentation_id` carries: the outstanding
    /// one, or a new one once enough acknowledged frames wait to be folded.
    pub(crate) fn declaration(&mut self, presentation_id: u32) -> Option<MzEpochDeclaration> {
        if self
            .declaring
            .is_some_and(|(_, first)| presentation_id.wrapping_sub(first) > MZ_REFERENCE_DATAGRAMS)
        {
            self.declaring = None;
        }
        // A declaration names only datagrams within its reach of the frame
        // carrying it, whose traces the browser still holds.
        let reach = presentation_id.wrapping_sub(MZ_DECLARATION_REACH);
        while self.unfolded.front().is_some_and(|&seq| older(seq, reach)) {
            self.unfolded.pop_front();
        }
        if self.declaring.is_none() && self.unfolded.len() >= EPOCH_FOLD_DATAGRAMS {
            let first = *self.unfolded.front()?;
            let mut datagrams = 0u64;
            while let Some(&seq) = self.unfolded.front() {
                let bit = seq.wrapping_sub(first);
                if bit >= MZ_EPOCH_DATAGRAMS {
                    break;
                }
                datagrams |= 1 << bit;
                self.unfolded.pop_front();
            }
            let declaration = MzEpochDeclaration {
                id: next_epoch_id(self.declared),
                base: self.usable.unwrap_or(0),
                first,
                datagrams,
            };
            // The sender holds every trace it declares: it kept each before
            // the datagram went out and folds only acknowledged ones.
            if self.session.build(&declaration).is_ok() {
                self.declared = declaration.id;
                self.declaring = Some((declaration, presentation_id));
            }
        }
        self.declaring.map(|(declaration, _)| declaration)
    }

    /// Datagram `seq` went out with `trace`, the symbols its MZ frame coded.
    pub(crate) fn keep_trace(&mut self, seq: u32, trace: &[u32]) {
        self.session.keep(seq, trace);
    }

    /// The current generation's snapshot went out with `trace`, its chunks'
    /// symbols in chunk order.
    pub(crate) fn keep_snapshot_trace(&mut self, trace: &[u32]) {
        self.session.keep_snapshot_chunk(trace);
    }

    /// A pooled buffer that holds `len` trace symbols.
    pub(crate) fn take_trace_buffer(&mut self, len: usize) -> Vec<u32> {
        self.trace_spare.take(len)
    }

    pub(crate) fn return_trace_buffer(&mut self, buffer: Vec<u32>) {
        self.trace_spare.put(buffer);
    }
}

#[inline]
fn item_bytes<'a>(row: &MzRow<'a>, index: usize) -> Option<&'a [u8]> {
    let start = if index == 0 {
        usize::from(row.first)
    } else {
        usize::from(row.items.get(index - 1)?.end)
    };
    row.entry.get(start..usize::from(row.items.get(index)?.end))
}

/// A peer's sources as one frame sees them: a delta of the current generation,
/// or the snapshot that opens the next one.
pub(crate) struct History<'a> {
    state: &'a MzPeerState,
    presentation_id: u32,
    snapshot: bool,
}

impl History<'_> {
    /// How the frame names source `key`, if it may: `(previous, back)`.
    #[inline]
    fn name(&self, key: SourceKey) -> Option<(bool, u32)> {
        let (generation, seq, _) = key;
        let state = self.state;
        if generation == state.generation {
            let held = state.floor.is_none_or(|floor| !older(seq, floor));
            if self.snapshot {
                return held.then_some((true, seq));
            }
            let seq_delta = self.presentation_id.wrapping_sub(seq);
            (seq_delta != 0 && seq_delta <= MZ_REFERENCE_DATAGRAMS && held).then_some((false, seq_delta))
        } else {
            let held = state.previous_floor.is_none_or(|floor| !older(seq, floor));
            (!self.snapshot && generation == state.previous && state.previous != 0 && held).then_some((true, seq))
        }
    }
}

impl MzMatches for History<'_> {
    fn candidates(&self, pair: u64, mut visit: impl FnMut(MzCandidate, MzRow<'_>) -> bool) {
        let Some(list) = self.state.pairs.get(&pair) else { return };
        for (key, item) in list.iter().rev() {
            let Some((previous, back)) = self.name(key) else { continue };
            let Some(source) = self.state.sources.get(&key) else { continue };
            let row = MzRow {
                entry: &source.entry,
                first: source.first,
                items: &source.items,
                mode: source.mode,
                hashes: &source.hashes,
            };
            if !visit(MzCandidate { previous, back, row: key.2, item }, row) {
                break;
            }
        }
    }
}

/// The rows of an applied datagram the browser's history records: complete,
/// linkless, without graphics.
pub(crate) fn recorded_rows<'a>(rows: impl IntoIterator<Item = &'a SentRow>) -> Vec<(u16, Arc<[CellRepr]>)> {
    rows.into_iter()
        .filter(|sent| sent.complete && sent.graphics.is_none() && sent.cells.iter().all(|cell| cell.link == 0))
        .map(|sent| (sent.row, Arc::clone(&sent.cells)))
        .collect()
}

/// One peer's handle, shared by the owner loop and the prepare thread.
pub(crate) type SharedPeerMz = Arc<PeerMz>;

#[cfg(test)]
mod successor_tests {
    /// Changed state counts as a successor only while demand permits sending it.
    #[test]
    fn a_successor_requires_both_changed_state_and_send_permission() {
        let peer = super::PeerMz::default();
        peer.capture(&[1, 2], 3);
        peer.pending(&[1, 2], 3, true);
        assert!(!peer.successor_waiting(), "a banked grant is not demand");
        peer.pending(&[1, 4], 3, false);
        assert!(!peer.successor_waiting(), "changed rows still need permission");
        peer.pending(&[1, 4], 3, true);
        assert!(peer.successor_waiting());
        peer.pending(&[1, 2], 3, true);
        assert!(!peer.successor_waiting(), "a reverted mutation needs no successor");
        peer.pending(&[1, 2], 5, true);
        assert!(peer.successor_waiting(), "a changed header is display state");
        peer.capture(&[1, 2], 5);
        assert!(!peer.successor_waiting());
    }
}

#[cfg(test)]
mod tests;
