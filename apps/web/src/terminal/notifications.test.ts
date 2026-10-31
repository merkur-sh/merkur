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
let restoreTerminalNotifications: typeof import('./notifications')['restoreTerminalNotifications'];
const registrations: Array<{ token: string | null; body: unknown }> = [];
let registrationFailure = false;
const apiDescriptors = new Map<string, PropertyDescriptor | undefined>();
beforeAll(async () => {
  const values = {
    location: { origin: 'https://notifications.example' },
    fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        registrations.push({
          token: new Headers(init.headers).get('authorization'),
          body: JSON.parse(String(init.body)),
        });
        return registrationFailure
          ? Response.json({ error: 'POST failed' }, { status: 503 })
          : Response.json({ ok: true });
      }
      return deleteFailure
        ? Response.json({ error: 'DELETE failed' }, { status: 503 })
        : Response.json({ ok: true });
    },
  };
  for (const [name, value] of Object.entries(values)) {
    apiDescriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  ({ disableTerminalNotifications, loadTerminalNotificationState, restoreTerminalNotifications } =
    await import('./notifications'));
});
afterAll(() => {
  for (const [name, descriptor] of apiDescriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

beforeEach(() => {
  storage.set('merkur:terminal-notifications-enabled', 'true');
  registrations.length = 0;
  registrationFailure = false;
  deleteFailure = false;
  unsubscribeFailure = false;
  unsubscribeCalls = 0;
  unsubscribeResult = true;
  present = true;
  const subscription = {
    endpoint: 'https://push.example/subscription',
    getKey: () => new Uint8Array([1, 2, 3]).buffer,
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

async function establish(token: string): Promise<string> {
  const source = readFileSync(new URL('../app/createAppController.ts', import.meta.url), 'utf8');
  const start = source.indexOf('    loadDevices: async (token, userId) => {');
  const end = source.indexOf('\n    },', start);
  if (start < 0 || end < start) throw new Error('missing account establishment callback');
  let state = loadTerminalNotificationState();
  const program = new Bun.Transpiler({ loader: 'ts' }).transformSync(
    `({${source.slice(start, end + 7)}}).loadDevices`,
  );
  const callback = runInNewContext(program, {
    startKeyboardSettingsSync: () => {},
    accessToken: () => token,
    boxAccess: { load: () => Promise.resolve() },
    loadDevices: () => Promise.resolve(),
    restoreTerminalNotifications,
    setTerminalNotificationState: (value: typeof state) => {
      state = value;
    },
    logger: { warn: () => {} },
  });
  await callback(token, 'account');
  return state;
}

test('each account establishment registers the existing subscription under its current delegation', async () => {
  expect(await establish('first-delegation')).toBe('enabled');
  expect(await establish('new-delegation')).toBe('enabled');
  expect(registrations.map((row) => row.token)).toEqual([
    'Bearer first-delegation',
    'Bearer new-delegation',
  ]);
  expect(registrations[0]?.body).toEqual({
    endpoint: 'https://push.example/subscription',
    keys: { p256dh: 'AQID', auth: 'AQID' },
  });
});

test('an enabled preference without a browser subscription displays off', async () => {
  present = false;
  expect(await establish('token')).toBe('off');
  expect(registrations).toEqual([]);
});

test('failed registration of an existing subscription displays off', async () => {
  registrationFailure = true;
  expect(await establish('token')).toBe('off');
});
