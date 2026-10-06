import { describe, expect, test } from 'bun:test';
import {
  AuthResetCodeResponse,
  AuthResetStartResponse,
  AuthResetVerifyResponse,
} from '@merkur/shared/api-schema';
import { OPAQUE_PASSWORD_STRETCHING } from '@merkur/shared/opaque-password-policy';
import {
  createUserDelegationCertificate,
  deriveUserAuthorizationSigningKey,
  deriveUserRootKeyCommitment,
  encodeUserAuthorizationBytes,
} from '@merkur/shared/user-authorization';
import * as opaque from '@serenity-kit/opaque';
import { Effect, Layer } from 'effect';
import { Value } from 'typebox/value';
import { deviceRoutesPlugin } from '../http/routes/device-routes';
import { createDeviceEventsSseLifetime } from '../http/sse';
import { createLogger } from '../logger';
import type { runServerProgram } from '../runtime';
import {
  db,
  envelope,
  finishClientLogin,
  finishRegistration,
  OLD_PASSWORD,
  ORIGIN,
  published,
  ROOT_PUBLIC_KEY,
  type SentMail,
  service,
  startClientAndServerAuth,
  TEST_CLIENT,
  useAuthServiceFixture,
  useEmailIdentity,
} from './auth-service-fixture';
import { createDeviceService, DeviceServiceTag } from './device-service';

useAuthServiceFixture();

const ADDRESS = 'someone@example.com';
const NEW_PASSWORD = 'a second correct horse battery';
const NEW_ROOT = deriveUserAuthorizationSigningKey(new Uint8Array(32).fill(0x55));
const NEW_ROOT_PUBLIC_KEY = encodeUserAuthorizationBytes(NEW_ROOT.publicKey);
const NEW_ROOT_KEY_COMMITMENT = deriveUserRootKeyCommitment(NEW_ROOT.publicKey);
const admitAll = () => Effect.succeed('admitted' as const);

describe('password reset', () => {
  let sent: SentMail[];

  async function emailService() {
    sent = [];
    await useEmailIdentity(sent);
  }

  function lastCode(): string {
    const code = sent.at(-1)?.code;
    if (code === undefined || code === null) throw new Error('no code was mailed');
    return code;
  }

  function wrongCode(code: string): string {
    return code === '000000' ? '000001' : '000000';
  }

  async function registerAccount(address = ADDRESS, delegationId = 'delegation-before-reset') {
    const started = await startClientAndServerAuth(OLD_PASSWORD, address);
    await Effect.runPromise(service.requestEmailCode(started.server.login.flowId, admitAll));
    return finishRegistration(started, 0x22, delegationId, lastCode());
  }

  async function startLogin(password: string) {
    const started = await startClientAndServerAuth(password, ADDRESS);
    return { client: started.login, server: started.server.login };
  }

  // Each step's answer is checked as the response its route builds from it:
  // the browser holds that response to the same schema.
  async function requestReset(address = ADDRESS) {
    const flowId = await Effect.runPromise(service.requestPasswordResetCode(address, admitAll));
    expect(Value.Check(AuthResetCodeResponse, { flowId })).toBe(true);
    return flowId;
  }

  async function verify(flowId: string, code: string) {
    const verified = await Effect.runPromise(
      service.verifyPasswordResetCode(flowId, code, admitAll),
    );
    expect(
      Value.Check(AuthResetVerifyResponse, {
        flowId: verified.flowId,
        devices: [...verified.devices],
      }),
    ).toBe(true);
    return verified;
  }

  /** Requests a code for `ADDRESS` and proves the mailbox with it. */
  async function provenReset(): Promise<string> {
    const flowId = await requestReset();
    return (await verify(flowId, lastCode())).flowId;
  }

  async function finishReset(flowId: string, overrides: { readonly rootEpoch?: number } = {}) {
    const registration = opaque.client.startRegistration({ password: NEW_PASSWORD });
    const start = await Effect.runPromise(
      service.startPasswordReset(flowId, registration.registrationRequest),
    );
    expect(Value.Check(AuthResetStartResponse, start)).toBe(true);
    const { registrationRecord } = opaque.client.finishRegistration({
      password: NEW_PASSWORD,
      clientRegistrationState: registration.clientRegistrationState,
      registrationResponse: start.registrationResponse,
      identifiers: { client: start.userId, server: ORIGIN },
      keyStretching: OPAQUE_PASSWORD_STRETCHING,
    });
    const delegate = deriveUserAuthorizationSigningKey(new Uint8Array(32).fill(0x66));
    const certificate = createUserDelegationCertificate(
      {
        userId: start.userId,
        rootKeyCommitment: NEW_ROOT_KEY_COMMITMENT,
        delegationId: 'delegation-after-reset',
        delegatePublicKey: encodeUserAuthorizationBytes(delegate.publicKey),
        scopes: ['terminal-session', 'session-revoke'],
        serverOrigin: ORIGIN,
        rootEpoch: overrides.rootEpoch ?? start.rootEpoch,
        issuedAt: start.delegationIssuedAt,
        expiresAt: start.delegationExpiresAt,
      },
      NEW_ROOT,
    );
    const session = await Effect.runPromise(
      service.finishPasswordReset({
        flowId,
        registrationRecord,
        rootPublicKey: NEW_ROOT_PUBLIC_KEY,
        rootEnvelope: envelope(0x33),
        delegationCertificate: certificate,
        client: TEST_CLIENT,
      }),
    );
    return { start, session };
  }

  async function linkMachine(userId: string, id: string, boxId: string | null) {
    await db
      .insertInto('daemons')
      .values({
        id,
        user_id: userId,
        name: id,
        platform: 'linux',
        daemon_identity_public_key: 'identity',
        daemon_identity_key_commitment: 'commitment',
        daemon_binding_json: '{}',
        last_seen: null,
        version: null,
        daemon_identity_p256_public_key: 'p256',
        identity_seal_backend: 'software',
        box_id: boxId,
      })
      .execute();
  }

  /** Renames a machine the way a browser does: the route, over the real device service. */
  function rename(userId: string, deviceId: string, name: string): Promise<Response> {
    const devices = createDeviceService(
      db,
      { tokenHmacSecret: 'test-token-hmac-secret', publicOrigin: ORIGIN },
      Effect.void,
    );

    // SAFETY: the rename route's program asks for the device service and nothing
    // else, and the layer provides it; the full server runtime is not needed.
    const run = ((program) =>
      Effect.runPromise(
        Effect.provide(
          program as Effect.Effect<unknown, unknown, never>,
          Layer.succeed(DeviceServiceTag, devices),
        ),
      )) as typeof runServerProgram;

    const routes = deviceRoutesPlugin({
      deviceEventsLifetime: createDeviceEventsSseLifetime(),
      runServerProgram: run,
      authorizeRequest: async () => ({
        userId,
        delegationId: 'delegation-before-reset',
        delegationExpiresAt: Date.now() + 60_000,
      }),
      logger: createLogger('auth-service-reset-test'),
      trustedProxyHops: 0,
    });

    return routes.handle(
      new Request(`${ORIGIN}/api/devices/${deviceId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      }),
    );
  }

  /** The root-bound state a used account carries, plus what must survive a reset. */
  async function populate(userId: string) {
    await linkMachine(userId, 'laptop', null);
    await linkMachine(userId, 'box-own', 'box-own');
    await linkMachine(userId, 'box-shared', 'box-shared');
    await db
      .insertInto('link_tokens')
      .values({ token_hash: 'token', user_id: userId, expires_at: 9e15, used_at: null })
      .execute();
    await db
      .insertInto('daemon_link_claims')
      .values({
        link_claim_id: 'claim',
        user_id: userId,
        state: 'approved',
        claim_commitment: 'commitment',
        public_claim_json: '{}',
        poll_token_hash: 'poll',
        server_nonce: 'nonce',
        approval_json: '{}',
        expires_at: 9e15,
        attempt_count: 0,
        created_at: 1,
        approved_at: 2,
      })
      .execute();
    await db
      .insertInto('push_subscriptions')
      .values({ id: 'push', user_id: userId, endpoint: 'https://push', p256dh: 'p', auth: 'a' })
      .execute();
    await db
      .insertInto('keyboard_settings')
      .values({ user_id: userId, settings_json: '{"kept":true}', updated_at: 1 })
      .execute();
    await db
      .insertInto('box_access')
      .values({ user_id: userId, status: 'approved', requested_at: 1, decided_at: 2 })
      .execute();
  }

  async function count(
    table:
      | 'daemons'
      | 'link_tokens'
      | 'daemon_link_claims'
      | 'push_subscriptions'
      | 'keyboard_settings'
      | 'box_access'
      | 'refresh_tokens'
      | 'browser_delegations',
    userId: string,
  ): Promise<number> {
    const row = await db
      .selectFrom(table)
      .select(({ fn }) => fn.countAll<number>().as('count'))
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }

  test('replaces the credential and root, destroys what the old root authorized, keeps the account', async () => {
    await emailService();
    const before = await registerAccount();
    // Another account's stale device names `box-shared` too: that container is
    // someone else's now, and a reset must not destroy it.
    const other = await registerAccount('other@example.com', 'delegation-other-account');
    await populate(before.userId);
    await linkMachine(other.userId, 'other-shared', 'box-shared');
    const oldCookie = before.session.refreshCookieHeader.split(';')[0] ?? '';

    const flowId = await requestReset('  Someone@Example.COM ');
    expect(sent.at(-1)).toMatchObject({ kind: 'reset-code', to: ADDRESS });
    const verified = await verify(flowId, lastCode());
    expect(verified.admitted).toBe('admitted');
    expect(verified.devices).toEqual([
      { name: 'box-own', platform: 'linux', box: true },
      { name: 'box-shared', platform: 'linux', box: true },
      { name: 'laptop', platform: 'linux', box: false },
    ]);

    const { start, session } = await finishReset(verified.flowId);

    expect(start.rootEpoch).toBe(2);
    expect(session.userId).toBe(before.userId);
    expect(session.deletionCancelled).toBe(false);
    const user = await db
      .selectFrom('users')
      .select(['username', 'root_epoch', 'root_public_key', 'root_key_commitment'])
      .where('id', '=', before.userId)
      .executeTakeFirstOrThrow();
    expect(user).toEqual({
      username: ADDRESS,
      root_epoch: 2,
      root_public_key: NEW_ROOT_PUBLIC_KEY,
      root_key_commitment: NEW_ROOT_KEY_COMMITMENT,
    });

    for (const table of [
      'daemons',
      'link_tokens',
      'daemon_link_claims',
      'push_subscriptions',
    ] as const) {
      expect([table, await count(table, before.userId)]).toEqual([table, 0]);
    }
    for (const table of ['keyboard_settings', 'box_access'] as const) {
      expect([table, await count(table, before.userId)]).toEqual([table, 1]);
    }
    expect(
      await db
        .selectFrom('browser_delegations')
        .select(['id', 'root_epoch'])
        .where('user_id', '=', before.userId)
        .execute(),
    ).toEqual([{ id: 'delegation-after-reset', root_epoch: 2 }]);
    expect(await count('refresh_tokens', before.userId)).toBe(1);
    // Only the box no other account names is queued; the other account is untouched.
    expect(await db.selectFrom('box_removals').select('box_id').execute()).toEqual([
      { box_id: 'box-own' },
    ]);
    expect(await count('daemons', other.userId)).toBe(1);
    expect(await count('browser_delegations', other.userId)).toBe(1);

    // Nothing the old root issued still works.
    expect(
      await Effect.runPromise(service.verifyBearerToken(before.session.accessToken)),
    ).toBeNull();
    expect(await Effect.runPromise(service.refresh(oldCookie))).toBeNull();
    expect(await Effect.runPromise(service.verifyBearerToken(session.accessToken))).toMatchObject({
      userId: before.userId,
      delegationId: 'delegation-after-reset',
    });

    // The old password opens nothing; the new one opens the new root.
    const oldLogin = await startLogin(OLD_PASSWORD);
    expect(oldLogin.server.userId).toBe(before.userId);
    expect(() => finishClientLogin(OLD_PASSWORD, oldLogin)).toThrow();
    const newLogin = await startLogin(NEW_PASSWORD);
    expect(finishClientLogin(NEW_PASSWORD, newLogin)).toBeDefined();
    expect(newLogin.server.rootEpoch).toBe(2);
    expect(newLogin.server.rootPublicKey).toBe(NEW_ROOT_PUBLIC_KEY);
    expect(newLogin.server.rootPublicKey).not.toBe(ROOT_PUBLIC_KEY);

    expect(sent.at(-1)).toMatchObject({ kind: 'reset-done', to: ADDRESS });
    // Open browsers are told their sessions ended, and open lists to reload.
    expect(published).toContainEqual({
      channel: `browser:presence:events:${before.userId}`,
      message: JSON.stringify({
        issuedDelegationIds: [],
        revokedDelegationIds: ['delegation-before-reset'],
      }),
    });
    expect(published).toContainEqual({
      channel: `merkur:device-events:{user:${before.userId}}`,
      message: 'resync',
    });
  });

  test('no rename leaves a machine with a name the reset answer cannot carry', async () => {
    await emailService();
    const account = await registerAccount();
    await linkMachine(account.userId, 'laptop', null);

    // One code point past what a response holds for a name.
    const tooLong = await rename(account.userId, 'laptop', 'n'.repeat(129));

    // `verify` holds its answer to the response's schema, as the route does.
    const afterTooLong = await verify(await requestReset(), lastCode());

    expect(tooLong.status).toBe(422);
    expect(afterTooLong.devices).toEqual([{ name: 'laptop', platform: 'linux', box: false }]);

    // The widest name the bound admits: 128 code points in 512 bytes.
    const widest = '👍'.repeat(128);
    const renamed = await rename(account.userId, 'laptop', widest);
    const afterWidest = await verify(await requestReset(), lastCode());

    expect(renamed.status).toBe(204);
    expect(afterWidest.devices).toEqual([{ name: widest, platform: 'linux', box: false }]);
  });

  test('a wrong code proves nothing, is admitted per account, and five destroy the flow', async () => {
    await emailService();
    const account = await registerAccount();
    const flowId = await requestReset();
    const code = lastCode();
    const admitted: string[] = [];
    const guess = (value: string) =>
      Effect.runPromise(
        service.verifyPasswordResetCode(flowId, value, (userId) =>
          Effect.sync(() => {
            admitted.push(userId);
          }),
        ),
      );

    await expect(guess('12a456')).rejects.toMatchObject({ code: 'invalid_request' });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(guess(wrongCode(code))).rejects.toMatchObject({ code: 'invalid_email_code' });
    }
    await expect(guess(code)).rejects.toMatchObject({ code: 'invalid_flow' });
    // Each counted guess was admitted against the account first; the malformed
    // one never reached it, and neither does a guess at a flow that is gone.
    expect(admitted).toEqual(Array.from({ length: 6 }, () => account.userId));
    await expect(guess(code)).rejects.toMatchObject({ code: 'invalid_flow' });
    expect(admitted).toHaveLength(6);
    expect(await count('browser_delegations', account.userId)).toBe(1);
  });

  test('a refused guess admission spends no attempt', async () => {
    await emailService();
    await registerAccount();
    const flowId = await requestReset();
    const code = lastCode();

    for (let attempt = 0; attempt < 8; attempt += 1) {
      await expect(
        Effect.runPromise(
          service.verifyPasswordResetCode(flowId, wrongCode(code), () =>
            Effect.fail('limited' as const),
          ),
        ),
      ).rejects.toBe('limited');
    }
    expect((await verify(flowId, code)).flowId).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test('an address with no account is mailed a notice and never verifies', async () => {
    await emailService();
    const flowId = await requestReset('nobody@example.com');

    expect(flowId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(sent).toEqual([
      {
        kind: 'reset-no-account',
        to: 'nobody@example.com',
        code: null,
        idempotencyKey: `${flowId}:1`,
      },
    ]);
    for (const guess of ['000000', '123456', '999999']) {
      await expect(verify(flowId, guess)).rejects.toMatchObject({ code: 'invalid_email_code' });
    }
  });

  test('a refused mail admission opens no flow and sends nothing', async () => {
    await emailService();
    await registerAccount();
    const before = sent.length;
    const recipients: string[] = [];

    await expect(
      Effect.runPromise(
        service.requestPasswordResetCode(ADDRESS, (recipient) =>
          Effect.suspend(() => {
            recipients.push(recipient);
            return Effect.fail('limited' as const);
          }),
        ),
      ),
    ).rejects.toBe('limited');
    expect(recipients).toEqual([ADDRESS]);
    expect(sent).toHaveLength(before);
  });

  test('a proven reset is spent once, and no flow id works as another kind', async () => {
    await emailService();
    const account = await registerAccount();
    const codeFlowId = await requestReset();
    const code = lastCode();
    const registration = opaque.client.startRegistration({ password: NEW_PASSWORD });

    // The mailed-code flow is not yet a reset.
    await expect(
      Effect.runPromise(service.startPasswordReset(codeFlowId, registration.registrationRequest)),
    ).rejects.toMatchObject({ code: 'invalid_flow' });
    // That refusal only read it, so the code still proves the mailbox, once.
    const proven = (await verify(codeFlowId, code)).flowId;
    await expect(verify(codeFlowId, code)).rejects.toMatchObject({ code: 'invalid_flow' });

    // A sign-in flow is not a reset either.
    const signIn = await startClientAndServerAuth(NEW_PASSWORD, ADDRESS);
    await expect(
      Effect.runPromise(
        service.startPasswordReset(signIn.server.login.flowId, registration.registrationRequest),
      ),
    ).rejects.toMatchObject({ code: 'invalid_flow' });

    await finishReset(proven);
    await expect(finishReset(proven)).rejects.toMatchObject({ code: 'invalid_flow' });
    expect(await count('browser_delegations', account.userId)).toBe(1);
  });

  test('a proven reset finishes no sign-up and no sign-in', async () => {
    await emailService();
    const account = await registerAccount();
    const proven = await provenReset();
    const started = await startClientAndServerAuth(NEW_PASSWORD, 'new@example.com');
    const asSignUp = { ...started.server.registration, flowId: proven };

    await expect(
      finishRegistration(
        { ...started, server: { ...started.server, registration: asSignUp } },
        0x23,
        'delegation-smuggled',
        '123456',
      ),
    ).rejects.toMatchObject({ code: 'invalid_flow' });
    expect(await db.selectFrom('users').select('id').execute()).toHaveLength(1);
    await expect(
      Effect.runPromise(
        service.finishLogin({
          flowId: proven,
          finishLoginRequest: 'q'.repeat(86),
          delegationCertificate: account.certificate,
          client: TEST_CLIENT,
        }),
      ),
    ).rejects.toMatchObject({ code: 'invalid_flow' });
    // The sign-in finish consumed the id it was offered, whatever its kind.
    await expect(finishReset(proven)).rejects.toMatchObject({ code: 'invalid_flow' });
  });

  test('a delegation naming the old epoch is refused and nothing changes', async () => {
    await emailService();
    const account = await registerAccount();
    await populate(account.userId);

    await expect(finishReset(await provenReset(), { rootEpoch: 1 })).rejects.toMatchObject({
      code: 'invalid_request',
    });
    expect(await count('daemons', account.userId)).toBe(3);
    expect(
      await db.selectFrom('users').select('root_epoch').where('id', '=', account.userId).execute(),
    ).toEqual([{ root_epoch: 1 }]);
    expect(await db.selectFrom('box_removals').select('box_id').execute()).toEqual([]);
  });

  test('a credential that moved after the code was mailed strands the reset', async () => {
    await emailService();
    const account = await registerAccount();
    await populate(account.userId);
    const first = await provenReset();
    const second = await provenReset();

    await finishReset(first);
    // The second mailbox proof was for the account before the first reset.
    await expect(finishReset(second)).rejects.toMatchObject({ code: 'invalid_flow' });
    expect(
      await db.selectFrom('users').select('root_epoch').where('id', '=', account.userId).execute(),
    ).toEqual([{ root_epoch: 2 }]);
    expect(await count('browser_delegations', account.userId)).toBe(1);
  });

  test('a suspended account is not reset', async () => {
    await emailService();
    const account = await registerAccount();
    await populate(account.userId);
    const proven = await provenReset();
    await db
      .updateTable('users')
      .set({ suspended_at: 1 })
      .where('id', '=', account.userId)
      .execute();

    await expect(finishReset(proven)).rejects.toMatchObject({ code: 'account_suspended' });
    expect(await count('daemons', account.userId)).toBe(3);
    expect(await count('push_subscriptions', account.userId)).toBe(1);
    expect(
      await db
        .selectFrom('users')
        .select(['root_epoch', 'root_public_key'])
        .where('id', '=', account.userId)
        .execute(),
    ).toEqual([{ root_epoch: 1, root_public_key: ROOT_PUBLIC_KEY }]);
    expect(await db.selectFrom('box_removals').select('box_id').execute()).toEqual([]);
    expect(sent.at(-1)?.kind).toBe('reset-code');
  });

  test('a reset calls off a scheduled erasure', async () => {
    await emailService();
    const account = await registerAccount();
    await db
      .updateTable('users')
      .set({ deletion_scheduled_at: 9e15 })
      .where('id', '=', account.userId)
      .execute();

    const { session } = await finishReset(await provenReset());

    expect(session.deletionCancelled).toBe(true);
    expect(
      await db
        .selectFrom('users')
        .select('deletion_scheduled_at')
        .where('id', '=', account.userId)
        .execute(),
    ).toEqual([{ deletion_scheduled_at: null }]);
  });

  test('username identity refuses every step', async () => {
    const registration = opaque.client.startRegistration({ password: NEW_PASSWORD });
    const flowId = 'f'.repeat(43);

    await expect(requestReset('someone')).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(verify(flowId, '123456')).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(
      Effect.runPromise(service.startPasswordReset(flowId, registration.registrationRequest)),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(finishReset(flowId)).rejects.toMatchObject({ code: 'invalid_request' });
  });
});
