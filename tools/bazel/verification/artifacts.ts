import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import path from 'node:path';

export interface EngineArtifact {
  readonly path: string;
  readonly digest: string;
  readonly length: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function identifier(value: unknown): string {
  if (!record(value) || typeof value.id !== 'string' || value.id === '')
    throw new Error('Invalid engine output-set identity');
  return value.id;
}

function relative(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value === '' ||
    value.includes('\\') ||
    value.includes('\0') ||
    value.split('/').some((part) => part === '' || part === '.' || part === '..')
  )
    throw new Error('Unsafe engine artifact path');
  return value;
}

/** Decode one actual configured producer's output DAG; the engine materializes the files. */
export function targetArtifacts(
  events: string,
  producer: { readonly label: string; readonly configuration: string; readonly group: string },
): readonly EngineArtifact[] {
  const sets = new Map<string, Record<string, unknown>>();
  let completed: Record<string, unknown> | undefined;
  for (const line of events.split('\n').filter((line) => line.trim() !== '')) {
    const event: unknown = JSON.parse(line);
    if (!record(event) || !record(event.id)) throw new Error('Invalid artifact build event');
    if (event.id.namedSet !== undefined) {
      const id = identifier(event.id.namedSet);
      if (!record(event.namedSetOfFiles) || sets.has(id))
        throw new Error('Invalid or duplicate engine output set');
      sets.set(id, event.namedSetOfFiles);
    }
    const target = event.id.targetCompleted;
    if (
      record(target) &&
      target.label === producer.label &&
      record(target.configuration) &&
      target.configuration.id === producer.configuration &&
      (target.aspect === undefined || target.aspect === '')
    ) {
      if (completed !== undefined || !record(event.completed))
        throw new Error('Duplicate or invalid configured producer completion');
      completed = event.completed;
    }
  }
  if (completed?.success !== true || !Array.isArray(completed.outputGroup))
    throw new Error('The configured artifact producer did not complete successfully');
  const groups = new Map<string, Record<string, unknown>>();
  for (const group of completed.outputGroup) {
    if (!record(group) || typeof group.name !== 'string' || groups.has(group.name))
      throw new Error('Invalid or duplicate producer output group');
    groups.set(group.name, group);
  }
  const group = groups.get(producer.group);
  if (
    group === undefined ||
    (group.incomplete !== undefined && group.incomplete !== false) ||
    !Array.isArray(group.fileSets)
  )
    throw new Error('Producer output group is absent or incomplete');
  const artifacts = new Map<string, EngineArtifact>();
  const visited = new Set<string>();
  const active = new Set<string>();
  function visit(id: string): void {
    if (active.has(id)) throw new Error('Cyclic engine output sets');
    if (visited.has(id)) return;
    const set = sets.get(id);
    if (set === undefined) throw new Error('Missing referenced engine output set');
    active.add(id);
    if (set.files !== undefined) {
      if (!Array.isArray(set.files)) throw new Error('Invalid engine output-file inventory');
      for (const file of set.files) {
        if (
          !record(file) ||
          (file.symlink !== undefined && file.symlink !== false) ||
          file.symlinkTargetPath !== undefined ||
          typeof file.digest !== 'string' ||
          !/^[a-f0-9]{64}$/.test(file.digest) ||
          typeof file.length !== 'string' ||
          !/^(0|[1-9][0-9]*)$/.test(file.length)
        )
          throw new Error('Engine artifact lacks regular-file digest and size evidence');
        const prefix = file.pathPrefix ?? [];
        if (
          !Array.isArray(prefix) ||
          prefix.some((part) => typeof part !== 'string' || part.includes('/'))
        )
          throw new Error('Invalid engine output path prefix');
        const output = relative([...prefix, relative(file.name)].join('/'));
        const artifact = { path: output, digest: file.digest, length: file.length };
        const previous = artifacts.get(output);
        if (
          previous !== undefined &&
          (previous.digest !== artifact.digest || previous.length !== artifact.length)
        )
          throw new Error('Conflicting engine artifact identities');
        artifacts.set(output, artifact);
      }
    }
    if (set.fileSets !== undefined) {
      if (!Array.isArray(set.fileSets))
        throw new Error('Invalid nested engine output-set inventory');
      for (const nested of set.fileSets) visit(identifier(nested));
    }
    active.delete(id);
    visited.add(id);
  }
  for (const set of group.fileSets) visit(identifier(set));
  if (artifacts.size === 0) throw new Error('Producer output inventory is empty');
  return [...artifacts.values()].sort((a, b) => a.path.localeCompare(b.path));
}

const READ_BYTES = 1 << 20;

/** Verify bytes already materialized by Bazel, without downloading or assembling artifacts. */
async function consumeEngineArtifact(
  root: string,
  artifact: { readonly path: string; readonly digest?: string; readonly length?: string },
  collect: boolean,
): Promise<{ readonly bytes?: Buffer; readonly artifact: EngineArtifact }> {
  const physicalRoot = realpathSync(root);
  const file = path.join(physicalRoot, relative(artifact.path));
  const resolved = realpathSync(file);
  const confined = path.relative(physicalRoot, resolved);
  if (confined === '..' || confined.startsWith(`..${path.sep}`) || path.isAbsolute(confined))
    throw new Error('Engine artifact escapes its materialized output root');
  const before = lstatSync(file, { bigint: true });
  if (
    !before.isFile() ||
    (artifact.length !== undefined && before.size !== BigInt(artifact.length))
  )
    throw new Error('Materialized engine artifact has the wrong type or size');
  const fd = openSync(resolved, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev)
      throw new Error('Materialized engine artifact changed before reading');
    const hash = createHash('sha256');
    const chunks: Buffer[] = [];
    // Read to the end of the held descriptor, one byte past its size: growth is refused below.
    for (let position = 0; ; ) {
      const rest = Number(opened.size) - position + 1;
      const chunk = Buffer.allocUnsafe(Math.max(1, Math.min(rest, READ_BYTES)));
      const count = readSync(fd, chunk, 0, chunk.byteLength, position);
      if (count === 0) break;
      position += count;
      const bytes = chunk.subarray(0, count);
      hash.update(bytes);
      if (collect) chunks.push(bytes);
    }
    const after = fstatSync(fd, { bigint: true });
    const current = lstatSync(file, { bigint: true });
    const digest = hash.digest('hex');
    if (
      (artifact.digest !== undefined && digest !== artifact.digest) ||
      realpathSync(file) !== resolved ||
      !current.isFile() ||
      before.ino !== current.ino ||
      before.dev !== current.dev ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      current.ctimeNs !== after.ctimeNs
    )
      throw new Error('Materialized engine artifact differs from its producing event');
    return {
      ...(collect ? { bytes: Buffer.concat(chunks) } : {}),
      artifact: { path: artifact.path, digest, length: String(before.size) },
    };
  } finally {
    closeSync(fd);
  }
}

export async function verifyEngineArtifact(root: string, artifact: EngineArtifact): Promise<void> {
  requireExpectedArtifact(artifact);
  await consumeEngineArtifact(root, artifact, false);
}

/** Return only bytes read through the same authenticated descriptor used by verification. */
export async function readEngineArtifact(root: string, artifact: EngineArtifact): Promise<Buffer> {
  requireExpectedArtifact(artifact);
  const { bytes } = await consumeEngineArtifact(root, artifact, true);
  if (bytes === undefined) throw new Error('Engine artifact acquisition did not return bytes');
  return bytes;
}

function requireExpectedArtifact(artifact: EngineArtifact): void {
  if (
    !record(artifact) ||
    typeof artifact.digest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(artifact.digest) ||
    typeof artifact.length !== 'string' ||
    !/^(0|[1-9][0-9]*)$/.test(artifact.length)
  )
    throw new Error('External engine artifact requires its expected digest and length');
}

/** Inside an engine action, typed configured File dependencies supply input authority. */
export async function readDeclaredInput(
  root: string,
  file: string,
): Promise<{ readonly bytes: Buffer; readonly artifact: EngineArtifact }> {
  const result = await consumeEngineArtifact(root, { path: file }, true);
  if (result.bytes === undefined)
    throw new Error('Declared input acquisition did not return bytes');
  return { bytes: result.bytes, artifact: result.artifact };
}
