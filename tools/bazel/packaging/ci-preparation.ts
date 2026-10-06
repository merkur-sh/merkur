import path from 'node:path';
import { type ControllerResult, controllerExpectations } from '../verification/controller';
import {
  type PreparedVerification,
  type PublishedVerificationExpectations,
  publishVerificationExpectations,
  type VerificationExpectation,
} from '../verification/front-end';
import type { VerificationReport } from '../verification/report';
import { reconstructCiVerification } from './ci-evidence';
import {
  type BoundProducerArtifact,
  bindProducerArtifacts,
  type ProducerOutputs,
} from './shipping-evidence';

/** A controller-owned publication capability, never an uploaded expected-context document. */
export interface ConfirmedCiExpectations {
  readonly expectations: readonly VerificationExpectation[];
}

const confirmations = new WeakMap<
  ConfirmedCiExpectations,
  {
    readonly expectations: readonly VerificationExpectation[];
    readonly controller?: ControllerResult;
  }
>();

function confirmedExpectations(
  confirmed: ConfirmedCiExpectations,
): readonly VerificationExpectation[] {
  const captured = confirmations.get(confirmed);
  if (captured === undefined) throw new Error('CI reconstruction requires an owned confirmation');
  // A saved confirmation cannot outlive the admission of its original controller result.
  if (captured.controller !== undefined) controllerExpectations(captured.controller);
  return captured.expectations;
}

/**
 * Confirm owned preparations without dispatching, promoting nonces or qualifying pools.
 * The publisher must return the root writer's owned durable publication receipt.
 * The frontend checks its exact ordered batch and retained output before confirming.
 */
export async function confirmCiExpectations(
  prepared: readonly PreparedVerification[],
  publish: (
    expectations: readonly VerificationExpectation[],
  ) => PublishedVerificationExpectations | Promise<PublishedVerificationExpectations>,
): Promise<ConfirmedCiExpectations> {
  let captured: readonly VerificationExpectation[] | undefined;
  await publishVerificationExpectations(prepared, async (expectations) => {
    if (
      new Set(expectations.map((context) => context.invocation)).size !== expectations.length ||
      new Set(expectations.map((context) => context.platform)).size !== expectations.length
    )
      throw new Error('CI preparation requires distinct invocation and platform identities');
    captured = expectations;
    return await publish(expectations);
  });
  if (captured === undefined) throw new Error('CI expectation publication did not complete');
  const confirmed = Object.freeze({ expectations: captured });
  confirmations.set(confirmed, { expectations: captured });
  return confirmed;
}

/** Reuse the one controller's actual publication; this does not publish or admit again. */
export function captureControllerCiExpectations(result: ControllerResult): ConfirmedCiExpectations {
  const expectations = controllerExpectations(result);
  const confirmed = Object.freeze({ expectations });
  confirmations.set(confirmed, { expectations, controller: result });
  // Do not expose a usable CI handle for incomplete, failed or mismatched worker reports.
  reconstructPreparedCiBatch(confirmed, result.results);
  return confirmed;
}

/** Reconstruct one report against its captured authority; this does not admit the batch. */
export function reconstructPreparedCiEvidence(
  confirmed: ConfirmedCiExpectations,
  result: unknown,
): VerificationReport {
  const report = reconstructEvidence(confirmedExpectations(confirmed), result);
  confirmedExpectations(confirmed);
  return report;
}

function reconstructEvidence(
  expected: readonly VerificationExpectation[],
  result: unknown,
): VerificationReport {
  if (
    result === null ||
    typeof result !== 'object' ||
    !Object.hasOwn(result, 'evidence') ||
    !('evidence' in result) ||
    result.evidence === null ||
    typeof result.evidence !== 'object' ||
    !Object.hasOwn(result.evidence, 'invocation') ||
    !('invocation' in result.evidence)
  )
    throw new Error('CI reconstruction requires a complete raw execution report');
  const invocation = result.evidence.invocation;
  const context = expected.find((item) => item.invocation === invocation);
  if (context === undefined) throw new Error('Report invocation is absent from the owned batch');
  return reconstructCiVerification(result, context);
}

function frozen<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}

/** Reconstruct the exact confirmed report batch; final nonce/pool admission remains separate. */
export function reconstructPreparedCiBatch(
  confirmed: ConfirmedCiExpectations,
  submitted: readonly unknown[],
): readonly VerificationReport[] {
  const expected = confirmedExpectations(confirmed);
  if (!Array.isArray(submitted) || submitted.length !== expected.length)
    throw new Error('CI reports must cover the complete confirmed platform batch');
  const byInvocation = new Map<string, VerificationReport>();
  for (const result of submitted) {
    const report = reconstructEvidence(expected, result);
    if (byInvocation.has(report.invocation))
      throw new Error('CI report batch repeats a captured invocation');
    byInvocation.set(report.invocation, frozen(structuredClone(report)));
  }
  const reports = expected.map((context) => {
    const report = byInvocation.get(context.invocation);
    if (report === undefined) throw new Error('CI report batch omits a captured invocation');
    return report;
  });
  confirmedExpectations(confirmed);
  return Object.freeze(reports);
}

/** Configured producer contracts and materialized namespaces come from the trusted controller. */
export interface PreparedCiArtifactInputs {
  readonly invocation: string;
  readonly materializedRoot: string;
  readonly producers: readonly ProducerOutputs[];
}

export interface PreparedCiArtifacts {
  readonly invocation: string;
  readonly platform: string;
  readonly artifacts: readonly BoundProducerArtifact[];
}

function artifactInventories(
  expected: readonly VerificationExpectation[],
  supplied: readonly PreparedCiArtifactInputs[],
): ReadonlyMap<string, PreparedCiArtifactInputs> {
  if (!Array.isArray(supplied) || supplied.length !== expected.length)
    throw new Error('Artifact inventories must cover the complete confirmed platform batch');
  const inventories = new Map<string, PreparedCiArtifactInputs>();
  for (const input of supplied) {
    if (
      input === null ||
      typeof input !== 'object' ||
      Object.keys(input).sort().join(',') !== 'invocation,materializedRoot,producers' ||
      !expected.some((context) => context.invocation === input.invocation) ||
      inventories.has(input.invocation) ||
      typeof input.materializedRoot !== 'string' ||
      !path.isAbsolute(input.materializedRoot) ||
      !Array.isArray(input.producers) ||
      input.producers.length === 0
    )
      throw new Error('Invalid or repeated captured artifact inventory');
    inventories.set(input.invocation, frozen(structuredClone(input)));
  }
  return inventories;
}

function submittedEvidence(results: readonly unknown[], invocation: string): unknown {
  for (const result of results) {
    if (result === null || typeof result !== 'object' || !('evidence' in result)) continue;
    const evidence = result.evidence;
    if (
      evidence !== null &&
      typeof evidence === 'object' &&
      'invocation' in evidence &&
      evidence.invocation === invocation
    )
      return evidence;
  }
  throw new Error('Captured artifact invocation is absent');
}

/**
 * Bind unsigned artifacts using the same owned expectations as the complete CI report batch.
 * This verifies selected output bytes; it neither promotes test nonces nor authorizes signing.
 */
export async function bindPreparedCiArtifacts(
  confirmed: ConfirmedCiExpectations,
  submitted: readonly unknown[],
  supplied: readonly PreparedCiArtifactInputs[],
): Promise<readonly PreparedCiArtifacts[]> {
  const expected = confirmedExpectations(confirmed);
  // Detach every input before asynchronous File verification can yield to its caller.
  const results: readonly unknown[] = structuredClone(submitted);
  reconstructPreparedCiBatch(confirmed, results);
  const inventories = artifactInventories(expected, supplied);
  const bound: PreparedCiArtifacts[] = [];
  for (const context of expected) {
    const inventory = inventories.get(context.invocation);
    if (inventory === undefined) throw new Error('Captured artifact inventory is absent');
    const artifacts = await bindProducerArtifacts(
      submittedEvidence(results, context.invocation),
      {
        platform: context.platform,
        commit: context.head,
        sourceDigest: context.sourceDigest,
        required: context.required,
        invocation: context.invocation,
        base: context.base,
        candidate: context.candidate,
        gitDigest: context.gitDigest,
        configuredDigest: context.configuredDigest,
        admittedUntracked: context.admittedUntracked,
      },
      inventory.materializedRoot,
      inventory.producers,
    );
    bound.push(frozen({ invocation: context.invocation, platform: context.platform, artifacts }));
  }
  // File reads yield: force revocation during binding must invalidate this same handle.
  confirmedExpectations(confirmed);
  return Object.freeze(bound);
}

/** Consume unsigned producer bytes inside the same admitted controller lifecycle. */
export async function bindControllerCiArtifacts(
  result: ControllerResult,
  supplied: readonly PreparedCiArtifactInputs[],
): Promise<readonly PreparedCiArtifacts[]> {
  const confirmed = captureControllerCiExpectations(result);
  if (result.admitted !== true || result.problems.length !== 0)
    throw new Error('Unsigned artifacts require a complete admitted controller result');
  return await bindPreparedCiArtifacts(confirmed, result.results, supplied);
}
