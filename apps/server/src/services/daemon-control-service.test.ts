import { describe, expect, test } from 'bun:test';
import {
  createDaemonControlCommandAckMessage,
  createDaemonControlSessionCancelMessage,
  type DaemonControlServerMessage,
  encodeDaemonControlMessage,
  parseDaemonControlServerMessage,
} from '@merkur/daemon-control-protocol';
import type { DeviceEventDelta } from '@merkur/shared';
import { Deferred, Effect, Fiber, Layer } from 'effect';

import { type ServerConfig, ServerConfigService } from '../config';
import { DatabaseService } from '../db/client';
import { createMigratedKyselyDatabase } from '../db/migrate';
import type { DatabaseSchema } from '../db/types';
import type { Logger } from '../logger';
import {
  ControlBackpressure,
  type ControlCommandRejected,
  type ControlConnectionHandle,
  ControlDeliveryTimeout,
  type ControlTeardown,
  createDaemonControlService,
  DAEMON_CONTROL_LEASE_RENEWAL_MS,
  DAEMON_CONTROL_PING_TIMEOUT_MS,
  DAEMON_CONTROL_SILENT_AFTER_MS,
  DAEMON_SHUTDOWN_CLOSE_CODE,
  type DaemonControlServiceDependencies,
  DaemonControlServiceLive,
  DaemonControlServiceTag,
  type DaemonControlSocket,
  type DaemonUnavailable,
  StaleDaemonPresence,
} from './daemon-control-service';
import { type DeviceService, DeviceServiceTag } from './device-service';
import { type EdgeRegistryService, EdgeRegistryServiceTag } from './edge-registry-service';
import {
  type DaemonCarrierIdentity,
  type DaemonPresence,
  type DaemonSilenceTransition,
  type RealtimeCoordinationService,
  RealtimeCoordinationServiceTag,
} from './realtime-coordination-service';
import { RedisError, RedisReplyError, type RedisService, RedisServiceTag } from './redis-service';

const DAEMON_ID = 'daemon-1';
const USER_ID = 'user-1';
const CERT_HASH = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const SESSION_OFFER = {
  userId: USER_ID,
  delegationId: 'delegation-1',
  clientNonce: Buffer.alloc(32, 8).toString('base64url'),
  encapsulationKey: Buffer.alloc(1_568, 9).toString('base64url'),
  edgeWtUrl: 'https://edge.example/wt',
  edgeCertHashes: [CERT_HASH],
} as const;

/**
 * Compile-time pin on the teardown classification.
 *
 * Which arm a reason lives in decides whether its lease — and every session
 * claim fenced by it — survives. Moving a reason in the type alone is already a
 * compile error at every call site that names it, so what remains is the
 * coherent-but-wrong edit: someone reclassifies a reason and updates the call
 * sites to match. That version compiles, and asserting on
 * `controlLeaseDisposition` cannot catch it either, since it derives from
 * `kind` and answers correctly for whatever arm it is handed.
 *
 * These pins fail `check:types` the moment an arm gains, loses, or swaps a
 * member, naming the intended mapping in one place a reviewer can check. The
 * behavioural tests below independently catch the same edit — 'retires an
 * active presence when a live revocation delivery is not acknowledged' and
 * 'retry-closes a remote owner without superseding it' both fail — but they
 * fail somewhere further from the cause.
 */
type ExactlyEqual<Actual, Expected> = [Actual] extends [Expected]
  ? [Expected] extends [Actual]
    ? true
    : never
  : never;

const _carrierLostReasonsAreExact: ExactlyEqual<
  Extract<ControlTeardown, { kind: 'carrier_lost' }>['reason'],
  'peer_disconnected' | 'ping_timeout' | 'inbound_overflow' | 'service_shutdown'
> = true;

const _leaseInvalidatedReasonsAreExact: ExactlyEqual<
  Extract<ControlTeardown, { kind: 'lease_invalidated' }>['reason'],
  // `revocation_retry` belongs here and nowhere else: suspending it would keep
  // alive the session claims the revocation exists to terminate. `peer_shutdown`
  // likewise: a daemon that said it was stopping has no PTYs left to resume.
  | 'peer_shutdown'
  | 'invalid_frame'
  | 'worker_defect'
  | 'superseded'
  | 'revocation_retry'
  | 'registration_failed'
> = true;

void _carrierLostReasonsAreExact;
void _leaseInvalidatedReasonsAreExact;

describe('DaemonControlService', () => {
  test('registers ping policy and renews the lease on the ticker with a lease frame', async () => {
    const state = createCoordinationState();
    const bus = createBrokerBus();
    const coordination = createFakeCoordination('instance-a', state);
    const socket = new TestSocket();
    let mono = 0;
    const service = createService(coordination, bus.redis, { monotonicNow: () => mono });

    const handle = await registerHandle(service, socket);
    expect(socket.messagesOfType('registered')).toEqual([
      {
        type: 'registered',
        version: 1,
        connectionId: 'connection-1',
        presenceId: 'presence-1',
        claimSeq: 1,
        revocationGeneration: 7,
        pingIntervalMs: 2_000,
        silentAfterMs: 5_000,
        stunServers: ['stun.test:3478', 'stun.test:3479'],
        stunTicket: 'ticket',
        stunTicketSecret: 'secret',
        stunTicketLifetimeMs: 4_000,
        edgeAttachTicket: EDGE_TICKET,
        edges: EDGES,
      },
    ]);
    // Registration renewed the lease once; nothing is due yet.
    expect(state.renewals).toEqual([[{ daemonId: DAEMON_ID, presenceId: 'presence-1' }]]);
    expect(await Effect.runPromise(service.livenessTick)).toBe(DAEMON_CONTROL_SILENT_AFTER_MS);
    expect(socket.messagesOfType('lease')).toHaveLength(0);

    // Pings keep the carrier out of the silence window while the lease comes
    // due; the renewal is answered with a lease frame.
    mono = DAEMON_CONTROL_LEASE_RENEWAL_MS;
    handle.observePing();
    await Effect.runPromise(service.livenessTick);
    expect(state.renewals).toHaveLength(2);
    expect(socket.messagesOfType('lease')).toEqual([
      {
        type: 'lease',
        version: 1,
        revocationGeneration: 7,
        stunTicket: 'ticket',
        stunTicketSecret: 'secret',
        stunTicketLifetimeMs: 4_000,
        edgeAttachTicket: EDGE_TICKET,
        edges: EDGES,
      },
    ]);
  });

  test('a registry read that fails sends no lease frame until a read succeeds', async () => {
    const state = createCoordinationState();
    const bus = createBrokerBus();
    const coordination = createFakeCoordination('instance-a', state);
    const socket = new TestSocket();
    let mono = 0;
    let registryUp = true;
    const service = createService(coordination, bus.redis, {
      monotonicNow: () => mono,
      edges: Effect.suspend(() =>
        registryUp
          ? Effect.succeed(EDGES)
          : Effect.fail(new RedisError({ message: 'registry down', cause: null })),
      ),
    });
    const handle = await registerHandle(service, socket);
    registryUp = false;
    mono = DAEMON_CONTROL_LEASE_RENEWAL_MS;
    handle.observePing();
    await Effect.runPromise(service.livenessTick);
    expect(socket.messagesOfType('lease')).toHaveLength(0);

    registryUp = true;
    mono += DAEMON_CONTROL_LEASE_RENEWAL_MS;
    handle.observePing();
    await Effect.runPromise(service.livenessTick);
    expect(socket.messagesOfType('lease')).toEqual([
      expect.objectContaining({ type: 'lease', edges: EDGES }),
    ]);
  });

  test('a renewal records last-seen only while the carrier is still answering', async () => {
    const state = createCoordinationState();
    const bus = createBrokerBus();
    const coordination = createFakeCoordination('instance-a', state);
    const socket = new TestSocket();
    let mono = 0;
    const seen: string[][] = [];
    const service = createService(coordination, bus.redis, {
      monotonicNow: () => mono,
      touchDaemonsSeen: (daemonIds) =>
        Effect.sync(() => {
          seen.push([...daemonIds]);
        }),
    });

    const handle = await registerHandle(service, socket);
    // Pings stopped six seconds ago: the socket is up and the lease still
    // renews, but nothing behind it has answered. A `last_seen` that advanced
    // here would say a machine was alive at the exact moment it stopped being
    // reachable — and `last_seen` is all the device list has left to show once
    // it can no longer call the machine online.
    mono = 14_000;
    handle.observePing();
    mono = DAEMON_CONTROL_LEASE_RENEWAL_MS;
    await Effect.runPromise(service.livenessTick);
    expect(state.renewals).toHaveLength(2);
    expect(seen).toEqual([]);

    // Answering again is what makes the next renewal proof of liveness.
    mono = 39_000;
    handle.observePing();
    mono = 2 * DAEMON_CONTROL_LEASE_RENEWAL_MS;
    await Effect.runPromise(service.livenessTick);
    expect(seen).toEqual([[DAEMON_ID]]);
  });

  test('a revoke-all generation is pushed to every connection of the user', async () => {
    const state = createCoordinationState();
    const bus = createBrokerBus();
    const coordination = createFakeCoordination('instance-a', state);
    const socket = new TestSocket();
    const service = createService(coordination, bus.redis);

    await register(service, socket);
    await Effect.runPromise(service.pushRevocationGeneration(USER_ID, 9));
    expect(bus.publishedChannels).toContain('merkur:daemon-control:broadcast');
    const frame = required(
      bus.published.find(({ channel }) => channel === 'merkur:daemon-control:broadcast'),
    ).message;
    expect(JSON.parse(frame)).toEqual({
      type: 'revocation_generation',
      version: 1,
      userId: USER_ID,
      generation: 9,
    });

    // Every instance, including the origin, delivers the broadcast locally.
    await Effect.runPromise(service.processBrokerFrame(frame));
    expect(socket.messagesOfType('revocation')).toEqual([
      { type: 'revocation', version: 1, revocationGeneration: 9 },
    ]);
    await Effect.runPromise(
      service.processBrokerFrame(
        JSON.stringify({
          type: 'revocation_generation',
          version: 1,
          userId: 'user-other',
          generation: 1,
        }),
      ),
    );
    expect(socket.messagesOfType('revocation')).toHaveLength(1);
  });

  test('gates sessions while reconnect revocations are acknowledged in durable order', async () => {
    const state = createCoordinationState();
    const bus = createBrokerBus();
    const coordination = createFakeCoordination('instance-a', state);
    const socket = new TestSocket();
    const acknowledged: string[] = [];
    const rejected: string[] = [];
    const issuedAt = 1_700_000_000_000;
    const expiresAt = issuedAt + 30 * 24 * 60 * 60 * 1_000;
    const rootKeyCommitment = authorizationBytes(64, 1);
    const actorCertificate = {
      userId: USER_ID,
      rootKeyCommitment,
      delegationId: 'delegation-actor',
      delegatePublicKey: authorizationBytes(2_592, 2),
      scopes: ['terminal-session', 'session-revoke'],
      serverOrigin: 'https://merkur.example',
      rootEpoch: 1,
      issuedAt,
      expiresAt,
      signature: authorizationBytes(4_627, 3),
    } as const;
    const revocationJson = (delegationId: string, nonceFill: number, signatureFill: number) =>
      JSON.stringify({
        userId: USER_ID,
        rootKeyCommitment,
        actorDelegationId: actorCertificate.delegationId,
        targets: [{ delegationId, expiresAt }],
        issuedAt: issuedAt + nonceFill,
        nonce: authorizationBytes(32, nonceFill),
        signature: authorizationBytes(4_627, signatureFill),
      });
    const service = createService(coordination, bus.redis, {
      commandTimeoutMs: 2_000,
      revocationOutbox: {
        listPending: () =>
          Effect.succeed([
            {
              commandId: 'revoke-before-self',
              actorCertificateJson: JSON.stringify(actorCertificate),
              revocationJson: revocationJson('delegation-other', 4, 5),
            },
            {
              commandId: 'revoke-self',
              actorCertificateJson: JSON.stringify(actorCertificate),
              revocationJson: revocationJson(actorCertificate.delegationId, 6, 7),
            },
          ]),
        markAcknowledged: (commandId) =>
          Effect.sync(() => {
            acknowledged.push(commandId);
          }),
        markRejected: (commandId) =>
          Effect.sync(() => {
            rejected.push(commandId);
          }),
      },
    });
    let registrationSettled = false;
    const registration = Effect.runPromise(
      service.acceptConnection({
        daemonId: DAEMON_ID,
        userId: USER_ID,
        boxId: null,
        daemonVersion: '4.0.0',
        connectionId: 'connection-1',
        presenceId: 'presence-1',
        socket,
        zone: null,
      }),
    );
    registration.then(
      () => {
        registrationSettled = true;
      },
      () => {
        registrationSettled = true;
      },
    );

    await waitForMessage(socket, 'registered');
    const first = await waitForMessage(socket, 'delegation_revoke');
    expect(first.commandId).toBe('revoke-before-self');
    await Promise.resolve();
    expect(registrationSettled).toBe(false);

    const presence = requirePresence(state);
    await expect(
      Effect.runPromise(
        service.startSession({
          presence,
          sessionId: 'session-before-revocations',
          browserNodeId: 'browser-1',
          offer: SESSION_OFFER,
        }),
      ),
    ).rejects.toMatchObject({
      _tag: 'DaemonUnavailable',
      reason: 'delegation_revocations_pending',
    } satisfies Partial<DaemonUnavailable>);
    expect(socket.messagesOfType('session_start')).toHaveLength(0);

    await Effect.runPromise(
      service.receive(
        presence.connectionId,
        encodeDaemonControlMessage(
          createDaemonControlCommandAckMessage(first.commandId, { status: 'accepted' }),
        ),
      ),
    );
    await waitFor(() => socket.messagesOfType('delegation_revoke').length === 2);
    const second = required(socket.messagesOfType('delegation_revoke').at(1));
    expect(second.commandId).toBe('revoke-self');
    expect(acknowledged).toEqual(['revoke-before-self']);
    expect(registrationSettled).toBe(false);

    await Effect.runPromise(
      service.receive(
        presence.connectionId,
        encodeDaemonControlMessage(
          createDaemonControlCommandAckMessage(second.commandId, {
            status: 'accepted',
          }),
        ),
      ),
    );
    await expect(registration).resolves.toHaveProperty('observePing');
    expect(acknowledged).toEqual(['revoke-before-self', 'revoke-self']);
    expect(rejected).toEqual([]);

    const delivery = Effect.runPromise(
      service.startSession({
        presence,
        sessionId: 'session-after-revocations',
        browserNodeId: 'browser-1',
        offer: SESSION_OFFER,
      }),
    );
    const sessionCommand = await waitForMessage(socket, 'session_start');
    await Effect.runPromise(
      service.receive(
        presence.connectionId,
        encodeDaemonControlMessage(
          createDaemonControlCommandAckMessage(sessionCommand.commandId, {
            status: 'accepted',
          }),
        ),
      ),
    );
    await expect(delivery).resolves.toBeUndefined();
  });

  test('retries a durably rejected revocation after reconnect and clears rejection only on ACK', async () => {
    const db = await createMigratedKyselyDatabase<DatabaseSchema>(':memory:');
    const issuedAt = Date.now() - 1_000;
    const expiresAt = issuedAt + 30 * 24 * 60 * 60 * 1_000;
    const rootKeyCommitment = authorizationBytes(64, 21);
    const actorCertificate = {
      userId: USER_ID,
      rootKeyCommitment,
      delegationId: 'delegation-actor',
      delegatePublicKey: authorizationBytes(2_592, 22),
      scopes: ['terminal-session', 'session-revoke'],
      serverOrigin: 'https://merkur.example',
      rootEpoch: 1,
      issuedAt,
      expiresAt,
      signature: authorizationBytes(4_627, 23),
    } as const;
    const revocation = {
      userId: USER_ID,
      rootKeyCommitment,
      actorDelegationId: actorCertificate.delegationId,
      targets: [{ delegationId: 'delegation-target', expiresAt }],
      issuedAt,
      nonce: authorizationBytes(32, 24),
      signature: authorizationBytes(4_627, 25),
    } as const;
    await db
      .insertInto('users')
      .values({
        id: USER_ID,
        username: 'user@example.com',
        opaque_registration_record: 'opaque-record',
        root_public_key: authorizationBytes(2_592, 20),
        root_key_commitment: rootKeyCommitment,
        root_epoch: 1,
        root_envelope_nonce: authorizationBytes(12, 19),
        root_envelope_ciphertext: authorizationBytes(48, 18),
        created_at: issuedAt,
      })
      .execute();
    await db
      .insertInto('daemons')
      .values({
        id: DAEMON_ID,
        user_id: USER_ID,
        name: 'daemon',
        platform: 'test',
        daemon_identity_public_key: 'identity-key',
        daemon_identity_p256_public_key: 'identity-p256',
        identity_seal_backend: 'software',
        daemon_identity_key_commitment: 'identity-commitment',
        daemon_binding_json: '{}',
        last_seen: issuedAt,
        version: null,
      })
      .execute();
    await db
      .insertInto('delegation_revocations')
      .values({
        nonce: revocation.nonce,
        user_id: USER_ID,
        actor_delegation_id: actorCertificate.delegationId,
        actor_certificate_json: JSON.stringify(actorCertificate),
        revocation_json: JSON.stringify(revocation),
        revoked_count: 1,
        created_at: issuedAt,
      })
      .execute();
    await db
      .insertInto('delegation_revocation_outbox')
      .values({
        command_id: 'revoke-retry',
        revocation_nonce: revocation.nonce,
        daemon_id: DAEMON_ID,
        user_id: USER_ID,
        actor_certificate_json: JSON.stringify(actorCertificate),
        revocation_json: JSON.stringify(revocation),
        created_at: issuedAt,
        acknowledged_at: null,
        rejected_reason: null,
      })
      .execute();
    const state = createCoordinationState();
    const bus = createBrokerBus();
    const redis: RedisService = {
      ...bus.redis,
      subscribe: () => Effect.void,
      unsubscribe: () => Effect.void,
    };
    const dependencies = Layer.mergeAll(
      Layer.succeed(RealtimeCoordinationServiceTag, createFakeCoordination('instance-a', state)),
      Layer.succeed(RedisServiceTag, redis),
      Layer.succeed(DeviceServiceTag, TEST_DEVICE_SERVICE),
      Layer.succeed(DatabaseService, db),
      // The Live layer mints STUN tickets, so it reads the server config.
      Layer.succeed(ServerConfigService, TEST_SERVER_CONFIG),
      Layer.succeed(EdgeRegistryServiceTag, TEST_EDGE_REGISTRY),
    );
    const controlLayer = DaemonControlServiceLive.pipe(Layer.provide(dependencies));

    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const control = yield* DaemonControlServiceTag;
            const firstSocket = new TestSocket();
            const firstRegistration = yield* Effect.forkChild(
              control.acceptConnection({
                daemonId: DAEMON_ID,
                userId: USER_ID,
                boxId: null,
                daemonVersion: '4.0.0',
                connectionId: 'connection-1',
                presenceId: 'presence-1',
                socket: firstSocket,
                zone: null,
              }),
            );
            const first = yield* Effect.promise(() =>
              waitForMessage(firstSocket, 'delegation_revoke'),
            );
            expect(first.commandId).toBe('revoke-retry');
            yield* control.receive(
              'connection-1',
              encodeDaemonControlMessage(
                createDaemonControlCommandAckMessage(first.commandId, {
                  status: 'rejected',
                  reason: 'config_persistence_failed',
                }),
              ),
            );
            yield* Fiber.join(firstRegistration);
            expect(firstSocket.closed).toContainEqual({
              code: 4003,
              reason: 'delegation_revocation_retry',
            });
            expect(
              yield* Effect.promise(() =>
                db
                  .selectFrom('delegation_revocation_outbox')
                  .select(['acknowledged_at', 'rejected_reason'])
                  .where('command_id', '=', 'revoke-retry')
                  .executeTakeFirstOrThrow(),
              ),
            ).toEqual({
              acknowledged_at: null,
              rejected_reason: 'config_persistence_failed',
            });

            yield* control.disconnect('connection-1', null);
            const secondSocket = new TestSocket();
            const secondRegistration = yield* Effect.forkChild(
              control.acceptConnection({
                daemonId: DAEMON_ID,
                userId: USER_ID,
                boxId: null,
                daemonVersion: '4.0.0',
                connectionId: 'connection-2',
                presenceId: 'presence-2',
                socket: secondSocket,
                zone: null,
              }),
            );
            const retried = yield* Effect.promise(() =>
              waitForMessage(secondSocket, 'delegation_revoke'),
            );
            expect(retried.commandId).toBe('revoke-retry');
            yield* control.receive(
              'connection-2',
              encodeDaemonControlMessage(
                createDaemonControlCommandAckMessage(retried.commandId, {
                  status: 'accepted',
                }),
              ),
            );
            yield* Fiber.join(secondRegistration);
            const acknowledged = yield* Effect.promise(() =>
              db
                .selectFrom('delegation_revocation_outbox')
                .select(['acknowledged_at', 'rejected_reason'])
                .where('command_id', '=', 'revoke-retry')
                .executeTakeFirstOrThrow(),
            );
            expect(acknowledged.acknowledged_at).not.toBeNull();
            expect(acknowledged.rejected_reason).toBeNull();
          }).pipe(Effect.provide(controlLayer)),
        ),
      );
    } finally {
      await db.destroy();
    }
  });

  test('retires an active presence when a live revocation delivery is not acknowledged', async () => {
    const state = createCoordinationState();
    const bus = createBrokerBus();
    const socket = new TestSocket();
    const issuedAt = Date.now() - 1_000;
    const expiresAt = issuedAt + 30 * 24 * 60 * 60 * 1_000;
    const rootKeyCommitment = authorizationBytes(64, 31);
    const actorCertificate = {
      userId: USER_ID,
      rootKeyCommitment,
      delegationId: 'delegation-actor',
      delegatePublicKey: authorizationBytes(2_592, 32),
      scopes: ['terminal-session', 'session-revoke'],
      serverOrigin: 'https://merkur.example',
      rootEpoch: 1,
      issuedAt,
      expiresAt,
      signature: authorizationBytes(4_627, 33),
    } as const;
    const revocation = {
      userId: USER_ID,
      rootKeyCommitment,
      actorDelegationId: actorCertificate.delegationId,
      targets: [{ delegationId: 'delegation-target', expiresAt }],
      issuedAt,
      nonce: authorizationBytes(32, 34),
      signature: authorizationBytes(4_627, 35),
    } as const;
    let pending = false;
    const acknowledged: string[] = [];
    const rejected: string[] = [];
    const service = createService(createFakeCoordination('instance-a', state), bus.redis, {
      commandTimeoutMs: 10,
      revocationOutbox: {
        listPending: () =>
          Effect.succeed(
            pending
              ? [
                  {
                    commandId: 'revoke-unacknowledged',
                    actorCertificateJson: JSON.stringify(actorCertificate),
                    revocationJson: JSON.stringify(revocation),
                  },
                ]
              : [],
          ),
        markAcknowledged: (commandId) =>
          Effect.sync(() => {
            acknowledged.push(commandId);
          }),
        markRejected: (commandId) =>
          Effect.sync(() => {
            rejected.push(commandId);
          }),
      },
    });

    await register(service, socket);
    pending = true;
    await Effect.runPromise(service.flushUserDelegationRevocations(USER_ID));

    expect(socket.messagesOfType('delegation_revoke')).toHaveLength(1);
    expect(socket.closed).toContainEqual({
      code: 4003,
      reason: 'delegation_revocation_retry',
    });
    expect(state.presence).toBeNull();
    expect(acknowledged).toEqual([]);
    expect(rejected).toEqual([]);
  });

  test('does not finish registration after the socket closes during device touch', async () => {
    const state = createCoordinationState();
    const bus = createBrokerBus();
    const coordination = createFakeCoordination('instance-a', state);
    const socket = new TestSocket();
    const touchStarted = Effect.runSync(Deferred.make<void>());
    const releaseTouch = Effect.runSync(Deferred.make<void>());
    const service = createService(coordination, bus.redis, {
      touchDaemon: () =>
        Deferred.succeed(touchStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseTouch)),
        ),
    });

    const registration = Effect.runFork(
      service.acceptConnection({
        daemonId: DAEMON_ID,
        userId: USER_ID,
        boxId: null,
        daemonVersion: '4.0.0',
        connectionId: 'connection-1',
        presenceId: 'presence-1',
        socket,
        zone: null,
      }),
    );
    await Effect.runPromise(Deferred.await(touchStarted));
    await Effect.runPromise(service.disconnect('connection-1', null));
    await Effect.runPromise(Deferred.succeed(releaseTouch, undefined));

    await expect(Effect.runPromise(Fiber.join(registration))).rejects.toMatchObject({
      _tag: 'DaemonUnavailable',
      reason: 'socket_closed_during_registration',
    } satisfies Partial<DaemonUnavailable>);
    expect(socket.messagesOfType('registered')).toHaveLength(0);
    expect(state.presence).toBeNull();
  });

  test('releases a Redis claim when registration is interrupted after claim storage', async () => {
    const state = createCoordinationState();
    const bus = createBrokerBus();
    const baseCoordination = createFakeCoordination('instance-a', state);
    const claimStored = Effect.runSync(Deferred.make<void>());
    const releaseClaim = Effect.runSync(Deferred.make<void>());
    const coordination: RealtimeCoordinationService = {
      ...baseCoordination,
      claimDaemonOnline: (input) =>
        baseCoordination.claimDaemonOnline(input).pipe(
          Effect.tap(() => Deferred.succeed(claimStored, undefined)),
          Effect.tap(() => Deferred.await(releaseClaim)),
        ),
    };
    const socket = new TestSocket();
    const service = createService(coordination, bus.redis, {
      touchDaemon: () => Effect.never,
    });
    const registration = Effect.runFork(
      service.acceptConnection({
        daemonId: DAEMON_ID,
        userId: USER_ID,
        boxId: null,
        daemonVersion: '4.0.0',
        connectionId: 'connection-1',
        presenceId: 'presence-1',
        socket,
        zone: null,
      }),
    );

    await Effect.runPromise(Deferred.await(claimStored));
    expect(state.presence).not.toBeNull();
    // Immediate runtime interruption makes this failure injection exact: the
    // claim effect is still suspended after its Redis write. acquireRelease
    // defers the interrupt until the lease finalizer has been installed.
    registration.interruptUnsafe();
    await Effect.runPromise(Deferred.succeed(releaseClaim, undefined));
    await Effect.runPromise(Fiber.await(registration));

    expect(state.presence).toBeNull();
    expect(await Effect.runPromise(service.healthSnapshot())).toMatchObject({
      controlConnections: 0,
    });
  });

  test('publishes the online edge once registration completes', async () => {
    const state = createCoordinationState();
    const bus = createBrokerBus();
    const baseCoordination = createFakeCoordination('instance-a', state);
    const published: Array<{ readonly userId: string; readonly delta: DeviceEventDelta }> = [];
    const coordination: RealtimeCoordinationService = {
      ...baseCoordination,
      publishDeviceDelta: (userId, delta) =>
        Effect.sync(() => {
          published.push({ userId, delta });
        }),
    };
    const socket = new TestSocket();
    const service = createService(coordination, bus.redis);

    await register(service, socket);

    // Without this edge a subscribed browser is never told the daemon came
    // back, so the device list holds a stale offline row indefinitely. It is
    // the only edge the control service publishes itself: every loss edge
    // comes from inside its own Redis transition.
    expect(published).toEqual([
      { userId: USER_ID, delta: { kind: 'presence', daemonId: DAEMON_ID, status: 'online' } },
    ]);
    expect(socket.messagesOfType('registered')).toHaveLength(1);
  });

  test('publishes the offline edge before propagating session cleanup failure', async () => {
    const state = createCoordinationState();
    const bus = createBrokerBus();
    const baseCoordination = createFakeCoordination('instance-a', state);
    const lifecycleEvents: string[] = [];
    const cleanupError = new RedisError({
      cause: null,
      message: 'session cleanup failed',
    });
    const coordination: RealtimeCoordinationService = {
      ...baseCoordination,
      // The offline edge is published from inside the retirement itself, so
      // observing the retirement is observing the publish.
      unmarkDaemonOnline: (input) =>
        baseCoordination.unmarkDaemonOnline(input).pipe(
          Effect.tap((removed) =>
            Effect.sync(() => {
              if (removed) lifecycleEvents.push('retired');
            }),
          ),
        ),
      removeDaemonSessions: () =>
        Effect.sync(() => {
          lifecycleEvents.push('cleanup');
        }).pipe(Effect.andThen(Effect.fail(cleanupError))),
    };
    const socket = new TestSocket();
    const service = createService(coordination, bus.redis);

    await register(service, socket);
    lifecycleEvents.length = 0;
    // An unparseable frame retires the lease outright — a daemon speaking
    // garbage is broken, not blipping — so this exercises the release path
    // rather than the suspend path a plain disconnect now takes.
    await expect(Effect.runPromise(service.receive('connection-1', 'not-a-frame'))).rejects.toBe(
      cleanupError,
    );

    expect(socket.closed).toContainEqual({ code: 1008, reason: 'invalid_control_frame' });
    expect(lifecycleEvents).toEqual(['retired', 'cleanup']);
    expect(state.presence).toBeNull();
  });

  test('a resumed carrier re-sends a revocation stranded on the carrier it replaced', async () => {
    const state = createCoordinationState();
    const bus = createBrokerBus();
    const removedSessions: string[] = [];
    const baseCoordination = createFakeCoordination('instance-a', state);
    const coordination: RealtimeCoordinationService = {
      ...baseCoordination,
      removeDaemonSessions: (input) =>
        Effect.sync(() => {
          removedSessions.push(input.presenceId);
        }),
    };
    const issuedAt = Date.now() - 1_000;
    const expiresAt = issuedAt + 30 * 24 * 60 * 60 * 1_000;
    const rootKeyCommitment = authorizationBytes(64, 31);
    const actorCertificate = {
      userId: USER_ID,
      rootKeyCommitment,
      delegationId: 'delegation-actor',
      delegatePublicKey: authorizationBytes(2_592, 32),
      scopes: ['terminal-session', 'session-revoke'],
      serverOrigin: 'https://merkur.example',
      rootEpoch: 1,
      issuedAt,
      expiresAt,
      signature: authorizationBytes(4_627, 33),
    } as const;
    const revocation = {
      userId: USER_ID,
      rootKeyCommitment,
      actorDelegationId: actorCertificate.delegationId,
      targets: [{ delegationId: 'delegation-target', expiresAt }],
      issuedAt,
      nonce: authorizationBytes(32, 34),
      signature: authorizationBytes(4_627, 35),
    } as const;
    let pending = false;
    const acknowledged: string[] = [];
    const socket = new TestSocket();
    const service = createService(coordination, bus.redis, {
      // Long enough that the stranded delivery is still parked when the daemon
      // reattaches, which is the whole point: a reconnect beats the timeout.
      commandTimeoutMs: 10_000,
      revocationOutbox: {
        listPending: () =>
          Effect.succeed(
            pending
              ? [
                  {
                    // Durable and reused until acknowledged, so registration
                    // re-sends this exact id after the reconnect.
                    commandId: 'revoke-stuck',
                    actorCertificateJson: JSON.stringify(actorCertificate),
                    revocationJson: JSON.stringify(revocation),
                  },
                ]
              : [],
          ),
        markAcknowledged: (commandId) =>
          Effect.sync(() => {
            acknowledged.push(commandId);
          }),
        markRejected: () => Effect.void,
      },
    });

    await register(service, socket);
    pending = true;
    // Forked, so the revocation stays parked awaiting an ack that never comes.
    Effect.runFork(service.flushUserDelegationRevocations(USER_ID));
    await waitFor(() => socket.messagesOfType('delegation_revoke').length === 1);

    await Effect.runPromise(service.disconnect('connection-1', null));
    expect(requirePresence(state).state).toBe('suspended');

    const resumedSocket = new TestSocket();
    const accepted = Effect.runPromise(
      Effect.exit(
        service.acceptConnection({
          daemonId: DAEMON_ID,
          userId: USER_ID,
          boxId: null,
          daemonVersion: '4.0.0',
          connectionId: 'connection-2',
          presenceId: 'presence-fresh',
          resumePresenceId: 'presence-1',
          socket: resumedSocket,
          zone: null,
        }),
      ),
    );

    // Registration re-sends the durable commandId on the resumed carrier. The
    // copy stranded on the departed one must be superseded rather than treated
    // as a duplicate, or registration fails and retires the lease the resume
    // just recovered — destroying the session claims it exists to preserve.
    await waitFor(() => resumedSocket.messagesOfType('delegation_revoke').length === 1);
    await Effect.runPromise(
      service.receive(
        'connection-2',
        encodeDaemonControlMessage(
          createDaemonControlCommandAckMessage('revoke-stuck', { status: 'accepted' }),
        ),
      ),
    );

    const exit = await accepted;
    expect(exit._tag).toBe('Success');
    expect(removedSessions).toEqual([]);
    expect(acknowledged).toEqual(['revoke-stuck']);
    const resumed = requirePresence(state);
    expect(resumed.state).toBe('online');
    expect(resumed.presenceId).toBe('presence-1');
    expect(resumed.connectionId).toBe('connection-2');
  });

  test('suspends rather than retires the lease when a healthy peer disconnects', async () => {
    const state = createCoordinationState();
    const bus = createBrokerBus();
    const removedSessions: string[] = [];
    const baseCoordination = createFakeCoordination('instance-a', state);
    const coordination: RealtimeCoordinationService = {
      ...baseCoordination,
      removeDaemonSessions: (input) =>
        Effect.sync(() => {
          removedSessions.push(input.presenceId);
        }),
    };
    const socket = new TestSocket();
    const service = createService(coordination, bus.redis);

    await register(service, socket);
    const claimed = requirePresence(state);
    await Effect.runPromise(service.disconnect('connection-1', null));

    const suspended = requirePresence(state);
    expect(suspended.state).toBe('suspended');
    // The identity a resume inherits, and every session claim fenced by it,
    // must survive untouched.
    expect(suspended.presenceId).toBe(claimed.presenceId);
    expect(suspended.claimSeq).toBe(claimed.claimSeq);
    expect(removedSessions).toEqual([]);
  });

  test('stops broker ingress before draining connection state on scope close', async () => {
    const state = createCoordinationState();
    const lifecycleEvents: string[] = [];
    const baseCoordination = createFakeCoordination('instance-a', state);
    const coordination: RealtimeCoordinationService = {
      ...baseCoordination,
      // A service shutdown is a rolling deploy, not a daemon going away, so the
      // lease is suspended rather than retired — otherwise every daemon in the
      // fleet would flap offline on each deploy.
      suspendDaemonPresence: (input) =>
        Effect.gen(function* () {
          const suspended = yield* baseCoordination.suspendDaemonPresence(input);
          if (suspended) lifecycleEvents.push('service_shutdown');
          return suspended;
        }),
    };
    const bus = createBrokerBus();
    const redis: RedisService = {
      ...bus.redis,
      subscribe: () =>
        Effect.sync(() => {
          lifecycleEvents.push('subscribed');
        }),
      unsubscribe: () =>
        Effect.sync(() => {
          lifecycleEvents.push('unsubscribed');
        }),
    };
    const dependencies = Layer.mergeAll(
      Layer.succeed(RealtimeCoordinationServiceTag, coordination),
      Layer.succeed(RedisServiceTag, redis),
      Layer.succeed(DeviceServiceTag, TEST_DEVICE_SERVICE),
      testDatabaseLayer(),
      Layer.succeed(ServerConfigService, TEST_SERVER_CONFIG),
      Layer.succeed(EdgeRegistryServiceTag, TEST_EDGE_REGISTRY),
    );
    const controlLayer = DaemonControlServiceLive.pipe(Layer.provide(dependencies));
    const socket = new TestSocket();

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* DaemonControlServiceTag;
          yield* control.acceptConnection({
            daemonId: DAEMON_ID,
            userId: USER_ID,
            boxId: null,
            daemonVersion: '4.0.0',
            connectionId: 'connection-1',
            presenceId: 'presence-1',
            socket,
            zone: null,
          });
        }).pipe(Effect.provide(controlLayer)),
      ),
    );

    // The instance channel and the broadcast channel are both released before
    // connection state is drained.
    expect(lifecycleEvents).toEqual([
      'subscribed',
      'subscribed',
      'unsubscribed',
      'unsubscribed',
      'service_shutdown',
    ]);
    expect(socket.closed).toContainEqual({ code: 1001, reason: 'server_shutdown' });
    expect(state.presence?.state).toBe('suspended');
  });

  test('treats an incompatible Redis reply as a critical broker failure', async () => {
    const state = createCoordinationState();
    const baseCoordination = createFakeCoordination('instance-a', state);
    const coordination: RealtimeCoordinationService = {
      ...baseCoordination,
      getDaemonPresence: () =>
        Effect.fail(new RedisReplyError('broker presence', 'injected incompatible reply')),
    };
    const bus = createBrokerBus();
    let brokerListener: ((frame: string) => void) | undefined;
    const redis: RedisService = {
      ...bus.redis,
      subscribe: (_channel, listener) =>
        Effect.sync(() => {
          brokerListener = listener;
        }),
      unsubscribe: () => Effect.void,
    };
    const dependencies = Layer.mergeAll(
      Layer.succeed(RealtimeCoordinationServiceTag, coordination),
      Layer.succeed(RedisServiceTag, redis),
      Layer.succeed(DeviceServiceTag, TEST_DEVICE_SERVICE),
      testDatabaseLayer(),
      Layer.succeed(ServerConfigService, TEST_SERVER_CONFIG),
      Layer.succeed(EdgeRegistryServiceTag, TEST_EDGE_REGISTRY),
    );
    const controlLayer = DaemonControlServiceLive.pipe(Layer.provide(dependencies));

    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* DaemonControlServiceTag;
          const criticalFailure = yield* Effect.forkChild(control.awaitCriticalFailure);
          required(brokerListener)(
            JSON.stringify({
              type: 'command_request',
              version: 1,
              requesterInstanceId: 'instance-requester',
              ownerInstanceId: 'instance-a',
              daemonId: DAEMON_ID,
              userId: USER_ID,
              connectionId: 'connection-1',
              presenceId: 'presence-1',
              claimSeq: 1,
              trace: {
                traceId: '0123456789abcdef0123456789abcdef',
                spanId: '0123456789abcdef',
                sampled: true,
              },
              command: createDaemonControlSessionCancelMessage(
                'command-1',
                'session-1',
                'browser-1',
                '',
              ),
            }),
          );
          for (let attempt = 0; attempt < 100; attempt += 1) {
            const current = yield* control.healthSnapshot();
            if (!current.brokerWorkersHealthy) {
              return {
                snapshot: current,
                criticalExit: yield* Fiber.await(criticalFailure),
              };
            }
            yield* Effect.yieldNow;
          }
          return {
            snapshot: yield* control.healthSnapshot(),
            criticalExit: yield* Fiber.await(criticalFailure),
          };
        }).pipe(Effect.provide(controlLayer)),
      ),
    );

    expect(observed.snapshot.brokerWorkersHealthy).toBe(false);
    expect(observed.criticalExit._tag).toBe('Failure');
  });

  test('completes a local session start only after the daemon acknowledges admission', async () => {
    const state = createCoordinationState();
    const bus = createBrokerBus();
    const coordination = createFakeCoordination('instance-a', state);
    const socket = new TestSocket();
    const service = createService(coordination, bus.redis);

    await register(service, socket);
    const presence = requirePresence(state);
    let settled = false;
    const delivery = Effect.runPromise(
      service.startSession({
        presence,
        sessionId: 'session-1',
        browserNodeId: 'browser-1',
        offer: SESSION_OFFER,
      }),
    );
    delivery.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    const command = await waitForMessage(socket, 'session_start');
    await Promise.resolve();
    expect(settled).toBe(false);

    await Effect.runPromise(
      service.receive(
        presence.connectionId,
        encodeDaemonControlMessage(
          createDaemonControlCommandAckMessage(command.commandId, {
            status: 'accepted',
          }),
        ),
      ),
    );

    await expect(delivery).resolves.toBeUndefined();
    expect(settled).toBe(true);
  });

  test('ping frames never enter the inbound mailbox', async () => {
    const state = createCoordinationState();
    const bus = createBrokerBus();
    const coordination = createFakeCoordination('instance-a', state);
    const socket = new TestSocket();
    const service = createService(coordination, bus.redis, {
      maxPendingCommandsPerConnection: 1,
    });

    const handle = await registerHandle(service, socket);
    // A flood of pings is free: no mailbox slot, no Redis, no teardown.
    for (let index = 0; index < 1_000; index += 1) handle.observePing();
    expect(socket.closed).toEqual([]);

    const delivery = Effect.runPromise(
      service.startSession(createSessionStartInput(requirePresence(state), 'session-after-pings')),
    );
    const command = await waitForMessage(socket, 'session_start');
    await Effect.runPromise(
      service.receive(
        'connection-1',
        encodeDaemonControlMessage(
          createDaemonControlCommandAckMessage(command.commandId, { status: 'accepted' }),
        ),
      ),
    );
    await expect(delivery).resolves.toBeUndefined();
  });

  test('closes an overloaded inbound mailbox with WebSocket 1013', async () => {
    const state = createCoordinationState();
    const bus = createBrokerBus();
    const baseCoordination = createFakeCoordination('instance-a', state);
    const ackStarted = Effect.runSync(Deferred.make<void>());
    const holdAck = Effect.runSync(Deferred.make<void>());
    let gateAcks = false;
    const coordination: RealtimeCoordinationService = {
      ...baseCoordination,
      getDaemonPresence: (daemonId) =>
        gateAcks
          ? Deferred.succeed(ackStarted, undefined).pipe(
              Effect.andThen(Deferred.await(holdAck)),
              Effect.andThen(baseCoordination.getDaemonPresence(daemonId)),
            )
          : baseCoordination.getDaemonPresence(daemonId),
    };
    const socket = new TestSocket();
    const service = createService(coordination, bus.redis, {
      maxPendingCommandsPerConnection: 1,
    });

    await register(service, socket);
    const delivery = Effect.runPromise(
      Effect.exit(
        service.startSession(createSessionStartInput(requirePresence(state), 'session-overflow')),
      ),
    );
    const command = await waitForMessage(socket, 'session_start');
    const ackFrame = encodeDaemonControlMessage(
      createDaemonControlCommandAckMessage(command.commandId, { status: 'accepted' }),
    );
    gateAcks = true;
    const processing = Effect.runFork(service.receive('connection-1', ackFrame));
    await Effect.runPromise(Deferred.await(ackStarted));
    const queued = Effect.runFork(service.receive('connection-1', ackFrame));

    await expect(
      Effect.runPromise(service.receive('connection-1', ackFrame)),
    ).rejects.toBeInstanceOf(ControlBackpressure);
    expect(socket.closed).toContainEqual({
      code: 1013,
      reason: 'control_inbound_overflow',
    });
    await Effect.runPromise(Deferred.succeed(holdAck, undefined));
    await Effect.runPromise(Fiber.await(processing));
    await Effect.runPromise(Fiber.await(queued));
    // The command stays pending for whichever carrier resumes the lease, so
    // `delivery` settles only on its own timeout and is deliberately not awaited.
    void delivery;
    // An overloaded mailbox is transient, so the lease is suspended, not retired.
    expect(state.presence?.state).toBe('suspended');
  });

  test('surfaces an unexpected inbound worker defect through health and closes the socket', async () => {
    const state = createCoordinationState();
    const bus = createBrokerBus();
    const baseCoordination = createFakeCoordination('instance-a', state);
    let failAck = false;
    const coordination: RealtimeCoordinationService = {
      ...baseCoordination,
      getDaemonPresence: (daemonId) =>
        failAck
          ? Effect.die(new Error('injected inbound worker defect'))
          : baseCoordination.getDaemonPresence(daemonId),
    };
    const socket = new TestSocket();
    const service = createService(coordination, bus.redis);

    await register(service, socket);
    const delivery = Effect.runPromise(
      Effect.exit(
        service.startSession(createSessionStartInput(requirePresence(state), 'session-defect')),
      ),
    );
    const command = await waitForMessage(socket, 'session_start');
    failAck = true;
    await expect(
      Effect.runPromise(
        service.receive(
          'connection-1',
          encodeDaemonControlMessage(
            createDaemonControlCommandAckMessage(command.commandId, { status: 'accepted' }),
          ),
        ),
      ),
    ).rejects.toThrow('injected inbound worker defect');
    void delivery;
    await waitFor(() =>
      socket.closed.some(({ code, reason }) => code === 1011 && reason === 'control_worker_failed'),
    );

    expect(await Effect.runPromise(service.healthSnapshot())).toMatchObject({
      connectionWorkersHealthy: false,
      controlConnections: 0,
    });
  });

  test('routes a fenced command across replicas and returns the remote acknowledgement', async () => {
    const state = createCoordinationState();
    const bus = createBrokerBus();
    const ownerCoordination = createFakeCoordination('instance-owner', state);
    const requesterCoordination = createFakeCoordination('instance-requester', state);
    const socket = new TestSocket();
    const owner = createService(ownerCoordination, bus.redis);
    const requester = createService(requesterCoordination, bus.redis);
    bus.register('instance-owner', (frame) => Effect.runPromise(owner.processBrokerFrame(frame)));
    bus.register('instance-requester', (frame) =>
      Effect.runPromise(requester.processBrokerFrame(frame)),
    );

    await register(owner, socket);
    const presence = requirePresence(state);
    let settled = false;
    const delivery = Effect.runPromise(
      requester.startSession({
        presence,
        sessionId: 'session-cross-replica',
        browserNodeId: 'browser-1',
        offer: SESSION_OFFER,
      }),
    );
    delivery.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    const command = await waitForMessage(socket, 'session_start');
    await Promise.resolve();
    expect(settled).toBe(false);

    await Effect.runPromise(
      owner.receive(
        presence.connectionId,
        encodeDaemonControlMessage(
          createDaemonControlCommandAckMessage(command.commandId, {
            status: 'accepted',
          }),
        ),
      ),
    );

    await expect(delivery).resolves.toBeUndefined();
    expect(settled).toBe(true);
    expect(bus.publishedChannels).toEqual([
      'merkur:daemon-control:instance:instance-owner',
      'merkur:daemon-control:instance:instance-requester',
    ]);
    const brokerRequest = JSON.parse(required(bus.published[0]).message) as {
      readonly trace?: {
        readonly traceId?: unknown;
        readonly spanId?: unknown;
        readonly sampled?: unknown;
      };
    };
    expect(brokerRequest.trace?.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(brokerRequest.trace?.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(brokerRequest.trace?.sampled).toBe(true);
  });

  test('routes a revocation across replicas and keeps the ACKed owner presence active', async () => {
    const state = createCoordinationState();
    const bus = createBrokerBus();
    const ownerCoordination = createFakeCoordination('instance-owner', state);
    const requesterCoordination = createFakeCoordination('instance-requester', state);
    const socket = new TestSocket();
    const issuedAt = Date.now() - 1_000;
    const expiresAt = issuedAt + 30 * 24 * 60 * 60 * 1_000;
    const rootKeyCommitment = authorizationBytes(64, 41);
    const actorCertificate = {
      userId: USER_ID,
      rootKeyCommitment,
      delegationId: 'delegation-actor',
      delegatePublicKey: authorizationBytes(2_592, 42),
      scopes: ['terminal-session', 'session-revoke'],
      serverOrigin: 'https://merkur.example',
      rootEpoch: 1,
      issuedAt,
      expiresAt,
      signature: authorizationBytes(4_627, 43),
    } as const;
    const revocation = {
      userId: USER_ID,
      rootKeyCommitment,
      actorDelegationId: actorCertificate.delegationId,
      targets: [{ delegationId: 'delegation-target', expiresAt }],
      issuedAt,
      nonce: authorizationBytes(32, 44),
      signature: authorizationBytes(4_627, 45),
    } as const;
    const acknowledged: string[] = [];
    const owner = createService(ownerCoordination, bus.redis);
    const requester = createService(requesterCoordination, bus.redis, {
      revocationOutbox: {
        listPending: () =>
          Effect.succeed([
            {
              commandId: 'revoke-cross-replica',
              actorCertificateJson: JSON.stringify(actorCertificate),
              revocationJson: JSON.stringify(revocation),
            },
          ]),
        markAcknowledged: (commandId) =>
          Effect.sync(() => {
            acknowledged.push(commandId);
          }),
        markRejected: () => Effect.void,
      },
    });
    bus.register('instance-owner', (frame) => Effect.runPromise(owner.processBrokerFrame(frame)));
    bus.register('instance-requester', (frame) =>
      Effect.runPromise(requester.processBrokerFrame(frame)),
    );

    await register(owner, socket);
    const presence = requirePresence(state);
    const delivery = Effect.runPromise(requester.flushUserDelegationRevocations(USER_ID));
    const command = await waitForMessage(socket, 'delegation_revoke');
    expect(command.commandId).toBe('revoke-cross-replica');
    await Effect.runPromise(
      owner.receive(
        presence.connectionId,
        encodeDaemonControlMessage(
          createDaemonControlCommandAckMessage(command.commandId, {
            status: 'accepted',
          }),
        ),
      ),
    );

    await expect(delivery).resolves.toBeUndefined();
    expect(acknowledged).toEqual(['revoke-cross-replica']);
    expect(socket.closed).toEqual([]);
    expect(state.presence).toEqual(presence);
  });

  test('retry-closes a remote owner without superseding it and redelivers after reconnect', async () => {
    const state = createCoordinationState();
    const bus = createBrokerBus();
    const ownerCoordination = createFakeCoordination('instance-owner', state);
    const requesterCoordination = createFakeCoordination('instance-requester', state);
    const firstSocket = new TestSocket();
    const issuedAt = Date.now() - 1_000;
    const expiresAt = issuedAt + 30 * 24 * 60 * 60 * 1_000;
    const rootKeyCommitment = authorizationBytes(64, 51);
    const actorCertificate = {
      userId: USER_ID,
      rootKeyCommitment,
      delegationId: 'delegation-actor',
      delegatePublicKey: authorizationBytes(2_592, 52),
      scopes: ['terminal-session', 'session-revoke'],
      serverOrigin: 'https://merkur.example',
      rootEpoch: 1,
      issuedAt,
      expiresAt,
      signature: authorizationBytes(4_627, 53),
    } as const;
    const revocation = {
      userId: USER_ID,
      rootKeyCommitment,
      actorDelegationId: actorCertificate.delegationId,
      targets: [{ delegationId: 'delegation-target', expiresAt }],
      issuedAt,
      nonce: authorizationBytes(32, 54),
      signature: authorizationBytes(4_627, 55),
    } as const;
    const acknowledged: string[] = [];
    const owner = createService(ownerCoordination, bus.redis, { commandTimeoutMs: 5 });
    const requester = createService(requesterCoordination, bus.redis, {
      commandTimeoutMs: 50,
      revocationOutbox: {
        listPending: () =>
          Effect.succeed([
            {
              commandId: 'revoke-remote-retry',
              actorCertificateJson: JSON.stringify(actorCertificate),
              revocationJson: JSON.stringify(revocation),
            },
          ]),
        markAcknowledged: (commandId) =>
          Effect.sync(() => {
            acknowledged.push(commandId);
          }),
        markRejected: () => Effect.void,
      },
    });
    bus.register('instance-owner', (frame) => Effect.runPromise(owner.processBrokerFrame(frame)));
    bus.register('instance-requester', (frame) =>
      Effect.runPromise(requester.processBrokerFrame(frame)),
    );

    await register(owner, firstSocket);
    await Effect.runPromise(requester.flushUserDelegationRevocations(USER_ID));

    expect(firstSocket.messagesOfType('delegation_revoke')).toHaveLength(1);
    expect(firstSocket.messagesOfType('superseded')).toEqual([]);
    expect(firstSocket.closed).toContainEqual({
      code: 4003,
      reason: 'delegation_revocation_retry',
    });
    expect(state.presence).toBeNull();
    expect(acknowledged).toEqual([]);

    const secondSocket = new TestSocket();
    await register(owner, secondSocket, 'connection-2', 'presence-2');
    const secondPresence = requirePresence(state);
    const retried = Effect.runPromise(requester.flushUserDelegationRevocations(USER_ID));
    const command = await waitForMessage(secondSocket, 'delegation_revoke');
    expect(command.commandId).toBe('revoke-remote-retry');
    await Effect.runPromise(
      owner.receive(
        secondPresence.connectionId,
        encodeDaemonControlMessage(
          createDaemonControlCommandAckMessage(command.commandId, {
            status: 'accepted',
          }),
        ),
      ),
    );
    await expect(retried).resolves.toBeUndefined();
    expect(acknowledged).toEqual(['revoke-remote-retry']);
    expect(secondSocket.closed).toEqual([]);
  });

  test('propagates an explicit daemon command rejection', async () => {
    const state = createCoordinationState();
    const bus = createBrokerBus();
    const coordination = createFakeCoordination('instance-a', state);
    const socket = new TestSocket();
    const service = createService(coordination, bus.redis);

    await register(service, socket);
    const presence = requirePresence(state);
    const delivery = Effect.runPromise(
      service.startSession({
        presence,
        sessionId: 'session-rejected',
        browserNodeId: 'browser-1',
        offer: SESSION_OFFER,
      }),
    );
    const command = await waitForMessage(socket, 'session_start');

    await Effect.runPromise(
      service.receive(
        presence.connectionId,
        encodeDaemonControlMessage(
          createDaemonControlCommandAckMessage(command.commandId, {
            status: 'rejected',
            reason: 'dataplane_backpressure',
          }),
        ),
      ),
    );

    await expect(delivery).rejects.toMatchObject({
      _tag: 'ControlCommandRejected',
      reason: 'dataplane_backpressure',
    } satisfies Partial<ControlCommandRejected>);
  });

  test('fails a command with a bounded acknowledgement timeout', async () => {
    const state = createCoordinationState();
    const bus = createBrokerBus();
    const coordination = createFakeCoordination('instance-a', state);
    const socket = new TestSocket();
    const service = createService(coordination, bus.redis, { commandTimeoutMs: 10 });

    await register(service, socket);
    await expect(
      Effect.runPromise(
        service.startSession({
          presence: requirePresence(state),
          sessionId: 'session-timeout',
          browserNodeId: 'browser-1',
          offer: SESSION_OFFER,
        }),
      ),
    ).rejects.toBeInstanceOf(ControlDeliveryTimeout);
  });

  test('fails closed when the caller supplies a stale daemon presence fence', async () => {
    const state = createCoordinationState();
    const bus = createBrokerBus();
    const coordination = createFakeCoordination('instance-a', state);
    const service = createService(coordination, bus.redis);
    const socket = new TestSocket();

    await register(service, socket);
    const stalePresence = requirePresence(state);
    state.presence = {
      ...stalePresence,
      connectionId: 'connection-new',
      presenceId: 'presence-new',
      claimSeq: stalePresence.claimSeq + 1,
    };

    await expect(
      Effect.runPromise(
        service.startSession({
          presence: stalePresence,
          sessionId: 'session-stale',
          browserNodeId: 'browser-1',
          offer: SESSION_OFFER,
        }),
      ),
    ).rejects.toBeInstanceOf(StaleDaemonPresence);
    expect(socket.messagesOfType('session_start')).toHaveLength(0);
  });

  test('rejects an acknowledgement if the presence was superseded after send', async () => {
    const state = createCoordinationState();
    const bus = createBrokerBus();
    const coordination = createFakeCoordination('instance-a', state);
    const socket = new TestSocket();
    const service = createService(coordination, bus.redis);

    await register(service, socket);
    const oldPresence = requirePresence(state);
    const delivery = Effect.runPromise(
      service.startSession({
        presence: oldPresence,
        sessionId: 'session-raced',
        browserNodeId: 'browser-1',
        offer: SESSION_OFFER,
      }),
    );
    const deliveryFailure = delivery.then(
      () => null,
      (error: unknown) => error,
    );
    const command = await waitForMessage(socket, 'session_start');
    state.presence = {
      ...oldPresence,
      ownerInstanceId: 'instance-b',
      connectionId: 'connection-new',
      presenceId: 'presence-new',
      claimSeq: oldPresence.claimSeq + 1,
    };

    await expect(
      Effect.runPromise(
        service.receive(
          oldPresence.connectionId,
          encodeDaemonControlMessage(
            createDaemonControlCommandAckMessage(command.commandId, {
              status: 'accepted',
            }),
          ),
        ),
      ),
    ).rejects.toBeInstanceOf(StaleDaemonPresence);
    expect(await deliveryFailure).toBeInstanceOf(StaleDaemonPresence);
    expect(socket.closed).toContainEqual({ code: 4001, reason: 'superseded' });
  });

  test('returns a stale result when a broker command loses its presence fence in transit', async () => {
    const state = createCoordinationState();
    const bus = createBrokerBus();
    const ownerCoordination = createFakeCoordination('instance-owner', state);
    const requesterCoordination = createFakeCoordination('instance-requester', state);
    const socket = new TestSocket();
    const owner = createService(ownerCoordination, bus.redis);
    const requester = createService(requesterCoordination, bus.redis);
    bus.register('instance-requester', (frame) =>
      Effect.runPromise(requester.processBrokerFrame(frame)),
    );

    await register(owner, socket);
    const oldPresence = requirePresence(state);
    const delivery = Effect.runPromise(
      requester.startSession({
        presence: oldPresence,
        sessionId: 'session-stale-in-transit',
        browserNodeId: 'browser-1',
        offer: SESSION_OFFER,
      }),
    );
    await waitFor(() => bus.published.length === 1);
    const brokerRequest = required(bus.published[0]);
    state.presence = {
      ...oldPresence,
      connectionId: 'connection-new',
      presenceId: 'presence-new',
      claimSeq: oldPresence.claimSeq + 1,
    };

    await Effect.runPromise(owner.processBrokerFrame(brokerRequest.message));

    await expect(delivery).rejects.toBeInstanceOf(StaleDaemonPresence);
    expect(socket.messagesOfType('session_start')).toHaveLength(0);
  });

  test('closes and reports control backpressure when the socket rejects a command', async () => {
    const state = createCoordinationState();
    const bus = createBrokerBus();
    const coordination = createFakeCoordination('instance-a', state);
    const socket = new TestSocket([1, -1]);
    const service = createService(coordination, bus.redis);

    await register(service, socket);
    await expect(
      Effect.runPromise(
        service.startSession({
          presence: requirePresence(state),
          sessionId: 'session-overloaded',
          browserNodeId: 'browser-1',
          offer: SESSION_OFFER,
        }),
      ),
    ).rejects.toBeInstanceOf(ControlBackpressure);
    expect(socket.closed).toContainEqual({
      code: 1013,
      reason: 'control_backpressure',
    });
  });

  test('supersedes an older local connection and marks silence before the ping timeout', async () => {
    const state = createCoordinationState();
    const bus = createBrokerBus();
    const coordination = createFakeCoordination('instance-a', state);
    let mono = 10_000;
    const firstSocket = new TestSocket();
    const secondSocket = new TestSocket();
    const service = createService(coordination, bus.redis, { monotonicNow: () => mono });

    await register(service, firstSocket, 'connection-1', 'presence-1');
    const handle = await registerHandle(service, secondSocket, 'connection-2', 'presence-2');

    expect(firstSocket.messagesOfType('superseded')).toHaveLength(1);
    expect(firstSocket.closed).toContainEqual({ code: 4001, reason: 'superseded' });

    // Silence: the browser is told, the carrier and the lease are untouched.
    mono += DAEMON_CONTROL_SILENT_AFTER_MS;
    await Effect.runPromise(service.livenessTick);
    await waitFor(() => state.presence?.state === 'silent');
    expect(secondSocket.closed).toEqual([]);
    expect(state.silenceTransitions).toEqual(['silent']);

    // The next ping clears it without a round trip on the ping path itself.
    handle.observePing();
    await waitFor(() => state.presence?.state === 'online');
    expect(state.silenceTransitions).toEqual(['silent', 'online']);

    // Only the hard timeout tears the carrier down, and even then the lease is
    // held through its resume grace window rather than retired, so the device
    // reads `degraded` instead of vanishing from the list.
    mono += DAEMON_CONTROL_PING_TIMEOUT_MS;
    await Effect.runPromise(service.livenessTick);
    expect(secondSocket.closed).toContainEqual({
      code: 1001,
      reason: 'ping_timeout',
    });
    expect(state.presence?.state).toBe('suspended');
  });

  test('a deliberate daemon shutdown releases the lease and its sessions at once', async () => {
    const state = createCoordinationState();
    const bus = createBrokerBus();
    const removedSessions: string[] = [];
    const coordination: RealtimeCoordinationService = {
      ...createFakeCoordination('instance-a', state),
      removeDaemonSessions: (input) =>
        Effect.sync(() => {
          removedSessions.push(input.presenceId);
        }),
    };
    const socket = new TestSocket();
    const service = createService(coordination, bus.redis);

    await register(service, socket);
    await Effect.runPromise(service.disconnect('connection-1', DAEMON_SHUTDOWN_CLOSE_CODE));

    // No resume grace: the PTYs went with the process.
    expect(state.presence).toBeNull();
    expect(removedSessions).toEqual(['presence-1']);
    expect(await Effect.runPromise(service.livenessTick)).toBeNull();
  });

  test('enforces local pending-command capacity across concurrent deliveries', async () => {
    const state = createCoordinationState();
    const bus = createBrokerBus();
    const coordination = createFakeCoordination('instance-a', state);
    const socket = new TestSocket();
    const service = createService(coordination, bus.redis, {
      maxPendingCommandsPerConnection: 1,
    });

    await register(service, socket);
    const presence = requirePresence(state);
    const first = Effect.runFork(
      service.startSession(createSessionStartInput(presence, 'session-local-first')),
    );
    try {
      await waitFor(() => socket.messagesOfType('session_start').length === 1);
      await expect(
        Effect.runPromise(
          service.startSession(createSessionStartInput(presence, 'session-local-second')),
        ),
      ).rejects.toBeInstanceOf(ControlBackpressure);
      expect(socket.messagesOfType('session_start')).toHaveLength(1);
    } finally {
      await Effect.runPromise(Fiber.interrupt(first));
    }
  });

  test('disconnect parks an admitted local command instead of failing it', async () => {
    const state = createCoordinationState();
    const bus = createBrokerBus();
    const coordination = createFakeCoordination('instance-a', state);
    const socket = new TestSocket();
    const service = createService(coordination, bus.redis, { commandTimeoutMs: 50 });

    await register(service, socket);
    let settled = false;
    const delivery = Effect.runPromise(
      service.startSession(
        createSessionStartInput(requirePresence(state), 'session-local-disconnect'),
      ),
    );
    delivery.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await waitFor(() => socket.messagesOfType('session_start').length === 1);
    await Effect.runPromise(service.disconnect('connection-1', null));

    // The carrier is gone but the lease is only suspended, so the command is
    // still deliverable to whatever connection resumes it. It must not be
    // failed the instant the socket drops — that is the churn being removed.
    await Promise.resolve();
    expect(settled).toBe(false);

    // Nobody reattaches, so the caller's patience budget decides.
    await expect(delivery).rejects.toMatchObject({
      _tag: 'ControlDeliveryTimeout',
    });
  });

  test('a reconnect reclaims the suspended lease and delivers the parked command', async () => {
    const state = createCoordinationState();
    const bus = createBrokerBus();
    const removedSessions: string[] = [];
    const baseCoordination = createFakeCoordination('instance-a', state);
    const coordination: RealtimeCoordinationService = {
      ...baseCoordination,
      removeDaemonSessions: (input) =>
        Effect.sync(() => {
          removedSessions.push(input.presenceId);
        }),
    };
    const first = new TestSocket();
    const service = createService(coordination, bus.redis);

    await register(service, first);
    const claimed = requirePresence(state);

    // A command goes out, then the carrier drops before it is acknowledged.
    const delivery = Effect.runPromise(
      service.startSession(createSessionStartInput(claimed, 'session-across-blip')),
    );
    await waitFor(() => first.messagesOfType('session_start').length === 1);
    const sent = required(first.messagesOfType('session_start')[0]);
    await Effect.runPromise(service.disconnect('connection-1', null));
    expect(requirePresence(state).state).toBe('suspended');

    // The daemon comes back offering the lease it still believes it owns.
    const second = new TestSocket();
    await Effect.runPromise(
      service.acceptConnection({
        daemonId: DAEMON_ID,
        userId: USER_ID,
        boxId: null,
        daemonVersion: '4.0.0',
        connectionId: 'connection-2',
        presenceId: 'presence-unused',
        resumePresenceId: claimed.presenceId,
        socket: second,
        zone: null,
      }),
    );

    const resumed = requirePresence(state);
    expect(resumed.state).toBe('online');
    // Same lease, so no supersession and no session teardown.
    expect(resumed.presenceId).toBe(claimed.presenceId);
    expect(resumed.claimSeq).toBe(claimed.claimSeq);
    expect(resumed.connectionId).toBe('connection-2');
    expect(first.messagesOfType('superseded')).toHaveLength(0);
    expect(removedSessions).toEqual([]);

    // The parked command is replayed onto the new carrier as the same command,
    // and the caller that never stopped waiting completes normally.
    await waitFor(() => second.messagesOfType('session_start').length === 1);
    const replayed = required(second.messagesOfType('session_start')[0]);
    expect(replayed.commandId).toBe(sent.commandId);

    await Effect.runPromise(
      service.receive(
        'connection-2',
        encodeDaemonControlMessage(
          createDaemonControlCommandAckMessage(replayed.commandId, {
            status: 'accepted',
          }),
        ),
      ),
    );
    await expect(delivery).resolves.toBeUndefined();
  });

  test('a lease reclaimed on another replica keeps the lease but not the parked command', async () => {
    const state = createCoordinationState();
    const bus = createBrokerBus();
    const first = new TestSocket();
    const owner = createService(createFakeCoordination('instance-owner', state), bus.redis, {
      commandTimeoutMs: 50,
    });
    const taker = createService(createFakeCoordination('instance-taker', state), bus.redis);
    bus.register('instance-owner', (frame) => Effect.runPromise(owner.processBrokerFrame(frame)));
    bus.register('instance-taker', (frame) => Effect.runPromise(taker.processBrokerFrame(frame)));

    await register(owner, first);
    const claimed = requirePresence(state);
    const delivery = Effect.runPromise(
      owner.startSession(createSessionStartInput(claimed, 'session-handover')),
    );
    await waitFor(() => first.messagesOfType('session_start').length === 1);
    await Effect.runPromise(owner.disconnect('connection-1', null));

    const second = new TestSocket();
    await Effect.runPromise(
      taker.acceptConnection({
        daemonId: DAEMON_ID,
        userId: USER_ID,
        boxId: null,
        daemonVersion: '4.0.0',
        connectionId: 'connection-2',
        presenceId: 'presence-unused',
        resumePresenceId: claimed.presenceId,
        socket: second,
        zone: null,
      }),
    );

    // Lease continuity is preserved across replicas — that is what keeps the
    // device online and its sessions alive.
    const resumed = requirePresence(state);
    expect(resumed.presenceId).toBe(claimed.presenceId);
    expect(resumed.claimSeq).toBe(claimed.claimSeq);
    expect(first.messagesOfType('superseded')).toHaveLength(0);

    // Command continuity is deliberately not: the outbox is in-memory on the
    // replica that admitted the command, so a reclaim elsewhere has nothing to
    // replay. The caller times out and its caller retries. Making this survive
    // needs a durable per-presence log, which was judged to cost more than the
    // narrow window it covers.
    expect(second.messagesOfType('session_start')).toHaveLength(0);
    await expect(delivery).rejects.toMatchObject({ _tag: 'ControlDeliveryTimeout' });
  });

  test('a restarted daemon presenting no lease gets a fresh one', async () => {
    const state = createCoordinationState();
    const bus = createBrokerBus();
    const first = new TestSocket();
    const service = createService(createFakeCoordination('instance-a', state), bus.redis);

    await register(service, first);
    const claimed = requirePresence(state);
    await Effect.runPromise(service.disconnect('connection-1', null));

    // A restart lost its PTYs, so it cannot present a lease and must not
    // inherit the sessions fenced by the old one.
    const second = new TestSocket();
    await Effect.runPromise(
      service.acceptConnection({
        daemonId: DAEMON_ID,
        userId: USER_ID,
        boxId: null,
        daemonVersion: '4.0.0',
        connectionId: 'connection-2',
        presenceId: 'presence-restarted',
        socket: second,
        zone: null,
      }),
    );

    const fresh = requirePresence(state);
    expect(fresh.presenceId).toBe('presence-restarted');
    expect(fresh.claimSeq).toBeGreaterThan(claimed.claimSeq);
  });

  test('retiring the lease fails every command still awaiting it', async () => {
    const state = createCoordinationState();
    const bus = createBrokerBus();
    const coordination = createFakeCoordination('instance-a', state);
    const socket = new TestSocket();
    const service = createService(coordination, bus.redis);

    await register(service, socket);
    const delivery = Effect.runPromise(
      service.startSession(createSessionStartInput(requirePresence(state), 'session-local-retire')),
    );
    await waitFor(() => socket.messagesOfType('session_start').length === 1);
    // An unparseable frame retires the lease outright rather than suspending it,
    // so there is nothing left to deliver to and the caller learns immediately.
    await Effect.runPromise(Effect.result(service.receive('connection-1', 'not-a-frame')));

    await expect(delivery).rejects.toMatchObject({
      _tag: 'DaemonUnavailable',
      reason: 'socket_closed',
    } satisfies Partial<DaemonUnavailable>);
    expect(state.presence).toBeNull();
  });

  test('does not admit a local command after shutdown wins an in-flight lookup', async () => {
    const state = createCoordinationState();
    const bus = createBrokerBus();
    const baseCoordination = createFakeCoordination('instance-a', state);
    const lookupStarted = Effect.runSync(Deferred.make<void>());
    const releaseLookup = Effect.runSync(Deferred.make<void>());
    let gateCommandLookups = false;
    let commandLookupCount = 0;
    let capturedPresence: DaemonPresence | null = null;
    const coordination: RealtimeCoordinationService = {
      ...baseCoordination,
      getDaemonPresence(daemonId) {
        if (!gateCommandLookups) return baseCoordination.getDaemonPresence(daemonId);
        commandLookupCount += 1;
        const result = capturedPresence?.daemonId === daemonId ? capturedPresence : null;
        if (commandLookupCount !== 2) return Effect.succeed(result);
        return Deferred.succeed(lookupStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseLookup)),
          Effect.as(result),
        );
      },
    };
    const socket = new TestSocket();
    const service = createService(coordination, bus.redis);

    await register(service, socket);
    capturedPresence = requirePresence(state);
    gateCommandLookups = true;
    const delivery = Effect.runFork(
      service.startSession(createSessionStartInput(capturedPresence, 'session-local-shutdown')),
    );
    await Effect.runPromise(Deferred.await(lookupStarted));
    await Effect.runPromise(service.shutdown);
    await Effect.runPromise(Deferred.succeed(releaseLookup, undefined));

    await expect(Effect.runPromise(Fiber.join(delivery))).rejects.toMatchObject({
      _tag: 'DaemonUnavailable',
      reason: 'control_service_closed',
    } satisfies Partial<DaemonUnavailable>);
    expect(socket.messagesOfType('session_start')).toHaveLength(0);
  });

  test('enforces remote pending-command capacity across concurrent deliveries', async () => {
    const state = createCoordinationState();
    state.presence = remotePresence();
    const bus = createBrokerBus();
    const requester = createService(
      createFakeCoordination('instance-requester', state),
      bus.redis,
      {
        maxPendingRemoteCommands: 1,
      },
    );
    const presence = requirePresence(state);
    const first = Effect.runFork(
      requester.startSession(createSessionStartInput(presence, 'session-remote-first')),
    );
    try {
      await waitFor(() => bus.published.length === 1);
      await expect(
        Effect.runPromise(
          requester.startSession(createSessionStartInput(presence, 'session-remote-second')),
        ),
      ).rejects.toBeInstanceOf(ControlBackpressure);
      expect(bus.published).toHaveLength(1);
    } finally {
      await Effect.runPromise(Fiber.interrupt(first));
    }
  });

  test('shutdown completes an admitted remote command with control_service_closed', async () => {
    const state = createCoordinationState();
    state.presence = remotePresence();
    const bus = createBrokerBus();
    const requester = createService(createFakeCoordination('instance-requester', state), bus.redis);
    const delivery = Effect.runPromise(
      requester.startSession(
        createSessionStartInput(requirePresence(state), 'session-remote-service-shutdown'),
      ),
    );
    await waitFor(() => bus.published.length === 1);
    await Effect.runPromise(requester.shutdown);

    await expect(delivery).rejects.toMatchObject({
      _tag: 'DaemonUnavailable',
      reason: 'control_service_closed',
    } satisfies Partial<DaemonUnavailable>);
  });

  test('does not admit a remote command after shutdown wins an in-flight lookup', async () => {
    const state = createCoordinationState();
    state.presence = remotePresence();
    const bus = createBrokerBus();
    const lookupStarted = Effect.runSync(Deferred.make<void>());
    const releaseLookup = Effect.runSync(Deferred.make<void>());
    const capturedPresence = requirePresence(state);
    const baseCoordination = createFakeCoordination('instance-requester', state);
    const coordination: RealtimeCoordinationService = {
      ...baseCoordination,
      getDaemonPresence: (daemonId) =>
        Deferred.succeed(lookupStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseLookup)),
          Effect.as(capturedPresence.daemonId === daemonId ? capturedPresence : null),
        ),
    };
    const requester = createService(coordination, bus.redis);
    const delivery = Effect.runFork(
      requester.startSession(createSessionStartInput(capturedPresence, 'session-remote-shutdown')),
    );

    await Effect.runPromise(Deferred.await(lookupStarted));
    await Effect.runPromise(requester.shutdown);
    await Effect.runPromise(Deferred.succeed(releaseLookup, undefined));

    await expect(Effect.runPromise(Fiber.join(delivery))).rejects.toMatchObject({
      _tag: 'DaemonUnavailable',
      reason: 'control_service_closed',
    } satisfies Partial<DaemonUnavailable>);
    expect(bus.published).toHaveLength(0);
  });

  test('releases local command capacity when a delivery fiber is interrupted', async () => {
    const state = createCoordinationState();
    const bus = createBrokerBus();
    const coordination = createFakeCoordination('instance-a', state);
    const socket = new TestSocket();
    const service = createService(coordination, bus.redis, {
      maxPendingCommandsPerConnection: 1,
    });

    await register(service, socket);
    const input = {
      presence: requirePresence(state),
      sessionId: 'session-interrupted',
      browserNodeId: 'browser-1',
      offer: SESSION_OFFER,
    } as const;
    const interrupted = Effect.runFork(service.startSession(input));
    await waitFor(() => socket.messagesOfType('session_start').length === 1);
    await Effect.runPromise(Fiber.interrupt(interrupted));

    const replacement = Effect.runPromise(
      service.startSession({ ...input, sessionId: 'session-replacement' }),
    );
    await waitFor(() => socket.messagesOfType('session_start').length === 2);
    const command = required(socket.messagesOfType('session_start').at(-1));
    await Effect.runPromise(
      service.receive(
        input.presence.connectionId,
        encodeDaemonControlMessage(
          createDaemonControlCommandAckMessage(command.commandId, {
            status: 'accepted',
          }),
        ),
      ),
    );
    await expect(replacement).resolves.toBeUndefined();
  });

  test('releases remote command capacity when a delivery fiber is interrupted', async () => {
    const state = createCoordinationState();
    state.presence = {
      daemonId: DAEMON_ID,
      userId: USER_ID,
      ownerInstanceId: 'instance-owner',
      connectionId: 'connection-owner',
      presenceId: 'presence-owner',
      claimSeq: 1,
      state: 'online',
      updatedAt: 1,
      zone: null,
    };
    const bus = createBrokerBus();
    const requester = createService(
      createFakeCoordination('instance-requester', state),
      bus.redis,
      {
        maxPendingRemoteCommands: 1,
      },
    );
    const input = {
      presence: requirePresence(state),
      sessionId: 'session-remote-interrupted',
      browserNodeId: 'browser-1',
      offer: SESSION_OFFER,
    } as const;

    const interrupted = Effect.runFork(requester.startSession(input));
    await waitFor(() => bus.published.length === 1);
    await Effect.runPromise(Fiber.interrupt(interrupted));

    const replacement = Effect.runFork(
      requester.startSession({ ...input, sessionId: 'session-remote-replacement' }),
    );
    await waitFor(() => bus.published.length === 2);
    await Effect.runPromise(Fiber.interrupt(replacement));
  });
});

interface CoordinationState {
  presence: DaemonPresence | null;
  nextClaimSeq: number;
  /** Every `renewDaemonLeases` batch, by lease identity. */
  readonly renewals: Array<Array<{ daemonId: string; presenceId: string }>>;
  /** Every committed silence swap, in order. */
  readonly silenceTransitions: Array<'silent' | 'online'>;
}

function createCoordinationState(): CoordinationState {
  return {
    presence: null,
    nextClaimSeq: 1,
    renewals: [],
    silenceTransitions: [],
  };
}

function swapFakeSilence(
  state: CoordinationState,
  instanceId: string,
  input: DaemonCarrierIdentity,
  target: 'silent' | 'online',
): Effect.Effect<DaemonSilenceTransition, RedisError> {
  return Effect.sync(() => {
    const current = state.presence;
    if (
      current === null ||
      current.ownerInstanceId !== instanceId ||
      current.daemonId !== input.daemonId ||
      current.userId !== input.userId ||
      current.presenceId !== input.presenceId ||
      current.claimSeq !== input.claimSeq ||
      current.connectionId !== input.connectionId ||
      current.state === 'suspended'
    ) {
      return 'not-current';
    }
    if (current.state === target) return 'already';
    state.presence = { ...current, state: target };
    state.silenceTransitions.push(target);
    return 'changed';
  });
}

function createFakeCoordination(
  instanceId: string,
  state: CoordinationState,
): RealtimeCoordinationService {
  return {
    instanceId,
    healthSnapshot: () =>
      Effect.succeed({
        presenceExpirySchedulerHealthy: true,
      }),
    awaitCriticalFailure: Effect.never,
    claimDaemonOnline: (input) =>
      Effect.sync(() => {
        const claimSeq = state.nextClaimSeq++;
        state.presence = {
          ...input,
          ownerInstanceId: instanceId,
          claimSeq,
          state: 'online',
          updatedAt: Date.now(),
        };
        return { _tag: 'Claimed' as const, claimSeq };
      }),
    renewDaemonLeases: (inputs) =>
      Effect.sync(() => {
        state.renewals.push(
          inputs.map((input) => ({ daemonId: input.daemonId, presenceId: input.presenceId })),
        );
        return inputs.map((input) => ({
          presence:
            state.presence !== null &&
            state.presence.ownerInstanceId === instanceId &&
            state.presence.daemonId === input.daemonId &&
            state.presence.userId === input.userId &&
            state.presence.presenceId === input.presenceId &&
            state.presence.claimSeq === input.claimSeq
              ? ('refreshed' as const)
              : ('not-owner' as const),
          revocationGeneration: 7,
        }));
      }),
    markDaemonSilent: (input) => swapFakeSilence(state, instanceId, input, 'silent'),
    clearDaemonSilent: (input) => swapFakeSilence(state, instanceId, input, 'online'),
    resumeDaemonPresence: (input) =>
      Effect.sync(() => {
        const current = state.presence;
        if (
          current === null ||
          current.daemonId !== input.daemonId ||
          current.userId !== input.userId ||
          current.presenceId !== input.presenceId ||
          current.state !== 'suspended'
        ) {
          return null;
        }
        // Ownership and carrier move; the lease identity does not.
        state.presence = {
          ...current,
          ownerInstanceId: instanceId,
          connectionId: input.connectionId,
          state: 'online',
        };
        return current.claimSeq;
      }),
    suspendDaemonPresence: (input) =>
      Effect.sync(() => {
        const current = state.presence;
        if (
          current === null ||
          current.ownerInstanceId !== instanceId ||
          current.daemonId !== input.daemonId ||
          current.userId !== input.userId ||
          current.presenceId !== input.presenceId ||
          current.claimSeq !== input.claimSeq ||
          current.state === 'suspended'
        ) {
          return false;
        }
        // The lease stays, only its disposition changes — mirroring the CAS in
        // the real script, which never removes the claim.
        state.presence = { ...current, state: 'suspended' };
        return true;
      }),
    unmarkDaemonOnline: (input) =>
      Effect.sync(() => {
        const matches =
          state.presence !== null &&
          state.presence.ownerInstanceId === instanceId &&
          state.presence.daemonId === input.daemonId &&
          state.presence.userId === input.userId &&
          state.presence.presenceId === input.presenceId &&
          state.presence.claimSeq === input.claimSeq;
        if (matches) state.presence = null;
        return matches;
      }),
    getDaemonPresence: (daemonId) =>
      Effect.succeed(state.presence?.daemonId === daemonId ? state.presence : null),
    getUserDaemonPresence: (userId) =>
      Effect.succeed(state.presence?.userId === userId ? [state.presence] : []),
    publishDeviceDelta: () => Effect.void,
    readDeviceEventsCursor: () => Effect.succeed({ epoch: 'feedfacefeedface', seq: 0 }),
    subscribeDeviceEvents: () => Effect.succeed(Effect.void),
    incrementRevocationGeneration: () => Effect.succeed(1),
    createSessionForDaemonPresence: () => Effect.succeed(state.presence),
    removeSessionForUser: () => Effect.void,
    removeDaemonSessions: () => Effect.void,
  };
}

/**
 * Only the fields the daemon-control layer actually reads. The STUN key is a
 * fixed pattern rather than random so a failure is reproducible.
 */
/** A fixed, well-formed edge attach ticket (35 base64url characters). */
const EDGE_TICKET = 'A'.repeat(35);
/** The registry every test service states. */
const EDGES = [
  {
    edgeWtUrl: 'https://edge.test:4433/',
    certHashes: [Buffer.alloc(32, 1).toString('base64'), Buffer.alloc(32, 2).toString('base64')],
  },
];
const TEST_EDGE_REGISTRY: EdgeRegistryService = {
  claimRegistrationNonce: () => Effect.void,
  registerEdge: () => Effect.void,
  listHealthyEdges: () =>
    Effect.succeed(
      EDGES.map((edge) => ({
        ...edge,
        edgeId: 'edge-1',
        edgeRegion: 'test',
        activeCertHash: edge.certHashes[0] ?? '',
        updatedAt: 1,
      })),
    ),
};

const TEST_SERVER_CONFIG = {
  stunTicketKey: new Uint8Array(64).fill(9),
  edgeAttachTicketKey: new Uint8Array(64).fill(11),
  stunServers: ['stun.test:3478', 'stun.test:3479'],
} as unknown as ServerConfig;

function createService(
  coordination: RealtimeCoordinationService,
  redis: RedisService,
  overrides: Partial<
    Pick<
      DaemonControlServiceDependencies,
      | 'now'
      | 'commandTimeoutMs'
      | 'maxPendingCommandsPerConnection'
      | 'maxPendingRemoteCommands'
      | 'monotonicNow'
      | 'touchDaemon'
      | 'touchDaemonsSeen'
      | 'revocationOutbox'
      | 'edges'
    >
  > = {},
) {
  return createDaemonControlService({
    coordination,
    redis,
    touchDaemon: () => Effect.void,
    touchDaemonsSeen: () => Effect.void,
    logger: NOOP_LOGGER,
    // A fixed issuer, so the `registered` and `lease` assertions can compare
    // exact frames instead of matching around a random ticket.
    stun: {
      serversFor: () => ['stun.test:3478', 'stun.test:3479'],
      issue: () => ({ ticket: 'ticket', secret: 'secret', lifetimeMs: 4_000 }),
    },
    edgeAttach: {
      forDaemon: () => EDGE_TICKET,
      forBrowser: () => EDGE_TICKET,
    },
    edges: Effect.succeed(EDGES),
    ...overrides,
  });
}

function authorizationBytes(length: number, fill: number): string {
  return Buffer.alloc(length, fill).toString('base64url');
}

async function register(
  service: ReturnType<typeof createDaemonControlService>,
  socket: DaemonControlSocket,
  connectionId = 'connection-1',
  presenceId = 'presence-1',
): Promise<void> {
  await registerHandle(service, socket, connectionId, presenceId);
}

function registerHandle(
  service: ReturnType<typeof createDaemonControlService>,
  socket: DaemonControlSocket,
  connectionId = 'connection-1',
  presenceId = 'presence-1',
): Promise<ControlConnectionHandle> {
  return Effect.runPromise(
    service.acceptConnection({
      daemonId: DAEMON_ID,
      userId: USER_ID,
      boxId: null,
      daemonVersion: '4.0.0',
      connectionId,
      presenceId,
      socket,
      zone: null,
    }),
  );
}

function requirePresence(state: CoordinationState): DaemonPresence {
  if (state.presence === null) throw new Error('expected daemon presence');
  return state.presence;
}

function remotePresence(): DaemonPresence {
  return {
    daemonId: DAEMON_ID,
    userId: USER_ID,
    ownerInstanceId: 'instance-owner',
    connectionId: 'connection-owner',
    presenceId: 'presence-owner',
    claimSeq: 1,
    state: 'online',
    updatedAt: 1,
    zone: null,
  };
}

function createSessionStartInput(presence: DaemonPresence, sessionId: string) {
  return {
    presence,
    sessionId,
    browserNodeId: 'browser-1',
    offer: SESSION_OFFER,
  } as const;
}

class TestSocket implements DaemonControlSocket {
  readonly frames: string[] = [];
  readonly closed: Array<{ readonly code: number; readonly reason: string }> = [];

  constructor(private readonly sendStatuses: number[] = []) {}

  sendText(payload: string): number {
    this.frames.push(payload);
    return this.sendStatuses.shift() ?? new TextEncoder().encode(payload).byteLength;
  }

  close(code: number, reason: string): void {
    this.closed.push({ code, reason });
  }

  messagesOfType<T extends DaemonControlServerMessage['type']>(
    type: T,
  ): Array<Extract<DaemonControlServerMessage, { readonly type: T }>> {
    return this.frames
      .map((frame) => parseDaemonControlServerMessage(frame))
      .filter(
        (message): message is Extract<DaemonControlServerMessage, { readonly type: T }> =>
          message?.type === type,
      );
  }
}

async function waitForMessage<T extends DaemonControlServerMessage['type']>(
  socket: TestSocket,
  type: T,
): Promise<Extract<DaemonControlServerMessage, { readonly type: T }>> {
  for (let attempt = 0; attempt < 1_000; attempt++) {
    const message = socket.messagesOfType(type).at(-1);
    if (message !== undefined) return message;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`timed out waiting for ${type}`);
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('timed out waiting for condition');
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('expected value');
  return value;
}

interface BrokerBus {
  readonly redis: RedisService;
  readonly publishedChannels: string[];
  readonly published: ReadonlyArray<{
    readonly channel: string;
    readonly message: string;
  }>;
  register(instanceId: string, listener: (frame: string) => Promise<void>): void;
}

function createBrokerBus(): BrokerBus {
  const listeners = new Map<string, Set<(frame: string) => Promise<void>>>();
  const publishedChannels: string[] = [];
  const published: Array<{ readonly channel: string; readonly message: string }> = [];
  const redis: RedisService = {
    useCommands<T>(): Effect.Effect<T, RedisError> {
      return Effect.die(new Error('unexpected Redis command call'));
    },
    publish: (channel, message) =>
      Effect.tryPromise({
        try: async () => {
          publishedChannels.push(channel);
          published.push({ channel, message });
          await Promise.all(
            [...(listeners.get(channel) ?? [])].map((listener) => listener(message)),
          );
        },
        catch: (cause) =>
          new RedisError({
            cause,
            message: 'fake Redis publish failed',
          }),
      }),
    subscribe: () => Effect.die(new Error('unexpected Redis subscribe call')),
    unsubscribe: () => Effect.die(new Error('unexpected Redis unsubscribe call')),
    healthSnapshot: () =>
      Effect.succeed({
        commandsReady: true,
        publisherReady: true,
        subscriberReady: true,
      }),
  };

  return {
    redis,
    publishedChannels,
    published,
    register(instanceId, listener) {
      const channel = `merkur:daemon-control:instance:${instanceId}`;
      const channelListeners = listeners.get(channel) ?? new Set();
      channelListeners.add(listener);
      listeners.set(channel, channelListeners);
    },
  };
}

const NOOP_LOGGER: Logger = {
  info() {},
  warn() {},
  error() {},
};

function testDatabaseLayer() {
  return Layer.effect(
    DatabaseService,
    Effect.acquireRelease(
      Effect.promise(() => createMigratedKyselyDatabase<DatabaseSchema>(':memory:')),
      (database) => Effect.promise(() => database.destroy()),
    ),
  );
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
