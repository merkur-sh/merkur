import { createHash } from 'node:crypto';
import { type EngineArtifact, readEngineArtifact, targetArtifacts } from './artifacts';
import { type ConfiguredCoverage, configuredCoverageCatalog } from './configured-catalog';
import type { SourceInventory } from './engine-catalog';
import { readBuildEvents } from './events';

/** These configured producer targets expose typed owner descriptor output groups. */
export const CONFIGURED_POLICY_PRODUCERS = [
  '//tools/bazel/verification:operation_bindings',
  '//tools/bazel/verification:integration_operation_bindings',
  '//tools/bazel/verification:simulator_operation_bindings',
  '//tools/bazel/bun:operation_bindings',
  '//tools/bazel/rust:operation_catalog',
  '//tools/bazel/verification:bounded_proof_operation_bindings',
] as const;

export interface ConfiguredPolicyInputs extends ConfiguredCoverage {
  readonly artifacts: readonly {
    readonly label: string;
    readonly configuration: string;
    readonly artifact: EngineArtifact;
  }[];
  /** Binds registry semantics to the actual configured producer output bytes. */
  readonly inputDigest: string;
}

/** Read only complete, digest-bound engine outputs, retaining every owner blocker. */
export async function loadConfiguredPolicyInputs(options: {
  readonly root: string;
  readonly events: string;
  readonly exitCode: number | null;
  readonly inventory: SourceInventory;
}): Promise<ConfiguredPolicyInputs> {
  const report = readBuildEvents(
    options.events,
    CONFIGURED_POLICY_PRODUCERS.map((label) => ({ label, kind: 'build', fresh: false })),
  );
  if (
    options.exitCode !== 0 ||
    report.exitCode !== 0 ||
    report.buildToolVersion !== '9.2.0' ||
    !report.complete ||
    report.problems.length !== 0 ||
    report.checks.some((check) => check.status !== 'passed' || check.configuration === null)
  )
    throw new Error('Configured policy producers lack complete pinned-engine evidence');
  const descriptors: unknown[] = [];
  const artifacts: ConfiguredPolicyInputs['artifacts'][number][] = [];
  for (const label of CONFIGURED_POLICY_PRODUCERS) {
    const configuration = report.checks.find((check) => check.label === label)?.configuration;
    if (configuration === undefined || configuration === null)
      throw new Error('Configured policy producer has no unique configuration');
    const files = targetArtifacts(options.events, { label, configuration, group: 'descriptor' });
    const artifact = files[0];
    if (files.length !== 1 || artifact === undefined)
      throw new Error('Configured policy owner must expose exactly one descriptor File');
    descriptors.push(JSON.parse((await readEngineArtifact(options.root, artifact)).toString()));
    artifacts.push({ label, configuration, artifact });
  }
  const configured = configuredCoverageCatalog(options.inventory, descriptors);
  return {
    ...configured,
    artifacts,
    inputDigest: createHash('sha256')
      .update(JSON.stringify({ catalog: configured.digest, artifacts }))
      .digest('hex'),
  };
}
