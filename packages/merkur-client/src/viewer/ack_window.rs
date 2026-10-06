//! Which display sequences the viewer has applied, in the exact shape the
//! display ACK puts on the wire. The port of `display-ack-window.ts`.
//!
//! A cumulative "highest applied" cannot describe a hole: with 10-12 lost and
//! 13-36 applied it told the daemon 10-12 arrived, the acknowledged baseline
//! held rows the viewer never saw, and re-selection found nothing to re-send.
//! The window is anchored at the NEWEST applied sequence and counts down, so it
//! never wedges at a permanent loss, and every ACK is self-contained: losing
//! one costs nothing, because the next one restates the same window.
//! Sequences are wrapping `u32`s, compared as the daemon compares them.

use merkur_wire::protocol::{DISPLAY_ACK_MASK_WINDOW, DISPLAY_ACK_MASK_WORDS, DisplayAckPayload};

#[derive(Clone, Debug, Default)]
pub struct AckWindow {
    received: [u32; DISPLAY_ACK_MASK_WORDS],
    recovered: [u32; DISPLAY_ACK_MASK_WORDS],
    largest: u32,
    applied: bool,
}

/// Whether `candidate` is newer than `reference` in wrapping serial order.
pub(crate) fn serial_is_newer(candidate: u32, reference: u32) -> bool {
    candidate != reference && candidate.wrapping_sub(reference) < 0x8000_0000
}

impl AckWindow {
    /// Record an applied sequence, and whether display FEC reconstructed it.
    pub fn note(&mut self, seq: u32, recovered: bool) {
        if seq == 0 {
            return;
        }
        if !self.applied {
            self.applied = true;
            self.largest = seq;
            self.received = [0; DISPLAY_ACK_MASK_WORDS];
            self.recovered = [0; DISPLAY_ACK_MASK_WORDS];
            self.received[0] = 1;
            self.recovered[0] = u32::from(recovered);
            return;
        }
        if seq == self.largest {
            self.recovered[0] |= u32::from(recovered);
            return;
        }
        if serial_is_newer(seq, self.largest) {
            let distance = seq.wrapping_sub(self.largest);
            shift_up(&mut self.received, distance);
            shift_up(&mut self.recovered, distance);
            self.largest = seq;
            self.received[0] |= 1;
            self.recovered[0] |= u32::from(recovered);
            return;
        }
        let offset = self.largest.wrapping_sub(seq);
        if offset >= DISPLAY_ACK_MASK_WINDOW {
            return;
        }
        let (word, bit) = ((offset >> 5) as usize, 1u32 << (offset & 31));
        self.received[word] |= bit;
        if recovered {
            self.recovered[word] |= bit;
        }
    }

    /// Highest applied sequence, or 0 when nothing has applied.
    pub fn largest(&self) -> u32 {
        self.largest
    }

    /// Bit `n` of word `w` reports `largest - (w * 32 + n)`.
    pub fn received(&self) -> [u32; DISPLAY_ACK_MASK_WORDS] {
        self.received
    }

    pub fn recovered(&self) -> [u32; DISPLAY_ACK_MASK_WORDS] {
        self.recovered
    }

    pub fn has_applied(&self) -> bool {
        self.applied
    }

    pub fn reset(&mut self) {
        *self = Self::default();
    }

    /// The acknowledgement for `generation` carrying `grant`.
    pub fn payload(&self, generation: u32, grant: u32) -> DisplayAckPayload {
        DisplayAckPayload {
            generation,
            largest_seq: self.largest,
            received: self.received,
            recovered: self.recovered,
            grant,
        }
    }
}

/// Every recorded bit is an offset below the anchor, so moving the anchor
/// forward by `distance` moves every bit back by the same amount.
fn shift_up(words: &mut [u32; DISPLAY_ACK_MASK_WORDS], distance: u32) {
    if distance >= DISPLAY_ACK_MASK_WINDOW {
        *words = [0; DISPLAY_ACK_MASK_WORDS];
        return;
    }
    let word_shift = (distance >> 5) as usize;
    let bit_shift = distance & 31;
    for target in (0..DISPLAY_ACK_MASK_WORDS).rev() {
        let Some(source) = target.checked_sub(word_shift) else {
            words[target] = 0;
            continue;
        };
        let mut value = words[source] << bit_shift;
        if bit_shift > 0 && source > 0 {
            value |= words[source - 1] >> (32 - bit_shift);
        }
        words[target] = value;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Sequences a mask reports as applied, newest first.
    fn seqs(window: &AckWindow, words: [u32; DISPLAY_ACK_MASK_WORDS]) -> Vec<u32> {
        (0..DISPLAY_ACK_MASK_WINDOW)
            .filter(|offset| words[(offset >> 5) as usize] & (1 << (offset & 31)) != 0)
            .map(|offset| window.largest().wrapping_sub(offset))
            .collect()
    }

    fn noted(pairs: &[(u32, bool)]) -> AckWindow {
        let mut window = AckWindow::default();
        for &(seq, recovered) in pairs {
            window.note(seq, recovered);
        }
        window
    }

    #[test]
    fn a_hole_is_reported_as_a_hole_not_swallowed_by_the_newest() {
        let window = noted(&[(7, false), (8, false), (9, false), (13, false)]);
        assert_eq!(window.largest(), 13);
        assert_eq!(seqs(&window, window.received()), [13, 9, 8, 7]);
    }

    #[test]
    fn the_anchor_tracks_the_newest_and_drags_the_window() {
        let window = noted(&[(1, false), (2, false), (1 + DISPLAY_ACK_MASK_WINDOW, false)]);
        assert_eq!(window.largest(), 1 + DISPLAY_ACK_MASK_WINDOW);
        assert_eq!(
            seqs(&window, window.received()),
            [1 + DISPLAY_ACK_MASK_WINDOW, 2]
        );
    }

    #[test]
    fn a_sequence_far_below_the_window_is_dropped() {
        let window = noted(&[(1000, false), (1, false)]);
        assert_eq!(seqs(&window, window.received()), [1000]);
    }

    #[test]
    fn out_of_order_and_duplicate_arrivals_converge() {
        let forward = noted(&[(4, false), (5, false), (6, false), (7, false)]);
        let shuffled = noted(&[
            (7, false),
            (4, false),
            (6, false),
            (5, false),
            (6, false),
            (7, false),
        ]);
        assert_eq!(shuffled.largest(), forward.largest());
        assert_eq!(shuffled.received(), forward.received());
    }

    #[test]
    fn wrap_is_forward_motion_not_a_four_billion_jump() {
        let window = noted(&[(0xffff_fffe, true), (0xffff_ffff, false), (1, true)]);
        assert_eq!(window.largest(), 1);
        assert_eq!(
            seqs(&window, window.received()),
            [1, 0xffff_ffff, 0xffff_fffe]
        );
        assert_eq!(seqs(&window, window.recovered()), [1, 0xffff_fffe]);
    }

    #[test]
    fn recovered_sequences_shift_with_the_window_and_stay_a_subset() {
        let window = noted(&[(31, true), (32, false), (64, true), (60, true)]);
        assert_eq!(seqs(&window, window.received()), [64, 60, 32, 31]);
        assert_eq!(seqs(&window, window.recovered()), [64, 60, 31]);
        for (recovered, received) in window.recovered().iter().zip(window.received()) {
            assert_eq!(recovered & !received, 0);
        }
    }

    #[test]
    fn a_duplicate_recovered_application_upgrades_the_bit() {
        let window = noted(&[(9, false), (9, true)]);
        assert_eq!(seqs(&window, window.recovered()), [9]);
    }

    #[test]
    fn nothing_is_claimed_before_the_first_applied_frame() {
        let mut window = AckWindow::default();
        window.note(0, false);
        assert!(!window.has_applied());
        window.note(5, true);
        assert!(window.has_applied());
        let payload = window.payload(3, 2);
        assert_eq!(
            (payload.generation, payload.largest_seq, payload.grant),
            (3, 5, 2)
        );
        window.reset();
        assert!(!window.has_applied());
        assert_eq!(window.largest(), 0);
        assert_eq!(window.received(), [0; DISPLAY_ACK_MASK_WORDS]);
    }
}
