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
import { Context, Deferred, Effect, Fiber, Layer, Queue, Redacted } from 'effect';
import type { Kysely } from 'kysely';
import { type ServerConfig, ServerConfigService } from '../config';
import { DatabaseService } from '../db/client';
import { createMigratedKyselyDatabase } from '../db/migrate';
import type { DatabaseSchema } from '../db/types';
import { fenceDaemonRegistration } from './daemon-control-ownership';
import {
  createDaemonControlService,
  DaemonControlServiceLive,
  DaemonControlServiceTag,
  type DaemonControlSocket,
} from './daemon-control-service';
import { DaemonReleaseStoreTag } from './daemon-release-store';
import { createDeviceService, type DeviceService, DeviceServiceTag } from './device-service';
import { EdgeRegistryServiceLive } from './edge-registry-service';
import {
  deliverPendingNotifications,
  NotificationOutboxServiceLive,
  NotificationOutboxServiceTag,
} from './notification-outbox-service';
import {
  RealtimeCoordinationServiceLive,
  RealtimeCoordinationServiceTag,
} from './realtime-coordination-service';
import { RedisError, RedisServiceLive, RedisServiceTag } from './redis-service';
import { enqueueResetRevocation } from './session-revocation-outbox';

const dragonflyUrl = process.env.DRAGONFLY_TEST_URL;
const UNLINK_TEST_DEADLINE = '5 seconds';
const CERT_HASH = Buffer.alloc(32, 7).toString('base64');

if (dragonflyUrl === undefined) {
  test.skip('routes a fenced session_start across live Redis Pub/Sub and completes only after command_ack', () => {});
} else {
  describe('DaemonControlService Redis broker integration', () => {
    test('failed renewal retries at its retry deadline against Redis', async () => {
      const id = randomUUID();
      const daemonId = `retry-daemon-${id}`;
      const userId = `retry-user-${id}`;
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const context = yield* Layer.build(createReplicaLayer(dragonflyUrl));
            const base = Context.get(context, RealtimeCoordinationServiceTag);
            const redis = Context.get(context, RedisServiceTag);
            const db = Context.get(context, DatabaseService);
            yield* Effect.promise(() => insertUser(db, userId, daemonId));
            let mono = 0;
            const attempts: number[] = [];
            const coordination = {
              ...base,
              renewDaemonLeases: (inputs: Parameters<typeof base.renewDaemonLeases>[0]) =>
                Effect.suspend(() => {
                  attempts.push(mono);
                  return mono === 20_000
                    ? Effect.fail(new RedisError({ cause: null, message: 'transient renewal' }))
                    : base.renewDaemonLeases(inputs);
                }),
            };
            const control = yield* Effect.acquireRelease(
              Effect.sync(() =>
                createDaemonControlService({
                  coordination,
                  redis,
                  registrationFence: (input, acquire) =>
                    fenceDaemonRegistration(db, coordination, input, acquire),
                  touchDaemon: () => Effect.void,
                  touchDaemonsSeen: () => Effect.void,
                  telemetryEnabled: () => Effect.succeed(false),
                  logger: { info() {}, warn() {}, error() {} },
                  monotonicNow: () => mono,
                  stun: {
                    serversFor: () => ['stun.test:3478', 'stun.test:3479'],
                    issue: () => ({
                      ticket: 'A'.repeat(55),
                      secret: 'A'.repeat(43),
                      lifetimeMs: 90_000,
                    }),
                  },
                  edgeAttach: { forDaemon: () => 'A'.repeat(35), forBrowser: () => 'A'.repeat(35) },
                  edges: Effect.succeed([
                    { edgeWtUrl: 'https://edge.test:4433/', certHashes: [CERT_HASH] },
                  ]),
                }),
              ),
              (service) => service.shutdown,
            );
            const socket = new ExactControlSocket(
              yield* Queue.unbounded<DaemonControlServerMessage>(),
            );
            const handle = yield* control.acceptConnection({
              daemonBindingJson: '{}',
              daemonId,
              userId,
              boxId: null,
              daemonVersion: 'test',
              connectionId: `connection-${id}`,
              presenceId: `presence-${id}`,
              socket,
              zone: null,
            });
            for (const at of [20_000, 22_000]) {
              mono = at;
              handle.observePing();
              yield* control.livenessTick;
              expect(attempts.at(-1)).toBe(at);
            }
            expect((yield* coordination.getDaemonPresence(daemonId))?.state).toBe('online');
          }),
        ),
      );
    });

    test.each([false, true])(
      'unlink retires daemon control while pings continue after reset: %s',
      async (reset) => {
        const id = randomUUID();
        const daemonId = `unlink-daemon-${id}`;
        const userId = `unlink-user-${id}`;
        const layer = createReplicaLayer(dragonflyUrl);
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const context = yield* Layer.build(layer);
              const notifications = yield* startNotificationWorker(context);
              const control = Context.get(context, DaemonControlServiceTag);
              const db = Context.get(context, DatabaseService);
              const coordination = Context.get(context, RealtimeCoordinationServiceTag);
              yield* Effect.promise(() => insertUser(db, userId, daemonId));
              const frames = yield* Queue.unbounded<DaemonControlServerMessage>();
              const socket = new ExactControlSocket(frames);
              const handle = yield* control.acceptConnection({
                daemonBindingJson: '{}',
                daemonId,
                userId,
                boxId: null,
                daemonVersion: 'test',
                connectionId: `connection-${id}`,
                presenceId: `presence-${id}`,
                socket,
                zone: null,
              });
              const devices = createDeviceService(
                db,
                { tokenHmacSecret: 'test', publicOrigin: 'https://localhost:3000' },
                notifications.wake,
              );
              if (reset)
                yield* Effect.promise(() =>
                  db.transaction().execute(async (trx) => {
                    await trx
                      .updateTable('users')
                      .set({ root_epoch: 2 })
                      .where('id', '=', userId)
                      .execute();
                    await enqueueResetRevocation(trx, userId, 2);
                  }),
                );
              yield* devices.deleteDevice(userId, daemonId);
              handle.observePing();
              if (reset) {
                expect((yield* takeMessage(frames, 'revocation')).revocationGeneration).toBe(1);
              }
              yield* Deferred.await(socket.closed).pipe(Effect.timeout(UNLINK_TEST_DEADLINE));
              expect(yield* coordination.getDaemonPresence(daemonId)).toBeNull();
              handle.observePing();
              expect((yield* control.healthSnapshot()).controlConnections).toBe(0);
            }),
          ),
        );
      },
    );

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
          yield* Effect.promise(() =>
            insertUser(Context.get(ownerContext, DatabaseService), userId, daemonId),
          );
          yield* owner.acceptConnection({
            daemonBindingJson: '{}',
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
          expect(registered.telemetryEnabled).toBe(false);
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

          const ownerDb = Context.get(ownerContext, DatabaseService);
          // The notification worker discovers committed work without a request-time wake.
          // Its scope ends before the explicit Redis failure/retry below.
          yield* Effect.scoped(
            Effect.gen(function* () {
              yield* startNotificationWorker(ownerContext);
              const revocationId = yield* Effect.promise(() =>
                recordRevocation(ownerDb, userId, daemonId),
              );
              const revoke = yield* takeMessage(socketFrames, 'delegation_revoke');
              expect(revoke.commandId).toBe(revocationId);
              yield* owner.receive(
                connectionId,
                encodeDaemonControlMessage(
                  createDaemonControlCommandAckMessage(revoke.commandId, { status: 'accepted' }),
                ),
              );
              yield* owner.flushUserDelegationRevocations(userId);
              expect(
                (yield* Effect.promise(() =>
                  ownerDb
                    .selectFrom('delegation_revocation_outbox')
                    .select('acknowledged_at')
                    .where('command_id', '=', revocationId)
                    .executeTakeFirstOrThrow(),
                )).acknowledged_at,
              ).not.toBeNull();
            }),
          );

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

          const ownerRedis = Context.get(ownerContext, RedisServiceTag);
          yield* Effect.promise(() =>
            ownerDb.transaction().execute((trx) => enqueueResetRevocation(trx, userId, 2)),
          );
          const unavailable = {
            ...ownerRedis,
            useCommands: () =>
              Effect.fail(new RedisError({ cause: null, message: 'reset Redis unavailable' })),
          };
          const failedReset = yield* Effect.result(
            deliverPendingNotifications(ownerDb, unavailable, ownerCoordination),
          );
          expect(failedReset._tag).toBe('Failure');
          yield* deliverPendingNotifications(ownerDb, ownerRedis, ownerCoordination);
          const resetRevocation = yield* takeMessage(socketFrames, 'revocation');
          expect(resetRevocation.revocationGeneration).toBe(1);
          expect((yield* ownerCoordination.getDaemonPresence(daemonId))?.connectionId).toBe(
            connectionId,
          );

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

const startNotificationWorker = Effect.fnUntraced(function* (
  context: Context.Context<DatabaseService | RedisServiceTag | RealtimeCoordinationServiceTag>,
) {
  const workerContext = yield* Layer.build(
    NotificationOutboxServiceLive.pipe(Layer.provide(Layer.succeedContext(context))),
  );
  const notifications = Context.get(workerContext, NotificationOutboxServiceTag);
  yield* notifications.start;
  return notifications;
});

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
    Layer.succeed(DaemonReleaseStoreTag, {
      staged: Effect.succeed(null),
      announcements: Effect.runSync(Queue.sliding<string>(1)),
    }),
  );
  return DaemonControlServiceLive.pipe(Layer.provideMerge(dependencies));
}

class ExactControlSocket implements DaemonControlSocket {
  readonly closed = Deferred.makeUnsafe<void>();
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
    Deferred.doneUnsafe(this.closed, Effect.void);
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

async function insertUser(
  database: Kysely<DatabaseSchema>,
  id: string,
  daemonId: string,
): Promise<void> {
  await database
    .insertInto('users')
    .values({
      id,
      username: `${id}@merkur.test`,
      opaque_registration_record: 'record',
      root_public_key: 'root-public-key',
      root_key_commitment: 'root-key-commitment',
      root_epoch: 1,
      root_envelope_nonce: 'nonce',
      root_envelope_ciphertext: 'ciphertext',
      created_at: 0,
    })
    .execute();
  await database
    .insertInto('daemons')
    .values({
      id: daemonId,
      user_id: id,
      name: 'Daemon',
      platform: 'linux',
      daemon_identity_public_key: 'identity',
      daemon_identity_p256_public_key: 'p256',
      identity_seal_backend: 'software',
      daemon_identity_key_commitment: 'commitment',
      daemon_binding_json: '{}',
      last_seen: null,
      version: null,
    })
    .execute();
}

async function recordRevocation(
  db: Kysely<DatabaseSchema>,
  userId: string,
  daemonId: string,
): Promise<string> {
  const issuedAt = Date.now();
  const expiresAt = issuedAt + 30 * 24 * 60 * 60 * 1_000;
  const bytes = (length: number, fill: number) => Buffer.alloc(length, fill).toString('base64url');
  const certificate = {
    userId,
    rootKeyCommitment: bytes(64, 21),
    delegationId: 'actor',
    delegatePublicKey: bytes(2_592, 22),
    scopes: ['terminal-session', 'session-revoke'],
    serverOrigin: 'https://localhost:3000',
    rootEpoch: 1,
    issuedAt,
    expiresAt,
    signature: bytes(4_627, 23),
  };
  const revocation = {
    userId,
    rootKeyCommitment: certificate.rootKeyCommitment,
    actorDelegationId: 'actor',
    targets: [{ delegationId: 'target', expiresAt }],
    issuedAt,
    nonce: bytes(32, 24),
    signature: bytes(4_627, 25),
  };
  const commandId = randomUUID();
  await db.transaction().execute(async (trx) => {
    await trx
      .insertInto('delegation_revocations')
      .values({
        nonce: revocation.nonce,
        user_id: userId,
        actor_delegation_id: 'actor',
        actor_certificate_json: JSON.stringify(certificate),
        revocation_json: JSON.stringify(revocation),
        revoked_count: 1,
        created_at: issuedAt,
      })
      .execute();
    await trx
      .insertInto('delegation_revocation_outbox')
      .values({
        command_id: commandId,
        revocation_nonce: revocation.nonce,
        daemon_id: daemonId,
        user_id: userId,
        actor_certificate_json: JSON.stringify(certificate),
        revocation_json: JSON.stringify(revocation),
        created_at: issuedAt,
        acknowledged_at: null,
        rejected_reason: null,
      })
      .execute();
  });
  return commandId;
}
