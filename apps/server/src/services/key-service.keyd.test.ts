/**
 * Pins the server's keyd client to the real `merkur-keyd`, and keyd's OPAQUE to the browser's
 * `@serenity-kit/opaque`: a setup serenity made loads in keyd unchanged, and an account
 * serenity's client registered signs in through keyd with the same export key.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { createECDH, createPublicKey, createVerify, randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import {
  assembleSessionAuthorizationToken,
  createOpaqueServerSetup,
  createSessionAuthorizationPayloadSegment,
  validateOpaqueServerSetup,
  verifySessionAuthorizationToken,
} from '@merkur/auth';
import { OPAQUE_PASSWORD_STRETCHING } from '@merkur/shared/opaque-password-policy';
import * as opaque from '@serenity-kit/opaque';
import { Effect } from 'effect';
import { keydExecutable, spawnKeyd } from '../../../../scripts/keyd';
import type { KeyServiceError } from './key-service';
import { keydCredentials, startTestKeyService, type TestKeyService } from './keyd-test-support';

const ORIGIN = 'https://merkur.test';
const USER = 'user-1';

let credentials: string;
let opaqueSetup: string;
let vapidPublicKey: string;
let keyd: TestKeyService | undefined;

beforeAll(async () => {
  await opaque.ready;
  opaqueSetup = await createOpaqueServerSetup();
  const vapid = createECDH('prime256v1');
  vapid.setPrivateKey(randomBytes(32));
  vapidPublicKey = vapid.getPublicKey().toString('base64url');
  credentials = await keydCredentials({
    'opaque-server-setup': opaqueSetup,
    'session-token-mldsa87-seed': Buffer.alloc(32, 7).toString('base64url'),
    'web-push-vapid-private-key': vapid.getPrivateKey().toString('base64url'),
  });
});

afterAll(async () => {
  await rm(path.dirname(credentials), { recursive: true, force: true });
});

afterEach(async () => {
  await keyd?.stop();
  keyd = undefined;
});

async function started(): Promise<TestKeyService> {
  keyd = await startTestKeyService(credentials);
  return keyd;
}

const run = <A>(effect: Effect.Effect<A, KeyServiceError>) => Effect.runPromise(effect);
const failure = <A>(effect: Effect.Effect<A, KeyServiceError>) =>
  Effect.runPromise(Effect.flip(effect));

/** serenity's client registers `password` through keyd. */
async function register(service: TestKeyService['service'], password: string) {
  const start = opaque.client.startRegistration({ password });
  const response = await run(
    service.registrationResponse({ userId: USER, registrationRequest: start.registrationRequest }),
  );
  const finished = opaque.client.finishRegistration({
    password,
    clientRegistrationState: start.clientRegistrationState,
    registrationResponse: response,
    identifiers: { client: USER, server: ORIGIN },
    keyStretching: OPAQUE_PASSWORD_STRETCHING,
  });
  return { record: finished.registrationRecord, exportKey: finished.exportKey };
}

async function authStart(service: TestKeyService['service'], password: string, record: string) {
  const login = opaque.client.startLogin({ password });
  const server = await run(
    service.authStart({
      userId: USER,
      serverIdentity: ORIGIN,
      registrationRecord: record,
      startLoginRequest: login.startLoginRequest,
      registrationRequest: opaque.client.startRegistration({ password }).registrationRequest,
    }),
  );
  return { login, server };
}

describe('merkur-keyd', () => {
  test('holds the serenity setup and the VAPID key it was given', async () => {
    const { service } = await started();
    expect(service.publicKeys.opaque).toBe(await validateOpaqueServerSetup(opaqueSetup));
    expect(service.publicKeys.vapid).toBe(vapidPublicKey);
    expect(Buffer.from(service.publicKeys.sessionCapability, 'base64url')).toHaveLength(2_592);
  });

  test("a serenity registration signs in through keyd with the browser's export key", async () => {
    const { service } = await started();
    const { record, exportKey } = await register(service, 'correct horse');
    const { login, server } = await authStart(service, 'correct horse', record);
    const finished = opaque.client.finishLogin({
      password: 'correct horse',
      clientLoginState: login.clientLoginState,
      loginResponse: server.loginResponse,
      identifiers: { client: USER, server: ORIGIN },
      keyStretching: OPAQUE_PASSWORD_STRETCHING,
    });
    if (finished === undefined) throw new Error('the right password did not sign in');
    expect(finished.exportKey).toBe(exportKey);
    expect(finished.serverStaticPublicKey).toBe(service.publicKeys.opaque);
    const finish = {
      userId: USER,
      serverIdentity: ORIGIN,
      serverLoginState: server.serverLoginState,
    };
    expect(
      await run(
        service.loginFinish({ ...finish, finishLoginRequest: finished.finishLoginRequest }),
      ),
    ).toBe(true);
    const forged = Buffer.alloc(64, 9).toString('base64url');
    expect(await run(service.loginFinish({ ...finish, finishLoginRequest: forged }))).toBe(false);
  });

  test("the eleventh attempt in a minute is refused until the window's oldest leaves", async () => {
    const { service } = await started();
    const { record } = await register(service, 'correct horse');
    for (let attempt = 2; attempt <= 10; attempt += 1) await authStart(service, 'wrong', record);
    const refused = await failure(
      service.registrationResponse({
        userId: USER,
        registrationRequest: opaque.client.startRegistration({ password: 'x' }).registrationRequest,
      }),
    );
    expect(refused.reason).toBe('exhausted');
    expect(refused.retryAfterSeconds).toBeGreaterThan(0);
    expect(refused.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  test('a malformed OPAQUE message is refused before it reaches keyd', async () => {
    const { service } = await started();
    expect(
      (await failure(service.registrationResponse({ userId: USER, registrationRequest: 'AAAA' })))
        .reason,
    ).toBe('invalid');
  });

  test('a live capability is signed and verifies with the key daemons are given', async () => {
    const { service } = await started();
    const now = Date.now();
    const claims = {
      userId: USER,
      delegationId: 'delegation-1',
      browserNodeId: 'node-1',
      daemonId: 'daemon-1',
      sessionId: 'session-1',
      daemonIdentityKeyCommitment: Buffer.alloc(64, 1).toString('base64url'),
      sessionRequestCommitment: Buffer.alloc(64, 2).toString('base64url'),
      issuedAtMs: now,
      expiresAtMs: now + 60_000,
    };
    const segment = createSessionAuthorizationPayloadSegment(claims);
    const token = assembleSessionAuthorizationToken(
      segment,
      await run(service.signCapability(segment)),
    );
    const verifyKey = Buffer.from(service.publicKeys.sessionCapability, 'base64url');
    expect(verifySessionAuthorizationToken(token, verifyKey, now)?.s).toBe('session-1');

    const stale = createSessionAuthorizationPayloadSegment({
      ...claims,
      issuedAtMs: now - 120_000,
      expiresAtMs: now - 60_000,
    });
    expect((await failure(service.signCapability(stale))).reason).toBe('refused');
  });

  test('a VAPID JWT verifies with the public key keyd reports', async () => {
    const { service } = await started();
    const { jwt, expiresAt } = await run(
      service.vapidJwt('https://push.example', 'mailto:ops@merkur.test'),
    );
    const [header, claims, signature] = jwt.split('.');
    if (header === undefined || claims === undefined || signature === undefined)
      throw new Error('not a JWT');
    expect(JSON.parse(Buffer.from(claims, 'base64url').toString())).toEqual({
      aud: 'https://push.example',
      exp: expiresAt,
      sub: 'mailto:ops@merkur.test',
    });
    const raw = Buffer.from(vapidPublicKey, 'base64url');
    const key = createPublicKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: raw.subarray(1, 33).toString('base64url'),
        y: raw.subarray(33).toString('base64url'),
      },
      format: 'jwk',
    });
    const verifier = createVerify('SHA256');
    verifier.update(`${header}.${claims}`);
    expect(
      verifier.verify({ key, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')),
    ).toBe(true);
  });

  test('a stopped keyd fails the request, and the next is dialed afresh', async () => {
    const running = await started();
    const socket = running.keyd.socket;
    await running.keyd.stop();
    expect((await failure(running.service.signCapability('x'))).reason).toBe('unreachable');

    // keyd restarted on the same socket, as systemd restarts it: the next request reaches it.
    const restarted = await spawnKeyd(
      keydExecutable(path.resolve(import.meta.dir, '../../../..')),
      { credentials, state: path.dirname(socket), socket },
      { PATH: process.env.PATH ?? '', RUST_LOG: 'warn' },
    );
    try {
      const now = Date.now();
      const segment = createSessionAuthorizationPayloadSegment({
        userId: USER,
        delegationId: 'delegation-1',
        browserNodeId: 'node-1',
        daemonId: 'daemon-1',
        sessionId: 'session-1',
        daemonIdentityKeyCommitment: Buffer.alloc(64, 1).toString('base64url'),
        sessionRequestCommitment: Buffer.alloc(64, 2).toString('base64url'),
        issuedAtMs: now,
        expiresAtMs: now + 60_000,
      });
      expect(await run(running.service.signCapability(segment))).toHaveLength(4_627);
    } finally {
      restarted.kill('SIGTERM');
      await restarted.exited;
      await rm(path.dirname(socket), { recursive: true, force: true });
    }
  });
});
