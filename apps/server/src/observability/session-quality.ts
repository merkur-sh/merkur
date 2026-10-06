/**
 * Apdex-shaped verdict for one browser reporting window.
 *
 * # Why this lives on the server
 *
 * Every input is already in the link report the browser posts. Classifying here
 * rather than in the browser means the thresholds can be retuned by a server
 * deploy instead of a daemon release plus a client refresh — and these
 * thresholds *will* be retuned, because they encode a judgement about what feels
 * bad rather than a measurement. It also keeps the wire contract unchanged and
 * puts the closed label set beyond the reach of a modified client.
 *
 * # Why per window rather than per session
 *
 * Each report normally covers one ~2s heartbeat. Backpressure can combine
 * several heartbeats into one report, and reporting is opt-in. The good fraction
 * is therefore report-weighted among reporting browsers, not a fraction of
 * user-minutes or sessions. Reports arrive during the session, so observation
 * does not depend on capturing a tab-close event.
 */

/** Closed set. These are metric label values and must never grow unbounded. */
export type SessionQualityVerdict = 'good' | 'degraded' | 'bad';

/**
 * Thresholds, in milliseconds, aligned to the browser's RTT bucket bounds.
 *
 * The aggregator reports a percentile as the upper bound of its containing
 * bucket (`LINK_RTT_BOUNDS_MS`), so a threshold that is not itself a bucket
 * bound would be indistinguishable from the next one up. 100, 150, 300 and 500
 * are all real bounds.
 *
 * `GOOD_INPUT_ACK_MS` is 100 because that is the long-standing threshold below
 * which an interaction reads as instantaneous; above it a keystroke echo is
 * perceptible. `DEGRADED_INPUT_ACK_MS` is 300 — still usable, clearly laggy.
 * The RTT bounds are the network-side companions, set higher because RTT
 * includes a round trip the echo does not always wait for.
 */
export const SESSION_QUALITY_THRESHOLDS = {
  GOOD_INPUT_ACK_MS: 100,
  DEGRADED_INPUT_ACK_MS: 300,
  GOOD_RTT_MS: 150,
  DEGRADED_RTT_MS: 500,
  /** Fraction of samples in the window that may be degraded and still count as tolerable. */
  DEGRADED_DEGRADED_RATIO: 0.5,
  /** Fraction of samples that may be reconnecting/closed and still count as tolerable. */
  DEGRADED_UNSTABLE_RATIO: 0.25,
} as const;

export interface SessionQualityInput {
  readonly sampleCount: number;
  readonly rttP95Ms: number;
  readonly inputAckP95Ms: number;
  readonly degradedSampleCount: number;
  readonly stateReconnecting: number;
  readonly stateClosed: number;
}

/**
 * Classify one window.
 *
 * A zero latency percentile means the window contained no measurement of that
 * kind — an idle window with no keystrokes reports `inputAckP95Ms: 0` — so zero
 * is treated as "no evidence" and never as "instant". Idle is not bad.
 */
export function classifySessionQuality(input: SessionQualityInput): SessionQualityVerdict {
  const {
    GOOD_INPUT_ACK_MS,
    DEGRADED_INPUT_ACK_MS,
    GOOD_RTT_MS,
    DEGRADED_RTT_MS,
    DEGRADED_DEGRADED_RATIO,
    DEGRADED_UNSTABLE_RATIO,
  } = SESSION_QUALITY_THRESHOLDS;

  // An empty window carries no evidence either way. The aggregator does not post
  // one, so this is a guard rather than a live path.
  if (input.sampleCount <= 0) return 'good';

  const unstable = input.stateReconnecting + input.stateClosed;
  const unstableRatio = unstable / input.sampleCount;
  const degradedRatio = input.degradedSampleCount / input.sampleCount;

  const ackBad = input.inputAckP95Ms > DEGRADED_INPUT_ACK_MS;
  const rttBad = input.rttP95Ms > DEGRADED_RTT_MS;
  if (ackBad || rttBad || degradedRatio > DEGRADED_DEGRADED_RATIO) return 'bad';
  if (unstableRatio > DEGRADED_UNSTABLE_RATIO) return 'bad';

  const ackGood = input.inputAckP95Ms <= GOOD_INPUT_ACK_MS;
  const rttGood = input.rttP95Ms <= GOOD_RTT_MS;
  if (!ackGood || !rttGood) return 'degraded';
  // Any display loss or any unstable sample at all disqualifies a window from
  // "good": both are things the user sees, not statistical noise.
  if (input.degradedSampleCount > 0 || unstable > 0) return 'degraded';

  return 'good';
}
