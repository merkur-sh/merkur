import { lstatSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { type OwnedDirectory, openOwnedDirectory } from '../bun/owned-files';
import {
  type EngineArtifact,
  readEngineArtifact,
  verifyEngineArtifact,
} from '../verification/artifacts';
import type { PreparedCiArtifacts } from './ci-preparation';
import releaseContract from './release-contract.json';

export interface ReleaseArtifactSource {
  readonly invocation: string;
  readonly materializedRoot: string;
  /** Additional genuine engine outputs retained by the controller, including contracts and BEP. */
  readonly retainedFiles?: readonly EngineArtifact[];
}

export interface ReleaseStagingOptions {
  /** Already bound by bindControllerCiArtifacts, within the owning controller lifecycle. */
  readonly batches: readonly PreparedCiArtifacts[];
  readonly sources: readonly ReleaseArtifactSource[];
  /** Both roots must be fresh siblings under an existing engine-owned directory. */
  readonly releaseRoot: string;
  readonly evidenceRoot: string;
  /** Rechecks the same controller's current nonce admission, never a supplied boolean. */
  readonly assertCurrent: () => void;
}

const platforms: Readonly<Record<string, string>> = {
  'darwin-arm64': 'darwin-arm64',
  'darwin-x86_64': 'darwin-x64',
  'linux-arm64': 'linux-arm64',
  'linux-x86_64': 'linux-x64',
};

const specialProducers: Readonly<Record<string, string>> = {
  'NOTICES.txt': '//release:unsigned_complete',
  'deployment.tar.gz': '//tools/bazel/packaging:deployment_unsigned',
  'edge-image.tar.gz': '//tools/bazel/packaging:edge_image_unsigned',
  'stun-image.tar.gz': '//tools/bazel/packaging:stun_image_unsigned',
};

function portable(value: string): boolean {
  return (
    /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(value) &&
    value.split('/').every((part) => part !== '.' && part !== '..')
  );
}

function producer(name: string): string {
  return specialProducers[name] ?? `//tools/bazel/packaging:${name.replace(/\.tar\.gz$/, '')}`;
}

interface Copy {
  readonly root: string;
  readonly artifact: EngineArtifact;
  readonly destination: string;
  readonly shipping: boolean;
}

function inventory(
  batches: readonly PreparedCiArtifacts[],
  sources: readonly ReleaseArtifactSource[],
): Copy[] {
  const roots = new Map<string, ReleaseArtifactSource>();
  for (const source of sources) {
    if (
      !portable(source.invocation) ||
      source.invocation.includes('/') ||
      !path.isAbsolute(source.materializedRoot) ||
      roots.has(source.invocation)
    )
      throw new Error('Release staging requires unique captured invocation roots');
    roots.set(source.invocation, source);
  }
  const expected = new Map(releaseContract.artifacts.map((artifact) => [artifact.name, artifact]));
  const shipping = new Set<string>();
  const evidence = new Set<string>();
  const invocations = new Set<string>();
  const copies: Copy[] = [];
  for (const batch of batches) {
    const source = roots.get(batch.invocation);
    const platform = platforms[batch.platform];
    if (source === undefined || platform === undefined || invocations.has(batch.invocation))
      throw new Error('Release staging contains foreign or repeated platform invocation');
    invocations.add(batch.invocation);
    for (const output of batch.artifacts) {
      if (!portable(output.destination)) throw new Error('Unsafe bound release destination');
      const contract = expected.get(output.destination);
      if (contract !== undefined) {
        if (
          output.producer !== producer(contract.name) ||
          (contract.platform !== 'all' && contract.platform !== platform) ||
          shipping.has(contract.name) ||
          output.artifact.length === '0'
        )
          throw new Error(
            'Release shipping artifact has foreign producer, platform or duplicate name',
          );
        shipping.add(contract.name);
      }
      const destination =
        contract === undefined
          ? `${batch.invocation}/outputs/${output.destination}`
          : contract.name;
      if (contract === undefined && evidence.has(destination))
        throw new Error('Duplicate release evidence destination');
      evidence.add(destination);
      copies.push({
        root: source.materializedRoot,
        artifact: output.artifact,
        destination,
        shipping: contract !== undefined,
      });
    }
    for (const artifact of source.retainedFiles ?? []) {
      if (!portable(artifact.path)) throw new Error('Unsafe retained engine artifact path');
      const destination = `${batch.invocation}/engine/${artifact.path}`;
      if (evidence.has(destination)) throw new Error('Duplicate retained engine evidence');
      evidence.add(destination);
      copies.push({ root: source.materializedRoot, artifact, destination, shipping: false });
    }
  }
  if (invocations.size !== roots.size)
    throw new Error('Release staging roots contain an unbound invocation');
  const missing = [...expected.keys()].filter((name) => !shipping.has(name));
  if (missing.length !== 0)
    throw new Error(`Incomplete release producer inventory: ${missing.join(', ')}`);
  return copies;
}

/**
 * Copy authenticated ordinary outputs without admitting tests or authorizing signing.
 * The caller retains the existing creation journals through final controller validation,
 * removes their files on any later failure, and closes both capabilities in its finally block.
 */
export async function stageReleaseArtifacts(
  options: ReleaseStagingOptions,
): Promise<readonly [OwnedDirectory, OwnedDirectory]> {
  const assertCurrent = options.assertCurrent;
  assertCurrent();
  const copies = inventory(structuredClone(options.batches), structuredClone(options.sources));
  const releaseRoot = options.releaseRoot;
  const evidenceRoot = options.evidenceRoot;
  if (
    !path.isAbsolute(releaseRoot) ||
    !path.isAbsolute(evidenceRoot) ||
    path.dirname(releaseRoot) !== path.dirname(evidenceRoot) ||
    releaseRoot === evidenceRoot
  )
    throw new Error('Release and evidence roots must be distinct absolute siblings');
  const parent = realpathSync(path.dirname(releaseRoot));
  const release = path.join(parent, path.basename(releaseRoot));
  const evidence = path.join(parent, path.basename(evidenceRoot));
  const directories: OwnedDirectory[] = [];
  let transferred = false;
  try {
    mkdirSync(release);
    const releaseIdentity = lstatSync(release);
    const output = openOwnedDirectory(release);
    directories.push(output);
    mkdirSync(evidence);
    const evidenceIdentity = lstatSync(evidence);
    const retained = openOwnedDirectory(evidence);
    directories.push(retained);
    for (const copy of copies) {
      const bytes = await readEngineArtifact(copy.root, copy.artifact);
      assertCurrent();
      const target = copy.shipping ? output : retained;
      const executable = copy.shipping && /^verify-linux-/.test(copy.destination);
      target.write(copy.destination, bytes, executable ? 0o555 : 0o444);
    }
    for (const copy of copies) {
      await verifyEngineArtifact(copy.root, copy.artifact);
      (copy.shipping ? output : retained).verify(copy.destination);
    }
    const actual = readdirSync(release).sort();
    const expected = releaseContract.artifacts.map((artifact) => artifact.name).sort();
    if (actual.join('\0') !== expected.join('\0'))
      throw new Error('Release consumer directory differs from the exact shipping inventory');
    for (const [root, identity] of [
      [release, releaseIdentity],
      [evidence, evidenceIdentity],
    ] as const) {
      const current = lstatSync(root);
      if (!current.isDirectory() || current.ino !== identity.ino || current.dev !== identity.dev)
        throw new Error('Release staging root namespace changed');
    }
    assertCurrent();
    transferred = true;
    return Object.freeze([output, retained] as const);
  } catch (error) {
    const failures: unknown[] = [error];
    for (const directory of [...directories].reverse()) {
      try {
        directory.removeCreated();
      } catch (cleanup) {
        failures.push(cleanup);
      }
    }
    if (failures.length !== 1) throw new AggregateError(failures, 'Release staging failed cleanup');
    throw error;
  } finally {
    if (!transferred) for (const directory of directories) directory.close();
  }
}
