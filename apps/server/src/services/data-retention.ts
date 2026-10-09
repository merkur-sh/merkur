import { Clock, DateTime, Effect } from 'effect';
import type { Kysely } from 'kysely';

import { ServerConfigService } from '../config';
import { DatabaseService } from '../db/client';
import { tryDatabaseTransactionPromise, withDatabaseTransaction } from '../db/transaction';
import type { DatabaseSchema } from '../db/types';
import { type Logger, logWithLoggerEffect } from '../logger';
import { queueBoxRemovals } from './box-removal';
import { readAccountBoxes } from './device-service';
import { infrastructureError } from './errors';
import { createResendMailSender, type MailSender } from './mail-sender';

export const DATA_RETENTION_INTERVAL = '1 hour';
const NOTICE_PERIOD_MS = 30 * 24 * 60 * 60 * 1_000;

/** UTC calendar months, rather than treating every year as 365 days. */
function monthsAgo(now: number, months: number): number {
  return DateTime.toEpochMillis(DateTime.subtract(DateTime.makeUnsafe(now), { months }));
}

export const enforceDataRetentionEffect = Effect.fn('DataRetention.sweep')(function* (
  logger: Logger,
) {
  const db = yield* DatabaseService;
  const config = yield* ServerConfigService;
  const mail =
    config.emailDelivery === undefined
      ? null
      : createResendMailSender(config.emailDelivery, config.publicOrigin);
  yield* enforceDataRetention(db, mail, logger);
});

export const enforceDataRetention = Effect.fn('DataRetention.enforce')(function* (
  db: Kysely<DatabaseSchema>,
  mail: MailSender | null,
  logger: Logger,
) {
  const now = yield* Clock.currentTimeMillis;
  const inactiveBefore = monthsAgo(now, 12);
  const suspendedBefore = monthsAgo(now, 24);
  const waitlist = yield* Effect.tryPromise({
    try: () =>
      db.deleteFrom('box_waitlist').where('created_at', '<=', inactiveBefore).executeTakeFirst(),
    catch: infrastructureError('data-retention', 'expire-waitlist'),
  });

  // Never infer a mailbox from a username. Only email sign-in verifies addresses.
  if (mail !== null) {
    const pending = yield* Effect.tryPromise({
      try: () =>
        db
          .selectFrom('users')
          .select(['id', 'username', 'last_sign_in_at'])
          .where('last_sign_in_at', '<=', inactiveBefore)
          .where('suspended_at', 'is', null)
          .where('deletion_scheduled_at', 'is', null)
          .where('inactivity_notice_sent_at', 'is', null)
          .execute(),
      catch: infrastructureError('data-retention', 'list-inactive-notices'),
    });
    for (const user of pending) {
      if (user.id === null) continue;
      const sent = yield* mail
        .sendInactivityNotice({
          to: user.username,
          idempotencyKey: `${user.id}:inactive:${user.last_sign_in_at}`,
        })
        .pipe(
          Effect.as(true),
          Effect.catch(() =>
            logWithLoggerEffect(logger, 'warn', 'inactivity_notice_failed', {
              userId: user.id,
            }).pipe(Effect.as(false)),
          ),
        );
      if (!sent) continue;
      // The clock starts after the provider accepts the notice. A sign-in that
      // raced delivery prevents the stale notice from scheduling any deletion.
      const sentAt = yield* Clock.currentTimeMillis;
      yield* Effect.tryPromise({
        try: () =>
          db
            .updateTable('users')
            .set({ inactivity_notice_sent_at: sentAt })
            .where('id', '=', user.id)
            .where('last_sign_in_at', '=', user.last_sign_in_at)
            .where('suspended_at', 'is', null)
            .where('deletion_scheduled_at', 'is', null)
            .where('inactivity_notice_sent_at', 'is', null)
            .execute(),
        catch: infrastructureError('data-retention', 'record-inactivity-notice'),
      });
    }
  }

  // Re-evaluate eligibility inside the same transaction that queues boxes and
  // deletes the account. A concurrent sign-in cannot leave an active account
  // whose box was already removed by an earlier candidate scan.
  const expired = yield* withDatabaseTransaction(db, (trx) =>
    tryDatabaseTransactionPromise({
      try: async () => {
        const due = await trx
          .selectFrom('users')
          .select('id')
          .where((eb) =>
            eb.or([
              eb('suspended_at', '<=', suspendedBefore),
              ...(mail === null
                ? []
                : [
                    eb.and([
                      eb('suspended_at', 'is', null),
                      eb('last_sign_in_at', '<=', inactiveBefore),
                      eb('inactivity_notice_sent_at', '<=', now - NOTICE_PERIOD_MS),
                    ]),
                  ]),
            ]),
          )
          .execute();
        let accounts = 0;
        let boxes = 0;
        for (const user of due) {
          if (user.id === null) continue;
          const owned = await readAccountBoxes(trx, user.id);
          await queueBoxRemovals(trx, owned.owned, now);
          await trx.deleteFrom('users').where('id', '=', user.id).execute();
          accounts += 1;
          boxes += owned.owned.length;
        }
        return { accounts, boxes };
      },
      catch: infrastructureError('data-retention', 'expire-accounts'),
    }),
  );
  yield* logWithLoggerEffect(logger, 'info', 'data_retention_enforced', {
    waitlist: Number(waitlist.numDeletedRows),
    ...expired,
  });
});
