import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { encodeUserAuthorizationBytes } from '@merkur/shared/user-authorization';

import type { ActiveBrowserAccount } from '../auth/account-workflow';
import { createBrowserDelegation, createBrowserRevocation } from '../auth/browser-delegation';
import type { UnlockedBrowserDelegation } from '../auth/delegation-vault';
import { storeLogoutTombstone } from '../auth/revocation-outbox';
import { deriveUserRootPublicKey, generateUserRootSeed } from '../auth/user-root';

const LOGOUT_TOMBSTONE_KEY = 'merkur:pending-browser-logout';
const storageEntries = new Map<string, string>();
const originalFormData = globalThis.FormData;
const originalLocks = Object.getOwnPropertyDescriptor(globalThis.navigator, 'locks');

let createAuth: typeof import('./createAuth').createAuth;
let markAccountSessionEstablished: typeof import('../api').markAccountSessionEstablished;

beforeAll(async () => {
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { origin: 'https://merkur.test' },
  });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem(key: string): string | null {
        return storageEntries.get(key) ?? null;
      },
      setItem(key: string, value: string): void {
        storageEntries.set(key, value);
      },
      removeItem(key: string): void {
        storageEntries.delete(key);
      },
    },
  });
  Object.defineProperty(globalThis.navigator, 'locks', {
    configurable: true,
    value: {
      request<T>(
        _name: string,
        _options: { readonly mode?: string },
        callback: () => Promise<T>,
      ): Promise<T> {
        return callback();
      },
    },
  });
  ({ createAuth } = await import('./createAuth'));
  ({ markAccountSessionEstablished } = await import('../api'));
});

beforeEach(() => storageEntries.clear());

afterEach(() => {
  markAccountSessionEstablished();
  storageEntries.clear();
});

afterAll(() => {
  Object.defineProperty(globalThis, 'FormData', {
    configurable: true,
    value: originalFormData,
  });
  if (originalLocks === undefined) {
    Reflect.deleteProperty(globalThis.navigator, 'locks');
  } else {
    Object.defineProperty(globalThis.navigator, 'locks', originalLocks);
  }
});

describe('createAuth local-first logout', () => {
  test('a rejected session leaves the UI before vault cleanup and sends no logout request', async () => {
    const fixture = createCredentialFixture();
    let account: ActiveBrowserAccount | null = fixture.account;
    let accessToken: string | null = fixture.account.session.accessToken;
    // The shell has left the screen; the account goes only after this.
    const departed = Promise.resolve();
    const enteredAuth = mock(() => departed);
    const ended = mock(() => {});
    const clear = mock(() => new Promise<void>(() => {}));
    const fetchMock = mock(() => Promise.reject(new Error('unexpected network request')));
    Object.defineProperty(globalThis, 'fetch', { configurable: true, value: fetchMock });
    const auth = createAuth({
      enterAuth: enteredAuth,
      endSignedInState: ended,
      setAccessToken(next) {
        accessToken = next;
      },
      setAccount(next) {
        account = next;
      },
      getAccount: () => account,
      loadDevices: async () => {},
      browserDelegationStore: {
        async has(): Promise<boolean> {
          return true;
        },
        async unlock(): Promise<UnlockedBrowserDelegation> {
          throw new Error('delegate unlock is not expected');
        },
        clear,
      },
    });

    auth.onSessionRejected();
    auth.onSessionRejected();
    expect(enteredAuth).toHaveBeenCalledTimes(1);
    expect(account).not.toBeNull();
    expect(ended).not.toHaveBeenCalled();
    await departed;
    expect(account).toBeNull();
    expect(accessToken).toBeNull();
    expect(ended).toHaveBeenCalledTimes(1);
    expect(clear).toHaveBeenCalledWith({
      userId: fixture.account.session.userId,
      delegationId: fixture.account.session.delegationId,
    });
    expect(clear).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(storageEntries.has(LOGOUT_TOMBSTONE_KEY)).toBe(false);
    fixture.wipe();
  });

  test('preserves the trusted-browser vault after an ambiguous refresh failure', async () => {
    const fixture = createCredentialFixture();
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: mock(() => Promise.reject(new TypeError('offline'))),
    });
    let account: ActiveBrowserAccount | null = fixture.account;
    let clearCalls = 0;
    const auth = createAuth({
      enterAuth: () => Promise.resolve(),
      endSignedInState: () => {},
      setAccessToken: () => {},
      setAccount(next) {
        account = next;
      },
      getAccount: () => account,
      loadDevices: async () => {},
      browserDelegationStore: {
        async has(): Promise<boolean> {
          return true;
        },
        async unlock(): Promise<UnlockedBrowserDelegation> {
          throw new Error('delegate unlock is not expected');
        },
        async clear(): Promise<void> {
          clearCalls += 1;
        },
      },
    });

    await auth.attemptSessionRefresh();

    expect(account).toBeNull();
    expect(clearCalls).toBe(0);
    expect(auth.authError()).toBe('Unable to reach Merkur. Check your connection, then try again.');
    fixture.wipe();
  });

  test('clears only the observed delegation after a definitive refresh rejection', async () => {
    const fixture = createCredentialFixture();
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: mock(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: 'invalid_refresh_token' }), {
            status: 401,
            headers: { 'content-type': 'application/json' },
          }),
        ),
      ),
    });
    let account: ActiveBrowserAccount | null = fixture.account;
    const cleared: Array<{ readonly userId: string; readonly delegationId: string } | undefined> =
      [];
    const auth = createAuth({
      enterAuth: () => Promise.resolve(),
      endSignedInState: () => {},
      setAccessToken: () => {},
      setAccount(next) {
        account = next;
      },
      getAccount: () => account,
      loadDevices: async () => {},
      browserDelegationStore: {
        async has(): Promise<boolean> {
          return true;
        },
        async unlock(): Promise<UnlockedBrowserDelegation> {
          throw new Error('delegate unlock is not expected');
        },
        async clear(expected): Promise<void> {
          cleared.push(expected);
        },
      },
    });

    await auth.attemptSessionRefresh();

    expect(account).toBeNull();
    expect(cleared).toEqual([
      {
        userId: fixture.account.session.userId,
        delegationId: fixture.account.session.delegationId,
      },
    ]);
    expect(auth.authError()).toBe('');
    fixture.wipe();
  });

  test('deletes the usable delegate before an offline request and retains only a public tombstone', async () => {
    const fixture = createCredentialFixture();
    let usableDelegatePresent = true;
    let returnedDelegateSeed = new Uint8Array(0);
    const order: string[] = [];
    const requests: Array<{ readonly url: string; readonly init: RequestInit | undefined }> = [];
    const fetchMock = mock((input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      order.push('network');
      expect(usableDelegatePresent).toBe(false);
      return Promise.reject(new TypeError('offline'));
    });
    Object.defineProperty(globalThis, 'fetch', { configurable: true, value: fetchMock });

    let activeAccount: ActiveBrowserAccount | null = fixture.account;
    let accessToken: string | null = fixture.account.session.accessToken;
    let enteredAuth = false;
    const auth = createAuth({
      enterAuth() {
        enteredAuth = true;
        return Promise.resolve();
      },
      // The shell is torn down after the vault is clear and before the
      // network is touched: the order the screen leaves in.
      endSignedInState() {
        order.push('ended');
      },
      setAccessToken(next) {
        accessToken = next;
      },
      setAccount(next) {
        activeAccount = next;
      },
      getAccount: () => activeAccount,
      loadDevices: async () => {},
      browserDelegationStore: {
        async has(): Promise<boolean> {
          return true;
        },
        async unlock(): Promise<UnlockedBrowserDelegation> {
          const delegateSeed = fixture.delegateSeed.slice();
          returnedDelegateSeed = delegateSeed;
          return {
            username: fixture.account.username,
            userId: fixture.account.session.userId,
            rootPublicKey: fixture.rootPublicKey.slice(),
            certificate: fixture.account.certificate,
            delegateSeed,
          };
        },
        async clear(): Promise<void> {
          order.push('clear');
          usableDelegatePresent = false;
        },
      },
    });

    await auth.onLogout();

    expect(order).toEqual(['clear', 'ended', 'network']);
    expect(usableDelegatePresent).toBe(false);
    expect(returnedDelegateSeed.byteLength).toBe(32);
    expect(returnedDelegateSeed.every((value) => value === 0)).toBe(true);
    expect(activeAccount).toBeNull();
    expect(accessToken).toBeNull();
    expect(enteredAuth).toBe(true);
    expect(requests).toHaveLength(1);
    expect(new URL(requests[0]?.url ?? '').pathname).toBe('/api/auth/logout');
    const headers = new Headers(requests[0]?.init?.headers);
    expect(headers.has('authorization')).toBe(false);

    const stored = JSON.parse(storageEntries.get(LOGOUT_TOMBSTONE_KEY) ?? 'null') as unknown;
    expect(stored).toEqual({
      actorCertificate: fixture.account.certificate,
      revocation: expect.objectContaining({
        actorDelegationId: fixture.account.certificate.delegationId,
        targets: [
          {
            delegationId: fixture.account.certificate.delegationId,
            expiresAt: fixture.account.certificate.expiresAt,
          },
        ],
      }),
    });
    fixture.wipe();
  });

  test('a pending public revocation blocks both refresh and a new password login', async () => {
    const fixture = createCredentialFixture();
    const authorization = {
      actorCertificate: fixture.account.certificate,
      revocation: createBrowserRevocation(
        {
          certificate: fixture.account.certificate,
          delegateSeed: fixture.delegateSeed,
        },
        [
          {
            delegationId: fixture.account.certificate.delegationId,
            expiresAt: fixture.account.certificate.expiresAt,
          },
        ],
        fixture.account.session.serverTimeMs,
      ),
    };
    storeLogoutTombstone(authorization);
    const requestPaths: string[] = [];
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: mock((input: string | URL | Request) => {
        const path = new URL(String(input)).pathname;
        // The sign-in screen reads the policy when shown; only the revocation
        // and everything after it are offline.
        if (path === '/api/auth/policy') {
          return Promise.resolve(
            new Response(JSON.stringify({ identity: 'username', registration: true }), {
              headers: { 'content-type': 'application/json' },
            }),
          );
        }
        requestPaths.push(path);
        return Promise.reject(new TypeError('offline'));
      }),
    });

    let account: ActiveBrowserAccount | null = fixture.account;
    let clearCalls = 0;
    const auth = createAuth({
      enterAuth: () => Promise.resolve(),
      endSignedInState: () => {},
      setAccessToken: () => {},
      setAccount(next) {
        account = next;
      },
      getAccount: () => account,
      loadDevices: async () => {
        throw new Error('device loading must remain blocked');
      },
      browserDelegationStore: {
        async has(): Promise<boolean> {
          return true;
        },
        async unlock(): Promise<UnlockedBrowserDelegation> {
          throw new Error('delegate unlock must remain blocked');
        },
        async clear(): Promise<void> {
          clearCalls += 1;
        },
      },
    });

    await auth.attemptSessionRefresh();
    expect(account).toBeNull();
    expect(clearCalls).toBe(1);
    await auth.loadAuthPolicy();
    expect(auth.authIdentity()).toBe('username');

    Object.defineProperty(globalThis, 'FormData', {
      configurable: true,
      value: class {
        get(name: string): string | null {
          if (name === 'username') return fixture.account.username;
          if (name === 'password') return 'correct horse battery staple';
          return null;
        }
      },
    });
    await auth.onAuthSubmit({
      preventDefault() {},
      currentTarget: { reset() {} },
    } as unknown as SubmitEvent);

    expect(requestPaths).toEqual(['/api/auth/logout', '/api/auth/logout']);
    expect(requestPaths).not.toContain('/api/auth/refresh');
    expect(requestPaths).not.toContain('/api/auth/start');
    expect(storageEntries.has(LOGOUT_TOMBSTONE_KEY)).toBe(true);
    fixture.wipe();
  });

  test('a profile with no stored delegation shows login without a refresh request', async () => {
    const fetchMock = mock(() => Promise.reject(new Error('unexpected network request')));
    Object.defineProperty(globalThis, 'fetch', { configurable: true, value: fetchMock });
    let account: ActiveBrowserAccount | null = null;
    const enteredAuth = mock(() => Promise.resolve());
    const auth = createAuth({
      enterAuth: enteredAuth,
      endSignedInState: () => {},
      setAccessToken: () => {},
      setAccount(next) {
        account = next;
      },
      getAccount: () => account,
      loadDevices: async () => {
        throw new Error('device loading is not expected');
      },
      browserDelegationStore: {
        async has(): Promise<boolean> {
          return false;
        },
        async unlock(): Promise<UnlockedBrowserDelegation> {
          throw new Error('delegate unlock is not expected');
        },
        async clear(): Promise<void> {
          throw new Error('vault clear is not expected');
        },
      },
    });

    await auth.attemptSessionRefresh();

    // Nothing to resume a refreshed session against, so the cookie is never
    // presented and the visitor's console never sees the 401 it would earn.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(enteredAuth).toHaveBeenCalledTimes(1);
    expect(account).toBeNull();
    expect(auth.authError()).toBe('');
  });
});

function createCredentialFixture(): {
  readonly account: ActiveBrowserAccount;
  readonly delegateSeed: Uint8Array;
  readonly rootPublicKey: Uint8Array;
  wipe(): void;
} {
  const issuedAt = 10_000;
  const rootSeed = generateUserRootSeed();
  const rootPublicKey = deriveUserRootPublicKey(rootSeed);
  const delegation = createBrowserDelegation(rootSeed, {
    userId: 'user-logout',
    serverOrigin: globalThis.location.origin,
    rootEpoch: 1,
    issuedAt,
    expiresAt: issuedAt + 30 * 24 * 60 * 60 * 1_000,
  });
  rootSeed.fill(0);
  return {
    account: {
      username: 'logout@example.test',
      session: {
        accessToken: 'access-token',
        userId: 'user-logout',
        delegationId: delegation.certificate.delegationId,
        delegationExpiresAt: delegation.certificate.expiresAt,
        deletionCancelled: false,
        serverTimeMs: issuedAt,
      },
      certificate: delegation.certificate,
      rootPublicKey: encodeUserAuthorizationBytes(rootPublicKey),
      serverTimeReceiptMonotonicMs: performance.now(),
    },
    delegateSeed: delegation.delegateSeed,
    rootPublicKey,
    wipe(): void {
      delegation.delegateSeed.fill(0);
      rootPublicKey.fill(0);
    },
  };
}
