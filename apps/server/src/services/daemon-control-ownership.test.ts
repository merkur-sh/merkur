import { expect, test } from 'bun:test';
import { Effect } from 'effect';
import { createMigratedKyselyDatabase } from '../db/migrate';
import type { DatabaseSchema } from '../db/types';
import { deliverDaemonUnlinks } from './daemon-control-ownership';
import type { RedisService } from './redis-service';

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
      ),
    );
    expect(retired).toBe(true);
    expect(await db.selectFrom('daemon_unlinks').selectAll().execute()).toEqual([]);
  } finally {
    await db.destroy();
  }
});
