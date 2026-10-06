import { WAKE_CLOCK_JUMP_MS, WAKE_TICK_MS } from '@merkur/config/reconnect-policy';

export interface WakeDetector {
  destroy(): void;
}

interface WakeDetectorOptions {
  readonly tickMs?: number;
  readonly jumpThresholdMs?: number;
  /** Injectable for tests; defaults to the document visibility state. */
  readonly isHidden?: () => boolean;
}

/**
 * Detects system sleep / page suspension via clock jumps: a steady interval
 * timer whose tick arrives far later than scheduled means the machine was
 * suspended, even when no browser event fires (lid close/open with the tab
 * staying visible). Hidden documents are skipped — background-timer
 * throttling makes late ticks routine there, and the hidden→visible wake is
 * already covered by the visibilitychange path.
 */
export function createWakeDetector(
  onWake: () => void,
  options?: WakeDetectorOptions,
): WakeDetector {
  const tickMs = options?.tickMs ?? WAKE_TICK_MS;
  const jumpThresholdMs = options?.jumpThresholdMs ?? WAKE_CLOCK_JUMP_MS;
  const isHidden = options?.isHidden ?? documentIsHidden;

  let lastTickMs = Date.now();
  const interval = setInterval(() => {
    const now = Date.now();
    const jumped = now - lastTickMs >= jumpThresholdMs;
    lastTickMs = now;
    if (jumped && !isHidden()) {
      onWake();
    }
  }, tickMs);

  return {
    destroy(): void {
      clearInterval(interval);
    },
  };
}

function documentIsHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}
