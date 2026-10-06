import { createLogger } from '@merkur/logger';
import loadWasm, {
  ClientViewer,
  init_display_receiver_calibration as initDisplayReceiverCalibration,
  init_regular as initTerminalRegular,
  type Terminal,
  cursor_cause_name as wasmCursorCauseName,
  cursor_motion_record_words as wasmCursorMotionRecordWords,
} from './term-wasm/pkg/term_wasm.js';
import { GEOMETRY_STATE_LENGTH } from './terminal/geometry-render-state';
import { createCursorInfoReader, createRowHashReader } from './terminal/wasm-render-readers';

/**
 * The name of a cursor-motion cause code, from the enum that defines it.
 *
 * Both this and the record stride are read out of WASM rather than restated
 * here: a diagnostic that prints the wrong cause name is worse than one that
 * prints none, and the codes are the whole content of the journal.
 */
export function cursorCauseName(code: number): string {
  return wasmCursorCauseName(code);
}

export function cursorMotionRecordWords(): number {
  return wasmCursorMotionRecordWords();
}

export interface WasmTerminalHandle {
  graphicsFragments(): Uint8Array;
  destroy(): void;
  rowHash(row: number): bigint;
  /**
   * Live per-row grid hashes as dense (lo, hi) `u32` pairs.
   *
   * The vector the daemon's row hashes are compared against, and the body of
   * the resume claim. Refreshed on read, so it never lags the grid.
   */
  rowHashes(): Uint32Array;
  /** Eligible visual cursor: [col, row, shape, visible, safeAppendOnlyPrintable]. */
  cursorInfo(): Uint16Array;
  /** Received authority, never a presentation claim: [col, row, shape, visible]. */
  receivedCursorInfo(): Uint16Array;
  /** Promote pending authority only after the worker releases its presentation hold. */
  commitPresentationState(): number;
  presentationRevision(): number;
  presentationCols(): number;
  presentationRows(): number;
  presentationRowVersion(row: number): number;
  resize(cols: number, rows: number): void;
  applyState(data: Uint8Array, seq: number): boolean;
  applyDelta(data: Uint8Array, seq: number): boolean;
  lastApplyVisuallyChanged(): boolean;
  /** Last authoritative display sequence applied to this row, or zero. */
  displayRowVersion(row: number): number;
  validateFrame(data: Uint8Array): boolean;
  installDisplayDictionary(
    generation: number,
    id: number,
    hash: number,
    bytes: Uint8Array,
  ): boolean;
  clearDisplayDictionaries(): void;
  stageDisplayFrame(data: Uint8Array): number;
  /** Logical bytes requested when the reusable WASM ingress grew; zero on reuse. */
  lastStageAllocationRequestedBytes(): number;
  validateStagedFrame(handle: number): boolean;
  applyStagedState(handle: number, seq: number): boolean;
  applyStagedDelta(handle: number, seq: number): boolean;
  releaseStagedFrame(handle: number): void;
  setTheme(bytes: Uint8Array): boolean;
  resetDisplayOrdering(): void;
  /** Exact local canonical mutation fence for a pending closure claim. */
  completionMutationEpoch(): number;
  /**
   * Whether the authoritative grid and applied header are exactly the complete
   * application frame the claim `hi:lo` names. Zero names nothing.
   */
  closureDigestMatches(hi: number, lo: number): boolean;
  cols(): number;
  rows(): number;
  takeLastError(): string | null;
  /**
   * `visible` is main's own admission decision, latched by the speculative line
   * this op seeds. Only a printable can seed one, so it is the only op that
   * carries the bit; the rest inherit their line's. The model never re-reads a
   * live visibility flag: the gate governs what may become visible, never what
   * is retracted.
   */
  predictPrintable(codepoint: number, sentAtMs: number, inputSeq: number, visible: boolean): number;
  predictBackspace(sentAtMs: number, inputSeq: number): number;
  predictDelete(sentAtMs: number, inputSeq: number): number;
  predictCursorShift(delta: number, sentAtMs: number, inputSeq: number): number;
  /**
   * An input the model does not project ended the line. Painted glyphs stay
   * until authority answers them; nothing typed behind it is modelled.
   * `inputSeq` is that input's sequence, 0 when it carried none.
   */
  predictSeal(inputSeq: number): void;
  /** The model's own code for why it last dropped, sealed or refused a line. */
  lastFlushCause(): number;
  /** Drop the model outright: the grid it was drawn over no longer exists. */
  predictDiscard(): void;
  predictReconcile(
    nowMs: number,
    ttlMs: number,
    authoritativeInputHighWater: number,
    authoritativeEchoHorizon: number,
  ): Uint32Array;
  /**
   * `[flags, startCol, cursorCol, endCol, opsRemaining, cols]` — the model's
   * own admission arithmetic, so main can decide wire provenance synchronously
   * instead of blocking a keystroke on this worker.
   */
  predictionModel(): Uint32Array;
  /**
   * Publish the daemon's prompt anchor. `flags` bit 0 clear voids it.
   * Lets the speculative model re-seed across a non-blank row tail (a shell
   * autosuggestion), which otherwise keeps prediction dead for the rest of the
   * line after any mid-line flush.
   */
  setEditorAnchor(generation: number, row: number, col: number, flags: number): void;
  /** Exact effects in the last built geometry, regardless of diagnostics. Borrow until the next mutation. */
  visiblePredictionInputSeqs(): Uint32Array;
  visiblePredictionClearEffectPairs(): Uint32Array;
  visiblePredictionInputSeqsTruncated(): boolean;
  /**
   * Turn on the backwards-cursor journal. Off by default; the render path pays
   * one branch while it is off.
   *
   * The renderer draws the cursor at the predicted column while the shadow
   * model is visible and at the authoritative column otherwise, and an
   * outstanding prediction is exactly the state in which those differ — so a
   * cursor seen stepping left mid-word is either the model being taken away or
   * authority itself moving back, and afterwards the two are the same pixel.
   * This is what tells them apart in a live session.
   */
  setCursorMotionJournal(enabled: boolean): void;
  /**
   * Backwards steps and authoritative shape/visibility changes since the last
   * drain, six words each: `[seq, cause, fromRowCol, toRowCol, flags, ops]`.
   * Rows and columns are packed `row << 16 | col`; a shape record (cause
   * `AuthorityShape`) packs `shape << 8 | visible` in those two words and the
   * header's display sequence in `ops`. `cursorCauseName` names the cause.
   */
  cursorMotion(): Uint32Array;
  /**
   * Words the journal holds, without building a view over them. The drain runs
   * on every frame of a profiling session and the journal is empty on almost
   * all of them; reading the length first keeps that path allocation-free.
   */
  cursorMotionLength(): number;
  clearCursorMotion(): void;
  /** Records the journal refused because nothing drained it. */
  cursorMotionDropped(): number;
  predictionRenderDirty(): boolean;
  clearPredictionRenderDirty(): void;
  hasPredictions(): boolean;
  // Font / atlas.
  setFontBytes(
    normal: Uint8Array,
    bold: Uint8Array,
    italic: Uint8Array,
    boldItalic: Uint8Array,
  ): void;
  setRegularFontBytes(normal: Uint8Array): void;
  /** Install the style faces, keeping the already-parsed regular face. */
  setStyleFontBytes(bold: Uint8Array, italic: Uint8Array, boldItalic: Uint8Array): void;
  setCellMetrics(pxPerEm: number, lineHeight: number, dpr: number): void;
  cellMetrics(): Float32Array; // [cell_w_phys, cell_h_phys, baseline_phys, dpr]
  atlasIsDirty(): boolean;
  atlasDirtyRect(): Uint32Array; // [x, y, w, h]
  atlasPixelsPtr(): number;
  atlasWidth(): number;
  atlasHeight(): number;
  atlasGeneration(): number;
  prepareSpeculativeAsciiAtlas(): boolean;
  speculativeAsciiEntries(): Int32Array;
  atlasMarkClean(): void;
  /** Flat `[codepoint, style, ...]` pairs awaiting Canvas 2D rasterization. */
  missingGlyphs(): Uint32Array;
  finishMissingPass(): void;
  injectGlyph(
    cp: number,
    style: number,
    w: number,
    h: number,
    ox: number,
    oy: number,
    pixels: Uint8Array,
  ): boolean;
  buildGeometry(): void;
  mouseMode(): number;
  /**
   * The daemon's input-routing word from a paused synchronized update: only
   * the routing and input-report bits of `mouseMode` change, and they stay the
   * word's across applied headers until `releaseInputRouting`.
   */
  setInputRouting(word: number): void;
  /** A header sent after the routing word applied: the routing bits are that header's again. */
  releaseInputRouting(): void;
  /** Every viewport row, untrimmed, joined by `\n`. */
  viewportRows(): string;
  presentationViewportRows(): string;
  /** One bit per row, LSB-first: set means the row soft-wraps onto the next. */
  viewportWrapBits(): Uint8Array;
  presentationViewportWrapBits(): Uint8Array;
  /** OSC 8 link id per authoritative viewport cell, row-major, 0 for none. */
  viewportLinks(): Uint32Array;
  /** Grid column of every UTF-16 unit of `viewportRows()`, newlines excluded. */
  viewportTextColumns(): Uint16Array;
  /** Render IME composition at the cursor; caret is a DOM UTF-16 offset. */
  setPreedit(text: string, caret: number): void;
  /** Fixed metadata groups for bg/glyph/deco/cursor, refreshed by buildGeometry. */
  geometryState(): Uint32Array;
  // direct WASM memory access
  readonly memory: WebAssembly.Memory;
}

interface LoadedWasmRuntime {
  readonly initDisplayReceiverCalibration: (cols: number, rows: number) => WasmTerminalInstance;
  readonly initRegular: (
    viewportWidth: number,
    viewportHeight: number,
    normal: Uint8Array,
    pxPerEm: number,
    lineHeight: number,
    dpr: number,
  ) => WasmTerminalInstance;
  readonly memory: WebAssembly.Memory;
}

interface WasmTerminalInstance {
  graphics_ptr(): number;
  graphics_len(): number;
  free(): void;
  row_hash(row: number): bigint;
  refresh_row_hashes(): number;
  row_hashes_len(): number;
  closure_digest_matches(hi: number, lo: number): boolean;
  cursor_info_ptr(): number;
  cursor_info_len(): number;
  received_cursor_info_ptr(): number;
  commit_presentation_state(): number;
  presentation_revision(): number;
  presentation_cols(): number;
  presentation_rows(): number;
  presentation_row_version(row: number): number;
  set_cursor_motion_journal(enabled: boolean): void;
  cursor_motion_ptr(): number;
  cursor_motion_len(): number;
  cursor_motion_dropped(): number;
  clear_cursor_motion(): void;
  resize(cols: number, rows: number): void;
  apply_state_seq(data: Uint8Array, seq: number): boolean;
  apply_delta_seq(data: Uint8Array, seq: number): boolean;
  last_apply_visually_changed(): boolean;
  display_row_version(row: number): number;
  validate_frame(data: Uint8Array): boolean;
  install_display_dictionary(
    generation: number,
    id: number,
    hash: number,
    bytes: Uint8Array,
  ): boolean;
  clear_display_dictionaries(): void;
  reserve_display_frame_input(capacity: number): number;
  stage_display_frame_input(len: number): number;
  validate_staged_frame(handle: number): boolean;
  apply_staged_state_seq(handle: number, seq: number): boolean;
  apply_staged_delta_seq(handle: number, seq: number): boolean;
  release_staged_frame(handle: number): void;
  set_theme(bytes: Uint8Array): boolean;
  reset_display_ordering(): void;
  cols(): number;
  rows(): number;
  take_last_error(): string | undefined;
  predict_printable(
    codepoint: number,
    sentAtMs: number,
    inputSeq: number,
    visible: boolean,
  ): number;
  predict_backspace(sentAtMs: number, inputSeq: number): number;
  predict_delete(sentAtMs: number, inputSeq: number): number;
  predict_cursor_shift(delta: number, sentAtMs: number, inputSeq: number): number;
  predict_seal(inputSeq: number): void;
  last_flush_cause(): number;
  predict_discard(): void;
  predict_reconcile(
    nowMs: number,
    ttlMs: number,
    authoritativeInputHighWater: number,
    authoritativeEchoHorizon: number,
  ): void;
  reconcile_stats_ptr(): number;
  reconcile_stats_len(): number;
  prediction_model_ptr(): number;
  prediction_model_len(): number;
  set_editor_anchor(generation: number, row: number, col: number, flags: number): void;
  visible_prediction_input_seqs_ptr(): number;
  visible_prediction_input_seqs_len(): number;
  visible_prediction_clear_effect_pairs_ptr(): number;
  visible_prediction_clear_effect_pairs_len(): number;
  visible_prediction_input_seqs_truncated(): boolean;
  prediction_render_dirty(): boolean;
  clear_prediction_render_dirty(): void;
  has_predictions(): boolean;
  // Font / atlas.
  set_font_bytes(
    normal: Uint8Array,
    bold: Uint8Array,
    italic: Uint8Array,
    boldItalic: Uint8Array,
  ): void;
  set_regular_font_bytes(normal: Uint8Array): void;
  set_style_font_bytes(bold: Uint8Array, italic: Uint8Array, boldItalic: Uint8Array): void;
  set_cell_metrics(pxPerEm: number, lineHeight: number, dpr: number): void;
  cell_metrics_ptr(): number;
  cell_metrics_len(): number;
  atlas_is_dirty(): boolean;
  atlas_dirty_rect_ptr(): number;
  atlas_dirty_rect_len(): number;
  atlas_pixels_ptr(): number;
  atlas_width(): number;
  atlas_height(): number;
  atlas_generation(): number;
  prepare_speculative_ascii_atlas(): boolean;
  speculative_ascii_entries_ptr(): number;
  speculative_ascii_entries_len(): number;
  atlas_mark_clean(): void;
  missing_codepoints_ptr(): number;
  missing_codepoints_len(): number;
  finish_missing_pass(): void;
  inject_glyph(
    cp: number,
    style: number,
    w: number,
    h: number,
    ox: number,
    oy: number,
    pixels: Uint8Array,
  ): boolean;
  build_geometry(): void;
  mouse_mode(): number;
  set_input_routing(word: number): void;
  release_input_routing(): void;
  viewport_rows(): string;
  presentation_viewport_rows(): string;
  viewport_wrap_bits(): Uint8Array;
  presentation_viewport_wrap_bits(): Uint8Array;
  viewport_links(): Uint32Array;
  viewport_text_columns(): Uint16Array;
  set_preedit(text: string, caret: number): void;
  geometry_state_ptr(): number;
  geometry_state_len(): number;
}

let preloadPromise: Promise<LoadedWasmRuntime> | null = null;
const WASM_MODULE_PATH = './term-wasm/pkg/term_wasm.js';
const ERROR_INVALID_WASM_MODULE = 'WASM module does not export expected terminal symbols';
const ERROR_INVALID_WASM_INIT = 'WASM module does not export init_regular(...)';
const ERROR_INVALID_WASM_CALIBRATION_INIT =
  'WASM module does not export init_display_receiver_calibration(...)';
const logger = createLogger('web-wasm');

/**
 * Start fetching and instantiating the terminal runtime without constructing a
 * terminal yet. Startup uses this to overlap WASM with font and decompressor
 * loading; createWasmTerminalHandle reuses the same owned promise.
 */
export async function preloadWasmTerminalRuntime(): Promise<void> {
  await loadWasmModule();
}

export async function createWasmTerminalHandle(
  viewportWidth: number,
  viewportHeight: number,
  regularFontBuffer: ArrayBuffer,
  fontSize: number,
  lineHeight: number,
  dpr: number,
): Promise<WasmTerminalHandle> {
  const wasmRuntime = await loadWasmModule();
  const terminal = wasmRuntime.initRegular(
    viewportWidth,
    viewportHeight,
    new Uint8Array(regularFontBuffer),
    fontSize * dpr,
    lineHeight,
    dpr,
  );
  return createWasmTerminalHandleFromInstance(wasmRuntime.memory, terminal);
}

/**
 * Renderer-free terminal with exclusive ownership by receiver calibration.
 * The caller must destroy it; it shares only the immutable WASM module and
 * linear memory allocator with the live terminal, never terminal state.
 */
export async function createWasmDisplayReceiverCalibrationHandle(
  cols: number,
  rows: number,
): Promise<WasmTerminalHandle> {
  const wasmRuntime = await loadWasmModule();
  const terminal = wasmRuntime.initDisplayReceiverCalibration(cols, rows);
  return createWasmTerminalHandleFromInstance(wasmRuntime.memory, terminal);
}

function createWasmTerminalHandleFromInstance(
  memory: WebAssembly.Memory,
  terminal: WasmTerminalInstance,
): WasmTerminalHandle {
  let frameInputPtr = 0;
  let frameInputCapacity = 0;
  let lastStageAllocationRequestedBytes = 0;
  let completionMutationEpoch = 0;
  function noteCanonicalMutation(): void {
    if (completionMutationEpoch === Number.MAX_SAFE_INTEGER)
      throw new Error('canonical mutation epoch exhausted');
    completionMutationEpoch += 1;
  }
  return {
    ...createWasmRenderHandle(memory, terminal),
    memory,
    commitPresentationState(): number {
      return terminal.commit_presentation_state() >>> 0;
    },
    resize(nextCols: number, nextRows: number): void {
      noteCanonicalMutation();
      terminal.resize(nextCols, nextRows);
    },
    applyState(data: Uint8Array, seq: number): boolean {
      return terminal.apply_state_seq(data, seq);
    },
    applyDelta(data: Uint8Array, seq: number): boolean {
      return terminal.apply_delta_seq(data, seq);
    },
    lastApplyVisuallyChanged(): boolean {
      return terminal.last_apply_visually_changed();
    },
    validateFrame(data: Uint8Array): boolean {
      return terminal.validate_frame(data);
    },
    installDisplayDictionary(
      generation: number,
      id: number,
      hash: number,
      bytes: Uint8Array,
    ): boolean {
      return terminal.install_display_dictionary(generation, id, hash, bytes);
    },
    clearDisplayDictionaries(): void {
      terminal.clear_display_dictionaries();
    },
    stageDisplayFrame(data: Uint8Array): number {
      lastStageAllocationRequestedBytes = 0;
      if (data.byteLength > frameInputCapacity) {
        frameInputPtr = terminal.reserve_display_frame_input(data.byteLength) >>> 0;
        if (frameInputPtr === 0) return 0;
        frameInputCapacity = data.byteLength;
        lastStageAllocationRequestedBytes = data.byteLength;
      }
      new Uint8Array(memory.buffer, frameInputPtr, data.byteLength).set(data);
      return terminal.stage_display_frame_input(data.byteLength);
    },
    lastStageAllocationRequestedBytes(): number {
      return lastStageAllocationRequestedBytes;
    },
    validateStagedFrame(handle: number): boolean {
      return terminal.validate_staged_frame(handle);
    },
    applyStagedState(handle: number, seq: number): boolean {
      return terminal.apply_staged_state_seq(handle, seq);
    },
    applyStagedDelta(handle: number, seq: number): boolean {
      return terminal.apply_staged_delta_seq(handle, seq);
    },
    releaseStagedFrame(handle: number): void {
      terminal.release_staged_frame(handle);
    },
    resetDisplayOrdering(): void {
      noteCanonicalMutation();
      terminal.reset_display_ordering();
    },
    completionMutationEpoch: () => completionMutationEpoch,
    closureDigestMatches(hi: number, lo: number): boolean {
      return terminal.closure_digest_matches(hi >>> 0, lo >>> 0);
    },
    takeLastError(): string | null {
      return terminal.take_last_error() ?? null;
    },
    predictPrintable(
      codepoint: number,
      sentAtMs: number,
      inputSeq: number,
      visible: boolean,
    ): number {
      return terminal.predict_printable(codepoint, sentAtMs, inputSeq, visible);
    },
    predictBackspace(sentAtMs: number, inputSeq: number): number {
      return terminal.predict_backspace(sentAtMs, inputSeq);
    },
    predictDelete(sentAtMs: number, inputSeq: number): number {
      return terminal.predict_delete(sentAtMs, inputSeq);
    },
    predictCursorShift(delta: number, sentAtMs: number, inputSeq: number): number {
      return terminal.predict_cursor_shift(delta, sentAtMs, inputSeq);
    },
    predictSeal(inputSeq: number): void {
      terminal.predict_seal(inputSeq);
    },
    predictDiscard(): void {
      terminal.predict_discard();
    },
    predictReconcile(
      nowMs: number,
      ttlMs: number,
      authoritativeInputHighWater: number,
      authoritativeEchoHorizon: number,
    ): Uint32Array {
      terminal.predict_reconcile(
        nowMs,
        ttlMs,
        authoritativeInputHighWater,
        authoritativeEchoHorizon,
      );
      const ptr = terminal.reconcile_stats_ptr() >>> 0;
      const len = terminal.reconcile_stats_len() >>> 0;
      return new Uint32Array(memory.buffer, ptr, len);
    },
    setEditorAnchor(generation: number, row: number, col: number, flags: number): void {
      terminal.set_editor_anchor(generation, row, col, flags);
    },
    releaseInputRouting(): void {
      terminal.release_input_routing();
    },
    setInputRouting(word: number): void {
      terminal.set_input_routing(word);
    },
  };
}

export type WasmRenderHandle = Pick<
  WasmTerminalHandle,
  | 'graphicsFragments'
  | 'destroy'
  | 'rowHash'
  | 'rowHashes'
  | 'cursorInfo'
  | 'receivedCursorInfo'
  | 'presentationRevision'
  | 'presentationCols'
  | 'presentationRows'
  | 'presentationRowVersion'
  | 'displayRowVersion'
  | 'setTheme'
  | 'cols'
  | 'rows'
  | 'lastFlushCause'
  | 'setCursorMotionJournal'
  | 'cursorMotion'
  | 'cursorMotionLength'
  | 'clearCursorMotion'
  | 'cursorMotionDropped'
  | 'predictionModel'
  | 'visiblePredictionInputSeqs'
  | 'visiblePredictionClearEffectPairs'
  | 'visiblePredictionInputSeqsTruncated'
  | 'predictionRenderDirty'
  | 'clearPredictionRenderDirty'
  | 'hasPredictions'
  | 'setFontBytes'
  | 'setRegularFontBytes'
  | 'setStyleFontBytes'
  | 'setCellMetrics'
  | 'cellMetrics'
  | 'atlasIsDirty'
  | 'atlasDirtyRect'
  | 'atlasPixelsPtr'
  | 'atlasWidth'
  | 'atlasHeight'
  | 'atlasGeneration'
  | 'prepareSpeculativeAsciiAtlas'
  | 'speculativeAsciiEntries'
  | 'atlasMarkClean'
  | 'missingGlyphs'
  | 'finishMissingPass'
  | 'injectGlyph'
  | 'buildGeometry'
  | 'mouseMode'
  | 'viewportRows'
  | 'presentationViewportRows'
  | 'viewportWrapBits'
  | 'presentationViewportWrapBits'
  | 'viewportLinks'
  | 'viewportTextColumns'
  | 'setPreedit'
  | 'geometryState'
  | 'memory'
>;

function createWasmRenderHandle(
  memory: WebAssembly.Memory,
  terminal: Pick<
    WasmTerminalInstance,
    | 'atlas_dirty_rect_len'
    | 'atlas_dirty_rect_ptr'
    | 'atlas_generation'
    | 'atlas_height'
    | 'atlas_is_dirty'
    | 'atlas_mark_clean'
    | 'atlas_pixels_ptr'
    | 'atlas_width'
    | 'build_geometry'
    | 'cell_metrics_len'
    | 'cell_metrics_ptr'
    | 'clear_cursor_motion'
    | 'clear_prediction_render_dirty'
    | 'cols'
    | 'cursor_info_len'
    | 'cursor_info_ptr'
    | 'cursor_motion_dropped'
    | 'cursor_motion_len'
    | 'cursor_motion_ptr'
    | 'display_row_version'
    | 'finish_missing_pass'
    | 'free'
    | 'geometry_state_len'
    | 'geometry_state_ptr'
    | 'graphics_len'
    | 'graphics_ptr'
    | 'has_predictions'
    | 'inject_glyph'
    | 'last_flush_cause'
    | 'missing_codepoints_len'
    | 'missing_codepoints_ptr'
    | 'mouse_mode'
    | 'prediction_model_len'
    | 'prediction_model_ptr'
    | 'prediction_render_dirty'
    | 'prepare_speculative_ascii_atlas'
    | 'presentation_cols'
    | 'presentation_revision'
    | 'presentation_row_version'
    | 'presentation_rows'
    | 'presentation_viewport_rows'
    | 'presentation_viewport_wrap_bits'
    | 'received_cursor_info_ptr'
    | 'refresh_row_hashes'
    | 'row_hash'
    | 'row_hashes_len'
    | 'rows'
    | 'set_cell_metrics'
    | 'set_cursor_motion_journal'
    | 'set_font_bytes'
    | 'set_preedit'
    | 'set_regular_font_bytes'
    | 'set_style_font_bytes'
    | 'set_theme'
    | 'speculative_ascii_entries_len'
    | 'speculative_ascii_entries_ptr'
    | 'viewport_links'
    | 'viewport_rows'
    | 'viewport_text_columns'
    | 'viewport_wrap_bits'
    | 'visible_prediction_input_seqs_truncated'
    | 'visible_prediction_input_seqs_ptr'
    | 'visible_prediction_input_seqs_len'
    | 'visible_prediction_clear_effect_pairs_ptr'
    | 'visible_prediction_clear_effect_pairs_len'
  >,
): WasmRenderHandle {
  const readCursorInfo = createCursorInfoReader(memory, terminal);
  let receivedCursorView: Uint16Array | null = null;
  const readRowHashes = createRowHashReader(memory, terminal);
  const readGeometryState = createGeometryStateReader(memory, terminal);
  const readVisiblePredictionInputSeqs = createPredictionEffectReader(
    memory,
    () => terminal.visible_prediction_input_seqs_ptr(),
    () => terminal.visible_prediction_input_seqs_len(),
  );
  const readVisiblePredictionClearEffectPairs = createPredictionEffectReader(
    memory,
    () => terminal.visible_prediction_clear_effect_pairs_ptr(),
    () => terminal.visible_prediction_clear_effect_pairs_len(),
  );
  const readPredictionModel = createPredictionEffectReader(
    memory,
    () => terminal.prediction_model_ptr(),
    () => terminal.prediction_model_len(),
  );
  const readCellMetrics = createWasmViewReader(
    memory,
    Float32Array,
    () => terminal.cell_metrics_ptr(),
    () => terminal.cell_metrics_len(),
  );
  const readSpeculativeAsciiEntries = createWasmViewReader(
    memory,
    Int32Array,
    () => terminal.speculative_ascii_entries_ptr(),
    () => terminal.speculative_ascii_entries_len(),
  );
  return {
    memory,
    graphicsFragments: () => {
      const pointer = terminal.graphics_ptr();
      return new Uint8Array(memory.buffer, pointer, terminal.graphics_len());
    },
    destroy(): void {
      terminal.free();
    },
    rowHash(row: number): bigint {
      return terminal.row_hash(row);
    },
    rowHashes(): Uint32Array {
      return readRowHashes();
    },
    cursorInfo(): Uint16Array {
      return readCursorInfo();
    },
    receivedCursorInfo(): Uint16Array {
      const ptr = terminal.received_cursor_info_ptr() >>> 0;
      if (
        receivedCursorView === null ||
        receivedCursorView.buffer !== memory.buffer ||
        receivedCursorView.byteOffset !== ptr
      ) {
        receivedCursorView = new Uint16Array(memory.buffer, ptr, 4);
      }
      return receivedCursorView;
    },
    presentationRevision(): number {
      return terminal.presentation_revision() >>> 0;
    },
    presentationCols(): number {
      return terminal.presentation_cols();
    },
    presentationRows(): number {
      return terminal.presentation_rows();
    },
    presentationRowVersion(row: number): number {
      return terminal.presentation_row_version(row) >>> 0;
    },
    displayRowVersion(row: number): number {
      return terminal.display_row_version(row) >>> 0;
    },
    setTheme(bytes: Uint8Array): boolean {
      return terminal.set_theme(bytes);
    },
    cols(): number {
      return terminal.cols();
    },
    rows(): number {
      return terminal.rows();
    },
    lastFlushCause(): number {
      return terminal.last_flush_cause() >>> 0;
    },
    setCursorMotionJournal(enabled: boolean): void {
      terminal.set_cursor_motion_journal(enabled);
    },
    cursorMotion(): Uint32Array {
      const ptr = terminal.cursor_motion_ptr() >>> 0;
      const len = terminal.cursor_motion_len() >>> 0;
      return new Uint32Array(memory.buffer, ptr, len);
    },
    cursorMotionLength(): number {
      return terminal.cursor_motion_len() >>> 0;
    },
    clearCursorMotion(): void {
      terminal.clear_cursor_motion();
    },
    cursorMotionDropped(): number {
      return terminal.cursor_motion_dropped() >>> 0;
    },
    predictionModel(): Uint32Array {
      return readPredictionModel();
    },
    visiblePredictionInputSeqs(): Uint32Array {
      return readVisiblePredictionInputSeqs();
    },
    visiblePredictionClearEffectPairs(): Uint32Array {
      return readVisiblePredictionClearEffectPairs();
    },
    visiblePredictionInputSeqsTruncated(): boolean {
      return terminal.visible_prediction_input_seqs_truncated();
    },
    predictionRenderDirty(): boolean {
      return terminal.prediction_render_dirty();
    },
    clearPredictionRenderDirty(): void {
      terminal.clear_prediction_render_dirty();
    },
    hasPredictions(): boolean {
      return terminal.has_predictions();
    },
    // Font / atlas.,
    setFontBytes(
      normal: Uint8Array,
      bold: Uint8Array,
      italic: Uint8Array,
      boldItalic: Uint8Array,
    ): void {
      terminal.set_font_bytes(normal, bold, italic, boldItalic);
    },
    setRegularFontBytes(normal: Uint8Array): void {
      terminal.set_regular_font_bytes(normal);
    },
    setStyleFontBytes(bold: Uint8Array, italic: Uint8Array, boldItalic: Uint8Array): void {
      terminal.set_style_font_bytes(bold, italic, boldItalic);
    },
    setCellMetrics(pxPerEm: number, lineHeight: number, dpr: number): void {
      terminal.set_cell_metrics(pxPerEm, lineHeight, dpr);
    },
    cellMetrics(): Float32Array {
      return readCellMetrics();
    },
    atlasIsDirty(): boolean {
      return terminal.atlas_is_dirty();
    },
    atlasDirtyRect(): Uint32Array {
      const ptr = terminal.atlas_dirty_rect_ptr() >>> 0;
      const len = terminal.atlas_dirty_rect_len() >>> 0;
      return new Uint32Array(memory.buffer, ptr, len);
    },
    atlasPixelsPtr(): number {
      return terminal.atlas_pixels_ptr() >>> 0;
    },
    atlasWidth(): number {
      return terminal.atlas_width();
    },
    atlasHeight(): number {
      return terminal.atlas_height();
    },
    atlasGeneration(): number {
      return terminal.atlas_generation();
    },
    prepareSpeculativeAsciiAtlas(): boolean {
      return terminal.prepare_speculative_ascii_atlas();
    },
    speculativeAsciiEntries(): Int32Array {
      return readSpeculativeAsciiEntries();
    },
    atlasMarkClean(): void {
      terminal.atlas_mark_clean();
    },
    missingGlyphs(): Uint32Array {
      const ptr = terminal.missing_codepoints_ptr() >>> 0;
      const len = terminal.missing_codepoints_len() >>> 0;
      if (len === 0) return new Uint32Array(0);
      // Copy rather than view. The caller injects while iterating, and an
      // injection that grows the atlas (2048² -> 4096²) grows the wasm heap,
      // which detaches every view over the old buffer mid-loop and silently
      // truncates the batch. The list is a handful of entries; the copy is free.
      return new Uint32Array(memory.buffer, ptr, len).slice();
    },
    finishMissingPass(): void {
      terminal.finish_missing_pass();
    },
    injectGlyph(
      cp: number,
      style: number,
      w: number,
      h: number,
      ox: number,
      oy: number,
      pixels: Uint8Array,
    ): boolean {
      return terminal.inject_glyph(cp, style, w, h, ox, oy, pixels);
    },
    buildGeometry(): void {
      terminal.build_geometry();
    },
    mouseMode(): number {
      return terminal.mouse_mode();
    },
    viewportRows(): string {
      return terminal.viewport_rows();
    },
    presentationViewportRows(): string {
      return terminal.presentation_viewport_rows();
    },
    viewportWrapBits(): Uint8Array {
      return terminal.viewport_wrap_bits();
    },
    presentationViewportWrapBits(): Uint8Array {
      return terminal.presentation_viewport_wrap_bits();
    },
    viewportLinks(): Uint32Array {
      return terminal.viewport_links();
    },
    viewportTextColumns(): Uint16Array {
      return terminal.viewport_text_columns();
    },
    setPreedit(text: string, caret: number): void {
      terminal.set_preedit(text, caret);
    },
    geometryState(): Uint32Array {
      return readGeometryState();
    },
  };
}

/** Borrow exact geometry membership without allocating another view on unchanged frames. */
export function createPredictionEffectReader(
  memory: WebAssembly.Memory,
  readPointer: () => number,
  readLength: () => number,
): () => Uint32Array {
  return createWasmViewReader(memory, Uint32Array, readPointer, readLength);
}

/**
 * Borrow a WASM-owned array, minting a view only when its pointer, length or
 * the memory's buffer (replaced by growth) changed since the last read.
 */
function createWasmViewReader<View extends Uint32Array | Int32Array | Float32Array>(
  memory: WebAssembly.Memory,
  View: new (buffer: ArrayBufferLike, byteOffset: number, length: number) => View,
  readPointer: () => number,
  readLength: () => number,
): () => View {
  let view: View | null = null;
  return (): View => {
    const ptr = readPointer() >>> 0;
    const len = readLength() >>> 0;
    const buffer = memory.buffer;
    if (view === null || view.buffer !== buffer || view.byteOffset !== ptr || view.length !== len) {
      view = new View(buffer, ptr, len);
    }
    return view;
  };
}

interface GeometryStateExports {
  geometry_state_ptr(): number;
  geometry_state_len(): number;
}

/**
 * Bind the terminal's fixed render snapshot once. WebAssembly memory growth
 * replaces `memory.buffer`, so the hot-path identity check rebinds the view
 * without re-querying its stable pointer or length.
 */
export function createGeometryStateReader(
  memory: WebAssembly.Memory,
  terminal: GeometryStateExports,
): () => Uint32Array {
  const ptr = terminal.geometry_state_ptr() >>> 0;
  const len = terminal.geometry_state_len() >>> 0;
  if (len !== GEOMETRY_STATE_LENGTH) {
    throw new RangeError(`invalid terminal geometry state length ${len}`);
  }
  let boundBuffer: ArrayBufferLike | null = null;
  let view: Uint32Array | null = null;
  return (): Uint32Array => {
    const buffer = memory.buffer;
    if (view === null || boundBuffer !== buffer) {
      boundBuffer = buffer;
      view = new Uint32Array(buffer, ptr, len);
    }
    return view;
  };
}

function loadWasmModule(): Promise<LoadedWasmRuntime> {
  if (preloadPromise !== null) {
    return preloadPromise;
  }

  preloadPromise = initializeWasmModule();
  return preloadPromise;
}

async function initializeWasmModule(): Promise<LoadedWasmRuntime> {
  try {
    if (typeof loadWasm !== 'function') {
      throw new Error(ERROR_INVALID_WASM_MODULE);
    }
    if (typeof initTerminalRegular !== 'function') {
      throw new Error(ERROR_INVALID_WASM_INIT);
    }
    if (typeof initDisplayReceiverCalibration !== 'function') {
      throw new Error(ERROR_INVALID_WASM_CALIBRATION_INIT);
    }

    const wasmExports = await loadWasm();
    const memory = readWasmMemory(wasmExports);
    return {
      initDisplayReceiverCalibration:
        initDisplayReceiverCalibration as unknown as LoadedWasmRuntime['initDisplayReceiverCalibration'],
      initRegular: initTerminalRegular as unknown as LoadedWasmRuntime['initRegular'],
      memory,
    };
  } catch (error) {
    logger.error('wasm_preload_failed', {
      error: String(error),
      modulePath: WASM_MODULE_PATH,
    });
    throw new Error(`Unable to preload terminal WASM module at ${WASM_MODULE_PATH}`);
  }
}

function readWasmMemory(value: unknown): WebAssembly.Memory {
  if (typeof value === 'object' && value !== null && 'memory' in value) {
    const memory = value.memory;
    if (memory instanceof WebAssembly.Memory) {
      return memory;
    }
  }

  throw new Error('WASM exports missing memory');
}

/** The viewer consumes the initialized terminal; its renderer handle exposes no authority mutation. */
export interface WasmClientViewerHandle extends WasmRenderHandle {
  readonly viewer: ClientViewer;
  receive(
    nowMs: number,
    channel: number,
    payload: Uint8Array,
    mapping: {
      epoch: number;
      localMinusWire: number;
      wireMin: number;
      wireMax: number;
    },
  ): boolean;
}

export async function createWasmClientViewerHandle(
  viewportWidth: number,
  viewportHeight: number,
  regularFontBuffer: ArrayBuffer,
  fontSize: number,
  lineHeight: number,
  dpr: number,
): Promise<WasmClientViewerHandle> {
  const runtime = await loadWasmModule();
  const terminal = runtime.initRegular(
    viewportWidth,
    viewportHeight,
    new Uint8Array(regularFontBuffer),
    fontSize * dpr,
    lineHeight,
    dpr,
  );
  return createWasmClientViewerHandleFromInstance(runtime.memory, terminal as unknown as Terminal);
}

export function createWasmClientViewerHandleFromInstance(
  memory: WebAssembly.Memory,
  terminal: Terminal,
): WasmClientViewerHandle {
  const viewer = new ClientViewer(terminal);
  const render = createWasmRenderHandle(memory, viewer);
  let ingress: Uint8Array | null = null;
  return {
    ...render,
    viewer,
    receive(nowMs, channel, payload, mapping): boolean {
      const pointer = viewer.reserve_ingress(payload.byteLength) >>> 0;
      if (pointer === 0) return false;
      if (
        ingress === null ||
        ingress.buffer !== memory.buffer ||
        ingress.byteOffset !== pointer ||
        ingress.byteLength < payload.byteLength
      ) {
        ingress = new Uint8Array(memory.buffer, pointer, payload.byteLength);
      }
      ingress.set(payload);
      viewer.set_input_mapping(
        mapping.epoch,
        mapping.localMinusWire,
        mapping.wireMin,
        mapping.wireMax,
      );
      return viewer.receive(nowMs, channel, payload.byteLength);
    },
  };
}
