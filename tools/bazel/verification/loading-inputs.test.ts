import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadingFacts } from './loading-inputs';

const temporary: string[] = [];
afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});

const PATHS = [
  'BUILD.bazel',
  'MODULE.bazel',
  'MODULE.bazel.lock',
  '.github/bazel/qualification.json',
  'package/BUILD.bazel',
  'package/rules.bzl',
  'package/source.ts',
  'package/pins.json',
  'package/recorded.patch',
  'README.md',
];

function workspace(lockRecords: readonly string[] = ['FILE:@@//package/pins.json 0a']): {
  readonly root: string;
  readonly engineRoot: string;
  readonly marker: string;
} {
  const container = mkdtempSync(path.join(tmpdir(), 'merkur-loading-'));
  temporary.push(container);
  const root = path.join(container, 'workspace');
  const engineRoot = path.join(container, 'engine');
  for (const file of PATHS) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), `${file}\n`);
  }
  writeFileSync(
    path.join(root, 'MODULE.bazel.lock'),
    JSON.stringify({
      moduleExtensions: {
        '//package:rules.bzl%pins': {
          general: { recordedInputs: ['REPO_MAPPING:rules+,tools tools', ...lockRecords] },
        },
      },
    }),
  );
  const external = path.join(engineRoot, 'f00d', 'external');
  mkdirSync(external, { recursive: true });
  // The other entries of an engine root are not output bases.
  writeFileSync(path.join(engineRoot, 'install'), '');
  const marker = path.join(external, '@+rule+patched.marker');
  writeFileSync(
    marker,
    [
      'e1294fa101dcb12c',
      'ENV:PATH /usr/bin',
      'FILE:@@//package/recorded.patch b538',
      'FILE:@@rules+//defs/BUILD.tpl 8182',
      'FILE:/outside/compiler.tar.gz 9987',
      '',
    ].join('\n'),
  );
  return { root, engineRoot, marker };
}

function digest(target: { root: string; engineRoot: string }): string | undefined {
  const facts = loadingFacts({ root: target.root, paths: PATHS, engineRoot: target.engineRoot });
  return facts === undefined ? undefined : JSON.stringify(facts);
}

describe('what a planning answer depends on', () => {
  test('a source file the engine only passes to actions does not enter it', () => {
    const target = workspace();
    const before = digest(target);
    expect(before).toBeDefined();
    writeFileSync(path.join(target.root, 'package/source.ts'), 'export const edited = true;\n');
    writeFileSync(path.join(target.root, 'README.md'), 'edited\n');
    expect(digest(target)).toBe(before);
  });

  test('every file the engine reads by name enters it', () => {
    for (const file of [
      'BUILD.bazel',
      'MODULE.bazel',
      'package/BUILD.bazel',
      'package/rules.bzl',
      '.github/bazel/qualification.json',
    ]) {
      const target = workspace();
      const before = digest(target);
      writeFileSync(path.join(target.root, file), 'edited\n');
      expect(digest(target)).not.toBe(before);
    }
  });

  test('a file the lock or a repository marker records enters it', () => {
    for (const file of ['package/pins.json', 'package/recorded.patch']) {
      const target = workspace();
      const before = digest(target);
      writeFileSync(path.join(target.root, file), 'edited\n');
      expect(digest(target)).not.toBe(before);
    }
  });

  test('a repository fetched since the last answer brings its inputs', () => {
    const target = workspace();
    const before = digest(target);
    writeFileSync(
      path.join(path.dirname(target.marker), '@+rule+readme.marker'),
      'c0ffee\nFILE:@@//README.md 5e93\n',
    );
    const fetched = digest(target);
    expect(fetched).not.toBe(before);
    writeFileSync(path.join(target.root, 'README.md'), 'edited\n');
    expect(digest(target)).not.toBe(fetched);
  });

  test('which paths exist, and of what kind, enters it', () => {
    const removed = workspace();
    const before = digest(removed);
    rmSync(path.join(removed.root, 'package/source.ts'));
    expect(digest(removed)).not.toBe(before);

    const linked = workspace();
    const file = digest(linked);
    rmSync(path.join(linked.root, 'package/source.ts'));
    symlinkSync('pins.json', path.join(linked.root, 'package/source.ts'));
    const first = digest(linked);
    expect(first).not.toBe(file);
    rmSync(path.join(linked.root, 'package/source.ts'));
    symlinkSync('recorded.patch', path.join(linked.root, 'package/source.ts'));
    expect(digest(linked)).not.toBe(first);
  });

  test('an engine with no output base yet has only the named and locked inputs', () => {
    const target = workspace();
    rmSync(target.engineRoot, { recursive: true });
    const before = digest(target);
    expect(before).toBeDefined();
    // No marker records the patch, so nothing binds its bytes yet.
    writeFileSync(path.join(target.root, 'package/recorded.patch'), 'edited\n');
    expect(digest(target)).toBe(before);
    writeFileSync(path.join(target.root, 'package/pins.json'), 'edited\n');
    expect(digest(target)).not.toBe(before);
  });

  test('a record this reader cannot bind to bytes yields no answer', () => {
    for (const record of [
      'DIRENTS:@@//package 77aa',
      'DIRTREE:@@//package 77aa',
      'FILE:@@//package/with\\sspace.json 77aa',
      'FILE:@@//package/pins.json',
    ]) {
      expect(digest(workspace([record]))).toBeUndefined();
      const target = workspace();
      writeFileSync(target.marker, `c0ffee\n${record}\n`);
      expect(digest(target)).toBeUndefined();
    }
    const target = workspace();
    writeFileSync(
      path.join(target.root, 'MODULE.bazel.lock'),
      JSON.stringify({ lockFileVersion: 1 }),
    );
    expect(digest(target)).toBeUndefined();
  });
});
