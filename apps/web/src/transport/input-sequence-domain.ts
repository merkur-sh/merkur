const MAX_INPUT_SEQUENCE = 0xffff_ffff;

/**
 * Constant-space translation from the daemon's per-peer wire sequence to the
 * main thread's monotonic local sequence.
 *
 * `localMinusWire` is unsigned modular arithmetic rather than a signed offset:
 * the full u32 range is representable even when local is near UINT32_MAX and
 * wire was rebased to 1. The inclusive wire bounds prevent an unrelated or
 * stale wire value from being fabricated into a valid local sequence.
 */
export interface InputSequenceMapping {
  readonly epoch: number;
  readonly localMinusWire: number;
  readonly wireMin: number;
  readonly wireMax: number;
}

export function localInputSequenceForWire(
  mapping: InputSequenceMapping,
  wireSequence: number,
): number | null {
  if (
    !Number.isInteger(wireSequence) ||
    wireSequence < 1 ||
    wireSequence > MAX_INPUT_SEQUENCE ||
    mapping.wireMin === 0 ||
    wireSequence < mapping.wireMin ||
    wireSequence > mapping.wireMax
  ) {
    return null;
  }

  const localSequence = (wireSequence + mapping.localMinusWire) >>> 0;
  return localSequence === 0 ? null : localSequence;
}

/** Display headers use zero for "no input applied"; unknown lineage fails to zero. */
export function normalizeDisplayInputSequence(
  mapping: InputSequenceMapping,
  wireSequence: number,
): number {
  if (wireSequence === 0) return 0;
  return localInputSequenceForWire(mapping, wireSequence) ?? 0;
}

/**
 * The older of two input sequences, where zero, "none", is older than any:
 * the newest input both of two bounds have reached.
 */
export function olderInputSequence(left: number, right: number): number {
  if (left >>> 0 === 0 || right >>> 0 === 0) return 0;
  return inputSequenceAdvances(left, right) ? left >>> 0 : right >>> 0;
}

/**
 * Whether `candidate` advances a nonzero u32 input-sequence high-water.
 *
 * Zero is the protocol sentinel for "no causal input". The explicit empty
 * case is also what lets the first observed serial sit near u32::MAX; once
 * initialized, RFC-1982 ordering keeps a wrapped successor newer than its
 * numerically larger predecessor.
 */
export function inputSequenceAdvances(current: number, candidate: number): boolean {
  const normalizedCandidate = candidate >>> 0;
  if (normalizedCandidate === 0) return false;
  const normalizedCurrent = current >>> 0;
  if (normalizedCurrent === 0) return true;
  const distance = (normalizedCandidate - normalizedCurrent) >>> 0;
  return distance !== 0 && distance < 0x8000_0000;
}

/** Advance a nonzero u32 input high-water without allocating or widening it. */
export function advanceInputSequence(current: number, candidate: number): number {
  return inputSequenceAdvances(current, candidate) ? candidate >>> 0 : current >>> 0;
}

export type InputSequenceEpochDecision = 'current' | 'advance' | 'stale';

/** Wrapping-aware lineage ordering; epoch zero means "not established". */
export function classifyInputSequenceEpoch(
  currentEpoch: number,
  incomingEpoch: number,
): InputSequenceEpochDecision {
  if (incomingEpoch === currentEpoch) return 'current';
  if (currentEpoch === 0) return 'advance';
  if (incomingEpoch === 0) return 'stale';
  return (incomingEpoch - currentEpoch) >>> 0 < 0x8000_0000 ? 'advance' : 'stale';
}
