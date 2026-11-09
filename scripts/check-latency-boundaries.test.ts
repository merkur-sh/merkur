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
});
