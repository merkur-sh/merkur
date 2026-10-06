import { describe, expect, test } from 'bun:test';
import { Effect, Layer, Result } from 'effect';
import { ServerConfigService } from '../config';
import { DaemonControlServiceTag } from './daemon-control-service';
import { DeviceServiceTag } from './device-service';
import { type EdgeRegistration, EdgeRegistryServiceTag } from './edge-registry-service';
import { RealtimeCoordinationServiceTag } from './realtime-coordination-service';
import { SessionIssuanceServiceTag } from './session-issuance-service';
import {
  DelegationMismatchError,
  SessionIdentityStateError,
  SessionServiceLive,
  SessionServiceTag,
} from './session-service';
import {
  createFakeConfig,
  createFakeControl,
  createFakeCoordination,
  createFakeDeviceService,
  createFakeEdgeRegistry,
  createFakeSessionIssuanceService,
  DAEMON_BINDING_JSON,
  DAEMON_IDENTITY_PUBLIC_KEY,
  TEST_DELEGATION_ID,
  TEST_USER_ID,
} from './session-test-fixture';

const principal = { userId: TEST_USER_ID, delegationId: TEST_DELEGATION_ID };
const request = {
  daemonId: 'daemon-1',
  browserNodeId: 'browser-1',
  delegationId: TEST_DELEGATION_ID,
  issuanceId: 'successor',
  supersedesIssuanceId: 'predecessor',
  clientNonce: Buffer.alloc(32, 1).toString('base64url'),
  encapsulationKey: Buffer.alloc(1_568, 2).toString('base64url'),
};
const SESSION_EDGE: EdgeRegistration = {
  edgeId: 'iad-1',
  edgeRegion: 'iad',
  edgeWtUrl: 'https://iad-1.edge.example:4433/',
  activeCertHash: Buffer.alloc(32, 4).toString('base64'),
  certHashes: [Buffer.alloc(32, 4).toString('base64'), Buffer.alloc(32, 5).toString('base64')],
  updatedAt: 1,
};
const renewal = {
  daemonId: request.daemonId,
  browserNodeId: request.browserNodeId,
  delegationId: request.delegationId,
  sessionId: 'live-session',
  commitment: Buffer.alloc(64, 3).toString('base64url'),
  edgeWtUrl: SESSION_EDGE.edgeWtUrl,
};

function serviceLayer(
  binding: string,
  events: string[],
  edgeRegistrations: readonly EdgeRegistration[] = [SESSION_EDGE],
) {
  const coordination = createFakeCoordination({});
  const issuance = createFakeSessionIssuanceService();
  return SessionServiceLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ServerConfigService, createFakeConfig()),
        Layer.succeed(
          DeviceServiceTag,
          createFakeDeviceService(DAEMON_IDENTITY_PUBLIC_KEY, binding),
        ),
        Layer.succeed(RealtimeCoordinationServiceTag, coordination),
        Layer.succeed(EdgeRegistryServiceTag, createFakeEdgeRegistry({ edgeRegistrations })),
        Layer.succeed(DaemonControlServiceTag, createFakeControl([], false, coordination)),
        Layer.succeed(SessionIssuanceServiceTag, {
          ...issuance,
          supersede: () =>
            Effect.sync(() => {
              events.push('supersede');
              return { _tag: 'Missing' as const };
            }),
          issue: (...args) => {
            events.push('issue');
            return issuance.issue(...args);
          },
        }),
      ),
    ),
  );
}

describe('SessionService identity boundary', () => {
  test('request and renewal reject a mismatched authenticated delegation', async () => {
    const events: string[] = [];
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionServiceTag;
        return [
          yield* Effect.result(
            sessions.request(principal, { ...request, delegationId: 'other' }, null, {}),
          ),
          yield* Effect.result(sessions.renew(principal, { ...renewal, delegationId: 'other' })),
        ];
      }).pipe(Effect.provide(serviceLayer(DAEMON_BINDING_JSON, events))),
    );
    for (const outcome of result) {
      expect(Result.isFailure(outcome)).toBe(true);
      if (Result.isFailure(outcome))
        expect(outcome.failure).toBeInstanceOf(DelegationMismatchError);
    }
    expect(events).toEqual([]);
  });

  test('invalid linked identities fail in the typed channel before predecessor retirement or renewal', async () => {
    const binding = JSON.parse(DAEMON_BINDING_JSON);
    for (const invalid of [
      '{broken',
      JSON.stringify({ ...binding, userId: 'another-account' }),
      JSON.stringify({ ...binding, daemonId: 'another-daemon' }),
      JSON.stringify({
        ...binding,
        daemonIdentityKeyCommitment: Buffer.alloc(64, 99).toString('base64url'),
      }),
    ]) {
      const events: string[] = [];
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const sessions = yield* SessionServiceTag;
          return [
            yield* Effect.result(sessions.request(principal, request, null, {})),
            yield* Effect.result(sessions.renew(principal, renewal)),
          ];
        }).pipe(Effect.provide(serviceLayer(invalid, events))),
      );
      for (const outcome of result) {
        expect(Result.isFailure(outcome)).toBe(true);
        if (Result.isFailure(outcome))
          expect(outcome.failure).toBeInstanceOf(SessionIdentityStateError);
      }
      expect(events).toEqual([]);
    }
  });
});

describe('SessionService renewal', () => {
  test("restates the named edge's registered certificate hashes", async () => {
    const renewed = await Effect.runPromise(
      Effect.flatMap(SessionServiceTag, (sessions) => sessions.renew(principal, renewal)).pipe(
        Effect.provide(serviceLayer(DAEMON_BINDING_JSON, [])),
      ),
    );
    expect(renewed.edgeCertHashes).toEqual([...SESSION_EDGE.certHashes]);
    expect(renewed.sessionToken.length).toBeGreaterThan(0);
  });

  test('states no hashes for an edge the registry no longer holds', async () => {
    const renewed = await Effect.runPromise(
      Effect.flatMap(SessionServiceTag, (sessions) => sessions.renew(principal, renewal)).pipe(
        Effect.provide(serviceLayer(DAEMON_BINDING_JSON, [], [])),
      ),
    );
    expect(renewed.edgeCertHashes).toBeNull();
  });
});
