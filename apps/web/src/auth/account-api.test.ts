import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  deriveDaemonIdentityKeyCommitment,
  deriveDaemonLinkClaimCommitment,
  USER_DELEGATION_LIFETIME_MS,
} from '@merkur/shared/user-authorization';
import { installBrowserLocks } from '../../../../tests/helpers/browser-locks';
import {
  type AuthenticationStartResponse,
  fetchAuthPolicy,
  finishLoginRequest,
  finishPasswordResetRequest,
  finishRegistrationRequest,
  inspectDaemonLinkClaim,
  logoutAccountSession,
  requestEmailCode,
  requestPasswordResetCode,
  startAuthenticationRequest,
  startPasswordResetRequest,
  verifyPasswordResetCode,
  withAccountCookieLock,
} from './account-api';
import { TEST_DELEGATION_CERTIFICATE } from './test-authorization-fixtures';

const ORIGIN = 'https://merkur.test';
const ISSUED_AT = 10_000;

// Responses are checked against the server's own schemas, so every stand-in is
// what the server sends: canonical base64url of the value's byte count.
const ONE_USE_FLOW = encoded(32, 1);

const DIFFERENT_FLOW = encoded(32, 2);

const CODE_FLOW = encoded(32, 3);

const PROVEN_FLOW = encoded(32, 4);

const LOGIN_RESPONSE = encoded(320, 5);

const REGISTRATION_RESPONSE = encoded(64, 6);

const originalFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
const originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');

beforeAll(() => {
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { origin: ORIGIN },
  });
});

afterAll(() => {
  restoreGlobal('fetch', originalFetch);
  restoreGlobal('location', originalLocation);
});

describe('account authentication start API', () => {
  test('sends both OPAQUE starts and accepts only the shared-flow response', async () => {
    const responseBody = authenticationStartResponse();
    let requestUrl = '';
    let requestInit: RequestInit | undefined;
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: (input: string | URL | Request, init?: RequestInit) => {
        requestUrl = String(input);
        requestInit = init;
        return Promise.resolve(jsonResponse(responseBody));
      },
    });

    const response = await startAuthenticationRequest(
      'dmitriy@example.test',
      'opaque-login-start',
      'opaque-registration-start',
    );

    expect(new URL(requestUrl).pathname).toBe('/api/auth/start');
    expect(requestInit?.method).toBe('POST');
    expect(requestInit?.credentials).toBe('include');
    const body = JSON.parse(String(requestInit?.body)) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['username', 'startLoginRequest', 'registrationRequest']);
    expect(body).toEqual({
      username: 'dmitriy@example.test',
      startLoginRequest: 'opaque-login-start',
      registrationRequest: 'opaque-registration-start',
    });
    expect(response).toEqual(responseBody);
  });

  test('rejects branches that are not bound to the same one-use flow', async () => {
    const responseBody = authenticationStartResponse();
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: () =>
        Promise.resolve(
          jsonResponse({
            ...responseBody,
            registration: { ...responseBody.registration, flowId: DIFFERENT_FLOW },
          }),
        ),
    });

    await expect(
      startAuthenticationRequest('dmitriy@example.test', 'login-start', 'registration-start'),
    ).rejects.toThrow('Invalid account authentication start response');
  });

  test('rejects a branch offering any delegation lifetime but the one, and a malformed branch', async () => {
    const { login, registration } = authenticationStartResponse();
    const cases: ReadonlyArray<readonly [AuthenticationStartResponse, string]> = [
      [
        { login: { ...login, delegationExpiresAt: login.delegationExpiresAt + 1 }, registration },
        'Invalid account login response',
      ],
      [
        {
          login,
          registration: {
            ...registration,
            delegationExpiresAt: registration.delegationExpiresAt + 1,
          },
        },
        'Invalid account registration response',
      ],
      [
        { login: { ...login, rootPublicKey: login.rootPublicKey.replace('A', '+') }, registration },
        'Invalid account authentication start response at /login/rootPublicKey (pattern)',
      ],
      [
        {
          login: { ...login, rootEnvelope: { ...login.rootEnvelope, nonce: 'AgICAgICAgICAgI=' } },
          registration,
        },
        'Invalid account authentication start response at /login/rootEnvelope/nonce (pattern)',
      ],
      [
        { login: { ...login, rootEpoch: 0 }, registration },
        'Invalid account authentication start response at /login/rootEpoch (minimum)',
      ],
      [
        // 32 bytes leave two spare bits in the last character; `R` sets them.
        { login, registration: { ...registration, flowId: `${ONE_USE_FLOW.slice(0, -1)}R` } },
        'Invalid account authentication start response at /registration/flowId (pattern)',
      ],
    ];
    for (const [body, message] of cases) {
      Object.defineProperty(globalThis, 'fetch', {
        configurable: true,
        value: () => Promise.resolve(jsonResponse(body)),
      });
      await expect(
        startAuthenticationRequest('dmitriy@example.test', 'login-start', 'registration-start'),
      ).rejects.toThrow(message);
    }
  });
});

describe('email identity API', () => {
  test('reads the policy and refuses any other shape', async () => {
    let answer: unknown = { identity: 'email', registration: false };
    let requestUrl = '';
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: (input: string | URL | Request) => {
        requestUrl = String(input);
        return Promise.resolve(jsonResponse(answer));
      },
    });

    expect(await fetchAuthPolicy()).toEqual({ identity: 'email', registration: false });
    expect(new URL(requestUrl).pathname).toBe('/api/auth/policy');

    for (const [invalid, where] of [
      [{ identity: 'phone', registration: true }, '/identity (anyOf)'],
      [{ identity: 'email' }, '/registration (required)'],
      [{ identity: 'email', registration: true, extra: 1 }, '/ (additionalProperties)'],
    ] as const) {
      answer = invalid;
      await expect(fetchAuthPolicy()).rejects.toThrow(
        `Invalid authentication policy response at ${where}`,
      );
    }
  });

  test('asks for a code by flow id alone', async () => {
    let requestInit: RequestInit | undefined;
    let requestUrl = '';
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: (input: string | URL | Request, init?: RequestInit) => {
        requestUrl = String(input);
        requestInit = init;
        return Promise.resolve(jsonResponse({ sent: true }));
      },
    });

    await requestEmailCode('one-use-flow');

    expect(new URL(requestUrl).pathname).toBe('/api/auth/register/code');
    expect(requestInit?.method).toBe('POST');
    expect(JSON.parse(String(requestInit?.body))).toEqual({ flowId: 'one-use-flow' });
  });
});

describe('password reset API', () => {
  function answer(body: unknown) {
    const requests: Array<{ path: string; body: unknown }> = [];
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: (input: string | URL | Request, init?: RequestInit) => {
        requests.push({
          path: new URL(String(input)).pathname,
          body: JSON.parse(String(init?.body)),
        });
        return Promise.resolve(jsonResponse(body));
      },
    });
    return requests;
  }

  test('asks for a code by address and accepts only a flow id back', async () => {
    const requests = answer({ flowId: CODE_FLOW });
    expect(await requestPasswordResetCode('someone@example.test')).toBe(CODE_FLOW);
    expect(requests).toEqual([
      { path: '/api/auth/reset/code', body: { username: 'someone@example.test' } },
    ]);

    for (const invalid of [
      {},
      { flowId: '' },
      { flowId: 'code-flow' },
      { flowId: CODE_FLOW, exists: true },
    ]) {
      answer(invalid);
      await expect(requestPasswordResetCode('someone@example.test')).rejects.toThrow(
        'Invalid password reset code response',
      );
    }
  });

  test('a verified code returns the proven flow and exactly the devices it will destroy', async () => {
    const devices = [
      { name: 'laptop', platform: 'macOS', box: false },
      { name: 'calm-harbor', platform: 'linux', box: true },
    ];
    const requests = answer({ flowId: PROVEN_FLOW, devices });
    expect(await verifyPasswordResetCode('code-flow', '123456')).toEqual({
      flowId: PROVEN_FLOW,
      devices,
    });
    expect(requests).toEqual([
      { path: '/api/auth/reset/verify', body: { flowId: 'code-flow', emailCode: '123456' } },
    ]);

    for (const invalid of [
      { flowId: PROVEN_FLOW },
      { flowId: PROVEN_FLOW, devices: [{ name: 'laptop', platform: 'macOS' }] },
      { flowId: PROVEN_FLOW, devices: [{ name: '', platform: 'macOS', box: false }] },
      { flowId: PROVEN_FLOW, devices: [{ name: 'laptop', platform: 'macOS', box: 1 }] },
    ]) {
      answer(invalid);
      await expect(verifyPasswordResetCode('code-flow', '123456')).rejects.toThrow(
        'Invalid password reset verification response',
      );
    }
  });

  test('the start step never accepts the first epoch or a wrong delegation lifetime', async () => {
    const start = {
      userId: 'user-1',
      registrationResponse: REGISTRATION_RESPONSE,
      rootEpoch: 2,
      delegationIssuedAt: ISSUED_AT,
      delegationExpiresAt: ISSUED_AT + USER_DELEGATION_LIFETIME_MS,
    };
    const requests = answer(start);
    expect(await startPasswordResetRequest('proven-flow', 'opaque-registration-start')).toEqual(
      start,
    );
    expect(requests).toEqual([
      {
        path: '/api/auth/reset/start',
        body: { flowId: 'proven-flow', registrationRequest: 'opaque-registration-start' },
      },
    ]);

    for (const invalid of [
      { ...start, rootEpoch: 1 },
      { ...start, delegationExpiresAt: start.delegationExpiresAt + 1 },
      { ...start, flowId: 'proven-flow' },
    ]) {
      answer(invalid);
      await expect(
        startPasswordResetRequest('proven-flow', 'opaque-registration-start'),
      ).rejects.toThrow('Invalid password reset start response');
    }
  });
});

function authenticationStartResponse(): AuthenticationStartResponse {
  const delegationExpiresAt = ISSUED_AT + USER_DELEGATION_LIFETIME_MS;
  return {
    login: {
      flowId: ONE_USE_FLOW,
      userId: 'user-1',
      loginResponse: LOGIN_RESPONSE,
      rootPublicKey: encoded(2_592, 1),
      rootEnvelope: { nonce: encoded(12, 2), ciphertext: encoded(48, 3) },
      rootEpoch: 1,
      delegationIssuedAt: ISSUED_AT,
      delegationExpiresAt,
    },
    registration: {
      flowId: ONE_USE_FLOW,
      userId: 'user-1',
      registrationResponse: REGISTRATION_RESPONSE,
      delegationIssuedAt: ISSUED_AT,
      delegationExpiresAt,
    },
  };
}

/** Canonical unpadded base64url of `bytes` bytes, each `fill`. */
function encoded(bytes: number, fill: number): string {
  return Buffer.alloc(bytes, fill).toString('base64url');
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function restoreGlobal(
  key: 'fetch' | 'location',
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor === undefined) {
    Reflect.deleteProperty(globalThis, key);
    return;
  }
  Object.defineProperty(globalThis, key, descriptor);
}

test('inspects a composite daemon claim in its canonical commitment order', async () => {
  const mldsa = new Uint8Array(2592).fill(1);
  // The commitment validates the daemon P-256 key as a curve point, so it must be one.
  const { publicKey } = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  );
  const p256 = new Uint8Array(await crypto.subtle.exportKey('raw', publicKey));
  const claim = {
    linkClaimId: 'link-claim-1',
    daemonId: 'daemon-1',
    daemonIdentityPublicKey: Buffer.from(mldsa).toString('base64url'),
    daemonIdentityP256PublicKey: Buffer.from(p256).toString('base64url'),
    daemonIdentityKeyCommitment: deriveDaemonIdentityKeyCommitment(mldsa, p256),
    name: 'Test Mac',
    platform: 'darwin',
    identitySealBackend: 'hardware' as const,
  };
  const response = {
    ...claim,
    claimCommitment: deriveDaemonLinkClaimCommitment(claim, new Uint8Array(32).fill(3)),
    serverNonce: Buffer.alloc(32, 4).toString('base64url'),
    serverTimeMs: ISSUED_AT,
  };
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: () => Promise.resolve(jsonResponse(response)),
  });
  expect(await inspectDaemonLinkClaim('access-token', claim.linkClaimId)).toEqual(response);

  const answer = (body: unknown) =>
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: () => Promise.resolve(jsonResponse(body)),
    });

  // The schema states canonical encoding itself: 32 bytes leave two spare bits
  // in the last character, and `R` sets them.
  answer({ ...response, serverNonce: `${response.serverNonce.slice(0, -1)}R` });
  await expect(inspectDaemonLinkClaim('access-token', claim.linkClaimId)).rejects.toThrow(
    'Invalid daemon-link inspection response at /serverNonce (pattern)',
  );
  answer({ ...response, claimCommitment: `${response.claimCommitment.slice(0, -1)}!` });
  await expect(inspectDaemonLinkClaim('access-token', claim.linkClaimId)).rejects.toThrow(
    'Invalid daemon-link inspection response at /claimCommitment (pattern)',
  );
  answer({ ...response, pollToken: 'not-the-browser-s-to-see' });
  await expect(inspectDaemonLinkClaim('access-token', claim.linkClaimId)).rejects.toThrow(
    'Invalid daemon-link inspection response at / (additionalProperties)',
  );

  // What the schema cannot say stays with the claim: a commitment of the right
  // form that is not this key's.
  answer({ ...response, daemonIdentityKeyCommitment: encoded(64, 7) });
  await expect(inspectDaemonLinkClaim('access-token', claim.linkClaimId)).rejects.toThrow(
    'daemon identity key commitment does not match its public key',
  );
});

for (const finish of ['login', 'registration', 'reset'] as const) {
  test(`a delayed logout response cannot erase the fresh ${finish} cookie`, async () => {
    let releaseFirst: () => void = () => {},
      firstStarted: () => void = () => {},
      queued: () => void = () => {};
    const firstResponse = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      queued = resolve;
    });
    const restoreLocks = installBrowserLocks(() => queued());
    let cookie = 'old',
      logouts = 0;
    const certificate = TEST_DELEGATION_CERTIFICATE;
    const authorization = {
      actorCertificate: certificate,
      revocation: {
        userId: certificate.userId,
        rootKeyCommitment: certificate.rootKeyCommitment,
        actorDelegationId: certificate.delegationId,
        targets: [{ delegationId: certificate.delegationId, expiresAt: certificate.expiresAt }],
        issuedAt: 10,
        nonce: encoded(32, 11),
        signature: encoded(4627, 12),
      },
    };
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: async (input: string | URL | Request) => {
        const path = new URL(String(input)).pathname;
        if (path === '/api/auth/logout') {
          logouts++;
          if (logouts === 1) {
            firstStarted();
            await firstResponse;
          }
          cookie = '';
          return jsonResponse({ ok: true });
        }
        const ceremony = finish === 'registration' ? 'register' : finish;
        if (path !== `/api/auth/${ceremony}/finish`) throw new Error(`unexpected ${path}`);
        cookie = 'fresh';
        return jsonResponse({
          accessToken: 'fresh-token',
          userId: 'user-1',
          delegationId: 'new-delegation',
          delegationExpiresAt: ISSUED_AT + USER_DELEGATION_LIFETIME_MS,
          serverTimeMs: ISSUED_AT,
          deletionCancelled: false,
        });
      },
    });
    try {
      const first = logoutAccountSession(authorization);
      await started;
      const body = {
        flowId: ONE_USE_FLOW,
        registrationRecord: 'registration-record',
        rootPublicKey: authenticationStartResponse().login.rootPublicKey,
        rootEnvelope: authenticationStartResponse().login.rootEnvelope,
        delegationCertificate: certificate,
      };
      const login = logoutAccountSession(authorization).then(() => {
        if (finish === 'registration')
          return finishRegistrationRequest({ ...body, emailCode: null });
        if (finish === 'reset') return finishPasswordResetRequest(body);
        return finishLoginRequest(ONE_USE_FLOW, 'finish', certificate);
      });
      // Both branches are real progress signals: unprotected login completes,
      // while protected delivery instead queues behind the first response.
      await Promise.race([login, waiting]);
      releaseFirst();
      await Promise.all([first, login]);
      expect(logouts).toBe(2);
      expect(cookie).toBe('fresh');
    } finally {
      releaseFirst();
      restoreLocks();
    }
  });
}

test('a cancelled authentication finish never delivers after waiting for the cookie lock', async () => {
  const restoreLocks = installBrowserLocks();
  let release: () => void = () => {},
    entered: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let fetches = 0;
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: async () => {
      fetches++;
      throw new Error('cancelled finish reached delivery');
    },
  });
  const holder = withAccountCookieLock(() => {
    entered();
    return gate;
  });
  try {
    await started;
    const controller = new AbortController();
    const finish = finishLoginRequest(
      ONE_USE_FLOW,
      'finish',
      TEST_DELEGATION_CERTIFICATE,
      controller.signal,
    );
    controller.abort(new Error('cancelled finish'));
    await expect(finish).rejects.toThrow('cancelled finish');
    release();
    await holder;
    expect(fetches).toBe(0);
  } finally {
    release();
    restoreLocks();
  }
});
