import type { VerificationExpectation } from '../verification/front-end';
import type { VerificationReport } from '../verification/report';
import { reconstructProducerVerification } from './shipping-evidence';

/** Acquired independently by the trusted CI controller, never copied from the submitted report. */
export type ExpectedCiVerification = VerificationExpectation;

/** Reconstruct raw execution evidence; job status, uploaded JSON and reported booleans do not admit it. */
export function reconstructCiVerification(
  result: unknown,
  expected: ExpectedCiVerification,
): VerificationReport {
  if (
    expected === null ||
    typeof expected !== 'object' ||
    Array.isArray(expected) ||
    Object.keys(expected).sort().join(',') !==
      'admittedUntracked,base,candidate,configuredDigest,gitDigest,head,invocation,platform,required,sourceDigest' ||
    ![expected.base, expected.candidate, expected.head].every(
      (identity) =>
        typeof identity === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(identity),
    ) ||
    new Set([expected.base.length, expected.candidate.length, expected.head.length]).size !== 1 ||
    typeof expected.invocation !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(expected.invocation) ||
    result === null ||
    typeof result !== 'object' ||
    Array.isArray(result) ||
    !Object.hasOwn(result, 'evidence') ||
    'phase' in result
  ) {
    throw new Error(
      'CI admission requires raw execution evidence and an independent complete context',
    );
  }
  const evidence = 'evidence' in result ? result.evidence : undefined;
  return reconstructProducerVerification(evidence, {
    platform: expected.platform,
    invocation: expected.invocation,
    base: expected.base,
    candidate: expected.candidate,
    commit: expected.head,
    gitDigest: expected.gitDigest,
    sourceDigest: expected.sourceDigest,
    configuredDigest: expected.configuredDigest,
    required: expected.required,
    admittedUntracked: expected.admittedUntracked,
  });
}
