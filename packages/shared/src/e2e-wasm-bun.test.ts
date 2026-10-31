import { expect, test } from 'bun:test';
import { runTestProcess } from '../../../scripts/test-process';

test('the lazy Bun loader compiles its owned file bytes without copying them', async () => {
  const result = await runTestProcess([
    process.execPath,
    new URL('../../../scripts/bench-bun-wasm-bootstrap.ts', import.meta.url).pathname,
    '--child',
    'probe',
  ]);
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe('');
  expect(JSON.parse(result.stdout)).toMatchObject({
    copies: 0,
    copiedBytes: 0,
    modules: 1,
    fingerprint: '5af45893c07601a8118808cd6c700f9ae4f046c42742ec355981a307e46c6739',
  });
});

test('the loader benchmark summarizes every fresh-process workload', async () => {
  const result = await runTestProcess(
    [
      process.execPath,
      new URL('../../../scripts/bench-bun-wasm-bootstrap.ts', import.meta.url).pathname,
    ],
    {
      env: {
        ...process.env,
        BENCH_SAMPLES: '1',
        BENCH_EXECUTABLE: undefined,
        BENCH_BASELINE_EXECUTABLE: undefined,
        BENCH_CONTROL_EXECUTABLE: undefined,
      },
    },
  );
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe('');
  const rows = result.stdout.split('\n').filter((line) => line.startsWith('{'));
  expect(rows.map((line) => JSON.parse(line).workload)).toEqual([
    'probe',
    'import',
    'init',
    'steady',
  ]);
  for (const line of rows) {
    const row = JSON.parse(line);
    expect(row.samples).toBe(1);
    expect(row.retainedHeapBytes.median).toBeGreaterThan(0);
    if (process.platform === 'darwin') {
      expect(row.instructions.median).toBeGreaterThan(0);
      expect(row.peakRssBytes.median).toBeGreaterThan(0);
    }
  }
  expect(result.stdout).toContain('@@merkur-perf ');
});
