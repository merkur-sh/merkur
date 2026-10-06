import { describe, expect, test } from 'bun:test';

import { parsePerfMetrics } from './perf/harness';
import { runTestProcess } from './test-process';

const ROOT = new URL('..', import.meta.url).pathname;

describe('retained wire payload pool benchmark', () => {
  test('measures every payload and pool-depth case in Chromium', async () => {
    const { exitCode, stdout, stderr } = await runTestProcess(
      ['bun', 'run', 'scripts/bench-retained-wire-payload-pool.ts'],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          BENCH_SAMPLES: '1',
          BENCH_WARMUPS: '0',
          BENCH_ITERATIONS: '10',
        },
      },
    );
    expect(exitCode, stderr).toBe(0);
    const metrics = parsePerfMetrics(stdout);
    expect(metrics).toHaveLength(18);
    expect(new Set(metrics.map((metric) => metric.name))).toEqual(
      new Set(
        [64, 1_024].flatMap((bytes) =>
          [1, 16, 64].map((depth) => `retained-wire-payload-${bytes}b-depth-${depth}`),
        ),
      ),
    );
    expect(metrics.every((metric) => metric.sampleSize === 1 && metric.value >= 0)).toBe(true);
    expect(stdout).toContain('retained wire payload raw:');
  }, 30_000);
});
