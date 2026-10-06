import { describe, expect, test } from 'bun:test';
import { createDisplayOutputSettle, DISPLAY_OUTPUT_SETTLE_MS } from './display-output-settle';

interface Harness {
  readonly settle: ReturnType<typeof createDisplayOutputSettle>;
  readonly changed: () => number;
  readonly settled: () => number;
  readonly armed: () => readonly number[];
  readonly cleared: () => number;
  advanceTo(nowMs: number): void;
  fire(): void;
}

function createHarness(): Harness {
  let nowMs = 0;
  let changed = 0;
  let settled = 0;
  let cleared = 0;
  const armed: number[] = [];
  const callbacks = new Map<number, () => void>();
  let nextHandle = 1;
  const settle = createDisplayOutputSettle<number>({
    onChanged: () => {
      changed += 1;
    },
    onSettled: () => {
      settled += 1;
    },
    now: () => nowMs,
    setTimer(callback, delayMs) {
      const handle = nextHandle;
      nextHandle += 1;
      armed.push(delayMs);
      callbacks.set(handle, callback);
      return handle;
    },
    clearTimer() {
      // Models a browser task already queued at cancellation: the callback is
      // deliberately retained so a cancelled deadline can be fired anyway.
      cleared += 1;
    },
  });
  return {
    settle,
    changed: () => changed,
    settled: () => settled,
    armed: () => armed,
    cleared: () => cleared,
    advanceTo(next) {
      nowMs = next;
    },
    fire() {
      const handle = nextHandle - 1;
      const callback = callbacks.get(handle);
      if (callback === undefined) throw new Error('no armed deadline to fire');
      callback();
    },
  };
}

describe('display output settle', () => {
  test('the first frame of a burst posts changed and arms the deadline once', () => {
    const h = createHarness();
    h.settle.noteFrame();
    expect(h.changed()).toBe(1);
    expect(h.settled()).toBe(0);
    expect(h.armed()).toEqual([DISPLAY_OUTPUT_SETTLE_MS]);
  });

  test('frames inside the window never re-arm and never re-post', () => {
    const h = createHarness();
    h.settle.noteFrame();
    for (let frame = 1; frame <= 64; frame += 1) {
      h.advanceTo(frame * 5);
      h.settle.noteFrame();
    }
    expect(h.changed()).toBe(1);
    expect(h.armed()).toEqual([DISPLAY_OUTPUT_SETTLE_MS]);
    expect(h.cleared()).toBe(0);
  });

  test('an early fire re-arms for exactly the remainder and settles once', () => {
    const h = createHarness();
    h.settle.noteFrame();
    h.advanceTo(200);
    h.settle.noteFrame();
    h.advanceTo(DISPLAY_OUTPUT_SETTLE_MS);
    h.fire();
    // 200 + 350 − 350: the deadline is re-checked, not the frame timer moved.
    expect(h.armed()).toEqual([DISPLAY_OUTPUT_SETTLE_MS, 200]);
    expect(h.settled()).toBe(0);

    h.advanceTo(200 + DISPLAY_OUTPUT_SETTLE_MS);
    h.fire();
    expect(h.settled()).toBe(1);
    expect(h.changed()).toBe(1);
    expect(h.armed()).toEqual([DISPLAY_OUTPUT_SETTLE_MS, 200]);
  });

  test('the frame after a settle opens a new burst', () => {
    const h = createHarness();
    h.settle.noteFrame();
    h.advanceTo(DISPLAY_OUTPUT_SETTLE_MS);
    h.fire();
    expect(h.settled()).toBe(1);

    h.advanceTo(1_000);
    h.settle.noteFrame();
    expect(h.changed()).toBe(2);
    expect(h.armed()).toEqual([DISPLAY_OUTPUT_SETTLE_MS, DISPLAY_OUTPUT_SETTLE_MS]);
  });

  test('reset discards the open burst; a cancelled deadline cannot settle it', () => {
    const h = createHarness();
    h.settle.noteFrame();
    h.settle.reset();
    expect(h.cleared()).toBe(1);
    h.advanceTo(DISPLAY_OUTPUT_SETTLE_MS);
    h.fire();
    expect(h.settled()).toBe(0);

    h.settle.noteFrame();
    expect(h.changed()).toBe(2);
    expect(h.armed()).toEqual([DISPLAY_OUTPUT_SETTLE_MS, DISPLAY_OUTPUT_SETTLE_MS]);
  });
});
