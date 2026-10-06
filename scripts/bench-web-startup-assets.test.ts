import { describe, expect, test } from 'bun:test';

import { parsePerfMetrics } from './perf/harness';
import { runTestProcess } from './test-process';

const ROOT = new URL('..', import.meta.url).pathname;

describe('web startup asset benchmark', () => {
  // Production Brotli quality 11 is CPU-intensive on shared CI runners.
  test('measures the production terminal font critical path', async () => {
    const { exitCode, stdout, stderr } = await runTestProcess(
      ['bun', 'run', 'scripts/bench-web-startup-assets.ts'],
      { cwd: ROOT, env: process.env },
    );

    expect(exitCode, stderr).toBe(0);
    const metrics = parsePerfMetrics(stdout);
    expect(metrics).toHaveLength(7);
    expect(
      metrics.find((metric) => metric.name === 'terminal-font-critical-path-asset-count')?.value,
    ).toBe(1);
    expect(
      metrics.find((metric) => metric.name === 'terminal-font-critical-path-raw-bytes')?.value,
    ).toBeGreaterThan(0);
    expect(
      metrics.find(
        (metric) => metric.name === 'terminal-font-critical-path-brotli-reduction-vs-all-styles',
      )?.value,
    ).toBeGreaterThan(70);
    expect(stdout).toContain('brotli-q11');
  }, 120_000);
});
