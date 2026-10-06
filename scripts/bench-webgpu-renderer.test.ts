import { afterEach, expect, test } from 'bun:test';
import { parsePerfMetrics } from './perf/harness';
import { rendererBenchmarkCount } from './perf/webgpu-renderer-benchmark';
import { runTestProcess } from './test-process';

const oldCount = process.env.MERKUR_TEST_RENDERER_COUNT;
afterEach(() => {
  if (oldCount === undefined) delete process.env.MERKUR_TEST_RENDERER_COUNT;
  else process.env.MERKUR_TEST_RENDERER_COUNT = oldCount;
});

test('renderer component schedule rejects unbounded or fractional samples', () => {
  delete process.env.MERKUR_TEST_RENDERER_COUNT;
  expect(rendererBenchmarkCount('MERKUR_TEST_RENDERER_COUNT', 20)).toBe(20);
  for (const value of ['-1', '0', '1.5', '1001', 'NaN']) {
    process.env.MERKUR_TEST_RENDERER_COUNT = value;
    expect(() => rendererBenchmarkCount('MERKUR_TEST_RENDERER_COUNT', 20)).toThrow();
  }
  process.env.MERKUR_TEST_RENDERER_COUNT = '0';
  expect(rendererBenchmarkCount('MERKUR_TEST_RENDERER_COUNT', 5, 0)).toBe(0);
});

test('production WebGPU component initializes and renders actual nonempty pixels with exact callbacks', async () => {
  for (const mode of ['init', 'render'] as const) {
    const { exitCode, stdout, stderr } = await runTestProcess(
      ['bun', `scripts/bench-webgpu-renderer-${mode}.ts`],
      {
        cwd: new URL('..', import.meta.url).pathname,
        env: {
          ...process.env,
          DEBUG: 'pw:browser',
          BENCH_GPU: 'swiftshader',
          BENCH_SAMPLES: '2',
          BENCH_WARMUPS: '0',
          BENCH_INITS_PER_SAMPLE: '1',
          BENCH_FRAMES_PER_SAMPLE: '1',
        },
        timeout: 45_000,
      },
    );
    expect(exitCode, stderr).toBe(0);
    const metrics = parsePerfMetrics(stdout);
    expect(metrics.filter((m) => m.percentile !== undefined)).toHaveLength(mode === 'init' ? 3 : 9);
    expect(metrics.every((m) => Number.isFinite(m.value) && m.value >= 0)).toBe(true);
    if (mode === 'render') {
      expect(stdout.match(/"rgba":"[0-9a-f]{64}"/g)).toHaveLength(3);
      expect(
        metrics.filter((m) => m.name.endsWith('api-submissions')).every((m) => m.value === 1),
      ).toBe(true);
      expect(
        metrics.find((m) => m.name === 'webgpu-render-same-version-api-uploadBytes')?.value,
      ).toBe(0);
    }
  }
}, 100_000);
