import { describe, expect, test } from 'bun:test';

import {
  clampTerminalFontSize,
  MAX_TERMINAL_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
  type TerminalAppearance,
  terminalAppearanceWithFontSize,
} from './appearance';

const APPEARANCE: TerminalAppearance = {
  themeId: 'catppuccinMocha',
  fontFamilyId: 'jetBrainsMono',
  fontSize: 14,
};

describe('clampTerminalFontSize', () => {
  test('holds the slider range', () => {
    expect(clampTerminalFontSize(MIN_TERMINAL_FONT_SIZE - 4)).toBe(MIN_TERMINAL_FONT_SIZE);
    expect(clampTerminalFontSize(MAX_TERMINAL_FONT_SIZE + 40)).toBe(MAX_TERMINAL_FONT_SIZE);
    expect(clampTerminalFontSize(17)).toBe(17);
  });

  test('rounds to whole pixels', () => {
    expect(clampTerminalFontSize(15.4)).toBe(15);
    expect(clampTerminalFontSize(15.6)).toBe(16);
  });

  test('falls back to the default when the value is not a number', () => {
    expect(clampTerminalFontSize(Number.NaN)).toBe(14);
    expect(clampTerminalFontSize(Number.POSITIVE_INFINITY)).toBe(14);
  });
});

describe('terminalAppearanceWithFontSize', () => {
  test('changes only the size', () => {
    const next = terminalAppearanceWithFontSize(APPEARANCE, 19);
    expect(next).toEqual({ ...APPEARANCE, fontSize: 19 });
  });
});
