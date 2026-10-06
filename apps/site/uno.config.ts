import { fileURLToPath } from 'node:url';
import { presetQuicksilver } from '@merkur/quicksilver/preset';
import { DISPLAY_STACK, MONO_STACK, UI_STACK } from '@merkur/quicksilver/tokens';
import presetUno from '@unocss/preset-uno';
import { defineConfig, type Extractor, transformerVariantGroup } from 'unocss';

import { FONT_SUBSETS, readSubsets, TERMINAL_FACE } from './src/vite/font-coverage';

/**
 * The website's layer over Quicksilver: its cut of the three faces with their
 * metric-matched fallbacks. The tokens, the base preflight and the shared
 * controls are `presetQuicksilver()`; the page's own rules are
 * `src/styles/site.css`, written against the variables both of these emit.
 *
 * The faces are Quicksilver's, cut to what the pages set
 * (`scripts/subset-fonts.ts`, `src/fonts/subset.json`) and handed to the
 * preset in place of its own blocks, so each family has one declaration.
 *
 * Fallback faces. The headline is the page's largest paint and it is text, so
 * it paints in whatever face is ready. `font-display: swap` paints it at once
 * in a local face and swaps when the web face lands; without these overrides
 * the swap re-wraps the headline and moves everything under it. Each fallback
 * is a local face scaled to the web face's advance and given its ascent and
 * descent, measured in Chromium on 2026-09-26 over a line of this page's copy
 * (the web face's width over the local face's, at 1000px): Geist over Arial
 * at weight 400 and, separately, 500, since Arial has no 500 to widen into;
 * JetBrains Mono over Courier New; Instrument Serif over Times New Roman.
 * Liberation Sans, Mono and Serif are metric twins of those three and stand in
 * for them on Linux.
 */
function fallbackFace(
  family: string,
  locals: readonly string[],
  metrics: { size: string; ascent: string; descent: string },
  weight?: string,
): string {
  return `
        @font-face {
          font-family: '${family}';
          src: ${locals.map((name) => `local('${name}')`).join(', ')};
          ${weight === undefined ? '' : `font-weight: ${weight};`}
          size-adjust: ${metrics.size};
          ascent-override: ${metrics.ascent};
          descent-override: ${metrics.descent};
          line-gap-override: 0%;
        }`;
}

const SANS_LOCALS = ['Arial', 'ArialMT', 'Liberation Sans'];
const FALLBACK_FACES = [
  fallbackFace(
    'Geist Fallback',
    SANS_LOCALS,
    { size: '101.6%', ascent: '98.92%', descent: '29.04%' },
    '100 450',
  ),
  fallbackFace(
    'Geist Fallback',
    SANS_LOCALS,
    { size: '103.85%', ascent: '96.77%', descent: '28.41%' },
    '451 900',
  ),
  fallbackFace('JetBrains Mono Fallback', ['Courier New', 'CourierNewPSMT', 'Liberation Mono'], {
    size: '99.98%',
    ascent: '102.02%',
    descent: '30%',
  }),
  fallbackFace(
    'Instrument Serif Fallback',
    ['Times New Roman', 'TimesNewRomanPSMT', 'Liberation Serif'],
    { size: '84.13%', ascent: '117.67%', descent: '36.85%' },
  ),
].join('\n');

/**
 * The cut faces, from the record `subset-fonts` wrote beside them. The terminal
 * face names its few marks as its range, so only a page that sets one of them
 * ever fetches it.
 */
function siteFaces(): string {
  const record = readSubsets(fileURLToPath(new URL('./src/fonts', import.meta.url)));
  return FONT_SUBSETS.map((face) => {
    const cut = record[face.file];
    if (cut === undefined) throw new Error(`uno.config: no cut of ${face.file}`);
    const range =
      face.file === TERMINAL_FACE
        ? `\n          unicode-range: ${[...cut.characters]
            .map((character) => `U+${(character.codePointAt(0) ?? 0).toString(16).toUpperCase()}`)
            .join(', ')};`
        : '';
    return `
        @font-face {
          font-family: '${cut.family}';
          font-style: ${face.style ?? 'normal'};
          font-weight: ${cut.weight};
          font-display: swap;
          src: url('/src/fonts/${face.file}') format('woff2');${range}
        }`;
  }).join('\n');
}

/** A Quicksilver stack with the fallback face second, after the web face it stands in for. */
function withFallback(stack: string, face: string): string {
  const lead = `'${face}', `;
  if (!stack.startsWith(lead)) throw new Error(`uno.config: ${stack} does not lead with ${face}`);
  return `${lead}'${face} Fallback', ${stack.slice(lead.length)}`;
}

/**
 * The preset's radius, duration, easing and lit-edge steps as variables, so the
 * page's own stylesheet takes each value from the token rather than retyping it.
 */
function themeVariables(): string {
  const theme: unknown = presetQuicksilver().theme;
  const group = (name: string): Record<string, string> => {
    const value =
      typeof theme === 'object' && theme !== null ? Reflect.get(theme, name) : undefined;
    if (typeof value !== 'object' || value === null)
      throw new Error(`uno.config: no theme.${name}`);
    return Object.fromEntries(
      Object.entries(value).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
  };
  const lines: string[] = [];
  for (const [step, value] of Object.entries(group('borderRadius')))
    lines.push(`--radius-${step}: ${value};`);
  for (const [step, value] of Object.entries(group('duration')))
    lines.push(`--duration-${step}: ${value};`);
  const easing = group('easing');
  const lift = group('boxShadow').lift;
  if (easing.out === undefined || lift === undefined)
    throw new Error('uno.config: no out easing or lift shadow');
  lines.push(`--ease-out: ${easing.out};`, `--shadow-lift: ${lift};`);
  return lines.map((line) => `          ${line}`).join('\n');
}

/**
 * The site's UI stack is Quicksilver's without its Windows and Android system
 * faces: Geist is self-hosted and always arrives, and the metric-matched
 * fallback holds its place until it does, so the page never names Segoe UI or
 * Roboto (the rulebook's banned faces) as a face it might draw in.
 */
const SITE_UI = withFallback(UI_STACK.replace(", 'Segoe UI', Roboto", ''), 'Geist');
if (/Segoe UI|Roboto/.test(SITE_UI))
  throw new Error(`uno.config: ${SITE_UI} still names a banned face`);
const SITE_MONO = withFallback(MONO_STACK, 'JetBrains Mono');
/** A terminal mark (`.tg`): the site's mono, then the app terminal's face for what it lacks. */
const TERMINAL_MONO = SITE_MONO.replace(
  "'JetBrains Mono', ",
  "'JetBrains Mono', 'Merkur Terminal', ",
);
if (TERMINAL_MONO === SITE_MONO) throw new Error('uno.config: no terminal stack');
/**
 * The mono faces load once the page has painted its first content (`main.ts`
 * sets `html[data-faces]`), so the first screen's paint waits on the
 * headline's face and the wordmark's and nothing else. Until then mono text is
 * set in its metric-matched fallback, so the swap moves nothing. Without script
 * the whole stacks apply from the start.
 */
const FIRST_PAINT_MONO = SITE_MONO.replace("'JetBrains Mono', ", '');
const FIRST_PAINT_TERMINAL_MONO = TERMINAL_MONO.replace(
  "'JetBrains Mono', 'Merkur Terminal', ",
  '',
);
if (FIRST_PAINT_MONO === SITE_MONO || FIRST_PAINT_TERMINAL_MONO === TERMINAL_MONO) {
  throw new Error('uno.config: no first-paint mono stack');
}
const SITE_DISPLAY = withFallback(DISPLAY_STACK, 'Instrument Serif');

/**
 * Utilities come from `class` attributes only. UnoCSS's default extractor
 * reads every word of a page as a possible class, so the pages' prose ("p50",
 * "p99") came out as padding rules.
 */
const classAttributes: Extractor = {
  name: 'merkur-site-class-attributes',
  extract({ code }) {
    const found = new Set<string>();
    for (const [, names = ''] of code.matchAll(/\bclass="([^"]*)"/g)) {
      for (const name of names.split(/\s+/)) if (name !== '') found.add(name);
    }
    return found;
  },
};

export default defineConfig({
  // The utilities' variable defaults only where a rule reads them.
  presets: [
    presetUno({ preflight: 'on-demand' }),
    presetQuicksilver({ faces: `${siteFaces()}\n${FALLBACK_FACES}` }),
  ],
  extractors: [classAttributes],
  extractorDefault: false,
  content: {
    pipeline: {
      // UnoCSS's own exclusions, then the blog: its pages and figures set
      // classes of their own (`src/blog/blog.css`), and a utility one of them
      // named would be written into every page's stylesheet.
      exclude: [
        /[\\/]node_modules[\\/]/,
        /[\\/]\.git[\\/]/,
        /\.(css|postcss|sass|scss|less|stylus|styl)($|\?)/,
        /[\\/]blog[\\/]/,
      ],
    },
  },
  transformers: [transformerVariantGroup()],
  theme: {
    fontFamily: { sans: SITE_UI, mono: 'var(--mono)', display: SITE_DISPLAY },
  },
  preflights: [
    {
      getCSS: () => `
        :root {
          --ui: ${SITE_UI};
          --mono: ${FIRST_PAINT_MONO};
          --terminal-mono: ${FIRST_PAINT_TERMINAL_MONO};
          --display: ${SITE_DISPLAY};
${themeVariables()}
        }

        html[data-faces] {
          --mono: ${SITE_MONO};
          --terminal-mono: ${TERMINAL_MONO};
        }

        @media (scripting: none) {
          :root {
            --mono: ${SITE_MONO};
            --terminal-mono: ${TERMINAL_MONO};
          }
        }
      `,
    },
  ],
});
