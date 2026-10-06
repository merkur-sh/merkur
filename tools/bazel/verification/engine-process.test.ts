import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DeclaredEngineProcess,
  declaredGitCaBundle,
  declaredGitSdkEnvironment,
} from './engine-process';
import { executorFlags, NATIVE_EXECUTION_PLATFORMS, parseExecutorPolicy } from './executor-policy';

function fixture(run: (engine: DeclaredEngineProcess) => Promise<void>): Promise<void> {
  const directory = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), 'merkur-execution-policy-control-')),
  );
  mkdirSync(path.join(directory, 'ssl'));
  writeFileSync(path.join(directory, 'ssl', 'cacert.pem'), 'unexecuted trust-bundle fixture');
  symlinkSync('cacert.pem', path.join(directory, 'ssl', 'cert.pem'));
  const engine = new DeclaredEngineProcess(
    {
      bazel: path.join(directory, 'not-executed-bazel'),
      acquisition: path.join(directory, 'not-read-acquisition'),
      git: path.join(directory, 'not-executed-git'),
      credentialHelper: path.join(directory, 'not-executed-helper'),
      credentialFile: path.join(directory, 'not-read-credential'),
      runfiles: directory,
      sdkEnvironment: { MERKUR_BAZEL_NATIVE_SDK_PREFIX: directory },
    },
    directory,
    new AbortController().signal,
  );
  return run(engine).finally(() => rmSync(directory, { recursive: true, force: true }));
}

function policy() {
  return parseExecutorPolicy({
    pools: NATIVE_EXECUTION_PLATFORMS.map((platform, index) => ({
      platform,
      provider: platform.startsWith('linux-') ? 'hosted' : 'registered',
      pool: `control-${index}`,
      executionPlatform: `//test:platform_${index}`,
      imageDigest: 'a'.repeat(64),
      sdkDigest: 'b'.repeat(64),
      containerImage: platform.startsWith('linux-') ? `test@sha256:${'a'.repeat(64)}` : null,
    })),
  });
}

test('configured queries require the captured scheduling policy and disable execution', async () => {
  await fixture(async (engine) => {
    const supplied = policy();
    const flags = executorFlags(supplied, 'linux-arm64');
    engine.bindExecutionPolicy(supplied, 'linux-arm64');
    expect(() => engine.bindExecutionPolicy(supplied, 'linux-arm64')).toThrow('bound once');
    const planning = [
      '--remote_executor=',
      ...flags.filter((flag) => !flag.startsWith('--remote_executor=')),
    ];
    for (const selected of [
      flags,
      ['--remote_executor='],
      [...planning, '--remote_default_exec_properties=Pool=foreign'],
      planning.filter((flag) => !flag.startsWith('--extra_execution_platforms=')),
    ]) {
      await expect(
        engine.query('/not-read', 'aquery', '//test:unit', 'jsonproto', selected),
      ).rejects.toThrow('controlled flags');
    }
    // Reaching identity validation proves only flag acceptance; no tool is executed.
    await expect(
      engine.query('/not-read', 'aquery', '//test:unit', 'jsonproto', planning),
    ).rejects.toThrow('validated declared engine identity');
    await expect(
      engine.query('/not-read', 'query', '//test:unit', 'streamed_jsonproto', ['--enable_bzlmod']),
    ).rejects.toThrow('validated declared engine identity');
  });
});

test('remote execution refuses unbound and foreign endpoints before reading any source or credentials', async () => {
  await fixture(async (engine) => {
    const flags = executorFlags(policy(), 'linux-arm64');
    await expect(engine.run('/not-read', 'test', flags)).rejects.toThrow('exact bound deployment');
    engine.bindExecutionPolicy(policy(), 'linux-arm64');
    for (const selected of [
      ['--remote_executor=grpcs://foreign.invalid'],
      ['--remote_executor=grpcs://remote.buildbuddy.io'],
      [...flags, '--remote_executor=grpcs://remote.buildbuddy.io'],
      [...flags, '--remote_default_exec_properties=Pool=foreign'],
      [...flags, '--extra_execution_platforms=//foreign:host'],
      [...flags, '--remote_default_exec_properties', 'Pool=foreign'],
    ])
      await expect(engine.run('/not-read', 'test', selected)).rejects.toThrow(
        'exact bound deployment',
      );
    await expect(engine.run('/not-read', 'test', flags)).rejects.toThrow(
      'validated declared engine identity',
    );
  });
});

test('declared Git trust uses the original contained CA alias and fixes verification', async () => {
  await fixture(async (engine) => {
    const bundle = path.join(engine.directory, 'ssl', 'cacert.pem');
    expect(declaredGitCaBundle(engine.directory)).toBe(bundle);
    expect(engine.environment.GIT_SSL_CAINFO).toBe(bundle);
    expect(engine.environment.GIT_SSL_NO_VERIFY).toBeUndefined();
  });
});

test('declared Git trust refuses a missing, directory or external bundle before execution', () => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'merkur-ca-boundary-control-')));
  try {
    const sdk = path.join(root, 'sdk');
    mkdirSync(path.join(sdk, 'ssl'), { recursive: true });
    const alias = path.join(sdk, 'ssl', 'cert.pem');
    expect(() => declaredGitCaBundle(sdk)).toThrow();
    mkdirSync(alias);
    expect(() => declaredGitCaBundle(sdk)).toThrow('ordinary SDK member');
    rmSync(alias, { recursive: true });
    const foreign = path.join(root, 'foreign.pem');
    writeFileSync(foreign, 'foreign trust-bundle fixture');
    symlinkSync(foreign, alias);
    expect(() => declaredGitCaBundle(sdk)).toThrow('ordinary SDK member');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('per-File SDK runfiles resolve through the exact native Git input and retain contained trust', () => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'merkur-sdk-runfiles-control-')));
  try {
    const sdk = path.join(root, 'original-sdk');
    const view = path.join(root, 'runfiles-sdk');
    for (const directory of [sdk, view]) {
      mkdirSync(path.join(directory, 'bin'), { recursive: true });
      mkdirSync(path.join(directory, 'ssl'), { recursive: true });
    }
    const git = path.join(sdk, 'bin', 'git');
    writeFileSync(git, 'unexecuted original Git File');
    writeFileSync(path.join(sdk, 'ssl', 'cacert.pem'), 'unexecuted original CA File');
    symlinkSync('cacert.pem', path.join(sdk, 'ssl', 'cert.pem'));
    symlinkSync(git, path.join(view, 'bin', 'git'));
    symlinkSync(path.join(sdk, 'ssl', 'cert.pem'), path.join(view, 'ssl', 'cert.pem'));
    expect(() => declaredGitCaBundle(view)).toThrow('ordinary SDK member');
    const environment = declaredGitSdkEnvironment(view, git);
    expect(environment.MERKUR_BAZEL_NATIVE_SDK_PREFIX).toBe(sdk);
    expect(environment.DYLD_FALLBACK_LIBRARY_PATH).toBe(path.join(sdk, 'lib'));
    expect(environment.DYLD_LIBRARY_PATH).toBeUndefined();
    expect(declaredGitCaBundle(sdk)).toBe(path.join(sdk, 'ssl', 'cacert.pem'));
    const foreign = path.join(root, 'foreign-git');
    writeFileSync(foreign, 'unexecuted foreign Git File');
    expect(() => declaredGitSdkEnvironment(view, foreign)).toThrow('exact SDK member');
    rmSync(path.join(sdk, 'ssl', 'cert.pem'));
    symlinkSync(foreign, path.join(sdk, 'ssl', 'cert.pem'));
    expect(() => declaredGitSdkEnvironment(view, git)).toThrow('ordinary SDK member');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('closing an unused private engine starts no tool and permanently refuses commands', async () => {
  await fixture(async (engine) => {
    const closed = engine.close();
    expect(engine.close()).toBe(closed);
    await closed;
    await expect(engine.run('/not-read', 'query', [])).rejects.toThrow('closing or closed');
  });
});

test('configured query accepts the controller native platform and qualification cleanup flags', async () => {
  await fixture(async (engine) => {
    for (const platform of ['macos_arm64', 'macos_x64', 'linux_arm64', 'linux_x64']) {
      await expect(
        engine.query('.', 'aquery', '//:control', 'jsonproto', [
          '--remote_executor=',
          `--platforms=//tools/bazel/platforms:${platform}`,
          '--experimental_sandbox_async_tree_delete_idle_threads=0',
        ]),
      ).rejects.toThrow('validated declared engine identity');
    }
    await expect(
      engine.query('.', 'aquery', '//:control', 'jsonproto', [
        '--remote_executor=',
        '--platforms=//foreign:platform',
      ]),
    ).rejects.toThrow('explicit controlled flags');
  });
});

test('source query refuses configured-only flags and each query requires its native output format', async () => {
  await fixture(async (engine) => {
    await expect(
      engine.query('.', 'query', '//:control', 'jsonproto', ['--enable_bzlmod']),
    ).rejects.toThrow('explicit controlled flags');
    await expect(
      engine.query('.', 'query', '//:control', 'streamed_jsonproto', ['--symlink_prefix=/']),
    ).rejects.toThrow('explicit controlled flags');
    await expect(
      engine.query('.', 'aquery', '//:control', 'streamed_jsonproto', ['--remote_executor=']),
    ).rejects.toThrow('explicit controlled flags');
  });
});
