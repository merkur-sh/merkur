import { describe, expect, test } from 'bun:test';

import vector from '../../../../packages/shared/test-vectors/user-root-envelope.json';
import { decryptUserRootSeed, deriveUserRootPublicKey, encryptUserRootSeed } from './user-root';

describe('OPAQUE-wrapped user root', () => {
  test('opens the envelope WebCrypto sealed, so every stored account still unlocks', async () => {
    const exportKey = new Uint8Array(Buffer.from(vector.exportKeyHex, 'hex'));
    const rootPublicKey = new Uint8Array(Buffer.from(vector.rootPublicKey, 'base64url'));
    const seed = await decryptUserRootSeed(
      vector.envelope,
      exportKey,
      vector.userId,
      rootPublicKey,
      vector.serverOrigin,
    );
    expect(Buffer.from(seed).toString('hex')).toBe(vector.rootSeedHex);
    seed.fill(0);
  });

  test('round-trips the 32-byte seed and rejects a different export key', async () => {
    const rootSeed = new Uint8Array(32).fill(1);
    const rootPublicKey = deriveUserRootPublicKey(rootSeed);
    const exportKey = new Uint8Array(64).fill(2);
    const wrongExportKey = new Uint8Array(64).fill(3);
    const origin = 'https://merkur.example';
    try {
      const envelope = await encryptUserRootSeed(
        rootSeed,
        exportKey,
        'user-1',
        rootPublicKey,
        origin,
      );
      expect(Buffer.from(envelope.nonce, 'base64url')).toHaveLength(12);
      expect(Buffer.from(envelope.ciphertext, 'base64url')).toHaveLength(48);

      const decrypted = await decryptUserRootSeed(
        envelope,
        exportKey,
        'user-1',
        rootPublicKey,
        origin,
      );
      expect(decrypted).toEqual(rootSeed);
      decrypted.fill(0);
      await expect(
        decryptUserRootSeed(envelope, wrongExportKey, 'user-1', rootPublicKey, origin),
      ).rejects.toBeDefined();
    } finally {
      rootSeed.fill(0);
      rootPublicKey.fill(0);
      exportKey.fill(0);
      wrongExportKey.fill(0);
    }
  });
});
