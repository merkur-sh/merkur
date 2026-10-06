/**
 * Real-Chromium cost of persisting the display resume snapshot.
 *
 * The transport worker persists the latest complete reliable snapshot for
 * cold-start paint (`display-receive-core.ts` → `saveResume`) after every
 * snapshot it assembles and when the page hides. Each save opens the session
 * database, puts the record, then reads the stored primary keys in `mtime`
 * order to evict beyond the eight-entry cap. A compare module that walks the
 * stored values instead deserialises every snapshot, chunks included, on the
 * transport worker.
 *
 * The production module is bundled for the browser and run inside a dedicated
 * module worker, as in production. Scenarios vary the snapshot size and how
 * many records are already stored. Per save the harness reports wall time and
 * the longest gap a `MessageChannel` probe observed between its own tasks on
 * that worker while the save was in flight: the longest the worker could not
 * run anything else, which is what a display datagram or input wake arriving
 * mid-save waits for.
 *
 * `BENCH_COMPARE_MODULE=/abs/path.ts` bundles a second store module and
 * interleaves the two per sample in ABBA order in the same worker. The store
 * contents are verified after each scenario: the saved record loads back and
 * the cap holds.
 */
import path from 'node:path';

import { chromium } from '@playwright/test';
import { emitPerfMetric, percentile, perfEnvInteger } from './perf/harness';

const ROOT = path.resolve(import.meta.dir, '..');
const SAMPLES = perfEnvInteger('BENCH_SAMPLES', 30);
const WARMUPS = perfEnvInteger('BENCH_WARMUPS', 3);
const SNAPSHOT_BYTES = [16 * 1024, 256 * 1024, 1024 * 1024] as const;
const STORED_ENTRIES = [1, 4, 8] as const;

async function bundle(entry: string): Promise<string> {
  const build = await Bun.build({ entrypoints: [entry], target: 'browser', format: 'esm' });
  const output = build.outputs[0];
  if (!build.success || build.outputs.length !== 1 || output === undefined) {
    throw new Error(`failed to bundle ${entry}: ${build.logs.join('\n')}`);
  }
  return output.text();
}

/** Runs in the module worker; `modules` are the bundled store modules by label. */
const WORKER_SOURCE = `
import * as production from '/production.js';
import * as compare from '/compare.js';

// Static imports: a top-level dynamic import in a module worker takes the whole
// headless Chromium 151 browser down.
const modules = { production, compare };

function snapshotEntry(daemonId, bytes, mtime) {
  const chunkBytes = Math.min(bytes, 64 * 1024);
  const chunks = [];
  for (let offset = 0; offset < bytes; offset += chunkBytes) {
    const chunk = new Uint8Array(Math.min(chunkBytes, bytes - offset));
    crypto.getRandomValues(chunk);
    chunks.push(chunk);
  }
  return { key: daemonId + ':tab', daemonId, tabId: 'tab', generation: 3, seq: 9, cols: 120, rows: 40, chunks, mtime };
}

async function clear() {
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase('merkur_session');
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('blocked'));
  });
}

/** Longest gap between this worker's own message tasks while \`work\` runs. */
async function probed(work) {
  const channel = new MessageChannel();
  let running = true;
  let last = performance.now();
  let maxGap = 0;
  channel.port1.onmessage = () => {
    const now = performance.now();
    maxGap = Math.max(maxGap, now - last);
    last = now;
    if (running) channel.port2.postMessage(0);
  };
  channel.port2.postMessage(0);
  const startedAt = performance.now();
  await work();
  const wall = performance.now() - startedAt;
  running = false;
  channel.port1.close();
  return { wall, maxGap };
}

self.onmessage = async (event) => {
  const { bytes, stored, samples, warmups, labels } = event.data;
  try {
    await clear();
    let mtime = 1_700_000_000_000;
    for (let index = 0; index < stored; index += 1) {
      mtime += 1;
      await modules.production.saveResume(snapshotEntry('stored-' + index, bytes, mtime));
    }
    const target = snapshotEntry('stored-0', bytes, mtime);
    const results = Object.fromEntries(labels.map((label) => [label, { wall: [], maxGap: [] }]));
    for (let round = 0; round < warmups + samples; round += 1) {
      const order = round % 4 === 0 || round % 4 === 3 ? labels : [...labels].reverse();
      for (const label of order) {
        mtime += 1;
        const entry = { ...target, mtime };
        const measured = await probed(() => modules[label].saveResume(entry));
        if (round >= warmups) {
          results[label].wall.push(measured.wall);
          results[label].maxGap.push(measured.maxGap);
        }
      }
    }
    const loaded = await modules.production.loadResume('stored-0', 'tab');
    const count = await new Promise((resolve, reject) => {
      const open = indexedDB.open('merkur_session');
      open.onsuccess = () => {
        const request = open.result.transaction('resume').objectStore('resume').count();
        request.onsuccess = () => { resolve(request.result); open.result.close(); };
        request.onerror = () => reject(request.error);
      };
      open.onerror = () => reject(open.error);
    });
    // The cap is eight. A store holding fewer records than were written is
    // reported, not failed: it is the eviction's own observable outcome.
    if (loaded === null || loaded.mtime !== mtime || count > 8) {
      throw new Error('store verification failed: ' + JSON.stringify({ loaded: loaded?.mtime, mtime, count, stored }));
    }
    self.postMessage({ ok: true, results, storedAfter: count });
  } catch (error) {
    self.postMessage({ ok: false, error: String(error) });
  }
};
`;

interface ScenarioResult {
  readonly wall: number[];
  readonly maxGap: number[];
}

const productionModule = await bundle(path.join(ROOT, 'apps/web/src/lib/display-resume-store.ts'));
const comparePath = process.env.BENCH_COMPARE_MODULE;
const compareModule =
  comparePath !== undefined && comparePath.length > 0 ? await bundle(comparePath) : null;
const labels = compareModule === null ? ['production'] : ['production', 'compare'];

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    const pathname = new URL(request.url).pathname;
    const javascript = { 'content-type': 'text/javascript; charset=utf-8' };
    if (pathname === '/production.js')
      return new Response(productionModule, { headers: javascript });
    if (pathname === '/compare.js') {
      return new Response(compareModule ?? productionModule, { headers: javascript });
    }
    if (pathname === '/worker.js') return new Response(WORKER_SOURCE, { headers: javascript });
    return new Response('<!doctype html><title>resume store</title>', {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  },
});

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: 'load' });
  process.stdout.write(
    `display resume store benchmark: samples=${SAMPLES}, warmups=${WARMUPS}, ` +
      `${await page.evaluate(() => navigator.userAgent)}\n`,
  );
  for (const bytes of SNAPSHOT_BYTES) {
    for (const stored of STORED_ENTRIES) {
      const outcome = await page.evaluate(
        async (input) =>
          await new Promise<
            | { ok: true; results: Record<string, ScenarioResult>; storedAfter: number }
            | { ok: false; error: string }
          >((resolve) => {
            const worker = new Worker('/worker.js', { type: 'module' });
            worker.onmessage = (event) => {
              worker.terminate();
              resolve(event.data);
            };
            worker.onerror = (event) => resolve({ ok: false, error: String(event.message) });
            worker.postMessage(input);
          }),
        { bytes, stored, samples: SAMPLES, warmups: WARMUPS, labels },
      );
      if (!outcome.ok) throw new Error(`${bytes}B x${stored}: ${outcome.error}`);
      for (const label of labels) {
        const result = outcome.results[label];
        if (result === undefined) continue;
        const id = `${Math.round(bytes / 1024)}KiB-stored-${stored}`;
        process.stdout.write(
          `${id} [${label}]: save wall p50=${percentile(result.wall, 0.5).toFixed(2)}ms ` +
            `p95=${percentile(result.wall, 0.95).toFixed(2)}ms; worker max task gap ` +
            `p50=${percentile(result.maxGap, 0.5).toFixed(2)}ms p95=${percentile(result.maxGap, 0.95).toFixed(2)}ms ` +
            `(n=${result.wall.length}); ${stored} written, ${outcome.storedAfter} stored after\n`,
        );
        if (label !== 'production') continue;
        emitPerfMetric({
          name: `display-resume-save-${id}-wall`,
          value: percentile(result.wall, 0.5),
          unit: 'ms/save',
          direction: 'lower',
          percentile: 0.5,
          sampleSize: result.wall.length,
        });
        emitPerfMetric({
          name: `display-resume-save-${id}-worker-gap`,
          value: percentile(result.maxGap, 0.5),
          unit: 'ms',
          direction: 'lower',
          percentile: 0.5,
          sampleSize: result.maxGap.length,
        });
      }
    }
  }
} finally {
  await browser.close();
  server.stop(true);
}
