import { describe, expect, test } from 'bun:test';

import { parsePerfMetrics } from './perf/harness';
import { runTestProcess } from './test-process';

const ROOT = new URL('..', import.meta.url).pathname;

describe('shadow terminal benchmark', () => {
  test('applies current display fixtures and emits every prediction metric', async () => {
    const { exitCode, stdout, stderr } = await runTestProcess(
      ['bun', 'run', 'scripts/bench-shadow-terminal.ts'],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          BENCH_SAMPLES: '1',
          BENCH_ACTIONS_PER_SAMPLE: '1',
          BENCH_PROJECTIONS_PER_SAMPLE: '1',
          BENCH_UNCHANGED_BUILDS_PER_SAMPLE: '1',
        },
      },
    );

    expect(exitCode, stderr).toBe(0);
    const metrics = parsePerfMetrics(stdout);
    expect(metrics).toHaveLength(27);
    expect(new Set(metrics.map((metric) => metric.name))).toEqual(
      new Set([
        'shadow-prediction-action-p50',
        'shadow-prediction-action-p95',
        'shadow-prediction-action-p99',
        'shadow-authority-only-flush-p50',
        'shadow-authority-only-flush-p95',
        'shadow-authority-only-flush-p99',
        'shadow-prediction-projection-p50',
        'shadow-prediction-projection-p95',
        'shadow-prediction-projection-p99',
        'shadow-prediction-midline-projection-p50',
        'shadow-prediction-midline-projection-p95',
        'shadow-prediction-midline-projection-p99',
        'shadow-prediction-120-cell-midline-projection-p50',
        'shadow-prediction-120-cell-midline-projection-p95',
        'shadow-prediction-120-cell-midline-projection-p99',
        'shadow-prediction-unchanged-build-p50',
        'shadow-prediction-unchanged-build-p95',
        'shadow-prediction-unchanged-build-p99',
        'shadow-reconcile-exact-prefix-cold-p50',
        'shadow-reconcile-exact-prefix-cold-p95',
        'shadow-reconcile-exact-prefix-cold-p99',
        'shadow-reconcile-mismatch-deferred-cold-p50',
        'shadow-reconcile-mismatch-deferred-cold-p95',
        'shadow-reconcile-mismatch-deferred-cold-p99',
        'shadow-reconcile-mismatch-cold-p50',
        'shadow-reconcile-mismatch-cold-p95',
        'shadow-reconcile-mismatch-cold-p99',
      ]),
    );
    expect(metrics.every((metric) => metric.sampleSize === 1)).toBe(true);
  }, 30_000);
});
