import { describe, expect, test } from 'bun:test';
import { Effect, Layer } from 'effect';
import { Elysia } from 'elysia';

import type { AuthIdentity } from '../../config';
import { createLogger } from '../../logger';
import type { runServerProgram } from '../../runtime';
import {
  AuthError,
  type AuthenticatedBrowser,
  type AuthService,
  AuthServiceTag,
} from '../../services/auth-service';
import { DaemonControlServiceTag } from '../../services/daemon-control-service';
import {
  type RateLimitReservation,
  type RateLimitService,
  RateLimitServiceTag,
} from '../../services/rate-limit-service';
import { RedisError } from '../../services/redis-service';
import { SessionServiceTag } from '../../services/session-service';
import { apiErrorPlugin } from '../api-errors';
import { authRoutesPlugin } from './auth-routes';

const PUBLIC_ORIGIN = 'https://merkur.test';

describe('auth routes', () => {
  test('exposes one fixed-shape OPAQUE start flow', async () => {
    const observed: unknown[] = [];

    // What the service answers is what the route's schema holds it to: each
    // value the canonical base64url of its byte count.
    const start = {
      login: {
        flowId: encoded(32, 1),
        userId: 'user-1',
        loginResponse: encoded(320, 2),
        rootPublicKey: encoded(2_592, 3),
        rootEnvelope: { nonce: encoded(12, 4), ciphertext: encoded(48, 5) },
        rootEpoch: 1,
        delegationIssuedAt: 1_000,
        delegationExpiresAt: 2_592_001_000,
      },
      registration: {
        flowId: encoded(32, 1),
        userId: 'user-1',
        registrationResponse: encoded(64, 6),
        delegationIssuedAt: 1_000,
        delegationExpiresAt: 2_592_001_000,
      },
    };

    const service: AuthService = {
      ...unexpectedAuthService(),
      startAuth: (username, startLoginRequest, registrationRequest) =>
        Effect.sync(() => {
          observed.push({ username, startLoginRequest, registrationRequest });

          return start;
        }),
    };

    const app = createApp(service);

    const response = await app.handle(
      request('/api/auth/start', {
        username: 'user@example.com',
        startLoginRequest: 'p'.repeat(128),
        registrationRequest: 'q'.repeat(43),
      }),
    );

    expect(response.status).toBe(200);
    expect(observed).toEqual([
      {
        username: 'user@example.com',
        startLoginRequest: 'p'.repeat(128),
        registrationRequest: 'q'.repeat(43),
      },
    ]);
    expect(await response.json()).toEqual(start);
  });

  test('a start the service answers out of contract never reaches the browser', async () => {
    const service: AuthService = {
      ...unexpectedAuthService(),
      startAuth: () =>
        Effect.succeed({
          login: {
            // The length of a flow id, in its alphabet, and not the encoding of 32 bytes.
            flowId: 'f'.repeat(43),
            userId: 'user-1',
            loginResponse: encoded(320, 2),
            rootPublicKey: encoded(2_592, 3),
            rootEnvelope: { nonce: encoded(12, 4), ciphertext: encoded(48, 5) },
            rootEpoch: 1,
            delegationIssuedAt: 1_000,
            delegationExpiresAt: 2_592_001_000,
          },
          registration: {
            flowId: 'f'.repeat(43),
            userId: 'user-1',
            registrationResponse: encoded(64, 6),
            delegationIssuedAt: 1_000,
            delegationExpiresAt: 2_592_001_000,
          },
        }),
    };

    const response = await createApp(service).handle(
      request('/api/auth/start', {
        username: 'user@example.com',
        startLoginRequest: 'p'.repeat(128),
        registrationRequest: 'q'.repeat(43),
      }),
    );

    // Refused by the route's own response schema: an error, and nothing of the answer.
    expect(response.ok).toBe(false);
    expect(await response.text()).not.toContain('f'.repeat(43));
  });

  test('hard-cuts both enumeration-prone start routes', async () => {
    const app = createApp(unexpectedAuthService());
    const body = { username: 'user@example.com', startLoginRequest: 'p'.repeat(128) };

    const [login, registration] = await Promise.all([
      app.handle(request('/api/auth/login/start', body)),
      app.handle(
        request('/api/auth/register/start', {
          username: body.username,
          registrationRequest: 'q'.repeat(43),
        }),
      ),
    ]);

    expect(login.status).toBe(404);
    expect(registration.status).toBe(404);
  });

  test('normalizes expected finish failures to one external error', async () => {
    const service: AuthService = {
      ...unexpectedAuthService(),
      finishLogin: () =>
        Effect.fail(
          new AuthError({
            code: 'invalid_credentials',
            message: 'internal detail must not cross the route',
          }),
        ),
    };
    const response = await createApp(service).handle(
      request('/api/auth/login/finish', {
        flowId: 'f'.repeat(43),
        finishLoginRequest: 'q'.repeat(86),
        delegationCertificate: delegationCertificate(),
        installed: false,
      }),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'authentication_failed' });
  });

  test('refresh returns the delegation-bound session and sets the fixed-family cookie', async () => {
    const service: AuthService = {
      ...unexpectedAuthService(),
      refresh: () =>
        Effect.succeed({
          accessToken: 'access-token',
          userId: 'user-1',
          delegationId: 'delegation-1',
          delegationExpiresAt: 2_592_001_000,
          serverTimeMs: 1_000,
          refreshCookieHeader: 'merkur_refresh=rotated; HttpOnly; Path=/',
          deletionCancelled: false,
        }),
    };
    const app = createApp(service);

    const response = await app.handle(request('/api/auth/refresh', undefined));

    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain('merkur_refresh=rotated');
    expect(await response.json()).toEqual({
      accessToken: 'access-token',
      userId: 'user-1',
      delegationId: 'delegation-1',
      deletionCancelled: false,
      delegationExpiresAt: 2_592_001_000,
      serverTimeMs: 1_000,
    });
  });

  test('a completed sign-in hands its rate-limit slot back', async () => {
    const refunded: RateLimitReservation[] = [];
    const service: AuthService = {
      ...unexpectedAuthService(),
      finishLogin: () =>
        Effect.succeed({
          accessToken: 'access-token',
          userId: 'user-1',
          delegationId: 'delegation-1',
          delegationExpiresAt: 2_592_001_000,
          serverTimeMs: 1_000,
          refreshCookieHeader: 'merkur_refresh=issued; HttpOnly; Path=/',
          deletionCancelled: false,
        }),
    };

    const response = await createApp(service, countingRateLimit(refunded)).handle(
      request('/api/auth/login/finish', {
        flowId: 'f'.repeat(43),
        finishLoginRequest: 'q'.repeat(86),
        delegationCertificate: delegationCertificate(),
        installed: false,
      }),
    );

    expect(response.status).toBe(200);
    // Only the IP slot is reserved on finish; the username limit guards start.
    expect(refunded).toEqual([{ key: 'auth:finish:ip:unknown', windowId: 7 }]);
  });

  test('a failed sign-in keeps spending the guessing budget', async () => {
    const refunded: RateLimitReservation[] = [];
    const service: AuthService = {
      ...unexpectedAuthService(),
      finishLogin: () => Effect.fail(new AuthError({ code: 'invalid_credentials', message: 'no' })),
    };

    const response = await createApp(service, countingRateLimit(refunded)).handle(
      request('/api/auth/login/finish', {
        flowId: 'f'.repeat(43),
        finishLoginRequest: 'q'.repeat(86),
        delegationCertificate: delegationCertificate(),
        installed: false,
      }),
    );

    expect(response.status).toBe(401);
    expect(refunded).toEqual([]);
  });

  test('a refund failure never costs the caller its session', async () => {
    const service: AuthService = {
      ...unexpectedAuthService(),
      finishLogin: () =>
        Effect.succeed({
          accessToken: 'access-token',
          userId: 'user-1',
          delegationId: 'delegation-1',
          delegationExpiresAt: 2_592_001_000,
          serverTimeMs: 1_000,
          refreshCookieHeader: 'merkur_refresh=issued; HttpOnly; Path=/',
          deletionCancelled: false,
        }),
    };
    const brokenRefund: RateLimitService = {
      consume: () => Effect.succeed({ allowed: true, windowId: 7 }),
      refund: () =>
        Effect.fail(new RedisError({ cause: null, message: 'rate-limit-refund unavailable' })),
    };

    const response = await createApp(service, brokenRefund).handle(
      request('/api/auth/login/finish', {
        flowId: 'f'.repeat(43),
        finishLoginRequest: 'q'.repeat(86),
        delegationCertificate: delegationCertificate(),
        installed: false,
      }),
    );

    expect(response.status).toBe(200);
  });

  test('password change requires an authenticated browser and a same-origin request', async () => {
    const app = createApp(unexpectedAuthService());
    expect((await app.handle(request('/api/auth/password', passwordChangeBody()))).status).toBe(
      401,
    );
    const crossSite = request('/api/auth/password', passwordChangeBody());
    crossSite.headers.set('origin', 'https://attacker.test');
    expect(
      (await createApp(unexpectedAuthService(), undefined, authenticatedBrowser).handle(crossSite))
        .status,
    ).toBe(403);
  });

  test('password change fails closed on exhausted or unavailable rate limits', async () => {
    for (const [rateLimit, status] of [
      [{ consume: () => Effect.succeed({ allowed: false, retryAfterMs: 1_000 }) }, 429],
      [
        { consume: () => Effect.fail(new RedisError({ cause: null, message: 'unavailable' })) },
        503,
      ],
    ] as const) {
      const response = await createApp(
        unexpectedAuthService(),
        rateLimit,
        authenticatedBrowser,
      ).handle(request('/api/auth/password', passwordChangeBody()));
      expect(response.status).toBe(status);
    }
  });

  test('password change returns a replacement cookie, refunds success and flushes revocations', async () => {
    const observed: unknown[] = [];
    const refunded: RateLimitReservation[] = [];
    const service: AuthService = {
      ...unexpectedAuthService(),
      changePassword: (browser, input) =>
        Effect.sync(() => {
          observed.push({ browser, input });
          return {
            accessToken: 'replacement',
            userId: 'user-1',
            delegationId: 'delegation-1',
            delegationExpiresAt: 2_592_001_000,
            serverTimeMs: 1_000,
            refreshCookieHeader: 'merkur_refresh=replacement; HttpOnly; Path=/',
            deletionCancelled: false,
          };
        }),
    };
    const response = await createApp(
      service,
      countingRateLimit(refunded),
      authenticatedBrowser,
      observed,
    ).handle(request('/api/auth/password', passwordChangeBody()));
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain('merkur_refresh=replacement');
    expect(await response.json()).toMatchObject({
      accessToken: 'replacement',
      delegationId: 'delegation-1',
    });
    expect(observed).toEqual([
      { browser: authenticatedBrowser, input: passwordChangeBody() },
      'user-1',
    ]);
    expect(refunded).toEqual([{ key: 'auth:finish:ip:unknown', windowId: 7 }]);
  });

  test('password change rejects plaintext passwords and malformed proof fields', async () => {
    const response = await createApp(
      unexpectedAuthService(),
      undefined,
      authenticatedBrowser,
    ).handle(
      request('/api/auth/password', {
        ...passwordChangeBody(),
        finishLoginRequest: 'invalid',
        password: 'secret',
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain('secret');
  });

  test('does not expose the retired plaintext-password continuation route', async () => {
    const response = await createApp(unexpectedAuthService()).handle(
      request('/api/auth/continue', { username: 'user@example.com', password: 'secret' }),
    );

    expect(response.status).toBe(404);
  });

  test('a closed sign-up has its own answer, distinct from a credential failure', async () => {
    const service: AuthService = {
      ...unexpectedAuthService(),
      finishRegistration: () =>
        Effect.fail(new AuthError({ code: 'registration_closed', message: 'closed' })),
    };

    const response = await createApp(service).handle(
      request('/api/auth/register/finish', registrationFinishBody()),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'registration_closed' });
  });

  test('a refused address has its own answer on both sign-up steps', async () => {
    const refused = Effect.fail(new AuthError({ code: 'email_not_accepted', message: 'refused' }));
    const service: AuthService = {
      ...unexpectedAuthService(),
      requestEmailCode: () => refused,
      finishRegistration: () => refused,
    };
    const app = createApp(service);

    for (const response of [
      await app.handle(request('/api/auth/register/code', { flowId: 'f'.repeat(43) })),
      await app.handle(request('/api/auth/register/finish', registrationFinishBody())),
    ]) {
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'email_not_accepted' });
    }
  });

  test('only a finish that creates an account spends the hourly sign-up slot', async () => {
    const created: RateLimitReservation[] = [];
    const creating: AuthService = {
      ...unexpectedAuthService(),
      finishRegistration: () =>
        Effect.succeed({
          accessToken: 'access-token',
          userId: 'user-1',
          delegationId: 'delegation-1',
          delegationExpiresAt: 2_592_001_000,
          serverTimeMs: 1_000,
          refreshCookieHeader: 'merkur_refresh=issued; HttpOnly; Path=/',
          deletionCancelled: false,
        }),
    };
    const success = await createApp(creating, countingRateLimit(created)).handle(
      request('/api/auth/register/finish', registrationFinishBody()),
    );
    expect(success.status).toBe(200);
    expect(created).toEqual([]);

    // The browser lands on this route after a wrong password on an existing
    // account too, so a failed finish hands the creation slot back.
    const refunded: RateLimitReservation[] = [];
    const refusing: AuthService = {
      ...unexpectedAuthService(),
      finishRegistration: () =>
        Effect.fail(new AuthError({ code: 'invalid_credentials', message: 'taken' })),
    };
    const failure = await createApp(refusing, countingRateLimit(refunded)).handle(
      request('/api/auth/register/finish', registrationFinishBody()),
    );
    expect(failure.status).toBe(401);
    expect(refunded).toEqual([{ key: 'auth:register:ip:unknown', windowId: 7 }]);
  });

  test('sign-ups past the hourly limit are refused before the account is created', async () => {
    const consumed: string[] = [];
    const limited: RateLimitService = {
      consume: (check) =>
        Effect.sync(() => {
          consumed.push(check.key);
          return check.key.startsWith('auth:register:')
            ? { allowed: false, retryAfterMs: 1_800_000 }
            : { allowed: true };
        }),
    };

    const response = await createApp(unexpectedAuthService(), limited).handle(
      request('/api/auth/register/finish', registrationFinishBody()),
    );

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('1800');
    expect(consumed).toEqual(['auth:finish:ip:unknown', 'auth:register:ip:unknown']);
  });
});

describe('email identity routes', () => {
  test('the policy names the identity and the sign-up state, and nothing else', async () => {
    for (const identity of ['username', 'email'] as const) {
      const response = await createApp(
        unexpectedAuthService(),
        undefined,
        null,
        [],
        identity,
      ).handle(new Request(`${PUBLIC_ORIGIN}/api/auth/policy`));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ identity, registration: true });
    }
  });

  test('a code request bounds mail per source and per recipient before sending', async () => {
    const consumed: string[] = [];
    const sent: string[] = [];
    const counting: RateLimitService = {
      consume: (check) =>
        Effect.sync(() => {
          consumed.push(check.key);
          return { allowed: true };
        }),
    };
    const service: AuthService = {
      ...unexpectedAuthService(),
      requestEmailCode: (flowId, admit) =>
        Effect.gen(function* () {
          yield* admit('someone@example.com');
          sent.push(flowId);
        }),
    };

    const response = await createApp(service, counting, null, [], 'email').handle(
      request('/api/auth/register/code', { flowId: 'f'.repeat(43) }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sent: true });
    expect(consumed).toEqual(['auth:code:ip:unknown', 'auth:code:addr:someone@example.com']);
    expect(sent).toEqual(['f'.repeat(43)]);
  });

  test('a recipient past its hourly mail budget is refused and not mailed', async () => {
    const sent: string[] = [];
    const limited: RateLimitService = {
      consume: (check) =>
        Effect.succeed(
          check.key.startsWith('auth:code:addr:')
            ? { allowed: false, retryAfterMs: 60_000 }
            : { allowed: true },
        ),
    };
    const service: AuthService = {
      ...unexpectedAuthService(),
      requestEmailCode: (flowId, admit) =>
        Effect.gen(function* () {
          yield* admit('someone@example.com');
          sent.push(flowId);
        }),
    };

    const response = await createApp(service, limited, null, [], 'email').handle(
      request('/api/auth/register/code', { flowId: 'f'.repeat(43) }),
    );

    expect(response.status).toBe(429);
    expect(sent).toEqual([]);
  });

  test('a wrong code has its own answer, so the form can ask again', async () => {
    const service: AuthService = {
      ...unexpectedAuthService(),
      finishRegistration: () =>
        Effect.fail(new AuthError({ code: 'invalid_email_code', message: 'wrong' })),
    };

    const response = await createApp(service, undefined, null, [], 'email').handle(
      request('/api/auth/register/finish', { ...registrationFinishBody(), emailCode: '123456' }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_email_code' });
  });

  test('a malformed code never reaches the service', async () => {
    const response = await createApp(unexpectedAuthService(), undefined, null, [], 'email').handle(
      request('/api/auth/register/finish', { ...registrationFinishBody(), emailCode: '12a456' }),
    );

    expect(response.status).toBe(400);
  });

  test('the per-name start budget keys on the stored spelling of an address', async () => {
    const consumed: string[] = [];
    const counting: RateLimitService = {
      consume: (check) =>
        Effect.sync(() => {
          consumed.push(check.key);
          return { allowed: true };
        }),
    };
    const service: AuthService = {
      ...unexpectedAuthService(),
      startAuth: () => Effect.fail(new AuthError({ code: 'invalid_request', message: 'stop' })),
    };

    await createApp(service, counting, null, [], 'email').handle(
      request('/api/auth/start', {
        username: '  Someone@Example.COM ',
        startLoginRequest: 'p'.repeat(128),
        registrationRequest: 'q'.repeat(43),
      }),
    );

    expect(consumed).toEqual(['auth:start:ip:unknown', 'auth:start:user:someone@example.com']);
  });
});

describe('password reset routes', () => {
  const FLOW_ID = encoded(32, 7);
  const PROVEN_FLOW_ID = encoded(32, 8);
  const session = {
    accessToken: 'access-token',
    userId: 'user-1',
    delegationId: 'delegation-1',
    delegationExpiresAt: 2_592_001_000,
    serverTimeMs: 1_000,
    refreshCookieHeader: 'merkur_refresh=reset; HttpOnly; Path=/',
    deletionCancelled: false,
  };

  function recordingRateLimit(consumed: string[], refunded: RateLimitReservation[] = []) {
    return {
      consume: (check) =>
        Effect.sync(() => {
          consumed.push(check.key);
          return { allowed: true, windowId: 7 };
        }),
      refund: (reservation) =>
        Effect.sync(() => {
          refunded.push(reservation);
        }),
    } satisfies RateLimitService;
  }

  function resetFinishBody() {
    const { emailCode: _emailCode, ...body } = registrationFinishBody();
    return body;
  }

  test('a code request spends the sign-up form’s mail budgets before anything is sent', async () => {
    const consumed: string[] = [];
    const asked: string[] = [];
    const service: AuthService = {
      ...unexpectedAuthService(),
      requestPasswordResetCode: (username, admit) =>
        Effect.gen(function* () {
          yield* admit('someone@example.com');
          asked.push(username);
          return FLOW_ID;
        }),
    };

    const response = await createApp(
      service,
      recordingRateLimit(consumed),
      null,
      [],
      'email',
    ).handle(request('/api/auth/reset/code', { username: ' Someone@Example.COM ' }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ flowId: FLOW_ID });
    expect(consumed).toEqual([
      'auth:code:ip:unknown',
      'auth:reset:ip:unknown',
      'auth:reset:user:someone@example.com',
      'auth:code:addr:someone@example.com',
    ]);
    expect(asked).toEqual([' Someone@Example.COM ']);
  });

  test('a mailbox past its hourly budget is refused a reset code and not mailed', async () => {
    const sent: string[] = [];
    const limited: RateLimitService = {
      consume: (check) =>
        Effect.succeed(
          check.key.startsWith('auth:code:addr:')
            ? { allowed: false, retryAfterMs: 60_000 }
            : { allowed: true },
        ),
    };
    const service: AuthService = {
      ...unexpectedAuthService(),
      requestPasswordResetCode: (username, admit) =>
        Effect.gen(function* () {
          yield* admit('someone@example.com');
          sent.push(username);
          return FLOW_ID;
        }),
    };

    const response = await createApp(service, limited, null, [], 'email').handle(
      request('/api/auth/reset/code', { username: 'someone@example.com' }),
    );

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('60');
    expect(sent).toEqual([]);
  });

  test('a correct code hands its guess back; the source budget stays spent', async () => {
    const consumed: string[] = [];
    const refunded: RateLimitReservation[] = [];
    const devices = [{ name: 'laptop', platform: 'macOS', box: false }];
    const service: AuthService = {
      ...unexpectedAuthService(),
      verifyPasswordResetCode: (_flowId, _emailCode, admit) =>
        Effect.gen(function* () {
          const admitted = yield* admit('user-1');
          return { flowId: PROVEN_FLOW_ID, devices, admitted };
        }),
    };

    const response = await createApp(
      service,
      recordingRateLimit(consumed, refunded),
      null,
      [],
      'email',
    ).handle(request('/api/auth/reset/verify', { flowId: FLOW_ID, emailCode: '123456' }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ flowId: PROVEN_FLOW_ID, devices });
    expect(consumed).toEqual(['auth:reset-verify:ip:unknown', 'auth:reset:guess:user-1']);
    expect(refunded).toEqual([{ key: 'auth:reset:guess:user-1', windowId: 7 }]);
  });

  test('a wrong code keeps the account’s guess spent and has its own answer', async () => {
    const refunded: RateLimitReservation[] = [];
    const service: AuthService = {
      ...unexpectedAuthService(),
      verifyPasswordResetCode: (_flowId, _emailCode, admit) =>
        Effect.gen(function* () {
          yield* admit('user-1');
          return yield* new AuthError({ code: 'invalid_email_code', message: 'wrong' });
        }),
    };

    const response = await createApp(
      service,
      countingRateLimit(refunded),
      null,
      [],
      'email',
    ).handle(request('/api/auth/reset/verify', { flowId: FLOW_ID, emailCode: '123456' }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_email_code' });
    expect(refunded).toEqual([]);
  });

  test('an account past its daily guess budget is refused before the code is compared', async () => {
    let compared = false;
    const limited: RateLimitService = {
      consume: (check) =>
        Effect.succeed(
          check.key.startsWith('auth:reset:guess:')
            ? { allowed: false, retryAfterMs: 3_600_000 }
            : { allowed: true },
        ),
    };
    const service: AuthService = {
      ...unexpectedAuthService(),
      verifyPasswordResetCode: (_flowId, _emailCode, admit) =>
        Effect.gen(function* () {
          const admitted = yield* admit('user-1');
          compared = true;
          return { flowId: PROVEN_FLOW_ID, devices: [], admitted };
        }),
    };

    const response = await createApp(service, limited, null, [], 'email').handle(
      request('/api/auth/reset/verify', { flowId: FLOW_ID, emailCode: '123456' }),
    );

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('3600');
    expect(compared).toBe(false);
  });

  test('the guess budget fails closed when it cannot be read', async () => {
    const unavailable: RateLimitService = {
      consume: (check) =>
        check.key.startsWith('auth:reset:guess:')
          ? Effect.fail(new RedisError({ cause: null, message: 'unavailable' }))
          : Effect.succeed({ allowed: true }),
    };
    const service: AuthService = {
      ...unexpectedAuthService(),
      verifyPasswordResetCode: (_flowId, _emailCode, admit) =>
        Effect.gen(function* () {
          const admitted = yield* admit('user-1');
          return { flowId: PROVEN_FLOW_ID, devices: [], admitted };
        }),
    };

    const response = await createApp(service, unavailable, null, [], 'email').handle(
      request('/api/auth/reset/verify', { flowId: FLOW_ID, emailCode: '123456' }),
    );

    expect(response.status).toBe(503);
  });

  test('a malformed code never reaches the service', async () => {
    const response = await createApp(unexpectedAuthService(), undefined, null, [], 'email').handle(
      request('/api/auth/reset/verify', { flowId: FLOW_ID, emailCode: '12a456' }),
    );

    expect(response.status).toBe(400);
  });

  test('the start step returns the registration response and the epoch to sign for', async () => {
    const start = {
      userId: 'user-1',
      registrationResponse: encoded(64, 6),
      rootEpoch: 2,
      delegationIssuedAt: 1_000,
      delegationExpiresAt: 2_592_001_000,
    };
    const service: AuthService = {
      ...unexpectedAuthService(),
      startPasswordReset: () => Effect.succeed(start),
    };

    const response = await createApp(service, undefined, null, [], 'email').handle(
      request('/api/auth/reset/start', {
        flowId: PROVEN_FLOW_ID,
        registrationRequest: 'q'.repeat(43),
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(start);
  });

  test('a finished reset sets the new cookie and revokes the account’s live sessions', async () => {
    const observed: unknown[] = [];
    const service: AuthService = {
      ...unexpectedAuthService(),
      finishPasswordReset: (input) =>
        Effect.sync(() => {
          observed.push(input);
          return session;
        }),
    };

    const response = await createApp(service, undefined, null, observed, 'email').handle(
      request('/api/auth/reset/finish', resetFinishBody()),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain('merkur_refresh=reset');
    expect(await response.json()).toEqual({
      accessToken: 'access-token',
      userId: 'user-1',
      delegationId: 'delegation-1',
      delegationExpiresAt: 2_592_001_000,
      serverTimeMs: 1_000,
      deletionCancelled: false,
    });
    expect(observed).toEqual([
      {
        ...resetFinishBody(),
        client: { browser: null, platform: null, installed: false },
      },
      { revokedAll: 'user-1' },
    ]);
  });

  test('a reset that committed is not undone by a failed session revocation', async () => {
    const service: AuthService = {
      ...unexpectedAuthService(),
      finishPasswordReset: () => Effect.succeed(session),
    };

    const response = await createApp(
      service,
      undefined,
      null,
      [],
      'email',
      Effect.fail(new RedisError({ cause: null, message: 'unavailable' })),
    ).handle(request('/api/auth/reset/finish', resetFinishBody()));

    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain('merkur_refresh=reset');
  });

  test('an expired or foreign flow is one external error at every step', async () => {
    const invalid = Effect.fail(new AuthError({ code: 'invalid_flow', message: 'gone' }));
    const service: AuthService = {
      ...unexpectedAuthService(),
      verifyPasswordResetCode: () => invalid,
      startPasswordReset: () => invalid,
      finishPasswordReset: () => invalid,
    };
    const app = createApp(service, undefined, null, [], 'email');

    for (const response of [
      await app.handle(request('/api/auth/reset/verify', { flowId: FLOW_ID, emailCode: '123456' })),
      await app.handle(
        request('/api/auth/reset/start', {
          flowId: FLOW_ID,
          registrationRequest: 'q'.repeat(43),
        }),
      ),
      await app.handle(request('/api/auth/reset/finish', resetFinishBody())),
    ]) {
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'authentication_failed' });
    }
  });

  test('every step refuses a cross-site request before it is counted', async () => {
    const consumed: string[] = [];
    const app = createApp(unexpectedAuthService(), recordingRateLimit(consumed), null, [], 'email');

    for (const [path, body] of [
      ['/api/auth/reset/code', { username: 'someone@example.com' }],
      ['/api/auth/reset/verify', { flowId: FLOW_ID, emailCode: '123456' }],
      ['/api/auth/reset/start', { flowId: FLOW_ID, registrationRequest: 'q'.repeat(43) }],
      ['/api/auth/reset/finish', resetFinishBody()],
    ] as const) {
      const crossSite = request(path, body);
      crossSite.headers.set('origin', 'https://attacker.test');
      expect([path, (await app.handle(crossSite)).status]).toEqual([path, 403]);
    }
    expect(consumed).toEqual([]);
  });
});

/** Canonical unpadded base64url of `bytes` bytes, each `fill`. */
function encoded(bytes: number, fill: number): string {
  return Buffer.alloc(bytes, fill).toString('base64url');
}

function registrationFinishBody() {
  return {
    flowId: 'f'.repeat(43),
    emailCode: null,
    registrationRecord: 'r'.repeat(256),
    rootPublicKey: 'k'.repeat(3_456),
    rootEnvelope: { nonce: 'n'.repeat(16), ciphertext: 'c'.repeat(64) },
    delegationCertificate: delegationCertificate(),
    installed: false,
  };
}

/**
 * Reports a `windowId` so `enforceRateLimitFailClosed` produces a reservation,
 * and records what the route hands back. The default double below omits both,
 * which degrades to counting attempts — safe, just stricter.
 */
function countingRateLimit(refunded: RateLimitReservation[]): RateLimitService {
  return {
    consume: () => Effect.succeed({ allowed: true, windowId: 7 }),
    refund: (reservation) =>
      Effect.sync(() => {
        refunded.push(reservation);
      }),
  };
}

function createApp(
  authService: AuthService,
  rateLimit: RateLimitService = { consume: () => Effect.succeed({ allowed: true }) },
  browser: AuthenticatedBrowser | null = null,
  flushed: unknown[] = [],
  identity: AuthIdentity = 'username',
  revokeAll?: Effect.Effect<void, RedisError>,
) {
  const layer = Layer.mergeAll(
    Layer.succeed(AuthServiceTag, authService),
    Layer.succeed(RateLimitServiceTag, rateLimit),
    Layer.succeed(SessionServiceTag, {
      request: () => Effect.die('unexpected session request'),
      renew: () => Effect.die('unexpected session renewal'),
      cancel: () => Effect.die('unexpected session cancel'),
      revokeAll: (userId) =>
        revokeAll ??
        Effect.sync(() => {
          flushed.push({ revokedAll: userId });
        }),
    }),
    Layer.succeed(DaemonControlServiceTag, {
      acceptConnection: () => Effect.die('unexpected accept'),
      receive: () => Effect.die('unexpected receive'),
      disconnect: () => Effect.die('unexpected disconnect'),
      pushRevocationGeneration: () => Effect.die('unexpected push'),
      startSession: () => Effect.die('unexpected start'),
      cancelSession: () => Effect.die('unexpected cancel'),
      flushUserDelegationRevocations: (userId) =>
        Effect.sync(() => {
          flushed.push(userId);
        }),
      healthSnapshot: () => Effect.die('unexpected health'),
      awaitCriticalFailure: Effect.never,
    }),
  );
  const run = ((program) =>
    Effect.runPromise(
      Effect.provide(program as Effect.Effect<unknown, unknown, never>, layer),
    )) as typeof runServerProgram;
  return new Elysia().use(apiErrorPlugin).use(
    authRoutesPlugin({
      runServerProgram: run,
      authorizeRequest: async () => browser,
      logger: createLogger('auth-routes-test'),
      publicOrigin: PUBLIC_ORIGIN,
      trustedProxyHops: 0,
      identity,
      allowRegistration: true,
    }),
  );
}

function unexpectedAuthService(): AuthService {
  const unexpected = (name: string) => Effect.die(new Error(`unexpected auth call: ${name}`));
  return {
    startAuth: () => unexpected('startAuth'),
    requestEmailCode: () => unexpected('requestEmailCode'),
    finishRegistration: () => unexpected('finishRegistration'),
    finishLogin: () => unexpected('finishLogin'),
    changePassword: () => unexpected('changePassword'),
    requestPasswordResetCode: () => unexpected('requestPasswordResetCode'),
    verifyPasswordResetCode: () => unexpected('verifyPasswordResetCode'),
    startPasswordReset: () => unexpected('startPasswordReset'),
    finishPasswordReset: () => unexpected('finishPasswordReset'),
    refresh: () => unexpected('refresh'),
    logout: () => unexpected('logout'),
    verifyBearerToken: () => unexpected('verifyBearerToken'),
    listBrowserSessions: () => unexpected('listBrowserSessions'),
    revokeBrowserSessions: () => unexpected('revokeBrowserSessions'),
    requireActiveDelegation: () => unexpected('requireActiveDelegation'),
    scheduleAccountDeletion: () => unexpected('scheduleAccountDeletion'),
    accountsDueForDeletion: () => unexpected('accountsDueForDeletion'),
    purgeAccount: () => unexpected('purgeAccount'),
  };
}

function delegationCertificate() {
  return {
    userId: 'user-1',
    rootKeyCommitment: 'r'.repeat(86),
    delegationId: 'delegation-1',
    delegatePublicKey: 'd'.repeat(3_456),
    scopes: ['terminal-session', 'session-revoke'],
    serverOrigin: PUBLIC_ORIGIN,
    rootEpoch: 1,
    issuedAt: 1_000,
    expiresAt: 2_592_001_000,
    signature: 's'.repeat(6_170),
  };
}

function request(path: string, body: unknown): Request {
  return new Request(`${PUBLIC_ORIGIN}${path}`, {
    method: 'POST',
    headers: {
      origin: PUBLIC_ORIGIN,
      'content-type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const authenticatedBrowser = {
  userId: 'user-1',
  delegationId: 'delegation-1',
  delegationExpiresAt: 2_592_001_000,
};
function passwordChangeBody() {
  return {
    flowId: 'f'.repeat(43),
    finishLoginRequest: 'q'.repeat(86),
    registrationRecord: 'r'.repeat(256),
    rootEnvelope: { nonce: 'n'.repeat(16), ciphertext: 'c'.repeat(64) },
    delegationCertificate: delegationCertificate(),
    revocation: null,
  };
}
