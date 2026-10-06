//! Input the daemon has not acknowledged, and the numbering it goes out
//! under: the port of `input-outbox.ts`.
//!
//! The host numbers records from its own counter; the daemon expects wire
//! sequences contiguous from its next-expected one, and a fresh peer starts
//! them again. `wire = local + offset` for every held and future record.
//! Genesis re-aligns the offset so the first surviving record lands exactly on
//! the daemon's next-expected sequence, and releases the records that daemon
//! already applied, whose acknowledgement died with the carrier: renumbering
//! them would apply them twice.

use std::collections::VecDeque;

use crate::input_sequence::{InputMapping, input_sequence_delta};

struct Entry {
    local: u32,
    record: Vec<u8>,
    /// The viewer's speculative model painted this record's effect.
    modelled: bool,
}

impl Drop for Entry {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        self.record.zeroize();
    }
}

pub(super) struct Outbox {
    entries: VecDeque<Entry>,
    offset: i64,
    /// A genesis that found nothing held anchors the offset on the next record.
    pending_rebase: Option<u32>,
    last_acked: u32,
    last_local: u32,
    last_released_local: u32,
    bytes: usize,
    mapping: InputMapping,
    /// Entries `[0, reliable_sent)` already rode the reliable stream.
    pub(super) reliable_sent: usize,
}

impl Outbox {
    pub(super) fn new() -> Self {
        Self {
            entries: VecDeque::new(),
            offset: 0,
            pending_rebase: None,
            last_acked: 0,
            last_local: 0,
            last_released_local: 0,
            bytes: 0,
            mapping: InputMapping {
                epoch: 1,
                ..InputMapping::default()
            },
            reliable_sent: 0,
        }
    }

    fn wire_of(&self, local: u32) -> i64 {
        i64::from(local) + self.offset
    }

    /// The wire sequence of held entry `index`.
    pub(super) fn wire(&self, index: usize) -> u32 {
        self.wire_of(self.entries[index].local) as u32
    }

    pub(super) fn len(&self) -> usize {
        self.entries.len()
    }

    pub(super) fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Retirement discards wiping input owners without inventing an ACK.
    pub(super) fn discard(&mut self) {
        self.entries.clear();
        self.bytes = 0;
        self.reliable_sent = 0;
    }

    /// Held entries from `from`, `count` at most, as an input run takes them.
    pub(super) fn run(
        &self,
        from: usize,
        count: usize,
    ) -> impl ExactSizeIterator<Item = (&[u8], bool)> + Clone {
        self.entries
            .iter()
            .skip(from)
            .take(count)
            .map(|entry| (&entry.record[..], entry.modelled))
    }

    pub(super) fn records(&self) -> impl Iterator<Item = &[u8]> {
        self.entries.iter().map(|entry| &entry.record[..])
    }

    /// Hold one record under the wire namespace. False when its wire sequence
    /// would leave `1..=u32::MAX`, which no contiguous namespace recovers from.
    pub(super) fn admit(&mut self, local: u32, record: Vec<u8>, modelled: bool) -> bool {
        // Own wiping before any admission check can refuse the input.
        let entry = Entry {
            local,
            record,
            modelled,
        };
        if self.entries.len() >= crate::input_delivery::MAX_INPUT_ENTRIES
            || entry.record.len()
                > crate::input_delivery::MAX_INPUT_BYTES.saturating_sub(self.bytes)
        {
            return false;
        }
        if let Some(wire) = self.pending_rebase.take() {
            self.offset = i64::from(wire) - i64::from(local);
        }
        let Ok(wire) = u32::try_from(self.wire_of(local)) else {
            return false;
        };
        if wire == 0 {
            return false;
        }
        self.last_local = local;
        self.record_mapping(local, wire);
        self.bytes += entry.record.len();
        self.entries.push_back(entry);
        true
    }

    /// Acknowledge every wire sequence through `seq`, cumulatively.
    pub(super) fn ack(&mut self, seq: u32) {
        if seq <= self.last_acked {
            return;
        }
        self.last_acked = seq;
        let released = self
            .entries
            .iter()
            .take_while(|entry| self.wire_of(entry.local) <= i64::from(seq))
            .count();
        for entry in self.entries.drain(..released) {
            self.bytes -= entry.record.len();
            self.last_released_local = entry.local;
        }
        self.reliable_sent = self.reliable_sent.saturating_sub(released);
    }

    /// Re-align to a new session's next-expected sequence `next_expected`:
    /// release what that daemon already applied, then number the surviving
    /// suffix, and every record after it, contiguously from it.
    pub(super) fn rebase(&mut self, next_expected: u32) {
        if next_expected == 0 {
            return;
        }
        let expected = i64::from(next_expected);
        let released = self
            .entries
            .iter()
            .take_while(|entry| self.wire_of(entry.local) < expected)
            .count();
        for entry in self.entries.drain(..released) {
            self.bytes -= entry.record.len();
            self.last_released_local = entry.local;
        }
        self.reliable_sent = self.reliable_sent.saturating_sub(released);
        self.last_acked = next_expected - 1;

        let previous = self.mapping;
        self.advance_epoch();
        if let Some(first) = self.entries.front() {
            let first_local = first.local;
            self.offset = expected - i64::from(first_local);
            self.pending_rebase = None;
            let delta = input_sequence_delta(first_local, next_expected);
            let rebased_max = next_expected.saturating_add(self.entries.len() as u32 - 1);
            self.mapping.local_minus_wire = delta;
            if previous.wire_min != 0
                && previous.local_minus_wire == delta
                && u64::from(next_expected) <= u64::from(previous.wire_max) + 1
            {
                // Resumed in the same namespace: a cumulative display frame
                // may still name an input already applied under it.
                self.mapping.wire_min = previous.wire_min;
                self.mapping.wire_max = previous.wire_max.max(rebased_max);
            } else {
                // The same wire numbers now name other inputs.
                self.mapping.wire_min = next_expected;
                self.mapping.wire_max = rebased_max;
            }
        } else {
            self.pending_rebase = Some(next_expected);
            let retains = self.last_local.checked_add(1).is_some_and(|next_local| {
                previous.wire_min != 0
                    && u64::from(next_expected) == u64::from(previous.wire_max) + 1
                    && input_sequence_delta(next_local, next_expected) == previous.local_minus_wire
            });
            if retains {
                self.mapping.local_minus_wire = previous.local_minus_wire;
                self.mapping.wire_min = previous.wire_min;
                self.mapping.wire_max = previous.wire_max;
            } else {
                self.deactivate_mapping();
            }
        }
    }

    /// A new authenticated lineage: every held record's speculative grant
    /// belonged to the model it replaced.
    pub(super) fn revoke_provenance(&mut self) {
        for entry in &mut self.entries {
            entry.modelled = false;
        }
    }

    pub(super) fn mapping(&self) -> InputMapping {
        self.mapping
    }

    pub(super) fn released_local(&self) -> u32 {
        self.last_released_local
    }

    /// The newest wire sequence the daemon acknowledged.
    pub(super) fn acked(&self) -> u32 {
        self.last_acked
    }

    /// The newest wire sequence held, or 0 when nothing is.
    pub(super) fn top(&self) -> u32 {
        self.entries
            .back()
            .map_or(0, |entry| self.wire_of(entry.local) as u32)
    }

    fn record_mapping(&mut self, local: u32, wire: u32) {
        let delta = input_sequence_delta(local, wire);
        if self.mapping.wire_min != 0
            && self.mapping.local_minus_wire == delta
            && u64::from(wire) == u64::from(self.mapping.wire_max) + 1
        {
            self.mapping.wire_max = wire;
            return;
        }
        if self.mapping.wire_min != 0 {
            // Unreachable while the host numbers records contiguously; fails
            // closed if it ever does not, so a stale interval never
            // translates a disjoint one.
            self.advance_epoch();
        }
        self.mapping.local_minus_wire = delta;
        self.mapping.wire_min = wire;
        self.mapping.wire_max = wire;
    }

    fn advance_epoch(&mut self) {
        self.mapping.epoch = self.mapping.epoch.wrapping_add(1).max(1);
    }

    fn deactivate_mapping(&mut self) {
        self.mapping.local_minus_wire = 0;
        self.mapping.wire_min = 0;
        self.mapping.wire_max = 0;
    }
}

#[cfg(test)]
mod tests;
