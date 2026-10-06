import { gcAndSweep, heapStats, profile } from 'bun:jsc';
import { createKeyboardEngine } from '../packages/keyboard/src/engine';
import {
  CUPERTINO_PORTRAIT_PROFILE,
  hitTestKeyboard,
  solveKeyboardGeometry,
} from '../packages/keyboard/src/geometry';
import { TERMINAL_US_LAYOUT } from '../packages/keyboard/src/layouts/terminal-us';
import { createKeyboardOffsetModel } from '../packages/keyboard/src/offset-model';
import {
  classifyKeyboardTouch,
  createKeyboardSpatialPrior,
} from '../packages/keyboard/src/touch-model';
import type { KeyboardTouchTrace } from '../packages/keyboard/src/types';
import { emitPerfMetric, summarizeSamples } from './perf/harness';

/** Package-only CPU and live-cell diagnostic; setup and trace construction are untimed. */
const geometry = solveKeyboardGeometry(
  TERMINAL_US_LAYOUT,
  'alpha',
  390,
  3,
  CUPERTINO_PORTRAIT_PROFILE,
);
const base = createKeyboardSpatialPrior(geometry);
const prior = Float64Array.from(geometry.keys, (key) =>
  key.definition.value?.length === 1 ? -key.index / 10 : Number.NaN,
);
const traces: KeyboardTouchTrace[] = geometry.keys.map((key) => {
  const x = key.rect.x + key.rect.width * 0.8;
  const y = key.rect.y + key.rect.height * 0.55;
  return {
    predictedKey: key.definition,
    layerId: geometry.layerId,
    pointerId: 1,
    downX: x,
    downY: y,
    trajectoryX: x + 1,
    trajectoryY: y + 1,
    releaseX: x + 2,
    releaseY: y + 2,
    durationMs: 84,
    sampleCount: 8,
    contactAtMs: 0,
    modelCenterX: base.centerX[key.index] ?? 0,
    modelCenterY: base.centerY[key.index] ?? 0,
    spatialKey: key.definition,
  };
});
const learner = createKeyboardOffsetModel();
for (const trace of traces) learner.record(trace, geometry);
const learned = learner.apply(geometry, base);
const spatial = new Int16Array(1);
let sink = 0;
let ordinal = 0;
const engine = createKeyboardEngine({
  geometry,
  profile: CUPERTINO_PORTRAIT_PROFILE,
  touchModel: learned,
  onRawCommit: (key) => {
    sink += key.index;
  },
  onTouchTrace: (trace) => {
    learner.record(trace, geometry);
  },
  timers: { set: () => 0, clear: () => {} },
});
engine.setKeyPrior(prior);

function nextTrace(): KeyboardTouchTrace {
  const trace = traces[ordinal++ % traces.length];
  if (trace === undefined) throw new Error('empty keyboard benchmark');
  return trace;
}

const stages: Record<string, () => void> = {
  hit() {
    const t = nextTrace();
    sink += hitTestKeyboard(geometry, t.downX, t.downY) ?? -1;
  },
  anchor() {
    const t = nextTrace();
    sink +=
      classifyKeyboardTouch(
        geometry,
        learned,
        t.modelCenterX,
        t.modelCenterY,
        t.modelCenterX,
        t.modelCenterY,
        t.modelCenterX,
        t.modelCenterY,
        0,
        prior,
        0.25,
        spatial,
      ) ?? -1;
  },
  tap() {
    const t = nextTrace();
    sink +=
      classifyKeyboardTouch(
        geometry,
        learned,
        t.downX,
        t.downY,
        t.trajectoryX,
        t.trajectoryY,
        t.releaseX,
        t.releaseY,
        0,
        prior,
        0.25,
        spatial,
      ) ?? -1;
  },
  slide() {
    const t = nextTrace();
    sink +=
      classifyKeyboardTouch(
        geometry,
        learned,
        t.downX,
        t.downY,
        t.trajectoryX + 20,
        t.trajectoryY + 5,
        t.releaseX + 40,
        t.releaseY + 10,
        0.4,
        prior,
        0.25,
        spatial,
      ) ?? -1;
  },
  record() {
    sink += Number(learner.record(nextTrace(), geometry));
  },
  correction() {
    const t = nextTrace();
    sink += Number(learner.recordCorrection(t, geometry, t.predictedKey?.id ?? ''));
  },
  apply() {
    sink += learner.apply(geometry, base).centerX[0] ?? 0;
  },
  'learned-tap'() {
    const t = nextTrace();
    const time = ordinal * 100;
    engine.beginPointerAt(1, t.downX, t.downY, time);
    engine.movePointerAt(1, t.trajectoryX, t.trajectoryY, time + 40);
    engine.endPointerAt(1, t.releaseX, t.releaseY, time + 84);
    if (ordinal % 25 === 0) engine.updateTouchModel(learner.apply(geometry, base));
  },
};

function run(operation: () => void, count: number): void {
  for (let index = 0; index < count; index += 1) operation();
}

function cells(): number {
  const counts = heapStats().objectTypeCounts;
  let count = 0;
  for (const type in counts) count += counts[type] ?? 0;
  return count;
}

function cellDelta(operation: () => void, count: number): number {
  gcAndSweep();
  const before = cells();
  run(operation, count);
  return cells() - before;
}

export function runKeyboardHotpathBench(): void {
  const samples = Number(process.env.BENCH_SAMPLES ?? 300);
  const batch = Number(process.env.BENCH_BATCH_SIZE ?? 4096);
  const selectedStage = process.env.BENCH_STAGE;
  if (selectedStage && stages[selectedStage] === undefined) throw new Error('Unknown BENCH_STAGE');
  if (
    !Number.isSafeInteger(samples) ||
    samples <= 0 ||
    !Number.isSafeInteger(batch) ||
    batch <= 0
  ) {
    throw new Error('BENCH_SAMPLES and BENCH_BATCH_SIZE must be positive safe integers');
  }
  for (const [name, operation] of Object.entries(stages)) {
    if (selectedStage && selectedStage !== name) continue;
    run(operation, 100_000);
    if (process.env.BENCH_CPU === '1') {
      process.stdout.write(`${name}\n${profile(() => run(operation, 1_000_000), 100).functions}\n`);
      continue;
    }
    const timings: number[] = [];
    for (let sample = 0; sample < samples; sample += 1) {
      const start = Bun.nanoseconds();
      run(operation, batch);
      timings.push((Bun.nanoseconds() - start) / batch);
    }
    const stats = summarizeSamples(timings);
    process.stdout.write(
      `${name}: p50=${stats.median.toFixed(2)} p95=${stats.p95.toFixed(2)} p99=${stats.p99.toFixed(2)} ns/op\n`,
    );
    for (const [percentile, value] of [
      [0.5, stats.median],
      [0.95, stats.p95],
      [0.99, stats.p99],
    ] as const) {
      emitPerfMetric({
        name: `keyboard-hot-${name}`,
        value,
        percentile,
        unit: 'ns/op',
        direction: 'lower',
        sampleSize: samples,
      });
    }
    // A small synchronous census before GC, corrected by the identical empty loop.
    // Three batch sizes expose collection/noise; these are live cells, not bytes.
    const empty = (): void => {};
    for (const count of [128, 256, 512]) {
      const control = cellDelta(empty, count);
      const delta = cellDelta(operation, count) - control;
      process.stdout.write(`${name}: cells/op(${count})=${(delta / count).toFixed(4)}\n`);
    }
  }
  engine.destroy();
  process.stdout.write(`sink=${sink}\n`);
}

if (import.meta.main) runKeyboardHotpathBench();
