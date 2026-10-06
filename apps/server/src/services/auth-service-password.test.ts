import { describe, expect, test } from 'bun:test';
import { OPAQUE_PASSWORD_STRETCHING } from '@merkur/shared/opaque-password-policy';
import {
  createDelegationRevocationStatement,
  encodeUserAuthorizationBytes,
} from '@merkur/shared/user-authorization';
import * as opaque from '@serenity-kit/opaque';
import { Effect } from 'effect';
import { sql } from 'kysely';
import {
  browser,
  db,
  envelope,
  finishClientLogin,
  loginWithNewDelegation,
  OLD_PASSWORD,
  ORIGIN,
  ROOT_KEY_COMMITMENT,
  registerAccount,
  service,
  startClientAndServerLogin,
  TEST_CLIENT,
  USERNAME,
  useAuthServiceFixture,
} from './auth-service-fixture';

useAuthServiceFixture();

const NEW_PASSWORD = 'a different correct horse battery';

describe('password changes', () => {
  // Each flow performs several real OPAQUE exchanges and password derivations;
  // keep their assertions independent of the shared runner's CPU throughput.
  test('replaces credentials, preserves links and root, revokes other browsers and rotates refresh', async () => {
    const actor = await registerAccount(OLD_PASSWORD, 0x22, 'current');
    const other = await loginWithNewDelegation(OLD_PASSWORD, 0x23, 'other');
    await db
      .insertInto('daemons')
      .values({
        id: 'linked-daemon',
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
    const before = await db.selectFrom('users').selectAll().executeTakeFirstOrThrow();
    const input = await preparePasswordChange(actor);
    const changed = await Effect.runPromise(service.changePassword(browser(actor), input));
    expect(changed.delegationId).toBe(actor.certificate.delegationId);
    expect(changed.delegationExpiresAt).toBe(actor.certificate.expiresAt);
    expect(
      await Effect.runPromise(service.verifyBearerToken(other.session.accessToken)),
    ).toBeNull();
    expect(await Effect.runPromise(service.verifyBearerToken(changed.accessToken))).not.toBeNull();
    expect(
      await Effect.runPromise(
        service.refresh(actor.session.refreshCookieHeader.split(';')[0] ?? ''),
      ),
    ).toBeNull();
    expect(
      await Effect.runPromise(
        service.refresh(other.session.refreshCookieHeader.split(';')[0] ?? ''),
      ),
    ).toBeNull();
    expect(
      await Effect.runPromise(service.refresh(changed.refreshCookieHeader.split(';')[0] ?? '')),
    ).not.toBeNull();
    const after = await db.selectFrom('users').selectAll().executeTakeFirstOrThrow();
    expect(after).toEqual({
      ...before,
      opaque_registration_record: input.registrationRecord,
      root_envelope_nonce: input.rootEnvelope.nonce,
      root_envelope_ciphertext: input.rootEnvelope.ciphertext,
    });
    expect(await db.selectFrom('daemons').select('id').execute()).toEqual([
      { id: 'linked-daemon' },
    ]);
    const outbox = await db.selectFrom('delegation_revocation_outbox').selectAll().execute();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.revocation_json).toBe(JSON.stringify(input.revocation));
    const oldLogin = await startClientAndServerLogin(OLD_PASSWORD);
    expect(() => finishClientLogin(OLD_PASSWORD, oldLogin)).toThrow();
    await expect(loginWithNewDelegation(NEW_PASSWORD, 0x24, 'new-login')).resolves.toBeDefined();
    await expect(
      Effect.runPromise(service.changePassword(browser(actor), input)),
    ).rejects.toMatchObject({ code: 'invalid_flow' });
  }, 30_000);

  test('rejects a wrong current-password proof without changing credentials', async () => {
    const actor = await registerAccount(OLD_PASSWORD, 0x22, 'current');
    const before = await db.selectFrom('users').selectAll().execute();
    const input = await preparePasswordChange(actor);
    await expect(
      Effect.runPromise(
        service.changePassword(browser(actor), {
          ...input,
          finishLoginRequest: 'A'.repeat(86),
        }),
      ),
    ).rejects.toMatchObject({ code: 'invalid_credentials' });
    expect(await db.selectFrom('users').selectAll().execute()).toEqual(before);
    await expect(
      Effect.runPromise(service.changePassword(browser(actor), input)),
    ).rejects.toMatchObject({ code: 'invalid_flow' });
  }, 30_000);

  test('rejects both stale login completion and a competing password change', async () => {
    const actor = await registerAccount(OLD_PASSWORD, 0x22, 'current');
    const pendingLogin = await startClientAndServerLogin(OLD_PASSWORD);
    const finish = finishClientLogin(OLD_PASSWORD, pendingLogin);
    const first = await preparePasswordChange(actor);
    const competing = await preparePasswordChange(actor);
    await Effect.runPromise(service.changePassword(browser(actor), first));
    await expect(
      Effect.runPromise(
        service.finishLogin({
          flowId: pendingLogin.server.flowId,
          finishLoginRequest: finish.finishLoginRequest,
          delegationCertificate: actor.certificate,
          client: TEST_CLIENT,
        }),
      ),
    ).rejects.toMatchObject({ code: 'invalid_credentials' });
    await expect(
      Effect.runPromise(service.changePassword(browser(actor), competing)),
    ).rejects.toMatchObject({ code: 'invalid_credentials' });
  }, 30_000);

  test('refuses a missing or stale revoke-others set', async () => {
    const actor = await registerAccount(OLD_PASSWORD, 0x22, 'current');
    const input = await preparePasswordChange(actor);
    await loginWithNewDelegation(OLD_PASSWORD, 0x23, 'other');
    await expect(
      Effect.runPromise(service.changePassword(browser(actor), input)),
    ).rejects.toMatchObject({ code: 'invalid_delegation' });
    const stale = await preparePasswordChange(actor);
    await loginWithNewDelegation(OLD_PASSWORD, 0x24, 'newer');
    await expect(
      Effect.runPromise(service.changePassword(browser(actor), stale)),
    ).rejects.toMatchObject({ code: 'invalid_delegation' });
    expect(
      (await Effect.runPromise(service.listBrowserSessions(browser(actor)))).sessions.every(
        (s) => s.revokedAt === null,
      ),
    ).toBe(true);
  }, 30_000);

  test('rejects a revoked actor and a flow belonging to a different account', async () => {
    const actor = await registerAccount(OLD_PASSWORD, 0x22, 'current');
    const wrongUser = await preparePasswordChange(actor);
    await expect(
      Effect.runPromise(
        service.changePassword({ ...browser(actor), userId: 'someone-else' }, wrongUser),
      ),
    ).rejects.toMatchObject({ code: 'invalid_credentials' });
    const input = await preparePasswordChange(actor);
    await db
      .updateTable('browser_delegations')
      .set({ revoked_at: Date.now() })
      .where('id', '=', 'current')
      .execute();
    await expect(
      Effect.runPromise(service.changePassword(browser(actor), input)),
    ).rejects.toMatchObject({ code: 'invalid_delegation' });
  }, 30_000);

  test('rolls back revocation and refresh deletion when credential storage fails', async () => {
    const actor = await registerAccount(OLD_PASSWORD, 0x22, 'current');
    const other = await loginWithNewDelegation(OLD_PASSWORD, 0x23, 'other');
    const before = await db.selectFrom('users').selectAll().execute();
    const input = await preparePasswordChange(actor);
    await sql`CREATE TRIGGER reject_password_update BEFORE UPDATE ON users BEGIN SELECT RAISE(ABORT, 'test failure'); END`.execute(
      db,
    );
    await expect(
      Effect.runPromise(service.changePassword(browser(actor), input)),
    ).rejects.toMatchObject({ _tag: 'InfrastructureError' });
    expect(await db.selectFrom('users').selectAll().execute()).toEqual(before);
    expect(await db.selectFrom('delegation_revocations').selectAll().execute()).toEqual([]);
    expect(
      await Effect.runPromise(service.verifyBearerToken(other.session.accessToken)),
    ).not.toBeNull();
    expect(
      await Effect.runPromise(
        service.refresh(other.session.refreshCookieHeader.split(';')[0] ?? ''),
      ),
    ).not.toBeNull();
  }, 30_000);
});

async function preparePasswordChange(actor: Awaited<ReturnType<typeof registerAccount>>) {
  const login = opaque.client.startLogin({ password: OLD_PASSWORD });
  const registration = opaque.client.startRegistration({ password: NEW_PASSWORD });
  const start = await Effect.runPromise(
    service.startAuth(USERNAME, login.startLoginRequest, registration.registrationRequest),
  );
  const oldFinish = finishClientLogin(OLD_PASSWORD, { client: login, server: start.login });
  const replacement = opaque.client.finishRegistration({
    password: NEW_PASSWORD,
    clientRegistrationState: registration.clientRegistrationState,
    registrationResponse: start.registration.registrationResponse,
    identifiers: { client: actor.userId, server: ORIGIN },
    keyStretching: OPAQUE_PASSWORD_STRETCHING,
  });
  const list = await Effect.runPromise(service.listBrowserSessions(browser(actor)));
  const targets = list.sessions
    .filter((s) => !s.current && s.revokedAt === null)
    .map(({ delegationId, expiresAt }) => ({ delegationId, expiresAt }))
    .sort((a, b) => (a.delegationId < b.delegationId ? -1 : 1));
  return {
    flowId: start.login.flowId,
    finishLoginRequest: oldFinish.finishLoginRequest,
    registrationRecord: replacement.registrationRecord,
    rootEnvelope: envelope(0x33),
    delegationCertificate: actor.certificate,
    revocation:
      targets.length === 0
        ? null
        : createDelegationRevocationStatement(
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
