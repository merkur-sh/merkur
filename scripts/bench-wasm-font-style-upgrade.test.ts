import { describe, expect, test } from 'bun:test';

import { parsePerfMetrics } from './perf/harness';
import { runTestProcess } from './test-process';

const ROOT = new URL('..', import.meta.url).pathname;

describe('terminal WASM font style-upgrade benchmark', () => {
  test('measures the production post-ready font boundary', async () => {
    const { exitCode, stdout, stderr } = await runTestProcess(
      ['bun', 'run', 'scripts/bench-wasm-font-style-upgrade.ts'],
      { cwd: ROOT, env: { ...process.env, BENCH_SAMPLES: '20', BENCH_WARMUPS: '0' } },
    );

    expect(exitCode, stderr).toBe(0);
    const metrics = parsePerfMetrics(stdout);
    expect(metrics.map((metric) => metric.name)).toEqual([
      'terminal-wasm-font-style-upgrade-p50',
      'terminal-wasm-font-style-upgrade-p95',
      'terminal-wasm-font-style-upgrade-p99',
      'terminal-wasm-font-style-upgrade-copied-bytes',
    ]);
    expect(metrics.slice(0, 3).every((metric) => metric.sampleSize === 20)).toBe(true);
    expect(metrics[3]?.sampleSize).toBe(1);
    expect(metrics.every((metric) => metric.value > 0)).toBe(true);
    expect(stdout).toContain('terminal WASM font style upgrade (');
  }, 30_000);

  test('rejects too few samples', async () => {
    const result = await runTestProcess(
      ['bun', 'run', 'scripts/bench-wasm-font-style-upgrade.ts'],
      { cwd: ROOT, env: { ...process.env, BENCH_SAMPLES: '19' } },
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('BENCH_SAMPLES must be a safe integer of at least 20');
  });
});
