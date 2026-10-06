/**
 * Allocation-free accumulator for browser link-quality samples.
 *
 * The transport worker already projects `rttMs`, `networkRttMs`, `pathType`,
 * `degraded`, `linkState` and cumulative wire bytes to the main thread once per
 * ~2s heartbeat, on the channel its own protocol file documents as explicitly
 * non-hot-path. This folds that existing stream into whatever interval the
 * reporter drains at, so it can be reported without adding a single observation
 * to any frame or keystroke path.
 *
 * Reporting streams: the reporter drains on each projection, so the common case
 * is one sample per report and the percentiles below degenerate to that sample.
 * The accumulator still earns its place, because it is also the backpressure —
 * while a send is outstanding, further projections fold in here and the next
 * report covers all of them.
 *
 * # Cost
 *
 * All state is allocated once per session: three small `Int32Array`s and a
 * handful of numbers. `observe` is a few ALU operations plus a linear scan over
 * fourteen bucket bounds — linear beats binary search at this size and, unlike
 * a sort-on-read design, allocates nothing.
 *
 * # Discipline
 *
 * This module has **zero imports**, deliberately, so it can be reasoned about
 * as pure arithmetic and is safe to call from any realm. `scripts/check-latency-boundaries.ts`
 * enforces that it never acquires an Effect dependency.
 *
 * # Privacy
 *
 * Everything here is an aggregate of transport latency and byte counts over a
 * heartbeat interval. Never add per-keystroke timestamps or inter-keystroke
 * deltas: keystroke timing is a genuine side channel for inferring typed
 * content, whereas round-trip time is not. That line is about *what* is
 * carried, not how wide the interval is — a count and percentiles never
 * reconstruct the gaps between keystrokes, however often they are sent.
 */

/**
 * Upper bounds, in milliseconds, for the RTT histogram. A value lands in the
 * first bucket it does not exceed; anything above the last bound lands in the
 * implicit overflow bucket.
 */
export const LINK_RTT_BOUNDS_MS: readonly number[] = [
  5, 10, 20, 30, 40, 50, 60, 80, 100, 150, 200, 300, 500, 1_000,
];

const BUCKET_COUNT = LINK_RTT_BOUNDS_MS.length + 1;

/** Index into the path counter array. Mirrors `LinkPath` without importing it. */
const PATH_DIRECT = 0;
const PATH_RELAY = 1;
const PATH_UNKNOWN = 2;

/** Index into the link-state counter array. Mirrors `LinkState`. */
const STATE_CONNECTING = 0;
const STATE_READY = 1;
const STATE_RECONNECTING = 2;
const STATE_DORMANT = 3;
const STATE_CLOSED = 4;

export interface LinkQualitySample {
  /** Heartbeat round-trip time, or `null` when the window had no measurement. */
  readonly rttMs: number | null;
  /** Keystroke-to-daemon-acknowledgement EWMA, or `null` before the first ack. */
  readonly inputAckRttMs: number | null;
  readonly path: 'direct' | 'relay' | 'unknown';
  readonly linkState:
    | 'connecting'
    | 'ready'
    | 'reconnecting'
    | 'dormant'
    | 'closed'
    | 'relay-paused'
    | 'relay-stopped';
  readonly degraded: boolean;
  /** Cumulative wire bytes for the session, not a delta. */
  readonly txBytes: number;
  readonly rxBytes: number;
}

export interface LinkQualityReport {
  readonly windowMs: number;
  readonly sampleCount: number;
  readonly rttP50Ms: number;
  readonly rttP95Ms: number;
  readonly rttMaxMs: number;
  readonly inputAckP50Ms: number;
  readonly inputAckP95Ms: number;
  readonly degradedSampleCount: number;
  readonly txBytes: number;
  readonly rxBytes: number;
  readonly pathDirect: number;
  readonly pathRelay: number;
  readonly pathUnknown: number;
  readonly stateConnecting: number;
  readonly stateReady: number;
  readonly stateReconnecting: number;
  readonly stateDormant: number;
  readonly stateClosed: number;
}

export interface LinkQualityAggregator {
  observe(sample: LinkQualitySample): void;
  /**
   * Summarise and reset. Returns `null` for an empty window so an idle session
   * posts nothing at all rather than a report full of zeroes.
   */
  drain(atMs: number): LinkQualityReport | null;
}

export function createLinkQualityAggregator(startedAtMs: number): LinkQualityAggregator {
  const rttBuckets = new Int32Array(BUCKET_COUNT);
  const inputAckBuckets = new Int32Array(BUCKET_COUNT);
  const pathCounts = new Int32Array(3);
  const stateCounts = new Int32Array(5);

  let windowStartedAtMs = startedAtMs;
  let sampleCount = 0;
  let rttSampleCount = 0;
  let inputAckSampleCount = 0;
  let rttMaxMs = 0;
  let degradedSampleCount = 0;
  let txBytes = 0;
  let rxBytes = 0;
  let lastTxBytes = -1;
  let lastRxBytes = -1;

  function reset(atMs: number): void {
    rttBuckets.fill(0);
    inputAckBuckets.fill(0);
    pathCounts.fill(0);
    stateCounts.fill(0);
    windowStartedAtMs = atMs;
    sampleCount = 0;
    rttSampleCount = 0;
    inputAckSampleCount = 0;
    rttMaxMs = 0;
    degradedSampleCount = 0;
    // Keep the cumulative baseline across reports. With one sample per
    // heartbeat, resetting it would report zero bytes forever.
    txBytes = 0;
    rxBytes = 0;
  }

  return {
    observe(sample: LinkQualitySample): void {
      sampleCount += 1;

      if (sample.rttMs !== null && Number.isFinite(sample.rttMs) && sample.rttMs >= 0) {
        bump(rttBuckets, bucketIndex(sample.rttMs));
        rttSampleCount += 1;
        if (sample.rttMs > rttMaxMs) rttMaxMs = sample.rttMs;
      }
      if (
        sample.inputAckRttMs !== null &&
        Number.isFinite(sample.inputAckRttMs) &&
        sample.inputAckRttMs >= 0
      ) {
        bump(inputAckBuckets, bucketIndex(sample.inputAckRttMs));
        inputAckSampleCount += 1;
      }

      bump(pathCounts, pathIndex(sample.path));
      bump(stateCounts, stateIndex(sample.linkState));
      if (sample.degraded) degradedSampleCount += 1;

      // Accumulate observed differences across heartbeat reports. A decrease
      // establishes a new baseline without erasing bytes already observed in
      // this report; the first observation also establishes a baseline.
      if (lastTxBytes >= 0 && sample.txBytes >= lastTxBytes)
        txBytes += sample.txBytes - lastTxBytes;
      if (lastRxBytes >= 0 && sample.rxBytes >= lastRxBytes)
        rxBytes += sample.rxBytes - lastRxBytes;
      lastTxBytes = sample.txBytes;
      lastRxBytes = sample.rxBytes;
    },

    drain(atMs: number): LinkQualityReport | null {
      if (sampleCount === 0) {
        reset(atMs);
        return null;
      }

      const report: LinkQualityReport = {
        windowMs: Math.max(0, Math.round(atMs - windowStartedAtMs)),
        sampleCount,
        rttP50Ms: percentileFromBuckets(rttBuckets, rttSampleCount, 0.5),
        rttP95Ms: percentileFromBuckets(rttBuckets, rttSampleCount, 0.95),
        rttMaxMs: Math.round(rttMaxMs),
        inputAckP50Ms: percentileFromBuckets(inputAckBuckets, inputAckSampleCount, 0.5),
        inputAckP95Ms: percentileFromBuckets(inputAckBuckets, inputAckSampleCount, 0.95),
        degradedSampleCount,
        txBytes,
        rxBytes,
        pathDirect: pathCounts[PATH_DIRECT] ?? 0,
        pathRelay: pathCounts[PATH_RELAY] ?? 0,
        pathUnknown: pathCounts[PATH_UNKNOWN] ?? 0,
        stateConnecting: stateCounts[STATE_CONNECTING] ?? 0,
        stateReady: stateCounts[STATE_READY] ?? 0,
        stateReconnecting: stateCounts[STATE_RECONNECTING] ?? 0,
        stateDormant: stateCounts[STATE_DORMANT] ?? 0,
        stateClosed: stateCounts[STATE_CLOSED] ?? 0,
      };

      reset(atMs);
      return report;
    },
  };
}

/**
 * Increment one counter slot.
 *
 * `noUncheckedIndexedAccess` types a typed-array read as possibly `undefined`,
 * so a compound assignment does not type-check. Every index here is produced by
 * a total function over a closed set, so the fallback is unreachable.
 */
function bump(counters: Int32Array, index: number): void {
  counters[index] = (counters[index] ?? 0) + 1;
}

/** First bucket whose bound the value does not exceed; overflow bucket otherwise. */
function bucketIndex(valueMs: number): number {
  for (let index = 0; index < LINK_RTT_BOUNDS_MS.length; index += 1) {
    const bound = LINK_RTT_BOUNDS_MS[index];
    if (bound !== undefined && valueMs <= bound) return index;
  }
  return LINK_RTT_BOUNDS_MS.length;
}

/**
 * Nearest-rank percentile read straight out of the bucket counts.
 *
 * Reports the bucket's upper bound, so the value is an upper estimate accurate
 * to one bucket width. That is the price of never sorting and never allocating,
 * and it is well inside what a link-quality chart needs. The overflow bucket
 * reports the last finite bound, which is why the ladder's top is chosen well
 * above any plausible healthy RTT.
 */
function percentileFromBuckets(buckets: Int32Array, total: number, ratio: number): number {
  if (total === 0) return 0;
  const target = Math.max(1, Math.ceil(total * ratio));
  let seen = 0;
  for (let index = 0; index < buckets.length; index += 1) {
    seen += buckets[index] ?? 0;
    if (seen >= target) {
      return LINK_RTT_BOUNDS_MS[index] ?? LINK_RTT_BOUNDS_MS[LINK_RTT_BOUNDS_MS.length - 1] ?? 0;
    }
  }
  return LINK_RTT_BOUNDS_MS[LINK_RTT_BOUNDS_MS.length - 1] ?? 0;
}

function pathIndex(path: LinkQualitySample['path']): number {
  if (path === 'direct') return PATH_DIRECT;
  if (path === 'relay') return PATH_RELAY;
  return PATH_UNKNOWN;
}

function stateIndex(state: LinkQualitySample['linkState']): number {
  if (state === 'connecting') return STATE_CONNECTING;
  if (state === 'ready') return STATE_READY;
  if (state === 'reconnecting') return STATE_RECONNECTING;
  if (state === 'dormant' || state === 'relay-paused' || state === 'relay-stopped')
    return STATE_DORMANT;
  return STATE_CLOSED;
}
