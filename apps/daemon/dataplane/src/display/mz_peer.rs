//! One peer's MZ state on the encoding side: the acknowledged rows its frames
//! may copy from, and its session epochs.
//!
//! The owner loop decides what the browser holds — acknowledgements, losses,
//! the ledger's floor — and queues those facts here; whoever encodes the
//! peer's next frame (the prepare thread, or the owner loop inline when no
//! request is in flight) drains them first. Each peer has at most one encode
//! at a time, so the state lock is never contended; the fact queue's lock is
//! held only to push or swap a vector.

use crate::connection::SentRow;
use merkur_codec::CellRepr;
use merkur_codec::mz::{
    MZ_DECLARATION_REACH, MZ_EPOCH_DATAGRAMS, MZ_REFERENCE_DATAGRAMS, MzCandidate, MzEpochDeclaration, MzItem,
    MzMatches, MzRow, MzSession, MzTracePool, SessionModel, encode_full_row_entry, entry_items, item_hash,
    next_epoch_id, pair_hash,
};
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

/// A fact the owner loop learned about what the browser holds.
pub(crate) enum MzFact {
    /// The browser applied datagram `seq`, which carried `rows`; `coded` when
    /// it was an MZ frame, `declared` the epoch it declared.
    Applied {
        seq: u32,
        rows: Vec<(u16, Arc<[CellRepr]>)>,
        coded: bool,
        declared: Option<u8>,
    },
    /// No acknowledged row may be copied again: the browser may have refused
    /// one.
    Untrusted,
    /// The grid changed geometry; the browser's history and epochs went with
    /// it.
    Reset,
}

/// A peer's shared MZ state.
#[derive(Default)]
pub(crate) struct PeerMz {
    facts: Mutex<Vec<MzFact>>,
    /// The oldest datagram the browser's history may still hold, plus one
    /// (zero: none recorded yet).
    floor: AtomicU32,
    state: Mutex<MzPeerState>,
}

impl PeerMz {
    pub(crate) fn push(&self, fact: MzFact) {
        if let Ok(mut facts) = self.facts.lock() {
            facts.push(fact);
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
        let floor = self.floor.load(Ordering::Acquire);
        state.floor = floor.checked_sub(1).filter(|_| floor != 0);
        for fact in facts.drain(..) {
            state.apply(fact);
        }
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

/// The encoder's view of one peer.
#[derive(Default)]
pub(crate) struct MzPeerState {
    fact_spare: Vec<MzFact>,
    floor: Option<u32>,
    /// Acknowledged complete rows, by datagram and row.
    sources: HashMap<(u32, u16), Source>,
    /// The pair hash of each source item pair → `(seq, row, item)`, newest last.
    pairs: HashMap<u64, Vec<(u32, u16, u16)>>,
    /// Sources in acknowledgement order, so they retire oldest first.
    order: VecDeque<(u32, u16)>,
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
    /// Acknowledged MZ datagrams not yet folded, oldest first.
    unfolded: VecDeque<u32>,
    trace_spare: MzTracePool,
}

/// Datagrams whose traces one declaration folds: once this many acknowledged
/// MZ frames wait, the next epoch is declared. One declaration's bitmap holds
/// at most `MZ_EPOCH_DATAGRAMS`.
const EPOCH_FOLD_DATAGRAMS: usize = 32;
/// Sources one item pair lists at most; the newest are kept.
const PAIR_SOURCES: usize = 4;

#[inline]
fn older(a: u32, b: u32) -> bool {
    matches!(b.wrapping_sub(a), 1..0x8000_0000)
}

impl MzPeerState {
    fn apply(&mut self, fact: MzFact) {
        match fact {
            MzFact::Applied { seq, rows, coded, declared } => {
                for (row, cells) in rows {
                    self.add_source(seq, row, &cells);
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
            MzFact::Untrusted => self.clear_sources(),
            MzFact::Reset => {
                self.clear_sources();
                self.session.clear();
                self.usable = None;
                self.declaring = None;
                self.unfolded.clear();
            }
        }
    }

    fn clear_sources(&mut self) {
        for (_, source) in self.sources.drain() {
            self.spare.push(source);
        }
        self.spare.truncate(merkur_codec::MAX_TERMINAL_ROWS);
        self.pairs.clear();
        self.order.clear();
    }

    fn add_source(&mut self, seq: u32, row: u16, cells: &[CellRepr]) {
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
                let list = self.pairs.entry(pair_hash(prior, hash)).or_default();
                if list.len() == PAIR_SOURCES {
                    list.remove(0);
                }
                let Ok(item) = u16::try_from(index - 1) else {
                    break;
                };
                list.push((seq, row, item));
            }
            previous = Some(hash);
        }
        if let Some(old) = self.sources.insert((seq, row), source) {
            self.spare.push(old);
        }
        self.order.push_back((seq, row));
    }

    /// Retire sources no frame can copy from: past the reach of the newest
    /// acknowledged datagram, or below the ledger's floor.
    fn retire(&mut self) {
        let Some(newest) = self.newest else { return };
        let reach = newest.wrapping_sub(MZ_REFERENCE_DATAGRAMS);
        while let Some(&(seq, row)) = self.order.front() {
            let below_floor = self.floor.is_some_and(|floor| older(seq, floor));
            if !older(seq, reach) && !below_floor {
                break;
            }
            self.order.pop_front();
            if let Some(source) = self.sources.remove(&(seq, row)) {
                self.spare.push(source);
            }
        }
        // Pair lists keep stale names until a lookup misses them; prune the
        // map once it outgrows its sources.
        if self.pairs.len() > 64 * self.sources.len().max(64) {
            let sources = &self.sources;
            self.pairs.retain(|_, list| {
                list.retain(|(seq, row, _)| sources.contains_key(&(*seq, *row)));
                !list.is_empty()
            });
        }
    }

    /// How many acknowledged rows the peer's frames may copy from.
    #[cfg(test)]
    pub(crate) fn sources(&self) -> usize {
        self.sources.len()
    }

    /// The copy sources for a frame of presentation `presentation_id`.
    pub(crate) fn history(&self, presentation_id: u32) -> History<'_> {
        History { state: self, presentation_id }
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

/// A peer's sources as one frame sees them.
pub(crate) struct History<'a> {
    state: &'a MzPeerState,
    presentation_id: u32,
}

impl History<'_> {
    #[inline]
    fn reachable(&self, seq: u32) -> Option<u32> {
        let seq_delta = self.presentation_id.wrapping_sub(seq);
        let held = self.state.floor.is_none_or(|floor| !older(seq, floor));
        (seq_delta != 0 && seq_delta <= MZ_REFERENCE_DATAGRAMS && held).then_some(seq_delta)
    }
}

impl MzMatches for History<'_> {
    fn candidates(&self, pair: u64, out: &mut Vec<MzCandidate>) {
        let Some(list) = self.state.pairs.get(&pair) else { return };
        for &(seq, row, item) in list.iter().rev() {
            if self.state.sources.contains_key(&(seq, row))
                && let Some(seq_delta) = self.reachable(seq)
            {
                out.push(MzCandidate { seq_delta, row, item });
            }
        }
    }

    fn row(&self, seq_delta: u32, row: u16) -> Option<MzRow<'_>> {
        let seq = self.presentation_id.wrapping_sub(seq_delta);
        self.reachable(seq)?;
        let source = self.state.sources.get(&(seq, row))?;
        Some(MzRow {
            entry: &source.entry,
            first: source.first,
            items: &source.items,
            mode: source.mode,
            hashes: &source.hashes,
        })
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
