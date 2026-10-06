import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { captureGitContext } from './git-context';
import { declaredRatchet } from './ratchet';
import { manifestFromInventory, materializeSnapshot } from './snapshot';
import { withCapturedSourceTree } from './source-tree';

const parent = mkdtempSync(path.join(os.tmpdir(), 'merkur-native-ratchet-'));
const cases: Parameters<typeof declaredRatchet>[0][] = [];
afterAll(() => rmSync(parent, { recursive: true, force: true }));

beforeAll(() => {
  const git = Bun.which('git');
  if (git === null) throw new Error('Declared native Git required');
  const fallow = process.env.MERKUR_VERIFICATION_FALLOW;
  if (fallow === undefined || !path.isAbsolute(fallow))
    throw new Error('Declared native Fallow executable required');
  const source = path.join(parent, 'source');
  mkdirSync(source);
  const sdkEnvironment = Object.fromEntries(
    [
      'DYLD_LIBRARY_PATH',
      'DYLD_FALLBACK_LIBRARY_PATH',
      'GIT_EXEC_PATH',
      'GIT_TEMPLATE_DIR',
      'OPENSSL_CONF',
      'OPENSSL_MODULES',
      'MERKUR_BAZEL_NATIVE_SDK_PREFIX',
    ].flatMap((name) => (process.env[name] === undefined ? [] : [[name, process.env[name] ?? '']])),
  );
  const runfiles = process.env.TEST_SRCDIR;
  if (runfiles === undefined) throw new Error('Engine-owned native tool runfiles required');
  const environment = {
    ...sdkEnvironment,
    HOME: parent,
    PATH: path.dirname(git),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_ATTR_NOSYSTEM: '1',
    LC_ALL: 'C',
    GIT_AUTHOR_NAME: 'Declared fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Declared fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
    GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
  };
  function read(args: readonly string[], stdin?: string): Uint8Array {
    const result = Bun.spawnSync([git ?? '', ...args], {
      cwd: source,
      env: environment,
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: stdin === undefined ? 'ignore' : Buffer.from(stdin),
    });
    if (result.exitCode !== 0 || result.signalCode) throw new Error(result.stderr.toString());
    return result.stdout;
  }
  read(['init', '--template=', '--object-format=sha1']);
  writeFileSync(
    path.join(source, 'package.json'),
    JSON.stringify({ name: 'fixture', private: true }),
  );
  writeFileSync(
    path.join(source, '.fallowrc.json'),
    JSON.stringify({
      entry: ['entry.ts'],
      includeEntryExports: true,
      health: { maxCyclomatic: 3, maxCognitive: 3 },
    }),
  );
  writeFileSync(
    path.join(source, '.fallowrc.semantic.json'),
    JSON.stringify({ extends: ['./.fallowrc.json'], duplicates: { mode: 'semantic' } }),
  );
  mkdirSync(path.join(source, 'fallow-baselines'));
  writeFileSync(path.join(source, 'fallow-baselines/complexity-ceilings.json'), '{}');
  const entry = path.join(source, 'entry.ts');
  writeFileSync(entry, 'function value() { return 1; }\nprocess.stdout.write(String(value()));\n');
  read([
    'add',
    '--',
    'entry.ts',
    'package.json',
    '.fallowrc.json',
    '.fallowrc.semantic.json',
    'fallow-baselines/complexity-ceilings.json',
  ]);
  read(['commit', '-m', 'base']);
  const base = Buffer.from(read(['rev-parse', 'HEAD']))
    .toString()
    .trim();
  writeFileSync(entry, 'function value() { return 2; }\nprocess.stdout.write(String(value()));\n');
  read(['add', '--', 'entry.ts']);
  read(['commit', '-m', 'candidate']);
  const head = Buffer.from(read(['rev-parse', 'HEAD']))
    .toString()
    .trim();
  const objects = Buffer.from(
    read(['rev-list', '--objects', '--no-object-names', head]),
  ).toString();
  const packed = read(['pack-objects', '--stdout'], objects);
  const pack = path.join(parent, 'objects.pack');
  writeFileSync(pack, packed);
  for (const name of ['passing', 'complexity-failure']) {
    if (name === 'complexity-failure')
      writeFileSync(
        entry,
        `function value(n: number) {\n${Array.from(
          { length: 8 },
          (_, n) => `if (n === ${n}) return ${n};`,
        ).join('\n')}\nreturn 9;\n}\nprocess.stdout.write(String(value(3)));\n`,
      );
    const context = captureGitContext((args) => Buffer.from(read(args)).toString(), base, head);
    const manifest = manifestFromInventory(
      source,
      context.index.map((item) => item.path),
      head,
    );
    const root = materializeSnapshot(manifest, path.join(parent, name));
    cases.push({
      root,
      scratch: parent,
      git,
      fallow,
      runfiles,
      pack,
      context,
      source: manifest,
      sdkEnvironment,
      objects: {
        contextDigest: context.digest,
        packDigest: createHash('sha256').update(packed).digest('hex'),
        packBytes: packed.length,
        shallow: [],
      },
    });
  }
  // Neither consumer can acquire facts from the original Git repository.
  rmSync(path.join(source, '.git'), { recursive: true });
});

test('native declared ratchet passes the real baseline audit and all ceiling policies', async () => {
  const options = cases[0];
  if (options === undefined) throw new Error('Ratchet acquisition did not complete');
  const verdict = await withCapturedSourceTree(
    {
      tree: options.root,
      root: mkdtempSync(path.join(parent, 'isolated-consumer-')),
      source: options.source,
    },
    async (root) => declaredRatchet({ ...options, root }),
  );
  expect(verdict).toBe(0);
});

test('native declared ratchet rejects newly introduced complexity without raising ceilings', () => {
  const options = cases[1];
  if (options === undefined) throw new Error('Ratchet acquisition did not complete');
  expect(declaredRatchet(options)).toBe(1);
});
