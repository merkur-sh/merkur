import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  buildSiteManifest,
  NOT_FOUND,
  pageStyleHashes,
  ROUTES,
  robots,
  sitemap,
} from './site-manifest';

const STYLE = 'body{color:#b9b9c0}';
const PAGE = `<!doctype html><html><head><style>${STYLE}</style><script type="module" src="/assets/main-AbCdEf12.js"></script></head><body></body></html>`;

let dist = '';

function write(path: string, content: string): void {
  const file = join(dist, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function site(): void {
  dist = mkdtempSync(join(tmpdir(), 'merkur-site-'));
  for (const page of [...Object.values(ROUTES), NOT_FOUND]) write(page, PAGE);
  write('assets/main-AbCdEf12.js', 'export {};');
  write('assets/orb-Zx_9-abc.webp', 'webp');
  write('fonts/Geist-latin.woff2', 'woff2');
  write('og.png', 'png');
}

afterEach(() => {
  if (dist !== '') rmSync(dist, { recursive: true, force: true });
  dist = '';
});

describe('site-manifest.json', () => {
  test('routes the pages, lists every other file with its type and cache class, and hashes the inline styles', () => {
    site();
    const manifest = buildSiteManifest(dist, ROUTES);
    expect(manifest.routes).toEqual(ROUTES);
    expect(manifest.routes['/']).toBe('index.html');
    expect(manifest.notFound).toBe('404.html');
    expect(manifest.files).toEqual([
      {
        path: '/assets/main-AbCdEf12.js',
        file: 'assets/main-AbCdEf12.js',
        contentType: 'text/javascript; charset=utf-8',
        immutable: true,
        brotli: false,
      },
      {
        path: '/assets/orb-Zx_9-abc.webp',
        file: 'assets/orb-Zx_9-abc.webp',
        contentType: 'image/webp',
        immutable: true,
        brotli: false,
      },
      {
        path: '/fonts/Geist-latin.woff2',
        file: 'fonts/Geist-latin.woff2',
        contentType: 'font/woff2',
        immutable: false,
        brotli: false,
      },
      {
        path: '/og.png',
        file: 'og.png',
        contentType: 'image/png',
        immutable: false,
        brotli: false,
      },
    ]);
    expect(manifest.styleHashes).toEqual([
      `sha256-${createHash('sha256').update(STYLE).digest('base64')}`,
    ]);
  });

  test('the sitemap lists every route on the site’s origin, and robots.txt names it', () => {
    const xml = sitemap('https://merkur.sh', ROUTES);
    for (const path of Object.keys(ROUTES)) {
      expect(xml).toContain(`<loc>https://merkur.sh${path}</loc>`);
    }
    expect(xml).not.toContain(NOT_FOUND);
    expect(robots('https://merkur.sh')).toBe(
      'User-agent: *\nAllow: /\n\nSitemap: https://merkur.sh/sitemap.xml\n',
    );
  });

  test('structured data is the one script a page may carry inline', () => {
    expect(
      pageStyleHashes('<script type="application/ld+json">{"a":1}</script>', 'index.html'),
    ).toEqual([]);
  });

  test('a file the server reserves for itself stops the build', () => {
    site();
    write('healthz', '');
    expect(() => buildSiteManifest(dist, ROUTES)).toThrow('no content type for healthz');
    rmSync(join(dist, 'healthz'));
    write('analytics/script.js', '');
    expect(() => buildSiteManifest(dist, ROUTES)).toThrow(
      '/analytics/script.js is reserved for the server',
    );
  });

  test('a page the CSP would break, a missing page or an unlisted kind of file stops the build', () => {
    expect(() => pageStyleHashes('<script>alert(1)</script>', 'index.html')).toThrow(
      'index.html has an inline script',
    );
    expect(() => pageStyleHashes('<p style="color:red">', 'index.html')).toThrow('style attribute');
    site();
    write('assets/unhashed.js', '');
    expect(() => buildSiteManifest(dist, ROUTES)).toThrow(
      'assets/unhashed.js is under assets/ without a content hash',
    );
    rmSync(join(dist, 'assets/unhashed.js'));
    write('notes.md', '');
    expect(() => buildSiteManifest(dist, ROUTES)).toThrow('no content type for notes.md');
    rmSync(join(dist, 'notes.md'));
    rmSync(join(dist, '404.html'));
    expect(() => buildSiteManifest(dist, ROUTES)).toThrow('the build has no 404.html');
  });
});
