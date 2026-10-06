//! Speculative local echo: the terminal worker's prediction rules over
//! term-wasm's shadow model (`prediction-gate.ts`, `prediction-input-barrier.ts`
//! and the worker's command, reconciliation and gate handlers) and the input
//! controller's `predictionPredictionCommand`.
//!
//! A security boundary before it is a latency feature: read `docs/security.md`
//! (Speculative Echo And The Prompt Boundary). The host asks before it sends
//! each record, and the answer is the record's modelled bit, which the daemon
//! reads as a capability. Only a key the model can produce claims it (a
//! printable under at most Shift, or Backspace, Delete, Left or Right alone,
//! the set the daemon's `record_is_modelled` honours), and only while the mode
//! word carries the daemon's authenticated prompt grant.
//!
//! Every refusal is an exact predicate over runtime state. An input the model
//! does not project seals the line and opens a causal barrier that only
//! authoritative display covering it closes. Glyphs are withdrawn on an exact
//! contradiction or past their lifetime, and become visible only after
//! counted confirmations.

use merkur_wire::input_record::{InputRecord, KeyEvent, KeyRecord, KeyText, decode, keys, mods};

use super::receive::DisplayGrid;
use crate::input_sequence::{advance_input_seq, input_seq_advances};

/// How long a glyph authority never answered may stay: a resource bound, not a
/// verdict. Mirrored from `predictionTtlMs` and `altScreenPredictionTtlMs`.
const TTL_MS: f64 = 500.0;
const ALT_SCREEN_TTL_MS: f64 = 200.0;
/// The trust window, mirrored from the worker's default tuning.
const RECENT_WINDOW: usize = 20;
const MIN_VISIBLE_RATIO: f64 = 0.9;
const MIN_CONSECUTIVE_CONFIRMED: u32 = 3;
/// How long a contradiction that may be half an echo waits for the rest. The
/// terminal's own reconcile reads this same window.
pub const MISMATCH_GRACE_MS: f64 = 18.0;

/// What a key press may do to the model.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PredictionCommand {
    Printable(u32),
    Backspace,
    Delete,
    CursorShift(i32),
    /// The line ends here: history, completion and Enter stay authority-only.
    Flush,
}

/// `predictionPredictionCommand`, read from the record's own fields: what the daemon
/// checks a modelled claim against.
fn intent(key: &KeyRecord<'_>, granted: bool) -> PredictionCommand {
    if !granted {
        return PredictionCommand::Flush;
    }
    // Lock state changes neither editing keys nor what a printable typed.
    let chord = key.mods & !mods::LOCKS;
    if chord == 0 {
        match key.key {
            keys::BACKSPACE => return PredictionCommand::Backspace,
            keys::DELETE => return PredictionCommand::Delete,
            keys::LEFT => return PredictionCommand::CursorShift(-1),
            keys::RIGHT => return PredictionCommand::CursorShift(1),
            _ => {}
        }
    }
    if chord & !mods::SHIFT == 0
        && let Some(codepoint) = text_code_point(key)
        && predictable_width_one(codepoint)
    {
        return PredictionCommand::Printable(codepoint);
    }
    PredictionCommand::Flush
}

/// The one code point a key typed, if it typed exactly one.
fn text_code_point(key: &KeyRecord<'_>) -> Option<u32> {
    match key.text {
        KeyText::Implied(c) => Some(u32::from(c)),
        KeyText::Explicit(text) => {
            let mut chars = text.chars();
            match (chars.next(), chars.next()) {
                (Some(c), None) => Some(u32::from(c)),
                _ => None,
            }
        }
        KeyText::None => None,
    }
}

/// A code point that advances the cursor by exactly one cell, space included,
/// by the width table the grid itself uses. The model and the terminal that
/// draws the prediction ask this one question, so they cannot disagree.
pub fn predictable_width_one(codepoint: u32) -> bool {
    char::from_u32(codepoint)
        .is_some_and(|ch| !ch.is_control() && unicode_width::UnicodeWidthChar::width(ch) == Some(1))
}

/// Whether applied display already represents local input `input_seq`.
fn covered(input_seq: u32, high_water: u32) -> bool {
    input_seq != 0
        && high_water != 0
        && (input_seq == high_water || input_seq_advances(input_seq, high_water))
}

/// The causal fence between input the model did not project and the next
/// prediction, which would otherwise start from a stale cursor: the port of
/// `prediction-input-barrier.ts`.
#[derive(Default)]
struct InputBarrier {
    high_water: u32,
}

impl InputBarrier {
    fn open_through(&mut self, input_seq: u32) {
        if input_seq != 0 {
            self.high_water = advance_input_seq(self.high_water, input_seq);
        }
    }

    /// True while prediction is refused; a refused newer input extends the
    /// fence, so prediction never restarts inside an unmodelled run.
    fn reject_if_open(&mut self, input_seq: u32) -> bool {
        if self.high_water == 0 {
            return false;
        }
        self.open_through(input_seq);
        true
    }

    /// Closes once authority covers every input the fence holds.
    fn observe_authoritative(&mut self, input_seq: u32) {
        if self.high_water != 0
            && input_seq != 0
            && (input_seq == self.high_water || input_seq_advances(self.high_water, input_seq))
        {
            self.high_water = 0;
        }
    }

    fn is_open(&self) -> bool {
        self.high_water != 0
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum PredictionState {
    /// Predictions are modelled and kept hidden until trusted.
    #[default]
    Learning,
    Visible,
    /// The mode word withholds the grant.
    Suppressed,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PredictionStats {
    pub state: PredictionState,
    /// Records the model took: the daemon reads them as modelled.
    pub modelled: u64,
    pub confirmed: u64,
    pub mismatched: u64,
    /// Retired past their lifetime with authority covering them.
    pub expired_covered: u64,
    /// Retired past their lifetime that authority never reached.
    pub expired_stalled: u64,
}

/// The worker's prediction state beside the viewer's grid.
#[derive(Default)]
pub(super) struct Prediction {
    /// Exact authenticated authority/retirement edge for unsent host previews.
    authority_revision: u32,
    barrier: InputBarrier,
    /// The newest input the model took.
    latest: u32,
    /// The newest local input applied display covers.
    authoritative_input: u32,
    /// The newest local input whose answer applied display could show.
    echo_horizon: u32,
    /// The newest input covered by display applied since the last
    /// reconciliation, when any applied.
    batch: Option<u32>,
    outcomes: [bool; RECENT_WINDOW],
    outcome_index: usize,
    outcome_count: usize,
    outcome_positive: usize,
    consecutive: u32,
    /// The grant and the alternate screen as the mode word last stated them;
    /// `None` before the first header.
    mode: Option<(bool, bool)>,
    grace_at_ms: Option<f64>,
    stats: PredictionStats,
}

impl Prediction {
    pub(super) fn authority_revision(&self) -> u32 {
        self.authority_revision
    }

    fn retire_preview_authority(&mut self) {
        self.authority_revision = self.authority_revision.wrapping_add(1);
    }

    pub(super) fn armed<G: DisplayGrid>(&self, grid: &G, epoch_reset: bool) -> bool {
        !epoch_reset && !self.barrier.is_open() && grid.prediction_granted()
    }

    pub(super) fn authoritative_input(&self) -> u32 {
        self.authoritative_input
    }

    pub(super) fn stats(&self) -> PredictionStats {
        self.stats
    }

    pub(super) fn next_deadline(&self) -> Option<f64> {
        self.grace_at_ms
    }

    /// One record the host is about to send as local input `input_seq`;
    /// true when the model took it, which is its modelled bit.
    pub(super) fn input<G: DisplayGrid>(
        &mut self,
        grid: &mut G,
        epoch_reset: bool,
        now_ms: f64,
        input_seq: u32,
        record: &[u8],
    ) -> bool {
        match decode(record) {
            Some(InputRecord::Key(key)) if key.event != KeyEvent::Release => {
                match intent(&key, grid.prediction_granted()) {
                    PredictionCommand::Flush => {
                        self.flush(grid, input_seq);
                        false
                    }
                    op => self.command(
                        grid,
                        epoch_reset,
                        now_ms,
                        input_seq,
                        (op, self.stats.state == PredictionState::Visible),
                    ),
                }
            }
            // Committed text ends the line as a composition does, and names
            // the input its answer follows.
            Some(InputRecord::Text(_)) => {
                self.flush(grid, 0);
                self.flush(grid, input_seq);
                false
            }
            Some(InputRecord::Paste(_)) => {
                self.flush(grid, 0);
                false
            }
            // Releases, pointer and focus reports are never modelled.
            _ => false,
        }
    }

    /// An input the model does not project ends the line. It is sealed, not
    /// dropped: every painted glyph still waits for its echo. Until authority
    /// covers the sealing input, nothing new is modelled from the line.
    fn flush<G: DisplayGrid>(&mut self, grid: &mut G, input_seq: u32) {
        if input_seq != 0 && !covered(input_seq, self.authoritative_input) {
            self.barrier.open_through(input_seq);
        }
        grid.predict_seal(input_seq);
    }

    /// Execute the command captured by a browser input owner. Visibility is
    /// latched at capture; authority may still revoke the modelled claim.
    pub(super) fn command<G: DisplayGrid>(
        &mut self,
        grid: &mut G,
        epoch_reset: bool,
        now_ms: f64,
        input_seq: u32,
        captured: (PredictionCommand, bool),
    ) -> bool {
        let (op, visible) = captured;
        if op == PredictionCommand::Flush {
            self.flush(grid, input_seq);
            return false;
        }
        if covered(input_seq, self.authoritative_input) {
            return false;
        }
        // No model on a lineage awaiting its snapshot, nor behind unmodelled
        // input authority has not covered.
        if epoch_reset {
            self.barrier.open_through(input_seq);
            return false;
        }
        if self.barrier.reject_if_open(input_seq) {
            return false;
        }
        let allowed = grid.prediction_granted()
            && match op {
                PredictionCommand::Printable(codepoint) => predictable_width_one(codepoint),
                PredictionCommand::CursorShift(delta) => delta == -1 || delta == 1,
                _ => true,
            };
        if !allowed {
            self.barrier.open_through(input_seq);
            return false;
        }
        let accepted = match op {
            PredictionCommand::Printable(codepoint) => {
                grid.predict_printable(codepoint, now_ms, input_seq, visible)
            }
            PredictionCommand::Backspace => grid.predict_backspace(now_ms, input_seq),
            PredictionCommand::Delete => grid.predict_delete(now_ms, input_seq),
            PredictionCommand::CursorShift(delta) => {
                grid.predict_cursor_shift(delta, now_ms, input_seq)
            }
            PredictionCommand::Flush => false,
        };
        if !accepted {
            // A refusal is itself an unmodelled input: the next key would
            // otherwise seed from the cursor before it.
            self.barrier.open_through(input_seq);
            return false;
        }
        self.latest = advance_input_seq(self.latest, input_seq);
        self.stats.modelled += 1;
        true
    }

    /// A frame applied, covering local input through `input_seq` and able to
    /// show the answer to input through `echo_horizon`.
    pub(super) fn note_applied(&mut self, input_seq: u32, echo_horizon: u32) {
        self.retire_preview_authority();
        self.authoritative_input = advance_input_seq(self.authoritative_input, input_seq);
        self.echo_horizon = advance_input_seq(self.echo_horizon, echo_horizon);
        self.batch = Some(advance_input_seq(self.batch.unwrap_or(0), input_seq));
    }

    /// A resize retires the overlay without retiring its causal input fence.
    pub(super) fn fence_for_resize<G: DisplayGrid>(&mut self, grid: &mut G) {
        self.retire_preview_authority();
        self.barrier.open_through(self.latest);
        grid.predict_discard();
        self.grace_at_ms = None;
    }

    /// A snapshot replaced the base the model predicts from: everything
    /// modelled waits for authority, and trust starts over.
    pub(super) fn fence_for_snapshot<G: DisplayGrid>(&mut self, grid: &mut G) {
        self.retire_preview_authority();
        self.barrier.open_through(self.latest);
        self.consecutive = 0;
        self.stats.state = PredictionState::Learning;
        if grid.has_predictions() {
            grid.predict_discard();
        }
        self.grace_at_ms = None;
    }

    /// A new authenticated session numbers input afresh.
    pub(super) fn reset_session<G: DisplayGrid>(&mut self, grid: &mut G) {
        grid.predict_discard();
        let (mode, stats) = (self.mode, self.stats);
        let authority_revision = self.authority_revision.wrapping_add(1);
        *self = Self {
            authority_revision,
            mode,
            stats: PredictionStats {
                state: PredictionState::Learning,
                ..stats
            },
            ..Self::default()
        };
    }

    /// The mode word may have moved: after every applied header, and every
    /// input-routing word.
    pub(super) fn observe_mode<G: DisplayGrid>(&mut self, grid: &mut G, epoch_reset: bool) {
        let mode = (grid.prediction_granted(), grid.alt_screen_active());
        if self.mode == Some(mode) {
            return;
        }
        self.retire_preview_authority();
        let was_refused = self.mode.is_some_and(|(granted, _)| !granted);
        let was_alt_screen = self.mode.is_some_and(|(_, alt)| alt);
        self.mode = Some(mode);
        let (granted, alt_screen) = mode;
        // Crossing the alternate screen repaints the whole grid: what is in
        // flight describes a screen that no longer exists. A withdrawn grant
        // was answered by the model when the header applied.
        if alt_screen != was_alt_screen || (!was_refused && !granted) {
            if alt_screen != was_alt_screen {
                grid.predict_discard();
                self.grace_at_ms = None;
            }
            self.stats.state = PredictionState::Suppressed;
            self.consecutive = 0;
        }
        self.update_gate(epoch_reset);
    }

    /// The daemon's prompt anchor: `generation:u32 | row:u16 | col:u16 |
    /// flags:u16`, geometry only. Only the open bit means anything.
    pub(super) fn editor_anchor<G: DisplayGrid>(&mut self, grid: &mut G, body: &[u8]) {
        let Some(anchor) = body.get(..10) else {
            return;
        };
        let generation = u32::from_be_bytes(anchor[..4].try_into().expect("u32"));
        let row = u16::from_be_bytes([anchor[4], anchor[5]]);
        let col = u16::from_be_bytes([anchor[6], anchor[7]]);
        let flags = u16::from_be_bytes([anchor[8], anchor[9]]);
        let open = flags & merkur_wire::protocol::EDITOR_ANCHOR_FLAG_OPEN != 0;
        self.retire_preview_authority();
        grid.set_editor_anchor(generation, row, col, open);
    }

    /// Everything the last drain applied is authority: compare the model
    /// against it once, then let the fence see how far it reaches.
    pub(super) fn reconcile_applied<G: DisplayGrid>(
        &mut self,
        grid: &mut G,
        epoch_reset: bool,
        now_ms: f64,
    ) {
        let Some(input_seq) = self.batch.take() else {
            return;
        };
        self.reconcile(grid, epoch_reset, now_ms);
        // Only explicit unmodelled input uses the fence; a mismatch rebases
        // straight onto this authority.
        self.barrier.observe_authoritative(input_seq);
        self.update_gate(epoch_reset);
    }

    /// A presentation committed: a verdict the model deferred for want of it
    /// is due now.
    pub(super) fn presented<G: DisplayGrid>(
        &mut self,
        grid: &mut G,
        epoch_reset: bool,
        now_ms: f64,
    ) {
        if self.grace_at_ms.take().is_some() {
            self.reconcile(grid, epoch_reset, now_ms);
        }
    }

    pub(super) fn handle_timeout<G: DisplayGrid>(
        &mut self,
        grid: &mut G,
        epoch_reset: bool,
        now_ms: f64,
    ) {
        if self.grace_at_ms.is_some_and(|at| at <= now_ms) {
            self.grace_at_ms = None;
            self.reconcile(grid, epoch_reset, now_ms);
        }
    }

    fn reconcile<G: DisplayGrid>(&mut self, grid: &mut G, epoch_reset: bool, now_ms: f64) {
        if !grid.has_predictions() {
            self.grace_at_ms = None;
            return;
        }
        let ttl_ms = if self.mode.is_some_and(|(_, alt)| alt) {
            ALT_SCREEN_TTL_MS
        } else {
            TTL_MS
        };
        let [
            confirmed,
            mismatched,
            expired_covered,
            _,
            _,
            deferred_mismatch,
            expired_stalled,
        ] = grid.predict_reconcile(now_ms, ttl_ms, self.authoritative_input, self.echo_horizon);
        if mismatched + expired_covered + expired_stalled > 0 {
            self.retire_preview_authority();
        }
        for _ in 0..confirmed {
            self.record_outcome(true);
        }
        // A stalled expiry is no evidence: nothing contradicted it.
        for _ in 0..mismatched + expired_covered {
            self.record_outcome(false);
        }
        self.stats.confirmed += u64::from(confirmed);
        self.stats.mismatched += u64::from(mismatched);
        self.stats.expired_covered += u64::from(expired_covered);
        self.stats.expired_stalled += u64::from(expired_stalled);
        // The model already rebased a mismatch onto authority; the trust
        // gate, not the fence, keeps what follows hidden until confirmed.
        if mismatched > 0 || expired_covered > 0 {
            self.consecutive = 0;
        } else {
            self.consecutive += confirmed;
        }
        if deferred_mismatch > 0 {
            self.grace_at_ms.get_or_insert(now_ms + MISMATCH_GRACE_MS);
        } else {
            self.grace_at_ms = None;
        }
        self.update_gate(epoch_reset);
    }

    fn record_outcome(&mut self, confirmed: bool) {
        if self.outcome_count == RECENT_WINDOW {
            self.outcome_positive -= usize::from(self.outcomes[self.outcome_index]);
        } else {
            self.outcome_count += 1;
        }
        self.outcomes[self.outcome_index] = confirmed;
        self.outcome_positive += usize::from(confirmed);
        self.outcome_index = (self.outcome_index + 1) % RECENT_WINDOW;
    }

    /// What the next printable latches: visible once the causal base is
    /// authoritative, the grant holds and enough confirmations came in a row.
    /// Nothing measured enters it.
    fn update_gate(&mut self, epoch_reset: bool) {
        let granted = self.mode.is_some_and(|(granted, _)| granted);
        let ratio = if self.outcome_count == 0 {
            0.0
        } else {
            self.outcome_positive as f64 / self.outcome_count as f64
        };
        let trusted = self.consecutive >= MIN_CONSECUTIVE_CONFIRMED && ratio >= MIN_VISIBLE_RATIO;
        let causal = !self.barrier.is_open() && !epoch_reset;
        self.stats.state = if !granted {
            PredictionState::Suppressed
        } else if causal && trusted {
            PredictionState::Visible
        } else {
            PredictionState::Learning
        };
    }
}

#[cfg(test)]
mod tests;
