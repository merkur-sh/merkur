import { expect, test } from 'bun:test';
import { gridConvergenceFailureDetail } from './grid-convergence-failure';

test('retains failed probe provenance without hiding timeout or repair counts', () => {
  expect(
    gridConvergenceFailureDetail({
      converged: false,
      failureReason: 'timeout',
      observationEpoch: 1,
      probeId: 2,
      attempts: 15,
      selectiveRepairCount: 0,
      generation: 2,
      lastAdmittedDisplaySeq: 0,
      rows: 37,
      elapsedMs: 20003.98,
    }),
  ).toBe(
    'converged=false failureReason=timeout observationEpoch=1 probeId=2 attempts=15 selectiveRepairCount=0 generation=2 lastAdmittedDisplaySeq=0 rows=37 elapsedMs=20003.98',
  );
});

test('unavailable and rejected probes remain distinct', () => {
  expect(gridConvergenceFailureDetail(null)).toBe('result=unavailable');
  expect(gridConvergenceFailureDetail({ probeError: 'request-rejected' })).toBe(
    'probeError=request-rejected',
  );
  expect(gridConvergenceFailureDetail({ probeError: 'hook-unavailable' })).toBe(
    'probeError=hook-unavailable',
  );
});

test('arbitrary payloads and nonfinite fields cannot expand or contaminate diagnostics', () => {
  const large = 'private terminal content'.repeat(10000);
  expect(
    gridConvergenceFailureDetail({
      failureReason: large,
      rows: large,
      elapsedMs: Infinity,
      payload: large,
    }),
  ).toBe('result=malformed');
  expect(gridConvergenceFailureDetail({ attempts: -1, rows: NaN })).toBe('result=malformed');
  expect(gridConvergenceFailureDetail({ attempts: Number.MAX_VALUE }).length).toBeLessThan(64);
});
