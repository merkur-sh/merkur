import { describe, expect, spyOn, test } from 'bun:test';
import { createOpaqueServerSetup } from '@merkur/auth';
import { OPAQUE_PASSWORD_STRETCHING } from '@merkur/shared/opaque-password-policy';
import {
  createDelegationRevocationStatement,
  encodeUserAuthorizationBytes,
} from '@merkur/shared/user-authorization';
import * as opaque from '@serenity-kit/opaque';
import { Effect } from 'effect';
import { SqliteQueryCompiler } from 'kysely';
import {
  activeDelegationQuery,
  compileActiveDelegationQuery,
  createAuthService,
} from './auth-service';
import {
  createFakeRedis,
  db,
  finishClientLogin,
  finishRegistration,
  loginWithNewDelegation,
  OLD_PASSWORD,
  ORIGIN,
  published,
  ROOT_KEY_COMMITMENT,
  ROOT_PUBLIC_KEY,
  registerAccount,
  service,
  setService,
  startClientAndServerAuth,
  startClientAndServerLogin,
  TEST_CLIENT,
  USERNAME,
  useAuthServiceFixture,
} from './auth-service-fixture';
import { deliverPendingNotifications } from './notification-outbox-service';

useAuthServiceFixture();

describe('AuthService user-root OPAQUE flows', () => {
  test('reports a normalized invalid username as a typed request failure', async () => {
    await expect(
      Effect.runPromise(service.startAuth('   ', 'A'.repeat(128), 'A'.repeat(43))),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });

  test('returns one fixed-shape flow with stable synthetic account material', async () => {
    const first = await startClientAndServerAuth(OLD_PASSWORD);
    const second = await startClientAndServerAuth(OLD_PASSWORD);

    expect(first.server.login.flowId).toBe(first.server.registration.flowId);
    expect(first.server.login.userId).toBe(first.server.registration.userId);
    expect(first.server.login.delegationIssuedAt).toBe(
      first.server.registration.delegationIssuedAt,
    );
    expect(first.server.login.delegationExpiresAt).toBe(
      first.server.registration.delegationExpiresAt,
    );
    expect(second.server.login.flowId).not.toBe(first.server.login.flowId);
    expect(second.server.login.userId).toBe(first.server.login.userId);
    expect(second.server.login.rootPublicKey).toBe(first.server.login.rootPublicKey);
    expect(second.server.login.rootEnvelope).toEqual(first.server.login.rootEnvelope);
    expect(first.server.login.userId).toHaveLength(21);
    expect(first.server.login.rootPublicKey).toHaveLength(3_456);
    expect(first.server.login.rootEnvelope.nonce).toHaveLength(16);
    expect(first.server.login.rootEnvelope.ciphertext).toHaveLength(64);
  });

  test('atomically consumes the combined flow across registration and login finishes', async () => {
    const started = await startClientAndServerAuth(OLD_PASSWORD);
    const registered = await finishRegistration(started, 0x22, 'delegation-one-use');

    await expect(
      Effect.runPromise(
        service.finishLogin({
          flowId: started.server.login.flowId,
          finishLoginRequest: 'A'.repeat(86),
          delegationCertificate: registered.certificate,
          client: TEST_CLIENT,
        }),
      ),
    ).rejects.toMatchObject({ code: 'invalid_flow' });
  });

  test('normalizes a registration uniqueness race to invalid credentials', async () => {
    const first = await startClientAndServerAuth(OLD_PASSWORD);
    const second = await startClientAndServerAuth(OLD_PASSWORD);
    await finishRegistration(first, 0x22, 'delegation-race-winner');

    await expect(finishRegistration(second, 0x23, 'delegation-race-loser')).rejects.toMatchObject({
      code: 'invalid_credentials',
    });
  });

  test('consumes but rejects the registration branch when registration is disabled', async () => {
    setService(
      createAuthService(
        db,
        createFakeRedis(),
        {
          accessToken: {
            hmacKey: new Uint8Array(64).fill(0x44),
            issuer: 'merkur-test',
            audience: 'merkur-test',
          },
          tokenHmacSecret: 'test-token-hmac-secret',
          allowRegistration: false,
          identity: { kind: 'username' },
          opaqueServerSetup: await createOpaqueServerSetup(),
          publicOrigin: ORIGIN,
        },
        deliverPendingNotifications(db, createFakeRedis()).pipe(Effect.orDie),
      ),
    );
    const started = await startClientAndServerAuth(OLD_PASSWORD);

    await expect(finishRegistration(started, 0x22, 'delegation-disabled')).rejects.toMatchObject({
      code: 'registration_closed',
    });
  });

  // The browser reaches the registration finish after a wrong password on an
  // existing account as well as for a new username, so with sign-up closed the
  // two must be indistinguishable or the error enumerates usernames.
  test('a closed sign-up answers an existing username exactly as a new one', async () => {
    const opaqueServerSetup = await createOpaqueServerSetup();
    const config = {
      accessToken: {
        hmacKey: new Uint8Array(64).fill(0x44),
        issuer: 'merkur-test',
        audience: 'merkur-test',
      },
      tokenHmacSecret: 'test-token-hmac-secret',
      identity: { kind: 'username' },
      opaqueServerSetup,
      publicOrigin: ORIGIN,
    } as const;
    setService(
      createAuthService(
        db,
        createFakeRedis(),
        { ...config, allowRegistration: true },
        deliverPendingNotifications(db, createFakeRedis()).pipe(Effect.orDie),
      ),
    );
    await registerAccount(OLD_PASSWORD, 0x22, 'delegation-existing');
    setService(
      createAuthService(
        db,
        createFakeRedis(),
        { ...config, allowRegistration: false },
        deliverPendingNotifications(db, createFakeRedis()).pipe(Effect.orDie),
      ),
    );

    const started = await startClientAndServerAuth('not the password');

    await expect(finishRegistration(started, 0x23, 'delegation-closed')).rejects.toMatchObject({
      code: 'registration_closed',
    });
  });

  test('round-trips real OPAQUE identifiers and reuses an active stored delegation', async () => {
    const registered = await registerAccount(OLD_PASSWORD, 0x22, 'delegation-existing');
    await Bun.sleep(5);
    const login = await startClientAndServerLogin(OLD_PASSWORD);

    expect(
      opaque.client.finishLogin({
        password: OLD_PASSWORD,
        clientLoginState: login.client.clientLoginState,
        loginResponse: login.server.loginResponse,
        identifiers: { client: login.server.userId, server: 'https://wrong-origin.test' },
        keyStretching: OPAQUE_PASSWORD_STRETCHING,
      }),
    ).toBeUndefined();
    expect(
      opaque.client.finishLogin({
        password: OLD_PASSWORD,
        clientLoginState: login.client.clientLoginState,
        loginResponse: login.server.loginResponse,
        identifiers: { client: 'wrong-user', server: ORIGIN },
        keyStretching: OPAQUE_PASSWORD_STRETCHING,
      }),
    ).toBeUndefined();

    const clientFinish = finishClientLogin(OLD_PASSWORD, login);
    const result = await Effect.runPromise(
      service.finishLogin({
        flowId: login.server.flowId,
        finishLoginRequest: clientFinish.finishLoginRequest,
        delegationCertificate: registered.certificate,
        client: TEST_CLIENT,
      }),
    );

    expect(result.userId).toBe(registered.userId);
    expect(result.delegationId).toBe('delegation-existing');
    expect(result.delegationExpiresAt).toBe(registered.certificate.expiresAt);
    expect(login.server.delegationIssuedAt).not.toBe(registered.certificate.issuedAt);
  });

  test('reports an invalid login delegation as a typed authentication failure', async () => {
    const registered = await registerAccount(OLD_PASSWORD, 0x24, 'delegation-valid');
    const login = await startClientAndServerLogin(OLD_PASSWORD);
    const clientFinish = finishClientLogin(OLD_PASSWORD, login);

    await expect(
      Effect.runPromise(
        service.finishLogin({
          flowId: login.server.flowId,
          finishLoginRequest: clientFinish.finishLoginRequest,
          client: TEST_CLIENT,
          delegationCertificate: {
            ...registered.certificate,
            delegationId: 'delegation-tampered',
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'invalid_delegation' });
  });

  test('accepts a retryable 60-second-old signed revocation and records it idempotently', async () => {
    const actor = await registerAccount(OLD_PASSWORD, 0x33, 'delegation-actor');
    const target = await loginWithNewDelegation(OLD_PASSWORD, 0x44, 'delegation-target');
    const issuedAt = Date.now() - 60_000;
    const revocation = createDelegationRevocationStatement(
      {
        userId: actor.userId,
        rootKeyCommitment: ROOT_KEY_COMMITMENT,
        actorDelegationId: actor.certificate.delegationId,
        targets: [
          {
            delegationId: target.certificate.delegationId,
            expiresAt: target.certificate.expiresAt,
          },
        ],
        issuedAt,
        nonce: encodeUserAuthorizationBytes(new Uint8Array(32).fill(0x55)),
      },
      actor.delegate,
    );
    const browser = {
      userId: actor.userId,
      delegationId: actor.certificate.delegationId,
      delegationExpiresAt: actor.certificate.expiresAt,
    };
    const proof = { actorCertificate: actor.certificate, revocation };

    await expect(
      Effect.runPromise(
        service.revokeBrowserSessions(browser, proof, {
          kind: 'one',
          delegationId: target.certificate.delegationId,
        }),
      ),
    ).resolves.toBe(1);
    await expect(
      Effect.runPromise(
        service.revokeBrowserSessions(browser, proof, {
          kind: 'one',
          delegationId: target.certificate.delegationId,
        }),
      ),
    ).resolves.toBe(1);
    const targetRow = await db
      .selectFrom('browser_delegations')
      .select('revoked_at')
      .where('id', '=', target.certificate.delegationId)
      .executeTakeFirstOrThrow();
    expect(targetRow.revoked_at).not.toBeNull();
    // Registration and the login each announced their new delegation; the two
    // revocation announced its exact target; replay did not announce it again.
    const channel = `browser:presence:events:${actor.userId}`;
    expect(published).toEqual([
      ...[actor, target].map((holder) => ({
        channel,
        message: JSON.stringify({
          issuedDelegationIds: [holder.certificate.delegationId],
          revokedDelegationIds: [],
        }),
      })),
      ...Array.from({ length: 1 }, () => ({
        channel,
        message: JSON.stringify({
          issuedDelegationIds: [],
          revokedDelegationIds: [target.certificate.delegationId],
        }),
      })),
    ]);
  });

  test('accepts an already-signed self logout after another delegate revokes its actor', async () => {
    const actor = await registerAccount(OLD_PASSWORD, 0x35, 'delegation-offline-logout');
    const revoker = await loginWithNewDelegation(OLD_PASSWORD, 0x45, 'delegation-revoker');
    const selfRevocation = createDelegationRevocationStatement(
      {
        userId: actor.userId,
        rootKeyCommitment: ROOT_KEY_COMMITMENT,
        actorDelegationId: actor.certificate.delegationId,
        targets: [
          {
            delegationId: actor.certificate.delegationId,
            expiresAt: actor.certificate.expiresAt,
          },
        ],
        issuedAt: Date.now(),
        nonce: encodeUserAuthorizationBytes(new Uint8Array(32).fill(0x56)),
      },
      actor.delegate,
    );
    const remoteRevocation = createDelegationRevocationStatement(
      {
        userId: actor.userId,
        rootKeyCommitment: ROOT_KEY_COMMITMENT,
        actorDelegationId: revoker.certificate.delegationId,
        targets: [
          {
            delegationId: actor.certificate.delegationId,
            expiresAt: actor.certificate.expiresAt,
          },
        ],
        issuedAt: Date.now(),
        nonce: encodeUserAuthorizationBytes(new Uint8Array(32).fill(0x57)),
      },
      revoker.delegate,
    );

    await expect(
      Effect.runPromise(
        service.revokeBrowserSessions(
          {
            userId: actor.userId,
            delegationId: revoker.certificate.delegationId,
            delegationExpiresAt: revoker.certificate.expiresAt,
          },
          { actorCertificate: revoker.certificate, revocation: remoteRevocation },
          { kind: 'one', delegationId: actor.certificate.delegationId },
        ),
      ),
    ).resolves.toBe(1);
    const remotelyRevokedAt = Date.now() - 60 * 60 * 1_000;
    await db
      .updateTable('browser_delegations')
      .set({ revoked_at: remotelyRevokedAt })
      .where('id', '=', actor.certificate.delegationId)
      .execute();
    expect(selfRevocation.issuedAt).toBeGreaterThan(remotelyRevokedAt);
    await expect(
      Effect.runPromise(
        service.revokeBrowserSessions(
          {
            userId: actor.userId,
            delegationId: actor.certificate.delegationId,
            delegationExpiresAt: actor.certificate.expiresAt,
          },
          { actorCertificate: actor.certificate, revocation: selfRevocation },
          { kind: 'self' },
        ),
      ),
    ).resolves.toBe(0);

    expect(
      await db.selectFrom('delegation_revocations').select('nonce').orderBy('nonce').execute(),
    ).toEqual([{ nonce: remoteRevocation.nonce }]);
  });
});

describe('active delegation lookup', () => {
  test('binds the precompiled text exactly as the builder compiles on the server dialect', () => {
    const built = activeDelegationQuery(db, 'user-id', 'delegation-id', 1_234).compile();
    const compiled = compileActiveDelegationQuery('user-id', 'delegation-id', 1_234);
    expect(compiled.sql).toBe(built.sql);
    expect(compiled.parameters).toEqual(built.parameters);
  });

  test('verifies a bearer token without compiling a query', async () => {
    const actor = await registerAccount(OLD_PASSWORD, 0x26, 'delegation-bearer');
    const compile = spyOn(SqliteQueryCompiler.prototype, 'compileQuery');
    try {
      const verified = await Effect.runPromise(
        service.verifyBearerToken(actor.session.accessToken),
      );
      expect(verified).toEqual({
        userId: actor.userId,
        delegationId: actor.certificate.delegationId,
        delegationExpiresAt: actor.certificate.expiresAt,
      });
      expect(compile).not.toHaveBeenCalled();
    } finally {
      compile.mockRestore();
    }
  });
});

describe('username uniqueness', () => {
  test('a losing concurrent registration is zero rows written, not a raised error', async () => {
    // Registration selects first and inserts second, so two requests for one
    // username can both pass the select. What refuses the loser is this: the
    // insert names the username index and reports how many rows it wrote. The
    // previous version read the text of the driver's exception instead, which
    // says something different when the database is reached over a connection.
    const account = (id: string, username: string) => ({
      id,
      username,
      opaque_registration_record: 'record',
      root_public_key: ROOT_PUBLIC_KEY,
      root_key_commitment: ROOT_KEY_COMMITMENT,
      root_epoch: 1,
      root_envelope_nonce: 'nonce',
      root_envelope_ciphertext: 'ciphertext',
      created_at: 1,
    });
    await db.insertInto('users').values(account('user-1', USERNAME)).execute();

    const losing = await db
      .insertInto('users')
      .values(account('user-2', USERNAME))
      .onConflict((conflict) => conflict.column('username').doNothing())
      .executeTakeFirst();

    expect(losing.numInsertedOrUpdatedRows).toBe(0n);
    expect(await db.selectFrom('users').select('id').execute()).toEqual([{ id: 'user-1' }]);

    // The same statement still writes when the username is free, so the zero
    // above is the conflict and not the clause refusing everything.
    const accepted = await db
      .insertInto('users')
      .values(account('user-3', 'someone-else@example.com'))
      .onConflict((conflict) => conflict.column('username').doNothing())
      .executeTakeFirst();

    expect(accepted.numInsertedOrUpdatedRows).toBe(1n);
  });
});
