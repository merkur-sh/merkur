import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { OPAQUE_PASSWORD_STRETCHING } from '@merkur/shared/opaque-password-policy';
import {
  decodeUserAuthorizationBytes,
  deriveUserRootKeyCommitment,
  encodeUserAuthorizationBytes,
  USER_AUTHORIZATION_PUBLIC_KEY_BYTES,
  USER_DELEGATION_LIFETIME_MS,
  type UserDelegationCertificate,
  verifyUserDelegationCertificate,
} from '@merkur/shared/user-authorization';
import * as opaque from '@serenity-kit/opaque';

import { createBrowserDelegation } from './browser-delegation';
import { loadBrowserDelegation, saveBrowserDelegation } from './delegation-vault';
import { deriveUserRootPublicKey, encryptUserRootSeed, generateUserRootSeed } from './user-root';

const ORIGIN = 'https://merkur.test';
const USER_ID = 'user-rejected-delegation';
const USERNAME = 'recovery@example.test';
const PASSWORD = 'correct horse battery staple';
const WRONG_PASSWORD = 'wrong horse battery staple';
const originalIndexedDb = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
const originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
const previousPin = process.env.VITE_MERKUR_OPAQUE_SERVER_PUBLIC_KEY;
let serverSetup = '';
let authenticateBrowserAccount: typeof import('./account-workflow').authenticateBrowserAccount;

beforeAll(async () => {
  await opaque.ready;
  serverSetup = opaque.server.createSetup();
  process.env.VITE_MERKUR_OPAQUE_SERVER_PUBLIC_KEY = opaque.server.getPublicKey(serverSetup);
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { origin: ORIGIN },
  });
  ({ authenticateBrowserAccount } = await import('./account-workflow'));
});

afterAll(() => {
  if (previousPin === undefined) delete process.env.VITE_MERKUR_OPAQUE_SERVER_PUBLIC_KEY;
  else process.env.VITE_MERKUR_OPAQUE_SERVER_PUBLIC_KEY = previousPin;
  restoreGlobal('indexedDB', originalIndexedDb);
  restoreGlobal('location', originalLocation);
});

describe('browser login delegation recovery', () => {
  test('replaces one definitively rejected stored certificate without another password prompt', async () => {
    const unlockedRootSeeds: Uint8Array[] = [];
    const exportKeys: Uint8Array[] = [];
    const assertSecretsRetired = () => {
      for (const seed of unlockedRootSeeds) expect(seed.every((byte) => byte === 0)).toBe(true);
      for (const key of exportKeys) expect(key.every((byte) => byte === 0)).toBe(true);
    };
    const records = installFakeIndexedDb(assertSecretsRetired);
    const registration = opaque.client.startRegistration({ password: PASSWORD });
    const registrationResponse = opaque.server.createRegistrationResponse({
      serverSetup,
      userIdentifier: USER_ID,
      registrationRequest: registration.registrationRequest,
    });
    const registered = opaque.client.finishRegistration({
      password: PASSWORD,
      clientRegistrationState: registration.clientRegistrationState,
      registrationResponse: registrationResponse.registrationResponse,
      identifiers: { client: USER_ID, server: ORIGIN },
      keyStretching: OPAQUE_PASSWORD_STRETCHING,
    });
    const exportKey = Uint8Array.from(Buffer.from(registered.exportKey, 'base64url'));
    const rootSeed = generateUserRootSeed();
    const rootPublicKey = deriveUserRootPublicKey(rootSeed);
    const rootPublicKeyEncoded = encodeUserAuthorizationBytes(rootPublicKey);
    const rootEnvelope = await encryptUserRootSeed(rootSeed, exportKey, USER_ID, rootPublicKey);
    const oldDelegation = createBrowserDelegation(rootSeed, {
      userId: USER_ID,
      serverOrigin: ORIGIN,
      rootEpoch: 1,
      issuedAt: 1_000,
      expiresAt: 1_000 + USER_DELEGATION_LIFETIME_MS,
      delegationId: 'rejected-delegation',
    });
    await saveBrowserDelegation(
      USERNAME,
      rootPublicKey,
      oldDelegation.certificate,
      oldDelegation.delegateSeed,
    );

    const rootModule = await import('./user-root');
    const opaqueModule = await import('./account-opaque');
    const decrypt = rootModule.decryptUserRootSeed;
    const finishLogin = opaqueModule.finishAccountLogin;
    const decryptSpy = spyOn(rootModule, 'decryptUserRootSeed').mockImplementation(
      async (...args) => {
        const seed = await decrypt(...args);
        unlockedRootSeeds.push(seed);
        return seed;
      },
    );
    const loginSpy = spyOn(opaqueModule, 'finishAccountLogin').mockImplementation(
      async (...args) => {
        const finished = await finishLogin(...args);
        if (finished !== null) exportKeys.push(finished.exportKey);
        return finished;
      },
    );

    let starts = 0;
    let finishes = 0;
    const serverStates = new Map<string, string>();
    const presentedCertificates: UserDelegationCertificate[] = [];
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const path = new URL(String(input)).pathname;
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        if (path === '/api/auth/start') {
          starts += 1;
          const flowId = flowIdNamed(`flow-${starts}`);
          const login = opaque.server.startLogin({
            serverSetup,
            registrationRecord: registered.registrationRecord,
            startLoginRequest: String(body.startLoginRequest),
            userIdentifier: USER_ID,
            identifiers: { client: USER_ID, server: ORIGIN },
          });
          const registrationBranch = opaque.server.createRegistrationResponse({
            serverSetup,
            userIdentifier: USER_ID,
            registrationRequest: String(body.registrationRequest),
          });
          serverStates.set(flowId, login.serverLoginState);
          const issuedAt = 10_000 + starts;
          return jsonResponse({
            login: {
              flowId,
              userId: USER_ID,
              loginResponse: login.loginResponse,
              rootPublicKey: rootPublicKeyEncoded,
              // A reusable, root-bound delegation does not need to decrypt this
              // envelope. Recovery still requires the genuine envelope.
              rootEnvelope:
                starts === 1
                  ? { ...rootEnvelope, ciphertext: Buffer.alloc(48).toString('base64url') }
                  : rootEnvelope,
              rootEpoch: 1,
              delegationIssuedAt: issuedAt,
              delegationExpiresAt: issuedAt + USER_DELEGATION_LIFETIME_MS,
            },
            registration: {
              flowId,
              userId: USER_ID,
              registrationResponse: registrationBranch.registrationResponse,
              delegationIssuedAt: issuedAt,
              delegationExpiresAt: issuedAt + USER_DELEGATION_LIFETIME_MS,
            },
          });
        }
        if (path !== '/api/auth/login/finish') throw new Error(`Unexpected request: ${path}`);
        finishes += 1;
        assertSecretsRetired();
        expect(unlockedRootSeeds.length).toBe(finishes === 1 ? 0 : 1);
        const flowId = String(body.flowId);
        const serverLoginState = serverStates.get(flowId);
        if (serverLoginState === undefined) throw new Error('Unknown OPAQUE flow');
        opaque.server.finishLogin({
          serverLoginState,
          finishLoginRequest: String(body.finishLoginRequest),
          identifiers: { client: USER_ID, server: ORIGIN },
        });
        const certificate = body.delegationCertificate as UserDelegationCertificate;
        presentedCertificates.push(certificate);
        if (finishes === 1) {
          return jsonResponse({ error: 'authentication_failed' }, 401);
        }
        return jsonResponse({
          accessToken: 'recovered-access-token',
          userId: USER_ID,
          delegationId: certificate.delegationId,
          delegationExpiresAt: certificate.expiresAt,
          deletionCancelled: false,
          serverTimeMs: 10_002,
        });
      },
    });

    try {
      const result = await authenticateBrowserAccount(USERNAME, PASSWORD, 'username');
      if (result.kind !== 'signed-in') throw new Error('Login unexpectedly asked for a code');
      const { account } = result;
      expect(starts).toBe(2);
      expect(finishes).toBe(2);
      expect(decryptSpy).toHaveBeenCalledTimes(1);
      expect(presentedCertificates[0]?.delegationId).toBe('rejected-delegation');
      expect(presentedCertificates[1]?.delegationId).not.toBe('rejected-delegation');
      const recoveredCertificate = presentedCertificates[1];
      if (recoveredCertificate === undefined) throw new Error('Recovery certificate is missing');
      expect(account.session.delegationId).toBe(recoveredCertificate.delegationId);
      const unlocked = await loadBrowserDelegation(USER_ID);
      expect(unlocked?.certificate.delegationId).toBe(account.session.delegationId);
      unlocked?.delegateSeed.fill(0);
      unlocked?.rootPublicKey.fill(0);
      expect(records.has('active-delegation')).toBe(true);
    } finally {
      decryptSpy.mockRestore();
      loginSpy.mockRestore();
      exportKey.fill(0);
      rootSeed.fill(0);
      rootPublicKey.fill(0);
      oldDelegation.delegateSeed.fill(0);
    }
  }, 30_000);

  test('wrong-password registration fallback never replaces the existing vault', async () => {
    installFakeIndexedDb();
    const registration = opaque.client.startRegistration({ password: PASSWORD });
    const registrationResponse = opaque.server.createRegistrationResponse({
      serverSetup,
      userIdentifier: USER_ID,
      registrationRequest: registration.registrationRequest,
    });
    const registered = opaque.client.finishRegistration({
      password: PASSWORD,
      clientRegistrationState: registration.clientRegistrationState,
      registrationResponse: registrationResponse.registrationResponse,
      identifiers: { client: USER_ID, server: ORIGIN },
      keyStretching: OPAQUE_PASSWORD_STRETCHING,
    });
    const exportKey = Uint8Array.from(Buffer.from(registered.exportKey, 'base64url'));
    const rootSeed = generateUserRootSeed();
    const rootPublicKey = deriveUserRootPublicKey(rootSeed);
    const rootPublicKeyEncoded = encodeUserAuthorizationBytes(rootPublicKey);
    const rootEnvelope = await encryptUserRootSeed(rootSeed, exportKey, USER_ID, rootPublicKey);
    const oldDelegation = createBrowserDelegation(rootSeed, {
      userId: USER_ID,
      serverOrigin: ORIGIN,
      rootEpoch: 1,
      issuedAt: 1_000,
      expiresAt: 1_000 + USER_DELEGATION_LIFETIME_MS,
      delegationId: 'still-valid-delegation',
    });
    await saveBrowserDelegation(
      USERNAME,
      rootPublicKey,
      oldDelegation.certificate,
      oldDelegation.delegateSeed,
    );

    let registrationFinishes = 0;
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const path = new URL(String(input)).pathname;
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        if (path === '/api/auth/start') {
          const flowId = flowIdNamed('wrong-password-flow');
          const login = opaque.server.startLogin({
            serverSetup,
            registrationRecord: registered.registrationRecord,
            startLoginRequest: String(body.startLoginRequest),
            userIdentifier: USER_ID,
            identifiers: { client: USER_ID, server: ORIGIN },
          });
          const registrationBranch = opaque.server.createRegistrationResponse({
            serverSetup,
            userIdentifier: USER_ID,
            registrationRequest: String(body.registrationRequest),
          });
          const issuedAt = 20_000;
          return jsonResponse({
            login: {
              flowId,
              userId: USER_ID,
              loginResponse: login.loginResponse,
              rootPublicKey: rootPublicKeyEncoded,
              rootEnvelope,
              rootEpoch: 1,
              delegationIssuedAt: issuedAt,
              delegationExpiresAt: issuedAt + USER_DELEGATION_LIFETIME_MS,
            },
            registration: {
              flowId,
              userId: USER_ID,
              registrationResponse: registrationBranch.registrationResponse,
              delegationIssuedAt: issuedAt,
              delegationExpiresAt: issuedAt + USER_DELEGATION_LIFETIME_MS,
            },
          });
        }
        if (path !== '/api/auth/register/finish') {
          throw new Error(`Unexpected request: ${path}`);
        }
        registrationFinishes += 1;
        const stored = await loadBrowserDelegation(USER_ID);
        expect(stored?.certificate.delegationId).toBe('still-valid-delegation');
        stored?.delegateSeed.fill(0);
        stored?.rootPublicKey.fill(0);
        return jsonResponse({ error: 'authentication_failed' }, 401);
      },
    });

    try {
      await expect(
        authenticateBrowserAccount(USERNAME, WRONG_PASSWORD, 'username'),
      ).rejects.toThrow();
      expect(registrationFinishes).toBe(1);
      const stored = await loadBrowserDelegation(USER_ID);
      expect(stored?.certificate.delegationId).toBe('still-valid-delegation');
      stored?.delegateSeed.fill(0);
      stored?.rootPublicKey.fill(0);
    } finally {
      exportKey.fill(0);
      rootSeed.fill(0);
      rootPublicKey.fill(0);
      oldDelegation.delegateSeed.fill(0);
    }
  }, 30_000);
});

describe('password reset', () => {
  const NEW_PASSWORD = 'a second correct horse battery';
  const ISSUED_AT = 30_000;
  const CODE_FLOW = flowIdNamed('code-flow');
  const PROVEN_FLOW = flowIdNamed('proven-flow');

  test('installs a new root at the epoch the server names, in place of the stored delegation', async () => {
    const records = installFakeIndexedDb();
    const oldSeed = generateUserRootSeed();
    const oldRootPublicKey = deriveUserRootPublicKey(oldSeed);
    const oldDelegation = createBrowserDelegation(oldSeed, {
      userId: USER_ID,
      serverOrigin: ORIGIN,
      rootEpoch: 1,
      issuedAt: 1_000,
      expiresAt: 1_000 + USER_DELEGATION_LIFETIME_MS,
      delegationId: 'delegation-before-reset',
    });
    await saveBrowserDelegation(
      USERNAME,
      oldRootPublicKey,
      oldDelegation.certificate,
      oldDelegation.delegateSeed,
    );

    const rootModule = await import('./user-root');
    const opaqueModule = await import('./account-opaque');
    const generate = rootModule.generateUserRootSeed;
    const finishRegistration = opaqueModule.finishAccountRegistration;
    const newSeeds: Uint8Array[] = [];
    const exportKeys: Uint8Array[] = [];
    const seedSpy = spyOn(rootModule, 'generateUserRootSeed').mockImplementation(() => {
      const seed = generate();
      newSeeds.push(seed);
      return seed;
    });
    const registrationSpy = spyOn(opaqueModule, 'finishAccountRegistration').mockImplementation(
      async (...args) => {
        const finished = await finishRegistration(...args);
        exportKeys.push(finished.exportKey);
        return finished;
      },
    );

    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    let finished: Record<string, unknown> | null = null;
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const path = new URL(String(input)).pathname;
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        requests.push({ path, body });
        switch (path) {
          case '/api/auth/reset/code':
            return jsonResponse({ flowId: CODE_FLOW });
          case '/api/auth/reset/verify':
            return body.emailCode === '123456'
              ? jsonResponse({
                  flowId: PROVEN_FLOW,
                  devices: [
                    { name: 'laptop', platform: 'macOS', box: false },
                    { name: 'calm-harbor', platform: 'linux', box: true },
                  ],
                })
              : jsonResponse({ error: 'invalid_email_code' }, 400);
          case '/api/auth/reset/start':
            return jsonResponse({
              userId: USER_ID,
              registrationResponse: opaque.server.createRegistrationResponse({
                serverSetup,
                userIdentifier: USER_ID,
                registrationRequest: String(body.registrationRequest),
              }).registrationResponse,
              rootEpoch: 2,
              delegationIssuedAt: ISSUED_AT,
              delegationExpiresAt: ISSUED_AT + USER_DELEGATION_LIFETIME_MS,
            });
          case '/api/auth/reset/finish': {
            // Sealed before the request leaves: nothing the reset unlocked is
            // still in memory when the network is touched.
            for (const seed of newSeeds) expect(seed.every((byte) => byte === 0)).toBe(true);
            for (const key of exportKeys) expect(key.every((byte) => byte === 0)).toBe(true);
            finished = body;
            const certificate = body.delegationCertificate as UserDelegationCertificate;
            return jsonResponse({
              accessToken: 'reset-access-token',
              userId: USER_ID,
              delegationId: certificate.delegationId,
              delegationExpiresAt: certificate.expiresAt,
              deletionCancelled: false,
              serverTimeMs: ISSUED_AT + 1,
            });
          }
          default:
            throw new Error(`Unexpected request: ${path}`);
        }
      },
    });

    try {
      const { beginPasswordReset } = await import('./password-reset');
      const pending = await beginPasswordReset(USERNAME);
      expect(pending.step).toBe('code');
      await expect(pending.submitCode('000000')).rejects.toMatchObject({
        code: 'invalid_email_code',
      });
      // A wrong code leaves the step usable.
      const proven = await pending.submitCode('123456');
      expect(proven.devices.map((device) => device.name)).toEqual(['laptop', 'calm-harbor']);

      const account = await proven.complete(NEW_PASSWORD);

      // One root was generated and one export key derived; the finish request
      // asserted both were already wiped.
      expect(newSeeds).toHaveLength(1);
      expect(exportKeys).toHaveLength(1);
      expect(requests.map((request) => request.path)).toEqual([
        '/api/auth/reset/code',
        '/api/auth/reset/verify',
        '/api/auth/reset/verify',
        '/api/auth/reset/start',
        '/api/auth/reset/finish',
      ]);
      expect(requests[0]?.body).toEqual({ username: USERNAME });
      expect(requests[3]?.body.flowId).toBe(PROVEN_FLOW);
      if (finished === null) throw new Error('The reset never reached its finish');
      const sent = finished as Record<string, unknown>;
      expect(Object.keys(sent)).toEqual([
        'flowId',
        'registrationRecord',
        'rootPublicKey',
        'rootEnvelope',
        'delegationCertificate',
        'installed',
      ]);
      expect(sent.flowId).toBe(PROVEN_FLOW);
      const newRootPublicKey = decodeUserAuthorizationBytes(
        String(sent.rootPublicKey),
        USER_AUTHORIZATION_PUBLIC_KEY_BYTES,
        'user root public key',
      );
      expect(sent.rootPublicKey).not.toBe(encodeUserAuthorizationBytes(oldRootPublicKey));
      // The delegation is the new root's, at the epoch the server named.
      const certificate = verifyUserDelegationCertificate(
        sent.delegationCertificate,
        newRootPublicKey,
        {
          userId: USER_ID,
          rootKeyCommitment: deriveUserRootKeyCommitment(newRootPublicKey),
          serverOrigin: ORIGIN,
          rootEpoch: 2,
          nowMs: ISSUED_AT,
        },
      );
      expect(certificate).not.toBeNull();
      expect(certificate?.issuedAt).toBe(ISSUED_AT);

      // The new password opens the record, and its export key opens the root
      // that was sealed: a later sign-in can recover this root.
      const login = opaque.client.startLogin({ password: NEW_PASSWORD });
      const serverLogin = opaque.server.startLogin({
        serverSetup,
        registrationRecord: String(sent.registrationRecord),
        startLoginRequest: login.startLoginRequest,
        userIdentifier: USER_ID,
        identifiers: { client: USER_ID, server: ORIGIN },
      });
      const opened = opaque.client.finishLogin({
        password: NEW_PASSWORD,
        clientLoginState: login.clientLoginState,
        loginResponse: serverLogin.loginResponse,
        identifiers: { client: USER_ID, server: ORIGIN },
        keyStretching: OPAQUE_PASSWORD_STRETCHING,
      });
      if (opened === undefined) throw new Error('The new password did not open the record');
      const recovered = await rootModule.decryptUserRootSeed(
        sent.rootEnvelope as Parameters<typeof rootModule.decryptUserRootSeed>[0],
        Uint8Array.from(Buffer.from(opened.exportKey, 'base64url')),
        USER_ID,
        newRootPublicKey,
      );
      expect(deriveUserRootPublicKey(recovered)).toEqual(newRootPublicKey);
      recovered.fill(0);

      // This profile now holds the new delegation and nothing of the old root.
      expect(account.session.accessToken).toBe('reset-access-token');
      expect(account.certificate.rootEpoch).toBe(2);
      expect(account.rootPublicKey).toBe(String(sent.rootPublicKey));
      const stored = await loadBrowserDelegation(USER_ID);
      expect(stored?.certificate.delegationId).toBe(account.session.delegationId);
      expect(stored?.certificate.delegationId).not.toBe('delegation-before-reset');
      expect(stored?.certificate.rootEpoch).toBe(2);
      stored?.delegateSeed.fill(0);
      stored?.rootPublicKey.fill(0);
      expect(records.has('active-delegation')).toBe(true);
    } finally {
      seedSpy.mockRestore();
      registrationSpy.mockRestore();
      oldSeed.fill(0);
      oldRootPublicKey.fill(0);
      oldDelegation.delegateSeed.fill(0);
    }
  }, 30_000);

  test('a password the policy refuses never reaches the server', async () => {
    installFakeIndexedDb();
    const paths: string[] = [];
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: async (input: string | URL | Request): Promise<Response> => {
        const path = new URL(String(input)).pathname;
        paths.push(path);
        return path === '/api/auth/reset/code'
          ? jsonResponse({ flowId: CODE_FLOW })
          : jsonResponse({ flowId: PROVEN_FLOW, devices: [] });
      },
    });
    const { beginPasswordReset } = await import('./password-reset');
    const proven = await (await beginPasswordReset(USERNAME)).submitCode('123456');

    await expect(proven.complete('short')).rejects.toThrow();
    expect(paths).toEqual(['/api/auth/reset/code', '/api/auth/reset/verify']);
  });
});

/** A flow id as the server issues one, 32 bytes in canonical base64url, distinct for each name. */
function flowIdNamed(name: string): string {
  return Buffer.alloc(32, name).toString('base64url');
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function installFakeIndexedDb(onPut?: () => void): Map<string, unknown> {
  const records = new Map<string, unknown>();
  const database = {
    objectStoreNames: { contains: () => true },
    transaction(_storeName: string, _mode: IDBTransactionMode) {
      let pending = 0;
      let completeQueued = false;
      let completed = false;
      const transaction: {
        error: DOMException | null;
        oncomplete: ((event: Event) => void) | null;
        onabort: ((event: Event) => void) | null;
        onerror: ((event: Event) => void) | null;
        objectStore(): object;
      } = {
        error: null,
        oncomplete: null,
        onabort: null,
        onerror: null,
        objectStore() {
          return {
            get(key: IDBValidKey) {
              const request = requestRecord();
              runOperation(() => {
                request.result = records.get(String(key));
                request.onsuccess?.(new Event('success'));
              });
              return request;
            },
            put(value: unknown, key: IDBValidKey) {
              onPut?.();
              const request = requestRecord();
              runOperation(() => {
                records.set(String(key), value);
                request.result = key;
                request.onsuccess?.(new Event('success'));
              });
              return request;
            },
            delete(key: IDBValidKey) {
              const request = requestRecord();
              runOperation(() => {
                records.delete(String(key));
                request.result = undefined;
                request.onsuccess?.(new Event('success'));
              });
              return request;
            },
          };
        },
      };
      function runOperation(operation: () => void): void {
        pending += 1;
        queueMicrotask(() => {
          operation();
          pending -= 1;
          queueCompletion();
        });
      }
      function queueCompletion(): void {
        if (pending !== 0 || completeQueued || completed) return;
        completeQueued = true;
        queueMicrotask(() => {
          completeQueued = false;
          if (pending !== 0 || completed) return;
          completed = true;
          transaction.oncomplete?.(new Event('complete'));
        });
      }
      return transaction;
    },
    close() {},
  };
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    value: {
      open() {
        const request = requestRecord<typeof database>();
        queueMicrotask(() => {
          request.result = database;
          request.onsuccess?.(new Event('success'));
        });
        return request;
      },
    },
  });
  return records;
}

function requestRecord<T = unknown>(): {
  result?: T;
  error: DOMException | null;
  onsuccess: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  onblocked: ((event: Event) => void) | null;
  onupgradeneeded: ((event: Event) => void) | null;
} {
  return {
    error: null,
    onsuccess: null,
    onerror: null,
    onblocked: null,
    onupgradeneeded: null,
  };
}

function restoreGlobal(name: 'indexedDB' | 'location', descriptor: PropertyDescriptor | undefined) {
  if (descriptor === undefined) Reflect.deleteProperty(globalThis, name);
  else Object.defineProperty(globalThis, name, descriptor);
}
