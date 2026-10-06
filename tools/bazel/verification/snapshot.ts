import { createHash } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

export interface SourceInput {
  readonly path: string;
  readonly kind: 'file' | 'symlink' | 'directory' | 'missing';
  readonly executable: boolean;
  readonly mode: number;
  readonly digest: string;
  readonly target?: string;
  readonly referent?: SourceInput;
  readonly children?: readonly SourceInput[];
  readonly resolution: readonly SourceResolution[];
}

export interface SourceResolution {
  readonly path: string;
  readonly resolvedPath: string;
  readonly kind: 'directory' | 'symlink' | 'missing';
  readonly mode: number;
  readonly target?: string;
}

export interface SourceManifest {
  readonly root: string;
  readonly commit: string;
  readonly inputs: readonly SourceInput[];
  readonly digest: string;
}

function digest(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function relativePath(value: unknown, rootAllowed = false): value is string {
  return (
    typeof value === 'string' &&
    ((rootAllowed && value === '') ||
      (value !== '' &&
        value !== '.' &&
        !path.isAbsolute(value) &&
        value === path.normalize(value) &&
        value !== '..' &&
        !value.startsWith(`..${path.sep}`)))
  );
}

function validMode(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0o777;
}

function validResolution(resolution: readonly unknown[]): boolean {
  const resolutionPaths = new Set<string>();
  for (const fact of resolution) {
    if (
      !record(fact) ||
      !relativePath(fact.path, true) ||
      !relativePath(fact.resolvedPath, true) ||
      !validMode(fact.mode) ||
      typeof fact.kind !== 'string' ||
      !['directory', 'symlink', 'missing'].includes(fact.kind) ||
      resolutionPaths.has(fact.path)
    )
      return false;
    resolutionPaths.add(fact.path);
    if (
      fact.kind === 'symlink' &&
      (typeof fact.target !== 'string' || path.isAbsolute(fact.target) || fact.mode !== 0)
    )
      return false;
  }
  return resolutionPaths.has('');
}

function validInput(value: unknown): boolean {
  if (
    !record(value) ||
    !relativePath(value.path) ||
    !validMode(value.mode) ||
    typeof value.executable !== 'boolean' ||
    typeof value.digest !== 'string' ||
    !Array.isArray(value.resolution)
  )
    return false;
  if (!validResolution(value.resolution)) return false;
  if (value.kind === 'file')
    return /^[a-f0-9]{64}$/.test(value.digest) && value.executable === ((value.mode & 0o111) !== 0);
  if (value.executable) return false;
  if (value.kind === 'missing') return value.mode === 0 && value.digest === '';
  if (value.kind === 'symlink')
    return (
      value.mode === 0 &&
      typeof value.target === 'string' &&
      !path.isAbsolute(value.target) &&
      validInput(value.referent) &&
      value.digest === digest(JSON.stringify({ target: value.target, referent: value.referent }))
    );
  if (value.kind !== 'directory' || !Array.isArray(value.children)) return false;
  const children = value.children;
  return (
    children.every(validInput) &&
    children.every(
      (child) =>
        record(child) && typeof child.path === 'string' && path.dirname(child.path) === value.path,
    ) &&
    new Set(children.map((child) => (record(child) ? child.path : null))).size ===
      children.length &&
    value.digest === digest(JSON.stringify(children))
  );
}

/** Validate deserialized evidence before comparing or publishing it. */
export function validSourceManifest(value: unknown): value is SourceManifest {
  try {
    if (
      !record(value) ||
      typeof value.root !== 'string' ||
      !path.isAbsolute(value.root) ||
      typeof value.commit !== 'string' ||
      !Array.isArray(value.inputs) ||
      !value.inputs.every(validInput)
    )
      return false;
    const paths = value.inputs.map((input) => input.path);
    return (
      new Set(paths).size === paths.length &&
      JSON.stringify(paths) === JSON.stringify([...paths].sort()) &&
      value.digest === digest(JSON.stringify(value.inputs))
    );
  } catch {
    return false;
  }
}

function confined(root: string, absolute: string): void {
  let ancestor = absolute;
  for (;;) {
    try {
      const real = realpathSync(ancestor);
      const relative = path.relative(root, real);
      if (relative === '..' || relative.startsWith(`..${path.sep}`)) {
        throw new Error(`Source resolution escapes workspace: ${absolute}`);
      }
      return;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      ancestor = path.dirname(ancestor);
    }
  }
}

function sourceInput(
  root: string,
  file: string,
  parents: ParentFacts,
  ancestors: ReadonlySet<string> = new Set(),
): SourceInput {
  const absolute = path.resolve(root, file);
  const relative = path.relative(root, absolute);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(file)) {
    throw new Error(`Source inventory escapes workspace: ${file}`);
  }
  confined(root, absolute);
  const directory = path.dirname(relative);
  let resolution = parents.get(directory);
  if (resolution === undefined) {
    resolution = parentResolution(root, relative);
    parents.set(directory, resolution);
  }
  if (ancestors.has(absolute)) throw new Error(`Source input cycle: ${file}`);
  const next = new Set([...ancestors, absolute]);
  let info: ReturnType<typeof lstatSync>;
  try {
    info = lstatSync(absolute);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { path: file, kind: 'missing', executable: false, mode: 0, digest: '', resolution };
    }
    throw error;
  }
  if (info.isSymbolicLink()) {
    const target = readlinkSync(absolute);
    const relative = path.relative(
      root,
      path.resolve(realpathSync(path.dirname(absolute)), target),
    );
    if (path.isAbsolute(target) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
      throw new Error(`Source symlink escapes workspace: ${file}`);
    }
    const referent = sourceInput(root, relative, parents, next);
    return {
      path: file,
      kind: 'symlink',
      executable: false,
      mode: 0,
      target,
      referent,
      resolution,
      digest: digest(JSON.stringify({ target, referent })),
    };
  }
  if (info.isDirectory()) {
    const children = readdirSync(absolute)
      .sort()
      .map((child) => sourceInput(root, path.join(file, child), parents, next));
    return {
      path: file,
      kind: 'directory',
      executable: false,
      mode: info.mode & 0o777,
      children,
      resolution,
      digest: digest(JSON.stringify(children)),
    };
  }
  if (!info.isFile()) throw new Error(`Unsupported source inventory entry: ${file}`);
  return {
    path: file,
    kind: 'file',
    executable: (info.mode & 0o111) !== 0,
    mode: info.mode & 0o777,
    digest: digest(readFileSync(absolute)),
    resolution,
  };
}

/**
 * The parent facts one manifest has read, by directory. Every input in a directory states the
 * same facts about it, so a manifest reads each directory's parents once.
 */
type ParentFacts = Map<string, readonly SourceResolution[]>;

/** Record each parent link and the physical directories reached through it. */
function parentResolution(root: string, file: string): readonly SourceResolution[] {
  const facts = new Map<string, SourceResolution>();
  function visit(directory: string, active: ReadonlySet<string>): void {
    const parts = directory === '.' || directory === '' ? [] : directory.split(path.sep);
    for (let length = 0; length <= parts.length; length += 1) {
      const relative = parts.slice(0, length).join(path.sep);
      if (active.has(relative)) throw new Error(`Source parent link cycle: ${relative}`);
      if (facts.has(relative)) continue;
      const absolute = path.join(root, relative);
      confined(root, absolute);
      let info: ReturnType<typeof lstatSync>;
      try {
        info = lstatSync(absolute);
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
        facts.set(relative, { path: relative, resolvedPath: relative, kind: 'missing', mode: 0 });
        break;
      }
      if (info.isSymbolicLink()) {
        const target = readlinkSync(absolute);
        const referent = path.relative(
          root,
          path.resolve(realpathSync(path.dirname(absolute)), target),
        );
        if (path.isAbsolute(target) || referent === '..' || referent.startsWith(`..${path.sep}`))
          throw new Error(`Source parent symlink escapes workspace: ${relative}`);
        const resolvedPath = path.join(
          path.relative(root, realpathSync(path.dirname(absolute))),
          path.basename(absolute),
        );
        facts.set(relative, { path: relative, resolvedPath, kind: 'symlink', mode: 0, target });
        visit(referent, new Set([...active, relative]));
      } else if (info.isDirectory()) {
        facts.set(relative, {
          path: relative,
          resolvedPath: path.relative(root, realpathSync(absolute)),
          kind: 'directory',
          mode: info.mode & 0o777,
        });
      } else throw new Error(`Source parent is not a directory: ${relative}`);
    }
  }
  visit(path.dirname(file), new Set());
  return [...facts.values()].sort((left, right) => left.path.localeCompare(right.path));
}

export function manifestFromInventory(
  directory: string,
  files: readonly string[],
  commit: string,
): SourceManifest {
  const root = realpathSync(directory);
  const parents: ParentFacts = new Map();
  const inputs = [...new Set(files)].sort().map((file) => sourceInput(root, file, parents));
  return { root, commit, inputs, digest: digest(JSON.stringify(inputs)) };
}

/** Current-tree validity is separate from successful execution of the captured inputs. */
export function changedInputs(before: SourceManifest, after: SourceManifest): string[] {
  const prior = new Map(before.inputs.map((input) => [input.path, JSON.stringify(input)]));
  const current = new Map(after.inputs.map((input) => [input.path, JSON.stringify(input)]));
  return [...new Set([...prior.keys(), ...current.keys()])]
    .filter((file) => prior.get(file) !== current.get(file))
    .sort();
}

/**
 * Move `fresh` into `target`, leaving in place every file whose bytes and mode already match.
 * An untouched file keeps its identity, so an engine that has read it does not read it again.
 */
function adoptEntry(fresh: string, target: string): void {
  const incoming = lstatSync(fresh);
  let existing: typeof incoming | undefined;
  try {
    existing = lstatSync(target);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  if (incoming.isDirectory() && existing?.isDirectory()) {
    // A directory may be read-only; its captured mode returns once its entries are settled.
    chmodSync(target, 0o700);
    const names = new Set(readdirSync(fresh));
    for (const name of readdirSync(target))
      if (!names.has(name)) rmSync(path.join(target, name), { recursive: true, force: true });
    for (const name of names) adoptEntry(path.join(fresh, name), path.join(target, name));
    chmodSync(target, incoming.mode & 0o7777);
    return;
  }
  if (
    existing !== undefined &&
    ((incoming.isSymbolicLink() &&
      existing.isSymbolicLink() &&
      readlinkSync(target) === readlinkSync(fresh)) ||
      (incoming.isFile() &&
        existing.isFile() &&
        (existing.mode & 0o7777) === (incoming.mode & 0o7777) &&
        existing.size === incoming.size &&
        readFileSync(target).equals(readFileSync(fresh))))
  )
    return;
  rmSync(target, { recursive: true, force: true });
  renameSync(fresh, target);
}

/**
 * Publish a verified copy at one path that outlives the run, so the engine that serves that
 * workspace stays warm. The copy is built and verified beside it; then only the entries that
 * differ are moved into place, and the published tree is verified against the manifest.
 */
export function materializeStableSnapshot(manifest: SourceManifest, stable: string): string {
  mkdirSync(stable, { recursive: true });
  const pending = path.join(stable, `pending-${process.pid}`);
  const published = path.join(stable, 'source');
  rmSync(pending, { recursive: true, force: true });
  const copy = materializeSnapshot(manifest, pending);
  try {
    adoptEntry(copy, published);
    const inventory = manifest.inputs.map((input) => input.path);
    if (manifestFromInventory(published, inventory, manifest.commit).digest !== manifest.digest)
      throw new Error('Published source snapshot does not match its manifest');
  } finally {
    rmSync(pending, { recursive: true, force: true });
  }
  return published;
}

/** Copy declared source bytes, including ignored referents, before invoking the compiler graph. */
export function materializeSnapshot(manifest: SourceManifest, destination: string): string {
  const parent = realpathSync(path.dirname(destination));
  const relative = path.relative(manifest.root, parent);
  if (relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`))) {
    throw new Error('Source snapshot destination must be outside the workspace');
  }
  const inventory = manifest.inputs.map((input) => input.path);
  const initial = manifestFromInventory(manifest.root, inventory, manifest.commit);
  if (
    initial.digest !== manifest.digest ||
    digest(JSON.stringify(manifest.inputs)) !== manifest.digest
  ) {
    throw new Error('Source changed or snapshot manifest is invalid');
  }
  // Exclusive creation establishes ownership; a failed copy cannot erase another publisher.
  mkdirSync(destination);
  const staging = mkdtempSync(path.join(destination, '.pending-'));
  const copied = new Set<string>();
  const directoryModes = new Map<string, number>();
  function prepare(input: SourceInput): void {
    for (const fact of input.resolution) {
      if (fact.kind !== 'directory') continue;
      const output = path.join(staging, fact.resolvedPath);
      mkdirSync(output, { recursive: true });
      directoryModes.set(output, fact.mode);
    }
    for (const fact of input.resolution) {
      if (fact.kind !== 'symlink' || fact.target === undefined) continue;
      const output = path.join(staging, fact.resolvedPath);
      let existing: ReturnType<typeof lstatSync> | undefined;
      try {
        existing = lstatSync(output);
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
      if (existing === undefined) symlinkSync(fact.target, output);
      else if (!existing.isSymbolicLink() || readlinkSync(output) !== fact.target)
        throw new Error(`Conflicting source parent identities: ${fact.path}`);
    }
  }
  function copy(input: SourceInput): void {
    if (copied.has(input.path)) return;
    copied.add(input.path);
    prepare(input);
    const output = path.join(staging, input.path);
    if (input.kind === 'missing') return;
    mkdirSync(path.dirname(output), { recursive: true });
    if (input.kind === 'directory') {
      mkdirSync(output, { recursive: true });
      for (const child of input.children ?? []) copy(child);
      directoryModes.set(output, input.mode);
    } else if (input.kind === 'symlink') {
      if (input.target === undefined || input.referent === undefined)
        throw new Error('Invalid source link manifest');
      copy(input.referent);
      try {
        symlinkSync(input.target, output);
      } catch (error) {
        if (
          !(error instanceof Error && 'code' in error && error.code === 'EEXIST') ||
          !lstatSync(output).isSymbolicLink() ||
          readlinkSync(output) !== input.target
        )
          throw error;
      }
    } else {
      confined(manifest.root, path.join(manifest.root, input.path));
      const bytes = readFileSync(path.join(manifest.root, input.path));
      if (digest(bytes) !== input.digest)
        throw new Error(`Source changed during snapshot: ${input.path}`);
      try {
        writeFileSync(output, bytes, { flag: 'wx', mode: input.mode });
      } catch (error) {
        if (
          !(error instanceof Error && 'code' in error && error.code === 'EEXIST') ||
          digest(readFileSync(output)) !== input.digest
        )
          throw error;
      }
      chmodSync(output, input.mode);
    }
  }
  try {
    for (const input of manifest.inputs) copy(input);
    for (const [directory, mode] of [...directoryModes].sort(
      (left, right) => right[0].length - left[0].length,
    ))
      chmodSync(directory, mode);
    const copiedManifest = manifestFromInventory(staging, inventory, manifest.commit);
    if (copiedManifest.digest !== manifest.digest)
      throw new Error('Copied source snapshot does not match its manifest');
    const current = manifestFromInventory(manifest.root, inventory, manifest.commit);
    if (current.digest !== manifest.digest) throw new Error('Source changed during snapshot');
    const published = path.join(destination, 'source');
    renameSync(staging, published);
    return published;
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}
