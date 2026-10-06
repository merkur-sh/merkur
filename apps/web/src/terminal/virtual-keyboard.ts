import { createKeyboardLayout, type KeyboardLayout } from '@merkur/keyboard';
import { TERMINAL_US_LAYOUT } from '@merkur/keyboard/layouts/terminal-us';
import {
  type AccountKeyboardSettings,
  isKeyboardMacro,
  type KeyboardMacro,
  MAX_KEYBOARD_MACROS,
  MAX_TOOLBAR_KEYS,
  parseJson,
  TERMINAL_KEYBOARD_LAYER_IDS,
  type TerminalKeyboardLayerId,
  type TerminalKeyboardLayerKeyOrder,
} from '@merkur/shared';

export type VirtualKeyId =
  | 'escape'
  | 'tab'
  | 'ctrl'
  | 'shift'
  | 'alt'
  | 'cmd'
  | 'shift-tab'
  | 'arrow-left'
  | 'arrow-down'
  | 'arrow-up'
  | 'arrow-right'
  | 'home'
  | 'end'
  | 'page-up'
  | 'page-down'
  | 'backspace'
  | 'delete'
  | 'enter'
  | 'space'
  | 'key-1'
  | 'key-2'
  | 'key-3'
  | 'key-4'
  | 'key-5'
  | 'key-6'
  | 'key-7'
  | 'key-8'
  | 'key-9'
  | 'key-0'
  | 'key-q'
  | 'key-w'
  | 'key-e'
  | 'key-r'
  | 'key-t'
  | 'key-y'
  | 'key-u'
  | 'key-i'
  | 'key-o'
  | 'key-p'
  | 'key-a'
  | 'key-s'
  | 'key-d'
  | 'key-f'
  | 'key-g'
  | 'key-h'
  | 'key-j'
  | 'key-k'
  | 'key-l'
  | 'key-z'
  | 'key-x'
  | 'key-c'
  | 'key-v'
  | 'key-b'
  | 'key-n'
  | 'key-m'
  | 'slash'
  | 'dash'
  | 'underscore'
  | 'pipe'
  | 'backslash'
  | 'tilde'
  | 'period'
  | 'bottom-period'
  | 'comma'
  | 'colon'
  | 'semicolon'
  | 'quote'
  | 'double-quote'
  | 'plus'
  | 'equals'
  | 'asterisk'
  | 'ampersand'
  | 'at'
  | 'hash'
  | 'dollar'
  | 'percent'
  | 'caret'
  | 'bang'
  | 'question'
  | 'left-paren'
  | 'right-paren'
  | 'left-bracket'
  | 'right-bracket'
  | 'left-brace'
  | 'right-brace'
  | 'less-than'
  | 'greater-than'
  | 'paste'
  | 'fit-window'
  | 'expand-toolbar'
  | 'hide';

export type ToolbarKeyId = VirtualKeyId | `macro:${string}`;

export interface VirtualKeyDefinition {
  readonly id: ToolbarKeyId;
  readonly macro?: KeyboardMacro['steps'];
  readonly label: string;
  readonly inputKey?: string;
  readonly modifier?: 'ctrl' | 'shift' | 'alt' | 'meta';
  readonly action?: 'paste' | 'fit-window' | 'expand-toolbar' | 'hide';
  readonly wide?: boolean;
}

/**
 * Everything the on-screen keyboard is configured by, both halves together.
 *
 * `toolbarKeys`, `macros` and `layerKeyOrder` are the account's — the arrangement follows
 * the user between devices, through {@link accountKeyboardSettings}. The rest
 * belongs to this device: `visible` and `toolbarExpanded` describe the session
 * in front of the user, and `keyPreview` is about this screen, next to the
 * learned touch offsets that never leave it either.
 */
export interface VirtualKeyboardPreferences {
  readonly visible: boolean;
  readonly toolbarExpanded: boolean;
  readonly toolbarKeys: readonly ToolbarKeyId[];
  readonly macros: readonly KeyboardMacro[];
  readonly layerKeyOrder: TerminalKeyboardLayerKeyOrder;
  readonly keyPreview: boolean;
}

/**
 * Local storage holds both halves, because a device must be able to draw its
 * keyboard before — and without — reaching the server. It is a cache of the
 * account's arrangement, not a second authority: a signed-in device adopts what
 * the account holds and overwrites this.
 */
const STORAGE_KEY = 'merkur.terminal.virtualKeyboard';
const PREFERENCES_CHANGED_EVENT = 'merkur:virtual-keyboard-preferences-changed';

export const VIRTUAL_KEY_DEFINITIONS: Record<VirtualKeyId, VirtualKeyDefinition> = {
  escape: { id: 'escape', label: 'Esc', inputKey: 'Escape' },
  tab: { id: 'tab', label: 'Tab', inputKey: 'Tab' },
  ctrl: { id: 'ctrl', label: 'Ctrl', modifier: 'ctrl' },
  shift: { id: 'shift', label: 'Shift', modifier: 'shift', wide: true },
  alt: { id: 'alt', label: 'Alt', modifier: 'alt' },
  cmd: { id: 'cmd', label: 'Cmd', modifier: 'meta' },
  'shift-tab': { id: 'shift-tab', label: 'S-Tab', inputKey: 'Shift+Tab', wide: true },
  'arrow-left': { id: 'arrow-left', label: '←', inputKey: 'ArrowLeft' },
  'arrow-down': { id: 'arrow-down', label: '↓', inputKey: 'ArrowDown' },
  'arrow-up': { id: 'arrow-up', label: '↑', inputKey: 'ArrowUp' },
  'arrow-right': { id: 'arrow-right', label: '→', inputKey: 'ArrowRight' },
  home: { id: 'home', label: 'Home', inputKey: 'Home' },
  end: { id: 'end', label: 'End', inputKey: 'End' },
  'page-up': { id: 'page-up', label: 'PgUp', inputKey: 'PageUp' },
  'page-down': { id: 'page-down', label: 'PgDn', inputKey: 'PageDown' },
  backspace: { id: 'backspace', label: '⌫', inputKey: 'Backspace', wide: true },
  delete: { id: 'delete', label: 'Del', inputKey: 'Delete' },
  enter: { id: 'enter', label: 'Return', inputKey: 'Enter', wide: true },
  space: { id: 'space', label: 'space', inputKey: ' ', wide: true },
  'key-1': { id: 'key-1', label: '1', inputKey: '1' },
  'key-2': { id: 'key-2', label: '2', inputKey: '2' },
  'key-3': { id: 'key-3', label: '3', inputKey: '3' },
  'key-4': { id: 'key-4', label: '4', inputKey: '4' },
  'key-5': { id: 'key-5', label: '5', inputKey: '5' },
  'key-6': { id: 'key-6', label: '6', inputKey: '6' },
  'key-7': { id: 'key-7', label: '7', inputKey: '7' },
  'key-8': { id: 'key-8', label: '8', inputKey: '8' },
  'key-9': { id: 'key-9', label: '9', inputKey: '9' },
  'key-0': { id: 'key-0', label: '0', inputKey: '0' },
  'key-q': { id: 'key-q', label: 'q', inputKey: 'q' },
  'key-w': { id: 'key-w', label: 'w', inputKey: 'w' },
  'key-e': { id: 'key-e', label: 'e', inputKey: 'e' },
  'key-r': { id: 'key-r', label: 'r', inputKey: 'r' },
  'key-t': { id: 'key-t', label: 't', inputKey: 't' },
  'key-y': { id: 'key-y', label: 'y', inputKey: 'y' },
  'key-u': { id: 'key-u', label: 'u', inputKey: 'u' },
  'key-i': { id: 'key-i', label: 'i', inputKey: 'i' },
  'key-o': { id: 'key-o', label: 'o', inputKey: 'o' },
  'key-p': { id: 'key-p', label: 'p', inputKey: 'p' },
  'key-a': { id: 'key-a', label: 'a', inputKey: 'a' },
  'key-s': { id: 'key-s', label: 's', inputKey: 's' },
  'key-d': { id: 'key-d', label: 'd', inputKey: 'd' },
  'key-f': { id: 'key-f', label: 'f', inputKey: 'f' },
  'key-g': { id: 'key-g', label: 'g', inputKey: 'g' },
  'key-h': { id: 'key-h', label: 'h', inputKey: 'h' },
  'key-j': { id: 'key-j', label: 'j', inputKey: 'j' },
  'key-k': { id: 'key-k', label: 'k', inputKey: 'k' },
  'key-l': { id: 'key-l', label: 'l', inputKey: 'l' },
  'key-z': { id: 'key-z', label: 'z', inputKey: 'z' },
  'key-x': { id: 'key-x', label: 'x', inputKey: 'x' },
  'key-c': { id: 'key-c', label: 'c', inputKey: 'c' },
  'key-v': { id: 'key-v', label: 'v', inputKey: 'v' },
  'key-b': { id: 'key-b', label: 'b', inputKey: 'b' },
  'key-n': { id: 'key-n', label: 'n', inputKey: 'n' },
  'key-m': { id: 'key-m', label: 'm', inputKey: 'm' },
  slash: { id: 'slash', label: '/', inputKey: '/' },
  dash: { id: 'dash', label: '-', inputKey: '-' },
  underscore: { id: 'underscore', label: '_', inputKey: '_' },
  pipe: { id: 'pipe', label: '|', inputKey: '|' },
  backslash: { id: 'backslash', label: '\\', inputKey: '\\' },
  tilde: { id: 'tilde', label: '~', inputKey: '~' },
  period: { id: 'period', label: '.', inputKey: '.' },
  'bottom-period': { id: 'bottom-period', label: '.', inputKey: '.' },
  comma: { id: 'comma', label: ',', inputKey: ',' },
  colon: { id: 'colon', label: ':', inputKey: ':' },
  semicolon: { id: 'semicolon', label: ';', inputKey: ';' },
  quote: { id: 'quote', label: "'", inputKey: "'" },
  'double-quote': { id: 'double-quote', label: '"', inputKey: '"' },
  plus: { id: 'plus', label: '+', inputKey: '+' },
  equals: { id: 'equals', label: '=', inputKey: '=' },
  asterisk: { id: 'asterisk', label: '*', inputKey: '*' },
  ampersand: { id: 'ampersand', label: '&', inputKey: '&' },
  at: { id: 'at', label: '@', inputKey: '@' },
  hash: { id: 'hash', label: '#', inputKey: '#' },
  dollar: { id: 'dollar', label: '$', inputKey: '$' },
  percent: { id: 'percent', label: '%', inputKey: '%' },
  caret: { id: 'caret', label: '^', inputKey: '^' },
  bang: { id: 'bang', label: '!', inputKey: '!' },
  question: { id: 'question', label: '?', inputKey: '?' },
  'left-paren': { id: 'left-paren', label: '(', inputKey: '(' },
  'right-paren': { id: 'right-paren', label: ')', inputKey: ')' },
  'left-bracket': { id: 'left-bracket', label: '[', inputKey: '[' },
  'right-bracket': { id: 'right-bracket', label: ']', inputKey: ']' },
  'left-brace': { id: 'left-brace', label: '{', inputKey: '{' },
  'right-brace': { id: 'right-brace', label: '}', inputKey: '}' },
  'less-than': { id: 'less-than', label: '<', inputKey: '<' },
  'greater-than': { id: 'greater-than', label: '>', inputKey: '>' },
  paste: { id: 'paste', label: 'Paste', action: 'paste', wide: true },
  'fit-window': { id: 'fit-window', label: 'Fit', action: 'fit-window' },
  'expand-toolbar': { id: 'expand-toolbar', label: 'More', action: 'expand-toolbar', wide: true },
  hide: { id: 'hide', label: 'Hide', action: 'hide', wide: true },
};

export const DEFAULT_TOOLBAR_KEYS = [
  'escape',
  'ctrl',
  'alt',
  'paste',
  'page-up',
  'page-down',
  'tab',
] as const satisfies readonly VirtualKeyId[];

export const TOOLBAR_KEY_OPTIONS = (Object.keys(VIRTUAL_KEY_DEFINITIONS) as VirtualKeyId[]).filter(
  (id) => {
    const definition = VIRTUAL_KEY_DEFINITIONS[id];
    return (
      (definition.inputKey !== undefined && id !== 'bottom-period') ||
      definition.modifier !== undefined ||
      definition.action === 'paste' ||
      definition.action === 'fit-window'
    );
  },
);

export const DEFAULT_TERMINAL_KEYBOARD_LAYER_KEY_ORDER: TerminalKeyboardLayerKeyOrder = {
  alpha: layerKeys('alpha'),
  numbers: layerKeys('numbers'),
  symbols: layerKeys('symbols'),
  pc: layerKeys('pc'),
};

export const DEFAULT_VIRTUAL_KEYBOARD_PREFERENCES: VirtualKeyboardPreferences = {
  visible: false,
  toolbarExpanded: false,
  toolbarKeys: DEFAULT_TOOLBAR_KEYS,
  macros: [],
  layerKeyOrder: DEFAULT_TERMINAL_KEYBOARD_LAYER_KEY_ORDER,
  keyPreview: true,
};

export function isTouchKeyboardEligible(): boolean {
  return (
    navigator.maxTouchPoints > 0 ||
    window.matchMedia('(pointer: coarse)').matches ||
    window.matchMedia('(hover: none)').matches
  );
}

export function loadVirtualKeyboardPreferences(): VirtualKeyboardPreferences {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULT_VIRTUAL_KEYBOARD_PREFERENCES;
    return normalizeVirtualKeyboardPreferences(JSON.parse(raw));
  } catch {
    return DEFAULT_VIRTUAL_KEYBOARD_PREFERENCES;
  }
}

export function saveVirtualKeyboardPreferences(preferences: VirtualKeyboardPreferences): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // Quota or private mode. Losing the cache is survivable — the account sync
    // still carries the change, and the notification below still reaches the
    // live keyboard — whereas throwing from here would take out whichever
    // caller made the change, including the sync fiber, permanently.
  }
  window.dispatchEvent(
    new CustomEvent<VirtualKeyboardPreferences>(PREFERENCES_CHANGED_EVENT, {
      detail: preferences,
    }),
  );
}

/**
 * Every change to the preferences, wherever it was made.
 *
 * Two sources, because a change has two ways of reaching a document. The custom
 * event carries writes made *in this document*. The `storage` event carries
 * writes made in another tab on this origin — the browser raises it only in the
 * other documents, so the two never double-report the same write.
 *
 * The cross-tab half matters more than it looks. Every tab runs its own account
 * sync, and a tab that missed a sibling's edit would still be holding the older
 * arrangement in a mounted preferences screen; the next edit made there would
 * push that stale arrangement over the sibling's. Converging every tab on what
 * local storage actually holds is what stops one tab from undoing another.
 */
export function observeVirtualKeyboardPreferences(
  listener: (preferences: VirtualKeyboardPreferences) => void,
): () => void {
  const onChanged = (event: Event): void => {
    if (!(event instanceof CustomEvent)) return;
    listener(normalizeVirtualKeyboardPreferences(event.detail));
  };
  const onStorage = (event: Event): void => {
    // Read structurally rather than through `instanceof StorageEvent`: the
    // fields are what this needs, and the constructor is a global that not
    // every environment this module is loaded in defines.
    const { key, newValue } = event as Partial<StorageEvent>;
    if (key !== STORAGE_KEY) return;
    // A removal leaves the origin with no stored preferences, which is the same
    // state a fresh browser is in.
    if (typeof newValue !== 'string') {
      listener(DEFAULT_VIRTUAL_KEYBOARD_PREFERENCES);
      return;
    }
    listener(normalizeVirtualKeyboardPreferences(parseJson(newValue)));
  };
  window.addEventListener(PREFERENCES_CHANGED_EVENT, onChanged);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(PREFERENCES_CHANGED_EVENT, onChanged);
    window.removeEventListener('storage', onStorage);
  };
}

export function normalizeVirtualKeyboardPreferences(value: unknown): VirtualKeyboardPreferences {
  if (typeof value !== 'object' || value === null) return DEFAULT_VIRTUAL_KEYBOARD_PREFERENCES;
  const record = value as Record<string, unknown>;
  const macros = normalizeKeyboardMacros(record.macros);
  return {
    visible: typeof record.visible === 'boolean' ? record.visible : false,
    toolbarExpanded: typeof record.toolbarExpanded === 'boolean' ? record.toolbarExpanded : false,
    toolbarKeys: normalizeToolbarKeys(record.toolbarKeys, macros),
    macros,
    layerKeyOrder: normalizeLayerKeyOrder(record.layerKeyOrder),
    keyPreview: typeof record.keyPreview === 'boolean' ? record.keyPreview : true,
  };
}

/** The half of the preferences that belongs to the account, not this device. */
export function accountKeyboardSettings(
  preferences: VirtualKeyboardPreferences,
): AccountKeyboardSettings {
  return {
    toolbarKeys: preferences.toolbarKeys,
    macros: preferences.macros,
    layerKeyOrder: preferences.layerKeyOrder,
  };
}

/**
 * Adopts an account arrangement, leaving every device-local field alone.
 *
 * The incoming value has been over the wire, so it goes through the same
 * normalizer a stored blob does: unknown key ids are dropped and a layer order
 * that is not a permutation of this build's layout falls back to the default,
 * rather than reaching the layout builder and throwing.
 */
export function withAccountKeyboardSettings(
  preferences: VirtualKeyboardPreferences,
  settings: AccountKeyboardSettings,
): VirtualKeyboardPreferences {
  const macros = normalizeKeyboardMacros(settings.macros);
  return {
    ...preferences,
    macros,
    toolbarKeys: normalizeToolbarKeys(settings.toolbarKeys, macros),
    layerKeyOrder: normalizeLayerKeyOrder(settings.layerKeyOrder),
  };
}

/** Whether two arrangements would render the same keyboard. */
export function sameAccountKeyboardSettings(
  left: AccountKeyboardSettings,
  right: AccountKeyboardSettings,
): boolean {
  return (
    sameArray(left.toolbarKeys, right.toolbarKeys) &&
    left.macros.length === right.macros.length &&
    left.macros.every((macro, index) => {
      const other = right.macros[index];
      return (
        other !== undefined &&
        macro.id === other.id &&
        macro.name === other.name &&
        macro.steps.length === other.steps.length &&
        macro.steps.every((step, stepIndex) => {
          const otherStep = other.steps[stepIndex];
          return (
            otherStep !== undefined &&
            step.key === otherStep.key &&
            step.ctrl === otherStep.ctrl &&
            step.alt === otherStep.alt &&
            step.shift === otherStep.shift &&
            step.meta === otherStep.meta
          );
        })
      );
    }) &&
    TERMINAL_KEYBOARD_LAYER_IDS.every((layerId) =>
      sameArray(left.layerKeyOrder[layerId], right.layerKeyOrder[layerId]),
    )
  );
}

export function createTerminalKeyboardLayout(
  keyOrder: TerminalKeyboardLayerKeyOrder,
): KeyboardLayout {
  let changed = false;
  const layers = { ...TERMINAL_US_LAYOUT.layers };

  for (const layerId of TERMINAL_KEYBOARD_LAYER_IDS) {
    const layer = TERMINAL_US_LAYOUT.layers[layerId];
    if (layer === undefined) continue;
    const orderedKeys = keyOrder[layerId];
    const defaultKeys = DEFAULT_TERMINAL_KEYBOARD_LAYER_KEY_ORDER[layerId];
    if (sameArray(orderedKeys, defaultKeys)) continue;
    changed = true;
    let keyIndex = 0;
    layers[layerId] = {
      ...layer,
      rows: layer.rows.map((row) => ({
        ...row,
        keys: row.keys.map((placement) => ({
          ...placement,
          key: orderedKeys[keyIndex++] ?? placement.key,
        })),
      })),
    };
  }

  if (!changed) return TERMINAL_US_LAYOUT;
  return createKeyboardLayout({
    ...TERMINAL_US_LAYOUT,
    id: `${TERMINAL_US_LAYOUT.id}-custom`,
    layers,
  });
}

export function swapTerminalKeyboardLayerKeys(
  keyOrder: TerminalKeyboardLayerKeyOrder,
  layerId: TerminalKeyboardLayerId,
  fromIndex: number,
  toIndex: number,
): TerminalKeyboardLayerKeyOrder {
  const current = keyOrder[layerId];
  if (
    fromIndex === toIndex ||
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= current.length ||
    toIndex >= current.length
  ) {
    return keyOrder;
  }
  const next = [...current];
  const fromKey = next[fromIndex];
  const toKey = next[toIndex];
  if (fromKey === undefined || toKey === undefined) return keyOrder;
  next[fromIndex] = toKey;
  next[toIndex] = fromKey;
  return { ...keyOrder, [layerId]: next };
}

export function moveToolbarKey(
  keys: readonly ToolbarKeyId[],
  fromIndex: number,
  toIndex: number,
): readonly ToolbarKeyId[] {
  if (
    fromIndex === toIndex ||
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= keys.length ||
    toIndex >= keys.length
  ) {
    return keys;
  }
  const next = [...keys];
  const moved = next.splice(fromIndex, 1)[0];
  if (moved === undefined) return keys;
  next.splice(toIndex, 0, moved);
  return next;
}

export function addToolbarKey(
  keys: readonly ToolbarKeyId[],
  key: ToolbarKeyId,
  macros: readonly KeyboardMacro[] = [],
): readonly ToolbarKeyId[] {
  const definition = getToolbarKeyDefinition(key, macros);
  if (
    definition === undefined ||
    (definition.macro === undefined && !isToolbarKey(key)) ||
    keys.includes(key) ||
    keys.length >= MAX_TOOLBAR_KEYS
  )
    return keys;
  return [...keys, key];
}

export function removeToolbarKey(
  keys: readonly ToolbarKeyId[],
  key: ToolbarKeyId,
): readonly ToolbarKeyId[] {
  const index = keys.indexOf(key);
  if (index < 0) return keys;
  return [...keys.slice(0, index), ...keys.slice(index + 1)];
}

export function getVirtualKeyDefinition(value: string): VirtualKeyDefinition | undefined {
  const definition = (
    VIRTUAL_KEY_DEFINITIONS as Readonly<Record<string, VirtualKeyDefinition | undefined>>
  )[value];
  return definition?.id === value ? definition : undefined;
}

function layerKeys(layerId: TerminalKeyboardLayerId): readonly string[] {
  const layer = TERMINAL_US_LAYOUT.layers[layerId];
  if (layer === undefined) throw new Error(`Missing terminal keyboard layer: ${layerId}`);
  return layer.rows.flatMap((row) => row.keys.map((placement) => placement.key));
}

function normalizeToolbarKeys(
  value: unknown,
  macros: readonly KeyboardMacro[],
): readonly ToolbarKeyId[] {
  if (!Array.isArray(value)) return DEFAULT_TOOLBAR_KEYS;
  const normalized: ToolbarKeyId[] = [];
  const seen = new Set<ToolbarKeyId>();
  for (const candidate of value) {
    if (typeof candidate !== 'string') continue;
    const definition = getToolbarKeyDefinition(candidate, macros);
    if (
      definition === undefined ||
      (definition.macro === undefined && !isToolbarKey(definition.id)) ||
      seen.has(definition.id)
    )
      continue;
    seen.add(definition.id);
    normalized.push(definition.id);
    if (normalized.length >= MAX_TOOLBAR_KEYS) break;
  }
  return normalized;
}

function normalizeLayerKeyOrder(value: unknown): TerminalKeyboardLayerKeyOrder {
  if (typeof value !== 'object' || value === null) {
    return DEFAULT_TERMINAL_KEYBOARD_LAYER_KEY_ORDER;
  }
  const record = value as Record<string, unknown>;
  let changed = false;
  const normalized = { ...DEFAULT_TERMINAL_KEYBOARD_LAYER_KEY_ORDER };
  for (const layerId of TERMINAL_KEYBOARD_LAYER_IDS) {
    const candidate = record[layerId];
    const defaults = DEFAULT_TERMINAL_KEYBOARD_LAYER_KEY_ORDER[layerId];
    if (!isPermutation(candidate, defaults)) continue;
    normalized[layerId] = candidate;
    if (!sameArray(candidate, defaults)) changed = true;
  }
  return changed ? normalized : DEFAULT_TERMINAL_KEYBOARD_LAYER_KEY_ORDER;
}

function isToolbarKey(value: ToolbarKeyId): boolean {
  return TOOLBAR_KEY_OPTIONS.some((key) => key === value);
}

function isPermutation(value: unknown, expected: readonly string[]): value is readonly string[] {
  if (!Array.isArray(value) || value.length !== expected.length) return false;
  const values = new Set<string>();
  for (const candidate of value) {
    if (typeof candidate !== 'string' || values.has(candidate)) return false;
    values.add(candidate);
  }
  return expected.every((key) => values.has(key));
}

function sameArray(left: readonly string[], right: readonly string[]): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/** Resolve a toolbar item against the current account definitions. */
export function getToolbarKeyDefinition(
  id: string,
  macros: readonly KeyboardMacro[],
): VirtualKeyDefinition | undefined {
  const macro = macros.find((candidate) => candidate.id === id);
  return macro === undefined
    ? getVirtualKeyDefinition(id)
    : { id: macro.id, label: macro.name, macro: macro.steps, wide: true };
}

function normalizeKeyboardMacros(value: unknown): readonly KeyboardMacro[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.filter((macro): macro is KeyboardMacro => {
    if (
      !isKeyboardMacro(macro) ||
      seen.has(macro.id) ||
      seen.size >= MAX_KEYBOARD_MACROS ||
      !macro.steps.every((step) => getVirtualKeyDefinition(step.key)?.inputKey !== undefined)
    )
      return false;
    seen.add(macro.id);
    return true;
  });
}
