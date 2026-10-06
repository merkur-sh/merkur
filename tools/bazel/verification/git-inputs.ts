import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { admitSourceInputs } from './admission';
import { type GitContext, validGitContext } from './git-context';
import { manifestFromInventory, materializeSnapshot, type SourceManifest } from './snapshot';
import { sourceLayout } from './source-tree';

export type GitBytesReader = (args: readonly string[], input?: Uint8Array) => Buffer;

/**
 * Git chooses a pack's encoding afresh each time, so the same objects yield different bytes
 * and every check that reads the pack sees a changed input. A run with a pack directory keeps
 * the last pack beside the digest of its object identities and its own digest, and reads
 * those bytes again for the same identities.
 */
export function acquiredPack(
  directory: string | undefined,
  identities: string,
  produce: () => Buffer,
): Buffer {
  if (directory === undefined) return produce();
  if (!path.isAbsolute(directory)) throw new Error('Object pack directory must be absolute');
  const sha256 = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  const keyFile = path.join(directory, 'objects.key');
  const packFile = path.join(directory, 'objects.pack');
  const objects = sha256(identities);
  try {
    const [held, digest] = readFileSync(keyFile, 'utf8').split('\n');
    if (held === objects) {
      const pack = readFileSync(packFile);
      if (sha256(pack) === digest) return pack;
    }
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  const pack = produce();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  // The key goes first and returns last, so it never names another pack's bytes.
  rmSync(keyFile, { force: true });
  for (const [file, bytes] of [
    [packFile, pack],
    [keyFile, `${objects}\n${sha256(pack)}\n`],
  ] as const) {
    const staged = `${file}.${process.pid}.tmp`;
    writeFileSync(staged, bytes, { mode: 0o600 });
    renameSync(staged, file);
  }
  return pack;
}

/**
 * The complete admitted source of a run: every indexed and explicitly admitted file, read
 * once. Everything a run keys an earlier answer by follows from it and the Git facts, so it is
 * captured before anything is acquired for an engine.
 */
export function capturedSource(options: {
  readonly root: string;
  readonly context: GitContext;
  readonly admittedUntracked: readonly string[];
  readonly read: GitBytesReader;
}): SourceManifest {
  const context = options.context;

  if (!validGitContext(context)) throw new Error('Fresh Git context required');

  if (context.index.some((entry) => entry.mode === '160000'))
    throw new Error('Submodule source acquisition is not implemented');

  if (options.read(['rev-parse', '--is-shallow-repository']).toString() !== 'false\n')
    throw new Error(
      'Source acquisition requires complete Git ancestry; shallow repositories are unqualified',
    );

  if (options.admittedUntracked.some((name) => !context.untracked.includes(name)))
    throw new Error('Explicit source admission must identify current untracked files');

  const inventory = [
    ...new Set([...context.index.map((entry) => entry.path), ...options.admittedUntracked]),
  ].sort();

  const source = manifestFromInventory(options.root, inventory, context.head);

  admitSourceInputs(source, context, options.admittedUntracked);

  return source;
}

/**
 * Acquire the captured source and its Git objects for the engine, before any source action
 * can reach a cache. The source and the Git facts must still be the captured ones when it ends.
 */
export function acquireGitInputs(options: {
  readonly root: string;
  readonly destination: string;
  readonly context: GitContext;
  readonly source: SourceManifest;
  readonly read: GitBytesReader;
  readonly recapture: () => GitContext;
  /** Where an ordinary run keeps the last object pack; absent, every pack is produced anew. */
  readonly packs?: string;
}): void {
  const { context, source } = options;

  if (
    !validGitContext(context) ||
    !path.isAbsolute(options.destination) ||
    source.commit !== context.head
  )
    throw new Error('Fresh Git context and absolute private acquisition destination required');

  const inventory = source.inputs.map((input) => input.path);
  const identities = [...new Set([context.base, context.candidate, context.head])];
  const expression = new RegExp(`^[a-f0-9]{${context.head.length}}$`);
  if (identities.some((identity) => !expression.test(identity)))
    throw new Error('Git ancestry contains an invalid identity');
  const objects = new Set(
    options
      .read(['rev-list', '--objects', '--no-object-names', ...identities])
      .toString()
      .trim()
      .split('\n'),
  );
  for (const entry of context.index) objects.add(entry.object);
  if (objects.size === 0 || [...objects].some((identity) => !expression.test(identity)))
    throw new Error('Git object acquisition is empty or malformed');
  const identitiesList = `${[...objects].sort().join('\n')}\n`;
  // The pack carries objects to one consumer on this host and is then discarded. Searching for
  // new deltas and compressing hard would shrink a file nobody stores, at several seconds of
  // every run whose index changed; deltas the repository already holds are still reused.
  const pack = acquiredPack(options.packs, identitiesList, () =>
    options.read(
      ['pack-objects', '--stdout', '--window=0', '--compression=1'],
      Buffer.from(identitiesList),
    ),
  );
  if (pack.subarray(0, 4).toString() !== 'PACK') throw new Error('Git did not emit an object pack');
  const final = options.recapture();
  if (
    !validGitContext(final) ||
    final.digest !== context.digest ||
    options.read(['rev-parse', '--is-shallow-repository']).toString() !== 'false\n' ||
    manifestFromInventory(options.root, inventory, context.head).digest !== source.digest
  )
    throw new Error('Git or source changed during declared input acquisition');
  // Acquire the actual complete ancestry, including merge parents; never invent shallow boundaries.
  const evidence = {
    contextDigest: context.digest,
    packDigest: createHash('sha256').update(pack).digest('hex'),
    packBytes: pack.length,
    shallow: [],
  };
  mkdirSync(options.destination, { mode: 0o700 });
  const files: Readonly<Record<string, unknown>> = {
    'git-context.json': context,
    'git-objects.json': evidence,
    'source-manifest.json': source,
    'source-aliases.json': manifestFromInventory(
      options.root,
      context.index.filter((entry) => entry.mode === '120000').map((entry) => entry.path),
      context.head,
    ),
  };
  for (const [name, value] of Object.entries(files))
    writeFileSync(path.join(options.destination, name), JSON.stringify(value) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
  writeFileSync(path.join(options.destination, 'objects.pack'), pack, { flag: 'wx', mode: 0o600 });
  const snapshotContainer = path.join(options.destination, 'source-snapshot');
  const snapshot = materializeSnapshot(source, snapshotContainer);
  const payload = path.join(options.destination, 'payload');
  mkdirSync(payload);
  const inputs: Record<string, string> = {};
  const layout = sourceLayout(source);
  const originals = layout.files;
  const byLogical = new Map([...originals.values()].map((input) => [input.path, input]));
  try {
    // The captured modes remain authoritative; only this owned transport snapshot needs write access.
    for (const [directory, mode] of layout.directories)
      chmodSync(path.join(snapshot, directory), mode | 0o700);
    for (const input of originals.values()) {
      const member = 'payload/' + createHash('sha256').update(input.path).digest('hex');
      if (inputs[member] !== undefined) throw new Error('Captured logical source paths collide');
      renameSync(path.join(snapshot, input.path), path.join(options.destination, member));
      inputs[member] = input.path;
    }
    for (const [member, logical] of Object.entries(inputs)) {
      const input = byLogical.get(logical);
      const file = path.join(options.destination, member);
      if (
        input === undefined ||
        (statSync(file).mode & 0o777) !== input.mode ||
        createHash('sha256').update(readFileSync(file)).digest('hex') !== input.digest
      )
        throw new Error('Captured source payload differs from its original manifest');
    }
  } finally {
    rmSync(snapshotContainer, { recursive: true });
  }
  writeFileSync(
    path.join(options.destination, 'BUILD.bazel'),
    'load("@merkur//tools/bazel/verification:captured-source.bzl", "captured_source_payload", "captured_source_tree")\n' +
      'exports_files(["git-context.json", "git-objects.json", "source-manifest.json", "source-aliases.json", "objects.pack"])\n' +
      `INPUTS = ${JSON.stringify(inputs)}\n` +
      'captured_source_tree(name="source_tree", manifest="source-manifest.json", inputs=INPUTS, visibility=["//visibility:public"])\n' +
      'captured_source_payload(name="source_payload", inputs=INPUTS, visibility=["//visibility:public"])\n',
    { flag: 'wx', mode: 0o600 },
  );
  writeFileSync(path.join(options.destination, 'REPO.bazel'), '', { flag: 'wx', mode: 0o600 });
}
