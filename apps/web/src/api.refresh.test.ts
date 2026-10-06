import { beforeAll, describe, expect, mock, test } from 'bun:test';

/**
 * Covers the browser half of strict refresh-token reuse detection.
 *
 * The server grants no grace for a spent refresh token, so these client
 * guarantees are what keep an honest session from being revoked: serialize
 * refreshes across tabs, never present the cookie again once a refresh outcome
 * is ambiguous, and make that retirement visible to every tab on the origin.
 */

const RETIREMENT_KEY = 'merkur:refresh-credential-retired';
const GENERATION_KEY = 'merkur:refresh-credential-generation';

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

interface StorageAccess {
  readonly op: 'get' | 'set' | 'remove';
  readonly key: string;
  /** Whether the refresh lock was held at the moment of the access. */
  readonly underLock: boolean;
}

const lockRequests: LockRequest[] = [];
const storageAccesses: StorageAccess[] = [];
const storageEntries = new Map<string, string>();
let lockHeld = false;

const fetchMock = mock((): Promise<Response> => Promise.reject(new TypeError('network down')));

let refreshAccessToken: () => Promise<unknown>;

function accessesFor(op: StorageAccess['op']): StorageAccess[] {
  return storageAccesses.filter((access) => access.op === op && access.key === RETIREMENT_KEY);
}

beforeAll(async () => {
  // api.ts binds its Eden client to `location.origin` at module scope, and the
  // lock and storage are browser APIs; none exist in the bun test realm.
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { origin: 'https://merkur.test' },
  });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem(key: string): string | null {
        storageAccesses.push({ op: 'get', key, underLock: lockHeld });
        return storageEntries.get(key) ?? null;
      },
      setItem(key: string, value: string): void {
        storageAccesses.push({ op: 'set', key, underLock: lockHeld });
        storageEntries.set(key, value);
      },
      removeItem(key: string): void {
        storageAccesses.push({ op: 'remove', key, underLock: lockHeld });
        storageEntries.delete(key);
      },
    },
  });
  Object.defineProperty(globalThis.navigator, 'locks', {
    configurable: true,
    value: {
      request<T>(name: string, options: { mode?: string }, callback: () => Promise<T>): Promise<T> {
        lockRequests.push({ name, mode: options.mode });
        return (async () => {
          lockHeld = true;
          try {
            return await callback();
          } finally {
            lockHeld = false;
          }
        })();
      },
    },
  });
  Object.defineProperty(globalThis, 'fetch', { configurable: true, value: fetchMock });

  ({ refreshAccessToken } = await import('./api'));
});

describe('refreshAccessToken', () => {
  test('serializes across tabs and retires the credential after an ambiguous failure', async () => {
    await expect(refreshAccessToken()).rejects.toBeDefined();

    // The rotating credential is taken under an exclusive origin-wide lock, so a
    // second tab cannot post the same one-use cookie concurrently.
    expect(lockRequests).toEqual([{ name: 'merkur-auth-refresh', mode: 'exclusive' }]);
    const attemptsAfterFirstFailure = fetchMock.mock.calls.length;
    expect(attemptsAfterFirstFailure).toBeGreaterThan(0);

    // Retirement is recorded origin-wide, not just in this tab's memory, and is
    // tagged with the generation it applies to rather than a bare boolean.
    expect(storageEntries.get(RETIREMENT_KEY)).toBe('0');

    // The ordering that makes the lock meaningful: Web Locks releases as soon as
    // the callback's promise settles, so retiring from the surrounding
    // `.then`/`.catch` would let a waiting tab read the flag before it is
    // written. Both the write and at least one read must happen while held.
    expect(accessesFor('set').every((access) => access.underLock)).toBe(true);
    expect(accessesFor('get').some((access) => access.underLock)).toBe(true);

    // A network failure may have rotated server-side with the Set-Cookie lost,
    // which would leave a spent token in the jar. Re-presenting it is
    // indistinguishable from a replay and would revoke the whole chain, so the
    // credential is retired and no further request is made.
    expect(await refreshAccessToken()).toBeNull();
    expect(await refreshAccessToken()).toBeNull();
    expect(fetchMock.mock.calls.length).toBe(attemptsAfterFirstFailure);
    expect(lockRequests).toHaveLength(1);
  });

  test('a sibling tab never presents a credential another tab retired', async () => {
    const attemptsBefore = fetchMock.mock.calls.length;
    const locksBefore = lockRequests.length;

    // A distinct module instance is a faithful second tab: fresh module-level
    // state, shared globals and shared storage. This also stands in for a tab
    // opened after the failure, and for a reloaded one.
    const secondTabSpecifier = './api';
    const secondTab = (await import(`${secondTabSpecifier}?tab=2`)) as typeof import('./api');

    // Its in-memory latch is unset, so only the persisted flag can stop it.
    expect(await secondTab.refreshAccessToken()).toBeNull();
    expect(fetchMock.mock.calls.length).toBe(attemptsBefore);
    expect(lockRequests).toHaveLength(locksBefore);
  });

  test('a successful sign-in clears the origin-wide retirement', async () => {
    expect(storageEntries.get(RETIREMENT_KEY)).toBe('0');
    fetchMock.mockImplementation(() => Promise.resolve(sessionResponse('token-1')));

    const thirdTabSpecifier = './api';
    const thirdTab = (await import(`${thirdTabSpecifier}?tab=3`)) as typeof import('./api');

    thirdTab.markAccountSessionEstablished();
    // Without this the retirement would be permanent and the user could never
    // sign back in on any tab.
    expect(storageEntries.has(RETIREMENT_KEY)).toBe(false);
    expect(storageEntries.get(GENERATION_KEY)).toBe('1');
    expect(await thirdTab.refreshAccessToken()).not.toBeNull();
  });

  test('a refresh that fails after another tab signs in does not retire the new chain', async () => {
    // Tab A starts a refresh and stalls. Sign-in deliberately does NOT take the
    // refresh lock — holding it across a password verify would stall every
    // tab — so tab B can complete a sign-in while A is still in flight.
    // Dispatch on the endpoint rather than by swapping implementations, so the
    // test does not depend on when each request happens to reach fetch.
    let failStalledRefresh: (reason: Error) => void = () => undefined;
    let markRefreshStarted: () => void = () => undefined;
    const refreshStarted = new Promise<void>((resolve) => {
      markRefreshStarted = resolve;
    });
    fetchMock.mockImplementation((...args: unknown[]) => {
      const [input] = args;
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : String((input as Request).url);
      if (url.includes('/auth/refresh')) {
        return new Promise<Response>((_resolve, reject) => {
          failStalledRefresh = reject;
          markRefreshStarted();
        });
      }
      return Promise.resolve(sessionResponse('token-2'));
    });

    const tabSpecifier = './api';
    const tabA = (await import(`${tabSpecifier}?tab=4`)) as typeof import('./api');
    const tabB = (await import(`${tabSpecifier}?tab=5`)) as typeof import('./api');

    const stalledRefresh = tabA.refreshAccessToken();
    // Let A enter the lock, capture the current generation, and dispatch before
    // B moves it. OPAQUE sign-in used to provide this scheduling edge itself.
    await refreshStarted;
    const generationBeforeSignIn = storageEntries.get(GENERATION_KEY);

    tabB.markAccountSessionEstablished();
    expect(storageEntries.get(GENERATION_KEY)).not.toBe(generationBeforeSignIn);

    // Only now does A's request fail. Its retirement carries the generation it
    // captured before B signed in, so it cannot apply to B's new chain.
    failStalledRefresh(new TypeError('network down'));
    await expect(stalledRefresh).rejects.toBeDefined();

    const tabC = (await import(`${tabSpecifier}?tab=6`)) as typeof import('./api');
    fetchMock.mockImplementation(() => Promise.resolve(sessionResponse('token-3')));
    expect(await tabC.refreshAccessToken()).not.toBeNull();
  });
});
