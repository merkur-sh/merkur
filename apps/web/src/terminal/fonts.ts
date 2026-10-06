export interface TerminalFontFamily {
  readonly name: string;
  /**
   * Small face carrying text, box drawing, Powerline and the common prompt
   * icons. Its small transfer keeps the full regular face off the blocking
   * startup path. Font outlines are compiled lazily on first glyph use.
   */
  readonly boot: string;
  readonly regular: string;
  readonly bold: string;
  readonly italic: string;
  readonly boldItalic: string;
}

/**
 * One family's identity, for deciding whether a switch changes anything. The
 * boot face is part of it: without it two families differing only in their
 * boot face compare equal, and a family switch silently keeps the old one.
 */
export function terminalFontFamilyKey(fontFamily: TerminalFontFamily): string {
  return [
    fontFamily.boot,
    fontFamily.regular,
    fontFamily.bold,
    fontFamily.italic,
    fontFamily.boldItalic,
  ].join('\n');
}

export const TERMINAL_FONT_ASSET_VERSION = 'ac140ea24268';

function localTerminalFontAsset(fileName: string): string {
  // Font requests bypass the service worker so terminal readiness cannot be
  // blocked by CacheStorage. The content-versioned URL remains immutable in the
  // browser's HTTP cache and changes whenever the bundled font bytes change.
  return `/fonts/${fileName}?v=${TERMINAL_FONT_ASSET_VERSION}`;
}

// Terminal fonts are served from this origin only. A cross-origin font host
// would be a fetch() destination the CSP has to permit, which is exactly the
// exfiltration path `connect-src` is meant to close off.
export const TERMINAL_FONTS = {
  jetBrainsMono: {
    name: 'JetBrains Mono Nerd Font',
    boot: localTerminalFontAsset('JetBrainsMonoNF-Boot.ttf'),
    regular: localTerminalFontAsset('JetBrainsMonoNF-Regular.ttf'),
    bold: localTerminalFontAsset('JetBrainsMonoNF-Bold.ttf'),
    italic: localTerminalFontAsset('JetBrainsMonoNF-Italic.ttf'),
    boldItalic: localTerminalFontAsset('JetBrainsMonoNF-BoldItalic.ttf'),
  },
} as const satisfies Record<string, TerminalFontFamily>;

export type TerminalFontFamilyId = keyof typeof TERMINAL_FONTS;

export const DEFAULT_TERMINAL_FONT = TERMINAL_FONTS.jetBrainsMono;
export const DEFAULT_TERMINAL_FONT_ID = 'jetBrainsMono' satisfies TerminalFontFamilyId;
