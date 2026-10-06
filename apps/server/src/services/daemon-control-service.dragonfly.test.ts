import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { deriveSessionAuthorizationKeyPair } from '@merkur/auth';
import {
  createDaemonControlCommandAckMessage,
  type DaemonControlServerMessage,
  encodeDaemonControlMessage,
  MAX_DAEMON_CONTROL_FRAME_BYTES,
  parseDaemonControlServerMessage,
} from '@merkur/daemon-control-protocol';
import { RedisClient } from 'bun';
import { Context, Effect, Fiber, Layer, Queue, Redacted } from 'effect';

import { type ServerConfig, ServerConfigService } from '../config';
import { DatabaseService } from '../db/client';
import { createMigratedKyselyDatabase } from '../db/migrate';
import type { DatabaseSchema } from '../db/types';
import {
  DaemonControlServiceLive,
  DaemonControlServiceTag,
  type DaemonControlSocket,
} from './daemon-control-service';
import { type DeviceService, DeviceServiceTag } from './device-service';
import { EdgeRegistryServiceLive } from './edge-registry-service';
import {
  RealtimeCoordinationServiceLive,
  RealtimeCoordinationServiceTag,
} from './realtime-coordination-service';
import { RedisServiceLive } from './redis-service';

const dragonflyUrl = process.env.DRAGONFLY_TEST_URL;
const CERT_HASH = Buffer.alloc(32, 7).toString('base64');

if (dragonflyUrl === undefined) {
  test.skip('routes a fenced session_start across live Redis Pub/Sub and completes only after command_ack', () => {});
} else {
  describe('DaemonControlService Redis broker integration', () => {
    test('routes a fenced session_start across live Redis Pub/Sub and completes only after command_ack', async () => {
      const suffix = randomUUID();
      const daemonId = `redis-control-daemon-${suffix}`;
      const userId = `redis-control-user-${suffix}`;
      const connectionId = `redis-control-connection-${suffix}`;
      const presenceId = `redis-control-presence-${suffix}`;
      const sessionId = `redis-control-session-${suffix}`;
      let claimSeq = 0;
      const probe = new RedisClient(dragonflyUrl);
      await probe.connect();

      try {
        const ownerLayer = createReplicaLayer(dragonflyUrl);
        const requesterLayer = createReplicaLayer(dragonflyUrl);
        const program = Effect.gen(function* () {
          const ownerContext = yield* Layer.build(ownerLayer);
          const requesterContext = yield* Layer.build(requesterLayer);
          const owner = Context.get(ownerContext, DaemonControlServiceTag);
          const requester = Context.get(requesterContext, DaemonControlServiceTag);
          const ownerCoordination = Context.get(ownerContext, RealtimeCoordinationServiceTag);
          const requesterCoordination = Context.get(
            requesterContext,
            RealtimeCoordinationServiceTag,
          );
          const socketFrames = yield* Queue.unbounded<DaemonControlServerMessage>();
          const socket = new ExactControlSocket(socketFrames);

          expect(ownerCoordination.instanceId).not.toBe(requesterCoordination.instanceId);
          yield* owner.acceptConnection({
            daemonId,
            userId,
            boxId: null,
            daemonVersion: '4.0.0-integration-test',
            connectionId,
            presenceId,
            socket,
            zone: null,
          });

          const registered = yield* takeMessage(socketFrames, 'registered');
          claimSeq = registered.claimSeq;
          const presence = yield* requesterCoordination.getDaemonPresence(daemonId);
          if (presence === null) {
            return yield* Effect.die(
              new Error('Requester replica could not read the registered daemon presence'),
            );
          }
          expect(presence).toMatchObject({
            daemonId,
            userId,
            ownerInstanceId: ownerCoordination.instanceId,
            connectionId,
            presenceId,
            claimSeq,
          });

          let deliverySettled = false;
          const delivery = yield* requester
            .startSession({
              presence,
              sessionId,
              browserNodeId: `redis-control-browser-${suffix}`,
              offer: {
                userId,
                delegationId: `redis-control-delegation-${suffix}`,
                clientNonce: Buffer.alloc(32, 8).toString('base64url'),
                encapsulationKey: Buffer.alloc(1_568, 9).toString('base64url'),
                edgeWtUrl: 'https://edge.example/integration',
                edgeCertHashes: [CERT_HASH],
              },
            })
            .pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  deliverySettled = true;
                }),
              ),
              Effect.forkChild({ startImmediately: true }),
            );

          const command = yield* takeMessage(socketFrames, 'session_start');
          expect(command).toMatchObject({
            type: 'session_start',
            sessionId,
            browserNodeId: `redis-control-browser-${suffix}`,
            offer: {
              userId,
              edgeWtUrl: 'https://edge.example/integration',
              edgeCertHashes: [CERT_HASH],
            },
          });
          yield* Effect.yieldNow;
          expect(deliverySettled).toBe(false);

          yield* owner.receive(
            connectionId,
            encodeDaemonControlMessage(
              createDaemonControlCommandAckMessage(command.commandId, {
                status: 'accepted',
              }),
            ),
          );
          yield* Fiber.join(delivery);
          expect(deliverySettled).toBe(true);

          // Exercise the suspend compare-and-swap against real Redis, not just
          // the in-memory interpreter: it matches on the exact stored bytes, so
          // any divergence between the serializer and what Lua reads back shows
          // up here and nowhere else.
          expect(
            yield* ownerCoordination.suspendDaemonPresence({
              daemonId,
              userId,
              presenceId,
              claimSeq,
            }),
          ).toBe(true);

          // The other replica must see the new disposition while the identity a
          // resume inherits is unchanged.
          const suspended = yield* requesterCoordination.getDaemonPresence(daemonId);
          expect(suspended).toMatchObject({
            daemonId,
            presenceId,
            claimSeq,
            state: 'suspended',
          });

          // Idempotent: the online bytes are gone, so a second attempt is a no-op.
          expect(
            yield* ownerCoordination.suspendDaemonPresence({
              daemonId,
              userId,
              presenceId,
              claimSeq,
            }),
          ).toBe(false);

          // Reclaiming moves ownership to the other replica without minting a
          // new lease, which is what keeps session claims and the device row
          // alive across a reconnect.
          expect(
            yield* requesterCoordination.resumeDaemonPresence({
              daemonId,
              userId,
              presenceId,
              connectionId: `${connectionId}-resumed`,
              zone: null,
            }),
          ).toBe(claimSeq);

          const resumed = yield* ownerCoordination.getDaemonPresence(daemonId);
          expect(resumed).toMatchObject({
            daemonId,
            presenceId,
            claimSeq,
            state: 'online',
            ownerInstanceId: requesterCoordination.instanceId,
            connectionId: `${connectionId}-resumed`,
          });

          // Nothing suspended is left to reclaim.
          expect(
            yield* requesterCoordination.resumeDaemonPresence({
              daemonId,
              userId,
              presenceId,
              connectionId: `${connectionId}-again`,
              zone: null,
            }),
          ).toBeNull();
        });

        await Effect.runPromise(Effect.scoped(program).pipe(Effect.timeout('10 seconds')));
      } finally {
        try {
          await cleanupFixture(probe, {
            daemonId,
            userId,
            presenceId,
            claimSeq,
          });
        } finally {
          probe.close();
        }
      }
    }, 15_000);

    test('the scoped claim finalizer leaves a suspended lease in place', async () => {
      const suffix = randomUUID();
      const daemonId = `redis-fence-daemon-${suffix}`;
      const userId = `redis-fence-user-${suffix}`;
      const presenceId = `redis-fence-presence-${suffix}`;
      let claimSeq = 0;
      const probe = new RedisClient(dragonflyUrl);
      await probe.connect();

      try {
        const program = Effect.gen(function* () {
          const context = yield* Layer.build(createReplicaLayer(dragonflyUrl));
          const coordination = Context.get(context, RealtimeCoordinationServiceTag);

          // `claimDaemonOnline` installs a fenced release finalizer in the
          // ambient scope, which in production is the daemon connection's. Scopes
          // close last-registered-first, so this inner scope reproduces the real
          // ordering: suspend first, then the claim finalizer.
          yield* Effect.scoped(
            Effect.gen(function* () {
              const claimed = yield* coordination.claimDaemonOnline({
                daemonId,
                userId,
                connectionId: `redis-fence-connection-${suffix}`,
                presenceId,
                zone: null,
              });
              expect(claimed._tag).toBe('Claimed');
              claimSeq = claimed.claimSeq;
              expect(
                yield* coordination.suspendDaemonPresence({
                  daemonId,
                  userId,
                  presenceId,
                  claimSeq,
                }),
              ).toBe(true);
            }),
          );

          // Real Lua and real cjson, which is the only place the state fence is
          // actually executed: suspension rewrites nothing the identity fence
          // looks at, so without reading `state` the finalizer would delete the
          // lease it was told to keep — and every session claim fenced by it.
          expect(yield* coordination.getDaemonPresence(daemonId)).toMatchObject({
            daemonId,
            presenceId,
            claimSeq,
            state: 'suspended',
          });
        });

        await Effect.runPromise(Effect.scoped(program).pipe(Effect.timeout('10 seconds')));
      } finally {
        try {
          await cleanupFixture(probe, { daemonId, userId, presenceId, claimSeq });
        } finally {
          probe.close();
        }
      }
    }, 15_000);
  });
}

function createReplicaLayer(redisUrl: string) {
  const configLayer = Layer.succeed(ServerConfigService, testConfig(redisUrl));
  const redisLayer = RedisServiceLive.pipe(Layer.provide(configLayer));
  const coordinationLayer = RealtimeCoordinationServiceLive.pipe(Layer.provideMerge(redisLayer));
  const databaseLayer = Layer.effect(
    DatabaseService,
    Effect.acquireRelease(
      Effect.promise(() => createMigratedKyselyDatabase<DatabaseSchema>(':memory:')),
      (database) => Effect.promise(() => database.destroy()),
    ),
  );
  const dependencies = Layer.mergeAll(
    coordinationLayer,
    Layer.succeed(DeviceServiceTag, TEST_DEVICE_SERVICE),
    databaseLayer,
    // The Live layer mints STUN tickets, so it now reads the server config
    // directly rather than only through the Redis layer.
    configLayer,
    EdgeRegistryServiceLive.pipe(Layer.provide(redisLayer)),
  );
  return DaemonControlServiceLive.pipe(Layer.provideMerge(dependencies));
}

class ExactControlSocket implements DaemonControlSocket {
  constructor(private readonly frames: Queue.Queue<DaemonControlServerMessage>) {}

  sendText(payload: string): number {
    const byteLength = new TextEncoder().encode(payload).byteLength;
    if (byteLength > MAX_DAEMON_CONTROL_FRAME_BYTES) {
      throw new Error(`Control service emitted an oversized ${byteLength}-byte frame`);
    }
    const message = parseDaemonControlServerMessage(payload);
    if (message === null) {
      throw new Error('Control service emitted a non-canonical daemon-control frame');
    }
    if (!Queue.offerUnsafe(this.frames, message)) return -1;
    return byteLength;
  }

  close(): void {
    // The scoped DaemonControlService owns this synthetic socket.
  }
}

function takeMessage<T extends DaemonControlServerMessage['type']>(
  frames: Queue.Queue<DaemonControlServerMessage>,
  type: T,
): Effect.Effect<Extract<DaemonControlServerMessage, { readonly type: T }>> {
  const next = Effect.gen(function* () {
    while (true) {
      const message = yield* Queue.take(frames);
      if (isMessageOfType(message, type)) return message;
    }
  });
  return next.pipe(
    Effect.timeoutOrElse({
      duration: '5 seconds',
      orElse: () => Effect.die(new Error(`Timed out waiting for ${type}`)),
    }),
  );
}

function isMessageOfType<T extends DaemonControlServerMessage['type']>(
  message: DaemonControlServerMessage,
  type: T,
): message is Extract<DaemonControlServerMessage, { readonly type: T }> {
  return message.type === type;
}

async function cleanupFixture(
  probe: {
    del(...keys: string[]): Promise<unknown>;
    zrem(key: string, member: string): Promise<unknown>;
  },
  fixture: {
    readonly daemonId: string;
    readonly userId: string;
    readonly presenceId: string;
    readonly claimSeq: number;
  },
): Promise<void> {
  await probe.del(
    `merkur:control:daemon-claim:${fixture.daemonId}:${fixture.presenceId}`,
    `merkur:control:daemon-claims:${fixture.daemonId}`,
    `merkur:control:user-online-daemons:${fixture.userId}`,
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

const TEST_DEVICE_SERVICE: DeviceService = {
  listDevices: () => Effect.die(new Error('Unexpected listDevices call')),
  getDevice: () => Effect.die(new Error('Unexpected getDevice call')),
  createLinkToken: () => Effect.die(new Error('Unexpected createLinkToken call')),
  resolveBox: () => Effect.die(new Error('Unexpected resolveBox call')),
  listAccountBoxes: () => Effect.die(new Error('Unexpected listAccountBoxes call')),
  getDaemonSessionIdentity: () => Effect.die(new Error('Unexpected getDaemonSessionIdentity call')),
  renameDevice: () => Effect.die(new Error('Unexpected renameDevice call')),
  deleteDevice: () => Effect.die(new Error('Unexpected deleteDevice call')),
  authenticateDaemonProof: () => Effect.die(new Error('Unexpected authenticateDaemonProof call')),
  touchDaemon: () => Effect.void,
  touchDaemonsSeen: () => Effect.void,
};
