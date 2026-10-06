//! Display FEC recovery: the port of `fec-decoder.ts`, over `merkur-fec`.
//!
//! The daemon protects a batch of datagrams with one repair envelope: parity
//! over the frames' plaintexts, each padded to the shard size. The viewer
//! keeps every protected frame for a retention window, and when a batch's
//! repair arrives with no more frames missing than it carries parity, rebuilds
//! the missing ones. A rebuilt frame must name the sequence and generation its
//! place in the batch implies; anything else was rebuilt from a wrong input
//! and is dropped, costing one datagram the daemon re-sends anyway.
//!
//! Every generation restarts its sequences, so all state belongs to one
//! generation: an older one is ignored and a newer one clears the slate.

use merkur_codec::{
    DISPLAY_HEADER_FLAG_FEC_PROTECTED, MSG_TYPE_DISPLAY_FEC_REPAIR, MSG_TYPE_DISPLAY_PATCH,
    STREAM_HEADER_BYTES, parse_stream_header,
};
use merkur_fec::repair::{RepairHeader, parse_repair, recover_batch_into};
use merkur_fec::{FEC_MAX_DATA, FEC_MAX_SHARD_BYTES};

use super::display_serial_is_newer;

/// How far behind the newest sequence a protected frame is kept, mirrored
/// from `FEC_RETENTION_WINDOW`. A repair follows its batch at once, so this
/// bounds memory rather than recovery.
const RETENTION_WINDOW: u32 = 1_000;
/// One slot per retained sequence: the window and the newest.
const RETAINED: usize = RETENTION_WINDOW as usize + 1;
const HALF_RANGE: u32 = 0x8000_0000;
/// Display sequences skip zero, so they wrap modulo this.
const SEQUENCE_MAX: u64 = 0xffff_ffff;
/// Recovery buffers kept from finished batches for the repairs that follow. A
/// repair follows its batch at once, so one batch is live at a time; the rest
/// cover batches that overlap under reordering.
const SPARE_RECOVERY_BUFFERS: usize = 4;

/// One retained frame; sequence 0 marks an empty slot. A slot's buffer keeps
/// its capacity, so a draining socket allocates nothing in steady state.
#[derive(Default)]
struct Retained {
    seq: u32,
    bytes: Vec<u8>,
}

struct Batch {
    header: RepairHeader,
    recovery: Vec<u8>,
}

impl Batch {
    fn covers(&self, seq: u32) -> bool {
        forward_distance(self.header.batch_start_seq, seq) < u32::from(self.header.data_shards)
    }
}

/// The frames one arrival let the viewer rebuild. A slot keeps its capacity
/// from one arrival to the next, so rebuilding on a lossy link allocates
/// nothing in steady state.
#[derive(Default)]
pub(super) struct Rebuilt {
    frames: Vec<Vec<u8>>,
    len: usize,
}

impl Rebuilt {
    fn push(&mut self, frame: &[u8]) {
        if self.len == self.frames.len() {
            self.frames.push(Vec::new());
        }
        let slot = &mut self.frames[self.len];
        slot.clear();
        slot.extend_from_slice(frame);
        self.len += 1;
    }

    pub(super) fn iter(&self) -> impl Iterator<Item = &[u8]> {
        self.frames[..self.len].iter().map(Vec::as_slice)
    }
}

pub(super) struct FecDecoder {
    generation: u32,
    newest: Option<u32>,
    retained: Vec<Retained>,
    batches: Vec<Batch>,
    /// Recovery buffers of finished batches, emptied, for the next repairs.
    spare: Vec<Vec<u8>>,
    padded: Vec<u8>,
    output: Vec<u8>,
}

impl Default for FecDecoder {
    fn default() -> Self {
        Self {
            generation: 0,
            newest: None,
            retained: std::iter::repeat_with(Retained::default)
                .take(RETAINED)
                .collect(),
            batches: Vec::new(),
            spare: Vec::new(),
            padded: Vec::new(),
            output: Vec::new(),
        }
    }
}

impl FecDecoder {
    pub(super) fn reset(&mut self) {
        for slot in &mut self.retained {
            slot.seq = 0;
        }
        while !self.batches.is_empty() {
            self.retire(0);
        }
        self.generation = 0;
        self.newest = None;
    }

    /// Take in one frame as it arrived from the wire; `rebuilt` becomes the
    /// frames it lets the viewer rebuild.
    pub(super) fn receive(&mut self, payload: &[u8], rebuilt: &mut Rebuilt) {
        rebuilt.len = 0;
        if payload.first() == Some(&MSG_TYPE_DISPLAY_FEC_REPAIR) {
            return self.repair(payload, rebuilt);
        }
        let Some(stream) = parse_stream_header(payload) else {
            return;
        };
        // A frame longer than a shard is in no batch: the daemon writes no
        // repair over one and `parse_repair` refuses a larger shard size. Kept,
        // it would let every slot grow to the frame limit instead of a shard.
        if stream.flags & DISPLAY_HEADER_FLAG_FEC_PROTECTED == 0
            || payload.len() > FEC_MAX_SHARD_BYTES
            || stream.seq == 0
            || !self.sync_generation(stream.generation)
        {
            return;
        }
        self.prune(stream.seq);
        if self.expired(stream.seq) {
            return;
        }
        let slot = &mut self.retained[slot_of(stream.seq)];
        slot.seq = stream.seq;
        slot.bytes.clear();
        slot.bytes.extend_from_slice(payload);
        if let Some(index) = self
            .batches
            .iter()
            .position(|batch| batch.covers(stream.seq))
        {
            self.recover(index, rebuilt);
        }
    }

    fn repair(&mut self, payload: &[u8], rebuilt: &mut Rebuilt) {
        let Some((header, body)) = parse_repair(payload) else {
            return;
        };
        // Single-shard protection is an exact replay of the patch, never a
        // repair envelope, and no flag bits are defined.
        if header.data_shards < 2
            || payload[1] != 0
            || header.batch_start_seq == 0
            || header.generation == 0
            || !self.sync_generation(header.generation)
        {
            return;
        }
        self.prune(add(
            header.batch_start_seq,
            u32::from(header.data_shards) - 1,
        ));
        if self.expired(header.batch_start_seq) {
            return;
        }
        let index = match self
            .batches
            .iter()
            .position(|batch| batch.header.batch_start_seq == header.batch_start_seq)
        {
            Some(index) => {
                let batch = &mut self.batches[index];
                batch.header = header;
                batch.recovery.clear();
                batch.recovery.extend_from_slice(body);
                index
            }
            None => {
                let mut recovery = self.spare.pop().unwrap_or_default();
                recovery.extend_from_slice(body);
                self.batches.push(Batch { header, recovery });
                self.batches.len() - 1
            }
        };
        self.recover(index, rebuilt);
    }

    fn recover(&mut self, index: usize, rebuilt: &mut Rebuilt) {
        let header = self.batches[index].header;
        let data_shards = usize::from(header.data_shards);
        let shard_size = usize::from(header.shard_size);
        let mut received: [Option<&[u8]>; FEC_MAX_DATA] = [None; FEC_MAX_DATA];
        let mut missing = 0;
        for (offset, shard) in received[..data_shards].iter_mut().enumerate() {
            let seq = add(header.batch_start_seq, offset as u32);
            let slot = &self.retained[slot_of(seq)];
            if slot.seq == seq && !expired(self.newest, seq) {
                *shard = Some(&slot.bytes);
            } else {
                missing += 1;
            }
        }
        if missing == 0 {
            return self.complete(index);
        }
        if missing > usize::from(header.recovery_shards) {
            return;
        }
        let span = data_shards * shard_size;
        if self.padded.len() < span {
            self.padded.resize(span, 0);
            self.output.resize(span, 0);
        }
        let restored = recover_batch_into(
            &header,
            &received[..data_shards],
            &self.batches[index].recovery,
            &mut self.padded,
            &mut self.output,
        );
        if restored == 0 {
            self.retire(index);
            return;
        }
        for offset in 0..data_shards {
            if restored & (1 << offset) == 0 {
                continue;
            }
            let shard = &self.output[offset * shard_size..(offset + 1) * shard_size];
            let seq = add(header.batch_start_seq, offset as u32);
            if let Some(len) = plausible(shard, seq, self.generation) {
                rebuilt.push(&shard[..len]);
            }
        }
        self.complete(index);
    }

    /// A batch every frame of which arrived or was rebuilt: it and its frames go.
    fn complete(&mut self, index: usize) {
        let header = self.retire(index);
        for offset in 0..u32::from(header.data_shards) {
            let seq = add(header.batch_start_seq, offset);
            let slot = &mut self.retained[slot_of(seq)];
            if slot.seq == seq {
                slot.seq = 0;
            }
        }
    }

    /// Drop batch `index`, keeping its recovery buffer for a later repair.
    fn retire(&mut self, index: usize) -> RepairHeader {
        let mut batch = self.batches.swap_remove(index);
        if self.spare.len() < SPARE_RECOVERY_BUFFERS {
            batch.recovery.clear();
            self.spare.push(batch.recovery);
        }
        batch.header
    }

    fn sync_generation(&mut self, generation: u32) -> bool {
        if generation == 0 {
            return false;
        }
        if generation != self.generation {
            if !display_serial_is_newer(generation, self.generation) {
                return false;
            }
            self.reset();
            self.generation = generation;
        }
        true
    }

    fn expired(&self, seq: u32) -> bool {
        expired(self.newest, seq)
    }

    /// Advance the newest sequence; batches that fell out of the window go.
    fn prune(&mut self, seq: u32) {
        if seq == 0 {
            return;
        }
        let Some(newest) = self.newest else {
            self.newest = Some(seq);
            return;
        };
        let advance = forward_distance(newest, seq);
        if advance == 0 || advance >= HALF_RANGE {
            return;
        }
        self.newest = Some(seq);
        let mut index = 0;
        while index < self.batches.len() {
            if expired(self.newest, self.batches[index].header.batch_start_seq) {
                self.retire(index);
            } else {
                index += 1;
            }
        }
    }
}

/// The frame length a rebuilt shard holds, if its header names exactly the
/// place it was rebuilt for.
fn plausible(shard: &[u8], seq: u32, generation: u32) -> Option<usize> {
    let stream = parse_stream_header(shard)?;
    // The body is measured against what follows the header. Adding the header
    // length to it first can wrap a 32-bit `usize`, as wasm32's is, to a
    // length inside the shard.
    let body_len = usize::try_from(stream.body_len).ok()?;
    let room = shard.len().checked_sub(STREAM_HEADER_BYTES)?;
    (stream.msg_type == MSG_TYPE_DISPLAY_PATCH
        && body_len <= room
        && stream.seq == seq
        && stream.generation == generation)
        .then(|| STREAM_HEADER_BYTES + body_len)
}

fn expired(newest: Option<u32>, seq: u32) -> bool {
    newest.is_some_and(|newest| {
        let age = forward_distance(seq, newest);
        age > RETENTION_WINDOW && age < HALF_RANGE
    })
}

fn slot_of(seq: u32) -> usize {
    seq as usize % RETAINED
}

/// `seq` advanced by `amount` in the zero-skipping sequence space.
fn add(seq: u32, amount: u32) -> u32 {
    ((u64::from(seq) - 1 + u64::from(amount)) % SEQUENCE_MAX + 1) as u32
}

/// How far `to` is ahead of `from` in the zero-skipping sequence space.
fn forward_distance(from: u32, to: u32) -> u32 {
    if to >= from {
        to - from
    } else {
        (SEQUENCE_MAX - u64::from(from) + u64::from(to)) as u32
    }
}

#[cfg(test)]
mod tests;
