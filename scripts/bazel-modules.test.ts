import { describe, expect, test } from 'bun:test';

import { namedReferences } from './bazel-modules';

describe('namedReferences', () => {
  test('a literal URL relative to the module names a file, through either URL binding', () => {
    const source = [
      "const a = new URL('./fixture.json', import.meta.url);",
      'const b = new globalThis.URL(`../shared/vector.json`, import.meta.url);',
      "const c = new URL('../migrations/', import.meta.url);",
    ].join('\n');
    expect(namedReferences('a.ts', source)).toEqual([
      { kind: 'url', relative: './fixture.json' },
      { kind: 'url', relative: '../shared/vector.json' },
      { kind: 'url', relative: '../migrations/' },
    ]);
  });

  test('import.meta.resolve names what it resolves', () => {
    expect(namedReferences('a.ts', "const elysia = import.meta.resolve('elysia');")).toEqual([
      { kind: 'specifier', specifier: 'elysia' },
    ]);
  });

  test('a computed name, or a URL against another base, names nothing', () => {
    const source = [
      'const page = "index.html";',
      'const a = new URL(`../${page}`, import.meta.url);',
      "const b = new URL('./x.json', 'https://example.com/');",
      "const c = new URL('./y.json', base);",
      "const d = new Other('./z.json', import.meta.url);",
      'const e = import.meta.resolve(name);',
    ].join('\n');
    expect(namedReferences('a.ts', source)).toEqual([]);
  });

  test('a file that does not parse is no answer', () => {
    expect(() => namedReferences('a.ts', 'const = ;')).toThrow('a.ts');
  });
});
