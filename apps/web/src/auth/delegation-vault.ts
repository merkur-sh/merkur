import { hasExactKeys, isRecord } from '@merkur/shared';
import {
  decodeUserAuthorizationBytes,
  deriveUserAuthorizationPublicKey,
  equalBytes,
  parseUserDelegationCertificate,
  serializeUserDelegationCertificate,
  USER_AUTHORIZATION_PUBLIC_KEY_BYTES,
  USER_AUTHORIZATION_SEED_BYTES,
  type UserDelegationCertificate,
} from '@merkur/shared/user-authorization';

import { loadE2eWasmModule } from '../lib/e2e-wasm-module';
import { validateStoredBrowserDelegation } from './browser-delegation';
import { decodeBase64UrlExact, encodeBase64Url } from './encoding';

const DB_NAME = 'merkur-auth';
const DB_VERSION = 1;
const STORE_NAME = 'browser-delegation';
const WRAPPING_KEY_ID = 'wrapping-key';
const ACTIVE_DELEGATION_ID = 'active-delegation';
const DB_OPEN_TIMEOUT_MS = 3_000;
const AES_NONCE_BYTES = 12;
const AES_CIPHERTEXT_BYTES = USER_AUTHORIZATION_SEED_BYTES + 16;

interface PersistedDelegation {
  readonly username: string;
  readonly userId: string;
  readonly rootPublicKey: string;
  readonly certificate: UserDelegationCertificate;
  readonly nonce: string;
  readonly ciphertext: string;
}

export interface UnlockedBrowserDelegation {
  readonly username: string;
  readonly userId: string;
  readonly rootPublicKey: Uint8Array;
  readonly certificate: UserDelegationCertificate;
  /** Caller owns this plaintext and must wipe it as soon as the operation ends. */
  readonly delegateSeed: Uint8Array;
}

export interface BrowserDelegationIdentity {
  readonly userId: string;
  readonly delegationId: string;
}

export async function saveBrowserDelegation(
  username: string,
  rootPublicKey: Uint8Array,
  certificateValue: unknown,
  delegateSeed: Uint8Array,
): Promise<void> {
  if (username.trim().length === 0) throw new Error('Browser delegation username is invalid');
  if (delegateSeed.byteLength !== USER_AUTHORIZATION_SEED_BYTES) {
    throw new Error('Browser delegate seed has an invalid length');
  }
  await loadE2eWasmModule();
  const certificate = validateStoredBrowserDelegation(
    certificateValue,
    rootPublicKey,
    parseUserDelegationCertificate(certificateValue).userId,
  );
  verifyDelegateSeed(certificate, delegateSeed);
  const rootPublicKeyEncoded = encodeBase64Url(rootPublicKey);
  const aad = delegationAad(rootPublicKeyEncoded, certificate);
  const nonce = crypto.getRandomValues(new Uint8Array(AES_NONCE_BYTES));
  const plaintext = Uint8Array.from(delegateSeed);
  try {
    await withDelegationDb(async (db) => {
      const wrappingKey = (await readRecord(db, WRAPPING_KEY_ID)) ?? (await createWrappingKey());
      requireWrappingKey(wrappingKey);
      const ciphertext = new Uint8Array(
        await crypto.subtle.encrypt(
          { name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: 128 },
          wrappingKey,
          plaintext,
        ),
      );
      try {
        if (ciphertext.byteLength !== AES_CIPHERTEXT_BYTES) {
          throw new Error('Encrypted browser delegate seed has an invalid length');
        }
        const record: PersistedDelegation = {
          username,
          userId: certificate.userId,
          rootPublicKey: rootPublicKeyEncoded,
          certificate,
          nonce: encodeBase64Url(nonce),
          ciphertext: encodeBase64Url(ciphertext),
        };
        await writeRecords(db, wrappingKey, record);
      } finally {
        ciphertext.fill(0);
      }
    });
    // A durability hint asking the browser not to evict this origin under
    // storage pressure — the vault is already written above, and nothing here
    // reads the answer. It must never be awaited: Firefox answers `persist()`
    // by raising a permission prompt and leaves the promise pending until the
    // user responds, so awaiting it put a permission dialog in the middle of
    // sign-in and a browser that never answered one never signed in at all.
    // Measured 2026-09-08: unsettled after 8 s in Firefox, resolved in under a
    // millisecond in Chromium.
    void navigator.storage?.persist?.().catch(() => undefined);
  } finally {
    aad.fill(0);
    nonce.fill(0);
    plaintext.fill(0);
  }
}

/** One snapshot of both records, so a caller never sees a half-written vault. */
async function readVaultRecords(): Promise<readonly [unknown, unknown]> {
  return await withDelegationDb(async (db) => {
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const keyRequest = store.get(WRAPPING_KEY_ID);
    const delegationRequest = store.get(ACTIVE_DELEGATION_ID);
    return await Promise.all([
      runRequest<unknown>(keyRequest),
      runRequest<unknown>(delegationRequest),
    ]);
  });
}

/**
 * Whether this profile holds a complete delegation record at all, for any
 * account. It says nothing about validity — `loadBrowserDelegation` decides
 * that — only whether a session refresh could possibly be resumed here: without
 * a stored delegation, a refreshed access token has nothing to attach to.
 */
export async function hasBrowserDelegation(): Promise<boolean> {
  const [keyValue, delegationValue] = await readVaultRecords();
  return keyValue !== undefined && delegationValue !== undefined;
}

export async function loadBrowserDelegation(
  expectedUserId: string,
): Promise<UnlockedBrowserDelegation | null> {
  if (expectedUserId.length === 0) return null;
  const [keyValue, delegationValue] = await readVaultRecords();
  if (keyValue === undefined && delegationValue === undefined) return null;
  await loadE2eWasmModule();
  if (keyValue === undefined || delegationValue === undefined) {
    // A later save atomically overwrites either orphan. Do not run a second,
    // unconditional transaction here: another tab may install a complete
    // replacement between this snapshot and that cleanup.
    return null;
  }

  let observedIdentity: BrowserDelegationIdentity | null = null;
  try {
    const record = parsePersistedDelegation(delegationValue);
    observedIdentity = {
      userId: record.userId,
      delegationId: record.certificate.delegationId,
    };
    // The vault is origin-wide. A stale tab from the previous account must not
    // delete the credential a newer tab installed for the current account.
    if (record.userId !== expectedUserId) return null;
    requireWrappingKey(keyValue);
    const rootPublicKey = decodeUserAuthorizationBytes(
      record.rootPublicKey,
      USER_AUTHORIZATION_PUBLIC_KEY_BYTES,
      'user-root public key',
    );
    try {
      const certificate = validateStoredBrowserDelegation(
        record.certificate,
        rootPublicKey,
        expectedUserId,
      );
      const nonce = decodeBase64UrlExact(record.nonce, AES_NONCE_BYTES, 'vault nonce');
      const ciphertext = decodeBase64UrlExact(
        record.ciphertext,
        AES_CIPHERTEXT_BYTES,
        'vault ciphertext',
      );
      const aad = delegationAad(record.rootPublicKey, certificate);
      try {
        const delegateSeed = new Uint8Array(
          await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: 128 },
            keyValue,
            ciphertext,
          ),
        );
        try {
          if (delegateSeed.byteLength !== USER_AUTHORIZATION_SEED_BYTES) {
            throw new Error('Decrypted browser delegate seed has an invalid length');
          }
          verifyDelegateSeed(certificate, delegateSeed);
          return {
            username: record.username,
            userId: expectedUserId,
            rootPublicKey: rootPublicKey.slice(),
            certificate,
            delegateSeed,
          };
        } catch (error) {
          delegateSeed.fill(0);
          throw error;
        }
      } finally {
        nonce.fill(0);
        ciphertext.fill(0);
        aad.fill(0);
      }
    } finally {
      rootPublicKey.fill(0);
    }
  } catch (error) {
    await clearBrowserDelegation(observedIdentity ?? undefined).catch(() => undefined);
    throw error;
  }
}

/**
 * Delete the vault atomically, optionally only while it still contains the
 * credential the caller observed. The comparison prevents a stale tab from
 * erasing a replacement installed by a concurrent authentication attempt.
 */
export async function clearBrowserDelegation(
  expected?: BrowserDelegationIdentity,
): Promise<boolean> {
  return await withDelegationDb(async (db) => {
    return await new Promise<boolean>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      let cleared = false;
      const delegationRequest = store.get(ACTIVE_DELEGATION_ID);
      delegationRequest.onsuccess = () => {
        if (
          expected !== undefined &&
          !storedDelegationMatchesOrIsMalformed(delegationRequest.result, expected)
        ) {
          return;
        }
        store.delete(WRAPPING_KEY_ID);
        store.delete(ACTIVE_DELEGATION_ID);
        cleared = true;
      };
      delegationRequest.onerror = () =>
        reject(delegationRequest.error ?? new Error('Browser delegation vault request failed'));
      transaction.oncomplete = () => resolve(cleared);
      transaction.onerror = () =>
        reject(transaction.error ?? new Error('Browser delegation vault transaction failed'));
      transaction.onabort = () =>
        reject(transaction.error ?? new Error('Browser delegation vault transaction aborted'));
    });
  });
}

async function createWrappingKey(): Promise<CryptoKey> {
  return await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
}

function requireWrappingKey(value: unknown): asserts value is CryptoKey {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('type' in value) ||
    value.type !== 'secret' ||
    !('extractable' in value) ||
    value.extractable !== false ||
    !('algorithm' in value) ||
    typeof value.algorithm !== 'object' ||
    value.algorithm === null ||
    !('name' in value.algorithm) ||
    value.algorithm.name !== 'AES-GCM' ||
    !('length' in value.algorithm) ||
    value.algorithm.length !== 256 ||
    !('usages' in value) ||
    !Array.isArray(value.usages) ||
    value.usages.length !== 2 ||
    !value.usages.includes('encrypt') ||
    !value.usages.includes('decrypt')
  ) {
    throw new Error('Browser delegation wrapping key is invalid');
  }
}

function parsePersistedDelegation(value: unknown): PersistedDelegation {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'username',
      'userId',
      'rootPublicKey',
      'certificate',
      'nonce',
      'ciphertext',
    ]) ||
    typeof value.username !== 'string' ||
    value.username.trim().length === 0 ||
    typeof value.userId !== 'string' ||
    typeof value.rootPublicKey !== 'string' ||
    typeof value.nonce !== 'string' ||
    typeof value.ciphertext !== 'string'
  ) {
    throw new Error('Stored browser delegation is malformed');
  }
  return {
    username: value.username,
    userId: value.userId,
    rootPublicKey: value.rootPublicKey,
    certificate: parseUserDelegationCertificate(value.certificate),
    nonce: value.nonce,
    ciphertext: value.ciphertext,
  };
}

function storedDelegationMatchesOrIsMalformed(
  value: unknown,
  expected: BrowserDelegationIdentity,
): boolean {
  if (value === undefined) return true;
  try {
    const record = parsePersistedDelegation(value);
    return (
      record.userId === expected.userId && record.certificate.delegationId === expected.delegationId
    );
  } catch {
    return true;
  }
}

function verifyDelegateSeed(
  certificate: UserDelegationCertificate,
  delegateSeed: Uint8Array,
): void {
  const expectedPublicKey = decodeUserAuthorizationBytes(
    certificate.delegatePublicKey,
    USER_AUTHORIZATION_PUBLIC_KEY_BYTES,
    'delegate public key',
  );
  const publicKey = deriveUserAuthorizationPublicKey(delegateSeed);
  try {
    if (!equalBytes(publicKey, expectedPublicKey)) {
      throw new Error('Browser delegate seed does not match its certificate');
    }
  } finally {
    expectedPublicKey.fill(0);
    publicKey.fill(0);
  }
}

function delegationAad(
  rootPublicKey: string,
  certificate: UserDelegationCertificate,
): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(
    JSON.stringify({
      rootPublicKey,
      certificate: serializeUserDelegationCertificate(certificate),
    }),
  );
}

async function withDelegationDb<A>(use: (db: IDBDatabase) => Promise<A>): Promise<A> {
  const db = await openDelegationDb();
  try {
    return await use(db);
  } finally {
    db.close();
  }
}

async function openDelegationDb(): Promise<IDBDatabase> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await ownDelegationDbOpenRequest(indexedDB.open(DB_NAME, DB_VERSION));
    } catch (error) {
      lastError = error;
    }
  }
  throw toError(lastError, 'Unable to open browser delegation vault');
}

/** Close an IndexedDB connection that succeeds after the bounded owner timed out. */
export function ownDelegationDbOpenRequest(request: IDBOpenDBRequest): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    let settled = false;
    let abandoned = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      abandoned = true;
      reject(new Error('Browser delegation vault open timed out'));
    }, DB_OPEN_TIMEOUT_MS);

    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => {
      if (abandoned) {
        request.result.close();
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve(request.result);
    };
    request.onerror = () => {
      if (abandoned) return;
      settled = true;
      clearTimeout(timeout);
      reject(request.error ?? new Error('Unable to open browser delegation vault'));
    };
    request.onblocked = () => {
      if (abandoned || settled) return;
      settled = true;
      abandoned = true;
      clearTimeout(timeout);
      reject(new Error('Browser delegation vault upgrade was blocked'));
    };
  });
}

async function readRecord(db: IDBDatabase, key: string): Promise<unknown> {
  return await runRequest(db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(key));
}

async function writeRecords(
  db: IDBDatabase,
  wrappingKey: CryptoKey,
  delegation: PersistedDelegation,
): Promise<void> {
  const transaction = db.transaction(STORE_NAME, 'readwrite');
  const store = transaction.objectStore(STORE_NAME);
  store.put(wrappingKey, WRAPPING_KEY_ID);
  store.put(delegation, ACTIVE_DELEGATION_ID);
  await transactionComplete(transaction);
}

function runRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error('Browser delegation vault request failed'));
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('Browser delegation vault transaction failed'));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('Browser delegation vault transaction aborted'));
  });
}

function toError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback);
}
