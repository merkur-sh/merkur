import { afterEach, beforeEach, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configureOriginal, validateOriginalConfiguration } from './bun-runtime-build-native';

type Request = Parameters<typeof configureOriginal>[0];
let root: string;
let savedEnvironment: NodeJS.ProcessEnv;

beforeEach(() => {
  savedEnvironment = { ...process.env };
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'bun-native-engine-control-')));
});
afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnvironment)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(savedEnvironment)) process.env[key] = value;
  rmSync(root, { recursive: true, force: true });
});

function file(name: string, contents = 'declared File identity fixture'): string {
  const output = path.join(root, name);
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, contents);
  chmodSync(output, 0o755);
  return output;
}

function fixture(dependencies = '[]', changes: Record<string, unknown> = {}) {
  const tools: Record<string, string> = { bun: process.execPath };
  for (const name of [
    'perl',
    'ninja',
    'bash',
    'git',
    'tar',
    'env',
    'python',
    'cmake',
    'nasm',
    'strip',
  ])
    tools[name] = file(`bin/${name}`);
  const bash = tools.bash;
  if (bash === undefined) throw new Error('Missing control shell');
  // These ordinary Files exercise selection only; no fixture pretends to be a
  // compiler or runs a fake executable. The fetch child uses the pinned Bun.
  file('bin/sh');
  process.env.PATH = path.join(root, 'bin');
  const configuration: Record<string, unknown> = {
    version: '1.4.2',
    revision: 'original-commit',
    clangVersion: '21.1.8',
    ci: true,
    buildkite: false,
    lto: true,
    mode: 'full',
    os: process.platform,
    arch: process.arch === 'arm64' ? 'aarch64' : 'x64',
    vendorDir: path.join(root, 'vendor'),
    cacheDir: path.join(root, 'cache'),
  };
  for (const [field, tool] of Object.entries({
    cc: 'clang',
    cxx: 'clang++',
    hostCc: 'clang',
    hostCxx: 'clang++',
    ar: 'llvm-ar',
    ranlib: 'llvm-ranlib',
    nm: 'llvm-nm',
    dsymutil: 'dsymutil',
  }))
    configuration[field] = file(`llvm/bin/${tool}`);
  configuration.cmake = tools.cmake;
  configuration.bun = tools.bun;
  configuration.cargo = file('nightly/bin/cargo');
  configuration.nasm = tools.nasm;
  configuration.strip = process.platform === 'linux' ? tools.strip : file('llvm/bin/llvm-strip');
  configuration.rustLld = file('nightly/bin/rust-lld');
  configuration.ld = configuration.rustLld;
  const sysroot = path.join(root, 'sysroot');
  mkdirSync(sysroot);
  configuration[process.platform === 'darwin' ? 'osxSysroot' : 'sysroot'] = sysroot;
  process.env.MERKUR_NINJA_SHELL = bash;
  process.env.MERKUR_NINJA_PYTHON = tools.python;
  // Bun.which('sh') must name the same actual File as its Bash role.
  rmSync(path.join(root, 'bin/sh'));
  symlinkSync(bash, path.join(root, 'bin/sh'));
  Object.assign(configuration, changes);
  const request: Request = {
    source: root,
    sysroot,
    llvm: path.join(root, 'llvm'),
    nightly: path.join(root, 'nightly'),
    tools,
    dependencies: {},
    commit: 'original-commit',
    report: path.join(root, 'report.json'),
  };
  file(
    'scripts/build/config.ts',
    `export function resolveConfig(){ return ${JSON.stringify(configuration)}; }`,
  );
  file(
    'scripts/build/profiles.ts',
    `export function getProfile(name){ if(name !== 'release') throw Error('wrong profile'); return { originalProfile: true }; }`,
  );
  file(
    'scripts/build/flags.ts',
    `export function linkerMapOutputs(cfg){ return [cfg.vendorDir+'/original.map']; } export function computeFlags(){ return { original: ['-flto'] }; }`,
  );
  file(
    'scripts/build/rust.ts',
    `export function cargoBuildInvocation(){ return ['original-cargo','--release']; }`,
  );
  file('scripts/build/deps/index.ts', `export const allDeps = ${dependencies};`);
  file(
    'scripts/build/configure.ts',
    `import { writeFileSync } from 'node:fs'; export function resolveToolchain(){ writeFileSync(${JSON.stringify(path.join(root, 'toolchain-called'))},'yes'); return {}; } export async function configure(input){ writeFileSync(${JSON.stringify(path.join(root, 'configured.json'))}, JSON.stringify(input)); return { cfg: ${JSON.stringify(configuration)}, output: { exe: 'original-unstripped', strippedExe: 'original-stripped', originalSideProduct: 'kept' } }; }`,
  );
  file(
    'scripts/build/fetch-cli.ts',
    `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(path.join(root, 'fetch.jsonl'))}, JSON.stringify(process.argv.slice(2))+String.fromCharCode(10));`,
  );
  return { request, configuration };
}

function runNative(request: Request) {
  const requestFile = file('request.json', JSON.stringify(request));
  const config = file('empty-bunfig.toml', '');
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      '--no-install',
      '--no-env-file',
      '--config=' + config,
      path.join(import.meta.dir, 'bun-runtime-build-native.ts'),
      requestFile,
    ],
    cwd: root,
    env: process.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return { exitCode: result.exitCode, stderr: Buffer.from(result.stderr).toString() };
}

test('native module API refusal precedes toolchain or dependency execution', async () => {
  const { request } = fixture();
  file(
    'scripts/build/flags.ts',
    'export const linkerMapOutputs = 1; export function computeFlags(){}',
  );
  await expect(configureOriginal(request)).rejects.toThrow(
    'Pinned original Bun native configure engine is absent',
  );
  expect(existsSync(path.join(root, 'toolchain-called'))).toBe(false);
  expect(existsSync(request.report)).toBe(false);
});

test('native configuration keeps original release predicates and exact tool identity', () => {
  const { request, configuration } = fixture();
  expect(runNative(request).exitCode).toBe(0);
  for (const changes of [
    { version: 'other' },
    { revision: 'other' },
    { clangVersion: 'other' },
    { ci: false },
    { buildkite: true },
    { lto: false },
    { mode: 'other' },
    { ccache: '/ambient/cache' },
  ])
    expect(() => validateOriginalConfiguration({ ...configuration, ...changes }, request)).toThrow(
      'Original Bun configuration differs from the declared native release build',
    );
  expect(() =>
    validateOriginalConfiguration({ ...configuration, cc: file('foreign-compiler') }, request),
  ).toThrow('undeclared cc');
  expect(() =>
    validateOriginalConfiguration({ ...configuration, rustLld: file('foreign-linker') }, request),
  ).toThrow('outside the declared nightly SDK');
});

test('native engine preserves offline archive arguments, release options and actual side-products', () => {
  const dependencies = `[
    { name: 'source', source: () => ({ kind: 'github-archive', repo: 'original/project', commit: 'exact' }), patches: () => ['patches/original.patch'] },
    { name: 'binary', source: () => ({ kind: 'prebuilt', url: 'https://original.invalid/archive', identity: 'original', rmAfterExtract: ['original-only'] }) },
    { name: 'disabled', enabled: () => false, source: () => { throw Error('disabled called'); } },
    { name: 'in-tree', source: () => ({ kind: 'in-tree' }) }
  ]`;
  const { request } = fixture(dependencies);
  const selected = {
    ...request,
    dependencies: {
      source: 'https://github.com/original/project/archive/exact.tar.gz',
      binary: 'https://original.invalid/archive',
    },
  };
  expect(runNative(selected)).toEqual({ exitCode: 0, stderr: '' });
  const calls = readFileSync(path.join(root, 'fetch.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(calls).toEqual([
    [
      'dep',
      'source',
      'original/project',
      'exact',
      path.join(root, 'vendor/source'),
      path.join(root, 'cache/tarballs'),
      path.join(root, 'patches/original.patch'),
    ],
    [
      'prebuilt',
      'binary',
      'https://original.invalid/archive',
      path.join(root, 'vendor/binary'),
      'original',
      'original-only',
    ],
  ]);
  const configured = JSON.parse(readFileSync(path.join(root, 'configured.json'), 'utf8'));
  expect(configured.profile).toBe('release');
  expect(configured.overrides).toMatchObject({
    ci: true,
    buildkite: false,
    mode: 'full',
    lto: true,
    packageManager: 'bun',
    linuxSysroot: request.sysroot,
  });
  const report = JSON.parse(readFileSync(request.report, 'utf8'));
  expect(report.runtime).toBe('original-stripped');
  expect(report.output.originalSideProduct).toBe('kept');
  expect(report.linkerMaps).toEqual([path.join(root, 'vendor/original.map')]);
  expect(report.flags).toEqual({ original: ['-flto'] });
  expect(report.cargo).toEqual(['original-cargo', '--release']);
  expect(report.dependencySources).toEqual([
    {
      name: 'source',
      kind: 'github-archive',
      url: selected.dependencies.source,
      directory: calls[0][4],
    },
    { name: 'binary', kind: 'prebuilt', url: selected.dependencies.binary, directory: calls[1][3] },
  ]);
});

test('offline closure mismatch refuses before original configure or report publication', () => {
  const { request } = fixture();
  const result = runNative({
    ...request,
    dependencies: { missing: 'https://original.invalid/missing' },
  });
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain(
    'Declared native dependency closure differs from the original configured graph',
  );
  expect(existsSync(path.join(root, 'configured.json'))).toBe(false);
  expect(existsSync(request.report)).toBe(false);
});

test('prebuilt removal schema rejects before original fetch invocation', () => {
  const { request } = fixture(
    `[{ name: 'binary', source: () => ({ kind: 'prebuilt', url: 'https://original.invalid/archive', identity: 'original', rmAfterExtract: [1] }) }]`,
  );
  const result = runNative(request);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain('Original prebuilt removal changed');
  expect(existsSync(path.join(root, 'fetch.jsonl'))).toBe(false);
  expect(existsSync(path.join(root, 'configured.json'))).toBe(false);
});

test('native report publication preserves a preexisting output', () => {
  const { request } = fixture();
  writeFileSync(request.report, 'preserve');
  const result = runNative(request);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain('EEXIST');
  expect(readFileSync(request.report, 'utf8')).toBe('preserve');
});

test('native source report retains the exact original prebuilt destination rather than its dependency name', () => {
  const { request } = fixture(
    `[{ name: 'binary', source: (cfg) => ({ kind: 'prebuilt', url: 'https://original.invalid/archive', identity: 'original', destDir: cfg.cacheDir + '/actual-output' }) }]`,
  );
  const selected = { ...request, dependencies: { binary: 'https://original.invalid/archive' } };
  expect(runNative(selected).exitCode).toBe(0);
  const invocation = JSON.parse(readFileSync(path.join(root, 'fetch.jsonl'), 'utf8'));
  const report = JSON.parse(readFileSync(request.report, 'utf8'));
  expect(invocation[3]).toBe(path.join(root, 'cache/actual-output'));
  expect(report.dependencySources).toEqual([
    {
      name: 'binary',
      kind: 'prebuilt',
      url: selected.dependencies.binary,
      directory: invocation[3],
    },
  ]);
});
