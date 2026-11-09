import { afterEach, beforeEach, describe, expect, jest, mock, test } from 'bun:test';
import { createWakeDetector, type WakeDetector } from './wake-detector';

const TICK_MS = 5;
const JUMP_MS = 50;

let detector: WakeDetector | null = null;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(0);
});

afterEach(() => {
  detector?.destroy();
  detector = null;
  jest.useRealTimers();
});

/**
 * Fires the next interval tick `ms` of wall clock after the previous one. The
 * clock jumps without firing timers, as it does across a suspension, and the
 * scheduled tick then lands.
 */
function advanceClock(ms: number): void {
  jest.setSystemTime(Date.now() + ms - TICK_MS);
  jest.advanceTimersByTime(TICK_MS);
}

describe('wake detector', () => {
  test('does not fire on normal tick cadence', () => {
    const onWake = mock(() => undefined);
    detector = createWakeDetector(onWake, { tickMs: TICK_MS, jumpThresholdMs: JUMP_MS });

    for (let index = 0; index < 6; index++) advanceClock(TICK_MS);
    expect(onWake).not.toHaveBeenCalled();
  });

  test('fires when a tick observes a clock jump beyond the threshold', () => {
    const onWake = mock(() => undefined);
    detector = createWakeDetector(onWake, { tickMs: TICK_MS, jumpThresholdMs: JUMP_MS });

    advanceClock(TICK_MS);
    advanceClock(JUMP_MS * 20);
    advanceClock(TICK_MS);
    expect(onWake).toHaveBeenCalledTimes(1);
  });

  test('skips the jump when the document is hidden', () => {
    const onWake = mock(() => undefined);
    detector = createWakeDetector(onWake, {
      tickMs: TICK_MS,
      jumpThresholdMs: JUMP_MS,
      isHidden: () => true,
    });

    advanceClock(TICK_MS);
    advanceClock(JUMP_MS * 20);
    advanceClock(TICK_MS);
    expect(onWake).not.toHaveBeenCalled();
  });

  test('destroy stops the interval', () => {
    const onWake = mock(() => undefined);
    detector = createWakeDetector(onWake, { tickMs: TICK_MS, jumpThresholdMs: JUMP_MS });

    detector.destroy();
    detector = null;
    advanceClock(JUMP_MS * 20);
    expect(onWake).not.toHaveBeenCalled();
  });
});
