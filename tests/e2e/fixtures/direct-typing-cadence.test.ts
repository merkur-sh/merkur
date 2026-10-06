import { expect, test } from 'bun:test';
import type {
  TerminalLatencySample,
  TerminalPerfEvent,
} from '../../../apps/web/src/perf/terminal-latency';
import { summarizeDirectTypingCadence } from './direct-typing-cadence';
import { DIRECT_TYPING_ORDINAL_PATTERN } from './direct-typing-populations';

function fixture() {
  const samples: TerminalLatencySample[] = [];
  const events: TerminalPerfEvent[] = [];
  for (let ordinal = 0; ordinal < 240; ordinal += 1) {
    const inputSeq = ordinal + 1;
    events.push({
      kind: 'input_queued',
      inputSeq,
      atMs: 1000 + ordinal * 100,
      admittedAtMs: 1000 + ordinal * 100,
      byteLength: 1,
    });
    samples.push({
      inputSeq,
      physicalInputToAdmissionMs: 0,
      touchToCommitMs: null,
      touchToPredictionSubmissionMs: null,
      inputToPredictionSubmissionMs: null,
      inputToPredictionPaintMs: null,
      admissionToInputSentMs: 0.1,
      inputSentToAckMs: 50,
      inputAckNetworkRttFloorMs: 50,
      inputAckNonNetworkUpperBoundMs: 0,
      inputToDisplayReceiveMs: 52,
      displayReceiveToWorkerQueueMs: 0.1,
      workerQueueToDisplayApplyMs: 0.1,
      inputToDisplayApplyMs: 52.2,
      inputToDisplayPaintMs: 60,
      inputToAuthoritativeVisualFenceMs: 60,
      inputToCompletedSenderPresentationFenceMs: null,
      inputToCompletedAuthoritativePresentationFenceMs: null,
      displayApplyToPaintMs: 7.8,
      displayApplyToRenderStartMs: 1,
      renderStartToRenderEndMs: 0.2,
      renderEndToDisplayPaintMs: 6.6,
      renderEndToLastUnreadyPollMs: 6,
      fenceObservationIntervalMs: 0.6,
      displayApplyToRenderWantedMs: 0.1,
      renderFenceGateMs: null,
      renderOpportunityGateMs: null,
      inputAckMs: 50,
    });
  }
  const ranges = DIRECT_TYPING_ORDINAL_PATTERN.map((range) => ({
    ...range,
    firstInputSeq: range.firstOrdinal + 1,
    lastInputSeq: range.endOrdinal,
  }));
  return { samples, events, ranges };
}

function analyze(trace: ReturnType<typeof fixture>) {
  return summarizeDirectTypingCadence(trace.samples, trace.events, trace.ranges, 16);
}

function authority(result: ReturnType<typeof analyze>) {
  const endpoint = result.populations[0]?.endpoints.find(
    (entry) => entry.metric === 'inputToAuthoritativeVisualFenceMs',
  );
  if (endpoint === undefined) throw new Error('missing authority');
  return endpoint;
}

test('constant remote latency is not a cadence stall; no cross-class/cycle pairs', () => {
  const result = analyze(fixture());
  expect(authority(result).pairs).toHaveLength(114);
  expect(authority(result).extraRefreshIntervalCount).toBe(0);
  expect(authority(result).endpointGapMs.p50).toBe(100);
  expect(authority(result).latencyMs.p50).toBe(60);
  expect(result.populations[0]?.inputGapMs.count).toBe(114);
});

test('retains a delayed key and its subsequent catch-up with exact identities and stage costs', () => {
  const trace = fixture();
  const row = trace.samples[10];
  if (row === undefined) throw new Error('missing fixture');
  trace.samples[10] = { ...row, inputToAuthoritativeVisualFenceMs: 90, renderFenceGateMs: 30 };
  const result = analyze(trace);
  expect(authority(result).extraRefreshIntervalCount).toBe(1);
  expect(authority(result).catchUpIntervalCount).toBe(1);
  expect(authority(result).pairs[9]).toMatchObject({
    inputSeq: 11,
    previousInputSeq: 10,
    inputGapMs: 100,
    endpointGapMs: 130,
    latencyGrowthMs: 30,
  });
  expect(result.rows[10]?.renderFenceGateMs).toBe(30);
});

test('slow injection alone does not become a terminal stall', () => {
  const trace = fixture();
  trace.events = trace.events.map((event, ordinal) => ({
    ...event,
    atMs: event.atMs + (ordinal >= 10 ? 50 : 0),
  }));
  const endpoint = authority(analyze(trace));
  expect(endpoint.endpointGapMs.max).toBe(150);
  expect(endpoint.extraRefreshIntervalCount).toBe(0);
});

test('missing endpoints stay missing and never bridge gaps', () => {
  const trace = fixture();
  const row = trace.samples[10];
  if (row === undefined) throw new Error('missing fixture');
  trace.samples[10] = { ...row, inputToAuthoritativeVisualFenceMs: null };
  const result = analyze(trace);
  expect(authority(result).missingInputCount).toBe(1);
  expect(authority(result).missingPairCount).toBe(2);
  expect(authority(result).pairs).toHaveLength(112);
  expect(
    result.populations[0]?.endpoints.find((entry) => entry.metric === 'inputToPredictionPaintMs'),
  ).toMatchObject({ observedInputCount: 0, missingInputCount: 120, missingPairCount: 114 });
});

test('preserves equal and reversed endpoints without claiming shared render identity', () => {
  const trace = fixture();
  for (const [ordinal, latency] of [
    [10, 160],
    [12, 180],
  ] as const) {
    const row = trace.samples[ordinal];
    if (row === undefined) throw new Error('missing fixture');
    trace.samples[ordinal] = { ...row, inputToAuthoritativeVisualFenceMs: latency };
  }
  const result = authority(analyze(trace));
  expect(result.equalEndpointCount).toBe(1);
  expect(result.reversedEndpointCount).toBe(1);
  expect(Math.min(...result.pairs.map((pair) => pair.endpointGapMs))).toBe(-20);
});

test('rejects duplicate identities, invalid durations, invalid periods and incomplete ranges', () => {
  const trace = fixture();
  expect(() =>
    summarizeDirectTypingCadence(trace.samples, trace.events, trace.ranges, 0),
  ).toThrow();
  expect(() =>
    summarizeDirectTypingCadence(trace.samples, trace.events, trace.ranges.slice(1), 16),
  ).toThrow();
  const row = trace.samples[10];
  if (row === undefined) throw new Error('missing fixture');
  trace.samples[10] = { ...row, inputToAuthoritativeVisualFenceMs: Number.NaN };
  expect(() => analyze(trace)).toThrow();
  trace.samples[10] = { ...row, inputSeq: 10 };
  expect(() => analyze(trace)).toThrow();
});

test('keeps u32 wrap in original input order', () => {
  const trace = fixture();
  const sequence = (ordinal: number) => (ordinal < 16 ? 0xffff_fff0 + ordinal : ordinal - 15);
  trace.samples = trace.samples.map((row, ordinal) => ({ ...row, inputSeq: sequence(ordinal) }));
  trace.events = trace.events.map((event, ordinal) => ({ ...event, inputSeq: sequence(ordinal) }));
  trace.ranges = trace.ranges.map((range) => ({
    ...range,
    firstInputSeq: sequence(range.firstOrdinal),
    lastInputSeq: sequence(range.endOrdinal - 1),
  }));
  expect(authority(analyze(trace)).pairs[15]).toMatchObject({
    previousInputSeq: 0xffff_ffff,
    inputSeq: 1,
  });
});

test('rejects raw-time reversal and relabeled or overlapping classes', () => {
  const trace = fixture();
  const range = trace.ranges[0];
  if (range === undefined) throw new Error('missing fixture');
  trace.ranges[1] = range;
  expect(() => analyze(trace)).toThrow();
  const reversed = fixture();
  const event = reversed.events[10];
  if (event === undefined) throw new Error('missing fixture');
  reversed.events[10] = { ...event, atMs: 0 };
  expect(() => analyze(reversed)).toThrow();
});
