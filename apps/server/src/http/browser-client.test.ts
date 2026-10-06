import { describe, expect, test } from 'bun:test';

import { parseBrowserClient } from './browser-client';

/**
 * Real headers, because the whole difficulty of user-agent parsing is that
 * every Chromium browser claims to be Chrome and Safari, Chrome claims to be
 * Safari, and an iPad in desktop mode claims to be a Mac. A hand-written
 * approximation of one of these strings would test the parser against a guess
 * rather than against what browsers send.
 *
 * These assert the *contract this app depends on* — a name, or none — rather
 * than restating the library's tables. What is pinned here is that Client Hints
 * are read when present, that the headers reach the parser bounded, that an
 * unrecognized request produces no name, and that the installed bit is carried
 * through untouched.
 */
const AGENTS = {
  chromeMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  edgeWindows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0',
  firefoxLinux: 'Mozilla/5.0 (X11; Linux x86_64; rv:129.0) Gecko/20100101 Firefox/129.0',
  safariIos:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
} as const;

const headers = (values: Record<string, string>): Headers => new Headers(values);

describe('parseBrowserClient', () => {
  test('names native clients only from explicit fixed metadata', () => {
    expect(
      parseBrowserClient(
        headers({ 'merkur-client': 'tui', 'merkur-client-platform': 'macOS' }),
        true,
      ),
    ).toEqual({
      browser: 'Merkur TUI',
      platform: 'macOS',
      installed: false,
    });
    expect(
      parseBrowserClient(
        headers({ 'merkur-client': 'tui', 'merkur-client-platform': 'Linux' }),
        false,
      ).platform,
    ).toBe('Linux');
    expect(
      parseBrowserClient(
        headers({ 'merkur-client': 'tui', 'merkur-client-platform': '\u001b[2J' }),
        false,
      ).platform,
    ).toBe(null);
    expect(parseBrowserClient(headers({ 'user-agent': 'merkur-tui/0.1.0' }), false).browser).toBe(
      null,
    );
  });
  test('names the browser and the platform a session row shows', () => {
    expect(parseBrowserClient(headers({ 'user-agent': AGENTS.chromeMac }), false)).toEqual({
      browser: 'Chrome',
      platform: 'macOS',
      installed: false,
    });
    expect(parseBrowserClient(headers({ 'user-agent': AGENTS.firefoxLinux }), false)).toEqual({
      browser: 'Firefox',
      platform: 'Linux',
      installed: false,
    });
    expect(parseBrowserClient(headers({ 'user-agent': AGENTS.safariIos }), false)).toEqual({
      browser: 'Mobile Safari',
      platform: 'iOS',
      installed: false,
    });
  });

  // The single most common way a user-agent parser is wrong: every Chromium
  // browser sends `Chrome/` too, so the specific family has to win.
  test('prefers the specific Chromium family over the Chrome token it also sends', () => {
    const client = parseBrowserClient(headers({ 'user-agent': AGENTS.edgeWindows }), false);
    expect(client.browser).toBe('Edge');
    expect(client.platform).toBe('Windows');
  });

  // Chromium is freezing its `User-Agent`, so the hints are the forward path
  // and have to be read rather than ignored in favour of the legacy header.
  test('reads User-Agent Client Hints when the browser sends them', () => {
    const client = parseBrowserClient(
      headers({
        'user-agent': AGENTS.chromeMac,
        'sec-ch-ua': '"Chromium";v="128", "Not;A=Brand";v="24", "Microsoft Edge";v="128"',
        'sec-ch-ua-platform': '"Android"',
        'sec-ch-ua-mobile': '?0',
      }),
      false,
    );
    expect(client.browser).toBe('Edge');
    expect(client.platform).toBe('Android');
  });

  test('reports no name rather than a guessed one', () => {
    for (const request of [headers({}), headers({ 'user-agent': 'curl/8.6.0' })]) {
      const client = parseBrowserClient(request, false);
      expect(client.browser).toBe(null);
      expect(client.platform).toBe(null);
    }
  });

  // Every header here is attacker-controlled and unbounded, and this runs
  // inside a sign-in. A bounded scan loses nothing an honest client sends.
  test('does not scan an unbounded header', () => {
    const padded = `${'x'.repeat(4_096)} ${AGENTS.chromeMac}`;
    expect(parseBrowserClient(headers({ 'user-agent': padded }), false)).toEqual({
      browser: null,
      platform: null,
      installed: false,
    });
  });

  // Both names reach a row and originate in those same headers, so neither may
  // decide the layout.
  test('bounds a name a browser gives itself', () => {
    const shouty = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ${'W'.repeat(200)}/1.0`;
    const client = parseBrowserClient(headers({ 'user-agent': shouty }), false);
    expect((client.browser ?? '').length).toBeLessThanOrEqual(32);
    expect((client.platform ?? '').length).toBeLessThanOrEqual(32);
  });

  test('carries the installed bit through untouched', () => {
    const request = headers({ 'user-agent': AGENTS.chromeMac });
    expect(parseBrowserClient(request, true).installed).toBe(true);
    expect(parseBrowserClient(request, false).installed).toBe(false);
  });
});
