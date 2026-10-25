import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Effect, Result } from 'effect';
import type { Kysely } from 'kysely';

import { down, up } from '../../migrations/009_account_telemetry';
import { createMigratedKyselyDatabase } from '../db/migrate';
import type { DatabaseSchema } from '../db/types';
import {
  createAccountTelemetryService,
  publishAccountTelemetryChange,
  readAccountTelemetryConsent,
  subscribeAccountTelemetryChanges,
} from './account-telemetry-service';
import { InfrastructureError } from './errors';
import type { RedisService } from './redis-service';

let db: Kysely<DatabaseSchema>;

beforeEach(async () => {
  db = await createMigratedKyselyDatabase<DatabaseSchema>(':memory:');
  await insertUser(db, 'user-1');
  await insertUser(db, 'user-2');
});
afterEach(async () => {
  await db.destroy();
});

function fixture() {
  const signals: Array<{ userId: string; value: boolean | null; target: string }> = [];
  const observe = Effect.fn('test.observeTelemetry')(function* (userId: string, target: string) {
    const value = yield* readAccountTelemetryConsent(db, userId);
    signals.push({ userId, value, target });
  }, Effect.orDie);
  const redis: RedisService = {
    publish: (channel, payload) => {
      expect(channel).toBe('account:telemetry:user-1');
      expect(payload).toBe('');
      return observe('user-1', 'browser');
    },
    useCommands: () => Effect.die('unexpected commands'),
    subscribe: () => Effect.die('unexpected subscribe'),
    unsubscribe: () => Effect.die('unexpected unsubscribe'),
    healthSnapshot: () => Effect.die('unexpected healthSnapshot'),
  };
  const service = createAccountTelemetryService(
    db,
    {
      pushTelemetryChanged: (userId) => observe(userId, 'daemon'),
    },
    redis,
  );
  return { service, signals, redis };
}

describe('AccountTelemetryService', () => {
  test('the migration leaves existing and new accounts not chosen', async () => {
    await down(db);
    await up(db);
    await insertUser(db, 'user-3');
    for (const userId of ['user-1', 'user-2', 'user-3']) {
      expect(await Effect.runPromise(readAccountTelemetryConsent(db, userId))).toBeNull();
    }
  });

  test('a NULL row reads as not chosen', async () => {
    expect(await Effect.runPromise(fixture().service.read('user-1'))).toBeNull();
  });

  test('writes the account value before publishing both contentless signals', async () => {
    const { service, signals } = fixture();
    for (const enabled of [false, true]) {
      expect(await Effect.runPromise(service.write('user-1', enabled))).toBe(enabled);
      expect(await Effect.runPromise(service.read('user-1'))).toBe(enabled);
    }
    expect(signals).toEqual([
      { userId: 'user-1', value: false, target: 'daemon' },
      { userId: 'user-1', value: false, target: 'browser' },
      { userId: 'user-1', value: true, target: 'daemon' },
      { userId: 'user-1', value: true, target: 'browser' },
    ]);
    expect(await Effect.runPromise(service.read('user-2'))).toBeNull();
  });

  test('a missing account fails without publishing', async () => {
    const { service, signals } = fixture();
    const read = await Effect.runPromise(Effect.result(service.read('missing')));
    const write = await Effect.runPromise(Effect.result(service.write('missing', false)));
    expect(Result.isFailure(read)).toBe(true);
    expect(Result.isFailure(write)).toBe(true);
    if (Result.isFailure(read)) expect(read.failure).toBeInstanceOf(InfrastructureError);
    if (Result.isFailure(write)) expect(write.failure).toBeInstanceOf(InfrastructureError);
    expect(signals).toEqual([]);
  });
});

async function insertUser(database: Kysely<DatabaseSchema>, id: string): Promise<void> {
  await database
    .insertInto('users')
    .values({
      id,
      username: `${id}@merkur.test`,
      opaque_registration_record: 'record',
      root_public_key: 'root-public-key',
      root_key_commitment: 'root-key-commitment',
      root_epoch: 1,
      root_envelope_nonce: 'nonce',
      root_envelope_ciphertext: 'ciphertext',
      created_at: 0,
    })
    .execute();
}

test('telemetry subscriptions wake only their account and unsubscribe independently', async () => {
  const listeners = new Map<string, Set<(message: string) => void>>();
  const redis: RedisService = {
    ...fixture().redis,
    publish: (channel, payload) =>
      Effect.sync(() => {
        expect(payload).toBe('');
        for (const listener of listeners.get(channel) ?? []) listener(payload);
      }),
    subscribe: (channel, listener) =>
      Effect.sync(() => {
        const subscribed = listeners.get(channel) ?? new Set();
        subscribed.add(listener);
        listeners.set(channel, subscribed);
      }),
    unsubscribe: (channel, listener) =>
      Effect.sync(() => {
        if (listener !== undefined) listeners.get(channel)?.delete(listener);
      }),
  };
  const wakes = [0, 0, 0];
  await Effect.runPromise(
    Effect.gen(function* () {
      const releases: Effect.Effect<void>[] = [];
      for (const index of wakes.keys()) {
        releases.push(
          yield* subscribeAccountTelemetryChanges(redis, index === 2 ? 'other' : 'user-1', () => {
            wakes[index] = (wakes[index] ?? 0) + 1;
          }),
        );
      }
      expect([...listeners.keys()]).toEqual([
        'account:telemetry:user-1',
        'account:telemetry:other',
      ]);
      yield* publishAccountTelemetryChange(redis, 'user-1');
      expect(wakes).toEqual([1, 1, 0]);
      const first = releases[0];
      if (first === undefined) throw new Error('subscription missing');
      yield* first;
      yield* publishAccountTelemetryChange(redis, 'user-1');
      expect(wakes).toEqual([1, 2, 0]);
      yield* Effect.all(releases, { discard: true });
      yield* publishAccountTelemetryChange(redis, 'user-1');
      yield* publishAccountTelemetryChange(redis, 'other');
      expect(wakes).toEqual([1, 2, 0]);
    }),
  );
});
