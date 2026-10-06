import { beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { DelegationRevocationStatement } from '@merkur/shared/user-authorization';
import { retryPendingLogout, storeLogoutTombstone } from './revocation-outbox';
import { TEST_DELEGATION_CERTIFICATE } from './test-authorization-fixtures';

const LOGOUT_TOMBSTONE_KEY = 'merkur:pending-browser-logout';
const storageEntries = new Map<string, string>();

beforeAll(() => {
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
});

beforeEach(() => storageEntries.clear());

describe('logout revocation outbox', () => {
  test('delivers and clears an exact replay without ever requiring a bearer token', async () => {
    const authorization = createAuthorization();
    const requests: Array<{ readonly url: string; readonly init: RequestInit | undefined }> = [];
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: mock((input: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: String(input), init });
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }),
    });

    storeLogoutTombstone(authorization);
    expect(await retryPendingLogout()).toBe('delivered');
    expect(storageEntries.has(LOGOUT_TOMBSTONE_KEY)).toBe(false);

    // The server treats this exact signed replay idempotently. The client must
    // accept the repeated success and remove the public retry record again.
    storeLogoutTombstone(authorization);
    expect(await retryPendingLogout()).toBe('delivered');
    expect(storageEntries.has(LOGOUT_TOMBSTONE_KEY)).toBe(false);

    expect(requests).toHaveLength(2);
    const firstBody = JSON.parse(String(requests[0]?.init?.body)) as unknown;
    const secondBody = JSON.parse(String(requests[1]?.init?.body)) as unknown;
    expect(secondBody).toEqual(firstBody);
    for (const request of requests) {
      expect(new URL(request.url).pathname).toBe('/api/auth/logout');
      expect(new Headers(request.init?.headers).has('authorization')).toBe(false);
      expect(request.init?.credentials).toBe('include');
    }
  });

  test('keeps the public tombstone when delivery is offline', async () => {
    const authorization = createAuthorization();
    storeLogoutTombstone(authorization);
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: mock(() => Promise.reject(new TypeError('offline'))),
    });

    expect(await retryPendingLogout()).toBe('pending');
    expect(JSON.parse(storageEntries.get(LOGOUT_TOMBSTONE_KEY) ?? 'null')).toEqual(authorization);
  });
});

function createAuthorization(): {
  readonly actorCertificate: typeof TEST_DELEGATION_CERTIFICATE;
  readonly revocation: DelegationRevocationStatement;
} {
  return {
    actorCertificate: TEST_DELEGATION_CERTIFICATE,
    revocation: {
      userId: TEST_DELEGATION_CERTIFICATE.userId,
      rootKeyCommitment: TEST_DELEGATION_CERTIFICATE.rootKeyCommitment,
      actorDelegationId: TEST_DELEGATION_CERTIFICATE.delegationId,
      targets: [
        {
          delegationId: TEST_DELEGATION_CERTIFICATE.delegationId,
          expiresAt: TEST_DELEGATION_CERTIFICATE.expiresAt,
        },
      ],
      issuedAt: 10,
      nonce: Buffer.alloc(32, 11).toString('base64url'),
      signature: Buffer.alloc(4_627, 12).toString('base64url'),
    },
  };
}
