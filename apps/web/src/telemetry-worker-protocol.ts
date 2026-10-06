import { isRecord } from '@merkur/shared';

import type { TelemetryDrainActivityStatus } from './perf/telemetry-drain-status';
import type { TerminalPerfEvent } from './perf/terminal-latency';

/**
 * Wire shapes for the telemetry worker.
 *
 * Deliberately tiny. The point of this worker is that the *data* never crosses
 * by `postMessage` — it arrives through shared memory — so the only messages
 * here are lifecycle and an explicit diagnostic dump.
 */
export type TelemetryWorkerCommand =
  | {
      kind: 'init';
      /** One ring per producer thread, drained oldest-first into one stream. */
      terminalPerfRing: SharedArrayBuffer;
      transportPerfRing: SharedArrayBuffer;
      mainPerfRing: SharedArrayBuffer;
      perfStrings: SharedArrayBuffer;
      /** Absolute base for `POST /api/telemetry/perf`. */
      origin: string;
      /** Bearer token; refreshed by `token` below as the session rotates it. */
      accessToken: string;
      /**
       * Hard ceiling on bytes shipped, after which the worker stops posting and
       * says so. A visible stop, never a silent thinning of the data.
       */
      byteBudget: number;
      /** Initial browser-owned profiling lineage. */
      observationEpoch: number;
      /** One-use fence that established the active browser observation. */
      preparationRequestId: number;
      /** Initial capture includes only records at or after this active boundary. */
      observationStartedAtMs: number;
    }
  | { kind: 'token'; accessToken: string }
  | {
      /**
       * Drain and release the previous diagnostic trace before a new exact
       * observation boundary is established. The matching `observation`
       * command must carry this request id.
       */
      kind: 'prepare_observation';
      requestId: number;
    }
  | {
      /** Reset the compact signature and observation-scoped retained trace. */
      kind: 'observation';
      preparationRequestId: number;
      observationEpoch: number;
      observationStartedAtMs: number;
    }
  /** Drain, ship, and report — used by tests and the local diagnostic path. */
  | { kind: 'flush' }
  /** Drain new ring records and return only a fixed-size presentation signature. */
  | { kind: 'drain_status'; requestId: number }
  /** Return the retained decoded trace without shipping it. */
  | { kind: 'dump'; requestId: number }
  | { kind: 'stop' };

export interface TelemetryWorkerStats {
  /** Records decoded and accepted since init. */
  readonly recordsDrained: number;
  /**
   * Records the writer overwrote before this worker reached them, plus records
   * dropped because they could not be decoded faithfully.
   */
  readonly recordsLost: number;
  readonly rowsShipped: number;
  readonly bytesShipped: number;
  readonly sendFailures: number;
  /** Rows currently retained only for the bounded telemetry-egress queue. */
  readonly pendingRows: number;
  /** Rows retained for dump but refused by a saturated telemetry-egress queue. */
  readonly pendingRowsDropped: number;
  /** True once `byteBudget` is exhausted; nothing is shipped after this. */
  readonly budgetExhausted: boolean;
}

export interface TelemetryWorkerDrainStatus {
  readonly activity: TelemetryDrainActivityStatus;
  readonly stats: TelemetryWorkerStats;
}

/** Exact accounting for the retained trace of one recorder observation. */
export interface TelemetryObservationTraceCapture {
  readonly complete: boolean;
  readonly preparationRequestId: number;
  readonly observationEpoch: number;
  readonly observationStartedAtMs: number;
  readonly capacity: number;
  /** Retained plus every exactly counted producer loss / retained overwrite. */
  readonly totalRecordedCount: number;
  readonly retainedEventCount: number;
  readonly retainedOverwriteCount: number;
  readonly producerRecordLossCount: number;
  readonly droppedEventCount: number;
}

export interface TelemetryObservationCompletion {
  readonly preparationRequestId: number;
  readonly observationEpoch: number;
  readonly observationStartedAtMs: number;
  readonly capture: TelemetryObservationTraceCapture;
}

export type TelemetryWorkerEvent =
  | { kind: 'stats'; stats: TelemetryWorkerStats }
  | {
      kind: 'observation_prepared';
      requestId: number;
      stats: TelemetryWorkerStats;
    }
  | ({ kind: 'observation_complete'; stats: TelemetryWorkerStats } & TelemetryObservationCompletion)
  | {
      kind: 'drain_status';
      requestId: number;
      status: TelemetryDrainActivityStatus;
      stats: TelemetryWorkerStats;
    }
  | {
      kind: 'dump';
      requestId: number;
      events: readonly TerminalPerfEvent[];
      stats: TelemetryWorkerStats;
      capture: TelemetryObservationTraceCapture;
    };

/**
 * Whether `value` is a capture whose accounting adds up. The performance
 * fixtures apply it to what they read back out of the page and off disk; the
 * worker channel itself is typed and unchecked.
 */
export function isTelemetryObservationTraceCapture(
  value: unknown,
): value is TelemetryObservationTraceCapture {
  if (!isRecord(value)) return false;
  const capture = value;
  return (
    typeof capture.complete === 'boolean' &&
    isUint32(capture.preparationRequestId) &&
    isUint32(capture.observationEpoch) &&
    capture.observationEpoch > 0 &&
    typeof capture.observationStartedAtMs === 'number' &&
    Number.isFinite(capture.observationStartedAtMs) &&
    capture.observationStartedAtMs >= 0 &&
    isCount(capture.capacity) &&
    capture.capacity > 0 &&
    isCount(capture.totalRecordedCount) &&
    isCount(capture.retainedEventCount) &&
    capture.retainedEventCount <= capture.capacity &&
    isCount(capture.retainedOverwriteCount) &&
    isCount(capture.producerRecordLossCount) &&
    isCount(capture.droppedEventCount) &&
    capture.droppedEventCount ===
      capture.retainedOverwriteCount + capture.producerRecordLossCount &&
    capture.totalRecordedCount === capture.retainedEventCount + capture.droppedEventCount
  );
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isUint32(value: unknown): value is number {
  return isCount(value) && value <= 0xffff_ffff;
}
