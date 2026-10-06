import { Clock, Context, Data, Effect, Layer } from 'effect';
import type { Kysely } from 'kysely';

import { DatabaseService } from '../db/client';
import type { DatabaseSchema } from '../db/types';
import { type InfrastructureError, infrastructureError } from './errors';

/**
 * Who may create hosted boxes, and the waitlist that decides it.
 *
 * Signing up is open; a box is not. It is a container on a host with a fixed
 * memory budget, so an account asks by joining the waitlist. Joining records
 * the account and nothing else — no contact address is collected, so the
 * account learns the decision the next time it opens the New box dialog.
 *
 * The server has no approval route. An operator decides in the database by
 * setting the account's `box_access.status` to `approved` (or back to
 * `waitlisted`) and stamping `decided_at`; no account holds operator authority
 * over the API. A privileged account (`users.privileged_at`, also set only in
 * the database) is approved without a waitlist row.
 */

export type BoxAccessStatus = 'none' | 'waitlisted' | 'approved';

export interface BoxAccess {
  readonly status: BoxAccessStatus;
}

export type BoxAccessErrorCode = 'box_access_required';

export class BoxAccessError extends Data.TaggedError('BoxAccessError')<{
  readonly code: BoxAccessErrorCode;
  readonly message: string;
}> {}

export interface BoxAccessService {
  access(userId: string): Effect.Effect<BoxAccess, InfrastructureError>;
  /**
   * Puts the account on the waitlist. Idempotent: an account already waiting
   * keeps its place, and an approved account stays approved.
   */
  join(userId: string): Effect.Effect<BoxAccess, InfrastructureError>;
  /** Fails with `box_access_required` unless the account is approved. */
  requireApproved(userId: string): Effect.Effect<void, BoxAccessError | InfrastructureError>;
}

export class BoxAccessServiceTag extends Context.Service<BoxAccessServiceTag, BoxAccessService>()(
  'BoxAccessService',
) {}

export const BoxAccessServiceLive = Layer.effect(
  BoxAccessServiceTag,
  Effect.gen(function* () {
    const db = yield* DatabaseService;
    return createBoxAccessService(db);
  }),
);

export function createBoxAccessService(db: Kysely<DatabaseSchema>): BoxAccessService {
  const readStatus = (userId: string) =>
    Effect.tryPromise({
      try: () =>
        db
          .selectFrom('users')
          .leftJoin('box_access', 'box_access.user_id', 'users.id')
          .select(['users.privileged_at', 'box_access.status'])
          .where('users.id', '=', userId)
          .executeTakeFirst(),
      catch: infrastructureError('box-access', 'read-status'),
    }).pipe(
      Effect.map((row): BoxAccessStatus => {
        if (row === undefined) return 'none';
        if (row.privileged_at !== null) return 'approved';
        return row.status === null ? 'none' : parseStatus(row.status);
      }),
    );

  return {
    access: Effect.fn('BoxAccessService.access')(function* (userId: string) {
      return { status: yield* readStatus(userId) };
    }),

    join: Effect.fn('BoxAccessService.join')(function* (userId: string) {
      const requestedAt = yield* Clock.currentTimeMillis;
      yield* Effect.tryPromise({
        try: () =>
          db
            .insertInto('box_access')
            .values({ user_id: userId, status: 'waitlisted', requested_at: requestedAt })
            .onConflict((conflict) => conflict.column('user_id').doNothing())
            .execute(),
        catch: infrastructureError('box-access', 'join'),
      });
      return { status: yield* readStatus(userId) };
    }),

    requireApproved: Effect.fn('BoxAccessService.requireApproved')(function* (userId: string) {
      if ((yield* readStatus(userId)) !== 'approved') {
        return yield* new BoxAccessError({
          code: 'box_access_required',
          message: 'This account is not approved to create boxes',
        });
      }
    }),
  };
}

/** The column is constrained to these two values; anything else is corruption. */
function parseStatus(value: string): Exclude<BoxAccessStatus, 'none'> {
  if (value === 'waitlisted' || value === 'approved') return value;
  throw new Error(`Unknown box access status: ${value}`);
}
