/**
 * The account-scoped half of a user's keyboard configuration.
 *
 * Only the *arrangement* is an account fact: which keys sit on the quick-access
 * toolbar, the named key sequences available there, and the order of the keys in each layer of the on-screen layout.
 * Those are decisions about how this person wants to type, so they follow the
 * account onto every device it signs in on.
 *
 * Everything a device measured about itself stays where it was measured. The
 * learned touch offsets and their grip field describe one screen held one way
 * in one hand; the typing diagnostics summarise taps on that screen; whether
 * the keyboard is currently shown and whether its toolbar is expanded are
 * statements about this session. Carrying a phone's calibration onto a tablet
 * would land keystrokes worse than that tablet's own priors do, so none of it
 * crosses the account boundary — see `keyboard-offset-store.ts`.
 *
 * The server stores this blob without interpreting it. Key identifiers belong
 * to the browser's keyboard, so the bounds here are structural — enough to keep
 * an untrusted body from becoming unbounded storage — and the browser rejects
 * anything it does not recognise when it reads the settings back.
 */
import { isRecord } from './parsing';

export const TERMINAL_KEYBOARD_LAYER_IDS = ['alpha', 'numbers', 'symbols', 'pc'] as const;
export type TerminalKeyboardLayerId = (typeof TERMINAL_KEYBOARD_LAYER_IDS)[number];
export type TerminalKeyboardLayerKeyOrder = Readonly<
  Record<TerminalKeyboardLayerId, readonly string[]>
>;

/** Toolbar capacity, enforced by the editor that builds one and by the route. */
export const MAX_TOOLBAR_KEYS = 32;
/**
 * Matches the per-layer ceiling `createKeyboardLayout` already enforces, so a
 * body this route accepts is one the browser's layout builder can also accept.
 */
export const MAX_KEYBOARD_LAYER_KEYS = 254;
/** Every shipped key id is well under this; it bounds the row, not the vocabulary. */
export const MAX_KEYBOARD_KEY_ID_LENGTH = 32;

/** Bounds keep account settings and a one-tap input burst finite. */
export const MAX_KEYBOARD_MACROS = 32;
export const MAX_KEYBOARD_MACRO_STEPS = 32;
export const MAX_KEYBOARD_MACRO_NAME_LENGTH = 32;

export interface KeyboardMacroStep {
  readonly key: string;
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  readonly meta: boolean;
}

export interface KeyboardMacro {
  readonly id: `macro:${string}`;
  readonly name: string;
  readonly steps: readonly KeyboardMacroStep[];
}

export function isKeyboardMacro(value: unknown): value is KeyboardMacro {
  if (!isExactRecord(value, ['id', 'name', 'steps'])) return false;
  return (
    typeof value.id === 'string' &&
    value.id.startsWith('macro:') &&
    value.id.length > 6 &&
    value.id.length <= MAX_KEYBOARD_KEY_ID_LENGTH &&
    typeof value.name === 'string' &&
    value.name.trim().length > 0 &&
    value.name.length <= MAX_KEYBOARD_MACRO_NAME_LENGTH &&
    Array.isArray(value.steps) &&
    value.steps.length > 0 &&
    value.steps.length <= MAX_KEYBOARD_MACRO_STEPS &&
    value.steps.every(
      (step) =>
        isExactRecord(step, ['key', 'ctrl', 'alt', 'shift', 'meta']) &&
        typeof step.key === 'string' &&
        step.key.length > 0 &&
        step.key.length <= MAX_KEYBOARD_KEY_ID_LENGTH &&
        typeof step.ctrl === 'boolean' &&
        typeof step.alt === 'boolean' &&
        typeof step.shift === 'boolean' &&
        typeof step.meta === 'boolean',
    )
  );
}

export interface AccountKeyboardSettings {
  /** Quick-access toolbar contents, in display order. */
  readonly toolbarKeys: readonly string[];
  /** Named key sequences available to the toolbar. */
  readonly macros: readonly KeyboardMacro[];
  /** Each layer's key ids in visual order, one entry per key placement. */
  readonly layerKeyOrder: TerminalKeyboardLayerKeyOrder;
}

const ACCOUNT_KEYBOARD_SETTINGS_KEYS = ['toolbarKeys', 'layerKeyOrder', 'macros'] as const;

/**
 * Structural guard for a stored or transmitted settings blob.
 *
 * Membership of the key vocabulary is deliberately not checked here: the ids
 * are the browser keyboard's, and neither the server nor this package knows
 * them. A blob that passes still goes through the browser's own normalizer,
 * which drops unknown ids and refuses a layer order that is not a permutation
 * of the layout it is being applied to.
 */
export function isAccountKeyboardSettings(value: unknown): value is AccountKeyboardSettings {
  if (!isExactRecord(value, ACCOUNT_KEYBOARD_SETTINGS_KEYS)) return false;
  if (!isKeyIdArray(value.toolbarKeys, MAX_TOOLBAR_KEYS)) return false;
  if (
    !Array.isArray(value.macros) ||
    value.macros.length > MAX_KEYBOARD_MACROS ||
    !value.macros.every(isKeyboardMacro) ||
    new Set(value.macros.map((macro) => macro.id)).size !== value.macros.length
  )
    return false;
  const layerKeyOrder = value.layerKeyOrder;
  if (!isExactRecord(layerKeyOrder, TERMINAL_KEYBOARD_LAYER_IDS)) return false;
  return TERMINAL_KEYBOARD_LAYER_IDS.every((layerId) =>
    isKeyIdArray(layerKeyOrder[layerId], MAX_KEYBOARD_LAYER_KEYS),
  );
}

function isKeyIdArray(value: unknown, maximum: number): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length <= maximum &&
    value.every(
      (entry) =>
        typeof entry === 'string' && entry.length > 0 && entry.length <= MAX_KEYBOARD_KEY_ID_LENGTH,
    )
  );
}

function isExactRecord<Key extends string>(
  value: unknown,
  expectedKeys: readonly Key[],
): value is Record<Key, unknown> {
  if (!isRecord(value)) return false;
  return (
    Object.keys(value).length === expectedKeys.length &&
    expectedKeys.every((key) => Object.hasOwn(value, key))
  );
}
