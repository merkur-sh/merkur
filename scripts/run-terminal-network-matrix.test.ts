import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { BROWSER_DISPLAY_IO_SCOPE } from '../apps/web/src/perf/browser-display-io';
import {
  buildTerminalLatencyReport,
  type TerminalPerfEvent,
} from '../apps/web/src/perf/terminal-latency';
import {
  collectApplicationDisplayOutcome,
  TERMINAL_PERF_ARTIFACT_SCHEMA_VERSION,
} from '../tests/e2e/fixtures/terminal-perf-artifacts';
import {
  extractPercentileMetrics,
  verifyRawTerminalPerfTrace,
} from '../tests/e2e/fixtures/terminal-perf-replay';
import { resolveEdgeNetworkConfig } from './edge-network-profile';
import {
  analyzeDaemonTransportLogLines,
  buildMatrixRawSampleRollups,
  buildNetworkMatrixCells,
  captureGridConvergenceEvidence,
  DEFAULT_NETWORK_MATRIX_SEEDS,
  loadCompatibleMatrixCheckpoint,
  matrixCellId,
  matrixEnvironment,
  RAW_TERMINAL_SAMPLE_METRICS,
  type RawTerminalMetricName,
  type RawTerminalMetricSamples,
  REQUIRED_COHERENT_REDRAW_EVIDENCE,
  REQUIRED_TEST_EVIDENCE,
  validateApplicationDisplayOutcomeEvidence,
  validateBrowserRuntimeEvidence,
  validateCarrierRepairPresentationEvidence,
  validateCellDisplayFaultEvidence,
  validateCellProxyFaultEvidence,
  validateDaemonNetworkProfileEvidence,
  validateExpectedTestEvidence,
  validateForcedResyncPresentationEvidence,
  validateLatencySummaryEvidence,
  validateMatrixHeadlineEvidence,
  validateProxyArtifactEvidence,
  validateWorkloadPresentationEvidence,
  writeMatrixArtifact,
} from './run-terminal-network-matrix';

function rawMetricSamples(
  overrides: Partial<Record<RawTerminalMetricName, readonly number[]>> = {},
): RawTerminalMetricSamples {
  return Object.fromEntries(
    RAW_TERMINAL_SAMPLE_METRICS.map((name) => [name, overrides[name] ?? []]),
  ) as RawTerminalMetricSamples;
}

function rawMetricCompleteness(
  complete = true,
  overrides: Partial<Record<RawTerminalMetricName, boolean>> = {},
): Readonly<Record<RawTerminalMetricName, boolean>> {
  return Object.fromEntries(
    RAW_TERMINAL_SAMPLE_METRICS.map((name) => [name, overrides[name] ?? complete]),
  ) as Readonly<Record<RawTerminalMetricName, boolean>>;
}

function gridConvergenceResult(
  observationEpoch: number,
  selectiveRepairCount = 0,
): Record<string, unknown> {
  return {
    observationEpoch,
    probeId: observationEpoch + 100,
    converged: true,
    failureReason: null,
    attempts: 1,
    selectiveRepairCount,
    generation: 3,
    lastAdmittedDisplaySeq: 19,
    rows: 24,
    elapsedMs: 12,
  };
}

function gridConvergenceEvidence(selectiveRepairCount = 0): Record<string, unknown> {
  return {
    complete: true,
    error: null,
    selectiveRepairCount,
    probes: [
      {
        purpose: 'reset-precondition',
        repair: true,
        result: gridConvergenceResult(7, selectiveRepairCount),
      },
      {
        purpose: 'observation-ack',
        repair: false,
        result: gridConvergenceResult(8),
      },
      {
        purpose: 'final-verification',
        repair: false,
        result: gridConvergenceResult(8),
      },
    ],
  };
}

function pathStats(overrides: Record<string, number> = {}): Record<string, number> {
  return {
    pathsAvailable: 1,
    pathsLive: 1,
    rttEwmaUsMax: 50_000,
    networkRttEwmaUsMax: 50_000,
    jitterEwmaUsMax: 5_000,
    sendFailuresMax: 0,
    lastAckAgeMsMax: 5,
    displayDatagramsReceived: 4,
    displayDatagramsRecoveredByFec: 0,
    displayDatagramsDeclaredLost: 0,
    displayDatagramsOutcomeUnknown: 0,
    quicSentPackets: 6,
    quicLostPackets: 0,
    quicLostBytes: 0,
    quicCongestionEvents: 0,
    quicBlackHoles: 0,
    quicDatagramsTx: 4,
    quicDatagramsRx: 4,
    quicUdpTxBytes: 4_000,
    quicUdpRxBytes: 4_000,
    quicMtuMin: 1_200,
    quicCwndBytesMin: 12_000,
    quicRttUsMax: 25_000,
    ...overrides,
  };
}

function transportStats(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    windowMs: 10_000,
    peers: 1,
    parkedPeers: 0,
    webtransport: pathStats(),
    edge: pathStats(),
    rowVersionsSent: 8,
    rowVersionsSupersededUnapplied: 0,
    rowVersionsSupersededApplied: 0,
    rowResendsIdentical: 0,
    stalePreparedFlushesSent: 0,
    burstsAbandoned: 0,
    burstsUnsafeToRewind: 0,
    datagramSendFailures: 0,
    fecRepairsSent: 0,
    fecRepairsRefused: 0,
    resyncRowsRequested: 0,
    rowsDeclaredLost: 0,
    unackedDatagramsMax: 2,
    edgeReliableQueuedBytesMax: 0,
    inboundDatagramDropsWt: 0,
    inboundDatagramDropsEdge: 0,
    overCapacitySessionRejections: 0,
    directWtIncomingExpected: 0,
    directWtIncomingUnexpected: 0,
    directWtAdmitted: 0,
    natKeepalivesSent: 0,
    natPunchBurstsSent: 0,
    natPunchRefusedNotGlobal: 0,
    natPunchRefusedRateLimited: 0,
    natSideChannelSendFailed: 0,
    natSideChannelWouldBlock: 0,
    statsEventsDropped: 0,
    rebindRequests: 0,
    rebindAccepted: 0,
    rebindCommitted: 0,
    rebindRefused: 0,
    rebindEnvelopesRejected: 0,
    rebindEventsSuppressed: 0,
    ...overrides,
  };
}

function daemonCaptureLine(options: {
  readonly daemonId?: string;
  readonly captureRequestedAtMs: number;
  readonly captureCompletedAtMs: number;
  readonly healthCheckedAtMs: number;
  readonly observedAtMs: number;
  readonly sampleCount: number;
  readonly latest?: Record<string, unknown>;
  readonly aggregate?: Record<string, unknown>;
}): string {
  return JSON.stringify({
    ts: new Date(options.healthCheckedAtMs).toISOString(),
    level: 'info',
    scope: 'daemon',
    message: 'daemon_transport_capture_complete',
    context: {
      daemonId: options.daemonId ?? 'daemon-1',
      captureRequestedAtMs: options.captureRequestedAtMs,
      captureCompletedAtMs: options.captureCompletedAtMs,
      health: { checkedAt: options.healthCheckedAtMs },
      metrics: {
        latestDataplaneTransport: {
          observedAtMs: options.observedAtMs,
          sampleCount: options.sampleCount,
          latest: options.latest ?? transportStats(),
          aggregate:
            options.aggregate ??
            transportStats({ windowMs: options.sampleCount * 10_000, rowVersionsSent: 8 }),
        },
      },
    },
  });
}

function proxyImpairment(
  overrides: {
    readonly profile?: 'fast' | 'typical' | 'difficult';
    readonly targetRttMs?: number;
    readonly baseDelayUs?: number;
    readonly jitterRadiusUs?: number;
    readonly datagramLossPercent?: number;
    readonly reorder?: string;
    readonly scenario?: string;
    readonly seed?: number;
    readonly seen?: number;
    readonly exactLossDropped?: number;
    readonly burstLossDropped?: number;
    readonly achievedPacketLossPercent?: number;
    readonly logicalObservedFaultSitePackets?: number;
    readonly logicalDroppedAtFaultSite?: number;
    readonly reordered?: number;
    readonly congested?: number;
    readonly congestedForwarded?: number;
    readonly pendingScheduledPackets?: number;
    readonly leaseExhaustedDrops?: number;
    readonly releasedSampleCount?: number;
    readonly releaseOvershootUs?: number;
    readonly releaseEarlyCount?: number;
  } = {},
): Record<string, unknown> {
  const seen = overrides.seen ?? 200;
  const exactLossDropped = overrides.exactLossDropped ?? 0;
  const burstLossDropped = overrides.burstLossDropped ?? 0;
  const dropped = exactLossDropped + burstLossDropped;
  const forwarded = seen - dropped;
  const baseDelayUs = overrides.baseDelayUs ?? 30_000;
  const jitterRadiusUs = overrides.jitterRadiusUs ?? 3_750;
  const jitterSpreadUs = Math.max(1, Math.floor(jitterRadiusUs / 2));
  const direction = (upstream: boolean): Record<string, unknown> => {
    const releasedCount = overrides.releasedSampleCount ?? (upstream ? seen : forwarded);
    const releaseOvershootUs = overrides.releaseOvershootUs ?? 100;
    const congested = upstream ? 0 : (overrides.congested ?? 0);
    const congestedForwarded = upstream ? 0 : (overrides.congestedForwarded ?? congested);
    const scheduledCount = upstream ? seen : forwarded;
    const scheduledMin = baseDelayUs - jitterSpreadUs;
    const scheduledMax = baseDelayUs + jitterSpreadUs;
    const actualMin = scheduledMin + releaseOvershootUs;
    const actualMax = scheduledMax + releaseOvershootUs;
    const actualP50 = Math.min(
      actualMax,
      Math.ceil((baseDelayUs + releaseOvershootUs) / 500) * 500,
    );
    return {
      seen,
      forwarded: upstream ? seen : forwarded,
      dropped: upstream ? 0 : dropped,
      exactLossDropped: upstream ? 0 : exactLossDropped,
      burstLossDropped: upstream ? 0 : burstLossDropped,
      burstLossRunsCompleted: upstream ? 0 : burstLossDropped >= 4 ? 1 : 0,
      jittered: Math.max(0, seen - 10),
      reorderInversions: upstream ? 0 : (overrides.reordered ?? 0),
      reordered: upstream ? 0 : (overrides.reordered ?? 0),
      congested,
      congestedForwarded,
      congestionClamped: 0,
      maxCongestionQueueDelayUs: congested >= 2 ? 8_000 : 0,
      maxForwardedCongestionQueueDelayUs: congestedForwarded >= 2 ? 8_000 : 0,
      achievedPacketLossPercent: upstream
        ? 0
        : (overrides.achievedPacketLossPercent ?? (seen === 0 ? 0 : (dropped * 100) / seen)),
      scheduledDelayUs: {
        count: scheduledCount,
        mean: baseDelayUs,
        min: scheduledMin,
        p50: baseDelayUs,
        p95: scheduledMax,
        p99: scheduledMax,
        max: scheduledMax,
        histogramBucketUs: 500,
        histogram: proxyDelayHistogram(
          scheduledCount,
          scheduledMin,
          baseDelayUs,
          scheduledMax,
          scheduledMax,
          scheduledMax,
        ),
      },
      releaseTargetResidenceUs: {
        count: releasedCount,
        mean: baseDelayUs,
        min: baseDelayUs - jitterSpreadUs,
        p50: baseDelayUs,
        p95: baseDelayUs + jitterSpreadUs,
        p99: baseDelayUs + jitterSpreadUs,
        max: baseDelayUs + jitterSpreadUs,
        histogramBucketUs: 500,
        histogram: proxyDelayHistogram(
          releasedCount,
          scheduledMin,
          baseDelayUs,
          scheduledMax,
          scheduledMax,
          scheduledMax,
        ),
      },
      actualResidenceUs: {
        count: releasedCount,
        mean: baseDelayUs + releaseOvershootUs,
        min: actualMin,
        p50: actualP50,
        p95: actualMax,
        p99: actualMax,
        max: actualMax,
        histogramBucketUs: 500,
        histogram: proxyDelayHistogram(
          releasedCount,
          actualMin,
          actualP50,
          actualMax,
          actualMax,
          actualMax,
        ),
      },
      releaseOvershootUs: {
        count: releasedCount,
        mean: releaseOvershootUs,
        min: releaseOvershootUs,
        p50: releaseOvershootUs,
        p95: releaseOvershootUs,
        p99: releaseOvershootUs,
        max: releaseOvershootUs,
        histogramBucketUs: 500,
        histogram: proxyDelayHistogram(
          releasedCount,
          releaseOvershootUs,
          releaseOvershootUs,
          releaseOvershootUs,
          releaseOvershootUs,
          releaseOvershootUs,
        ),
      },
      releaseEarlyCount: overrides.releaseEarlyCount ?? 0,
      maxReleaseEarlyUs: (overrides.releaseEarlyCount ?? 0) > 0 ? 500 : 0,
    };
  };
  const datagramLossPercent = overrides.datagramLossPercent ?? 0;
  const pendingScheduledPackets = overrides.pendingScheduledPackets ?? 0;
  // One relay saw everything from ordinal zero, so its complete windows are
  // the aggregate's and every exact-loss drop fell inside them.
  const exactLossWindowsCompleted = Math.floor(seen / 100);
  return {
    schemaVersion: 9,
    epoch: 2,
    config: {
      profile: overrides.profile ?? 'typical',
      targetRttMs: overrides.targetRttMs ?? 120,
      baseDelayUs,
      jitterRadiusUs,
      datagramLossPercent,
      faultSite: 'edge-to-client',
      faultSitesPerLogicalDirection: 1,
      reorder: overrides.reorder ?? 'none',
      scenario: overrides.scenario ?? 'steady',
      seed: overrides.seed ?? 7,
    },
    upstream: direction(true),
    downstream: direction(false),
    logicalPathImpairment: {
      faultSite: 'edge-to-client',
      faultSitesPerLogicalDirection: 1,
      requestedDatagramLossPercent: datagramLossPercent,
      observedFaultSitePackets: overrides.logicalObservedFaultSitePackets ?? seen,
      droppedAtFaultSite: overrides.logicalDroppedAtFaultSite ?? dropped,
      achievedPacketLossPercent:
        overrides.achievedPacketLossPercent ?? (seen === 0 ? 0 : (dropped * 100) / seen),
    },
    harnessDrops: {
      oversized: 0,
      admission: 0,
      leaseExhausted: overrides.leaseExhaustedDrops ?? 0,
    },
    splitDatagrams: 0,
    pendingScheduledPackets,
    exactLossWindowsCompleted,
    exactLossDroppedInCompletedWindows: exactLossWindowsCompleted === 0 ? 0 : exactLossDropped,
    relays: [
      {
        admissionSeq: 1,
        listener: { role: 'browser', competitor: false },
        upstreamPort: 50_001,
        pending: pendingScheduledPackets,
        upSeen: seen,
        downSeen: seen,
        downDropped: dropped,
        downReordered: overrides.reordered ?? 0,
        upMaxInFlight: 12,
        downMaxInFlight: 14,
        bottleneckDrops: 0,
      },
    ],
    links: [],
    relayLinks: [],
  };
}

function proxyDelayHistogram(
  count: number,
  minimumUs: number,
  p50Us: number,
  p95Us: number,
  p99Us: number,
  maximumUs: number,
): number[] {
  const histogram = Array<number>(512).fill(0);
  if (count === 0) return histogram;
  const add = (bucket: number, amount: number): void => {
    const index = Math.min(511, Math.max(0, bucket));
    histogram[index] = (histogram[index] ?? 0) + amount;
  };
  const quantileBucket = (valueUs: number): number =>
    valueUs === maximumUs ? Math.floor(valueUs / 500) : Math.max(0, Math.ceil(valueUs / 500) - 1);
  const rank50 = Math.ceil(count * 0.5);
  const rank95 = Math.ceil(count * 0.95);
  const rank99 = Math.ceil(count * 0.99);
  add(Math.floor(minimumUs / 500), 1);
  add(quantileBucket(p50Us), rank50 - 1);
  add(quantileBucket(p95Us), rank95 - rank50);
  add(quantileBucket(p99Us), rank99 - rank95);
  add(Math.floor(maximumUs / 500), count - rank99);
  return histogram;
}

describe('terminal network matrix', () => {
  test('uses two distinct deterministic seeds for acceptance-grade default tails', () => {
    expect(DEFAULT_NETWORK_MATRIX_SEEDS).toHaveLength(2);
    expect(new Set(DEFAULT_NETWORK_MATRIX_SEEDS).size).toBe(2);
  });

  test('replays mandatory raw traces and rejects corrupt or mismatched artifacts', () => {
    const events: TerminalPerfEvent[] = [
      {
        kind: 'main_frame_cadence',
        atMs: 10,
        gapMs: 8.33,
        longTaskObserverSupported: true,
      },
      { kind: 'main_long_task', atMs: 12, durationMs: 51 },
      {
        kind: 'browser_display_io',
        atMs: 14,
        stage: 'transport_ingress',
        ingressRoute: 'direct-datagram',
        displaySeq: 1,
        generation: 1,
        frameId: 1,
        chunkIndex: 0,
        chunkCount: 1,
        payloadByteLength: 512,
        admitted: true,
        fecRecovered: false,
        explicitCopyCount: 1,
        explicitCopiedBytes: 512,
        explicitAllocationRequestCount: 1,
        explicitAllocationRequestedBytes: 512,
        explicitObjectAllocationRequestCount: 0,
      },
    ];
    const report = buildTerminalLatencyReport(events);
    const applicationDisplayOutcome = collectApplicationDisplayOutcome(events);
    const compressed = gzipSync(JSON.stringify(events));

    expect(verifyRawTerminalPerfTrace(compressed, 3, report, applicationDisplayOutcome)).toEqual(
      expect.objectContaining({
        eventCount: 3,
        reportSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        applicationDisplayOutcomeSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        metricSamples: rawMetricSamples(),
        metricComplete: expect.any(Object),
      }),
    );
    expect(() =>
      verifyRawTerminalPerfTrace(compressed, 2, report, applicationDisplayOutcome),
    ).toThrow('raw terminal event count 3 does not match summary 2');
    expect(() =>
      verifyRawTerminalPerfTrace(
        compressed.subarray(0, compressed.length - 3),
        3,
        report,
        applicationDisplayOutcome,
      ),
    ).toThrow('raw terminal event trace is not valid gzip JSON');
    expect(() =>
      verifyRawTerminalPerfTrace(
        gzipSync(JSON.stringify([{ kind: 'invented_event', atMs: 1 }])),
        1,
        report,
        applicationDisplayOutcome,
      ),
    ).toThrow('raw terminal event trace contains a malformed event envelope');
    expect(() =>
      verifyRawTerminalPerfTrace(
        compressed,
        3,
        { ...report, sampleCount: 1 },
        applicationDisplayOutcome,
      ),
    ).toThrow('raw terminal event replay does not match the retained latency report');
    expect(() =>
      verifyRawTerminalPerfTrace(compressed, 3, report, {
        ...applicationDisplayOutcome,
        receivedEventCount: 1,
      }),
    ).toThrow('raw terminal event replay does not match the retained application display outcome');
  });

  test('covers every required RTT, loss, and reorder cell plus bounded stress profiles', () => {
    const cells = buildNetworkMatrixCells(
      ['fast', 'typical', 'difficult'],
      [0, 1, 3, 9],
      [7],
      true,
      true,
    );
    expect(cells).toHaveLength(40);

    for (const profile of ['fast', 'typical', 'difficult'] as const) {
      const expectedReorder = profile === 'fast' ? 'light' : 'moderate';
      for (const lossPercent of [0, 1, 3, 9] as const) {
        if (profile === 'fast' && lossPercent === 9) continue;
        expect(cells).toContainEqual({
          phase: 'workload',
          profile,
          datagramLossPercent: lossPercent,
          reorder: 'none',
          scenario: 'steady',
          seed: 7,
        });
        expect(cells).toContainEqual({
          phase: 'workload',
          profile,
          datagramLossPercent: lossPercent,
          reorder: expectedReorder,
          scenario: 'steady',
          seed: 7,
        });
      }
      expect(cells).toContainEqual({
        phase: 'workload',
        profile,
        datagramLossPercent: 0,
        reorder: 'none',
        scenario: 'burst-loss',
        seed: 7,
      });
      expect(cells).toContainEqual({
        phase: 'recovery',
        profile,
        datagramLossPercent: profile === 'fast' ? 3 : 9,
        reorder: expectedReorder,
        scenario: 'steady',
        seed: 7,
      });
      expect(cells).toContainEqual({
        phase: 'recovery',
        profile,
        datagramLossPercent: 0,
        reorder: expectedReorder,
        scenario: 'burst-loss',
        seed: 7,
      });
      expect(cells).toContainEqual({
        phase: 'recovery',
        profile,
        datagramLossPercent: profile === 'fast' ? 3 : 9,
        reorder: expectedReorder,
        scenario: 'congestion',
        seed: 7,
      });
      expect(cells).toContainEqual({
        phase: 'workload',
        profile,
        datagramLossPercent: 3,
        reorder: expectedReorder,
        scenario: 'congestion',
        seed: 7,
      });
      expect(cells).toContainEqual({
        phase: 'recovery',
        profile,
        datagramLossPercent: 0,
        reorder: 'none',
        scenario: 'steady',
        seed: 7,
      });
    }
  });

  test('keeps seed repetitions as independent raw cells', () => {
    const cells = buildNetworkMatrixCells(['fast'], [1], [11, 12], false, false);
    expect(cells).toEqual([
      {
        phase: 'workload',
        profile: 'fast',
        datagramLossPercent: 1,
        reorder: 'none',
        scenario: 'steady',
        seed: 11,
      },
      {
        phase: 'workload',
        profile: 'fast',
        datagramLossPercent: 1,
        reorder: 'light',
        scenario: 'steady',
        seed: 11,
      },
      {
        phase: 'workload',
        profile: 'fast',
        datagramLossPercent: 1,
        reorder: 'none',
        scenario: 'steady',
        seed: 12,
      },
      {
        phase: 'workload',
        profile: 'fast',
        datagramLossPercent: 1,
        reorder: 'light',
        scenario: 'steady',
        seed: 12,
      },
    ]);
  });

  test('headline acceptance requires 100 replayed observations in each claimed population', () => {
    const cells = buildNetworkMatrixCells(['fast'], [0], [11, 12], false, false).filter(
      (cell) => cell.reorder === 'none',
    );
    const makeRuns = (sampleCount: number) =>
      cells.map((cell, index) => ({
        id: matrixCellId(cell),
        cell,
        exitCode: 0,
        daemonTransport: { complete: true },
        latencyEvidenceErrors: [],
        latencySummaries: [
          {
            testFile: 'terminal-performance-matrix.e2e.ts',
            testTitle: 'interaction: isolated single-character feedback is independently fenced',
            measurementPurpose: 'isolated-interactive' as const,
          },
          ...REQUIRED_COHERENT_REDRAW_EVIDENCE.map((test) => ({
            testFile: test.file,
            testTitle: test.title,
            measurementPurpose: 'coherent-redraw' as const,
          })),
        ].map((summary) => ({
          ...summary,
          proxyImpairment: validateProxyArtifactEvidence(
            proxyImpairment({
              profile: 'fast',
              targetRttMs: 50,
              baseDelayUs: 12_500,
              jitterRadiusUs: 1_250,
              reorder: cell.reorder,
              seed: cell.seed,
            }),
            cell,
          ).stats,
          rawEvents: {
            complete: true,
            eventCount: 1_000,
            metricComplete: rawMetricCompleteness(),
            metricSamples: rawMetricSamples(
              Object.fromEntries(
                RAW_TERMINAL_SAMPLE_METRICS.map((name) => [
                  name,
                  Array.from(
                    { length: index === 0 ? 50 : sampleCount - 50 },
                    (_, sample) => sample,
                  ),
                ]),
              ),
            ),
          },
        })),
      }));

    const tooFew = buildMatrixRawSampleRollups(cells, makeRuns(99));
    expect(tooFew.coherentRedrawByProfile[0]?.complete).toBe(true);
    expect(validateMatrixHeadlineEvidence(cells, tooFew)).toContain(
      'fast/isolated-typing/physicalInputToAdmissionMs: requires at least 100 complete observations and p99',
    );
    const enough = buildMatrixRawSampleRollups(cells, makeRuns(100));
    expect(validateMatrixHeadlineEvidence(cells, enough)).toEqual([]);
    const shortProxy = {
      ...enough,
      proxyDelayByScenario: enough.proxyDelayByScenario.map((rollup) => ({
        ...rollup,
        metrics: {
          ...rollup.metrics,
          'downstream.actualResidenceUs': {
            ...rollup.metrics['downstream.actualResidenceUs'],
            count: 99,
            histogram: rollup.metrics['downstream.actualResidenceUs'].histogram.map((_, index) =>
              index === 0 ? 99 : 0,
            ),
            saturatedBucketCount: 0,
          },
        },
      })),
    };
    expect(
      validateMatrixHeadlineEvidence(cells, shortProxy).some((error) =>
        error.includes('downstream.actualResidenceUs: requires 100'),
      ),
    ).toBe(true);
    expect(
      validateMatrixHeadlineEvidence(cells, { ...enough, proxyDelayByScenario: [] }).some((error) =>
        error.includes('missing complete residence/delay population'),
      ),
    ).toBe(true);
    const badProxy = {
      ...enough,
      proxyDelayByScenario: enough.proxyDelayByScenario.map((rollup) => ({
        ...rollup,
        metrics: {
          ...rollup.metrics,
          'downstream.actualResidenceUs': {
            ...rollup.metrics['downstream.actualResidenceUs'],
            saturatedBucketCount: 100,
          },
        },
      })),
    };
    expect(
      validateMatrixHeadlineEvidence(cells, badProxy).some((error) =>
        error.includes('downstream.actualResidenceUs: requires 100'),
      ),
    ).toBe(true);
    const saturatedRuns = makeRuns(100).map((run) => ({
      ...run,
      latencySummaries: run.latencySummaries.map((summary) => {
        const stats = summary.proxyImpairment;
        if (stats === null) throw new Error('missing proxy fixture');
        const metric = stats.upstream.actualResidenceUs;
        return {
          ...summary,
          proxyImpairment: {
            ...stats,
            upstream: {
              ...stats.upstream,
              actualResidenceUs: {
                ...metric,
                min: 300_000,
                mean: 300_000,
                max: 300_000,
                p50: 300_000,
                p95: 300_000,
                p99: 300_000,
                histogram: metric.histogram.map((_, index) =>
                  index === metric.histogram.length - 1 ? metric.count : 0,
                ),
              },
            },
          },
        };
      }),
    }));
    const saturated = buildMatrixRawSampleRollups(cells, saturatedRuns);
    expect(saturated.proxyDelayByScenario[0]?.metrics['upstream.actualResidenceUs'].p99).toBeNull();
    expect(saturated.proxyDelayByScenario[0]?.metrics['upstream.actualResidenceUs'].worst).toBe(
      300_000,
    );
    expect(
      validateMatrixHeadlineEvidence(cells, saturated).some((error) =>
        error.includes('upstream.actualResidenceUs: requires 100'),
      ),
    ).toBe(true);

    for (const defect of ['missing', 'duplicate', 'wrong-file', 'wrong-purpose'] as const) {
      const runs = makeRuns(100);
      const summaries = runs[0]?.latencySummaries;
      const selected = summaries?.[1];
      if (summaries === undefined || selected === undefined) throw new Error('missing fixture');
      if (defect === 'missing') summaries.splice(1, 1);
      if (defect === 'duplicate') summaries.push(selected);
      if (defect === 'wrong-file') selected.testFile = 'unrelated.e2e.ts';
      if (defect === 'wrong-purpose') selected.measurementPurpose = 'isolated-interactive';
      expect(buildMatrixRawSampleRollups(cells, runs).coherentRedrawByProfile[0]?.complete).toBe(
        false,
      );
    }
    expect(validateMatrixHeadlineEvidence(cells.slice(0, 1), enough)).toContain(
      'fast: requires two independent clean steady seeds',
    );
    const missingTrace = makeRuns(100);
    const first = missingTrace[0]?.latencySummaries[0];
    if (first === undefined) throw new Error('missing test population');
    first.rawEvents.complete = false;
    expect(
      validateMatrixHeadlineEvidence(cells, buildMatrixRawSampleRollups(cells, missingTrace)),
    ).toContain('fast/isolated-typing: missing complete replay-verified population');
  });

  test('rolls up replayed raw samples with exact weighting and scenario isolation', () => {
    const cells = buildNetworkMatrixCells(['fast'], [0], [11, 12], false, false);
    const runs = cells.map((cell, index) => ({
      id: matrixCellId(cell),
      cell,
      exitCode: 0,
      daemonTransport: { complete: true },
      latencyEvidenceErrors: [],
      latencySummaries: [
        {
          testFile: '/repo/tests/e2e/terminal-performance-matrix.e2e.ts',
          testTitle: 'interaction: isolated single-character feedback is independently fenced',
          measurementPurpose: 'isolated-interactive' as const,
          proxyImpairment: validateProxyArtifactEvidence(
            proxyImpairment({
              profile: 'fast',
              targetRttMs: 50,
              baseDelayUs: 12_500,
              jitterRadiusUs: 1_250,
              reorder: cell.reorder,
              seed: cell.seed,
            }),
            cell,
          ).stats,
          rawEvents: {
            complete: true,
            eventCount: 10 + index,
            metricSamples: rawMetricSamples({
              inputToAuthoritativeVisualFenceMs:
                cell.reorder === 'none' ? (cell.seed === 11 ? [1, 2, 3] : [4, 100]) : [500],
              touchToCommitMs:
                cell.seed === 11
                  ? Array.from({ length: 50 }, (_, sample) => sample + 1)
                  : Array.from({ length: 50 }, (_, sample) => sample + 51),
            }),
            metricComplete: rawMetricCompleteness(),
          },
        },
      ],
    }));
    const rollups = buildMatrixRawSampleRollups(cells, runs);
    expect(rollups.exactScenarios).toHaveLength(2);
    const none = rollups.exactScenarios.find((rollup) => rollup.scope.reorder === 'none');
    if (none === undefined) throw new Error('clean rollup is missing');
    expect(none?.complete).toBe(true);
    expect(none?.expectedRunCount).toBe(2);
    expect(none?.acceptedRunCount).toBe(2);
    expect(none?.metrics.inputToAuthoritativeVisualFenceMs).toEqual({
      count: 5,
      median: 3,
      p95: null,
      p99: null,
      worst: 100,
      complete: true,
    });
    expect(none?.metrics.touchToCommitMs).toEqual({
      count: 100,
      median: 50,
      p95: 95,
      p99: 99,
      worst: 100,
      complete: true,
    });
    expect(rollups.cleanWorkloadByProfile).toEqual([none]);
    const cleanProxy = rollups.proxyDelayByScenario.find(
      (rollup) => rollup.scope.reorder === 'none',
    );
    expect(cleanProxy?.complete).toBe(true);
    expect(cleanProxy?.metrics['upstream.actualResidenceUs'].count).toBe(400);
    expect(cleanProxy?.metrics['upstream.actualResidenceUs'].p99).not.toBeNull();
    const isolatedCharacter = rollups.cleanWorkloadByTest.find(
      (rollup) =>
        rollup.scope.profile === 'fast' &&
        rollup.scope.testTitle ===
          'interaction: isolated single-character feedback is independently fenced',
    );
    expect(isolatedCharacter?.complete).toBe(true);
    expect(isolatedCharacter?.metrics.inputToAuthoritativeVisualFenceMs).toEqual(
      none?.metrics.inputToAuthoritativeVisualFenceMs,
    );
    expect(
      rollups.cleanWorkloadByTest.find(
        (rollup) =>
          rollup.scope.profile === 'fast' &&
          rollup.scope.testTitle === 'burst output: dense row burst',
      )?.complete,
    ).toBe(false);

    const coherentRuns = runs.map((run) => ({
      ...run,
      latencySummaries: run.latencySummaries.map((summary) => ({
        ...summary,
        testTitle: 'burst output: dense row burst',
        measurementPurpose: 'coherent-redraw' as const,
        rawEvents: {
          ...summary.rawEvents,
          metricSamples: rawMetricSamples({
            'presentation.measurementWindowExposureMs': Array.from(
              { length: 50 },
              (_, sample) => (run.cell.seed === 11 ? 0 : 50) + sample + 1,
            ),
          }),
        },
      })),
    }));
    const coherent = buildMatrixRawSampleRollups(cells, coherentRuns).coherentRedrawByProfile.find(
      (rollup) => rollup.scope.profile === 'fast',
    );
    expect(coherent?.complete).toBe(false);
    expect(coherent?.metrics['presentation.measurementWindowExposureMs']).toEqual({
      count: 100,
      median: 50,
      p95: 95,
      p99: 99,
      worst: 100,
      complete: false,
    });

    const incomplete = buildMatrixRawSampleRollups(cells, runs.slice(0, -1));
    expect(incomplete.exactScenarios.some((rollup) => !rollup.complete)).toBe(true);
    expect(
      incomplete.exactScenarios.find((rollup) => rollup.scope.reorder === 'light')?.metrics
        .inputToAuthoritativeVisualFenceMs.complete,
    ).toBe(false);
  });

  test('matrix environment resolves to the exact downstream fault-site contract', () => {
    const [cell] = buildNetworkMatrixCells(['difficult'], [9], [17], false, false);
    if (cell === undefined) throw new Error('test matrix unexpectedly empty');
    const environment = matrixEnvironment(cell, '/tmp/result.json');
    expect(environment.EDGE_NETWORK_LOSS_PERCENT).toBeUndefined();
    expect(environment.EDGE_NETWORK_DATAGRAM_LOSS_PERCENT).toBe('9');
    expect(environment.DAEMON_LOG_FILE).toBe('/tmp/result.json.daemon.jsonl');
    expect(environment.MERKUR_E2E_FINAL_TRANSPORT_CAPTURE).toBe('1');
    const config = resolveEdgeNetworkConfig(environment);
    expect(config?.datagramLossPercent).toBe(9);
    expect(config?.profile.targetRttMs).toBe(200);
    expect(config?.profile.hopDelayUs).toBe(50_000);
  });

  test('requires exact read-only convergence ACK/final evidence and reports verifier repairs', () => {
    const cleanCell = {
      phase: 'workload',
      profile: 'typical',
      datagramLossPercent: 0,
      reorder: 'none',
      scenario: 'steady',
      seed: 7,
    } as const;
    expect(captureGridConvergenceEvidence(gridConvergenceEvidence(), cleanCell).errors).toEqual([]);
    expect(captureGridConvergenceEvidence(gridConvergenceEvidence(1), cleanCell).errors).toContain(
      'clean matrix cell required selective repair to establish grid convergence',
    );

    const impairedCell = {
      ...cleanCell,
      datagramLossPercent: 9,
      reorder: 'moderate',
      scenario: 'congestion',
    } as const;
    const impaired = captureGridConvergenceEvidence(gridConvergenceEvidence(2), impairedCell);
    expect(impaired.errors).toEqual([]);
    expect(impaired.evidence.selectiveRepairCount).toBe(2);

    const staleAck = gridConvergenceEvidence() as {
      complete: boolean;
      error: null;
      selectiveRepairCount: number;
      probes: Array<{ purpose: string; repair: boolean; result: Record<string, unknown> }>;
    };
    staleAck.probes[1] = {
      purpose: 'observation-ack',
      repair: false,
      result: gridConvergenceResult(7),
    };
    expect(captureGridConvergenceEvidence(staleAck, impairedCell).errors).toContain(
      'terminal grid-convergence observation ACK did not advance the reset epoch',
    );

    const mutatingFinal = gridConvergenceEvidence() as {
      complete: boolean;
      error: null;
      selectiveRepairCount: number;
      probes: Array<{ purpose: string; repair: boolean; result: Record<string, unknown> }>;
    };
    mutatingFinal.probes[2] = {
      purpose: 'final-verification',
      repair: false,
      result: gridConvergenceResult(8, 1),
    };
    expect(captureGridConvergenceEvidence(mutatingFinal, impairedCell).errors).toEqual([
      'terminal grid-convergence evidence is missing or malformed',
    ]);
  });

  test('emits median, p95, p99, and worst without relabeling incomplete data', () => {
    expect(
      extractPercentileMetrics({
        inputToAuthoritativeVisualFenceMs: {
          count: 192,
          p50: 50,
          p95: 75,
          p99: 90,
          max: 101,
          complete: true,
        },
        inputToCompletedAuthoritativePresentationFenceMs: {
          count: 1,
          eligibleCount: 1,
          censoredCount: 0,
          p50: 72,
          p95: 72,
          p99: 72,
          max: 72,
          complete: true,
        },
        unavailable: {
          count: 0,
          p50: null,
          p95: null,
          p99: null,
          max: null,
          complete: false,
        },
        presentation: {
          partialPresentationExposureMs: {
            count: 7,
            p50: 0,
            p95: 16,
            p99: 16,
            max: 17,
            complete: false,
          },
          malformed: { count: 1, p50: 1, p95: 2, max: 4 },
        },
        sampleCount: 192,
      }),
    ).toEqual({
      inputToAuthoritativeVisualFenceMs: {
        count: 192,
        median: 50,
        p95: 75,
        p99: 90,
        worst: 101,
        complete: true,
      },
      inputToCompletedAuthoritativePresentationFenceMs: {
        count: 1,
        eligibleCount: 1,
        censoredCount: 0,
        median: 72,
        p95: 72,
        p99: 72,
        worst: 72,
        complete: true,
      },
      'presentation.partialPresentationExposureMs': {
        count: 7,
        median: 0,
        p95: 16,
        p99: 16,
        worst: 17,
        complete: false,
      },
      unavailable: {
        count: 0,
        median: null,
        p95: null,
        p99: null,
        worst: null,
        complete: false,
      },
    });
  });

  test('requires complete application display evidence and exact recovery snapshot membership', () => {
    const outcome = {
      complete: true,
      receivedEventCount: 4,
      uniqueReceivedDatagramCount: 2,
      duplicateReceivedEventCount: 0,
      appliedEventCount: 3,
      uniqueAppliedDatagramCount: 2,
      receivedWithoutApplyCount: 0,
      appliedWithoutReceiveCount: 0,
      observedSequenceSlotCount: 2,
      interiorSequenceGapCount: 0,
      outOfOrderReceivedDatagramCount: 0,
      fecRecoveredReceivedDatagramCount: 0,
      fecRecoveredAppliedDatagramCount: 0,
      fecRecoveredVisualAppliedDatagramCount: 0,
      interiorSequenceGapPercent: 0,
      snapshotReceivedCount: 1,
      snapshotAppliedCount: 1,
      snapshotReceivedChunkCount: 2,
      snapshotAppliedChunkCount: 2,
      resyncRequestCount: 1,
      resyncAlreadyPendingCount: 0,
      repairTargetSatisfiedCommitCount: 0,
      repairDeadlineExpiredCommitCount: 0,
    };
    expect(validateApplicationDisplayOutcomeEvidence(outcome, true, false, false)).toEqual([]);
    expect(validateApplicationDisplayOutcomeEvidence(outcome, false, true, true)).toEqual([]);
    for (const key of [
      'repairTargetSatisfiedCommitCount',
      'repairDeadlineExpiredCommitCount',
      'fecRecoveredReceivedDatagramCount',
      'fecRecoveredAppliedDatagramCount',
      'fecRecoveredVisualAppliedDatagramCount',
      'interiorSequenceGapCount',
    ] as const) {
      expect(
        validateApplicationDisplayOutcomeEvidence({ ...outcome, [key]: 1 }, false, true, true),
      ).toContain(`clean workload application display ${key} must be zero`);
    }
    expect(
      validateApplicationDisplayOutcomeEvidence(
        { ...outcome, complete: false, snapshotAppliedChunkCount: 1 },
        true,
        false,
        false,
      ),
    ).toEqual([
      'application display outcome is incomplete',
      'recovery snapshot chunk receipt/apply counts differ',
    ]);
    expect(
      validateApplicationDisplayOutcomeEvidence(
        { ...outcome, receivedWithoutApplyCount: 1 },
        false,
        true,
        false,
      ),
    ).toContain('ordinary workload received a display transformation that was never applied');
  });

  test('accepts only one ordinary coherent commit plus at most one exact repair commit', () => {
    const cell = {
      phase: 'workload',
      profile: 'difficult',
      datagramLossPercent: 9,
      reorder: 'moderate',
      scenario: 'steady',
      seed: 7,
    } as const;
    const metric = (worst: number, count = 3) => ({
      count,
      median: worst,
      p95: worst,
      p99: worst,
      worst,
      complete: true,
    });
    const base = {
      'presentation.commitsPerPresentation': metric(1, 6),
      'presentation.partialPresentationExposureMs': metric(0, 6),
      'presentation.commitsPerMeasurementWindow': metric(1),
      'presentation.ordinaryCommitsPerMeasurementWindow': metric(1),
      'presentation.repairCommitsPerMeasurementWindow': metric(0),
      'presentation.expiredRepairCommitsPerMeasurementWindow': metric(0),
      'presentation.ordinaryMeasurementWindowExposureMs': metric(0),
      'presentation.measurementWindowExposureMs': metric(0),
    };
    const outcome = { repairDeadlineExpiredCommitCount: 0 };
    const coherentPresentation = {
      measurementWindowCountByPurpose: {
        'coherent-redraw': 3,
        'isolated-interactive': 0,
        streaming: 0,
      },
    };
    expect(
      validateWorkloadPresentationEvidence(cell, 3, coherentPresentation, base, outcome),
    ).toEqual([]);
    const cleanCell = { ...cell, datagramLossPercent: 0, reorder: 'none' } as const;
    expect(
      validateWorkloadPresentationEvidence(
        cleanCell,
        3,
        coherentPresentation,
        {
          ...base,
          'presentation.repairCommitsPerMeasurementWindow': metric(1),
        },
        outcome,
      ),
    ).toContain('clean workload presentation was assisted by repair');
    expect(
      validateWorkloadPresentationEvidence(
        cell,
        3,
        coherentPresentation,
        {
          ...base,
          'presentation.commitsPerPresentation': metric(2, 6),
          'presentation.partialPresentationExposureMs': metric(180, 6),
          'presentation.commitsPerMeasurementWindow': metric(2),
          'presentation.repairCommitsPerMeasurementWindow': metric(1),
          'presentation.measurementWindowExposureMs': metric(180),
        },
        outcome,
      ),
    ).toEqual([]);

    const errors = validateWorkloadPresentationEvidence(
      cell,
      3,
      coherentPresentation,
      {
        ...base,
        'presentation.commitsPerPresentation': metric(2, 6),
        'presentation.ordinaryCommitsPerMeasurementWindow': metric(2),
        'presentation.expiredRepairCommitsPerMeasurementWindow': metric(1),
        'presentation.ordinaryMeasurementWindowExposureMs': metric(16),
      },
      { repairDeadlineExpiredCommitCount: 1 },
    );
    expect(errors).toContain('a logical redraw used more than one ordinary presentation commit');
    expect(errors).toContain('ordinary logical-redraw commits exposed a visible row sweep');
    expect(errors).toContain('a repair presentation escaped through its deadline');
    expect(errors).toContain('application display telemetry recorded an expired repair hold');

    const streaming = {
      ...base,
      'presentation.commitsPerMeasurementWindow': metric(100),
      'presentation.ordinaryCommitsPerMeasurementWindow': metric(100),
      'presentation.ordinaryMeasurementWindowExposureMs': metric(250),
      'presentation.measurementWindowExposureMs': metric(250),
    };
    expect(
      validateWorkloadPresentationEvidence(
        cell,
        3,
        {
          measurementWindowCountByPurpose: {
            'coherent-redraw': 0,
            'isolated-interactive': 0,
            streaming: 3,
          },
        },
        streaming,
        outcome,
      ),
    ).toEqual([]);
  });

  test('requires configured proxy faults to reach application display evidence', () => {
    const cell = {
      phase: 'workload',
      profile: 'typical',
      datagramLossPercent: 3,
      reorder: 'moderate',
      scenario: 'steady',
      seed: 7,
    } as const;
    const daemon = analyzeDaemonTransportLogLines(
      [
        daemonCaptureLine({
          captureRequestedAtMs: 97_000,
          captureCompletedAtMs: 99_500,
          healthCheckedAtMs: 99_000,
          observedAtMs: 98_000,
          sampleCount: 1,
          aggregate: transportStats({
            webtransport: pathStats({ displayDatagramsDeclaredLost: 1 }),
            rowsDeclaredLost: 1,
          }),
        }),
      ],
      100_000,
    );
    const outcome = {
      interiorSequenceGapCount: 0,
      outOfOrderReceivedDatagramCount: 0,
      repairTargetSatisfiedCommitCount: 0,
      fecRecoveredVisualAppliedDatagramCount: 0,
    };
    const observedFaults = {
      exactLossObserved: true,
      exactLossSelectorWindowVerified: true,
      reorderObserved: true,
      burstLossObserved: false,
      congestionObserved: false,
    };
    expect(
      validateCellDisplayFaultEvidence(
        cell,
        [{ applicationDisplayOutcome: outcome, proxyFaultEvidence: observedFaults }],
        daemon,
      ),
    ).toEqual([
      'no single reset epoch contains both configured packet loss and an observed display gap, visual FEC recovery, or exact row repair',
      'no single reset epoch contains both configured packet reordering and an out-of-order application display datagram',
    ]);

    // Fault counters in one reset epoch and display consequences in another
    // must not be unioned into fabricated causality.
    expect(
      validateCellDisplayFaultEvidence(
        cell,
        [
          { applicationDisplayOutcome: outcome, proxyFaultEvidence: observedFaults },
          {
            applicationDisplayOutcome: {
              ...outcome,
              interiorSequenceGapCount: 1,
              outOfOrderReceivedDatagramCount: 1,
            },
            proxyFaultEvidence: {
              exactLossObserved: false,
              exactLossSelectorWindowVerified: false,
              reorderObserved: false,
              burstLossObserved: false,
              congestionObserved: false,
            },
          },
        ],
        daemon,
      ),
    ).toHaveLength(2);
    expect(
      validateCellDisplayFaultEvidence(
        cell,
        [
          {
            applicationDisplayOutcome: {
              ...outcome,
              fecRecoveredVisualAppliedDatagramCount: 1,
              outOfOrderReceivedDatagramCount: 1,
            },
            proxyFaultEvidence: observedFaults,
          },
        ],
        daemon,
      ),
    ).toEqual([]);
  });

  test('retains non-window diagnostics without poisoning valid workload evidence', () => {
    expect(
      validateLatencySummaryEvidence('workload', [
        { testTitle: 'cursor diagnostic', measurementWindowCount: 0, complete: false },
        { testTitle: 'bounded redraw window', measurementWindowCount: 1, complete: true },
      ]),
    ).toEqual([]);
  });

  test('rejects a workload cell with no explicit measurement window', () => {
    expect(
      validateLatencySummaryEvidence('workload', [
        { testTitle: 'cursor diagnostic', measurementWindowCount: 0, complete: true },
      ]),
    ).toEqual(['workload cell produced no explicit logical-workload measurement window']);
  });

  test('rejects incomplete promised windows and keeps recovery summaries strict', () => {
    const incomplete = {
      testTitle: 'bounded redraw window',
      measurementWindowCount: 1,
      complete: false,
    };
    expect(validateLatencySummaryEvidence('workload', [incomplete])).toEqual([
      'logical-workload summary is incomplete: bounded redraw window',
    ]);
    expect(validateLatencySummaryEvidence('recovery', [incomplete])).toEqual([
      'recovery summary is incomplete: bounded redraw window',
    ]);
  });

  test('requires a bounded multi-datagram single-fence carrier repair window', () => {
    const cell = {
      phase: 'recovery',
      profile: 'typical',
      datagramLossPercent: 9,
      reorder: 'moderate',
      scenario: 'congestion',
      seed: 7,
    } as const;
    const metric = (value: number) => ({
      count: 1,
      median: value,
      p95: value,
      p99: value,
      worst: value,
      complete: true,
    });
    const metrics = {
      'presentation.commitsPerMeasurementWindow': metric(1),
      'presentation.rowsPerMeasurementWindow': metric(24),
      'presentation.datagramsPerMeasurementWindow': metric(4),
      'presentation.bytesPerMeasurementWindow': metric(2_400),
      'presentation.measurementWindowExposureMs': metric(0),
      'presentation.firstDisplayReceiveToCompletedPresentationFenceMs': metric(95),
      'presentation.refreshPeriodPerMeasurementWindowMs': metric(8.33),
      'presentation.fenceObservationIntervalPerMeasurementWindowMs': metric(2),
    };
    const file = '/repo/tests/e2e/carrier-rebind.e2e.ts';
    const title = 'a rebound carrier keeps its display generation and is repaired, not repainted';

    expect(validateCarrierRepairPresentationEvidence(cell, file, title, 1, metrics)).toEqual([]);
    expect(validateCarrierRepairPresentationEvidence(cell, file, title, 0, metrics)).toContain(
      'carrier-repair sentinel must contain exactly one presentation measurement window',
    );
    expect(
      validateCarrierRepairPresentationEvidence(cell, file, title, 1, {
        ...metrics,
        'presentation.commitsPerMeasurementWindow': metric(2),
        'presentation.datagramsPerMeasurementWindow': metric(1),
        'presentation.measurementWindowExposureMs': metric(16),
        'presentation.firstDisplayReceiveToCompletedPresentationFenceMs': metric(1_000),
      }),
    ).toEqual([
      'carrier-repair window was not presented in exactly one GPU-fenced commit',
      'carrier-repair window did not span multiple independent display units',
      'carrier-repair window exposed more than one visible GPU-fenced sub-update',
      expect.stringMatching(/carrier-repair first-receipt-to-GPU-fence 1000ms exceeded/),
    ]);
    expect(
      validateCarrierRepairPresentationEvidence(cell, file, title, 1, {
        ...metrics,
        'presentation.bytesPerMeasurementWindow': { ...metric(2_400), complete: false },
      }),
    ).toEqual(['presentation.bytesPerMeasurementWindow recovery evidence is incomplete']);
  });

  test('requires a bounded single-fence forced-resync snapshot window', () => {
    const cell = {
      phase: 'recovery',
      profile: 'difficult',
      datagramLossPercent: 9,
      reorder: 'moderate',
      scenario: 'congestion',
      seed: 7,
    } as const;
    const metric = (value: number) => ({
      count: 1,
      median: value,
      p95: value,
      p99: value,
      worst: value,
      complete: true,
    });
    const metrics = {
      'presentation.commitsPerMeasurementWindow': metric(1),
      'presentation.rowsPerMeasurementWindow': metric(24),
      'presentation.datagramsPerMeasurementWindow': metric(1),
      'presentation.bytesPerMeasurementWindow': metric(2_400),
      'presentation.measurementWindowExposureMs': metric(0),
      'presentation.measurementWindowToCompletedAuthoritativePresentationFenceMs': metric(520),
      'presentation.firstDisplayReceiveToCompletedPresentationFenceMs': metric(35),
      'presentation.refreshPeriodPerMeasurementWindowMs': metric(8.33),
      'presentation.fenceObservationIntervalPerMeasurementWindowMs': metric(2),
    };
    const file = '/repo/tests/e2e/display-resync-recovery.e2e.ts';
    const title =
      'a forced profiling resync completes through an authoritative GPU-fenced snapshot';
    expect(validateForcedResyncPresentationEvidence(cell, file, title, 1, metrics)).toEqual([]);
    expect(
      validateForcedResyncPresentationEvidence(cell, file, title, 1, {
        ...metrics,
        'presentation.commitsPerMeasurementWindow': metric(2),
        'presentation.measurementWindowExposureMs': metric(16),
        'presentation.measurementWindowToCompletedAuthoritativePresentationFenceMs': metric(2_000),
      }),
    ).toEqual([
      'forced-resync snapshot was not presented in exactly one GPU-fenced commit',
      'forced-resync snapshot exposed more than one visible GPU-fenced sub-update',
      expect.stringMatching(/forced-resync request-to-GPU-fence 2000ms exceeded/),
    ]);
  });

  test('fails closed on main-thread cadence and browser display I/O evidence', () => {
    const cleanCell = {
      phase: 'workload',
      profile: 'typical',
      datagramLossPercent: 0,
      reorder: 'none',
      scenario: 'steady',
      seed: 7,
    } as const;
    const metric = (value: number | null, count = 1, complete = true) => ({
      count,
      median: value,
      p95: value,
      p99: value,
      worst: value,
      complete,
    });
    const metrics = {
      'displayPipeline.pumpDurationMs': metric(0.25, 2),
      'displayPipeline.encodedDeferralQueueHighWaterPerPump': metric(0, 2),
      'displayPipeline.ringBytesAtPumpStart': metric(0, 2),
      'displayPipeline.ringBytesAtPumpEnd': metric(0, 2),
      'displayPipeline.ringRefusedFrameCountPerMeasurementWindow': metric(0),
      'displayPipeline.ringRefusedFrameCountBetweenMeasurementWindows': metric(null, 0),
      'mainThread.rafGapMs': metric(8.3, 3),
      'mainThread.frameBudgetOverrunMs': metric(0, 3),
      'mainThread.estimatedMissedFramesPerGap': metric(0, 3),
      'mainThread.estimatedMissedFramesPerMeasurementWindow': metric(0),
      'mainThread.longTaskDurationMs': metric(null, 0),
      'browserDisplayIo.endToEndExplicitCopiesPerUpdate': metric(2, 4),
      'browserDisplayIo.endToEndExplicitCopiedBytesPerPayloadByte': metric(2, 4),
      'browserDisplayIo.endToEndExplicitAllocationRequestsPerUpdate': metric(1, 4),
      'browserDisplayIo.endToEndExplicitAllocationRequestedBytesPerUpdate': metric(600, 4),
      'browserDisplayIo.endToEndExplicitAllocationRequestedBytesPerPayloadByte': metric(1, 4),
      'browserDisplayIo.endToEndExplicitObjectAllocationRequestsPerUpdate': metric(2, 4),
    };
    const report = {
      displayPipeline: {
        encodedDeferralQueueRemainingPerPump: metric(0, 2),
        ringRefusalAccountingComplete: true,
        ringRefusedFrameCount: 0,
      },
      mainThread: {
        complete: true,
        measurementWindowCount: 1,
        sampledMeasurementWindowCount: 1,
        intervalCount: 3,
        estimatedMissedFrameCount: 0,
        frameBudgetExceededIntervalCount: 0,
        longTaskObserverSupported: true,
        longTaskCount: 0,
        longTaskTotalMs: 0,
      },
      browserDisplayIo: {
        scope: BROWSER_DISPLAY_IO_SCOPE,
        complete: true,
        transportIngressUpdateCount: 4,
        rejectedTransportIngressUpdateCount: 0,
        terminalApplyUpdateCount: 4,
        endToEndMatchedUpdateCount: 4,
        fecRecoveredTerminalApplyUpdateCount: 0,
        endToEndCoverageRatio: 1,
        endToEndMatchedPayloadByteCount: 2_400,
        payloadByteCount: 4_800,
        explicitCopyCount: 8,
        explicitCopiedByteCount: 4_800,
        explicitAllocationRequestCount: 4,
        explicitAllocationRequestedByteCount: 2_400,
        explicitObjectAllocationRequestCount: 8,
      },
    };

    expect(validateBrowserRuntimeEvidence(cleanCell, 1, report, metrics)).toEqual([]);
    const invalid = validateBrowserRuntimeEvidence(
      cleanCell,
      1,
      {
        mainThread: {
          ...report.mainThread,
          complete: false,
          sampledMeasurementWindowCount: 0,
          estimatedMissedFrameCount: 1,
          frameBudgetExceededIntervalCount: 1,
          longTaskCount: 1,
          longTaskTotalMs: 51,
        },
        browserDisplayIo: {
          ...report.browserDisplayIo,
          complete: false,
          terminalApplyUpdateCount: 4,
          endToEndMatchedUpdateCount: 3,
          endToEndCoverageRatio: 0.75,
        },
      },
      metrics,
    );
    expect(invalid).toContain('browser display I/O evidence is incomplete');
    expect(invalid).toContain('main-thread frame evidence is incomplete');
    expect(invalid).toContain('main-thread cadence did not fully sample every presentation window');
    expect(invalid).toContain('main thread missed an estimated browser refresh opportunity');
    expect(invalid).toContain('main thread recorded a long task inside a presentation window');
    expect(invalid).toContain('mainThread.longTaskDurationMs evidence is incomplete');
    expect(invalid).toContain('browser display I/O end-to-end coverage ratio is invalid');
    expect(invalid).toContain(
      'browserDisplayIo.endToEndExplicitCopiesPerUpdate evidence is incomplete',
    );

    const lossyCell = { ...cleanCell, datagramLossPercent: 9 } as const;
    const lossyReport = {
      ...report,
      browserDisplayIo: {
        ...report.browserDisplayIo,
        terminalApplyUpdateCount: 4,
        endToEndMatchedUpdateCount: 3,
        fecRecoveredTerminalApplyUpdateCount: 1,
        endToEndCoverageRatio: 1,
      },
    };
    const lossyMetrics = Object.fromEntries(
      Object.entries(metrics).map(([name, value]) => [
        name,
        name.startsWith('browserDisplayIo.') ? { ...value, count: 3 } : value,
      ]),
    );
    expect(validateBrowserRuntimeEvidence(lossyCell, 1, lossyReport, lossyMetrics)).toEqual([]);

    const refusedLossyReport = {
      ...lossyReport,
      displayPipeline: {
        ...report.displayPipeline,
        ringRefusedFrameCount: 1,
      },
      mainThread: {
        ...report.mainThread,
        measurementWindowCount: 2,
        sampledMeasurementWindowCount: 2,
      },
    };
    const refusedLossyMetrics = {
      ...lossyMetrics,
      'displayPipeline.ringRefusedFrameCountPerMeasurementWindow': metric(0, 2),
      'displayPipeline.ringRefusedFrameCountBetweenMeasurementWindows': metric(1),
      'mainThread.estimatedMissedFramesPerMeasurementWindow': metric(0, 2),
    };
    expect(
      validateBrowserRuntimeEvidence(lossyCell, 2, refusedLossyReport, refusedLossyMetrics),
    ).toContain('browser display ingress refused a frame-ring write in typical/steady');
  });

  test('requires each expected test exactly once as an ordinary passing artifact', () => {
    const expected = [{ file: 'required.e2e.ts', title: 'required sentinel' }];
    const valid = {
      artifact: 'artifact.json',
      testFile: '/repo/tests/e2e/required.e2e.ts',
      testTitle: 'required sentinel',
      testStatus: 'passed',
      testExpectedStatus: 'passed',
      measurementWindowCount: 0,
      complete: true,
    };
    expect(validateExpectedTestEvidence([valid], expected)).toEqual([]);
    expect(validateExpectedTestEvidence([], expected)).toEqual([
      'expected exactly one required.e2e.ts :: required sentinel result, observed 0',
    ]);
    expect(validateExpectedTestEvidence([valid, valid], expected)).toEqual([
      'expected exactly one required.e2e.ts :: required sentinel result, observed 2',
    ]);
    expect(validateExpectedTestEvidence([{ ...valid, testStatus: 'skipped' }], expected)).toEqual([
      'required test did not produce a passing artifact: required sentinel',
    ]);
    expect(validateExpectedTestEvidence([{ ...valid, complete: false }], expected)).toEqual([
      'required test did not produce a passing artifact: required sentinel',
    ]);
  });

  test('validates exact per-reset proxy config and unions positively observed faults', () => {
    const cell = {
      phase: 'workload',
      profile: 'typical',
      datagramLossPercent: 3,
      reorder: 'moderate',
      scenario: 'congestion',
      seed: 7,
    } as const;
    const first = validateProxyArtifactEvidence(
      proxyImpairment({
        datagramLossPercent: 3,
        exactLossDropped: 6,
        reorder: 'moderate',
        reordered: 0,
        scenario: 'congestion',
        congested: 0,
      }),
      cell,
    );
    const second = validateProxyArtifactEvidence(
      proxyImpairment({
        datagramLossPercent: 3,
        exactLossDropped: 6,
        reorder: 'moderate',
        reordered: 3,
        scenario: 'congestion',
        congested: 12,
      }),
      cell,
    );
    expect(first.errors).toEqual([]);
    expect(second.errors).toEqual([]);
    const congestionOnlyOnDroppedPackets = validateProxyArtifactEvidence(
      proxyImpairment({
        datagramLossPercent: 3,
        exactLossDropped: 6,
        reorder: 'moderate',
        scenario: 'congestion',
        congested: 12,
        congestedForwarded: 0,
      }),
      cell,
    );
    expect(congestionOnlyOnDroppedPackets.errors).toEqual([]);
    expect(congestionOnlyOnDroppedPackets.evidence.congestionObserved).toBe(false);
    expect(
      validateCellProxyFaultEvidence(cell, [
        { proxyFaultEvidence: first.evidence },
        { proxyFaultEvidence: second.evidence },
      ]),
    ).toEqual([]);
    expect(validateCellProxyFaultEvidence(cell, [{ proxyFaultEvidence: first.evidence }])).toEqual([
      'cell never exercised configured downstream reordering after a trace reset',
      'cell never exercised configured bounded downstream congestion after a trace reset',
    ]);

    const incompleteSelectorWindow = validateProxyArtifactEvidence(
      proxyImpairment({
        datagramLossPercent: 3,
        seen: 50,
        exactLossDropped: 1,
        reorder: 'moderate',
        scenario: 'congestion',
      }),
      cell,
    );
    expect(incompleteSelectorWindow.errors).toEqual([]);
    expect(incompleteSelectorWindow.evidence.exactLossSelectorWindowVerified).toBe(false);
    expect(
      validateCellProxyFaultEvidence(cell, [
        { proxyFaultEvidence: incompleteSelectorWindow.evidence },
      ]),
    ).toContain('cell never verified a complete deterministic exact-loss selector window');

    expect(
      validateProxyArtifactEvidence(
        proxyImpairment({
          datagramLossPercent: 3,
          exactLossDropped: 5,
          reorder: 'moderate',
          scenario: 'congestion',
        }),
        cell,
      ).errors,
    ).toContain('downstream exact-loss count is impossible for its selector windows');

    expect(
      validateProxyArtifactEvidence(
        proxyImpairment({
          datagramLossPercent: 3,
          exactLossDropped: 6,
          achievedPacketLossPercent: 99,
          reorder: 'moderate',
          scenario: 'congestion',
        }),
        cell,
      ).errors,
    ).toEqual(['proxy impairment snapshot is missing or malformed']);

    expect(
      validateProxyArtifactEvidence(
        proxyImpairment({
          datagramLossPercent: 3,
          exactLossDropped: 6,
          logicalObservedFaultSitePackets: 201,
          logicalDroppedAtFaultSite: 7,
          reorder: 'moderate',
          scenario: 'congestion',
        }),
        cell,
      ).errors,
    ).toEqual(['proxy impairment snapshot is missing or malformed']);

    expect(
      validateProxyArtifactEvidence(
        proxyImpairment({
          datagramLossPercent: 3,
          exactLossDropped: 6,
          reorder: 'moderate',
          reordered: 3,
          scenario: 'congestion',
          congested: 12,
          pendingScheduledPackets: 1,
          leaseExhaustedDrops: 1,
        }),
        cell,
      ).errors,
    ).toEqual([
      'proxy dropped packets outside the configured impairment',
      'proxy still owns scheduled packets at artifact closure',
    ]);

    expect(
      validateProxyArtifactEvidence(
        proxyImpairment({
          datagramLossPercent: 3,
          exactLossDropped: 6,
          reorder: 'moderate',
          reordered: 3,
          scenario: 'congestion',
          congested: 12,
          releasedSampleCount: 193,
        }),
        cell,
      ).errors,
    ).toContain('upstream actual release sample count does not match released UDP units');

    expect(
      validateProxyArtifactEvidence(
        proxyImpairment({
          datagramLossPercent: 3,
          exactLossDropped: 6,
          reorder: 'moderate',
          reordered: 3,
          scenario: 'congestion',
          congested: 12,
          releaseOvershootUs: 100_000,
        }),
        cell,
      ).errors,
    ).toContain('upstream userspace release scheduler exceeded its bounded overshoot budget');

    expect(
      validateProxyArtifactEvidence(
        proxyImpairment({
          datagramLossPercent: 3,
          exactLossDropped: 6,
          reorder: 'moderate',
          reordered: 3,
          scenario: 'congestion',
          congested: 12,
          releaseEarlyCount: 1,
        }),
        cell,
      ).errors,
    ).toContain('upstream proxy released a UDP unit before its target deadline');
  });

  test('edge Playwright config includes the forced production resync sentinel', async () => {
    const config = await readFile(
      path.join(import.meta.dir, '..', 'playwright.edge.config.mjs'),
      'utf8',
    );
    expect(config).toContain('**/display-resync-recovery.e2e.ts');
  });

  test('atomically replaces a checkpoint without leaving same-directory temporaries', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'merkur-network-matrix-'));
    const filename = path.join(directory, 'matrix.json');
    try {
      await writeMatrixArtifact(filename, { revision: 1 });
      await writeMatrixArtifact(filename, { revision: 2 });
      expect(JSON.parse(await readFile(filename, 'utf8'))).toEqual({ revision: 2 });
      expect((await readdir(directory)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('accepts only fresh fixed-shape final daemon transport captures', () => {
    const result = analyzeDaemonTransportLogLines(
      [
        'non-json child progress is ignored',
        JSON.stringify({
          message: 'daemon_health_snapshot',
          context: { daemonId: 'daemon-1' },
        }),
        daemonCaptureLine({
          captureRequestedAtMs: 90_000,
          captureCompletedAtMs: 92_500,
          healthCheckedAtMs: 92_000,
          observedAtMs: 91_000,
          sampleCount: 1,
          latest: transportStats({ windowMs: 1_000 }),
          aggregate: transportStats({ windowMs: 1_000 }),
        }),
        daemonCaptureLine({
          captureRequestedAtMs: 97_000,
          captureCompletedAtMs: 99_500,
          healthCheckedAtMs: 99_000,
          observedAtMs: 98_000,
          sampleCount: 2,
          latest: transportStats({ windowMs: 8_000 }),
          aggregate: transportStats({ windowMs: 20_000, rowVersionsSent: 16 }),
        }),
      ],
      100_000,
    );

    expect(result.complete).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.captureCount).toBe(2);
    expect(result.daemonCount).toBe(1);
    expect(result.freshAtRunEnd).toBe(true);
    expect(result.latestByDaemon[0]?.sampleCount).toBe(2);
    expect(result.latestByDaemon[0]?.sampleToRunEndMs).toBe(2_000);
    expect(result.latestByDaemon[0]?.captureCompletionToRunEndMs).toBe(500);
    expect(result.latestByDaemon[0]?.aggregate.windowMs).toBe(20_000);
  });

  test('requires daemon heartbeat RTT to corroborate the four-leg matrix profile', () => {
    const cell = {
      phase: 'workload',
      profile: 'typical',
      datagramLossPercent: 0,
      reorder: 'none',
      scenario: 'steady',
      seed: 7,
    } as const;
    const typicalPath = pathStats({
      rttEwmaUsMax: 125_000,
      networkRttEwmaUsMax: 120_000,
      quicRttUsMax: 60_000,
    });
    const evidence = analyzeDaemonTransportLogLines(
      [
        daemonCaptureLine({
          captureRequestedAtMs: 97_000,
          captureCompletedAtMs: 99_500,
          healthCheckedAtMs: 99_000,
          observedAtMs: 98_000,
          sampleCount: 1,
          latest: transportStats({ webtransport: typicalPath, edge: typicalPath }),
          aggregate: transportStats({ webtransport: typicalPath, edge: typicalPath }),
        }),
      ],
      100_000,
    );
    expect(validateDaemonNetworkProfileEvidence(cell, evidence)).toEqual([]);

    const bypassedPath = pathStats({
      rttEwmaUsMax: 10_000,
      networkRttEwmaUsMax: 10_000,
      quicRttUsMax: 5_000,
    });
    const bypassed = analyzeDaemonTransportLogLines(
      [
        daemonCaptureLine({
          captureRequestedAtMs: 97_000,
          captureCompletedAtMs: 99_500,
          healthCheckedAtMs: 99_000,
          observedAtMs: 98_000,
          sampleCount: 1,
          latest: transportStats({ webtransport: bypassedPath, edge: bypassedPath }),
          aggregate: transportStats({ webtransport: bypassedPath, edge: bypassedPath }),
        }),
      ],
      100_000,
    );
    expect(
      validateDaemonNetworkProfileEvidence(cell, bypassed).every((error) =>
        error.includes('outside the typical profile range'),
      ),
    ).toBe(true);
    expect(validateDaemonNetworkProfileEvidence(cell, bypassed).length).toBe(4);
  });

  test('rejects missing, stale, dropped, and inconsistent daemon transport samples', () => {
    const missingPathField = Object.fromEntries(
      Object.entries(pathStats()).filter(([name]) => name !== 'quicLostBytes'),
    );
    const malformed = analyzeDaemonTransportLogLines(
      [
        daemonCaptureLine({
          captureRequestedAtMs: 97_000,
          captureCompletedAtMs: 99_500,
          healthCheckedAtMs: 99_000,
          observedAtMs: 98_000,
          sampleCount: 1,
          latest: transportStats({ edge: missingPathField }),
        }),
      ],
      100_000,
    );
    expect(malformed.complete).toBe(false);
    expect(malformed.errors).toContain('line 1: daemon transport sample shape is invalid');

    const stale = analyzeDaemonTransportLogLines(
      [
        daemonCaptureLine({
          captureRequestedAtMs: 90_000,
          captureCompletedAtMs: 96_000,
          healthCheckedAtMs: 95_500,
          observedAtMs: 89_000,
          sampleCount: 1,
        }),
      ],
      140_000,
    );
    expect(stale.complete).toBe(false);
    expect(stale.errors.some((error) => error.includes('does not bracket'))).toBe(true);
    expect(stale.errors.some((error) => error.includes('within 10000ms of run end'))).toBe(true);

    const incomplete = analyzeDaemonTransportLogLines(
      [
        daemonCaptureLine({
          captureRequestedAtMs: 97_000,
          captureCompletedAtMs: 99_500,
          healthCheckedAtMs: 99_000,
          observedAtMs: 98_000,
          sampleCount: 2,
          latest: transportStats({ windowMs: 0, statsEventsDropped: 1 }),
          aggregate: transportStats({ windowMs: 10_000, statsEventsDropped: 1 }),
        }),
      ],
      100_000,
    );
    expect(incomplete.complete).toBe(false);
    expect(incomplete.errors).toContain(
      'line 1: daemon transport partial-window coverage is inconsistent',
    );
    expect(incomplete.errors).toContain('line 1: dataplane transport telemetry reported drops');

    const unsafeQueues = analyzeDaemonTransportLogLines(
      [
        daemonCaptureLine({
          captureRequestedAtMs: 97_000,
          captureCompletedAtMs: 99_500,
          healthCheckedAtMs: 99_000,
          observedAtMs: 98_000,
          sampleCount: 1,
          latest: transportStats({
            datagramSendFailures: 1,
            unackedDatagramsMax: 1_025,
            edgeReliableQueuedBytesMax: 4 * 1_024 * 1_024 + 1,
          }),
        }),
      ],
      100_000,
    );
    expect(unsafeQueues.complete).toBe(false);
    expect(unsafeQueues.errors).toContain(
      'line 1: latest transport sample reported Merkur-owned send/admission/queue drops',
    );
    expect(unsafeQueues.errors).toContain(
      'line 1: latest application display tracking exceeded 1024 datagrams',
    );
    expect(unsafeQueues.errors).toContain(
      'line 1: latest edge reliable admission backlog exceeded 4194304 bytes',
    );

    const missing = analyzeDaemonTransportLogLines([], 100_000);
    expect(missing.complete).toBe(false);
    expect(missing.captureCount).toBe(0);
    expect(missing.errors).toContain('no complete final dataplane transport capture was observed');

    const periodicOnly = analyzeDaemonTransportLogLines(
      [JSON.stringify({ message: 'daemon_health_snapshot', context: {} })],
      100_000,
    );
    expect(periodicOnly.complete).toBe(false);
    expect(periodicOnly.captureCount).toBe(0);

    const capturedAfterPeerRemoval = analyzeDaemonTransportLogLines(
      [
        daemonCaptureLine({
          captureRequestedAtMs: 97_000,
          captureCompletedAtMs: 99_500,
          healthCheckedAtMs: 99_000,
          observedAtMs: 98_000,
          sampleCount: 2,
          latest: transportStats({ windowMs: 1_000, peers: 0 }),
          aggregate: transportStats({ windowMs: 11_000, rowVersionsSent: 40 }),
        }),
      ],
      100_000,
    );
    expect(capturedAfterPeerRemoval.complete).toBe(false);
    expect(capturedAfterPeerRemoval.errors).toContain(
      'line 1: final daemon transport capture had no live browser peer',
    );
  });

  test('resumes only exact completed cell keys from an identical matrix plan', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'merkur-network-matrix-'));
    const filename = path.join(directory, 'matrix.json');
    const cell = buildNetworkMatrixCells(['fast'], [0], [7], false, true).find(
      (candidate) =>
        candidate.phase === 'recovery' &&
        candidate.datagramLossPercent === 0 &&
        candidate.reorder === 'none' &&
        candidate.scenario === 'steady',
    );
    if (cell === undefined) throw new Error('test matrix unexpectedly empty');
    const id = matrixCellId(cell);
    const playwrightArgs = ['terminal.e2e.ts', '--workers=1'];
    const sourceFingerprint = 'sha256:exact-test-source';
    const events: TerminalPerfEvent[] = [];
    const report = buildTerminalLatencyReport(events);
    const applicationDisplayOutcome = collectApplicationDisplayOutcome(events);
    const compressed = gzipSync(JSON.stringify(events));
    const replay = verifyRawTerminalPerfTrace(
      compressed,
      events.length,
      report,
      applicationDisplayOutcome,
    );
    const impairment = proxyImpairment({
      profile: 'fast',
      targetRttMs: 50,
      baseDelayUs: 12_500,
      jitterRadiusUs: 1_250,
      seed: 7,
    });
    const summaries = [];
    for (const [index, sentinel] of REQUIRED_TEST_EVIDENCE.recovery.entries()) {
      const artifact = path.join(directory, `artifact-${index}.json`);
      const rawArtifact = path.join(directory, `events-${index}.json.gz`);
      await writeFile(rawArtifact, compressed);
      await writeFile(
        artifact,
        JSON.stringify({
          schemaVersion: TERMINAL_PERF_ARTIFACT_SCHEMA_VERSION,
          test: {
            id: `test-${index}`,
            title: sentinel.title,
            file: `/repo/tests/e2e/${sentinel.file}`,
            status: 'passed',
            expectedStatus: 'passed',
          },
          report,
          gridConvergence: gridConvergenceEvidence(),
          transportProfile: {
            achieved: impairment,
            applicationDisplayOutcome,
          },
        }),
      );
      summaries.push({
        artifact,
        rawEvents: {
          artifact: rawArtifact,
          sha256: createHash('sha256').update(compressed).digest('hex'),
          eventCount: replay.eventCount,
          reportSha256: replay.reportSha256,
          applicationDisplayOutcomeSha256: replay.applicationDisplayOutcomeSha256,
          metricSamples: replay.metricSamples,
          metricComplete: replay.metricComplete,
          complete: true,
          error: null,
        },
        testId: `test-${index}`,
        testTitle: sentinel.title,
        testFile: `/repo/tests/e2e/${sentinel.file}`,
        testStatus: 'passed',
        testExpectedStatus: 'passed',
        gridConvergence: gridConvergenceEvidence(),
        measurementWindowCount: 0,
        measurementPurpose: null,
        complete: true,
        errors: [],
        metrics: extractPercentileMetrics(report),
        applicationDisplayOutcome,
        proxyImpairment: impairment,
        proxyFaultEvidence: {
          exactLossObserved: false,
          exactLossSelectorWindowVerified: false,
          reorderObserved: false,
          burstLossObserved: false,
          congestionObserved: false,
        },
      });
    }
    const daemonArtifact = path.join(directory, 'daemon-transport.jsonl');
    const daemonLine = daemonCaptureLine({
      captureRequestedAtMs: 97_000,
      captureCompletedAtMs: 99_500,
      healthCheckedAtMs: 99_000,
      observedAtMs: 98_000,
      sampleCount: 1,
    });
    await writeFile(daemonArtifact, daemonLine);
    const daemonTransport = analyzeDaemonTransportLogLines([daemonLine], 100_000, daemonArtifact);
    const runStartedAt = new Date(100_000 - 123).toISOString();
    try {
      await writeMatrixArtifact(filename, {
        schemaVersion: 9,
        startedAt: '2026-09-04T00:00:00.000Z',
        plan: {
          cellIds: [id],
          sourceFingerprint,
          playwrightArgsByPhase: { workload: playwrightArgs, recovery: [] },
        },
        runs: [
          {
            id,
            cell,
            startedAt: runStartedAt,
            durationMs: 123,
            exitCode: 0,
            harnessResult: { seed: 7 },
            latencySummaries: summaries,
            latencyEvidenceErrors: [],
            daemonTransport,
          },
        ],
      });
      const resumed = await loadCompatibleMatrixCheckpoint(
        filename,
        [cell],
        playwrightArgs,
        [],
        sourceFingerprint,
      );
      expect(resumed?.runs.map((run) => run.id)).toEqual([id]);
      expect(resumed?.runs[0]?.harnessResult).toEqual({ seed: 7 });

      const retainedRaw = summaries[0]?.rawEvents.artifact;
      if (retainedRaw === undefined || retainedRaw === null) {
        throw new Error('retained raw checkpoint fixture is missing');
      }
      await writeFile(retainedRaw, gzipSync('corrupt'));
      await expect(
        loadCompatibleMatrixCheckpoint(filename, [cell], playwrightArgs, [], sourceFingerprint),
      ).rejects.toThrow('unverifiable retained evidence');
      await writeFile(retainedRaw, compressed);

      await writeFile(daemonArtifact, `${daemonLine}\ncorrupt final evidence`);
      await expect(
        loadCompatibleMatrixCheckpoint(filename, [cell], playwrightArgs, [], sourceFingerprint),
      ).rejects.toThrow('unverifiable retained evidence');
      await writeFile(daemonArtifact, daemonLine);

      await expect(
        loadCompatibleMatrixCheckpoint(
          filename,
          [cell],
          ['different.e2e.ts'],
          [],
          sourceFingerprint,
        ),
      ).rejects.toThrow('exact matrix plan differs');
      await expect(
        loadCompatibleMatrixCheckpoint(
          filename,
          [cell],
          playwrightArgs,
          [],
          'sha256:different-source',
        ),
      ).rejects.toThrow('exact matrix plan differs');

      const firstSummary = summaries[0];
      if (firstSummary === undefined) throw new Error('required manifest unexpectedly empty');
      await writeMatrixArtifact(filename, {
        schemaVersion: 9,
        startedAt: '2026-09-04T00:00:00.000Z',
        plan: {
          cellIds: [id],
          sourceFingerprint,
          playwrightArgsByPhase: { workload: playwrightArgs, recovery: [] },
        },
        runs: [
          {
            id,
            cell,
            startedAt: runStartedAt,
            durationMs: 123,
            exitCode: 0,
            harnessResult: { seed: 7 },
            latencySummaries: [
              {
                ...firstSummary,
                rawEvents: {
                  artifact: null,
                  sha256: null,
                  eventCount: 12,
                  reportSha256: null,
                  applicationDisplayOutcomeSha256: null,
                  metricSamples: rawMetricSamples(),
                  metricComplete: rawMetricCompleteness(false),
                  complete: false,
                  error: 'copy failed',
                },
              },
              ...summaries.slice(1),
            ],
            latencyEvidenceErrors: [],
            daemonTransport,
          },
        ],
      });
      const incomplete = await loadCompatibleMatrixCheckpoint(
        filename,
        [cell],
        playwrightArgs,
        [],
        sourceFingerprint,
      );
      expect(incomplete?.runs).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
