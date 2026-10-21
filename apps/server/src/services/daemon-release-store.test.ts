import { describe, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  daemonArtifactName,
  encodeReleaseManifest,
  RELEASE_MANIFEST_FILE,
  RELEASE_MANIFEST_SIGNATURE_FILE,
  RELEASE_PLATFORMS,
} from '@merkur/shared';
import {
  deriveReleaseSigningKey,
  encodeReleasePublicKey,
  encodeReleaseSignature,
  signReleaseManifest,
} from '@merkur/shared/release-signature';

import { createLogger } from '../logger';
import { readStagedRelease } from './daemon-release-store';

const logger = createLogger('daemon-release-store-test');

function signedStore(
  releases: readonly (readonly [string, number])[],
  forge: string | null = null,
) {
  const directory = mkdtempSync(path.join(tmpdir(), 'merkur-release-store-'));
  const seed = new Uint8Array(32).fill(3);
  const pair = deriveReleaseSigningKey(seed);
  const other = deriveReleaseSigningKey(new Uint8Array(32).fill(4));
  for (const [version, sequence] of releases) {
    const manifest = encodeReleaseManifest({
      sequence,
      version,
      expiresAt: 1_801_000_000_000,
      minimumSequence: 1,
      artifacts: RELEASE_PLATFORMS.map((platform) => ({
        name: daemonArtifactName(platform),
        size: 100,
        sha512: 'ab'.repeat(64),
      })),
    });
    const signer = version === forge ? other : pair;
    const signature = signReleaseManifest(manifest, signer, new Uint8Array(32).fill(5));
    mkdirSync(path.join(directory, version));
    writeFileSync(path.join(directory, version, RELEASE_MANIFEST_FILE), manifest);
    writeFileSync(
      path.join(directory, version, RELEASE_MANIFEST_SIGNATURE_FILE),
      encodeReleaseSignature(signature),
    );
  }
  const publicKey = encodeReleasePublicKey(pair.publicKey);
  pair.free();
  other.free();
  return {
    directory,
    publicKey,
    dispose: () => rmSync(directory, { recursive: true, force: true }),
  };
}

describe('daemon release store', () => {
  test('stages the newest signed release past the server’s own, and nothing older', () => {
    const store = signedStore([
      ['v1.0.0', 10],
      ['v1.1.0', 11],
      ['v1.2.0', 12],
    ]);
    try {
      expect(readStagedRelease(store.directory, 'v1.1.0', store.publicKey, logger)).toBe('v1.2.0');
      expect(readStagedRelease(store.directory, 'v1.2.0', store.publicKey, logger)).toBeNull();
      // A server whose own release is missing has nothing to compare with.
      expect(readStagedRelease(store.directory, 'v9.9.9', store.publicKey, logger)).toBeNull();
      expect(
        readStagedRelease(path.join(store.directory, 'absent'), 'v1.0.0', store.publicKey, logger),
      ).toBeNull();
    } finally {
      store.dispose();
    }
  });

  test('ignores a release another key signed or whose tag is not its directory', () => {
    const store = signedStore(
      [
        ['v1.0.0', 10],
        ['v1.1.0', 11],
      ],
      'v1.1.0',
    );
    try {
      expect(readStagedRelease(store.directory, 'v1.0.0', store.publicKey, logger)).toBeNull();
      mkdirSync(path.join(store.directory, 'v2.0.0'));
      // v1.0.0's signed manifest, under another tag's name.
      for (const file of [RELEASE_MANIFEST_FILE, RELEASE_MANIFEST_SIGNATURE_FILE]) {
        copyFileSync(
          path.join(store.directory, 'v1.0.0', file),
          path.join(store.directory, 'v2.0.0', file),
        );
      }
      expect(readStagedRelease(store.directory, 'v1.0.0', store.publicKey, logger)).toBeNull();
    } finally {
      store.dispose();
    }
  });
});
