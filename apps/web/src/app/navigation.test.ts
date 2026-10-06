import { describe, expect, test } from 'bun:test';
import { createRoot, flush } from 'solid-js';

import { createNavigation, type Navigation } from './navigation';

/**
 * `createMemo` needs an owner; in the app that owner is the component that
 * calls `createAppController`. Disposing keeps one test's computations from
 * outliving it.
 *
 * Solid 2 makes a write visible to readers only after the queue drains, so
 * every assertion here is preceded by `flush()` — the same "settle now" point
 * the browser reaches on its own microtask.
 */
function withNavigation(run: (nav: Navigation) => void): void {
  createRoot((dispose) => {
    try {
      run(createNavigation());
    } finally {
      dispose();
    }
  });
}

describe('createNavigation', () => {
  test('boots into the bootstrapping phase on the device route', () => {
    withNavigation((nav) => {
      flush();
      expect(nav.phase()).toBe('bootstrapping');
      expect(nav.route()).toEqual({ k: 'devices' });
      expect(nav.connection()).toBe('idle');
    });
  });

  test('enterShell lands on the device list', () => {
    withNavigation((nav) => {
      nav.enterShell();
      flush();
      expect(nav.phase()).toBe('shell');
      expect(nav.route()).toEqual({ k: 'devices' });
    });
  });

  test('push and pop move between routes', () => {
    withNavigation((nav) => {
      nav.enterShell();
      nav.push({ k: 'settings', tab: 'sessions' });
      flush();
      expect(nav.route()).toEqual({ k: 'settings', tab: 'sessions' });
      nav.pop();
      flush();
      expect(nav.route()).toEqual({ k: 'devices' });
    });
  });

  // Tabs are a move within one screen, so the way out of Settings is one press
  // however many tabs were visited on the way.
  test('replace swaps the top route without deepening the stack', () => {
    withNavigation((nav) => {
      nav.enterShell();
      nav.push({ k: 'settings', tab: 'terminal' });
      nav.replace({ k: 'settings', tab: 'account' });
      flush();
      expect(nav.route()).toEqual({ k: 'settings', tab: 'account' });
      nav.pop();
      flush();
      expect(nav.route()).toEqual({ k: 'devices' });
    });
  });

  test('pop never empties the stack', () => {
    withNavigation((nav) => {
      nav.enterShell();
      nav.pop();
      nav.pop();
      flush();
      expect(nav.route()).toEqual({ k: 'devices' });
    });
  });

  test('pop returns to the route beneath, not always the device list', () => {
    withNavigation((nav) => {
      nav.enterShell();
      nav.push({ k: 'terminal', deviceId: 'device-1' });
      nav.push({ k: 'settings', tab: 'terminal' });
      nav.pop();
      flush();
      expect(nav.route()).toEqual({ k: 'terminal', deviceId: 'device-1' });
    });
  });

  // The whole point of the split: a connect attempt in flight is a connection
  // fact, not a screen. The old `CONNECTING` enum member meant both, so the
  // device list had to be derived as `IDLE || CONNECTING`.
  test('a connect attempt does not move the route off the device list', () => {
    withNavigation((nav) => {
      nav.enterShell();
      nav.setConnection('connecting');
      flush();
      expect(nav.route()).toEqual({ k: 'devices' });
      expect(nav.connection()).toBe('connecting');
    });
  });

  test('connection status changes leave the terminal route mounted', () => {
    withNavigation((nav) => {
      nav.enterShell();
      nav.push({ k: 'terminal', deviceId: 'device-1' });
      for (const status of ['signaling', 'connected', 'disconnected'] as const) {
        nav.setConnection(status);
        flush();
        expect(nav.route()).toEqual({ k: 'terminal', deviceId: 'device-1' });
        expect(nav.connection()).toBe(status);
      }
    });
  });

  test('enterAuth discards the route stack and the connection status', () => {
    withNavigation((nav) => {
      nav.enterShell();
      nav.push({ k: 'terminal', deviceId: 'device-1' });
      nav.setConnection('disconnected');

      nav.enterAuth();

      flush();
      expect(nav.phase()).toBe('auth');
      expect(nav.route()).toEqual({ k: 'devices' });
      expect(nav.connection()).toBe('idle');
    });
  });

  test('enterShell clears a stale connection status from the previous session', () => {
    withNavigation((nav) => {
      nav.enterShell();
      nav.push({ k: 'terminal', deviceId: 'device-1' });
      nav.setConnection('disconnected');

      nav.enterShell();

      flush();
      expect(nav.route()).toEqual({ k: 'devices' });
      expect(nav.connection()).toBe('idle');
    });
  });

  // Signing out drops the account only after this settles, so the shell that
  // leaves the screen is the one the user was looking at.
  test('enterAuth settles only once the phase that was showing has departed', async () => {
    let settled = false;
    let leave!: Promise<void>;
    let departed!: () => void;
    withNavigation((nav) => {
      nav.enterShell();
      leave = nav.enterAuth().then(() => {
        settled = true;
      });
      departed = () => nav.departed();
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    departed();
    await leave;
    expect(settled).toBe(true);
  });

  test('enterAuth settles at once when the login screen is already showing', async () => {
    let leave!: Promise<void>;
    withNavigation((nav) => {
      void nav.enterAuth();
      leave = nav.enterAuth();
    });

    await leave;
  });
});
