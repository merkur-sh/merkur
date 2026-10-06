import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { DEFAULT_TERMINAL_FONT } from '../apps/web/src/terminal/fonts';
import { emitPerfMetric, perfEnvInteger, summarizeSamples } from './perf/harness';

const ROOT = path.resolve(import.meta.dir, '..');
const SAMPLES = perfEnvInteger('BENCH_SAMPLES', 40);
const WARMUPS = readNonNegativeInteger('BENCH_WARMUPS', 5);
const ITERATIONS = perfEnvInteger('BENCH_ITERATIONS', 100_000);

await runOrThrow(['bun', 'run', 'sync:wasm']);
const { createWasmTerminalHandle } = await import('../apps/web/src/wasm-loader');
const fontUrl = new URL(DEFAULT_TERMINAL_FONT.regular, 'https://merkur.local');
const fontBytes = await readFile(path.join(ROOT, 'apps', 'web', 'public', fontUrl.pathname));
const regularFont = fontBytes.buffer.slice(
  fontBytes.byteOffset,
  fontBytes.byteOffset + fontBytes.byteLength,
) as ArrayBuffer;
const terminal = await createWasmTerminalHandle(1_280, 720, regularFont, 14, 1, 1);
terminal.commitPresentationState();
terminal.buildGeometry();

const firstCursor = terminal.cursorInfo();
const cursorIdentityStable = firstCursor === terminal.cursorInfo();

let checksum = 0;
for (let sample = 0; sample < WARMUPS; sample += 1) {
  measureCursor();
}
const cursorSamples: number[] = [];
for (let sample = 0; sample < SAMPLES; sample += 1) {
  cursorSamples.push(measureCursor());
}

report('terminal-render-cursor-reader', cursorSamples);

// The same read with the backwards-cursor journal armed.
//
// The journal is what tells a retracted prediction from an authoritative frame
// carrying the wrong cursor, and it is armed whenever perf is enabled — which
// is exactly when someone is measuring latency, so its own cost has to be a
// number rather than an assurance. Nothing here steps the cursor backwards, so
// this is the steady-state armed cost: the comparison, not the recording.
terminal.setCursorMotionJournal(true);
for (let sample = 0; sample < WARMUPS; sample += 1) {
  measureCursor();
}
const journalledSamples: number[] = [];
for (let sample = 0; sample < SAMPLES; sample += 1) {
  journalledSamples.push(measureCursor());
}
const journalledSteps = terminal.cursorMotion().length;
terminal.setCursorMotionJournal(false);

report('terminal-render-cursor-reader-journalled', journalledSamples);
emitPerfMetric({
  name: 'terminal-render-reader-array-allocations',
  value: Number(!cursorIdentityStable),
  unit: 'objects/frame',
  direction: 'lower',
  sampleSize: 1,
});
terminal.destroy();
process.stdout.write(
  `terminal render readers: samples=${SAMPLES} iterations=${ITERATIONS} ` +
    `cursorStable=${cursorIdentityStable} journalledSteps=${journalledSteps} ` +
    `checksum=${checksum >>> 0}\n`,
);
if (journalledSteps !== 0) {
  throw new Error(
    `the armed journal recorded ${journalledSteps} words on a still cursor, so the ` +
      'measurement above is of the recording path rather than the comparison',
  );
}

function measureCursor(): number {
  const startedAt = performance.now();
  for (let index = 0; index < ITERATIONS; index += 1) {
    const cursor = terminal.cursorInfo();
    checksum = (checksum + (cursor[index % cursor.length] ?? 0)) >>> 0;
  }
  return ((performance.now() - startedAt) * 1_000_000) / ITERATIONS;
}

function report(name: string, values: readonly number[]): void {
  const summary = summarizeSamples(values);
  for (const [suffix, value, percentile] of [
    ['p50', summary.median, 0.5],
    ['p95', summary.p95, 0.95],
    ['p99', summary.p99, 0.99],
  ] as const) {
    emitPerfMetric({
      name: `${name}-${suffix}`,
      value,
      unit: 'ns/frame',
      direction: 'lower',
      percentile,
      sampleSize: values.length,
    });
  }
}

function readNonNegativeInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  return value;
}

async function runOrThrow(command: readonly string[]): Promise<void> {
  const processHandle = Bun.spawn([...command], {
    cwd: ROOT,
    stdout: 'ignore',
    stderr: 'inherit',
  });
  const exitCode = await processHandle.exited;
  if (exitCode !== 0) throw new Error(`${command.join(' ')} exited with ${exitCode}`);
}
