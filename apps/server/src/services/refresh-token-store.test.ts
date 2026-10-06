import { beforeEach, describe, expect, test } from 'bun:test';
import { createRefreshToken, type RefreshTokenIssue, rotateRefreshToken } from '@merkur/auth';
import { Effect } from 'effect';
import type { Kysely } from 'kysely';

import { createMigratedKyselyDatabase } from '../db/migrate';
import { withDatabaseTransaction } from '../db/transaction';
import type { DatabaseSchema } from '../db/types';
import { createRefreshTokenStore } from './refresh-token-store';

const HMAC_SECRET = 'test-hmac-secret';
const DELEGATION_EXPIRES_AT = 4_000_000_000_000;

let db: Kysely<DatabaseSchema>;

async function insertUser(userId: string): Promise<void> {
  await db
    .insertInto('users')
    .values({
      id: userId,
      username: `${userId}@example.com`,
      opaque_registration_record: 'A'.repeat(256),
      root_public_key: 'A'.repeat(3_456),
      root_key_commitment: 'A'.repeat(86),
      root_epoch: 1,
      root_envelope_nonce: 'A'.repeat(16),
      root_envelope_ciphertext: 'A'.repeat(64),
      created_at: Date.now(),
    })
    .execute();
  await db
    .insertInto('browser_delegations')
    .values({
      id: `${userId}-delegation`,
      user_id: userId,
      root_epoch: 1,
      delegate_public_key: 'A'.repeat(3_456),
      certificate_json: '{}',
      issued_at: 1,
      expires_at: DELEGATION_EXPIRES_AT,
      revoked_at: null,
      client_browser: null,
      client_platform: null,
      client_installed: 0,
    })
    .execute();
}

async function issueStoredToken(userId: string): Promise<RefreshTokenIssue> {
  const issue = createRefreshToken(
    userId,
    `${userId}-delegation`,
    DELEGATION_EXPIRES_AT,
    HMAC_SECRET,
  );
  await createRefreshTokenStore(db).insert(issue.record);
  return issue;
}

/**
 * Mirrors `rotateRefreshTokenInTransaction` in auth-service.ts: the production
 * path always rotates inside a database transaction, so tests that care about
 * atomicity have to go through one too.
 */
function rotateInTransaction(issue: RefreshTokenIssue): Promise<unknown> {
  return Effect.runPromise(
    withDatabaseTransaction(db, (trx) =>
      Effect.promise(() =>
        rotateRefreshToken({
          store: createRefreshTokenStore(trx),
          refreshTokenId: issue.record.id,
          presentedToken: issue.token,
          hmacSecret: HMAC_SECRET,
        }),
      ),
    ) as Effect.Effect<unknown, never, never>,
  );
}

async function storedRowCount(): Promise<number> {
  const rows = await db.selectFrom('refresh_tokens').select('id').execute();
  return rows.length;
}

beforeEach(async () => {
  db = await createMigratedKyselyDatabase<DatabaseSchema>(':memory:');
});

describe('createRefreshTokenStore (Kysely/SQLite)', () => {
  test('insert then findById round-trips every field the rotation logic reads', async () => {
    await insertUser('user-1');
    const issue = await issueStoredToken('user-1');

    const found = await createRefreshTokenStore(db).findById(issue.record.id);

    // `rotatedAt` in particular must survive as null rather than undefined:
    // reuse detection branches on `!== null`, so a store that returned
    // undefined would classify a live token as already spent.
    expect(found).toEqual(issue.record);
    expect(found?.rotatedAt).toBeNull();
  });

  test('findById returns null for an unknown id', async () => {
    expect(await createRefreshTokenStore(db).findById('nope')).toBeNull();
  });

  test('markRotated persists the spent marker without deleting the row', async () => {
    await insertUser('user-1');
    const issue = await issueStoredToken('user-1');
    const store = createRefreshTokenStore(db);

    await store.markRotated(issue.record.id, 1_700_000_000_000);

    const found = await store.findById(issue.record.id);
    expect(found?.rotatedAt).toBe(1_700_000_000_000);
    expect(await storedRowCount()).toBe(1);
  });

  test('deleteByFamilyId removes the whole chain and leaves other families', async () => {
    await insertUser('user-1');
    const kept = await issueStoredToken('user-1');
    const doomed = await issueStoredToken('user-1');
    const store = createRefreshTokenStore(db);
    // Give the doomed family a second link so the delete has to match on
    // family rather than on id.
    const descendant = createRefreshToken(
      'user-1',
      'user-1-delegation',
      DELEGATION_EXPIRES_AT,
      HMAC_SECRET,
    );
    await store.insert({ ...descendant.record, familyId: doomed.record.familyId });

    await store.deleteByFamilyId(doomed.record.familyId);

    expect(await store.findById(doomed.record.id)).toBeNull();
    expect(await store.findById(descendant.record.id)).toBeNull();
    expect(await store.findById(kept.record.id)).not.toBeNull();
  });

  test('deleteById removes only the addressed row', async () => {
    await insertUser('user-1');
    const target = await issueStoredToken('user-1');
    const other = await issueStoredToken('user-1');

    await createRefreshTokenStore(db).deleteById(target.record.id);

    expect(await createRefreshTokenStore(db).findById(target.record.id)).toBeNull();
    expect(await createRefreshTokenStore(db).findById(other.record.id)).not.toBeNull();
  });
});

describe('refresh rotation against the real store', () => {
  test('rotating persists the spent original and its replacement', async () => {
    await insertUser('user-1');
    const issue = await issueStoredToken('user-1');

    const result = await rotateInTransaction(issue);

    expect(result).toMatchObject({ outcome: 'rotated' });
    const spent = await createRefreshTokenStore(db).findById(issue.record.id);
    expect(spent?.rotatedAt).not.toBeNull();
    expect(await storedRowCount()).toBe(2);
  });

  test('replaying a spent token revokes the family in SQL', async () => {
    await insertUser('user-1');
    const issue = await issueStoredToken('user-1');
    const survivor = await issueStoredToken('user-1');
    await rotateInTransaction(issue);

    const replay = await rotateInTransaction(issue);

    expect(replay).toMatchObject({ outcome: 'reuse-detected' });
    // Both links of the compromised family are gone; the unrelated login is not.
    expect(await createRefreshTokenStore(db).findById(issue.record.id)).toBeNull();
    expect(await createRefreshTokenStore(db).findById(survivor.record.id)).not.toBeNull();
    expect(await storedRowCount()).toBe(1);
  });

  test('concurrent rotations of one token never both succeed', async () => {
    await insertUser('user-1');
    const issue = await issueStoredToken('user-1');

    // `rotateRefreshToken` reads the record, checks `rotatedAt`, then writes —
    // a check-then-act that is only safe because both halves run inside one
    // serialized database transaction. This pins that guarantee: if rotation
    // ever moves outside a transaction, or onto a backend that lets two
    // transactions interleave reads, both callers would mint a live successor
    // from the same token and neither would be reported as reuse.
    const outcomes = await Promise.all([rotateInTransaction(issue), rotateInTransaction(issue)]);
    const observed = outcomes.map((outcome) => (outcome as { outcome: string }).outcome).sort();

    // There is no grace for a benign double-submit: clients must not present a
    // spent token, so the loser is reported as reuse and the family dies. The
    // browser prevents this reaching here at all by serializing refreshes
    // across tabs (see `refreshAccessToken` in apps/web/src/api.ts).
    expect(observed).toEqual(['reuse-detected', 'rotated']);
    expect(await storedRowCount()).toBe(0);
  });
});
