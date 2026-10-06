import { expect, test } from 'bun:test';
import { verificationArguments } from './cli';
import type { CoverageCatalog } from './coverage';
import type { RequiredCheck } from './events';
import { BAZEL_STATIC_GATES as STATIC_GATES } from './static-gates';
import {
  ASSURANCE_OPERATIONS,
  assuranceWorkflowSelection,
  EXTENDED_SUITES,
  extendedWorkflowSelection,
  extendedWorkflowsSelection,
} from './workflow-selection';

function fixture(): CoverageCatalog {
  const names = [...STATIC_GATES, ...Object.values(ASSURANCE_OPERATIONS).flat(), 'test:sim:sweep'];
  return {
    tests: [],
    suites: new Map(),
    crates: new Map(),
    browserOwners: new Map(),
    operations: new Map(
      names.map((name) => [
        name,
        [{ label: `//assurance:${name.replaceAll(':', '_')}`, kind: 'test', fresh: true }],
      ]),
    ),
  };
}

function replace(catalog: CoverageCatalog, name: string, checks: readonly RequiredCheck[]) {
  return { ...catalog, operations: new Map([...catalog.operations, [name, checks]]) };
}

test('pull requests and pushes select every mandatory original assurance operation', () => {
  for (const event of ['pull_request', 'push']) {
    const selection = assuranceWorkflowSelection(event, fixture());
    expect(selection.lanes).toEqual([
      'parser-smoke',
      'ownership',
      'bounded-proofs',
      'kernel-tool',
      'simulation',
    ]);
    expect(selection.operations).toEqual([
      ...STATIC_GATES,
      'test:fuzz:instrumentation',
      'test:fuzz:smoke',
      'test:ownership',
      'rust:lint:ownership',
      'test:ownership:kani',
      'test:ownership:negative',
      'test:fuzz:kani',
      'rust:lint:kernel-tool',
      'test:kernel-tool',
      'test:kernel-tool:completed-work',
      'test:sim',
    ]);
    expect(selection.coverage.staticOperations.map((operation) => operation.name)).toEqual([
      ...STATIC_GATES,
    ]);
    expect(selection.coverage.required).toHaveLength(19);
    expect(selection.coverage.pendingDeferred).toEqual([]);
    expect(selection.coverage.docsOnly).toBe(false);
  }
});

test('scheduled and manual assurance add the bounded campaign to the same complete batch', () => {
  for (const event of ['schedule', 'workflow_dispatch']) {
    const selection = assuranceWorkflowSelection(event, fixture());
    expect(selection.lanes).toEqual([
      'parser-smoke',
      'ownership',
      'bounded-proofs',
      'kernel-tool',
      'simulation',
      'fuzz-campaign',
    ]);
    expect(selection.operations).toContain('test:fuzz:campaign');
    expect(selection.operations.at(-1)).toBe('test:sim:sweep');
    expect(selection.coverage.required).toHaveLength(21);
  }
});

test('every absent or empty required producer is refused before reservation', () => {
  const catalog = fixture();
  for (const name of assuranceWorkflowSelection('schedule', catalog).operations) {
    const operations = new Map(catalog.operations);
    operations.delete(name);
    expect(() => assuranceWorkflowSelection('schedule', { ...catalog, operations })).toThrow(name);
    expect(() => assuranceWorkflowSelection('schedule', replace(catalog, name, []))).toThrow(name);
  }
});

test('a missing campaign is irrelevant only to events that do not run it', () => {
  const catalog = fixture();
  const operations = new Map(catalog.operations);
  operations.delete('test:fuzz:campaign');
  expect(assuranceWorkflowSelection('pull_request', { ...catalog, operations }).lanes).toHaveLength(
    5,
  );
  expect(() => assuranceWorkflowSelection('schedule', { ...catalog, operations })).toThrow(
    'test:fuzz:campaign',
  );
});

test('one union deduplicates shared test labels and keeps the strongest freshness requirement', () => {
  let catalog = fixture();
  catalog = replace(catalog, 'test:fuzz:smoke', [
    { label: '//assurance:shared', kind: 'test', fresh: false },
  ]);
  catalog = replace(catalog, 'test:fuzz:kani', [
    { label: '//assurance:shared', kind: 'test', fresh: true },
  ]);
  const selection = assuranceWorkflowSelection('push', catalog);
  expect(
    selection.coverage.required.filter((check) => check.label === '//assurance:shared'),
  ).toEqual([{ label: '//assurance:shared', kind: 'test', fresh: true }]);
  expect(selection.coverage.required).toHaveLength(18);
});

test('unrelated configured operations and source tests do not expand the workflow', () => {
  const catalog = replace(fixture(), 'test:extra-proof', [
    { label: '//assurance:extra', kind: 'test', fresh: true },
  ]);
  const selection = assuranceWorkflowSelection('push', {
    ...catalog,
    tests: [
      {
        file: 'other.test.ts',
        inputs: [],
        check: { label: '//other:test', kind: 'test', fresh: true },
      },
    ],
  });
  expect(selection.operations).not.toContain('test:extra-proof');
  expect(
    selection.coverage.required.some((check) =>
      ['//assurance:extra', '//other:test'].includes(check.label),
    ),
  ).toBe(false);
});

test('build-only, duplicate and malformed test bindings cannot substitute for a verdict', () => {
  const catalog = fixture();
  const valid: RequiredCheck = { label: '//assurance:proof', kind: 'test', fresh: true };
  for (const checks of [
    [{ ...valid, kind: 'build' as const }],
    [valid, valid],
    [{ ...valid, label: '@foreign//:proof' }],
    [{ ...valid, fresh: undefined } as unknown as RequiredCheck],
  ]) {
    expect(() =>
      assuranceWorkflowSelection('push', replace(catalog, 'test:fuzz:kani', checks)),
    ).toThrow('Invalid assurance workflow test binding');
  }
});

test('unsupported or malformed events do not gain an assurance exemption', () => {
  for (const event of ['', 'workflow_dispatch ', 'pull_request_target', 'release', 'SCHEDULE'])
    expect(() => assuranceWorkflowSelection(event, fixture())).toThrow('Unsupported assurance');
});

test('selection is deterministic without mutating or retaining mutable configured check objects', () => {
  const catalog = fixture();
  const selection = assuranceWorkflowSelection('schedule', catalog);
  const reversed = { ...catalog, operations: new Map([...catalog.operations].reverse()) };
  expect(assuranceWorkflowSelection('schedule', reversed)).toEqual(selection);
  const checks = catalog.operations.get('check:types');
  expect(checks).toHaveLength(1);
  expect(selection.coverage.staticOperations[0]?.checks).not.toBe(checks);
  expect(selection.coverage.required.map((check) => check.label)).toEqual(
    [...selection.coverage.required.map((check) => check.label)].sort(),
  );
});

test('extended matrix selects exactly eight static policies and its configured suite', () => {
  for (const suite of EXTENDED_SUITES) {
    const catalog = replace(fixture(), suite, [
      { label: '//extended:selected', kind: 'test', fresh: true },
    ]);
    const coverage = extendedWorkflowSelection(suite, catalog);
    expect(coverage.required).toHaveLength(STATIC_GATES.length + 1);
    expect(coverage.required.map((check) => check.label)).toContain('//extended:selected');
    expect(coverage.staticOperations.map((operation) => operation.name)).toEqual([...STATIC_GATES]);
    expect(coverage.deferred).toEqual([]);
    const args = [
      '--all',
      '--force',
      '--ci-report-file',
      '/declared/ci.json',
      '--extended-suite',
      suite,
    ];
    expect(verificationArguments(args).extendedSuite).toBe(suite);
    for (const missing of ['--all', '--force'])
      expect(() => verificationArguments(args.filter((arg) => arg !== missing))).toThrow(
        'Extended suite',
      );
    expect(() => extendedWorkflowSelection(suite, fixture())).toThrow(suite);
    expect(() => extendedWorkflowSelection(suite, replace(catalog, suite, []))).toThrow(suite);
    expect(() =>
      extendedWorkflowSelection(
        suite,
        replace(catalog, suite, [{ label: '//extended:selected', kind: 'build', fresh: true }]),
      ),
    ).toThrow('Invalid extended');
  }
});

test('extended selection refuses unknown operations and another workflow', () => {
  for (const suite of ['', 'test:natlab ', 'test:arbitrary'])
    expect(() => extendedWorkflowSelection(suite, fixture())).toThrow('Unsupported extended');
  expect(() =>
    verificationArguments(['--all', '--force', '--extended-suite', 'test:natlab']),
  ).toThrow('Extended suite');
  expect(() =>
    verificationArguments([
      '--all',
      '--force',
      '--ci-report-file',
      '/declared/ci.json',
      '--extended-suite',
      'test:natlab',
      '--assurance-event',
      'push',
    ]),
  ).toThrow('Extended suite');
});

test('simulation replay is required for every event and only scheduled batches require sweep', () => {
  for (const event of ['pull_request', 'push', 'schedule', 'workflow_dispatch']) {
    const catalog = fixture();
    const operations = new Map(catalog.operations);
    operations.delete('test:sim');
    expect(() => assuranceWorkflowSelection(event, { ...catalog, operations })).toThrow('test:sim');
    operations.set('test:sim', catalog.operations.get('test:sim') ?? []);
    operations.delete('test:sim:sweep');
    if (event === 'schedule' || event === 'workflow_dispatch') {
      expect(() => assuranceWorkflowSelection(event, { ...catalog, operations })).toThrow(
        'test:sim:sweep',
      );
    } else {
      expect(
        assuranceWorkflowSelection(event, { ...catalog, operations }).operations,
      ).not.toContain('test:sim:sweep');
    }
  }
});

test('the extended matrix reserves one union including every suite and shared static test', () => {
  const catalog = fixture();
  const shared = { label: '//extended:shared', kind: 'test' as const, fresh: false };
  const operations = new Map(catalog.operations);
  for (const name of [...STATIC_GATES, ...EXTENDED_SUITES])
    operations.set(name, [
      shared,
      { label: `//extended:${name.replaceAll(':', '_')}`, kind: 'test', fresh: true },
    ]);
  operations.set('test:natlab', [{ ...shared, fresh: true }]);
  const selected = extendedWorkflowsSelection({ ...catalog, operations });
  expect(selected.required.filter((check) => check.label === shared.label)).toEqual([
    { ...shared, fresh: true },
  ]);
  expect(new Set(selected.required.map((check) => check.label)).size).toBe(
    selected.required.length,
  );
  expect(selected.staticOperations.map((entry) => entry.name)).toEqual([...STATIC_GATES]);
  for (const name of EXTENDED_SUITES)
    expect(selected.reasons.some((reason) => reason.endsWith(`extended ${name}`))).toBe(true);
  for (const name of [...STATIC_GATES, ...EXTENDED_SUITES]) {
    const missing = new Map(operations);
    missing.delete(name);
    expect(() => extendedWorkflowsSelection({ ...catalog, operations: missing })).toThrow(name);
    expect(() => extendedWorkflowsSelection(replace({ ...catalog, operations }, name, []))).toThrow(
      name,
    );
  }
});

test('the complete extended CLI batch rejects overlapping workflow modes before execution', () => {
  const args = ['--all', '--force', '--extended-suites', '--ci-report-file', '/tmp/extended.json'];
  expect(verificationArguments(args).extendedSuites).toBe(true);
  for (const omitted of ['--all', '--force'])
    expect(() => verificationArguments(args.filter((argument) => argument !== omitted))).toThrow();
  expect(() => verificationArguments(['--all', '--force', '--extended-suites'])).toThrow();
  for (const conflict of [
    ['--extended-suites'],
    ['--extended-suite', 'test:natlab'],
    ['--assurance-event', 'schedule'],
    ['--native-platforms', '--executor-policy-file', '/tmp/policy.json'],
    ['--unsigned', '--unsigned-output-directory', '/tmp/unsigned'],
  ])
    expect(() => verificationArguments([...args, ...conflict])).toThrow();
});
