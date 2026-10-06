import { type ControllerAttempt, verifyReservedBatch } from './controller';
import {
  type ExecutorPolicy,
  NATIVE_EXECUTION_PLATFORMS,
  parseExecutorPolicy,
} from './executor-policy';

/** Native-four qualification cannot be reduced to the platform jobs that happened to finish. */
export function requireNativePlatformAttempts(attempts: readonly ControllerAttempt[]): void {
  if (
    attempts.length !== NATIVE_EXECUTION_PLATFORMS.length ||
    new Set(attempts.map(({ engine }) => engine.platform)).size !== attempts.length ||
    NATIVE_EXECUTION_PLATFORMS.some(
      (platform) => !attempts.some(({ engine }) => engine.platform === platform),
    )
  )
    throw new Error(
      'Native qualification requires exactly the four independently planned platforms',
    );
}

/**
 * Uses the admission controller's sole reservation, publication, execution and retirement path.
 * Deployment configuration selects workers; report JSON never supplies or shrinks this inventory.
 * Successful execution alone does not establish quiet-hardware or shared-cache qualification.
 */
export async function verifyNativePlatformBatch(
  options: Parameters<typeof verifyReservedBatch>[0] & { readonly executorPolicy: ExecutorPolicy },
): ReturnType<typeof verifyReservedBatch> {
  parseExecutorPolicy(options.executorPolicy);
  // Copy before asynchronous execution so caller mutation cannot shrink the cohort.
  const attempts = options.attempts.map((attempt) => ({
    engine: attempt.engine,
    options: { ...attempt.options, admittedUntracked: [...attempt.options.admittedUntracked] },
  }));
  requireNativePlatformAttempts(attempts);
  return verifyReservedBatch({ ...options, attempts });
}
