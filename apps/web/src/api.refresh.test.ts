import { beforeAll, describe, expect, mock, test } from 'bun:test';
import { IDBFactory } from 'fake-indexeddb';

import { STORAGE_NAMES } from './lib/storage-names';

/**
 * Covers the browser half of strict refresh-token reuse detection.
 *
 * The server grants no grace for a spent refresh token, so these client
 * guarantees are what keep an honest session from being revoked: serialize
 * refreshes across tabs, never present the cookie again once a refresh outcome
 * is ambiguous, and make that retirement visible to every tab on the origin,
 * including the one already waiting for the lock.
 *
 * Each tab is a distinct module instance of `./api`: fresh module-level state,
 * shared globals, one IndexedDB and one lock manager, as tabs of one origin have.
 */

function sessionResponse(accessToken: string): Response {
  return new Response(
    JSON.stringify({
      accessToken,
      userId: 'user-1',
      delegationId: 'delegation-1',
      delegationExpiresAt: 2_592_000_001,
      deletionCancelled: false,
      serverTimeMs: 1,
    }),
    {
      status: 200,
      headers: { 'content-type': 'application/json' },
    },
  );
}

interface LockRequest {
  readonly name: string;
  readonly mode: string | undefined;
}

const lockRequests: LockRequest[] = [];

/** First come, first served per name, as a browser grants exclusive locks. */
const lockTails = new Map<string, Promise<void>>();

const fetchMock = mock(
  (_input: RequestInfo | URL): Promise<Response> => Promise.reject(new TypeError('network down')),
);

function refreshRequests(): number {
  return fetchMock.mock.calls.filter(([input]) => String(input).includes('/auth/refresh')).length;
}

type Api = typeof import('./api');
let tabCount = 0;

async function openTab(): Promise<Api> {
  tabCount += 1;
  // The first tab is the literal import, which is what puts `./api` in this test's
  // checkout; every later one is a distinct instance of the same file.
  if (tabCount === 1) return await import('./api');
  const specifier = './api';
  // SAFETY: the module is `./api`; the query only makes Bun load a distinct instance of it.
  return (await import(`${specifier}?tab=${tabCount}`)) as Api;
}

/** The stored credential state, read as another tab would. */
async function storedCredential(): Promise<unknown> {
  const connection = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(STORAGE_NAMES.refresh_credential);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    if (!connection.objectStoreNames.contains('credential')) return undefined;
    return await new Promise((resolve, reject) => {
      const request = connection.transaction('credential').objectStore('credential').get('current');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    connection.close();
  }
}

beforeAll(() => {
  // api.ts binds its Eden client to `location.origin` at module scope, and the
  // lock and IndexedDB are browser APIs; none exist in the bun test realm.
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { origin: 'https://merkur.test' },
  });
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: new IDBFactory() });
  Object.defineProperty(globalThis.navigator, 'locks', {
    configurable: true,
    value: {
      request<T>(name: string, options: { mode?: string }, callback: () => Promise<T>): Promise<T> {
        lockRequests.push({ name, mode: options.mode });
        const previous = lockTails.get(name) ?? Promise.resolve();
        let release = (): void => undefined;
        lockTails.set(
          name,
          previous.then(
            () =>
              new Promise<void>((resolve) => {
                release = resolve;
              }),
          ),
        );
        return previous.then(async () => {
          try {
            return await callback();
          } finally {
            release();
          }
        });
      },
    },
  });
  Object.defineProperty(globalThis, 'fetch', { configurable: true, value: fetchMock });
});

describe('refreshAccessToken', () => {
  test('a tab queued behind a failing refresh never presents the credential it retired', async () => {
    let failStalledRefresh: (reason: Error) => void = () => undefined;
    let markRefreshStarted: () => void = () => undefined;
    const refreshStarted = new Promise<void>((resolve) => {
      markRefreshStarted = resolve;
    });
    fetchMock.mockImplementation(
      (_input) =>
        new Promise<Response>((_resolve, reject) => {
          failStalledRefresh = reject;
          markRefreshStarted();
        }),
    );
    const first = await openTab();
    const second = await openTab();

    const failing = first.refreshAccessToken();
    await refreshStarted;
    // The second tab reads no retirement yet, so it queues for the lock.
    const queued = second.refreshAccessToken();
    failStalledRefresh(new TypeError('network down'));
    await expect(failing).rejects.toBeDefined();

    // A network failure may have rotated server-side with the Set-Cookie lost,
    // which would leave a spent token in the jar. The first tab records that
    // before it releases the lock, so the tab that takes it next reads it and
    // sends nothing: re-presenting the token would revoke the whole chain.
    expect(await queued).toBeNull();
    expect(refreshRequests()).toBe(1);
    expect(lockRequests.every((request) => request.mode === 'exclusive')).toBe(true);
    expect(await storedCredential()).toEqual({ generation: 0, retired: true });
  });

  test('a retired credential is never presented again, by this tab or a new one', async () => {
    const attemptsBefore = refreshRequests();
    const opened = await openTab();
    expect(await opened.refreshAccessToken()).toBeNull();
    expect(await opened.refreshAccessToken()).toBeNull();
    expect(refreshRequests()).toBe(attemptsBefore);
  });

  test('a successful sign-in clears the origin-wide retirement', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(sessionResponse('token-1')));
    const signedIn = await openTab();

    // Without this the retirement would be permanent and the user could never
    // sign back in on any tab.
    await signedIn.markAccountSessionEstablished();
    expect(await storedCredential()).toEqual({ generation: 1, retired: false });
    expect(await signedIn.refreshAccessToken()).not.toBeNull();
  });

  test('a refresh that fails after another tab signs in does not retire the new chain', async () => {
    // Tab A starts a refresh and stalls. Sign-in deliberately does NOT take the
    // refresh lock — holding it across a password verify would stall every
    // tab — so tab B can complete a sign-in while A is still in flight.
    let failStalledRefresh: (reason: Error) => void = () => undefined;
    let markRefreshStarted: () => void = () => undefined;
    const refreshStarted = new Promise<void>((resolve) => {
      markRefreshStarted = resolve;
    });
    fetchMock.mockImplementation((input) => {
      if (String(input).includes('/auth/refresh')) {
        return new Promise<Response>((_resolve, reject) => {
          failStalledRefresh = reject;
          markRefreshStarted();
        });
      }
      return Promise.resolve(sessionResponse('token-2'));
    });

    const tabA = await openTab();
    const tabB = await openTab();
    const stalledRefresh = tabA.refreshAccessToken();
    // Let A enter the lock and capture the current generation before B moves it.
    await refreshStarted;

    await tabB.markAccountSessionEstablished();
    expect(await storedCredential()).toEqual({ generation: 2, retired: false });

    // Only now does A's request fail. Its retirement carries the generation it
    // captured before B signed in, so it cannot apply to B's new chain.
    failStalledRefresh(new TypeError('network down'));
    await expect(stalledRefresh).rejects.toBeDefined();
    expect(await storedCredential()).toEqual({ generation: 2, retired: false });

    const tabC = await openTab();
    fetchMock.mockImplementation(() => Promise.resolve(sessionResponse('token-3')));
    expect(await tabC.refreshAccessToken()).not.toBeNull();
  });
});
