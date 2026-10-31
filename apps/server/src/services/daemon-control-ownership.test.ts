import { expect, test } from 'bun:test';
import { Cause, Effect, Exit } from 'effect';
import { createMigratedKyselyDatabase } from '../db/migrate';
import type { DatabaseSchema } from '../db/types';
import { deliverDaemonUnlinks } from './daemon-control-ownership';
import { RedisError, type RedisService } from './redis-service';

const redis: RedisService = {
  publish: () => Effect.void,
  useCommands: () => Effect.die('reset marker read after exact owner was gone'),
  subscribe: () => Effect.void,
  unsubscribe: () => Effect.void,
  healthSnapshot: () =>
    Effect.succeed({ commandsReady: true, publisherReady: true, subscriberReady: true }),
};

test('restored reset unlink retires a missing exact owner without Redis reset markers', async () => {
  const db = await createMigratedKyselyDatabase<DatabaseSchema>(':memory:');
  try {
    await db
      .insertInto('daemon_unlinks')
      .values({
        connection_id: 'lost-connection',
        daemon_id: 'daemon',
        user_id: 'user',
        owner_instance_id: 'old-replica',
        presence_id: 'lost-presence',
        claim_seq: 1,
        root_epoch: 2,
      })
      .execute();
    let retired = false;
    await Effect.runPromise(
      deliverDaemonUnlinks(
        db,
        redis,
        () =>
          Effect.sync(() => {
            retired = true;
            return true;
          }),
        { getDaemonPresence: () => Effect.succeed(null) },
        'daemon',
      ),
    );
    expect(retired).toBe(true);
    expect(await db.selectFrom('daemon_unlinks').selectAll().execute()).toEqual([]);
  } finally {
    await db.destroy();
  }
});

test('invalid live reset state fails with a RedisError', async () => {
  const db = await createMigratedKyselyDatabase<DatabaseSchema>(':memory:');
  try {
    await db
      .insertInto('daemon_unlinks')
      .values({
        connection_id: 'connection',
        daemon_id: 'daemon',
        user_id: 'user',
        owner_instance_id: 'replica',
        presence_id: 'presence',
        claim_seq: 1,
        root_epoch: 2,
      })
      .execute();
    const invalid: RedisService = {
      ...redis,
      useCommands: (fn) =>
        Effect.tryPromise({
          try: async () =>
            await fn({
              sendCommand: async <T>() => {
                // SAFETY: the fake supplies a malformed Redis wire reply to exercise decoding.
                return 'invalid' as T;
              },
            }),
          catch: (cause) => new RedisError({ cause, message: String(cause) }),
        }),
    };
    const outcome = await Effect.runPromise(
      Effect.exit(
        deliverDaemonUnlinks(
          db,
          invalid,
          () => Effect.die('invalid state must not retire the live owner'),
          {
            getDaemonPresence: () =>
              Effect.succeed({
                daemonId: 'daemon',
                userId: 'user',
                connectionId: 'connection',
                ownerInstanceId: 'replica',
                presenceId: 'presence',
                claimSeq: 1,
                state: 'online',
                updatedAt: 0,
                zone: null,
              }),
          },
          'daemon',
        ),
      ),
    );
    expect(Exit.isFailure(outcome)).toBe(true);
    if (!Exit.isFailure(outcome)) throw new Error('expected reset failure');
    expect(Cause.squash(outcome.cause)).toBeInstanceOf(RedisError);
  } finally {
    await db.destroy();
  }
});
