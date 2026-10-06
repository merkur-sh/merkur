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

export function terminalRuntimePolicyForUserAgent(userAgent: string): TerminalRuntimePolicy {
  const isAppleMobileWebKit =
    /AppleWebKit\//.test(userAgent) &&
    /Mobile\//.test(userAgent) &&
    !/\bAndroid\b/i.test(userAgent);

  return isAppleMobileWebKit ? APPLE_MOBILE_WEBKIT_RUNTIME_POLICY : DEFAULT_TERMINAL_RUNTIME_POLICY;
}
