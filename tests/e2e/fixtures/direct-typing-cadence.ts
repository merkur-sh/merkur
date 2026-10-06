import type {
  TerminalLatencySample,
  TerminalPerfEvent,
} from '../../../apps/web/src/perf/terminal-latency';
import {
  DIRECT_TYPING_INPUT_COUNT,
  DIRECT_TYPING_ORDINAL_PATTERN,
  type DirectTypingOrdinalRange,
} from './direct-typing-populations';
import { referenceDistribution } from './terminal-redraw-reference';

const ENDPOINTS = [
  'physicalInputToAdmissionMs',
  'inputAckMs',
  'inputToDisplayReceiveMs',
  'inputToDisplayApplyMs',
  'inputToDisplayPaintMs',
  'inputToPredictionSubmissionMs',
  'inputToPredictionPaintMs',
  'inputToAuthoritativeVisualFenceMs',
] as const satisfies readonly (keyof TerminalLatencySample)[];

const STAGES = [
  'admissionToInputSentMs',
  'inputAckNonNetworkUpperBoundMs',
  'displayReceiveToWorkerQueueMs',
  'workerQueueToDisplayApplyMs',
  'displayApplyToRenderWantedMs',
  'displayApplyToRenderStartMs',
  'renderFenceGateMs',
  'renderOpportunityGateMs',
  'renderStartToRenderEndMs',
  'renderEndToDisplayPaintMs',
  'fenceObservationIntervalMs',
] as const satisfies readonly (keyof TerminalLatencySample)[];

/**
 * Cold-path diagnostic after class validation. The caller separately attempts
 * raw replay; failed parent evidence never becomes valid through this summary.
 * Latency growth between adjacent keys is output-gap minus actual input-gap.
 * Constant RTT therefore contributes zero growth; a delayed key followed by a
 * catch-up remains visible instead of disappearing into a pooled percentile.
 * No text is retained, and no endpoint is called a physical paint. Equal endpoint
 * timestamps do not establish shared render identity or transport batching.
 */
export function summarizeDirectTypingCadence(
  samples: readonly TerminalLatencySample[],
  events: readonly TerminalPerfEvent[],
  ranges: readonly DirectTypingOrdinalRange[],
  refreshPeriodMs: number,
) {
  if (!Number.isFinite(refreshPeriodMs) || refreshPeriodMs <= 0) {
    throw new Error('typing cadence requires an independently calibrated refresh period');
  }
  const inputs = events.filter((event) => event.kind === 'input_queued');
  if (inputs.length !== DIRECT_TYPING_INPUT_COUNT || samples.length !== inputs.length) {
    throw new Error('typing cadence requires the complete bounded 240-input population');
  }
  const identities = new Set<number>();
  const rows = inputs.map((input, ordinal) => {
    const sample = samples[ordinal];
    if (
      sample === undefined ||
      sample.inputSeq !== input.inputSeq ||
      !Number.isSafeInteger(input.inputSeq) ||
      input.inputSeq <= 0 ||
      input.inputSeq > 0xffff_ffff ||
      identities.has(input.inputSeq) ||
      !Number.isFinite(input.atMs) ||
      input.atMs < 0 ||
      input.atMs < (inputs[ordinal - 1]?.atMs ?? 0)
    )
      throw new Error(`invalid typing cadence identity/timing at ordinal ${ordinal}`);
    identities.add(input.inputSeq);
    const previousSeq = inputs[ordinal - 1]?.inputSeq;
    if (
      previousSeq !== undefined &&
      input.inputSeq !== (previousSeq === 0xffff_ffff ? 1 : previousSeq + 1)
    ) {
      throw new Error('typing cadence input sequences are not contiguous');
    }
    for (const metric of [...ENDPOINTS, ...STAGES]) {
      const value = sample[metric];
      if (value !== null && (!Number.isFinite(value) || value < 0)) {
        throw new Error(`invalid typing cadence endpoint ${metric} at ordinal ${ordinal}`);
      }
    }
    return { ordinal, inputAtMs: input.atMs, ...sample };
  });
  const owners = new Uint8Array(inputs.length);
  if (ranges.length !== DIRECT_TYPING_ORDINAL_PATTERN.length)
    throw new Error('missing typing cadence ranges');
  for (const range of ranges) {
    const expected = DIRECT_TYPING_ORDINAL_PATTERN.find(
      (entry) => entry.cycle === range.cycle && entry.inputClass === range.inputClass,
    );
    if (
      expected === undefined ||
      expected.firstOrdinal !== range.firstOrdinal ||
      expected.endOrdinal !== range.endOrdinal ||
      !Number.isSafeInteger(range.firstOrdinal) ||
      !Number.isSafeInteger(range.endOrdinal) ||
      range.firstOrdinal < 0 ||
      range.endOrdinal <= range.firstOrdinal ||
      range.endOrdinal > rows.length ||
      rows[range.firstOrdinal]?.inputSeq !== range.firstInputSeq ||
      rows[range.endOrdinal - 1]?.inputSeq !== range.lastInputSeq
    )
      throw new Error('invalid typing cadence ordinal range');
    for (let ordinal = range.firstOrdinal; ordinal < range.endOrdinal; ordinal += 1) {
      if (owners[ordinal] !== 0) throw new Error('overlapping typing cadence ranges');
      owners[ordinal] = 1;
    }
  }
  if (owners.some((owner) => owner !== 1)) throw new Error('missing typing cadence range');

  const populations = (['printable', 'backspace'] as const).map((inputClass) => {
    const classRanges = ranges.filter((range) => range.inputClass === inputClass);
    const classRows = classRanges.flatMap((range) =>
      rows.slice(range.firstOrdinal, range.endOrdinal),
    );
    const endpoints = ENDPOINTS.map((metric) => {
      const pairs: {
        previousOrdinal: number;
        ordinal: number;
        previousInputSeq: number;
        inputSeq: number;
        inputGapMs: number;
        endpointGapMs: number;
        latencyGrowthMs: number;
      }[] = [];
      let missingPairCount = 0;
      for (const range of classRanges) {
        for (let ordinal = range.firstOrdinal + 1; ordinal < range.endOrdinal; ordinal += 1) {
          const previous = rows[ordinal - 1];
          const current = rows[ordinal];
          if (previous === undefined || current === undefined)
            throw new Error('missing cadence row');
          const before = previous[metric];
          const after = current[metric];
          // Do not bridge missing prediction/authority or different edit cycles.
          if (before === null || after === null) {
            missingPairCount += 1;
            continue;
          }
          const inputGapMs = current.inputAtMs - previous.inputAtMs;
          const latencyGrowthMs = after - before;
          pairs.push({
            previousOrdinal: ordinal - 1,
            ordinal,
            previousInputSeq: previous.inputSeq,
            inputSeq: current.inputSeq,
            inputGapMs,
            endpointGapMs: inputGapMs + latencyGrowthMs,
            latencyGrowthMs,
          });
        }
      }
      const latencies = classRows.flatMap((row) => (row[metric] === null ? [] : [row[metric]]));
      return {
        metric,
        inputCount: classRows.length,
        observedInputCount: latencies.length,
        missingInputCount: classRows.length - latencies.length,
        missingPairCount,
        latencyMs: referenceDistribution(latencies),
        endpointGapMs: referenceDistribution(pairs.map((pair) => pair.endpointGapMs)),
        latencyGrowthMs: referenceDistribution(pairs.map((pair) => pair.latencyGrowthMs)),
        extraRefreshIntervalCount: pairs.filter((pair) => pair.latencyGrowthMs > refreshPeriodMs)
          .length,
        catchUpIntervalCount: pairs.filter((pair) => pair.latencyGrowthMs < -refreshPeriodMs)
          .length,
        equalEndpointCount: pairs.filter((pair) => pair.endpointGapMs === 0).length,
        reversedEndpointCount: pairs.filter((pair) => pair.endpointGapMs < 0).length,
        pairs,
      };
    });
    const inputGaps = classRanges.flatMap((range) =>
      rows.slice(range.firstOrdinal + 1, range.endOrdinal).map((row) => {
        const previous = rows[row.ordinal - 1];
        if (previous === undefined) throw new Error('missing cadence predecessor');
        return row.inputAtMs - previous.inputAtMs;
      }),
    );
    const stages = STAGES.map((metric) => {
      const values = classRows.flatMap((row) => (row[metric] === null ? [] : [row[metric]]));
      return {
        metric,
        observedInputCount: values.length,
        unobservedOrNotApplicableInputCount: classRows.length - values.length,
        durationMs: referenceDistribution(values),
      };
    });
    return {
      inputClass,
      inputCount: classRows.length,
      inputGapMs: referenceDistribution(inputGaps),
      endpoints,
      stages,
    };
  });
  return {
    schemaVersion: 1,
    boundary: 'browser-input to recorded software endpoints; not compositor visibility or photons',
    stageOwnership:
      'Render stages belong to inputToDisplayPaintMs, not necessarily inputToAuthoritativeVisualFenceMs. Different header/geometry renders require exact renderSeq joins before attribution. Null gate durations can mean an immediate, ungated render, not missing telemetry.',
    interpretation:
      'Diagnostic only. Adjacent same-class same-cycle pairs; no gap bridging. Positive latency growth is extra spacing beyond actual input cadence. Equal timestamps do not prove batching. Missing endpoints and parent capture failures remain missing/ineligible.',
    refreshPeriodMs,
    populations,
    rows,
  };
}
