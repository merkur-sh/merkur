/**
 * Cells and time per refresh-estimator read and per calibration sample.
 *
 * `presentationPeriodMs()` is read by the terminal worker on every display pump
 * (the drain's CPU slice), every render-gate wait, and every profiled render.
 * The estimator classifies a session as variable-refresh when the continuous
 * calibration deltas spread by more than its hysteresis bound, which a real
 * VRR panel does and which a browser's 1 ms rAF timestamp quantization does at
 * 60 and 120 Hz alike. Once classified, every read derives the P10 of the
 * 32-entry period ring.
 *
 * Workloads, each on the production estimator:
 *
 * - `read-vrr`: `presentationPeriodMs()` after a 1 ms-quantized 120 Hz
 *   calibration stream, which the estimator classifies as VRR.
 * - `read-fixed`: the same read after an exact 120 Hz stream (not VRR), the
 *   control for the read itself.
 * - `calibration-sample`: one continuous `sample()` of a quantized burst, the
 *   calibrator's per-frame cost once the period ring is full.
 *
 * An oracle replays one deterministic stream mixing continuous and demand
 * samples, jitter, idle gaps, rate changes and resets, and records every public
 * reading after every sample. With `BENCH_COMPARE_MODULE=/abs/path.ts` the two
 * modules must produce the identical trace before any timing runs, and timing
 * interleaves them in ABBA order in one process.
 */
import { fullGC, heapStats } from 'bun:jsc';
import * as production from '../apps/web/src/terminal/refresh-rate-estimator';
import { emitPerfMetric, perfEnvInteger } from './perf/harness';

type EstimatorModule = Pick<typeof production, 'createRefreshRateEstimator'>;
type Estimator = ReturnType<EstimatorModule['createRefreshRateEstimator']>;
type Workload = 'read-vrr' | 'read-fixed' | 'calibration-sample';

const WORKLOADS: readonly Workload[] = ['read-vrr', 'read-fixed', 'calibration-sample'];
const ALLOCATION_OPS = perfEnvInteger('BENCH_ALLOCATION_OPS', 512);
const ALLOCATION_SAMPLES = perfEnvInteger('BENCH_ALLOCATION_SAMPLES', 15);
const TIMING_OPS = perfEnvInteger('BENCH_TIMING_OPS', 10_000);
const TIMING_SAMPLES = perfEnvInteger('BENCH_TIMING_SAMPLES', 200);
const WARMUPS = perfEnvInteger('BENCH_WARMUPS', 30);
const PERIOD_120_HZ_MS = 1000 / 120;
const CALIBRATION_FRAMES = 64;

let sink = 0;

/** Feed a continuous stream; `quantumMs` models the browser's timestamp precision. */
function calibrate(
  estimator: Estimator,
  startMs: number,
  frames: number,
  quantumMs: number,
): number {
  let exact = startMs;
  for (let frame = 0; frame < frames; frame += 1) {
    exact += PERIOD_120_HZ_MS;
    estimator.sample(quantumMs > 0 ? Math.floor(exact / quantumMs) * quantumMs : exact, true);
  }
  return exact;
}

interface Driver {
  run(ops: number): void;
}

function createDriver(module: EstimatorModule, workload: Workload): Driver {
  const estimator = module.createRefreshRateEstimator();
  const quantized = workload !== 'read-fixed';
  let clock = calibrate(estimator, 1_000, CALIBRATION_FRAMES, quantized ? 1 : 0);
  if (estimator.vrr() !== quantized) {
    throw new Error(`${workload}: expected vrr=${quantized}, estimator reports ${estimator.vrr()}`);
  }
  if (workload === 'calibration-sample') {
    return {
      run(ops: number): void {
        for (let op = 0; op < ops; op += 1) {
          clock += PERIOD_120_HZ_MS;
          estimator.sample(Math.floor(clock), true);
        }
        sink += estimator.vrr() ? 1 : 0;
      },
    };
  }
  return {
    run(ops: number): void {
      let total = 0;
      for (let op = 0; op < ops; op += 1) total += estimator.presentationPeriodMs();
      sink += total;
    },
  };
}

/** Deterministic xorshift so the oracle stream is identical for both modules. */
function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

type Reading = [number, number, number, number | null, boolean];

function read(estimator: Estimator, nowMs: number): Reading {
  return [
    estimator.periodMs(),
    estimator.presentationPeriodMs(),
    estimator.confidence01(),
    estimator.nextVsyncAfter(nowMs),
    estimator.vrr(),
  ];
}

/** Every public reading after every sample of a stream that visits every state. */
function oracleTrace(module: EstimatorModule): Reading[] {
  const estimator = module.createRefreshRateEstimator();
  const random = createRandom(0x5eed_1234);
  const trace: Reading[] = [];
  let now = 500;
  const phases: Array<{ period: number; quantum: number; frames: number }> = [
    { period: PERIOD_120_HZ_MS, quantum: 1, frames: 120 },
    { period: PERIOD_120_HZ_MS, quantum: 0, frames: 80 },
    { period: 1000 / 60, quantum: 1, frames: 120 },
    { period: 1000 / 144, quantum: 0.1, frames: 90 },
    { period: 1000 / 60, quantum: 0, frames: 60 },
  ];
  for (const phase of phases) {
    for (let frame = 0; frame < phase.frames; frame += 1) {
      const jitter = (random() - 0.5) * 0.6;
      const skipped = random() < 0.08 ? 1 + Math.floor(random() * 3) : 0;
      now += phase.period * (1 + skipped) + jitter;
      if (random() < 0.02) now += 400;
      const stamp = phase.quantum > 0 ? Math.floor(now / phase.quantum) * phase.quantum : now;
      estimator.sample(stamp, random() < 0.8);
      trace.push(read(estimator, stamp + phase.period / 3));
    }
    if (random() < 0.5) estimator.reset();
  }
  return trace;
}

function verifyEquivalent(modules: readonly EstimatorModule[]): void {
  const traces = modules.map(oracleTrace);
  const reference = JSON.stringify(traces[0]);
  for (let index = 1; index < traces.length; index += 1) {
    if (JSON.stringify(traces[index]) !== reference) {
      throw new Error(`module ${index} diverges from production on the oracle stream`);
    }
  }
  const vrrReadings = traces[0]?.filter((reading) => reading[4]).length ?? 0;
  process.stdout.write(
    `oracle: ${traces[0]?.length ?? 0} readings (${vrrReadings} while VRR), ` +
      `${modules.length} module(s) identical\n`,
  );
}

function cellTotal(): number {
  const counts = heapStats().objectTypeCounts;
  let total = 0;
  for (const key in counts) total += counts[key] ?? 0;
  return total;
}

function measureCells(driver: Driver): number {
  const control: Driver = { run: () => {} };
  for (let warmup = 0; warmup < WARMUPS; warmup += 1) driver.run(ALLOCATION_OPS);
  const perOp: number[] = [];
  for (let sample = 0; sample < ALLOCATION_SAMPLES; sample += 1) {
    fullGC();
    const controlBefore = cellTotal();
    control.run(ALLOCATION_OPS);
    const controlCells = cellTotal() - controlBefore;
    fullGC();
    const before = cellTotal();
    driver.run(ALLOCATION_OPS);
    perOp.push((cellTotal() - before - controlCells) / ALLOCATION_OPS);
  }
  perOp.sort((left, right) => left - right);
  return perOp[Math.floor(perOp.length / 2)] ?? Number.NaN;
}

interface Summary {
  readonly median: number;
  readonly p95: number;
  readonly count: number;
}

function summarize(values: number[]): Summary {
  values.sort((left, right) => left - right);
  return {
    median: values[Math.floor(values.length / 2)] ?? Number.NaN,
    p95: values[Math.min(values.length - 1, Math.ceil(values.length * 0.95) - 1)] ?? Number.NaN,
    count: values.length,
  };
}

function timeOnce(driver: Driver): number {
  const startedAt = performance.now();
  driver.run(TIMING_OPS);
  return ((performance.now() - startedAt) * 1_000_000) / TIMING_OPS;
}

function measureTiming(
  modules: readonly EstimatorModule[],
  workload: Workload,
): { perModule: Summary[]; paired: Summary | null } {
  const drivers = modules.map((module) => createDriver(module, workload));
  for (let warmup = 0; warmup < WARMUPS; warmup += 1) {
    for (const driver of drivers) driver.run(TIMING_OPS);
  }
  const samples: number[][] = drivers.map(() => []);
  const differences: number[] = [];
  for (let sample = 0; sample < TIMING_SAMPLES; sample += 1) {
    const order = sample % 4 === 0 || sample % 4 === 3 ? [0, 1] : [1, 0];
    const round: number[] = [];
    for (const index of order) {
      const driver = drivers[index];
      if (driver === undefined) continue;
      round[index] = timeOnce(driver);
      samples[index]?.push(round[index] ?? Number.NaN);
    }
    if (round[0] !== undefined && round[1] !== undefined) differences.push(round[1] - round[0]);
  }
  return {
    perModule: samples.map((values) => summarize(values)),
    paired: differences.length > 0 ? summarize(differences) : null,
  };
}

async function loadCompareModule(): Promise<EstimatorModule | null> {
  const modulePath = process.env.BENCH_COMPARE_MODULE;
  if (modulePath === undefined || modulePath.length === 0) return null;
  const loaded = (await import(modulePath)) as Partial<EstimatorModule>;
  if (loaded.createRefreshRateEstimator === undefined) {
    throw new Error(`${modulePath} does not export createRefreshRateEstimator`);
  }
  return { createRefreshRateEstimator: loaded.createRefreshRateEstimator };
}

if (import.meta.main) {
  const compare = await loadCompareModule();
  const modules: EstimatorModule[] = compare === null ? [production] : [production, compare];
  const labels = compare === null ? ['production'] : ['production', 'compare'];
  verifyEquivalent(modules);
  process.stdout.write(
    `refresh estimator benchmark: allocationOps=${ALLOCATION_OPS}, allocationSamples=${ALLOCATION_SAMPLES}, ` +
      `timingOps=${TIMING_OPS}, timingSamples=${TIMING_SAMPLES}, warmups=${WARMUPS}\n`,
  );
  for (const workload of WORKLOADS) {
    const timing = measureTiming(modules, workload);
    modules.forEach((module, index) => {
      const cells = measureCells(createDriver(module, workload));
      const time = timing.perModule[index];
      const label = labels[index] ?? 'module';
      process.stdout.write(
        `${workload} [${label}]: cells/op=${cells.toFixed(3)}, ns/op median=${time?.median.toFixed(2)} ` +
          `p95=${time?.p95.toFixed(2)} (n=${time?.count})\n`,
      );
      if (label !== 'production') return;
      emitPerfMetric({
        name: `refresh-estimator-${workload}-cells`,
        value: cells,
        unit: 'cells/op',
        direction: 'lower',
        sampleSize: ALLOCATION_SAMPLES,
      });
      emitPerfMetric({
        name: `refresh-estimator-${workload}-time`,
        value: time?.median ?? Number.NaN,
        unit: 'ns/op',
        direction: 'lower',
        percentile: 0.5,
        sampleSize: TIMING_SAMPLES,
      });
    });
    if (timing.paired !== null) {
      process.stdout.write(
        `${workload} [compare - production]: paired ns/op median=${timing.paired.median.toFixed(2)} ` +
          `p95=${timing.paired.p95.toFixed(2)} (n=${timing.paired.count}, ABBA)\n`,
      );
    }
  }
  process.stdout.write(`sink=${sink.toFixed(0)}\n`);
}
