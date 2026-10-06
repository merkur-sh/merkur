import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createLogger } from '../../logger';
import { webRoutesPlugin } from './web-routes';

const ORIGIN = 'https://merkur.example';

describe('web routes', () => {
  test('serves the legal pages at their short URLs, not the app shell', async () => {
    const app = createApp(
      writeDist({ privacy: '<h1>Privacy Policy</h1>', terms: '<h1>Terms</h1>' }),
    );

    for (const [route, heading] of [
      ['/privacy', 'Privacy Policy'],
      ['/terms', 'Terms'],
    ] as const) {
      const response = await app.handle(new Request(`${ORIGIN}${route}`));
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toStartWith('text/html');
      expect(await response.text()).toContain(heading);
    }
  });

  test('answers 404 rather than the shell when a legal page is missing from the build', async () => {
    const app = createApp(writeDist({}));

    const response = await app.handle(new Request(`${ORIGIN}/privacy`));

    expect(response.status).toBe(404);
  });
});

function createApp(dist: string) {
  return webRoutesPlugin({
    logger: createLogger('web-routes-test'),
    webIndexFile: path.join(dist, 'index.html'),
    webDistDirectory: dist,
    publicOrigin: ORIGIN,
  });
}

function writeDist(pages: { readonly privacy?: string; readonly terms?: string }): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'merkur-web-routes-'));
  writeFileSync(path.join(directory, 'index.html'), '<div id="app-shell"></div>');
  mkdirSync(path.join(directory, 'legal'));
  if (pages.privacy !== undefined) {
    writeFileSync(path.join(directory, 'legal', 'privacy.html'), pages.privacy);
  }
  if (pages.terms !== undefined)
    writeFileSync(path.join(directory, 'legal', 'terms.html'), pages.terms);
  return directory;
}
