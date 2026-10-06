import { beforeEach, describe, expect, test } from 'bun:test';

import {
  createRefreshToken,
  type RefreshTokenRecord,
  type RefreshTokenStore,
  revokeRefreshTokenFamily,
  rotateRefreshToken,
} from './index';

class InMemoryRefreshStore implements RefreshTokenStore {
  private readonly records = new Map<string, RefreshTokenRecord>();

  async findById(id: string): Promise<RefreshTokenRecord | null> {
    return this.records.get(id) ?? null;
  }

  async insert(record: RefreshTokenRecord): Promise<void> {
    this.records.set(record.id, record);
  }

  async markRotated(id: string, rotatedAt: number): Promise<void> {
    const record = this.records.get(id);
    if (record !== undefined) {
      this.records.set(id, { ...record, rotatedAt });
    }
  }

  async deleteById(id: string): Promise<void> {
    this.records.delete(id);
  }

  async deleteByFamilyId(familyId: string): Promise<void> {
    for (const record of this.records.values()) {
      if (record.familyId === familyId) {
        this.records.delete(record.id);
      }
    }
  }

  async deleteByDelegationId(delegationId: string): Promise<void> {
    for (const record of this.records.values()) {
      if (record.delegationId === delegationId) {
        this.records.delete(record.id);
      }
    }
  }

  size(): number {
    return this.records.size;
  }

  hasId(id: string): boolean {
    return this.records.has(id);
  }
}

const HMAC_SECRET = 'test-hmac-secret';
const DELEGATION_ID = 'delegation-1';
const REFRESH_LIFETIME_MS = 30 * 24 * 60 * 60 * 1_000;

let store: InMemoryRefreshStore;

beforeEach(() => {
  store = new InMemoryRefreshStore();
});

function issueRefresh(userId = 'user-1', now = Date.now()) {
  return createRefreshToken(userId, DELEGATION_ID, now + REFRESH_LIFETIME_MS, HMAC_SECRET, now);
}

describe('refresh tokens', () => {
  test('createRefreshToken returns a record + raw token with TTL', () => {
    const now = 1_700_000_000_000;
    const issue = issueRefresh('user-1', now);

    expect(issue.token.length).toBeGreaterThan(40);
    expect(issue.record.userId).toBe('user-1');
    expect(issue.record.delegationId).toBe(DELEGATION_ID);
    expect(issue.record.expiresAt - now).toBe(30 * 24 * 60 * 60 * 1_000);
    expect(issue.record.tokenHash).toMatch(/^[0-9a-f]+$/);
  });

  test('rotate rejects when token is unknown', async () => {
    const result = await rotateRefreshToken({
      store,
      refreshTokenId: 'unknown-id',
      presentedToken: 'whatever',
      hmacSecret: HMAC_SECRET,
    });
    expect(result.outcome).toBe('rejected');
  });

  test('rotate succeeds, retains the spent original, inserts replacement', async () => {
    const issue = issueRefresh();
    await store.insert(issue.record);

    const result = await rotateRefreshToken({
      store,
      refreshTokenId: issue.record.id,
      presentedToken: issue.token,
      hmacSecret: HMAC_SECRET,
      now: 1_700_000_000_000,
    });

    expect(result.outcome).toBe('rotated');
    if (result.outcome !== 'rotated') return;
    expect(result.revokedTokenId).toBe(issue.record.id);
    expect((await store.findById(issue.record.id))?.rotatedAt).toBe(1_700_000_000_000);
    expect(store.hasId(result.rotated.record.id)).toBe(true);
    expect(result.rotated.record.familyId).toBe(issue.record.familyId);
    expect(result.rotated.record.rotatedAt).toBeNull();
  });

  test('rotate refuses when the presented token does not match', async () => {
    const issue = issueRefresh();
    await store.insert(issue.record);

    const result = await rotateRefreshToken({
      store,
      refreshTokenId: issue.record.id,
      presentedToken: 'forged-token',
      hmacSecret: HMAC_SECRET,
    });

    expect(result.outcome).toBe('rejected');
    expect(store.hasId(issue.record.id)).toBe(true);
  });

  test('rotate deletes and refuses when the token has expired', async () => {
    const issue = issueRefresh('user-1', 0);
    await store.insert(issue.record);

    const result = await rotateRefreshToken({
      store,
      refreshTokenId: issue.record.id,
      presentedToken: issue.token,
      hmacSecret: HMAC_SECRET,
      now: issue.record.expiresAt + 1,
    });

    expect(result.outcome).toBe('rejected');
    expect(store.hasId(issue.record.id)).toBe(false);
  });

  test('replaying a spent token reports reuse and revokes the whole family', async () => {
    const rotatedAt = 1_700_000_000_000;
    const first = issueRefresh('user-1', rotatedAt);
    const other = issueRefresh('user-1', rotatedAt);
    await store.insert(first.record);
    await store.insert(other.record);

    const rotated = await rotateRefreshToken({
      store,
      refreshTokenId: first.record.id,
      presentedToken: first.token,
      hmacSecret: HMAC_SECRET,
      now: rotatedAt,
    });
    expect(rotated.outcome).toBe('rotated');
    if (rotated.outcome !== 'rotated') return;

    const replay = await rotateRefreshToken({
      store,
      refreshTokenId: first.record.id,
      presentedToken: first.token,
      hmacSecret: HMAC_SECRET,
      now: rotatedAt + 1,
    });

    expect(replay.outcome).toBe('reuse-detected');
    if (replay.outcome !== 'reuse-detected') return;
    expect(replay.userId).toBe('user-1');
    expect(replay.familyId).toBe(first.record.familyId);
    // The successor the thief would have used next dies with the family...
    expect(store.hasId(first.record.id)).toBe(false);
    expect(store.hasId(rotated.rotated.record.id)).toBe(false);
    // ...but the user's other login is a separate family and survives.
    expect(store.hasId(other.record.id)).toBe(true);
  });

  test('a forged token against a spent record is rejected, not treated as reuse', async () => {
    const issue = issueRefresh();
    await store.insert(issue.record);
    await rotateRefreshToken({
      store,
      refreshTokenId: issue.record.id,
      presentedToken: issue.token,
      hmacSecret: HMAC_SECRET,
    });

    const result = await rotateRefreshToken({
      store,
      refreshTokenId: issue.record.id,
      presentedToken: 'forged-token',
      hmacSecret: HMAC_SECRET,
    });

    expect(result.outcome).toBe('rejected');
    expect(store.hasId(issue.record.id)).toBe(true);
  });

  test('revokeRefreshTokenFamily clears the spent ancestors too', async () => {
    const issue = issueRefresh();
    await store.insert(issue.record);
    const rotated = await rotateRefreshToken({
      store,
      refreshTokenId: issue.record.id,
      presentedToken: issue.token,
      hmacSecret: HMAC_SECRET,
    });
    if (rotated.outcome !== 'rotated') throw new Error('expected rotation');

    expect(await revokeRefreshTokenFamily(store, rotated.rotated.record.id)).toBe(true);
    expect(store.size()).toBe(0);
    expect(await revokeRefreshTokenFamily(store, rotated.rotated.record.id)).toBe(false);
  });
});
