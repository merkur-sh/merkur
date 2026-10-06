import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createOwnedAnimationFrame } from './lib/owned-scheduled-callback';
import { createWorkerControlQueue } from './terminal/worker-control-queue';

const source = readFileSync(new URL('./terminal-worker.ts', import.meta.url), 'utf8');
function workerFunction(name: string): string {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf('\n}', start);
  if (start < 0 || end < start) throw new Error(`missing worker callback ${name}`);
  return source.slice(start, end + 2);
}
const program = new Bun.Transpiler({ loader: 'ts' }).transformSync(
  [
    workerFunction('queueSurfaceReplacement'),
    workerFunction('resizeAndRenderDisplaySurface'),
    workerFunction('handleRenderRefresh'),
    workerFunction('queueRasterMetrics'),
    workerFunction('commitPendingRasterMetrics'),
    workerFunction('handleFontUpdate'),
    workerFunction('handleDisplayEnv'),
    workerFunction('armPresentationCommit'),
    workerFunction('applyInstalledFontMetrics'),
    'globalThis.callbacks = { queueSurfaceReplacement, resizeAndRenderDisplaySurface, handleRenderRefresh, handleFontUpdate, handleDisplayEnv, commitPendingRasterMetrics };',
  ].join('\n'),
);

function harness() {
  let schedules = 0;
  let canceled = 0;
  let invalidated = 0;
  let resumes = 0;
  const visibility: boolean[] = [];
  let nextFrame = 1;
  const frames = new Map<number, (at: number) => void>();
  const fired: string[] = [];
  const createFrameSlot = () =>
    createOwnedAnimationFrame(
      (callback) => {
        const handle = nextFrame++;
        frames.set(handle, callback);
        return handle;
      },
      (handle) => {
        canceled += 1;
        frames.delete(handle);
      },
    );
  const context = {
    renderer: {},
    wasmTerminal: {
      viewer: {
        set_visible: (_now: number, visible: boolean) => visibility.push(visible),
        resume_visible: () => {
          resumes++;
        },
        wants_frame: () => true,
      },
    },
    nowMs: () => 100,
    viewerNowMs: () => 100,
    armViewerDeadline() {},
    offscreenCanvas: { width: 800, height: 600 },
    physW: 800,
    physH: 600,
    pendingRasterMetrics: null,
    currentFontSize: 14,
    currentLineHeight: 1,
    currentDevicePixelRatio: 2,
    displayEnvDpr: 2,
    graphicsVisible: true,
    graphicsPlayback: null,
    refreshCalibrator: { setVisible: () => {}, requestBurst: () => {} },
    refreshRate: { reset: () => {} },
    publishPresentationPeriod: () => {},
    armDisplayDemandFrame: () => {},

    preparePreviewAtlas: () => {},
    applyCellMetrics: (fontSize: number, lineHeight: number, dpr: number) => {
      installedMetrics.push([fontSize, lineHeight, dpr]);
    },
    displayEpoch: { renderPending: false, stateReadyPending: false, stateAppliedPending: false },
    localPresentationPending: false,
    displaySurfaceReplacementPending: false,
    displaySurfaceResizePending: false,

    displayRepaintHold: {
      release: () => {
        throw new Error('repair hold was released');
      },
    },
    repaintHoldTimer: {
      cancel: () => {
        canceled += 1;
      },
    },
    presentationAnimationFrame: createFrameSlot(),
    renderAnimationFrame: createFrameSlot(),
    onViewerAnimationFrame: () => fired.push('presentation'),
    onRenderAnimationFrame: () => fired.push('render'),
    markPendingPredictionRenderIfDirty: () => {},
    scheduleRenderFrame: () => {
      schedules += 1;
    },
    updatePhysDimensions: () => {},
    postWorkerHealth: () => {},
    deferInFlightPerfCompletion: (disposition: string) => {
      if (disposition === 'invalidated') invalidated += 1;
    },
  };
  const installedMetrics: number[][] = [];
  const callbacks = runInNewContext(`${program}\nglobalThis.callbacks;`, context) as {
    queueSurfaceReplacement(stateReady: boolean): void;
    resizeAndRenderDisplaySurface(stateReady: boolean): void;
    handleRenderRefresh(): void;
    handleFontUpdate(command: { fontSize: number; lineHeight: number }): void;
    handleDisplayEnv(command: { visible: boolean; devicePixelRatio: number }): void;
    commitPendingRasterMetrics(): void;
  };
  return {
    callbacks,
    context,
    installedMetrics,
    visibility,
    frames,
    fired,
    get resumes() {
      return resumes;
    },
    get schedules() {
      return schedules;
    },
    get canceled() {
      return canceled;
    },
    get invalidated() {
      return invalidated;
    },
  };
}

test('density and font changes coalesce without changing the held scene raster', () => {
  const host = harness();
  host.callbacks.handleDisplayEnv({ visible: true, devicePixelRatio: 1.25 });
  host.callbacks.handleFontUpdate({ fontSize: 18, lineHeight: 1 });
  host.callbacks.handleDisplayEnv({ visible: true, devicePixelRatio: 0.8 });
  expect(host.installedMetrics).toEqual([]);
  expect(host.context.currentDevicePixelRatio).toBe(2);
  expect(host.context.offscreenCanvas.width).toBe(800);

  host.callbacks.commitPendingRasterMetrics();
  expect(host.installedMetrics).toEqual([[18, 1, 0.8]]);
  expect(host.context.currentDevicePixelRatio).toBe(0.8);
  expect(host.context.currentFontSize).toBe(18);
  host.callbacks.commitPendingRasterMetrics();
  expect(host.installedMetrics).toHaveLength(1);
});

test('duplicate density signals do no work and returning to the current density cancels pending rasterization', () => {
  const host = harness();
  host.callbacks.handleDisplayEnv({ visible: false, devicePixelRatio: 2 });
  expect(host.schedules).toBe(0);
  host.callbacks.handleDisplayEnv({ visible: true, devicePixelRatio: 1 });
  const schedules = host.schedules;
  host.callbacks.handleDisplayEnv({ visible: true, devicePixelRatio: 1 });
  expect(host.schedules).toBe(schedules);
  host.callbacks.handleDisplayEnv({ visible: true, devicePixelRatio: 2 });
  host.callbacks.commitPendingRasterMetrics();
  expect(host.installedMetrics).toEqual([]);
});

test('visibility resumes core demand exactly on the hidden-to-visible edge', () => {
  const host = harness();
  host.callbacks.handleDisplayEnv({ visible: false, devicePixelRatio: 2 });
  expect(host.resumes).toBe(0);
  host.callbacks.handleDisplayEnv({ visible: true, devicePixelRatio: 2 });
  expect(host.resumes).toBe(1);
  host.callbacks.handleDisplayEnv({ visible: true, devicePixelRatio: 2 });
  expect(host.resumes).toBe(1);
  expect(host.visibility).toEqual([false, true, true]);
});

for (const coalesced of [false, true]) {
  test(`visibility restores worker frames cleared by engine suspension (coalesced=${coalesced})`, () => {
    const host = harness();
    host.context.presentationAnimationFrame.arm(host.context.onViewerAnimationFrame);
    host.context.renderAnimationFrame.arm(host.context.onRenderAnimationFrame);
    const retiredCallbacks = [...host.frames.values()];
    const queue = createWorkerControlQueue();
    queue.push({ kind: 'display_env', visible: false, devicePixelRatio: 2 });
    if (!coalesced) {
      host.callbacks.handleDisplayEnv({ visible: false, devicePixelRatio: 2 });
      queue.shift();
    }
    // WebKit WorkerAnimationController::suspend clears the native callback list
    // without calling JavaScript. Both ownership slots still consider it armed.
    host.frames.clear();
    expect(host.context.presentationAnimationFrame.isArmed()).toBe(true);
    expect(host.context.renderAnimationFrame.isArmed()).toBe(true);
    queue.push({ kind: 'display_env', visible: true, devicePixelRatio: 2 });
    const resume = queue.shift();
    if (resume?.kind !== 'display_env') throw new Error('missing visibility command');
    host.callbacks.handleDisplayEnv(resume);

    expect(host.frames.size).toBe(2);
    // A retired callback delivered late cannot consume the replacement owner.
    for (const callback of retiredCallbacks) callback(100);
    expect(host.fired).toEqual([]);
    const restoredCallbacks = [...host.frames.values()];
    host.frames.clear();
    for (const callback of restoredCallbacks) callback(16_100);
    expect(host.fired).toEqual(['presentation', 'render']);
    expect(host.context.presentationAnimationFrame.isArmed()).toBe(false);
    expect(host.context.renderAnimationFrame.isArmed()).toBe(false);
  });
}

test('refreshes redraw eligible state without releasing received rows or fabricating application', () => {
  const host = harness();
  for (let i = 0; i < 16; i += 1) host.callbacks.handleRenderRefresh();
  expect(host.context.localPresentationPending).toBe(true);
  expect(host.context.displayEpoch.renderPending).toBe(true);
  expect(host.context.displayEpoch.stateAppliedPending).toBe(false);
  expect(host.context.displayEpoch.stateReadyPending).toBe(false);
  expect(host.canceled).toBe(0);
  expect(host.invalidated).toBe(0);
  expect(host.schedules).toBe(16);
  // Local refreshes did not extend the original one-refresh escape bound.
});

test('font/viewport replacement defers physical resizing and preserves held membership', () => {
  for (const resized of [false, true]) {
    const host = harness();
    if (resized) host.context.physW = 900;
    host.callbacks.resizeAndRenderDisplaySurface(true);
    expect(host.context.offscreenCanvas.width).toBe(800);
    expect(host.context.localPresentationPending).toBe(true);
    expect(host.context.displayEpoch.stateReadyPending).toBe(true);
    expect(host.context.displayEpoch.stateAppliedPending).toBe(true);
    expect(host.context.displaySurfaceResizePending).toBe(resized);
    expect(host.canceled).toBe(0);
    expect(host.invalidated).toBe(Number(resized));
    expect(host.schedules).toBe(1);
  }
});

test('device restoration may replace only the eligible scene without consuming authority', () => {
  const host = harness();
  host.context.displayEpoch.stateAppliedPending = true;
  host.callbacks.queueSurfaceReplacement(false);
  expect(host.context.displaySurfaceReplacementPending).toBe(true);
  expect(host.context.localPresentationPending).toBe(true);
  expect(host.context.displayEpoch.stateAppliedPending).toBe(true);
  expect(host.canceled).toBe(0);
});
