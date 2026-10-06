//! Where the daemon's input-routing word stands against the display frames.
//! The port of `input-routing-hold.ts`.
//!
//! The word crosses the control lane while a synchronized update is paused and
//! no display header can leave, and nothing orders that lane against the
//! frames: a frame sent before the word can land after it (FEC rebuilt, a
//! stream retransmission, the other carrier), and a word can land after the
//! header that commits the update. So the word names its display position:
//! read after every frame of `generation` up to sequence `after_seq`, before
//! every later one. While a word is held the terminal keeps its routing bits
//! across the headers of earlier frames, and the first frame past the position
//! releases it to that frame's header. A word a later header already applied
//! past is dropped, and `serial` orders two words sent at one position, which
//! can cross on different carriers.

use super::display_serial_is_newer;

#[derive(Default)]
pub struct InputRoutingHold {
    held: bool,
    generation: u32,
    after_seq: u32,
    serial: u32,
    /// The applied position orders against the daemon's: a frame applied
    /// since the last fence or re-rooting.
    applied_ordered: bool,
}

/// Whether display position `(generation, seq)` comes after
/// `(anchor_generation, anchor_seq)`. A snapshot rides sequence zero, so it
/// follows only from a newer generation.
fn position_follows(generation: u32, seq: u32, anchor_generation: u32, anchor_seq: u32) -> bool {
    display_serial_is_newer(generation, anchor_generation)
        || (generation == anchor_generation && display_serial_is_newer(seq, anchor_seq))
}

impl InputRoutingHold {
    /// Whether a word takes the terminal's routing bits now, given the newest
    /// display position the terminal applied.
    pub fn admit(
        &mut self,
        generation: u32,
        after_seq: u32,
        serial: u32,
        applied_generation: u32,
        applied_seq: u32,
    ) -> bool {
        if self.held {
            // Serials and positions advance together, so a newer word is never
            // behind the applied position either.
            if !display_serial_is_newer(serial, self.serial) {
                return false;
            }
        } else if self.applied_ordered
            && position_follows(applied_generation, applied_seq, generation, after_seq)
        {
            return false;
        }
        self.held = true;
        self.generation = generation;
        self.after_seq = after_seq;
        self.serial = serial;
        true
    }

    /// A frame at `(generation, seq)` applied; true when it releases the word.
    pub fn note_applied(&mut self, generation: u32, seq: u32) -> bool {
        self.applied_ordered = true;
        if !self.held || !position_follows(generation, seq, self.generation, self.after_seq) {
            return false;
        }
        self.held = false;
        true
    }

    /// An authenticated session boundary. The next session may be another
    /// daemon process, whose generations do not order against this one's: a
    /// held word yields to the first frame that applies, any word the new
    /// session sends is taken, and the applied position orders again once one
    /// of its frames applied.
    pub fn fence(&mut self) {
        self.applied_ordered = false;
        // Every frame follows generation zero, and every serial succeeds zero.
        self.generation = 0;
        self.serial = 0;
    }

    /// The applied generation stopped ordering against the daemon's, which a
    /// stale-generation recovery re-roots. A held word came from that daemon,
    /// so its own position still orders.
    pub fn unroot(&mut self) {
        self.applied_ordered = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_word_outlasts_the_frames_of_its_own_generation_up_to_its_sequence_and_no_further() {
        let mut hold = InputRoutingHold::default();
        assert!(!hold.note_applied(4, 10));
        assert!(hold.admit(4, 12, 1, 4, 10));
        // The generation's snapshot, an older generation, and every frame up
        // to sequence 12 were sent before the word.
        assert!(!hold.note_applied(4, 0));
        assert!(!hold.note_applied(3, 99));
        assert!(!hold.note_applied(4, 12));
        assert!(hold.note_applied(4, 13));
        // Released: nothing is held for a later frame to release.
        assert!(!hold.note_applied(4, 14));
    }

    #[test]
    fn a_word_from_a_generation_the_terminal_has_not_reached_outlasts_the_old_one() {
        let mut hold = InputRoutingHold::default();
        hold.note_applied(4, 10);
        // A withdrawn dictionary opened generation 5 before any of its frames
        // left, and the paused drain read the word in it.
        assert!(hold.admit(5, 0, 1, 4, 10));
        assert!(!hold.note_applied(4, 11));
        // Generation 5 never sends a frame: its snapshot opens generation 6.
        assert!(hold.note_applied(6, 0));
    }

    #[test]
    fn a_word_an_applied_header_was_captured_after_is_dropped() {
        let mut hold = InputRoutingHold::default();
        hold.note_applied(4, 13);
        assert!(!hold.admit(4, 12, 1, 4, 13));
        assert!(!hold.admit(3, 99, 2, 4, 13));
        // Nothing was taken, so nothing is released.
        assert!(!hold.note_applied(4, 14));
    }

    #[test]
    fn a_stale_generation_recovery_keeps_the_held_position_but_not_the_applied_one() {
        let mut hold = InputRoutingHold::default();
        // The applied generation is poisoned above the daemon's.
        hold.note_applied(9, 3);
        assert!(!hold.admit(4, 1, 1, 9, 3));
        hold.unroot();
        assert!(hold.admit(4, 1, 1, 9, 3));
        // The word came from that daemon, so its position still orders its
        // frames.
        assert!(!hold.note_applied(4, 1));
        assert!(hold.note_applied(4, 2));
    }

    #[test]
    fn serials_order_the_words_while_one_is_held_across_the_u32_wrap() {
        let mut hold = InputRoutingHold::default();
        assert!(hold.admit(1, 0, 0xffff_ffff, 0, 0));
        assert!(!hold.admit(1, 0, 0xffff_fffe, 0, 0));
        assert!(!hold.admit(1, 0, 0xffff_ffff, 0, 0));
        // The daemon's serial skips zero on the wrap.
        assert!(hold.admit(1, 0, 1, 0, 0));
    }
}
