import { afterEach, expect, test } from 'bun:test';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BazelVerificationEngine } from './bazel-engine';
import { declaredTools } from './cli';
import { DeclaredEngineProcess } from './engine-process';
import { type ExecutorPolicy, NATIVE_EXECUTION_PLATFORMS } from './executor-policy';

// Synthetic process I/O exercises the actual adapter, not native Bazel, server or admission proof.
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture(
  options: Pick<
    ConstructorParameters<typeof BazelVerificationEngine>[0],
    'platform' | 'executionPolicy' | 'qualifyExecution'
  > = {},
) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'development engine ')));
  directories.push(root);
  const source = path.join(root, 'source');
  const directory = path.join(root, 'private');
  const sdk = path.join(root, 'sdk');
  for (const member of [source, directory, path.join(sdk, 'bin'), path.join(sdk, 'ssl')])
    mkdirSync(member, { recursive: true });
  writeFileSync(path.join(sdk, 'ssl', 'cert.pem'), 'synthetic declared CA fixture\n');
  writeFileSync(path.join(sdk, 'bin', 'git'), 'synthetic declared Git member\n');
  chmodSync(path.join(sdk, 'bin', 'git'), 0o555);
  const tools = {
    bazel: path.join(root, 'declared-bazel'),
    acquisition: path.join(root, 'acquisition.json'),
    git: path.join(sdk, 'bin', 'git'),
    credentialHelper: path.join(root, 'declared-helper'),
    credentialFile: path.join(root, 'unread-credential'),
    runfiles: root,
    sdkEnvironment: { MERKUR_BAZEL_NATIVE_SDK_PREFIX: sdk },
  };
  const engine = new BazelVerificationEngine({
    root: source,
    directory,
    tools,
    signal: new AbortController().signal,
    admittedUntracked: [],
    all: false,
    ...options,
  });
  const process = Reflect.get(engine, 'process');
  if (!(process instanceof DeclaredEngineProcess)) throw new Error('Original process required');
  const calls: { root: string; command: string; args: readonly string[] }[] = [];
  const executionRoot = path.join(root, 'execution');
  mkdirSync(executionRoot);
  let exitCode: number | null = 0;
  let events = 'ordinary synthetic BEP bytes\n';
  let infoExit = 0;
  let infoOutput = `${executionRoot}\n`;
  let writeEvents = true;
  function control() {
    Object.defineProperty(process, 'run', {
      value: async (cwd: string, command: string, args: readonly string[]) => {
        calls.push({ root: cwd, command, args: [...args] });
        if (command === 'info') return { stdout: infoOutput, stderr: '', exitCode: infoExit };
        expect(command).toBe('build');
        const file = args.find((arg) => arg.startsWith('--build_event_json_file='));
        if (file === undefined) throw new Error('Original build BEP argument required');
        if (writeEvents) writeFileSync(file.slice('--build_event_json_file='.length), events);
        return { stdout: '', stderr: '', exitCode };
      },
    });
  }
  return {
    root,
    source,
    directory,
    sdk,
    tools,
    engine,
    process,
    calls,
    executionRoot,
    control,
    result(code: number | null, body = events) {
      exitCode = code;
      events = body;
    },
    missingEvents() {
      writeEvents = false;
    },
    info(code: number, output = infoOutput) {
      infoExit = code;
      infoOutput = output;
    },
  };
}

test('buildArtifacts uses guarded build flags, fresh BEP files and original execution root without test dispatch', async () => {
  const f = fixture();
  f.control();
  const first = await f.engine.buildArtifacts(['//apps/server:server', '//apps/server:migrations']);
  expect(first).toEqual({
    executionRoot: f.executionRoot,
    events: 'ordinary synthetic BEP bytes\n',
    exitCode: 0,
  });
  f.result(0, 'fresh second BEP\n');
  const second = await f.engine.buildArtifacts(
    ['//apps/web:frontend'],
    ['default', 'development_runtime'],
  );
  expect(second.events).toBe('fresh second BEP\n');
  expect(f.calls.map((call) => call.command)).toEqual(['build', 'info', 'build', 'info']);
  expect(f.calls.every((call) => call.root === f.source)).toBe(true);
  const builds = f.calls.filter((call) => call.command === 'build');
  const files = builds.map((call) =>
    call.args.find((arg) => arg.startsWith('--build_event_json_file=')),
  );
  expect(new Set(files).size).toBe(2);
  for (const call of builds) {
    expect(call.args).toContain('--guard_against_concurrent_changes');
    expect(call.args).toContain('--incompatible_strict_action_env');
    expect(call.args).toContain('--remote_verify_downloads');
    expect(call.args).toContain('--remote_download_outputs=all');
    expect(call.args).toContain('--remote_executor=');
    expect(call.args).toContain('--disk_cache=');
    expect(call.args).toContain('--remote_cache=grpcs://remote.buildbuddy.io');
    expect(call.args).toContain(
      `--credential_helper=remote.buildbuddy.io=${f.tools.credentialHelper}`,
    );
    expect(
      call.args.some((arg) => arg.startsWith('--override_repository=verification_revocations=')),
    ).toBe(false);
    expect(call.args.filter((arg) => arg.startsWith('--invocation_id='))).toHaveLength(1);
  }
  expect(builds[0]?.args.slice(0, 2)).toEqual(['//apps/server:server', '//apps/server:migrations']);
  expect(builds[0]?.args.some((arg) => arg.startsWith('--output_groups='))).toBe(false);
  expect(builds[1]?.args.filter((arg) => arg.startsWith('--output_groups='))).toEqual([
    '--output_groups=default,development_runtime',
  ]);
  expect(
    f.calls
      .filter((call) => call.command === 'info')
      .every((call) => !call.args.some((arg) => arg.startsWith('--output_groups='))),
  ).toBe(true);
});

test('invalid comma option duplicate and empty output groups refuse before command I/O', async () => {
  const f = fixture();
  f.control();
  for (const groups of [
    ['default,development_runtime'],
    ['--keep_going'],
    ['--output_groups=default'],
    ['default', 'default'],
    [''],
    ['default', ''],
    ['default', 'foreign group'],
  ])
    await expect(f.engine.buildArtifacts(['//apps/server:server'], groups)).rejects.toThrow(
      'distinct named output groups',
    );
  expect(f.calls).toEqual([]);
});

test('failed build preserves process exit and raw partial BEP without asserting success', async () => {
  const f = fixture();
  f.control();
  f.result(1, 'partial failure BEP\n');
  expect(await f.engine.buildArtifacts(['//apps/server:server'])).toEqual({
    executionRoot: f.executionRoot,
    events: 'partial failure BEP\n',
    exitCode: 1,
  });
  f.result(null, 'signal partial BEP\n');
  expect((await f.engine.buildArtifacts(['//apps/server:server'])).exitCode).toBeNull();
});

test('missing fresh BEP and invalid materialized execution roots refuse', async () => {
  const missing = fixture();
  missing.control();
  missing.missingEvents();
  await expect(missing.engine.buildArtifacts(['//apps/server:server'])).rejects.toThrow();
  for (const [code, output] of [
    [1, '/original/root\n'],
    [0, 'relative/root\n'],
    [0, '/one\n/two\n'],
  ] as const) {
    const f = fixture();
    f.control();
    f.info(code, output);
    await expect(f.engine.buildArtifacts(['//apps/server:server'])).rejects.toThrow(
      'materialized execution root',
    );
  }
});

test('empty duplicate and invalid explicit labels refuse before command I/O', async () => {
  const f = fixture();
  f.control();
  for (const labels of [
    [],
    ['//apps/server:server', '//apps/server:server'],
    ['@foreign//:target'],
    ['//apps/server'],
    ['//apps/server:'],
    ['//apps/server:server extra'],
    ['--all'],
  ])
    await expect(f.engine.buildArtifacts(labels)).rejects.toThrow(
      'distinct declared target labels',
    );
  expect(f.calls).toEqual([]);
});

test('developmentEnvironment returns detached sealed process environment without ambient inheritance', () => {
  const f = fixture();
  const first = f.engine.developmentEnvironment;
  expect(first).toEqual(f.process.environment);
  first.PATH = '/foreign';
  first.MERKUR_BUILDBUDDY_AUTH_FILE = '/foreign-secret';
  first.EXTRA = 'foreign';
  const second = f.engine.developmentEnvironment;
  expect(second).toEqual(f.process.environment);
  expect(second.PATH).toBe(path.join(f.sdk, 'bin'));
  expect(second.MERKUR_BUILDBUDDY_AUTH_FILE).toBe(f.tools.credentialFile);
  expect(second.EXTRA).toBeUndefined();
  expect(second.GIT_SSL_NO_VERIFY).toBeUndefined();
});

test('actual unbound and closed process guards prevent build dispatch; empty close is idempotent', async () => {
  const f = fixture();
  await expect(f.engine.buildArtifacts(['//apps/server:server'])).rejects.toThrow();
  await f.engine.close();
  await f.engine.close();
  await expect(f.engine.buildArtifacts(['//apps/server:server'])).rejects.toThrow();
  expect(readFileSync(path.join(f.sdk, 'ssl/cert.pem'), 'utf8')).toBe(
    'synthetic declared CA fixture\n',
  );
});

test('caller-owned lifecycle can close after successful or failed builds without losing retained BEP', async () => {
  for (const code of [0, 1]) {
    const f = fixture();
    f.control();
    f.result(code);
    let closes = 0;
    Object.defineProperty(f.process, 'close', {
      value: async () => {
        closes++;
      },
    });
    const result = await f.engine.buildArtifacts(['//apps/server:server']);
    expect(closes).toBe(0);
    await f.engine.close();
    expect(closes).toBe(1);
    const file = f.calls[0]?.args.find((arg) => arg.startsWith('--build_event_json_file='));
    if (file === undefined) throw new Error('Captured original BEP path absent');
    expect(readFileSync(file.slice('--build_event_json_file='.length), 'utf8')).toBe(result.events);
  }
});

test('exported declaredTools preserves exact native SDK member and required absolute tool inputs', () => {
  const f = fixture();
  const environment: Record<string, string> = {
    MERKUR_VERIFICATION_BAZEL: f.tools.bazel,
    MERKUR_VERIFICATION_BAZEL_ACQUISITION: f.tools.acquisition,
    MERKUR_VERIFICATION_GIT: f.tools.git,
    MERKUR_VERIFICATION_CREDENTIAL_HELPER: f.tools.credentialHelper,
    MERKUR_BAZEL_RUNFILES_ROOT: f.tools.runfiles,
    MERKUR_BAZEL_NATIVE_SDK_PREFIX: f.sdk,
  };
  const previous = new Map(Object.keys(environment).map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, environment);
    const captured = declaredTools(f.tools.credentialFile);
    expect(captured.git).toBe(f.tools.git);
    expect(captured.credentialFile).toBe(f.tools.credentialFile);
    expect(captured.sdkEnvironment.MERKUR_BAZEL_NATIVE_SDK_PREFIX).toBe(f.sdk);
    process.env.MERKUR_VERIFICATION_GIT = path.join(f.root, 'foreign-git');
    writeFileSync(process.env.MERKUR_VERIFICATION_GIT, 'same synthetic bytes');
    expect(() => declaredTools(f.tools.credentialFile)).toThrow();
    for (const key of Object.keys(environment)) {
      Object.assign(process.env, environment);
      delete process.env[key];
      expect(() => declaredTools(f.tools.credentialFile)).toThrow('Missing absolute declared tool');
      process.env[key] = 'relative';
      expect(() => declaredTools(f.tools.credentialFile)).toThrow('Missing absolute declared tool');
    }
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('native Darwin qualification bounds cleanup without changing action or ordinary execution flags', async () => {
  const executionPolicy: ExecutorPolicy = {
    pools: NATIVE_EXECUTION_PLATFORMS.map((platform) => ({
      platform,
      provider: platform.startsWith('linux-') ? 'hosted' : 'registered',
      pool: 'control',
      executionPlatform: `//control:${platform.replaceAll('-', '_')}`,
      imageDigest: 'a'.repeat(64),
      sdkDigest: 'b'.repeat(64),
      containerImage: platform.startsWith('linux-')
        ? `registry.invalid/control@sha256:${'a'.repeat(64)}`
        : null,
    })),
  };
  const cleanup = '--experimental_sandbox_async_tree_delete_idle_threads=0';
  for (const platform of NATIVE_EXECUTION_PLATFORMS) {
    const captured: (readonly string[])[][] = [];
    for (const qualifyExecution of [false, true]) {
      const f = fixture({ platform, executionPolicy, qualifyExecution });
      f.control();
      await f.engine.buildArtifacts(['//control:artifact']);
      expect(f.calls.map((call) => call.command)).toEqual(['build', 'info']);
      captured.push(
        f.calls.map((call) => {
          expect(call.args.includes(cleanup)).toBe(
            qualifyExecution && platform.startsWith('darwin-'),
          );
          return call.args
            .filter(
              (arg) =>
                arg !== cleanup &&
                !arg.startsWith('--invocation_id=') &&
                !arg.startsWith('--build_event_json_file='),
            )
            .map((arg) => arg.replaceAll(f.root, '<owned>'));
        }),
      );
    }
    expect(captured[1]).toEqual(captured[0]);
  }
});
