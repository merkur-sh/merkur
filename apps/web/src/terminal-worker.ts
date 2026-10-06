import type { OwnedTimeout } from './lib/owned-scheduled-callback';

import { createOwnedAnimationFrame, createOwnedTimeout } from './lib/owned-scheduled-callback';

import { createTaskWake } from './lib/task-wake';
import {
  recordClientViewerDiscard,
  recordClientViewerDisplay,
} from './perf/client-viewer-observation';

import {
  emitCursorShape,
  emitCursorStep,
  emitDisplayPumpComplete,
  emitFrameComplete,
  emitInputSeqEvent,
  emitPredictionRejected,
  emitPresentationCommit,
  emitPresentationEpochBoundary,
  emitPresentationGate,
  emitRenderEnd,
  emitRenderStart,
  PERF_KIND_PREDICTION_APPLIED,
} from './perf/perf-event-codec';

import { createPerfRingWriter, type PerfRingWriter } from './perf/perf-ring';

import type {
  TerminalFrameCompletionDisposition,
  TerminalPresentationCommitReason,
  TerminalRenderGate,
} from './perf/terminal-latency';

import { createClientViewerSceneReader } from './terminal/client-viewer-scene';
import { createDisplayOutputSettle } from './terminal/display-output-settle';
import { displayProcessSliceBudgetMs } from './terminal/display-process-budget';
import {
  createDisplayReceiverCalibrationRun,
  createDisplayReceiverCalibrationScheduler,
  DISPLAY_RECEIVER_CALIBRATION_COLS,
  DISPLAY_RECEIVER_CALIBRATION_ROWS,
} from './terminal/display-receiver-calibration';
import {
  createDisplayReceiverProfileWriter,
  type DisplayReceiverProfileWriter,
} from './terminal/display-receiver-profile';
import {
  persistDisplayReceiverProfile,
  restoreDisplayReceiverProfile,
} from './terminal/display-receiver-profile-cache';
import { resizeDisplaySurface } from './terminal/display-surface';
import { createFirstDisplayGpuFenceTracker } from './terminal/first-display-gpu-fence';
import { createTerminalFontLoader, type TerminalStyleFontBuffers } from './terminal/font-loader';
import {
  DEFAULT_TERMINAL_FONT,
  type TerminalFontFamily,
  terminalFontFamilyKey,
} from './terminal/fonts';
import {
  createGeometryRenderState,
  updateGeometryRenderState,
} from './terminal/geometry-render-state';
import { comparePerfGridConvergence } from './terminal/perf-grid-convergence';
import {
  createPredictionFastPathConsumer,
  PREDICTION_COMMAND_FLUSH,
  type PredictionCommandKind,
  type PredictionFastPathConsumer,
  type ProvisionalPreviewSnapshot,
} from './terminal/prediction-fast-path';
import {
  createPresentationCadenceWriter,
  PRESENTATION_PERIOD_CHANGED_EDGE,
  type PresentationCadenceWriter,
  quantizePresentationPeriodUs,
} from './terminal/presentation-cadence';

import { createPresentedPredictionSources } from './terminal/presented-prediction-sources';

import { createProvisionalPreviewState } from './terminal/provisional-preview';

import { createRefreshRateCalibrator } from './terminal/refresh-rate-calibrator';

import { createRefreshRateEstimator } from './terminal/refresh-rate-estimator';

import { createRenderMailbox, type MailboxAction } from './terminal/render-mailbox';

import { createRenderSubmissionState } from './terminal/render-submission-state';

import {
  createFrameRingReaderForMode,
  createViewerOutputRingWriterForMode,
} from './terminal/ring-wake-readers';

import {
  FRAME_KIND_CLIENT_INGRESS_BASE,
  FRAME_RING_SPACE_EDGE,
  type FrameRingReader,
} from './terminal/shared-ring';

import type { TerminalTheme } from './terminal/themes';

import {
  assertViewerOutputBound,
  createViewerOutputPublisher,
  type ViewerOutputPublisher,
} from './terminal/viewer-output-publisher';

import { VIEWER_OUTPUT_SPACE_EDGE } from './terminal/viewer-output-ring';

import {
  createWorkerControlQueue,
  workerControlCommandBlocksDataPlane,
} from './terminal/worker-control-queue';

import type {
  ClientGraphicsAsset,
  ClientSessionFence,
  PerfGridConvergenceResponseEdge,
  TerminalToTransportPeer,
  TransportToTerminalPeer,
} from './terminal/worker-peer-control';

import { type GpuRenderer, selectRenderer } from './terminal-renderer';

import type { TerminalWorkerTuning, WorkerCommand, WorkerEvent } from './terminal-worker-protocol';

import { advanceInputSequence } from './transport/input-sequence-domain';

import {
  createPredictionAdmissionResolver,
  type PredictionAdmissionResolver,
} from './transport/prediction-admission';

import {
  createWasmClientViewerHandle,
  createWasmDisplayReceiverCalibrationHandle,
  cursorCauseName,
  cursorMotionRecordWords,
  preloadWasmTerminalRuntime,
  type WasmClientViewerHandle,
} from './wasm-loader';

let renderer: GpuRenderer | null = null;

let rendererContextLost = false;

let wasmTerminal: WasmClientViewerHandle | null = null;

let viewportWatched = false;

let offscreenCanvas: OffscreenCanvas | null = null;

let physW = 0;

let physH = 0;

let cols = 0;

let rows = 0;

let requestedCols = 0;

let requestedRows = 0;

let controlsGeometry = false;

let resizeRequestedAtMs = 0;

/** The transport's geometry grant; its epoch is the authenticated display lineage. */
let receivedGeometryState: { readonly epoch: number; readonly status: 0 | 1 | 2 } | null = null;

function applyGeometryAuthority(): void {
  const state = receivedGeometryState;
  if (state === null || state.epoch !== graphicsEpoch) return;
  const controls = state.status === 1;
  if (controls === controlsGeometry) return;
  controlsGeometry = controls;
  if (controls) {
    if (
      requestedCols > 0 &&
      requestedRows > 0 &&
      (cols !== requestedCols || rows !== requestedRows)
    ) {
      handleResize({ kind: 'resize', cols: requestedCols, rows: requestedRows });
    }
  } else {
    resizeRequestedAtMs = 0;
    wasmTerminal?.viewer.release_geometry(viewerNowMs());
    drainViewerOutputs();
    armViewerDeadline();
  }
}

let charWidth = 0;

let charHeight = 0;

let currentFontSize = 14;

let currentLineHeight = 1;

let currentDevicePixelRatio = 1;

let pendingRasterMetrics: {
  fontSize: number;
  lineHeight: number;
  dpr: number;
} | null = null;

let emojiCtx: OffscreenCanvasRenderingContext2D | null = null;

let fallbackBoxSignature: number | null = null;

let lastMouseMode = -1;

let atlasPixelsView: Uint8Array | null = null;

let atlasPixelsBuffer: ArrayBufferLike | null = null;

let atlasPixelsLength = 0;

let uploadedAtlasGeneration = 0;

const geometryRenderState = createGeometryRenderState();

const DEFAULT_TERMINAL_WORKER_TUNING: Required<TerminalWorkerTuning> = {
  // A resource bound on overlay lifetime, not a correctness gate. Every real
  // withdrawal is an exact grid mismatch; reaching this deadline means the link
  // stalled, which is classified separately and never resets trust.
  predictionTtlMs: 500,
  altScreenPredictionTtlMs: 200,
  pathRttEwmaAlpha: 0.3,
  predictionRecentWindow: 20,
  predictionLowRttMinVisibleRatio: 0.9,
  predictionLowRttMinConsecutiveConfirmed: 3,
  predictionCommandsPerSlice: 32,
  displayProcessBudgetMs: 6,
};

const MAX_VISIBLE_PREDICTION_PERF_SEQS = 256;

let srttMs: number | null = null;

let tuning = DEFAULT_TERMINAL_WORKER_TUNING;

const refreshRate = createRefreshRateEstimator();

const renderMailbox = createRenderMailbox();

const renderSubmissions = createRenderSubmissionState();

let renderViewportEpoch = 0;

let renderStateRevision = 0;

let renderPredictionRevision = 0;

let localPresentationPending = false;

let committedInputHighWater = 0;

let committedPhysW = 0;

let committedPhysH = 0;

let preeditActive = false;

const provisionalPreview = createProvisionalPreviewState();

const previewAuthority = {
  epoch: 0,
  modelVersion: 0,
  predictionSafe: false,
  predictionVisible: false,
  appendOnly: false,
  cursorVisible: false,
  preeditActive: false,
  col: 0,
  row: 0,
  cols: 0,
  rows: 0,
  inputSeq: 0,
  foreground: 0,
  background: 0,
  cursorShape: 0,
  atlasGeneration: 0,
};

const previewAtlas = {
  entries: new Int32Array(0) as Int32Array,
  generation: 0,
  width: 0,
  height: 0,
  cellWidth: 0,
  cellHeight: 0,
  baseline: 0,
};

function createBouncedContinuation(
  timer: OwnedTimeout,
  run: (token: number) => void,
): (token: number) => void {
  const bounce = new MessageChannel();
  bounce.port1.onmessage = (event: MessageEvent<number>) => {
    timer.arm(() => run(event.data), 0);
  };
  return (token: number) => bounce.port2.postMessage(token);
}

interface PredictionPerfSnapshot {
  readonly predictionInputSeq: number;
  readonly visiblePredictionInputSeqs: readonly number[];
  readonly visiblePredictionInputSeqsTruncated: boolean;
  /** Prediction glyph provenance present in the submitted frame itself. */
}

let renderPerfSeq = 0;

let renderGateWantedAtMs = 0;

let renderGateFenceEnteredAtMs = 0;

let renderGateFenceReleasedAtMs = 0;

let renderGateFenceReleasedRenderSeq = 0;

let renderGateOpportunityEnteredAtMs = 0;

let renderGateOpportunityDelayMs = 0;

let renderGateWaitKind: 'none' | 'fence' | 'opportunity' = 'none';

let renderGateWaitStartedAtMs = 0;

let renderGateFenceWaitMs = 0;

let renderGateOpportunityWaitMs = 0;

let renderGateFenceReleasePending = false;

let inFlightCursorValid = false;

let inFlightCursorCol = 0;

let inFlightCursorRow = 0;

let inFlightCursorVisible = false;

const refreshCalibrator = createRefreshRateCalibrator(
  refreshRate,
  {
    requestFrame: (callback) => requestAnimationFrame(callback),
    cancelFrame: (handle) => cancelAnimationFrame(handle),
    setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimer: (timer) => clearTimeout(timer),
    now: () => performance.now(),
  },
  publishPresentationPeriod,
);

let displayEnvDpr: number | null = null;

const presentedPredictionSources = createPresentedPredictionSources();

let lastRenderUploadedAtlas = false;

let predictionModelThroughInputSeq = 0;

let displayEpoch = {
  generation: 0,
  renderPending: false,
  pumpScheduled: false,
  /**
   * Main re-lays out its canvas from `display_state_ready`/`_applied`, so they
   * are raised only when the grid or its metrics changed. Every presentation
   * still settles output and stales watched viewport rows, through this flag.
   */
  stateReadyPending: false,
  stateAppliedPending: false,
  outputPresentedPending: false,
  lastFrameAtMs: 0,
  lastSnapshotAtMs: 0,
};

const presentationAnimationFrame = createOwnedAnimationFrame(
  (callback) => requestAnimationFrame(callback),
  (handle) => cancelAnimationFrame(handle),
);

const renderAnimationFrame = createOwnedAnimationFrame(
  (callback) => requestAnimationFrame(callback),
  (handle) => cancelAnimationFrame(handle),
);

let displayRenderExecuting = false;

let displaySurfaceResizePending = false;

let perfEnabled = false;

let workerReady = false;

type FirstDisplayFrameIdentity = Omit<
  Extract<WorkerEvent, { kind: 'first_display_gpu_complete' }>,
  'kind'
>;

const firstDisplayGpuFence = createFirstDisplayGpuFenceTracker<FirstDisplayFrameIdentity>();

const terminalFontLoader = createTerminalFontLoader();

let activeFontFamilyKey = '';

type InstalledFontTier = 'boot' | 'regular' | 'styled';

interface FontStyleUpgrade {
  readonly generation: number;
  readonly terminal: WasmClientViewerHandle;
  readonly fontFamily: TerminalFontFamily;
  readonly fontFamilyKey: string;
}

let installedFontTier: InstalledFontTier = 'boot';

let fontStyleUpgradeGeneration = 0;

let pendingFontStyleUpgrade: FontStyleUpgrade | null = null;

let regularPromotionInFlight: {
  readonly generation: number;
  readonly promise: Promise<boolean>;
} | null = null;

let activeFontFamilyUpdateController: AbortController | null = null;

interface PreparedFontFamilyUpdate {
  readonly controller: AbortController;
  readonly terminal: WasmClientViewerHandle;
  readonly sessionEpoch: number;
  readonly fontFamily: TerminalFontFamily;
  readonly bytes: ArrayBuffer;
}

let preparedFontFamilyUpdate: PreparedFontFamilyUpdate | null = null;

let latestPredictionInputSeq = 0;

let pendingRenderPredictionInputSeq = 0;

function appliedHighWater(_generation: number): number {
  return wasmTerminal?.viewer.applied_sequence() ?? 0;
}

let presentationCadenceWriter: PresentationCadenceWriter | null = null;

let frameRingReader: FrameRingReader | null = null;

let viewerOutputPublisher: ViewerOutputPublisher | null = null;

let displayReceiverProfileWriter: DisplayReceiverProfileWriter | null = null;

let displayReceiverProfileBuffer: SharedArrayBuffer | null = null;

const displayAvailableWake = createTaskWake();

const DISPLAY_OUTPUT_CHANGED: WorkerEvent = Object.freeze({ kind: 'display_output_changed' });

const DISPLAY_OUTPUT_SETTLED: WorkerEvent = Object.freeze({ kind: 'display_output_settled' });

const displayOutputSettle = createDisplayOutputSettle({
  onChanged: () => self.postMessage(DISPLAY_OUTPUT_CHANGED),
  onSettled: () => self.postMessage(DISPLAY_OUTPUT_SETTLED),
  now: () => performance.now(),
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (timer) => clearTimeout(timer),
});

let ringWakePort: MessagePort | null = null;

let graphicsEpoch = 0;

let graphicsOwner = '';

let graphicsVisible = true;

function wakeGraphics(): void {
  localPresentationPending = true;
  displayEpoch.renderPending = true;
  scheduleRenderFrame();
}

function graphicsUploaded(epoch: number, owner: string, key: string): void {
  if (epoch !== graphicsEpoch || owner !== graphicsOwner || wasmTerminal === null) return;
  retryWaitingGraphicsAsset();
  graphicsResidents.add(key);
  wasmTerminal.viewer.set_graphics_resident(viewerNowMs(), epoch, key, true);
  drainViewerOutputs();
  armViewerDeadline();
  wakeGraphics();
}

const PERF_GRID_CONVERGENCE_DEADLINE_MS = 20_000;

const PERF_GRID_CONVERGENCE_RESPONSE_TIMEOUT_MS = 1_500;

const PERF_GRID_CONVERGENCE_MAX_ATTEMPTS = 16;

const PERF_GRID_CONVERGENCE_MAX_REPAIRS = 4;

interface PendingPerfGridConvergence {
  readonly observationEpoch: number;
  readonly probeId: number;
  readonly startedAtMs: number;
  readonly deadlineAtMs: number;
  readonly repair: boolean;
  attempts: number;
  selectiveRepairCount: number;
  response: PerfGridConvergenceResponseEdge | null;
}

let pendingPerfGridConvergence: PendingPerfGridConvergence | null = null;

const perfGridConvergenceTimer = createOwnedTimeout(
  (callback, delayMs) => setTimeout(callback, delayMs),
  (timer) => clearTimeout(timer),
);

let predictionAdmissionResolver: PredictionAdmissionResolver | null = null;

let predictionFastPath: PredictionFastPathConsumer | null = null;

let activeSessionEpoch = 0;
let activeFrameFenceToken = 0;

let displayReceiverCalibrationSettled = false;

const displayReceiverCalibrationScheduler = createDisplayReceiverCalibrationScheduler({
  createTerminal: () =>
    createWasmDisplayReceiverCalibrationHandle(
      DISPLAY_RECEIVER_CALIBRATION_COLS,
      DISPLAY_RECEIVER_CALIBRATION_ROWS,
    ),
  createRun: (terminal) => {
    const writer = displayReceiverProfileWriter;
    if (writer === null) throw new Error('display receiver profile writer unavailable');
    return createDisplayReceiverCalibrationRun(terminal, writer);
  },
  currentEpoch: () => activeSessionEpoch,
  currentGeneration: () => displayEpoch.generation,
  hasLiveWork: () =>
    controlQueueSize() > 0 ||
    hasDisplayOwnerWork() ||
    (predictionFastPath?.pendingCount() ?? 0) > 0 ||
    (predictionFastPath?.previewsPending() ?? false) ||
    displayRenderExecuting ||
    displayEpoch.renderPending ||
    renderer?.frameInFlight() === true,
  onComplete: () => {
    displayReceiverCalibrationSettled = true;

    const buffer = displayReceiverProfileBuffer;
    if (buffer !== null) void persistDisplayReceiverProfile(buffer);
  },
  onFailure: (error) => {
    displayReceiverCalibrationSettled = true;
    postDisplayDiag('display_receiver_calibration_failed', error, true);
  },
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  cancelScheduled: (handle) => clearTimeout(handle),
});

function handleRingWakeEdge(event: MessageEvent<number | TransportToTerminalPeer>): void {
  const data = event.data;
  if (data === VIEWER_OUTPUT_SPACE_EDGE) {
    // The transport worker drained a viewer-output ring that had refused an
    // output: the one held here goes out, and the viewer is polled again.
    drainViewerOutputs();
    return;
  }
  if (typeof data === 'number') {
    displayAvailableWake.wake();
    predictionFastPath?.wake();
    return;
  }
  switch (data.kind) {
    case 'client_graphics_asset':
      void acceptClientGraphicsAsset(data).catch(reportFatal);
      return;
    case 'client_graphics_clock':
      if (data.lineage === activeSessionEpoch && data.frameFenceToken === activeFrameFenceToken) {
        wasmTerminal?.viewer.graphics_clock(viewerNowMs(), data.monotonicUs, data.rttMs);
        observeViewerPresentation();
        drainViewerOutputs();
        armViewerDeadline();
        wakeGraphics();
      }
      return;
    case 'client_geometry':
      if (data.lineage === activeSessionEpoch && data.frameFenceToken === activeFrameFenceToken) {
        receivedGeometryState = { epoch: data.lineage, status: data.status };
        applyGeometryAuthority();
      }
      return;
    case 'client_session_fence':
      peerFences.length = 0;
      peerFences.push(data);
      scheduleControlPump();
      return;
    case 'perf_grid_convergence_response':
      handlePerfGridConvergenceResponse(data);
      return;
  }
}

function installRingWakePort(port: MessagePort): void {
  if (ringWakePort !== null && ringWakePort !== port) ringWakePort.close();
  ringWakePort = port;
  // Assigning the handler starts the port: edges posted before this point
  // were queued on it, not lost.
  port.onmessage = handleRingWakeEdge;
}

function startPerfGridConvergence(
  cmd: Extract<WorkerCommand, { kind: 'profiling_verify_grid_convergence' }>,
): void {
  if (pendingPerfGridConvergence !== null) {
    finishPerfGridConvergence(false, 'superseded');
  }
  const now = performance.now();
  pendingPerfGridConvergence = {
    observationEpoch: cmd.observationEpoch,
    probeId: cmd.probeId,
    startedAtMs: now,
    deadlineAtMs: now + PERF_GRID_CONVERGENCE_DEADLINE_MS,
    repair: cmd.repair,
    attempts: 0,
    selectiveRepairCount: 0,
    response: null,
  };
  if (!perfEnabled || !workerReady || wasmTerminal === null || ringWakePort === null) {
    finishPerfGridConvergence(false, 'not-ready');
    return;
  }
  sendPerfGridConvergenceProbe();
}

function sendPerfGridConvergenceProbe(): void {
  const pending = pendingPerfGridConvergence;
  if (pending === null) return;
  const now = performance.now();
  if (now >= pending.deadlineAtMs || pending.attempts >= PERF_GRID_CONVERGENCE_MAX_ATTEMPTS) {
    finishPerfGridConvergence(false, 'timeout');
    return;
  }
  pending.attempts += 1;
  pending.response = null;
  ringWakePort?.postMessage({
    kind: 'perf_grid_convergence_request',
    observationEpoch: pending.observationEpoch,
    probeId: pending.probeId,
  } satisfies TerminalToTransportPeer);
  perfGridConvergenceTimer.arm(
    sendPerfGridConvergenceProbe,
    Math.min(PERF_GRID_CONVERGENCE_RESPONSE_TIMEOUT_MS, pending.deadlineAtMs - now),
  );
}

function handlePerfGridConvergenceResponse(response: PerfGridConvergenceResponseEdge): void {
  const pending = pendingPerfGridConvergence;
  if (
    pending === null ||
    response.observationEpoch !== pending.observationEpoch ||
    response.probeId !== pending.probeId
  ) {
    return;
  }
  perfGridConvergenceTimer.cancel();
  pending.response = response;
  evaluatePerfGridConvergence();
}

function perfGridConvergenceHasPendingPresentation(): boolean {
  return (
    wasmTerminal === null ||
    wasmTerminal.viewer.presentation_held() ||
    hasDisplayOwnerWork() ||
    displayRenderExecuting ||
    displayEpoch.renderPending ||
    rendererContextLost ||
    renderer?.frameInFlight() === true
  );
}

function schedulePerfGridConvergenceEvaluation(delayMs: number): void {
  const pending = pendingPerfGridConvergence;
  if (pending === null) return;
  const now = performance.now();
  if (now >= pending.deadlineAtMs) {
    finishPerfGridConvergence(false, 'timeout');
    return;
  }
  perfGridConvergenceTimer.arm(
    evaluatePerfGridConvergence,
    Math.max(1, Math.min(delayMs, pending.deadlineAtMs - now)),
  );
}

function evaluatePerfGridConvergence(): void {
  const pending = pendingPerfGridConvergence;
  const response = pending?.response ?? null;
  if (pending === null || response === null) return;
  if (performance.now() >= pending.deadlineAtMs) {
    finishPerfGridConvergence(false, 'timeout');
    return;
  }
  // A successful result is deliberately downstream of the real renderer
  // fence. This proves the matching authoritative grid reached the GPU; it is
  // not represented as compositor/scanout timing, which WebGPU cannot expose.
  if (perfGridConvergenceHasPendingPresentation()) {
    schedulePerfGridConvergenceEvaluation(refreshRate.presentationPeriodMs());
    return;
  }
  const terminal = wasmTerminal;
  if (terminal === null || displayEpoch.generation === 0) {
    schedulePerfGridConvergenceEvaluation(refreshRate.presentationPeriodMs());
    return;
  }
  const comparison = comparePerfGridConvergence(response, {
    generation: displayEpoch.generation,
    lastAppliedDisplaySeq: appliedHighWater(displayEpoch.generation),
    cols: terminal.cols(),
    rows: terminal.rows(),
    rowHashes: terminal.rowHashes(),
  });
  if (comparison.kind === 'converged') {
    finishPerfGridConvergence(true, null);
    return;
  }
  pending.response = null;
  if (comparison.kind === 'repair') {
    if (!pending.repair) {
      finishPerfGridConvergence(false, 'mismatch');
      return;
    }
    if (pending.selectiveRepairCount >= PERF_GRID_CONVERGENCE_MAX_REPAIRS) {
      finishPerfGridConvergence(false, 'timeout');
      return;
    }
    if (
      terminal.viewer.request_row_repair(displayEpoch.generation, Uint16Array.from(comparison.rows))
    ) {
      pending.selectiveRepairCount += 1;
      drainViewerOutputs();
    }
    // The observation probe and core repair are independent control messages. Give
    // the existing repair path one RTT-scaled interval to apply before taking
    // the next observation; this is measurement-only and remains deadline
    // bounded.
    const repairObservationDelayMs = Math.min(1_000, Math.max(50, (srttMs ?? 200) * 1.25));
    perfGridConvergenceTimer.arm(sendPerfGridConvergenceProbe, repairObservationDelayMs);
    return;
  }
  // The daemon observation and browser grid name different instants. No row
  // is known divergent; taking another bounded observation is the only honest
  // action.
  perfGridConvergenceTimer.arm(
    sendPerfGridConvergenceProbe,
    Math.max(1, Math.min(refreshRate.presentationPeriodMs(), 50)),
  );
}

function finishPerfGridConvergence(
  converged: boolean,
  failureReason: 'not-ready' | 'mismatch' | 'superseded' | 'timeout' | null,
): void {
  const pending = pendingPerfGridConvergence;
  if (pending === null) return;
  perfGridConvergenceTimer.cancel();
  pendingPerfGridConvergence = null;
  const response = pending.response;
  self.postMessage({
    kind: 'perf_grid_convergence_result',
    observationEpoch: pending.observationEpoch,
    probeId: pending.probeId,
    converged,
    failureReason,
    attempts: Math.max(1, pending.attempts),
    selectiveRepairCount: pending.selectiveRepairCount,
    generation: response?.generation ?? displayEpoch.generation,
    lastAdmittedDisplaySeq:
      response?.lastAdmittedDisplaySeq ?? appliedHighWater(displayEpoch.generation),
    rows: response?.rows ?? wasmTerminal?.rows() ?? 0,
    elapsedMs: Math.max(0, performance.now() - pending.startedAtMs),
  } satisfies WorkerEvent);
}

function cancelPerfGridConvergence(): void {
  perfGridConvergenceTimer.cancel();
  pendingPerfGridConvergence = null;
}

type WorkerControlCommand = WorkerCommand;

const controlQueue = createWorkerControlQueue();

function controlQueueSize(): number {
  return controlQueue.size();
}

function displayQueueSize(): number {
  return frameRingReader?.hasPending() ? 1 : 0;
}

let controlPumpScheduled = false;

let controlPumpActive = false;

let activeControlBlocksDataPlane = false;

let controlQueueOverflowReported = false;

let predictionRingPumpActive = false;

let predictionRingPumpToken = 0;

let predictionRingWaitPending = false;

const predictionRingContinuation = createOwnedTimeout(
  (callback, delayMs) => setTimeout(callback, delayMs),
  (timer) => clearTimeout(timer),
);

const controlPumpContinuation = createOwnedTimeout(
  (callback, delayMs) => setTimeout(callback, delayMs),
  (timer) => clearTimeout(timer),
);

const displayPumpContinuation = createOwnedTimeout(
  (callback, delayMs) => setTimeout(callback, delayMs),
  (timer) => clearTimeout(timer),
);

function reportFatal(err: unknown): void {
  try {
    self.postMessage({
      kind: 'fatal',
      message: String(err),
    } satisfies WorkerEvent);
  } catch {
    // no-op
  }
}

const DISPLAY_DIAG_MIN_INTERVAL_MS = 1_000;

const lastDisplayDiagAtMs = new Map<string, number>();

function postDisplayDiag(event: string, detail: string, important = false): void {
  // Important diagnostics (every resync trigger) bypass the per-event rate
  // limit: a resync storm is exactly the case we need the FULL sequence of
  // reasons for, and throttling to 1/sec would collapse a burst into a single
  // line and hide which trigger actually fired (apply_rejected wasmError=...,
  // parse_failed, assemblies_overflow, stale_generation_recovery, ...).
  if (!important) {
    const now = performance.now();
    const last = lastDisplayDiagAtMs.get(event);
    if (last !== undefined && now - last < DISPLAY_DIAG_MIN_INTERVAL_MS) return;
    lastDisplayDiagAtMs.set(event, now);
  }
  try {
    self.postMessage({
      kind: 'display_diag',
      event,
      detail,
    } satisfies WorkerEvent);
  } catch {
    // diagnostics must never break the worker
  }
}

/**
 * Epoch time for telemetry, comparable with the stamps of main and the other
 * workers. Not the viewer's clock: WebKit recomputes `performance.timeOrigin`
 * on every read and moves it forward by each device sleep.
 */
function nowMs(): number {
  return performance.timeOrigin + performance.now();
}

const WORKER_TIME_ORIGIN_MS = performance.timeOrigin;

/**
 * The viewer core's one clock: this realm's monotonic timeline, the one its
 * animation frame times are on. A frame compared with the apply it releases
 * must read the same origin: on `nowMs`, every frame after an iPhone sleep
 * predates the hold it should release, and output freezes for the length of
 * the sleep while input keeps working.
 */
function viewerNowMs(): number {
  return WORKER_TIME_ORIGIN_MS + performance.now();
}

/**
 * How far `nowMs` has run ahead of `viewerNowMs`, for stamps crossing between
 * the two: zero in Chromium and Firefox, every sleep since this worker began in
 * WebKit.
 */
function timeOriginDriftMs(): number {
  return performance.timeOrigin - WORKER_TIME_ORIGIN_MS;
}

let perfWriter: PerfRingWriter | null = null;

function sanitizeTerminalWorkerTuning(
  overrides: TerminalWorkerTuning | undefined,
): Required<TerminalWorkerTuning> {
  const defaults = DEFAULT_TERMINAL_WORKER_TUNING;
  return {
    predictionTtlMs: finiteNumber(overrides?.predictionTtlMs, defaults.predictionTtlMs, 0, 5_000),
    altScreenPredictionTtlMs: finiteNumber(
      overrides?.altScreenPredictionTtlMs,
      defaults.altScreenPredictionTtlMs,
      0,
      5_000,
    ),
    pathRttEwmaAlpha: finiteNumber(overrides?.pathRttEwmaAlpha, defaults.pathRttEwmaAlpha, 0, 1),
    predictionRecentWindow: integerNumber(
      overrides?.predictionRecentWindow,
      defaults.predictionRecentWindow,
      1,
      512,
    ),
    predictionLowRttMinVisibleRatio: finiteNumber(
      overrides?.predictionLowRttMinVisibleRatio,
      defaults.predictionLowRttMinVisibleRatio,
      0,
      1,
    ),
    predictionLowRttMinConsecutiveConfirmed: integerNumber(
      overrides?.predictionLowRttMinConsecutiveConfirmed,
      defaults.predictionLowRttMinConsecutiveConfirmed,
      0,
      512,
    ),
    predictionCommandsPerSlice: integerNumber(
      overrides?.predictionCommandsPerSlice,
      defaults.predictionCommandsPerSlice,
      1,
      4_096,
    ),
    displayProcessBudgetMs: finiteNumber(
      overrides?.displayProcessBudgetMs,
      defaults.displayProcessBudgetMs,
      0,
      100,
    ),
  };
}

function finiteNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function integerNumber(value: unknown, fallback: number, min: number, max: number): number {
  return Math.round(finiteNumber(value, fallback, min, max));
}

self.onmessage = (e: MessageEvent<WorkerCommand>) => {
  const command = e.data;
  if (
    command.kind === 'font_family_update' ||
    command.kind === 'init' ||
    command.kind === 'session_epoch' ||
    command.kind === 'shutdown'
  ) {
    abortActiveFontFamilyUpdate(`superseded by ${command.kind}`);
  }
  if (!controlQueue.push(command)) {
    if (!controlQueueOverflowReported) {
      controlQueueOverflowReported = true;
      reportFatal(new Error('terminal worker control queue capacity exceeded'));
    }
    return;
  }
  scheduleControlPump();
};

function abortActiveFontFamilyUpdate(reason: string): void {
  preparedFontFamilyUpdate = null;
  const controller = activeFontFamilyUpdateController;
  activeFontFamilyUpdateController = null;
  if (controller === null || controller.signal.aborted) return;
  controller.abort(new Error(`terminal font-family update ${reason}`));
}

function clearQueuedPredictions(): number {
  let discardedThrough = 0;
  predictionFastPath?.discardPending((inputSeq) => {
    discardedThrough = Math.max(discardedThrough, inputSeq) >>> 0;
    predictionAdmissionResolver?.reject(inputSeq);
  });
  return discardedThrough;
}

function revokePaintedPredictions(): void {
  if (!provisionalPreview.clear()) return;
  localPresentationPending = true;
  displayEpoch.renderPending = true;
}

function scheduleControlPump(): void {
  if (controlPumpScheduled || controlPumpActive) return;
  controlPumpScheduled = true;
  queueMicrotask(() => {
    controlPumpScheduled = false;
    // Failures outside runControlPump's internal try/catch would otherwise
    // reject unobserved; surface them through the worker fatal path.
    runControlPump().catch((err: unknown) => reportFatal(err));
  });
}

const bounceControlPumpContinuation = createBouncedContinuation(controlPumpContinuation, () => {
  controlPumpScheduled = false;
  runControlPump().catch((err: unknown) => reportFatal(err));
});

function scheduleControlPumpContinuation(): void {
  if (controlPumpScheduled || controlPumpActive) return;
  controlPumpScheduled = true;
  bounceControlPumpContinuation(0);
}

function startPredictionRingPump(): void {
  if (predictionRingPumpActive || predictionFastPath === null) return;
  predictionRingPumpActive = true;
  predictionRingWaitPending = false;
  predictionRingPumpToken = (predictionRingPumpToken + 1) >>> 0;
  pumpPredictionRing(predictionRingPumpToken);
}

function stopPredictionRingPump(): void {
  predictionRingPumpToken = (predictionRingPumpToken + 1) >>> 0;
  predictionRingPumpActive = false;
  predictionRingContinuation.cancel();
  predictionFastPath?.wake();
}

const bouncePredictionRingContinuation = createBouncedContinuation(
  predictionRingContinuation,
  (token) => pumpPredictionRing(token),
);

function schedulePredictionRingContinuation(token: number): void {
  bouncePredictionRingContinuation(token);
}

function pumpPredictionRing(token: number): void {
  if (!predictionRingPumpActive || token !== predictionRingPumpToken) return;
  const fastPath = predictionFastPath;
  if (fastPath === null || !fastPath.epochReady()) return;
  if (
    activeControlBlocksDataPlane ||
    controlQueue.hasDataPlaneBarrier() ||
    (!controlPumpActive && controlQueueSize() > 0)
  ) {
    scheduleControlPump();
    return;
  }

  const overflowInputSeq = fastPath.takeOverflowInputSeq();
  if (overflowInputSeq !== null) handlePredictionRingOverflow(overflowInputSeq);
  const processed = fastPath.drain(tuning.predictionCommandsPerSlice, handlePredictionCommand);
  if (processed > 0 || overflowInputSeq !== null) publishPredictionModel();
  fastPath.drainProvisionalPreviews(handleProvisionalPreviewSnapshot);
  renderPredictionIfDirty();

  if (!controlPumpActive && controlQueueSize() > 0) {
    scheduleControlPump();
    return;
  }
  if (fastPath.pendingCount() > 0 || fastPath.previewsPending()) {
    schedulePredictionRingContinuation(token);
    return;
  }
  // A control-triggered recovery pass can run while the idle wait is still
  // armed. Never accumulate detached waitAsync promises in that case.
  if (predictionRingWaitPending) return;
  const wait = fastPath.waitAsync();
  if (wait === 'not-equal') {
    schedulePredictionRingContinuation(token);
  } else {
    predictionRingWaitPending = true;
    void wait.then(() => {
      if (token !== predictionRingPumpToken) return;
      predictionRingWaitPending = false;
      pumpPredictionRing(token);
    });
  }
}

function handlePredictionRingOverflow(inputSeq: number): void {
  let firstRejected = inputSeq;
  predictionFastPath?.discardPending((sequence) => {
    predictionAdmissionResolver?.reject(sequence);
    if (sequence > 0 && (firstRejected === 0 || sequence < firstRejected)) firstRejected = sequence;
  });
  predictionAdmissionResolver?.reject(inputSeq);
  handlePredictFlush(firstRejected);
}

const bounceDisplayPumpContinuation = createBouncedContinuation(displayPumpContinuation, () => {
  displayEpoch.pumpScheduled = false;
  runDisplayPump();
});

function scheduleDisplayPumpContinuation(): void {
  if (displayEpoch.pumpScheduled) return;
  displayEpoch.pumpScheduled = true;
  bounceDisplayPumpContinuation(0);
}

const CONTROL_COMMANDS_PER_SLICE = 4;

function runDataPlaneFairnessSlice(): void {
  if (controlQueue.hasDataPlaneBarrier()) return;

  const fastPath = predictionFastPath;
  if (fastPath !== null && predictionRingPumpActive && fastPath.epochReady()) {
    const overflowInputSeq = fastPath.takeOverflowInputSeq();
    if (overflowInputSeq !== null) handlePredictionRingOverflow(overflowInputSeq);
    const processed = fastPath.drain(tuning.predictionCommandsPerSlice, handlePredictionCommand);
    if (processed > 0 || overflowInputSeq !== null) publishPredictionModel();
    fastPath.drainProvisionalPreviews(handleProvisionalPreviewSnapshot);
    renderPredictionIfDirty();
  }

  if (hasDisplayOwnerWork()) {
    // `drainDisplayQueue` checks for newly queued control after every complete
    // display frame, so this grants progress without allowing a long display
    // burst to steal the next control slice.
    drainDisplayQueue(
      displayProcessSliceBudgetMs(
        tuning.displayProcessBudgetMs,
        refreshRate.presentationPeriodMs(),
      ),
    );
  }
}

async function runControlPump(): Promise<void> {
  if (controlPumpActive) return;
  controlPumpActive = true;
  let processed = 0;
  try {
    while (peerFences.length > 0 && wasmTerminal !== null) {
      const fence = peerFences.shift();
      if (fence !== undefined) applyPeerFence(fence);
    }
    while (controlQueueSize() > 0 && processed < CONTROL_COMMANDS_PER_SLICE) {
      const cmd = controlQueue.shift();
      if (cmd === undefined) {
        continue;
      }
      processed += 1;
      controlQueueOverflowReported = false;
      activeControlBlocksDataPlane = workerControlCommandBlocksDataPlane(cmd);
      try {
        const handling = handleControlCommand(cmd);
        // Only initialization owns an asynchronous barrier. Ordinary controls
        // and font readiness commits are synchronous, with no per-command hop.
        if (handling !== undefined) await handling;
      } catch (err) {
        reportFatal(err);
      } finally {
        activeControlBlocksDataPlane = false;
      }
    }
    // The ready slot gets one opportunity per bounded slice, even under a
    // continuous control backlog. It may not overtake an ownership barrier.
    if (!controlQueue.hasDataPlaneBarrier()) commitPreparedFontFamilyUpdate();
  } finally {
    controlPumpActive = false;
  }

  while (peerFences.length > 0 && wasmTerminal !== null) {
    const fence = peerFences.shift();
    if (fence !== undefined) applyPeerFence(fence);
  }
  runDataPlaneFairnessSlice();
  if (controlQueueSize() > 0) {
    // Repeated queueMicrotask turns never yield to input/rAF task sources.
    // Backlog, unlike an idle control edge, must cross a real fair task.
    scheduleControlPumpContinuation();
  } else {
    continueDisplayOwner();
  }
  if (predictionFastPath?.pendingCount())
    schedulePredictionRingContinuation(predictionRingPumpToken);
  armPresentationCommit();
}

function runDisplayPump(): void {
  if (displayOwnerActive || !frameRingPumpActive) return;
  displayPumpContinuation.cancel();
  displayEpoch.pumpScheduled = false;
  if (
    activeControlBlocksDataPlane ||
    controlQueue.hasDataPlaneBarrier() ||
    (!controlPumpActive && controlQueueSize() > 0)
  ) {
    scheduleControlPump();
    return;
  }
  drainDisplayQueue(
    displayProcessSliceBudgetMs(tuning.displayProcessBudgetMs, refreshRate.presentationPeriodMs()),
  );
  if (controlQueueSize() > 0) scheduleControlPump();
  // A fairness slice may enter while the control owner is active. Preserve its
  // bounded display progress; pending controls regain ownership at the next
  // slice, and lifecycle barriers always block immediately.
  if (
    !activeControlBlocksDataPlane &&
    !controlQueue.hasDataPlaneBarrier() &&
    (controlPumpActive || controlQueueSize() === 0)
  )
    continueDisplayOwner();
}

function handleControlCommand(cmd: WorkerControlCommand): void | Promise<void> {
  if (cmd.kind === 'init') {
    return handleInit(cmd);
  } else if (cmd.kind === 'resize') {
    handleResize(cmd);
  } else if (cmd.kind === 'font_update') {
    handleFontUpdate(cmd);
  } else if (cmd.kind === 'font_family_update') {
    handleFontFamilyUpdate(cmd);
  } else if (cmd.kind === 'theme_update') {
    handleThemeUpdate(cmd);
  } else if (cmd.kind === 'render_refresh') {
    handleRenderRefresh();
  } else if (cmd.kind === 'display_available') {
    // Serialize the wake with session_epoch. The edge carries no authority, but
    // releasing the frame consumer before its epoch fence would let new-lineage
    // bytes be interpreted against the previous terminal state.
    displayAvailableWake.wake();
  } else if (cmd.kind === 'get_viewport_rows') {
    // One reply carries both halves: the layer positions the rows and the copy
    // assembly needs the wrap bits to join a soft-wrapped line without a
    // newline. Splitting them would let the two arrive against different grids.
    const text = wasmTerminal?.presentationViewportRows() ?? '';
    const wrapBits = wasmTerminal?.presentationViewportWrapBits() ?? new Uint8Array(0);
    // The mirror reads once per settled burst and never needs telling; only a
    // read kept on screen asks, or every burst would cost a message.
    if (cmd.watch && wasmTerminal !== null) viewportWatched = true;
    self.postMessage({ kind: 'viewport_rows_result', text, wrapBits } satisfies WorkerEvent);
  } else if (cmd.kind === 'get_link_viewport') {
    // Authoritative grid, not presentation: link ids exist only there, and the
    // text has to come from the grid the ids describe.
    const terminal = wasmTerminal;
    const event: Extract<WorkerEvent, { kind: 'link_viewport_result' }> =
      terminal === null
        ? {
            kind: 'link_viewport_result',
            cols: 0,
            rows: 0,
            text: '',
            wrapBits: new Uint8Array(0),
            columns: new Uint16Array(0),
            links: new Uint32Array(0),
          }
        : {
            kind: 'link_viewport_result',
            cols: terminal.cols(),
            rows: terminal.rows(),
            text: terminal.viewportRows(),
            wrapBits: terminal.viewportWrapBits(),
            columns: terminal.viewportTextColumns(),
            links: terminal.viewportLinks(),
          };
    if (terminal !== null) viewportWatched = true;
    self.postMessage(event, [event.wrapBits.buffer, event.columns.buffer, event.links.buffer]);
  } else if (cmd.kind === 'rtt_sample') {
    handleRttSample(cmd.rttMs);
  } else if (cmd.kind === 'srtt_reset') {
    srttMs = null;
  } else if (cmd.kind === 'profiling_verify_grid_convergence') {
    startPerfGridConvergence(cmd);
  } else if (cmd.kind === 'profiling_read_display_ring_boundary') {
    if (perfEnabled && frameRingReader !== null && activeSessionEpoch > 0) {
      self.postMessage({
        kind: 'perf_display_ring_boundary',
        observationEpoch: cmd.observationEpoch,
        requestId: cmd.requestId,
        sessionEpoch: activeSessionEpoch,
        atMs: nowMs(),
        ringDroppedTotal: frameRingReader.droppedCount(),
      } satisfies WorkerEvent);
    }
  } else if (cmd.kind === 'session_epoch') {
    predictionFastPath?.adoptRequiredEpoch((inputSeq) =>
      predictionAdmissionResolver?.reject(inputSeq),
    );
    predictionModelThroughInputSeq = 0;
    publishPredictionModel();
    schedulePredictionRingContinuation(predictionRingPumpToken);
  } else if (cmd.kind === 'set_preedit') {
    handleSetPreedit(cmd);
  } else if (cmd.kind === 'display_env') {
    handleDisplayEnv(cmd);
  } else if (cmd.kind === 'worker_health_check') {
    postWorkerHealth();
  } else if (cmd.kind === 'profiling_force_display_resync') {
    // The command is admitted only by a main-thread listener installed while
    // profiling is active, and the worker checks its independently latched bit
    // too. Only the trigger is synthetic: snapshot request, encrypted control
    // transport, daemon snapshot encoding, receive, apply, and GPU submission
    // all follow the production resynchronization path.
    if (perfEnabled && workerReady) requestDisplaySnapshot();
  } else if (cmd.kind === 'shutdown') {
    handleShutdown();
  }
}

function handleDisplayEnv(cmd: Extract<WorkerCommand, { kind: 'display_env' }>): void {
  const becameVisible = cmd.visible && !graphicsVisible;
  refreshCalibrator.setVisible(cmd.visible);
  graphicsVisible = cmd.visible;
  wasmTerminal?.viewer.set_visible(viewerNowMs(), cmd.visible);
  if (becameVisible) wasmTerminal?.viewer.resume_visible();
  if (cmd.visible) {
    // WebKit clears native worker rAF callbacks on suspension without notifying
    // our ownership slots. Replace retained arms on the explicit visible signal;
    // hidden/visible setters can coalesce before this worker gets a control turn.
    if (presentationAnimationFrame.isArmed())
      presentationAnimationFrame.arm(onViewerAnimationFrame);
    if (renderAnimationFrame.isArmed()) renderAnimationFrame.arm(onRenderAnimationFrame);
  }
  armPresentationCommit();
  armViewerDeadline();
  if (displayEnvDpr !== null && cmd.devicePixelRatio !== displayEnvDpr) {
    refreshRate.reset();
    publishPresentationPeriod();
    refreshCalibrator.requestBurst('dpr');
  }
  displayEnvDpr = cmd.devicePixelRatio;
  queueRasterMetrics(
    pendingRasterMetrics?.fontSize ?? currentFontSize,
    pendingRasterMetrics?.lineHeight ?? currentLineHeight,
    cmd.devicePixelRatio,
  );
}

function publishPresentationPeriod(): void {
  if (
    presentationCadenceWriter?.setPresentationPeriodUs(
      quantizePresentationPeriodUs(refreshRate.presentationPeriodMs()),
    ) === true
  ) {
    // Numeric and allocation-free; posted only on a quantized cadence change.
    // Zero remains reserved for task-mode frame/ACK ring notifications.
    ringWakePort?.postMessage(PRESENTATION_PERIOD_CHANGED_EDGE);
  }
}

function handleSetPreedit(cmd: Extract<WorkerCommand, { kind: 'set_preedit' }>): void {
  if (wasmTerminal === null || renderer === null) return;
  preeditActive = cmd.text.length !== 0;
  wasmTerminal.setPreedit(cmd.text, cmd.caret);
  localPresentationPending = true;
  // Transient overlay change: schedule a render without touching the
  // display-state machinery (same shape as renderPredictionIfDirty).
  displayEpoch.renderPending = true;
  scheduleRenderFrame();
}

function postWorkerHealth(): void {
  self.postMessage({
    kind: 'worker_health',
    diagnostics: {
      ready: workerReady,
      lastDisplayFrameAtMs: displayEpoch.lastFrameAtMs,
      lastSnapshotAtMs: displayEpoch.lastSnapshotAtMs,
      cols,
      rows,
      charWidth,
      charHeight,
      pixelWidth: physW,
      pixelHeight: physH,
      devicePixelRatio: currentDevicePixelRatio,
      queuedDisplayFrames: displayQueueSize(),
    },
  } satisfies WorkerEvent);
}

function handlePredictionCommand(
  kind: PredictionCommandKind,
  inputSeq: number,
  value: number,
  sentAtMs: number,
  visible: boolean,
): void {
  predictionModelThroughInputSeq = advanceInputSequence(predictionModelThroughInputSeq, inputSeq);
  // Main stamps the keystroke in epoch time; the core reads its own clock.
  const accepted =
    wasmTerminal?.viewer.prediction_command(
      sentAtMs - timeOriginDriftMs(),
      inputSeq,
      kind,
      value,
      visible,
    ) === true;
  if (!accepted) {
    predictionAdmissionResolver?.reject(inputSeq);
    if (
      perfEnabled &&
      perfWriter !== null &&
      wasmTerminal !== null &&
      kind !== PREDICTION_COMMAND_FLUSH
    )
      emitPredictionRejected(perfWriter, nowMs(), inputSeq, kind, wasmTerminal.lastFlushCause());
  }
  if (accepted && perfEnabled && perfWriter !== null)
    emitInputSeqEvent(
      perfWriter,
      PERF_KIND_PREDICTION_APPLIED,
      Math.max(sentAtMs, nowMs()),
      inputSeq,
    );
  latestPredictionInputSeq = advanceInputSequence(latestPredictionInputSeq, inputSeq);
  publishPredictionModel();
  renderPredictionIfDirty();
  armViewerDeadline();
}

async function handleInit(cmd: Extract<WorkerCommand, { kind: 'init' }>): Promise<void> {
  // Before the first await: the transport worker may already be initialized
  // and posting edges on this port, which holds them only until a handler
  // exists.
  installRingWakePort(cmd.ringWakePort);
  const nextDisplayReceiverProfileWriter = createDisplayReceiverProfileWriter(
    cmd.displayReceiverProfile,
  );
  // Cache evidence is opportunistic. An empty mailbox is the transport
  // planner's conservative prior, so neither IndexedDB nor cold calibration
  // belongs on the terminal-ready critical path.
  void restoreDisplayReceiverProfile(cmd.displayReceiverProfile);
  const replacingInstalledRuntime =
    workerReady || wasmTerminal !== null || renderer !== null || frameRingReader !== null;
  const nextTuning = cmd.perfEnabled
    ? sanitizeTerminalWorkerTuning(cmd.perfTuning)
    : DEFAULT_TERMINAL_WORKER_TUNING;
  const dpr = cmd.devicePixelRatio;

  // Construct the complete replacement in locals. Until renderer creation
  // succeeds, the installed runtime keeps serving frames; a failed re-init
  // therefore cannot leave a half-installed terminal/renderer pair.
  // All independent cold-start assets begin together. Only the boot face blocks
  // readiness. The full regular face starts promoting immediately afterward;
  // the three style faces remain behind the first authoritative GPU frame.
  // The full regular face is requested here but never awaited: first paint
  // needs only the boot face, while starting the real fetch this early keeps an
  // offline cold start able to promote later.
  terminalFontLoader.prefetchRegular(cmd.fontFamily);
  const [initialFontBuffers] = await Promise.all([
    terminalFontLoader.loadBlocking(cmd.fontFamily),
    preloadWasmTerminalRuntime(),
  ]);
  const nextPresentationCadenceWriter = createPresentationCadenceWriter(cmd.presentationCadence);
  nextPresentationCadenceWriter.setPresentationPeriodUs(
    quantizePresentationPeriodUs(refreshRate.presentationPeriodMs()),
  );
  let nextWasmTerminal: WasmClientViewerHandle | null = null;
  let nextRenderer: GpuRenderer | null = null;
  const canvas = cmd.gridCanvas;
  try {
    nextWasmTerminal = await createWasmClientViewerHandle(
      cmd.viewportWidth,
      cmd.viewportHeight,
      initialFontBuffers,
      cmd.fontSize,
      cmd.lineHeight,
      dpr,
    );
    if (!nextWasmTerminal.setTheme(terminalThemeBytes(cmd.theme))) {
      throw new Error('terminal rejected initial theme');
    }
    // Armed with the same switch: a backwards cursor step names the site that
    // caused it only if the site was recording when it happened.
    nextWasmTerminal.setCursorMotionJournal(cmd.perfEnabled);
    nextWasmTerminal.viewer.set_tracing(cmd.perfEnabled);
    const displayMemory = nextWasmTerminal.memory;
    nextWasmTerminal.viewer.set_display_observer((pointer, sinceMs) => {
      // The core keeps this stamp on its own clock; telemetry records it in epoch time.
      const atMs = viewerNowMs();
      const words = new Uint32Array(displayMemory.buffer, pointer, 14);
      if (words[0] === 4 && resizeRequestedAtMs !== 0) {
        postDisplayDiag(
          'resize_authority_window',
          `ms=${(atMs - resizeRequestedAtMs).toFixed(1)} grid=${words[1]}x${words[2]} kind=${words[3] === 1 ? 'display_snapshot' : 'display_delta'} corrected=${words[4] === 0xffffffff ? -1 : words[4]}/${words[5]}`,
          true,
        );
        resizeRequestedAtMs = 0;
      } else if (perfWriter !== null) {
        const driftMs = timeOriginDriftMs();
        if (words[0] === 5) {
          presentationTransactionSeq = recordClientViewerDiscard(
            perfWriter,
            words,
            atMs + driftMs,
            presentationTransactionSeq,
          );
        } else {
          recordClientViewerDisplay(
            perfWriter,
            words,
            atMs + driftMs,
            sinceMs + driftMs,
            presentationTransactionSeq,
          );
        }
      }
      return atMs;
    });
    nextWasmTerminal.setCellMetrics(cmd.fontSize * dpr, cmd.lineHeight, dpr);
    nextWasmTerminal.viewer.set_cell_size(
      viewerNowMs(),
      nextWasmTerminal.cellMetrics()[0] ?? 8,
      nextWasmTerminal.cellMetrics()[1] ?? 16,
    );
    const metrics = nextWasmTerminal.cellMetrics();
    const nextCellWidthPhysical = metrics[0] ?? 8;
    const nextCellHeightPhysical = metrics[1] ?? 16;
    const nextCols = Math.max(1, nextWasmTerminal.cols());
    const nextRows = Math.max(1, nextWasmTerminal.rows());
    const nextPhysW = Math.round(nextCols * nextCellWidthPhysical);
    const nextPhysH = Math.round(nextRows * nextCellHeightPhysical);
    canvas.width = nextPhysW;
    canvas.height = nextPhysH;

    let preparedRenderer: GpuRenderer | null = null;
    preparedRenderer = await selectRenderer(
      canvas,
      nextWasmTerminal.atlasWidth() || 2048,
      nextWasmTerminal.atlasHeight() || 2048,
      cmd.theme.background,
      () => {
        if (renderer !== preparedRenderer) return;
        // Device restoration redraws the retained eligible scene. It does not
        // make a partly received transaction eligible or alter its deadline.
        rendererContextLost = false;

        graphicsOwner = '';
        uploadedAtlasGeneration = 0;
        presentedPredictionSources.reset();
        wasmTerminal?.viewer.reproject_graphics(viewerNowMs());
        observeViewerPresentation();
        drainViewerOutputs();
        queueSurfaceReplacement(false);
      },
      () => {
        if (renderer !== preparedRenderer) return;
        // Destroyed GPU resources release physical owners only. Received and
        // eligible WASM state retain their independent transaction ownership.
        rendererContextLost = true;
        presentedPredictionSources.reset();

        abandonInFlightLatencyFrame();
        renderSubmissions.contextDestroyed(discardLatencyToken);
        renderMailbox.reset();
        cancelRenderOpportunity();
        resetRenderGateAccumulators();
      },
      (id) => {
        if (renderer === preparedRenderer) onGpuFrameComplete(id);
      },
      (error) => {
        if (renderer === preparedRenderer) reportFatal(error);
      },
    );
    nextRenderer = preparedRenderer;
    const readScene = createClientViewerSceneReader(nextWasmTerminal.memory);
    nextWasmTerminal.viewer.set_scene_admitter(
      (pointer: number, length: number, quadsRevision: number) => {
        // This callback is inside Rust's mutable viewer borrow. No WASM calls,
        // scheduling, or retained linear-memory views are allowed here.
        const scene = readScene(pointer, length, quadsRevision);
        const epoch = graphicsEpoch;
        const owner = graphicsOwner;
        const accepted =
          preparedRenderer?.setGraphicsScene(scene, wakeGraphics, (key) =>
            graphicsUploaded(epoch, owner, key),
          ) === true;
        graphicsPresentationDirty ||= accepted;
        graphicsOfferSpaceReleased ||=
          waitingGraphicsAsset !== null && preparedRenderer?.graphicsTileCapacity() === true;
        return accepted;
      },
    );

    const nextFrameRingReader = createFrameRingReaderForMode(
      cmd.displayRingWakeMode,
      cmd.frameRing,
      displayAvailableWake,
    );
    assertViewerOutputBound(nextWasmTerminal.viewer);
    const nextViewerOutputPublisher = createViewerOutputPublisher(
      createViewerOutputRingWriterForMode(
        cmd.displayRingWakeMode,
        cmd.viewerOutputRing,
        cmd.ringWakePort,
      ),
      viewerNowMs,
    );
    const nextPredictionAdmissionResolver = createPredictionAdmissionResolver(
      cmd.predictionAdmission,
    );
    const nextPredictionFastPath = createPredictionFastPathConsumer(cmd.predictionFastPath);
    const emojiCanvas = new OffscreenCanvas(
      Math.ceil(nextCellWidthPhysical * 2),
      Math.ceil(nextCellHeightPhysical),
    );
    const nextEmojiCtx = emojiCanvas.getContext('2d', {
      willReadFrequently: true,
    });

    // Commit point: everything that can fail materially is ready. Tear down the
    // old generation, then install matching terminal/renderer/ring components
    // together before the SAB pump is allowed to run.
    disposeInstalledRuntime();
    perfEnabled = cmd.perfEnabled;
    // Constructed unconditionally: the ring is a plain view over shared memory,
    // so building it costs nothing an opted-out session will notice, and
    // `perfEnabled` remains the single gate every emission site tests.
    perfWriter = createPerfRingWriter(cmd.perfRing);
    tuning = nextTuning;
    displayReceiverProfileBuffer = cmd.displayReceiverProfile;
    displayReceiverProfileWriter = nextDisplayReceiverProfileWriter;

    displayReceiverCalibrationSettled = false;
    currentFontSize = cmd.fontSize;
    currentLineHeight = cmd.lineHeight;
    currentDevicePixelRatio = dpr;
    wasmTerminal = nextWasmTerminal;
    renderer = nextRenderer;
    presentedPredictionSources.reset();
    rendererContextLost = false;
    frameRingReader = nextFrameRingReader;
    viewerOutputPublisher = nextViewerOutputPublisher;
    presentationCadenceWriter = nextPresentationCadenceWriter;
    predictionAdmissionResolver = nextPredictionAdmissionResolver;
    predictionFastPath = nextPredictionFastPath;
    cols = nextCols;
    rows = nextRows;
    requestedCols = nextCols;
    requestedRows = nextRows;
    charWidth = nextCellWidthPhysical / dpr;
    charHeight = nextCellHeightPhysical / dpr;
    physW = nextPhysW;
    physH = nextPhysH;
    committedPhysW = physW;
    committedPhysH = physH;
    offscreenCanvas = canvas;
    emojiCtx = nextEmojiCtx;
    activeFontFamilyKey = terminalFontFamilyKey(cmd.fontFamily);
    armFontStyleUpgrade(cmd.fontFamily, nextWasmTerminal);
    // The newly installed GPU has not received this WASM atlas yet.
    uploadedAtlasGeneration = 0;
    // Ownership transferred to installed globals.
    nextWasmTerminal = null;
    nextRenderer = null;

    if (replacingInstalledRuntime) frameRingReader.discardPending();
    startFrameRingPump();
    startPredictionRingPump();
  } finally {
    // Only non-null while preparation failed before the commit point.
    nextRenderer?.destroy();
    nextWasmTerminal?.destroy();
  }

  preparePreviewAtlas();
  self.postMessage({
    kind: 'ready',
    cols,
    rows,
    charWidth,
    charHeight,
    baseline: currentBaselineCss(),
  } satisfies WorkerEvent);
  workerReady = true;
  startPendingFontRegularPromotion();
  refreshCalibrator.start();
  if (replacingInstalledRuntime) requestDisplaySnapshot();
  postWorkerHealth();
}

function disposeInstalledRuntime(): void {
  stopFrameRingPump();
  stopPredictionRingPump();
  clearQueuedPredictions();
  predictionFastPath?.resetPublishedState();
  cancelViewerDeadline();
  presentationAnimationFrame.cancel();
  displayOutputSettle.reset();
  cancelFontStyleUpgrade();
  abortActiveFontFamilyUpdate('runtime retirement');
  refreshCalibrator.stop();
  displayReceiverCalibrationScheduler.cancel();
  renderMailbox.reset();
  cancelRenderOpportunity();
  renderSubmissions.contextDestroyed(discardLatencyToken);
  resetRenderGateAccumulators();
  retireWaitingGraphicsAsset();
  renderer?.destroy();
  // What the viewer still holds offscreen is never shown: its record closes
  // while the observer can still write it.
  wasmTerminal?.viewer.discard_presentation();
  wasmTerminal?.destroy();
  renderer = null;
  wasmTerminal = null;
  rendererContextLost = false;
  frameRingReader = null;
  viewerOutputPublisher = null;
  predictionFastPath = null;
  predictionAdmissionResolver = null;
  presentationCadenceWriter = null;
  offscreenCanvas = null;
  emojiCtx = null;
  workerReady = false;
  activeSessionEpoch = 0;
  activeFrameFenceToken = 0;
  predictionModelThroughInputSeq = 0;
  localPresentationPending = false;
  provisionalPreview.clear();
  presentedPredictionSources.reset();
  firstDisplayGpuFence.resetEpoch();
  lastMouseMode = -1;
  uploadedAtlasGeneration = 0;
  atlasPixelsView = null;
  pendingRasterMetrics = null;
  displaySurfaceResizePending = false;
  displayEpoch = {
    generation: 0,
    renderPending: false,
    pumpScheduled: false,
    stateReadyPending: false,
    stateAppliedPending: false,
    outputPresentedPending: false,
    lastFrameAtMs: 0,
    lastSnapshotAtMs: 0,
  };
  observedViewerFrames = 0;
  observedViewerSnapshots = 0;
  observedPresentationRevision = 0;
  observedViewerPresentations = 0;
  resumePresentationPending = false;
  resumeAppliedFrames = 0;
  graphicsOwner = '';
  graphicsResidents.clear();
  graphicsPresentationDirty = false;
  graphicsOfferSpaceReleased = false;
  pendingPresentationTrace = false;
  authoritativePresentationUrgent = false;
  displaySurfaceReplacementPending = false;
}

let frameRingPumpActive = false;

let frameRingPumpToken = 0;

let frameRingWaitPending = false;

let displayOwnerActive = false;

let displayOwnerDatagrams = 0;

function hasDisplayOwnerWork(): boolean {
  return frameRingReader?.hasPending() === true;
}

function startFrameRingPump(): void {
  if (frameRingPumpActive || frameRingReader === null) return;
  frameRingPumpActive = true;
  frameRingPumpToken = (frameRingPumpToken + 1) >>> 0;
  runDisplayPump();
}

function stopFrameRingPump(): void {
  frameRingPumpToken = (frameRingPumpToken + 1) >>> 0;
  frameRingPumpActive = false;
  frameRingWaitPending = false;
  displayPumpContinuation.cancel();
  displayEpoch.pumpScheduled = false;
  displayAvailableWake.wake();
  frameRingReader = null;
}

function continueDisplayOwner(): void {
  if (!frameRingPumpActive) return;
  if (hasDisplayOwnerWork()) {
    scheduleDisplayPumpContinuation();
    return;
  }
  const reader = frameRingReader;
  // A presentation/control callback can drain while an idle waiter exists.
  // There is exactly one park per generation, never one per caller.
  if (reader === null || frameRingWaitPending) return;
  const token = frameRingPumpToken;
  const result = reader.waitAsync();
  if (result === 'not-equal') {
    scheduleDisplayPumpContinuation();
    return;
  }
  frameRingWaitPending = true;
  void result.then(() => {
    if (token !== frameRingPumpToken) return;
    frameRingWaitPending = false;
    runDisplayPump();
  });
}

function consumeDisplayRingEntry(): boolean {
  const entry = frameRingReader?.tryReadLeased();
  if (entry === null || entry === undefined) {
    if (frameRingReader?.takeRefusal()) ringWakePort?.postMessage(FRAME_RING_SPACE_EDGE);
    return false;
  }
  try {
    const terminal = wasmTerminal;
    if (terminal !== null && entry.kind >= FRAME_KIND_CLIENT_INGRESS_BASE) {
      terminal.viewer.set_presentation_ready(
        renderer?.canSubmitFrame() === true && !rendererContextLost,
      );
      // `receive` reads the leased entry's mapping before the release below.
      terminal.receive(
        viewerNowMs(),
        entry.kind - FRAME_KIND_CLIENT_INGRESS_BASE,
        entry.payload,
        entry.inputSequenceMapping,
      );
      displayOwnerDatagrams++;
    }
  } finally {
    entry.release();
  }
  return true;
}

function applyCellMetrics(
  fontSize: number,
  lineHeight: number,
  dpr: number,
): { readonly widthPhysical: number; readonly heightPhysical: number } {
  if (wasmTerminal === null) {
    return { widthPhysical: 8, heightPhysical: 16 };
  }

  wasmTerminal.setCellMetrics(fontSize * dpr, lineHeight, dpr);
  wasmTerminal.viewer.set_cell_size(
    viewerNowMs(),
    wasmTerminal.cellMetrics()[0] ?? 8,
    wasmTerminal.cellMetrics()[1] ?? 16,
  );
  observeViewerPresentation();
  const metrics = wasmTerminal.cellMetrics();
  const widthPhysical = metrics[0] ?? 8;
  const heightPhysical = metrics[1] ?? 16;
  charWidth = widthPhysical / dpr;
  charHeight = heightPhysical / dpr;
  return { widthPhysical, heightPhysical };
}

function currentBaselineCss(): number {
  const metrics = wasmTerminal?.cellMetrics();
  const physical = metrics?.[2] ?? charHeight * currentDevicePixelRatio;
  const metricsDpr = metrics?.[3] ?? currentDevicePixelRatio;
  return physical / metricsDpr;
}

async function prepareFontFamilyUpdate(
  fontFamily: TerminalFontFamily,
  controller: AbortController,
  terminal: WasmClientViewerHandle,
  sessionEpoch: number,
): Promise<void> {
  const signal = controller.signal;
  try {
    let bytes: ArrayBuffer;
    try {
      terminalFontLoader.prefetchRegular(fontFamily, signal);
      bytes = await terminalFontLoader.loadBlocking(fontFamily, signal);
    } catch (error) {
      // Preserve the existing unavailable-custom-family policy. No terminal
      // state is changed by either fetch; only the owner commits ready bytes.
      if (
        signal.aborted ||
        terminalFontFamilyKey(fontFamily) === terminalFontFamilyKey(DEFAULT_TERMINAL_FONT)
      )
        throw error;
      fontFamily = DEFAULT_TERMINAL_FONT;
      terminalFontLoader.prefetchRegular(fontFamily, signal);
      bytes = await terminalFontLoader.loadBlocking(fontFamily, signal);
    }
    if (
      signal.aborted ||
      activeFontFamilyUpdateController !== controller ||
      wasmTerminal !== terminal ||
      activeSessionEpoch !== sessionEpoch
    )
      return;
    preparedFontFamilyUpdate = { controller, terminal, sessionEpoch, fontFamily, bytes };
    scheduleControlPump();
  } catch (error) {
    if (!signal.aborted && activeFontFamilyUpdateController === controller) reportFatal(error);
  } finally {
    if (
      activeFontFamilyUpdateController === controller &&
      preparedFontFamilyUpdate?.controller !== controller
    ) {
      activeFontFamilyUpdateController = null;
    }
  }
}

function commitPreparedFontFamilyUpdate(): void {
  const prepared = preparedFontFamilyUpdate;
  if (prepared === null) return;
  preparedFontFamilyUpdate = null;
  const { controller, terminal, sessionEpoch, fontFamily, bytes } = prepared;
  try {
    if (
      controller.signal.aborted ||
      activeFontFamilyUpdateController !== controller ||
      wasmTerminal !== terminal ||
      renderer === null ||
      activeSessionEpoch !== sessionEpoch
    )
      return;
    // Font parsing and CURRENT metrics/surface replacement are one synchronous
    // transaction. Resizes and metric changes during the fetch remain valid.
    const dpr = terminal.cellMetrics()[3] ?? currentDevicePixelRatio;
    terminal.setRegularFontBytes(new Uint8Array(bytes));
    installedFontTier = 'boot';
    activeFontFamilyKey = terminalFontFamilyKey(fontFamily);
    currentDevicePixelRatio = dpr;
    applyCellMetrics(currentFontSize, currentLineHeight, dpr);
    preparePreviewAtlas();
    updatePhysDimensions();
    resizeAndRenderDisplaySurface(true);
    armFontStyleUpgrade(fontFamily, terminal);
    startPendingFontRegularPromotion();
    if (firstDisplayGpuFence.isComplete()) startPendingFontStyleUpgrade();
  } finally {
    if (activeFontFamilyUpdateController === controller) activeFontFamilyUpdateController = null;
  }
}

function armFontStyleUpgrade(
  fontFamily: TerminalFontFamily,
  terminal: WasmClientViewerHandle,
): void {
  const generation = nextFontStyleUpgradeGeneration();
  if (installedFontTier === 'styled') {
    pendingFontStyleUpgrade = null;
    return;
  }
  pendingFontStyleUpgrade = {
    generation,
    terminal,
    fontFamily,
    fontFamilyKey: terminalFontFamilyKey(fontFamily),
  };
}

function cancelFontStyleUpgrade(): void {
  nextFontStyleUpgradeGeneration();
  pendingFontStyleUpgrade = null;
  regularPromotionInFlight = null;
  cancelFontPromotionRetry();
}

function nextFontStyleUpgradeGeneration(): number {
  fontStyleUpgradeGeneration =
    fontStyleUpgradeGeneration >= Number.MAX_SAFE_INTEGER ? 1 : fontStyleUpgradeGeneration + 1;
  return fontStyleUpgradeGeneration;
}

function startPendingFontStyleUpgrade(): void {
  const upgrade = pendingFontStyleUpgrade;
  if (upgrade === null) return;
  pendingFontStyleUpgrade = null;
  void completeFontStyleUpgrade(upgrade);
}

function startPendingFontRegularPromotion(): void {
  const upgrade = pendingFontStyleUpgrade;
  if (upgrade === null) return;
  // Full regular is glyph correctness, so let its already-prefetched request
  // finish independently of the first-display fence. Style faces remain behind
  // that fence. The promotion reapplies metrics synchronously before yielding,
  // preventing a reset font engine from exposing a low-resolution canvas.
  void ensureRegularFontPromotion(upgrade);
}

function ensureRegularFontPromotion(upgrade: FontStyleUpgrade): Promise<boolean> {
  const inFlight = regularPromotionInFlight;
  if (inFlight?.generation === upgrade.generation) return inFlight.promise;
  const promise = promoteBootFaceToRegular(upgrade).finally(() => {
    if (regularPromotionInFlight?.promise === promise) regularPromotionInFlight = null;
  });
  regularPromotionInFlight = { generation: upgrade.generation, promise };
  return promise;
}

const FONT_PROMOTION_RETRY_DELAYS_MS = [1_000, 5_000, 20_000, 60_000];

let fontPromotionRetryAttempt = 0;

let fontPromotionRetryTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleFontPromotionRetry(upgrade: FontStyleUpgrade): void {
  if (fontPromotionRetryTimer !== null) return;
  const delayMs = FONT_PROMOTION_RETRY_DELAYS_MS[fontPromotionRetryAttempt];
  if (delayMs === undefined) return;
  fontPromotionRetryAttempt += 1;
  fontPromotionRetryTimer = setTimeout(() => {
    fontPromotionRetryTimer = null;
    // A newer generation means a family switch or teardown superseded this
    // attempt; the guards inside would reject it anyway, so stop here.
    void completeFontStyleUpgrade({
      ...upgrade,
      generation: nextFontStyleUpgradeGeneration(),
    });
  }, delayMs);
}

function cancelFontPromotionRetry(): void {
  if (fontPromotionRetryTimer !== null) {
    clearTimeout(fontPromotionRetryTimer);
    fontPromotionRetryTimer = null;
  }
  fontPromotionRetryAttempt = 0;
}

async function promoteBootFaceToRegular(upgrade: FontStyleUpgrade): Promise<boolean> {
  if (installedFontTier !== 'boot') return true;

  let regular: ArrayBuffer;
  try {
    regular = await terminalFontLoader.loadRegular(upgrade.fontFamily);
  } catch (error) {
    postDisplayDiag('font_regular_promotion_failed', String(error), true);
    return false;
  }
  if (
    fontStyleUpgradeGeneration !== upgrade.generation ||
    wasmTerminal !== upgrade.terminal ||
    renderer === null ||
    activeFontFamilyKey !== upgrade.fontFamilyKey
  ) {
    return false;
  }

  try {
    upgrade.terminal.setRegularFontBytes(new Uint8Array(regular));
    installedFontTier = 'regular';
    applyInstalledFontMetrics();
    return true;
  } catch (error) {
    postDisplayDiag('font_regular_promotion_apply_failed', String(error), true);
    return false;
  }
}

async function completeFontStyleUpgrade(upgrade: FontStyleUpgrade): Promise<void> {
  if (!(await ensureRegularFontPromotion(upgrade))) {
    // The boot face is still installed, so the session is degraded rather than
    // broken: text renders, the omitted glyphs do not. The first-frame fence
    // fires once per epoch and will not call back, so retry on a timer.
    scheduleFontPromotionRetry(upgrade);
    return;
  }

  let styleBuffers: TerminalStyleFontBuffers;
  try {
    styleBuffers = await terminalFontLoader.loadStyleFaces(upgrade.fontFamily);
  } catch (error) {
    // Regular-first initialization is already usable. A style fetch failure
    // must stay non-fatal and can recover on a later explicit family update.
    postDisplayDiag('font_style_upgrade_failed', String(error), true);
    return;
  }
  if (
    fontStyleUpgradeGeneration !== upgrade.generation ||
    wasmTerminal !== upgrade.terminal ||
    renderer === null ||
    activeFontFamilyKey !== upgrade.fontFamilyKey
  ) {
    return;
  }

  try {
    const [fontBold, fontItalic, fontBoldItalic] = styleBuffers;
    // Preserve the regular face's immutable bytes, mapping and compiled glyphs.
    // Style faces compile outlines lazily as their glyphs enter the atlas.
    upgrade.terminal.setStyleFontBytes(
      new Uint8Array(fontBold),
      new Uint8Array(fontItalic),
      new Uint8Array(fontBoldItalic),
    );
    installedFontTier = 'styled';
    applyInstalledFontMetrics();
  } catch (error) {
    // Style enhancement must never take down a renderer that is already
    // serving the regular-face terminal.
    postDisplayDiag('font_style_upgrade_apply_failed', String(error), true);
  }
}

function applyInstalledFontMetrics(): void {
  // Font byte installation resets the font engine's cached cell metrics. DPR is
  // an environment property, not a value to rediscover from that reset cache.
  // Reapply it in the same task as the face swap so no compositor frame can
  // stretch an 8x16 fallback backing store over the mobile CSS grid.
  applyCellMetrics(currentFontSize, currentLineHeight, currentDevicePixelRatio);
  preparePreviewAtlas();
  updatePhysDimensions();
  resizeAndRenderDisplaySurface(true);
}

function drainDisplayQueue(budgetMs: number): void {
  if (displayOwnerActive) return;
  displayOwnerActive = true;
  const started = performance.now();
  const perfStarted = perfEnabled ? nowMs() : 0;
  const rowsBefore = perfEnabled ? (wasmTerminal?.viewer.applied_rows() ?? 0n) : 0n;
  const bytesBefore = perfEnabled ? (frameRingReader?.pendingBytes() ?? 0) : 0;
  displayOwnerDatagrams = 0;
  try {
    do {
      if (!consumeDisplayRingEntry()) break;
      if (
        controlQueue.hasDataPlaneBarrier() ||
        activeControlBlocksDataPlane ||
        (!controlPumpActive && controlQueueSize() > 0)
      )
        break;
    } while (performance.now() - started < budgetMs);
    wasmTerminal?.viewer.set_presentation_ready(
      renderer?.canSubmitFrame() === true && !rendererContextLost,
    );
    wasmTerminal?.viewer.present_now(viewerNowMs());
    observeViewerPresentation();
    drainViewerOutputs();
  } finally {
    displayOwnerActive = false;
  }
  publishPredictionModel();
  renderPredictionIfDirty();
  scheduleRenderFrame();
  armPresentationCommit();
  armViewerDeadline();
  if (perfEnabled && perfWriter !== null && displayOwnerDatagrams > 0) {
    const completed = nowMs();
    const appliedRows = Number((wasmTerminal?.viewer.applied_rows() ?? rowsBefore) - rowsBefore);
    emitDisplayPumpComplete(
      perfWriter,
      completed,
      Math.max(0, completed - perfStarted),
      budgetMs,
      displayOwnerDatagrams,
      appliedRows,
      displayOwnerDatagrams + displayQueueSize(),
      displayQueueSize(),
      bytesBefore,
      frameRingReader?.pendingBytes() ?? 0,
      frameRingReader?.droppedCount() ?? 0,
    );
    notePresentationGate(appliedRows);
  }
}

function onDisplayDemandFrame(frameTimeMs: number): void {
  applyViewerFrame(frameTimeMs);
}

function requestDisplaySnapshot(): void {
  wasmTerminal?.viewer.request_snapshot(viewerNowMs());
  drainViewerOutputs();
  armViewerDeadline();
}

function syncDimensionsFromWasm(): boolean {
  if (wasmTerminal === null) return false;
  const nextCols = Math.max(1, wasmTerminal.presentationCols());
  const nextRows = Math.max(1, wasmTerminal.presentationRows());
  if (nextCols === cols && nextRows === rows) return false;
  cols = nextCols;
  rows = nextRows;
  updatePhysDimensions();
  deferInFlightPerfCompletion('invalidated');
  displaySurfaceResizePending = true;
  return true;
}

function commitPendingDisplaySurfaceResize(): void {
  if (!displaySurfaceResizePending || renderer === null) return;
  displaySurfaceResizePending = false;
  resizeDisplaySurface(offscreenCanvas, renderer, physW, physH);
  renderViewportEpoch = (renderViewportEpoch + 1) >>> 0;
}

function markPendingPredictionRenderIfDirty(): void {
  if (!wasmTerminal?.predictionRenderDirty()) return;
  localPresentationPending = true;
  pendingRenderPredictionInputSeq =
    Math.max(pendingRenderPredictionInputSeq, latestPredictionInputSeq) >>> 0;
}

function sendPendingDisplayStateReady(): void {
  if (displayEpoch.stateReadyPending) {
    self.postMessage({
      kind: 'display_state_ready',
      cols,
      rows,
    } satisfies WorkerEvent);
    displayEpoch.stateReadyPending = false;
    postWorkerHealth();
  }
}

/**
 * A submitted presentation settles output and stales watched viewport rows;
 * one that changed the grid or its metrics also hands main the new layout.
 */
function publishPresentedOutput(): void {
  if (!displayEpoch.stateAppliedPending && !displayEpoch.outputPresentedPending) return;
  displayOutputSettle.noteFrame();
  if (displayEpoch.stateAppliedPending)
    self.postMessage({
      kind: 'display_state_applied',
      cols,
      rows,
      charWidth,
      charHeight,
      baseline: currentBaselineCss(),
    } satisfies WorkerEvent);
  noteViewportChanged();
}

function noteViewportChanged(): void {
  if (!viewportWatched) return;
  viewportWatched = false;
  self.postMessage({ kind: 'viewport_stale' } satisfies WorkerEvent);
}

function handleResize(cmd: Extract<WorkerCommand, { kind: 'resize' }>): void {
  requestedCols = Math.max(1, cmd.cols);
  requestedRows = Math.max(1, cmd.rows);
  if (!controlsGeometry || wasmTerminal === null || renderer === null) return;
  clearQueuedPredictions();
  revokePaintedPredictions();
  presentedPredictionSources.reset();
  if (wasmTerminal.viewer.cols() !== requestedCols || wasmTerminal.viewer.rows() !== requestedRows)
    resizeRequestedAtMs = perfEnabled ? viewerNowMs() : 0;
  wasmTerminal.viewer.resize(requestedCols, requestedRows);
  observeViewerPresentation();
  publishPredictionModel();
  noteViewportChanged();
  syncDimensionsFromWasm();
  updatePhysDimensions();
  deferInFlightPerfCompletion('invalidated');
  displaySurfaceResizePending = true;
  queueSurfaceReplacement(true);
  refreshCalibrator.requestBurst('resize');
  drainViewerOutputs();
  armViewerDeadline();
}

function handleFontUpdate(cmd: Extract<WorkerCommand, { kind: 'font_update' }>): void {
  queueRasterMetrics(
    cmd.fontSize,
    cmd.lineHeight,
    pendingRasterMetrics?.dpr ?? currentDevicePixelRatio,
  );
}

function queueRasterMetrics(fontSize: number, lineHeight: number, dpr: number): void {
  if (wasmTerminal === null || renderer === null) return;
  if (
    fontSize === currentFontSize &&
    lineHeight === currentLineHeight &&
    dpr === currentDevicePixelRatio
  ) {
    pendingRasterMetrics = null;
    return;
  }
  if (
    pendingRasterMetrics?.fontSize === fontSize &&
    pendingRasterMetrics.lineHeight === lineHeight &&
    pendingRasterMetrics.dpr === dpr
  )
    return;
  pendingRasterMetrics = { fontSize, lineHeight, dpr };
  queueSurfaceReplacement(true);
}

function commitPendingRasterMetrics(): void {
  const metrics = pendingRasterMetrics;
  if (metrics === null) return;
  pendingRasterMetrics = null;
  currentFontSize = metrics.fontSize;
  currentLineHeight = metrics.lineHeight;
  currentDevicePixelRatio = metrics.dpr;
  // Wait for the surface commit: prediction renders during a held transaction
  // must keep the old atlas, metrics and backing dimensions together.
  applyInstalledFontMetrics();
}

function handleFontFamilyUpdate(cmd: Extract<WorkerCommand, { kind: 'font_family_update' }>): void {
  abortActiveFontFamilyUpdate('superseded by family owner');
  if (wasmTerminal === null || renderer === null) return;
  if (terminalFontFamilyKey(cmd.fontFamily) === activeFontFamilyKey) return;
  cancelFontStyleUpgrade();
  const controller = new AbortController();
  activeFontFamilyUpdateController = controller;
  void prepareFontFamilyUpdate(cmd.fontFamily, controller, wasmTerminal, activeSessionEpoch);
}

function resizeAndRenderDisplaySurface(stateReady: boolean): void {
  if (renderer === null) return;
  const backingStoreWillReset =
    offscreenCanvas === null || offscreenCanvas.width !== physW || offscreenCanvas.height !== physH;
  if (backingStoreWillReset) {
    // The eventual dimension assignment invalidates visual timing ownership.
    // It remains deferred until an eligible authoritative replacement submits.
    deferInFlightPerfCompletion('invalidated');
  }
  displaySurfaceResizePending ||= backingStoreWillReset;
  queueSurfaceReplacement(stateReady);
}

function queueSurfaceReplacement(stateReady: boolean): void {
  displaySurfaceReplacementPending = true;
  localPresentationPending = true;
  markPendingPredictionRenderIfDirty();
  displayEpoch.renderPending = true;
  displayEpoch.stateReadyPending = displayEpoch.stateReadyPending || stateReady;
  displayEpoch.stateAppliedPending ||= stateReady;
  scheduleRenderFrame();
}

function handleThemeUpdate(cmd: Extract<WorkerCommand, { kind: 'theme_update' }>): void {
  if (wasmTerminal === null || renderer === null) return;
  if (!wasmTerminal.setTheme(terminalThemeBytes(cmd.theme))) return;
  // Restyle the eligible scene without exposing held rows or claiming a new
  // authoritative display application.
  renderer.setClearColor(cmd.theme.background);
  queueSurfaceReplacement(false);
}

function handleRenderRefresh(): void {
  if (wasmTerminal === null || renderer === null) return;
  updatePhysDimensions();
  const backingStoreWillReset =
    offscreenCanvas === null || offscreenCanvas.width !== physW || offscreenCanvas.height !== physH;
  deferInFlightPerfCompletion(backingStoreWillReset ? 'invalidated' : 'superseded');
  displaySurfaceResizePending = true;
  queueSurfaceReplacement(false);
  postWorkerHealth();
}

function terminalThemeBytes(theme: TerminalTheme): Uint8Array {
  const bytes = new Uint8Array(57);
  writeRgb(bytes, 0, theme.foreground);
  writeRgb(bytes, 3, theme.background);
  writeRgb(bytes, 6, theme.cursor);
  for (let index = 0; index < 16; index += 1) {
    writeRgb(bytes, 9 + index * 3, theme.palette[index] ?? theme.foreground);
  }
  return bytes;
}

function writeRgb(bytes: Uint8Array, offset: number, rgb: readonly [number, number, number]): void {
  bytes[offset] = rgb[0];
  bytes[offset + 1] = rgb[1];
  bytes[offset + 2] = rgb[2];
}

function handleShutdown(): void {
  cancelPerfGridConvergence();
  disposeInstalledRuntime();
  displayAvailableWake.dispose();
  ringWakePort?.close();
  ringWakePort = null;
  self.postMessage({ kind: 'shutdown_complete' } satisfies WorkerEvent);
  self.close();
}

function handlePredictFlush(inputSeq: number): void {
  wasmTerminal?.viewer.prediction_command(
    viewerNowMs(),
    inputSeq,
    PREDICTION_COMMAND_FLUSH,
    0,
    false,
  );
}

function handleRttSample(rttMs: number): void {
  if (!Number.isFinite(rttMs) || rttMs < 0) return;
  srttMs = srttMs === null ? rttMs : srttMs + tuning.pathRttEwmaAlpha * (rttMs - srttMs);
}

let observedPredictionAuthorityRevision = -1;

function publishPredictionModel(): void {
  const fastPath = predictionFastPath;
  if (fastPath === null) return;
  if (wasmTerminal === null) {
    fastPath.publishModel(false, 0, 0, 0, 0, 0, 0, predictionModelThroughInputSeq);
    return;
  }
  const authorityRevision = wasmTerminal.viewer.prediction_authority_revision();
  if (authorityRevision !== observedPredictionAuthorityRevision) {
    observedPredictionAuthorityRevision = authorityRevision;
    fastPath.invalidateModelRevision();
    revokePaintedPredictions();
  }
  fastPath.publishVisible(wasmTerminal.viewer.prediction_state() === 1);
  const model = wasmTerminal.predictionModel();
  fastPath.publishModel(
    predictionArmed(),
    model[0] ?? 0,
    model[1] ?? 0,
    model[2] ?? 0,
    model[3] ?? 0,
    model[4] ?? 0,
    model[5] ?? 0,
    predictionModelThroughInputSeq,
  );
}

function predictionArmed(): boolean {
  return wasmTerminal?.viewer.prediction_armed() === true;
}

function renderPredictionIfDirty(): void {
  if (!wasmTerminal?.predictionRenderDirty()) return;
  localPresentationPending = true;
  displayEpoch.renderPending = true;
  scheduleRenderFrame();
}

function rasterizeMissingGlyphs(): boolean {
  if (!wasmTerminal || !emojiCtx) return false;
  const missing = wasmTerminal.missingGlyphs();
  if (missing.length === 0) return false;

  const m = wasmTerminal.cellMetrics();
  const cw = Math.ceil((m[0] ?? 8) * 2); // 2× wide canvas to fit double-width glyphs
  const ch = Math.ceil(m[1] ?? 16);
  const baseline = m[2] ?? 13;
  const fontSize = Math.round(ch * 0.82);
  const oy = -Math.round(baseline); // shift so canvas-top aligns with cell-top

  if (emojiCtx.canvas.width !== cw || emojiCtx.canvas.height !== ch) {
    emojiCtx.canvas.width = cw;
    emojiCtx.canvas.height = ch;
    fallbackBoxSignature = null;
  }
  emojiCtx.font = `${fontSize}px Apple Color Emoji, Segoe UI Emoji, Noto Color Emoji, sans-serif`;
  emojiCtx.fillStyle = 'white';
  emojiCtx.textBaseline = 'alphabetic';

  const tofu = fallbackBoxSignatureFor(emojiCtx, cw, ch, baseline);

  let injected = false;
  // Flat [codepoint, style] pairs. The style matters: injection resolves the
  // exact slot it is given, so answering a bold miss at style 0 would leave the
  // bold slot unresolved and re-queued on the next build.
  for (let index = 0; index + 1 < missing.length; index += 2) {
    const cp = missing[index] ?? 0;
    const style = missing[index + 1] ?? 0;
    const r8 = rasterizeGlyphAlpha(emojiCtx, fallbackGlyphText(cp), cw, ch, baseline);
    // Nothing painted, or the engine painted its own last-resort box. Either way
    // this codepoint has no representation; leaving it un-injected lets the
    // atlas record it as unrenderable so it is never offered again.
    if (!r8.some((v) => v > 0)) continue;
    if (tofu !== null && alphaSignature(r8) === tofu) continue;
    // ox=0 (cell-left aligned); oy shifts canvas-top to cell-top
    if (wasmTerminal.injectGlyph(cp, style, cw, ch, 0, oy, r8)) injected = true;
  }
  wasmTerminal.finishMissingPass();
  return injected;
}

const EMOJI = /^\p{Emoji}$/u;

const EMOJI_PRESENTATION = /^\p{Emoji_Presentation}$/u;

const TEXT_PRESENTATION = '\uFE0E';

function fallbackGlyphText(cp: number): string {
  const glyph = String.fromCodePoint(cp);
  return EMOJI.test(glyph) && !EMOJI_PRESENTATION.test(glyph) ? glyph + TEXT_PRESENTATION : glyph;
}

function rasterizeGlyphAlpha(
  context: OffscreenCanvasRenderingContext2D,
  glyph: string,
  cw: number,
  ch: number,
  baseline: number,
): Uint8Array {
  context.clearRect(0, 0, cw, ch);
  context.fillText(glyph, 0, baseline);
  const { data } = context.getImageData(0, 0, cw, ch);
  const r8 = new Uint8Array(cw * ch);
  for (let i = 0; i < r8.length; i++) r8[i] = data[i * 4 + 3] ?? 0;
  return r8;
}

function alphaSignature(r8: Uint8Array): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < r8.length; i++) {
    hash ^= r8[i] ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function fallbackBoxSignatureFor(
  context: OffscreenCanvasRenderingContext2D,
  cw: number,
  ch: number,
  baseline: number,
): number | null {
  if (fallbackBoxSignature !== null) return fallbackBoxSignature;
  const reference = rasterizeGlyphAlpha(context, String.fromCodePoint(0xfffe), cw, ch, baseline);
  fallbackBoxSignature = reference.some((v) => v > 0) ? alphaSignature(reference) : null;
  return fallbackBoxSignature;
}

function preparePreviewAtlas(): void {
  wasmTerminal?.prepareSpeculativeAsciiAtlas();
}

function updatePreviewAuthority(): void {
  const terminal = wasmTerminal;
  const a = previewAuthority;
  a.epoch = activeSessionEpoch;
  a.modelVersion = predictionFastPath?.modelVersion() ?? 0;
  a.predictionSafe = terminal !== null && predictionArmed();
  a.predictionVisible = terminal?.viewer.prediction_state() === 1;
  a.preeditActive = preeditActive;
  a.cols = terminal?.presentationCols() ?? 0;
  a.rows = terminal?.presentationRows() ?? 0;
  a.inputSeq = Math.max(committedInputHighWater, latestPredictionInputSeq);
  a.atlasGeneration = terminal?.atlasGeneration() ?? 0;
  const cursor = terminal?.cursorInfo();
  a.col = cursor?.[0] ?? 0;
  a.row = cursor?.[1] ?? 0;
  a.cursorShape = cursor?.[2] ?? 0;
  a.cursorVisible = (cursor?.[3] ?? 0) !== 0;
  a.appendOnly = (cursor?.[4] ?? 0) !== 0;
  a.foreground = cursor === undefined ? 0 : packCursorRgb(cursor, 5);
  a.background = cursor === undefined ? 0 : packCursorRgb(cursor, 8);
}

function handleProvisionalPreviewSnapshot(snapshot: ProvisionalPreviewSnapshot): void {
  updatePreviewAuthority();
  if (!provisionalPreview.synchronize(snapshot, previewAuthority)) return;
  localPresentationPending = true;
  displayEpoch.renderPending = true;
  scheduleRenderFrame();
}

function preparePreviewGeometry(): void {
  const terminal = wasmTerminal;
  if (terminal === null) {
    provisionalPreview.clear();
    return;
  }
  updatePreviewAuthority();
  const metrics = terminal.cellMetrics();
  previewAtlas.entries = terminal.speculativeAsciiEntries();
  previewAtlas.generation = terminal.atlasGeneration();
  previewAtlas.width = terminal.atlasWidth();
  previewAtlas.height = terminal.atlasHeight();
  previewAtlas.cellWidth = metrics[0] ?? 0;
  previewAtlas.cellHeight = metrics[1] ?? 0;
  previewAtlas.baseline = metrics[2] ?? 0;
  provisionalPreview.buildGeometry(previewAuthority, previewAtlas);
}

function buildAndRender(): number {
  if (!wasmTerminal || !renderer) return 0;
  lastRenderUploadedAtlas = false;
  wasmTerminal.buildGeometry();
  if (rasterizeMissingGlyphs()) {
    wasmTerminal.buildGeometry();
    preparePreviewAtlas();
  }
  const atlasGeneration = wasmTerminal.atlasGeneration();
  const atlasDirty = wasmTerminal.atlasIsDirty();
  if (atlasDirty || atlasGeneration !== uploadedAtlasGeneration) {
    lastRenderUploadedAtlas = true;
    const atlasW = wasmTerminal.atlasWidth();
    const atlasH = wasmTerminal.atlasHeight();
    const dr = atlasDirty ? wasmTerminal.atlasDirtyRect() : null;
    const [dirtyX = 0, dirtyY = 0, dirtyX2 = atlasW, dirtyY2 = atlasH] = dr ?? [];
    const ptr = wasmTerminal.atlasPixelsPtr();
    const pixels = viewWasmU8(wasmTerminal.memory.buffer, ptr, atlasW * atlasH);
    renderer.uploadAtlas(
      pixels,
      [dirtyX, dirtyY, dirtyX2 - dirtyX, dirtyY2 - dirtyY],
      [atlasW, atlasH],
    );
    uploadedAtlasGeneration = atlasGeneration;
    wasmTerminal.atlasMarkClean();
  }
  preparePreviewGeometry();
  const submissionId = renderFrame();
  if (submissionId !== 0) captureInFlightCursorPosition();
  wasmTerminal.clearPredictionRenderDirty();
  return submissionId;
}

const EMPTY_PREDICTION_PERF: PredictionPerfSnapshot = {
  predictionInputSeq: 0,
  visiblePredictionInputSeqs: [],
  visiblePredictionInputSeqsTruncated: false,
};

const TRUNCATED_PREDICTION_PERF: PredictionPerfSnapshot = {
  predictionInputSeq: 0,
  visiblePredictionInputSeqs: [],
  visiblePredictionInputSeqsTruncated: true,
};

function snapshotPredictionPerfEffects(): PredictionPerfSnapshot {
  if (!perfEnabled || wasmTerminal === null) {
    return EMPTY_PREDICTION_PERF;
  }
  const visible = wasmTerminal.visiblePredictionInputSeqs();
  const clearEffectPairs = wasmTerminal.visiblePredictionClearEffectPairs();
  if (
    wasmTerminal.visiblePredictionInputSeqsTruncated() ||
    clearEffectPairs.length % 2 !== 0 ||
    visible.length + clearEffectPairs.length / 2 > MAX_VISIBLE_PREDICTION_PERF_SEQS
  ) {
    return TRUNCATED_PREDICTION_PERF;
  }

  const exact: number[] = [];
  let highWater = 0;
  for (const inputSeq of visible) {
    if (!Number.isSafeInteger(inputSeq) || inputSeq <= 0) {
      return TRUNCATED_PREDICTION_PERF;
    }
    exact.push(inputSeq);
    highWater = Math.max(highWater, inputSeq) >>> 0;
  }
  for (let index = 0; index < clearEffectPairs.length; index += 2) {
    const inputSeq = clearEffectPairs[index] ?? 0;
    const clearedInputSeq = clearEffectPairs[index + 1] ?? 0;
    if (
      !Number.isSafeInteger(inputSeq) ||
      inputSeq <= 0 ||
      !Number.isSafeInteger(clearedInputSeq) ||
      clearedInputSeq <= 0
    ) {
      return TRUNCATED_PREDICTION_PERF;
    }
    // A backspace is visibly predictive only when the glyph it removes was
    // present in a prior GPU-completed frame. Coalesced create/remove actions
    // that never reached the display must not manufacture coverage.
    if (!presentedPredictionSources.sourceWasPresented(clearedInputSeq)) continue;
    exact.push(inputSeq);
    highWater = Math.max(highWater, inputSeq) >>> 0;
  }
  return {
    predictionInputSeq: highWater,
    visiblePredictionInputSeqs: exact,
    visiblePredictionInputSeqsTruncated: false,
  };
}

let lastCursorCol = -1;

let lastCursorRow = -1;

let lastCursorVisible = -1;

function captureInFlightCursorPosition(): void {
  if (wasmTerminal === null) {
    abandonInFlightCursorPosition();
    return;
  }
  const info = wasmTerminal.cursorInfo();
  inFlightCursorCol = info[0] ?? 0;
  inFlightCursorRow = info[1] ?? 0;
  inFlightCursorVisible = (info[3] ?? 0) !== 0;
  inFlightCursorValid = true;
  // The journal samples this eligible/predicted base cursor, excluding the
  // separate UNSENT provisional cursor pass. It is not physical-paint evidence.
  // Drain it now while it still describes the base snapshot copied above.
  drainCursorMotionJournal();
}

function publishInFlightCursorPosition(): void {
  if (!inFlightCursorValid) return;
  inFlightCursorValid = false;
  if (
    inFlightCursorCol === lastCursorCol &&
    inFlightCursorRow === lastCursorRow &&
    Number(inFlightCursorVisible) === lastCursorVisible
  ) {
    return;
  }
  lastCursorCol = inFlightCursorCol;
  lastCursorRow = inFlightCursorRow;
  lastCursorVisible = Number(inFlightCursorVisible);
  self.postMessage({
    kind: 'cursor_position',
    col: inFlightCursorCol,
    row: inFlightCursorRow,
    visible: inFlightCursorVisible,
  } satisfies WorkerEvent);
}

function abandonInFlightCursorPosition(): void {
  inFlightCursorValid = false;
}

function drainCursorMotionJournal(): void {
  const terminal = wasmTerminal;
  if (terminal === null || !perfEnabled || terminal.cursorMotionLength() === 0) return;
  const records = terminal.cursorMotion();
  const stride = cursorMotionRecordWords();
  // One stamp for the whole drain: the records were journalled inside the
  // apply/reconcile that this render is presenting, and this is when they
  // become observable.
  const drainedAtMs = nowMs();
  // What authority had covered when the steps became observable, beside the
  // newest keystroke the model accepted.
  const authoritativeInputSeq = terminal.viewer.authoritative_input();
  for (let index = 0; index + stride <= records.length; index += stride) {
    const causeCode = records[index + 1] ?? 0;
    const cause = cursorCauseName(causeCode);
    const from = records[index + 2] ?? 0;
    const to = records[index + 3] ?? 0;
    const flags = records[index + 4] ?? 0;
    const last = records[index + 5] ?? 0;
    if (cause === 'AuthorityShape') {
      // The authoritative cursor changed shape or visibility without moving:
      // the words carry `shape << 8 | visible` and the header's sequence.
      postDisplayDiag(
        'cursor_shape_changed',
        `from=shape:${from >>> 8},visible:${from & 0xff} ` +
          `to=shape:${to >>> 8},visible:${to & 0xff} ` +
          `flags=0x${flags.toString(16)} seq=${last}`,
        true,
      );
      if (perfWriter !== null) {
        emitCursorShape(
          perfWriter,
          drainedAtMs,
          from >>> 8,
          from & 0xff,
          to >>> 8,
          to & 0xff,
          flags,
          last,
        );
      }
      continue;
    }
    postDisplayDiag(
      'cursor_stepped_backwards',
      `cause=${cause} ` +
        `from=${from >>> 16},${from & 0xffff} to=${to >>> 16},${to & 0xffff} ` +
        `flags=0x${flags.toString(16)} ops=${last}`,
      true,
    );
    if (perfWriter !== null) {
      emitCursorStep(
        perfWriter,
        drainedAtMs,
        causeCode,
        from >>> 16,
        from & 0xffff,
        to >>> 16,
        to & 0xffff,
        flags,
        last,
        records[index] ?? 0,
        latestPredictionInputSeq,
        authoritativeInputSeq,
      );
    }
  }
  const dropped = terminal.cursorMotionDropped();
  if (dropped > 0) {
    postDisplayDiag('cursor_motion_journal_overflow', `dropped=${dropped}`);
  }
  terminal.clearCursorMotion();
}

function packCursorRgb(info: Uint16Array, offset: number): number {
  return (
    (((info[offset] ?? 0) & 0xff) << 16) |
    (((info[offset + 1] ?? 0) & 0xff) << 8) |
    ((info[offset + 2] ?? 0) & 0xff)
  );
}

function presentationRenderIsBlocked(): boolean {
  return activeControlBlocksDataPlane || controlQueue.hasDataPlaneBarrier();
}

function scheduleRenderFrame(urgentRows = false): void {
  if (!displayEpoch.renderPending || displayRenderExecuting || rendererContextLost) return;
  if (presentationRenderIsBlocked()) return;
  dispatchMailboxAction(noteRenderWanted(urgentRows));
}

function noteRenderWanted(urgentRows = false): MailboxAction {
  return renderMailbox.noteDirty(urgentRows || authoritativePresentationUrgent);
}

function dispatchMailboxAction(action: MailboxAction): void {
  if (presentationRenderIsBlocked()) {
    if (perfEnabled) {
      accumulateRenderGateWait(nowMs());
      renderGateWaitKind = 'none';
    }
    cancelRenderOpportunity();
    // `advance` claimed the render by clearing dirty and setting
    // awaitingSubmit. Restore it without submitting; the hold's release owns
    // the next scheduling edge. This also covers a fence completing while a
    // coherent transaction is open.
    if (action.kind === 'render-now') renderMailbox.noteRenderAborted();
    return;
  }
  if (perfEnabled) noteRenderGateAction(action);
  if (action.kind === 'render-now') {
    cancelRenderOpportunity();
    executeRender();
  } else if (action.kind === 'wait-frame') {
    armRenderOpportunity();
  } else if (action.kind === 'wait-fence') {
    // Only real completion can resolve overload. Do not spin a deadline/rAF
    // loop while input, received state and selective ACK continue independently.
    cancelRenderOpportunity();
  }
}

function cancelRenderOpportunity(): void {
  renderAnimationFrame.cancel();
}

function armRenderOpportunity(): void {
  if (!renderAnimationFrame.isArmed()) renderAnimationFrame.arm(onRenderAnimationFrame);
}

function onRenderAnimationFrame(frameTimeMs: number): void {
  refreshRate.sample(frameTimeMs, false);
  publishPresentationPeriod();
  // Ingestion may already have posted work. Apply one bounded owner slice before
  // choosing the latest scene; do not recursively drain an unbounded burst.
  if (hasDisplayOwnerWork()) runDisplayPump();
  // After the slice, so a state it applied counts toward this frame's grant.
  onDisplayDemandFrame(frameTimeMs);
  dispatchMailboxAction(renderMailbox.noteOpportunity(frameTimeMs));
}

function noteRenderGateAction(action: MailboxAction): void {
  if (action.kind === 'none') return;
  // The one post-submit idle observation does not open another render's wait.
  if (action.kind === 'wait-frame' && !renderMailbox.renderQueued()) return;
  const atMs = nowMs();
  accumulateRenderGateWait(atMs);
  renderGateWaitKind =
    action.kind === 'wait-fence' ? 'fence' : action.kind === 'wait-frame' ? 'opportunity' : 'none';
  renderGateWaitStartedAtMs = atMs;
  if (renderGateWantedAtMs === 0) renderGateWantedAtMs = atMs;
  if (action.kind === 'wait-fence') {
    renderGateFenceReleasePending = true;
    renderGateFenceReleasedAtMs = 0;
    renderGateFenceReleasedRenderSeq = 0;
    if (renderGateFenceEnteredAtMs === 0) renderGateFenceEnteredAtMs = atMs;
  } else if (action.kind === 'wait-frame' && renderMailbox.renderQueued()) {
    if (renderGateOpportunityEnteredAtMs === 0) {
      renderGateOpportunityEnteredAtMs = atMs;
      // The wait now ends at the next animation frame, so the expected cost is
      // one refresh period rather than the distance to a scheduled timer.
      renderGateOpportunityDelayMs = refreshRate.presentationPeriodMs();
    }
  }
}

function accumulateRenderGateWait(atMs: number): void {
  const elapsed = Math.max(0, atMs - renderGateWaitStartedAtMs);
  if (renderGateWaitKind === 'fence') renderGateFenceWaitMs += elapsed;
  else if (renderGateWaitKind === 'opportunity') renderGateOpportunityWaitMs += elapsed;
  renderGateWaitStartedAtMs = atMs;
}

function renderGateLabel(): TerminalRenderGate {
  if (renderGateFenceEnteredAtMs !== 0)
    return renderGateOpportunityEnteredAtMs !== 0 ? 'fence-and-opportunity' : 'fence';
  return renderGateOpportunityEnteredAtMs !== 0 ? 'opportunity' : 'immediate';
}

function resetRenderGateAccumulators(): void {
  renderGateWantedAtMs = 0;
  renderGateFenceEnteredAtMs = 0;
  renderGateFenceReleasedAtMs = 0;
  renderGateFenceReleasedRenderSeq = 0;
  renderGateOpportunityEnteredAtMs = 0;
  renderGateOpportunityDelayMs = 0;
  renderGateWaitKind = 'none';
  renderGateWaitStartedAtMs = 0;
  renderGateFenceWaitMs = 0;
  renderGateOpportunityWaitMs = 0;
  renderGateFenceReleasePending = false;
}

function onGpuFrameComplete(submissionId: number): void {
  wasmTerminal?.viewer.set_presentation_ready(
    renderer?.canSubmitFrame() === true && !rendererContextLost,
  );
  wasmTerminal?.viewer.present_now(viewerNowMs());
  observeViewerPresentation();
  drainViewerOutputs();
  const frame = renderSubmissions.retire(submissionId);
  const valid =
    frame.semanticValid &&
    frame.sessionEpoch === activeSessionEpoch &&
    frame.generation === displayEpoch.generation;
  const completedAtMs = perfEnabled ? nowMs() : 0;
  if (frame.trackerToken !== null) {
    if (valid) presentedPredictionSources.noteFrameCompleted(frame.trackerToken);
    else presentedPredictionSources.discardFrame(frame.trackerToken);
  }
  if (frame.perfWriter !== null && frame.perfWriter === perfWriter && frame.perf !== null) {
    emitFrameComplete(
      frame.perfWriter,
      completedAtMs,
      frame.renderSeq,
      frame.perf.displayInputSeq,
      frame.perf.predictionInputSeq,
      frame.queueDepth,
      frame.perf.visiblePredictionInputSeqs,
      frame.perf.visiblePredictionInputSeqsTruncated,
      0,
      0,
      !valid
        ? 'invalidated'
        : renderSubmissions.isLatest(frame)
          ? 'latest-submitted'
          : 'superseded',
    );
  }
  if (valid && frame.firstDisplayOwner) {
    const firstDisplayFrame = firstDisplayGpuFence.noteCompleted(true);
    if (firstDisplayFrame !== null) {
      self.postMessage({
        kind: 'first_display_gpu_complete',
        ...firstDisplayFrame,
      } satisfies WorkerEvent);
      startPendingFontStyleUpgrade();
      if (!displayReceiverCalibrationSettled)
        displayReceiverCalibrationScheduler.start(
          firstDisplayFrame.sessionEpoch,
          firstDisplayFrame.generation,
        );
    }
  }
  const completedRenderSeq = frame.renderSeq;
  renderSubmissions.release(frame);
  const action = renderMailbox.noteFrameComplete(submissionId);
  if (
    perfEnabled &&
    renderGateFenceReleasePending &&
    action.kind !== 'wait-fence' &&
    action.kind !== 'none' &&
    renderer?.canSubmitFrame()
  ) {
    // Resource pressure may need several completions. Credit only the callback
    // that actually releases admission, not the first to arrive.
    if (renderGateWaitKind === 'fence') {
      accumulateRenderGateWait(completedAtMs);
      renderGateWaitKind = 'none';
    }
    renderGateFenceReleasePending = false;
    renderGateFenceReleasedAtMs = completedAtMs;
    renderGateFenceReleasedRenderSeq = completedRenderSeq;
  }
  dispatchMailboxAction(action);
  // Returning a held mailbox claim above must precede this retry. A matched
  // claim that waited on the last GPU owner need not also wait for another frame.
  scheduleRenderFrame();
}

function discardLatencyToken(token: number): void {
  presentedPredictionSources.discardFrame(token);
}

function abandonInFlightLatencyFrame(): void {
  abandonInFlightCursorPosition();
  renderSubmissions.invalidateSemantics(discardLatencyToken);
  firstDisplayGpuFence.abandonSubmitted();
}

function deferInFlightPerfCompletion(
  completionDisposition: Extract<TerminalFrameCompletionDisposition, 'superseded' | 'invalidated'>,
): void {
  // A newer state does not invalidate completion of an older submitted image.
  if (completionDisposition === 'invalidated') abandonInFlightLatencyFrame();
}

function armPresentationCommit(): void {
  if (wasmTerminal?.viewer.wants_frame(graphicsVisible) && !presentationAnimationFrame.isArmed())
    presentationAnimationFrame.arm(onViewerAnimationFrame);
}

function presentationReleaseBlockedByControl(): boolean {
  return (
    activeControlBlocksDataPlane ||
    controlQueue.hasDataPlaneBarrier() ||
    (!controlPumpActive && controlQueueSize() > 0)
  );
}

function executeRender(): void {
  if (
    !displayEpoch.renderPending ||
    wasmTerminal === null ||
    rendererContextLost ||
    renderer === null
  ) {
    dispatchMailboxAction(renderMailbox.noteRenderAborted());
    return;
  }
  if (!renderer.canSubmitFrame()) {
    renderMailbox.noteRenderAborted();
    if (perfEnabled) noteRenderGateAction({ kind: 'wait-fence' });
    return;
  }
  displayRenderExecuting = true;
  const submission = renderSubmissions.reserve();
  let submitted = false;
  try {
    commitPendingRasterMetrics();
    syncDimensionsFromWasm();
    updatePhysDimensions();
    sendPendingDisplayStateReady();
    const surfaceChanged = displaySurfaceResizePending || displaySurfaceReplacementPending;
    commitPendingDisplaySurfaceResize();
    committedPhysW = physW;
    committedPhysH = physH;
    const inputSeq = wasmTerminal.viewer.authoritative_input();
    renderStateRevision = wasmTerminal.presentationRevision();
    if (localPresentationPending) renderPredictionRevision = (renderPredictionRevision + 1) >>> 0;
    if (perfEnabled) {
      renderPerfSeq = (renderPerfSeq + 1) >>> 0 || 1;
      if (perfWriter !== null)
        emitRenderStart(
          perfWriter,
          nowMs(),
          renderPerfSeq,
          inputSeq,
          0,
          displayQueueSize(),
          renderGateWantedAtMs,
          renderGateLabel(),
          renderGateFenceReleasedAtMs,
          renderGateFenceReleasedRenderSeq,
          renderGateOpportunityEnteredAtMs,
          renderGateOpportunityDelayMs,
          refreshRate.presentationPeriodMs(),
          refreshRate.confidence01(),
          renderGateFenceWaitMs,
          renderGateOpportunityWaitMs,
        );
      resetRenderGateAccumulators();
    }
    const beforeBg = geometryRenderState.versions.bg;
    const beforeGlyph = geometryRenderState.versions.glyph;
    const beforeDeco = geometryRenderState.versions.deco;
    const beforeCursor = geometryRenderState.versions.cursor;
    const submissionId = buildAndRender();
    if (rendererContextLost || submissionId === 0) return;
    submission.sessionEpoch = activeSessionEpoch;
    submission.generation = displayEpoch.generation;
    submission.viewportEpoch = renderViewportEpoch;
    submission.stateRevision = renderStateRevision;
    submission.predictionRevision = renderPredictionRevision;
    renderSubmissions.commit(submission, submissionId);
    submitted = true;
    publishInFlightCursorPosition();
    publishPredictionModel();
    const predictionPerf = snapshotPredictionPerfEffects();
    submission.renderSeq = renderPerfSeq;
    submission.queueDepth = displayQueueSize();
    submission.perfWriter = perfEnabled ? perfWriter : null;
    submission.perf = perfEnabled ? { displayInputSeq: inputSeq, ...predictionPerf } : null;
    const firstAlreadySubmitted = firstDisplayGpuFence.hasInFlight();
    firstDisplayGpuFence.noteSubmitted(true);
    submission.firstDisplayOwner = !firstAlreadySubmitted && firstDisplayGpuFence.hasInFlight();
    submission.trackerToken = recordLatencyFrameSubmitted();
    if (perfEnabled && perfWriter !== null) {
      // Both records describe this exact successful submission. Sampling again
      // for its commit would place it after render_end and break the fence join.
      const submittedAtMs = nowMs();
      emitRenderEnd(
        perfWriter,
        submittedAtMs,
        renderPerfSeq,
        inputSeq,
        predictionPerf.predictionInputSeq,
        submission.queueDepth,
        predictionPerf.visiblePredictionInputSeqs,
        predictionPerf.visiblePredictionInputSeqsTruncated,
        'gpu-queue',
        lastRenderUploadedAtlas,
        false,
      );
      if (pendingPresentationTrace) {
        pendingPresentationTrace = false;
        presentationTransactionSeq = (presentationTransactionSeq + 1) >>> 0 || 1;
        const changed =
          surfaceChanged ||
          beforeBg !== geometryRenderState.versions.bg ||
          beforeGlyph !== geometryRenderState.versions.glyph ||
          beforeDeco !== geometryRenderState.versions.deco ||
          beforeCursor !== geometryRenderState.versions.cursor;
        emitViewerPresentationCommit(perfWriter, submittedAtMs, renderPerfSeq, changed);
      }
    }
    publishPresentedOutput();
    displaySurfaceReplacementPending = false;
    displayEpoch.stateAppliedPending = false;
    displayEpoch.outputPresentedPending = false;
    displayEpoch.renderPending = false;
    authoritativePresentationUrgent = false;
    localPresentationPending = false;
    committedInputHighWater = inputSeq;
  } finally {
    if (!submitted) {
      displayEpoch.renderPending = true;
      abandonInFlightCursorPosition();
      renderSubmissions.abortReserved(submission);
    }
    displayRenderExecuting = false;
    const action = submitted
      ? renderMailbox.noteSubmitted(performance.now(), submission.submissionId)
      : renderMailbox.noteRenderAborted();
    dispatchMailboxAction(action);
    if (
      !submitted &&
      !rendererContextLost &&
      !presentationRenderIsBlocked() &&
      renderer.canSubmitFrame()
    )
      armRenderOpportunity();
  }
}

function recordLatencyFrameSubmitted(): number | null {
  if (wasmTerminal === null || renderer?.frameInFlight() !== true) {
    presentedPredictionSources.reset();
    return null;
  }
  return presentedPredictionSources.noteFrameSubmitted(
    wasmTerminal.visiblePredictionInputSeqs(),
    wasmTerminal.visiblePredictionInputSeqsTruncated(),
  );
}

function renderFrame(): number {
  if (wasmTerminal === null || renderer === null) return 0;
  const packed = wasmTerminal.geometryState();
  updateGeometryRenderState(geometryRenderState, packed, committedPhysW, committedPhysH);
  return renderer.render(
    wasmTerminal.memory.buffer,
    geometryRenderState.bg,
    geometryRenderState.glyph,
    geometryRenderState.deco,
    geometryRenderState.cursor,
    geometryRenderState.viewport,
    geometryRenderState.versions,
    provisionalPreview.geometry,
  );
}

function updatePhysDimensions(): void {
  if (wasmTerminal === null) return;
  const metrics = wasmTerminal.cellMetrics();
  const cellWPhys = metrics[0] ?? 8;
  const cellHPhys = metrics[1] ?? 16;
  physW = Math.round(cols * cellWPhys);
  physH = Math.round(rows * cellHPhys);
}

function viewWasmU8(buffer: ArrayBufferLike, ptr: number, len: number): Uint8Array {
  if (atlasPixelsView === null || atlasPixelsBuffer !== buffer || atlasPixelsLength !== len) {
    atlasPixelsBuffer = buffer;
    atlasPixelsLength = len;
    atlasPixelsView = new Uint8Array(buffer, ptr, len);
    return atlasPixelsView;
  }

  if (atlasPixelsView.byteOffset !== ptr) {
    atlasPixelsView = new Uint8Array(buffer, ptr, len);
  }
  return atlasPixelsView;
}

const peerFences: ClientSessionFence[] = [];

let observedViewerFrames = 0;

let observedViewerSnapshots = 0;

let observedPresentationRevision = 0;
let observedViewerPresentations = 0;
let resumePresentationPending = false;
let resumeAppliedFrames = 0;

const viewerDeadline = createOwnedTimeout(
  (callback, delay) => setTimeout(callback, delay),
  (handle) => clearTimeout(handle),
);

// The core deadline the viewer timer is armed for, NaN when none is. Every
// display pump and frame asks again; an unchanged deadline keeps its timer
// rather than clearing and setting it.
let armedViewerDeadline = Number.NaN;

function onViewerDeadline(): void {
  armedViewerDeadline = Number.NaN;
  wasmTerminal?.viewer.set_presentation_ready(
    renderer?.canSubmitFrame() === true && !rendererContextLost,
  );
  wasmTerminal?.viewer.handle_timeout(viewerNowMs());
  observeViewerPresentation();
  drainViewerOutputs();
  publishPredictionModel();
  renderPredictionIfDirty();
  scheduleRenderFrame();
  armPresentationCommit();
  armViewerDeadline();
}

function cancelViewerDeadline(): void {
  viewerDeadline.cancel();
  armedViewerDeadline = Number.NaN;
}

function armViewerDeadline(): void {
  const deadline = wasmTerminal?.viewer.next_deadline() ?? Infinity;
  if (deadline === armedViewerDeadline) return;
  cancelViewerDeadline();
  if (!Number.isFinite(deadline)) return;
  armedViewerDeadline = deadline;
  viewerDeadline.arm(onViewerDeadline, Math.max(0, deadline - viewerNowMs()));
}

function applyViewerFrame(frameTimeMs: number): void {
  const terminal = wasmTerminal;
  if (terminal === null || presentationReleaseBlockedByControl()) return;
  terminal.viewer.set_presentation_ready(
    renderer?.canSubmitFrame() === true && !rendererContextLost,
  );
  // The frame time is on `viewerNowMs`'s timeline, so it orders exactly
  // against every apply and hold the core stamped.
  terminal.viewer.frame(
    WORKER_TIME_ORIGIN_MS + frameTimeMs,
    refreshRate.presentationPeriodMs(),
    graphicsVisible,
    srttMs ?? -1,
  );
  lastViewerFrameAtMs = nowMs();
  observeViewerPresentation();
  drainViewerOutputs();
  publishPredictionModel();
  renderPredictionIfDirty();
  scheduleRenderFrame();
  armViewerDeadline();
}

/** When the core was last offered a display frame; -1 before the first. */
let lastViewerFrameAtMs = -1;
/** Presentations counted at the last pump that applied rows, per lineage. */
let presentationsAtLastRowPump = -1;

/**
 * A pump applied rows and nothing was presented since the previous pump that
 * did: record every gate between applied and shown state. Normal output
 * presents between pumps and records nothing.
 */
function notePresentationGate(appliedRows: number): void {
  const terminal = wasmTerminal;
  const writer = perfWriter;
  if (terminal === null || writer === null || appliedRows === 0) return;
  const presentations = terminal.viewer.applied_presentations();
  const stalled = presentations === presentationsAtLastRowPump;
  presentationsAtLastRowPump = presentations;
  if (!stalled) return;
  const workerGates =
    Number(presentationAnimationFrame.isArmed()) |
    (Number(terminal.viewer.wants_frame(graphicsVisible)) << 1) |
    (Number(activeControlBlocksDataPlane) << 2) |
    (Number(controlQueue.hasDataPlaneBarrier()) << 3) |
    (Number(controlPumpActive) << 4) |
    (Number(controlQueueSize() > 0) << 5) |
    (Number(graphicsVisible) << 6) |
    (Number(renderer?.canSubmitFrame() === true) << 7) |
    (Number(rendererContextLost) << 8) |
    (Number(controlsGeometry) << 9) |
    (Number(renderAnimationFrame.isArmed()) << 10) |
    (Number(firstDisplayGpuFence.awaitingFirstApplied()) << 11);
  const at = nowMs();
  emitPresentationGate(
    writer,
    at,
    (terminal.viewer.presentation_gates() | (workerGates << 16)) >>> 0,
    lastViewerFrameAtMs < 0 ? -1 : at - lastViewerFrameAtMs,
    activeFrameFenceToken,
    terminal.viewer.cols(),
    terminal.viewer.rows(),
    terminal.viewer.presentation_cols(),
    terminal.viewer.presentation_rows(),
  );
}

function onViewerAnimationFrame(frameTimeMs: number): void {
  if (presentationReleaseBlockedByControl()) {
    armPresentationCommit();
    return;
  }
  if (hasDisplayOwnerWork()) runDisplayPump();
  applyViewerFrame(frameTimeMs);
  armPresentationCommit();
}

function observeViewerPresentation(): void {
  const terminal = wasmTerminal;
  if (terminal === null) return;
  const viewer = terminal.viewer;
  if (graphicsOfferSpaceReleased) {
    graphicsOfferSpaceReleased = false;
    retryWaitingGraphicsAsset();
  }
  const generation = viewer.generation();
  if (displayEpoch.generation !== generation) {
    abandonInFlightLatencyFrame();
    firstDisplayGpuFence.resetEpoch();
  }
  displayEpoch.generation = generation;
  if (graphicsPresentationDirty) {
    graphicsPresentationDirty = false;
    localPresentationPending = true;
    displayEpoch.renderPending = true;
  }

  if (renderer !== null) {
    for (const key of graphicsResidents) {
      if (!renderer.hasGraphicsTile(key)) {
        graphicsResidents.delete(key);
        viewer.set_graphics_resident(viewerNowMs(), graphicsEpoch, key, false);
      }
    }
  }

  publishViewerLinks();
  const mode = terminal.mouseMode();
  if (mode !== lastMouseMode) {
    lastMouseMode = mode;
    self.postMessage({ kind: 'mouse_mode_changed', mode } satisfies WorkerEvent);
  }
  const frames = viewer.applied_frames();
  if (frames !== observedViewerFrames) {
    observedViewerFrames = frames;
    displayEpoch.lastFrameAtMs = performance.now();
    const snapshots = viewer.applied_snapshots();
    if (snapshots !== observedViewerSnapshots) {
      observedViewerSnapshots = snapshots;
      displayEpoch.lastSnapshotAtMs = performance.now();
    }
    self.postMessage({
      kind: 'display_frame_applied',
      generation: displayEpoch.generation,
      frameId: viewer.applied_frame_id(),
      displayKind: viewer.applied_snapshot() ? 'display_snapshot' : 'display_delta',
    } satisfies WorkerEvent);
  }
  if (perfEnabled && viewer.take_presentation_trace()) {
    presentationTraceWords.set(
      new Uint32Array(terminal.memory.buffer, viewer.trace_words_ptr(), 18),
    );
    presentationTraceTimes.set(
      new Float64Array(terminal.memory.buffer, viewer.trace_times_ptr(), 5),
    );
    rebasePresentationTraceTimes(presentationTraceTimes, timeOriginDriftMs());
    pendingPresentationTrace = true;
  }
  const revision = terminal.presentationRevision();
  const presentations = viewer.applied_presentations();
  if (presentations !== observedViewerPresentations || revision !== observedPresentationRevision) {
    observedViewerPresentations = presentations;
    observedPresentationRevision = revision;
    displayEpoch.renderPending = true;
    authoritativePresentationUrgent = true;
    displayEpoch.outputPresentedPending = true;
    if (firstDisplayGpuFence.awaitingFirstApplied())
      firstDisplayGpuFence.observeApplied({
        sessionEpoch: activeSessionEpoch,
        frameFenceToken: activeFrameFenceToken,
        generation: displayEpoch.generation,
        frameId:
          resumePresentationPending && frames === resumeAppliedFrames
            ? 0
            : viewer.applied_frame_id(),
        displayKind:
          resumePresentationPending && frames === resumeAppliedFrames
            ? 'display_resume'
            : viewer.applied_snapshot()
              ? 'display_snapshot'
              : 'display_delta',
      });
    resumePresentationPending = false;
    if (syncDimensionsFromWasm()) {
      displayEpoch.stateReadyPending = true;
      displayEpoch.stateAppliedPending = true;
    }
    updatePhysDimensions();
    displaySurfaceResizePending =
      offscreenCanvas?.width !== physW || offscreenCanvas?.height !== physH;
  }
}

function applyPeerFence(fence: ClientSessionFence): void {
  const terminal = wasmTerminal;
  if (
    terminal === null ||
    fence.frameFenceToken === activeFrameFenceToken ||
    (!fence.newSession && fence.lineage <= activeSessionEpoch)
  )
    return;
  // An output held for a full ring was polled under the lineage that ends
  // here, and the viewer's output buffer is about to be reused.
  viewerOutputPublisher?.reset();
  if (fence.newSession) {
    terminal.viewer.reset_session();
    terminal.viewer.set_tracing(perfEnabled);
    const metrics = terminal.cellMetrics();
    terminal.viewer.set_cell_size(viewerNowMs(), metrics[0] ?? 8, metrics[1] ?? 16);
    observedPredictionAuthorityRevision = -1;
    observedViewerFrames = 0;
    observedViewerSnapshots = 0;
    observedViewerPresentations = 0;
    observedPresentationRevision = terminal.presentationRevision();
    displayEpoch.generation = 0;
    displayEpoch.renderPending = false;
    displayEpoch.stateReadyPending = false;
    displayEpoch.stateAppliedPending = false;
    displayEpoch.outputPresentedPending = false;
    displayEpoch.lastFrameAtMs = 0;
    displayEpoch.lastSnapshotAtMs = 0;
    receivedGeometryState = null;
    localPresentationPending = false;
    lastMouseMode = -1;
    preeditActive = false;
  }
  finishPerfGridConvergence(false, 'superseded');
  clearQueuedPredictions();
  resumePresentationPending = false;
  resumeAppliedFrames = terminal.viewer.applied_frames();
  presentationsAtLastRowPump = -1;
  frameRingReader?.discardPending();
  displayOutputSettle.reset();
  abandonInFlightLatencyFrame();
  firstDisplayGpuFence.resetEpoch();
  presentedPredictionSources.reset();
  provisionalPreview.clear();
  predictionModelThroughInputSeq = 0;
  pendingPresentationTrace = false;
  authoritativePresentationUrgent = false;
  graphicsPresentationDirty = false;
  graphicsOfferSpaceReleased = false;
  activeSessionEpoch = fence.lineage;
  activeFrameFenceToken = fence.frameFenceToken;
  graphicsEpoch = fence.lineage;
  controlsGeometry = false;
  resizeRequestedAtMs = 0;
  if (receivedGeometryState?.epoch !== fence.lineage) receivedGeometryState = null;
  graphicsOwner = crypto.randomUUID();
  observedLinkRevision = -1;
  retireWaitingGraphicsAsset();
  graphicsResidents.clear();
  renderer?.clearGraphics();
  terminal.viewer.fence(viewerNowMs(), fence.lineage);
  applyGeometryAuthority();
  publishViewerLinks();
  drainViewerOutputs();
  ringWakePort?.postMessage({
    kind: 'client_viewer_fenced',
    lineage: fence.lineage,
    frameFenceToken: fence.frameFenceToken,
  } satisfies TerminalToTransportPeer);
  frameRingReader?.releaseSessionLineageFence(fence.frameFenceToken);
  displayAvailableWake.wake();
  publishPredictionModel();
  armPresentationCommit();
  armViewerDeadline();
  if (perfEnabled && perfWriter !== null)
    emitPresentationEpochBoundary(perfWriter, nowMs(), activeSessionEpoch, fence.lineage > 1);
}

/**
 * What the viewer asks its session to send goes to the transport worker's
 * ring, copied from the viewer's memory with no object per output. A full
 * ring leaves one output held; the transport's space edge resumes this drain.
 */
function drainViewerOutputs(): void {
  const terminal = wasmTerminal;
  const publisher = viewerOutputPublisher;
  if (terminal === null || publisher === null) return;
  if (
    publisher.drain(terminal.viewer, terminal.memory, activeSessionEpoch, activeFrameFenceToken)
  ) {
    resumePresentationPending = true;
  }
}

async function acceptClientGraphicsAsset(asset: ClientGraphicsAsset): Promise<void> {
  const terminal = wasmTerminal;
  const target = renderer;
  try {
    if (
      terminal === null ||
      target === null ||
      asset.lineage !== activeSessionEpoch ||
      asset.frameFenceToken !== activeFrameFenceToken ||
      asset.epoch !== graphicsEpoch
    ) {
      consumeClientGraphicsAsset(asset, false);
      return;
    }
    if (asset.asset === 1) {
      terminal.viewer.graphics_manifest(viewerNowMs(), asset.epoch, asset.key, asset.bytes);
      observeViewerPresentation();
      drainViewerOutputs();
      wakeGraphics();
      armViewerDeadline();
      consumeClientGraphicsAsset(asset, true);
      return;
    }
    const bitmap = await createImageBitmap(
      new Blob([asset.bytes as Uint8Array<ArrayBuffer>], { type: 'image/png' }),
    );
    if (
      wasmTerminal !== terminal ||
      renderer !== target ||
      asset.lineage !== activeSessionEpoch ||
      asset.frameFenceToken !== activeFrameFenceToken
    ) {
      bitmap.close();
      consumeClientGraphicsAsset(asset, false);
      return;
    }
    if (!target.graphicsTileCapacity()) {
      if (waitingGraphicsAsset !== null) {
        bitmap.close();
        throw new Error('session exceeded graphics delivery credit');
      }
      waitingGraphicsAsset = { asset, bitmap, target };
      return;
    }
    if (target.offerGraphicsTile(asset.key, bitmap)) wakeGraphics();
    consumeClientGraphicsAsset(asset, true);
  } finally {
    asset.bytes.fill(0);
  }
}
interface WaitingGraphicsAsset {
  asset: ClientGraphicsAsset;
  bitmap: ImageBitmap;
  target: GpuRenderer;
}
let waitingGraphicsAsset: WaitingGraphicsAsset | null = null;
let graphicsPresentationDirty = false;
let graphicsOfferSpaceReleased = false;
/** Return the asset's delivery credit; `taken` says the viewer or renderer holds it. */
function consumeClientGraphicsAsset(asset: ClientGraphicsAsset, taken: boolean): void {
  ringWakePort?.postMessage({
    kind: 'client_graphics_consumed',
    lineage: asset.lineage,
    frameFenceToken: asset.frameFenceToken,
    key: asset.key,
    taken,
  } satisfies TerminalToTransportPeer);
}
function retryWaitingGraphicsAsset(): void {
  const waiting = waitingGraphicsAsset;
  if (waiting === null) return;
  if (
    waiting.asset.lineage !== activeSessionEpoch ||
    waiting.asset.frameFenceToken !== activeFrameFenceToken ||
    renderer !== waiting.target
  ) {
    retireWaitingGraphicsAsset();
    return;
  }
  if (!waiting.target.graphicsTileCapacity()) return;
  waitingGraphicsAsset = null;
  if (waiting.target.offerGraphicsTile(waiting.asset.key, waiting.bitmap)) wakeGraphics();
  consumeClientGraphicsAsset(waiting.asset, true);
}
function retireWaitingGraphicsAsset(): void {
  const waiting = waitingGraphicsAsset;
  waitingGraphicsAsset = null;
  if (waiting === null) return;
  waiting.bitmap.close();
  consumeClientGraphicsAsset(waiting.asset, false);
}

let observedLinkRevision = -1;

const linkDecoder = new TextDecoder();

function publishViewerLinks(): void {
  const terminal = wasmTerminal;
  if (terminal === null || ringWakePort === null) return;
  const revision = terminal.viewer.refresh_links();
  if (revision === observedLinkRevision) return;
  observedLinkRevision = revision;
  const bytes = new Uint8Array(
    terminal.memory.buffer,
    terminal.viewer.links_bytes_ptr(),
    terminal.viewer.links_bytes_len(),
  );
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries: { id: number; uri: string }[] = [];
  for (let at = 0; at < bytes.length; ) {
    const id = data.getUint32(at, true);
    const size = data.getUint32(at + 4, true);
    at += 8;
    const uri = linkDecoder.decode(bytes.subarray(at, at + size));
    at += size;
    entries.push({ id, uri });
  }
  ringWakePort.postMessage({
    kind: 'client_link_definitions',
    lineage: activeSessionEpoch,
    frameFenceToken: activeFrameFenceToken,
    entries,
    reset: true,
  } satisfies TerminalToTransportPeer);
}

const graphicsResidents = new Set<string>();

let displaySurfaceReplacementPending = false;
let authoritativePresentationUrgent = false;
let presentationTransactionSeq = 0;
let pendingPresentationTrace = false;
const presentationTraceWords = new Uint32Array(18);
const presentationTraceTimes = new Float64Array(5);
/**
 * The core stamps its trace on `viewerNowMs`; commit telemetry is epoch time.
 * Slots: first apply, last apply, deadline, period, and the releasing frame's
 * time, which is zero when no frame released the transaction.
 */
function rebasePresentationTraceTimes(times: Float64Array, driftMs: number): void {
  times[0] = (times[0] ?? 0) + driftMs;
  times[1] = (times[1] ?? 0) + driftMs;
  times[2] = (times[2] ?? 0) + driftMs;
  if (times[4] !== 0) times[4] = (times[4] ?? 0) + driftMs;
}
/**
 * The commit record of the transaction the viewer last traced, under the
 * number it was just given. Words: generation, first and last sequence, input
 * barrier, first and last presentation, datagrams, rows and bytes as two words
 * each, queue high water, coherent, end seen, release bits, release frames,
 * reason, echo horizon.
 */
function emitViewerPresentationCommit(
  writer: PerfRingWriter,
  at: number,
  renderSeq: number,
  changed: boolean,
): void {
  const w = presentationTraceWords,
    t = presentationTraceTimes;
  emitPresentationCommit(
    writer,
    at,
    presentationTransactionSeq,
    renderSeq,
    w[0] ?? 0,
    w[1] ?? 0,
    w[2] ?? 0,
    w[3] ?? 0,
    w[4] ?? 0,
    w[5] ?? 0,
    Math.max(0, at - (t[0] ?? at)),
    Math.max(0, at - (t[1] ?? at)),
    Math.max(0, at - (t[2] ?? at)),
    t[3] ?? 0,
    w[6] ?? 0,
    (w[7] ?? 0) + (w[8] ?? 0) * 4294967296,
    (w[9] ?? 0) + (w[10] ?? 0) * 4294967296,
    w[11] ?? 0,
    (w[12] ?? 0) !== 0,
    (w[13] ?? 0) !== 0,
    changed,
    presentationCommitReason(w[16] ?? 0),
    t[4] ?? 0,
    w[15] ?? 0,
    w[14] ?? 0,
    w[17] ?? 0,
  );
}

function presentationCommitReason(code: number): TerminalPresentationCommitReason {
  switch (code) {
    case 1:
      return 'group-end-vsync';
    case 2:
      return 'deadline-vsync';
    case 3:
      return 'urgent';
    case 4:
      return 'membership-complete';
    case 5:
      return 'closure-complete';
    case 6:
      return 'paced-complete';
    default:
      return 'recovery-release';
  }
}
