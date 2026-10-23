import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parsePerfMetrics } from './perf/harness';
import { runTestProcess } from './test-process';

/** Where the benchmark runs: the repository's root, a place to start in, not a file it reads. */
const ROOT = path.resolve(import.meta.dir, '..');
const BENCHMARK = fileURLToPath(new URL('./bench-kernels-row-geometry.ts', import.meta.url));

describe('terminal WASM row geometry benchmark', () => {
  test('rebuilds both full screens through the production export and reports each', async () => {
    const env: Record<string, string | undefined> = { ...process.env, BENCH_SAMPLES: '20' };
    delete env.BENCH_CANDIDATE_PKG;
    const { exitCode, stdout, stderr } = await runTestProcess(['bun', 'run', BENCHMARK], {
      cwd: ROOT,
      env,
    });

    expect(exitCode, stderr).toBe(0);
    const metrics = parsePerfMetrics(stdout);
    expect(metrics.map((metric) => metric.name)).toEqual(
      ['text', 'mixed'].flatMap((content) => [
        `terminal-wasm-row-geometry-${content}-p50`,
        `terminal-wasm-row-geometry-${content}-p95`,
      ]),
    );
    expect(metrics.every((metric) => metric.value > 0 && metric.sampleSize === 20)).toBe(true);
  }, 300_000);
});
