import { describe, expect, test } from 'bun:test';
import { verifySessionAuthorizationToken } from '@merkur/auth';
import { Deferred, Effect, Layer } from 'effect';

import { type ServerConfig, ServerConfigService } from '../../config';
import { createLogger } from '../../logger';
import type { runServerProgram } from '../../runtime';
import {
  type DaemonControlService,
  DaemonControlServiceTag,
} from '../../services/daemon-control-service';
import { type DeviceService, DeviceServiceTag } from '../../services/device-service';
import {
  type EdgeRegistration,
  type EdgeRegistryService,
  EdgeRegistryServiceTag,
} from '../../services/edge-registry-service';
import {
  type DaemonPresence,
  type RealtimeCoordinationService,
  RealtimeCoordinationServiceTag,
} from '../../services/realtime-coordination-service';
import type { RedisError } from '../../services/redis-service';
import { SessionIssuanceConflictError } from '../../services/session-issuance-contract';
import {
  type SessionIssuanceService,
  SessionIssuanceServiceTag,
} from '../../services/session-issuance-service';
import { SessionServiceLive } from '../../services/session-service';
import {
  CLIENT_NONCE,
  createFakeConfig,
  createFakeControl,
  createFakeCoordination,
  createFakeDeviceService,
  createFakeEdgeRegistry,
  createFakeSessionIssuanceService,
  DAEMON_IDENTITY_KEY_COMMITMENT,
  DAEMON_IDENTITY_PUBLIC_KEY,
  DEFAULT_DAEMON_PRESENCE,
  ENCAPSULATION_KEY,
  PREVIOUS_SESSION_REQUEST_COMMITMENT,
  SESSION_REQUEST_COMMITMENT,
  type SentDaemonMessage,
  TEST_DELEGATION_ID,
  TEST_USER_ID,
  VALID_CERT_HASH,
  VERIFY_KEY,
} from '../../services/session-test-fixture';
import { sessionRoutesPlugin } from './session-routes';

// A test runServerProgram that provides exactly the services the session routes
// use, mirroring the real signature so the plugin type-checks.
function makeRunServerProgram(
  config: ServerConfig,
  coordination: RealtimeCoordinationService,
  edgeRegistry: EdgeRegistryService,
  control: DaemonControlService,
  issuance: SessionIssuanceService,
  deviceService: DeviceService,
): typeof runServerProgram {
  const dependencies = Layer.mergeAll(
    Layer.succeed(ServerConfigService, config),
    Layer.succeed(RealtimeCoordinationServiceTag, coordination),
    Layer.succeed(EdgeRegistryServiceTag, edgeRegistry),
    Layer.succeed(DaemonControlServiceTag, control),
    Layer.succeed(DeviceServiceTag, deviceService),
    Layer.succeed(SessionIssuanceServiceTag, issuance),
  );
  const layer = SessionServiceLive.pipe(Layer.provideMerge(dependencies));
  return ((program) =>
    Effect.runPromise(
      Effect.provide(program as Effect.Effect<unknown, unknown, never>, layer),
    )) as typeof runServerProgram;
}

function buildApp(input: {
  readonly config: ServerConfig;
  readonly coordination: RealtimeCoordinationService;
  readonly sentDaemonMessages?: SentDaemonMessage[];
  readonly edgeRegistrations?: readonly EdgeRegistration[];
  readonly edgeRegistryFailure?: boolean;
  readonly listHealthyEdges?: () => Effect.Effect<EdgeRegistration[], RedisError>;
  readonly deliveryFailure?: boolean;
  readonly sessionIssuance?: SessionIssuanceService;
  readonly daemonIdentityPublicKey?: string | null;
}) {
  return sessionRoutesPlugin({
    runServerProgram: makeRunServerProgram(
      input.config,
      input.coordination,
      createFakeEdgeRegistry(input),
      createFakeControl(
        input.sentDaemonMessages ?? [],
        input.deliveryFailure ?? false,
        input.coordination,
      ),
      input.sessionIssuance ?? createFakeSessionIssuanceService(),
      createFakeDeviceService(
        input.daemonIdentityPublicKey === undefined
          ? DAEMON_IDENTITY_PUBLIC_KEY
          : input.daemonIdentityPublicKey,
      ),
    ),
    authorizeRequest: () =>
      Promise.resolve({
        userId: TEST_USER_ID,
        delegationId: TEST_DELEGATION_ID,
        delegationExpiresAt: Date.now() + 60_000,
      }),
    logger: createLogger('test'),
    trustedProxyHops: 1,
  });
}

function requestSession(
  app: ReturnType<typeof buildApp>,
  body: {
    readonly daemonId: string;
    readonly browserNodeId: string;
    readonly delegationId?: string;
    readonly issuanceId: string;
    readonly supersedesIssuanceId?: string;
  } = {
    daemonId: 'daemon-1',
    browserNodeId: 'browser-1',
    issuanceId: 'issuance-1',
  },
  headers: Readonly<Record<string, string>> = {},
): Promise<Response> {
  return app.handle(
    new Request('https://merkur.example/api/sessions/request', {
      method: 'POST',
      headers: {
        authorization: 'Bearer test',
        'content-type': 'application/json',
        ...headers,
      },
      body: JSON.stringify({
        delegationId: body.delegationId ?? TEST_DELEGATION_ID,
        clientNonce: CLIENT_NONCE,
        encapsulationKey: ENCAPSULATION_KEY,
        ...body,
      }),
    }),
  );
}

describe('session-routes /sessions/request edge fields', () => {
  test('returns exact current edge coordinates', async () => {
    const app = buildApp({
      config: createFakeConfig(),
      coordination: createFakeCoordination({}),
    });

    const response = await requestSession(app);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;

    expect(body.daemonId).toBe('daemon-1');
    expect(body.daemonIdentityPublicKey).toBe(DAEMON_IDENTITY_PUBLIC_KEY);
    expect(body.sessionTokenExpiresInMs).toBeGreaterThan(0);
    expect(body.sessionTokenExpiresInMs).toBeLessThanOrEqual(60_000);
    expect(body.edgeWtUrl).toBe('https://edge.example:4433');
    expect(body.edgeCertHashes).toEqual([VALID_CERT_HASH]);
    // The browser's address reaches the daemon only as the edge validated it on
    // the signaling carrier; neither the response nor the capability names one.
    expect(Object.hasOwn(body, 'browserIp')).toBe(false);
    const [payloadSegment] = String(body.sessionToken).split('.');
    expect(
      Object.keys(JSON.parse(Buffer.from(payloadSegment ?? '', 'base64url').toString('utf8'))),
    ).toEqual(['u', 'g', 'b', 'd', 's', 'k', 'q', 'iat', 'e']);
    expect(response.headers.get('server-timing')).toMatch(
      /^session;dur=\d+\.\d{2}, issuance;dur=\d+\.\d{2}, prepare;dur=\d+\.\d{2}, presence;dur=\d+\.\d{2}, edge;dur=\d+\.\d{2}, delivery;dur=\d+\.\d{2}$/,
    );
  });

  test('pushes a session_start control message to the owning daemon', async () => {
    const sentDaemonMessages: SentDaemonMessage[] = [];
    const app = buildApp({
      config: createFakeConfig(),
      coordination: createFakeCoordination({}),
      sentDaemonMessages,
    });

    const response = await requestSession(app);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;

    const sessionToken = body.sessionToken;
    const expiresAtMs = body.sessionTokenExpiresAtMs;
    expect(typeof sessionToken).toBe('string');
    expect(typeof expiresAtMs).toBe('number');
    expect(
      verifySessionAuthorizationToken(
        sessionToken as string,
        VERIFY_KEY,
        (expiresAtMs as number) - 1,
      ),
    ).toMatchObject({
      u: TEST_USER_ID,
      b: 'browser-1',
      d: 'daemon-1',
      s: body.sessionId,
      k: DAEMON_IDENTITY_KEY_COMMITMENT,
      q: SESSION_REQUEST_COMMITMENT,
      e: expiresAtMs,
    });

    expect(sentDaemonMessages).toHaveLength(1);
    const pushed = sentDaemonMessages[0];
    expect(pushed?.connectionId).toBe('connection-1');
    const message = JSON.parse(pushed?.payload ?? '{}') as Record<string, unknown>;
    expect(message.type).toBe('session_start');
    expect(message.version).toBe(1);
    expect(message.commandId).toBe('command-1');
    expect(message.sessionId).toBe(body.sessionId);
    expect(message.browserNodeId).toBe('browser-1');
    expect(message.offer).toEqual({
      userId: TEST_USER_ID,
      delegationId: TEST_DELEGATION_ID,
      edgeWtUrl: 'https://edge.example:4433',
      edgeCertHashes: [VALID_CERT_HASH],
      clientNonce: CLIENT_NONCE,
      encapsulationKey: ENCAPSULATION_KEY,
    });
  });

  test('returns 503 when session_start cannot be delivered to the daemon', async () => {
    const removedSessionIds: string[] = [];
    const app = buildApp({
      config: createFakeConfig(),
      coordination: createFakeCoordination({ removedSessionIds }),
      deliveryFailure: true,
    });

    const response = await requestSession(app);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'failed to deliver session to daemon' });
    expect(response.headers.get('server-timing')).toMatch(
      /^session;dur=\d+\.\d{2}, prepare;dur=\d+\.\d{2}, presence;dur=\d+\.\d{2}, edge;dur=\d+\.\d{2}$/,
    );
    // Delivery can have succeeded remotely even when its acknowledgement is
    // lost. The durable prepared issuance and its exact claim must survive so
    // the same issuance id can redeliver the same session on demand.
    expect(removedSessionIds).toHaveLength(0);
  });

  test('selects one healthy replica and pushes identical coordinates to the daemon', async () => {
    const iadHash = Buffer.alloc(32, 3).toString('base64');
    const oldIadHash = Buffer.alloc(32, 4).toString('base64');
    const fraHash = Buffer.alloc(32, 5).toString('base64');
    const sentDaemonMessages: SentDaemonMessage[] = [];
    const app = buildApp({
      config: createFakeConfig(),
      coordination: createFakeCoordination({}),
      edgeRegistrations: [
        {
          edgeId: 'iad-1',
          edgeRegion: 'iad',
          edgeWtUrl: 'https://iad-1.edge.example:4433',
          activeCertHash: iadHash,
          certHashes: [iadHash, oldIadHash],
          updatedAt: Date.now(),
        },
        {
          edgeId: 'fra-1',
          edgeRegion: 'fra',
          edgeWtUrl: 'https://fra-1.edge.example:4433',
          activeCertHash: fraHash,
          certHashes: [fraHash],
          updatedAt: Date.now(),
        },
      ],
      sentDaemonMessages,
    });

    const response = await requestSession(app);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(typeof body.edgeWtUrl).toBe('string');
    const pushed = JSON.parse(sentDaemonMessages[0]?.payload ?? '{}') as Record<string, unknown>;
    expect(pushed.offer).toEqual({
      userId: TEST_USER_ID,
      delegationId: TEST_DELEGATION_ID,
      edgeWtUrl: body.edgeWtUrl,
      edgeCertHashes: body.edgeCertHashes,
      clientNonce: CLIENT_NONCE,
      encapsulationKey: ENCAPSULATION_KEY,
    });
    expect(['https://iad-1.edge.example:4433', 'https://fra-1.edge.example:4433']).toContain(
      String(body.edgeWtUrl),
    );
  });

  test('starts healthy-edge discovery while the authoritative presence claim is in flight', async () => {
    const edgeLookupStarted = Effect.runSync(Deferred.make<void>());
    const edge: EdgeRegistration = {
      edgeId: 'fra-1',
      edgeRegion: 'fra',
      edgeWtUrl: 'https://fra-1.edge.example:4433',
      activeCertHash: VALID_CERT_HASH,
      certHashes: [VALID_CERT_HASH],
      updatedAt: Date.now(),
    };
    const app = buildApp({
      config: createFakeConfig(),
      coordination: createFakeCoordination({
        createSession: () =>
          Deferred.await(edgeLookupStarted).pipe(Effect.as(DEFAULT_DAEMON_PRESENCE)),
      }),
      listHealthyEdges: () =>
        Deferred.succeed(edgeLookupStarted, undefined).pipe(Effect.as([edge])),
    });

    const response = await requestSession(app);

    expect(response.status).toBe(200);
    expect((await response.json()) as Record<string, unknown>).toMatchObject({
      edgeWtUrl: edge.edgeWtUrl,
      edgeCertHashes: edge.certHashes,
    });
    expect(response.headers.get('server-timing')).toContain('edge;dur=');
  });

  test('does not expose detailed timing before same-user presence is established', async () => {
    let edgeLookupCalls = 0;
    const app = buildApp({
      config: createFakeConfig(),
      coordination: createFakeCoordination({
        createSession: () => Effect.succeed(null),
      }),
      listHealthyEdges: () =>
        Effect.sync(() => {
          edgeLookupCalls++;
          return [];
        }),
    });

    const response = await requestSession(app);

    expect(response.status).toBe(400);
    expect(edgeLookupCalls).toBe(0);
    expect(response.headers.get('server-timing')).toMatch(/^session;dur=\d+\.\d{2}$/);
  });

  test('cancels an unfinished edge lookup when authoritative presence is absent', async () => {
    const edgeLookupStarted = Effect.runSync(Deferred.make<void>());
    const edgeLookupCancelled = Effect.runSync(Deferred.make<void>());
    const app = buildApp({
      config: createFakeConfig(),
      coordination: createFakeCoordination({
        createSession: () => Deferred.await(edgeLookupStarted).pipe(Effect.as(null)),
      }),
      listHealthyEdges: () =>
        Deferred.succeed(edgeLookupStarted, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Deferred.succeed(edgeLookupCancelled, undefined)),
        ),
    });

    const response = await requestSession(app);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'daemon not connected' });
    expect(response.headers.get('server-timing')).toMatch(/^session;dur=\d+\.\d{2}$/);
    await Effect.runPromise(Deferred.await(edgeLookupCancelled));
  });

  test('does not retire a predecessor for an unowned successor daemon identity', async () => {
    let supersedeCalls = 0;
    const sessionIssuance: SessionIssuanceService = {
      ...createFakeSessionIssuanceService(),
      supersede: () => {
        supersedeCalls += 1;
        return Effect.succeed({ _tag: 'Missing' as const });
      },
    };
    const app = buildApp({
      config: createFakeConfig(),
      coordination: createFakeCoordination({}),
      daemonIdentityPublicKey: null,
      sessionIssuance,
    });

    const response = await requestSession(app, {
      daemonId: 'daemon-1',
      browserNodeId: 'browser-1',
      issuanceId: 'issuance-new',
      supersedesIssuanceId: 'issuance-old',
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'daemon not connected' });
    expect(supersedeCalls).toBe(0);
  });

  test('returns 503 when no edge is registered', async () => {
    const removedSessionIds: string[] = [];
    const app = buildApp({
      config: createFakeConfig(),
      coordination: createFakeCoordination({ removedSessionIds }),
      edgeRegistrations: [],
    });

    const response = await requestSession(app);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'edge temporarily unavailable' });
    expect(removedSessionIds).toHaveLength(1);
  });

  test('returns 503 when Redis session coordination is unavailable', async () => {
    const app = buildApp({
      config: createFakeConfig(),
      coordination: createFakeCoordination({}),
      edgeRegistryFailure: true,
    });

    const response = await requestSession(app);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'session coordination unavailable' });
    expect(response.headers.get('server-timing')).toMatch(
      /^session;dur=\d+\.\d{2}, presence;dur=\d+\.\d{2}$/,
    );
  });

  test('cancels the exact durable issuance only after session_cancel delivery is acknowledged', async () => {
    const removedSessionIds: string[] = [];
    const sentDaemonMessages: SentDaemonMessage[] = [];
    const sessionIssuance: SessionIssuanceService = {
      ...createFakeSessionIssuanceService(),
      cancel: (userId, issuanceId) => {
        expect(userId).toBe(TEST_USER_ID);
        expect(issuanceId).toBe('issuance-old');
        return Effect.succeed({
          _tag: 'Cancelled' as const,
          sessionId: 'session-old',
          daemonId: 'daemon-1',
          browserNodeId: 'browser-old',
          sessionRequestCommitment: PREVIOUS_SESSION_REQUEST_COMMITMENT,
        });
      },
    };
    const app = buildApp({
      config: createFakeConfig(),
      coordination: createFakeCoordination({
        removedSessionIds,
        presence: {
          daemonId: 'daemon-1',
          userId: TEST_USER_ID,
          connectionId: 'connection-1',
          ownerInstanceId: 'instance-test',
          presenceId: 'presence-1',
          claimSeq: 1,
          state: 'online',
          updatedAt: Date.now(),
          zone: null,
        },
      }),
      sentDaemonMessages,
      sessionIssuance,
    });

    const response = await app.handle(
      new Request('https://merkur.example/api/sessions/request/cancel', {
        method: 'POST',
        headers: {
          authorization: 'Bearer test',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ issuanceId: 'issuance-old' }),
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(removedSessionIds).toEqual(['session-old']);
    expect(sentDaemonMessages).toHaveLength(1);
    expect(JSON.parse(sentDaemonMessages[0]?.payload ?? '{}')).toEqual({
      type: 'session_cancel',
      version: 1,
      commandId: 'command-1',
      sessionId: 'session-old',
      browserNodeId: 'browser-old',
      // Empty because these tests run with no tracer, which is the honest
      // encoding of "the sender had no active span" — never an absent key,
      // which the daemon's exact-key validation would reject outright.
      traceparent: '',
    });
  });

  test('retains a cancellation while presence is absent and replays its exact tuple on recovery', async () => {
    const sentDaemonMessages: SentDaemonMessage[] = [];
    const coordinationState: { presence: DaemonPresence | null } = { presence: null };
    const sessionIssuance: SessionIssuanceService = {
      ...createFakeSessionIssuanceService(),
      cancel: () =>
        Effect.succeed({
          _tag: 'Cancelled' as const,
          sessionId: 'session-replay',
          daemonId: 'daemon-1',
          browserNodeId: 'browser-replay',
          sessionRequestCommitment: PREVIOUS_SESSION_REQUEST_COMMITMENT,
        }),
    };
    const app = buildApp({
      config: createFakeConfig(),
      coordination: createFakeCoordination(coordinationState),
      sentDaemonMessages,
      sessionIssuance,
    });
    const requestCancel = () =>
      app.handle(
        new Request('https://merkur.example/api/sessions/request/cancel', {
          method: 'POST',
          headers: {
            authorization: 'Bearer test',
            'content-type': 'application/json',
          },
          body: JSON.stringify({ issuanceId: 'issuance-replay' }),
        }),
      );

    const unavailable = await requestCancel();
    expect(unavailable.status).toBe(503);
    expect(sentDaemonMessages).toHaveLength(0);

    coordinationState.presence = {
      daemonId: 'daemon-1',
      userId: TEST_USER_ID,
      connectionId: 'connection-1',
      ownerInstanceId: 'instance-test',
      presenceId: 'presence-1',
      claimSeq: 1,
      state: 'online',
      updatedAt: Date.now(),
      zone: null,
    };
    const recovered = await requestCancel();
    expect(recovered.status).toBe(200);
    expect(sentDaemonMessages).toHaveLength(1);
    expect(JSON.parse(sentDaemonMessages[0]?.payload ?? '{}')).toEqual({
      type: 'session_cancel',
      version: 1,
      commandId: 'command-1',
      sessionId: 'session-replay',
      browserNodeId: 'browser-replay',
      traceparent: '',
    });
  });

  test('durably cancels a predecessor before issuing its replacement', async () => {
    const events: string[] = [];
    const removedSessionIds: string[] = [];
    const sentDaemonMessages: SentDaemonMessage[] = [];
    const baseIssuance = createFakeSessionIssuanceService();
    const sessionIssuance: SessionIssuanceService = {
      ...baseIssuance,
      issue(input, callbacks) {
        events.push(`issue:${input.issuanceId}`);
        return baseIssuance.issue(input, callbacks);
      },
      supersede: (input) => {
        events.push(`supersede:${input.predecessorIssuanceId}`);
        return Effect.succeed({
          _tag: 'Cancelled' as const,
          sessionId: 'session-old',
          daemonId: 'daemon-1',
          browserNodeId: 'browser-new',
          sessionRequestCommitment: PREVIOUS_SESSION_REQUEST_COMMITMENT,
        });
      },
    };
    const app = buildApp({
      config: createFakeConfig(),
      coordination: createFakeCoordination({
        removedSessionIds,
        presence: {
          daemonId: 'daemon-1',
          userId: TEST_USER_ID,
          connectionId: 'connection-1',
          ownerInstanceId: 'instance-test',
          presenceId: 'presence-1',
          claimSeq: 1,
          state: 'online',
          updatedAt: Date.now(),
          zone: null,
        },
      }),
      sentDaemonMessages,
      sessionIssuance,
    });

    const response = await requestSession(app, {
      daemonId: 'daemon-1',
      browserNodeId: 'browser-new',
      issuanceId: 'issuance-new',
      supersedesIssuanceId: 'issuance-old',
    });
    await Bun.sleep(0);

    expect(response.status).toBe(200);
    expect(events).toEqual(['supersede:issuance-old', 'issue:issuance-new']);
    expect(removedSessionIds).toEqual(['session-old']);
    expect(
      sentDaemonMessages
        .map((message) => JSON.parse(message.payload) as { type?: string })
        .map((message) => message.type)
        .sort(),
    ).toEqual(['session_cancel', 'session_start']);
  });

  test('rejects capability refresh that reuses the predecessor browser bootstrap', async () => {
    let issueCalls = 0;
    const removedSessionIds: string[] = [];
    const sentDaemonMessages: SentDaemonMessage[] = [];
    const sessionIssuance: SessionIssuanceService = {
      ...createFakeSessionIssuanceService(),
      issue: () => {
        issueCalls += 1;
        return Effect.die(new Error('unsafe replacement must not be issued'));
      },
      supersede: (input) =>
        Effect.fail(new SessionIssuanceConflictError({ issuanceId: input.successorIssuanceId })),
    };
    const app = buildApp({
      config: createFakeConfig(),
      coordination: createFakeCoordination({ removedSessionIds }),
      sentDaemonMessages,
      sessionIssuance,
    });

    const response = await requestSession(app, {
      daemonId: 'daemon-1',
      browserNodeId: 'browser-1',
      issuanceId: 'issuance-new',
      supersedesIssuanceId: 'issuance-old',
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'session_issuance_conflict' });
    expect(issueCalls).toBe(0);
    expect(removedSessionIds).toEqual([]);
    expect(sentDaemonMessages).toEqual([]);
  });
});

describe('session authorization renewal', () => {
  test('signs for the existing identity and restates its edge, without issuance, edge allocation, or control commands', async () => {
    const sent: SentDaemonMessage[] = [];
    const config = createFakeConfig();
    let allocations = 0;
    const edge: EdgeRegistration = {
      edgeId: 'iad-1',
      edgeRegion: 'iad',
      edgeWtUrl: 'https://iad-1.edge.example:4433/',
      activeCertHash: VALID_CERT_HASH,
      certHashes: [VALID_CERT_HASH, Buffer.alloc(32, 92).toString('base64')],
      updatedAt: Date.now(),
    };
    const app = buildApp({
      config,
      sentDaemonMessages: sent,
      coordination: createFakeCoordination({
        createSession: () => {
          allocations += 1;
          return Effect.succeed(null);
        },
      }),
      edgeRegistrations: [edge],
    });
    const commitment = Buffer.alloc(64, 91).toString('base64url');
    const request = (delegationId = TEST_DELEGATION_ID, edgeWtUrl = edge.edgeWtUrl) =>
      app.handle(
        new Request('https://merkur.example/api/sessions/renew', {
          method: 'POST',
          headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
          body: JSON.stringify({
            delegationId,
            daemonId: 'daemon-1',
            browserNodeId: 'browser-1',
            sessionId: 'existing-session',
            commitment,
            edgeWtUrl,
          }),
        }),
      );
    const response = await request();
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      sessionToken: string;
      sessionTokenExpiresInMs: number;
      edgeCertHashes: string[] | null;
    };
    expect(body.edgeCertHashes).toEqual([...edge.certHashes]);
    const unregistered = await request(TEST_DELEGATION_ID, 'https://gone.edge.example:4433/');
    expect(unregistered.status).toBe(200);
    expect(((await unregistered.json()) as { edgeCertHashes: unknown }).edgeCertHashes).toBeNull();
    const capability = verifySessionAuthorizationToken(body.sessionToken, VERIFY_KEY, Date.now());
    expect(capability).toMatchObject({
      u: TEST_USER_ID,
      g: TEST_DELEGATION_ID,
      b: 'browser-1',
      d: 'daemon-1',
      s: 'existing-session',
      q: commitment,
      k: DAEMON_IDENTITY_KEY_COMMITMENT,
    });
    expect(body.sessionTokenExpiresInMs).toBe(config.sessionTokenTtlMs);
    expect(sent).toEqual([]);
    expect(allocations).toBe(0);
    expect((await request('another-delegation')).status).toBe(401);
  });
});
