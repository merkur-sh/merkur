import { expect, test } from 'bun:test';
import { runTestProcess } from './test-process';

const benchmarkEnvironment = {
  ...process.env,
  BENCH_EXECUTABLE: undefined,
  BENCH_BASELINE_EXECUTABLE: undefined,
  BENCH_CONTROL_EXECUTABLE: undefined,
};

test('the loader benchmark summarizes every fresh-process workload', async () => {
  const result = await runTestProcess(
    [process.execPath, new URL('./bench-bun-wasm-bootstrap.ts', import.meta.url).pathname],
    {
      env: {
        ...benchmarkEnvironment,
        BENCH_SAMPLES: '1',
      },
    },
  );
  expect(result.exitCode, result.stderr).toBe(0);
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
      if (row.instructions !== undefined) expect(row.instructions.median).toBeGreaterThan(0);
      expect(row.peakRssBytes.median).toBeGreaterThan(0);
    }
  }
  expect(result.stdout).toContain('@@merkur-perf ');
}, 30_000);

test('the loader benchmark omits unavailable macOS counters', async () => {
  const benchmark = new URL('./bench-bun-wasm-bootstrap.ts', import.meta.url);
  const result = await runTestProcess(
    [
      process.execPath,
      '-e',
      `
        Object.defineProperty(process, 'platform', { value: 'darwin' });
        const spawn = Bun.spawn;
        let sample = 0;
        Bun.spawn = (command, options) => {
          const child = spawn(command.slice(2), { ...options, stderr: 'inherit' });
          const counters = '4096  maximum resident set size\\n' +
            (sample++ % 2 === 0 ? '' : '1000  instructions retired\\n');
          return {
            stdout: child.stdout,
            stderr: new Blob([counters]).stream(),
            exited: child.exited,
          };
        };
        await import(${JSON.stringify(benchmark.href)});
      `,
    ],
    {
      env: {
        ...benchmarkEnvironment,
        BENCH_SAMPLES: '2',
      },
    },
  );
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stderr).toBe('');
  const rows = result.stdout.split('\n').filter((line) => line.startsWith('{'));
  expect(rows).toHaveLength(4);
  for (const line of rows) {
    const row = JSON.parse(line);
    expect(row.peakRssBytes.median).toBe(4096);
    expect(row.instructions).toBeUndefined();
    expect(row.peakFootprintBytes).toBeUndefined();
  }
}, 30_000);
