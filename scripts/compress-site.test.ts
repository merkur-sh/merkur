import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { brotliDecompressSync } from 'node:zlib';

import {
  readSiteManifest,
  SITE_MANIFEST_FILE,
  type SiteManifest,
} from '../apps/site/server/manifest';
import { brotliCompressible, compressSite } from './compress-site';

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function writeDist(files: Record<string, string | Uint8Array>, manifest: SiteManifest) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'merkur-compress-site-'));
  directories.push(directory);
  for (const [file, content] of Object.entries(files)) {
    await Bun.write(path.join(directory, file), content);
  }
  await Bun.write(path.join(directory, SITE_MANIFEST_FILE), JSON.stringify(manifest));
  return directory;
}

function entry(file: string, contentType: string) {
  return { path: `/${file}`, file, contentType, immutable: true, brotli: false };
}

describe('brotliCompressible', () => {
  test('skips only formats that are already compressed', () => {
    for (const type of [
      'font/woff2',
      'image/webp',
      'image/avif',
      'image/png',
      'image/jpeg',
      'IMAGE/WEBP',
    ]) {
      expect({ type, compressible: brotliCompressible(type) }).toEqual({
        type,
        compressible: false,
      });
    }
    for (const type of [
      'text/html; charset=utf-8',
      'text/javascript',
      'application/wasm',
      'application/octet-stream',
      'font/ttf',
      'image/svg+xml',
    ]) {
      expect({ type, compressible: brotliCompressible(type) }).toEqual({
        type,
        compressible: true,
      });
    }
  });
});

describe('compressSite', () => {
  test('writes a decodable sibling for documents and compressible files and marks them', async () => {
    const html = `<!doctype html>${'<p>Merkur</p>'.repeat(50)}`;
    const script = `export const x = ${JSON.stringify('y'.repeat(400))};`;
    const font = Uint8Array.from({ length: 256 }, (_, index) => index);
    const directory = await writeDist(
      {
        'index.html': html,
        '404.html': html,
        'assets/main-Ab12Cd34.js': script,
        'fonts/Inter.woff2': font,
      },
      {
        routes: { '/': 'index.html' },
        notFound: '404.html',
        files: [
          entry('assets/main-Ab12Cd34.js', 'text/javascript; charset=utf-8'),
          entry('fonts/Inter.woff2', 'font/woff2'),
        ],
        styleHashes: [],
      },
    );

    await compressSite(directory);
    // Idempotent: a second run leaves the same bytes and flags.
    const manifest = await compressSite(directory);

    expect(await readSiteManifest(directory)).toEqual(manifest);
    expect(manifest.files.map((file) => [file.file, file.brotli])).toEqual([
      ['assets/main-Ab12Cd34.js', true],
      ['fonts/Inter.woff2', false],
    ]);
    for (const [file, source] of [
      ['index.html', html],
      ['404.html', html],
      ['assets/main-Ab12Cd34.js', script],
    ] as const) {
      const compressed = await Bun.file(path.join(directory, `${file}.br`)).bytes();
      expect(compressed.byteLength).toBeLessThan(Buffer.byteLength(source));
      expect(brotliDecompressSync(compressed).toString()).toBe(source);
    }
    expect(await Bun.file(path.join(directory, 'fonts/Inter.woff2.br')).exists()).toBe(false);
  });

  test('fails on a manifest that names a missing file', async () => {
    const directory = await writeDist(
      { 'index.html': '<!doctype html>', '404.html': '<!doctype html>' },
      {
        routes: { '/': 'index.html' },
        notFound: '404.html',
        files: [entry('assets/missing.js', 'text/javascript')],
        styleHashes: [],
      },
    );
    await expect(compressSite(directory)).rejects.toThrow();
  });
});
