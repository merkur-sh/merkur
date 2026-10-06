export type WakeLockAcquisitionPhase = 'idle' | 'acquiring' | 'held' | 'denied' | 'disposed';

export type WakeLockDenialDisposition = 'latched' | 'lifecycle-reset' | 'ignored';

export interface WakeLockAcquisitionGate {
  readonly phase: WakeLockAcquisitionPhase;
  beginAcquire(): boolean;
  acquired(): boolean;
  denied(): WakeLockDenialDisposition;
  visibilityChanged(visible: boolean): boolean;
  released(): boolean;
  dispose(): void;
}

/**
 * Owns screen-wake-lock acquisition eligibility.
 *
 * A denial is latched: ordinary calls to `beginAcquire` cannot turn user input
 * into a permission-request storm. Only a real hidden -> visible lifecycle
 * edge, or release of a lock that was actually held, reopens acquisition.
 */
export function createWakeLockAcquisitionGate(initiallyVisible: boolean): WakeLockAcquisitionGate {
  let phase: WakeLockAcquisitionPhase = 'idle';
  let visible = initiallyVisible;
  // A visibility resume can happen while the browser's non-cancellable
  // request promise is still pending. Preserve that edge so a later denial
  // cannot consume the only lifecycle reset.
  let lifecycleResetDuringAcquire = false;

  return {
    get phase(): WakeLockAcquisitionPhase {
      return phase;
    },

    beginAcquire(): boolean {
      if (!visible || phase !== 'idle') return false;
      phase = 'acquiring';
      lifecycleResetDuringAcquire = false;
      return true;
    },

    acquired(): boolean {
      if (phase !== 'acquiring') return false;
      phase = 'held';
      lifecycleResetDuringAcquire = false;
      return true;
    },

    denied(): WakeLockDenialDisposition {
      if (phase !== 'acquiring') return 'ignored';
      if (visible && lifecycleResetDuringAcquire) {
        phase = 'idle';
        lifecycleResetDuringAcquire = false;
        return 'lifecycle-reset';
      }
      phase = 'denied';
      lifecycleResetDuringAcquire = false;
      return 'latched';
    },

    visibilityChanged(nextVisible: boolean): boolean {
      const resumed = !visible && nextVisible;
      visible = nextVisible;
      if (!resumed || phase === 'disposed') return false;
      if (phase === 'acquiring') {
        lifecycleResetDuringAcquire = true;
        return false;
      }
      if (phase === 'denied') phase = 'idle';
      return phase === 'idle';
    },

    released(): boolean {
      if (phase !== 'held') return false;
      phase = 'idle';
      lifecycleResetDuringAcquire = false;
      return visible;
    },

    dispose(): void {
      phase = 'disposed';
      lifecycleResetDuringAcquire = false;
    },
  };
}
