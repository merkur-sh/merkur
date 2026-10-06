import { createHash } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
} from 'node:fs';
import path from 'node:path';
import { type SourceInput, type SourceManifest, validSourceManifest } from './snapshot';

/** Restore captured source aliases only when their complete referents are declared in the tree. */
export function restoreSourceAliases(root: string, manifest: SourceManifest): void {
  if (!validSourceManifest(manifest)) throw new Error('Invalid captured alias manifest');
  const physicalRoot = realpathSync(root);
  const sourceRelative = path.relative(manifest.root, physicalRoot);
  if (
    sourceRelative === '' ||
    (sourceRelative !== '..' && !sourceRelative.startsWith(`..${path.sep}`))
  )
    throw new Error('Alias restoration requires a private copy outside the captured source');
  function confined(file: string): string {
    const absolute = path.resolve(physicalRoot, file);
    const relative = path.relative(physicalRoot, absolute);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      throw new Error('Captured source alias escapes its declared tree');
    return absolute;
  }
  const restored = new Map<string, string>();
  const active = new Set<string>();
  const modes = new Map<string, number>();
  function restore(input: SourceInput): void {
    if (input.kind !== 'symlink' || input.target === undefined || input.referent === undefined)
      throw new Error('Alias manifest contains a non-alias input');
    const previous = restored.get(input.path);
    if (previous !== undefined) {
      if (previous !== input.digest) throw new Error('Conflicting captured source aliases');
      return;
    }
    if (active.has(input.path)) throw new Error('Cyclic captured source aliases');
    active.add(input.path);
    const output = confined(input.path);
    const target = confined(
      path.relative(physicalRoot, path.resolve(path.dirname(output), input.target)),
    );
    if (target !== confined(input.referent.path))
      throw new Error('Captured alias target does not match its declared referent');
    verify(input.referent);
    mkdirSync(path.dirname(output), { recursive: true });
    const parent = realpathSync(path.dirname(output));
    confined(path.relative(physicalRoot, parent));
    symlinkSync(input.target, output);
    active.delete(input.path);
    restored.set(input.path, input.digest);
  }
  function verify(input: SourceInput): void {
    if (input.kind === 'symlink') {
      restore(input);
      if (readlinkSync(confined(input.path)) !== input.target)
        throw new Error('Captured alias differs from restored source');
      return;
    }
    const absolute = confined(input.path);
    const resolved = realpathSync(absolute);
    confined(path.relative(physicalRoot, resolved));
    const info = lstatSync(absolute);
    if (input.kind === 'file') {
      if (
        !info.isFile() ||
        createHash('sha256').update(readFileSync(absolute)).digest('hex') !== input.digest
      )
        throw new Error('Captured alias referent differs from declared source');
      // Tree artifacts normalize permissions. Restore logical source mode from the
      // captured manifest after verifying bytes, only within the owned private copy.
      modes.set(absolute, input.mode);
    } else if (input.kind === 'directory') {
      const children = input.children ?? [];
      const actual = readdirSync(absolute).sort();
      const expected = children.map((child) => path.basename(child.path)).sort();
      const aliases = children
        .filter((child) => child.kind === 'symlink')
        .map((child) => path.basename(child.path));
      if (
        !info.isDirectory() ||
        actual.some((name) => !expected.includes(name)) ||
        expected.some((name) => !actual.includes(name) && !aliases.includes(name))
      )
        throw new Error('Captured alias directory has an incomplete declared inventory');
      for (const child of children) verify(child);
      if (JSON.stringify(readdirSync(absolute).sort()) !== JSON.stringify(expected))
        throw new Error('Restored alias directory differs from its captured inventory');
      modes.set(absolute, input.mode);
    } else {
      throw new Error('Alias referents must be complete declared regular source trees');
    }
  }
  for (const input of manifest.inputs) {
    if (input.kind === 'missing') continue;
    restore(input);
  }
  // Restrictive directory modes are applied after child aliases have been created.
  for (const [file, mode] of [...modes].sort(([a], [b]) => b.length - a.length))
    chmodSync(file, mode);
}
