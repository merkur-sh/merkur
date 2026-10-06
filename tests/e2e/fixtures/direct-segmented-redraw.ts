import {
  TERMINAL_LATENCY_RAW_METRIC_NAMES,
  type TerminalLatencyRawMetricName,
  type TerminalLatencyRawMetricSamples,
} from '../../../apps/web/src/perf/terminal-latency';
import type { DirectFramePhasePopulation } from './direct-frame-control';
import type { DirectCoherentInputPopulation } from './direct-tui-workloads';
import { referenceDistribution } from './terminal-redraw-reference';

export const DIRECT_REDRAW_OBSERVATION_SEGMENT_SIZE = 20;

export interface DirectRedrawSegmentRingBoundary {
  readonly atMs: number;
  readonly measurementId: number;
  readonly phase: 'start' | 'end';
  readonly observationEpoch: number;
  readonly sessionEpoch: number;
  readonly ringDroppedTotal: number;
}

export interface DirectRedrawSegmentArtifactLink {
  readonly rawArtifact: string;
  readonly rawSha256: string;
  readonly reportArtifact: string;
  readonly reportSha256: string;
  readonly replayEventCount: number;
  readonly replayReportSha256: string;
  readonly replayApplicationDisplayOutcomeSha256: string;
}

export interface DirectRedrawSegmentHopCounters {
  readonly epoch: number;
  readonly upstreamForwarded: number;
  readonly downstreamForwarded: number;
}

export interface DirectRedrawObservationSegment {
  readonly segmentIndex: number;
  readonly firstSampleOrdinal: number;
  readonly sampleCount: number;
  readonly inputPopulation: DirectCoherentInputPopulation;
  readonly ringBoundaries: readonly DirectRedrawSegmentRingBoundary[];
  readonly metricSamples: TerminalLatencyRawMetricSamples;
  readonly metricComplete: Readonly<Record<TerminalLatencyRawMetricName, boolean>>;
  readonly directHopCounters: readonly DirectRedrawSegmentHopCounters[];
  readonly artifacts: DirectRedrawSegmentArtifactLink;
  readonly errors: readonly string[];
}

export interface DirectRedrawObservationSegmentSummary {
  readonly segmentIndex: number;
  readonly firstSampleOrdinal: number;
  readonly lastSampleOrdinal: number;
  readonly sampleCount: number;
  readonly observationEpoch: number;
  readonly sessionEpoch: number;
  readonly firstMeasurementId: number;
  readonly lastMeasurementId: number;
  readonly firstInputSeq: number;
  readonly lastInputSeq: number;
  readonly ringDroppedAtFirstStart: number;
  readonly ringDroppedAtLastEnd: number;
  readonly directHopForwardedDeltas: readonly {
    readonly upstream: number;
    readonly downstream: number;
  }[];
  readonly artifacts: DirectRedrawSegmentArtifactLink;
  readonly errors: readonly string[];
}

export interface DirectSegmentedRedrawEvidence {
  readonly segmentSize: number;
  readonly segmentCount: number;
  readonly windowCount: number;
  readonly inputCount: number;
  readonly inputBytesPerWindow: number;
  readonly sessionEpoch: number;
  readonly firstInputSeq: number;
  readonly lastInputSeq: number;
  readonly firstMeasurementId: number;
  readonly lastMeasurementId: number;
  readonly ringRefusedFrameCountBetweenSegments: readonly number[];
  readonly segments: readonly DirectRedrawObservationSegmentSummary[];
  readonly metricSamples: TerminalLatencyRawMetricSamples;
  readonly metricComplete: Readonly<Record<TerminalLatencyRawMetricName, boolean>>;
}

export function directRedrawCumulativeHopDeltas(
  previous: readonly DirectRedrawSegmentHopCounters[],
  current: readonly DirectRedrawSegmentHopCounters[],
): readonly { readonly upstream: number; readonly downstream: number }[] {
  if (previous.length !== 2 || current.length !== 2) {
    throw new Error('segmented Direct redraw cumulative hop cut is incomplete');
  }
  return current.map((hop, hopIndex) => {
    const prior = previous[hopIndex];
    if (
      prior === undefined ||
      !isNonNegativeSafeInteger(prior.epoch) ||
      !isNonNegativeSafeInteger(prior.upstreamForwarded) ||
      !isNonNegativeSafeInteger(prior.downstreamForwarded) ||
      !isNonNegativeSafeInteger(hop.epoch) ||
      !isNonNegativeSafeInteger(hop.upstreamForwarded) ||
      !isNonNegativeSafeInteger(hop.downstreamForwarded) ||
      hop.epoch !== prior.epoch ||
      hop.upstreamForwarded < prior.upstreamForwarded ||
      hop.downstreamForwarded < prior.downstreamForwarded
    ) {
      throw new Error(`segmented Direct redraw cumulative hop ${hopIndex} reset or regressed`);
    }
    return {
      upstream: hop.upstreamForwarded - prior.upstreamForwarded,
      downstream: hop.downstreamForwarded - prior.downstreamForwarded,
    };
  });
}

export function summarizeDirectSegmentedRedrawFramePhase(
  name: string,
  evidence: DirectSegmentedRedrawEvidence,
  frameBudgetToleranceMs: number,
): DirectFramePhasePopulation {
  if (name.length === 0 || !Number.isFinite(frameBudgetToleranceMs) || frameBudgetToleranceMs < 0) {
    throw new Error('invalid segmented Direct redraw frame-phase contract');
  }
  const overrun = evidence.metricSamples['mainThread.frameBudgetOverrunMs'];
  const missedPerGap = evidence.metricSamples['mainThread.estimatedMissedFramesPerGap'];
  if (
    !evidence.metricComplete['mainThread.frameBudgetOverrunMs'] ||
    !evidence.metricComplete['mainThread.estimatedMissedFramesPerGap']
  ) {
    throw new Error('pooled rAF frame population is incomplete');
  }
  if (overrun.length === 0 || overrun.length !== missedPerGap.length) {
    throw new Error('pooled rAF overrun and estimated-miss populations differ');
  }
  if (missedPerGap.some((count) => !Number.isSafeInteger(count) || count < 0)) {
    throw new Error('pooled estimated-miss population contains an invalid count');
  }
  return {
    name,
    matchedControl: 'idle',
    intervalCount: overrun.length,
    frameBudgetOverrunMs: referenceDistribution(overrun),
    estimatedMissedFrameCount: missedPerGap.reduce((sum, count) => sum + count, 0),
    estimatedMissedIntervalCount: missedPerGap.filter((count) => count > 0).length,
    frameBudgetExceededIntervalCount: overrun.filter((value) => value > frameBudgetToleranceMs)
      .length,
  };
}

const EXACT_PER_WINDOW_METRICS = [
  'inputAckNetworkRttFloorMs',
  'inputToDisplayReceiveMs',
  'inputToCompletedAuthoritativePresentationFenceMs',
  'displayPipeline.ringRefusedFrameCountPerMeasurementWindow',
  'mainThread.estimatedMissedFramesPerMeasurementWindow',
  'presentation.measurementWindowExposureMs',
  'presentation.measurementWindowToCompletedAuthoritativePresentationFenceMs',
  'presentation.commitsPerMeasurementWindow',
  'presentation.ordinaryCommitsPerMeasurementWindow',
  'presentation.repairCommitsPerMeasurementWindow',
  'presentation.expiredRepairCommitsPerMeasurementWindow',
  'presentation.ordinaryMeasurementWindowExposureMs',
  'presentation.rowsPerMeasurementWindow',
  'presentation.datagramsPerMeasurementWindow',
  'presentation.bytesPerMeasurementWindow',
  'presentation.firstDisplayReceiveToCompletedPresentationFenceMs',
  'presentation.refreshPeriodPerMeasurementWindowMs',
  'presentation.fenceObservationIntervalPerMeasurementWindowMs',
] as const satisfies readonly TerminalLatencyRawMetricName[];

/**
 * Join bounded recorder observations without joining their event timelines.
 *
 * Every segment remains independently replayable. Only exact raw analyzer
 * samples are concatenated here, so the caller can rank the complete n-window
 * population instead of taking a percentile of segment percentiles. The
 * cumulative receive-ring refusal counter and serial identities bridge the
 * reset gaps that are intentionally absent from each segment's raw trace.
 */
export function combineDirectRedrawObservationSegments(
  segments: readonly DirectRedrawObservationSegment[],
  expectedWindowCount: number,
  expectedSessionEpoch: number,
  segmentSize = DIRECT_REDRAW_OBSERVATION_SEGMENT_SIZE,
): DirectSegmentedRedrawEvidence {
  if (
    !Number.isSafeInteger(expectedWindowCount) ||
    expectedWindowCount <= 0 ||
    !isPositiveUint32(expectedSessionEpoch) ||
    !Number.isSafeInteger(segmentSize) ||
    segmentSize <= 0 ||
    expectedWindowCount % segmentSize !== 0 ||
    segments.length !== expectedWindowCount / segmentSize
  ) {
    throw new Error('invalid segmented Direct redraw population contract');
  }

  const pooled = Object.fromEntries(
    TERMINAL_LATENCY_RAW_METRIC_NAMES.map((name) => [name, [] as number[]]),
  ) as Record<TerminalLatencyRawMetricName, number[]>;
  const complete = Object.fromEntries(
    TERMINAL_LATENCY_RAW_METRIC_NAMES.map((name) => [name, true]),
  ) as Record<TerminalLatencyRawMetricName, boolean>;
  const summaries: DirectRedrawObservationSegmentSummary[] = [];
  const inputSeqs: number[] = [];
  const measurementIds: number[] = [];
  const observationEpochs: number[] = [];
  const refusedBetweenSegments: number[] = [];
  const artifactNames = new Set<string>();
  let previousLastBoundary: DirectRedrawSegmentRingBoundary | null = null;
  let previousHopCounters: readonly DirectRedrawSegmentHopCounters[] | null = null;

  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
    const segment = segments[segmentIndex];
    if (segment === undefined) throw new Error(`Direct redraw segment ${segmentIndex} is missing`);
    if (
      segment.segmentIndex !== segmentIndex ||
      segment.firstSampleOrdinal !== segmentIndex * segmentSize ||
      segment.sampleCount !== segmentSize
    ) {
      throw new Error(`Direct redraw segment ${segmentIndex} has a non-contiguous ordinal range`);
    }
    validateArtifactLink(segment.artifacts, artifactNames, segmentIndex);
    if (segment.errors.length !== 0) {
      throw new Error(
        `Direct redraw segment ${segmentIndex} is invalid: ${segment.errors.join('; ')}`,
      );
    }
    if (
      segment.inputPopulation.windowCount !== segmentSize ||
      segment.inputPopulation.inputCount !== segmentSize ||
      segment.inputPopulation.inputBytesPerWindow !== 1 ||
      segment.inputPopulation.windows.length !== segmentSize
    ) {
      throw new Error(`Direct redraw segment ${segmentIndex} has incomplete input ownership`);
    }
    if (segment.directHopCounters.length !== 2) {
      throw new Error(`Direct redraw segment ${segmentIndex} has incomplete direct-hop counters`);
    }
    const directHopForwardedDeltas = directRedrawCumulativeHopDeltas(
      previousHopCounters ??
        segment.directHopCounters.map((hop) => ({
          epoch: hop.epoch,
          upstreamForwarded: 0,
          downstreamForwarded: 0,
        })),
      segment.directHopCounters,
    ).map(({ upstream, downstream }, hopIndex) => {
      if (upstream < segmentSize || downstream < segmentSize) {
        throw new Error(
          `Direct redraw segment ${segmentIndex} direct-hop ${hopIndex} traffic is underpopulated`,
        );
      }
      return { upstream, downstream };
    });
    previousHopCounters = segment.directHopCounters;

    const boundaries = [...segment.ringBoundaries].sort(
      (left, right) =>
        left.atMs - right.atMs ||
        left.measurementId - right.measurementId ||
        (left.phase === right.phase ? 0 : left.phase === 'start' ? -1 : 1),
    );
    if (boundaries.length !== segmentSize * 2) {
      throw new Error(`Direct redraw segment ${segmentIndex} has incomplete ring boundaries`);
    }
    const firstBoundary = boundaries[0];
    const lastBoundary = boundaries.at(-1);
    if (firstBoundary === undefined || lastBoundary === undefined) {
      throw new Error(`Direct redraw segment ${segmentIndex} has no ring boundary`);
    }
    const observationEpoch = firstBoundary.observationEpoch;
    if (!isPositiveUint32(observationEpoch)) {
      throw new Error(`Direct redraw segment ${segmentIndex} has an invalid observation epoch`);
    }
    observationEpochs.push(observationEpoch);

    for (let windowIndex = 0; windowIndex < segmentSize; windowIndex += 1) {
      const window = segment.inputPopulation.windows[windowIndex];
      const start = boundaries[windowIndex * 2];
      const end = boundaries[windowIndex * 2 + 1];
      if (window === undefined || start === undefined || end === undefined) {
        throw new Error(`Direct redraw segment ${segmentIndex} window ${windowIndex} is missing`);
      }
      if (
        start.phase !== 'start' ||
        end.phase !== 'end' ||
        start.measurementId !== window.measurementId ||
        end.measurementId !== window.measurementId ||
        start.atMs !== window.startAtMs ||
        end.atMs !== window.endAtMs ||
        start.atMs >= end.atMs ||
        start.observationEpoch !== observationEpoch ||
        end.observationEpoch !== observationEpoch ||
        start.sessionEpoch !== expectedSessionEpoch ||
        end.sessionEpoch !== expectedSessionEpoch ||
        !isUint32(start.ringDroppedTotal) ||
        !isUint32(end.ringDroppedTotal)
      ) {
        throw new Error(
          `Direct redraw segment ${segmentIndex} window ${windowIndex} has invalid ring lineage`,
        );
      }
      const withinWindowRefusals = unsignedDelta(start.ringDroppedTotal, end.ringDroppedTotal);
      if (withinWindowRefusals !== 0) {
        throw new Error(
          `Direct redraw segment ${segmentIndex} window ${windowIndex} refused ${withinWindowRefusals} receive-ring frames`,
        );
      }
      if (windowIndex > 0) {
        const priorEnd = boundaries[windowIndex * 2 - 1];
        if (priorEnd === undefined) throw new Error('Direct redraw ring boundary pairing failed');
        const betweenWindowRefusals = unsignedDelta(
          priorEnd.ringDroppedTotal,
          start.ringDroppedTotal,
        );
        if (betweenWindowRefusals !== 0) {
          throw new Error(
            `Direct redraw segment ${segmentIndex} refused ${betweenWindowRefusals} receive-ring frames between windows`,
          );
        }
      }
      if (!isPositiveUint32(window.inputSeq) || !isPositiveUint32(window.measurementId)) {
        throw new Error(`Direct redraw segment ${segmentIndex} has an invalid input identity`);
      }
      inputSeqs.push(window.inputSeq);
      measurementIds.push(window.measurementId);
    }

    if (previousLastBoundary !== null) {
      const betweenSegmentRefusals = unsignedDelta(
        previousLastBoundary.ringDroppedTotal,
        firstBoundary.ringDroppedTotal,
      );
      refusedBetweenSegments.push(betweenSegmentRefusals);
      if (
        previousLastBoundary.sessionEpoch !== firstBoundary.sessionEpoch ||
        firstBoundary.atMs <= previousLastBoundary.atMs ||
        betweenSegmentRefusals !== 0
      ) {
        throw new Error(
          `Direct redraw segment ${segmentIndex} changed session, overlapped, or refused receive-ring frames across reset`,
        );
      }
    }
    previousLastBoundary = lastBoundary;

    for (const name of EXACT_PER_WINDOW_METRICS) {
      if (!segment.metricComplete[name] || segment.metricSamples[name].length !== segmentSize) {
        throw new Error(
          `Direct redraw segment ${segmentIndex} ${name} is not an exact ${segmentSize}-window raw population`,
        );
      }
    }
    const betweenWindowRefusals =
      segment.metricSamples['displayPipeline.ringRefusedFrameCountBetweenMeasurementWindows'];
    if (
      !segment.metricComplete['displayPipeline.ringRefusedFrameCountBetweenMeasurementWindows'] ||
      betweenWindowRefusals.length !== segmentSize - 1
    ) {
      throw new Error(
        `Direct redraw segment ${segmentIndex} ring-refusal gap population is incomplete`,
      );
    }
    for (const name of TERMINAL_LATENCY_RAW_METRIC_NAMES) {
      for (const value of segment.metricSamples[name]) {
        if (!Number.isFinite(value) || value < 0) {
          throw new Error(
            `Direct redraw segment ${segmentIndex} ${name} contains an invalid raw sample`,
          );
        }
      }
      complete[name] &&= segment.metricComplete[name];
      pooled[name].push(...segment.metricSamples[name]);
    }
    summaries.push({
      segmentIndex,
      firstSampleOrdinal: segment.firstSampleOrdinal,
      lastSampleOrdinal: segment.firstSampleOrdinal + segment.sampleCount - 1,
      sampleCount: segment.sampleCount,
      observationEpoch,
      sessionEpoch: expectedSessionEpoch,
      firstMeasurementId: segment.inputPopulation.windows[0]?.measurementId ?? 0,
      lastMeasurementId: segment.inputPopulation.windows.at(-1)?.measurementId ?? 0,
      firstInputSeq: segment.inputPopulation.windows[0]?.inputSeq ?? 0,
      lastInputSeq: segment.inputPopulation.windows.at(-1)?.inputSeq ?? 0,
      ringDroppedAtFirstStart: firstBoundary.ringDroppedTotal,
      ringDroppedAtLastEnd: lastBoundary.ringDroppedTotal,
      directHopForwardedDeltas,
      artifacts: segment.artifacts,
      errors: segment.errors,
    });
  }

  requireContiguousPositiveUint32(inputSeqs, 'input');
  requireContiguousPositiveUint32(measurementIds, 'measurement');
  requireContiguousPositiveUint32(observationEpochs, 'observation epoch');
  if (inputSeqs.length !== expectedWindowCount || measurementIds.length !== expectedWindowCount) {
    throw new Error('segmented Direct redraw population is not exactly window-complete');
  }

  const firstInputSeq = inputSeqs[0];
  const lastInputSeq = inputSeqs.at(-1);
  const firstMeasurementId = measurementIds[0];
  const lastMeasurementId = measurementIds.at(-1);
  if (
    firstInputSeq === undefined ||
    lastInputSeq === undefined ||
    firstMeasurementId === undefined ||
    lastMeasurementId === undefined
  ) {
    throw new Error('segmented Direct redraw population has no identity range');
  }

  return {
    segmentSize,
    segmentCount: segments.length,
    windowCount: expectedWindowCount,
    inputCount: inputSeqs.length,
    inputBytesPerWindow: 1,
    sessionEpoch: expectedSessionEpoch,
    firstInputSeq,
    lastInputSeq,
    firstMeasurementId,
    lastMeasurementId,
    ringRefusedFrameCountBetweenSegments: refusedBetweenSegments,
    segments: summaries,
    metricSamples: pooled,
    metricComplete: complete,
  };
}

function validateArtifactLink(
  artifacts: DirectRedrawSegmentArtifactLink,
  names: Set<string>,
  segmentIndex: number,
): void {
  for (const name of [artifacts.rawArtifact, artifacts.reportArtifact]) {
    if (name.length === 0 || names.has(name)) {
      throw new Error(`Direct redraw segment ${segmentIndex} has a missing or duplicate artifact`);
    }
    names.add(name);
  }
  for (const sha256 of [artifacts.rawSha256, artifacts.reportSha256]) {
    if (!/^[0-9a-f]{64}$/u.test(sha256)) {
      throw new Error(`Direct redraw segment ${segmentIndex} has an invalid artifact digest`);
    }
  }
  if (!Number.isSafeInteger(artifacts.replayEventCount) || artifacts.replayEventCount <= 0) {
    throw new Error(`Direct redraw segment ${segmentIndex} has an invalid replay event count`);
  }
  for (const sha256 of [
    artifacts.replayReportSha256,
    artifacts.replayApplicationDisplayOutcomeSha256,
  ]) {
    if (!/^[0-9a-f]{64}$/u.test(sha256)) {
      throw new Error(`Direct redraw segment ${segmentIndex} has an invalid replay digest`);
    }
  }
}

function requireContiguousPositiveUint32(values: readonly number[], label: string): void {
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === undefined || !isPositiveUint32(value)) {
      throw new Error(`segmented Direct redraw ${label} sequence is invalid`);
    }
    if (index === 0) continue;
    const prior = values[index - 1];
    if (prior === undefined || value !== nextPositiveUint32(prior)) {
      throw new Error(`segmented Direct redraw ${label} sequence is not contiguous`);
    }
  }
}

function nextPositiveUint32(value: number): number {
  return value === 0xffff_ffff ? 1 : value + 1;
}

function unsignedDelta(start: number, end: number): number {
  return (end - start) >>> 0;
}

function isUint32(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= 0xffff_ffff;
}

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isPositiveUint32(value: number): boolean {
  return isUint32(value) && value > 0;
}
