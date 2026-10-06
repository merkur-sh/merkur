import { describe, expect, test } from 'bun:test';
import { createRttEstimator, RTO_CEIL_MS, RTO_FLOOR_MS, RTO_INITIAL_MS } from './rtt-estimator';

describe('rtt estimator (RFC 6298)', () => {
  test('returns the initial RTO before any sample', () => {
    const est = createRttEstimator();
    expect(est.srttMs()).toBeNull();
    expect(est.rttvarMs()).toBeNull();
    expect(est.rtoMs()).toBe(RTO_INITIAL_MS);
  });

  test('first sample seeds SRTT = R and RTTVAR = R/2', () => {
    const est = createRttEstimator();
    est.observe(100);
    expect(est.srttMs()).toBe(100);
    expect(est.rttvarMs()).toBe(50);
    // RTO = 100 + 4·50 = 300
    expect(est.rtoMs()).toBe(300);
  });

  test('steady identical samples converge the RTO to the floor', () => {
    const est = createRttEstimator();
    for (let i = 0; i < 50; i += 1) {
      est.observe(20);
    }
    // RTTVAR decays toward 0 on a jitterless path; SRTT + 4·RTTVAR < floor.
    expect(est.rtoMs()).toBe(RTO_FLOOR_MS);
  });

  test('subsequent samples follow the standard gains', () => {
    const est = createRttEstimator();
    est.observe(100); // srtt=100, rttvar=50
    est.observe(200);
    // rttvar = 0.75·50 + 0.25·|100−200| = 62.5; srtt = 0.875·100 + 0.125·200 = 112.5
    expect(est.srttMs()).toBe(112.5);
    expect(est.rttvarMs()).toBe(62.5);
    expect(est.rtoMs()).toBe(112.5 + 4 * 62.5);
  });

  test('RTO clamps at the ceiling on pathological paths', () => {
    const est = createRttEstimator();
    est.observe(5_000);
    expect(est.rtoMs()).toBe(RTO_CEIL_MS);
  });

  test('ignores non-finite and negative samples', () => {
    const est = createRttEstimator();
    est.observe(Number.NaN);
    est.observe(-5);
    est.observe(Number.POSITIVE_INFINITY);
    expect(est.srttMs()).toBeNull();
    expect(est.rtoMs()).toBe(RTO_INITIAL_MS);
  });
});
