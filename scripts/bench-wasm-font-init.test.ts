import { describe, expect, test } from 'bun:test';

import { parsePerfMetrics } from './perf/harness';
import { runTestProcess } from './test-process';

const ROOT = new URL('..', import.meta.url).pathname;

describe('terminal WASM font initialization benchmark', () => {
  test('measures both the blocking boot face and the promoted regular face', async () => {
    const { exitCode, stdout, stderr } = await runTestProcess(
      ['bun', 'run', 'scripts/bench-wasm-font-init.ts'],
      { cwd: ROOT, env: { ...process.env, BENCH_SAMPLES: '100' } },
    );

    expect(exitCode, stderr).toBe(0);
    const metrics = parsePerfMetrics(stdout);
    expect(metrics.map((metric) => metric.name)).toEqual([
      'terminal-wasm-regular-once-init-cold',
      'terminal-wasm-regular-once-init-p50',
      'terminal-wasm-regular-once-init-p95',
      'terminal-wasm-regular-once-init-p99',
      'terminal-wasm-boot-once-init-cold',
      'terminal-wasm-boot-once-init-p50',
      'terminal-wasm-boot-once-init-p95',
      'terminal-wasm-boot-once-init-p99',
    ]);
    const cold = metrics.filter((metric) => metric.name.endsWith('-cold'));
    expect(cold.every((metric) => metric.sampleSize === 1)).toBe(true);
    expect(
      metrics
        .filter((metric) => !metric.name.endsWith('-cold'))
        .every((metric) => metric.sampleSize === 100),
    ).toBe(true);
    expect(metrics.every((metric) => metric.value > 0)).toBe(true);

    // The reason the boot face exists: it is the blocking parse, and it must be
    // materially cheaper than the face it stands in for.
    const regularP50 = metrics.find((m) => m.name === 'terminal-wasm-regular-once-init-p50');
    const bootP50 = metrics.find((m) => m.name === 'terminal-wasm-boot-once-init-p50');
    expect(bootP50?.value ?? Number.POSITIVE_INFINITY).toBeLessThan((regularP50?.value ?? 0) / 2);
  }, 30_000);

  test('rejects an invalid sample count', async () => {
    const result = await runTestProcess(['bun', 'run', 'scripts/bench-wasm-font-init.ts'], {
      cwd: ROOT,
      env: { ...process.env, BENCH_SAMPLES: '99' },
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('BENCH_SAMPLES must be a safe integer of at least 100 for p99');
  });
});
