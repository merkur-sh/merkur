import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { TERMINAL_US_LAYOUT } from '@merkur/keyboard/layouts/terminal-us';

import {
  accountKeyboardSettings,
  addToolbarKey,
  createTerminalKeyboardLayout,
  DEFAULT_TERMINAL_KEYBOARD_LAYER_KEY_ORDER,
  DEFAULT_TOOLBAR_KEYS,
  DEFAULT_VIRTUAL_KEYBOARD_PREFERENCES,
  getToolbarKeyDefinition,
  loadVirtualKeyboardPreferences,
  moveToolbarKey,
  normalizeVirtualKeyboardPreferences,
  observeVirtualKeyboardPreferences,
  removeToolbarKey,
  sameAccountKeyboardSettings,
  saveVirtualKeyboardPreferences,
  swapTerminalKeyboardLayerKeys,
  withAccountKeyboardSettings,
} from './virtual-keyboard';

describe('virtual keyboard preferences', () => {
  test('uses the terminal-first quick access defaults', () => {
    expect(DEFAULT_TOOLBAR_KEYS).toEqual([
      'escape',
      'ctrl',
      'alt',
      'paste',
      'page-up',
      'page-down',
      'tab',
    ]);
  });

  test('normalizes current preferences while preserving customized quick keys', () => {
    const preferences = normalizeVirtualKeyboardPreferences({
      visible: true,
      toolbarExpanded: false,
      macros: [],
      toolbarKeys: ['cmd', 'ctrl', 'cmd', 'hide', 'unknown'],
    });

    expect(preferences.visible).toBe(true);
    expect(preferences.toolbarKeys).toEqual(['cmd', 'ctrl']);
    expect(preferences.layerKeyOrder).toBe(DEFAULT_TERMINAL_KEYBOARD_LAYER_KEY_ORDER);
    expect(preferences.keyPreview).toBe(true);
  });

  test('normalizes the independently configurable key preview', () => {
    const preferences = normalizeVirtualKeyboardPreferences({ keyPreview: false });

    expect(preferences.keyPreview).toBe(false);
  });

  test('rejects a corrupt layer order instead of producing an invalid layout', () => {
    const alpha = [...DEFAULT_TERMINAL_KEYBOARD_LAYER_KEY_ORDER.alpha];
    alpha[1] = alpha[0] ?? 'key-q';
    const preferences = normalizeVirtualKeyboardPreferences({
      layerKeyOrder: {
        ...DEFAULT_TERMINAL_KEYBOARD_LAYER_KEY_ORDER,
        alpha,
      },
    });

    expect(preferences.layerKeyOrder.alpha).toBe(DEFAULT_TERMINAL_KEYBOARD_LAYER_KEY_ORDER.alpha);
  });

  test('swaps key meanings without changing Apple-sized physical slots', () => {
    const reordered = swapTerminalKeyboardLayerKeys(
      DEFAULT_TERMINAL_KEYBOARD_LAYER_KEY_ORDER,
      'alpha',
      0,
      1,
    );
    const layout = createTerminalKeyboardLayout(reordered);
    const firstRow = layout.layers.alpha?.rows[0];
    const defaultRow = TERMINAL_US_LAYOUT.layers.alpha?.rows[0];

    expect(layout).not.toBe(TERMINAL_US_LAYOUT);
    expect(firstRow?.keys[0]?.key).toBe('key-w');
    expect(firstRow?.keys[1]?.key).toBe('key-q');
    expect(firstRow?.keys[0]?.column).toBe(defaultRow?.keys[0]?.column);
    expect(firstRow?.keys[0]?.span).toBe(defaultRow?.keys[0]?.span);
    expect(createTerminalKeyboardLayout(DEFAULT_TERMINAL_KEYBOARD_LAYER_KEY_ORDER)).toBe(
      TERMINAL_US_LAYOUT,
    );
  });

  test('reorders, adds, and removes toolbar keys without duplicates', () => {
    const moved = moveToolbarKey(['escape', 'ctrl', 'cmd'], 2, 0);
    expect(moved).toEqual(['cmd', 'escape', 'ctrl']);
    expect(addToolbarKey(moved, 'ctrl')).toBe(moved);
    const added = addToolbarKey(moved, 'paste');
    expect(added).toEqual(['cmd', 'escape', 'ctrl', 'paste']);
    expect(removeToolbarKey(added, 'escape')).toEqual(['cmd', 'ctrl', 'paste']);
  });
});

const storage = new Map<string, string>();
const savedDescriptors = new Map<string, PropertyDescriptor | undefined>();

/**
 * Installed and restored through descriptors, both ways. `bun test` shares one
 * process across files, so a neighbour may have installed `localStorage`
 * non-writably — which makes a plain assignment throw — and installing it
 * non-writably here would break a neighbour that assigns.
 */
function install(name: string, value: unknown): void {
  savedDescriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

beforeAll(() => {
  install('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  install('window', globalThis);
});

afterAll(() => {
  for (const [name, descriptor] of savedDescriptors) {
    if (descriptor === undefined) Reflect.deleteProperty(globalThis, name);
    else Object.defineProperty(globalThis, name, descriptor);
  }
});

beforeEach(() => {
  storage.clear();
});

/** The single key the module persists under, derived rather than restated. */
function persistedKey(): string {
  saveVirtualKeyboardPreferences(loadVirtualKeyboardPreferences());
  const [key] = [...storage.keys()];
  if (key === undefined) throw new Error('preferences were never persisted');
  return key;
}

const SWAPPED_ALPHA = (() => {
  const alpha = [...DEFAULT_TERMINAL_KEYBOARD_LAYER_KEY_ORDER.alpha];
  const [first, second] = alpha;
  if (first === undefined || second === undefined) throw new Error('alpha layer is too small');
  alpha[0] = second;
  alpha[1] = first;
  return { ...DEFAULT_TERMINAL_KEYBOARD_LAYER_KEY_ORDER, alpha };
})();

describe('the account half of the keyboard preferences', () => {
  // This is the whole split. A field added to the preferences is device-local
  // until someone deliberately widens this, which is the intended default: what
  // a device measured about itself must never travel to another one.
  test('carries the arrangement and nothing else', () => {
    const settings = accountKeyboardSettings({
      visible: true,
      toolbarExpanded: true,
      macros: [],
      toolbarKeys: ['escape'],
      layerKeyOrder: SWAPPED_ALPHA,
      keyPreview: false,
    });

    expect(Object.keys(settings).sort()).toEqual(['layerKeyOrder', 'macros', 'toolbarKeys']);
    expect(settings.toolbarKeys).toEqual(['escape']);
    expect(settings.layerKeyOrder).toBe(SWAPPED_ALPHA);
  });

  test('adopting an arrangement leaves every device-local field untouched', () => {
    const adopted = withAccountKeyboardSettings(
      {
        visible: true,
        toolbarExpanded: true,
        macros: [],
        toolbarKeys: ['tab'],
        layerKeyOrder: DEFAULT_TERMINAL_KEYBOARD_LAYER_KEY_ORDER,
        keyPreview: false,
      },
      { macros: [], toolbarKeys: ['escape'], layerKeyOrder: SWAPPED_ALPHA },
    );

    expect(adopted.visible).toBe(true);
    expect(adopted.toolbarExpanded).toBe(true);
    expect(adopted.keyPreview).toBe(false);
    expect(adopted.toolbarKeys).toEqual(['escape']);
    expect(adopted.layerKeyOrder.alpha).toEqual(SWAPPED_ALPHA.alpha);
  });

  // The value has crossed the network, so it is untrusted here even though the
  // route bounded it: the route knows nothing of this build's key vocabulary.
  test('an arrangement from the wire is normalized, never applied as given', () => {
    const adopted = withAccountKeyboardSettings(DEFAULT_VIRTUAL_KEYBOARD_PREFERENCES, {
      macros: [],
      toolbarKeys: ['escape', 'not-a-key', 'escape', 'hide'],
      // Not a permutation of this build's alpha layer: adopting it as given
      // would build a layout with a duplicated key and a missing one.
      layerKeyOrder: { ...DEFAULT_TERMINAL_KEYBOARD_LAYER_KEY_ORDER, alpha: ['key-q'] },
    });

    expect(adopted.toolbarKeys).toEqual(['escape']);
    expect(adopted.layerKeyOrder.alpha).toBe(DEFAULT_TERMINAL_KEYBOARD_LAYER_KEY_ORDER.alpha);
    // Proves the normalized result is one the layout builder accepts.
    expect(createTerminalKeyboardLayout(adopted.layerKeyOrder)).toBe(TERMINAL_US_LAYOUT);
  });

  test('two arrangements compare by contents, across every layer', () => {
    const base = {
      macros: [],
      toolbarKeys: ['escape'],
      layerKeyOrder: DEFAULT_TERMINAL_KEYBOARD_LAYER_KEY_ORDER,
    };

    expect(sameAccountKeyboardSettings(base, { ...base, toolbarKeys: ['escape'] })).toBe(true);
    expect(sameAccountKeyboardSettings(base, { ...base, toolbarKeys: ['tab'] })).toBe(false);
    expect(sameAccountKeyboardSettings(base, { ...base, toolbarKeys: [] })).toBe(false);
    expect(sameAccountKeyboardSettings(base, { ...base, layerKeyOrder: SWAPPED_ALPHA })).toBe(
      false,
    );
    expect(
      sameAccountKeyboardSettings(base, {
        ...base,
        layerKeyOrder: { ...DEFAULT_TERMINAL_KEYBOARD_LAYER_KEY_ORDER, pc: ['home'] },
      }),
    ).toBe(false);
  });
});

describe('observing preference changes', () => {
  test('reports a write made in this document', () => {
    const seen: string[][] = [];
    const stop = observeVirtualKeyboardPreferences((p) => seen.push([...p.toolbarKeys]));

    saveVirtualKeyboardPreferences({
      ...DEFAULT_VIRTUAL_KEYBOARD_PREFERENCES,
      toolbarKeys: ['escape'],
    });
    stop();

    expect(seen).toEqual([['escape']]);
  });

  // The browser raises `storage` only in the *other* documents on the origin,
  // so this is how a sibling tab's edit reaches this one — and the two sources
  // never double-report the same write.
  test('reports a write made in another tab', () => {
    const key = persistedKey();
    const seen: string[][] = [];
    const stop = observeVirtualKeyboardPreferences((p) => seen.push([...p.toolbarKeys]));

    const newValue = JSON.stringify({
      ...DEFAULT_VIRTUAL_KEYBOARD_PREFERENCES,
      toolbarKeys: ['tab', 'paste'],
    });
    window.dispatchEvent(Object.assign(new Event('storage'), { key, newValue }));
    stop();

    expect(seen).toEqual([['tab', 'paste']]);
  });

  test('a sibling write is normalized like any other untrusted value', () => {
    const key = persistedKey();
    const seen: string[][] = [];
    const stop = observeVirtualKeyboardPreferences((p) => seen.push([...p.toolbarKeys]));

    for (const newValue of ['{"toolbarKeys":', JSON.stringify({ toolbarKeys: ['nope'] })]) {
      window.dispatchEvent(Object.assign(new Event('storage'), { key, newValue }));
    }
    stop();

    expect(seen).toEqual([[...DEFAULT_TOOLBAR_KEYS], []]);
  });

  test('a cleared origin reads as a fresh browser', () => {
    const key = persistedKey();
    const seen: string[][] = [];
    const stop = observeVirtualKeyboardPreferences((p) => seen.push([...p.toolbarKeys]));

    window.dispatchEvent(Object.assign(new Event('storage'), { key, newValue: null }));
    stop();

    expect(seen).toEqual([[...DEFAULT_TOOLBAR_KEYS]]);
  });

  test('another key on the origin is not our business', () => {
    const seen: unknown[] = [];
    const stop = observeVirtualKeyboardPreferences((p) => seen.push(p));

    window.dispatchEvent(
      Object.assign(new Event('storage'), {
        key: 'merkur.terminal.typingOffsets',
        newValue: '{}',
      }),
    );
    stop();

    expect(seen).toEqual([]);
  });

  test('unsubscribing detaches both sources', () => {
    const key = persistedKey();
    const seen: unknown[] = [];
    observeVirtualKeyboardPreferences((p) => seen.push(p))();

    saveVirtualKeyboardPreferences({
      ...DEFAULT_VIRTUAL_KEYBOARD_PREFERENCES,
      toolbarKeys: ['escape'],
    });
    window.dispatchEvent(Object.assign(new Event('storage'), { key, newValue: '{}' }));

    expect(seen).toEqual([]);
  });
});

const interrupt = {
  id: 'macro:interrupt',
  name: 'Interrupt',
  steps: [{ key: 'key-c', ctrl: true, alt: false, shift: false, meta: false }],
} as const;

describe('virtual keyboard macros', () => {
  test('normalizes definitions before resolving toolbar references and rejects recursive or action steps', () => {
    const preferences = normalizeVirtualKeyboardPreferences({
      macros: [
        interrupt,
        interrupt,
        { ...interrupt, id: 'macro:paste', steps: [{ ...interrupt.steps[0], key: 'paste' }] },
        {
          ...interrupt,
          id: 'macro:recursive',
          steps: [{ ...interrupt.steps[0], key: interrupt.id }],
        },
      ],
      toolbarKeys: ['escape', interrupt.id, 'macro:missing', interrupt.id],
    });
    expect(preferences.macros).toEqual([interrupt]);
    expect(preferences.toolbarKeys).toEqual(['escape', interrupt.id]);
    expect(getToolbarKeyDefinition(interrupt.id, preferences.macros)).toEqual({
      id: interrupt.id,
      label: 'Interrupt',
      macro: interrupt.steps,
      wide: true,
    });
    expect(getToolbarKeyDefinition('macro:missing', preferences.macros)).toBeUndefined();
  });

  test('account adoption and persistence carry macro names and steps', () => {
    const account = {
      ...accountKeyboardSettings(DEFAULT_VIRTUAL_KEYBOARD_PREFERENCES),
      macros: [interrupt],
      toolbarKeys: [interrupt.id],
    };
    const adopted = withAccountKeyboardSettings(DEFAULT_VIRTUAL_KEYBOARD_PREFERENCES, account);
    saveVirtualKeyboardPreferences(adopted);
    expect(accountKeyboardSettings(loadVirtualKeyboardPreferences())).toEqual(account);
    expect(
      sameAccountKeyboardSettings(account, {
        ...account,
        macros: [{ ...interrupt, name: 'Stop' }],
      }),
    ).toBe(false);
    expect(
      sameAccountKeyboardSettings(account, {
        ...account,
        macros: [{ ...interrupt, steps: [{ ...interrupt.steps[0], alt: true }] }],
      }),
    ).toBe(false);
    expect(
      sameAccountKeyboardSettings(account, {
        ...account,
        macros: [
          {
            name: interrupt.name,
            steps: [{ meta: false, alt: false, shift: false, key: 'key-c', ctrl: true }],
            id: interrupt.id,
          },
        ],
      }),
    ).toBe(true);
  });

  test('adds only defined macros and preserves toolbar capacity', () => {
    expect(addToolbarKey([], interrupt.id)).toEqual([]);
    expect(addToolbarKey([], interrupt.id, [interrupt])).toEqual([interrupt.id]);
    expect(removeToolbarKey(['escape', interrupt.id], interrupt.id)).toEqual(['escape']);
  });
});
