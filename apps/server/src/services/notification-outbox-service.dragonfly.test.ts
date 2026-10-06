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

const url = process.env.DRAGONFLY_TEST_URL;
if (url === undefined) {
  test.skip('durable device invalidation advances the shared Dragonfly cursor', () => {});
} else {
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
      await Effect.runPromise(deliverPendingNotifications(db, redis));
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
