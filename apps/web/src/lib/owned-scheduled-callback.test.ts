import { fullGC, heapStats } from 'bun:jsc';
import { describe, expect, test } from 'bun:test';
import {
  createOwnedAnimationFrame,
  createOwnedScheduledCallback,
  createOwnedTimeout,
  yieldToFairTask,
} from './owned-scheduled-callback';

interface RetainedScheduler<Args extends unknown[]> {
  schedule(callback: (...args: Args) => void): number;
  cancel(handle: number): void;
  fire(handle: number, ...args: Args): void;
  /** Handles passed to cancel, in call order. */
  readonly cancelled: number[];
  /** Runs inside the next schedule call, after the handle is chosen. */
  inside: (() => void) | null;
}

function createRetainedScheduler<Args extends unknown[]>(): RetainedScheduler<Args> {
  let nextHandle = 1;
  const callbacks = new Map<number, (...args: Args) => void>();
  const scheduler: RetainedScheduler<Args> = {
    schedule(callback): number {
      const handle = nextHandle;
      nextHandle += 1;
      callbacks.set(handle, callback);
      const inside = scheduler.inside;
      scheduler.inside = null;
      inside?.();
      return handle;
    },
    cancel(handle): void {
      // Deliberately retain the callback: models a browser task that was queued
      // immediately before cancellation and cannot be withdrawn anymore.
      scheduler.cancelled.push(handle);
    },
    fire(handle, ...args): void {
      callbacks.get(handle)?.(...args);
    },
    cancelled: [],
    inside: null,
  };
  return scheduler;
}

/** A timeout or an animation frame slot, driven through one shape. */
interface SlotUnderTest {
  arm(fired: string[], label: string): void;
  cancel(): void;
  isArmed(): boolean;
  /** Delivers the retained callback for `handle`, as the platform would. */
  fire(handle: number): void;
  /** Handles the slot passed to the platform's cancel, in call order. */
  readonly cancelled: number[];
  /** Runs `during` inside the slot's next schedule call. */
  duringNextSchedule(during: () => void): void;
  /** Makes the slot's next schedule call throw `error` instead of scheduling. */
  throwOnNextSchedule(error: Error): void;
}

function ownedTimeoutUnderTest(): SlotUnderTest {
  const scheduler = createRetainedScheduler<[]>();
  let throwNext: Error | null = null;
  const slot = createOwnedTimeout(
    (callback, _delayMs: number) => {
      const error = throwNext;
      throwNext = null;
      if (error !== null) throw error;
      return scheduler.schedule(callback);
    },
    (handle) => scheduler.cancel(handle),
  );
  return {
    arm: (fired, label) => slot.arm(() => fired.push(label), 10),
    cancel: () => slot.cancel(),
    isArmed: () => slot.isArmed(),
    fire: (handle) => scheduler.fire(handle),
    cancelled: scheduler.cancelled,
    duringNextSchedule: (during) => {
      scheduler.inside = during;
    },
    throwOnNextSchedule: (error) => {
      throwNext = error;
    },
  };
}

function ownedAnimationFrameUnderTest(): SlotUnderTest {
  const scheduler = createRetainedScheduler<[frameTimeMs: number]>();
  let throwNext: Error | null = null;
  const slot = createOwnedAnimationFrame(
    (callback) => {
      const error = throwNext;
      throwNext = null;
      if (error !== null) throw error;
      return scheduler.schedule(callback);
    },
    (handle) => scheduler.cancel(handle),
  );
  return {
    arm: (fired, label) => slot.arm((frameTimeMs) => fired.push(`${label}@${frameTimeMs}`)),
    cancel: () => slot.cancel(),
    isArmed: () => slot.isArmed(),
    fire: (handle) => scheduler.fire(handle, 16.5),
    cancelled: scheduler.cancelled,
    duringNextSchedule: (during) => {
      scheduler.inside = during;
    },
    throwOnNextSchedule: (error) => {
      throwNext = error;
    },
  };
}

const SLOTS_UNDER_TEST: ReadonlyArray<[string, () => SlotUnderTest, string]> = [
  ['timeout', ownedTimeoutUnderTest, ''],
  ['animation frame', ownedAnimationFrameUnderTest, '@16.5'],
];

/**
 * Cells allocated per call of `run`, net of the heap snapshot itself. Counts are
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

describe('owned scheduled callback', () => {
  test('a queued cancelled callback cannot consume or fire its replacement', () => {
    const scheduler = createRetainedScheduler<[]>();
    const slot = createOwnedScheduledCallback<number, [], []>(
      (callback) => scheduler.schedule(callback),
      (handle) => scheduler.cancel(handle),
    );
    const fired: string[] = [];

    slot.arm(() => fired.push('old'));
    slot.arm(() => fired.push('replacement'));
    scheduler.fire(1);

    expect(fired).toEqual([]);
    expect(slot.isArmed()).toBe(true);

    scheduler.fire(2);
    expect(fired).toEqual(['replacement']);
    expect(slot.isArmed()).toBe(false);
  });

  test('a callback may re-arm the same slot without being cancelled by its predecessor', () => {
    const scheduler = createRetainedScheduler<[]>();
    const slot = createOwnedTimeout(
      (callback) => scheduler.schedule(callback),
      (handle) => scheduler.cancel(handle),
    );
    const fired: string[] = [];

    slot.arm(() => {
      fired.push('first');
      slot.arm(() => fired.push('second'), 10);
    }, 10);
    scheduler.fire(1);

    expect(fired).toEqual(['first']);
    expect(slot.isArmed()).toBe(true);
    scheduler.fire(2);
    expect(fired).toEqual(['first', 'second']);
  });

  test('publishes synchronous timer and frame schedulers before invoking user code', () => {
    let timerFires = 0;
    const timer = createOwnedTimeout(
      (callback) => {
        callback();
        return 1;
      },
      () => {},
    );
    timer.arm(() => {
      timerFires += 1;
    }, 0);

    let frameTime = 0;
    const frame = createOwnedAnimationFrame(
      (callback) => {
        callback(12.5);
        return 1;
      },
      () => {},
    );
    frame.arm((time) => {
      frameTime = time;
    });

    expect(timerFires).toBe(1);
    expect(timer.isArmed()).toBe(false);
    expect(frameTime).toBe(12.5);
    expect(frame.isArmed()).toBe(false);
  });

  describe.each(SLOTS_UNDER_TEST)('%s', (_name, create, stamp) => {
    test('a queued cancelled callback cannot consume or fire its replacement', () => {
      const slot = create();
      const fired: string[] = [];

      slot.arm(fired, 'old');
      slot.arm(fired, 'replacement');
      expect(slot.cancelled).toEqual([1]);
      slot.fire(1);

      expect(fired).toEqual([]);
      expect(slot.isArmed()).toBe(true);

      slot.fire(2);
      slot.fire(2);
      expect(fired).toEqual([`replacement${stamp}`]);
      expect(slot.isArmed()).toBe(false);
    });

    test('a scheduler that cancels the slot inside schedule leaves the stale arm silent', () => {
      const slot = create();
      const fired: string[] = [];

      slot.duringNextSchedule(() => slot.cancel());
      slot.arm(fired, 'cancelled');
      expect(slot.isArmed()).toBe(false);
      // Handle 1 was never published, so the platform has nothing to cancel.
      expect(slot.cancelled).toEqual([]);
      slot.fire(1);
      expect(fired).toEqual([]);

      // The next arm's cancel reaches its own handle, never the abandoned one.
      slot.arm(fired, 'live');
      slot.cancel();
      expect(slot.cancelled).toEqual([2]);
      slot.fire(1);
      slot.fire(2);
      expect(fired).toEqual([]);
    });

    test('a scheduler that re-arms the slot inside schedule hands it to the inner arm', () => {
      const slot = create();
      const fired: string[] = [];

      // The outer arm takes handle 1; the inner arm, armed while that schedule
      // call is still running, takes handle 2 and owns the slot afterwards.
      slot.duringNextSchedule(() => slot.arm(fired, 'inner'));
      slot.arm(fired, 'outer');
      expect(slot.isArmed()).toBe(true);
      expect(slot.cancelled).toEqual([]);
      slot.cancel();
      expect(slot.cancelled).toEqual([2]);
      slot.fire(1);
      slot.fire(2);
      expect(fired).toEqual([]);

      slot.duringNextSchedule(() => slot.arm(fired, 'inner'));
      slot.arm(fired, 'outer');
      slot.fire(3);
      expect(fired).toEqual([]);
      expect(slot.isArmed()).toBe(true);
      slot.fire(4);
      expect(fired).toEqual([`inner${stamp}`]);
      expect(slot.isArmed()).toBe(false);
    });

    test('a throwing scheduler leaves the slot disarmed and propagates the error', () => {
      const slot = create();
      const fired: string[] = [];

      slot.arm(fired, 'first');
      slot.throwOnNextSchedule(new Error('scheduler refused'));
      expect(() => slot.arm(fired, 'refused')).toThrow('scheduler refused');
      expect(slot.isArmed()).toBe(false);
      // The refused arm cancelled its predecessor and published nothing of its own.
      expect(slot.cancelled).toEqual([1]);
      slot.cancel();
      expect(slot.cancelled).toEqual([1]);
      slot.fire(1);
      expect(fired).toEqual([]);

      slot.arm(fired, 'after');
      slot.fire(2);
      expect(fired).toEqual([`after${stamp}`]);
    });
  });

  test('an arm allocates one cell, the scheduled function, whether it fires or is re-armed', () => {
    let pendingTimer: (() => void) | null = null;
    let pendingFrame: ((frameTimeMs: number) => void) | null = null;
    let fired = 0;
    const onTimer = (): void => {
      fired += 1;
    };
    const onFrame = (frameTimeMs: number): void => {
      fired += frameTimeMs;
    };
    const timeout = createOwnedTimeout(
      (callback, _delayMs: number) => {
        pendingTimer = callback;
        return 1;
      },
      () => {
        pendingTimer = null;
      },
    );
    const frame = createOwnedAnimationFrame(
      (callback) => {
        pendingFrame = callback;
        return 1;
      },
      () => {
        pendingFrame = null;
      },
    );
    const timeoutFire = (ops: number): void => {
      for (let op = 0; op < ops; op += 1) {
        timeout.arm(onTimer, 4);
        const deliver = pendingTimer;
        pendingTimer = null;
        deliver?.();
      }
    };
    const frameFire = (ops: number): void => {
      for (let op = 0; op < ops; op += 1) {
        frame.arm(onFrame);
        const deliver = pendingFrame;
        pendingFrame = null;
        deliver?.(1);
      }
    };
    const timeoutRearm = (ops: number): void => {
      for (let op = 0; op < ops; op += 1) {
        timeout.cancel();
        timeout.arm(onTimer, 4);
      }
    };

    // A per-arm owner record, rest/spread argument arrays and captured
    // environments cost 5 to 10 cells per cycle here; the slot needs only the
    // function it hands the platform.
    expect(cellsPerOp(timeoutFire, 256)).toBeLessThan(2);
    expect(cellsPerOp(frameFire, 256)).toBeLessThan(2);
    expect(cellsPerOp(timeoutRearm, 256)).toBeLessThan(2);
    expect(fired).toBeGreaterThan(0);
  });
});

describe('fair yield', () => {
  test('resolves on a macrotask turn, FIFO, one port hop and one zero timer per yield', async () => {
    const originalPostMessage = MessagePort.prototype.postMessage;
    const originalSetTimeout = globalThis.setTimeout;
    const posted: unknown[] = [];
    const armedDelays: Array<number | undefined> = [];
    MessagePort.prototype.postMessage = function spiedPostMessage(
      this: MessagePort,
      ...args: Parameters<typeof originalPostMessage>
    ) {
      posted.push(args[0]);
      return originalPostMessage.apply(this, args);
    } as typeof originalPostMessage;
    globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      armedDelays.push(timeout);
      return originalSetTimeout(handler, timeout, ...args);
    }) as typeof setTimeout;
    try {
      const order: string[] = [];
      const first = yieldToFairTask().then(() => order.push('first'));
      const second = yieldToFairTask().then(() => order.push('second'));
      const third = yieldToFairTask().then(() => order.push('third'));
      // A microtask queued after the yields runs before any of them: the
      // yield is a real task boundary, not a promise tick.
      await Promise.resolve().then(() => order.push('microtask'));
      expect(order).toEqual(['microtask']);

      await Promise.all([first, second, third]);
      expect(order).toEqual(['microtask', 'first', 'second', 'third']);
      // The caller never arms a timer itself: each yield is one message on the
      // port, and the port handler arms exactly one setTimeout(0) for it.
      expect(posted).toEqual([0, 0, 0]);
      expect(armedDelays).toEqual([0, 0, 0]);
    } finally {
      MessagePort.prototype.postMessage = originalPostMessage;
      globalThis.setTimeout = originalSetTimeout;
    }
  });
});
