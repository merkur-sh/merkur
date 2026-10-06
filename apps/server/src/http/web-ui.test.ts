import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { serveStaticAsset } from './web-ui';

describe('web ui brotli assets', () => {
  test('serves br when the client accepts it and a precompressed file exists', () => {
    const sourceFile = writeTempAsset('app.js', 'console.log("hello");');
    writeFileSync(`${sourceFile}.br`, 'compressed');

    const request = new Request('https://merkur.example/app.js', {
      headers: { 'accept-encoding': 'gzip, br' },
    });

    const response = serveStaticAsset(request, sourceFile);

    expect(response.headers.get('content-encoding')).toBe('br');
    expect(response.headers.get('vary')).toBe('Accept-Encoding');
    expect(response.headers.get('content-type')).toBe('text/javascript;charset=utf-8');
  });

  test('falls back to the source file without br support', () => {
    expectSourceFallbackForAcceptEncoding('gzip');
  });

  test('falls back to the source file when br is disabled by quality', () => {
    expectSourceFallbackForAcceptEncoding('gzip, br;q=0');
  });
});

function expectSourceFallbackForAcceptEncoding(acceptEncoding: string): void {
  const sourceFile = writeTempAsset('app.js', 'console.log("hello");');
  writeFileSync(`${sourceFile}.br`, 'compressed');

  const request = new Request('https://merkur.example/app.js', {
    headers: { 'accept-encoding': acceptEncoding },
  });

  const response = serveStaticAsset(request, sourceFile);

  expect(response.headers.get('content-encoding')).toBeNull();
  expect(response.headers.get('vary')).toBe('Accept-Encoding');
  expect(response.headers.get('content-type')).toBe('text/javascript;charset=utf-8');
}

function writeTempAsset(fileName: string, body: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'merkur-web-ui-'));
  const file = path.join(directory, fileName);
  writeFileSync(file, body);
  return file;
}
