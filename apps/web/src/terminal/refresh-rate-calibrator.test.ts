import { describe, expect, test } from 'bun:test';
import {
  type CalibratorIo,
  createRefreshRateCalibrator,
  type RefreshRateCalibrator,
} from './refresh-rate-calibrator';
import type { RefreshRateEstimator } from './refresh-rate-estimator';

interface FakeTimer {
  readonly id: number;
  readonly callback: () => void;
  readonly fireAtMs: number;
}

interface Harness {
  calibrator: RefreshRateCalibrator;
  sampled: number[];
  sampledContinuous: boolean[];
  afterSampleCount: { value: number };
  confidence: { value: number };
  pendingFrames: () => number;
  pendingTimers: () => number;
  fireFrame: (deltaMs?: number) => void;
  fireDueTimers: () => void;
  advance: (ms: number) => void;
  frameIds: number[];
  timerIds: number[];
  fireRetainedFrame: (id: number, frameTimeMs?: number) => void;
  fireRetainedTimer: (id: number) => void;
}

function createHarness(): Harness {
  let nowMs = 0;
  const sampled: number[] = [];
  const sampledContinuous: boolean[] = [];
  const afterSampleCount = { value: 0 };
  const confidence = { value: 0 };
  const frames = new Map<number, (ts: number) => void>();
  const retainedFrames = new Map<number, (ts: number) => void>();
  const frameIds: number[] = [];
  let timers: FakeTimer[] = [];
  const retainedTimers = new Map<number, () => void>();
  const timerIds: number[] = [];
  let nextId = 1;

  const estimator: RefreshRateEstimator = {
    sample: (ts, continuous) => {
      sampled.push(ts);
      sampledContinuous.push(continuous);
    },
    periodMs: () => 1000 / 60,
    presentationPeriodMs: () => 1000 / 60,
    confidence01: () => confidence.value,
    nextVsyncAfter: () => null,
    vrr: () => false,
    reset: () => {},
  };

  const io: CalibratorIo = {
    requestFrame: (callback) => {
      const id = nextId;
      nextId += 1;
      frames.set(id, callback);
      retainedFrames.set(id, callback);
      frameIds.push(id);
      return id;
    },
    cancelFrame: (handle) => {
      frames.delete(handle);
    },
    setTimer: (callback, delayMs) => {
      const id = nextId;
      nextId += 1;
      timers.push({ id, callback, fireAtMs: nowMs + delayMs });
      retainedTimers.set(id, callback);
      timerIds.push(id);
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (timer) => {
      timers = timers.filter((entry) => entry.id !== (timer as unknown as number));
    },
    now: () => nowMs,
  };

  return {
    calibrator: createRefreshRateCalibrator(estimator, io, () => {
      afterSampleCount.value += 1;
    }),
    sampled,
    sampledContinuous,
    afterSampleCount,
    confidence,
    pendingFrames: () => frames.size,
    pendingTimers: () => timers.length,
    fireFrame: (deltaMs = 1000 / 120) => {
      const [entry] = frames;
      if (entry === undefined) throw new Error('no pending frame');
      frames.delete(entry[0]);
      nowMs += deltaMs;
      entry[1](nowMs);
    },
    fireDueTimers: () => {
      const due = timers.filter((entry) => entry.fireAtMs <= nowMs);
      timers = timers.filter((entry) => entry.fireAtMs > nowMs);
      for (const entry of due) entry.callback();
    },
    advance: (ms) => {
      nowMs += ms;
    },
    frameIds,
    timerIds,
    fireRetainedFrame: (id, frameTimeMs = nowMs) => retainedFrames.get(id)?.(frameTimeMs),
    fireRetainedTimer: (id) => retainedTimers.get(id)?.(),
  };
}

describe('createRefreshRateCalibrator', () => {
  test('start launches an init burst that ends at convergence', () => {
    const h = createHarness();
    h.calibrator.start();
    expect(h.pendingFrames()).toBe(1);
    for (let i = 0; i < 4; i += 1) h.fireFrame();
    expect(h.pendingFrames()).toBe(1);
    h.confidence.value = 0.95;
    h.fireFrame();
    expect(h.pendingFrames()).toBe(0);
    expect(h.sampled.length).toBe(5);
    // The burst is the estimator's only unbroken rAF chain, so every sample it
    // feeds must claim that provenance — it is what licenses seeding and
    // subharmonic demotion.
    expect(h.sampledContinuous).toEqual([true, true, true, true, true]);
    expect(h.afterSampleCount.value).toBe(5);
  });

  test('a burst caps at its frame budget when never converged', () => {
    const h = createHarness();
    h.calibrator.start();
    let fired = 0;
    while (h.pendingFrames() > 0) {
      h.fireFrame();
      fired += 1;
      if (fired > 100) throw new Error('burst never terminated');
    }
    expect(fired).toBe(36);
  });

  test('concurrent burst requests never create a second chain', () => {
    const h = createHarness();
    h.calibrator.start();
    h.calibrator.requestBurst('resize');
    h.calibrator.requestBurst('dpr');
    expect(h.pendingFrames()).toBe(1);
  });

  test('hidden leaves zero pending frames and timers', () => {
    const h = createHarness();
    h.calibrator.start();
    h.calibrator.setVisible(false);
    expect(h.pendingFrames()).toBe(0);
    expect(h.pendingTimers()).toBe(0);
  });

  test('becoming visible starts a burst and re-arms revalidation', () => {
    const h = createHarness();
    h.calibrator.start();
    h.calibrator.setVisible(false);
    h.advance(5_000);
    h.calibrator.setVisible(true);
    expect(h.pendingFrames()).toBe(1);
    expect(h.pendingTimers()).toBeGreaterThan(0);
  });

  test('revalidation fires a burst every interval while visible', () => {
    const h = createHarness();
    h.calibrator.start();
    h.confidence.value = 0.95;
    h.fireFrame();
    expect(h.pendingFrames()).toBe(0);
    h.advance(60_000);
    h.fireDueTimers();
    expect(h.pendingFrames()).toBe(1);
  });

  test('requests inside the dedupe window after a finished burst are dropped', () => {
    const h = createHarness();
    h.calibrator.start();
    h.confidence.value = 0.95;
    h.fireFrame();
    expect(h.pendingFrames()).toBe(0);
    h.advance(500);
    h.calibrator.requestBurst('resize');
    expect(h.pendingFrames()).toBe(0);
    h.advance(2_000);
    h.calibrator.requestBurst('resize');
    expect(h.pendingFrames()).toBe(1);
  });

  test('the watchdog reclaims a stalled burst', () => {
    const h = createHarness();
    h.calibrator.start();
    expect(h.pendingFrames()).toBe(1);
    h.advance(3_500);
    h.fireDueTimers();
    expect(h.pendingFrames()).toBe(0);
  });

  test('stop cancels everything', () => {
    const h = createHarness();
    h.calibrator.start();
    h.calibrator.stop();
    expect(h.pendingFrames()).toBe(0);
    expect(h.pendingTimers()).toBe(0);
  });

  test('queued cancelled frame/watchdog/revalidation callbacks cannot steal visible replacements', () => {
    const h = createHarness();
    h.calibrator.start();
    const oldFrame = h.frameIds[0];
    const oldWatchdog = h.timerIds[0];
    const oldRevalidation = h.timerIds[1];
    if (oldFrame === undefined || oldWatchdog === undefined || oldRevalidation === undefined) {
      throw new Error('initial calibration callbacks missing');
    }

    h.calibrator.setVisible(false);
    h.calibrator.setVisible(true);
    expect(h.pendingFrames()).toBe(1);
    const replacementTimerCount = h.pendingTimers();

    h.fireRetainedFrame(oldFrame, 123);
    h.fireRetainedTimer(oldWatchdog);
    h.fireRetainedTimer(oldRevalidation);

    expect(h.sampled).toEqual([]);
    expect(h.pendingFrames()).toBe(1);
    expect(h.pendingTimers()).toBe(replacementTimerCount);
  });
});
