import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parsePerfMetrics } from './perf/harness';
import { runTestProcess } from './test-process';

/** Where the benchmark runs: the repository's root, a place to start in, not a file it reads. */
const ROOT = path.resolve(import.meta.dir, '..');
const BENCHMARK = fileURLToPath(new URL('./bench-input-send-path.ts', import.meta.url));

describe('input send path benchmark', () => {
  test('reports one objects-per-keystroke metric from the production send path', async () => {
    const { exitCode, stdout, stderr } = await runTestProcess(['bun', 'run', BENCHMARK], {
      cwd: ROOT,
      env: {
        ...process.env,
        BENCH_KEYSTROKES: '64',
        BENCH_SAMPLES: '3',
        BENCH_WARMUPS: '1',
      },
    });

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
