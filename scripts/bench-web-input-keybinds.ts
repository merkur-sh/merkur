import { fullGC, heapStats } from 'bun:jsc';
import { emitPerfMetric, perfEnvInteger } from './perf/harness';

/**
 * The app keyboard layer's cost on every terminal keystroke.
 *
 * `hooks/createKeybinds.ts` listens for `keydown` on the document, and the
 * terminal's input controller listens on the window, so for every key typed
 * into the terminal the app layer's handler runs first, in the bubble phase,
 * before the terminal sees the key. This drives that real listener: the real
 * `createKeybinds` registers the scopes the shell registers (App's "Anywhere"
 * and "Go to", DeviceList's "Machines", SettingsScreen's "Sessions" and
 * "Settings", with their real key strings), with the activity each has while
 * the terminal is on screen — only "Anywhere" — and a plain letter keydown is
 * dispatched to the listener it attached.
 *
 * Solid must load its browser build for `onSettled` to attach the listener, so
 * this runs with the browser export condition:
 *
 *   bun --conditions=browser run scripts/bench-web-input-keybinds.ts
 *
 * Counts are `bun:jsc` heap cells per keystroke (a full collection, cells
 * after a run minus cells before). Timing is ns per keystroke, median and p95.
 * `active()` here returns a constant where production reads Solid signals, so
 * the timing is a lower bound on the handler's cost.
 */

const KEYSTROKES = perfEnvInteger('BENCH_KEYSTROKES', 4096);
const SAMPLES = perfEnvInteger('BENCH_SAMPLES', 9);
const TIMING_SAMPLES = perfEnvInteger('BENCH_TIMING_SAMPLES', 500);

interface FakeEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  defaultPrevented: boolean;
  target: null;
  preventDefault(): void;
}

const listeners: Array<(event: unknown) => void> = [];
const globals = globalThis as Record<string, unknown>;
globals.document = {
  addEventListener: (_type: string, handler: (event: unknown) => void) => listeners.push(handler),
  removeEventListener: () => {},
};
globals.window = { addEventListener: () => {}, removeEventListener: () => {} };
globals.HTMLElement ??= class {};

// Loaded through variables so the scripts type-check project, which has no
// Solid types, does not pull the web app's Solid modules in with them.
const SOLID_MODULE = '../apps/web/node_modules/solid-js';
const KEYBINDS_MODULE = '../apps/web/src/hooks/createKeybinds';
interface ScopeShape {
  readonly title: string;
  active(): boolean;
  readonly bindings: readonly { readonly keys: string; readonly label: string; run(): void }[];
}
const solid = (await import(SOLID_MODULE)) as {
  createRoot(fn: (dispose: () => void) => void): void;
};
const { createKeybinds } = (await import(KEYBINDS_MODULE)) as {
  createKeybinds(scope: ScopeShape): void;
};

const run = (): void => {};
const bindings = (keys: readonly string[]) => keys.map((key) => ({ keys: key, label: key, run }));
let dispose: () => void = () => {};
solid.createRoot((disposeRoot) => {
  dispose = disposeRoot;
  createKeybinds({ title: 'Anywhere', active: () => true, bindings: bindings(['rcmd+k']) });
  createKeybinds({ title: 'Go to', active: () => false, bindings: bindings(['g d', 'g s', '?']) });
  createKeybinds({
    title: 'Machines',
    active: () => false,
    bindings: bindings(['j', 'k', 'g g', 'G', 'o', 's', 'r', 'x', 'n', 'a', 'y', 'R']),
  });
  createKeybinds({ title: 'Sessions', active: () => false, bindings: bindings(['x', 'X']) });
  createKeybinds({
    title: 'Settings',
    active: () => false,
    bindings: bindings(['j', 'k', 'l', 'h', '1', '2', '3', '4', 'q', 'Escape']),
  });
});
await new Promise((resolve) => setTimeout(resolve, 0));
const handler = listeners[0];
if (listeners.length !== 1 || handler === undefined) {
  throw new Error(`bench: createKeybinds attached ${listeners.length} listeners, expected 1`);
}

let prevented = 0;
const events: FakeEvent[] = [...'etaoinshrdlucmfwypvbgkqjxz'].map((key) => ({
  key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  defaultPrevented: false,
  target: null,
  preventDefault: () => {
    prevented += 1;
  },
}));

function keystrokes(count: number): void {
  for (let index = 0; index < count; index += 1) {
    handler?.(events[index % events.length]);
  }
}

function liveCells(): number {
  const counts = heapStats().objectTypeCounts;
  let total = 0;
  for (const key in counts) total += counts[key] ?? 0;
  return total;
}

function percentile(sorted: readonly number[], p: number): number {
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? Number.NaN;
}

for (let warmup = 0; warmup < 50; warmup += 1) keystrokes(KEYSTROKES);
const counts: number[] = [];
let types: Record<string, number> = {};
for (let sample = 0; sample < SAMPLES; sample += 1) {
  fullGC();
  const typesBefore = { ...heapStats().objectTypeCounts };
  const before = liveCells();
  keystrokes(KEYSTROKES);
  counts.push((liveCells() - before) / KEYSTROKES);
  const typesAfter = heapStats().objectTypeCounts;
  types = {};
  for (const key of Object.keys(typesAfter)) {
    const delta = ((typesAfter[key] ?? 0) - (typesBefore[key] ?? 0)) / KEYSTROKES;
    if (Math.abs(delta) >= 0.05) types[key] = Number(delta.toFixed(2));
  }
}
counts.sort((left, right) => left - right);
const timings: number[] = [];
for (let sample = 0; sample < TIMING_SAMPLES; sample += 1) {
  const startedAt = Bun.nanoseconds();
  keystrokes(256);
  timings.push((Bun.nanoseconds() - startedAt) / 256);
}
timings.sort((left, right) => left - right);
if (prevented !== 0) throw new Error(`bench: the app layer swallowed ${prevented} terminal keys`);
dispose();

const median = percentile(counts, 0.5);
process.stdout.write(
  `app keybinds on a terminal keystroke: objects/keystroke median=${median.toFixed(2)} ` +
    `(n=${SAMPLES}x${KEYSTROKES}); ns/keystroke p50=${percentile(timings, 0.5).toFixed(1)} ` +
    `p95=${percentile(timings, 0.95).toFixed(1)} (n=${TIMING_SAMPLES}x256)\n` +
    `  cell types/keystroke: ${JSON.stringify(types)}\n`,
);
emitPerfMetric({
  name: 'web-input-app-keybinds-objects',
  value: median,
  unit: 'objects/keystroke',
  direction: 'lower',
  sampleSize: SAMPLES,
});
emitPerfMetric({
  name: 'web-input-app-keybinds-ns',
  value: percentile(timings, 0.5),
  unit: 'ns/keystroke',
  direction: 'lower',
  percentile: 0.5,
  sampleSize: TIMING_SAMPLES,
});
