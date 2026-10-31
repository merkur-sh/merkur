import { randomUUID } from 'node:crypto';
import { Effect } from 'effect';
import type { Transaction } from 'kysely';
import type { DatabaseSchema } from '../db/types';
import {
  BROKER_BROADCAST_CHANNEL,
  revocationGenerationBroadcast,
} from './daemon-control-broadcast';
import { defineRedisScript } from './redis-script';
import { evalRedisScript, type RedisService } from './redis-service';

const RESET_REVOCATION_SCRIPT = defineRedisScript(
  'reset-session-revocation',
  `
local epoch = tonumber(ARGV[1])
local applied = tonumber(redis.call('GET', KEYS[2]) or '0')
if epoch > applied then
  redis.call('INCR', KEYS[1])
  redis.call('SET', KEYS[2], ARGV[1])
end
return tonumber(redis.call('GET', KEYS[1]) or '0')
`,
);

/** The reset transaction owns the intent and its monotonically increasing root epoch. */
export async function enqueueResetRevocation(
  db: Transaction<DatabaseSchema>,
  userId: string,
  rootEpoch: number,
): Promise<void> {
  await db
    .insertInto('notification_outbox')
    .values({
      id: randomUUID(),
      user_id: userId,
      kind: 'reset-revocation',
      payload: String(rootEpoch),
    })
    .execute();
}

export const deliverResetRevocation = Effect.fnUntraced(function* (
  redis: RedisService,
  userId: string,
  epoch: string,
) {
  const generation = yield* redis.useCommands((commands) =>
    evalRedisScript<number>(
      commands,
      RESET_REVOCATION_SCRIPT,
      [`merkur:auth:revocation:${userId}`, `merkur:auth:reset-revocation:${userId}`],
      [epoch],
    ),
  );
  yield* redis.publish(BROKER_BROADCAST_CHANNEL, revocationGenerationBroadcast(userId, generation));
});
