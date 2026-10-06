import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_TERMINAL_FONT } from '../apps/web/src/terminal/fonts';
import {
  createGeometryRenderState,
  GEOMETRY_STATE_LENGTH,
  updateGeometryRenderState,
} from '../apps/web/src/terminal/geometry-render-state';
import type { GeometryBufferRange, GeometryVersions } from '../apps/web/src/terminal-renderer';
import { emitPerfMetric, perfEnvInteger, summarizeSamples } from './perf/harness';

const ROOT = path.resolve(import.meta.dir, '..');
const SAMPLES = perfEnvInteger('BENCH_SAMPLES', 40);
const WARMUPS = readNonNegativeInteger('BENCH_WARMUPS', 5);
const BOUNDARY_ITERATIONS = perfEnvInteger('BENCH_BOUNDARY_ITERATIONS', 20_000);
const NO_DAMAGE_ITERATIONS = perfEnvInteger('BENCH_NO_DAMAGE_ITERATIONS', 5_000);
const DIRTY_ITERATIONS = perfEnvInteger('BENCH_DIRTY_ITERATIONS', 100);
const VIEWPORT_WIDTH = 1_280;
const VIEWPORT_HEIGHT = 720;

await runOrThrow(['bun', 'run', 'sync:wasm']);
const fontUrl = new URL(DEFAULT_TERMINAL_FONT.regular, 'https://merkur.local');
const font = new Uint8Array(
  await readFile(path.join(ROOT, 'apps', 'web', 'public', fontUrl.pathname)),
);
const wasmBytes = new Uint8Array(
  await readFile(path.join(ROOT, 'apps', 'web', 'src', 'term-wasm', 'pkg', 'term_wasm_bg.wasm')),
);
const wasm = await import('../apps/web/src/term-wasm/pkg/term_wasm.js');
const wasmExports = wasm.initSync({ module: wasmBytes });
const memory = wasmExports.memory;

const terminal = wasm.init_regular(VIEWPORT_WIDTH, VIEWPORT_HEIGHT, font, 14, 1, 1);
terminal.commit_presentation_state();
terminal.build_geometry();

const packedPtr = terminal.geometry_state_ptr() >>> 0;
const packedLen = terminal.geometry_state_len() >>> 0;
if (packedLen !== GEOMETRY_STATE_LENGTH) {
  throw new Error(`unexpected packed geometry length ${packedLen}`);
}
let packedBuffer: ArrayBufferLike | null = null;
let packedView: Uint32Array | null = null;
const reusableState = createGeometryRenderState();
let checksum = 0;

function readPackedState(): Uint32Array {
  const buffer = memory.buffer;
  if (packedView === null || packedBuffer !== buffer) {
    packedBuffer = buffer;
    packedView = new Uint32Array(buffer, packedPtr, packedLen);
  }
  return packedView;
}

function collect(): number {
  updateGeometryRenderState(reusableState, readPackedState(), VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
  return consumeGeometry(
    reusableState.bg,
    reusableState.glyph,
    reusableState.deco,
    reusableState.cursor,
    reusableState.viewport,
    reusableState.versions,
  );
}

function consumeGeometry(
  bg: GeometryBufferRange,
  glyph: GeometryBufferRange,
  deco: GeometryBufferRange,
  cursor: GeometryBufferRange,
  viewport: readonly [number, number],
  versions: GeometryVersions,
): number {
  return (
    (bg.ptr +
      bg.count +
      glyph.ptr +
      glyph.count +
      deco.ptr +
      deco.count +
      cursor.ptr +
      cursor.count +
      viewport[0] +
      viewport[1] +
      versions.bg +
      versions.glyph +
      versions.deco +
      versions.cursor +
      versions.bgDirtyOffset +
      versions.bgDirtyCount +
      versions.glyphDirtyOffset +
      versions.glyphDirtyCount +
      versions.decoDirtyOffset +
      versions.decoDirtyCount +
      versions.cursorDirtyOffset +
      versions.cursorDirtyCount) >>>
    0
  );
}

for (let index = 0; index < WARMUPS; index += 1) {
  measureBoundary();
  measureNoDamage();
  measureDirty();
}
const boundarySamples: number[] = [];
const noDamageSamples: number[] = [];
const dirtySamples: number[] = [];
for (let index = 0; index < SAMPLES; index += 1) {
  boundarySamples.push(measureBoundary());
  noDamageSamples.push(measureNoDamage());
  dirtySamples.push(measureDirty());
}

report('terminal-geometry-boundary', boundarySamples);
report('terminal-geometry-no-damage-frame', noDamageSamples);
report('terminal-geometry-dirty-preedit-frame', dirtySamples);
terminal.free();
process.stdout.write(`terminal geometry state: samples=${SAMPLES} checksum=${checksum >>> 0}\n`);

function measureBoundary(): number {
  const startedAt = performance.now();
  for (let index = 0; index < BOUNDARY_ITERATIONS; index += 1) checksum ^= collect();
  return ((performance.now() - startedAt) * 1_000_000) / BOUNDARY_ITERATIONS;
}

function measureNoDamage(): number {
  terminal.set_preedit('', 0);
  terminal.build_geometry();
  const startedAt = performance.now();
  for (let index = 0; index < NO_DAMAGE_ITERATIONS; index += 1) {
    terminal.build_geometry();
    checksum ^= collect();
  }
  return ((performance.now() - startedAt) * 1_000_000) / NO_DAMAGE_ITERATIONS;
}

function measureDirty(): number {
  terminal.set_preedit('', 0);
  terminal.build_geometry();
  const startedAt = performance.now();
  for (let index = 0; index < DIRTY_ITERATIONS; index += 1) {
    const visible = (index & 1) === 0;
    terminal.set_preedit(visible ? 'x' : '', visible ? 1 : 0);
    terminal.build_geometry();
    checksum ^= collect();
  }
  return ((performance.now() - startedAt) * 1_000_000) / DIRTY_ITERATIONS;
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
