import type { TelemetryInputFrontierStatus } from '../../../apps/web/src/perf/telemetry-drain-status';
import type { TelemetryWorkerDrainStatus } from '../../../apps/web/src/telemetry-worker-protocol';
import { inputSequenceAdvances } from '../../../apps/web/src/transport/input-sequence-domain';
import {
  PROXY_HARNESS_DROP_KINDS,
  type ProxySettleStatus,
} from '../../../scripts/edge-network-stats';

export interface PresentationDrainObservation {
  readonly browserStatus: TelemetryWorkerDrainStatus | null;
  readonly proxyStatus: ProxySettleStatus | null;
}

/** The input frontier as a window with one timed input opened. */
export interface TimedInputBaseline {
  readonly observationEpoch: number;
  readonly input: TelemetryInputFrontierStatus;
}

/**
 * Where a timed window's one input completed: the first settle poll whose
 * browser status showed its ACK and its authoritative fence.
 */
export interface TimedInputClose {
  readonly input: TelemetryInputFrontierStatus;
  /**
   * The same poll's proxy status, read after that browser status: every packet
   * decided before the input completed, and those of about one more poll.
   */
  readonly proxyStatus: ProxySettleStatus | null;
}

export interface WaitForPresentationDrainOptions {
  /** Exact recorded window start, used when closing a real measurement. */
  readonly measurementId?: number;
  /** Measurement-free quiet oracle, used before opening an exact window. */
  readonly startAtMs?: number;
  /** The window holds exactly one awaited input after this baseline. */
  readonly timedInput?: TimedInputBaseline;
  readonly quietMs: number;
  readonly timeoutMs: number;
  readonly poll: () => Promise<PresentationDrainObservation>;
  readonly nowMs?: () => number;
  readonly wait?: (durationMs: number) => Promise<void>;
  readonly pollMs?: number;
}

/**
 * Hold a profiling boundary open until both sides of the observable test path
 * are quiet. This is a harness oracle, never a production presentation or
 * transport barrier: independent datagrams continue to apply immediately.
 *
 * Proxy counters are part of the signature as well as its live pending count.
 * A packet that enters and leaves between two polls therefore still resets the
 * quiet interval. Browser receipt/apply/commit and the exact commit GPU fence
 * do the same, so a reordered redraw arriving after its marker extends the
 * window instead of disappearing beyond it. Graphics tile jobs count too: every
 * transition restarts the interval, and quiet requires none still open.
 *
 * With `timedInput`, the drain also closes the window's proxy ledger where its
 * one input completed. Each poll reads the browser before the proxy, so the
 * first poll whose browser status covers the input with its cumulative ACK and
 * a fenced authoritative presentation reads a proxy status strictly after
 * completion. That status is returned, and the drain never settles before it.
 * No poll is added: the ones this oracle already makes run through the sample.
 */
export async function waitForPresentationDrain(
  options: WaitForPresentationDrainOptions,
): Promise<TimedInputClose | null> {
  const nowMs = options.nowMs ?? (() => performance.now());
  const wait =
    options.wait ??
    ((durationMs: number) => new Promise<void>((resolve) => setTimeout(resolve, durationMs)));
  const pollMs = options.pollMs ?? 25;
  if (
    (options.measurementId === undefined) === (options.startAtMs === undefined) ||
    (options.measurementId !== undefined &&
      (!Number.isSafeInteger(options.measurementId) || options.measurementId <= 0)) ||
    (options.startAtMs !== undefined &&
      (!Number.isFinite(options.startAtMs) || options.startAtMs < 0)) ||
    (options.timedInput !== undefined && options.measurementId === undefined) ||
    !Number.isFinite(options.quietMs) ||
    options.quietMs < 0 ||
    !Number.isFinite(options.timeoutMs) ||
    options.timeoutMs <= 0 ||
    !Number.isFinite(pollMs) ||
    pollMs <= 0
  ) {
    throw new Error('presentation drain requires one start boundary and positive finite durations');
  }

  const timedInput = options.timedInput;
  const startedAtMs = nowMs();
  let stableSinceMs = startedAtMs;
  let previousSignature: string | null = null;
  let observationEpoch: number | null = null;
  let close: TimedInputClose | null = null;
  let lastInput: TelemetryInputFrontierStatus | null = null;
  for (;;) {
    const observation = await options.poll();
    const browserStatus = observation.browserStatus;
    if (browserStatus?.activity.trackingOverflow) {
      throw new Error('presentation drain authoritative-render tracking overflowed');
    }
    if ((browserStatus?.stats.recordsLost ?? 0) > 0) {
      throw new Error('presentation drain cannot prove quiet after telemetry records were lost');
    }
    if (browserStatus !== null && browserStatus.stats.pendingRowsDropped > 0) {
      const stats = browserStatus.stats;
      throw new Error(
        `presentation drain cannot prove quiet after telemetry egress saturation: ${stats.pendingRowsDropped} rows refused, ${stats.pendingRows} pending, ${stats.rowsShipped} shipped, ${stats.sendFailures} failed sends`,
      );
    }
    const nextEpoch = browserStatus?.activity.observationEpoch;
    if (nextEpoch !== undefined) {
      observationEpoch ??= nextEpoch;
      if (nextEpoch !== observationEpoch) {
        throw new Error('presentation drain observation epoch changed while waiting for quiet');
      }
    }
    if (timedInput !== undefined && close === null && browserStatus !== null) {
      if (browserStatus.activity.observationEpoch !== timedInput.observationEpoch) {
        throw new Error('the observation changed after the timed window opened');
      }
      lastInput = browserStatus.activity.input;
      if (timedInputCompleted(timedInput.input, lastInput)) {
        close = { input: lastInput, proxyStatus: observation.proxyStatus };
      }
    }
    const signature = presentationDrainSignature(observation);
    const currentAtMs = nowMs();
    if (signature === null) {
      stableSinceMs = currentAtMs;
      previousSignature = null;
    } else {
      if (signature !== previousSignature) stableSinceMs = currentAtMs;
      previousSignature = signature;
      if (
        (timedInput === undefined || close !== null) &&
        (browserStatus?.activity.pendingAuthoritativeRenderCount ?? 1) === 0 &&
        (browserStatus?.activity.graphicsAsset.open ?? 1) === 0 &&
        (observation.proxyStatus?.pendingScheduledPackets ?? 0) === 0 &&
        currentAtMs - stableSinceMs >= options.quietMs
      ) {
        return close;
      }
    }
    if (currentAtMs - startedAtMs >= options.timeoutMs) {
      const timed =
        timedInput === undefined || close !== null
          ? ''
          : `; its timed input never completed: ${JSON.stringify({ baseline: timedInput, last: lastInput })}`;
      throw new Error(
        `presentation drain ${options.measurementId ?? options.startAtMs} did not settle within ${options.timeoutMs}ms${timed}`,
      );
    }
    await wait(pollMs);
  }
}

/**
 * Exactly one awaited input followed the baseline, and both the cumulative
 * ACK and a fenced authoritative presentation cover it. A second input makes
 * the window's sample ambiguous, so it throws.
 */
function timedInputCompleted(
  baseline: TelemetryInputFrontierStatus,
  current: TelemetryInputFrontierStatus,
): boolean {
  const queued = current.queuedCount - baseline.queuedCount;
  if (queued > 1) {
    throw new Error(
      `a timed window queued ${queued} inputs, not one: ${JSON.stringify({ baseline, current })}`,
    );
  }
  return (
    queued === 1 &&
    inputSequenceCovers(current.ackedSeq, current.queuedSeq) &&
    inputSequenceCovers(current.fencedSeq, current.queuedSeq)
  );
}

function inputSequenceCovers(frontier: number, inputSeq: number): boolean {
  return frontier === inputSeq || inputSequenceAdvances(inputSeq, frontier);
}

export function presentationDrainQuietMs(environment: NodeJS.ProcessEnv): number {
  const targetRttMs = finiteNonNegative(environment.EDGE_NETWORK_TARGET_RTT_MS);
  const jitterMs = finiteNonNegative(environment.EDGE_NETWORK_ONE_WAY_JITTER_MS);
  const maxExtraDelayMs = finiteNonNegative(environment.EDGE_NETWORK_MAX_EXTRA_DELAY_MS);
  const lossPercent = finiteNonNegative(environment.EDGE_NETWORK_DATAGRAM_LOSS_PERCENT);
  const repairTailMs =
    lossPercent > 0 || environment.EDGE_NETWORK_SCENARIO === 'burst-loss'
      ? targetRttMs * 2 + 24
      : 0;
  // Two 60Hz periods cover browser receipt/apply/fence scheduling. The rest is
  // the configured one-fault-site delivery skew and bounded repair tail.
  return Math.ceil(Math.max(50, 1000 / 30 + jitterMs + maxExtraDelayMs + repairTailMs));
}

function presentationDrainSignature(observation: PresentationDrainObservation): string | null {
  const browser = observation.browserStatus?.activity;
  if (browser === undefined) return null;
  const proxy = observation.proxyStatus;
  return [
    browser.observationEpoch,
    browser.observationStartedAtMs,
    browser.activityRevision,
    browser.activityEventCount,
    browser.latestActivityAtMs,
    browser.pendingAuthoritativeRenderCount,
    browser.graphicsAsset.eventCount,
    proxy?.epoch ?? 0,
    proxy?.upstream.seen ?? 0,
    proxy?.downstream.seen ?? 0,
    proxy?.upstream.forwarded ?? 0,
    proxy?.downstream.forwarded ?? 0,
    proxy?.upstream.released ?? 0,
    proxy?.downstream.released ?? 0,
    proxy?.downstream.dropped ?? 0,
    proxy?.downstream.reorderInversions ?? 0,
    proxy?.splitDatagrams ?? 0,
    ...PROXY_HARNESS_DROP_KINDS.map((kind) => proxy?.harnessDrops[kind] ?? 0),
    proxy?.pendingScheduledPackets ?? 0,
  ].join(':');
}

function finiteNonNegative(raw: string | undefined): number {
  if (raw === undefined) return 0;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`expected a non-negative finite network profile value, received ${raw}`);
  }
  return value;
}
