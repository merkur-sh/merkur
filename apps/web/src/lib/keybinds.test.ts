import { describe, expect, test } from 'bun:test';

import { formatKeys, keyToken, resolveSequence, stepIndex } from './keybinds';

function press(
  key: string,
  modifiers: Partial<Omit<KeyboardEvent, 'key'>> = {},
): {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
} {
  return {
    key,
    ctrlKey: modifiers.ctrlKey === true,
    metaKey: modifiers.metaKey === true,
    altKey: modifiers.altKey === true,
    shiftKey: modifiers.shiftKey === true,
  };
}

describe('keyToken', () => {
  test('passes an unmodified key through verbatim', () => {
    expect(keyToken(press('j'), false)).toBe('j');
    expect(keyToken(press('Enter'), false)).toBe('Enter');
  });

  // Shift folds into the character rather than becoming a prefix, so `G` and
  // `?` are written the way they are typed.
  test('folds shift into the character', () => {
    expect(keyToken(press('G', { shiftKey: true }), false)).toBe('G');
    expect(keyToken(press('?', { shiftKey: true }), false)).toBe('?');
  });

  // The whole point of the side split: the same event is a binding or not
  // depending only on which ⌘ the tracker says is down.
  test('binds Meta only while the right one is held', () => {
    expect(keyToken(press('k', { metaKey: true }), true)).toBe('rcmd+k');
    expect(keyToken(press('k', { metaKey: true }), false)).toBeNull();
  });

  test('normalizes the character regardless of shift', () => {
    expect(keyToken(press('K', { metaKey: true, shiftKey: true }), true)).toBe('rcmd+k');
  });

  // `ctrl+` tokens exist only so the palette can move its cursor while its
  // query field holds focus.
  test('keeps bare Ctrl bindable and Ctrl+Shift not', () => {
    expect(keyToken(press('j', { ctrlKey: true }), false)).toBe('ctrl+j');
    expect(keyToken(press('J', { ctrlKey: true, shiftKey: true }), false)).toBeNull();
  });

  test('refuses Alt, which nothing here binds', () => {
    expect(keyToken(press('j', { altKey: true }), false)).toBeNull();
  });

  // A modified non-character key is not a binding; returning null leaves it to
  // the browser.
  test('refuses a modified key with no character', () => {
    expect(keyToken(press('Tab', { ctrlKey: true }), false)).toBeNull();
    expect(keyToken(press('Meta', { metaKey: true }), true)).toBeNull();
  });
});

describe('resolveSequence', () => {
  const KEYS = ['j', 'k', 'G', 'g g', 'g d', 'g s'];

  test('matches a single-key binding', () => {
    expect(resolveSequence(KEYS, '', 'j')).toEqual({ match: 'j', pending: '' });
  });

  test('holds a prefix that leads somewhere', () => {
    expect(resolveSequence(KEYS, '', 'g')).toEqual({ match: null, pending: 'g' });
  });

  test('completes a chord from its prefix', () => {
    expect(resolveSequence(KEYS, 'g', 'd')).toEqual({ match: 'g d', pending: '' });
  });

  // A dead prefix must not eat the key that killed it: `g` then `j` moves down
  // rather than costing the user two presses to recover from one typo.
  test('retries a dead prefix as a fresh token', () => {
    expect(resolveSequence(KEYS, 'g', 'j')).toEqual({ match: 'j', pending: '' });
  });

  test('reports an unbound key as unhandled', () => {
    expect(resolveSequence(KEYS, '', 'z')).toEqual({ match: null, pending: '' });
    expect(resolveSequence(KEYS, 'g', 'z')).toEqual({ match: null, pending: '' });
  });

  test('distinguishes a shifted binding from its lowercase one', () => {
    expect(resolveSequence(KEYS, '', 'G')).toEqual({ match: 'G', pending: '' });
    expect(resolveSequence(KEYS, '', 'g')).toEqual({ match: null, pending: 'g' });
  });

  // The definition the indexed prefix test replaced: a chord continues when a
  // binding starts with the candidate and a space.
  function reference(boundKeys: readonly string[], pending: string, token: string) {
    const candidate = pending === '' ? token : `${pending} ${token}`;
    if (boundKeys.includes(candidate)) return { match: candidate, pending: '' };
    if (boundKeys.some((keys) => keys.startsWith(`${candidate} `))) {
      return { match: null, pending: candidate };
    }
    if (pending !== '') return reference(boundKeys, '', token);
    return { match: null, pending: '' };
  }

  test('agrees with the space-joined prefix definition on every press', () => {
    // A key and a chord it begins, a longer chord, a space-free lookalike, a
    // modifier token, and a binding that is only ever a prefix's prefix.
    const table = ['g', 'g d', 'g d x', 'gd', 'rcmd+k', 'rcmd+k s', 'j', 'z z z'];
    const tokens = ['g', 'd', 'x', 'gd', 'rcmd+k', 's', 'j', 'z', 'q'];
    const pendings = ['', 'g', 'g d', 'gd', 'rcmd+k', 'z', 'z z', 'q'];
    for (let subset = 0; subset < 1 << table.length; subset += 1) {
      const boundKeys = table.filter((_, index) => (subset & (1 << index)) !== 0);
      for (const pending of pendings) {
        for (const token of tokens) {
          expect(resolveSequence(boundKeys, pending, token)).toEqual(
            reference(boundKeys, pending, token),
          );
        }
      }
    }
  });
});

describe('stepIndex', () => {
  test('wraps at both ends', () => {
    expect(stepIndex(3, 2, 1)).toBe(0);
    expect(stepIndex(3, 0, -1)).toBe(2);
  });

  test('walks the interior', () => {
    expect(stepIndex(3, 0, 1)).toBe(1);
    expect(stepIndex(3, 2, -1)).toBe(1);
  });

  // Focus not being on the list is the common case for the first press after a
  // screen opens: enter at the end the direction implies.
  test('enters the list from outside it', () => {
    expect(stepIndex(3, -1, 1)).toBe(0);
    expect(stepIndex(3, -1, -1)).toBe(2);
  });

  test('does nothing with nothing to focus', () => {
    expect(stepIndex(0, -1, 1)).toBeNull();
    expect(stepIndex(0, 0, -1)).toBeNull();
  });
});

describe('formatKeys', () => {
  // "⌘K" would send the reader to the wrong key half the time.
  test('names the side of the modifier explicitly', () => {
    expect(formatKeys('rcmd+k')).toBe('right ⌘ K');
    expect(formatKeys('rcmd+s')).toBe('right ⌘ S');
  });

  test('keeps a chord as separate presses', () => {
    expect(formatKeys('g d')).toBe('g d');
  });

  test('renders bare Ctrl', () => {
    expect(formatKeys('ctrl+j')).toBe('Ctrl+J');
  });

  test('leaves a plain key alone', () => {
    expect(formatKeys('G')).toBe('G');
    expect(formatKeys('?')).toBe('?');
  });
});
