import { describe, expect, test } from 'bun:test';

import { parsePerfMetrics } from './perf/harness';
import { runTestProcess } from './test-process';

const ROOT = new URL('..', import.meta.url).pathname;

describe('input send path benchmark', () => {
  test('reports one objects-per-keystroke metric from the production send path', async () => {
    const { exitCode, stdout, stderr } = await runTestProcess(
      ['bun', 'run', 'scripts/bench-input-send-path.ts'],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          BENCH_KEYSTROKES: '64',
          BENCH_SAMPLES: '3',
          BENCH_WARMUPS: '1',
        },
      },
    );

    expect(exitCode, stderr).toBe(0);
    const metrics = parsePerfMetrics(stdout);
    expect(metrics).toHaveLength(1);
    const metric = metrics[0];
    if (metric === undefined) throw new Error('no metric');
    expect(metric.name).toBe('input-send-objects-per-keystroke');
    expect(metric.unit).toBe('objects/keystroke');
    expect(metric.direction).toBe('lower');
    expect(Number.isFinite(metric.value)).toBe(true);
    // Delivery and ACK validation run outside the boundary allocation capture.
    expect(metric.value).toBeGreaterThanOrEqual(0);
    const records = stdout
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line));
    expect(records).toHaveLength(3);
    for (const record of records) {
      expect(record.datagramsIssued).toBe(64);
      expect(record.reliableRecords).toBe(64);
      expect(record.scope).toContain(
        'authenticated delivery/ACK oracle outside allocation capture',
      );
    }
  });
});
