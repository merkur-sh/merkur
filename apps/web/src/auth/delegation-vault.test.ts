import { afterEach, describe, expect, test } from 'bun:test';
import {
  decodeUserAuthorizationBytes,
  USER_AUTHORIZATION_PUBLIC_KEY_BYTES,
  USER_DELEGATION_LIFETIME_MS,
} from '@merkur/shared/user-authorization';

import { ClientSession } from '../../../../packages/e2e-wasm/pkg/e2e_wasm.js';
import { loadE2eWasmModule } from '../lib/e2e-wasm-module';
import { createBrowserDelegation } from './browser-delegation';
import {
  clearBrowserDelegation,
  hasBrowserDelegation,
  loadBrowserDelegation,
  loadBrowserSessionDelegation,
  saveBrowserDelegation,
} from './delegation-vault';
import { TEST_DELEGATION_CERTIFICATE } from './test-authorization-fixtures';
import { deriveUserRootPublicKey, generateUserRootSeed } from './user-root';

const originalDecrypt = crypto.subtle.decrypt;
const WRAPPING_KEY_ID = 'wrapping-key';
const ACTIVE_DELEGATION_ID = 'active-delegation';
const originalIndexedDb = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
const originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

afterEach(() => {
  crypto.subtle.decrypt = originalDecrypt;
  restoreGlobal('indexedDB', originalIndexedDb);
  restoreGlobal('location', originalLocation);
  restoreGlobal('navigator', originalNavigator);
});

describe('browser delegation vault ownership', () => {
  test('an old tab cannot clear a newer delegation', async () => {
    const record = persistedDelegation('user-new', 'delegation-new');
    const fake = installFakeIndexedDb(
      new Map([
        [WRAPPING_KEY_ID, { fake: 'key' }],
        [ACTIVE_DELEGATION_ID, record],
      ]),
    );

    expect(
      await clearBrowserDelegation({ userId: 'user-old', delegationId: 'delegation-old' }),
    ).toBe(false);
    expect(fake.records.get(ACTIVE_DELEGATION_ID)).toEqual(record);
    expect(fake.deletedKeys).toEqual([]);
  });

  test('clears the exact delegation and its nonextractable wrapping key together', async () => {
    const fake = installFakeIndexedDb(
      new Map([
        [WRAPPING_KEY_ID, { fake: 'key' }],
        [ACTIVE_DELEGATION_ID, persistedDelegation('user-1', 'delegation-1')],
      ]),
    );

    expect(await clearBrowserDelegation({ userId: 'user-1', delegationId: 'delegation-1' })).toBe(
      true,
    );
    expect(fake.records.size).toBe(0);
    expect(fake.deletedKeys).toEqual([WRAPPING_KEY_ID, ACTIVE_DELEGATION_ID]);
  });

  test('a previous account observes an origin-wide replacement without deleting it', async () => {
    const record = persistedDelegation('user-new', 'delegation-new');
    const fake = installFakeIndexedDb(
      new Map([
        [WRAPPING_KEY_ID, { fake: 'key' }],
        [ACTIVE_DELEGATION_ID, record],
      ]),
    );

    expect(await loadBrowserDelegation('user-old')).toBeNull();
    expect(fake.records.get(ACTIVE_DELEGATION_ID)).toEqual(record);
    expect(fake.deletedKeys).toEqual([]);
  });
});

describe('browser delegation vault presence', () => {
  test('a complete record is present for any account', async () => {
    installFakeIndexedDb(
      new Map([
        [WRAPPING_KEY_ID, { fake: 'key' }],
        [ACTIVE_DELEGATION_ID, persistedDelegation('user-1', 'delegation-1')],
      ]),
    );

    expect(await hasBrowserDelegation()).toBe(true);
  });

  test('an empty vault and an orphaned half are both absent', async () => {
    installFakeIndexedDb(new Map());
    expect(await hasBrowserDelegation()).toBe(false);

    installFakeIndexedDb(
      new Map([[ACTIVE_DELEGATION_ID, persistedDelegation('user-1', 'delegation-1')]]),
    );
    expect(await hasBrowserDelegation()).toBe(false);
  });
});

describe('browser session signer ownership', () => {
  test('wipes the decrypted seed before handing the checked signer to a session', async () => {
    await installValidDelegation();
    const plaintexts: Uint8Array[] = [];
    crypto.subtle.decrypt = async (...args: Parameters<SubtleCrypto['decrypt']>) => {
      const result = await originalDecrypt.apply(crypto.subtle, args);
      plaintexts.push(new Uint8Array(result));
      return result;
    };
    const delegation = await loadBrowserSessionDelegation('user-session');
    if (delegation === null) throw new Error('missing session delegation');
    try {
      expect(plaintexts).toHaveLength(1);
      expect(plaintexts[0]).toEqual(new Uint8Array(32));
      const publicKey = delegation.delegateKey.publicKey;
      const expected = decodeUserAuthorizationBytes(
        delegation.certificate.delegatePublicKey,
        USER_AUTHORIZATION_PUBLIC_KEY_BYTES,
        'delegate public key',
      );
      expect(publicKey).toEqual(expected);
      publicKey.fill(0);
      expected.fill(0);
      const { memory } = await loadE2eWasmModule();
      // SAFETY: the generated wasm-bindgen class initializes __wbg_ptr to its
      // allocation address; this signer has not been transferred or freed.
      const signerPointer = (
        delegation.delegateKey as typeof delegation.delegateKey & {
          readonly __wbg_ptr: number;
        }
      ).__wbg_ptr;
      const session = new ClientSession(
        JSON.stringify(delegation.certificate),
        delegation.rootPublicKey,
        'https://merkur.test',
        'browser',
        true,
        delegation.delegateKey,
      );
      session.free();
      expect(
        new Uint8Array(memory.buffer, signerPointer + 64, 256).every((byte) => byte === 0),
      ).toBe(true);
    } finally {
      delegation.delegateKey.free();
      delegation.rootPublicKey.fill(0);
    }
  });

  test('rejects a mismatched seed and wipes it before rejecting', async () => {
    const fake = await installValidDelegation();
    const plaintexts: Uint8Array[] = [];
    crypto.subtle.decrypt = async (...args: Parameters<SubtleCrypto['decrypt']>) => {
      const result = await originalDecrypt.apply(crypto.subtle, args);
      const plaintext = new Uint8Array(result);
      plaintext.fill(4);
      plaintexts.push(plaintext);
      return result;
    };
    await expect(loadBrowserSessionDelegation('user-session')).rejects.toThrow(
      'Browser delegate seed does not match its certificate',
    );
    expect(plaintexts).toHaveLength(1);
    expect(plaintexts[0]).toEqual(new Uint8Array(32));
    expect(fake.records.size).toBe(0);
  });

  test('a cancelled construction frees its signer without affecting metadata unlocks', async () => {
    await installValidDelegation();
    const prepared = await loadBrowserSessionDelegation('user-session');
    if (prepared === null) throw new Error('missing session delegation');
    prepared.delegateKey.free();
    prepared.rootPublicKey.fill(0);
    const metadata = await loadBrowserDelegation('user-session');
    if (metadata === null) throw new Error('missing metadata delegation');
    expect(metadata.delegateSeed.some((byte) => byte !== 0)).toBe(true);
    metadata.delegateSeed.fill(0);
    metadata.rootPublicKey.fill(0);
  });
});

async function installValidDelegation() {
  const fake = installFakeIndexedDb(new Map());
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { origin: 'https://merkur.test' },
  });
  const rootSeed = generateUserRootSeed();
  const rootPublicKey = deriveUserRootPublicKey(rootSeed);
  const issuedAt = 1_800_000_000_000;
  const created = createBrowserDelegation(rootSeed, {
    userId: 'user-session',
    serverOrigin: 'https://merkur.test',
    rootEpoch: 1,
    issuedAt,
    expiresAt: issuedAt + USER_DELEGATION_LIFETIME_MS,
  });
  try {
    await saveBrowserDelegation(
      'session',
      rootPublicKey,
      created.certificate,
      created.delegateSeed,
    );
    return fake;
  } finally {
    rootSeed.fill(0);
    rootPublicKey.fill(0);
    created.delegateSeed.fill(0);
  }
}

describe('browser delegation vault durability hint', () => {
  /**
   * Firefox answers `navigator.storage.persist()` with a permission prompt and
   * leaves the promise pending until the user responds. Awaiting it here made
   * the whole sign-in wait on a dialog, so a Firefox that never answered one
   * never reached the device list — measured 2026-09-08, unsettled after 8 s.
   * The hint is advisory and its answer is read by nothing; the vault write
   * must complete regardless of whether it is ever answered.
   */
  test('a persistence hint that never answers cannot block the vault write', async () => {
    const records = installFakeIndexedDb(new Map()).records;
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: { origin: 'https://merkur.test' },
    });
    let requested = 0;
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        storage: {
          persist() {
            requested += 1;
            return new Promise<boolean>(() => {});
          },
        },
      },
    });

    const rootSeed = generateUserRootSeed();
    const rootPublicKey = deriveUserRootPublicKey(rootSeed);
    const issuedAt = Date.now();
    const created = createBrowserDelegation(rootSeed, {
      userId: 'user-persist',
      serverOrigin: 'https://merkur.test',
      rootEpoch: 1,
      issuedAt,
      expiresAt: issuedAt + USER_DELEGATION_LIFETIME_MS,
    });

    await Promise.race([
      saveBrowserDelegation(
        'persist@example.test',
        rootPublicKey,
        created.certificate,
        created.delegateSeed,
      ),
      // A regression never resolves at all, so any finite deadline separates
      // the two outcomes; this one is loose enough to survive a slow machine.
      new Promise<never>((_resolve, reject) =>
        setTimeout(
          () => reject(new Error('saveBrowserDelegation awaited the persistence hint')),
          5_000,
        ),
      ),
    ]);

    expect(requested).toBe(1);
    expect(records.has(WRAPPING_KEY_ID)).toBe(true);
    expect(records.has(ACTIVE_DELEGATION_ID)).toBe(true);
  });
});

function restoreGlobal(
  name: 'indexedDB' | 'location' | 'navigator',
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor === undefined) Reflect.deleteProperty(globalThis, name);
  else Object.defineProperty(globalThis, name, descriptor);
}

function persistedDelegation(userId: string, delegationId: string): object {
  return {
    username: `${userId}@example.test`,
    userId,
    rootPublicKey: 'unused-by-these-tests',
    certificate: {
      ...TEST_DELEGATION_CERTIFICATE,
      userId,
      delegationId,
    },
    nonce: 'unused-by-these-tests',
    ciphertext: 'unused-by-these-tests',
  };
}

function installFakeIndexedDb(records: Map<string, unknown>): {
  readonly records: Map<string, unknown>;
  readonly deletedKeys: string[];
} {
  const deletedKeys: string[] = [];
  const database = {
    objectStoreNames: { contains: () => true },
    transaction(_storeName: string, _mode: IDBTransactionMode) {
      // A transaction completes once every request issued on it has run, so a
      // write that issues two puts is not reported complete after the first.
      let pending = 0;
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
              const request = requestRecord();
              runOperation(() => {
                records.set(String(key), value);
                request.result = key;
                request.onsuccess?.(new Event('success'));
              });
              return request;
            },
            delete(key: IDBValidKey) {
              const stringKey = String(key);
              deletedKeys.push(stringKey);
              records.delete(stringKey);
              return {};
            },
          };
        },
      };
      function runOperation(operation: () => void): void {
        pending += 1;
        queueMicrotask(() => {
          operation();
          pending -= 1;
          queueMicrotask(() => {
            if (pending !== 0 || completed) return;
            completed = true;
            transaction.oncomplete?.(new Event('complete'));
          });
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
        const request: {
          result?: typeof database;
          error: DOMException | null;
          onsuccess: ((event: Event) => void) | null;
          onerror: ((event: Event) => void) | null;
          onblocked: ((event: Event) => void) | null;
          onupgradeneeded: ((event: Event) => void) | null;
        } = {
          error: null,
          onsuccess: null,
          onerror: null,
          onblocked: null,
          onupgradeneeded: null,
        };
        queueMicrotask(() => {
          request.result = database;
          request.onsuccess?.(new Event('success'));
        });
        return request;
      },
    },
  });
  return { records, deletedKeys };
}

function requestRecord(): {
  result?: unknown;
  error: DOMException | null;
  onsuccess: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
} {
  return { error: null, onsuccess: null, onerror: null };
}
