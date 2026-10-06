import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

import { inlineStylesheet, quicksilverFonts } from './vite';

interface Asset {
  readonly type: 'asset';
  readonly fileName: string;
  source: string | Uint8Array;
}

/** A plugin hook called the way the bundler calls it, with a stand-in context. */
function callHook(
  plugin: Plugin,
  name: 'config' | 'generateBundle',
  context: unknown,
  ...args: unknown[]
): unknown {
  const hook = plugin[name] as unknown as (this: unknown, ...hookArgs: unknown[]) => unknown;
  return hook.call(context, ...args);
}

function asset(fileName: string, source: string): Asset {
  return { type: 'asset', fileName, source };
}

const FONTS_DIRECTORY = new URL('../fonts/', import.meta.url);

describe('inlineStylesheet', () => {
  test('every page that links the stylesheet carries it, and the file is gone', () => {
    const link = '<link rel="stylesheet" crossorigin href="/styles.abc.css">';
    const bundle: Record<string, Asset> = {
      'index.html': asset('index.html', `<head>${link}</head>`),
      'privacy.html': asset('privacy.html', `<head>${link}</head>`),
      'styles.abc.css': asset('styles.abc.css', 'a{color:red}/*$vite$:1*/'),
    };
    callHook(inlineStylesheet(), 'generateBundle', {}, {}, bundle);
    // A function replacement, so `$` in the stylesheet is text, not a pattern.
    expect(bundle['index.html']?.source).toBe(
      '<head><style>a{color:red}/*$vite$:1*/</style></head>',
    );
    expect(bundle['privacy.html']?.source).toBe(bundle['index.html']?.source);
    expect(bundle['styles.abc.css']).toBeUndefined();
  });

  test('a stylesheet no page links stops the build', () => {
    const bundle: Record<string, Asset> = {
      'index.html': asset('index.html', '<head></head>'),
      'styles.abc.css': asset('styles.abc.css', 'a{color:red}'),
    };
    expect(() => callHook(inlineStylesheet(), 'generateBundle', {}, {}, bundle)).toThrow(
      'no page links styles.abc.css',
    );
  });
});

describe('quicksilverFonts', () => {
  test('emits every file in fonts/ at /fonts/<file>, byte for byte, and declares each external', () => {
    const files = readdirSync(FONTS_DIRECTORY).sort();
    const plugin = quicksilverFonts();
    const emitted: { fileName: string; originalFileName: string; source: Uint8Array }[] = [];
    callHook(plugin, 'generateBundle', {
      emitFile: (file: { fileName: string; originalFileName: string; source: Uint8Array }) =>
        emitted.push(file),
    });
    expect(emitted.map((file) => file.fileName)).toEqual(files.map((file) => `fonts/${file}`));
    for (const file of emitted) {
      const name = file.fileName.slice('fonts/'.length);
      expect(file.originalFileName).toBe(fileURLToPath(new URL(name, FONTS_DIRECTORY)));
      expect(Buffer.compare(file.source, readFileSync(new URL(name, FONTS_DIRECTORY)))).toBe(0);
    }
    expect(callHook(plugin, 'config', {})).toEqual({
      build: { rolldownOptions: { external: files.map((file) => `/fonts/${file}`) } },
    });
  });
});
