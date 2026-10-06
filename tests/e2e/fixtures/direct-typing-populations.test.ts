import { describe, expect, test } from 'bun:test';
import type {
  TerminalLatencySample,
  TerminalPerfEvent,
} from '../../../apps/web/src/perf/terminal-latency';
import {
  DIRECT_TYPING_INPUT_COUNT,
  DIRECT_TYPING_INPUTS_PER_CLASS,
  DIRECT_TYPING_ORDINAL_PATTERN,
  type DirectTypingOrdinalPatternRange,
  type DirectTypingParentCompleteness,
  summarizeDirectTypingPopulations,
} from './direct-typing-populations';

const COMPLETE: DirectTypingParentCompleteness = {
  physicalInputToAdmissionMs: true,
  admissionToInputSentMs: true,
  inputSentToAckMs: true,
  inputAckNetworkRttFloorMs: true,
  inputAckMs: true,
  inputToDisplayReceiveMs: true,
  inputToAuthoritativeVisualFenceMs: true,
  inputToPredictionSubmissionMs: true,
  inputToPredictionPaintMs: true,
};

describe('direct typing population reconstruction', () => {
  test('replays six explicit 20-printable/20-Backspace ranges as two exact populations', () => {
    const trace = makeTrace({ startInputSeq: 0xffff_ff80 });
    const summary = summarizeDirectTypingPopulations(
      trace.samples,
      trace.events,
      COMPLETE,
      DIRECT_TYPING_ORDINAL_PATTERN,
    );

    expect(summary.pattern).toEqual({
      cycleCount: 6,
      printablesPerCycle: 20,
      backspacesPerCycle: 20,
      totalInputCount: 240,
    });
    expect(summary.ordinalRanges).toHaveLength(12);
    expect(summary.ordinalRanges[0]).toEqual({
      cycle: 0,
      inputClass: 'printable',
      firstOrdinal: 0,
      endOrdinal: 20,
      firstInputSeq: 0xffff_ff80,
      lastInputSeq: 0xffff_ff93,
    });
    expect(summary.ordinalRanges[1]).toEqual({
      cycle: 0,
      inputClass: 'backspace',
      firstOrdinal: 20,
      endOrdinal: 40,
      firstInputSeq: 0xffff_ff94,
      lastInputSeq: 0xffff_ffa7,
    });
    expect(summary.printable.inputCount).toBe(DIRECT_TYPING_INPUTS_PER_CLASS);
    expect(summary.backspace.inputCount).toBe(DIRECT_TYPING_INPUTS_PER_CLASS);
    expect(summary.printable.metrics.inputAckMs.count).toBe(120);
    expect(summary.backspace.metrics.inputAckMs.count).toBe(120);
    expect(summary.printable.inputToPredictionPaintMs).toMatchObject({
      count: 120,
      modelAcceptedCount: 120,
      modelAcceptedFenceCoverageRatio: 1,
      inputCoverageRatio: 1,
      complete: true,
    });
    expect(summary.backspace.inputToPredictionPaintMs).toMatchObject({
      count: 120,
      modelAcceptedCount: 120,
      modelAcceptedFenceCoverageRatio: 1,
      inputCoverageRatio: 1,
      complete: true,
    });
    expect(summary.printable.predictionFenceLead).toMatchObject({
      inputCount: 120,
      pairedCount: 120,
      complete: true,
    });
  });

  test('keeps class censoring and exact prediction eligibility out of pooled aggregates', () => {
    const trace = makeTrace({
      includePrediction: (ordinal) => inputClass(ordinal) === 'printable' || ordinal < 220,
      predictionPaint: (ordinal) =>
        inputClass(ordinal) === 'printable' || ordinal < 220 ? 3 : null,
      authoritativeFence: (ordinal) => (inputClass(ordinal) === 'printable' ? 4 : null),
      speculativePaint: (ordinal) => (inputClass(ordinal) === 'printable' ? 0.2 : null),
    });
    const summary = summarizeDirectTypingPopulations(
      trace.samples,
      trace.events,
      { ...COMPLETE, inputToDisplayReceiveMs: false },
      DIRECT_TYPING_ORDINAL_PATTERN,
    );

    expect(summary.printable.metrics.inputToAuthoritativeVisualFenceMs.count).toBe(120);
    expect(summary.printable.metrics.inputToAuthoritativeVisualFenceMs.p95).toBe(4);
    expect(summary.backspace.metrics.inputToAuthoritativeVisualFenceMs).toMatchObject({
      count: 0,
      p95: null,
      inputCoverageRatio: 0,
      complete: true,
    });
    expect(summary.backspace.predictionFenceLead).toMatchObject({
      inputCount: 120,
      pairedCount: 0,
      missingAuthorityCount: 120,
      complete: false,
    });
    expect(summary.printable.metrics.inputToPredictionSubmissionMs.count).toBe(120);
    expect(summary.backspace.metrics.inputToPredictionSubmissionMs.count).toBe(0);
    expect(summary.backspace.inputToPredictionPaintMs).toMatchObject({
      count: 100,
      modelAcceptedCount: 100,
      modelAcceptedFenceCoverageRatio: 1,
      inputCoverageRatio: 100 / 120,
    });
    expect(summary.printable.metrics.inputToDisplayReceiveMs.complete).toBe(false);
    expect(summary.backspace.metrics.inputToDisplayReceiveMs.complete).toBe(false);
    expect(summary.printable.metrics.inputAckMs.complete).toBe(true);
  });

  test('rejects duplicate, missing, misordered, or non-one-byte raw inputs', () => {
    const trace = makeTrace();
    const firstInputIndex = trace.events.findIndex((event) => event.kind === 'input_queued');
    const secondInputIndex = trace.events.findIndex(
      (event, index) => index > firstInputIndex && event.kind === 'input_queued',
    );
    const firstInput = trace.events[firstInputIndex];
    const secondInput = trace.events[secondInputIndex];
    if (firstInput?.kind !== 'input_queued' || secondInput?.kind !== 'input_queued') {
      throw new Error('test trace did not contain two inputs');
    }

    const duplicateEvents = trace.events.slice();
    duplicateEvents[secondInputIndex] = { ...secondInput, inputSeq: firstInput.inputSeq };
    const duplicateSamples = trace.samples.slice();
    duplicateSamples[1] = { ...must(duplicateSamples[1]), inputSeq: firstInput.inputSeq };
    expect(() => summarize(duplicateSamples, duplicateEvents)).toThrow('is duplicated');

    const mismatchedSamples = trace.samples.slice();
    mismatchedSamples[1] = { ...must(mismatchedSamples[1]), inputSeq: secondInput.inputSeq + 1 };
    expect(() => summarize(mismatchedSamples, trace.events)).toThrow(
      'report/raw identity mismatch',
    );

    const gappedEvents = trace.events.slice();
    gappedEvents[secondInputIndex] = { ...secondInput, inputSeq: secondInput.inputSeq + 1 };
    const gappedSamples = trace.samples.slice();
    gappedSamples[1] = { ...must(gappedSamples[1]), inputSeq: secondInput.inputSeq + 1 };
    expect(() => summarize(gappedSamples, gappedEvents)).toThrow('input order is not contiguous');

    const wideEvents = trace.events.slice();
    wideEvents[firstInputIndex] = { ...firstInput, byteLength: 2 };
    expect(() => summarize(trace.samples, wideEvents)).toThrow('carried 2 bytes; expected 1');

    expect(() => summarize(trace.samples.slice(1), trace.events)).toThrow('expected 240');
  });

  test('rejects class metadata with overlapping or unowned ordinals', () => {
    const trace = makeTrace();
    const overlapping: DirectTypingOrdinalPatternRange[] = [
      ...DIRECT_TYPING_ORDINAL_PATTERN,
      must(DIRECT_TYPING_ORDINAL_PATTERN[0]),
    ];
    expect(() =>
      summarizeDirectTypingPopulations(trace.samples, trace.events, COMPLETE, overlapping),
    ).toThrow('ordinal range metadata is invalid');
    expect(() =>
      summarizeDirectTypingPopulations(
        trace.samples,
        trace.events,
        COMPLETE,
        DIRECT_TYPING_ORDINAL_PATTERN.slice(1),
      ),
    ).toThrow('not owned by exactly one class range');
    const shifted = DIRECT_TYPING_ORDINAL_PATTERN.map((range, index) =>
      index === 0 ? { ...range, firstOrdinal: range.firstOrdinal + 1 } : range,
    );
    expect(() =>
      summarizeDirectTypingPopulations(trace.samples, trace.events, COMPLETE, shifted),
    ).toThrow('ordinal range metadata is invalid');
  });

  test('rejects a prediction fence without its exact prediction_applied eligibility event', () => {
    const trace = makeTrace({ includePrediction: () => false, predictionPaint: () => 2 });
    expect(() => summarize(trace.samples, trace.events)).toThrow(
      'has a prediction fence without prediction_applied eligibility',
    );
  });

  test('uses distinct prediction identities and rejects eligibility outside the phase', () => {
    const trace = makeTrace();
    const firstPrediction = trace.events.find((event) => event.kind === 'prediction_applied');
    if (firstPrediction?.kind !== 'prediction_applied') {
      throw new Error('test trace did not contain prediction eligibility');
    }
    const duplicate = summarize(trace.samples, [
      ...trace.events,
      { ...firstPrediction, atMs: firstPrediction.atMs + 1 },
    ]);
    expect(duplicate.printable.inputToPredictionPaintMs.modelAcceptedCount).toBe(120);
    expect(duplicate.backspace.inputToPredictionPaintMs.modelAcceptedCount).toBe(120);

    expect(() =>
      summarize(trace.samples, [
        ...trace.events,
        { kind: 'prediction_applied', atMs: 999, inputSeq: 999_999 },
      ]),
    ).toThrow('is outside the direct typing phase');
  });
});

interface TraceOptions {
  readonly startInputSeq?: number;
  readonly includePrediction?: (ordinal: number) => boolean;
  readonly predictionPaint?: (ordinal: number) => number | null;
  readonly authoritativeFence?: (ordinal: number) => number | null;
  readonly speculativePaint?: (ordinal: number) => number | null;
}

function makeTrace(options: TraceOptions = {}): {
  readonly samples: TerminalLatencySample[];
  readonly events: TerminalPerfEvent[];
} {
  const startInputSeq = options.startInputSeq ?? 1_001;
  const samples: TerminalLatencySample[] = [];
  const events: TerminalPerfEvent[] = [];
  for (let ordinal = 0; ordinal < DIRECT_TYPING_INPUT_COUNT; ordinal += 1) {
    const inputSeq = wrappedInputSequence(startInputSeq, ordinal);
    const atMs = 10 + Math.floor(ordinal / 4);
    events.push({ kind: 'input_queued', atMs, admittedAtMs: atMs + 0.1, inputSeq, byteLength: 1 });
    if (options.includePrediction?.(ordinal) ?? true) {
      events.push({ kind: 'prediction_applied', atMs: atMs + 0.2, inputSeq });
    }
    samples.push(
      sample(
        inputSeq,
        ordinal,
        options.predictionPaint === undefined ? 3 : options.predictionPaint(ordinal),
        options.authoritativeFence === undefined ? 4 : options.authoritativeFence(ordinal),
        options.speculativePaint === undefined
          ? inputClass(ordinal) === 'printable'
            ? 0.2
            : null
          : options.speculativePaint(ordinal),
      ),
    );
  }
  return { samples, events };
}

function sample(
  inputSeq: number,
  ordinal: number,
  predictionPaint: number | null,
  authoritativeFence: number | null,
  speculativePaint: number | null,
): TerminalLatencySample {
  return {
    inputSeq,
    physicalInputToAdmissionMs: 0.1,
    touchToCommitMs: null,
    touchToPredictionSubmissionMs: null,
    inputToPredictionSubmissionMs: speculativePaint,
    inputToPredictionPaintMs: predictionPaint,
    admissionToInputSentMs: 0.2,
    inputSentToAckMs: 50 + ordinal / 1_000,
    inputAckNetworkRttFloorMs: 50,
    inputAckNonNetworkUpperBoundMs: 0.5,
    inputToDisplayReceiveMs: 51 + ordinal / 1_000,
    displayReceiveToWorkerQueueMs: 0.1,
    workerQueueToDisplayApplyMs: 0.1,
    inputToDisplayApplyMs: 52,
    inputToDisplayPaintMs: authoritativeFence,
    inputToAuthoritativeVisualFenceMs: authoritativeFence,
    inputToCompletedSenderPresentationFenceMs: authoritativeFence,
    inputToCompletedAuthoritativePresentationFenceMs: null,
    displayApplyToPaintMs: 1,
    displayApplyToRenderStartMs: 0.2,
    renderStartToRenderEndMs: 0.2,
    renderEndToDisplayPaintMs: 0.6,
    renderEndToLastUnreadyPollMs: 0.3,
    fenceObservationIntervalMs: 0.3,
    displayApplyToRenderWantedMs: 0.1,
    renderFenceGateMs: 0,
    renderOpportunityGateMs: 0,
    inputAckMs: 51 + ordinal / 1_000,
  };
}

function inputClass(ordinal: number): 'printable' | 'backspace' {
  const cycleOrdinal = ordinal % 40;
  return cycleOrdinal < 20 ? 'printable' : 'backspace';
}

function wrappedInputSequence(start: number, ordinal: number): number {
  return ((start - 1 + ordinal) % 0xffff_ffff) + 1;
}

function summarize(
  samples: readonly TerminalLatencySample[],
  events: readonly TerminalPerfEvent[],
) {
  return summarizeDirectTypingPopulations(samples, events, COMPLETE, DIRECT_TYPING_ORDINAL_PATTERN);
}

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected test value');
  return value;
}
