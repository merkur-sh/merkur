import { describe, expect, test } from 'bun:test';

import { createLinkCommandRefresh } from './link-command-refresh';

interface LinkToken {
  readonly command: string;
  readonly expiresAt: number;
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolvePromise: (value: T) => void = () => {};
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: resolvePromise,
  };
}

interface ManualWake {
  cancelled: boolean;
  fire(): void;
}

function createManualScheduler(): {
  readonly wakes: ManualWake[];
  scheduleWake(delayMs: number, wake: () => void): () => void;
} {
  const wakes: ManualWake[] = [];
  return {
    wakes,
    scheduleWake: (_delayMs, callback) => {
      const wake = {
        cancelled: false,
        fire: callback,
      };
      wakes.push(wake);
      return () => {
        wake.cancelled = true;
      };
    },
  };
}

describe('link command refresh ownership', () => {
  test('capacity replaces an old command and schedules only the exact reservation expiry', async () => {
    let now = 10;
    let command = '';
    let used = 0;
    const delays: number[] = [];
    const wakes: Array<() => void> = [];
    const responses = [
      { command: 'first', expiresAt: 100, machineUsage: { used: 2, limit: 3 } },
      { command: null, expiresAt: 200, machineUsage: { used: 3, limit: 3 } },
      { command: 'available', expiresAt: 500, machineUsage: { used: 2, limit: 3 } },
      { command: null, expiresAt: null, machineUsage: { used: 3, limit: 3 } },
    ];
    const refresh = createLinkCommandRefresh({
      refreshMarginMs: 5,
      now: () => now,
      createToken: async () => responses.shift() ?? null,
      onToken: (token) => {
        used = token.machineUsage.used;
      },
      onCommand: (next) => {
        command = next;
      },
      onAutoRefreshError: () => {},
      scheduleWake: (delay, wake) => {
        delays.push(delay);
        wakes.push(wake);
        return () => {};
      },
    });
    await refresh.refresh('token');
    await refresh.refresh('token');
    expect(command).toBe('');
    expect(used).toBe(3);
    expect(delays).toEqual([85, 190]);
    now = 200;
    wakes[1]?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(command).toBe('available');
    expect(used).toBe(2);
    await refresh.refresh('token');
    expect(command).toBe('');
    expect(delays).toHaveLength(3);
    refresh.stop();
  });
  test('an older response cannot replace a newer link command', async () => {
    const oldRequest = deferred<LinkToken | null>();
    const replacementRequest = deferred<LinkToken | null>();
    const scheduler = createManualScheduler();
    let command = '';
    const refresh = createLinkCommandRefresh({
      refreshMarginMs: 0,
      createToken: (token) => (token === 'old' ? oldRequest.promise : replacementRequest.promise),
      onCommand: (next) => {
        command = next;
      },
      onAutoRefreshError: () => {},
      now: () => 0,
      scheduleWake: scheduler.scheduleWake,
    });

    const oldRefresh = refresh.refresh('old');
    const replacementRefresh = refresh.refresh('replacement');
    replacementRequest.resolve({
      command: 'merkur link replacement',
      expiresAt: 60_000,
    });
    await replacementRefresh;
    oldRequest.resolve({
      command: 'merkur link stale',
      expiresAt: 60_000,
    });
    await oldRefresh;

    expect(command).toBe('merkur link replacement');
    refresh.stop();
  });

  test('stop cancels the successor timer installed by an automatic refresh', async () => {
    const scheduler = createManualScheduler();
    let calls = 0;
    let command = '';
    const refresh = createLinkCommandRefresh({
      refreshMarginMs: 0,
      createToken: () => {
        calls += 1;
        return Promise.resolve({
          command: `merkur link automatic-${calls}`,
          expiresAt: 100,
        });
      },
      onCommand: (next) => {
        command = next;
      },
      onAutoRefreshError: () => {},
      now: () => 0,
      scheduleWake: scheduler.scheduleWake,
    });

    await refresh.refresh('token');
    expect(scheduler.wakes).toHaveLength(1);
    scheduler.wakes[0]?.fire();
    await Promise.resolve();
    await Promise.resolve();

    expect(calls).toBe(2);
    expect(command).toBe('merkur link automatic-2');
    expect(scheduler.wakes).toHaveLength(2);
    refresh.stop();
    expect(scheduler.wakes[1]?.cancelled).toBe(true);
    command = '';

    // Cancellation revokes ownership before dispatching interruption. Even if
    // an already-queued host callback still runs, it cannot refresh or clear
    // state owned by a replacement.
    scheduler.wakes[1]?.fire();
    scheduler.wakes[0]?.fire();
    await Promise.resolve();

    expect(calls).toBe(2);
    expect(command).toBe('');
  });

  test('an old command still expires while a manual replacement request is pending', async () => {
    const scheduler = createManualScheduler();
    const pendingRequest = deferred<LinkToken | null>();
    let calls = 0;
    let nowMs = 0;
    let command = '';
    const refresh = createLinkCommandRefresh({
      refreshMarginMs: 0,
      createToken: () => {
        calls += 1;
        if (calls === 1) {
          return Promise.resolve({ command: 'merkur link old', expiresAt: 100 });
        }
        if (calls === 2) {
          return pendingRequest.promise;
        }
        return Promise.resolve({
          command: 'merkur link automatic',
          expiresAt: 200,
        });
      },
      onCommand: (next) => {
        command = next;
      },
      onAutoRefreshError: () => {},
      now: () => nowMs,
      scheduleWake: scheduler.scheduleWake,
    });

    await refresh.refresh('token');
    const pendingRefresh = refresh.refresh('token');
    expect(scheduler.wakes[0]?.cancelled).toBe(false);

    nowMs = 100;
    scheduler.wakes[0]?.fire();
    expect(command).toBe('');
    await Promise.resolve();
    await Promise.resolve();

    expect(command).toBe('merkur link automatic');
    pendingRequest.resolve({ command: 'merkur link stale', expiresAt: 300 });
    expect(await pendingRefresh).toBe(false);
    expect(command).toBe('merkur link automatic');
    refresh.stop();
  });

  test('a failed replacement leaves the old expiry wake responsible for clearing the command', async () => {
    const scheduler = createManualScheduler();
    let calls = 0;
    let command = '';
    const refresh = createLinkCommandRefresh({
      refreshMarginMs: 0,
      createToken: () => {
        calls += 1;
        if (calls === 1) {
          return Promise.resolve({ command: 'merkur link old', expiresAt: 100 });
        }
        if (calls === 2) {
          return Promise.reject(new Error('replacement failed'));
        }
        return new Promise<LinkToken | null>(() => {});
      },
      onCommand: (next) => {
        command = next;
      },
      onAutoRefreshError: () => {},
      now: () => 0,
      scheduleWake: scheduler.scheduleWake,
    });

    await refresh.refresh('token');
    await expect(refresh.refresh('token')).rejects.toThrow('replacement failed');
    expect(command).toBe('merkur link old');
    expect(scheduler.wakes[0]?.cancelled).toBe(false);

    scheduler.wakes[0]?.fire();
    expect(command).toBe('');
    expect(calls).toBe(3);
    refresh.stop();
  });

  test('a cancelled old expiry callback cannot clear a successfully replaced command', async () => {
    const scheduler = createManualScheduler();
    let calls = 0;
    let command = '';
    const refresh = createLinkCommandRefresh({
      refreshMarginMs: 0,
      createToken: () => {
        calls += 1;
        return Promise.resolve({
          command: calls === 1 ? 'merkur link old' : 'merkur link replacement',
          expiresAt: calls === 1 ? 100 : 200,
        });
      },
      onCommand: (next) => {
        command = next;
      },
      onAutoRefreshError: () => {},
      now: () => 0,
      scheduleWake: scheduler.scheduleWake,
    });

    await refresh.refresh('token');
    await refresh.refresh('token');
    expect(scheduler.wakes[0]?.cancelled).toBe(true);
    expect(command).toBe('merkur link replacement');

    scheduler.wakes[0]?.fire();
    await Promise.resolve();
    expect(calls).toBe(2);
    expect(command).toBe('merkur link replacement');
    refresh.stop();
  });

  test('a synchronous expiry callback cannot reinstall its already-fired wake', async () => {
    const automaticRequest = deferred<LinkToken | null>();
    let calls = 0;
    let command = '';
    let cancellations = 0;
    const refresh = createLinkCommandRefresh({
      refreshMarginMs: 0,
      createToken: () => {
        calls += 1;
        if (calls === 1) {
          return Promise.resolve({
            command: 'merkur link transient',
            expiresAt: 100,
          });
        }
        return automaticRequest.promise;
      },
      onCommand: (next) => {
        command = next;
      },
      onAutoRefreshError: () => {},
      now: () => 0,
      scheduleWake: (_delayMs, wake) => {
        wake();
        return () => {
          cancellations += 1;
        };
      },
    });

    expect(await refresh.refresh('token')).toBe(false);
    expect(command).toBe('');
    expect(calls).toBe(2);
    expect(cancellations).toBe(1);

    refresh.stop();
    automaticRequest.resolve(null);
    await Promise.resolve();
  });
});
