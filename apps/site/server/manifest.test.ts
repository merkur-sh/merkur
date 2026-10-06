import { describe, expect, test } from 'bun:test';

import { parseSiteManifest, SiteManifestError, siteDocuments } from './manifest';

const STYLE_HASH = 'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=';

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    routes: { '/': 'index.html', '/security': 'security.html' },
    notFound: '404.html',
    files: [
      {
        path: '/assets/main-Ab12Cd34.js',
        file: 'assets/main-Ab12Cd34.js',
        contentType: 'text/javascript; charset=utf-8',
        immutable: true,
        brotli: true,
      },
    ],
    styleHashes: [STYLE_HASH],
    ...overrides,
  };
}

function file(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    path: '/fonts/Inter.woff2',
    file: 'fonts/Inter.woff2',
    contentType: 'font/woff2',
    immutable: true,
    brotli: false,
    ...overrides,
  };
}

describe('parseSiteManifest', () => {
  test('accepts the build contract and lists each document once', () => {
    const parsed = parseSiteManifest(
      manifest({ routes: { '/': 'index.html', '/home': 'index.html' } }),
    );
    expect(parsed.files).toHaveLength(1);
    expect(siteDocuments(parsed)).toEqual(['index.html', '404.html']);
  });

  const refused: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ['an unknown top-level key', manifest({ version: 2 })],
    ['a missing key', { routes: { '/': 'index.html' }, notFound: '404.html', files: [] }],
    ['no routes', manifest({ routes: {} })],
    ['a relative route path', manifest({ routes: { security: 'security.html' } })],
    ['a dot-segment route path', manifest({ routes: { '/a/../security': 'security.html' } })],
    [
      'an encoded dot-segment path',
      manifest({ files: [file({ path: '/%2e%2e/fonts/Inter.woff2' })] }),
    ],
    ['a protocol-relative path', manifest({ files: [file({ path: '//fonts/Inter.woff2' })] })],
    ['an unencoded space', manifest({ files: [file({ path: '/fonts/Inter Var.woff2' })] })],
    ['the health path', manifest({ files: [file({ path: '/healthz' })] })],
    ['a proxied path', manifest({ files: [file({ path: '/analytics/script.js' })] })],
    ['a file shadowing a route', manifest({ files: [file({ path: '/security' })] })],
    ['a path served twice', manifest({ files: [file({}), file({ file: 'fonts/Other.woff2' })] })],
    ['a parent-directory file', manifest({ files: [file({ file: '../secrets.txt' })] })],
    ['an absolute file', manifest({ files: [file({ file: '/etc/passwd' })] })],
    ['a backslash file', manifest({ files: [file({ file: 'fonts\\Inter.woff2' })] })],
    ['a dot-segment document', manifest({ notFound: './404.html' })],
    [
      'a header-splitting content type',
      manifest({ files: [file({ contentType: 'text/plain\r\nx: y' })] }),
    ],
    ['a non-boolean flag', manifest({ files: [file({ immutable: 'yes' })] })],
    ['an extra file key', manifest({ files: [file({ encoding: 'br' })] })],
    ['a malformed style hash', manifest({ styleHashes: ["'unsafe-inline'"] })],
  ];
  for (const [name, value] of refused) {
    test(`refuses ${name}`, () => {
      expect(() => parseSiteManifest(value)).toThrow(SiteManifestError);
    });
  }
});
