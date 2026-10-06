import { beforeEach, describe, expect, test } from 'bun:test';
import { Cause, Effect, Exit, Option } from 'effect';
import type { Kysely } from 'kysely';

import { createMigratedKyselyDatabase } from '../db/migrate';
import type { DatabaseSchema } from '../db/types';
import { BoxWaitlistError, createBoxWaitlistService } from './box-waitlist-service';
import type { MailResolver } from './email-admission';
import { InfrastructureError } from './errors';

/** Answers for a domain that names a mail exchanger. */
const TAKES_MAIL: MailResolver = {
  resolveMx: async () => [{ exchange: 'mx.example.net' }],
  resolve4: async () => [],
  resolve6: async () => [],
};

let db: Kysely<DatabaseSchema>;

beforeEach(async () => {
  db = await createMigratedKyselyDatabase<DatabaseSchema>(':memory:');
});

describe('BoxWaitlistService', () => {
  test('records a new address with the time it joined', async () => {
    const service = createBoxWaitlistService(db, TAKES_MAIL);
    const before = Date.now();

    expect(await Effect.runPromise(service.record('person@example.com'))).toEqual({
      inserted: true,
    });

    const rows = await db.selectFrom('box_waitlist').selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.email).toBe('person@example.com');
    expect(rows[0]?.created_at).toBeGreaterThanOrEqual(before);
  });

  test('a second join of the same address inserts nothing and keeps its first time', async () => {
    const service = createBoxWaitlistService(db, TAKES_MAIL);
    await Effect.runPromise(service.record('person@example.com'));
    await db.updateTable('box_waitlist').set({ created_at: 1 }).execute();

    expect(await Effect.runPromise(service.record('person@example.com'))).toEqual({
      inserted: false,
    });

    expect(await db.selectFrom('box_waitlist').selectAll().execute()).toEqual([
      { email: 'person@example.com', created_at: 1 },
    ]);
  });

  test('stores the one spelling sign-up uses, so case and spacing are the same address', async () => {
    const service = createBoxWaitlistService(db, TAKES_MAIL);

    expect(await Effect.runPromise(service.record('  Person@Example.COM '))).toEqual({
      inserted: true,
    });
    expect(await Effect.runPromise(service.record('person@example.com'))).toEqual({
      inserted: false,
    });

    expect(await db.selectFrom('box_waitlist').select('email').execute()).toEqual([
      { email: 'person@example.com' },
    ]);
  });

  test('keeps subaddresses distinct, as account names do', async () => {
    const service = createBoxWaitlistService(db, TAKES_MAIL);

    await Effect.runPromise(service.record('person@example.com'));
    expect(await Effect.runPromise(service.record('person+boxes@example.com'))).toEqual({
      inserted: true,
    });
  });

  test('refuses a value that is not an address', async () => {
    const service = createBoxWaitlistService(db, TAKES_MAIL);

    for (const value of ['not-an-address', 'a@b', 'two@@example.com', 'x@example.c0m']) {
      expect(errorCode(await Effect.runPromiseExit(service.record(value)))).toBe('email_invalid');
    }
    expect(await db.selectFrom('box_waitlist').selectAll().execute()).toHaveLength(0);
  });

  test('refuses a disposable domain and any subdomain of one', async () => {
    const service = createBoxWaitlistService(db, TAKES_MAIL);

    for (const value of ['someone@mailinator.com', 'someone@inbox.mailinator.com']) {
      expect(errorCode(await Effect.runPromiseExit(service.record(value)))).toBe('email_refused');
    }
    expect(await db.selectFrom('box_waitlist').selectAll().execute()).toHaveLength(0);
  });

  test("refuses an address that reaches a suspended account's mailbox", async () => {
    const service = createBoxWaitlistService(db, TAKES_MAIL);
    await insertUser(db, 'first.last+merkur@gmail.com', 1);

    expect(errorCode(await Effect.runPromiseExit(service.record('firstlast@googlemail.com')))).toBe(
      'email_refused',
    );
    expect(await db.selectFrom('box_waitlist').selectAll().execute()).toHaveLength(0);
  });

  test('refuses an address whose domain takes no mail', async () => {
    const service = createBoxWaitlistService(db, { ...TAKES_MAIL, resolveMx: async () => [] });

    expect(errorCode(await Effect.runPromiseExit(service.record('person@example.com')))).toBe(
      'email_refused',
    );
    expect(await db.selectFrom('box_waitlist').selectAll().execute()).toHaveLength(0);
  });

  test('asks the resolver nothing about an address it refuses on its own', async () => {
    let asked = 0;
    const service = createBoxWaitlistService(db, {
      ...TAKES_MAIL,
      resolveMx: (name) => {
        asked += 1;
        return TAKES_MAIL.resolveMx(name);
      },
    });
    await insertUser(db, 'banned@example.com', 1);

    for (const value of ['not-an-address', 'someone@mailinator.com', 'banned@example.com']) {
      await Effect.runPromiseExit(service.record(value));
    }

    expect(asked).toBe(0);
  });

  test('stores nothing when the resolver gives no answer, and fails without a verdict', async () => {
    const service = createBoxWaitlistService(db, {
      ...TAKES_MAIL,
      resolveMx: async (name) => {
        throw Object.assign(new Error(`queryMx ETIMEOUT ${name}`), { code: 'ETIMEOUT' });
      },
    });

    const exit = await Effect.runPromiseExit(service.record('person@example.com'));

    const error = Exit.isSuccess(exit) ? null : Option.getOrNull(Cause.findErrorOption(exit.cause));
    expect(error).toBeInstanceOf(InfrastructureError);
    expect(error).toMatchObject({ service: 'box-waitlist', operation: 'resolve-mail-domain' });
    expect(await db.selectFrom('box_waitlist').selectAll().execute()).toHaveLength(0);
  });

  test('takes the address of an account that is not suspended', async () => {
    const service = createBoxWaitlistService(db, TAKES_MAIL);
    await insertUser(db, 'person@example.com', null);

    expect(await Effect.runPromise(service.record('person@example.com'))).toEqual({
      inserted: true,
    });
  });
});

function errorCode(exit: Exit.Exit<unknown, unknown>): string | null {
  if (Exit.isSuccess(exit)) return null;
  const error = Option.getOrNull(Cause.findErrorOption(exit.cause));
  return error instanceof BoxWaitlistError ? error.code : null;
}

async function insertUser(
  database: Kysely<DatabaseSchema>,
  username: string,
  suspendedAt: number | null,
): Promise<void> {
  await database
    .insertInto('users')
    .values({
      id: 'user-1',
      username,
      opaque_registration_record: 'record',
      root_public_key: 'root-public-key',
      root_key_commitment: 'root-key-commitment',
      root_epoch: 1,
      root_envelope_nonce: 'nonce',
      root_envelope_ciphertext: 'ciphertext',
      created_at: 0,
      suspended_at: suspendedAt,
    })
    .execute();
}
