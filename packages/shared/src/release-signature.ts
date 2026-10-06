import { createHash } from 'node:crypto';
import type { MlDsa87SigningKey } from '../../e2e-wasm/pkg/e2e_wasm.js';
import { e2eWasm } from './e2e-wasm-runtime';

import {
  RELEASE_MLDSA87_CONTEXT,
  RELEASE_MLDSA87_PUBLIC_KEY_BYTES,
  RELEASE_MLDSA87_SIGNATURE_BYTES,
} from './release';

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const CONTEXT = new TextEncoder().encode(RELEASE_MLDSA87_CONTEXT);
const MLDSA87_SEED_BYTES = 32;
const MLDSA87_SIGNING_ENTROPY_BYTES = 32;

/**
 * The release signing key, expanded in WebAssembly memory. The caller must
 * `free()` it, which wipes it, in a `finally`.
 */
export function deriveReleaseSigningKey(seed: Uint8Array): MlDsa87SigningKey {
  requireLength(seed, MLDSA87_SEED_BYTES, 'release signing seed');
  const key = e2eWasm().MlDsa87SigningKey.fromSeed(seed);
  requireLength(key.publicKey, RELEASE_MLDSA87_PUBLIC_KEY_BYTES, 'release public key');
  return key;
}

export function signReleaseManifest(
  manifestBytes: Uint8Array,
  key: MlDsa87SigningKey,
  signingEntropy: Uint8Array,
): Uint8Array {
  requireLength(signingEntropy, MLDSA87_SIGNING_ENTROPY_BYTES, 'release signing entropy');
  const signature = key.sign(CONTEXT, manifestBytes, signingEntropy);
  requireLength(signature, RELEASE_MLDSA87_SIGNATURE_BYTES, 'release signature');
  return signature;
}

export function verifyReleaseManifestSignature(
  manifestBytes: Uint8Array,
  signature: Uint8Array,
  publicKey: Uint8Array,
): boolean {
  requireLength(signature, RELEASE_MLDSA87_SIGNATURE_BYTES, 'release signature');
  requireLength(publicKey, RELEASE_MLDSA87_PUBLIC_KEY_BYTES, 'release public key');
  return e2eWasm().mlDsa87Verify(publicKey, CONTEXT, manifestBytes, signature);
}

export function encodeReleaseSignature(value: Uint8Array): string {
  requireLength(value, RELEASE_MLDSA87_SIGNATURE_BYTES, 'release signature');
  return Buffer.from(value).toString('base64url');
}

export function decodeReleaseSignature(value: string): Uint8Array {
  return decodeCanonicalBase64Url(value, RELEASE_MLDSA87_SIGNATURE_BYTES, 'release signature');
}

export function encodeReleasePublicKey(value: Uint8Array): string {
  requireLength(value, RELEASE_MLDSA87_PUBLIC_KEY_BYTES, 'release public key');
  return Buffer.from(value).toString('base64url');
}

export function decodeReleasePublicKey(value: string): Uint8Array {
  return decodeCanonicalBase64Url(value, RELEASE_MLDSA87_PUBLIC_KEY_BYTES, 'release public key');
}

/**
 * The release key's fingerprint: plain SHA-256 of the 2,592 raw key bytes, as
 * eight groups of eight lowercase hex digits.
 *
 * This is what a person compares between `merkur release-key`, the README, and
 * SECURITY.md to check a first install against a channel other than the one it
 * came from. Plain SHA-256, not a domain-separated hash, so anyone can recompute
 * it from the published key with standard tools.
 */
export function releasePublicKeyFingerprint(publicKeyBase64url: string): string {
  const publicKey = decodeReleasePublicKey(publicKeyBase64url);
  try {
    const hex = createHash('sha256').update(publicKey).digest('hex');
    const groups: string[] = [];
    for (let offset = 0; offset < hex.length; offset += 8)
      groups.push(hex.slice(offset, offset + 8));
    return groups.join(' ');
  } finally {
    publicKey.fill(0);
  }
}

function decodeCanonicalBase64Url(value: string, length: number, label: string): Uint8Array {
  if (value.length === 0 || !BASE64URL_PATTERN.test(value)) {
    throw new Error(`${label} is not canonical unpadded base64url`);
  }
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value || decoded.byteLength !== length) {
    throw new Error(`${label} is not canonical unpadded base64url of ${length} bytes`);
  }
  return new Uint8Array(decoded);
}

function requireLength(value: Uint8Array, expected: number, label: string): void {
  if (!(value instanceof Uint8Array) || value.byteLength !== expected) {
    throw new Error(`${label} must be exactly ${expected} bytes`);
  }
}
