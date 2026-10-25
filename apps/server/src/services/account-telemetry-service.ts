import { Context, Effect } from 'effect';
import type { Kysely } from 'kysely';

import type { DatabaseSchema } from '../db/types';
import type { DaemonControlService } from './daemon-control-service';
import { type InfrastructureError, infrastructureError } from './errors';
import type { RedisError, RedisService } from './redis-service';

export const publishAccountTelemetryChange = Effect.fn('accountTelemetry.publishChange')(function* (
  redis: RedisService,
  userId: string,
) {
  yield* redis.publish(`account:telemetry:${userId}`, '');
});

export const subscribeAccountTelemetryChanges = Effect.fn('accountTelemetry.subscribeChanges')(
  function* (redis: RedisService, userId: string, onChange: () => void) {
    const channel = `account:telemetry:${userId}`;
    yield* redis.subscribe(channel, onChange);
    return redis.unsubscribe(channel, onChange).pipe(Effect.orDie);
  },
);

export const readAccountTelemetryConsent = Effect.fn('readAccountTelemetryConsent')(function* (
  db: Kysely<DatabaseSchema>,
  userId: string,
) {
  const row = yield* Effect.tryPromise({
    try: () =>
      db
        .selectFrom('users')
        .select('telemetry_consent')
        .where('id', '=', userId)
        .executeTakeFirstOrThrow(),
    catch: infrastructureError('database', 'read-account-telemetry'),
  });
  return row.telemetry_consent === null ? null : row.telemetry_consent === 1;
});

export interface AccountTelemetryService {
  read(userId: string): Effect.Effect<boolean | null, InfrastructureError>;
  write(userId: string, enabled: boolean): Effect.Effect<boolean, InfrastructureError | RedisError>;
}

export class AccountTelemetryServiceTag extends Context.Service<
  AccountTelemetryServiceTag,
  AccountTelemetryService
>()('AccountTelemetryService') {}

export function createAccountTelemetryService(
  db: Kysely<DatabaseSchema>,
  control: Pick<DaemonControlService, 'pushTelemetryChanged'>,
  redis: RedisService,
): AccountTelemetryService {
  return {
    read: (userId) => readAccountTelemetryConsent(db, userId),
    write: Effect.fn('AccountTelemetryService.write')(function* (userId: string, enabled: boolean) {
      const row = yield* Effect.tryPromise({
        try: () =>
          db
            .updateTable('users')
            .set({ telemetry_consent: enabled ? 1 : 0 })
            .where('id', '=', userId)
            .returning('telemetry_consent')
            .executeTakeFirstOrThrow(),
        catch: infrastructureError('database', 'write-account-telemetry'),
      });
      yield* control.pushTelemetryChanged(userId);
      yield* publishAccountTelemetryChange(redis, userId);
      return row.telemetry_consent === 1;
    }),
  };
}
