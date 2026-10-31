import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { DEFAULT_TERMINAL_FONT } from '../apps/web/src/terminal/fonts';
import { emitPerfMetric, summarizeSamples } from './perf/harness';
import { readTerminalWasm } from './perf/terminal-wasm';

const ROOT = path.resolve(import.meta.dir, '..');
const samples = readSampleCount(process.env.BENCH_SAMPLES);
// Both faces are measured. `regular` keeps its historical meaning; `boot` is
// what actually blocks first paint, and the ratio between them is the reason
// the boot face exists.
const regularBytes = await readFontFace(DEFAULT_TERMINAL_FONT.regular);
const bootBytes = await readFontFace(DEFAULT_TERMINAL_FONT.boot);
const wasmBytes = new Uint8Array(await readTerminalWasm());
const wasm = await import('../apps/web/src/term-wasm/pkg/term_wasm.js');
const { memory } = wasm.initSync({ module: wasmBytes });

const regular = measureFace(regularBytes);
const boot = measureFace(bootBytes);

for (const [prefix, measured] of [
  ['terminal-wasm-regular-once-init', regular],
  ['terminal-wasm-boot-once-init', boot],
] as const) {
  emitPerfMetric({
    name: `${prefix}-cold`,
    value: measured.coldDurationMs,
    unit: 'ms/init',
    direction: 'lower',
    sampleSize: 1,
  });
  for (const [suffix, value, percentile] of [
    ['p50', measured.summary.median, 0.5],
    ['p95', measured.summary.p95, 0.95],
    ['p99', measured.summary.p99, 0.99],
  ] as const) {
    emitPerfMetric({
      name: `${prefix}-${suffix}`,
      value,
      unit: 'ms/init',
      direction: 'lower',
      percentile,
      sampleSize: samples,
    });
  }
}

for (const [label, measured] of [
  ['regular', regular],
  ['boot', boot],
] as const) {
  process.stdout.write(
    `terminal WASM ${label}-only init: cold=${measured.coldDurationMs.toFixed(3)}ms ` +
      `steady-samples=${samples} p50=${measured.summary.median.toFixed(3)}ms ` +
      `p95=${measured.summary.p95.toFixed(3)}ms p99=${measured.summary.p99.toFixed(3)}ms\n`,
  );
}

const metricUpdates = {
  unchanged: [
    [14, 1, 1],
    [14, 1, 1],
  ],
  'line-height': [
    [14, 1, 1],
    [14, 1.2, 1],
  ],
  'size-dpr': [
    [14, 1, 1],
    [28, 1, 2],
  ],
  invalid: [
    [0, 1, 1],
    [0, 1, 1],
  ],
} as const;

for (const [label, bytes] of [
  ['regular', regularBytes],
  ['boot', bootBytes],
] as const) {
  for (const scenario of ['unchanged', 'line-height', 'size-dpr', 'invalid'] as const) {
    const terminal = wasm.init_regular(800, 600, bytes, 14, 1.0, 1.0);
    const durations: number[] = [];
    let checksum = 0;
    try {
      for (let sample = 0; sample < samples; sample += 1) {
        const startedAt = performance.now();
        for (let step = 0; step < 32; step += 1) {
          const updates = metricUpdates[scenario];
          const update = step % 2 === 0 ? updates[0] : updates[1];
          terminal.set_cell_metrics(update[0], update[1], update[2]);
        }
        durations.push((performance.now() - startedAt) / 32);
        const metrics = new Uint32Array(memory.buffer, terminal.cell_metrics_ptr(), 4);
        for (const value of metrics) checksum = (Math.imul(checksum, 31) + value) >>> 0;
      }
    } finally {
      terminal.free();
    }
    const summary = summarizeSamples(durations);
    for (const [suffix, value, percentile] of [
      ['p50', summary.median, 0.5],
      ['p95', summary.p95, 0.95],
      ['p99', summary.p99, 0.99],
    ] as const) {
      emitPerfMetric({
        name: `terminal-wasm-${label}-metrics-${scenario}-${suffix}`,
        value,
        unit: 'ms/update',
        direction: 'lower',
        percentile,
        sampleSize: samples,
      });
    }
    process.stdout.write(
      `terminal WASM ${label} metrics ${scenario}: checksum=${checksum} p50=${summary.median.toFixed(6)}ms p99=${summary.p99.toFixed(6)}ms\n`,
    );
  }
}

function measureFace(fontBytes: Uint8Array): {
  readonly coldDurationMs: number;
  readonly summary: ReturnType<typeof summarizeSamples>;
} {
  const coldDurationMs = measureInitialization(fontBytes);
  const durations: number[] = [];
  for (let index = 0; index < samples; index += 1) {
    durations.push(measureInitialization(fontBytes));
  }
  return { coldDurationMs, summary: summarizeSamples(durations) };
}

function measureInitialization(fontBytes: Uint8Array): number {
  const startedAt = performance.now();
  const terminal = wasm.init_regular(800, 600, fontBytes, 14, 1.0, 1.0);
  const durationMs = performance.now() - startedAt;
  terminal.free();
  return durationMs;
}

async function readFontFace(assetUrl: string): Promise<Uint8Array> {
  const { pathname } = new URL(assetUrl, 'https://merkur.local');
  return new Uint8Array(await readFile(path.join(ROOT, 'apps', 'web', 'public', pathname)));
}

function readSampleCount(raw: string | undefined): number {
  const value = Number(raw ?? 100);
  if (!Number.isSafeInteger(value) || value < 100) {
    throw new Error('BENCH_SAMPLES must be a safe integer of at least 100 for p99');
  }
  return value;
}
