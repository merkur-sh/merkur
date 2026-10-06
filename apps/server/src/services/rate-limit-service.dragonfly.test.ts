import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { deriveSessionAuthorizationKeyPair } from '@merkur/auth';
import { RedisClient } from 'bun';
import { Effect, Layer, Redacted } from 'effect';

import { type ServerConfig, ServerConfigService } from '../config';
import {
  RATE_LIMIT_SLIDING_WINDOW_SCRIPT,
  RateLimitServiceLive,
  RateLimitServiceTag,
} from './rate-limit-service';
import { RedisServiceLive } from './redis-service';

const dragonflyUrl = process.env.DRAGONFLY_TEST_URL;
const WINDOW_MS = 60_000;
const SUSTAINED_WINDOW_MS = 3_600_000;

if (dragonflyUrl === undefined) {
  test.skip('preloads and recovers the atomic rate-limit script on Dragonfly', () => {});
} else {
  describe('RateLimitService Dragonfly integration', () => {
    test('preloads and recovers the atomic rate-limit script after SCRIPT FLUSH', async () => {
      const key = `dragonfly-${randomUUID()}`;
      const redisKey = `rl:${key}`;
      const probe = new RedisClient(dragonflyUrl);
      await probe.connect();

      try {
        const configLayer = Layer.succeed(ServerConfigService, testConfig(dragonflyUrl));
        const redisLayer = RedisServiceLive.pipe(Layer.provide(configLayer));
        const rateLimitLayer = RateLimitServiceLive.pipe(Layer.provide(redisLayer));
        const result = await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const rateLimit = yield* RateLimitServiceTag;
              const preloaded = yield* Effect.promise(() =>
                probe.send('SCRIPT', ['EXISTS', RATE_LIMIT_SLIDING_WINDOW_SCRIPT.sha1]),
              );

              const first = yield* rateLimit.consume({ key, limit: 1, windowMs: WINDOW_MS });
              yield* Effect.promise(() => probe.send('SCRIPT', ['FLUSH']));
              const second = yield* rateLimit.consume({ key, limit: 1, windowMs: WINDOW_MS });
              const reloaded = yield* Effect.promise(() =>
                probe.send('SCRIPT', ['EXISTS', RATE_LIMIT_SLIDING_WINDOW_SCRIPT.sha1]),
              );
              return { first, preloaded, reloaded, second };
            }).pipe(Effect.provide(rateLimitLayer)),
          ),
        );

        expect(result.preloaded).toEqual([1]);
        expect(result.first.allowed).toBe(true);
        expect(result.second.allowed).toBe(false);
        expect(result.reloaded).toEqual([1]);
        expect(await probe.type(redisKey)).toBe('hash');
        const ttlMs = await probe.pttl(redisKey);
        expect(ttlMs).toBeGreaterThan(0);
        expect(ttlMs).toBeLessThanOrEqual(WINDOW_MS * 2);
      } finally {
        try {
          await probe.del(redisKey);
        } finally {
          probe.close();
        }
      }
    });

    test('refund releases a reservation without resurrecting or re-expiring', async () => {
      // The clamp in the refund script is what stops a pruned field coming back
      // as -1 and poisoning reply parsing for every later consume. Exercised
      // against real Lua because the guard lives in the script, not in TS.
      const key = `dragonfly-${randomUUID()}`;
      const redisKey = `rl:${key}`;
      const probe = new RedisClient(dragonflyUrl);
      await probe.connect();

      try {
        const configLayer = Layer.succeed(ServerConfigService, testConfig(dragonflyUrl));
        const redisLayer = RedisServiceLive.pipe(Layer.provide(configLayer));
        const rateLimitLayer = RateLimitServiceLive.pipe(Layer.provide(redisLayer));
        const result = await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const rateLimit = yield* RateLimitServiceTag;
              const first = yield* rateLimit.consume({ key, limit: 1, windowMs: WINDOW_MS });
              const windowId = first.allowed === true ? first.windowId : undefined;
              if (windowId === undefined) {
                return { windowId, refundedAllows: false, staleHandled: false };
              }

              yield* rateLimit.refund?.({ key, windowId }) ?? Effect.void;
              // The reservation is back, so the next consume is allowed again.
              const second = yield* rateLimit.consume({ key, limit: 1, windowMs: WINDOW_MS });
              // Refunding a window that was never consumed must not create it.
              yield* rateLimit.refund?.({ key, windowId: windowId - 10 }) ?? Effect.void;
              const third = yield* rateLimit.consume({ key, limit: 1, windowMs: WINDOW_MS });
              return {
                windowId,
                refundedAllows: second.allowed,
                staleHandled: !third.allowed,
              };
            }).pipe(Effect.provide(rateLimitLayer)),
          ),
        );

        expect(result.windowId).toBeGreaterThan(0);
        expect(result.refundedAllows).toBe(true);
        // The stale refund left no field behind for the parser to choke on.
        expect(result.staleHandled).toBe(true);
        expect(await probe.hget(redisKey, String((result.windowId ?? 0) - 10))).toBeNull();

        const ttlMs = await probe.pttl(redisKey);
        expect(ttlMs).toBeGreaterThan(0);
        expect(ttlMs).toBeLessThanOrEqual(WINDOW_MS * 2);
      } finally {
        try {
          await probe.del(redisKey);
        } finally {
          probe.close();
        }
      }
    });

    test('keeps a minute and an hour window independent on separate keys', async () => {
      // The script prunes every hash field outside the calling window and
      // re-expires the key at windowMs * 2, so two windows sharing one key would
      // erase each other's counters. /api/auth/continue relies on this by
      // running its burst and sustained IP limits under distinct key prefixes.
      const subject = `dragonfly-${randomUUID()}`;
      const minuteKey = `${subject}:minute`;
      const hourKey = `${subject}:hour`;
      const probe = new RedisClient(dragonflyUrl);
      await probe.connect();

      try {
        const configLayer = Layer.succeed(ServerConfigService, testConfig(dragonflyUrl));
        const redisLayer = RedisServiceLive.pipe(Layer.provide(configLayer));
        const rateLimitLayer = RateLimitServiceLive.pipe(Layer.provide(redisLayer));
        const result = await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const rateLimit = yield* RateLimitServiceTag;
              // Exhaust the minute window, then check the hour window: it has
              // seen the same traffic but under its own key and a higher limit,
              // so it must still pass rather than having been pruned or expired.
              yield* rateLimit.consume({ key: minuteKey, limit: 1, windowMs: WINDOW_MS });
              const minuteDenied = yield* rateLimit.consume({
                key: minuteKey,
                limit: 1,
                windowMs: WINDOW_MS,
              });
              yield* rateLimit.consume({ key: hourKey, limit: 5, windowMs: SUSTAINED_WINDOW_MS });
              const hourAllowed = yield* rateLimit.consume({
                key: hourKey,
                limit: 5,
                windowMs: SUSTAINED_WINDOW_MS,
              });
              return { minuteDenied, hourAllowed };
            }).pipe(Effect.provide(rateLimitLayer)),
          ),
        );

        expect(result.minuteDenied.allowed).toBe(false);
        expect(result.hourAllowed.allowed).toBe(true);

        const minuteTtl = await probe.pttl(`rl:${minuteKey}`);
        const hourTtl = await probe.pttl(`rl:${hourKey}`);
        expect(minuteTtl).toBeGreaterThan(0);
        expect(minuteTtl).toBeLessThanOrEqual(WINDOW_MS * 2);
        expect(hourTtl).toBeGreaterThan(WINDOW_MS * 2);
        expect(hourTtl).toBeLessThanOrEqual(SUSTAINED_WINDOW_MS * 2);
      } finally {
        try {
          await probe.del(`rl:${minuteKey}`, `rl:${hourKey}`);
        } finally {
          probe.close();
        }
      }
    });
  });
}

function testConfig(redisUrl: string): ServerConfig {
  return {
    host: '127.0.0.1',
    port: 3000,
    dbUrl: ':memory:',
    dbAuthToken: undefined,
    redisUrl: Redacted.make(redisUrl),
    publicOrigin: 'https://localhost:3000',
    website: undefined,
    accessTokenHmacKey: new Uint8Array(64),
    jwtIssuer: 'merkur',
    jwtAudience: 'merkur-clients',
    tokenHmacSecret: Redacted.make('test'),
    authAllowRegistration: false,
    authIdentity: 'username',
    emailDelivery: undefined,
    opaqueServerSetup: Redacted.make(Buffer.alloc(128).toString('base64url')),
    opaqueServerPublicKey: Buffer.alloc(32).toString('base64url'),
    trustedProxyHops: 1,
    sessionTokenSigningKey: deriveSessionAuthorizationKeyPair(new Uint8Array(32)).signingKey,
    sessionTokenVerifyKeyB64: 'A'.repeat(3_456),
    sessionTokenTtlMs: 60_000,
    webPush: undefined,
    edgeRegistrationKeys: new Map(),
    telemetry: undefined,
    traceLevel: 'Info',
    traceSampleRatio: 1,
    traceSlowThresholdMs: 1_000,
    boxHost: undefined,
    stunTicketKey: new Uint8Array(64),
    edgeAttachTicketKey: new Uint8Array(64).fill(11),
    stunServers: ['stun.test:3478', 'stun.test:3479'],
    boxHostStunObservers: [],
  };
}
