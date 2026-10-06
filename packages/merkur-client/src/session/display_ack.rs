//! When a display ACK also takes the reliable control lane. The port of the
//! transport worker's `maybeSendReliableDisplayAck`.
//!
//! The datagram ACK is the low-latency signal. The reliable copy advances the
//! daemon's acknowledged baseline when datagram ACKs are lost, at a coarse
//! cadence, plus at once for what a lost datagram would strand: a new
//! generation, newly FEC-recovered sequences (the daemon's repair evidence),
//! and a durable grant, which fills the viewer's demand window so that nothing
//! would repeat it.

use merkur_wire::protocol::{DISPLAY_ACK_MASK_WINDOW, DISPLAY_ACK_MASK_WORDS, DisplayAckPayload};

use crate::viewer::display_serial_is_newer;

/// Mirrored from `RELIABLE_ACK_MIN_INTERVAL_MS`.
const RELIABLE_ACK_MIN_INTERVAL_MS: u64 = 400;

#[derive(Default)]
pub(super) struct ReliableAcks {
    last: Option<Sent>,
}

struct Sent {
    generation: u32,
    largest_seq: u32,
    at_ms: u64,
    recovered: [u32; DISPLAY_ACK_MASK_WORDS],
    grant: u32,
}

impl ReliableAcks {
    /// A new session or carrier: nothing has been sent on it.
    pub(super) fn reset(&mut self) {
        self.last = None;
    }

    /// Whether `ack` also goes reliably; recorded as sent if so.
    pub(super) fn admit(&mut self, now_ms: u64, ack: &DisplayAckPayload, durable: bool) -> bool {
        let admitted = match &self.last {
            None => true,
            Some(last) if last.generation != ack.generation => true,
            Some(last) => {
                let seq_advanced = display_serial_is_newer(ack.largest_seq, last.largest_seq);
                let recovery_added = last.recovery_added(ack);
                let durable_grant_added = durable && display_serial_is_newer(ack.grant, last.grant);
                let interval_elapsed =
                    now_ms.saturating_sub(last.at_ms) >= RELIABLE_ACK_MIN_INTERVAL_MS;
                (seq_advanced && interval_elapsed) || recovery_added || durable_grant_added
            }
        };
        if admitted {
            self.last = Some(Sent {
                generation: ack.generation,
                largest_seq: ack.largest_seq,
                at_ms: now_ms,
                recovered: ack.recovered,
                grant: ack.grant,
            });
        }
        admitted
    }
}

impl Sent {
    /// Whether the re-anchored recovered mask holds a bit not yet sent.
    fn recovery_added(&self, ack: &DisplayAckPayload) -> bool {
        let distance = ack.largest_seq.wrapping_sub(self.largest_seq) as i32;
        if distance < 0 || distance as u32 >= DISPLAY_ACK_MASK_WINDOW {
            return ack.recovered.iter().any(|word| *word != 0);
        }
        let distance = distance as u32;
        (0..DISPLAY_ACK_MASK_WORDS)
            .any(|word| ack.recovered[word] & !self.shifted(word, distance) != 0)
    }

    /// Word `target` of the sent recovered mask moved up by `distance`.
    fn shifted(&self, target: usize, distance: u32) -> u32 {
        let (word_shift, bit_shift) = ((distance >> 5) as usize, distance & 31);
        let Some(source) = target.checked_sub(word_shift) else {
            return 0;
        };
        let mut value = self.recovered[source] << bit_shift;
        if bit_shift > 0 && source > 0 {
            value |= self.recovered[source - 1] >> (32 - bit_shift);
        }
        value
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ack(generation: u32, largest_seq: u32, recovered0: u32, grant: u32) -> DisplayAckPayload {
        DisplayAckPayload {
            generation,
            largest_seq,
            received: [1, 0, 0, 0],
            recovered: [recovered0, 0, 0, 0],
            grant,
        }
    }

    #[test]
    fn a_generation_goes_reliably_at_once_then_at_the_coarse_cadence() {
        let mut acks = ReliableAcks::default();
        assert!(acks.admit(0, &ack(1, 5, 0, 1), false));
        assert!(!acks.admit(100, &ack(1, 6, 0, 1), false));
        assert!(acks.admit(400, &ack(1, 7, 0, 1), false));
        // Nothing advanced: the cadence alone sends nothing.
        assert!(!acks.admit(900, &ack(1, 7, 0, 1), false));
        assert!(acks.admit(901, &ack(2, 1, 0, 1), false));
    }

    #[test]
    fn repair_evidence_bypasses_the_cadence_once() {
        let mut acks = ReliableAcks::default();
        assert!(acks.admit(0, &ack(1, 10, 0, 1), false));
        assert!(acks.admit(10, &ack(1, 11, 1, 1), false));
        // The same recovered sequence, re-anchored two higher, is not new.
        assert!(!acks.admit(20, &ack(1, 13, 1 << 2, 1), false));
        assert!(acks.admit(30, &ack(1, 13, (1 << 2) | 1, 1), false));
    }

    #[test]
    fn a_durable_grant_bypasses_the_cadence_and_a_lazy_one_does_not() {
        let mut acks = ReliableAcks::default();
        assert!(acks.admit(0, &ack(1, 10, 0, 2), false));
        assert!(!acks.admit(10, &ack(1, 10, 0, 3), false));
        assert!(acks.admit(20, &ack(1, 10, 0, 4), true));
        assert!(!acks.admit(30, &ack(1, 10, 0, 4), true));
    }
}
