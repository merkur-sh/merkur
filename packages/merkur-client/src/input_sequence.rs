//! The two numberings of one input record, and the map between them: the port
//! of `input-sequence-domain.ts`.
//!
//! The host numbers every record it sends from one monotonic counter, the
//! local sequence that prediction and display coverage speak. The daemon
//! numbers the same records per peer, the wire sequence its dedup and display
//! headers speak, and a fresh peer starts that count again. The session keeps
//! the affine map from wire to local over exactly the wire interval it has
//! assigned, so a stale or unrelated wire value is never turned into a local
//! one.

// A latency path: input waits on the event itself, never on a clock. `clippy.toml` lists the
// timer calls this denies.
#![cfg_attr(not(test), deny(clippy::disallowed_methods))]

/// How one wire interval maps onto local sequences.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct InputMapping {
    /// Rotates whenever the same wire numbers may come to name other inputs.
    pub epoch: u32,
    /// `local - wire`, modular, so the whole `u32` range is representable.
    pub local_minus_wire: u32,
    /// The proven wire interval, inclusive; a zero `wire_min` maps nothing.
    pub wire_min: u32,
    pub wire_max: u32,
}

impl InputMapping {
    pub fn local_for_wire(&self, wire: u32) -> Option<u32> {
        if wire == 0 || self.wire_min == 0 || wire < self.wire_min || wire > self.wire_max {
            return None;
        }
        let local = wire.wrapping_add(self.local_minus_wire);
        (local != 0).then_some(local)
    }

    /// A display header's input sequence as a local one. Zero is the header's
    /// "no input applied", and a wire value outside the interval reads as it.
    pub fn normalize_display(&self, wire: u32) -> u32 {
        self.local_for_wire(wire).unwrap_or(0)
    }
}

pub(crate) fn input_sequence_delta(local: u32, wire: u32) -> u32 {
    local.wrapping_sub(wire)
}

/// Whether `candidate` advances a high-water in serial order. Zero is the
/// protocol's "no input", so an empty high-water takes anything nonzero,
/// which is what lets the first sequence sit anywhere, `u32::MAX` included.
pub fn input_seq_advances(current: u32, candidate: u32) -> bool {
    if candidate == 0 {
        return false;
    }
    if current == 0 {
        return true;
    }
    let distance = candidate.wrapping_sub(current);
    distance != 0 && distance < 0x8000_0000
}

pub fn advance_input_seq(current: u32, candidate: u32) -> u32 {
    if input_seq_advances(current, candidate) {
        candidate
    } else {
        current
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EpochDecision {
    Current,
    Advance,
    Stale,
}

/// Mapping epochs in serial order; zero is "none yet".
pub fn classify_epoch(current: u32, incoming: u32) -> EpochDecision {
    if incoming == current {
        EpochDecision::Current
    } else if current == 0 {
        EpochDecision::Advance
    } else if incoming == 0 || incoming.wrapping_sub(current) >= 0x8000_0000 {
        EpochDecision::Stale
    } else {
        EpochDecision::Advance
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn translation_is_bounded_to_the_proven_wire_interval() {
        let mapping = InputMapping {
            epoch: 3,
            local_minus_wire: 100 - 1,
            wire_min: 1,
            wire_max: 2,
        };
        assert_eq!(mapping.local_for_wire(1), Some(100));
        assert_eq!(mapping.local_for_wire(2), Some(101));
        assert_eq!(mapping.local_for_wire(0), None);
        assert_eq!(mapping.local_for_wire(3), None);
        assert_eq!(mapping.normalize_display(1), 100);
        assert_eq!(mapping.normalize_display(3), 0);
        assert_eq!(mapping.normalize_display(0), 0);
    }

    #[test]
    fn stale_epochs_are_refused_across_the_u32_wrap() {
        assert_eq!(classify_epoch(0, 7), EpochDecision::Advance);
        assert_eq!(classify_epoch(7, 7), EpochDecision::Current);
        assert_eq!(classify_epoch(8, 7), EpochDecision::Stale);
        assert_eq!(classify_epoch(u32::MAX, 1), EpochDecision::Advance);
        assert_eq!(classify_epoch(1, u32::MAX), EpochDecision::Stale);
    }

    #[test]
    fn a_high_water_advances_in_serial_order_across_the_u32_wrap() {
        assert!(!input_seq_advances(0, 0));
        assert!(input_seq_advances(0, 0xffff_fffe));
        assert_eq!(advance_input_seq(0, 0xffff_fffe), 0xffff_fffe);
        assert_eq!(advance_input_seq(0xffff_fffe, u32::MAX), u32::MAX);
        assert_eq!(advance_input_seq(u32::MAX, 1), 1);
        assert_eq!(advance_input_seq(1, u32::MAX), 1);
        assert!(!input_seq_advances(7, 7));
    }
}
