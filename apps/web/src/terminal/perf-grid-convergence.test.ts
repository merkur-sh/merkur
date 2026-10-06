import { describe, expect, test } from 'bun:test';
import { comparePerfGridConvergence } from './perf-grid-convergence';
import type { PerfGridConvergenceResponseEdge } from './worker-peer-control';

function response(hashes = new Uint32Array([1, 2, 3, 4])): PerfGridConvergenceResponseEdge {
  return {
    kind: 'perf_grid_convergence_response',
    observationEpoch: 7,
    probeId: 9,
    generation: 11,
    lastAdmittedDisplaySeq: 13,
    cols: 80,
    rows: 2,
    rowHashes: hashes.buffer,
  };
}

const local = {
  generation: 11,
  lastAppliedDisplaySeq: 13,
  cols: 80,
  rows: 2,
  rowHashes: new Uint32Array([1, 2, 3, 4]),
};

describe('performance grid convergence comparison', () => {
  test('requires one exact state instant before comparing hashes', () => {
    expect(comparePerfGridConvergence(response(), local)).toEqual({ kind: 'converged' });
    expect(comparePerfGridConvergence(response(), { ...local, generation: 12 })).toEqual({
      kind: 'retry',
      reason: 'generation',
    });
    expect(comparePerfGridConvergence(response(), { ...local, lastAppliedDisplaySeq: 14 })).toEqual(
      {
        kind: 'retry',
        reason: 'sequence',
      },
    );
    expect(comparePerfGridConvergence(response(), { ...local, cols: 81 })).toEqual({
      kind: 'retry',
      reason: 'dimensions',
    });
  });

  test('returns only the exact divergent rows for selective repair', () => {
    expect(comparePerfGridConvergence(response(new Uint32Array([1, 2, 99, 4])), local)).toEqual({
      kind: 'repair',
      rows: [1],
    });
  });
});
