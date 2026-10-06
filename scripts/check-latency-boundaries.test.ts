import { describe, expect, test } from 'bun:test';

import { findLatencyBoundaryViolations } from './check-latency-boundaries';

describe('latency-sensitive import boundary', () => {
  test('reports a direct Effect dependency from a selected source file', () => {
    const violations = findLatencyBoundaryViolations(['apps/server/src/runtime.ts']);

    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((violation) => violation.module === 'effect')).toBe(true);
    expect(violations[0]?.chain[0]).toBe('apps/server/src/runtime.ts');
  });

  test('accepts a project graph without Effect', () => {
    const violations = findLatencyBoundaryViolations(['scripts/bench-input-ring.ts']);

    expect(violations).toEqual([]);
  });

  test('the always-on measurement modules stay dependency-free', () => {
    // These three are pure by design — `terminal-latency.ts` is called from
    // per-keystroke paths, `presented-prediction-sources.ts` per submitted
    // frame, and the aggregator is the file a future change would most
    // plausibly "just add a log to". Their purity was convention until they
    // joined the enforced list.
    const violations = findLatencyBoundaryViolations([
      'apps/web/src/perf/terminal-latency.ts',
      'apps/web/src/terminal/presented-prediction-sources.ts',
      'apps/web/src/perf/link-quality-aggregator.ts',
    ]);

    expect(violations).toEqual([]);
  });
});
