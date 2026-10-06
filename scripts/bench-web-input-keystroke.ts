import '../packages/shared/src/e2e-wasm-bun';
import { fullGC, heapStats } from 'bun:jsc';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createOwnedTimeout } from '../apps/web/src/lib/owned-scheduled-callback';
import { createTerminalInputController } from '../apps/web/src/terminal/input-controller';
import {
  recordKeyboardBreak,
  recordKeyboardCommit,
  recordKeyboardTouch,
} from '../apps/web/src/terminal/keyboard-diagnostics-store';
import {
  applyKeyboardOffsets,
  recordKeyboardOffsetTouch,
} from '../apps/web/src/terminal/keyboard-offset-store';
import { createKeyboardPrior } from '../apps/web/src/terminal/keyboard-prior';
import { PREDICTION_MODEL_BASE_READY } from '../apps/web/src/terminal/prediction-admission-model';
import { CAPTURE_PRINTABLE, PredictionCapture } from '../apps/web/src/terminal/prediction-capture';
import {
  createPredictionFastPathBuffer,
  createPredictionFastPathConsumer,
  createPredictionFastPathWriter,
  createPredictionFastStateReader,
} from '../apps/web/src/terminal/prediction-fast-path';
import { getVirtualKeyDefinition } from '../apps/web/src/terminal/virtual-keyboard';
import type { TerminalWorkerClient } from '../apps/web/src/terminal-worker-client';
import {
  createInputRingReader,
  createInputRingWriter,
  INPUT_RING_SIZE,
  type InputRingReader,
  type InputRingWriter,
  MAX_BUFFERED_INPUT_BYTES,
  MAX_BUFFERED_INPUT_ENTRIES,
} from '../apps/web/src/transport/input-ring';
import { createLinkActivityPublisher } from '../apps/web/src/transport/link-activity';
import { createPredictionAdmissionBuffer } from '../apps/web/src/transport/prediction-admission';
import {
  INPUT_AWAITED,
  INPUT_DEFERRED,
  type InputDelivery,
  type TerminalSession,
} from '../apps/web/src/transport-worker-client';
import * as e2eWasm from '../packages/e2e-wasm/pkg/e2e_wasm.js';
import { createKeyboardEngine } from '../packages/keyboard/src/engine';
import {
  CUPERTINO_PORTRAIT_PROFILE,
  solveKeyboardGeometry,
} from '../packages/keyboard/src/geometry';
import { TERMINAL_US_LAYOUT } from '../packages/keyboard/src/layouts/terminal-us';
import { createKeyboardSpatialPrior } from '../packages/keyboard/src/touch-model';
import { createClientSessionFixture } from './perf/client-session-fixture';
import { emitPerfMetric, perfEnvInteger, summarizeSamples } from './perf/harness';

/**
 * Main-thread physical/touch prediction capture, ring park, link activity and
 * the authenticated shared Rust transport path. Main-thread stages supply a
 * host drain/release double; transport-send uses the real signed native peer.
 * JSC cell counts and synchronous component timings are not device latency.
 */

const KEYSTROKES = perfEnvInteger('BENCH_KEYSTROKES', 256);
const SAMPLES = perfEnvInteger('BENCH_SAMPLES', 9);
const WARMUPS = perfEnvInteger('BENCH_WARMUPS', 3, 0);
const TIMING_SAMPLES = perfEnvInteger('BENCH_TIMING_SAMPLES', 200);
const ONLY = process.env.BENCH_STAGE ?? '';
/** Typing cadence for the heartbeat stage: 100 ms is ten keys a second. */
const KEY_INTERVAL_MS = perfEnvInteger('BENCH_KEY_INTERVAL_MS', 100);
const REPO_ROOT = path.resolve(import.meta.dir, '..');
const LETTERS = 'etaoinshrdlucmfwypvbgkqjxz';

type Settle = 'microtask' | 'macrotask';

interface KeystrokeStage {
  readonly name: string;
  readonly settle: Settle;
  /**
   * One keystroke of this stage; throws if production refused it. An
   * asynchronous stage returns the promise its keystroke completes with.
   */
  keystroke(): void | Promise<void>;
  /** Invariants after a measured run (bytes written, entries acked, ...). */
  verify?(): void;
  /** Deterministic per-keystroke facts of the last measured run, for the report. */
  detail?(): string;
  dispose?(): void | Promise<void>;
}

// ── Cell counting ────────────────────────────────────────────────────────────

function liveCells(): number {
  const counts = heapStats().objectTypeCounts;
  let total = 0;
  for (const key in counts) total += counts[key] ?? 0;
  return total;
}

function cellTypes(): Record<string, number> {
  return { ...heapStats().objectTypeCounts };
}

function settleOnce(kind: Settle): Promise<void> {
  if (kind === 'microtask') return Promise.resolve();
  return new Promise((resolve) => setImmediate(resolve));
}

async function objectsPerKeystroke(
  stage: KeystrokeStage,
  keystrokes: number,
): Promise<{ perKey: number; types: Record<string, number> }> {
  fullGC();
  const controlBefore = liveCells();
  const controlTypesBefore = cellTypes();
  for (let index = 0; index < keystrokes; index += 1) await settleOnce(stage.settle);
  const control = liveCells() - controlBefore;
  const controlTypesAfter = cellTypes();

  fullGC();
  const before = liveCells();
  const typesBefore = cellTypes();
  for (let index = 0; index < keystrokes; index += 1) {
    const done = stage.keystroke();
    if (done !== undefined) await done;
    await settleOnce(stage.settle);
  }
  const path = liveCells() - before;
  const typesAfter = cellTypes();
  stage.verify?.();
  const types: Record<string, number> = {};
  for (const key of new Set([...Object.keys(typesAfter), ...Object.keys(controlTypesAfter)])) {
    const pathDelta = (typesAfter[key] ?? 0) - (typesBefore[key] ?? 0);
    const controlDelta = (controlTypesAfter[key] ?? 0) - (controlTypesBefore[key] ?? 0);
    const delta = (pathDelta - controlDelta) / keystrokes;
    if (Math.abs(delta) >= 0.05) types[key] = Number(delta.toFixed(2));
  }
  return { perKey: (path - control) / keystrokes, types };
}

async function nsPerKeystroke(stage: KeystrokeStage, batch: number): Promise<number> {
  const startedAt = Bun.nanoseconds();
  for (let index = 0; index < batch; index += 1) {
    const done = stage.keystroke();
    if (done !== undefined) await done;
  }
  const elapsed = Bun.nanoseconds() - startedAt;
  // Let deferred work (timers, fibers, promise reactions) run outside the clock.
  for (let index = 0; index < 4; index += 1) await settleOnce(stage.settle);
  return elapsed / batch;
}

// ── Main thread: the physical key path ──────────────────────────────────────

interface FakeKeyEvent {
  key: string;
  code: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  repeat: boolean;
  isComposing: boolean;
  keyCode: number;
  location: number;
  defaultPrevented: boolean;
  target: null;
  timeStamp: number;
  preventDefault(): void;
  stopPropagation(): void;
  getModifierState(name: string): boolean;
}

function installListenerWindow(): {
  dispatch(type: string, event: unknown): void;
  restore(): void;
} {
  const globals = globalThis as Record<string, unknown>;
  const saved = new Map<string, unknown>();
  const listeners = new Map<string, Array<(event: unknown) => void>>();
  for (const name of [
    'HTMLInputElement',
    'HTMLTextAreaElement',
    'HTMLSelectElement',
    'HTMLElement',
  ]) {
    saved.set(name, globals[name]);
    globals[name] ??= class {};
  }
  const sink = {
    addEventListener: (type: string, handler: (event: unknown) => void) => {
      const bucket = listeners.get(type) ?? [];
      bucket.push(handler);
      listeners.set(type, bucket);
    },
    removeEventListener: () => {},
  };
  saved.set('window', globals.window);
  saved.set('document', globals.document);
  globals.window = sink;
  globals.document = { ...sink, visibilityState: 'visible', hasFocus: () => true };
  return {
    dispatch(type, event): void {
      const bucket = listeners.get(type);
      if (bucket === undefined) return;
      for (let index = 0; index < bucket.length; index += 1) bucket[index]?.(event);
    },
    restore(): void {
      for (const [name, value] of saved) {
        if (value === undefined) delete globals[name];
        else globals[name] = value;
      }
    },
  };
}

function createKeyEvents(): FakeKeyEvent[] {
  const noop = (): void => {};
  const noLocks = (): boolean => false;
  return [...LETTERS].map((letter) => ({
    key: letter,
    code: `Key${letter.toUpperCase()}`,
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    repeat: false,
    isComposing: false,
    keyCode: 0,
    location: 0,
    defaultPrevented: false,
    target: null,
    timeStamp: 0,
    preventDefault: noop,
    stopPropagation: noop,
    getModifierState: noLocks,
  }));
}

/**
 * The main-thread halves of both worker clients, mirrored from
 * `createTransportSession().sendKeystroke` and
 * `createTerminalWorkerClient().predictPrintable` et al. over the production
 * ring, fast path, admission ledger and admission model.
 */
function createMainThreadDoubles(): {
  session: TerminalSession;
  workerClient: TerminalWorkerClient;
  writer: InputRingWriter;
  reader: InputRingReader;
  drainHostInput(): void;
  republishModel(): void;
  inputsSent(): number;
  predictionsAdmitted(): number;
  dispose(): void;
} {
  const ringSab = new SharedArrayBuffer(INPUT_RING_SIZE);
  const admissionSab = createPredictionAdmissionBuffer();
  const writer = createInputRingWriter(ringSab, admissionSab);
  const reader = createInputRingReader(ringSab, 30_000, admissionSab);

  writer.beginPredictionLineage();

  const fastPath = createPredictionFastPathBuffer();
  const predictionWriter = createPredictionFastPathWriter(fastPath);
  const predictionState = createPredictionFastStateReader(fastPath);
  const consumer = createPredictionFastPathConsumer(fastPath);
  predictionWriter.beginEpoch();
  consumer.adoptRequiredEpoch();
  consumer.publishVisible(true);

  let nextInputSeq = 1;
  let admittedPredictions = 0;
  if (captureMemory === null) throw new Error('bench: client runtime is not initialized');
  const predictionModel = new PredictionCapture(captureMemory, predictionState);
  let drainedThrough = 0;

  function republishModel(): void {
    consumer.drain(4096, (_kind, inputSeq) => {
      drainedThrough = inputSeq;
    });
    consumer.publishModel(true, PREDICTION_MODEL_BASE_READY, 2, 2, 2, 64, 1_000, drainedThrough);
  }
  republishModel();

  function predictPrintable(inputSeq: number, codepoint: number, sentAtMs: number): boolean {
    if (!predictionWriter.epochReady()) return false;
    const admitted = predictionModel.prepare(CAPTURE_PRINTABLE, inputSeq);
    const queued = predictionWriter.writePrintable(
      inputSeq,
      codepoint,
      sentAtMs,
      predictionState.visible(),
    );
    if (!queued) {
      predictionModel.invalidate();
      return false;
    }
    if (admitted) {
      admittedPredictions += 1;
    }
    return admitted;
  }

  const session = {
    isAcceptingInput: () => true,
    // Geometry ownership is outside this keystroke/ring benchmark.
    setWindowFocused: () => {},
    releaseDeferredInput: () => writer.releaseDeferred(),
    sendKeystroke(
      input: Uint8Array,
      _inputAtMs = 0,
      classifyShadowModelled?: (inputSeq: number) => boolean,
      delivery: InputDelivery = INPUT_AWAITED,
    ): number | null {
      if (
        writer.bufferedBytes() + input.byteLength > MAX_BUFFERED_INPUT_BYTES ||
        writer.bufferedEntries() >= MAX_BUFFERED_INPUT_ENTRIES
      ) {
        writer.releaseDeferred();
        return null;
      }
      const seq = nextInputSeq++;
      if (!writer.write(seq, input, classifyShadowModelled, delivery === INPUT_DEFERRED)) {
        nextInputSeq = seq;
        writer.releaseDeferred();
        return null;
      }
      return seq;
    },
  } as unknown as TerminalSession;

  const workerClient = {
    isPredictionSafe: () => true,
    terminalMode: () => 0,
    predictPrintable,
    predictBackspace: () => false,
    predictDelete: () => false,
    predictCursorShift: () => false,
    flushPredictions: () => {},
    previewPrintable: () => false,
    clearProvisionalPrintable: () => {},
  } as unknown as TerminalWorkerClient;

  return {
    session,
    workerClient,
    writer,
    reader,
    drainHostInput() {
      let releaseThrough = -1;
      for (;;) {
        const ordinal = reader.tryReadNext();
        if (ordinal < 0) break;
        releaseThrough = ordinal + 1;
      }
      if (releaseThrough >= 0) reader.release(releaseThrough);
    },
    republishModel,
    inputsSent: () => nextInputSeq - 1,
    predictionsAdmitted: () => admittedPredictions,
    dispose: () => predictionModel.close(),
  };
}

/** The terminal panel: every benchmark key is aimed at the terminal. */
const OWNING_PANEL = { contains: () => true } as unknown as HTMLElement;

function createMainPhysicalKeyStage(): KeystrokeStage & { dispose(): void } {
  const window = installListenerWindow();
  const doubles = createMainThreadDoubles();
  const controller = createTerminalInputController({
    touchKeyboardEligible: false,
    ownerEl: OWNING_PANEL,
    getSession: () => doubles.session,
    getWorkerClient: () => doubles.workerClient,
    getTouchSurfaceEl: () => null,
    getVirtualModifiers: () => ({ shift: false, ctrl: false, alt: false, meta: false }),
    clearVirtualModifiers: () => {},
    focusTerminal: () => {},
    onToggleFocusMode: () => {},
  });
  controller.attach();
  const events = createKeyEvents();
  let next = 0;
  let sentBefore = 0;

  // The transport side of the ring, outside the measured stage: read and
  // acknowledge what main published so the ring never fills.
  function drainAndAck(): void {
    doubles.drainHostInput();
    doubles.republishModel();
  }

  return {
    name: 'main-physical-key',
    settle: 'microtask',
    keystroke(): void {
      const event = events[next % events.length];
      next += 1;
      if (event === undefined) throw new Error('bench: key event disappeared');
      window.dispatch('keydown', event);
      window.dispatch('keyup', event);
      // A release is deferred; the press behind it releases it. Keep the
      // ring's readable edge where production leaves it between keys.
      if ((next & 63) === 0) drainAndAck();
    },
    verify(): void {
      drainAndAck();
      const sent = doubles.inputsSent();
      if (sent - sentBefore < 2) throw new Error('bench: main admitted no keystrokes');
      sentBefore = sent;
      if (doubles.predictionsAdmitted() === 0) throw new Error('bench: no prediction admitted');
    },
    dispose(): void {
      controller.destroy();
      doubles.dispose();
      window.restore();
    },
  };
}

// Transport timing uses the authenticated shared Rust owner, including its retry and heartbeat state.
let captureMemory: WebAssembly.Memory | null = null;
async function loadRuntime(): Promise<void> {
  captureMemory = e2eWasm.initSync({
    module: readFileSync(path.join(REPO_ROOT, 'packages/e2e-wasm/pkg/e2e_wasm_bg.wasm')),
  }).memory;
}
async function createTransportSendStage(): Promise<KeystrokeStage> {
  const peer = await createClientSessionFixture();
  let sequence = 0;
  return {
    name: 'transport-send',
    settle: 'microtask',
    async keystroke() {
      peer.setNow(peer.now() + KEY_INTERVAL_MS);
      if (!peer.input(++sequence, Uint8Array.of(0, 97)))
        throw new Error('authenticated Rust input refusal');
      await peer.settle();
    },
    verify() {
      if (peer.applied.length !== sequence)
        throw new Error('daemon did not apply each input exactly once');
    },
    detail: () =>
      'full signed Session input/Noise/ACK path; native oracle IPC included in asynchronous cost',
    dispose: () => peer.close(),
  };
}

function createReaderParkStage(): KeystrokeStage {
  const sab = new SharedArrayBuffer(INPUT_RING_SIZE);
  const writer = createInputRingWriter(sab);
  const reader = createInputRingReader(sab);
  const payload = Uint8Array.of(0x01, 0x61);
  let seq = 1;
  return {
    name: 'reader-park',
    settle: 'microtask',
    // One park and one wake per keystroke, awaited: the idle typist's shape.
    // Timing here is the whole hop, park to woken, not synchronous work.
    async keystroke(): Promise<void> {
      const wait = reader.waitAsync();
      if (wait === 'not-equal') throw new Error('bench: an empty ring did not park');
      if (!writer.write(seq, payload)) throw new Error('bench: ring refused an entry');
      seq += 1;
      await wait;
      const ordinal = reader.tryReadNext();
      if (ordinal < 0) throw new Error('bench: woken reader found nothing');
      reader.release(ordinal + 1);
    },
  };
}

function createLinkActivityStage(): KeystrokeStage & { dispose(): void } {
  const totals = { txBytes: 0, rxBytes: 0 };
  let publications = 0;
  let publicationsBefore = 0;
  const publisher = createLinkActivityPublisher({
    now: () => performance.now(),
    timer: createOwnedTimeout(
      (callback, delayMs) => setTimeout(callback, delayMs),
      (handle) => clearTimeout(handle),
    ),
    totals: () => totals,
    publish(snapshot): void {
      publications += 1;
      // Main acknowledges each delivery; here at once.
      queueMicrotask(() => publisher.acknowledge(snapshot.subscriptionId, snapshot.sequence));
    },
  });
  publisher.start();
  publisher.subscribe(1, true, 64);
  return {
    name: 'link-activity',
    settle: 'microtask',
    keystroke(): void {
      totals.txBytes += 64;
      publisher.record(64, 0, true);
      totals.rxBytes += 180;
      publisher.record(0, 180, true);
    },
    verify(): void {
      // The 60 ms cadence arms once per burst; a publication lands between
      // samples, so each measured run is the per-record path alone.
      if (publications === publicationsBefore && publications === 0) {
        throw new Error('bench: the publisher never published its baseline');
      }
      publicationsBefore = publications;
    },
    dispose(): void {
      publisher.stop();
    },
  };
}

// ── Main thread: an on-screen keyboard tap ──────────────────────────────────

function createTouchTapStage(): KeystrokeStage & { dispose(): void } {
  const window = installListenerWindow();
  const doubles = createMainThreadDoubles();
  const controller = createTerminalInputController({
    touchKeyboardEligible: true,
    ownerEl: OWNING_PANEL,
    getSession: () => doubles.session,
    getWorkerClient: () => doubles.workerClient,
    getTouchSurfaceEl: () => null,
    getVirtualModifiers: () => NO_MODIFIERS,
    clearVirtualModifiers: () => {},
    focusTerminal: () => {},
    onToggleFocusMode: () => {},
  });
  const geometry = solveKeyboardGeometry(
    TERMINAL_US_LAYOUT,
    'alpha',
    390,
    3,
    CUPERTINO_PORTRAIT_PROFILE,
  );
  const prior = createKeyboardPrior(geometry);
  let commits = 0;
  let lastCharacter: string | null = null;
  const engine = createKeyboardEngine({
    geometry,
    profile: CUPERTINO_PORTRAIT_PROFILE,
    touchModel: applyKeyboardOffsets(geometry, createKeyboardSpatialPrior(geometry)),
    onRawCommit(key, _layerId, pointerId, _x, _y, contactAtMs, repeat): void {
      // VirtualTerminalKeyboard.handleKey: refresh the causal prior, send, then
      // hand the commit to the correction analysis.
      const definition = key.definition;
      const value = definition.id === 'space' ? ' ' : definition.value;
      lastCharacter = value !== undefined && value.length === 1 ? value : null;
      engine.setKeyPrior(prior.forPrevious(lastCharacter));
      const virtual = getVirtualKeyDefinition(definition.id);
      if (virtual === undefined) return;
      commits += 1;
      controller.sendVirtualKey(virtual, contactAtMs, repeat);
      recordKeyboardCommit(definition, pointerId, repeat);
    },
    onRawProvisional(key, _layerId, pointerId): void {
      controller.previewVirtualKey(
        key === null ? null : (getVirtualKeyDefinition(key.definition.id) ?? null),
        pointerId,
      );
    },
    onTouchTrace(trace): void {
      recordKeyboardTouch(trace, geometry);
      recordKeyboardOffsetTouch(trace, geometry);
    },
  });
  // Off-anchor points, as bench-keyboard aims them: the contact stays undecided
  // until the lift, which is the path that classifies, traces and commits.
  const points = ['key-e', 'key-t', 'key-a', 'key-o', 'key-i', 'key-n', 'key-s', 'key-h'].map(
    (id) => {
      const key = geometry.keys.find((candidate) => candidate.definition.id === id);
      if (key === undefined) throw new Error(`bench: keyboard has no ${id}`);
      return [key.rect.x + key.rect.width * 0.85, key.rect.y + key.rect.height / 2] as const;
    },
  );
  let next = 0;
  let clock = 0;
  let commitsBefore = 0;
  return {
    name: 'touch-tap',
    settle: 'microtask',
    keystroke(): void {
      const point = points[next & 7];
      next += 1;
      if (point === undefined) throw new Error('bench: tap point disappeared');
      clock += 120;
      if (!engine.beginPointerAt(1, point[0], point[1], clock)) {
        throw new Error('bench: engine refused a contact');
      }
      engine.movePointerAt(1, point[0] + 0.5, point[1], clock + 20);
      if (!engine.endPointerAt(1, point[0] + 1, point[1], clock + 60)) {
        throw new Error('bench: engine refused a lift');
      }
      if ((next & 63) === 0) {
        // A line ends every 64 taps, as Enter ends one, so its analysis is
        // inside the measurement rather than a line growing without bound.
        recordKeyboardBreak();
        doubles.drainHostInput();
        doubles.republishModel();
      }
    },
    verify(): void {
      if (commits === commitsBefore) throw new Error('bench: no tap committed a key');
      commitsBefore = commits;
    },
    dispose(): void {
      engine.destroy();
      controller.destroy();
      doubles.dispose();
      window.restore();
    },
  };
}

const NO_MODIFIERS = { shift: false, ctrl: false, alt: false, meta: false } as const;

// ── Driver ───────────────────────────────────────────────────────────────────

async function report(stage: KeystrokeStage): Promise<void> {
  for (let warmup = 0; warmup < WARMUPS; warmup += 1) await objectsPerKeystroke(stage, KEYSTROKES);
  const counts: number[] = [];
  let types: Record<string, number> = {};
  for (let sample = 0; sample < SAMPLES; sample += 1) {
    const measured = await objectsPerKeystroke(stage, KEYSTROKES);
    counts.push(measured.perKey);
    types = measured.types;
  }
  const timings: number[] = [];
  for (let ordinal = 0; ordinal < TIMING_SAMPLES; ordinal++)
    timings.push(await nsPerKeystroke(stage, 64));
  const allocation = summarizeSamples(counts),
    timing = summarizeSamples(timings);
  process.stdout.write(
    `${JSON.stringify({ stage: stage.name, allocationCellsPerKey: allocation, nanosecondsPerKey: timing, cellTypes: types, scope: stage.detail?.() ?? 'production main-thread component with host transport completion supplied' })}\n`,
  );
  emitPerfMetric({
    name: `web-input-${stage.name}-objects`,
    value: allocation.median,
    unit: 'objects/keystroke',
    direction: 'lower',
    sampleSize: SAMPLES,
  });
  emitPerfMetric({
    name: `web-input-${stage.name}-ns`,
    value: timing.median,
    unit: 'ns/keystroke',
    direction: 'lower',
    percentile: 0.5,
    sampleSize: TIMING_SAMPLES,
  });
}

if (import.meta.main) {
  await loadRuntime();
  process.stdout.write(
    `web input keystroke benchmark: keystrokes=${KEYSTROKES}, samples=${SAMPLES}, warmups=${WARMUPS}\n`,
  );
  const wants = (name: string): boolean => ONLY === '' || ONLY.split(',').includes(name);

  const stages: ReadonlyArray<readonly [string, () => KeystrokeStage | Promise<KeystrokeStage>]> = [
    ['main-physical-key', createMainPhysicalKeyStage],
    ['transport-send', createTransportSendStage],
    ['reader-park', createReaderParkStage],
    ['link-activity', createLinkActivityStage],
    ['touch-tap', createTouchTapStage],
  ];
  for (const [name, create] of stages) {
    if (!wants(name)) continue;
    const stage = await create();
    try {
      await report(stage);
    } finally {
      await stage.dispose?.();
    }
  }
  // The keyboard diagnostics and offset stores arm their production persist
  // timers (4 s and 8 s) on the first tap; nothing here waits for them.
  process.exit(0);
}
