import { createHash, randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { createReadStream } from 'node:fs';
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { isDeepStrictEqual } from 'node:util';

import type {
  DataplanePathStats,
  DataplaneTransportStats,
} from '../apps/daemon/src/services/dataplane-client';
import { BROWSER_DISPLAY_IO_SCOPE } from '../apps/web/src/perf/browser-display-io';
import {
  TERMINAL_LATENCY_RAW_METRIC_NAMES,
  type TerminalLatencyRawMetricName,
  type TerminalLatencyRawMetricSamples,
  type TerminalPresentationMeasurementPurpose,
} from '../apps/web/src/perf/terminal-latency';
import type { PerfGridConvergenceResult } from '../apps/web/src/terminal-worker-protocol';
import {
  TERMINAL_PERF_ARTIFACT_SCHEMA_VERSION,
  validateApplicationDisplayOutcomeEvidence,
} from '../tests/e2e/fixtures/terminal-perf-artifacts';
import {
  extractPercentileMetrics,
  type PercentileDistribution,
  verifyRawTerminalPerfTrace,
} from '../tests/e2e/fixtures/terminal-perf-replay';

import {
  DEFAULT_EDGE_NETWORK_SEED,
  EDGE_NETWORK_DATAGRAM_LOSS_PERCENTAGES,
  EDGE_NETWORK_PROFILE_NAMES,
  EDGE_NETWORK_PROFILES,
  type EdgeNetworkDatagramLossPercent,
  type EdgeNetworkProfileName,
  type EdgeNetworkReorderMode,
  type EdgeNetworkScenario,
} from './edge-network-profile';
import {
  configuredProxyFaultEvidenceErrors,
  PROXY_DELAY_HISTOGRAM_BUCKET_US,
  PROXY_DELAY_HISTOGRAM_BUCKETS,
  PROXY_IMPAIRMENT_SCHEMA_VERSION,
  type ProxyFaultEvidence,
  type ProxyImpairmentStats,
  parseProxyImpairmentStats,
  proxyFaultEvidence,
} from './edge-network-stats';

const ROOT = path.resolve(import.meta.dir, '..');
const PLAYWRIGHT_RESULTS = path.join(ROOT, 'test-results', 'e2e-edge');
const DEFAULT_OUTPUT = path.join(ROOT, 'test-results', 'terminal-network-matrix.json');
const MATRIX_RUNTIME_ARTIFACTS = [
  'target/rust/release/merkur-edge',
  'target/rust/release/delay_proxy',
  'apps/daemon/dist/merkur-dataplane',
  'apps/web/src/term-wasm/pkg/term_wasm.js',
  'apps/web/src/term-wasm/pkg/term_wasm_bg.wasm',
  'packages/e2e-wasm/pkg/e2e_wasm.js',
  'packages/e2e-wasm/pkg/e2e_wasm_bg.wasm',
] as const;
const DATAPLANE_TRANSPORT_SAMPLE_CADENCE_MS = 10_000;
const FINAL_CAPTURE_REQUEST_TIMEOUT_MS = 5_000;
const FINAL_CAPTURE_RUN_END_ALLOWANCE_MS = 10_000;
const SENT_DATAGRAM_MAX_ENTRIES = 1_024;
const EDGE_RELIABLE_QUEUE_MAX_BYTES = 4 * 1_024 * 1_024;
const MATRIX_ARTIFACT_SCHEMA_VERSION = 9;
export const DEFAULT_NETWORK_MATRIX_SEEDS = [DEFAULT_EDGE_NETWORK_SEED, 0xa11c_e5ed] as const;
const DATAPLANE_PATH_STATS_KEYS = [
  'pathsAvailable',
  'pathsLive',
  'rttEwmaUsMax',
  'networkRttEwmaUsMax',
  'jitterEwmaUsMax',
  'sendFailuresMax',
  'lastAckAgeMsMax',
  'displayDatagramsReceived',
  'displayDatagramsRecoveredByFec',
  'displayDatagramsDeclaredLost',
  'displayDatagramsOutcomeUnknown',
  'quicSentPackets',
  'quicLostPackets',
  'quicLostBytes',
  'quicCongestionEvents',
  'quicBlackHoles',
  'quicDatagramsTx',
  'quicDatagramsRx',
  'quicUdpTxBytes',
  'quicUdpRxBytes',
  'quicMtuMin',
  'quicCwndBytesMin',
  'quicRttUsMax',
] as const satisfies readonly (keyof DataplanePathStats)[];
const DATAPLANE_TRANSPORT_STATS_KEYS = [
  'windowMs',
  'peers',
  'parkedPeers',
  'webtransport',
  'edge',
  'rowVersionsSent',
  'rowVersionsSupersededUnapplied',
  'rowVersionsSupersededApplied',
  'rowResendsIdentical',
  'stalePreparedFlushesSent',
  'burstsAbandoned',
  'burstsUnsafeToRewind',
  'datagramSendFailures',
  'fecRepairsSent',
  'fecRepairsRefused',
  'resyncRowsRequested',
  'rowsDeclaredLost',
  'unackedDatagramsMax',
  'edgeReliableQueuedBytesMax',
  'inboundDatagramDropsWt',
  'inboundDatagramDropsEdge',
  'overCapacitySessionRejections',
  'directWtIncomingExpected',
  'directWtIncomingUnexpected',
  'directWtAdmitted',
  'natKeepalivesSent',
  'natPunchBurstsSent',
  'natPunchRefusedNotGlobal',
  'natPunchRefusedRateLimited',
  'natSideChannelSendFailed',
  'natSideChannelWouldBlock',
  'statsEventsDropped',
  'rebindRequests',
  'rebindAccepted',
  'rebindCommitted',
  'rebindRefused',
  'rebindEnvelopesRejected',
  'rebindEventsSuppressed',
] as const satisfies readonly (keyof DataplaneTransportStats)[];
const DEFAULT_PLAYWRIGHT_ARGS = [
  'terminal.e2e.ts',
  'terminal-cursor-motion.e2e.ts',
  'terminal-geometry-matrix.e2e.ts',
  'terminal-input-matrix.e2e.ts',
  'terminal-performance-matrix.e2e.ts',
  'edge-sweep.e2e.ts',
  'transport-latency.e2e.ts',
  '--workers=1',
];
const DEFAULT_RECOVERY_PLAYWRIGHT_ARGS = [
  'carrier-rebind.e2e.ts',
  'display-resync-recovery.e2e.ts',
  '--workers=1',
];

export type NetworkMatrixPhase = 'workload' | 'recovery';

export interface NetworkMatrixCell {
  readonly phase: NetworkMatrixPhase;
  readonly profile: EdgeNetworkProfileName;
  readonly datagramLossPercent: EdgeNetworkDatagramLossPercent;
  readonly reorder: EdgeNetworkReorderMode;
  readonly scenario: EdgeNetworkScenario;
  readonly seed: number;
}

interface MatrixOptions {
  readonly outputPath: string;
  readonly seeds: readonly number[];
  readonly profiles: readonly EdgeNetworkProfileName[];
  readonly datagramLossPercentages: readonly EdgeNetworkDatagramLossPercent[];
  readonly includeStress: boolean;
  readonly includeRecovery: boolean;
  readonly playwrightArgs: readonly string[];
  readonly recoveryPlaywrightArgs: readonly string[];
}

export type { PercentileDistribution } from '../tests/e2e/fixtures/terminal-perf-replay';

interface CapturedLatencySummary {
  readonly artifact: string;
  /** Mandatory raw trace retained for independent re-analysis. */
  readonly rawEvents: {
    readonly artifact: string | null;
    readonly sha256: string | null;
    readonly eventCount: number | null;
    /** Hash of the full replayed report except its intentionally bounded sample list. */
    readonly reportSha256: string | null;
    readonly applicationDisplayOutcomeSha256: string | null;
    /** Full replay-derived values, never percentiles copied from a summary. */
    readonly metricSamples: RawTerminalMetricSamples;
    /** Per-metric analyzer validity; trace validity alone cannot make a censored tail complete. */
    readonly metricComplete: Readonly<Record<RawTerminalMetricName, boolean>>;
    readonly complete: boolean;
    readonly error: string | null;
  };
  readonly testId: string;
  readonly testTitle: string;
  readonly testFile: string;
  readonly testStatus: string | null;
  readonly testExpectedStatus: string;
  /** Exact measurement-only daemon/browser authoritative-grid proofs. */
  readonly gridConvergence: CapturedGridConvergenceEvidence;
  /** Exact completed logical-workload windows represented by this summary. */
  readonly measurementWindowCount: number;
  /** Null for diagnostics with no exact window; windowed tests use one explicit purpose. */
  readonly measurementPurpose: TerminalPresentationMeasurementPurpose | null;
  readonly complete: boolean;
  readonly errors: readonly string[];
  readonly metrics: Readonly<Record<string, PercentileDistribution>>;
  /** Browser-observed display sequences; distinct from proxy UDP packet counters. */
  readonly applicationDisplayOutcome: unknown;
  /** Exact proxy-control snapshot taken for this terminal-perf artifact. */
  readonly proxyImpairment: ProxyImpairmentStats | null;
  /** Fault families positively observed within this summary's reset epoch. */
  readonly proxyFaultEvidence: ProxyFaultEvidence;
}

type GridConvergenceProbePurpose = 'reset-precondition' | 'observation-ack' | 'final-verification';

interface CapturedGridConvergenceProbe {
  readonly purpose: GridConvergenceProbePurpose;
  readonly repair: boolean;
  readonly result: PerfGridConvergenceResult;
}

interface CapturedGridConvergenceEvidence {
  readonly complete: boolean;
  readonly error: string | null;
  readonly selectiveRepairCount: number;
  readonly probes: readonly CapturedGridConvergenceProbe[];
}

export const RAW_TERMINAL_SAMPLE_METRICS = TERMINAL_LATENCY_RAW_METRIC_NAMES;
export type RawTerminalMetricName = TerminalLatencyRawMetricName;
export type RawTerminalMetricSamples = TerminalLatencyRawMetricSamples;

export interface MatrixRawSampleRollup {
  readonly scope: {
    readonly phase: NetworkMatrixPhase;
    readonly profile: EdgeNetworkProfileName;
    readonly datagramLossPercent: EdgeNetworkDatagramLossPercent;
    readonly reorder: EdgeNetworkReorderMode;
    readonly scenario: EdgeNetworkScenario;
  };
  readonly expectedRunCount: number;
  readonly acceptedRunCount: number;
  readonly traceCount: number;
  readonly replayVerifiedTraceCount: number;
  readonly rawEventCount: number;
  readonly complete: boolean;
  readonly metrics: Readonly<Record<RawTerminalMetricName, PercentileDistribution>>;
}

export interface MatrixRawSampleWorkloadRollup extends Omit<MatrixRawSampleRollup, 'scope'> {
  readonly scope: {
    readonly phase: 'workload';
    readonly profile: EdgeNetworkProfileName;
    readonly testFile: string;
    readonly testTitle: string;
  };
}

export interface MatrixRawSamplePurposeRollup extends Omit<MatrixRawSampleRollup, 'scope'> {
  readonly scope: {
    readonly phase: 'workload';
    readonly profile: EdgeNetworkProfileName;
    readonly purpose: 'coherent-redraw';
  };
}

export const MATRIX_PROXY_DELAY_METRICS = [
  'upstream.scheduledDelayUs',
  'downstream.scheduledDelayUs',
  'upstream.releaseTargetResidenceUs',
  'downstream.releaseTargetResidenceUs',
  'upstream.actualResidenceUs',
  'downstream.actualResidenceUs',
  'upstream.releaseOvershootUs',
  'downstream.releaseOvershootUs',
] as const;
export type MatrixProxyDelayMetricName = (typeof MATRIX_PROXY_DELAY_METRICS)[number];

export interface MatrixProxyDelayDistribution extends PercentileDistribution {
  readonly histogramBucketUs: typeof PROXY_DELAY_HISTOGRAM_BUCKET_US;
  readonly histogram: readonly number[];
  readonly saturatedBucketCount: number;
}

export interface MatrixProxyDelayRollup {
  readonly scope: MatrixRawSampleRollup['scope'];
  readonly expectedRunCount: number;
  readonly acceptedRunCount: number;
  readonly snapshotCount: number;
  readonly complete: boolean;
  readonly metrics: Readonly<Record<MatrixProxyDelayMetricName, MatrixProxyDelayDistribution>>;
}

export interface MatrixRawSampleRollups {
  readonly weighting: 'one observation per non-null replayed analyzer sample; never a percentile of percentiles';
  readonly exactScenarios: readonly MatrixRawSampleRollup[];
  readonly cleanWorkloadByProfile: readonly MatrixRawSampleRollup[];
  /** Clean traces stratified by workload so high-rate input cannot hide redraw tails. */
  readonly cleanWorkloadByTest: readonly MatrixRawSampleWorkloadRollup[];
  /** Canonical clean redraw-workload mixture, not a homogeneous per-workload tail. */
  readonly coherentRedrawByProfile: readonly MatrixRawSamplePurposeRollup[];
  /** Replayed 500us proxy histograms; never percentiles pooled from summaries. */
  readonly proxyDelayByScenario: readonly MatrixProxyDelayRollup[];
}

export interface MatrixRawSampleRun {
  readonly id: string;
  readonly cell: NetworkMatrixCell;
  readonly exitCode: number;
  readonly daemonTransport: { readonly complete: boolean };
  readonly latencyEvidenceErrors: readonly string[];
  readonly latencySummaries: readonly {
    readonly testFile: string;
    readonly testTitle: string;
    readonly measurementPurpose: TerminalPresentationMeasurementPurpose | null;
    readonly proxyImpairment: ProxyImpairmentStats | null;
    readonly rawEvents: {
      readonly complete: boolean;
      readonly eventCount: number | null;
      readonly metricSamples: RawTerminalMetricSamples;
      readonly metricComplete: Readonly<Record<RawTerminalMetricName, boolean>>;
    };
  }[];
}

interface DaemonTransportFinalCapture {
  readonly daemonId: string;
  readonly captureRequestedAtMs: number;
  readonly captureCompletedAtMs: number;
  readonly healthCheckedAtMs: number;
  readonly observedAtMs: number;
  readonly sampleCount: number;
  readonly captureRequestToSampleMs: number;
  readonly sampleToRunEndMs: number;
  readonly captureCompletionToRunEndMs: number;
  readonly latest: DataplaneTransportStats;
  readonly aggregate: DataplaneTransportStats;
}

export interface CapturedDaemonTransportEvidence {
  readonly artifact: string | null;
  readonly sha256: string | null;
  readonly complete: boolean;
  readonly errors: readonly string[];
  readonly captureCount: number;
  readonly daemonCount: number;
  readonly freshAtRunEnd: boolean;
  readonly latestByDaemon: readonly DaemonTransportFinalCapture[];
}

interface DaemonTransportEvidenceAccumulator {
  readonly artifact: string | null;
  readonly sha256: string | null;
  readonly errors: string[];
  readonly latestByDaemon: Map<string, DaemonTransportFinalCapture>;
  captureCount: number;
}

interface MatrixRunRecord {
  readonly id: string;
  readonly cell: NetworkMatrixCell;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly exitCode: number;
  readonly harnessResult: unknown;
  readonly latencySummaries: readonly CapturedLatencySummary[];
  readonly latencyEvidenceErrors: readonly string[];
  readonly daemonTransport: CapturedDaemonTransportEvidence;
}

export interface CompatibleMatrixCheckpoint {
  readonly startedAt: string;
  readonly runs: readonly MatrixRunRecord[];
}

/**
 * Exact requested matrix: 0/1/3% at 50 ms and 0/1/3/9% at 120/200 ms, each
 * under no and profile-appropriate reordering, plus one short-burst and one
 * temporary-congestion cell per RTT. The default plan adds four bounded
 * recovery phases per RTT without multiplying those long partition tests
 * across every workload cell.
 */
export function buildNetworkMatrixCells(
  profiles: readonly EdgeNetworkProfileName[],
  datagramLossPercentages: readonly EdgeNetworkDatagramLossPercent[],
  seeds: readonly number[],
  includeStress: boolean,
  includeRecovery: boolean,
): NetworkMatrixCell[] {
  const cells: NetworkMatrixCell[] = [];
  for (const seed of seeds) {
    for (const profile of profiles) {
      const profileReorder: EdgeNetworkReorderMode = profile === 'fast' ? 'light' : 'moderate';
      for (const datagramLossPercent of datagramLossPercentages) {
        // The requested fast-remote matrix stops at 3%; 9% belongs only to the
        // typical and difficult profiles.
        if (profile === 'fast' && datagramLossPercent === 9) continue;
        cells.push({
          phase: 'workload',
          profile,
          datagramLossPercent,
          reorder: 'none',
          scenario: 'steady',
          seed,
        });
        cells.push({
          phase: 'workload',
          profile,
          datagramLossPercent,
          reorder: profileReorder,
          scenario: 'steady',
          seed,
        });
      }
      if (includeStress) {
        cells.push({
          phase: 'workload',
          profile,
          datagramLossPercent: 0,
          reorder: 'none',
          scenario: 'burst-loss',
          seed,
        });
        cells.push({
          phase: 'workload',
          profile,
          datagramLossPercent: 3,
          reorder: profileReorder,
          scenario: 'congestion',
          seed,
        });
      }
      if (includeRecovery) {
        // Four bounded recovery phases per RTT cover the clean baseline plus
        // coexistence with exact loss/reorder, short burst loss, and temporary
        // congestion. This avoids multiplying carrier partitions across all 28
        // workload cells while still exercising every requested impairment
        // family against real rebind, incremental repair, and resync.
        const recoveryLoss: EdgeNetworkDatagramLossPercent = profile === 'fast' ? 3 : 9;
        cells.push(
          {
            phase: 'recovery',
            profile,
            datagramLossPercent: 0,
            reorder: 'none',
            scenario: 'steady',
            seed,
          },
          {
            phase: 'recovery',
            profile,
            datagramLossPercent: recoveryLoss,
            reorder: profileReorder,
            scenario: 'steady',
            seed,
          },
          {
            phase: 'recovery',
            profile,
            datagramLossPercent: 0,
            reorder: profileReorder,
            scenario: 'burst-loss',
            seed,
          },
          {
            phase: 'recovery',
            profile,
            datagramLossPercent: recoveryLoss,
            reorder: profileReorder,
            scenario: 'congestion',
            seed,
          },
        );
      }
    }
  }
  return cells;
}

export { validateApplicationDisplayOutcomeEvidence };

interface LatencySummaryEvidence {
  readonly artifact?: string;
  readonly testFile?: string;
  readonly testTitle: string;
  readonly testStatus?: string | null;
  readonly testExpectedStatus?: string;
  readonly measurementWindowCount: number;
  readonly complete: boolean;
}

export interface ExpectedTestEvidence {
  readonly file: string;
  readonly title: string;
}

export const REQUIRED_COHERENT_REDRAW_EVIDENCE = [
  { file: 'terminal-performance-matrix.e2e.ts', title: 'burst output: dense row burst' },
  { file: 'terminal-performance-matrix.e2e.ts', title: 'burst output: wide-cell burst' },
  {
    file: 'terminal-performance-matrix.e2e.ts',
    title: 'burst output: deterministic cat-style file stream',
  },
  {
    file: 'terminal-performance-matrix.e2e.ts',
    title: 'redraw: alternate-screen truecolor TUI commits coherently',
  },
  {
    file: 'edge-sweep.e2e.ts',
    title: 'sparse redraw over the edge has one authoritative GPU fence',
  },
] as const satisfies readonly ExpectedTestEvidence[];

function isCleanWorkload(cell: NetworkMatrixCell): boolean {
  return (
    cell.phase === 'workload' &&
    cell.datagramLossPercent === 0 &&
    cell.reorder === 'none' &&
    cell.scenario === 'steady'
  );
}

export const REQUIRED_TEST_EVIDENCE: Readonly<
  Record<NetworkMatrixPhase, readonly ExpectedTestEvidence[]>
> = {
  workload: [
    {
      file: 'terminal-performance-matrix.e2e.ts',
      title: 'interaction: isolated single-character feedback is independently fenced',
    },
    {
      file: 'terminal-performance-matrix.e2e.ts',
      title: 'interaction: isolated cursor-only changes are independently fenced',
    },
    {
      file: 'terminal-performance-matrix.e2e.ts',
      title: 'interaction: command submission reaches its first authoritative output',
    },
    {
      file: 'terminal-performance-matrix.e2e.ts',
      title: 'interaction: remote line editing remains authoritative and ordered',
    },
    {
      file: 'terminal-performance-matrix.e2e.ts',
      title: 'rapid typing: zero-delay keydown stream',
    },
    {
      file: 'terminal-input-matrix.e2e.ts',
      title: 'terminal interaction 11: history and completion remain authority-only',
    },
    {
      file: 'terminal-performance-matrix.e2e.ts',
      title: 'burst output: dense row burst',
    },
    {
      file: 'terminal-performance-matrix.e2e.ts',
      title: 'burst output: wide-cell burst',
    },
    {
      file: 'terminal-performance-matrix.e2e.ts',
      title: 'burst output: deterministic cat-style file stream',
    },
    {
      file: 'terminal-performance-matrix.e2e.ts',
      title: 'redraw: alternate-screen truecolor TUI commits coherently',
    },
    {
      file: 'terminal-performance-matrix.e2e.ts',
      title: 'resize under load: resize storm under output load',
    },
    {
      file: 'terminal-geometry-matrix.e2e.ts',
      title: 'resize reflow: the local rewrap already matches the daemon',
    },
    {
      file: 'terminal-performance-matrix.e2e.ts',
      title: 'stability: sustained output completes without disconnect or signaling reconnect',
    },
    {
      file: 'edge-sweep.e2e.ts',
      title: 'sparse redraw over the edge has one authoritative GPU fence',
    },
    {
      file: 'transport-latency.e2e.ts',
      title: 'terminal input remains responsive and observable end to end',
    },
  ],
  recovery: [
    {
      file: 'carrier-rebind.e2e.ts',
      title: 'a partitioned carrier rebinds in place and keeps its terminal',
    },
    {
      file: 'carrier-rebind.e2e.ts',
      title: 'a rebound carrier keeps its display generation and is repaired, not repainted',
    },
    {
      file: 'carrier-rebind.e2e.ts',
      title: 'recovery takes the rebind path without a server round trip',
    },
    {
      file: 'display-resync-recovery.e2e.ts',
      title: 'a forced profiling resync completes through an authoritative GPU-fenced snapshot',
    },
  ],
};

/**
 * Decide whether a cell has acceptance-grade latency evidence without turning
 * ordinary non-window terminal diagnostics into fake logical workloads.
 */
export function validateLatencySummaryEvidence(
  phase: NetworkMatrixPhase,
  summaries: readonly LatencySummaryEvidence[],
): string[] {
  if (summaries.length === 0) return ['cell produced no terminal latency summaries'];
  if (phase === 'recovery') {
    return summaries.flatMap((summary) =>
      summary.complete ? [] : [`recovery summary is incomplete: ${summary.testTitle}`],
    );
  }

  const windowSummaries = summaries.filter((summary) => summary.measurementWindowCount > 0);
  if (windowSummaries.length === 0) {
    return ['workload cell produced no explicit logical-workload measurement window'];
  }
  return windowSummaries.flatMap((summary) =>
    summary.complete ? [] : [`logical-workload summary is incomplete: ${summary.testTitle}`],
  );
}

const CARRIER_REPAIR_TEST_TITLE =
  'a rebound carrier keeps its display generation and is repaired, not repainted';
const FORCED_RESYNC_TEST_TITLE =
  'a forced profiling resync completes through an authoritative GPU-fenced snapshot';
const REPAIR_PRESENTATION_MINIMUM_ROWS = 23;

function completeSingletonMetric(
  metrics: Readonly<Record<string, PercentileDistribution>>,
  name: string,
): PercentileDistribution | null {
  const metric = metrics[name];
  return metric?.complete && metric.count === 1 ? metric : null;
}

function measurementPurposeFromPresentation(
  presentation: Record<string, unknown> | null,
  measurementWindowCount: number,
): TerminalPresentationMeasurementPurpose | null {
  if (measurementWindowCount === 0 || !isRecord(presentation?.measurementWindowCountByPurpose)) {
    return null;
  }
  const counts = presentation.measurementWindowCountByPurpose;
  for (const purpose of ['coherent-redraw', 'isolated-interactive', 'streaming'] as const) {
    if (counts[purpose] === measurementWindowCount) return purpose;
  }
  return null;
}

/**
 * Separate an ordinary coherent redraw from a later exact repair transaction.
 * Configured UDP impairment never relaxes this gate: only the commit reason
 * emitted by the repair marker can explain a second visible submission.
 */
export function validateWorkloadPresentationEvidence(
  cell: NetworkMatrixCell,
  measurementWindowCount: number,
  presentation: unknown,
  metrics: Readonly<Record<string, PercentileDistribution>>,
  applicationDisplayOutcome: unknown,
): string[] {
  if (cell.phase !== 'workload' || measurementWindowCount === 0) return [];
  const names = [
    'presentation.commitsPerPresentation',
    'presentation.partialPresentationExposureMs',
    'presentation.commitsPerMeasurementWindow',
    'presentation.ordinaryCommitsPerMeasurementWindow',
    'presentation.repairCommitsPerMeasurementWindow',
    'presentation.expiredRepairCommitsPerMeasurementWindow',
    'presentation.ordinaryMeasurementWindowExposureMs',
    'presentation.measurementWindowExposureMs',
  ] as const;
  const errors: string[] = [];
  if (!isRecord(presentation) || !isRecord(presentation.measurementWindowCountByPurpose)) {
    return ['presentation measurement-purpose evidence is missing'];
  }
  const purposeCounts = presentation.measurementWindowCountByPurpose;
  if (
    !hasExactKeys(purposeCounts, ['coherent-redraw', 'isolated-interactive', 'streaming']) ||
    !isNonNegativeSafeInteger(purposeCounts['coherent-redraw']) ||
    !isNonNegativeSafeInteger(purposeCounts['isolated-interactive']) ||
    !isNonNegativeSafeInteger(purposeCounts.streaming) ||
    purposeCounts['coherent-redraw'] +
      purposeCounts['isolated-interactive'] +
      purposeCounts.streaming !==
      measurementWindowCount ||
    [
      purposeCounts['coherent-redraw'],
      purposeCounts['isolated-interactive'],
      purposeCounts.streaming,
    ].filter((count) => count > 0).length !== 1
  ) {
    return ['presentation measurement purposes are invalid or mixed within one test'];
  }
  const strictAtomicWindow =
    purposeCounts['coherent-redraw'] === measurementWindowCount ||
    purposeCounts['isolated-interactive'] === measurementWindowCount;
  const required: Partial<Record<(typeof names)[number], PercentileDistribution>> = {};
  for (const name of names) {
    const metric = metrics[name];
    const expectedCount =
      name === 'presentation.commitsPerPresentation' ||
      name === 'presentation.partialPresentationExposureMs'
        ? null
        : measurementWindowCount;
    if (
      metric === undefined ||
      !metric.complete ||
      metric.count === 0 ||
      (expectedCount !== null && metric.count !== expectedCount)
    ) {
      errors.push(`${name} workload coherence evidence is incomplete`);
    } else {
      required[name] = metric;
    }
  }
  if (errors.length > 0) return errors;

  const max = (name: (typeof names)[number]): number =>
    required[name]?.worst ?? Number.POSITIVE_INFINITY;
  // Total per-id commit/exposure remains diagnostic: an independently lost
  // member can legitimately arrive later through exact FEC/row repair while
  // retaining its sender presentation id. Atomicity is accepted against the
  // exact logical window below, after repair-provenance commits are removed.
  if (strictAtomicWindow && max('presentation.ordinaryCommitsPerMeasurementWindow') > 1) {
    errors.push('a logical redraw used more than one ordinary presentation commit');
  }
  if (strictAtomicWindow && max('presentation.ordinaryMeasurementWindowExposureMs') !== 0) {
    errors.push('ordinary logical-redraw commits exposed a visible row sweep');
  }
  if (strictAtomicWindow && max('presentation.repairCommitsPerMeasurementWindow') > 1) {
    errors.push('a logical redraw fragmented across multiple repair commits');
  }
  if (isCleanWorkload(cell) && max('presentation.repairCommitsPerMeasurementWindow') !== 0) {
    errors.push('clean workload presentation was assisted by repair');
  }
  if (max('presentation.expiredRepairCommitsPerMeasurementWindow') !== 0) {
    errors.push('a repair presentation escaped through its deadline');
  }
  if (
    strictAtomicWindow &&
    max('presentation.repairCommitsPerMeasurementWindow') === 0 &&
    max('presentation.measurementWindowExposureMs') !== 0
  ) {
    errors.push('an unrepaired logical redraw exposed more than one visible sub-update');
  }
  if (
    isRecord(applicationDisplayOutcome) &&
    applicationDisplayOutcome.repairDeadlineExpiredCommitCount !== 0
  ) {
    errors.push('application display telemetry recorded an expired repair hold');
  }
  return errors;
}

/**
 * Recovery has its own exact visual oracle. A one-row repair can prove the
 * protocol branch ran while completely missing END-first/interior-hole sweep
 * failures, so the carrier sentinel must retain one multi-unit logical window
 * and finish it in one observed GPU-fenced commit.
 */
export function validateCarrierRepairPresentationEvidence(
  cell: NetworkMatrixCell,
  testFile: string,
  testTitle: string,
  measurementWindowCount: number,
  metrics: Readonly<Record<string, PercentileDistribution>>,
): string[] {
  if (
    cell.phase !== 'recovery' ||
    testTitle !== CARRIER_REPAIR_TEST_TITLE ||
    !normalizedTestFileMatches(testFile, 'carrier-rebind.e2e.ts')
  ) {
    return [];
  }

  const errors: string[] = [];
  if (measurementWindowCount !== 1) {
    errors.push('carrier-repair sentinel must contain exactly one presentation measurement window');
  }
  const requiredNames = [
    'presentation.commitsPerMeasurementWindow',
    'presentation.rowsPerMeasurementWindow',
    'presentation.datagramsPerMeasurementWindow',
    'presentation.bytesPerMeasurementWindow',
    'presentation.measurementWindowExposureMs',
    'presentation.firstDisplayReceiveToCompletedPresentationFenceMs',
    'presentation.refreshPeriodPerMeasurementWindowMs',
    'presentation.fenceObservationIntervalPerMeasurementWindowMs',
  ] as const;
  const required = Object.fromEntries(
    requiredNames.map((name) => [name, completeSingletonMetric(metrics, name)]),
  ) as Record<(typeof requiredNames)[number], PercentileDistribution | null>;
  for (const name of requiredNames) {
    if (required[name] === null) errors.push(`${name} recovery evidence is incomplete`);
  }
  if (errors.length > 0) return errors;

  const commits = required['presentation.commitsPerMeasurementWindow'];
  const rows = required['presentation.rowsPerMeasurementWindow'];
  const datagrams = required['presentation.datagramsPerMeasurementWindow'];
  const exposure = required['presentation.measurementWindowExposureMs'];
  const firstReceiveToFence =
    required['presentation.firstDisplayReceiveToCompletedPresentationFenceMs'];
  const refresh = required['presentation.refreshPeriodPerMeasurementWindowMs'];
  const fencePoll = required['presentation.fenceObservationIntervalPerMeasurementWindowMs'];
  if (commits?.median !== 1 || commits.p95 !== 1 || commits.p99 !== 1 || commits.worst !== 1) {
    errors.push('carrier-repair window was not presented in exactly one GPU-fenced commit');
  }
  if ((rows?.median ?? 0) < REPAIR_PRESENTATION_MINIMUM_ROWS) {
    errors.push('carrier-repair window did not carry a full-screen row repair');
  }
  if ((datagrams?.median ?? 0) < 2) {
    errors.push('carrier-repair window did not span multiple independent display units');
  }
  if (exposure?.worst !== 0) {
    errors.push('carrier-repair window exposed more than one visible GPU-fenced sub-update');
  }

  const refreshMs = refresh?.worst ?? Number.POSITIVE_INFINITY;
  const fencePollMs = fencePoll?.worst ?? Number.POSITIVE_INFINITY;
  const observedMs = firstReceiveToFence?.worst ?? Number.POSITIVE_INFINITY;
  const profile = EDGE_NETWORK_PROFILES[cell.profile];
  const oneWayJitterMs = profile.oneWayJitterUs / 1_000;
  const maxExtraDelayMs =
    (cell.reorder === 'none' ? 0 : oneWayJitterMs) +
    (cell.scenario === 'congestion' ? 32 : 0) +
    (cell.scenario === 'handshake-split' ? profile.hopDelayUs / 1_000 : 0);
  // Repair rows remain independent datagrams; the ordered repair END travels
  // on CTRL. Two RTTs cover packet-threshold/tail-loss resolution plus one
  // row retry. The remaining terms are the advertised one-fault-site delivery
  // skew and two local frame opportunities.
  const receiptToFenceBudgetMs =
    profile.targetRttMs * 2 + oneWayJitterMs + maxExtraDelayMs + refreshMs * 2 + fencePollMs + 24;
  if (!Number.isFinite(observedMs) || observedMs > receiptToFenceBudgetMs) {
    errors.push(
      `carrier-repair first-receipt-to-GPU-fence ${observedMs}ms exceeded ${receiptToFenceBudgetMs}ms`,
    );
  }
  return errors;
}

/** Exact request-to-fence presentation contract for the real snapshot path. */
export function validateForcedResyncPresentationEvidence(
  cell: NetworkMatrixCell,
  testFile: string,
  testTitle: string,
  measurementWindowCount: number,
  metrics: Readonly<Record<string, PercentileDistribution>>,
): string[] {
  if (
    cell.phase !== 'recovery' ||
    testTitle !== FORCED_RESYNC_TEST_TITLE ||
    !normalizedTestFileMatches(testFile, 'display-resync-recovery.e2e.ts')
  ) {
    return [];
  }
  const errors: string[] = [];
  if (measurementWindowCount !== 1) {
    errors.push('forced-resync sentinel must contain exactly one presentation measurement window');
  }
  const requiredNames = [
    'presentation.commitsPerMeasurementWindow',
    'presentation.rowsPerMeasurementWindow',
    'presentation.datagramsPerMeasurementWindow',
    'presentation.bytesPerMeasurementWindow',
    'presentation.measurementWindowExposureMs',
    'presentation.measurementWindowToCompletedAuthoritativePresentationFenceMs',
    'presentation.firstDisplayReceiveToCompletedPresentationFenceMs',
    'presentation.refreshPeriodPerMeasurementWindowMs',
    'presentation.fenceObservationIntervalPerMeasurementWindowMs',
  ] as const;
  const required = Object.fromEntries(
    requiredNames.map((name) => [name, completeSingletonMetric(metrics, name)]),
  ) as Record<(typeof requiredNames)[number], PercentileDistribution | null>;
  for (const name of requiredNames) {
    if (required[name] === null) errors.push(`${name} forced-resync evidence is incomplete`);
  }
  if (errors.length > 0) return errors;
  const commits = required['presentation.commitsPerMeasurementWindow'];
  const rows = required['presentation.rowsPerMeasurementWindow'];
  const datagrams = required['presentation.datagramsPerMeasurementWindow'];
  const bytes = required['presentation.bytesPerMeasurementWindow'];
  const exposure = required['presentation.measurementWindowExposureMs'];
  if (commits?.median !== 1 || commits.p95 !== 1 || commits.p99 !== 1 || commits.worst !== 1) {
    errors.push('forced-resync snapshot was not presented in exactly one GPU-fenced commit');
  }
  if ((rows?.median ?? 0) <= 0 || (datagrams?.median ?? 0) <= 0 || (bytes?.median ?? 0) <= 0) {
    errors.push('forced-resync snapshot window carried no authoritative display payload');
  }
  if (exposure?.worst !== 0) {
    errors.push('forced-resync snapshot exposed more than one visible GPU-fenced sub-update');
  }

  const profile = EDGE_NETWORK_PROFILES[cell.profile];
  const oneWayJitterMs = profile.oneWayJitterUs / 1_000;
  const maxExtraOneWayMs =
    (cell.reorder === 'none' ? 0 : oneWayJitterMs) + (cell.scenario === 'congestion' ? 32 : 0);
  const refreshMs =
    required['presentation.refreshPeriodPerMeasurementWindowMs']?.worst ?? Number.POSITIVE_INFINITY;
  const pollMs =
    required['presentation.fenceObservationIntervalPerMeasurementWindowMs']?.worst ??
    Number.POSITIVE_INFINITY;
  const budgetMs =
    profile.targetRttMs * 3 +
    oneWayJitterMs * 2 +
    maxExtraOneWayMs * 2 +
    refreshMs * 2 +
    pollMs +
    150;
  const windowToFence =
    required['presentation.measurementWindowToCompletedAuthoritativePresentationFenceMs']?.worst ??
    Number.POSITIVE_INFINITY;
  if (!Number.isFinite(windowToFence) || windowToFence > budgetMs) {
    errors.push(`forced-resync request-to-GPU-fence ${windowToFence}ms exceeded ${budgetMs}ms`);
  }
  const receiveToFence =
    required['presentation.firstDisplayReceiveToCompletedPresentationFenceMs']?.worst ??
    Number.POSITIVE_INFINITY;
  if (!Number.isFinite(receiveToFence) || receiveToFence > budgetMs) {
    errors.push(
      `forced-resync first-receipt-to-GPU-fence ${receiveToFence}ms exceeded ${budgetMs}ms`,
    );
  }
  return errors;
}

const BROWSER_DISPLAY_IO_DISTRIBUTIONS = [
  'browserDisplayIo.endToEndExplicitCopiesPerUpdate',
  'browserDisplayIo.endToEndExplicitCopiedBytesPerPayloadByte',
  'browserDisplayIo.endToEndExplicitAllocationRequestsPerUpdate',
  'browserDisplayIo.endToEndExplicitAllocationRequestedBytesPerUpdate',
  'browserDisplayIo.endToEndExplicitAllocationRequestedBytesPerPayloadByte',
  'browserDisplayIo.endToEndExplicitObjectAllocationRequestsPerUpdate',
] as const;

/** Fail closed on browser accounting and exact-window main-thread evidence. */
export function validateBrowserRuntimeEvidence(
  cell: NetworkMatrixCell,
  measurementWindowCount: number,
  report: unknown,
  metrics: Readonly<Record<string, PercentileDistribution>>,
): string[] {
  const errors: string[] = [];
  if (!isRecord(report) || !isRecord(report.browserDisplayIo)) {
    return ['browser display I/O evidence is missing'];
  }
  const displayIo = report.browserDisplayIo;
  if (displayIo.scope !== BROWSER_DISPLAY_IO_SCOPE) {
    errors.push('browser display I/O accounting scope is invalid');
  }
  if (displayIo.complete !== true) errors.push('browser display I/O evidence is incomplete');

  const displayIoCounterNames = [
    'transportIngressUpdateCount',
    'rejectedTransportIngressUpdateCount',
    'terminalApplyUpdateCount',
    'endToEndMatchedUpdateCount',
    'fecRecoveredTerminalApplyUpdateCount',
    'endToEndMatchedPayloadByteCount',
    'payloadByteCount',
    'explicitCopyCount',
    'explicitCopiedByteCount',
    'explicitAllocationRequestCount',
    'explicitAllocationRequestedByteCount',
    'explicitObjectAllocationRequestCount',
  ] as const;
  for (const name of displayIoCounterNames) {
    if (!isNonNegativeSafeInteger(displayIo[name])) {
      errors.push(`browser display I/O counter ${name} is invalid`);
    }
  }
  if (displayIo.rejectedTransportIngressUpdateCount !== 0) {
    errors.push('browser display transport ingress rejected an update');
  }
  const terminalApplyCount = displayIo.terminalApplyUpdateCount;
  const matchedCount = displayIo.endToEndMatchedUpdateCount;
  const fecRecoveredCount = displayIo.fecRecoveredTerminalApplyUpdateCount;
  const coverage = displayIo.endToEndCoverageRatio;
  if (isNonNegativeSafeInteger(terminalApplyCount) && terminalApplyCount === 0) {
    if (matchedCount !== 0 || fecRecoveredCount !== 0 || coverage !== null) {
      errors.push('empty browser display I/O evidence reported an impossible matched coverage');
    }
  } else if (
    !isNonNegativeSafeInteger(terminalApplyCount) ||
    typeof coverage !== 'number' ||
    !Number.isFinite(coverage) ||
    coverage !== 1 ||
    !isNonNegativeSafeInteger(matchedCount) ||
    !isNonNegativeSafeInteger(fecRecoveredCount) ||
    matchedCount + fecRecoveredCount !== terminalApplyCount
  ) {
    errors.push('browser display I/O end-to-end coverage ratio is invalid');
  }
  for (const name of BROWSER_DISPLAY_IO_DISTRIBUTIONS) {
    const metric = metrics[name];
    if (
      metric === undefined ||
      !metric.complete ||
      !isNonNegativeSafeInteger(matchedCount) ||
      metric.count !== matchedCount
    ) {
      errors.push(`${name} evidence is incomplete`);
    }
  }

  if (!isRecord(report.displayPipeline)) {
    errors.push('browser display-pump evidence is missing');
  } else {
    const displayPipeline = report.displayPipeline;
    const pumpDuration = metrics['displayPipeline.pumpDurationMs'];
    const pumpCount = pumpDuration?.count ?? -1;
    for (const name of [
      'displayPipeline.encodedDeferralQueueHighWaterPerPump',
      'displayPipeline.ringBytesAtPumpStart',
      'displayPipeline.ringBytesAtPumpEnd',
    ] as const) {
      const metric = metrics[name];
      if (
        metric === undefined ||
        !metric.complete ||
        !pumpDuration?.complete ||
        pumpCount <= 0 ||
        metric.count !== pumpCount
      ) {
        errors.push(`${name} evidence is incomplete`);
      }
    }
    if (
      !isRecord(displayPipeline.encodedDeferralQueueRemainingPerPump) ||
      displayPipeline.encodedDeferralQueueRemainingPerPump.complete !== true ||
      displayPipeline.encodedDeferralQueueRemainingPerPump.count !== pumpCount
    ) {
      errors.push('displayPipeline.encodedDeferralQueueRemainingPerPump evidence is incomplete');
    }
    if (measurementWindowCount > 0) {
      const refused = metrics['displayPipeline.ringRefusedFrameCountPerMeasurementWindow'];
      const refusedBetween =
        metrics['displayPipeline.ringRefusedFrameCountBetweenMeasurementWindows'];
      const expectedBetweenCount = Math.max(0, measurementWindowCount - 1);
      if (
        displayPipeline.ringRefusalAccountingComplete !== true ||
        !isNonNegativeSafeInteger(displayPipeline.ringRefusedFrameCount) ||
        refused === undefined ||
        !refused.complete ||
        refused.count !== measurementWindowCount ||
        refusedBetween === undefined ||
        !refusedBetween.complete ||
        refusedBetween.count !== expectedBetweenCount
      ) {
        errors.push('display-ring refusal evidence is incomplete');
      } else if (
        displayPipeline.ringRefusedFrameCount !== 0 ||
        refused.worst !== 0 ||
        (expectedBetweenCount > 0 && refusedBetween.worst !== 0)
      ) {
        // The fixed SAB is sized above every requested impairment burst. A
        // refusal is browser-local loss amplification, not expected network
        // loss, so no matrix profile is allowed to hide one.
        errors.push(
          `browser display ingress refused a frame-ring write in ${cell.profile}/${cell.scenario}`,
        );
      }
    }
  }

  if (measurementWindowCount > 0) {
    if (!isRecord(report.mainThread)) {
      errors.push('main-thread frame evidence is missing');
    } else {
      const mainThread = report.mainThread;
      if (mainThread.complete !== true) errors.push('main-thread frame evidence is incomplete');
      if (
        mainThread.measurementWindowCount !== measurementWindowCount ||
        mainThread.sampledMeasurementWindowCount !== measurementWindowCount
      ) {
        errors.push('main-thread cadence did not fully sample every presentation window');
      }
      if (!isNonNegativeSafeInteger(mainThread.intervalCount) || mainThread.intervalCount === 0) {
        errors.push('main-thread cadence recorded no frame interval');
      }
      if (
        !isNonNegativeSafeInteger(mainThread.estimatedMissedFrameCount) ||
        mainThread.estimatedMissedFrameCount !== 0 ||
        !isNonNegativeSafeInteger(mainThread.frameBudgetExceededIntervalCount) ||
        mainThread.frameBudgetExceededIntervalCount !== 0
      ) {
        // Network impairment can bunch display arrivals, but it does not buy
        // the browser another local frame. Both clean and impaired cells keep
        // the same zero-estimated-missed-frame acceptance threshold.
        errors.push('main thread missed an estimated browser refresh opportunity');
      }
      if (mainThread.longTaskObserverSupported !== true) {
        errors.push('browser long-task observation was unavailable');
      }
      if (
        !isNonNegativeSafeInteger(mainThread.longTaskCount) ||
        mainThread.longTaskCount !== 0 ||
        typeof mainThread.longTaskTotalMs !== 'number' ||
        !Number.isFinite(mainThread.longTaskTotalMs) ||
        mainThread.longTaskTotalMs !== 0
      ) {
        errors.push('main thread recorded a long task inside a presentation window');
      }

      const intervalCount = isNonNegativeSafeInteger(mainThread.intervalCount)
        ? mainThread.intervalCount
        : -1;
      for (const name of [
        'mainThread.rafGapMs',
        'mainThread.frameBudgetOverrunMs',
        'mainThread.estimatedMissedFramesPerGap',
      ]) {
        const metric = metrics[name];
        if (metric === undefined || !metric.complete || metric.count !== intervalCount) {
          errors.push(`${name} evidence is incomplete`);
        }
      }
      const missedPerWindow = metrics['mainThread.estimatedMissedFramesPerMeasurementWindow'];
      if (
        missedPerWindow === undefined ||
        !missedPerWindow.complete ||
        missedPerWindow.count !== measurementWindowCount ||
        missedPerWindow.worst !== 0
      ) {
        errors.push('mainThread.estimatedMissedFramesPerMeasurementWindow evidence is incomplete');
      }
      const longTasks = metrics['mainThread.longTaskDurationMs'];
      if (
        longTasks === undefined ||
        !longTasks.complete ||
        longTasks.count !== mainThread.longTaskCount
      ) {
        errors.push('mainThread.longTaskDurationMs evidence is incomplete');
      }
    }

    if (!isNonNegativeSafeInteger(terminalApplyCount) || terminalApplyCount === 0) {
      errors.push('browser display I/O recorded no terminal apply inside the logical window');
    }
    if (!isNonNegativeSafeInteger(matchedCount) || matchedCount === 0) {
      errors.push('browser display I/O recorded no matched ingress-to-apply update');
    }
    if (
      !isNonNegativeSafeInteger(displayIo.endToEndMatchedPayloadByteCount) ||
      displayIo.endToEndMatchedPayloadByteCount === 0
    ) {
      errors.push('browser display I/O recorded no matched payload bytes');
    }
  }
  return errors;
}

export function validateExpectedTestEvidence(
  summaries: readonly LatencySummaryEvidence[],
  expected: readonly ExpectedTestEvidence[],
): string[] {
  const errors: string[] = [];
  for (const sentinel of expected) {
    const matches = summaries.filter(
      (summary) =>
        summary.testTitle === sentinel.title &&
        summary.testFile !== undefined &&
        normalizedTestFileMatches(summary.testFile, sentinel.file),
    );
    if (matches.length !== 1) {
      errors.push(
        `expected exactly one ${sentinel.file} :: ${sentinel.title} result, observed ${matches.length}`,
      );
      continue;
    }
    const match = matches[0];
    if (
      match === undefined ||
      match.artifact === undefined ||
      match.artifact.length === 0 ||
      !match.complete ||
      match.testStatus !== 'passed' ||
      match.testExpectedStatus !== 'passed'
    ) {
      errors.push(`required test did not produce a passing artifact: ${sentinel.title}`);
    }
  }
  return errors;
}

export function validateProxyArtifactEvidence(
  value: unknown,
  cell: NetworkMatrixCell,
): {
  readonly stats: ProxyImpairmentStats | null;
  readonly evidence: ProxyFaultEvidence;
  readonly errors: readonly string[];
} {
  const stats = parseProxyImpairmentStats(value);
  if (stats === null) {
    return {
      stats: null,
      evidence: emptyProxyFaultEvidence(),
      errors: ['proxy impairment snapshot is missing or malformed'],
    };
  }
  const profile = EDGE_NETWORK_PROFILES[cell.profile];
  const errors = configuredProxyFaultEvidenceErrors(stats, {
    requireDrained: true,
    requireConfiguredFaultsObserved: false,
  });
  if (
    stats.config.profile !== cell.profile ||
    stats.config.targetRttMs !== profile.targetRttMs ||
    stats.config.baseDelayUs !== profile.hopDelayUs ||
    stats.config.jitterRadiusUs !== profile.oneWayJitterUs / 4 ||
    stats.config.datagramLossPercent !== cell.datagramLossPercent ||
    stats.config.reorder !== cell.reorder ||
    stats.config.scenario !== cell.scenario ||
    stats.config.seed !== cell.seed ||
    stats.logicalPathImpairment.requestedDatagramLossPercent !== cell.datagramLossPercent
  ) {
    errors.push('proxy impairment config does not exactly match its matrix cell');
  }
  return { stats, evidence: proxyFaultEvidence(stats), errors };
}

export function validateCellProxyFaultEvidence(
  cell: NetworkMatrixCell,
  summaries: readonly Pick<CapturedLatencySummary, 'proxyFaultEvidence'>[],
): string[] {
  if (summaries.length === 0) return ['cell produced no per-test proxy impairment snapshots'];
  const combined = summaries.reduce<ProxyFaultEvidence>(
    (evidence, summary) => ({
      exactLossObserved: evidence.exactLossObserved || summary.proxyFaultEvidence.exactLossObserved,
      exactLossSelectorWindowVerified:
        evidence.exactLossSelectorWindowVerified ||
        summary.proxyFaultEvidence.exactLossSelectorWindowVerified,
      reorderObserved: evidence.reorderObserved || summary.proxyFaultEvidence.reorderObserved,
      burstLossObserved: evidence.burstLossObserved || summary.proxyFaultEvidence.burstLossObserved,
      congestionObserved:
        evidence.congestionObserved || summary.proxyFaultEvidence.congestionObserved,
    }),
    emptyProxyFaultEvidence(),
  );
  const errors: string[] = [];
  if (cell.datagramLossPercent > 0 && !combined.exactLossObserved) {
    errors.push('cell never exercised configured exact downstream UDP loss after a trace reset');
  }
  if (cell.datagramLossPercent > 0 && !combined.exactLossSelectorWindowVerified) {
    errors.push('cell never verified a complete deterministic exact-loss selector window');
  }
  if (cell.reorder !== 'none' && !combined.reorderObserved) {
    errors.push('cell never exercised configured downstream reordering after a trace reset');
  }
  if (cell.scenario === 'burst-loss' && !combined.burstLossObserved) {
    errors.push('cell never exercised configured short downstream burst loss after a trace reset');
  }
  if (cell.scenario === 'congestion' && !combined.congestionObserved) {
    errors.push(
      'cell never exercised configured bounded downstream congestion after a trace reset',
    );
  }
  return errors;
}

export function validateCellDisplayFaultEvidence(
  cell: NetworkMatrixCell,
  summaries: readonly Pick<
    CapturedLatencySummary,
    'applicationDisplayOutcome' | 'proxyFaultEvidence'
  >[],
  daemonTransport: CapturedDaemonTransportEvidence,
): string[] {
  const requiresLoss = cell.datagramLossPercent > 0 || cell.scenario === 'burst-loss';
  const requiresReorder = cell.reorder !== 'none';
  if (!requiresLoss && !requiresReorder) return [];

  let sameEpochLossConsequence = false;
  let sameEpochReorderConsequence = false;
  for (const summary of summaries) {
    const outcome = summary.applicationDisplayOutcome;
    if (!isRecord(outcome)) continue;
    const lossObserved =
      (cell.datagramLossPercent > 0
        ? summary.proxyFaultEvidence.exactLossSelectorWindowVerified
        : false) || summary.proxyFaultEvidence.burstLossObserved;
    const displayLossConsequence =
      nonNegativeIntegerOrZero(outcome.interiorSequenceGapCount) > 0 ||
      nonNegativeIntegerOrZero(outcome.repairTargetSatisfiedCommitCount) > 0 ||
      nonNegativeIntegerOrZero(outcome.fecRecoveredVisualAppliedDatagramCount) > 0;
    sameEpochLossConsequence ||= lossObserved && displayLossConsequence;
    sameEpochReorderConsequence ||=
      summary.proxyFaultEvidence.reorderObserved &&
      nonNegativeIntegerOrZero(outcome.outOfOrderReceivedDatagramCount) > 0;
  }

  let declaredLost = 0;
  let recoveredByFec = 0;
  let rowsDeclaredLost = 0;
  for (const daemon of daemonTransport.latestByDaemon) {
    declaredLost +=
      daemon.aggregate.webtransport.displayDatagramsDeclaredLost +
      daemon.aggregate.edge.displayDatagramsDeclaredLost;
    recoveredByFec +=
      daemon.aggregate.webtransport.displayDatagramsRecoveredByFec +
      daemon.aggregate.edge.displayDatagramsRecoveredByFec;
    rowsDeclaredLost += daemon.aggregate.rowsDeclaredLost;
  }

  const errors: string[] = [];
  if (requiresLoss && !sameEpochLossConsequence) {
    errors.push(
      'no single reset epoch contains both configured packet loss and an observed display gap, visual FEC recovery, or exact row repair',
    );
  }
  if (requiresLoss && declaredLost === 0 && recoveredByFec === 0 && rowsDeclaredLost === 0) {
    errors.push(
      'daemon transport counters do not corroborate the observed display-loss consequence',
    );
  }
  if (requiresReorder && !sameEpochReorderConsequence) {
    errors.push(
      'no single reset epoch contains both configured packet reordering and an out-of-order application display datagram',
    );
  }
  return errors;
}

function nonNegativeIntegerOrZero(value: unknown): number {
  return isNonNegativeSafeInteger(value) ? value : 0;
}

function emptyProxyFaultEvidence(): ProxyFaultEvidence {
  return {
    exactLossObserved: false,
    exactLossSelectorWindowVerified: false,
    reorderObserved: false,
    burstLossObserved: false,
    congestionObserved: false,
  };
}

function validateMatrixRunLatencyEvidence(
  cell: NetworkMatrixCell,
  summaries: readonly CapturedLatencySummary[],
  daemonTransport: CapturedDaemonTransportEvidence,
): string[] {
  return [
    ...validateLatencySummaryEvidence(cell.phase, summaries),
    ...validateExpectedTestEvidence(summaries, REQUIRED_TEST_EVIDENCE[cell.phase]),
    ...summaries.flatMap((summary) =>
      summary.rawEvents.complete
        ? []
        : [`${summary.testTitle}: mandatory raw terminal event trace is incomplete`],
    ),
    ...summaries.flatMap((summary) =>
      validateProxyArtifactEvidence(summary.proxyImpairment, cell).errors.map(
        (error) => `${summary.testTitle}: ${error}`,
      ),
    ),
    ...validateCellProxyFaultEvidence(cell, summaries),
    ...validateCellDisplayFaultEvidence(cell, summaries, daemonTransport),
    ...validateDaemonNetworkProfileEvidence(cell, daemonTransport),
  ];
}

/**
 * Confirm that the daemon's authenticated heartbeat RTT observed the requested
 * four-leg application path. This is deliberately separate from the proxy's
 * userspace enqueue-to-release residence; neither measurement includes the
 * other's boundary.
 */
export function validateDaemonNetworkProfileEvidence(
  cell: NetworkMatrixCell,
  evidence: CapturedDaemonTransportEvidence,
): string[] {
  if (!evidence.complete) return ['daemon transport evidence is incomplete'];
  const profile = EDGE_NETWORK_PROFILES[cell.profile];
  const expectedRttUs = profile.targetRttMs * 1_000;
  const reorderRoundTripAllowanceUs = cell.reorder === 'none' ? 0 : profile.oneWayJitterUs * 2;
  const congestionRoundTripAllowanceUs = cell.scenario === 'congestion' ? 64_000 : 0;
  // A bounded host/EWMA margin still rejects a bypassed 50/120/200ms profile.
  const minimumRttUs = Math.max(5_000, Math.floor(expectedRttUs * 0.5));
  const maximumRttUs =
    expectedRttUs +
    profile.oneWayJitterUs * 2 +
    reorderRoundTripAllowanceUs +
    congestionRoundTripAllowanceUs +
    25_000;
  const errors: string[] = [];
  let livePathCount = 0;
  for (const daemon of evidence.latestByDaemon) {
    for (const [scope, stats] of [
      ['latest', daemon.latest],
      ['aggregate', daemon.aggregate],
    ] as const) {
      for (const [pathName, pathStats] of [
        ['webtransport', stats.webtransport],
        ['edge', stats.edge],
      ] as const) {
        if (pathStats.pathsLive === 0) continue;
        livePathCount += pathStats.pathsLive;
        if (
          pathStats.networkRttEwmaUsMax < minimumRttUs ||
          pathStats.networkRttEwmaUsMax > maximumRttUs
        ) {
          errors.push(
            `${daemon.daemonId} ${scope} ${pathName} heartbeat RTT ${pathStats.networkRttEwmaUsMax}us is outside the ${cell.profile} profile range ${minimumRttUs}..${maximumRttUs}us`,
          );
        }
      }
    }
  }
  if (livePathCount === 0)
    errors.push('daemon transport evidence contains no live path RTT sample');
  return errors;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const cells = buildNetworkMatrixCells(
    options.profiles,
    options.datagramLossPercentages,
    options.seeds,
    options.includeStress,
    options.includeRecovery,
  );
  if (cells.length === 0) {
    throw new Error('the selected profiles and loss percentages produce no matrix cells');
  }
  await buildMatrixRuntimeArtifacts();
  await mkdir(path.dirname(options.outputPath), { recursive: true });
  const runArtifactsDirectory = `${options.outputPath}.artifacts`;
  await mkdir(runArtifactsDirectory, { recursive: true });
  const sourceFingerprint = await computeExecutionFingerprint();

  const plannedCellIds = cells.map(matrixCellId);
  const checkpoint = await loadCompatibleMatrixCheckpoint(
    options.outputPath,
    cells,
    options.playwrightArgs,
    options.includeRecovery ? options.recoveryPlaywrightArgs : [],
    sourceFingerprint,
  );
  const matrixStartedAt = checkpoint?.startedAt ?? new Date().toISOString();
  const runs: MatrixRunRecord[] = checkpoint === null ? [] : [...checkpoint.runs];
  const completedIds = new Set(runs.map((run) => run.id));
  if (runs.length > 0) {
    process.stdout.write(
      `[network-matrix] resuming ${runs.length}/${cells.length} completed cells from ${options.outputPath}\n`,
    );
  }
  await writeCheckpoint(
    options,
    plannedCellIds,
    sourceFingerprint,
    matrixStartedAt,
    cells,
    runs,
    options.outputPath,
  );

  for (let index = 0; index < cells.length; index += 1) {
    const cell = cells[index];
    if (cell === undefined) throw new Error(`missing matrix cell ${index}`);
    const id = matrixCellId(cell);
    if (completedIds.has(id)) {
      process.stdout.write(`[network-matrix] ${index + 1}/${cells.length} ${id} (checkpointed)\n`);
      continue;
    }
    const resultPath = path.join(
      runArtifactsDirectory,
      `${String(index).padStart(3, '0')}-${id}.json`,
    );
    if ((await computeExecutionFingerprint()) !== sourceFingerprint) {
      throw new Error(
        'repository source or executed artifact changed after the matrix plan was created',
      );
    }
    const startedAtMs = Date.now();
    process.stdout.write(`[network-matrix] ${index + 1}/${cells.length} ${id}\n`);
    const environment = matrixEnvironment(cell, resultPath);
    await unlinkIfPresent(daemonLogPath(resultPath));
    const child = Bun.spawn(
      ['bun', 'run', 'scripts/run-edge-harness.ts', ...playwrightArgsForCell(options, cell)],
      { cwd: ROOT, env: environment, stdout: 'inherit', stderr: 'inherit' },
    );
    const exitCode = await child.exited;
    const finishedAtMs = Date.now();
    if ((await computeExecutionFingerprint()) !== sourceFingerprint) {
      throw new Error(
        `repository source or executed artifact changed while matrix cell ${id} was running`,
      );
    }
    const harnessResult = await readJsonIfPresent(resultPath);
    const capturedArtifactsDirectory = path.join(
      runArtifactsDirectory,
      `${String(index).padStart(3, '0')}-${id}`,
    );
    const latencySummaries = await captureLatencySummaries(
      startedAtMs,
      capturedArtifactsDirectory,
      cell,
    );
    const daemonTransport = await captureDaemonTransportEvidence(
      daemonLogPath(resultPath),
      capturedArtifactsDirectory,
      finishedAtMs,
    );
    const latencyEvidenceErrors = validateMatrixRunLatencyEvidence(
      cell,
      latencySummaries,
      daemonTransport,
    );
    runs.push({
      id,
      cell,
      startedAt: new Date(startedAtMs).toISOString(),
      durationMs: finishedAtMs - startedAtMs,
      exitCode,
      harnessResult,
      latencySummaries,
      latencyEvidenceErrors,
      daemonTransport,
    });
    if (exitCode === 0 && daemonTransport.complete && latencyEvidenceErrors.length === 0) {
      completedIds.add(id);
    }
    await writeCheckpoint(
      options,
      plannedCellIds,
      sourceFingerprint,
      matrixStartedAt,
      cells,
      runs,
      options.outputPath,
    );
  }

  const failures = runs.filter(
    (run) =>
      run.exitCode !== 0 || !run.daemonTransport.complete || run.latencyEvidenceErrors.length > 0,
  );
  process.stdout.write(
    `[network-matrix] wrote ${runs.length} runs (${failures.length} failed or missing complete latency/transport evidence) to ${options.outputPath}\n`,
  );
  const headlineEvidenceErrors = validateMatrixHeadlineEvidence(
    cells,
    buildMatrixRawSampleRollups(cells, runs),
  );
  for (const error of headlineEvidenceErrors) {
    process.stderr.write(`[network-matrix] incomplete headline evidence: ${error}\n`);
  }
  if (failures.length > 0 || headlineEvidenceErrors.length > 0) process.exitCode = 1;
}

async function writeCheckpoint(
  options: MatrixOptions,
  plannedCellIds: readonly string[],
  sourceFingerprint: string,
  matrixStartedAt: string,
  cells: readonly NetworkMatrixCell[],
  runs: readonly MatrixRunRecord[],
  outputPath: string,
): Promise<void> {
  const runById = new Map(runs.map((run) => [run.id, run]));
  const orderedRuns = cells.flatMap((cell) => {
    const run = runById.get(matrixCellId(cell));
    return run === undefined ? [] : [run];
  });
  const rawSampleRollups = buildMatrixRawSampleRollups(cells, orderedRuns);
  const headlineEvidenceErrors = validateMatrixHeadlineEvidence(cells, rawSampleRollups);
  await writeMatrixArtifact(outputPath, {
    schemaVersion: MATRIX_ARTIFACT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    startedAt: matrixStartedAt,
    complete:
      headlineEvidenceErrors.length === 0 &&
      orderedRuns.length === cells.length &&
      orderedRuns.every(
        (run) =>
          run.exitCode === 0 &&
          run.daemonTransport.complete &&
          run.latencyEvidenceErrors.length === 0,
      ),
    plan: {
      cellIds: plannedCellIds,
      sourceFingerprint,
      playwrightArgsByPhase: {
        workload: options.playwrightArgs,
        recovery: options.includeRecovery ? options.recoveryPlaywrightArgs : [],
      },
    },
    methodology: {
      matrixArtifactSchemaVersion: MATRIX_ARTIFACT_SCHEMA_VERSION,
      sourceFingerprint,
      edgeHarnessArtifactSchemaVersion: 2,
      delayProxyControlSchemaVersion: PROXY_IMPAIRMENT_SCHEMA_VERSION,
      applicationRttCrossesProxyLegs: 4,
      profileOrder: options.profiles,
      datagramLossPercentagesByProfile: Object.fromEntries(
        options.profiles.map((profile) => [
          profile,
          options.datagramLossPercentages.filter((loss) => profile !== 'fast' || loss !== 9),
        ]),
      ),
      destructiveImpairmentFaultSite: 'edge-to-client',
      faultSitesPerLogicalDirection: 1,
      proxyLossUnit: 'downstream UDP packet selected in exact complete 100-packet windows',
      applicationDisplayOutcomeSource: 'browser display-sequence telemetry',
      proxyScheduledDelaySemantics:
        'controller-selected delay; excludes Tokio, socket, kernel, and QUIC queue residence',
      proxyActualResidenceSemantics:
        'monotonic userspace enqueue-to-release residence immediately before socket send; excludes socket, kernel, edge, QUIC, and browser transit',
      rawLatencyRollupWeighting: rawSampleRollups.weighting,
      daemonTransportSampleCadenceMs: DATAPLANE_TRANSPORT_SAMPLE_CADENCE_MS,
      daemonTransportEvidence:
        'SIGUSR2 requests one synchronous Rust owner-loop partial-window sample after Playwright and before daemon teardown; the matrix accepts only the resulting capture record whose raw observation brackets the request and is adjacent to run end',
      finalTransportCaptureTimeoutMs: FINAL_CAPTURE_REQUEST_TIMEOUT_MS,
      finalTransportCaptureRunEndAllowanceMs: FINAL_CAPTURE_RUN_END_ALLOWANCE_MS,
      seeds: options.seeds,
      includesSeededCentredJitter: true,
      includesExactRateLoss: true,
      includesShortBurstLoss: options.includeStress,
      includesBoundedTemporaryCongestion: options.includeStress,
      recoveryPhasesPerRtt: options.includeRecovery ? 4 : 0,
      recoveryImpairmentFamilies: options.includeRecovery
        ? ['clean', 'exact-loss-and-reorder', 'burst-loss-and-reorder', 'congestion-loss-reorder']
        : [],
      playwrightArgsByPhase: {
        workload: options.playwrightArgs,
        recovery: options.includeRecovery ? options.recoveryPlaywrightArgs : [],
      },
    },
    runCount: orderedRuns.length,
    expectedRunCount: cells.length,
    transportEvidenceFailureCount: orderedRuns.filter((run) => !run.daemonTransport.complete)
      .length,
    latencyEvidenceFailureCount: orderedRuns.filter((run) => run.latencyEvidenceErrors.length > 0)
      .length,
    rawSampleRollups,
    headlineEvidenceErrors,
    runs: orderedRuns,
  });
}

/** The final report needs observed p99s in their own populations, not mixed-load tails. */
export function validateMatrixHeadlineEvidence(
  cells: readonly NetworkMatrixCell[],
  rollups: MatrixRawSampleRollups,
): string[] {
  const errors: string[] = [];
  const interactionMetrics = [
    'physicalInputToAdmissionMs',
    'admissionToInputSentMs',
    'inputSentToAckMs',
    'inputToAuthoritativeVisualFenceMs',
    'inputToCompletedAuthoritativePresentationFenceMs',
    'fenceObservationIntervalMs',
    'daemonPipeline.gridMutationToEncodedUs',
    'daemonPipeline.encodeUs',
    'daemonPipeline.compressionUs',
    'daemonPipeline.queuedBeforeTransportSubmitUs',
  ] as const satisfies readonly RawTerminalMetricName[];
  const redrawMetrics = [
    'presentation.measurementWindowExposureMs',
    'presentation.ordinaryMeasurementWindowExposureMs',
    'presentation.firstDisplayReceiveToCompletedPresentationFenceMs',
    'presentation.commitsPerMeasurementWindow',
    'presentation.datagramsPerMeasurementWindow',
    'presentation.bytesPerMeasurementWindow',
    'presentation.firstApplyToCommitMs',
    'presentation.commitToGpuFenceMs',
    'displayPipeline.workerReceiptToDecodeMs',
    'displayPipeline.decodeToApplyMs',
    'displayPipeline.encodedDeferralQueueHighWaterPerPump',
    'displayPipeline.ringBytesAtPumpStart',
    'displayPipeline.ringBytesAtPumpEnd',
    'displayPipeline.ringRefusedFrameCountPerMeasurementWindow',
    'displayPipeline.ringRefusedFrameCountBetweenMeasurementWindows',
    'presentation.renderSubmissionMs',
    'mainThread.rafGapMs',
    'browserDisplayIo.endToEndExplicitCopiesPerUpdate',
    'browserDisplayIo.endToEndExplicitCopiedBytesPerPayloadByte',
    'browserDisplayIo.endToEndExplicitAllocationRequestsPerUpdate',
  ] as const satisfies readonly RawTerminalMetricName[];

  function requireTail(
    label: string,
    rollup: Omit<MatrixRawSampleRollup, 'scope'> | undefined,
    metrics: readonly RawTerminalMetricName[],
    expectedRuns: number,
  ): void {
    if (
      rollup === undefined ||
      !rollup.complete ||
      rollup.expectedRunCount !== expectedRuns ||
      rollup.acceptedRunCount !== expectedRuns ||
      rollup.traceCount === 0 ||
      rollup.replayVerifiedTraceCount !== rollup.traceCount ||
      rollup.rawEventCount === 0
    ) {
      errors.push(`${label}: missing complete replay-verified population`);
      return;
    }
    for (const name of metrics) {
      const metric = rollup.metrics[name];
      if (
        !metric.complete ||
        metric.count < 100 ||
        metric.median === null ||
        metric.p95 === null ||
        metric.p99 === null ||
        metric.worst === null
      ) {
        errors.push(`${label}/${name}: requires at least 100 complete observations and p99`);
      }
    }
  }

  for (const profile of EDGE_NETWORK_PROFILE_NAMES) {
    if (!cells.some((cell) => cell.phase === 'workload' && cell.profile === profile)) continue;
    const cleanCells = cells.filter(
      (cell) =>
        cell.phase === 'workload' &&
        cell.profile === profile &&
        cell.datagramLossPercent === 0 &&
        cell.reorder === 'none' &&
        cell.scenario === 'steady',
    );
    if (new Set(cleanCells.map((cell) => cell.seed)).size < 2) {
      errors.push(`${profile}: requires two independent clean steady seeds`);
    }
    const typing = rollups.cleanWorkloadByTest.find(
      (rollup) =>
        rollup.scope.profile === profile &&
        rollup.scope.testFile === 'terminal-performance-matrix.e2e.ts' &&
        rollup.scope.testTitle ===
          'interaction: isolated single-character feedback is independently fenced',
    );
    requireTail(`${profile}/isolated-typing`, typing, interactionMetrics, cleanCells.length);
    if (profile !== 'fast') {
      requireTail(
        `${profile}/speculative-typing`,
        typing,
        ['inputToPredictionSubmissionMs', 'inputToPredictionPaintMs'],
        cleanCells.length,
      );
    }
    requireTail(
      `${profile}/coherent-redraw`,
      rollups.coherentRedrawByProfile.find((rollup) => rollup.scope.profile === profile),
      redrawMetrics,
      cleanCells.length,
    );
  }
  const expectedScopes = new Map<string, number>();
  for (const cell of cells) {
    const key = rawRollupScopeKey(rawRollupScope(cell));
    expectedScopes.set(key, (expectedScopes.get(key) ?? 0) + 1);
  }
  for (const [key, expectedRuns] of expectedScopes) {
    const matches = rollups.proxyDelayByScenario.filter(
      (rollup) => rawRollupScopeKey(rollup.scope) === key,
    );
    const rollup = matches[0];
    if (
      matches.length !== 1 ||
      rollup === undefined ||
      !rollup.complete ||
      rollup.expectedRunCount !== expectedRuns ||
      rollup.acceptedRunCount !== expectedRuns ||
      rollup.snapshotCount === 0
    ) {
      errors.push(`proxy/${key}: missing complete residence/delay population`);
      continue;
    }
    for (const name of MATRIX_PROXY_DELAY_METRICS) {
      const metric = rollup.metrics[name];
      if (
        !metric.complete ||
        metric.count < 100 ||
        metric.median === null ||
        metric.p95 === null ||
        metric.p99 === null ||
        metric.worst === null ||
        metric.histogram.reduce((sum, count) => sum + count, 0) !== metric.count ||
        metric.count - metric.saturatedBucketCount < Math.ceil(metric.count * 0.99)
      ) {
        errors.push(
          `proxy/${key}/${name}: requires 100 complete observations and an unsaturated p99`,
        );
      }
    }
  }
  return errors;
}

/**
 * Pool replay-derived observations, never already-aggregated percentiles. The
 * exact-scenario table keeps loss/reorder/congestion cells distinct; the
 * profile table is only the canonical clean workload subset.
 */
export function buildMatrixRawSampleRollups(
  plannedCells: readonly NetworkMatrixCell[],
  runs: readonly MatrixRawSampleRun[],
): MatrixRawSampleRollups {
  const scopes = new Map<string, MatrixRawSampleRollup['scope']>();
  for (const cell of plannedCells) {
    const scope = rawRollupScope(cell);
    scopes.set(rawRollupScopeKey(scope), scope);
  }
  const exactScenarios = [...scopes.values()]
    .sort((left, right) => rawRollupScopeKey(left).localeCompare(rawRollupScopeKey(right)))
    .map((scope) => buildRawSampleRollup(scope, plannedCells, runs));
  const proxyDelayByScenario = [...scopes.values()]
    .sort((left, right) => rawRollupScopeKey(left).localeCompare(rawRollupScopeKey(right)))
    .map((scope) => buildProxyDelayRollup(scope, plannedCells, runs));
  const cleanWorkloadByProfile = EDGE_NETWORK_PROFILE_NAMES.flatMap((profile) => {
    const scope = scopes.get(
      rawRollupScopeKey({
        phase: 'workload',
        profile,
        datagramLossPercent: 0,
        reorder: 'none',
        scenario: 'steady',
      }),
    );
    return scope === undefined ? [] : [buildRawSampleRollup(scope, plannedCells, runs)];
  });
  const cleanWorkloadByTest = EDGE_NETWORK_PROFILE_NAMES.flatMap((profile) => {
    const expectedCells = plannedCells.filter(
      (cell) =>
        cell.phase === 'workload' &&
        cell.profile === profile &&
        cell.datagramLossPercent === 0 &&
        cell.reorder === 'none' &&
        cell.scenario === 'steady',
    );
    if (expectedCells.length === 0) return [];
    const matchingRuns = runs.filter((run) =>
      expectedCells.some((cell) => matrixCellId(cell) === run.id),
    );
    return REQUIRED_TEST_EVIDENCE.workload.map((test) => ({
      scope: {
        phase: 'workload' as const,
        profile,
        testFile: test.file,
        testTitle: test.title,
      },
      ...buildRawSampleRollupBody(
        expectedCells,
        matchingRuns,
        matchingRuns.flatMap((run) =>
          run.latencySummaries.filter(
            (summary) =>
              summary.testTitle === test.title &&
              normalizedTestFileMatches(summary.testFile, test.file),
          ),
        ),
        matchingRuns.every(
          (run) =>
            run.latencySummaries.filter(
              (summary) =>
                summary.testTitle === test.title &&
                normalizedTestFileMatches(summary.testFile, test.file),
            ).length === 1,
        ),
      ),
    }));
  });
  const coherentRedrawByProfile = EDGE_NETWORK_PROFILE_NAMES.flatMap((profile) => {
    const expectedCells = plannedCells.filter(
      (cell) =>
        cell.phase === 'workload' &&
        cell.profile === profile &&
        cell.datagramLossPercent === 0 &&
        cell.reorder === 'none' &&
        cell.scenario === 'steady',
    );
    if (expectedCells.length === 0) return [];
    const matchingRuns = runs.filter((run) =>
      expectedCells.some((cell) => matrixCellId(cell) === run.id),
    );
    const summaries = matchingRuns.flatMap((run) =>
      run.latencySummaries.filter((summary) => summary.measurementPurpose === 'coherent-redraw'),
    );
    return [
      {
        scope: {
          phase: 'workload' as const,
          profile,
          purpose: 'coherent-redraw' as const,
        },
        ...buildRawSampleRollupBody(
          expectedCells,
          matchingRuns,
          summaries,
          matchingRuns.every((run) => {
            const redraws = run.latencySummaries.filter(
              (summary) => summary.measurementPurpose === 'coherent-redraw',
            );
            return (
              redraws.length === REQUIRED_COHERENT_REDRAW_EVIDENCE.length &&
              REQUIRED_COHERENT_REDRAW_EVIDENCE.every(
                (test) =>
                  redraws.filter(
                    (summary) =>
                      normalizedTestFileMatches(summary.testFile, test.file) &&
                      summary.testTitle === test.title,
                  ).length === 1,
              )
            );
          }),
        ),
      },
    ];
  });
  return {
    weighting:
      'one observation per non-null replayed analyzer sample; never a percentile of percentiles',
    exactScenarios,
    cleanWorkloadByProfile,
    cleanWorkloadByTest,
    coherentRedrawByProfile,
    proxyDelayByScenario,
  };
}

function buildProxyDelayRollup(
  scope: MatrixRawSampleRollup['scope'],
  plannedCells: readonly NetworkMatrixCell[],
  runs: readonly MatrixRawSampleRun[],
): MatrixProxyDelayRollup {
  const expected = plannedCells.filter(
    (cell) => rawRollupScopeKey(rawRollupScope(cell)) === rawRollupScopeKey(scope),
  );
  const matchingRuns = runs.filter(
    (run) => rawRollupScopeKey(rawRollupScope(run.cell)) === rawRollupScopeKey(scope),
  );
  const acceptedRunIds = new Set(
    matchingRuns
      .filter(
        (run) =>
          run.exitCode === 0 &&
          run.daemonTransport.complete &&
          run.latencyEvidenceErrors.length === 0,
      )
      .map((run) => run.id),
  );
  const summaries = matchingRuns.flatMap((run) => run.latencySummaries);
  const snapshots = summaries.flatMap((summary) =>
    summary.proxyImpairment === null ? [] : [summary.proxyImpairment],
  );
  const complete =
    expected.length > 0 &&
    matchingRuns.length === expected.length &&
    expected.every((cell) => acceptedRunIds.has(matrixCellId(cell))) &&
    summaries.length > 0 &&
    snapshots.length === summaries.length;
  const metrics = Object.fromEntries(
    MATRIX_PROXY_DELAY_METRICS.map((name) => [
      name,
      poolProxyDelayHistograms(
        snapshots.map((snapshot) => proxyDelayDistribution(snapshot, name)),
        complete,
      ),
    ]),
  ) as Readonly<Record<MatrixProxyDelayMetricName, MatrixProxyDelayDistribution>>;
  return {
    scope,
    expectedRunCount: expected.length,
    acceptedRunCount: expected.filter((cell) => acceptedRunIds.has(matrixCellId(cell))).length,
    snapshotCount: snapshots.length,
    complete,
    metrics,
  };
}

function proxyDelayDistribution(
  stats: ProxyImpairmentStats,
  name: MatrixProxyDelayMetricName,
): ProxyImpairmentStats['upstream']['scheduledDelayUs'] {
  const direction = name.startsWith('upstream.') ? stats.upstream : stats.downstream;
  if (name.endsWith('.scheduledDelayUs')) return direction.scheduledDelayUs;
  if (name.endsWith('.releaseTargetResidenceUs')) return direction.releaseTargetResidenceUs;
  if (name.endsWith('.actualResidenceUs')) return direction.actualResidenceUs;
  return direction.releaseOvershootUs;
}

function poolProxyDelayHistograms(
  distributions: readonly ProxyImpairmentStats['upstream']['scheduledDelayUs'][],
  complete: boolean,
): MatrixProxyDelayDistribution {
  const histogram = Array<number>(PROXY_DELAY_HISTOGRAM_BUCKETS).fill(0);
  let count = 0;
  let worst = 0;
  let safe = true;
  for (const distribution of distributions) {
    count += distribution.count;
    worst = Math.max(worst, distribution.max);
    safe &&= Number.isSafeInteger(count);
    for (let index = 0; index < histogram.length; index += 1) {
      const next = (histogram[index] ?? 0) + (distribution.histogram[index] ?? 0);
      histogram[index] = next;
      safe &&= Number.isSafeInteger(next);
    }
  }
  const percentile = (ratio: number, minimumCount: number): number | null => {
    if (count < minimumCount) return null;
    const target = Math.ceil(count * ratio);
    let cumulative = 0;
    for (let index = 0; index < histogram.length; index += 1) {
      cumulative += histogram[index] ?? 0;
      if (cumulative >= target) {
        // The final bucket contains every larger value, not a finite upper
        // edge. Reporting its nominal edge understates an unknown tail.
        if (index === histogram.length - 1) return null;
        return Math.min((index + 1) * PROXY_DELAY_HISTOGRAM_BUCKET_US, worst);
      }
    }
    return worst;
  };
  return {
    count,
    median: percentile(0.5, 1),
    p95: percentile(0.95, 20),
    p99: percentile(0.99, 100),
    worst: count === 0 ? null : worst,
    complete: complete && safe,
    histogramBucketUs: PROXY_DELAY_HISTOGRAM_BUCKET_US,
    histogram,
    saturatedBucketCount: histogram[PROXY_DELAY_HISTOGRAM_BUCKETS - 1] ?? 0,
  };
}

function buildRawSampleRollup(
  scope: MatrixRawSampleRollup['scope'],
  plannedCells: readonly NetworkMatrixCell[],
  runs: readonly MatrixRawSampleRun[],
): MatrixRawSampleRollup {
  const expected = plannedCells.filter(
    (cell) => rawRollupScopeKey(rawRollupScope(cell)) === rawRollupScopeKey(scope),
  );
  const matchingRuns = runs.filter(
    (run) => rawRollupScopeKey(rawRollupScope(run.cell)) === rawRollupScopeKey(scope),
  );
  const summaries = matchingRuns.flatMap((run) => run.latencySummaries);
  return {
    scope,
    ...buildRawSampleRollupBody(expected, matchingRuns, summaries, true),
  };
}

function buildRawSampleRollupBody(
  expected: readonly NetworkMatrixCell[],
  matchingRuns: readonly MatrixRawSampleRun[],
  summaries: readonly MatrixRawSampleRun['latencySummaries'][number][],
  exactSummaryMultiplicity: boolean,
): Omit<MatrixRawSampleRollup, 'scope'> {
  const acceptedRunIds = new Set(
    matchingRuns
      .filter(
        (run) =>
          run.exitCode === 0 &&
          run.daemonTransport.complete &&
          run.latencyEvidenceErrors.length === 0,
      )
      .map((run) => run.id),
  );
  const verified = summaries.filter((summary) => summary.rawEvents.complete);
  const complete =
    expected.length > 0 &&
    matchingRuns.length === expected.length &&
    expected.every((cell) => acceptedRunIds.has(matrixCellId(cell))) &&
    verified.length === summaries.length &&
    exactSummaryMultiplicity;
  const metrics = Object.fromEntries(
    RAW_TERMINAL_SAMPLE_METRICS.map((name) => [
      name,
      rawPercentiles(
        verified.flatMap((summary) => summary.rawEvents.metricSamples[name]),
        complete && verified.every((summary) => summary.rawEvents.metricComplete[name]),
      ),
    ]),
  ) as Readonly<Record<RawTerminalMetricName, PercentileDistribution>>;
  return {
    expectedRunCount: expected.length,
    acceptedRunCount: expected.filter((cell) => acceptedRunIds.has(matrixCellId(cell))).length,
    traceCount: summaries.length,
    replayVerifiedTraceCount: verified.length,
    rawEventCount: verified.reduce(
      (total, summary) => total + (summary.rawEvents.eventCount ?? 0),
      0,
    ),
    complete,
    metrics,
  };
}

function rawPercentiles(values: readonly number[], complete: boolean): PercentileDistribution {
  if (values.length === 0) {
    return { count: 0, median: null, p95: null, p99: null, worst: null, complete };
  }
  const sorted = [...values].sort((left, right) => left - right);
  const at = (ratio: number): number =>
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))] ?? 0;
  return {
    count: sorted.length,
    median: at(0.5),
    p95: sorted.length >= 20 ? at(0.95) : null,
    p99: sorted.length >= 100 ? at(0.99) : null,
    worst: sorted[sorted.length - 1] ?? null,
    complete,
  };
}

function rawRollupScope(cell: NetworkMatrixCell): MatrixRawSampleRollup['scope'] {
  return {
    phase: cell.phase,
    profile: cell.profile,
    datagramLossPercent: cell.datagramLossPercent,
    reorder: cell.reorder,
    scenario: cell.scenario,
  };
}

function rawRollupScopeKey(scope: MatrixRawSampleRollup['scope']): string {
  return `${scope.phase}\0${scope.profile}\0${scope.datagramLossPercent}\0${scope.reorder}\0${scope.scenario}`;
}

function parseOptions(args: readonly string[]): MatrixOptions {
  let outputPath = DEFAULT_OUTPUT;
  let seeds: readonly number[] = DEFAULT_NETWORK_MATRIX_SEEDS;
  let profiles: readonly EdgeNetworkProfileName[] = EDGE_NETWORK_PROFILE_NAMES;
  let datagramLossPercentages: readonly EdgeNetworkDatagramLossPercent[] =
    EDGE_NETWORK_DATAGRAM_LOSS_PERCENTAGES;
  let includeStress = true;
  const playwrightArgs: string[] = [];
  let passthrough = false;

  for (const argument of args) {
    if (passthrough) {
      playwrightArgs.push(argument);
      continue;
    }
    if (argument === '--') {
      passthrough = true;
      continue;
    }
    if (argument === '--steady-only') {
      includeStress = false;
      continue;
    }
    if (argument.startsWith('--output=')) {
      const raw = argument.slice('--output='.length);
      if (raw.length === 0 || raw.includes('\0')) throw new Error('--output requires a path');
      outputPath = path.resolve(raw);
      continue;
    }
    if (argument.startsWith('--seeds=')) {
      seeds = parseSeeds(argument.slice('--seeds='.length));
      continue;
    }
    if (argument.startsWith('--profiles=')) {
      profiles = parseMembers(
        '--profiles',
        argument.slice('--profiles='.length),
        EDGE_NETWORK_PROFILE_NAMES,
      );
      continue;
    }
    if (argument.startsWith('--datagram-loss=')) {
      datagramLossPercentages = parseLossPercentages(argument.slice('--datagram-loss='.length));
      continue;
    }
    throw new Error(
      `unknown matrix option ${argument}; Playwright arguments must follow a standalone --`,
    );
  }

  return {
    outputPath,
    seeds,
    profiles,
    datagramLossPercentages,
    includeStress,
    includeRecovery: playwrightArgs.length === 0,
    playwrightArgs: playwrightArgs.length === 0 ? DEFAULT_PLAYWRIGHT_ARGS : playwrightArgs,
    recoveryPlaywrightArgs: DEFAULT_RECOVERY_PLAYWRIGHT_ARGS,
  };
}

export function matrixEnvironment(
  cell: NetworkMatrixCell,
  resultPath: string,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !name.startsWith('EDGE_NETWORK_')) environment[name] = value;
  }
  return {
    ...environment,
    EDGE_NETWORK_PROFILE: cell.profile,
    EDGE_NETWORK_DATAGRAM_LOSS_PERCENT: String(cell.datagramLossPercent),
    EDGE_NETWORK_REORDER: cell.reorder,
    EDGE_NETWORK_SCENARIO: cell.scenario,
    EDGE_NETWORK_SEED: String(cell.seed),
    MERKUR_EDGE_HARNESS_RESULT_PATH: resultPath,
    MERKUR_E2E_FINAL_TRANSPORT_CAPTURE: '1',
    DAEMON_LOG_FILE: daemonLogPath(resultPath),
  };
}

function daemonLogPath(resultPath: string): string {
  return `${resultPath}.daemon.jsonl`;
}

function playwrightArgsForCell(options: MatrixOptions, cell: NetworkMatrixCell): readonly string[] {
  return cell.phase === 'recovery' ? options.recoveryPlaywrightArgs : options.playwrightArgs;
}

export function matrixCellId(cell: NetworkMatrixCell): string {
  return `${cell.phase}-${cell.profile}-datagram-loss-${cell.datagramLossPercent}-reorder-${cell.reorder}-${cell.scenario}-seed-${cell.seed}`;
}

export async function loadCompatibleMatrixCheckpoint(
  filename: string,
  cells: readonly NetworkMatrixCell[],
  playwrightArgs: readonly string[],
  recoveryPlaywrightArgs: readonly string[],
  sourceFingerprint: string,
): Promise<CompatibleMatrixCheckpoint | null> {
  let raw: string;
  try {
    raw = await readFile(filename, 'utf8');
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return null;
    throw error;
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw incompatibleCheckpoint(filename, 'it is not valid JSON');
  }
  if (
    !isRecord(value) ||
    value.schemaVersion !== MATRIX_ARTIFACT_SCHEMA_VERSION ||
    typeof value.startedAt !== 'string' ||
    value.startedAt.length === 0 ||
    !isRecord(value.plan) ||
    !stringArraysEqual(value.plan.cellIds, cells.map(matrixCellId)) ||
    value.plan.sourceFingerprint !== sourceFingerprint ||
    !isRecord(value.plan.playwrightArgsByPhase) ||
    !stringArraysEqual(value.plan.playwrightArgsByPhase.workload, playwrightArgs) ||
    !stringArraysEqual(value.plan.playwrightArgsByPhase.recovery, recoveryPlaywrightArgs) ||
    !Array.isArray(value.runs)
  ) {
    throw incompatibleCheckpoint(filename, 'its schema or exact matrix plan differs');
  }

  const expectedById = new Map(cells.map((cell) => [matrixCellId(cell), cell]));
  const seen = new Set<string>();
  const runs: MatrixRunRecord[] = [];
  for (const candidate of value.runs) {
    if (!isRecord(candidate) || typeof candidate.id !== 'string' || seen.has(candidate.id)) {
      throw incompatibleCheckpoint(filename, 'it contains an invalid or duplicate run key');
    }
    const expectedCell = expectedById.get(candidate.id);
    if (
      expectedCell === undefined ||
      !sameNetworkMatrixCell(candidate.cell, expectedCell) ||
      typeof candidate.startedAt !== 'string' ||
      candidate.startedAt.length === 0 ||
      typeof candidate.durationMs !== 'number' ||
      !Number.isFinite(candidate.durationMs) ||
      candidate.durationMs < 0 ||
      typeof candidate.exitCode !== 'number' ||
      !Number.isSafeInteger(candidate.exitCode) ||
      !Array.isArray(candidate.latencySummaries) ||
      !candidate.latencySummaries.every(isCapturedLatencySummary) ||
      !Array.isArray(candidate.latencyEvidenceErrors) ||
      !candidate.latencyEvidenceErrors.every((error) => typeof error === 'string') ||
      !isCapturedDaemonTransportEvidence(candidate.daemonTransport)
    ) {
      throw incompatibleCheckpoint(filename, `run ${candidate.id} is incomplete or mismatched`);
    }
    if (
      candidate.exitCode === 0 &&
      candidate.daemonTransport.complete &&
      candidate.latencySummaries.every((summary) => summary.rawEvents.complete)
    ) {
      try {
        const startedAtMs = Date.parse(candidate.startedAt);
        if (!Number.isFinite(startedAtMs)) {
          throw new Error(`run ${candidate.id} has an invalid start timestamp`);
        }
        await reverifyCapturedDaemonTransportEvidence(
          candidate.daemonTransport,
          startedAtMs + candidate.durationMs,
        );
        for (const summary of candidate.latencySummaries) {
          await reverifyCapturedLatencySummary(summary);
        }
      } catch (error) {
        throw incompatibleCheckpoint(
          filename,
          `run ${candidate.id} has unverifiable retained evidence: ${formatError(error)}`,
        );
      }
    }
    seen.add(candidate.id);
    const latencyEvidenceErrors = validateMatrixRunLatencyEvidence(
      expectedCell,
      candidate.latencySummaries,
      candidate.daemonTransport,
    );
    // The checkpoint doubles as a retry journal. A structurally valid failed
    // attempt remains inspectable in the artifact but is not a completed cell
    // and therefore runs again after interruption.
    if (
      candidate.exitCode !== 0 ||
      !candidate.daemonTransport.complete ||
      latencyEvidenceErrors.length > 0
    ) {
      continue;
    }
    runs.push({
      id: candidate.id,
      cell: expectedCell,
      startedAt: candidate.startedAt,
      durationMs: candidate.durationMs,
      exitCode: candidate.exitCode,
      harnessResult: candidate.harnessResult,
      latencySummaries: candidate.latencySummaries,
      latencyEvidenceErrors,
      daemonTransport: candidate.daemonTransport,
    });
  }
  return { startedAt: value.startedAt, runs };
}

async function reverifyCapturedLatencySummary(summary: CapturedLatencySummary): Promise<void> {
  if (!summary.rawEvents.complete || summary.rawEvents.artifact === null) {
    throw new Error(`${summary.testTitle}: raw trace is incomplete`);
  }
  const summaryPath = matrixEvidencePath(summary.artifact);
  const rawPath = matrixEvidencePath(summary.rawEvents.artifact);
  const stored = await readJsonIfPresent(summaryPath);
  if (
    !isRecord(stored) ||
    stored.schemaVersion !== TERMINAL_PERF_ARTIFACT_SCHEMA_VERSION ||
    !isRecord(stored.test) ||
    !isRecord(stored.report) ||
    !isCapturedGridConvergenceEvidence(stored.gridConvergence) ||
    !isRecord(stored.transportProfile) ||
    !isRecord(stored.transportProfile.applicationDisplayOutcome)
  ) {
    throw new Error(`${summary.testTitle}: retained summary artifact is malformed`);
  }
  if (
    stored.test.id !== summary.testId ||
    stored.test.title !== summary.testTitle ||
    stored.test.file !== summary.testFile ||
    stored.test.status !== summary.testStatus ||
    stored.test.expectedStatus !== summary.testExpectedStatus ||
    !isDeepStrictEqual(stored.gridConvergence, summary.gridConvergence) ||
    !isDeepStrictEqual(extractPercentileMetrics(stored.report), summary.metrics) ||
    !isDeepStrictEqual(
      stored.transportProfile.applicationDisplayOutcome,
      summary.applicationDisplayOutcome,
    ) ||
    !isDeepStrictEqual(stored.transportProfile.achieved ?? null, summary.proxyImpairment)
  ) {
    throw new Error(`${summary.testTitle}: retained summary no longer matches the checkpoint`);
  }
  const presentation = stored.report.presentation;
  if (
    !isRecord(presentation) ||
    presentation.measurementWindowCount !== summary.measurementWindowCount ||
    measurementPurposeFromPresentation(presentation, summary.measurementWindowCount) !==
      summary.measurementPurpose
  ) {
    throw new Error(`${summary.testTitle}: retained measurement-window count changed`);
  }

  const raw = await readFile(rawPath);
  const sha256 = createHash('sha256').update(raw).digest('hex');
  if (sha256 !== summary.rawEvents.sha256 || summary.rawEvents.eventCount === null) {
    throw new Error(`${summary.testTitle}: retained raw trace digest changed`);
  }
  const replay = verifyRawTerminalPerfTrace(
    raw,
    summary.rawEvents.eventCount,
    stored.report,
    stored.transportProfile.applicationDisplayOutcome,
  );
  if (
    replay.reportSha256 !== summary.rawEvents.reportSha256 ||
    replay.applicationDisplayOutcomeSha256 !== summary.rawEvents.applicationDisplayOutcomeSha256 ||
    !isDeepStrictEqual(replay.metricSamples, summary.rawEvents.metricSamples) ||
    !isDeepStrictEqual(replay.metricComplete, summary.rawEvents.metricComplete)
  ) {
    throw new Error(`${summary.testTitle}: retained raw replay no longer matches the checkpoint`);
  }
}

async function reverifyCapturedDaemonTransportEvidence(
  expected: CapturedDaemonTransportEvidence,
  runEndAtMs: number,
): Promise<void> {
  if (!expected.complete || expected.artifact === null || expected.sha256 === null) {
    throw new Error('daemon transport evidence is incomplete');
  }
  const artifactPath = matrixEvidencePath(expected.artifact);
  const sha256 = await fileSha256(artifactPath);
  if (sha256 !== expected.sha256) {
    throw new Error('retained daemon transport trace digest changed');
  }

  const accumulator = createDaemonTransportEvidenceAccumulator(expected.artifact, sha256);
  const lines = createInterface({
    input: createReadStream(artifactPath, { encoding: 'utf8' }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  let lineNumber = 0;
  try {
    for await (const line of lines) {
      lineNumber += 1;
      inspectDaemonTransportLogLine(accumulator, line, lineNumber, runEndAtMs);
    }
  } finally {
    lines.close();
  }
  const replayed = finishDaemonTransportEvidence(accumulator, runEndAtMs);
  if (!isDeepStrictEqual(replayed, expected)) {
    throw new Error('retained daemon transport replay no longer matches the checkpoint');
  }
}

function matrixEvidencePath(relativePath: string): string {
  if (relativePath.length === 0 || relativePath.includes('\0')) {
    throw new Error('matrix evidence path is invalid');
  }
  // The CLI explicitly permits --output outside the checkout. Captures are
  // stored relative to ROOT when possible, but an absolute journal produced by
  // tooling remains valid; content hashes and replay, not pathname shape, are
  // the trust boundary.
  return path.isAbsolute(relativePath) ? relativePath : path.resolve(ROOT, relativePath);
}

function incompatibleCheckpoint(filename: string, reason: string): Error {
  return new Error(
    `cannot resume network matrix from ${filename}: ${reason}; ` +
      'choose a different --output path or remove the incompatible artifact',
  );
}

function sameNetworkMatrixCell(value: unknown, expected: NetworkMatrixCell): boolean {
  return (
    isRecord(value) &&
    value.phase === expected.phase &&
    value.profile === expected.profile &&
    value.datagramLossPercent === expected.datagramLossPercent &&
    value.reorder === expected.reorder &&
    value.scenario === expected.scenario &&
    value.seed === expected.seed
  );
}

function stringArraysEqual(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((entry, index) => entry === expected[index])
  );
}

function emptyRawTerminalMetricSamples(): RawTerminalMetricSamples {
  return mutableRawTerminalMetricSamples();
}

function emptyRawTerminalMetricCompleteness(): Readonly<Record<RawTerminalMetricName, boolean>> {
  return Object.fromEntries(RAW_TERMINAL_SAMPLE_METRICS.map((name) => [name, false])) as Readonly<
    Record<RawTerminalMetricName, boolean>
  >;
}

function mutableRawTerminalMetricSamples(): Record<RawTerminalMetricName, number[]> {
  return Object.fromEntries(
    RAW_TERMINAL_SAMPLE_METRICS.map((name) => [name, [] as number[]]),
  ) as Record<RawTerminalMetricName, number[]>;
}

export function captureGridConvergenceEvidence(
  value: unknown,
  cell: NetworkMatrixCell,
): { readonly evidence: CapturedGridConvergenceEvidence; readonly errors: string[] } {
  const errors: string[] = [];
  const unavailable: CapturedGridConvergenceEvidence = {
    complete: false,
    error: 'terminal grid-convergence evidence is missing or malformed',
    selectiveRepairCount: 0,
    probes: [],
  };
  if (!isCapturedGridConvergenceEvidence(value)) {
    return { evidence: unavailable, errors: [unavailable.error ?? ''] };
  }

  const preconditions = value.probes.filter((probe) => probe.purpose === 'reset-precondition');
  const observationAcks = value.probes.filter((probe) => probe.purpose === 'observation-ack');
  const finalVerifications = value.probes.filter((probe) => probe.purpose === 'final-verification');
  if (!value.complete || value.error !== null) {
    errors.push(`terminal grid-convergence evidence is incomplete: ${value.error ?? 'no error'}`);
  }
  if (
    preconditions.length === 0 ||
    preconditions.length !== observationAcks.length ||
    finalVerifications.length !== 1
  ) {
    errors.push('terminal grid-convergence reset/ack/final probe membership is incomplete');
  }
  for (let index = 0; index < Math.min(preconditions.length, observationAcks.length); index += 1) {
    if (
      preconditions[index]?.result.observationEpoch ===
      observationAcks[index]?.result.observationEpoch
    ) {
      errors.push('terminal grid-convergence observation ACK did not advance the reset epoch');
    }
  }
  const latestAck = observationAcks.at(-1)?.result;
  const finalVerification = finalVerifications[0]?.result;
  if (
    latestAck !== undefined &&
    finalVerification !== undefined &&
    latestAck.observationEpoch !== finalVerification.observationEpoch
  ) {
    errors.push('terminal grid-convergence final proof does not match the measured observation');
  }
  const computedSelectiveRepairCount = value.probes.reduce(
    (total, probe) => total + probe.result.selectiveRepairCount,
    0,
  );
  if (value.selectiveRepairCount !== computedSelectiveRepairCount) {
    errors.push('terminal grid-convergence selective-repair aggregate is inconsistent');
  }
  if (
    cell.datagramLossPercent === 0 &&
    cell.reorder === 'none' &&
    cell.scenario === 'steady' &&
    value.selectiveRepairCount !== 0
  ) {
    errors.push('clean matrix cell required selective repair to establish grid convergence');
  }
  return { evidence: value, errors };
}

async function captureLatencySummaries(
  startedAtMs: number,
  destinationDirectory: string,
  cell: NetworkMatrixCell,
): Promise<CapturedLatencySummary[]> {
  const files = await findNamedFiles(PLAYWRIGHT_RESULTS, 'terminal-latency-summary.json');
  const summaries: CapturedLatencySummary[] = [];
  await mkdir(destinationDirectory, { recursive: true });
  for (const file of files) {
    const metadata = await stat(file);
    if (metadata.mtimeMs + 1_000 < startedAtMs) continue;
    const value = await readJsonIfPresent(file);
    if (!isRecord(value) || !isRecord(value.test) || typeof value.test.title !== 'string') continue;
    const testRecord = value.test;
    const testTitle = value.test.title;
    const metrics = extractPercentileMetrics(value.report);
    if (Object.keys(metrics).length === 0) continue;
    const artifactIndex = summaries.length;
    const artifact = path.join(
      destinationDirectory,
      `terminal-latency-summary-${artifactIndex}.json`,
    );
    await copyFile(file, artifact);
    const rawEventsDestination = path.join(
      destinationDirectory,
      `terminal-perf-events-${artifactIndex}.json.gz`,
    );
    const rawEventsMetadata = isRecord(value.rawEvents) ? value.rawEvents : null;
    let rawEvents: CapturedLatencySummary['rawEvents'];
    try {
      if (
        rawEventsMetadata === null ||
        rawEventsMetadata.filename !== 'terminal-perf-events.json.gz' ||
        !isNonNegativeSafeInteger(rawEventsMetadata.eventCount)
      ) {
        throw new Error('summary raw-event metadata is missing or malformed');
      }
      await copyFile(
        path.join(path.dirname(file), rawEventsMetadata.filename),
        rawEventsDestination,
      );
      const rawBytes = await readFile(rawEventsDestination);
      const digest = createHash('sha256').update(rawBytes).digest('hex');
      const applicationDisplayOutcome =
        isRecord(value.transportProfile) &&
        isRecord(value.transportProfile.applicationDisplayOutcome)
          ? value.transportProfile.applicationDisplayOutcome
          : null;
      const replay = verifyRawTerminalPerfTrace(
        rawBytes,
        rawEventsMetadata.eventCount,
        value.report,
        applicationDisplayOutcome,
      );
      rawEvents = {
        artifact: path.relative(ROOT, rawEventsDestination),
        sha256: digest,
        eventCount: replay.eventCount,
        reportSha256: replay.reportSha256,
        applicationDisplayOutcomeSha256: replay.applicationDisplayOutcomeSha256,
        metricSamples: replay.metricSamples,
        metricComplete: replay.metricComplete,
        complete: true,
        error: null,
      };
    } catch (error) {
      rawEvents = {
        artifact: null,
        sha256: null,
        eventCount:
          rawEventsMetadata !== null && isNonNegativeSafeInteger(rawEventsMetadata.eventCount)
            ? rawEventsMetadata.eventCount
            : null,
        reportSha256: null,
        applicationDisplayOutcomeSha256: null,
        metricSamples: emptyRawTerminalMetricSamples(),
        metricComplete: emptyRawTerminalMetricCompleteness(),
        complete: false,
        error: `raw terminal event trace was not retained and replay-verified: ${formatError(error)}`,
      };
    }
    const applicationDisplayOutcome =
      isRecord(value.transportProfile) && isRecord(value.transportProfile.applicationDisplayOutcome)
        ? value.transportProfile.applicationDisplayOutcome
        : null;
    const proxySnapshot =
      isRecord(value.transportProfile) && isRecord(value.transportProfile.achieved)
        ? value.transportProfile.achieved
        : null;
    const proxyEvidence = validateProxyArtifactEvidence(proxySnapshot, cell);
    const testFile = typeof testRecord.file === 'string' ? testRecord.file : '';
    const requireSnapshot =
      cell.phase === 'recovery' &&
      testTitle ===
        'a forced profiling resync completes through an authoritative GPU-fenced snapshot' &&
      normalizedTestFileMatches(testFile, 'display-resync-recovery.e2e.ts');
    const errors = validateApplicationDisplayOutcomeEvidence(
      applicationDisplayOutcome,
      requireSnapshot,
      cell.phase === 'workload',
      isCleanWorkload(cell),
    );
    const gridConvergence = captureGridConvergenceEvidence(value.gridConvergence, cell);
    errors.push(...gridConvergence.errors);
    if (value.schemaVersion !== TERMINAL_PERF_ARTIFACT_SCHEMA_VERSION) {
      errors.push(
        `terminal performance artifact schema ${String(value.schemaVersion)} does not match ${TERMINAL_PERF_ARTIFACT_SCHEMA_VERSION}`,
      );
    }
    if (!rawEvents.complete && rawEvents.error !== null) errors.push(rawEvents.error);
    if (isRecord(applicationDisplayOutcome)) {
      if (applicationDisplayOutcome.resyncAlreadyPendingCount !== 0) {
        errors.push('display resync requests overlapped an already-pending recovery');
      }
      if (!requireSnapshot && applicationDisplayOutcome.resyncRequestCount !== 0) {
        errors.push('non-resync sentinel unexpectedly requested display resynchronization');
      }
      if (requireSnapshot) {
        if (applicationDisplayOutcome.resyncRequestCount !== 1) {
          errors.push('forced-resync sentinel did not issue exactly one resync request');
        }
        if (
          applicationDisplayOutcome.snapshotReceivedCount !== 1 ||
          applicationDisplayOutcome.snapshotAppliedCount !== 1
        ) {
          errors.push('forced-resync sentinel did not receive and apply exactly one snapshot');
        }
      }
      const requireTargetSatisfiedRepair =
        cell.phase === 'recovery' &&
        testTitle === CARRIER_REPAIR_TEST_TITLE &&
        normalizedTestFileMatches(testFile, 'carrier-rebind.e2e.ts');
      if (requireTargetSatisfiedRepair) {
        if (
          !isNonNegativeSafeInteger(applicationDisplayOutcome.repairTargetSatisfiedCommitCount) ||
          applicationDisplayOutcome.repairTargetSatisfiedCommitCount < 1
        ) {
          errors.push('carrier-repair sentinel recorded no target-satisfied presentation release');
        }
        if (
          !isNonNegativeSafeInteger(applicationDisplayOutcome.repairDeadlineExpiredCommitCount) ||
          applicationDisplayOutcome.repairDeadlineExpiredCommitCount !== 0
        ) {
          errors.push('carrier-repair sentinel fell through to a deadline-expired release');
        }
      }
    }
    errors.push(...proxyEvidence.errors);
    const presentation =
      isRecord(value.report) && isRecord(value.report.presentation)
        ? value.report.presentation
        : null;
    const measurementWindowCount =
      presentation !== null && isNonNegativeSafeInteger(presentation.measurementWindowCount)
        ? presentation.measurementWindowCount
        : 0;
    const measurementPurpose = measurementPurposeFromPresentation(
      presentation,
      measurementWindowCount,
    );
    if (presentation === null || !isNonNegativeSafeInteger(presentation.measurementWindowCount)) {
      errors.push('presentation measurement-window count is invalid');
    }
    if ((measurementWindowCount === 0) !== (measurementPurpose === null)) {
      errors.push('presentation measurement-window purpose is missing or mixed');
    }
    if (presentation === null || !isNonNegativeSafeInteger(presentation.frameBudgetExceededCount)) {
      errors.push('presentation frame-budget evidence is invalid');
    } else if (presentation.frameBudgetExceededCount !== 0) {
      errors.push('presentation exceeded the renderer frame budget');
    }
    errors.push(
      ...validateCarrierRepairPresentationEvidence(
        cell,
        testFile,
        testTitle,
        measurementWindowCount,
        metrics,
      ),
    );
    errors.push(
      ...validateForcedResyncPresentationEvidence(
        cell,
        testFile,
        testTitle,
        measurementWindowCount,
        metrics,
      ),
    );
    errors.push(
      ...validateBrowserRuntimeEvidence(cell, measurementWindowCount, value.report, metrics),
    );
    errors.push(
      ...validateWorkloadPresentationEvidence(
        cell,
        measurementWindowCount,
        presentation,
        metrics,
        applicationDisplayOutcome,
      ),
    );
    if (
      typeof testRecord.id !== 'string' ||
      testRecord.id.length === 0 ||
      typeof testRecord.file !== 'string' ||
      testRecord.file.length === 0 ||
      (testRecord.status !== null && typeof testRecord.status !== 'string') ||
      typeof testRecord.expectedStatus !== 'string'
    ) {
      errors.push('Playwright test identity or status is invalid');
    } else if (testRecord.status !== 'passed' || testRecord.expectedStatus !== 'passed') {
      errors.push(
        `Playwright test was not an ordinary pass (status=${String(testRecord.status)}, expected=${testRecord.expectedStatus})`,
      );
    }
    if (cell.phase === 'workload' && measurementWindowCount > 0) {
      const completedPresentation = metrics.inputToCompletedAuthoritativePresentationFenceMs;
      if (
        completedPresentation === undefined ||
        !completedPresentation.complete ||
        completedPresentation.eligibleCount !== measurementWindowCount ||
        completedPresentation.censoredCount !== 0 ||
        completedPresentation.count !== completedPresentation.eligibleCount
      ) {
        errors.push('workload trigger-to-completed presentation evidence is incomplete');
      }
      const completedWindow =
        metrics['presentation.measurementWindowToCompletedAuthoritativePresentationFenceMs'];
      if (
        completedWindow === undefined ||
        !completedWindow.complete ||
        completedWindow.count !== measurementWindowCount
      ) {
        errors.push('logical-workload window-to-completed presentation evidence is incomplete');
      }
      for (const metricName of [
        'presentation.datagramsPerMeasurementWindow',
        'presentation.bytesPerMeasurementWindow',
        'presentation.firstDisplayReceiveToCompletedPresentationFenceMs',
      ]) {
        const metric = metrics[metricName];
        if (metric === undefined || !metric.complete || metric.count !== measurementWindowCount) {
          errors.push(`${metricName} evidence is incomplete`);
        }
      }
    }
    summaries.push({
      artifact: path.relative(ROOT, artifact),
      rawEvents,
      testId: typeof testRecord.id === 'string' ? testRecord.id : '',
      testTitle,
      testFile,
      testStatus: typeof testRecord.status === 'string' ? testRecord.status : null,
      testExpectedStatus:
        typeof testRecord.expectedStatus === 'string' ? testRecord.expectedStatus : '',
      gridConvergence: gridConvergence.evidence,
      measurementWindowCount,
      measurementPurpose,
      complete: errors.length === 0,
      errors,
      metrics,
      applicationDisplayOutcome,
      proxyImpairment: proxyEvidence.stats,
      proxyFaultEvidence: proxyEvidence.evidence,
    });
  }
  return summaries.sort((left, right) => left.artifact.localeCompare(right.artifact));
}

/**
 * Preserve the daemon's fixed-cardinality transport evidence beside each cell.
 * The log is copied first and then streamed line-by-line, so a long matrix cell
 * cannot make validation retain the whole process log in memory.
 */
async function captureDaemonTransportEvidence(
  sourceLog: string,
  destinationDirectory: string,
  runEndAtMs: number,
): Promise<CapturedDaemonTransportEvidence> {
  await mkdir(destinationDirectory, { recursive: true });
  const artifactPath = path.join(destinationDirectory, 'daemon-transport.jsonl');
  try {
    await copyFile(sourceLog, artifactPath);
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      return emptyDaemonTransportEvidence(
        null,
        `daemon transport log was not produced at ${sourceLog}`,
      );
    }
    throw error;
  }

  const artifact = path.relative(ROOT, artifactPath);
  const sha256 = await fileSha256(artifactPath);
  const accumulator = createDaemonTransportEvidenceAccumulator(artifact, sha256);
  const lines = createInterface({
    input: createReadStream(artifactPath, { encoding: 'utf8' }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  let lineNumber = 0;
  try {
    for await (const line of lines) {
      lineNumber += 1;
      inspectDaemonTransportLogLine(accumulator, line, lineNumber, runEndAtMs);
    }
  } finally {
    lines.close();
  }
  return finishDaemonTransportEvidence(accumulator, runEndAtMs);
}

async function fileSha256(filename: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

/** Pure entry point used by focused tests for malformed and stale evidence. */
export function analyzeDaemonTransportLogLines(
  lines: readonly string[],
  runEndAtMs: number,
  artifact = 'daemon-transport.jsonl',
): CapturedDaemonTransportEvidence {
  const sha256 = createHash('sha256').update(lines.join('\n')).digest('hex');
  const accumulator = createDaemonTransportEvidenceAccumulator(artifact, sha256);
  for (let index = 0; index < lines.length; index += 1) {
    inspectDaemonTransportLogLine(accumulator, lines[index] ?? '', index + 1, runEndAtMs);
  }
  return finishDaemonTransportEvidence(accumulator, runEndAtMs);
}

function createDaemonTransportEvidenceAccumulator(
  artifact: string | null,
  sha256: string | null,
): DaemonTransportEvidenceAccumulator {
  return { artifact, sha256, errors: [], latestByDaemon: new Map(), captureCount: 0 };
}

function emptyDaemonTransportEvidence(
  artifact: string | null,
  error: string,
): CapturedDaemonTransportEvidence {
  return {
    artifact,
    sha256: null,
    complete: false,
    errors: [error],
    captureCount: 0,
    daemonCount: 0,
    freshAtRunEnd: false,
    latestByDaemon: [],
  };
}

function inspectDaemonTransportLogLine(
  accumulator: DaemonTransportEvidenceAccumulator,
  line: string,
  lineNumber: number,
  runEndAtMs: number,
): void {
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    // CLI progress and child stderr legitimately share this tee. Only a line
    // claiming to be the final capture is evidence and therefore fail-closed.
    if (line.includes('daemon_transport_capture_complete')) {
      accumulator.errors.push(`line ${lineNumber}: daemon transport capture is not valid JSON`);
    }
    return;
  }
  if (!isRecord(record) || record.message !== 'daemon_transport_capture_complete') return;
  if (!isRecord(record.context)) {
    accumulator.errors.push(`line ${lineNumber}: daemon transport capture context is missing`);
    return;
  }
  const context = record.context;
  if (typeof context.daemonId !== 'string' || context.daemonId.length === 0) {
    accumulator.errors.push(`line ${lineNumber}: daemon health daemonId is invalid`);
    return;
  }
  if (
    !isNonNegativeSafeInteger(context.captureRequestedAtMs) ||
    !isNonNegativeSafeInteger(context.captureCompletedAtMs) ||
    !isRecord(context.health) ||
    !isNonNegativeSafeInteger(context.health.checkedAt) ||
    !isRecord(context.metrics) ||
    !Object.hasOwn(context.metrics, 'latestDataplaneTransport')
  ) {
    accumulator.errors.push(`line ${lineNumber}: daemon transport capture shape is incomplete`);
    return;
  }

  const rawSample = context.metrics.latestDataplaneTransport;
  if (rawSample === null) {
    accumulator.errors.push(`line ${lineNumber}: final daemon transport sample is missing`);
    return;
  }
  if (!isDaemonDataplaneTransportSample(rawSample)) {
    accumulator.errors.push(`line ${lineNumber}: daemon transport sample shape is invalid`);
    return;
  }

  if (
    rawSample.latest.windowMs <= 0 ||
    rawSample.latest.windowMs > DATAPLANE_TRANSPORT_SAMPLE_CADENCE_MS ||
    rawSample.aggregate.windowMs < rawSample.latest.windowMs
  ) {
    accumulator.errors.push(
      `line ${lineNumber}: daemon transport partial-window coverage is inconsistent`,
    );
  }
  if (rawSample.latest.statsEventsDropped !== 0 || rawSample.aggregate.statsEventsDropped !== 0) {
    accumulator.errors.push(`line ${lineNumber}: dataplane transport telemetry reported drops`);
  }
  for (const [scope, stats] of [
    ['latest', rawSample.latest],
    ['aggregate', rawSample.aggregate],
  ] as const) {
    const merkurOwnedDrops =
      stats.datagramSendFailures +
      stats.inboundDatagramDropsWt +
      stats.inboundDatagramDropsEdge +
      stats.overCapacitySessionRejections;
    if (
      merkurOwnedDrops !== 0 ||
      stats.webtransport.sendFailuresMax !== 0 ||
      stats.edge.sendFailuresMax !== 0
    ) {
      accumulator.errors.push(
        `line ${lineNumber}: ${scope} transport sample reported Merkur-owned send/admission/queue drops`,
      );
    }
    if (stats.unackedDatagramsMax > SENT_DATAGRAM_MAX_ENTRIES) {
      accumulator.errors.push(
        `line ${lineNumber}: ${scope} application display tracking exceeded ${SENT_DATAGRAM_MAX_ENTRIES} datagrams`,
      );
    }
    if (stats.edgeReliableQueuedBytesMax > EDGE_RELIABLE_QUEUE_MAX_BYTES) {
      accumulator.errors.push(
        `line ${lineNumber}: ${scope} edge reliable admission backlog exceeded ${EDGE_RELIABLE_QUEUE_MAX_BYTES} bytes`,
      );
    }
  }
  if (rawSample.latest.peers === 0) {
    accumulator.errors.push(
      `line ${lineNumber}: final daemon transport capture had no live browser peer`,
    );
  }
  if (
    rawSample.aggregate.peers === 0 ||
    rawSample.aggregate.webtransport.quicSentPackets + rawSample.aggregate.edge.quicSentPackets ===
      0
  ) {
    accumulator.errors.push(
      `line ${lineNumber}: daemon transport aggregate contains no live carrier traffic`,
    );
  }

  const healthCheckedAtMs = context.health.checkedAt;
  const captureRequestedAtMs = context.captureRequestedAtMs;
  const captureCompletedAtMs = context.captureCompletedAtMs;
  const captureRequestToSampleMs = rawSample.observedAtMs - captureRequestedAtMs;
  const sampleToRunEndMs = runEndAtMs - rawSample.observedAtMs;
  const captureCompletionToRunEndMs = runEndAtMs - captureCompletedAtMs;
  const sample: DaemonTransportFinalCapture = {
    daemonId: context.daemonId,
    captureRequestedAtMs,
    captureCompletedAtMs,
    healthCheckedAtMs,
    observedAtMs: rawSample.observedAtMs,
    sampleCount: rawSample.sampleCount,
    captureRequestToSampleMs,
    sampleToRunEndMs,
    captureCompletionToRunEndMs,
    latest: rawSample.latest,
    aggregate: rawSample.aggregate,
  };
  accumulator.captureCount += 1;
  const previous = accumulator.latestByDaemon.get(sample.daemonId);
  if (previous !== undefined && sample.captureRequestedAtMs <= previous.captureRequestedAtMs) {
    accumulator.errors.push(
      `line ${lineNumber}: daemon transport capture requests are duplicate or non-monotonic`,
    );
  }
  if (previous === undefined || sample.captureRequestedAtMs > previous.captureRequestedAtMs) {
    accumulator.latestByDaemon.set(sample.daemonId, sample);
  }

  if (
    captureRequestToSampleMs < 0 ||
    captureRequestToSampleMs > FINAL_CAPTURE_REQUEST_TIMEOUT_MS ||
    healthCheckedAtMs < rawSample.observedAtMs ||
    captureCompletedAtMs < healthCheckedAtMs
  ) {
    accumulator.errors.push(
      `line ${lineNumber}: final daemon transport sample does not bracket its capture request`,
    );
  }
  if (sampleToRunEndMs < 0 || captureCompletionToRunEndMs < 0) {
    accumulator.errors.push(`line ${lineNumber}: daemon transport capture is after the matrix run`);
  }
}

function finishDaemonTransportEvidence(
  accumulator: DaemonTransportEvidenceAccumulator,
  runEndAtMs: number,
): CapturedDaemonTransportEvidence {
  const latestByDaemon = [...accumulator.latestByDaemon.values()].sort((left, right) =>
    left.daemonId.localeCompare(right.daemonId),
  );
  if (accumulator.captureCount === 0) {
    accumulator.errors.push('no complete final dataplane transport capture was observed');
  }
  const freshAtRunEnd =
    latestByDaemon.length > 0 &&
    latestByDaemon.every(
      (snapshot) =>
        runEndAtMs - snapshot.captureCompletedAtMs >= 0 &&
        runEndAtMs - snapshot.captureCompletedAtMs <= FINAL_CAPTURE_RUN_END_ALLOWANCE_MS &&
        snapshot.observedAtMs >= snapshot.captureRequestedAtMs,
    );
  if (!freshAtRunEnd) {
    accumulator.errors.push(
      `no final daemon transport capture was within ${FINAL_CAPTURE_RUN_END_ALLOWANCE_MS}ms of run end`,
    );
  }
  return {
    artifact: accumulator.artifact,
    sha256: accumulator.sha256,
    complete: accumulator.errors.length === 0 && accumulator.captureCount > 0 && freshAtRunEnd,
    errors: accumulator.errors,
    captureCount: accumulator.captureCount,
    daemonCount: latestByDaemon.length,
    freshAtRunEnd,
    latestByDaemon,
  };
}

interface DaemonDataplaneTransportSampleShape {
  readonly observedAtMs: number;
  readonly sampleCount: number;
  readonly latest: DataplaneTransportStats;
  readonly aggregate: DataplaneTransportStats;
}

function isDaemonDataplaneTransportSample(
  value: unknown,
): value is DaemonDataplaneTransportSampleShape {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['observedAtMs', 'sampleCount', 'latest', 'aggregate']) &&
    isNonNegativeSafeInteger(value.observedAtMs) &&
    isPositiveSafeInteger(value.sampleCount) &&
    isDataplaneTransportStats(value.latest) &&
    isDataplaneTransportStats(value.aggregate)
  );
}

function isDataplaneTransportStats(value: unknown): value is DataplaneTransportStats {
  if (!isRecord(value) || !hasExactKeys(value, DATAPLANE_TRANSPORT_STATS_KEYS)) return false;
  if (!isDataplanePathStats(value.webtransport) || !isDataplanePathStats(value.edge)) return false;
  for (const key of DATAPLANE_TRANSPORT_STATS_KEYS) {
    if (key === 'webtransport' || key === 'edge') continue;
    if (!isNonNegativeSafeInteger(value[key])) return false;
  }
  return true;
}

function isDataplanePathStats(value: unknown): value is DataplanePathStats {
  if (!isRecord(value) || !hasExactKeys(value, DATAPLANE_PATH_STATS_KEYS)) return false;
  return DATAPLANE_PATH_STATS_KEYS.every((key) => isNonNegativeSafeInteger(value[key]));
}

function isCapturedDaemonTransportEvidence(
  value: unknown,
): value is CapturedDaemonTransportEvidence {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'artifact',
      'sha256',
      'complete',
      'errors',
      'captureCount',
      'daemonCount',
      'freshAtRunEnd',
      'latestByDaemon',
    ]) ||
    !(value.artifact === null || typeof value.artifact === 'string') ||
    !(
      value.sha256 === null ||
      (typeof value.sha256 === 'string' && /^[0-9a-f]{64}$/.test(value.sha256))
    ) ||
    typeof value.complete !== 'boolean' ||
    !Array.isArray(value.errors) ||
    !value.errors.every((error) => typeof error === 'string') ||
    !isNonNegativeSafeInteger(value.captureCount) ||
    !isNonNegativeSafeInteger(value.daemonCount) ||
    typeof value.freshAtRunEnd !== 'boolean' ||
    !Array.isArray(value.latestByDaemon) ||
    !value.latestByDaemon.every(isDaemonTransportFinalCapture) ||
    value.daemonCount !== value.latestByDaemon.length
  ) {
    return false;
  }
  return value.complete
    ? value.artifact !== null &&
        value.sha256 !== null &&
        value.errors.length === 0 &&
        value.captureCount > 0 &&
        value.freshAtRunEnd
    : true;
}

function isDaemonTransportFinalCapture(value: unknown): value is DaemonTransportFinalCapture {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'daemonId',
      'captureRequestedAtMs',
      'captureCompletedAtMs',
      'healthCheckedAtMs',
      'observedAtMs',
      'sampleCount',
      'captureRequestToSampleMs',
      'sampleToRunEndMs',
      'captureCompletionToRunEndMs',
      'latest',
      'aggregate',
    ]) &&
    typeof value.daemonId === 'string' &&
    value.daemonId.length > 0 &&
    isNonNegativeSafeInteger(value.captureRequestedAtMs) &&
    isNonNegativeSafeInteger(value.captureCompletedAtMs) &&
    isNonNegativeSafeInteger(value.healthCheckedAtMs) &&
    isNonNegativeSafeInteger(value.observedAtMs) &&
    isPositiveSafeInteger(value.sampleCount) &&
    isFiniteNumber(value.captureRequestToSampleMs) &&
    isFiniteNumber(value.sampleToRunEndMs) &&
    isFiniteNumber(value.captureCompletionToRunEndMs) &&
    isDataplaneTransportStats(value.latest) &&
    isDataplaneTransportStats(value.aggregate)
  );
}

async function findNamedFiles(directory: string, filename: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await findNamedFiles(child, filename)));
    else if (entry.isFile() && entry.name === filename) files.push(child);
  }
  return files;
}

async function readJsonIfPresent(filename: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filename, 'utf8'));
  } catch {
    return null;
  }
}

async function unlinkIfPresent(filename: string): Promise<void> {
  try {
    await unlink(filename);
  } catch (error) {
    if (!isErrnoException(error) || error.code !== 'ENOENT') throw error;
  }
}

export async function writeMatrixArtifact(filename: string, value: unknown): Promise<void> {
  const directory = path.dirname(filename);
  const temporary = path.join(
    directory,
    `.${path.basename(filename)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    await rename(temporary, filename);
  } catch (error) {
    try {
      await unlink(temporary);
    } catch {
      // The write may have failed before creating the temporary or rename may
      // already have consumed it. Preserve the original checkpoint error.
    }
    throw error;
  }
}

/** Build every ignored/native artifact the harness executes before hashing it. */
async function buildMatrixRuntimeArtifacts(): Promise<void> {
  for (const command of [
    ['bun', 'run', 'build:wasm'],
    ['bun', 'run', 'build:dataplane'],
    ['cargo', 'build', '--release', '--locked', '-p', 'merkur-edge', '--bins'],
  ] as const) {
    process.stdout.write(`[network-matrix] build ${command.join(' ')}\n`);
    const child = Bun.spawn([...command], { cwd: ROOT, stdout: 'inherit', stderr: 'inherit' });
    const exitCode = await child.exited;
    if (exitCode !== 0) throw new Error(`${command.join(' ')} failed (${exitCode})`);
  }
}

/**
 * Bind resumable cells to the exact dirty-tree inputs and every ignored/native
 * artifact the harness executes. HEAD alone is insufficient during an
 * optimization campaign, and a source hash cannot detect a stale release
 * binary or WASM module.
 */
export async function computeExecutionFingerprint(): Promise<string> {
  const [head, trackedDiff, untrackedRaw] = await Promise.all([
    runGit(['rev-parse', 'HEAD']),
    runGit(['diff', '--binary', 'HEAD', '--', '.']),
    runGit(['ls-files', '--others', '--exclude-standard', '-z']),
  ]);
  const hash = createHash('sha256');
  hash.update('merkur-network-matrix-execution-v2\0');
  hash.update(head);
  hash.update('\0tracked-diff\0');
  hash.update(trackedDiff);
  const untracked = new TextDecoder()
    .decode(untrackedRaw)
    .split('\0')
    .filter((filename) => filename.length > 0)
    .sort();
  for (const filename of untracked) {
    hash.update('\0untracked-path\0');
    hash.update(filename);
    hash.update('\0untracked-content\0');
    hash.update(await readFile(path.join(ROOT, filename)));
  }
  for (const filename of MATRIX_RUNTIME_ARTIFACTS) {
    hash.update('\0runtime-artifact-path\0');
    hash.update(filename);
    hash.update('\0runtime-artifact-content\0');
    hash.update(await readFile(path.join(ROOT, filename)));
  }
  return `sha256:${hash.digest('hex')}`;
}

async function runGit(args: readonly string[]): Promise<Uint8Array> {
  const child = Bun.spawn(['git', ...args], {
    cwd: ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${exitCode}): ${stderr.trim()}`);
  }
  return new Uint8Array(stdout);
}

function parseSeeds(raw: string): readonly number[] {
  const values = parseCsv(raw);
  return values.map((value) => {
    if (!/^\d+$/.test(value)) throw new Error('--seeds values must be unsigned 32-bit integers');
    const seed = Number(value);
    if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
      throw new Error('--seeds values must be unsigned 32-bit integers');
    }
    return seed;
  });
}

function parseLossPercentages(raw: string): readonly EdgeNetworkDatagramLossPercent[] {
  return parseCsv(raw).map((value) => {
    const loss = Number(value);
    if (!EDGE_NETWORK_DATAGRAM_LOSS_PERCENTAGES.includes(loss as EdgeNetworkDatagramLossPercent)) {
      throw new Error('--datagram-loss values must be 0, 1, 3, or 9');
    }
    return loss as EdgeNetworkDatagramLossPercent;
  });
}

function parseMembers<const T extends readonly string[]>(
  name: string,
  raw: string,
  allowed: T,
): readonly T[number][] {
  return parseCsv(raw).map((value) => {
    if (!allowed.some((candidate) => candidate === value)) {
      throw new Error(`${name} values must be ${allowed.join(', ')}`);
    }
    return value as T[number];
  });
}

function parseCsv(raw: string): string[] {
  const values = raw.split(',');
  if (values.length === 0 || values.some((value) => value.length === 0 || value.trim() !== value)) {
    throw new Error('matrix lists must be non-empty comma-separated values without whitespace');
  }
  return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCapturedLatencySummary(value: unknown): value is CapturedLatencySummary {
  return (
    isRecord(value) &&
    typeof value.artifact === 'string' &&
    value.artifact.length > 0 &&
    isCapturedRawEvents(value.rawEvents) &&
    typeof value.testId === 'string' &&
    value.testId.length > 0 &&
    typeof value.testTitle === 'string' &&
    value.testTitle.length > 0 &&
    typeof value.testFile === 'string' &&
    value.testFile.length > 0 &&
    (value.testStatus === null || typeof value.testStatus === 'string') &&
    typeof value.testExpectedStatus === 'string' &&
    value.testExpectedStatus.length > 0 &&
    isCapturedGridConvergenceEvidence(value.gridConvergence) &&
    isNonNegativeSafeInteger(value.measurementWindowCount) &&
    (value.measurementPurpose === null ||
      value.measurementPurpose === 'coherent-redraw' ||
      value.measurementPurpose === 'isolated-interactive' ||
      value.measurementPurpose === 'streaming') &&
    typeof value.complete === 'boolean' &&
    Array.isArray(value.errors) &&
    value.errors.every((error) => typeof error === 'string') &&
    isRecord(value.metrics) &&
    (value.proxyImpairment === null || parseProxyImpairmentStats(value.proxyImpairment) !== null) &&
    isProxyFaultEvidence(value.proxyFaultEvidence)
  );
}

function isCapturedGridConvergenceEvidence(
  value: unknown,
): value is CapturedGridConvergenceEvidence {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['complete', 'error', 'selectiveRepairCount', 'probes']) &&
    typeof value.complete === 'boolean' &&
    (value.error === null || typeof value.error === 'string') &&
    isNonNegativeSafeInteger(value.selectiveRepairCount) &&
    Array.isArray(value.probes) &&
    value.probes.every(isCapturedGridConvergenceProbe)
  );
}

function isCapturedGridConvergenceProbe(value: unknown): value is CapturedGridConvergenceProbe {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['purpose', 'repair', 'result']) ||
    (value.purpose !== 'reset-precondition' &&
      value.purpose !== 'observation-ack' &&
      value.purpose !== 'final-verification') ||
    typeof value.repair !== 'boolean' ||
    !isPerfGridConvergenceResult(value.result)
  ) {
    return false;
  }
  const expectedRepair = value.purpose === 'reset-precondition';
  return (
    value.repair === expectedRepair && (value.repair || value.result.selectiveRepairCount === 0)
  );
}

function isPerfGridConvergenceResult(value: unknown): value is PerfGridConvergenceResult {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'observationEpoch',
      'probeId',
      'converged',
      'failureReason',
      'attempts',
      'selectiveRepairCount',
      'generation',
      'lastAdmittedDisplaySeq',
      'rows',
      'elapsedMs',
    ]) &&
    isPositiveUint32(value.observationEpoch) &&
    isPositiveUint32(value.probeId) &&
    value.converged === true &&
    value.failureReason === null &&
    isNonNegativeSafeInteger(value.attempts) &&
    value.attempts > 0 &&
    isNonNegativeSafeInteger(value.selectiveRepairCount) &&
    isPositiveUint32(value.generation) &&
    isUint32(value.lastAdmittedDisplaySeq) &&
    isNonNegativeSafeInteger(value.rows) &&
    value.rows > 0 &&
    typeof value.elapsedMs === 'number' &&
    Number.isFinite(value.elapsedMs) &&
    value.elapsedMs >= 0
  );
}

function isUint32(value: unknown): value is number {
  return isNonNegativeSafeInteger(value) && value <= 0xffff_ffff;
}

function isPositiveUint32(value: unknown): value is number {
  return isUint32(value) && value > 0;
}

function isCapturedRawEvents(value: unknown): value is CapturedLatencySummary['rawEvents'] {
  return (
    isRecord(value) &&
    (value.artifact === null ||
      (typeof value.artifact === 'string' && value.artifact.length > 0)) &&
    (value.sha256 === null ||
      (typeof value.sha256 === 'string' && /^[0-9a-f]{64}$/.test(value.sha256))) &&
    (value.eventCount === null || isNonNegativeSafeInteger(value.eventCount)) &&
    (value.reportSha256 === null ||
      (typeof value.reportSha256 === 'string' && /^[0-9a-f]{64}$/.test(value.reportSha256))) &&
    (value.applicationDisplayOutcomeSha256 === null ||
      (typeof value.applicationDisplayOutcomeSha256 === 'string' &&
        /^[0-9a-f]{64}$/.test(value.applicationDisplayOutcomeSha256))) &&
    isRawTerminalMetricSamples(value.metricSamples) &&
    isRawTerminalMetricCompleteness(value.metricComplete) &&
    typeof value.complete === 'boolean' &&
    (value.error === null || typeof value.error === 'string') &&
    (value.complete
      ? value.artifact !== null &&
        value.sha256 !== null &&
        value.eventCount !== null &&
        value.reportSha256 !== null &&
        value.applicationDisplayOutcomeSha256 !== null &&
        value.error === null
      : value.error !== null)
  );
}

function isRawTerminalMetricCompleteness(
  value: unknown,
): value is Readonly<Record<RawTerminalMetricName, boolean>> {
  return (
    isRecord(value) &&
    hasExactKeys(value, RAW_TERMINAL_SAMPLE_METRICS) &&
    RAW_TERMINAL_SAMPLE_METRICS.every((name) => typeof value[name] === 'boolean')
  );
}

function isRawTerminalMetricSamples(value: unknown): value is RawTerminalMetricSamples {
  return (
    isRecord(value) &&
    hasExactKeys(value, RAW_TERMINAL_SAMPLE_METRICS) &&
    RAW_TERMINAL_SAMPLE_METRICS.every(
      (name) =>
        Array.isArray(value[name]) &&
        value[name].every(
          (sample) => typeof sample === 'number' && Number.isFinite(sample) && sample >= 0,
        ),
    )
  );
}

function isProxyFaultEvidence(value: unknown): value is ProxyFaultEvidence {
  return (
    isRecord(value) &&
    typeof value.exactLossObserved === 'boolean' &&
    typeof value.exactLossSelectorWindowVerified === 'boolean' &&
    typeof value.reorderObserved === 'boolean' &&
    typeof value.burstLossObserved === 'boolean' &&
    typeof value.congestionObserved === 'boolean'
  );
}

function normalizedTestFileMatches(testFile: string, expectedFile: string): boolean {
  const normalized = testFile.replaceAll('\\', '/');
  return normalized === expectedFile || normalized.endsWith(`/${expectedFile}`);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly PropertyKey[]): boolean {
  const actual = Reflect.ownKeys(value);
  return actual.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function isErrnoException(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value;
}

function formatError(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

if (import.meta.main) {
  await main();
}
