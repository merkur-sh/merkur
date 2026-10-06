import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { openOwnedDirectory } from '../bun/owned-files';
import {
  type EngineArtifact,
  readDeclaredInput,
  readEngineArtifact,
  targetArtifacts,
} from './artifacts';
import type { SourceManifest } from './snapshot';
import { withCapturedSourceContents } from './source-tree';

export interface StaticSource {
  readonly destination: string;
  readonly artifact: EngineArtifact;
  readonly bytes: Uint8Array;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function relative(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value !== '' &&
    !value.includes('\\') &&
    !value.includes('\0') &&
    value.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
  );
}

function matches(bytes: Uint8Array, artifact: EngineArtifact): boolean {
  return (
    String(bytes.length) === artifact.length &&
    createHash('sha256').update(bytes).digest('hex') === artifact.digest
  );
}

interface ProjectionMember {
  readonly artifact: string;
  readonly destination: string;
  readonly sha256: string;
  readonly size: number;
}

function projectionMembers(
  value: unknown,
  producer: string,
  projection: string,
  destinations: readonly string[],
): readonly ProjectionMember[] {
  if (
    !record(value) ||
    value.producer !== producer ||
    value.projection !== projection ||
    !Array.isArray(value.sources) ||
    Object.keys(value).sort().join(',') !== 'producer,projection,sources'
  )
    throw new Error('Static projection manifest does not identify the configured producers');
  const result: ProjectionMember[] = [];
  for (const source of value.sources) {
    if (
      !record(source) ||
      Object.keys(source).sort().join(',') !== 'artifact,destination,sha256,size' ||
      !relative(source.artifact) ||
      !relative(source.destination) ||
      typeof source.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(source.sha256) ||
      typeof source.size !== 'number' ||
      !Number.isSafeInteger(source.size) ||
      source.size < 0
    )
      throw new Error('Invalid static projection member');
    result.push({
      artifact: source.artifact,
      destination: source.destination,
      sha256: source.sha256,
      size: source.size,
    });
  }
  if (
    new Set(result.map((source) => source.artifact)).size !== result.length ||
    new Set(result.map((source) => source.destination)).size !== result.length ||
    JSON.stringify(result.map((source) => source.destination).sort()) !==
      JSON.stringify([...destinations].sort())
  )
    throw new Error('Static projection differs from the required complete logical inventory');
  return result;
}

/** Acquire the exact configured projection; neither a manifest nor a caller invents file identities. */
export async function loadStaticSources(options: {
  readonly events: string;
  readonly engineRoot: string;
  readonly label: string;
  readonly configuration: string;
  readonly producer: string;
  readonly destinations: readonly string[];
}): Promise<readonly StaticSource[]> {
  const target = { label: options.label, configuration: options.configuration };
  const manifests = targetArtifacts(options.events, { ...target, group: 'projection_manifest' });
  const artifacts = targetArtifacts(options.events, { ...target, group: 'static_sources' });
  const manifest = manifests[0];
  if (manifests.length !== 1 || manifest === undefined)
    throw new Error('A configured static projection must publish exactly one manifest');
  const manifestBytes = await readEngineArtifact(options.engineRoot, manifest);
  const value: unknown = JSON.parse(manifestBytes.toString('utf8'));
  const members = projectionMembers(
    value,
    options.producer,
    `@@${options.label}`,
    options.destinations,
  );
  if (members.length !== artifacts.length)
    throw new Error('Static projection member count differs from engine output evidence');
  const prefix = /^(bazel-out\/[^/]+\/bin\/)/.exec(manifest.path)?.[1];
  if (prefix === undefined) throw new Error('Static projection lacks a configured output prefix');
  const byPath = new Map(artifacts.map((artifact) => [artifact.path, artifact]));
  const result: StaticSource[] = [];
  for (const source of members) {
    const artifact = byPath.get(prefix + source.artifact);
    if (
      artifact === undefined ||
      artifact.digest !== source.sha256 ||
      artifact.length !== String(source.size)
    )
      throw new Error('Static projection member differs from engine output evidence');
    byPath.delete(artifact.path);
    const bytes = await readEngineArtifact(options.engineRoot, artifact);
    result.push({ destination: source.destination, artifact, bytes });
  }
  const destinations = result.map((source) => source.destination).sort();
  if (
    byPath.size !== 0 ||
    new Set(destinations).size !== destinations.length ||
    JSON.stringify(destinations) !== JSON.stringify([...options.destinations].sort())
  )
    throw new Error('Static projection differs from the required complete logical inventory');
  return result;
}

/** In a test action, the typed projection provider supplies every actual File dependency. */
export async function loadDeclaredStaticSources(options: {
  readonly root: string;
  readonly manifest: string;
  readonly producer: string;
  readonly projection: string;
  readonly files: readonly { readonly artifact: string; readonly destination: string }[];
}): Promise<readonly StaticSource[]> {
  const input = await readDeclaredInput(options.root, options.manifest);
  const members = projectionMembers(
    JSON.parse(input.bytes.toString('utf8')),
    options.producer,
    options.projection,
    options.files.map((file) => file.destination),
  );
  const files = new Map(options.files.map((file) => [file.artifact, file.destination]));
  if (files.size !== options.files.length || files.size !== members.length)
    throw new Error('Configured projection File dependencies are incomplete or duplicated');
  const result: StaticSource[] = [];
  for (const member of members) {
    if (files.get(member.artifact) !== member.destination)
      throw new Error('Projection member does not match its configured File dependency');
    files.delete(member.artifact);
    const artifact = {
      path: member.artifact,
      digest: member.sha256,
      length: String(member.size),
    };
    const bytes = await readEngineArtifact(options.root, artifact);
    result.push({ destination: member.destination, artifact, bytes });
  }
  if (files.size !== 0) throw new Error('Projection has unconsumed configured File dependencies');
  return result;
}

/** Ignored generated roles are temporary; captured originals require their reconstruction owner. */
export function withStaticSources(
  root: string,
  source: SourceManifest,
  sources: readonly StaticSource[],
  ignored: (relative: string) => boolean,
  run: () => void,
): void {
  const physical = realpathSync(root);
  const identity = lstatSync(physical);
  const owned = openOwnedDirectory(physical);
  const failures: unknown[] = [];
  const destinations = new Set<string>();
  const replacements: { path: string; bytes: Uint8Array }[] = [];
  const created = new Set<string>();
  function verify(): void {
    const current = lstatSync(physical);
    if (
      realpathSync(root) !== physical ||
      !current.isDirectory() ||
      current.dev !== identity.dev ||
      current.ino !== identity.ino ||
      current.mode !== identity.mode
    )
      throw new Error('Generated static root ownership changed during analysis');
    for (const destination of created) owned.verify(destination);
  }
  try {
    for (const item of sources) {
      const original = source.inputs.find((input) => input.path === item.destination);
      const conflicts = source.inputs.some(
        (input) =>
          input.path === item.destination ||
          input.path.startsWith(`${item.destination}/`) ||
          item.destination.startsWith(`${input.path}/`),
      );
      if (
        !relative(item.destination) ||
        destinations.has(item.destination) ||
        !matches(item.bytes, item.artifact) ||
        item.destination.split('/').includes('.gitignore') ||
        item.destination.split('/').includes('.git') ||
        (original === undefined && !ignored(item.destination)) ||
        (conflicts &&
          (original?.kind !== 'file' ||
            original.resolution.some(
              (fact) => fact.kind !== 'directory' || fact.path !== fact.resolvedPath,
            )))
      )
        throw new Error(
          'Generated static destination conflicts with captured source or ignore policy',
        );
      destinations.add(item.destination);
      if (original !== undefined) replacements.push({ path: item.destination, bytes: item.bytes });
      else {
        owned.write(item.destination, item.bytes, 0o600);
        created.add(item.destination);
      }
    }
    const analyze = () => {
      verify();
      run();
      verify();
    };
    if (replacements.length !== 0) withCapturedSourceContents(root, source, replacements, analyze);
    else analyze();
  } catch (error) {
    failures.push(error);
  }
  try {
    owned.removeCreated();
  } catch (error) {
    failures.push(error);
  }
  try {
    owned.close();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, 'Static analysis and projection cleanup failed');
}
