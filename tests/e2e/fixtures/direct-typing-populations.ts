import type {
  TerminalLatencyPercentiles,
  TerminalLatencySample,
  TerminalPerfEvent,
} from '../../../apps/web/src/perf/terminal-latency';
import { summarizeDirectPredictionLead } from './direct-prediction-lead';
import { referenceDistribution } from './terminal-redraw-reference';

export const DIRECT_TYPING_CYCLE_COUNT = 6;
export const DIRECT_TYPING_PRINTABLES_PER_CYCLE = 20;
export const DIRECT_TYPING_BACKSPACES_PER_CYCLE = 20;
export const DIRECT_TYPING_INPUTS_PER_CLASS =
  DIRECT_TYPING_CYCLE_COUNT * DIRECT_TYPING_PRINTABLES_PER_CYCLE;
export const DIRECT_TYPING_INPUT_COUNT = DIRECT_TYPING_INPUTS_PER_CLASS * 2;

export type DirectTypingInputClass = 'printable' | 'backspace';

export interface DirectTypingOrdinalPatternRange {
  readonly cycle: number;
  readonly inputClass: DirectTypingInputClass;
  readonly firstOrdinal: number;
  readonly endOrdinal: number;
}

export const DIRECT_TYPING_ORDINAL_PATTERN: readonly DirectTypingOrdinalPatternRange[] =
  Object.freeze(
    Array.from({ length: DIRECT_TYPING_CYCLE_COUNT }, (_, cycle) => {
      const cycleStart =
        cycle * (DIRECT_TYPING_PRINTABLES_PER_CYCLE + DIRECT_TYPING_BACKSPACES_PER_CYCLE);
      return [
        {
          cycle,
          inputClass: 'printable' as const,
          firstOrdinal: cycleStart,
          endOrdinal: cycleStart + DIRECT_TYPING_PRINTABLES_PER_CYCLE,
        },
        {
          cycle,
          inputClass: 'backspace' as const,
          firstOrdinal: cycleStart + DIRECT_TYPING_PRINTABLES_PER_CYCLE,
          endOrdinal:
            cycleStart + DIRECT_TYPING_PRINTABLES_PER_CYCLE + DIRECT_TYPING_BACKSPACES_PER_CYCLE,
        },
      ];
    }).flat(),
  );

export const DIRECT_TYPING_METRIC_NAMES = [
  'physicalInputToAdmissionMs',
  'admissionToInputSentMs',
  'inputSentToAckMs',
  'inputAckNetworkRttFloorMs',
  'inputAckMs',
  'inputToDisplayReceiveMs',
  'inputToAuthoritativeVisualFenceMs',
  'inputToPredictionSubmissionMs',
] as const satisfies readonly (keyof TerminalLatencySample)[];

export type DirectTypingMetricName = (typeof DIRECT_TYPING_METRIC_NAMES)[number];

export interface DirectTypingOrdinalRange {
  readonly cycle: number;
  readonly inputClass: DirectTypingInputClass;
  /** Zero-based inclusive ordinal in the phase's raw input_queued stream. */
  readonly firstOrdinal: number;
  /** Zero-based exclusive ordinal in the phase's raw input_queued stream. */
  readonly endOrdinal: number;
  readonly firstInputSeq: number;
  readonly lastInputSeq: number;
}

export interface DirectTypingMetricSummary extends TerminalLatencyPercentiles {
  /** Non-null exact-input samples divided by this class's 120 admitted inputs. */
  readonly inputCoverageRatio: number;
}

export interface DirectTypingPredictionSummary extends DirectTypingMetricSummary {
  /** Distinct exact model-admission (`prediction_applied`) sequences in this class. */
  readonly modelAcceptedCount: number;
  /** GPU-fenced exact prediction samples divided by modelAcceptedCount. */
  readonly modelAcceptedFenceCoverageRatio: number | null;
}

export interface DirectTypingClassSummary {
  readonly inputClass: DirectTypingInputClass;
  readonly inputCount: number;
  readonly metrics: Readonly<Record<DirectTypingMetricName, DirectTypingMetricSummary>>;
  readonly inputToPredictionPaintMs: DirectTypingPredictionSummary;
  readonly predictionFenceLead: ReturnType<typeof summarizeDirectPredictionLead>;
}

export interface DirectTypingPopulationSummary {
  readonly pattern: {
    readonly cycleCount: number;
    readonly printablesPerCycle: number;
    readonly backspacesPerCycle: number;
    readonly totalInputCount: number;
  };
  readonly ordinalRanges: readonly DirectTypingOrdinalRange[];
  readonly printable: DirectTypingClassSummary;
  readonly backspace: DirectTypingClassSummary;
}

export type DirectTypingParentCompleteness = Readonly<
  Record<DirectTypingMetricName | 'inputToPredictionPaintMs', boolean>
>;

/**
 * Reconstruct the two homogeneous direct-typing populations from the exact raw
 * input stream and its explicit six-cycle ordinal contract.
 *
 * This never classifies by elapsed time or by an input-sequence modulo. The
 * range table below is the workload metadata: every raw ordinal must be owned
 * exactly once, and the corresponding replayed analyzer sample must retain the
 * same input identity. Prediction eligibility comes only from exact
 * `prediction_applied` events; an aggregate report count cannot fill a class.
 */
export function summarizeDirectTypingPopulations(
  samples: readonly TerminalLatencySample[],
  events: readonly TerminalPerfEvent[],
  parentComplete: DirectTypingParentCompleteness,
  ordinalPattern: readonly DirectTypingOrdinalPatternRange[],
): DirectTypingPopulationSummary {
  if (samples.length !== DIRECT_TYPING_INPUT_COUNT) {
    throw new Error(
      `direct typing report retained ${samples.length} samples; expected ${DIRECT_TYPING_INPUT_COUNT}`,
    );
  }

  const rawInputs = events
    .map((event, eventOrdinal) => ({ event, eventOrdinal }))
    .filter(
      (
        entry,
      ): entry is {
        event: Extract<TerminalPerfEvent, { kind: 'input_queued' }>;
        eventOrdinal: number;
      } => entry.event.kind === 'input_queued',
    )
    .sort(
      (left, right) => left.event.atMs - right.event.atMs || left.eventOrdinal - right.eventOrdinal,
    );
  if (rawInputs.length !== DIRECT_TYPING_INPUT_COUNT) {
    throw new Error(
      `direct typing trace retained ${rawInputs.length} input_queued events; expected ${DIRECT_TYPING_INPUT_COUNT}`,
    );
  }

  const inputBySeq = new Map<number, Extract<TerminalPerfEvent, { kind: 'input_queued' }>>();
  for (let ordinal = 0; ordinal < rawInputs.length; ordinal += 1) {
    const input = rawInputs[ordinal]?.event;
    const sample = samples[ordinal];
    if (input === undefined || sample === undefined) {
      throw new Error(`direct typing ordinal ${ordinal} is missing`);
    }
    if (input.byteLength !== 1) {
      throw new Error(
        `direct typing ordinal ${ordinal} carried ${input.byteLength} bytes; expected 1`,
      );
    }
    if (inputBySeq.has(input.inputSeq)) {
      throw new Error(`direct typing input sequence ${input.inputSeq} is duplicated`);
    }
    if (sample.inputSeq !== input.inputSeq) {
      throw new Error(
        `direct typing ordinal ${ordinal} report/raw identity mismatch: ${sample.inputSeq}/${input.inputSeq}`,
      );
    }
    const previous = rawInputs[ordinal - 1]?.event.inputSeq;
    if (previous !== undefined && input.inputSeq !== nextInputSequence(previous)) {
      throw new Error(
        `direct typing input order is not contiguous at ordinal ${ordinal}: ${previous} -> ${input.inputSeq}`,
      );
    }
    inputBySeq.set(input.inputSeq, input);
  }

  const ordinalOwners = new Int8Array(DIRECT_TYPING_INPUT_COUNT);
  const cycleClassOwners = new Int8Array(DIRECT_TYPING_CYCLE_COUNT * 2);
  const printableSamples: TerminalLatencySample[] = [];
  const backspaceSamples: TerminalLatencySample[] = [];
  const ordinalRanges: DirectTypingOrdinalRange[] = [];
  for (const range of ordinalPattern) {
    const classOffset = range.inputClass === 'printable' ? 0 : 1;
    const expectedFirst =
      range.cycle * (DIRECT_TYPING_PRINTABLES_PER_CYCLE + DIRECT_TYPING_BACKSPACES_PER_CYCLE) +
      (range.inputClass === 'backspace' ? DIRECT_TYPING_PRINTABLES_PER_CYCLE : 0);
    const expectedCount =
      range.inputClass === 'printable'
        ? DIRECT_TYPING_PRINTABLES_PER_CYCLE
        : DIRECT_TYPING_BACKSPACES_PER_CYCLE;
    if (
      !Number.isSafeInteger(range.cycle) ||
      range.cycle < 0 ||
      range.cycle >= DIRECT_TYPING_CYCLE_COUNT ||
      (range.inputClass !== 'printable' && range.inputClass !== 'backspace') ||
      !Number.isSafeInteger(range.firstOrdinal) ||
      !Number.isSafeInteger(range.endOrdinal) ||
      range.firstOrdinal < 0 ||
      range.endOrdinal <= range.firstOrdinal ||
      range.endOrdinal > DIRECT_TYPING_INPUT_COUNT ||
      range.firstOrdinal !== expectedFirst ||
      range.endOrdinal !== expectedFirst + expectedCount ||
      cycleClassOwners[range.cycle * 2 + classOffset] !== 0
    ) {
      throw new Error('direct typing ordinal range metadata is invalid');
    }
    cycleClassOwners[range.cycle * 2 + classOffset] = 1;
    assignRange(
      range.inputClass,
      range.cycle,
      range.firstOrdinal,
      range.endOrdinal - range.firstOrdinal,
    );
  }
  for (let ordinal = 0; ordinal < ordinalOwners.length; ordinal += 1) {
    if (ordinalOwners[ordinal] !== 1) {
      throw new Error(`direct typing ordinal ${ordinal} is not owned by exactly one class range`);
    }
  }
  if (cycleClassOwners.some((owner) => owner !== 1)) {
    throw new Error('direct typing ordinal metadata omitted a cycle/class range');
  }
  if (
    printableSamples.length !== DIRECT_TYPING_INPUTS_PER_CLASS ||
    backspaceSamples.length !== DIRECT_TYPING_INPUTS_PER_CLASS
  ) {
    throw new Error('direct typing class ranges did not produce 120 inputs per class');
  }

  const predictionApplied = new Set<number>();
  for (const event of events) {
    if (event.kind !== 'prediction_applied') continue;
    const input = inputBySeq.get(event.inputSeq);
    if (input === undefined) {
      throw new Error(
        `prediction_applied sequence ${event.inputSeq} is outside the direct typing phase`,
      );
    }
    if (!Number.isFinite(event.atMs) || event.atMs < input.atMs) {
      throw new Error(`prediction_applied sequence ${event.inputSeq} has invalid causal timing`);
    }
    // The analyzer is earliest-wins for duplicate diagnostic delivery. Class
    // eligibility is likewise an input identity set, never an event count.
    predictionApplied.add(event.inputSeq);
  }

  return {
    pattern: {
      cycleCount: DIRECT_TYPING_CYCLE_COUNT,
      printablesPerCycle: DIRECT_TYPING_PRINTABLES_PER_CYCLE,
      backspacesPerCycle: DIRECT_TYPING_BACKSPACES_PER_CYCLE,
      totalInputCount: DIRECT_TYPING_INPUT_COUNT,
    },
    ordinalRanges,
    printable: summarizeClass('printable', printableSamples),
    backspace: summarizeClass('backspace', backspaceSamples),
  };

  function assignRange(
    inputClass: DirectTypingInputClass,
    cycle: number,
    firstOrdinal: number,
    count: number,
  ): void {
    const endOrdinal = firstOrdinal + count;
    const first = samples[firstOrdinal];
    const last = samples[endOrdinal - 1];
    if (first === undefined || last === undefined) {
      throw new Error(`direct typing ${inputClass} range ${cycle} exceeds the retained samples`);
    }
    for (let ordinal = firstOrdinal; ordinal < endOrdinal; ordinal += 1) {
      if (ordinalOwners[ordinal] !== 0) {
        throw new Error(`direct typing ordinal ${ordinal} belongs to overlapping class ranges`);
      }
      ordinalOwners[ordinal] = 1;
      const sample = samples[ordinal];
      if (sample === undefined) throw new Error(`direct typing ordinal ${ordinal} is missing`);
      (inputClass === 'printable' ? printableSamples : backspaceSamples).push(sample);
    }
    ordinalRanges.push({
      cycle,
      inputClass,
      firstOrdinal,
      endOrdinal,
      firstInputSeq: first.inputSeq,
      lastInputSeq: last.inputSeq,
    });
  }

  function summarizeClass(
    inputClass: DirectTypingInputClass,
    classSamples: readonly TerminalLatencySample[],
  ): DirectTypingClassSummary {
    const metrics = Object.fromEntries(
      DIRECT_TYPING_METRIC_NAMES.map((name) => [
        name,
        summarizeMetric(classSamples, name, parentComplete[name]),
      ]),
    ) as Readonly<Record<DirectTypingMetricName, DirectTypingMetricSummary>>;
    const eligible = new Set(
      classSamples
        .map((sample) => sample.inputSeq)
        .filter((inputSeq) => predictionApplied.has(inputSeq)),
    );
    const prediction = summarizeMetric(
      classSamples,
      'inputToPredictionPaintMs',
      parentComplete.inputToPredictionPaintMs,
    );
    for (const sample of classSamples) {
      if (sample.inputToPredictionPaintMs !== null && !eligible.has(sample.inputSeq)) {
        throw new Error(
          `direct typing ${inputClass} sequence ${sample.inputSeq} has a prediction fence without prediction_applied eligibility`,
        );
      }
    }
    return {
      inputClass,
      inputCount: classSamples.length,
      metrics,
      inputToPredictionPaintMs: {
        ...prediction,
        modelAcceptedCount: eligible.size,
        modelAcceptedFenceCoverageRatio:
          eligible.size === 0 ? null : prediction.count / eligible.size,
      },
      predictionFenceLead: summarizeDirectPredictionLead(classSamples, {
        prediction: parentComplete.inputToPredictionPaintMs,
        authoritative: parentComplete.inputToAuthoritativeVisualFenceMs,
      }),
    };
  }
}

function summarizeMetric(
  samples: readonly TerminalLatencySample[],
  name: DirectTypingMetricName | 'inputToPredictionPaintMs',
  complete: boolean,
): DirectTypingMetricSummary {
  const distribution = referenceDistribution(
    samples
      .map((sample) => sample[name])
      .filter((value): value is number => value !== null && Number.isFinite(value)),
  );
  return {
    ...distribution,
    complete,
    inputCoverageRatio: distribution.count / samples.length,
  };
}

function nextInputSequence(inputSeq: number): number {
  if (!Number.isSafeInteger(inputSeq) || inputSeq <= 0 || inputSeq > 0xffff_ffff) {
    throw new Error(`direct typing input sequence ${inputSeq} is invalid`);
  }
  return inputSeq === 0xffff_ffff ? 1 : inputSeq + 1;
}
