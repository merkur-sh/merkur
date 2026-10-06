// Browser input records: what the user did, never the bytes an application
// reads. The daemon encodes each record against the terminal it owns
// (Kitty keyboard flags, DECCKM, modifyOtherKeys, bracketed paste, mouse and
// focus reporting), because those modes change in PTY output the browser sees
// a round trip late.
//
// Every `input_run` entry and every `sequenced_keystroke` body is one record.
// Mirrors `packages/merkur-wire/src/input_record.rs`, which rejects any
// spelling but the canonical one produced here.
//
//   Key   0  head[4:3] event, [2] FN, [1] MODS, [0] EXT
//            key: FN ? u8 index (code = 0xE000 + index) : LEB128 code point
//            [mods u8] [ext u8] [shifted LEB128] [base LEB128] [text UTF-8 = rest]
//   Text  1  head | UTF-8
//   Paste 2  head | UTF-8
//   Mouse 3  head[4:3] action, [2:0] shift alt ctrl | button u8 | column LEB128 | row LEB128
//   Wheel 4  head[4:3] direction, [2:0] shift alt ctrl | count u8 | column LEB128 | row LEB128
//   Focus 5  head[0] focused

export const INPUT_RECORD_KIND_KEY = 0;
export const INPUT_RECORD_KIND_TEXT = 1;
export const INPUT_RECORD_KIND_PASTE = 2;
export const INPUT_RECORD_KIND_MOUSE = 3;
export const INPUT_RECORD_KIND_WHEEL = 4;
export const INPUT_RECORD_KIND_FOCUS = 5;

export const KEY_EVENT_PRESS = 0;
export const KEY_EVENT_REPEAT = 1;
export const KEY_EVENT_RELEASE = 2;
export type KeyEvent = typeof KEY_EVENT_PRESS | typeof KEY_EVENT_REPEAT | typeof KEY_EVENT_RELEASE;

/** Kitty's modifier bits, in the protocol's own order. */
export const KEY_MOD_SHIFT = 1;
export const KEY_MOD_ALT = 1 << 1;
export const KEY_MOD_CTRL = 1 << 2;
export const KEY_MOD_SUPER = 1 << 3;
export const KEY_MOD_HYPER = 1 << 4;
export const KEY_MOD_META = 1 << 5;
export const KEY_MOD_CAPS_LOCK = 1 << 6;
export const KEY_MOD_NUM_LOCK = 1 << 7;
/** Modifiers after which a key produces no text of its own. */
export const KEY_MODS_TEXT_SUPPRESSING =
  KEY_MOD_ALT | KEY_MOD_CTRL | KEY_MOD_SUPER | KEY_MOD_HYPER | KEY_MOD_META;

export const MOUSE_ACTION_PRESS = 0;
export const MOUSE_ACTION_RELEASE = 1;
export const MOUSE_ACTION_MOTION = 2;
export type MouseAction =
  | typeof MOUSE_ACTION_PRESS
  | typeof MOUSE_ACTION_RELEASE
  | typeof MOUSE_ACTION_MOTION;

export const MOUSE_BUTTON_LEFT = 0;
export const MOUSE_BUTTON_MIDDLE = 1;
export const MOUSE_BUTTON_RIGHT = 2;
/** Motion with no button held. */
export const MOUSE_BUTTON_NONE = 3;
export type MouseButton =
  | typeof MOUSE_BUTTON_LEFT
  | typeof MOUSE_BUTTON_MIDDLE
  | typeof MOUSE_BUTTON_RIGHT
  | typeof MOUSE_BUTTON_NONE;

export const WHEEL_UP = 0;
export const WHEEL_DOWN = 1;
export const WHEEL_LEFT = 2;
export const WHEEL_RIGHT = 3;
export type WheelDirection =
  | typeof WHEEL_UP
  | typeof WHEEL_DOWN
  | typeof WHEEL_LEFT
  | typeof WHEEL_RIGHT;

/** Pointer records carry Shift, Alt and Ctrl in these bits. */
export const POINTER_MOD_MASK = KEY_MOD_SHIFT | KEY_MOD_ALT | KEY_MOD_CTRL;

/**
 * Kitty's functional keys: its Private Use Area table, in order. A record
 * names every non-text key by one of these, including the ones whose encoding
 * is a legacy escape sequence.
 */
export const FUNCTIONAL_KEY = {
  ESCAPE: 0xe000,
  ENTER: 0xe001,
  TAB: 0xe002,
  BACKSPACE: 0xe003,
  INSERT: 0xe004,
  DELETE: 0xe005,
  LEFT: 0xe006,
  RIGHT: 0xe007,
  UP: 0xe008,
  DOWN: 0xe009,
  PAGE_UP: 0xe00a,
  PAGE_DOWN: 0xe00b,
  HOME: 0xe00c,
  END: 0xe00d,
  CAPS_LOCK: 0xe00e,
  SCROLL_LOCK: 0xe00f,
  NUM_LOCK: 0xe010,
  PRINT_SCREEN: 0xe011,
  PAUSE: 0xe012,
  MENU: 0xe013,
  /** F1 through F35 are consecutive from here. */
  F1: 0xe014,
  /** KP_0 through KP_9 are consecutive from here. */
  KP_0: 0xe037,
  KP_DECIMAL: 0xe041,
  KP_DIVIDE: 0xe042,
  KP_MULTIPLY: 0xe043,
  KP_SUBTRACT: 0xe044,
  KP_ADD: 0xe045,
  KP_ENTER: 0xe046,
  KP_EQUAL: 0xe047,
  KP_SEPARATOR: 0xe048,
  KP_LEFT: 0xe049,
  KP_RIGHT: 0xe04a,
  KP_UP: 0xe04b,
  KP_DOWN: 0xe04c,
  KP_PAGE_UP: 0xe04d,
  KP_PAGE_DOWN: 0xe04e,
  KP_HOME: 0xe04f,
  KP_END: 0xe050,
  KP_INSERT: 0xe051,
  KP_DELETE: 0xe052,
  KP_BEGIN: 0xe053,
  MEDIA_PLAY: 0xe054,
  MEDIA_PAUSE: 0xe055,
  MEDIA_PLAY_PAUSE: 0xe056,
  MEDIA_REVERSE: 0xe057,
  MEDIA_STOP: 0xe058,
  MEDIA_FAST_FORWARD: 0xe059,
  MEDIA_REWIND: 0xe05a,
  MEDIA_TRACK_NEXT: 0xe05b,
  MEDIA_TRACK_PREVIOUS: 0xe05c,
  MEDIA_RECORD: 0xe05d,
  LOWER_VOLUME: 0xe05e,
  RAISE_VOLUME: 0xe05f,
  MUTE_VOLUME: 0xe060,
  LEFT_SHIFT: 0xe061,
  LEFT_CONTROL: 0xe062,
  LEFT_ALT: 0xe063,
  LEFT_SUPER: 0xe064,
  LEFT_HYPER: 0xe065,
  LEFT_META: 0xe066,
  RIGHT_SHIFT: 0xe067,
  RIGHT_CONTROL: 0xe068,
  RIGHT_ALT: 0xe069,
  RIGHT_SUPER: 0xe06a,
  RIGHT_HYPER: 0xe06b,
  RIGHT_META: 0xe06c,
  ISO_LEVEL3_SHIFT: 0xe06d,
  ISO_LEVEL5_SHIFT: 0xe06e,
} as const;

export const FUNCTIONAL_KEY_FIRST = FUNCTIONAL_KEY.ESCAPE;
export const FUNCTIONAL_KEY_LAST = FUNCTIONAL_KEY.ISO_LEVEL5_SHIFT;

const KIND_SHIFT = 5;
const KEY_HEAD_FN = 1 << 2;
const KEY_HEAD_MODS = 1 << 1;
const KEY_HEAD_EXT = 1 << 0;
const EXT_SHIFTED = 1 << 0;
const EXT_BASE = 1 << 1;
const EXT_TEXT = 1 << 2;
const EXT_NO_TEXT = 1 << 3;

/** Longest key record: head, key, mods, ext, two alternates. Text is extra. */
export const KEY_RECORD_FIXED_MAX_BYTES = 1 + 3 + 1 + 1 + 3 + 3;

export function isFunctionalKey(code: number): boolean {
  return code >= FUNCTIONAL_KEY_FIRST && code <= FUNCTIONAL_KEY_LAST;
}

function isControl(code: number): boolean {
  return code < 0x20 || (code >= 0x7f && code <= 0x9f);
}

export interface KeyRecordFields {
  readonly event: KeyEvent;
  /** Kitty's key number: the unshifted code point, or a `FUNCTIONAL_KEY`. */
  readonly key: number;
  readonly mods: number;
  /** The shifted code point, when Shift changes the key. */
  readonly shifted: number | null;
  /** The key at this position on a PC-101 US layout, when it differs. */
  readonly base: number | null;
  /** The text the key produces, or `null` when it produces none. */
  readonly text: string | null;
}

/**
 * The single code point a key implies as its text when its record does not
 * say otherwise. The daemon applies the same rule, so an implied text is
 * never spelled out.
 */
function impliedTextCodePoint(fields: KeyRecordFields): number | null {
  if (fields.event === KEY_EVENT_RELEASE) return null;
  if (isFunctionalKey(fields.key)) return null;
  if ((fields.mods & KEY_MODS_TEXT_SUPPRESSING) !== 0) return null;
  if ((fields.mods & KEY_MOD_SHIFT) !== 0 && fields.shifted !== null) return fields.shifted;
  return fields.key;
}

function isSingleCodePoint(text: string, codePoint: number): boolean {
  const first = text.codePointAt(0);
  return first === codePoint && text.length === (codePoint > 0xffff ? 2 : 1);
}

function leb128Length(value: number): number {
  return value < 0x80
    ? 1
    : value < 0x4000
      ? 2
      : value < 0x20_0000
        ? 3
        : value < 0x1000_0000
          ? 4
          : 5;
}

function writeLeb128(dst: Uint8Array, offset: number, value: number): number {
  let remaining = value >>> 0;
  let position = offset;
  while (remaining >= 0x80) {
    dst[position++] = (remaining & 0x7f) | 0x80;
    remaining >>>= 7;
  }
  dst[position++] = remaining;
  return position;
}

const TEXT_ENCODER = new TextEncoder();

/**
 * Encodes a key record into `dst` at `offset` and returns the offset past it.
 * `dst` must hold `KEY_RECORD_FIXED_MAX_BYTES` plus the text's UTF-8 length.
 */
export function encodeKeyRecordInto(
  dst: Uint8Array,
  offset: number,
  fields: KeyRecordFields,
): number {
  const functional = isFunctionalKey(fields.key);
  const implied = impliedTextCodePoint(fields);
  let ext = 0;
  if (fields.shifted !== null) ext |= EXT_SHIFTED;
  if (fields.base !== null) ext |= EXT_BASE;
  let explicitText: string | null = null;
  if (fields.text === null) {
    if (implied !== null) ext |= EXT_NO_TEXT;
  } else if (implied === null || !isSingleCodePoint(fields.text, implied)) {
    ext |= EXT_TEXT;
    explicitText = fields.text;
  }

  let head = fields.event << 3;
  if (functional) head |= KEY_HEAD_FN;
  if (fields.mods !== 0) head |= KEY_HEAD_MODS;
  if (ext !== 0) head |= KEY_HEAD_EXT;
  let position = offset;
  dst[position++] = head;
  if (functional) {
    dst[position++] = fields.key - FUNCTIONAL_KEY_FIRST;
  } else {
    position = writeLeb128(dst, position, fields.key);
  }
  if (fields.mods !== 0) dst[position++] = fields.mods;
  if (ext !== 0) dst[position++] = ext;
  if (fields.shifted !== null) position = writeLeb128(dst, position, fields.shifted);
  if (fields.base !== null) position = writeLeb128(dst, position, fields.base);
  if (explicitText !== null) {
    position += TEXT_ENCODER.encodeInto(explicitText, dst.subarray(position)).written;
  }
  return position;
}

/** A key record as its own buffer, exactly sized. */
export function encodeKeyRecord(fields: KeyRecordFields): Uint8Array {
  const text = fields.text === null ? 0 : fields.text.length * 3;
  const scratch = new Uint8Array(KEY_RECORD_FIXED_MAX_BYTES + text);
  return scratch.slice(0, encodeKeyRecordInto(scratch, 0, fields));
}

/** Whether a key record can be built from these fields at all. */
export function isEncodableKey(fields: KeyRecordFields): boolean {
  if (!Number.isInteger(fields.key) || fields.key < 0 || fields.key > 0x10ffff) return false;
  if (fields.key >= 0xd800 && fields.key <= 0xdfff) return false;
  if (
    !isFunctionalKey(fields.key) &&
    (isControl(fields.key) || (fields.key >= 0xe000 && fields.key <= 0xe06e))
  ) {
    return false;
  }
  if (fields.shifted !== null && (isControl(fields.shifted) || fields.shifted > 0x10ffff))
    return false;
  if (fields.text !== null) {
    if (fields.text.length === 0) return false;
    for (const c of fields.text) {
      const code = c.codePointAt(0) ?? 0;
      if (isControl(code)) return false;
    }
  }
  return true;
}

function kindRecord(kind: number, text: string): Uint8Array {
  const body = TEXT_ENCODER.encode(text);
  const record = new Uint8Array(1 + body.length);
  record[0] = kind << KIND_SHIFT;
  record.set(body, 1);
  return record;
}

/** Committed text: an IME commit, an on-screen keyboard insertion. */
export function encodeTextRecord(text: string): Uint8Array {
  return kindRecord(INPUT_RECORD_KIND_TEXT, text);
}

/**
 * Encodes as much of `text` as fits in `dst` as one paste record, never
 * splitting a code point. Returns the record length and how many UTF-16 units
 * of `text` it consumed.
 */
export function encodePasteRecordInto(
  dst: Uint8Array,
  text: string,
): { readonly length: number; readonly read: number } {
  dst[0] = INPUT_RECORD_KIND_PASTE << KIND_SHIFT;
  const { read, written } = TEXT_ENCODER.encodeInto(text, dst.subarray(1));
  return { length: 1 + written, read };
}

/** The longest mouse record: two bytes and two LEB128 `u32` coordinates. */
export const MOUSE_RECORD_MAX_BYTES = 12;

/**
 * Encodes a mouse record at the start of `dst`, which holds at least
 * `MOUSE_RECORD_MAX_BYTES`, and returns its length. For a caller that reports
 * every cell a pointer crosses and keeps one record to do it in.
 */
export function encodeMouseRecordInto(
  dst: Uint8Array,
  action: MouseAction,
  button: MouseButton,
  mods: number,
  column: number,
  row: number,
): number {
  dst[0] = (INPUT_RECORD_KIND_MOUSE << KIND_SHIFT) | (action << 3) | (mods & POINTER_MOD_MASK);
  dst[1] = button;
  return writeLeb128(dst, writeLeb128(dst, 2, column), row);
}

export function encodeMouseRecord(
  action: MouseAction,
  button: MouseButton,
  mods: number,
  column: number,
  row: number,
): Uint8Array {
  const record = new Uint8Array(2 + leb128Length(column) + leb128Length(row));
  encodeMouseRecordInto(record, action, button, mods, column, row);
  return record;
}

export function encodeWheelRecord(
  direction: WheelDirection,
  mods: number,
  count: number,
  column: number,
  row: number,
): Uint8Array {
  const record = new Uint8Array(2 + leb128Length(column) + leb128Length(row));
  record[0] =
    (INPUT_RECORD_KIND_WHEEL << KIND_SHIFT) | (direction << 3) | (mods & POINTER_MOD_MASK);
  record[1] = count;
  writeLeb128(record, writeLeb128(record, 2, column), row);
  return record;
}

export function encodeFocusRecord(focused: boolean): Uint8Array {
  return Uint8Array.of((INPUT_RECORD_KIND_FOCUS << KIND_SHIFT) | (focused ? 1 : 0));
}

export type DecodedInputRecord =
  | ({ readonly kind: 'key' } & KeyRecordFields)
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'paste'; readonly text: string }
  | {
      readonly kind: 'mouse';
      readonly action: MouseAction;
      readonly button: MouseButton;
      readonly mods: number;
      readonly column: number;
      readonly row: number;
    }
  | {
      readonly kind: 'wheel';
      readonly direction: WheelDirection;
      readonly mods: number;
      readonly count: number;
      readonly column: number;
      readonly row: number;
    }
  | { readonly kind: 'focus'; readonly focused: boolean };

const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true });

/**
 * A key record's text from its extension byte, the code point the key implies
 * and its trailing bytes (`null` when they are not UTF-8), or `undefined` for a
 * spelling `encodeKeyRecordInto` never writes.
 */
function keyText(
  ext: number,
  implied: number | null,
  trailing: string | null,
): string | null | undefined {
  if ((ext & EXT_TEXT) !== 0) {
    if (trailing === null || trailing.length === 0) return undefined;
    for (const c of trailing) if (isControl(c.codePointAt(0) ?? 0)) return undefined;
    // The text a key implies is never spelled out.
    if (implied !== null && isSingleCodePoint(trailing, implied)) return undefined;
    return trailing;
  }
  if (trailing !== '') return undefined;
  // "No text" is spelled only where the key would imply some.
  if ((ext & EXT_NO_TEXT) !== 0) return implied === null ? undefined : null;
  return implied === null ? null : String.fromCodePoint(implied);
}

/**
 * Decodes one canonical record, or `null` for anything the daemon rejects.
 * Diagnostics and conformance tests only; the browser never reads a record.
 */
export function decodeInputRecord(bytes: Uint8Array): DecodedInputRecord | null {
  if (bytes.length === 0) return null;
  const head = bytes[0] ?? 0;
  let position = 1;
  const byte = (): number | null => (position < bytes.length ? (bytes[position++] ?? null) : null);
  const leb128 = (): number | null => {
    let value = 0;
    for (let shift = 0; shift < 35; shift += 7) {
      const next = byte();
      if (next === null) return null;
      const group = next & 0x7f;
      if (shift === 28 && group > 0x0f) return null;
      value += group * 2 ** shift;
      if ((next & 0x80) === 0) return next === 0 && shift !== 0 ? null : value;
    }
    return null;
  };
  const scalar = (): number | null => {
    const value = leb128();
    if (value === null || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) return null;
    return value;
  };
  const utf8 = (from: number): string | null => {
    try {
      return STRICT_UTF8.decode(bytes.subarray(from));
    } catch {
      return null;
    }
  };
  switch (head >> KIND_SHIFT) {
    case INPUT_RECORD_KIND_KEY: {
      const event = (head >> 3) & 0b11;
      if (event === 3) return null;
      const functional = (head & KEY_HEAD_FN) !== 0;
      let key: number | null;
      if (functional) {
        const index = byte();
        key = index === null ? null : FUNCTIONAL_KEY_FIRST + index;
        if (key !== null && key > FUNCTIONAL_KEY_LAST) return null;
      } else {
        key = scalar();
        if (key !== null && (isControl(key) || isFunctionalKey(key))) return null;
      }
      if (key === null) return null;
      let mods = 0;
      if ((head & KEY_HEAD_MODS) !== 0) {
        const value = byte();
        if (value === null || value === 0) return null;
        mods = value;
      }
      let ext = 0;
      if ((head & KEY_HEAD_EXT) !== 0) {
        const value = byte();
        if (value === null || value === 0 || (value & ~0b1111) !== 0) return null;
        if ((value & (EXT_TEXT | EXT_NO_TEXT)) === (EXT_TEXT | EXT_NO_TEXT)) return null;
        ext = value;
      }
      let shifted: number | null = null;
      if ((ext & EXT_SHIFTED) !== 0) {
        shifted = scalar();
        if (shifted === null || isControl(shifted)) return null;
      }
      let base: number | null = null;
      if ((ext & EXT_BASE) !== 0) {
        base = scalar();
        if (base === null) return null;
      }
      const partial: KeyRecordFields = {
        event: event as KeyEvent,
        key,
        mods,
        shifted,
        base,
        text: null,
      };
      const text = keyText(ext, impliedTextCodePoint(partial), utf8(position));
      if (text === undefined) return null;
      return { kind: 'key', ...partial, text };
    }
    case INPUT_RECORD_KIND_TEXT:
    case INPUT_RECORD_KIND_PASTE: {
      if ((head & 0b1_1111) !== 0 || bytes.length === 1) return null;
      const text = utf8(1);
      if (text === null) return null;
      return head >> KIND_SHIFT === INPUT_RECORD_KIND_TEXT
        ? { kind: 'text', text }
        : { kind: 'paste', text };
    }
    case INPUT_RECORD_KIND_MOUSE: {
      const action = (head >> 3) & 0b11;
      if (action === 3) return null;
      const button = byte();
      if (button === null || button > 3) return null;
      if (button === MOUSE_BUTTON_NONE && action !== MOUSE_ACTION_MOTION) return null;
      const column = leb128();
      const row = leb128();
      if (column === null || row === null || position !== bytes.length) return null;
      return {
        kind: 'mouse',
        action: action as MouseAction,
        button: button as MouseButton,
        mods: head & POINTER_MOD_MASK,
        column,
        row,
      };
    }
    case INPUT_RECORD_KIND_WHEEL: {
      const count = byte();
      if (count === null || count === 0) return null;
      const column = leb128();
      const row = leb128();
      if (column === null || row === null || position !== bytes.length) return null;
      return {
        kind: 'wheel',
        direction: ((head >> 3) & 0b11) as WheelDirection,
        mods: head & POINTER_MOD_MASK,
        count,
        column,
        row,
      };
    }
    case INPUT_RECORD_KIND_FOCUS:
      if ((head & 0b1_1110) !== 0 || bytes.length !== 1) return null;
      return { kind: 'focus', focused: (head & 1) !== 0 };
    default:
      return null;
  }
}
