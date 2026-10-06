import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { openOwnedDirectory } from '../bun/owned-files';
import { readEngineArtifact } from './artifacts';
import {
  manifestFromInventory,
  type SourceInput,
  type SourceManifest,
  validSourceManifest,
} from './snapshot';

const activeReconstructions = new Map<
  string,
  {
    readonly source: SourceManifest;
    readonly contents: (
      replacements: readonly { readonly path: string; readonly bytes: Uint8Array }[],
      run: () => void,
    ) => void;
    readonly verify: () => void;
  }
>();

/** A temporary generated role can borrow only the active original reconstruction journal. */
export function withCapturedSourceContents(
  root: string,
  source: SourceManifest,
  replacements: readonly { readonly path: string; readonly bytes: Uint8Array }[],
  run: () => void,
): void {
  const physical = realpathSync(root);
  const owner = activeReconstructions.get(physical);
  if (
    owner === undefined ||
    owner.source.root !== source.root ||
    owner.source.digest !== source.digest ||
    owner.source.commit !== source.commit
  )
    throw new Error('Captured source projection requires its active private reconstruction owner');
  owner.verify();
  owner.contents(replacements, run);
  owner.verify();
}

function portable(relative: string): string {
  if (
    relative.includes('\\') ||
    relative.includes('\0') ||
    relative.startsWith('/') ||
    relative.split('/').some((part) => part === '' || part === '.' || part === '..')
  )
    throw new Error('Captured source requires a confined portable path');
  return relative;
}

export function sourceLayout(source: SourceManifest) {
  const directories = new Map<string, number>();
  const aliases = new Map<string, string>();
  const files = new Map<string, SourceInput>();
  const missing = new Set<string>();
  function unique<T>(entries: Map<string, T>, relative: string, value: T): void {
    const previous = entries.get(relative);
    if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(value))
      throw new Error('Captured source has conflicting physical identities');
    entries.set(relative, value);
  }
  function physical(relative: string): string {
    const active = new Set<string>();
    let result = relative;
    for (;;) {
      const parts = result.split('/');
      const alias = parts
        .slice(0, -1)
        .map((_, index) => parts.slice(0, index + 1).join('/'))
        .find((parent) => aliases.has(parent));
      if (alias === undefined) return portable(result);
      if (active.has(alias)) throw new Error('Captured source has a cyclic parent alias');
      active.add(alias);
      const target = aliases.get(alias);
      if (target === undefined) throw new Error('Captured source alias target is absent');
      result = portable(
        path.posix.join(path.posix.dirname(alias), target, result.slice(alias.length + 1)),
      );
    }
  }
  function parents(input: SourceInput): void {
    for (const fact of input.resolution) {
      if (fact.resolvedPath !== '') portable(fact.resolvedPath);
      if (fact.kind === 'directory') unique(directories, fact.resolvedPath, fact.mode);
      else if (fact.kind === 'symlink' && fact.target !== undefined)
        unique(aliases, fact.resolvedPath, fact.target);
    }
    if (input.referent !== undefined) parents(input.referent);
    for (const child of input.children ?? []) parents(child);
  }
  function collect(input: SourceInput): void {
    const relative = physical(input.path);
    if (input.kind === 'directory') {
      unique(directories, relative, input.mode);
      for (const child of input.children ?? []) collect(child);
    } else if (input.kind === 'symlink') {
      if (input.target === undefined || input.referent === undefined)
        throw new Error('Captured source alias is incomplete');
      unique(aliases, relative, input.target);
      collect(input.referent);
    } else if (input.kind === 'file') {
      const previous = files.get(relative);
      if (
        previous !== undefined &&
        (previous.digest !== input.digest || previous.mode !== input.mode)
      )
        throw new Error('Captured file aliases disagree on bytes or mode');
      files.set(relative, input);
    } else missing.add(relative);
  }
  for (const input of source.inputs) parents(input);
  for (const input of source.inputs) collect(input);
  const rootMode = directories.get('');
  if (rootMode === undefined) throw new Error('Captured source root identity is absent');
  for (const relative of [...files.keys(), ...aliases.keys()]) {
    if (directories.has(relative) || missing.has(relative))
      throw new Error('Captured source entry has conflicting kinds');
  }
  return { directories, aliases, files, rootMode };
}

export interface CapturedSource {
  /** The published tree, or the directory that holds the original payload. */
  readonly tree: string;
  /** Where each file lies under `tree`, by logical path; a published tree needs none. */
  readonly members?: Readonly<Record<string, string>>;
  readonly root: string;
  readonly source: SourceManifest;
}

/**
 * A sandbox presents each declared member as a carrier of that same member in the engine's own
 * directory, so every member must resolve inside one physical tree.
 */
function presentedMember(tree: string, location: string, presented: string | undefined) {
  const original = realpathSync(path.join(tree, portable(location)));
  const member = `${path.sep}${location.split('/').join(path.sep)}`;
  const physical = original.endsWith(member) ? original.slice(0, -member.length) : undefined;
  if (physical === undefined || physical !== (presented ?? physical))
    throw new Error('Declared source tree member escapes its engine presentation');
  const info = lstatSync(original, { bigint: true });
  if (!info.isFile()) throw new Error('Declared source tree contains a non-regular file');
  return { physical, info };
}

/**
 * The original payload a test declares: the mapping names this payload's directory in the
 * runfiles and each captured file's place in it, and must name every captured file.
 */
export function capturedSourcePayload(
  mapping: string,
  runfiles: string,
  source: SourceManifest,
): { readonly tree: string; readonly members: Readonly<Record<string, string>> } {
  const value: unknown = JSON.parse(readFileSync(mapping, 'utf8'));
  if (
    !path.isAbsolute(runfiles) ||
    typeof value !== 'object' ||
    value === null ||
    !('directory' in value) ||
    !('files' in value) ||
    typeof value.directory !== 'string' ||
    typeof value.files !== 'object' ||
    value.files === null ||
    !Object.values(value.files).every((member) => typeof member === 'string')
  )
    throw new Error('Captured source payload mapping is malformed');
  const expected = [...sourceLayout(source).files.values()].map((input) => input.path).sort();
  if (JSON.stringify(Object.keys(value.files).sort()) !== JSON.stringify(expected))
    throw new Error('Complete original captured source File membership is required');
  return {
    tree: path.join(runfiles, portable(value.directory)),
    members: value.files as Readonly<Record<string, string>>,
  };
}

/**
 * Reconstruct the complete logical source from declared bytes, never from the live checkout.
 * With a consumer the tree is private to it and removed afterwards; without one it is published.
 */
async function capturedSourceTree<T>(
  options: CapturedSource,
  use?: (root: string) => Promise<T>,
): Promise<T> {
  if (!validSourceManifest(options.source)) throw new Error('Captured full source is invalid');
  const tree = realpathSync(options.tree);
  const root = realpathSync(options.root);
  const relative = path.relative(options.source.root, root);
  const treeRelative = path.relative(tree, root);
  const identity = lstatSync(root);
  if (
    !identity.isDirectory() ||
    treeRelative === '' ||
    (treeRelative !== '..' && !treeRelative.startsWith(`..${path.sep}`)) ||
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`)) ||
    readdirSync(root).length !== 0
  )
    throw new Error('Source reconstruction requires an empty exclusive private directory');
  const layout = sourceLayout(options.source);
  const owned = openOwnedDirectory(root);
  function verifyRoot(): void {
    const current = lstatSync(root);
    if (
      !current.isDirectory() ||
      current.ino !== identity.ino ||
      current.dev !== identity.dev ||
      realpathSync(root) !== root
    )
      throw new Error('Private source root was replaced');
  }
  function verifyJournal(): void {
    verifyRoot();
    owned.verifyJournal(layout.directories.keys(), [
      ...layout.files.keys(),
      ...layout.aliases.keys(),
    ]);
  }
  const inventory = options.source.inputs.map((input) => input.path);
  const expected = [
    ...[...layout.directories.keys()].filter((directory) => directory !== ''),
    ...layout.files.keys(),
    ...layout.aliases.keys(),
  ].sort();
  function verifyTree(): void {
    verifyJournal();
    const actual: string[] = [];
    function visit(directory: string): void {
      for (const name of readdirSync(path.join(root, directory))) {
        const member = path.posix.join(directory, name);
        actual.push(member);
        if (lstatSync(path.join(root, member)).isDirectory()) visit(member);
      }
    }
    visit('');
    if (JSON.stringify(actual.sort()) !== JSON.stringify(expected)) {
      const actualMembers = new Set(actual);
      const expectedMembers = new Set(expected);
      throw new Error(
        `Captured source membership changed during its consumer: ${JSON.stringify({
          added: actual.filter((member) => !expectedMembers.has(member)),
          removed: expected.filter((member) => !actualMembers.has(member)),
        })}`,
      );
    }
    if (
      manifestFromInventory(root, inventory, options.source.commit).digest !== options.source.digest
    )
      throw new Error('Captured source bytes or topology changed during its consumer');
    verifyJournal();
  }
  const failures: unknown[] = [];
  let result: T | undefined;
  try {
    for (const directory of [...layout.directories.keys()]
      .filter((entry) => entry !== '')
      .sort(
        (left, right) =>
          left.split('/').length - right.split('/').length || left.localeCompare(right),
      ))
      owned.directory(directory);
    let presented: string | undefined;
    for (const [destination, input] of layout.files) {
      verifyRoot();
      const location = options.members === undefined ? destination : options.members[input.path];
      if (location === undefined) throw new Error('Captured source File has no original payload');
      const { physical, info } = presentedMember(tree, location, presented);
      presented = physical;
      // The engine sets the modes of a tree it publishes; an original payload File keeps its own.
      if (options.members !== undefined && (Number(info.mode) & 0o777) !== input.mode)
        throw new Error('Captured original source File mode differs from its manifest');
      const bytes = await readEngineArtifact(physical, {
        path: location,
        digest: input.digest,
        length: String(info.size),
      });
      owned.write(destination, bytes, input.mode);
    }
    for (const [destination, target] of layout.aliases) {
      portable(path.posix.join(path.posix.dirname(destination), target));
      owned.symlink(destination, target);
    }
    for (const [directory, mode] of [...layout.directories].sort(
      ([left], [right]) => right.length - left.length,
    ))
      owned.setDirectoryMode(directory, mode);
    verifyTree();
    // A published tree has no consumer, so nothing separates a second proof from the first.
    if (use !== undefined) {
      activeReconstructions.set(root, {
        source: options.source,
        contents: owned.withTemporaryContents.bind(owned),
        verify: verifyJournal,
      });
      try {
        result = await use(root);
      } finally {
        activeReconstructions.delete(root);
      }
      verifyTree();
    }
  } catch (error) {
    failures.push(error);
  }
  if (use === undefined && failures.length === 0) {
    owned.close();
    return result as T;
  }
  try {
    // This exclusive private root may have received a captured read-only mode.
    // Restore owner access through its held descriptor before removing owned children.
    owned.setDirectoryMode('', (identity.mode & 0o777) | 0o700);
  } catch (error) {
    failures.push(error);
  }
  try {
    owned.removeCreated();
  } catch (error) {
    failures.push(error);
  }
  try {
    owned.setDirectoryMode('', identity.mode & 0o777);
  } catch (error) {
    failures.push(error);
  }
  try {
    owned.close();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'Captured source cleanup failed');
  return result as T;
}

export async function withCapturedSourceTree<T>(
  options: CapturedSource,
  use: (root: string) => Promise<T>,
): Promise<T> {
  return capturedSourceTree(options, use);
}

/** Publish the same validated original source tree as an engine-declared output. */
export async function publishCapturedSourceTree(options: {
  readonly tree: string;
  readonly root: string;
  readonly source: SourceManifest;
}): Promise<void> {
  await capturedSourceTree<void>(options);
}
