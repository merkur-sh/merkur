import {
  buildTerminalLatencyReport,
  type TerminalPerfEvent,
} from '../apps/web/src/perf/terminal-latency';
import { emitPerfMetric } from './perf/harness';

const INPUTS = positiveInteger(process.env.BENCH_INPUTS, 10_000);
const SAMPLES = positiveInteger(process.env.BENCH_SAMPLES, 10);
const WARMUPS = positiveInteger(process.env.BENCH_WARMUPS, 2);

benchmarkScenario('dense', makeEvents(INPUTS, true), true);
benchmarkScenario('unmatched', makeEvents(INPUTS, false), false);

function makeEvents(inputCount: number, correlated: boolean): TerminalPerfEvent[] {
  const events: TerminalPerfEvent[] = [];
  for (let inputSeq = 1; inputSeq <= inputCount; inputSeq += 1) {
    const atMs = inputSeq * 10;
    const correlatedSeq = correlated ? inputSeq : 0;
    events.push({ kind: 'input_queued', atMs, admittedAtMs: atMs, inputSeq, byteLength: 1 });
    events.push(displayEvent('display_received', atMs + 1, correlatedSeq, inputSeq));
    events.push(displayEvent('worker_display_queued', atMs + 2, correlatedSeq, inputSeq));
    events.push(displayEvent('worker_display_applied', atMs + 3, correlatedSeq, inputSeq));
    // One render identity per input. The start/end/completion triple is what
    // the report's `renderSeq` join walks, so the benchmark measures the join
    // rather than a report that silently skipped it.
    events.push({
      kind: 'render_start',
      atMs: atMs + 4,
      renderSeq: inputSeq,
      displayInputSeq: correlatedSeq,
      predictionInputSeq: 0,
      queuedDisplayFrames: 0,
      wantedAtMs: atMs + 3,
      gate: 'immediate',
      fenceReleasedAtMs: 0,
      fenceReleasedRenderSeq: 0,
      opportunityEnteredAtMs: 0,
      opportunityDelayMs: 0,
      fenceWaitMs: 0,
      opportunityWaitMs: 0,
      refreshPeriodMs: 1000 / 60,
      refreshConfidence01: 1,
    });
    events.push({
      kind: 'render_end',
      atMs: atMs + 5,
      renderSeq: inputSeq,
      displayInputSeq: correlatedSeq,
      predictionInputSeq: 0,
      visiblePredictionInputSeqs: [],
      visiblePredictionInputSeqsTruncated: false,
      queuedDisplayFrames: 0,
      completionMode: 'gpu-queue',
      atlasUploaded: false,
      drainedDisplay: false,
    });
    events.push({
      kind: 'presentation_commit',
      atMs: atMs + 5.25,
      releaseFrameTimeMs: 0,
      releaseFrameCount: 0,
      membershipReleaseDisableBits: 0,
      transactionSeq: inputSeq,
      renderSeq: inputSeq,
      generation: 1,
      firstDisplaySeq: inputSeq,
      lastDisplaySeq: inputSeq,
      displayInputSeq: correlatedSeq,
      displayEchoHorizonSeq: correlatedSeq,
      firstPresentationId: inputSeq,
      lastPresentationId: inputSeq,
      firstApplyToCommitMs: 2.25,
      lastApplyToCommitMs: 2.25,
      deadlineOverrunMs: 0,
      refreshPeriodMs: 1000 / 60,
      datagramCount: 1,
      rowCount: 1,
      byteLength: 32,
      queueHighWater: 1,
      coherent: false,
      endSeen: true,
      authoritativeVisualChange: correlated,
      reason: 'urgent',
    });
    events.push({
      kind: 'frame_complete',
      completionDisposition: 'latest-submitted',
      atMs: atMs + 6,
      renderSeq: inputSeq,
      displayInputSeq: correlatedSeq,
      predictionInputSeq: 0,
      visiblePredictionInputSeqs: [],
      visiblePredictionInputSeqsTruncated: false,
      queuedDisplayFrames: 0,
      pollCount: 0,
      previousPollAtMs: 0,
    });
    events.push({
      kind: 'input_ack',
      atMs: atMs + 7,
      inputSeq: correlatedSeq,
      networkRttMs: null,
    });
  }
  return events;
}

function displayEvent(
  kind: 'display_received' | 'worker_display_queued' | 'worker_display_applied',
  atMs: number,
  inputSeq: number,
  displaySeq: number,
): TerminalPerfEvent {
  return {
    kind,
    atMs,
    displaySeq,
    generation: 1,
    inputSeq,
    frameId: displaySeq,
    chunkIndex: 0,
    chunkCount: 1,
    presentationId: displaySeq,
    presentationMemberIndex: 0,
    presentationMemberCount: 0,
    rowPredecessorPresentationId: 0,
    presentationTransactionSeq: kind === 'worker_display_applied' ? displaySeq : 0,
    presentationCoherent: false,
    fecRecovered: false,
    presentationEnd: false,
    authoritativeVisualMutation: kind === 'worker_display_applied' ? true : null,
    workerReceiptToDecodeMs: kind === 'display_received' ? 0.25 : null,
    decodeToApplyMs: kind === 'worker_display_applied' ? 0.75 : null,
    byteLength: 32,
    rowCount: 1,
    displayKind: 'display_delta',
  };
}

function benchmarkScenario(
  name: 'dense' | 'unmatched',
  events: readonly TerminalPerfEvent[],
  correlated: boolean,
): void {
  for (let index = 0; index < WARMUPS; index += 1) {
    verifyReport(buildTerminalLatencyReport(events), INPUTS, correlated);
  }

  const elapsedSamples: number[] = [];
  for (let index = 0; index < SAMPLES; index += 1) {
    const startedAt = performance.now();
    const report = buildTerminalLatencyReport(events);
    elapsedSamples.push(performance.now() - startedAt);
    verifyReport(report, INPUTS, correlated);
  }
  elapsedSamples.sort((left, right) => left - right);

  const p50Ms = nearestRank(elapsedSamples, 0.5);
  const p95Ms = nearestRank(elapsedSamples, 0.95);
  const p99Ms = nearestRank(elapsedSamples, 0.99);
  const eventCount = events.length;
  const eventsPerSecond = Math.round(eventCount / (p50Ms / 1_000));

  process.stdout.write(
    `terminal latency report ${name}: inputs=${INPUTS}, events=${eventCount}, samples=${SAMPLES}\n` +
      `report: p50=${p50Ms.toFixed(3)}ms, p95=${p95Ms.toFixed(3)}ms, p99=${p99Ms.toFixed(3)}ms, ${eventsPerSecond.toLocaleString('en-US')} events/s\n`,
  );
  for (const [value, percentile] of [
    [p50Ms, 0.5],
    [p95Ms, 0.95],
    [p99Ms, 0.99],
  ] as const) {
    emitPerfMetric({
      name: `terminal-latency-report-${name}`,
      value,
      unit: 'ms',
      direction: 'lower',
      percentile,
      sampleSize: SAMPLES,
    });
  }
  emitPerfMetric({
    name: `terminal-latency-report-${name}-throughput`,
    value: eventsPerSecond,
    unit: 'events/s',
    direction: 'higher',
    sampleSize: eventCount,
  });
}

function verifyReport(
  report: ReturnType<typeof buildTerminalLatencyReport>,
  expectedSamples: number,
  correlated: boolean,
): void {
  if (
    report.sampleCount !== expectedSamples ||
    report.inputToDisplayPaintMs.count !== (correlated ? expectedSamples : 0) ||
    report.inputToAuthoritativeVisualFenceMs.count !== (correlated ? expectedSamples : 0) ||
    report.presentation.commitCount !== expectedSamples ||
    report.inputAckMs.p99 !== (correlated ? 7 : null)
  ) {
    throw new Error('terminal latency report benchmark produced an invalid correlation result');
  }
}

function nearestRank(sorted: readonly number[], percentile: number): number {
  return sorted[Math.max(0, Math.ceil(sorted.length * percentile) - 1)] ?? 0;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`expected a positive integer, received ${JSON.stringify(value)}`);
  }
  return parsed;
}
