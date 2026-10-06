// What a key press IS, as a Kitty key record — never the bytes an application
// reads. The daemon encodes records against the terminal it owns; this module
// only has to state the facts the browser actually knows about a key: its
// identity, its modifiers, its event type and the text it produced.
//
// Key identity uses exact facts only. With Shift up the unshifted key is
// `event.key`; a cased letter is lowercased; a Shift that chose a symbol keeps
// the produced symbol and its Shift, which is the form tmux normalises every
// key to. No layout map and no US-layout guess stand in for the unshifted key.
// The base-layout key Kitty reports alongside is the PC-101 key at the same
// position, which is exactly what `event.code` names.
//
// Every resolution is memoised and the returned records are immutable, so the
// keystroke path allocates nothing after a key's first use: the input ring
// copies a record synchronously, and a queued record holds the cached array.

import {
  encodeKeyRecord,
  FUNCTIONAL_KEY,
  isEncodableKey,
  KEY_EVENT_PRESS,
  KEY_EVENT_RELEASE,
  KEY_MOD_ALT,
  KEY_MOD_CAPS_LOCK,
  KEY_MOD_CTRL,
  KEY_MOD_NUM_LOCK,
  KEY_MOD_SHIFT,
  KEY_MOD_SUPER,
  KEY_MODS_TEXT_SUPPRESSING,
  type KeyEvent,
  type KeyRecordFields,
} from '@merkur/protocol';
import { TERMINAL_MODE_KEY_RELEASES, TERMINAL_MODE_MODIFIER_KEYS } from '@merkur/shared';

export interface TerminalModifierState {
  readonly shift: boolean;
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly meta: boolean;
}

/** The identity a press and its release share. */
export interface KeyIdentity {
  readonly key: number;
  readonly shifted: number | null;
  readonly base: number | null;
}

export interface ResolvedKey {
  readonly record: Uint8Array;
  readonly identity: KeyIdentity;
  readonly mods: number;
  /**
   * The terminal mode bits that must all be set for this record to encode to
   * any bytes, or `REPORTED_ALWAYS` for a press or repeat of a key that is not
   * a modifier or lock. Anything else (a release, a bare modifier) is never
   * shadow-modelled, never flushes predictions, is not an input whose latency
   * anyone waits on, and waits in the input ring until these bits are set.
   */
  readonly reportedWhen: number;
  /** The single code point the key typed, or -1 when it typed no single one. */
  readonly textCodePoint: number;
}

/** `reportedWhen` of input every application receives: always sent, and awaited. */
export const REPORTED_ALWAYS = 0;

/** Physical Option on Apple platforms, where the right one composes text. */
export const IS_APPLE_PLATFORM =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform ?? '');

const NAMED_KEYS: Record<string, number> = {
  Escape: FUNCTIONAL_KEY.ESCAPE,
  Enter: FUNCTIONAL_KEY.ENTER,
  Tab: FUNCTIONAL_KEY.TAB,
  Backspace: FUNCTIONAL_KEY.BACKSPACE,
  Insert: FUNCTIONAL_KEY.INSERT,
  Delete: FUNCTIONAL_KEY.DELETE,
  ArrowLeft: FUNCTIONAL_KEY.LEFT,
  ArrowRight: FUNCTIONAL_KEY.RIGHT,
  ArrowUp: FUNCTIONAL_KEY.UP,
  ArrowDown: FUNCTIONAL_KEY.DOWN,
  PageUp: FUNCTIONAL_KEY.PAGE_UP,
  PageDown: FUNCTIONAL_KEY.PAGE_DOWN,
  Home: FUNCTIONAL_KEY.HOME,
  End: FUNCTIONAL_KEY.END,
  CapsLock: FUNCTIONAL_KEY.CAPS_LOCK,
  ScrollLock: FUNCTIONAL_KEY.SCROLL_LOCK,
  NumLock: FUNCTIONAL_KEY.NUM_LOCK,
  PrintScreen: FUNCTIONAL_KEY.PRINT_SCREEN,
  Pause: FUNCTIONAL_KEY.PAUSE,
  ContextMenu: FUNCTIONAL_KEY.MENU,
  MediaPlay: FUNCTIONAL_KEY.MEDIA_PLAY,
  MediaPause: FUNCTIONAL_KEY.MEDIA_PAUSE,
  MediaPlayPause: FUNCTIONAL_KEY.MEDIA_PLAY_PAUSE,
  MediaStop: FUNCTIONAL_KEY.MEDIA_STOP,
  MediaFastForward: FUNCTIONAL_KEY.MEDIA_FAST_FORWARD,
  MediaRewind: FUNCTIONAL_KEY.MEDIA_REWIND,
  MediaTrackNext: FUNCTIONAL_KEY.MEDIA_TRACK_NEXT,
  MediaTrackPrevious: FUNCTIONAL_KEY.MEDIA_TRACK_PREVIOUS,
  MediaRecord: FUNCTIONAL_KEY.MEDIA_RECORD,
  AudioVolumeDown: FUNCTIONAL_KEY.LOWER_VOLUME,
  AudioVolumeUp: FUNCTIONAL_KEY.RAISE_VOLUME,
  AudioVolumeMute: FUNCTIONAL_KEY.MUTE_VOLUME,
  AltGraph: FUNCTIONAL_KEY.ISO_LEVEL3_SHIFT,
};

// F1 through F35 are consecutive in Kitty's table.
for (let n = 1; n <= 35; n += 1) NAMED_KEYS[`F${n}`] = FUNCTIONAL_KEY.F1 + n - 1;

/** Kitty's modifier and lock keys, which report state rather than type. */
function isModifierKey(key: number): boolean {
  return (
    (key >= FUNCTIONAL_KEY.LEFT_SHIFT && key <= FUNCTIONAL_KEY.ISO_LEVEL5_SHIFT) ||
    key === FUNCTIONAL_KEY.CAPS_LOCK ||
    key === FUNCTIONAL_KEY.NUM_LOCK ||
    key === FUNCTIONAL_KEY.SCROLL_LOCK
  );
}

/** Modifier keys are named by their position, which only `code` carries. */
const MODIFIER_CODES: Readonly<Record<string, number>> = {
  ShiftLeft: FUNCTIONAL_KEY.LEFT_SHIFT,
  ShiftRight: FUNCTIONAL_KEY.RIGHT_SHIFT,
  ControlLeft: FUNCTIONAL_KEY.LEFT_CONTROL,
  ControlRight: FUNCTIONAL_KEY.RIGHT_CONTROL,
  AltLeft: FUNCTIONAL_KEY.LEFT_ALT,
  AltRight: FUNCTIONAL_KEY.RIGHT_ALT,
  MetaLeft: FUNCTIONAL_KEY.LEFT_SUPER,
  MetaRight: FUNCTIONAL_KEY.RIGHT_SUPER,
  OSLeft: FUNCTIONAL_KEY.LEFT_SUPER,
  OSRight: FUNCTIONAL_KEY.RIGHT_SUPER,
};

/** Keypad keys by the key they produced, so NumLock decides digit or motion. */
const KEYPAD_KEYS: Readonly<Record<string, number>> = {
  Enter: FUNCTIONAL_KEY.KP_ENTER,
  Insert: FUNCTIONAL_KEY.KP_INSERT,
  Delete: FUNCTIONAL_KEY.KP_DELETE,
  Home: FUNCTIONAL_KEY.KP_HOME,
  End: FUNCTIONAL_KEY.KP_END,
  PageUp: FUNCTIONAL_KEY.KP_PAGE_UP,
  PageDown: FUNCTIONAL_KEY.KP_PAGE_DOWN,
  ArrowUp: FUNCTIONAL_KEY.KP_UP,
  ArrowDown: FUNCTIONAL_KEY.KP_DOWN,
  ArrowLeft: FUNCTIONAL_KEY.KP_LEFT,
  ArrowRight: FUNCTIONAL_KEY.KP_RIGHT,
  Clear: FUNCTIONAL_KEY.KP_BEGIN,
};

const KEYPAD_CODES: Readonly<Record<string, number>> = {
  NumpadDecimal: FUNCTIONAL_KEY.KP_DECIMAL,
  NumpadDivide: FUNCTIONAL_KEY.KP_DIVIDE,
  NumpadMultiply: FUNCTIONAL_KEY.KP_MULTIPLY,
  NumpadSubtract: FUNCTIONAL_KEY.KP_SUBTRACT,
  NumpadAdd: FUNCTIONAL_KEY.KP_ADD,
  NumpadEqual: FUNCTIONAL_KEY.KP_EQUAL,
  NumpadComma: FUNCTIONAL_KEY.KP_SEPARATOR,
  NumpadEnter: FUNCTIONAL_KEY.KP_ENTER,
};

/** The PC-101 US key at each physical position that carries a character. */
const US_KEY_AT_CODE: Readonly<Record<string, string>> = {
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Space: ' ',
};

/** Merkur's on-screen keyboard is a US layout; Shift picks these symbols. */
const US_SHIFTED_SYMBOLS: Readonly<Record<string, string>> = {
  '`': '~',
  '1': '!',
  '2': '@',
  '3': '#',
  '4': '$',
  '5': '%',
  '6': '^',
  '7': '&',
  '8': '*',
  '9': '(',
  '0': ')',
  '-': '_',
  '=': '+',
  '[': '{',
  ']': '}',
  '\\': '|',
  ';': ':',
  "'": '"',
  ',': '<',
  '.': '>',
  '/': '?',
};

const DOM_KEY_LOCATION_NUMPAD = 3;

function usKeyAtCode(code: string): string | null {
  if (code.length === 4 && code.startsWith('Key')) return code.slice(3).toLowerCase();
  if (code.length === 6 && code.startsWith('Digit')) return code.slice(5);
  return US_KEY_AT_CODE[code] ?? null;
}

/** The only code point of `value`, or -1. */
function soleCodePoint(value: string): number {
  const codePoint = value.codePointAt(0);
  if (codePoint === undefined) return -1;
  return value.length === (codePoint > 0xffff ? 2 : 1) ? codePoint : -1;
}

function isPrintable(codePoint: number): boolean {
  return codePoint >= 0x20 && !(codePoint >= 0x7f && codePoint <= 0x9f);
}

/**
 * The identity of a character key: its unshifted code point and, for a cased
 * letter, the shifted one.
 */
function characterIdentity(produced: string, base: string | null): KeyIdentity | null {
  const producedCodePoint = soleCodePoint(produced);
  if (producedCodePoint < 0 || !isPrintable(producedCodePoint)) return null;
  const lower = produced.toLowerCase();
  const upper = produced.toUpperCase();
  const lowerCodePoint = soleCodePoint(lower);
  const upperCodePoint = soleCodePoint(upper);
  const cased = lowerCodePoint >= 0 && upperCodePoint >= 0 && lowerCodePoint !== upperCodePoint;
  const key = cased ? lowerCodePoint : producedCodePoint;
  const baseCodePoint = base === null ? -1 : soleCodePoint(base);
  return {
    key,
    shifted: cased ? upperCodePoint : null,
    base: baseCodePoint >= 0 && baseCodePoint !== key ? baseCodePoint : null,
  };
}

interface EventFacts {
  readonly identity: KeyIdentity;
  /** The text the key typed, before modifiers decide whether it counts. */
  readonly produced: string | null;
}

/** A key's identity from a DOM event, or null for a key nothing may report. */
function eventFacts(event: KeyboardEvent, altComposes: boolean): EventFacts | null {
  const modifier = MODIFIER_CODES[event.code];
  if (modifier !== undefined)
    return { identity: { key: modifier, shifted: null, base: null }, produced: null };
  if (event.location === DOM_KEY_LOCATION_NUMPAD) {
    const byCode = KEYPAD_CODES[event.code];
    const digit =
      event.code.length === 7 && event.code.startsWith('Numpad') ? event.code.slice(6) : '';
    const byKey = KEYPAD_KEYS[event.key];
    const keypad =
      byKey ??
      (digit >= '0' && digit <= '9' && event.key === digit
        ? FUNCTIONAL_KEY.KP_0 + Number(digit)
        : byCode);
    if (keypad !== undefined) {
      const produced = soleCodePoint(event.key) >= 0 ? event.key : null;
      return { identity: { key: keypad, shifted: null, base: null }, produced };
    }
  }
  const named = NAMED_KEYS[event.key];
  if (named !== undefined)
    return { identity: { key: named, shifted: null, base: null }, produced: null };
  const base = usKeyAtCode(event.code);
  // Alt that is a modifier, not a composer: the key is the one at its position
  // (macOS reports the composed character, which is not what Alt+key names).
  if (
    event.altKey &&
    !altComposes &&
    !event.getModifierState('AltGraph') &&
    IS_APPLE_PLATFORM &&
    base !== null
  ) {
    const identity = characterIdentity(event.shiftKey ? base.toUpperCase() : base, base);
    return identity === null ? null : { identity, produced: null };
  }
  const identity = characterIdentity(event.key, base);
  return identity === null ? null : { identity, produced: event.key };
}

function eventMods(event: KeyboardEvent, altComposes: boolean): number {
  // AltGr is Ctrl+Alt to the browser and a text-composing shift to the user.
  const altGraph = event.getModifierState('AltGraph');
  let mods = 0;
  if (event.shiftKey) mods |= KEY_MOD_SHIFT;
  if (event.altKey && !altGraph && !altComposes) mods |= KEY_MOD_ALT;
  if (event.ctrlKey && !altGraph) mods |= KEY_MOD_CTRL;
  if (event.metaKey) mods |= KEY_MOD_SUPER;
  if (event.getModifierState('CapsLock')) mods |= KEY_MOD_CAPS_LOCK;
  if (event.getModifierState('NumLock')) mods |= KEY_MOD_NUM_LOCK;
  return mods;
}

function textFor(produced: string | null, mods: number, event: KeyEvent): string | null {
  if (produced === null || event === KEY_EVENT_RELEASE) return null;
  if ((mods & KEY_MODS_TEXT_SUPPRESSING) !== 0) return null;
  return produced;
}

function resolve(
  identity: KeyIdentity,
  mods: number,
  event: KeyEvent,
  text: string | null,
): ResolvedKey | null {
  const fields: KeyRecordFields = {
    event,
    key: identity.key,
    mods,
    // The daemon reads the shifted key only while Shift is held, so it rides
    // along only then: a plain letter stays a two-byte record.
    shifted: (mods & KEY_MOD_SHIFT) !== 0 ? identity.shifted : null,
    base: identity.base,
    text,
  };
  if (!isEncodableKey(fields)) return null;
  return {
    record: encodeKeyRecord(fields),
    identity,
    mods,
    reportedWhen: reportedWhen(event, identity.key),
    textCodePoint: text === null ? -1 : soleCodePoint(text),
  };
}

/**
 * When the daemon's encoder gives a key event any bytes: a release only under
 * Kitty's event reporting, a modifier only when every key is reported, a
 * modifier's release under both.
 */
function reportedWhen(event: KeyEvent, key: number): number {
  const modifier = isModifierKey(key) ? TERMINAL_MODE_MODIFIER_KEYS : REPORTED_ALWAYS;
  return event === KEY_EVENT_RELEASE ? TERMINAL_MODE_KEY_RELEASES | modifier : modifier;
}

// code → key → (mods | event << 8 | altComposes << 10) → resolution. Three
// lookups keyed by values the event already holds, so a hit allocates nothing.
const eventCache = new Map<string, Map<string, Map<number, ResolvedKey | null>>>();

/**
 * The record for a physical key event. `altComposes` is whether the held Alt
 * types text (right Option on Apple platforms) rather than modifying the key.
 */
export function resolveKeyboardEvent(
  event: KeyboardEvent,
  keyEvent: KeyEvent,
  altComposes: boolean,
): ResolvedKey | null {
  const mods = eventMods(event, altComposes);
  const slot = mods | (keyEvent << 8) | (altComposes ? 1 << 10 : 0);
  let byKey = eventCache.get(event.code);
  if (byKey === undefined) {
    byKey = new Map();
    eventCache.set(event.code, byKey);
  }
  let bySlot = byKey.get(event.key);
  if (bySlot === undefined) {
    bySlot = new Map();
    byKey.set(event.key, bySlot);
  }
  const cached = bySlot.get(slot);
  if (cached !== undefined) return cached;
  const facts = eventFacts(event, altComposes);
  const resolved =
    facts === null
      ? null
      : resolve(facts.identity, mods, keyEvent, textFor(facts.produced, mods, keyEvent));
  bySlot.set(slot, resolved);
  return resolved;
}

const releaseCache = new WeakMap<KeyIdentity, Map<number, ResolvedKey | null>>();

/**
 * The release of a key that was pressed as `identity`, with the modifiers held
 * when it is released. A release carries the press's identity, not whatever
 * the layout would now call the key: Shift let go before `1` is still the key
 * that typed `!`.
 */
export function resolveRelease(identity: KeyIdentity, mods: number): ResolvedKey | null {
  let byMods = releaseCache.get(identity);
  if (byMods === undefined) {
    byMods = new Map();
    releaseCache.set(identity, byMods);
  }
  const cached = byMods.get(mods);
  if (cached !== undefined) return cached;
  const resolved = resolve(identity, mods, KEY_EVENT_RELEASE, null);
  byMods.set(mods, resolved);
  return resolved;
}

/** The modifiers of a key event, for the release that ends a press. */
export function modifiersOf(event: KeyboardEvent, altComposes: boolean): number {
  return eventMods(event, altComposes);
}

function virtualMods(modifiers: TerminalModifierState): number {
  return (
    (modifiers.shift ? KEY_MOD_SHIFT : 0) |
    (modifiers.ctrl ? KEY_MOD_CTRL : 0) |
    (modifiers.alt ? KEY_MOD_ALT : 0) |
    (modifiers.meta ? KEY_MOD_SUPER : 0)
  );
}

function virtualFacts(inputKey: string, shift: boolean): EventFacts | null {
  if (inputKey === 'Shift+Tab') {
    return { identity: { key: FUNCTIONAL_KEY.TAB, shifted: null, base: null }, produced: null };
  }
  const named = NAMED_KEYS[inputKey];
  if (named !== undefined)
    return { identity: { key: named, shifted: null, base: null }, produced: null };
  const produced = shift ? (US_SHIFTED_SYMBOLS[inputKey] ?? inputKey.toUpperCase()) : inputKey;
  const identity = characterIdentity(produced, null);
  return identity === null ? null : { identity, produced };
}

interface VirtualResolution {
  readonly press: ResolvedKey;
  readonly release: ResolvedKey | null;
}

const virtualCache = new Map<string, Map<number, VirtualResolution | null>>();

/**
 * The press and release an on-screen key sends. The on-screen keyboard is a US
 * layout, and its latched modifiers go in the record's modifier byte only: a
 * latch is not a key anyone pressed.
 */
export function resolveVirtualKey(
  inputKey: string,
  modifiers: TerminalModifierState,
): VirtualResolution | null {
  let mods = virtualMods(modifiers);
  if (inputKey === 'Shift+Tab') mods |= KEY_MOD_SHIFT;
  let byMods = virtualCache.get(inputKey);
  if (byMods === undefined) {
    byMods = new Map();
    virtualCache.set(inputKey, byMods);
  }
  const cached = byMods.get(mods);
  if (cached !== undefined) return cached;
  const facts = virtualFacts(inputKey, (mods & KEY_MOD_SHIFT) !== 0);
  let resolution: VirtualResolution | null = null;
  if (facts !== null) {
    const press = resolve(
      facts.identity,
      mods,
      KEY_EVENT_PRESS,
      textFor(facts.produced, mods, KEY_EVENT_PRESS),
    );
    if (press !== null) resolution = { press, release: resolveRelease(facts.identity, mods) };
  }
  byMods.set(mods, resolution);
  return resolution;
}
