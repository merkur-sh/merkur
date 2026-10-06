import { describe, expect, test } from 'bun:test';

import {
  type AccountKeyboardSettings,
  isAccountKeyboardSettings,
  MAX_KEYBOARD_KEY_ID_LENGTH,
  MAX_KEYBOARD_LAYER_KEYS,
  MAX_KEYBOARD_MACRO_NAME_LENGTH,
  MAX_KEYBOARD_MACRO_STEPS,
  MAX_KEYBOARD_MACROS,
  MAX_TOOLBAR_KEYS,
  TERMINAL_KEYBOARD_LAYER_IDS,
} from './keyboard-settings';

const valid: AccountKeyboardSettings = {
  macros: [],
  toolbarKeys: ['escape', 'ctrl'],
  layerKeyOrder: { alpha: ['key-a'], numbers: ['key-1'], symbols: ['at'], pc: ['home'] },
};

function withLayerKeys(layerId: string, keys: readonly string[]): unknown {
  return { ...valid, layerKeyOrder: { ...valid.layerKeyOrder, [layerId]: keys } };
}

describe('account keyboard settings guard', () => {
  test('accepts a settings blob naming every layer', () => {
    expect(isAccountKeyboardSettings(valid)).toBe(true);
  });

  test('accepts empty arrays, because an empty toolbar is a real choice', () => {
    expect(
      isAccountKeyboardSettings({
        macros: [],
        toolbarKeys: [],
        layerKeyOrder: { alpha: [], numbers: [], symbols: [], pc: [] },
      }),
    ).toBe(true);
  });

  test('rejects a blob missing a layer, so a partial write cannot be adopted', () => {
    const { pc: _pc, ...withoutPc } = valid.layerKeyOrder;
    expect(isAccountKeyboardSettings({ ...valid, layerKeyOrder: withoutPc })).toBe(false);
  });

  test('rejects unknown properties on either level', () => {
    expect(isAccountKeyboardSettings({ ...valid, keyPreview: true })).toBe(false);
    expect(
      isAccountKeyboardSettings({
        ...valid,
        layerKeyOrder: { ...valid.layerKeyOrder, emoji: ['key-a'] },
      }),
    ).toBe(false);
  });

  test('rejects non-string and empty key ids', () => {
    expect(isAccountKeyboardSettings({ ...valid, toolbarKeys: ['escape', 7] })).toBe(false);
    expect(isAccountKeyboardSettings({ ...valid, toolbarKeys: [''] })).toBe(false);
    expect(isAccountKeyboardSettings(withLayerKeys('alpha', ['key-a', null as never]))).toBe(false);
  });

  // The bounds are the only thing standing between an untrusted body and
  // unbounded per-account storage, so each one is asserted at its edge.
  test('bounds the toolbar length', () => {
    const atLimit = Array.from({ length: MAX_TOOLBAR_KEYS }, (_, index) => `key-${index}`);
    expect(isAccountKeyboardSettings({ ...valid, toolbarKeys: atLimit })).toBe(true);
    expect(isAccountKeyboardSettings({ ...valid, toolbarKeys: [...atLimit, 'one-more'] })).toBe(
      false,
    );
  });

  test('bounds each layer length', () => {
    const atLimit = Array.from({ length: MAX_KEYBOARD_LAYER_KEYS }, (_, index) => `key-${index}`);
    expect(isAccountKeyboardSettings(withLayerKeys('alpha', atLimit))).toBe(true);
    expect(isAccountKeyboardSettings(withLayerKeys('alpha', [...atLimit, 'one-more']))).toBe(false);
  });

  test('bounds key id length', () => {
    expect(
      isAccountKeyboardSettings({
        ...valid,
        macros: [],
        toolbarKeys: ['k'.repeat(MAX_KEYBOARD_KEY_ID_LENGTH)],
      }),
    ).toBe(true);
    expect(
      isAccountKeyboardSettings({
        ...valid,
        macros: [],
        toolbarKeys: ['k'.repeat(MAX_KEYBOARD_KEY_ID_LENGTH + 1)],
      }),
    ).toBe(false);
  });

  test('rejects the shapes a corrupt or hostile row can take', () => {
    expect(isAccountKeyboardSettings(null)).toBe(false);
    expect(isAccountKeyboardSettings('escape')).toBe(false);
    expect(isAccountKeyboardSettings([])).toBe(false);
    expect(isAccountKeyboardSettings({ toolbarKeys: [] })).toBe(false);
    expect(isAccountKeyboardSettings({ ...valid, layerKeyOrder: null })).toBe(false);
  });

  test('the guard covers exactly the layers the contract names', () => {
    expect(Object.keys(valid.layerKeyOrder)).toEqual([...TERMINAL_KEYBOARD_LAYER_IDS]);
  });
});

const macro = {
  id: 'macro:interrupt',
  name: 'Interrupt',
  steps: [{ key: 'key-c', ctrl: true, alt: false, shift: false, meta: false }],
} as const;

describe('account keyboard macros', () => {
  test('requires the current shape, accepts bounded macros and rejects duplicate identities', () => {
    expect(isAccountKeyboardSettings({ ...valid, macros: [macro] })).toBe(true);
    const { macros: _macros, ...oldShape } = valid;
    expect(isAccountKeyboardSettings(oldShape)).toBe(false);
    expect(isAccountKeyboardSettings({ ...valid, macros: [macro, macro] })).toBe(false);
  });

  test('rejects malformed names, identities, modifiers and empty sequences', () => {
    for (const changed of [
      { id: 'escape' },
      { id: 'macro:' },
      { name: ' ' },
      { name: 'x'.repeat(MAX_KEYBOARD_MACRO_NAME_LENGTH + 1) },
      { steps: [] },
      { steps: [{ ...macro.steps[0], ctrl: 'true' }] },
      { steps: [{ ...macro.steps[0], key: '' }] },
      { steps: [{ ...macro.steps[0], action: 'paste' }] },
    ])
      expect(isAccountKeyboardSettings({ ...valid, macros: [{ ...macro, ...changed }] })).toBe(
        false,
      );
  });

  test('bounds macro count and steps at both edges', () => {
    const macros = Array.from({ length: MAX_KEYBOARD_MACROS }, (_, index) => ({
      ...macro,
      id: `macro:${index}`,
    }));
    expect(isAccountKeyboardSettings({ ...valid, macros })).toBe(true);
    expect(
      isAccountKeyboardSettings({ ...valid, macros: [...macros, { ...macro, id: 'macro:extra' }] }),
    ).toBe(false);
    const steps = Array.from({ length: MAX_KEYBOARD_MACRO_STEPS }, () => macro.steps[0]);
    expect(isAccountKeyboardSettings({ ...valid, macros: [{ ...macro, steps }] })).toBe(true);
    expect(
      isAccountKeyboardSettings({
        ...valid,
        macros: [{ ...macro, steps: [...steps, macro.steps[0]] }],
      }),
    ).toBe(false);
  });
});
