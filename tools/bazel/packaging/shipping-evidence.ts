import {
  type EngineArtifact,
  targetArtifacts,
  verifyEngineArtifact,
} from '../verification/artifacts';
import type { RequiredCheck } from '../verification/events';
import { validGitContext } from '../verification/git-context';
import {
  type VerificationEvidence,
  type VerificationReport,
  verificationReport,
} from '../verification/report';
import { validSourceManifest } from '../verification/snapshot';

export interface ProducerVerificationContext {
  readonly platform: string;
  readonly commit: string;
  readonly sourceDigest: string;
  /** Independent complete policy inventory, including the ordinary static checks. */
  readonly required: readonly RequiredCheck[];
  readonly invocation: string;
  readonly base: string;
  readonly candidate: string;
  readonly gitDigest: string;
  readonly configuredDigest: string;
  readonly admittedUntracked: readonly string[];
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function checks(value: unknown): RequiredCheck[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('Empty producer inventory');
  const result = value.map((check): RequiredCheck => {
    if (
      !record(check) ||
      Object.keys(check).sort().join(',') !== 'fresh,kind,label' ||
      typeof check.label !== 'string' ||
      !/^\/\/[^:\s]*:[^:\s]+$/.test(check.label) ||
      (check.kind !== 'test' && check.kind !== 'build') ||
      typeof check.fresh !== 'boolean'
    ) {
      throw new Error('Invalid independent producer check');
    }
    return { label: check.label, kind: check.kind, fresh: check.fresh };
  });
  if (new Set(result.map((check) => check.label)).size !== result.length) {
    throw new Error('Duplicate producer inventory');
  }
  return result.sort((left, right) =>
    left.label < right.label ? -1 : left.label > right.label ? 1 : 0,
  );
}

type ProducerEvidenceEnvelope = Omit<VerificationEvidence, 'context' | 'required'> & {
  readonly context: unknown;
  readonly required: unknown;
};

function validateEvidenceEnvelope(
  value: unknown,
  context: ProducerVerificationContext,
): asserts value is ProducerEvidenceEnvelope {
  if (
    !record(value) ||
    Object.keys(value).sort().join(',') !==
      'buildEvents,context,current,expectedBuildToolVersion,invocation,pendingLiveChecks,platform,processExitCode,required,snapshot' ||
    typeof value.invocation !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.invocation) ||
    value.expectedBuildToolVersion !== '9.2.0' ||
    typeof value.platform !== 'string' ||
    value.platform !== context.platform ||
    typeof value.buildEvents !== 'string' ||
    (value.processExitCode !== null &&
      (typeof value.processExitCode !== 'number' ||
        !Number.isSafeInteger(value.processExitCode))) ||
    !Array.isArray(value.pendingLiveChecks) ||
    !value.pendingLiveChecks.every((item) => typeof item === 'string') ||
    !validSourceManifest(value.snapshot) ||
    !validSourceManifest(value.current)
  ) {
    throw new Error('Malformed reconstructable producer evidence');
  }
}

function admittedName(name: unknown): boolean {
  return (
    typeof name === 'string' &&
    name !== '' &&
    !name.includes('\\') &&
    !name.includes('\0') &&
    !name.split('/').some((part) => part === '' || part === '.' || part === '..')
  );
}

function validateAdmissions(actual: unknown, expected: readonly string[]): void {
  if (
    !Array.isArray(actual) ||
    !Array.isArray(expected) ||
    !expected.every(admittedName) ||
    new Set(expected).size !== expected.length ||
    JSON.stringify([...actual].sort()) !== JSON.stringify([...expected].sort())
  )
    throw new Error('Producer evidence belongs to another independent Git or configured context');
}

function producerGitBinding(
  value: ProducerEvidenceEnvelope,
  context: ProducerVerificationContext,
): VerificationEvidence['context'] {
  const binding = value.context;
  if (
    !record(binding) ||
    Object.keys(binding).sort().join(',') !== 'admittedUntracked,configuredDigest,currentGit,git' ||
    !validGitContext(binding.git) ||
    !validGitContext(binding.currentGit) ||
    binding.git.base !== context.base ||
    binding.git.candidate !== context.candidate ||
    binding.git.head !== context.commit ||
    binding.git.digest !== context.gitDigest ||
    binding.configuredDigest !== context.configuredDigest ||
    value.invocation !== context.invocation ||
    typeof context.gitDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(context.gitDigest) ||
    typeof context.configuredDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(context.configuredDigest)
  ) {
    throw new Error('Producer evidence belongs to another independent Git or configured context');
  }
  validateAdmissions(binding.admittedUntracked, context.admittedUntracked);
  return {
    git: binding.git,
    currentGit: binding.currentGit,
    configuredDigest: context.configuredDigest,
    admittedUntracked: context.admittedUntracked,
  };
}

function validateProducerSource(
  value: ProducerEvidenceEnvelope,
  context: ProducerVerificationContext,
): void {
  if (
    typeof context.platform !== 'string' ||
    context.platform.length === 0 ||
    typeof context.commit !== 'string' ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(context.commit) ||
    typeof context.sourceDigest !== 'string' ||
    !/^[0-9a-f]{64}$/.test(context.sourceDigest) ||
    value.snapshot.commit !== context.commit ||
    value.snapshot.digest !== context.sourceDigest
  ) {
    throw new Error('Producer evidence belongs to another release context');
  }
}

/** Reconstruct verification from raw evidence. This does not bind shipping artifact bytes. */
export function reconstructProducerVerification(
  value: unknown,
  context: ProducerVerificationContext,
): VerificationReport {
  validateEvidenceEnvelope(value, context);
  const binding = producerGitBinding(value, context);
  validateProducerSource(value, context);
  const required = checks(value.required);
  if (JSON.stringify(required) !== JSON.stringify(checks(context.required))) {
    throw new Error('Producer evidence omits or changes independent required checks');
  }
  const evidence: VerificationEvidence = {
    invocation: value.invocation,
    expectedBuildToolVersion: value.expectedBuildToolVersion,
    platform: value.platform,
    snapshot: value.snapshot,
    current: value.current,
    buildEvents: value.buildEvents,
    required,
    processExitCode: value.processExitCode,
    pendingLiveChecks: value.pendingLiveChecks,
    context: binding,
  };
  const report = verificationReport(evidence);
  if (!report.currentAccepted) {
    throw new Error('Producer verification is failed, incomplete, stale or pending');
  }
  return report;
}

export interface ProducerOutputs {
  readonly label: string;
  readonly configuration: string;
  readonly group: string;
  /** Independent complete output-group inventory from the configured packaging contract. */
  readonly outputs: readonly { readonly path: string; readonly destination: string }[];
}

export interface BoundProducerArtifact {
  readonly producer: string;
  readonly configuration: string;
  readonly group: string;
  readonly destination: string;
  readonly artifact: EngineArtifact;
}

function portable(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(value) &&
    !value.split('/').some((part) => part === '.' || part === '..')
  );
}

/** Bind complete configured producer groups to materialized engine bytes, after verification. */
export async function bindProducerArtifacts(
  value: unknown,
  context: ProducerVerificationContext,
  materializedRoot: string,
  producers: readonly ProducerOutputs[],
): Promise<readonly BoundProducerArtifact[]> {
  reconstructProducerVerification(value, context);
  if (!record(value) || typeof value.buildEvents !== 'string') {
    throw new Error('Producer evidence has no reconstructable engine events');
  }
  if (!Array.isArray(producers) || producers.length === 0) {
    throw new Error('Independent artifact producer inventory is empty');
  }
  const labels = new Set<string>();
  const destinations = new Set<string>();
  const paths = new Set<string>();
  const bound: BoundProducerArtifact[] = [];
  for (const producer of producers) {
    if (
      !record(producer) ||
      Object.keys(producer).sort().join(',') !== 'configuration,group,label,outputs' ||
      typeof producer.label !== 'string' ||
      !context.required.some((check) => check.label === producer.label && check.kind === 'build') ||
      labels.has(producer.label) ||
      typeof producer.configuration !== 'string' ||
      producer.configuration.length === 0 ||
      typeof producer.group !== 'string' ||
      producer.group.length === 0 ||
      !Array.isArray(producer.outputs) ||
      producer.outputs.length === 0
    ) {
      throw new Error('Invalid independent configured artifact producer');
    }
    labels.add(producer.label);
    const expected = new Map<string, string>();
    for (const output of producer.outputs) {
      if (
        !record(output) ||
        Object.keys(output).sort().join(',') !== 'destination,path' ||
        !portable(output.path) ||
        !portable(output.destination) ||
        paths.has(output.path) ||
        destinations.has(output.destination)
      ) {
        throw new Error('Invalid or duplicate independent artifact destination');
      }
      expected.set(output.path, output.destination);
      paths.add(output.path);
      destinations.add(output.destination);
    }
    const artifacts = targetArtifacts(value.buildEvents, {
      label: producer.label,
      configuration: producer.configuration,
      group: producer.group,
    });
    if (
      artifacts.length !== expected.size ||
      artifacts.some((artifact) => !expected.has(artifact.path))
    ) {
      throw new Error('Producer output group differs from its complete packaging inventory');
    }
    for (const artifact of artifacts) {
      const destination = expected.get(artifact.path);
      if (destination === undefined) throw new Error('Uninventoried producer artifact');
      await verifyEngineArtifact(materializedRoot, artifact);
      bound.push({
        producer: producer.label,
        configuration: producer.configuration,
        group: producer.group,
        destination,
        artifact,
      });
    }
  }
  return bound.sort((left, right) =>
    left.destination < right.destination ? -1 : left.destination > right.destination ? 1 : 0,
  );
}
