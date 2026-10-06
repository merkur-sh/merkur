//! Shared terminal adapter for the native and browser client viewers.
//! The viewer owns its terminal; renderers borrow only that owner's presentation.

use crate::Terminal;
use merkur_client::viewer::{DisplayGrid, graphics::Scene};
type GraphicsAdmitter = Box<dyn FnMut(&Scene) -> bool>;
type DisplayObserver = Box<dyn FnMut(&[u32; 14], f64) -> f64>;

pub struct ClientGrid {
    terminal: Terminal,
    /// Every local change to the canonical grid, as the browser's loader
    /// counts them: a claim noted before one no longer describes the grid.
    mutation_epoch: u64,
    graphics_admitter: Option<GraphicsAdmitter>,
    display_observer: Option<DisplayObserver>,
}

impl ClientGrid {
    /// A grid of this size until the first snapshot sets the daemon's.
    pub fn new(cols: u16, rows: u16) -> Self {
        Self::from_terminal(Terminal::new_headless(cols, rows))
    }

    /// A renderer's fully initialized terminal and the viewer share one owner.
    pub fn from_terminal(terminal: Terminal) -> Self {
        Self {
            terminal,
            mutation_epoch: 0,
            graphics_admitter: None,
            display_observer: None,
        }
    }

    pub fn fresh_session(&mut self) -> Self {
        let mut next = Self::from_terminal(self.terminal.fresh_display_session());
        next.graphics_admitter = self.graphics_admitter.take();
        next.display_observer = self.display_observer.take();
        next
    }

    pub fn set_graphics_admitter(&mut self, admit: GraphicsAdmitter) {
        self.graphics_admitter = Some(admit);
    }

    pub fn set_display_observer(&mut self, observer: DisplayObserver) {
        self.display_observer = Some(observer);
    }

    pub fn terminal_mut(&mut self) -> &mut Terminal {
        &mut self.terminal
    }

    pub fn terminal(&self) -> &Terminal {
        &self.terminal
    }

    /// Theme changes invalidate a claim captured before the local mutation.
    pub fn set_theme(&mut self, bytes: &[u8]) -> bool {
        if !self.terminal.set_theme(bytes) {
            return false;
        }
        self.mutation_epoch = self
            .mutation_epoch
            .checked_add(1)
            .expect("terminal mutation namespace exhausted");
        true
    }

    /// Every row of the shown grid as text, its blank tail trimmed.
    pub fn screen(&self) -> Vec<String> {
        self.terminal
            .presentation_viewport_rows()
            .split('\n')
            .map(|row| row.trim_end().to_string())
            .collect()
    }
}

impl DisplayGrid for ClientGrid {
    fn trace_display(&mut self, words: &[u32; 14], since_ms: f64) -> f64 {
        self.display_observer
            .as_mut()
            .map_or(f64::NAN, |observe| observe(words, since_ms))
    }
    fn resize(&mut self, cols: u16, rows: u16) {
        self.terminal.resize(cols, rows);
        self.mutation_epoch = self
            .mutation_epoch
            .checked_add(1)
            .expect("terminal mutation namespace exhausted");
    }

    fn stage(&mut self, frame: &[u8]) -> u32 {
        self.terminal.stage_display_frame_bytes(frame)
    }

    fn validate(&mut self, handle: u32) -> bool {
        self.terminal.validate_staged_frame(handle)
    }

    fn apply_state(&mut self, handle: u32, seq: u32) -> bool {
        self.terminal.apply_staged_state_seq(handle, seq)
    }

    fn apply_delta(&mut self, handle: u32, seq: u32) -> bool {
        self.terminal.apply_staged_delta_seq(handle, seq)
    }

    fn release(&mut self, handle: u32) {
        self.terminal.release_staged_frame(handle);
    }

    fn reset_ordering(&mut self) {
        self.terminal.reset_display_ordering();
        self.mutation_epoch = self
            .mutation_epoch
            .checked_add(1)
            .expect("terminal mutation namespace exhausted");
    }

    fn take_error(&mut self) -> Option<String> {
        self.terminal.take_last_error()
    }

    fn rows(&self) -> u16 {
        self.terminal.rows()
    }

    fn row_hashes(&mut self) -> &[u64] {
        self.terminal.refresh_row_hashes();
        &self.terminal.row_hashes
    }

    fn row_version(&self, row: u16) -> u32 {
        self.terminal.display_row_version(row)
    }

    fn install_dictionary(&mut self, generation: u32, id: u32, hash: u32, bytes: &[u8]) -> bool {
        self.terminal
            .install_display_dictionary(generation, id, hash, bytes)
    }

    fn clear_dictionaries(&mut self) {
        self.terminal.clear_display_dictionaries();
    }

    fn cols(&self) -> u16 {
        self.terminal.cols()
    }

    fn last_apply_visually_changed(&self) -> bool {
        self.terminal.last_apply_visually_changed()
    }

    fn closure_digest_matches(&mut self, digest: u64) -> bool {
        self.terminal
            .closure_digest_matches((digest >> 32) as u32, digest as u32)
    }

    fn completion_mutation_epoch(&self) -> u64 {
        self.mutation_epoch
    }

    fn commit_presentation(&mut self) {
        self.terminal.commit_presentation_state();
    }

    fn set_input_routing(&mut self, word: u16) {
        self.terminal.set_input_routing(u32::from(word));
    }

    fn release_input_routing(&mut self) {
        self.terminal.release_input_routing();
    }

    fn prediction_granted(&self) -> bool {
        self.terminal.prediction_granted()
    }

    fn alt_screen_active(&self) -> bool {
        self.terminal.alt_screen_active()
    }

    fn set_editor_anchor(&mut self, generation: u32, row: u16, col: u16, open: bool) {
        self.terminal
            .set_editor_anchor(generation, row, col, u32::from(open));
    }

    fn predict_printable(
        &mut self,
        codepoint: u32,
        sent_at_ms: f64,
        input_seq: u32,
        visible: bool,
    ) -> bool {
        self.terminal
            .predict_printable(codepoint, sent_at_ms, input_seq, visible)
            != 0
    }

    fn predict_backspace(&mut self, sent_at_ms: f64, input_seq: u32) -> bool {
        self.terminal.predict_backspace(sent_at_ms, input_seq) != 0
    }

    fn predict_delete(&mut self, sent_at_ms: f64, input_seq: u32) -> bool {
        self.terminal.predict_delete(sent_at_ms, input_seq) != 0
    }

    fn predict_cursor_shift(&mut self, delta: i32, sent_at_ms: f64, input_seq: u32) -> bool {
        self.terminal
            .predict_cursor_shift(delta, sent_at_ms, input_seq)
            != 0
    }

    fn predict_seal(&mut self, input_seq: u32) {
        self.terminal.predict_seal(input_seq);
    }

    fn predict_discard(&mut self) {
        self.terminal.predict_discard();
    }

    fn has_predictions(&self) -> bool {
        self.terminal.has_predictions()
    }

    fn predict_reconcile(
        &mut self,
        now_ms: f64,
        ttl_ms: f64,
        input_high_water: u32,
        echo_horizon: u32,
    ) -> [u32; 7] {
        self.terminal
            .predict_reconcile(now_ms, ttl_ms, input_high_water, echo_horizon);
        self.terminal.reconcile_stats()
    }

    fn admit_graphics_scene(&mut self, scene: &Scene) -> bool {
        self.graphics_admitter
            .as_mut()
            .is_none_or(|admit| admit(scene))
    }

    fn graphics_revision(&self) -> u32 {
        self.terminal.graphics_revision()
    }

    fn graphics_fragments(&mut self) -> &[u8] {
        self.terminal.graphics_fragments()
    }
}
