import { describe, expect, test } from 'bun:test';

import { resolveSessionStartBenchmarkOptions } from './run-session-start-benchmark';

describe('session-start benchmark runner options', () => {
  test('uses benchmark defaults when sampling overrides are absent', () => {
    expect(resolveSessionStartBenchmarkOptions([], {})).toEqual({
      iterations: undefined,
      warmupIterations: undefined,
      baselineArtifact: undefined,
      regressionPercent: undefined,
    });
  });

  test('forwards validated iteration and warmup counts unchanged', () => {
    expect(
      resolveSessionStartBenchmarkOptions([], {
        BENCH_ITERATIONS: '2500',
        BENCH_WARMUP_ITERATIONS: '250',
      }),
    ).toEqual({
      iterations: '2500',
      warmupIterations: '250',
      baselineArtifact: undefined,
      regressionPercent: undefined,
    });
  });

  test('forwards one archived pre-cut baseline artifact path', () => {
    expect(
      resolveSessionStartBenchmarkOptions(['--baseline-artifact=artifacts/pre-cut.jsonl'], {}),
    ).toEqual({
      iterations: undefined,
      warmupIterations: undefined,
      baselineArtifact: 'artifacts/pre-cut.jsonl',
      regressionPercent: undefined,
    });
  });

  test('forwards one explicit regression threshold with a baseline', () => {
    expect(
      resolveSessionStartBenchmarkOptions(
        ['--regression-percent=7.5', '--baseline-artifact=artifacts/session-start-pre-cut.jsonl'],
        {},
      ),
    ).toEqual({
      iterations: undefined,
      warmupIterations: undefined,
      baselineArtifact: 'artifacts/session-start-pre-cut.jsonl',
      regressionPercent: '7.5',
    });
  });

  for (const [name, environment] of [
    ['zero iterations', { BENCH_ITERATIONS: '0' }],
    ['fractional iterations', { BENCH_ITERATIONS: '1.5' }],
    ['negative warmups', { BENCH_WARMUP_ITERATIONS: '-1' }],
    ['unsafe warmups', { BENCH_WARMUP_ITERATIONS: '999999999999999999999999' }],
  ] as const) {
    test(`rejects ${name}`, () => {
      expect(() => resolveSessionStartBenchmarkOptions([], environment)).toThrow(
        /must be a positive safe integer/,
      );
    });
  }

  test('rejects positional arguments before starting Docker', () => {
    expect(() => resolveSessionStartBenchmarkOptions(['unexpected'], {})).toThrow(
      'unexpected argument: unexpected',
    );
  });

  test('rejects an empty or repeated baseline artifact argument', () => {
    expect(() => resolveSessionStartBenchmarkOptions(['--baseline-artifact='], {})).toThrow(
      'requires a non-empty path',
    );
    expect(() =>
      resolveSessionStartBenchmarkOptions(
        ['--baseline-artifact=first.jsonl', '--baseline-artifact=second.jsonl'],
        {},
      ),
    ).toThrow('may be specified only once');
  });

  test('rejects invalid, unbound, or repeated regression thresholds', () => {
    for (const argument of [
      '--regression-percent=',
      '--regression-percent=-1',
      '--regression-percent=NaN',
      '--regression-percent=Infinity',
      '--regression-percent= 5',
    ]) {
      expect(() =>
        resolveSessionStartBenchmarkOptions([argument, '--baseline-artifact=baseline.jsonl'], {}),
      ).toThrow('must be a non-negative finite number');
    }
    expect(() => resolveSessionStartBenchmarkOptions(['--regression-percent=5'], {})).toThrow(
      'requires --baseline-artifact',
    );
    expect(() =>
      resolveSessionStartBenchmarkOptions(
        ['--baseline-artifact=baseline.jsonl', '--regression-percent=5', '--regression-percent=6'],
        {},
      ),
    ).toThrow('may be specified only once');
  });
});
