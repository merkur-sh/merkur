/**
 * Measurement-only intersection of release 60f039c7 and the current producer.
 * No production analyzer imports, synthesized transaction identities, or
 * telemetry backports: the complete raw dump remains the replay authority.
 */

import type { ProxyImpairmentStats } from '../../../scripts/edge-network-stats';
import { configuredProxyFaultEvidenceErrors } from '../../../scripts/edge-network-stats';
import {
  normalizeReferenceTerminalEvents,
  type ReferenceDisplayEvent,
  type ReferenceRedrawSample,
  type ReferenceTerminalEvent,
  referenceDistribution,
} from './terminal-redraw-reference';

export const DIRECT_REFERENCE_CONTRACT = {
  inputOrigin: 'browser input event, not physical switch actuation',
  prediction: 'exact rendered effect membership observed at a GPU fence, not panel photons',
  authority:
    'first GPU fence whose exact render start covers an applied cumulative input watermark; not proof that this individual key changed pixels',
  redraw:
    'row-bearing apply-to-render exposure proxy; identical retries can count, so this is not semantic partial-pixel exposure',
  frameTime: 'synchronous worker render_start to render_end; excludes GPU/compositor/panel time',
  network: 'carrier RTT floor reported on an input ACK; not synchronized one-way transit',
  daemon: 'native monotonic duration fields; never subtract daemon and browser clock origins',
  boundary: 'browser-epoch windows, no product observation reset or new profiling hooks',
} as const;

export const COMMON_DAEMON_STAGES = [
  'recvToPtyUs',
  'ptyToReadUs',
  'gridApplyUs',
  'displayCoalesceUs',
  'selectCaptureUs',
  'prepareQueueUs',
  'encodeUs',
  'compressionUs',
  'completionQueueUs',
  'transportSubmitUs',
] as const;

export interface DirectReferenceWindow {
  readonly startAtMs: number;
  /** End of keyboard dispatch, before the independently declared tail wait. */
  readonly inputEndAtMs: number;
  readonly endAtMs: number;
  /** First outside-window rAF marker; a later retained event fences the dump. */
  readonly proofAtMs: number;
  readonly expectedInputCount: number;
}

interface Input {
  readonly inputSeq: number;
  readonly atMs: number;
  readonly admittedAtMs: number;
  readonly byteLength: number;
}

export interface DirectReferenceInputSample extends Input {
  readonly ordinal: number;
  readonly inputClass: string;
  readonly browserOriginToAdmissionMs: number;
  readonly admissionToTransportSubmissionMs: number | null;
  readonly inputToAckMs: number | null;
  readonly ackCarrierRttFloorMs: number | null;
  readonly inputToCausalDisplayReceiveMs: number | null;
  readonly inputToCausalStateApplicationMs: number | null;
  readonly inputToAuthoritativeWatermarkGpuFenceMs: number | null;
  readonly inputToExactPredictionGpuFenceMs: number | null;
  readonly predictionAccepted: boolean;
  readonly authoritativeRenderSeq: number | null;
  readonly predictionRenderSeq: number | null;
}

const INPUT_METRICS = [
  'browserOriginToAdmissionMs',
  'admissionToTransportSubmissionMs',
  'inputToAckMs',
  'ackCarrierRttFloorMs',
  'inputToCausalDisplayReceiveMs',
  'inputToCausalStateApplicationMs',
  'inputToAuthoritativeWatermarkGpuFenceMs',
  'inputToExactPredictionGpuFenceMs',
] as const;

const EXACT_INPUT_METRICS = [
  'browserOriginToAdmissionMs',
  'admissionToTransportSubmissionMs',
  'inputToAckMs',
  'ackCarrierRttFloorMs',
] as const;

const CAUSAL_INPUT_METRICS = [
  'inputToCausalDisplayReceiveMs',
  'inputToCausalStateApplicationMs',
  'inputToAuthoritativeWatermarkGpuFenceMs',
] as const;

export interface DirectReferenceCoverageOptions {
  readonly mode: 'completeness-only' | 'latency';
  readonly expectedClassCounts: Readonly<Record<string, number>>;
  readonly minimumCausalSamplesPerClass: number;
  readonly targetRttMs: number;
  /** Full injected RTT jitter span plus explicit app-estimator quantization allowance. */
  readonly appRttToleranceMs: number;
}

export interface DirectReferenceNetworkOptions {
  readonly profile: string;
  readonly targetRttMs: number;
  readonly baseDelayUs: number;
  readonly jitterRadiusUs: number;
  readonly seed: number;
  readonly backendPort: number;
  readonly proxyPorts: readonly [number, number];
  readonly minimumDirectionalPackets: number;
  readonly dials: readonly string[];
  readonly workerSources: readonly {
    readonly url: string;
    readonly productionSha256: string;
    readonly patchedSha256: string;
  }[];
}

export interface DirectReferenceRedrawCoverage {
  readonly workload: string;
  readonly windowCount: number;
  readonly minimumRowsPerWindow: number;
  readonly observedMinimumRows: number;
  readonly appliedDisplayUnitCount: number;
  readonly appliedPayloadByteCount: number;
  readonly singletonWindowCount: number;
  readonly multiUnitWindowCount: number;
  readonly applicationTransactionCoherence: {
    readonly available: false;
    readonly reason: 'presentation transaction identity is not present in the cross-revision event intersection';
  };
}

/** A nonzero u32 watermark covers exactly one serial half-range. */
export function referenceSequenceCovers(watermark: number, inputSeq: number): boolean {
  return watermark !== 0 && (watermark - inputSeq) >>> 0 < 0x8000_0000;
}

export function analyzeDirectReferenceInputs(
  raw: readonly unknown[],
  window: DirectReferenceWindow,
  inputClasses: readonly string[],
) {
  if (
    !Number.isFinite(window.startAtMs) ||
    window.startAtMs > window.inputEndAtMs ||
    window.inputEndAtMs > window.endAtMs ||
    window.endAtMs > window.proofAtMs ||
    !Number.isFinite(window.proofAtMs)
  )
    throw new Error('invalid common observation window');
  const events = normalizeReferenceTerminalEvents(raw);
  const records = raw.filter(isRecord).sort((a, b) => finite(a.atMs) - finite(b.atMs));
  if (records.length === 0 || finite(records[0]?.atMs) > window.startAtMs) {
    throw new Error('common trace retention does not cover the observation start');
  }
  if (finite(records.at(-1)?.atMs) < window.proofAtMs) {
    throw new Error('common trace retention does not cover the outside-window proof cut');
  }
  const inputs: Input[] = [];
  const seen = new Set<number>();
  for (const event of records) {
    if (event.kind !== 'input_queued') continue;
    const atMs = finite(event.atMs);
    if (atMs < window.startAtMs || atMs > window.proofAtMs) continue;
    if (atMs > window.inputEndAtMs)
      throw new Error('unexpected terminal input during the tail wait');
    const inputSeq = positiveU32(event.inputSeq);
    if (seen.has(inputSeq)) throw new Error('duplicate input identity in common observation');
    seen.add(inputSeq);
    const admittedAtMs = finite(event.admittedAtMs);
    if (admittedAtMs < atMs) throw new Error('input admission precedes its browser origin');
    const byteLength = positiveU32(event.byteLength);
    if (byteLength !== 1) throw new Error('common workload input must be exactly one byte');
    inputs.push({ inputSeq, atMs, admittedAtMs, byteLength });
  }
  if (inputs.length !== window.expectedInputCount || inputClasses.length !== inputs.length) {
    throw new Error(
      `common observation owns ${inputs.length} inputs, expected ${window.expectedInputCount}`,
    );
  }
  for (let index = 1; index < inputs.length; index += 1) {
    const previous = inputs[index - 1];
    const current = inputs[index];
    if (previous === undefined || current === undefined) throw new Error('missing common input');
    const expected = previous.inputSeq === 0xffff_ffff ? 1 : previous.inputSeq + 1;
    if (current.inputSeq !== expected) {
      throw new Error('common workload input identities are not contiguous nonzero u32 values');
    }
  }
  const starts = uniqueRenderEvents(events, 'render_start');
  const ends = uniqueRenderEvents(events, 'render_end');
  const frames = uniqueRenderEvents(events, 'frame_complete');
  const gpuFrames = [...frames.values()].filter((frame) => {
    if (frame.atMs < window.startAtMs || frame.atMs > window.endAtMs) return false;
    const start = starts.get(frame.renderSeq);
    const end = ends.get(frame.renderSeq);
    if (
      start === undefined ||
      end === undefined ||
      start.atMs > end.atMs ||
      end.atMs > frame.atMs
    ) {
      throw new Error('GPU fence has no exact ordered render start/end ownership');
    }
    if (start.displayInputSeq !== frame.displayInputSeq)
      throw new Error('render watermark changed identity');
    if (frame.visiblePredictionInputSeqsTruncated)
      throw new Error('exact prediction membership truncated');
    return end.completionMode === 'gpu-queue';
  });
  const received = events.filter((e): e is ReferenceDisplayEvent => e.kind === 'display_received');
  const applied = events.filter(
    (e): e is ReferenceDisplayEvent => e.kind === 'worker_display_applied',
  );
  const belongsToWindowInput = (watermark: number): boolean =>
    inputs.some((input) => referenceSequenceCovers(watermark, input.inputSeq));
  for (const event of records) {
    const atMs = finite(event.atMs);
    if (atMs < window.startAtMs || atMs > window.proofAtMs) continue;
    if (event.kind === 'session_start') {
      throw new Error('common workload crossed a terminal session boundary');
    }
    if (
      event.kind === 'transport_state' &&
      (event.state === 'disconnected' || event.state === 'signaling_reconnecting')
    ) {
      throw new Error('common workload crossed a transport reconnect boundary');
    }
  }
  const causalReceived = received.filter(
    (event) =>
      event.atMs >= window.startAtMs &&
      event.atMs <= window.proofAtMs &&
      belongsToWindowInput(event.inputSeq),
  );
  const causalApplied = applied.filter(
    (event) =>
      event.atMs >= window.startAtMs &&
      event.atMs <= window.proofAtMs &&
      belongsToWindowInput(event.inputSeq),
  );
  if (causalReceived.some((event) => event.atMs > window.endAtMs)) {
    throw new Error('common workload has a causal display receipt after its tail boundary');
  }
  if (causalApplied.some((event) => event.atMs > window.endAtMs)) {
    throw new Error('common workload has a causal display apply after its tail boundary');
  }
  const causalGenerations = new Set(
    [...causalReceived, ...causalApplied].map((event) => positiveU32(event.generation)),
  );
  if (causalGenerations.size > 1) {
    throw new Error('common workload crossed a display generation boundary');
  }
  const displayIdentity = (event: ReferenceDisplayEvent): string =>
    `${event.generation}:${event.displaySeq}`;
  const receivedIdentities = new Set<string>();
  for (const event of causalReceived) {
    const identity = displayIdentity(event);
    if (receivedIdentities.has(identity)) {
      throw new Error('common workload contains a duplicate causal display receipt');
    }
    receivedIdentities.add(identity);
  }
  const appliedIdentities = new Set<string>();
  for (const event of causalApplied) {
    const identity = displayIdentity(event);
    if (appliedIdentities.has(identity)) {
      throw new Error('common workload contains a duplicate causal display apply');
    }
    if (!receivedIdentities.has(identity)) {
      throw new Error('common workload applied a display unit without its receipt');
    }
    appliedIdentities.add(identity);
  }
  for (const identity of receivedIdentities) {
    if (!appliedIdentities.has(identity)) {
      throw new Error('common workload received a display unit without applying it');
    }
  }
  const samples: DirectReferenceInputSample[] = inputs.map((input, ordinal) => {
    const sent = records.find(
      (e) =>
        e.kind === 'input_sent' &&
        e.inputSeq === input.inputSeq &&
        finite(e.atMs) >= input.admittedAtMs &&
        finite(e.atMs) <= window.endAtMs,
    );
    const ack = records.find(
      (e) =>
        e.kind === 'input_ack' &&
        referenceSequenceCovers(positiveU32(e.inputSeq), input.inputSeq) &&
        finite(e.atMs) >= input.atMs &&
        finite(e.atMs) <= window.endAtMs,
    );
    const receipt = received.find(
      (e) =>
        e.atMs >= input.atMs &&
        e.atMs <= window.endAtMs &&
        referenceSequenceCovers(e.inputSeq, input.inputSeq),
    );
    const apply = applied.find(
      (e) =>
        e.atMs >= input.atMs &&
        e.atMs <= window.endAtMs &&
        referenceSequenceCovers(e.inputSeq, input.inputSeq),
    );
    const authoritative = gpuFrames.find((frame) => {
      const start = starts.get(frame.renderSeq);
      return (
        apply !== undefined &&
        start !== undefined &&
        start.atMs >= apply.atMs &&
        referenceSequenceCovers(start.displayInputSeq, input.inputSeq)
      );
    });
    const prediction = gpuFrames.find(
      (frame) =>
        frame.atMs >= input.atMs && frame.visiblePredictionInputSeqs.includes(input.inputSeq),
    );
    return {
      ...input,
      ordinal,
      inputClass: inputClasses[ordinal] ?? 'invalid',
      browserOriginToAdmissionMs: input.admittedAtMs - input.atMs,
      admissionToTransportSubmissionMs:
        sent === undefined ? null : finite(sent.atMs) - input.admittedAtMs,
      inputToAckMs: ack === undefined ? null : finite(ack.atMs) - input.atMs,
      ackCarrierRttFloorMs:
        ack === undefined || ack.networkRttMs === null ? null : finite(ack.networkRttMs),
      inputToCausalDisplayReceiveMs: receipt === undefined ? null : receipt.atMs - input.atMs,
      inputToCausalStateApplicationMs: apply === undefined ? null : apply.atMs - input.atMs,
      inputToAuthoritativeWatermarkGpuFenceMs:
        authoritative === undefined ? null : authoritative.atMs - input.atMs,
      inputToExactPredictionGpuFenceMs:
        prediction === undefined ? null : prediction.atMs - input.atMs,
      predictionAccepted: records.some(
        (e) =>
          e.kind === 'prediction_applied' &&
          e.inputSeq === input.inputSeq &&
          finite(e.atMs) >= input.atMs &&
          finite(e.atMs) <= window.endAtMs,
      ),
      authoritativeRenderSeq: authoritative?.renderSeq ?? null,
      predictionRenderSeq: prediction?.renderSeq ?? null,
    };
  });
  const classes = [...new Set(inputClasses)].map((inputClass) => {
    const population = samples.filter((sample) => sample.inputClass === inputClass);
    const predictionAcceptedCount = population.filter((sample) => sample.predictionAccepted).length;
    const predictionObservedCount = population.filter(
      (sample) => sample.inputToExactPredictionGpuFenceMs !== null,
    ).length;
    const predictionAcceptedObservedCount = population.filter(
      (sample) => sample.predictionAccepted && sample.inputToExactPredictionGpuFenceMs !== null,
    ).length;
    return {
      inputClass,
      inputCount: population.length,
      predictionAcceptedCount,
      predictionObservedCount,
      predictionAcceptedObservedCount,
      predictionAcceptedUnobservedCount: predictionAcceptedCount - predictionAcceptedObservedCount,
      predictionObservedWithoutAcceptanceCount:
        predictionObservedCount - predictionAcceptedObservedCount,
      metrics: Object.fromEntries(
        INPUT_METRICS.map((key) => {
          const values = population
            .map((sample) => sample[key])
            .filter((value): value is number => value !== null);
          return [
            key,
            { ...referenceDistribution(values), coverage: values.length / population.length },
          ];
        }),
      ),
    };
  });
  const daemon = records.filter(
    (event) =>
      event.kind === 'daemon_timing' &&
      typeof event.inputSeq === 'number' &&
      seen.has(event.inputSeq),
  );
  const daemonByInput = new Map<number, Record<string, unknown>>();
  const daemonObservationEpochs = new Set<number>();
  const daemonSamples = daemon.map((event) => {
    const inputSeq = positiveU32(event.inputSeq);
    if (daemonByInput.has(inputSeq)) {
      throw new Error('common workload has duplicate daemon timing for one input');
    }
    const atMs = finite(event.atMs);
    if (atMs < window.startAtMs || atMs > window.proofAtMs) {
      throw new Error('common workload daemon timing falls outside its proof boundary');
    }
    positiveU32(event.batchSeq);
    daemonObservationEpochs.add(positiveU32(event.observationEpoch));
    daemonByInput.set(inputSeq, event);
    return {
      inputSeq,
      valuesUs: Object.fromEntries(
        COMMON_DAEMON_STAGES.map((key) => [key, nonnegative(event[key])]),
      ),
    };
  });
  if (
    daemonByInput.size !== inputs.length ||
    inputs.some((entry) => !daemonByInput.has(entry.inputSeq))
  ) {
    throw new Error('common workload daemon timing population is incomplete');
  }
  if (daemonObservationEpochs.size !== 1) {
    throw new Error('common workload daemon timing observation lineage is incomplete');
  }
  const daemonObservationEpoch = [...daemonObservationEpochs][0];
  if (daemonObservationEpoch === undefined) {
    throw new Error('common workload daemon timing observation is missing');
  }
  const epochTimings = records.filter(
    (event) => event.kind === 'daemon_timing' && event.observationEpoch === daemonObservationEpoch,
  );
  const epochStatuses = records.filter(
    (event) =>
      event.kind === 'daemon_timing_status' && event.observationEpoch === daemonObservationEpoch,
  );
  if (epochStatuses.length === 0) {
    throw new Error('common workload daemon timing status is missing');
  }
  const recordsByBatch = new Map<number, number>();
  const epochInputSeqs = new Set<number>();
  let epochDisplayAttributedTotal = 0;
  for (const event of epochTimings) {
    const batchSeq = positiveU32(event.batchSeq);
    recordsByBatch.set(batchSeq, (recordsByBatch.get(batchSeq) ?? 0) + 1);
    const inputSeq = nonnegativeU32(event.inputSeq);
    if (inputSeq === 0) epochDisplayAttributedTotal += 1;
    else {
      if (epochInputSeqs.has(inputSeq)) {
        throw new Error('common daemon timing observation contains duplicate input identity');
      }
      epochInputSeqs.add(inputSeq);
    }
  }
  let previousInputTotal = 0;
  let previousDisplayTotal = 0;
  for (const status of epochStatuses) {
    const batchSeq = positiveU32(status.batchSeq);
    const inputAttributedTotal = nonnegativeU32(status.inputAttributedTotal);
    const displayAttributedTotal = nonnegativeU32(status.displayAttributedTotal);
    nonnegativeU32(status.inputDroppedTotal);
    nonnegativeU32(status.inputSkippedTotal);
    nonnegativeU32(status.pendingInputs);
    nonnegativeU32(status.displayDroppedTotal);
    if (
      inputAttributedTotal < previousInputTotal ||
      displayAttributedTotal < previousDisplayTotal ||
      nonnegativeU32(status.recordCount) !== (recordsByBatch.get(batchSeq) ?? 0)
    ) {
      throw new Error('common daemon timing status record accounting is inconsistent');
    }
    previousInputTotal = inputAttributedTotal;
    previousDisplayTotal = displayAttributedTotal;
  }
  const finalDaemonStatus = epochStatuses.at(-1);
  if (
    finalDaemonStatus === undefined ||
    nonnegativeU32(finalDaemonStatus.inputDroppedTotal) !== 0 ||
    nonnegativeU32(finalDaemonStatus.inputSkippedTotal) !== 0 ||
    nonnegativeU32(finalDaemonStatus.pendingInputs) !== 0 ||
    nonnegativeU32(finalDaemonStatus.displayDroppedTotal) !== 0 ||
    nonnegativeU32(finalDaemonStatus.inputAttributedTotal) !== epochInputSeqs.size ||
    nonnegativeU32(finalDaemonStatus.displayAttributedTotal) !== epochDisplayAttributedTotal
  ) {
    throw new Error('common daemon timing final cumulative accounting is incomplete');
  }
  return {
    contract: DIRECT_REFERENCE_CONTRACT,
    window,
    samples,
    classes,
    daemonSamples,
    inputOriginCadenceMs: referenceDistribution(
      samples.slice(1).map((sample, index) => sample.atMs - (samples[index]?.atMs ?? sample.atMs)),
    ),
    daemonStageDistributionsUs: Object.fromEntries(
      COMMON_DAEMON_STAGES.map((key) => [
        key,
        referenceDistribution(daemon.map((event) => nonnegative(event[key]))),
      ]),
    ),
    workerRenderCpuMs: referenceDistribution(
      [...starts.values()]
        .filter((start) => start.atMs >= window.startAtMs && start.atMs <= window.endAtMs)
        .map((start) => {
          const end = ends.get(start.renderSeq);
          if (end === undefined || end.atMs < start.atMs || end.atMs > window.endAtMs)
            throw new Error('render ended outside retained trace');
          return end.atMs - start.atMs;
        }),
    ),
    authoritativeFenceCoverage:
      samples.filter((sample) => sample.authoritativeRenderSeq !== null).length /
      Math.max(1, samples.length),
  };
}

/**
 * Validate homogeneous class populations before any cross-revision pooling.
 * Cadence zero retains exact ownership/completeness but makes no latency claim.
 */
export function validateDirectReferenceInputCoverage(
  analysis: ReturnType<typeof analyzeDirectReferenceInputs>,
  options: DirectReferenceCoverageOptions,
): {
  readonly complete: true;
  readonly mode: DirectReferenceCoverageOptions['mode'];
  readonly appRttEnvelopeMs: readonly [number, number];
} {
  const expectedNames = Object.keys(options.expectedClassCounts).sort();
  const actualNames = analysis.classes.map((entry) => entry.inputClass).sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new Error('common input class identity/multiplicity set is incomplete');
  }
  for (const summary of analysis.classes) {
    const expected = options.expectedClassCounts[summary.inputClass];
    if (
      !Number.isSafeInteger(expected) ||
      expected === undefined ||
      summary.inputCount !== expected
    ) {
      throw new Error(`common ${summary.inputClass} input population is incomplete`);
    }
    if (summary.predictionObservedWithoutAcceptanceCount !== 0) {
      throw new Error(
        `common ${summary.inputClass} prediction observation lacks admission evidence`,
      );
    }
    for (const metric of EXACT_INPUT_METRICS) {
      const distribution = summary.metrics[metric];
      if (
        distribution === undefined ||
        distribution.count !== expected ||
        distribution.coverage !== 1
      ) {
        throw new Error(`common ${summary.inputClass} ${metric} population is incomplete`);
      }
    }
    if (options.mode === 'completeness-only') continue;
    for (const metric of CAUSAL_INPUT_METRICS) {
      const distribution = summary.metrics[metric];
      if (
        distribution === undefined ||
        distribution.count < options.minimumCausalSamplesPerClass ||
        distribution.coverage < options.minimumCausalSamplesPerClass / expected
      ) {
        throw new Error(`common ${summary.inputClass} ${metric} causal coverage is incomplete`);
      }
    }
  }
  const rttValues = analysis.samples
    .map((sample) => sample.ackCarrierRttFloorMs)
    .filter((value): value is number => value !== null);
  const rtt = referenceDistribution(rttValues);
  const lower = Math.max(0, options.targetRttMs - options.appRttToleranceMs);
  const upper = options.targetRttMs + options.appRttToleranceMs;
  if (
    options.mode === 'latency' &&
    (rtt.count !== analysis.samples.length ||
      rtt.p50 === null ||
      rtt.p95 === null ||
      rtt.p50 < lower ||
      rtt.p50 > upper ||
      rtt.p95 < lower ||
      rtt.p95 > upper)
  ) {
    throw new Error('common application ACK RTT does not corroborate the selected Direct profile');
  }
  return {
    complete: true,
    mode: options.mode,
    appRttEnvelopeMs: [lower, upper],
  };
}

/** Exact two-hop/four-leg clean Direct path proof for one reset epoch. */
export function validateDirectReferenceNetworkEvidence(
  hops: readonly ProxyImpairmentStats[],
  options: DirectReferenceNetworkOptions,
): { readonly complete: true; readonly directionalLegCount: 4 } {
  if (hops.length !== 2) throw new Error('common Direct route must contain exactly two proxy hops');
  const expectedSeeds = [options.seed >>> 0, (options.seed ^ 0x9e37_79b9) >>> 0] as const;
  for (let index = 0; index < hops.length; index += 1) {
    const hop = hops[index];
    if (hop === undefined) throw new Error('common Direct route is missing a proxy hop');
    if (
      hop.config.profile !== options.profile ||
      hop.config.targetRttMs !== options.targetRttMs ||
      hop.config.baseDelayUs !== options.baseDelayUs ||
      hop.config.jitterRadiusUs !== options.jitterRadiusUs ||
      hop.config.datagramLossPercent !== 0 ||
      hop.config.faultSite !== 'edge-to-client' ||
      hop.config.faultSitesPerLogicalDirection !== 1 ||
      hop.config.reorder !== 'none' ||
      hop.config.scenario !== 'steady' ||
      hop.config.seed !== expectedSeeds[index] ||
      hop.pendingScheduledPackets !== 0 ||
      hop.splitDatagrams !== 0 ||
      Object.values(hop.harnessDrops).some((count) => count !== 0)
    ) {
      throw new Error(`common Direct proxy hop ${index} does not match its exact clean profile`);
    }
    const intrinsicErrors = configuredProxyFaultEvidenceErrors(hop, {
      requireDrained: true,
      requireConfiguredFaultsObserved: false,
    });
    if (intrinsicErrors.length > 0) {
      throw new Error(
        `common Direct proxy hop ${index} is incomplete: ${intrinsicErrors.join('; ')}`,
      );
    }
    for (const [directionName, direction] of [
      ['upstream', hop.upstream],
      ['downstream', hop.downstream],
    ] as const) {
      if (
        direction.forwarded < options.minimumDirectionalPackets ||
        direction.scheduledDelayUs.count !== direction.forwarded ||
        direction.scheduledDelayUs.min < options.baseDelayUs - options.jitterRadiusUs ||
        direction.scheduledDelayUs.max > options.baseDelayUs + options.jitterRadiusUs
      ) {
        throw new Error(
          `common Direct proxy hop ${index} ${directionName} delay population is incomplete`,
        );
      }
    }
  }
  if (options.workerSources.length !== 1) {
    throw new Error('common Direct route must rewrite exactly one transport worker source');
  }
  const source = options.workerSources[0];
  if (
    source === undefined ||
    !/\/transport-worker[^/]*\.js(?:\?.*)?$/u.test(source.url) ||
    !/^[0-9a-f]{64}$/u.test(source.productionSha256) ||
    !/^[0-9a-f]{64}$/u.test(source.patchedSha256) ||
    source.productionSha256 === source.patchedSha256
  ) {
    throw new Error('common Direct transport-worker rewrite evidence is invalid');
  }
  if (options.dials.length !== 2) {
    throw new Error('common Direct route must contain exactly two constructor dial rewrites');
  }
  const originalHosts = new Set<string>();
  for (const line of options.dials) {
    const match = /^\[merkur-direct-proxy-dial\] (\S+) (\S+)$/u.exec(line);
    if (match === null) throw new Error('common Direct constructor dial marker is malformed');
    const originalText = match[1];
    const routedText = match[2];
    if (originalText === undefined || routedText === undefined) {
      throw new Error('common Direct constructor dial marker is incomplete');
    }
    const original = new URL(originalText);
    const routed = new URL(routedText);
    if (
      original.protocol !== 'https:' ||
      routed.protocol !== 'https:' ||
      Number(original.port) !== options.backendPort ||
      routed.hostname !== '[::1]' ||
      Number(routed.port) !== options.proxyPorts[0]
    ) {
      throw new Error('common Direct constructor did not route through the owned outer proxy');
    }
    originalHosts.add(original.hostname);
  }
  if (!originalHosts.has('127.0.0.1') || !originalHosts.has('[::1]')) {
    throw new Error('common Direct route did not prove both production constructor candidates');
  }
  return { complete: true, directionalLegCount: 4 };
}

/** Gate workload density without pretending row-bearing retries prove changed pixels. */
export function validateDirectReferenceRedrawCoverage(
  workload: string,
  samples: readonly ReferenceRedrawSample[],
  expectedWindowCount: number,
  minimumRowsPerWindow: number,
): DirectReferenceRedrawCoverage {
  if (expectedWindowCount < 100 || samples.length !== expectedWindowCount) {
    throw new Error(`common ${workload} redraw population must contain at least 100 exact windows`);
  }
  if (!Number.isSafeInteger(minimumRowsPerWindow) || minimumRowsPerWindow <= 0) {
    throw new Error('common redraw density threshold is invalid');
  }
  for (const sample of samples) {
    if (sample.appliedRows < minimumRowsPerWindow) {
      throw new Error(`common ${workload} redraw window did not cover its declared row density`);
    }
    if (sample.appliedDatagrams < 1 || sample.appliedBytes <= 0) {
      throw new Error(`common ${workload} redraw window has no applied display-unit payload`);
    }
  }
  return {
    workload,
    windowCount: samples.length,
    minimumRowsPerWindow,
    observedMinimumRows: Math.min(...samples.map((sample) => sample.appliedRows)),
    appliedDisplayUnitCount: samples.reduce((sum, sample) => sum + sample.appliedDatagrams, 0),
    appliedPayloadByteCount: samples.reduce((sum, sample) => sum + sample.appliedBytes, 0),
    singletonWindowCount: samples.filter((sample) => sample.appliedDatagrams === 1).length,
    multiUnitWindowCount: samples.filter((sample) => sample.appliedDatagrams > 1).length,
    applicationTransactionCoherence: {
      available: false,
      reason:
        'presentation transaction identity is not present in the cross-revision event intersection',
    },
  };
}

/** Fail on recorder loss rather than quietly changing the sample population. */
export function validateDirectReferenceDump(raw: unknown): {
  events: readonly unknown[];
  stats: Record<string, unknown>;
} {
  if (!isRecord(raw) || !Array.isArray(raw.events) || !isRecord(raw.stats))
    throw new Error('invalid common worker dump');
  if (nonnegative(raw.stats.recordsLost) !== 0)
    throw new Error('common trace lost producer records');
  if (raw.events.length === 0) throw new Error('common trace is empty');
  return { events: raw.events, stats: raw.stats };
}

function uniqueRenderEvents<K extends 'render_start' | 'render_end' | 'frame_complete'>(
  events: readonly ReferenceTerminalEvent[],
  kind: K,
): Map<number, Extract<ReferenceTerminalEvent, { kind: K }>> {
  const result = new Map<number, Extract<ReferenceTerminalEvent, { kind: K }>>();
  for (const event of events) {
    if (event.kind !== kind) continue;
    if (result.has(event.renderSeq)) throw new Error(`duplicate ${kind} identity`);
    // The discriminator has been checked; generic narrowing does not preserve K.
    result.set(event.renderSeq, event as Extract<ReferenceTerminalEvent, { kind: K }>);
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function finite(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new Error('invalid finite common event field');
  return value;
}
function nonnegative(value: unknown): number {
  const result = finite(value);
  if (result < 0) throw new Error('negative common duration/counter');
  return result;
}
function positiveU32(value: unknown): number {
  const result = finite(value);
  if (!Number.isInteger(result) || result <= 0 || result > 0xffff_ffff)
    throw new Error('invalid nonzero common u32');
  return result;
}
function nonnegativeU32(value: unknown): number {
  const result = finite(value);
  if (!Number.isInteger(result) || result < 0 || result > 0xffff_ffff)
    throw new Error('invalid non-negative common u32');
  return result;
}
