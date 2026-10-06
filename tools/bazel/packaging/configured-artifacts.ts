import path from 'node:path';
import {
  type EngineArtifact,
  readEngineArtifact,
  targetArtifacts,
  verifyEngineArtifact,
} from '../verification/artifacts';
import { readBuildEvents } from '../verification/events';
import type { PreparedCiArtifactInputs } from './ci-preparation';
import releaseContract from './release-contract.json';
import type { ProducerOutputs } from './shipping-evidence';

export const UNSIGNED_CONTRACT_OUTPUT_GROUP = 'unsigned_contract';
const platforms: Readonly<Record<string, string>> = {
  'darwin-arm64': 'darwin-arm64',
  'darwin-x86_64': 'darwin-x64',
  'linux-arm64': 'linux-arm64',
  'linux-x86_64': 'linux-x64',
};

function releaseProducer(name: string): string {
  if (name === 'NOTICES.txt') return '//release:unsigned_complete';
  const special: Readonly<Record<string, string>> = {
    'deployment.tar.gz': 'deployment_unsigned',
    'edge-image.tar.gz': 'edge_image_unsigned',
    'stun-image.tar.gz': 'stun_image_unsigned',
  };
  return `//tools/bazel/packaging:${special[name] ?? name.replace(/\.tar\.gz$/, '')}`;
}

/** Supported original contract roles; actual configured BEP completion is still mandatory. */
export const CONFIGURED_UNSIGNED_PRODUCERS: readonly string[] = Object.freeze(
  releaseContract.artifacts.map((artifact) => releaseProducer(artifact.name)),
);

/** Keep the four native invocation owners; global shipping outputs belong only to Linux x64. */
export function configuredUnsignedSelection(
  platform: string,
  complete: boolean,
): readonly string[] {
  const native = platforms[platform];
  if (typeof native !== 'string')
    throw new Error('Unsigned selection requires a supported native platform');
  if (!complete) {
    if (platform !== 'linux-x86_64')
      throw new Error(
        'One-platform unsigned selection has a configured producer only on Linux x64',
      );
    return Object.freeze(['//tools/bazel/packaging:deployment_unsigned']);
  }
  return Object.freeze(
    releaseContract.artifacts
      .filter(
        (artifact) =>
          artifact.platform === native || (artifact.platform === 'all' && native === 'linux-x64'),
      )
      .map((artifact) => releaseProducer(artifact.name)),
  );
}

/** Captured engine metadata; only the engine's owned prepared state supplies it. */
export interface ConfiguredArtifactProducers {
  readonly invocation: string;
  readonly materializedRoot: string;
  readonly producers: readonly ProducerOutputs[];
  readonly retainedFiles: readonly {
    readonly label: string;
    readonly configuration: string;
    readonly artifact: EngineArtifact;
  }[];
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function portable(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(value) &&
    !value.split('/').some((part) => part === '.' || part === '..')
  );
}

function descriptor(value: unknown, label: string, configuration: string): ProducerOutputs {
  if (
    !record(value) ||
    Object.keys(value).sort().join(',') !== 'group,label,outputs' ||
    value.label !== label ||
    value.group !== 'default' ||
    !Array.isArray(value.outputs) ||
    value.outputs.length === 0
  )
    throw new Error('Configured unsigned producer contract has a foreign identity or schema');
  const outputs: ProducerOutputs['outputs'][number][] = [];
  const paths = new Set<string>();
  const destinations = new Set<string>();
  for (const output of value.outputs) {
    if (
      !record(output) ||
      Object.keys(output).sort().join(',') !== 'destination,path' ||
      !portable(output.path) ||
      !portable(output.destination) ||
      output.destination !== path.posix.basename(output.path) ||
      paths.has(output.path) ||
      destinations.has(output.destination)
    )
      throw new Error('Configured unsigned producer contract has invalid ordinary outputs');
    paths.add(output.path);
    destinations.add(output.destination);
    outputs.push({ path: output.path, destination: output.destination });
  }
  const shipping = releaseContract.artifacts.find(
    (artifact) => releaseProducer(artifact.name) === label,
  );
  if (shipping !== undefined && label !== '//tools/bazel/packaging:deployment_unsigned') {
    const signing =
      label === '//release:unsigned_complete'
        ? []
        : [`${shipping.name.replace(/\.tar\.gz$/, '')}.signing-inputs.json`];
    const expected = [shipping.name, ...signing].sort();
    if (JSON.stringify([...destinations].sort()) !== JSON.stringify(expected))
      throw new Error(
        'Unsigned producer omitted or replaced its original shipping and signing inventory',
      );
  }
  outputs.sort((left, right) => left.path.localeCompare(right.path));
  return Object.freeze({
    label,
    configuration,
    group: value.group,
    outputs: Object.freeze(outputs),
  });
}

function completed(options: {
  readonly invocation: string;
  readonly events: string;
  readonly exitCode: number | null;
  readonly labels: readonly string[];
}): ReadonlyMap<string, string> {
  if (
    options.labels.length === 0 ||
    new Set(options.labels).size !== options.labels.length ||
    options.labels.some((label) => !CONFIGURED_UNSIGNED_PRODUCERS.some((known) => known === label))
  )
    throw new Error('Unsigned selection lacks an implemented configured producer');
  const report = readBuildEvents(
    options.events,
    options.labels.map((label) => ({ label, kind: 'build', fresh: false })),
  );
  if (
    options.exitCode !== 0 ||
    report.invocation !== options.invocation ||
    report.buildToolVersion !== '9.2.0' ||
    report.exitCode !== 0 ||
    !report.complete ||
    report.problems.length !== 0 ||
    report.checks.some((check) => check.status !== 'passed' || check.configuration === null)
  )
    throw new Error('Unsigned producers lack complete matching pinned-engine evidence');
  return new Map(
    report.checks.map((check) => {
      if (check.configuration === null)
        throw new Error('Unsigned producer configuration is missing');
      return [check.label, check.configuration];
    }),
  );
}

/** Load ordinary descriptor Files from the actual configured producer BEP. */
export async function captureConfiguredArtifactProducers(options: {
  readonly invocation: string;
  readonly root: string;
  readonly events: string;
  readonly exitCode: number | null;
  readonly labels: readonly string[];
}): Promise<ConfiguredArtifactProducers> {
  if (!path.isAbsolute(options.root))
    throw new Error('Absolute engine materialization root required');
  const configurations = completed(options);
  const producers: ProducerOutputs[] = [];
  const retainedFiles: ConfiguredArtifactProducers['retainedFiles'][number][] = [];
  for (const [label, configuration] of configurations) {
    const files = targetArtifacts(options.events, {
      label,
      configuration,
      group: UNSIGNED_CONTRACT_OUTPUT_GROUP,
    });
    const artifact = files[0];
    if (files.length !== 1 || artifact === undefined)
      throw new Error('Unsigned producer must retain exactly one ordinary contract File');
    producers.push(
      descriptor(
        JSON.parse((await readEngineArtifact(options.root, artifact)).toString()),
        label,
        configuration,
      ),
    );
    retainedFiles.push(
      Object.freeze({ label, configuration, artifact: Object.freeze({ ...artifact }) }),
    );
  }
  return Object.freeze({
    invocation: options.invocation,
    materializedRoot: options.root,
    producers: Object.freeze(producers),
    retainedFiles: Object.freeze(retainedFiles),
  });
}

/** Recheck retained contracts and bind execution outputs; this never admits a release. */
export async function loadConfiguredCiArtifactInputs(options: {
  readonly invocation: string;
  readonly executionRoot: string;
  readonly events: string;
  readonly exitCode: number | null;
  readonly configured: ConfiguredArtifactProducers;
}): Promise<PreparedCiArtifactInputs> {
  const configured = structuredClone(options.configured);
  if (!path.isAbsolute(options.executionRoot) || !path.isAbsolute(configured.materializedRoot))
    throw new Error('Absolute engine materialization roots required');
  const configurations = completed({
    ...options,
    labels: configured.producers.map((item) => item.label),
  });
  if (configured.retainedFiles.length !== configured.producers.length)
    throw new Error('Unsigned retained contract inventory is incomplete');
  const seen = new Set<string>();
  for (const producer of configured.producers) {
    const retained = configured.retainedFiles.find((item) => item.label === producer.label);
    if (
      retained === undefined ||
      seen.has(retained.label) ||
      retained.configuration !== producer.configuration ||
      configurations.get(producer.label) !== producer.configuration
    )
      throw new Error('Unsigned retained File or execution producer identity differs');
    seen.add(retained.label);
    const original = descriptor(
      JSON.parse(
        (await readEngineArtifact(configured.materializedRoot, retained.artifact)).toString(),
      ),
      retained.label,
      retained.configuration,
    );
    if (JSON.stringify(original) !== JSON.stringify(producer))
      throw new Error('Unsigned producer differs from its original retained contract');
    const executedContracts = targetArtifacts(options.events, {
      label: producer.label,
      configuration: producer.configuration,
      group: UNSIGNED_CONTRACT_OUTPUT_GROUP,
    });
    if (
      executedContracts.length !== 1 ||
      JSON.stringify(executedContracts[0]) !== JSON.stringify(retained.artifact)
    )
      throw new Error('Executed unsigned descriptor differs from the original retained File');
    await verifyEngineArtifact(options.executionRoot, retained.artifact);
    const artifacts = targetArtifacts(options.events, producer);
    if (
      artifacts.length !== producer.outputs.length ||
      artifacts.some(
        (artifact) => !producer.outputs.some((output) => output.path === artifact.path),
      )
    )
      throw new Error(
        'Unsigned execution output group differs from the configured complete inventory',
      );
    for (const artifact of artifacts) await verifyEngineArtifact(options.executionRoot, artifact);
  }
  for (const retained of configured.retainedFiles)
    await verifyEngineArtifact(configured.materializedRoot, retained.artifact);
  return Object.freeze({
    invocation: options.invocation,
    materializedRoot: options.executionRoot,
    producers: Object.freeze(configured.producers),
  });
}
