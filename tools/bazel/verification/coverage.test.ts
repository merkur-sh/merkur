import { expect, test } from 'bun:test';
import { type CoverageCatalog, coveragePlan, unitCoverage } from './coverage';
import type { RequiredCheck } from './events';
import { BAZEL_STATIC_GATES as STATIC_GATES } from './static-gates';

function check(label: string, fresh = false): RequiredCheck {
  return { label, kind: 'test', fresh };
}

function catalog(): CoverageCatalog {
  const names = [
    ...STATIC_GATES,
    'rust:lint',
    'rust:deps',
    'test:real-helper',
    'check:protocol',
    'check:audit',
    'build:image-worker',
    'test:e2e:latency',
    'test:e2e:transport',
    'test:graphics:long',
    'test:fuzz:kani',
  ];
  return {
    tests: [
      { file: 'apps/web/a.test.ts', check: check('//web:a'), inputs: ['apps/web/a.ts'] },
      { file: 'apps/web/b.test.ts', check: check('//web:b'), inputs: ['apps/web/b.ts'] },
      {
        file: 'apps/server/consumer.test.ts',
        check: check('//server:consumer'),
        inputs: ['apps/web/a.ts', 'fixtures/shared.json'],
      },
    ],
    suites: new Map([
      ['apps/web', ['apps/web/a.test.ts', 'apps/web/b.test.ts']],
      ['apps/server', ['apps/server/consumer.test.ts']],
      ['scripts', []],
    ]),
    operations: new Map(
      names.map((name) => [name, [check(`//gates:${name.replaceAll(':', '_')}`)]]),
    ),
    crates: new Map([['merkur-codec', [check('//codec:unit'), check('//codec:doc')]]]),
    browserOwners: new Map([['tests/e2e/*.e2e.ts', ['test:e2e:transport']]]),
  };
}

function labels(files: readonly string[], input = catalog(), all = false): string[] {
  return coveragePlan(files, input, all).required.map((required) => required.label);
}

test('source changes select the owning suite and configured consumers', () => {
  const selected = labels(['apps/web/a.ts']);
  expect(selected).toContain('//web:a');
  expect(selected).toContain('//web:b');
  expect(selected).toContain('//server:consumer');
  expect(selected.filter((name) => name.startsWith('//gates:'))).toHaveLength(8);
});

test('a changed test selects itself rather than unrelated owning tests', () => {
  const selected = labels(['apps/web/a.test.ts']);
  expect(selected).toContain('//web:a');
  expect(selected).not.toContain('//web:b');
});

test('unclassified inputs still select declared consumers and every static gate', () => {
  const selected = labels(['fixtures/shared.json']);
  expect(selected).toContain('//server:consumer');
  expect(selected.filter((name) => name.startsWith('//gates:'))).toHaveLength(8);
});

test('Rust display codec changes include protocol, real helper, lint and doctests', () => {
  const result = coveragePlan(['packages/merkur-codec/src/lib.rs'], catalog(), false);
  for (const name of [
    '//codec:unit',
    '//codec:doc',
    '//gates:check_protocol',
    '//gates:test_real-helper',
    '//gates:build_image-worker',
    '//gates:rust_lint',
    '//gates:rust_deps',
  ]) {
    expect(result.required.map((required) => required.label)).toContain(name);
  }
  expect(result.deferred).toEqual(['test:e2e:transport', 'test:fuzz:kani', 'test:graphics:long']);
  expect(labels(result.files, catalog(), true)).toContain('//gates:test_e2e_transport');
});

test('verification infrastructure selects the complete source inventory', () => {
  expect(
    labels(['scripts/test-inventory.ts']).filter((name) => !name.startsWith('//gates:')),
  ).toEqual(['//server:consumer', '//web:a', '//web:b']);
});

test('transport coverage subsumes latency and extended coverage is explicit', () => {
  const files = ['apps/web/src/terminal-worker.ts'];
  const plan = coveragePlan(files, catalog(), false);
  expect(plan.deferred).toEqual(['test:e2e:transport']);
  expect(plan.required.map((required) => required.label)).not.toContain(
    '//gates:test_e2e_transport',
  );
  expect(labels(files, catalog(), true)).toContain('//gates:test_e2e_transport');
});

test('ordinary verification requires all eight static results for prose and an unchanged tree', () => {
  const expected = STATIC_GATES.map((name) => `//gates:${name.replaceAll(':', '_')}`).sort();
  expect(labels(['docs/security.md'])).toEqual(expected);
  expect(coveragePlan(['docs/security.md'], catalog(), false).docsOnly).toBe(true);
  expect(labels([])).toEqual(expected);
});

test('missing operations and ambiguous catalogs cannot silently reduce coverage', () => {
  const input = catalog();
  expect(() => labels(['apps/web/a.ts'], { ...input, operations: new Map() })).toThrow(
    'No Bazel coverage',
  );
  expect(() =>
    labels(['packages/merkur-codec/src/lib.rs'], { ...input, crates: new Map() }),
  ).toThrow('No Bazel suite');
  const first = input.tests[0];
  if (first === undefined) throw new Error('Fixture is empty');
  expect(() => labels(['apps/web/a.ts'], { ...input, tests: [...input.tests, first] })).toThrow(
    'Duplicate source test',
  );
  expect(() => labels(['../escape'])).toThrow('Invalid coverage source path');
});

test('an absent owning suite fails while an explicitly complete empty suite is represented', () => {
  const original = catalog();
  const tests = original.tests.filter((entry) => entry.file.startsWith('apps/web/'));
  const suites = new Map([['apps/web', ['apps/web/a.test.ts', 'apps/web/b.test.ts']]]);
  expect(() => labels(['apps/server/service.ts'], { ...original, tests, suites })).toThrow(
    'No complete owning suite',
  );
  suites.set('apps/server', []);
  expect(labels(['apps/server/service.ts'], { ...original, tests, suites })).toHaveLength(8);
});

test('unit selection uses every configured source test and the eight static policies, without domain campaigns', () => {
  const input = catalog();
  const result = unitCoverage(input);
  const statics = STATIC_GATES.map((name) => ({
    name,
    checks: input.operations.get(name) ?? [],
  }));
  expect(result.required).toEqual(
    [...input.tests.map((entry) => entry.check), ...statics.flatMap((entry) => entry.checks)].sort(
      (a, b) => a.label.localeCompare(b.label),
    ),
  );
  expect(result.files).toEqual([]);
  expect(result.docsOnly).toBe(false);
  expect(result.deferred).toEqual([]);
  expect(result.pendingDeferred).toEqual([]);
  expect(result.staticOperations).toEqual(statics);
  expect(statics.every((entry) => entry.checks.length !== 0)).toBe(true);
  expect(result.reasons).toEqual([
    'Complete configured source-test inventory',
    'Required static policies',
  ]);
  expect(() => unitCoverage({ ...input, operations: new Map() })).toThrow('No Bazel coverage');
});

test('unit selection preserves required freshness when original source tests share a configured action', () => {
  const input = catalog();
  const shared = { file: 'scripts/shared.test.ts', check: check('//web:a', true), inputs: [] };
  const suites = new Map(input.suites);
  suites.set('scripts', [shared.file]);
  const result = unitCoverage({ ...input, tests: [...input.tests, shared], suites });
  expect(result.required).toHaveLength(input.tests.length + STATIC_GATES.length);
  expect(result.required.find((entry) => entry.label === '//web:a')).toEqual(
    check('//web:a', true),
  );
  expect(input.tests[0]?.check.fresh).toBe(false);
});

test('unit selection cannot accept an empty, reduced ambiguous or non-test source catalog', () => {
  const input = catalog();
  const first = input.tests[0];
  if (first === undefined) throw new Error('Fixture empty');
  expect(() => unitCoverage({ ...input, tests: [], suites: new Map() })).toThrow(
    'complete configured source-test inventory',
  );
  expect(() => unitCoverage({ ...input, tests: [...input.tests, first] })).toThrow(
    'Duplicate source test',
  );
  expect(() =>
    unitCoverage({
      ...input,
      tests: [{ ...first, check: { ...first.check, kind: 'build' } }, ...input.tests.slice(1)],
    }),
  ).toThrow('not an engine test');
  expect(() => unitCoverage({ ...input, tests: input.tests.slice(1) })).toThrow();
});
