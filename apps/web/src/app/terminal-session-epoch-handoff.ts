export interface SessionEpochWorker {
  notifySessionEpoch(displayRingFenceToken: number | null): void;
}

export interface TerminalSessionEpochHandoff<TSession, TWorker extends SessionEpochWorker> {
  /**
   * True when the token fences a display lineage the worker has not held. A
   * transport back at ready on the lineage already fenced (a carrier rebind)
   * brings no new display, so the worker reports no new first display for it.
   */
  onTransportConnected(session: TSession, displayRingFenceToken: number): boolean;
  onWorkerReady(worker: TWorker): void;
  onWorkerClosed(): void;
  reset(): void;
}

/**
 * Level-triggered handoff between independently starting transport and
 * terminal workers.
 *
 * No edge is timing-sensitive: if transport authenticates first, readiness of
 * the eventual terminal worker replays resize-before-epoch. If the terminal
 * worker is already ready, the transport event publishes the epoch directly.
 * The latest ring-fence token remains replayable across worker replacement so
 * a worker that died before handling its epoch cannot strand the consumer.
 */
export function createTerminalSessionEpochHandoff<
  TSession,
  TWorker extends SessionEpochWorker,
>(options: {
  readonly getSession: () => TSession | null;
  readonly getWorker: () => TWorker | null;
  readonly sendCurrentResize: (session: TSession) => void;
}): TerminalSessionEpochHandoff<TSession, TWorker> {
  let epochPending = false;
  let latestDisplayRingFenceToken: number | null = null;

  return {
    onTransportConnected(session, displayRingFenceToken): boolean {
      const newLineage = displayRingFenceToken !== latestDisplayRingFenceToken;
      options.sendCurrentResize(session);
      latestDisplayRingFenceToken = displayRingFenceToken;
      const worker = options.getWorker();
      if (worker === null) {
        epochPending = true;
        return newLineage;
      }
      worker.notifySessionEpoch(displayRingFenceToken);
      epochPending = false;
      return newLineage;
    },

    onWorkerReady(worker): void {
      if (!epochPending) return;
      const session = options.getSession();
      if (session !== null) options.sendCurrentResize(session);
      worker.notifySessionEpoch(latestDisplayRingFenceToken);
      epochPending = false;
    },

    onWorkerClosed(): void {
      // The previous worker may have died after main delivered the owner
      // token but before it advanced the SAB. Replaying the real target lets
      // a replacement reach the exact transport fence.
      if (options.getSession() !== null) epochPending = true;
    },

    reset(): void {
      epochPending = false;
      latestDisplayRingFenceToken = null;
    },
  };
}
