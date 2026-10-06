import { describe, expect, test } from 'bun:test';
import { deriveSessionAuthorizationKeyPair } from '@merkur/auth';
import { ServerVersionResponse } from '@merkur/shared/api-schema';
import { Effect, Layer, Redacted } from 'effect';
import { Value } from 'typebox/value';
import { type ServerConfig, ServerConfigService } from '../config';
import { createLogger } from '../logger';
import { createAuthorizeRequest } from '../middleware/authenticated-user';
import type { runServerProgram } from '../runtime';
import { type AuthService, AuthServiceTag } from '../services/auth-service';
import { BoxWaitlistServiceTag } from '../services/box-waitlist-service';
import { type DeviceService, DeviceServiceTag } from '../services/device-service';
import { type RateLimitService, RateLimitServiceTag } from '../services/rate-limit-service';
import { RybbitEventsTag } from '../services/rybbit-events';
import { createServerApp } from './server-app';
import { createDeviceEventsSseLifetime } from './sse';

const SUBMITTED_OPAQUE_REQUEST = 'sensitive-opaque-registration-request';
const PAIRING_ID = Buffer.alloc(32, 0xaa).toString('base64url');
const WEBSITE = { origin: 'https://www.merkur.test', rybbit: undefined } as const;

/**
 * These probes exercise the composed app rather than an individual route
 * plugin. The error contracts below are produced by `apiErrorPlugin`, which
 * only fires because it is registered before the route plugins — mounting a
 * plugin on its own bypasses it and reports Elysia's defaults instead.
 */
describe('server app error contract', () => {
  test('rejects a malformed body with the documented 400 shape', async () => {
    const response = await handle(
      new Request('https://merkur.test/api/daemon-link/claims', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toHaveProperty('error', 'invalid_request');
    expectSecurityHeaders(response);
  });

  test('rejects surplus link-token creation fields', async () => {
    const response = await handle(
      new Request('https://merkur.test/api/link-token', {
        method: 'POST',
        headers: {
          authorization: 'Bearer token-1',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ pairingId: PAIRING_ID, pairingCode: 'must-not-cross-server' }),
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toHaveProperty('error', 'invalid_request');
    expectSecurityHeaders(response);
  });

  test('never reflects submitted OPAQUE material in a validation failure', async () => {
    const response = await handle(
      new Request('https://merkur.test/api/auth/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://merkur.test' },
        body: JSON.stringify({
          username: 'person@example.com',
          startLoginRequest: 'l'.repeat(128),
          registrationRequest: SUBMITTED_OPAQUE_REQUEST,
        }),
      }),
    );

    expect(response.status).toBe(400);
    const body = await response.text();
    expect(body).not.toContain(SUBMITTED_OPAQUE_REQUEST);
    expect(body).not.toContain('"found"');
    expect(JSON.parse(body)).toHaveProperty('error', 'invalid_request');
    expectSecurityHeaders(response);
  });

  test('hard-cuts password-change endpoints', async () => {
    const responses = await Promise.all(
      ['start', 'finish'].map((operation) =>
        handle(
          new Request(`https://merkur.test/api/auth/password/change/${operation}`, {
            method: 'POST',
            headers: {
              authorization: 'Bearer token-1',
              'content-type': 'application/json',
            },
            body: JSON.stringify({}),
          }),
        ),
      ),
    );

    expect(responses.map((response) => response.status)).toEqual([404, 404]);
  });

  test('answers an unauthenticated API request with JSON, not a bare string', async () => {
    const response = await handle(
      new Request('https://merkur.test/api/link-token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pairingId: PAIRING_ID }),
      }),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toEqual({ error: 'unauthorized' });
    expectSecurityHeaders(response);
  });

  test('authenticates before validating a protected request body', async () => {
    const response = await handle(
      new Request('https://merkur.test/api/devices/device-1', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '' }),
      }),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'unauthorized' });
    expectSecurityHeaders(response);
  });

  test('preserves schema-authored validation details without reflecting the request', async () => {
    // Empty, and one code point past the bound every response holds a name to.
    for (const name of ['', 'n'.repeat(129), '👍'.repeat(129)]) {
      const response = await handle(
        new Request('https://merkur.test/api/devices/device-1', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', authorization: 'Bearer token-1' },
          body: JSON.stringify({ name }),
        }),
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: 'invalid_request',
        details: 'device name must be 1 to 128 characters',
      });
    }
  });

  test('answers the version probe with exactly the response the browser checks it against', async () => {
    const response = await handle(new Request('https://merkur.test/api/version'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(Value.Check(ServerVersionResponse, body)).toBe(true);
    expect(Object.keys(body)).toEqual(['version']);
  });

  test('answers an unknown API path with the documented 404 shape', async () => {
    const response = await handle(new Request('https://merkur.test/api/does-not-exist'));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not_found' });
    expectSecurityHeaders(response);
  });

  test('answers an unknown non-GET path with the documented 404 shape', async () => {
    // The web catch-all only registers GET, so this reaches Elysia's built-in
    // not-found path rather than `webRoutesPlugin`.
    const response = await handle(
      new Request('https://merkur.test/definitely-not-a-route', { method: 'POST' }),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not_found' });
    expectSecurityHeaders(response);
  });

  test('does not leak an unmapped failure message', async () => {
    // Deliberate dummy credential for the error-redaction assertion below.
    const secret = 'postgres://user:hunter2@db.internal/merkur'; // trufflehog:ignore
    const response = await handle(
      new Request('https://merkur.test/api/link-token', {
        method: 'POST',
        headers: {
          authorization: 'Bearer token-1',
          'content-type': 'application/json',
        },
        body: JSON.stringify({}),
      }),
      {
        createLinkToken: () => Effect.die(new Error(secret)),
      },
    );

    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).not.toContain(secret);
    expect(body).not.toContain('hunter2');
    expect(JSON.parse(body)).toEqual({ error: 'internal_error' });
    expectSecurityHeaders(response);
  });

  test('serves an unauthenticated route without an auth challenge', async () => {
    const response = await handle(new Request('https://merkur.test/api/version'));

    expect(response.status).toBe(200);
    expect(await response.json()).toHaveProperty('version');
    expectSecurityHeaders(response);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('server app website waitlist', () => {
  test("accepts the website's url-encoded post with its CORS headers", async () => {
    const response = await handle(
      waitlistPost(WEBSITE.origin, 'email=person%40example.com'),
      {},
      WEBSITE,
    );

    expect(response.status).toBe(204);
    expectWebsiteCors(response);
    expectSecurityHeaders(response);
  });

  test('keeps the CORS headers on the error contract, so the page can read why', async () => {
    const response = await handle(waitlistPost(WEBSITE.origin, 'email=a'), {}, WEBSITE);

    expect(response.status).toBe(400);
    expect(await response.json()).toHaveProperty('error', 'invalid_request');
    expectWebsiteCors(response);
    expectSecurityHeaders(response);
  });

  test('refuses a post from any origin but the website', async () => {
    const response = await handle(
      waitlistPost('https://merkur.test', 'email=a%40b.io'),
      {},
      WEBSITE,
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'origin_forbidden' });
    expectWebsiteCors(response);
    expectSecurityHeaders(response);
  });

  test('has no waitlist route on a deployment without a website', async () => {
    const response = await handle(waitlistPost(WEBSITE.origin, 'email=person%40example.com'));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not_found' });
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });
});

function waitlistPost(origin: string, body: string): Request {
  return new Request('https://merkur.test/api/box-waitlist', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin },
    body,
  });
}

function expectWebsiteCors(response: Response): void {
  expect(response.headers.get('access-control-allow-origin')).toBe(WEBSITE.origin);
  expect(response.headers.get('vary')).toBe('Origin');
}

function expectSecurityHeaders(response: Response): void {
  expect(response.headers.get('Content-Security-Policy')).toContain("default-src 'self'");
  expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
  expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
  expect(response.headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin');
}

function handle(
  request: Request,
  deviceOverrides: Partial<DeviceService> = {},
  website: ServerConfig['website'] = undefined,
): Promise<Response> {
  const config = { ...createConfig(), website };
  const runProgram = makeRunServerProgram(config, deviceOverrides);
  const app = createServerApp({
    deviceEventsLifetime: createDeviceEventsSseLifetime(),
    config,
    runServerProgram: runProgram,
    authorizeRequest: createAuthorizeRequest(runProgram),
    logger: createLogger('server-app-test'),
    webIndexFile: '/nonexistent/index.html',
    webDistDirectory: '/nonexistent',
  });
  return app.handle(request);
}

function createDeviceService(overrides: Partial<DeviceService>): DeviceService {
  const unexpected = (name: string) =>
    Effect.die(new Error(`unexpected device service call: ${name}`));
  return {
    listDevices: () => unexpected('listDevices'),
    getDevice: () => unexpected('getDevice'),
    createLinkToken: () => unexpected('createLinkToken'),
    resolveBox: () => unexpected('resolveBox'),
    listAccountBoxes: () => unexpected('listAccountBoxes'),
    getDaemonSessionIdentity: () => unexpected('getDaemonSessionIdentity'),
    renameDevice: () => unexpected('renameDevice'),
    deleteDevice: () => unexpected('deleteDevice'),
    authenticateDaemonProof: () => unexpected('authenticateDaemonProof'),
    touchDaemon: () => unexpected('touchDaemon'),
    touchDaemonsSeen: () => unexpected('touchDaemonsSeen'),
    ...overrides,
  };
}

function createAuthService(): AuthService {
  const unexpected = (name: string) =>
    Effect.die(new Error(`unexpected auth service call: ${name}`));
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
    // Any bearer token presented by these probes is treated as valid, so the
    // 401 case is reached only when no token is sent at all.
    verifyBearerToken: () =>
      Effect.succeed({
        userId: 'user-1',
        delegationId: 'delegation-1',
        delegationExpiresAt: Date.now() + 60_000,
      }),
    listBrowserSessions: () => unexpected('listBrowserSessions'),
    revokeBrowserSessions: () => unexpected('revokeBrowserSessions'),
    requireActiveDelegation: () => unexpected('requireActiveDelegation'),
    scheduleAccountDeletion: () => unexpected('scheduleAccountDeletion'),
    accountsDueForDeletion: () => unexpected('accountsDueForDeletion'),
    purgeAccount: () => unexpected('purgeAccount'),
  };
}

function createConfig(): ServerConfig {
  return {
    host: '0.0.0.0',
    port: 3000,
    dbUrl: ':memory:',
    dbAuthToken: undefined,
    redisUrl: Redacted.make('redis://127.0.0.1:6379'),
    publicOrigin: 'https://merkur.test',
    website: undefined,
    accessTokenHmacKey: new Uint8Array(64),
    jwtIssuer: 'merkur-test',
    jwtAudience: 'merkur-test',
    tokenHmacSecret: Redacted.make('hmac-secret'),
    authAllowRegistration: true,
    authIdentity: 'username',
    emailDelivery: undefined,
    opaqueServerSetup: Redacted.make(Buffer.alloc(128).toString('base64url')),
    opaqueServerPublicKey: Buffer.alloc(32).toString('base64url'),
    trustedProxyHops: 1,
    sessionTokenSigningKey: deriveSessionAuthorizationKeyPair(new Uint8Array(32)).signingKey,
    sessionTokenVerifyKeyB64: 'A'.repeat(3_456),
    sessionTokenTtlMs: 60_000,
    webPush: undefined,
    edgeRegistrationKeys: new Map(),
    telemetry: undefined,
    traceLevel: 'Info',
    traceSampleRatio: 1,
    traceSlowThresholdMs: 1_000,
    boxHost: undefined,
    stunTicketKey: new Uint8Array(64),
    edgeAttachTicketKey: new Uint8Array(64).fill(11),
    stunServers: ['stun.test:3478', 'stun.test:3479'],
    boxHostStunObservers: [],
  };
}

function makeRunServerProgram(
  config: ServerConfig,
  deviceOverrides: Partial<DeviceService>,
): typeof runServerProgram {
  const rateLimit: RateLimitService = {
    consume: () => Effect.succeed({ allowed: true }),
  };
  const layer = Layer.mergeAll(
    Layer.succeed(ServerConfigService, config),
    Layer.succeed(DeviceServiceTag, createDeviceService(deviceOverrides)),
    Layer.succeed(AuthServiceTag, createAuthService()),
    Layer.succeed(RateLimitServiceTag, rateLimit),
    Layer.succeed(BoxWaitlistServiceTag, {
      record: () => Effect.succeed({ inserted: false }),
    }),
    Layer.succeed(RybbitEventsTag, { send: () => Effect.void }),
  );
  return ((program) =>
    Effect.runPromise(
      Effect.provide(program as Effect.Effect<unknown, unknown, never>, layer),
    )) as typeof runServerProgram;
}
