import { describe, expect, test } from 'bun:test';
import {
  type TerminalRuntimePolicy,
  terminalCanvasPresentation,
  terminalRuntimePolicyForUserAgent,
} from './runtime-policy';

const APPLE_MOBILE_POLICY: TerminalRuntimePolicy = {
  displayRingWakeMode: 'task',
};

const DEFAULT_POLICY: TerminalRuntimePolicy = {
  displayRingWakeMode: 'native',
};

describe('terminalRuntimePolicyForUserAgent', () => {
  test('uses the Apple mobile policy for the observed iPhone WebKit UA', () => {
    const userAgent =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 ' +
      '(KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1';

    expect(terminalRuntimePolicyForUserAgent(userAgent)).toEqual(APPLE_MOBILE_POLICY);
  });

  test('uses the Apple mobile policy for iPad WebKit', () => {
    const userAgent =
      'Mozilla/5.0 (iPad; CPU OS 18_5 like Mac OS X) AppleWebKit/605.1.15 ' +
      '(KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';

    expect(terminalRuntimePolicyForUserAgent(userAgent)).toEqual(APPLE_MOBILE_POLICY);
  });

  test('uses the Apple mobile policy for iPadOS desktop-style WebKit UA', () => {
    const userAgent =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 ' +
      '(KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';

    expect(terminalRuntimePolicyForUserAgent(userAgent)).toEqual(APPLE_MOBILE_POLICY);
  });

  test('keeps the default policy for desktop Safari', () => {
    const userAgent =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 ' +
      '(KHTML, like Gecko) Version/18.5 Safari/605.1.15';

    expect(terminalRuntimePolicyForUserAgent(userAgent)).toEqual(DEFAULT_POLICY);
  });

  test('keeps the default policy for Chrome on Android', () => {
    const userAgent =
      'Mozilla/5.0 (Linux; Android 15; Pixel 9 Pro) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36';

    expect(terminalRuntimePolicyForUserAgent(userAgent)).toEqual(DEFAULT_POLICY);
  });

  test('keeps the default policy for an empty UA', () => {
    expect(terminalRuntimePolicyForUserAgent('')).toEqual(DEFAULT_POLICY);
  });

  test('platform only decides ingress wake behavior, never rendering or font loading', () => {
    // A `loadBackgroundFontStyles: false` here used to skip arming the style
    // upgrade entirely on Apple mobile, so `setFontBytes` was never called and
    // bold text rendered as regular for the whole session on every iPhone and
    // iPad. Font staging is now keyed on the installed tier, not the platform.
    const appleMobile = terminalRuntimePolicyForUserAgent(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 ' +
        '(KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1',
    );

    expect(Object.keys(appleMobile)).toEqual(['displayRingWakeMode']);
    expect(Object.keys(terminalRuntimePolicyForUserAgent(''))).toEqual(['displayRingWakeMode']);
  });
});

describe('terminalCanvasPresentation', () => {
  // The user agents of the measured browsers, then the forms they stand for.
  const zen =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:158.0) Gecko/20100101 Firefox/158.0';
  const chrome =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/158.0.0.0 Safari/537.36';
  const safari =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) ' +
    'Version/26.5.2 Safari/605.1.15';
  const iphone =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 ' +
    '(KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1';
  const iosChrome =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 ' +
    '(KHTML, like Gecko) CriOS/140.0.0.0 Mobile/15E148 Safari/604.1';
  const androidChrome =
    'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/140.0.0.0 Mobile Safari/537.36';
  const headlessChrome =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'HeadlessChrome/140.0.0.0 Safari/537.36';

  const linuxFirefox = 'Mozilla/5.0 (X11; Linux x86_64; rv:158.0) Gecko/20100101 Firefox/158.0';
  const androidFirefox = 'Mozilla/5.0 (Android 15; Mobile; rv:158.0) Gecko/158.0 Firefox/158.0';

  test('WebKit, on every Apple platform and behind every iOS browser, takes rgba8unorm', () => {
    for (const userAgent of [safari, iphone, iosChrome])
      expect(terminalCanvasPresentation(userAgent, 'bgra8unorm')).toEqual({
        format: 'rgba8unorm',
        presentAwaitsCompletion: false,
      });
  });

  test('Gecko takes rgba8unorm, which it presents when its completions are delivered', () => {
    // Its bgra8unorm shared-texture swap chain shows older frames beside other canvas updates.
    for (const userAgent of [zen, linuxFirefox, androidFirefox])
      expect(terminalCanvasPresentation(userAgent, 'bgra8unorm')).toEqual({
        format: 'rgba8unorm',
        presentAwaitsCompletion: true,
      });
  });

  test('Chromium takes the format it prefers', () => {
    for (const userAgent of [chrome, headlessChrome])
      expect(terminalCanvasPresentation(userAgent, 'bgra8unorm')).toEqual({
        format: 'bgra8unorm',
        presentAwaitsCompletion: false,
      });
    expect(terminalCanvasPresentation(androidChrome, 'rgba8unorm').format).toBe('rgba8unorm');
  });
});
