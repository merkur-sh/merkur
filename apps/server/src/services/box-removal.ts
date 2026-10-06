import { Data, Effect } from 'effect';
import type { Transaction } from 'kysely';

import { DatabaseService } from '../db/client';
import type { DatabaseSchema } from '../db/types';
import { type Logger, logWithLoggerEffect } from '../logger';
import { BoxHostServiceTag } from './box-host-service';
import { type InfrastructureError, infrastructureError } from './errors';

/**
 * How often the queue is drained.
 *
 * A queued box is already unreachable: its device row is gone and its sessions
 * are revoked. This only paces how long the container outlives that, and how
 * soon a host that refused is asked again. The queue is empty except after a
 * password reset, so a pass is one read of an empty table.
 */
export const BOX_REMOVAL_INTERVAL = '1 minute';

/**
 * Records, inside the transaction that drops the rows naming them, that these
 * boxes are to be destroyed. A box already queued stays queued once.
 */
export async function queueBoxRemovals(
  db: Transaction<DatabaseSchema>,
  boxIds: readonly string[],
  now: number,
): Promise<void> {
  if (boxIds.length === 0) return;
  await db
    .insertInto('box_removals')
    .values(boxIds.map((boxId) => ({ box_id: boxId, requested_at: now })))
    .onConflict((conflict) => conflict.column('box_id').doNothing())
    .execute();
}

/** A box of this name is still owed its destruction. */
export class BoxRemovalPendingError extends Data.TaggedError('BoxRemovalPendingError')<{
  readonly boxId: string;
}> {}

/**
 * Refuses a name whose previous box is still queued: creating a box under it
 * would hand the queued removal a container it was never meant for.
 */
export function requireNoPendingBoxRemoval(
  boxId: string,
): Effect.Effect<void, InfrastructureError | BoxRemovalPendingError, DatabaseService> {
  return Effect.gen(function* () {
    const db = yield* DatabaseService;
    const pending = yield* Effect.tryPromise({
      try: () =>
        db
          .selectFrom('box_removals')
          .select('box_id')
          .where('box_id', '=', boxId)
          .executeTakeFirst(),
      catch: infrastructureError('box-removal', 'read-pending'),
    });
    if (pending !== undefined) return yield* new BoxRemovalPendingError({ boxId });
  });
}

/**
 * Destroys every box a password reset queued, oldest first.
 *
 * Runs on the maintenance loop rather than in the reset's request, so a reset
 * never waits on the box host and a host that was down is asked again. A row
 * leaves the queue only when the host confirms the box is gone, which `remove`
 * also reports for a box it no longer has.
 */
export function drainBoxRemovalsEffect(
  logger: Logger,
): Effect.Effect<void, InfrastructureError, DatabaseService | BoxHostServiceTag> {
  return Effect.gen(function* () {
    const db = yield* DatabaseService;
    const pending = yield* Effect.tryPromise({
      try: () =>
        db.selectFrom('box_removals').select('box_id').orderBy('requested_at', 'asc').execute(),
      catch: infrastructureError('box-removal', 'list-pending'),
    });
    if (pending.length === 0) return;

    const boxHost = yield* BoxHostServiceTag;
    for (const { box_id: box } of pending) {
      const removed = yield* boxHost.remove(box).pipe(
        Effect.as(true),
        Effect.catch((error) =>
          logWithLoggerEffect(logger, 'warn', 'box_removal_failed', {
            box,
            errorTag: error._tag,
          }).pipe(Effect.as(false)),
        ),
      );
      if (!removed) continue;
      yield* Effect.tryPromise({
        try: () => db.deleteFrom('box_removals').where('box_id', '=', box).execute(),
        catch: infrastructureError('box-removal', 'complete'),
      });
      yield* logWithLoggerEffect(logger, 'info', 'box_removed', { box });
    }
  });
}
