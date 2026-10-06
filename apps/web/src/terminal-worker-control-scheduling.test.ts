import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('./terminal-worker.ts', import.meta.url), 'utf8');
const program = new Bun.Transpiler({ loader: 'ts' }).transformSync(
  ['async function runControlPump(', 'function scheduleControlPumpContinuation(']
    .map((signature) => {
      const start = source.indexOf(signature);
      const end = source.indexOf('\n}', start);
      if (start < 0 || end < start) throw new Error(`missing production ${signature}`);
      return source.slice(start, end + 2);
    })
    .join('\n'),
);

function harness(kinds: string[]) {
  const commands = kinds.map((kind) => ({ kind }));
  const events: string[] = [];
  const tasks: (() => Promise<unknown>)[] = [];
  let displayBudgets = 0;
  const context = {
    peerFences: [],
    wasmTerminal: {},
    controlPumpActive: false,
    controlPumpScheduled: false,
    controlQueueOverflowReported: false,
    activeControlBlocksDataPlane: false,
    CONTROL_COMMANDS_PER_SLICE: 4,
    controlQueueSize: () => commands.length,
    controlQueue: {
      shift: () => commands.shift(),
      hasDataPlaneBarrier: () => commands.some((cmd) => cmd.kind === 'session_epoch'),
    },
    commitPreparedFontFamilyUpdate: () => {},
    workerControlCommandBlocksDataPlane: (cmd: { kind: string }) => cmd.kind === 'session_epoch',
    handleControlCommand: (cmd: { kind: string }) => {
      events.push(cmd.kind);
    },
    runDisplayPump: () => {
      if (
        context.activeControlBlocksDataPlane ||
        commands.some((cmd) => cmd.kind === 'session_epoch')
      ) {
        return;
      }
      events.push('display');
      displayBudgets += 1;
    },
    runDataPlaneFairnessSlice: () => context.runDisplayPump(),
    pumpPredictionRing: () => events.push('prediction'),
    predictionRingPumpToken: 1,
    predictionFastPath: null,
    continueDisplayOwner: () => events.push('park-or-fair-display'),
    armPresentationCommit: () => {},
    reportFatal: (error: unknown) => {
      throw error;
    },
    bounceControlPumpContinuation: () => {
      events.push('fair-control-task');
      tasks.push(async () => {
        context.controlPumpScheduled = false;
        return await runInNewContext('runControlPump();', context);
      });
    },
  };
  runInNewContext(program, context);
  return {
    events,
    tasks,
    context,
    displayBudgets: () => displayBudgets,
    run: async () => await runInNewContext('runControlPump();', context),
  };
}

test('distinct synchronous controls share one display budget before a real task boundary', async () => {
  const owner = harness([
    'resize',
    'theme_update',
    'font_update',
    'render_refresh',
    'measurement',
    'health',
    'resize',
    'theme_update',
    'render_refresh',
  ]);
  await owner.run();
  expect(owner.events).toEqual([
    'resize',
    'theme_update',
    'font_update',
    'render_refresh',
    'display',
    'fair-control-task',
  ]);
  expect(owner.displayBudgets()).toBe(1);
  expect(owner.tasks).toHaveLength(1);
  // A browser/input/rAF task can run here; microtasks alone cannot run the
  // second control slice.
  owner.events.push('other-task');
  await owner.tasks.shift()?.();
  expect(owner.displayBudgets()).toBe(2);
  expect(owner.events.indexOf('other-task')).toBeLessThan(owner.events.indexOf('measurement'));
  expect(owner.tasks).toHaveLength(1);
  await owner.tasks.shift()?.();
  expect(owner.displayBudgets()).toBe(3);
  expect(owner.tasks).toHaveLength(0);
});

test('starting a non-owning font fetch preserves the single control-slice display budget', async () => {
  const owner = harness(['font_family_update', 'resize', 'theme_update', 'render_refresh']);
  await owner.run();
  expect(owner.events.slice(0, 4)).toEqual([
    'font_family_update',
    'resize',
    'theme_update',
    'render_refresh',
  ]);
  expect(owner.context.controlPumpActive).toBe(false);
  expect(owner.displayBudgets()).toBe(1);
  expect(owner.events).toContain('park-or-fair-display');
});

test('an ownership barrier has its turn before the next display grant', async () => {
  const owner = harness(['font_family_update', 'session_epoch']);
  await owner.run();
  expect(owner.events.indexOf('session_epoch')).toBeLessThan(owner.events.indexOf('display'));
  expect(owner.context.activeControlBlocksDataPlane).toBe(false);
});
