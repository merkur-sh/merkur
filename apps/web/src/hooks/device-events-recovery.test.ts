import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  DEVICE_EVENTS_RECONNECT_BASE_MS,
  DEVICE_EVENTS_RECONNECT_CEIL_MS,
} from '@merkur/config/retry-schedules';
import { DEVICE_EVENTS_SINCE_HEADER, type Device } from '@merkur/shared';
import { Duration, Effect, Schedule } from 'effect';
import * as AsyncResult from 'effect/reactivity/AsyncResult';
import * as AtomRegistry from 'effect/reactivity/AtomRegistry';
import { ApiError } from '../lib/api-error';
import { EventStreamHttpError } from '../lib/authenticated-transport';
import type { NetworkChangeEvent } from '../session/network-monitor';
import type { DeviceEventsIo } from './device-events-atoms';
import {
  createDeviceEventsReconnectSchedule,
  deviceEventsReconnectDelayMs,
  shouldForceResumeReconnect,
} from './device-events-reconnect';

const RESUME_STALE_HIDDEN_MS = 5_000;

interface MockStreamOptions {
  readonly signal: AbortSignal;
  readonly headers?: Readonly<Record<string, string>>;
  readonly onOpen?: () => void;
  readonly onEvent: (event: { readonly event: string; readonly data: string }) => void;
  readonly onActivity?: () => void;
}

const refreshAccessTokenMock = mock<() => Promise<{ readonly accessToken: string | null } | null>>(
  () => Promise.resolve({ accessToken: 'replacement-token' }),
);

const openAuthenticatedEventStreamMock = mock(
  (_token: string, _path: string, _options: MockStreamOptions): Promise<void> =>
    Promise.reject(new Error('stream failed')),
);

const network: {
  publishChange: ((kind: NetworkChangeEvent['kind']) => void) | null;
} = { publishChange: null };

function createFakeEventTarget() {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  return {
    addEventListener(type: string, listener: (event: unknown) => void): void {
      const existing = listeners.get(type) ?? new Set<(event: unknown) => void>();
      existing.add(listener);
      listeners.set(type, existing);
    },
    removeEventListener(type: string, listener: (event: unknown) => void): void {
      listeners.get(type)?.delete(listener);
    },
    dispatch(type: string, event: unknown): void {
      for (const listener of [...(listeners.get(type) ?? [])]) listener(event);
    },
  };
}

const fakeWindow = createFakeEventTarget();
const fakeDocument = { ...createFakeEventTarget(), visibilityState: 'visible' };

// `api.ts` reads `location.origin` while it is being evaluated, and the
// recovery loop attaches resume listeners to `document`/`window`. Install both
// before the modules under test are loaded, then import them dynamically.
if (typeof globalThis.location === 'undefined') {
  Object.defineProperty(globalThis, 'location', {
    value: { origin: 'http://localhost' },
    configurable: true,
  });
}
// `writable` matters as much as `configurable`: without it these globals become
// readonly, and other suites in the same shard install their own fakes with
// plain assignment, which throws in strict-mode ESM. Omitting it made those
// suites fail purely on shard ordering.
Object.defineProperty(globalThis, 'document', {
  value: fakeDocument,
  configurable: true,
  writable: true,
});
Object.defineProperty(globalThis, 'window', {
  value: fakeWindow,
  configurable: true,
  writable: true,
});

const {
  browserPresenceAtom,
  browserSessionsChangedAtom,
  deviceEventsAttemptsAtom,
  deviceEventsErrorAtom,
  deviceEventsIoAtom,
  deviceEventsRejectedTokenAtom,
  deviceEventsRotatedTokenAtom,
  deviceEventsStreamFailureAtom,
  deviceListStatusAtom,
  deviceEventsBootAtom,
  deviceCursorAtom,
  deviceUserIdAtom,
  devicesAtom,
  hasDeviceSnapshotAtom,
  publishDeviceEventsError,
  startDeviceEvents,
  stopDeviceEvents,
} = await import('./device-events-atoms');
const { deviceEventsAtom } = await import('./device-events-recovery');

const validDevice: Device = {
  id: 'device-1',
  userId: 'user-1',
  name: 'Workstation',
  platform: 'linux',
  status: 'online',
  lastSeen: 1,
  version: '1.0.0',
  identitySealBackend: 'software',
};

const USER_ID = 'user-1';

const EPOCH = 'a1b2c3d4e5f60718';

function snapshotEvent(devices: readonly Device[], seq = 1): { event: string; data: string } {
  return { event: 'snapshot', data: JSON.stringify({ epoch: EPOCH, seq, devices }) };
}

function resumeEvent(seq: number, epoch = EPOCH): { event: string; data: string } {
  return { event: 'resume', data: JSON.stringify({ epoch, seq }) };
}

function deltaEvent(seq: number, status: Device['status']): { event: string; data: string } {
  return {
    event: 'delta',
    data: JSON.stringify({ seq, kind: 'presence', daemonId: validDevice.id, status }),
  };
}

const activeHarnesses: Array<() => void> = [];

function createHarness(overrides: Partial<DeviceEventsIo> = {}): AtomRegistry.AtomRegistry {
  const registry = AtomRegistry.make();
  registry.set(deviceEventsIoAtom, {
    openEventStream: openAuthenticatedEventStreamMock,
    refreshAuthentication: refreshAccessTokenMock,
    createNetworkMonitor: (listener) => {
      network.publishChange = (kind) => listener({ kind });
      return { destroy: () => {} };
    },
    isNetworkOffline: () => false,
    reconnectRandom: () => 1,
    // Long enough that only a test that asks for the deadline observes it.
    firstSnapshotTimeout: '30 seconds',
    stallTimeout: '30 seconds',
    ...overrides,
  });
  const unmount = registry.mount(deviceEventsAtom);
  activeHarnesses.push(() => {
    stopDeviceEvents(registry);
    unmount();
    registry.dispose();
  });
  return registry;
}

/** Start a lifetime without caring whether teardown later rejects its wait. */
function start(registry: AtomRegistry.AtomRegistry, token: string): Promise<void> {
  const wait = startDeviceEvents(registry, token, USER_ID);
  void wait.catch(() => undefined);
  return wait;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function streamTokens(): string[] {
  return openAuthenticatedEventStreamMock.mock.calls.map((call) => call[0]);
}

async function waitForCalls(count: number, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now();
  while (openAuthenticatedEventStreamMock.mock.calls.length < count) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(
        `expected ${count} stream calls, saw ${openAuthenticatedEventStreamMock.mock.calls.length}`,
      );
    }
    await sleep(5);
  }
}

async function waitForCondition(condition: () => boolean, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt >= timeoutMs) throw new Error('condition timed out');
    await sleep(5);
  }
}

function capturingStream(
  captured: MockStreamOptions[],
): (token: string, path: string, options: MockStreamOptions) => Promise<void> {
  return (_token, _path, options) => {
    captured.push(options);
    return new Promise<void>(() => {});
  };
}

beforeEach(() => {
  refreshAccessTokenMock.mockClear();
  openAuthenticatedEventStreamMock.mockClear();
  network.publishChange = null;
  fakeDocument.visibilityState = 'visible';
  refreshAccessTokenMock.mockImplementation(() =>
    Promise.resolve({ accessToken: 'replacement-token' }),
  );
  openAuthenticatedEventStreamMock.mockImplementation((_token, _path, _options) =>
    Promise.reject(new Error('stream failed')),
  );
});

afterEach(() => {
  for (const dispose of activeHarnesses.splice(0, activeHarnesses.length)) dispose();
});

test('browser presence updates over the existing stream and becomes unconfirmed on disconnect', async () => {
  const streams: MockStreamOptions[] = [];
  openAuthenticatedEventStreamMock.mockImplementation(capturingStream(streams));
  const registry = createHarness();
  const started = start(registry, 'current-token');
  await waitForCalls(1);
  const stream = streams[0];
  if (stream === undefined) throw new Error('stream missing');
  stream.onOpen?.();
  stream.onEvent(snapshotEvent([validDevice]));
  await started;
  expect(registry.get(browserPresenceAtom)).toBeNull();
  stream.onEvent({
    event: 'browser-presence',
    data: JSON.stringify({ activeDelegationIds: ['one', 'two'] }),
  });
  await waitForCondition(() => registry.get(browserPresenceAtom)?.length === 2);
  stream.onEvent({
    event: 'browser-presence',
    data: JSON.stringify({ activeDelegationIds: ['one'] }),
  });
  await waitForCondition(() => registry.get(browserPresenceAtom)?.length === 1);
  expect(openAuthenticatedEventStreamMock.mock.calls.length).toBe(1);
  const cursor = registry.get(deviceCursorAtom);
  stream.onEvent({
    event: 'browser-presence',
    data: JSON.stringify({ activeDelegationIds: ['one', 2] }),
  });
  await sleep(5);
  expect(registry.get(browserPresenceAtom)).toEqual(['one']);
  expect(registry.get(deviceCursorAtom)).toEqual(cursor);
  stopDeviceEvents(registry);
  expect(registry.get(browserPresenceAtom)).toBeNull();
});

describe('device events reconnect timing', () => {
  test('uses the configured base as the first full-jitter ceiling', () => {
    expect(deviceEventsReconnectDelayMs(1, () => 1)).toBe(DEVICE_EVENTS_RECONNECT_BASE_MS);
    expect(deviceEventsReconnectDelayMs(1, () => 0)).toBe(0);
    expect(deviceEventsReconnectDelayMs(1, () => 0.5)).toBe(DEVICE_EVENTS_RECONNECT_BASE_MS / 2);
  });

  test('backs off exponentially, remains capped, and bounds hostile entropy', () => {
    expect(deviceEventsReconnectDelayMs(2, () => 1)).toBe(DEVICE_EVENTS_RECONNECT_BASE_MS * 2);
    expect(deviceEventsReconnectDelayMs(6, () => 1)).toBe(DEVICE_EVENTS_RECONNECT_CEIL_MS);
    expect(deviceEventsReconnectDelayMs(10_000, () => 1)).toBe(DEVICE_EVENTS_RECONNECT_CEIL_MS);
    expect(deviceEventsReconnectDelayMs(2, () => -10)).toBe(0);
    expect(deviceEventsReconnectDelayMs(2, () => 10)).toBe(DEVICE_EVENTS_RECONNECT_BASE_MS * 2);
  });

  test('defensively treats invalid low attempts as the first attempt', () => {
    expect(deviceEventsReconnectDelayMs(0, () => 1)).toBe(DEVICE_EVENTS_RECONNECT_BASE_MS);
    expect(deviceEventsReconnectDelayMs(-1, () => 1)).toBe(DEVICE_EVENTS_RECONNECT_BASE_MS);
  });

  test('resume reconnect dedupe accepts the first event at monotonic time zero', () => {
    expect(shouldForceResumeReconnect(0, null)).toBe(true);
    expect(shouldForceResumeReconnect(999, 0)).toBe(false);
    expect(shouldForceResumeReconnect(1_000, 0)).toBe(true);
  });

  test('the reconnect schedule retries immediately once, then backs off to the ceiling', async () => {
    const delays = await Effect.runPromise(
      Effect.gen(function* () {
        const step = yield* Schedule.toStep(createDeviceEventsReconnectSchedule(() => 1));
        const observed: number[] = [];
        for (let index = 0; index < 8; index += 1) {
          const [, delay] = yield* Effect.orDie(step(0, undefined));
          observed.push(Duration.toMillis(delay));
        }
        return observed;
      }),
    );

    expect(delays.slice(0, 4)).toEqual([
      0,
      DEVICE_EVENTS_RECONNECT_BASE_MS,
      DEVICE_EVENTS_RECONNECT_BASE_MS * 2,
      DEVICE_EVENTS_RECONNECT_BASE_MS * 4,
    ]);
    expect(delays.at(-1)).toBe(DEVICE_EVENTS_RECONNECT_CEIL_MS);
  });
});

describe('device events recovery loop', () => {
  test('a cancelled retry cannot release or outlive its replacement retry', async () => {
    openAuthenticatedEventStreamMock.mockImplementation((token) =>
      token === 'old-token'
        ? Promise.reject(new Error('stream failed'))
        : new Promise<void>(() => {}),
    );
    const registry = createHarness();

    void start(registry, 'old-token');
    // First failure is retried immediately; the second owns the 250 ms
    // fallback deadline.
    await waitForCalls(2);

    // Explicit replacement interrupts that deadline and installs one stream.
    void start(registry, 'new-token');
    await waitForCalls(3);
    await sleep(DEVICE_EVENTS_RECONNECT_BASE_MS + 120);

    expect(openAuthenticatedEventStreamMock).toHaveBeenCalledTimes(3);
    expect(streamTokens()).toEqual(['old-token', 'old-token', 'new-token']);
  });

  test('EOF/network recovery immediately reuses the current token without a refresh RTT', async () => {
    openAuthenticatedEventStreamMock.mockImplementationOnce(() =>
      Promise.reject(new Error('connection reset')),
    );
    openAuthenticatedEventStreamMock.mockImplementationOnce(() => new Promise<void>(() => {}));
    const registry = createHarness();

    void start(registry, 'current-token');
    await waitForCalls(2);

    expect(streamTokens()).toEqual(['current-token', 'current-token']);
    expect(refreshAccessTokenMock).not.toHaveBeenCalled();
  });

  test('a clean end of body reconnects on the fallback schedule without an error', async () => {
    openAuthenticatedEventStreamMock.mockImplementationOnce(() => Promise.resolve());
    openAuthenticatedEventStreamMock.mockImplementationOnce(() => new Promise<void>(() => {}));
    const registry = createHarness();

    void start(registry, 'current-token');
    await waitForCalls(2);

    expect(registry.get(deviceEventsErrorAtom)).toBe('');
    expect(registry.get(deviceListStatusAtom)).not.toBe('offline');
  });

  test('a clean end of body retires the badge that vouched for the list', async () => {
    const streams: MockStreamOptions[] = [];
    const firstStreamEnd: { resolve: () => void } = { resolve: () => {} };
    openAuthenticatedEventStreamMock.mockImplementation((_token, _path, options) => {
      streams.push(options);
      if (streams.length > 1) return new Promise<void>(() => {});
      return new Promise<void>((resolve) => {
        firstStreamEnd.resolve = resolve;
      });
    });
    const registry = createHarness();

    void start(registry, 'current-token');
    await waitForCalls(1);
    streams[0]?.onOpen?.();
    streams[0]?.onEvent(snapshotEvent([validDevice]));
    await waitForCondition(() => registry.get(deviceListStatusAtom) === 'live');

    firstStreamEnd.resolve();

    // No error — a server that closed the body cleanly is not a fault — but the
    // list is no longer being confirmed by anything, and the badge says so.
    await waitForCondition(() => registry.get(deviceListStatusAtom) === 'refreshing');
    expect(registry.get(deviceEventsErrorAtom)).toBe('');
    expect(registry.get(devicesAtom)).toHaveLength(1);
  });

  test('a session-ended event ends the lifetime without refreshing or reconnecting', async () => {
    const streams: MockStreamOptions[] = [];
    openAuthenticatedEventStreamMock.mockImplementation(capturingStream(streams));
    const registry = createHarness();
    void start(registry, 'revoked-token');
    await waitForCalls(1);
    streams[0]?.onEvent({ event: 'browser-session-ended', data: '{}' });
    await sleep(5);
    expect(registry.get(deviceEventsRejectedTokenAtom)).toBeNull();
    streams[0]?.onEvent({ event: 'browser-session-ended', data: 'null' });
    await waitForCondition(() => registry.get(deviceEventsRejectedTokenAtom) === 'revoked-token');
    expect(streams[0]?.signal.aborted).toBe(true);
    expect(refreshAccessTokenMock).not.toHaveBeenCalled();
    expect(registry.get(deviceEventsStreamFailureAtom)).toBeNull();
    network.publishChange?.('online');
    await sleep(30);
    expect(streamTokens()).toEqual(['revoked-token']);
  });

  test('a sessions-changed event counts up and leaves the stream open', async () => {
    const streams: MockStreamOptions[] = [];
    openAuthenticatedEventStreamMock.mockImplementation(capturingStream(streams));
    const registry = createHarness();
    void start(registry, 'token');
    await waitForCalls(1);
    streams[0]?.onEvent({ event: 'browser-sessions-changed', data: '{}' });
    await sleep(5);
    expect(registry.get(browserSessionsChangedAtom)).toBe(0);
    streams[0]?.onEvent({ event: 'browser-sessions-changed', data: 'null' });
    streams[0]?.onEvent({ event: 'browser-sessions-changed', data: 'null' });
    await waitForCondition(() => registry.get(browserSessionsChangedAtom) === 2);
    expect(streams[0]?.signal.aborted).toBe(false);
    expect(registry.get(deviceEventsRejectedTokenAtom)).toBeNull();
  });

  test('a definitive 401 refreshes exactly once and reconnects with the replacement token', async () => {
    openAuthenticatedEventStreamMock.mockImplementationOnce(() =>
      Promise.reject(new EventStreamHttpError(401)),
    );
    openAuthenticatedEventStreamMock.mockImplementationOnce(() => new Promise<void>(() => {}));
    const registry = createHarness();

    void start(registry, 'expired-token');
    await waitForCalls(2);

    expect(refreshAccessTokenMock).toHaveBeenCalledTimes(1);
    expect(registry.get(deviceEventsRotatedTokenAtom)).toBe('replacement-token');
    expect(streamTokens()).toEqual(['expired-token', 'replacement-token']);
    // A 401 is an answer, and rotating past it is this loop working. Reporting
    // it as a request nobody answered would drown the signal that matters in
    // the ordinary lifecycle of an expiring credential.
    expect(registry.get(deviceEventsStreamFailureAtom)).toBeNull();
  });

  test('a replacement-token 401 ends the session without repeating refresh', async () => {
    openAuthenticatedEventStreamMock.mockImplementation(() =>
      Promise.reject(new EventStreamHttpError(401)),
    );
    const registry = createHarness();

    void start(registry, 'expired-token');
    await waitForCalls(2);
    await waitForCondition(() => registry.get(deviceEventsRejectedTokenAtom) === 'expired-token');
    network.publishChange?.('online');
    await sleep(30);

    expect(refreshAccessTokenMock).toHaveBeenCalledTimes(1);
    expect(streamTokens()).toEqual(['expired-token', 'replacement-token']);
  });

  test('a rejected refresh ends the session, while network errors remain recoverable', async () => {
    refreshAccessTokenMock.mockImplementationOnce(() => Promise.reject(new TypeError('offline')));
    refreshAccessTokenMock.mockImplementationOnce(() =>
      Promise.reject(new ApiError(401, 'invalid_refresh_token')),
    );
    openAuthenticatedEventStreamMock.mockImplementation(() =>
      Promise.reject(new EventStreamHttpError(401)),
    );
    const registry = createHarness();
    void start(registry, 'revoked-token');
    await waitForCondition(() =>
      registry.get(deviceEventsErrorAtom).includes('Session refresh failed'),
    );
    expect(registry.get(deviceEventsRejectedTokenAtom)).toBeNull();

    network.publishChange?.('online');
    await waitForCondition(() => registry.get(deviceEventsRejectedTokenAtom) === 'revoked-token');
    network.publishChange?.('online');
    await sleep(30);
    expect(refreshAccessTokenMock).toHaveBeenCalledTimes(2);
    expect(streamTokens()).toEqual(['revoked-token', 'revoked-token']);

    openAuthenticatedEventStreamMock.mockImplementation(() => new Promise<void>(() => {}));
    void start(registry, 'new-login-token');
    await waitForCalls(3);
    expect(registry.get(deviceEventsRejectedTokenAtom)).toBeNull();
  });

  test('an online edge rearms one refresh after a null result and coalesces event bursts', async () => {
    refreshAccessTokenMock
      .mockImplementationOnce(() => Promise.resolve(null))
      .mockImplementationOnce(() => Promise.resolve({ accessToken: 'recovered-token' }));
    openAuthenticatedEventStreamMock
      .mockImplementationOnce(() => Promise.reject(new EventStreamHttpError(401)))
      .mockImplementationOnce(() => Promise.reject(new EventStreamHttpError(401)))
      .mockImplementationOnce(() => new Promise<void>(() => {}));
    const registry = createHarness();

    void start(registry, 'expired-token');
    await waitForCondition(
      () =>
        refreshAccessTokenMock.mock.calls.length === 1 &&
        registry.get(deviceEventsErrorAtom).includes('Session refresh failed'),
    );

    network.publishChange?.('online');
    network.publishChange?.('online');
    await waitForCalls(3);
    await sleep(30);

    expect(refreshAccessTokenMock).toHaveBeenCalledTimes(2);
    expect(streamTokens()).toEqual(['expired-token', 'expired-token', 'recovered-token']);
  });

  test('a failed-refresh latch consumes one recovery edge inside the resume dedupe window', async () => {
    refreshAccessTokenMock
      .mockImplementationOnce(() => Promise.resolve(null))
      .mockImplementationOnce(() => Promise.resolve({ accessToken: 'recovered-token' }));
    openAuthenticatedEventStreamMock
      .mockImplementationOnce(() => new Promise<void>(() => {}))
      .mockImplementationOnce(() => Promise.reject(new EventStreamHttpError(401)))
      .mockImplementationOnce(() => Promise.reject(new EventStreamHttpError(401)))
      .mockImplementationOnce(() => new Promise<void>(() => {}));
    const registry = createHarness();

    void start(registry, 'expired-token');
    await waitForCalls(1);
    network.publishChange?.('online');
    await waitForCondition(
      () =>
        refreshAccessTokenMock.mock.calls.length === 1 &&
        registry.get(deviceEventsErrorAtom).includes('Session refresh failed'),
    );

    // This arrives well inside the ordinary one-second resume dedupe window,
    // but the intervening failed refresh is new state and grants one attempt.
    network.publishChange?.('online');
    network.publishChange?.('online');
    await waitForCalls(4);
    await sleep(30);

    expect(refreshAccessTokenMock).toHaveBeenCalledTimes(2);
    expect(streamTokens()).toEqual([
      'expired-token',
      'expired-token',
      'expired-token',
      'recovered-token',
    ]);
  });

  test('an online edge rearms one refresh after the server returns the same token', async () => {
    refreshAccessTokenMock
      .mockImplementationOnce(() => Promise.resolve({ accessToken: 'expired-token' }))
      .mockImplementationOnce(() => Promise.resolve({ accessToken: 'recovered-token' }));
    openAuthenticatedEventStreamMock
      .mockImplementationOnce(() => Promise.reject(new EventStreamHttpError(401)))
      .mockImplementationOnce(() => Promise.reject(new EventStreamHttpError(401)))
      .mockImplementationOnce(() => new Promise<void>(() => {}));
    const registry = createHarness();

    void start(registry, 'expired-token');
    await waitForCondition(
      () =>
        refreshAccessTokenMock.mock.calls.length === 1 &&
        registry.get(deviceEventsErrorAtom).includes('Session refresh failed'),
    );

    network.publishChange?.('online');
    await waitForCalls(3);
    await sleep(30);

    expect(refreshAccessTokenMock).toHaveBeenCalledTimes(2);
    expect(streamTokens()).toEqual(['expired-token', 'expired-token', 'recovered-token']);
  });

  test('a recovery edge invalidates an in-flight refresh before rearming', async () => {
    const staleRefresh: {
      resolve: ((value: { readonly accessToken: string | null } | null) => void) | null;
    } = { resolve: null };
    refreshAccessTokenMock
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            staleRefresh.resolve = resolve;
          }),
      )
      .mockImplementationOnce(() => Promise.resolve({ accessToken: 'recovered-token' }));
    openAuthenticatedEventStreamMock
      .mockImplementationOnce(() => Promise.reject(new EventStreamHttpError(401)))
      .mockImplementationOnce(() => Promise.reject(new EventStreamHttpError(401)))
      .mockImplementationOnce(() => new Promise<void>(() => {}));
    const registry = createHarness();

    void start(registry, 'expired-token');
    await waitForCondition(() => refreshAccessTokenMock.mock.calls.length === 1);

    network.publishChange?.('online');
    await waitForCalls(3);
    staleRefresh.resolve?.({ accessToken: 'stale-token' });
    await sleep(30);

    expect(refreshAccessTokenMock).toHaveBeenCalledTimes(2);
    // The interrupted refresh never reaches the rotation write, so the stale
    // credential cannot be installed after its successor already was.
    expect(registry.get(deviceEventsRotatedTokenAtom)).toBe('recovered-token');
    expect(streamTokens()).toEqual(['expired-token', 'expired-token', 'recovered-token']);
  });

  test('offline parks recovery and online preempts the pending fallback deadline', async () => {
    openAuthenticatedEventStreamMock
      .mockImplementationOnce(() => Promise.reject(new Error('offline')))
      .mockImplementationOnce(() => Promise.reject(new Error('still offline')))
      .mockImplementationOnce(() => new Promise<void>(() => {}));
    const registry = createHarness();

    void start(registry, 'current-token');
    await waitForCalls(2);
    network.publishChange?.('offline');
    await waitForCondition(() => registry.get(deviceEventsErrorAtom).startsWith('Offline'));
    await sleep(DEVICE_EVENTS_RECONNECT_BASE_MS + 50);
    expect(openAuthenticatedEventStreamMock).toHaveBeenCalledTimes(2);

    const startedAt = performance.now();
    network.publishChange?.('online');
    await waitForCalls(3, 200);

    expect(performance.now() - startedAt).toBeLessThan(DEVICE_EVENTS_RECONNECT_BASE_MS);
    expect(refreshAccessTokenMock).not.toHaveBeenCalled();
  });

  test('callbacks queued by an old stream cannot mutate or release its replacement', async () => {
    const streams: MockStreamOptions[] = [];
    openAuthenticatedEventStreamMock.mockImplementation(capturingStream(streams));
    const registry = createHarness();

    void start(registry, 'old-token');
    await waitForCalls(1);
    const oldStream = streams[0];
    if (oldStream === undefined) throw new Error('old stream missing');

    let replacementSettled = false;
    const replacementStart = start(registry, 'replacement-token').then(() => {
      replacementSettled = true;
    });
    await waitForCalls(2);
    const replacementStream = streams[1];
    if (replacementStream === undefined) throw new Error('replacement stream missing');
    expect(oldStream.signal.aborted).toBe(true);

    oldStream.onOpen?.();
    oldStream.onEvent(snapshotEvent([validDevice]));
    await sleep(30);

    expect(registry.get(devicesAtom)).toEqual([]);
    expect(registry.get(deviceListStatusAtom)).not.toBe('live');
    expect(replacementSettled).toBe(false);

    replacementStream.onOpen?.();
    replacementStream.onEvent(snapshotEvent([validDevice]));
    await replacementStart;

    expect(registry.get(devicesAtom)).toEqual([validDevice]);
    expect(registry.get(deviceListStatusAtom)).toBe('live');
    expect(registry.get(deviceEventsErrorAtom)).toBe('');
  });

  test('same-token starters share the owned initial-snapshot barrier', async () => {
    const streams: MockStreamOptions[] = [];
    openAuthenticatedEventStreamMock.mockImplementation(capturingStream(streams));
    const registry = createHarness();

    const first = start(registry, 'same-token');
    const second = start(registry, 'same-token');
    let settled = false;
    void second.then(() => {
      settled = true;
    });
    await waitForCalls(1);
    await sleep(20);
    expect(settled).toBe(false);
    expect(openAuthenticatedEventStreamMock).toHaveBeenCalledTimes(1);

    const currentStream = streams[0];
    if (currentStream === undefined) throw new Error('stream options missing');
    currentStream.onEvent(snapshotEvent([]));

    await Promise.all([first, second]);
    expect(settled).toBe(true);
    expect(openAuthenticatedEventStreamMock).toHaveBeenCalledTimes(1);
  });

  test('rejects a mixed-schema snapshot atomically without satisfying boot', async () => {
    const streams: MockStreamOptions[] = [];
    openAuthenticatedEventStreamMock.mockImplementation(capturingStream(streams));
    const registry = createHarness();

    const started = start(registry, 'current-token');
    let settled = false;
    void started.then(() => {
      settled = true;
    });
    await waitForCalls(1);
    const currentStream = streams[0];
    if (currentStream === undefined) throw new Error('stream options missing');

    currentStream.onEvent({
      event: 'snapshot',
      data: JSON.stringify({ seq: 1, devices: [validDevice, { ...validDevice, id: '' }] }),
    });
    await sleep(30);
    expect(registry.get(devicesAtom)).toEqual([]);
    expect(settled).toBe(false);

    currentStream.onEvent(snapshotEvent([validDevice]));
    await started;
    expect(registry.get(devicesAtom)).toEqual([validDevice]);
  });

  test('a snapshot queued before stop cannot resurrect the barrier its owner failed', async () => {
    const streams: MockStreamOptions[] = [];
    openAuthenticatedEventStreamMock.mockImplementation(capturingStream(streams));
    const registry = createHarness();

    const started = start(registry, 'current-token');
    await waitForCalls(1);
    const currentStream = streams[0];
    if (currentStream === undefined) throw new Error('stream options missing');

    // Stopping is the owner declaring the boot wait lost. It fails the barrier.
    // Bounded: if stop ever stopped settling the wait, an unbounded await would
    // hang the suite instead of reporting which invariant broke.
    stopDeviceEvents(registry);
    const settledAs = await Promise.race([
      started.then(
        () => 'resolved' as const,
        () => 'rejected' as const,
      ),
      sleep(500).then(() => 'pending' as const),
    ]);
    expect(settledAs).toBe('rejected');
    expect(AsyncResult.isFailure(registry.get(deviceEventsBootAtom))).toBe(true);

    // Abort cannot retract a host callback the stream had already queued. A
    // snapshot arriving after the stop must not flip the barrier to success:
    // a caller that already saw boot fail would otherwise never be told, and a
    // later start for the same token would inherit a satisfied barrier and skip
    // waiting for its own first snapshot.
    currentStream.onEvent(snapshotEvent([validDevice]));
    await sleep(30);

    expect(AsyncResult.isFailure(registry.get(deviceEventsBootAtom))).toBe(true);
  });

  test('same-token starters also share the barrier while recovery is parked offline', async () => {
    const registry = createHarness({ isNetworkOffline: () => true });

    const first = start(registry, 'offline-token');
    const second = start(registry, 'offline-token');
    await waitForCondition(() => registry.get(deviceEventsErrorAtom).startsWith('Offline'));
    expect(openAuthenticatedEventStreamMock).not.toHaveBeenCalled();

    const firstOutcome = first.catch((error: unknown) => error);
    const secondOutcome = second.catch((error: unknown) => error);
    stopDeviceEvents(registry);

    expect(await firstOutcome).toMatchObject({ _tag: 'DeviceEventsStopped' });
    expect(await secondOutcome).toMatchObject({ _tag: 'DeviceEventsStopped' });
  });

  test('the boot wait resolves after the first-snapshot deadline so the splash can exit', async () => {
    openAuthenticatedEventStreamMock.mockImplementation(() => new Promise<void>(() => {}));
    const registry = createHarness({ firstSnapshotTimeout: '40 millis' });

    const started = start(registry, 'stalled-token');
    await waitForCalls(1);
    await started;

    // The lifetime is still live; only the wait was bounded.
    expect(openAuthenticatedEventStreamMock).toHaveBeenCalledTimes(1);
  });

  test('a successful snapshot resets the fallback schedule to an immediate retry', async () => {
    openAuthenticatedEventStreamMock
      .mockImplementationOnce(() => Promise.reject(new Error('stream failed')))
      .mockImplementationOnce((_token, _path, options) => {
        options.onEvent(snapshotEvent([validDevice]));
        return sleep(20);
      })
      .mockImplementationOnce(() => new Promise<void>(() => {}));
    const registry = createHarness();

    const started = start(registry, 'current-token');
    await started;
    const snapshotAtMs = performance.now();
    await waitForCalls(3, 500);

    // Without the reset the third attempt would sit on the 250 ms fallback.
    expect(performance.now() - snapshotAtMs).toBeLessThan(DEVICE_EVENTS_RECONNECT_BASE_MS);
    expect(registry.get(devicesAtom)).toEqual([validDevice]);
  });

  test('a long hidden period rebuilds the stream on resume', async () => {
    openAuthenticatedEventStreamMock.mockImplementation(() => new Promise<void>(() => {}));
    const registry = createHarness();

    void start(registry, 'current-token');
    await waitForCalls(1);

    const realNow = Date.now;
    const hiddenAtMs = realNow();
    try {
      Date.now = () => hiddenAtMs;
      fakeDocument.visibilityState = 'hidden';
      fakeDocument.dispatch('visibilitychange', {});
      await sleep(20);
      expect(openAuthenticatedEventStreamMock).toHaveBeenCalledTimes(1);

      Date.now = () => hiddenAtMs + RESUME_STALE_HIDDEN_MS;
      fakeDocument.visibilityState = 'visible';
      fakeDocument.dispatch('visibilitychange', {});
      await waitForCalls(2);
    } finally {
      Date.now = realNow;
    }

    expect(streamTokens()).toEqual(['current-token', 'current-token']);
  });

  test('a brief hidden period leaves the stream alone', async () => {
    openAuthenticatedEventStreamMock.mockImplementation(() => new Promise<void>(() => {}));
    const registry = createHarness();

    void start(registry, 'current-token');
    await waitForCalls(1);

    fakeDocument.visibilityState = 'hidden';
    fakeDocument.dispatch('visibilitychange', {});
    fakeDocument.visibilityState = 'visible';
    fakeDocument.dispatch('visibilitychange', {});
    await sleep(50);

    expect(openAuthenticatedEventStreamMock).toHaveBeenCalledTimes(1);
  });

  test('a stream that stops delivering bytes is condemned by its own silence', async () => {
    const streams: MockStreamOptions[] = [];
    openAuthenticatedEventStreamMock.mockImplementation(capturingStream(streams));
    const registry = createHarness({ stallTimeout: '60 millis' });

    void start(registry, 'current-token');
    await waitForCalls(1);
    streams[0]?.onOpen?.();
    streams[0]?.onEvent(snapshotEvent([validDevice]));
    await waitForCondition(() => registry.get(deviceListStatusAtom) === 'live');

    // Nothing else is ever written to this stream and nothing fails it: this is
    // the half-open socket `fetch` never reports.
    await waitForCalls(2);
    expect(registry.get(deviceListStatusAtom)).toBe('offline');
    expect(registry.get(deviceEventsErrorAtom).length).toBeGreaterThan(0);
    // The list itself is held, and the reopen offers its sequence rather than
    // asking for a snapshot it may not need.
    expect(registry.get(devicesAtom)).toHaveLength(1);
    expect(streams[1]?.headers?.[DEVICE_EVENTS_SINCE_HEADER]).toBe(`${EPOCH}:1`);
    expect(streams[0]?.signal.aborted).toBe(true);
  });

  /**
   * The failure this separation exists for, and the one the production report
   * came down to: `refreshing`, one attempt, no error, no request that ever
   * completed, and a socket in perfect health underneath it. The server starts
   * its keep-alives once it believes it has written the opening frame, so a
   * client that never got that frame is fed proof of life every fifteen seconds
   * forever — the deadline never expires, nothing reconnects, and nothing is
   * ever reported.
   */
  test('keep-alive bytes cannot hold a stream that never delivered its first frame', async () => {
    const streams: MockStreamOptions[] = [];
    openAuthenticatedEventStreamMock.mockImplementation(capturingStream(streams));
    const registry = createHarness({ stallTimeout: '60 millis' });
    registry.set(deviceUserIdAtom, USER_ID);
    registry.set(devicesAtom, [validDevice]);
    registry.set(deviceCursorAtom, { epoch: EPOCH, seq: 5 });
    registry.set(hasDeviceSnapshotAtom, true);

    void start(registry, 'current-token');
    await waitForCalls(1);
    streams[0]?.onOpen?.();

    // Bytes, faithfully, forever — and not one frame.
    const heartbeats = setInterval(() => streams[0]?.onActivity?.(), 15);
    try {
      await waitForCalls(2, 2_000);
    } finally {
      clearInterval(heartbeats);
    }
    expect(registry.get(deviceEventsStreamFailureAtom)).toEqual({ kind: 'no_frame' });
    expect(streams[0]?.signal.aborted).toBe(true);
  });

  test('keep-alive bytes hold a stream that has no frames to send', async () => {
    const streams: MockStreamOptions[] = [];
    openAuthenticatedEventStreamMock.mockImplementation(capturingStream(streams));
    const registry = createHarness({ stallTimeout: '60 millis' });

    void start(registry, 'current-token');
    await waitForCalls(1);
    streams[0]?.onOpen?.();
    streams[0]?.onEvent(snapshotEvent([validDevice]));
    await waitForCondition(() => registry.get(deviceListStatusAtom) === 'live');

    // A comment the SSE parser discards is still a byte that arrived.
    for (let tick = 0; tick < 10; tick += 1) {
      streams[0]?.onActivity?.();
      await sleep(20);
    }

    expect(openAuthenticatedEventStreamMock).toHaveBeenCalledTimes(1);
    expect(registry.get(deviceListStatusAtom)).toBe('live');
  });

  test('a request that never answers is bounded by the same deadline', async () => {
    // No `onOpen`, no body, no rejection: the fetch simply hangs, which nothing
    // else in this loop bounds.
    openAuthenticatedEventStreamMock.mockImplementation(() => new Promise<void>(() => {}));
    const registry = createHarness({ stallTimeout: '60 millis' });

    void start(registry, 'current-token');
    await waitForCalls(2);
    expect(streamTokens()).toEqual(['current-token', 'current-token']);
  });

  test('a bfcache restore rebuilds the stream, an ordinary pageshow does not', async () => {
    openAuthenticatedEventStreamMock.mockImplementation(() => new Promise<void>(() => {}));
    const registry = createHarness();

    void start(registry, 'current-token');
    await waitForCalls(1);

    fakeWindow.dispatch('pageshow', { persisted: false });
    await sleep(30);
    expect(openAuthenticatedEventStreamMock).toHaveBeenCalledTimes(1);

    fakeWindow.dispatch('pageshow', { persisted: true });
    await waitForCalls(2);
    expect(streamTokens()).toEqual(['current-token', 'current-token']);
  });

  test('a recovery edge aborts the in-flight attempt before opening its replacement', async () => {
    const streams: MockStreamOptions[] = [];
    openAuthenticatedEventStreamMock.mockImplementation(capturingStream(streams));
    const registry = createHarness();

    void start(registry, 'current-token');
    await waitForCalls(1);
    const suspectStream = streams[0];
    if (suspectStream === undefined) throw new Error('stream options missing');
    expect(suspectStream.signal.aborted).toBe(false);

    // A resumed iOS PWA can be holding a frozen stream that never errors, so
    // the edge must tear the attempt down rather than wait on it.
    fakeWindow.dispatch('pageshow', { persisted: true });
    await waitForCalls(2);

    expect(suspectStream.signal.aborted).toBe(true);
    expect(streams[1]?.signal.aborted).toBe(false);
  });

  test('stopping the lifetime detaches its resume listeners and aborts its stream', async () => {
    const streams: MockStreamOptions[] = [];
    openAuthenticatedEventStreamMock.mockImplementation(capturingStream(streams));
    const registry = createHarness();

    void start(registry, 'current-token');
    await waitForCalls(1);
    const currentStream = streams[0];
    if (currentStream === undefined) throw new Error('stream options missing');

    stopDeviceEvents(registry);
    await waitForCondition(() => currentStream.signal.aborted);

    fakeWindow.dispatch('pageshow', { persisted: true });
    await sleep(30);
    expect(openAuthenticatedEventStreamMock).toHaveBeenCalledTimes(1);
  });

  test('applies sequenced deltas in order, ignores repeats, and reopens on a gap', async () => {
    const streams: MockStreamOptions[] = [];
    openAuthenticatedEventStreamMock.mockImplementation(capturingStream(streams));
    const registry = createHarness();

    const started = start(registry, 'current-token');
    await waitForCalls(1);
    const stream = streams[0];
    if (stream === undefined) throw new Error('stream options missing');
    // A first open holds no list, so it offers no sequence to resume from.
    expect(stream.headers).toBeUndefined();
    stream.onOpen?.();
    stream.onEvent(snapshotEvent([validDevice], 3));
    await started;
    expect(registry.get(deviceCursorAtom)).toEqual({ epoch: EPOCH, seq: 3 });

    stream.onEvent(deltaEvent(4, 'offline'));
    await waitForCondition(() => registry.get(deviceCursorAtom)?.seq === 4);
    expect(registry.get(devicesAtom)).toEqual([{ ...validDevice, status: 'offline' }]);

    // A repeat is absolute and therefore harmless.
    stream.onEvent(deltaEvent(4, 'online'));
    await sleep(20);
    expect(registry.get(devicesAtom)).toEqual([{ ...validDevice, status: 'offline' }]);

    // A hole ends this lifetime; the reopen offers the last applied sequence
    // and lets the server decide between a snapshot and a resume.
    stream.onEvent(deltaEvent(6, 'online'));
    await waitForCalls(2);
    expect(stream.signal.aborted).toBe(true);
    expect(streams[1]?.headers).toEqual({ [DEVICE_EVENTS_SINCE_HEADER]: `${EPOCH}:4` });
    expect(registry.get(devicesAtom)).toEqual([{ ...validDevice, status: 'offline' }]);
  });

  test('a resume frame confirms the held list, releases boot, and carries no snapshot', async () => {
    const streams: MockStreamOptions[] = [];
    openAuthenticatedEventStreamMock.mockImplementation(capturingStream(streams));
    const registry = createHarness();
    // What a warm launch hydrates from the cache.
    registry.set(deviceUserIdAtom, USER_ID);
    registry.set(devicesAtom, [validDevice]);
    registry.set(deviceCursorAtom, { epoch: EPOCH, seq: 5 });
    registry.set(hasDeviceSnapshotAtom, true);

    const started = start(registry, 'current-token');
    await waitForCalls(1);
    const stream = streams[0];
    if (stream === undefined) throw new Error('stream options missing');
    expect(stream.headers).toEqual({ [DEVICE_EVENTS_SINCE_HEADER]: `${EPOCH}:5` });

    stream.onOpen?.();
    stream.onEvent(resumeEvent(5));
    await started;
    expect(registry.get(devicesAtom)).toEqual([validDevice]);
    expect(registry.get(deviceListStatusAtom)).toBe('live');
    expect(AsyncResult.isSuccess(registry.get(deviceEventsBootAtom))).toBe(true);
  });

  test('a resume this browser did not ask for forces a snapshot instead', async () => {
    const streams: MockStreamOptions[] = [];
    openAuthenticatedEventStreamMock.mockImplementation(capturingStream(streams));
    const registry = createHarness();
    registry.set(deviceUserIdAtom, USER_ID);
    registry.set(devicesAtom, [validDevice]);
    registry.set(deviceCursorAtom, { epoch: EPOCH, seq: 5 });
    registry.set(hasDeviceSnapshotAtom, true);

    const started = start(registry, 'current-token');
    void started.catch(() => undefined);
    await waitForCalls(1);
    const stream = streams[0];
    if (stream === undefined) throw new Error('stream options missing');
    stream.onOpen?.();

    // "Everything you hold is current" — about a counter this browser never
    // named. Accepting it would stamp the held rows with a cursor nothing
    // confirmed, and they would keep answering for the machines forever.
    stream.onEvent(resumeEvent(5, '00112233445566ff'));

    await waitForCalls(2);
    expect(stream.signal.aborted).toBe(true);
    // The rows stay; the claim about them does not. The reopen offers nothing,
    // so only a snapshot can answer it.
    expect(registry.get(devicesAtom)).toEqual([validDevice]);
    expect(registry.get(deviceCursorAtom)).toBeNull();
    expect(streams[1]?.headers).toBeUndefined();
  });

  test('another account drops the held list before any cursor is offered', async () => {
    const streams: MockStreamOptions[] = [];
    openAuthenticatedEventStreamMock.mockImplementation(capturingStream(streams));
    const registry = createHarness();
    registry.set(deviceUserIdAtom, USER_ID);
    registry.set(devicesAtom, [validDevice]);
    registry.set(deviceCursorAtom, { epoch: EPOCH, seq: 5 });
    registry.set(hasDeviceSnapshotAtom, true);

    const lifetime = startDeviceEvents(registry, 'other-token', 'user-2');
    void lifetime.catch(() => undefined);
    expect(registry.get(devicesAtom)).toEqual([]);
    expect(registry.get(hasDeviceSnapshotAtom)).toBe(false);
    expect(registry.get(deviceUserIdAtom)).toBe('user-2');
    expect(registry.get(deviceListStatusAtom)).toBe('initial-loading');
    await waitForCalls(1);
    expect(streams[0]?.headers).toBeUndefined();

    const stream = streams[0];
    if (stream === undefined) throw new Error('stream options missing');
    stream.onOpen?.();
    stream.onEvent(snapshotEvent([validDevice]));
    await lifetime;
    expect(registry.get(deviceListStatusAtom)).toBe('live');

    // Joining the running lifetime announces nothing: it is owed no frame, so
    // re-arming the badge would leave it claiming a refresh that never comes.
    const joined = startDeviceEvents(registry, 'other-token', 'user-2');
    void joined.catch(() => undefined);
    expect(registry.get(deviceListStatusAtom)).toBe('live');
    expect(streamTokens()).toEqual(['other-token']);
  });

  test('counts every attempt it begins, so a loop that never ran is not a loop trying', async () => {
    const streams: MockStreamOptions[] = [];
    openAuthenticatedEventStreamMock.mockImplementation(capturingStream(streams));
    const registry = createHarness();
    registry.set(deviceUserIdAtom, USER_ID);
    expect(registry.get(deviceEventsAttemptsAtom)).toBe(0);

    const started = start(registry, 'current-token');
    await waitForCalls(1);
    expect(registry.get(deviceEventsAttemptsAtom)).toBe(1);
    streams[0]?.onOpen?.();
    streams[0]?.onEvent(snapshotEvent([validDevice]));
    await started;

    // A stream that ends is a new attempt, and the count says so even while
    // the status stays exactly where it was.
    network.publishChange?.('online');
    await waitForCalls(2);
    expect(registry.get(deviceEventsAttemptsAtom)).toBe(2);
  });

  /**
   * A reload opens its first stream onto a connection the page it replaced is
   * still closing, and that request can fail once. "Disconnected" is a claim
   * about something that was connected, and the fallback schedule's own policy
   * is that a failed stream is worth one immediate retry — so announcing the
   * first failure announces a fault the loop expects to fix before anyone can
   * read the sentence. Which is what a reload did: a red notice for a split
   * second, about a stream that had never connected.
   */
  test('the first failure of a lifetime is a retry, not a disconnection', async () => {
    const streams: MockStreamOptions[] = [];
    openAuthenticatedEventStreamMock
      .mockImplementationOnce(() => Promise.reject(new Error('connection closing')))
      .mockImplementation(capturingStream(streams));
    const registry = createHarness();
    registry.set(deviceUserIdAtom, USER_ID);

    const started = start(registry, 'current-token');
    await waitForCalls(2);
    expect(registry.get(deviceEventsErrorAtom)).toBe('');

    streams[0]?.onOpen?.();
    streams[0]?.onEvent(snapshotEvent([validDevice]));
    await started;
    expect(registry.get(deviceListStatusAtom)).toBe('live');
    expect(registry.get(deviceEventsErrorAtom)).toBe('');
  });

  test('a second failure with nothing delivered between them is one', async () => {
    openAuthenticatedEventStreamMock.mockImplementation(() =>
      Promise.reject(new Error('connection closing')),
    );
    const registry = createHarness();
    registry.set(deviceUserIdAtom, USER_ID);

    void start(registry, 'current-token');
    await waitForCondition(() => registry.get(deviceEventsErrorAtom).length > 0);
    expect(registry.get(deviceEventsErrorAtom)).toContain('disconnected');
    expect(openAuthenticatedEventStreamMock.mock.calls.length).toBeGreaterThan(1);
  });

  test('a cleared error restores the badge the stream is entitled to', async () => {
    const streams: MockStreamOptions[] = [];
    openAuthenticatedEventStreamMock.mockImplementation(capturingStream(streams));
    const registry = createHarness();
    registry.set(deviceUserIdAtom, USER_ID);

    const started = start(registry, 'current-token');
    await waitForCalls(1);
    streams[0]?.onOpen?.();
    streams[0]?.onEvent(snapshotEvent([validDevice]));
    await started;
    expect(registry.get(deviceListStatusAtom)).toBe('live');

    // A failure the loop publishes takes the list offline, and clearing it —
    // which the next `open` does — must hand the badge back. Assigned rather
    // than derived, the status stayed `offline` over a stream that was already
    // delivering, until some later frame happened to overwrite it.
    publishDeviceEventsError(registry, 'something went wrong');
    expect(registry.get(deviceListStatusAtom)).toBe('offline');
    publishDeviceEventsError(registry, '');
    expect(registry.get(deviceListStatusAtom)).toBe('live');
  });

  test('an attempt that opens and delivers nothing reports itself', async () => {
    const streams: MockStreamOptions[] = [];
    openAuthenticatedEventStreamMock.mockImplementation(capturingStream(streams));
    const registry = createHarness({ stallTimeout: '60 millis' });
    registry.set(deviceUserIdAtom, USER_ID);
    registry.set(devicesAtom, [validDevice]);
    registry.set(deviceCursorAtom, { epoch: EPOCH, seq: 5 });
    registry.set(hasDeviceSnapshotAtom, true);

    void start(registry, 'current-token');
    await waitForCalls(1);
    // Response headers, then nothing: the server owes every stream a `snapshot`
    // or a `resume` as its first frame, and this one never sends it.
    streams[0]?.onOpen?.();
    expect(registry.get(deviceListStatusAtom)).toBe('refreshing');

    await waitForCalls(2);
    expect(registry.get(deviceEventsStreamFailureAtom)).toEqual({ kind: 'no_frame' });
  });

  test('a request that is never answered is reported apart from one that opens', async () => {
    // No `onOpen`, no bytes, no rejection. Nothing on the server records a
    // request it never received, so this browser is the only place the fact
    // exists at all.
    openAuthenticatedEventStreamMock.mockImplementation(() => new Promise<void>(() => {}));
    const registry = createHarness({ stallTimeout: '60 millis' });
    registry.set(deviceUserIdAtom, USER_ID);

    void start(registry, 'current-token');
    await waitForCalls(2);
    expect(registry.get(deviceEventsStreamFailureAtom)).toEqual({ kind: 'no_response' });
  });

  test('a page being torn down does not report the attempt that died with it', async () => {
    // A fetch cancelled by a navigation rejects the way a dead network does, so
    // nothing in the failure says the page went away. Reporting it would put
    // one failure on the wire for every reload — which is the traffic anyone
    // reproducing a stuck list generates while reproducing it.
    openAuthenticatedEventStreamMock.mockImplementation(() =>
      Promise.reject(new TypeError('Failed to fetch')),
    );
    const registry = createHarness();
    registry.set(deviceUserIdAtom, USER_ID);

    void start(registry, 'current-token');
    await waitForCalls(1);
    await waitForCondition(() => registry.get(deviceEventsStreamFailureAtom) !== null);
    registry.set(deviceEventsStreamFailureAtom, null);

    fakeWindow.dispatch('pagehide', {});
    const before = openAuthenticatedEventStreamMock.mock.calls.length;
    await waitForCalls(before + 1);
    await sleep(50);
    expect(registry.get(deviceEventsStreamFailureAtom)).toBeNull();
  });

  test('an attempt this loop preempts on purpose is not a failure', async () => {
    openAuthenticatedEventStreamMock.mockImplementation(() => new Promise<void>(() => {}));
    const registry = createHarness();
    registry.set(deviceUserIdAtom, USER_ID);

    void start(registry, 'current-token');
    await waitForCalls(1);

    // A recovery edge ends the attempt before it could deliver anything. The
    // loop chose that, so there is nothing to report.
    network.publishChange?.('online');
    await waitForCalls(2);
    expect(registry.get(deviceEventsStreamFailureAtom)).toBeNull();
  });

  test('stopping the lifetime retires the status it announced', async () => {
    const streams: MockStreamOptions[] = [];
    openAuthenticatedEventStreamMock.mockImplementation(capturingStream(streams));
    const registry = createHarness();
    registry.set(deviceUserIdAtom, USER_ID);
    registry.set(devicesAtom, [validDevice]);
    registry.set(deviceCursorAtom, { epoch: EPOCH, seq: 5 });
    registry.set(hasDeviceSnapshotAtom, true);

    const started = start(registry, 'current-token');
    void started;
    // A held list refreshing behind the badge, no frame delivered yet.
    expect(registry.get(deviceListStatusAtom)).toBe('refreshing');
    await waitForCalls(1);

    // Selecting a machine stops the stream mid-refresh. Nothing is coming, so
    // the badge must stop saying one is: this is the "Updating…" that never
    // cleared when the connect attempt then failed before the terminal took
    // the screen.
    stopDeviceEvents(registry);
    expect(registry.get(deviceListStatusAtom)).toBe('offline');

    // And a lifetime torn down after it went live cannot leave the list
    // claiming a stream that is no longer running.
    const resumed = start(registry, 'current-token');
    void resumed;
    await waitForCalls(2);
    const stream = streams[1];
    if (stream === undefined) throw new Error('stream options missing');
    stream.onOpen?.();
    stream.onEvent(resumeEvent(5));
    await resumed;
    expect(registry.get(deviceListStatusAtom)).toBe('live');

    stopDeviceEvents(registry);
    expect(registry.get(deviceListStatusAtom)).toBe('offline');
  });
});
