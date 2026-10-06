import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { test as base, expect, type Page } from '@playwright/test';
import type {
  TelemetryGraphicsAssetStatus,
  TelemetryInputFrontierStatus,
} from '../../../apps/web/src/perf/telemetry-drain-status';
import {
  buildTerminalLatencyReport,
  type TerminalLatencyReport,
  type TerminalPerfEvent,
  type TerminalPresentationMeasurementPhase,
  type TerminalPresentationMeasurementPurpose,
  type TerminalStartupAttemptReport,
} from '../../../apps/web/src/perf/terminal-latency';
import {
  isTelemetryObservationTraceCapture,
  type TelemetryObservationCompletion,
  type TelemetryObservationTraceCapture,
  type TelemetryWorkerDrainStatus,
} from '../../../apps/web/src/telemetry-worker-protocol';
import {
  type PerfDisplayRingBoundarySnapshot,
  type PerfGridConvergenceResult,
  TERMINAL_PERF_FORCE_RESYNC_EVENT,
} from '../../../apps/web/src/terminal-worker-protocol';
import {
  requestProxyChunkedReply,
  requestProxyControl,
  requestProxyImpairmentStats,
} from '../../../scripts/edge-network-control';
import {
  PROXY_MAX_TRACE_MARK_KEY,
  type ProxyImpairmentStats,
  type ProxySettleStatus,
  parseProxyMarkStatus,
  parseProxySettleStatus,
} from '../../../scripts/edge-network-stats';
import { gridConvergenceFailureDetail } from './grid-convergence-failure';
import {
  type GraphicsAssetTarget,
  recordPresentationMeasurementBoundaryInPage,
} from './presentation-measurement-boundary';
import {
  presentationDrainQuietMs,
  type TimedInputBaseline,
  type TimedInputClose,
  waitForPresentationDrain,
} from './presentation-measurement-settle';
import {
  BoundedTailBuffer,
  boundTerminalLatencyReport,
  buildTelemetryObservationRecorderMetadata,
  collectApplicationDisplayOutcome,
  collectPredictionDiagnostics,
  enableE2ETelemetryPreference,
  freezeTerminalPerfSnapshot,
  installE2ETerminalPerfRecorder,
  MAX_SUMMARY_REPORT_SAMPLES,
  normalizeRecorderMetadata,
  TERMINAL_PERF_ARTIFACT_SCHEMA_VERSION,
  TERMINAL_PERF_HARNESS_BOUNDARY_KINDS,
  type TerminalPerfRecorderCapture,
  type TerminalPerfRecorderMetadata,
  unavailableRecorderMetadata,
  validateRecorderMetadata,
  writeGzipJsonArray,
} from './terminal-perf-artifacts';

export interface TerminalPerfSnapshot {
  readonly events: readonly TerminalPerfEvent[];
  readonly report: TerminalLatencyReport;
  readonly recorder: TerminalPerfRecorderMetadata;
}

export interface TerminalPerfFixture {
  reset(): Promise<void>;
  /** Current exact proxy-control counters for feedback-driven impairment priming. */
  proxyImpairment(): Promise<ProxyImpairmentStats | null>;
  /** Trigger only; the resulting request/snapshot/apply/fence remain the real protocol path. */
  forceDisplayResync(): Promise<void>;
  /** Wait for proxy, apply, presentation, and GPU-fence quiet without recording a window. */
  settlePresentation(): Promise<void>;
  /**
   * One-shot read-only final authority/presented-grid check. No reset, resync,
   * or new measurement may follow it; explicit finalization lets a test-owned
   * carrier stay alive through the proof and close before fixture teardown.
   */
  finalizeGridConvergence(): Promise<PerfGridConvergenceResult>;
  /**
   * Opens one measurement window. With `afterGraphicsAsset`, the page first
   * waits, reading the telemetry worker back to back, until that tile job
   * counter reaches its target, and opens the window in the same task: a timed
   * input can then ride a transfer that outlasts no harness round trip. It
   * throws as soon as `failed` rises; its 15 s bound is liveness only. With
   * `timedInput`, the window holds exactly one awaited input, and the input
   * frontier the page read last before the boundary is its baseline.
   */
  beginPresentationMeasurement(
    purpose: TerminalPresentationMeasurementPurpose,
    options?: PresentationMeasurementOptions,
  ): Promise<number>;
  /**
   * Settles and closes the window. A timed window also returns where its input
   * completed: the first settle poll that saw its ACK and authoritative fence,
   * and the proxy status that poll read next. `settleTimeoutMs` extends the
   * settle's 15 s liveness bound for a window whose work (a large tile
   * transfer behind a slow link) takes longer to go quiet.
   */
  endPresentationMeasurement(
    measurementId: number,
    settleTimeoutMs?: number,
  ): Promise<TimedInputClose | null>;
  snapshot(): Promise<TerminalPerfSnapshot>;
  /**
   * The trace since the last reset as it stands, read without the presentation
   * settle. A window that failed can hold work that never ends, such as a tile
   * job that never retires, so its evidence cannot wait for quiet.
   */
  unsettledEvents(): Promise<readonly TerminalPerfEvent[]>;
}

export interface PresentationMeasurementOptions {
  readonly afterGraphicsAsset?: GraphicsAssetTarget;
  readonly timedInput?: true;
}

const GRAPHICS_ASSET_WAIT_LIVENESS_MS = 15_000;

type GridConvergenceProbePurpose = 'reset-precondition' | 'observation-ack' | 'final-verification';

interface GridConvergenceProbeEvidence {
  readonly purpose: GridConvergenceProbePurpose;
  readonly repair: boolean;
  readonly result: PerfGridConvergenceResult;
}

async function recordPresentationMeasurementBoundary(
  page: Page,
  measurementId: number,
  phase: TerminalPresentationMeasurementPhase,
  purpose: TerminalPresentationMeasurementPurpose,
  options: PresentationMeasurementOptions = {},
): Promise<TimedInputBaseline | null> {
  const { afterGraphicsAsset, timedInput } = options;
  const result = await page.evaluate(recordPresentationMeasurementBoundaryInPage, {
    id: measurementId,
    boundaryPhase: phase,
    boundaryPurpose: purpose,
    ...(afterGraphicsAsset === undefined
      ? {}
      : {
          afterGraphicsAsset: {
            ...afterGraphicsAsset,
            livenessMs: GRAPHICS_ASSET_WAIT_LIVENESS_MS,
          },
        }),
    ...(timedInput === undefined ? {} : { timedInput }),
  });
  if (!isPerfDisplayRingBoundarySnapshot(result.ringBoundary)) {
    throw new Error('terminal worker returned an invalid display-ring boundary snapshot');
  }
  if (timedInput === undefined) return null;
  const baseline = result.timedInputBaseline;
  if (
    !isObject(baseline) ||
    !isPositiveUint32(baseline.observationEpoch) ||
    !isTelemetryInputFrontierStatus(baseline.input)
  ) {
    throw new Error(
      `a timed window opened without a valid input baseline: ${JSON.stringify(baseline)}`,
    );
  }
  return { observationEpoch: baseline.observationEpoch, input: baseline.input };
}

function proxyControlPort(): number | null {
  const rawPort = process.env.EDGE_PROXY_CONTROL_PORT;
  if (rawPort === undefined) return null;
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('EDGE_PROXY_CONTROL_PORT must be an integer from 1 to 65535');
  }
  return port;
}

async function waitForProxyDrainGrace(): Promise<void> {
  if (proxyControlPort() === null) return;
  const drainGraceMs = Number(process.env.EDGE_NETWORK_DRAIN_GRACE_MS ?? 0);
  if (!Number.isFinite(drainGraceMs) || drainGraceMs < 0) {
    throw new Error('EDGE_NETWORK_DRAIN_GRACE_MS must be a non-negative finite number');
  }
  // Let priming packets already classified by the proxy leave both bounded
  // delay queues before the recorder and deterministic trace are reset.
  await new Promise<void>((resolve) => {
    setTimeout(resolve, Math.ceil(drainGraceMs));
  });
}

async function requestProxyImpairment(
  command: 'reset' | 'stats',
): Promise<ProxyImpairmentStats | null> {
  const port = proxyControlPort();
  if (port === null) return null;
  return requestProxyImpairmentStats(port, command);
}

async function requestDrainedProxyImpairment(): Promise<ProxyImpairmentStats | null> {
  if (proxyControlPort() === null) return null;
  const deadline = Date.now() + 2_000;
  do {
    const status = await requestProxySettleStatus();
    if (status?.pendingScheduledPackets === 0) return requestProxyImpairment('stats');
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  return requestProxyImpairment('stats');
}

/**
 * The proxy's full statistics, links and each relay's use of them since the
 * mark included. Chunked across several datagrams, so read it outside any
 * measured window. Null without a proxy.
 */
export async function requestProxyStats(): Promise<ProxyImpairmentStats | null> {
  return requestProxyImpairment('stats');
}

/**
 * The proxy's bounded status: aggregate counters, the current trace mark, every
 * relay's ledger since that mark together (a detached relay's included), and
 * each live relay's pending packets and own ledger. Null without a proxy.
 */
export async function requestProxySettleStatus(): Promise<ProxySettleStatus | null> {
  const port = proxyControlPort();
  if (port === null) return null;
  const nonce = randomUUID();
  return requestProxyChunkedReply(port, `settle:${nonce}`, 'settle', nonce, parseProxySettleStatus);
}

/**
 * Restart every proxy relay's impairment trace under `key` at its next packet,
 * so windows marked with one key replay the same decisions relay by relay.
 * Retries repeat the request string, which the proxy answers from its reply
 * cache, so a retry never marks twice. Returns the relays as the mark found
 * them, or null without a proxy.
 */
export async function markProxyTrace(key: number): Promise<ProxySettleStatus | null> {
  const port = proxyControlPort();
  if (port === null) return null;
  if (!Number.isSafeInteger(key) || key < 1 || key >= PROXY_MAX_TRACE_MARK_KEY) {
    throw new Error(`proxy trace key ${key} is outside [1, 2^53)`);
  }
  const nonce = randomUUID();
  return requestProxyChunkedReply(port, `mark:${nonce}:${key}`, 'mark', nonce, (value) =>
    parseProxyMarkStatus(value, key),
  );
}

export async function readBrowserDrainStatus(page: Page): Promise<TelemetryWorkerDrainStatus> {
  const raw: unknown = await page.evaluate(async () => {
    const request = (
      globalThis as unknown as {
        __merkurPerfDrainStatus?: () => Promise<unknown>;
      }
    ).__merkurPerfDrainStatus;
    if (typeof request !== 'function') return null;
    return Promise.race([
      request().catch(() => null),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 1_000)),
    ]);
  });
  if (!isTelemetryWorkerDrainStatus(raw)) {
    throw new Error('telemetry worker returned no valid compact drain status');
  }
  return raw;
}

async function requireGridConvergence(
  page: Page,
  repair: boolean,
): Promise<PerfGridConvergenceResult> {
  const raw: unknown = await page.evaluate(async (allowRepair) => {
    const verify = (
      globalThis as unknown as {
        __merkurTerminalPerfVerifyGridConvergence?: (repair: boolean) => Promise<unknown>;
      }
    ).__merkurTerminalPerfVerifyGridConvergence;
    if (typeof verify !== 'function') return { probeError: 'hook-unavailable' };
    return verify(allowRepair).catch(() => ({ probeError: 'request-rejected' }));
  }, repair);
  if (!isPerfGridConvergenceResult(raw) || !raw.converged || raw.failureReason !== null) {
    throw new Error(
      `terminal grid convergence could not be proved after presentation drain: ${gridConvergenceFailureDetail(raw)}`,
    );
  }
  if (!repair && raw.selectiveRepairCount !== 0) {
    throw new Error('read-only terminal grid convergence unexpectedly performed selective repair');
  }
  return raw;
}

function isTelemetryWorkerDrainStatus(value: unknown): value is TelemetryWorkerDrainStatus {
  if (!isObject(value) || !isObject(value.activity) || !isObject(value.stats)) return false;
  const activity = value.activity;
  const stats = value.stats;
  return (
    isPositiveUint32(activity.observationEpoch) &&
    isNonNegativeFinite(activity.observationStartedAtMs) &&
    isUint32(activity.activityRevision) &&
    isNonNegativeSafeInteger(activity.activityEventCount) &&
    isNonNegativeFinite(activity.latestActivityAtMs) &&
    isNonNegativeSafeInteger(activity.pendingAuthoritativeRenderCount) &&
    typeof activity.trackingOverflow === 'boolean' &&
    isTelemetryGraphicsAssetStatus(activity.graphicsAsset) &&
    isTelemetryInputFrontierStatus(activity.input) &&
    isNonNegativeSafeInteger(stats.recordsDrained) &&
    isNonNegativeSafeInteger(stats.recordsLost) &&
    isNonNegativeSafeInteger(stats.rowsShipped) &&
    isNonNegativeSafeInteger(stats.bytesShipped) &&
    isNonNegativeSafeInteger(stats.sendFailures) &&
    isNonNegativeSafeInteger(stats.pendingRows) &&
    isNonNegativeSafeInteger(stats.pendingRowsDropped) &&
    typeof stats.budgetExhausted === 'boolean'
  );
}

/**
 * Every transition lands in exactly one counter, and a job the observation
 * saw retire is one it saw demanded: `open` can never go negative.
 */
function isTelemetryGraphicsAssetStatus(value: unknown): value is TelemetryGraphicsAssetStatus {
  if (!isObject(value)) return false;
  const phases = [
    value.demanded,
    value.requested,
    value.firstByte,
    value.fin,
    value.published,
    value.consumed,
    value.retired,
    value.failed,
  ];
  if (!phases.every(isNonNegativeSafeInteger) || !isNonNegativeSafeInteger(value.eventCount)) {
    return false;
  }
  const counts = phases as number[];
  return (
    value.eventCount === counts.reduce((sum, count) => sum + count, 0) &&
    value.open === (value.demanded as number) - (value.retired as number) &&
    (value.open as number) >= 0
  );
}

/** Each high-water is a u32 input sequence; each time is zero until its high-water is set. */
function isTelemetryInputFrontierStatus(value: unknown): value is TelemetryInputFrontierStatus {
  return (
    isObject(value) &&
    isNonNegativeSafeInteger(value.queuedCount) &&
    isUint32(value.queuedSeq) &&
    isUint32(value.ackedSeq) &&
    isNonNegativeFinite(value.ackAtMs) &&
    (value.ackedSeq === 0) === (value.ackAtMs === 0) &&
    isUint32(value.fencedSeq) &&
    isNonNegativeFinite(value.fenceAtMs) &&
    (value.fencedSeq === 0) === (value.fenceAtMs === 0)
  );
}

function isPerfGridConvergenceResult(value: unknown): value is PerfGridConvergenceResult {
  if (!isObject(value)) return false;
  return (
    isPositiveUint32(value.observationEpoch) &&
    isPositiveUint32(value.probeId) &&
    typeof value.converged === 'boolean' &&
    (value.failureReason === null ||
      value.failureReason === 'not-ready' ||
      value.failureReason === 'superseded' ||
      value.failureReason === 'timeout' ||
      value.failureReason === 'mismatch') &&
    isNonNegativeSafeInteger(value.attempts) &&
    value.attempts > 0 &&
    isNonNegativeSafeInteger(value.selectiveRepairCount) &&
    isPositiveUint32(value.generation) &&
    isUint32(value.lastAdmittedDisplaySeq) &&
    isNonNegativeSafeInteger(value.rows) &&
    value.rows > 0 &&
    isNonNegativeFinite(value.elapsedMs)
  );
}

function isTelemetryObservationCompletion(value: unknown): value is TelemetryObservationCompletion {
  if (!isObject(value) || !isTelemetryObservationTraceCapture(value.capture)) return false;
  return (
    isPositiveUint32(value.preparationRequestId) &&
    isPositiveUint32(value.observationEpoch) &&
    isNonNegativeFinite(value.observationStartedAtMs) &&
    value.capture.complete &&
    value.capture.preparationRequestId === value.preparationRequestId &&
    value.capture.observationEpoch === value.observationEpoch &&
    value.capture.observationStartedAtMs === value.observationStartedAtMs
  );
}

function isPerfDisplayRingBoundarySnapshot(
  value: unknown,
): value is PerfDisplayRingBoundarySnapshot {
  return (
    isObject(value) &&
    isPositiveUint32(value.observationEpoch) &&
    isPositiveUint32(value.requestId) &&
    isNonNegativeSafeInteger(value.sessionEpoch) &&
    value.sessionEpoch > 0 &&
    isNonNegativeFinite(value.atMs) &&
    isUint32(value.ringDroppedTotal)
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isUint32(value: unknown): value is number {
  return isNonNegativeSafeInteger(value) && value <= 0xffff_ffff;
}

function isPositiveUint32(value: unknown): value is number {
  return isUint32(value) && value > 0;
}

/**
 * Blackhole every packet through the proxy for `durationMs`, then let it
 * restore itself.
 *
 * Loss injection models a degraded path; only this models the case reconnect
 * exists for — a carrier that stops entirely and comes back. Returns false when
 * the harness is running without the proxy, so a spec can skip rather than
 * silently assert nothing.
 */
/**
 * Which connections a partition cuts.
 *
 * `whole-path` blackholes everything, new dials included: the edge is simply
 * unreachable, so recovery is bounded by the outage rather than by any decision
 * the browser makes. `established` cuts only the connections that exist right
 * now and lets a fresh dial straight through — the interface-change case, and
 * the only one under which a speculative dial can complete and the promotion
 * path is reachable at all. `browser-dials` cuts nothing that exists and admits
 * nothing a browser dials: armed over a whole-path partition, the stalled
 * carrier answers before any replacement can be set up.
 */
export type PartitionScope = 'whole-path' | 'established' | 'browser-established' | 'browser-dials';

export async function partitionEdgeProxy(
  durationMs: number,
  scope: PartitionScope = 'whole-path',
): Promise<boolean> {
  const port = proxyControlPort();
  if (port === null) return false;
  const verb = scope === 'whole-path' ? 'partition' : `partition-${scope}`;
  await requestProxyControl(port, verb, String(Math.round(durationMs)), 'partitioned');
  return true;
}

/**
 * Where the edge sees the browser's connections come from: `::1`, or
 * `127.0.0.1` through the harness edge's dual-stack listener. Moving it is a
 * network change under connections that migrate; naming the current source
 * again moves only their ports. Returns how many connections moved, or null
 * without the delay proxy.
 */
export async function moveEdgeProxyBrowserSource(
  source: 'configured' | 'ipv4-loopback',
): Promise<number | null> {
  const port = proxyControlPort();
  if (port === null) return null;
  const [, moved] = await requestProxyControl(port, 'source', source, 'sourced');
  return Number(moved);
}

interface WindowedTerminalPerfCapture extends TerminalPerfRecorderCapture {
  readonly filteredBeforeWindowCount: number;
  readonly rejectedEventCount: number;
  readonly telemetryObservation: TelemetryObservationTraceCapture | null;
}

export const test = base.extend<{ terminalPerf: TerminalPerfFixture }>({
  page: async ({ page }, use, testInfo) => {
    // Seeded here rather than in `terminalPerf` because the app reads the
    // preference once at boot and fixtures that navigate — `linkedDaemon`
    // calls `goto('/')` — are not ordered after it. A seed that lands on an
    // already-booted page leaves that session unprofiled with no second read.
    await page.addInitScript(enableE2ETelemetryPreference);
    const diagnostics = new BoundedTailBuffer<string>(2_048);
    page.on('console', (message) => {
      diagnostics.push(`[console:${message.type()}] ${message.text()}`);
    });
    page.on('pageerror', (error) => {
      diagnostics.push(`[pageerror] ${error.stack ?? error.message}`);
    });
    page.on('crash', () => {
      diagnostics.push('[crash] browser page crashed');
    });
    page.on('requestfailed', (request) => {
      diagnostics.push(
        `[requestfailed] ${request.method()} ${request.url()} ${request.failure()?.errorText ?? ''}`,
      );
    });

    await use(page);

    if (testInfo.status !== testInfo.expectedStatus && diagnostics.count > 0) {
      const truncationNotice =
        diagnostics.droppedCount > 0
          ? `[recorder] dropped ${diagnostics.droppedCount} older browser diagnostic messages\n`
          : '';
      await testInfo.attach('browser-diagnostics.log', {
        body: `${truncationNotice}${diagnostics.values().join('\n')}\n`,
        contentType: 'text/plain',
      });
    }
  },
  terminalPerf: async ({ page }, use, testInfo) => {
    await page.addInitScript(installE2ETerminalPerfRecorder);
    await page.evaluate(installE2ETerminalPerfRecorder);
    let minimumEventAtMs = Number.NEGATIVE_INFINITY;
    let lastSnapshot: TerminalPerfSnapshot | undefined;
    let lastSnapshotSource:
      | 'fixture_initial_snapshot'
      | 'reset_snapshot'
      | 'last_fixture_snapshot'
      | 'empty_after_read_error' = 'fixture_initial_snapshot';
    const hasLastFixtureSnapshot = (): boolean => lastSnapshotSource === 'last_fixture_snapshot';
    let lastPageReadError: string | null = null;
    let lastWindowCounts = { filteredBeforeWindowCount: 0, rejectedEventCount: 0 };
    let lastProxyImpairmentStats: ProxyImpairmentStats | null = null;
    let lastSnapshotProxyImpairmentStats: ProxyImpairmentStats | null = null;
    let lastTelemetryObservation: TelemetryObservationTraceCapture | null = null;
    let nextPresentationMeasurementId = 0;
    const activePresentationMeasurements = new Map<
      number,
      {
        readonly purpose: TerminalPresentationMeasurementPurpose;
        readonly timedInput: TimedInputBaseline | null;
      }
    >();
    const gridConvergenceProbes: GridConvergenceProbeEvidence[] = [];
    let gridConvergenceError: string | null = null;
    let gridConvergenceFinalization: 'open' | 'complete' | 'failed' = 'open';
    const retainedStartupAttempts = new Map<string, TerminalStartupAttemptReport>();
    const browser = page.context().browser();
    const browserMetadata = {
      name: browser?.browserType().name() ?? null,
      version: browser?.version() ?? null,
      projectName: testInfo.project.name,
    };

    const readCapture = async (): Promise<WindowedTerminalPerfCapture> => {
      const capture = await page.evaluate(
        async ({ minimumAtMs, harnessBoundaryKinds }) => {
          type RecorderCapture = {
            events?: unknown;
            recorder?: unknown;
          };
          const scope = globalThis as unknown as {
            __merkurPerfDump?: () => Promise<{
              events?: unknown;
              stats?: unknown;
              capture?: unknown;
            }>;
            __merkurTerminalPerf?: {
              readonly events?: unknown[];
              readonly metadata?: unknown;
              snapshot?(): RecorderCapture;
            };
          };
          // Profiling records live in shared-memory rings drained by the telemetry
          // worker, never on the main thread, so the trace has to be requested
          // from that worker. The injected recorder below is the fallback for
          // runs where profiling never started and no worker exists.
          const dump = scope.__merkurPerfDump;
          if (typeof dump === 'function') {
            // `dump()` rejects if the worker died or was stopped, and answers
            // only while it is alive, so bound it here as well. Once the worker
            // exists its observation capture is authoritative: falling back to
            // the page shell would turn a missing worker trace into a false
            // empty success.
            const dumped = await new Promise<Awaited<ReturnType<typeof dump>> | null>((resolve) => {
              const timeout = setTimeout(() => resolve(null), 10_000);
              dump().then(
                (value) => {
                  clearTimeout(timeout);
                  resolve(value);
                },
                () => {
                  clearTimeout(timeout);
                  resolve(null);
                },
              );
            });
            if (dumped === null) {
              throw new Error('telemetry worker returned no exact observation dump');
            }
            {
              const dumpedEvents = Array.isArray(dumped.events) ? dumped.events : [];
              // Worker stats are lifetime transport counters, not observation
              // recorder metadata. Return the exact worker capture separately;
              // the outer fixture performs the one shared accounting validation.
              const shell = scope.__merkurTerminalPerf;
              const shellCapture =
                shell === undefined
                  ? undefined
                  : typeof shell.snapshot === 'function'
                    ? shell.snapshot()
                    : { events: shell.events, recorder: shell.metadata };
              const shellMeta = shellCapture?.recorder;
              const measurementBoundaries = Array.isArray(shellCapture?.events)
                ? shellCapture.events.filter(
                    (event) =>
                      typeof event === 'object' &&
                      event !== null &&
                      harnessBoundaryKinds.some(
                        (kind) => kind === (event as { kind?: unknown }).kind,
                      ),
                  )
                : [];
              const mergedEvents = dumpedEvents.concat(measurementBoundaries);
              return windowEvents(
                mergedEvents,
                shellMeta,
                dumped.capture,
                dumpedEvents.length,
                measurementBoundaries.length,
              );
            }
          }

          const recorder = scope.__merkurTerminalPerf;
          if (recorder === undefined) {
            return {
              events: [],
              recorder: undefined,
              filteredBeforeWindowCount: 0,
              rejectedEventCount: 0,
              telemetryObservation: null,
              workerRetainedEventCount: null,
              harnessBoundaryCount: 0,
            };
          }
          const snapshot =
            typeof recorder.snapshot === 'function'
              ? recorder.snapshot()
              : { events: recorder.events, recorder: recorder.metadata };
          const rawEvents = Array.isArray(snapshot.events) ? snapshot.events : [];
          // Worker messages posted before reset can be delivered just after the
          // main-thread clear. Their epoch timestamps expose that race, so keep
          // them out of the new measurement window.
          const events: unknown[] = [];
          let filteredBeforeWindowCount = 0;
          let rejectedEventCount = 0;
          for (const event of rawEvents) {
            if (typeof event !== 'object' || event === null) {
              rejectedEventCount += 1;
              continue;
            }
            const atMs = (event as { atMs?: unknown }).atMs;
            if (typeof atMs !== 'number' || !Number.isFinite(atMs)) {
              rejectedEventCount += 1;
            } else if (atMs < minimumAtMs) {
              filteredBeforeWindowCount += 1;
            } else {
              events.push(event);
            }
          }
          return {
            events,
            recorder: snapshot.recorder,
            filteredBeforeWindowCount,
            rejectedEventCount,
            telemetryObservation: null,
            workerRetainedEventCount: null,
            harnessBoundaryCount: 0,
          };

          function windowEvents(
            rawList: readonly unknown[],
            recorderMeta: unknown,
            telemetryObservation: unknown,
            workerRetainedEventCount: number | null,
            harnessBoundaryCount: number,
          ): {
            events: unknown[];
            recorder: unknown;
            filteredBeforeWindowCount: number;
            rejectedEventCount: number;
            telemetryObservation: unknown;
            workerRetainedEventCount: number | null;
            harnessBoundaryCount: number;
          } {
            const kept: unknown[] = [];
            let beforeWindow = 0;
            let rejected = 0;
            for (const event of rawList) {
              if (typeof event !== 'object' || event === null) {
                rejected += 1;
                continue;
              }
              const at = (event as { atMs?: unknown }).atMs;
              if (typeof at !== 'number' || !Number.isFinite(at)) rejected += 1;
              else if (at < minimumAtMs) beforeWindow += 1;
              else kept.push(event);
            }
            return {
              events: kept,
              recorder: recorderMeta,
              filteredBeforeWindowCount: beforeWindow,
              rejectedEventCount: rejected,
              telemetryObservation,
              workerRetainedEventCount,
              harnessBoundaryCount,
            };
          }
        },
        {
          minimumAtMs: minimumEventAtMs,
          harnessBoundaryKinds: [...TERMINAL_PERF_HARNESS_BOUNDARY_KINDS],
        },
      );
      const events = capture.events as TerminalPerfEvent[];
      let telemetry: ReturnType<typeof buildTelemetryObservationRecorderMetadata> | null = null;
      if (capture.telemetryObservation !== null) {
        if (capture.workerRetainedEventCount === null) {
          throw new Error('telemetry worker observation omitted its retained-event count');
        }
        telemetry = buildTelemetryObservationRecorderMetadata(
          capture.recorder,
          capture.telemetryObservation,
          capture.workerRetainedEventCount,
          capture.harnessBoundaryCount,
          lastTelemetryObservation,
        );
      }
      return {
        events,
        recorder: telemetry?.recorder ?? normalizeRecorderMetadata(capture.recorder, events.length),
        filteredBeforeWindowCount: capture.filteredBeforeWindowCount,
        rejectedEventCount: capture.rejectedEventCount,
        telemetryObservation: telemetry?.capture ?? null,
      };
    };

    const makeSnapshot = (capture: TerminalPerfRecorderCapture): TerminalPerfSnapshot =>
      freezeTerminalPerfSnapshot(
        capture.events,
        buildTerminalLatencyReport(capture.events),
        capture.recorder,
      );
    const retainStartup = (snapshot: TerminalPerfSnapshot): void => {
      for (const attempt of snapshot.report.startup.attempts) {
        retainedStartupAttempts.set(`${attempt.deviceId}\0${attempt.attemptId}`, attempt);
      }
    };
    const pollPresentationDrain = async () => ({
      browserStatus: await readBrowserDrainStatus(page),
      proxyStatus: await requestProxySettleStatus(),
    });
    const settlePresentationPipeline = async (
      boundary:
        | { readonly measurementId: number; readonly timedInput?: TimedInputBaseline }
        | { readonly startAtMs: number },
      timeoutMs = 15_000,
    ): Promise<TimedInputClose | null> => {
      const drainOptions = {
        ...boundary,
        quietMs: presentationDrainQuietMs(process.env),
        timeoutMs,
        poll: pollPresentationDrain,
      };
      const close = await waitForPresentationDrain(drainOptions);
      await waitForProxyDrainGrace();
      return close;
    };
    const verifyAndRetainGridConvergence = async (
      purpose: GridConvergenceProbePurpose,
      repair: boolean,
    ): Promise<PerfGridConvergenceResult> => {
      const result = await requireGridConvergence(page, repair);
      gridConvergenceProbes.push({ purpose, repair, result });
      const cleanNetworkProfile =
        process.env.EDGE_NETWORK_ACTIVE !== '1' ||
        (Number(process.env.EDGE_NETWORK_DATAGRAM_LOSS_PERCENT ?? 0) === 0 &&
          (process.env.EDGE_NETWORK_REORDER ?? 'none') === 'none' &&
          (process.env.EDGE_NETWORK_SCENARIO ?? 'steady') === 'steady');
      if (
        purpose === 'reset-precondition' &&
        cleanNetworkProfile &&
        result.selectiveRepairCount !== 0
      ) {
        throw new Error('clean terminal grid convergence unexpectedly required selective repair');
      }
      return result;
    };
    const convergePrecondition = async (
      boundary: { readonly measurementId: number } | { readonly startAtMs: number },
    ): Promise<PerfGridConvergenceResult> => {
      await settlePresentationPipeline(boundary);
      const result = await verifyAndRetainGridConvergence('reset-precondition', true);
      // A mismatch may have exercised real selective repair. The convergence
      // result is downstream of its GPU fence; close its ACK/proxy tail before
      // cutting the fresh observation boundary.
      await settlePresentationPipeline(boundary);
      return result;
    };
    const assertGridConvergenceNotFinalized = (operation: string): void => {
      if (gridConvergenceFinalization !== 'open') {
        throw new Error(`${operation} is not allowed after terminal grid convergence finalization`);
      }
    };
    const runFinalGridConvergence = async (): Promise<PerfGridConvergenceResult> => {
      if (gridConvergenceFinalization !== 'open') {
        throw new Error('terminal grid convergence is already finalized');
      }
      try {
        if (activePresentationMeasurements.size !== 0) {
          throw new Error('cannot finalize terminal grid convergence with an open measurement');
        }
        const startedAtMs = await page.evaluate(() => performance.timeOrigin + performance.now());
        await settlePresentationPipeline({ startAtMs: startedAtMs });
        const result = await verifyAndRetainGridConvergence('final-verification', false);
        await settlePresentationPipeline({ startAtMs: startedAtMs });
        gridConvergenceFinalization = 'complete';
        return result;
      } catch (error) {
        gridConvergenceFinalization = 'failed';
        gridConvergenceError = formatError(error);
        throw error;
      }
    };

    try {
      const capture = await readCapture();
      lastSnapshot = makeSnapshot(capture);
      lastTelemetryObservation = capture.telemetryObservation;
      retainStartup(lastSnapshot);
      lastWindowCounts = {
        filteredBeforeWindowCount: capture.filteredBeforeWindowCount,
        rejectedEventCount: capture.rejectedEventCount,
      };
    } catch (error) {
      lastPageReadError = formatError(error);
      lastSnapshotSource = 'empty_after_read_error';
      lastWindowCounts = { filteredBeforeWindowCount: 0, rejectedEventCount: 0 };
      lastSnapshot = makeSnapshot({
        events: [],
        recorder: unavailableRecorderMetadata(),
      });
    }

    await use({
      async reset() {
        assertGridConvergenceNotFinalized('reset');
        try {
          // One bootstrap dump preserves startup attempts before the recorder
          // lineage is cut. It is never used by settle polling.
          retainStartup(makeSnapshot(await readCapture()));
          const preconditionStartedAtMs = await page.evaluate(
            () => performance.timeOrigin + performance.now(),
          );
          await convergePrecondition({ startAtMs: preconditionStartedAtMs });
          const resetCapture = await page.evaluate(async () => {
            type RecorderCapture = {
              events?: unknown;
              recorder?: unknown;
            };
            const scope = globalThis as unknown as {
              __merkurTerminalPerf?: {
                readonly events?: unknown[];
                readonly metadata?: unknown;
                reset(): void;
                snapshot?(): RecorderCapture;
              };
              __merkurPerfPrepareObservation?: () => Promise<number>;
              __merkurPerfObservationReady?: () => Promise<unknown>;
            };
            const prepare = scope.__merkurPerfPrepareObservation;
            const ready = scope.__merkurPerfObservationReady;
            if (typeof prepare !== 'function' || typeof ready !== 'function') {
              throw new Error('telemetry observation boundary API is unavailable');
            }
            const preparationRequestId = await new Promise<number>((resolve, reject) => {
              const timeout = setTimeout(
                () => reject(new Error('telemetry observation preparation timed out')),
                10_000,
              );
              prepare().then(
                (requestId) => {
                  clearTimeout(timeout);
                  resolve(requestId);
                },
                (error) => {
                  clearTimeout(timeout);
                  reject(error);
                },
              );
            });
            const resetAtMs = performance.timeOrigin + performance.now();
            const recorder = scope.__merkurTerminalPerf;
            recorder?.reset();
            const observation = await new Promise<unknown>((resolve, reject) => {
              const timeout = setTimeout(
                () => reject(new Error('telemetry observation completion timed out')),
                10_000,
              );
              ready().then(
                (result) => {
                  clearTimeout(timeout);
                  resolve(result);
                },
                (error) => {
                  clearTimeout(timeout);
                  reject(error);
                },
              );
            });
            const snapshot =
              typeof recorder?.snapshot === 'function'
                ? recorder.snapshot()
                : { events: recorder?.events ?? [], recorder: recorder?.metadata };
            const rawEvents = Array.isArray(snapshot.events) ? snapshot.events : [];
            const events: unknown[] = [];
            let filteredBeforeWindowCount = 0;
            let rejectedEventCount = 0;
            for (const event of rawEvents) {
              if (typeof event !== 'object' || event === null) {
                rejectedEventCount += 1;
                continue;
              }
              const atMs = (event as { atMs?: unknown }).atMs;
              if (typeof atMs !== 'number' || !Number.isFinite(atMs)) {
                rejectedEventCount += 1;
              } else if (atMs < resetAtMs) {
                filteredBeforeWindowCount += 1;
              } else {
                events.push(event);
              }
            }
            return {
              resetAtMs,
              preparationRequestId,
              observation,
              events,
              recorder: snapshot.recorder,
              filteredBeforeWindowCount,
              rejectedEventCount,
            };
          });
          if (
            !isTelemetryObservationCompletion(resetCapture.observation) ||
            resetCapture.observation.preparationRequestId !== resetCapture.preparationRequestId ||
            resetCapture.observation.observationStartedAtMs < resetCapture.resetAtMs
          ) {
            throw new Error('telemetry observation completion did not match the exact reset');
          }
          activePresentationMeasurements.clear();
          // Wait for the telemetry worker to install the fresh observation,
          // then use a read-only convergence response as the reliable daemon
          // PERF_ENABLE acknowledgement. The repair-enabled precondition above
          // ensures this request cannot alter the grid or emit repair traffic.
          await settlePresentationPipeline({ startAtMs: resetCapture.resetAtMs });
          const observationAck = await verifyAndRetainGridConvergence('observation-ack', false);
          await settlePresentationPipeline({ startAtMs: resetCapture.resetAtMs });
          const browserDrainStatus = await readBrowserDrainStatus(page);
          if (browserDrainStatus.activity.observationEpoch !== observationAck.observationEpoch) {
            throw new Error(
              'terminal convergence ACK did not match the fresh recorder observation',
            );
          }
          // Reset the deterministic packet trace only after every precondition
          // and acknowledgement packet has drained. No verifier runs between
          // this cut and the first measured input.
          lastProxyImpairmentStats = await requestProxyImpairment('reset');
          lastSnapshotProxyImpairmentStats = lastProxyImpairmentStats;
          minimumEventAtMs = await page.evaluate(() => performance.timeOrigin + performance.now());
          const events: TerminalPerfEvent[] = [];
          lastTelemetryObservation = resetCapture.observation.capture;
          lastSnapshot = makeSnapshot({
            events,
            recorder: normalizeRecorderMetadata(resetCapture.recorder, events.length),
          });
          lastWindowCounts = {
            filteredBeforeWindowCount:
              resetCapture.filteredBeforeWindowCount +
              (Array.isArray(resetCapture.events) ? resetCapture.events.length : 0),
            rejectedEventCount: resetCapture.rejectedEventCount,
          };
          lastSnapshotSource = 'reset_snapshot';
          lastPageReadError = null;
        } catch (error) {
          lastTelemetryObservation = null;
          lastPageReadError = formatError(error);
          lastSnapshotSource = 'empty_after_read_error';
          lastWindowCounts = { filteredBeforeWindowCount: 0, rejectedEventCount: 0 };
          lastSnapshot = makeSnapshot({
            events: [],
            recorder: unavailableRecorderMetadata(),
          });
          throw error;
        }
      },
      async forceDisplayResync() {
        assertGridConvergenceNotFinalized('display resync');
        await page.evaluate((eventName) => {
          globalThis.dispatchEvent(new Event(eventName));
        }, TERMINAL_PERF_FORCE_RESYNC_EVENT);
      },
      async settlePresentation() {
        const startAtMs = await page.evaluate(() => performance.timeOrigin + performance.now());
        await settlePresentationPipeline({ startAtMs });
      },
      async finalizeGridConvergence() {
        return runFinalGridConvergence();
      },
      async proxyImpairment() {
        const stats = await requestProxyImpairment('stats');
        if (stats !== null) lastProxyImpairmentStats = stats;
        return stats;
      },
      async beginPresentationMeasurement(purpose, options) {
        assertGridConvergenceNotFinalized('presentation measurement');
        nextPresentationMeasurementId =
          nextPresentationMeasurementId >= 0xffff_ffff ? 1 : nextPresentationMeasurementId + 1;
        const measurementId = nextPresentationMeasurementId;
        const timedInput = await recordPresentationMeasurementBoundary(
          page,
          measurementId,
          'start',
          purpose,
          options,
        );
        activePresentationMeasurements.set(measurementId, { purpose, timedInput });
        return measurementId;
      },
      async endPresentationMeasurement(measurementId, settleTimeoutMs) {
        const window = activePresentationMeasurements.get(measurementId);
        if (window === undefined) {
          throw new Error(`presentation measurement ${measurementId} is not active`);
        }
        const close = await settlePresentationPipeline(
          window.timedInput === null
            ? { measurementId }
            : { measurementId, timedInput: window.timedInput },
          settleTimeoutMs,
        );
        await recordPresentationMeasurementBoundary(page, measurementId, 'end', window.purpose);
        activePresentationMeasurements.delete(measurementId);
        return close;
      },
      async snapshot() {
        try {
          const startAtMs = await page.evaluate(() => performance.timeOrigin + performance.now());
          await settlePresentationPipeline({ startAtMs });
          const capture = await readCapture();
          lastTelemetryObservation = capture.telemetryObservation;
          const proxyStats = await requestProxyImpairment('stats');
          if (proxyStats !== null) {
            lastProxyImpairmentStats = proxyStats;
            lastSnapshotProxyImpairmentStats = proxyStats;
          }
          const snapshot = makeSnapshot(capture);
          retainStartup(snapshot);
          // Teardown deliberately serializes this exact immutable value instead
          // of rereading a trace that can continue changing after assertions.
          lastSnapshot = snapshot;
          lastWindowCounts = {
            filteredBeforeWindowCount: capture.filteredBeforeWindowCount,
            rejectedEventCount: capture.rejectedEventCount,
          };
          lastSnapshotSource = 'last_fixture_snapshot';
          lastPageReadError = null;
          return snapshot;
        } catch (error) {
          lastPageReadError = formatError(error);
          throw error;
        }
      },
      async unsettledEvents() {
        return (await readCapture()).events;
      },
    });

    // One read-only authoritative-grid proof runs after the test has closed
    // every logical window. Per-window drain polling remains scalar-only and
    // never adds an RTT or repair traffic to the measured workload.
    // A spec can skip before it opens a terminal (carrier-rebind does this when
    // the delay proxy is absent). In that case no terminal or telemetry worker
    // exists, so there is no authoritative grid to prove. Preserve the skip
    // instead of turning fixture teardown into a false failure.
    if (gridConvergenceFinalization === 'open' && testInfo.status !== 'skipped') {
      try {
        await runFinalGridConvergence();
      } catch (error) {
        gridConvergenceError = formatError(error);
      }
    }

    // Materialize the cumulative worker trace and histogram-rich proxy sample
    // once, after the final read-only proof. No settle poll above traverses
    // either retained event storage or delay histograms.
    try {
      const capture = await readCapture();
      lastTelemetryObservation = capture.telemetryObservation;
      const proxyStats = await requestDrainedProxyImpairment();
      if (proxyStats !== null) {
        lastProxyImpairmentStats = proxyStats;
        lastSnapshotProxyImpairmentStats = proxyStats;
      }
      lastSnapshot = makeSnapshot(capture);
      retainStartup(lastSnapshot);
      lastWindowCounts = {
        filteredBeforeWindowCount: capture.filteredBeforeWindowCount,
        rejectedEventCount: capture.rejectedEventCount,
      };
      lastSnapshotSource = 'last_fixture_snapshot';
      lastPageReadError = null;
    } catch (error) {
      lastPageReadError = formatError(error);
    }

    const snapshot =
      lastSnapshot ??
      makeSnapshot({
        events: [],
        recorder: unavailableRecorderMetadata(),
      });
    const { events, recorder } = snapshot;
    retainStartup(snapshot);
    const edgeNetworkActive = process.env.EDGE_NETWORK_ACTIVE === '1';
    let proxyStatsReadError: string | null = null;
    if (!hasLastFixtureSnapshot() && lastProxyImpairmentStats !== null) {
      try {
        lastProxyImpairmentStats = await requestDrainedProxyImpairment();
        lastSnapshotProxyImpairmentStats = lastProxyImpairmentStats;
      } catch (error) {
        proxyStatsReadError = formatError(error);
      }
    }
    const capturedProxyImpairmentStats = lastSnapshotProxyImpairmentStats;
    const transportProfile = {
      edgeNetworkActive,
      profile: edgeNetworkActive ? (process.env.EDGE_NETWORK_PROFILE ?? null) : null,
      targetRttMs: edgeNetworkActive
        ? readNonNegativeFinite(process.env.EDGE_NETWORK_TARGET_RTT_MS)
        : 0,
      fourLegHopDelayMs: edgeNetworkActive
        ? readNonNegativeFinite(process.env.EDGE_NETWORK_HOP_DELAY_MS)
        : 0,
      oneWayJitterMs: edgeNetworkActive
        ? readNonNegativeFinite(process.env.EDGE_NETWORK_ONE_WAY_JITTER_MS)
        : 0,
      maxExtraDelayMs: edgeNetworkActive
        ? readNonNegativeFinite(process.env.EDGE_NETWORK_MAX_EXTRA_DELAY_MS)
        : 0,
      datagramLossPercent: edgeNetworkActive
        ? readNonNegativeFinite(process.env.EDGE_NETWORK_DATAGRAM_LOSS_PERCENT)
        : 0,
      faultSite: edgeNetworkActive ? (process.env.EDGE_NETWORK_FAULT_SITE ?? null) : null,
      faultSitesPerLogicalDirection: edgeNetworkActive
        ? readNonNegativeFinite(process.env.EDGE_NETWORK_FAULT_SITES_PER_LOGICAL_DIRECTION)
        : 0,
      reorder: edgeNetworkActive ? (process.env.EDGE_NETWORK_REORDER ?? null) : null,
      scenario: edgeNetworkActive ? (process.env.EDGE_NETWORK_SCENARIO ?? null) : null,
      seed: edgeNetworkActive ? readNonNegativeFinite(process.env.EDGE_NETWORK_SEED) : null,
      traceReset: edgeNetworkActive && process.env.EDGE_PROXY_CONTROL_PORT !== undefined,
      traceEpoch: capturedProxyImpairmentStats?.epoch ?? null,
      achieved: capturedProxyImpairmentStats,
      applicationDisplayOutcome: collectApplicationDisplayOutcome(events),
      proxyStatsReadError,
    };
    const predictionDiagnostics = collectPredictionDiagnostics(events);
    const gridPreconditions = gridConvergenceProbes.filter(
      (probe) => probe.purpose === 'reset-precondition',
    );
    const gridObservationAcks = gridConvergenceProbes.filter(
      (probe) => probe.purpose === 'observation-ack',
    );
    const gridFinalVerifications = gridConvergenceProbes.filter(
      (probe) => probe.purpose === 'final-verification',
    );
    const latestObservationAck = gridObservationAcks.at(-1)?.result;
    const finalVerification = gridFinalVerifications[0]?.result;
    const gridConvergence = {
      complete:
        gridConvergenceError === null &&
        gridPreconditions.length === gridObservationAcks.length &&
        gridPreconditions.length > 0 &&
        gridFinalVerifications.length === 1 &&
        latestObservationAck !== undefined &&
        finalVerification !== undefined &&
        latestObservationAck.observationEpoch === finalVerification.observationEpoch,
      error: gridConvergenceError,
      selectiveRepairCount: gridConvergenceProbes.reduce(
        (total, probe) =>
          Math.min(Number.MAX_SAFE_INTEGER, total + probe.result.selectiveRepairCount),
        0,
      ),
      probes: gridConvergenceProbes,
    } as const;
    const boundedReport = boundTerminalLatencyReport(snapshot.report, MAX_SUMMARY_REPORT_SAMPLES);
    const rawEventsFilename = 'terminal-perf-events.json.gz';
    const summary = `${JSON.stringify(
      {
        schemaVersion: TERMINAL_PERF_ARTIFACT_SCHEMA_VERSION,
        generatedAt: new Date().toISOString(),
        runtime: {
          nodeVersion: process.versions.node,
          bunVersion: process.versions.bun ?? null,
          platform: process.platform,
          architecture: process.arch,
        },
        browser: browserMetadata,
        test: {
          id: testInfo.testId,
          title: testInfo.title,
          titlePath: testInfo.titlePath,
          file: testInfo.file,
          line: testInfo.line,
          column: testInfo.column,
          retry: testInfo.retry,
          repeatEachIndex: testInfo.repeatEachIndex,
          workerIndex: testInfo.workerIndex,
          parallelIndex: testInfo.parallelIndex,
          status: testInfo.status ?? null,
          expectedStatus: testInfo.expectedStatus,
        },
        capture: {
          source: lastSnapshotSource,
          pageReadError: lastPageReadError,
          minimumEventAtMs: Number.isFinite(minimumEventAtMs) ? minimumEventAtMs : null,
          frozenSnapshot: true,
          capturedEventCount: events.length,
          ...lastWindowCounts,
          recorder,
          telemetryObservation: lastTelemetryObservation,
        },
        gridConvergence,
        rawEvents: {
          filename: rawEventsFilename,
          contentType: 'application/json',
          contentEncoding: 'gzip',
          eventCount: events.length,
        },
        transportProfile,
        predictionDiagnostics,
        startupCaptures: {
          attemptCount: retainedStartupAttempts.size,
          attempts: [...retainedStartupAttempts.values()],
        },
        reportSampleRetention: boundedReport.sampleRetention,
        report: boundedReport.report,
      },
      null,
      2,
    )}\n`;
    // `attach({ body })` is reporter-owned and some reporters discard passing
    // test attachments. Keep a real output artifact as well so clean-path
    // latency measurements remain inspectable after a successful release run.
    const summaryPath = testInfo.outputPath('terminal-latency-summary.json');
    const eventsPath = testInfo.outputPath(rawEventsFilename);
    const artifactErrors: string[] = [];
    const writeResults = await Promise.allSettled([
      writeFile(summaryPath, summary),
      writeGzipJsonArray(eventsPath, events),
    ]);
    if (writeResults[0].status === 'rejected') {
      artifactErrors.push(`summary write failed: ${formatError(writeResults[0].reason)}`);
    }
    if (writeResults[1].status === 'rejected') {
      artifactErrors.push(`raw-event write failed: ${formatError(writeResults[1].reason)}`);
    }
    const attachmentResults = await Promise.allSettled([
      ...(writeResults[0].status === 'fulfilled'
        ? [
            testInfo.attach('terminal-latency-summary.json', {
              path: summaryPath,
              contentType: 'application/json',
            }),
          ]
        : []),
      ...(writeResults[1].status === 'fulfilled'
        ? [
            testInfo.attach(rawEventsFilename, {
              path: eventsPath,
              contentType: 'application/gzip',
            }),
          ]
        : []),
    ]);
    for (const result of attachmentResults) {
      if (result.status === 'rejected') {
        artifactErrors.push(`artifact attachment failed: ${formatError(result.reason)}`);
      }
    }

    const invalidReasons = [...artifactErrors];
    if (!gridConvergence.complete && testInfo.status !== 'skipped') {
      invalidReasons.push(
        `terminal grid convergence evidence is incomplete${gridConvergence.error === null ? '' : `: ${gridConvergence.error}`}`,
      );
    }
    if (lastPageReadError !== null) {
      invalidReasons.push(`terminal recorder page read failed: ${lastPageReadError}`);
    }
    if (lastWindowCounts.rejectedEventCount > 0) {
      invalidReasons.push(
        `terminal recorder rejected ${lastWindowCounts.rejectedEventCount} malformed event(s)`,
      );
    }
    if (
      recorder.available &&
      recorder.retainedEventCount !==
        events.length +
          lastWindowCounts.filteredBeforeWindowCount +
          lastWindowCounts.rejectedEventCount
    ) {
      invalidReasons.push(
        `terminal recorder capture accounting mismatch: retained=${recorder.retainedEventCount} ` +
          `captured=${events.length} beforeWindow=${lastWindowCounts.filteredBeforeWindowCount} ` +
          `rejected=${lastWindowCounts.rejectedEventCount}`,
      );
    }
    invalidReasons.push(...validateRecorderMetadata(recorder));
    if (invalidReasons.length > 0) {
      throw new Error(
        `Terminal performance capture is invalid after artifacts were retained:\n${invalidReasons.join('\n')}`,
      );
    }
  },
});

export { expect };

function readNonNegativeFinite(value: string | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message;
  return String(error);
}
