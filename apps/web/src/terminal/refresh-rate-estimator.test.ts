import { fullGC, heapStats } from 'bun:jsc';
import { describe, expect, test } from 'bun:test';
import { createRefreshRateEstimator, type RefreshRateEstimator } from './refresh-rate-estimator';

const PERIOD_60_MS = 1000 / 60;
const PERIOD_100_MS = 1000 / 100;
const PERIOD_120_MS = 1000 / 120;
const PERIOD_144_MS = 1000 / 144;
const PERIOD_240_MS = 1000 / 240;

function feed(
  estimator: RefreshRateEstimator,
  deltas: readonly number[],
  startTs = 0,
  continuous = true,
): number {
  let ts = startTs;
  estimator.sample(ts, continuous);
  for (const delta of deltas) {
    ts += delta;
    estimator.sample(ts, continuous);
  }
  return ts;
}

/**
 * Cells allocated per op of `run`, net of the heap snapshot itself. Counts are
 * taken with no collection in between, so every cell the loop allocates is
 * still counted; a collection inside the loop could only lower the figure.
 */
function cellsPerOp(run: (ops: number) => void, ops: number): number {
  const cells = (): number => {
    const counts = heapStats().objectTypeCounts;
    let total = 0;
    for (const key in counts) total += counts[key] ?? 0;
    return total;
  };
  for (let warmup = 0; warmup < 20; warmup += 1) run(ops);
  fullGC();
  const snapshotStart = cells();
  const snapshotOverhead = cells() - snapshotStart;
  fullGC();
  const before = cells();
  run(ops);
  return (cells() - before - snapshotOverhead) / ops;
}

describe('createRefreshRateEstimator', () => {
  test('defaults to 60Hz before any samples', () => {
    const estimator = createRefreshRateEstimator();
    expect(estimator.periodMs()).toBeCloseTo(PERIOD_60_MS, 5);
    expect(estimator.confidence01()).toBe(0);
  });

  test('stays at the default while the seed window is unfilled', () => {
    const estimator = createRefreshRateEstimator();
    feed(estimator, Array(5).fill(PERIOD_120_MS));
    expect(estimator.periodMs()).toBeCloseTo(PERIOD_60_MS, 5);
  });

  test('cold presentation deadlines learn high-Hz cadence from initial rAF samples', () => {
    for (const period of [PERIOD_120_MS, PERIOD_144_MS, PERIOD_240_MS]) {
      const estimator = createRefreshRateEstimator();
      // With no cadence evidence, presentation uses the fastest supported
      // bound rather than assuming that this is a 60 Hz panel.
      expect(estimator.presentationPeriodMs()).toBeCloseTo(1000 / 480, 5);
      estimator.sample(100, true);
      estimator.sample(100 + period, true);
      expect(estimator.confidence01()).toBe(0);
      expect(estimator.presentationPeriodMs()).toBeCloseTo(period, 5);
    }
  });

  test('a reset relearns high-Hz presentation cadence before confidence returns', () => {
    for (const period of [PERIOD_120_MS, PERIOD_144_MS, PERIOD_240_MS]) {
      const estimator = createRefreshRateEstimator();
      feed(estimator, Array(12).fill(PERIOD_60_MS));
      expect(estimator.periodMs()).toBeCloseTo(PERIOD_60_MS, 3);

      estimator.reset();
      estimator.sample(1_000, true);
      estimator.sample(1_000 + period, true);
      expect(estimator.confidence01()).toBe(0);
      expect(estimator.presentationPeriodMs()).toBeCloseTo(period, 5);
    }
  });

  test('locks 120Hz from clean deltas', () => {
    const estimator = createRefreshRateEstimator();
    feed(estimator, Array(10).fill(PERIOD_120_MS));
    expect(estimator.periodMs()).toBeCloseTo(PERIOD_120_MS, 3);
  });

  test('locks 100Hz exactly without a candidate list', () => {
    const estimator = createRefreshRateEstimator();
    feed(estimator, Array(12).fill(PERIOD_100_MS));
    expect(estimator.periodMs()).toBeCloseTo(PERIOD_100_MS, 3);
  });

  test('stays at 60Hz when jank doubles fold as k=2', () => {
    const estimator = createRefreshRateEstimator();
    const deltas: number[] = [];
    for (let i = 0; i < 10; i += 1) deltas.push(PERIOD_60_MS, PERIOD_60_MS * 2);
    feed(estimator, deltas);
    expect(estimator.periodMs()).toBeCloseTo(PERIOD_60_MS, 2);
  });

  test('recovers 120Hz through jank (mixed single and double periods)', () => {
    const estimator = createRefreshRateEstimator();
    const deltas: number[] = [];
    for (let i = 0; i < 10; i += 1) deltas.push(PERIOD_120_MS, PERIOD_120_MS * 2);
    feed(estimator, deltas);
    expect(estimator.periodMs()).toBeCloseTo(PERIOD_120_MS, 2);
  });

  test('freezes through throttle gaps instead of inflating', () => {
    const estimator = createRefreshRateEstimator();
    const ts = feed(estimator, Array(12).fill(PERIOD_120_MS));
    feed(estimator, Array(10).fill(1000), ts);
    expect(estimator.periodMs()).toBeCloseTo(PERIOD_120_MS, 3);
  });

  test('stays at the default when only throttled deltas are seen', () => {
    const estimator = createRefreshRateEstimator();
    feed(estimator, Array(10).fill(1000));
    expect(estimator.periodMs()).toBeCloseTo(PERIOD_60_MS, 5);
  });

  test('re-seeds upward on a 60Hz to 120Hz monitor move', () => {
    const estimator = createRefreshRateEstimator();
    const ts = feed(estimator, Array(16).fill(PERIOD_60_MS));
    feed(estimator, Array(16).fill(PERIOD_120_MS), ts);
    expect(estimator.periodMs()).toBeCloseTo(PERIOD_120_MS, 2);
  });

  test('demotes to the subharmonic on a 120Hz to 60Hz monitor move', () => {
    const estimator = createRefreshRateEstimator();
    const ts = feed(estimator, Array(16).fill(PERIOD_120_MS));
    feed(estimator, Array(16).fill(PERIOD_60_MS), ts);
    expect(estimator.periodMs()).toBeCloseTo(PERIOD_60_MS, 2);
  });

  test('locks 120Hz despite timestamp jitter', () => {
    const estimator = createRefreshRateEstimator();
    const deltas: number[] = [];
    for (let i = 0; i < 16; i += 1) deltas.push(PERIOD_120_MS + (i % 2 === 0 ? 0.3 : -0.3));
    feed(estimator, deltas);
    expect(estimator.periodMs()).toBeCloseTo(PERIOD_120_MS, 1);
  });

  test('a single anomalous fast delta does not move a 60Hz lock', () => {
    const estimator = createRefreshRateEstimator();
    const ts = feed(estimator, Array(10).fill(PERIOD_60_MS));
    feed(estimator, [7, PERIOD_60_MS, PERIOD_60_MS, PERIOD_60_MS], ts);
    expect(estimator.periodMs()).toBeCloseTo(PERIOD_60_MS, 2);
    expect(estimator.presentationPeriodMs()).toBeCloseTo(PERIOD_60_MS, 2);
  });

  test('a jittery seed that locked too slow is walked back down by continuous evidence', () => {
    const estimator = createRefreshRateEstimator();
    // A calibration burst landing on a busy main thread: every delta is a real
    // 60 Hz frame plus scheduling noise, which folds onto a period roughly two
    // milliseconds too long. Production published exactly this shape — 18.2,
    // 18.4 and 18.7 ms estimates on 60 Hz panels — and it used to stick for the
    // whole session because the presentation bound could never be lowered.
    const jitter = [2.1, 1.6, 2.4, 1.9, 2.3, 1.7, 2.2, 2.0];
    const ts = feed(
      estimator,
      jitter.map((noise) => PERIOD_60_MS + noise),
    );
    expect(estimator.periodMs()).toBeGreaterThan(PERIOD_60_MS + 1);

    // The panel keeps producing clean 60 Hz frames. Every one is rejected as an
    // outlier against the inflated lock, so only the carried re-seed can see
    // them — and it corrects the published bound inside the same burst.
    const corrected = feed(estimator, Array(5).fill(PERIOD_60_MS), ts);
    expect(estimator.presentationPeriodMs()).toBeCloseTo(PERIOD_60_MS, 1);
    // A full seed window later the lock itself is back, at full confidence.
    feed(estimator, Array(8).fill(PERIOD_60_MS), corrected);
    expect(estimator.periodMs()).toBeCloseTo(PERIOD_60_MS, 1);
    expect(estimator.presentationPeriodMs()).toBeCloseTo(PERIOD_60_MS, 1);
    expect(estimator.confidence01()).toBeGreaterThan(0.5);
  });

  test('the presentation bound follows the estimate down as well as up', () => {
    const estimator = createRefreshRateEstimator();
    const ts = feed(estimator, Array(12).fill(PERIOD_60_MS));
    expect(estimator.presentationPeriodMs()).toBeCloseTo(PERIOD_60_MS, 2);
    // The session moves to a faster display. Nothing may pin the old, slower
    // seed observation as a floor under the new one.
    estimator.reset();
    feed(estimator, Array(16).fill(PERIOD_120_MS), ts + 1_000);
    expect(estimator.periodMs()).toBeCloseTo(PERIOD_120_MS, 2);
    expect(estimator.presentationPeriodMs()).toBeCloseTo(PERIOD_120_MS, 2);
  });

  test('locks slow panels down to the 30Hz clamp', () => {
    const estimator = createRefreshRateEstimator();
    feed(estimator, Array(12).fill(25));
    expect(estimator.periodMs()).toBeCloseTo(25, 2);
  });

  test('rejects deltas beyond the slow-panel seed band', () => {
    const estimator = createRefreshRateEstimator();
    feed(estimator, Array(12).fill(50));
    expect(estimator.periodMs()).toBeCloseTo(PERIOD_60_MS, 5);
  });

  test('detects VRR after a lock and publishes a stable lower bound', () => {
    const estimator = createRefreshRateEstimator();
    let ts = feed(estimator, Array(10).fill(PERIOD_120_MS));
    const vrrDeltas: number[] = [];
    for (let i = 0; i < 48; i += 1) vrrDeltas.push(7.4 + (i % 5) * 0.5);
    ts = feed(estimator, vrrDeltas, ts);
    expect(estimator.vrr()).toBe(true);
    const period = estimator.periodMs();
    expect(period).toBeGreaterThan(7);
    expect(period).toBeLessThan(8.6);
    expect(estimator.nextVsyncAfter(ts)).toBeNull();
  });

  test('a VRR period read reports the ring P10 without allocating', () => {
    const estimator = createRefreshRateEstimator();
    let ts = feed(estimator, Array(10).fill(PERIOD_120_MS));
    const vrrDeltas: number[] = [];
    for (let i = 0; i < 48; i += 1) vrrDeltas.push(7.4 + (i % 5) * 0.5);
    ts = feed(estimator, vrrDeltas, ts);
    expect(estimator.vrr()).toBe(true);
    // The last 32 periods cycle 7.4 to 9.4 ms, with 7.4 at least four times,
    // so the 10th percentile (sorted index 3) is 7.4.
    expect(estimator.presentationPeriodMs()).toBeCloseTo(7.4, 6);

    // Every display pump reads the period; a copy and sort of the ring per read
    // costs 3 cells.
    let sum = 0;
    const reads = (count: number): void => {
      for (let read = 0; read < count; read += 1) sum += estimator.presentationPeriodMs();
    };
    expect(cellsPerOp(reads, 1024)).toBeLessThan(1);
    expect(sum).toBeGreaterThan(0);
  });

  test('predicts the next vsync edge within 0.5ms on a clean lock', () => {
    const estimator = createRefreshRateEstimator();
    const ts = feed(estimator, Array(20).fill(PERIOD_120_MS), 1000);
    const next = estimator.nextVsyncAfter(ts + 1);
    expect(next).not.toBeNull();
    if (next !== null) {
      expect(Math.abs(next - (ts + PERIOD_120_MS))).toBeLessThan(0.5);
    }
  });

  test('phase prediction goes null when the lock is stale', () => {
    const estimator = createRefreshRateEstimator();
    const ts = feed(estimator, Array(20).fill(PERIOD_120_MS));
    expect(estimator.nextVsyncAfter(ts + 10_000)).toBeNull();
  });

  test('reset returns to the default with zero confidence', () => {
    const estimator = createRefreshRateEstimator();
    feed(estimator, Array(12).fill(PERIOD_120_MS));
    estimator.reset();
    expect(estimator.periodMs()).toBeCloseTo(PERIOD_60_MS, 5);
    expect(estimator.confidence01()).toBe(0);
  });

  test('a revalidation burst after a long idle does not inflate the span estimate', () => {
    const estimator = createRefreshRateEstimator();
    // The calibrator revalidates once a minute, so the first delta of every
    // burst spans the whole idle. That gap is skipped, and if the span baseline
    // is not restarted with it the elapsed time lands in the period estimate.
    let ts = feed(estimator, Array(40).fill(PERIOD_120_MS));
    ts = feed(estimator, [60_000], ts);
    feed(estimator, Array(12).fill(PERIOD_120_MS), ts);
    expect(estimator.periodMs()).toBeCloseTo(PERIOD_120_MS, 2);
  });

  test('a skipped gap does not make a stale phase look fresh', () => {
    const estimator = createRefreshRateEstimator();
    const ts = feed(estimator, Array(20).fill(PERIOD_120_MS));
    feed(estimator, [60_000], ts);
    expect(estimator.nextVsyncAfter(ts + 60_000)).toBeNull();
  });

  test('rejected residuals cannot inflate the accepted span at full confidence', () => {
    for (const continuous of [false, true]) {
      const estimator = createRefreshRateEstimator();
      let ts = feed(estimator, Array(60).fill(PERIOD_120_MS));
      for (let i = 0; i < 100; i += 1) {
        ts = feed(estimator, [PERIOD_120_MS * 1.4, PERIOD_120_MS], ts, continuous);
      }
      expect(estimator.confidence01()).toBeGreaterThan(0.99);
      expect(estimator.periodMs()).toBeCloseTo(PERIOD_120_MS, 5);
    }
  });

  test('rejected sub-period samples cannot leak into the next accepted span', () => {
    for (const continuous of [false, true]) {
      const estimator = createRefreshRateEstimator();
      let ts = feed(estimator, Array(60).fill(PERIOD_120_MS));
      for (let i = 0; i < 100; i += 1) {
        ts = feed(estimator, [PERIOD_120_MS * 0.4, PERIOD_120_MS], ts, continuous);
      }
      expect(estimator.periodMs()).toBeCloseTo(PERIOD_120_MS, 5);
    }
  });

  test('a rejected sample does not refresh a stale phase', () => {
    const estimator = createRefreshRateEstimator();
    let ts = feed(estimator, Array(60).fill(PERIOD_120_MS));
    ts = feed(estimator, Array(40).fill(PERIOD_120_MS * 1.4), ts, false);
    expect(estimator.nextVsyncAfter(ts)).toBeNull();
    feed(estimator, Array(20).fill(PERIOD_120_MS), ts, false);
    expect(estimator.periodMs()).toBeCloseTo(PERIOD_120_MS, 5);
  });

  test('near-duplicate and invalid timestamps do not move the delta origin', () => {
    const estimator = createRefreshRateEstimator();
    let ts = feed(estimator, Array(60).fill(PERIOD_120_MS));
    for (let i = 0; i < 100; i += 1) {
      estimator.sample(ts + 0.25, false);
      estimator.sample(ts - 1, false);
      estimator.sample(Number.NaN, false);
      estimator.sample(Number.POSITIVE_INFINITY, false);
      estimator.sample(Number.NEGATIVE_INFINITY, false);
      ts += PERIOD_120_MS;
      estimator.sample(ts, true);
    }
    expect(estimator.periodMs()).toBeCloseTo(PERIOD_120_MS, 5);
    expect(estimator.confidence01()).toBeGreaterThan(0.99);
  });

  test('a suspended seed chain cannot combine old and new monitor samples', () => {
    const estimator = createRefreshRateEstimator();
    let ts = feed(estimator, Array(6).fill(PERIOD_120_MS));
    ts = feed(estimator, [60_000, PERIOD_60_MS, PERIOD_60_MS], ts);
    expect(estimator.confidence01()).toBe(0);
    expect(estimator.presentationPeriodMs()).toBeCloseTo(PERIOD_60_MS, 5);
    feed(estimator, Array(10).fill(PERIOD_60_MS), ts);
    expect(estimator.periodMs()).toBeCloseTo(PERIOD_60_MS, 5);
    expect(estimator.confidence01()).toBeGreaterThan(0.99);
  });

  test('an opportunistic k>=2 run does not demote a 120Hz lock', () => {
    const estimator = createRefreshRateEstimator();
    const ts = feed(estimator, Array(16).fill(PERIOD_120_MS));
    // The render loop asks for a frame only when it has something to paint, so
    // during typing every delta it produces spans several vsyncs. Read as
    // display evidence this is a 120 -> 60 -> 30Hz monitor move; read as demand
    // it is a quiet terminal.
    feed(estimator, Array(24).fill(PERIOD_120_MS * 4), ts, false);
    expect(estimator.periodMs()).toBeCloseTo(PERIOD_120_MS, 2);
  });

  test('the same k>=2 run from the calibrator still demotes', () => {
    const estimator = createRefreshRateEstimator();
    const ts = feed(estimator, Array(16).fill(PERIOD_120_MS));
    feed(estimator, Array(24).fill(PERIOD_120_MS * 4), ts, true);
    expect(estimator.periodMs()).toBeGreaterThan(PERIOD_120_MS * 2);
  });

  test('opportunistic samples never walk the estimate to the 30Hz clamp', () => {
    const estimator = createRefreshRateEstimator();
    // The production ladder, reproduced: repeated k>=2 windows demoted 8.33 ->
    // 16.67 -> 33.33ms, which doubled every threshold derived from the period.
    let ts = feed(estimator, Array(16).fill(PERIOD_120_MS));
    for (let burst = 0; burst < 6; burst += 1) {
      ts = feed(estimator, Array(14).fill(PERIOD_120_MS * 3), ts, false);
    }
    expect(estimator.periodMs()).toBeLessThan(PERIOD_60_MS);
  });

  test('an opportunistic run cannot re-seed a lock away from the display', () => {
    const estimator = createRefreshRateEstimator();
    const ts = feed(estimator, Array(16).fill(PERIOD_120_MS));
    // Faster than the lock can explain, and residuals it cannot fold: from the
    // render loop this is jitter in when the terminal wanted to paint.
    feed(estimator, Array(12).fill(PERIOD_120_MS * 1.4), ts, false);
    expect(estimator.periodMs()).toBeCloseTo(PERIOD_120_MS, 2);
  });

  test('opportunistic samples alone never leave the default', () => {
    const estimator = createRefreshRateEstimator();
    feed(estimator, Array(16).fill(PERIOD_120_MS), 0, false);
    expect(estimator.periodMs()).toBeCloseTo(PERIOD_60_MS, 5);
    expect(estimator.confidence01()).toBe(0);
  });

  test('opportunistic samples still refine a locked period', () => {
    const estimator = createRefreshRateEstimator();
    // Lock slightly off, then feed exact multiples opportunistically.
    const ts = feed(estimator, Array(12).fill(PERIOD_120_MS + 0.25));
    feed(estimator, Array(24).fill(PERIOD_120_MS * 2), ts, false);
    expect(estimator.periodMs()).toBeCloseTo(PERIOD_120_MS, 1);
  });

  test('drops duplicate timestamps', () => {
    const estimator = createRefreshRateEstimator();
    let ts = 0;
    estimator.sample(ts, true);
    for (let i = 0; i < 12; i += 1) {
      ts += PERIOD_120_MS;
      estimator.sample(ts, true);
      estimator.sample(ts, true);
    }
    expect(estimator.periodMs()).toBeCloseTo(PERIOD_120_MS, 3);
  });
});
