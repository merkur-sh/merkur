import { describe, expect, test } from 'bun:test';
import {
  binomialRate,
  compareDirectFrameControls,
  compareDirectRefreshPeriods,
  type DirectFrameControlPopulation,
  type DirectFramePhasePopulation,
} from './direct-frame-control';

function population(
  name: string,
  p95: number,
  p99: number,
  maximum = p99,
  intervalCount = 240,
): Omit<DirectFramePhasePopulation, 'matchedControl'> {
  return {
    name,
    intervalCount,
    frameBudgetOverrunMs: { count: intervalCount, p95, p99, max: maximum },
    estimatedMissedFrameCount: 0,
    estimatedMissedIntervalCount: 0,
    frameBudgetExceededIntervalCount: 0,
  };
}

function controls(): DirectFrameControlPopulation[] {
  return (['idle', 'keyboard-injection'] as const).flatMap((kind) =>
    (['before', 'after'] as const).map((position, index) => ({
      ...population(`${kind}-${position}`, 1.8 + index / 10, 2 + index / 10),
      kind,
      position,
    })),
  );
}

describe('Direct frame control comparison', () => {
  test('uses bracketing matched controls without turning their absolute miss into a pass', () => {
    const bracket = controls();
    const firstControl = bracket[0];
    if (firstControl === undefined) throw new Error('missing test control');
    bracket[0] = {
      ...firstControl,
      estimatedMissedFrameCount: 1,
      frameBudgetExceededIntervalCount: 8,
    };
    const result = compareDirectFrameControls(
      bracket,
      [{ ...population('typing-8ms', 2.2, 2.4), matchedControl: 'keyboard-injection' }],
      1,
    );
    expect(result.status).toBe('inconclusive');
    expect(result.relativeComplete).toBe(true);
    expect(result.absoluteTargetComplete).toBe(false);
    expect(result.phases[0]?.p95.equivalent).toBe(true);
    expect(result.phases[0]?.rawTarget.met).toBe(false);
    expect(result.phases[0]?.rawTarget.environmentLimited).toBe(true);

    const idlePhase = compareDirectFrameControls(
      bracket,
      [{ ...population('redraw', 2.2, 2.4), matchedControl: 'idle' }],
      1,
    );
    expect(idlePhase.status).toBe('inconclusive');
    expect(idlePhase.phases[0]?.rawTarget.environmentLimited).toBe(true);
    expect(idlePhase.phases[0]?.rawTarget.controlsExceededAbsoluteTarget).toEqual([
      'before',
      'after',
    ]);
  });

  test('fails a product p95 or p99 beyond the fixed matched-control margin', () => {
    const result = compareDirectFrameControls(
      controls(),
      [{ ...population('slow', 3.01, 3.11), matchedControl: 'idle' }],
      1,
    );
    expect(result.status).toBe('fail');
    expect(result.errors).toEqual([
      'slow p95 rAF overrun 3.01ms exceeds bracketed idle control 1.9000000000000001ms + 1ms',
      'slow p99 rAF overrun 3.11ms exceeds bracketed idle control 2.1ms + 1ms',
    ]);
  });

  test('marks low-N active p99 unavailable without padding it with idle samples', () => {
    const result = compareDirectFrameControls(
      controls(),
      [
        {
          ...population('zero-cadence', 2.2, 2.4, 2.4, 80),
          matchedControl: 'keyboard-injection',
        },
      ],
      1,
    );
    expect(result.status).toBe('inconclusive');
    expect(result.phases[0]?.p99).toEqual({
      available: false,
      reason: 'fewer-than-200-active-intervals',
    });
  });

  test('requires both positions and at least 200 intervals per control', () => {
    const invalid = controls().filter(
      (control) => !(control.kind === 'idle' && control.position === 'after'),
    );
    const firstControl = invalid[0];
    if (firstControl === undefined) throw new Error('missing test control');
    invalid[0] = { ...firstControl, intervalCount: 199 };
    const result = compareDirectFrameControls(
      invalid,
      [{ ...population('redraw', 2, 2), matchedControl: 'idle' }],
      1,
    );
    expect(result.status).toBe('fail');
    expect(result.errors.some((error) => error.includes('at least 200'))).toBe(true);
    expect(result.errors).toContain('redraw lacks bracketing idle controls');
    expect(result.errors).toContain('idle after control is missing');
  });

  test('retains Wilson evidence instead of comparing unequal raw counts', () => {
    const zero = binomialRate(0, 400);
    expect(zero.count).toBe(0);
    expect(zero.population).toBe(400);
    expect(zero.rate).toBe(0);
    expect(zero.wilson95.low).toBe(0);
    expect(zero.wilson95.high).toBeCloseTo(0.009512294334296508, 12);
    expect(binomialRate(1, 80).wilson95.high).toBeGreaterThan(0.05);
  });

  test('counts missed intervals rather than treating every missed frame as an independent trial', () => {
    const bracket = controls();
    const phase = {
      ...population('one-long-gap', 2, 2),
      matchedControl: 'idle' as const,
      estimatedMissedFrameCount: 5,
      estimatedMissedIntervalCount: 1,
    };
    const result = compareDirectFrameControls(bracket, [phase], 1);
    expect(result.phases[0]?.rawTarget.productEstimatedMissRate).toMatchObject({
      count: 1,
      population: 240,
      rate: 1 / 240,
    });
  });

  test('cannot pass an absolute miss even when matched controls are noisy', () => {
    const result = compareDirectFrameControls(
      controls(),
      [
        {
          ...population('product-miss', 2, 2),
          matchedControl: 'idle',
          estimatedMissedFrameCount: 1,
          estimatedMissedIntervalCount: 1,
        },
      ],
      1,
    );
    expect(result.status).toBe('inconclusive');
    expect(result.relativeComplete).toBe(true);
    expect(result.absoluteTargetComplete).toBe(false);
    expect(result.inconclusiveReasons).toHaveLength(1);
  });
});

describe('Direct refresh-period anchoring', () => {
  test('accepts same-session phase periods within the fixed calibration tolerance', () => {
    const result = compareDirectRefreshPeriods(
      { sourceAtMs: 100, periodMs: 1000 / 120, confidence01: 0.9 },
      [
        {
          name: 'render-start',
          observations: [{ atMs: 101, periodMs: 8.4 }],
        },
        {
          name: 'measurement-window',
          observations: [{ atMs: null, periodMs: 8.3 }],
        },
      ],
      1,
    );
    expect(result.complete).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.maximumAbsoluteDeltaMs).toBeCloseTo(1 / 15, 10);
  });

  test('rejects a workload-demoted 60Hz harmonic on a calibrated 120Hz display', () => {
    const result = compareDirectRefreshPeriods(
      { sourceAtMs: 100, periodMs: 1000 / 120, confidence01: 0.9 },
      [
        {
          name: 'measurement-window',
          observations: [{ atMs: null, periodMs: 1000 / 60 }],
        },
      ],
      1,
    );
    expect(result.complete).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('differs from calibrated');
  });

  test('fails missing populations, low-confidence calibration, and stale observations', () => {
    const result = compareDirectRefreshPeriods(
      { sourceAtMs: 100, periodMs: 8.33, confidence01: 0.49 },
      [
        { name: 'empty', observations: [] },
        { name: 'stale', observations: [{ atMs: 100, periodMs: 8.33 }] },
      ],
      1,
    );
    expect(result.complete).toBe(false);
    expect(result.errors).toContain(
      'direct phase has no confident pre-workload refresh calibration',
    );
    expect(result.errors).toContain('empty has no refresh-period observations');
    expect(result.errors).toContain('stale[0] does not follow the calibration boundary');
  });

  test('rejects an in-phase session replacement even when its period is unchanged', () => {
    const result = compareDirectRefreshPeriods(
      { sourceAtMs: 100, periodMs: 8.33, confidence01: 0.9 },
      [{ name: 'window', observations: [{ atMs: null, periodMs: 8.33 }] }],
      1,
      [150],
    );
    expect(result.complete).toBe(false);
    expect(result.errors).toContain(
      'phase contains a session start at 150ms after fixed calibration',
    );
  });
});
