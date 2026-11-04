import { beforeEach, describe, expect, test } from 'bun:test';
import type { Logger } from '@merkur/logger';
import { Effect } from 'effect';
import type { Kysely } from 'kysely';

import { DatabaseService } from '../db/client';
import { createMigratedKyselyDatabase } from '../db/migrate';
import { withDatabaseTransaction } from '../db/transaction';
import type { DatabaseSchema } from '../db/types';
import { BoxHostError, type BoxHostService, BoxHostServiceTag } from './box-host-service';
import {
  BoxNameHeldError,
  drainBoxRemovalsEffect,
  queueBoxRemovals,
  requireBoxNameFree,
} from './box-removal';

let db: Kysely<DatabaseSchema>;

beforeEach(async () => {
  db = await createMigratedKyselyDatabase<DatabaseSchema>(':memory:');
});

function queue(boxIds: readonly string[], now: number): Promise<void> {
  return Effect.runPromise(
    withDatabaseTransaction(db, (trx) => Effect.promise(() => queueBoxRemovals(trx, boxIds, now))),
  );
}

function pending(): Promise<string[]> {
  return db
    .selectFrom('box_removals')
    .select('box_id')
    .orderBy('requested_at', 'asc')
    .execute()
    .then((rows) => rows.map((row) => row.box_id));
}

async function drain(refuse: ReadonlySet<string> = new Set()) {
  const removed: string[] = [];
  const logs: string[] = [];
  const push = (message: string): void => {
    logs.push(message);
  };
  const logger: Logger = { info: push, warn: push, error: push };
  const boxHost: BoxHostService = {
    createLinked: () => Effect.die(new Error('unexpected createLinked')),
    start: () => Effect.die(new Error('unexpected start')),
    remove: (boxId) =>
      refuse.has(boxId)
        ? Effect.fail(new BoxHostError({ operation: 'remove', message: 'down', status: 502 }))
        : Effect.sync(() => void removed.push(boxId)),
  };
  await Effect.runPromise(
    drainBoxRemovalsEffect(logger).pipe(
      Effect.provideService(DatabaseService, db),
      Effect.provideService(BoxHostServiceTag, boxHost),
    ),
  );
  return { removed, logs };
}

describe('box removal queue', () => {
  test('an empty queue never asks the host', async () => {
    expect(await drain()).toEqual({ removed: [], logs: [] });
  });

  test('queued boxes are destroyed oldest first and leave the queue once the host confirms', async () => {
    await queue(['box-b'], 2);
    await queue(['box-a'], 1);
    // Queued again by a second reset: one row, its first request time.
    await queue(['box-b'], 3);

    const { removed } = await drain();

    expect(removed).toEqual(['box-a', 'box-b']);
    expect(await pending()).toEqual([]);
  });

  test('a box the host refuses stays queued and does not hold up the rest', async () => {
    await queue(['box-down', 'box-a'], 1);

    const first = await drain(new Set(['box-down']));
    expect(first.removed).toEqual(['box-a']);
    expect(first.logs).toContain('box_removal_failed');
    expect(await pending()).toEqual(['box-down']);

    // The host is back: the next pass finishes the job.
    expect((await drain()).removed).toEqual(['box-down']);
    expect(await pending()).toEqual([]);
  });

  test('a name is refused to a new box only while its removal is owed', async () => {
    await queue(['box-a'], 1);
    await expect(checkName('box-a')).rejects.toMatchObject({
      _tag: 'BoxRemovalPendingError',
      boxId: 'box-a',
    });
    await expect(checkName('box-other')).resolves.toBeUndefined();
    await drain();
    await expect(checkName('box-a')).resolves.toBeUndefined();
  });

  test('a name any device row still carries is refused to a new box', async () => {
    await db
      .insertInto('users')
      .values({
        id: 'user-1',
        username: 'box-owner',
        opaque_registration_record: 'A'.repeat(256),
        root_public_key: 'A'.repeat(3456),
        root_key_commitment: 'A'.repeat(86),
        root_epoch: 1,
        root_envelope_nonce: 'A'.repeat(16),
        root_envelope_ciphertext: 'A'.repeat(64),
        created_at: 1,
      })
      .execute();
    await db
      .insertInto('daemons')
      .values({
        id: 'daemon-stale',
        user_id: 'user-1',
        name: 'Stale',
        platform: 'linux',
        daemon_identity_public_key: 'key',
        daemon_identity_p256_public_key: 'p256',
        identity_seal_backend: 'software',
        daemon_identity_key_commitment: 'commitment',
        daemon_binding_json: '{}',
        last_seen: 1,
        version: null,
        box_id: 'box-a',
      })
      .execute();

    await expect(checkName('box-a')).rejects.toEqual(new BoxNameHeldError({ boxId: 'box-a' }));
    await db.deleteFrom('daemons').execute();
    await expect(checkName('box-a')).resolves.toBeUndefined();
  });
});

function checkName(boxId: string): Promise<void> {
  return Effect.runPromise(
    requireBoxNameFree(boxId).pipe(Effect.provideService(DatabaseService, db)),
  );
}
