import {
  deriveDaemonIdentityKeyCommitment,
  deriveSessionAuthorizationKeyPair,
  deriveSessionRequestCommitment,
  deriveSoftwareDaemonP256PublicKey,
} from '@merkur/auth';
import {
  createDaemonControlSessionCancelMessage,
  createDaemonControlSessionStartMessage,
  encodeDaemonControlMessage,
} from '@merkur/daemon-control-protocol';
import {
  createDaemonBinding,
  deriveUserAuthorizationSigningKey,
  deriveUserRootKeyCommitment,
} from '@merkur/shared/user-authorization';
import { Effect, Redacted, Result } from 'effect';

import type { ServerConfig } from '../config';
import { type DaemonControlService, DaemonUnavailable } from './daemon-control-service';
import type { DeviceService } from './device-service';
import type { EdgeRegistration, EdgeRegistryService } from './edge-registry-service';
import type {
  CreatedSessionPresence,
  DaemonPresence,
  RealtimeCoordinationService,
} from './realtime-coordination-service';
import { RedisError } from './redis-service';
import type { SessionIssuanceService } from './session-issuance-service';

export const TEST_USER_ID = 'user-test';
export const TEST_DELEGATION_ID = 'delegation-test';
export const VALID_CERT_HASH = 'Qr4ZuCBq6NiQejuKBH9LF4gS6GICM00rGduNd31OVXw=';
const DAEMON_IDENTITY_PUBLIC_KEY_BYTES = new Uint8Array(2_592).fill(0x51);
export const DAEMON_IDENTITY_PUBLIC_KEY = Buffer.from(DAEMON_IDENTITY_PUBLIC_KEY_BYTES).toString(
  'base64url',
);
const CLIENT_NONCE_BYTES = new Uint8Array(32).fill(0x52);
export const CLIENT_NONCE = Buffer.from(CLIENT_NONCE_BYTES).toString('base64url');
const ENCAPSULATION_KEY_BYTES = new Uint8Array(1_568).fill(0x53);
export const ENCAPSULATION_KEY = Buffer.from(ENCAPSULATION_KEY_BYTES).toString('base64url');
export const DAEMON_IDENTITY_KEY_COMMITMENT = deriveDaemonIdentityKeyCommitment(
  DAEMON_IDENTITY_PUBLIC_KEY_BYTES,
  deriveSoftwareDaemonP256PublicKey(new Uint8Array(32).fill(0x51)),
);
const TEST_ROOT = deriveUserAuthorizationSigningKey(new Uint8Array(32).fill(0x59));
export const DAEMON_BINDING_JSON = JSON.stringify(
  createDaemonBinding(
    {
      userId: TEST_USER_ID,
      rootKeyCommitment: deriveUserRootKeyCommitment(TEST_ROOT.publicKey),
      daemonId: 'daemon-1',
      daemonIdentityKeyCommitment: DAEMON_IDENTITY_KEY_COMMITMENT,
      serverOrigin: 'https://localhost:3000',
      linkClaimId: 'link-claim-1',
      issuedAt: 1,
    },
    TEST_ROOT,
  ),
);
export const SESSION_REQUEST_COMMITMENT = deriveSessionRequestCommitment(
  CLIENT_NONCE_BYTES,
  ENCAPSULATION_KEY_BYTES,
);
export const PREVIOUS_SESSION_REQUEST_COMMITMENT = deriveSessionRequestCommitment(
  new Uint8Array(32).fill(0x54),
  new Uint8Array(1_568).fill(0x55),
);

const { signingKey: SIGNING_KEY, verifyKey } = deriveSessionAuthorizationKeyPair(
  new Uint8Array(32).fill(11),
);
export const DEFAULT_DAEMON_PRESENCE: DaemonPresence = {
  daemonId: 'daemon-1',
  userId: TEST_USER_ID,
  ownerInstanceId: 'instance-test',
  connectionId: 'connection-1',
  presenceId: 'presence-1',
  claimSeq: 1,
  state: 'online',
  updatedAt: 1,
  zone: null,
};

// Coordination double: the session-request route only creates and removes
// session presence. Every other method is a hard stub — exercising it is a test
// bug, not a path the routes take.
export function createFakeCoordination(overrides: {
  readonly created?: CreatedSessionPresence | null;
  readonly presence?: DaemonPresence | null;
  readonly removedSessionIds?: string[];
  readonly createSession?: () => Effect.Effect<CreatedSessionPresence | null, RedisError>;
}): RealtimeCoordinationService {
  const unused = (name: string) => Effect.die(new Error(`unexpected coordination call: ${name}`));
  return {
    instanceId: 'instance-test',
    awaitCriticalFailure: Effect.never,
    healthSnapshot: () =>
      Effect.succeed({
        presenceExpirySchedulerHealthy: true,
      }),
    claimDaemonOnline: () => unused('claimDaemonOnline'),
    renewDaemonLeases: () => unused('renewDaemonLeases'),
    markDaemonSilent: () => unused('markDaemonSilent'),
    clearDaemonSilent: () => unused('clearDaemonSilent'),
    unmarkDaemonOnline: () => unused('unmarkDaemonOnline'),
    suspendDaemonPresence: () => unused('suspendDaemonPresence'),
    resumeDaemonPresence: () => unused('resumeDaemonPresence'),
    getDaemonPresence: () => Effect.succeed(overrides.presence ?? null),
    getUserDaemonPresence: () => unused('getUserDaemonPresence'),
    publishDeviceDelta: () => unused('publishDeviceDelta'),
    readDeviceEventsCursor: () => unused('readDeviceEventsCursor'),
    subscribeDeviceEvents: () => unused('subscribeDeviceEvents'),
    incrementRevocationGeneration: () => unused('incrementRevocationGeneration'),
    createSessionForDaemonPresence: () =>
      overrides.createSession?.() ?? Effect.succeed(overrides.created ?? DEFAULT_DAEMON_PRESENCE),
    removeSessionForUser: ({ sessionId }) =>
      Effect.sync(() => {
        overrides.removedSessionIds?.push(sessionId);
      }),
    removeDaemonSessions: () => unused('removeDaemonSessions'),
  };
}

export function createFakeEdgeRegistry(overrides: {
  readonly edgeRegistrations?: readonly EdgeRegistration[];
  readonly edgeRegistryFailure?: boolean;
  readonly listHealthyEdges?: () => Effect.Effect<EdgeRegistration[], RedisError>;
}): EdgeRegistryService {
  const unused = (name: string) => Effect.die(new Error(`unexpected edge registry call: ${name}`));
  return {
    claimRegistrationNonce: () => unused('claimRegistrationNonce'),
    registerEdge: () => unused('registerEdge'),
    listHealthyEdges: () =>
      overrides.listHealthyEdges?.() ??
      (overrides.edgeRegistryFailure === true
        ? Effect.fail(
            new RedisError({
              cause: new Error('Dragonfly unavailable'),
              message: 'Error in `Redis.commands`',
            }),
          )
        : Effect.succeed([...(overrides.edgeRegistrations ?? [DEFAULT_EDGE_REGISTRATION])])),
  };
}

const DEFAULT_EDGE_REGISTRATION: EdgeRegistration = {
  edgeId: 'default-1',
  edgeRegion: 'test',
  edgeWtUrl: 'https://edge.example:4433',
  activeCertHash: VALID_CERT_HASH,
  certHashes: [VALID_CERT_HASH],
  updatedAt: 1,
};

export function createFakeConfig(): ServerConfig {
  return {
    host: '0.0.0.0',
    port: 3000,
    dbUrl: ':memory:',
    dbAuthToken: undefined,
    redisUrl: Redacted.make('redis://localhost:6379'),
    publicOrigin: 'https://localhost:3000',
    website: undefined,
    accessTokenHmacKey: new Uint8Array(64),
    jwtIssuer: 'merkur',
    jwtAudience: 'merkur-clients',
    tokenHmacSecret: Redacted.make('secret'),
    authAllowRegistration: true,
    authIdentity: 'username',
    emailDelivery: undefined,
    opaqueServerSetup: Redacted.make(Buffer.alloc(128).toString('base64url')),
    opaqueServerPublicKey: Buffer.alloc(32).toString('base64url'),
    trustedProxyHops: 1,
    sessionTokenSigningKey: SIGNING_KEY,
    sessionTokenVerifyKeyB64: Buffer.from(VERIFY_KEY).toString('base64url'),
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

export interface SentDaemonMessage {
  readonly connectionId: string;
  readonly payload: string;
}

export function createFakeControl(
  sent: SentDaemonMessage[],
  deliveryFailure: boolean,
  coordination: RealtimeCoordinationService,
): DaemonControlService {
  let nextCommandId = 1;
  const failDelivery = (daemonId: string) =>
    Effect.fail(new DaemonUnavailable({ daemonId, reason: 'test_delivery_failure' }));
  return {
    awaitCriticalFailure: Effect.never,
    acceptConnection: () => Effect.die(new Error('unexpected acceptConnection')),
    receive: () => Effect.die(new Error('unexpected receive')),
    disconnect: () => Effect.die(new Error('unexpected disconnect')),
    pushRevocationGeneration: () => Effect.die(new Error('unexpected pushRevocationGeneration')),
    startSession(input) {
      if (deliveryFailure) return failDelivery(input.presence.daemonId);
      const payload = encodeDaemonControlMessage(
        createDaemonControlSessionStartMessage(
          `command-${nextCommandId++}`,
          input.sessionId,
          input.browserNodeId,
          input.offer,
          '',
        ),
      );
      sent.push({ connectionId: input.presence.connectionId, payload });
      return Effect.void;
    },
    cancelSession(input) {
      return Effect.gen(function* () {
        if (deliveryFailure) return yield* failDelivery(input.daemonId);
        const presence = yield* coordination.getDaemonPresence(input.daemonId);
        if (presence === null || presence.userId !== input.userId) {
          return yield* new DaemonUnavailable({
            daemonId: input.daemonId,
            reason: 'daemon_presence_unavailable',
          });
        }
        const payload = encodeDaemonControlMessage(
          createDaemonControlSessionCancelMessage(
            `command-${nextCommandId++}`,
            input.sessionId,
            input.browserNodeId,
            '',
          ),
        );
        sent.push({ connectionId: presence.connectionId, payload });
      });
    },
    flushUserDelegationRevocations: () => Effect.void,
    healthSnapshot: () =>
      Effect.succeed({
        brokerWorkersHealthy: true,
        livenessTickerHealthy: true,
        connectionWorkersHealthy: true,
        controlConnections: 0,
      }),
  };
}

export function createFakeSessionIssuanceService(): SessionIssuanceService {
  return {
    issue(input, callbacks) {
      const sessionId = `session-${input.issuanceId}`;
      return Effect.gen(function* () {
        const prepared = yield* Effect.result(callbacks.prepare(sessionId));
        if (Result.isFailure(prepared)) {
          yield* callbacks.compensate(sessionId).pipe(Effect.ignore);
          return yield* Effect.fail(prepared.failure);
        }
        yield* callbacks.deliver(prepared.success.response);
        return prepared.success.response;
      });
    },
    cancel: () => Effect.succeed({ _tag: 'Missing' }),
    supersede: () => Effect.succeed({ _tag: 'Missing' }),
  };
}

export function createFakeDeviceService(
  daemonIdentityPublicKey: string | null,
  daemonBindingJson = DAEMON_BINDING_JSON,
): DeviceService {
  const unused = (name: string) => Effect.die(new Error(`unexpected device call: ${name}`));
  return {
    listDevices: () => unused('listDevices'),
    touchDaemonsSeen: () => unused('touchDaemonsSeen'),
    getDevice: () => unused('getDevice'),
    createLinkToken: () => unused('createLinkToken'),
    resolveBox: () => unused('resolveBox'),
    listAccountBoxes: () => unused('listAccountBoxes'),
    getDaemonSessionIdentity: () =>
      Effect.succeed(
        daemonIdentityPublicKey === null
          ? null
          : {
              daemonIdentityPublicKey,
              daemonIdentityP256PublicKey: Buffer.from(
                deriveSoftwareDaemonP256PublicKey(new Uint8Array(32).fill(0x51)),
              ).toString('base64url'),
              daemonBindingJson,
            },
      ),
    renameDevice: () => unused('renameDevice'),
    deleteDevice: () => unused('deleteDevice'),
    authenticateDaemonProof: () => unused('authenticateDaemonProof'),
    touchDaemon: () => unused('touchDaemon'),
  };
}

export const VERIFY_KEY = verifyKey;
