import { createLogger } from '@merkur/logger';
import {
  encodeMouseRecord,
  encodeMouseRecordInto,
  encodeWheelRecord,
  KEY_MOD_ALT,
  KEY_MOD_CTRL,
  KEY_MOD_SHIFT,
  MOUSE_ACTION_MOTION,
  MOUSE_ACTION_PRESS,
  MOUSE_ACTION_RELEASE,
  MOUSE_BUTTON_LEFT,
  MOUSE_BUTTON_MIDDLE,
  MOUSE_BUTTON_NONE,
  MOUSE_BUTTON_RIGHT,
  MOUSE_RECORD_MAX_BYTES,
  type MouseButton,
  WHEEL_DOWN,
  WHEEL_UP,
} from '@merkur/protocol';
import {
  clampTerminalDimensions,
  MAX_TERMINAL_COLUMNS,
  TERMINAL_MODE_ALT_SCREEN,
  TERMINAL_MODE_INPUT_REPORTS,
  TERMINAL_MODE_POINTER_CLICKS,
  TERMINAL_MODE_POINTER_DRAG,
  TERMINAL_MODE_POINTER_HOVER,
  TERMINAL_MODE_WHEEL,
} from '@merkur/shared';
import { loadE2eWasmModule } from './lib/e2e-wasm-module';
import { mainPerfWriter } from './perf/main-perf-writer';
import {
  emitFirstDisplayGate,
  emitInputSeqEvent,
  PERF_KIND_PREDICTION_QUEUED,
} from './perf/perf-event-codec';
import {
  isTerminalPerfRecording,
  terminalPerfNowMs,
  terminalPerfObservationEpoch,
} from './perf/terminal-latency';
import {
  DEFAULT_TERMINAL_FONT,
  type TerminalFontFamily,
  terminalFontFamilyKey,
} from './terminal/fonts';
import {
  findLinkAt,
  type LinkHit,
  type LinkViewport,
  type UrlMatcher,
} from './terminal/link-detection';
import { createLinkHoverLayer } from './terminal/link-hover-layer';
import {
  type CellPos,
  createMouseGestureOwner,
  createPointerMotionDeduper,
  type TerminalPointerGeometry,
  terminalCaretAtPoint,
  terminalCellAtPoint,
  terminalCellAtPointInto,
} from './terminal/pointer-input';
import type { PredictionModelSnapshot } from './terminal/prediction-admission-model';
import {
  CAPTURE_BACKSPACE,
  CAPTURE_DELETE,
  CAPTURE_LEFT,
  CAPTURE_PRINTABLE,
  CAPTURE_RIGHT,
  type CaptureOp,
  PredictionCapture,
} from './terminal/prediction-capture';
import {
  createPredictionFastPathWriter,
  createPredictionFastStateReader,
} from './terminal/prediction-fast-path';
import { isShadowModelInputSafe } from './terminal/prediction-gate';
import { createProfilingViewportReadOwner } from './terminal/profiling-viewport-read';
import type { TerminalDisplayRingWakeMode } from './terminal/runtime-policy';
import { createSelectionLayer } from './terminal/selection-layer';
import { createSessionEpochCommandGate } from './terminal/session-epoch-command';
import { wakeFrameRingReader } from './terminal/shared-ring';
import { DEFAULT_TERMINAL_THEME, rgbCss, type TerminalTheme } from './terminal/themes';
import {
  type PerfDisplayRingBoundarySnapshot,
  type PerfGridConvergenceResult,
  TERMINAL_PERF_FORCE_RESYNC_EVENT,
  type TerminalWorkerDiagnostics,
  type TerminalWorkerTuning,
  type WorkerCommand,
  type WorkerEvent,
} from './terminal-worker-protocol';

declare global {
  // Measurement harness only; installed while profiling owns a live terminal.
  var __merkurTerminalPerfVerifyGridConvergence:
    | ((repair: boolean) => Promise<PerfGridConvergenceResult>)
    | undefined;
  var __merkurTerminalPerfReadDisplayRingBoundary:
    | (() => Promise<PerfDisplayRingBoundarySnapshot>)
    | undefined;
  var __merkurTerminalPerfReadViewportText: (() => Promise<string>) | undefined;
}

// Mouse mode flags. One definition, in `@merkur/shared`, pinned to the Rust
// authority in `packages/term-wasm/src/lib.rs` — these were local copies, and a
// local copy of the prediction mask is exactly how speculative echo came to be
// disarmed for every alternate-screen application.
const MM_CLICKS = TERMINAL_MODE_POINTER_CLICKS;
const MM_DRAG = TERMINAL_MODE_POINTER_DRAG;
const MM_HOVER = TERMINAL_MODE_POINTER_HOVER;
const MM_WHEEL = TERMINAL_MODE_WHEEL;
const MM_ALTSCR = TERMINAL_MODE_ALT_SCREEN;
// Upper bound on how long close() waits for the terminal worker's shutdown
// handler (renderer.destroy(), timer teardown) before force terminating.
const WORKER_SHUTDOWN_GRACE_MS = 500;
const PERF_DISPLAY_RING_BOUNDARY_TIMEOUT_MS = 2_000;
const PERF_VIEWPORT_READ_TIMEOUT_MS = 2_000;
// Long enough that a stream of output does not rebuild the layer per frame,
// short enough that Shift held over changing output still selects what is on
// screen. Only ever spends a worker round trip while the layer is mounted.
const SELECTION_REFRESH_DEBOUNCE_MS = 120;
const logger = createLogger('web-terminal-worker-client');

/** Cursor cell rectangle in CSS pixels, relative to the terminal container. */
export interface CursorRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** Grid cell coordinates of the cursor. */
  readonly col: number;
  readonly row: number;
  readonly visible: boolean;
}

export interface TerminalWorkerClient {
  resize(cols: number, rows: number): void;
  refreshLayout(): void;
  refreshRender(): void;
  updateFont(fontSize: number, lineHeight: number): void;
  updateFontFamily(fontFamily: TerminalFontFamily): void;
  updateTheme(theme: TerminalTheme): void;
  /**
   * Mount or unmount the transparent DOM text layer that lets the browser own
   * selection and copy. Driven by Shift — hardware on desktop, the custom
   * keyboard's virtual modifier on touch.
   */
  setSelectionEnabled(active: boolean): void;
  /**
   * The touch keyboard's Ctrl or Cmd latch is set: the next tap on a link opens
   * it instead of reaching the application. The hardware modifiers need no
   * such call; pointer and key events carry them.
   */
  setLinkModifierLatched(latched: boolean): void;
  /**
   * Fetch the full visible viewport as plain text (rows joined by \n).
   * Returns false (and never invokes `cb`) if the worker is not ready yet.
   */
  getViewportText(cb: (text: string) => void): boolean;
  /**
   * Push the in-progress IME composition (preedit) string to the worker so it
   * renders inline at the cursor. `caret` is a DOM UTF-16 offset; empty `text`
   * clears the overlay.
   */
  setPreedit(text: string, caret: number): void;
  isAltScreenActive(): boolean;
  isPredictionSafe(): boolean;
  /** The latest display header's mode word (`TERMINAL_MODE_*`). */
  terminalMode(): number;
  previewPrintable(pointerId: number, codepoint: number): boolean;
  clearProvisionalPrintable(pointerId: number): void;
  predictPrintable(inputSeq: number, codepoint: number, sentAtMs: number): boolean;
  predictBackspace(inputSeq: number, sentAtMs: number): boolean;
  predictDelete(inputSeq: number, sentAtMs: number): boolean;
  predictCursorShift(inputSeq: number, delta: number, sentAtMs: number): boolean;
  /**
   * Flush speculative state. When an accepted but unmodelled input caused the
   * flush, pass its local sequence so prediction waits for authoritative
   * catch-up instead of restarting from a stale cursor.
   */
  flushPredictions(inputSeq?: number): void;
  updateRtt(rttMs: number): void;
  resetSrtt(): void;
  /**
   * Page visibility changed: suspends/resumes the worker's refresh-rate
   * calibration. Posts the live devicePixelRatio alongside.
   */
  updateDisplayEnv(visible: boolean): void;
  /**
   * Recovery only (resume, clock jump): re-release the frame-ring consumer and
   * the prediction consumer. The per-frame edge never comes through here — the
   * transport worker wakes this worker on the ring's own word, or over their
   * shared port on the engine whose workers park on a task.
   */
  notifyDisplayAvailable(): void;
  /**
   * Ask the worker to post a fresh `worker_health` snapshot. Health is pushed
   * once at ready and never again on its own, so a live readout has to pull.
   */
  requestHealth(): void;
  /** Measurement-only proof that daemon, applied grid, and GPU submission converge. */
  verifyGridConvergence(repair: boolean): Promise<PerfGridConvergenceResult>;
  /** Exact terminal-worker timestamp/counter pair for a measurement boundary. */
  readDisplayRingBoundary(): Promise<PerfDisplayRingBoundarySnapshot>;
  /**
   * A session (re)authenticated: the worker fences its prediction state, and
   * `displayRingFenceToken` (the transport's lineage for the new epoch) is what
   * the worker's first-display report must name to be accepted.
   */
  notifySessionEpoch(displayRingFenceToken: number | null): void;
  close(): void;
}

export function createTerminalWorkerClient(
  container: HTMLElement,
  fontSize: number,
  lineHeight: number,
  callbacks: {
    onReady(cols: number, rows: number, charWidth: number, charHeight: number): void;
    /** The first applied frame of an output burst (`display_output_changed`). */
    onDisplayFrameReceived(): void;
    /** The output has been still for the worker's settle window. */
    onDisplayOutputSettled(): void;
    onDisplayFrameApplied(displayKind: 'display_snapshot' | 'display_delta'): void;
    onFirstDisplayGpuComplete(
      displayKind: 'display_snapshot' | 'display_delta' | 'display_resume',
    ): void;
    onDisplayStateReady(cols: number, rows: number): void;
    onDisplayStateApplied(): void;
    onDisplaySnapshotRequest(): void;
    onWorkerHealth(diagnostics: TerminalWorkerDiagnostics): void;
    onMetrics(charWidth: number, charHeight: number): void;
    onFatal(message: string): void;
    /**
     * A mouse or wheel input record, for the input controller's queue. Its
     * bytes are this client's to reuse once the call returns: motion reports
     * share one record, so a consumer that keeps a record copies it.
     */
    onMouseInput(record: Uint8Array): void;
    /** Fired when the cursor cell moves; rect is in CSS px. */
    onCursorMove(rect: CursorRect): void;
    /**
     * The selection layer went up or came down. The caller must not move focus
     * while it is up: focusing the editing surface moves the document selection
     * into its `EditContext` and wipes whatever the user selected.
     */
    onSelectionActive(active: boolean): void;
    /** The URI the daemon defined for an OSC 8 link id, if it has arrived. */
    resolveLink(id: number): string | undefined;
    /** A touch tap opened a link, spending the keyboard's modifier latch. */
    onLinkActivated(): void;
    /**
     * The terminal started reporting releases, bare modifiers or focus: input
     * of that kind held while it encoded to nothing has to leave now.
     */
    onInputReportsRaised(): void;
  },
  // The display frameRing is created by the app controller and shared with the
  // transport worker (its sole producer); this client's terminal worker only
  // reads from it.
  frameRing: SharedArrayBuffer,
  // The other direction: this client's terminal worker is the sole producer of
  // what its viewer asks the session to send, and the transport worker reads.
  viewerOutputRing: SharedArrayBuffer,
  // Fixed shared ledger used to turn a queued prediction into wire provenance
  // only after the terminal worker/WASM accepts that exact local input.
  predictionAdmission: SharedArrayBuffer,
  // Fixed SPSC prediction commands plus worker-published admission/visibility state.
  predictionFastPath: SharedArrayBuffer,
  // Where this worker publishes the live grid claim the transport worker turns
  // into a `display_resume`.
  presentationCadence: SharedArrayBuffer,
  displayReceiverProfile: SharedArrayBuffer,
  // Profiling ring handed to the terminal worker and written only there. One
  // ring per producer keeps each lane single-writer, so neither needs a CAS.
  // This thread's own records go through `mainPerfWriter()`, the single main
  // thread producer installed by the app controller.
  terminalPerfRing: SharedArrayBuffer,
  // This worker's end of the worker-to-worker wake channel, transferred in
  // `init`, and the wake mode main resolved for every ring in the bundle.
  ringWakePort: MessagePort,
  displayRingWakeMode: TerminalDisplayRingWakeMode,
  options?: {
    readonly fontFamily?: TerminalFontFamily;
    readonly perfTuning?: TerminalWorkerTuning;
    readonly theme?: TerminalTheme;
  },
): TerminalWorkerClient {
  // ── DOM setup ──────────────────────────────────────────────────────────────
  const gridCanvas = document.createElement('canvas');
  const selectionLayer = createSelectionLayer();

  const initialTheme = options?.theme ?? DEFAULT_TERMINAL_THEME;
  const initialFontFamily = options?.fontFamily ?? DEFAULT_TERMINAL_FONT;
  container.style.cssText = `position:relative;overflow:hidden;margin-inline:auto;background:${rgbCss(initialTheme.background)};touch-action:none`;
  // The worker already rasterizes at display density. CSS layout quantization
  // can otherwise make the compositor filter the completed canvas a second
  // time, even when its nominal CSS/backing ratio matches devicePixelRatio.
  gridCanvas.style.cssText =
    'position:absolute;left:0;top:0;display:block;pointer-events:none;image-rendering:pixelated';

  const predictionWriter = createPredictionFastPathWriter(predictionFastPath);
  const predictionState = createPredictionFastStateReader(predictionFastPath);
  // The existing authorization realm hosts Rust's synchronous capture owner.
  // No terminal grid or text is instantiated on main.
  let predictionCapture: PredictionCapture | null = null;
  let pendingPredictionFlush = 0;
  const predictionModelSnapshot: PredictionModelSnapshot = {
    armed: false,
    flags: 0,
    startCol: 0,
    cursorCol: 0,
    endCol: 0,
    opsRemaining: 0,
    cols: 0,
    throughInputSeq: 0,
  };
  // The selection layer sits last so its transparent text is above the painted
  // grid: the browser hit-tests it for drags, long-presses and the iOS callout,
  // and paints `::selection` over the glyphs beneath.
  // The link hover layer sits above both and passes every pointer event through.
  const linkHoverLayer = createLinkHoverLayer();
  container.replaceChildren(gridCanvas, selectionLayer.element, linkHoverLayer.element);

  const offscreenGrid = gridCanvas.transferControlToOffscreen();

  // ── Worker ─────────────────────────────────────────────────────────────────
  // Vite fingerprints this worker dependency and pins the resulting URL in
  // the content-hashed main bundle. This is an ABI boundary: the terminal and
  // transport workers share fixed SAB layouts and must roll out with their
  // matching main-thread client.
  const worker = new Worker(new URL('./terminal-worker.ts', import.meta.url), {
    type: 'module',
  });
  const profilingResyncControlEnabled = isTerminalPerfRecording();
  const forceDisplayResyncForProfiling = (): void => {
    if (!isReady || closing || terminated) return;
    worker.postMessage({ kind: 'profiling_force_display_resync' } satisfies WorkerCommand);
  };
  if (profilingResyncControlEnabled) {
    window.addEventListener(TERMINAL_PERF_FORCE_RESYNC_EVENT, forceDisplayResyncForProfiling);
  }
  const profilingGridConvergenceControl = (repair: boolean): Promise<PerfGridConvergenceResult> =>
    verifyGridConvergence(repair);
  const profilingDisplayRingBoundaryControl = (): Promise<PerfDisplayRingBoundarySnapshot> =>
    readDisplayRingBoundary();
  const profilingViewportReads = profilingResyncControlEnabled
    ? createProfilingViewportReadOwner(
        (complete) => getViewportText(complete),
        PERF_VIEWPORT_READ_TIMEOUT_MS,
      )
    : null;
  const profilingViewportTextControl = (): Promise<string> => {
    if (profilingViewportReads === null) {
      return Promise.reject(new Error('terminal profiling viewport query is disabled'));
    }
    if (!isReady || closing || terminated) {
      return Promise.reject(new Error('terminal worker is unavailable for a viewport read'));
    }
    return profilingViewportReads.read();
  };
  if (profilingResyncControlEnabled) {
    globalThis.__merkurTerminalPerfVerifyGridConvergence = profilingGridConvergenceControl;
    globalThis.__merkurTerminalPerfReadDisplayRingBoundary = profilingDisplayRingBoundaryControl;
    globalThis.__merkurTerminalPerfReadViewportText = profilingViewportTextControl;
  }

  // Graceful-shutdown handshake: close() posts shutdown and waits (bounded) for
  // the worker's shutdown_complete before terminate(), so renderer.destroy() and
  // timer teardown run instead of being discarded.
  let shutdownTimer: ReturnType<typeof setTimeout> | null = null;
  let closing = false;
  let terminated = false;
  let nextPerfGridConvergenceProbeId = 1;
  let pendingPerfGridConvergence: {
    readonly observationEpoch: number;
    readonly probeId: number;
    readonly repair: boolean;
    readonly promise: Promise<PerfGridConvergenceResult>;
    readonly resolve: (result: PerfGridConvergenceResult) => void;
    readonly reject: (error: Error) => void;
  } | null = null;
  let nextPerfDisplayRingBoundaryRequestId = 1;
  let pendingPerfDisplayRingBoundary: {
    readonly observationEpoch: number;
    readonly requestId: number;
    readonly timer: ReturnType<typeof setTimeout>;
    readonly promise: Promise<PerfDisplayRingBoundarySnapshot>;
    readonly resolve: (snapshot: PerfDisplayRingBoundarySnapshot) => void;
    readonly reject: (error: Error) => void;
  } | null = null;
  function finishShutdown(): void {
    if (terminated) return;
    terminated = true;
    if (shutdownTimer !== null) {
      clearTimeout(shutdownTimer);
      shutdownTimer = null;
    }
    predictionCapture?.close();
    predictionCapture = null;
    worker.terminate();
  }

  // ── Ready gate ─────────────────────────────────────────────────────────────
  let isReady = false;
  let workerReady: Extract<WorkerEvent, { kind: 'ready' }> | null = null;
  let pendingResize: Extract<WorkerCommand, { kind: 'resize' }> | null = null;
  let pendingFontUpdate: Extract<WorkerCommand, { kind: 'font_update' }> | null = null;
  let pendingFontFamilyUpdate: Extract<WorkerCommand, { kind: 'font_family_update' }> | null = null;
  let pendingThemeUpdate: Extract<WorkerCommand, { kind: 'theme_update' }> | null = null;
  let pendingPreeditUpdate: Extract<WorkerCommand, { kind: 'set_preedit' }> | null = null;
  let requestedFontSize = fontSize;
  let requestedLineHeight = lineHeight;
  let requestedFontFamilyKey = terminalFontFamilyKey(initialFontFamily);
  let requestedTheme = initialTheme;
  // Authentication may complete while this client is still installing WASM,
  // fonts, and the renderer. Keep one level-triggered epoch intent: only the
  // latest authenticated lineage matters, and it must be delivered once ready.
  const sessionEpochCommands = createSessionEpochCommandGate((command) =>
    worker.postMessage(command),
  );

  let lastCharWidth = 0;
  let lastCharHeight = 0;
  let lastBaseline = 0;
  // The grid whose pixels are on screen. Every consumer here — CSS geometry,
  // hit-testing, selection, text range — is asking about what is rendered, so
  // this only ever advances at the edge where the worker has actually painted
  // the new grid.
  let cols = 1;
  let rows = 1;
  // The grid last asked of the worker, kept apart from the rendered one purely
  // to drop repeat requests.
  let requestedCols = 1;
  let requestedRows = 1;
  // Pointer events can arrive at display refresh frequency. Reading layout in
  // each event forces style/layout work onto that input path, so retain the
  // latest explicit layout edge instead. Pointer/touch start and the existing
  // resize/refresh paths update it before any high-frequency motion.
  let containerLeft = 0;
  let containerTop = 0;
  let containerWidth = 0;
  let containerHeight = 0;
  // Last geometry actually written to the canvases. Every commit re-derives
  // the same numbers; only a real change may reach a style write or a backing
  // store assignment.
  let lastCssWidth = -1;
  let lastCssHeight = -1;
  let lastClampCharWidth = 0;
  const pointerGeometry: TerminalPointerGeometry = {
    containerLeft: 0,
    containerTop: 0,
    charWidth: 0,
    charHeight: 0,
    cols: 1,
    rows: 1,
  };

  // ── Mouse / selection state ────────────────────────────────────────────────
  let mouseMode = 0;
  // FIFO: the worker answers get_viewport_rows commands strictly in order, so
  // concurrent requesters (the selection layer, the accessibility mirror) each
  // get their own response.
  const viewportRowsCallbacks: Array<(text: string, wrapBits: Uint8Array) => void> = [];
  // Selection is the browser's job, and the layer that lets it do that is
  // mounted only while Shift is active: a selectable text layer and a custom
  // touch-gesture terminal cannot share the same pixels, and on desktop the
  // same gate preserves today's shift-overrides-mouse-reporting behaviour.
  let selectionEnabled = false;
  let selectionRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  // The grid changed under the mounted layer's rows. Held across a live
  // selection, which pins the rows, so they refresh once it collapses.
  let selectionLayerStale = false;
  // Grid position of the mouse press a selection drag is running from, or null
  // when no primary button is down. See the anchoring handlers below.
  let selectionDragCaret: CellPos | null = null;
  const mouseGesture = createMouseGestureOwner();
  // Last value handed to `onSelectionActive`.
  let selectionActiveReported = false;

  // ── Link state ─────────────────────────────────────────────────────────────
  // A link is resolved against one authoritative viewport read, fetched only
  // while a link modifier is held and discarded by the next applied frame.
  let linkViewport: LinkViewport | null = null;
  let linkViewportCurrent = false;
  let linkViewportInFlight = false;
  let urlMatcher: UrlMatcher | null = null;
  let urlMatcherRequested = false;
  let linkUnderlineColor = rgbCss(initialTheme.foreground);
  let linkModifierLatched = false;
  // Hardware Cmd/Ctrl as the last key or pointer event reported it.
  let linkModifierKeyHeld = false;
  // Last pointer position over the grid, so pressing the modifier with the
  // pointer at rest shows the link under it. Scalars, not an object: this is
  // written on every mouse move.
  let linkPointerInside = false;
  let linkPointerX = 0;
  let linkPointerY = 0;
  // The link a press landed on. It opens on release over the same link, which
  // is what a click is; dragging off cancels.
  let linkPress: { readonly pointerId: number; readonly url: string } | null = null;
  let linkTouch: { readonly identifier: number; readonly url: string } | null = null;
  // The last resolution, reused while the pointer stays in one cell of one read.
  let linkResolvedViewport: LinkViewport | null = null;
  let linkResolvedCell = -1;
  let linkResolvedMatcher: UrlMatcher | null = null;
  let linkResolvedHit: LinkHit | null = null;

  // ── Cursor position (for IME anchoring) ────────────────────────────────────
  let cursorCol = 0;
  let cursorRow = 0;
  let cursorVisible = false;
  let cursorRect: CursorRect | null = null;

  function recomputeCursorRect(): void {
    if (lastCharWidth === 0 || lastCharHeight === 0) {
      cursorRect = null;
      return;
    }
    const next: CursorRect = {
      x: cursorCol * lastCharWidth,
      y: cursorRow * lastCharHeight,
      w: lastCharWidth,
      h: lastCharHeight,
      col: cursorCol,
      row: cursorRow,
      visible: cursorVisible,
    };
    // Resize/layout paths recompute unconditionally; only notify on real
    // movement — each emission costs main-thread style writes (and, on the
    // EditContext tier, an IME bounds update).
    const prev = cursorRect;
    cursorRect = next;
    if (
      prev !== null &&
      prev.x === next.x &&
      prev.y === next.y &&
      prev.w === next.w &&
      prev.h === next.h &&
      prev.visible === next.visible
    ) {
      return;
    }
    callbacks.onCursorMove(next);
  }

  const mouseMotionDeduper = createPointerMotionDeduper();

  // Touch scroll
  let touchScrollLastY = 0;

  function recordFirstDisplayGate(
    accepted: boolean,
    frameFenceToken: number,
    currentFenceToken: number | null,
  ): void {
    if (!isTerminalPerfRecording()) return;
    const writer = mainPerfWriter();
    if (writer !== null) {
      emitFirstDisplayGate(
        writer,
        terminalPerfNowMs(),
        accepted,
        frameFenceToken,
        currentFenceToken ?? 0,
      );
    }
  }

  // ── Shared prediction fast lane ────────────────────────────────────────────
  function recordPredictionQueued(inputSeq: number): void {
    if (!isTerminalPerfRecording()) return;
    // A second writer over the same ring keeps its own private cursor and
    // publishes it to the shared header, which rewinds the reader and costs it
    // every main-thread record written since that writer last committed.
    const writer = mainPerfWriter();
    if (writer !== null) {
      emitInputSeqEvent(writer, PERF_KIND_PREDICTION_QUEUED, terminalPerfNowMs(), inputSeq);
    }
  }

  // ── Cell coordinate helpers ────────────────────────────────────────────────
  function refreshContainerBounds(): Pick<DOMRectReadOnly, 'width' | 'height'> {
    const rect = container.getBoundingClientRect();
    containerLeft = rect.left;
    containerTop = rect.top;
    containerWidth = rect.width;
    containerHeight = rect.height;
    pointerGeometry.containerLeft = rect.left;
    pointerGeometry.containerTop = rect.top;
    return rect;
  }

  function syncPointerGeometry(): TerminalPointerGeometry {
    pointerGeometry.charWidth = lastCharWidth;
    pointerGeometry.charHeight = lastCharHeight;
    pointerGeometry.cols = cols;
    pointerGeometry.rows = rows;
    return pointerGeometry;
  }

  function pixelToCell(clientX: number, clientY: number): CellPos {
    return terminalCellAtPoint(clientX, clientY, syncPointerGeometry());
  }

  /** The one cell the motion path hit-tests into; motion never allocates. */
  const motionCell: CellPos = { col: 0, row: 0 };
  /**
   * The one record motion reports are encoded in, and a view of it for each
   * length a record takes: `onMouseInput` is handed exactly the record's bytes,
   * and a subarray per report would be the allocation this avoids.
   */
  const motionRecord = new Uint8Array(MOUSE_RECORD_MAX_BYTES);
  const motionRecordViews: (Uint8Array | undefined)[] = [];
  /** The wheel path's own cell, so a notch never disturbs motion deduplication. */
  const wheelCell: CellPos = { col: 0, row: 0 };

  function pixelToCaret(clientX: number, clientY: number): CellPos {
    return terminalCaretAtPoint(clientX, clientY, syncPointerGeometry());
  }

  /**
   * One notch as a wheel record. The daemon reports it as a wheel button or,
   * on an alternate screen with alternate scroll, as cursor keys in whichever
   * cursor-key mode the application set; the mirrored bits here only decide
   * whether the wheel belongs to the application at all.
   */
  function sendScrollInput(deltaY: number, clientX: number, clientY: number): void {
    // Wheel events arrive at display rate while a shell owns the screen, so
    // only one the application asked for hit-tests, into a reused cell.
    if (!(mouseMode & MM_WHEEL)) return;
    terminalCellAtPointInto(clientX, clientY, syncPointerGeometry(), wheelCell);
    callbacks.onMouseInput(
      encodeWheelRecord(deltaY < 0 ? WHEEL_UP : WHEEL_DOWN, 0, 1, wheelCell.col, wheelCell.row),
    );
  }

  // ── Viewport reads (worker answers strictly in FIFO order) ─────────────────
  /** `watch`: the rows stay on screen, so ask for `viewport_stale` when they change. */
  function requestViewportRows(
    cb: (text: string, wrapBits: Uint8Array) => void,
    watch: boolean,
  ): boolean {
    if (!isReady) return false;
    viewportRowsCallbacks.push(cb);
    worker.postMessage({ kind: 'get_viewport_rows', watch } satisfies WorkerCommand);
    return true;
  }

  // ── Links ──────────────────────────────────────────────────────────────────
  /** Cmd on macOS, Ctrl elsewhere — both are accepted everywhere, as paste is. */
  function linkModifierHeld(e: { readonly metaKey: boolean; readonly ctrlKey: boolean }): boolean {
    return e.metaKey || e.ctrlKey;
  }

  function prepareLinkResolution(): void {
    if (!urlMatcherRequested) {
      urlMatcherRequested = true;
      // Loaded on first use: nothing on the login or first-paint path pays for
      // a URL grammar most sessions never reach for.
      void import('./terminal/url-matcher').then(
        (module) => {
          urlMatcher = module.createUrlMatcher();
          refreshLinkHover();
        },
        (error: unknown) => {
          urlMatcherRequested = false;
          logger.warn('url matcher failed to load', { error: String(error) });
        },
      );
    }
    if (linkViewportCurrent || linkViewportInFlight || !isReady) return;
    linkViewportInFlight = true;
    linkViewportCurrent = true;
    worker.postMessage({ kind: 'get_link_viewport' } satisfies WorkerCommand);
  }

  function linkAtPoint(clientX: number, clientY: number): LinkHit | null {
    if (linkViewport === null) return null;
    const cell = pixelToCell(clientX, clientY);
    const cellIndex = cell.row * linkViewport.cols + cell.col;
    // Pointer motion within one cell asks the same question of the same read.
    if (
      linkResolvedViewport === linkViewport &&
      linkResolvedCell === cellIndex &&
      linkResolvedMatcher === urlMatcher
    ) {
      return linkResolvedHit;
    }
    const hit = findLinkAt(linkViewport, cell.row, cell.col, callbacks.resolveLink, urlMatcher);
    // An OSC 8 cell that resolved to nothing may only be waiting for its
    // definition, which arrives without a new read; ask again next time.
    const awaitingDefinition = hit === null && (linkViewport.links[cellIndex] ?? 0) !== 0;
    linkResolvedViewport = awaitingDefinition ? null : linkViewport;
    linkResolvedCell = cellIndex;
    linkResolvedMatcher = urlMatcher;
    linkResolvedHit = hit;
    return hit;
  }

  function clearLinkHover(): void {
    if (!linkHoverLayer.isVisible()) return;
    linkHoverLayer.hide();
    container.style.cursor = '';
  }

  function updateLinkHover(modifierHeld: boolean): void {
    // Ctrl and Cmd are chord keys a terminal user presses constantly; with the
    // pointer off the grid there is nothing to point at, so no viewport read.
    if (!modifierHeld || !linkPointerInside || selectionLayer.isVisible()) {
      clearLinkHover();
      return;
    }
    // Fetched on the modifier edge, before any motion, so a pointer resting on
    // a link shows it and a click with no motion in between still resolves.
    prepareLinkResolution();
    const hit = linkAtPoint(linkPointerX, linkPointerY);
    if (hit === null) {
      clearLinkHover();
      return;
    }
    linkHoverLayer.show(
      hit,
      linkViewport?.cols ?? 0,
      lastCharWidth,
      lastCharHeight,
      linkUnderlineColor,
    );
    container.style.cursor = 'pointer';
  }

  /** Re-resolve the visible hover against newer inputs: a viewport or matcher. */
  function refreshLinkHover(): void {
    if (linkHoverLayer.isVisible() || linkModifierKeyHeld) updateLinkHover(linkModifierKeyHeld);
  }

  /**
   * The grid under the read changed. The read is dropped, not kept for display:
   * its ids and text name cells that may hold other output now, and a press
   * resolved against it would open a link no longer on screen. Re-read only
   * while the pointer is over the grid with the modifier held, where the
   * underline has to follow the output; a touch latch re-reads at the tap
   * instead, so a latch left set costs no read per change.
   */
  function invalidateLinkViewport(): void {
    linkViewport = null;
    linkViewportCurrent = false;
    if (linkModifierKeyHeld && linkPointerInside) prepareLinkResolution();
  }

  function openLink(url: string): void {
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  function setLinkModifierLatched(latched: boolean): void {
    linkModifierLatched = latched;
    if (latched) prepareLinkResolution();
  }

  // Pointer events carry their own modifiers; this covers pressing or releasing
  // the key with the pointer at rest.
  const onLinkModifierKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Meta' && e.key !== 'Control') return;
    linkModifierKeyHeld = linkModifierHeld(e);
    updateLinkHover(linkModifierKeyHeld);
  };
  const onLinkModifierBlur = (): void => {
    linkModifierKeyHeld = false;
    linkPress = null;
    clearLinkHover();
  };
  window.addEventListener('keydown', onLinkModifierKey);
  window.addEventListener('keyup', onLinkModifierKey);
  window.addEventListener('blur', onLinkModifierBlur);

  container.addEventListener('pointermove', (e: PointerEvent) => {
    if (e.pointerType === 'touch') return;
    linkPointerInside = true;
    linkPointerX = e.clientX;
    linkPointerY = e.clientY;
    linkModifierKeyHeld = linkModifierHeld(e);
    if (linkModifierKeyHeld || linkHoverLayer.isVisible()) updateLinkHover(linkModifierKeyHeld);
  });
  container.addEventListener('pointerleave', () => {
    linkPointerInside = false;
    clearLinkHover();
    // Re-entering at the same cell is a new hover the application must hear.
    mouseMotionDeduper.reset();
  });

  // ── Selection layer control ────────────────────────────────────────────────
  function applySelectionMetrics(): void {
    selectionLayer.setMetrics({
      charWidth: lastCharWidth,
      charHeight: lastCharHeight,
      cols,
      rows,
      fontSize: requestedFontSize,
    });
  }

  function unmountSelectionLayer(): void {
    if (selectionRefreshTimer !== null) {
      clearTimeout(selectionRefreshTimer);
      selectionRefreshTimer = null;
    }
    selectionLayer.hide();
    container.style.touchAction = 'none';
    notifySelectionActive(false);
  }

  // Mount and unmount are both reached from more than one path, and the panel's
  // focus policy hangs off this, so it is reported on change only.
  function notifySelectionActive(active: boolean): void {
    if (active === selectionActiveReported) return;
    selectionActiveReported = active;
    callbacks.onSelectionActive(active);
  }

  function mountSelectionLayer(text: string, wrapBits: Uint8Array): void {
    // Shift may have been released during the worker hop.
    if (!selectionEnabled) return;
    // No cell metrics yet means no way to place a row. Mounting anyway would
    // build a zero-width layer whose selection rectangles land nowhere.
    if (lastCharWidth <= 0 || lastCharHeight <= 0) return;
    applySelectionMetrics();
    selectionLayerStale = false;
    selectionLayer.show(text, wrapBits);
    // `touch-action` intersects down the ancestor chain, so the container's
    // `none` would suppress the long-press the layer exists to receive.
    container.style.touchAction = 'auto';
    // A drag already in flight: the button went down before this layer existed,
    // so the browser anchored it outside — one end of the viewport — and is
    // extending from there. Hand it the cell the press was actually on. A
    // gesture the application owns is left alone: it was reported at the press
    // and giving it a browser selection too is the very confusion this avoids.
    if (selectionDragCaret !== null && !mouseGesture.isApplication()) {
      selectionLayer.anchorSelectionAt(selectionDragCaret.row, selectionDragCaret.col);
    }
    notifySelectionActive(true);
  }

  function setSelectionEnabled(active: boolean): void {
    if (active === selectionEnabled) return;
    selectionEnabled = active;
    if (!active) {
      // A live selection outlives the gate. Releasing Shift the instant before
      // Cmd+C must not delete what is about to be copied; `selectionchange`
      // tears the layer down once the selection actually collapses.
      if (!selectionLayer.holdsSelection()) unmountSelectionLayer();
      return;
    }
    // Already mounted because a selection outlived the previous gate. Pressing
    // Shift again to extend it must not rebuild the rows underneath it.
    if (selectionLayer.isVisible()) return;
    if (!requestViewportRows(mountSelectionLayer, true)) selectionEnabled = false;
  }

  /**
   * Output repainted the canvas underneath the mounted layer. The worker says
   * so once per read (`viewport_stale`), so a stream of output re-reads at most
   * once per debounce window rather than once per frame.
   */
  function noteSelectionLayerStale(): void {
    if (!selectionLayer.isVisible()) return;
    selectionLayerStale = true;
    scheduleSelectionRefresh();
  }

  // Never mid-selection: a selection belongs to the screen it started on.
  function scheduleSelectionRefresh(): void {
    if (!selectionEnabled || selectionRefreshTimer !== null) return;
    selectionRefreshTimer = setTimeout(() => {
      selectionRefreshTimer = null;
      if (!selectionEnabled || selectionLayer.holdsSelection()) return;
      requestViewportRows(mountSelectionLayer, true);
    }, SELECTION_REFRESH_DEBOUNCE_MS);
  }

  // Fires for every selection anywhere in the document, so it must cost nothing
  // when the layer is not the thing that changed.
  const onDocumentSelectionChange = (): void => {
    if (!selectionLayer.isVisible() || selectionLayer.holdsSelection()) return;
    // The selection that pinned stale rows collapsed with Shift still held.
    if (selectionEnabled) {
      if (selectionLayerStale) scheduleSelectionRefresh();
      return;
    }
    unmountSelectionLayer();
  };
  document.addEventListener('selectionchange', onDocumentSelectionChange);

  /**
   * The user is selecting, so the application sees no mouse at all.
   *
   * Shift is read from the event rather than from the layer's mounted state
   * because that mount is deliberately late: the intent gate defers it 200 ms
   * and the viewport it needs costs a worker round trip on top. A press inside
   * that window reaches an application that tracks the mouse, which starts its
   * own selection underneath the browser's — two selections in vim, and the
   * application never sees the release either, because by the time it happens
   * the layer is up and swallowing it. Shift bypassing mouse reporting is also
   * what every other terminal does, so there is nothing to defer here.
   */
  function selectionOwnsMouse(e: { readonly shiftKey: boolean }): boolean {
    return e.shiftKey || selectionEnabled || selectionLayer.isVisible();
  }

  function sendMouseButtonEvent(e: PointerEvent, cell: CellPos, release: boolean): void {
    const button = recordButton(e.button);
    if (button === null) return;
    callbacks.onMouseInput(
      encodeMouseRecord(
        release ? MOUSE_ACTION_RELEASE : MOUSE_ACTION_PRESS,
        button,
        pointerMods(e),
        cell.col,
        cell.row,
      ),
    );
  }

  /** The button a drag reports, from `PointerEvent.buttons`, primary first. */
  function heldButton(buttons: number): MouseButton | null {
    if (buttons & 1) return MOUSE_BUTTON_LEFT;
    if (buttons & 4) return MOUSE_BUTTON_MIDDLE;
    if (buttons & 2) return MOUSE_BUTTON_RIGHT;
    return null;
  }

  /** The X10 button a DOM button reports as; the back and forward buttons have none. */
  function recordButton(domButton: number): MouseButton | null {
    if (domButton === 0) return MOUSE_BUTTON_LEFT;
    if (domButton === 1) return MOUSE_BUTTON_MIDDLE;
    if (domButton === 2) return MOUSE_BUTTON_RIGHT;
    return null;
  }

  function pointerMods(e: {
    readonly shiftKey: boolean;
    readonly altKey: boolean;
    readonly ctrlKey: boolean;
  }): number {
    return (
      (e.shiftKey ? KEY_MOD_SHIFT : 0) |
      (e.altKey ? KEY_MOD_ALT : 0) |
      (e.ctrlKey ? KEY_MOD_CTRL : 0)
    );
  }

  // ── Mouse selection anchoring ──────────────────────────────────────────────
  // Shift gates selection here, and Shift+mousedown is also the browser's own
  // "extend the current selection" gesture, so a drag left entirely to the
  // browser anchors at whatever base it was already holding — the caret from an
  // earlier click, or a position outside the layer that reads on screen as the
  // end of the viewport — and sweeps everything between there and the pointer
  // into the selection. Chromium refuses to extend out of the focused editing
  // surface at all, so the same drag selects nothing there instead. Every drag
  // therefore takes its anchor from the grid.
  //
  // Recorded on `pointerdown` because that is the event that knows the pointer
  // is a mouse, and applied on `mousedown` because the panel focuses the
  // editing surface from a bubbling `pointerdown` handler and moving focus
  // re-parks the browser's base: an anchor set before that focus is lost.
  // Primary button only — right-click over a live selection is how the Copy
  // menu is reached, and collapsing the selection under it would take that
  // away.
  const onWindowPointerRelease = (): void => {
    selectionDragCaret = null;
    // Bubbles after the container's handler, which opens a link released on
    // it; a release anywhere else abandons the press.
    linkPress = null;
    // Bubbles after the container's own `pointerup`, which has already reported
    // the release it owed. A `pointercancel` reaches only this one, and it is
    // the end of the gesture either way.
    mouseGesture.reset();
  };
  window.addEventListener('pointerup', onWindowPointerRelease);
  window.addEventListener('pointercancel', onWindowPointerRelease);

  container.addEventListener('mousedown', () => {
    if (selectionDragCaret === null || !selectionLayer.isVisible()) return;
    selectionLayer.anchorSelectionAt(selectionDragCaret.row, selectionDragCaret.col);
  });

  // ── Pointer events ─────────────────────────────────────────────────────────
  container.addEventListener('pointerdown', (e: PointerEvent) => {
    if (e.pointerType === 'touch') return;
    refreshContainerBounds();
    // A modified press on a link belongs to the link, whatever the application
    // is tracking; a modified press anywhere else is the application's as before.
    if (e.button === 0 && linkModifierHeld(e)) {
      const hit = linkAtPoint(e.clientX, e.clientY);
      if (hit !== null) {
        e.preventDefault();
        linkPress = { pointerId: e.pointerId, url: hit.url };
        return;
      }
    }
    // Recorded before the early return, because the layer may not be mounted
    // yet: pressing Shift and the button together beats the intent timer, and
    // the mount that follows lands mid-drag on a selection the browser already
    // anchored somewhere else.
    if (e.button === 0) selectionDragCaret = pixelToCaret(e.clientX, e.clientY);
    // With Shift down the selection owns the drag: capturing the pointer here
    // would take it away from the browser mid-gesture, and reporting it would
    // hand the application a selection of its own. The `mousedown` handler
    // above still runs, and gives that drag its anchor.
    if (!mouseGesture.press(selectionOwnsMouse(e))) return;
    container.setPointerCapture(e.pointerId);
    mouseMotionDeduper.reset();
    if (mouseMode & MM_CLICKS) {
      sendMouseButtonEvent(e, pixelToCell(e.clientX, e.clientY), false);
    }
  });

  container.addEventListener('pointermove', (e: PointerEvent) => {
    if (e.pointerType === 'touch') return;
    let button: MouseButton;
    if (container.hasPointerCapture(e.pointerId)) {
      // A drag whose press the application was told about.
      if (!(mouseMode & MM_DRAG) || !mouseGesture.isApplication()) return;
      const held = heldButton(e.buttons);
      if (held === null) return;
      button = held;
    } else {
      // Hover, for an application tracking every motion. A selection on
      // screen owns the pointer, so it is not reported under one.
      if (!(mouseMode & MM_HOVER) || e.buttons !== 0 || selectionLayer.isVisible()) return;
      button = MOUSE_BUTTON_NONE;
    }
    terminalCellAtPointInto(e.clientX, e.clientY, syncPointerGeometry(), motionCell);
    const mods = pointerMods(e);
    // One report per cell crossing, which is the protocol's resolution.
    if (!mouseMotionDeduper.shouldReport(motionCell, button | (mods << 2))) return;
    const length = encodeMouseRecordInto(
      motionRecord,
      MOUSE_ACTION_MOTION,
      button,
      mods,
      motionCell.col,
      motionCell.row,
    );
    let record = motionRecordViews[length];
    if (record === undefined) {
      record = motionRecord.subarray(0, length);
      motionRecordViews[length] = record;
    }
    callbacks.onMouseInput(record);
  });

  container.addEventListener('pointerup', (e: PointerEvent) => {
    if (e.pointerType === 'touch') return;
    const press = linkPress;
    if (press !== null && press.pointerId === e.pointerId) {
      linkPress = null;
      // Opened inside the release handler, which is the user activation a
      // popup blocker requires.
      if (linkAtPoint(e.clientX, e.clientY)?.url === press.url) openLink(press.url);
      return;
    }
    // Follows the press, not the modifier as it stands now: a gesture the
    // application was told about must be told how it ended.
    if (!mouseGesture.release()) return;
    if (mouseMode & MM_CLICKS) {
      sendMouseButtonEvent(e, pixelToCell(e.clientX, e.clientY), true);
    }
    mouseMotionDeduper.reset();
  });

  container.addEventListener('contextmenu', (e: MouseEvent) => {
    // macOS turns Ctrl+click into a context menu; on a link it is the link's.
    if (linkPress !== null) {
      e.preventDefault();
      return;
    }
    // Right-click Copy over a live selection is one of the things the layer
    // exists to provide, so forwarding the button to the application would
    // take the menu away exactly when it is useful.
    if (selectionOwnsMouse(e)) return;
    if (mouseMode & MM_CLICKS) {
      e.preventDefault();
      const cell = pixelToCell(e.clientX, e.clientY);
      callbacks.onMouseInput(
        encodeMouseRecord(
          MOUSE_ACTION_PRESS,
          MOUSE_BUTTON_RIGHT,
          pointerMods(e),
          cell.col,
          cell.row,
        ),
      );
    }
  });

  // ── Wheel event ────────────────────────────────────────────────────────────
  container.addEventListener(
    'wheel',
    (e: WheelEvent) => {
      // Still swallowed from the page, never forwarded: scrolling an
      // application's buffer out from under a selection the user is dragging
      // across it is the same confusion a reported press causes, and there is
      // no local scrollback here for Shift+wheel to move instead.
      e.preventDefault();
      if (selectionOwnsMouse(e)) return;
      sendScrollInput(e.deltaY, e.clientX, e.clientY);
    },
    { passive: false },
  );

  // ── Touch events ───────────────────────────────────────────────────────────
  container.addEventListener(
    'touchstart',
    (e: TouchEvent) => {
      // Selection mode hands the finger to the browser: long-press, handles,
      // magnifier and the iOS Copy callout are all default behaviour, and
      // preventing it here is exactly what suppressed them before.
      if (selectionLayer.isVisible()) return;
      e.preventDefault();
      refreshContainerBounds();

      if (e.touches.length === 2) {
        const firstTouch = e.touches.item(0);
        const secondTouch = e.touches.item(1);
        if (!firstTouch || !secondTouch) return;
        touchScrollLastY = (firstTouch.clientY + secondTouch.clientY) / 2;
      } else if (e.touches.length === 1) {
        const touch = e.touches.item(0);
        if (!touch) return;
        linkTouch = null;
        if (linkModifierLatched) {
          // Decided on the last read and confirmed on release against the one
          // this tap fetches, so output that moved in between cannot open a
          // link the finger is no longer on.
          prepareLinkResolution();
          const hit = linkAtPoint(touch.clientX, touch.clientY);
          if (hit !== null) {
            linkTouch = { identifier: touch.identifier, url: hit.url };
            return;
          }
        }
        if (!(mouseMode & MM_CLICKS)) return;
        const cell = pixelToCell(touch.clientX, touch.clientY);
        callbacks.onMouseInput(
          encodeMouseRecord(MOUSE_ACTION_PRESS, MOUSE_BUTTON_LEFT, 0, cell.col, cell.row),
        );
      }
    },
    { passive: false },
  );

  container.addEventListener(
    'touchmove',
    (e: TouchEvent) => {
      if (selectionLayer.isVisible()) return;
      e.preventDefault();
      if (e.touches.length === 2) {
        const firstTouch = e.touches.item(0);
        const secondTouch = e.touches.item(1);
        if (!firstTouch || !secondTouch) return;
        const midY = (firstTouch.clientY + secondTouch.clientY) / 2;
        const deltaY = touchScrollLastY - midY;
        touchScrollLastY = midY;
        if (Math.abs(deltaY) > 1) {
          sendScrollInput(
            deltaY,
            containerLeft + containerWidth / 2,
            containerTop + containerHeight / 2,
          );
        }
      }
    },
    { passive: false },
  );

  container.addEventListener(
    'touchend',
    (e: TouchEvent) => {
      if (selectionLayer.isVisible()) return;
      e.preventDefault();
      const tap = linkTouch;
      if (tap === null) return;
      for (const touch of Array.from(e.changedTouches)) {
        if (touch.identifier !== tap.identifier) continue;
        linkTouch = null;
        if (linkAtPoint(touch.clientX, touch.clientY)?.url === tap.url) {
          openLink(tap.url);
          callbacks.onLinkActivated();
        }
      }
    },
    { passive: false },
  );

  // ── CSS dimension management ───────────────────────────────────────────────
  function updateCanvasCssDimensions(
    charWidth: number,
    charHeight: number,
    baseline = lastBaseline,
  ): void {
    lastCharWidth = charWidth;
    lastCharHeight = charHeight;
    lastBaseline = baseline;
    const w = cols * charWidth;
    const h = rows * charHeight;
    refreshContainerBounds();
    mouseMotionDeduper.reset();
    // The column clamp is a layout property of the container, not an offset
    // applied to the canvas. Below the clamp the container is exactly as wide
    // as the viewport allows and the grid starts at its origin; above it the
    // container centres itself and the grid still starts at its origin. The
    // grid therefore cannot move while only the container's width changes,
    // which is what made contents jitter through a window drag. Only the cell
    // metrics can move this bound, so it is not rewritten per resize.
    if (charWidth !== lastClampCharWidth) {
      lastClampCharWidth = charWidth;
      container.style.maxWidth = `${MAX_TERMINAL_COLUMNS * charWidth}px`;
    }
    // Each style write invalidates layout. A commit that did not move the grid
    // must cost nothing.
    if (w !== lastCssWidth || h !== lastCssHeight) {
      lastCssWidth = w;
      lastCssHeight = h;
      gridCanvas.style.width = `${w}px`;
      gridCanvas.style.height = `${h}px`;
    }
    applySelectionMetrics();
    recomputeCursorRect();
  }

  // ── Flush pending after ready ──────────────────────────────────────────────
  function flushPendingCommands(): void {
    isReady = true;
    sessionEpochCommands.markReady();
    if (pendingFontUpdate !== null) {
      worker.postMessage(pendingFontUpdate);
      pendingFontUpdate = null;
    }
    if (pendingFontFamilyUpdate !== null) {
      worker.postMessage(pendingFontFamilyUpdate);
      pendingFontFamilyUpdate = null;
    }
    if (pendingThemeUpdate !== null) {
      worker.postMessage(pendingThemeUpdate);
      pendingThemeUpdate = null;
    }
    if (pendingResize !== null) {
      worker.postMessage(pendingResize);
      pendingResize = null;
    }
    if (pendingPreeditUpdate !== null) {
      worker.postMessage(pendingPreeditUpdate);
      pendingPreeditUpdate = null;
    }
    requestWorkerHealth();
  }

  function requestWorkerHealth(): void {
    if (!isReady) return;
    worker.postMessage({ kind: 'worker_health_check' } satisfies WorkerCommand);
  }

  function finishReady(): void {
    const ready = workerReady;
    if (closing || isReady || ready === null || predictionCapture === null) return;
    cols = ready.cols;
    rows = ready.rows;
    requestedCols = ready.cols;
    requestedRows = ready.rows;
    updateCanvasCssDimensions(ready.charWidth, ready.charHeight, ready.baseline);
    flushPendingCommands();
    callbacks.onReady(ready.cols, ready.rows, ready.charWidth, ready.charHeight);
  }

  void loadE2eWasmModule()
    .then((runtime) => {
      if (closing || terminated) return;
      predictionCapture = new PredictionCapture(runtime.memory, predictionState);
      predictionCapture.flush(pendingPredictionFlush);
      pendingPredictionFlush = 0;
      finishReady();
    })
    .catch((error: unknown) => {
      if (closing || terminated) return;
      callbacks.onFatal(
        error instanceof Error ? error.message : 'Client WASM initialization failed',
      );
    });

  // ── Worker message handler ─────────────────────────────────────────────────
  // A refused message, a crash and an undeserializable message all end the
  // terminal: each is a contract or runtime failure, never a message to skip.
  const failWorker = (message: string): void => {
    if (closing || terminated) return;
    logger.error('terminal_worker_failed', { message });
    callbacks.onFatal(message);
  };
  worker.onerror = (event: ErrorEvent): void => {
    event.preventDefault();
    failWorker(`Terminal worker crashed: ${event.message || 'unknown worker error'}`);
  };
  worker.onmessageerror = (): void => {
    failWorker('Terminal worker failed to deserialize a message');
  };
  worker.onmessage = (e: MessageEvent<WorkerEvent>) => {
    const evt = e.data;
    if (evt.kind === 'shutdown_complete') {
      finishShutdown();
      return;
    }
    if (closing) return;
    if (evt.kind === 'ready') {
      workerReady = evt;
      finishReady();
    } else if (evt.kind === 'display_output_changed') {
      callbacks.onDisplayFrameReceived();
    } else if (evt.kind === 'display_output_settled') {
      callbacks.onDisplayOutputSettled();
    } else if (evt.kind === 'display_frame_applied') {
      callbacks.onDisplayFrameApplied(evt.displayKind);
    } else if (evt.kind === 'first_display_gpu_complete') {
      // The worker's epoch is the Rust session's lineage; the fence token is the
      // identity main and the worker both take from the transport.
      const currentFenceToken = sessionEpochCommands.currentFenceToken();
      const accepted = evt.frameFenceToken === currentFenceToken;
      recordFirstDisplayGate(accepted, evt.frameFenceToken, currentFenceToken);
      if (accepted) callbacks.onFirstDisplayGpuComplete(evt.displayKind);
    } else if (evt.kind === 'display_state_ready') {
      // "Ready" is advance notice from the worker, not a committed main-thread
      // layout edge. Keep the dimensions that currently own the CSS canvas
      // until the matching frame has actually been applied.
      callbacks.onDisplayStateReady(evt.cols, evt.rows);
    } else if (evt.kind === 'display_state_applied') {
      const dimensionsChanged = evt.cols !== cols || evt.rows !== rows;
      const metricsChanged =
        evt.charWidth !== lastCharWidth ||
        evt.charHeight !== lastCharHeight ||
        evt.baseline !== lastBaseline;
      cols = evt.cols;
      rows = evt.rows;
      if (dimensionsChanged || metricsChanged) {
        // The worker resized the OffscreenCanvas backing store before painting
        // this frame. Commit the matching CSS geometry at the same semantic
        // edge so the browser never stretches or clips it using an older grid.
        updateCanvasCssDimensions(evt.charWidth, evt.charHeight, evt.baseline);
        if (metricsChanged) callbacks.onMetrics(evt.charWidth, evt.charHeight);
        callbacks.onDisplayStateApplied();
      }
    } else if (evt.kind === 'display_snapshot_request') {
      callbacks.onDisplaySnapshotRequest();
    } else if (evt.kind === 'worker_health') {
      callbacks.onWorkerHealth(evt.diagnostics);
    } else if (evt.kind === 'perf_grid_convergence_result') {
      const pending = pendingPerfGridConvergence;
      if (
        pending !== null &&
        evt.observationEpoch === pending.observationEpoch &&
        evt.probeId === pending.probeId
      ) {
        pendingPerfGridConvergence = null;
        pending.resolve(evt);
      }
    } else if (evt.kind === 'perf_display_ring_boundary') {
      const pending = pendingPerfDisplayRingBoundary;
      if (
        pending !== null &&
        evt.observationEpoch === pending.observationEpoch &&
        evt.requestId === pending.requestId
      ) {
        clearTimeout(pending.timer);
        pendingPerfDisplayRingBoundary = null;
        pending.resolve(evt);
      }
    } else if (evt.kind === 'display_diag') {
      // Worker display state transitions — the daemon log cannot see
      // these (it only observes ACKs stopping); keep them in the console
      // so display stalls are diagnosable from a screenshot.
      logger.warn('terminal_display_diag', {
        event: evt.event,
        detail: evt.detail,
      });
    } else if (evt.kind === 'fatal') {
      logger.error('terminal_worker_fatal', {
        message: evt.message,
      });
      callbacks.onFatal(evt.message);
    } else if (evt.kind === 'mouse_mode_changed') {
      const wasMouseOn = (mouseMode & MM_CLICKS) !== 0;
      const raisedReports = evt.mode & ~mouseMode & TERMINAL_MODE_INPUT_REPORTS;
      mouseMode = evt.mode;
      if (raisedReports !== 0) callbacks.onInputReportsRaised();
      mouseMotionDeduper.reset();
      const isMouseOn = (mouseMode & MM_CLICKS) !== 0;
      if (!wasMouseOn && isMouseOn) {
        setSelectionEnabled(false);
      }
    } else if (evt.kind === 'viewport_rows_result') {
      const cb = viewportRowsCallbacks.shift();
      cb?.(evt.text, evt.wrapBits);
    } else if (evt.kind === 'link_viewport_result') {
      linkViewportInFlight = false;
      linkViewport = evt.cols === 0 ? null : evt;
      refreshLinkHover();
    } else if (evt.kind === 'viewport_stale') {
      // The grid the reads kept on screen describe changed underneath them.
      // This is the honest edge for that: the cursor does not move for every
      // repaint, so watching cursor position would miss output entirely.
      invalidateLinkViewport();
      noteSelectionLayerStale();
    } else if (evt.kind === 'cursor_position') {
      cursorCol = evt.col;
      cursorRow = evt.row;
      cursorVisible = evt.visible;
      recomputeCursorRect();
    }
  };

  // ── Send init ──────────────────────────────────────────────────────────────
  const initialViewportRect = refreshContainerBounds();

  worker.postMessage(
    {
      kind: 'init',
      viewportWidth: initialViewportRect.width,
      viewportHeight: initialViewportRect.height,
      gridCanvas: offscreenGrid,
      fontFamily: initialFontFamily,
      fontSize,
      lineHeight,
      theme: initialTheme,
      devicePixelRatio: window.devicePixelRatio || 1,
      perfEnabled: isTerminalPerfRecording(),
      ...(options?.perfTuning === undefined ? {} : { perfTuning: options.perfTuning }),
      perfRing: terminalPerfRing,
      frameRing,
      viewerOutputRing,
      predictionAdmission,
      predictionFastPath,
      presentationCadence,
      displayReceiverProfile,
      ringWakePort,
      displayRingWakeMode,
    } satisfies WorkerCommand,
    [offscreenGrid, ringWakePort],
  );

  // Initial display environment (covers mounting while hidden) plus a
  // re-armed DPR media query: zoom or a monitor move changes the DPR without
  // necessarily resizing the container. The worker replaces its raster metrics
  // and recalibrates presentation cadence from that same environment edge.
  let dprMedia: MediaQueryList | null = null;
  function postDisplayEnv(visible: boolean): void {
    worker.postMessage({
      kind: 'display_env',
      visible,
      devicePixelRatio: window.devicePixelRatio || 1,
    } satisfies WorkerCommand);
  }
  function onDprChange(): void {
    postDisplayEnv(document.visibilityState === 'visible');
    armDprListener();
  }
  function armDprListener(): void {
    dprMedia?.removeEventListener('change', onDprChange);
    dprMedia = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    dprMedia.addEventListener('change', onDprChange);
  }
  postDisplayEnv(document.visibilityState === 'visible');
  armDprListener();

  // ── Public API ─────────────────────────────────────────────────────────────

  function resize(nextCols: number, nextRows: number): void {
    const dimensions = clampTerminalDimensions(nextCols, nextRows);
    nextCols = dimensions.columns;
    nextRows = dimensions.rows;
    // A repeat request is a true no-op. This used to reassert the CSS geometry
    // on every commit, because an applied frame could publish the daemon's
    // dimensions over the viewport's; the worker now restores the
    // controlling viewport grid as each frame applies (observers retain the
    // canonical grid), so there is nothing to walk
    // back and nothing to rewrite.
    if (nextCols === requestedCols && nextRows === requestedRows) return;
    requestedCols = nextCols;
    requestedRows = nextRows;
    // Deliberately no CSS write here. Sizing the canvas to a grid the worker
    // has not painted yet asks the browser to scale the old pixels into the
    // new box, and a display frame already in flight then applies at the old
    // grid and writes that size back — so the canvas went new, old, new for a
    // single resize. It now changes exactly once, at the edge where the
    // matching pixels exist.
    const cmd: Extract<WorkerCommand, { kind: 'resize' }> = {
      kind: 'resize',
      cols: nextCols,
      rows: nextRows,
    };
    if (!isReady) {
      pendingResize = cmd;
      return;
    }
    worker.postMessage(cmd);
  }

  function refreshLayout(): void {
    if (lastCharWidth > 0 && lastCharHeight > 0) {
      // This path exists to repair a surface that may have been dropped while
      // the page was hidden, so it must defeat the unchanged-geometry guard
      // rather than be skipped by it.
      lastCssWidth = -1;
      updateCanvasCssDimensions(lastCharWidth, lastCharHeight);
    }
  }

  function refreshRender(): void {
    if (!isReady) return;
    worker.postMessage({ kind: 'render_refresh' } satisfies WorkerCommand);
  }

  function updateFont(nextFontSize: number, nextLineHeight: number): void {
    if (nextFontSize === requestedFontSize && nextLineHeight === requestedLineHeight) return;
    requestedFontSize = nextFontSize;
    requestedLineHeight = nextLineHeight;
    const cmd: Extract<WorkerCommand, { kind: 'font_update' }> = {
      kind: 'font_update',
      fontSize: nextFontSize,
      lineHeight: nextLineHeight,
    };
    if (!isReady) {
      pendingFontUpdate = cmd;
      return;
    }
    worker.postMessage(cmd);
  }

  function updateFontFamily(fontFamily: TerminalFontFamily): void {
    const key = terminalFontFamilyKey(fontFamily);
    if (key === requestedFontFamilyKey) return;
    requestedFontFamilyKey = key;
    const cmd: Extract<WorkerCommand, { kind: 'font_family_update' }> = {
      kind: 'font_family_update',
      fontFamily,
    };
    if (!isReady) {
      pendingFontFamilyUpdate = cmd;
      return;
    }
    worker.postMessage(cmd);
  }

  function updateTheme(theme: TerminalTheme): void {
    if (theme === requestedTheme) return;
    requestedTheme = theme;
    container.style.background = rgbCss(theme.background);
    linkUnderlineColor = rgbCss(theme.foreground);
    const cmd: Extract<WorkerCommand, { kind: 'theme_update' }> = {
      kind: 'theme_update',
      theme,
    };
    if (!isReady) {
      pendingThemeUpdate = cmd;
      return;
    }
    worker.postMessage(cmd);
  }

  function close(): void {
    if (closing || terminated) return;
    closing = true;
    isReady = false;
    if (profilingResyncControlEnabled) {
      window.removeEventListener(TERMINAL_PERF_FORCE_RESYNC_EVENT, forceDisplayResyncForProfiling);
    }
    if (globalThis.__merkurTerminalPerfVerifyGridConvergence === profilingGridConvergenceControl) {
      globalThis.__merkurTerminalPerfVerifyGridConvergence = undefined;
    }
    if (
      globalThis.__merkurTerminalPerfReadDisplayRingBoundary === profilingDisplayRingBoundaryControl
    ) {
      globalThis.__merkurTerminalPerfReadDisplayRingBoundary = undefined;
    }
    if (globalThis.__merkurTerminalPerfReadViewportText === profilingViewportTextControl) {
      globalThis.__merkurTerminalPerfReadViewportText = undefined;
    }
    pendingPerfGridConvergence?.reject(new Error('terminal worker closed during grid convergence'));
    pendingPerfGridConvergence = null;
    profilingViewportReads?.close(new Error('terminal worker closed during viewport read'));
    if (pendingPerfDisplayRingBoundary !== null) {
      clearTimeout(pendingPerfDisplayRingBoundary.timer);
      pendingPerfDisplayRingBoundary.reject(
        new Error('terminal worker closed during display-ring boundary read'),
      );
      pendingPerfDisplayRingBoundary = null;
    }
    document.removeEventListener('selectionchange', onDocumentSelectionChange);
    window.removeEventListener('keydown', onLinkModifierKey);
    window.removeEventListener('keyup', onLinkModifierKey);
    window.removeEventListener('blur', onLinkModifierBlur);
    clearLinkHover();
    window.removeEventListener('pointerup', onWindowPointerRelease);
    window.removeEventListener('pointercancel', onWindowPointerRelease);
    selectionEnabled = false;
    unmountSelectionLayer();
    selectionLayer.destroy();
    // Nothing will answer these now; leaving them queued strands their callers
    // and desynchronizes the FIFO if the client is ever revived.
    viewportRowsCallbacks.length = 0;
    predictionWriter.wake();
    dprMedia?.removeEventListener('change', onDprChange);
    dprMedia = null;
    worker.postMessage({ kind: 'shutdown' } satisfies WorkerCommand);
    // Wait (bounded) for the worker's shutdown_complete ack so renderer.destroy()
    // and timer teardown actually run before terminate() discards the worker.
    shutdownTimer = setTimeout(finishShutdown, WORKER_SHUTDOWN_GRACE_MS);
  }

  function getViewportText(cb: (text: string) => void): boolean {
    // The mirror announces rows and skips empty ones, so it wants the blank
    // tail gone. `viewport_rows` deliberately keeps it for selection, which is
    // the one caller that must be able to copy the spaces it dragged over.
    return requestViewportRows((text) => {
      cb(
        text
          .split('\n')
          .map((row) => row.replace(/ +$/u, ''))
          .join('\n'),
      );
    }, false);
  }

  let requestedPreeditText = '';
  let requestedPreeditCaret = 0;
  function setPreedit(text: string, caret: number): void {
    if (text === requestedPreeditText && (text.length === 0 || caret === requestedPreeditCaret)) {
      return;
    }
    requestedPreeditText = text;
    requestedPreeditCaret = caret;
    const command = {
      kind: 'set_preedit',
      text,
      caret,
    } satisfies WorkerCommand;
    if (!isReady) {
      // A clear before initialization cancels any queued composition because
      // the fresh terminal already starts with an empty preedit.
      pendingPreeditUpdate = text.length === 0 ? null : command;
      return;
    }
    worker.postMessage(command);
  }

  function isAltScreenActive(): boolean {
    return (mouseMode & MM_ALTSCR) !== 0;
  }

  function terminalMode(): number {
    return mouseMode;
  }

  function isPredictionSafe(): boolean {
    return isShadowModelInputSafe(mouseMode, cursorVisible, requestedPreeditText.length > 0);
  }

  function previewPrintable(pointerId: number, codepoint: number): boolean {
    if (
      !isReady ||
      !predictionWriter.epochReady() ||
      !isPredictionSafe() ||
      !predictionState.visible()
    )
      return false;
    if (
      !Number.isSafeInteger(pointerId) ||
      pointerId < 0 ||
      !Number.isInteger(codepoint) ||
      codepoint < 0x20 ||
      codepoint > 0x7e
    )
      return false;
    const modelVersion = predictionState.readModelInto(predictionModelSnapshot);
    const epoch = predictionState.activeEpoch();
    if (modelVersion === 0 || epoch === 0 || !predictionModelSnapshot.armed) return false;
    return predictionWriter.writeProvisional(pointerId, codepoint, epoch, modelVersion);
  }

  function clearProvisionalPrintable(pointerId: number): void {
    if (!isReady || !Number.isSafeInteger(pointerId) || pointerId < 0) return;
    const epoch = predictionState.activeEpoch();
    if (epoch === 0) return;
    // Revocation must not gate clearing an already displayed pointer preview.
    predictionWriter.writeProvisional(pointerId, null, epoch, 0);
  }

  /**
   * Decide wire-level shadow provenance for one input, synchronously.
   *
   * Refreshes from the published snapshot only once the worker has drained
   * every input this thread has already issued; otherwise the snapshot is
   * behind main's own projection and adopting it would double-count ops still
   * in flight. Between refreshes, main advances the projection itself, which is
   * what makes key N+1 of a burst admissible before the worker has processed
   * key N.
   */
  function admitPredictionOp(op: CaptureOp, inputSeq: number): boolean {
    return predictionCapture?.prepare(op, inputSeq) ?? false;
  }

  function predictPrintable(inputSeq: number, codepoint: number, sentAtMs: number): boolean {
    if (!isReady || !predictionWriter.epochReady()) return false;
    const admitted = admitPredictionOp(CAPTURE_PRINTABLE, inputSeq);
    // Latch this input's visibility admission once; the worker remains the only painter.
    const queued = predictionWriter.writePrintable(
      inputSeq,
      codepoint,
      sentAtMs,
      predictionState.visible(),
    );
    if (!queued) {
      predictionCapture?.invalidate();
      return false;
    }
    recordPredictionQueued(inputSeq);
    return admitted;
  }

  function predictBackspace(inputSeq: number, sentAtMs: number): boolean {
    if (!isReady || !predictionWriter.epochReady()) return false;
    const admitted = admitPredictionOp(CAPTURE_BACKSPACE, inputSeq);
    const queued = predictionWriter.writeBackspace(inputSeq, sentAtMs);
    if (!queued) {
      predictionCapture?.invalidate();
      return false;
    }
    recordPredictionQueued(inputSeq);
    return admitted;
  }

  function predictDelete(inputSeq: number, sentAtMs: number): boolean {
    if (!isReady || !predictionWriter.epochReady()) return false;
    const admitted = admitPredictionOp(CAPTURE_DELETE, inputSeq);
    const queued = predictionWriter.writeDelete(inputSeq, sentAtMs);
    if (!queued) {
      predictionCapture?.invalidate();
      return false;
    }
    recordPredictionQueued(inputSeq);
    return admitted;
  }

  function predictCursorShift(inputSeq: number, delta: number, sentAtMs: number): boolean {
    if (!isReady || !predictionWriter.epochReady() || (delta !== -1 && delta !== 1)) return false;
    const op = delta === -1 ? CAPTURE_LEFT : CAPTURE_RIGHT;
    const admitted = admitPredictionOp(op, inputSeq);
    const queued = predictionWriter.writeCursorShift(inputSeq, delta, sentAtMs);
    if (!queued) {
      predictionCapture?.invalidate();
      return false;
    }
    recordPredictionQueued(inputSeq);
    return admitted;
  }

  function flushPredictions(inputSeq?: number): void {
    // A flush rotates the shadow epoch. Main cannot model the re-seed, so the
    // projection is dropped until the worker republishes.
    if (predictionCapture === null) {
      pendingPredictionFlush = Math.max(pendingPredictionFlush, inputSeq ?? 0) >>> 0;
    } else predictionCapture.flush(inputSeq);
    if (!isReady || !predictionWriter.epochReady()) return;
    predictionWriter.writeFlush(inputSeq);
  }

  function updateRtt(rttMs: number): void {
    if (!isReady) return;
    worker.postMessage({ kind: 'rtt_sample', rttMs } satisfies WorkerCommand);
  }

  // Deliberately not gated on isReady: the worker handles display_env
  // order-safely and commands are processed in order regardless.
  function updateDisplayEnv(visible: boolean): void {
    if (visible) notifyDisplayAvailable();
    postDisplayEnv(visible);
  }

  function notifyDisplayAvailable(): void {
    if (closing || terminated) return;
    // All three are recovery: the native notify a suspended WebKit worker may
    // have lost, the prediction consumer's, and a real worker task for the
    // arm that parks on one.
    wakeFrameRingReader(frameRing);
    predictionWriter.wake();
    worker.postMessage({ kind: 'display_available' } satisfies WorkerCommand);
  }

  function resetSrtt(): void {
    if (!isReady) return;
    worker.postMessage({ kind: 'srtt_reset' } satisfies WorkerCommand);
  }

  function verifyGridConvergence(repair: boolean): Promise<PerfGridConvergenceResult> {
    if (typeof repair !== 'boolean') {
      return Promise.reject(new TypeError('terminal grid convergence repair policy is required'));
    }
    if (!isReady || closing || terminated || !profilingResyncControlEnabled) {
      return Promise.reject(new Error('terminal grid convergence probe is not ready'));
    }
    if (pendingPerfGridConvergence !== null) {
      return pendingPerfGridConvergence.repair === repair
        ? pendingPerfGridConvergence.promise
        : Promise.reject(new Error('terminal grid convergence probe policy is already active'));
    }
    const probeId = nextPerfGridConvergenceProbeId;
    nextPerfGridConvergenceProbeId = (nextPerfGridConvergenceProbeId + 1) >>> 0;
    if (nextPerfGridConvergenceProbeId === 0) nextPerfGridConvergenceProbeId = 1;
    let resolve!: (result: PerfGridConvergenceResult) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<PerfGridConvergenceResult>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const observationEpoch = terminalPerfObservationEpoch();
    pendingPerfGridConvergence = { observationEpoch, probeId, repair, promise, resolve, reject };
    worker.postMessage({
      kind: 'profiling_verify_grid_convergence',
      observationEpoch,
      probeId,
      repair,
    } satisfies WorkerCommand);
    return promise;
  }

  function readDisplayRingBoundary(): Promise<PerfDisplayRingBoundarySnapshot> {
    if (!isReady || closing || terminated || !profilingResyncControlEnabled) {
      return Promise.reject(new Error('terminal display-ring boundary reader is not ready'));
    }
    if (pendingPerfDisplayRingBoundary !== null) {
      return Promise.reject(new Error('terminal display-ring boundary read is already active'));
    }
    const requestId = nextPerfDisplayRingBoundaryRequestId;
    nextPerfDisplayRingBoundaryRequestId = (nextPerfDisplayRingBoundaryRequestId + 1) >>> 0;
    if (nextPerfDisplayRingBoundaryRequestId === 0) nextPerfDisplayRingBoundaryRequestId = 1;
    const observationEpoch = terminalPerfObservationEpoch();
    let resolve!: (snapshot: PerfDisplayRingBoundarySnapshot) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<PerfDisplayRingBoundarySnapshot>(
      (resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
      },
    );
    const timer = setTimeout(() => {
      const pending = pendingPerfDisplayRingBoundary;
      if (
        pending === null ||
        pending.observationEpoch !== observationEpoch ||
        pending.requestId !== requestId
      ) {
        return;
      }
      pendingPerfDisplayRingBoundary = null;
      pending.reject(new Error('terminal display-ring boundary read timed out'));
    }, PERF_DISPLAY_RING_BOUNDARY_TIMEOUT_MS);
    pendingPerfDisplayRingBoundary = {
      observationEpoch,
      requestId,
      timer,
      promise,
      resolve,
      reject,
    };
    worker.postMessage({
      kind: 'profiling_read_display_ring_boundary',
      observationEpoch,
      requestId,
    } satisfies WorkerCommand);
    return promise;
  }

  function notifySessionEpoch(displayRingFenceToken: number | null): void {
    // Fence the SAB lane before posting the semantic epoch command. Until the
    // worker adopts this required epoch, prediction fails closed while ordinary
    // input continues over the transport ring.
    predictionWriter.beginEpoch();
    predictionCapture?.reset();
    pendingPredictionFlush = 0;
    sessionEpochCommands.notify(displayRingFenceToken);
  }

  return {
    resize,
    refreshLayout,
    refreshRender,
    updateFont,
    updateFontFamily,
    updateTheme,
    setSelectionEnabled,
    setLinkModifierLatched,
    getViewportText,
    setPreedit,
    isAltScreenActive,
    isPredictionSafe,
    terminalMode,
    previewPrintable,
    clearProvisionalPrintable,
    predictPrintable,
    predictBackspace,
    predictDelete,
    predictCursorShift,
    flushPredictions,
    updateRtt,
    resetSrtt,
    updateDisplayEnv,
    notifyDisplayAvailable,
    requestHealth: requestWorkerHealth,
    verifyGridConvergence,
    readDisplayRingBoundary,
    notifySessionEpoch,
    close,
  };
}
