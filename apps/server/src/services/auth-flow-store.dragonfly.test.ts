import { expect, test } from 'bun:test';
import { RedisClient } from 'bun';
import { Effect } from 'effect';

import {
  type AuthStartFlow,
  createAuthFlowStore,
  type PasswordResetCodeFlow,
  type PasswordResetFlow,
} from './auth-flow-store';
import { createRedisCommandClient, type RedisService, useRedisClient } from './redis-service';

const dragonflyUrl = process.env.DRAGONFLY_TEST_URL;

if (dragonflyUrl === undefined) {
  test.skip('consumes credential-bound OPAQUE flows once across Dragonfly clients', () => {});
  test.skip('a password reset is proven once and spent once, and only as a reset', () => {});
} else {
  test('consumes credential-bound OPAQUE flows once across Dragonfly clients', async () => {
    const first = new RedisClient(dragonflyUrl);
    const second = new RedisClient(dragonflyUrl);
    await Promise.all([first.connect(), second.connect()]);
    try {
      const stores = [createAuthFlowStore(service(first)), createAuthFlowStore(service(second))];
      const store = stores[0];
      if (store === undefined) throw new Error('missing flow store');
      const flow: AuthStartFlow = {
        kind: 'auth-start',
        userId: 'password-test',
        username: 'password-test',
        serverLoginState: 'opaque-state',
        accountExists: true,
        credentialFingerprint: 'a'.repeat(64),
        registrationAllowed: true,
        delegationIssuedAt: 1_000,
        delegationExpiresAt: 2_592_001_000,
      };
      const id = await Effect.runPromise(store.createStart(flow));
      const ttl = await first.pttl(`auth:flow:${id}`);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(120_000);
      const results = await Promise.all(
        Array.from({ length: 16 }, (_, index) => {
          const consumer = stores[index % stores.length];
          if (consumer === undefined) throw new Error('missing flow consumer');
          return Effect.runPromise(consumer.consumeStart(id));
        }),
      );
      expect(results.filter((value) => value !== null)).toEqual([flow]);
      expect(await Effect.runPromise(store.consumeStart(id))).toBeNull();

      const expired = await Effect.runPromise(store.createStart(flow));
      await first.pexpireat(`auth:flow:${expired}`, 1);
      expect(await Effect.runPromise(store.consumeStart(expired))).toBeNull();

      const invalid = await Effect.runPromise(store.createStart(flow));
      await first.set(
        `auth:flow:${invalid}`,
        JSON.stringify({ ...flow, credentialFingerprint: 'invalid' }),
      );
      await expect(Effect.runPromise(store.consumeStart(invalid))).rejects.toThrow(
        'Authentication flow fields are malformed',
      );
      expect(await Effect.runPromise(store.consumeStart(invalid))).toBeNull();

      // A mailed code: peeking leaves the flow, attaching extends it, attempts
      // survive a resend and the sixth guess destroys the flow.
      const mailed = await Effect.runPromise(store.createStart(flow));
      expect(await Effect.runPromise(store.peekStart(mailed))).toEqual(flow);
      const mac = 'b'.repeat(64);
      const wrong = 'c'.repeat(64);
      expect(await Effect.runPromise(store.attachEmailCode(mailed, mac))).toBe(1);
      expect(await first.pttl(`auth:flow:${mailed}`)).toBeGreaterThan(120_000);
      expect(await first.pttl(`auth:flow-code:${mailed}`)).toBeGreaterThan(120_000);
      expect(await Effect.runPromise(store.checkEmailCode(mailed, wrong))).toBe('mismatch');
      expect(await Effect.runPromise(store.attachEmailCode(mailed, mac))).toBe(2);
      expect(await Effect.runPromise(store.checkEmailCode(mailed, mac))).toBe('match');
      for (let attempt = 0; attempt < 3; attempt += 1) {
        expect(await Effect.runPromise(store.checkEmailCode(mailed, wrong))).toBe('mismatch');
      }
      expect(await Effect.runPromise(store.checkEmailCode(mailed, mac))).toBe('exhausted');
      expect(await Effect.runPromise(store.peekStart(mailed))).toBeNull();

      const expiredCode = 'A'.repeat(43);
      expect(await Effect.runPromise(store.attachEmailCode(expiredCode, mac))).toBeNull();
      expect(await Effect.runPromise(store.checkEmailCode(expiredCode, mac))).toBe('missing');
      expect(await first.exists(`auth:flow-code:${expiredCode}`)).toBe(false);
    } finally {
      first.close();
      second.close();
    }
  });

  test('a password reset is proven once and spent once, and only as a reset', async () => {
    const first = new RedisClient(dragonflyUrl);
    const second = new RedisClient(dragonflyUrl);
    await Promise.all([first.connect(), second.connect()]);
    try {
      const stores = [createAuthFlowStore(service(first)), createAuthFlowStore(service(second))];
      const store = stores[0];
      if (store === undefined) throw new Error('missing flow store');
      const pending: PasswordResetCodeFlow = {
        kind: 'password-reset-code',
        userId: 'reset-test',
        username: 'reset@example.test',
        accountExists: true,
        credentialFingerprint: 'a'.repeat(64),
        rootEpoch: 1,
      };
      const proven: PasswordResetFlow = {
        kind: 'password-reset',
        userId: 'reset-test',
        username: 'reset@example.test',
        credentialFingerprint: 'a'.repeat(64),
        rootEpoch: 1,
        delegationIssuedAt: 1_000,
        delegationExpiresAt: 2_592_001_000,
      };

      // Both kinds live for the mailed-code lifetime from creation: a mailbox
      // has to be opened, and a warning read, before either is used.
      const codeId = await Effect.runPromise(store.createResetCode(pending));
      expect(await first.pttl(`auth:flow:${codeId}`)).toBeGreaterThan(120_000);
      expect(await Effect.runPromise(store.peekResetCode(codeId))).toEqual(pending);
      expect(await Effect.runPromise(store.peekReset(codeId))).toBeNull();
      expect(await Effect.runPromise(store.peekStart(codeId))).toBeNull();
      const proofs = await Promise.all(
        Array.from({ length: 16 }, (_, index) => {
          const consumer = stores[index % stores.length];
          if (consumer === undefined) throw new Error('missing flow consumer');
          return Effect.runPromise(consumer.consumeResetCode(codeId));
        }),
      );
      expect(proofs.filter((value) => value !== null)).toEqual([pending]);

      const resetId = await Effect.runPromise(store.createReset(proven));
      expect(await first.pttl(`auth:flow:${resetId}`)).toBeGreaterThan(120_000);
      expect(await Effect.runPromise(store.peekReset(resetId))).toEqual(proven);
      expect(await Effect.runPromise(store.peekResetCode(resetId))).toBeNull();
      const finishes = await Promise.all(
        Array.from({ length: 16 }, (_, index) => {
          const consumer = stores[index % stores.length];
          if (consumer === undefined) throw new Error('missing flow consumer');
          return Effect.runPromise(consumer.consumeReset(resetId));
        }),
      );
      expect(finishes.filter((value) => value !== null)).toEqual([proven]);

      // An id of one kind finishes nothing of another, and is spent by trying.
      const stray = await Effect.runPromise(store.createReset(proven));
      expect(await Effect.runPromise(store.consumeStart(stray))).toBeNull();
      expect(await Effect.runPromise(store.peekReset(stray))).toBeNull();

      const invalid = await Effect.runPromise(store.createReset(proven));
      await first.set(`auth:flow:${invalid}`, JSON.stringify({ ...proven, rootEpoch: 0 }));
      await expect(Effect.runPromise(store.consumeReset(invalid))).rejects.toThrow(
        'Authentication flow fields are malformed',
      );
    } finally {
      first.close();
      second.close();
    }
  });
}

function service(client: RedisClient): RedisService {
  const commands = createRedisCommandClient(client);
  return {
    useCommands: (fn) => useRedisClient(commands, fn, 'Redis.commands'),
    publish: () => Effect.die('unexpected publish'),
    subscribe: () => Effect.die('unexpected subscribe'),
    unsubscribe: () => Effect.die('unexpected unsubscribe'),
    healthSnapshot: () => Effect.die('unexpected health snapshot'),
  };
}
