import { createKeyboardLayout } from '../layout';
import type {
  KeyboardKeyDefinition,
  KeyboardKeyPlacement,
  KeyboardLayout,
  KeyboardRow,
} from '../types';

const REPEAT = { delayMs: 500, intervalMs: 72 } as const;
const keys: Record<string, KeyboardKeyDefinition> = {};

function define(key: KeyboardKeyDefinition): void {
  keys[key.id] = key;
}

function input(
  id: string,
  label: string,
  value: string,
  overrides: Partial<KeyboardKeyDefinition> = {},
): void {
  define({ id, label, value, kind: 'input', variant: 'character', ...overrides });
}

function placement(key: string, column: number, span?: number): KeyboardKeyPlacement {
  return span === undefined ? { key, column } : { key, column, span };
}

function row(...rowKeys: KeyboardKeyPlacement[]): KeyboardRow {
  return { keys: rowKeys };
}

for (const letter of 'qwertyuiopasdfghjklzxcvbnm') {
  const shifted = letter.toUpperCase();
  input(`key-${letter}`, letter, letter, { shiftedLabel: shifted, shiftedValue: shifted });
}
for (const digit of '1234567890') input(`key-${digit}`, digit, digit);

const symbolKeys = [
  ['dash', '-', '-'],
  ['slash', '/', '/'],
  ['colon', ':', ':'],
  ['semicolon', ';', ';'],
  ['left-paren', '(', '('],
  ['right-paren', ')', ')'],
  ['dollar', '$', '$'],
  ['ampersand', '&', '&'],
  ['at', '@', '@'],
  ['period', '.', '.'],
  ['comma', ',', ','],
  ['question', '?', '?'],
  ['bang', '!', '!'],
  ['quote', "'", "'"],
  ['left-bracket', '[', '['],
  ['right-bracket', ']', ']'],
  ['left-brace', '{', '{'],
  ['right-brace', '}', '}'],
  ['hash', '#', '#'],
  ['percent', '%', '%'],
  ['caret', '^', '^'],
  ['asterisk', '*', '*'],
  ['plus', '+', '+'],
  ['equals', '=', '='],
  ['underscore', '_', '_'],
  ['backslash', '\\', '\\'],
  ['pipe', '|', '|'],
  ['tilde', '~', '~'],
  ['less-than', '<', '<'],
  ['greater-than', '>', '>'],
  ['double-quote', '"', '"'],
] as const;
for (const [id, label, value] of symbolKeys) input(id, label, value);
// A separately addressable physical slot lets every layer retain its own period
// key while sharing the Cupertino URL-keyboard bottom row.
input('bottom-period', '.', '.');

input('escape', 'esc', 'Escape', { variant: 'special', ariaLabel: 'Escape' });
input('tab', 'tab', 'Tab', { variant: 'special', ariaLabel: 'Tab' });
input('shift-tab', '⇤', 'Shift+Tab', { variant: 'special', ariaLabel: 'Shift Tab' });
input('backspace', '⌫', 'Backspace', {
  variant: 'special',
  ariaLabel: 'Backspace',
  activation: 'press',
  repeat: REPEAT,
});
input('delete', '⌦', 'Delete', {
  variant: 'special',
  ariaLabel: 'Delete',
  activation: 'press',
  repeat: REPEAT,
});
input('enter', 'return', 'Enter', { variant: 'accent', ariaLabel: 'Return' });
input('space', 'space', ' ', { variant: 'space', ariaLabel: 'Space' });
input('home', 'home', 'Home', { variant: 'special' });
input('end', 'end', 'End', { variant: 'special' });
input('page-up', 'pg up', 'PageUp', { variant: 'special' });
input('page-down', 'pg dn', 'PageDown', { variant: 'special' });
input('arrow-left', '←', 'ArrowLeft', {
  variant: 'special',
  activation: 'press',
  repeat: REPEAT,
});
input('arrow-down', '↓', 'ArrowDown', {
  variant: 'special',
  activation: 'press',
  repeat: REPEAT,
});
input('arrow-up', '↑', 'ArrowUp', {
  variant: 'special',
  activation: 'press',
  repeat: REPEAT,
});
input('arrow-right', '→', 'ArrowRight', {
  variant: 'special',
  activation: 'press',
  repeat: REPEAT,
});

for (const [id, label, modifier] of [
  ['shift', '⇧', 'shift'],
  ['ctrl', 'ctrl', 'ctrl'],
  ['alt', 'alt', 'alt'],
  ['cmd', 'cmd', 'meta'],
] as const) {
  define({ id, label, modifier, kind: 'modifier', variant: 'special', activation: 'press' });
}

define({ id: 'paste', label: 'paste', action: 'paste', kind: 'action', variant: 'special' });
define({
  id: 'fit-window',
  label: 'fit',
  ariaLabel: 'Fit terminal to this window',
  action: 'fit-window',
  kind: 'action',
  variant: 'special',
});
for (const [id, label, targetLayer] of [
  ['layer-alpha', 'ABC', 'alpha'],
  ['layer-numbers', '123', 'numbers'],
  ['layer-symbols', '#+=', 'symbols'],
  ['layer-pc', 'PC', 'pc'],
] as const) {
  define({ id, label, targetLayer, kind: 'layer', variant: 'special', activation: 'press' });
}

const alphaRowOne = [...'qwertyuiop'].map((letter, column) => placement(`key-${letter}`, column));
const alphaRowTwo = [...'asdfghjkl'].map((letter, column) =>
  placement(`key-${letter}`, column + 0.5),
);
const alphaRowThree = [...'zxcvbnm'].map((letter, column) =>
  placement(`key-${letter}`, column + 1.5),
);
const digitRow = [...'1234567890'].map((digit, column) => placement(`key-${digit}`, column));

/**
 * Apple's URL keyboard proportions at 402 pt / 3x. The PC layer selector
 * deliberately occupies the globe/emoji key's native slot.
 */
const cupertinoBottomRow = (): KeyboardRow =>
  row(
    placement('layer-alpha', 0, 1.25),
    placement('layer-pc', 1.25, 1.25),
    placement('space', 2.5, 4.75),
    placement('bottom-period', 7.25),
    placement('enter', 8.25, 1.75),
  );

/**
 * Four data-only layers: alphabetic, iOS-style numeric and symbol pages, and a
 * terminal PC layer in the position normally occupied by the globe/emoji path.
 */
export const TERMINAL_US_LAYOUT: KeyboardLayout = createKeyboardLayout({
  id: 'merkur-terminal-us',
  initialLayer: 'alpha',
  keys,
  layers: {
    alpha: {
      id: 'alpha',
      columns: 10,
      rows: [
        row(...alphaRowOne),
        row(...alphaRowTwo),
        row(placement('shift', 0, 1.3), ...alphaRowThree, placement('backspace', 8.7, 1.3)),
        row(
          placement('layer-numbers', 0, 1.25),
          placement('layer-pc', 1.25, 1.25),
          placement('space', 2.5, 4.75),
          placement('bottom-period', 7.25),
          placement('enter', 8.25, 1.75),
        ),
      ],
    },
    numbers: {
      id: 'numbers',
      columns: 10,
      rows: [
        row(...digitRow),
        row(
          placement('dash', 0.5),
          placement('slash', 1.5),
          placement('colon', 2.5),
          placement('semicolon', 3.5),
          placement('left-paren', 4.5),
          placement('right-paren', 5.5),
          placement('dollar', 6.5),
          placement('ampersand', 7.5),
          placement('at', 8.5),
        ),
        row(
          placement('layer-symbols', 0, 1.3),
          placement('period', 1.65),
          placement('comma', 2.85),
          placement('question', 4.05),
          placement('bang', 5.25),
          placement('quote', 6.45),
          placement('backspace', 8.7, 1.3),
        ),
        cupertinoBottomRow(),
      ],
    },
    symbols: {
      id: 'symbols',
      columns: 10,
      rows: [
        row(
          placement('left-bracket', 0),
          placement('right-bracket', 1),
          placement('left-brace', 2),
          placement('right-brace', 3),
          placement('hash', 4),
          placement('percent', 5),
          placement('caret', 6),
          placement('asterisk', 7),
          placement('plus', 8),
          placement('equals', 9),
        ),
        row(
          placement('underscore', 1.5),
          placement('backslash', 2.5),
          placement('pipe', 3.5),
          placement('tilde', 4.5),
          placement('less-than', 5.5),
          placement('greater-than', 6.5),
          placement('double-quote', 7.5),
        ),
        row(
          placement('layer-numbers', 0, 1.3),
          placement('period', 1.65),
          placement('comma', 2.85),
          placement('question', 4.05),
          placement('bang', 5.25),
          placement('quote', 6.45),
          placement('backspace', 8.7, 1.3),
        ),
        cupertinoBottomRow(),
      ],
    },
    pc: {
      id: 'pc',
      columns: 10,
      rows: [
        row(
          placement('escape', 0, 1.3),
          placement('tab', 1.45, 1.3),
          placement('shift-tab', 2.9, 1.3),
          placement('ctrl', 4.35, 1.3),
          placement('alt', 5.8, 1.3),
          placement('cmd', 7.25, 1.3),
          placement('fit-window', 8.7, 1.3),
        ),
        row(
          placement('home', 0, 1.85),
          placement('arrow-up', 2.05, 1.85),
          placement('end', 4.1, 1.85),
          placement('page-up', 6.15, 1.85),
          placement('delete', 8.2, 1.8),
        ),
        row(
          placement('page-down', 0, 1.85),
          placement('arrow-left', 2.05, 1.85),
          placement('arrow-down', 4.1, 1.85),
          placement('arrow-right', 6.15, 1.85),
          placement('backspace', 8.2, 1.8),
        ),
        row(
          placement('layer-alpha', 0, 1.8),
          placement('layer-numbers', 1.95, 1.45),
          placement('paste', 3.55, 2),
          placement('space', 5.7, 2.3),
          placement('enter', 8.15, 1.85),
        ),
      ],
    },
  },
});
