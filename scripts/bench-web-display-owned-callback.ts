/**
 * Cells allocated and time spent per arm/fire cycle of the owned scheduled
 * callbacks (`apps/web/src/lib/owned-scheduled-callback.ts`).
 *
 * Every terminal-worker render frame arms `renderAnimationFrame`, every
 * coherent presentation arms `presentationAnimationFrame`, every bounced ring
 * continuation arms one of the pump timeouts, and every keystroke emit re-arms
 * the input retry timeout. The primitive therefore runs several times per
 * frame and per keystroke on the latency-owning workers, so its own garbage is
 * multiplied by the display and input rates.
 *
 * Workloads drive the production factories through a scheduler double that
 * retains exactly one pending callback, the way a platform timer or animation
 * frame queue does:
 *
 * - `timeout-fire`: arm, then the platform fires it (pump continuations).
 * - `frame-fire`: arm an animation frame, then it fires (render frame).
 * - `timeout-rearm`: cancel and arm again while pending (input retry emit).
 *
 * Cells are `bun:jsc` `heapStats().objectTypeCounts`, summed per type across a
 * run short enough that no collection runs inside it, with a full collection
 * before each snapshot, minus a control loop that performs the same scheduler
 * double work with a prebuilt callback. Time is ns per cycle over longer runs.
 *
 * `BENCH_COMPARE_MODULE=/abs/path.ts` loads a second module with the same
 * exports and interleaves the two in ABBA order, so a candidate and the
 * production module share one process, one JIT, and one machine state. Both
 * modules must pass the same ownership oracle before anything is measured.
 */
import { fullGC, heapStats } from 'bun:jsc';
import * as production from '../apps/web/src/lib/owned-scheduled-callback';
import { emitPerfMetric, perfEnvInteger } from './perf/harness';

type OwnedModule = Pick<typeof production, 'createOwnedTimeout' | 'createOwnedAnimationFrame'>;
type Workload = 'timeout-fire' | 'frame-fire' | 'timeout-rearm';

const WORKLOADS: readonly Workload[] = ['timeout-fire', 'frame-fire', 'timeout-rearm'];
const ALLOCATION_OPS = perfEnvInteger('BENCH_ALLOCATION_OPS', 512);
const ALLOCATION_SAMPLES = perfEnvInteger('BENCH_ALLOCATION_SAMPLES', 15);
const TIMING_OPS = perfEnvInteger('BENCH_TIMING_OPS', 20_000);
const TIMING_SAMPLES = perfEnvInteger('BENCH_TIMING_SAMPLES', 200);
const WARMUPS = perfEnvInteger('BENCH_WARMUPS', 50);

interface Driver {
  run(ops: number): void;
  fired(): number;
}

/** One retained pending callback per queue, like the platform's own timer/frame list. */
interface SchedulerDouble {
  pendingTimer: (() => void) | null;
  pendingFrame: ((frameTimeMs: number) => void) | null;
  nextHandle: number;
}

function createDriver(module: OwnedModule, workload: Workload): Driver {
  const scheduler: SchedulerDouble = { pendingTimer: null, pendingFrame: null, nextHandle: 1 };
  let fired = 0;
  const onTimer = (): void => {
    fired += 1;
  };
  const onFrame = (frameTimeMs: number): void => {
    fired += frameTimeMs > 0 ? 1 : 0;
  };
  const timeout = module.createOwnedTimeout(
    (callback: () => void, _delayMs: number) => {
      scheduler.pendingTimer = callback;
      scheduler.nextHandle += 1;
      return scheduler.nextHandle;
    },
    () => {
      scheduler.pendingTimer = null;
    },
  );
  const frame = module.createOwnedAnimationFrame(
    (callback) => {
      scheduler.pendingFrame = callback;
      scheduler.nextHandle += 1;
      return scheduler.nextHandle;
    },
    () => {
      scheduler.pendingFrame = null;
    },
  );

  const fireTimer = (): void => {
    const callback = scheduler.pendingTimer;
    scheduler.pendingTimer = null;
    callback?.();
  };

  const run = (ops: number): void => {
    if (workload === 'timeout-fire') {
      for (let op = 0; op < ops; op += 1) {
        timeout.arm(onTimer, 4);
        fireTimer();
      }
    } else if (workload === 'frame-fire') {
      for (let op = 0; op < ops; op += 1) {
        frame.arm(onFrame);
        const callback = scheduler.pendingFrame;
        scheduler.pendingFrame = null;
        callback?.(op + 1);
      }
    } else {
      for (let op = 0; op < ops; op += 1) {
        timeout.cancel();
        timeout.arm(onTimer, 4);
      }
      fireTimer();
    }
  };
  return { run, fired: () => fired };
}

/** The scheduler double's own work, with no owned wrapper in between. */
function createControl(): Driver {
  let pending: (() => void) | null = null;
  let fired = 0;
  const onTimer = (): void => {
    fired += 1;
  };
  return {
    run(ops: number): void {
      for (let op = 0; op < ops; op += 1) {
        pending = onTimer;
        const callback = pending;
        pending = null;
        callback?.();
      }
    },
    fired: () => fired,
  };
}

/**
 * The contract both modules must satisfy before either is timed: a cancelled
 * callback the platform still delivers never fires, a replacement fires once,
 * a callback may re-arm its own slot, and a synchronous scheduler is deferred
 * until its handle is published.
 */
function verifyOwnership(module: OwnedModule, label: string): void {
  const retained: Array<() => void> = [];
  const events: string[] = [];
  const timeout = module.createOwnedTimeout(
    (callback: () => void, _delayMs: number) => retained.push(callback),
    () => {},
  );
  timeout.arm(() => events.push('stale'), 1);
  timeout.arm(() => {
    events.push('replacement');
    timeout.arm(() => events.push('rearmed'), 1);
  }, 1);
  retained[0]?.();
  retained[1]?.();
  retained[1]?.();
  retained[2]?.();

  let frameTime = 0;
  const inline = module.createOwnedAnimationFrame(
    (callback) => {
      callback(12.5);
      return 7;
    },
    () => {},
  );
  inline.arm((time) => {
    frameTime = time;
  });

  const expected = ['replacement', 'rearmed'];
  if (
    events.join(',') !== expected.join(',') ||
    timeout.isArmed() ||
    frameTime !== 12.5 ||
    inline.isArmed()
  ) {
    throw new Error(
      `${label}: ownership oracle failed: ${JSON.stringify({ events, frameTime, armed: timeout.isArmed() })}`,
    );
  }
}

type SchedulerMode =
  | 'plain'
  | 'inline'
  | 'cancel-inside'
  | 'rearm-inside'
  | 'throw'
  | 'inline-cancel';
const SCHEDULER_MODES: readonly SchedulerMode[] = [
  'inline',
  'cancel-inside',
  'rearm-inside',
  'throw',
  'inline-cancel',
];
const REENTRANCY_SEEDS = perfEnvInteger('BENCH_REENTRANCY_SEEDS', 2_000);
const REENTRANCY_STEPS = 60;

/**
 * A seeded trace of one slot under the scheduler shapes the ownership oracle
 * does not reach: a scheduler that runs the callback inline, cancels or re-arms
 * the slot from inside `schedule`, or throws; stale deliveries of retained
 * callbacks; and callbacks that re-arm their own slot. Every schedule and cancel
 * call is logged with its handle, so two modules agree only if they make the
 * same platform calls in the same order and fire the same callbacks with the
 * same arguments. A timer is delivered with no arguments, as the platform does.
 */
function reentrancyTrace(module: OwnedModule, seed: number): string {
  const log: string[] = [];
  let state = seed >>> 0;
  const random = (bound: number): number => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state % bound;
  };
  const isFrame = seed % 2 === 0;
  const retained: Array<{ handle: number; deliver: () => void }> = [];
  let nextHandle = 1;
  let mode: SchedulerMode = 'plain';
  let reentered = false;
  let slotRef: { arm(callback: () => void): void; cancel(): void } | null = null;

  const schedule = (deliver: () => void, delay: string): number => {
    const handle = nextHandle;
    nextHandle += 1;
    log.push(`schedule h${handle} ${delay} ${mode}`);
    if (mode === 'throw') throw new Error('scheduler threw');
    retained.push({ handle, deliver });
    if (mode === 'inline' || mode === 'inline-cancel') deliver();
    if (!reentered && (mode === 'cancel-inside' || mode === 'inline-cancel')) {
      reentered = true;
      slotRef?.cancel();
    }
    if (!reentered && mode === 'rearm-inside') {
      reentered = true;
      slotRef?.arm(() => log.push('fire inner'));
    }
    return handle;
  };
  const cancelHandle = (handle: number): void => {
    log.push(`cancel h${handle}`);
  };

  let arm: (fire: (frameTimeMs?: number) => void) => void;
  let slot: { cancel(): void; isArmed(): boolean };
  if (isFrame) {
    const frame = module.createOwnedAnimationFrame(
      (callback) => schedule(() => callback(1_000 + nextHandle), 'frame'),
      cancelHandle,
    );
    arm = (fire) => frame.arm((frameTimeMs) => fire(frameTimeMs));
    slot = frame;
  } else {
    const timeout = module.createOwnedTimeout(
      (callback: () => void, delayMs: number) => schedule(() => callback(), `d${delayMs}`),
      cancelHandle,
    );
    arm = (fire) => timeout.arm(() => fire(), 7);
    slot = timeout;
  }
  slotRef = {
    arm(callback: () => void): void {
      arm(() => callback());
    },
    cancel(): void {
      slot.cancel();
    },
  };

  for (let step = 0; step < REENTRANCY_STEPS; step += 1) {
    reentered = false;
    mode = random(10) < 6 ? 'plain' : (SCHEDULER_MODES[random(SCHEDULER_MODES.length)] ?? 'plain');
    const operation = random(6);
    try {
      if (operation <= 2) {
        const id = step;
        arm((frameTimeMs) => {
          log.push(`fire ${id} t${frameTimeMs ?? '-'}`);
          if (random(4) === 0) {
            mode = 'plain';
            arm((innerTimeMs) => log.push(`fire rearm ${id} t${innerTimeMs ?? '-'}`));
          }
        });
      } else if (operation === 3) {
        mode = 'plain';
        slot.cancel();
      } else {
        mode = 'plain';
        const stale = retained.length === 0 ? undefined : retained[random(retained.length)];
        stale?.deliver();
      }
    } catch (error) {
      log.push(`threw ${error instanceof Error ? error.message : String(error)}`);
    }
    log.push(`armed=${slot.isArmed()}`);
  }
  return log.join('\n');
}

/** Both modules must produce byte-identical re-entrancy traces for every seed. */
function verifyReentrancy(modules: readonly OwnedModule[]): void {
  const [reference, ...others] = modules;
  if (reference === undefined || others.length === 0) return;
  for (let seed = 1; seed <= REENTRANCY_SEEDS; seed += 1) {
    const expected = reentrancyTrace(reference, seed);
    for (const other of others) {
      if (reentrancyTrace(other, seed) !== expected) {
        throw new Error(`re-entrancy oracle diverged at seed ${seed}`);
      }
    }
  }
  process.stdout.write(
    `re-entrancy oracle: ${REENTRANCY_SEEDS} seeds x ${REENTRANCY_STEPS} steps identical across ${modules.length} modules\n`,
  );
}

function cellsByType(): Map<string, number> {
  const counts = heapStats().objectTypeCounts;
  const result = new Map<string, number>();
  for (const key in counts) result.set(key, counts[key] ?? 0);
  return result;
}

function allocationDelta(driver: Driver, ops: number): Map<string, number> {
  fullGC();
  const before = cellsByType();
  driver.run(ops);
  const after = cellsByType();
  const delta = new Map<string, number>();
  for (const [key, value] of after) {
    const change = value - (before.get(key) ?? 0);
    if (change !== 0) delta.set(key, change);
  }
  return delta;
}

function sumCells(delta: Map<string, number>): number {
  let total = 0;
  for (const value of delta.values()) total += value;
  return total;
}

interface AllocationResult {
  readonly cellsPerOp: number;
  readonly byType: Record<string, number>;
}

function measureAllocations(module: OwnedModule, workload: Workload): AllocationResult {
  const driver = createDriver(module, workload);
  const control = createControl();
  for (let warmup = 0; warmup < WARMUPS; warmup += 1) {
    driver.run(ALLOCATION_OPS);
    control.run(ALLOCATION_OPS);
  }
  const perOp: number[] = [];
  let medianTypes = new Map<string, number>();
  const samples: Array<{ perOp: number; types: Map<string, number> }> = [];
  for (let sample = 0; sample < ALLOCATION_SAMPLES; sample += 1) {
    const controlDelta = allocationDelta(control, ALLOCATION_OPS);
    const pathDelta = allocationDelta(driver, ALLOCATION_OPS);
    const types = new Map<string, number>();
    for (const [key, value] of pathDelta) {
      const net = value - (controlDelta.get(key) ?? 0);
      if (net !== 0) types.set(key, net / ALLOCATION_OPS);
    }
    for (const [key, value] of controlDelta) {
      if (!pathDelta.has(key)) types.set(key, -value / ALLOCATION_OPS);
    }
    const net = (sumCells(pathDelta) - sumCells(controlDelta)) / ALLOCATION_OPS;
    perOp.push(net);
    samples.push({ perOp: net, types });
  }
  samples.sort((left, right) => left.perOp - right.perOp);
  const median = samples[Math.floor(samples.length / 2)];
  medianTypes = median?.types ?? medianTypes;
  const byType: Record<string, number> = {};
  for (const [key, value] of medianTypes) {
    // Structure/Object noise below one cell per 16 ops is the heap snapshot itself.
    if (Math.abs(value) >= 1 / 16) byType[key] = Number(value.toFixed(3));
  }
  perOp.sort((left, right) => left - right);
  return { cellsPerOp: perOp[Math.floor(perOp.length / 2)] ?? Number.NaN, byType };
}

interface TimingResult {
  readonly medianNs: number;
  readonly p95Ns: number;
  readonly samples: number;
}

function timeSample(driver: Driver): number {
  const startedAt = performance.now();
  driver.run(TIMING_OPS);
  return ((performance.now() - startedAt) * 1_000_000) / TIMING_OPS;
}

function summarize(samples: number[]): TimingResult {
  samples.sort((left, right) => left - right);
  return {
    medianNs: samples[Math.floor(samples.length / 2)] ?? Number.NaN,
    p95Ns:
      samples[Math.min(samples.length - 1, Math.ceil(samples.length * 0.95) - 1)] ?? Number.NaN,
    samples: samples.length,
  };
}

/** ABBA-interleaved timing of up to two modules for one workload. */
function measureTiming(
  modules: readonly OwnedModule[],
  workload: Workload,
): { results: TimingResult[]; paired: TimingResult | null } {
  const drivers = modules.map((module) => createDriver(module, workload));
  for (let warmup = 0; warmup < WARMUPS; warmup += 1) {
    for (const driver of drivers) driver.run(TIMING_OPS);
  }
  const perModule: number[][] = drivers.map(() => []);
  const differences: number[] = [];
  for (let sample = 0; sample < TIMING_SAMPLES; sample += 1) {
    const order = sample % 4 === 0 || sample % 4 === 3 ? [0, 1] : [1, 0];
    const round: number[] = [];
    for (const index of order) {
      const driver = drivers[index];
      if (driver === undefined) continue;
      const value = timeSample(driver);
      perModule[index]?.push(value);
      round[index] = value;
    }
    const first = round[0];
    const second = round[1];
    if (first !== undefined && second !== undefined) differences.push(second - first);
  }
  return {
    results: perModule.map((samples) => summarize(samples)),
    paired: differences.length > 0 ? summarize(differences) : null,
  };
}

async function loadCompareModule(): Promise<OwnedModule | null> {
  const modulePath = process.env.BENCH_COMPARE_MODULE;
  if (modulePath === undefined || modulePath.length === 0) return null;
  const loaded = (await import(modulePath)) as Partial<OwnedModule>;
  if (loaded.createOwnedTimeout === undefined || loaded.createOwnedAnimationFrame === undefined) {
    throw new Error(`${modulePath} does not export the owned scheduled callback factories`);
  }
  return {
    createOwnedTimeout: loaded.createOwnedTimeout,
    createOwnedAnimationFrame: loaded.createOwnedAnimationFrame,
  };
}

if (import.meta.main) {
  const compare = await loadCompareModule();
  const modules: OwnedModule[] = compare === null ? [production] : [production, compare];
  const labels = compare === null ? ['production'] : ['production', 'compare'];
  modules.forEach((module, index) => {
    verifyOwnership(module, labels[index] ?? 'module');
  });
  verifyReentrancy(modules);

  process.stdout.write(
    `owned scheduled callback benchmark: allocationOps=${ALLOCATION_OPS}, ` +
      `allocationSamples=${ALLOCATION_SAMPLES}, timingOps=${TIMING_OPS}, ` +
      `timingSamples=${TIMING_SAMPLES}, warmups=${WARMUPS}\n`,
  );
  for (const workload of WORKLOADS) {
    const timing = measureTiming(modules, workload);
    modules.forEach((module, index) => {
      const label = labels[index] ?? 'module';
      const allocation = measureAllocations(module, workload);
      const time = timing.results[index];
      process.stdout.write(
        `${workload} [${label}]: cells/op=${allocation.cellsPerOp.toFixed(3)} ` +
          `${JSON.stringify(allocation.byType)}, ` +
          `ns/op median=${time?.medianNs.toFixed(2)} p95=${time?.p95Ns.toFixed(2)} (n=${time?.samples})\n`,
      );
      if (label === 'production') {
        emitPerfMetric({
          name: `owned-callback-${workload}-cells`,
          value: allocation.cellsPerOp,
          unit: 'cells/op',
          direction: 'lower',
          sampleSize: ALLOCATION_SAMPLES,
        });
        emitPerfMetric({
          name: `owned-callback-${workload}-time`,
          value: time?.medianNs ?? Number.NaN,
          unit: 'ns/op',
          direction: 'lower',
          percentile: 0.5,
          sampleSize: TIMING_SAMPLES,
        });
      }
    });
    if (timing.paired !== null) {
      process.stdout.write(
        `${workload} [compare - production]: paired ns/op median=${timing.paired.medianNs.toFixed(2)} ` +
          `p95=${timing.paired.p95Ns.toFixed(2)} (n=${timing.paired.samples}, ABBA)\n`,
      );
    }
  }
}
