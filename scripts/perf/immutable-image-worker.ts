import { WebGl2Renderer } from 'merkur-historical-webgl';
import type { GeometryVersions } from '../../apps/web/src/terminal-renderer';

export type ImageExperimentArm = 'direct' | 'bitmap';

export interface ImmutableImageInit {
  readonly kind: 'init';
  readonly canvas: OffscreenCanvas;
  readonly arm: 'direct' | 'bitmap';
  readonly width: number;
  readonly height: number;
  readonly periodMs: number;
  readonly workload: 'typing' | 'redraw';
}

export type ImmutableImageCommand =
  | ImmutableImageInit
  | { readonly kind: 'offer'; readonly ordinal: number; readonly offeredAtMs: number }
  | { readonly kind: 'accepted'; readonly ordinal: number }
  | { readonly kind: 'finish' }
  | { readonly kind: 'shutdown' };

export interface ImmutableImageSubmitted {
  readonly kind: 'submitted';
  readonly ordinal: number;
  readonly offeredAtMs: number;
  readonly receivedAtMs: number;
  readonly renderStartAtMs: number;
  readonly renderEndAtMs: number;
  readonly imageEndAtMs: number;
  readonly postedAtMs: number;
  readonly bitmap?: ImageBitmap;
}

export interface ImmutableImageDone {
  readonly kind: 'done';
  readonly arm: 'direct' | 'bitmap';
  readonly rendererIdentity: string;
  readonly contextAttributes: WebGLContextAttributes | null;
  readonly offeredCount: number;
  readonly submittedCount: number;
  readonly coalescedCount: number;
  readonly maxOutstanding: number;
  readonly createdBitmapCount: number;
  readonly receivedCount: number;
  readonly lastOrdinal: number;
  readonly expectedPixels: readonly {
    readonly x: number;
    readonly y: number;
    readonly rgba: readonly number[];
  }[];
}

export type ImageExperimentResult = ImmutableImageDone;
export type ImageExperimentMessage =
  | ImmutableImageSubmitted
  | ImmutableImageDone
  | {
      readonly kind: 'ready';
      readonly arm: ImageExperimentArm;
      readonly rendererIdentity: string;
      readonly contextAttributes: WebGLContextAttributes | null;
    }
  | { readonly kind: 'error'; readonly message: string };

/**
 * Component experiment only. Runner pins the complete renderer import closure
 * to fc3e6e36. This does NOT exercise the candidate two-credit renderer or bound
 * the GPU/compositor queue. Main-thread acceptance is not GPU readiness or paint.
 * Both arms share one outstanding delivery plus one latest unsubmitted offer.
 */
declare const self: DedicatedWorkerGlobalScope;
const scope = self;
const COLS = 100;
const ROWS = 30;
const GLYPHS = COLS * ROWS;
const BG_FLOATS = ROWS * 7;
const storage = new Float32Array(BG_FLOATS + GLYPHS * 14);
const bg = { ptr: 0, count: ROWS };
const glyph = { ptr: BG_FLOATS * 4, count: GLYPHS };
const empty = { ptr: 0, count: 0 };
const versions: GeometryVersions = {
  bg: 0,
  glyph: 0,
  deco: 0,
  cursor: 0,
  bgDirtyOffset: 0,
  bgDirtyCount: ROWS,
  glyphDirtyOffset: 0,
  glyphDirtyCount: GLYPHS,
  decoDirtyOffset: 0,
  decoDirtyCount: 0,
  cursorDirtyOffset: 0,
  cursorDirtyCount: 0,
};
let request: ImmutableImageInit | null = null;
let renderer: WebGl2Renderer | null = null;
let initialized = false;
let stopped = false;
let finishing = false;
let done = false;
let raf: number | null = null;
let outstanding = 0;
let pendingOrdinal = 0;
let pendingOfferedAtMs = 0;
let pendingReceivedAtMs = 0;
let latestOfferedOrdinal = 0;
let lastSubmitAtMs = Number.NEGATIVE_INFINITY;
let offeredCount = 0;
let submittedCount = 0;
let coalescedCount = 0;
let maxOutstanding = 0;
let createdBitmapCount = 0;
let lastOrdinal = 0;
let rendererIdentity = '';
let contextAttributes: WebGLContextAttributes | null = null;

function epochNow(): number {
  return performance.timeOrigin + performance.now();
}

function stop(): void {
  stopped = true;
  if (raf !== null) scope.cancelAnimationFrame(raf);
  raf = null;
  if (initialized) renderer?.destroy();
  renderer = null;
  initialized = false;
}

function fail(error: unknown): void {
  if (stopped) return;
  stop();
  scope.postMessage({
    kind: 'error',
    message: error instanceof Error ? error.message : String(error),
  });
}

function maybeDone(): void {
  if (!finishing || done || outstanding !== 0 || pendingOrdinal !== 0 || request === null) return;
  done = true;
  scope.postMessage({
    kind: 'done',
    arm: request.arm,
    rendererIdentity,
    contextAttributes,
    offeredCount,
    submittedCount,
    coalescedCount,
    maxOutstanding,
    createdBitmapCount,
    receivedCount: offeredCount,
    lastOrdinal,
    expectedPixels: Array.from({ length: ROWS }, (_, row) => ({
      x: 2,
      y: row * 32 + 16,
      rgba: [
        ((request?.workload === 'typing' && row !== 0 ? 0 : lastOrdinal) % 200) + 30,
        ((row * 7) % 200) + 30,
        60,
        255,
      ],
    })),
  } satisfies ImmutableImageDone);
  // Keep the final direct surface alive for the runner's screenshot oracle.
}

function schedule(): void {
  if (stopped || !initialized || outstanding !== 0 || pendingOrdinal === 0 || request === null)
    return;
  if (performance.now() - lastSubmitAtMs >= request.periodMs) {
    submit();
  } else if (raf === null) {
    raf = scope.requestAnimationFrame(() => {
      raf = null;
      try {
        // A real refresh opportunity is one-use credit; rechecking an estimate
        // here could accidentally skip every other frame due to clock jitter.
        if (outstanding === 0 && pendingOrdinal !== 0) submit();
      } catch (error) {
        fail(error);
      }
    });
  }
}

function updateGeometry(ordinal: number): void {
  const current = request;
  if (current === null) throw new Error('missing initialized fixture');
  // Witness pixels stay outside glyph coverage (x=0..4). Typing changes only
  // row zero's marker; redraw changes every row. No full-row oracle tax is
  // silently charged to the sparse typing workload.
  const changedRows = current.workload === 'typing' ? 1 : ROWS;
  for (let row = 0; row < changedRows; row += 1) {
    const at = row * 7;
    storage[at + 4] = ((ordinal % 200) + 30) / 255;
    storage[at + 5] = (((row * 7) % 200) + 30) / 255;
    storage[at + 6] = 60 / 255;
  }
  // Absolute replacement of the SAME cell: skipping an obsolete pending
  // presentation must not skip a cumulative mutation and change the workload.
  const first = 0;
  const count = current.workload === 'typing' ? 1 : GLYPHS;
  for (let index = first; index < first + count; index += 1) {
    const at = BG_FLOATS + index * 14;
    storage[at + 10] = ((ordinal % 100) + 100) / 255;
    storage[at + 11] = ((index % 100) + 100) / 255;
    storage[at + 12] = 0.85;
  }
  versions.bg = ordinal;
  versions.bgDirtyCount = changedRows;
  versions.glyph = ordinal;
  versions.glyphDirtyOffset = first;
  versions.glyphDirtyCount = count;
}

function submit(): void {
  const current = request;
  const activeRenderer = renderer;
  if (current === null || activeRenderer === null || pendingOrdinal === 0 || outstanding !== 0)
    return;
  const ordinal = pendingOrdinal;
  const offeredAtMs = pendingOfferedAtMs;
  const receivedAtMs = pendingReceivedAtMs;
  pendingOrdinal = 0;
  updateGeometry(ordinal);
  const renderStartAtMs = epochNow();
  activeRenderer.render(
    storage.buffer,
    bg,
    glyph,
    empty,
    empty,
    [current.width, current.height],
    versions,
  );
  const renderEndAtMs = epochNow();
  lastSubmitAtMs = performance.now();
  let bitmap: ImageBitmap | undefined;
  try {
    // transferToImageBitmap detaches the old backing image. Every subsequent
    // render clears and draws the complete scene, including cached geometry.
    if (current.arm === 'bitmap') {
      bitmap = current.canvas.transferToImageBitmap();
      createdBitmapCount += 1;
    }
    const imageEndAtMs = epochNow();
    const message: ImmutableImageSubmitted = {
      kind: 'submitted',
      ordinal,
      offeredAtMs,
      receivedAtMs,
      renderStartAtMs,
      renderEndAtMs,
      imageEndAtMs,
      postedAtMs: epochNow(),
      ...(bitmap === undefined ? {} : { bitmap }),
    };
    outstanding = ordinal;
    maxOutstanding = 1;
    scope.postMessage(message, bitmap === undefined ? [] : [bitmap]);
    // Ownership moved to main. It must transferFromImageBitmap or close it.
    bitmap = undefined;
    submittedCount += 1;
    lastOrdinal = ordinal;
  } finally {
    bitmap?.close();
  }
}

async function initialize(value: ImmutableImageInit): Promise<void> {
  if (request !== null) throw new Error('duplicate initialization');
  if (
    (value.arm !== 'direct' && value.arm !== 'bitmap') ||
    (value.workload !== 'typing' && value.workload !== 'redraw') ||
    !Number.isFinite(value.periodMs) ||
    value.periodMs <= 0 ||
    value.periodMs > 1000 ||
    value.width !== 1600 ||
    value.height !== 960
  )
    throw new Error('invalid experiment fixture');
  request = value;
  value.canvas.width = value.width;
  value.canvas.height = value.height;
  const activeRenderer = new WebGl2Renderer();
  renderer = activeRenderer;
  await activeRenderer.init(value.canvas, 8, 8, [0, 0, 0]);
  initialized = true;
  if (stopped) {
    activeRenderer.destroy();
    initialized = false;
    return;
  }
  const gl = value.canvas.getContext('webgl2');
  if (gl === null) throw new Error('production renderer has no WebGL2 context');
  const debug = gl.getExtension('WEBGL_debug_renderer_info');
  const identity: unknown = gl.getParameter(
    debug === null ? gl.RENDERER : debug.UNMASKED_RENDERER_WEBGL,
  );
  if (typeof identity !== 'string') throw new Error('renderer identity unavailable');
  if (/SwiftShader|llvmpipe|software/iu.test(identity))
    throw new Error(`hardware GPU required: ${identity}`);
  rendererIdentity = identity;
  contextAttributes = gl.getContextAttributes();
  value.canvas.addEventListener('webglcontextlost', () =>
    fail(new Error('experiment context lost')),
  );
  const atlas = new Uint8Array(64);
  for (let y = 0; y < 8; y += 1)
    for (let x = 0; x < 8; x += 1) atlas[y * 8 + x] = x === 1 || y === 1 || y === 6 ? 255 : 0;
  activeRenderer.uploadAtlas(atlas, [0, 0, 8, 8], [8, 8]);
  for (let row = 0; row < ROWS; row += 1)
    storage.set(
      [0, row * 32, value.width, 32, 30 / 255, (((row * 7) % 200) + 30) / 255, 60 / 255],
      row * 7,
    );
  for (let index = 0; index < GLYPHS; index += 1)
    storage.set(
      [
        (index % COLS) * 16 + 6,
        Math.floor(index / COLS) * 32 + 2,
        0,
        0,
        8,
        24,
        0,
        0,
        1,
        1,
        0.8,
        0.8,
        0.85,
        1,
      ],
      BG_FLOATS + index * 14,
    );
  scope.postMessage({ kind: 'ready', arm: value.arm, rendererIdentity, contextAttributes });
}

scope.onmessage = (event: MessageEvent<ImmutableImageCommand>): void => {
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
    if (!initialized) throw new Error('command before initialization');
    if (value.kind === 'offer') {
      if (
        finishing ||
        !Number.isSafeInteger(value.ordinal) ||
        value.ordinal <= latestOfferedOrdinal ||
        !Number.isFinite(value.offeredAtMs)
      )
        throw new Error('invalid or non-monotonic offer');
      latestOfferedOrdinal = value.ordinal;
      offeredCount += 1;
      if (pendingOrdinal !== 0) coalescedCount += 1;
      pendingOrdinal = value.ordinal;
      pendingOfferedAtMs = value.offeredAtMs;
      pendingReceivedAtMs = epochNow();
      schedule();
    } else if (value.kind === 'accepted') {
      if (outstanding === 0 || value.ordinal !== outstanding)
        throw new Error('acceptance without exact outstanding owner');
      outstanding = 0;
      schedule();
      maybeDone();
    } else if (value.kind === 'finish') {
      finishing = true;
      maybeDone();
    } else throw new Error('unknown experiment command');
  } catch (error) {
    fail(error);
  }
};
