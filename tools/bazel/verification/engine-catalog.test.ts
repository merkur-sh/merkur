import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SOURCE_TEST_QUERY, sourceInventory } from './engine-catalog';
import { DeclaredEngineProcess, engineQueryReceipt } from './engine-process';

function unboundEngine() {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), 'merkur-engine-origin-')));
  mkdirSync(path.join(directory, 'ssl'));
  writeFileSync(path.join(directory, 'ssl', 'cert.pem'), 'unexecuted trust-bundle fixture');
  const tools = {
    bazel: '/declared/bazel',
    acquisition: '/declared/acquisition.json',
    git: '/declared/git',
    credentialHelper: '/declared/helper',
    credentialFile: '/declared/auth.bazelrc',
    runfiles: '/declared/runfiles',
    sdkEnvironment: { MERKUR_BAZEL_NATIVE_SDK_PREFIX: directory },
  };
  return { directory, tools };
}

test('an engine identity is owned validation, not caller supplied paths and a digest', () => {
  const fixture = unboundEngine();
  try {
    const engine = new DeclaredEngineProcess(
      fixture.tools,
      fixture.directory,
      new AbortController().signal,
    );
    expect(() =>
      engine.bind({ executable: fixture.tools.bazel, digest: 'a'.repeat(64) }, fixture.directory),
    ).toThrow('validated');
    expect(Object.isFrozen(engine.environment)).toBe(true);
    expect(Object.isFrozen(engine.tools)).toBe(true);
    expect(Object.isFrozen(engine.tools.sdkEnvironment)).toBe(true);
    fixture.tools.sdkEnvironment.MERKUR_BAZEL_NATIVE_SDK_PREFIX = '/ambient';
    fixture.tools.bazel = '/ambient/bazel';
    expect(engine.tools.bazel).toBe('/declared/bazel');
    expect(engine.environment.PATH).toBe(path.join(fixture.directory, 'bin'));
    expect(engine.environment.MERKUR_BUILDBUDDY_AUTH_FILE).toBe('/declared/auth.bazelrc');
    expect(engine.backendFlags()).toContain('--remote_cache=grpcs://remote.buildbuddy.io');
    expect(engine.backendFlags()).toContain(
      '--credential_helper=remote.buildbuddy.io=/declared/helper',
    );
    expect(engine.backendFlags()).toContain('--build_event_json_file_path_conversion=false');
    expect(() => Object.defineProperty(engine, 'environment', { value: {} })).toThrow();
    expect(() => Object.defineProperty(engine, 'tools', { value: fixture.tools })).toThrow();
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('only a private engine writes the shared service, and no query streams its answer', async () => {
  const fixture = unboundEngine();
  const stream = '--bes_backend=grpcs://remote.buildbuddy.io';
  try {
    const signal = new AbortController().signal;
    const authoritative = new DeclaredEngineProcess(fixture.tools, fixture.directory, signal);
    expect(authoritative.backendFlags()).not.toContain('--noremote_upload_local_results');
    expect(authoritative.backendFlags()).toContain(stream);
    expect(authoritative.queryBackendFlags()).not.toContain(stream);
    expect(authoritative.queryBackendFlags()).toContain(
      '--remote_cache=grpcs://remote.buildbuddy.io',
    );
    await expect(
      authoritative.query(fixture.directory, 'aquery', '//:target', 'jsonproto', [
        ...authoritative.queryBackendFlags(),
        '--remote_executor=',
        stream,
      ]),
    ).rejects.toThrow('controlled');
    const run = path.join(fixture.directory, 'run');
    mkdirSync(run);
    const kept = new DeclaredEngineProcess(
      fixture.tools,
      run,
      signal,
      path.join(fixture.directory, 'home'),
    );
    expect(kept.backendFlags()).toContain('--remote_cache=grpcs://remote.buildbuddy.io');
    expect(kept.backendFlags()).toContain('--noremote_upload_local_results');
    expect(kept.backendFlags()).not.toContain(stream);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('a public run override cannot fabricate a completed query', async () => {
  const fixture = unboundEngine();
  let overridden = false;
  class FabricatedRun extends DeclaredEngineProcess {
    override async run() {
      overridden = true;
      return { stdout: '{}', exitCode: 0 };
    }
  }
  try {
    const engine = new FabricatedRun(
      fixture.tools,
      fixture.directory,
      new AbortController().signal,
    );
    await expect(
      engine.query(fixture.directory, 'aquery', 'deps(//:target)', 'jsonproto', [
        '--remote_executor=',
      ]),
    ).rejects.toThrow('validated');
    expect(overridden).toBe(false);
    expect(() =>
      engineQueryReceipt({
        expression: 'deps(//:target)',
        format: 'jsonproto',
        buildToolVersion: '9.2.0',
        exitCode: 0,
        stdout: '{}',
      }),
    ).toThrow('no owned');
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('a public backend flags override cannot authorize a different transport', async () => {
  const fixture = unboundEngine();
  class ForgedBackend extends DeclaredEngineProcess {
    override backendFlags() {
      return ['--remote_cache=https://untrusted.example'];
    }
  }
  try {
    const engine = new ForgedBackend(
      fixture.tools,
      fixture.directory,
      new AbortController().signal,
    );
    await expect(
      engine.query(fixture.directory, 'aquery', '//:target', 'jsonproto', engine.backendFlags()),
    ).rejects.toThrow('controlled');
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('query flags cannot override status, RC, configuration or invocation policy', async () => {
  const fixture = unboundEngine();
  try {
    const engine = new DeclaredEngineProcess(
      fixture.tools,
      fixture.directory,
      new AbortController().signal,
    );
    const disguised = ['--config=ambient'];
    disguised.some = () => false;
    await expect(
      engine.query(fixture.directory, 'aquery', '//:target', 'jsonproto', disguised),
    ).rejects.toThrow('controlled');
    for (const flag of [
      '--workspace_status_command=/ambient',
      '--workspace_status_command=',
      '--config=ambient',
      '--flagfile=/ambient',
      '--invocation_policy={}',
      '--bazelrc=/ambient',
      '--remote_cache=https://ambient',
      '--remote_cache=',
      '--bes_backend=',
      '--credential_helper=remote.buildbuddy.io=/ambient/helper',
      '--remote_header=x-buildbuddy-api-key=synthetic-key',
      '--build_event_json_file_path_conversion=true',
    ])
      await expect(
        engine.query(fixture.directory, 'aquery', '//:target', 'jsonproto', [flag]),
      ).rejects.toThrow('controlled');
    await expect(
      engine.query(fixture.directory, 'aquery', '//:target', 'jsonproto', [
        '--enable_bzlmod',
        '--enable_bzlmod',
      ]),
    ).rejects.toThrow('controlled');
    await expect(
      engine.query(fixture.directory, 'aquery', '//:target', 'jsonproto', [
        '--override_repository=verification_context=/declared/a',
        '--override_repository=verification_context=/declared/b',
      ]),
    ).rejects.toThrow('controlled');
    await expect(
      engine.query(fixture.directory, 'aquery', '--config=ambient', 'jsonproto', []),
    ).rejects.toThrow('controlled');
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

function fixture() {
  const labels = ['//apps/server:unit', '//scripts:unit'];
  const files = ['apps/server/unit.test.ts', 'scripts/unit.test.ts'];
  const paths = [files[0], 'packages/shared/library.ts', 'bazel-out/config/helper.wasm', files[1]];
  const pathFragments: { id: number; parentId?: number; label: string }[] = [];
  const artifacts = paths.map((name, index) => {
    if (name === undefined) throw new Error('Missing fixture path');
    let parent: number | undefined;
    for (const label of name.split('/')) {
      const id = pathFragments.length + 1;
      pathFragments.push({ id, parentId: parent, label });
      parent = id;
    }
    return { id: index + 1, pathFragmentId: parent };
  });
  const rules = labels.map((label, index) => ({
    type: 'RULE',
    rule: {
      name: label,
      ruleClass: 'bun_test',
      attribute: [
        { name: 'test_files', stringListValue: [files[index]] },
        { name: 'tags', stringListValue: ['manual', 'unqualified-runtime'] },
      ],
    },
  }));
  const graph = {
    pathFragments,
    artifacts,
    targets: labels.map((label, index) => ({ id: index + 1, label })),
    depSetOfFiles: [
      { id: 1, directArtifactIds: [2] },
      { id: 2, directArtifactIds: [1, 3] },
      { id: 3, directArtifactIds: [4, 3] },
    ],
    actions: [
      { inputDepSetIds: [1], outputIds: [3] },
      { inputDepSetIds: [2], mnemonic: 'TestRunner', targetId: 1 },
      { inputDepSetIds: [3], mnemonic: 'TestRunner', targetId: 2 },
    ],
  };
  return { rules, graph };
}

function capture(value: ReturnType<typeof fixture>) {
  return sourceInventory(
    {
      expression: SOURCE_TEST_QUERY,
      format: 'streamed_jsonproto',
      buildToolVersion: '9.2.0',
      exitCode: 0,
      stdout: value.rules.map((rule) => JSON.stringify(rule)).join('\n'),
    },
    {
      expression: `deps(set(${value.rules
        .map((rule) => rule.rule.name)
        .sort()
        .join(' ')}))`,
      format: 'jsonproto',
      buildToolVersion: '9.2.0',
      exitCode: 0,
      stdout: JSON.stringify(value.graph),
    },
  );
}

test('engine membership and generated-artifact consumers form complete owning suites', () => {
  const inventory = capture(fixture());
  expect(inventory.tests).toHaveLength(2);
  expect(inventory.tests[0]?.inputs).toEqual([
    'apps/server/unit.test.ts',
    'packages/shared/library.ts',
  ]);
  expect(inventory.tests[1]?.inputs).toEqual([
    'packages/shared/library.ts',
    'scripts/unit.test.ts',
  ]);
  expect(inventory.suites.get('apps/server')).toEqual(['apps/server/unit.test.ts']);
  expect(inventory.suites.get('apps/daemon')).toEqual([]);
  expect(inventory.tests.some((test) => test.check.fresh)).toBe(false);
  const reordered = fixture();
  reordered.rules.reverse();
  expect(capture(reordered).digest).toBe(inventory.digest);
});

test('rejects omissions, duplicate targets and claimed source files absent from their action', () => {
  const omitted = fixture();
  omitted.graph.actions.pop();
  expect(() => capture(omitted)).toThrow('exactly one');
  const duplicate = fixture();
  const rule = duplicate.rules[0];
  if (rule === undefined) throw new Error('Missing fixture rule');
  duplicate.rules.push(rule);
  expect(() => capture(duplicate)).toThrow('duplicate');
  const wrongFile = fixture();
  wrongFile.graph.depSetOfFiles[1] = { id: 2, directArtifactIds: [3] };
  expect(() => capture(wrongFile)).toThrow('does not read');
});

test('rejects multiple-file aggregation, escaping paths and non-rule query output', () => {
  const grouped = fixture();
  grouped.rules[0]?.rule.attribute[0]?.stringListValue.push('apps/server/other.test.ts');
  expect(() => capture(grouped)).toThrow('exactly one');
  const escaping = fixture();
  const attribute = escaping.rules[0]?.rule.attribute[0];
  if (attribute === undefined) throw new Error('Missing fixture attribute');
  attribute.stringListValue = ['../private'];
  expect(() => capture(escaping)).toThrow('canonical');
  expect(() =>
    sourceInventory(
      {
        expression: SOURCE_TEST_QUERY,
        format: 'streamed_jsonproto',
        buildToolVersion: '9.2.0',
        exitCode: 0,
        stdout: '{"type":"SOURCE_FILE"}',
      },
      { expression: '', format: 'jsonproto', buildToolVersion: '9.2.0', exitCode: 0, stdout: '{}' },
    ),
  ).toThrow('non-rule');
});

test('a partial or failed engine query cannot attest complete owning suites', () => {
  const value = fixture();
  const query = {
    expression: 'kind(bun_test, //apps/server:unit)',
    format: 'streamed_jsonproto' as const,
    buildToolVersion: '9.2.0',
    exitCode: 0,
    stdout: value.rules.map((rule) => JSON.stringify(rule)).join('\n'),
  };
  const actions = {
    expression: 'deps(//apps/server:unit)',
    format: 'jsonproto' as const,
    buildToolVersion: '9.2.0',
    exitCode: 0,
    stdout: JSON.stringify(value.graph),
  };
  expect(() => sourceInventory(query, actions)).toThrow('Incomplete');
  expect(() => sourceInventory({ ...query, expression: SOURCE_TEST_QUERY }, actions)).toThrow(
    'complete',
  );
  expect(() =>
    sourceInventory({ ...query, expression: SOURCE_TEST_QUERY, exitCode: 1 }, actions),
  ).toThrow('Incomplete');
  expect(() =>
    sourceInventory(
      { ...query, expression: SOURCE_TEST_QUERY, buildToolVersion: '9.3.0' },
      actions,
    ),
  ).toThrow('mismatched');
});
