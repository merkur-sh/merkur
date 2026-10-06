import { describe, expect, test } from 'bun:test';
import { summarizeDirectPredictionLead } from './direct-prediction-lead';

const complete = { prediction: true, authoritative: true };
const input = (inputSeq: number, prediction: number | null, authoritative: number | null) => ({
  inputSeq,
  inputToPredictionPaintMs: prediction,
  inputToAuthoritativeVisualFenceMs: authoritative,
});

describe('exact-input prediction fence lead', () => {
  test('pairs by input instead of subtracting unrelated marginal percentiles', () => {
    const report = summarizeDirectPredictionLead([input(1, 1, 101), input(2, 99, 100)], complete);
    expect(report.leadMs).toEqual({
      count: 2,
      p50: 1,
      p95: 100,
      p99: 100,
      max: 100,
      p10: 1,
      p90: 100,
      min: 1,
    });
    expect(report.pairs.map((pair) => [pair.inputSeq, pair.leadMs])).toEqual([
      [1, 100],
      [2, 1],
    ]);
  });

  test('keeps missing prediction in the input denominator, including forced-hidden cells', () => {
    const report = summarizeDirectPredictionLead([input(1, 2, 10), input(2, null, 50)], complete);
    expect(report.perceptibleLeadInputRatio).toBe(0.5);
    expect(report.missingPredictionCount).toBe(1);
    expect(report.complete).toBe(true);
    const hidden = summarizeDirectPredictionLead([input(1, null, 50)], complete);
    expect(hidden.perceptibleLeadInputRatio).toBe(0);
    expect(hidden.pairedCount).toBe(0);
    expect(hidden.complete).toBe(true);
    expect(hidden.leadMs.p99).toBeNull();
  });

  test('preserves negative leads, ties and the exact 8ms boundary', () => {
    const report = summarizeDirectPredictionLead(
      [input(1, 20, 10), input(2, 10, 10), input(3, 2, 10), input(4, 2.001, 10)],
      complete,
    );
    expect(report.leadMs.min).toBe(-10);
    expect(report.authoritativeBeforePredictionCount).toBe(1);
    expect(report.equalEndpointCount).toBe(1);
    expect(report.perceptibleLeadCount).toBe(1);
  });

  test('does not accept missing authority or incomplete parent evidence', () => {
    const report = summarizeDirectPredictionLead([input(1, 1, null), input(2, 1, 50)], complete);
    expect(report.complete).toBe(false);
    expect(report.missingAuthorityCount).toBe(1);
    expect(report.pairedCoverageRatio).toBe(0.5);
    for (const key of ['prediction', 'authoritative'] as const) {
      expect(
        summarizeDirectPredictionLead([input(1, 1, 50)], { ...complete, [key]: false }).complete,
      ).toBe(false);
    }
  });

  test('rejects duplicate, zero and out-of-range identities even without a pair', () => {
    for (const seq of [0, -1, 0x1_0000_0000, 1.5, Number.NaN]) {
      expect(() => summarizeDirectPredictionLead([input(seq, null, null)], complete)).toThrow();
    }
    expect(() =>
      summarizeDirectPredictionLead([input(1, null, 50), input(1, 1, 50)], complete),
    ).toThrow();
  });

  test('rejects non-finite and negative endpoints rather than silently censoring them', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(() => summarizeDirectPredictionLead([input(1, value, 50)], complete)).toThrow();
      expect(() => summarizeDirectPredictionLead([input(1, 1, value)], complete)).toThrow();
    }
  });

  test('empty populations have no fabricated zero quantiles or ratios', () => {
    const report = summarizeDirectPredictionLead([], complete);
    expect(report.inputCount).toBe(0);
    expect(report.complete).toBe(false);
    expect(report.perceptibleLeadInputRatio).toBeNull();
    expect(report.pairedCoverageRatio).toBeNull();
    expect(report.leadMs.min).toBeNull();
    expect(report.leadMs.p90).toBeNull();
  });
});
