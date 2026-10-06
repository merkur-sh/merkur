import { afterEach, describe, expect, mock, test } from 'bun:test';
import { createWakeDetector, type WakeDetector } from './wake-detector';

const TICK_MS = 5;
const JUMP_MS = 50;

const realDateNow = Date.now;
let detector: WakeDetector | null = null;

afterEach(() => {
  Date.now = realDateNow;
  detector?.destroy();
  detector = null;
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Make Date.now report `offsetMs` ahead of the real clock. */
function jumpClock(offsetMs: number): void {
  Date.now = () => realDateNow() + offsetMs;
}

describe('wake detector', () => {
  test('does not fire on normal tick cadence', async () => {
    const onWake = mock(() => undefined);
    detector = createWakeDetector(onWake, { tickMs: TICK_MS, jumpThresholdMs: JUMP_MS });

    await sleep(TICK_MS * 6);
    expect(onWake).not.toHaveBeenCalled();
  });

  test('fires when a tick observes a clock jump beyond the threshold', async () => {
    const onWake = mock(() => undefined);
    detector = createWakeDetector(onWake, { tickMs: TICK_MS, jumpThresholdMs: JUMP_MS });

    await sleep(TICK_MS * 3);
    jumpClock(JUMP_MS * 20);
    await sleep(TICK_MS * 4);
    expect(onWake.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  test('skips the jump when the document is hidden', async () => {
    const onWake = mock(() => undefined);
    detector = createWakeDetector(onWake, {
      tickMs: TICK_MS,
      jumpThresholdMs: JUMP_MS,
      isHidden: () => true,
    });

    await sleep(TICK_MS * 3);
    jumpClock(JUMP_MS * 20);
    await sleep(TICK_MS * 4);
    expect(onWake).not.toHaveBeenCalled();
  });

  test('destroy stops the interval', async () => {
    const onWake = mock(() => undefined);
    detector = createWakeDetector(onWake, { tickMs: TICK_MS, jumpThresholdMs: JUMP_MS });

    detector.destroy();
    detector = null;
    jumpClock(JUMP_MS * 20);
    await sleep(TICK_MS * 4);
    expect(onWake).not.toHaveBeenCalled();
  });
});
