import { describe, expect, test } from 'bun:test';

import { displayProcessSliceBudgetMs } from './display-process-budget';

describe('display process slice budget', () => {
  test('leaves render headroom at every supported active cadence', () => {
    for (const hz of [60, 90, 120, 144, 240, 480]) {
      const period = 1000 / hz;
      const budget = displayProcessSliceBudgetMs(6, period);
      expect(budget).toBeLessThan(period);
      expect(budget).toBeLessThanOrEqual(6);
      expect(budget).toBeCloseTo(Math.min(6, period * 0.7), 8);
    }
  });

  test('cold or invalid cadence is conservatively bounded as 480 Hz', () => {
    const coldBound = (1000 / 480) * 0.7;
    expect(displayProcessSliceBudgetMs(6, Number.NaN)).toBeCloseTo(coldBound, 8);
    expect(displayProcessSliceBudgetMs(6, 0)).toBeCloseTo(coldBound, 8);
  });

  test('a lower operator tuning remains the cap and zero disables multi-frame work', () => {
    expect(displayProcessSliceBudgetMs(1.5, 1000 / 240)).toBe(1.5);
    expect(displayProcessSliceBudgetMs(0, 1000 / 60)).toBe(0);
    expect(displayProcessSliceBudgetMs(Number.NaN, 1000 / 60)).toBe(0);
  });
});
