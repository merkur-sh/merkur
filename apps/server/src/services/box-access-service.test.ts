import { beforeEach, describe, expect, test } from 'bun:test';
import { Cause, Effect, Exit, Option } from 'effect';
import type { Kysely } from 'kysely';

import { createMigratedKyselyDatabase } from '../db/migrate';
import type { DatabaseSchema } from '../db/types';
import { BoxAccessError, createBoxAccessService } from './box-access-service';

let db: Kysely<DatabaseSchema>;

beforeEach(async () => {
  db = await createMigratedKyselyDatabase<DatabaseSchema>(':memory:');
  await insertUser(db, 'user-1', 'alice');
});

describe('BoxAccessService', () => {
  test('an account that never asked has no access', async () => {
    const service = createBoxAccessService(db);

    expect(await Effect.runPromise(service.access('user-1'))).toEqual({ status: 'none' });
  });

  test('joining puts the account on the waitlist, and joining again keeps its place', async () => {
    const service = createBoxAccessService(db);

    expect(await Effect.runPromise(service.join('user-1'))).toEqual({ status: 'waitlisted' });
    const first = await db
      .selectFrom('box_access')
      .select('requested_at')
      .where('user_id', '=', 'user-1')
      .executeTakeFirstOrThrow();

    await Effect.runPromise(service.join('user-1'));

    const rows = await db.selectFrom('box_access').selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.requested_at).toBe(first.requested_at);
  });

  test('box creation is refused until the row is approved, then allowed', async () => {
    const service = createBoxAccessService(db);

    const refused = await Effect.runPromiseExit(service.requireApproved('user-1'));
    expect(errorCode(refused)).toBe('box_access_required');

    await Effect.runPromise(service.join('user-1'));
    expect(errorCode(await Effect.runPromiseExit(service.requireApproved('user-1')))).toBe(
      'box_access_required',
    );

    await setStatus(db, 'user-1', 'approved');
    expect(await Effect.runPromise(service.access('user-1'))).toEqual({ status: 'approved' });
    expect(Exit.isSuccess(await Effect.runPromiseExit(service.requireApproved('user-1')))).toBe(
      true,
    );
  });

  // Joining after approval must not quietly send an approved account back to
  // the queue — the dialog calls join from any state it is shown in.
  test('an approved account stays approved when it joins again', async () => {
    const service = createBoxAccessService(db);
    await Effect.runPromise(service.join('user-1'));
    await setStatus(db, 'user-1', 'approved');

    expect((await Effect.runPromise(service.join('user-1'))).status).toBe('approved');
  });

  test('returning the row to waiting refuses new boxes', async () => {
    const service = createBoxAccessService(db);
    await Effect.runPromise(service.join('user-1'));
    await setStatus(db, 'user-1', 'approved');

    await setStatus(db, 'user-1', 'waitlisted');

    expect(errorCode(await Effect.runPromiseExit(service.requireApproved('user-1')))).toBe(
      'box_access_required',
    );
  });

  test('a privileged account is approved without a waitlist row, whatever a row says', async () => {
    const service = createBoxAccessService(db);
    await db.updateTable('users').set({ privileged_at: 1 }).where('id', '=', 'user-1').execute();

    expect(await Effect.runPromise(service.access('user-1'))).toEqual({ status: 'approved' });
    expect(Exit.isSuccess(await Effect.runPromiseExit(service.requireApproved('user-1')))).toBe(
      true,
    );
    await Effect.runPromise(service.join('user-1'));
    await setStatus(db, 'user-1', 'waitlisted');
    expect(await Effect.runPromise(service.access('user-1'))).toEqual({ status: 'approved' });
  });

  test('deleting the account takes its waitlist entry with it', async () => {
    const service = createBoxAccessService(db);
    await Effect.runPromise(service.join('user-1'));

    await db.deleteFrom('users').where('id', '=', 'user-1').execute();

    expect(await db.selectFrom('box_access').selectAll().execute()).toHaveLength(0);
  });
});

/** The operator's decision: a direct update of the row, as done against the database. */
async function setStatus(
  database: Kysely<DatabaseSchema>,
  userId: string,
  status: 'waitlisted' | 'approved',
): Promise<void> {
  await database
    .updateTable('box_access')
    .set({ status, decided_at: Date.now() })
    .where('user_id', '=', userId)
    .execute();
}

function errorCode(exit: Exit.Exit<unknown, unknown>): string | null {
  if (Exit.isSuccess(exit)) return null;
  const error = Option.getOrNull(Cause.findErrorOption(exit.cause));
  return error instanceof BoxAccessError ? error.code : null;
}

async function insertUser(
  database: Kysely<DatabaseSchema>,
  id: string,
  username: string,
): Promise<void> {
  await database
    .insertInto('users')
    .values({
      id,
      username,
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
