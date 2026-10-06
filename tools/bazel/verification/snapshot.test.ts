import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  changedInputs,
  manifestFromInventory,
  materializeSnapshot,
  materializeStableSnapshot,
} from './snapshot';

const temporary: string[] = [];
afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'merkur-bazel-inputs-'));
  temporary.push(root);
  writeFileSync(path.join(root, 'source.ts'), 'export const value = 1;');
  return root;
}

describe('source input evidence', () => {
  test('uncommitted bytes invalidate a verification despite unchanged commit identity', () => {
    const root = fixture();
    const before = manifestFromInventory(root, ['source.ts'], 'same-commit');
    writeFileSync(path.join(root, 'source.ts'), 'export const value = 2;');
    const after = manifestFromInventory(root, ['source.ts'], 'same-commit');
    expect(before.digest).not.toBe(after.digest);
    expect(changedInputs(before, after)).toEqual(['source.ts']);
  });

  test('additions, deletions and both rename endpoints participate', () => {
    const root = fixture();
    const before = manifestFromInventory(root, ['source.ts', 'expected-missing'], 'commit');
    renameSync(path.join(root, 'source.ts'), path.join(root, 'renamed.ts'));
    writeFileSync(path.join(root, 'expected-missing'), 'now present');
    const after = manifestFromInventory(
      root,
      ['source.ts', 'renamed.ts', 'expected-missing'],
      'commit',
    );
    expect(changedInputs(before, after)).toEqual(['expected-missing', 'renamed.ts', 'source.ts']);
  });

  test('permission and symlink-target changes invalidate inputs', () => {
    const root = fixture();
    chmodSync(path.join(root, 'source.ts'), 0o600);
    symlinkSync('source.ts', path.join(root, 'link'));
    const before = manifestFromInventory(root, ['source.ts', 'link'], 'commit');
    chmodSync(path.join(root, 'source.ts'), 0o644);
    rmSync(path.join(root, 'link'));
    symlinkSync('missing.ts', path.join(root, 'link'));
    const after = manifestFromInventory(root, ['source.ts', 'link'], 'commit');
    expect(changedInputs(before, after)).toEqual(['link', 'source.ts']);
  });

  test('input and symlink escape are refused', () => {
    const root = fixture();
    expect(() => manifestFromInventory(root, ['../other'], 'commit')).toThrow('escapes');
    symlinkSync('/etc/passwd', path.join(root, 'link'));
    expect(() => manifestFromInventory(root, ['link'], 'commit')).toThrow('escapes');
  });

  test('input order and duplicate enumeration do not change identity', () => {
    const root = fixture();
    const first = manifestFromInventory(root, ['missing', 'source.ts', 'source.ts'], 'commit');
    const second = manifestFromInventory(root, ['source.ts', 'missing'], 'commit');
    expect(first.digest).toBe(second.digest);
    expect(changedInputs(first, second)).toEqual([]);
  });

  test('symlink referent bytes and permissions are required inputs even outside Git inventory', () => {
    const root = fixture();
    symlinkSync('source.ts', path.join(root, 'link'));
    const before = manifestFromInventory(root, ['link'], 'commit');
    writeFileSync(path.join(root, 'source.ts'), 'edited through an ignored referent');
    chmodSync(path.join(root, 'source.ts'), 0o755);
    const after = manifestFromInventory(root, ['link'], 'commit');
    expect(changedInputs(before, after)).toEqual(['link']);
  });

  test('intermediate symlink escapes and directory membership changes are observable', () => {
    const root = fixture();
    symlinkSync('/etc', path.join(root, 'external'));
    symlinkSync('external/passwd', path.join(root, 'link'));
    expect(() => manifestFromInventory(root, ['link'], 'commit')).toThrow('escapes');
    mkdirSync(path.join(root, 'fixtures'));
    const before = manifestFromInventory(root, ['fixtures'], 'commit');
    writeFileSync(path.join(root, 'fixtures/added'), 'new fixture');
    const after = manifestFromInventory(root, ['fixtures'], 'commit');
    expect(changedInputs(before, after)).toEqual(['fixtures']);
  });

  test('compiled snapshot remains on captured bytes after source edits', () => {
    const root = fixture();
    const output = fixture();
    symlinkSync('source.ts', path.join(root, 'link'));
    const manifest = manifestFromInventory(root, ['link', 'missing.ts'], 'commit');
    const snapshot = materializeSnapshot(manifest, path.join(output, 'snapshot'));
    writeFileSync(path.join(root, 'source.ts'), 'edited after capture');
    expect(readFileSync(path.join(snapshot, 'link'), 'utf8')).toBe('export const value = 1;');
    expect(readlinkSync(path.join(snapshot, 'link'))).toBe('source.ts');
    expect(existsSync(path.join(snapshot, 'missing.ts'))).toBe(false);
  });

  test('a stable snapshot keeps one path and holds exactly the latest captured bytes', () => {
    const root = fixture();
    const output = fixture();
    const stable = path.join(output, 'workspace');
    writeFileSync(path.join(root, 'removed.ts'), 'present in the first capture');
    const first = manifestFromInventory(root, ['source.ts', 'removed.ts'], 'commit');
    const published = materializeStableSnapshot(first, stable);
    expect(published).toBe(path.join(stable, 'source'));
    expect(readFileSync(path.join(published, 'removed.ts'), 'utf8')).toBe(
      'present in the first capture',
    );

    // An unchanged file keeps its identity across publications; a changed one is replaced.
    writeFileSync(path.join(root, 'kept.ts'), 'unchanged between captures');
    const withKept = manifestFromInventory(root, ['source.ts', 'removed.ts', 'kept.ts'], 'commit');
    materializeStableSnapshot(withKept, stable);
    const kept = statSync(path.join(published, 'kept.ts'));
    const replaced = statSync(path.join(published, 'source.ts')).ino;
    writeFileSync(path.join(root, 'source.ts'), 'export const value = 3;');
    materializeStableSnapshot(
      manifestFromInventory(root, ['source.ts', 'removed.ts', 'kept.ts'], 'commit'),
      stable,
    );
    expect(statSync(path.join(published, 'kept.ts')).ino).toBe(kept.ino);
    expect(statSync(path.join(published, 'kept.ts')).mtimeMs).toBe(kept.mtimeMs);
    expect(statSync(path.join(published, 'source.ts')).ino).not.toBe(replaced);
    expect(readFileSync(path.join(published, 'source.ts'), 'utf8')).toBe('export const value = 3;');

    writeFileSync(path.join(root, 'source.ts'), 'export const value = 2;');
    rmSync(path.join(root, 'removed.ts'));
    rmSync(path.join(root, 'kept.ts'));
    const second = manifestFromInventory(root, ['source.ts'], 'commit');
    expect(materializeStableSnapshot(second, stable)).toBe(published);
    expect(readFileSync(path.join(published, 'source.ts'), 'utf8')).toBe('export const value = 2;');
    expect(existsSync(path.join(published, 'removed.ts'))).toBe(false);
    expect(manifestFromInventory(published, ['source.ts'], 'commit').digest).toBe(second.digest);
    expect(readdirSync(stable)).toEqual(['source']);

    // A copy that fails verification leaves the published one in place.
    writeFileSync(path.join(root, 'source.ts'), 'changed after capture');
    expect(() => materializeStableSnapshot(second, stable)).toThrow('changed');
    expect(readFileSync(path.join(published, 'source.ts'), 'utf8')).toBe('export const value = 2;');
  });

  test('intermediate link identity and parent modes survive copying', () => {
    const root = fixture();
    const output = fixture();
    for (const name of ['first', 'second']) {
      mkdirSync(path.join(root, name));
      writeFileSync(path.join(root, name, 'input'), 'identical');
    }
    chmodSync(path.join(root, 'first'), 0o700);
    symlinkSync('first', path.join(root, 'alias'));
    const before = manifestFromInventory(root, ['alias/input'], 'commit');
    const snapshot = materializeSnapshot(before, path.join(output, 'snapshot'));
    expect(readlinkSync(path.join(snapshot, 'alias'))).toBe('first');
    expect(statSync(path.join(snapshot, 'first')).mode & 0o777).toBe(0o700);
    rmSync(path.join(root, 'alias'));
    symlinkSync('second', path.join(root, 'alias'));
    const after = manifestFromInventory(root, ['alias/input'], 'commit');
    expect(changedInputs(before, after)).toEqual(['alias/input']);
  });

  test('relative links below aliases use the physical parent directory', () => {
    const root = fixture();
    const output = fixture();
    mkdirSync(path.join(root, 'deep', 'parent'), { recursive: true });
    writeFileSync(path.join(root, 'deep', 'input'), 'physical referent');
    writeFileSync(path.join(root, 'input'), 'lexical decoy');
    symlinkSync('deep/parent', path.join(root, 'alias'));
    symlinkSync('../input', path.join(root, 'deep', 'parent', 'link'));
    const manifest = manifestFromInventory(root, ['alias/link'], 'commit');
    const snapshot = materializeSnapshot(manifest, path.join(output, 'snapshot'));
    expect(readFileSync(path.join(snapshot, 'alias', 'link'), 'utf8')).toBe('physical referent');
  });

  test('a source race publishes no partial snapshot and never replaces an existing destination', () => {
    const root = fixture();
    const output = fixture();
    const manifest = manifestFromInventory(root, ['source.ts'], 'commit');
    writeFileSync(path.join(root, 'source.ts'), 'changed before materialization');
    const destination = path.join(output, 'snapshot');
    expect(() => materializeSnapshot(manifest, destination)).toThrow('changed');
    expect(existsSync(destination)).toBe(false);
    mkdirSync(destination);
    writeFileSync(path.join(destination, 'owned-by-another-publisher'), 'keep');
    expect(() => materializeSnapshot(manifest, destination)).toThrow();
    expect(readFileSync(path.join(destination, 'owned-by-another-publisher'), 'utf8')).toBe('keep');
  });

  test('a forged manifest cannot write outside its owned snapshot', () => {
    const root = fixture();
    const output = fixture();
    const captured = manifestFromInventory(root, ['source.ts'], 'commit');
    const forged = {
      ...captured,
      inputs: captured.inputs.map((input) => ({ ...input, path: '../escaped' })),
    };
    expect(() => materializeSnapshot(forged, path.join(output, 'snapshot'))).toThrow('escapes');
    expect(existsSync(path.join(output, 'escaped'))).toBe(false);
    expect(existsSync(path.join(output, 'snapshot'))).toBe(false);
  });
});
