import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Effect, Layer } from 'effect';
import { type Kysely, sql } from 'kysely';
import { DatabaseService } from '../db/client';
import { createMigratedKyselyDatabase } from '../db/migrate';
import { tryDatabaseTransactionPromise, withDatabaseTransaction } from '../db/transaction';
import type { DatabaseSchema } from '../db/types';
import { infrastructureError } from './errors';
import {
  deliverPendingNotifications,
  enqueueBrowserSessionChange,
  NotificationOutboxServiceLive,
  NotificationOutboxServiceTag,
} from './notification-outbox-service';
import {
  type RealtimeCoordinationService,
  RealtimeCoordinationServiceTag,
} from './realtime-coordination-service';
import { RedisError, type RedisService, RedisServiceTag } from './redis-service';

const unexpectedCoordination = () => Effect.die('unexpected coordination operation');
const coordination: RealtimeCoordinationService = {
  instanceId: 'replica',
  healthSnapshot: () => Effect.succeed({ presenceExpirySchedulerHealthy: true }),
  awaitCriticalFailure: Effect.never,
  getDaemonPresence: () => Effect.succeed(null),
  claimDaemonOnline: unexpectedCoordination,
  renewDaemonLeases: unexpectedCoordination,
  markDaemonSilent: unexpectedCoordination,
  clearDaemonSilent: unexpectedCoordination,
  unmarkDaemonOnline: unexpectedCoordination,
  suspendDaemonPresence: unexpectedCoordination,
  resumeDaemonPresence: unexpectedCoordination,
  getUserDaemonPresence: unexpectedCoordination,
  publishDeviceDelta: unexpectedCoordination,
  readDeviceEventsCursor: unexpectedCoordination,
  subscribeDeviceEvents: unexpectedCoordination,
  incrementRevocationGeneration: unexpectedCoordination,
  createSessionForDaemonPresence: unexpectedCoordination,
  removeSessionForUser: unexpectedCoordination,
  removeDaemonSessions: unexpectedCoordination,
};

let db: Kysely<DatabaseSchema>;
const change = { issuedDelegationIds: [], revokedDelegationIds: ['exact-delegation'] };

beforeEach(async () => {
  db = await createMigratedKyselyDatabase<DatabaseSchema>(':memory:');
  await db
    .insertInto('users')
    .values({
      id: 'account',
      username: 'account',
      opaque_registration_record: 'record',
      root_public_key: 'root',
      root_key_commitment: 'commitment',
      root_epoch: 1,
      root_envelope_nonce: 'nonce',
      root_envelope_ciphertext: 'ciphertext',
      created_at: 1,
    })
    .execute();
});
afterEach(() => db.destroy());

describe('durable notification publication', () => {
  test('unlink intent commits a durable wake for its exact owner', async () => {
    await db.transaction().execute(async (trx) => {
      await trx
        .insertInto('daemon_unlinks')
        .values({
          daemon_id: 'daemon',
          user_id: 'account',
          connection_id: 'connection',
          owner_instance_id: 'replica',
          presence_id: 'presence',
          claim_seq: 1,
          root_epoch: 0,
        })
        .execute();
    });
    const messages: Array<{ channel: string; payload: string }> = [];
    await Effect.runPromise(
      deliverPendingNotifications(
        db,
        fakeRedis((channel, payload) => {
          messages.push({ channel, payload });
        }),
        coordination,
      ),
    );
    expect(messages).toEqual([
      {
        channel: 'merkur:daemon-control:instance:replica',
        payload: JSON.stringify({
          type: 'daemon_work',
          version: 1,
          daemonId: 'daemon',
          ownerInstanceId: 'replica',
        }),
      },
    ]);
    expect(await pending()).toEqual([]);
    expect(await db.selectFrom('daemon_unlinks').selectAll().execute()).toEqual([]);
  });

  test('a rollback removes notification intent along with its state change', async () => {
    const failed = withDatabaseTransaction(db, (trx) =>
      tryDatabaseTransactionPromise({
        try: async () => {
          await trx
            .updateTable('users')
            .set({ username: 'changed' })
            .where('id', '=', 'account')
            .execute();
          await enqueueBrowserSessionChange(trx, 'account', change);
          throw new Error('storage failed');
        },
        catch: infrastructureError('test', 'rollback'),
      }),
    );
    await expect(Effect.runPromise(failed)).rejects.toThrow('storage failed');
    expect(await pending()).toHaveLength(0);
    expect(
      (await db.selectFrom('users').select('username').executeTakeFirstOrThrow()).username,
    ).toBe('account');
  });

  test('an unknown Redis result retains exact intent and recovery safely replays it', async () => {
    await enqueueChange();
    const messages: string[] = [];
    const unknown: RedisService = {
      ...fakeRedis(),
      publish: (_channel, payload) =>
        Effect.gen(function* () {
          messages.push(payload);
          return yield* new RedisError({ cause: null, message: 'reply lost after publication' });
        }),
    };
    await expect(
      Effect.runPromise(deliverPendingNotifications(db, unknown, coordination)),
    ).rejects.toThrow('reply lost');
    expect(await pending()).toHaveLength(1);
    await Effect.runPromise(
      deliverPendingNotifications(
        db,
        fakeRedis((_channel, payload) => messages.push(payload)),
        coordination,
      ),
    );
    expect(messages).toEqual([JSON.stringify(change), JSON.stringify(change)]);
    expect(await pending()).toHaveLength(0);
  });

  test('a lost SQL acknowledgement replays publication rather than dropping intent', async () => {
    await enqueueChange();
    await sql`CREATE TRIGGER refuse_ack BEFORE DELETE ON notification_outbox BEGIN SELECT RAISE(FAIL, 'ack failed'); END`.execute(
      db,
    );
    const messages: string[] = [];
    const redis = fakeRedis((_channel, payload) => messages.push(payload));
    await expect(
      Effect.runPromise(deliverPendingNotifications(db, redis, coordination)),
    ).rejects.toThrow('ack failed');
    expect(await pending()).toHaveLength(1);
    await sql`DROP TRIGGER refuse_ack`.execute(db);
    await Effect.runPromise(deliverPendingNotifications(db, redis, coordination));
    expect(messages).toHaveLength(2);
    expect(await pending()).toHaveLength(0);
  });

  test('the scoped worker waits for migration readiness, then drains durable commits', async () => {
    await enqueueChange();
    const published = Promise.withResolvers<void>();
    const messages: string[] = [];
    const layer = NotificationOutboxServiceLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(DatabaseService, db),
          Layer.succeed(RealtimeCoordinationServiceTag, coordination),
          Layer.succeed(
            RedisServiceTag,
            fakeRedis((_channel, payload) => {
              messages.push(payload);
              published.resolve();
            }),
          ),
        ),
      ),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* NotificationOutboxServiceTag;
        yield* service.wake;
        expect(messages).toHaveLength(0);
        yield* service.start;
        yield* service.start;
        yield* Effect.promise(() => published.promise);
      }).pipe(Effect.provide(layer)),
    );
    expect(messages).toEqual([JSON.stringify(change)]);
  });

  test('a malformed notification cannot starve valid notifications across batches', async () => {
    await db
      .insertInto('notification_outbox')
      .values(
        Array.from({ length: 65 }, (_, index) => ({
          id: `a-${index.toString().padStart(3, '0')}`,
          user_id: 'account',
          kind: 'invalid',
          payload: '',
        })),
      )
      .execute();
    await enqueueChange();
    const messages: string[] = [];
    await expect(
      Effect.runPromise(
        deliverPendingNotifications(
          db,
          fakeRedis((_channel, payload) => messages.push(payload)),
          coordination,
        ),
      ),
    ).rejects.toThrow('Invalid notification kind');
    expect(messages).toEqual([JSON.stringify(change)]);
    expect(await pending()).toHaveLength(65);
  });

  test('account erasure retains pending revocation delivery intent', async () => {
    await enqueueChange();
    await db.deleteFrom('users').where('id', '=', 'account').execute();
    expect(await pending()).toHaveLength(1);
    await Effect.runPromise(deliverPendingNotifications(db, fakeRedis(), coordination));
    expect(await pending()).toHaveLength(0);
  });
});

function pending() {
  return db.selectFrom('notification_outbox').selectAll().execute();
}
function enqueueChange() {
  return Effect.runPromise(
    withDatabaseTransaction(db, (trx) =>
      tryDatabaseTransactionPromise({
        try: () => enqueueBrowserSessionChange(trx, 'account', change),
        catch: infrastructureError('test', 'enqueue'),
      }),
    ),
  );
}
function fakeRedis(onPublish: (channel: string, payload: string) => void = () => {}): RedisService {
  return {
    publish: (channel, payload) => Effect.sync(() => onPublish(channel, payload)),
    useCommands: () => Effect.die('unexpected command'),
    subscribe: () => Effect.void,
    unsubscribe: () => Effect.void,
    healthSnapshot: () =>
      Effect.succeed({ commandsReady: true, publisherReady: true, subscriberReady: true }),
  };
}
