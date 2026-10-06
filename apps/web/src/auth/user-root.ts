import {
  deriveUserAuthorizationPublicKey,
  equalBytes,
  USER_AUTHORIZATION_PUBLIC_KEY_BYTES,
} from '@merkur/shared/user-authorization';

import { decodeBase64UrlExact, encodeBase64Url } from './encoding';

export const ML_DSA_87_SEED_BYTES = 32;
export const ML_DSA_87_PUBLIC_KEY_BYTES = USER_AUTHORIZATION_PUBLIC_KEY_BYTES;
const OPAQUE_EXPORT_KEY_BYTES = 64;
const ROOT_ENVELOPE_NONCE_BYTES = 12;
const ROOT_ENVELOPE_CIPHERTEXT_BYTES = ML_DSA_87_SEED_BYTES + 16;
const ROOT_ENVELOPE_INFO = new TextEncoder().encode('merkur-user-root-envelope-key');

export interface UserRootEnvelope {
  readonly nonce: string;
  readonly ciphertext: string;
}

export function generateUserRootSeed(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(ML_DSA_87_SEED_BYTES));
}

export function deriveUserRootPublicKey(rootSeed: Uint8Array): Uint8Array {
  requireExactBytes(rootSeed, ML_DSA_87_SEED_BYTES, 'user-root seed');
  const publicKey = deriveUserAuthorizationPublicKey(rootSeed);
  requireExactBytes(publicKey, ML_DSA_87_PUBLIC_KEY_BYTES, 'user-root public key');
  return publicKey;
}

export async function encryptUserRootSeed(
  rootSeed: Uint8Array,
  opaqueExportKey: Uint8Array,
  userId: string,
  rootPublicKey: Uint8Array,
  serverOrigin = globalThis.location.origin,
): Promise<UserRootEnvelope> {
  requireExactBytes(rootSeed, ML_DSA_87_SEED_BYTES, 'user-root seed');
  requireExactBytes(opaqueExportKey, OPAQUE_EXPORT_KEY_BYTES, 'OPAQUE export key');
  requireExactBytes(rootPublicKey, ML_DSA_87_PUBLIC_KEY_BYTES, 'user-root public key');
  requireIdentityContext(userId, serverOrigin);

  const envelopeKey = await deriveEnvelopeKey(opaqueExportKey, userId, serverOrigin);
  const nonce = crypto.getRandomValues(new Uint8Array(ROOT_ENVELOPE_NONCE_BYTES));
  const aad = rootEnvelopeAad(userId, rootPublicKey, serverOrigin);
  const plaintext = Uint8Array.from(rootSeed);
  try {
    const encrypted = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: 128 },
        envelopeKey,
        plaintext,
      ),
    );
    try {
      requireExactBytes(encrypted, ROOT_ENVELOPE_CIPHERTEXT_BYTES, 'user-root envelope ciphertext');
      return {
        nonce: encodeBase64Url(nonce),
        ciphertext: encodeBase64Url(encrypted),
      };
    } finally {
      encrypted.fill(0);
    }
  } finally {
    nonce.fill(0);
    aad.fill(0);
    plaintext.fill(0);
  }
}

export async function decryptUserRootSeed(
  envelope: UserRootEnvelope,
  opaqueExportKey: Uint8Array,
  userId: string,
  expectedRootPublicKey: Uint8Array,
  serverOrigin = globalThis.location.origin,
): Promise<Uint8Array> {
  requireExactBytes(opaqueExportKey, OPAQUE_EXPORT_KEY_BYTES, 'OPAQUE export key');
  requireExactBytes(
    expectedRootPublicKey,
    ML_DSA_87_PUBLIC_KEY_BYTES,
    'expected user-root public key',
  );
  requireIdentityContext(userId, serverOrigin);

  const nonce = decodeBase64UrlExact(
    envelope.nonce,
    ROOT_ENVELOPE_NONCE_BYTES,
    'user-root envelope nonce',
  );
  const ciphertext = decodeBase64UrlExact(
    envelope.ciphertext,
    ROOT_ENVELOPE_CIPHERTEXT_BYTES,
    'user-root envelope ciphertext',
  );
  const aad = rootEnvelopeAad(userId, expectedRootPublicKey, serverOrigin);
  const envelopeKey = await deriveEnvelopeKey(opaqueExportKey, userId, serverOrigin);
  try {
    const rootSeed = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: 128 },
        envelopeKey,
        ciphertext,
      ),
    );
    try {
      requireExactBytes(rootSeed, ML_DSA_87_SEED_BYTES, 'decrypted user-root seed');
      const derivedPublicKey = deriveUserRootPublicKey(rootSeed);
      try {
        if (!equalBytes(derivedPublicKey, expectedRootPublicKey)) {
          throw new Error('Decrypted user-root seed does not match the account root public key');
        }
      } finally {
        derivedPublicKey.fill(0);
      }
      return rootSeed;
    } catch (error) {
      rootSeed.fill(0);
      throw error;
    }
  } finally {
    nonce.fill(0);
    ciphertext.fill(0);
    aad.fill(0);
  }
}

async function deriveEnvelopeKey(
  opaqueExportKey: Uint8Array,
  userId: string,
  serverOrigin: string,
): Promise<CryptoKey> {
  const exportKey = Uint8Array.from(opaqueExportKey);
  let material: CryptoKey;
  try {
    material = await crypto.subtle.importKey('raw', exportKey, 'HKDF', false, ['deriveKey']);
  } finally {
    exportKey.fill(0);
  }
  const salt = new TextEncoder().encode(`merkur-user-root\0${serverOrigin}\0${userId}`);
  try {
    return await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-512', salt, info: ROOT_ENVELOPE_INFO },
      material,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  } finally {
    salt.fill(0);
  }
}

function rootEnvelopeAad(
  userId: string,
  rootPublicKey: Uint8Array,
  serverOrigin: string,
): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(
    JSON.stringify({
      userId,
      rootPublicKey: encodeBase64Url(rootPublicKey),
      serverOrigin,
    }),
  );
}

function requireIdentityContext(userId: string, serverOrigin: string): void {
  if (userId.length === 0) throw new Error('User id must not be empty');
  if (serverOrigin.length === 0) throw new Error('Server origin must not be empty');
}

function requireExactBytes(value: Uint8Array, expected: number, label: string): void {
  if (!(value instanceof Uint8Array) || value.byteLength !== expected) {
    throw new Error(`${label} must be exactly ${expected} bytes`);
  }
}
