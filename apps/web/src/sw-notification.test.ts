import { expect, test } from 'bun:test';

interface NotificationScenario {
  readonly path?: string;
  readonly url?: string;
  readonly absent?: boolean;
  readonly focus?: 'closed' | 'rejected';
  readonly repeat?: boolean;
  readonly recover?: boolean;
}

type NotificationAction =
  | readonly ['destination' | 'open' | 'reported' | 'rejected', string]
  | readonly ['focus'];

async function clickNotification(
  scenario: NotificationScenario = {},
): Promise<readonly NotificationAction[]> {
  const source = `
    const scenario = ${JSON.stringify(scenario)};
    const listeners = new Map();
    const actions = [];
    let present = !scenario.absent;
    globalThis.addEventListener = (kind, listener) => listeners.set(kind, listener);
    globalThis.reportError = error => actions.push(['reported', error.message]);
    globalThis.location = { origin: 'https://app.merkur.test' };
    globalThis.Notification = class {
      constructor() { this.data = { url: scenario.path ?? '/#machine=machine-b' }; }
      close() {}
    };
    const client = {
      id: 'existing-app',
      url: scenario.url ?? 'https://app.merkur.test/',
      postMessage(message) { actions.push(['destination', message.url]); },
      async focus() {
        actions.push(['focus']);
        if (scenario.focus === 'closed' || scenario.focus === 'rejected') {
          if (scenario.recover) scenario.focus = undefined;
          throw new Error('focus refused');
        }
        return client;
      },
    };
    globalThis.clients = {
      async matchAll() { return present ? [client] : []; },
      async get() { return scenario.focus === 'closed' ? undefined : client; },
      async openWindow(url) { actions.push(['open', url]); present = true; return client; },
    };
    await import(${JSON.stringify(new URL('./sw.ts', import.meta.url).href)});
    const finished = [];
    const event = {
      notification: new Notification(),
      waitUntil(promise) { finished.push(promise); },
    };
    listeners.get('notificationclick')(event);
    if (scenario.repeat) listeners.get('notificationclick')(event);
    if (scenario.recover) {
      for (const result of await Promise.allSettled(finished)) {
        if (result.status === 'rejected') actions.push(['rejected', result.reason.message]);
      }
    } else await Promise.all(finished);
    postMessage(actions);
  `;
  const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(source)}`));
  try {
    return await new Promise<readonly NotificationAction[]>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<readonly NotificationAction[]>) =>
        resolve(event.data);
      worker.onerror = (event: ErrorEvent) => reject(new Error(event.message));
    });
  } finally {
    worker.terminate();
  }
}

test('notification click delivers its machine destination before focusing an existing app', async () => {
  expect(await clickNotification()).toEqual([
    ['destination', 'https://app.merkur.test/#machine=machine-b'],
    ['focus'],
  ]);
});

test('destination delivery never navigates a live app despite a stale client URL', async () => {
  expect(
    await clickNotification({ url: 'https://app.merkur.test/index.html?sw=on#machine=machine-a' }),
  ).toEqual([['destination', 'https://app.merkur.test/#machine=machine-b'], ['focus']]);
});

test('a closed app opens directly at the intended machine', async () => {
  expect(await clickNotification({ absent: true })).toEqual([
    ['open', 'https://app.merkur.test/#machine=machine-b'],
  ]);
});

test('overlapping cold notification clicks open one app and deliver the later destination to it', async () => {
  expect(await clickNotification({ absent: true, repeat: true })).toEqual([
    ['open', 'https://app.merkur.test/#machine=machine-b'],
    ['destination', 'https://app.merkur.test/#machine=machine-b'],
    ['focus'],
  ]);
});

test('a window retired during focus no longer owns the destination', async () => {
  expect(await clickNotification({ focus: 'closed' })).toEqual([
    ['destination', 'https://app.merkur.test/#machine=machine-b'],
    ['focus'],
    ['open', 'https://app.merkur.test/#machine=machine-b'],
  ]);
});

test('an unrelated document is never navigated or focused', async () => {
  expect(await clickNotification({ url: 'https://app.merkur.test/privacy' })).toEqual([
    ['open', 'https://app.merkur.test/#machine=machine-b'],
  ]);
});

test('an external notification URL never navigates, focuses or opens a window', async () => {
  expect(await clickNotification({ path: 'https://external.test/#machine=machine-b' })).toEqual([]);
});

test('a failed-sign-in notification focuses the existing app without replacing its terminal', async () => {
  expect(await clickNotification({ path: '/' })).toEqual([['focus']]);
});

test('a live window focus failure stays a failure instead of opening a duplicate app', async () => {
  await expect(clickNotification({ focus: 'rejected' })).rejects.toThrow('focus refused');
});

test('a failed click is reported and rejected while a later click still progresses', async () => {
  expect(await clickNotification({ focus: 'rejected', repeat: true, recover: true })).toEqual([
    ['destination', 'https://app.merkur.test/#machine=machine-b'],
    ['focus'],
    ['reported', 'Notification destination could not be opened'],
    ['destination', 'https://app.merkur.test/#machine=machine-b'],
    ['focus'],
    ['rejected', 'focus refused'],
  ]);
});
