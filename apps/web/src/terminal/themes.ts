export interface TerminalTheme {
  readonly name: string;
  readonly foreground: readonly [number, number, number];
  readonly background: readonly [number, number, number];
  readonly cursor: readonly [number, number, number];
  readonly palette: readonly (readonly [number, number, number])[];
}

export const TERMINAL_THEMES = {
  catppuccinMocha: {
    name: 'Catppuccin Mocha',
    foreground: [205, 214, 244],
    background: [30, 30, 46],
    cursor: [245, 224, 220],
    palette: [
      [69, 71, 90],
      [243, 139, 168],
      [166, 227, 161],
      [249, 226, 175],
      [137, 180, 250],
      [245, 194, 231],
      [148, 226, 213],
      [186, 194, 222],
      [88, 91, 112],
      [243, 139, 168],
      [166, 227, 161],
      [249, 226, 175],
      [137, 180, 250],
      [245, 194, 231],
      [148, 226, 213],
      [166, 173, 200],
    ],
  },
  phosphor: {
    name: 'Phosphor',
    foreground: [213, 255, 224],
    background: [7, 18, 12],
    cursor: [174, 255, 189],
    palette: [
      [20, 36, 26],
      [255, 107, 107],
      [117, 255, 153],
      [236, 231, 126],
      [107, 181, 255],
      [213, 145, 255],
      [111, 236, 219],
      [213, 255, 224],
      [65, 93, 73],
      [255, 139, 139],
      [154, 255, 181],
      [255, 245, 156],
      [148, 204, 255],
      [226, 174, 255],
      [151, 255, 241],
      [238, 255, 243],
    ],
  },
  graphite: {
    name: 'Graphite',
    foreground: [229, 231, 235],
    background: [13, 15, 18],
    cursor: [255, 255, 255],
    palette: [
      [39, 43, 49],
      [239, 68, 68],
      [34, 197, 94],
      [234, 179, 8],
      [96, 165, 250],
      [192, 132, 252],
      [45, 212, 191],
      [229, 231, 235],
      [75, 85, 99],
      [248, 113, 113],
      [74, 222, 128],
      [250, 204, 21],
      [147, 197, 253],
      [216, 180, 254],
      [94, 234, 212],
      [249, 250, 251],
    ],
  },
} as const satisfies Record<string, TerminalTheme>;

export type TerminalThemeId = keyof typeof TERMINAL_THEMES;

export const DEFAULT_TERMINAL_THEME = TERMINAL_THEMES.catppuccinMocha;
export const DEFAULT_TERMINAL_THEME_ID = 'catppuccinMocha' satisfies TerminalThemeId;

export function rgbCss([r, g, b]: readonly [number, number, number]): string {
  return `rgb(${r}, ${g}, ${b})`;
}
