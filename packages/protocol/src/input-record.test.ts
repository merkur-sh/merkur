import { describe, expect, test } from 'bun:test';
import {
  decodeInputRecord,
  encodeFocusRecord,
  encodeKeyRecord,
  encodeMouseRecord,
  encodeMouseRecordInto,
  encodePasteRecordInto,
  encodeTextRecord,
  encodeWheelRecord,
  FUNCTIONAL_KEY,
  KEY_EVENT_PRESS,
  KEY_EVENT_RELEASE,
  KEY_MOD_CAPS_LOCK,
  KEY_MOD_CTRL,
  KEY_MOD_SHIFT,
  type KeyRecordFields,
  MOUSE_ACTION_MOTION,
  MOUSE_BUTTON_NONE,
  MOUSE_RECORD_MAX_BYTES,
  WHEEL_DOWN,
} from './input-record';

function key(fields: Partial<KeyRecordFields> & { readonly key: number }): KeyRecordFields {
  return {
    event: KEY_EVENT_PRESS,
    mods: 0,
    shifted: null,
    base: null,
    text: null,
    ...fields,
  };
}

// The same canonical spellings `input_record.rs` pins from the other side.
describe('input record wire vectors', () => {
  test('a plain keystroke is two bytes with its text implied', () => {
    const record = encodeKeyRecord(key({ key: 0x61, text: 'a' }));
    expect([...record]).toEqual([0x00, 0x61]);
    expect(decodeInputRecord(record)).toEqual({ kind: 'key', ...key({ key: 0x61, text: 'a' }) });
  });

  test('Shift+a spells the shifted key and implies its text', () => {
    const fields = key({ key: 0x61, mods: KEY_MOD_SHIFT, shifted: 0x41, text: 'A' });
    expect([...encodeKeyRecord(fields)]).toEqual([0x03, 0x61, 0x01, 0x01, 0x41]);
    expect(decodeInputRecord(encodeKeyRecord(fields))).toEqual({ kind: 'key', ...fields });
  });

  test('functional keys and releases are two bytes', () => {
    expect([...encodeKeyRecord(key({ key: FUNCTIONAL_KEY.UP }))]).toEqual([0x04, 0x08]);
    expect([
      ...encodeKeyRecord(key({ key: FUNCTIONAL_KEY.ENTER, event: KEY_EVENT_RELEASE })),
    ]).toEqual([0x14, 0x01]);
    expect([...encodeKeyRecord(key({ key: 0x61, event: KEY_EVENT_RELEASE }))]).toEqual([
      0x10, 0x61,
    ]);
  });

  test('text differing from the implied text is spelled out, and absent text is marked', () => {
    const caps = key({ key: 0x61, mods: KEY_MOD_CAPS_LOCK, text: 'A' });
    expect([...encodeKeyRecord(caps)]).toEqual([0x03, 0x61, KEY_MOD_CAPS_LOCK, 0x04, 0x41]);
    expect(decodeInputRecord(encodeKeyRecord(caps))).toEqual({ kind: 'key', ...caps });

    const keypad = key({ key: FUNCTIONAL_KEY.KP_0 + 5, text: '5' });
    expect(decodeInputRecord(encodeKeyRecord(keypad))).toEqual({ kind: 'key', ...keypad });

    // A printable key that typed nothing (a dead key's base) says so.
    const silent = key({ key: 0x61, text: null });
    expect([...encodeKeyRecord(silent)]).toEqual([0x01, 0x61, 0x08]);
    expect(decodeInputRecord(encodeKeyRecord(silent))).toEqual({ kind: 'key', ...silent });

    const ctrl = key({ key: 0x63, mods: KEY_MOD_CTRL });
    expect([...encodeKeyRecord(ctrl)]).toEqual([0x02, 0x63, KEY_MOD_CTRL]);
  });

  test('non-ASCII keys and base-layout keys round-trip through LEB128', () => {
    const cyrillic = key({ key: 0x441, base: 0x63, text: 'с' });
    expect(decodeInputRecord(encodeKeyRecord(cyrillic))).toEqual({ kind: 'key', ...cyrillic });
    const astral = key({ key: 0x1f600, text: '😀' });
    expect(decodeInputRecord(encodeKeyRecord(astral))).toEqual({ kind: 'key', ...astral });
  });

  test('every other kind round-trips', () => {
    expect(decodeInputRecord(encodeTextRecord('héllo\n'))).toEqual({
      kind: 'text',
      text: 'héllo\n',
    });
    const buffer = new Uint8Array(16);
    const { length, read } = encodePasteRecordInto(buffer, 'a\x1bb');
    expect(read).toBe(3);
    expect(decodeInputRecord(buffer.subarray(0, length))).toEqual({
      kind: 'paste',
      text: 'a\x1bb',
    });
    expect(
      decodeInputRecord(
        encodeMouseRecord(MOUSE_ACTION_MOTION, MOUSE_BUTTON_NONE, KEY_MOD_CTRL, 300, 7),
      ),
    ).toEqual({
      kind: 'mouse',
      action: MOUSE_ACTION_MOTION,
      button: MOUSE_BUTTON_NONE,
      mods: KEY_MOD_CTRL,
      column: 300,
      row: 7,
    });
    expect(decodeInputRecord(encodeWheelRecord(WHEEL_DOWN, 0, 3, 0, 0))).toEqual({
      kind: 'wheel',
      direction: WHEEL_DOWN,
      mods: 0,
      count: 3,
      column: 0,
      row: 0,
    });
    expect(decodeInputRecord(encodeFocusRecord(true))).toEqual({ kind: 'focus', focused: true });
    expect([...encodeFocusRecord(false)]).toEqual([0xa0]);
  });

  test('a mouse record encoded in place is the record, at every coordinate width', () => {
    const scratch = new Uint8Array(MOUSE_RECORD_MAX_BYTES);
    for (const [column, row] of [
      [0, 0],
      [127, 128],
      [300, 7],
      [16_383, 16_384],
      [0xffff_ffff, 0xffff_ffff],
    ] as const) {
      // What the last report left must not reach this one.
      scratch.fill(0xff);
      const length = encodeMouseRecordInto(
        scratch,
        MOUSE_ACTION_MOTION,
        MOUSE_BUTTON_NONE,
        KEY_MOD_CTRL,
        column,
        row,
      );
      expect(length).toBeLessThanOrEqual(MOUSE_RECORD_MAX_BYTES);
      expect([...scratch.subarray(0, length)]).toEqual([
        ...encodeMouseRecord(MOUSE_ACTION_MOTION, MOUSE_BUTTON_NONE, KEY_MOD_CTRL, column, row),
      ]);
    }
  });

  test('a paste chunk never splits a code point', () => {
    const buffer = new Uint8Array(1 + 4);
    const { length, read } = encodePasteRecordInto(buffer, '€€');
    // Only one three-byte euro fits in four bytes of body.
    expect(read).toBe(1);
    expect(length).toBe(4);
  });

  test('every noncanonical or reserved spelling is rejected', () => {
    const rejected: number[][] = [
      [],
      [6 << 5],
      [(7 << 5) | 1, 0],
      [3 << 3, 0x61],
      [0x00, 0x0d],
      [0x00, 0x7f],
      [0x00, 0x80, 0xc0, 0x03],
      [0x04, 111],
      [0x00, 0x80, 0xb0, 0x03],
      [0x00, 0xe1, 0x00],
      [0x02, 0x61, 0],
      [0x01, 0x61, 0],
      [0x01, 0x61, 0x10],
      [0x01, 0x61, 0x04 | 0x08],
      [0x01, 0x61, 0x04],
      [0x01, 0x61, 0x04, 0x1b],
      [0x01, 0x61, 0x04, 0xff],
      // The text a key implies, spelled out: plain, and shifted.
      [0x01, 0x61, 0x04, 0x61],
      [0x03, 0x61, KEY_MOD_SHIFT, 0x01 | 0x04, 0x41, 0x41],
      // "No text" where the key implies none already: a release, a functional
      // key, a text-suppressing modifier.
      [0x11, 0x61, 0x08],
      [0x05, 0x01, 0x08],
      [0x03, 0x63, KEY_MOD_CTRL, 0x08],
      [0x00, 0x61, 0x62],
      [1 << 5],
      [2 << 5, 0xc3],
      [(1 << 5) | 1, 0x61],
      [3 << 5, 3, 0, 0],
      [3 << 5, 4, 0, 0],
      [3 << 5, 0, 0],
      [(3 << 5) | (3 << 3), 0, 0, 0],
      [4 << 5, 0, 0, 0],
      [(5 << 5) | 2],
      [5 << 5, 0],
    ];
    for (const bytes of rejected) {
      expect(decodeInputRecord(Uint8Array.from(bytes)), JSON.stringify(bytes)).toBeNull();
    }
  });
});
