import { describe, expect, test } from 'bun:test';
import { imageExperimentOfferPlan, summarizeImageExperiment } from './bench-immutable-image';

describe('immutable image experiment accounting', () => {
  test('open-loop plan is independent of completions and excludes end boundary', () => {
    expect(imageExperimentOfferPlan(1000, 100)).toEqual([
      0, 100, 200, 300, 400, 500, 600, 700, 800, 900,
    ]);
    expect(imageExperimentOfferPlan(1000, 8)).toHaveLength(125);
  });
  test('bounded options reject unbounded or malformed schedules', () => {
    for (const duration of [0, 30_001, Number.NaN, Infinity, 200.5])
      expect(() => imageExperimentOfferPlan(duration, 8)).toThrow();
    for (const interval of [0, -1, Number.NaN, Infinity, 1.5, 1001])
      expect(() => imageExperimentOfferPlan(1000, interval)).toThrow();
  });
  test('nearest-rank tails retain worst samples and empty is not zero latency', () => {
    const values = [100, 1, 2, 3, 4];
    expect(summarizeImageExperiment(values)).toEqual({
      count: 5,
      median: 3,
      p95: 100,
      p99: 100,
      worst: 100,
    });
    expect(values).toEqual([100, 1, 2, 3, 4]);
    expect(summarizeImageExperiment([])).toEqual({
      count: 0,
      median: null,
      p95: null,
      p99: null,
      worst: null,
    });
    expect(() => summarizeImageExperiment([-1])).toThrow();
  });
});
