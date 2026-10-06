import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { openOwnedDirectory } from '../bun/owned-files';
import type { GitContext, IndexEntry } from './git-context';
import { manifestFromInventory, type SourceManifest } from './snapshot';

export interface HeadSnapshotOptions {
  readonly sourceRoot: string;
  readonly destination: string;
  readonly head: GitContext['head'];
  readonly runGit: (args: readonly string[]) => Uint8Array;
}

export interface StagedSnapshotOptions extends HeadSnapshotOptions {
  readonly index: GitContext['index'];
  readonly indexTree: string;
}

export interface HeadSnapshot {
  readonly manifest: SourceManifest;
  readonly assertCurrent: () => void;
}

export interface StagedSnapshot extends HeadSnapshot {
  readonly head: GitContext['head'];
  readonly indexTree: string;
}

function object(value: string): string {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value) || /^0+$/.test(value))
    throw new Error('Staged snapshot requires a full Git object identity');
  return value;
}

function sourcePath(value: string): string {
  if (
    value === '' ||
    value.includes('\\') ||
    value.includes('\0') ||
    path.isAbsolute(value) ||
    value.split('/').some((part) => part === '' || part === '.' || part === '..')
  )
    throw new Error('Staged snapshot contains an unsafe source path');
  return value;
}

function indexBytes(index: GitContext['index']): Buffer {
  const names = new Set<string>();
  const entries = index.map((entry) => {
    sourcePath(entry.path);
    object(entry.object);
    if (entry.mode === '160000') throw new Error('Staged snapshot cannot materialize Git links');
    if (!['100644', '100755', '120000'].includes(entry.mode))
      throw new Error('Staged snapshot contains an unsupported index mode');
    if (names.has(entry.path)) throw new Error('Staged snapshot contains duplicate index paths');
    names.add(entry.path);
    return { ...entry };
  });
  for (const name of names) {
    let parent = path.posix.dirname(name);
    while (parent !== '.') {
      if (names.has(parent)) throw new Error('Staged snapshot contains conflicting index paths');
      parent = path.posix.dirname(parent);
    }
  }
  return Buffer.from(
    entries
      .sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)))
      .map((entry) => `${entry.mode} ${entry.object} 0\t${entry.path}\0`)
      .join(''),
  );
}

function materializeObjects(
  options: HeadSnapshotOptions,
  index: GitContext['index'],
  assertCurrent: () => void,
): SourceManifest {
  const head = options.head;
  const runGit = options.runGit;
  const sourceRoot = realpathSync(options.sourceRoot);
  if (!path.isAbsolute(options.destination))
    throw new Error('Staged snapshot destination must be absolute');
  const parent = realpathSync(path.dirname(options.destination));
  const relative = path.relative(sourceRoot, parent);
  if (relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`)))
    throw new Error('Staged snapshot destination must be outside the source workspace');
  const name = sourcePath(path.basename(options.destination));
  const destination = path.join(parent, name);
  assertCurrent();
  const owned = openOwnedDirectory(parent);
  let complete = false;
  try {
    owned.directory(name);
    // A pre-existing directory is caller-owned and cannot satisfy exclusive creation.
    owned.setDirectoryMode(name, 0o755);
    for (const entry of index) {
      const bytes = Buffer.from(runGit(['cat-file', 'blob', entry.object]));
      const identity = createHash(entry.object.length === 40 ? 'sha1' : 'sha256')
        .update(`blob ${bytes.byteLength}\0`)
        .update(bytes)
        .digest('hex');
      if (identity !== entry.object)
        throw new Error('Staged snapshot blob bytes differ from their Git object');
      const output = path.join(name, entry.path);
      if (entry.mode === '120000') {
        const target = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        const referent = path.posix.normalize(
          path.posix.join(path.posix.dirname(entry.path), target),
        );
        if (
          target === '' ||
          target.includes('\0') ||
          target.includes('\\') ||
          path.posix.isAbsolute(target) ||
          referent === '..' ||
          referent.startsWith('../')
        )
          throw new Error('Staged snapshot symlink escapes its source workspace');
        owned.symlink(output, target);
      } else owned.write(output, bytes, entry.mode === '100755' ? 0o755 : 0o644);
    }
    owned.verifyDirectory(name);
    const manifest = manifestFromInventory(
      destination,
      index.map((entry) => entry.path),
      head,
    );
    for (const entry of index) owned.verify(path.join(name, entry.path));
    owned.verifyDirectory(name);
    assertCurrent();
    complete = true;
    return manifest;
  } finally {
    try {
      if (!complete) owned.removeCreated();
    } finally {
      owned.close();
    }
  }
}

/** Materialize the captured index, including partially staged files, without reading live bytes. */
export function materializeStagedSnapshot(options: StagedSnapshotOptions): StagedSnapshot {
  const head = object(options.head);
  const indexTree = object(options.indexTree);
  const index = options.index.map((entry) => Object.freeze({ ...entry }));
  const expected = indexBytes(index);
  const runGit = options.runGit;
  const text = (args: readonly string[]) =>
    new TextDecoder('utf-8', { fatal: true }).decode(runGit(args));
  function assertCurrent(): void {
    const currentHead = text(['rev-parse', '--verify', 'HEAD^{commit}']).trim();
    const currentIndex = Buffer.from(runGit(['ls-files', '--stage', '-z']));
    const records = new TextDecoder('utf-8', { fatal: true }).decode(currentIndex).split('\0');
    if (records.some((record) => record !== '' && record.split('\t', 1)[0]?.split(' ')[2] !== '0'))
      throw new Error('Staged snapshot Git index contains unresolved merge entries');
    const currentTree = text(['write-tree']).trim();
    const finalHead = text(['rev-parse', '--verify', 'HEAD^{commit}']).trim();
    const finalIndex = Buffer.from(runGit(['ls-files', '--stage', '-z']));
    if (
      currentHead !== head ||
      finalHead !== head ||
      currentTree !== indexTree ||
      !currentIndex.equals(expected) ||
      !finalIndex.equals(expected)
    )
      throw new Error('Staged snapshot HEAD or index changed');
  }
  const manifest = materializeObjects({ ...options, head, runGit }, index, assertCurrent);
  return Object.freeze({ manifest, head, indexTree, assertCurrent });
}

/** Materialize the immutable HEAD baseline without requiring the live index to match it. */
export function materializeHeadSnapshot(options: HeadSnapshotOptions): HeadSnapshot {
  const head = object(options.head);
  const runGit = options.runGit;
  const text = (args: readonly string[]) =>
    new TextDecoder('utf-8', { fatal: true }).decode(runGit(args));
  function assertCurrent(): void {
    if (text(['rev-parse', '--verify', 'HEAD^{commit}']).trim() !== head)
      throw new Error('HEAD snapshot Git head changed');
  }
  assertCurrent();
  const tree = text(['ls-tree', '-rz', '--full-tree', head]);
  if (tree !== '' && !tree.endsWith('\0'))
    throw new Error('HEAD snapshot contains truncated tree records');
  const index: IndexEntry[] = (tree === '' ? [] : tree.slice(0, -1).split('\0')).map((row) => {
    const separator = row.indexOf('\t');
    const match = /^(100644|100755|120000) blob ([a-f0-9]{40}|[a-f0-9]{64})$/.exec(
      row.slice(0, separator),
    );
    if (separator === -1 || match?.[1] === undefined || match[2] === undefined)
      throw new Error('HEAD snapshot contains an unsupported tree entry');
    return Object.freeze({ path: row.slice(separator + 1), mode: match[1], object: match[2] });
  });
  indexBytes(index);
  const manifest = materializeObjects({ ...options, head, runGit }, index, assertCurrent);
  return Object.freeze({ manifest, assertCurrent });
}
