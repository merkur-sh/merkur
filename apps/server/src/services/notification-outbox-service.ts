import { randomBytes, randomUUID } from 'node:crypto';
import { Cause, Context, Deferred, Effect, Layer, Queue } from 'effect';
import type { Kysely, Transaction } from 'kysely';
import { DatabaseService } from '../db/client';
import type { DatabaseSchema } from '../db/types';
import { createLogger, errorLogContext, logWithLoggerEffect } from '../logger';
import type { BrowserSessionChange } from './browser-session-presence';
import { type InfrastructureError, infrastructureError } from './errors';
import { defineRedisScript } from './redis-script';
import {
  evalRedisScript,
  type RedisError,
  type RedisService,
  RedisServiceTag,
} from './redis-service';

const BATCH_SIZE = 64;
const RECONCILE_INTERVAL = '1 second';

// Advancing the cursor is essential: a browser reconnecting after this publish
// must observe a gap and reload SQL even if no subscriber received the marker.
const DEVICE_RESYNC_SCRIPT = defineRedisScript(
  'device-events-outbox-resync',
  `
redis.call('HSETNX', KEYS[1], 'epoch', ARGV[1])
redis.call('HINCRBY', KEYS[1], 'seq', 1)
redis.call('PUBLISH', KEYS[2], 'resync')
return 1
`,
);

export class NotificationOutboxServiceTag extends Context.Service<
  NotificationOutboxServiceTag,
  {
    /** Called after migrations, before accepting requests. */
    readonly start: Effect.Effect<void>;
    /** Coalesced local commit notification; durable SQL rows own delivery. */
    readonly wake: Effect.Effect<void>;
  }
>()('NotificationOutboxService') {}

export const NotificationOutboxServiceLive = Layer.effect(
  NotificationOutboxServiceTag,
  Effect.gen(function* () {
    const db = yield* DatabaseService;
    const redis = yield* RedisServiceTag;
    const logger = createLogger('server');
    const started = yield* Deferred.make<void>();
    const wakeups = yield* Queue.make<void>({ capacity: 1, strategy: 'dropping' });
    yield* Effect.addFinalizer(() => Queue.shutdown(wakeups));
    yield* Effect.gen(function* () {
      yield* Deferred.await(started);
      yield* Effect.forever(
        Effect.gen(function* () {
          yield* deliverPendingNotifications(db, redis).pipe(
            Effect.catchCause((cause) => {
              if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
              return logWithLoggerEffect(logger, 'warn', 'notification_outbox_delivery_failed', {
                ...errorLogContext(Cause.squash(cause)),
              });
            }),
          );
          // Local commits wake immediately. The durable scan also discovers
          // commits whose process died before waking its worker.
          yield* Queue.take(wakeups).pipe(
            Effect.timeoutOrElse({ duration: RECONCILE_INTERVAL, orElse: () => Effect.void }),
          );
        }),
      );
    }).pipe(Effect.forkScoped);
    return {
      start: Deferred.succeed(started, undefined).pipe(Effect.asVoid),
      wake: Queue.offer(wakeups, undefined).pipe(Effect.asVoid),
    };
  }),
);

/** Must be called inside the transaction that changes browser sessions. */
export async function enqueueBrowserSessionChange(
  db: Transaction<DatabaseSchema>,
  userId: string,
  change: BrowserSessionChange,
): Promise<void> {
  if (change.issuedDelegationIds.length === 0 && change.revokedDelegationIds.length === 0) return;
  await db
    .insertInto('notification_outbox')
    .values({
      id: randomUUID(),
      user_id: userId,
      kind: 'browser-sessions',
      payload: JSON.stringify(change),
    })
    .execute();
}

/** Replayed invalidations always load authoritative state, never stale deltas. */
export async function enqueueDeviceResync(
  db: Transaction<DatabaseSchema>,
  userId: string,
): Promise<void> {
  await db
    .insertInto('notification_outbox')
    .values({
      id: randomUUID(),
      user_id: userId,
      kind: 'devices',
      payload: '',
    })
    .execute();
}

const publishNotification = Effect.fnUntraced(function* (
  redis: RedisService,
  row: { readonly kind: string; readonly user_id: string; readonly payload: string },
) {
  if (row.kind === 'browser-sessions') {
    yield* redis.publish(`browser:presence:events:${row.user_id}`, row.payload);
  } else if (row.kind === 'devices') {
    yield* redis.useCommands((commands) =>
      evalRedisScript(
        commands,
        DEVICE_RESYNC_SCRIPT,
        [
          `merkur:device-events-cursor:${row.user_id}`,
          `merkur:device-events:{user:${row.user_id}}`,
        ],
        [randomBytes(8).toString('hex')],
      ),
    );
  } else {
    return yield* Effect.fail(
      infrastructureError(
        'notification-outbox',
        'decode-kind',
      )(new Error(`Invalid notification kind: ${row.kind}`)),
    );
  }
});

export const deliverPendingNotifications = Effect.fnUntraced(function* (
  db: Kysely<DatabaseSchema>,
  redis: RedisService,
) {
  let after: string | undefined;
  let firstFailure: InfrastructureError | RedisError | undefined;
  while (true) {
    const rows = yield* Effect.tryPromise({
      try: () => {
        let query = db
          .selectFrom('notification_outbox')
          .selectAll()
          .orderBy('id')
          .limit(BATCH_SIZE);
        if (after !== undefined) query = query.where('id', '>', after);
        return query.execute();
      },
      catch: infrastructureError('notification-outbox', 'list-pending'),
    });
    if (rows.length === 0) {
      if (firstFailure !== undefined) return yield* Effect.fail(firstFailure);
      return;
    }
    const published: string[] = [];
    for (const row of rows) {
      after = row.id;
      const result = yield* Effect.result(publishNotification(redis, row));
      if (result._tag === 'Failure') {
        firstFailure ??= result.failure;
      } else {
        published.push(row.id);
      }
    }
    if (published.length === 0) continue;
    // Batch acknowledgement touches only immutable IDs whose publication was
    // confirmed. Failed rows remain durable, and cannot block other accounts.
    const acknowledged = yield* Effect.result(
      Effect.tryPromise({
        try: () => db.deleteFrom('notification_outbox').where('id', 'in', published).execute(),
        catch: infrastructureError('notification-outbox', 'acknowledge-publication'),
      }),
    );
    if (acknowledged._tag === 'Failure') firstFailure ??= acknowledged.failure;
  }
});
