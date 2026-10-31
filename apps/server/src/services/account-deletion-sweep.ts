import { Effect } from 'effect';

import { type Logger, logWithLoggerEffect } from '../logger';
import { AuthServiceTag } from './auth-service';
import type { InfrastructureError } from './errors';

/**
 * How often the sweep looks for accounts whose grace period has run out.
 *
 * The grace period is measured in days, so the only thing this paces is how
 * long past its deadline an erasure can sit. An hour is well inside any
 * reasonable reading of "without undue delay" and costs one indexed query.
 */
export const ACCOUNT_DELETION_SWEEP_INTERVAL = '1 hour';

/**
 * Erases the accounts whose grace period has run out.
 *
 * Runs as ordinary background maintenance rather than as part of the request
 * that asked for the deletion, because the wait is the point: the account holder
 * can still call the whole thing off by signing in, right up until this sweep
 * reaches them.
 *
 * Eligibility is rechecked transactionally with erasure and durable box-removal
 * queueing. The box-removal worker destroys the containers after the commit.
 */
export function sweepDeletedAccountsEffect(
  logger: Logger,
): Effect.Effect<void, InfrastructureError, AuthServiceTag> {
  return Effect.gen(function* () {
    const auth = yield* AuthServiceTag;
    const due = yield* auth.accountsDueForDeletion();
    if (due.length === 0) return;

    for (const userId of due) {
      yield* auth.purgeAccount(userId);
      yield* logWithLoggerEffect(logger, 'info', 'account_deletion_checked', {
        userId,
      });
    }
  });
}
