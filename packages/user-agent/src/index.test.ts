import { describe, expect, test } from 'bun:test';

import { USER_AGENT_CASES } from './fixtures';
import { parseBrowser, parsePlatform } from './index';

describe('browser identity', () => {
  for (const sample of USER_AGENT_CASES) {
    test(sample.name, () => {
      const headers = new Headers(sample.headers);
      expect(parseBrowser(headers)).toEqual({ browser: sample.browser, platform: sample.platform });
      expect(parsePlatform(headers)).toBe(sample.platform);
    });
  }

  test('specific brands win in every ordering, without trusting GREASE text', () => {
    const brands = ['"Chromium";v="128"', '"Google Chrome";v="128"', '"Microsoft Edge";v="128"'];
    for (const first of brands) {
      for (const second of brands.filter((brand) => brand !== first)) {
        const third = brands.find((brand) => brand !== first && brand !== second);
        const field = `"Not\\"Edge, Brand";v="99", ${first}, ${second}, ${third}`;
        expect(parseBrowser(new Headers({ 'sec-ch-ua': field })).browser).toBe('Edge');
      }
    }
  });

  test('generic Chromium stays generic and unknown brands never become display labels', () => {
    expect(
      parseBrowser(new Headers({ 'sec-ch-ua': '"Chromium";v="128", "Mystery";v="1"' })).browser,
    ).toBe('Chromium');
    expect(parseBrowser(new Headers({ 'sec-ch-ua': '"Mystery";v="1"' })).browser).toBeNull();
    expect(parseBrowser(new Headers({ 'sec-ch-ua': '"Not;A=Brand";v="24"' })).browser).toBeNull();
  });

  test('conflicting specific brands are unknown in either ordering', () => {
    for (const field of [
      '"Brave";v="1", "Microsoft Edge";v="1"',
      '"Microsoft Edge";v="1", "Brave";v="1"',
    ]) {
      expect(parseBrowser(new Headers({ 'sec-ch-ua': field })).browser).toBeNull();
    }
  });

  test('parameter types, escaped GREASE, whitespace, and duplicate keys follow structured fields', () => {
    for (const field of [
      '"Google Chrome";v="128";flag;number=-12;decimal=1.25;token=abc/def;bytes=:YWJj:;boolean=?1',
      '"Google Chrome";v=?1;v="128"',
      '"Not\\\\A\\"Brand";v="99",\t"Google Chrome"; v="128"',
      '"Google Chrome";v="128", "Google Chrome";v="128"',
    ]) {
      expect(parseBrowser(new Headers({ 'sec-ch-ua': field })).browser).toBe('Chrome');
    }
    expect(parsePlatform(new Headers({ 'sec-ch-ua-platform': '"Windows";extra=?1' }))).toBe(
      'Windows',
    );
  });

  test('a malformed brand list is rejected whole, including a valid prefix', () => {
    for (const field of [
      '',
      'Google Chrome',
      '"Google Chrome"',
      '"Google Chrome";v=128',
      '"Google Chrome";v="128",',
      '"Google Chrome";v="128", junk',
      '"Google Chrome";v="128" garbage',
      '"Google Chrome";v="128";v=?1',
      '"Google Chrome";v="128";x="unterminated',
      '"Google Chrome";v="128";x=?2',
      '"Google Chrome";v="128";x=1.2345',
      '"Google Chrome";v="128";x=1234567890123456',
      '"Google Chrome";v="128";X=token',
      '"Google Chrome";v="128";x="bad\\q"',
      '"Google Chrome";v="128", "bad\tbrand";v="1"',
      '("Google Chrome";v="128")',
    ]) {
      const headers = new Headers({ 'user-agent': 'Chrome/128.0', 'sec-ch-ua': field });
      expect(parseBrowser(headers).browser, field).toBeNull();
    }
  });

  test('platform hints must name a supported OS, and never infer one from arbitrary text', () => {
    for (const field of [
      '',
      'Windows',
      '"Unknown"',
      '"Windows", "Linux"',
      '"Linux"x',
      '"Win\\dows"',
      '"Windows";x=?2',
    ]) {
      const headers = new Headers({
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0)',
        'sec-ch-ua-platform': field,
      });
      expect(parsePlatform(headers), field).toBeNull();
      expect(parseBrowser(headers).platform, field).toBeNull();
    }
    expect(parsePlatform(new Headers({ 'sec-ch-ua-platform': '"Chromium OS"' }))).toBe('Chrome OS');
  });

  test('each hint selects only its own field', () => {
    const ua = 'Mozilla/5.0 (Windows NT 10.0) Chrome/128.0';
    expect(parseBrowser(new Headers({ 'user-agent': ua, 'sec-ch-ua': '"Brave";v="128"' }))).toEqual(
      { browser: 'Brave', platform: 'Windows' },
    );
    expect(
      parseBrowser(new Headers({ 'user-agent': ua, 'sec-ch-ua-platform': '"Android"' })),
    ).toEqual({ browser: 'Chrome', platform: 'Android' });
  });

  test('field bounds reject oversized values without truncating valid prefixes', () => {
    for (const name of ['user-agent', 'sec-ch-ua', 'sec-ch-ua-platform']) {
      const prefix =
        name === 'user-agent'
          ? 'Chrome/128.0 (Windows NT 10.0)'
          : name === 'sec-ch-ua'
            ? '"Google Chrome";v="128"'
            : '"Windows"';
      const value = `${prefix}${'x'.repeat(513)}`;
      expect(parseBrowser(new Headers({ [name]: value }))).toEqual({
        browser: null,
        platform: null,
      });
    }
    const prefix = '"Google Chrome";v="128";pad="';
    const exact = `${prefix}${'x'.repeat(512 - prefix.length - 1)}"`;
    expect(parseBrowser(new Headers({ 'sec-ch-ua': exact })).browser).toBe('Chrome');
    expect(parseBrowser(new Headers({ 'sec-ch-ua': `${exact};x` })).browser).toBeNull();
  });

  test('product matches require token boundaries and a version', () => {
    for (const ua of [
      'NotChrome/128.0',
      'Chrome/',
      'Chrome/nope',
      'OtherFirefox/129.0',
      'Safari/605.1',
    ]) {
      expect(parseBrowser(new Headers({ 'user-agent': ua })).browser).toBeNull();
    }
  });

  test('case-insensitive products, mobile variants, and generic compatibility tokens', () => {
    const samples = [
      ['mozilla/5.0 (linux) chrome/128.0 safari/537.36 edg/128.0', 'Edge'],
      ['Mozilla/5.0 (Android; Mobile; rv:128.0) Gecko/128.0 Firefox/128.0', 'Mobile Firefox'],
      ['Mozilla/5.0 Chrome/128.0 Safari/537.36 OPR/113.0', 'Opera'],
      ['Mozilla/5.0 Chrome/128.0 Safari/537.36 OPRGX/113.0', 'Opera GX'],
      ['Mozilla/5.0 Version/17.5 Mobile/15E148 Safari/604.1 OPiOS/1.0', 'Opera Mini'],
      ['Mozilla/5.0 Chrome/128.0 Safari/537.36 DuckDuckGo/1.0', 'DuckDuckGo'],
      ['Mozilla/5.0 Chrome/128.0 Safari/537.36 YaBrowser/24.0', 'Yandex'],
      ['Mozilla/5.0 Chrome/128.0 Safari/537.36 Chromium/128.0', 'Chromium'],
      ['Mozilla/5.0 Chrome/128.0 Safari/537.36 Brave/1.0', 'Brave'],
      ['Mozilla/5.0 Chrome/128.0 Edg/128.0 OPR/113.0', null],
    ] as const;
    for (const [ua, browser] of samples) {
      expect(parseBrowser(new Headers({ 'user-agent': ua })).browser, ua).toBe(browser);
    }
  });

  test('additional browser products outrank compatibility names in either token order', () => {
    const samples = [
      ['Silk', 'Amazon Silk', 'Chrome'],
      ['HuaweiBrowser', 'Huawei Browser', 'Chrome'],
      ['LibreWolf', 'LibreWolf', 'Firefox'],
      ['MicroMessenger', 'WeChat', 'Chrome'],
      ['MiuiBrowser', 'MIUI Browser', 'Chrome'],
      ['MQQBrowser', 'QQBrowser', 'Chrome'],
      ['QQBrowser', 'QQBrowser', 'Chrome'],
      ['SeaMonkey', 'SeaMonkey', 'Firefox'],
      ['UCBrowser', 'UCBrowser', 'Chrome'],
      ['Waterfox', 'Waterfox', 'Firefox'],
      ['Whale', 'Whale', 'Chrome'],
    ] as const;
    for (const [product, browser, compatibility] of samples) {
      const base = `Mozilla/5.0 (X11; Linux x86_64) ${compatibility}/128.0 Safari/537.36`;
      for (const ua of [`${base} ${product}/12.0`, `${product}/12.0 ${base}`]) {
        const headers = new Headers({ 'user-agent': ua });
        expect(parseBrowser(headers)).toEqual({ browser, platform: 'Linux' });
        if (compatibility === 'Chrome') {
          headers.set('sec-ch-ua', '"Chromium";v="128", "Google Chrome";v="128"');
          expect(parseBrowser(headers).browser, product).toBe(browser);
        }
      }
      for (const suffix of [`Not${product}/12.0`, `${product}/nope`, product]) {
        expect(parseBrowser(new Headers({ 'user-agent': `${base} ${suffix}` })).browser).toBe(
          compatibility,
        );
      }
    }
  });

  test('additional explicit hint brands win regardless of their order or UA compatibility name', () => {
    for (const [brand, browser] of [
      ['Amazon Silk', 'Amazon Silk'],
      ['Huawei Browser', 'Huawei Browser'],
      ['LibreWolf', 'LibreWolf'],
      ['MIUI Browser', 'MIUI Browser'],
      ['QQBrowser', 'QQBrowser'],
      ['SeaMonkey', 'SeaMonkey'],
      ['Silk', 'Amazon Silk'],
      ['UCBrowser', 'UCBrowser'],
      ['Waterfox', 'Waterfox'],
      ['WeChat', 'WeChat'],
      ['Whale', 'Whale'],
    ] as const) {
      const hint = `"${brand}";v="12"`;
      for (const brands of [`${hint}, "Chromium";v="128"`, `"Chromium";v="128", ${hint}`]) {
        expect(
          parseBrowser(new Headers({ 'user-agent': 'Chrome/128.0', 'sec-ch-ua': brands })).browser,
        ).toBe(browser);
      }
    }
  });

  test('new peers stay ambiguous, aliases agree, and embedding apps outrank browsers', () => {
    for (const suffix of ['Waterfox/1.0 LibreWolf/1.0', 'LibreWolf/1.0 Waterfox/1.0']) {
      expect(
        parseBrowser(new Headers({ 'user-agent': `Firefox/128.0 ${suffix}` })).browser,
      ).toBeNull();
    }
    for (const brands of [
      '"Whale";v="1", "MIUI Browser";v="1"',
      '"MIUI Browser";v="1", "Whale";v="1"',
    ]) {
      expect(parseBrowser(new Headers({ 'sec-ch-ua': brands })).browser).toBeNull();
    }
    expect(
      parseBrowser(new Headers({ 'user-agent': 'Chrome/128.0 MQQBrowser/12.0 QQBrowser/12.0' }))
        .browser,
    ).toBe('QQBrowser');
    expect(
      parseBrowser(
        new Headers({ 'user-agent': 'Chrome/128.0 MiuiBrowser/12.0 MicroMessenger/8.0' }),
      ).browser,
    ).toBe('WeChat');
    expect(
      parseBrowser(
        new Headers({
          'user-agent': 'Chrome/128.0 DuckDuckGo/1.0',
          'sec-ch-ua': '"Chromium";v="128", "Google Chrome";v="128"',
        }),
      ).browser,
    ).toBe('DuckDuckGo');
  });

  test('a desktop-mode iPad is indistinguishable from the macOS UA it advertises', () => {
    const headers = new Headers({
      'user-agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
    });
    expect(parseBrowser(headers)).toEqual({ browser: 'Safari', platform: 'macOS' });
  });

  test('app identity survives reordered compatibility products and generic Chromium hints', () => {
    for (const ua of [
      'Mozilla/5.0 Chrome/128.0 Safari/537.36 Electron/32.0',
      'Mozilla/5.0 Electron/32.0 Chrome/128.0 Safari/537.36',
    ]) {
      expect(
        parseBrowser(
          new Headers({
            'user-agent': ua,
            'sec-ch-ua': '"Chromium";v="128", "Google Chrome";v="128"',
          }),
        ).browser,
      ).toBe('Electron');
    }
  });

  test('binary parameters must be decodable and invalid suffixes reject the entire field', () => {
    for (const bytes of [':A:', ':=:', ':AA=:', ':AAAA=:']) {
      expect(
        parseBrowser(new Headers({ 'sec-ch-ua': `"Google Chrome";v="128";x=${bytes}` })).browser,
      ).toBeNull();
    }
  });

  test('OS-only parsing does not read browser hints, UA, or unrelated request headers when the platform is present', () => {
    class PlatformHeaders extends Headers {
      override get(name: string): string | null {
        if (name !== 'sec-ch-ua-platform') throw new Error(`unexpected header read: ${name}`);
        return '"Linux"';
      }
    }
    expect(parsePlatform(new PlatformHeaders())).toBe('Linux');
  });
});
