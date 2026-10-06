import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { terminalBlockingFontUrls, terminalPromotionFontUrls } from './font-loader';
import { DEFAULT_TERMINAL_FONT, TERMINAL_FONT_ASSET_VERSION } from './fonts';

const FONT_FILES = [
  'JetBrainsMonoNF-Boot.ttf',
  'JetBrainsMonoNF-Regular.ttf',
  'JetBrainsMonoNF-Bold.ttf',
  'JetBrainsMonoNF-Italic.ttf',
  'JetBrainsMonoNF-BoldItalic.ttf',
];

const FONTS_DIRECTORY = resolve(import.meta.dir, '../../public/fonts');

describe('terminal font startup assets', () => {
  test('only the boot face blocks initial terminal readiness', () => {
    // The full regular face parses in ~29ms and is ~1MB brotli; the boot face
    // is what first paint actually waits on.
    expect(terminalBlockingFontUrls(DEFAULT_TERMINAL_FONT)).toEqual([DEFAULT_TERMINAL_FONT.boot]);
  });

  test('promotion fetches every face the boot tier is standing in for', () => {
    expect(terminalPromotionFontUrls(DEFAULT_TERMINAL_FONT)).toEqual([
      DEFAULT_TERMINAL_FONT.regular,
      DEFAULT_TERMINAL_FONT.bold,
      DEFAULT_TERMINAL_FONT.italic,
      DEFAULT_TERMINAL_FONT.boldItalic,
    ]);
  });

  test('promotion URLs are unique and exclude the blocking face', () => {
    const sharedStyles = {
      name: 'Shared styles',
      boot: '/boot.ttf',
      regular: '/boot.ttf',
      bold: '/bold.ttf',
      italic: '/bold.ttf',
      boldItalic: '/bold.ttf',
    };

    expect(terminalPromotionFontUrls(sharedStyles)).toEqual(['/bold.ttf']);
  });

  test('local immutable-cache URLs carry an explicit content version', () => {
    const contentHash = createHash('sha256');
    for (const fileName of FONT_FILES) {
      contentHash.update(readFileSync(resolve(FONTS_DIRECTORY, fileName)));
    }
    expect(TERMINAL_FONT_ASSET_VERSION).toBe(contentHash.digest('hex').slice(0, 12));
    for (const url of [
      DEFAULT_TERMINAL_FONT.boot,
      DEFAULT_TERMINAL_FONT.regular,
      DEFAULT_TERMINAL_FONT.bold,
      DEFAULT_TERMINAL_FONT.italic,
      DEFAULT_TERMINAL_FONT.boldItalic,
    ]) {
      expect(url).toEndWith(`?v=${TERMINAL_FONT_ASSET_VERSION}`);
    }
  });

  test('shipped font bytes match the subset provenance manifest', () => {
    // The `.ttf` files are re-emitted from upstream with hb-subset. The manifest
    // is what makes that reversible, so it must not drift from the bytes it
    // claims to describe.
    const manifest = JSON.parse(
      readFileSync(resolve(FONTS_DIRECTORY, 'SUBSET.json'), 'utf8'),
    ) as SubsetManifest;

    expect(manifest.faces.map((face) => face.file).sort()).toEqual([...FONT_FILES].sort());
    for (const face of manifest.faces) {
      const bytes = readFileSync(resolve(FONTS_DIRECTORY, face.file));
      expect(bytes.byteLength).toBe(face.bytes);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(face.sha256);
    }
  });
});

interface SubsetManifest {
  readonly faces: readonly {
    readonly file: string;
    readonly sha256: string;
    readonly bytes: number;
  }[];
}
