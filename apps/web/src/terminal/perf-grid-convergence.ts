import type { PerfGridConvergenceResponseEdge } from './worker-peer-control';

export type PerfGridConvergenceComparison =
  | { readonly kind: 'converged' }
  | { readonly kind: 'await-display' }
  | { readonly kind: 'retry'; readonly reason: 'generation' | 'dimensions' | 'sequence' }
  | { readonly kind: 'repair'; readonly rows: readonly number[] };

/**
 * Compare one quiescent daemon observation with the terminal worker's current
 * authoritative state. Hashes are compared only at the exact generation and
 * sequence the daemon reported. A response ahead of the local state names
 * display the browser has not applied yet (still in flight, or being recovered
 * after a loss), so the same observation holds until that display lands. A
 * response behind it describes an older instant and must be re-probed, never
 * misclassified as divergence.
 */
export function comparePerfGridConvergence(
  response: PerfGridConvergenceResponseEdge,
  local: {
    readonly generation: number;
    readonly lastAppliedDisplaySeq: number;
    readonly cols: number;
    readonly rows: number;
    readonly rowHashes: Uint32Array;
  },
): PerfGridConvergenceComparison {
  if (response.generation > local.generation) {
    return { kind: 'await-display' };
  }
  if (response.generation < local.generation) {
    return { kind: 'retry', reason: 'generation' };
  }
  if (
    response.cols !== local.cols ||
    response.rows !== local.rows ||
    response.rowHashes.byteLength !== local.rowHashes.byteLength
  ) {
    return { kind: 'retry', reason: 'dimensions' };
  }
  if (response.lastAdmittedDisplaySeq > local.lastAppliedDisplaySeq) {
    return { kind: 'await-display' };
  }
  if (response.lastAdmittedDisplaySeq < local.lastAppliedDisplaySeq) {
    return { kind: 'retry', reason: 'sequence' };
  }

  const remote = new Uint32Array(response.rowHashes);
  const mismatched: number[] = [];
  for (let row = 0; row < local.rows; row += 1) {
    const word = row * 2;
    if (remote[word] !== local.rowHashes[word] || remote[word + 1] !== local.rowHashes[word + 1]) {
      mismatched.push(row);
    }
  }
  return mismatched.length === 0 ? { kind: 'converged' } : { kind: 'repair', rows: mismatched };
}
