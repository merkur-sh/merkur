import { describe, expect, test } from 'bun:test';

import { parsePerfMetrics } from './perf/harness';
import { runTestProcess } from './test-process';

const ROOT = new URL('..', import.meta.url).pathname;

describe('session crypto startup benchmark', () => {
  test('measures the signed ML-KEM-1024 and ML-DSA-87 bootstrap path', async () => {
    const { exitCode, stdout, stderr } = await runTestProcess(
      ['bun', 'run', 'scripts/bench-session-crypto-startup.ts'],
      { cwd: ROOT, env: { ...process.env, BENCH_SAMPLES: '100' } },
    );

    expect(exitCode, stderr).toBe(0);
    const metrics = parsePerfMetrics(stdout);
    expect(metrics.map((metric) => metric.name)).toEqual([
      'session-pq-wasm-module-init',
      'session-pq-bootstrap-cold',
      'session-pq-bootstrap-p50',
      'session-pq-bootstrap-p95',
      'session-pq-bootstrap-p99',
    ]);
    expect(metrics[0]?.sampleSize).toBe(1);
    expect(metrics[1]?.sampleSize).toBe(1);
    expect(metrics.slice(2).every((metric) => metric.sampleSize === 100)).toBe(true);
    expect(metrics.every((metric) => metric.value > 0)).toBe(true);
    // The p99 metric requires >= 100 samples, and a bootstrap is a full
    // ML-KEM-1024 + ML-DSA-87 round at ~40ms p50, so the subprocess needs
    // several seconds of crypto before it can print anything. The default 5s
    // budget only cleared on an idle, fast machine; every other bench test in
    // this directory already carries an explicit one.
  }, 60_000);

  test('rejects an invalid sample count', async () => {
    const { exitCode, stderr } = await runTestProcess(
      ['bun', 'run', 'scripts/bench-session-crypto-startup.ts'],
      { cwd: ROOT, env: { ...process.env, BENCH_SAMPLES: '99' } },
    );

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('BENCH_SAMPLES must be a safe integer of at least 100 for p99');
  });
});
