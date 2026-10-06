import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { deriveSessionAuthorizationKeyPair } from '@merkur/auth';
import { RedisClient } from 'bun';
import { Deferred, Effect, Layer, Redacted, type Scope } from 'effect';

import { type ServerConfig, ServerConfigService } from '../config';
import {
  type ClaimDaemonOnlineResult,
  type RealtimeCoordinationService,
  RealtimeCoordinationServiceLive,
  RealtimeCoordinationServiceTag,
} from './realtime-coordination-service';
import { RedisServiceLive } from './redis-service';

const dragonflyUrl = process.env.DRAGONFLY_TEST_URL;
const HEX_EPOCH = /^[0-9a-f]{16}$/;

if (dragonflyUrl === undefined) {
  test.skip('Dragonfly sequences device events under an epoch that dies with its counter', () => {});
} else {
  describe('Dragonfly device-events cursor', () => {
    test('session waiter cleanup preserves the shared device listener', async () => {
      const suffix = randomUUID();
      const userId = `dragonfly-user-${suffix}`;
      const daemonId = `dragonfly-daemon-${suffix}`;
      const probe = new RedisClient(dragonflyUrl);
      await probe.connect();
      try {
        await runCoordination(dragonflyUrl, (coordination) =>
          Effect.gen(function* () {
            const resync = yield* Deferred.make<void>();
            const cleanup = yield* coordination.subscribeDeviceEvents(userId, (signal) => {
              if (signal._tag === 'resync') Deferred.doneUnsafe(resync, Effect.void);
            });
            yield* coordination.claimDaemonOnline({
              daemonId,
              userId,
              connectionId: `dragonfly-connection-${suffix}`,
              presenceId: `dragonfly-presence-${suffix}`,
              zone: null,
            });
            yield* Effect.forEach(
              [0, 1],
              (index) =>
                coordination.createSessionForDaemonPresence({
                  daemonId,
                  userId,
                  sessionId: `dragonfly-session-${suffix}-${index}`,
                  browserNodeId: `dragonfly-browser-${suffix}-${index}`,
                }),
              { concurrency: 'unbounded' },
            );
            yield* Effect.promise(() =>
              probe.publish(`merkur:device-events:{user:${userId}}`, 'resync'),
            );
            yield* Deferred.await(resync).pipe(Effect.timeout('3 seconds'));
            yield* cleanup;
          }),
        );
      } finally {
        await probe.del(`merkur:device-events-cursor:${userId}`);
        probe.close();
      }
    });

    /**
     * The whole point of the epoch, against a real server.
     *
     * A counter that restarts is not a hypothetical: presence lives in a store
     * that is deliberately not durable here, so a restart or an eviction takes
     * this key with it and the very transitions that rebuild presence walk the
     * new counter straight back up through the numbers a browser is holding.
     * Only the epoch can tell those two `5`s apart, so it has to be minted with
     * the counter, by whichever call finds it missing, and it has to disappear
     * with it — which is why both live in one key.
     */
    test('mints an epoch with the counter and a different one after it is destroyed', async () => {
      const suffix = randomUUID();
      const userId = `dragonfly-user-${suffix}`;
      const cursorKey = `merkur:device-events-cursor:${userId}`;
      const probe = new RedisClient(dragonflyUrl);
      await probe.connect();

      try {
        const first = await runCoordination(dragonflyUrl, (coordination) =>
          Effect.gen(function* () {
            // A first read on an account that has never published anything
            // still has to name a cursor, so it mints one.
            const opened = yield* coordination.readDeviceEventsCursor(userId);
            yield* coordination.publishDeviceDelta(userId, {
              kind: 'remove',
              deviceId: `daemon-a-${suffix}`,
            });
            yield* coordination.publishDeviceDelta(userId, {
              kind: 'remove',
              deviceId: `daemon-b-${suffix}`,
            });
            const advanced = yield* coordination.readDeviceEventsCursor(userId);
            return { opened, advanced };
          }),
        );

        expect(first.opened.epoch).toMatch(HEX_EPOCH);
        expect(first.opened.seq).toBe(0);
        // Reading again neither re-mints the epoch nor moves the counter.
        expect(first.advanced).toEqual({ epoch: first.opened.epoch, seq: 2 });

        // What a restart, a flush, or an eviction does. Both halves go, because
        // they are one key — a surviving epoch over a restarted counter would
        // be exactly the confusion this exists to prevent.
        await probe.del(cursorKey);

        const rebuilt = await runCoordination(dragonflyUrl, (coordination) =>
          Effect.gen(function* () {
            yield* coordination.publishDeviceDelta(userId, {
              kind: 'remove',
              deviceId: `daemon-a-${suffix}`,
            });
            yield* coordination.publishDeviceDelta(userId, {
              kind: 'remove',
              deviceId: `daemon-b-${suffix}`,
            });
            return yield* coordination.readDeviceEventsCursor(userId);
          }),
        );

        // The counter climbed back to the same number by a different route, and
        // the cursor a browser holds from before no longer matches it.
        expect(rebuilt.seq).toBe(first.advanced.seq);
        expect(rebuilt.epoch).toMatch(HEX_EPOCH);
        expect(rebuilt.epoch).not.toBe(first.opened.epoch);
      } finally {
        try {
          await probe.del(cursorKey);
        } finally {
          probe.close();
        }
      }
    });

    /**
     * Presence transitions sequence through the same key from inside their own
     * scripts, each of which carries its own candidate epoch. An argument
     * misplaced by one there would stamp a delta payload, or a claim sequence,
     * into the epoch — and nothing at runtime would notice, because the epoch is
     * only ever compared.
     */
    test('a presence transition sequences and mints through the same cursor', async () => {
      const suffix = randomUUID();
      const userId = `dragonfly-user-${suffix}`;
      const daemonId = `dragonfly-daemon-${suffix}`;
      const presenceId = `dragonfly-presence-${suffix}`;
      const cursorKey = `merkur:device-events-cursor:${userId}`;
      const probe = new RedisClient(dragonflyUrl);
      await probe.connect();

      try {
        const cursor = await runCoordination(dragonflyUrl, (coordination) =>
          Effect.gen(function* () {
            const claim = yield* coordination.claimDaemonOnline({
              daemonId,
              userId,
              connectionId: `dragonfly-connection-${suffix}`,
              presenceId,
              zone: null,
            });
            const claimSeq = expectClaimed(claim);
            // Silence and its recovery: two swaps of the stored state, each
            // publishing its own edge.
            const carrier = {
              daemonId,
              userId,
              presenceId,
              claimSeq,
              connectionId: `dragonfly-connection-${suffix}`,
            };
            yield* coordination.markDaemonSilent(carrier);
            yield* coordination.clearDaemonSilent(carrier);
            // And the retirement, which is a different script again.
            yield* coordination.unmarkDaemonOnline({
              daemonId,
              userId,
              presenceId,
              claimSeq,
              connectionId: `dragonfly-connection-${suffix}`,
            });
            return yield* coordination.readDeviceEventsCursor(userId);
          }),
        );

        // Silent, recovered, offline — three sequenced edges on a key no read
        // had touched, so the epoch was minted by a transition rather than by a
        // stream opening.
        expect(cursor.seq).toBe(3);
        expect(cursor.epoch).toMatch(HEX_EPOCH);
      } finally {
        try {
          await probe.del(
            cursorKey,
            `merkur:control:daemon-claim:${daemonId}:${presenceId}`,
            `merkur:control:daemon-claims:${daemonId}`,
            `merkur:control:user-online-daemons:${userId}`,
          );
        } finally {
          probe.close();
        }
      }
    });
  });
}

function runCoordination<A>(
  redisUrl: string,
  program: (coordination: RealtimeCoordinationService) => Effect.Effect<A, unknown, Scope.Scope>,
): Promise<A> {
  const configLayer = Layer.succeed(ServerConfigService, testConfig(redisUrl));
  const redisLayer = RedisServiceLive.pipe(Layer.provide(configLayer));
  const coordinationLayer = RealtimeCoordinationServiceLive.pipe(Layer.provide(redisLayer));
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const coordination = yield* RealtimeCoordinationServiceTag;
        return yield* program(coordination);
      }),
    ).pipe(Effect.provide(coordinationLayer), Effect.orDie),
  );
}

function expectClaimed(result: ClaimDaemonOnlineResult): number {
  expect(result._tag).toBe('Claimed');
  if (result._tag !== 'Claimed') throw new Error('Expected daemon claim to succeed');
  return result.claimSeq;
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
