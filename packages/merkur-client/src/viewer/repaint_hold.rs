//! Presentation-only hold across an incremental resume repair: the port of
//! `display-repaint-hold.ts` and the repair marker of
//! `display-repair-marker.ts`.
//!
//! Frame application and selective ACKs advance at once. The daemon's reliable
//! end marker names `(row, minimum_admitted_seq)` for every repaired row, and
//! the grid's exact per-row versions allow an early presentation. Otherwise the
//! first visual mutation bounds suppression to [`HOLD_FRAMES`] real host
//! frames, even before that marker arrives: unrelated output cannot satisfy
//! repair membership, but must not wait an RTT behind a lost marker or a
//! missing repair row.
//!
//! The visual bound counts delivered frames exactly as the presentation
//! coordinator does, including its rule that a frame whose time predates the
//! anchor is the frame this hold interrupted, not one it suppressed through.
//! Before any visual mutation there are no new pixels to suppress, even while
//! the data attachment is still dialing. Only snapshot-owned suppression has a
//! wall-clock backstop.

use merkur_codec::MAX_TERMINAL_ROWS;

use super::presentation::HOLD_FRAMES;
use super::{display_serial_is_newer, display_serial_reached};

/// The most rows one repair marker names, mirrored from
/// `DISPLAY_REPAIR_MAX_MEMBERS`: a repair covers at most half of the 256-row
/// protocol bound, or the daemon sends a snapshot instead.
const MAX_REPAIR_MEMBERS: usize = 128;
const MARKER_FIXED_BYTES: usize = 10;
const MARKER_MEMBER_BYTES: usize = 6;

/// `generation:u32 | repair_id:u32 | count:u16 | count * (row:u16 |
/// minimum_seq:u32)`: the daemon's `MSG_TYPE_DISPLAY_REPAIR_END`.
pub(super) struct RepairEnd {
    pub(super) generation: u32,
    pub(super) repair_id: u32,
    /// `(row, minimum admitted sequence)`, rows unique.
    pub(super) members: Vec<(u16, u32)>,
}

impl RepairEnd {
    /// Refuses the whole marker on any malformed member: a partial membership
    /// would let a partial repair show.
    pub(super) fn parse(body: &[u8]) -> Option<Self> {
        let fixed = body.get(..MARKER_FIXED_BYTES)?;
        let count = usize::from(u16::from_be_bytes([fixed[8], fixed[9]]));
        if count > MAX_REPAIR_MEMBERS
            || body.len() != MARKER_FIXED_BYTES + count * MARKER_MEMBER_BYTES
        {
            return None;
        }
        let mut members: Vec<(u16, u32)> = Vec::with_capacity(count);
        for member in body[MARKER_FIXED_BYTES..].chunks_exact(MARKER_MEMBER_BYTES) {
            let row = u16::from_be_bytes([member[0], member[1]]);
            let minimum_seq = u32::from_be_bytes([member[2], member[3], member[4], member[5]]);
            if usize::from(row) >= MAX_TERMINAL_ROWS
                || minimum_seq == 0
                || members.iter().any(|(prior, _)| *prior == row)
            {
                return None;
            }
            members.push((row, minimum_seq));
        }
        Some(Self {
            generation: u32::from_be_bytes([fixed[0], fixed[1], fixed[2], fixed[3]]),
            repair_id: u32::from_be_bytes([fixed[4], fixed[5], fixed[6], fixed[7]]),
            members,
        })
    }
}

/// The absolute liveness backstop for snapshot-owned suppression, scaled with
/// the link: twice the RTT and a flush allowance, within 32..=250 ms.
pub(super) fn snapshot_deadline_ms(srtt_ms: Option<f64>) -> f64 {
    const MIN_MS: f64 = 32.0;
    const MAX_MS: f64 = 250.0;
    const FLUSH_ALLOWANCE_MS: f64 = 24.0;
    let rtt = srtt_ms
        .filter(|rtt| rtt.is_finite() && *rtt > 0.0)
        .unwrap_or(60.0);
    (rtt * 2.0 + FLUSH_ALLOWANCE_MS).clamp(MIN_MS, MAX_MS)
}

struct Target {
    row: u16,
    minimum_seq: u32,
    seen: bool,
}

#[derive(Default)]
pub(super) struct RepaintHold {
    held: bool,
    hard_deadline_ms: Option<f64>,
    repair_id: u32,
    target_generation: u32,
    targets: Vec<Target>,
    remaining: usize,
    have_target: bool,
    awaiting_snapshot: bool,
    visual_anchored: bool,
    visual_frames: u32,
    /// When the visual bound was anchored, on the host's frame clock.
    visual_anchored_at_ms: f64,
    /// The newest generation this hold saw apply: a repair target a newer
    /// lineage already superseded is moot.
    observed_generation: u32,
    observed_any: bool,
}

impl RepaintHold {
    fn clear_target(&mut self) {
        self.targets.clear();
        self.remaining = 0;
        self.target_generation = 0;
        self.have_target = false;
    }

    fn clear_observed_generation(&mut self) {
        self.observed_generation = 0;
        self.observed_any = false;
    }

    fn clear_visual(&mut self) {
        self.visual_anchored = false;
        self.visual_frames = 0;
        self.visual_anchored_at_ms = 0.0;
    }

    pub(super) fn release(&mut self) -> bool {
        if !self.held {
            return false;
        }
        self.held = false;
        self.clear_target();
        self.clear_observed_generation();
        self.awaiting_snapshot = false;
        self.clear_visual();
        self.hard_deadline_ms = None;
        self.repair_id = 0;
        true
    }

    fn counting_frames(&self) -> bool {
        self.held && !self.awaiting_snapshot && self.visual_anchored
    }

    fn anchor_visual_release(&mut self, observed_at_ms: f64) {
        if self.visual_anchored {
            return;
        }
        self.visual_anchored = true;
        self.visual_frames = 0;
        self.visual_anchored_at_ms = observed_at_ms;
    }

    fn note_observed_generation(&mut self, generation: u32, seq: u32) {
        if seq == 0 {
            return;
        }
        if !self.observed_any {
            self.observed_generation = generation;
            self.observed_any = true;
        } else if display_serial_is_newer(generation, self.observed_generation) {
            self.observed_generation = generation;
        }
    }

    fn observe_satisfied_targets(&mut self, observed_at_ms: f64, row_version: impl Fn(u16) -> u32) {
        let mut satisfied = false;
        for target in self.targets.iter_mut().filter(|target| !target.seen) {
            let version = row_version(target.row);
            if version == 0 || !display_serial_reached(version, target.minimum_seq) {
                continue;
            }
            target.seen = true;
            self.remaining -= 1;
            satisfied = true;
        }
        // An advanced row version means a row transformation applied, so the
        // visual bound counts frames from here. Membership itself stays exact
        // and is decided by the row versions, never by timing.
        if satisfied {
            self.anchor_visual_release(observed_at_ms);
        }
    }

    /// An incremental repair of `repair_id` is coming: hold the paint.
    pub(super) fn arm(&mut self, repair_id: u32) {
        self.held = true;
        self.repair_id = repair_id;
        self.hard_deadline_ms = None;
        self.clear_target();
        self.clear_observed_generation();
        self.awaiting_snapshot = false;
        self.clear_visual();
    }

    /// Whether the paint is held for the repair `repair_id`.
    pub(super) fn awaits_repair(&self, repair_id: u32) -> bool {
        self.held && !self.awaiting_snapshot && repair_id == self.repair_id
    }

    /// The daemon's end marker; true when it releases the hold.
    pub(super) fn note_repair_end(
        &mut self,
        marker: &RepairEnd,
        observed_at_ms: f64,
        row_version: impl Fn(u16) -> u32,
    ) -> bool {
        if !self.awaits_repair(marker.repair_id) {
            return false;
        }
        self.clear_target();
        self.target_generation = marker.generation;
        self.targets
            .extend(marker.members.iter().map(|&(row, minimum_seq)| Target {
                row,
                minimum_seq,
                seen: false,
            }));
        self.remaining = self.targets.len();
        self.have_target = true;
        if self.observed_any
            && display_serial_is_newer(self.observed_generation, self.target_generation)
        {
            return self.release();
        }
        self.observe_satisfied_targets(observed_at_ms, row_version);
        self.remaining == 0 && self.release()
    }

    /// Hold the paint until a snapshot replaces it, or `deadline_ms`.
    pub(super) fn await_snapshot(&mut self, deadline_ms: f64) {
        match self.hard_deadline_ms {
            Some(held) if self.held => self.hard_deadline_ms = Some(held.min(deadline_ms)),
            _ => {
                self.held = true;
                self.hard_deadline_ms = Some(deadline_ms);
            }
        }
        self.clear_target();
        self.clear_observed_generation();
        self.awaiting_snapshot = true;
        self.repair_id = 0;
        self.clear_visual();
    }

    /// A frame at `(generation, seq)` applied; true when it releases the hold.
    pub(super) fn note_applied(
        &mut self,
        generation: u32,
        seq: u32,
        visual: bool,
        observed_at_ms: f64,
        row_version: impl Fn(u16) -> u32,
    ) -> bool {
        if !self.held {
            return false;
        }
        self.note_observed_generation(generation, seq);
        if self.have_target && generation != self.target_generation {
            return display_serial_is_newer(generation, self.target_generation) && self.release();
        }
        // The hold suppresses every authoritative pixel, not only repair
        // members: waiting for reliable membership before anchoring would
        // make datagram output pay the hard recovery timeout under CTRL loss.
        if visual && !self.awaiting_snapshot {
            self.anchor_visual_release(observed_at_ms);
        }
        if !self.have_target {
            return false;
        }
        self.observe_satisfied_targets(observed_at_ms, row_version);
        self.remaining == 0 && self.release()
    }

    /// One real host frame against the anchored visual bound, on the clock of
    /// `observed_at_ms`; true when it releases the hold.
    pub(super) fn note_frame(&mut self, frame_ms: f64) -> bool {
        // The frame this hold interrupted: its time preceded the anchoring
        // mutation, so it suppressed nothing and cannot spend the budget.
        if !self.counting_frames() || frame_ms < self.visual_anchored_at_ms {
            return false;
        }
        self.visual_frames += 1;
        self.visual_frames >= HOLD_FRAMES && self.release()
    }

    /// Release once a snapshot wait's wall-clock backstop elapsed.
    pub(super) fn expire(&mut self, now_ms: f64) -> bool {
        self.held
            && self
                .hard_deadline_ms
                .is_some_and(|deadline| now_ms >= deadline)
            && self.release()
    }

    pub(super) fn is_held(&self) -> bool {
        self.held
    }

    /// The paint is held until a snapshot replaces it.
    pub(super) fn awaits_snapshot(&self) -> bool {
        self.held && self.awaiting_snapshot
    }

    /// An anchored visual bound is still counting frames down.
    pub(super) fn awaiting_frames(&self) -> bool {
        self.counting_frames()
    }

    /// Incremental holds are bounded by delivered frames; only a snapshot
    /// wait has a deadline.
    pub(super) fn deadline_ms(&self) -> Option<f64> {
        self.hard_deadline_ms.filter(|_| self.held)
    }
}

#[cfg(test)]
mod tests;
