import { expect, test } from 'bun:test';
import { parsePerfMetrics } from './perf/harness';
import { runTestProcess } from './test-process';

test('latency benchmark joins dense and unmatched traces with valid presentation timing', async () => {
  const { exitCode, stdout, stderr } = await runTestProcess(
    ['bun', 'run', 'scripts/bench-terminal-latency-report.ts'],
    {
      cwd: new URL('..', import.meta.url).pathname,
      env: { ...process.env, BENCH_INPUTS: '64', BENCH_SAMPLES: '2', BENCH_WARMUPS: '1' },
    },
  );
  expect(exitCode, stderr).toBe(0);
  const metrics = parsePerfMetrics(stdout);
  expect(metrics).toHaveLength(8);
  for (const name of ['dense', 'unmatched']) {
    const latencies = metrics.filter((metric) => metric.name === `terminal-latency-report-${name}`);
    expect(latencies.map((metric) => metric.percentile)).toEqual([0.5, 0.95, 0.99]);
    expect(latencies.every((metric) => Number.isFinite(metric.value) && metric.value > 0)).toBe(
      true,
    );
    expect(
      metrics.some(
        (metric) =>
          metric.name === `terminal-latency-report-${name}-throughput` && metric.value > 0,
      ),
    ).toBe(true);
  }
});
