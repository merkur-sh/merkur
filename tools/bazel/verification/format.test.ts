import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  linkSync,
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
import { formatFiles } from './format';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'merkur-format-')));
  directories.push(directory);
  const root = path.join(directory, 'workspace with spaces');
  mkdirSync(root);
  const config = JSON.stringify({
    formatter: { indentStyle: 'space', indentWidth: 2 },
    javascript: { formatter: { quoteStyle: 'single' } },
  });
  writeFileSync(path.join(root, 'biome.json'), config);
  const captured = path.join(directory, 'declared-biome.json');
  writeFileSync(captured, config);
  const executable = path.join(directory, 'declared-biome');
  writeFileSync(executable, 'declared executable fixture');
  chmodSync(executable, 0o755);
  writeFileSync(path.join(root, 'owned.ts'), 'const owned={value:"one"};\n');
  writeFileSync(path.join(root, 'untouched.ts'), 'const untouched={value:"two"};\n');
  return {
    root,
    directory,
    captured,
    executable,
    environment: {
      BUILD_WORKSPACE_DIRECTORY: root,
      MERKUR_FORMAT_CONFIG: captured,
      MERKUR_FORMAT_BIOME: executable,
      MERKUR_BAZEL_RUNFILES_ROOT: directory,
    },
  };
}

describe('owned file formatter', () => {
  test('passes exact files, declared config and executable with workspace cwd', () => {
    const f = fixture();
    let calls = 0;
    expect(
      formatFiles(
        ['owned.ts', path.join(f.root, 'untouched.ts')],
        f.environment,
        (argv, options) => {
          calls++;
          expect(argv).toEqual([
            f.executable,
            'format',
            '--write',
            `--config-path=${path.join(f.root, 'biome.json')}`,
            path.join(f.root, 'owned.ts'),
            path.join(f.root, 'untouched.ts'),
          ]);
          expect(options).toEqual({
            cwd: f.root,
            env: { PATH: '', RUNFILES_DIR: f.directory },
            stdout: 'inherit',
            stderr: 'inherit',
          });
          return { exitCode: 0 };
        },
      ),
    ).toBe(0);
    expect(calls).toBe(1);
  });

  test('rejects empty requests and options before dispatch', () => {
    const f = fixture();
    for (const args of [
      [],
      [''],
      ['--write'],
      ['owned.ts', '--config-path=evil'],
      ['owned.ts', 'bad\0file'],
    ]) {
      expect(() =>
        formatFiles(args, f.environment, () => {
          throw new Error('must never invoke');
        }),
      ).toThrow(/owned file/);
    }
  });

  test('validates the entire list before dispatch, including directories and missing files', () => {
    const f = fixture();
    const original = readFileSync(path.join(f.root, 'owned.ts'));
    for (const args of [
      ['owned.ts', '.'],
      ['owned.ts', 'missing.ts'],
    ]) {
      expect(() =>
        formatFiles(args, f.environment, () => {
          writeFileSync(path.join(f.root, 'owned.ts'), 'unexpected');
          return { exitCode: 0 };
        }),
      ).toThrow();
      expect(readFileSync(path.join(f.root, 'owned.ts'))).toEqual(original);
    }
  });

  test('rejects outside files and sibling paths with the workspace prefix', () => {
    const f = fixture();
    const sibling = `${f.root}-outside`;
    mkdirSync(sibling);
    writeFileSync(path.join(sibling, 'outside.ts'), 'foreign');
    for (const file of [path.join(sibling, 'outside.ts'), '../declared-biome.json']) {
      expect(() => formatFiles(['owned.ts', file], f.environment)).toThrow('escaped the workspace');
    }
    symlinkSync(f.root, path.join(f.directory, 'returned'));
    expect(() => formatFiles(['../returned/owned.ts'], f.environment)).toThrow(
      'escaped the workspace',
    );
  });

  test('rejects symlink escape through a directory or final member', () => {
    const f = fixture();
    const outside = path.join(f.directory, 'foreign');
    mkdirSync(outside);
    writeFileSync(path.join(outside, 'foreign.ts'), 'foreign');
    symlinkSync(outside, path.join(f.root, 'link'));
    symlinkSync(path.join(outside, 'foreign.ts'), path.join(f.root, 'escape.ts'));
    symlinkSync(path.join(f.root, 'owned.ts'), path.join(f.root, 'alias.ts'));
    for (const file of ['link/foreign.ts', 'escape.ts', 'alias.ts']) {
      expect(() => formatFiles(['owned.ts', file], f.environment)).toThrow();
    }
    expect(readFileSync(path.join(outside, 'foreign.ts'), 'utf8')).toBe('foreign');
  });

  test('rejects repeated canonical files including different spellings', () => {
    const f = fixture();
    for (const args of [
      ['owned.ts', './owned.ts'],
      ['owned.ts', path.join(f.root, 'owned.ts')],
    ]) {
      expect(() => formatFiles(args, f.environment)).toThrow('Duplicate');
    }
  });

  test('rejects config drift and symlink config before dispatch', () => {
    const f = fixture();
    writeFileSync(path.join(f.root, 'biome.json'), '{}');
    expect(() => formatFiles(['owned.ts'], f.environment)).toThrow('differs');
    rmSync(path.join(f.root, 'biome.json'));
    symlinkSync(f.captured, path.join(f.root, 'biome.json'));
    expect(() => formatFiles(['owned.ts'], f.environment)).toThrow('ordinary');
  });

  test('requires Bazel workspace and exact executable/config Files', () => {
    const f = fixture();
    for (const key of [
      'BUILD_WORKSPACE_DIRECTORY',
      'MERKUR_FORMAT_CONFIG',
      'MERKUR_FORMAT_BIOME',
      'MERKUR_BAZEL_RUNFILES_ROOT',
    ]) {
      const environment: Record<string, string | undefined> = {
        ...f.environment,
        [key]: undefined,
      };
      expect(() => formatFiles(['owned.ts'], environment)).toThrow('required');
    }
    chmodSync(f.executable, 0o644);
    expect(() => formatFiles(['owned.ts'], f.environment)).toThrow();
  });

  test('preserves formatter failure and refuses missing or signalled completion', () => {
    const f = fixture();
    expect(formatFiles(['owned.ts'], f.environment, () => ({ exitCode: 7 }))).toBe(7);
    expect(() => formatFiles(['owned.ts'], f.environment, () => ({ exitCode: -1 }))).toThrow(
      'exit status',
    );
    expect(() =>
      formatFiles(['owned.ts'], f.environment, () => ({ exitCode: 0, signalCode: 'SIGTERM' })),
    ).toThrow('SIGTERM');
  });

  test('actual declared Biome formats only the named file', () => {
    const f = fixture();
    const biome = process.env.MERKUR_FORMAT_BIOME;
    if (biome === undefined)
      throw new Error('Actual declared Biome required for formatter controls');
    const untouched = readFileSync(path.join(f.root, 'untouched.ts'));
    expect(formatFiles(['owned.ts'], { ...f.environment, MERKUR_FORMAT_BIOME: biome })).toBe(0);
    expect(readFileSync(path.join(f.root, 'owned.ts'), 'utf8')).toBe(
      "const owned = { value: 'one' };\n",
    );
    expect(readFileSync(path.join(f.root, 'untouched.ts'))).toEqual(untouched);
  });

  for (const location of ['inside', 'outside'] as const) {
    test(`rejects a hardlink ${location} the workspace before any file changes`, () => {
      const f = fixture();
      const biome = process.env.MERKUR_FORMAT_BIOME;
      if (biome === undefined)
        throw new Error('Actual declared Biome required for formatter controls');
      const owned = path.join(f.root, 'owned.ts');
      const alias = path.join(location === 'inside' ? f.root : f.directory, 'alias.ts');
      linkSync(owned, alias);
      const original = readFileSync(owned);
      const untouched = readFileSync(path.join(f.root, 'untouched.ts'));
      expect(() =>
        formatFiles(['untouched.ts', 'owned.ts'], { ...f.environment, MERKUR_FORMAT_BIOME: biome }),
      ).toThrow('single link');
      expect(readFileSync(owned)).toEqual(original);
      expect(readFileSync(alias)).toEqual(original);
      expect(readFileSync(path.join(f.root, 'untouched.ts'))).toEqual(untouched);
    });
  }
});
