import type {
  TerminalPresentationMeasurementPhase,
  TerminalPresentationMeasurementPurpose,
} from '../../../apps/web/src/perf/terminal-latency';

/** A graphics tile job counter that must reach `atLeast` before a window opens. */
export interface GraphicsAssetTarget {
  readonly phase: 'firstByte' | 'fin' | 'consumed';
  readonly atLeast: number;
  /** `failed` before the arming input; any rise refuses to open the window. */
  readonly failedBaseline: number;
}

export interface PresentationMeasurementBoundaryPageArgs {
  readonly id: number;
  readonly boundaryPhase: TerminalPresentationMeasurementPhase;
  readonly boundaryPurpose: TerminalPresentationMeasurementPurpose;
  /** Open only after this transition, observed in the same page task. */
  readonly afterGraphicsAsset?: GraphicsAssetTarget & { readonly livenessMs: number };
  /** Return the drain status's input frontier as the window opens. */
  readonly timedInput?: true;
}

export interface PresentationMeasurementBoundaryPageResult {
  /** The terminal worker's display-ring boundary snapshot, unvalidated. */
  readonly ringBoundary: unknown;
  /**
   * With `timedInput`: the observation epoch and input frontier of the last
   * drain status read before the boundary, unvalidated; otherwise null.
   */
  readonly timedInputBaseline: unknown;
}

/**
 * Keep this function self-contained: Playwright serializes it into the page.
 * The terminal-worker response is a WorkerEvent and therefore carries its own
 * `kind` and request correlation id; neither is part of the retained harness
 * boundary event.
 *
 * With `afterGraphicsAsset`, the page reads the telemetry worker back to back
 * (each read drains the rings) and opens the window as soon as the counter
 * reaches its target: no harness round trip stands between the transition and
 * the boundary. The liveness bound only ends a wait that can never succeed.
 *
 * With `timedInput`, the input frontier of the last drain status read becomes
 * the window's baseline: the asset wait's final read, or one read of its own.
 * Either way it precedes the boundary, and the harness types the timed input
 * only after the boundary returns.
 */
export async function recordPresentationMeasurementBoundaryInPage({
  id,
  boundaryPhase,
  boundaryPurpose,
  afterGraphicsAsset,
  timedInput,
}: PresentationMeasurementBoundaryPageArgs): Promise<PresentationMeasurementBoundaryPageResult> {
  const recorder = (
    globalThis as unknown as {
      __merkurTerminalPerf?: {
        record(event: unknown): void;
      };
    }
  ).__merkurTerminalPerf;
  if (recorder === undefined) throw new Error('terminal performance recorder is unavailable');
  const readDrainStatus = (
    globalThis as unknown as {
      __merkurPerfDrainStatus?: () => Promise<{
        readonly activity?: {
          readonly observationEpoch?: unknown;
          readonly graphicsAsset?: Readonly<Record<string, number>>;
          readonly input?: unknown;
        };
      }>;
    }
  ).__merkurPerfDrainStatus;
  let lastStatus: Awaited<ReturnType<NonNullable<typeof readDrainStatus>>> | null = null;
  if (afterGraphicsAsset !== undefined) {
    if (typeof readDrainStatus !== 'function') {
      throw new Error('telemetry drain status is unavailable');
    }
    const { phase, atLeast, failedBaseline, livenessMs } = afterGraphicsAsset;
    const deadline = performance.now() + livenessMs;
    for (;;) {
      lastStatus = await readDrainStatus();
      const graphics = lastStatus.activity?.graphicsAsset;
      if (graphics === undefined)
        throw new Error('drain status carries no graphics asset counters');
      if ((graphics.failed ?? 0) > failedBaseline) {
        throw new Error(
          `a graphics asset job failed before the window: ${JSON.stringify(graphics)}`,
        );
      }
      if ((graphics[phase] ?? 0) >= atLeast) break;
      if (performance.now() >= deadline) {
        throw new Error(
          `graphics asset ${phase} never reached ${atLeast}: ${JSON.stringify(graphics)}`,
        );
      }
    }
  }
  let timedInputBaseline: unknown = null;
  if (timedInput === true) {
    if (typeof readDrainStatus !== 'function') {
      throw new Error('telemetry drain status is unavailable');
    }
    lastStatus ??= await readDrainStatus();
    timedInputBaseline = {
      observationEpoch: lastStatus.activity?.observationEpoch,
      input: lastStatus.activity?.input,
    };
  }
  const readRingBoundary = (
    globalThis as unknown as {
      __merkurTerminalPerfReadDisplayRingBoundary?: () => Promise<unknown>;
    }
  ).__merkurTerminalPerfReadDisplayRingBoundary;
  if (typeof readRingBoundary !== 'function') {
    throw new Error('terminal display-ring boundary reader is unavailable');
  }
  const ringBoundary = await readRingBoundary();
  if (typeof ringBoundary !== 'object' || ringBoundary === null) {
    throw new Error('terminal display-ring boundary snapshot is unavailable');
  }
  const boundary = ringBoundary as {
    readonly observationEpoch?: unknown;
    readonly sessionEpoch?: unknown;
    readonly atMs?: unknown;
    readonly ringDroppedTotal?: unknown;
  };
  if (typeof boundary.atMs !== 'number' || !Number.isFinite(boundary.atMs)) {
    throw new Error('terminal display-ring boundary timestamp is invalid');
  }
  recorder.record({
    kind: 'presentation_measurement_boundary',
    atMs: boundary.atMs,
    measurementId: id,
    phase: boundaryPhase,
    purpose: boundaryPurpose,
  });
  recorder.record({
    kind: 'display_ring_measurement_boundary',
    atMs: boundary.atMs,
    measurementId: id,
    phase: boundaryPhase,
    observationEpoch: boundary.observationEpoch,
    sessionEpoch: boundary.sessionEpoch,
    ringDroppedTotal: boundary.ringDroppedTotal,
  });
  return { ringBoundary, timedInputBaseline };
}
