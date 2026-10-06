import path from 'node:path';

import { chromium } from '@playwright/test';
import { declaredBrowserExecutable } from './perf/browser-runtime';
import { emitPerfMetric, summarizeSamples } from './perf/harness';

const ROOT = path.resolve(import.meta.dir, '..');
const SAMPLES = positiveInteger('BENCH_SAMPLES', 40);
const WARMUPS = nonNegativeInteger('BENCH_WARMUPS', 10);
const ITERATIONS = positiveInteger('BENCH_ITERATIONS', 50_000);
const PAYLOAD_BYTES = [64, 1_024] as const;
const POOL_DEPTHS = [1, 16, 64] as const;

const build = await Bun.build({
  entrypoints: [path.join(ROOT, 'apps/web/src/terminal/retained-wire-payload-pool.ts')],
  target: 'browser',
  format: 'esm',
});
if (!build.success || build.outputs.length !== 1) {
  throw new Error(`failed to bundle retained payload pool: ${build.logs.join('\n')}`);
}
const poolModule = await build.outputs[0]?.text();
if (poolModule === undefined) throw new Error('retained payload pool bundle produced no output');

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    if (new URL(request.url).pathname === '/pool.js') {
      return new Response(poolModule, {
        headers: { 'content-type': 'text/javascript; charset=utf-8' },
      });
    }
    return new Response(
      '<!doctype html><script type="module">' +
        "import { createRetainedWirePayloadPool } from '/pool.js';" +
        'globalThis.__createRetainedWirePayloadPool = createRetainedWirePayloadPool;' +
        '</script>',
      { headers: { 'content-type': 'text/html; charset=utf-8' } },
    );
  },
});

interface ScenarioResult {
  readonly samples: number[];
  readonly checksum: number;
  readonly finalAvailable: number;
}

interface BrowserResult {
  readonly scenarios: Record<string, ScenarioResult>;
  readonly userAgent: string;
}

const browser = await chromium.launch({
  headless: true,
  executablePath: declaredBrowserExecutable('headless-shell'),
});
let result: BrowserResult;
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => '__createRetainedWirePayloadPool' in globalThis);
  result = await page.evaluate(
    ({ samples, warmups, iterations, payloadBytes, poolDepths }): BrowserResult => {
      type PoolFactory =
        typeof import('../apps/web/src/terminal/retained-wire-payload-pool').createRetainedWirePayloadPool;
      const factory = (
        globalThis as typeof globalThis & { __createRetainedWirePayloadPool?: PoolFactory }
      ).__createRetainedWirePayloadPool;
      if (factory === undefined) throw new Error('retained payload pool factory was not loaded');

      const scenarios: Record<string, ScenarioResult> = {};
      for (const payloadLength of payloadBytes) {
        for (const depth of poolDepths) {
          const pool = factory(64);
          const held = [];
          const distractorLength = Math.max(1, Math.floor(payloadLength / 8));
          for (let index = 1; index < depth; index += 1) {
            held.push(pool.acquire(new Uint8Array(distractorLength)));
          }
          held.push(pool.acquire(new Uint8Array(payloadLength)));
          for (const payload of held) payload.release();
          if (pool.availableCount() !== depth) {
            throw new Error(`failed to prime depth ${depth}`);
          }

          const source = new Uint8Array(payloadLength);
          for (let index = 0; index < source.length; index += 1) {
            source[index] = (index * 31 + depth) & 0xff;
          }
          let checksum = 0;
          const runBatch = (): number => {
            const startedAt = performance.now();
            for (let index = 0; index < iterations; index += 1) {
              const payload = pool.acquire(source);
              checksum =
                (checksum +
                  (payload.bytes[0] ?? 0) +
                  (payload.bytes[payload.bytes.length - 1] ?? 0)) >>>
                0;
              payload.release();
            }
            return ((performance.now() - startedAt) * 1_000_000) / iterations;
          };
          for (let warmup = 0; warmup < warmups; warmup += 1) runBatch();
          const measured: number[] = [];
          for (let sample = 0; sample < samples; sample += 1) measured.push(runBatch());
          if (pool.availableCount() !== depth) {
            throw new Error(`pool depth changed after measurement: ${pool.availableCount()}`);
          }
          const verify = pool.acquire(source);
          if (
            verify.bytes.length !== source.length ||
            verify.bytes[0] !== source[0] ||
            verify.bytes[verify.bytes.length - 1] !== source[source.length - 1]
          ) {
            throw new Error('pooled payload failed byte-exact verification');
          }
          verify.release();
          scenarios[`${payloadLength}b-depth-${depth}`] = {
            samples: measured,
            checksum,
            finalAvailable: pool.availableCount(),
          };
        }
      }
      return { scenarios, userAgent: navigator.userAgent };
    },
    {
      samples: SAMPLES,
      warmups: WARMUPS,
      iterations: ITERATIONS,
      payloadBytes: PAYLOAD_BYTES,
      poolDepths: POOL_DEPTHS,
    },
  );
} finally {
  await browser.close();
  server.stop(true);
}

for (const payloadLength of PAYLOAD_BYTES) {
  for (const depth of POOL_DEPTHS) {
    const id = `${payloadLength}b-depth-${depth}`;
    const scenario = result.scenarios[id];
    if (scenario === undefined || scenario.samples.length !== SAMPLES) {
      throw new Error(`${id} produced an invalid sample set`);
    }
    if (scenario.finalAvailable !== depth) {
      throw new Error(`${id} ended with ${scenario.finalAvailable}/${depth} pooled entries`);
    }
    const summary = summarizeSamples(scenario.samples);
    process.stdout.write(
      `${id}: p50=${summary.median.toFixed(3)}ns p95=${summary.p95.toFixed(3)}ns ` +
        `p99=${summary.p99.toFixed(3)}ns checksum=${scenario.checksum}\n`,
    );
    for (const [percentile, value] of [
      [0.5, summary.median],
      [0.95, summary.p95],
      [0.99, summary.p99],
    ] as const) {
      emitPerfMetric({
        name: `retained-wire-payload-${id}`,
        value,
        unit: 'ns/acquire-release',
        direction: 'lower',
        percentile,
        sampleSize: SAMPLES,
      });
    }
  }
}
process.stdout.write(`retained wire payload raw: ${JSON.stringify(result)}\n`);
if (process.env.BENCH_OUTPUT !== undefined) {
  const revision = captureCommand(['git', 'rev-parse', 'HEAD']).trim();
  const dirty = captureCommand(['git', 'status', '--porcelain=v1']).length > 0;
  await Bun.write(
    path.resolve(process.env.BENCH_OUTPUT),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
        revision,
        dirty,
        config: {
          samples: SAMPLES,
          warmups: WARMUPS,
          iterations: ITERATIONS,
          payloadBytes: PAYLOAD_BYTES,
          poolDepths: POOL_DEPTHS,
        },
        browser: { userAgent: result.userAgent },
        result,
      },
      null,
      2,
    )}\n`,
  );
}

function positiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function captureCommand(command: readonly string[]): string {
  const result = Bun.spawnSync([...command], {
    cwd: ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) {
    throw new Error(`${command.join(' ')} exited with ${result.exitCode}`);
  }
  return new TextDecoder().decode(result.stdout);
}
