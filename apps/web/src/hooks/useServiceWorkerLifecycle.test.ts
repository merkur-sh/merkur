import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';

let mount: (() => undefined | (() => void)) | undefined;
let dispose: (() => void) | undefined;
let useServiceWorkerLifecycle: typeof import('./useServiceWorkerLifecycle').useServiceWorkerLifecycle;
const reload = mock(() => {});
const page = Object.assign(new EventTarget(), { visibilityState: 'visible' });
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const originalServiceWorker = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker');

beforeAll(async () => {
  mock.module('solid-js', () => ({
    onSettled: (callback: () => undefined | (() => void)) => {
      mount = callback;
    },
  }));
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { hostname: 'merkur.test', reload } },
  });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: page });
  ({ useServiceWorkerLifecycle } = await import('./useServiceWorkerLifecycle'));
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  mount = undefined;
  reload.mockClear();
  page.visibilityState = 'visible';
});

afterAll(() => {
  mock.restore();
  if (originalWindow === undefined) Reflect.deleteProperty(globalThis, 'window');
  else Object.defineProperty(globalThis, 'window', originalWindow);
  if (originalDocument === undefined) Reflect.deleteProperty(globalThis, 'document');
  else Object.defineProperty(globalThis, 'document', originalDocument);
  if (originalServiceWorker === undefined) Reflect.deleteProperty(navigator, 'serviceWorker');
  else Object.defineProperty(navigator, 'serviceWorker', originalServiceWorker);
});

function startLifecycle(initialController: object | null) {
  const registration = Object.assign(new EventTarget(), {
    active: initialController as object | null,
    waiting: null as ReturnType<typeof makeWorker> | null,
    installing: null as ReturnType<typeof makeWorker> | null,
    update: mock(() => Promise.resolve()),
  });
  let resolveRegistration: (value: typeof registration) => void = () => {};
  const registered = new Promise<typeof registration>((resolve) => {
    resolveRegistration = resolve;
  });
  const serviceWorker = Object.assign(new EventTarget(), {
    controller: initialController,
    register: mock(() => registered),
  });
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: serviceWorker });
  const setSwUpdate = mock((_next: string) => {});
  const applyUpdate = useServiceWorkerLifecycle({ setSwUpdate });
  dispose = mount?.() ?? undefined;
  expect(dispose).toBeFunction();
  return {
    setSwUpdate,
    registration,
    applyUpdate,
    lastState: () => setSwUpdate.mock.calls.at(-1)?.[0],
    async finishRegistration() {
      resolveRegistration(registration);
      await registered;
    },
    changeController(controller: object | null) {
      serviceWorker.controller = controller;
      serviceWorker.dispatchEvent(new Event('controllerchange'));
    },
  };
}

function makeWorker() {
  return Object.assign(new EventTarget(), { postMessage: mock((_message: string) => {}) });
}

describe('service worker update prompt', () => {
  test('first claim is silent; a later replacement reloads the old shell', () => {
    const { setSwUpdate, changeController } = startLifecycle(null);
    changeController({});
    expect(setSwUpdate).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    changeController({});
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test('activation by another tab reloads once, even while registration is pending', () => {
    const { setSwUpdate, changeController } = startLifecycle({});
    changeController({});
    changeController({});
    expect(reload).toHaveBeenCalledTimes(1);
    expect(setSwUpdate).not.toHaveBeenCalled();
  });

  test('an already waiting update prompts and activates only when Reload is chosen', async () => {
    const lifecycle = startLifecycle({});
    const waiting = makeWorker();
    lifecycle.registration.waiting = waiting;
    await lifecycle.finishRegistration();
    expect(lifecycle.setSwUpdate.mock.calls).toEqual([['ready']]);
    expect(waiting.postMessage).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    lifecycle.applyUpdate();
    expect(waiting.postMessage.mock.calls).toEqual([['activate_update']]);
    expect(lifecycle.lastState()).toBe('applying');
    expect(reload).not.toHaveBeenCalled();
    lifecycle.changeController(waiting);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test('a repeated Reload tap sends one activation request', async () => {
    const lifecycle = startLifecycle({});
    const waiting = makeWorker();
    lifecycle.registration.waiting = waiting;
    await lifecycle.finishRegistration();
    lifecycle.applyUpdate();
    lifecycle.applyUpdate();
    expect(waiting.postMessage).toHaveBeenCalledTimes(1);
  });

  test('a page the worker did not control reloads on the controller its Reload caused', async () => {
    // A hard reload bypasses the worker, so the page starts uncontrolled while
    // another tab keeps the active worker in use and the update waiting.
    const lifecycle = startLifecycle(null);
    lifecycle.registration.active = {};
    const waiting = makeWorker();
    lifecycle.registration.waiting = waiting;
    await lifecycle.finishRegistration();
    expect(lifecycle.lastState()).toBe('ready');
    lifecycle.applyUpdate();
    lifecycle.changeController(waiting);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test('an installing update prompts only after it becomes waiting', async () => {
    const lifecycle = startLifecycle({});
    await lifecycle.finishRegistration();
    const installing = makeWorker();
    lifecycle.registration.installing = installing;
    lifecycle.registration.dispatchEvent(new Event('updatefound'));
    installing.dispatchEvent(new Event('statechange'));
    expect(lifecycle.lastState()).toBe('none');
    lifecycle.registration.waiting = installing;
    installing.dispatchEvent(new Event('statechange'));
    expect(lifecycle.lastState()).toBe('ready');
    expect(installing.postMessage).not.toHaveBeenCalled();
  });

  test('a first installation without an active worker never prompts', async () => {
    const lifecycle = startLifecycle(null);
    const installing = makeWorker();
    lifecycle.registration.installing = installing;
    await lifecycle.finishRegistration();
    lifecycle.registration.waiting = installing;
    installing.dispatchEvent(new Event('statechange'));
    lifecycle.applyUpdate();
    expect(lifecycle.setSwUpdate.mock.calls.every(([state]) => state === 'none')).toBe(true);
    expect(installing.postMessage).not.toHaveBeenCalled();
  });

  test('a newer build replacing the waiting one keeps the prompt on the newer worker', async () => {
    const lifecycle = startLifecycle({});
    const first = makeWorker();
    lifecycle.registration.waiting = first;
    await lifecycle.finishRegistration();
    const second = makeWorker();
    lifecycle.registration.waiting = second;
    first.dispatchEvent(new Event('statechange'));
    expect(lifecycle.lastState()).toBe('ready');
    lifecycle.applyUpdate();
    expect(first.postMessage).not.toHaveBeenCalled();
    expect(second.postMessage.mock.calls).toEqual([['activate_update']]);
  });

  test('a newer build arriving after Reload is applied without asking again', async () => {
    const lifecycle = startLifecycle({});
    const first = makeWorker();
    lifecycle.registration.waiting = first;
    await lifecycle.finishRegistration();
    lifecycle.applyUpdate();
    const second = makeWorker();
    lifecycle.registration.waiting = second;
    first.dispatchEvent(new Event('statechange'));
    expect(second.postMessage.mock.calls).toEqual([['activate_update']]);
    expect(lifecycle.lastState()).toBe('applying');
  });

  test('a later installation does not stop the waiting worker being followed', async () => {
    const lifecycle = startLifecycle({});
    await lifecycle.finishRegistration();
    const second = makeWorker();
    lifecycle.registration.installing = second;
    lifecycle.registration.dispatchEvent(new Event('updatefound'));
    lifecycle.registration.installing = null;
    lifecycle.registration.waiting = second;
    second.dispatchEvent(new Event('statechange'));
    expect(lifecycle.lastState()).toBe('ready');
    // A third build starts installing, then another tab activates the second.
    lifecycle.registration.installing = makeWorker();
    lifecycle.registration.dispatchEvent(new Event('updatefound'));
    lifecycle.registration.waiting = null;
    second.dispatchEvent(new Event('statechange'));
    expect(lifecycle.lastState()).toBe('none');
  });

  test('the prompt retracts when the waiting worker leaves without this page asking', async () => {
    const lifecycle = startLifecycle({});
    const waiting = makeWorker();
    lifecycle.registration.waiting = waiting;
    await lifecycle.finishRegistration();
    lifecycle.registration.waiting = null;
    waiting.dispatchEvent(new Event('statechange'));
    expect(lifecycle.lastState()).toBe('none');
  });

  test('returning to the page checks for a new build', async () => {
    const lifecycle = startLifecycle({});
    await lifecycle.finishRegistration();
    page.visibilityState = 'hidden';
    page.dispatchEvent(new Event('visibilitychange'));
    expect(lifecycle.registration.update).not.toHaveBeenCalled();
    page.visibilityState = 'visible';
    page.dispatchEvent(new Event('visibilitychange'));
    expect(lifecycle.registration.update).toHaveBeenCalledTimes(1);
  });

  test('an unchanged controller or loss of control does not signal an update', () => {
    const controller = {};
    const { setSwUpdate, changeController } = startLifecycle(controller);
    changeController(controller);
    changeController(null);
    expect(setSwUpdate).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  test('disposing while registration is pending prevents late registration or reload', async () => {
    const lifecycle = startLifecycle({});
    dispose?.();
    dispose = undefined;
    lifecycle.registration.waiting = makeWorker();
    await lifecycle.finishRegistration();
    lifecycle.changeController({});
    lifecycle.applyUpdate();
    expect(lifecycle.setSwUpdate).not.toHaveBeenCalled();
    expect(lifecycle.registration.waiting.postMessage).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  test('disposing removes installation listeners and revokes the update action', async () => {
    const lifecycle = startLifecycle({});
    const installing = makeWorker();
    lifecycle.registration.installing = installing;
    await lifecycle.finishRegistration();
    const callsBeforeDispose = lifecycle.setSwUpdate.mock.calls.length;
    dispose?.();
    dispose = undefined;
    lifecycle.registration.waiting = installing;
    installing.dispatchEvent(new Event('statechange'));
    lifecycle.registration.dispatchEvent(new Event('updatefound'));
    page.dispatchEvent(new Event('visibilitychange'));
    lifecycle.applyUpdate();
    expect(lifecycle.setSwUpdate.mock.calls.length).toBe(callsBeforeDispose);
    expect(installing.postMessage).not.toHaveBeenCalled();
    expect(lifecycle.registration.update).not.toHaveBeenCalled();
  });
});
