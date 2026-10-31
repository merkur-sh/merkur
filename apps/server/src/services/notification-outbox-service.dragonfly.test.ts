import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { RedisClient } from 'bun';
import { Effect } from 'effect';
import { createMigratedKyselyDatabase } from '../db/migrate';
import { tryDatabaseTransactionPromise, withDatabaseTransaction } from '../db/transaction';
import type { DatabaseSchema } from '../db/types';
import { infrastructureError } from './errors';
import { deliverPendingNotifications, enqueueDeviceResync } from './notification-outbox-service';
import { createRedisCommandClient, RedisError, type RedisService } from './redis-service';
import { enqueueResetRevocation } from './session-revocation-outbox';

const coordination = { getDaemonPresence: () => Effect.succeed(null) };

const url = process.env.DRAGONFLY_TEST_URL;
if (url === undefined) {
  test.skip('durable device invalidation advances the shared Dragonfly cursor', () => {});
} else {
  test('an unlink publishes a wake on its exact replica channel', async () => {
    const db = await createMigratedKyselyDatabase<DatabaseSchema>(':memory:');
    const publisher = new RedisClient(url);
    const subscriber = new RedisClient(url);
    const replica = randomUUID();
    const channel = `merkur:daemon-control:instance:${replica}`;
    const observed = Promise.withResolvers<string>();
    await Promise.all([publisher.connect(), subscriber.connect()]);
    const commands = createRedisCommandClient(publisher);
    const redis: RedisService = {
      useCommands: (fn) =>
        Effect.tryPromise({
          try: async () => await fn(commands),
          catch: (cause) => new RedisError({ cause, message: String(cause) }),
        }),
      publish: (target, payload) =>
        Effect.tryPromise({
          try: async () => {
            await publisher.publish(target, payload);
          },
          catch: (cause) => new RedisError({ cause, message: String(cause) }),
        }),
      subscribe: () => Effect.void,
      unsubscribe: () => Effect.void,
      healthSnapshot: () =>
        Effect.succeed({ commandsReady: true, publisherReady: true, subscriberReady: true }),
    };
    try {
      await subscriber.subscribe(channel, (message) => observed.resolve(message));
      await db.transaction().execute(async (trx) => {
        await trx
          .insertInto('daemon_unlinks')
          .values({
            daemon_id: 'daemon',
            user_id: 'account',
            connection_id: 'old-connection',
            owner_instance_id: replica,
            presence_id: 'old-presence',
            claim_seq: 1,
            root_epoch: 0,
          })
          .execute();
      });
      await Effect.runPromise(deliverPendingNotifications(db, redis, coordination));
      expect(JSON.parse(await observed.promise)).toEqual({
        type: 'daemon_work',
        version: 1,
        daemonId: 'daemon',
        ownerInstanceId: replica,
      });
      expect(await db.selectFrom('daemon_unlinks').selectAll().execute()).toEqual([]);
      expect(await db.selectFrom('notification_outbox').selectAll().execute()).toEqual([]);
    } finally {
      subscriber.close();
      publisher.close();
      await db.destroy();
    }
  });

  test('reset revocation survives Redis failure without incrementing twice', async () => {
    const db = await createMigratedKyselyDatabase<DatabaseSchema>(':memory:');
    const probe = new RedisClient(url);
    await probe.connect();
    const userId = randomUUID();
    const generationKey = `merkur:auth:revocation:${userId}`;
    const marker = `merkur:auth:reset-revocation:${userId}`;
    const commands = createRedisCommandClient(probe);
    const broadcasts: string[] = [];
    let mode: 'before' | 'after' | 'healthy' = 'before';
    const redis: RedisService = {
      useCommands: (fn) =>
        Effect.tryPromise({
          try: async () => {
            if (mode === 'before') throw new Error('Redis unavailable');
            const result = await fn(commands);
            if (mode === 'after') throw new Error('Redis reply lost');
            return result;
          },
          catch: (cause) => new RedisError({ cause, message: String(cause) }),
        }),
      publish: (_channel, message) => Effect.sync(() => void broadcasts.push(message)),
      subscribe: () => Effect.void,
      unsubscribe: () => Effect.void,
      healthSnapshot: () =>
        Effect.succeed({ commandsReady: true, publisherReady: true, subscriberReady: true }),
    };
    try {
      await db.transaction().execute((trx) => enqueueResetRevocation(trx, userId, 2));
      await expect(
        Effect.runPromise(deliverPendingNotifications(db, redis, coordination)),
      ).rejects.toThrow('Redis unavailable');
      expect(await db.selectFrom('notification_outbox').selectAll().execute()).toHaveLength(1);
      mode = 'after';
      await expect(
        Effect.runPromise(deliverPendingNotifications(db, redis, coordination)),
      ).rejects.toThrow('Redis reply lost');
      expect(await probe.get(generationKey)).toBe('1');
      mode = 'healthy';
      await Effect.runPromise(deliverPendingNotifications(db, redis, coordination));
      expect(await probe.get(generationKey)).toBe('1');
      expect(broadcasts.map((message) => JSON.parse(message))).toEqual([
        { type: 'revocation_generation', version: 1, userId, generation: 1 },
      ]);
      expect(await db.selectFrom('notification_outbox').selectAll().execute()).toEqual([]);
      await db.transaction().execute(async (trx) => {
        await enqueueResetRevocation(trx, userId, 3);
        await enqueueResetRevocation(trx, userId, 2);
      });
      await Effect.runPromise(deliverPendingNotifications(db, redis, coordination));
      expect(await probe.get(generationKey)).toBe('2');
    } finally {
      await probe.del(generationKey, marker);
      probe.close();
      await db.destroy();
    }
  });

  test('durable invalidation preserves the epoch, advances the cursor, and replays safely', async () => {
    const db = await createMigratedKyselyDatabase<DatabaseSchema>(':memory:');
    const probe = new RedisClient(url);
    const subscriber = new RedisClient(url);
    const userId = randomUUID();
    const cursor = `merkur:device-events-cursor:${userId}`;
    const channel = `merkur:device-events:{user:${userId}}`;
    const messages: string[] = [];
    const observed = Promise.withResolvers<void>();
    await Promise.all([probe.connect(), subscriber.connect()]);
    const commands = createRedisCommandClient(probe);
    const redis: RedisService = {
      useCommands: (fn) =>
        Effect.tryPromise({
          try: async () => await fn(commands),
          catch: (cause) => new RedisError({ cause, message: String(cause) }),
        }),
      publish: () => Effect.die('unexpected session publish'),
      subscribe: () => Effect.void,
      unsubscribe: () => Effect.void,
      healthSnapshot: () =>
        Effect.succeed({ commandsReady: true, publisherReady: true, subscriberReady: true }),
    };
    try {
      await db
        .insertInto('users')
        .values({
          id: userId,
          username: userId,
          opaque_registration_record: 'record',
          root_public_key: 'root',
          root_key_commitment: 'commitment',
          root_epoch: 1,
          root_envelope_nonce: 'nonce',
          root_envelope_ciphertext: 'ciphertext',
          created_at: 1,
        })
        .execute();
      await subscriber.subscribe(channel, (payload) => {
        messages.push(payload);
        if (messages.length === 2) observed.resolve();
      });
      await probe.send('HSET', [cursor, 'epoch', '0123456789abcdef', 'seq', '7']);
      await Effect.runPromise(
        withDatabaseTransaction(db, (trx) =>
          tryDatabaseTransactionPromise({
            try: async () => {
              await enqueueDeviceResync(trx, userId);
              await enqueueDeviceResync(trx, userId);
            },
            catch: infrastructureError('test', 'enqueue'),
          }),
        ),
      );
      await Effect.runPromise(deliverPendingNotifications(db, redis, coordination));
      await observed.promise;
      expect(messages).toEqual(['resync', 'resync']);
      expect(await probe.send('HGETALL', [cursor])).toEqual([
        'epoch',
        '0123456789abcdef',
        'seq',
        '9',
      ]);
      expect(await db.selectFrom('notification_outbox').selectAll().execute()).toEqual([]);
    } finally {
      await probe.send('DEL', [cursor]);
      subscriber.close();
      probe.close();
      await db.destroy();
    }
  });
}
