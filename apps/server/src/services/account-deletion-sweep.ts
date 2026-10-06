import { Effect } from 'effect';

import { type Logger, logWithLoggerEffect } from '../logger';
import { AuthServiceTag } from './auth-service';
import { BoxHostServiceTag } from './box-host-service';
import { DeviceServiceTag } from './device-service';
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
 * Containers are destroyed before the rows are. A box that outlives the account
 * that owned it still holds that account's files, and once the rows are gone
 * nothing remembers the box existed — so the order here is what makes the
 * erasure real rather than nominal. If the host refuses, the account keeps its
 * rows and the next sweep tries again.
 */
export function sweepDeletedAccountsEffect(
  logger: Logger,
): Effect.Effect<void, InfrastructureError, AuthServiceTag | DeviceServiceTag | BoxHostServiceTag> {
  return Effect.gen(function* () {
    const auth = yield* AuthServiceTag;
    const due = yield* auth.accountsDueForDeletion();
    if (due.length === 0) return;

    const devices = yield* DeviceServiceTag;
    const boxHost = yield* BoxHostServiceTag;
    for (const userId of due) {
      // The box each device was linked from, never its editable name. A
      // machine that is not a box names none and costs the host nothing.
      const boxes = yield* devices.listAccountBoxes(userId);
      for (const box of boxes.contested) {
        yield* logWithLoggerEffect(logger, 'warn', 'account_deletion_box_contested', {
          userId,
          box,
        });
      }
      let boxFailures = 0;
      for (const box of boxes.owned) {
        // `remove` succeeds for a box the host no longer has. An unreachable or
        // refusing host must stop the purge: deleting the rows anyway would
        // strand the container with no record that it belongs to anyone.
        const removed = yield* boxHost.remove(box).pipe(
          Effect.as(true),
          Effect.catch((error) =>
            logWithLoggerEffect(logger, 'warn', 'account_deletion_box_remove_failed', {
              userId,
              box,
              errorTag: error._tag,
            }).pipe(Effect.as(false)),
          ),
        );
        if (!removed) boxFailures += 1;
      }
      if (boxFailures > 0) {
        yield* logWithLoggerEffect(logger, 'warn', 'account_deletion_deferred', {
          userId,
          boxFailures,
        });
        continue;
      }
      yield* auth.purgeAccount(userId);
      yield* logWithLoggerEffect(logger, 'info', 'account_deleted', {
        userId,
        boxes: boxes.owned.length,
      });
    }
  });
}
