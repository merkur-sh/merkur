#![deny(clippy::debug_assert_with_mut_call)]
// The instrumented training build's profile runtime: an instrumented cdylib
// cannot link without it (see `packages/term-wasm-pgo`).
#[cfg(all(feature = "pgo-train", target_arch = "wasm32"))]
extern crate minicov as _;
pub mod client_grid;
mod client_viewer;
#[cfg(all(feature = "pgo-train", target_arch = "wasm32"))]
include!("pgo_training.rs");
pub use client_viewer::ClientViewer;
mod animation;
mod graphics;

mod atlas;
mod builtin_glyph;

use std::rc::Rc;

use alacritty_terminal::event::{Event, EventListener};
use alacritty_terminal::grid::{Dimensions, Grid, GridCell};
use alacritty_terminal::index::{Column, Line, Point};
use alacritty_terminal::term::cell::{Cell, Flags};
use alacritty_terminal::term::{Config, Term, point_to_viewport};
use alacritty_terminal::vte::ansi::{Color, CursorShape, NamedColor, Rgb};
use builtin_glyph::{BuiltinCellGlyph, builtin_cell_glyph};
use merkur_codec::theme::{
    ANSI_PALETTE, DEFAULT_BACKGROUND, DEFAULT_CURSOR, DEFAULT_DIM_FOREGROUND, DEFAULT_FOREGROUND,
    DIM_PALETTE, resolve_color,
};
use merkur_codec::{
    CELL_DIGEST_BYTES, CELL_DIGEST_WRAPPED_BIT, CellRepr, DISPLAY_COMPRESSED_LENGTH_OFFSET,
    DISPLAY_COMPRESSED_PAYLOAD_OFFSET, DISPLAY_DICT_COMPRESSED_PAYLOAD_OFFSET,
    DISPLAY_GENERATION_OFFSET, DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD,
    DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD_DICT, DISPLAY_HEADER_FLAGS_OFFSET, DISPLAY_VERSION_OFFSET,
    FRAME_HEADER_BODY_BYTES, FrameHeader, FrameKind, MAX_DISPLAY_FRAME_BYTES, MAX_TERMINAL_CELLS,
    MAX_TERMINAL_COLUMNS, MAX_TERMINAL_ROWS, MSG_TYPE_DISPLAY_PATCH, STREAM_HEADER_BYTES, VERSION,
    ValidatedDisplayRow, append_link_digest, cell_wraps, pack_cell_digest, parse_frame_header,
    parse_stream_header, row_hash_packed, validate_display_frame, validate_display_frame_header,
    validate_display_rows,
};
use unicode_width::UnicodeWidthChar;
use wasm_bindgen::prelude::*;

const THEME_BYTES: usize = 57;
const THEME_ANSI_OFFSET: usize = 9;
// Keep these wire-facing limits aligned with the daemon's validated terminal
// dimensions. They bound both allocation and decode work before a frame can
// resize or otherwise mutate the terminal.
const STAGED_VALIDATION_POOL_MAX: usize = 16;
// Vec growth may reserve beyond its current length. Retain at most two full
// terminal grids of decoded-cell capacity across every pooled chunk scratch.
const STAGED_VALIDATION_POOL_MAX_CELL_CAPACITY: usize = MAX_TERMINAL_CELLS * 2;
// The browser receive queue has the same frame bound. Keeping it here as an
// independent hard limit means a caller outside that worker cannot turn the
// staging table into an unbounded handle arena.
const STAGED_FRAME_MAX: usize = 256;
// Active staged work is bounded separately from recycled capacity. Four MiB
// admits the browser's largest legitimate reliable snapshot while refusing a
// queue full of individually-small compressed frames that expand together.
const STAGED_ACTIVE_MAX_WIRE_BYTES: usize = merkur_codec::MAX_DISPLAY_SNAPSHOT_BYTES;
const STAGED_ACTIVE_MAX_DECODED_BYTES: usize = merkur_codec::MAX_DISPLAY_SNAPSHOT_BYTES;
const STAGED_ACTIVE_MAX_CELL_BUDGET: usize = MAX_TERMINAL_CELLS * 2;
// A compressed frame cannot need more history than the bounded frame itself.
// Keep decoder history bounded independently of its advertised output length.
const DISPLAY_ZSTD_MAX_WINDOW_BYTES: u64 = MAX_DISPLAY_FRAME_BYTES as u64;
const GEOMETRY_STATE_WORDS_PER_BUFFER: usize = 5;
const GEOMETRY_STATE_BUFFER_COUNT: usize = 4;
const GEOMETRY_STATE_LEN: usize = GEOMETRY_STATE_WORDS_PER_BUFFER * GEOMETRY_STATE_BUFFER_COUNT + 1;

#[derive(Clone, Copy)]
struct RenderTheme {
    foreground: [u8; 3],
    background: [u8; 3],
    cursor: [u8; 3],
    palette: [[u8; 3]; 16],
}

impl Default for RenderTheme {
    fn default() -> Self {
        Self {
            foreground: DEFAULT_FOREGROUND,
            background: DEFAULT_BACKGROUND,
            cursor: DEFAULT_CURSOR,
            palette: ANSI_PALETTE,
        }
    }
}
const CURSOR_SHAPE_HIDDEN: u8 = 0;
const CURSOR_SHAPE_BLOCK: u8 = 1;
const CURSOR_SHAPE_BEAM: u8 = 2;
const CURSOR_SHAPE_UNDERLINE: u8 = 3;
const PREDICTION_ALPHA: f32 = 0.55;
const PREDICTION_STYLE_NORMAL: u8 = 0;
const SPECULATIVE_ASCII_FIRST: u32 = 0x20;
const SPECULATIVE_ASCII_LAST: u32 = 0x7e;
const SPECULATIVE_ASCII_COUNT: usize =
    (SPECULATIVE_ASCII_LAST - SPECULATIVE_ASCII_FIRST + 1) as usize;
const SPECULATIVE_GLYPH_ENTRY_WORDS: usize = 6;
const SPECULATIVE_ASCII_ENTRIES_LEN: usize =
    SPECULATIVE_ASCII_COUNT * SPECULATIVE_GLYPH_ENTRY_WORDS;
// PTY write completion can advance a display frame's authenticated input
// watermark just before the slave's echo reaches the terminal parser. Give a
// contradictory cell projection one presentation-sized grace window so a
// following correction can reconcile without a false rollback. The core's
// prediction model waits out the same window.
use merkur_client::viewer::MISMATCH_GRACE_MS as PREDICTION_MISMATCH_GRACE_MS;
// Exact visible-effect membership also drives local latency admission with
// diagnostics disabled. Overflow is unknown, never a partial claimed set.
const MAX_VISIBLE_PREDICTION_EFFECTS: usize = 256;
// Move the measured first glyph/clear's three allocations (96 bytes) to
// construction. Larger bursts still grow within MAX_VISIBLE_PREDICTION_EFFECTS.
const INITIAL_VISIBLE_PREDICTION_EFFECT_CAPACITY: usize = 4;
const MAX_SHADOW_OPS: usize = 256;
// The daemon's `mode_flags`: routing decisions it derives from its own
// terminal (`encode_terminal_mode` in the dataplane), never raw xterm modes.
const DISPLAY_MODE_POINTER_CLICKS: u32 = 1;
const DISPLAY_MODE_POINTER_DRAG: u32 = 1 << 1;
const DISPLAY_MODE_POINTER_HOVER: u32 = 1 << 2;
const DISPLAY_MODE_WHEEL: u32 = 1 << 3;
/// Deliberately not consulted by `prediction_mode_is_unsafe` — see the note
/// there. Resize does consult it: the alternate screen is the one screen
/// alacritty resizes without reflow, and this grid has to match the daemon's
/// decision.
const DISPLAY_MODE_ALT_SCREEN: u32 = 1 << 4;
// Authenticated daemon capability grant for modes whose local edits can be
// predicted safely. Absence is unsafe so old daemons and lookup failures fail
// closed.
const DISPLAY_MODE_PREDICTION_SAFE: u32 = 1 << 5;
// When input nothing waits on (releases, bare modifiers, focus) encodes to
// bytes; the browser holds it in the input ring until then.
const DISPLAY_MODE_KEY_RELEASES: u32 = 1 << 6;
const DISPLAY_MODE_MODIFIER_KEYS: u32 = 1 << 7;
const DISPLAY_MODE_FOCUS: u32 = 1 << 8;
const DISPLAY_MODE_KNOWN_MASK: u32 = 0x1ff;
// What the daemon's input-routing word carries while a synchronized update is
// paused: every bit above except the alternate screen and the grant, which
// describe the grid.
const DISPLAY_MODE_INPUT_ROUTING: u32 = DISPLAY_MODE_POINTER_CLICKS
    | DISPLAY_MODE_POINTER_DRAG
    | DISPLAY_MODE_POINTER_HOVER
    | DISPLAY_MODE_WHEEL
    | DISPLAY_MODE_KEY_RELEASES
    | DISPLAY_MODE_MODIFIER_KEYS
    | DISPLAY_MODE_FOCUS;

/// Whether a mode word carries the daemon's authenticated prompt grant and no
/// mode this build does not know.
fn mode_grants_prediction(mode: u32) -> bool {
    mode & !DISPLAY_MODE_KNOWN_MASK == 0 && mode & DISPLAY_MODE_PREDICTION_SAFE != 0
}

/// RFC-1982 ordering for daemon-owned display sequences.
///
/// The producer skips zero when its `u32` counter wraps. Zero is therefore an
/// uninitialized/reset sentinel here, not a serial that can supersede live
/// delta state. Treating it separately also lets the first post-reset frame
/// start anywhere in the sequence space. The exactly-half-range case is
/// intentionally unordered and therefore not newer.
#[inline]
fn display_sequence_is_newer(candidate: u32, current: u32) -> bool {
    if candidate == 0 {
        return false;
    }
    if current == 0 {
        return true;
    }
    let distance = candidate.wrapping_sub(current);
    distance != 0 && distance < 0x8000_0000
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum PredKind {
    Char,
    ClearBack,
}

#[derive(Clone, Copy)]
struct Prediction {
    row: u16,
    col: u16,
    input_seq: u32,
    codepoint: u32,
    original_codepoint: u32,
    epoch: u32,
    kind: PredKind,
    fg: [u8; 3],
}

#[derive(Clone, Copy)]
struct PredictionClearEffect {
    input_seq: u32,
    cleared_input_seq: u32,
    row: u16,
    col: u16,
    original_codepoint: u32,
}

/// Why the eligible/predicted base cursor last had a reason to move.
///
/// `cursor_info_ptr` selects `predicted_cursor` while the shadow model is
/// visible and the eligible presentation cursor otherwise. A backwards base
/// step can come from withdrawing the model, moving its projection, or promoting
/// a changed authoritative cursor. Each mutation stamps its cause here, and
/// [`Terminal::note_drawn_cursor`] reads that name at the moment the step is
/// sampled. This excludes the worker's separate UNSENT provisional cursor pass
/// and does not observe GPU completion, compositor presentation, or physical pixels.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u32)]
enum CursorCause {
    Unknown = 0,
    /// A newer display header moved the authoritative cursor.
    AuthorityHeader = 1,
    /// A newer display header changed the authoritative cursor's shape or
    /// visibility. The two coordinate words carry `shape << 8 | visible`
    /// before and after; the ops word carries the header's display sequence.
    AuthorityShape = 2,
    /// The local grid was resized.
    AuthorityResize = 3,
    /// `predict_flush` from outside WASM (the worker's own drop paths).
    FlushExternal = 10,
    FlushSnapshot = 11,
    FlushResize = 12,
    FlushPreedit = 13,
    /// A key the model does not project: a control character, or a printable
    /// that is not width-one.
    FlushUnpredictableKey = 14,
    /// The daemon has withdrawn the prompt grant, or the cursor is hidden.
    FlushModeUnsafe = 15,
    /// The model's base no longer describes the presented grid: the cells it
    /// asserts or the cursor it expects differ from what is drawn.
    FlushBaseMismatch = 16,
    /// The line reached the op journal bound or the right margin.
    FlushLineFull = 17,
    /// An op could not be projected onto the line it was modelled against.
    FlushOpFailed = 18,
    /// The daemon published a different prompt anchor.
    FlushEditorAnchor = 19,
    /// A newer header arrived with prediction no longer granted.
    FlushModeRevoked = 20,
    /// Reconciliation found authority contradicting the projection.
    FlushReconcileMismatch = 21,
    /// A prediction outlived its lifetime with authority already covering it.
    FlushExpiredCovered = 22,
    /// A prediction outlived its lifetime and authority never arrived.
    FlushExpiredStalled = 23,
    /// There is no line to model onto and none can be seeded here.
    FlushNoSeedableLine = 24,
    /// The row tail is not blank and no prompt anchor vouches for it — the
    /// shape a shell autosuggestion leaves behind.
    FlushRowTailNotPredictable = 25,
    /// The prompt anchor or the grid geometry the renderer presents is not the
    /// one authority holds, so no base can be trusted until they agree.
    FlushAnchorNotPresented = 26,
    /// Received authority matches neither the base nor any prefix of the
    /// projected ops: an echo the model cannot place.
    FlushReceivedIncompatible = 27,
    /// The row under the cursor has not been received into the presentation
    /// since authority last moved, so there is no base to seed from yet.
    FlushSeedBaseNotReceived = 28,
    /// `predict_seal` from outside WASM: an input the model does not project
    /// ended the line. Nothing painted was taken back for it.
    SealExternal = 29,
    /// The model accepted an op and moved its own cursor.
    PredictOp = 30,
    /// Reconciliation rebased the line onto authority.
    ReconcileRebase = 31,
    /// The line is sealed behind an unmodelled input, so no op can extend it.
    LineSealed = 32,
    /// A sealed line was answered by authority — every painted op confirmed,
    /// or the row transformed past them — and is finished.
    FlushSealResolved = 33,
    /// Resolved where the step is observed: the line was never admitted.
    AdmissionWithheld = 40,
    /// Resolved where the step is observed: the newest op is unconfirmed.
    EpochTentative = 41,
}

impl CursorCause {
    /// Every variant, in code order. The one list to keep in step with the
    /// enum; a code missing from it reads back as `cause(<code>)` rather than
    /// as a wrong name.
    const ALL: &'static [CursorCause] = &[
        CursorCause::Unknown,
        CursorCause::AuthorityHeader,
        CursorCause::AuthorityShape,
        CursorCause::AuthorityResize,
        CursorCause::FlushExternal,
        CursorCause::FlushSnapshot,
        CursorCause::FlushResize,
        CursorCause::FlushPreedit,
        CursorCause::FlushUnpredictableKey,
        CursorCause::FlushModeUnsafe,
        CursorCause::FlushBaseMismatch,
        CursorCause::FlushLineFull,
        CursorCause::FlushOpFailed,
        CursorCause::FlushEditorAnchor,
        CursorCause::FlushModeRevoked,
        CursorCause::FlushReconcileMismatch,
        CursorCause::FlushExpiredCovered,
        CursorCause::FlushExpiredStalled,
        CursorCause::FlushNoSeedableLine,
        CursorCause::FlushRowTailNotPredictable,
        CursorCause::FlushAnchorNotPresented,
        CursorCause::FlushReceivedIncompatible,
        CursorCause::FlushSeedBaseNotReceived,
        CursorCause::SealExternal,
        CursorCause::PredictOp,
        CursorCause::ReconcileRebase,
        CursorCause::LineSealed,
        CursorCause::FlushSealResolved,
        CursorCause::AdmissionWithheld,
        CursorCause::EpochTentative,
    ];
}

/// Words per cursor-motion journal record, so a reader never carries its own
/// copy of the stride.
#[wasm_bindgen]
pub fn cursor_motion_record_words() -> usize {
    CURSOR_MOTION_RECORD_WORDS
}

/// The name of a cursor-motion cause code.
///
/// Derived from the enum's own `Debug`, so a reader can never print a name the
/// code does not have.
#[wasm_bindgen]
pub fn cursor_cause_name(code: u32) -> String {
    CursorCause::ALL
        .iter()
        .find(|cause| **cause as u32 == code)
        .map_or_else(|| format!("cause({code})"), |cause| format!("{cause:?}"))
}

/// Words per [`Terminal::cursor_motion`] record:
/// `[seq, cause, from_row<<16|from_col, to_row<<16|to_col, flags, ops]`.
/// Coordinates describe the sampled eligible/predicted base cursor, not an
/// UNSENT provisional cursor or a physical-presentation observation.
pub const CURSOR_MOTION_RECORD_WORDS: usize = 6;
/// Records kept before the journal starts counting drops instead. A reader
/// drains it every render; this bounds a reader that has stopped.
const CURSOR_MOTION_MAX_RECORDS: usize = 64;
pub const CURSOR_MOTION_FLAG_WAS_MODELLED: u32 = 1 << 0;
pub const CURSOR_MOTION_FLAG_IS_MODELLED: u32 = 1 << 1;
pub const CURSOR_MOTION_FLAG_LINE_PRESENT: u32 = 1 << 2;
pub const CURSOR_MOTION_FLAG_LINE_ADMITTED: u32 = 1 << 3;
pub const CURSOR_MOTION_FLAG_MODE_UNSAFE: u32 = 1 << 4;
pub const CURSOR_MOTION_FLAG_LINE_SEALED: u32 = 1 << 5;

#[derive(Clone, Copy)]
struct ShadowMeta {
    input_seq: u32,
    sent_at_ms: f64,
    epoch: u32,
}

#[derive(Clone, Copy)]
struct ShadowCell {
    codepoint: u32,
    meta: ShadowMeta,
    fg: [u8; 3],
    font_style: u8,
    underline: bool,
}

#[derive(Clone, Copy)]
enum ShadowOpKind {
    Insert { index: u16, cell: ShadowCell },
    Backspace { index: u16 },
    Delete { index: u16 },
    CursorShift { delta: i8 },
}

#[derive(Clone, Copy)]
struct ShadowOp {
    kind: ShadowOpKind,
    meta: ShadowMeta,
    authority_revision: u32,
    header_revision: u32,
}

#[derive(Default)]
struct ShadowState {
    cells: Vec<ShadowCell>,
    cursor: usize,
    extent: usize,
    clear_meta: Vec<Option<ShadowMeta>>,
}

impl Clone for ShadowState {
    fn clone(&self) -> Self {
        Self {
            cells: self.cells.clone(),
            cursor: self.cursor,
            extent: self.extent,
            clear_meta: self.clear_meta.clone(),
        }
    }

    fn clone_from(&mut self, source: &Self) {
        // Derive's default clone_from replaces both vectors. Replay/rebase is
        // recurring input work; preserve their already-owned capacity instead.
        self.cells.clone_from(&source.cells);
        self.cursor = source.cursor;
        self.extent = source.extent;
        self.clear_meta.clone_from(&source.clear_meta);
    }
}

#[derive(Clone)]
struct ShadowLine {
    row: u16,
    start_col: u16,
    base: ShadowState,
    projected: ShadowState,
    ops: Vec<ShadowOp>,
    /// Whether this speculative line was admitted as *displayable* when it was
    /// seeded, latched for its lifetime.
    ///
    /// The visibility gate answers "is local echo worth showing", from a
    /// smoothed rtt, a paint-latency floor and a trust window — all of which
    /// move continuously. Consulting it at render time made every one of those
    /// movements retract or restore the whole model, and an outstanding
    /// prediction is exactly the state in which the predicted and authoritative
    /// cursors differ, so each movement stepped the cursor sideways. Latching
    /// per line makes it an admission decision on a boundary the user can see:
    /// a line begins visible or it does not, and the gate gets its next say
    /// when the line is flushed — which every non-predictable key already does.
    visible: bool,
    /// The line ended behind an input the model does not project — Enter, a
    /// paste, a key it refused — or behind the grant that input withdrew.
    ///
    /// Sealing is the opposite of flushing. No op can extend a sealed line, so
    /// nothing typed behind the submission is ever painted from a stale base;
    /// but every op already painted stays exactly where it is until authority
    /// answers it. The answer is read the same way as for an open line — the
    /// row's cells against the projection — except that the cursor is no
    /// longer expected at the projected column, because the sealing input may
    /// have moved it anywhere. Taking the glyphs back on the key instead put
    /// the row's *previous* contents on screen for one round trip on every
    /// line submitted faster than the path, with the cursor stepping back to
    /// match: the "cursor jumps backwards and I see past content" of
    /// 2026-09-07.
    ///
    /// Carries what sealed it, because that decides how a later contradiction
    /// is read: after Enter, a paste or a completion the row is *expected* to
    /// transform and the line is simply finished; after a refusal that was
    /// itself caused by received authority disagreeing with the base, the
    /// same contradiction is evidence against the glyphs and counts.
    sealed: Option<CursorCause>,
    /// The input that sealed the line, or 0 when the seal carried none (a
    /// composition).
    ///
    /// Until authority's echo horizon (`FrameHeader::echo_horizon`) covers
    /// it, no grid received can show what that input did, and the line is
    /// answered exactly as an open one: an echo still on the wire is a lag,
    /// and a prefix the row already shows is reconciled. The input watermark
    /// cannot say this: it advances when the write completes, so a frame
    /// captured between the write and the program's answer covers the input
    /// as fully as one captured after it. Submitting the last glyph and Enter
    /// in one burst took that glyph back for a round trip, with the cursor
    /// stepping back to match.
    sealed_by_input: u32,
    mismatch_first_seen_at_ms: Option<f64>,
}

struct ShadowRenderProjection<'a> {
    row: usize,
    start_col: usize,
    cells: &'a [ShadowCell],
    extent: usize,
}

#[derive(Clone, Copy)]
struct TerminalDimensions {
    cols: usize,
    rows: usize,
}

#[derive(Default)]
struct RowGeometry {
    bg: Vec<f32>,
    glyph: Vec<f32>,
    deco: Vec<f32>,
    bg_start: usize,
    glyph_start: usize,
    deco_start: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct PendingDisplayHeader {
    seq: u32,
    cursor_col: u16,
    cursor_row: u16,
    cursor_shape: u8,
    cursor_visible: u8,
    mode_flags: u16,
    /// `FrameHeader::scroll_serial` of the state this header describes.
    scroll_serial: u32,
}

#[derive(Default)]
struct DisplayFrameDecodeScratch {
    graphics: Vec<merkur_graphics::projection::Fragment>,
    rows: Vec<ValidatedDisplayRow>,
    cells: Vec<CellRepr>,
    row_seen: Vec<bool>,
}

struct StagedDisplayValidation {
    header: FrameHeader,
    decoded: DisplayFrameDecodeScratch,
    graphics: Option<Vec<(u16, merkur_graphics::projection::RowFragments)>>,
}

#[derive(Clone, Copy)]
struct StagedDisplayBudget {
    wire_bytes: usize,
    decoded_bytes: usize,
    decoded_cells: usize,
}

#[derive(Clone, Copy)]
struct StagedDisplayAdmission {
    header: FrameHeader,
    budget: StagedDisplayBudget,
    compressed: bool,
}

struct StagedDisplayFrame {
    data: Vec<u8>,
    validation: Option<StagedDisplayValidation>,
    budget: StagedDisplayBudget,
}

impl Dimensions for TerminalDimensions {
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

#[derive(Clone, Copy)]
struct WasmEventListener;

impl EventListener for WasmEventListener {
    fn send_event(&self, _event: Event) {}
}

const CURRENT_DISPLAY_DICTIONARY: usize = 0;
const PREVIOUS_DISPLAY_DICTIONARY: usize = 1;

struct DisplayDictionarySlot {
    bytes: Vec<u8>,
    /// The parsed decoder form of `bytes`, present exactly when `bytes` is.
    /// A frame names its slot through the authenticated outer tuple, so each
    /// slot decodes with its own dictionary and zstd ids never have to be
    /// unique across slots.
    ddict: Option<zstd_safe::DDict<'static>>,
    generation: u32,
    id: u32,
    hash: u32,
    zstd_id: u32,
}

impl DisplayDictionarySlot {
    fn empty() -> Self {
        Self {
            bytes: Vec::new(),
            ddict: None,
            generation: 0,
            id: 0,
            hash: 0,
            zstd_id: 0,
        }
    }

    #[inline]
    fn matches(&self, generation: u32, id: u32, hash: u32) -> bool {
        !self.bytes.is_empty()
            && self.generation == generation
            && self.id == id
            && self.hash == hash
    }

    fn replace(
        &mut self,
        generation: u32,
        id: u32,
        hash: u32,
        zstd_id: u32,
        bytes: &[u8],
        ddict: zstd_safe::DDict<'static>,
    ) {
        self.clear();
        self.bytes.extend_from_slice(bytes);
        self.ddict = Some(ddict);
        self.generation = generation;
        self.id = id;
        self.hash = hash;
        self.zstd_id = zstd_id;
    }

    fn clear(&mut self) {
        // Vec::clear only changes length. Zero the live range first so a later
        // shorter replacement cannot leave authenticated dictionary tail bytes
        // resident in the retained allocation.
        self.bytes.fill(0);
        self.bytes.clear();
        // `ZSTD_freeDDict` releases the decoder's copy of the dictionary.
        self.ddict = None;
        self.generation = 0;
        self.id = 0;
        self.hash = 0;
        self.zstd_id = 0;
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ZstdFrameMetadata {
    dictionary_id: Option<u32>,
    window_size: u64,
    /// Bytes of the frame header, where the first block begins.
    header_len: usize,
}

/// Parse the allocation-driving subset of the display payload's zstd frame
/// header: magicless, with a window descriptor, no content size and no
/// checksum, exactly what the daemon writes.
///
/// Merkur never emits skippable frames or concatenated frames. Reading this
/// fixed prefix before invoking libzstd lets us compare authenticated outer
/// metadata with the embedded dictionary identity and reject an excessive
/// window before any decode work.
fn parse_zstd_frame_metadata(data: &[u8]) -> Option<ZstdFrameMetadata> {
    let descriptor = *data.first()?;
    // Bits 4 and 3 are unused/reserved and must be zero in the frame dialect
    // libzstd produces. The daemon writes neither a frame content size (the
    // top two bits, and the single-segment bit that implies one) nor a
    // checksum (bit 2): the envelope carries the length, and the AEAD
    // authenticates the bytes.
    if descriptor & 0b1111_1100 != 0 {
        return None;
    }
    let window_descriptor = *data.get(1)?;
    let dictionary_id_bytes = match descriptor & 0x03 {
        0 => 0,
        1 => 1,
        2 => 2,
        _ => 4,
    };
    let dictionary_id = read_zstd_little_endian(data, 2, dictionary_id_bytes)?;
    let exponent = u32::from(window_descriptor >> 3);
    let base = 1u64.checked_shl(10 + exponent)?;
    let window_size = base.checked_add((base / 8) * u64::from(window_descriptor & 0x07))?;
    Some(ZstdFrameMetadata {
        dictionary_id: (dictionary_id != 0).then_some(dictionary_id as u32),
        window_size,
        header_len: 2 + dictionary_id_bytes,
    })
}

/// The exact size of the one checksum-free zstd frame at the start of `data`
/// whose header is `header_len` bytes, walking its block headers; `None` when
/// a block is reserved or runs past `data`.
///
/// `ZSTD_decompress*` decodes every frame concatenated in its input, and with
/// no magic number there is nothing else to tell where a frame ends, so the
/// payload must be proven to be exactly one frame before it is decoded.
fn zstd_frame_size(data: &[u8], header_len: usize) -> Option<usize> {
    const BLOCK_HEADER_BYTES: usize = 3;
    let mut at = header_len;
    loop {
        let header = data.get(at..at + BLOCK_HEADER_BYTES)?;
        let block = u32::from(header[0]) | u32::from(header[1]) << 8 | u32::from(header[2]) << 16;
        let size = (block >> 3) as usize;
        let content = match (block >> 1) & 0x03 {
            // Raw and compressed blocks carry `size` bytes; an RLE block one.
            0 | 2 => size,
            1 => 1,
            _ => return None,
        };
        at = at.checked_add(BLOCK_HEADER_BYTES + content)?;
        if at > data.len() {
            return None;
        }
        if block & 0x01 != 0 {
            return Some(at);
        }
    }
}

fn read_zstd_little_endian(data: &[u8], offset: usize, len: usize) -> Option<u64> {
    let bytes = data.get(offset..offset.checked_add(len)?)?;
    let mut value = 0u64;
    for (shift, byte) in bytes.iter().copied().enumerate() {
        value |= u64::from(byte) << (shift * 8);
    }
    Some(value)
}

/// One-shot decoding writes straight into the caller's split buffer and never
/// allocates a history window, so the only window bound is the exact byte
/// check `parse_zstd_frame_metadata` feeds before any decode. The display
/// payload's frames are magicless.
fn new_display_decoder() -> zstd_safe::DCtx<'static> {
    let mut decoder = zstd_safe::DCtx::create();
    decoder
        .set_parameter(zstd_safe::DParameter::Format(
            zstd_safe::FrameFormat::Magicless,
        ))
        .expect("magicless display frames");
    decoder
}

/// Mark one row's cached hash stale.
///
/// A free function over the three fields rather than a method: the apply loops
/// hold an immutable borrow of `frame_rows_scratch` while
/// they run, so a `&mut self` call there would not borrow-check. Disjoint field
/// borrows do.
#[inline]
fn mark_row_hash_dirty(
    all_dirty: &mut bool,
    dirty: &mut [bool],
    dirty_list: &mut Vec<u16>,
    row: u16,
) {
    if *all_dirty {
        return;
    }
    match dirty.get_mut(usize::from(row)) {
        // A length disagreement means the vectors have not caught up with a
        // geometry change yet; the next refresh rebuilds them wholesale.
        None => *all_dirty = true,
        Some(slot) if *slot => {}
        Some(slot) => {
            *slot = true;
            dirty_list.push(row);
        }
    }
}

#[wasm_bindgen]
pub struct Terminal {
    graphics: Option<graphics::GraphicsRows>,
    frame_graphics_scratch: Vec<merkur_graphics::projection::Fragment>,
    term: Term<WasmEventListener>,
    // Received authority and render eligibility have different commit boundaries.
    // Reuse one viewport-sized backing grid; only dirty rows are copied on release.
    presentation_grid: Grid<Cell>,
    presentation_cursor_shape: CursorShape,
    presentation_dirty_rows: Vec<u16>,
    // 0 = absent, 1 = version-only, 2 = changed cells. One list entry per row.
    presentation_dirty_set: Vec<u8>,
    presentation_full_pending: bool,
    presentation_header_pending: bool,
    presentation_cursor_dirty: bool,
    presentation_revision: u32,
    presentation_row_versions: Vec<u32>,
    presentation_editor_anchor: Option<(u16, u16)>,
    presentation_editor_anchor_generation: u32,
    /// Rows the next geometry build must redo, each listed once: the set
    /// bounds the list by the row count even for a host that never builds
    /// geometry (the native viewer), where it would otherwise grow per frame.
    damaged_rows: Vec<u16>,
    damaged_row_set: Vec<bool>,
    /// Packed row-digest bytes, retained so a steady drain allocates nothing.
    hash_digest_scratch: Vec<u8>,
    /// Live per-row XXH3 of the authoritative grid, in the CellRepr shape the
    /// daemon hashes.
    ///
    /// Maintained incrementally so that neither the resume claim nor the
    /// hash-digest comparison has to walk the whole grid: both become reads of
    /// this vector. The grid is mutated in exactly two places — `apply_row_cells`
    /// inside `apply_validated_frame`, and `resize` — so marking there is
    /// complete. Predictions are a shadow overlay and never reach the grid, which
    /// is what keeps these hashes comparable with the daemon's.
    row_hashes: Vec<u64>,
    /// Rows whose entry in `row_hashes` is stale. Dirty rows are hashed once per
    /// `refresh_row_hashes`, so a row rewritten by several frames in one drain
    /// costs one hash rather than one per frame.
    row_hash_dirty: Vec<bool>,
    row_hash_dirty_list: Vec<u16>,
    /// Set instead of listing every row when the whole grid turns over.
    row_hash_all_dirty: bool,
    frame_rows_scratch: Vec<ValidatedDisplayRow>,
    frame_cells_scratch: Vec<CellRepr>,
    // Row indices already claimed by an entry in the frame being validated.
    // Two entries writing one row at the same seq would be ambiguous.
    frame_row_seen_scratch: Vec<bool>,
    // Compressed display frames decode and validate directly into retained
    // scratch. Multi-chunk raw frames use the same owned slots so their
    // validation decode can be retained and applied without a second JS ->
    // WASM copy. Raw single-datagram frames never enter this staging path.
    staged_frames: Vec<Option<StagedDisplayFrame>>,
    // Released handles are reused in O(1). A linear scan here made a burst of
    // staged snapshots quadratic in the number of live holes.
    staged_frame_free_slots: Vec<usize>,
    staged_frame_pool: Vec<Vec<u8>>,
    staged_validation_pool: Vec<DisplayFrameDecodeScratch>,
    staged_validation_pool_cell_capacity: usize,
    staged_validation_pool_graphics_capacity: usize,
    staged_active_wire_bytes: usize,
    staged_active_decoded_bytes: usize,
    staged_active_decoded_cells: usize,
    staged_frame_input: Vec<u8>,
    // Display streams can overtake the reliable dictionary-install control
    // lane after the daemon promotes an acknowledged dictionary. Retain the
    // immediately previous dictionary so those already-sent frames remain
    // decodable. The fixed pair reuses both Vec allocations after warmup.
    display_dictionaries: [DisplayDictionarySlot; 2],
    // Rebuilt whenever a dictionary slot changes, because ruzstd's dictionary
    // map has no removal API and a session would otherwise retain every
    // dictionary revision it ever saw. Installs are rare; frames are not.
    display_decoder: zstd_safe::DCtx<'static>,
    /// Decompressed split payload of the frame being staged, before the join.
    /// Reused across frames; bounded by the envelope's row-body length.
    display_decoded_split: Vec<u8>,
    /// Joined rows of the frame being staged. Reused across frames and
    /// bounded by `MAX_DISPLAY_FRAME_BYTES`, like `staged_frame_input`.
    display_decoded_rows: Vec<u8>,
    full_damage: bool,
    display_mode: u32,
    // The routing bits of `display_mode` are the daemon's input-routing word,
    // not the last header's. The terminal worker knows where the word stands in
    // the display stream and releases it when a header captured after it applies.
    input_routing_held: bool,
    last_error: Option<String>,
    // col, row, shape, visible, safe append-only insertion, fg RGB, bg RGB.
    cursor_info_buf: [u16; 11],
    received_cursor_info_buf: [u16; 4],
    prediction_model_buf: [u32; 6],
    cell_metrics_buf: [f32; 4],
    atlas_dirty_buf: [u32; 4],
    // Printable ASCII metadata from the exact fontdue/WebGL atlas cache:
    // atlas x/y, width/height, and physical-pixel x/y bearings.
    speculative_ascii_entries: [i32; SPECULATIVE_ASCII_ENTRIES_LEN],
    missing_buf: Vec<u32>,
    // confirmed, mismatched, expired-covered, no-credit,
    // discarded-after-mismatch, transient-mismatch-deferred, expired-stalled.
    // A single authoritative contradiction can invalidate a long speculative
    // tail; keeping that neutral tail separate prevents one event from being
    // misreported as many independent accuracy failures. The two expiry slots
    // are separate for the same reason in the other direction: a retirement
    // authority never reached is a stalled link, not a wrong prediction, and
    // the worker's trust gate must not count it.
    reconcile_stats: [u32; 7],
    // Font atlas and cached render geometry.
    atlas: Option<atlas::GlyphAtlas>,
    cell_dpr: f32,
    bg_buf: Vec<f32>,     // 7 f32/instance: [x, y, w, h, r, g, b]
    glyph_buf: Vec<f32>,  // 14 f32/instance: [cx, cy, ox, oy, gw, gh, u0, v0, u1, v1, r, g, b, a]
    deco_buf: Vec<f32>,   // 7 f32/instance: [x, y, w, h, r, g, b]
    cursor_buf: Vec<f32>, // 8 f32/instance: [x, y, w, h, r, g, b, shape]
    // Post-build render metadata, grouped as
    // [ptr, count, version, dirty_offset, dirty_count] for bg/glyph/deco/cursor.
    // JS holds a view over this fixed array, replacing twenty wasm boundary
    // calls with one stable memory read while the legacy getters remain an
    // independent compatibility/correctness oracle.
    geometry_state: [u32; GEOMETRY_STATE_LEN],
    row_geometry: Vec<RowGeometry>,
    /// Atlas layout generation used by the cached normalized glyph UVs.
    geometry_atlas_generation: u32,
    bg_version: u32,
    glyph_version: u32,
    deco_version: u32,
    cursor_version: u32,
    bg_dirty: (u32, u32),
    glyph_dirty: (u32, u32),
    deco_dirty: (u32, u32),
    cursor_dirty: (u32, u32),
    geometry_buffers_initialized: bool,
    display_row_versions: Vec<u32>,
    display_cell_versions: Vec<u32>,
    /// OSC 8 link id per authoritative cell, row-major, 0 for none. Beside the
    /// grid rather than in `Cell::extra`: the id is all the row hash and the
    /// browser's link resolution need, and the grid's `Hyperlink` would cost an
    /// allocation per linked cell for a URI the main thread already holds.
    display_cell_links: Vec<u32>,
    /// Link identity committed with the exact cells the host presents.
    #[cfg(not(target_arch = "wasm32"))]
    presentation_cell_links: Vec<u32>,
    /// Presentation commits so far, and for each row the commit that last
    /// rewrote its cells or links. A native host that has shown a row at its
    /// commit shows it still, and skips reading it.
    #[cfg(not(target_arch = "wasm32"))]
    presentation_commits: u64,
    #[cfg(not(target_arch = "wasm32"))]
    presentation_row_commits: Vec<u64>,
    /// Linked cells per authoritative row, so hashing a row without a link —
    /// nearly every row — skips the scan for one.
    display_row_link_cells: Vec<u16>,
    /// Streaming validation's buffer for one row's link span table.
    display_link_table_scratch: Vec<u8>,
    // Monotonic local evidence that a frame actually carried each exact cell.
    // Wire display sequence is insufficient here: snapshots may use seq=0 and
    // sparse row repairs carry a global cursor from an unrelated row.
    authoritative_cell_revisions: Vec<u32>,
    authoritative_revision: u32,
    authoritative_header_revision: u32,
    authoritative_cursor_visible: bool,
    display_header_version: u32,
    last_applied_display_header: Option<PendingDisplayHeader>,
    last_apply_visually_changed: bool,
    // IME preedit overlay: the in-progress composition string rendered inline
    // at the cursor. Never written to the grid; appended to the geometry
    // buffers each build like predictions.
    preedit_chars: Vec<char>,
    preedit_caret: usize,
    preedit_dirty: bool,
    theme: RenderTheme,
    predictions: Vec<Prediction>,
    predicted_cursor: (u16, u16),
    shadow_line: Option<ShadowLine>,
    shadow_row_projected: bool,
    shadow_replay_scratch: ShadowState,
    // Received rows and cursor must remain known base/operation-prefix states
    // while successful visual retirement waits for a coupled, presented echo.
    shadow_received_compatible: bool,
    /// Row and cursor each match a known prefix, but not the same prefix.
    shadow_received_split: bool,
    shadow_presentation_split: bool,
    shadow_touch_revision_scratch: Vec<u32>,
    #[cfg(test)]
    shadow_sync_count: u32,
    #[cfg(test)]
    display_frame_decode_count: u32,
    prediction_epoch: u32,
    /// Prompt-end (row, col) published by the daemon, or `None` when no editor
    /// boundary is open.
    editor_anchor: Option<(u16, u16)>,
    editor_anchor_generation: u32,
    confirmed_epoch: u32,
    prediction_render_dirty: bool,
    pending_prediction_clear_effects: Vec<PredictionClearEffect>,
    pending_prediction_clear_effects_truncated: bool,
    visible_predictions_scratch: Vec<Prediction>,
    visible_prediction_input_seqs: Vec<u32>,
    visible_prediction_clear_effect_pairs: Vec<u32>,
    visible_prediction_input_seqs_truncated: bool,
    /// Diagnostic journal of backwards steps of the DRAWN cursor.
    ///
    /// Off by default; a diagnostic turns it on and drains it. The render path
    /// pays one already-hot comparison and a branch while it is off.
    cursor_motion_enabled: bool,
    cursor_motion: Vec<u32>,
    cursor_motion_dropped: u32,
    cursor_motion_seq: u32,
    /// The last cursor the renderer was handed: row, column, whether it came
    /// from the shadow model rather than authority, and the presented state's
    /// scroll serial when it was drawn.
    last_drawn_cursor: Option<(u16, u16, bool, u32)>,
    /// Scroll serial of the presented state (`FrameHeader::scroll_serial`).
    presentation_scroll_serial: u32,
    /// The most recent event that moved the model's own cursor.
    cursor_model_cause: CursorCause,
    /// The most recent event that moved the authoritative cursor. Kept apart
    /// from the model's: a drain applies a frame and then reconciles, so one
    /// field would always name the reconciliation, and the step a torn frame
    /// causes would be attributed to the code that cleaned up after it.
    cursor_authority_cause: CursorCause,
    /// Why `ensure_shadow_line` last refused. It has four refusals and they
    /// are not the same defect; the caller flushes with whichever it hit.
    ensure_refusal: CursorCause,
    /// The most recent event that dropped the model, kept separately: an
    /// authoritative apply after a flush overwrites `cursor_cause`, and the
    /// flush is still what took the cursor off the prediction.
    cursor_flush_cause: CursorCause,
}

#[wasm_bindgen]
pub fn init_regular(
    viewport_width: f32,
    viewport_height: f32,
    normal: &[u8],
    px_per_em: f32,
    line_height: f32,
    dpr: f32,
) -> Terminal {
    let normal = load_font(normal);
    let mut atlas = atlas::GlyphAtlas::new(regular_font_aliases(normal));
    apply_cell_metrics_to_atlas(&mut atlas, px_per_em, line_height);
    let (cols, rows) = terminal_size_from_viewport(viewport_width, viewport_height, &atlas, dpr);
    Terminal::new_with_atlas(cols, rows, atlas, dpr)
}

/// Construct the isolated, renderer-free terminal used by browser receiver
/// calibration after the live terminal's first authoritative GPU frame.
///
/// It intentionally owns no font or atlas: calibration exercises only display
/// framing, fused ruzstd validation, and terminal mutation. Keeping this as a
/// distinct instance makes it impossible for calibration rows, dictionaries,
/// ordering, prediction state, or damage to leak into the presented terminal.
#[wasm_bindgen]
pub fn init_display_receiver_calibration(cols: u16, rows: u16) -> Terminal {
    Terminal::new(cols.max(1), rows.max(1))
}

fn terminal_font_settings() -> fontdue::FontSettings {
    fontdue::FontSettings {
        // The terminal rasterizes Unicode scalar values directly and never
        // uses fontdue's indexed shaping API. GSUB traversal would prepare
        // substitution indices that this renderer never requests.
        load_substitutions: false,
        ..fontdue::FontSettings::default()
    }
}

fn load_font(bytes: &[u8]) -> Rc<fontdue::Font> {
    fontdue::Font::from_bytes(bytes, terminal_font_settings())
        .map(Rc::new)
        .expect("terminal font bytes must be valid")
}

fn load_fonts(
    normal: &[u8],
    bold: &[u8],
    italic: &[u8],
    bold_italic: &[u8],
) -> [Rc<fontdue::Font>; 4] {
    let settings = terminal_font_settings();
    let f_normal = load_font(normal);
    let f_bold = fontdue::Font::from_bytes(bold, settings)
        .map(Rc::new)
        .unwrap_or_else(|_| Rc::clone(&f_normal));
    let f_italic = fontdue::Font::from_bytes(italic, settings)
        .map(Rc::new)
        .unwrap_or_else(|_| Rc::clone(&f_normal));
    let f_bold_italic = fontdue::Font::from_bytes(bold_italic, settings)
        .map(Rc::new)
        .unwrap_or_else(|_| Rc::clone(&f_normal));
    [f_normal, f_bold, f_italic, f_bold_italic]
}

fn regular_font_aliases(normal: Rc<fontdue::Font>) -> [Rc<fontdue::Font>; 4] {
    [
        Rc::clone(&normal),
        Rc::clone(&normal),
        Rc::clone(&normal),
        normal,
    ]
}

fn apply_cell_metrics_to_atlas(atlas: &mut atlas::GlyphAtlas, px_per_em: f32, line_height: f32) {
    atlas.px_per_em = px_per_em;

    let font = &atlas.fonts[0];
    let (m_metrics, _) = font.rasterize('M', px_per_em);
    atlas.cell_w = m_metrics.advance_width.round().max(1.0);

    if let Some(lm) = font.horizontal_line_metrics(px_per_em) {
        atlas.cell_h = ((lm.ascent - lm.descent) * line_height).round().max(1.0);
        // The atlas already contains pixel coverage. Translating that bitmap by
        // a fractional pixel would filter it a second time at presentation.
        atlas.baseline = lm.ascent.round();
    } else {
        atlas.cell_h = (px_per_em * line_height).round().max(1.0);
        atlas.baseline = (px_per_em * 0.8).round();
    }
}

fn terminal_size_from_viewport(
    viewport_width: f32,
    viewport_height: f32,
    atlas: &atlas::GlyphAtlas,
    dpr: f32,
) -> (u16, u16) {
    terminal_grid_from_css_cells(
        viewport_width,
        viewport_height,
        (atlas.cell_w / dpr).max(1.0),
        (atlas.cell_h / dpr).max(1.0),
    )
}

/// Viewport pixels to a terminal grid.
///
/// The Rust half of the rule owned by `computeTerminalGrid` in
/// `packages/shared/src/terminal.ts` — this one picks the startup grid, that
/// one every grid after it. Nothing at runtime detects drift between them, so
/// both are pinned to the same vectors by their own suites and the signatures
/// are deliberately identical.
///
/// Both axes floor, so the grid is always the largest one that *fits*. Rows
/// previously rounded, which handed startup a grid up to half a cell taller
/// than the viewport that measured it. The caps come from `merkur_codec`
/// rather than a private copy, and were previously not applied here at all.
fn terminal_grid_from_css_cells(
    viewport_width: f32,
    viewport_height: f32,
    css_cell_w: f32,
    css_cell_h: f32,
) -> (u16, u16) {
    let cols = floor_terminal_dimension(viewport_width / css_cell_w, MAX_TERMINAL_COLUMNS);
    let rows = floor_terminal_dimension(viewport_height / css_cell_h, MAX_TERMINAL_ROWS);
    if usize::from(cols) * usize::from(rows) <= MAX_TERMINAL_CELLS {
        return (cols, rows);
    }
    (cols, (MAX_TERMINAL_CELLS / usize::from(cols)).max(1) as u16)
}

/// Floors one axis into `1..=maximum`. A non-finite ratio — an unmeasured
/// viewport, or a cell size of zero — yields the minimum grid rather than a
/// zero, negative, or saturated one.
fn floor_terminal_dimension(cells: f32, maximum: usize) -> u16 {
    if !cells.is_finite() || cells < 1.0 {
        return 1;
    }
    (cells.floor() as usize).min(maximum) as u16
}

/// Native-only construction, for harnesses that drive the real terminal from
/// Rust rather than from a browser.
///
/// Safe Rust access for the shared client grid adapter, outside the
/// `#[wasm_bindgen]` impl. A renderer initializes its font and viewport through
/// `init_regular`; renderer-free clients initialize an exact headless grid.
impl Terminal {
    /// A different account owns no received cells, modes or speculative state.
    /// Only local font resources and render configuration survive replacement.
    pub(crate) fn fresh_display_session(&mut self) -> Terminal {
        let mut next = Terminal::new(self.cols(), self.rows());
        next.atlas = self.atlas.take();
        next.cell_metrics_buf = self.cell_metrics_buf;
        next.cell_dpr = self.cell_dpr;
        next.theme = self.theme;
        next.cursor_motion_enabled = self.cursor_motion_enabled;
        next.bg_version = self.bg_version.wrapping_add(1);
        next.glyph_version = self.glyph_version.wrapping_add(1);
        next.deco_version = self.deco_version.wrapping_add(1);
        next.cursor_version = self.cursor_version.wrapping_add(1);
        next.presentation_revision = self.presentation_revision.wrapping_add(1);
        next
    }

    pub fn new_headless(cols: u16, rows: u16) -> Terminal {
        Terminal::new(cols, rows)
    }

    /// Native equivalent of the browser's reserve → write → stage sequence.
    ///
    /// The browser reserves a capacity, writes the frame into linear memory
    /// through the returned pointer, then stages it. This performs the same
    /// three steps with a safe direct copy in place of the pointer write, so
    /// the real capacity gate and staging path — including fused zstd validation — run
    /// exactly as they do in the browser.
    pub fn stage_display_frame_bytes(&mut self, bytes: &[u8]) -> u32 {
        let Ok(len) = u32::try_from(bytes.len()) else {
            self.last_error = Some(String::from("display_stage_length_invalid"));
            return 0;
        };
        if self.reserve_display_frame_input(len) == 0 {
            return 0;
        }
        self.staged_frame_input[..bytes.len()].copy_from_slice(bytes);
        self.stage_display_frame_input(len)
    }

    /// The mode half of `prediction_mode_is_unsafe`, which the input path
    /// asks before a key is modelled: `terminalModeAllowsPrediction`.
    pub fn prediction_granted(&self) -> bool {
        mode_grants_prediction(self.mouse_mode())
    }

    pub fn alt_screen_active(&self) -> bool {
        self.mouse_mode() & DISPLAY_MODE_ALT_SCREEN != 0
    }

    /// The presented scene's graphics revision: it advances whenever a
    /// presentation commit changes a placement, and is 0 before any.
    pub fn graphics_revision(&self) -> u32 {
        self.geometry_state[GEOMETRY_STATE_LEN - 1]
    }

    /// The presented scene's placement fragments, 124 bytes each, as the
    /// browser's `graphicsFragments` reads them.
    pub fn graphics_fragments(&mut self) -> &[u8] {
        self.graphics.as_mut().map_or(&[][..], |rows| rows.export())
    }

    /// What the last [`Self::predict_reconcile`] retired: `[confirmed,
    /// mismatched, expired_covered, _, discarded, deferred_mismatch,
    /// expired_stalled]`, as `reconcile_stats_ptr` shows the browser.
    pub fn reconcile_stats(&self) -> [u32; 7] {
        self.reconcile_stats
    }

}

#[cfg(not(target_arch = "wasm32"))]
impl Terminal {
    /// Row `row` of the presentation, with the visible speculative echo over
    /// it as the browser draws it: what a native host shows there.
    pub fn displayed_row(&self, row: u16, out: &mut Vec<DisplayedCell>) {
        out.clear();
        let grid = &self.presentation_grid;
        if usize::from(row) >= grid.screen_lines() {
            return;
        }
        let line = Line(i32::from(row));
        out.extend(
            (0..grid.columns())
                .map(|col| DisplayedCell::from_cell(&grid[Point::new(line, Column(col))])),
        );
        for prediction in self
            .predictions
            .iter()
            .filter(|prediction| prediction.row == row && self.prediction_is_visible(prediction))
        {
            let col = usize::from(prediction.col);
            let Some(cell) = out.get_mut(col) else {
                continue;
            };
            *cell = DisplayedCell {
                c: match prediction.kind {
                    PredKind::Char => char::from_u32(prediction.codepoint).unwrap_or(' '),
                    PredKind::ClearBack => ' ',
                },
                fg: displayed_color(
                    prediction_color_at(grid, usize::from(row), col),
                    NamedColor::Foreground,
                ),
                bg: cell.bg,
                attrs: 0,
            };
        }
    }

    /// OSC 8 identities of the presentation, with speculative cells unlinked.
    pub fn displayed_links(&self, row: u16, out: &mut Vec<u32>) {
        out.clear();
        let columns = self.presentation_grid.columns();
        let start = usize::from(row) * columns;
        if let Some(links) = self.presentation_cell_links.get(start..start + columns) {
            out.extend_from_slice(links);
        }
        for prediction in self
            .predictions
            .iter()
            .filter(|prediction| prediction.row == row && self.prediction_is_visible(prediction))
        {
            if let Some(link) = out.get_mut(usize::from(prediction.col)) {
                *link = 0;
            }
        }
    }

    /// The presentation commit that last rewrote row `row`'s cells or links;
    /// it only ever advances. A host that has shown the row at this commit
    /// shows it still, unless the row holds a prediction. `None` outside the
    /// committed grid.
    pub fn presentation_row_commit(&self, row: u16) -> Option<u64> {
        self.presentation_row_commits.get(usize::from(row)).copied()
    }

    /// Whether a speculative echo sits on row `row`, shown or not. Such a row
    /// can differ from one read to the next with no commit between them.
    pub fn row_holds_prediction(&self, row: u16) -> bool {
        self.predictions
            .iter()
            .any(|prediction| prediction.row == row)
    }

    /// Where a native host shows the cursor, and as what; `None` when hidden
    /// or outside the grid. The speculative echo's cursor while it is visible.
    pub fn displayed_cursor(&self) -> Option<DisplayedCursor> {
        let shape = match self.presentation_cursor_shape {
            CursorShape::Hidden => return None,
            CursorShape::Beam => DisplayedCursorShape::Beam,
            CursorShape::Underline => DisplayedCursorShape::Underline,
            CursorShape::Block | CursorShape::HollowBlock => DisplayedCursorShape::Block,
        };
        let (row, col) = if self.shadow_cursor_is_visible() {
            self.predicted_cursor
        } else {
            let point = point_to_viewport(0, self.presentation_grid.cursor.point)?;
            (
                clamp_usize_to_u16(point.line),
                clamp_usize_to_u16(point.column.0),
            )
        };
        Some(DisplayedCursor { row, col, shape })
    }
}

/// One cell as a native host shows it. A `None` colour is the default of the
/// terminal showing it, which is what the daemon's own default means.
#[cfg(not(target_arch = "wasm32"))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DisplayedCell {
    pub c: char,
    pub fg: Option<[u8; 3]>,
    pub bg: Option<[u8; 3]>,
    /// `DISPLAYED_*` bits.
    pub attrs: u8,
}

#[cfg(not(target_arch = "wasm32"))]
pub const DISPLAYED_BOLD: u8 = 1;
#[cfg(not(target_arch = "wasm32"))]
pub const DISPLAYED_ITALIC: u8 = 1 << 1;
#[cfg(not(target_arch = "wasm32"))]
pub const DISPLAYED_UNDERLINE: u8 = 1 << 2;
#[cfg(not(target_arch = "wasm32"))]
pub const DISPLAYED_INVERSE: u8 = 1 << 3;
/// A character two columns wide, whose second column is the next cell.
#[cfg(not(target_arch = "wasm32"))]
pub const DISPLAYED_WIDE: u8 = 1 << 4;
/// The second column of a wide character.
#[cfg(not(target_arch = "wasm32"))]
pub const DISPLAYED_SPACER: u8 = 1 << 5;

#[cfg(not(target_arch = "wasm32"))]
impl DisplayedCell {
    pub const BLANK: DisplayedCell = DisplayedCell {
        c: ' ',
        fg: None,
        bg: None,
        attrs: 0,
    };

    fn from_cell(cell: &Cell) -> DisplayedCell {
        let mut attrs = 0;
        for (flag, bit) in [
            (Flags::BOLD, DISPLAYED_BOLD),
            (Flags::ITALIC, DISPLAYED_ITALIC),
            (Flags::INVERSE, DISPLAYED_INVERSE),
            (Flags::WIDE_CHAR, DISPLAYED_WIDE),
            (Flags::WIDE_CHAR_SPACER, DISPLAYED_SPACER),
        ] {
            if cell.flags.contains(flag) {
                attrs |= bit;
            }
        }
        if cell.flags.intersects(Flags::ALL_UNDERLINES) {
            attrs |= DISPLAYED_UNDERLINE;
        }
        DisplayedCell {
            c: if cell.c == '\0' { ' ' } else { cell.c },
            fg: displayed_color(cell.fg, NamedColor::Foreground),
            bg: displayed_color(cell.bg, NamedColor::Background),
            attrs,
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DisplayedCursorShape {
    Block,
    Underline,
    Beam,
}

#[cfg(not(target_arch = "wasm32"))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DisplayedCursor {
    pub row: u16,
    pub col: u16,
    pub shape: DisplayedCursorShape,
}

/// `color`, or `None` for the default it names.
#[cfg(not(target_arch = "wasm32"))]
fn displayed_color(color: Color, default: NamedColor) -> Option<[u8; 3]> {
    match color {
        Color::Named(named) if named == default => None,
        color => Some(resolve_color(color)),
    }
}

/// Test-only row reader. Assertions want one row with its blank tail removed,
/// which is exactly the trim `viewport_rows` must not do for real selections.
#[cfg(test)]
impl Terminal {
    fn row_text(&self, row: usize) -> String {
        self.viewport_rows()
            .split('\n')
            .nth(row)
            .unwrap_or_default()
            .trim_end()
            .to_string()
    }
}

#[wasm_bindgen]
impl Terminal {
    pub fn graphics_ptr(&mut self) -> *const u8 {
        self.graphics
            .as_mut()
            .map_or(std::ptr::null(), |rows| rows.export().as_ptr())
    }
    pub fn graphics_len(&mut self) -> usize {
        self.graphics.as_mut().map_or(0, |rows| rows.export().len())
    }

    fn new(cols: u16, rows: u16) -> Terminal {
        let dimensions = create_dimensions(cols, rows);
        // No scrollback. This grid only ever holds the viewport the daemon
        // sends it, and nothing scrolls it. The capacity is not free once
        // reflow is live: a column shrink pushes the rows it wraps off the top
        // into history, where at the default 10 000 lines they would
        // accumulate across every drag of a window edge and pin up to a
        // hundred megabytes of `Cell` in the worker's heap for content no one
        // can scroll back to. At zero, reflow keeps the newest `rows` lines and
        // drops the rest — which is exactly what the viewport shows.
        let config = Config {
            scrolling_history: 0,
            ..Config::default()
        };
        let term = Term::new(config, &dimensions, WasmEventListener);
        let presentation_grid = Grid::new(dimensions.rows, dimensions.cols, 0);
        let presentation_cursor_shape = term.renderable_content().cursor.shape;

        let mut terminal = Terminal {
            graphics: None,
            frame_graphics_scratch: Vec::new(),
            term,
            presentation_grid,
            presentation_cursor_shape,
            presentation_dirty_rows: Vec::with_capacity(dimensions.rows),
            presentation_dirty_set: vec![0; dimensions.rows],
            presentation_full_pending: true,
            presentation_header_pending: true,
            presentation_cursor_dirty: true,
            presentation_revision: 0,
            presentation_row_versions: vec![0; dimensions.rows],
            presentation_editor_anchor: None,
            presentation_editor_anchor_generation: 0,
            damaged_rows: Vec::with_capacity(dimensions.rows),
            damaged_row_set: vec![false; dimensions.rows],
            hash_digest_scratch: Vec::new(),
            row_hashes: Vec::new(),
            row_hash_dirty: Vec::new(),
            row_hash_dirty_list: Vec::new(),
            row_hash_all_dirty: true,
            frame_rows_scratch: Vec::new(),
            frame_cells_scratch: Vec::new(),
            frame_row_seen_scratch: Vec::new(),
            staged_frames: Vec::new(),
            staged_frame_free_slots: Vec::new(),
            staged_frame_pool: Vec::new(),
            staged_validation_pool: Vec::new(),
            staged_validation_pool_cell_capacity: 0,
            staged_validation_pool_graphics_capacity: 0,
            staged_active_wire_bytes: 0,
            staged_active_decoded_bytes: 0,
            staged_active_decoded_cells: 0,
            staged_frame_input: Vec::new(),
            display_dictionaries: [
                DisplayDictionarySlot::empty(),
                DisplayDictionarySlot::empty(),
            ],
            display_decoder: new_display_decoder(),
            display_decoded_split: Vec::new(),
            display_decoded_rows: Vec::new(),
            full_damage: true,
            display_mode: 0,
            input_routing_held: false,
            last_error: None,
            cursor_info_buf: [
                0,
                0,
                1,
                1,
                0,
                u16::from(DEFAULT_FOREGROUND[0]),
                u16::from(DEFAULT_FOREGROUND[1]),
                u16::from(DEFAULT_FOREGROUND[2]),
                u16::from(DEFAULT_BACKGROUND[0]),
                u16::from(DEFAULT_BACKGROUND[1]),
                u16::from(DEFAULT_BACKGROUND[2]),
            ],
            prediction_model_buf: [0; 6],
            received_cursor_info_buf: [0; 4],
            cell_metrics_buf: [8.0, 16.0, 13.0, 1.0],
            atlas_dirty_buf: [0, 0, 0, 0],
            speculative_ascii_entries: [0; SPECULATIVE_ASCII_ENTRIES_LEN],
            missing_buf: Vec::new(),
            reconcile_stats: [0; 7],
            atlas: None,
            cell_dpr: 1.0,
            bg_buf: Vec::new(),
            glyph_buf: Vec::new(),
            deco_buf: Vec::new(),
            cursor_buf: Vec::new(),
            geometry_state: [0; GEOMETRY_STATE_LEN],
            row_geometry: Vec::new(),
            geometry_atlas_generation: 0,
            bg_version: 1,
            glyph_version: 1,
            deco_version: 1,
            cursor_version: 1,
            bg_dirty: (0, 0),
            glyph_dirty: (0, 0),
            deco_dirty: (0, 0),
            cursor_dirty: (0, 0),
            geometry_buffers_initialized: false,
            display_row_versions: Vec::new(),
            display_cell_versions: Vec::new(),
            display_cell_links: Vec::new(),
            #[cfg(not(target_arch = "wasm32"))]
            presentation_cell_links: Vec::new(),
            #[cfg(not(target_arch = "wasm32"))]
            presentation_commits: 0,
            #[cfg(not(target_arch = "wasm32"))]
            presentation_row_commits: Vec::new(),
            display_row_link_cells: Vec::new(),
            display_link_table_scratch: Vec::new(),
            authoritative_cell_revisions: Vec::new(),
            authoritative_revision: 0,
            authoritative_header_revision: 0,
            authoritative_cursor_visible: true,
            display_header_version: 0,
            last_applied_display_header: None,
            presentation_scroll_serial: 0,
            last_apply_visually_changed: false,
            preedit_chars: Vec::new(),
            preedit_caret: 0,
            preedit_dirty: false,
            theme: RenderTheme::default(),
            predictions: Vec::new(),
            predicted_cursor: (0, 0),
            shadow_line: None,
            shadow_row_projected: false,
            shadow_replay_scratch: ShadowState::default(),
            shadow_received_compatible: true,
            shadow_received_split: false,
            shadow_presentation_split: false,
            shadow_touch_revision_scratch: Vec::new(),
            #[cfg(test)]
            shadow_sync_count: 0,
            #[cfg(test)]
            display_frame_decode_count: 0,
            prediction_epoch: 1,
            editor_anchor: None,
            editor_anchor_generation: 0,
            confirmed_epoch: 0,
            prediction_render_dirty: false,
            pending_prediction_clear_effects: Vec::with_capacity(
                INITIAL_VISIBLE_PREDICTION_EFFECT_CAPACITY,
            ),
            pending_prediction_clear_effects_truncated: false,
            visible_predictions_scratch: Vec::new(),
            visible_prediction_input_seqs: Vec::with_capacity(
                INITIAL_VISIBLE_PREDICTION_EFFECT_CAPACITY,
            ),
            visible_prediction_clear_effect_pairs: Vec::with_capacity(
                INITIAL_VISIBLE_PREDICTION_EFFECT_CAPACITY,
            ),
            visible_prediction_input_seqs_truncated: false,
            cursor_motion_enabled: false,
            cursor_motion: Vec::new(),
            cursor_motion_dropped: 0,
            cursor_motion_seq: 0,
            last_drawn_cursor: None,
            cursor_model_cause: CursorCause::Unknown,
            cursor_authority_cause: CursorCause::Unknown,
            ensure_refusal: CursorCause::Unknown,
            cursor_flush_cause: CursorCause::Unknown,
        };
        terminal.refresh_geometry_state();
        terminal
    }

    fn new_with_atlas(cols: u16, rows: u16, atlas: atlas::GlyphAtlas, dpr: f32) -> Terminal {
        let mut terminal = Terminal::new(cols, rows);
        terminal.cell_metrics_buf = [atlas.cell_w, atlas.cell_h, atlas.baseline, dpr];
        terminal.cell_dpr = dpr;
        terminal.atlas = Some(atlas);
        terminal.full_damage = true;
        terminal
    }

    pub fn apply_state_seq(&mut self, data: &[u8], seq: u32) -> bool {
        // A snapshot changes the prediction lineage even when its geometry is
        // unchanged. Re-enter through a tentative epoch instead of projecting
        // edits over state whose causal history was replaced.
        self.predict_flush_because(CursorCause::FlushSnapshot);
        self.apply_frame(data, true, seq)
    }

    pub fn apply_delta_seq(&mut self, data: &[u8], seq: u32) -> bool {
        self.apply_frame(data, false, seq)
    }

    pub fn install_display_dictionary(
        &mut self,
        generation: u32,
        id: u32,
        hash: u32,
        bytes: &[u8],
    ) -> bool {
        if generation == 0 || id == 0 || bytes.is_empty() {
            return false;
        }
        let actual_hash = (merkur_codec::hash_bytes(bytes) >> 32) as u32;
        if actual_hash != hash {
            return false;
        }
        // Reliable control can still be duplicated across transport fallback.
        // An exact duplicate must be idempotent: rotating a repeated previous
        // install back to current would evict the dictionary frames now use.
        for slot in &self.display_dictionaries {
            if slot.matches(generation, id, hash) {
                return slot.bytes == bytes;
            }
        }

        // A dictionary that will not parse can never decode a frame, and
        // accepting it would leave the peer compressing against a slot the
        // browser believes it holds. Only a finalized dictionary carries the
        // magic and id; given that magic, libzstd parses the entropy tables
        // and refuses a corrupt dictionary instead of loading raw content.
        let Some(zstd_id) = zstd_safe::get_dict_id_from_dict(bytes) else {
            return false;
        };
        let Some(ddict) = zstd_safe::DDict::try_create(bytes) else {
            return false;
        };

        let retain_current = !self.display_dictionaries[CURRENT_DISPLAY_DICTIONARY]
            .bytes
            .is_empty()
            && self.display_dictionaries[CURRENT_DISPLAY_DICTIONARY].generation == generation;
        if retain_current {
            self.display_dictionaries
                .swap(CURRENT_DISPLAY_DICTIONARY, PREVIOUS_DISPLAY_DICTIONARY);
        } else {
            // A terminal generation boundary is a hard cut: accepting a frame
            // from the prior session would cross ordering/security lineage.
            self.display_dictionaries[PREVIOUS_DISPLAY_DICTIONARY].clear();
        }
        self.display_dictionaries[CURRENT_DISPLAY_DICTIONARY].replace(
            generation,
            id,
            hash,
            zstd_id.get(),
            bytes,
            ddict,
        );
        true
    }

    /// Drop codec state at an authenticated-session boundary without touching
    /// the terminal grid or font atlas. Slot allocations remain reusable, but
    /// every replaced/cleared live range is zeroed before its length is reset.
    pub fn clear_display_dictionaries(&mut self) {
        for dictionary in &mut self.display_dictionaries {
            dictionary.clear();
        }
    }

    /// Reserve the one reusable JS -> WASM ingress buffer. JS caches this
    /// pointer and calls this again only when a larger frame arrives.
    pub fn reserve_display_frame_input(&mut self, capacity: u32) -> usize {
        let capacity = capacity as usize;
        if !(STREAM_HEADER_BYTES + FRAME_HEADER_BODY_BYTES..=MAX_DISPLAY_FRAME_BYTES)
            .contains(&capacity)
        {
            self.last_error = Some(String::from("display_stage_length_invalid"));
            return 0;
        }
        if self.staged_frame_input.len() < capacity {
            self.staged_frame_input.resize(capacity, 0);
        }
        self.last_error = None;
        self.staged_frame_input.as_mut_ptr() as usize
    }

    /// Copy/decompress the reusable ingress bytes into a terminal-owned queue
    /// slot and return its handle. This is the sole production apply path.
    pub fn stage_display_frame_input(&mut self, len: u32) -> u32 {
        let len = len as usize;
        if len < STREAM_HEADER_BYTES + FRAME_HEADER_BODY_BYTES
            || len > self.staged_frame_input.len()
        {
            self.last_error = Some(String::from("display_stage_length_invalid"));
            return 0;
        }
        let admission = match self.preflight_staged_display_frame(&self.staged_frame_input[..len]) {
            Ok(admission) => admission,
            Err(error) => {
                self.last_error = Some(String::from(error));
                return 0;
            }
        };
        let slot = if let Some(slot) = self.staged_frame_free_slots.last().copied() {
            slot
        } else if self.staged_frames.len() < STAGED_FRAME_MAX {
            self.staged_frames.len()
        } else {
            self.last_error = Some(String::from("display_stage_slot_limit"));
            return 0;
        };
        let input = std::mem::take(&mut self.staged_frame_input);
        let (data, validation) = if admission.compressed {
            let Some(validation) = self.decode_compressed_frame(
                &input[..len],
                admission.header,
                admission.budget.decoded_bytes,
            ) else {
                self.staged_frame_input = input;
                return 0;
            };
            (Vec::new(), Some(validation))
        } else {
            let mut data = self.staged_frame_pool.pop().unwrap_or_default();
            data.clear();
            data.extend_from_slice(&input[..len]);
            (data, None)
        };
        self.staged_frame_input = input;
        let staged = StagedDisplayFrame {
            data,
            validation,
            budget: admission.budget,
        };
        if slot == self.staged_frames.len() {
            self.staged_frames.push(Some(staged));
        } else {
            // Slot ownership must move in release builds too. A side effect
            // inside debug_assert disappears under optimization, leaving this
            // live slot on the free list for the next decoded datagram.
            let acquired_slot = self.staged_frame_free_slots.pop();
            debug_assert_eq!(acquired_slot, Some(slot));
            debug_assert!(self.staged_frames[slot].is_none());
            self.staged_frames[slot] = Some(staged);
        }
        self.staged_active_wire_bytes += admission.budget.wire_bytes;
        self.staged_active_decoded_bytes += admission.budget.decoded_bytes;
        self.staged_active_decoded_cells += admission.budget.decoded_cells;
        self.last_error = None;
        u32::try_from(slot + 1).unwrap_or(0)
    }

    fn preflight_staged_display_frame(
        &self,
        data: &[u8],
    ) -> Result<StagedDisplayAdmission, &'static str> {
        let rows_offset = STREAM_HEADER_BYTES + FRAME_HEADER_BODY_BYTES;
        let stream = parse_stream_header(data).ok_or("display_stage_envelope_invalid")?;
        if stream.msg_type != MSG_TYPE_DISPLAY_PATCH
            || stream.body_len as usize != data.len().saturating_sub(STREAM_HEADER_BYTES)
            || data.len() > MAX_DISPLAY_FRAME_BYTES
            || data.get(DISPLAY_VERSION_OFFSET).copied() != Some(VERSION)
            || stream.generation == 0
        {
            return Err("display_stage_envelope_invalid");
        }
        let header = parse_frame_header(data).map_err(|_| "display_stage_envelope_invalid")?;
        if matches!(header.kind, FrameKind::Delta) && stream.seq == 0 {
            return Err("display_stage_sequence_invalid");
        }
        let bounds = validate_display_frame_header(header).map_err(|error| error.code())?;
        let compressed = stream.flags & DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD != 0;
        let uses_dictionary = stream.flags & DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD_DICT != 0;
        if uses_dictionary && !compressed {
            return Err("compressed_display_metadata_mismatch");
        }
        let decoded_bytes = if compressed {
            let payload_offset = if uses_dictionary {
                DISPLAY_DICT_COMPRESSED_PAYLOAD_OFFSET
            } else {
                DISPLAY_COMPRESSED_PAYLOAD_OFFSET
            };
            if data.len() <= payload_offset {
                return Err("compressed_display_payload_missing");
            }
            let rows_len = u32::from_be_bytes(
                data[DISPLAY_COMPRESSED_LENGTH_OFFSET..DISPLAY_COMPRESSED_LENGTH_OFFSET + 4]
                    .try_into()
                    .expect("fixed compressed length field"),
            ) as usize;
            if rows_offset
                .checked_add(rows_len)
                .is_none_or(|end| end > MAX_DISPLAY_FRAME_BYTES)
            {
                return Err("compressed_display_rows_too_large");
            }
            rows_len
        } else {
            data.len()
                .checked_sub(rows_offset)
                .ok_or("display_stage_envelope_invalid")?
        };
        let budget = StagedDisplayBudget {
            wire_bytes: data.len(),
            decoded_bytes,
            decoded_cells: bounds.max_decoded_cells,
        };
        if self
            .staged_active_wire_bytes
            .checked_add(budget.wire_bytes)
            .is_none_or(|total| total > STAGED_ACTIVE_MAX_WIRE_BYTES)
            || self
                .staged_active_decoded_bytes
                .checked_add(budget.decoded_bytes)
                .is_none_or(|total| total > STAGED_ACTIVE_MAX_DECODED_BYTES)
            || self
                .staged_active_decoded_cells
                .checked_add(budget.decoded_cells)
                .is_none_or(|total| total > STAGED_ACTIVE_MAX_CELL_BUDGET)
        {
            return Err("display_stage_active_budget_exceeded");
        }
        Ok(StagedDisplayAdmission {
            header,
            budget,
            compressed,
        })
    }

    fn decode_compressed_frame(
        &mut self,
        data: &[u8],
        header: FrameHeader,
        rows_len: usize,
    ) -> Option<StagedDisplayValidation> {
        let uses_dictionary =
            data[DISPLAY_HEADER_FLAGS_OFFSET] & DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD_DICT != 0;
        let payload_offset = if uses_dictionary {
            DISPLAY_DICT_COMPRESSED_PAYLOAD_OFFSET
        } else {
            DISPLAY_COMPRESSED_PAYLOAD_OFFSET
        };
        let payload = &data[payload_offset..];
        let Some(zstd_metadata) = parse_zstd_frame_metadata(payload) else {
            self.last_error = Some(String::from("compressed_display_metadata_mismatch"));
            return None;
        };
        if zstd_metadata.window_size > DISPLAY_ZSTD_MAX_WINDOW_BYTES {
            self.last_error = Some(String::from("compressed_display_window_too_large"));
            return None;
        }
        let dictionary_slot = if uses_dictionary {
            let generation = u32::from_be_bytes(
                data[DISPLAY_GENERATION_OFFSET..DISPLAY_GENERATION_OFFSET + 4]
                    .try_into()
                    .expect("generation field"),
            );
            let id = u32::from_be_bytes(
                data[DISPLAY_COMPRESSED_LENGTH_OFFSET + 4..DISPLAY_COMPRESSED_LENGTH_OFFSET + 8]
                    .try_into()
                    .expect("dictionary id field"),
            );
            let hash = u32::from_be_bytes(
                data[DISPLAY_COMPRESSED_LENGTH_OFFSET + 8..DISPLAY_COMPRESSED_LENGTH_OFFSET + 12]
                    .try_into()
                    .expect("dictionary hash field"),
            );
            if self.display_dictionaries[CURRENT_DISPLAY_DICTIONARY].matches(generation, id, hash) {
                Some(CURRENT_DISPLAY_DICTIONARY)
            } else if self.display_dictionaries[PREVIOUS_DISPLAY_DICTIONARY]
                .matches(generation, id, hash)
            {
                Some(PREVIOUS_DISPLAY_DICTIONARY)
            } else {
                self.last_error = Some(String::from("compressed_display_dictionary_missing"));
                return None;
            }
        } else {
            None
        };
        let expected_zstd_dictionary_id =
            dictionary_slot.map(|slot| self.display_dictionaries[slot].zstd_id);
        if zstd_metadata.dictionary_id != expected_zstd_dictionary_id {
            self.last_error = Some(String::from("compressed_display_metadata_mismatch"));
            return None;
        }
        if zstd_frame_size(payload, zstd_metadata.header_len) != Some(payload.len()) {
            self.last_error = Some(String::from("compressed_display_trailing_or_checksum"));
            return None;
        }
        #[cfg(test)]
        {
            self.display_frame_decode_count = self.display_frame_decode_count.saturating_add(1);
        }
        // One-shot decode into the reusable split buffer. A split payload is
        // its rows less two bytes a row plus a header of at most
        // `SPLIT_HEADER_MAX_BYTES`, so this capacity bounds what libzstd may
        // write; the join below proves the exact length.
        self.display_decoded_split.clear();
        self.display_decoded_split
            .reserve(rows_len + merkur_codec::SPLIT_HEADER_MAX_BYTES);
        let decompressed = match dictionary_slot {
            Some(slot) => {
                let Some(ddict) = self.display_dictionaries[slot].ddict.as_ref() else {
                    self.last_error = Some(String::from("compressed_display_dictionary_missing"));
                    return None;
                };
                self.display_decoder.decompress_using_ddict(
                    &mut self.display_decoded_split,
                    payload,
                    ddict,
                )
            }
            None => self
                .display_decoder
                .decompress(&mut self.display_decoded_split, payload),
        };
        if decompressed.is_err() {
            self.last_error = Some(String::from("compressed_display_trailing_or_checksum"));
            return None;
        }
        if merkur_codec::join_rows_into(
            &self.display_decoded_split,
            header.row_count,
            &mut self.display_decoded_rows,
        )
        .is_err()
            || self.display_decoded_rows.len() != rows_len
        {
            self.last_error = Some(String::from("compressed_display_split_invalid"));
            return None;
        }
        let mut decoded = self.take_staged_validation();
        let validation = validate_display_rows(
            header,
            &self.display_decoded_rows,
            &mut decoded.rows,
            &mut decoded.cells,
            &mut decoded.row_seen,
            &mut decoded.graphics,
            &mut self.display_link_table_scratch,
        );
        match validation {
            Ok(()) => Some(StagedDisplayValidation {
                header,
                decoded,
                graphics: None,
            }),
            Err(error) => {
                self.recycle_staged_validation(decoded);
                self.last_error = Some(String::from(error.code()));
                None
            }
        }
    }

    pub fn validate_staged_frame(&mut self, handle: u32) -> bool {
        let Some(slot) = usize::try_from(handle)
            .ok()
            .and_then(|value| value.checked_sub(1))
            .filter(|slot| *slot < self.staged_frames.len())
        else {
            self.last_error = Some(String::from("display_stage_handle_invalid"));
            return false;
        };
        let Some(mut staged) = self.staged_frames[slot].take() else {
            self.last_error = Some(String::from("display_stage_handle_missing"));
            return false;
        };
        let valid = self.ensure_staged_frame_validation(&mut staged)
            && self.reserve_staged_graphics(&mut staged);
        self.staged_frames[slot] = Some(staged);
        valid
    }

    pub fn apply_staged_state_seq(&mut self, handle: u32, seq: u32) -> bool {
        self.apply_staged_frame(handle, true, seq)
    }

    pub fn apply_staged_delta_seq(&mut self, handle: u32, seq: u32) -> bool {
        self.apply_staged_frame(handle, false, seq)
    }

    pub fn release_staged_frame(&mut self, handle: u32) {
        let Some(slot) = usize::try_from(handle)
            .ok()
            .and_then(|value| value.checked_sub(1))
        else {
            return;
        };
        if let Some(mut staged) = self.staged_frames.get_mut(slot).and_then(Option::take) {
            self.staged_active_wire_bytes = self
                .staged_active_wire_bytes
                .saturating_sub(staged.budget.wire_bytes);
            self.staged_active_decoded_bytes = self
                .staged_active_decoded_bytes
                .saturating_sub(staged.budget.decoded_bytes);
            self.staged_active_decoded_cells = self
                .staged_active_decoded_cells
                .saturating_sub(staged.budget.decoded_cells);
            if staged.data.capacity() != 0 && self.staged_frame_pool.len() < 16 {
                staged.data.clear();
                self.staged_frame_pool.push(staged.data);
            }
            if let Some(validation) = staged.validation.take() {
                self.recycle_staged_validation(validation.decoded);
            }
            self.staged_frame_free_slots.push(slot);
        }
    }

    fn apply_staged_frame(&mut self, handle: u32, snapshot: bool, seq: u32) -> bool {
        let Some(slot) = usize::try_from(handle)
            .ok()
            .and_then(|value| value.checked_sub(1))
            .filter(|slot| *slot < self.staged_frames.len())
        else {
            self.last_error = Some(String::from("display_stage_handle_invalid"));
            return false;
        };
        let Some(mut staged) = self.staged_frames[slot].take() else {
            self.last_error = Some(String::from("display_stage_handle_missing"));
            return false;
        };
        if snapshot {
            self.predict_flush_because(CursorCause::FlushSnapshot);
        }
        let applied = if let Some(validation) = staged.validation.as_mut() {
            // Explicit all-chunks prevalidation owns a decoded cache. Move its
            // vectors through the established apply scratch without decoding
            // the same chunk a second time.
            std::mem::swap(&mut self.frame_rows_scratch, &mut validation.decoded.rows);
            std::mem::swap(&mut self.frame_cells_scratch, &mut validation.decoded.cells);
            std::mem::swap(
                &mut self.frame_graphics_scratch,
                &mut validation.decoded.graphics,
            );
            let applied = self.apply_validated_frame(
                validation.header,
                snapshot,
                seq,
                validation.graphics.as_mut(),
            );
            validation.graphics = None;
            std::mem::swap(&mut self.frame_rows_scratch, &mut validation.decoded.rows);
            std::mem::swap(&mut self.frame_cells_scratch, &mut validation.decoded.cells);
            std::mem::swap(
                &mut self.frame_graphics_scratch,
                &mut validation.decoded.graphics,
            );
            applied
        } else {
            // Production single-chunk compressed frames are not explicitly
            // prevalidated. Keep that common path on the legacy direct scratch
            // buffers: one decode/apply, with no validation allocation, cache
            // ownership, pool accounting, or scratch-vector swaps.
            self.apply_frame(&staged.data, snapshot, seq)
        };
        self.staged_frames[slot] = Some(staged);
        applied
    }

    fn ensure_staged_frame_validation(&mut self, staged: &mut StagedDisplayFrame) -> bool {
        if staged.validation.is_some() {
            self.last_error = None;
            return true;
        }
        let mut decoded = self.take_staged_validation();
        #[cfg(test)]
        {
            self.display_frame_decode_count = self.display_frame_decode_count.saturating_add(1);
        }
        match validate_display_frame(
            &staged.data,
            &mut decoded.rows,
            &mut decoded.cells,
            &mut decoded.row_seen,
            &mut decoded.graphics,
            &mut self.display_link_table_scratch,
        ) {
            Ok(header) => {
                staged.validation = Some(StagedDisplayValidation {
                    header,
                    decoded,
                    graphics: None,
                });
                self.last_error = None;
                true
            }
            Err(error) => {
                self.recycle_staged_validation(decoded);
                self.last_error = Some(String::from(error.code()));
                false
            }
        }
    }

    fn reserve_staged_graphics(&mut self, staged: &mut StagedDisplayFrame) -> bool {
        let Some(validation) = staged.validation.as_mut() else {
            return false;
        };
        if validation.graphics.is_some()
            || (self.graphics.is_none() && validation.decoded.graphics.is_empty())
        {
            return true;
        }
        let graphics = self
            .graphics
            .get_or_insert_with(graphics::GraphicsRows::new);
        match graphics.reserve(
            validation.header,
            &validation.decoded.rows,
            &validation.decoded.graphics,
        ) {
            Ok(reserved) => {
                validation.graphics = Some(reserved);
                true
            }
            Err(_) => {
                self.last_error = Some(String::from("display_graphics_budget_exceeded"));
                false
            }
        }
    }

    fn recycle_staged_validation(&mut self, decoded: DisplayFrameDecodeScratch) {
        let cell_capacity = decoded.cells.capacity();
        let graphics_capacity = decoded.graphics.capacity();
        let Some(retained_graphics) = self
            .staged_validation_pool_graphics_capacity
            .checked_add(graphics_capacity)
        else {
            return;
        };
        let Some(retained_capacity) = self
            .staged_validation_pool_cell_capacity
            .checked_add(cell_capacity)
        else {
            return;
        };
        if self.staged_validation_pool.len() < STAGED_VALIDATION_POOL_MAX
            && retained_capacity <= STAGED_VALIDATION_POOL_MAX_CELL_CAPACITY
            && retained_graphics <= 2 * merkur_graphics::projection::MAX_ROW_FRAGMENTS
        {
            self.staged_validation_pool_cell_capacity = retained_capacity;
            self.staged_validation_pool_graphics_capacity = retained_graphics;
            self.staged_validation_pool.push(decoded);
        }
    }

    fn take_staged_validation(&mut self) -> DisplayFrameDecodeScratch {
        let Some(decoded) = self.staged_validation_pool.pop() else {
            return DisplayFrameDecodeScratch::default();
        };
        self.staged_validation_pool_cell_capacity = self
            .staged_validation_pool_cell_capacity
            .saturating_sub(decoded.cells.capacity());
        self.staged_validation_pool_graphics_capacity = self
            .staged_validation_pool_graphics_capacity
            .saturating_sub(decoded.graphics.capacity());
        decoded
    }

    /// Validate a display chunk without mutating terminal/render ordering.
    ///
    /// The worker calls this for every chunk in an assembled logical frame
    /// before applying the first one, preventing a malformed later chunk from
    /// leaving a partially committed frame on screen.
    pub fn validate_frame(&mut self, data: &[u8]) -> bool {
        #[cfg(test)]
        {
            self.display_frame_decode_count = self.display_frame_decode_count.saturating_add(1);
        }
        match validate_display_frame(
            data,
            &mut self.frame_rows_scratch,
            &mut self.frame_cells_scratch,
            &mut self.frame_row_seen_scratch,
            &mut self.frame_graphics_scratch,
            &mut self.display_link_table_scratch,
        ) {
            Ok(_) => {
                self.last_error = None;
                true
            }
            Err(error) => {
                self.last_error = Some(String::from(error.code()));
                false
            }
        }
    }

    /// Set the IME preedit (in-progress composition) string rendered inline at
    /// the cursor. `caret` is the DOM-native UTF-16 offset into `text`; it is
    /// converted once to the renderer's Unicode-scalar index. Empty `text`
    /// clears.
    pub fn set_preedit(&mut self, text: &str, caret: u32) {
        if !text.is_empty() && self.shadow_line.is_some() {
            self.seal_shadow_line(CursorCause::FlushPreedit, 0);
        }
        let chars: Vec<char> = text.chars().collect();
        let requested_utf16_offset = caret as usize;
        let mut consumed_utf16_units = 0;
        let mut caret = 0;
        for character in &chars {
            let next_offset = consumed_utf16_units + character.len_utf16();
            if next_offset > requested_utf16_offset {
                break;
            }
            consumed_utf16_units = next_offset;
            caret += 1;
        }
        if chars == self.preedit_chars && caret == self.preedit_caret {
            return;
        }
        self.preedit_chars = chars;
        self.preedit_caret = caret;
        self.preedit_dirty = true;
    }

    pub fn set_theme(&mut self, bytes: &[u8]) -> bool {
        let Some(theme) = parse_render_theme(bytes) else {
            return false;
        };
        self.theme = theme;
        self.full_damage = true;
        self.geometry_buffers_initialized = false;
        self.prediction_render_dirty = true;
        true
    }

    fn apply_frame(&mut self, data: &[u8], snapshot: bool, seq: u32) -> bool {
        #[cfg(test)]
        {
            self.display_frame_decode_count = self.display_frame_decode_count.saturating_add(1);
        }
        let header = match validate_display_frame(
            data,
            &mut self.frame_rows_scratch,
            &mut self.frame_cells_scratch,
            &mut self.frame_row_seen_scratch,
            &mut self.frame_graphics_scratch,
            &mut self.display_link_table_scratch,
        ) {
            Ok(header) => header,
            Err(error) => {
                self.last_error = Some(String::from(error.code()));
                return false;
            }
        };
        self.apply_validated_frame(header, snapshot, seq, None)
    }

    fn apply_validated_frame(
        &mut self,
        header: FrameHeader,
        snapshot: bool,
        seq: u32,
        reserved: Option<&mut Vec<(u16, merkur_graphics::projection::RowFragments)>>,
    ) -> bool {
        if !snapshot && seq == 0 {
            self.last_apply_visually_changed = false;
            self.last_error = Some(String::from("display_sequence_invalid"));
            return false;
        }
        let cols = usize::from(header.cols);
        let rows = usize::from(header.rows);
        let dimensions_changed =
            self.term.grid().columns() != cols || self.term.grid().screen_lines() != rows;

        self.last_apply_visually_changed = false;

        if dimensions_changed && !snapshot {
            self.last_error = Some(String::from("display_dimensions_mismatch"));
            return false;
        }
        if self.graphics.is_some() || !self.frame_graphics_scratch.is_empty() {
            let graphics = self
                .graphics
                .get_or_insert_with(graphics::GraphicsRows::new);
            if let Some(reserved) = reserved {
                graphics.adopt(reserved, snapshot, seq, &self.display_row_versions);
            } else if graphics
                .prepare(
                    header,
                    &self.frame_rows_scratch,
                    &self.frame_graphics_scratch,
                    snapshot,
                    seq,
                    &self.display_row_versions,
                )
                .is_err()
            {
                self.last_error = Some(String::from("display_graphics_budget_exceeded"));
                return false;
            }
        }

        if dimensions_changed {
            self.resize_authoritative(header.cols, header.rows);
        }
        if self.display_row_versions.len() != rows {
            self.display_row_versions.clear();
            self.display_row_versions.resize(rows, 0);
        }
        if self.display_cell_versions.len() != rows.saturating_mul(cols) {
            self.display_cell_versions.clear();
            self.display_cell_versions
                .resize(rows.saturating_mul(cols), 0);
        }
        if self.authoritative_cell_revisions.len() != rows.saturating_mul(cols) {
            self.authoritative_cell_revisions.clear();
            self.authoritative_cell_revisions
                .resize(rows.saturating_mul(cols), 0);
        }
        if self.display_cell_links.len() != rows.saturating_mul(cols)
            || self.display_row_link_cells.len() != rows
        {
            self.display_cell_links.clear();
            self.display_cell_links.resize(rows.saturating_mul(cols), 0);
            self.display_row_link_cells.clear();
            self.display_row_link_cells.resize(rows, 0);
        }
        let authoritative_revision = self.authoritative_revision.wrapping_add(1).max(1);
        self.authoritative_revision = authoritative_revision;
        let mut visually_changed_rows = 0usize;
        let shadow_row = self.shadow_line.as_ref().map(|line| usize::from(line.row));
        let mut shadow_authority_changed = false;
        for row in self.frame_rows_scratch.iter().copied() {
            let row_index = usize::from(row.row_index);
            // ACK-baseline deltas can contain disjoint cells from a shared
            // baseline. Reject the entire stale row, not just overlapping
            // cells, so reordering cannot restore older omitted content.
            if !snapshot && !display_sequence_is_newer(seq, self.display_row_versions[row_index]) {
                continue;
            }
            let left = usize::from(row.left);
            let (applied, damage, links_changed) = {
                let grid = self.term.grid_mut();
                apply_row_cells(
                    grid,
                    &mut self.display_cell_versions,
                    &mut self.authoritative_cell_revisions,
                    &mut self.display_cell_links,
                    &mut self.display_row_link_cells[row_index],
                    &self.frame_cells_scratch[row.cells_start..row.cells_end],
                    row_index,
                    left,
                    cols,
                    seq,
                    snapshot,
                    authoritative_revision,
                )
            };
            // Authority advances even when a repair carries the exact content
            // already present. Ordering and prediction evidence are not damage.
            if applied {
                self.display_row_versions[row_index] = seq;
                if self.presentation_dirty_set[row_index] == 0 {
                    self.presentation_dirty_rows.push(row.row_index);
                    self.presentation_dirty_set[row_index] = 1;
                }
            }
            // A link is hashed but never drawn, so a row whose only change is
            // a link id is stale in `row_hashes` without being damage.
            if links_changed && damage.is_none() {
                mark_row_hash_dirty(
                    &mut self.row_hash_all_dirty,
                    &mut self.row_hash_dirty,
                    &mut self.row_hash_dirty_list,
                    row.row_index,
                );
            }
            if damage.is_some() {
                shadow_authority_changed |= shadow_row == Some(row_index);
                mark_row_hash_dirty(
                    &mut self.row_hash_all_dirty,
                    &mut self.row_hash_dirty,
                    &mut self.row_hash_dirty_list,
                    row.row_index,
                );
                self.presentation_dirty_set[row_index] = 2;
                visually_changed_rows += 1;
            }
        }

        if let Some(graphics) = self.graphics.as_mut() {
            graphics.apply(rows, |row| {
                let index = usize::from(row);
                if self.presentation_dirty_set[index] == 0 {
                    self.presentation_dirty_rows.push(row);
                }
                self.presentation_dirty_set[index] = 2;
                mark_row_hash_dirty(
                    &mut self.row_hash_all_dirty,
                    &mut self.row_hash_dirty,
                    &mut self.row_hash_dirty_list,
                    row,
                );
                visually_changed_rows += 1;
                shadow_authority_changed |= shadow_row == Some(index);
            });
        }
        let prediction_render_dirty_before = self.prediction_render_dirty;
        if self.shadow_line.as_ref().is_some_and(|line| {
            self.graphics_intersect(
                line.row,
                usize::from(line.start_col),
                usize::from(line.start_col) + line.base.extent.max(line.projected.extent) + 1,
            )
        }) {
            self.predict_flush_because(CursorCause::FlushReceivedIncompatible);
        }
        let (header_applied, header_visually_changed) = self.apply_newer_display_header(
            snapshot,
            seq,
            header.cursor_col,
            header.cursor_row,
            header.cursor_shape,
            header.cursor_visible,
            header.mode_flags,
            header.scroll_serial,
        );
        if header_applied {
            self.authoritative_header_revision = authoritative_revision;
        }
        self.presentation_header_pending |= header_visually_changed;

        self.presentation_full_pending |= snapshot;
        if shadow_authority_changed || header_visually_changed || snapshot {
            self.refresh_shadow_received_compatibility();
        }
        if self
            .shadow_line
            .as_ref()
            .is_some_and(|line| !line.ops.is_empty())
        {
            let was_visible = self.has_visible_predictions_internal();
            self.sync_predictions_from_shadow();
            self.mark_shadow_visual_change(was_visible);
        }
        self.last_apply_visually_changed = snapshot
            || dimensions_changed
            || visually_changed_rows != 0
            || header_visually_changed
            || (!prediction_render_dirty_before && self.prediction_render_dirty);
        self.last_error = None;
        true
    }

    pub fn resize(&mut self, cols: u16, rows: u16) {
        // Graphics are absolute row authority, not enough information to guess
        // daemon scrollback/reflow. Keep text and images together in the last
        // authoritative layout until the resize snapshot arrives. Canvas clipping
        // and viewport metrics remain renderer-owned and update independently.
        if self
            .graphics
            .as_ref()
            .is_some_and(graphics::GraphicsRows::has_content)
        {
            return;
        }
        self.resize_authoritative(cols, rows);
    }

    fn resize_authoritative(&mut self, cols: u16, rows: u16) {
        let dimensions = create_dimensions(cols, rows);
        // Reflow rewraps the rows this grid already holds so a column change
        // lands as the daemon will re-send it, instead of as a truncate on
        // shrink and a blank pad on grow. It is a guess — the daemon rewraps
        // against scrollback this grid does not have, so a column grow leaves
        // blanks at the top where the daemon pulls history down — and the
        // authoritative frame overwrites it about one round trip later.
        //
        // The alternate screen is excluded because that is what the daemon
        // does: alacritty resizes an alt-screen grid without reflow, and this
        // grid must match. It never enters the alternate screen itself, so the
        // mode arrives in the display header rather than in `Term::mode`, and
        // the decision has to be stated rather than derived.
        let reflow = self.display_mode & DISPLAY_MODE_ALT_SCREEN == 0;
        {
            let grid = self.term.grid_mut();
            // Bottom-anchor a growing reflow with one screen of blank
            // scrollback.
            //
            // Rejoining wrapped rows frees rows, and so does adding rows
            // outright. Alacritty fills the gap from scrollback, which keeps
            // the newest line — the prompt — pinned to the bottom and pulls
            // older content down into the space. The daemon, with 10 000 lines
            // of it, does exactly that. This grid holds none: it would pad the
            // *bottom* instead, walking the prompt up the screen for the one
            // round trip until the authoritative frame walks it back down. A
            // guess that moves content the daemon will not move is worse than
            // no guess at all, so the backfill has to come from somewhere.
            //
            // Blank history is that somewhere. The rows it lends are wrong —
            // the daemon will send real scrollback — but they are wrong in the
            // place the correction is going to land anyway, above content that
            // stays put. It is allocated only for a resize that can consume it
            // and handed back immediately below, so nothing accumulates across
            // a drag.
            if reflow
                && (usize::from(cols) > grid.columns() || usize::from(rows) > grid.screen_lines())
            {
                grid.update_history(usize::from(rows.max(1)));
                grid.initialize_all();
            }
        }
        self.term.resize_reflowing(dimensions, reflow);
        // Back to no scrollback. Nothing scrolls this grid, and a column
        // shrink would otherwise park every row it wraps off the top in
        // history that no one can reach and nothing frees.
        self.term.grid_mut().update_history(0);
        self.presentation_full_pending = true;
        self.presentation_header_pending = true;
        self.presentation_dirty_rows.clear();
        self.presentation_dirty_rows
            .reserve(usize::from(rows.max(1)));
        self.presentation_dirty_set.clear();
        self.presentation_dirty_set
            .resize(usize::from(rows.max(1)), 0);
        self.damaged_rows.clear();
        self.damaged_row_set.clear();
        self.damaged_row_set.resize(usize::from(rows.max(1)), false);
        self.row_geometry.clear();
        self.display_row_versions.clear();
        self.display_row_versions
            .resize(usize::from(rows.max(1)), 0);
        self.display_cell_versions.clear();
        self.display_cell_versions.resize(
            usize::from(cols.max(1)).saturating_mul(usize::from(rows.max(1))),
            0,
        );
        self.authoritative_cell_revisions.clear();
        self.authoritative_cell_revisions.resize(
            usize::from(cols.max(1)).saturating_mul(usize::from(rows.max(1))),
            0,
        );
        // Reflow moved the cells but not their ids. The snapshot that follows
        // every resize restores them; until then no row claims a link it may
        // no longer sit under.
        self.display_cell_links.clear();
        self.display_cell_links.resize(
            usize::from(cols.max(1)).saturating_mul(usize::from(rows.max(1))),
            0,
        );
        self.display_row_link_cells.clear();
        self.display_row_link_cells
            .resize(usize::from(rows.max(1)), 0);
        self.display_header_version = 0;
        self.last_applied_display_header = None;
        self.last_apply_visually_changed = true;
        self.authoritative_header_revision = 0;
        self.geometry_buffers_initialized = false;
        self.full_damage = true;
        // Every row moved, and the vector length changed with it. Listing rows
        // individually here would be the one case where the dirty list can grow
        // to the full grid on a path that already rebuilds everything.
        self.row_hash_all_dirty = true;
        self.row_hash_dirty_list.clear();
        self.cursor_authority_cause = CursorCause::AuthorityResize;
        self.predict_flush_because(CursorCause::FlushResize);
    }

    pub fn reset_display_ordering(&mut self) {
        self.display_row_versions.fill(0);
        self.display_cell_versions.fill(0);
        self.display_header_version = 0;
        self.last_applied_display_header = None;
        self.authoritative_header_revision = 0;
    }

    pub fn last_apply_visually_changed(&self) -> bool {
        self.last_apply_visually_changed
    }

    /// Newest display sequence that successfully transformed `row`, or zero
    /// before any delta in the current ordering epoch. The browser's resume
    /// presentation hold reads at most 128 rows on recovery only; ordinary
    /// display application never crosses this WASM boundary.
    pub fn display_row_version(&self, row: u16) -> u32 {
        self.display_row_versions
            .get(usize::from(row))
            .copied()
            .unwrap_or(0)
    }

    pub fn cols(&self) -> u16 {
        clamp_usize_to_u16(self.term.grid().columns())
    }

    pub fn rows(&self) -> u16 {
        clamp_usize_to_u16(self.term.grid().screen_lines())
    }

    /// Bring `row_hashes` up to date with the grid and return its base address.
    ///
    /// Called once per display drain rather than once per applied frame, so a
    /// row several frames touched is hashed once. This is the only place the
    /// hash pass runs: `row_hash` below stays as the direct, per-call reference
    /// the tests compare against.
    ///
    /// Returning the pointer follows `cursor_info_ptr`: the reader must go
    /// through the refreshing export, so there is no address to read stale.
    pub fn refresh_row_hashes(&mut self) -> *const u64 {
        let rows = usize::from(self.rows());
        if self.row_hashes.len() != rows || self.row_hash_dirty.len() != rows {
            self.row_hashes.clear();
            self.row_hashes.resize(rows, 0);
            self.row_hash_dirty.clear();
            self.row_hash_dirty.resize(rows, false);
            self.row_hash_all_dirty = true;
            self.row_hash_dirty_list.clear();
        }
        if self.row_hash_all_dirty {
            for row in 0..rows {
                self.row_hashes[row] = self.compute_row_hash(row);
            }
            self.row_hash_all_dirty = false;
            self.row_hash_dirty.fill(false);
            self.row_hash_dirty_list.clear();
            return self.row_hashes.as_ptr();
        }
        // `pop` rather than draining a copy: the list keeps its capacity, so a
        // steady session allocates nothing here.
        while let Some(row) = self.row_hash_dirty_list.pop() {
            let index = usize::from(row);
            if index >= rows {
                continue;
            }
            self.row_hash_dirty[index] = false;
            self.row_hashes[index] = self.compute_row_hash(index);
        }
        self.row_hashes.as_ptr()
    }

    /// Whether the authoritative grid and applied header are exactly the
    /// complete application frame `hi:lo` names
    /// (`merkur_codec::viewport_closure_digest`). Zero names nothing.
    ///
    /// The daemon stamps the claim on every frame of a capture taken at an
    /// explicit synchronized-update end, however that capture was clipped,
    /// repaired or continued; this is the one question that closes it. Rows
    /// and headers only ever apply from a newer sequence, so the answer
    /// cannot be reached through a stale overwrite. Costs one incremental row
    /// hash refresh plus one XXH3 over the row hashes.
    pub fn closure_digest_matches(&mut self, hi: u32, lo: u32) -> bool {
        let digest = (u64::from(hi) << 32) | u64::from(lo);
        let Some(header) = self.last_applied_display_header else {
            return false;
        };
        if digest == 0 {
            return false;
        }
        self.refresh_row_hashes();
        merkur_codec::viewport_closure_digest(
            self.cols(),
            self.rows(),
            header.cursor_col,
            header.cursor_row,
            header.cursor_shape,
            header.cursor_visible,
            &self.row_hashes,
        ) == digest
    }

    /// Rows currently described by `refresh_row_hashes`.
    ///
    /// The vector is read through a `Uint32Array` view on the JS side: two `u32`
    /// loads per row beat one `BigInt` allocation per row, which is what the
    /// per-heartbeat digest comparison used to cost.
    pub fn row_hashes_len(&self) -> u16 {
        clamp_usize_to_u16(self.row_hashes.len())
    }

    fn compute_row_hash(&mut self, row: usize) -> u64 {
        let grid = self.term.grid();
        let cols = grid.columns();
        if row >= grid.screen_lines() {
            return 0;
        }
        let line = match i32::try_from(row) {
            Ok(value) => Line(value),
            Err(_) => return 0,
        };
        let links = if self
            .display_row_link_cells
            .get(row)
            .is_some_and(|&cells| cells > 0)
        {
            self.display_cell_links
                .get(row * cols..(row + 1) * cols)
                .unwrap_or(&[])
        } else {
            &[]
        };
        let fragments = self
            .graphics
            .as_ref()
            .and_then(|graphics| graphics.digest(row));
        hash_row(
            grid,
            line,
            cols,
            links,
            fragments,
            &mut self.hash_digest_scratch,
        )
    }

    /// XXH3 of the row in the same shape the daemon hashes (CellRepr-based).
    ///
    /// The direct form, kept as the reference the incremental vector above is
    /// asserted against. Production reads go through `row_hashes_ptr`.
    pub fn row_hash(&mut self, row: u16) -> u64 {
        self.compute_row_hash(usize::from(row))
    }

    pub fn cursor_info_ptr(&mut self) -> *const u16 {
        // Compute this in WASM beside the shadow model. Exporting one bit avoids
        // allocating a row String in JS on every render and, more importantly,
        // keeps the instant overlay's admission rule identical to the model
        // that will authoritatively accept or reject the command.
        let append_only = self.speculative_printable_is_safe();
        // Read the renderable content out by value: the journal below needs
        // `&mut self`, and this is the one call on this path that borrows the
        // grid. Every field taken here is `Copy`.
        let display_offset = 0;
        let cursor_point = self.presentation_grid.cursor.point;
        let cursor_shape = encode_cursor_shape(self.presentation_cursor_shape);
        let cursor_visible = u8::from(!matches!(
            self.presentation_cursor_shape,
            CursorShape::Hidden
        ));

        if self.shadow_cursor_is_visible() {
            let (row, col) = self.predicted_cursor;
            let (foreground, background) = self.speculative_cell_colors(row, col);
            self.cursor_info_buf = [
                col,
                row,
                u16::from(cursor_shape),
                u16::from(cursor_visible),
                u16::from(append_only),
                u16::from(foreground[0]),
                u16::from(foreground[1]),
                u16::from(foreground[2]),
                u16::from(background[0]),
                u16::from(background[1]),
                u16::from(background[2]),
            ];
            self.note_drawn_cursor(row, col, true);
            return self.cursor_info_buf.as_ptr();
        }

        let Some(viewport_point) = point_to_viewport(display_offset, cursor_point) else {
            self.cursor_info_buf = [
                0,
                0,
                u16::from(cursor_shape),
                u16::from(cursor_visible),
                0,
                u16::from(self.theme.foreground[0]),
                u16::from(self.theme.foreground[1]),
                u16::from(self.theme.foreground[2]),
                u16::from(self.theme.background[0]),
                u16::from(self.theme.background[1]),
                u16::from(self.theme.background[2]),
            ];
            // The cursor is outside the viewport, so nothing is drawn at a
            // position at all. Forget the last one rather than measuring the
            // next position against it.
            if self.cursor_motion_enabled {
                self.last_drawn_cursor = None;
            }
            return self.cursor_info_buf.as_ptr();
        };

        let col = clamp_usize_to_u16(viewport_point.column.0);
        let row = clamp_usize_to_u16(viewport_point.line);
        let (foreground, background) = self.speculative_cell_colors(row, col);

        self.cursor_info_buf = [
            col,
            row,
            u16::from(cursor_shape),
            u16::from(cursor_visible),
            u16::from(append_only),
            u16::from(foreground[0]),
            u16::from(foreground[1]),
            u16::from(foreground[2]),
            u16::from(background[0]),
            u16::from(background[1]),
            u16::from(background[2]),
        ];
        self.note_drawn_cursor(row, col, false);
        self.cursor_info_buf.as_ptr()
    }

    pub fn cursor_info_len(&self) -> usize {
        self.cursor_info_buf.len()
    }

    /// Received header diagnostics. Never use this cursor to place visual UI.
    pub fn received_cursor_info_ptr(&mut self) -> *const u16 {
        let content = self.term.renderable_content();
        let point = point_to_viewport(content.display_offset, content.cursor.point);
        self.received_cursor_info_buf = [
            point.map_or(0, |p| clamp_usize_to_u16(p.column.0)),
            point.map_or(0, |p| clamp_usize_to_u16(p.line)),
            u16::from(encode_cursor_shape(content.cursor.shape)),
            u16::from(!matches!(content.cursor.shape, CursorShape::Hidden)),
        ];
        self.received_cursor_info_buf.as_ptr()
    }

    /// Turn the backwards-cursor journal on or off. Off is the default.
    ///
    /// Arming forgets the last sampled base cursor: while the journal is off nothing
    /// tracks it — that is what keeps the render path to one branch — so the
    /// first read after arming establishes the baseline rather than being
    /// measured against the prior sample from an earlier journal interval.
    pub fn set_cursor_motion_journal(&mut self, enabled: bool) {
        self.cursor_motion_enabled = enabled;
        self.last_drawn_cursor = None;
        if !enabled {
            self.cursor_motion.clear();
            self.cursor_motion_dropped = 0;
        }
    }

    /// Journal records, `CURSOR_MOTION_RECORD_WORDS` words each. Read then
    /// [`Terminal::clear_cursor_motion`]; the pointer moves when it refills.
    pub fn cursor_motion_ptr(&self) -> *const u32 {
        self.cursor_motion.as_ptr()
    }

    pub fn cursor_motion_len(&self) -> usize {
        self.cursor_motion.len()
    }

    /// Records the journal refused because the reader had not drained it.
    pub fn cursor_motion_dropped(&self) -> u32 {
        self.cursor_motion_dropped
    }

    /// The code of the event that last dropped the speculative model.
    ///
    /// A refused prediction and a retracted one leave the same visible state —
    /// no model — so a reader that wants to know which needs the name, and it
    /// is already recorded for the journal.
    pub fn last_flush_cause(&self) -> u32 {
        self.cursor_flush_cause as u32
    }

    pub fn clear_cursor_motion(&mut self) {
        self.cursor_motion.clear();
        self.cursor_motion_dropped = 0;
    }

    /// Record the cursor the renderer is about to draw, and journal the step
    /// if it went backwards.
    ///
    /// "Backwards" is reading order: an earlier row, or an earlier column on
    /// the same row. That is the whole symptom — the cursor visibly stepping
    /// left mid-word, or up a line — and it is the only motion that cannot be
    /// explained by typing.
    ///
    /// Order is read in content, not in viewport rows. When the screen has
    /// scrolled N lines since the last sample, the content the cursor was on
    /// now stands N rows higher, so a submitted line's new prompt on the same
    /// bottom row is a step down, not back. A cursor whose line scrolled off
    /// the top has nothing left to be behind.
    ///
    /// The disabled state is one load and one branch, taken before anything
    /// else: this runs on every render, and a diagnostic nobody asked for has
    /// to cost nothing. The recording itself is out of line for the same
    /// reason — it must not lengthen `cursor_info_ptr`'s own code.
    #[inline]
    fn note_drawn_cursor(&mut self, row: u16, col: u16, from_model: bool) {
        if !self.cursor_motion_enabled {
            return;
        }
        let serial = self.presentation_scroll_serial;
        let previous = self
            .last_drawn_cursor
            .replace((row, col, from_model, serial));
        let Some((from_row, from_col, was_from_model, from_serial)) = previous else {
            return;
        };
        let Some(content_row) = u32::from(from_row).checked_sub(serial.wrapping_sub(from_serial))
        else {
            return;
        };
        if (u32::from(row), col) >= (content_row, from_col) {
            return;
        }
        self.journal_backwards_step(from_row, from_col, was_from_model, row, col, from_model);
    }

    #[cold]
    #[inline(never)]
    fn journal_backwards_step(
        &mut self,
        from_row: u16,
        from_col: u16,
        was_from_model: bool,
        row: u16,
        col: u16,
        from_model: bool,
    ) {
        if self.cursor_motion.len() >= CURSOR_MOTION_MAX_RECORDS * CURSOR_MOTION_RECORD_WORDS {
            self.cursor_motion_dropped = self.cursor_motion_dropped.saturating_add(1);
            return;
        }

        let line = self.shadow_line.as_ref();
        // The model stopping is a different event from the model moving, and
        // only the first has to be resolved here: `cursor_cause` names what
        // last moved a cursor, but when the sampled base cursor changes SOURCE the
        // reason is a property of the model's state at this instant.
        let cause = if was_from_model && !from_model {
            match line {
                None => self.cursor_flush_cause,
                Some(line) if !line.visible => CursorCause::AdmissionWithheld,
                Some(_) => CursorCause::EpochTentative,
            }
        } else if from_model {
            self.cursor_model_cause
        } else {
            self.cursor_authority_cause
        };
        let mut flags = 0u32;
        if was_from_model {
            flags |= CURSOR_MOTION_FLAG_WAS_MODELLED;
        }
        if from_model {
            flags |= CURSOR_MOTION_FLAG_IS_MODELLED;
        }
        if let Some(line) = line {
            flags |= CURSOR_MOTION_FLAG_LINE_PRESENT;
            if line.visible {
                flags |= CURSOR_MOTION_FLAG_LINE_ADMITTED;
            }
            if line.sealed.is_some() {
                flags |= CURSOR_MOTION_FLAG_LINE_SEALED;
            }
        }
        if self.prediction_mode_is_unsafe() {
            flags |= CURSOR_MOTION_FLAG_MODE_UNSAFE;
        }
        let ops = line.map_or(0, |line| line.ops.len());
        self.cursor_motion_seq = self.cursor_motion_seq.wrapping_add(1);
        self.cursor_motion.extend_from_slice(&[
            self.cursor_motion_seq,
            cause as u32,
            (u32::from(from_row) << 16) | u32::from(from_col),
            (u32::from(row) << 16) | u32::from(col),
            flags,
            clamp_usize_to_u16(ops).into(),
        ]);
    }

    /// Journal an authoritative cursor shape or visibility change, so a frame
    /// that hides the cursor or turns it into a beam is attributable to the
    /// header that carried it. Same bound and drain as the backwards-step
    /// records; the two coordinate words are packed as `shape << 8 | visible`.
    #[cold]
    #[inline(never)]
    fn journal_header_shape(
        &mut self,
        previous: &PendingDisplayHeader,
        header: &PendingDisplayHeader,
    ) {
        if self.cursor_motion.len() >= CURSOR_MOTION_MAX_RECORDS * CURSOR_MOTION_RECORD_WORDS {
            self.cursor_motion_dropped = self.cursor_motion_dropped.saturating_add(1);
            return;
        }
        let mut flags = 0u32;
        if let Some(line) = self.shadow_line.as_ref() {
            flags |= CURSOR_MOTION_FLAG_LINE_PRESENT;
            if line.visible {
                flags |= CURSOR_MOTION_FLAG_LINE_ADMITTED;
            }
        }
        self.cursor_motion_seq = self.cursor_motion_seq.wrapping_add(1);
        self.cursor_motion.extend_from_slice(&[
            self.cursor_motion_seq,
            CursorCause::AuthorityShape as u32,
            (u32::from(previous.cursor_shape) << 8) | u32::from(previous.cursor_visible),
            (u32::from(header.cursor_shape) << 8) | u32::from(header.cursor_visible),
            flags,
            header.seq,
        ]);
    }

    /// Publish the speculative model's admission arithmetic for the main thread.
    ///
    /// Main decides wire-level shadow provenance synchronously at keystroke
    /// time, so it needs the same bounds this model will apply — not a promise
    /// to answer later. Everything here is already computed for the per-command
    /// checks in `predict_*`; exporting it costs six stores and removes a
    /// cross-thread round trip from the keystroke path.
    ///
    /// `[flags, start_col, cursor_col, end_col, ops_remaining, cols]`. Columns
    /// are absolute so a caller that has locally advanced the cursor re-applies
    /// the same bounds without knowing the split between already-typed base and
    /// pending ops.
    pub fn prediction_model_ptr(&mut self) -> *const u32 {
        let cols = clamp_usize_to_u16(self.presentation_grid.columns());
        let sealed = self
            .shadow_line
            .as_ref()
            .is_some_and(|line| line.sealed.is_some());
        let seedable = !sealed && self.speculative_printable_is_safe();
        let base_ready = !sealed
            && !self.prediction_mode_is_unsafe()
            && self.shadow_received_compatible
            && self.shadow_base_matches_presentation()
            && self.shadow_line.as_ref().is_none_or(|line| {
                !self.graphics_intersect(
                    line.row,
                    usize::from(line.start_col),
                    usize::from(line.start_col) + line.projected.cells.len() + 2,
                )
            });
        let (start_col, cursor_col, end_col, ops_remaining) = match self.shadow_line.as_ref() {
            Some(line) if base_ready => (
                line.start_col,
                line.start_col
                    .saturating_add(clamp_usize_to_u16(line.projected.cursor)),
                line.start_col
                    .saturating_add(clamp_usize_to_u16(line.projected.cells.len())),
                clamp_usize_to_u16(MAX_SHADOW_OPS.saturating_sub(line.ops.len())),
            ),
            // No usable line. A seeding printable starts at the authoritative
            // cursor with an empty projection, and `seedable` is exactly the
            // predicate `ensure_shadow_line` re-runs when one arrives.
            _ => {
                let col = self.presentation_cursor().map_or(0, |(_, col)| col);
                (col, col, col, clamp_usize_to_u16(MAX_SHADOW_OPS))
            }
        };
        self.prediction_model_buf = [
            u32::from(base_ready) | (u32::from(seedable) << 1),
            u32::from(start_col),
            u32::from(cursor_col),
            u32::from(end_col),
            u32::from(ops_remaining),
            u32::from(cols),
        ];
        self.prediction_model_buf.as_ptr()
    }

    pub fn prediction_model_len(&self) -> usize {
        self.prediction_model_buf.len()
    }

    pub fn take_last_error(&mut self) -> Option<String> {
        self.last_error.take()
    }

    pub fn predict_printable(
        &mut self,
        codepoint: u32,
        sent_at_ms: f64,
        input_seq: u32,
        visible: bool,
    ) -> u32 {
        if char::from_u32(codepoint).is_none() {
            return 0;
        }
        // The core's own question, so the model never predicts a key this
        // terminal then refuses to draw.
        if !merkur_client::viewer::predictable_width_one(codepoint) {
            self.seal_shadow_line(CursorCause::FlushUnpredictableKey, input_seq);
            return 0;
        }
        if self.prediction_mode_is_unsafe() {
            self.seal_shadow_line(CursorCause::FlushModeUnsafe, input_seq);
            return 0;
        }
        if !self.ensure_shadow_line(visible) {
            self.seal_shadow_line(self.ensure_refusal, input_seq);
            return 0;
        }
        let cols = self.presentation_grid.columns();
        let Some(line) = self.shadow_line.as_ref() else {
            return 0;
        };
        let new_len = line.projected.cells.len().saturating_add(1);
        if self.graphics_intersect(
            line.row,
            usize::from(line.start_col) + line.projected.cursor,
            usize::from(line.start_col) + new_len + 1,
        ) {
            self.seal_shadow_line(CursorCause::AdmissionWithheld, input_seq);
            return 0;
        }
        if line.ops.len() >= MAX_SHADOW_OPS
            || usize::from(line.start_col).saturating_add(new_len) >= cols
        {
            self.seal_shadow_line(CursorCause::FlushLineFull, input_seq);
            return 0;
        }
        let was_visible = self.has_visible_predictions_internal();
        let row = line.row;
        let index = line.projected.cursor;
        let col = usize::from(line.start_col).saturating_add(index);
        let meta = ShadowMeta {
            input_seq,
            sent_at_ms,
            epoch: self.prediction_epoch,
        };
        let cell = ShadowCell {
            codepoint,
            meta,
            fg: prediction_fg_at(&self.presentation_grid, usize::from(row), col),
            font_style: PREDICTION_STYLE_NORMAL,
            underline: false,
        };
        let op = ShadowOp {
            kind: ShadowOpKind::Insert {
                index: clamp_usize_to_u16(index),
                cell,
            },
            meta,
            authority_revision: self.authoritative_revision,
            header_revision: self.authoritative_header_revision,
        };
        if let Some(line) = self.shadow_line.as_mut() {
            if !apply_shadow_op(&mut line.projected, op) {
                self.seal_shadow_line(CursorCause::FlushOpFailed, input_seq);
                return 0;
            }
            line.ops.push(op);
            self.predicted_cursor = shadow_cursor(line);
        }
        self.cursor_model_cause = CursorCause::PredictOp;
        self.sync_predictions_from_shadow();

        if let Some(atlas) = self.atlas.as_mut() {
            let _ = atlas.get_or_rasterize(atlas::GlyphKey {
                codepoint,
                style: PREDICTION_STYLE_NORMAL,
            });
        }
        self.mark_shadow_visual_change(was_visible);
        self.prediction_epoch
    }

    pub fn predict_backspace(&mut self, sent_at_ms: f64, input_seq: u32) -> u32 {
        if let Some(cause) = self.shadow_edit_refusal() {
            self.seal_shadow_line(cause, input_seq);
            return 0;
        }
        let Some(line) = self.shadow_line.as_ref() else {
            return 0;
        };
        if line.projected.cursor == 0 || line.ops.len() >= MAX_SHADOW_OPS {
            self.seal_shadow_line(CursorCause::FlushLineFull, input_seq);
            return 0;
        }
        let removed_index = line.projected.cursor - 1;
        if self.graphics_intersect(
            line.row,
            usize::from(line.start_col) + removed_index,
            usize::from(line.start_col) + line.projected.cells.len() + 1,
        ) {
            self.seal_shadow_line(CursorCause::AdmissionWithheld, input_seq);
            return 0;
        }
        let Some(removed) = line.projected.cells.get(removed_index).copied() else {
            self.seal_shadow_line(CursorCause::FlushOpFailed, input_seq);
            return 0;
        };
        let clear_row = line.row;
        let clear_col = line.start_col.saturating_add(clamp_usize_to_u16(
            line.projected.cells.len().saturating_sub(1),
        ));
        let clear_original_codepoint = authoritative_cell_codepoint(
            &self.presentation_grid
                [Point::new(Line(i32::from(clear_row)), Column(usize::from(clear_col)))],
        );
        let was_visible = self.has_visible_predictions_internal();
        let meta = ShadowMeta {
            input_seq,
            epoch: self.prediction_epoch,
            sent_at_ms,
        };
        let op = ShadowOp {
            kind: ShadowOpKind::Backspace {
                index: clamp_usize_to_u16(removed_index),
            },
            meta,
            authority_revision: self.authoritative_revision,
            header_revision: self.authoritative_header_revision,
        };
        let clear_effect = if let Some(line) = self.shadow_line.as_mut() {
            if !apply_shadow_op(&mut line.projected, op) {
                self.seal_shadow_line(CursorCause::FlushOpFailed, input_seq);
                return 0;
            }
            line.ops.push(op);
            self.predicted_cursor = shadow_cursor(line);
            if was_visible {
                Some(Prediction {
                    row: clear_row,
                    col: clear_col,
                    input_seq: removed.meta.input_seq,
                    codepoint: removed.codepoint,
                    original_codepoint: clear_original_codepoint,
                    epoch: removed.meta.epoch,
                    kind: PredKind::Char,
                    fg: removed.fg,
                })
            } else {
                None
            }
        } else {
            None
        };
        if let Some(previous) = clear_effect {
            self.record_prediction_clear_effect(input_seq, previous);
        }
        self.cursor_model_cause = CursorCause::PredictOp;
        self.sync_predictions_from_shadow();
        self.mark_shadow_visual_change(was_visible);
        self.prediction_epoch
    }

    pub fn predict_delete(&mut self, sent_at_ms: f64, input_seq: u32) -> u32 {
        if let Some(cause) = self.shadow_edit_refusal() {
            self.seal_shadow_line(cause, input_seq);
            return 0;
        }
        let Some(line) = self.shadow_line.as_ref() else {
            return 0;
        };
        let index = line.projected.cursor;
        let Some(removed) = line.projected.cells.get(index).copied() else {
            self.seal_shadow_line(CursorCause::FlushOpFailed, input_seq);
            return 0;
        };
        if self.graphics_intersect(
            line.row,
            usize::from(line.start_col) + index,
            usize::from(line.start_col) + line.projected.cells.len() + 1,
        ) {
            self.seal_shadow_line(CursorCause::AdmissionWithheld, input_seq);
            return 0;
        }
        if line.ops.len() >= MAX_SHADOW_OPS {
            self.seal_shadow_line(CursorCause::FlushLineFull, input_seq);
            return 0;
        }
        let clear_row = line.row;
        let clear_col = line.start_col.saturating_add(clamp_usize_to_u16(
            line.projected.cells.len().saturating_sub(1),
        ));
        let clear_original_codepoint = authoritative_cell_codepoint(
            &self.presentation_grid
                [Point::new(Line(i32::from(clear_row)), Column(usize::from(clear_col)))],
        );
        let was_visible = self.has_visible_predictions_internal();
        let meta = ShadowMeta {
            input_seq,
            sent_at_ms,
            epoch: self.prediction_epoch,
        };
        let op = ShadowOp {
            kind: ShadowOpKind::Delete {
                index: clamp_usize_to_u16(index),
            },
            meta,
            authority_revision: self.authoritative_revision,
            header_revision: self.authoritative_header_revision,
        };
        let clear_effect = if let Some(line) = self.shadow_line.as_mut() {
            if !apply_shadow_op(&mut line.projected, op) {
                self.seal_shadow_line(CursorCause::FlushOpFailed, input_seq);
                return 0;
            }
            line.ops.push(op);
            self.predicted_cursor = shadow_cursor(line);
            if was_visible {
                Some(Prediction {
                    row: clear_row,
                    col: clear_col,
                    input_seq: removed.meta.input_seq,
                    codepoint: removed.codepoint,
                    original_codepoint: clear_original_codepoint,
                    epoch: removed.meta.epoch,
                    kind: PredKind::Char,
                    fg: removed.fg,
                })
            } else {
                None
            }
        } else {
            None
        };
        if let Some(previous) = clear_effect {
            self.record_prediction_clear_effect(input_seq, previous);
        }
        self.cursor_model_cause = CursorCause::PredictOp;
        self.sync_predictions_from_shadow();
        self.mark_shadow_visual_change(was_visible);
        self.prediction_epoch
    }

    pub fn predict_cursor_shift(&mut self, delta: i32, sent_at_ms: f64, input_seq: u32) -> u32 {
        if !matches!(delta, -1 | 1) {
            self.seal_shadow_line(CursorCause::FlushUnpredictableKey, input_seq);
            return 0;
        }
        if let Some(cause) = self.shadow_edit_refusal() {
            self.seal_shadow_line(cause, input_seq);
            return 0;
        }
        let Some(line) = self.shadow_line.as_ref() else {
            return 0;
        };
        let next = line.projected.cursor as i32 + delta;
        let start = usize::from(line.start_col);
        let current = start + line.projected.cursor;
        let target = start + usize::try_from(next).unwrap_or(0);
        if self.graphics_intersect(line.row, current.min(target), current.max(target) + 1) {
            self.seal_shadow_line(CursorCause::AdmissionWithheld, input_seq);
            return 0;
        }
        if next < 0
            || usize::try_from(next)
                .ok()
                .is_none_or(|next| next > line.projected.cells.len())
            || line.ops.len() >= MAX_SHADOW_OPS
        {
            self.seal_shadow_line(CursorCause::FlushLineFull, input_seq);
            return 0;
        }
        let was_visible = self.has_visible_predictions_internal();
        let meta = ShadowMeta {
            input_seq,
            sent_at_ms,
            epoch: self.prediction_epoch,
        };
        let op = ShadowOp {
            kind: ShadowOpKind::CursorShift { delta: delta as i8 },
            meta,
            authority_revision: self.authoritative_revision,
            header_revision: self.authoritative_header_revision,
        };
        if let Some(line) = self.shadow_line.as_mut() {
            if !apply_shadow_op(&mut line.projected, op) {
                self.seal_shadow_line(CursorCause::FlushOpFailed, input_seq);
                return 0;
            }
            line.ops.push(op);
            self.predicted_cursor = shadow_cursor(line);
        }
        self.cursor_model_cause = CursorCause::PredictOp;
        self.sync_predictions_from_shadow();
        self.mark_shadow_visual_change(was_visible);
        self.prediction_epoch
    }

    /// Drop the model outright: the worker's own reset paths (a new session
    /// epoch, an authoritative snapshot, an alternate-screen crossing), where
    /// the grid the glyphs were drawn over no longer exists.
    pub fn predict_discard(&mut self) {
        self.predict_flush_because(CursorCause::FlushExternal);
    }

    /// An input the model does not project ended the line: Enter, Tab, a
    /// paste, a composition, a key `predictionIntent` sends down the flush
    /// path. See [`ShadowLine::sealed`] for why this keeps every painted glyph.
    pub fn predict_seal(&mut self, input_seq: u32) {
        self.seal_shadow_line(CursorCause::SealExternal, input_seq);
    }

    /// End the line without taking anything back.
    ///
    /// A line with painted glyphs is sealed; one with nothing on screen —
    /// no line, an undisplayed line, or one whose ops are all answered — is
    /// simply dropped, because dropping it moves no pixel and leaves the next
    /// key free to seed afresh.
    fn seal_shadow_line(&mut self, cause: CursorCause, input_seq: u32) {
        if !self.has_visible_predictions_internal() {
            self.predict_flush_because(cause);
            return;
        }
        if let Some(line) = self.shadow_line.as_mut()
            && line.sealed.is_none()
        {
            line.sealed = Some(cause);
            line.sealed_by_input = input_seq;
        }
        self.cursor_flush_cause = cause;
    }

    /// Drop the model, naming what dropped it.
    ///
    /// A visible model's flush returns the base cursor to eligible authority.
    /// If that changes its sampled position, this name attributes the step;
    /// the journal does not establish whether that position reached the screen.
    fn predict_flush_because(&mut self, cause: CursorCause) {
        self.shadow_received_compatible = true;
        self.shadow_received_split = false;
        self.shadow_presentation_split = false;
        self.cursor_flush_cause = cause;
        let had_visible = self.has_visible_predictions_internal();
        let old_row = self.shadow_line.as_ref().map(|line| line.row);
        self.predictions.clear();
        self.shadow_line = None;
        self.reset_predicted_cursor_to_real();
        self.become_tentative();
        if had_visible || self.shadow_row_projected {
            self.prediction_render_dirty = true;
            if let Some(row) = old_row {
                self.note_damaged_row(row);
            }
        }
    }

    pub fn predict_reconcile(
        &mut self,
        now_ms: f64,
        ttl_ms: f64,
        authoritative_input_high_water: u32,
        authoritative_echo_horizon: u32,
    ) {
        let mut confirmed = 0u32;
        let mut mismatched = 0u32;
        let mut no_credit = 0u32;
        let mut discarded = 0u32;
        let Some(line) = self.shadow_line.as_ref() else {
            self.reconcile_stats = [0; 7];
            return;
        };
        let sealed = line.sealed.is_some();
        // Only a grid captured after output that followed the sealing input
        // can show what it did to the row. Before that the line is read as an
        // open one; see `ShadowLine::sealed_by_input`.
        let seal_answerable = sealed && line.sealed_by_input <= authoritative_echo_horizon;
        // A refusal that received authority itself provoked sealed the line
        // over a contradiction already in hand; that contradiction is evidence
        // against the glyphs. Every other seal expects the row to change.
        let seal_contradiction_is_evidence = matches!(
            line.sealed,
            Some(
                CursorCause::FlushReceivedIncompatible
                    | CursorCause::FlushBaseMismatch
                    | CursorCause::FlushAnchorNotPresented
            )
        );
        if line.ops.is_empty() {
            if sealed {
                // Every op a sealed line ever had has been answered; nothing
                // is painted from it and nothing can be added to it.
                self.predict_flush_because(CursorCause::FlushSealResolved);
            }
            self.reconcile_stats = [0; 7];
            return;
        }

        // The lifetime is a resource bound on the overlay, not a verdict. Split
        // what it retires by the same exact predicate the model uses to cancel
        // covered work: authority that arrived and left a prediction
        // unconfirmed is evidence against it, authority that never arrived is a
        // stalled link and evidence of nothing. The worker resets its trust gate
        // on the first and deliberately not on the second.
        let mut expired_covered = 0u32;
        let mut expired_stalled = 0u32;
        for op in &line.ops {
            if now_ms - op.meta.sent_at_ms <= ttl_ms {
                continue;
            }
            if op.meta.input_seq <= authoritative_input_high_water {
                expired_covered += 1;
            } else {
                expired_stalled += 1;
            }
        }
        let expired_count = (expired_covered + expired_stalled) as usize;
        if expired_count > 0 {
            if sealed {
                // The input that sealed the line may have ended the line editor
                // altogether (Ctrl-C, Ctrl-Z, a command that never echoes), so
                // an answer that never comes is not evidence against the
                // glyphs. Neutral, like the discarded tail below.
                discarded = line.ops.len() as u32;
                self.predict_flush_because(CursorCause::FlushSealResolved);
                self.reconcile_stats = [0, 0, 0, 0, discarded, 0, 0];
                return;
            }
            discarded = line.ops.len().saturating_sub(expired_count) as u32;
            self.predict_flush_because(if expired_covered > 0 {
                CursorCause::FlushExpiredCovered
            } else {
                CursorCause::FlushExpiredStalled
            });
            self.reconcile_stats = [0, 0, expired_covered, 0, discarded, 0, expired_stalled];
            return;
        }

        let covered = line
            .ops
            .iter()
            .take_while(|op| op.meta.input_seq <= authoritative_input_high_water)
            .count();
        if covered == 0 {
            self.reconcile_stats = [0; 7];
            return;
        }
        if !seal_answerable && self.shadow_received_split {
            // Independent absolute row/header delivery can expose two valid
            // echo prefixes. Neither contradicts the model, but their union is
            // not an echo confirmation. Keep projecting the same bounded ops
            // until matching evidence arrives; expiry above still applies.
            if let Some(line) = self.shadow_line.as_mut() {
                line.mismatch_first_seen_at_ms = None;
            }
            self.reconcile_stats = [0, 0, 0, 0, 0, 1, 0];
            return;
        }
        let row = line.row;
        let start_col = line.start_col;
        let base_cursor = line.base.cursor;
        self.shadow_replay_scratch.clone_from(&line.base);
        self.shadow_touch_revision_scratch.clear();
        self.shadow_touch_revision_scratch
            .resize(line.projected.extent.max(line.base.extent), 0);
        let mut next_confirmed_epoch = self.confirmed_epoch;
        let mut valid_projection = true;
        let mut required_header_revision = 0u32;
        for index in 0..covered {
            let op = line.ops[index];
            if let Some((start, end)) = shadow_op_touch_range(&self.shadow_replay_scratch, op) {
                if end > self.shadow_touch_revision_scratch.len() {
                    self.shadow_touch_revision_scratch.resize(end, 0);
                }
                let required_revision = op.authority_revision.wrapping_add(1).max(1);
                for revision in &mut self.shadow_touch_revision_scratch[start..end] {
                    *revision = (*revision).max(required_revision);
                }
            }
            valid_projection &= apply_shadow_op(&mut self.shadow_replay_scratch, op);
            next_confirmed_epoch = next_confirmed_epoch.max(op.meta.epoch);
            required_header_revision =
                required_header_revision.max(op.header_revision.wrapping_add(1).max(1));
        }

        // PTY write coverage can overtake the echo. Reconcile the largest
        // prefix that the received row and cursor actually show, leaving the
        // unechoed tail projected against that new base. The normal path still
        // replays once; only a partial echo searches the bounded operation list.
        if covered > 1
            && !seal_answerable
            && valid_projection
            && !self.shadow_state_matches_authority(
                row,
                start_col,
                &self.shadow_replay_scratch,
                true,
            )
        {
            self.shadow_replay_scratch.clone_from(&line.base);
            let mut echoed_input_seq = None;
            let authoritative_cursor = self.authoritative_cursor();
            for op in &line.ops[..covered - 1] {
                if !apply_shadow_op(&mut self.shadow_replay_scratch, *op) {
                    break;
                }
                if authoritative_cursor
                    == Some((
                        row,
                        start_col
                            .saturating_add(clamp_usize_to_u16(self.shadow_replay_scratch.cursor)),
                    ))
                    && self.shadow_state_matches_authority(
                        row,
                        start_col,
                        &self.shadow_replay_scratch,
                        false,
                    )
                {
                    echoed_input_seq = Some(op.meta.input_seq);
                }
            }
            if let Some(input_seq) = echoed_input_seq {
                // Re-enter the same revision and presentation checks for this
                // prefix. Its exact match prevents another prefix search.
                self.predict_reconcile(now_ms, ttl_ms, input_seq, authoritative_echo_horizon);
                return;
            }
            // No partial match: restore the full projection for the existing
            // evidence/mismatch decision below.
            self.shadow_replay_scratch.clone_from(&line.base);
            for op in &line.ops[..covered] {
                apply_shadow_op(&mut self.shadow_replay_scratch, *op);
            }
        }

        let cursor_changed = self.shadow_replay_scratch.cursor != base_cursor;
        if cursor_changed {
            for (offset, required_revision) in
                self.shadow_touch_revision_scratch.iter_mut().enumerate()
            {
                if shadow_state_codepoint(&line.base, offset)
                    == shadow_state_codepoint(&self.shadow_replay_scratch, offset)
                {
                    *required_revision = 0;
                }
            }
        }
        let has_cell_evidence = self
            .shadow_touch_revision_scratch
            .iter()
            .any(|revision| *revision != 0);
        let cells_ready = self.shadow_touch_revision_scratch.iter().enumerate().all(
            |(offset, required_revision)| {
                if *required_revision == 0 {
                    return true;
                }
                let row = usize::from(row);
                let col = usize::from(start_col).saturating_add(offset);
                let cols = self.term.grid().columns();
                self.authoritative_cell_revisions
                    .get(row.saturating_mul(cols).saturating_add(col))
                    .is_some_and(|revision| *revision >= *required_revision)
            },
        );
        let header_ready = self.authoritative_header_revision >= required_header_revision;
        // Received authority that the presentation has not drawn yet: the
        // header, the whole grid, or this row.
        let row_presentation_pending = self.presentation_full_pending
            || self.presentation_header_pending
            || self
                .presentation_dirty_set
                .get(usize::from(row))
                .copied()
                .unwrap_or(2)
                == 2;
        let was_visible = self.has_visible_predictions_internal();
        // A typed glyph the row already showed — an autosuggestion accepted one
        // character at a time — changes no cell when it is echoed, so no cell
        // revision can ever advance for it and `cells_ready` stays false for
        // as long as the op lives. Authority nevertheless shows the edit
        // exactly: a header newer than the op has moved the cursor to the
        // projected column and the row reads as projected. Only the echo can
        // produce that pair; the watermark advertisement that overtakes an echo
        // leaves the cursor a column short. Measured 2026-09-07: without this,
        // fish refused every second keystroke of a line that matched history.
        let echo_shown = valid_projection
            && header_ready
            && !cells_ready
            && self.authoritative_cursor()
                == Some((
                    row,
                    start_col.saturating_add(clamp_usize_to_u16(self.shadow_replay_scratch.cursor)),
                ))
            && self.shadow_state_matches_authority(
                row,
                start_col,
                &self.shadow_replay_scratch,
                false,
            );

        if !valid_projection {
            mismatched = 1;
        } else if (!cells_ready || !header_ready) && !echo_shown {
            // Coverage without evidence. The authenticated input watermark
            // advances at PTY *write* completion, and a stale advertisement is
            // by itself a reason for the daemon to flush, so a header-only
            // frame carrying no cell authority for this edit routinely
            // overtakes the slave's echo. It contradicts nothing: leave the
            // model exactly as it is, credit nothing, and damage nothing.
            //
            // The deferred count is what keeps the worker re-examining at its
            // own deadline. Without it a peer that goes quiet after covering an
            // op has nothing left to drive reconciliation, and the lifetime
            // that is now the only bound on an unechoed prediction would be
            // enforced whenever the next rtt sample happened to arrive.
            self.reconcile_stats = [0, 0, 0, 0, 0, 1, 0];
            return;
        } else {
            let cells_match = self.shadow_state_matches_authority(
                row,
                start_col,
                &self.shadow_replay_scratch,
                false,
            );
            let cursor_matches = self.authoritative_cursor()
                == Some((
                    row,
                    start_col.saturating_add(clamp_usize_to_u16(self.shadow_replay_scratch.cursor)),
                ));
            if !cells_match
                && !seal_answerable
                && self.shadow_state_matches_authority(row, start_col, &line.base, true)
                && (0..self.shadow_touch_revision_scratch.len()).all(|offset| {
                    let cell = &self.term.grid()[Point::new(
                        Line(i32::from(row)),
                        Column(usize::from(start_col) + offset),
                    )];
                    cell_is_predictable_width_one(cell)
                        && authoritative_cell_codepoint(cell)
                            == shadow_state_codepoint(&line.base, offset)
                })
            {
                // A repeated absolute row can refresh every cell revision before
                // a later header advertises the next PTY write. If the cursor
                // and the whole affected span still show the exact base, zero
                // operations have echoed: this is not a contradiction. Include
                // the pending suffix so a changed cell beyond base.cells cannot
                // masquerade as an unchanged base. The lifetime above still
                // bounds the wait, and no prediction receives confirmation.
                if let Some(line) = self.shadow_line.as_mut() {
                    line.mismatch_first_seen_at_ms = None;
                }
                self.reconcile_stats = [0, 0, 0, 0, 0, 1, 0];
                return;
            }
            if !cells_match && seal_answerable && !seal_contradiction_is_evidence {
                // The sealing input transformed the row past the projection —
                // a paste landed, Ctrl-U cleared the line, a completion
                // rewrote it. Authority already shows the result, so this is
                // not a contradiction of what was painted and does not touch
                // trust; the line is simply finished.
                if row_presentation_pending {
                    // But only once that result is drawn. Finishing the line
                    // on received authority alone puts the presented row back
                    // — the one without the glyphs — for as long as the
                    // transformed row waits on its presentation, with the
                    // cursor stepping back to match. The same hold as a
                    // confirmation's, below.
                    self.reconcile_stats = [0, 0, 0, 0, 0, 1, 0];
                    return;
                }
                discarded = line.ops.len() as u32;
                self.predict_flush_because(CursorCause::FlushSealResolved);
                self.refresh_shadow_received_compatibility();
                self.reconcile_stats = [0, 0, 0, 0, discarded, 0, 0];
                return;
            }
            if !cells_match {
                let grace_elapsed = self
                    .shadow_line
                    .as_ref()
                    .and_then(|line| line.mismatch_first_seen_at_ms)
                    .is_some_and(|first_seen_at_ms| {
                        now_ms - first_seen_at_ms >= PREDICTION_MISMATCH_GRACE_MS
                    });
                if grace_elapsed {
                    mismatched = 1;
                } else {
                    if let Some(line) = self.shadow_line.as_mut() {
                        line.mismatch_first_seen_at_ms.get_or_insert(now_ms);
                    }
                    // The authoritative row is already dirty from frame apply.
                    // This extra edge asks the worker to reconcile again at the
                    // owned grace deadline even if no correction arrives.
                    self.prediction_render_dirty = true;
                    self.reconcile_stats = [0, 0, 0, 0, 0, 1, 0];
                    return;
                }
            } else if !cursor_matches && !seal_answerable {
                // A newer header can still precede terminal echo. Wait for
                // exact cursor authority rather than turning PTY scheduling
                // into a false contradiction — and wait without retracting,
                // for the same reason as the branch above. An answerable sealed
                // line expects no cursor at all: the input that sealed it moved
                // the cursor wherever the shell put it, and the cells alone say
                // whether the glyphs were right.
                if let Some(line) = self.shadow_line.as_mut() {
                    line.mismatch_first_seen_at_ms = None;
                }
                self.reconcile_stats = [0, 0, 0, 0, 0, 1, 0];
                return;
            } else {
                if let Some(line) = self.shadow_line.as_mut() {
                    line.mismatch_first_seen_at_ms = None;
                }
                if has_cell_evidence || cursor_changed {
                    confirmed = covered as u32;
                } else {
                    no_credit = covered as u32;
                }
            }
        }

        if mismatched == 0 && row_presentation_pending {
            // Matching received authority is not yet a visual replacement.
            // Keep the exact projected operations against the eligible base;
            // otherwise local feedback would erase a confirmed prefix before
            // the coherent row transaction containing its echo can be drawn.
            // Contradiction, expiry and safety revocation still act immediately.
            self.reconcile_stats = [0, 0, 0, 0, 0, 1, 0];
            return;
        }
        if mismatched == 0 {
            rebase_shadow_cell_styles_from_authority(
                self.term.grid(),
                row,
                start_col,
                &mut self.shadow_replay_scratch,
            );
            if let Some(line) = self.shadow_line.as_mut() {
                std::mem::swap(&mut line.base, &mut self.shadow_replay_scratch);
                // A vacated column stops being the model's the moment authority
                // has answered the erase that vacated it. Keeping the claim is
                // what would paint a blank over whatever the shell put back.
                line.base.extent = line.base.cells.len();
                line.base.clear_meta.truncate(line.base.extent);
                line.ops.drain(..covered);
                line.projected.clone_from(&line.base);
                line.mismatch_first_seen_at_ms = None;
                for index in 0..line.ops.len() {
                    let op = line.ops[index];
                    if !apply_shadow_op(&mut line.projected, op) {
                        mismatched = 1;
                        break;
                    }
                }
                self.predicted_cursor = shadow_cursor(line);
            }
            self.cursor_model_cause = CursorCause::ReconcileRebase;
            if mismatched == 0 {
                if confirmed > 0 {
                    self.confirmed_epoch = next_confirmed_epoch;
                }
                self.sync_predictions_from_shadow();
                self.mark_shadow_visual_change(was_visible);
                if sealed
                    && self
                        .shadow_line
                        .as_ref()
                        .is_some_and(|line| line.ops.is_empty())
                {
                    self.predict_flush_because(CursorCause::FlushSealResolved);
                }
            }
        }
        if mismatched > 0 {
            confirmed = 0;
            let pending = self
                .shadow_line
                .as_ref()
                .map(|line| line.ops.len())
                .unwrap_or(0);
            discarded = pending.saturating_sub(1) as u32;
            self.predict_flush_because(CursorCause::FlushReconcileMismatch);
        }
        self.refresh_shadow_received_compatibility();
        // `expired_covered`/`expired_stalled` are unreachable here: the expiry
        // branch above returns.
        self.reconcile_stats = [confirmed, mismatched, 0, no_credit, discarded, 0, 0];
    }

    pub fn reconcile_stats_ptr(&self) -> *const u32 {
        self.reconcile_stats.as_ptr()
    }

    pub fn reconcile_stats_len(&self) -> usize {
        self.reconcile_stats.len()
    }

    pub fn prediction_render_dirty(&self) -> bool {
        self.prediction_render_dirty
    }

    pub fn clear_prediction_render_dirty(&mut self) {
        self.prediction_render_dirty = false;
    }

    pub fn has_predictions(&self) -> bool {
        self.shadow_line
            .as_ref()
            .is_some_and(|line| !line.ops.is_empty())
    }

    pub fn visible_prediction_input_seqs_ptr(&self) -> *const u32 {
        self.visible_prediction_input_seqs.as_ptr()
    }

    pub fn visible_prediction_input_seqs_len(&self) -> usize {
        self.visible_prediction_input_seqs.len()
    }

    pub fn visible_prediction_clear_effect_pairs_ptr(&self) -> *const u32 {
        self.visible_prediction_clear_effect_pairs.as_ptr()
    }

    pub fn visible_prediction_clear_effect_pairs_len(&self) -> usize {
        self.visible_prediction_clear_effect_pairs.len()
    }

    pub fn visible_prediction_input_seqs_truncated(&self) -> bool {
        self.visible_prediction_input_seqs_truncated
    }

    // ── Font / atlas API ─────────────────────────────────────────────────────

    pub fn set_font_bytes(
        &mut self,
        normal: &[u8],
        bold: &[u8],
        italic: &[u8],
        bold_italic: &[u8],
    ) {
        self.replace_fonts(load_fonts(normal, bold, italic, bold_italic));
    }

    pub fn set_regular_font_bytes(&mut self, normal: &[u8]) {
        let normal = load_font(normal);
        self.replace_fonts(regular_font_aliases(normal));
    }

    /// Install the three style faces, keeping the already-parsed regular face.
    ///
    /// Promotion happens in stages, and going through `set_font_bytes` would
    /// re-parse the regular face the earlier stage already paid for — parsing
    /// costs roughly 2.7 µs per glyph, so on the bundled faces that is tens of
    /// milliseconds thrown away on the thread that also drives rendering.
    pub fn set_style_font_bytes(&mut self, bold: &[u8], italic: &[u8], bold_italic: &[u8]) {
        let normal = match self.atlas.as_ref() {
            Some(atlas) => Rc::clone(&atlas.fonts[0]),
            None => return,
        };
        let settings = terminal_font_settings();
        let style = |bytes: &[u8]| {
            fontdue::Font::from_bytes(bytes, settings)
                .map(Rc::new)
                .unwrap_or_else(|_| Rc::clone(&normal))
        };
        let fonts = [
            Rc::clone(&normal),
            style(bold),
            style(italic),
            style(bold_italic),
        ];
        self.replace_fonts(fonts);
    }

    fn replace_fonts(&mut self, fonts: [Rc<fontdue::Font>; 4]) {
        self.atlas = Some(atlas::GlyphAtlas::new(fonts));
        self.row_geometry.clear();
        self.geometry_atlas_generation = 0;
        self.geometry_buffers_initialized = false;
        self.full_damage = true;
    }

    pub fn set_cell_metrics(&mut self, px_per_em: f32, line_height: f32, dpr: f32) {
        if !px_per_em.is_finite()
            || px_per_em <= 0.0
            || !line_height.is_finite()
            || line_height <= 0.0
            || !dpr.is_finite()
            || dpr <= 0.0
        {
            return;
        }
        let atlas = match self.atlas.as_mut() {
            Some(a) => a,
            None => return,
        };
        let old_px_per_em = atlas.px_per_em.to_bits();
        let old_layout_metrics = (
            atlas.cell_w.to_bits(),
            atlas.cell_h.to_bits(),
            atlas.baseline.to_bits(),
        );
        apply_cell_metrics_to_atlas(atlas, px_per_em, line_height);
        let raster_metrics_changed = old_px_per_em != atlas.px_per_em.to_bits();
        let layout_metrics_changed = old_layout_metrics
            != (
                atlas.cell_w.to_bits(),
                atlas.cell_h.to_bits(),
                atlas.baseline.to_bits(),
            );
        if raster_metrics_changed {
            atlas.reset_raster_cache();
            self.geometry_atlas_generation = 0;
        }
        if raster_metrics_changed || layout_metrics_changed {
            self.row_geometry.clear();
            self.geometry_buffers_initialized = false;
        }
        self.cell_dpr = dpr;
        self.full_damage = true;
    }

    pub fn cell_metrics_ptr(&mut self) -> *const f32 {
        self.cell_metrics_buf = match self.atlas.as_ref() {
            Some(a) => [a.cell_w, a.cell_h, a.baseline, self.cell_dpr],
            None => [8.0, 16.0, 13.0, 1.0],
        };
        self.cell_metrics_buf.as_ptr()
    }

    pub fn cell_metrics_len(&self) -> usize {
        self.cell_metrics_buf.len()
    }

    pub fn atlas_is_dirty(&self) -> bool {
        self.atlas.as_ref().map(|a| a.dirty).unwrap_or(false)
    }

    pub fn atlas_dirty_rect_ptr(&mut self) -> *const u32 {
        self.atlas_dirty_buf = match self.atlas.as_ref() {
            Some(a) => a.dirty_rect,
            None => [0, 0, 0, 0],
        };
        self.atlas_dirty_buf.as_ptr()
    }

    pub fn atlas_dirty_rect_len(&self) -> usize {
        self.atlas_dirty_buf.len()
    }

    pub fn atlas_pixels_ptr(&self) -> *const u8 {
        match self.atlas.as_ref() {
            Some(a) => a.pixels.as_ptr(),
            None => std::ptr::null(),
        }
    }

    pub fn atlas_width(&self) -> u32 {
        self.atlas.as_ref().map(|a| a.atlas_w).unwrap_or(0)
    }

    pub fn atlas_height(&self) -> u32 {
        self.atlas.as_ref().map(|a| a.atlas_h).unwrap_or(0)
    }

    pub fn atlas_generation(&self) -> u32 {
        self.atlas.as_ref().map(|a| a.generation()).unwrap_or(0)
    }

    /// Rasterize printable ASCII into the same cache used by terminal WebGL
    /// geometry and publish its exact pixel coordinates and bearings to JS.
    pub fn prepare_speculative_ascii_atlas(&mut self) -> bool {
        let Some(atlas) = self.atlas.as_mut() else {
            return false;
        };
        let mut entries = [0_i32; SPECULATIVE_ASCII_ENTRIES_LEN];
        for codepoint in SPECULATIVE_ASCII_FIRST..=SPECULATIVE_ASCII_LAST {
            let Some(entry) = atlas.get_or_rasterize(atlas::GlyphKey {
                codepoint,
                style: PREDICTION_STYLE_NORMAL,
            }) else {
                continue;
            };
            let offset =
                (codepoint - SPECULATIVE_ASCII_FIRST) as usize * SPECULATIVE_GLYPH_ENTRY_WORDS;
            entries[offset] = i32::from(entry.atlas_x);
            entries[offset + 1] = i32::from(entry.atlas_y);
            entries[offset + 2] = i32::from(entry.width);
            entries[offset + 3] = i32::from(entry.height);
            entries[offset + 4] = i32::from(entry.offset_x);
            entries[offset + 5] = i32::from(entry.offset_y);
        }
        self.speculative_ascii_entries = entries;
        true
    }

    pub fn speculative_ascii_entries_ptr(&self) -> *const i32 {
        self.speculative_ascii_entries.as_ptr()
    }

    pub fn speculative_ascii_entries_len(&self) -> usize {
        self.speculative_ascii_entries.len()
    }

    pub fn atlas_mark_clean(&mut self) {
        if let Some(a) = self.atlas.as_mut() {
            a.mark_clean();
        }
    }

    /// Glyphs seen during build_geometry that aren't in the bundled fonts,
    /// as flat `(codepoint, style)` pairs.
    ///
    /// The style travels with the codepoint because injection resolves exactly
    /// one `(codepoint, style)` slot. Reporting the codepoint alone let JS
    /// answer a bold miss with a normal-style injection, leaving the bold slot
    /// unresolved and the pair re-queued on the next build, forever.
    pub fn missing_codepoints_ptr(&mut self) -> *const u32 {
        self.missing_buf.clear();
        if let Some(atlas) = self.atlas.as_ref() {
            self.missing_buf.reserve(atlas.pending_len() * 2);
            for key in atlas.pending_keys() {
                self.missing_buf.push(key.codepoint);
                self.missing_buf.push(u32::from(key.style));
            }
        }
        self.missing_buf.as_ptr()
    }

    pub fn missing_codepoints_len(&self) -> usize {
        self.missing_buf.len()
    }

    /// Close the pass after JS has injected everything it could. Whatever is
    /// still queued was declined and is recorded so it is never offered again.
    pub fn finish_missing_pass(&mut self) {
        if let Some(a) = self.atlas.as_mut() {
            a.finish_missing_pass();
        }
    }

    /// Inject a Canvas-2D-rasterized glyph (R8 alpha pixels) into the atlas.
    pub fn inject_glyph(
        &mut self,
        cp: u32,
        style: u8,
        w: u16,
        h: u16,
        ox: i16,
        oy: i16,
        pixels: &[u8],
    ) -> bool {
        let atlas = match self.atlas.as_mut() {
            Some(a) => a,
            None => return false,
        };
        let injected = atlas.inject_extern(
            atlas::GlyphKey {
                codepoint: cp,
                style,
            },
            pixels,
            w,
            h,
            ox,
            oy,
        );
        if injected {
            self.row_geometry.clear();
            self.geometry_buffers_initialized = false;
            self.full_damage = true;
        }
        injected
    }

    // ── Geometry build ────────────────────────────────────────────────────────

    /// Promote received rows and their matching header as one visual base.
    /// The caller owns presentation eligibility; decode and ACK never wait here.
    /// A steady sparse commit copies only changed rows into retained cell storage.
    pub fn commit_presentation_state(&mut self) -> u32 {
        let rows = self.term.grid().screen_lines();
        let cols = self.term.grid().columns();
        if let Some(graphics) = self.graphics.as_mut() {
            graphics.commit(
                rows,
                self.presentation_full_pending,
                &self.presentation_dirty_rows,
            );
            self.geometry_state[GEOMETRY_STATE_LEN - 1] = graphics.revision();
        }
        let resized = self.presentation_grid.screen_lines() != rows
            || self.presentation_grid.columns() != cols;
        if resized {
            self.presentation_grid.resize(false, rows, cols);
            self.presentation_grid.update_history(0);
            self.presentation_row_versions.resize(rows, 0);
            self.presentation_full_pending = true;
        }
        #[cfg(not(target_arch = "wasm32"))]
        {
            self.presentation_cell_links.resize(rows * cols, 0);
            // A row the grid gained is new at this commit, whatever commit a
            // row of that index showed before the grid lost it.
            self.presentation_commits += 1;
            self.presentation_row_commits
                .resize(rows, self.presentation_commits);
        }
        if self.presentation_full_pending {
            #[cfg(not(target_arch = "wasm32"))]
            {
                if self.display_cell_links.len() == rows * cols {
                    self.presentation_cell_links
                        .copy_from_slice(&self.display_cell_links);
                } else {
                    self.presentation_cell_links.fill(0);
                }
                self.presentation_row_commits
                    .fill(self.presentation_commits);
            }
            let source = self.term.grid();
            let target = &mut self.presentation_grid;
            for row in 0..rows {
                let line = Line(row as i32);
                target[line][..].clone_from_slice(&source[line][..]);
                self.presentation_row_versions[row] =
                    self.display_row_versions.get(row).copied().unwrap_or(0);
            }
            self.full_damage = true;
            self.presentation_dirty_set.fill(0);
        } else {
            let source = self.term.grid();
            let target = &mut self.presentation_grid;
            for row in self.presentation_dirty_rows.iter().copied() {
                let index = usize::from(row);
                let line = Line(i32::from(row));
                if self.presentation_dirty_set[index] == 2 {
                    target[line][..].clone_from_slice(&source[line][..]);
                    if !self.damaged_row_set[index] {
                        self.damaged_row_set[index] = true;
                        self.damaged_rows.push(row);
                    }
                }
                #[cfg(not(target_arch = "wasm32"))]
                {
                    let range = index * cols..(index + 1) * cols;
                    if let Some(links) = self.display_cell_links.get(range.clone()) {
                        self.presentation_cell_links[range].copy_from_slice(links);
                    }
                    self.presentation_row_commits[index] = self.presentation_commits;
                }
                self.presentation_row_versions[index] =
                    self.display_row_versions.get(index).copied().unwrap_or(0);
                self.presentation_dirty_set[index] = 0;
            }
        }
        let (point, shape) = {
            let content = self.term.renderable_content();
            (content.cursor.point, content.cursor.shape)
        };
        self.presentation_grid.cursor.point = point;
        self.presentation_cursor_shape = shape;
        if let Some(header) = self.last_applied_display_header {
            self.presentation_scroll_serial = header.scroll_serial;
        }
        self.presentation_cursor_dirty |= self.presentation_header_pending || resized;
        self.presentation_editor_anchor = self.editor_anchor;
        self.presentation_editor_anchor_generation = self.editor_anchor_generation;
        self.presentation_dirty_rows.clear();
        self.presentation_full_pending = false;
        self.presentation_header_pending = false;
        self.presentation_revision = self.authoritative_revision;
        self.shadow_presentation_split = self.shadow_received_split;
        // Received evidence can have confirmed a projected prefix while its
        // visual replacement was held. Reconcile after this commit, never erase
        // those speculative pixels against a base that still lacks the echo.
        self.presentation_revision
    }

    pub fn presentation_revision(&self) -> u32 {
        self.presentation_revision
    }

    pub fn presentation_cols(&self) -> u16 {
        clamp_usize_to_u16(self.presentation_grid.columns())
    }

    pub fn presentation_rows(&self) -> u16 {
        clamp_usize_to_u16(self.presentation_grid.screen_lines())
    }

    pub fn presentation_row_version(&self, row: u16) -> u32 {
        self.presentation_row_versions
            .get(usize::from(row))
            .copied()
            .unwrap_or(0)
    }

    pub fn build_geometry(&mut self) {
        self.build_geometry_inner(true);
    }

    fn build_geometry_inner(&mut self, retry_after_growth: bool) {
        let current_atlas_generation = self
            .atlas
            .as_ref()
            .map(|atlas| atlas.generation())
            .unwrap_or(0);
        if current_atlas_generation != self.geometry_atlas_generation {
            self.row_geometry.clear();
            self.geometry_buffers_initialized = false;
            self.full_damage = true;
        }
        if self.damaged_rows.is_empty()
            && !self.prediction_render_dirty
            && !self.preedit_dirty
            && !self.full_damage
            && !self.presentation_cursor_dirty
        {
            return;
        }

        let use_shadow_row_projection = self.shadow_requires_row_projection();
        let shadow_projection = if use_shadow_row_projection {
            self.shadow_line
                .as_ref()
                .map(|line| ShadowRenderProjection {
                    row: usize::from(line.row),
                    start_col: usize::from(line.start_col),
                    cells: &line.projected.cells,
                    extent: line.projected.extent,
                })
        } else {
            None
        };
        let mut visible_predictions = std::mem::take(&mut self.visible_predictions_scratch);
        visible_predictions.clear();
        visible_predictions.extend(
            self.predictions
                .iter()
                .copied()
                .filter(|prediction| self.prediction_is_visible(prediction)),
        );
        // Use the very same post-gate set as glyph preparation. These borrowed
        // memberships describe geometry, not whether diagnostics are enabled.
        let grid = &self.presentation_grid;
        let rows = grid.screen_lines();
        let cols = grid.columns();
        let mut truncated = self.pending_prediction_clear_effects_truncated;
        self.visible_prediction_input_seqs.clear();
        let visible_capacity = visible_predictions
            .len()
            .min(MAX_VISIBLE_PREDICTION_EFFECTS);
        if visible_capacity > self.visible_prediction_input_seqs.capacity() {
            self.visible_prediction_input_seqs
                .reserve(visible_capacity.next_power_of_two());
        }
        self.visible_prediction_clear_effect_pairs.clear();
        let clear_capacity = self
            .pending_prediction_clear_effects
            .len()
            .min(MAX_VISIBLE_PREDICTION_EFFECTS)
            * 2;
        if clear_capacity > self.visible_prediction_clear_effect_pairs.capacity() {
            self.visible_prediction_clear_effect_pairs
                .reserve(clear_capacity.next_power_of_two());
        }
        for prediction in &visible_predictions {
            if self.visible_prediction_input_seqs.len() >= MAX_VISIBLE_PREDICTION_EFFECTS {
                truncated = true;
                break;
            }
            self.visible_prediction_input_seqs
                .push(prediction.input_seq);
        }
        if self.shadow_cursor_is_visible()
            && !matches!(self.presentation_cursor_shape, CursorShape::Hidden)
            && self.presentation_cursor() != Some(self.predicted_cursor)
            && let Some(cursor_input_seq) = self
                .shadow_line
                .as_ref()
                .and_then(|line| line.ops.last())
                .map(|op| op.meta.input_seq)
            && !self
                .visible_prediction_input_seqs
                .contains(&cursor_input_seq)
        {
            if self.visible_prediction_input_seqs.len() >= MAX_VISIBLE_PREDICTION_EFFECTS {
                truncated = true;
            } else {
                self.visible_prediction_input_seqs.push(cursor_input_seq);
            }
        }
        if !truncated {
            for effect in &self.pending_prediction_clear_effects {
                let row = usize::from(effect.row);
                let col = usize::from(effect.col);
                let replaced_by_visible_prediction = visible_predictions
                    .iter()
                    .any(|prediction| prediction.row == effect.row && prediction.col == effect.col);
                let still_visibly_clear = row < rows
                    && col < cols
                    && !replaced_by_visible_prediction
                    && u32::from(grid[Point::new(Line(row as i32), Column(col))].c)
                        == effect.original_codepoint;
                if !still_visibly_clear {
                    continue;
                }
                if self.visible_prediction_input_seqs.len()
                    + self.visible_prediction_clear_effect_pairs.len() / 2
                    >= MAX_VISIBLE_PREDICTION_EFFECTS
                {
                    truncated = true;
                    break;
                }
                self.visible_prediction_clear_effect_pairs
                    .push(effect.input_seq);
                self.visible_prediction_clear_effect_pairs
                    .push(effect.cleared_input_seq);
            }
        }
        if truncated {
            self.visible_prediction_input_seqs.clear();
            self.visible_prediction_clear_effect_pairs.clear();
        }
        self.visible_prediction_input_seqs_truncated = truncated;
        let atlas = match self.atlas.as_mut() {
            Some(a) => a,
            None => {
                self.visible_predictions_scratch = visible_predictions;
                self.pending_prediction_clear_effects.clear();
                self.pending_prediction_clear_effects_truncated = false;
                self.refresh_geometry_state();
                return;
            }
        };
        let build_atlas_generation = atlas.generation();
        let grid = &self.presentation_grid;
        let cols = grid.columns();
        let rows = grid.screen_lines();
        let cw = atlas.cell_w;
        let ch = atlas.cell_h;
        let baseline = atlas.baseline;
        let aw = atlas.atlas_w as f32;
        let ah = atlas.atlas_h as f32;
        let theme = self.theme;
        if self.row_geometry.len() != rows {
            self.row_geometry.clear();
            self.row_geometry.resize_with(rows, RowGeometry::default);
            self.full_damage = true;
            self.geometry_buffers_initialized = false;
        }

        let mut rows_changed = self.full_damage;
        let mut rebuild_bg = self.full_damage || !self.geometry_buffers_initialized;
        let mut rebuild_glyph =
            self.full_damage || !self.geometry_buffers_initialized || self.prediction_render_dirty;
        let mut rebuild_deco = self.full_damage || !self.geometry_buffers_initialized;
        // The preedit overlay is cursor-anchored: while active, cursor motion
        // must reposition it, so force full rebuilds (composition sessions are
        // short and human-paced; rebuilds already dominate during typing).
        let preedit_was_dirty = self.preedit_dirty;
        let preedit_active = !self.preedit_chars.is_empty();
        if preedit_active || preedit_was_dirty {
            rebuild_bg = true;
            rebuild_glyph = true;
            rebuild_deco = true;
        }
        self.bg_dirty = (0, 0);
        self.glyph_dirty = (0, 0);
        self.deco_dirty = (0, 0);
        self.cursor_dirty = (0, 0);
        if self.full_damage {
            for row_idx in 0..rows {
                build_row_geometry_into(
                    grid,
                    atlas,
                    row_idx,
                    cols,
                    cw,
                    ch,
                    baseline,
                    aw,
                    ah,
                    theme,
                    shadow_projection.as_ref(),
                    &mut self.row_geometry[row_idx],
                );
            }
        } else if !self.damaged_rows.is_empty() {
            self.damaged_rows.sort_unstable();
            for row in self.damaged_rows.iter().copied() {
                let row_idx = usize::from(row);
                if row_idx >= rows {
                    continue;
                }
                rows_changed = true;
                let old_bg_len = self.row_geometry[row_idx].bg.len();
                let old_glyph_len = self.row_geometry[row_idx].glyph.len();
                let old_deco_len = self.row_geometry[row_idx].deco.len();
                let bg_start = self.row_geometry[row_idx].bg_start;
                let glyph_start = self.row_geometry[row_idx].glyph_start;
                let deco_start = self.row_geometry[row_idx].deco_start;
                build_row_geometry_into(
                    grid,
                    atlas,
                    row_idx,
                    cols,
                    cw,
                    ch,
                    baseline,
                    aw,
                    ah,
                    theme,
                    shadow_projection.as_ref(),
                    &mut self.row_geometry[row_idx],
                );
                let row = &self.row_geometry[row_idx];
                if !rebuild_bg && old_bg_len == row.bg.len() {
                    self.bg_buf[bg_start..bg_start + row.bg.len()].copy_from_slice(&row.bg);
                    widen_dirty_range(&mut self.bg_dirty, bg_start / 7, row.bg.len() / 7);
                } else {
                    rebuild_bg = true;
                }
                if !rebuild_glyph && old_glyph_len == row.glyph.len() {
                    self.glyph_buf[glyph_start..glyph_start + row.glyph.len()]
                        .copy_from_slice(&row.glyph);
                    widen_dirty_range(
                        &mut self.glyph_dirty,
                        glyph_start / 14,
                        row.glyph.len() / 14,
                    );
                } else {
                    rebuild_glyph = true;
                }
                if !rebuild_deco && old_deco_len == row.deco.len() {
                    self.deco_buf[deco_start..deco_start + row.deco.len()]
                        .copy_from_slice(&row.deco);
                    widen_dirty_range(&mut self.deco_dirty, deco_start / 7, row.deco.len() / 7);
                } else {
                    rebuild_deco = true;
                }
            }
        }

        if rebuild_bg {
            rebuild_bg_buffer(&mut self.bg_buf, &mut self.row_geometry);
            self.bg_dirty = (0, (self.bg_buf.len() / 7) as u32);
        }
        if rebuild_glyph {
            rebuild_glyph_buffer(&mut self.glyph_buf, &mut self.row_geometry);
            self.glyph_dirty = (0, (self.glyph_buf.len() / 14) as u32);
        }
        if rebuild_deco {
            rebuild_deco_buffer(&mut self.deco_buf, &mut self.row_geometry);
            self.deco_dirty = (0, (self.deco_buf.len() / 7) as u32);
        }
        self.geometry_buffers_initialized = true;

        if rebuild_glyph && !use_shadow_row_projection {
            let prediction_glyph_start = self.glyph_buf.len() / 14;
            for prediction in &visible_predictions {
                push_prediction_glyph_into(
                    atlas,
                    &mut self.glyph_buf,
                    prediction,
                    cols,
                    rows,
                    cw,
                    ch,
                    baseline,
                    aw,
                    ah,
                    theme,
                );
            }
            let prediction_glyph_count = self.glyph_buf.len() / 14 - prediction_glyph_start;
            widen_dirty_range(
                &mut self.glyph_dirty,
                prediction_glyph_start,
                prediction_glyph_count,
            );
        }

        // IME preedit overlay — appended last so it draws above grid content.
        if preedit_active {
            let cursor_vp = point_to_viewport(0, self.presentation_grid.cursor.point);
            if let Some(vp) = cursor_vp {
                let missing = append_preedit_into(
                    atlas,
                    &mut self.bg_buf,
                    &mut self.glyph_buf,
                    &mut self.deco_buf,
                    &self.preedit_chars,
                    vp.column.0,
                    vp.line,
                    cols,
                    rows,
                    cw,
                    ch,
                    baseline,
                    aw,
                    ah,
                    theme,
                );
                self.bg_dirty = (0, (self.bg_buf.len() / 7) as u32);
                self.glyph_dirty = (0, (self.glyph_buf.len() / 14) as u32);
                self.deco_dirty = (0, (self.deco_buf.len() / 7) as u32);
                // Glyphs queued for JS-side rasterization: stay dirty so the
                // post-injection rebuild re-appends them.
                self.preedit_dirty = missing;
            } else {
                self.preedit_dirty = false;
            }
        } else {
            self.preedit_dirty = false;
        }

        let final_atlas_generation = atlas.generation();
        if final_atlas_generation != build_atlas_generation {
            // Rasterization can grow the atlas while this pass is producing
            // normalized UVs. Never expose a mixture of old/new denominators
            // (or cached rows that refer to the old layout) to the renderer.
            self.row_geometry.clear();
            self.geometry_buffers_initialized = false;
            self.full_damage = true;
            if retry_after_growth {
                self.visible_predictions_scratch = visible_predictions;
                self.build_geometry_inner(false);
            } else {
                self.visible_predictions_scratch = visible_predictions;
                self.refresh_geometry_state();
            }
            return;
        }
        self.geometry_atlas_generation = final_atlas_generation;

        // Cursor. Row damage commonly rebuilds geometry without moving or
        // restyling the cursor. Keep the existing instance and version in that
        // case so the renderer can skip the WebGL buffer upload.
        let next_cursor_geometry = if !matches!(self.presentation_cursor_shape, CursorShape::Hidden)
        {
            let cursor = if self.shadow_cursor_is_visible() {
                Some((
                    usize::from(self.predicted_cursor.0),
                    usize::from(self.predicted_cursor.1),
                ))
            } else {
                point_to_viewport(0, self.presentation_grid.cursor.point)
                    .map(|vp| (vp.line, vp.column.0))
            };
            if let Some((cursor_row, cursor_col)) = cursor {
                let cx = cursor_col as f32 * cw;
                let cy = cursor_row as f32 * ch;
                let shape_id = match self.presentation_cursor_shape {
                    CursorShape::Block | CursorShape::HollowBlock => 0.0,
                    CursorShape::Beam => 1.0,
                    CursorShape::Underline => 2.0,
                    CursorShape::Hidden => 0.0,
                };
                Some(cursor_geometry(cx, cy, cw, ch, theme.cursor, shape_id))
            } else {
                None
            }
        } else {
            None
        };
        let cursor_changed = match next_cursor_geometry.as_ref() {
            Some(geometry) => self.cursor_buf.as_slice() != geometry.as_slice(),
            None => !self.cursor_buf.is_empty(),
        };
        if cursor_changed {
            self.cursor_buf.clear();
            if let Some(geometry) = next_cursor_geometry {
                push8(&mut self.cursor_buf, geometry);
            }
            self.cursor_dirty = (0, (self.cursor_buf.len() / 8) as u32);
            self.cursor_version = self.cursor_version.wrapping_add(1).max(1);
        }

        if rows_changed || preedit_was_dirty || preedit_active {
            self.bg_version = self.bg_version.wrapping_add(1).max(1);
            self.deco_version = self.deco_version.wrapping_add(1).max(1);
        }
        if rows_changed || self.prediction_render_dirty || preedit_was_dirty || preedit_active {
            self.glyph_version = self.glyph_version.wrapping_add(1).max(1);
        }
        self.clear_damaged_rows();
        self.full_damage = false;
        self.presentation_cursor_dirty = false;
        self.shadow_row_projected = use_shadow_row_projection;
        self.visible_predictions_scratch = visible_predictions;
        // Atlas growth can restart this build. Consume one-shot clear effects
        // only after the final geometry succeeds, not before a recursive retry.
        self.pending_prediction_clear_effects.clear();
        self.pending_prediction_clear_effects_truncated = false;
        self.refresh_geometry_state();
    }

    // ── Geometry pointer exports ──────────────────────────────────────────────

    fn refresh_geometry_state(&mut self) {
        // The image revision changes only at presentation commit. Rewriting it
        // here adds a load/store to every text-only geometry refresh.
        self.geometry_state[..GEOMETRY_STATE_LEN - 1].copy_from_slice(&[
            self.bg_buf.as_ptr() as usize as u32,
            (self.bg_buf.len() / 7) as u32,
            self.bg_version,
            self.bg_dirty.0,
            self.bg_dirty.1,
            self.glyph_buf.as_ptr() as usize as u32,
            (self.glyph_buf.len() / 14) as u32,
            self.glyph_version,
            self.glyph_dirty.0,
            self.glyph_dirty.1,
            self.deco_buf.as_ptr() as usize as u32,
            (self.deco_buf.len() / 7) as u32,
            self.deco_version,
            self.deco_dirty.0,
            self.deco_dirty.1,
            self.cursor_buf.as_ptr() as usize as u32,
            (self.cursor_buf.len() / 8) as u32,
            self.cursor_version,
            self.cursor_dirty.0,
            self.cursor_dirty.1,
        ]);
    }

    pub fn geometry_state_ptr(&self) -> *const u32 {
        self.geometry_state.as_ptr()
    }

    pub fn geometry_state_len(&self) -> usize {
        self.geometry_state.len()
    }

    /// The daemon's mode word, as the latest header (or input-routing word)
    /// carried it. This grid parses no escape sequences, so it has no modes of
    /// its own to derive one from; the dataplane's `encode_terminal_mode` is
    /// the one derivation.
    pub fn mouse_mode(&self) -> u32 {
        self.display_mode
    }

    /// Adopt the daemon's input-routing word, sent on the control lane while a
    /// synchronized update is paused and no display header can leave. Only the
    /// routing and input-report bits change; the alternate screen and the grant
    /// keep the last header's values. The routing bits stay the word's across
    /// every header applied until [`Self::release_input_routing`], because a
    /// frame sent before the word can arrive after it.
    pub fn set_input_routing(&mut self, word: u32) {
        self.display_mode =
            (self.display_mode & !DISPLAY_MODE_INPUT_ROUTING) | (word & DISPLAY_MODE_INPUT_ROUTING);
        self.input_routing_held = true;
    }

    /// A header captured after the input-routing word has applied: the routing
    /// bits are that header's, and every later header's, again.
    pub fn release_input_routing(&mut self) {
        self.input_routing_held = false;
        if let Some(header) = self.last_applied_display_header {
            self.display_mode = (self.display_mode & !DISPLAY_MODE_INPUT_ROUTING)
                | (u32::from(header.mode_flags) & DISPLAY_MODE_INPUT_ROUTING);
        }
    }

    /// Every viewport row as text, one line per grid row, joined by `\n`.
    ///
    /// Untrimmed on purpose. The selection layer lays this text over the canvas
    /// and the browser slices the copy out of it, so a mid-row selection has to
    /// keep the spaces the user actually highlighted. Trailing-space policy
    /// belongs to the copy assembly, which knows where the selection ends; this
    /// function cannot see that and would apply the trim to the wrong range.
    ///
    /// Wide-character spacers are skipped, so a row's char count is its column
    /// count minus one per wide character. The layer measures glyph advance
    /// itself and never assumes char index equals column.
    pub fn viewport_rows(&self) -> String {
        Self::grid_viewport_rows(self.term.grid())
    }

    /// Selection/accessibility text from the same eligible base as geometry.
    pub fn presentation_viewport_rows(&self) -> String {
        Self::grid_viewport_rows(&self.presentation_grid)
    }

    fn grid_viewport_rows(grid: &Grid<Cell>) -> String {
        let cols = grid.columns();
        let rows = grid.screen_lines();
        let mut out = String::with_capacity(rows.saturating_mul(cols + 1));
        for row_idx in 0..rows {
            if row_idx > 0 {
                out.push('\n');
            }
            let line = Line(row_idx as i32);
            for col in 0..cols {
                let cell = &grid[Point::new(line, Column(col))];
                if cell.flags.contains(Flags::WIDE_CHAR_SPACER) {
                    continue;
                }
                if col > 0 && cell.c == ' ' {
                    let previous = &grid[Point::new(line, Column(col - 1))];
                    if previous.flags.contains(Flags::WIDE_CHAR) {
                        continue;
                    }
                }
                out.push(cell.c);
            }
        }
        out
    }

    /// One bit per viewport row, LSB-first within each byte: set means the row
    /// is soft-wrapped and continues onto the next one.
    ///
    /// Without it a wrapped command copies with a newline through its middle and
    /// will not run when pasted back. Alacritty's reflow keeps the wrap bit on
    /// the row's final cell, which is the only place it is authoritative.
    /// Link id per authoritative viewport cell, row-major, 0 for none.
    ///
    /// Read only while the user holds the link modifier, together with
    /// [`Self::viewport_rows`] and [`Self::viewport_text_columns`].
    pub fn viewport_links(&self) -> Vec<u32> {
        let grid = self.term.grid();
        let cells = grid.columns().saturating_mul(grid.screen_lines());
        if self.display_cell_links.len() == cells {
            self.display_cell_links.clone()
        } else {
            vec![0; cells]
        }
    }

    /// The grid column of every UTF-16 code unit of [`Self::viewport_rows`],
    /// newlines excluded, so a match found in that text maps back to cells.
    ///
    /// Needed because the text skips wide-character spacers and a character
    /// outside the BMP is two code units: neither index is a column.
    pub fn viewport_text_columns(&self) -> Vec<u16> {
        let grid = self.term.grid();
        let cols = grid.columns();
        let rows = grid.screen_lines();
        let mut out = Vec::with_capacity(rows.saturating_mul(cols));
        for row_idx in 0..rows {
            let line = Line(row_idx as i32);
            for col in 0..cols {
                let cell = &grid[Point::new(line, Column(col))];
                if cell.flags.contains(Flags::WIDE_CHAR_SPACER) {
                    continue;
                }
                if col > 0 && cell.c == ' ' {
                    let previous = &grid[Point::new(line, Column(col - 1))];
                    if previous.flags.contains(Flags::WIDE_CHAR) {
                        continue;
                    }
                }
                for _ in 0..cell.c.len_utf16() {
                    out.push(col as u16);
                }
            }
        }
        out
    }

    pub fn viewport_wrap_bits(&self) -> Vec<u8> {
        Self::grid_viewport_wrap_bits(self.term.grid())
    }

    pub fn presentation_viewport_wrap_bits(&self) -> Vec<u8> {
        Self::grid_viewport_wrap_bits(&self.presentation_grid)
    }

    fn grid_viewport_wrap_bits(grid: &Grid<Cell>) -> Vec<u8> {
        let cols = grid.columns();
        let rows = grid.screen_lines();
        let mut bits = vec![0u8; rows.div_ceil(8)];
        if cols == 0 {
            return bits;
        }
        for row_idx in 0..rows {
            let last = &grid[Point::new(Line(row_idx as i32), Column(cols - 1))];
            if last.flags.contains(Flags::WRAPLINE) {
                bits[row_idx >> 3] |= 1 << (row_idx & 7);
            }
        }
        bits
    }

    fn ensure_shadow_line(&mut self, visible: bool) -> bool {
        if self.presentation_editor_anchor != self.editor_anchor
            || self.presentation_editor_anchor_generation != self.editor_anchor_generation
            || self.presentation_grid.columns() != self.term.grid().columns()
            || self.presentation_grid.screen_lines() != self.term.grid().screen_lines()
        {
            self.ensure_refusal = CursorCause::FlushAnchorNotPresented;
            return false;
        }
        if let Some(line) = self.shadow_line.as_ref() {
            if line.sealed.is_some() {
                self.ensure_refusal = CursorCause::LineSealed;
                return false;
            }
            if !self.shadow_received_compatible {
                self.ensure_refusal = CursorCause::FlushReceivedIncompatible;
                return false;
            }
            if !self.shadow_base_matches_presentation() {
                self.ensure_refusal = CursorCause::FlushBaseMismatch;
                return false;
            }
            // A line with nothing outstanding is drawn exactly as authority
            // draws it — no predicted glyph, and the cursor already at the
            // authoritative column — so re-taking the gate here moves no pixel.
            // It is the same admission boundary as seeding, reached without
            // waiting for the flush that ends the line, which is what keeps a
            // line that began under a closed gate from staying dark for its
            // whole length.
            if let Some(line) = self.shadow_line.as_mut()
                && line.ops.is_empty()
            {
                line.visible = visible;
            }
            return true;
        }
        let Some((row, col)) = self.presentation_cursor() else {
            self.ensure_refusal = CursorCause::FlushNoSeedableLine;
            return false;
        };
        if !self.presentation_seed_has_received_base(row) {
            self.ensure_refusal = CursorCause::FlushSeedBaseNotReceived;
            return false;
        }
        let grid = &self.presentation_grid;
        let row_index = usize::from(row);
        let col_index = usize::from(col);
        if row_index >= grid.screen_lines() || col_index.saturating_add(1) >= grid.columns() {
            self.ensure_refusal = CursorCause::FlushNoSeedableLine;
            return false;
        }
        if let Some(line) = self.seed_shadow_from_editor_anchor(row, col, visible) {
            self.shadow_line = Some(line);
            self.predicted_cursor = (row, col);
            return true;
        }
        if !row_tail_is_predictable(&self.presentation_grid, row_index, col_index) {
            self.ensure_refusal = CursorCause::FlushRowTailNotPredictable;
            return false;
        }
        self.shadow_line = Some(ShadowLine {
            row,
            start_col: col,
            base: ShadowState::default(),
            projected: ShadowState::default(),
            ops: Vec::new(),
            visible,
            sealed: None,
            sealed_by_input: 0,
            mismatch_first_seen_at_ms: None,
        });
        self.predicted_cursor = (row, col);
        true
    }

    /// Seed a shadow line from the daemon-supplied prompt anchor.
    ///
    /// This is the one path that bypasses `row_tail_is_predictable`, and that
    /// bypass is the entire point. A shell drawing an autosuggestion to the
    /// right of the cursor makes the row tail non-blank, so after any mid-line
    /// flush the ordinary path can never re-seed and prediction stays dead
    /// until the next prompt. The anchor is authenticated evidence that we are
    /// inside the line editor, where that tail belongs to the shell and is
    /// exactly what the next keystroke overwrites.
    ///
    /// Everything before the cursor is adopted as the already-typed base, so a
    /// Backspace can reach back to the prompt rather than only to wherever
    /// typing resumed.
    fn seed_shadow_from_editor_anchor(
        &mut self,
        row: u16,
        col: u16,
        visible: bool,
    ) -> Option<ShadowLine> {
        let (anchor_row, anchor_col) = self.presentation_editor_anchor?;
        // The anchor describes the row the cursor is on; anything else is a
        // stale prompt (the screen scrolled since it was captured).
        if anchor_row != row || anchor_col > col {
            return None;
        }
        let grid = &self.presentation_grid;
        let cols = grid.columns();
        let start = usize::from(anchor_col);
        let cursor = usize::from(col);
        // `cursor` is indexed below, so it must be a real column, not the
        // one-past-the-end position.
        if start.saturating_add(1) >= cols || cursor >= cols {
            return None;
        }

        let line = Line(i32::from(row));
        // Include the cell AT the cursor: it is the first one a prediction
        // overwrites, and this seeding path is the only one that reaches a
        // paint without `shadow_state_matches_authority` having checked it.
        // A suggestion beginning with a wide glyph would otherwise have its
        // left half painted over, stranding the WIDE_CHAR_SPACER beside it.
        if !cell_is_predictable_width_one(&grid[Point::new(line, Column(cursor))]) {
            return None;
        }
        let mut cells = Vec::with_capacity(cursor - start);
        for column in start..cursor {
            let cell = &grid[Point::new(line, Column(column))];
            if !cell_is_predictable_width_one(cell) {
                return None;
            }
            cells.push(ShadowCell {
                codepoint: authoritative_cell_codepoint(cell),
                meta: ShadowMeta {
                    // Seeded cells are authority, not prediction: they carry no
                    // input sequence and are never emitted as speculative
                    // glyphs, because `sync_predictions_from_shadow` skips
                    // cells that already equal the grid.
                    input_seq: 0,
                    sent_at_ms: 0.0,
                    epoch: self.prediction_epoch,
                },
                fg: prediction_fg_at(grid, usize::from(row), column),
                font_style: 0,
                underline: false,
            });
        }

        let extent = cells.len();
        let state = ShadowState {
            cells,
            cursor: extent,
            extent,
            clear_meta: vec![None; extent],
        };
        Some(ShadowLine {
            row,
            start_col: anchor_col,
            base: state.clone(),
            projected: state,
            ops: Vec::new(),
            visible,
            sealed: None,
            sealed_by_input: 0,
            mismatch_first_seen_at_ms: None,
        })
    }

    /// Adopt a prompt anchor published by the daemon.
    ///
    /// `flags` bit 0 clear means no editor boundary is open, which voids the
    /// anchor. A changed anchor invalidates any shadow seeded from the old one.
    pub fn set_editor_anchor(&mut self, generation: u32, row: u16, col: u16, flags: u32) {
        let anchor = (flags & 1 != 0).then_some((row, col));
        if self.editor_anchor == anchor && self.editor_anchor_generation == generation {
            return;
        }
        self.editor_anchor = anchor;
        self.editor_anchor_generation = generation;
        // The anchor rides the reliable lane and routinely lands after the
        // datagram that drew the prompt has already been presented. A seed reads
        // only the anchor's own row, so the anchor is presented on arrival
        // whenever that row is on screen as authority holds it — no full
        // replacement pending and no changed cells of that row held — and waits
        // for the commit that presents it otherwise. Rows held elsewhere (a
        // multiplexer's status line under loss) do not hold the prompt hostage.
        // Without this, the first key of every such line was refused
        // `FlushAnchorNotPresented` until the next display frame, and a burst
        // typed faster than the path was fenced whole behind that refusal
        // (2026-09-07, `fast` + 3 %).
        let anchor_row_presented = !self.presentation_full_pending
            && anchor.is_none_or(|(row, _)| {
                self.presentation_dirty_set
                    .get(usize::from(row))
                    .copied()
                    .unwrap_or(2)
                    != 2
            });
        if anchor_row_presented {
            self.presentation_editor_anchor = anchor;
            self.presentation_editor_anchor_generation = generation;
        }
        // An open line loses its admission when the anchor changes. A sealed
        // line is still owed its echo: reliable closure or the next prompt can
        // overtake that display row. Neither proves that its painted glyphs
        // were wrong. It admits no new keys; display evidence retires the seal.
        if self
            .shadow_line
            .as_ref()
            .is_some_and(|line| line.sealed.is_none())
        {
            self.predict_flush_because(CursorCause::FlushEditorAnchor);
        }
    }

    /// Whether the next width-one printable can use the one-frame main-thread
    /// overlay without touching or shifting an existing terminal cell.
    fn speculative_printable_is_safe(&self) -> bool {
        if self.prediction_mode_is_unsafe()
            || self.presentation_editor_anchor != self.editor_anchor
            || self.presentation_editor_anchor_generation != self.editor_anchor_generation
            || self.presentation_grid.columns() != self.term.grid().columns()
            || self.presentation_grid.screen_lines() != self.term.grid().screen_lines()
        {
            return false;
        }
        if let Some(line) = self.shadow_line.as_ref() {
            let cols = self.presentation_grid.columns();
            let new_len = line.projected.cells.len().saturating_add(1);
            let cursor_col = usize::from(line.start_col).saturating_add(line.projected.cursor);
            return self.shadow_received_compatible
                && !self.graphics_intersect(line.row, cursor_col, cursor_col + 2)
                && self.shadow_base_matches_presentation()
                && line.projected.cursor == line.projected.cells.len()
                && line.ops.len() < MAX_SHADOW_OPS
                && usize::from(line.start_col).saturating_add(new_len) < cols
                && row_tail_has_uniform_background(
                    &self.presentation_grid,
                    self.theme,
                    usize::from(line.row),
                    cursor_col,
                );
        }
        let Some((row, col)) = self.presentation_cursor() else {
            return false;
        };
        if !self.presentation_seed_has_received_base(row) {
            return false;
        }
        let grid = &self.presentation_grid;
        let row_index = usize::from(row);
        let col_index = usize::from(col);
        row_index < grid.screen_lines()
            && !self.graphics_intersect(row, col_index, col_index + 2)
            && col_index.saturating_add(1) < grid.columns()
            && row_tail_is_predictable(grid, row_index, col_index)
            && row_tail_has_uniform_background(grid, self.theme, row_index, col_index)
    }

    fn graphics_intersect(&self, row: u16, left: usize, right: usize) -> bool {
        self.graphics.as_ref().is_some_and(|graphics| {
            graphics.intersects(
                usize::from(row),
                clamp_usize_to_u16(left),
                clamp_usize_to_u16(right),
            )
        })
    }

    fn speculative_cell_colors(&self, row: u16, col: u16) -> ([u8; 3], [u8; 3]) {
        let grid = &self.presentation_grid;
        let row = usize::from(row);
        let col = usize::from(col);
        if row >= grid.screen_lines() || col >= grid.columns() {
            return (self.theme.foreground, self.theme.background);
        }
        let cell = &grid[Point::new(Line(row as i32), Column(col))];
        (
            remap_rgb(self.theme, prediction_fg_at(grid, row, col)),
            displayed_cell_background(self.theme, cell),
        )
    }

    fn authoritative_cursor(&self) -> Option<(u16, u16)> {
        let renderable = self.term.renderable_content();
        point_to_viewport(renderable.display_offset, renderable.cursor.point).map(|point| {
            (
                clamp_usize_to_u16(point.line),
                clamp_usize_to_u16(point.column.0),
            )
        })
    }

    fn presentation_cursor(&self) -> Option<(u16, u16)> {
        point_to_viewport(0, self.presentation_grid.cursor.point).map(|point| {
            (
                clamp_usize_to_u16(point.line),
                clamp_usize_to_u16(point.column.0),
            )
        })
    }

    /// Whether speculative echo must be withheld right now.
    ///
    /// Neither the alternate screen nor mouse tracking is part of this. Both
    /// were proxies for "there is no line editor at the cursor", and a
    /// multiplexer breaks both at once: tmux holds the alternate screen for its
    /// whole lifetime and sets mouse tracking whenever `mouse on` is
    /// configured, while the shell inside it has an ordinary line editor. The
    /// alternate screen was dropped first, but tmux sets both bits, so the
    /// mouse proxy went on withholding prediction from exactly the users the
    /// first removal was meant to serve — 74% of all refusals in production
    /// telemetry, against 24% for the screen.
    ///
    /// Neither proxy is one of the three gates in `docs/security.md`. Mouse
    /// tracking governs how *pointer* events are encoded and says nothing about
    /// whether the shell echoes typed characters.
    ///
    /// `DISPLAY_MODE_PREDICTION_SAFE` is the real signal: the daemon sets it
    /// only inside an authenticated OSC 133 prompt boundary and clears it on
    /// command start, on unmodelled input, and on reset. A full-screen program
    /// cannot inherit a prompt's grant because `133;C` closes the boundary
    /// before it runs, and an in-process widget started from the prompt is
    /// closed out by the unmodelled keystroke that invoked it.
    fn prediction_mode_is_unsafe(&self) -> bool {
        !mode_grants_prediction(self.display_mode)
            || !self.authoritative_cursor_visible
            || !self.preedit_chars.is_empty()
    }

    /// Whether a new op may be modelled from the existing line's base.
    ///
    /// The comparison below IS the question: it checks the base cells and the
    /// cursor against the live grid. A `!authority_pending` conjunct used to
    /// guard it, and it was wrong in exactly the case it fired — a watermark
    /// advertisement covers an op without carrying its echo, changing no cell
    /// the base describes, so the base still matches. Refusing there rejected
    /// the next keystroke, opened the causal barrier and withdrew that
    /// keystroke's wire provenance, which the daemon reads as unmodelled input.
    /// Why an edit op cannot be modelled onto the current line, or `None`.
    ///
    /// The same three refusals every non-printable prediction shares, split so
    /// a flush can say which one it was: a withdrawn grant, a line that does
    /// not exist, and a base authority has moved out from under are three
    /// different defects that produce one identical cursor step.
    fn shadow_edit_refusal(&self) -> Option<CursorCause> {
        if self.prediction_mode_is_unsafe() {
            return Some(CursorCause::FlushModeUnsafe);
        }
        let Some(line) = self.shadow_line.as_ref() else {
            return Some(CursorCause::FlushNoSeedableLine);
        };
        if line.sealed.is_some() {
            return Some(CursorCause::LineSealed);
        }
        if !self.shadow_received_compatible {
            return Some(CursorCause::FlushReceivedIncompatible);
        }
        if !self.shadow_base_matches_presentation() {
            return Some(CursorCause::FlushBaseMismatch);
        }
        None
    }

    fn presentation_seed_has_received_base(&self, row: u16) -> bool {
        (!self.presentation_full_pending
            || self.presentation_revision == self.authoritative_revision)
            && self
                .presentation_dirty_set
                .get(usize::from(row))
                .copied()
                .unwrap_or(2)
                != 2
            && self.authoritative_cursor() == self.presentation_cursor()
    }

    fn refresh_shadow_received_compatibility(&mut self) {
        self.shadow_received_split = false;
        let Some(line) = self.shadow_line.as_ref() else {
            self.shadow_received_compatible = true;
            return;
        };
        let cursor = self.authoritative_cursor();
        let matches = |state: &ShadowState| {
            // Cursor equality is a cheap rejection before reading a row; it
            // also prevents treating an unmatched transformed echo as a shorter
            // valid prefix whose remaining cells belong to an autosuggestion.
            cursor
                == Some((
                    line.row,
                    line.start_col
                        .saturating_add(clamp_usize_to_u16(state.cursor)),
                ))
                && self.shadow_state_matches_authority(line.row, line.start_col, state, false)
        };
        if matches(&line.base) {
            self.shadow_received_compatible = true;
            return;
        }
        let mut replay = std::mem::take(&mut self.shadow_replay_scratch);
        replay.clone_from(&line.base);
        let mut compatible = false;
        for op in line.ops.iter().copied() {
            if !apply_shadow_op(&mut replay, op) {
                break;
            }
            if cursor
                == Some((
                    line.row,
                    line.start_col
                        .saturating_add(clamp_usize_to_u16(replay.cursor)),
                ))
                && self.shadow_state_matches_authority(line.row, line.start_col, &replay, false)
            {
                compatible = true;
                break;
            }
        }
        if !compatible {
            // The coupled-prefix check above stays the fast path. Only a torn
            // receipt searches independent row/header evidence. Check the whole
            // affected span here: a shorter typed prefix must not hide a
            // transformed pending character as an apparent autosuggestion.
            replay.clone_from(&line.base);
            let extent = line.base.extent.max(line.projected.extent);
            let mut cells_known =
                self.shadow_state_matches_affected_cells(line.row, line.start_col, &replay, extent);
            let mut cursor_known = cursor
                == Some((
                    line.row,
                    line.start_col
                        .saturating_add(clamp_usize_to_u16(replay.cursor)),
                ));
            for op in line.ops.iter().copied() {
                if !apply_shadow_op(&mut replay, op) {
                    break;
                }
                cursor_known |= cursor
                    == Some((
                        line.row,
                        line.start_col
                            .saturating_add(clamp_usize_to_u16(replay.cursor)),
                    ));
                if !cells_known {
                    cells_known = self.shadow_state_matches_affected_cells(
                        line.row,
                        line.start_col,
                        &replay,
                        extent,
                    );
                }
                if cells_known && cursor_known {
                    break;
                }
            }
            self.shadow_received_split = cells_known && cursor_known;
        }
        self.shadow_replay_scratch = replay;
        self.shadow_received_compatible = compatible || self.shadow_received_split;
    }

    fn shadow_state_matches_affected_cells(
        &self,
        row: u16,
        start_col: u16,
        state: &ShadowState,
        extent: usize,
    ) -> bool {
        let grid = self.term.grid();
        let start = usize::from(start_col);
        usize::from(row) < grid.screen_lines()
            && start.saturating_add(extent) <= grid.columns()
            && (0..extent).all(|offset| {
                let cell = &grid[Point::new(Line(i32::from(row)), Column(start + offset))];
                cell_is_predictable_width_one(cell)
                    && authoritative_cell_codepoint(cell) == shadow_state_codepoint(state, offset)
            })
    }

}

/// Native only: the dataplane's cursor lab reads it; no browser build exports it.
#[cfg(not(target_arch = "wasm32"))]
impl Terminal {
    /// One line describing the model against both grids, for the cursor lab's
    /// refusal report.
    pub fn shadow_debug(&self) -> String {
        let cells = |state: &ShadowState| {
            state
                .cells
                .iter()
                .map(|cell| char::from_u32(cell.codepoint).unwrap_or('?'))
                .collect::<String>()
        };
        let Some(line) = self.shadow_line.as_ref() else {
            return "no shadow line".to_string();
        };
        let row = usize::from(line.row);
        let grid_row = |grid: &Grid<Cell>| {
            (usize::from(line.start_col)..grid.columns().min(usize::from(line.start_col) + 40))
                .map(|col| {
                    let c = grid[Point::new(Line(row as i32), Column(col))].c;
                    if c == '\0' { ' ' } else { c }
                })
                .collect::<String>()
                .trim_end()
                .to_string()
        };
        format!(
            "row={} start_col={} base(cursor={} extent={} cells={:?}) projected(cursor={} cells={:?}) ops={} compatible={} visible={} sealed={:?} presentation_cursor={:?} authoritative_cursor={:?} presented={:?} authority={:?}",
            line.row,
            line.start_col,
            line.base.cursor,
            line.base.extent,
            cells(&line.base),
            line.projected.cursor,
            cells(&line.projected),
            line.ops.len(),
            self.shadow_received_compatible,
            line.visible,
            line.sealed,
            self.presentation_cursor(),
            self.authoritative_cursor(),
            grid_row(&self.presentation_grid),
            grid_row(self.term.grid()),
        )
    }
}

#[wasm_bindgen]
impl Terminal {
    fn shadow_base_matches_presentation(&self) -> bool {
        let Some(line) = self.shadow_line.as_ref() else {
            return false;
        };
        // A bounded presentation hold may release a torn but individually
        // proven pair of prefixes. The unchanged operation log still projects
        // the exact local line over it. Keep the certificate with that committed
        // grid while newer receipts wait; a commit or model flush replaces it.
        if self.shadow_presentation_split {
            return true;
        }
        self.shadow_state_matches_grid(
            &self.presentation_grid,
            self.presentation_cursor(),
            line.row,
            line.start_col,
            &line.base,
            true,
        )
    }

    fn shadow_state_matches_authority(
        &self,
        row: u16,
        start_col: u16,
        state: &ShadowState,
        check_cursor: bool,
    ) -> bool {
        self.shadow_state_matches_grid(
            self.term.grid(),
            self.authoritative_cursor(),
            row,
            start_col,
            state,
            check_cursor,
        )
    }

    fn shadow_state_matches_grid(
        &self,
        grid: &Grid<Cell>,
        cursor: Option<(u16, u16)>,
        row: u16,
        start_col: u16,
        state: &ShadowState,
        check_cursor: bool,
    ) -> bool {
        let row_index = usize::from(row);
        let start = usize::from(start_col);
        if row_index >= grid.screen_lines()
            || start.saturating_add(state.extent) > grid.columns()
            || state.cursor > state.cells.len()
        {
            return false;
        }
        let line = Line(row_index as i32);
        // Only the characters the model asserts, which is `cells` — never the
        // columns past them that an erase vacated.
        //
        // Those columns belong to the shell. The model paints a blank in them
        // so an erase feels immediate, but it is not predicting what ends up
        // there: a shell drawing an autosuggestion refills the vacated column
        // in the very frame that echoes the erase, and requiring a blank there
        // made that echo a contradiction the model could never confirm. One
        // Backspace then ended speculative echo for the rest of the line on
        // every shell with autosuggestions. What proves the erase happened is
        // the typed prefix below and the cursor, both of which are still
        // checked exactly; and a confirmed erase collapses its vacated column
        // out of the model entirely, so nothing goes on being painted over it.
        for offset in 0..state.cells.len() {
            let cell = &grid[Point::new(line, Column(start + offset))];
            if !cell_is_predictable_width_one(cell) {
                return false;
            }
            let expected = state
                .cells
                .get(offset)
                .map(|cell| cell.codepoint)
                .unwrap_or(u32::from(' '));
            if authoritative_cell_codepoint(cell) != expected {
                return false;
            }
        }
        if !check_cursor {
            return true;
        }
        cursor
            == Some((
                row,
                start_col.saturating_add(clamp_usize_to_u16(state.cursor)),
            ))
    }

    fn sync_predictions_from_shadow(&mut self) {
        #[cfg(test)]
        {
            self.shadow_sync_count = self.shadow_sync_count.saturating_add(1);
        }
        self.predictions.clear();
        let Some(line) = self.shadow_line.as_ref() else {
            return;
        };
        let row = usize::from(line.row);
        let start = usize::from(line.start_col);
        let state = &line.projected;
        let fallback_meta = line.ops.last().map(|op| op.meta);
        let grid = &self.presentation_grid;
        let cols = grid.columns();
        let rows = grid.screen_lines();
        if row >= rows || start.saturating_add(state.extent) > cols {
            return;
        }
        self.predictions.reserve(state.extent);
        for offset in 0..state.extent {
            let col = start + offset;
            let authoritative = &grid[Point::new(Line(row as i32), Column(col))];
            let original_codepoint = authoritative_cell_codepoint(authoritative);
            let projected = state.cells.get(offset);
            let codepoint = projected
                .map(|cell| cell.codepoint)
                .unwrap_or(u32::from(' '));
            if codepoint == original_codepoint {
                continue;
            }
            let meta = projected
                .map(|cell| cell.meta)
                .or_else(|| state.clear_meta.get(offset).copied().flatten())
                .or(fallback_meta);
            let Some(meta) = meta else {
                continue;
            };
            self.predictions.push(Prediction {
                row: line.row,
                col: clamp_usize_to_u16(col),
                input_seq: meta.input_seq,
                codepoint,
                original_codepoint,
                epoch: meta.epoch,
                kind: if codepoint == u32::from(' ') {
                    PredKind::ClearBack
                } else {
                    PredKind::Char
                },
                fg: projected
                    .map(|cell| cell.fg)
                    .unwrap_or_else(|| prediction_fg_at(grid, row, col)),
            });
        }
    }

    /// Whether the eligible/predicted base cursor follows the speculative model.
    ///
    /// Two conditions, and both are properties of the newest op rather than of
    /// the moment: it was admitted as displayable, and its epoch has been
    /// confirmed. `authority_pending` is deliberately absent — it means "not
    /// confirmable yet", and the input watermark it is set from advances at PTY
    /// *write* completion, strictly before any echo could exist. Retracting the
    /// cursor on it moved the cursor backwards a column on a frame that
    /// contradicted nothing, then forwards again when the echo landed.
    fn shadow_cursor_is_visible(&self) -> bool {
        let Some(line) = self.shadow_line.as_ref() else {
            return false;
        };
        line.visible
            && line
                .ops
                .last()
                .is_some_and(|op| op.meta.epoch <= self.confirmed_epoch)
    }

    fn shadow_requires_row_projection(&self) -> bool {
        self.shadow_cursor_is_visible()
            && self.predictions.iter().any(|prediction| {
                prediction.kind == PredKind::ClearBack
                    || prediction.original_codepoint != u32::from(' ')
            })
    }

    fn clear_damaged_rows(&mut self) {
        for row in self.damaged_rows.drain(..) {
            if let Some(listed) = self.damaged_row_set.get_mut(usize::from(row)) {
                *listed = false;
            }
        }
    }

    fn note_damaged_row(&mut self, row: u16) {
        if let Some(listed) = self.damaged_row_set.get_mut(usize::from(row))
            && !*listed
        {
            *listed = true;
            self.damaged_rows.push(row);
        }
    }

    fn mark_shadow_visual_change(&mut self, was_visible: bool) {
        let now_visible = self.has_visible_predictions_internal();
        if (self.shadow_row_projected || self.shadow_requires_row_projection())
            && let Some(row) = self.shadow_line.as_ref().map(|line| line.row)
        {
            self.note_damaged_row(row);
        }
        if was_visible || now_visible {
            self.prediction_render_dirty = true;
        }
    }

    fn record_prediction_clear_effect(&mut self, input_seq: u32, prediction: Prediction) {
        if self.pending_prediction_clear_effects_truncated {
            return;
        }
        let effect = PredictionClearEffect {
            input_seq,
            cleared_input_seq: prediction.input_seq,
            row: prediction.row,
            col: prediction.col,
            original_codepoint: prediction.original_codepoint,
        };
        if let Some(existing) = self
            .pending_prediction_clear_effects
            .iter_mut()
            .find(|existing| existing.row == effect.row && existing.col == effect.col)
        {
            *existing = effect;
            return;
        }
        if self.pending_prediction_clear_effects.len() >= MAX_VISIBLE_PREDICTION_EFFECTS {
            self.pending_prediction_clear_effects.clear();
            self.pending_prediction_clear_effects_truncated = true;
            return;
        }
        self.pending_prediction_clear_effects.push(effect);
    }

    fn reset_predicted_cursor_to_real(&mut self) {
        let Some(viewport_point) = point_to_viewport(0, self.presentation_grid.cursor.point) else {
            self.predicted_cursor = (0, 0);
            return;
        };
        self.predicted_cursor = (
            clamp_usize_to_u16(viewport_point.line),
            clamp_usize_to_u16(viewport_point.column.0),
        );
    }

    fn become_tentative(&mut self) {
        self.prediction_epoch = self.prediction_epoch.wrapping_add(1).max(1);
    }

    fn prediction_is_visible(&self, prediction: &Prediction) -> bool {
        self.shadow_cursor_is_visible() && prediction_visible_with(prediction, self.confirmed_epoch)
    }

    fn has_visible_predictions_internal(&self) -> bool {
        self.shadow_cursor_is_visible()
            && (self
                .predictions
                .iter()
                .any(|prediction| self.prediction_is_visible(prediction))
                || self
                    .shadow_line
                    .as_ref()
                    .is_some_and(|line| !line.ops.is_empty()))
    }

    fn apply_newer_display_header(
        &mut self,
        snapshot: bool,
        seq: u32,
        cursor_col: u16,
        cursor_row: u16,
        cursor_shape: u8,
        cursor_visible: u8,
        mode_flags: u16,
        scroll_serial: u32,
    ) -> (bool, bool) {
        if !(display_sequence_is_newer(seq, self.display_header_version)
            || snapshot && seq == 0 && self.display_header_version == 0)
        {
            return (false, false);
        }
        let header = PendingDisplayHeader {
            seq,
            cursor_col,
            cursor_row,
            cursor_shape,
            cursor_visible,
            mode_flags,
            scroll_serial,
        };
        let visually_changed = self.last_applied_display_header.is_none_or(|previous| {
            previous.cursor_col != header.cursor_col
                || previous.cursor_row != header.cursor_row
                || previous.cursor_shape != header.cursor_shape
                || previous.cursor_visible != header.cursor_visible
                || previous.mode_flags != header.mode_flags
        });
        if self.cursor_motion_enabled
            && let Some(previous) = self.last_applied_display_header
            && (previous.cursor_shape != header.cursor_shape
                || previous.cursor_visible != header.cursor_visible)
        {
            self.journal_header_shape(&previous, &header);
        }
        self.apply_display_header(header);
        (true, visually_changed)
    }

    fn apply_display_header(&mut self, header: PendingDisplayHeader) {
        let rows = self.term.grid().screen_lines();
        let cols = self.term.grid().columns();
        // A header applied while an input-routing word is held may have been
        // captured before it; `release_input_routing` hands the routing bits to
        // the first one that was not.
        let routing = if self.input_routing_held {
            self.display_mode
        } else {
            u32::from(header.mode_flags)
        };
        self.display_mode = (u32::from(header.mode_flags) & !DISPLAY_MODE_INPUT_ROUTING)
            | (routing & DISPLAY_MODE_INPUT_ROUTING);
        self.term.set_cursor_direct(
            i32::from(
                header
                    .cursor_row
                    .min(clamp_usize_to_u16(rows.saturating_sub(1))),
            ),
            usize::from(
                header
                    .cursor_col
                    .min(clamp_usize_to_u16(cols.saturating_sub(1))),
            ),
        );
        self.term.set_cursor_shape_direct(decode_cursor_shape(
            header.cursor_shape,
            header.cursor_visible,
        ));
        self.authoritative_cursor_visible =
            header.cursor_visible != 0 && header.cursor_shape != CURSOR_SHAPE_HIDDEN;
        self.cursor_authority_cause = CursorCause::AuthorityHeader;
        self.display_header_version = header.seq;
        self.last_applied_display_header = Some(header);
        if self.prediction_mode_is_unsafe()
            && let Some(line) = self.shadow_line.as_ref()
            && line.sealed.is_none()
        {
            // A withdrawn grant this browser did not cause — echo turned off
            // under a program another peer started, the cursor hidden by a
            // full-screen application — takes painted glyphs off the screen
            // now. One its own unmodelled input caused has already sealed the
            // line, and those glyphs wait for the echo the shell owes them.
            self.predict_flush_because(CursorCause::FlushModeRevoked);
        }
    }
}

// ── Geometry helpers ─────────────────────────────────────────────────────────

/// Write one row's cells through the per-cell display-ordering gate.
///
/// Every accepted cell advances authority even when its contents are identical.
/// Returns whether any cell applied and the smallest span whose canonical
/// contents changed. Only that span contributes renderer damage.
///
/// Free function rather than a method because callers hold a `&mut Grid` from
/// `self.term` while mutating sibling fields.
fn apply_row_cells(
    grid: &mut Grid<Cell>,
    display_cell_versions: &mut [u32],
    authoritative_cell_revisions: &mut [u32],
    display_cell_links: &mut [u32],
    row_link_cells: &mut u16,
    cells: &[CellRepr],
    row_index: usize,
    left: usize,
    cols: usize,
    seq: u32,
    snapshot: bool,
    authoritative_revision: u32,
) -> (bool, Option<(usize, usize)>, bool) {
    let mut applied = false;
    let mut links_changed = false;
    let mut applied_left = cols;
    let mut applied_right = 0usize;
    for (cell_offset, cell) in cells.iter().copied().enumerate() {
        let col = left + cell_offset;
        let cell_version_index = row_index * cols + col;
        let can_apply_cell =
            display_sequence_is_newer(seq, display_cell_versions[cell_version_index])
                || (snapshot && seq == 0 && display_cell_versions[cell_version_index] == 0);
        if can_apply_cell {
            let visually_changed = write_cell(
                &mut grid[Point::new(Line(row_index as i32), Column(col))],
                cell,
            );
            display_cell_versions[cell_version_index] = seq;
            authoritative_cell_revisions[cell_version_index] = authoritative_revision;
            let previous_link = display_cell_links[cell_version_index];
            links_changed |= previous_link != cell.link;
            *row_link_cells =
                *row_link_cells + u16::from(cell.link != 0) - u16::from(previous_link != 0);
            display_cell_links[cell_version_index] = cell.link;
            applied = true;
            if visually_changed {
                applied_left = applied_left.min(col);
                applied_right = applied_right.max(col);
            }
        }
    }
    (
        applied,
        (applied_left <= applied_right).then_some((applied_left, applied_right)),
        links_changed,
    )
}

/// Resolve a colour, reusing the previous answer when it repeats.
///
/// A row is overwhelmingly one or two colours, and `resolve_color` is a palette
/// lookup per call. The daemon's row reader has carried this memo for a while;
/// the browser's had not.
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

/// Digest one whole grid row without ever materializing its `CellRepr`s.
///
/// This is the hash-only half of the pair below, and it exists because nothing
/// on the browser retains a row's cells purely to hash them: `compute_row_hash`
/// used to build a whole `Vec<CellRepr>` solely to hand it to `row_hash`, which
/// then re-read those 16-byte structs to pack an 11-byte-per-cell digest. Both
/// the intermediate buffer and the second read are avoidable.
///
/// The row is taken once rather than indexed per cell — `grid[Point::new(..)]`
/// resolves the line on every column — and `digest` is retained by the caller so
/// a steady drain allocates nothing. `links` is the row's per-column link ids,
/// or empty for a row that holds none.
#[inline]
fn hash_row(
    grid: &Grid<Cell>,
    line: Line,
    cols: usize,
    links: &[u32],
    fragments: Option<u64>,
    digest: &mut Vec<u8>,
) -> u64 {
    let digest_len = cols.saturating_mul(CELL_DIGEST_BYTES);
    if digest.len() != digest_len {
        digest.resize(digest_len, 0);
    }
    let row = &grid[line];
    let mut fg_cache = None;
    let mut bg_cache = None;
    for (packed, cell) in digest
        .chunks_exact_mut(CELL_DIGEST_BYTES)
        .zip(row)
        .take(cols)
    {
        let fg = resolve_cached_color(cell.fg, &mut fg_cache);
        let bg = resolve_cached_color(cell.bg, &mut bg_cache);
        pack_cell_digest(&CellRepr::from_alacritty_with_colors(cell, fg, bg), packed);
    }
    stamp_row_wrap_digest(row, digest);
    // Empty unless the row holds a link: the caller keeps the per-row count.
    if !links.is_empty() {
        append_link_digest(digest, links.iter().copied());
    }
    merkur_codec::append_graphics_digest(digest, fragments);
    row_hash_packed(digest)
}

/// OR the row-scoped wrap bit into the final cell's already-packed flags byte.
///
/// `from_alacritty_with_colors` leaves the bit clear — a conversion that sees
/// one cell cannot know whether it is the last — so this is exact, and it is
/// what lets hashing pack as it goes instead of walking the row twice.
#[inline]
fn stamp_row_wrap_digest(row: &alacritty_terminal::grid::Row<Cell>, digest: &mut [u8]) {
    if let (Some(cell), Some(flags)) = (row.last(), digest.last_mut())
        && cell_wraps(cell)
    {
        *flags |= CELL_DIGEST_WRAPPED_BIT;
    }
}

/// Canonicalize every admitted write, but report only semantic cell damage.
/// Named/indexed and explicit colors can differ structurally while resolving
/// identically. Extra alacritty state is conservatively dirty when stripped.
fn write_cell(cell: &mut Cell, repr: CellRepr) -> bool {
    let mut next = Cell {
        c: char::from_u32(repr.codepoint).unwrap_or(' '),
        ..Cell::default()
    };
    // An implicit default is left as the `Color::Named` default `Cell::default()`
    // already installed, rather than restated as an equal `Color::Spec`. Both
    // resolve to the same RGB and render identically, but alacritty's
    // `GridCell::is_empty` compares the *discriminant*: a row of Spec-colored
    // blanks is never "clear", and reflow drops cleared rows to decide where
    // content lands. Writing Spec here made every replicated row permanently
    // non-empty, which is invisible until the grid is asked to reflow.
    if repr.fg != DEFAULT_FOREGROUND {
        next.fg = Color::Spec(Rgb {
            r: repr.fg[0],
            g: repr.fg[1],
            b: repr.fg[2],
        });
    }
    // Explicit paint equal to the default RGB must survive reflow, hashing and
    // image layering. Only the implicit default may become a Named background.
    if repr.has_explicit_background() {
        next.bg = Color::Spec(Rgb {
            r: repr.bg[0],
            g: repr.bg[1],
            b: repr.bg[2],
        });
    }
    let mut flags = Flags::empty();
    if repr.wrapped() {
        flags.insert(Flags::WRAPLINE);
    }
    if repr.wide() {
        flags.insert(Flags::WIDE_CHAR);
    }
    if repr.bold() {
        flags.insert(Flags::BOLD);
    }
    if repr.italic() {
        flags.insert(Flags::ITALIC);
    }
    if repr.underline() {
        flags.insert(Flags::UNDERLINE);
    }
    if repr.inverse() {
        flags.insert(Flags::INVERSE);
    }
    next.flags = flags;
    let visually_changed = cell.c != next.c
        || cell.flags != next.flags
        || (cell.fg != next.fg && resolve_color(cell.fg) != repr.fg)
        || (cell.bg != next.bg
            && (cell.bg == Color::Named(NamedColor::Background)
                || next.bg == Color::Named(NamedColor::Background)
                || resolve_color(cell.bg) != repr.bg))
        || cell.extra.is_some();
    *cell = next;
    visually_changed
}

#[cfg(test)]
mod tests;

fn build_row_geometry_into(
    grid: &Grid<Cell>,
    atlas: &mut atlas::GlyphAtlas,
    row_idx: usize,
    cols: usize,
    cw: f32,
    ch: f32,
    baseline: f32,
    aw: f32,
    ah: f32,
    theme: RenderTheme,
    shadow: Option<&ShadowRenderProjection<'_>>,
    out: &mut RowGeometry,
) {
    out.bg.clear();
    out.glyph.clear();
    out.deco.clear();
    let line_idx = match i32::try_from(row_idx) {
        Ok(value) => Line(value),
        Err(_) => return,
    };
    let y = row_idx as f32 * ch;
    let mut span_start = 0usize;
    let mut span_color: Option<[f32; 3]> = None;
    for col in 0..=cols {
        let bg = if col < cols {
            let cell = &grid[Point::new(line_idx, Column(col))];
            if cell.flags.contains(Flags::INVERSE)
                && cell.c != merkur_graphics::placeholder::PLACEHOLDER
            {
                Some(rgb_to_f32(resolve_theme_color(theme, cell.fg)))
            } else if cell.bg != Color::Named(NamedColor::Background) {
                Some(rgb_to_f32(resolve_theme_color(theme, cell.bg)))
            } else {
                None
            }
        } else {
            None
        };
        if bg != span_color {
            if let Some(sc) = span_color {
                let x = span_start as f32 * cw;
                let w = (col - span_start) as f32 * cw;
                push7(&mut out.bg, [x, y, w, ch, sc[0], sc[1], sc[2]]);
            }
            span_start = col;
            span_color = bg;
        }
    }

    let mut col = 0usize;
    while col < cols {
        let cell = &grid[Point::new(line_idx, Column(col))];
        let shadow_cell = shadow.and_then(|projection| {
            if projection.row != row_idx
                || col < projection.start_col
                || col >= projection.start_col.saturating_add(projection.extent)
            {
                return None;
            }
            let offset = col - projection.start_col;
            let projected = projection.cells.get(offset);
            Some((
                projected
                    .map(|cell| cell.codepoint)
                    .unwrap_or(u32::from(' ')),
                projected,
            ))
        });
        let authoritative_codepoint = authoritative_cell_codepoint(cell);
        let shadow_override =
            shadow_cell.filter(|(codepoint, _)| *codepoint != authoritative_codepoint);
        let flags = if shadow_override.is_some() {
            Flags::empty()
        } else {
            cell.flags
        };
        if flags.contains(Flags::WIDE_CHAR_SPACER) {
            col += 1;
            continue;
        }
        let cp = shadow_override
            .map(|(codepoint, _)| codepoint)
            .unwrap_or(authoritative_codepoint);
        // The canonical graphics row already describes this cell's image.
        // Foreground/underline colors encode IDs; text styling is reserved.
        if cp == u32::from(merkur_graphics::placeholder::PLACEHOLDER) {
            col += 1;
            continue;
        }
        let is_wide = flags.contains(Flags::WIDE_CHAR);
        let span = if is_wide { 2usize } else { 1usize };
        let cell_x = col as f32 * cw;
        let cell_pixel_w = span as f32 * cw;

        if cp > 31 && cp != 127 {
            let style: u8 = if let Some((_, Some(shadow_cell))) = shadow_override {
                shadow_cell.font_style
            } else if shadow_override.is_some() {
                PREDICTION_STYLE_NORMAL
            } else {
                font_style_from_flags(flags)
            };
            let key = atlas::GlyphKey {
                codepoint: cp,
                style,
            };
            let (fg_raw, dim) = if let Some((_, Some(shadow_cell))) = shadow_override {
                (remap_rgb(theme, shadow_cell.fg), false)
            } else if flags.contains(Flags::INVERSE) {
                (
                    resolve_theme_color(theme, cell.bg),
                    flags.contains(Flags::DIM),
                )
            } else {
                (
                    resolve_theme_color(theme, cell.fg),
                    flags.contains(Flags::DIM),
                )
            };
            let [r, g, b] = rgb_to_f32(fg_raw);
            let a = if shadow_override.is_some() {
                PREDICTION_ALPHA
            } else if dim {
                0.72f32
            } else {
                1.0f32
            };
            if let Some(glyph) = builtin_cell_glyph(cp) {
                push_builtin_cell_glyph(&mut out.deco, glyph, cell_x, y, cell_pixel_w, ch, r, g, b);
            } else if let Some(entry) = atlas.get_or_rasterize(key) {
                let gw = entry.width as f32;
                let gh = entry.height as f32;
                let ox = entry.offset_x as f32;
                let oy = baseline + entry.offset_y as f32;
                let u0 = entry.atlas_x as f32 / aw;
                let v0 = entry.atlas_y as f32 / ah;
                let u1 = (entry.atlas_x as f32 + gw) / aw;
                let v1 = (entry.atlas_y as f32 + gh) / ah;
                push14(
                    &mut out.glyph,
                    [cell_x, y, ox, oy, gw, gh, u0, v0, u1, v1, r, g, b, a],
                );
            }
        }

        let shadow_underline = shadow_override
            .and_then(|(_, shadow_cell)| shadow_cell)
            .is_some_and(|shadow_cell| shadow_cell.underline);
        if shadow_underline || flags.contains(Flags::UNDERLINE) || flags.contains(Flags::STRIKEOUT)
        {
            let decoration_color = if let Some((_, Some(shadow_cell))) = shadow_override {
                remap_rgb(theme, shadow_cell.fg)
            } else if flags.contains(Flags::INVERSE) {
                resolve_theme_color(theme, cell.bg)
            } else {
                resolve_theme_color(theme, cell.fg)
            };
            let [r, g, b] = rgb_to_f32(decoration_color);
            if shadow_underline || flags.contains(Flags::UNDERLINE) {
                let line_y = y + ch - 1.0;
                push7(&mut out.deco, [cell_x, line_y, cell_pixel_w, 1.0, r, g, b]);
            }
            if flags.contains(Flags::STRIKEOUT) {
                let line_y = y + ch * 0.5;
                push7(&mut out.deco, [cell_x, line_y, cell_pixel_w, 1.0, r, g, b]);
            }
        }
        col += span;
    }
}

/// Append the IME preedit run (bg highlight, glyphs, 2px underline) anchored
/// at the cursor cell. If the run would overflow the row, it is shifted left
/// (and, if longer than the row, trimmed from the front) so the most recently
/// composed tail stays visible. Returns true if any glyph was queued for
/// JS-side rasterization (caller keeps the overlay dirty for the rebuild).
fn append_preedit_into(
    atlas: &mut atlas::GlyphAtlas,
    bg_buf: &mut Vec<f32>,
    glyph_buf: &mut Vec<f32>,
    deco_buf: &mut Vec<f32>,
    chars: &[char],
    cursor_col: usize,
    cursor_row: usize,
    cols: usize,
    rows: usize,
    cw: f32,
    ch: f32,
    baseline: f32,
    aw: f32,
    ah: f32,
    theme: RenderTheme,
) -> bool {
    if cursor_row >= rows || cols == 0 {
        return false;
    }

    // Cell widths (zero-width combining marks render over the previous cell;
    // approximate by skipping them — the committed text renders correctly).
    let widths: Vec<usize> = chars
        .iter()
        .map(|c| UnicodeWidthChar::width(*c).unwrap_or(0))
        .collect();
    let mut total: usize = widths.iter().sum();
    if total == 0 {
        return false;
    }

    // Trim from the front until the run fits the row.
    let mut first = 0usize;
    while total > cols && first < chars.len() {
        total -= widths[first];
        first += 1;
    }
    // Every char trimmed (e.g. a wide char in a one-column grid): nothing to
    // draw — bail before pushing zero-width quads.
    if total == 0 {
        return false;
    }
    let start_col = if cursor_col + total <= cols {
        cursor_col
    } else {
        cols - total
    };

    let y = cursor_row as f32 * ch;
    let x0 = start_col as f32 * cw;
    let run_w = total as f32 * cw;
    let fg = rgb_to_f32(theme.foreground);
    let bg = mix_rgb_f32(theme.background, theme.foreground, 0.18);

    // Background highlight (single quad) + underline (2px, distinguishes the
    // composing run from regular underlined grid text).
    push7(bg_buf, [x0, y, run_w, ch, bg[0], bg[1], bg[2]]);
    push7(
        deco_buf,
        [x0, y + ch - 2.0, run_w, 2.0, fg[0], fg[1], fg[2]],
    );

    let mut missing = false;
    let mut col = start_col;
    for (i, c) in chars.iter().enumerate().skip(first) {
        let width = widths[i];
        if width == 0 {
            continue;
        }
        let cp = *c as u32;
        if cp > 31 && cp != 127 {
            let key = atlas::GlyphKey {
                codepoint: cp,
                style: PREDICTION_STYLE_NORMAL,
            };
            if let Some(entry) = atlas.get_or_rasterize(key) {
                let gw = entry.width as f32;
                let gh = entry.height as f32;
                let ox = entry.offset_x as f32;
                let oy = baseline + entry.offset_y as f32;
                let u0 = entry.atlas_x as f32 / aw;
                let v0 = entry.atlas_y as f32 / ah;
                let u1 = (entry.atlas_x as f32 + gw) / aw;
                let v1 = (entry.atlas_y as f32 + gh) / ah;
                push14(
                    glyph_buf,
                    [
                        col as f32 * cw,
                        y,
                        ox,
                        oy,
                        gw,
                        gh,
                        u0,
                        v0,
                        u1,
                        v1,
                        fg[0],
                        fg[1],
                        fg[2],
                        1.0,
                    ],
                );
            } else if atlas.is_pending(key) {
                // Only a glyph actually queued for the Canvas 2D pass justifies
                // staying dirty. A blank (U+0020 reaches here) or an already
                // declined glyph never resolves, so treating those as missing
                // pinned `preedit_dirty` and defeated the damage early-return,
                // re-running the whole pass on every render for the life of the
                // composition.
                missing = true;
            }
        }
        col += width;
    }
    missing
}

fn mix_rgb_f32(base: [u8; 3], toward: [u8; 3], amount: f32) -> [f32; 3] {
    let base = rgb_to_f32(base);
    let toward = rgb_to_f32(toward);
    [
        base[0] + (toward[0] - base[0]) * amount,
        base[1] + (toward[1] - base[1]) * amount,
        base[2] + (toward[2] - base[2]) * amount,
    ]
}

fn push_builtin_cell_glyph(
    buf: &mut Vec<f32>,
    glyph: BuiltinCellGlyph,
    cell_x: f32,
    cell_y: f32,
    cell_w: f32,
    cell_h: f32,
    r: f32,
    g: f32,
    b: f32,
) {
    for rect in glyph.rects() {
        push7(
            buf,
            [
                cell_x + rect.x * cell_w,
                cell_y + rect.y * cell_h,
                rect.w * cell_w,
                rect.h * cell_h,
                r,
                g,
                b,
            ],
        );
    }
}

fn rebuild_bg_buffer(out: &mut Vec<f32>, rows: &mut [RowGeometry]) {
    out.clear();
    out.reserve(rows.iter().map(|row| row.bg.len()).sum());
    for row in rows {
        row.bg_start = out.len();
        out.extend_from_slice(&row.bg);
    }
}

fn rebuild_glyph_buffer(out: &mut Vec<f32>, rows: &mut [RowGeometry]) {
    out.clear();
    out.reserve(rows.iter().map(|row| row.glyph.len()).sum());
    for row in rows {
        row.glyph_start = out.len();
        out.extend_from_slice(&row.glyph);
    }
}

fn rebuild_deco_buffer(out: &mut Vec<f32>, rows: &mut [RowGeometry]) {
    out.clear();
    out.reserve(rows.iter().map(|row| row.deco.len()).sum());
    for row in rows {
        row.deco_start = out.len();
        out.extend_from_slice(&row.deco);
    }
}

fn push_prediction_glyph_into(
    atlas: &mut atlas::GlyphAtlas,
    glyph_buf: &mut Vec<f32>,
    prediction: &Prediction,
    cols: usize,
    rows: usize,
    cw: f32,
    ch: f32,
    baseline: f32,
    aw: f32,
    ah: f32,
    theme: RenderTheme,
) {
    if prediction.kind != PredKind::Char {
        return;
    }
    let row = usize::from(prediction.row);
    let col = usize::from(prediction.col);
    if row >= rows || col >= cols {
        return;
    }
    let key = atlas::GlyphKey {
        codepoint: prediction.codepoint,
        style: PREDICTION_STYLE_NORMAL,
    };
    let Some(entry) = atlas.get_or_rasterize(key) else {
        return;
    };
    let gw = entry.width as f32;
    let gh = entry.height as f32;
    let ox = entry.offset_x as f32;
    let oy = baseline + entry.offset_y as f32;
    let u0 = entry.atlas_x as f32 / aw;
    let v0 = entry.atlas_y as f32 / ah;
    let u1 = (entry.atlas_x as f32 + gw) / aw;
    let v1 = (entry.atlas_y as f32 + gh) / ah;
    let [r, g, b] = rgb_to_f32(remap_rgb(theme, prediction.fg));
    push14(
        glyph_buf,
        [
            col as f32 * cw,
            row as f32 * ch,
            ox,
            oy,
            gw,
            gh,
            u0,
            v0,
            u1,
            v1,
            r,
            g,
            b,
            PREDICTION_ALPHA,
        ],
    );
}

fn push7(buf: &mut Vec<f32>, v: [f32; 7]) {
    buf.extend_from_slice(&v);
}

fn push8(buf: &mut Vec<f32>, v: [f32; 8]) {
    buf.extend_from_slice(&v);
}

fn push14(buf: &mut Vec<f32>, v: [f32; 14]) {
    buf.extend_from_slice(&v);
}

fn cursor_geometry(x: f32, y: f32, w: f32, h: f32, rgb: [u8; 3], shape_id: f32) -> [f32; 8] {
    let [r, g, b] = rgb_to_f32(rgb);
    [x, y, w, h, r, g, b, shape_id]
}

/// Whether one prediction of an already-admitted line draws a glyph.
///
/// Line-level admission is `shadow_cursor_is_visible`; this is the per-cell
/// half of the same question.
fn prediction_visible_with(prediction: &Prediction, confirmed_epoch: u32) -> bool {
    prediction.kind == PredKind::Char
        // A predicted space advances the speculative cursor model but draws
        // no glyph over the already-blank tail. Treating it as visible caused
        // gate transitions to submit and attribute a no-op prediction frame.
        && prediction.codepoint != u32::from(' ')
        && prediction.epoch <= confirmed_epoch
}

fn shadow_op_touch_range(state: &ShadowState, op: ShadowOp) -> Option<(usize, usize)> {
    match op.kind {
        ShadowOpKind::Insert { index, .. } => {
            let start = usize::from(index);
            Some((start, state.cells.len().saturating_add(1)))
        }
        ShadowOpKind::Backspace { index } | ShadowOpKind::Delete { index } => {
            Some((usize::from(index), state.cells.len()))
        }
        ShadowOpKind::CursorShift { .. } => None,
    }
}

fn shadow_state_codepoint(state: &ShadowState, offset: usize) -> u32 {
    state
        .cells
        .get(offset)
        .map(|cell| cell.codepoint)
        .unwrap_or(u32::from(' '))
}

fn apply_shadow_op(state: &mut ShadowState, op: ShadowOp) -> bool {
    match op.kind {
        ShadowOpKind::Insert { index, cell } => {
            let index = usize::from(index);
            if index != state.cursor || index > state.cells.len() {
                return false;
            }
            state.cells.insert(index, cell);
            for shifted in state.cells.iter_mut().skip(index + 1) {
                shifted.meta = op.meta;
            }
            state.cursor = state.cursor.saturating_add(1);
            state.extent = state.extent.max(state.cells.len());
            state.clear_meta.resize(state.extent, None);
            for clear in state.clear_meta.iter_mut().take(state.cells.len()) {
                *clear = None;
            }
            true
        }
        ShadowOpKind::Backspace { index } => {
            let index = usize::from(index);
            if state.cursor == 0
                || index.saturating_add(1) != state.cursor
                || index >= state.cells.len()
            {
                return false;
            }
            let old_len = state.cells.len();
            state.cells.remove(index);
            for shifted in state.cells.iter_mut().skip(index) {
                shifted.meta = op.meta;
            }
            state.cursor -= 1;
            state.extent = state.extent.max(old_len);
            state.clear_meta.resize(state.extent, None);
            for clear in state.clear_meta.iter_mut().take(state.cells.len()) {
                *clear = None;
            }
            if let Some(clear) = state.clear_meta.get_mut(old_len.saturating_sub(1)) {
                *clear = Some(op.meta);
            }
            true
        }
        ShadowOpKind::Delete { index } => {
            let index = usize::from(index);
            if index != state.cursor || index >= state.cells.len() {
                return false;
            }
            let old_len = state.cells.len();
            state.cells.remove(index);
            for shifted in state.cells.iter_mut().skip(index) {
                shifted.meta = op.meta;
            }
            state.extent = state.extent.max(old_len);
            state.clear_meta.resize(state.extent, None);
            for clear in state.clear_meta.iter_mut().take(state.cells.len()) {
                *clear = None;
            }
            if let Some(clear) = state.clear_meta.get_mut(old_len.saturating_sub(1)) {
                *clear = Some(op.meta);
            }
            true
        }
        ShadowOpKind::CursorShift { delta } => {
            let next = state.cursor as i32 + i32::from(delta);
            if next < 0 {
                return false;
            }
            let Ok(next) = usize::try_from(next) else {
                return false;
            };
            if next > state.cells.len() {
                return false;
            }
            state.cursor = next;
            true
        }
    }
}

fn shadow_cursor(line: &ShadowLine) -> (u16, u16) {
    (
        line.row,
        line.start_col
            .saturating_add(clamp_usize_to_u16(line.projected.cursor)),
    )
}

fn authoritative_cell_codepoint(cell: &Cell) -> u32 {
    if cell.c == '\0' {
        u32::from(' ')
    } else {
        u32::from(cell.c)
    }
}

fn font_style_from_flags(flags: Flags) -> u8 {
    match (flags.contains(Flags::BOLD), flags.contains(Flags::ITALIC)) {
        (true, true) => 3,
        (true, false) => 1,
        (false, true) => 2,
        (false, false) => PREDICTION_STYLE_NORMAL,
    }
}

fn displayed_cell_foreground(cell: &Cell) -> [u8; 3] {
    if cell.flags.contains(Flags::INVERSE) {
        resolve_color(cell.bg)
    } else {
        resolve_color(cell.fg)
    }
}

fn displayed_cell_background(theme: RenderTheme, cell: &Cell) -> [u8; 3] {
    if cell.flags.contains(Flags::INVERSE) {
        resolve_theme_color(theme, cell.fg)
    } else {
        resolve_theme_color(theme, cell.bg)
    }
}

fn rebase_shadow_cell_styles_from_authority(
    grid: &Grid<Cell>,
    row: u16,
    start_col: u16,
    state: &mut ShadowState,
) {
    let row = usize::from(row);
    let start_col = usize::from(start_col);
    if row >= grid.screen_lines() || start_col.saturating_add(state.cells.len()) > grid.columns() {
        return;
    }
    let line = Line(row as i32);
    for (offset, shadow_cell) in state.cells.iter_mut().enumerate() {
        let authoritative = &grid[Point::new(line, Column(start_col + offset))];
        shadow_cell.fg = displayed_cell_foreground(authoritative);
        shadow_cell.font_style = font_style_from_flags(authoritative.flags);
        shadow_cell.underline = authoritative.flags.contains(Flags::UNDERLINE);
    }
}

fn cell_is_predictable_width_one(cell: &Cell) -> bool {
    !cell
        .flags
        .intersects(Flags::WIDE_CHAR | Flags::WIDE_CHAR_SPACER)
        && cell
            .zerowidth()
            .is_none_or(|characters| characters.is_empty())
}

fn row_tail_is_predictable(grid: &Grid<Cell>, row: usize, start_col: usize) -> bool {
    if row >= grid.screen_lines() || start_col >= grid.columns() {
        return false;
    }
    let line = Line(row as i32);
    for col in start_col..grid.columns() {
        let cell = &grid[Point::new(line, Column(col))];
        if !cell_is_predictable_width_one(cell)
            || authoritative_cell_codepoint(cell) != u32::from(' ')
        {
            return false;
        }
    }
    true
}

fn row_tail_has_uniform_background(
    grid: &Grid<Cell>,
    theme: RenderTheme,
    row: usize,
    start_col: usize,
) -> bool {
    if row >= grid.screen_lines() || start_col >= grid.columns() {
        return false;
    }
    let line = Line(row as i32);
    let expected = displayed_cell_background(theme, &grid[Point::new(line, Column(start_col))]);
    (start_col + 1..grid.columns()).all(|col| {
        displayed_cell_background(theme, &grid[Point::new(line, Column(col))]) == expected
    })
}

fn prediction_fg_at(grid: &Grid<Cell>, row: usize, col: usize) -> [u8; 3] {
    resolve_color(prediction_color_at(grid, row, col))
}

/// The colour a prediction at `col` is drawn in: that of the nearest glyph at
/// or before it on the row, or of the cell itself.
fn prediction_color_at(grid: &Grid<Cell>, row: usize, col: usize) -> Color {
    let line = Line(row as i32);
    if row >= grid.screen_lines() || col >= grid.columns() {
        return Color::Named(NamedColor::Foreground);
    }
    let visible_fg = |cell: &Cell| {
        if cell.flags.contains(Flags::INVERSE) {
            cell.bg
        } else {
            cell.fg
        }
    };
    for probe_col in (0..=col).rev() {
        let cell = &grid[Point::new(line, Column(probe_col))];
        if !cell.is_empty() && cell.c != ' ' {
            return visible_fg(cell);
        }
    }
    visible_fg(&grid[Point::new(line, Column(col))])
}

fn rgb_to_f32(rgb: [u8; 3]) -> [f32; 3] {
    [
        rgb[0] as f32 / 255.0,
        rgb[1] as f32 / 255.0,
        rgb[2] as f32 / 255.0,
    ]
}

// ── Color resolution ─────────────────────────────────────────────────────────

fn create_dimensions(cols: u16, rows: u16) -> TerminalDimensions {
    TerminalDimensions {
        cols: usize::from(cols),
        rows: usize::from(rows),
    }
}

fn resolve_theme_color(theme: RenderTheme, color: Color) -> [u8; 3] {
    remap_rgb(theme, resolve_color(color))
}

fn remap_rgb(theme: RenderTheme, rgb: [u8; 3]) -> [u8; 3] {
    if rgb == DEFAULT_FOREGROUND {
        return theme.foreground;
    }
    if rgb == DEFAULT_BACKGROUND {
        return theme.background;
    }
    if rgb == DEFAULT_CURSOR {
        return theme.cursor;
    }
    if rgb == DEFAULT_DIM_FOREGROUND {
        return dim_rgb(theme.foreground, theme.background);
    }

    for (index, color) in ANSI_PALETTE.iter().enumerate() {
        if rgb == *color {
            return theme.palette[index];
        }
    }

    for (index, color) in DIM_PALETTE.iter().enumerate() {
        if rgb == *color {
            return dim_rgb(theme.palette[index], theme.background);
        }
    }

    rgb
}

fn parse_render_theme(bytes: &[u8]) -> Option<RenderTheme> {
    if bytes.len() != THEME_BYTES {
        return None;
    }

    let mut palette = [[0u8; 3]; 16];
    for (index, entry) in palette.iter_mut().enumerate() {
        *entry = read_rgb(bytes, THEME_ANSI_OFFSET + index * 3)?;
    }

    Some(RenderTheme {
        foreground: read_rgb(bytes, 0)?,
        background: read_rgb(bytes, 3)?,
        cursor: read_rgb(bytes, 6)?,
        palette,
    })
}

fn read_rgb(bytes: &[u8], offset: usize) -> Option<[u8; 3]> {
    Some([
        *bytes.get(offset)?,
        *bytes.get(offset + 1)?,
        *bytes.get(offset + 2)?,
    ])
}

fn dim_rgb(rgb: [u8; 3], background: [u8; 3]) -> [u8; 3] {
    const NUM: u16 = 2;
    const DEN: u16 = 3;
    [
        mix_channel(rgb[0], background[0], NUM, DEN),
        mix_channel(rgb[1], background[1], NUM, DEN),
        mix_channel(rgb[2], background[2], NUM, DEN),
    ]
}

fn mix_channel(foreground: u8, background: u8, foreground_num: u16, denominator: u16) -> u8 {
    let background_num = denominator.saturating_sub(foreground_num);
    let value = u16::from(foreground) * foreground_num + u16::from(background) * background_num;
    (value / denominator) as u8
}

fn clamp_usize_to_u16(value: usize) -> u16 {
    u16::try_from(value).unwrap_or(u16::MAX)
}

fn widen_dirty_range(range: &mut (u32, u32), start: usize, count: usize) {
    if count == 0 {
        return;
    }
    let start = start as u32;
    let end = start.saturating_add(count as u32);
    if range.1 == 0 {
        *range = (start, count as u32);
        return;
    }
    let existing_end = range.0.saturating_add(range.1);
    let next_start = range.0.min(start);
    let next_end = existing_end.max(end);
    *range = (next_start, next_end.saturating_sub(next_start));
}

fn encode_cursor_shape(shape: CursorShape) -> u8 {
    match shape {
        CursorShape::Hidden => CURSOR_SHAPE_HIDDEN,
        CursorShape::Beam => CURSOR_SHAPE_BEAM,
        CursorShape::Underline => CURSOR_SHAPE_UNDERLINE,
        CursorShape::Block | CursorShape::HollowBlock => CURSOR_SHAPE_BLOCK,
    }
}

fn decode_cursor_shape(shape: u8, visible: u8) -> CursorShape {
    if visible == 0 || shape == CURSOR_SHAPE_HIDDEN {
        return CursorShape::Hidden;
    }
    match shape {
        CURSOR_SHAPE_BEAM => CursorShape::Beam,
        CURSOR_SHAPE_UNDERLINE => CursorShape::Underline,
        _ => CursorShape::Block,
    }
}
