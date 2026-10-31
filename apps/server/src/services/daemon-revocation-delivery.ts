import { Cause, Effect } from 'effect';
import type { Kysely } from 'kysely';
import type { DatabaseSchema } from '../db/types';
import { errorLogContext, type Logger, logWithLoggerEffect } from '../logger';
import { type InfrastructureError, infrastructureError } from './errors';
import type { RedisError } from './redis-service';

const RECONCILE_INTERVAL = '1 second';

/** Each replica delivers only to its own ready connections. SQL retains pending work. */
export const runDaemonRevocationDelivery = Effect.fnUntraced(function* (
  db: Kysely<DatabaseSchema>,
  deliver: (daemonIds: readonly string[]) => Effect.Effect<void, InfrastructureError | RedisError>,
  logger: Logger,
  unlinks: Effect.Effect<void, InfrastructureError | RedisError>,
) {
  yield* Effect.forever(
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        yield* unlinks;
        const pending = yield* Effect.tryPromise({
          try: () =>
            db
              .selectFrom('delegation_revocation_outbox')
              .select('daemon_id')
              .distinct()
              .where('acknowledged_at', 'is', null)
              .execute(),
          catch: infrastructureError('daemon-control', 'scan-pending-revocations'),
        });
        yield* deliver(pending.map((row) => row.daemon_id));
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : logWithLoggerEffect(
                logger,
                'warn',
                'daemon_revocation_delivery_failed',
                errorLogContext(Cause.squash(cause)),
              ),
        ),
      );
      yield* Effect.sleep(RECONCILE_INTERVAL);
    }),
  );
});
