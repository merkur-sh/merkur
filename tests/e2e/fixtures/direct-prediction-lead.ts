import type { TerminalLatencySample } from '../../../apps/web/src/perf/terminal-latency';
import { referenceDistribution } from './terminal-redraw-reference';

type PredictionLeadInput = Pick<
  TerminalLatencySample,
  'inputSeq' | 'inputToPredictionPaintMs' | 'inputToAuthoritativeVisualFenceMs'
>;

/**
 * Compare the two browser-observed fence endpoints for each EXACT input.
 * Call after raw replay and ordinal/class validation, never on pooled quantiles.
 * These observations are not physical scanout or proof of compositor visibility.
 */
export function summarizeDirectPredictionLead(
  samples: readonly PredictionLeadInput[],
  completeness: { readonly prediction: boolean; readonly authoritative: boolean },
) {
  const identities = new Set<number>();
  const pairs: {
    inputSeq: number;
    predictionMs: number;
    authoritativeMs: number;
    leadMs: number;
  }[] = [];
  let missingPredictionCount = 0;
  let missingAuthorityCount = 0;
  for (const sample of samples) {
    if (
      !Number.isSafeInteger(sample.inputSeq) ||
      sample.inputSeq <= 0 ||
      sample.inputSeq > 0xffff_ffff ||
      identities.has(sample.inputSeq)
    ) {
      throw new Error(`invalid or duplicate prediction-lead identity ${sample.inputSeq}`);
    }
    identities.add(sample.inputSeq);
    const predictionMs = sample.inputToPredictionPaintMs;
    const authoritativeMs = sample.inputToAuthoritativeVisualFenceMs;
    for (const value of [predictionMs, authoritativeMs]) {
      if (value !== null && (!Number.isFinite(value) || value < 0)) {
        throw new Error(`invalid prediction-lead endpoint for input ${sample.inputSeq}`);
      }
    }
    if (predictionMs === null) missingPredictionCount += 1;
    if (authoritativeMs === null) missingAuthorityCount += 1;
    if (predictionMs === null || authoritativeMs === null) continue;
    pairs.push({
      inputSeq: sample.inputSeq,
      predictionMs,
      authoritativeMs,
      leadMs: authoritativeMs - predictionMs,
    });
  }
  const leads = pairs.map((pair) => pair.leadMs).sort((left, right) => left - right);
  const percentile = (ratio: number) => leads[Math.ceil(leads.length * ratio) - 1] ?? null;
  const perceptibleLeadCount = leads.filter((leadMs) => leadMs >= 8).length;
  return {
    endpoint: 'browser-observed-webgpu-queue-completion' as const,
    inputCount: samples.length,
    // Missing prediction is a non-benefit, not a reason to shrink the denominator.
    missingPredictionCount,
    missingAuthorityCount,
    pairedCount: pairs.length,
    pairedCoverageRatio: samples.length === 0 ? null : pairs.length / samples.length,
    perceptibleLeadCount,
    perceptibleLeadInputRatio: samples.length === 0 ? null : perceptibleLeadCount / samples.length,
    authoritativeBeforePredictionCount: leads.filter((leadMs) => leadMs < 0).length,
    equalEndpointCount: leads.filter((leadMs) => leadMs === 0).length,
    // Missing A prevents an end-to-end conclusion even when retained tails look good.
    complete:
      samples.length > 0 &&
      completeness.prediction &&
      completeness.authoritative &&
      missingAuthorityCount === 0,
    leadMs: {
      ...referenceDistribution(leads),
      p10: percentile(0.1),
      p90: percentile(0.9),
      min: leads[0] ?? null,
    },
    pairs,
  };
}
