import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parsePerfMetrics } from './perf/harness';
import { runTestProcess } from './test-process';

/** Where the benchmark runs: the repository's root, a place to start in, not a file it reads. */
const ROOT = path.resolve(import.meta.dir, '..');
const BENCHMARK = fileURLToPath(new URL('./bench-wasm-font-init.ts', import.meta.url));

describe('terminal WASM font initialization benchmark', () => {
  test('measures both the blocking boot face and the promoted regular face', async () => {
    const { exitCode, stdout, stderr } = await runTestProcess(['bun', 'run', BENCHMARK], {
      cwd: ROOT,
      env: { ...process.env, BENCH_SAMPLES: '100' },
    });

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
      ...['regular', 'boot'].flatMap((face) =>
        ['unchanged', 'line-height', 'size-dpr', 'invalid'].flatMap((scenario) =>
          ['p50', 'p95', 'p99'].map(
            (percentile) => `terminal-wasm-${face}-metrics-${scenario}-${percentile}`,
          ),
        ),
      ),
    ]);
    const cold = metrics.filter((metric) => metric.name.endsWith('-cold'));
    expect(cold.every((metric) => metric.sampleSize === 1)).toBe(true);
    expect(
      metrics
        .filter((metric) => !metric.name.endsWith('-cold'))
        .every((metric) => metric.sampleSize === 100),
    ).toBe(true);
    expect(metrics.every((metric) => metric.value > 0)).toBe(true);

    expect(stdout.match(/checksum=\d+/g)).toHaveLength(8);

    // The reason the boot face exists: it is the blocking parse, and it must be
    // materially cheaper than the face it stands in for.
    const regularP50 = metrics.find((m) => m.name === 'terminal-wasm-regular-once-init-p50');
    const bootP50 = metrics.find((m) => m.name === 'terminal-wasm-boot-once-init-p50');
    expect(bootP50?.value ?? Number.POSITIVE_INFINITY).toBeLessThan((regularP50?.value ?? 0) / 2);
  }, 30_000);

  test('rejects an invalid sample count', async () => {
    const result = await runTestProcess(['bun', 'run', BENCHMARK], {
      cwd: ROOT,
      env: { ...process.env, BENCH_SAMPLES: '99' },
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('BENCH_SAMPLES must be a safe integer of at least 100 for p99');
  });
});
