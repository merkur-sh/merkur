import { describe, expect, test } from 'bun:test';

import { parseCriterionMetrics } from './criterion';

describe('Criterion metric parser', () => {
  test('parses inline and wrapped estimates and normalizes their units', () => {
    const output = [
      'Benchmarking encode_row',
      'encode_row              time:   [126.20 ns 127.28 ns 129.01 ns]',
      'Benchmarking long/group/name: Analyzing',
      '                        time:   [2.50 µs 2.75 µs 3.00 µs]',
    ].join('\n');

    expect(parseCriterionMetrics(output, 20)).toEqual([
      {
        name: 'criterion-time:encode_row',
        value: 127.28,
        unit: 'ns/op',
        direction: 'lower',
        sampleSize: 20,
      },
      {
        name: 'criterion-time:long/group/name',
        value: 2_750,
        unit: 'ns/op',
        direction: 'lower',
        sampleSize: 20,
      },
    ]);
  });

  test('uses Criterion non-TTY standalone identities for later wrapped estimates', () => {
    const output = [
      'lz4_compress/blank/512  time:   [117.40 ns 120.27 ns 122.67 ns]',
      '                        thrpt:  [3.8872 GiB/s 3.9648 GiB/s 4.0618 GiB/s]',
      '                 change:',
      '                        No change in performance detected.',
      'Found 2 outliers among 20 measurements (10.00%)',
      '  2 (10.00%) high mild',
      'lz4_compress/terminal/512',
      '                        time:   [184.29 ns 191.06 ns 197.76 ns]',
    ].join('\n');

    expect(parseCriterionMetrics(output, 20).map(({ name, value }) => ({ name, value }))).toEqual([
      { name: 'criterion-time:lz4_compress/blank/512', value: 120.27 },
      { name: 'criterion-time:lz4_compress/terminal/512', value: 191.06 },
    ]);
  });

  test('handles ANSI output, ASCII microseconds, and scientific notation', () => {
    const output =
      '\u001b[32mdecode\u001b[0m time: [1.0e-1 us 2.0e-1 us 3.0e-1 us]\n' +
      'slow time: [0.5 ms 1.5 ms 2.5 ms]';

    expect(parseCriterionMetrics(output, 10).map(({ name, value }) => ({ name, value }))).toEqual([
      { name: 'criterion-time:decode', value: 200 },
      { name: 'criterion-time:slow', value: 1_500_000 },
    ]);
  });

  test('normalizes confidence interval values that Criterion renders with different units', () => {
    const output = 'threshold time: [1000 ns 2 us 0.003 ms]';

    expect(parseCriterionMetrics(output, 10)[0]?.value).toBe(2_000);
  });

  test('rejects duplicate estimates and invalid sample sizes', () => {
    const duplicate = ['same time: [1 ns 2 ns 3 ns]', 'same time: [1 ns 2 ns 3 ns]'].join('\n');

    expect(() => parseCriterionMetrics(duplicate, 10)).toThrow('duplicate');
    expect(() => parseCriterionMetrics('', 0)).toThrow('sample size');
    expect(() => parseCriterionMetrics('reversed time: [1 ns 2 us 3 ns]', 10)).toThrow(
      'confidence interval',
    );
  });

  test('rejects truncated output even when it contains a complete leading estimate', () => {
    const output = 'first time: [1 ns 2 ns 3 ns]\n\n[output truncated after 512 bytes]\n';

    expect(() => parseCriterionMetrics(output, 10)).toThrow('metric set may be incomplete');
  });
});
