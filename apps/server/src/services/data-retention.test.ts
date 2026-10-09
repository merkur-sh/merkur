import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
import type { Logger } from '@merkur/logger';
import { DateTime, Effect } from 'effect';
import { type Kysely, sql } from 'kysely';

import { createMigratedKyselyDatabase } from '../db/migrate';
import type { DatabaseSchema } from '../db/types';
import { recordingMail, type SentMail } from './auth-service-fixture';
import { enforceDataRetention } from './data-retention';
import { infrastructureError } from './errors';

const NOW = DateTime.toEpochMillis(DateTime.makeUnsafe('2026-10-09T12:00:00Z'));
const YEAR_AGO = DateTime.toEpochMillis(DateTime.makeUnsafe('2025-10-09T12:00:00Z'));
const TWO_YEARS_AGO = DateTime.toEpochMillis(DateTime.makeUnsafe('2024-10-09T12:00:00Z'));
const DAY = 24 * 60 * 60 * 1_000;
const logger: Logger = { info() {}, warn() {}, error() {} };
let db: Kysely<DatabaseSchema>;
let sent: SentMail[];

beforeEach(async () => {
  db = await createMigratedKyselyDatabase<DatabaseSchema>(':memory:');
  sent = [];
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
});

afterEach(async () => {
  jest.useRealTimers();
  await db.destroy();
});

async function account(
  id: string,
  fields: {
    last_sign_in_at?: number;
    suspended_at?: number;
    inactivity_notice_sent_at?: number;
  } = {},
): Promise<void> {
  await db
    .insertInto('users')
    .values({
      id,
      username: `${id}@example.com`,
      opaque_registration_record: 'record',
      root_public_key: 'root',
      root_key_commitment: 'commitment',
      root_epoch: 1,
      root_envelope_nonce: 'nonce',
      root_envelope_ciphertext: 'ciphertext',
      created_at: TWO_YEARS_AGO,
      last_sign_in_at: YEAR_AGO,
      ...fields,
    })
    .execute();
}

const users = () => db.selectFrom('users').selectAll().orderBy('id').execute();
const sweep = () => Effect.runPromise(enforceDataRetention(db, recordingMail(sent), logger));

describe('database retention', () => {
  test('waitlist expires at 12 calendar months, including the millisecond boundary', async () => {
    await db
      .insertInto('box_waitlist')
      .values([
        { email: 'due@example.com', created_at: YEAR_AGO },
        { email: 'fresh@example.com', created_at: YEAR_AGO + 1 },
      ])
      .execute();
    await sweep();
    expect(await db.selectFrom('box_waitlist').select('email').execute()).toEqual([
      { email: 'fresh@example.com' },
    ]);
  });

  test('a leap year is retained for 12 calendar months rather than 365 days', async () => {
    const joined = DateTime.toEpochMillis(DateTime.makeUnsafe('2024-02-28T12:00:00Z'));
    jest.setSystemTime(joined + 365 * DAY);
    await db
      .insertInto('box_waitlist')
      .values({ email: 'leap@example.com', created_at: joined })
      .execute();
    await sweep();
    expect(await db.selectFrom('box_waitlist').select('email').execute()).toHaveLength(1);
    jest.setSystemTime(DateTime.toEpochMillis(DateTime.makeUnsafe('2025-02-28T12:00:00Z')));
    await sweep();
    expect(await db.selectFrom('box_waitlist').select('email').execute()).toHaveLength(0);
  });

  test('a confirmed notice buys 30 complete days; recent sign-ins receive no notice', async () => {
    await account('due');
    await account('fresh', { last_sign_in_at: YEAR_AGO + 1 });
    await sweep();
    expect(sent.map((mail) => mail.to)).toEqual(['due@example.com']);
    expect((await users()).find((user) => user.id === 'due')?.inactivity_notice_sent_at).toBe(NOW);
    await sweep();
    expect(sent).toHaveLength(1);
    jest.setSystemTime(NOW + 30 * DAY - 1);
    await sweep();
    expect((await users()).map((user) => user.id)).toContain('due');
    jest.setSystemTime(NOW + 30 * DAY);
    await sweep();
    expect((await users()).map((user) => user.id)).not.toContain('due');
  });

  test('failed mail never starts a countdown and does not prevent suspended expiry', async () => {
    await account('inactive');
    await account('suspended', { suspended_at: TWO_YEARS_AGO });
    await account('recent-suspension', { suspended_at: TWO_YEARS_AGO + 1 });
    const mail = {
      ...recordingMail(sent),
      sendInactivityNotice: () =>
        Effect.fail(infrastructureError('mail', 'send')(new Error('down'))),
    };
    await Effect.runPromise(enforceDataRetention(db, mail, logger));
    expect((await users()).map((user) => user.id)).toEqual(['inactive', 'recent-suspension']);
    expect((await users())[0]?.inactivity_notice_sent_at).toBeNull();
    await sweep();
    expect(sent).toHaveLength(1);
  });

  test('a sign-in during delivery prevents a stale notice from scheduling deletion', async () => {
    await account('returning');
    const mail = {
      ...recordingMail(sent),
      sendInactivityNotice: () =>
        Effect.promise(async () => {
          await db.updateTable('users').set({ last_sign_in_at: NOW }).execute();
        }),
    };
    await Effect.runPromise(enforceDataRetention(db, mail, logger));
    expect((await users())[0]?.inactivity_notice_sent_at).toBeNull();
  });

  test('username mode never deletes for inactivity but still expires suspended accounts', async () => {
    await account('inactive', { inactivity_notice_sent_at: NOW - 30 * DAY });
    await account('suspended', { suspended_at: TWO_YEARS_AGO });
    await Effect.runPromise(enforceDataRetention(db, null, logger));
    expect((await users()).map((user) => user.id)).toEqual(['inactive']);
    expect(sent).toHaveLength(0);
  });

  test('account erasure and box removal commit together, with personal data cascaded', async () => {
    await account('expired', { suspended_at: TWO_YEARS_AGO });
    await db
      .insertInto('daemons')
      .values({
        id: 'box-daemon',
        user_id: 'expired',
        name: 'box',
        platform: 'linux',
        daemon_binding_json: 'binding',
        daemon_identity_public_key: 'identity',
        daemon_identity_p256_public_key: 'p256',
        identity_seal_backend: 'software',
        daemon_identity_key_commitment: 'commitment',
        box_id: 'owned-box',
      })
      .execute();
    await db
      .insertInto('push_subscriptions')
      .values({
        id: 'push',
        user_id: 'expired',
        endpoint: 'endpoint',
        p256dh: 'key',
        auth: 'auth',
      })
      .execute();
    await sql`CREATE TRIGGER reject_retention BEFORE DELETE ON users
      BEGIN SELECT RAISE(ABORT, 'injected deletion failure'); END`.execute(db);
    await expect(sweep()).rejects.toMatchObject({ operation: 'expire-accounts' });
    expect(await users()).toHaveLength(1);
    expect(await db.selectFrom('daemons').selectAll().execute()).toHaveLength(1);
    expect(await db.selectFrom('box_removals').selectAll().execute()).toEqual([]);
    await sql`DROP TRIGGER reject_retention`.execute(db);
    await sweep();
    expect(await users()).toEqual([]);
    expect(await db.selectFrom('daemons').selectAll().execute()).toEqual([]);
    expect(await db.selectFrom('push_subscriptions').selectAll().execute()).toEqual([]);
    expect(await db.selectFrom('box_removals').selectAll().execute()).toEqual([
      { box_id: 'owned-box', requested_at: NOW },
    ]);
  });
});
