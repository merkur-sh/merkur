import { describe, expect, test } from 'bun:test';

import { shouldBypassServiceWorkerRequest } from './service-worker-routing';

const APP_ORIGIN = 'https://merkur.example';

function bypasses(url: string, method = 'GET'): boolean {
  return shouldBypassServiceWorkerRequest({ method, url }, APP_ORIGIN);
}

describe('service worker routing', () => {
  test('bypasses terminal fonts so startup never waits on CacheStorage', () => {
    expect(bypasses(`${APP_ORIGIN}/fonts/JetBrainsMonoNF-Regular.ttf?v=content`)).toBe(true);
    expect(bypasses(`${APP_ORIGIN}/fonts/JetBrainsMonoNF-Boot.ttf`)).toBe(true);
  });

  test('serves the UI faces from the shell cache, unlike the terminal faces beside them', () => {
    // A first paint in the fallback typeface is what the shell cache exists to
    // prevent, so these go through the worker even though they share a
    // directory with the .ttf faces that must not.
    expect(bypasses(`${APP_ORIGIN}/fonts/Geist-latin.woff2`)).toBe(false);
    expect(bypasses(`${APP_ORIGIN}/fonts/JetBrainsMono-latin.woff2`)).toBe(false);
  });

  test('continues bypassing API, cross-origin, and non-GET requests', () => {
    expect(bypasses(`${APP_ORIGIN}/api/session`)).toBe(true);
    expect(bypasses('https://cdn.example/font.ttf')).toBe(true);
    expect(bypasses(`${APP_ORIGIN}/assets/main.js`, 'POST')).toBe(true);
  });

  test('sends the legal pages to the server, never the cached app shell', () => {
    expect(bypasses(`${APP_ORIGIN}/privacy`)).toBe(true);
    expect(bypasses(`${APP_ORIGIN}/terms`)).toBe(true);
    expect(bypasses(`${APP_ORIGIN}/legal/legal.css`)).toBe(true);
    expect(bypasses(`${APP_ORIGIN}/privacy-settings`)).toBe(false);
  });

  test('keeps same-origin shell assets on the service-worker path', () => {
    expect(bypasses(`${APP_ORIGIN}/`)).toBe(false);
    expect(bypasses(`${APP_ORIGIN}/assets/main.js`)).toBe(false);
    expect(bypasses(`${APP_ORIGIN}/terminal/device-1`)).toBe(false);
  });

  /**
   * The reachability probe's target must never be answered from CacheStorage:
   * `shellCacheFirst` caches a successful GET, so a cached `/health/live` would
   * report the network as reachable forever, including while it is dead.
   */
  test('health probes bypass the cache entirely', () => {
    expect(
      shouldBypassServiceWorkerRequest(
        { method: 'GET', url: 'https://app.example/health/live' },
        'https://app.example',
      ),
    ).toBe(true);
    expect(
      shouldBypassServiceWorkerRequest(
        { method: 'GET', url: 'https://app.example/health' },
        'https://app.example',
      ),
    ).toBe(true);
  });

  test('a path merely starting with health is still served normally', () => {
    expect(
      shouldBypassServiceWorkerRequest(
        { method: 'GET', url: 'https://app.example/healthy-shell.js' },
        'https://app.example',
      ),
    ).toBe(false);
  });
});
