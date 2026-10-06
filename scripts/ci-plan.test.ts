import { describe, expect, test } from 'bun:test';
import { ciPlan } from './ci-plan';
import { checkCiResults } from './ci-required';

describe('CI selection', () => {
  test('main, release and unknown inputs retain full coverage', () => {
    for (const files of [
      [],
      ['Cargo.lock'],
      ['bun.lock'],
      ['.github/workflows/ci.yml'],
      ['scripts/build-term-wasm.ts'],
      ['new-package/source.ts'],
      ['.claude/hooks/run.sh'],
      ['apps/daemon/dataplane/src/display/wire.rs'],
      ['packages/term-wasm/src/lib.rs'],
    ]) {
      expect(ciPlan(files, false)).toEqual({ source: true, native: true, integration: true });
    }
    expect(ciPlan(['README.md'], true)).toEqual({ source: true, native: true, integration: true });
  });

  test('prose needs only documentation validation', () => {
    expect(ciPlan(['README.md', 'docs/ci.md'], false)).toEqual({
      source: false,
      native: false,
      integration: false,
    });
  });

  test('ordinary UI keeps browsers but avoids unrelated native tests', () => {
    expect(ciPlan(['apps/web/src/screens/devices.tsx'], false)).toEqual({
      source: true,
      native: false,
      integration: true,
    });
  });

  test('a protocol consumer still selects native and browser proofs', () => {
    expect(ciPlan(['packages/shared/src/ipc.ts'], false)).toEqual({
      source: true,
      native: true,
      integration: true,
    });
  });

  test('isolated unit-test edits do not select browsers', () => {
    expect(ciPlan(['packages/keyboard/src/layout.test.ts'], false)).toEqual({
      source: true,
      native: false,
      integration: false,
    });
  });

  test('both sides of a rename participate', () => {
    expect(ciPlan(['packages/shared/src/ipc.ts', 'docs/old-ipc.md'], false).native).toBe(true);
  });
});

test('required check accepts only exactly the planned successes and skips', () => {
  const plan = ciPlan(['README.md'], false);
  const results = Object.fromEntries(
    [
      ['plan', 'success'],
      ['wasm', 'skipped'],
      ['source', 'success'],
      ['native', 'skipped'],
      ['browser-native', 'skipped'],
      ['integration', 'skipped'],
      ['transport', 'skipped'],
    ].map(([name, result]) => [name, { result }]),
  );
  // Explicit literals above are checked at the boundary by the workflow as well.
  const valid = results as Record<string, { result: string }>;
  expect(() => checkCiResults(plan, valid)).not.toThrow();
  for (const result of ['failure', 'cancelled', 'skipped']) {
    expect(() => checkCiResults(plan, { ...valid, source: { result } })).toThrow();
  }
  expect(() => checkCiResults(plan, { ...valid, native: { result: 'success' } })).toThrow();
  expect(() => checkCiResults(plan, {})).toThrow();
  expect(() => checkCiResults({ source: true, native: true, integration: true }, valid)).toThrow();
});
