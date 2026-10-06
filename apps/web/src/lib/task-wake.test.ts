import { describe, expect, jest, test } from 'bun:test';
import { createTaskWake } from './task-wake';

describe('task wake', () => {
  test('resolves a parked consumer from a later task edge', async () => {
    const wake = createTaskWake();
    const wait = wake.wait(60_000);

    wake.wake();

    await expect(wait).resolves.toBeUndefined();
  });

  test('latches a task edge that arrives before the consumer parks', async () => {
    const wake = createTaskWake();
    wake.wake();

    await expect(wake.wait(60_000)).resolves.toBeUndefined();
  });

  test('coalesces duplicate task edges into one pending wake', async () => {
    const wake = createTaskWake();
    wake.wake();
    wake.wake();

    await wake.wait(60_000);
    const next = wake.wait(60_000);
    const early = await Promise.race([
      next.then(() => 'settled'),
      new Promise<'parked'>((resolve) => setTimeout(() => resolve('parked'), 5)),
    ]);
    expect(early).toBe('parked');
    wake.wake();
    await expect(next).resolves.toBeUndefined();
  });

  test('an old watchdog cannot settle a successor waiter', async () => {
    // Virtual time: the old watchdog fires inside the successor's window however loaded the
    // host is; on a stalled real clock it can fire past the successor's own deadline.
    jest.useFakeTimers();
    try {
      const wake = createTaskWake();
      const first = wake.wait(1);
      wake.wake();
      await first;

      let settled = false;
      const second = wake.wait(20).then(() => {
        settled = true;
      });
      jest.advanceTimersByTime(19);
      await new Promise((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      wake.wake();
      await second;
      expect(settled).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  test('dispose releases a parked consumer and makes later waits inert', async () => {
    const wake = createTaskWake();
    const wait = wake.wait(60_000);

    wake.dispose();

    await expect(wait).resolves.toBeUndefined();
    await expect(wake.wait(60_000)).resolves.toBeUndefined();
  });

  test('five park/wake cycles arm one watchdog and cancel none', async () => {
    // The watchdog is a lifetime timer, not a per-park one: a park arms it only
    // when it is not running, and a wake never clears it. Counted through the
    // globals the module reaches for, delegating to the real timers.
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    let armed = 0;
    let cleared = 0;
    globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      armed += 1;
      return originalSetTimeout(handler, timeout, ...args);
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((id?: Parameters<typeof clearTimeout>[0]) => {
      cleared += 1;
      originalClearTimeout(id);
    }) as typeof clearTimeout;
    try {
      const wake = createTaskWake();
      for (let cycle = 0; cycle < 5; cycle += 1) {
        const wait = wake.wait(60_000);
        wake.wake();
        await wait;
      }
      expect(armed).toBe(1);
      expect(cleared).toBe(0);
      wake.dispose();
      expect(cleared).toBe(1);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  });
});
