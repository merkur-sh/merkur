import { describe, expect, test } from 'bun:test';

import {
  decodeReleasePublicKey,
  decodeReleaseSignature,
  deriveReleaseSigningKey,
  encodeReleasePublicKey,
  encodeReleaseSignature,
  releasePublicKeyFingerprint,
  signReleaseManifest,
  verifyReleaseManifestSignature,
} from './release-signature';

describe('release key fingerprint', () => {
  test('is plain SHA-256 of the raw key, as eight groups of eight hex digits', () => {
    const pair = deriveReleaseSigningKey(new Uint8Array(32).fill(7));
    try {
      const expected = new Bun.CryptoHasher('sha256').update(pair.publicKey).digest('hex');
      const fingerprint = releasePublicKeyFingerprint(encodeReleasePublicKey(pair.publicKey));
      expect(fingerprint).toMatch(/^[0-9a-f]{8}( [0-9a-f]{8}){7}$/);
      expect(fingerprint.replaceAll(' ', '')).toBe(expected);
    } finally {
      pair.free();
    }
  });
});

describe('ML-DSA-87 release signatures', () => {
  test('signs and verifies canonical manifest bytes with the fixed release context', () => {
    const seed = new Uint8Array(32).fill(7);
    const entropy = new Uint8Array(32).fill(9);
    const manifest = new TextEncoder().encode('{"sequence":1}\n');
    const pair = deriveReleaseSigningKey(seed);

    try {
      const signature = signReleaseManifest(manifest, pair, entropy);
      expect(verifyReleaseManifestSignature(manifest, signature, pair.publicKey)).toBe(true);
      expect(
        verifyReleaseManifestSignature(
          new TextEncoder().encode('{"sequence":2}\n'),
          signature,
          pair.publicKey,
        ),
      ).toBe(false);
      expect(decodeReleaseSignature(encodeReleaseSignature(signature))).toEqual(signature);
      expect(decodeReleasePublicKey(encodeReleasePublicKey(pair.publicKey))).toEqual(
        pair.publicKey,
      );
    } finally {
      pair.free();
      seed.fill(0);
      entropy.fill(0);
    }
  });

  test('rejects padded, truncated, and malformed key material', () => {
    expect(() => decodeReleasePublicKey('AA==')).toThrow('canonical');
    expect(() => decodeReleaseSignature('AA')).toThrow('4627 bytes');
  });
});
