import type { TerminalPerfEvent } from '../../../apps/web/src/perf/terminal-latency';

export type PackingPopulation = 'bulk-only' | 'overlap-row' | 'overlap-header';

/** Predeclared, nonoverlapping actual input-queue intervals; not timer labels. */
export const PACKING_INPUT_INTERVALS = {
  1: { minimumMs: 0.5, maximumExclusiveMs: 4 },
  8: { minimumMs: 6, maximumExclusiveMs: 12 },
  16: { minimumMs: 14, maximumExclusiveMs: 20 },
} as const;

export const PACKING_INTER_WINDOW_QUIET_MS = 250;

export function packingInputOwnership(
  events: readonly TerminalPerfEvent[],
  population: PackingPopulation,
  requestedOffsetMs: 1 | 8 | 16 | null,
) {
  if ((population === 'bulk-only') !== (requestedOffsetMs === null))
    throw new Error('bulk-only has no followup interval; overlap requires one exact interval');
  const inputs = events.filter(
    (event): event is Extract<TerminalPerfEvent, { kind: 'input_queued' }> =>
      event.kind === 'input_queued',
  );
  const expectedCount = population === 'bulk-only' ? 1 : 2;
  if (inputs.length !== expectedCount)
    throw new Error(`packing window requires exactly ${expectedCount} owned inputs`);
  for (let index = 0; index < inputs.length; index++) {
    const input = inputs[index];
    if (
      input === undefined ||
      input.byteLength !== 1 ||
      !Number.isSafeInteger(input.inputSeq) ||
      input.inputSeq <= 0 ||
      input.inputSeq > 0xffff_ffff ||
      !Number.isFinite(input.atMs) ||
      !Number.isFinite(input.admittedAtMs) ||
      input.admittedAtMs < input.atMs
    )
      throw new Error('packing input is not one valid admitted byte');
    const previous = inputs[index - 1];
    if (previous !== undefined && input.inputSeq !== ((previous.inputSeq + 1) >>> 0 || 1))
      throw new Error('packing inputs must have contiguous unique nonzero identities');
  }
  const bulk = inputs[0];
  if (bulk === undefined) throw new Error('missing bulk input');
  const followup = inputs[1];
  const actualOffsetMs = followup === undefined ? null : followup.atMs - bulk.atMs;
  if (requestedOffsetMs !== null) {
    const interval = PACKING_INPUT_INTERVALS[requestedOffsetMs];
    if (
      actualOffsetMs === null ||
      actualOffsetMs < interval.minimumMs ||
      actualOffsetMs >= interval.maximumExclusiveMs
    )
      throw new Error(
        `actual input interval ${actualOffsetMs}ms is outside the declared ${requestedOffsetMs}ms stratum`,
      );
  }
  return {
    population,
    bulk,
    followup: followup ?? null,
    actualOffsetMs,
    requestedOffsetMs,
    finalOwnedInputSeq: followup?.inputSeq ?? bulk.inputSeq,
    endpointScope:
      population === 'bulk-only'
        ? 'standalone-bulk-first-and-complete-authoritative-fence'
        : 'combined-workload-complete-authoritative-fence; no synthetic per-input completion',
    followupEffect:
      population === 'overlap-row'
        ? 'two-row feedback: row-zero marker and final-row X'
        : population === 'overlap-header'
          ? 'completion-owned cursor shape'
          : null,
  };
}
