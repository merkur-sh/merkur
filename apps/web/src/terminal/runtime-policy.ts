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

export interface TerminalCanvasPresentation {
  readonly format: TerminalCanvasFormat;
  /** A submitted frame reaches the screen only when completions are delivered. */
  readonly presentAwaitsCompletion: boolean;
}

// Gecko's `bgra8unorm` shared-texture swap chain shows the terminal an older
// frame when another texture-backed element on the page updates (a 2D canvas on
// either thread, SVG) while it draws (Gecko 158); any other format
// takes its readback presenter, which presents in order once the GPU process
// next maintains the device, the same maintenance that delivers completions.
const GECKO_CANVAS_PRESENTATION: TerminalCanvasPresentation = {
  format: 'rgba8unorm',
  presentAwaitsCompletion: true,
};

// WebKit shows an `rgba8unorm` canvas 1.5–3.6 ms sooner than the `bgra8unorm`
// it reports as preferred, and completes its submission 2 ms sooner.
const WEBKIT_CANVAS_PRESENTATION: TerminalCanvasPresentation = {
  format: 'rgba8unorm',
  presentAwaitsCompletion: false,
};

/**
 * How the engine presents the terminal canvas. Chromium's preferred format is
 * the one it presents without a copy. Gecko names `rv:…) Gecko/<date>`, which
 * no other engine's `like Gecko` matches; every Chromium names `Chrome/` or
 * `Chromium/` (`HeadlessChrome/` included); every iOS browser is WebKit.
 */
export function terminalCanvasPresentation(
  userAgent: string,
  preferred: TerminalCanvasFormat,
): TerminalCanvasPresentation {
  if (/\) Gecko\/\d/.test(userAgent)) return GECKO_CANVAS_PRESENTATION;
  if (/AppleWebKit\//.test(userAgent) && !/Chrom(?:e|ium)\//.test(userAgent))
    return WEBKIT_CANVAS_PRESENTATION;
  return { format: preferred, presentAwaitsCompletion: false };
}

export function terminalRuntimePolicyForUserAgent(userAgent: string): TerminalRuntimePolicy {
  const isAppleMobileWebKit =
    /AppleWebKit\//.test(userAgent) &&
    /Mobile\//.test(userAgent) &&
    !/\bAndroid\b/i.test(userAgent);

  return isAppleMobileWebKit ? APPLE_MOBILE_WEBKIT_RUNTIME_POLICY : DEFAULT_TERMINAL_RUNTIME_POLICY;
}
