import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { gunzipSync } from 'node:zlib';
import {
  buildTerminalLatencyRawMetricSamples,
  buildTerminalLatencyReport,
  TERMINAL_LATENCY_RAW_METRIC_NAMES,
  type TerminalLatencyRawMetricName,
  type TerminalLatencyRawMetricSamples,
  type TerminalPerfEvent,
} from '../../../apps/web/src/perf/terminal-latency';
import { collectApplicationDisplayOutcome } from './terminal-perf-artifacts';

export interface PercentileDistribution {
  readonly count: number;
  readonly median: number | null;
  readonly p95: number | null;
  readonly p99: number | null;
  readonly worst: number | null;
  /** False means the numeric tail is diagnostic only, never acceptance evidence. */
  readonly complete: boolean;
  /** Inputs admitted inside an explicit logical-workload window, when applicable. */
  readonly eligibleCount?: number;
  /** Eligible inputs without a causally covered final GPU fence. */
  readonly censoredCount?: number;
}

export interface RawTerminalPerfReplay {
  readonly eventCount: number;
  readonly reportSha256: string;
  readonly applicationDisplayOutcomeSha256: string;
  readonly metricSamples: TerminalLatencyRawMetricSamples;
  readonly metricComplete: Readonly<Record<TerminalLatencyRawMetricName, boolean>>;
}

const TERMINAL_PERF_EVENT_KINDS = new Set<string>([
  'browser_display_io',
  'carrier_recovery',
  'daemon_timing',
  'daemon_timing_status',
  'display_pump_complete',
  'display_ring_measurement_boundary',
  'display_received',
  'display_resync',
  'frame_complete',
  'graphics_asset',
  'input_ack',
  'input_queued',
  'input_sent',
  'keyboard_commit',
  'main_frame_cadence',
  'main_long_task',
  'prediction_applied',
  'prediction_gate',
  'prediction_queued',
  'prediction_rejected',
  'prediction_suppressed',
  'presentation_commit',
  'presentation_epoch_boundary',
  'presentation_measurement_boundary',
  'presentation_transaction_discarded',
  'render_end',
  'render_start',
  'session_bound',
  'session_start',
  'startup_milestone',
  'transport_state',
  'worker_display_applied',
  'worker_display_queued',
]);

export function extractPercentileMetrics(
  report: unknown,
): Readonly<Record<string, PercentileDistribution>> {
  const metrics: Record<string, PercentileDistribution> = {};
  const visit = (value: unknown, pathSegments: readonly string[]): void => {
    if (!isRecord(value)) return;
    const median = nullableFiniteNumber(value.p50);
    const p95 = nullableFiniteNumber(value.p95);
    const p99 = nullableFiniteNumber(value.p99);
    const worst = nullableFiniteNumber(value.max);
    if (
      pathSegments.length > 0 &&
      isNonNegativeSafeInteger(value.count) &&
      typeof value.complete === 'boolean' &&
      median !== undefined &&
      p95 !== undefined &&
      p99 !== undefined &&
      worst !== undefined
    ) {
      metrics[pathSegments.join('.')] = {
        count: value.count,
        median,
        p95,
        p99,
        worst,
        complete: value.complete,
        ...(isNonNegativeSafeInteger(value.eligibleCount)
          ? { eligibleCount: value.eligibleCount }
          : {}),
        ...(isNonNegativeSafeInteger(value.censoredCount)
          ? { censoredCount: value.censoredCount }
          : {}),
      };
      return;
    }
    for (const [name, child] of Object.entries(value)) visit(child, [...pathSegments, name]);
  };
  visit(report, []);
  return metrics;
}

/**
 * Decode the retained gzip trace and independently rebuild every unbounded
 * report aggregate used by matrix acceptance. The summary intentionally keeps
 * only a bounded head/tail sample list, so `samples` is the sole excluded
 * field; all distributions, completeness bits, counters, and presentation
 * membership must be byte-for-value identical to a fresh replay.
 */
export function verifyRawTerminalPerfTrace(
  compressed: Uint8Array,
  expectedEventCount: number,
  expectedReport: unknown,
  expectedApplicationDisplayOutcome: unknown,
): RawTerminalPerfReplay {
  if (!isNonNegativeSafeInteger(expectedEventCount)) {
    throw new Error(`raw terminal event count is invalid: ${String(expectedEventCount)}`);
  }
  if (!isRecord(expectedReport)) throw new Error('terminal latency summary report is malformed');
  let decoded: unknown;
  try {
    decoded = JSON.parse(gunzipSync(compressed).toString('utf8'));
  } catch (error) {
    throw new Error(`raw terminal event trace is not valid gzip JSON: ${formatError(error)}`);
  }
  if (!Array.isArray(decoded)) throw new Error('raw terminal event trace is not a JSON array');
  if (decoded.length !== expectedEventCount) {
    throw new Error(
      `raw terminal event count ${decoded.length} does not match summary ${expectedEventCount}`,
    );
  }
  if (
    !decoded.every(
      (event) =>
        isRecord(event) &&
        typeof event.kind === 'string' &&
        TERMINAL_PERF_EVENT_KINDS.has(event.kind) &&
        (event.kind !== 'frame_complete' ||
          event.completionDisposition === 'latest-submitted' ||
          event.completionDisposition === 'superseded' ||
          event.completionDisposition === 'invalidated') &&
        typeof event.atMs === 'number' &&
        Number.isFinite(event.atMs),
    )
  ) {
    throw new Error('raw terminal event trace contains a malformed event envelope');
  }

  // The discriminant/timestamp envelope was validated above. The analyzer
  // performs the kind-specific fail-closed validation and will make any
  // malformed member differ from the producer-built summary.
  const events = decoded as TerminalPerfEvent[];
  const replayedReport = buildTerminalLatencyReport(events);
  const replayedMetrics = extractPercentileMetrics(replayedReport);
  const replayedComparableReport = reportWithoutSamples(replayedReport);
  const expectedComparableReport = reportWithoutSamples(expectedReport);
  if (!isDeepStrictEqual(replayedComparableReport, expectedComparableReport)) {
    throw new Error('raw terminal event replay does not match the retained latency report');
  }

  const replayedApplicationDisplayOutcome = collectApplicationDisplayOutcome(events);
  if (!isDeepStrictEqual(replayedApplicationDisplayOutcome, expectedApplicationDisplayOutcome)) {
    throw new Error(
      'raw terminal event replay does not match the retained application display outcome',
    );
  }
  return {
    eventCount: events.length,
    reportSha256: jsonSha256(replayedComparableReport),
    applicationDisplayOutcomeSha256: jsonSha256(replayedApplicationDisplayOutcome),
    metricSamples: buildTerminalLatencyRawMetricSamples(events),
    metricComplete: Object.fromEntries(
      TERMINAL_LATENCY_RAW_METRIC_NAMES.map((name) => [
        name,
        replayedMetrics[name]?.complete === true,
      ]),
    ) as Readonly<Record<TerminalLatencyRawMetricName, boolean>>,
  };
}

function reportWithoutSamples(value: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'samples'));
}

function jsonSha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function nullableFiniteNumber(value: unknown): number | null | undefined {
  if (value === null) return null;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function formatError(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
