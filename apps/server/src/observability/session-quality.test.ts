import { describe, expect, test } from 'bun:test';

import {
  classifySessionQuality,
  SESSION_QUALITY_THRESHOLDS,
  type SessionQualityInput,
} from './session-quality';

/** A nominal window: 30 samples, fast, stable, nothing degraded. */
function window(overrides: Partial<SessionQualityInput> = {}): SessionQualityInput {
  return {
    sampleCount: 30,
    rttP95Ms: 40,
    inputAckP95Ms: 20,
    degradedSampleCount: 0,
    stateReconnecting: 0,
    stateClosed: 0,
    ...overrides,
  };
}

describe('session quality verdict', () => {
  test('a fast, stable window is good', () => {
    expect(classifySessionQuality(window())).toBe('good');
  });

  test('an idle window is good rather than penalised for having no keystrokes', () => {
    // The aggregator reports 0 for a percentile it has no samples for. Zero must
    // read as "no evidence", never as "instant" and never as a failure.
    expect(classifySessionQuality(window({ inputAckP95Ms: 0, rttP95Ms: 0 }))).toBe('good');
  });

  test('perceptible but usable echo is degraded, not bad', () => {
    const justOverGood = SESSION_QUALITY_THRESHOLDS.GOOD_INPUT_ACK_MS + 1;
    expect(classifySessionQuality(window({ inputAckP95Ms: justOverGood }))).toBe('degraded');
  });

  test('echo past the usable threshold is bad', () => {
    const justOverDegraded = SESSION_QUALITY_THRESHOLDS.DEGRADED_INPUT_ACK_MS + 1;
    expect(classifySessionQuality(window({ inputAckP95Ms: justOverDegraded }))).toBe('bad');
  });

  test('thresholds are inclusive at the boundary', () => {
    // The browser reports a percentile as its bucket's upper bound, so the
    // boundary value is the common case rather than an edge case.
    expect(
      classifySessionQuality(
        window({ inputAckP95Ms: SESSION_QUALITY_THRESHOLDS.GOOD_INPUT_ACK_MS }),
      ),
    ).toBe('good');
    expect(
      classifySessionQuality(window({ rttP95Ms: SESSION_QUALITY_THRESHOLDS.GOOD_RTT_MS })),
    ).toBe('good');
    expect(
      classifySessionQuality(
        window({ inputAckP95Ms: SESSION_QUALITY_THRESHOLDS.DEGRADED_INPUT_ACK_MS }),
      ),
    ).toBe('degraded');
  });

  test('slow network alone downgrades the window', () => {
    expect(
      classifySessionQuality(window({ rttP95Ms: SESSION_QUALITY_THRESHOLDS.GOOD_RTT_MS + 1 })),
    ).toBe('degraded');
    expect(
      classifySessionQuality(window({ rttP95Ms: SESSION_QUALITY_THRESHOLDS.DEGRADED_RTT_MS + 1 })),
    ).toBe('bad');
  });

  test('a single degraded sample is enough to lose "good"', () => {
    // Display loss is something the user sees, not statistical noise.
    expect(classifySessionQuality(window({ degradedSampleCount: 1 }))).toBe('degraded');
  });

  test('mostly-degraded windows are bad', () => {
    expect(classifySessionQuality(window({ sampleCount: 30, degradedSampleCount: 16 }))).toBe(
      'bad',
    );
  });

  test('a single reconnect is enough to lose "good"', () => {
    expect(classifySessionQuality(window({ stateReconnecting: 1 }))).toBe('degraded');
  });

  test('a window spent substantially reconnecting or closed is bad', () => {
    expect(classifySessionQuality(window({ sampleCount: 30, stateReconnecting: 8 }))).toBe('bad');
    expect(classifySessionQuality(window({ sampleCount: 30, stateClosed: 8 }))).toBe('bad');
    // Neither alone crosses the ratio, but together they do.
    expect(
      classifySessionQuality(window({ sampleCount: 30, stateReconnecting: 4, stateClosed: 5 })),
    ).toBe('bad');
  });

  test('an empty window does not fabricate a bad verdict', () => {
    expect(classifySessionQuality(window({ sampleCount: 0 }))).toBe('good');
  });

  test('the verdict set is exactly three values', () => {
    // These are metric label values; the set must stay closed.
    const verdicts = new Set(
      [
        window(),
        window({ inputAckP95Ms: 150 }),
        window({ inputAckP95Ms: 5_000 }),
        window({ sampleCount: 0 }),
        window({ degradedSampleCount: 30 }),
      ].map(classifySessionQuality),
    );
    for (const verdict of verdicts) {
      expect(['good', 'degraded', 'bad']).toContain(verdict);
    }
  });

  test('thresholds are ordered so the degraded band is non-empty', () => {
    expect(SESSION_QUALITY_THRESHOLDS.DEGRADED_INPUT_ACK_MS).toBeGreaterThan(
      SESSION_QUALITY_THRESHOLDS.GOOD_INPUT_ACK_MS,
    );
    expect(SESSION_QUALITY_THRESHOLDS.DEGRADED_RTT_MS).toBeGreaterThan(
      SESSION_QUALITY_THRESHOLDS.GOOD_RTT_MS,
    );
  });
});
