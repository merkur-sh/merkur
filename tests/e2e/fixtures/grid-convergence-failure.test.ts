import { expect, test } from 'bun:test';
import { gridConvergenceFailureDetail } from './grid-convergence-failure';

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
