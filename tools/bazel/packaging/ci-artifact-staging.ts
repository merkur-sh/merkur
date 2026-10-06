import { lstatSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { type OwnedDirectory, openOwnedDirectory } from '../bun/owned-files';
import {
  type EngineArtifact,
  readEngineArtifact,
  verifyEngineArtifact,
} from '../verification/artifacts';
import type { PreparedCiArtifactInputs, PreparedCiArtifacts } from './ci-preparation';
import releaseContract from './release-contract.json';

export interface CiArtifactStagingOptions {
  /** Bound by bindControllerCiArtifacts in the same controller's publication lifecycle. */
  readonly batches: readonly PreparedCiArtifacts[];
  /** The owning engine's captured configured producer contracts. */
  readonly sources: readonly PreparedCiArtifactInputs[];
  /** A fresh absolute child of the caller's held output parent. */
  readonly outputRoot: string;
  readonly assertCurrent: () => void;
}

interface Copy {
  readonly root: string;
  readonly artifact: EngineArtifact;
  readonly destination: string;
}

const executables = new Set(
  releaseContract.artifacts
    .filter((artifact) => Object.hasOwn(artifact.inputs, 'verify'))
    .map((artifact) => artifact.name),
);

function copiesFor(
  batches: readonly PreparedCiArtifacts[],
  sources: readonly PreparedCiArtifactInputs[],
): Copy[] {
  if (batches.length === 0 || sources.length !== batches.length)
    throw new Error('CI staging requires complete bound invocation inventories');
  const roots = new Map<string, PreparedCiArtifactInputs>();
  for (const source of sources) {
    if (
      source.invocation === '' ||
      !path.isAbsolute(source.materializedRoot) ||
      roots.has(source.invocation)
    )
      throw new Error('CI staging requires unique captured invocation roots');
    roots.set(source.invocation, source);
  }
  const destinations = new Set<string>();
  const invocations = new Set<string>();
  const copies: Copy[] = [];
  const platform = batches[0]?.platform;
  for (const batch of batches) {
    const source = roots.get(batch.invocation);
    if (
      source === undefined ||
      invocations.has(batch.invocation) ||
      batch.platform === '' ||
      batch.platform !== platform
    )
      throw new Error('CI staging requires one platform and unique bound invocations');
    invocations.add(batch.invocation);
    const expected = new Map<string, { producer: string; configuration: string; group: string }>();
    for (const producer of source.producers) {
      if (producer.outputs.length === 0)
        throw new Error('CI staging captured an empty producer inventory');
      for (const output of producer.outputs) {
        // The configured descriptor specifies flat original basenames, including signing JSON.
        // It does not confer the complete four-platform shipping inventory.
        if (
          !/^[A-Za-z0-9_.-]+$/.test(output.destination) ||
          output.destination === '.' ||
          output.destination === '..' ||
          path.posix.basename(output.path) !== output.destination ||
          destinations.has(output.destination)
        )
          throw new Error('CI staging contains an unsafe or duplicate captured destination');
        const key = JSON.stringify([output.path, output.destination]);
        if (expected.has(key)) throw new Error('CI staging contains duplicate captured outputs');
        destinations.add(output.destination);
        expected.set(key, {
          producer: producer.label,
          configuration: producer.configuration,
          group: producer.group,
        });
      }
    }
    if (expected.size === 0 || batch.artifacts.length !== expected.size)
      throw new Error('CI staging bound outputs differ from the complete configured inventory');
    for (const output of batch.artifacts) {
      const key = JSON.stringify([output.artifact.path, output.destination]);
      const original = expected.get(key);
      if (
        original === undefined ||
        output.producer !== original.producer ||
        output.configuration !== original.configuration ||
        output.group !== original.group ||
        output.artifact.length === '0'
      )
        throw new Error('CI staging bound output differs from its captured producer contract');
      expected.delete(key);
      copies.push({
        root: source.materializedRoot,
        artifact: output.artifact,
        destination: output.destination,
      });
    }
    if (expected.size !== 0) throw new Error('CI staging omitted a captured output');
  }
  return copies;
}

/**
 * Materialize only this platform's already bound configured outputs. The caller retains
 * the returned creation journal through final controller validation, verifies its Files
 * and root namespace, removes its created Files on late failure, and finally closes it.
 * This byte consumer neither admits tests nor asserts complete release qualification.
 */
export async function stageCiArtifacts(options: CiArtifactStagingOptions): Promise<OwnedDirectory> {
  const assertCurrent = options.assertCurrent;
  assertCurrent();
  const copies = copiesFor(structuredClone(options.batches), structuredClone(options.sources));
  const outputRoot = options.outputRoot;
  if (!path.isAbsolute(outputRoot)) throw new Error('CI staging output root must be absolute');
  const parent = realpathSync(path.dirname(outputRoot));
  const root = path.join(parent, path.basename(outputRoot));
  for (const copy of copies) {
    const source = realpathSync(copy.root);
    if (root === source || root.startsWith(`${source}${path.sep}`))
      throw new Error('CI staging output must be outside materialized engine sources');
  }
  let directory: OwnedDirectory | undefined;
  let transferred = false;
  try {
    mkdirSync(root);
    const identity = lstatSync(root);
    directory = openOwnedDirectory(root);
    for (const copy of copies) {
      const bytes = await readEngineArtifact(copy.root, copy.artifact);
      assertCurrent();
      directory.write(copy.destination, bytes, executables.has(copy.destination) ? 0o555 : 0o444);
    }
    for (const copy of copies) {
      await verifyEngineArtifact(copy.root, copy.artifact);
      assertCurrent();
      directory.verify(copy.destination);
    }
    if (
      readdirSync(root).sort().join('\0') !==
      copies
        .map((copy) => copy.destination)
        .sort()
        .join('\0')
    )
      throw new Error('CI staging directory differs from the exact captured inventory');
    const current = lstatSync(root);
    if (!current.isDirectory() || current.ino !== identity.ino || current.dev !== identity.dev)
      throw new Error('CI staging root namespace changed');
    assertCurrent();
    transferred = true;
    return directory;
  } catch (error) {
    try {
      directory?.removeCreated();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'CI staging failed cleanup');
    }
    throw error;
  } finally {
    if (!transferred) directory?.close();
  }
}
