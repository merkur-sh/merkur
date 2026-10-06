import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { DEFAULT_TERMINAL_FONT } from '../apps/web/src/terminal/fonts';
import { emitPerfMetric, summarizeSamples } from './perf/harness';

const ROOT = path.resolve(import.meta.dir, '..');
const samples = readCount('BENCH_SAMPLES', process.env.BENCH_SAMPLES, 30, 20);
const warmups = readCount('BENCH_WARMUPS', process.env.BENCH_WARMUPS, 5, 0);

const [regular, bold, italic, boldItalic] = await Promise.all([
  readFont(DEFAULT_TERMINAL_FONT.regular),
  readFont(DEFAULT_TERMINAL_FONT.bold),
  readFont(DEFAULT_TERMINAL_FONT.italic),
  readFont(DEFAULT_TERMINAL_FONT.boldItalic),
]);
const wasmBytes = new Uint8Array(
  await readFile(path.join(ROOT, 'apps', 'web', 'src', 'term-wasm', 'pkg', 'term_wasm_bg.wasm')),
);
const wasm = await import('../apps/web/src/term-wasm/pkg/term_wasm.js');
wasm.initSync({ module: wasmBytes });

type StyleTerminal = ReturnType<typeof wasm.init_regular> & {
  set_style_font_bytes?: (bold: Uint8Array, italic: Uint8Array, boldItalic: Uint8Array) => void;
};

const supportsStyleOnlyUpgrade = (() => {
  const terminal = wasm.init_regular(800, 600, regular, 14, 1.0, 1.0) as StyleTerminal;
  try {
    return typeof terminal.set_style_font_bytes === 'function';
  } finally {
    terminal.free();
  }
})();

for (let index = 0; index < warmups; index += 1) measureUpgrade();
const durations: number[] = [];
for (let index = 0; index < samples; index += 1) durations.push(measureUpgrade());

const summary = summarizeSamples(durations);
for (const [name, value, percentile] of [
  ['terminal-wasm-font-style-upgrade-p50', summary.median, 0.5],
  ['terminal-wasm-font-style-upgrade-p95', summary.p95, 0.95],
  ['terminal-wasm-font-style-upgrade-p99', summary.p99, 0.99],
] as const) {
  emitPerfMetric({
    name,
    value,
    unit: 'ms/upgrade',
    direction: 'lower',
    percentile,
    sampleSize: samples,
  });
}
emitPerfMetric({
  name: 'terminal-wasm-font-style-upgrade-copied-bytes',
  value:
    bold.byteLength +
    italic.byteLength +
    boldItalic.byteLength +
    (supportsStyleOnlyUpgrade ? 0 : regular.byteLength),
  unit: 'bytes/upgrade',
  direction: 'lower',
  sampleSize: 1,
});

process.stdout.write(
  `terminal WASM font style upgrade (${supportsStyleOnlyUpgrade ? 'styles-only' : 'four-face'}): ` +
    `samples=${samples} p50=${summary.median.toFixed(3)}ms ` +
    `p95=${summary.p95.toFixed(3)}ms p99=${summary.p99.toFixed(3)}ms\n`,
);

function measureUpgrade(): number {
  // Regular initialization is deliberately outside the timed region: this
  // workload models the post-first-frame style upgrade in the worker.
  const terminal = wasm.init_regular(800, 600, regular, 14, 1.0, 1.0) as StyleTerminal;
  try {
    const startedAt = performance.now();
    if (terminal.set_style_font_bytes !== undefined) {
      terminal.set_style_font_bytes(bold, italic, boldItalic);
    } else {
      terminal.set_font_bytes(regular, bold, italic, boldItalic);
    }
    return performance.now() - startedAt;
  } finally {
    terminal.free();
  }
}

async function readFont(url: string): Promise<Uint8Array> {
  const fontUrl = new URL(url, 'https://merkur.local');
  return new Uint8Array(await readFile(path.join(ROOT, 'apps', 'web', 'public', fontUrl.pathname)));
}

function readCount(
  name: string,
  raw: string | undefined,
  fallback: number,
  minimum: number,
): number {
  const value = Number(raw ?? fallback);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be a safe integer of at least ${minimum}`);
  }
  return value;
}
