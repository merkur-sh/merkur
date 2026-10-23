import { describe, expect, test } from 'bun:test';

import { countsTable, dataplaneBenchmarks, instructionCount } from './bench-instructions';

describe('dataplaneBenchmarks', () => {
  test('reads the release benchmarks and their environment from the package scripts', () => {
    expect(
      dataplaneBenchmarks({
        'bench:display-ack:rust':
          'bazel run //apps/daemon/dataplane:unit_release -- --ignored --exact display::recv::ack',
        'bench:display-pipeline:rust':
          'BENCH_SAMPLES=200 bazel run //apps/daemon/dataplane:unit_release -- --ignored pipeline',
        'bench:browser': 'bun run scripts/bench-browser.ts',
        'build:native': 'bazel run //tools/bazel/native:sync',
      }),
    ).toEqual([
      {
        name: 'bench:display-ack:rust',
        environment: {},
        args: ['--ignored', '--exact', 'display::recv::ack'],
      },
      {
        name: 'bench:display-pipeline:rust',
        environment: { BENCH_SAMPLES: '200' },
        args: ['--ignored', 'pipeline'],
      },
    ]);
  });
});

describe('instructionCount', () => {
  test('is the I refs total Cachegrind prints', () => {
    expect(
      instructionCount(
        '==4242== Cachegrind, a high-precision tracing profiler\n==4242== I   refs:      1,234,567,890\n',
      ),
    ).toBe(1_234_567_890);
  });

  test('a report without one is no answer', () => {
    expect(() => instructionCount('==4242== error')).toThrow('no instruction count');
  });
});

describe('countsTable', () => {
  test('sets each count beside the previous push and the change', () => {
    expect(countsTable({ 'bench:a': 1_050, 'bench:new': 7 }, { 'bench:a': 1_000 })).toBe(
      [
        '| Benchmark | Instructions | Previous push | Change |',
        '| --- | ---: | ---: | ---: |',
        '| `bench:a` | 1,050 | 1,000 | 5.00% |',
        '| `bench:new` | 7 |  |  |',
      ].join('\n'),
    );
  });
});
