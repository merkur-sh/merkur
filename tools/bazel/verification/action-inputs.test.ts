import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { declaredSourcePaths, testNonceInputPaths, testSourcePaths } from './action-inputs';

function graph() {
  return {
    pathFragments: [
      { id: 1, label: 'apps' },
      { id: 2, parentId: 1, label: 'input.ts' },
      { id: 3, label: 'external' },
      { id: 4, parentId: 3, label: 'compiler' },
      { id: 5, label: 'bazel-out' },
      { id: 6, parentId: 5, label: 'copied.ts' },
      { id: 7, label: '.gitignore' },
    ],
    artifacts: [
      { id: 1, pathFragmentId: 2 },
      { id: 2, pathFragmentId: 4 },
      { id: 3, pathFragmentId: 6 },
      { id: 4, pathFragmentId: 7 },
    ],
    depSetOfFiles: [
      { id: 1, directArtifactIds: [1, 2, 4] },
      { id: 2, directArtifactIds: [3], transitiveDepSetIds: [1] },
    ],
    actions: [{ inputDepSetIds: [1], outputIds: [3] }, { inputDepSetIds: [2] }],
  };
}

test('captures transitive first-party action inputs and approved hidden configuration', () => {
  expect(declaredSourcePaths(JSON.stringify(graph()))).toEqual(['.gitignore', 'apps/input.ts']);
});

test('rejects incomplete dependencies, duplicate identities and graph cycles', () => {
  const missing = graph();
  missing.depSetOfFiles[1]?.transitiveDepSetIds?.push(99);
  expect(() => declaredSourcePaths(JSON.stringify(missing))).toThrow('Missing');
  const duplicate = graph();
  duplicate.artifacts.push({ id: 1, pathFragmentId: 2 });
  expect(() => declaredSourcePaths(JSON.stringify(duplicate))).toThrow('Duplicate');
  const cycle = graph();
  cycle.depSetOfFiles[1]?.transitiveDepSetIds?.push(2);
  expect(() => declaredSourcePaths(JSON.stringify(cycle))).toThrow('Cyclic');
});

test('rejects escaping paths, missing artifact paths and empty input graphs', () => {
  const escaping = graph();
  const fragment = escaping.pathFragments[0];
  if (fragment === undefined) throw new Error('Missing fixture');
  fragment.label = '../escape';
  expect(() => declaredSourcePaths(JSON.stringify(escaping))).toThrow('Unsafe');
  const missing = graph();
  missing.artifacts[0] = { id: 1, pathFragmentId: 999 };
  expect(() => declaredSourcePaths(JSON.stringify(missing))).toThrow('Missing');
  expect(() => declaredSourcePaths(JSON.stringify({ ...graph(), actions: [] }))).toThrow('empty');
});

test('maps source consumers through generated artifacts to their actual test action', () => {
  const value = {
    ...graph(),
    targets: [{ id: 1, label: '//apps:unit' }],
    actions: [
      { inputDepSetIds: [1], outputIds: [3] },
      { inputDepSetIds: [2], mnemonic: 'TestRunner', targetId: 1 },
    ],
  };
  expect([...testSourcePaths(JSON.stringify(value), ['//apps:unit'])]).toEqual([
    ['//apps:unit', ['.gitignore', 'apps/input.ts']],
  ]);
  expect(() => testSourcePaths(JSON.stringify(value), ['//apps:missing'])).toThrow('exactly one');
  value.actions.push({ inputDepSetIds: [2], mnemonic: 'TestRunner', targetId: 1 });
  expect(() => testSourcePaths(JSON.stringify(value), ['//apps:unit'])).toThrow('exactly one');
});

test('rejects generated inputs without producer authority and cyclic output dependencies', () => {
  const value = graph();
  value.actions.shift();
  expect(() => declaredSourcePaths(JSON.stringify(value))).toThrow('missing producer');
  value.actions[0] = { inputDepSetIds: [2], outputIds: [3] };
  expect(() => declaredSourcePaths(JSON.stringify(value))).toThrow('Cyclic generated');
});

test('coalesces exact configured shared actions and rejects competing output producers', () => {
  const original = graph();
  const first = original.actions[0];
  if (first === undefined) throw new Error('Missing producer fixture');
  const producer = {
    ...first,
    actionKey: 'a'.repeat(64),
    mnemonic: 'Symlink',
    configurationId: 1,
    targetId: 1,
    primaryOutputId: 3,
    executionPlatform: '@@platforms//host:host',
  };
  const value = { ...original, actions: [producer, { ...producer }, original.actions[1]] };
  expect(declaredSourcePaths(JSON.stringify(value))).toEqual(['.gitignore', 'apps/input.ts']);
  for (const competing of [
    { ...producer, actionKey: 'b'.repeat(64) },
    { ...producer, inputDepSetIds: [2] },
    { ...producer, configurationId: 2 },
    { ...producer, executionPlatform: '//platforms:other' },
  ])
    expect(() =>
      declaredSourcePaths(JSON.stringify({ ...value, actions: [producer, competing] })),
    ).toThrow('Duplicate action output producer');
  for (const malformed of [
    { ...producer, configurationId: null },
    { ...producer, configurationId: true },
    { ...producer, configurationId: 0 },
    { ...producer, targetId: 0 },
    { ...producer, executionPlatform: null },
    { ...producer, mnemonic: null },
  ])
    expect(() =>
      declaredSourcePaths(JSON.stringify({ ...value, actions: [malformed, { ...malformed }] })),
    ).toThrow('Duplicate action output producer');
});

function nonceGraph() {
  const label = '//apps:unit';
  const repository = 'external/+local_repository+verification_revocations';
  const hash = createHash('sha256').update(label).digest('hex');
  const identity = {
    actionKey: 'a'.repeat(64),
    configurationId: 1,
    targetId: 1,
    executionPlatform: '@@platforms//host:host',
  };
  return {
    label,
    repository,
    graph: {
      targets: [{ id: 1, label }],
      configuration: [
        { id: 1, checksum: 'c'.repeat(64) },
        { id: 2, checksum: 'd'.repeat(64) },
      ],
      pathFragments: [
        { id: 1, label: 'external' },
        { id: 2, parentId: 1, label: '+local_repository+verification_revocations' },
        { id: 3, parentId: 2, label: 'nonce' },
        { id: 4, parentId: 3, label: `${hash}.txt` },
        { id: 5, label: 'bazel-out' },
        { id: 6, parentId: 5, label: 'unit.runfiles' },
        { id: 7, parentId: 2, label: 'BUILD.bazel' },
      ],
      artifacts: [
        { id: 1, pathFragmentId: 4 },
        { id: 2, pathFragmentId: 6, isTreeArtifact: true },
        { id: 3, pathFragmentId: 7 },
      ],
      depSetOfFiles: [
        { id: 1, directArtifactIds: [1] },
        { id: 2, directArtifactIds: [2] },
      ],
      actions: [
        { ...identity, mnemonic: 'FileWrite', inputDepSetIds: [], outputIds: [] },
        { ...identity, mnemonic: 'RunfilesTree', inputDepSetIds: [1], outputIds: [2] },
        { ...identity, mnemonic: 'TestRunner', inputDepSetIds: [2], outputIds: [] },
      ],
    },
  };
}

test('nonce binding follows the generated runfiles tree without requiring launcher inputs', () => {
  const { graph: value, label, repository } = nonceGraph();
  expect([...testNonceInputPaths(JSON.stringify(value), [label], repository)]).toEqual([
    [label, `${repository}/nonce/${createHash('sha256').update(label).digest('hex')}.txt`],
  ]);
});

test('nonce binding refuses foreign nonce, repository metadata and compiler input edges', () => {
  for (const mutation of ['foreign', 'metadata', 'launcher', 'missing'] as const) {
    const { graph: value, label, repository } = nonceGraph();
    const fragment = value.pathFragments.find((row) => row.id === 4);
    const set = value.depSetOfFiles[0];
    const write = value.actions[0];
    if (fragment === undefined || set === undefined || write === undefined)
      throw new Error('Incomplete nonce fixture');
    if (mutation === 'foreign') fragment.label = `${'b'.repeat(64)}.txt`;
    if (mutation === 'metadata') set.directArtifactIds.push(3);
    if (mutation === 'launcher') write.inputDepSetIds = [1];
    if (mutation === 'missing') set.directArtifactIds = [];
    expect(() => testNonceInputPaths(JSON.stringify(value), [label], repository)).toThrow(
      'Nonce must belong only',
    );
  }
});

test('nonce binding refuses incomplete, duplicated and unconfigured TestRunner evidence', () => {
  const { graph: original, label, repository } = nonceGraph();
  for (const mutation of ['producer', 'runner', 'configuration'] as const) {
    const value = structuredClone(original);
    const runner = value.actions[2];
    if (runner === undefined) throw new Error('Missing nonce runner');
    if (mutation === 'producer') value.actions.splice(1, 1);
    if (mutation === 'runner') value.actions.push({ ...runner });
    if (mutation === 'configuration') runner.configurationId = 0;
    expect(() => testNonceInputPaths(JSON.stringify(value), [label], repository)).toThrow();
  }
  for (const [labels, carrier] of [
    [[], repository],
    [[label, label], repository],
    [[label], 'external/../foreign'],
  ] as const)
    expect(() => testNonceInputPaths(JSON.stringify(original), labels, carrier)).toThrow();
});

test('nonce binding resolves duplicate artifact paths to producers and refuses mixed configurations', () => {
  for (const mutation of ['generated', 'dangling', 'mixed', 'tool'] as const) {
    const { graph: value, label, repository } = nonceGraph();
    const write = value.actions[0];
    const tree = value.actions[1];
    const runner = value.actions[2];
    if (write === undefined || tree === undefined || runner === undefined)
      throw new Error('Incomplete nonce fixture');
    if (mutation === 'generated') {
      value.artifacts.push({ id: 4, pathFragmentId: 4 });
      write.outputIds = [4];
    }
    if (mutation === 'dangling') runner.configurationId = 999;
    if (mutation === 'mixed') tree.configurationId = 2;
    if (mutation === 'tool') Object.assign(value.configuration[0] ?? {}, { isTool: true });
    expect(() => testNonceInputPaths(JSON.stringify(value), [label], repository)).toThrow();
  }
});
