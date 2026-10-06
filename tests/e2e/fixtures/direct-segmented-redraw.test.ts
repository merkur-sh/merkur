import { describe, expect, test } from 'bun:test';
import {
  TERMINAL_LATENCY_RAW_METRIC_NAMES,
  type TerminalLatencyRawMetricName,
  type TerminalLatencyRawMetricSamples,
} from '../../../apps/web/src/perf/terminal-latency';
import {
  combineDirectRedrawObservationSegments,
  type DirectRedrawObservationSegment,
  directRedrawCumulativeHopDeltas,
  summarizeDirectSegmentedRedrawFramePhase,
} from './direct-segmented-redraw';

describe('segmented Direct redraw evidence', () => {
  test('pins the production population to five independently replayed 20-window segments', () => {
    const segments = Array.from({ length: 5 }, (_, segmentIndex) =>
      segment(
        segmentIndex,
        segmentIndex * 20,
        1 + segmentIndex * 20,
        10 + segmentIndex * 300,
        100 + segmentIndex,
        0,
        20,
      ),
    );

    const combined = combineDirectRedrawObservationSegments(segments, 100, 9);

    expect(combined.segmentCount).toBe(5);
    expect(combined.segmentSize).toBe(20);
    expect(combined.windowCount).toBe(100);
    expect(combined.inputCount).toBe(100);
    expect(combined.segments.map((segment) => segment.firstSampleOrdinal)).toEqual([
      0, 20, 40, 60, 80,
    ]);
    expect(combined.ringRefusedFrameCountBetweenSegments).toEqual([0, 0, 0, 0]);
    expect(combined.segments.map((segment) => segment.directHopForwardedDeltas)).toEqual(
      Array.from({ length: 5 }, () => [
        { upstream: 20, downstream: 20 },
        { upstream: 20, downstream: 20 },
      ]),
    );
    expect(combined.metricSamples['presentation.rowsPerMeasurementWindow']).toHaveLength(100);
    expect(summarizeDirectSegmentedRedrawFramePhase('bounded-cat', combined, 1)).toMatchObject({
      name: 'bounded-cat',
      matchedControl: 'idle',
      intervalCount: 100,
      frameBudgetOverrunMs: { count: 100, p95: 4, p99: 4, max: 4 },
      estimatedMissedFrameCount: 200,
      estimatedMissedIntervalCount: 80,
      frameBudgetExceededIntervalCount: 60,
    });
  });

  test('joins only raw samples across exact contiguous lossless observations', () => {
    const segments = [segment(0, 0, 0xffff_fffe, 10, 0xffff_ffff, 7), segment(1, 2, 1, 40, 1, 7)];
    const second = segments[1];
    if (second === undefined) throw new Error('fixture segment missing');
    segments[1] = {
      ...second,
      metricComplete: completeness({ 'daemonPipeline.totalUs': false }),
    };

    const combined = combineDirectRedrawObservationSegments(segments, 4, 9, 2);

    expect(combined).toMatchObject({
      segmentSize: 2,
      segmentCount: 2,
      windowCount: 4,
      inputCount: 4,
      inputBytesPerWindow: 1,
      sessionEpoch: 9,
      firstInputSeq: 0xffff_fffe,
      lastInputSeq: 2,
      firstMeasurementId: 0xffff_fffe,
      lastMeasurementId: 2,
      ringRefusedFrameCountBetweenSegments: [0],
    });
    expect(combined.segments.map((value) => value.observationEpoch)).toEqual([0xffff_ffff, 1]);
    expect(combined.metricSamples['presentation.rowsPerMeasurementWindow']).toEqual([0, 0, 1, 1]);
    expect(combined.metricComplete['daemonPipeline.totalUs']).toBe(false);
    expect(combined.metricComplete['presentation.rowsPerMeasurementWindow']).toBe(true);
  });

  test('rejects a receive-ring refusal hidden between recorder observations', () => {
    const first = segment(0, 0, 10, 20, 30, 0);
    const second = segment(1, 2, 12, 50, 31, 1);
    expect(() => combineDirectRedrawObservationSegments([first, second], 4, 9, 2)).toThrow(
      'changed session, overlapped, or refused receive-ring frames across reset',
    );
  });

  test('rejects observations whose page-clock ranges overlap across reset', () => {
    const first = segment(0, 0, 10, 20, 30, 0);
    const second = segment(1, 2, 12, 35, 31, 0);
    expect(() => combineDirectRedrawObservationSegments([first, second], 4, 9, 2)).toThrow(
      'changed session, overlapped, or refused receive-ring frames across reset',
    );
  });

  test('rejects a receive-ring refusal inside a retained measurement', () => {
    const original = segment(0, 0, 10, 20, 30, 0xffff_ffff);
    const boundaries = [...original.ringBoundaries];
    const end = boundaries[1];
    if (end === undefined) throw new Error('fixture boundary missing');
    boundaries[1] = { ...end, ringDroppedTotal: 0 };
    expect(() =>
      combineDirectRedrawObservationSegments(
        [{ ...original, ringBoundaries: boundaries }],
        2,
        9,
        2,
      ),
    ).toThrow('refused 1 receive-ring frames');
  });

  test('rejects reset, regressed, or underpopulated cumulative direct-hop counters', () => {
    const first = segment(0, 0, 10, 20, 30, 0);
    const second = segment(1, 2, 12, 50, 31, 0);
    expect(() =>
      combineDirectRedrawObservationSegments(
        [
          first,
          {
            ...second,
            directHopCounters: second.directHopCounters.map((hop) => ({ ...hop, epoch: 8 })),
          },
        ],
        4,
        9,
        2,
      ),
    ).toThrow('reset or regressed');
    expect(() =>
      combineDirectRedrawObservationSegments(
        [
          first,
          {
            ...second,
            directHopCounters: second.directHopCounters.map((hop) => ({
              ...hop,
              upstreamForwarded: 3,
            })),
          },
        ],
        4,
        9,
        2,
      ),
    ).toThrow('traffic is underpopulated');
  });

  test('closes the final non-atomic two-hop cut without requiring new tail traffic', () => {
    const prior = segment(0, 0, 10, 20, 30, 0).directHopCounters;
    const current = prior.map((hop, index) => ({
      ...hop,
      upstreamForwarded: hop.upstreamForwarded + index,
      downstreamForwarded: hop.downstreamForwarded + index + 1,
    }));
    expect(directRedrawCumulativeHopDeltas(prior, current)).toEqual([
      { upstream: 0, downstream: 1 },
      { upstream: 1, downstream: 2 },
    ]);
    expect(() => directRedrawCumulativeHopDeltas(prior, current.slice(1))).toThrow(
      'cumulative hop cut is incomplete',
    );
    expect(() =>
      directRedrawCumulativeHopDeltas(
        prior,
        current.map((hop) => ({ ...hop, epoch: hop.epoch + 1 })),
      ),
    ).toThrow('reset or regressed');
  });

  test('rejects session, observation, input, and ordinal discontinuity', () => {
    const first = segment(0, 0, 10, 20, 30, 0);
    const second = segment(1, 2, 12, 50, 31, 0);
    const changedSession = second.ringBoundaries.map((boundary) => ({
      ...boundary,
      sessionEpoch: 10,
    }));
    expect(() =>
      combineDirectRedrawObservationSegments(
        [first, { ...second, ringBoundaries: changedSession }],
        4,
        9,
        2,
      ),
    ).toThrow('invalid ring lineage');

    const skippedEpoch = second.ringBoundaries.map((boundary) => ({
      ...boundary,
      observationEpoch: 32,
    }));
    expect(() =>
      combineDirectRedrawObservationSegments(
        [first, { ...second, ringBoundaries: skippedEpoch }],
        4,
        9,
        2,
      ),
    ).toThrow('observation epoch sequence is not contiguous');

    const windows = second.inputPopulation.windows.map((window, index) =>
      index === 0 ? { ...window, inputSeq: 99 } : window,
    );
    expect(() =>
      combineDirectRedrawObservationSegments(
        [first, { ...second, inputPopulation: { ...second.inputPopulation, windows } }],
        4,
        9,
        2,
      ),
    ).toThrow('input sequence is not contiguous');

    expect(() =>
      combineDirectRedrawObservationSegments(
        [first, { ...second, firstSampleOrdinal: 3 }],
        4,
        9,
        2,
      ),
    ).toThrow('non-contiguous ordinal range');
  });

  test('rejects a missing pair or duplicate durable artifact identity', () => {
    const first = segment(0, 0, 10, 20, 30, 0);
    const second = segment(1, 2, 12, 50, 31, 0);
    expect(() =>
      combineDirectRedrawObservationSegments(
        [first, { ...second, ringBoundaries: second.ringBoundaries.slice(1) }],
        4,
        9,
        2,
      ),
    ).toThrow('incomplete ring boundaries');
    expect(() =>
      combineDirectRedrawObservationSegments(
        [
          first,
          {
            ...second,
            artifacts: { ...second.artifacts, rawArtifact: first.artifacts.rawArtifact },
          },
        ],
        4,
        9,
        2,
      ),
    ).toThrow('missing or duplicate artifact');
  });

  test('rejects complete-labelled raw populations with a missing window or replay binding', () => {
    const original = segment(0, 0, 10, 20, 30, 0);
    expect(() =>
      combineDirectRedrawObservationSegments(
        [
          {
            ...original,
            metricSamples: {
              ...original.metricSamples,
              'presentation.rowsPerMeasurementWindow': [23],
            },
          },
        ],
        2,
        9,
        2,
      ),
    ).toThrow('presentation.rowsPerMeasurementWindow is not an exact 2-window raw population');
    expect(() =>
      combineDirectRedrawObservationSegments(
        [
          {
            ...original,
            artifacts: { ...original.artifacts, replayEventCount: 0 },
          },
        ],
        2,
        9,
        2,
      ),
    ).toThrow('invalid replay event count');
    expect(() =>
      combineDirectRedrawObservationSegments(
        [{ ...original, errors: ['recorder: retained trace lost one event'] }],
        2,
        9,
        2,
      ),
    ).toThrow('segment 0 is invalid: recorder: retained trace lost one event');
  });

  test('rejects nonfinite or negative raw samples before pooling', () => {
    const original = segment(0, 0, 10, 20, 30, 0);
    for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, -0.001]) {
      expect(() =>
        combineDirectRedrawObservationSegments(
          [
            {
              ...original,
              metricSamples: {
                ...original.metricSamples,
                'daemonPipeline.totalUs': [0, invalid],
              },
            },
          ],
          2,
          9,
          2,
        ),
      ).toThrow('daemonPipeline.totalUs contains an invalid raw sample');
    }
  });

  test('rejects mismatched or non-integral pooled frame populations', () => {
    const combined = combineDirectRedrawObservationSegments(
      [segment(0, 0, 10, 20, 30, 0)],
      2,
      9,
      2,
    );
    expect(() =>
      summarizeDirectSegmentedRedrawFramePhase(
        'bounded-cat',
        {
          ...combined,
          metricSamples: {
            ...combined.metricSamples,
            'mainThread.estimatedMissedFramesPerGap': [0],
          },
        },
        1,
      ),
    ).toThrow('pooled rAF overrun and estimated-miss populations differ');
    expect(() =>
      summarizeDirectSegmentedRedrawFramePhase(
        'bounded-cat',
        {
          ...combined,
          metricSamples: {
            ...combined.metricSamples,
            'mainThread.estimatedMissedFramesPerGap': [0, 0.5],
          },
        },
        1,
      ),
    ).toThrow('pooled estimated-miss population contains an invalid count');
    expect(() =>
      summarizeDirectSegmentedRedrawFramePhase(
        'bounded-cat',
        {
          ...combined,
          metricComplete: {
            ...combined.metricComplete,
            'mainThread.frameBudgetOverrunMs': false,
          },
        },
        1,
      ),
    ).toThrow('pooled rAF frame population is incomplete');
    expect(() =>
      summarizeDirectSegmentedRedrawFramePhase(
        'bounded-cat',
        {
          ...combined,
          metricComplete: {
            ...combined.metricComplete,
            'mainThread.estimatedMissedFramesPerGap': false,
          },
        },
        1,
      ),
    ).toThrow('pooled rAF frame population is incomplete');
  });
});

function segment(
  segmentIndex: number,
  firstSampleOrdinal: number,
  firstIdentity: number,
  firstAtMs: number,
  observationEpoch: number,
  ringDroppedTotal: number,
  sampleCount = 2,
): DirectRedrawObservationSegment {
  const windows = Array.from({ length: sampleCount }, (_, offset) => {
    const measurementId = advance(firstIdentity, offset);
    const inputSeq = advance(firstIdentity, offset);
    const startAtMs = firstAtMs + offset * 10;
    return { measurementId, startAtMs, endAtMs: startAtMs + 5, inputSeq };
  });
  return {
    segmentIndex,
    firstSampleOrdinal,
    sampleCount,
    inputPopulation: {
      windowCount: sampleCount,
      inputCount: sampleCount,
      inputBytesPerWindow: 1,
      windows,
    },
    ringBoundaries: windows.flatMap((window) => [
      {
        atMs: window.startAtMs,
        measurementId: window.measurementId,
        phase: 'start' as const,
        observationEpoch,
        sessionEpoch: 9,
        ringDroppedTotal,
      },
      {
        atMs: window.endAtMs,
        measurementId: window.measurementId,
        phase: 'end' as const,
        observationEpoch,
        sessionEpoch: 9,
        ringDroppedTotal,
      },
    ]),
    metricSamples: samples(segmentIndex, sampleCount),
    metricComplete: completeness(),
    directHopCounters: Array.from({ length: 2 }, () => ({
      epoch: 7,
      upstreamForwarded: firstSampleOrdinal + sampleCount,
      downstreamForwarded: firstSampleOrdinal + sampleCount,
    })),
    artifacts: {
      rawArtifact: `segment-${segmentIndex}.json.gz`,
      rawSha256: String(segmentIndex).padStart(64, '0'),
      reportArtifact: `segment-${segmentIndex}.json`,
      reportSha256: String(segmentIndex + 1).padStart(64, '0'),
      replayEventCount: 100 + segmentIndex,
      replayReportSha256: String(segmentIndex + 2).padStart(64, '0'),
      replayApplicationDisplayOutcomeSha256: String(segmentIndex + 3).padStart(64, '0'),
    },
    errors: [],
  };
}

function samples(value: number, sampleCount: number): TerminalLatencyRawMetricSamples {
  const result = Object.fromEntries(
    TERMINAL_LATENCY_RAW_METRIC_NAMES.map((name) => [name, [] as number[]]),
  ) as Record<TerminalLatencyRawMetricName, number[]>;
  for (const name of TERMINAL_LATENCY_RAW_METRIC_NAMES) {
    result[name] = Array<number>(
      name === 'displayPipeline.ringRefusedFrameCountBetweenMeasurementWindows'
        ? sampleCount - 1
        : sampleCount,
    ).fill(value);
  }
  return result;
}

function completeness(
  overrides: Partial<Record<TerminalLatencyRawMetricName, boolean>> = {},
): Readonly<Record<TerminalLatencyRawMetricName, boolean>> {
  return Object.fromEntries(
    TERMINAL_LATENCY_RAW_METRIC_NAMES.map((name) => [name, overrides[name] ?? true]),
  ) as Readonly<Record<TerminalLatencyRawMetricName, boolean>>;
}

function advance(value: number, count: number): number {
  let current = value;
  for (let index = 0; index < count; index += 1)
    current = current === 0xffff_ffff ? 1 : current + 1;
  return current;
}
