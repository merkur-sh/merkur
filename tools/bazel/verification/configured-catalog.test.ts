import { expect, test } from 'bun:test';
import { configuredCoverageCatalog, coverageObligations } from './configured-catalog';
import { coveragePlan } from './coverage';
import type { SourceInventory } from './engine-catalog';
import type { RequiredCheck } from './events';
import { BAZEL_STATIC_GATES as STATIC_GATES } from './static-gates';

const inventory: SourceInventory = {
  tests: [
    {
      file: 'scripts/check.test.ts',
      check: { label: '//scripts:unit', kind: 'test', fresh: true },
      inputs: ['scripts/check.test.ts'],
    },
  ],
  suites: new Map([['scripts', ['scripts/check.test.ts']]]),
  digest: 'a'.repeat(64),
};

function descriptor() {
  const obligations = coverageObligations();
  return {
    operations: obligations.operations.map((name) => ({
      name,
      checks: STATIC_GATES.includes(name)
        ? [
            {
              label: `//static:${name.replaceAll(':', '_')}`,
              kind: 'test',
              fresh: true,
            } as RequiredCheck,
          ]
        : [],
      pending: STATIC_GATES.includes(name) ? [] : ['Native runtime qualification remains open'],
    })),
    crates: obligations.crates.map((name) => ({
      name,
      checks: [] as RequiredCheck[],
      pending: ['Configured native suite is not imported'],
    })),
    browserOwners: [{ pattern: 'tests/e2e/**/*.e2e.ts', operations: ['test:e2e:transport'] }],
  };
}

test('complete configured ownership retains explicit blockers and all eight static results', () => {
  const result = configuredCoverageCatalog(inventory, [descriptor()]);
  expect(result.pendingQualifications).toContain(
    'rust:deps: Native runtime qualification remains open',
  );
  expect(result.catalog.operations.has('rust:deps')).toBe(false);
  expect(coveragePlan(['docs/processes.md'], result.catalog, false).required).toHaveLength(8);
  expect(() => coveragePlan(['packages/merkur-codec/src/lib.rs'], result.catalog, false)).toThrow(
    'No Bazel suite',
  );
  const reordered = descriptor();
  reordered.operations.reverse();
  reordered.crates.reverse();
  expect(configuredCoverageCatalog(inventory, [reordered]).digest).toBe(result.digest);
});

test('absent policy obligations and empty claims cannot hide behind changed-path selection', () => {
  const missingStatic = descriptor();
  missingStatic.operations = missingStatic.operations.filter((row) => row.name !== 'check:docs');
  expect(() => configuredCoverageCatalog(inventory, [missingStatic])).toThrow(
    'Unregistered policy operation',
  );
  const missingCrate = descriptor();
  missingCrate.crates.pop();
  expect(() => configuredCoverageCatalog(inventory, [missingCrate])).toThrow(
    'Unregistered policy crate',
  );
  const missingBlocker = descriptor();
  missingBlocker.crates[0]?.pending.splice(0);
  expect(() => configuredCoverageCatalog(inventory, [missingBlocker])).toThrow('explicit blocker');
});

test('competing owners and contradictory engine kinds reject; a reusable test check binds', () => {
  expect(() => configuredCoverageCatalog(inventory, [descriptor(), descriptor()])).toThrow(
    'Competing',
  );
  const conflict = descriptor();
  conflict.operations.push({
    name: 'build:web',
    checks: [{ label: '//scripts:unit', kind: 'build', fresh: false }],
    pending: [],
  });
  expect(() => configuredCoverageCatalog(inventory, [conflict])).toThrow(
    'Conflicting configured target kinds',
  );
  const cached = descriptor();
  const row = cached.operations.find((entry) => entry.name === 'check:docs');
  if (row === undefined) throw new Error('Missing fixture row');
  row.checks = [{ label: '//static:docs', kind: 'test', fresh: false }];
  expect(
    configuredCoverageCatalog(inventory, [cached]).catalog.operations.get('check:docs'),
  ).toEqual([{ label: '//static:docs', kind: 'test', fresh: false }]);
});

test('malformed descriptors and unbound or unsafe browser ownership reject', () => {
  expect(() => configuredCoverageCatalog(inventory, [{ ...descriptor(), accepted: true }])).toThrow(
    'unexpected',
  );
  const unbound = descriptor();
  unbound.browserOwners[0]?.operations.push('test:missing-browser');
  expect(() => configuredCoverageCatalog(inventory, [unbound])).toThrow(
    'Unregistered browser operation',
  );
  const unsafe = descriptor();
  const owner = unsafe.browserOwners[0];
  if (owner === undefined) throw new Error('Missing browser fixture');
  owner.pattern = '../outside/*.e2e.ts';
  expect(() => configuredCoverageCatalog(inventory, [unsafe])).toThrow('unsafe');
  const duplicate = descriptor();
  const duplicateOwner = duplicate.browserOwners[0];
  if (duplicateOwner === undefined) throw new Error('Missing browser fixture');
  duplicate.browserOwners.push(duplicateOwner);
  expect(() => configuredCoverageCatalog(inventory, [duplicate])).toThrow('unsafe');
});

function simulationDescriptor(
  simulationOutputs: unknown = [{ label: '//tools/sim:test_regressions', mode: 'replay' }],
  name = 'test:sim',
  kind: RequiredCheck['kind'] = 'test',
) {
  const original = descriptor();
  return {
    ...original,
    operations: [
      ...original.operations.filter((row) => row.name !== name),
      {
        name,
        checks: [
          { label: '//tools/sim:test_regressions', kind, fresh: true },
          { label: '//tools/sim:test_doc', kind: 'test', fresh: true },
        ],
        pending: ['Native simulator execution remains unqualified'],
        simulationOutputs,
      },
    ],
  };
}

test('explicit simulator emitter metadata excludes original rustdoc without inferring from checks', () => {
  const result = configuredCoverageCatalog(inventory, [simulationDescriptor()]);
  expect(result.catalog.operations.get('test:sim')).toHaveLength(2);
  expect(result.simulationOutputs.get('test:sim')).toEqual([
    { label: '//tools/sim:test_regressions', mode: 'replay' },
  ]);
  expect(
    result.simulationOutputs.get('test:sim')?.some((row) => row.label.endsWith('test_doc')),
  ).toBe(false);
  expect(result.pendingQualifications).toContain(
    'test:sim: Native simulator execution remains unqualified',
  );
  const unbound = descriptor();
  expect(configuredCoverageCatalog(inventory, [unbound]).simulationOutputs.size).toBe(0);
  expect(Object.isFrozen(result.simulationOutputs.get('test:sim'))).toBe(true);
  expect(Object.isFrozen(result.simulationOutputs.get('test:sim')?.[0])).toBe(true);
});

test('simulation emitter selection is part of existing configured coverage digest', () => {
  const one = configuredCoverageCatalog(inventory, [simulationDescriptor()]);
  const other = configuredCoverageCatalog(inventory, [
    simulationDescriptor([{ label: '//tools/sim:test_doc', mode: 'replay' }]),
  ]);
  expect(other.digest).not.toBe(one.digest);
  const both = [
    { label: '//tools/sim:test_doc', mode: 'replay' },
    { label: '//tools/sim:test_regressions', mode: 'replay' },
  ];
  expect(configuredCoverageCatalog(inventory, [simulationDescriptor(both)]).digest).toBe(
    configuredCoverageCatalog(inventory, [simulationDescriptor([...both].reverse())]).digest,
  );
});

for (const emitters of [
  null,
  {},
  [null],
  [{ label: '//tools/sim:test_regressions', mode: 'replay', accepted: true }],
  [{ label: '//tools/sim:foreign', mode: 'replay' }],
  [{ label: '//tools/sim:test_regressions', mode: 'sweep' }],
  [{ label: '//tools/sim:test_regressions', mode: 'unknown' }],
  [
    { label: '//tools/sim:test_regressions', mode: 'replay' },
    { label: '//tools/sim:test_regressions', mode: 'replay' },
  ],
]) {
  test(`malformed simulation emitter metadata rejects ${JSON.stringify(emitters)}`, () => {
    expect(() => configuredCoverageCatalog(inventory, [simulationDescriptor(emitters)])).toThrow();
  });
}

test('simulation emitters cannot bind build checks, foreign operations or crate metadata', () => {
  expect(() =>
    configuredCoverageCatalog(inventory, [simulationDescriptor(undefined, 'test:sim', 'build')]),
  ).toThrow('same operation test');
  expect(() =>
    configuredCoverageCatalog(inventory, [simulationDescriptor(undefined, 'test:natlab')]),
  ).toThrow('another operation');
  const original = descriptor();
  const first = original.crates[0];
  if (first === undefined) throw new Error('Missing original crate binding');
  const invalid = {
    ...original,
    crates: [{ ...first, simulationOutputs: [] }, ...original.crates.slice(1)],
  };
  expect(() => configuredCoverageCatalog(inventory, [invalid])).toThrow('unexpected');
});

test('sweep metadata uses only the sweep mode and explicit empty pending bindings stay blocked', () => {
  expect(
    configuredCoverageCatalog(inventory, [
      simulationDescriptor(
        [{ label: '//tools/sim:test_regressions', mode: 'sweep' }],
        'test:sim:sweep',
      ),
    ]).simulationOutputs.get('test:sim:sweep'),
  ).toEqual([{ label: '//tools/sim:test_regressions', mode: 'sweep' }]);
  expect(() =>
    configuredCoverageCatalog(inventory, [
      simulationDescriptor(
        [{ label: '//tools/sim:test_regressions', mode: 'replay' }],
        'test:sim:sweep',
      ),
    ]),
  ).toThrow('same operation test and mode');
  const original = descriptor();
  const empty = {
    ...original,
    operations: [
      ...original.operations.filter((row) => row.name !== 'test:sim'),
      {
        name: 'test:sim',
        checks: [],
        pending: ['Exact configured simulator roots are absent'],
        simulationOutputs: [],
      },
    ],
  };
  const result = configuredCoverageCatalog(inventory, [empty]);
  expect(result.simulationOutputs.get('test:sim')).toEqual([]);
  expect(result.catalog.operations.has('test:sim')).toBe(false);
  expect(result.pendingQualifications).toContain(
    'test:sim: Exact configured simulator roots are absent',
  );
});
