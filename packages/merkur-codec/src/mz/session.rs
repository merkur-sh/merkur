//! The session model: tables both ends derive from what the session already
//! carried. Each acknowledged datagram's symbol trace — the very symbols its
//! frame coded, which the encoder recorded and the decoder decoded — folds into
//! them at a slow rate, so a frame may start from what this session's screens
//! look like rather than from the trained prior alone.
//!
//! Nothing of the model crosses the wire. The daemon declares an epoch as the
//! previous epoch plus a list of acknowledged datagrams; the browser folds the
//! same traces, and acknowledges the epoch it holds. A frame names the epoch it
//! was coded against, or the static model.

use super::model::{KEYS, Prior, StaticModel};
use super::nibble::Cdf;
use std::collections::HashMap;

/// The rate a session fold adapts at: slower than a frame's, since a session
/// table summarizes many frames.
const SESSION_RATE: u32 = 5;
/// Datagrams one epoch folds at most, the width of its declaration bitmap.
pub const MZ_EPOCH_DATAGRAMS: u32 = 64;

#[derive(Clone)]
struct Set {
    hi: Cdf,
    /// Index plus one of each high nibble's low table in `SessionModel::lo`.
    lo_at: [u32; 16],
}

/// Session tables over the static model: a key the session never coded keeps
/// the static model's tables.
#[derive(Clone)]
pub struct SessionModel {
    /// Index plus one of each key's set.
    index: Box<[u32]>,
    sets: Vec<Set>,
    lo: Vec<Cdf>,
}

impl Default for SessionModel {
    fn default() -> Self {
        Self {
            index: vec![0; KEYS].into_boxed_slice(),
            sets: Vec::new(),
            lo: Vec::new(),
        }
    }
}

impl SessionModel {
    /// Fold one datagram's symbol trace.
    #[expect(
        clippy::indexing_slicing,
        clippy::cast_possible_truncation,
        reason = "keys are checked below `KEYS`, the index's length; sets and low tables \
                  are indexed by the positions this fold pushed, and number at most \
                  `KEYS * 17`, far below 2^32"
    )]
    pub fn fold(&mut self, trace: &[u32]) {
        let base = super::model::static_model();
        for &entry in trace {
            let key = entry >> 9;
            if key as usize >= KEYS {
                continue;
            }
            let (low, h, s) = (entry >> 8 & 1 == 1, (entry >> 4 & 15) as usize, (entry & 15) as usize);
            let set = match self.index[key as usize] {
                0 => {
                    self.sets.push(Set { hi: *base.hi(key), lo_at: [0; 16] });
                    self.index[key as usize] = self.sets.len() as u32;
                    self.sets.len() - 1
                }
                at => at as usize - 1,
            };
            if low {
                let at = match self.sets[set].lo_at[h] {
                    0 => {
                        self.lo.push(*base.lo(key, h));
                        self.sets[set].lo_at[h] = self.lo.len() as u32;
                        self.lo.len() - 1
                    }
                    at => at as usize - 1,
                };
                self.lo[at].update(s, SESSION_RATE);
            } else {
                self.sets[set].hi.update(s, SESSION_RATE);
            }
        }
    }

    /// Bytes the tables hold.
    pub fn bytes(&self) -> usize {
        self.sets.len() * size_of::<Set>() + self.lo.len() * size_of::<Cdf>()
    }
}

/// A session's tables over the static model, as a frame's prior.
pub(super) struct Layered<'a> {
    pub(super) session: &'a SessionModel,
    pub(super) base: &'a StaticModel,
}

#[expect(
    clippy::indexing_slicing,
    reason = "every key indexes the `KEYS` index, and its entries name sets and low \
              tables the session's fold pushed"
)]
impl Prior for Layered<'_> {
    #[inline]
    fn hi(&self, key: u32) -> &Cdf {
        match self.session.index[key as usize] {
            0 => self.base.hi(key),
            at => &self.session.sets[at as usize - 1].hi,
        }
    }

    #[inline]
    fn lo(&self, key: u32, h: usize) -> &Cdf {
        match self.session.index[key as usize] {
            0 => self.base.lo(key, h),
            at => match self.session.sets[at as usize - 1].lo_at[h & 15] {
                0 => self.base.lo(key, h),
                lo => &self.session.lo[lo as usize - 1],
            },
        }
    }

    #[inline]
    fn rate(&self, key: u32) -> u8 {
        self.base.rate(key)
    }
}

/// An epoch declaration: epoch `id` is epoch `base` (0: no session yet) with
/// the traces of the datagrams `first + i` for every bit `i` of `datagrams`
/// folded in, in that order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MzEpochDeclaration {
    pub id: u8,
    pub base: u8,
    pub first: u32,
    pub datagrams: u64,
}

impl MzEpochDeclaration {
    /// The bytes a declaration takes on the wire.
    pub const BYTES: usize = 14;

    /// Append the declaration: id, base, first (BE u32), datagrams (BE u64).
    pub fn write(&self, out: &mut Vec<u8>) {
        out.push(self.id);
        out.push(self.base);
        out.extend_from_slice(&self.first.to_be_bytes());
        out.extend_from_slice(&self.datagrams.to_be_bytes());
    }

    /// The declaration `bytes` begin with; `None` for one no sender writes.
    pub fn read(bytes: &[u8]) -> Option<Self> {
        let bytes: &[u8; Self::BYTES] = bytes.get(..Self::BYTES)?.try_into().ok()?;
        let declaration = Self {
            id: bytes[0],
            base: bytes[1],
            first: u32::from_be_bytes(bytes[2..6].try_into().ok()?),
            datagrams: u64::from_be_bytes(bytes[6..14].try_into().ok()?),
        };
        (EPOCH_IDS.contains(&declaration.id)
            && (declaration.base == 0 || EPOCH_IDS.contains(&declaration.base))
            && declaration.base != declaration.id
            && declaration.datagrams != 0)
            .then_some(declaration)
    }

    /// The declaration's datagrams, in fold order.
    pub fn seqs(&self) -> impl Iterator<Item = u32> + '_ {
        (0..MZ_EPOCH_DATAGRAMS)
            .filter(|bit| self.datagrams >> bit & 1 == 1)
            .map(|bit| self.first.wrapping_add(bit))
    }
}

/// The ids an epoch takes: a frame's prior byte names one in its low seven
/// bits, zero naming the static model.
const EPOCH_IDS: std::ops::RangeInclusive<u8> = 1..=0x7f;

/// The next epoch id after `id`, cycling through `EPOCH_IDS`.
pub fn next_epoch_id(id: u8) -> u8 {
    if id >= *EPOCH_IDS.end() { 1 } else { id + 1 }
}

/// Why a receiver cannot build a declared epoch.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MzEpochError {
    /// It does not hold the base epoch.
    Base,
    /// It does not hold the trace of a declared datagram.
    Trace,
}

/// Trace buffers kept for reuse, ordered by capacity, so a trace takes the
/// smallest buffer that holds it and a steady stream of traces of mixed
/// lengths allocates nothing once each length has been seen.
#[derive(Default)]
pub struct MzTracePool {
    buffers: Vec<Vec<u32>>,
}

/// A resource bound: buffers a pool keeps, one trace window.
const POOL_BUFFERS: usize = TRACE_DATAGRAMS as usize;

impl MzTracePool {
    /// An empty buffer that holds `len` symbols: the smallest pooled one that
    /// does, else a new one sized to the power of two at or above `len`, so a
    /// stream of traces settles on a few sizes after its first frames.
    pub fn take(&mut self, len: usize) -> Vec<u32> {
        let at = self.buffers.partition_point(|buffer| buffer.capacity() < len);
        if at < self.buffers.len() {
            let mut buffer = self.buffers.remove(at);
            buffer.clear();
            buffer
        } else {
            Vec::with_capacity(len.next_power_of_two())
        }
    }

    /// Keep `buffer` for a later `take`; one that holds nothing is not worth
    /// keeping.
    pub fn put(&mut self, buffer: Vec<u32>) {
        if buffer.capacity() == 0 || self.buffers.len() >= POOL_BUFFERS {
            return;
        }
        let at = self.buffers.partition_point(|held| held.capacity() < buffer.capacity());
        self.buffers.insert(at, buffer);
    }
}

/// One end's session epochs: the traces of the current generation's datagrams
/// not yet folded, and the newest epoch with the base it was declared over, so
/// frames coded against the base while the newest was being acknowledged
/// still decode.
#[derive(Default)]
pub struct MzSession {
    traces: HashMap<u32, Vec<u32>>,
    /// Kept traces' sequences, oldest first, so the window retires by
    /// sequence distance.
    order: std::collections::VecDeque<u32>,
    spare: MzTracePool,
    current: Option<(u8, SessionModel)>,
    previous: Option<(u8, SessionModel)>,
}

/// The sequence distance behind the newest kept trace a session keeps traces
/// for: twice a declaration's reach, so a declaration the sender bounds to
/// its reach finds every trace it names here whatever reordering moved the
/// frame carrying it by up to a reach.
const TRACE_DATAGRAMS: u32 = 2 * super::history::MZ_REFERENCE_DATAGRAMS;

/// The sequence distance behind the frame carrying it that a declaration may
/// name a datagram from.
pub const MZ_DECLARATION_REACH: u32 = super::history::MZ_REFERENCE_DATAGRAMS;

#[inline]
fn older(a: u32, b: u32) -> bool {
    matches!(b.wrapping_sub(a), 1..0x8000_0000)
}

impl MzSession {
    /// Forget everything: the session's screens are gone.
    pub fn clear(&mut self) {
        for (_, trace) in self.traces.drain() {
            self.spare.put(trace);
        }
        self.order.clear();
        self.current = None;
        self.previous = None;
    }

    /// A display generation began: its sequences start over, so every kept
    /// trace goes. The epochs stay; they describe content, not order.
    pub fn begin_generation(&mut self) {
        for (_, trace) in self.traces.drain() {
            self.spare.put(trace);
        }
        self.order.clear();
    }

    /// Append one chunk of the generation's snapshot, datagram 0, to its
    /// trace: the chunks fold in chunk order, as one datagram.
    pub fn keep_snapshot_chunk(&mut self, trace: &[u32]) {
        match self.traces.get_mut(&0) {
            Some(held) => held.extend_from_slice(trace),
            None => self.keep(0, trace),
        }
    }

    /// Keep datagram `seq`'s trace for a later fold, retiring every trace
    /// `TRACE_DATAGRAMS` or more behind it.
    pub fn keep(&mut self, seq: u32, trace: &[u32]) {
        let floor = seq.wrapping_sub(TRACE_DATAGRAMS - 1);
        while let Some(&oldest) = self.order.front() {
            if !older(oldest, floor) {
                break;
            }
            self.order.pop_front();
            if let Some(old) = self.traces.remove(&oldest) {
                self.spare.put(old);
            }
        }
        let mut kept = self.spare.take(trace.len());
        kept.extend_from_slice(trace);
        match self.traces.insert(seq, kept) {
            Some(old) => self.spare.put(old),
            None => self.order.push_back(seq),
        }
    }

    /// Whether this end holds what `declaration` folds: its base epoch and
    /// every declared trace.
    pub fn can_build(&self, declaration: &MzEpochDeclaration) -> bool {
        (declaration.base == 0 || self.epoch(declaration.base).is_some())
            && declaration.seqs().all(|seq| self.traces.contains_key(&seq))
    }

    /// Whether keeping `seq`'s trace retires one a pending declaration may
    /// name.
    fn retires_before(&self, seq: u32) -> bool {
        self.order
            .front()
            .is_some_and(|&oldest| older(oldest, seq.wrapping_sub(TRACE_DATAGRAMS - 1)))
    }

    /// Build the declared epoch from its base and the declared traces, and
    /// make it current, keeping exactly its base beside it: until the sender
    /// learns this epoch is held, it codes against the base, which is what it
    /// named when it declared this one. A built epoch the sender abandoned is
    /// never a base, so the next build drops it.
    pub fn build(&mut self, declaration: &MzEpochDeclaration) -> Result<(), MzEpochError> {
        let mut model = match declaration.base {
            0 => SessionModel::default(),
            base => self.epoch(base).ok_or(MzEpochError::Base)?.clone(),
        };
        if declaration.seqs().any(|seq| !self.traces.contains_key(&seq)) {
            return Err(MzEpochError::Trace);
        }
        for seq in declaration.seqs() {
            if let Some(trace) = self.traces.remove(&seq) {
                model.fold(&trace);
                self.spare.put(trace);
            }
        }
        let base = [self.current.take(), self.previous.take()]
            .into_iter()
            .flatten()
            .find(|(id, _)| *id == declaration.base);
        self.previous = base;
        self.current = Some((declaration.id, model));
        Ok(())
    }

    /// Epoch `id`, when held.
    pub fn epoch(&self, id: u8) -> Option<&SessionModel> {
        [&self.current, &self.previous]
            .into_iter()
            .flatten()
            .find(|(held, _)| *held == id)
            .map(|(_, model)| model)
    }

    /// The newest epoch held.
    pub fn current(&self) -> Option<(u8, &SessionModel)> {
        self.current.as_ref().map(|(id, model)| (*id, model))
    }

    /// Whether datagram `seq`'s trace is held.
    pub fn holds_trace(&self, seq: u32) -> bool {
        self.traces.contains_key(&seq)
    }
}

/// A receiver's MZ state: the rows it holds for copies, its session epochs,
/// the epochs declared to it but not yet built, and the display generation its
/// frames belong to.
#[derive(Default)]
pub struct MzReceiver {
    pub history: super::history::RowHistory,
    session: MzSession,
    decoder: super::frame::MzDecoder,
    /// Declared epochs waiting to be built, oldest first.
    pending: Vec<MzEpochDeclaration>,
    /// The newest display generation a frame was decoded in; 0 before any.
    generation: u32,
    /// Frames of the current generation refused as unresolved, wrapping: the
    /// sender reads a change as proof its view of this end was wrong.
    refusals: u32,
}

struct ReceiverSources<'a> {
    history: &'a super::history::RowHistory,
    session: &'a MzSession,
    generation: u32,
    presentation_id: u32,
}

impl super::frame::MzSources for ReceiverSources<'_> {
    fn row(&self, previous: bool, back: u32, row: u16) -> Result<super::frame::MzRow<'_>, super::frame::MzError> {
        self.history.row(self.generation, self.presentation_id, previous, back, row)
    }

    fn epoch(&self, id: u8) -> Option<&SessionModel> {
        self.session.epoch(id)
    }
}

impl MzReceiver {
    /// Forget every row and epoch: the grid they describe is gone. The
    /// refusal count starts over, as the sender's reading of it does when the
    /// resume claims no grid.
    pub fn clear(&mut self) {
        self.history.clear();
        self.session.clear();
        self.pending.clear();
        self.generation = 0;
        self.refusals = 0;
    }

    /// A frame of display generation `generation` arrived, compressed or not:
    /// a newer generation begins here.
    pub fn observe_generation(&mut self, generation: u32) {
        if generation != 0 && (self.generation == 0 || older(self.generation, generation)) {
            self.begin_generation(generation);
        }
    }

    /// Generation `generation` began: every declaration pending is built
    /// first, since the sender may already count one held, and then the
    /// generation's traces and the rows two generations old go.
    fn begin_generation(&mut self, generation: u32) {
        while self.build_pending() {}
        self.pending.clear();
        self.session.begin_generation();
        self.history.begin_generation(generation);
        self.generation = generation;
    }

    /// Decode the payload of datagram `seq` of display generation
    /// `generation` (0: the generation's snapshot, one call per chunk in chunk
    /// order), presented as `presentation_id`, of `row_count` entries and
    /// `rows_len` row-layout bytes, into `out`. A newer generation begins
    /// here. A declaration it carries is kept to build; an epoch it names that
    /// is declared but not yet built is built first. A frame of an older
    /// generation still decodes against the rows it can name, but its trace
    /// and any declaration it carries are of a generation whose traces are
    /// gone.
    #[expect(clippy::too_many_arguments, reason = "a frame's identity, payload and output")]
    pub fn decode(
        &mut self,
        generation: u32,
        seq: u32,
        presentation_id: u32,
        payload: &[u8],
        row_count: u16,
        rows_len: usize,
        out: &mut Vec<u8>,
    ) -> Result<(), super::frame::MzError> {
        self.observe_generation(generation);
        let current = generation == self.generation;
        let result = self.decode_frame(current, generation, seq, presentation_id, payload, row_count, rows_len, out);
        if current && result == Err(super::frame::MzError::Unresolved) {
            self.refusals = self.refusals.wrapping_add(1);
        }
        result
    }

    #[expect(clippy::too_many_arguments, reason = "`decode`'s arguments, resolved")]
    fn decode_frame(
        &mut self,
        current: bool,
        generation: u32,
        seq: u32,
        presentation_id: u32,
        payload: &[u8],
        row_count: u16,
        rows_len: usize,
        out: &mut Vec<u8>,
    ) -> Result<(), super::frame::MzError> {
        let (prior, declaration) = super::frame::MzDecoder::peek(payload)?;
        if let Some(declaration) = declaration
            && self.session.epoch(declaration.id).is_none()
            && !self.pending.contains(&declaration)
        {
            // A declaration this end cannot build is refused with its frame,
            // so the sender never takes it for held.
            let base_pending = self.pending.iter().any(|pending| pending.id == declaration.base);
            if !current || (!base_pending && !self.session.can_build(&declaration)) {
                return Err(super::frame::MzError::Unresolved);
            }
            self.pending.push(declaration);
        }
        if prior != 0 && self.session.epoch(prior).is_none() {
            self.build_through(prior);
        }
        let sources = ReceiverSources {
            history: &self.history,
            session: &self.session,
            generation,
            presentation_id,
        };
        self.decoder.decode(payload, row_count, rows_len, &sources, out)?;
        if !current {
            return Ok(());
        }
        if seq == 0 {
            self.session.keep_snapshot_chunk(self.decoder.trace());
            return Ok(());
        }
        // Keeping this trace retires the oldest; a pending declaration may
        // still name one, so build those first.
        if !self.pending.is_empty() && self.session.retires_before(seq) {
            while self.build_pending() {}
        }
        self.session.keep(seq, self.decoder.trace());
        Ok(())
    }

    /// Frames of the current generation refused as unresolved since this
    /// receiver began, wrapping.
    pub fn refusals(&self) -> u32 {
        self.refusals
    }

    /// The generation the newest decoded frame belonged to; 0 before any.
    pub fn generation(&self) -> u32 {
        self.generation
    }

    /// Build every pending epoch up to and including `id`.
    fn build_through(&mut self, id: u8) {
        while let Some(at) = self.pending.iter().position(|declaration| declaration.base == 0 || self.session.epoch(declaration.base).is_some()) {
            let declaration = self.pending.remove(at);
            let built = declaration.id;
            // A declaration was taken only once buildable, so this builds;
            // were it not, frames naming the epoch are refused as unresolved.
            if self.session.build(&declaration).is_err() {
                continue;
            }
            if built == id {
                return;
            }
        }
    }

    /// Build one pending epoch, off the decode path. Returns whether more wait.
    pub fn build_pending(&mut self) -> bool {
        let Some(at) = self.pending.iter().position(|declaration| declaration.base == 0 || self.session.epoch(declaration.base).is_some()) else {
            // None can build, now or later: their frames are refused as
            // unresolved.
            self.pending.clear();
            return false;
        };
        let declaration = self.pending.remove(at);
        // As in `build_through`: a failed build leaves frames naming the
        // epoch unresolved.
        if self.session.build(&declaration).is_err() {
            return !self.pending.is_empty();
        }
        !self.pending.is_empty()
    }

    /// The newest epoch held, for tests and accounting.
    pub fn epoch(&self) -> Option<u8> {
        self.session.current().map(|(id, _)| id)
    }

    /// Bytes of the distinct rows held, for tests and memory accounting.
    pub fn held_bytes(&self) -> usize {
        self.history.held_bytes()
    }
}
