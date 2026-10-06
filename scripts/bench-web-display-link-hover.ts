/**
 * Cells and time per link resolution while the link modifier is held.
 *
 * The terminal client resolves the link under the pointer once per grid cell
 * the pointer enters (`linkAtPoint` caches the answer per cell), so sweeping a
 * URL with Ctrl/Cmd held calls `findLinkAt` once per cell of it, and the hover
 * layer then rebuilds its identity key for every hit object it has not seen.
 *
 * Workloads, on one production-shaped viewport read (the same `LinkViewport`
 * object for the whole sweep, as the client keeps it until the grid changes):
 *
 * - `text-sweep`: every cell of a 150-character https URL the terminal wrapped
 *   across two rows, matched by the production `linkify-it` matcher.
 * - `osc8-sweep`: every cell of an OSC 8 link whose text spans two rows.
 *
 * Reported per `findLinkAt` call: `bun:jsc` cells with a full collection before
 * each snapshot, and ns. With `BENCH_COMPARE_MODULE=/abs/path.ts` a second
 * link-detection module must first return an equal hit (url and spans) for
 * every cell of both viewports, then both are timed in ABBA order.
 */
import { fullGC, heapStats } from 'bun:jsc';
import * as production from '../apps/web/src/terminal/link-detection';
import { createUrlMatcher } from '../apps/web/src/terminal/url-matcher';
import { emitPerfMetric, perfEnvInteger } from './perf/harness';

type LinkModule = Pick<typeof production, 'findLinkAt'>;
type LinkViewport = production.LinkViewport;

const COLS = 120;
const ROWS = 40;
const ALLOCATION_SAMPLES = perfEnvInteger('BENCH_ALLOCATION_SAMPLES', 15);
const TIMING_SAMPLES = perfEnvInteger('BENCH_TIMING_SAMPLES', 150);
const TIMING_SWEEPS = perfEnvInteger('BENCH_TIMING_SWEEPS', 40);
const WARMUPS = perfEnvInteger('BENCH_WARMUPS', 30);
const URL_TEXT = `https://example.com/${'path-segment/'.repeat(10)}index.html?query=value`;
const OSC8_URI = 'https://example.com/osc8/target';
const OSC8_ID = 7;
const matcher = createUrlMatcher();
const resolve = (id: number): string | undefined => (id === OSC8_ID ? OSC8_URI : undefined);

let sink = 0;

interface Sweep {
  readonly viewport: LinkViewport;
  readonly cells: ReadonlyArray<readonly [number, number]>;
  readonly matcher: production.UrlMatcher | null;
}

/** A viewport whose row 5 holds `prefix + URL`, wrapped onto row 6 by the grid. */
function textSweep(): Sweep {
  const rows: string[] = [];
  const wrapBits = new Uint8Array(Math.ceil(ROWS / 8));
  const line = `$ curl ${URL_TEXT}`;
  for (let row = 0; row < ROWS; row += 1) rows.push(`prompt output line ${row}`);
  rows[5] = line.slice(0, COLS);
  rows[6] = line.slice(COLS);
  wrapBits[0] = (wrapBits[0] ?? 0) | (1 << 5);
  const cells: Array<readonly [number, number]> = [];
  const start = line.indexOf('https');
  for (let offset = start; offset < line.length; offset += 1) {
    cells.push([5 + Math.floor(offset / COLS), offset % COLS]);
  }
  return { viewport: viewportOf(rows, wrapBits, new Uint32Array(COLS * ROWS)), cells, matcher };
}

/** A viewport whose OSC 8 link text wraps from the end of row 10 into row 11. */
function osc8Sweep(): Sweep {
  const rows: string[] = [];
  for (let row = 0; row < ROWS; row += 1) rows.push(`plain row ${row}`);
  const links = new Uint32Array(COLS * ROWS);
  const cells: Array<readonly [number, number]> = [];
  rows[10] = `${' '.repeat(80)}${'L'.repeat(40)}`;
  rows[11] = 'L'.repeat(60);
  for (let col = 80; col < COLS; col += 1) {
    links[10 * COLS + col] = OSC8_ID;
    cells.push([10, col]);
  }
  for (let col = 0; col < 60; col += 1) {
    links[11 * COLS + col] = OSC8_ID;
    cells.push([11, col]);
  }
  return {
    viewport: viewportOf(rows, new Uint8Array(Math.ceil(ROWS / 8)), links),
    cells,
    matcher,
  };
}

function viewportOf(
  rows: readonly string[],
  wrapBits: Uint8Array,
  links: Uint32Array,
): LinkViewport {
  const columns: number[] = [];
  for (const row of rows) for (let unit = 0; unit < row.length; unit += 1) columns.push(unit);
  return {
    cols: COLS,
    rows: ROWS,
    text: rows.join('\n'),
    wrapBits,
    columns: Uint16Array.from(columns),
    links,
  };
}

function sweepOnce(module: LinkModule, sweep: Sweep): number {
  let hits = 0;
  for (const [row, col] of sweep.cells) {
    const hit = module.findLinkAt(sweep.viewport, row, col, resolve, sweep.matcher);
    if (hit !== null) {
      hits += 1;
      sink += hit.spans.length;
    }
  }
  return hits;
}

function hitsOf(module: LinkModule, sweep: Sweep): string {
  return JSON.stringify(
    sweep.cells.map(([row, col]) =>
      module.findLinkAt(sweep.viewport, row, col, resolve, sweep.matcher),
    ),
  );
}

function cellTotal(): number {
  const counts = heapStats().objectTypeCounts;
  let total = 0;
  for (const key in counts) total += counts[key] ?? 0;
  return total;
}

function cellsPerCall(module: LinkModule, sweep: Sweep): number {
  for (let warmup = 0; warmup < WARMUPS; warmup += 1) sweepOnce(module, sweep);
  const perCall: number[] = [];
  for (let sample = 0; sample < ALLOCATION_SAMPLES; sample += 1) {
    fullGC();
    const before = cellTotal();
    sweepOnce(module, sweep);
    perCall.push((cellTotal() - before) / sweep.cells.length);
  }
  perCall.sort((left, right) => left - right);
  return perCall[Math.floor(perCall.length / 2)] ?? Number.NaN;
}

function summarize(values: number[]): { median: number; p95: number; count: number } {
  values.sort((left, right) => left - right);
  return {
    median: values[Math.floor(values.length / 2)] ?? Number.NaN,
    p95: values[Math.min(values.length - 1, Math.ceil(values.length * 0.95) - 1)] ?? Number.NaN,
    count: values.length,
  };
}

function timeSweeps(module: LinkModule, sweep: Sweep): number {
  const startedAt = performance.now();
  for (let index = 0; index < TIMING_SWEEPS; index += 1) sweepOnce(module, sweep);
  return ((performance.now() - startedAt) * 1_000_000) / (TIMING_SWEEPS * sweep.cells.length);
}

function measureTiming(modules: readonly LinkModule[], sweep: Sweep) {
  for (let warmup = 0; warmup < WARMUPS; warmup += 1) {
    for (const module of modules) timeSweeps(module, sweep);
  }
  const samples: number[][] = modules.map(() => []);
  const differences: number[] = [];
  for (let sample = 0; sample < TIMING_SAMPLES; sample += 1) {
    const order = sample % 4 === 0 || sample % 4 === 3 ? [0, 1] : [1, 0];
    const round: number[] = [];
    for (const index of order) {
      const module = modules[index];
      if (module === undefined) continue;
      round[index] = timeSweeps(module, sweep);
      samples[index]?.push(round[index] ?? Number.NaN);
    }
    if (round[0] !== undefined && round[1] !== undefined) differences.push(round[1] - round[0]);
  }
  return {
    perModule: samples.map((values) => summarize(values)),
    paired: differences.length > 0 ? summarize(differences) : null,
  };
}

async function loadCompareModule(): Promise<LinkModule | null> {
  const modulePath = process.env.BENCH_COMPARE_MODULE;
  if (modulePath === undefined || modulePath.length === 0) return null;
  const loaded = (await import(modulePath)) as Partial<LinkModule>;
  if (loaded.findLinkAt === undefined) throw new Error(`${modulePath} does not export findLinkAt`);
  return { findLinkAt: loaded.findLinkAt };
}

if (import.meta.main) {
  const compare = await loadCompareModule();
  const modules: LinkModule[] = compare === null ? [production] : [production, compare];
  const labels = compare === null ? ['production'] : ['production', 'compare'];
  const sweeps = { 'text-sweep': textSweep(), 'osc8-sweep': osc8Sweep() } as const;
  for (const [name, sweep] of Object.entries(sweeps)) {
    const reference = hitsOf(production, sweep);
    if (!reference.includes(name === 'text-sweep' ? URL_TEXT : OSC8_URI)) {
      throw new Error(`${name}: production did not resolve the fixture link`);
    }
    if (compare !== null && hitsOf(compare, sweep) !== reference) {
      throw new Error(`${name}: compare module resolves different hits`);
    }
  }
  process.stdout.write(
    `link hover benchmark: allocationSamples=${ALLOCATION_SAMPLES}, timingSamples=${TIMING_SAMPLES}, ` +
      `sweepsPerSample=${TIMING_SWEEPS}, hits identical across ${modules.length} module(s)\n`,
  );
  for (const [name, sweep] of Object.entries(sweeps)) {
    const timing = measureTiming(modules, sweep);
    modules.forEach((module, index) => {
      const cells = cellsPerCall(module, sweep);
      const time = timing.perModule[index];
      const label = labels[index] ?? 'module';
      process.stdout.write(
        `${name} [${label}]: ${sweep.cells.length} cells swept, cells/call=${cells.toFixed(2)}, ` +
          `ns/call median=${time?.median.toFixed(1)} p95=${time?.p95.toFixed(1)} (n=${time?.count})\n`,
      );
      if (label !== 'production') return;
      emitPerfMetric({
        name: `link-hover-${name}-cells`,
        value: cells,
        unit: 'cells/call',
        direction: 'lower',
        sampleSize: ALLOCATION_SAMPLES,
      });
      emitPerfMetric({
        name: `link-hover-${name}-time`,
        value: time?.median ?? Number.NaN,
        unit: 'ns/call',
        direction: 'lower',
        percentile: 0.5,
        sampleSize: TIMING_SAMPLES,
      });
    });
    if (timing.paired !== null) {
      process.stdout.write(
        `${name} [compare - production]: paired ns/call median=${timing.paired.median.toFixed(1)} ` +
          `p95=${timing.paired.p95.toFixed(1)} (n=${timing.paired.count}, ABBA)\n`,
      );
    }
  }
  process.stdout.write(`sink=${sink}\n`);
}
