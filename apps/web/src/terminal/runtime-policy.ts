export type TerminalDisplayRingWakeMode = 'native' | 'task';

export interface TerminalRuntimePolicy {
  readonly displayRingWakeMode: TerminalDisplayRingWakeMode;
}

const DEFAULT_TERMINAL_RUNTIME_POLICY: TerminalRuntimePolicy = {
  displayRingWakeMode: 'native',
};

const APPLE_MOBILE_WEBKIT_RUNTIME_POLICY: TerminalRuntimePolicy = {
  displayRingWakeMode: 'task',
};

export type TerminalCanvasFormat = 'bgra8unorm' | 'rgba8unorm';

/**
 * The canvas format the engine presents soonest, measured on screen: WebKit
 * shows an `rgba8unorm` canvas 1.5–3.6 ms sooner than the `bgra8unorm` it
 * reports as preferred, and completes its submission 2 ms sooner. Every other
 * engine's preferred format is the one it presents without a copy; Gecko's
 * shared-texture swap chain takes only `bgra8unorm`, and any other format waits
 * for its GPU process to poll the device. Every Chromium names `Chrome/` or
 * `Chromium/` (`HeadlessChrome/` included); every iOS browser is WebKit.
 */
export function terminalCanvasFormat(
  userAgent: string,
  preferred: TerminalCanvasFormat,
): TerminalCanvasFormat {
  const isWebKit = /AppleWebKit\//.test(userAgent) && !/Chrom(?:e|ium)\//.test(userAgent);
  return isWebKit ? 'rgba8unorm' : preferred;
}

export function terminalRuntimePolicyForUserAgent(userAgent: string): TerminalRuntimePolicy {
  const isAppleMobileWebKit =
    /AppleWebKit\//.test(userAgent) &&
    /Mobile\//.test(userAgent) &&
    !/\bAndroid\b/i.test(userAgent);

  return isAppleMobileWebKit ? APPLE_MOBILE_WEBKIT_RUNTIME_POLICY : DEFAULT_TERMINAL_RUNTIME_POLICY;
}
