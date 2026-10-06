import { describe, expect, test } from 'bun:test';

import { resolveAuthContinueRateLimitBenchmarkOptions } from './run-auth-continue-rate-limit-benchmark';

describe('auth continue rate limit benchmark runner', () => {
  test('forwards validated optional sample sizes', () => {
    expect(
      resolveAuthContinueRateLimitBenchmarkOptions([], {
        BENCH_ITERATIONS: '5000',
        BENCH_WARMUP_ITERATIONS: '500',
      }),
    ).toEqual({ iterations: '5000', warmupIterations: '500' });
    expect(resolveAuthContinueRateLimitBenchmarkOptions([], {})).toEqual({
      iterations: undefined,
      warmupIterations: undefined,
    });
  });

  test('rejects arguments and invalid environment values', () => {
    expect(() => resolveAuthContinueRateLimitBenchmarkOptions(['--unexpected'], {})).toThrow(
      'accepts no arguments',
    );
    for (const value of ['', '0', '-1', '1.5', ' 1', '9007199254740992']) {
      expect(() =>
        resolveAuthContinueRateLimitBenchmarkOptions([], { BENCH_ITERATIONS: value }),
      ).toThrow('positive safe integer');
    }
  });
});
