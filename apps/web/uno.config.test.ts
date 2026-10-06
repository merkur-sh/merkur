import { describe, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createGenerator } from 'unocss';

import config from './uno.config';

/**
 * What the app's layer over Quicksilver emits: its own shortcuts and its own
 * preflight, generated from the whole config so they are asserted exactly as
 * the build composes them with the preset. The shared vocabulary is pinned in
 * packages/quicksilver/src/preset.test.ts.
 *
 * UnoCSS applies the utilities inside a shortcut in its rule order, not in the
 * order they were written, so the emitted declarations are asserted rather
 * than the shortcut strings. Within one rule the last declaration of a
 * property wins, which is what `declarations()` resolves.
 */
async function declarations(token: string): Promise<Record<string, string>> {
  const uno = await createGenerator(config);
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

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx$/.test(entry.name) && !entry.name.includes('.test.')) out.push(full);
  }
  return out;
}

function escapeToken(token: string): string {
  return token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('layout shortcuts', () => {
  test('the terminal screen is a full-viewport column', async () => {
    // It is the one screen that is not the 460px card, and it is the one whose
    // absence is invisible in review: deleting this shortcut in a config
    // rewrite left `<section class="terminal-shell">` with no layout at all, so
    // `#terminal-viewport` had no flex parent to grow into, the grid collapsed
    // to nothing, and the connecting overlay's `inset-0` box collapsed with it
    // — a black screen with the card pinned to the top edge.
    const shell = await declarations('terminal-shell');
    expect(shell.display).toBe('flex');
    expect(shell['flex-direction']).toBe('column');
    expect(shell.height).toBe('100dvh');
    expect(shell.overflow).toBe('hidden');
  });

  test('above the column width the app becomes a window', async () => {
    const uno = await createGenerator(config);
    const { css } = await uno.generate('app-frame', { preflights: false });
    const frame = /@media \(min-width: *461px\)\{\s*\.app-frame\{([^}]*)\}/.exec(css)?.[1];
    if (frame === undefined) throw new Error('app-frame has no wide-viewport rule');
    expect(frame).toContain('border-width');
    expect(frame).toContain('border-radius');
    expect(frame).toContain('box-shadow');
    // This chrome lived in a custom rule named `app-frame`, which never applied
    // because a shortcut of the same name resolves first and the rule is never
    // consulted. It has to be part of the shortcut.
  });
});

describe('the reset', () => {
  test('a width-only border utility actually draws', async () => {
    // border-style's initial value is `none`, so `border-2` alone paints
    // nothing. Every loading spinner in the app is `border-2 border-line3
    // border-t-ink` and every one of them was invisible.
    const uno = await createGenerator(config);
    const { css } = await uno.generate('', { preflights: true });
    const reset = /\*,\s*\*::before,\s*\*::after \{([^}]*)\}/.exec(css)?.[1];
    if (reset === undefined) throw new Error('no universal reset in the preflight');
    expect(reset).toContain('border-style: solid');
    expect(reset).toContain('border-width: 0');
    expect(reset).toContain('box-sizing: border-box');
  });
});

describe('the spinner', () => {
  test('the ring has a head distinct from its track', async () => {
    const uno = await createGenerator(config);
    const { css } = await uno.generate('', { preflights: true });
    const rule = /\.spinner \{([^}]*)\}/.exec(css)?.[1];
    if (rule === undefined) throw new Error('no .spinner in the preflight');
    expect(rule).toContain('border-top-color');
    expect(rule).toContain('animation');
  });

  test('no element combines a border colour with a border-side colour', async () => {
    // `border-line3 border-t-ink` looks like a track and a head. It is not:
    // both utilities write the SAME `--un-border-opacity`, so whichever the
    // generator emits last sets the alpha for both, and the ring came out a
    // uniform opaque white — a spinner that appears not to be spinning. The
    // pair is unusable in this preset; two-tone borders belong in the
    // preflight, where the two colours are literals.
    const uno = await createGenerator(config);
    const { css } = await uno.generate('border-line3 border-t-ink', { preflights: false });
    expect(css).toContain('--un-border-opacity');
    const offenders: string[] = [];
    for (const file of sourceFiles(new URL('./src', import.meta.url).pathname)) {
      const text = await Bun.file(file).text();
      for (const attribute of text.matchAll(/class(?:Name)?="([^"]*)"/g)) {
        const classes = (attribute[1] ?? '').split(/\s+/);
        // A numeric suffix is a WIDTH (`border-b-0`), which collides with nothing.
        const side = classes.some((token) => /^border-[trblxy]-(?!\d)\S/.test(token));
        const all = classes.some((token) =>
          /^border-(?![trblxy]-)(?!solid|dashed|dotted|none|\d)\S/.test(token),
        );
        if (side && all) offenders.push(`${file}: ${attribute[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('the type layer', () => {
  test('the UI face reaches the body and the utilities alike', async () => {
    const uno = await createGenerator(config);
    const { css } = await uno.generate('font-sans font-mono', { preflights: true });
    expect(css).toContain('font-family: var(--ui)');
    expect(css).toContain("'Geist'");
    expect(css).toContain("'JetBrains Mono'");
  });
});

describe('the accent', () => {
  test('selection is ink, so the accent keeps one job', async () => {
    const uno = await createGenerator(config);
    const { css } = await uno.generate('tab-on', { preflights: false });
    const underline = /\.tab-on::after\{([^}]*)\}/.exec(css)?.[1];
    if (underline === undefined) throw new Error('tab-on has no underline rule');
    expect(underline).toContain('248 248 252');
    expect(underline).not.toContain('oklch(');
  });
});

describe('the desk', () => {
  test('the desk is a dot grid over the field, tiled once', async () => {
    const uno = await createGenerator(config);
    const { css } = await uno.generate('', { preflights: true });
    const desk = /body\.app-body::before \{([^}]*)\}/.exec(css)?.[1];
    if (desk === undefined) throw new Error('no desk rule in the preflight');
    expect(desk).toContain('radial-gradient(circle');
    expect(desk).toContain('background-size: 12px 12px, auto');
    expect(desk).not.toContain('feTurbulence');
  });
});
