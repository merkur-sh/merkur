/**
 * The AuthService suite's shared state and its real-OPAQUE client.
 *
 * Every password flow here runs the production Argon2id stretching, about 0.2 s per finish, so
 * the suite is split across files and the bun lane's workers run them side by side; in one file
 * it was the lane's slowest. A test file calls `useAuthServiceFixture()` once. `db`, `service`
 * and `published` are live bindings: a test reads what its `beforeEach` made, and replaces the
 * service through `setService`.
 */
import { beforeEach, expect } from 'bun:test';
import { createOpaqueServerSetup } from '@merkur/auth';
import { AuthSessionResponse, AuthStartResponse } from '@merkur/shared/api-schema';
import { OPAQUE_PASSWORD_STRETCHING } from '@merkur/shared/opaque-password-policy';
import {
  createUserDelegationCertificate,
  deriveUserAuthorizationSigningKey,
  deriveUserRootKeyCommitment,
  encodeUserAuthorizationBytes,
  USER_DELEGATION_LIFETIME_MS,
  type UserDelegationCertificate,
} from '@merkur/shared/user-authorization';
import * as opaque from '@serenity-kit/opaque';
import { Effect } from 'effect';
import type { Kysely } from 'kysely';
import { Value } from 'typebox/value';
import { createMigratedKyselyDatabase } from '../db/migrate';
import type { DatabaseSchema } from '../db/types';
import {
  type AuthService,
  type AuthServiceConfig,
  type AuthSessionResult,
  createAuthService,
} from './auth-service';
import type { MailSender } from './mail-sender';
import { deliverPendingNotifications } from './notification-outbox-service';
import type { RedisCommandClient, RedisService } from './redis-service';

export const ORIGIN = 'https://merkur.test';
export const USERNAME = 'user@example.com';
/** One parsed client for every issuance in this suite; nothing here asserts on it. */
export const TEST_CLIENT = { browser: 'Chrome', platform: 'macOS', installed: false } as const;

export const OLD_PASSWORD = 'correct horse battery staple';
export const ROOT = deriveUserAuthorizationSigningKey(new Uint8Array(32).fill(0x11));
export const ROOT_PUBLIC_KEY = encodeUserAuthorizationBytes(ROOT.publicKey);
export const ROOT_KEY_COMMITMENT = deriveUserRootKeyCommitment(ROOT.publicKey);

export let db: Kysely<DatabaseSchema>;
export let service: AuthService;
export const published: Array<{ channel: string; message: string }> = [];

export function useAuthServiceFixture(): void {
  beforeEach(async () => {
    published.length = 0;
    await opaque.ready;
    db = await createMigratedKyselyDatabase<DatabaseSchema>(':memory:');
    service = createAuthService(
      db,
      createFakeRedis(),
      {
        accessToken: {
          hmacKey: new Uint8Array(64).fill(0x44),
          issuer: 'merkur-test',
          audience: 'merkur-test',
        },
        tokenHmacSecret: 'test-token-hmac-secret',
        allowRegistration: true,
        identity: { kind: 'username' },
        opaqueServerSetup: await createOpaqueServerSetup(),
        publicOrigin: ORIGIN,
      },
      deliverPendingNotifications(db, createFakeRedis()).pipe(Effect.orDie),
    );
  });
}

export function setService(next: AuthService): void {
  service = next;
}

export interface SentMail {
  readonly kind: 'code' | 'already-registered' | 'reset-code' | 'reset-no-account' | 'reset-done';
  readonly to: string;
  readonly code: string | null;
  readonly idempotencyKey: string;
}

export function recordingMail(sent: SentMail[]): MailSender {
  const notice = (kind: SentMail['kind']) => (input: { to: string; idempotencyKey: string }) =>
    Effect.sync(() => {
      sent.push({ kind, to: input.to, code: null, idempotencyKey: input.idempotencyKey });
    });
  const code =
    (kind: SentMail['kind']) => (input: { to: string; code: string; idempotencyKey: string }) =>
      Effect.sync(() => {
        sent.push({ kind, to: input.to, code: input.code, idempotencyKey: input.idempotencyKey });
      });
  return {
    sendSignUpCode: code('code'),
    sendAlreadyRegistered: notice('already-registered'),
    sendPasswordResetCode: code('reset-code'),
    sendPasswordResetNoAccount: notice('reset-no-account'),
    sendPasswordWasReset: notice('reset-done'),
  };
}

/** Replaces the fixture's service with an email-identity one that records its mail into `sent`. */
export async function useEmailIdentity(
  sent: SentMail[],
  overrides: Partial<AuthServiceConfig> = {},
): Promise<void> {
  service = createAuthService(
    db,
    createFakeRedis(),
    {
      accessToken: {
        hmacKey: new Uint8Array(64).fill(0x44),
        issuer: 'merkur-test',
        audience: 'merkur-test',
      },
      tokenHmacSecret: 'test-token-hmac-secret',
      allowRegistration: true,
      identity: { kind: 'email', mail: recordingMail(sent) },
      opaqueServerSetup: await createOpaqueServerSetup(),
      publicOrigin: ORIGIN,
      ...overrides,
    },
    deliverPendingNotifications(db, createFakeRedis()).pipe(Effect.orDie),
  );
}

export async function registerAccount(
  password: string,
  delegateByte: number,
  delegationId: string,
) {
  return finishRegistration(await startClientAndServerAuth(password), delegateByte, delegationId);
}

export function browser(actor: Awaited<ReturnType<typeof registerAccount>>) {
  return {
    userId: actor.userId,
    delegationId: actor.certificate.delegationId,
    delegationExpiresAt: actor.certificate.expiresAt,
  };
}

// A code retry can reuse the registration record for its OPAQUE flow.
// Repeating password stretching would test client CPU cost for every server-side guess.
const registrationRecords = new WeakMap<
  Awaited<ReturnType<typeof startClientAndServerAuth>>,
  string
>();

export async function finishRegistration(
  started: Awaited<ReturnType<typeof startClientAndServerAuth>>,
  delegateByte: number,
  delegationId: string,
  emailCode: string | null = null,
) {
  const start = started.server.registration;
  let registrationRecord = registrationRecords.get(started);
  if (registrationRecord === undefined) {
    registrationRecord = opaque.client.finishRegistration({
      password: started.password,
      clientRegistrationState: started.registration.clientRegistrationState,
      registrationResponse: start.registrationResponse,
      identifiers: { client: start.userId, server: ORIGIN },
      keyStretching: OPAQUE_PASSWORD_STRETCHING,
    }).registrationRecord;
    registrationRecords.set(started, registrationRecord);
  }
  const delegate = deriveUserAuthorizationSigningKey(new Uint8Array(32).fill(delegateByte));
  const certificate = makeCertificate(
    start.userId,
    delegationId,
    delegate,
    start.delegationIssuedAt,
    start.delegationExpiresAt,
  );
  const session = await Effect.runPromise(
    service.finishRegistration({
      flowId: start.flowId,
      emailCode,
      registrationRecord,
      rootPublicKey: ROOT_PUBLIC_KEY,
      rootEnvelope: envelope(0x22),
      delegationCertificate: certificate,
      client: TEST_CLIENT,
    }),
  );
  expectSessionResponse(session);
  return { userId: start.userId, delegate, certificate, session };
}

export async function loginWithNewDelegation(
  password: string,
  delegateByte: number,
  delegationId: string,
) {
  const login = await startClientAndServerLogin(password);
  const clientFinish = finishClientLogin(password, login);
  const delegate = deriveUserAuthorizationSigningKey(new Uint8Array(32).fill(delegateByte));
  const certificate = makeCertificate(
    login.server.userId,
    delegationId,
    delegate,
    login.server.delegationIssuedAt,
    login.server.delegationExpiresAt,
  );
  const session = await Effect.runPromise(
    service.finishLogin({
      flowId: login.server.flowId,
      finishLoginRequest: clientFinish.finishLoginRequest,
      delegationCertificate: certificate,
      client: TEST_CLIENT,
    }),
  );
  expectSessionResponse(session);
  return { delegate, certificate, session };
}

export async function startClientAndServerLogin(password: string) {
  const started = await startClientAndServerAuth(password);
  return { client: started.login, server: started.server.login };
}

export async function startClientAndServerAuth(password: string, username = USERNAME) {
  const login = opaque.client.startLogin({ password });
  const registration = opaque.client.startRegistration({ password });
  const server = await Effect.runPromise(
    service.startAuth(username, login.startLoginRequest, registration.registrationRequest),
  );
  // Every start in the suite, for an account that exists and for one that does
  // not, is a response the browser will check against this schema.
  expect(Value.Check(AuthStartResponse, server)).toBe(true);
  return { password, login, registration, server };
}

/** The session a finish route answers with is the service's, less the cookie it sets. */
function expectSessionResponse(session: AuthSessionResult): void {
  const { refreshCookieHeader: _cookie, ...response } = session;
  expect(Value.Check(AuthSessionResponse, response)).toBe(true);
}

export function finishClientLogin(
  password: string,
  login: Awaited<ReturnType<typeof startClientAndServerLogin>>,
) {
  const finished = opaque.client.finishLogin({
    password,
    clientLoginState: login.client.clientLoginState,
    loginResponse: login.server.loginResponse,
    identifiers: { client: login.server.userId, server: ORIGIN },
    keyStretching: OPAQUE_PASSWORD_STRETCHING,
  });
  if (finished === undefined) throw new Error('OPAQUE login unexpectedly failed');
  return finished;
}

function makeCertificate(
  userId: string,
  delegationId: string,
  delegate: ReturnType<typeof deriveUserAuthorizationSigningKey>,
  issuedAt: number,
  expiresAt: number,
): UserDelegationCertificate {
  expect(expiresAt - issuedAt).toBe(USER_DELEGATION_LIFETIME_MS);
  return createUserDelegationCertificate(
    {
      userId,
      rootKeyCommitment: ROOT_KEY_COMMITMENT,
      delegationId,
      delegatePublicKey: encodeUserAuthorizationBytes(delegate.publicKey),
      scopes: ['terminal-session', 'session-revoke'],
      serverOrigin: ORIGIN,
      rootEpoch: 1,
      issuedAt,
      expiresAt,
    },
    ROOT,
  );
}

export function envelope(byte: number) {
  return {
    nonce: Buffer.alloc(12, byte).toString('base64url'),
    ciphertext: Buffer.alloc(48, byte).toString('base64url'),
  };
}

export function createFakeRedis(): RedisService {
  const values = new Map<string, string>();
  const hashes = new Map<string, Map<string, string>>();
  const hash = (key: string) => {
    const existing = hashes.get(key);
    if (existing !== undefined) return existing;
    const created = new Map<string, string>();
    hashes.set(key, created);
    return created;
  };
  // One handler per command the service sends. `undefined` is a call this fake does not
  // model, which `sendCommand` raises; `null` is Redis's nil reply.
  type Reply = string | number | null;
  const replies = new Map<string, (args: readonly string[]) => Reply | undefined>([
    [
      'SET',
      ([key, value]) => {
        if (key === undefined || value === undefined) return undefined;
        if (values.has(key)) return null;
        values.set(key, value);
        return 'OK';
      },
    ],
    [
      'GETDEL',
      ([key]) => {
        if (key === undefined) return undefined;
        const stored = values.get(key) ?? null;
        values.delete(key);
        return stored;
      },
    ],
    ['GET', ([key]) => (key === undefined ? undefined : (values.get(key) ?? null))],
    // Expiry is not modelled: these tests never outlive a flow.
    [
      'PEXPIRE',
      ([key]) => {
        if (key === undefined) return undefined;
        return values.has(key) || hashes.has(key) ? 1 : 0;
      },
    ],
    [
      'DEL',
      (targets) => {
        for (const target of targets) {
          values.delete(target);
          hashes.delete(target);
        }
        return 1;
      },
    ],
    [
      'HSET',
      ([key, field, value]) => {
        if (key === undefined || field === undefined || value === undefined) return undefined;
        hash(key).set(field, value);
        return 1;
      },
    ],
    [
      'HSETNX',
      ([key, field, value]) => {
        if (key === undefined || field === undefined || value === undefined) return undefined;
        const target = hash(key);
        if (target.has(field)) return 0;
        target.set(field, value);
        return 1;
      },
    ],
    [
      'HINCRBY',
      ([key, field, value]) => {
        if (key === undefined || field === undefined || value === undefined) return undefined;
        const target = hash(key);
        const next = Number(target.get(field) ?? '0') + Number(value);
        target.set(field, String(next));
        return next;
      },
    ],
    [
      'HGET',
      ([key, field]) => {
        if (key === undefined || field === undefined) return undefined;
        return hashes.get(key)?.get(field) ?? null;
      },
    ],
    // The one script these services run is the device-list resync, which
    // publishes on its second key; the cursor it advances is not modelled.
    [
      'EVAL',
      ([, , , channel]) => {
        if (channel === undefined) return undefined;
        published.push({ channel, message: 'resync' });
        return 1;
      },
    ],
  ]);
  const commands: RedisCommandClient = {
    async sendCommand<T>(args: string[]): Promise<T> {
      const [command, ...rest] = args;
      const reply = command === undefined ? undefined : replies.get(command)?.(rest);
      if (reply === undefined) throw new Error(`unexpected Redis command: ${args.join(' ')}`);
      return reply as T;
    },
  };
  return {
    useCommands: (fn) => Effect.promise(() => Promise.resolve(fn(commands))),
    publish: (channel, message) =>
      Effect.sync(() => {
        published.push({ channel, message });
      }),
    subscribe: () => Effect.void,
    unsubscribe: () => Effect.void,
    healthSnapshot: () =>
      Effect.succeed({ commandsReady: true, publisherReady: true, subscriberReady: true }),
  };
}
