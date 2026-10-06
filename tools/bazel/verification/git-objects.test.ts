import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { captureGitContext } from './git-context';
import { withGitObjects } from './git-objects';

const parent = mkdtempSync(path.join(os.tmpdir(), 'merkur-git-objects-'));
let verifyObjects: (() => void) | undefined;
afterAll(() => rmSync(parent, { recursive: true, force: true }));

beforeAll(() => {
  const executable = Bun.which('git');
  if (executable === null) throw new Error('Declared native Git required');
  const source = path.join(parent, 'source');
  const copy = path.join(parent, 'copy');
  mkdirSync(source);
  mkdirSync(copy);
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
  const environment = {
    ...sdkEnvironment,
    HOME: parent,
    PATH: path.dirname(executable),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_ATTR_NOSYSTEM: '1',
    LC_ALL: 'C',
    GIT_AUTHOR_NAME: 'Declared fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Declared fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
    GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
  };
  function git(
    root: string,
    args: readonly string[],
    env = environment,
    stdin?: string,
  ): Uint8Array {
    const result = Bun.spawnSync([executable ?? '', ...args], {
      cwd: root,
      env,
      stdin: stdin === undefined ? 'ignore' : Buffer.from(stdin),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout;
  }
  git(source, ['init', '--template=', '--object-format=sha1']);
  writeFileSync(path.join(source, 'tracked.ts'), 'export const number = 1;\n');
  git(source, ['add', '--', 'tracked.ts']);
  git(source, ['commit', '-m', 'base']);
  const base = Buffer.from(git(source, ['rev-parse', 'HEAD']))
    .toString()
    .trim();
  writeFileSync(path.join(source, 'tracked.ts'), 'export const number = 2;\n');
  git(source, ['add', '--', 'tracked.ts']);
  git(source, ['commit', '-m', 'candidate']);
  const candidate = Buffer.from(git(source, ['rev-parse', 'HEAD']))
    .toString()
    .trim();
  writeFileSync(path.join(source, 'tracked.ts'), 'export const number = 3;\n');
  writeFileSync(path.join(source, 'untracked.ts'), 'export const untracked = true;\n');
  const context = captureGitContext(
    (args) => Buffer.from(git(source, args)).toString(),
    base,
    candidate,
  );
  const objects = Buffer.from(
    git(source, ['rev-list', '--objects', '--no-object-names', candidate]),
  ).toString();
  const pack = path.join(parent, 'objects.pack');
  const packed = git(source, ['pack-objects', '--stdout'], environment, objects);
  writeFileSync(pack, packed);
  const evidence = {
    contextDigest: context.digest,
    packDigest: createHash('sha256').update(packed).digest('hex'),
    packBytes: packed.length,
    shallow: [],
  };
  for (const file of ['tracked.ts', 'untracked.ts'])
    cpSync(path.join(source, file), path.join(copy, file));
  // The captured checkout is deliberately removed before baseline interpretation.
  rmSync(path.join(source, '.git'), { recursive: true });
  verifyObjects = () => {
    withGitObjects(
      { executable, root: copy, scratch: parent, pack, context, evidence, sdkEnvironment },
      (env) => {
        const current = captureGitContext(
          (args) => Buffer.from(git(copy, args, { ...environment, ...env })).toString(),
          base,
          candidate,
        );
        expect(current).toEqual(context);
        expect(
          Buffer.from(
            git(copy, ['show', `${base}:tracked.ts`], { ...environment, ...env }),
          ).toString(),
        ).toBe('export const number = 1;\n');
        const baseline = path.join(parent, 'baseline');
        git(copy, ['worktree', 'add', '--detach', baseline, base], { ...environment, ...env });
        expect(readFileSync(path.join(baseline, 'tracked.ts'), 'utf8')).toBe(
          'export const number = 1;\n',
        );
        git(copy, ['worktree', 'remove', baseline], { ...environment, ...env });
      },
    );
    expect(existsSync(path.join(copy, '.git'))).toBe(false);
    const changed = Buffer.from(packed);
    changed[changed.length - 1] = (changed[changed.length - 1] ?? 0) ^ 1;
    writeFileSync(pack, changed);
    expect(() =>
      withGitObjects(
        { executable, root: copy, scratch: parent, pack, context, evidence, sdkEnvironment },
        () => {},
      ),
    ).toThrow('bytes differ');
    expect(existsSync(path.join(copy, '.git'))).toBe(false);
  };
});

test('declared native Git object closure preserves base, index and dirty/untracked facts', () => {
  if (verifyObjects === undefined) throw new Error('Declared Git acquisition did not complete');
  verifyObjects();
});
