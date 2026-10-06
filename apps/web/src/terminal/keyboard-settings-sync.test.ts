import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { AccountKeyboardSettings } from '@merkur/shared';
import { Effect } from 'effect';
import { createLifecycleClock } from '../../../../tests/helpers/lifecycle-clock';

const storage = new Map<string, string>();
const savedDescriptors = new Map<string, PropertyDescriptor | undefined>();
let clock: Awaited<ReturnType<typeof createLifecycleClock>>;
/** Comfortably past `REVALIDATE_MIN_SPACING_MS`. */
const PAST_REVALIDATE_SPACING_MS = 20_000;

/**
 * Installed and restored around this file, and always through a descriptor.
 *
 * `bun test` shares one process across files, so a global left behind here is
 * one every other suite inherits. Descriptors both ways is what makes this
 * survive the neighbours: a suite that installed its own `localStorage`
 * non-writably makes a plain assignment throw, and installing non-writably here
 * would silently defeat a suite that installs its own by assignment.
 */
function install(name: string, value: unknown): void {
  savedDescriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

/** Stands in for the document whose visibility the sync watches. */
const documentStub = {
  hidden: false,
  listeners: new Map<string, Set<() => void>>(),
  addEventListener(type: string, handler: () => void): void {
    const handlers = documentStub.listeners.get(type) ?? new Set();
    handlers.add(handler);
    documentStub.listeners.set(type, handlers);
  },
  removeEventListener(type: string, handler: () => void): void {
    documentStub.listeners.get(type)?.delete(handler);
  },
  emit(type: string): void {
    for (const handler of [...(documentStub.listeners.get(type) ?? [])]) handler();
  },
};

beforeAll(() => {
  install('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  // The preferences module broadcasts changes on `window`; in a browser it is
  // the same event target the whole app shares.
  install('window', globalThis);
  install('document', documentStub);
});

afterAll(() => {
  for (const [name, descriptor] of savedDescriptors) {
    if (descriptor === undefined) Reflect.deleteProperty(globalThis, name);
    else Object.defineProperty(globalThis, name, descriptor);
  }
});

let remote: AccountKeyboardSettings | null = null;
let fetchFailure: Error | null = null;
let saveFailure: Error | null = null;
const saved: AccountKeyboardSettings[] = [];
let fetchCount = 0;

mock.module('../api', () => ({
  fetchAccountKeyboardSettingsEffect: (_token: string) =>
    Effect.suspend(() => {
      fetchCount += 1;
      return fetchFailure === null ? Effect.succeed(remote) : Effect.fail(fetchFailure);
    }),
  saveAccountKeyboardSettingsEffect: (_token: string, settings: AccountKeyboardSettings) =>
    Effect.suspend(() => {
      if (saveFailure !== null) return Effect.fail(saveFailure);
      saved.push(settings);
      remote = settings;
      return Effect.void;
    }),
}));

const { startKeyboardSettingsSync, stopKeyboardSettingsSync } = await import(
  './keyboard-settings-sync'
);
const {
  DEFAULT_TERMINAL_KEYBOARD_LAYER_KEY_ORDER,
  DEFAULT_TOOLBAR_KEYS,
  loadVirtualKeyboardPreferences,
  observeVirtualKeyboardPreferences,
  saveVirtualKeyboardPreferences,
} = await import('./virtual-keyboard');

async function until(predicate: () => boolean, label: string): Promise<void> {
  await clock.until(predicate, label);
}

/** A layer order that differs from the default by one swap in `alpha`. */
function swappedAlpha(): AccountKeyboardSettings['layerKeyOrder'] {
  const alpha = [...DEFAULT_TERMINAL_KEYBOARD_LAYER_KEY_ORDER.alpha];
  const first = alpha[0];
  const second = alpha[1];
  if (first === undefined || second === undefined) throw new Error('alpha layer is too small');
  alpha[0] = second;
  alpha[1] = first;
  return { ...DEFAULT_TERMINAL_KEYBOARD_LAYER_KEY_ORDER, alpha };
}

beforeEach(async () => {
  clock = await createLifecycleClock();
  storage.clear();
  saved.length = 0;
  remote = null;
  fetchFailure = null;
  saveFailure = null;
  fetchCount = 0;
  documentStub.hidden = false;
});

afterEach(async () => {
  stopKeyboardSettingsSync();
  await clock.flush();
  await clock.close();
});

describe('account keyboard settings sync', () => {
  test('adopts the account arrangement over what this device had cached', async () => {
    saveVirtualKeyboardPreferences({
      ...loadVirtualKeyboardPreferences(),
      toolbarKeys: ['tab'],
    });
    remote = {
      macros: [
        {
          id: 'macro:stop',
          name: 'Stop',
          steps: [{ key: 'key-c', ctrl: true, alt: false, shift: false, meta: false }],
        },
      ],
      toolbarKeys: ['escape', 'ctrl'],
      layerKeyOrder: swappedAlpha(),
    };

    startKeyboardSettingsSync(() => 'token', clock.runtime);

    await until(
      () => loadVirtualKeyboardPreferences().toolbarKeys[0] === 'escape',
      'the account arrangement to be adopted',
    );
    const adopted = loadVirtualKeyboardPreferences();
    expect(adopted.toolbarKeys).toEqual(['escape', 'ctrl']);
    expect(adopted.macros).toEqual(remote?.macros);
    expect(adopted.layerKeyOrder.alpha).toEqual(swappedAlpha().alpha);
  });

  test('adopting the account arrangement is not pushed back as a change', async () => {
    remote = {
      macros: [],
      toolbarKeys: ['escape'],
      layerKeyOrder: DEFAULT_TERMINAL_KEYBOARD_LAYER_KEY_ORDER,
    };

    startKeyboardSettingsSync(() => 'token', clock.runtime);
    await until(
      () => loadVirtualKeyboardPreferences().toolbarKeys[0] === 'escape',
      'the account arrangement to be adopted',
    );
    // Comfortably past the coalescing window: a push would have gone by now.
    await clock.advance(1_200);

    expect(saved).toHaveLength(0);
  });

  test('an account that has never saved is seeded from this device', async () => {
    saveVirtualKeyboardPreferences({
      ...loadVirtualKeyboardPreferences(),
      toolbarKeys: ['tab', 'paste'],
    });
    remote = null;

    startKeyboardSettingsSync(() => 'token', clock.runtime);

    await until(() => saved.length === 1, 'the account to be seeded');
    expect(saved[0]?.toolbarKeys).toEqual(['tab', 'paste']);
  });

  test('a local edit is pushed to the account', async () => {
    remote = {
      macros: [],
      toolbarKeys: [...DEFAULT_TOOLBAR_KEYS],
      layerKeyOrder: DEFAULT_TERMINAL_KEYBOARD_LAYER_KEY_ORDER,
    };
    startKeyboardSettingsSync(() => 'token', clock.runtime);
    await until(() => fetchCount === 1, 'the initial read');

    saveVirtualKeyboardPreferences({
      ...loadVirtualKeyboardPreferences(),
      toolbarKeys: ['escape', 'tab'],
    });

    await clock.advance(749);
    expect(saved).toHaveLength(0);
    await clock.advance(1);
    expect(saved).toHaveLength(1);
    expect(saved[0]?.toolbarKeys).toEqual(['escape', 'tab']);
  });

  // The layout editor emits one change per swap, so a rearrangement must not
  // become a request per swap.
  test('a burst of edits collapses into one request carrying the last one', async () => {
    remote = {
      macros: [],
      toolbarKeys: [...DEFAULT_TOOLBAR_KEYS],
      layerKeyOrder: DEFAULT_TERMINAL_KEYBOARD_LAYER_KEY_ORDER,
    };
    startKeyboardSettingsSync(() => 'token', clock.runtime);
    await until(() => fetchCount === 1, 'the initial read');

    for (const keys of [['escape'], ['escape', 'tab'], ['escape', 'tab', 'paste']]) {
      saveVirtualKeyboardPreferences({
        ...loadVirtualKeyboardPreferences(),
        toolbarKeys: keys as never,
      });
    }

    await until(() => saved.length === 1, 'the burst to be pushed');
    await clock.advance(1_200);
    expect(saved).toHaveLength(1);
    expect(saved[0]?.toolbarKeys).toEqual(['escape', 'tab', 'paste']);
  });

  // This is the whole point of the split: a device's own measurements and
  // session state must never travel, or a phone's grip model would land on a
  // tablet and a laptop would inherit a phone's shown keyboard.
  test('device-local preferences are never sent to the account', async () => {
    remote = {
      macros: [],
      toolbarKeys: [...DEFAULT_TOOLBAR_KEYS],
      layerKeyOrder: DEFAULT_TERMINAL_KEYBOARD_LAYER_KEY_ORDER,
    };
    startKeyboardSettingsSync(() => 'token', clock.runtime);
    await until(() => fetchCount === 1, 'the initial read');

    saveVirtualKeyboardPreferences({
      ...loadVirtualKeyboardPreferences(),
      visible: true,
      toolbarExpanded: true,
      keyPreview: false,
    });
    await clock.advance(1_200);

    expect(saved).toHaveLength(0);
  });

  // The account is authoritative for the arrangement; a device-local field it
  // says nothing about must survive adopting one.
  test('adopting an arrangement leaves device-local preferences alone', async () => {
    saveVirtualKeyboardPreferences({
      ...loadVirtualKeyboardPreferences(),
      keyPreview: false,
      macros: [],
      toolbarKeys: ['tab'],
    });
    remote = {
      macros: [],
      toolbarKeys: ['escape'],
      layerKeyOrder: DEFAULT_TERMINAL_KEYBOARD_LAYER_KEY_ORDER,
    };

    startKeyboardSettingsSync(() => 'token', clock.runtime);

    await until(
      () => loadVirtualKeyboardPreferences().toolbarKeys[0] === 'escape',
      'the account arrangement to be adopted',
    );
    expect(loadVirtualKeyboardPreferences().keyPreview).toBe(false);
  });

  // Seeding the account out of a failed read would let one device's outage
  // overwrite what another device had already saved.
  test('an outage never seeds the account; the read waits for a real answer', async () => {
    saveVirtualKeyboardPreferences({
      ...loadVirtualKeyboardPreferences(),
      toolbarKeys: ['tab'],
    });
    remote = {
      macros: [],
      toolbarKeys: ['escape'],
      layerKeyOrder: DEFAULT_TERMINAL_KEYBOARD_LAYER_KEY_ORDER,
    };
    fetchFailure = new Error('offline');

    startKeyboardSettingsSync(() => 'token', clock.runtime);
    await until(() => fetchCount > 1, 'the read to be retried');
    expect(saved).toHaveLength(0);
    expect(loadVirtualKeyboardPreferences().toolbarKeys).toEqual(['tab']);

    fetchFailure = null;

    await until(
      () => loadVirtualKeyboardPreferences().toolbarKeys[0] === 'escape',
      'the account arrangement to be adopted once the read lands',
    );
    expect(saved).toHaveLength(0);
  });

  // The user acted; the account's answer only tells us what was true before.
  test('an edit made before the account answers wins over what it answers', async () => {
    remote = {
      macros: [],
      toolbarKeys: ['escape'],
      layerKeyOrder: DEFAULT_TERMINAL_KEYBOARD_LAYER_KEY_ORDER,
    };
    fetchFailure = new Error('offline');
    startKeyboardSettingsSync(() => 'token', clock.runtime);
    await until(() => fetchCount > 1, 'the read to be retried');

    saveVirtualKeyboardPreferences({
      ...loadVirtualKeyboardPreferences(),
      toolbarKeys: ['tab', 'paste'],
    });
    fetchFailure = null;

    await until(() => saved.length === 1, 'the edit to be pushed');
    expect(saved[0]?.toolbarKeys).toEqual(['tab', 'paste']);
    expect(loadVirtualKeyboardPreferences().toolbarKeys).toEqual(['tab', 'paste']);
  });

  test('a failed push retries itself, without needing another edit', async () => {
    remote = {
      macros: [],
      toolbarKeys: [...DEFAULT_TOOLBAR_KEYS],
      layerKeyOrder: DEFAULT_TERMINAL_KEYBOARD_LAYER_KEY_ORDER,
    };
    startKeyboardSettingsSync(() => 'token', clock.runtime);
    await until(() => fetchCount === 1, 'the initial read');

    saveFailure = new Error('offline');
    saveVirtualKeyboardPreferences({
      ...loadVirtualKeyboardPreferences(),
      toolbarKeys: ['escape'],
    });
    await clock.advance(1_500);
    expect(saved).toHaveLength(0);

    saveFailure = null;

    await until(() => saved.length === 1, 'the push to recover on its own');
    expect(saved[0]?.toolbarKeys).toEqual(['escape']);
  });

  // A retry that replayed the arrangement that failed would undo the edit made
  // during the outage.
  test('a retry carries the newest arrangement, never the one that failed', async () => {
    remote = {
      macros: [],
      toolbarKeys: [...DEFAULT_TOOLBAR_KEYS],
      layerKeyOrder: DEFAULT_TERMINAL_KEYBOARD_LAYER_KEY_ORDER,
    };
    startKeyboardSettingsSync(() => 'token', clock.runtime);
    await until(() => fetchCount === 1, 'the initial read');

    saveFailure = new Error('offline');
    saveVirtualKeyboardPreferences({
      ...loadVirtualKeyboardPreferences(),
      toolbarKeys: ['escape'],
    });
    await clock.advance(1_500);

    saveVirtualKeyboardPreferences({
      ...loadVirtualKeyboardPreferences(),
      toolbarKeys: ['escape', 'tab'],
    });
    saveFailure = null;

    await until(() => saved.length === 1, 'the retry to land');
    await clock.advance(1_200);
    expect(saved).toEqual([
      {
        macros: [],
        toolbarKeys: ['escape', 'tab'],
        layerKeyOrder: DEFAULT_TERMINAL_KEYBOARD_LAYER_KEY_ORDER,
      },
    ]);
  });

  // Without this a device left open never learns about a change made on
  // another one, which is most of what "settings follow the account" means.
  test('coming back to the tab picks up a change made on another device', async () => {
    remote = {
      macros: [],
      toolbarKeys: [...DEFAULT_TOOLBAR_KEYS],
      layerKeyOrder: DEFAULT_TERMINAL_KEYBOARD_LAYER_KEY_ORDER,
    };
    startKeyboardSettingsSync(() => 'token', clock.runtime);
    await until(() => fetchCount === 1, 'the initial read');

    remote = { macros: [], toolbarKeys: ['escape', 'paste'], layerKeyOrder: swappedAlpha() };
    await clock.advance(PAST_REVALIDATE_SPACING_MS);
    documentStub.emit('visibilitychange');

    await until(
      () => loadVirtualKeyboardPreferences().toolbarKeys[0] === 'escape',
      'the other device’s arrangement to be adopted',
    );
    expect(loadVirtualKeyboardPreferences().layerKeyOrder.alpha).toEqual(swappedAlpha().alpha);
    expect(saved).toHaveLength(0);
  });

  test('regaining the network and a back/forward restore both revalidate', async () => {
    remote = {
      macros: [],
      toolbarKeys: [...DEFAULT_TOOLBAR_KEYS],
      layerKeyOrder: DEFAULT_TERMINAL_KEYBOARD_LAYER_KEY_ORDER,
    };
    startKeyboardSettingsSync(() => 'token', clock.runtime);
    await until(() => fetchCount === 1, 'the initial read');

    let expected = 1;
    for (const type of ['online', 'pageshow']) {
      await clock.advance(PAST_REVALIDATE_SPACING_MS);
      window.dispatchEvent(new Event(type));
      expected += 1;
      await until(() => fetchCount === expected, `a read for the ${type} edge`);
    }
  });

  // The edges arrive in bursts — waking a laptop raises all three at once — and
  // an arrangement cannot change often enough to be worth a request each.
  test('a burst of edges costs one read, not one per edge', async () => {
    remote = {
      macros: [],
      toolbarKeys: [...DEFAULT_TOOLBAR_KEYS],
      layerKeyOrder: DEFAULT_TERMINAL_KEYBOARD_LAYER_KEY_ORDER,
    };
    startKeyboardSettingsSync(() => 'token', clock.runtime);
    await until(() => fetchCount === 1, 'the initial read');

    await clock.advance(PAST_REVALIDATE_SPACING_MS);
    documentStub.emit('visibilitychange');
    window.dispatchEvent(new Event('online'));
    window.dispatchEvent(new Event('pageshow'));
    await clock.advance(500);

    expect(fetchCount).toBe(2);
  });

  test('a hidden tab is not a reason to read', async () => {
    remote = {
      macros: [],
      toolbarKeys: [...DEFAULT_TOOLBAR_KEYS],
      layerKeyOrder: DEFAULT_TERMINAL_KEYBOARD_LAYER_KEY_ORDER,
    };
    startKeyboardSettingsSync(() => 'token', clock.runtime);
    await until(() => fetchCount === 1, 'the initial read');

    await clock.advance(PAST_REVALIDATE_SPACING_MS);
    documentStub.hidden = true;
    documentStub.emit('visibilitychange');
    await clock.advance(500);

    expect(fetchCount).toBe(1);
  });

  // The revalidation closes the latch on its way in, so an edit raised before
  // it ran would have been swallowed and never pushed.
  test('an edit is still pushed when a revalidation overtakes it', async () => {
    remote = {
      macros: [],
      toolbarKeys: [...DEFAULT_TOOLBAR_KEYS],
      layerKeyOrder: DEFAULT_TERMINAL_KEYBOARD_LAYER_KEY_ORDER,
    };
    startKeyboardSettingsSync(() => 'token', clock.runtime);
    await until(() => fetchCount === 1, 'the initial read');

    // Raised in the same turn, so both are waiting when the loop next runs.
    saveVirtualKeyboardPreferences({
      ...loadVirtualKeyboardPreferences(),
      toolbarKeys: ['escape', 'paste'],
    });
    await clock.advance(PAST_REVALIDATE_SPACING_MS);
    documentStub.emit('visibilitychange');

    await until(() => saved.length === 1, 'the edit to survive the revalidation');
    expect(saved[0]?.toolbarKeys).toEqual(['escape', 'paste']);
    expect(loadVirtualKeyboardPreferences().toolbarKeys).toEqual(['escape', 'paste']);
  });

  // Every tab runs its own sync, so a tab that missed a sibling's edit would
  // push its stale arrangement over it on the next edit made there.
  test('a sibling tab’s write converges this one rather than being pushed back', async () => {
    remote = {
      macros: [],
      toolbarKeys: [...DEFAULT_TOOLBAR_KEYS],
      layerKeyOrder: DEFAULT_TERMINAL_KEYBOARD_LAYER_KEY_ORDER,
    };
    startKeyboardSettingsSync(() => 'token', clock.runtime);
    await until(() => fetchCount === 1, 'the initial read');

    // Derived from what the module writes rather than restated here, so the key
    // it listens on is asserted to be the key it saves under. Persisting the
    // preferences unchanged is what materialises it, and matches what the
    // account already holds, so it is not itself a change to push.
    saveVirtualKeyboardPreferences(loadVirtualKeyboardPreferences());
    const [storageKey] = [...storage.keys()];
    if (storageKey === undefined) throw new Error('preferences were never persisted');

    const observed: string[][] = [];
    const stop = observeVirtualKeyboardPreferences((preferences) => {
      observed.push([...preferences.toolbarKeys]);
    });
    // What the browser raises in *this* document when another tab on the origin
    // writes: the value lands in storage without this document's custom event.
    const written = { ...loadVirtualKeyboardPreferences(), toolbarKeys: ['tab', 'paste'] };
    const newValue = JSON.stringify(written);
    storage.set(storageKey, newValue);
    window.dispatchEvent(Object.assign(new Event('storage'), { key: storageKey, newValue }));

    expect(observed).toEqual([['tab', 'paste']]);
    stop();
    // This tab cannot know the sibling already pushed, so it pushes the same
    // arrangement once. Identical, therefore harmless — and it is what stops
    // this tab from later pushing the arrangement it would otherwise still be
    // holding. It cannot ping-pong: a push writes no local storage, so the
    // sibling sees no storage event in return.
    await until(() => saved.length === 1, 'the converged tab to agree with the account');
    expect(saved[0]?.toolbarKeys).toEqual(['tab', 'paste']);
    await clock.advance(1_200);
    expect(saved).toHaveLength(1);
  });

  // The caller runs on every credential event, including a session resume. A
  // resume that restarted the loop would drop the unsent edit, then read the
  // account and revert the user's change to the value it just read.
  test('a session resume does not restart the loop, so an unsent edit survives', async () => {
    remote = {
      macros: [],
      toolbarKeys: [...DEFAULT_TOOLBAR_KEYS],
      layerKeyOrder: DEFAULT_TERMINAL_KEYBOARD_LAYER_KEY_ORDER,
    };
    startKeyboardSettingsSync(() => 'token', clock.runtime);
    await until(() => fetchCount === 1, 'the initial read');

    saveFailure = new Error('offline');
    saveVirtualKeyboardPreferences({
      ...loadVirtualKeyboardPreferences(),
      toolbarKeys: ['escape', 'paste'],
    });
    await clock.advance(900);
    // The resume the app performs on every refreshed session.
    startKeyboardSettingsSync(() => 'token', clock.runtime);
    saveFailure = null;

    await until(() => saved.length === 1, 'the unsent edit to reach the account');
    expect(saved[0]?.toolbarKeys).toEqual(['escape', 'paste']);
    expect(loadVirtualKeyboardPreferences().toolbarKeys).toEqual(['escape', 'paste']);
    // One loop, so one read: a second would mean a second fiber was forked.
    expect(fetchCount).toBe(1);
  });

  // `localStorage` throws on quota and in some private modes. An unguarded
  // write inside the loop would kill the fiber, and nothing restarts it.
  test('a storage failure costs the cache, not the sync', async () => {
    const failing = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => {},
    };
    const restore = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    if (restore === undefined) throw new Error('localStorage was never installed');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      writable: true,
      value: failing,
    });
    try {
      remote = { macros: [], toolbarKeys: ['escape'], layerKeyOrder: swappedAlpha() };
      startKeyboardSettingsSync(() => 'token', clock.runtime);
      await until(() => fetchCount === 1, 'the initial read');

      // The adopt path writes storage; the throw must not reach the fiber.
      await clock.advance(PAST_REVALIDATE_SPACING_MS);
      documentStub.emit('visibilitychange');

      await until(() => fetchCount === 2, 'the loop to still be alive afterwards');
    } finally {
      Object.defineProperty(globalThis, 'localStorage', restore);
    }
  });

  test('stopping the sync detaches it, so a later edit reaches no account', async () => {
    remote = {
      macros: [],
      toolbarKeys: [...DEFAULT_TOOLBAR_KEYS],
      layerKeyOrder: DEFAULT_TERMINAL_KEYBOARD_LAYER_KEY_ORDER,
    };
    startKeyboardSettingsSync(() => 'token', clock.runtime);
    await until(() => fetchCount === 1, 'the initial read');

    stopKeyboardSettingsSync();
    saveVirtualKeyboardPreferences({
      ...loadVirtualKeyboardPreferences(),
      toolbarKeys: ['escape'],
    });
    await clock.advance(1_200);

    expect(saved).toHaveLength(0);
  });

  test('without a credential nothing is read or written', async () => {
    startKeyboardSettingsSync(() => null, clock.runtime);
    saveVirtualKeyboardPreferences({
      ...loadVirtualKeyboardPreferences(),
      toolbarKeys: ['escape'],
    });
    await clock.advance(1_200);

    expect(fetchCount).toBe(0);
    expect(saved).toHaveLength(0);
  });
});
