// Types of the main ↔ terminal-worker control channel. Both ends are one build,
// so the types are the whole contract. Terminal display frames and ACKs stay on
// the SAB data plane.

import type { TerminalFontFamily } from './terminal/fonts';
import type { TerminalDisplayRingWakeMode } from './terminal/runtime-policy';
import type { TerminalTheme } from './terminal/themes';

/**
 * Profiling-harness control surface. The main-thread client listens only while
 * terminal performance recording is active; the terminal worker independently
 * checks its latched `perfEnabled` bit before honoring the command.
 */
export const TERMINAL_PERF_FORCE_RESYNC_EVENT = 'merkur:terminal-perf-force-resync';

export interface TerminalWorkerTuning {
  readonly predictionTtlMs?: number;
  readonly altScreenPredictionTtlMs?: number;
  readonly pathRttEwmaAlpha?: number;
  readonly predictionRecentWindow?: number;
  readonly predictionLowRttMinVisibleRatio?: number;
  readonly predictionLowRttMinConsecutiveConfirmed?: number;
  readonly predictionCommandsPerSlice?: number;
  readonly displayProcessBudgetMs?: number;
}

export interface TerminalWorkerDiagnostics {
  readonly ready: boolean;
  readonly lastDisplayFrameAtMs: number | null;
  readonly lastSnapshotAtMs: number | null;
  readonly cols: number;
  readonly rows: number;
  readonly charWidth: number;
  readonly charHeight: number;
  readonly pixelWidth: number;
  readonly pixelHeight: number;
  readonly devicePixelRatio: number;
  readonly queuedDisplayFrames: number;
}

export type PerfGridConvergenceFailureReason = 'not-ready' | 'mismatch' | 'superseded' | 'timeout';

export interface PerfGridConvergenceResult {
  readonly observationEpoch: number;
  readonly probeId: number;
  readonly converged: boolean;
  readonly failureReason: PerfGridConvergenceFailureReason | null;
  readonly attempts: number;
  readonly selectiveRepairCount: number;
  readonly generation: number;
  readonly lastAdmittedDisplaySeq: number;
  readonly rows: number;
  readonly elapsedMs: number;
}

/**
 * Measurement-only snapshot of the display ingress ring's refusal counter.
 * The terminal worker owns both the timestamp and the SAB read, so a pair of
 * these records forms an exact boundary rather than inferring a baseline from
 * the first display pump that happened to run.
 */
export interface PerfDisplayRingBoundarySnapshot {
  readonly observationEpoch: number;
  readonly requestId: number;
  readonly sessionEpoch: number;
  readonly atMs: number;
  readonly ringDroppedTotal: number;
}

export type WorkerCommand =
  | {
      kind: 'init';
      viewportWidth: number;
      viewportHeight: number;
      gridCanvas: OffscreenCanvas;
      fontFamily: TerminalFontFamily;
      fontSize: number;
      lineHeight: number;
      theme: TerminalTheme;
      devicePixelRatio: number;
      perfEnabled: boolean;
      perfTuning?: TerminalWorkerTuning;
      /**
       * Profiling record ring, written by this worker and drained by the
       * telemetry worker. Always supplied; `perfEnabled` decides whether
       * anything is written to it.
       */
      perfRing: SharedArrayBuffer;
      frameRing: SharedArrayBuffer;
      /** This worker writes what its viewer asks the session to send; transport reads it. */
      viewerOutputRing: SharedArrayBuffer;
      predictionAdmission: SharedArrayBuffer;
      predictionFastPath: SharedArrayBuffer;
      /** This worker publishes measured presentation cadence here; transport reads it. */
      presentationCadence: SharedArrayBuffer;
      /** This worker publishes fused receiver-cost posterior samples here. */
      displayReceiverProfile: SharedArrayBuffer;
      /**
       * This worker's end of the worker-to-worker wake channel, transferred.
       * In `'task'` mode the transport worker posts a frame-ring edge on it and
       * this worker posts a viewer-output edge back. In both modes each worker
       * posts the rare allocation-free edges: room in a ring that had refused
       * an entry, and from this worker a quantized display-cadence change.
       */
      ringWakePort: MessagePort;
      /**
       * Resolved once on main; decides how this worker's frame reader parks,
       * and whether its viewer-output writer carries a task edge at all.
       */
      displayRingWakeMode: TerminalDisplayRingWakeMode;
    }
  | { kind: 'resize'; cols: number; rows: number }
  | { kind: 'font_update'; fontSize: number; lineHeight: number }
  | { kind: 'font_family_update'; fontFamily: TerminalFontFamily }
  | { kind: 'theme_update'; theme: TerminalTheme }
  | { kind: 'render_refresh' }
  | { kind: 'display_available' }
  // `watch`: the caller keeps these rows on screen, so the worker posts
  // `viewport_stale` on the next change to the grid.
  | { kind: 'get_viewport_rows'; watch: boolean }
  | { kind: 'get_link_viewport' }
  | { kind: 'rtt_sample'; rttMs: number }
  | { kind: 'srtt_reset' }
  // A session (re)authenticated: the worker fences its prediction state. The
  // epoch, fence token and display disposition are main's and the transport's
  // to track; nothing here reads them.
  | { kind: 'session_epoch' }
  | { kind: 'worker_health_check' }
  | { kind: 'profiling_force_display_resync' }
  | {
      kind: 'profiling_verify_grid_convergence';
      observationEpoch: number;
      probeId: number;
      /** Whether an exact hash mismatch may invoke selective row repair. */
      repair: boolean;
    }
  | {
      kind: 'profiling_read_display_ring_boundary';
      observationEpoch: number;
      requestId: number;
    }
  // Inline IME preedit: render the in-progress composition string at the
  // cursor through the WASM/WebGL overlay pipeline. Empty `text` clears it.
  | { kind: 'set_preedit'; text: string; caret: number }
  // Display environment signals for rasterization and refresh-rate calibration: page
  // visibility (suspends/resumes the calibration rAF chain) and live
  // devicePixelRatio (a change implies a possible monitor move).
  | { kind: 'display_env'; visible: boolean; devicePixelRatio: number }
  | { kind: 'shutdown' };

export type WorkerEvent =
  | {
      kind: 'ready';
      cols: number;
      rows: number;
      charWidth: number;
      charHeight: number;
      baseline: number;
    }
  // Display output notices, two per burst rather than one per frame: the
  // first applied frame of a burst, and the moment the output has been still
  // for the settle window (`terminal/display-output-settle.ts`). What the
  // screen-reader mirror and the first-frame status consume; they never
  // needed the per-frame identity the old `display_frame_received` carried.
  | { kind: 'display_output_changed' }
  | { kind: 'display_output_settled' }
  | { kind: 'display_state_ready'; cols: number; rows: number }
  | {
      kind: 'display_state_applied';
      cols: number;
      rows: number;
      charWidth: number;
      charHeight: number;
      baseline: number;
    }
  | {
      kind: 'display_frame_applied';
      generation: number;
      frameId: number;
      displayKind: 'display_snapshot' | 'display_delta';
    }
  | {
      /** Authoritative frame or confirmed retained grid reached this epoch's GPU fence. */
      kind: 'first_display_gpu_complete';
      sessionEpoch: number;
      /**
       * The transport's display-ring fence for this lineage. Main learns the
       * same token from the transport, so it names the epoch on both sides;
       * `sessionEpoch` is the Rust session's lineage, not main's command count.
       */
      frameFenceToken: number;
      generation: number;
      frameId: number;
      displayKind: 'display_snapshot' | 'display_delta' | 'display_resume';
    }
  | { kind: 'worker_health'; diagnostics: TerminalWorkerDiagnostics }
  | { kind: 'display_diag'; event: string; detail: string }
  | { kind: 'fatal'; message: string }
  | { kind: 'mouse_mode_changed'; mode: number }
  // Whole viewport as untrimmed rows joined by `\n`, plus one wrap bit per row
  // (LSB-first). Both the selection layer and the accessibility mirror read it.
  | { kind: 'viewport_rows_result'; text: string; wrapBits: Uint8Array }
  // The authoritative viewport as link resolution needs it: the text, its wrap
  // bits, the column of every text unit, and the OSC 8 link id of every cell,
  // all read from one grid in one turn.
  | {
      kind: 'link_viewport_result';
      cols: number;
      rows: number;
      text: string;
      wrapBits: Uint8Array;
      columns: Uint16Array;
      links: Uint32Array;
    }
  // The grid every watched read so far described has changed: the last
  // `link_viewport_result`, and any `viewport_rows_result` asked with `watch`.
  // Posted once, on the first change after such a read.
  | { kind: 'viewport_stale' }
  // Live cursor position in grid coords, posted coalesced (≤1/frame). The main
  // thread converts to CSS pixels to anchor the IME editing surface/overlay.
  | { kind: 'cursor_position'; col: number; row: number; visible: boolean }
  | { kind: 'display_snapshot_request' }
  | ({ kind: 'perf_grid_convergence_result' } & PerfGridConvergenceResult)
  | ({ kind: 'perf_display_ring_boundary' } & PerfDisplayRingBoundarySnapshot)
  // Posted once the worker's shutdown handler has run (renderer.destroy() and
  // timer teardown). Main waits for it — bounded by a timeout — before
  // terminate(), so those handlers actually run instead of being discarded.
  | { kind: 'shutdown_complete' };
