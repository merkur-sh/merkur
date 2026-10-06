import { describe, expect, test } from 'bun:test';

import {
  daemonArtifactName,
  encodeReleaseManifest,
  parseCanonicalReleaseManifest,
  RELEASE_PLATFORMS,
  type ReleaseManifest,
} from './release';

const DIGEST = 'ab'.repeat(64);

function manifest(): ReleaseManifest {
  return {
    sequence: 42,
    version: 'v1.2.3',
    expiresAt: 1_900_000_000_000,
    minimumSequence: 40,
    artifacts: RELEASE_PLATFORMS.map((platform, index) => ({
      name: daemonArtifactName(platform),
      size: 100 + index,
      sha512: DIGEST,
    })),
  };
}

describe('release manifest', () => {
  test('round-trips one exact canonical representation', () => {
    const encoded = encodeReleaseManifest(manifest());

    expect(new TextDecoder().decode(encoded)).toBe(`${JSON.stringify(manifest())}\n`);
    expect(parseCanonicalReleaseManifest(encoded)).toEqual(manifest());
  });

  test('rejects reordered fields even when the JSON meaning is unchanged', () => {
    const value = manifest();
    const reordered = new TextEncoder().encode(
      `${JSON.stringify({ version: value.version, sequence: value.sequence, expiresAt: value.expiresAt, minimumSequence: value.minimumSequence, artifacts: value.artifacts })}\n`,
    );

    expect(() => parseCanonicalReleaseManifest(reordered)).toThrow('exact canonical fields');
  });

  test('rejects missing, reordered, or non-SHA-512 artifact entries', () => {
    const value = manifest();
    expect(() =>
      encodeReleaseManifest({
        ...value,
        artifacts: [...value.artifacts].reverse(),
      }),
    ).toThrow('must be named');
    expect(() =>
      encodeReleaseManifest({
        ...value,
        artifacts: value.artifacts.map((artifact, index) =>
          index === 0 ? { ...artifact, sha512: '00'.repeat(32) } : artifact,
        ),
      }),
    ).toThrow('SHA-512');
  });

  test('rejects sequences outside the signed minimum floor', () => {
    const value = manifest();
    expect(() => encodeReleaseManifest({ ...value, minimumSequence: 43 })).toThrow(
      'minimum sequence',
    );
  });
});
