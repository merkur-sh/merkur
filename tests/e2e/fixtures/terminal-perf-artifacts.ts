import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip, constants as zlibConstants } from 'node:zlib';

import type {
  TerminalLatencyPercentiles,
  TerminalLatencyReport,
  TerminalPerfEvent,
} from '../../../apps/web/src/perf/terminal-latency';
import {
  isTelemetryObservationTraceCapture,
  type TelemetryObservationTraceCapture,
} from '../../../apps/web/src/telemetry-worker-protocol';

// 4: `TerminalLatencyReport` gained the apply-to-paint decomposition
// (`displayApplyToRenderStartMs`, `renderStartToRenderEndMs`,
// `renderEndToDisplayPaintMs`, the fence observation bounds, `renderGate` and
// `renderInstrumentation`). The recorder itself is unchanged.
// 5: `TerminalLatencyReport` gained authoritative-geometry GPU-fence latency,
// completed-presentation GPU-fence latency, and the `presentation` transaction
// aggregates including `partialPresentationExposureMs`.
// 6: presentation commits gained exact applied-datagram transaction membership;
// coherence exposure is joined through poll-observed GPU-fence completion for
// every presentation id and explicit harness workload window, and nested
// worker timestamps became clock-safe durations. Artifacts also carry the
// realized application display outcome alongside configured proxy loss, plus
// exact worker receipt/decode/apply and bounded display-pump slice metrics.
// 7: display events gained exact visual-mutation, chunk, presentation discard,
// epoch-boundary, and reliable daemon-timing completeness provenance.
// 8: explicit workload windows gained visible main-thread rAF/long-task
// evidence plus exact Merkur-owned browser display copy/allocation requests.
// 9: exact daemon timing-batch completeness and browser display-I/O coverage
// moved into the mandatory report contract.
// 10: daemon reports gained per-sample grid-mutation-to-encoding and summed
// prepare/completion queue distributions instead of requiring consumers to
// add independently ranked percentiles.
// 11: measurement windows classify ordinary, exact-repair, and expired-repair
// commits, and browser evidence records actual display-datagram reordering.
// 16: display-pump evidence names encoded deferrals explicitly, retains SAB
// boundary occupancy, and pairs worker-owned refusal counters across exact
// logical windows plus every inter-window gap in the measured span.
// 17: the nonphysical fence lower-bound metric is replaced by the literal
// render-end-to-last-cached-unready-poll observation. Raw event shape is unchanged.
// 18: the endpoint literal names browser-observed WebGL sync readiness, not
// the physical instant the underlying fence signaled. Raw event shape is unchanged.
// 19: frame completions require latest-submitted/superseded/invalidated disposition;
// non-latest command-readiness observations retain their submitted membership
// but cannot supply local prediction-visibility evidence.
// Fence-gated render starts also name their exact completed render owner.
// 20: browser display ingress accounting carries the exact callback-owned
// direct/relay and datagram/reliable route; terminal-owned stages carry null.
export const TERMINAL_PERF_ARTIFACT_SCHEMA_VERSION = 20;
export const TERMINAL_PERF_RECORDER_SCHEMA_VERSION = 3;
export const MAX_DIAGNOSTIC_EVENTS_PER_KIND = 256;
export const MAX_DIAGNOSTIC_EVENT_KINDS = 128;
export const MAX_SUMMARY_REPORT_SAMPLES = 256;

/** Main-recorder events merged beside the telemetry worker's final ring dump. */
export const TERMINAL_PERF_HARNESS_BOUNDARY_KINDS = [
  'presentation_measurement_boundary',
  'display_ring_measurement_boundary',
] as const;

/**
 * The telemetry worker owns hot-path events, while the profiling fixture owns
 * logical boundaries. Preserve both boundary kinds exactly once when the one
 * final worker dump replaces the recorder shell.
 */
export function mergeTerminalPerfWorkerAndHarnessEvents(
  workerEvents: readonly unknown[],
  recorderEvents: readonly unknown[],
): unknown[] {
  const boundaries = recorderEvents.filter((event) => {
    if (typeof event !== 'object' || event === null) return false;
    const kind = (event as { kind?: unknown }).kind;
    return TERMINAL_PERF_HARNESS_BOUNDARY_KINDS.some((candidate) => candidate === kind);
  });
  return workerEvents.concat(boundaries);
}

/**
 * The capture is written into the artifact as received, so it carries exactly the fields its
 * type names. The guard proves each one; this count, exhaustive at compile time, refuses any
 * other.
 */
const CAPTURE_FIELD_COUNT = Object.keys({
  complete: true,
  preparationRequestId: true,
  observationEpoch: true,
  observationStartedAtMs: true,
  capacity: true,
  totalRecordedCount: true,
  retainedEventCount: true,
  retainedOverwriteCount: true,
  producerRecordLossCount: true,
  droppedEventCount: true,
} satisfies Record<keyof TelemetryObservationTraceCapture, true>).length;

export interface TelemetryObservationIdentity {
  readonly preparationRequestId: number;
  readonly observationEpoch: number;
  readonly observationStartedAtMs: number;
}

/**
 * Build recorder accounting from the worker's exact observation capture.
 *
 * The page recorder contributes only the separately retained harness boundary
 * events. Lifetime worker stats are deliberately absent: they cannot describe
 * which losses belong to this observation.
 */
export function buildTelemetryObservationRecorderMetadata(
  shellMetadata: unknown,
  captureValue: unknown,
  workerRetainedEventCount: number,
  harnessBoundaryCount: number,
  expectedObservation: TelemetryObservationIdentity | null,
): {
  readonly capture: TelemetryObservationTraceCapture;
  readonly recorder: TerminalPerfRecorderMetadata;
} {
  if (!Number.isSafeInteger(workerRetainedEventCount) || workerRetainedEventCount < 0) {
    throw new Error(
      `telemetry worker retained-event count is invalid: ${String(workerRetainedEventCount)}`,
    );
  }
  if (!Number.isSafeInteger(harnessBoundaryCount) || harnessBoundaryCount < 0) {
    throw new Error(`telemetry harness boundary count is invalid: ${String(harnessBoundaryCount)}`);
  }
  if (
    !isTelemetryObservationTraceCapture(captureValue) ||
    Object.keys(captureValue).length !== CAPTURE_FIELD_COUNT
  ) {
    throw new Error('telemetry worker observation capture is malformed');
  }
  const capture = captureValue;
  if (!capture.complete) {
    throw new Error('telemetry worker observation capture is incomplete');
  }
  if (capture.retainedEventCount !== workerRetainedEventCount) {
    throw new Error(
      `telemetry worker retained ${workerRetainedEventCount} event(s), capture accounts for ${capture.retainedEventCount}`,
    );
  }
  if (
    expectedObservation !== null &&
    (capture.preparationRequestId !== expectedObservation.preparationRequestId ||
      capture.observationEpoch !== expectedObservation.observationEpoch ||
      capture.observationStartedAtMs !== expectedObservation.observationStartedAtMs)
  ) {
    throw new Error('telemetry worker observation capture does not match the active boundary');
  }

  const retainedEventCount = checkedSafeSum(
    capture.retainedEventCount,
    harnessBoundaryCount,
    'retained-event',
  );
  const totalRecordedCount = checkedSafeSum(
    capture.totalRecordedCount,
    harnessBoundaryCount,
    'total-recorded-event',
  );
  const capacity = checkedSafeSum(capture.capacity, harnessBoundaryCount, 'capacity');
  if (!isRecord(shellMetadata)) {
    throw new Error('terminal performance boundary recorder metadata is unavailable');
  }
  const shell = normalizeRecorderMetadata(shellMetadata, harnessBoundaryCount);
  const shellProblems = validateRecorderMetadata(shell);
  if (
    shellMetadata.available !== true ||
    shellMetadata.schemaVersion !== TERMINAL_PERF_RECORDER_SCHEMA_VERSION ||
    !Number.isSafeInteger(shellMetadata.totalRecordedCount) ||
    !Number.isSafeInteger(shellMetadata.retainedEventCount) ||
    !Number.isSafeInteger(shellMetadata.overwriteCount) ||
    !Number.isSafeInteger(shellMetadata.droppedEventCount) ||
    shellProblems.length > 0
  ) {
    throw new Error(
      `terminal performance boundary recorder metadata is invalid${shellProblems.length === 0 ? '' : `: ${shellProblems.join('; ')}`}`,
    );
  }
  if (
    shell.totalRecordedCount !== harnessBoundaryCount ||
    shell.retainedEventCount !== harnessBoundaryCount
  ) {
    throw new Error(
      `terminal performance boundary recorder retained ${shell.retainedEventCount}/${shell.totalRecordedCount} event(s), expected ${harnessBoundaryCount}`,
    );
  }
  return {
    capture,
    recorder: {
      ...shell,
      available: shell.available,
      capacity,
      resetAtMs: capture.observationStartedAtMs,
      totalRecordedCount,
      retainedEventCount,
      overwriteCount: capture.retainedOverwriteCount,
      droppedEventCount: capture.droppedEventCount,
    },
  };
}

export interface TerminalPerfRecorderMetadata {
  readonly available: boolean;
  readonly schemaVersion: number | null;
  readonly capacity: number | null;
  readonly installedAtMs: number | null;
  readonly resetAtMs: number | null;
  readonly capturedAtMs: number | null;
  readonly firstRecordedAtMs: number | null;
  readonly lastRecordedAtMs: number | null;
  readonly oldestRetainedEventAtMs: number | null;
  readonly newestRetainedEventAtMs: number | null;
  readonly totalRecordedCount: number;
  readonly retainedEventCount: number;
  /** Missing because the recorder's own fixed retained store evicted it. */
  readonly overwriteCount: number;
  /** All missing events, including producer-ring/decode loss before retention. */
  readonly droppedEventCount: number;
}

export interface TerminalPerfRecorderCapture {
  readonly events: TerminalPerfEvent[];
  readonly recorder: TerminalPerfRecorderMetadata;
}

export interface FrozenTerminalPerfSnapshot {
  readonly events: readonly TerminalPerfEvent[];
  readonly report: TerminalLatencyReport;
  readonly recorder: TerminalPerfRecorderMetadata;
}

/** A numeric tail is reportable only when every source event joined cleanly. */
export function isCompleteLatencyDistribution(
  distribution: TerminalLatencyPercentiles,
  minimumCount: number,
): boolean {
  return distribution.complete && distribution.count >= minimumCount && distribution.p95 !== null;
}

export interface PredictionDiagnostics {
  readonly eventCountsByKind: Readonly<Record<string, number>>;
  readonly unclassifiedEvents: number;
  readonly untrackedKindEvents: number;
  readonly perKindRetentionLimit: number;
  readonly queued: number;
  readonly applied: number;
  readonly submitted: number;
  readonly completed: number;
  readonly queuedEvents: readonly Readonly<Record<string, unknown>>[];
  readonly appliedEvents: readonly Readonly<Record<string, unknown>>[];
  readonly gates: readonly Readonly<Record<string, unknown>>[];
  readonly suppressions: readonly Readonly<Record<string, unknown>>[];
  readonly renderedFrames: readonly Readonly<Record<string, unknown>>[];
  readonly submittedFrames: readonly Readonly<Record<string, unknown>>[];
  readonly completedFrames: readonly Readonly<Record<string, unknown>>[];
}

/**
 * What the browser actually observed at the application display layer.
 *
 * `interiorSequenceGapCount` is a lower bound over delta-datagram sequences: it
 * counts missing numbers bracketed by later received deltas, never an unresolved
 * tail. Reliable snapshots use sequence zero and are counted by exact
 * generation/frame/chunk identity instead. QUIC packet loss and
 * display-datagram loss are not interchangeable, so this is reported beside
 * (not derived from) the proxy's UDP counters.
 */
export interface ApplicationDisplayOutcome {
  readonly complete: boolean;
  readonly receivedEventCount: number;
  readonly uniqueReceivedDatagramCount: number;
  readonly duplicateReceivedEventCount: number;
  readonly appliedEventCount: number;
  readonly uniqueAppliedDatagramCount: number;
  readonly receivedWithoutApplyCount: number;
  readonly appliedWithoutReceiveCount: number;
  readonly observedSequenceSlotCount: number;
  readonly interiorSequenceGapCount: number;
  readonly outOfOrderReceivedDatagramCount: number;
  readonly fecRecoveredReceivedDatagramCount: number;
  readonly fecRecoveredAppliedDatagramCount: number;
  readonly fecRecoveredVisualAppliedDatagramCount: number;
  readonly interiorSequenceGapPercent: number | null;
  readonly snapshotReceivedCount: number;
  readonly snapshotAppliedCount: number;
  readonly snapshotReceivedChunkCount: number;
  readonly snapshotAppliedChunkCount: number;
  readonly resyncRequestCount: number;
  readonly resyncAlreadyPendingCount: number;
  readonly repairTargetSatisfiedCommitCount: number;
  readonly repairDeadlineExpiredCommitCount: number;
}

const APPLICATION_DISPLAY_OUTCOME_COUNT_KEYS = [
  'receivedEventCount',
  'uniqueReceivedDatagramCount',
  'duplicateReceivedEventCount',
  'appliedEventCount',
  'uniqueAppliedDatagramCount',
  'receivedWithoutApplyCount',
  'appliedWithoutReceiveCount',
  'observedSequenceSlotCount',
  'interiorSequenceGapCount',
  'outOfOrderReceivedDatagramCount',
  'fecRecoveredReceivedDatagramCount',
  'fecRecoveredAppliedDatagramCount',
  'fecRecoveredVisualAppliedDatagramCount',
  'snapshotReceivedCount',
  'snapshotAppliedCount',
  'snapshotReceivedChunkCount',
  'snapshotAppliedChunkCount',
  'resyncRequestCount',
  'resyncAlreadyPendingCount',
  'repairTargetSatisfiedCommitCount',
  'repairDeadlineExpiredCommitCount',
] as const;

/** Shared fail-closed semantic validation for retained application display evidence. */
export function validateApplicationDisplayOutcomeEvidence(
  value: unknown,
  requireSnapshot: boolean,
  requireEveryReceivedApplied: boolean,
  requireNoRecovery: boolean,
): string[] {
  if (!isRecord(value)) return ['application display outcome is missing'];
  const errors: string[] = [];
  if (value.complete !== true) errors.push('application display outcome is incomplete');
  for (const key of APPLICATION_DISPLAY_OUTCOME_COUNT_KEYS) {
    if (!isNonNegativeSafeInteger(value[key])) errors.push(`application display ${key} is invalid`);
  }
  if (value.receivedEventCount === 0) errors.push('application display recorded no receipts');
  if (value.appliedEventCount === 0) errors.push('application display recorded no applies');
  if (value.appliedWithoutReceiveCount !== 0) {
    errors.push('application display apply provenance is missing');
  }
  if (
    isNonNegativeSafeInteger(value.fecRecoveredReceivedDatagramCount) &&
    isNonNegativeSafeInteger(value.fecRecoveredAppliedDatagramCount) &&
    value.fecRecoveredAppliedDatagramCount > value.fecRecoveredReceivedDatagramCount
  ) {
    errors.push('application display FEC receipt/apply counts are inconsistent');
  }
  if (
    isNonNegativeSafeInteger(value.fecRecoveredAppliedDatagramCount) &&
    isNonNegativeSafeInteger(value.fecRecoveredVisualAppliedDatagramCount) &&
    value.fecRecoveredVisualAppliedDatagramCount > value.fecRecoveredAppliedDatagramCount
  ) {
    errors.push('application display visual FEC apply count is inconsistent');
  }
  if (requireEveryReceivedApplied && value.receivedWithoutApplyCount !== 0) {
    errors.push('ordinary workload received a display transformation that was never applied');
  }
  if (requireNoRecovery) {
    for (const key of [
      'repairTargetSatisfiedCommitCount',
      'repairDeadlineExpiredCommitCount',
      'fecRecoveredReceivedDatagramCount',
      'fecRecoveredAppliedDatagramCount',
      'fecRecoveredVisualAppliedDatagramCount',
      'interiorSequenceGapCount',
    ] as const) {
      if (value[key] !== 0) errors.push(`clean workload application display ${key} must be zero`);
    }
  }
  if (
    typeof value.interiorSequenceGapPercent !== 'number' &&
    value.interiorSequenceGapPercent !== null
  ) {
    errors.push('application display interior gap percentage is invalid');
  }
  if (
    typeof value.interiorSequenceGapPercent === 'number' &&
    (!Number.isFinite(value.interiorSequenceGapPercent) || value.interiorSequenceGapPercent < 0)
  ) {
    errors.push('application display interior gap percentage is invalid');
  }
  if (
    isNonNegativeSafeInteger(value.snapshotReceivedCount) &&
    isNonNegativeSafeInteger(value.snapshotReceivedChunkCount) &&
    value.snapshotReceivedCount > value.snapshotReceivedChunkCount
  ) {
    errors.push('application display snapshot receipt frame/chunk counts are inconsistent');
  }
  if (
    isNonNegativeSafeInteger(value.snapshotAppliedCount) &&
    isNonNegativeSafeInteger(value.snapshotAppliedChunkCount) &&
    value.snapshotAppliedCount > value.snapshotAppliedChunkCount
  ) {
    errors.push('application display snapshot apply frame/chunk counts are inconsistent');
  }
  if (requireSnapshot) {
    if (value.snapshotReceivedCount === 0 || value.snapshotReceivedChunkCount === 0) {
      errors.push('recovery artifact recorded no snapshot receipt');
    }
    if (value.snapshotAppliedCount !== value.snapshotReceivedCount) {
      errors.push('recovery snapshot frame receipt/apply counts differ');
    }
    if (value.snapshotAppliedChunkCount !== value.snapshotReceivedChunkCount) {
      errors.push('recovery snapshot chunk receipt/apply counts differ');
    }
  }
  return errors;
}

export function collectApplicationDisplayOutcome(
  events: readonly TerminalPerfEvent[],
): ApplicationDisplayOutcome {
  let latestSessionStartAtMs = Number.NEGATIVE_INFINITY;
  let complete = true;
  for (const event of events) {
    if (event.kind !== 'session_start') continue;
    if (!Number.isFinite(event.atMs)) complete = false;
    else latestSessionStartAtMs = Math.max(latestSessionStartAtMs, event.atMs);
  }

  const receivedTransformations = new Set<string>();
  const appliedTransformations = new Set<string>();
  const receivedDeltaDatagrams = new Set<string>();
  const appliedDeltaDatagrams = new Set<string>();
  const fecRecoveredReceivedDatagrams = new Set<string>();
  const fecRecoveredAppliedDatagrams = new Set<string>();
  const fecRecoveredVisualAppliedDatagrams = new Set<string>();
  const receivedSnapshotFrames = new Set<string>();
  const appliedSnapshotFrames = new Set<string>();
  const receivedSnapshotChunks = new Set<string>();
  const appliedSnapshotChunks = new Set<string>();
  const receivedByGeneration = new Map<number, Set<number>>();
  const newestReceivedByGeneration = new Map<number, number>();
  let receivedEventCount = 0;
  let appliedEventCount = 0;
  let resyncRequestCount = 0;
  let resyncAlreadyPendingCount = 0;
  let repairTargetSatisfiedCommitCount = 0;
  let repairDeadlineExpiredCommitCount = 0;
  let outOfOrderReceivedDatagramCount = 0;

  for (const event of events) {
    if (event.atMs < latestSessionStartAtMs) continue;
    if (event.kind === 'display_received' || event.kind === 'worker_display_applied') {
      const invalidCommonIdentity =
        !Number.isFinite(event.atMs) ||
        !Number.isSafeInteger(event.generation) ||
        event.generation <= 0 ||
        !Number.isSafeInteger(event.displaySeq) ||
        event.displaySeq < 0 ||
        !Number.isSafeInteger(event.frameId) ||
        event.frameId <= 0 ||
        !Number.isSafeInteger(event.presentationId) ||
        event.presentationId <= 0 ||
        !Number.isSafeInteger(event.chunkIndex) ||
        event.chunkIndex < 0 ||
        !Number.isSafeInteger(event.chunkCount) ||
        event.chunkCount <= 0 ||
        event.chunkIndex >= event.chunkCount ||
        typeof event.fecRecovered !== 'boolean';
      const validDeltaIdentity =
        event.displayKind !== 'display_delta' ||
        (event.displaySeq > 0 && event.chunkIndex === 0 && event.chunkCount === 1);
      const validSnapshotAggregate =
        event.kind !== 'worker_display_applied' ||
        event.displayKind !== 'display_snapshot' ||
        event.chunkIndex === 0;
      if (invalidCommonIdentity || !validDeltaIdentity || !validSnapshotAggregate) {
        complete = false;
        continue;
      }
      if (event.displayKind === 'display_delta') {
        const key = `delta:${event.generation}:${event.displaySeq}`;
        if (event.kind === 'display_received') {
          receivedEventCount += 1;
          receivedTransformations.add(key);
          if (!receivedDeltaDatagrams.has(key)) {
            const newest = newestReceivedByGeneration.get(event.generation);
            if (
              newest !== undefined &&
              event.displaySeq !== newest &&
              (newest - event.displaySeq) >>> 0 < 0x8000_0000
            ) {
              outOfOrderReceivedDatagramCount += 1;
            } else if (
              newest === undefined ||
              (event.displaySeq !== newest && (event.displaySeq - newest) >>> 0 < 0x8000_0000)
            ) {
              newestReceivedByGeneration.set(event.generation, event.displaySeq);
            }
          }
          receivedDeltaDatagrams.add(key);
          if (event.fecRecovered) fecRecoveredReceivedDatagrams.add(key);
          let sequences = receivedByGeneration.get(event.generation);
          if (sequences === undefined) {
            sequences = new Set<number>();
            receivedByGeneration.set(event.generation, sequences);
          }
          sequences.add(event.displaySeq);
        } else {
          appliedEventCount += 1;
          appliedTransformations.add(key);
          appliedDeltaDatagrams.add(key);
          if (event.fecRecovered) {
            fecRecoveredAppliedDatagrams.add(key);
            if (event.authoritativeVisualMutation) fecRecoveredVisualAppliedDatagrams.add(key);
          }
        }
        continue;
      }

      const frameKey = `snapshot:${event.generation}:${event.frameId}`;
      if (event.kind === 'display_received') {
        receivedEventCount += 1;
        receivedSnapshotFrames.add(frameKey);
        const chunkKey = `${frameKey}:${event.chunkIndex}`;
        receivedSnapshotChunks.add(chunkKey);
        receivedTransformations.add(chunkKey);
      } else {
        appliedEventCount += 1;
        appliedSnapshotFrames.add(frameKey);
        // One applied event represents the complete prevalidated reliable frame.
        // Reconstruct its exact chunk membership so missing receipt provenance
        // cannot be hidden by the aggregate event.
        for (let chunkIndex = 0; chunkIndex < event.chunkCount; chunkIndex += 1) {
          const chunkKey = `${frameKey}:${chunkIndex}`;
          appliedSnapshotChunks.add(chunkKey);
          appliedTransformations.add(chunkKey);
        }
      }
    } else if (event.kind === 'display_resync') {
      if (!Number.isFinite(event.atMs) || !Number.isSafeInteger(event.generation)) {
        complete = false;
        continue;
      }
      resyncRequestCount += 1;
      if (event.alreadyPending) resyncAlreadyPendingCount += 1;
    } else if (event.kind === 'presentation_commit') {
      if (event.reason === 'repair-target-satisfied') repairTargetSatisfiedCommitCount += 1;
      else if (event.reason === 'repair-deadline-expired') repairDeadlineExpiredCommitCount += 1;
    }
  }

  let observedSequenceSlotCount = 0;
  let interiorSequenceGapCount = 0;
  for (const [generation, sequences] of receivedByGeneration) {
    const newest = newestReceivedByGeneration.get(generation);
    if (newest === undefined || sequences.size === 0) continue;
    let oldestDistance = 0;
    for (const sequence of sequences) {
      const distance = nonzeroSerialDistance(newest, sequence);
      // A half-range or farther observation cannot be ordered under RFC-1982.
      // Refuse to manufacture a plausible gap count from an ambiguous span.
      if (distance >= 0x8000_0000) {
        complete = false;
        oldestDistance = -1;
        break;
      }
      oldestDistance = Math.max(oldestDistance, distance);
    }
    if (oldestDistance < 0) continue;
    const slots = oldestDistance + 1;
    if (!Number.isSafeInteger(slots) || slots < sequences.size) {
      complete = false;
      continue;
    }
    observedSequenceSlotCount += slots;
    interiorSequenceGapCount += slots - sequences.size;
  }

  let receivedWithoutApplyCount = 0;
  for (const key of receivedTransformations) {
    if (!appliedTransformations.has(key)) receivedWithoutApplyCount += 1;
  }
  let appliedWithoutReceiveCount = 0;
  for (const key of appliedTransformations) {
    if (!receivedTransformations.has(key)) appliedWithoutReceiveCount += 1;
  }
  if (appliedWithoutReceiveCount > 0) complete = false;

  return {
    complete,
    receivedEventCount,
    uniqueReceivedDatagramCount: receivedDeltaDatagrams.size,
    duplicateReceivedEventCount:
      receivedEventCount - receivedDeltaDatagrams.size - receivedSnapshotChunks.size,
    appliedEventCount,
    uniqueAppliedDatagramCount: appliedDeltaDatagrams.size,
    receivedWithoutApplyCount,
    appliedWithoutReceiveCount,
    observedSequenceSlotCount,
    interiorSequenceGapCount,
    outOfOrderReceivedDatagramCount,
    fecRecoveredReceivedDatagramCount: fecRecoveredReceivedDatagrams.size,
    fecRecoveredAppliedDatagramCount: fecRecoveredAppliedDatagrams.size,
    fecRecoveredVisualAppliedDatagramCount: fecRecoveredVisualAppliedDatagrams.size,
    interiorSequenceGapPercent:
      observedSequenceSlotCount === 0
        ? null
        : (interiorSequenceGapCount * 100) / observedSequenceSlotCount,
    snapshotReceivedCount: receivedSnapshotFrames.size,
    snapshotAppliedCount: appliedSnapshotFrames.size,
    snapshotReceivedChunkCount: receivedSnapshotChunks.size,
    snapshotAppliedChunkCount: appliedSnapshotChunks.size,
    resyncRequestCount,
    resyncAlreadyPendingCount,
    repairTargetSatisfiedCommitCount,
    repairDeadlineExpiredCommitCount,
  };
}

/** Forward distance over the display sequence domain, whose zero value is reserved. */
function nonzeroSerialDistance(newer: number, older: number): number {
  const rawDistance = (newer - older) >>> 0;
  return newer < older ? rawDistance - 1 : rawDistance;
}

export interface BoundedReport {
  readonly report: TerminalLatencyReport;
  readonly sampleRetention: {
    readonly strategy: 'head_tail';
    readonly total: number;
    readonly retained: number;
    readonly limit: number;
    readonly truncated: boolean;
  };
}

/**
 * Fixed-capacity tail storage with O(1) writes. It is used for diagnostics so
 * a noisy browser or a long soak cannot turn artifact collection into the
 * source of a memory or latency regression.
 */
export class BoundedTailBuffer<T> {
  readonly #capacity: number;
  readonly #storage: T[];
  #start = 0;
  #count = 0;
  #droppedCount = 0;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError(`BoundedTailBuffer capacity must be a positive integer: ${capacity}`);
    }
    this.#capacity = capacity;
    this.#storage = new Array<T>(capacity);
  }

  get count(): number {
    return this.#count;
  }

  get droppedCount(): number {
    return this.#droppedCount;
  }

  push(value: T): void {
    if (this.#count < this.#capacity) {
      this.#storage[(this.#start + this.#count) % this.#capacity] = value;
      this.#count += 1;
      return;
    }
    this.#storage[this.#start] = value;
    this.#start = (this.#start + 1) % this.#capacity;
    this.#droppedCount += 1;
  }

  values(): T[] {
    if (this.#count === 0) return [];
    const tailLength = Math.min(this.#count, this.#capacity - this.#start);
    return this.#storage
      .slice(this.#start, this.#start + tailLength)
      .concat(this.#storage.slice(0, this.#count - tailLength));
  }
}

/**
 * Opt the page into browser telemetry before the app boots.
 *
 * Profiling is opt-in and off by default. `createAppController` seeds its
 * `telemetryEnabled` signal from this key at boot and only constructs the
 * profiling worker for a session when it is on, and that worker is what owns
 * `__merkurPerfDump` — the drain for the shared-memory perf rings both other
 * workers write to. Left off, the workers latch `perfEnabled: false`, nothing
 * is ever written, and every telemetry assertion reads an empty trace from the
 * injected fallback recorder rather than failing on a missing worker.
 *
 * The key is spelled out rather than imported because this runs in the page;
 * `telemetry-preference.test.ts` repeats it for the same reason.
 *
 * Keep this function self-contained. Playwright serializes it and runs it in
 * the page with `addInitScript`, where module-scope bindings do not exist.
 */
export function enableE2ETelemetryPreference(): void {
  try {
    localStorage.setItem('merkur:telemetry-enabled', 'true');
  } catch {
    // An opaque origin (a page still on about:blank) has no storage to seed.
    // The next navigation runs this again, which is the one that matters.
  }
}

/**
 * Keep this function self-contained. Playwright serializes it and runs it in
 * the page with `addInitScript`, where module-scope bindings do not exist.
 *
 * This installs the RECORDER only, which is what makes each worker latch
 * `perfEnabled` and write into the rings. Starting the telemetry worker that
 * DRAINS them is the separate stored preference, seeded by
 * `enableE2ETelemetryPreference` above — a page with one and not the other
 * writes into rings nobody reads and reads back an empty trace.
 */
export function installE2ETerminalPerfRecorder(): void {
  const recorderSchemaVersion = 3;
  const maxEvents = 120 * 10 * 60 * 8;
  const storage: unknown[] = [];
  let start = 0;
  let count = 0;
  let totalRecordedCount = 0;
  let overwriteCount = 0;
  const nowMs = (): number => {
    if (
      typeof performance !== 'undefined' &&
      Number.isFinite(performance.timeOrigin) &&
      Number.isFinite(performance.now())
    ) {
      return performance.timeOrigin + performance.now();
    }
    return Date.now();
  };
  const installedAtMs = nowMs();
  let resetAtMs = installedAtMs;
  let firstRecordedAtMs: number | null = null;
  let lastRecordedAtMs: number | null = null;

  const eventAtMs = (value: unknown): number | null => {
    if (typeof value !== 'object' || value === null) return null;
    const atMs = (value as { atMs?: unknown }).atMs;
    return typeof atMs === 'number' && Number.isFinite(atMs) ? atMs : null;
  };
  const snapshotEvents = (): unknown[] => {
    if (count === 0) return [];
    const tailLength = Math.min(count, maxEvents - start);
    return storage.slice(start, start + tailLength).concat(storage.slice(0, count - tailLength));
  };
  const metadata = (): {
    available: true;
    schemaVersion: number;
    capacity: number;
    installedAtMs: number;
    resetAtMs: number;
    capturedAtMs: number;
    firstRecordedAtMs: number | null;
    lastRecordedAtMs: number | null;
    oldestRetainedEventAtMs: number | null;
    newestRetainedEventAtMs: number | null;
    totalRecordedCount: number;
    retainedEventCount: number;
    overwriteCount: number;
    droppedEventCount: number;
  } => {
    const oldest = count === 0 ? undefined : storage[start];
    const newest = count === 0 ? undefined : storage[(start + count - 1) % maxEvents];
    return {
      available: true,
      schemaVersion: recorderSchemaVersion,
      capacity: maxEvents,
      installedAtMs,
      resetAtMs,
      capturedAtMs: nowMs(),
      firstRecordedAtMs,
      lastRecordedAtMs,
      oldestRetainedEventAtMs: eventAtMs(oldest),
      newestRetainedEventAtMs: eventAtMs(newest),
      totalRecordedCount,
      retainedEventCount: count,
      overwriteCount,
      droppedEventCount: overwriteCount,
    };
  };

  (
    globalThis as unknown as {
      __merkurTerminalPerf?: {
        readonly events: unknown[];
        readonly metadata: ReturnType<typeof metadata>;
        record(event: unknown): void;
        reset(): void;
        report(): null;
        snapshot(): {
          events: unknown[];
          recorder: ReturnType<typeof metadata>;
        };
      };
    }
  ).__merkurTerminalPerf = {
    get events(): unknown[] {
      return snapshotEvents();
    },
    get metadata(): ReturnType<typeof metadata> {
      return metadata();
    },
    record(event): void {
      const recordedAtMs = nowMs();
      firstRecordedAtMs ??= recordedAtMs;
      lastRecordedAtMs = recordedAtMs;
      totalRecordedCount += 1;
      if (count < maxEvents) {
        storage[(start + count) % maxEvents] = event;
        count += 1;
      } else {
        storage[start] = event;
        start = (start + 1) % maxEvents;
        overwriteCount += 1;
      }
    },
    reset(): void {
      (
        globalThis as unknown as {
          __merkurTerminalPerfResetObservation?: () => number;
        }
      ).__merkurTerminalPerfResetObservation?.();
      storage.length = 0;
      start = 0;
      count = 0;
      totalRecordedCount = 0;
      overwriteCount = 0;
      resetAtMs = nowMs();
      firstRecordedAtMs = null;
      lastRecordedAtMs = null;
    },
    report(): null {
      return null;
    },
    snapshot(): {
      events: unknown[];
      recorder: ReturnType<typeof metadata>;
    } {
      return { events: snapshotEvents(), recorder: metadata() };
    },
  };
}

export function collectPredictionDiagnostics(
  events: readonly unknown[],
  retentionLimit = MAX_DIAGNOSTIC_EVENTS_PER_KIND,
): PredictionDiagnostics {
  const countsByKind = new Map<string, number>();
  const queuedEvents = new BoundedTailBuffer<Readonly<Record<string, unknown>>>(retentionLimit);
  const appliedEvents = new BoundedTailBuffer<Readonly<Record<string, unknown>>>(retentionLimit);
  const gates = new BoundedTailBuffer<Readonly<Record<string, unknown>>>(retentionLimit);
  const suppressions = new BoundedTailBuffer<Readonly<Record<string, unknown>>>(retentionLimit);
  const renderedFrames = new BoundedTailBuffer<Readonly<Record<string, unknown>>>(retentionLimit);
  const submittedFrames = new BoundedTailBuffer<Readonly<Record<string, unknown>>>(retentionLimit);
  const completedFrames = new BoundedTailBuffer<Readonly<Record<string, unknown>>>(retentionLimit);
  let unclassifiedEvents = 0;
  let untrackedKindEvents = 0;
  let queued = 0;
  let applied = 0;
  let submitted = 0;
  let completed = 0;

  for (const event of events) {
    if (!isRecord(event) || typeof event.kind !== 'string') {
      unclassifiedEvents += 1;
      continue;
    }
    const kind = event.kind;
    const currentKindCount = countsByKind.get(kind);
    if (currentKindCount !== undefined) {
      countsByKind.set(kind, currentKindCount + 1);
    } else if (countsByKind.size < MAX_DIAGNOSTIC_EVENT_KINDS) {
      countsByKind.set(kind, 1);
    } else {
      untrackedKindEvents += 1;
    }
    if (kind === 'prediction_queued') {
      queued += 1;
      queuedEvents.push(event);
    } else if (kind === 'prediction_applied') {
      applied += 1;
      appliedEvents.push(event);
    } else if (kind === 'prediction_gate') {
      gates.push(event);
    } else if (kind === 'prediction_suppressed') {
      suppressions.push(event);
    } else if (kind === 'render_end') {
      renderedFrames.push(event);
      if (
        typeof event.predictionInputSeq === 'number' &&
        Number.isFinite(event.predictionInputSeq) &&
        event.predictionInputSeq > 0
      ) {
        submitted += 1;
        submittedFrames.push(event);
      }
    } else if (kind === 'frame_complete') {
      completed += 1;
      completedFrames.push(event);
    }
  }

  return {
    eventCountsByKind: Object.freeze(
      Object.fromEntries(
        [...countsByKind.entries()].sort(([left], [right]) => left.localeCompare(right)),
      ),
    ),
    unclassifiedEvents,
    untrackedKindEvents,
    perKindRetentionLimit: retentionLimit,
    queued,
    applied,
    submitted,
    completed,
    queuedEvents: Object.freeze(queuedEvents.values()),
    appliedEvents: Object.freeze(appliedEvents.values()),
    gates: Object.freeze(gates.values()),
    suppressions: Object.freeze(suppressions.values()),
    renderedFrames: Object.freeze(renderedFrames.values()),
    submittedFrames: Object.freeze(submittedFrames.values()),
    completedFrames: Object.freeze(completedFrames.values()),
  };
}

export function boundTerminalLatencyReport(
  report: TerminalLatencyReport,
  limit = MAX_SUMMARY_REPORT_SAMPLES,
): BoundedReport {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new RangeError(`Report sample limit must be a positive integer: ${limit}`);
  }
  const total = report.samples.length;
  const samples =
    total <= limit
      ? [...report.samples]
      : [
          ...report.samples.slice(0, Math.ceil(limit / 2)),
          ...report.samples.slice(total - Math.floor(limit / 2)),
        ];
  return {
    report: { ...report, samples },
    sampleRetention: {
      strategy: 'head_tail',
      total,
      retained: samples.length,
      limit,
      truncated: total > limit,
    },
  };
}

export function freezeTerminalPerfSnapshot(
  events: TerminalPerfEvent[],
  report: TerminalLatencyReport,
  recorder: TerminalPerfRecorderMetadata,
): FrozenTerminalPerfSnapshot {
  const seen = new WeakSet<object>();
  const frozenEvents = Object.freeze(events.map((event) => deepFreeze(event, seen)));
  // Freeze a detached copy so the cached assertion snapshot cannot drift.
  const frozenReport = deepFreeze(
    {
      ...report,
      samples: report.samples.map((sample) => ({ ...sample })),
    },
    seen,
  ) as TerminalLatencyReport;
  return deepFreeze(
    {
      events: frozenEvents,
      report: frozenReport,
      recorder: { ...recorder },
    },
    seen,
  );
}

export function validateRecorderMetadata(metadata: TerminalPerfRecorderMetadata): string[] {
  if (!metadata.available) return ['terminal performance recorder metadata is unavailable'];
  const problems: string[] = [];
  if (metadata.schemaVersion !== TERMINAL_PERF_RECORDER_SCHEMA_VERSION) {
    problems.push(
      `terminal recorder schema ${String(metadata.schemaVersion)} does not match ${TERMINAL_PERF_RECORDER_SCHEMA_VERSION}`,
    );
  }
  if (
    metadata.capacity === null ||
    !Number.isSafeInteger(metadata.capacity) ||
    metadata.capacity <= 0
  ) {
    problems.push(`terminal recorder capacity is invalid: ${String(metadata.capacity)}`);
  } else if (metadata.retainedEventCount > metadata.capacity) {
    problems.push(
      `terminal recorder retained ${metadata.retainedEventCount} events above capacity ${metadata.capacity}`,
    );
  }
  if (metadata.totalRecordedCount < metadata.retainedEventCount) {
    problems.push(
      `terminal recorder total ${metadata.totalRecordedCount} is below retained ${metadata.retainedEventCount}`,
    );
  }
  if (metadata.overwriteCount > metadata.droppedEventCount) {
    problems.push(
      `terminal recorder overwrite count ${metadata.overwriteCount} exceeds total dropped ${metadata.droppedEventCount}`,
    );
  }
  const expectedDroppedEventCount = metadata.totalRecordedCount - metadata.retainedEventCount;
  if (expectedDroppedEventCount >= 0 && metadata.droppedEventCount !== expectedDroppedEventCount) {
    problems.push(
      `terminal recorder dropped count ${metadata.droppedEventCount} does not match total-retained ${expectedDroppedEventCount}`,
    );
  }
  if (metadata.droppedEventCount > 0) {
    problems.push(
      `terminal recorder truncated ${metadata.droppedEventCount} event(s) at capacity ${String(metadata.capacity)}`,
    );
  }
  return problems;
}

export function unavailableRecorderMetadata(retainedEventCount = 0): TerminalPerfRecorderMetadata {
  return {
    available: false,
    schemaVersion: null,
    capacity: null,
    installedAtMs: null,
    resetAtMs: null,
    capturedAtMs: null,
    firstRecordedAtMs: null,
    lastRecordedAtMs: null,
    oldestRetainedEventAtMs: null,
    newestRetainedEventAtMs: null,
    totalRecordedCount: retainedEventCount,
    retainedEventCount,
    overwriteCount: 0,
    droppedEventCount: 0,
  };
}

export function normalizeRecorderMetadata(
  value: unknown,
  retainedEventCount: number,
): TerminalPerfRecorderMetadata {
  if (!isRecord(value)) return unavailableRecorderMetadata(retainedEventCount);
  return {
    available: value.available === true,
    schemaVersion: optionalNonNegativeInteger(value.schemaVersion),
    capacity: optionalNonNegativeInteger(value.capacity),
    installedAtMs: optionalFiniteNumber(value.installedAtMs),
    resetAtMs: optionalFiniteNumber(value.resetAtMs),
    capturedAtMs: optionalFiniteNumber(value.capturedAtMs),
    firstRecordedAtMs: optionalFiniteNumber(value.firstRecordedAtMs),
    lastRecordedAtMs: optionalFiniteNumber(value.lastRecordedAtMs),
    oldestRetainedEventAtMs: optionalFiniteNumber(value.oldestRetainedEventAtMs),
    newestRetainedEventAtMs: optionalFiniteNumber(value.newestRetainedEventAtMs),
    totalRecordedCount: nonNegativeInteger(value.totalRecordedCount, retainedEventCount),
    retainedEventCount: nonNegativeInteger(value.retainedEventCount, retainedEventCount),
    overwriteCount: nonNegativeInteger(value.overwriteCount, 0),
    droppedEventCount: nonNegativeInteger(value.droppedEventCount, 0),
  };
}

function checkedSafeSum(left: number, right: number, label: string): number {
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) {
    throw new Error(`telemetry observation ${label} count exceeds the safe-integer range`);
  }
  return sum;
}

export async function writeGzipJsonArray(path: string, values: readonly unknown[]): Promise<void> {
  await pipeline(
    Readable.from(jsonArrayChunks(values)),
    createGzip({ level: zlibConstants.Z_BEST_SPEED }),
    createWriteStream(path),
  );
}

function* jsonArrayChunks(values: readonly unknown[]): Generator<string> {
  yield '[';
  for (let index = 0; index < values.length; index += 1) {
    if (index > 0) yield ',';
    const serialized = JSON.stringify(values[index]);
    yield serialized ?? 'null';
  }
  yield ']\n';
}

function deepFreeze<T>(value: T, seen: WeakSet<object>): T {
  if (typeof value !== 'object' || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function optionalFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function optionalNonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function nonNegativeInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}
