import { describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { deriveSessionAuthorizationKeyPair } from '@merkur/auth';
import { RedisClient } from 'bun';
import { Effect, Layer, Redacted } from 'effect';

import { type ServerConfig, ServerConfigService } from '../config';
import { EdgeRegistryServiceLive, EdgeRegistryServiceTag } from './edge-registry-service';
import {
  type ClaimDaemonOnlineResult,
  RealtimeCoordinationServiceLive,
  RealtimeCoordinationServiceTag,
} from './realtime-coordination-service';
import {
  type RedisCommandClient,
  type RedisService,
  RedisServiceLive,
  RedisServiceTag,
} from './redis-service';

const dragonflyUrl = process.env.DRAGONFLY_TEST_URL;
const SESSION_TTL_MS = 300_000;

if (dragonflyUrl === undefined) {
  test.skip('Dragonfly enforces declared Lua keys and serves the edge registry', () => {});
} else {
  describe('Dragonfly edge registry integration', () => {
    test('enforces declared Lua keys and serves the edge registry', async () => {
      const suffix = randomUUID();
      const edgeIds = [`current-a-${suffix}`, `current-b-${suffix}`] as const;
      const probe = new RedisClient(dragonflyUrl);
      await probe.connect();
      try {
        await expect(
          probe.send('EVAL', ["return redis.call('GET', ARGV[1])", '0', 'merkur:test:undeclared']),
        ).rejects.toThrow(/undeclared key/i);
        const configLayer = Layer.succeed(ServerConfigService, testConfig(dragonflyUrl));
        const redisLayer = RedisServiceLive.pipe(Layer.provide(configLayer));
        const registryLayer = EdgeRegistryServiceLive.pipe(Layer.provide(redisLayer));
        const program = Effect.gen(function* () {
          const registry = yield* EdgeRegistryServiceTag;
          yield* registry.registerEdge(registration(edgeIds[0], 1));
          yield* registry.registerEdge(registration(edgeIds[1], 2));
          return yield* registry.listHealthyEdges();
        });

        const edges = await Effect.runPromise(
          Effect.scoped(program.pipe(Effect.provide(registryLayer))),
        );
        expect(edges.map((edge) => edge.edgeId).sort()).toEqual([...edgeIds].sort());
      } finally {
        try {
          await probe.del(
            ...edgeIds.flatMap((edgeId) => [
              `merkur:edge:registration:${edgeId}`,
              `merkur:edge:id-owner:${edgeId}`,
              edgeUrlOwnerKey(`https://${edgeId}.example:4433/`),
            ]),
          );
          await probe.zrem('merkur:edge:registrations', ...edgeIds);
        } finally {
          probe.close();
        }
      }
    });

    test('atomically creates a session for the exact current daemon claim', async () => {
      const suffix = randomUUID();
      const daemonId = `dragonfly-daemon-${suffix}`;
      const userId = `dragonfly-user-${suffix}`;
      const presenceId = `dragonfly-presence-${suffix}`;
      const sessionId = `dragonfly-session-${suffix}`;
      const configLayer = Layer.succeed(ServerConfigService, testConfig(dragonflyUrl));
      const redisLayer = RedisServiceLive.pipe(Layer.provide(configLayer));
      const coordinationLayer = RealtimeCoordinationServiceLive.pipe(Layer.provide(redisLayer));
      let claimSeq = 0;
      const probe = new RedisClient(dragonflyUrl);
      await probe.connect();

      try {
        const program = Effect.gen(function* () {
          const coordination = yield* RealtimeCoordinationServiceTag;
          const claim = yield* coordination.claimDaemonOnline({
            daemonId,
            userId,
            connectionId: `dragonfly-connection-${suffix}`,
            presenceId,
            zone: null,
          });
          claimSeq = expectClaimed(claim);
          const created = yield* coordination.createSessionForDaemonPresence({
            sessionId,
            userId,
            daemonId,
            browserNodeId: `dragonfly-browser-${suffix}`,
          });
          return created;
        });

        const result = await Effect.runPromise(
          Effect.scoped(program.pipe(Effect.provide(coordinationLayer))),
        );
        expect(result?.connectionId).toBe(`dragonfly-connection-${suffix}`);
        const activeSession = await probe.get(`merkur:sessions:active:${sessionId}`);
        if (activeSession === null) throw new Error('Expected an active session claim');
        expect(JSON.parse(activeSession)).toMatchObject({
          daemonId,
          userId,
          browserNodeId: `dragonfly-browser-${suffix}`,
          presenceId,
          claimSeq,
        });

        const [activeTtlMs, claimIndexTtlMs] = await Promise.all([
          probe.pttl(`merkur:sessions:active:${sessionId}`),
          probe.pttl(`merkur:sessions:claim:${daemonId}:${claimSeq}:${presenceId}`),
        ]);
        expect(activeTtlMs).toBeGreaterThan(0);
        expect(activeTtlMs).toBeLessThanOrEqual(SESSION_TTL_MS);
        expect(claimIndexTtlMs).toBeGreaterThan(0);
        expect(claimIndexTtlMs).toBeLessThanOrEqual(SESSION_TTL_MS);
      } finally {
        try {
          await cleanupSessionFixture(probe, {
            daemonId,
            userId,
            presenceId,
            claimSeq,
            sessionId,
          });
        } finally {
          probe.close();
        }
      }
    });

    test('rejects a session when the exact presence value changes before the atomic write', async () => {
      const suffix = randomUUID();
      const daemonId = `dragonfly-daemon-${suffix}`;
      const userId = `dragonfly-user-${suffix}`;
      const presenceId = `dragonfly-presence-${suffix}`;
      const sessionId = `dragonfly-session-${suffix}`;
      const claimKey = `merkur:control:daemon-claim:${daemonId}:${presenceId}`;
      const configLayer = Layer.succeed(ServerConfigService, testConfig(dragonflyUrl));
      const redisLayer = RedisServiceLive.pipe(Layer.provide(configLayer));
      const probe = new RedisClient(dragonflyUrl);
      let claimSeq = 0;
      let replacedPresence = false;
      await probe.connect();

      const interceptedRedisLayer = Layer.effect(
        RedisServiceTag,
        Effect.gen(function* () {
          const redis = yield* RedisServiceTag;
          return interceptSessionCreate(redis, async () => {
            replacedPresence = true;
            const [rawPresence, remainingTtlMs] = await Promise.all([
              probe.get(claimKey),
              probe.pttl(claimKey),
            ]);
            if (rawPresence === null || remainingTtlMs <= 0) {
              throw new Error('Expected a live daemon presence before the session write');
            }
            const parsed: unknown = JSON.parse(rawPresence);
            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
              throw new Error('Expected a daemon presence object');
            }
            await probe.set(
              claimKey,
              JSON.stringify({
                ...parsed,
                connectionId: `replacement-connection-${suffix}`,
              }),
              'PX',
              remainingTtlMs,
            );
          });
        }),
      ).pipe(Layer.provide(redisLayer));
      const coordinationLayer = RealtimeCoordinationServiceLive.pipe(
        Layer.provide(interceptedRedisLayer),
      );

      try {
        const created = await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const coordination = yield* RealtimeCoordinationServiceTag;
              claimSeq = expectClaimed(
                yield* coordination.claimDaemonOnline({
                  daemonId,
                  userId,
                  connectionId: `dragonfly-connection-${suffix}`,
                  presenceId,
                  zone: null,
                }),
              );
              return yield* coordination.createSessionForDaemonPresence({
                sessionId,
                userId,
                daemonId,
                browserNodeId: `dragonfly-browser-${suffix}`,
              });
            }).pipe(Effect.provide(coordinationLayer)),
          ),
        );
        expect(replacedPresence).toBe(true);
        expect(created).toBeNull();
        expect(await probe.exists(`merkur:sessions:active:${sessionId}`)).toBe(false);
        expect(
          Boolean(
            await probe.sismember(
              `merkur:sessions:claim:${daemonId}:${claimSeq}:${presenceId}`,
              sessionId,
            ),
          ),
        ).toBe(false);
      } finally {
        try {
          await cleanupSessionFixture(probe, {
            daemonId,
            userId,
            presenceId,
            claimSeq,
            sessionId,
          });
        } finally {
          probe.close();
        }
      }
    });
  });
}

function interceptSessionCreate(
  redis: RedisService,
  beforeCreate: () => Promise<void>,
): RedisService {
  let intercepted = false;
  return {
    useCommands<T>(use: (client: RedisCommandClient) => T | PromiseLike<T>) {
      return redis.useCommands((commands) =>
        use({
          async sendCommand<Result = unknown>(args: string[]): Promise<Result> {
            if (
              !intercepted &&
              args[0]?.toUpperCase() === 'EVAL' &&
              args[1]?.includes('merkur:create-session-for-daemon-claim') === true
            ) {
              intercepted = true;
              await beforeCreate();
            }
            return commands.sendCommand<Result>(args);
          },
        }),
      );
    },
    publish: (channel, message) => redis.publish(channel, message),
    subscribe: (channel, handler) => redis.subscribe(channel, handler),
    unsubscribe: (channel, handler) => redis.unsubscribe(channel, handler),
    healthSnapshot: () => redis.healthSnapshot(),
  };
}

async function cleanupSessionFixture(
  probe: {
    del(...keys: string[]): Promise<unknown>;
    zrem(key: string, member: string): Promise<unknown>;
  },
  fixture: {
    readonly daemonId: string;
    readonly userId: string;
    readonly presenceId: string;
    readonly claimSeq: number;
    readonly sessionId: string;
  },
): Promise<void> {
  await probe.del(
    `merkur:control:daemon-claim:${fixture.daemonId}:${fixture.presenceId}`,
    `merkur:control:daemon-claims:${fixture.daemonId}`,
    `merkur:control:user-online-daemons:${fixture.userId}`,
    `merkur:sessions:active:${fixture.sessionId}`,
    `merkur:sessions:claim:${fixture.daemonId}:${fixture.claimSeq}:${fixture.presenceId}`,
  );
  if (fixture.claimSeq > 0) {
    await probe.zrem(
      'merkur:control:daemon-presence-deadlines',
      JSON.stringify({
        daemonId: fixture.daemonId,
        userId: fixture.userId,
        presenceId: fixture.presenceId,
        claimSeq: fixture.claimSeq,
      }),
    );
  }
}

function expectClaimed(result: ClaimDaemonOnlineResult): number {
  expect(result._tag).toBe('Claimed');
  if (result._tag !== 'Claimed') throw new Error('Expected daemon claim to succeed');
  return result.claimSeq;
}

function registration(edgeId: string, hashByte: number) {
  const certHash = Buffer.alloc(32, hashByte).toString('base64');
  return {
    edgeId,
    edgeRegion: 'test',
    edgeWtUrl: `https://${edgeId}.example:4433/`,
    activeCertHash: certHash,
    certHashes: [certHash, Buffer.alloc(32, hashByte ^ 0xff).toString('base64')],
    updatedAt: Date.now(),
  };
}

function edgeUrlOwnerKey(edgeWtUrl: string): string {
  return `merkur:edge:url-owner:${createHash('sha256').update(edgeWtUrl).digest('hex')}`;
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
