import { describe, expect, test } from 'bun:test';
import {
  decodeInputRecord,
  FUNCTIONAL_KEY,
  KEY_EVENT_PRESS,
  KEY_EVENT_RELEASE,
  KEY_MOD_ALT,
  KEY_MOD_CTRL,
  KEY_MOD_NUM_LOCK,
  KEY_MOD_SHIFT,
  KEY_MOD_SUPER,
} from '@merkur/protocol';
import { resolveKeyboardEvent, resolveRelease, resolveVirtualKey } from './key-record';

interface FakeKeyEvent {
  readonly key: string;
  readonly code: string;
  readonly location?: number;
  readonly shiftKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly altKey?: boolean;
  readonly metaKey?: boolean;
  readonly states?: readonly string[];
}

function keyEvent(fake: FakeKeyEvent): KeyboardEvent {
  return {
    location: 0,
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    getModifierState: (name: string) => fake.states?.includes(name) === true,
    ...fake,
  } as unknown as KeyboardEvent;
}

function decodedPress(fake: FakeKeyEvent) {
  const resolved = resolveKeyboardEvent(keyEvent(fake), KEY_EVENT_PRESS, false);
  if (resolved === null) return null;
  return decodeInputRecord(resolved.record);
}

describe('key records from keyboard events', () => {
  test('named keys are Kitty functional keys and never carry text', () => {
    expect(decodedPress({ key: 'ArrowUp', code: 'ArrowUp' })).toMatchObject({
      key: FUNCTIONAL_KEY.UP,
      text: null,
    });
    expect(decodedPress({ key: 'F5', code: 'F5' })).toMatchObject({ key: FUNCTIONAL_KEY.F1 + 4 });
    expect(decodedPress({ key: 'Escape', code: 'Escape', altKey: true })).toMatchObject({
      key: FUNCTIONAL_KEY.ESCAPE,
      mods: KEY_MOD_ALT,
    });
  });

  test('modifier keys are named by their side', () => {
    expect(decodedPress({ key: 'Shift', code: 'ShiftRight', shiftKey: true })).toMatchObject({
      key: FUNCTIONAL_KEY.RIGHT_SHIFT,
      mods: KEY_MOD_SHIFT,
    });
    expect(decodedPress({ key: 'Meta', code: 'MetaLeft', metaKey: true })).toMatchObject({
      key: FUNCTIONAL_KEY.LEFT_SUPER,
      mods: KEY_MOD_SUPER,
    });
  });

  test('keypad keys follow NumLock and carry the text they typed', () => {
    expect(
      decodedPress({ key: '5', code: 'Numpad5', location: 3, states: ['NumLock'] }),
    ).toMatchObject({ key: FUNCTIONAL_KEY.KP_0 + 5, mods: KEY_MOD_NUM_LOCK, text: '5' });
    expect(decodedPress({ key: 'ArrowLeft', code: 'Numpad4', location: 3 })).toMatchObject({
      key: FUNCTIONAL_KEY.KP_LEFT,
      text: null,
    });
    expect(decodedPress({ key: 'Enter', code: 'NumpadEnter', location: 3 })).toMatchObject({
      key: FUNCTIONAL_KEY.KP_ENTER,
    });
  });

  test('AltGr composes text instead of reporting Ctrl+Alt', () => {
    // German `@` is AltGr+Q; the browser reports Ctrl and Alt held as well.
    expect(
      decodedPress({
        key: '@',
        code: 'KeyQ',
        ctrlKey: true,
        altKey: true,
        states: ['AltGraph'],
      }),
    ).toMatchObject({ key: 0x40, mods: 0, base: 0x71, text: '@' });
  });

  test('a non-Latin letter keeps its own identity and names its US position', () => {
    expect(decodedPress({ key: 'с', code: 'KeyC', ctrlKey: true })).toMatchObject({
      key: 0x441,
      base: 0x63,
      mods: KEY_MOD_CTRL,
      text: null,
    });
  });

  test('dead and unidentified keys have no record', () => {
    expect(decodedPress({ key: 'Unidentified', code: '' })).toBeNull();
    expect(decodedPress({ key: 'Tab', code: 'Tab' })).toMatchObject({ key: FUNCTIONAL_KEY.TAB });
  });

  test('a release reuses the identity and drops the text', () => {
    const press = resolveKeyboardEvent(
      keyEvent({ key: 'A', code: 'KeyA', shiftKey: true }),
      KEY_EVENT_PRESS,
      false,
    );
    if (press === null) throw new Error('Shift+A resolves');
    const release = resolveRelease(press.identity, 0);
    expect(release === null ? null : decodeInputRecord(release.record)).toEqual({
      kind: 'key',
      event: KEY_EVENT_RELEASE,
      key: 0x61,
      mods: 0,
      shifted: null,
      base: null,
      text: null,
    });
    expect(resolveRelease(press.identity, 0)).toBe(release);
  });
});

describe('key records from the on-screen keyboard', () => {
  const none = { shift: false, ctrl: false, alt: false, meta: false };

  test('latched Shift picks the US symbol', () => {
    const resolved = resolveVirtualKey('1', { ...none, shift: true });
    expect(resolved === null ? null : decodeInputRecord(resolved.press.record)).toMatchObject({
      key: 0x21,
      mods: KEY_MOD_SHIFT,
      text: '!',
    });
  });

  test('Shift+Tab is Tab under Shift, and the latched ⌘ is Super', () => {
    const tab = resolveVirtualKey('Shift+Tab', none);
    expect(tab === null ? null : decodeInputRecord(tab.press.record)).toMatchObject({
      key: FUNCTIONAL_KEY.TAB,
      mods: KEY_MOD_SHIFT,
    });
    const cmd = resolveVirtualKey('b', { ...none, meta: true });
    expect(cmd === null ? null : decodeInputRecord(cmd.press.record)).toMatchObject({
      key: 0x62,
      mods: KEY_MOD_SUPER,
      text: null,
    });
  });

  test('resolutions are memoised', () => {
    expect(resolveVirtualKey('a', none)).toBe(resolveVirtualKey('a', none));
  });
});
