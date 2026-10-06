import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { DEFAULT_TERMINAL_FONT } from './terminal/fonts';
import { DEFAULT_TERMINAL_THEME } from './terminal/themes';
import {
  createWorkerControlQueue,
  workerControlCommandBlocksDataPlane,
} from './terminal/worker-control-queue';
import type { WorkerCommand } from './terminal-worker-protocol';

const source = readFileSync(new URL('./terminal-worker.ts', import.meta.url), 'utf8');
const program = new Bun.Transpiler({ loader: 'ts' }).transformSync(
  [
    'async function runControlPump(',
    'function handleControlCommand(',
    'function handleFontFamilyUpdate(',
    'async function prepareFontFamilyUpdate(',
    'function commitPreparedFontFamilyUpdate(',
    'function abortActiveFontFamilyUpdate(',
  ]
    .map((signature) => {
      const start = source.indexOf(signature);
      const end = source.indexOf('\n}', start);
      if (start < 0 || end < start) throw new Error(`missing production ${signature}`);
      return source.slice(start, end + 2);
    })
    .join('\n'),
);

function harness() {
  const queue = createWorkerControlQueue();
  const events: string[] = [];
  const loads: ((bytes: ArrayBuffer) => void)[] = [];
  const installed: number[] = [];
  const metrics: number[][] = [];
  const context = {
    AbortController,
    Uint8Array,
    DEFAULT_TERMINAL_FONT,
    activeFontFamilyUpdateController: null,
    preparedFontFamilyUpdate: null,
    activeFontFamilyKey: '',
    activeSessionEpoch: 1,
    terminalFontFamilyKey: (font: typeof DEFAULT_TERMINAL_FONT) => font.regular,
    terminalFontLoader: {
      prefetchRegular: () => {},
      loadBlocking: () => new Promise<ArrayBuffer>((resolve) => loads.push(resolve)),
    },
    wasmTerminal: {
      setRegularFontBytes: (bytes: Uint8Array) => installed.push(bytes[0] ?? 0),
      cellMetrics: () => [8, 16, 12, context.currentDevicePixelRatio],
      presentationViewportRows: () => 'viewport',
      presentationViewportWrapBits: () => new Uint8Array(1),
    },
    renderer: {},
    currentDevicePixelRatio: 1,
    currentFontSize: 14,
    currentLineHeight: 1,
    charWidth: 8,
    charHeight: 16,
    installedFontTier: 'boot',
    applyCellMetrics: (...values: number[]) => metrics.push(values),
    preparePreviewAtlas: () => events.push('atlas'),
    updatePhysDimensions: () => events.push('dimensions'),
    resizeAndRenderDisplaySurface: () => events.push('render'),
    currentBaselineCss: () => 12,
    armFontStyleUpgrade: () => {},
    startPendingFontRegularPromotion: () => {},
    startPendingFontStyleUpgrade: () => {},
    cancelFontStyleUpgrade: () => {},
    firstDisplayGpuFence: { isComplete: () => true },
    self: { postMessage: (event: { kind: string }) => events.push(event.kind) },
    controlQueue: queue,
    controlQueueSize: () => queue.size(),
    peerFences: [],
    controlPumpActive: false,
    controlQueueOverflowReported: false,
    activeControlBlocksDataPlane: false,
    CONTROL_COMMANDS_PER_SLICE: 4,
    workerControlCommandBlocksDataPlane,
    handleResize: () => events.push('resize'),
    handleThemeUpdate: () => events.push('theme'),
    handleFontUpdate: () => events.push('font-metrics'),
    postWorkerHealth: () => events.push('health'),
    handleShutdown: () => events.push('shutdown'),
    handleInit: () => events.push('init'),
    runDataPlaneFairnessSlice: () => events.push('data'),
    continueDisplayOwner: () => {},
    predictionFastPath: null,
    armPresentationCommit: () => {},
    scheduleControlPump: () => events.push('ready-control'),
    scheduleControlPumpContinuation: () => events.push('control-continuation'),
    reportFatal: (error: unknown) => {
      throw error;
    },
  };
  runInNewContext(program, context);
  return {
    context,
    queue,
    events,
    installed,
    loads,
    metrics,
    push: (command: WorkerCommand) => expect(queue.push(command)).toBe(true),
    run: async () => {
      await runInNewContext('runControlPump()', context);
    },
    abort: () => runInNewContext("abortActiveFontFamilyUpdate('test ownership boundary')", context),
    resolve: async (index: number, byte: number) => {
      const resolve = loads[index];
      if (resolve === undefined) throw new Error('missing pending fetch');
      resolve(new Uint8Array([byte]).buffer);
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

test('a never-settling family fetch does not own controls, observations, or data progress', async () => {
  const owner = harness();
  owner.push({ kind: 'font_family_update', fontFamily: DEFAULT_TERMINAL_FONT });
  owner.push({ kind: 'theme_update', theme: DEFAULT_TERMINAL_THEME });
  await owner.run();
  expect(owner.loads).toHaveLength(1);
  expect(owner.context.controlPumpActive).toBe(false);
  expect(owner.events).toContain('theme');
  for (let index = 0; index < 100; index += 1) {
    owner.push({ kind: 'resize', cols: 100, rows: 40 });
    owner.push({ kind: 'get_viewport_rows', watch: false });
    owner.push({ kind: 'font_update', fontSize: 18, lineHeight: 1.2 });
    owner.push({ kind: 'worker_health_check' });
    await owner.run();
    expect(owner.queue.size()).toBe(0);
  }
  expect(owner.events.filter((event) => event === 'resize')).toHaveLength(100);
  expect(owner.events.filter((event) => event === 'viewport_rows_result')).toHaveLength(100);
  expect(owner.events.filter((event) => event === 'font-metrics')).toHaveLength(100);
  expect(owner.events.filter((event) => event === 'health')).toHaveLength(100);
  expect(owner.events.filter((event) => event === 'data')).toHaveLength(101);
  expect(owner.installed).toEqual([]);
  expect(owner.queue.highWater()).toBe(4);
});

test('ready font commits current metrics once and cannot starve behind ordinary controls', async () => {
  const owner = harness();
  owner.push({ kind: 'font_family_update', fontFamily: DEFAULT_TERMINAL_FONT });
  await owner.run();
  await owner.resolve(0, 42);
  expect(owner.installed).toEqual([]);
  owner.context.currentFontSize = 20;
  owner.context.currentLineHeight = 1.5;
  owner.context.currentDevicePixelRatio = 2;
  for (let index = 0; index < 12; index += 1)
    owner.push({ kind: 'get_viewport_rows', watch: false });
  await owner.run();
  expect(owner.queue.size()).toBe(8);
  expect(owner.installed).toEqual([42]);
  expect(owner.metrics).toEqual([[20, 1.5, 2]]);
  expect(owner.context.activeFontFamilyUpdateController).toBeNull();
  expect(owner.context.preparedFontFamilyUpdate).toBeNull();
  await owner.run();
  expect(owner.installed).toEqual([42]);
});

test('superseded, replaced-terminal, and changed-epoch fetches never commit late bytes', async () => {
  for (const invalidation of ['new-family', 'epoch', 'terminal', 'shutdown']) {
    const owner = harness();
    owner.push({ kind: 'font_family_update', fontFamily: DEFAULT_TERMINAL_FONT });
    await owner.run();
    if (invalidation === 'new-family') {
      owner.push({ kind: 'font_family_update', fontFamily: DEFAULT_TERMINAL_FONT });
      await owner.run();
    } else if (invalidation === 'epoch') {
      owner.context.activeSessionEpoch = 2;
    } else if (invalidation === 'terminal') {
      owner.context.wasmTerminal = { ...owner.context.wasmTerminal };
    } else {
      owner.abort();
      owner.push({ kind: 'shutdown' });
      await owner.run();
      expect(owner.events).toContain('shutdown');
    }
    await owner.resolve(0, 41);
    await owner.run();
    expect(owner.installed).toEqual([]);
    if (invalidation === 'new-family') {
      await owner.resolve(1, 42);
      await owner.run();
      expect(owner.installed).toEqual([42]);
    }
  }
});

test('a ready result cannot overtake a queued ownership barrier and abort drops its bytes', async () => {
  const owner = harness();
  owner.push({ kind: 'font_family_update', fontFamily: DEFAULT_TERMINAL_FONT });
  await owner.run();
  await owner.resolve(0, 42);
  for (let index = 0; index < 4; index += 1)
    owner.push({ kind: 'get_viewport_rows', watch: false });
  // A valid ownership command beyond this slice still fences the ready slot.
  // Deliberately bypass the onmessage abort to exercise the second guard.
  owner.push({ kind: 'session_epoch' });
  expect(owner.queue.hasDataPlaneBarrier()).toBe(true);
  await owner.run();
  expect(owner.queue.size()).toBe(1);
  expect(owner.installed).toEqual([]);
  expect(owner.context.preparedFontFamilyUpdate).not.toBeNull();
  owner.abort();
  owner.push({ kind: 'shutdown' });
  await owner.run();
  expect(owner.installed).toEqual([]);
  expect(owner.context.preparedFontFamilyUpdate).toBeNull();
});
