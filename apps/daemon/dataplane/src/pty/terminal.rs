mod graphics;

use alacritty_terminal::event::{Event, EventListener};
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::index::Line;
#[cfg(test)]
use alacritty_terminal::index::{Column, Point};
use alacritty_terminal::term::{Config, Term, TermDamage, TermMode, point_to_viewport};
use alacritty_terminal::vte::ansi::{Color, CursorShape, Processor};
use crossbeam_channel::Sender;
use merkur_codec::{
    CELL_DIGEST_BYTES, CELL_DIGEST_WRAPPED_BIT, CellRepr, FrameHeader, FrameKind, GraphicsVersion,
    PreparedGraphics, ROW_FLAG_GRAPHICS, STREAM_HEADER_BYTES, VERSION, append_graphics_digest,
    append_link_digest, cell_wraps, encode_cells, pack_cell_digest, resolve_color,
    row_cell_count_field, row_hash_packed, row_left_field,
};
#[cfg(test)]
use merkur_codec::{
    DISPLAY_ROW_COUNT_OFFSET, FRAME_HEADER_BODY_BYTES, ROW_PREFIX_BYTES, encoded_cells_size,
};
use merkur_graphics::scene::Image;
use merkur_image_worker::{content::ImageContent, retirement::Completion};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use super::TerminalEvent;
use super::input_encoder;
use super::links::{LinkTable, openable_url};
use super::open_url::OpenUrlQueue;
use crate::network::input_record::{InputRecord, KeyEvent, KeyText, mods as input_mods};

/// See [`TerminalState::display_header_state`].
#[derive(Clone, Copy)]
pub struct DisplayHeaderState {
    pub header: FrameHeader,
    pub signal: u128,
    pub cursor_row: Option<u16>,
}

/// Immutable visible-row capture shared by diffing, encoding, resume adoption
/// and dictionary preparation. Its graphics row carries bytes but no storage
/// charge; ACK provenance keeps only the row's version (`connection::SentRow`).
#[derive(Clone)]
pub struct CapturedRow {
    pub row: u16,
    pub hash: u64,
    pub cells: Arc<[CellRepr]>,
    pub graphics: merkur_codec::PreparedGraphics,
}

/// Two retained versions per visible row: the current capture and its next
/// writable storage. Slow consumers may own older versions, but cannot grow
/// this pool or allow a retained ACK/preparation baseline to be overwritten.
#[derive(Default)]
struct RowCapturePool {
    cols: usize,
    rows: Vec<[Option<Arc<[CellRepr]>>; 2]>,
}

impl RowCapturePool {
    fn capture(
        &mut self,
        row: u16,
        cols: u16,
        rows: u16,
        graphics: &PreparedGraphics,
        fill: impl FnOnce(&mut [CellRepr]) -> u64,
    ) -> CapturedRow {
        let cols = usize::from(cols);
        if self.cols != cols {
            self.rows.clear();
            self.cols = cols;
        }
        self.rows.resize_with(usize::from(rows), || [None, None]);
        let versions = &mut self.rows[usize::from(row)];
        // Oldest first. get_mut is the ownership proof, including weak owners;
        // a consumer may release an Arc concurrently but cannot acquire a new
        // one after this test succeeds.
        let reusable = versions.iter_mut().position(|version| {
            version
                .as_mut()
                .is_some_and(|cells| Arc::get_mut(cells).is_some())
        });
        let mut cells = reusable
            .and_then(|index| versions[index].take())
            .unwrap_or_else(|| Arc::from(vec![CellRepr::BLANK; cols]));
        let hash = fill(Arc::get_mut(&mut cells).expect("capture storage has one owner"));
        if reusable != Some(1) {
            versions[0] = versions[1].take();
        }
        versions[1] = Some(Arc::clone(&cells));
        CapturedRow {
            row,
            hash,
            cells,
            graphics: graphics.clone(),
        }
    }
}

/// Retained immutable-row storage plus packed digest scratch. Capture fills both
/// in one terminal traversal; readers share the resulting row and its hash.
#[derive(Default)]
pub struct RowCaptureScratch {
    #[cfg(test)]
    pub cells: Vec<CellRepr>,
    pub digest: Vec<u8>,
    captures: RowCapturePool,
}

#[derive(Clone, Copy)]
pub struct DisplayRowRequest {
    pub row: u16,
    pub force_full: bool,
}

impl DisplayRowRequest {
    /// A row entry. Test-only: production
    /// selection builds requests directly in `classify_flush_rows`.
    #[cfg(test)]
    pub fn literal(row: u16, force_full: bool) -> Self {
        Self { row, force_full }
    }
}

const CURSOR_SHAPE_HIDDEN: u8 = 0;
const CURSOR_SHAPE_BLOCK: u8 = 1;
const CURSOR_SHAPE_BEAM: u8 = 2;
const CURSOR_SHAPE_UNDERLINE: u8 = 3;
/// Display mode bits, a wire fact mirrored by `DISPLAY_MODE_*` in
/// `packages/term-wasm` and `TERMINAL_MODE_*` in `packages/shared`.
/// Pointer presses and releases belong to the application, not to selection.
pub const DISPLAY_MODE_POINTER_CLICKS: u16 = 1;
/// Motion with a button held is reported.
pub const DISPLAY_MODE_POINTER_DRAG: u16 = 1 << 1;
/// Motion with no button held is reported (any-motion tracking).
pub const DISPLAY_MODE_POINTER_HOVER: u16 = 1 << 2;
/// The wheel belongs to the application: as wheel buttons under mouse
/// tracking, or as cursor keys on an alternate screen with alternate scroll.
pub const DISPLAY_MODE_WHEEL: u16 = 1 << 3;
/// The alternate screen, which resizes without reflow.
pub const DISPLAY_MODE_ALT_SCREEN: u16 = 1 << 4;
/// The authenticated grant that local edits at the cursor may be predicted.
pub const DISPLAY_MODE_PREDICTION_SAFE: u16 = 1 << 5;
/// Key releases encode to bytes (Kitty flag 2). With the next two bits, this
/// tells the browser when input nothing waits on is worth a datagram of its
/// own; until then it rides with the next input.
pub const DISPLAY_MODE_KEY_RELEASES: u16 = 1 << 6;
/// Bare modifier keys encode to bytes (Kitty flag 8).
pub const DISPLAY_MODE_MODIFIER_KEYS: u16 = 1 << 7;
/// Focus records encode to bytes (DECSET 1004).
pub const DISPLAY_MODE_FOCUS: u16 = 1 << 8;
// The input-routing word is the mode word less everything that describes the
// grid (alternate screen, prediction grant). The wire states its mask as a
// literal both languages pin; these are the bits it has to be.
const _: () = assert!(
    crate::network::protocol::INPUT_ROUTING_MASK
        == DISPLAY_MODE_POINTER_CLICKS
            | DISPLAY_MODE_POINTER_DRAG
            | DISPLAY_MODE_POINTER_HOVER
            | DISPLAY_MODE_WHEEL
            | DISPLAY_MODE_KEY_RELEASES
            | DISPLAY_MODE_MODIFIER_KEYS
            | DISPLAY_MODE_FOCUS
);
/// Shell authority comes only from canonical VTE events, never a second ANSI parser.
#[derive(Default)]
struct ShellIntegrationState {
    input_active: bool,
    input_authenticated: bool,
    /// A new boundary needs fresh kernel evidence even if its bits are unchanged.
    authority_changed: bool,
    expected_token: Option<Box<[u8]>>,
}

impl ShellIntegrationState {
    fn grant(&mut self, authenticated: bool) {
        self.authority_changed = true;
        self.input_active = true;
        self.input_authenticated = authenticated;
    }

    fn hard_reset(&mut self) {
        self.authority_changed = true;
        self.input_active = false;
        self.input_authenticated = false;
    }
}

/// Constant-time comparison of the daemon's 128-bit prompt token.
#[inline]
fn tokens_equal(expected: &[u8], candidate: &[u8]) -> bool {
    if expected.len() != candidate.len() {
        return false;
    }
    let mut difference = 0u8;
    for (left, right) in expected.iter().zip(candidate) {
        difference |= left ^ right;
    }
    difference == 0
}

struct EventForwarder {
    graphics: merkur_graphics::boundary::Boundary,
    graphics_reset: bool,
    viewport: Option<super::Viewport>,
    event_tx: Sender<TerminalEvent>,
    bell_pending: Arc<AtomicBool>,
    shell_integration: ShellIntegrationState,
    editor_anchor: Option<(u16, u16)>,
    editor_anchor_generation: u32,
    /// Already received but unapplied bytes cannot establish a fresh boundary
    /// after an unmodelled input or resize invalidates their provenance.
    ignored_shell_evidence_bytes: usize,
    last_application_fresh: bool,
    control_fresh: bool,
    pending_prompt: Option<bool>,
    pending_prompt_escape_start: bool,
    /// Authenticated `merkur open` requests no browser has acknowledged.
    open_urls: OpenUrlQueue,
    ui: Mutex<crate::pty::terminal_ui::Effects>,
}

impl EventListener for EventForwarder {
    fn terminal_apc_start(&mut self) {
        self.graphics.start();
    }

    fn terminal_apc_put(&mut self, bytes: &[u8]) {
        self.graphics.push(bytes);
    }

    fn terminal_apc_end(&mut self, complete: bool) {
        self.graphics.end(complete);
    }

    fn terminal_semantic_pending(&self) -> bool {
        self.graphics.paused() || self.graphics_reset
    }

    fn terminal_reset(&mut self) {
        self.graphics.reset();
        self.graphics_reset = true;
    }

    #[inline]
    fn observe_terminal_bytes(&mut self, bytes: &[u8]) {
        let ignored = self.ignored_shell_evidence_bytes.min(bytes.len());
        self.ignored_shell_evidence_bytes -= ignored;
        self.last_application_fresh = ignored < bytes.len();
    }

    fn terminal_control_started(&mut self) {
        if self.pending_prompt_escape_start {
            self.pending_prompt_escape_start = false;
        } else {
            self.pending_prompt = None;
        }
        self.control_fresh = self.last_application_fresh;
    }

    fn terminal_control_cancelled(&mut self) {
        self.control_fresh = false;
        self.pending_prompt = None;
        self.pending_prompt_escape_start = false;
        self.shell_integration.hard_reset();
        self.clear_editor_anchor();
    }

    fn shell_editor_mode(&mut self, enabled: bool) {
        if enabled && self.control_fresh {
            self.shell_integration.grant(false);
        } else {
            self.shell_integration.hard_reset();
            self.clear_editor_anchor();
        }
    }

    fn shell_integration(&mut self, params: &[&[u8]], bell_terminated: bool) -> bool {
        let authenticated = match params {
            [b"B"] => Some(false),
            [b"B", token] => token.strip_prefix(b"merkur=").and_then(|candidate| {
                self.shell_integration
                    .expected_token
                    .as_ref()
                    .filter(|expected| tokens_equal(expected, candidate))
                    .map(|_| true)
            }),
            _ => None,
        };
        if let Some(authenticated) = authenticated.filter(|_| self.control_fresh) {
            if !bell_terminated {
                // VTE dispatches OSC at ESC, before its final backslash. Only
                // the bounded classified result survives, never borrowed bytes.
                self.shell_integration.hard_reset();
                self.clear_editor_anchor();
                self.pending_prompt = Some(authenticated);
                self.pending_prompt_escape_start = true;
                return false;
            }
            self.shell_integration.grant(authenticated);
            true
        } else {
            self.shell_integration.hard_reset();
            self.clear_editor_anchor();
            false
        }
    }

    fn shell_integration_terminator(&mut self, valid: bool) -> bool {
        let pending = self.pending_prompt.take();
        self.pending_prompt_escape_start = false;
        if let Some(authenticated) = pending.filter(|_| valid && self.control_fresh) {
            self.shell_integration.grant(authenticated);
            true
        } else {
            false
        }
    }

    /// `OSC 7780 ; merkur=<token> ; <url>`. The token is the prompt-boundary
    /// token and carries the same claim: whatever wrote this could read a file
    /// in the user's 0700 config directory, so it is not a remote program's
    /// output. Anything else — no token, a wrong one, a URL that is not
    /// `http(s)` — is dropped without a trace.
    fn open_url_request(&mut self, params: &[&[u8]]) {
        let [token, url @ ..] = params else {
            return;
        };
        let authenticated = token.strip_prefix(b"merkur=").is_some_and(|candidate| {
            self.shell_integration
                .expected_token
                .as_ref()
                .is_some_and(|expected| tokens_equal(expected, candidate))
        });
        if !authenticated || url.is_empty() {
            return;
        }
        // VTE splits at every `;`, and a URL may contain them.
        let url = url.join(&b';');
        if let Some(url) = openable_url(&url) {
            self.open_urls.push(url.into());
        }
    }

    fn desktop_notification(&mut self, title: &[u8], body: &[&[u8]]) {
        use merkur_wire::terminal_ui::{TEXT_BYTES_MAX, TerminalUi};
        let bytes = body.iter().map(|part| part.len()).sum::<usize>()
            .saturating_add(body.len().saturating_sub(1));
        if title.len().saturating_add(bytes) > TEXT_BYTES_MAX { return; }
        let joined = body.join(&b';');
        let (Ok(title), Ok(body)) = (std::str::from_utf8(title), std::str::from_utf8(&joined)) else { return; };
        self.ui.get_mut().unwrap_or_else(|poisoned| poisoned.into_inner())
            .push(TerminalUi::Notification { title: title.into(), body: body.into() });
    }

    fn terminal_prompt_boundary(&mut self, cursor: Option<(usize, usize)>) {
        let Some((row, col)) = cursor else {
            self.clear_editor_anchor();
            return;
        };
        let anchor = (clamp_usize_to_u16(row), clamp_usize_to_u16(col));
        if self.editor_anchor != Some(anchor) {
            self.editor_anchor = Some(anchor);
            self.editor_anchor_generation = self.editor_anchor_generation.wrapping_add(1).max(1);
        }
    }

    fn send_event(&self, event: Event) {
        match event {
            Event::Title(title) => {
                self.ui.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).title(title);
            }
            Event::ResetTitle => {
                self.ui.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).title(String::new());
            }
            Event::ClipboardStore(selection, text) => {
                use alacritty_terminal::term::ClipboardType;
                use merkur_wire::terminal_ui::TerminalUi;
                let selection = match selection {
                    ClipboardType::Clipboard => b'c',
                    ClipboardType::Selection => b'p',
                };
                self.ui.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
                    .push(TerminalUi::Clipboard { selection, text: zeroize::Zeroizing::new(text) });
            }
            Event::TextAreaSizeRequest(_) => {
                if let Some(viewport) = self.viewport {
                    let reply =
                        format!("\x1b[4;{};{}t", viewport.pixel_height, viewport.pixel_width);
                    let _ = self
                        .event_tx
                        .send(TerminalEvent::PtyWrite(reply.into_bytes()));
                }
            }
            Event::Bell => {
                // BEL is level-triggered UI state, not loss-sensitive data.
                // Coalesce it here instead of allocating one channel node per
                // byte (a child can emit tens of thousands in one PTY read).
                self.bell_pending.store(true, Ordering::Release);
            }
            // The emulator answers terminal queries (cursor position/DSR,
            // device attributes/DA, mode reports/DECRQM, etc.) by asking us to
            // write the reply back to the PTY. These MUST reach the child:
            // neovim and other TUIs block on them per redraw (up to
            // `ttimeoutlen`), so dropping them throttles rendering to ~1 row per
            // timeout — the visible line-by-line repaint.
            Event::PtyWrite(text) => {
                let _ = self
                    .event_tx
                    .send(TerminalEvent::PtyWrite(text.into_bytes()));
            }
            _ => {}
        }
    }
}

impl EventForwarder {
    fn clear_editor_anchor(&mut self) {
        if self.editor_anchor.take().is_some() {
            self.editor_anchor_generation = self.editor_anchor_generation.wrapping_add(1).max(1);
        }
    }
}

#[derive(Clone, Copy)]
struct TermDimensions {
    cols: usize,
    rows: usize,
}

impl Dimensions for TermDimensions {
    fn total_lines(&self) -> usize {
        self.rows
    }
    fn screen_lines(&self) -> usize {
        self.rows
    }
    fn columns(&self) -> usize {
        self.cols
    }
}

pub struct TerminalState {
    pub(crate) geometry_authority: crate::geometry::Authority,
    term: Term<EventForwarder>,
    parser: Processor,
    graphics: graphics::Graphics,
    /// Bytes in the owner's one retained PTY read, beyond the parser's own sync
    /// buffer. Input/resize revocation must cover both already-received sources.
    unapplied_pty_bytes: usize,
    pub cols: u16,
    pub rows: u16,
    bell_pending: Arc<AtomicBool>,
    dirty_rows: DirtyRows,
    display_metadata_dirty: bool,
    /// Monotonic identity of the terminal state used to prepare display
    /// frames. Pending transport work captures this value so a newer parsed
    /// mutation can discard only plaintext frames that have not been offered.
    display_revision: u64,
    /// Positive only when the latest PTY application completed an explicit ESU.
    completed_sync_update_epoch: u64,
    prediction_safe: bool,
    last_cursor: Option<(usize, usize)>,
    row_cells_scratch: Vec<CellRepr>,
    row_captures: RowCapturePool,
    /// Packed row-digest bytes, filled in the same traversal that fills
    /// `row_cells_scratch`. Held here rather than rebuilt per row so the hash
    /// pass allocates nothing in the steady state.
    row_digest_scratch: Vec<u8>,
    row_bytes_scratch: Vec<u8>,
    last_encoded_row_count: u16,
    /// OSC 8 ids issued by row capture. Behind a mutex because capture runs
    /// through `&self` from the send path; it is only locked for a row that
    /// actually holds a link, and only by the owner loop.
    links: Mutex<LinkTable>,
    /// Browsers whose window has focus. Focus reporting (DECSET 1004) is about
    /// the terminal, not one viewer of it: the application hears focus-in when
    /// the first browser gains focus and focus-out when the last one loses it
    /// or leaves.
    focused_peers: Vec<Arc<str>>,
}

/// Allocation-free damage census used by the display scheduler.
///
/// `CursorOnly` is deliberately narrower than "one dirty row": it is the one
/// row shape the encoder can classify as latency-critical authoritative
/// feedback. Every other row-bearing mutation must begin on the bounded redraw
/// tail, so the sender and browser agree about which work forms a coherent
/// presentation transaction.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PendingRowDamage {
    None,
    CursorOnly,
    Coherent,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PendingDisplayDamage {
    pub any: bool,
    pub rows: PendingRowDamage,
    pub cursor_row: Option<u16>,
    /// Application-provided completion evidence, independent of transport ACKs.
    pub completed_sync_update_epoch: u64,
}

impl PendingDisplayDamage {
    #[cfg(test)]
    pub const CLEAN: Self = Self {
        any: false,
        rows: PendingRowDamage::None,
        cursor_row: None,
        completed_sync_update_epoch: 0,
    };

    #[cfg(test)]
    pub const METADATA: Self = Self {
        any: true,
        rows: PendingRowDamage::None,
        cursor_row: None,
        completed_sync_update_epoch: 0,
    };

    #[cfg(test)]
    pub const COHERENT: Self = Self {
        any: true,
        rows: PendingRowDamage::Coherent,
        cursor_row: None,
        completed_sync_update_epoch: 0,
    };

    #[cfg(test)]
    pub const fn cursor_only(row: u16) -> Self {
        Self {
            any: true,
            rows: PendingRowDamage::CursorOnly,
            cursor_row: Some(row),
            completed_sync_update_epoch: 0,
        }
    }
}

/// Viewport rows whose content may have changed since the last capture, one
/// bit per row.
///
/// Only membership is kept: capture always re-reads the whole row, so column
/// bounds would be computed and never read. The words are sized only when the
/// viewport is, which keeps marking, clearing and the per-flush walk
/// allocation-free on every PTY read, including the full-damage read that
/// every scroll produces. No bit at or past `rows` is ever set.
struct DirtyRows {
    words: Vec<u64>,
    rows: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DirtyCensus {
    Clean,
    One(usize),
    Many,
}

impl DirtyRows {
    fn all(rows: usize) -> Self {
        let mut dirty = Self {
            words: vec![0; rows.div_ceil(64)],
            rows,
        };
        dirty.mark_all();
        dirty
    }

    /// Follow a viewport resize; the resized grid is entirely dirty.
    fn resize_all(&mut self, rows: usize) {
        self.rows = rows;
        self.words.resize(rows.div_ceil(64), 0);
        self.mark_all();
    }

    fn mark_all(&mut self) {
        self.words.fill(u64::MAX);
        let tail = self.rows % 64;
        if tail != 0
            && let Some(last) = self.words.last_mut()
        {
            *last = (1u64 << tail) - 1;
        }
    }

    fn clear(&mut self) {
        self.words.fill(0);
    }

    /// Merge a row bitset with this word layout. Bits at or past `rows` are
    /// dropped, so a full-damage word of ones marks exactly the viewport.
    fn mark_bits(&mut self, damage: &[u64]) {
        for (word, bits) in self.words.iter_mut().zip(damage) {
            *word |= bits;
        }
        let tail = self.rows % 64;
        if tail != 0
            && let Some(last) = self.words.last_mut()
        {
            *last &= (1u64 << tail) - 1;
        }
    }

    /// A row past the viewport clamps to the last row: an extra mark costs
    /// one capture, while a missed one leaves the browser's row stale.
    #[inline]
    fn mark(&mut self, row: usize) {
        let Some(last) = self.rows.checked_sub(1) else {
            return;
        };
        let row = row.min(last);
        if let Some(word) = self.words.get_mut(row / 64) {
            *word |= 1u64 << (row % 64);
        }
    }

    /// Stops at the second dirty row: coherence is certain by then.
    fn census(&self) -> DirtyCensus {
        let mut found = None;
        for (index, &bits) in self.words.iter().enumerate() {
            if bits == 0 {
                continue;
            }
            if found.is_some() || bits & (bits - 1) != 0 {
                return DirtyCensus::Many;
            }
            found = Some(index * 64 + bits.trailing_zeros() as usize);
        }
        found.map_or(DirtyCensus::Clean, DirtyCensus::One)
    }

    /// Dirty rows in ascending order.
    fn iter(&self) -> DirtyRowIter<'_> {
        DirtyRowIter {
            words: &self.words,
            next_word: 0,
            base: 0,
            bits: 0,
        }
    }
}

struct DirtyRowIter<'a> {
    words: &'a [u64],
    next_word: usize,
    base: usize,
    bits: u64,
}

impl Iterator for DirtyRowIter<'_> {
    type Item = usize;

    #[inline]
    fn next(&mut self) -> Option<usize> {
        while self.bits == 0 {
            self.bits = *self.words.get(self.next_word)?;
            self.base = self.next_word * 64;
            self.next_word += 1;
        }
        let row = self.base + self.bits.trailing_zeros() as usize;
        self.bits &= self.bits - 1;
        Some(row)
    }
}

impl TerminalState {
    pub fn new(cols: u16, rows: u16, event_tx: Sender<TerminalEvent>) -> Self {
        let normalized_cols = cols.max(1);
        let normalized_rows = rows.max(1);
        let dimensions = TermDimensions {
            cols: usize::from(normalized_cols),
            rows: usize::from(normalized_rows),
        };
        let bell_pending = Arc::new(AtomicBool::new(false));

        // The keyboard protocols are answered and tracked here, and honoured by
        // `input_encoder`, which reads the modes they set when it encodes a key.
        let config = Config {
            kitty_keyboard: true,
            modify_other_keys: true,
            ..Config::default()
        };
        Self {
            term: Term::new(
                config,
                &dimensions,
                EventForwarder {
                    graphics: merkur_graphics::boundary::Boundary::new(
                        merkur_graphics::processing::MAX_INPUT_BYTES.div_ceil(3) * 4,
                    ),
                    graphics_reset: false,
                    viewport: None,
                    event_tx,
                    bell_pending: Arc::clone(&bell_pending),
                    shell_integration: ShellIntegrationState::default(),
                    editor_anchor: None,
                    editor_anchor_generation: 0,
                    ignored_shell_evidence_bytes: 0,
                    last_application_fresh: true,
                    control_fresh: false,
                    pending_prompt: None,
                    pending_prompt_escape_start: false,
                    open_urls: OpenUrlQueue::new(),
                    ui: Mutex::new(crate::pty::terminal_ui::Effects::default()),
                },
            ),
            geometry_authority: crate::geometry::Authority::default(),
            parser: Processor::new(),
            graphics: graphics::Graphics::new(),
            unapplied_pty_bytes: 0,
            cols: normalized_cols,
            rows: normalized_rows,
            bell_pending,
            dirty_rows: DirtyRows::all(usize::from(normalized_rows)),
            display_metadata_dirty: false,
            display_revision: 1,
            completed_sync_update_epoch: 0,
            prediction_safe: false,
            last_cursor: None,
            row_cells_scratch: vec![CellRepr::BLANK; usize::from(normalized_cols)],
            row_captures: RowCapturePool::default(),
            row_digest_scratch: vec![0u8; usize::from(normalized_cols) * CELL_DIGEST_BYTES],
            row_bytes_scratch: Vec::new(),
            last_encoded_row_count: 0,
            links: Mutex::new(LinkTable::default()),
            focused_peers: Vec::new(),
        }
    }

    pub fn terminal_ui(&mut self) -> &mut crate::pty::terminal_ui::Effects {
        self.term.event_listener_mut().ui.get_mut().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Authenticated `merkur open` requests no browser has acknowledged.
    pub fn open_urls(&self) -> &OpenUrlQueue {
        &self.term.event_listener().open_urls
    }

    /// A browser handled the request `(epoch, seq)`.
    pub fn acknowledge_open_url(&mut self, epoch: u32, seq: u32) {
        self.term.event_listener_mut().open_urls.acknowledge(epoch, seq);
    }

    /// The hyperlink ids row capture has issued, for delivering their URIs.
    pub fn link_table(&self) -> MutexGuard<'_, LinkTable> {
        self.links.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Apply PTY output. The VTE observer captures shell evidence and the exact
    /// prompt cursor only as bytes enter terminal semantics, below synchronized
    /// buffering. Receipt of a still-buffered prompt grants no echo permission.
    pub fn apply_bytes(&mut self, bytes: &[u8]) -> usize {
        self.term.event_listener_mut().shell_integration.authority_changed = false;
        let sync_epoch_before = self.parser.completed_sync_updates();
        let forced_sync_before = self.parser.forced_sync_updates();
        if !bytes.is_empty() || self.graphics_pending() {
            self.bump_display_revision();
            self.completed_sync_update_epoch = 0;
        }
        let mut accepted = 0;
        loop {
            if self.graphics_pending() && !self.graphics.advance(&mut self.term) {
                break;
            }
            accepted += self.parser.advance(&mut self.term, &bytes[accepted..]);
            self.graphics.consume_anchor_events(&mut self.term);
            if !self.graphics_pending() {
                break;
            }
        }
        self.unapplied_pty_bytes = bytes.len() - accepted;
        if self.graphics_pending() {
            // Revoke the reliable editor anchor immediately, including while
            // synchronized display capture is held behind image validation.
            self.clear_editor_anchor();
        }

        if self.term.event_listener().shell_integration.authority_changed
            || self.synchronized_update_deadline().is_some()
            || self.parser.control_pending()
            || self.graphics_pending()
        {
            // Publish revocation as metadata even for control-only output.
            // Fresh grants (including authenticated -> bare B) cannot reuse
            // the previous boundary's termios/process-group sample.
            self.set_prediction_safe(false);
        }

        if self.parser.forced_sync_updates() != forced_sync_before {
            // A buffer-limit release must fail closed just like the owner's
            // timeout release; it is not a fresh shell-editor boundary.
            self.term.event_listener_mut().terminal_control_cancelled();
            self.set_prediction_safe(false);
        } else if self.parser.completed_sync_updates() != sync_epoch_before
            && self.parser.sync_completed_at_boundary()
        {
            self.completed_sync_update_epoch = self.parser.completed_sync_updates();
        }

        // A boundary close (133;C, bracketed-paste disable, RIS) revokes the
        // editor claim, and an anchor without that claim is meaningless.
        if !self.term.event_listener().shell_integration.input_active {
            self.clear_editor_anchor();
        }
        self.project_graphics();
        self.record_damage();
        accepted
    }

    fn project_graphics(&mut self) {
        let damage = self.graphics.project(&mut self.term, self.cols, self.rows);
        self.dirty_rows.mark_bits(&damage);
    }

    /// The physical release the owner loop waits on, while the parser's storage
    /// admission or a deferred projection needs a removed source's storage back.
    pub(crate) fn graphics_release(&self) -> Option<Arc<Completion>> {
        self.graphics.release()
    }

    /// A removed source's physical release landed: resume a projection deferred
    /// behind it, and wake an admission waiting on it through the graphics wake,
    /// so the parser resumes on the owner loop's ordinary PTY path.
    pub fn observe_graphics_release(&mut self) {
        let (deferred, waiting) = self.graphics.observe_releases();
        if deferred {
            self.bump_display_revision();
            self.project_graphics();
        }
        if waiting {
            self.graphics.wake.notify_one();
        }
    }

    pub fn graphics_pending(&self) -> bool {
        self.term.event_listener().terminal_semantic_pending()
    }

    pub(crate) fn graphics_source(&self, root: &[u8; 32]) -> Option<Arc<Image<ImageContent>>> {
        self.graphics.source(root)
    }

    /// Whether a source root was published since the last call. Publication is
    /// the only way a root enters the live namespace, so it is the exact signal
    /// for requests parked on an absent root.
    pub(crate) fn take_published_roots(&mut self) -> bool {
        std::mem::take(&mut self.graphics.published)
    }

    /// The live image the application named `id`.
    #[cfg(test)]
    pub(crate) fn graphics_image(&self, id: u32) -> Option<Arc<Image<ImageContent>>> {
        self.graphics.image(id)
    }

    pub fn graphics_wake(&self) -> Arc<tokio::sync::Notify> {
        Arc::clone(&self.graphics.wake)
    }

    /// Replace this fresh terminal's graphics owner with one that runs the
    /// helper `bun run build:image-worker` builds, under its own resource
    /// ceilings.
    #[cfg(test)]
    pub(crate) fn use_built_image_worker(&mut self) {
        self.graphics = graphics::Graphics::with_built_worker();
    }

    /// The projection row display capture reads for `row`.
    #[cfg(test)]
    pub(crate) fn graphics_row(&self, row: usize) -> &PreparedGraphics {
        self.graphics.row(row)
    }

    /// Publish `rows` as the complete graphics projection, the way the live
    /// projector publishes one admitted batch: a row whose canonical encoding
    /// changed marks display damage, and published content latches the
    /// memory-only policy. Test-only: decoded images come only from the
    /// sandboxed helper, which a default test run does not build.
    #[cfg(test)]
    pub(crate) fn publish_graphics_projection(&mut self, rows: Vec<PreparedGraphics>) {
        assert!(
            rows.len() <= usize::from(self.rows),
            "a projection covers visible rows only"
        );
        self.bump_display_revision();
        for row in 0..usize::from(self.rows) {
            if !self
                .graphics
                .row(row)
                .same(rows.get(row).unwrap_or(&PreparedGraphics::EMPTY))
            {
                self.dirty_rows.mark(row);
            }
        }
        self.graphics.publish_projection(rows);
    }

    /// What this terminal's graphics storage holds.
    #[cfg(test)]
    pub(crate) fn graphics_storage_used(&self) -> merkur_graphics::budget::Usage {
        self.graphics.storage_used()
    }

    /// Reserve all of this terminal's graphics storage but `free`.
    #[cfg(test)]
    pub(crate) fn leave_graphics_storage(
        &self,
        free: merkur_graphics::budget::Usage,
    ) -> merkur_graphics::budget::Lease {
        self.graphics.leave_storage(free)
    }

    /// Graphics admission of a daemon of its own. The display simulator stands
    /// in for a whole daemon, and tests run many at once in one process: under
    /// the shared decoder admission, two other open uploads refuse this one's,
    /// and its synchronized drain never pauses on the image.
    #[cfg(test)]
    pub(crate) fn own_graphics_daemon(&mut self) {
        self.graphics = graphics::Graphics::with_own_daemon();
    }

    pub(crate) fn enable_native_graphics(&mut self) -> std::io::Result<graphics::NativeEndpoint> {
        self.graphics.enable_native()
    }

    pub fn display_commit_pending(&self) -> bool {
        self.parser.sync_drain_pending()
    }

    pub async fn shutdown_graphics(&mut self) {
        self.term.event_listener_mut().graphics.retire();
        self.graphics.shutdown(&mut self.term).await;
    }

    fn clear_editor_anchor(&mut self) {
        self.term.event_listener_mut().clear_editor_anchor();
    }

    /// Prompt-end cursor and its generation, or `None` when no authenticated
    /// editor boundary is currently open.
    pub fn editor_anchor(&self) -> Option<(u16, u16)> {
        self.term.event_listener().editor_anchor
    }

    pub fn editor_anchor_generation(&self) -> u32 {
        self.term.event_listener().editor_anchor_generation
    }

    /// Update the daemon-issued PTY prediction-safety capability advertised in
    /// authenticated display headers.
    ///
    /// `true` is a capability grant for speculative input, so callers must
    /// sample it fail-closed. Keep metadata damage separate from cell damage:
    /// a terminal-mode transition needs a header-only delta, not a full repaint.
    pub fn set_prediction_safe(&mut self, prediction_safe: bool) -> bool {
        // Buffered terminal bytes may revoke the prior prompt. Never advertise
        // a capability based on that stale boundary while application is pending.
        let prediction_safe = prediction_safe
            && self.synchronized_update_deadline().is_none()
            && !self.parser.control_pending()
            && !self.graphics_pending()
            && self.unapplied_pty_bytes == 0;
        if self.prediction_safe == prediction_safe {
            return false;
        }
        self.prediction_safe = prediction_safe;
        self.display_metadata_dirty = true;
        self.bump_display_revision();
        true
    }

    /// Cheap identity for every display-affecting parser/metadata transition.
    ///
    /// Saturation preserves monotonic ordering. Reaching `u64::MAX` would
    /// require centuries of sustained PTY reads; at that point supersession
    /// simply becomes conservative and lets pending work finish.
    #[inline]
    pub fn display_revision(&self) -> u64 {
        self.display_revision
    }

    /// An explicit ESU means the application has already finished its redraw.
    /// It needs no additional heuristic collection delay. Peers consume this
    /// identity only when their captured work actually enters the carrier.
    #[inline]
    pub fn completed_sync_update_epoch(&self) -> u64 {
        self.completed_sync_update_epoch
    }

    /// Parser lifetime identity, independent of eligibility for urgent display.
    /// An ESU followed by ordinary output still ends the old safety deadline.
    pub fn synchronized_update_lifetime_epoch(&self) -> u64 {
        self.parser.completed_sync_updates()
    }

    /// VTE records this deadline but does not drive a timer itself.
    #[inline]
    pub fn synchronized_update_deadline(&self) -> Option<std::time::Instant> {
        self.parser.sync_timeout().sync_timeout()
    }

    /// Safety release for an application that never sends ESU. The owner drives
    /// the bounded timer even when no more PTY bytes arrive. This does not grant
    /// the explicit completion epoch or fresh shell-editor evidence.
    pub fn stop_synchronized_update(&mut self) -> bool {
        if self.synchronized_update_deadline().is_none() {
            return false;
        }
        self.parser.stop_sync(&mut self.term);
        // A forced sync drain can expose an APC without a new physical PTY
        // read. Start its job now so its exact completion can wake the owner.
        let unapplied = self.unapplied_pty_bytes;
        self.apply_bytes(&[]);
        self.unapplied_pty_bytes = unapplied;
        self.completed_sync_update_epoch = 0;
        self.bump_display_revision();
        self.term.event_listener_mut().terminal_control_cancelled();
        self.clear_editor_anchor();
        self.set_prediction_safe(false);
        self.record_damage();
        true
    }

    /// Revoke editor evidence before unmodelled input can reach the PTY.
    ///
    /// Control keys, history/completion, paste runs, and other unknown input can
    /// invoke a same-shell widget which enters a silent read while retaining
    /// the foreground process group. Requiring a fresh post-input editor
    /// boundary prevents the stale prompt latch from reopening speculation.
    /// The boolean is authenticated browser provenance that the exact input
    /// was admitted into the bounded shadow model; every legacy or unflagged
    /// input fails closed.
    /// Input the browser could not model.
    ///
    /// Prediction is withdrawn immediately either way. What differs is whether
    /// the shell's editor boundary also closes, because that is the signal a
    /// password read is caught by and only a fresh `OSC 133;B` re-opens it —
    /// which never arrives mid-line.
    ///
    /// Closing it for EVERY unmodelled keystroke made one un-predicted key cost
    /// local echo for the remainder of the line, and made prediction coverage
    /// bimodal: a session either predicted throughout or collapsed on its first
    /// unmodelled key. But an ordinary printable cannot start a silent read. To
    /// reach one the input has to submit the line or change modes, so only that
    /// class closes the boundary.
    ///
    /// This does not widen what prediction is granted over: at a password
    /// prompt the boundary is already closed (the shell emitted `133;C` /
    /// `?2004l` and no new `133;B`), so `pty_prediction_safe` fails closed
    /// regardless of what is typed. The `read -s -k 1` regression test covers
    /// exactly that, and the submitting `\n` still closes the boundary here.
    ///
    /// Callers pass `record_is_modelled` and `record_leaves_line_editor`, never
    /// a judgement of the bytes the record encoded to: an application's
    /// keyboard mode decides those bytes, and must not move this boundary.
    pub fn observe_user_input(&mut self, modelled: bool, leaves_line_editor: bool) -> bool {
        if modelled {
            return false;
        }
        let buffered = self.parser.pending_sync_bytes_count() + self.unapplied_pty_bytes;
        self.term.event_listener_mut().ignored_shell_evidence_bytes = buffered;
        self.term.event_listener_mut().control_fresh = false;
        self.term.event_listener_mut().pending_prompt = None;
        self.term.event_listener_mut().pending_prompt_escape_start = false;
        if buffered != 0 || leaves_line_editor {
            self.term
                .event_listener_mut()
                .shell_integration
                .hard_reset();
            self.clear_editor_anchor();
        }
        self.set_prediction_safe(false)
    }

    /// Whether one input byte could submit the line or leave the line editor,
    /// after which an unseen `read -s` could be the next thing reading the PTY.
    #[inline]
    const fn input_can_leave_line_editor(byte: u8) -> bool {
        matches!(byte, b'\r' | b'\n' | 0x03 | 0x04 | 0x1a | 0x1b)
    }

    /// Whether legacy terminal input `bytes` could leave the line editor.
    pub fn bytes_leave_line_editor(bytes: &[u8]) -> bool {
        bytes
            .iter()
            .any(|byte| Self::input_can_leave_line_editor(*byte))
    }

    /// Whether `record` could leave the line editor, judged by its legacy
    /// encoding whatever the terminal's modes are, so that no keyboard mode an
    /// application enables can narrow the boundary. Pointer and focus reports
    /// exist only for an application that asked for them, which a line editor
    /// waiting on a password is not, and close it unconditionally.
    pub fn record_leaves_line_editor(record: &InputRecord<'_>) -> bool {
        struct LeaveScan(bool);
        impl input_encoder::Sink for LeaveScan {
            fn put(&mut self, bytes: &[u8]) {
                self.0 |= TerminalState::bytes_leave_line_editor(bytes);
            }
        }
        match record {
            InputRecord::Key(_) | InputRecord::Text(_) | InputRecord::Paste(_) => {
                let mut scan = LeaveScan(false);
                input_encoder::encode(record, TermMode::empty(), &mut scan);
                scan.0
            }
            InputRecord::Mouse(_) | InputRecord::Wheel(_) | InputRecord::Focus(_) => true,
        }
    }

    /// Whether the browser's claim that it modelled `record` is one the
    /// prediction model can make: a printable character typed with at most
    /// Shift, or Backspace, Delete, Left or Right alone. Enter is never
    /// modelled, so a claim on it cannot suppress the revocation Enter owes.
    /// Lock state changes neither.
    pub fn record_is_modelled(record: &InputRecord<'_>, shadow_modelled: bool) -> bool {
        if !shadow_modelled {
            return false;
        }
        let InputRecord::Key(key) = record else {
            return false;
        };
        if key.event == KeyEvent::Release {
            return false;
        }
        let chord = key.mods & !input_mods::LOCKS;
        match key.text {
            KeyText::Implied(_) => chord & !input_mods::SHIFT == 0,
            KeyText::Explicit(text) => {
                chord & !input_mods::SHIFT == 0 && text.chars().nth(1).is_none()
            }
            KeyText::None => {
                chord == 0
                    && matches!(
                        key.key,
                        input_encoder::BACKSPACE
                            | input_encoder::DELETE
                            | input_encoder::LEFT
                            | input_encoder::RIGHT
                    )
            }
        }
    }

    /// The modes the input encoder reads.
    #[inline]
    pub fn input_modes(&self) -> TermMode {
        *self.term.mode()
    }

    /// The part of the mode word that decides where browser input goes, derived
    /// from the same modes the input encoder reads.
    #[inline]
    pub fn input_routing_word(&self) -> u16 {
        encode_terminal_mode(self.input_modes()) & crate::network::protocol::INPUT_ROUTING_MASK
    }

    /// Whether `peer` gaining or losing focus changes whether any browser has
    /// it, which is the only change focus reporting describes.
    pub fn focus_changes_terminal_focus(&self, peer: &str, focused: bool) -> bool {
        let before = !self.focused_peers.is_empty();
        let after = focused || self.focused_peers.iter().any(|held| &**held != peer);
        before != after
    }

    /// Records `peer`'s focus once its focus record has been admitted.
    pub fn set_peer_focus(&mut self, peer: &Arc<str>, focused: bool) {
        let held = self.focused_peers.iter().position(|held| held == peer);
        match (held, focused) {
            (None, true) => self.focused_peers.push(Arc::clone(peer)),
            (Some(index), false) => {
                self.focused_peers.swap_remove(index);
            }
            _ => {}
        }
    }

    /// Drops the focus of browsers that are gone, and returns the focus-out
    /// report owed when the last focused one left without saying so.
    pub fn release_departed_focus(
        &mut self,
        present: impl Fn(&str) -> bool,
    ) -> Option<&'static [u8]> {
        if self.focused_peers.is_empty() {
            return None;
        }
        self.focused_peers.retain(|peer| present(peer));
        (self.focused_peers.is_empty() && self.term.mode().contains(TermMode::FOCUS_IN_OUT))
            .then_some(b"\x1b[O")
    }

    /// Whether prediction is currently granted. This — not the shell's editor
    /// boundary — is the property that gates speculative echo.
    ///
    /// Test-only accessor. Production reads the flag through the frame the
    /// encoder stamps; the grant itself is (re)computed by `pty_prediction_safe`
    /// and installed via `set_prediction_safe`.
    #[cfg(test)]
    pub fn prediction_safe(&self) -> bool {
        self.prediction_safe
    }

    pub fn shell_integration_input_active(&self) -> bool {
        self.synchronized_update_deadline().is_none()
            && !self.parser.control_pending()
            && !self.graphics_pending()
            && self.unapplied_pty_bytes == 0
            && self.term.event_listener().shell_integration.input_active
    }

    /// Whether the open boundary carried the daemon's token.
    ///
    /// Only ever consulted to decide whether the kernel-side cross-checks are
    /// applicable — see `prediction_safe_from_terminal_state`. It never opens a
    /// boundary that `shell_integration_input_active` has not already opened.
    pub fn shell_integration_authenticated(&self) -> bool {
        self.term
            .event_listener()
            .shell_integration
            .input_authenticated
    }

    /// Install the token an authenticated `OSC 133;B` must carry.
    ///
    /// Called once at startup from the value the daemon persisted. Without it
    /// the authenticated form is never accepted and behaviour is exactly what
    /// it was before the token existed.
    pub fn set_shell_token(&mut self, token: Box<[u8]>) {
        self.term
            .event_listener_mut()
            .shell_integration
            .expected_token = Some(token);
    }

    /** Return whether one or more BEL events arrived since the last call. */
    pub fn take_bell(&self) -> bool {
        self.bell_pending.swap(false, Ordering::AcqRel)
    }

    pub fn viewport_matches(&self, viewport: super::Viewport) -> bool {
        self.cols == viewport.cols
            && self.rows == viewport.rows
            && self.term.event_listener().viewport.map(|old| old.cell) == Some(viewport.cell)
    }

    /// The last successfully applied authenticated resize owns both grid and
    /// pixel geometry. Detached terminals retain that geometry until replaced.
    pub fn resize_viewport(&mut self, viewport: super::Viewport) {
        if self.term.event_listener().viewport.map(|old| old.cell) != Some(viewport.cell) {
            self.graphics.resize_geometry(&mut self.term, viewport.cell);
        }
        self.term.event_listener_mut().viewport = Some(viewport);
        self.resize(viewport.cols, viewport.rows);
    }

    pub fn resize(&mut self, cols: u16, rows: u16) {
        self.term.event_listener_mut().terminal_control_cancelled();
        self.term.event_listener_mut().ignored_shell_evidence_bytes =
            self.parser.pending_sync_bytes_count() + self.unapplied_pty_bytes;
        self.completed_sync_update_epoch = 0;
        self.bump_display_revision();
        self.cols = cols.max(1);
        self.rows = rows.max(1);
        self.term.resize(TermDimensions {
            cols: usize::from(self.cols),
            rows: usize::from(self.rows),
        });
        self.graphics.consume_anchor_events(&mut self.term);
        self.project_graphics();
        self.row_cells_scratch
            .resize(usize::from(self.cols), CellRepr::BLANK);
        self.last_cursor = None;
        self.term
            .event_listener_mut()
            .shell_integration
            .hard_reset();
        self.clear_editor_anchor();
        self.prediction_safe = false;
        self.dirty_rows.resize_all(usize::from(self.rows));
        self.term.reset_damage();
    }

    /// Fill `out` with the entire current visible grid (rows * cols cells).
    /// Used to populate a peer's acknowledged baseline after a snapshot.
    #[cfg(test)]
    pub fn current_grid_into(&self, out: &mut Vec<CellRepr>) {
        let grid = self.term.grid();
        let rows = grid.screen_lines();
        let cols = grid.columns();
        out.clear();
        out.reserve(rows.saturating_mul(cols));
        for row_index in 0..rows {
            let line = Line(row_index as i32);
            for col in 0..cols {
                out.push(CellRepr::from_alacritty(
                    &grid[Point::new(line, Column(col))],
                ));
            }
        }
    }

    /// Fill `out` with the cells of `row` and return its hash.
    /// O(cols) — caller owns the scratch buffer.
    #[cfg(test)]
    pub fn read_row_cells(&self, row: usize, out: &mut RowCaptureScratch) -> u64 {
        fill_visible_row(
            &self.term,
            &self.links,
            &self.graphics,
            row,
            usize::from(self.cols),
            &mut out.cells,
            &mut out.digest,
        )
    }

    /// Capture directly into uniquely owned immutable-row storage.
    pub fn capture_row(&self, row: u16, out: &mut RowCaptureScratch) -> CapturedRow {
        out.captures.capture(
            row,
            self.cols,
            self.rows,
            self.graphics.row(usize::from(row)),
            |cells| {
                fill_visible_cells(
                    &self.term,
                    &self.links,
                    &self.graphics,
                    usize::from(row),
                    cells,
                    &mut out.digest,
                )
            },
        )
    }

    /// Current cursor row in the visible viewport.
    ///
    /// Display scheduling uses this to keep the cursor-bearing row on the
    /// lowest-latency delivery path without exposing terminal-emulator or
    /// scrollback coordinates to the send layer.
    pub fn current_cursor_row(&self) -> Option<u16> {
        self.current_cursor_position()
            .map(|(row, _)| clamp_usize_to_u16(row))
    }

    /// Compact, allocation-free identity for the display header state that is
    /// visible to a peer. The send scheduler keeps one value per peer so a
    /// cursor/mode change can promote an existing row datagram to the Critical
    /// path without emitting a second header-only packet.
    pub fn current_display_header_signal(&self) -> u128 {
        Self::display_header_signal(&self.display_header(FrameKind::Delta, 0))
    }

    fn display_header_signal(header: &FrameHeader) -> u128 {
        (u128::from(header.memory_only) << 96)
            | (u128::from(header.cols) << 80)
            | (u128::from(header.rows) << 64)
            | (u128::from(header.cursor_col) << 48)
            | (u128::from(header.cursor_row) << 32)
            | (u128::from(header.cursor_shape) << 24)
            | (u128::from(header.cursor_visible) << 16)
            | u128::from(header.mode_flags)
    }

    /// The mode word a [`Self::current_display_header_signal`] value carries.
    #[inline]
    pub const fn display_header_signal_mode_flags(signal: u128) -> u16 {
        signal as u16
    }

    /// The complete-screen claim a capture of the current state makes, or 0.
    ///
    /// Only a state the application itself declared finished qualifies: the
    /// latest PTY application ended exactly at an explicit ESU, with nothing
    /// applied since. Graphics are excluded: a placement digest does not prove
    /// the image behind it has arrived. `row_hashes` must be this flush's
    /// `current_row_hashes`, which cover every row of the current grid.
    pub fn closure_digest(&self, header: &FrameHeader, row_hashes: &[u64]) -> u64 {
        if self.completed_sync_update_epoch == 0
            || self.graphics_pending()
            || self.graphics.projects_any_row()
            || row_hashes.len() != usize::from(self.rows)
            || header.cols != self.cols
            || header.rows != self.rows
        {
            return 0;
        }
        merkur_codec::viewport_closure_digest(
            header.cols,
            header.rows,
            header.cursor_col,
            header.cursor_row,
            header.cursor_shape,
            header.cursor_visible,
            row_hashes,
        )
    }

    /// Immutable display header captured for off-owner-loop frame encoding.
    ///
    /// The terminal emulator remains exclusively owned by the daemon loop;
    /// workers receive this value plus refcounted row snapshots and never
    /// access `Term` itself. `echo_horizon` is zero here: it belongs to the
    /// peer the capture is for (`PeerDisplayState::echo_horizon`), and a
    /// capture sent to a browser stamps it.
    pub fn current_display_header(&self, kind: FrameKind) -> FrameHeader {
        self.display_header(kind, 0)
    }

    /// Everything one peer flush reads of the header, from a single pass over
    /// the terminal: the delta header, the signal that identifies it to a peer,
    /// and the cursor's row while the cursor is inside the viewport.
    pub fn display_header_state(&self) -> DisplayHeaderState {
        let (header, cursor_row) = self.display_header_and_cursor_row(FrameKind::Delta, 0);
        DisplayHeaderState {
            header,
            signal: Self::display_header_signal(&header),
            cursor_row,
        }
    }

    /// Fill `out` with XXH3 hashes of every row in the current grid.
    /// `out.len() == rows` on return.
    pub fn current_row_hashes_into(&mut self, out: &mut Vec<u64>) {
        let cols = usize::from(self.cols);
        let rows = usize::from(self.rows);
        out.clear();
        out.reserve(rows);
        let mut scratch = std::mem::take(&mut self.row_cells_scratch);
        let mut digest = std::mem::take(&mut self.row_digest_scratch);
        if scratch.len() != cols {
            scratch.resize(cols, CellRepr::BLANK);
        }
        for row_index in 0..rows {
            out.push(fill_visible_row(
                &self.term,
                &self.links,
                &self.graphics,
                row_index,
                cols,
                &mut scratch,
                &mut digest,
            ));
        }
        self.row_cells_scratch = scratch;
        self.row_digest_scratch = digest;
    }

    /// Re-capture and re-hash only the rows marked dirty since the last
    /// `clear_dirty()`, replacing `captures` with one capture per such row.
    ///
    /// On the first call, and after a resize (`hashes.len() != rows`), every
    /// row is dirty.
    pub fn update_hashes_for_dirty_rows(
        &mut self,
        hashes: &mut Vec<u64>,
        captures: &mut Vec<CapturedRow>,
    ) {
        let rows = usize::from(self.rows);
        captures.clear();
        if hashes.len() != rows {
            hashes.resize(rows, 0);
            self.dirty_rows.mark_all();
        }
        for row_index in self.dirty_rows.iter() {
            let capture = self.row_captures.capture(
                row_index as u16,
                self.cols,
                self.rows,
                self.graphics.row(row_index),
                |cells| {
                    fill_visible_cells(
                        &self.term,
                        &self.links,
                        &self.graphics,
                        row_index,
                        cells,
                        &mut self.row_digest_scratch,
                    )
                },
            );
            hashes[row_index] = capture.hash;
            captures.push(capture);
        }
        // Every changed row is captured, so every region on screen is interned:
        // the one point where retiring a URI cannot race its own redraw.
        self.links
            .get_mut()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .retire_unreferenced_if_due();
        self.clear_dirty();
    }

    /// Encode a snapshot of the entire visible grid into `payload`.
    /// Returns (payload, encoded_row_count).
    #[cfg(test)]
    pub fn encode_snapshot_into(&mut self, payload: Vec<u8>) -> (Vec<u8>, u16) {
        self.encode_snapshot_rows_into(payload, None, None)
    }

    /// Capture a complete snapshot in one terminal traversal.
    ///
    /// The encoded rows, row-major cells used to prime peer ACK baselines, and
    /// per-row hashes all come from the same immutable row scratch before the
    /// next terminal row is read. This keeps snapshot/resync preparation both
    /// cheaper and internally consistent. `graphics` receives each encoded row's
    /// graphics version, not its bytes: the baselines it primes hold no storage.
    pub fn encode_snapshot_state_into(
        &mut self,
        payload: Vec<u8>,
        grid: &mut Vec<CellRepr>,
        row_hashes: &mut Vec<u64>,
        graphics: &mut Vec<Option<GraphicsVersion>>,
    ) -> (Vec<u8>, u16) {
        graphics.clear();
        graphics.extend(self.graphics.projected.iter().map(PreparedGraphics::version));
        self.encode_snapshot_rows_into(payload, Some(grid), Some(row_hashes))
    }

    fn encode_snapshot_rows_into(
        &mut self,
        mut payload: Vec<u8>,
        mut grid: Option<&mut Vec<CellRepr>>,
        mut row_hashes: Option<&mut Vec<u64>>,
    ) -> (Vec<u8>, u16) {
        let cols = usize::from(self.cols);
        let rows = usize::from(self.rows);
        payload.clear();
        payload.reserve(rows.saturating_mul(cols).saturating_mul(4));
        if let Some(grid) = grid.as_mut() {
            grid.clear();
            grid.reserve(rows.saturating_mul(cols));
        }
        if let Some(row_hashes) = row_hashes.as_mut() {
            row_hashes.clear();
            row_hashes.reserve(rows);
        }
        let header = self.display_header(FrameKind::Snapshot, 0);
        let row_count_offset = write_display_header(&mut payload, &header);
        self.last_cursor = self.current_cursor_position();

        let mut row_cells = std::mem::take(&mut self.row_cells_scratch);
        let mut row_digest = std::mem::take(&mut self.row_digest_scratch);
        let mut row_bytes = std::mem::take(&mut self.row_bytes_scratch);
        if row_cells.len() != cols {
            row_cells.resize(cols, CellRepr::BLANK);
        }
        let mut encoded_rows = 0usize;
        for row_index in 0..rows {
            let hash =
                fill_visible_row(
                &self.term,
                &self.links,
                &self.graphics,
                row_index,
                cols,
                &mut row_cells,
                &mut row_digest,
            );
            if let Some(grid) = grid.as_mut() {
                grid.extend_from_slice(&row_cells);
            }
            if let Some(row_hashes) = row_hashes.as_mut() {
                row_hashes.push(hash);
            }
            encode_display_row(
                &mut payload,
                clamp_usize_to_u16(row_index),
                0,
                &row_cells,
                &mut row_bytes,
                self.graphics.row(row_index),
            );
            encoded_rows += 1;
        }
        self.row_cells_scratch = row_cells;
        self.row_digest_scratch = row_digest;
        self.row_bytes_scratch = row_bytes;
        patch_display_row_count(&mut payload, row_count_offset, encoded_rows);
        self.last_encoded_row_count = clamp_usize_to_u16(encoded_rows);
        (payload, self.last_encoded_row_count)
    }

    /// Encode a delta against a per-peer baseline. Only the listed `dirty_rows`
    /// are walked. For each row, we compute the changed-cell range against
    /// the baseline and emit just that span. `force_full` rows are emitted as
    /// complete-row corrections for speculative sends that the browser may have
    /// applied even though the current terminal state returned to the ACKed row.
    ///
    /// Returns (payload, encoded_row_count). encoded_row_count may be less than
    /// dirty_rows.len() if a listed row happens to be byte-identical to the
    /// baseline (caller-side hash comparison normally rules this out, but we
    /// guard defensively). The payload is still meaningful when encoded_row_count
    /// is zero because the frame header carries cursor and mode state.
    ///
    /// `baseline_cells` is laid out row-major, length must be rows * cols.
    #[cfg(test)]
    pub fn encode_delta_for_rows(
        &mut self,
        baseline_cells: &[CellRepr],
        rows_to_send: &[DisplayRowRequest],
        mut payload: Vec<u8>,
    ) -> (Vec<u8>, u16) {
        let cols = usize::from(self.cols);
        let rows = usize::from(self.rows);
        payload.clear();
        if baseline_cells.len() != rows.saturating_mul(cols) {
            // Baseline has wrong shape — caller should send a snapshot instead.
            self.last_encoded_row_count = 0;
            return (payload, 0);
        }
        payload.reserve(rows_to_send.len().saturating_mul(cols).saturating_mul(4));
        let header = self.display_header(FrameKind::Delta, 0);
        let row_count_offset = write_display_header(&mut payload, &header);
        self.last_cursor = self.current_cursor_position();

        let mut row_cells = std::mem::take(&mut self.row_cells_scratch);
        let mut row_digest = std::mem::take(&mut self.row_digest_scratch);
        let mut row_bytes = std::mem::take(&mut self.row_bytes_scratch);
        if row_cells.len() != cols {
            row_cells.resize(cols, CellRepr::BLANK);
        }
        let mut encoded_rows = 0usize;
        for request in rows_to_send {
            let row_index = usize::from(request.row);
            if row_index >= rows {
                continue;
            }
            fill_visible_row(
                &self.term,
                &self.links,
                &self.graphics,
                row_index,
                cols,
                &mut row_cells,
                &mut row_digest,
            );
            let baseline_offset = row_index.saturating_mul(cols);
            let baseline_row = &baseline_cells[baseline_offset..baseline_offset + cols];
            let range = if request.force_full {
                Some((0, cols.saturating_sub(1)))
            } else {
                changed_cell_range(baseline_row, &row_cells)
            };
            let Some((left, right)) = range else {
                continue;
            };
            encode_display_row(
                &mut payload,
                clamp_usize_to_u16(row_index),
                clamp_usize_to_u16(left),
                &row_cells[left..=right],
                &mut row_bytes,
                self.graphics.row(row_index),
            );
            encoded_rows += 1;
        }
        self.row_cells_scratch = row_cells;
        self.row_digest_scratch = row_digest;
        self.row_bytes_scratch = row_bytes;
        patch_display_row_count(&mut payload, row_count_offset, encoded_rows);
        self.last_encoded_row_count = clamp_usize_to_u16(encoded_rows);
        (payload, self.last_encoded_row_count)
    }

    /// Encode only the current terminal header into a retained display buffer.
    ///
    /// A causal input acknowledgement or cursor/mode change can require a
    /// delta when no row cells changed. Such a frame has no baseline to read;
    /// keeping this path explicit avoids manufacturing a flattened grid solely
    /// to satisfy the row-bearing encoder's shape check.
    pub fn encode_header_only_delta_into(
        &mut self,
        mut payload: Vec<u8>,
        closure_digest: u64,
        echo_horizon: u32,
    ) -> Vec<u8> {
        let mut header = self.display_header(FrameKind::Delta, 0);
        header.closure_digest = closure_digest;
        header.echo_horizon = echo_horizon;
        write_display_header(&mut payload, &header);
        self.last_cursor = self.current_cursor_position();
        self.last_encoded_row_count = 0;
        payload
    }

    #[cfg(test)]
    pub fn estimate_row_delta_size(
        &mut self,
        baseline_cells: &[CellRepr],
        request: DisplayRowRequest,
    ) -> usize {
        let cols = usize::from(self.cols);
        let row_index = usize::from(request.row);
        if row_index >= usize::from(self.rows) {
            return 0;
        }
        let baseline_offset = row_index.saturating_mul(cols);
        if baseline_offset + cols > baseline_cells.len() {
            return 0;
        }
        let mut row_cells = std::mem::take(&mut self.row_cells_scratch);
        let mut row_digest = std::mem::take(&mut self.row_digest_scratch);
        if row_cells.len() != cols {
            row_cells.resize(cols, CellRepr::BLANK);
        }
        fill_visible_row(
            &self.term,
            &self.links,
            &self.graphics,
            row_index,
            cols,
            &mut row_cells,
            &mut row_digest,
        );
        let baseline_row = &baseline_cells[baseline_offset..baseline_offset + cols];
        let size = if request.force_full {
            ROW_PREFIX_BYTES + encoded_cells_size(&row_cells)
        } else {
            match changed_cell_range(baseline_row, &row_cells) {
                Some((left, right)) => {
                    ROW_PREFIX_BYTES + encoded_cells_size(&row_cells[left..=right])
                }
                None => 0,
            }
        };
        self.row_cells_scratch = row_cells;
        self.row_digest_scratch = row_digest;
        size
    }

    /// How many visible rows carry the wrap flag.
    ///
    /// Non-vacuity control for the reflow oracle: a screen with no wrapped rows
    /// reflows to itself, and would let the oracle pass while proving nothing.
    #[cfg(test)]
    pub fn wrapped_row_count(&self) -> usize {
        let grid = self.term.grid();
        (0..usize::from(self.rows))
            .filter(|row| grid[Line(*row as i32)].last().is_some_and(cell_wraps))
            .count()
    }

    pub fn clear_dirty(&mut self) {
        self.dirty_rows.clear();
        self.display_metadata_dirty = false;
    }

    #[cfg(test)]
    fn dirty_row_flags(&self) -> Vec<bool> {
        let mut flags = vec![false; self.dirty_rows.rows];
        for row in self.dirty_rows.iter() {
            flags[row] = true;
        }
        flags
    }

    pub fn has_dirty(&self) -> bool {
        self.pending_display_damage().any
    }

    /// Classify pending cell damage in one bounded, allocation-free traversal.
    ///
    /// This replaces two independent `any()` walks in the scheduler and, more
    /// importantly, distinguishes the only row-bearing update allowed to take
    /// the zero-delay input-feedback arm. The scan exits as soon as coherence
    /// is certain.
    pub fn pending_display_damage(&self) -> PendingDisplayDamage {
        let cursor_row = self.current_cursor_row();
        let rows = match self.dirty_rows.census() {
            DirtyCensus::Clean => PendingRowDamage::None,
            DirtyCensus::One(row) if cursor_row.is_some_and(|cursor| usize::from(cursor) == row) => {
                PendingRowDamage::CursorOnly
            }
            DirtyCensus::One(_) | DirtyCensus::Many => PendingRowDamage::Coherent,
        };
        PendingDisplayDamage {
            any: self.display_metadata_dirty || rows != PendingRowDamage::None,
            rows,
            cursor_row,
            completed_sync_update_epoch: self.completed_sync_update_epoch(),
        }
    }

    #[cfg(test)]
    pub fn mark_all_dirty(&mut self) {
        self.dirty_rows.mark_all();
    }

    #[inline]
    fn bump_display_revision(&mut self) {
        self.display_revision = self.display_revision.saturating_add(1);
    }

    fn record_damage(&mut self) {
        debug_assert_eq!(self.term.grid().screen_lines(), self.dirty_rows.rows);
        // Disjoint fields: the damage iterator borrows the terminal while its
        // rows go straight into the bitset, with no staging copy.
        match self.term.damage() {
            TermDamage::Full => self.dirty_rows.mark_all(),
            TermDamage::Partial(lines) => {
                for line in lines {
                    self.dirty_rows.mark(line.line);
                }
            }
        }
        let current_cursor = self.current_cursor_position();
        if let Some((line, _)) = self.last_cursor {
            self.dirty_rows.mark(line);
        }
        if let Some((line, _)) = current_cursor {
            self.dirty_rows.mark(line);
        }
        self.last_cursor = current_cursor;
        self.term.reset_damage();
    }

    pub fn current_cursor_position(&self) -> Option<(usize, usize)> {
        let renderable = self.term.renderable_content();
        point_to_viewport(renderable.display_offset, renderable.cursor.point)
            .map(|point| (point.line, point.column.0))
    }

    fn display_header(&self, kind: FrameKind, row_count: usize) -> FrameHeader {
        self.display_header_and_cursor_row(kind, row_count).0
    }

    fn display_header_and_cursor_row(
        &self,
        kind: FrameKind,
        row_count: usize,
    ) -> (FrameHeader, Option<u16>) {
        let grid = self.term.grid();
        let renderable = self.term.renderable_content();
        let cursor = point_to_viewport(renderable.display_offset, renderable.cursor.point);
        let cursor_shape = encode_cursor_shape(renderable.cursor.shape);
        let cursor_visible =
            u8::from(cursor.is_some() && !matches!(renderable.cursor.shape, CursorShape::Hidden));
        let (cursor_col, cursor_row) = match cursor {
            Some(point) => (
                clamp_usize_to_u16(point.column.0),
                clamp_usize_to_u16(point.line),
            ),
            None => (0, 0),
        };
        let header = FrameHeader {
            memory_only: self.graphics.memory_only,
            kind,
            cols: clamp_usize_to_u16(grid.columns()),
            rows: clamp_usize_to_u16(grid.screen_lines()),
            cursor_col,
            cursor_row,
            cursor_shape,
            cursor_visible,
            mode_flags: encode_terminal_mode(*self.term.mode())
                | if self.prediction_safe && cursor_visible != 0 {
                    DISPLAY_MODE_PREDICTION_SAFE
                } else {
                    0
                },
            row_count: clamp_usize_to_u16(row_count),
            frame_id: 0,
            presentation_id: 0,
            row_predecessor_presentation_id: 0,
            presentation_member_index: 0,
            presentation_member_count: 0,
            presentation_coherent: false,
            presentation_end: false,
            chunk_index: 0,
            chunk_count: 1,
            demand_serial: 0,
            demand_limited: false,
            demand_prompt: false,
            demand_awaits_grant: false,
            closure_digest: 0,
            // Wrapping on the wire: a viewer reads only the difference.
            scroll_serial: grid.screen_scrolls() as u32,
            // A peer's, stamped by whoever captures for that peer.
            echo_horizon: 0,
        };
        (header, cursor.map(|point| clamp_usize_to_u16(point.line)))
    }
}

/// Materialize one visible row as transport cells AND as the exact digest byte
/// stream `row_hash` consumes, in a single traversal, returning the row hash.
///
/// The three used to be three passes over the same cells: read the grid into
/// `CellRepr`, re-read those 16-byte structs to pack an 11-byte-per-cell digest,
/// then hash it. The middle pass is pure re-reading — the packing can happen at
/// the moment each cell is converted, while it is still in a register.
///
/// This is the single place the daemon materializes a row, so it stays the
/// single place the wrap bit is applied consistently to hashing, diffing, and
/// encoding.
fn fill_visible_row(
    term: &Term<EventForwarder>,
    links: &Mutex<LinkTable>,
    graphics: &graphics::Graphics,
    row_index: usize,
    cols: usize,
    out: &mut Vec<CellRepr>,
    digest: &mut Vec<u8>,
) -> u64 {
    if out.len() != cols {
        out.resize(cols, CellRepr::BLANK);
    }
    fill_visible_cells(term, links, graphics, row_index, out, digest)
}

fn fill_visible_cells(
    term: &Term<EventForwarder>,
    links: &Mutex<LinkTable>,
    graphics: &graphics::Graphics,
    row_index: usize,
    out: &mut [CellRepr],
    digest: &mut Vec<u8>,
) -> u64 {
    let cols = out.len();
    let digest_len = cols.saturating_mul(CELL_DIGEST_BYTES);
    // Exactly the cell stream: a linked row's previous capture may have left
    // its link suffix on the end, and the wrap patch below reads the last byte.
    if digest.len() != digest_len {
        digest.resize(digest_len, 0);
    }
    let grid = term.grid();
    let line = Line(row_index as i32);
    let row = &grid[line];
    let mut fg_cache = None;
    let mut bg_cache = None;
    // Cells of one OSC 8 region share an allocation, so a run of linked cells
    // resolves its id once. The table is locked only when a row holds a link.
    let mut link_cache: Option<(usize, u32)> = None;
    let mut link_table: Option<MutexGuard<'_, LinkTable>> = None;
    let mut row_links = false;
    for ((target, packed), cell) in out
        .iter_mut()
        .zip(digest.chunks_exact_mut(CELL_DIGEST_BYTES))
        .zip(row)
        .take(cols)
    {
        let fg = resolve_cached_color(cell.fg, &mut fg_cache);
        let bg = resolve_cached_color(cell.bg, &mut bg_cache);
        let mut repr = CellRepr::from_alacritty_with_colors(cell, fg, bg);
        if let Some(link) = cell.hyperlink_ref() {
            let allocation = link.allocation();
            repr.link = match link_cache {
                Some((cached, id)) if cached == allocation => id,
                _ => {
                    let table = link_table.get_or_insert_with(|| {
                        links.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
                    });
                    let id = table.intern(link);
                    link_cache = Some((allocation, id));
                    id
                }
            };
            row_links |= repr.link != 0;
        }
        pack_cell_digest(&repr, packed);
        *target = repr;
    }
    drop(link_table);
    // The wrap bit is row-scoped and lives on the final cell, so it cannot be
    // known until the row ends. `from_alacritty_with_colors` leaves it clear,
    // which is what makes ORing it into the already-packed final flags byte
    // exact — and cheaper than re-walking the row to repack it.
    if let (Some(target), Some(cell)) = (out.last_mut(), row.last()) {
        let wraps = cell_wraps(cell);
        target.set_wrapped(wraps);
        if wraps && let Some(flags) = digest.last_mut() {
            *flags |= CELL_DIGEST_WRAPPED_BIT;
        }
    }
    if row_links {
        append_link_digest(digest, out.iter().map(|cell| cell.link));
    }
    append_graphics_digest(digest, graphics.row(row_index).digest());
    row_hash_packed(digest)
}

#[inline]
fn resolve_cached_color(color: Color, cache: &mut Option<(Color, [u8; 3])>) -> [u8; 3] {
    if let Some((cached_color, resolved)) = cache.as_ref()
        && *cached_color == color
    {
        return *resolved;
    }
    let resolved = resolve_color(color);
    *cache = Some((color, resolved));
    resolved
}

fn write_display_header(out: &mut Vec<u8>, header: &FrameHeader) -> usize {
    out.clear();
    out.resize(STREAM_HEADER_BYTES, 0);
    out.push(VERSION);
    let mut patch_flags = header.kind.patch_flags();
    if header.presentation_coherent {
        patch_flags |= merkur_codec::PATCH_FLAG_PRESENTATION_COHERENT;
    }
    if header.presentation_end {
        patch_flags |= merkur_codec::PATCH_FLAG_PRESENTATION_END;
    }
    if header.memory_only {
        patch_flags |= merkur_codec::PATCH_FLAG_MEMORY_ONLY;
    }
    if header.demand_limited {
        patch_flags |= merkur_codec::PATCH_FLAG_DEMAND_LIMITED;
    }
    if header.demand_prompt {
        patch_flags |= merkur_codec::PATCH_FLAG_DEMAND_PROMPT;
    }
    if header.demand_awaits_grant {
        patch_flags |= merkur_codec::PATCH_FLAG_DEMAND_AWAITS_GRANT;
    }
    out.push(patch_flags);
    out.extend_from_slice(&header.cols.to_be_bytes());
    out.extend_from_slice(&header.rows.to_be_bytes());
    out.extend_from_slice(&header.cursor_col.to_be_bytes());
    out.extend_from_slice(&header.cursor_row.to_be_bytes());
    out.push((header.cursor_shape & 0x0f) | ((header.cursor_visible & 0x01) << 4));
    out.extend_from_slice(&header.mode_flags.to_be_bytes());
    out.extend_from_slice(&header.frame_id.to_be_bytes());
    out.extend_from_slice(&header.presentation_id.to_be_bytes());
    out.extend_from_slice(&header.chunk_index.to_be_bytes());
    out.extend_from_slice(&header.chunk_count.to_be_bytes());
    let row_count_offset = out.len();
    out.extend_from_slice(&header.row_count.to_be_bytes());
    out.extend_from_slice(&header.presentation_member_index.to_be_bytes());
    out.extend_from_slice(&header.presentation_member_count.to_be_bytes());
    out.extend_from_slice(&header.row_predecessor_presentation_id.to_be_bytes());
    out.extend_from_slice(&header.demand_serial.to_be_bytes());
    out.extend_from_slice(&header.closure_digest.to_be_bytes());
    out.extend_from_slice(&header.scroll_serial.to_be_bytes());
    out.extend_from_slice(&header.echo_horizon.to_be_bytes());
    debug_assert_eq!(
        out.len(),
        STREAM_HEADER_BYTES + merkur_codec::FRAME_HEADER_BODY_BYTES
    );
    row_count_offset
}

fn patch_display_row_count(out: &mut [u8], offset: usize, row_count: usize) {
    let count = clamp_usize_to_u16(row_count).to_be_bytes();
    out[offset] = count[0];
    out[offset + 1] = count[1];
}

fn encode_display_row(
    out: &mut Vec<u8>,
    row_index: u16,
    left: u16,
    cells: &[CellRepr],
    row_bytes: &mut Vec<u8>,
    graphics: &PreparedGraphics,
) {
    row_bytes.clear();
    encode_cells(row_bytes, cells);
    out.reserve(8 + row_bytes.len() + graphics.bytes().len());
    out.extend_from_slice(&row_index.to_be_bytes());
    // Through `row_left_field` for the same reason as the count below: the
    // column shares its field with the row's link-table flag.
    let left = row_left_field(left, cells)
        | if graphics.is_empty() {
            0
        } else {
            ROW_FLAG_GRAPHICS
        };
    out.extend_from_slice(&left.to_be_bytes());
    // Through `row_cell_count_field`, not `cells.len()`: the count shares its
    // field with the row's wrap bit, and this encoder writes the row prefix by
    // hand rather than through `encode_frame_into`.
    out.extend_from_slice(&row_cell_count_field(cells).to_be_bytes());
    out.extend_from_slice(&(row_bytes.len() as u16).to_be_bytes());
    out.extend_from_slice(row_bytes);
    out.extend_from_slice(graphics.bytes());
}

#[cfg(test)]
fn changed_cell_range(previous: &[CellRepr], current: &[CellRepr]) -> Option<(usize, usize)> {
    if previous.len() != current.len() {
        return None;
    }
    let left = previous
        .iter()
        .zip(current.iter())
        .position(|(p, c)| p != c)?;
    let right_from_end = previous
        .iter()
        .rev()
        .zip(current.iter().rev())
        .position(|(p, c)| p != c)
        .unwrap_or(0);
    Some((left, current.len().saturating_sub(1 + right_from_end)))
}

/// The display header's mode word: the routing decisions the browser acts on,
/// made here from the terminal's own modes so the browser never recombines
/// raw xterm modes. They only gate what the browser sends; the input encoder
/// reads the real modes again for every record, so a word one frame stale can
/// cost a record that encodes to nothing, never a wrong byte.
fn encode_terminal_mode(mode: TermMode) -> u16 {
    let mut encoded = 0u16;
    if mode.intersects(TermMode::MOUSE_MODE) {
        encoded |= DISPLAY_MODE_POINTER_CLICKS;
    }
    if mode.intersects(TermMode::MOUSE_DRAG | TermMode::MOUSE_MOTION) {
        encoded |= DISPLAY_MODE_POINTER_DRAG;
    }
    if mode.contains(TermMode::MOUSE_MOTION) {
        encoded |= DISPLAY_MODE_POINTER_HOVER;
    }
    if mode.intersects(TermMode::MOUSE_MODE)
        || mode.contains(TermMode::ALT_SCREEN | TermMode::ALTERNATE_SCROLL)
    {
        encoded |= DISPLAY_MODE_WHEEL;
    }
    if mode.contains(TermMode::ALT_SCREEN) {
        encoded |= DISPLAY_MODE_ALT_SCREEN;
    }
    if mode.contains(TermMode::REPORT_EVENT_TYPES) {
        encoded |= DISPLAY_MODE_KEY_RELEASES;
    }
    if mode.contains(TermMode::REPORT_ALL_KEYS_AS_ESC) {
        encoded |= DISPLAY_MODE_MODIFIER_KEYS;
    }
    if mode.contains(TermMode::FOCUS_IN_OUT) {
        encoded |= DISPLAY_MODE_FOCUS;
    }
    encoded
}

fn encode_cursor_shape(shape: CursorShape) -> u8 {
    match shape {
        CursorShape::Hidden => CURSOR_SHAPE_HIDDEN,
        CursorShape::Beam => CURSOR_SHAPE_BEAM,
        CursorShape::Underline => CURSOR_SHAPE_UNDERLINE,
        CursorShape::Block | CursorShape::HollowBlock => CURSOR_SHAPE_BLOCK,
    }
}

fn clamp_usize_to_u16(value: usize) -> u16 {
    u16::try_from(value).unwrap_or(u16::MAX)
}

#[cfg(test)]
mod tests {
    #[test]
    fn graphics_capture_snapshot_hashes_match_the_receiver_and_captures_hold_no_charge() {
        use merkur_graphics::budget::{Budget, Usage};
        use merkur_graphics::geometry::{CELL_UNIT, RowSlice};
        use merkur_graphics::projection::{Fragment, Stack};
        use merkur_graphics::source::SourceManifest;

        let budget = Budget::new(Usage {
            bytes: 4096,
            objects: 4,
        });
        let pixels = merkur_graphics::processing::Pixels::new(
            1,
            1,
            vec![20, 40, 60, 255].into_boxed_slice(),
        )
        .unwrap();
        let source = SourceManifest::from_pixels(&pixels);
        let fragment = Fragment {
            content: source.content(),
            stack: Stack {
                z: -1,
                image_id: 1,
                placement: 1,
            },
            slice: RowSlice {
                left: CELL_UNIT,
                right: 2 * CELL_UNIT,
                top: 0,
                bottom: CELL_UNIT,
                source_left: 0,
                source_right: CELL_UNIT,
                source_top: 0,
                source_bottom: CELL_UNIT,
            },
        };
        // `charge` stands in for the projector's own lease on the row.
        let (prepared, charge) =
            PreparedGraphics::new(&budget, 8, &[fragment], &mut Default::default()).unwrap();
        let (event_tx, _event_rx) = crossbeam_channel::unbounded();
        let mut terminal = TerminalState::new(8, 2, event_tx);
        terminal.apply_bytes(b"hello");
        terminal.graphics.projected.push(prepared);
        terminal.graphics.memory_only = true;
        let mut scratch = RowCaptureScratch::default();
        let captured = terminal.capture_row(0, &mut scratch);
        let mut grid = Vec::new();
        let mut hashes = Vec::new();
        let mut graphics = Vec::new();
        let (mut frame, _) =
            terminal.encode_snapshot_state_into(Vec::new(), &mut grid, &mut hashes, &mut graphics);
        assert_eq!(hashes[0], captured.hash);
        assert_eq!(graphics[0], captured.graphics.version());
        crate::display::encoder::patch_stream_header(
            &mut frame, 1, 1, 0, 1, 1, false, true, 0, 1, 0, 0,
        )
        .unwrap();
        let mut receiver = term_wasm::Terminal::new_headless(8, 2);
        assert!(receiver.apply_delta_seq(&frame, 1));
        assert_eq!(receiver.row_hash(0), captured.hash);
        let mut recomputed = Vec::new();
        terminal.current_row_hashes_into(&mut recomputed);
        assert_eq!(recomputed, hashes);
        let mut captures = Vec::new();
        terminal.update_hashes_for_dirty_rows(&mut Vec::new(), &mut captures);
        assert_eq!(captures[0].hash, captured.hash);
        assert_eq!(captures[0].graphics.version(), captured.graphics.version());
        // The owner supersedes its row: the charge returns at once, while the
        // captures still read the bytes they were sent with.
        terminal.graphics.projected.clear();
        drop(charge);
        let removed = terminal.capture_row(0, &mut scratch);
        assert!(removed.graphics.is_empty());
        assert_ne!(removed.hash, captured.hash);
        assert!(!captured.graphics.is_empty());
        assert!(captures[0].graphics.same(&captured.graphics));
        assert_eq!(
            budget.used(),
            Some(Usage {
                bytes: 0,
                objects: 0
            })
        );
        drop((captured, graphics, captures));
    }

    #[test]
    fn the_mode_word_carries_routing_decisions_not_xterm_modes() {
        const CLICKS: u16 = super::DISPLAY_MODE_POINTER_CLICKS;
        const DRAG: u16 = super::DISPLAY_MODE_POINTER_DRAG;
        const HOVER: u16 = super::DISPLAY_MODE_POINTER_HOVER;
        const WHEEL: u16 = super::DISPLAY_MODE_WHEEL;
        const ALT: u16 = super::DISPLAY_MODE_ALT_SCREEN;
        const RELEASES: u16 = super::DISPLAY_MODE_KEY_RELEASES;
        const MODIFIERS: u16 = super::DISPLAY_MODE_MODIFIER_KEYS;
        const FOCUS: u16 = super::DISPLAY_MODE_FOCUS;
        let word = |setup: &[u8]| {
            let (event_tx, _event_rx) = crossbeam_channel::unbounded();
            let mut terminal = super::TerminalState::new(8, 2, event_tx);
            terminal.apply_bytes(setup);
            super::encode_terminal_mode(*terminal.term.mode())
        };
        // A plain shell owns nothing: clicks select, the wheel does nothing.
        assert_eq!(word(b""), 0);
        // Encodings and bracketed paste are the daemon's business alone.
        assert_eq!(word(b"\x1b[?1006h\x1b[?1005h\x1b[?2004h"), 0);
        assert_eq!(word(b"\x1b[?1000h"), CLICKS | WHEEL);
        assert_eq!(word(b"\x1b[?1002h"), CLICKS | DRAG | WHEEL);
        assert_eq!(word(b"\x1b[?1003h"), CLICKS | DRAG | HOVER | WHEEL);
        // Alternate scroll is on by default, so a full-screen program without
        // mouse tracking still takes the wheel, as cursor keys.
        assert_eq!(word(b"\x1b[?1049h"), ALT | WHEEL);
        assert_eq!(word(b"\x1b[?1049h\x1b[?1007l"), ALT);
        // Input nothing waits on is worth a datagram only once it encodes.
        assert_eq!(word(b"\x1b[>1u"), 0);
        assert_eq!(word(b"\x1b[>2u"), RELEASES);
        assert_eq!(word(b"\x1b[>8u"), MODIFIERS);
        assert_eq!(word(b"\x1b[>31u"), RELEASES | MODIFIERS);
        assert_eq!(word(b"\x1b[>31u\x1b[<u"), 0);
        assert_eq!(word(b"\x1b[?1004h"), FOCUS);
    }

    #[test]
    fn capture_storage_reuses_released_rows_without_mutating_retained_versions() {
        let (event_tx, _event_rx) = crossbeam_channel::unbounded();
        let mut terminal = TerminalState::new(8, 2, event_tx);
        let mut scratch = RowCaptureScratch::default();
        terminal.apply_bytes(b"first");
        let first = terminal.capture_row(0, &mut scratch);
        let first_cells = first.cells.to_vec();
        let first_hash = first.hash;
        terminal.apply_bytes(b"\rsecond");
        let second = terminal.capture_row(0, &mut scratch);
        let second_cells = second.cells.to_vec();
        let second_ptr = Arc::as_ptr(&second.cells);
        // A weak observer also prevents mutable reuse.
        let weak = Arc::downgrade(&second.cells);
        drop(second);
        terminal.apply_bytes(b"\rthird");
        let third = terminal.capture_row(0, &mut scratch);
        assert_ne!(Arc::as_ptr(&third.cells), second_ptr);
        assert_eq!(&*weak.upgrade().unwrap(), second_cells.as_slice());
        drop(weak);
        drop(third);
        crate::edge_tunnel::test_allocations::begin_thread();
        let reused = terminal.capture_row(0, &mut scratch);
        let tally = crate::edge_tunnel::test_allocations::end_thread();
        assert_eq!(tally.allocations, 0);
        assert_eq!(&*first.cells, first_cells.as_slice());
        assert_eq!(first.hash, first_hash);
        let mut reference = RowCaptureScratch::default();
        assert_eq!(reused.hash, terminal.read_row_cells(0, &mut reference));
        assert_eq!(&*reused.cells, reference.cells.as_slice());
        terminal.resize(4, 1);
        let resized = terminal.capture_row(0, &mut scratch);
        assert_eq!(resized.cells.len(), 4);
        assert_eq!(scratch.captures.rows.len(), 1);
        assert_eq!(&*first.cells, first_cells.as_slice());
    }

    #[test]
    fn dirty_captures_allocate_nothing_after_both_grid_versions_are_warm() {
        let (event_tx, _event_rx) = crossbeam_channel::unbounded();
        let mut terminal = TerminalState::new(384, 256, event_tx);
        let mut hashes = Vec::new();
        let mut captures = Vec::new();
        let mut retained = Vec::new();
        for _ in 0..3 {
            terminal.mark_all_dirty();
            terminal.update_hashes_for_dirty_rows(&mut hashes, &mut captures);
            retained.clone_from(&captures);
        }
        terminal.mark_all_dirty();
        crate::edge_tunnel::test_allocations::begin_thread();
        terminal.update_hashes_for_dirty_rows(&mut hashes, &mut captures);
        let tally = crate::edge_tunnel::test_allocations::end_thread();
        assert_eq!(tally.allocations, 0);
        assert_eq!(captures.len(), 256);
        for (current, previous) in captures.iter().zip(&retained) {
            assert!(!Arc::ptr_eq(&current.cells, &previous.cells));
            assert_eq!(current.hash, previous.hash);
        }
    }

    /// Every scrolling PTY read reports full damage, so recording damage sits
    /// on the per-read path and must never allocate, full or partial.
    #[test]
    fn damage_recording_allocates_nothing() {
        let (event_tx, _event_rx) = crossbeam_channel::unbounded();
        let mut terminal = TerminalState::new(120, 40, event_tx);
        terminal.apply_bytes(b"warm\x1b[?1049h\x1b[?1049l");
        terminal.clear_dirty();

        terminal.parser.advance(&mut terminal.term, b"\x1b[?1049h");
        assert!(matches!(terminal.term.damage(), TermDamage::Full));
        crate::edge_tunnel::test_allocations::begin_thread();
        terminal.record_damage();
        let full = crate::edge_tunnel::test_allocations::end_thread();
        assert_eq!(full.allocations, 0);
        assert_eq!(terminal.dirty_row_flags(), vec![true; 40]);

        terminal.clear_dirty();
        terminal.parser.advance(&mut terminal.term, b"\x1b[5;3Hxy\x1b[9;1H");
        crate::edge_tunnel::test_allocations::begin_thread();
        terminal.record_damage();
        terminal.mark_all_dirty();
        terminal.clear_dirty();
        let partial = crate::edge_tunnel::test_allocations::end_thread();
        assert_eq!(partial.allocations, 0);
    }

    #[test]
    fn partial_damage_marks_written_and_cursor_rows_only() {
        let (event_tx, _event_rx) = crossbeam_channel::unbounded();
        let mut terminal = TerminalState::new(120, 40, event_tx);
        terminal.apply_bytes(b"\x1b[H");
        terminal.clear_dirty();
        terminal.apply_bytes(b"\x1b[5;3Hxy\x1b[9;1H");
        let dirty: Vec<usize> = terminal.dirty_rows.iter().collect();
        assert_eq!(dirty, vec![0, 4, 8]);
    }

    #[test]
    fn dirty_rows_never_report_a_row_past_the_viewport() {
        let mut dirty = DirtyRows::all(65);
        assert_eq!(dirty.words.len(), 2);
        assert_eq!(dirty.iter().collect::<Vec<_>>(), (0..65).collect::<Vec<_>>());
        assert_eq!(dirty.census(), DirtyCensus::Many);

        dirty.clear();
        assert_eq!(dirty.census(), DirtyCensus::Clean);
        assert_eq!(dirty.iter().next(), None);
        dirty.mark(200);
        assert_eq!(dirty.census(), DirtyCensus::One(64));
        dirty.mark(3);
        assert_eq!(dirty.census(), DirtyCensus::Many);
        assert_eq!(dirty.iter().collect::<Vec<_>>(), vec![3, 64]);

        dirty.resize_all(64);
        assert_eq!(dirty.words, vec![u64::MAX]);
        dirty.resize_all(130);
        assert_eq!(dirty.iter().collect::<Vec<_>>(), (0..130).collect::<Vec<_>>());
        dirty.resize_all(1);
        assert_eq!(dirty.words, vec![1]);
        assert_eq!(dirty.census(), DirtyCensus::One(0));
    }

    /// Isolated VT parser throughput. `min` over many repetitions, because the
    /// machine this runs on is not quiet and the minimum is the sample least
    /// contaminated by other load.
    #[test]
    #[ignore = "production performance workload"]
    fn vte_advance_benchmark() {
        use std::time::Instant;
        const COLS: u16 = 120;
        const ROWS: u16 = 40;

        let mut ascii = Vec::new();
        for row in 0..ROWS {
            ascii.extend_from_slice(format!("\x1b[{};1H", row + 1).as_bytes());
            for col in 0..COLS {
                ascii.push(b' ' + ((row as u8).wrapping_add(col as u8)) % 95);
            }
        }
        let mut wide = Vec::new();
        for row in 0..ROWS {
            wide.extend_from_slice(format!("\x1b[{};1H", row + 1).as_bytes());
            for col in 0..COLS / 2 {
                let ch = char::from_u32(0x4e00 + u32::from(col)).unwrap_or('a');
                let mut buf = [0u8; 4];
                wide.extend_from_slice(ch.encode_utf8(&mut buf).as_bytes());
            }
        }

        for (label, fixture) in [("ascii", &ascii), ("cjk", &wide)] {
            let (event_tx, _event_rx) = crossbeam_channel::unbounded();
            let mut terminal = TerminalState::new(COLS, ROWS, event_tx);
            let mut best = f64::MAX;
            for _ in 0..2_000 {
                let started = Instant::now();
                terminal.parser.advance(&mut terminal.term, fixture);
                best = best.min(started.elapsed().as_secs_f64() * 1e6);
            }
            println!(
                "@@vte {label}: min={best:.2} us ({:.2} ns/byte, {} bytes)",
                best * 1000.0 / fixture.len() as f64,
                fixture.len()
            );
        }
    }

    /// The same damage invariant under a deterministic pseudo-random stream of
    /// escape sequences and text, which is the evidence that actually justifies
    /// deleting the redundant full-repaint scan: a fixed list of sequences only
    /// proves the cases someone thought to list.
    #[test]
    fn damage_covers_every_changed_row_under_randomized_sequences() {
        const COLS: u16 = 24;
        const ROWS: u16 = 8;

        let fragments: [&[u8]; 20] = [
            b"\x0c",
            b"\x1b[J",
            b"\x1b[0J",
            b"\x1b[1J",
            b"\x1b[2J",
            b"\x1b[3J",
            b"\x1b[?2J",
            b"\x1bc",
            b"\x1b[?1049h",
            b"\x1b[?1049l",
            b"\x1b[K",
            b"\x1b[2K",
            b"\x1b[L",
            b"\x1b[M",
            b"\x1b[S",
            b"\x1b[T",
            b"\n",
            b"\r",
            b"\x08",
            b"hello world",
        ];

        let (event_tx, _event_rx) = crossbeam_channel::unbounded();
        let mut terminal = TerminalState::new(COLS, ROWS, event_tx);
        let mut before = Vec::new();
        let mut after = Vec::new();
        let mut state = 0x1234_5678u32;
        let mut next = move || {
            state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            (state >> 16) as usize
        };

        let mut chunk = Vec::new();
        for step in 0..4_000 {
            chunk.clear();
            // Between one and four fragments per read, so sequences also get
            // split across reads the way a real PTY delivers them.
            for _ in 0..=(next() % 4) {
                let fragment = fragments[next() % fragments.len()];
                chunk.extend_from_slice(fragment);
                if next() % 3 == 0 {
                    let row = next() % usize::from(ROWS) + 1;
                    let col = next() % usize::from(COLS) + 1;
                    chunk.extend_from_slice(format!("\x1b[{row};{col}H").as_bytes());
                }
            }

            terminal.current_row_hashes_into(&mut before);
            terminal.clear_dirty();
            terminal.apply_bytes(&chunk);
            let dirty = terminal.dirty_row_flags();
            terminal.current_row_hashes_into(&mut after);

            for row in 0..usize::from(ROWS) {
                if before[row] != after[row] {
                    assert!(
                        dirty.get(row).copied().unwrap_or(false),
                        "step {step}: row {row} changed but was not marked dirty; chunk={:?}",
                        String::from_utf8_lossy(&chunk),
                    );
                }
            }
        }
    }

    /// The display's core damage invariant: every row whose content actually
    /// changed must be marked dirty, or the browser keeps a stale row forever.
    ///
    /// This exists because `apply_bytes` used to scan every PTY read for a form
    /// feed or a CSI erase-display and force a full repaint on top of whatever
    /// the emulator reported. That scan is redundant if — and only if — the
    /// emulator's own damage already covers every changed row for those
    /// sequences. Rather than trust a reading of the emulator, this drives the
    /// production path and compares changed rows against dirty rows directly.
    #[test]
    fn damage_covers_every_changed_row_for_screen_clearing_sequences() {
        const COLS: u16 = 40;
        const ROWS: u16 = 12;

        // Sequences that repaint or scroll the screen wholesale, plus the two
        // the removed scan looked for specifically.
        let cases: [(&str, &[u8]); 12] = [
            ("form feed", b"\x0c"),
            ("erase display default", b"\x1b[J"),
            ("erase below", b"\x1b[0J"),
            ("erase above", b"\x1b[1J"),
            ("erase all", b"\x1b[2J"),
            ("erase all with private param", b"\x1b[?2J"),
            ("erase scrollback", b"\x1b[3J"),
            ("home then erase all", b"\x1b[H\x1b[2J"),
            ("reset to initial state", b"\x1bc"),
            ("alt screen enter", b"\x1b[?1049h"),
            ("alt screen exit", b"\x1b[?1049l"),
            ("scroll by newlines", b"\n\n\n\n\n\n"),
        ];

        for (label, sequence) in cases {
            let (event_tx, _event_rx) = crossbeam_channel::unbounded();
            let mut terminal = TerminalState::new(COLS, ROWS, event_tx);
            // Distinct content per row, and leave the lower half blank so the
            // "row was already blank" case is covered too.
            for row in 0..ROWS / 2 {
                terminal.apply_bytes(format!("\x1b[{};1H", row + 1).as_bytes());
                terminal.apply_bytes(format!("row {row} contents").as_bytes());
            }

            let mut before = Vec::new();
            terminal.current_row_hashes_into(&mut before);
            terminal.clear_dirty();

            terminal.apply_bytes(sequence);

            let dirty = terminal.dirty_row_flags();
            let mut after = Vec::new();
            terminal.current_row_hashes_into(&mut after);

            for row in 0..usize::from(ROWS) {
                if before[row] != after[row] {
                    assert!(
                        dirty.get(row).copied().unwrap_or(false),
                        "{label}: row {row} changed but was not marked dirty",
                    );
                }
            }
        }
    }

    /// Paired A/B for the batched printable-run write, both arms in one
    /// process.
    ///
    /// The parser hands the terminal whole runs of ground-state text. The
    /// baseline arm is what it used to do with them — `Handler::input` once per
    /// character, which is still exactly what `Handler::input_str` falls back to
    /// — and the candidate arm is the batched override. Cursor positioning runs
    /// through the real parser in both arms, so the only difference measured is
    /// how the printable bytes between escapes reach the grid.
    ///
    /// Arm order alternates per sample: the machine is not quiet, and a fixed
    /// order would let drift accumulate against whichever arm runs second.
    #[test]
    #[ignore = "production performance workload"]
    fn printable_run_write_benchmark() {
        use alacritty_terminal::vte::ansi::Handler;
        use std::time::Instant;
        const COLS: u16 = 120;
        const ROWS: u16 = 40;
        let samples = 400usize;

        // Three shapes, because the batch length is the whole mechanism.
        // Full-width rows are the repaint case the pipeline benchmark uses;
        // short runs are ordinary shell output; CJK never takes the fast path
        // at all and exists to prove the guard costs nothing measurable.
        let full_row: String = (0..COLS)
            .map(|col| char::from(b' ' + (col as u8) % 95))
            .collect();
        let short_run = "$ ".to_owned();
        let cjk: String = (0..COLS / 2)
            .map(|col| char::from_u32(0x4e00 + u32::from(col)).unwrap_or('a'))
            .collect();

        for (label, text) in [
            ("full-row", &full_row),
            ("short-run", &short_run),
            ("cjk", &cjk),
        ] {
            let (event_tx, _event_rx) = crossbeam_channel::unbounded();
            let mut terminal = TerminalState::new(COLS, ROWS, event_tx);
            let cursor_moves: Vec<Vec<u8>> = (0..ROWS)
                .map(|row| format!("\x1b[{};1H", row + 1).into_bytes())
                .collect();

            let mut per_char = Vec::with_capacity(samples);
            let mut batched = Vec::with_capacity(samples);

            for sample in 0..samples {
                let run_per_char = |terminal: &mut TerminalState| {
                    let started = Instant::now();
                    for cursor_move in &cursor_moves {
                        terminal.parser.advance(&mut terminal.term, cursor_move);
                        for c in text.chars() {
                            terminal.term.input(c);
                        }
                    }
                    started.elapsed().as_secs_f64() * 1e6
                };
                let run_batched = |terminal: &mut TerminalState| {
                    let started = Instant::now();
                    for cursor_move in &cursor_moves {
                        terminal.parser.advance(&mut terminal.term, cursor_move);
                        terminal.term.input_str(text);
                    }
                    started.elapsed().as_secs_f64() * 1e6
                };

                if sample % 2 == 0 {
                    per_char.push(run_per_char(&mut terminal));
                    batched.push(run_batched(&mut terminal));
                } else {
                    batched.push(run_batched(&mut terminal));
                    per_char.push(run_per_char(&mut terminal));
                }
            }

            per_char.sort_by(f64::total_cmp);
            batched.sort_by(f64::total_cmp);
            let baseline = per_char[per_char.len() / 2];
            let candidate = batched[batched.len() / 2];
            println!(
                "@@run {label}: per-char p50={baseline:.2} us, batched p50={candidate:.2} us, \
                 delta={:+.2}% ({} chars/row x {ROWS} rows)",
                (candidate - baseline) / baseline * 100.0,
                text.chars().count(),
            );
        }
    }

    /// Stage decomposition of `apply_bytes`, which is the largest single term
    /// in the display flush.
    ///
    use super::*;

    /// Assertions exercise the same VTE/Term semantics as production; there is
    /// no test-only marker parser which can agree with itself but not the grid.
    struct IntegrationProbe {
        terminal: TerminalState,
        input_active: bool,
        input_authenticated: bool,
        prompt_anchor: bool,
    }

    impl IntegrationProbe {
        fn new(token: Option<&[u8]>) -> Self {
            let (tx, _rx) = crossbeam_channel::unbounded();
            let mut terminal = TerminalState::new(80, 3, tx);
            if let Some(token) = token {
                terminal.set_shell_token(token.into());
            }
            Self {
                terminal,
                input_active: false,
                input_authenticated: false,
                prompt_anchor: false,
            }
        }

        fn observe(&mut self, bytes: &[u8]) {
            self.terminal.apply_bytes(bytes);
            self.input_active = self.terminal.shell_integration_input_active();
            self.input_authenticated = self.terminal.shell_integration_authenticated();
            self.prompt_anchor = self.terminal.editor_anchor().is_some();
        }

        fn hard_reset(&mut self) {
            self.terminal
                .observe_user_input(false, TerminalState::bytes_leave_line_editor(b"\r"));
            self.observe(b"");
        }
    }

    fn visible_row_text(terminal: &TerminalState, row: usize) -> String {
        let mut scratch = RowCaptureScratch::default();
        terminal.read_row_cells(row, &mut scratch);
        scratch
            .cells
            .iter()
            .map(|cell| char::from_u32(cell.codepoint).unwrap_or('\u{fffd}'))
            .collect::<String>()
            .trim_end_matches(['\0', ' '])
            .to_string()
    }

    #[test]
    #[ignore = "production performance workload"]
    fn applied_observer_cost_probe() {
        use std::time::Instant;

        // Compare the canonical shell evidence hook against the same parser
        // and grid with no host observer. This is parser-only overhead, not
        // a retained unsafe raw-scanner implementation or end-to-end latency.
        struct NoShellEvents(EventForwarder);
        impl EventListener for NoShellEvents {
            fn send_event(&self, event: Event) {
                self.0.send_event(event);
            }
        }
        let dimensions = TermDimensions {
            cols: 120,
            rows: 40,
        };
        let (tx, _rx) = crossbeam_channel::unbounded();
        let make_events = || EventForwarder {
            graphics: merkur_graphics::boundary::Boundary::new(
                merkur_graphics::processing::MAX_INPUT_BYTES.div_ceil(3) * 4,
            ),
            graphics_reset: false,
            viewport: None,
            event_tx: tx.clone(),
            bell_pending: Arc::new(AtomicBool::new(false)),
            shell_integration: ShellIntegrationState::default(),
            editor_anchor: None,
            editor_anchor_generation: 0,
            ignored_shell_evidence_bytes: 0,
            last_application_fresh: true,
            control_fresh: false,
            pending_prompt: None,
            pending_prompt_escape_start: false,
            open_urls: OpenUrlQueue::new(),
            ui: Mutex::new(crate::pty::terminal_ui::Effects::default()),
        };
        let mut dense = Vec::new();
        let mut styled = Vec::new();
        for row in 1..=40 {
            dense.extend_from_slice(format!("\x1b[{row};1H").as_bytes());
            dense.extend_from_slice(&[b'x'; 120]);
            styled.extend_from_slice(format!("\x1b[{row};1H").as_bytes());
            for _ in 0..20 {
                styled.extend_from_slice(b"\x1b[31mred\x1b[0mxyz");
            }
        }
        for (name, bytes) in [
            ("typing", &b"\x1b[1;1Hx"[..]),
            ("cursor", &b"\x1b[3;40H"[..]),
            ("dense", dense.as_slice()),
            ("styled", styled.as_slice()),
        ] {
            let mut current = Term::new(Config::default(), &dimensions, make_events());
            let mut reference =
                Term::new(Config::default(), &dimensions, NoShellEvents(make_events()));
            let mut current_parser: Processor = Processor::new();
            let mut reference_parser: Processor = Processor::new();
            let mut samples = [Vec::with_capacity(2000), Vec::with_capacity(2000)];
            for iteration in 0..2200 {
                // AB/BA interleave with independent persistent terminal state.
                for candidate in [iteration & 1, 1 - (iteration & 1)] {
                    let started = Instant::now();
                    if candidate == 0 {
                        reference_parser.advance(&mut reference, bytes);
                        std::hint::black_box((&reference_parser, &reference));
                    } else {
                        current_parser.advance(&mut current, bytes);
                        std::hint::black_box((&current_parser, &current));
                    }
                    let elapsed = started.elapsed().as_secs_f64() * 1_000_000.0;
                    if iteration >= 200 {
                        samples[candidate].push(elapsed);
                    }
                }
                current.reset_damage();
                reference.reset_damage();
            }
            assert_eq!(current.grid().cursor.point, reference.grid().cursor.point);
            for row in 0..40 {
                for col in 0..120 {
                    let point = Point::new(Line(row), Column(col));
                    assert_eq!(current.grid()[point], reference.grid()[point]);
                }
            }
            for (candidate, samples) in samples.iter_mut().enumerate() {
                println!("@@observer_raw workload={name} candidate={candidate} us={}",
                    serde_json::to_string(samples).expect("finite duration samples"));
                samples.sort_by(f64::total_cmp);
                let quantile = |p: f64| samples[(p * samples.len() as f64).ceil() as usize - 1];
                println!(
                    "@@observer workload={name} candidate={candidate} n={} bytes={} p50_us={:.3} p95_us={:.3} p99_us={:.3} worst_us={:.3}",
                    samples.len(),
                    bytes.len(),
                    quantile(0.5),
                    quantile(0.95),
                    quantile(0.99),
                    quantile(1.0)
                );
            }
        }
    }

    #[test]
    fn synchronized_prompt_evidence_follows_application_and_exact_cursor() {
        let prompt = b"\x1b]133;B;merkur=0123456789abcdef0123456789abcdef\x07";
        for split in 0..=prompt.len() {
            let (tx, _rx) = crossbeam_channel::unbounded();
            let mut terminal = TerminalState::new(40, 3, tx);
            terminal.set_shell_token(TEST_TOKEN.into());
            terminal.apply_bytes(b"\x1b[?2026h\x1b[2;4Hprompt> ");
            terminal.apply_bytes(&prompt[..split]);
            terminal.apply_bytes(&prompt[split..]);
            terminal.apply_bytes(b"typed");
            assert!(!terminal.shell_integration_input_active(), "split {split}");
            assert!(!terminal.shell_integration_authenticated());
            assert_eq!(terminal.editor_anchor(), None);
            terminal.set_prediction_safe(true);
            assert!(!terminal.prediction_safe());
            terminal.apply_bytes(b"\x1b[?2026l");
            assert!(terminal.shell_integration_input_active());
            assert!(terminal.shell_integration_authenticated());
            assert_eq!(terminal.editor_anchor(), Some((1, 11)), "split {split}");
            assert_eq!(visible_row_text(&terminal, 1), "   prompt> typed");
        }
    }

    #[test]
    fn input_cannot_reopen_from_a_pre_input_buffered_prompt() {
        let prompt = b"\x1b]133;B;merkur=0123456789abcdef0123456789abcdef\x07";
        for split in 0..=prompt.len() {
            let (tx, _rx) = crossbeam_channel::unbounded();
            let mut terminal = TerminalState::new(40, 3, tx);
            terminal.set_shell_token(TEST_TOKEN.into());
            terminal.apply_bytes(b"\x1b[?2026h");
            terminal.apply_bytes(&prompt[..split]);
            terminal.observe_user_input(false, TerminalState::bytes_leave_line_editor(b"\r"));
            terminal.apply_bytes(&prompt[split..]);
            terminal.apply_bytes(b"\x1b[?2026l");
            // Only a prompt beginning entirely after the input can grant.
            assert_eq!(
                terminal.shell_integration_input_active(),
                split == 0,
                "split {split}"
            );
            if split != 0 {
                assert_eq!(terminal.editor_anchor(), None);
            }
        }
        let (tx, _rx) = crossbeam_channel::unbounded();
        let mut terminal = TerminalState::new(40, 3, tx);
        terminal.set_shell_token(TEST_TOKEN.into());
        terminal.apply_bytes(b"\x1b[?2026h");
        terminal.apply_bytes(prompt);
        terminal.observe_user_input(false, TerminalState::bytes_leave_line_editor(b"\r"));
        terminal.apply_bytes(b"\r\nnew> ");
        terminal.apply_bytes(prompt);
        terminal.apply_bytes(b"\x1b[?2026l");
        assert!(terminal.shell_integration_input_active());
        assert!(terminal.shell_integration_authenticated());
        assert_eq!(terminal.editor_anchor(), Some((1, 5)));
    }

    #[test]
    fn buffered_c1_prefix_cannot_authenticate_after_input() {
        for suffix in [&b"\x9d133;B\x07"[..], &b"\x9b?2004h"[..]] {
            let (tx, _rx) = crossbeam_channel::unbounded();
            let mut terminal = TerminalState::new(40, 3, tx);
            terminal.apply_bytes(b"\x1b[?2026h\xc2");
            terminal.observe_user_input(false, TerminalState::bytes_leave_line_editor(b"\r"));
            terminal.apply_bytes(suffix);
            terminal.apply_bytes(b"\x1b[?2026l");
            assert!(!terminal.shell_integration_input_active());
            assert_eq!(terminal.editor_anchor(), None);
            // C1 is not an OSC/CSI transition in VTE, even when wholly fresh.
            terminal.apply_bytes(b"\xc2");
            terminal.apply_bytes(suffix);
            assert!(!terminal.shell_integration_input_active());
        }
    }

    #[test]
    fn canonical_authority_changes_revoke_advertised_prediction_without_cell_damage() {
        let authenticated = b"\x1b]133;B;merkur=0123456789abcdef0123456789abcdef\x07";
        for boundary in [
            &b"\x1b]133;C\x07"[..],
            &b"\x1b[?2004l"[..],
            &b"\x1b]133;B\x07"[..],
            &b"\x1b[?2004h"[..],
            &authenticated[..],
        ] {
            let (tx, _rx) = crossbeam_channel::unbounded();
            let mut terminal = TerminalState::new(20, 3, tx);
            terminal.set_shell_token(TEST_TOKEN.into());
            terminal.apply_bytes(authenticated);
            assert!(terminal.set_prediction_safe(true));
            let mut baseline = Vec::new();
            terminal.current_grid_into(&mut baseline);
            terminal.clear_dirty();
            let previous_header = terminal.current_display_header_signal();
            terminal.apply_bytes(boundary);
            assert!(!terminal.prediction_safe(), "{boundary:?}");
            assert!(terminal.has_dirty(), "control-only revocation must wake display");
            assert_ne!(terminal.current_display_header_signal(), previous_header);
            let (payload, rows) = terminal.encode_delta_for_rows(&baseline, &[], Vec::new());
            assert_eq!(rows, 0);
            let header = merkur_codec::parse_frame_header(&payload).unwrap();
            assert_eq!(header.mode_flags & DISPLAY_MODE_PREDICTION_SAFE, 0);
            if boundary != authenticated {
                assert!(!terminal.shell_integration_authenticated());
            }
            #[cfg(unix)]
            {
                let sampled = super::super::prediction_safe_from_terminal_state(
                    libc::ECHO | libc::ICANON,
                    Some(99),
                    42,
                    terminal.shell_integration_input_active(),
                    terminal.shell_integration_authenticated(),
                );
                terminal.set_prediction_safe(sampled);
                assert_eq!(terminal.prediction_safe(), boundary == authenticated);
            }
        }
    }

    #[test]
    fn canonical_control_events_own_editor_authority() {
        for revoke in [
            &b"\x1b\x07c"[..],
            &b"\x1b[?20\x0704l"[..],
            &b"\x1b[?1;2004l"[..],
            &b"\x1b]133;\x00C\x07"[..],
            &b"\x1b\x18"[..],
            &b"\x1bPq\x1a"[..],
        ] {
            let mut probe = IntegrationProbe::new(None);
            probe.observe(b"\x1b[?2004h");
            assert!(probe.input_active);
            probe.observe(revoke);
            assert!(!probe.input_active, "{revoke:?}");
        }
        let starts: &[&[u8]] = &[b"", b"\x1b", b"\x1bPq", b"\x1bX", b"\x1b_", b"\x1b^"];
        let controls: &[&[u8]] = &[
            b"\x9d133;B\x07",
            b"\xc2\x9d133;B\x07",
            b"\x9b?2004h",
            b"\xc2\x9b?2004h",
            b"\x9d133;B;merkur=0123456789abcdef0123456789abcdef\x9c",
        ];
        for start in starts {
            for control in controls {
                for split in 0..=control.len() {
                    let mut probe = IntegrationProbe::new(Some(TEST_TOKEN));
                    probe.observe(start);
                    probe.observe(&control[..split]);
                    probe.observe(&control[split..]);
                    assert!(!probe.input_active, "{start:?}/{control:?}/{split}");
                    assert!(!probe.input_authenticated);
                    assert!(!probe.prompt_anchor);
                }
            }
        }
        for end in [
            &b"\x9c"[..],
            &b"\xc2\x9c"[..],
            &b"\x1bX"[..],
            &b"\x1b\x1b\\"[..],
        ] {
            let mut probe = IntegrationProbe::new(None);
            probe.observe(b"\x1b]133;B");
            probe.observe(end);
            assert!(!probe.input_active, "{end:?}");
            assert!(!probe.prompt_anchor);
        }
        let mut probe = IntegrationProbe::new(None);
        probe.observe(b"\x1b]133;B\x1b");
        probe
            .terminal
            .observe_user_input(false, TerminalState::bytes_leave_line_editor(b"\r"));
        probe.observe(b"\\");
        assert!(
            !probe.input_active,
            "split ST cannot revive a pre-input prompt"
        );
        probe.observe(b"\x1b]133;B\x1b\\");
        assert!(probe.input_active);
        assert!(probe.prompt_anchor);
    }

    #[test]
    fn staged_prompt_cannot_survive_cancellation_or_external_invalidation() {
        for &cancelled in b"\x18\x1a" {
            let mut probe = IntegrationProbe::new(None);
            probe.observe(b"\x1b]133;B\x07");
            assert!(probe.input_active);
            probe.observe(b"\x1b]133;B");
            probe.observe(&[cancelled]);
            probe.observe(b"\x1b\\");
            assert!(!probe.input_active);
            assert!(!probe.prompt_anchor);
        }
        for action in 0..3 {
            let mut probe = IntegrationProbe::new(None);
            if action == 2 { probe.observe(b"\x1b[?2026h"); }
            probe.observe(b"\x1b]133;B\x1b");
            match action {
                0 => {
                    probe
                        .terminal
                        .observe_user_input(false, TerminalState::bytes_leave_line_editor(b"\r"));
                }
                1 => probe.terminal.resize(81, 3),
                _ => {
                    assert!(probe.terminal.stop_synchronized_update());
                }
            }
            probe.observe(b"\\");
            assert!(!probe.input_active, "action {action}");
            assert!(!probe.prompt_anchor);
        }
    }

    #[test]
    fn unfinished_sync_withholds_existing_grant_and_applies_revocation() {
        let (tx, _rx) = crossbeam_channel::unbounded();
        let mut terminal = TerminalState::new(20, 3, tx);
        terminal.apply_bytes(b"\x1b[?2004h");
        terminal.set_prediction_safe(true);
        assert!(terminal.prediction_safe());
        terminal.apply_bytes(b"\x1b[?2026h\x1b[?2004l");
        assert!(!terminal.shell_integration_input_active());
        assert!(!terminal.prediction_safe());
        terminal.set_prediction_safe(true);
        assert!(!terminal.prediction_safe());
        terminal.apply_bytes(b"\x1b[?2026l");
        assert!(!terminal.shell_integration_input_active());
        assert!(!terminal.prediction_safe());
    }

    #[test]
    fn synchronized_update_completion_is_applied_not_merely_received() {
        let (tx, _rx) = crossbeam_channel::unbounded();
        let mut terminal = TerminalState::new(20, 3, tx);
        terminal.apply_bytes(b"\x1b[?2026hfirst\r\nsecond\x1b[?202");
        assert_eq!(terminal.completed_sync_update_epoch(), 0);
        assert_eq!(visible_row_text(&terminal, 0), "");
        assert!(terminal.synchronized_update_deadline().is_some());
        terminal.apply_bytes(b"6l");
        assert_eq!(terminal.completed_sync_update_epoch(), 1);
        assert_eq!(visible_row_text(&terminal, 0), "first");
        assert_eq!(visible_row_text(&terminal, 1), "second");
        assert!(terminal.synchronized_update_deadline().is_none());
        terminal.clear_dirty();
        assert_eq!(
            terminal
                .pending_display_damage()
                .completed_sync_update_epoch,
            1
        );
        // A later unrelated write cannot borrow the prior application's epoch.
        terminal.apply_bytes(b"!");
        assert_eq!(terminal.completed_sync_update_epoch(), 0);
        terminal.apply_bytes(b"\x1b[?2026hA\x1b[?2026l\x1b[?2026hB\x1b[?2026l");
        // VTE applies already-buffered adjacent ESUs in one parser transaction.
        assert_eq!(terminal.completed_sync_update_epoch(), 2);
        terminal.apply_bytes(b"\x1b[?2026hC\x1b[?2026l\x1b[?2026hD");
        assert_eq!(terminal.completed_sync_update_epoch(), 3);
        assert!(terminal.synchronized_update_deadline().is_some());
        assert!(visible_row_text(&terminal, 1).ends_with("!ABC"));
        assert!(!visible_row_text(&terminal, 1).contains('D'));
    }

    #[test]
    fn synchronized_update_timeout_and_overflow_release_without_editor_authority() {
        for overflow in [false, true] {
            let (tx, _rx) = crossbeam_channel::unbounded();
            let mut terminal = TerminalState::new(20, 3, tx);
            terminal.apply_bytes(b"\x1b[?2026h\x1b[?2004hhidden");
            terminal.set_prediction_safe(true);
            assert_eq!(visible_row_text(&terminal, 0), "");
            if overflow {
                // VTE's exact bounded sync buffer size; forces its internal
                // release rather than the daemon's deadline callback.
                terminal.apply_bytes(&vec![b' '; 2 * 1024 * 1024]);
            } else {
                assert!(terminal.stop_synchronized_update());
                assert_eq!(visible_row_text(&terminal, 0), "hidden");
                assert!(!terminal.stop_synchronized_update());
            }
            assert_eq!(terminal.completed_sync_update_epoch(), 0);
            assert!(!terminal.prediction_safe());
            assert!(!terminal.shell_integration_input_active());
            assert_eq!(terminal.editor_anchor(), None);
            assert!(terminal.synchronized_update_deadline().is_none());
        }
    }

    /// A viewer reads how far content moved between two captures from the
    /// difference in their scroll serials: whole-screen scrolls only.
    #[test]
    fn a_display_header_carries_the_screens_scroll_serial() {
        let (tx, _rx) = crossbeam_channel::unbounded();
        let mut terminal = TerminalState::new(20, 3, tx);
        let serial = |terminal: &TerminalState| {
            terminal
                .current_display_header(FrameKind::Delta)
                .scroll_serial
        };
        terminal.apply_bytes(b"one\r\ntwo");
        assert_eq!(serial(&terminal), 0, "nothing reached the bottom row yet");
        terminal.apply_bytes(b"\r\nthree\r\nfour\r\nfive");
        assert_eq!(serial(&terminal), 2);
        // A scroll region moves only its own rows: not counted.
        terminal.apply_bytes(b"\x1b[2;3r\x1b[3;1H\n\n\x1b[r");
        assert_eq!(serial(&terminal), 2);
    }

    #[test]
    fn a_closure_claim_names_exactly_an_explicitly_completed_frame() {
        let (tx, _rx) = crossbeam_channel::unbounded();
        let mut terminal = TerminalState::new(20, 3, tx);
        let mut hashes = Vec::new();
        let claim = |terminal: &mut TerminalState, hashes: &mut Vec<u64>| {
            terminal.current_row_hashes_into(hashes);
            let header = terminal.current_display_header(FrameKind::Delta);
            terminal.closure_digest(&header, hashes)
        };
        assert_eq!(claim(&mut terminal, &mut hashes), 0, "nothing was declared complete");
        terminal.apply_bytes(b"\x1b[?2026hfirst\r\nsecond\x1b[?2026l");
        let completed = claim(&mut terminal, &mut hashes);
        assert_ne!(completed, 0);
        // Independent of the incremental hashes: a full recompute names it too.
        let header = terminal.current_display_header(FrameKind::Delta);
        assert_eq!(
            completed,
            merkur_codec::viewport_closure_digest(
                header.cols,
                header.rows,
                header.cursor_col,
                header.cursor_row,
                header.cursor_shape,
                header.cursor_visible,
                &hashes,
            )
        );
        // Hashes that do not describe the grid claim nothing.
        assert_eq!(terminal.closure_digest(&header, &hashes[..2]), 0);
        // The same content reached through ordinary output is not a declaration.
        terminal.apply_bytes(b"!");
        assert_eq!(claim(&mut terminal, &mut hashes), 0);
        terminal.apply_bytes(b"\x1b[?2026h\x1b[?2026l");
        assert_ne!(claim(&mut terminal, &mut hashes), 0);
        // A still-buffered successor does not change the completed screen.
        let before = claim(&mut terminal, &mut hashes);
        terminal.apply_bytes(b"\x1b[?2026hhidden");
        assert_eq!(claim(&mut terminal, &mut hashes), 0, "any byte ends the claim");
        // A forced release and a resize end the claim as well.
        assert!(terminal.stop_synchronized_update());
        assert_eq!(claim(&mut terminal, &mut hashes), 0);
        terminal.apply_bytes(b"\x1b[?2026hA\x1b[?2026l");
        assert_ne!(claim(&mut terminal, &mut hashes), before);
        terminal.resize(21, 3);
        assert_eq!(claim(&mut terminal, &mut hashes), 0);
    }

    #[test]
    fn no_op_synchronized_update_does_not_accelerate_unrelated_output() {
        let (tx, _rx) = crossbeam_channel::unbounded();
        let mut terminal = TerminalState::new(20, 3, tx);
        terminal.apply_bytes(b"\x1b[?2026h\x1b[?2026l");
        assert_eq!(terminal.completed_sync_update_epoch(), 1);
        terminal.clear_dirty();
        terminal.apply_bytes(b"ordinary");
        assert_eq!(terminal.completed_sync_update_epoch(), 0);
        terminal.apply_bytes(b"\x1b[?2026h\x1b[?2026l");
        assert_eq!(terminal.completed_sync_update_epoch(), 2);
        terminal.resize(21, 3);
        assert_eq!(terminal.completed_sync_update_epoch(), 0);
        terminal.apply_bytes(b"\x1b[?2026hA\x1b[?2026lordinary");
        assert_eq!(terminal.completed_sync_update_epoch(), 0);
        assert!(visible_row_text(&terminal, 0).ends_with("Aordinary"));
    }

    #[test]
    fn redraw_fixture_erases_each_shorter_row_before_its_exact_marker() {
        const COLS: u16 = 48;
        const ROWS: u16 = 4;
        const PREFILL: &[u8] = b"legacy-row-zero-with-a-long-suffix\r\n\
legacy-row-one-with-a-long-suffix\r\n\
legacy-marker-with-a-long-suffix";
        const OLD_REDRAW: &[u8] = b"\x1b[Hrow-000-0\r\nrow-001-0\r\ndirect-final";
        const ERASED_REDRAW: &[u8] = b"\x1b[H\x1b[2K\rrow-000-0\r\n\
\x1b[2K\rrow-001-0\r\n\
\x1b[2K\rdirect-final";

        let terminal_with = |redraw: &[u8]| {
            let (event_tx, _event_rx) = crossbeam_channel::unbounded();
            let mut terminal = TerminalState::new(COLS, ROWS, event_tx);
            terminal.apply_bytes(PREFILL);
            terminal.apply_bytes(redraw);
            terminal
        };

        let old = terminal_with(OLD_REDRAW);
        assert!(
            visible_row_text(&old, 2).starts_with("direct-final"),
            "the negative control must reach the final marker"
        );
        assert_ne!(
            visible_row_text(&old, 2),
            "direct-final",
            "cursor-home alone must retain the pre-existing row suffix"
        );

        let erased = terminal_with(ERASED_REDRAW);
        assert_eq!(visible_row_text(&erased, 0), "row-000-0");
        assert_eq!(visible_row_text(&erased, 1), "row-001-0");
        assert_eq!(visible_row_text(&erased, 2), "direct-final");
    }

    #[test]
    fn pending_damage_census_distinguishes_only_the_current_cursor_row() {
        let (event_tx, _event_rx) = crossbeam_channel::unbounded();
        let mut terminal = TerminalState::new(8, 3, event_tx);

        terminal.clear_dirty();
        let clean = terminal.pending_display_damage();
        assert!(!clean.any);
        assert_eq!(clean.rows, PendingRowDamage::None);
        assert_eq!(clean.cursor_row, Some(0));

        terminal.display_metadata_dirty = true;
        let metadata = terminal.pending_display_damage();
        assert!(metadata.any);
        assert_eq!(metadata.rows, PendingRowDamage::None);
        assert_eq!(metadata.cursor_row, Some(0));

        terminal.clear_dirty();
        terminal.dirty_rows.mark(0);
        assert_eq!(
            terminal.pending_display_damage(),
            PendingDisplayDamage::cursor_only(0),
        );

        terminal.clear_dirty();
        terminal.dirty_rows.mark(1);
        assert_eq!(
            terminal.pending_display_damage().rows,
            PendingRowDamage::Coherent,
        );

        terminal.dirty_rows.mark(0);
        assert_eq!(
            terminal.pending_display_damage().rows,
            PendingRowDamage::Coherent,
        );
    }

    #[test]
    fn osc133_input_boundaries_are_exact_and_stream_across_chunks() {
        let mut integration = IntegrationProbe::new(None);

        integration.observe(b"\x1b]133;");
        integration.observe(b"B");
        assert!(!integration.input_active, "unterminated B must not grant");
        integration.observe(b"\x07");
        assert!(integration.input_active);

        integration.observe(b"\x1b]133;C\x1b");
        assert!(
            !integration.input_active,
            "an unambiguous C prefix must revoke before its split terminator"
        );
        integration.observe(b"\\");
        assert!(!integration.input_active);

        integration.observe(b"\x9d133;B\x9c");
        assert!(
            !integration.input_active,
            "C1 cannot grant when VTE does not implement its state transition"
        );
    }

    /// The token the daemon would have written. Any 32-char value works; the
    /// tests care about match/mismatch, not about how it was generated.
    const TEST_TOKEN: &[u8] = b"0123456789abcdef0123456789abcdef";

    fn authenticated_scanner() -> IntegrationProbe {
        IntegrationProbe::new(Some(TEST_TOKEN))
    }

    #[test]
    fn an_authenticated_prompt_boundary_grants_and_is_marked_authenticated() {
        let mut integration = authenticated_scanner();

        integration.observe(b"\x1b]133;B;merkur=0123456789abcdef0123456789abcdef\x07");

        assert!(integration.input_active);
        assert!(
            integration.input_authenticated,
            "a matching token is what lets the pgrp check be skipped under tmux"
        );
        assert!(
            integration.prompt_anchor,
            "an authenticated boundary must still record the prompt anchor"
        );
    }

    #[test]
    fn a_bare_prompt_boundary_still_grants_but_never_authenticates() {
        let mut integration = authenticated_scanner();

        integration.observe(b"\x1b]133;B\x07");

        assert!(
            integration.input_active,
            "shell integrations that predate Merkur's token must keep working"
        );
        assert!(!integration.input_authenticated);
    }

    #[test]
    fn a_forged_prompt_boundary_revokes_rather_than_being_ignored() {
        // The distinction is the whole point. If a bad token were ignored, a
        // boundary opened by the REAL prompt a moment earlier would still be
        // standing, and the forgery would have gained something by failing.
        for forgery in [
            b"\x1b]133;B;merkur=ffffffffffffffffffffffffffffffff\x07".as_slice(),
            b"\x1b]133;B;merkur=\x07".as_slice(),
            b"\x1b]133;B;merkur=0123456789abcdef0123456789abcde\x07".as_slice(),
            b"\x1b]133;B;merkur=0123456789abcdef0123456789abcdefX\x07".as_slice(),
        ] {
            let mut integration = authenticated_scanner();
            integration.observe(b"\x1b]133;B\x07");
            assert!(integration.input_active, "precondition: boundary is open");

            integration.observe(forgery);

            assert!(
                !integration.input_active,
                "a mismatched token must close the boundary, not leave it open"
            );
            assert!(!integration.input_authenticated);
        }
    }

    #[test]
    fn an_authenticated_form_without_a_configured_token_fails_closed() {
        let mut integration = IntegrationProbe::new(None);
        integration.observe(b"\x1b]133;B\x07");
        assert!(integration.input_active, "precondition: boundary is open");

        integration.observe(b"\x1b]133;B;merkur=0123456789abcdef0123456789abcdef\x07");

        assert!(
            !integration.input_active,
            "with no token installed there is nothing to match, so it must revoke"
        );
    }

    #[test]
    fn an_oversized_forged_token_overflows_and_fails_closed() {
        let mut integration = authenticated_scanner();
        integration.observe(b"\x1b]133;B\x07");
        assert!(integration.input_active, "precondition: boundary is open");

        let mut oversized = b"\x1b]133;B;merkur=".to_vec();
        oversized.extend(std::iter::repeat_n(b'a', 96));
        oversized.push(0x07);
        integration.observe(&oversized);

        assert!(
            !integration.input_active,
            "a payload too long to buffer must revoke rather than be dropped silently"
        );
    }

    #[test]
    fn an_authenticated_boundary_streams_across_chunks_but_c1_cannot_grant() {
        // tmux strips its own DCS passthrough wrapper, so what reaches this
        // scanner is the plain inner sequence — arriving in whatever chunks the
        // PTY read happened to split it into.
        let mut integration = authenticated_scanner();

        integration.observe(b"\x1b]133;B;mer");
        assert!(!integration.input_active, "unterminated must not grant");
        integration.observe(b"kur=0123456789abcdef");
        assert!(!integration.input_active);
        integration.observe(b"0123456789abcdef");
        assert!(!integration.input_active, "still unterminated");
        integration.observe(b"\x07");

        assert!(integration.input_active);
        assert!(integration.input_authenticated);

        integration.observe(b"\x1b]133;C\x07");
        assert!(
            !integration.input_authenticated,
            "command start revokes both"
        );

        integration.observe(b"\x9d133;B;merkur=0123456789abcdef0123456789abcdef\x9c");
        assert!(
            !integration.input_authenticated,
            "unsupported C1 controls cannot authenticate"
        );
    }

    #[test]
    fn unmodelled_input_and_reset_clear_authentication_with_the_boundary() {
        let mut integration = authenticated_scanner();
        integration.observe(b"\x1b]133;B;merkur=0123456789abcdef0123456789abcdef\x07");
        assert!(integration.input_authenticated, "precondition");

        integration.hard_reset();

        assert!(!integration.input_active);
        assert!(
            !integration.input_authenticated,
            "authentication must never outlive the boundary it belongs to"
        );
    }

    #[test]
    fn the_shipped_fish_snippet_under_tmux_produces_a_boundary_this_scanner_accepts() {
        // These are not hand-written. They were captured from the OUTER pty of a
        // real `tmux -> fish -i` session running the snippet that
        // `merkur shell-integration fish` prints, with
        // `set -g allow-passthrough on`. tmux consumed its DCS wrapper and
        // forwarded the inner OSC, which is the whole premise of W3.1 — and the
        // premise that fails silently if tmux ever changes its passthrough
        // behaviour or the snippet's escaping regresses.
        //
        // The token below is the one that session had on disk.
        const CAPTURED_TOKEN: &[u8] = b"7ff847e4b4d468623e927408e8f6ffb7";
        const CAPTURED_PROMPT_END: &[u8] =
            b"\x1b]133;B;merkur=7ff847e4b4d468623e927408e8f6ffb7\x07";
        const CAPTURED_COMMAND_START: &[u8] = b"\x1b]133;C\x07";
        const CAPTURED_COMMAND_END: &[u8] = b"\x1b]133;D;0\x07";

        let mut integration = IntegrationProbe::new(Some(CAPTURED_TOKEN));

        integration.observe(CAPTURED_PROMPT_END);
        assert!(
            integration.input_active,
            "the real prompt boundary must open"
        );
        assert!(
            integration.input_authenticated,
            "the real token must authenticate, or prediction stays off under tmux"
        );
        assert!(integration.prompt_anchor);

        integration.observe(CAPTURED_COMMAND_START);
        assert!(
            !integration.input_active,
            "the real command start must close the boundary before the command runs"
        );

        integration.observe(CAPTURED_COMMAND_END);
        assert!(!integration.input_active);
    }

    #[test]
    fn bracketed_paste_editor_boundaries_stream_and_malformed_prefixes_fail_closed() {
        let mut integration = IntegrationProbe::new(None);

        integration.observe(b"\x1b[?20");
        assert!(!integration.input_active);
        integration.observe(b"04h");
        assert!(integration.input_active);

        integration.observe(b"\x1b[?2004l");
        assert!(!integration.input_active);

        integration.observe(b"\x1b[?2004h");
        assert!(integration.input_active);
        integration.observe(b"\x1b[?20\x1bX");
        assert!(
            !integration.input_active,
            "aborted partial bracketed-paste control must fail closed"
        );

        integration.observe(b"\x1b[?2004h");
        assert!(integration.input_active);
        integration.observe(b"\x1b[?200X");
        assert!(
            !integration.input_active,
            "a terminated short relevant CSI must fail closed"
        );
    }

    /// Ordinary output does not close the editor boundary.
    ///
    /// The fragment test — "could this payload still become `?2004l` or
    /// `133;C`?" — is only meaningful within the family the payload is being
    /// scanned in. Asked across families it fired on the most common bytes a
    /// shell emits: `CSI 1 m` is bold, and `1` is a prefix of `133;`, which a
    /// CSI cannot carry. Every sequence below is one a coloured prompt, a
    /// syntax highlighter, or a line editor produces continuously, and each one
    /// used to end speculative echo until the next prompt.
    #[test]
    fn ordinary_control_sequences_do_not_close_the_editor_boundary() {
        for sequence in [
            &b"\x1b[1m"[..],          // bold
            &b"\x1b[1D"[..],          // one column left
            &b"\x1b[13D"[..],         // thirteen columns left, an autosuggestion walk-back
            &b"\x1b[1C"[..],          // one column right
            &b"\x1b[1A"[..],          // one row up
            &b"\x1b[1G"[..],          // column one
            &b"\x1b[133;1H"[..],      // a cursor move whose row happens to be 133
            &b"\x1b]1;title\x07"[..], // an icon-name OSC
        ] {
            let mut integration = IntegrationProbe::new(None);
            integration.observe(b"\x1b[?2004h");
            assert!(
                integration.input_active,
                "the fixture did not open a boundary"
            );
            integration.observe(sequence);
            assert!(
                integration.input_active,
                "{:?} closed the editor boundary",
                String::from_utf8_lossy(sequence)
            );
        }
    }

    /// And the revocations still revoke, in either family.
    #[test]
    fn revocation_controls_still_close_the_editor_boundary() {
        for sequence in [
            &b"\x1b[?2004l"[..],    // bracketed paste off
            &b"\x1b[?2004$p"[..],   // a bracketed-paste control with an unexpected ending
            &b"\x1b[?200X"[..],     // a terminated fragment of one
            &b"\x1b]133;C\x07"[..], // command start
            &b"\x1b]133;X\x07"[..], // an unrecognised member of the same family
            &b"\x1bc"[..],          // RIS
        ] {
            let mut integration = IntegrationProbe::new(None);
            integration.observe(b"\x1b[?2004h");
            assert!(
                integration.input_active,
                "the fixture did not open a boundary"
            );
            integration.observe(sequence);
            assert!(
                !integration.input_active,
                "{:?} left the editor boundary open",
                String::from_utf8_lossy(sequence)
            );
        }
    }

    #[test]
    fn line_submission_discards_partial_pre_submit_editor_markers() {
        let (event_tx, _event_rx) = crossbeam_channel::unbounded();
        let mut terminal = TerminalState::new(8, 4, event_tx);

        terminal.apply_bytes(b"\x1b]133;");
        terminal.observe_user_input(false, TerminalState::bytes_leave_line_editor(b"\r"));
        terminal.apply_bytes(b"B\x07");
        assert!(
            !terminal.shell_integration_input_active(),
            "an OSC marker that started before Enter cannot finish after it"
        );

        terminal.apply_bytes(b"\x1b[?20");
        terminal.observe_user_input(false, TerminalState::bytes_leave_line_editor(b"\r"));
        terminal.apply_bytes(b"04h");
        assert!(
            !terminal.shell_integration_input_active(),
            "a bracketed-paste marker that started before Enter cannot finish after it"
        );

        terminal.apply_bytes(b"\x1b[?2004h");
        assert!(
            terminal.shell_integration_input_active(),
            "a complete marker beginning after submission may regrant"
        );
    }

    #[test]
    fn unmodelled_control_input_revokes_prediction_until_a_fresh_editor_boundary() {
        let (event_tx, _event_rx) = crossbeam_channel::unbounded();
        let mut terminal = TerminalState::new(8, 4, event_tx);
        let mut baseline = Vec::new();
        terminal.current_grid_into(&mut baseline);

        terminal.apply_bytes(b"\x1b[?2004h");
        terminal.set_prediction_safe(true);
        terminal.clear_dirty();

        assert!(terminal.observe_user_input(false, TerminalState::bytes_leave_line_editor(b"\r")));
        assert!(!terminal.shell_integration_input_active());
        assert!(terminal.has_dirty());
        let (payload, _) = terminal.encode_delta_for_rows(&baseline, &[], Vec::new());
        let header = merkur_codec::parse_frame_header(&payload).unwrap();
        assert_eq!(header.mode_flags & DISPLAY_MODE_PREDICTION_SAFE, 0);

        terminal.apply_bytes(b"ordinary output");
        assert!(
            !terminal.shell_integration_input_active(),
            "ordinary output cannot revive a stale prompt latch"
        );
        terminal.apply_bytes(b"\x1b[?2004h");
        assert!(terminal.shell_integration_input_active());
    }

    #[test]
    fn unmodelled_printable_revokes_prediction_but_keeps_the_editor_boundary() {
        // The distinction that stops one un-predicted keystroke costing local
        // echo for the rest of the line. Prediction still stops at once; the
        // shell's editor boundary is only closed by input that could submit the
        // line, because only then can an unseen `read -s` follow.
        let (event_tx, _event_rx) = crossbeam_channel::unbounded();
        let mut terminal = TerminalState::new(8, 4, event_tx);
        terminal.apply_bytes(b"\x1b[?2004h");
        terminal.set_prediction_safe(true);

        assert!(terminal.observe_user_input(false, TerminalState::bytes_leave_line_editor(b"a")));
        assert!(
            !terminal.prediction_safe(),
            "prediction is withdrawn at once"
        );
        assert!(
            terminal.shell_integration_input_active(),
            "a printable cannot start a silent read, so the boundary stands and \
             the next PTY sample can re-grant"
        );

        // Submitting input is different: a `read -s` can be the very next thing
        // on the PTY, so the boundary closes until a fresh prompt.
        terminal.set_prediction_safe(true);
        assert!(terminal.observe_user_input(false, TerminalState::bytes_leave_line_editor(b"\r")));
        assert!(!terminal.shell_integration_input_active());
    }

    #[test]
    fn authenticated_shadow_modelled_input_preserves_current_editor_boundary() {
        let (event_tx, _event_rx) = crossbeam_channel::unbounded();
        let mut terminal = TerminalState::new(8, 4, event_tx);
        terminal.apply_bytes(b"\x1b[?2004h");
        terminal.set_prediction_safe(true);

        assert!(!terminal.observe_user_input(true, TerminalState::bytes_leave_line_editor(b"x")));
        assert!(terminal.shell_integration_input_active());
    }

    #[test]
    fn malformed_osc133_never_grants_and_revokes_an_active_input_boundary() {
        let mut integration = IntegrationProbe::new(None);

        integration.observe(b"\x1b]133;B-extra\x07");
        assert!(!integration.input_active);
        integration.observe(b"\x1b]133;B\x1bX");
        assert!(!integration.input_active);

        integration.observe(b"\x1b]133;B\x07");
        assert!(integration.input_active);
        integration.observe(b"\x1b]133;C-extra\x07");
        assert!(
            !integration.input_active,
            "malformed shell-integration control must fail closed"
        );

        integration.observe(b"\x1b]133;B\x07");
        assert!(integration.input_active);
        integration.observe(b"\x1b]13\x07");
        assert!(
            !integration.input_active,
            "a terminated short relevant OSC must fail closed"
        );
    }

    #[test]
    fn osc133_command_boundary_and_terminal_reset_revoke_prediction_grant() {
        let (event_tx, _event_rx) = crossbeam_channel::unbounded();
        let mut terminal = TerminalState::new(8, 4, event_tx);

        terminal.apply_bytes(b"\x1b]133;B\x1b\\");
        assert!(terminal.shell_integration_input_active());
        terminal.apply_bytes(b"\x1b]133;C\x07password:");
        assert!(
            !terminal.shell_integration_input_active(),
            "C must revoke before password/command output is applied"
        );

        terminal.apply_bytes(b"\x1b]133;B\x07");
        assert!(terminal.shell_integration_input_active());
        terminal.apply_bytes(b"\x1bc");
        assert!(!terminal.shell_integration_input_active());

        terminal.apply_bytes(b"\x1b]133;B\x07");
        terminal.set_prediction_safe(true);
        terminal.resize(9, 5);
        assert!(!terminal.shell_integration_input_active());
        assert_eq!(
            terminal.current_display_header_signal() & u128::from(DISPLAY_MODE_PREDICTION_SAFE),
            0
        );
    }

    #[test]
    fn repeated_bells_coalesce_without_allocating_terminal_events() {
        let (event_tx, event_rx) = crossbeam_channel::unbounded();
        let mut terminal = TerminalState::new(8, 4, event_tx);
        let bells = [0x07; 32 * 1024];

        terminal.apply_bytes(&bells);

        assert!(terminal.take_bell());
        assert!(!terminal.take_bell());
        assert!(event_rx.try_recv().is_err());
    }

    #[test]
    fn cursor_only_delta_keeps_header_payload() {
        let (event_tx, _event_rx) = crossbeam_channel::unbounded();
        let mut terminal = TerminalState::new(8, 4, event_tx);
        let mut baseline = Vec::new();

        terminal.current_grid_into(&mut baseline);
        terminal.apply_bytes(b"\x1b[C");

        let (payload, encoded_rows) = terminal.encode_delta_for_rows(&baseline, &[], Vec::new());

        assert_eq!(encoded_rows, 0);
        assert!(!payload.is_empty());
        assert_eq!(payload[STREAM_HEADER_BYTES + 6], 0);
        assert_eq!(payload[STREAM_HEADER_BYTES + 7], 1);
        assert_eq!(payload[DISPLAY_ROW_COUNT_OFFSET], 0);
        assert_eq!(payload[DISPLAY_ROW_COUNT_OFFSET + 1], 0);
    }

    #[test]
    fn display_revision_tracks_parsed_metadata_and_resize_mutations_only() {
        let (event_tx, _event_rx) = crossbeam_channel::unbounded();
        let mut terminal = TerminalState::new(8, 4, event_tx);
        let initial = terminal.display_revision();

        terminal.apply_bytes(&[]);
        assert_eq!(terminal.display_revision(), initial);

        terminal.apply_bytes(b"A");
        let parsed = terminal.display_revision();
        assert_eq!(parsed, initial + 1);

        assert!(!terminal.set_prediction_safe(false));
        assert_eq!(terminal.display_revision(), parsed);
        assert!(terminal.set_prediction_safe(true));
        let metadata = terminal.display_revision();
        assert_eq!(metadata, parsed + 1);

        terminal.resize(9, 5);
        assert_eq!(terminal.display_revision(), metadata + 1);
        terminal.clear_dirty();
        assert_eq!(
            terminal.display_revision(),
            metadata + 1,
            "consuming damage is not a terminal-state mutation"
        );
    }

    #[test]
    fn prediction_safety_transitions_dirty_metadata_and_update_wire_header() {
        let (event_tx, _event_rx) = crossbeam_channel::unbounded();
        let mut terminal = TerminalState::new(8, 4, event_tx);
        let mut baseline = Vec::new();
        terminal.current_grid_into(&mut baseline);
        terminal.clear_dirty();

        let (initial_payload, _) = terminal.encode_delta_for_rows(&baseline, &[], Vec::new());
        let initial_header = merkur_codec::parse_frame_header(&initial_payload).unwrap();
        assert_eq!(
            initial_header.mode_flags & DISPLAY_MODE_PREDICTION_SAFE,
            0,
            "unknown/unobserved PTY state must fail closed"
        );

        assert!(terminal.set_prediction_safe(true));
        assert!(terminal.has_dirty(), "the mode transition must arm a flush");
        let (enabled_payload, encoded_rows) =
            terminal.encode_delta_for_rows(&baseline, &[], Vec::new());
        let enabled_header = merkur_codec::parse_frame_header(&enabled_payload).unwrap();
        assert_eq!(
            encoded_rows, 0,
            "prediction safety is display metadata, not cell damage"
        );
        assert_eq!(
            enabled_header.mode_flags & DISPLAY_MODE_PREDICTION_SAFE,
            DISPLAY_MODE_PREDICTION_SAFE
        );

        terminal.clear_dirty();
        assert!(!terminal.set_prediction_safe(true));
        assert!(
            !terminal.has_dirty(),
            "an unchanged sample must not create display work"
        );

        assert!(terminal.set_prediction_safe(false));
        assert!(terminal.has_dirty());
        let (disabled_payload, _) = terminal.encode_delta_for_rows(&baseline, &[], Vec::new());
        let disabled_header = merkur_codec::parse_frame_header(&disabled_payload).unwrap();
        assert_eq!(disabled_header.mode_flags & DISPLAY_MODE_PREDICTION_SAFE, 0);
    }

    #[test]
    fn hidden_cursor_suppresses_prediction_capability_in_the_wire_header() {
        let (event_tx, _event_rx) = crossbeam_channel::unbounded();
        let mut terminal = TerminalState::new(8, 4, event_tx);
        let mut baseline = Vec::new();
        terminal.current_grid_into(&mut baseline);
        terminal.set_prediction_safe(true);

        terminal.apply_bytes(b"\x1b[?25l");
        let (hidden_payload, _) = terminal.encode_delta_for_rows(&baseline, &[], Vec::new());
        let hidden_header = merkur_codec::parse_frame_header(&hidden_payload).unwrap();
        assert_eq!(hidden_header.cursor_visible, 0);
        assert_eq!(
            hidden_header.mode_flags & DISPLAY_MODE_PREDICTION_SAFE,
            0,
            "a hidden cursor must never advertise speculative-input capability"
        );

        terminal.apply_bytes(b"\x1b[?25h");
        let (visible_payload, _) = terminal.encode_delta_for_rows(&baseline, &[], Vec::new());
        let visible_header = merkur_codec::parse_frame_header(&visible_payload).unwrap();
        assert_eq!(visible_header.cursor_visible, 1);
        assert_eq!(
            visible_header.mode_flags & DISPLAY_MODE_PREDICTION_SAFE,
            DISPLAY_MODE_PREDICTION_SAFE
        );
    }

    #[test]
    fn force_full_delta_emits_row_equal_to_baseline() {
        let (event_tx, _event_rx) = crossbeam_channel::unbounded();
        let mut terminal = TerminalState::new(3, 1, event_tx);
        let mut baseline = Vec::new();

        terminal.current_grid_into(&mut baseline);

        let (payload, encoded_rows) = terminal.encode_delta_for_rows(
            &baseline,
            &[DisplayRowRequest::literal(0, true)],
            Vec::new(),
        );

        assert_eq!(encoded_rows, 1);
        assert_eq!(payload[DISPLAY_ROW_COUNT_OFFSET], 0);
        assert_eq!(payload[DISPLAY_ROW_COUNT_OFFSET + 1], 1);
    }

    #[test]
    fn estimate_row_delta_size_matches_encoded_payload_size() {
        // Both force_full=false (changed-range only) and force_full=true (full row)
        // must produce estimates equal to the actual encoded per-row contribution.
        let (event_tx, _event_rx) = crossbeam_channel::unbounded();
        let mut terminal = TerminalState::new(8, 1, event_tx);
        let mut baseline = Vec::new();
        terminal.current_grid_into(&mut baseline);

        // Mutate row 0 so changed_cell_range produces a sub-row span.
        terminal.apply_bytes(b"hi");

        for force_full in [false, true] {
            let request = DisplayRowRequest::literal(0, force_full);
            let estimate = terminal.estimate_row_delta_size(&baseline, request);
            let header_overhead = STREAM_HEADER_BYTES + FRAME_HEADER_BODY_BYTES;
            let (payload, encoded_rows) =
                terminal.encode_delta_for_rows(&baseline, &[request], Vec::new());
            assert_eq!(encoded_rows, 1, "force_full={force_full}");
            let actual_row_bytes = payload.len() - header_overhead;
            assert_eq!(estimate, actual_row_bytes, "force_full={force_full}");
        }
    }

    /// A snapshot carries the wrap bit, and a receiver reading it back gets the
    /// same `CellRepr` the grid holds.
    ///
    /// The snapshot path writes row prefixes by hand instead of going through
    /// `encode_frame_into`, so it needs coverage of its own: it shipped without
    /// the bit once, which cost the browser every wrap flag it held the moment
    /// a resize forced a snapshot — the exact frame its local rewrap depends
    /// on.
    #[test]
    fn a_snapshot_carries_the_row_wrap_bit() {
        let (event_tx, _event_rx) = crossbeam_channel::unbounded();
        let mut terminal = TerminalState::new(8, 4, event_tx);
        // Wider than the terminal, so the first row wraps into the second.
        terminal.apply_bytes(b"0123456789ab\r\nshort");

        let expected: Vec<bool> = (0..4)
            .map(|row| {
                terminal.term.grid()[Line(row)]
                    .last()
                    .is_some_and(cell_wraps)
            })
            .collect();
        assert_eq!(
            expected,
            vec![true, false, false, false],
            "the fixture must wrap"
        );

        let (frame, encoded_rows) = terminal.encode_snapshot_into(Vec::new());
        assert_eq!(encoded_rows, 4);
        let observed: Vec<bool> = merkur_codec::iter_rows(&frame)
            .map(|entry| entry.expect("row decodes").wrapped)
            .collect();
        assert_eq!(observed, expected);

        // And the bit survives back onto the cell that owns it, which is what
        // makes an applied row hash the same as the row it was read from.
        let mut rows = Vec::new();
        let mut cells = Vec::new();
        let mut seen = Vec::new();
        merkur_codec::validate_display_frame(
            &frame,
            &mut rows,
            &mut cells,
            &mut seen,
            &mut Vec::new(),
            &mut Vec::new(),
        )
        .expect("the snapshot validates");
        assert!(cells[7].wrapped(), "row 0's last cell lost the bit");
        assert!(!cells[15].wrapped(), "row 1 does not wrap");
    }

    fn open_url_terminal() -> TerminalState {
        let (event_tx, _event_rx) = crossbeam_channel::unbounded();
        let mut terminal = TerminalState::new(40, 4, event_tx);
        terminal.set_shell_token(Box::from(&b"0123abcd"[..]));
        terminal
    }

    #[test]
    fn an_authenticated_open_request_is_queued_with_its_semicolons_intact() {
        let mut terminal = open_url_terminal();
        terminal.apply_bytes(b"\x1b]7780;merkur=0123abcd;https://a.example/x;y?q=1\x07");
        // ST-terminated too, split across two reads.
        terminal.apply_bytes(b"\x1b]7780;merkur=0123abcd;http://127.0.0.1:5173/");
        terminal.apply_bytes(b"\x1b\\");
        let urls: Vec<(u32, &str)> = terminal
            .open_urls()
            .after(0)
            .map(|request| (request.seq, &*request.url))
            .collect();
        assert_eq!(urls, [(1, "https://a.example/x;y?q=1"), (2, "http://127.0.0.1:5173/")]);
        assert!(visible_row_text(&terminal, 0).trim().is_empty(), "nothing is drawn");
    }

    #[test]
    fn open_requests_without_the_token_or_an_http_url_are_dropped() {
        let mut terminal = open_url_terminal();
        for forged in [
            &b"\x1b]7780;https://a.example/\x07"[..],
            b"\x1b]7780;merkur=wrong;https://a.example/\x07",
            b"\x1b]7780;merkur=0123abcd\x07",
            b"\x1b]7780;merkur=0123abcd;javascript:alert(1)\x07",
            b"\x1b]7780;merkur=0123abcd;file:///etc/passwd\x07",
            b"\x1b]7780;merkur=0123abcd;https://\x07",
            b"\x1b]7780;merkur=0123abcd;https://a.example/\xc3\xa9\x07",
        ] {
            terminal.apply_bytes(forged);
        }
        assert_eq!(terminal.open_urls().newest_seq(), None);

        let (event_tx, _event_rx) = crossbeam_channel::unbounded();
        let mut tokenless = TerminalState::new(40, 4, event_tx);
        tokenless.apply_bytes(b"\x1b]7780;merkur=;https://a.example/\x07");
        assert_eq!(
            tokenless.open_urls().newest_seq(),
            None,
            "no configured token fails closed"
        );
    }

    #[test]
    fn osc8_links_ride_the_snapshot_as_interned_ids_and_move_the_row_hash() {
        let (event_tx, _event_rx) = crossbeam_channel::unbounded();
        let mut terminal = TerminalState::new(16, 3, event_tx);
        terminal.apply_bytes(
            b"\x1b]8;;https://a.example/\x1b\\link\x1b]8;;\x1b\\ \x1b]8;;https://b.example/\x07b\x1b]8;;\x07",
        );
        // A second row linked only to a file: plain text on the wire, and
        // hashed exactly as if it had no link.
        terminal.apply_bytes(b"\r\n\x1b]8;;file:///etc/hosts\x07hosts\x1b]8;;\x07");

        let mut hashes = Vec::new();
        terminal.current_row_hashes_into(&mut hashes);
        let (frame, _) = terminal.encode_snapshot_into(Vec::new());
        let (mut rows, mut cells, mut seen) = (Vec::new(), Vec::new(), Vec::new());
        merkur_codec::validate_display_frame(
            &frame,
            &mut rows,
            &mut cells,
            &mut seen,
            &mut Vec::new(),
            &mut Vec::new(),
        )
        .expect("the snapshot validates");

        let links: Vec<u32> = cells[..6].iter().map(|cell| cell.link).collect();
        assert_ne!(links[0], 0);
        assert_eq!(&links[..4], &[links[0]; 4]);
        assert_eq!(links[4], 0, "the space between links is plain");
        assert_ne!(links[5], 0);
        assert_ne!(links[5], links[0]);
        assert!(cells[6..].iter().all(|cell| cell.link == 0));
        assert!(cells[16..32].iter().all(|cell| cell.link == 0));
        assert_eq!(hashes[1], merkur_codec::row_hash(&cells[16..32]));

        // The browser hashes the applied cells; it must agree with the capture.
        assert_eq!(hashes[0], merkur_codec::row_hash(&cells[..16]));
        let mut unlinked = cells[..16].to_vec();
        unlinked.iter_mut().for_each(|cell| cell.link = 0);
        assert_ne!(hashes[0], merkur_codec::row_hash(&unlinked));

        let table = terminal.link_table();
        let uris: Vec<(u32, &str)> = table
            .live()
            .iter()
            .map(|live| (live.id, &*live.uri))
            .collect();
        assert_eq!(
            uris,
            [(links[0], "https://a.example/"), (links[5], "https://b.example/")]
        );
    }

    #[test]
    fn one_pass_snapshot_matches_separate_grid_and_hash_walks() {
        let (event_tx, _event_rx) = crossbeam_channel::unbounded();
        let mut terminal = TerminalState::new(12, 3, event_tx);
        terminal.apply_bytes(b"alpha\r\n\x1b[31mbeta\x1b[0m\r\ngamma");

        let (legacy_frame, legacy_rows) = terminal.encode_snapshot_into(Vec::new());
        let mut legacy_grid = Vec::new();
        let mut legacy_hashes = Vec::new();
        terminal.current_grid_into(&mut legacy_grid);
        terminal.current_row_hashes_into(&mut legacy_hashes);

        let mut grid = Vec::new();
        let mut hashes = Vec::new();
        let (frame, rows) = terminal.encode_snapshot_state_into(
            Vec::new(),
            &mut grid,
            &mut hashes,
            &mut Vec::new(),
        );
        assert_eq!(frame, legacy_frame);
        assert_eq!(rows, legacy_rows);
        assert_eq!(grid, legacy_grid);
        assert_eq!(hashes, legacy_hashes);
    }
}

#[cfg(test)]
mod ui_tests;
