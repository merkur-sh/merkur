import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import presetUno from '@unocss/preset-uno';
import { createGenerator } from 'unocss';

import { cssEase, OUT_EASE, TRAVEL_EASE } from './motion';
import { presetQuicksilver } from './preset';
import { COLORS } from './tokens';

/**
 * The preset with nothing around it: no surface's config, so whatever this
 * file asserts is the preset's own doing and holds on every surface.
 */
function generator() {
  return createGenerator({ presets: [presetUno(), presetQuicksilver()] });
}

/**
 * What a shortcut actually emits, which is not what reading its string says.
 *
 * UnoCSS applies the utilities inside a shortcut in ITS rule order, not in the
 * order they were written, so a variant cannot count on overriding a
 * declaration its base already set. `btn-icon` was written as `btn … p-0 grid`
 * and shipped as `padding: 0 13px; display: inline-flex` — 26px of horizontal
 * padding inside a 30px square, which left every icon in the app a 2px sliver
 * and the terminal's Back button visibly empty. Nothing caught it: every class
 * was real, the CSS was valid, and `check`, `test:unit` and the e2e suites were
 * all green.
 *
 * So the emitted declarations are asserted rather than the shortcut strings.
 * Within one rule the last declaration of a property wins, which is what
 * `declarations()` resolves.
 */
async function declarations(token: string): Promise<Record<string, string>> {
  const uno = await generator();
  const { css } = await uno.generate(token, { preflights: false });
  const body = new RegExp(String.raw`[\n}]\.${escapeToken(token)}\{([^}]*)\}`).exec(css)?.[1];
  if (body === undefined) throw new Error(`No rule emitted for .${token}`);
  const resolved: Record<string, string> = {};
  for (const declaration of body.split(';')) {
    const separator = declaration.indexOf(':');
    if (separator <= 0) continue;
    resolved[declaration.slice(0, separator).trim()] = declaration.slice(separator + 1).trim();
  }
  return resolved;
}

function escapeToken(token: string): string {
  return token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function preflightCss(): Promise<string> {
  const uno = await generator();
  return (await uno.generate('', { preflights: true })).css;
}

interface FontProvenance {
  readonly files: Readonly<
    Record<
      string,
      { readonly bytes: number; readonly sha256: string; readonly unicodeRange: string }
    >
  >;
}

const FONTS_DIRECTORY = new URL('../fonts/', import.meta.url);

describe('tokens', () => {
  test('a surface can bring its own cut of the faces, and the default is the shipped set', async () => {
    const own = "@font-face { font-family: 'Geist'; src: url('/cut.woff2'); }";
    const uno = await createGenerator({
      presets: [presetUno(), presetQuicksilver({ faces: own })],
    });
    const { css } = await uno.generate('', { preflights: true });
    expect(css).toContain(own);
    expect(css).not.toContain("url('/fonts/Geist-latin.woff2')");
    expect(await preflightCss()).toContain("url('/fonts/Geist-latin.woff2')");
  });

  test('every colour is a variable with the value its utility is generated from', async () => {
    // One object feeds both, so a colour cannot be correct as a class and stale
    // as a variable; this pins that the preflight still reads that object.
    const css = await preflightCss();
    for (const [name, value] of Object.entries(COLORS)) {
      expect(css).toContain(`--${name}: ${value};`);
    }
    expect(css).toContain('color-scheme: dark');
  });

  test('CSS transitions decelerate on the curves Motion animates with', async () => {
    expect((await declarations('ease-out'))['transition-timing-function']).toBe(cssEase(OUT_EASE));
    expect((await declarations('ease-travel'))['transition-timing-function']).toBe(
      cssEase(TRAVEL_EASE),
    );
  });
});

describe('type layer', () => {
  test('all three faces are self-hosted, with the ranges the files were cut for', async () => {
    const css = await preflightCss();
    for (const file of [
      'Geist-latin.woff2',
      'Geist-latin-ext.woff2',
      'JetBrainsMono-latin.woff2',
      'JetBrainsMono-latin-ext.woff2',
      'InstrumentSerif-latin.woff2',
      'InstrumentSerif-latin-ext.woff2',
    ]) {
      expect(css).toContain(`url('/fonts/${file}')`);
    }
    // A face with no range would be downloaded by every session for glyphs
    // almost none of them render.
    expect(css.match(/unicode-range:/g)).toHaveLength(6);
    // Never a third-party stylesheet: it would block the first paint this app
    // exists to make instant, and leave an offline PWA with no typeface.
    expect(css).not.toContain('fonts.googleapis.com');
    expect(css).not.toContain('fonts.gstatic.com');
  });

  test('each shipped face is the file its provenance records, declared for its range', async () => {
    // The faces are fetched verbatim from Google Fonts, and the ranges are what
    // Google declared for each file. Neither is re-derivable here, so the
    // committed bytes and the emitted ranges are held to the record.
    const provenance = JSON.parse(
      readFileSync(new URL('../FONTS.json', import.meta.url), 'utf8'),
    ) as FontProvenance;
    const declared = new Map<string, string>();
    for (const [, block = ''] of (await preflightCss()).matchAll(/@font-face \{([^}]*)\}/g)) {
      const file = /url\('\/fonts\/([^']+)'\)/.exec(block)?.[1];
      const range = /unicode-range: ([^;]+);/.exec(block)?.[1];
      if (file === undefined || range === undefined) throw new Error(`incomplete @font-face`);
      declared.set(file, range);
    }
    expect([...declared.keys()].sort()).toEqual(Object.keys(provenance.files).sort());
    for (const [file, record] of Object.entries(provenance.files)) {
      const bytes = readFileSync(new URL(file, FONTS_DIRECTORY));
      expect(bytes.byteLength).toBe(record.bytes);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(record.sha256);
      expect(declared.get(file)).toBe(record.unicodeRange);
    }
  });

  test('what ships at /fonts is the faces and the licence of every family', () => {
    // `quicksilverFonts()` ships the whole directory, so its listing is the
    // shipped set: nothing beyond the faces, nothing missing from the licences.
    const provenance = JSON.parse(
      readFileSync(new URL('../FONTS.json', import.meta.url), 'utf8'),
    ) as FontProvenance;
    expect(readdirSync(FONTS_DIRECTORY).sort()).toEqual(
      [
        ...Object.keys(provenance.files),
        'OFL-Geist.txt',
        'OFL-InstrumentSerif.txt',
        'OFL-JetBrainsMono.txt',
      ].sort(),
    );
  });

  test('the display register is real CSS, not silently dropped utilities', async () => {
    // A utility the preset does not know emits nothing and no gate notices, so
    // the register's three defining properties are asserted rather than the
    // shortcut strings being read.
    const md = await declarations('display-md');
    expect(md['font-size']).toBe('24px');
    expect(md['letter-spacing']).toBe('-0.022em');
    expect(md['text-wrap']).toBe('balance');
    const lg = await declarations('display-lg');
    expect(lg['font-size']).toBe('36px');
    expect(lg['--un-numeric-spacing']).toBe('tabular-nums');
    const wordmark = await declarations('wordmark');
    expect(wordmark['font-family']).toContain("'Instrument Serif'");
  });

  test('an eyebrow is legible, not a placeholder', async () => {
    // --meta (#9899a1), which clears 4.5:1 on every surface it sits on; --faint
    // is reserved for placeholders that are read once and then replaced.
    const eyebrow = await declarations('eyebrow');
    expect(eyebrow.color).toContain('152 153 161');
  });
});

describe('button shortcuts', () => {
  test('an icon button is a square with no text padding', async () => {
    const icon = await declarations('btn-icon');
    expect(icon.width).toBe('2rem');
    expect(icon.height).toBe('2rem');
    expect(icon.display).toBe('grid');
    expect(icon['place-items']).toBe('center');
    // The whole defect: any padding here is subtracted from the glyph.
    for (const property of Object.keys(icon)) {
      expect(property).not.toStartWith('padding');
    }
  });

  test('a text button keeps its own padding and layout', async () => {
    const primary = await declarations('btn-primary');
    expect(primary.display).toBe('inline-flex');
    expect(primary['padding-left']).toBe('13px');
    expect(primary['padding-right']).toBe('13px');
    expect(primary.height).toBe('2rem');
  });

  test('the size modifiers are emitted after the variants they resize', async () => {
    // `btn-sm` and `btn-quiet` are separate classes in the markup, so which one
    // wins is decided by their order in the sheet rather than by the element.
    const uno = await generator();
    const { css } = await uno.generate('btn-quiet btn-sm', { preflights: false });
    expect(css.indexOf('.btn-sm{')).toBeGreaterThan(css.indexOf('.btn-quiet{'));
  });
});

describe('selector merging', () => {
  test('a vendor pseudo-element never shares a rule with a plain utility', async () => {
    // A selector list is dropped whole when any member is unparseable, and
    // `::-moz-range-thumb` is unparseable to Chromium and WebKit. Merged with
    // `.appearance-none`, it took `appearance-none` — and `bg-transparent`,
    // `rounded-full`, `cursor-pointer` — out of every browser but Firefox.
    // The generator here has no config of its own: the preset turns merging off.
    const uno = await generator();
    const { css } = await uno.generate(
      'appearance-none bg-transparent rounded-full [&::-moz-range-thumb]:appearance-none [&::-moz-range-track]:bg-transparent [&::-moz-range-thumb]:rounded-full [&::-webkit-slider-thumb]:appearance-none',
      { preflights: false },
    );
    for (const rule of css.matchAll(/(?:^|\n)([^{\n][^{]*)\{/g)) {
      const selector = rule[1] ?? '';
      if (selector.includes(',')) {
        throw new Error(`merged selector list emitted: ${selector}`);
      }
    }
    for (const plain of ['.appearance-none{', '.bg-transparent{', '.rounded-full{']) {
      expect(css).toContain(`\n${plain}`);
    }
  });
});

describe('the accent', () => {
  test('the solid steps are declared in a wide gamut', async () => {
    // One OKLCH declaration per step: a P3 display shows the full chroma and an
    // sRGB display clips to its boundary. No `@supports` twin, no second value.
    const uno = await generator();
    const { css } = await uno.generate('bg-accent bg-accentlo bg-accentdn text-accentlt', {
      preflights: false,
    });
    expect(css.match(/oklch\(/g)).toHaveLength(4);
  });
});

describe('surfaces', () => {
  test('the slab is the largest object and carries the smooth corner', async () => {
    const slab = await declarations('slab');
    expect(slab['border-radius']).toBe('20px');
    expect(slab['corner-shape']).toBe('superellipse(1.6)');
    const card = await declarations('card');
    expect(card['border-radius']).toBe('10px');
    expect(card['corner-shape']).toBe('superellipse(1.6)');
  });
});
