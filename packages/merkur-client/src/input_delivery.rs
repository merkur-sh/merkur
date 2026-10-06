//! Input admission and delivery facts shared by native and browser hosts.
//! A deferred report keeps its sequence and leaves with the next useful input
//! or an authenticated mode's rising edge; it never owns a retry timer.

// A latency path: input waits on the event itself, never on a clock. `clippy.toml` lists the
// timer calls this denies.
#![cfg_attr(not(test), deny(clippy::disallowed_methods))]

use merkur_wire::input_record::{InputRecord, KeyEvent, decode};
use std::collections::VecDeque;

pub const MAX_INPUT_BYTES: usize = 256 * 1024;
pub const MAX_INPUT_ENTRIES: usize = 4_096;
pub const PASTE_CHUNK: usize = 8 * 1024;
pub const KEY_RELEASES: u32 = 1 << 6;
pub const MODIFIER_KEYS: u32 = 1 << 7;
pub const FOCUS: u32 = 1 << 8;
pub const REPORTS: u32 = KEY_RELEASES | MODIFIER_KEYS | FOCUS;

/// Zero names input every application receives. Nonzero names the exact
/// terminal modes under which the daemon's encoder gives the report bytes.
pub fn reported_when(record: &[u8]) -> u32 {
    match decode(record) {
        Some(InputRecord::Key(key)) => {
            // Kitty's lock keys and left/right modifiers, through ISO level 5.
            let modifier =
                (0xE061..=0xE06E).contains(&key.key) || (0xE00E..=0xE010).contains(&key.key);
            (if modifier { MODIFIER_KEYS } else { 0 })
                | (if key.event == KeyEvent::Release {
                    KEY_RELEASES
                } else {
                    0
                })
        }
        Some(InputRecord::Focus(_)) => FOCUS,
        _ => 0,
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AdmissionError {
    Full,
    SequenceExhausted,
}

/// Charges every record from capture until the daemon acknowledged it,
/// including reports still held by the host or queued to its transport.
#[derive(Default)]
pub struct Budget {
    entries: VecDeque<(u32, usize)>,
    bytes: usize,
    sequence: u32,
}
impl Budget {
    pub fn admit(&mut self, length: usize) -> Result<u32, AdmissionError> {
        if length == 0
            || self.entries.len() >= MAX_INPUT_ENTRIES
            || length > MAX_INPUT_BYTES.saturating_sub(self.bytes)
        {
            return Err(AdmissionError::Full);
        }
        let sequence = self
            .sequence
            .checked_add(1)
            .ok_or(AdmissionError::SequenceExhausted)?;
        self.sequence = sequence;
        self.bytes += length;
        self.entries.push_back((sequence, length));
        Ok(sequence)
    }
    pub fn acknowledged(&mut self, sequence: u32) {
        while self
            .entries
            .front()
            .is_some_and(|(seq, _)| *seq <= sequence)
        {
            if let Some((_, bytes)) = self.entries.pop_front() {
                self.bytes -= bytes;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use merkur_wire::input_record::build;
    #[test]
    fn delivery_requires_exact_release_modifier_and_focus_modes() {
        assert_eq!(reported_when(&build::press('a')), 0);
        assert_eq!(
            reported_when(&build::functional(0xE00E, 0, 0)),
            MODIFIER_KEYS
        );
        assert_eq!(
            reported_when(&build::functional(0xE061, 2, 0)),
            MODIFIER_KEYS | KEY_RELEASES
        );
        assert_eq!(
            reported_when(&build::functional(0xE007, 2, 0)),
            KEY_RELEASES
        );
        assert_eq!(reported_when(&build::focus(true)), FOCUS);
    }
    #[test]
    fn byte_and_entry_budgets_cover_the_whole_unacknowledged_backlog() {
        let mut budget = Budget::default();
        let first = budget.admit(MAX_INPUT_BYTES).unwrap();
        assert_eq!(budget.admit(1), Err(AdmissionError::Full));
        budget.acknowledged(first);
        for _ in 0..MAX_INPUT_ENTRIES {
            budget.admit(1).unwrap();
        }
        assert_eq!(budget.admit(1), Err(AdmissionError::Full));
        budget.acknowledged(1); // Old ACK cannot free newer records.
        assert_eq!(budget.admit(1), Err(AdmissionError::Full));
        budget.acknowledged(2);
        assert!(budget.admit(1).is_ok());
    }
    #[test]
    fn a_sequence_never_wraps_or_reserves_bytes_on_failure() {
        let mut budget = Budget {
            sequence: u32::MAX,
            ..Budget::default()
        };
        assert_eq!(budget.admit(1), Err(AdmissionError::SequenceExhausted));
        assert_eq!(budget.bytes, 0);
        assert!(budget.entries.is_empty());
    }
}
