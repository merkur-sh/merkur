import type { parseBrowser } from './index';

// Independent request examples for Merkur's contract, not an upstream parser corpus.
// Product spellings: Chrome/Edge vendor UA documentation and Mozilla's UA reference.
// Client Hints: WICG UA-CH and RFC 8941. Versions are illustrative, never parsed.
const CHROME_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const CHROME_WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const CHROME_ANDROID =
  'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36';
const SAFARI_IOS =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

export const USER_AGENT_CASES: readonly {
  readonly name: string;
  readonly headers: Record<string, string>;
  readonly browser: ReturnType<typeof parseBrowser>['browser'];
  readonly platform: ReturnType<typeof parseBrowser>['platform'];
}[] = [
  {
    name: 'chrome-mac',
    headers: { 'user-agent': CHROME_MAC },
    browser: 'Chrome',
    platform: 'macOS',
  },
  {
    name: 'edge-windows',
    headers: { 'user-agent': `${CHROME_WINDOWS} Edg/128.0.0.0` },
    browser: 'Edge',
    platform: 'Windows',
  },
  {
    name: 'firefox-linux',
    headers: {
      'user-agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:129.0) Gecko/20100101 Firefox/129.0',
    },
    browser: 'Firefox',
    platform: 'Linux',
  },
  {
    name: 'safari-ios',
    headers: { 'user-agent': SAFARI_IOS },
    browser: 'Mobile Safari',
    platform: 'iOS',
  },
  {
    name: 'chrome-android',
    headers: { 'user-agent': CHROME_ANDROID },
    browser: 'Mobile Chrome',
    platform: 'Android',
  },
  {
    name: 'edge-android',
    headers: { 'user-agent': `${CHROME_ANDROID} EdgA/128.0.0.0` },
    browser: 'Edge',
    platform: 'Android',
  },
  {
    name: 'edge-ios',
    headers: { 'user-agent': `${SAFARI_IOS} EdgiOS/128.0.0.0` },
    browser: 'Edge',
    platform: 'iOS',
  },
  {
    name: 'firefox-ios',
    headers: { 'user-agent': `${SAFARI_IOS} FxiOS/129.0` },
    browser: 'Mobile Firefox',
    platform: 'iOS',
  },
  {
    name: 'chrome-ios',
    headers: { 'user-agent': `${SAFARI_IOS} CriOS/128.0.0.0` },
    browser: 'Mobile Chrome',
    platform: 'iOS',
  },
  {
    name: 'safari-mac',
    headers: {
      'user-agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
    },
    browser: 'Safari',
    platform: 'macOS',
  },
  {
    name: 'chrome-os',
    headers: {
      'user-agent':
        'Mozilla/5.0 (X11; CrOS x86_64 15917.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    },
    browser: 'Chrome',
    platform: 'Chrome OS',
  },
  {
    name: 'samsung-android',
    headers: { 'user-agent': `${CHROME_ANDROID} SamsungBrowser/26.0` },
    browser: 'Samsung Internet',
    platform: 'Android',
  },
  {
    name: 'opera-windows',
    headers: { 'user-agent': `${CHROME_WINDOWS} OPR/113.0.0.0` },
    browser: 'Opera',
    platform: 'Windows',
  },
  {
    name: 'vivaldi-mac',
    headers: { 'user-agent': `${CHROME_MAC} Vivaldi/6.9.0.0` },
    browser: 'Vivaldi',
    platform: 'macOS',
  },
  {
    name: 'edge-hints-only',
    headers: {
      'sec-ch-ua': '"Chromium";v="128", "Not;A=Brand";v="24", "Microsoft Edge";v="128"',
      'sec-ch-ua-platform': '"Windows"',
    },
    browser: 'Edge',
    platform: 'Windows',
  },
  {
    name: 'brave-hints',
    headers: {
      'user-agent': CHROME_MAC,
      'sec-ch-ua': '"Brave";v="128", "Chromium";v="128", "Not A Brand";v="99"',
      'sec-ch-ua-platform': '"macOS"',
    },
    browser: 'Brave',
    platform: 'macOS',
  },
  {
    name: 'conflicting-hints',
    headers: {
      'user-agent': CHROME_MAC,
      'sec-ch-ua': '"Chromium";v="128", "Microsoft Edge";v="128"',
      'sec-ch-ua-platform': '"Android"',
    },
    browser: 'Edge',
    platform: 'Android',
  },
  {
    name: 'curl',
    headers: { 'user-agent': 'curl/8.6.0' },
    browser: null,
    platform: null,
  },
  { name: 'empty', headers: {}, browser: null, platform: null },
  {
    name: 'chrome-hints',
    headers: {
      'user-agent': CHROME_MAC,
      'sec-ch-ua': '"Chromium";v="128", "Google Chrome";v="128", "Not;A=Brand";v="24"',
      'sec-ch-ua-platform': '"macOS"',
    },
    browser: 'Chrome',
    platform: 'macOS',
  },
  {
    name: 'generic-hints-preserve-opera',
    headers: {
      'user-agent': `${CHROME_WINDOWS} OPR/113.0.0.0`,
      'sec-ch-ua': '"Chromium";v="128", "Google Chrome";v="128"',
      'sec-ch-ua-platform': '"Windows"',
    },
    browser: 'Opera',
    platform: 'Windows',
  },
  {
    name: 'android-webview',
    headers: {
      'user-agent':
        'Mozilla/5.0 (Linux; Android 10; K; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/128.0.0.0 Mobile Safari/537.36',
    },
    browser: 'Chrome WebView',
    platform: 'Android',
  },
  {
    name: 'electron',
    headers: {
      'user-agent': CHROME_WINDOWS.replace('Safari/537.36', 'Electron/32.0.0 Safari/537.36'),
    },
    browser: 'Electron',
    platform: 'Windows',
  },
  {
    name: 'headless',
    headers: { 'user-agent': CHROME_MAC.replace('Chrome/', 'HeadlessChrome/') },
    browser: 'Chrome Headless',
    platform: 'macOS',
  },
  {
    name: 'instagram-webview',
    headers: { 'user-agent': `${CHROME_ANDROID} Instagram/340.0.0` },
    browser: 'Instagram',
    platform: 'Android',
  },
  {
    name: 'facebook-ios',
    headers: { 'user-agent': `${SAFARI_IOS} [FBAN/FBIOS;FBAV/480.0.0;]` },
    browser: 'Facebook',
    platform: 'iOS',
  },
  {
    name: 'webview-hints',
    headers: {
      'sec-ch-ua':
        '"Microsoft Edge WebView2";v="128", "Microsoft Edge";v="128", "Chromium";v="128"',
      'sec-ch-ua-platform': '"Windows"',
    },
    browser: 'Edge WebView2',
    platform: 'Windows',
  },
];
