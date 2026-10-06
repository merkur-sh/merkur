import { expect, test } from 'bun:test';

import { runTestProcess } from './test-process';

test('keyboard hot-path benchmark emits finite framed latency metrics and allocation censuses', async () => {
  const result = await runTestProcess(
    [process.execPath, `${import.meta.dir}/bench-keyboard-hotpaths.ts`],
    {
      env: {
        ...process.env,
        BENCH_STAGE: 'record',
        BENCH_CPU: '0',
        BENCH_SAMPLES: '3',
        BENCH_BATCH_SIZE: '64',
      },
    },
  );
  expect(result.exitCode).toBe(0);
  const output = result.stdout;
  const metrics = output
    .split('\n')
    .filter((line) => line.startsWith('@@merkur-perf '))
    .map((line) => JSON.parse(line.slice('@@merkur-perf '.length)));
  expect(metrics).toHaveLength(3);
  expect(metrics.map((metric) => metric.percentile)).toEqual([0.5, 0.95, 0.99]);
  for (const metric of metrics) {
    expect(metric.name).toBe('keyboard-hot-record');
    expect(metric.unit).toBe('ns/op');
    expect(metric.direction).toBe('lower');
    expect(metric.sampleSize).toBe(3);
    expect(Number.isFinite(metric.value) && metric.value > 0).toBe(true);
  }
  for (const count of [128, 256, 512]) expect(output).toContain(`record: cells/op(${count})=`);
  expect(output).toContain('sink=');
});

test('keyboard hot-path benchmark rejects invalid workload and sampling arguments', async () => {
  for (const env of [
    { BENCH_STAGE: 'absent' },
    { BENCH_SAMPLES: '0' },
    { BENCH_BATCH_SIZE: 'NaN' },
  ]) {
    const result = await runTestProcess(
      [process.execPath, `${import.meta.dir}/bench-keyboard-hotpaths.ts`],
      {
        env: { ...process.env, ...env },
      },
    );
    expect(result.exitCode).not.toBe(0);
  }
});
