import { WebGl2Renderer } from 'merkur-historical-webgl';
import {
  createTerminalFixture,
  FIXTURE_BG_FLOATS,
  FIXTURE_GLYPHS,
  FIXTURE_ROWS,
  fixtureGeometryUploadBytes,
  type TerminalFixtureWorkload,
  TerminalSubmissionWindow,
  terminalFixtureExpectedPixels,
  updateTerminalFixture,
  WebGpuFixtureRenderer,
} from './webgpu-terminal-renderer';

export type WebGpuTerminalArm = 'webgl' | 'webgpu';
export type WebGpuTerminalTrigger = 'offer' | 'completion' | 'poll' | 'raf' | 'finish';
export interface WebGpuTerminalInit {
  readonly kind: 'init';
  readonly canvas: OffscreenCanvas;
  readonly arm: WebGpuTerminalArm;
  readonly width: number;
  readonly height: number;
  readonly periodMs: number;
  readonly workload: TerminalFixtureWorkload;
}
export type WebGpuTerminalCommand =
  | WebGpuTerminalInit
  | { readonly kind: 'offer'; readonly ordinal: number; readonly offeredAtMs: number }
  | { readonly kind: 'finish' }
  | { readonly kind: 'shutdown' };
export interface WebGpuTerminalSubmitted {
  readonly kind: 'submitted';
  readonly ordinal: number;
  /** Main-thread clock, echoed unchanged. Every other timestamp is worker-local. */
  readonly offeredAtMs: number;
  readonly receivedAtMs: number;
  readonly renderStartAtMs: number;
  readonly renderEndAtMs: number;
  readonly completionTrackingEndAtMs: number;
  readonly postedAtMs: number;
  readonly rendererSubmissionId: number;
  readonly trigger: WebGpuTerminalTrigger;
}
export interface WebGpuTerminalCompleted {
  readonly kind: 'completed';
  readonly ordinal: number;
  readonly offeredAtMs: number;
  readonly renderEndAtMs: number;
  readonly completedAtMs: number;
  readonly rendererSubmissionId: number;
  readonly pollCount: number;
}
export interface WebGpuTerminalDone {
  readonly kind: 'done';
  readonly arm: WebGpuTerminalArm;
  readonly rendererIdentity: string;
  readonly contextAttributes: WebGLContextAttributes | null;
  readonly offeredCount: number;
  readonly receivedCount: number;
  readonly submittedCount: number;
  readonly completedCount: number;
  readonly coalescedCount: number;
  readonly maxOutstanding: number;
  readonly lastOrdinal: number;
  readonly expectedPixels: ReturnType<typeof terminalFixtureExpectedPixels>;
  readonly apiUploadBytes: number;
  readonly createdGpuObjects: number;
  readonly completionPollCount: number;
  /** Worker-local observed callback entry times, not browser paint timestamps. */
  readonly workerRafTimes: readonly number[];
  readonly apiAccounting: {
    readonly geometryUploadBytes: number;
    readonly completionPromises: number;
    readonly interpretation: string;
  };
}
export type WebGpuTerminalMessage =
  | WebGpuTerminalSubmitted
  | WebGpuTerminalCompleted
  | WebGpuTerminalDone
  | {
      readonly kind: 'ready';
      readonly arm: WebGpuTerminalArm;
      readonly rendererIdentity: string;
      readonly contextAttributes: WebGLContextAttributes | null;
    }
  | { readonly kind: 'error'; readonly message: string };

/** Component experiment. No main ACK, bitmap transfer or synthetic completion.
 * Runner pins the candidate exact-ID WebGL renderer and records its source hash.
 * Queue callbacks / observed GL sync status are not compositor or paint events.
 */
declare const self: DedicatedWorkerGlobalScope;
const scope = self;
const fixture = createTerminalFixture();
const window = new TerminalSubmissionWindow();
const bg = { ptr: 0, count: FIXTURE_ROWS };
const glyph = { ptr: FIXTURE_BG_FLOATS * 4, count: FIXTURE_GLYPHS };
const empty = { ptr: 0, count: 0 };
const viewport: [number, number] = [1600, 960];
interface Outstanding {
  ordinal: number;
  offeredAtMs: number;
  renderEndAtMs: number;
  rendererSubmissionId: number;
  pollCount: number;
}
const records: [Outstanding | null, Outstanding | null] = [null, null];
let request: WebGpuTerminalInit | null = null;
let webgl: WebGl2Renderer | null = null;
let webgpu: WebGpuFixtureRenderer | null = null;
let initialized = false;
let stopped = false;
let finishing = false;
let done = false;
let driving = false;
let raf: number | null = null;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let pollPosted = false;
let watchdog: ReturnType<typeof setTimeout> | null = null;
const pollChannel = new MessageChannel();
let pendingOfferedAtMs = 0;
let pendingReceivedAtMs = 0;
let lastSubmitAtMs = Number.NEGATIVE_INFINITY;
let lastOrdinal = 0;
let rendererIdentity = '';
let contextAttributes: WebGLContextAttributes | null = null;
let geometryUploadBytes = 0;
let completionPollCount = 0;
let completionPromises = 0;
const workerRafTimes: number[] = [];

function post(message: WebGpuTerminalMessage): void {
  scope.postMessage(message);
}
function stop(): void {
  if (stopped) return;
  stopped = true;
  if (raf !== null) scope.cancelAnimationFrame(raf);
  if (pollTimer !== null) clearTimeout(pollTimer);
  if (watchdog !== null) clearTimeout(watchdog);
  pollChannel.port1.close();
  pollChannel.port2.close();
  webgl?.destroy();
  webgpu?.destroy();
}
function fail(error: unknown): void {
  if (stopped) return;
  stop();
  post({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
}
function ensureWatchdog(): void {
  if (stopped || watchdog !== null) return;
  if (window.outstanding() === 0 && window.pendingOrdinal() === 0) return;
  const currentAtMs = performance.now();
  let remainingMs = 5000;
  for (const record of records) {
    if (record !== null)
      remainingMs = Math.min(remainingMs, record.renderEndAtMs + 5000 - currentAtMs);
  }
  if (window.pendingOrdinal() !== 0)
    remainingMs = Math.min(remainingMs, pendingReceivedAtMs + 5000 - currentAtMs);
  watchdog = setTimeout(
    () => {
      watchdog = null;
      const now = performance.now();
      if (
        records.some((record) => record !== null && now - record.renderEndAtMs >= 5000) ||
        (window.pendingOrdinal() !== 0 && now - pendingReceivedAtMs >= 5000)
      ) {
        fail(new Error('submission or pending presentation exceeded five-second bound'));
        return;
      }
      ensureWatchdog();
    },
    Math.max(1, remainingMs),
  );
}
function maybeDone(): void {
  if (
    !finishing ||
    done ||
    stopped ||
    !initialized ||
    window.outstanding() !== 0 ||
    window.pendingOrdinal() !== 0 ||
    request === null
  )
    return;
  done = true;
  if (watchdog !== null) clearTimeout(watchdog);
  watchdog = null;
  post({
    kind: 'done',
    arm: request.arm,
    rendererIdentity,
    contextAttributes,
    offeredCount: window.offeredCount,
    receivedCount: window.offeredCount,
    submittedCount: window.submittedCount,
    completedCount: window.completedCount,
    coalescedCount: window.coalescedCount,
    maxOutstanding: window.maxOutstanding,
    lastOrdinal,
    expectedPixels: terminalFixtureExpectedPixels(fixture),
    apiUploadBytes: webgpu?.apiUploadBytes ?? 48 + 64 + geometryUploadBytes,
    createdGpuObjects: webgpu?.createdGpuObjects ?? 19 + window.submittedCount,
    completionPollCount,
    workerRafTimes,
    apiAccounting: {
      geometryUploadBytes,
      completionPromises,
      interpretation:
        'API buffer/texture input bytes and explicit create calls only, not backend allocations/copies. WebGL counts its pinned 19 fixed create calls and one owned sync per submission; scalar uniform calls are excluded. WebGPU includes device, fixed resource/pipeline creates and per-submit encoder/pass/view/command-buffer creates; canvas texture wrapper reuse is not counted.',
    },
  });
  // Preserve the final surface for the runner's untimed, declared-pixel oracle.
}
function complete(record: Outstanding): void {
  if (stopped) return;
  const slot = records[0] === record ? 0 : records[1] === record ? 1 : -1;
  if (slot === -1) throw new Error('completion callback lost its exact owner');
  records[slot] = null;
  window.complete(record.ordinal);
  post({ kind: 'completed', ...record, completedAtMs: performance.now() });
  drive('completion');
  maybeDone();
}
function pollWebGl(): void {
  const renderer = webgl;
  if (renderer === null || stopped) return;
  // At most two zero-time queries per pass. No loop can chase a self-growing queue.
  for (let index = 0; index < 2; index += 1) {
    const oldest =
      records[0] === null
        ? records[1]
        : records[1] === null || records[0].ordinal < records[1].ordinal
          ? records[0]
          : records[1];
    if (oldest === null) break;
    oldest.pollCount += 1;
    completionPollCount += 1;
    const id = renderer.pollFrameComplete();
    if (id === 0) break;
    if (id !== oldest.rendererSubmissionId)
      throw new Error('WebGL completion identity/order mismatch');
    complete(oldest);
  }
}
function schedulePoll(): void {
  if (webgl === null || stopped || window.outstanding() === 0 || pollPosted || pollTimer !== null)
    return;
  pollPosted = true;
  // A separate task before the 1 ms timer prevents nested-timer 4 ms clamping;
  // no continuously self-reposting MessagePort monopolizes a worker task queue.
  pollChannel.port2.postMessage(0);
}
pollChannel.port1.onmessage = () => {
  pollPosted = false;
  if (stopped || window.outstanding() === 0) return;
  pollTimer = setTimeout(() => {
    pollTimer = null;
    try {
      drive('poll');
    } catch (error) {
      fail(error);
    }
  }, 1);
};

function submit(trigger: WebGpuTerminalTrigger): void {
  if (request === null || !window.canSubmit()) throw new Error('invalid submission state');
  const offeredAtMs = pendingOfferedAtMs;
  const receivedAtMs = pendingReceivedAtMs;
  const ordinal = window.take();
  updateTerminalFixture(fixture, request.workload, ordinal);
  const renderStartAtMs = performance.now();
  let rendererSubmissionId: number;
  if (webgl !== null) {
    if (!webgl.canSubmitFrame()) throw new Error('WebGL credits disagree with shared window');
    rendererSubmissionId = webgl.render(
      fixture.storage.buffer,
      bg,
      glyph,
      empty,
      empty,
      viewport,
      fixture.versions,
    );
    if (rendererSubmissionId === 0) throw new Error('WebGL submission has no completion owner');
  } else if (webgpu !== null) {
    webgpu.render(fixture, request.workload);
    rendererSubmissionId = window.submittedCount;
  } else throw new Error('no selected renderer');
  const renderEndAtMs = performance.now();
  lastSubmitAtMs = renderEndAtMs;
  geometryUploadBytes += fixtureGeometryUploadBytes(window.submittedCount === 1, request.workload);
  const record: Outstanding = {
    ordinal,
    offeredAtMs,
    renderEndAtMs,
    rendererSubmissionId,
    pollCount: 0,
  };
  const slot = records[0] === null ? 0 : records[1] === null ? 1 : -1;
  if (slot === -1) throw new Error('unbounded completion records');
  records[slot] = record;
  if (webgpu !== null) {
    completionPromises += 1;
    void webgpu.onSubmittedWorkDone().then(() => {
      try {
        complete(record);
      } catch (error) {
        fail(error);
      }
    }, fail);
  }
  const completionTrackingEndAtMs = performance.now();
  lastOrdinal = ordinal;
  post({
    kind: 'submitted',
    trigger,
    ordinal,
    offeredAtMs,
    receivedAtMs,
    renderStartAtMs,
    renderEndAtMs,
    completionTrackingEndAtMs,
    rendererSubmissionId,
    postedAtMs: performance.now(),
  });
  ensureWatchdog();
}
function drive(trigger: WebGpuTerminalTrigger, refreshCredit = false): void {
  if (stopped || !initialized || driving || request === null) return;
  driving = true;
  try {
    pollWebGl();
    if (window.canSubmit()) {
      if (refreshCredit || performance.now() - lastSubmitAtMs >= request.periodMs) {
        if (raf !== null) scope.cancelAnimationFrame(raf);
        raf = null;
        submit(trigger);
      } else if (raf === null) {
        raf = scope.requestAnimationFrame(() => {
          raf = null;
          try {
            if (workerRafTimes.length >= 10_000)
              throw new Error('worker rAF diagnostic capacity exceeded');
            workerRafTimes.push(performance.now());
            drive('raf', true);
          } catch (error) {
            fail(error);
          }
        });
      }
    }
    schedulePoll();
    maybeDone();
  } finally {
    driving = false;
  }
}
async function initialize(value: WebGpuTerminalInit): Promise<void> {
  if (request !== null) throw new Error('duplicate initialization');
  if (
    (value.arm !== 'webgl' && value.arm !== 'webgpu') ||
    (value.workload !== 'typing' && value.workload !== 'redraw') ||
    value.width !== 1600 ||
    value.height !== 960 ||
    !Number.isFinite(value.periodMs) ||
    value.periodMs <= 0 ||
    value.periodMs > 1000
  )
    throw new Error('invalid bounded fixture configuration');
  request = value;
  value.canvas.width = value.width;
  value.canvas.height = value.height;
  if (value.arm === 'webgl') {
    const renderer = new WebGl2Renderer();
    webgl = renderer;
    await renderer.init(value.canvas, 8, 8, [0, 0, 0]);
    if (stopped) {
      renderer.destroy();
      return;
    }
    const gl = value.canvas.getContext('webgl2');
    if (gl === null) throw new Error('WebGL2 unavailable');
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    const identity: unknown = gl.getParameter(
      debug === null ? gl.RENDERER : debug.UNMASKED_RENDERER_WEBGL,
    );
    if (typeof identity !== 'string' || /swiftshader|llvmpipe|software/iu.test(identity))
      throw new Error('hardware WebGL identity unavailable');
    rendererIdentity = identity;
    contextAttributes = gl.getContextAttributes();
    value.canvas.addEventListener('webglcontextlost', () => fail(new Error('WebGL context lost')));
    renderer.uploadAtlas(fixture.atlas, [0, 0, 8, 8], [8, 8]);
  } else {
    const renderer = new WebGpuFixtureRenderer();
    webgpu = renderer;
    await renderer.init(value.canvas, fixture, fail);
    if (stopped) {
      renderer.destroy();
      return;
    }
    rendererIdentity = renderer.identity;
  }
  initialized = true;
  post({ kind: 'ready', arm: value.arm, rendererIdentity, contextAttributes });
}
scope.onmessage = (event: MessageEvent<WebGpuTerminalCommand>) => {
  if (stopped) return;
  try {
    const value = event.data;
    if (value.kind === 'shutdown') {
      stop();
      return;
    }
    if (value.kind === 'init') {
      void initialize(value).catch(fail);
      return;
    }
    if (!initialized || done) throw new Error('command outside initialized active lifetime');
    if (value.kind === 'offer') {
      if (finishing || !Number.isFinite(value.offeredAtMs) || value.offeredAtMs < 0)
        throw new Error('invalid offer');
      window.offer(value.ordinal);
      pendingOfferedAtMs = value.offeredAtMs;
      pendingReceivedAtMs = performance.now();
      drive('offer');
      ensureWatchdog();
    } else if (value.kind === 'finish') {
      if (finishing) throw new Error('duplicate finish');
      finishing = true;
      drive('finish');
      maybeDone();
    } else throw new Error('unknown command');
  } catch (error) {
    fail(error);
  }
};
