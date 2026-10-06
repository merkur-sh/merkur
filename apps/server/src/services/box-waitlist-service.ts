import { Clock, Context, Data, Effect, Layer } from 'effect';
import type { Kysely } from 'kysely';

import { DatabaseService } from '../db/client';
import type { DatabaseSchema } from '../db/types';
import { normalizeAccountIdentifier } from './account-identifier';
import {
  domainTakesMail,
  isDisposableAddress,
  type MailResolver,
  SYSTEM_MAIL_RESOLVER,
  suspendedMailboxTaken,
} from './email-admission';
import { type InfrastructureError, infrastructureError } from './errors';

/**
 * The public website's Boxes waitlist: addresses that asked to hear when hosted
 * boxes open.
 *
 * It belongs to no account, which is what separates it from `box_access`, an
 * account's own standing inside the application. An address is held to the
 * same rules as a sign-up: one spelling (`normalizeAccountIdentifier`), and no
 * disposable domain or suspended account's mailbox (`email-admission.ts`).
 *
 * A sign-up proves its mailbox with the code mailed to it. Nothing is mailed
 * to a waitlist address until boxes open, so here the domain itself must take
 * mail (`domainTakesMail`). When the resolver gives no answer the join fails
 * and nothing is stored, rather than an unchecked address being taken.
 */

export type BoxWaitlistErrorCode = 'email_invalid' | 'email_refused';

export class BoxWaitlistError extends Data.TaggedError('BoxWaitlistError')<{
  readonly code: BoxWaitlistErrorCode;
  readonly message: string;
}> {}

export interface BoxWaitlistEntry {
  /** False when the address was already on the list; the list is unchanged then. */
  readonly inserted: boolean;
}

export interface BoxWaitlistService {
  /**
   * Adds the address in its normalized spelling. Idempotent: an address
   * already on the list keeps its original `created_at`.
   */
  record(email: string): Effect.Effect<BoxWaitlistEntry, BoxWaitlistError | InfrastructureError>;
}

export class BoxWaitlistServiceTag extends Context.Service<
  BoxWaitlistServiceTag,
  BoxWaitlistService
>()('BoxWaitlistService') {}

export const BoxWaitlistServiceLive = Layer.effect(
  BoxWaitlistServiceTag,
  Effect.gen(function* () {
    const db = yield* DatabaseService;
    return createBoxWaitlistService(db, SYSTEM_MAIL_RESOLVER);
  }),
);

export function createBoxWaitlistService(
  db: Kysely<DatabaseSchema>,
  resolver: MailResolver,
): BoxWaitlistService {
  return {
    record: Effect.fn('BoxWaitlistService.record')(function* (email: string) {
      const address = normalizeAccountIdentifier('email', email);
      if (address === null) {
        return yield* new BoxWaitlistError({
          code: 'email_invalid',
          message: 'Email address is invalid',
        });
      }
      // The lookup comes last, so an address the server can refuse on its own
      // never costs a query.
      if (
        isDisposableAddress(address) ||
        (yield* Effect.tryPromise({
          try: () => suspendedMailboxTaken(db, address),
          catch: infrastructureError('box-waitlist', 'match-suspended-mailbox'),
        })) ||
        !(yield* Effect.tryPromise({
          try: () => domainTakesMail(resolver, address),
          catch: infrastructureError('box-waitlist', 'resolve-mail-domain'),
        }))
      ) {
        return yield* new BoxWaitlistError({
          code: 'email_refused',
          message: 'This address cannot join the waitlist',
        });
      }
      const createdAt = yield* Clock.currentTimeMillis;
      // `RETURNING` yields the row only when this insert wrote it, so a
      // duplicate is told apart by the insert itself rather than a second read.
      const row = yield* Effect.tryPromise({
        try: () =>
          db
            .insertInto('box_waitlist')
            .values({ email: address, created_at: createdAt })
            .onConflict((conflict) => conflict.column('email').doNothing())
            .returning('email')
            .executeTakeFirst(),
        catch: infrastructureError('box-waitlist', 'record'),
      });
      return { inserted: row !== undefined };
    }),
  };
}
