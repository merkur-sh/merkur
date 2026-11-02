import { type Cloned, defineDatabase, keyedStore } from '@merkur/browser-storage';
import { hasExactKeys, isRecord } from '@merkur/shared';
import {
  decodeUserAuthorizationBytes,
  deriveUserAuthorizationPublicKey,
  deriveUserAuthorizationSigningKey,
  equalBytes,
  type MlDsa87SigningKey,
  parseUserDelegationCertificate,
  serializeUserDelegationCertificate,
  USER_AUTHORIZATION_PUBLIC_KEY_BYTES,
  USER_AUTHORIZATION_SEED_BYTES,
  type UserDelegationCertificate,
} from '@merkur/shared/user-authorization';

import { loadE2eWasmModule } from '../lib/e2e-wasm-module';
import { STORAGE_NAMES } from '../lib/storage-names';
import { validateStoredBrowserDelegation } from './browser-delegation';
import { decodeBase64UrlExact, encodeBase64Url } from './encoding';

const VAULT_STORE = 'browser-delegation';
const ACTIVE_VAULT = 'active';
const DB_OPEN_TIMEOUT_MS = 3_000;
/**
 * Every write to the vault resolves only once it is on disk: a sign-in that
 * returned must not lose its credential to a crash, and a sign-out that
 * returned must not have it come back.
 */
const DURABLE = { durability: 'strict' } as const;
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

/**
 * The wrapping key and the delegation it seals, as one record: a reader sees
 * both or neither, so no tab ever finds a key without its delegation or a
 * delegation without the key that opens it.
 */
interface PersistedVault {
  readonly wrappingKey: CryptoKey;
  readonly delegation: PersistedDelegation;
}

const delegationVault = defineDatabase(STORAGE_NAMES.delegation_vault, 2, {
  [VAULT_STORE]: keyedStore<typeof ACTIVE_VAULT, PersistedVault>(parseVault),
});

export interface UnlockedBrowserDelegation {
  readonly username: string;
  readonly userId: string;
  readonly rootPublicKey: Uint8Array;
  readonly certificate: UserDelegationCertificate;
  /** Caller owns this plaintext and must wipe it as soon as the operation ends. */
  readonly delegateSeed: Uint8Array;
}

export interface BrowserSessionDelegation {
  readonly username: string;
  readonly userId: string;
  readonly rootPublicKey: Uint8Array;
  readonly certificate: UserDelegationCertificate;
  /** ClientSession moves the key; caller always frees this wrapper. */
  readonly delegateKey: MlDsa87SigningKey;
}

type UnlockDelegation<T> = (
  username: string,
  userId: string,
  rootPublicKey: Uint8Array,
  certificate: UserDelegationCertificate,
  delegateSeed: Uint8Array,
) => T;

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
    await withDelegationDb(async () => {
      // Encryption is not an IndexedDB request, so it runs between the read
      // and the write rather than inside either transaction.
      const wrappingKey = (await readVault())?.wrappingKey ?? (await createWrappingKey());
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
        const delegation: PersistedDelegation = {
          username,
          userId: certificate.userId,
          rootPublicKey: rootPublicKeyEncoded,
          certificate,
          nonce: encodeBase64Url(nonce),
          ciphertext: encodeBase64Url(ciphertext),
        };
        await delegationVault.write(
          [VAULT_STORE],
          (transaction) => {
            transaction.store(VAULT_STORE).put(ACTIVE_VAULT, { wrappingKey, delegation });
          },
          DURABLE,
        );
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

/**
 * Whether this profile holds a well-formed vault at all, for any account. It
 * says nothing about validity — `loadBrowserDelegation` decides that — only
 * whether a session refresh could possibly be resumed here: without a stored
 * delegation, a refreshed access token has nothing to attach to.
 */
export async function hasBrowserDelegation(): Promise<boolean> {
  return (await withDelegationDb(readVault)) !== null;
}

export function loadBrowserDelegation(
  expectedUserId: string,
): Promise<UnlockedBrowserDelegation | null> {
  return loadDelegation(expectedUserId, unlockSeed);
}

export function loadBrowserSessionDelegation(
  expectedUserId: string,
): Promise<BrowserSessionDelegation | null> {
  return loadDelegation(expectedUserId, unlockSigner);
}

async function loadDelegation<T>(
  expectedUserId: string,
  unlock: UnlockDelegation<T>,
): Promise<T | null> {
  if (expectedUserId.length === 0) return null;
  // A malformed vault reads as absent and stays until a later save replaces
  // it. Do not clear it from here: another tab may install a complete
  // replacement between this read and a second, unconditional transaction.
  const vault = await withDelegationDb(readVault);
  if (vault === null) return null;
  const record = vault.delegation;
  // The vault is origin-wide. A stale tab from the previous account must not
  // delete the credential a newer tab installed for the current account.
  if (record.userId !== expectedUserId) return null;
  await loadE2eWasmModule();

  const observedIdentity: BrowserDelegationIdentity = {
    userId: record.userId,
    delegationId: record.certificate.delegationId,
  };
  try {
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
            vault.wrappingKey,
            ciphertext,
          ),
        );
        try {
          if (delegateSeed.byteLength !== USER_AUTHORIZATION_SEED_BYTES) {
            throw new Error('Decrypted browser delegate seed has an invalid length');
          }
          return unlock(record.username, expectedUserId, rootPublicKey, certificate, delegateSeed);
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
    await clearBrowserDelegation(observedIdentity).catch(() => undefined);
    throw error;
  }
}

function unlockSeed(
  username: string,
  userId: string,
  rootPublicKey: Uint8Array,
  certificate: UserDelegationCertificate,
  delegateSeed: Uint8Array,
): UnlockedBrowserDelegation {
  verifyDelegateSeed(certificate, delegateSeed);
  return { username, userId, rootPublicKey: rootPublicKey.slice(), certificate, delegateSeed };
}

function unlockSigner(
  username: string,
  userId: string,
  rootPublicKey: Uint8Array,
  certificate: UserDelegationCertificate,
  delegateSeed: Uint8Array,
): BrowserSessionDelegation {
  const expectedPublicKey = decodeUserAuthorizationBytes(
    certificate.delegatePublicKey,
    USER_AUTHORIZATION_PUBLIC_KEY_BYTES,
    'delegate public key',
  );
  let delegateKey: MlDsa87SigningKey | null = null;
  let publicKey: Uint8Array | null = null;
  try {
    try {
      delegateKey = deriveUserAuthorizationSigningKey(delegateSeed);
    } finally {
      delegateSeed.fill(0);
    }
    publicKey = delegateKey.publicKey;
    if (!equalBytes(publicKey, expectedPublicKey)) {
      throw new Error('Browser delegate seed does not match its certificate');
    }
    const unlocked = {
      username,
      userId,
      rootPublicKey: rootPublicKey.slice(),
      certificate,
      delegateKey,
    };
    delegateKey = null;
    return unlocked;
  } finally {
    delegateKey?.free();
    publicKey?.fill(0);
    expectedPublicKey.fill(0);
  }
}

/**
 * Delete the vault atomically, optionally only while it still contains the
 * credential the caller observed. The comparison prevents a stale tab from
 * erasing a replacement installed by a concurrent authentication attempt. A
 * malformed vault is no one's credential, so it is cleared either way.
 */
export async function clearBrowserDelegation(
  expected?: BrowserDelegationIdentity,
): Promise<boolean> {
  return await withDelegationDb(() =>
    delegationVault.write(
      [VAULT_STORE],
      async (transaction) => {
        const store = transaction.store(VAULT_STORE);
        const vault = await store.get(ACTIVE_VAULT);
        if (
          expected !== undefined &&
          vault !== null &&
          (vault.delegation.userId !== expected.userId ||
            vault.delegation.certificate.delegationId !== expected.delegationId)
        ) {
          return false;
        }
        store.delete(ACTIVE_VAULT);
        return true;
      },
      DURABLE,
    ),
  );
}

function readVault(): Promise<PersistedVault | null> {
  return delegationVault.read([VAULT_STORE], (transaction) =>
    transaction.store(VAULT_STORE).get(ACTIVE_VAULT),
  );
}

/**
 * Connects to the vault, bounded, then runs `use` on the connection: an open
 * that has not succeeded by the deadline is given up, and the connection it
 * would have produced is closed on arrival. One failed attempt is retried
 * before the error reaches the caller; `use` itself runs once.
 */
async function withDelegationDb<A>(use: () => Promise<A>): Promise<A> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await delegationVault.connect({ signal: AbortSignal.timeout(DB_OPEN_TIMEOUT_MS) });
    } catch (error) {
      lastError = error;
      continue;
    }
    return await use();
  }
  throw lastError instanceof Error
    ? lastError
    : new Error('Unable to open browser delegation vault');
}

async function createWrappingKey(): Promise<CryptoKey> {
  return await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
}

function parseVault(value: Cloned): PersistedVault | null {
  if (!isRecord(value) || !hasExactKeys(value, ['wrappingKey', 'delegation'])) return null;
  if (!isWrappingKey(value.wrappingKey)) return null;
  try {
    return {
      wrappingKey: value.wrappingKey,
      delegation: parsePersistedDelegation(value.delegation),
    };
  } catch (cause) {
    // The delegation parsers refuse a malformed record by throwing an `Error`.
    if (!(cause instanceof Error)) throw cause;
    return null;
  }
}

function isWrappingKey(value: unknown): value is CryptoKey {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    value.type === 'secret' &&
    'extractable' in value &&
    value.extractable === false &&
    'algorithm' in value &&
    typeof value.algorithm === 'object' &&
    value.algorithm !== null &&
    'name' in value.algorithm &&
    value.algorithm.name === 'AES-GCM' &&
    'length' in value.algorithm &&
    value.algorithm.length === 256 &&
    'usages' in value &&
    Array.isArray(value.usages) &&
    value.usages.length === 2 &&
    value.usages.includes('encrypt') &&
    value.usages.includes('decrypt')
  );
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
