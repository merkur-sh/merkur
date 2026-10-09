import { describe, expect, test } from 'bun:test';
import { BrowserSessionListResponse } from '@merkur/shared/api-schema';
import {
  createAccountDeletionStatement,
  createDelegationRevocationStatement,
  deriveUserAuthorizationSigningKey,
  encodeUserAuthorizationBytes,
} from '@merkur/shared/user-authorization';
import { Effect } from 'effect';
import { Value } from 'typebox/value';
import type { SignedRevocation } from './auth-service';
import {
  browser,
  db,
  loginWithNewDelegation,
  OLD_PASSWORD,
  ROOT,
  ROOT_KEY_COMMITMENT,
  registerAccount,
  service,
  useAuthServiceFixture,
} from './auth-service-fixture';

useAuthServiceFixture();

describe('account suspension', () => {
  test('a suspended account cannot sign in, and can again once restored', async () => {
    const actor = await registerAccount(OLD_PASSWORD, 0x22, 'current');
    await db
      .updateTable('users')
      .set({ suspended_at: Date.now() })
      .where('id', '=', actor.userId)
      .execute();

    // The password is still correct; the account is simply not usable.
    expect(loginWithNewDelegation(OLD_PASSWORD, 0x25, 'while-suspended')).rejects.toThrow();

    await db
      .updateTable('users')
      .set({ suspended_at: null })
      .where('id', '=', actor.userId)
      .execute();
    const restored = await loginWithNewDelegation(OLD_PASSWORD, 0x26, 'after-restore');
    expect(restored.session.userId).toBe(actor.userId);
  });

  // Suspending is a database write with no revocation step, so the delegation
  // the account already holds must stop working on the next request by itself.
  test('suspending in the database refuses the delegation the account already holds', async () => {
    const actor = await registerAccount(OLD_PASSWORD, 0x27, 'held-while-suspended');
    const setSuspended = (suspendedAt: number | null) =>
      db
        .updateTable('users')
        .set({ suspended_at: suspendedAt })
        .where('id', '=', actor.userId)
        .execute();

    await setSuspended(Date.now());

    expect(
      await Effect.runPromise(service.verifyBearerToken(actor.session.accessToken)),
    ).toBeNull();
    expect(
      await Effect.runPromise(
        service.requireActiveDelegation(actor.userId, actor.certificate.delegationId),
      ),
    ).toBeNull();

    await setSuspended(null);
    expect(
      await Effect.runPromise(service.verifyBearerToken(actor.session.accessToken)),
    ).not.toBeNull();
  });
});

describe('account deletion', () => {
  function deletionStatement(
    actor: Awaited<ReturnType<typeof registerAccount>>,
    overrides: { issuedAt?: number; rootEpoch?: number } = {},
  ) {
    return createAccountDeletionStatement(
      {
        userId: actor.userId,
        rootKeyCommitment: ROOT_KEY_COMMITMENT,
        rootEpoch: overrides.rootEpoch ?? 1,
        issuedAt: overrides.issuedAt ?? Date.now(),
        nonce: encodeUserAuthorizationBytes(new Uint8Array(32).fill(0x66)),
      },
      ROOT,
    );
  }

  /** What the browser signs alongside the request: every active delegation, its own included. */
  async function everyDelegation(
    actor: Awaited<ReturnType<typeof registerAccount>>,
    keep: (delegationId: string) => boolean = () => true,
  ): Promise<SignedRevocation> {
    const list = await Effect.runPromise(service.listBrowserSessions(browser(actor)));
    // The list is the route's response as it stands; the browser holds it to this schema.
    expect(Value.Check(BrowserSessionListResponse, list)).toBe(true);
    const targets = list.sessions
      .filter((s) => s.revokedAt === null && s.expiresAt > list.serverTimeMs)
      .filter((s) => keep(s.delegationId))
      .map(({ delegationId, expiresAt }) => ({ delegationId, expiresAt }))
      .sort((a, b) => (a.delegationId < b.delegationId ? -1 : 1));
    return {
      actorCertificate: actor.certificate,
      revocation: createDelegationRevocationStatement(
        {
          userId: actor.userId,
          rootKeyCommitment: ROOT_KEY_COMMITMENT,
          actorDelegationId: actor.certificate.delegationId,
          targets,
          issuedAt: list.serverTimeMs,
          nonce: encodeUserAuthorizationBytes(crypto.getRandomValues(new Uint8Array(32))),
        },
        actor.delegate,
      ),
    };
  }

  test('schedules the purge, puts the account to sleep, and keeps it signable-in', async () => {
    const actor = await registerAccount(OLD_PASSWORD, 0x22, 'current');
    const before = Date.now();

    const scheduledFor = await Effect.runPromise(
      service.scheduleAccountDeletion(
        browser(actor),
        deletionStatement(actor),
        await everyDelegation(actor),
      ),
    );

    // Seven days out, not now: the wait is what makes it recoverable.
    expect(scheduledFor).toBeGreaterThanOrEqual(before + 7 * 24 * 60 * 60 * 1_000);
    const stored = await db
      .selectFrom('users')
      .select('deletion_scheduled_at')
      .where('id', '=', actor.userId)
      .executeTakeFirstOrThrow();
    expect(stored.deletion_scheduled_at).toBe(scheduledFor);

    // Dormant: every delegation revoked and no refresh token left to rotate,
    // so the only way back in is a password sign-in.
    const live = await db
      .selectFrom('browser_delegations')
      .select('id')
      .where('user_id', '=', actor.userId)
      .where('revoked_at', 'is', null)
      .execute();
    expect(live).toEqual([]);
    const refresh = await db
      .selectFrom('refresh_tokens')
      .select('token_hash')
      .where('user_id', '=', actor.userId)
      .execute();
    expect(refresh).toEqual([]);

    // The account row itself survives, or there would be nothing to sign in to.
    const user = await db
      .selectFrom('users')
      .select('id')
      .where('id', '=', actor.userId)
      .executeTakeFirst();
    expect(user?.id).toBe(actor.userId);
  });

  test('signing in calls the deletion off and says so', async () => {
    const actor = await registerAccount(OLD_PASSWORD, 0x22, 'current');
    const issued = await db
      .selectFrom('users')
      .select('last_sign_in_at')
      .where('id', '=', actor.userId)
      .executeTakeFirstOrThrow();
    expect(issued.last_sign_in_at).toBe(actor.session.serverTimeMs);
    await Effect.runPromise(
      service.scheduleAccountDeletion(
        browser(actor),
        deletionStatement(actor),
        await everyDelegation(actor),
      ),
    );

    await db
      .updateTable('users')
      .set({ inactivity_notice_sent_at: Date.now() })
      .where('id', '=', actor.userId)
      .execute();
    const session = await loginWithNewDelegation(OLD_PASSWORD, 0x24, 'returned');

    expect(session.session.deletionCancelled).toBe(true);
    const stored = await db
      .selectFrom('users')
      .select(['deletion_scheduled_at', 'last_sign_in_at', 'inactivity_notice_sent_at'])
      .where('id', '=', actor.userId)
      .executeTakeFirstOrThrow();
    expect(stored.deletion_scheduled_at).toBeNull();
    expect(stored.inactivity_notice_sent_at).toBeNull();
    expect(stored.last_sign_in_at).toBe(session.session.serverTimeMs);
    expect(await Effect.runPromise(service.accountsDueForDeletion())).toEqual([]);
  });

  test('refuses a request that the root key did not sign for this account now', async () => {
    const actor = await registerAccount(OLD_PASSWORD, 0x22, 'current');
    const other = deriveUserAuthorizationSigningKey(new Uint8Array(32).fill(0x77));

    const cases = [
      // Signed by something that is not the account's root key.
      createAccountDeletionStatement(
        {
          userId: actor.userId,
          rootKeyCommitment: ROOT_KEY_COMMITMENT,
          rootEpoch: 1,
          issuedAt: Date.now(),
          nonce: encodeUserAuthorizationBytes(new Uint8Array(32).fill(0x66)),
        },
        other,
      ),
      // Naming a different account than the one signing in.
      deletionStatement({ ...actor, userId: 'someone-else' }),
      // Held over a root rotation.
      deletionStatement(actor, { rootEpoch: 2 }),
      // Stale: replayed long after it was signed.
      deletionStatement(actor, { issuedAt: Date.now() - 10 * 60 * 1_000 }),
    ];

    for (const statement of cases) {
      const exit = await Effect.runPromiseExit(
        service.scheduleAccountDeletion(browser(actor), statement, await everyDelegation(actor)),
      );
      expect(exit._tag).toBe('Failure');
    }
    const stored = await db
      .selectFrom('users')
      .select('deletion_scheduled_at')
      .where('id', '=', actor.userId)
      .executeTakeFirstOrThrow();
    expect(stored.deletion_scheduled_at).toBeNull();
  });

  test('records a revocation the daemons can act on, and refuses one that spares a delegation', async () => {
    const actor = await registerAccount(OLD_PASSWORD, 0x22, 'current');
    await loginWithNewDelegation(OLD_PASSWORD, 0x24, 'second');
    await db
      .insertInto('daemons')
      .values({
        id: 'serving-daemon',
        user_id: actor.userId,
        name: 'machine',
        platform: 'test',
        daemon_binding_json: 'binding',
        daemon_identity_public_key: 'identity',
        daemon_identity_p256_public_key: 'identity-p256',
        identity_seal_backend: 'software',
        daemon_identity_key_commitment: 'commitment',
      })
      .execute();
    const scheduled = () =>
      db
        .selectFrom('users')
        .select('deletion_scheduled_at')
        .where('id', '=', actor.userId)
        .executeTakeFirstOrThrow();
    const outbox = () =>
      db
        .selectFrom('delegation_revocation_outbox')
        .select(['daemon_id', 'revocation_json'])
        .where('user_id', '=', actor.userId)
        .execute();

    // Sparing this browser's own delegation would leave it serving: refused,
    // and nothing is scheduled or revoked.
    const spared = await Effect.runPromiseExit(
      service.scheduleAccountDeletion(
        browser(actor),
        deletionStatement(actor),
        await everyDelegation(actor, (id) => id !== actor.certificate.delegationId),
      ),
    );
    expect(spared._tag).toBe('Failure');
    expect((await scheduled()).deletion_scheduled_at).toBeNull();
    expect(await outbox()).toEqual([]);

    await Effect.runPromise(
      service.scheduleAccountDeletion(
        browser(actor),
        deletionStatement(actor),
        await everyDelegation(actor),
      ),
    );
    expect((await scheduled()).deletion_scheduled_at).not.toBeNull();
    const queued = await outbox();
    expect(queued.map((row) => row.daemon_id)).toEqual(['serving-daemon']);
    const revocation: unknown = JSON.parse(queued[0]?.revocation_json ?? 'null');
    expect(revocation).toMatchObject({
      actorDelegationId: 'current',
      targets: [{ delegationId: 'current' }, { delegationId: 'second' }],
    });
  });

  test('reports only accounts past their deadline, and purging cascades', async () => {
    const actor = await registerAccount(OLD_PASSWORD, 0x22, 'current');
    await db
      .insertInto('daemons')
      .values({
        id: 'doomed-daemon',
        user_id: actor.userId,
        name: 'machine',
        platform: 'test',
        daemon_binding_json: 'binding',
        daemon_identity_public_key: 'identity',
        daemon_identity_p256_public_key: 'identity-p256',
        identity_seal_backend: 'software',
        daemon_identity_key_commitment: 'commitment',
      })
      .execute();
    await db
      .insertInto('box_access')
      .values({ user_id: actor.userId, status: 'approved', requested_at: 1, decided_at: 2 })
      .execute();

    await Effect.runPromise(
      service.scheduleAccountDeletion(
        browser(actor),
        deletionStatement(actor),
        await everyDelegation(actor),
      ),
    );
    // Still inside the grace period.
    expect(await Effect.runPromise(service.accountsDueForDeletion())).toEqual([]);

    await db
      .updateTable('users')
      .set({ deletion_scheduled_at: Date.now() - 1 })
      .where('id', '=', actor.userId)
      .execute();
    expect(await Effect.runPromise(service.accountsDueForDeletion())).toEqual([actor.userId]);

    await Effect.runPromise(service.purgeAccount(actor.userId));

    // One delete, and SQLite takes the rest: nothing here lists the tables, so
    // a table added later cannot be forgotten by this sweep.
    for (const table of ['users', 'daemons', 'box_access', 'browser_delegations'] as const) {
      const rows = await db
        .selectFrom(table)
        .selectAll()
        .where(table === 'users' ? 'id' : 'user_id', '=', actor.userId)
        .execute();
      expect(rows).toEqual([]);
    }
  });
});
