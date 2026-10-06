import { describe, expect, test } from 'bun:test';

import { type AccessTokenConfig, createAccessToken, verifyAccessToken } from './index';

const issuer = 'merkur-test-issuer';
const audience = 'merkur-test-audience';
const delegationId = 'delegation-123';
const key = Uint8Array.from({ length: 64 }, (_, index) => (index * 29 + 7) & 0xff);
const DELEGATION_DEADLINE_MS = Date.now() + 30 * 24 * 60 * 60 * 1_000;

function makeConfig(overrides: Partial<AccessTokenConfig> = {}): AccessTokenConfig {
  return {
    hmacKey: key,
    issuer,
    audience,
    ...overrides,
  };
}

describe('access tokens', () => {
  test('round-trip yields the original userId without an algorithm or key-id header', async () => {
    const token = await createAccessToken(
      'user-123',
      delegationId,
      DELEGATION_DEADLINE_MS,
      makeConfig(),
    );
    const verified = await verifyAccessToken(token, makeConfig());

    expect(token.split('.')).toHaveLength(2);
    expect(verified.userId).toBe('user-123');
    expect(verified.delegationId).toBe(delegationId);
    expect(verified.expiresAt).toBeGreaterThan(verified.issuedAt);
  });

  test('rejects tokens issued for a different audience', async () => {
    const token = await createAccessToken(
      'user-123',
      delegationId,
      DELEGATION_DEADLINE_MS,
      makeConfig(),
    );
    await expect(
      verifyAccessToken(token, makeConfig({ audience: 'other-audience' })),
    ).rejects.toThrow();
  });

  test('rejects a tampered authentication tag', async () => {
    const token = await createAccessToken(
      'user-123',
      delegationId,
      DELEGATION_DEADLINE_MS,
      makeConfig(),
    );
    const [payload = '', original = ''] = token.split('.');
    const mid = Math.floor(original.length / 2);
    const replacement = original[mid] === 'A' ? 'B' : 'A';
    const tampered = `${payload}.${original.slice(0, mid)}${replacement}${original.slice(mid + 1)}`;

    await expect(verifyAccessToken(tampered, makeConfig())).rejects.toThrow();
  });

  test('rejects a tag made under a different symmetric key', async () => {
    const token = await createAccessToken(
      'user-123',
      delegationId,
      DELEGATION_DEADLINE_MS,
      makeConfig(),
    );
    const otherKey = Uint8Array.from(key, (byte) => byte ^ 0xa5);
    await expect(verifyAccessToken(token, makeConfig({ hmacKey: otherKey }))).rejects.toThrow();
  });

  test('rejects JWT-style three-segment and padded encodings', async () => {
    const token = await createAccessToken(
      'user-123',
      delegationId,
      DELEGATION_DEADLINE_MS,
      makeConfig(),
    );
    await expect(verifyAccessToken(`header.${token}`, makeConfig())).rejects.toThrow();
    const [payload, tag] = token.split('.');
    await expect(verifyAccessToken(`${payload}=.${tag}`, makeConfig())).rejects.toThrow();
  });

  test('rejects expired tokens and implausible future issue times', async () => {
    const expired = await createAccessToken(
      'user-123',
      delegationId,
      30 * 24 * 60 * 60 * 1_000,
      makeConfig(),
      new Date(0),
    );
    await expect(verifyAccessToken(expired, makeConfig())).rejects.toThrow();

    const futureNow = new Date(Date.now() + 60_000);
    const future = await createAccessToken(
      'user-123',
      delegationId,
      futureNow.getTime() + 60_000,
      makeConfig(),
      futureNow,
    );
    await expect(verifyAccessToken(future, makeConfig())).rejects.toThrow();
  });

  test('rejects invalid creation inputs and non-64-byte keys', async () => {
    await expect(
      createAccessToken('', delegationId, DELEGATION_DEADLINE_MS, makeConfig()),
    ).rejects.toThrow();
    await expect(
      createAccessToken(
        'user-123',
        delegationId,
        DELEGATION_DEADLINE_MS,
        makeConfig({ hmacKey: new Uint8Array(32) }),
      ),
    ).rejects.toThrow(/exactly 64 bytes/);
  });

  test('rejects tokens issued for a different issuer', async () => {
    const token = await createAccessToken(
      'user-123',
      delegationId,
      DELEGATION_DEADLINE_MS,
      makeConfig(),
    );
    await expect(
      verifyAccessToken(token, makeConfig({ issuer: 'other-issuer' })),
    ).rejects.toThrow();
  });
});
