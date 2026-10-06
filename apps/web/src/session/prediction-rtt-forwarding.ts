export interface PredictionRttSink {
  resetSrtt(): void;
  updateRtt(rttMs: number): void;
}

export interface PredictionRttForwarder {
  /**
   * Attach the current terminal worker. A newly attached worker receives the
   * latest sample from the current path, if one arrived while it was loading.
   */
  setSink(sink: PredictionRttSink | null): void;
  /** Observe one transport metric update. */
  observe(rttMs: number | null, pathChanged: boolean): void;
  /** Forget every sample, for example when leaving the current session. */
  clear(): void;
}

/**
 * Keep predictive echo aligned with the currently labelled transport path.
 *
 * A path transition invalidates the old EWMA, but the sample that revealed
 * that transition already belongs to the new path. Reset first, then admit
 * that sample; reversing the order discards it and leaves prediction blind
 * until the next heartbeat interval.
 */
export function forwardPredictionRttSample(
  sink: PredictionRttSink | null,
  rttMs: number | null,
  pathChanged: boolean,
): void {
  if (sink === null) return;
  if (pathChanged) sink.resetSrtt();
  if (rttMs !== null) sink.updateRtt(rttMs);
}

/**
 * Bridges the independent transport and terminal-worker lifecycles.
 *
 * The transport starts its heartbeat as soon as E2E is established, while the
 * terminal worker may still be loading WASM and fonts. Retaining exactly one
 * validated sample prevents that first heartbeat from being lost without
 * building an unbounded queue or replaying samples from an obsolete path.
 */
export function createPredictionRttForwarder(): PredictionRttForwarder {
  let sink: PredictionRttSink | null = null;
  let latestRttMs: number | null = null;

  return {
    setSink(nextSink) {
      if (nextSink === sink) return;
      sink = nextSink;
      if (sink === null) return;

      // A replacement worker may have survived a prior session. Establish a
      // clean lineage before replaying the current path's retained sample.
      sink.resetSrtt();
      if (latestRttMs !== null) sink.updateRtt(latestRttMs);
    },
    observe(rttMs, pathChanged) {
      if (pathChanged) latestRttMs = null;

      const validRttMs = rttMs !== null && Number.isFinite(rttMs) && rttMs >= 0 ? rttMs : null;
      forwardPredictionRttSample(sink, validRttMs, pathChanged);
      if (validRttMs !== null) latestRttMs = validRttMs;
    },
    clear() {
      latestRttMs = null;
      sink?.resetSrtt();
    },
  };
}
