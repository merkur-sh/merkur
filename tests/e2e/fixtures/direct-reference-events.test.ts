import { describe, expect, test } from 'bun:test';
import {
  analyzeDirectReferenceInputs,
  COMMON_DAEMON_STAGES,
  referenceSequenceCovers,
  validateDirectReferenceDump,
  validateDirectReferenceInputCoverage,
} from './direct-reference-events';

const window = {
  startAtMs: 1,
  inputEndAtMs: 4,
  endAtMs: 30,
  proofAtMs: 31,
  expectedInputCount: 2,
};
const input = (inputSeq: number, atMs: number) => ({
  kind: 'input_queued',
  inputSeq,
  atMs,
  admittedAtMs: atMs + 0.1,
  byteLength: 1,
});
const display = (kind: string, atMs: number, inputSeq = 2) => ({
  kind,
  atMs,
  displaySeq: 11,
  generation: 1,
  inputSeq,
  frameId: 11,
  byteLength: 80,
  rowCount: 1,
  displayKind: 'display_delta',
});
const daemonTiming = (inputSeq: number, atMs: number) => ({
  kind: 'daemon_timing',
  inputSeq,
  atMs,
  batchSeq: 1,
  observationEpoch: 1,
  ...Object.fromEntries(COMMON_DAEMON_STAGES.map((key) => [key, 10])),
});
function frame(
  renderSeq: number,
  start: number,
  end: number,
  fence: number,
  displayInputSeq: number,
  ids: number[] = [],
) {
  return [
    { kind: 'render_start', atMs: start, renderSeq, displayInputSeq },
    { kind: 'render_end', atMs: end, renderSeq, atlasUploaded: false, completionMode: 'gpu-queue' },
    {
      kind: 'frame_complete',
      atMs: fence,
      renderSeq,
      displayInputSeq,
      predictionInputSeq: ids.at(-1) ?? 0,
      visiblePredictionInputSeqs: ids,
      visiblePredictionInputSeqsTruncated: false,
      queuedDisplayFrames: 0,
      pollCount: 0,
      previousPollAtMs: 0,
    },
  ];
}
function fixture() {
  return [
    { kind: 'unrelated_retained_precondition', atMs: 0 },
    input(1, 2),
    input(2, 3),
    { kind: 'prediction_applied', inputSeq: 1, atMs: 3.2 },
    ...frame(1, 4, 4.1, 5, 0, [1]),
    display('display_received', 10),
    display('worker_display_applied', 12),
    // OLD render's fence may complete after the new apply. It cannot own it.
    ...frame(2, 11, 11.1, 15, 1),
    ...frame(3, 13, 13.1, 20, 2),
    { kind: 'input_sent', inputSeq: 1, atMs: 2.2 },
    { kind: 'input_ack', inputSeq: 2, atMs: 16, networkRttMs: 50 },
    daemonTiming(1, 21),
    daemonTiming(2, 22),
    {
      kind: 'daemon_timing_status',
      atMs: 23,
      batchSeq: 1,
      observationEpoch: 1,
      inputAttributedTotal: 2,
      inputDroppedTotal: 0,
      inputSkippedTotal: 0,
      pendingInputs: 0,
      displayAttributedTotal: 0,
      displayDroppedTotal: 0,
      recordCount: 2,
    },
    { kind: 'main_frame_cadence', atMs: 31, gapMs: 8.3 },
  ];
}

describe('common release/final Direct event adapter', () => {
  test('joins exact render starts, not fence timestamp adjacency or prediction watermarks', () => {
    const result = analyzeDirectReferenceInputs(fixture(), window, ['printable', 'backspace']);
    expect(result.samples[0]?.inputToExactPredictionGpuFenceMs).toBe(3);
    expect(result.samples[1]?.inputToExactPredictionGpuFenceMs).toBeNull();
    expect(result.samples.map((sample) => sample.authoritativeRenderSeq)).toEqual([3, 3]);
    expect(result.samples.map((sample) => sample.inputToAuthoritativeWatermarkGpuFenceMs)).toEqual([
      18, 17,
    ]);
    expect(result.samples[0]?.inputToAckMs).toBe(14);
    expect(result.daemonSamples).toHaveLength(2);
    expect(result.daemonStageDistributionsUs.prepareQueueUs?.p99).toBe(10);
    expect(result.authoritativeFenceCoverage).toBe(1);
  });
  test('selects only a causal display receipt after the owned input origin', () => {
    const result = analyzeDirectReferenceInputs(
      [
        ...fixture(),
        { ...display('display_received', 1.5, 1), displaySeq: 10 },
        { ...display('worker_display_applied', 1.6, 1), displaySeq: 10 },
      ],
      window,
      ['printable', 'backspace'],
    );
    expect(result.samples[0]?.inputToCausalDisplayReceiveMs).toBe(8);
  });
  test('retains missing individual attribution rather than copying a neighbor sample', () => {
    const result = analyzeDirectReferenceInputs(fixture(), window, ['printable', 'backspace']);
    expect(result.samples[1]?.admissionToTransportSubmissionMs).toBeNull();
    expect(result.classes[1]?.metrics.admissionToTransportSubmissionMs?.coverage).toBe(0);
  });
  test('gates every homogeneous class independently and retains cadence-zero as completeness only', () => {
    const complete = [...fixture(), { kind: 'input_sent', inputSeq: 2, atMs: 3.2 }];
    const result = analyzeDirectReferenceInputs(complete, window, ['printable', 'backspace']);
    expect(
      validateDirectReferenceInputCoverage(result, {
        mode: 'latency',
        expectedClassCounts: { printable: 1, backspace: 1 },
        minimumCausalSamplesPerClass: 1,
        targetRttMs: 50,
        appRttToleranceMs: 10,
      }),
    ).toEqual({ complete: true, mode: 'latency', appRttEnvelopeMs: [40, 60] });
    expect(() =>
      validateDirectReferenceInputCoverage(
        analyzeDirectReferenceInputs(fixture(), window, ['printable', 'backspace']),
        {
          mode: 'latency',
          expectedClassCounts: { printable: 1, backspace: 1 },
          minimumCausalSamplesPerClass: 1,
          targetRttMs: 50,
          appRttToleranceMs: 10,
        },
      ),
    ).toThrow('admissionToTransportSubmissionMs');
    expect(
      validateDirectReferenceInputCoverage(result, {
        mode: 'completeness-only',
        expectedClassCounts: { printable: 1, backspace: 1 },
        minimumCausalSamplesPerClass: 1,
        targetRttMs: 50,
        appRttToleranceMs: 10,
      }).mode,
    ).toBe('completeness-only');
    expect(() =>
      validateDirectReferenceInputCoverage(
        analyzeDirectReferenceInputs(fixture(), window, ['printable', 'backspace']),
        {
          mode: 'completeness-only',
          expectedClassCounts: { printable: 1, backspace: 1 },
          minimumCausalSamplesPerClass: 1,
          targetRttMs: 50,
          appRttToleranceMs: 10,
        },
      ),
    ).toThrow('admissionToTransportSubmissionMs');
  });
  test('rejects clipping, duplicates, malformed membership and a tail input', () => {
    expect(() => analyzeDirectReferenceInputs(fixture().slice(1), window, ['p', 'b'])).toThrow(
      'retention',
    );
    expect(() =>
      analyzeDirectReferenceInputs([...fixture(), input(3, 8)], window, ['p', 'b']),
    ).toThrow('tail');
    expect(() =>
      analyzeDirectReferenceInputs([...fixture(), input(1, 2)], window, ['p', 'b']),
    ).toThrow('duplicate');
    expect(() =>
      analyzeDirectReferenceInputs(
        fixture().map((event) =>
          event.kind === 'input_queued' && 'inputSeq' in event && event.inputSeq === 2
            ? { ...event, inputSeq: 3 }
            : event,
        ),
        window,
        ['p', 'b'],
      ),
    ).toThrow('contiguous');
    expect(() =>
      analyzeDirectReferenceInputs(
        fixture().map((event) =>
          event.kind === 'input_queued' && 'inputSeq' in event && event.inputSeq === 2
            ? { ...event, byteLength: 2 }
            : event,
        ),
        window,
        ['p', 'b'],
      ),
    ).toThrow('exactly one byte');
    expect(() =>
      analyzeDirectReferenceInputs(
        [...fixture(), { ...display('display_received', 30.5), displaySeq: 12 }],
        window,
        ['p', 'b'],
      ),
    ).toThrow('after its tail boundary');
    const truncated = fixture().map((event) =>
      event.kind === 'frame_complete'
        ? { ...event, visiblePredictionInputSeqsTruncated: true }
        : event,
    );
    expect(() => analyzeDirectReferenceInputs(truncated, window, ['p', 'b'])).toThrow('truncated');
  });
  test('fails closed on daemon completeness, lineage replacement, and render boundary overlap', () => {
    expect(() =>
      analyzeDirectReferenceInputs(
        fixture().filter(
          (event) =>
            !(event.kind === 'daemon_timing' && 'inputSeq' in event && event.inputSeq === 2),
        ),
        window,
        ['p', 'b'],
      ),
    ).toThrow('daemon timing population');
    expect(() =>
      analyzeDirectReferenceInputs([...fixture(), daemonTiming(1, 24)], window, ['p', 'b']),
    ).toThrow('duplicate daemon timing');
    expect(() =>
      analyzeDirectReferenceInputs(
        fixture().map((event) =>
          event.kind === 'daemon_timing_status' ? { ...event, inputDroppedTotal: 1 } : event,
        ),
        window,
        ['p', 'b'],
      ),
    ).toThrow('final cumulative accounting');
    expect(() =>
      analyzeDirectReferenceInputs([...fixture(), { kind: 'session_start', atMs: 6 }], window, [
        'p',
        'b',
      ]),
    ).toThrow('session boundary');
    expect(() =>
      analyzeDirectReferenceInputs(
        [...fixture(), { kind: 'transport_state', state: 'signaling_reconnecting', atMs: 6 }],
        window,
        ['p', 'b'],
      ),
    ).toThrow('reconnect boundary');
    expect(() =>
      analyzeDirectReferenceInputs(
        [
          ...fixture(),
          { kind: 'render_start', atMs: 29, renderSeq: 9, displayInputSeq: 2 },
          {
            kind: 'render_end',
            atMs: 30.5,
            renderSeq: 9,
            atlasUploaded: false,
            completionMode: 'gpu-queue',
          },
        ],
        window,
        ['p', 'b'],
      ),
    ).toThrow('render ended outside');
  });
  test('rejects recorder loss and honors serial wrap/half-range', () => {
    expect(() =>
      validateDirectReferenceDump({ events: fixture(), stats: { recordsLost: 1 } }),
    ).toThrow('lost');
    expect(
      validateDirectReferenceDump({ events: fixture(), stats: { recordsLost: 0 } }).events,
    ).toHaveLength(fixture().length);
    expect(referenceSequenceCovers(1, 0xffff_ffff)).toBe(true);
    expect(referenceSequenceCovers(0xffff_ffff, 1)).toBe(false);
    expect(referenceSequenceCovers(0x8000_0001, 1)).toBe(false);
    expect(referenceSequenceCovers(0, 1)).toBe(false);
  });
});
