import { DEFAULT_TERMINAL_FONT_ID, TERMINAL_FONTS, type TerminalFontFamilyId } from './fonts';
import { DEFAULT_TERMINAL_THEME_ID, TERMINAL_THEMES, type TerminalThemeId } from './themes';

const STORAGE_KEY = 'merkur.terminal.appearance.v1';

export const MIN_TERMINAL_FONT_SIZE = 10;
export const MAX_TERMINAL_FONT_SIZE = 24;
/**
 * Whole pixels. A fractional em size buys nothing here — the renderer snaps
 * cell metrics to the device pixel grid anyway — and it would turn one drag of
 * the slider into hundreds of atlas rebuilds instead of at most fourteen.
 */
export const TERMINAL_FONT_SIZE_STEP = 1;

/**
 * Cell leading. A constant rather than a stored field: the three size presets
 * were the only thing that ever varied it, and a value nothing can set has no
 * business being persisted.
 */
export const TERMINAL_LINE_HEIGHT = 1.0;

export interface TerminalAppearance {
  readonly themeId: TerminalThemeId;
  readonly fontFamilyId: TerminalFontFamilyId;
  readonly fontSize: number;
}

const DEFAULT_TERMINAL_APPEARANCE: TerminalAppearance = {
  themeId: DEFAULT_TERMINAL_THEME_ID,
  fontFamilyId: DEFAULT_TERMINAL_FONT_ID,
  fontSize: 14,
};

export function loadTerminalAppearance(): TerminalAppearance {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) {
      return DEFAULT_TERMINAL_APPEARANCE;
    }
    return normalizeTerminalAppearance(JSON.parse(raw));
  } catch {
    return DEFAULT_TERMINAL_APPEARANCE;
  }
}

export function saveTerminalAppearance(appearance: TerminalAppearance): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(appearance));
}

export function terminalAppearanceWithFontSize(
  current: TerminalAppearance,
  fontSize: number,
): TerminalAppearance {
  return { ...current, fontSize: clampTerminalFontSize(fontSize) };
}

/**
 * The slider's `min`/`max`/`step` are a hint to the pointer, not a guarantee:
 * the value also arrives from a stored record written by an older layout.
 */
export function clampTerminalFontSize(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_TERMINAL_APPEARANCE.fontSize;
  }
  return Math.min(MAX_TERMINAL_FONT_SIZE, Math.max(MIN_TERMINAL_FONT_SIZE, Math.round(value)));
}

function normalizeTerminalAppearance(value: unknown): TerminalAppearance {
  if (typeof value !== 'object' || value === null) {
    return DEFAULT_TERMINAL_APPEARANCE;
  }

  const record = value as Record<string, unknown>;
  const themeId =
    typeof record.themeId === 'string' && record.themeId in TERMINAL_THEMES
      ? (record.themeId as TerminalThemeId)
      : DEFAULT_TERMINAL_APPEARANCE.themeId;
  const fontFamilyId =
    typeof record.fontFamilyId === 'string' && record.fontFamilyId in TERMINAL_FONTS
      ? (record.fontFamilyId as TerminalFontFamilyId)
      : DEFAULT_TERMINAL_APPEARANCE.fontFamilyId;
  const fontSize =
    typeof record.fontSize === 'number'
      ? clampTerminalFontSize(record.fontSize)
      : DEFAULT_TERMINAL_APPEARANCE.fontSize;

  return { themeId, fontFamilyId, fontSize };
}
