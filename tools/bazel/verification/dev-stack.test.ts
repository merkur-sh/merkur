import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Effect } from 'effect';
import { runDevelopmentStack } from '../../../scripts/dev';
import { prepareDevelopmentEnvironment } from '../../../scripts/dev-server-env';
import { materializeBunRuntime } from '../bun/runtime-materializer';
import { admittedInputs } from './cli';
import {
  DEVELOPMENT_NATIVE_PRODUCERS,
  developmentManifest,
  developmentNativeFiles,
  devStackArguments,
  refreshDevelopmentSource,
  runtimeGraphIdentity,
  sourceGraphChange,
} from './dev-stack';

const config = 'tools/empty.toml';
function manifest() {
  return developmentManifest({
    files: {
      [config]: { runfile: '_main/config', link: false },
      'src/main.ts': { runfile: '_main/src/main.ts', link: false },
      'node_modules/fixture': { runfile: '_main/npm/fixture', link: true },
      '.merkur-dev/vite': { runfile: '_main/vite', link: false },
      '.merkur-dev/vite-preload.ts': { runfile: '_main/preload', link: false },
    },
    cwd: '',
    config,
    execFiles: {
      '_main/config': 'config',
      '_main/src/main.ts': 'src/main.ts',
      '_main/npm/fixture': 'npm/fixture',
      '_main/vite': 'vite',
      '_main/preload': 'preload',
    },
    workspacePackages: {},
    workspace: ['src/main.ts'],
    vite: '.merkur-dev/vite/bin/vite.js',
    preload: '.merkur-dev/vite-preload.ts',
  });
}

test('developer modes have explicit credential and source admission boundaries', () => {
  expect(
    devStackArguments(['--credential-file', '/private/credential', '--with-daemon']).modes,
  ).toEqual(['--with-daemon']);
  for (const args of [
    [],
    ['--credential-file', 'relative'],
    ['--credential-file', '/x', '--web-only', '--with-daemon'],
    ['--credential-file', '/x', '--unknown'],
    ['--credential-file', '/x', '--server-only', '--server-only'],
  ])
    expect(() => devStackArguments(args)).toThrow();
});

test('runtime declarations reject missing Vite, foreign workspace files and unsafe namespaces', () => {
  const valid = manifest();
  expect(valid.workspace).toEqual(['src/main.ts']);
  for (const wrong of [
    { ...valid, unknown: true },
    { ...valid, workspace: ['node_modules/fixture'] },
    { ...valid, workspace: ['src/main.ts', 'src/main.ts'] },
    { ...valid, vite: '../foreign' },
    { ...valid, config: 'absent' },
    { ...valid, files: { ...valid.files, '../escape': { runfile: '_main/escape', link: false } } },
  ])
    expect(() => developmentManifest(wrong)).toThrow();
});

test('mapped source edits stay in the declared npm closure despite conflicting checkout node_modules', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'merkur-dev-source-'));
  const workspace = path.join(directory, 'workspace');
  const runfiles = path.join(directory, 'runfiles');
  const runtime = path.join(directory, 'runtime');
  try {
    await Promise.all(
      ['src', 'node_modules/fixture'].map((name) =>
        mkdir(path.join(workspace, name), { recursive: true }),
      ),
    );
    await Promise.all(
      ['_main/src', '_main/npm/fixture', '_main/vite/bin'].map((name) =>
        mkdir(path.join(runfiles, name), { recursive: true }),
      ),
    );
    await writeFile(
      path.join(workspace, 'node_modules/fixture/package.json'),
      '{"name":"fixture","main":"index.js"}',
    );
    await writeFile(
      path.join(workspace, 'node_modules/fixture/index.js'),
      'export default "ambient";',
    );
    await writeFile(
      path.join(runfiles, '_main/npm/fixture/package.json'),
      '{"name":"fixture","main":"index.js"}',
    );
    await writeFile(
      path.join(runfiles, '_main/npm/fixture/index.js'),
      'export default "declared";',
    );
    for (const name of ['config', 'preload', 'vite/bin/vite.js'])
      await writeFile(path.join(runfiles, '_main', name), '');
    const source = 'import input from "fixture"; process.stdout.write(input+":"+VALUE+"\\n");';
    await writeFile(path.join(workspace, 'src/main.ts'), source.replace('VALUE', '"first"'));
    await writeFile(path.join(runfiles, '_main/src/main.ts'), '');
    const selected = manifest();
    await materializeBunRuntime(selected, runfiles, runtime);
    expect(await refreshDevelopmentSource(selected, workspace, runtime, 'src/main.ts')).toBe(true);
    const child = Bun.spawn(
      [
        process.execPath,
        '--no-install',
        '--no-env-file',
        `--config=${path.join(runtime, config)}`,
        '--watch',
        path.join(runtime, 'src/main.ts'),
      ],
      { cwd: runtime, env: { PATH: '/no/ambient' }, stdout: 'pipe', stderr: 'pipe' },
    );
    const reader = child.stdout.getReader();
    async function output(expected: string): Promise<void> {
      let text = '';
      while (!text.includes(expected)) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error('Watch child closed before expected output');
        text += new TextDecoder().decode(chunk.value);
      }
      expect(text).not.toContain('ambient');
    }
    try {
      await output('declared:first');
      await writeFile(path.join(workspace, 'src/main.ts'), source.replace('VALUE', '"second"'));
      expect(await refreshDevelopmentSource(selected, workspace, runtime, 'src/main.ts')).toBe(
        true,
      );
      await output('declared:second');
      await writeFile(path.join(workspace, 'src/new.ts'), 'new source');
      expect(await refreshDevelopmentSource(selected, workspace, runtime, 'src/new.ts')).toBe(
        false,
      );
      expect(await Bun.file(path.join(runtime, 'src/new.ts')).exists()).toBe(false);
    } finally {
      child.kill('SIGTERM');
      await child.exited;
      reader.releaseLock();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function events(label: string, bytes: Buffer) {
  const target = { targetCompleted: { label, configuration: { id: 'native' } } };
  const set = { namedSet: { id: 'output' } };
  const finish = { buildFinished: {} };
  return [
    {
      id: { started: {} },
      started: { uuid: 'actual-fixture', buildToolVersion: '9.2.0' },
      children: [target, set, finish],
    },
    {
      id: set,
      namedSetOfFiles: {
        files: [
          {
            name: 'actual-executable',
            pathPrefix: ['bin'],
            digest: createHash('sha256').update(bytes).digest('hex'),
            length: String(bytes.length),
          },
        ],
      },
    },
    {
      id: target,
      completed: {
        success: true,
        outputGroup: [{ name: 'default', fileSets: [{ id: 'output' }] }],
      },
    },
    { id: finish, finished: { exitCode: { code: 0 } }, lastMessage: true },
  ]
    .map((entry) => JSON.stringify(entry))
    .join('\n');
}

test('development binaries bind exact actual configured BEP outputs and original sibling names', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'merkur-dev-binary-'));
  try {
    await mkdir(path.join(root, 'bin'));
    await mkdir(path.join(root, 'captured'));
    const bytes = Buffer.from('actual executable bytes');
    await writeFile(path.join(root, 'bin/actual-executable'), bytes, { mode: 0o555 });
    const label = DEVELOPMENT_NATIVE_PRODUCERS.imageWorker;
    const input = {
      executionRoot: root,
      events: events(label, bytes),
      exitCode: 0,
      labels: [label],
      destination: path.join(root, 'captured'),
    };
    const output = (await developmentNativeFiles(input)).get(label);
    expect(output).toBe(path.join(root, 'captured/merkur-image-worker'));
    expect(await readFile(output ?? '')).toEqual(bytes);
    for (const wrong of [
      { ...input, exitCode: null },
      { ...input, exitCode: 1 },
      { ...input, labels: ['//foreign:producer'] },
      { ...input, events: input.events.replace('9.2.0', '9.1.0') },
    ])
      await expect(developmentNativeFiles(wrong)).rejects.toThrow();
    await chmod(path.join(root, 'bin/actual-executable'), 0o755);
    await writeFile(path.join(root, 'bin/actual-executable'), Buffer.alloc(bytes.length));
    await expect(developmentNativeFiles(input)).rejects.toThrow('differs');
    await chmod(path.join(root, 'bin/actual-executable'), 0o444);
    await expect(developmentNativeFiles(input)).rejects.toThrow('executable');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function stackFixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'merkur-dev-stack-'));
  for (const relative of ['apps/server', 'apps/daemon/dataplane/src', 'apps/web'])
    await mkdir(path.join(directory, relative), { recursive: true });
  const environment = await Effect.runPromise(prepareDevelopmentEnvironment('', {}));
  const serverEnvironmentFile = path.join(directory, 'apps/server/.env');
  await writeFile(serverEnvironmentFile, environment.contents);
  const linked = path.join(directory, 'linked.json');
  await writeFile(linked, '{}');
  const script = path.join(directory, 'service.ts');
  await writeFile(
    script,
    `import {appendFileSync} from 'node:fs';
appendFileSync(${JSON.stringify(path.join(directory, 'children.jsonl'))}, JSON.stringify({role:process.argv[2],pid:process.pid,binary:process.env.MERKUR_DATAPLANE_BIN})+String.fromCharCode(10));
setInterval(()=>{},1000);`,
  );
  const edge = path.join(directory, 'edge');
  const ready = `cert_hash_b64=${'A'.repeat(43)}=\nblind WebTransport relay listening\n`;
  await writeFile(
    edge,
    `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(ready)});setInterval(()=>{},1000);`,
    { mode: 0o700 },
  );
  const commands = {
    server: [process.execPath, script, 'server'],
    web: () => [process.execPath, script, 'web'],
    daemon: [process.execPath, script, 'daemon'],
  };
  return { directory, serverEnvironmentFile, linked, edge, commands };
}

test('one owned lifecycle preserves last-good daemon on rebuild failure and replaces it after success', async () => {
  const fixture = await stackFixture();
  let build = 0;
  let fail = false;
  const stack = await runDevelopmentStack({
    root: fixture.directory,
    sourceRoot: fixture.directory,
    serverEnvironmentFile: fixture.serverEnvironmentFile,
    configurationEnvironment: {},
    arguments: ['--with-daemon'],
    environment: { PATH: path.dirname(process.execPath) },
    daemonConfigPath: fixture.linked,
    edgeIdentityDirectory: path.join(fixture.directory, 'identity'),
    commands: fixture.commands,
    doctor: async () => {},
    buildEdge: async () => fixture.edge,
    buildDaemon: async () => {
      if (fail) throw new Error('actual build failed');
      return { MERKUR_DATAPLANE_BIN: `/private/binary-${++build}` };
    },
  });
  async function children() {
    return (await readFile(path.join(fixture.directory, 'children.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { role: string; pid: number; binary?: string });
  }
  try {
    while ((await children()).length < 3) await Bun.sleep(1);
    const before = await children();
    expect(before.map((child) => child.role).sort()).toEqual(['daemon', 'server', 'web']);
    expect(before.find((child) => child.role === 'daemon')?.binary).toBe('/private/binary-1');
    fail = true;
    await stack.rebuildDaemon();
    expect(await children()).toEqual(before);
    fail = false;
    await stack.rebuildDaemon();
    while ((await children()).length < 4) await Bun.sleep(1);
    const after = await children();
    expect(after.filter((child) => child.role === 'daemon').map((child) => child.binary)).toEqual([
      '/private/binary-1',
      '/private/binary-2',
    ]);
    expect(after.filter((child) => child.role === 'server')).toEqual(
      before.filter((child) => child.role === 'server'),
    );
  } finally {
    await stack.stop(0);
    expect(await stack.done).toBe(0);
    for (const child of await children()) expect(() => process.kill(child.pid, 0)).toThrow();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('typed authored npm package links observe source edits within their own declared namespace', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'merkur-dev-authored-'));
  const runfiles = path.join(directory, 'runfiles');
  const runtime = path.join(directory, 'runtime');
  try {
    await mkdir(path.join(runfiles, '_main/packages/authored'), { recursive: true });
    await writeFile(path.join(runfiles, '_main/config'), '');
    await writeFile(
      path.join(runfiles, '_main/packages/authored/package.json'),
      '{"name":"authored","main":"index.ts"}',
    );
    await writeFile(
      path.join(runfiles, '_main/packages/authored/index.ts'),
      'export default "first";',
    );
    await writeFile(
      path.join(runfiles, '_main/main.ts'),
      'import value from "authored";process.stdout.write(value);',
    );
    const files = {
      'packages/authored/package.json': {
        runfile: '_main/packages/authored/package.json',
        link: false,
      },
      'packages/authored/index.ts': { runfile: '_main/packages/authored/index.ts', link: false },
      'node_modules/authored': { runfile: '_main/actual-configured-store', link: true },
      config: { runfile: '_main/config', link: false },
      'main.ts': { runfile: '_main/main.ts', link: false },
    };
    await materializeBunRuntime({ files, cwd: '', config: 'config' }, runfiles, runtime, {
      '_main/actual-configured-store': 'packages/authored',
    });
    const command = [
      process.execPath,
      '--no-install',
      '--no-env-file',
      `--config=${path.join(runtime, 'config')}`,
      path.join(runtime, 'main.ts'),
    ];
    const first = Bun.spawnSync(command, { cwd: runtime, env: { PATH: '/no/ambient' } });
    expect(first.exitCode).toBe(0);
    expect(first.stdout.toString()).toBe('first');
    await writeFile(path.join(runtime, 'packages/authored/index.ts'), 'export default "second";');
    const second = Bun.spawnSync(command, { cwd: runtime, env: { PATH: '/no/ambient' } });
    expect(second.exitCode).toBe(0);
    expect(second.stdout.toString()).toBe('second');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('missing configuration and failed initial native prerequisites launch no services', async () => {
  const fixture = await stackFixture();
  let doctor = 0;
  const runtime = {
    root: fixture.directory,
    sourceRoot: fixture.directory,
    serverEnvironmentFile: fixture.serverEnvironmentFile,
    configurationEnvironment: {},
    arguments: ['--server-only'],
    environment: {},
    daemonConfigPath: fixture.linked,
    edgeIdentityDirectory: path.join(fixture.directory, 'identity'),
    commands: fixture.commands,
    doctor: async () => {
      doctor++;
    },
    buildEdge: async () => {
      throw new Error('Configured compiler is unqualified');
    },
    buildDaemon: async () => ({}),
  };
  try {
    await expect(runDevelopmentStack(runtime)).rejects.toThrow(
      'Configured compiler is unqualified',
    );
    expect(doctor).toBe(1);
    expect(await Bun.file(path.join(fixture.directory, 'children.jsonl')).exists()).toBe(false);
    await rm(fixture.serverEnvironmentFile);
    await expect(runDevelopmentStack(runtime)).rejects.toThrow('preflight');
    expect(doctor).toBe(1);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('stop cancels and joins an owned in-flight rebuild before completing the stack', async () => {
  const fixture = await stackFixture();
  let builds = 0;
  const entered = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<void>();
  const stack = await runDevelopmentStack({
    root: fixture.directory,
    sourceRoot: fixture.directory,
    serverEnvironmentFile: fixture.serverEnvironmentFile,
    configurationEnvironment: {},
    arguments: ['--with-daemon'],
    environment: {},
    daemonConfigPath: fixture.linked,
    edgeIdentityDirectory: path.join(fixture.directory, 'identity'),
    commands: fixture.commands,
    doctor: async () => {},
    buildEdge: async () => fixture.edge,
    buildDaemon: async (signal) => {
      if (++builds === 1) return { MERKUR_DATAPLANE_BIN: '/private/last-good' };
      entered.resolve();
      await new Promise<void>((_resolve, reject) =>
        signal.addEventListener(
          'abort',
          () => {
            cancelled.resolve();
            reject(signal.reason);
          },
          { once: true },
        ),
      );
      throw new Error('Interrupted rebuild cannot publish');
    },
  });
  try {
    const rebuilding = stack.rebuildDaemon();
    await entered.promise;
    await stack.stop(0);
    await rebuilding;
    await cancelled.promise;
    expect(await stack.done).toBe(0);
    expect(builds).toBe(2);
    await writeFile(path.join(fixture.directory, 'apps/daemon/dataplane/src/after-stop.rs'), '');
    expect(builds).toBe(2);
  } finally {
    await stack.stop(0);
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('a source event can propose refresh but only a changed configured File graph authorizes replacement', () => {
  const original = manifest();
  expect(sourceGraphChange(original, 'src/new.ts')).toBe(true);
  expect(sourceGraphChange(original, 'src/deeper/new.ts')).toBe(true);
  expect(sourceGraphChange(original, 'node_modules/foreign/new.ts')).toBe(false);
  expect(sourceGraphChange(original, 'target/foreign-output')).toBe(false);
  expect(sourceGraphChange(original, '.git/index')).toBe(false);
  expect(runtimeGraphIdentity(original)).toBe(runtimeGraphIdentity(manifest()));
  const added = developmentManifest({
    ...original,
    files: { ...original.files, 'src/new.ts': { runfile: '_main/src/new.ts', link: false } },
    execFiles: { ...original.execFiles, '_main/src/new.ts': 'src/new.ts' },
    workspace: [...original.workspace, 'src/new.ts'],
  });
  expect(runtimeGraphIdentity(added)).not.toBe(runtimeGraphIdentity(original));
  const moved = developmentManifest({
    ...added,
    files: Object.fromEntries(
      Object.entries(added.files).filter(([name]) => name !== 'src/main.ts'),
    ),
    workspace: ['src/new.ts'],
  });
  expect(runtimeGraphIdentity(moved)).not.toBe(runtimeGraphIdentity(original));
});

test('failed application preflight retires every registered stack signal handler', async () => {
  const fixture = await stackFixture();
  const before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
  try {
    await expect(
      runDevelopmentStack({
        root: fixture.directory,
        sourceRoot: fixture.directory,
        serverEnvironmentFile: fixture.serverEnvironmentFile,
        configurationEnvironment: {},
        arguments: ['--server-only'],
        environment: {},
        daemonConfigPath: fixture.linked,
        edgeIdentityDirectory: path.join(fixture.directory, 'identity'),
        commands: fixture.commands,
        doctor: async () => {
          throw new Error('Redis preflight failed');
        },
        buildEdge: async () => fixture.edge,
        buildDaemon: async () => ({}),
      }),
    ).rejects.toThrow('Redis preflight failed');
    expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(before);
    expect(await Bun.file(path.join(fixture.directory, 'children.jsonl')).exists()).toBe(false);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('daemon Rust and Swift edits watch the original checkout beside a JS-only runtime', async () => {
  const fixture = await stackFixture();
  const sourceRoot = path.join(fixture.directory, 'original checkout');
  const source = path.join(sourceRoot, 'apps/daemon/dataplane/src');
  await mkdir(source, { recursive: true });
  await rm(path.join(fixture.directory, 'apps/daemon/dataplane'), { recursive: true });
  let builds = 0;
  const swiftRebuilt = Promise.withResolvers<void>();
  const rustRebuilt = Promise.withResolvers<void>();
  const stack = await runDevelopmentStack({
    root: fixture.directory,
    sourceRoot,
    serverEnvironmentFile: fixture.serverEnvironmentFile,
    configurationEnvironment: {},
    arguments: ['--with-daemon'],
    environment: {},
    daemonConfigPath: fixture.linked,
    edgeIdentityDirectory: path.join(fixture.directory, 'identity'),
    commands: fixture.commands,
    doctor: async () => {},
    buildEdge: async () => fixture.edge,
    buildDaemon: async () => {
      builds++;
      if (builds === 2) swiftRebuilt.resolve();
      if (builds === 3) rustRebuilt.resolve();
      return { MERKUR_DATAPLANE_BIN: `/private/original-source-build-${builds}` };
    },
  });
  try {
    expect(await Bun.file(path.join(fixture.directory, 'apps/daemon/dataplane/src')).exists()).toBe(
      false,
    );
    await writeFile(path.join(source, 'identity.swift'), 'original public Swift source');
    await swiftRebuilt.promise;
    expect(builds).toBe(2);
    await writeFile(path.join(source, 'main.rs'), 'original Rust source');
    await rustRebuilt.promise;
    expect(builds).toBe(3);
  } finally {
    await stack.stop(0);
    expect(await stack.done).toBe(0);
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('web-only returns its live lifecycle handle before the owned service exits', async () => {
  const fixture = await stackFixture();
  const starting = runDevelopmentStack({
    root: fixture.directory,
    sourceRoot: fixture.directory,
    serverEnvironmentFile: fixture.serverEnvironmentFile,
    configurationEnvironment: {},
    arguments: ['--web-only'],
    environment: {},
    daemonConfigPath: fixture.linked,
    edgeIdentityDirectory: path.join(fixture.directory, 'identity'),
    commands: fixture.commands,
    doctor: async () => {},
    buildEdge: async () => fixture.edge,
    buildDaemon: async () => ({}),
  });
  let stack: Awaited<typeof starting> | undefined;
  try {
    stack = await Promise.race([starting, Bun.sleep(500).then(() => undefined)]);
    expect(stack).toBeDefined();
    if (stack === undefined)
      throw new Error('The live web service must return its lifecycle handle');
    while (!(await Bun.file(path.join(fixture.directory, 'children.jsonl')).exists()))
      await Bun.sleep(1);
    const child = JSON.parse(
      await readFile(path.join(fixture.directory, 'children.jsonl'), 'utf8'),
    ) as { role: string; pid: number };
    expect(child.role).toBe('web');
    expect(() => process.kill(child.pid, 0)).not.toThrow();
    await stack.stop(0);
    expect(await stack.done).toBe(0);
    expect(() => process.kill(child.pid, 0)).toThrow();
  } finally {
    if (
      stack === undefined &&
      (await Bun.file(path.join(fixture.directory, 'children.jsonl')).exists())
    ) {
      const child = JSON.parse(
        await readFile(path.join(fixture.directory, 'children.jsonl'), 'utf8'),
      ) as { pid: number };
      process.kill(child.pid, 'SIGTERM');
    }
    await (await starting).stop(0);
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('developer and verification source admission share the exact ordinary File unique list', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'merkur-dev-admission-'));
  const file = path.join(directory, 'selected source files.json');
  try {
    expect(await admittedInputs(undefined)).toEqual([]);
    const selected = ['apps/server/src/index.ts', 'packages/shared/src/index.ts'];
    await writeFile(file, JSON.stringify(selected));
    expect(await admittedInputs(file)).toEqual(selected);
    await writeFile(file, JSON.stringify([selected[0], selected[0]]));
    await expect(admittedInputs(file)).rejects.toThrow('exact unique JSON list');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
