import {
  createLinkQualityAggregator,
  type LinkQualityAggregator,
  type LinkQualityReport,
  type LinkQualitySample,
} from './link-quality-aggregator';

/**
 * Streams the browser's link-quality samples for as long as reporting is on.
 *
 * Everything it consumes is already produced: the transport worker's ~2s
 * heartbeat projection and the terminal worker's paint summary. It adds no
 * observation to any hot path — the aggregator runs on the main thread inside a
 * callback that already recomputes the autotuner and touches Solid signals at
 * the same cadence.
 *
 * # Reporting contract
 *
 * - **There is no reporting window and no timer.** Every heartbeat projection
 *   is posted as it arrives, so the server sees the session continuously rather
 *   than as a minute-resolution summary. The cadence is therefore exactly the
 *   transport heartbeat's, and a session that produces no samples posts nothing.
 * - Never more than one request in flight. A sample observed while a send is
 *   outstanding accumulates into the aggregator instead of queueing a second
 *   request, so a slow network coarsens the resolution rather than piling up
 *   requests — the backpressure is the whole reason the aggregator survives the
 *   move away from a fixed window.
 * - A hidden page and a stopped reporter each flush whatever is accumulated.
 * - A failed send is dropped, never retried. Observability must not consume the
 *   budget of the thing it observes, and a retried report double-counts.
 *
 * # Privacy
 *
 * The posted body is bounded numbers only — see the schema comment on
 * `ApiModels.BrowserLinkReportBody`. Nothing here carries an identifier; the
 * server already knows the user from the authenticated cookie.
 *
 * Paint timing is deliberately absent here. It now travels on the profiling
 * ring as raw `input_queued`/`frame_complete` events, from which the analyzer
 * derives the same figure with full sub-term attribution instead of the single
 * optimistic floor this body used to carry.
 */
export interface TelemetryReporter {
  /**
   * Fold one heartbeat projection in and post it.
   *
   * This is the only thing that drives a send: the reporter has no clock of its
   * own, so its output cadence is the input's.
   */
  observeLink(sample: LinkQualitySample): void;
  /** Flush whatever is accumulated and release the listener. */
  stop(): void;
  /**
   * Release the listener without sending what is accumulated.
   *
   * Used when the user turns reporting off. `stop` would post one final report
   * after the moment consent was withdrawn, which is the wrong side of that
   * boundary no matter how little is accumulated.
   */
  discard(): void;
}

export type BrowserLinkReportBody = LinkQualityReport;

export type BrowserLinkReportSender = (body: BrowserLinkReportBody) => Promise<void>;

export interface TelemetryReporterOptions {
  readonly send: BrowserLinkReportSender;
  readonly now?: () => number;
}

export function createTelemetryReporter({
  send,
  now = () => Date.now(),
}: TelemetryReporterOptions): TelemetryReporter {
  const aggregator: LinkQualityAggregator = createLinkQualityAggregator(now());
  let sending = false;
  let stopped = false;

  function flush(): void {
    if (stopped || sending) return;
    const report = aggregator.drain(now());
    if (report === null) return;

    sending = true;
    void send(report)
      .catch(() => {
        // Deliberately swallowed. A dropped telemetry window is a non-event; a
        // rejected promise escaping a timer callback is not.
      })
      .finally(() => {
        sending = false;
      });
  }

  // A hidden page stops receiving heartbeat projections, so nothing would drive
  // the last flush. `visibilitychange` rather than `unload`: the latter is
  // unreliable on mobile and is not fired for a backgrounded tab later discarded.
  const onVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') flush();
  };
  document.addEventListener('visibilitychange', onVisibilityChange);

  function release(): void {
    stopped = true;
    document.removeEventListener('visibilitychange', onVisibilityChange);
  }

  return {
    observeLink(sample: LinkQualitySample): void {
      if (stopped) return;
      aggregator.observe(sample);
      // Post it now. `flush` is a no-op while a send is outstanding, which is
      // what keeps one request in flight without dropping the sample.
      flush();
    },

    stop(): void {
      if (stopped) return;
      flush();
      release();
    },

    discard(): void {
      if (stopped) return;
      release();
    },
  };
}
