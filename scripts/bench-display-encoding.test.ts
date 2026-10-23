import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parsePerfMetrics } from './perf/harness';
import { runTestProcess } from './test-process';

/** Where the benchmark runs: the repository's root, a place to start in, not a file it reads. */
const ROOT = path.resolve(import.meta.dir, '..');
const BENCHMARK = fileURLToPath(new URL('./bench-display-encoding.ts', import.meta.url));
const COLD_FIXTURE_TIMEOUT_MS = 30_000;

describe('display encoding benchmark sampling', () => {
  test(
    'applies the minimum iteration floor to production-valid staged rows',
    async () => {
      const { exitCode, stdout, stderr } = await runTestProcess(['bun', 'run', BENCHMARK], {
        cwd: ROOT,
        env: {
          ...process.env,
          BENCH_DISPLAY_SIZES: '65000',
          BENCH_DISPLAY_PATTERNS: 'random',
          BENCH_TARGET_BYTES: '1',
          BENCH_MIN_ITERATIONS: '1234',
        },
      });

      expect(exitCode, stderr).toBe(0);
      const metrics = parsePerfMetrics(stdout);
      expect(metrics).toHaveLength(1);
      expect(metrics.every((metric) => metric.sampleSize === 1234)).toBe(true);
    },
    COLD_FIXTURE_TIMEOUT_MS,
  );

  test('rejects a non-positive minimum iteration floor', async () => {
    const { exitCode, stderr } = await runTestProcess(['bun', 'run', BENCHMARK], {
      cwd: ROOT,
      env: {
        ...process.env,
        BENCH_DISPLAY_SIZES: '65000',
        BENCH_DISPLAY_PATTERNS: 'random',
        BENCH_TARGET_BYTES: '1',
        BENCH_MIN_ITERATIONS: '0',
      },
    });

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('BENCH_MIN_ITERATIONS must be a positive safe integer');
  });
});
