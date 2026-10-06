import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { coverageObligations } from './configured-catalog';
import { CONFIGURED_POLICY_PRODUCERS, loadConfiguredPolicyInputs } from './configured-inputs';
import { coveragePlan } from './coverage';
import type { SourceInventory } from './engine-catalog';
import type { RequiredCheck } from './events';
import { BAZEL_STATIC_GATES as STATIC_GATES } from './static-gates';

const inventory: SourceInventory = {
  tests: [
    {
      file: 'scripts/a.test.ts',
      check: { label: '//scripts:a', kind: 'test', fresh: true },
      inputs: ['scripts/a.test.ts'],
    },
  ],
  suites: new Map([['scripts', ['scripts/a.test.ts']]]),
  digest: 'a'.repeat(64),
};

function fixture(root: string) {
  const obligations = coverageObligations();
  const descriptors = CONFIGURED_POLICY_PRODUCERS.map((label) => ({
    operations:
      label === '//tools/bazel/verification:operation_bindings'
        ? obligations.operations
            .filter(
              (name) =>
                !['check:proofs', 'test:fuzz:kani', 'test:sim', 'test:sim:sweep'].includes(name),
            )
            .map((name) => ({
              name,
              checks: STATIC_GATES.includes(name)
                ? [
                    {
                      label: `//policy:${name.replaceAll(':', '_')}`,
                      kind: 'test',
                      fresh: true,
                    } as RequiredCheck,
                  ]
                : [],
              pending: STATIC_GATES.includes(name) ? [] : ['Native qualification pending'],
            }))
        : label === '//tools/bazel/verification:bounded_proof_operation_bindings'
          ? ['check:proofs', 'test:fuzz:kani'].map((name) => ({
              name,
              checks: [
                'proof_proto_frame',
                'proof_data_handshake',
                'proof_frame_header',
                'proof_input_mapping',
                'proof_input_serial_order',
                'proof_rebind_keeper_chain',
              ].map((harness) => ({
                label: `//tools/bazel/rust:kani__${harness}`,
                kind: 'test' as const,
                fresh: true,
              })),
              pending: ['Original native proof qualification pending'],
            }))
          : label === '//tools/bazel/verification:simulator_operation_bindings'
            ? ['test:sim', 'test:sim:sweep'].map((name) => ({
                name,
                checks: [],
                pending: ['Native simulator context pending'],
                simulationOutputs: [],
              }))
            : [],
    crates:
      label === '//tools/bazel/rust:operation_catalog'
        ? obligations.crates.map((name) => ({
            name,
            checks: [],
            pending: ['Native context pending'],
          }))
        : [],
    browserOwners:
      label === '//tools/bazel/bun:operation_bindings'
        ? [{ pattern: 'tests/e2e/**/*.e2e.ts', operations: ['test:e2e:transport'] }]
        : [],
  }));
  const events: unknown[] = [
    { id: { started: {} }, started: { uuid: 'configured-input-test', buildToolVersion: '9.2.0' } },
  ];
  function producer(index: number) {
    const label = CONFIGURED_POLICY_PRODUCERS[index];
    const descriptor = descriptors[index];
    if (label === undefined || descriptor === undefined) throw new Error('Fixture owner absent');
    const name = `${index}.json`;
    const bytes = Buffer.from(JSON.stringify(descriptor));
    writeFileSync(path.join(root, name), bytes);
    return [
      {
        id: { namedSet: { id: String(index) } },
        namedSetOfFiles: {
          files: [
            {
              name,
              digest: createHash('sha256').update(bytes).digest('hex'),
              length: String(bytes.length),
            },
          ],
        },
      },
      {
        id: { targetCompleted: { label, configuration: { id: 'native-config' } } },
        completed: {
          success: true,
          outputGroup: [{ name: 'descriptor', fileSets: [{ id: String(index) }] }],
        },
      },
    ];
  }
  function stream() {
    return [
      ...events,
      ...CONFIGURED_POLICY_PRODUCERS.flatMap((_, i) => producer(i)),
      { id: { buildFinished: {} }, finished: { exitCode: { name: 'SUCCESS' } }, lastMessage: true },
    ]
      .map((event) => JSON.stringify(event))
      .join('\n');
  }
  return { descriptors, stream };
}

test('all configured owner Files are byte-bound and every unresolved obligation survives selection', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'merkur-configured-inputs-'));
  try {
    const current = fixture(root);
    const result = await loadConfiguredPolicyInputs({
      root,
      inventory,
      events: current.stream(),
      exitCode: 0,
    });
    expect(result.artifacts.map((artifact) => artifact.label)).toEqual([
      ...CONFIGURED_POLICY_PRODUCERS,
    ]);
    expect(result.catalog.operations.get('check:proofs')).toHaveLength(6);
    expect(result.simulationOutputs.get('test:sim')).toEqual([]);
    expect(result.pendingQualifications).toContain('test:sim: Native simulator context pending');
    expect(result.pendingQualifications).toContain(
      'check:proofs: Original native proof qualification pending',
    );
    expect(result.pendingQualifications).toContain('rust:deps: Native qualification pending');
    expect(coveragePlan(['docs/security.md'], result.catalog, false).staticOperations).toHaveLength(
      8,
    );
    const events = current.stream();
    writeFileSync(path.join(root, '0.json'), '{}');
    await expect(
      loadConfiguredPolicyInputs({ root, inventory, events, exitCode: 0 }),
    ).rejects.toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an omitted policy row still rejects when its changed artifact digest is coherent', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'merkur-configured-omission-'));
  try {
    const current = fixture(root);
    const owner = current.descriptors[0];
    if (owner === undefined) throw new Error('Fixture owner absent');
    owner.operations = owner.operations.filter((row) => row.name !== 'check:docs');
    await expect(
      loadConfiguredPolicyInputs({ root, inventory, events: current.stream(), exitCode: 0 }),
    ).rejects.toThrow('Unregistered policy operation');
    await expect(
      loadConfiguredPolicyInputs({ root, inventory, events: current.stream(), exitCode: 1 }),
    ).rejects.toThrow('engine evidence');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the bounded proof owner needs its own completed engine descriptor', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'merkur-proof-owner-'));
  try {
    const current = fixture(root);
    const events = current
      .stream()
      .split('\n')
      .filter((line) => {
        const event = JSON.parse(line);
        return (
          event.id?.targetCompleted?.label !==
          '//tools/bazel/verification:bounded_proof_operation_bindings'
        );
      })
      .join('\n');
    await expect(
      loadConfiguredPolicyInputs({ root, inventory, events, exitCode: 0 }),
    ).rejects.toThrow('engine evidence');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
