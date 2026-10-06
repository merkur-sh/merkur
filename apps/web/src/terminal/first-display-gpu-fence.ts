/**
 * One-shot session-epoch readiness tracker.
 *
 * CPU application nominates the first authoritative frame. Readiness moves
 * only with a real submitted GPU fence; abandoning a submission returns the
 * candidate to pending so a replacement render can own it.
 */
export interface FirstDisplayGpuFenceTracker<TFrame> {
  /**
   * True until this epoch's first applied frame has been observed. The caller
   * builds the frame identity only behind this guard, so the literal is
   * minted once per authenticated epoch rather than once per applied datagram.
   */
  awaitingFirstApplied(): boolean;
  observeApplied(frame: TFrame): boolean;
  noteSubmitted(frameHasFence: boolean): void;
  noteCompleted(frameHadFence: boolean): TFrame | null;
  abandonSubmitted(): void;
  /**
   * Forget an applied candidate that is still offscreen. A resync may discard
   * that authoritative lineage before it ever reaches a renderer submission;
   * the replacement snapshot must then become the epoch's first visible frame.
   */
  discardPendingApplied(): boolean;
  resetEpoch(): void;
  hasInFlight(): boolean;
  isComplete(): boolean;
}

export function createFirstDisplayGpuFenceTracker<TFrame>(): FirstDisplayGpuFenceTracker<TFrame> {
  let appliedObserved = false;
  let completed = false;
  let pending: TFrame | null = null;
  let inFlight: TFrame | null = null;

  return {
    awaitingFirstApplied(): boolean {
      return !appliedObserved && !completed;
    },

    observeApplied(frame): boolean {
      if (appliedObserved || completed) return false;
      appliedObserved = true;
      pending = frame;
      return true;
    },

    noteSubmitted(frameHasFence): void {
      if (!frameHasFence || pending === null || inFlight !== null || completed) return;
      inFlight = pending;
      pending = null;
    },

    noteCompleted(frameHadFence): TFrame | null {
      if (!frameHadFence || inFlight === null || completed) return null;
      const frame = inFlight;
      inFlight = null;
      completed = true;
      return frame;
    },

    abandonSubmitted(): void {
      if (inFlight === null || completed) return;
      pending ??= inFlight;
      inFlight = null;
    },

    discardPendingApplied(): boolean {
      if (pending === null || inFlight !== null || completed) return false;
      pending = null;
      appliedObserved = false;
      return true;
    },

    resetEpoch(): void {
      appliedObserved = false;
      completed = false;
      pending = null;
      inFlight = null;
    },

    hasInFlight(): boolean {
      return inFlight !== null;
    },

    isComplete(): boolean {
      return completed;
    },
  };
}
