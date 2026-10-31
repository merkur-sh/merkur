import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const storage = new Map<string, string>();
const descriptors = new Map<string, PropertyDescriptor | undefined>();
let deleteFailure = false,
  unsubscribeFailure = false,
  unsubscribeCalls = 0;
let unsubscribeResult = true,
  present = true;
let disableTerminalNotifications: typeof import('./notifications')['disableTerminalNotifications'];
let loadTerminalNotificationState: typeof import('./notifications')['loadTerminalNotificationState'];
const apiDescriptors = new Map<string, PropertyDescriptor | undefined>();
beforeAll(async () => {
  const values = {
    location: { origin: 'https://notifications.example' },
    fetch: async () =>
      deleteFailure
        ? Response.json({ error: 'DELETE failed' }, { status: 503 })
        : Response.json({ ok: true }),
  };
  for (const [name, value] of Object.entries(values)) {
    apiDescriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  ({ disableTerminalNotifications, loadTerminalNotificationState } = await import(
    './notifications'
  ));
});
afterAll(() => {
  for (const [name, descriptor] of apiDescriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

beforeEach(() => {
  storage.set('merkur:terminal-notifications-enabled', 'true');
  deleteFailure = false;
  unsubscribeFailure = false;
  unsubscribeCalls = 0;
  unsubscribeResult = true;
  present = true;
  const subscription = {
    endpoint: 'https://push.example/subscription',
    async unsubscribe() {
      unsubscribeCalls++;
      if (unsubscribeFailure) throw new Error('unsubscribe failed');
      if (unsubscribeResult) present = false;
      return unsubscribeResult;
    },
  };
  const values = {
    window: { Notification: {}, PushManager: {}, matchMedia: () => ({ matches: true }) },
    Notification: { permission: 'granted' },
    navigator: {
      serviceWorker: {
        ready: Promise.resolve({
          pushManager: {
            getSubscription: async () => (present ? subscription : null),
          },
        }),
      },
    },
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      removeItem: (key: string) => storage.delete(key),
    },
  };
  for (const [name, value] of Object.entries(values)) {
    descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
});
afterEach(() => {
  for (const [name, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  descriptors.clear();
  storage.clear();
});

test('failed disable preserves the enabled preference when both removals reject', async () => {
  deleteFailure = true;
  unsubscribeFailure = true;
  await expect(disableTerminalNotifications('token')).rejects.toThrow();
  expect(loadTerminalNotificationState()).toBe('enabled');
  expect(unsubscribeCalls).toBe(1);
});

test('confirmed disable removes the enabled preference', async () => {
  expect(await disableTerminalNotifications('token')).toBe('off');
  expect(loadTerminalNotificationState()).toBe('off');
});

test('failed disable preserves enabled state when browser removal is refused', async () => {
  unsubscribeResult = false;
  await expect(disableTerminalNotifications('token')).rejects.toThrow('still active');
  expect(loadTerminalNotificationState()).toBe('enabled');
});

for (const failure of ['server', 'browser'] as const) {
  test(`failed disable reports ${failure} removal failure`, async () => {
    deleteFailure = failure === 'server';
    unsubscribeFailure = failure === 'browser';
    await expect(disableTerminalNotifications('token')).rejects.toThrow();
    expect(loadTerminalNotificationState()).toBe('enabled');
  });
}

test('failed disable reaches the Settings error slot and releases its busy state', async () => {
  deleteFailure = true;
  unsubscribeFailure = true;
  const source = readFileSync(new URL('../screens/TerminalSettings.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('  async function changeNotifications(');
  const end = source.indexOf('\n  }\n', start);
  if (start < 0 || end < start) throw new Error('missing notification action');
  let error = '',
    busy = false;
  const context = {
    notificationChanging: false,
    NOTIFICATION_CHANGE_ERROR: 'Could not change notifications. Try again.',
    setNotificationBusy: (value: boolean) => {
      busy = value;
    },
    setNotificationError: (value: string) => {
      error = value;
    },
    props: { onTerminalNotificationsDisable: () => disableTerminalNotifications('token') },
  };
  const program = new Bun.Transpiler({ loader: 'ts' }).transformSync(source.slice(start, end + 4));
  await runInNewContext(`${program}\nchangeNotifications(false);`, context);
  expect(error).toBe(context.NOTIFICATION_CHANGE_ERROR);
  expect(busy).toBe(false);
  expect(loadTerminalNotificationState()).toBe('enabled');
});
