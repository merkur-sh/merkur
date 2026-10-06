import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  type ConfiguredArtifactProducers,
  captureConfiguredArtifactProducers,
  configuredUnsignedSelection,
  loadConfiguredCiArtifactInputs,
  UNSIGNED_CONTRACT_OUTPUT_GROUP,
} from './configured-artifacts';
import releaseContract from './release-contract.json';

const label = '//tools/bazel/packaging:deployment_unsigned';
const captureInvocation = '11111111-1111-4111-8111-111111111111';
const executionInvocation = '22222222-2222-4222-8222-222222222222';
const prefix = 'bazel-out/native/bin/tools/bazel/packaging';
const output = `${prefix}/deployment.tar.gz`;
const signing = `${prefix}/deployment.inputs.json`;
const descriptorPath = `${prefix}/deployment_unsigned.unsigned-contract.json`;
const contract = {
  label,
  group: 'default',
  outputs: [
    { path: output, destination: 'deployment.tar.gz' },
    { path: signing, destination: 'deployment.inputs.json' },
  ],
};

async function fixture(
  run: (input: {
    root: string;
    events: (invocation: string, descriptor?: unknown, members?: readonly string[]) => string;
    capture: () => Promise<ConfiguredArtifactProducers>;
  }) => Promise<void>,
  selected: typeof contract = contract,
): Promise<void> {
  const root = mkdtempSync(path.join(os.tmpdir(), 'configured-artifacts-'));
  try {
    mkdirSync(path.join(root, prefix), { recursive: true });
    const contents = new Map(
      selected.outputs.map((item) => [
        item.path,
        Buffer.from(`original output fixture: ${item.destination}`),
      ]),
    );
    for (const [name, bytes] of contents) writeFileSync(path.join(root, name), bytes);
    function events(
      invocation: string,
      descriptor: unknown = selected,
      members: readonly string[] = selected.outputs.map((item) => item.path),
    ): string {
      const bytes = new Map([
        [descriptorPath, Buffer.from(JSON.stringify(descriptor))],
        ...contents,
      ]);
      writeFileSync(path.join(root, descriptorPath), bytes.get(descriptorPath) ?? '');
      const file = (name: string) => {
        const content = bytes.get(name);
        if (content === undefined) throw new Error('Fixture has no declared output bytes');
        return {
          name: path.posix.basename(name),
          pathPrefix: path.posix.dirname(name).split('/'),
          digest: createHash('sha256').update(content).digest('hex'),
          length: String(content.length),
        };
      };
      return [
        { id: { started: {} }, started: { uuid: invocation, buildToolVersion: '9.2.0' } },
        {
          id: { namedSet: { id: 'descriptor' } },
          namedSetOfFiles: { files: [file(descriptorPath)] },
        },
        { id: { namedSet: { id: 'outputs' } }, namedSetOfFiles: { files: members.map(file) } },
        {
          id: { targetCompleted: { label: selected.label, configuration: { id: 'native' } } },
          completed: {
            success: true,
            outputGroup: [
              { name: UNSIGNED_CONTRACT_OUTPUT_GROUP, fileSets: [{ id: 'descriptor' }] },
              { name: 'default', fileSets: [{ id: 'outputs' }] },
            ],
          },
        },
        {
          id: { buildFinished: {} },
          finished: { exitCode: { code: 0 } },
          lastMessage: true,
        },
      ]
        .map((event) => JSON.stringify(event))
        .join('\n');
    }
    await run({
      root,
      events,
      capture: () =>
        captureConfiguredArtifactProducers({
          root,
          invocation: captureInvocation,
          events: events(captureInvocation),
          exitCode: 0,
          labels: [selected.label],
        }),
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('captured original configured contracts produce the existing CI artifact inputs', async () => {
  await fixture(async ({ root, events, capture }) => {
    const configured = await capture();
    const result = await loadConfiguredCiArtifactInputs({
      invocation: executionInvocation,
      executionRoot: root,
      events: events(executionInvocation),
      exitCode: 0,
      configured,
    });
    expect(result.invocation).toBe(executionInvocation);
    expect(result.materializedRoot).toBe(root);
    expect(result.producers[0]?.outputs).toHaveLength(2);
    expect(configured.retainedFiles).toHaveLength(1);
    expect(Object.isFrozen(configured)).toBe(true);
  });
});

test('missing or foreign retained File identities and changed inventories refuse extraction', async () => {
  await fixture(async ({ root, events, capture }) => {
    const configured = await capture();
    const retained = configured.retainedFiles[0];
    const producer = configured.producers[0];
    if (retained === undefined || producer === undefined) throw new Error('Incomplete fixture');
    for (const change of [
      { retainedFiles: [] },
      { retainedFiles: [{ ...retained, label: '//tools/bazel/packaging:edge_image_unsigned' }] },
      { retainedFiles: [{ ...retained, configuration: 'foreign' }] },
      { producers: [{ ...producer, configuration: 'foreign' }] },
      { producers: [{ ...producer, outputs: producer.outputs.slice(0, 1) }] },
      {
        producers: [
          {
            ...producer,
            outputs: producer.outputs.map((item) => ({ ...item, destination: 'foreign' })),
          },
        ],
      },
    ]) {
      await expect(
        loadConfiguredCiArtifactInputs({
          invocation: executionInvocation,
          executionRoot: root,
          events: events(executionInvocation),
          exitCode: 0,
          configured: { ...configured, ...change },
        }),
      ).rejects.toThrow();
    }
  });
});

test('original retained contract bytes cannot be replaced by a coherent caller inventory', async () => {
  await fixture(async ({ root, events, capture }) => {
    const configured = await capture();
    const executed = events(executionInvocation);
    writeFileSync(
      path.join(root, descriptorPath),
      JSON.stringify({ ...contract, label: 'foreign' }),
    );
    await expect(
      loadConfiguredCiArtifactInputs({
        invocation: executionInvocation,
        executionRoot: root,
        events: executed,
        exitCode: 0,
        configured,
      }),
    ).rejects.toThrow();
  });
});

test('foreign invocation, configuration, process failure and partial output groups refuse', async () => {
  await fixture(async ({ root, events, capture }) => {
    const configured = await capture();
    const executed = events(executionInvocation);
    for (const change of [
      { invocation: captureInvocation },
      { exitCode: 1 },
      { events: executed.replace('"id":"native"', '"id":"foreign"') },
      { events: executed.replace(UNSIGNED_CONTRACT_OUTPUT_GROUP, 'foreign_contract') },
      { events: executed.replace('"id":"descriptor"', '"id":"foreign_descriptor"') },
      { events: events(executionInvocation, contract, [output]) },
      { events: executed.split('\n').slice(0, -1).join('\n') },
    ]) {
      await expect(
        loadConfiguredCiArtifactInputs({
          invocation: executionInvocation,
          executionRoot: root,
          events: executed,
          exitCode: 0,
          configured,
          ...change,
        }),
      ).rejects.toThrow();
    }
  });
});

test('corrupt materialized unsigned output refuses the original producing digest', async () => {
  await fixture(async ({ root, events, capture }) => {
    const configured = await capture();
    const executed = events(executionInvocation);
    writeFileSync(path.join(root, output), 'foreign archive bytes');
    await expect(
      loadConfiguredCiArtifactInputs({
        invocation: executionInvocation,
        executionRoot: root,
        events: executed,
        exitCode: 0,
        configured,
      }),
    ).rejects.toThrow();
  });
});

test('descriptor capture refuses incomplete providers and invalid original metadata', async () => {
  await fixture(async ({ root, events }) => {
    for (const descriptor of [
      { ...contract, label: '//tools/bazel/packaging:edge_image_unsigned' },
      { ...contract, group: 'archive' },
      { ...contract, outputs: [] },
      { ...contract, outputs: [{ path: '../outside', destination: 'outside' }] },
      { ...contract, outputs: [...contract.outputs, contract.outputs[0]] },
      { ...contract, qualified: true },
    ]) {
      await expect(
        captureConfiguredArtifactProducers({
          invocation: captureInvocation,
          root,
          events: events(captureInvocation, descriptor),
          exitCode: 0,
          labels: [label],
        }),
      ).rejects.toThrow();
    }
    await expect(
      captureConfiguredArtifactProducers({
        invocation: captureInvocation,
        root,
        events: events(captureInvocation),
        exitCode: 0,
        labels: ['//tools/bazel/packaging:unimplemented_release'],
      }),
    ).rejects.toThrow('implemented configured producer');
  });
});

const completePlatforms = {
  'darwin-arm64': ['merkur-daemon-darwin-arm64'],
  'darwin-x86_64': ['merkur-daemon-darwin-x64'],
  'linux-arm64': ['merkur-daemon-linux-arm64', 'verify-linux-arm64'],
  'linux-x86_64': [
    '//release:unsigned_complete',
    'deployment_unsigned',
    'edge_image_unsigned',
    'merkur-daemon-linux-x64',
    'stun_image_unsigned',
    'verify-linux-x64',
  ],
};

test('complete unsigned selection partitions the original ten roles among four native owners', () => {
  const union: string[] = [];
  for (const [platform, roles] of Object.entries(completePlatforms)) {
    const labels = roles.map((role) =>
      role.startsWith('//') ? role : `//tools/bazel/packaging:${role}`,
    );
    const selected = configuredUnsignedSelection(platform, true);
    expect(selected).toEqual(labels);
    expect(Object.isFrozen(selected)).toBe(true);
    union.push(...selected);
    if (platform === 'linux-x86_64')
      expect(configuredUnsignedSelection(platform, false)).toEqual([
        '//tools/bazel/packaging:deployment_unsigned',
      ]);
    else
      expect(() => configuredUnsignedSelection(platform, false)).toThrow(
        'configured producer only on Linux x64',
      );
  }
  expect(union).toHaveLength(releaseContract.artifacts.length);
  expect(new Set(union).size).toBe(10);
  for (const complete of [false, true])
    for (const unsupported of ['foreign-platform', 'constructor', '__proto__', 'linux-x64'])
      expect(() => configuredUnsignedSelection(unsupported, complete)).toThrow(
        'supported native platform',
      );
});

function shippingContract(name: string) {
  const special: Readonly<Record<string, string>> = {
    'NOTICES.txt': '//release:unsigned_complete',
    'edge-image.tar.gz': '//tools/bazel/packaging:edge_image_unsigned',
    'stun-image.tar.gz': '//tools/bazel/packaging:stun_image_unsigned',
  };
  const stem = name.replace(/\.tar\.gz$/, '');
  return {
    label: special[name] ?? `//tools/bazel/packaging:${stem}`,
    group: 'default',
    outputs: [name, ...(name === 'NOTICES.txt' ? [] : [`${stem}.signing-inputs.json`])].map(
      (destination) => ({ path: `${prefix}/${destination}`, destination }),
    ),
  };
}

for (const artifact of releaseContract.artifacts.filter(
  (item) => item.name !== 'deployment.tar.gz',
)) {
  test(`original ${artifact.name} contract requires successful configured execution and exact shipping inventory`, async () => {
    const selected = shippingContract(artifact.name);
    await fixture(async ({ root, events, capture }) => {
      const configured = await capture();
      const executed = events(executionInvocation);
      const inputs = await loadConfiguredCiArtifactInputs({
        invocation: executionInvocation,
        executionRoot: root,
        events: executed,
        exitCode: 0,
        configured,
      });
      expect(inputs.producers[0]?.label).toBe(selected.label);
      expect(inputs.producers[0]?.outputs).toEqual(configured.producers[0]?.outputs);
      for (const invalid of [
        { ...selected, group: 'unsigned_artifacts' },
        { ...selected, outputs: selected.outputs.slice(1) },
        { ...selected, outputs: contract.outputs },
        { ...selected, label: `@foreign${selected.label}` },
      ]) {
        await expect(
          captureConfiguredArtifactProducers({
            invocation: captureInvocation,
            root,
            events: events(captureInvocation, invalid),
            exitCode: 0,
            labels: [selected.label],
          }),
        ).rejects.toThrow();
      }
      events(executionInvocation);
      for (const replacement of [
        { events: executed.replace('"success":true', '"success":false') },
        { events: executed.split('\n').slice(0, -1).join('\n') },
        { exitCode: 1 },
      ]) {
        await expect(
          loadConfiguredCiArtifactInputs({
            invocation: executionInvocation,
            executionRoot: root,
            events: executed,
            exitCode: 0,
            configured,
            ...replacement,
          }),
        ).rejects.toThrow();
      }
    }, selected);
  });
}
