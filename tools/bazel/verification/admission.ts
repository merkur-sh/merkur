import path from 'node:path';
import { type GitContext, validGitContext } from './git-context';
import { type SourceInput, type SourceManifest, validSourceManifest } from './snapshot';

function sourcePath(value: string): string {
  if (
    value === '' ||
    value.includes('\\') ||
    value.includes('\0') ||
    value.split('/').some((part) => part === '' || part === '.' || part === '..') ||
    ['external', 'bazel-out'].includes(value.split('/')[0] ?? '')
  ) {
    throw new Error(`Unsafe or reserved first-party input: ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * A declared action input is not permission to upload a private local file. Every physical
 * file and symlink must be tracked or explicitly admitted before the snapshot reaches CAS.
 */
export function admitSourceInputs(
  manifest: SourceManifest,
  git: GitContext,
  approvedUntracked: readonly string[],
): readonly string[] {
  if (!validSourceManifest(manifest)) throw new Error('Cannot admit an invalid source manifest');
  if (!validGitContext(git)) throw new Error('Cannot admit invalid Git context');
  if (manifest.commit !== git.head) throw new Error('Source admission belongs to another Git head');
  const tracked = new Set(git.index.map((entry) => sourcePath(entry.path)));
  const approved = new Set(approvedUntracked.map(sourcePath));
  if (approved.size !== approvedUntracked.length) throw new Error('Duplicate source admission');
  const admitted = new Set<string>();
  function requireAdmission(name: string): void {
    sourcePath(name);
    if (tracked.has(name)) return;
    if (!approved.has(name))
      throw new Error(`Untracked physical input requires admission: ${name}`);
    admitted.add(name);
  }
  function visit(input: SourceInput): void {
    sourcePath(input.path);
    for (const fact of input.resolution) {
      if (fact.kind !== 'symlink') continue;
      requireAdmission(fact.resolvedPath);
    }
    if (input.kind === 'missing') return;
    if (input.kind === 'directory') {
      for (const child of input.children ?? []) visit(child);
      return;
    }
    function physicalDirectory(name: string, active: ReadonlySet<string>): string {
      const canonical = name === '.' ? '' : name;
      if (active.has(canonical)) throw new Error('Cyclic admission parent facts');
      const fact = input.resolution.find((entry) => entry.path === canonical);
      if (fact === undefined || fact.kind === 'missing') {
        throw new Error('Source admission lacks physical parent identity');
      }
      if (fact.kind === 'directory') return fact.resolvedPath;
      if (fact.target === undefined) throw new Error('Source admission lacks parent link target');
      const target = path.posix.normalize(
        path.posix.join(path.posix.dirname(fact.resolvedPath), fact.target),
      );
      if (target !== '.') sourcePath(target);
      return physicalDirectory(target, new Set([...active, canonical]));
    }
    const parent = physicalDirectory(path.posix.dirname(input.path), new Set());
    const physical =
      parent === ''
        ? path.posix.basename(input.path)
        : `${parent}/${path.posix.basename(input.path)}`;
    requireAdmission(physical);
    if (input.kind === 'symlink' && input.referent !== undefined) visit(input.referent);
  }
  for (const input of manifest.inputs) visit(input);
  return [...admitted].sort();
}
