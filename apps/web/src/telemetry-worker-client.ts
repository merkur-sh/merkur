import { createLogger } from '@merkur/logger';

import {
  onTerminalPerfObservationReset,
  type TerminalPerfEvent,
  terminalPerfNowMs,
  terminalPerfObservationEpoch,
} from './perf/terminal-latency';
import type {
  TelemetryObservationCompletion,
  TelemetryObservationTraceCapture,
  TelemetryWorkerCommand,
  TelemetryWorkerDrainStatus,
  TelemetryWorkerEvent,
  TelemetryWorkerStats,
} from './telemetry-worker-protocol';
import type { TerminalRingBundle } from './terminal/ring-bundle';

/**
 * Owns the telemetry worker.
 *
 * Thin by design: everything expensive happens inside the worker, and the only
 * traffic across this boundary is lifecycle plus an occasional stats update.
 * The profiling records themselves never come this way — they go from producer
 * to worker through shared memory, which is the whole point.
 */
export interface TelemetryWorkerClient {
  /** Refresh the bearer token as the session rotates it. */
  setAccessToken(accessToken: string): void;
  /** Latest stats the worker reported, or null before its first tick. */
  stats(): TelemetryWorkerStats | null;
  /**
   * Retained decoded trace, for local diagnosis. Deliberately a request rather
   * than a running mirror: keeping a copy on the main thread would undo the
   * reason the worker exists.
   */
  dump(): Promise<{
    events: readonly TerminalPerfEvent[];
    stats: TelemetryWorkerStats;
    capture: TelemetryObservationTraceCapture;
  }>;
  /** One-use pre-boundary fence for an exact observation reset. */
  prepareObservation(): Promise<number>;
  /** Matching worker ACK after the recorder reset installed its epoch/boundary. */
  observationReady(): Promise<TelemetryObservationCompletion>;
  /** Fixed-size incremental presentation status; never materializes the retained trace. */
  drainStatus(): Promise<TelemetryWorkerDrainStatus>;
  stop(): void;
}

export interface TelemetryWorkerClientOptions {
  readonly rings: TerminalRingBundle;
  readonly origin: string;
  readonly accessToken: string;
  readonly byteBudget: number;
  /** Publish pending browser observations before the worker drains the shared rings. */
  readonly flushMainThreadObservations: () => void;
  /** Called on every worker tick, so preferences can show live burn. */
  readonly onStats?: (stats: TelemetryWorkerStats) => void;
  /**
   * A worker crash, classified and counted by the caller.
   *
   * A worker's `error` event fires on the `Worker` object, never on `window`, so the global
   * handlers cannot see it. Without this hook a crashed worker is invisible to everything
   * but the console.
   */
  readonly onWorkerError?: (error: unknown) => void;
}

declare global {
  /**
   * Page-level access to the retained profiling trace.
   *
   * Installed while the telemetry worker is alive. Exists because the trace no
   * longer lives on the main thread at all — Playwright and a browser console
   * both need a way to ask the worker for it, and neither can hold a ring
   * reader. Async by necessity: the answer comes from another thread.
   */
  var __merkurPerfDump:
    | (() => Promise<{
        events: readonly TerminalPerfEvent[];
        stats: TelemetryWorkerStats;
        capture: TelemetryObservationTraceCapture;
      }>)
    | undefined;
  var __merkurPerfDrainStatus: (() => Promise<TelemetryWorkerDrainStatus>) | undefined;
  var __merkurPerfPrepareObservation: (() => Promise<number>) | undefined;
  var __merkurPerfObservationReady: (() => Promise<TelemetryObservationCompletion>) | undefined;
}

const logger = createLogger('web-telemetry-worker-client');

interface ActiveTelemetryObservationIdentity {
  readonly preparationRequestId: number;
  readonly observationEpoch: number;
  readonly observationStartedAtMs: number;
}

let activeTelemetryObservationIdentity: ActiveTelemetryObservationIdentity = {
  preparationRequestId: 0,
  observationEpoch: terminalPerfObservationEpoch(),
  observationStartedAtMs: 0,
};

export function createTelemetryWorkerClient({
  rings,
  origin,
  accessToken,
  byteBudget,
  flushMainThreadObservations,
  onStats,
  onWorkerError,
}: TelemetryWorkerClientOptions): TelemetryWorkerClient {
  // Same `new URL(..., import.meta.url)` form the other two workers use, so Vite
  // fingerprints it and pins the hashed URL into the main bundle.
  const worker = new Worker(new URL('./telemetry-worker.ts', import.meta.url), {
    type: 'module',
  });

  let latest: TelemetryWorkerStats | null = null;
  let pendingDump: {
    readonly requestId: number;
    readonly resolve: (value: {
      events: readonly TerminalPerfEvent[];
      stats: TelemetryWorkerStats;
      capture: TelemetryObservationTraceCapture;
    }) => void;
    readonly reject: (reason: Error) => void;
  } | null = null;
  let pendingDumpPromise: Promise<{
    events: readonly TerminalPerfEvent[];
    stats: TelemetryWorkerStats;
    capture: TelemetryObservationTraceCapture;
  }> | null = null;
  let nextDumpRequestId = 0;
  let nextDrainStatusRequestId = 0;
  let pendingDrainStatus: {
    readonly requestId: number;
    readonly resolve: (value: TelemetryWorkerDrainStatus) => void;
    readonly reject: (reason: Error) => void;
  } | null = null;
  let nextObservationPreparationRequestId = 0;
  let pendingObservationPreparation: {
    readonly requestId: number;
    readonly resolve: (requestId: number) => void;
    readonly reject: (reason: Error) => void;
  } | null = null;
  let preparedObservationRequestId: number | null = null;
  let observationTransitionActive = false;
  let latestObservationCompletion: Promise<TelemetryObservationCompletion> | null = null;
  let pendingObservationCompletion: {
    readonly preparationRequestId: number;
    readonly observationEpoch: number;
    readonly observationStartedAtMs: number;
    readonly resolve: (value: TelemetryObservationCompletion) => void;
    readonly reject: (reason: Error) => void;
  } | null = null;
  let failure: string | null = null;
  let stopped = false;

  worker.onmessage = (event: MessageEvent<TelemetryWorkerEvent>): void => {
    latest = event.data.stats;
    onStats?.(event.data.stats);
    if (event.data.kind === 'observation_prepared') {
      const settle = pendingObservationPreparation;
      if (settle === null || settle.requestId !== event.data.requestId) return;
      pendingObservationPreparation = null;
      preparedObservationRequestId = event.data.requestId;
      settle.resolve(event.data.requestId);
    } else if (event.data.kind === 'observation_complete') {
      const settle = pendingObservationCompletion;
      if (settle === null) return;
      pendingObservationCompletion = null;
      if (
        event.data.preparationRequestId !== settle.preparationRequestId ||
        event.data.observationEpoch !== settle.observationEpoch ||
        event.data.observationStartedAtMs !== settle.observationStartedAtMs ||
        !observationCaptureMatches(event.data.capture, settle)
      ) {
        settle.reject(new Error('Telemetry worker returned a mismatched observation completion'));
        return;
      }
      if (!event.data.capture.complete) {
        settle.reject(new Error('Telemetry worker could not establish an exact observation'));
        return;
      }
      activeTelemetryObservationIdentity = {
        preparationRequestId: event.data.preparationRequestId,
        observationEpoch: event.data.observationEpoch,
        observationStartedAtMs: event.data.observationStartedAtMs,
      };
      observationTransitionActive = false;
      settle.resolve({
        preparationRequestId: event.data.preparationRequestId,
        observationEpoch: event.data.observationEpoch,
        observationStartedAtMs: event.data.observationStartedAtMs,
        capture: event.data.capture,
      });
    } else if (event.data.kind === 'drain_status') {
      const settle = pendingDrainStatus;
      if (settle === null || settle.requestId !== event.data.requestId) return;
      pendingDrainStatus = null;
      settle.resolve({ activity: event.data.status, stats: event.data.stats });
    } else if (event.data.kind === 'dump') {
      const settle = pendingDump;
      if (settle === null || settle.requestId !== event.data.requestId) return;
      pendingDump = null;
      pendingDumpPromise = null;
      settle.resolve({
        events: event.data.events,
        stats: event.data.stats,
        capture: event.data.capture,
      });
    }
  };

  /**
   * Profiling is optional, so a dead telemetry worker must not disturb the
   * session — but it must never be silent either. Without these handlers an
   * uncaught worker error killed the drain on its first tick, and the only
   * symptom was a `dump()` that stayed pending forever with nothing logged.
   */
  function failWorker(reason: string): void {
    failure ??= reason;
    logger.error(reason);
    const settle = pendingDump;
    pendingDump = null;
    pendingDumpPromise = null;
    settle?.reject(new Error(reason));
    const drainSettle = pendingDrainStatus;
    pendingDrainStatus = null;
    drainSettle?.reject(new Error(reason));
    const prepareSettle = pendingObservationPreparation;
    pendingObservationPreparation = null;
    prepareSettle?.reject(new Error(reason));
    const observationSettle = pendingObservationCompletion;
    pendingObservationCompletion = null;
    observationTransitionActive = false;
    observationSettle?.reject(new Error(reason));
  }

  worker.onerror = (event: ErrorEvent): void => {
    event.preventDefault();
    // Reported before failing: a worker error event never reaches the window handlers, so
    // without this a crashed worker is invisible to everything but the console.
    onWorkerError?.(event.error ?? new Error(event.message));
    failWorker(`Telemetry worker crashed: ${event.message || 'unknown worker error'}`);
  };
  worker.onmessageerror = (): void => {
    failWorker('Telemetry worker failed to deserialize a message');
  };

  function post(command: TelemetryWorkerCommand): void {
    worker.postMessage(command);
  }

  const currentObservationEpoch = terminalPerfObservationEpoch();
  if (activeTelemetryObservationIdentity.observationEpoch !== currentObservationEpoch) {
    activeTelemetryObservationIdentity = {
      preparationRequestId: 0,
      observationEpoch: currentObservationEpoch,
      observationStartedAtMs: 0,
    };
  }
  post({
    kind: 'init',
    terminalPerfRing: rings.terminalPerfRing,
    transportPerfRing: rings.transportPerfRing,
    mainPerfRing: rings.mainPerfRing,
    perfStrings: rings.perfStrings,
    origin,
    accessToken,
    byteBudget,
    ...activeTelemetryObservationIdentity,
  });
  const stopObservationReset = onTerminalPerfObservationReset((observationEpoch) => {
    const observationStartedAtMs = terminalPerfNowMs();
    const preparationRequestId = preparedObservationRequestId ?? 0;
    preparedObservationRequestId = null;
    pendingObservationCompletion?.reject(
      new Error('Superseded by a newer telemetry observation reset'),
    );
    observationTransitionActive = true;
    latestObservationCompletion = new Promise((resolve, reject) => {
      pendingObservationCompletion = {
        preparationRequestId,
        observationEpoch,
        observationStartedAtMs,
        resolve,
        reject,
      };
    });
    // Recorder reset is also a public diagnostic operation. If nobody awaits
    // the explicit readiness hook, keep a failed exact-boundary ACK from
    // becoming an unrelated global unhandled-rejection signal; the next dump
    // remains fail-closed through its capture metadata.
    void latestObservationCompletion.catch(() => {});
    post({
      kind: 'observation',
      preparationRequestId,
      observationEpoch,
      observationStartedAtMs,
    });
  });

  const client: TelemetryWorkerClient = {
    setAccessToken(next: string): void {
      post({ kind: 'token', accessToken: next });
    },
    stats(): TelemetryWorkerStats | null {
      return latest;
    },
    dump(): Promise<{
      events: readonly TerminalPerfEvent[];
      stats: TelemetryWorkerStats;
      capture: TelemetryObservationTraceCapture;
    }> {
      if (failure !== null) return Promise.reject(new Error(failure));
      if (observationTransitionActive) {
        return Promise.reject(new Error('Telemetry observation boundary is not complete'));
      }
      if (pendingDumpPromise !== null) return pendingDumpPromise;
      flushMainThreadObservations();
      pendingDumpPromise = new Promise((resolve, reject) => {
        nextDumpRequestId = (nextDumpRequestId + 1) >>> 0 || 1;
        pendingDump = { requestId: nextDumpRequestId, resolve, reject };
        post({ kind: 'dump', requestId: nextDumpRequestId });
      });
      return pendingDumpPromise;
    },
    drainStatus(): Promise<TelemetryWorkerDrainStatus> {
      if (failure !== null) return Promise.reject(new Error(failure));
      if (observationTransitionActive) {
        return Promise.reject(new Error('Telemetry observation boundary is not complete'));
      }
      return new Promise((resolve, reject) => {
        pendingDrainStatus?.reject(new Error('Superseded by a newer telemetry drain status'));
        nextDrainStatusRequestId = (nextDrainStatusRequestId + 1) >>> 0 || 1;
        pendingDrainStatus = { requestId: nextDrainStatusRequestId, resolve, reject };
        post({ kind: 'drain_status', requestId: nextDrainStatusRequestId });
      });
    },
    prepareObservation(): Promise<number> {
      if (failure !== null) return Promise.reject(new Error(failure));
      // Flush buffered PerformanceObserver records before PREPARE so the
      // worker's drain includes them in the retired observation. A flush after
      // PREPARED would conservatively charge old callback work to the new one.
      flushMainThreadObservations();
      const dumpSettle = pendingDump;
      pendingDump = null;
      pendingDumpPromise = null;
      dumpSettle?.reject(new Error('Superseded by a telemetry observation preparation'));
      const drainSettle = pendingDrainStatus;
      pendingDrainStatus = null;
      drainSettle?.reject(new Error('Superseded by a telemetry observation preparation'));
      pendingObservationPreparation?.reject(
        new Error('Superseded by a newer telemetry observation preparation'),
      );
      pendingObservationCompletion?.reject(
        new Error('Superseded by a newer telemetry observation preparation'),
      );
      pendingObservationCompletion = null;
      latestObservationCompletion = null;
      preparedObservationRequestId = null;
      observationTransitionActive = true;
      nextObservationPreparationRequestId = (nextObservationPreparationRequestId + 1) >>> 0 || 1;
      return new Promise((resolve, reject) => {
        pendingObservationPreparation = {
          requestId: nextObservationPreparationRequestId,
          resolve,
          reject,
        };
        post({
          kind: 'prepare_observation',
          requestId: nextObservationPreparationRequestId,
        });
      });
    },
    observationReady(): Promise<TelemetryObservationCompletion> {
      if (failure !== null) return Promise.reject(new Error(failure));
      return (
        latestObservationCompletion ??
        Promise.reject(new Error('No telemetry observation reset is awaiting completion'))
      );
    },
    stop(): void {
      if (stopped) return;
      flushMainThreadObservations();
      stopped = true;
      // Deliberately no `terminate()`. The worker drains and ships its tail
      // asynchronously and then closes itself; terminating here would kill that
      // final send mid-flight and lose the end of every profiled session.
      post({ kind: 'stop' });
      stopObservationReset();
      const settle = pendingDump;
      pendingDump = null;
      pendingDumpPromise = null;
      settle?.reject(new Error('Telemetry worker stopped before the dump completed'));
      const drainSettle = pendingDrainStatus;
      pendingDrainStatus = null;
      drainSettle?.reject(new Error('Telemetry worker stopped before drain status completed'));
      const prepareSettle = pendingObservationPreparation;
      pendingObservationPreparation = null;
      prepareSettle?.reject(
        new Error('Telemetry worker stopped before observation preparation completed'),
      );
      const observationSettle = pendingObservationCompletion;
      pendingObservationCompletion = null;
      observationTransitionActive = false;
      observationSettle?.reject(
        new Error('Telemetry worker stopped before observation completion'),
      );
      globalThis.__merkurPerfDump = undefined;
      globalThis.__merkurPerfDrainStatus = undefined;
      globalThis.__merkurPerfPrepareObservation = undefined;
      globalThis.__merkurPerfObservationReady = undefined;
    },
  };

  globalThis.__merkurPerfDump = () => client.dump();
  globalThis.__merkurPerfDrainStatus = () => client.drainStatus();
  globalThis.__merkurPerfPrepareObservation = () => client.prepareObservation();
  globalThis.__merkurPerfObservationReady = () => client.observationReady();
  return client;
}

function observationCaptureMatches(
  capture: TelemetryObservationTraceCapture,
  expected: {
    readonly preparationRequestId: number;
    readonly observationEpoch: number;
    readonly observationStartedAtMs: number;
  },
): boolean {
  return (
    capture.preparationRequestId === expected.preparationRequestId &&
    capture.observationEpoch === expected.observationEpoch &&
    capture.observationStartedAtMs === expected.observationStartedAtMs
  );
}
