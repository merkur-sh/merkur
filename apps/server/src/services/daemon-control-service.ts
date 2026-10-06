import {
  createDaemonControlDelegationRevokeMessage,
  createDaemonControlLeaseMessage,
  createDaemonControlRegisteredMessage,
  createDaemonControlRevocationMessage,
  createDaemonControlSessionCancelMessage,
  createDaemonControlSessionStartMessage,
  createDaemonControlSupersededMessage,
  type DaemonControlCommandMessage,
  type DaemonControlDaemonMessage,
  type DaemonControlEdge,
  type DaemonControlServerMessage,
  type DaemonControlSessionOffer,
  encodeDaemonControlMessage,
  MAX_DAEMON_CONTROL_FRAME_BYTES,
  parseDaemonControlDaemonMessage,
  parseDaemonControlServerMessage,
} from '@merkur/daemon-control-protocol';
import { hasExactKeys, isRecord, spanAttributes } from '@merkur/shared';
import {
  parseDelegationRevocationStatement,
  parseUserDelegationCertificate,
} from '@merkur/shared/user-authorization';
import {
  Cause,
  Clock,
  Context,
  Data,
  Deferred,
  Effect,
  Exit,
  Layer,
  Metric,
  Option,
  Queue,
  Result,
  Scope,
  Tracer,
} from 'effect';
import type { Kysely } from 'kysely';
import { ServerConfigService } from '../config';
import { DatabaseService } from '../db/client';
import type { DatabaseSchema } from '../db/types';
import { createLogger, errorLogContext, type Logger, logWithLoggerEffect } from '../logger';
import {
  backgroundWorkerFailureFrequency,
  daemonControlActiveConnectionsGauge,
  daemonControlDeliveryLatencyMs,
  daemonControlDeliveryOutcomeFrequency,
  daemonControlInboundOverflowCounter,
  daemonControlPingTimeoutCounter,
  daemonControlSilentTransitionFrequency,
} from '../observability/metrics';
import { currentTraceparent } from '../observability/traceparent';
import { DeviceServiceTag } from './device-service';
import { createEdgeAttachTicketIssuer, type EdgeAttachTicketIssuer } from './edge-attach-ticket';
import { EdgeRegistryServiceTag } from './edge-registry-service';
import { type InfrastructureError, infrastructureError } from './errors';
import type { IpZone } from './ip-region';
import {
  type ClaimDaemonOnlineResult,
  type DaemonPresence,
  type RealtimeCoordinationService,
  RealtimeCoordinationServiceTag,
} from './realtime-coordination-service';
import {
  type RedisError,
  RedisReplyError,
  type RedisService,
  RedisServiceTag,
} from './redis-service';
import { createStunTicketIssuer, type StunTicketIssuer } from './stun-ticket-service';

/**
 * Carrier liveness and lease durability run on separate cadences, on purpose.
 *
 * The daemon sends a WebSocket ping frame every `PING_INTERVAL`; the frame costs
 * nothing to observe — no parse, no Redis — so it can be frequent. After
 * `SILENT_AFTER` without one the presence is reported silent (the browser shows
 * the device down) while the socket, lease and sessions are left untouched,
 * because a false positive there only costs a wrong badge for a moment. Only
 * after `PING_TIMEOUT` is the carrier torn down, which forces a reconnect and
 * re-registration and therefore must stay generous. The Redis lease is renewed
 * every `LEASE_RENEWAL`, a third of its 60 s TTL, in one batched round trip per
 * instance — how often a daemon proves it is alive has nothing to do with how
 * often the durable record needs rewriting.
 */
export const DAEMON_CONTROL_PING_INTERVAL_MS = 2_000;
export const DAEMON_CONTROL_SILENT_AFTER_MS = 5_000;
export const DAEMON_CONTROL_PING_TIMEOUT_MS = 15_000;
export const DAEMON_CONTROL_LEASE_RENEWAL_MS = 20_000;
/**
 * Sent by a daemon that is deliberately stopping. Its PTYs are gone, so the
 * lease is released at once instead of being held through the resume grace.
 */
export const DAEMON_SHUTDOWN_CLOSE_CODE = 4_004;
export const DAEMON_CONTROL_COMMAND_TIMEOUT_MS = 5_000;
export const DAEMON_CONTROL_BACKPRESSURE_LIMIT_BYTES = 64 * 1024;
export const DAEMON_CONTROL_MAX_PENDING_COMMANDS_PER_CONNECTION = 64;

const MAX_CONNECTIONS = 10_000;
const MAX_PENDING_REMOTE_COMMANDS = 1_024;
const BROKER_INBOX_CAPACITY = 1_024;
const BROKER_HANDLER_CONCURRENCY = 32;
const MAX_BROKER_FRAME_BYTES = MAX_DAEMON_CONTROL_FRAME_BYTES + 4_096;
/**
 * Renewals per pipelined Redis call. The client's command queue is shared with
 * every other operation on the instance and holds 1 000 entries; one call per
 * chunk keeps a large fleet from monopolising it.
 */
const LEASE_RENEWAL_CHUNK = 128;
/** A failed renewal batch is retried on this cadence, not at the next period. */
const LEASE_RENEWAL_RETRY_MS = 2_000;
/** Shortest sleep between liveness walks, so a stuck deadline cannot spin. */
const LIVENESS_TICK_FLOOR_MS = 250;
const BROKER_PROTOCOL_VERSION = 1;
const BROKER_CHANNEL_PREFIX = 'merkur:daemon-control:instance:';
/** Every instance subscribes; carries fan-out that has no single owner. */
const BROKER_BROADCAST_CHANNEL = 'merkur:daemon-control:broadcast';
const UTF8_ENCODER = new TextEncoder();

export class DaemonUnavailable extends Data.TaggedError('DaemonUnavailable')<{
  readonly daemonId: string;
  readonly reason: string;
}> {}

export class StaleDaemonPresence extends Data.TaggedError('StaleDaemonPresence')<{
  readonly daemonId: string;
  readonly presenceId: string;
  readonly claimSeq: number;
}> {}

export class ControlDeliveryTimeout extends Data.TaggedError('ControlDeliveryTimeout')<{
  readonly daemonId: string;
  readonly commandId: string;
}> {}

export class ControlBackpressure extends Data.TaggedError('ControlBackpressure')<{
  readonly daemonId: string;
  readonly connectionId: string;
}> {}

export class ControlCommandRejected extends Data.TaggedError('ControlCommandRejected')<{
  readonly daemonId: string;
  readonly commandId: string;
  readonly reason: string;
}> {}

export type DaemonControlDeliveryError =
  | DaemonUnavailable
  | StaleDaemonPresence
  | ControlDeliveryTimeout
  | ControlBackpressure
  | ControlCommandRejected;

export interface DaemonControlSocket {
  sendText(payload: string): number;
  close(code: number, reason: string): void;
}

export interface DaemonControlConnectionInput {
  readonly daemonId: string;
  readonly userId: string;
  /** The box this daemon runs in, or `null`; selects its STUN observers. */
  readonly boxId: string | null;
  readonly daemonVersion: string;
  readonly connectionId: string;
  /** Freshly generated. Used only when no suspended lease is reclaimed. */
  readonly presenceId: string;
  /**
   * The presence this daemon believes it still owns, if any.
   *
   * The daemon learns it from `registered` and keeps it in memory only, so a
   * restarted process cannot present one — which is exactly the distinction
   * that matters: a restart lost its PTYs, and its sessions must not be
   * inherited. Authority comes from the identity proof that authenticated this socket;
   * this only selects *which* lease is being reclaimed.
   */
  readonly resumePresenceId?: string;
  /**
   * Zone of the address this upgrade arrived from, resolved by the route.
   *
   * The service never sees the address itself. Resolution belongs to the HTTP
   * layer because that is where trusted-proxy hops are known, and the zone is
   * all the presence record is allowed to keep.
   */
  readonly zone: IpZone | null;
  readonly socket: DaemonControlSocket;
}

export interface DaemonControlSessionStartInput {
  readonly presence: DaemonPresence;
  readonly sessionId: string;
  readonly browserNodeId: string;
  readonly offer: DaemonControlSessionOffer;
}

export interface DaemonControlSessionCancelInput {
  readonly daemonId: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly browserNodeId: string;
}

export type DaemonControlRegistrationError =
  | RedisError
  | InfrastructureError
  | DaemonControlDeliveryError;

/**
 * What the socket layer keeps per connection after registration.
 *
 * `observePing` is synchronous and allocation-free by design: it runs once per
 * ping frame per daemon, straight from the socket's `ping` handler, and must
 * not pay for a runtime entry. It is the one non-Effect path into this service.
 */
export interface ControlConnectionHandle {
  observePing(): void;
}

export interface DaemonControlService {
  acceptConnection(
    input: DaemonControlConnectionInput,
  ): Effect.Effect<ControlConnectionHandle, DaemonControlRegistrationError>;
  receive(
    connectionId: string,
    frame: unknown,
  ): Effect.Effect<void, RedisError | DaemonControlDeliveryError>;
  /**
   * `closeCode` is what the peer closed with, or null when the close carried
   * none. Only `DAEMON_SHUTDOWN_CLOSE_CODE` changes the outcome: every other
   * peer close is a lost carrier whose lease is held for resume.
   */
  disconnect(connectionId: string, closeCode: number | null): Effect.Effect<void, RedisError>;
  /**
   * Fans a new revoke-all generation out to every connection of this user on
   * every instance. The periodic `lease` message is the bound; this is the
   * push that makes the dataplane evict its peers now.
   */
  pushRevocationGeneration(userId: string, generation: number): Effect.Effect<void, RedisError>;
  startSession(
    input: DaemonControlSessionStartInput,
  ): Effect.Effect<void, RedisError | DaemonControlDeliveryError>;
  cancelSession(
    input: DaemonControlSessionCancelInput,
  ): Effect.Effect<void, RedisError | DaemonControlDeliveryError>;
  flushUserDelegationRevocations(
    userId: string,
  ): Effect.Effect<void, RedisError | InfrastructureError>;
  readonly healthSnapshot: () => Effect.Effect<DaemonControlHealthSnapshot>;
  readonly awaitCriticalFailure: Effect.Effect<never>;
}

export interface DaemonControlHealthSnapshot {
  readonly brokerWorkersHealthy: boolean;
  readonly livenessTickerHealthy: boolean;
  readonly connectionWorkersHealthy: boolean;
  readonly controlConnections: number;
}

export class DaemonControlServiceTag extends Context.Service<
  DaemonControlServiceTag,
  DaemonControlService
>()('DaemonControlService') {}

interface PendingLocalCommand {
  /** Retained so a resumed carrier can be re-sent the frame it never saw. */
  readonly command: DaemonControlCommandMessage;
  /**
   * The carrier this delivery is currently riding, rewritten when a resumed
   * connection replays it. Only that carrier can ack it, so an entry left
   * behind by a departed one must not block a fresh delivery of the same
   * commandId — the delegation-revocation outbox reuses its commandId until it
   * is acknowledged, and registration re-sends it.
   */
  connectionId: string;
  readonly deferred: Deferred.Deferred<
    Extract<DaemonControlDaemonMessage, { readonly type: 'command_ack' }>,
    DaemonUnavailable | StaleDaemonPresence
  >;
}

interface InboundControlMessage<
  Message extends DaemonControlDaemonMessage = DaemonControlDaemonMessage,
> {
  readonly message: Message;
  readonly completed: Deferred.Deferred<void, RedisError | DaemonControlDeliveryError>;
}

/**
 * Why a control connection is being torn down.
 *
 * The discriminant is the whole point. Everything that happens to the lease is
 * *derived* from `kind`, so a new teardown path never has to reason about the
 * consequences — only about what it observed:
 *
 * - `carrier_lost` — the daemon did nothing wrong and we did not evict it; the
 *   transport went away. The lease is held through its resume grace window,
 *   which keeps `presenceId`/`claimSeq` and every session claim fenced by them.
 * - `lease_invalidated` — this lease must not survive: the daemon is broken, our
 *   own view of it is untrusted, a newer claim owns it, or holding it would keep
 *   something alive that must die. The lease and its session claims are retired.
 *
 * Adding a variant forces a choice between those two, and the exhaustive tables
 * below make the compiler ask for it. There is no default to inherit — that is
 * how an undelivered revocation once nearly kept its session claims alive.
 */
export type ControlTeardown =
  | {
      readonly kind: 'carrier_lost';
      readonly reason:
        | 'peer_disconnected'
        | 'ping_timeout'
        // A daemon flooding our inbound mailbox is overloaded, not hostile, and
        // overload is transient — so this stays a lost carrier rather than an
        // invalidated lease.
        | 'inbound_overflow'
        | 'service_shutdown';
    }
  | {
      readonly kind: 'lease_invalidated';
      readonly reason: // The daemon said it was stopping. Its PTYs are gone with it, so there
      // is nothing for the resume grace window to preserve.
        | 'peer_shutdown'
        | 'invalid_frame'
        | 'worker_defect'
        | 'superseded'
        | 'revocation_retry'
        | 'registration_failed';
    };

type ControlTeardownReason = ControlTeardown['reason'];
type PresenceDisposition = 'suspend' | 'release';

interface ControlTeardownPolicy {
  /** Close code to send, or null when the peer is already gone. */
  readonly closeCode: number | null;
  readonly closeReason: string;
  /** Whether to tear down a connection that never finished registering. */
  readonly forceRegistrationCleanup: boolean;
}

const CONTROL_TEARDOWN_POLICY: Readonly<Record<ControlTeardownReason, ControlTeardownPolicy>> = {
  // The peer closed the socket, so there is nothing left to send a code on.
  peer_disconnected: { closeCode: null, closeReason: '', forceRegistrationCleanup: false },
  peer_shutdown: { closeCode: null, closeReason: '', forceRegistrationCleanup: false },
  ping_timeout: {
    closeCode: 1001,
    closeReason: 'ping_timeout',
    forceRegistrationCleanup: true,
  },
  inbound_overflow: {
    closeCode: 1013,
    closeReason: 'control_inbound_overflow',
    forceRegistrationCleanup: true,
  },
  service_shutdown: {
    closeCode: 1001,
    closeReason: 'server_shutdown',
    forceRegistrationCleanup: true,
  },
  invalid_frame: {
    closeCode: 1008,
    closeReason: 'invalid_control_frame',
    forceRegistrationCleanup: true,
  },
  worker_defect: {
    closeCode: 1011,
    closeReason: 'control_worker_failed',
    forceRegistrationCleanup: true,
  },
  superseded: { closeCode: 4001, closeReason: 'superseded', forceRegistrationCleanup: true },
  revocation_retry: {
    closeCode: 4003,
    closeReason: 'delegation_revocation_retry',
    forceRegistrationCleanup: true,
  },
  registration_failed: {
    closeCode: 1011,
    closeReason: 'registration_failed',
    forceRegistrationCleanup: true,
  },
};

export function controlLeaseDisposition(teardown: ControlTeardown): PresenceDisposition {
  return teardown.kind === 'carrier_lost' ? 'suspend' : 'release';
}

interface ControlConnection {
  readonly daemonId: string;
  readonly userId: string;
  readonly daemonVersion: string;
  readonly connectionId: string;
  /** Rewritten when a suspended lease is reclaimed instead of a fresh claim. */
  presenceId: string;
  readonly socket: DaemonControlSocket;
  readonly scope: Scope.Closeable;
  readonly commandAckInbox: Queue.Queue<
    InboundControlMessage<Extract<DaemonControlDaemonMessage, { readonly type: 'command_ack' }>>
  >;
  readonly inboundWake: Queue.Queue<void>;
  /** Wakes the convergence worker whenever `silent` may differ from Redis. */
  readonly presenceWake: Queue.Queue<void>;
  readonly presenceLeaseFinalized: Deferred.Deferred<void, RedisError>;
  presenceLeaseAcquired: boolean;
  /**
   * Why this connection was torn down, written once by `releaseConnection`.
   * `null` means the scope closed without going through it, which is
   * unreachable today and is treated as an invalidated lease.
   */
  teardownReason: ControlTeardown | null;
  /** Whether this connection created its lease or inherited a suspended one. */
  leaseOrigin: 'claimed' | 'resumed';
  claimSeq: number | null;
  peerClosed: boolean;
  sessionReady: boolean;
  /** Monotonic instant of the last ping frame, or of registration. */
  lastSeenAtMono: number;
  /** Observed: no ping for `DAEMON_CONTROL_SILENT_AFTER_MS`. */
  silent: boolean;
  /** What Redis holds. The convergence worker drives it toward `silent`. */
  silentCommitted: boolean;
  /** True while the node sits in the liveness and lease lists. */
  linked: boolean;
  /** Last renewal attempt — the lease list is ordered by this, not by success. */
  leaseAttemptedAtMono: number;
  leaseRenewedAtMono: number;
  readonly liveLink: ListLink;
  readonly leaseLink: ListLink;
}

interface ListLink {
  prev: ControlConnection | null;
  next: ControlConnection | null;
}

type ListLinkKey = 'liveLink' | 'leaseLink';

/**
 * Intrusive doubly linked list over connections, ordered by insertion.
 *
 * Every deadline this service tracks is a fixed offset from a per-connection
 * timestamp that only ever moves forward, so moving a node to the tail when
 * its timestamp is refreshed keeps the list sorted with no comparison at all:
 * the head is always the next node due. O(1) per ping, O(due) per walk.
 */
class ConnectionList {
  head: ControlConnection | null = null;
  tail: ControlConnection | null = null;

  constructor(private readonly key: ListLinkKey) {}

  append(node: ControlConnection): void {
    const link = node[this.key];
    link.prev = this.tail;
    link.next = null;
    if (this.tail === null) {
      this.head = node;
    } else {
      this.tail[this.key].next = node;
    }
    this.tail = node;
  }

  remove(node: ControlConnection): void {
    const link = node[this.key];
    if (link.prev === null) {
      this.head = link.next;
    } else {
      link.prev[this.key].next = link.next;
    }
    if (link.next === null) {
      this.tail = link.prev;
    } else {
      link.next[this.key].prev = link.prev;
    }
    link.prev = null;
    link.next = null;
  }

  moveToTail(node: ControlConnection): void {
    if (this.tail === node) return;
    this.remove(node);
    this.append(node);
  }
}

interface PendingRemoteCommand {
  readonly daemonId: string;
  readonly presenceId: string;
  readonly claimSeq: number;
  readonly deferred: Deferred.Deferred<BrokerCommandResult>;
}

interface BrokerCommandRequest {
  readonly type: 'command_request';
  readonly version: typeof BROKER_PROTOCOL_VERSION;
  readonly requesterInstanceId: string;
  readonly ownerInstanceId: string;
  readonly daemonId: string;
  readonly userId: string;
  readonly connectionId: string;
  readonly presenceId: string;
  readonly claimSeq: number;
  readonly trace: BrokerTraceContext;
  readonly command: DaemonControlCommandMessage;
}

interface BrokerTraceContext {
  readonly traceId: string;
  readonly spanId: string;
  readonly sampled: boolean;
}

type BrokerCommandOutcome =
  | 'accepted'
  | 'rejected'
  | 'unavailable'
  | 'stale'
  | 'timeout'
  | 'backpressure';

interface BrokerCommandResult {
  readonly type: 'command_result';
  readonly version: typeof BROKER_PROTOCOL_VERSION;
  readonly requesterInstanceId: string;
  readonly ownerInstanceId: string;
  readonly daemonId: string;
  readonly presenceId: string;
  readonly claimSeq: number;
  readonly commandId: string;
  readonly outcome: BrokerCommandOutcome;
  readonly reason: string | null;
}

interface BrokerSuperseded {
  readonly type: 'superseded';
  readonly version: typeof BROKER_PROTOCOL_VERSION;
  readonly ownerInstanceId: string;
  readonly daemonId: string;
  readonly connectionId: string;
  readonly presenceId: string;
  readonly claimSeq: number;
}

interface BrokerDelegationRevocationRetry {
  readonly type: 'delegation_revocation_retry';
  readonly version: typeof BROKER_PROTOCOL_VERSION;
  readonly ownerInstanceId: string;
  readonly daemonId: string;
  readonly connectionId: string;
  readonly presenceId: string;
  readonly claimSeq: number;
}

/** Broadcast to every instance; each delivers to its own connections of the user. */
interface BrokerRevocationGeneration {
  readonly type: 'revocation_generation';
  readonly version: typeof BROKER_PROTOCOL_VERSION;
  readonly userId: string;
  readonly generation: number;
}

type BrokerEnvelope =
  | BrokerCommandRequest
  | BrokerCommandResult
  | BrokerSuperseded
  | BrokerDelegationRevocationRetry
  | BrokerRevocationGeneration;

interface DaemonControlRuntime extends DaemonControlService {
  readonly processBrokerFrame: (frame: string) => Effect.Effect<void, RedisError>;
  /**
   * One liveness walk: silent marks, ping timeouts, and due lease renewals.
   * Returns how long to sleep before the next walk, or null when there is no
   * connection to watch.
   */
  readonly livenessTick: Effect.Effect<number | null>;
  /** `livenessTick` on a timer that an insert or a recovery can shorten. */
  readonly runLivenessTicker: Effect.Effect<never>;
  readonly shutdown: Effect.Effect<void>;
  readonly reportCriticalWorkerFailure: (
    component: keyof Omit<DaemonControlHealthSnapshot, 'controlConnections'>,
    cause: Cause.Cause<unknown>,
  ) => Effect.Effect<void>;
}

export interface DaemonControlServiceDependencies {
  readonly coordination: RealtimeCoordinationService;
  readonly redis: RedisService;
  readonly touchDaemon: (
    daemonId: string,
    version: string,
  ) => Effect.Effect<void, InfrastructureError>;
  /** Records liveness for daemons whose lease this instance just renewed. */
  readonly touchDaemonsSeen: (
    daemonIds: readonly string[],
  ) => Effect.Effect<void, InfrastructureError>;
  readonly revocationOutbox?: DelegationRevocationOutbox;
  readonly logger: Logger;
  /**
   * Mints the STUN credential carried on `registered` and every `lease`.
   *
   * Required rather than defaulted: a daemon that receives no ticket cannot
   * probe, which shows up as `NatMapping::Unknown` and a silently missing
   * direct path — exactly the kind of failure a convenient default would hide.
   */
  readonly stun: StunTicketIssuer;
  /**
   * Mints the edge attach ticket carried on `registered` and every `lease`.
   * Required for the same reason as `stun`: a daemon without one is refused
   * by every edge, and a default would hide that.
   */
  readonly edgeAttach: EdgeAttachTicketIssuer;
  /**
   * The registry's edges and their certificate hashes, stated on `registered`
   * and every `lease`: the daemon pins each edge's newest hashes on every dial,
   * and a restarted dataplane states its incarnation to each.
   */
  readonly edges: Effect.Effect<readonly DaemonControlEdge[], RedisError>;
  /** Wall clock, for timestamps that leave the process. */
  readonly now?: () => number;
  /**
   * Monotonic clock, for every deadline. Wall time can step backwards under
   * NTP, which would break the ordering the deadline lists rely on.
   */
  readonly monotonicNow?: () => number;
  readonly commandTimeoutMs?: number;
  readonly maxPendingCommandsPerConnection?: number;
  readonly maxPendingRemoteCommands?: number;
  readonly criticalFailure?: Deferred.Deferred<never>;
}

interface PendingDelegationRevocation {
  readonly commandId: string;
  readonly actorCertificateJson: string;
  readonly revocationJson: string;
}

interface DelegationRevocationOutbox {
  listPending(
    daemonId: string,
  ): Effect.Effect<readonly PendingDelegationRevocation[], InfrastructureError>;
  markAcknowledged(
    commandId: string,
    acknowledgedAt: number,
  ): Effect.Effect<void, InfrastructureError>;
  markRejected(commandId: string, reason: string): Effect.Effect<void, InfrastructureError>;
}

export const DaemonControlServiceLive = Layer.effect(
  DaemonControlServiceTag,
  Effect.gen(function* () {
    const coordination = yield* RealtimeCoordinationServiceTag;
    const redis = yield* RedisServiceTag;
    const devices = yield* DeviceServiceTag;
    const config = yield* ServerConfigService;
    const db = yield* DatabaseService;
    const edgeRegistry = yield* EdgeRegistryServiceTag;
    const clock = yield* Clock.Clock;
    const logger = createLogger('daemon-control');
    const brokerInbox = yield* Queue.bounded<string>(BROKER_INBOX_CAPACITY);
    const criticalFailure = yield* Deferred.make<never>();
    const service = createDaemonControlService({
      coordination,
      redis,
      touchDaemon: (daemonId, version) => devices.touchDaemon(daemonId, version),
      touchDaemonsSeen: (daemonIds) => devices.touchDaemonsSeen(daemonIds),
      revocationOutbox: createDelegationRevocationOutbox(db),
      logger,
      now: () => clock.currentTimeMillisUnsafe(),
      monotonicNow: () => performance.now(),
      stun: createStunTicketIssuer(
        config.stunTicketKey,
        config.stunServers,
        config.boxHostStunObservers,
      ),
      edgeAttach: createEdgeAttachTicketIssuer(config.edgeAttachTicketKey),
      edges: edgeRegistry
        .listHealthyEdges()
        .pipe(
          Effect.map((registrations) =>
            registrations.map(({ edgeWtUrl, certHashes }) => ({ edgeWtUrl, certHashes })),
          ),
        ),
      criticalFailure,
    });
    yield* Metric.update(daemonControlActiveConnectionsGauge, 0);
    // Scope finalizers run in reverse registration order. Register the service
    // owner first so broker workers and subscriptions stop before connection
    // state is drained and sockets are closed.
    yield* Effect.addFinalizer(() => service.shutdown);
    const brokerChannel = brokerChannelForInstance(coordination.instanceId);
    const brokerListener = (frame: string): void => {
      if (!Queue.offerUnsafe(brokerInbox, frame)) {
        logger.warn('daemon_control_broker_inbox_overloaded');
      }
    };

    yield* Effect.acquireRelease(redis.subscribe(brokerChannel, brokerListener), () =>
      redis.unsubscribe(brokerChannel, brokerListener).pipe(Effect.ignore),
    );
    yield* Effect.acquireRelease(redis.subscribe(BROKER_BROADCAST_CHANNEL, brokerListener), () =>
      redis.unsubscribe(BROKER_BROADCAST_CHANNEL, brokerListener).pipe(Effect.ignore),
    );
    yield* Effect.forEach(
      Array.from({ length: BROKER_HANDLER_CONCURRENCY }),
      (_, workerIndex) =>
        superviseCriticalWorker(
          `broker-${workerIndex}`,
          'brokerWorkersHealthy',
          runBrokerWorker(service, brokerInbox, logger),
          service,
        ).pipe(Effect.forkScoped),
      { discard: true },
    );
    yield* superviseCriticalWorker(
      'liveness-ticker',
      'livenessTickerHealthy',
      service.runLivenessTicker,
      service,
    ).pipe(Effect.forkScoped);
    return service;
  }),
);

export function createDaemonControlService(
  dependencies: DaemonControlServiceDependencies,
): DaemonControlRuntime {
  const { coordination, redis, logger, stun, edgeAttach } = dependencies;
  const now = dependencies.now ?? Date.now;
  const monotonicNow = dependencies.monotonicNow ?? (() => performance.now());
  const commandTimeoutMs = dependencies.commandTimeoutMs ?? DAEMON_CONTROL_COMMAND_TIMEOUT_MS;
  const maxPendingCommandsPerConnection =
    dependencies.maxPendingCommandsPerConnection ??
    DAEMON_CONTROL_MAX_PENDING_COMMANDS_PER_CONNECTION;
  const maxPendingRemoteCommands =
    dependencies.maxPendingRemoteCommands ?? MAX_PENDING_REMOTE_COMMANDS;
  const connections = new Map<string, ControlConnection>();
  const connectionIdByDaemonId = new Map<string, string>();
  /** Revoke-all fan-out is O(this user's daemons), not O(connections). */
  const connectionIdsByUserId = new Map<string, Set<string>>();
  // Registered connections, ordered by last ping and by last renewal attempt.
  // See `ConnectionList` for why ordering costs nothing to maintain.
  const liveList = new ConnectionList('liveLink');
  const leaseList = new ConnectionList('leaseLink');
  // The ticker sleeps until the earliest deadline it computed. An insert or a
  // recovery from silence can create an earlier one; they wake it through this
  // queue, sliding so a burst collapses into one wake.
  const tickerWake = Effect.runSync(Queue.sliding<void>(1));
  let armedDeadlineMono = Number.POSITIVE_INFINITY;
  const pendingRemoteCommands = new Map<string, PendingRemoteCommand>();
  // Keyed by presenceId, not connectionId: a presence outlives the socket that
  // created it, so a command in flight when a carrier drops is still awaited by
  // the caller and still deliverable once the daemon reattaches. Inner maps are
  // keyed by commandId, and their insertion order is admission order.
  const pendingByPresence = new Map<string, Map<string, PendingLocalCommand>>();

  function pendingCommandsFor(presenceId: string): Map<string, PendingLocalCommand> {
    const existing = pendingByPresence.get(presenceId);
    if (existing !== undefined) return existing;
    const created = new Map<string, PendingLocalCommand>();
    pendingByPresence.set(presenceId, created);
    return created;
  }
  let brokerWorkersHealthy = true;
  let livenessTickerHealthy = true;
  let connectionWorkersHealthy = true;
  let closed = false;

  function wakeTickerIfEarlier(deadlineMono: number): void {
    if (deadlineMono < armedDeadlineMono) {
      armedDeadlineMono = deadlineMono;
      Queue.offerUnsafe(tickerWake, undefined);
    }
  }

  /**
   * Links a registered connection into both deadline lists. Its timestamps are
   * the newest of all, so appending keeps the lists ordered.
   */
  function linkConnection(connection: ControlConnection): void {
    const at = monotonicNow();
    connection.lastSeenAtMono = at;
    connection.leaseAttemptedAtMono = at;
    connection.leaseRenewedAtMono = at;
    connection.linked = true;
    liveList.append(connection);
    leaseList.append(connection);
    // Every other node may already be silent, which would leave the ticker
    // armed on a timeout deadline later than this node's silence deadline.
    wakeTickerIfEarlier(at + DAEMON_CONTROL_SILENT_AFTER_MS);
  }

  function unlinkConnection(connection: ControlConnection): void {
    if (!connection.linked) return;
    connection.linked = false;
    liveList.remove(connection);
    leaseList.remove(connection);
  }

  function observePing(connection: ControlConnection): void {
    // A ping can arrive between `connections.set` and registration completing;
    // moving an unlinked node "to the tail" would insert it, and registration
    // would then insert it again.
    if (!connection.linked || connection.peerClosed) return;
    connection.lastSeenAtMono = monotonicNow();
    liveList.moveToTail(connection);
    if (connection.silent) {
      connection.silent = false;
      Queue.offerUnsafe(connection.presenceWake, undefined);
      wakeTickerIfEarlier(connection.lastSeenAtMono + DAEMON_CONTROL_SILENT_AFTER_MS);
    }
  }

  const service: DaemonControlRuntime = {
    acceptConnection(input) {
      return Effect.gen(function* () {
        if (closed || connections.size >= MAX_CONNECTIONS || connections.has(input.connectionId)) {
          return yield* new DaemonUnavailable({
            daemonId: input.daemonId,
            reason: closed ? 'control_service_closed' : 'connection_capacity_exceeded',
          });
        }

        // The connection owns a child scope whose finalizers cover its mailbox
        // worker, queues, and Redis presence lease. Building and publishing the
        // state is uninterruptible so every visible connection has an owner
        // capable of closing those resources.
        const connection = yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const scope = yield* Scope.make();
            const commandAckInbox = yield* Scope.provide(
              Effect.acquireRelease(
                Queue.bounded<
                  InboundControlMessage<
                    Extract<DaemonControlDaemonMessage, { readonly type: 'command_ack' }>
                  >
                >(Math.max(1, maxPendingCommandsPerConnection)),
                Queue.shutdown,
              ),
              scope,
            );
            const inboundWake = yield* Scope.provide(
              Effect.acquireRelease(Queue.sliding<void>(1), Queue.shutdown),
              scope,
            );
            const presenceWake = yield* Scope.provide(
              Effect.acquireRelease(Queue.sliding<void>(1), Queue.shutdown),
              scope,
            );
            const presenceLeaseFinalized = yield* Deferred.make<void, RedisError>();
            const created: ControlConnection = {
              ...input,
              scope,
              commandAckInbox,
              inboundWake,
              presenceWake,
              presenceLeaseFinalized,
              presenceLeaseAcquired: false,
              claimSeq: null,
              peerClosed: false,
              sessionReady: false,
              teardownReason: null,
              leaseOrigin: 'claimed',
              lastSeenAtMono: 0,
              silent: false,
              silentCommitted: false,
              linked: false,
              leaseAttemptedAtMono: 0,
              leaseRenewedAtMono: 0,
              liveLink: { prev: null, next: null },
              leaseLink: { prev: null, next: null },
            };
            connections.set(input.connectionId, created);
            let userConnections = connectionIdsByUserId.get(input.userId);
            if (userConnections === undefined) {
              userConnections = new Set();
              connectionIdsByUserId.set(input.userId, userConnections);
            }
            userConnections.add(input.connectionId);
            yield* Metric.update(daemonControlActiveConnectionsGauge, connections.size);
            return created;
          }),
        );
        const handle: ControlConnectionHandle = {
          observePing: () => observePing(connection),
        };

        const previousPresence = yield* coordination.getDaemonPresence(input.daemonId);
        // Reclaiming a suspended lease keeps `presenceId`/`claimSeq`, so the
        // session claims fenced by them stay valid and the browser never sees
        // this daemon leave the list. Runs inside the same acquireRelease as a
        // fresh claim so an interrupt still relinquishes whatever was taken.
        const acquireLease = Effect.gen(function* () {
          const resumePresenceId = input.resumePresenceId;
          if (resumePresenceId !== undefined) {
            const claimSeq = yield* coordination.resumeDaemonPresence({
              daemonId: input.daemonId,
              userId: input.userId,
              presenceId: resumePresenceId,
              connectionId: input.connectionId,
              zone: input.zone,
            });
            if (claimSeq !== null) {
              connection.presenceId = resumePresenceId;
              connection.leaseOrigin = 'resumed';
              return { _tag: 'Claimed' as const, claimSeq };
            }
            // The lease expired or was superseded while the daemon was away.
            // A fresh claim is a new lease, not a retry of the old one.
          }
          return yield* coordination.claimDaemonOnline({
            daemonId: input.daemonId,
            userId: input.userId,
            connectionId: input.connectionId,
            presenceId: input.presenceId,
            zone: input.zone,
          });
        });
        // acquireRelease masks interruption until the claim result is installed
        // and its release finalizer is registered in the owned connection
        // scope. If Redis stores the claim and this registration fiber is
        // interrupted immediately afterward, onExit closes the scope and the
        // fenced lease is still relinquished.
        const claim = yield* Scope.provide(
          Effect.acquireRelease(
            acquireLease.pipe(
              Effect.tap((claimed) =>
                Effect.sync(() => {
                  connection.claimSeq = claimed.claimSeq;
                  connection.presenceLeaseAcquired = true;
                }),
              ),
            ),
            (claimed) => finalizePresenceLease(connection, claimed),
          ),
          connection.scope,
        );
        if (claim._tag === 'Superseded') {
          return yield* new StaleDaemonPresence({
            daemonId: input.daemonId,
            presenceId: connection.presenceId,
            claimSeq: claim.claimSeq,
          });
        }
        if (connection.peerClosed) {
          return yield* new DaemonUnavailable({
            daemonId: input.daemonId,
            reason: 'socket_closed_during_registration',
          });
        }

        // Registration performs the first lease renewal itself: it is what
        // proves the claim is owned, and its revocation generation is what
        // `registered` carries.
        const [renewal] = yield* coordination.renewDaemonLeases([
          {
            daemonId: input.daemonId,
            userId: input.userId,
            presenceId: connection.presenceId,
            claimSeq: claim.claimSeq,
          },
        ]);
        if (renewal === undefined || renewal.presence !== 'refreshed') {
          return yield* new StaleDaemonPresence({
            daemonId: input.daemonId,
            presenceId: connection.presenceId,
            claimSeq: claim.claimSeq,
          });
        }

        yield* dependencies.touchDaemon(input.daemonId, input.daemonVersion);
        if (connection.peerClosed || connections.get(input.connectionId) !== connection) {
          return yield* new DaemonUnavailable({
            daemonId: input.daemonId,
            reason: 'socket_closed_during_registration',
          });
        }
        const previousLocalConnectionId = connectionIdByDaemonId.get(input.daemonId);
        connectionIdByDaemonId.set(input.daemonId, input.connectionId);
        linkConnection(connection);

        if (
          previousLocalConnectionId !== undefined &&
          previousLocalConnectionId !== input.connectionId
        ) {
          yield* retireSupersededConnection(previousLocalConnectionId);
        } else if (
          previousPresence !== null &&
          previousPresence.presenceId !== connection.presenceId &&
          previousPresence.ownerInstanceId !== coordination.instanceId
        ) {
          yield* publishSuperseded(previousPresence).pipe(
            Effect.catch((error) =>
              logWithLoggerEffect(logger, 'warn', 'daemon_control_superseded_publish_failed', {
                daemonId: input.daemonId,
                ...errorLogContext(error),
              }),
            ),
          );
        }

        yield* superviseConnectionWorker(connection, runConnectionInboundWorker(connection)).pipe(
          Effect.forkIn(connection.scope),
        );
        yield* superviseConnectionWorker(connection, runPresenceConvergenceWorker(connection)).pipe(
          Effect.forkIn(connection.scope),
        );
        const edges = yield* dependencies.edges;
        yield* sendFrame(
          connection,
          (() => {
            const ticket = stun.issue(now());
            return createDaemonControlRegisteredMessage(
              input.connectionId,
              connection.presenceId,
              claim.claimSeq,
              renewal.revocationGeneration,
              DAEMON_CONTROL_PING_INTERVAL_MS,
              DAEMON_CONTROL_SILENT_AFTER_MS,
              stun.serversFor(input.boxId),
              ticket.ticket,
              ticket.secret,
              ticket.lifetimeMs,
              edgeAttach.forDaemon(input.daemonId, now()),
              edges,
            );
          })(),
        );
        const revocationsApplied = yield* flushDaemonDelegationRevocations({
          daemonId: input.daemonId,
          userId: input.userId,
          ownerInstanceId: coordination.instanceId,
          connectionId: input.connectionId,
          presenceId: connection.presenceId,
          claimSeq: claim.claimSeq,
          state: 'online',
          updatedAt: now(),
          zone: input.zone,
        });
        if (!revocationsApplied) {
          yield* releaseConnection(connection.connectionId, {
            kind: 'lease_invalidated',
            reason: 'revocation_retry',
          });
          return handle;
        }
        connection.sessionReady = true;
        yield* logWithLoggerEffect(logger, 'info', 'daemon_control_registered', {
          daemonId: input.daemonId,
          connectionId: input.connectionId,
          presenceId: connection.presenceId,
          claimSeq: claim.claimSeq,
          leaseOrigin: connection.leaseOrigin,
        });
        // The online edge. Loss edges are published from inside their own Lua
        // transitions; this one is deliberately published here, after
        // `sessionReady`, so the device is never announced online before it can
        // admit a session. It covers `resumed` as well as `claimed`: both reach
        // here, and a resume is the degraded → online edge.
        yield* coordination.publishDeviceDelta(input.userId, {
          kind: 'presence',
          daemonId: input.daemonId,
          status: 'online',
        });
        // Strictly last, and only after `sessionReady`: a buffered session_start
        // replayed before the revocation flush would outrun a pending
        // revocation, and `session_start` admission is gated on `sessionReady`.
        yield* replayPresenceOutbox(connection);
        return handle;
      }).pipe(
        Effect.onExit((exit) =>
          exit._tag === 'Failure'
            ? releaseConnection(input.connectionId, {
                kind: 'lease_invalidated',
                reason: 'registration_failed',
              }).pipe(Effect.ignore)
            : Effect.void,
        ),
      );
    },

    receive(connectionId, frame) {
      const connection = connections.get(connectionId);
      if (connection === undefined || connection.claimSeq === null || connection.peerClosed) {
        return Effect.fail(
          new DaemonUnavailable({
            daemonId: connection?.daemonId ?? 'unknown',
            reason: 'connection_not_registered',
          }),
        );
      }
      const message = parseDaemonControlDaemonMessage(frame);
      if (message === null) {
        return releaseConnection(connectionId, {
          kind: 'lease_invalidated',
          reason: 'invalid_frame',
        });
      }
      return Effect.gen(function* () {
        const completed = yield* Deferred.make<void, RedisError | DaemonControlDeliveryError>();
        const accepted = Queue.offerUnsafe(connection.commandAckInbox, { message, completed });
        if (!accepted) {
          const overflow = new ControlBackpressure({
            daemonId: connection.daemonId,
            connectionId: connection.connectionId,
          });
          return yield* Metric.update(daemonControlInboundOverflowCounter, 1).pipe(
            Effect.andThen(
              Effect.result(
                releaseConnection(connectionId, {
                  kind: 'carrier_lost',
                  reason: 'inbound_overflow',
                }),
              ),
            ),
            Effect.andThen(Effect.fail(overflow)),
          );
        }
        Queue.offerUnsafe(connection.inboundWake, undefined);
        return yield* Deferred.await(completed);
      });
    },

    disconnect(connectionId, closeCode) {
      const connection = connections.get(connectionId);
      if (connection === undefined) {
        return Effect.void;
      }
      connection.peerClosed = true;
      if (connection.claimSeq === null) {
        return Effect.void;
      }
      return releaseConnection(
        connectionId,
        closeCode === DAEMON_SHUTDOWN_CLOSE_CODE
          ? { kind: 'lease_invalidated', reason: 'peer_shutdown' }
          : { kind: 'carrier_lost', reason: 'peer_disconnected' },
      );
    },

    pushRevocationGeneration(userId, generation) {
      const envelope: BrokerRevocationGeneration = {
        type: 'revocation_generation',
        version: BROKER_PROTOCOL_VERSION,
        userId,
        generation,
      };
      return redis.publish(BROKER_BROADCAST_CHANNEL, JSON.stringify(envelope));
    },

    startSession(input) {
      return Effect.gen(function* () {
        const commandId = crypto.randomUUID();
        // Read inside the caller's span, not at connection time: the control
        // socket was opened long before this request, so the connection carries
        // no useful context and only the command can.
        const traceparent = yield* currentTraceparent;
        return yield* sendCommandToPresence(
          input.presence,
          createDaemonControlSessionStartMessage(
            commandId,
            input.sessionId,
            input.browserNodeId,
            input.offer,
            traceparent,
          ),
        );
      });
    },

    cancelSession(input) {
      return Effect.gen(function* () {
        const presence = yield* coordination.getDaemonPresence(input.daemonId);
        if (presence === null || presence.userId !== input.userId) {
          return yield* new DaemonUnavailable({
            daemonId: input.daemonId,
            reason: 'daemon_presence_unavailable',
          });
        }
        const commandId = crypto.randomUUID();
        const traceparent = yield* currentTraceparent;
        yield* sendCommandToPresence(
          presence,
          createDaemonControlSessionCancelMessage(
            commandId,
            input.sessionId,
            input.browserNodeId,
            traceparent,
          ),
        );
      });
    },

    flushUserDelegationRevocations(userId) {
      return Effect.gen(function* () {
        const presences = yield* coordination.getUserDaemonPresence(userId);
        yield* Effect.forEach(
          presences,
          (presence) =>
            Effect.gen(function* () {
              const delivery = yield* Effect.result(flushDaemonDelegationRevocations(presence));
              if (Result.isSuccess(delivery) && delivery.success) return;
              yield* logWithLoggerEffect(logger, 'warn', 'daemon_control_revocation_flush_failed', {
                daemonId: presence.daemonId,
                ...(Result.isFailure(delivery)
                  ? errorLogContext(delivery.failure)
                  : { reason: 'revocation_not_applied' }),
              });
              yield* retireDelegationRevocationPresence(presence).pipe(
                Effect.catch((error) =>
                  logWithLoggerEffect(logger, 'warn', 'daemon_control_revocation_retire_failed', {
                    daemonId: presence.daemonId,
                    ...errorLogContext(error),
                  }),
                ),
              );
            }),
          { discard: true },
        );
      }).pipe(
        Effect.catch((error) =>
          logWithLoggerEffect(logger, 'warn', 'daemon_control_revocation_presence_lookup_failed', {
            userId,
            ...errorLogContext(error),
          }),
        ),
      );
    },

    healthSnapshot: () =>
      Effect.sync(() => ({
        brokerWorkersHealthy,
        livenessTickerHealthy,
        connectionWorkersHealthy,
        controlConnections: connections.size,
      })),
    awaitCriticalFailure:
      dependencies.criticalFailure === undefined
        ? Effect.never
        : Deferred.await(dependencies.criticalFailure),

    reportCriticalWorkerFailure(component, cause) {
      const defect =
        cause.reasons.find(Cause.isDieReason)?.defect ??
        new Error(`daemon control critical worker failed: ${component}`);
      return Effect.sync(() => {
        if (component === 'brokerWorkersHealthy') {
          brokerWorkersHealthy = false;
        } else if (component === 'livenessTickerHealthy') {
          livenessTickerHealthy = false;
        } else {
          connectionWorkersHealthy = false;
        }
      }).pipe(
        Effect.andThen(
          logWithLoggerEffect(logger, 'error', 'daemon_control_critical_worker_failed', {
            component,
            cause: Cause.pretty(cause),
          }),
        ),
        Effect.andThen(
          Metric.update(backgroundWorkerFailureFrequency, `daemon-control:${component}`),
        ),
        Effect.andThen(
          dependencies.criticalFailure === undefined
            ? Effect.void
            : Deferred.die(dependencies.criticalFailure, defect).pipe(Effect.asVoid),
        ),
      );
    },

    processBrokerFrame(frame) {
      const envelope = parseBrokerEnvelope(frame);
      if (envelope === null) {
        return logWithLoggerEffect(logger, 'warn', 'daemon_control_invalid_broker_frame');
      }
      if (envelope.type === 'revocation_generation') {
        return deliverRevocationGeneration(envelope.userId, envelope.generation);
      }
      if (envelope.ownerInstanceId !== coordination.instanceId) {
        return Effect.void;
      }
      if (envelope.type === 'command_result') {
        const pending = pendingRemoteCommands.get(envelope.commandId);
        if (
          pending === undefined ||
          envelope.requesterInstanceId !== coordination.instanceId ||
          pending.daemonId !== envelope.daemonId ||
          pending.presenceId !== envelope.presenceId ||
          pending.claimSeq !== envelope.claimSeq
        ) {
          return Effect.void;
        }
        return Deferred.succeed(pending.deferred, envelope).pipe(Effect.asVoid);
      }
      if (envelope.type === 'superseded') {
        const connection = connections.get(envelope.connectionId);
        if (
          connection === undefined ||
          connection.daemonId !== envelope.daemonId ||
          connection.presenceId !== envelope.presenceId ||
          connection.claimSeq !== envelope.claimSeq
        ) {
          return Effect.void;
        }
        return retireSupersededConnection(connection.connectionId).pipe(Effect.asVoid);
      }
      if (envelope.type === 'delegation_revocation_retry') {
        const connection = connections.get(envelope.connectionId);
        if (
          connection === undefined ||
          connection.daemonId !== envelope.daemonId ||
          connection.presenceId !== envelope.presenceId ||
          connection.claimSeq !== envelope.claimSeq
        ) {
          return Effect.void;
        }
        return releaseConnection(connection.connectionId, {
          kind: 'lease_invalidated',
          reason: 'revocation_retry',
        });
      }
      return handleBrokerCommandRequest(envelope);
    },

    livenessTick: Effect.gen(function* () {
      const tickAt = monotonicNow();

      // Liveness: the list is ordered by last ping, so the walk stops at the
      // first node still inside the silence window. Nodes already silent sit
      // ahead of it and are revisited only to check the hard timeout.
      let firstNonSilentDeadline = Number.POSITIVE_INFINITY;
      let node = liveList.head;
      while (node !== null) {
        const next = node.liveLink.next;
        const silenceMs = tickAt - node.lastSeenAtMono;
        if (silenceMs >= DAEMON_CONTROL_PING_TIMEOUT_MS) {
          yield* Metric.update(daemonControlPingTimeoutCounter, 1);
          yield* logWithLoggerEffect(logger, 'warn', 'daemon_control_ping_timeout', {
            daemonId: node.daemonId,
            connectionId: node.connectionId,
            silenceMs: Math.round(silenceMs),
          }).pipe(
            Effect.andThen(
              releaseConnection(node.connectionId, {
                kind: 'carrier_lost',
                reason: 'ping_timeout',
              }),
            ),
            Effect.catch((error) => dieOnReplyError(error, 'daemon_control_ping_timeout_failed')),
          );
        } else if (silenceMs >= DAEMON_CONTROL_SILENT_AFTER_MS) {
          if (!node.silent) {
            node.silent = true;
            Queue.offerUnsafe(node.presenceWake, undefined);
          }
        } else {
          firstNonSilentDeadline = node.lastSeenAtMono + DAEMON_CONTROL_SILENT_AFTER_MS;
          break;
        }
        node = next;
      }

      // Leases: everything at the head that is due, renewed in bounded chunks.
      // `leaseAttemptedAtMono` advances on attempt, so a renewal that keeps
      // failing cannot pin the head in the past and spin the ticker.
      const due: ControlConnection[] = [];
      let leaseNode = leaseList.head;
      while (
        leaseNode !== null &&
        tickAt - leaseNode.leaseAttemptedAtMono >= DAEMON_CONTROL_LEASE_RENEWAL_MS
      ) {
        due.push(leaseNode);
        leaseNode = leaseNode.leaseLink.next;
      }
      let renewalFailed = false;
      for (let offset = 0; offset < due.length; offset += LEASE_RENEWAL_CHUNK) {
        const chunk = due
          .slice(offset, offset + LEASE_RENEWAL_CHUNK)
          .filter((connection) => connection.linked && connection.claimSeq !== null);
        if (chunk.length === 0) continue;
        for (const connection of chunk) {
          connection.leaseAttemptedAtMono = tickAt;
          leaseList.moveToTail(connection);
        }
        // The registry read rides with the renewal: one statement of the edges
        // per chunk, and a failed read retries the chunk as a failed renewal.
        const renewals = yield* Effect.result(
          Effect.all([
            coordination.renewDaemonLeases(
              chunk.map((connection) => ({
                daemonId: connection.daemonId,
                userId: connection.userId,
                presenceId: connection.presenceId,
                claimSeq: connection.claimSeq ?? 0,
              })),
            ),
            dependencies.edges,
          ]),
        );
        if (Result.isFailure(renewals)) {
          if (renewals.failure instanceof RedisReplyError) {
            return yield* Effect.die(renewals.failure);
          }
          renewalFailed = true;
          yield* logWithLoggerEffect(logger, 'error', 'daemon_control_lease_renewal_failed', {
            connections: chunk.length,
            ...errorLogContext(renewals.failure),
          });
          continue;
        }
        // Daemons this walk proved alive. A renewed lease alone is not that
        // proof — the lease is renewed for a silent connection too, whose
        // socket is up while nothing behind it has answered a ping. Recording
        // liveness there would keep `last_seen` advancing for a machine that
        // has already stopped responding, which is exactly the moment the
        // device list stops being able to say anything else about it.
        const provenAlive: string[] = [];
        const [renewed, edges] = renewals.success;
        for (let index = 0; index < chunk.length; index += 1) {
          const connection = chunk[index];
          const renewal = renewed[index];
          if (connection === undefined || renewal === undefined || !connection.linked) continue;
          if (renewal.presence === 'refreshed') {
            connection.leaseRenewedAtMono = tickAt;
            if (!connection.silent) provenAlive.push(connection.daemonId);
            // Silence convergence can lose a Redis round trip; the renewal is
            // the bound on how long the stored state may lag the observed one.
            if (connection.silentCommitted !== connection.silent) {
              Queue.offerUnsafe(connection.presenceWake, undefined);
            }
            const ticket = stun.issue(now());
            yield* sendFrame(
              connection,
              createDaemonControlLeaseMessage(
                renewal.revocationGeneration,
                ticket.ticket,
                ticket.secret,
                ticket.lifetimeMs,
                edgeAttach.forDaemon(connection.daemonId, now()),
                edges,
              ),
            ).pipe(
              // One backpressured daemon must not abort the walk; the ticket it
              // missed is re-issued on the next renewal, well inside its life.
              Effect.catch((error) =>
                logWithLoggerEffect(logger, 'warn', 'daemon_control_lease_send_failed', {
                  daemonId: connection.daemonId,
                  connectionId: connection.connectionId,
                  ...errorLogContext(error),
                }),
              ),
            );
          } else if (renewal.presence === 'not-owner') {
            yield* retireSupersededConnection(connection.connectionId).pipe(
              Effect.catch((error) => dieOnReplyError(error, 'daemon_control_lease_retire_failed')),
            );
          } else {
            // A malformed reply for this one claim retires this one connection;
            // it is not a reason to take the ticker — and the instance — down.
            yield* releaseConnection(connection.connectionId, {
              kind: 'lease_invalidated',
              reason: 'worker_defect',
            }).pipe(
              Effect.catch((error) => dieOnReplyError(error, 'daemon_control_lease_retire_failed')),
            );
          }
        }
        if (provenAlive.length > 0) {
          // One statement for the chunk, and never a reason to abort the walk:
          // a lost liveness write costs a `last_seen` that is one renewal
          // period stale, which the next renewal corrects.
          yield* dependencies.touchDaemonsSeen(provenAlive).pipe(
            Effect.catch((error) =>
              logWithLoggerEffect(logger, 'warn', 'daemon_control_last_seen_write_failed', {
                daemons: provenAlive.length,
                ...errorLogContext(error),
              }),
            ),
          );
        }
      }

      const liveHead = liveList.head;
      const liveDeadline =
        liveHead === null
          ? Number.POSITIVE_INFINITY
          : Math.min(
              liveHead.lastSeenAtMono +
                (liveHead.silent ? DAEMON_CONTROL_PING_TIMEOUT_MS : DAEMON_CONTROL_SILENT_AFTER_MS),
              firstNonSilentDeadline,
            );
      const leaseHead = leaseList.head;
      const leaseDeadline = renewalFailed
        ? tickAt + LEASE_RENEWAL_RETRY_MS
        : leaseHead === null
          ? Number.POSITIVE_INFINITY
          : leaseHead.leaseAttemptedAtMono + DAEMON_CONTROL_LEASE_RENEWAL_MS;
      const deadline = Math.min(liveDeadline, leaseDeadline);
      if (!Number.isFinite(deadline)) {
        armedDeadlineMono = Number.POSITIVE_INFINITY;
        return null;
      }
      const delayMs = Math.max(LIVENESS_TICK_FLOOR_MS, deadline - monotonicNow());
      armedDeadlineMono = monotonicNow() + delayMs;
      return delayMs;
    }),

    runLivenessTicker: Effect.gen(function* () {
      while (true) {
        const delayMs = yield* service.livenessTick;
        if (delayMs === null) {
          yield* Queue.take(tickerWake);
          continue;
        }
        yield* Effect.race(Effect.sleep(`${delayMs} millis`), Queue.take(tickerWake));
      }
    }),

    shutdown: Effect.suspend(() => {
      if (closed) return Effect.void;
      closed = true;
      const remoteCommands = Array.from(pendingRemoteCommands);
      pendingRemoteCommands.clear();
      const connectionIds = Array.from(connections.keys());
      return Effect.gen(function* () {
        yield* Effect.forEach(
          remoteCommands,
          ([commandId, pending]) =>
            Deferred.succeed(pending.deferred, {
              type: 'command_result',
              version: BROKER_PROTOCOL_VERSION,
              requesterInstanceId: coordination.instanceId,
              ownerInstanceId: coordination.instanceId,
              daemonId: pending.daemonId,
              presenceId: pending.presenceId,
              claimSeq: pending.claimSeq,
              commandId,
              outcome: 'unavailable',
              reason: 'control_service_closed',
            }),
          { discard: true },
        );
        yield* Effect.forEach(
          connectionIds,
          (connectionId) =>
            releaseConnection(connectionId, {
              kind: 'carrier_lost',
              reason: 'service_shutdown',
            }).pipe(Effect.ignore),
          { discard: true },
        );
      });
    }),
  };

  return service;

  /**
   * Settles every command still awaiting this presence and drops its map.
   * Called only when the lease itself is gone — a carrier drop alone must not
   * reach here, or a resume would find nothing left to deliver.
   */
  function retirePresenceOutbox(
    presenceId: string,
    daemonId: string,
    reason: 'socket_closed' | 'control_service_closed',
  ): Effect.Effect<void> {
    return Effect.suspend(() => {
      const pendingCommands = pendingByPresence.get(presenceId);
      if (pendingCommands === undefined) return Effect.void;
      pendingByPresence.delete(presenceId);
      const pending = Array.from(pendingCommands.values());
      pendingCommands.clear();
      return Effect.forEach(
        pending,
        (entry) => Deferred.fail(entry.deferred, new DaemonUnavailable({ daemonId, reason })),
        { discard: true },
      );
    });
  }

  /**
   * Re-sends every command still parked for this presence to the carrier that
   * just took it over. Their callers are still awaiting the same deferreds, so
   * a command issued moments before a blip completes normally instead of
   * timing out.
   *
   * Replayed in admission order: `Map` iteration is insertion order by spec, and
   * these were inserted as they were admitted, so no explicit sort is needed.
   */
  function replayPresenceOutbox(connection: ControlConnection): Effect.Effect<void> {
    return Effect.suspend(() => {
      const pendingCommands = pendingByPresence.get(connection.presenceId);
      if (pendingCommands === undefined || pendingCommands.size === 0) return Effect.void;
      return Effect.forEach(
        Array.from(pendingCommands.values()),
        (entry) =>
          sendFrame(connection, entry.command).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                entry.connectionId = connection.connectionId;
              }),
            ),
            Effect.andThen(
              logWithLoggerEffect(logger, 'info', 'daemon_control_command_replayed', {
                daemonId: connection.daemonId,
                presenceId: connection.presenceId,
                commandId: entry.command.commandId,
              }),
            ),
            // A send failure is not fatal: the command stays pending and the
            // caller's own timeout still governs.
            Effect.ignore,
          ),
        { discard: true },
      );
    });
  }

  function finalizePresenceLease(
    connection: ControlConnection,
    claim: ClaimDaemonOnlineResult,
  ): Effect.Effect<void> {
    const cleanup =
      claim._tag === 'Superseded'
        ? retirePresenceOutbox(connection.presenceId, connection.daemonId, 'socket_closed')
        : Effect.gen(function* () {
            // A scope that closed without a recorded teardown is unreachable
            // today — only `releaseConnection` closes it — so treat the absence
            // as an invalidated lease rather than silently holding one.
            const teardown = connection.teardownReason;
            if (teardown === null) {
              yield* logWithLoggerEffect(logger, 'error', 'daemon_control_teardown_unattributed', {
                daemonId: connection.daemonId,
                presenceId: connection.presenceId,
              });
            }
            // `sessionReady` is the "registration actually completed" mark. A
            // connection that died mid-registration has no established lease to
            // hold, and testing it here rather than at each call site keeps the
            // decision correct regardless of whether the peer close or the
            // registration failure reaches teardown first.
            if (
              teardown !== null &&
              controlLeaseDisposition(teardown) === 'suspend' &&
              connection.sessionReady
            ) {
              const suspended = yield* coordination.suspendDaemonPresence({
                daemonId: connection.daemonId,
                userId: connection.userId,
                presenceId: connection.presenceId,
                claimSeq: claim.claimSeq,
              });
              if (suspended) {
                // The lease and its session claims survive, and the degraded
                // edge was published from inside the suspend transition.
                // Pending commands are deliberately left intact for the
                // connection that resumes it. Nothing retires them here: each
                // one is already bounded by its caller's own timeout, and the
                // presence entry drops as soon as the last one settles, so a
                // lease that never resumes leaves nothing behind either way.
                return;
              }
              // Losing the CAS means this presence is no longer current, so
              // there is nothing left to hold. Fall through to full retirement.
            }
            yield* retirePresenceOutbox(
              connection.presenceId,
              connection.daemonId,
              'socket_closed',
            );
            const removed = yield* coordination.unmarkDaemonOnline({
              daemonId: connection.daemonId,
              userId: connection.userId,
              presenceId: connection.presenceId,
              claimSeq: claim.claimSeq,
              // A resume rewrites the stored carrier, so retiring by lease
              // identity alone would let a departing connection retire the
              // lease its own replacement is already serving.
              connectionId: connection.connectionId,
            });
            if (!removed) return;
            // The offline edge was published from inside the retirement, ahead
            // of this session bookkeeping, so a bookkeeping failure cannot
            // leave subscribed browsers showing the device as online.
            yield* coordination.removeDaemonSessions({
              daemonId: connection.daemonId,
              userId: connection.userId,
              presenceId: connection.presenceId,
              claimSeq: claim.claimSeq,
            });
          });
    return Effect.exit(cleanup).pipe(
      Effect.flatMap((exit) => Deferred.done(connection.presenceLeaseFinalized, exit)),
      Effect.asVoid,
    );
  }

  /**
   * A `RedisReplyError` means Redis answered with something this code cannot
   * interpret; the existing convention is to die rather than carry on against
   * a misbehaving store. Anything else is logged and the walk continues.
   */
  function dieOnReplyError(error: unknown, eventName: string): Effect.Effect<void> {
    return error instanceof RedisReplyError
      ? Effect.die(error)
      : logWithLoggerEffect(logger, 'error', eventName, errorLogContext(error));
  }

  /**
   * Fans a revoke-all generation out to this instance's connections for the
   * user. Send failures are logged, not propagated: the next `lease` carries
   * the same generation, so a dropped push costs at most one renewal period.
   */
  function deliverRevocationGeneration(userId: string, generation: number): Effect.Effect<void> {
    const connectionIds = connectionIdsByUserId.get(userId);
    if (connectionIds === undefined) return Effect.void;
    return Effect.forEach(
      Array.from(connectionIds),
      (connectionId) => {
        const connection = connections.get(connectionId);
        if (connection === undefined || connection.claimSeq === null || connection.peerClosed) {
          return Effect.void;
        }
        return sendFrame(connection, createDaemonControlRevocationMessage(generation)).pipe(
          Effect.catch((error) =>
            logWithLoggerEffect(logger, 'warn', 'daemon_control_revocation_push_failed', {
              daemonId: connection.daemonId,
              connectionId,
              ...errorLogContext(error),
            }),
          ),
        );
      },
      { discard: true },
    );
  }

  /**
   * Drives the stored presence state toward the observed one.
   *
   * `silent` flips in the liveness walk and on the ping path; the two CAS
   * scripts that record it would race if fired from there directly. One fiber
   * per connection, woken by a sliding queue, serialises them: latest intent
   * wins and no update is lost. It is deliberately not folded into the inbound
   * worker, where a slow Redis round trip would delay a `session_start` ack.
   */
  function runPresenceConvergenceWorker(connection: ControlConnection): Effect.Effect<never> {
    return Effect.gen(function* () {
      while (true) {
        yield* Queue.take(connection.presenceWake);
        let attempts = 0;
        while (
          connection.silentCommitted !== connection.silent &&
          !connection.peerClosed &&
          connection.claimSeq !== null &&
          attempts < 3
        ) {
          attempts += 1;
          const target = connection.silent;
          const identity = {
            daemonId: connection.daemonId,
            userId: connection.userId,
            presenceId: connection.presenceId,
            claimSeq: connection.claimSeq,
            connectionId: connection.connectionId,
          };
          const outcome = yield* (
            target
              ? coordination.markDaemonSilent(identity)
              : coordination.clearDaemonSilent(identity)
          ).pipe(
            Effect.catch((error) =>
              error instanceof RedisReplyError
                ? Effect.die(error)
                : logWithLoggerEffect(
                    logger,
                    'warn',
                    'daemon_control_presence_convergence_failed',
                    { daemonId: connection.daemonId, ...errorLogContext(error) },
                  ).pipe(Effect.as('retry' as const)),
            ),
          );
          if (outcome === 'not-current') break;
          if (outcome === 'retry') continue;
          connection.silentCommitted = target;
          if (outcome === 'changed') {
            yield* Metric.update(
              daemonControlSilentTransitionFrequency,
              target ? 'silent' : 'recovered',
            );
          }
        }
      }
    });
  }

  function superviseConnectionWorker(
    connection: ControlConnection,
    worker: Effect.Effect<never>,
  ): Effect.Effect<never> {
    return worker.pipe(
      Effect.onExit((exit) => {
        if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) return Effect.void;
        const cause = Exit.isFailure(exit)
          ? exit.cause
          : Cause.die(new Error('daemon control inbound worker completed unexpectedly'));
        return service.reportCriticalWorkerFailure('connectionWorkersHealthy', cause).pipe(
          Effect.andThen(
            releaseConnection(connection.connectionId, {
              kind: 'lease_invalidated',
              reason: 'worker_defect',
            }),
          ),
          Effect.ignore,
        );
      }),
    );
  }

  function runConnectionInboundWorker(connection: ControlConnection): Effect.Effect<never> {
    return Effect.gen(function* () {
      while (true) {
        yield* Queue.take(connection.inboundWake);
        while (true) {
          // The mailbox carries command acknowledgements only. Liveness rides
          // on transport-level ping frames that never enter it, so nothing a
          // daemon sends on a cadence can sit ahead of an admitted command's
          // result, and FIFO order stays deterministic.
          const commandAck = yield* Queue.poll(connection.commandAckInbox);
          if (Option.isNone(commandAck)) break;
          yield* processQueuedInboundMessage(connection, commandAck.value);
        }
      }
    });
  }

  function processQueuedInboundMessage(
    connection: ControlConnection,
    inbound: InboundControlMessage,
  ): Effect.Effect<void> {
    return Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        yield* Effect.annotateCurrentSpan(
          spanAttributes({
            'merkur.daemon.id': connection.daemonId,
            'merkur.connection.id': connection.connectionId,
            'merkur.presence.id': connection.presenceId,
            'merkur.claim.seq': connection.claimSeq ?? 0,
            'merkur.message.type': inbound.message.type,
            ...(inbound.message.type === 'command_ack'
              ? { 'merkur.command.id': inbound.message.commandId }
              : {}),
          }),
        );
        const exit = yield* Effect.exit(
          restore(processInboundMessage(connection, inbound.message)),
        );
        yield* Deferred.done(inbound.completed, exit);
        if (Exit.isSuccess(exit)) return;
        if (Cause.hasDies(exit.cause)) {
          const defect = exit.cause.reasons.find(Cause.isDieReason)?.defect;
          return yield* Effect.die(
            defect ?? new Error('daemon control inbound worker failed with an unknown defect'),
          );
        }
        if (Cause.hasInterrupts(exit.cause)) {
          return yield* Effect.interrupt;
        }
      }).pipe(Effect.withSpan('daemon-control.inbound')),
    );
  }

  function processInboundMessage(
    connection: ControlConnection,
    message: DaemonControlDaemonMessage,
  ): Effect.Effect<void, RedisError | DaemonControlDeliveryError> {
    const pending = pendingByPresence.get(connection.presenceId)?.get(message.commandId);
    if (pending === undefined) {
      return logWithLoggerEffect(logger, 'warn', 'daemon_control_unmatched_command_ack', {
        daemonId: connection.daemonId,
        commandId: message.commandId,
      });
    }
    return Effect.gen(function* () {
      const claimSeq = connection.claimSeq;
      const current = yield* coordination.getDaemonPresence(connection.daemonId);
      if (
        claimSeq === null ||
        current === null ||
        current.userId !== connection.userId ||
        current.ownerInstanceId !== coordination.instanceId ||
        current.connectionId !== connection.connectionId ||
        current.presenceId !== connection.presenceId ||
        current.claimSeq !== claimSeq
      ) {
        const stale = new StaleDaemonPresence({
          daemonId: connection.daemonId,
          presenceId: connection.presenceId,
          claimSeq: claimSeq ?? 0,
        });
        yield* Deferred.fail(pending.deferred, stale);
        yield* retireSupersededConnection(connection.connectionId);
        return yield* stale;
      }
      yield* Deferred.succeed(pending.deferred, message);
    });
  }

  function sendCommandToPresence(
    expectedPresence: DaemonPresence,
    command: DaemonControlCommandMessage,
  ): Effect.Effect<void, RedisError | DaemonControlDeliveryError> {
    const delivery = Effect.gen(function* () {
      const current = yield* coordination.getDaemonPresence(expectedPresence.daemonId);
      if (current === null || current.userId !== expectedPresence.userId) {
        return yield* new DaemonUnavailable({
          daemonId: expectedPresence.daemonId,
          reason: 'daemon_presence_unavailable',
        });
      }
      if (!isSamePresenceLease(current, expectedPresence)) {
        return yield* new StaleDaemonPresence({
          daemonId: expectedPresence.daemonId,
          presenceId: expectedPresence.presenceId,
          claimSeq: expectedPresence.claimSeq,
        });
      }
      // Route on the freshly-read owner, never the caller's copy: a resume onto
      // another replica moves ownership without changing the lease.
      if (current.ownerInstanceId === coordination.instanceId) {
        return yield* deliverLocalCommand(current, command);
      }
      return yield* deliverRemoteCommand(current, command);
    });
    return instrumentCommandDelivery(expectedPresence, command, delivery);
  }

  function flushDaemonDelegationRevocations(
    presence: DaemonPresence,
  ): Effect.Effect<boolean, InfrastructureError | RedisError | DaemonControlDeliveryError> {
    const outbox = dependencies.revocationOutbox;
    if (outbox === undefined) return Effect.succeed(true);
    return Effect.gen(function* () {
      const pending = yield* outbox.listPending(presence.daemonId);
      // Revocations flush from an outbox, so the span in scope belongs to
      // whatever triggered the flush rather than to the request that queued the
      // entry. That is still the right context: it is the work happening now.
      const traceparent = yield* currentTraceparent;
      for (const entry of pending) {
        let command: DaemonControlCommandMessage;
        try {
          command = createDaemonControlDelegationRevokeMessage(
            entry.commandId,
            parseUserDelegationCertificate(JSON.parse(entry.actorCertificateJson)),
            parseDelegationRevocationStatement(JSON.parse(entry.revocationJson)),
            traceparent,
          );
        } catch {
          yield* outbox.markRejected(entry.commandId, 'invalid_outbox_payload');
          return false;
        }
        const delivered = yield* Effect.result(sendCommandToPresence(presence, command));
        if (Result.isSuccess(delivered)) {
          yield* outbox.markAcknowledged(entry.commandId, now());
          continue;
        }
        if (delivered.failure instanceof ControlCommandRejected) {
          yield* outbox.markRejected(entry.commandId, delivered.failure.reason);
          return false;
        }
        return yield* delivered.failure;
      }
      return true;
    });
  }

  function instrumentCommandDelivery(
    presence: DaemonPresence,
    command: DaemonControlCommandMessage,
    delivery: Effect.Effect<void, RedisError | DaemonControlDeliveryError>,
  ): Effect.Effect<void, RedisError | DaemonControlDeliveryError> {
    return Effect.gen(function* () {
      yield* Effect.annotateCurrentSpan(
        spanAttributes({
          'merkur.daemon.id': presence.daemonId,
          'merkur.command.id': command.commandId,
          'merkur.presence.id': presence.presenceId,
          'merkur.claim.seq': presence.claimSeq,
          'merkur.command.type': command.type,
        }),
      );
      const startedAt = yield* Clock.currentTimeMillis;
      const exit = yield* Effect.exit(delivery);
      const completedAt = yield* Clock.currentTimeMillis;
      yield* Metric.update(daemonControlDeliveryLatencyMs, Math.max(0, completedAt - startedAt));
      yield* Metric.update(
        daemonControlDeliveryOutcomeFrequency,
        daemonControlDeliveryOutcome(exit),
      );
      return yield* exit;
    }).pipe(Effect.withSpan('daemon-control.delivery'));
  }

  function deliverLocalCommand(
    expectedPresence: DaemonPresence,
    command: DaemonControlCommandMessage,
  ): Effect.Effect<void, RedisError | DaemonControlDeliveryError> {
    return Effect.gen(function* () {
      const current = yield* coordination.getDaemonPresence(expectedPresence.daemonId);
      if (
        current === null ||
        current.ownerInstanceId !== coordination.instanceId ||
        !isSamePresenceLease(current, expectedPresence)
      ) {
        return yield* new StaleDaemonPresence({
          daemonId: expectedPresence.daemonId,
          presenceId: expectedPresence.presenceId,
          claimSeq: expectedPresence.claimSeq,
        });
      }

      const pending: PendingLocalCommand = {
        command,
        connectionId: current.connectionId,
        deferred: yield* Deferred.make<
          Extract<DaemonControlDaemonMessage, { readonly type: 'command_ack' }>,
          DaemonUnavailable | StaleDaemonPresence
        >(),
      };
      const admission = yield* Effect.sync(() => {
        if (closed) return { _tag: 'Closed' } as const;
        // Resolve the socket from the presence we just read, not the caller's
        // copy: after a resume the lease is unchanged but the connection is new.
        const connection = connections.get(current.connectionId);
        if (
          connection === undefined ||
          connection.peerClosed ||
          connection.presenceId !== current.presenceId ||
          connection.claimSeq !== current.claimSeq
        ) {
          return { _tag: 'Unavailable' } as const;
        }
        if (command.type === 'session_start' && !connection.sessionReady) {
          return { _tag: 'NotReady', connection } as const;
        }
        // Read without creating: a rejected command must not leave an entry
        // behind for a presence that may never reach a release path on this
        // replica. Only an accepted command creates one.
        const admitted = pendingByPresence.get(current.presenceId);
        const inFlight = admitted?.get(command.commandId);
        if (inFlight !== undefined && inFlight.connectionId === connection.connectionId) {
          return { _tag: 'Backpressure', connection } as const;
        }
        if ((admitted?.size ?? 0) >= maxPendingCommandsPerConnection && inFlight === undefined) {
          return { _tag: 'Backpressure', connection } as const;
        }
        // An entry stranded on a departed carrier can never be acknowledged: the
        // socket that would answer it is gone. Superseding it is what lets the
        // registration-time revocation flush re-send its durable commandId onto
        // the resumed carrier, instead of colliding with its own stranded
        // delivery and failing registration — which would retire the lease the
        // resume just recovered, along with every session claim fenced by it.
        pendingCommandsFor(current.presenceId).set(command.commandId, pending);
        return { _tag: 'Accepted', connection, superseded: inFlight } as const;
      });
      if (admission._tag === 'Closed') {
        return yield* new DaemonUnavailable({
          daemonId: expectedPresence.daemonId,
          reason: 'control_service_closed',
        });
      }
      if (admission._tag === 'Unavailable') {
        return yield* new DaemonUnavailable({
          daemonId: expectedPresence.daemonId,
          reason: 'owner_socket_unavailable',
        });
      }
      if (admission._tag === 'Backpressure') {
        return yield* new ControlBackpressure({
          daemonId: admission.connection.daemonId,
          connectionId: admission.connection.connectionId,
        });
      }
      if (admission._tag === 'NotReady') {
        return yield* new DaemonUnavailable({
          daemonId: admission.connection.daemonId,
          reason: 'delegation_revocations_pending',
        });
      }
      const connection = admission.connection;
      if (admission.superseded !== undefined) {
        // Its carrier is gone, so its ack can never arrive. Fail it now rather
        // than leaving the caller to sit out its own timeout.
        yield* Deferred.fail(
          admission.superseded.deferred,
          new DaemonUnavailable({
            daemonId: connection.daemonId,
            reason: 'owner_socket_unavailable',
          }),
        );
        yield* logWithLoggerEffect(logger, 'info', 'daemon_control_command_superseded', {
          daemonId: connection.daemonId,
          presenceId: current.presenceId,
          commandId: command.commandId,
          strandedOn: admission.superseded.connectionId,
          resentOn: connection.connectionId,
        });
      }
      const acknowledge = Deferred.await(pending.deferred).pipe(
        Effect.timeoutOrElse({
          duration: `${commandTimeoutMs} millis`,
          orElse: () =>
            Effect.fail(
              new ControlDeliveryTimeout({
                daemonId: connection.daemonId,
                commandId: command.commandId,
              }),
            ),
        }),
      );

      const result = yield* Effect.result(
        sendFrame(connection, command).pipe(Effect.andThen(acknowledge)),
      ).pipe(
        // `ensuring`, not `tap`: this runs on success, failure, timeout and
        // interruption alike. A path that skipped it would leak an outbox slot
        // that nothing ever reclaims, and the slot is what bounds admission.
        Effect.ensuring(
          Effect.sync(() => {
            const pendingCommands = pendingByPresence.get(current.presenceId);
            if (pendingCommands === undefined) return;
            // Remove only our own registration. A superseded delivery settles
            // and runs this after its replacement is already installed under the
            // same commandId, and evicting that would strand the live delivery
            // with no entry for its ack to match.
            if (pendingCommands.get(command.commandId) !== pending) return;
            pendingCommands.delete(command.commandId);
            // Drop the presence entry once it holds nothing. A suspended lease
            // keeps its entry only while commands are actually waiting for the
            // carrier that resumes it; an empty one would otherwise outlive a
            // presence that never resumes, for the life of the process.
            if (pendingCommands.size === 0) {
              pendingByPresence.delete(current.presenceId);
            }
          }),
        ),
      );
      if (Result.isFailure(result)) {
        return yield* result.failure;
      }
      if (result.success.status === 'rejected') {
        return yield* new ControlCommandRejected({
          daemonId: connection.daemonId,
          commandId: command.commandId,
          reason: result.success.reason,
        });
      }
    });
  }

  function deliverRemoteCommand(
    presence: DaemonPresence,
    command: DaemonControlCommandMessage,
  ): Effect.Effect<void, RedisError | DaemonControlDeliveryError> {
    return Effect.gen(function* () {
      const pending: PendingRemoteCommand = {
        daemonId: presence.daemonId,
        presenceId: presence.presenceId,
        claimSeq: presence.claimSeq,
        deferred: yield* Deferred.make<BrokerCommandResult>(),
      };
      const admission = yield* Effect.sync(() => {
        if (closed) return 'closed' as const;
        if (
          pendingRemoteCommands.size >= maxPendingRemoteCommands ||
          pendingRemoteCommands.has(command.commandId)
        ) {
          return 'backpressure' as const;
        }
        pendingRemoteCommands.set(command.commandId, pending);
        return 'accepted' as const;
      });
      if (admission === 'closed') {
        return yield* new DaemonUnavailable({
          daemonId: presence.daemonId,
          reason: 'control_service_closed',
        });
      }
      if (admission === 'backpressure') {
        return yield* new ControlBackpressure({
          daemonId: presence.daemonId,
          connectionId: presence.connectionId,
        });
      }
      const currentSpan = yield* Effect.currentSpan.pipe(Effect.orDie);
      const request: BrokerCommandRequest = {
        type: 'command_request',
        version: BROKER_PROTOCOL_VERSION,
        requesterInstanceId: coordination.instanceId,
        ownerInstanceId: presence.ownerInstanceId,
        daemonId: presence.daemonId,
        userId: presence.userId,
        connectionId: presence.connectionId,
        presenceId: presence.presenceId,
        claimSeq: presence.claimSeq,
        trace: {
          traceId: currentSpan.traceId,
          spanId: currentSpan.spanId,
          sampled: currentSpan.sampled,
        },
        command,
      };
      const response = yield* Effect.result(
        redis
          .publish(brokerChannelForInstance(presence.ownerInstanceId), JSON.stringify(request))
          .pipe(
            Effect.andThen(Deferred.await(pending.deferred)),
            Effect.timeoutOrElse({
              duration: `${commandTimeoutMs} millis`,
              orElse: () =>
                Effect.fail(
                  new ControlDeliveryTimeout({
                    daemonId: presence.daemonId,
                    commandId: command.commandId,
                  }),
                ),
            }),
          ),
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            pendingRemoteCommands.delete(command.commandId);
          }),
        ),
      );
      if (Result.isFailure(response)) {
        return yield* response.failure;
      }
      return yield* brokerResultToEffect(response.success);
    });
  }

  function handleBrokerCommandRequest(
    request: BrokerCommandRequest,
  ): Effect.Effect<void, RedisError> {
    const expectedPresence: DaemonPresence = {
      daemonId: request.daemonId,
      userId: request.userId,
      ownerInstanceId: request.ownerInstanceId,
      connectionId: request.connectionId,
      presenceId: request.presenceId,
      claimSeq: request.claimSeq,
      // Synthesised for the lease fence only, like `updatedAt` below: delivery
      // compares lease identity, never disposition, so a suspended presence is
      // still a legitimate delivery target.
      state: 'online',
      updatedAt: 1,
      // Same reasoning as `state` and `updatedAt`: the fence compares lease
      // identity, and location is not part of that identity.
      zone: null,
    };
    return Effect.gen(function* () {
      yield* Effect.annotateCurrentSpan(
        spanAttributes({
          'merkur.daemon.id': request.daemonId,
          'merkur.command.id': request.command.commandId,
          'merkur.presence.id': request.presenceId,
          'merkur.claim.seq': request.claimSeq,
          'merkur.requester.instance_id': request.requesterInstanceId,
          'merkur.owner.instance_id': request.ownerInstanceId,
        }),
      );
      const command = request.command;
      const delivery = yield* Effect.result(deliverLocalCommand(expectedPresence, command));
      if (Result.isFailure(delivery) && delivery.failure instanceof RedisReplyError) {
        return yield* delivery.failure;
      }
      const response = createBrokerCommandResult(request, delivery);
      yield* redis.publish(
        brokerChannelForInstance(request.requesterInstanceId),
        JSON.stringify(response),
      );
    }).pipe(
      Effect.withSpan('daemon-control.broker-delivery', {
        parent: Tracer.externalSpan(request.trace),
      }),
    );
  }

  function publishSuperseded(presence: DaemonPresence): Effect.Effect<void, RedisError> {
    const message: BrokerSuperseded = {
      type: 'superseded',
      version: BROKER_PROTOCOL_VERSION,
      ownerInstanceId: presence.ownerInstanceId,
      daemonId: presence.daemonId,
      connectionId: presence.connectionId,
      presenceId: presence.presenceId,
      claimSeq: presence.claimSeq,
    };
    return redis.publish(
      brokerChannelForInstance(presence.ownerInstanceId),
      JSON.stringify(message),
    );
  }

  function retireDelegationRevocationPresence(
    presence: DaemonPresence,
  ): Effect.Effect<void, RedisError> {
    if (presence.ownerInstanceId !== coordination.instanceId) {
      const message: BrokerDelegationRevocationRetry = {
        type: 'delegation_revocation_retry',
        version: BROKER_PROTOCOL_VERSION,
        ownerInstanceId: presence.ownerInstanceId,
        daemonId: presence.daemonId,
        connectionId: presence.connectionId,
        presenceId: presence.presenceId,
        claimSeq: presence.claimSeq,
      };
      return redis.publish(
        brokerChannelForInstance(presence.ownerInstanceId),
        JSON.stringify(message),
      );
    }
    const connection = connections.get(presence.connectionId);
    if (
      connection === undefined ||
      connection.daemonId !== presence.daemonId ||
      connection.userId !== presence.userId ||
      connection.presenceId !== presence.presenceId ||
      connection.claimSeq !== presence.claimSeq
    ) {
      return Effect.void;
    }
    return releaseConnection(connection.connectionId, {
      kind: 'lease_invalidated',
      reason: 'revocation_retry',
    });
  }

  function retireSupersededConnection(connectionId: string): Effect.Effect<void, RedisError> {
    const connection = connections.get(connectionId);
    if (connection === undefined) return Effect.void;
    const notification = sendFrame(connection, createDaemonControlSupersededMessage()).pipe(
      Effect.ignore,
    );
    return notification.pipe(
      Effect.andThen(
        releaseConnection(connectionId, { kind: 'lease_invalidated', reason: 'superseded' }),
      ),
    );
  }

  /**
   * The single path that closes a connection scope, and therefore the single
   * path to `finalizePresenceLease`. The teardown is required rather than
   * defaulted: what happens to the lease, which close code the peer sees, and
   * whether a half-registered connection is cleaned up are all derived from it.
   */
  function releaseConnection(
    connectionId: string,
    teardown: ControlTeardown,
  ): Effect.Effect<void, RedisError> {
    return Effect.suspend(() => {
      const connection = connections.get(connectionId);
      if (connection === undefined) return Effect.void;
      connection.teardownReason = teardown;
      connection.peerClosed = true;
      const policy = CONTROL_TEARDOWN_POLICY[teardown.reason];
      if (connection.claimSeq === null && !policy.forceRegistrationCleanup) {
        return Effect.void;
      }

      connections.delete(connectionId);
      // Unlinked here, in the same synchronous step that makes the connection
      // invisible, so the ticker can never walk a node whose owner is gone.
      unlinkConnection(connection);
      const userConnections = connectionIdsByUserId.get(connection.userId);
      if (userConnections !== undefined) {
        userConnections.delete(connectionId);
        if (userConnections.size === 0) connectionIdsByUserId.delete(connection.userId);
      }
      const activeConnections = connections.size;
      if (connectionIdByDaemonId.get(connection.daemonId) === connectionId) {
        connectionIdByDaemonId.delete(connection.daemonId);
      }
      if (policy.closeCode !== null) {
        closeSocket(connection, policy.closeCode, policy.closeReason);
      }
      const pendingInbound: InboundControlMessage[] = drainInboundQueue(connection.commandAckInbox);
      const presenceLeaseAcquired = connection.presenceLeaseAcquired;

      return Effect.gen(function* () {
        yield* Metric.update(daemonControlActiveConnectionsGauge, activeConnections);
        // Commands in flight are NOT failed here. They belong to the presence,
        // not to this socket, and the presence outlives a carrier drop. They are
        // settled in `finalizePresenceLease` when the lease itself is retired,
        // or delivered on the connection that resumes the same lease.
        yield* Effect.forEach(
          pendingInbound,
          (inbound) =>
            Deferred.fail(
              inbound.completed,
              new DaemonUnavailable({
                daemonId: connection.daemonId,
                reason: 'socket_closed',
              }),
            ),
          { discard: true },
        );
        yield* Scope.close(connection.scope, Exit.succeed(undefined));
        if (presenceLeaseAcquired) {
          yield* Deferred.await(connection.presenceLeaseFinalized);
        }
      });
    });
  }

  function sendFrame(
    connection: ControlConnection,
    message: DaemonControlServerMessage,
  ): Effect.Effect<void, DaemonUnavailable | ControlBackpressure> {
    const encoded = encodeDaemonControlMessage(message);
    if (UTF8_ENCODER.encode(encoded).byteLength > MAX_DAEMON_CONTROL_FRAME_BYTES) {
      return Effect.fail(
        new ControlBackpressure({
          daemonId: connection.daemonId,
          connectionId: connection.connectionId,
        }),
      );
    }
    return Effect.gen(function* () {
      const status = yield* Effect.try<number, DaemonUnavailable>({
        try: () => connection.socket.sendText(encoded),
        catch: () =>
          new DaemonUnavailable({
            daemonId: connection.daemonId,
            reason: 'socket_send_failed',
          }),
      });
      if (status > 0) return;
      if (status === -1) {
        closeSocket(connection, 1013, 'control_backpressure');
        return yield* new ControlBackpressure({
          daemonId: connection.daemonId,
          connectionId: connection.connectionId,
        });
      }
      return yield* new DaemonUnavailable({
        daemonId: connection.daemonId,
        reason: 'socket_send_dropped',
      });
    });
  }
}

function drainInboundQueue<Message extends DaemonControlDaemonMessage>(
  queue: Queue.Queue<InboundControlMessage<Message>>,
): InboundControlMessage<Message>[] {
  const drained: InboundControlMessage<Message>[] = [];
  while (true) {
    const next = Queue.takeUnsafe(queue);
    if (next === undefined || Exit.isFailure(next)) return drained;
    drained.push(next.value);
  }
}

function daemonControlDeliveryOutcome(exit: Exit.Exit<unknown, unknown>): string {
  if (Exit.isSuccess(exit)) return 'accepted';
  const failure = exit.cause.reasons.find(Cause.isFailReason);
  if (failure !== undefined) {
    const error = failure.error;
    if (
      typeof error === 'object' &&
      error !== null &&
      '_tag' in error &&
      typeof error._tag === 'string'
    ) {
      return error._tag;
    }
    return 'failure';
  }
  if (Cause.hasDies(exit.cause)) return 'defect';
  if (Cause.hasInterrupts(exit.cause)) return 'interrupted';
  return 'unknown';
}

function superviseCriticalWorker(
  name: string,
  component: 'brokerWorkersHealthy' | 'livenessTickerHealthy',
  worker: Effect.Effect<never>,
  service: DaemonControlRuntime,
): Effect.Effect<never> {
  return worker.pipe(
    Effect.onExit((exit) => {
      if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) return Effect.void;
      const cause = Exit.isFailure(exit)
        ? exit.cause
        : Cause.die(new Error(`${name} completed unexpectedly`));
      return service.reportCriticalWorkerFailure(component, cause);
    }),
  );
}

function runBrokerWorker(
  service: DaemonControlRuntime,
  inbox: Queue.Queue<string>,
  logger: Logger,
): Effect.Effect<never> {
  return Effect.gen(function* () {
    while (true) {
      const frame = yield* Queue.take(inbox);
      yield* service
        .processBrokerFrame(frame)
        .pipe(
          Effect.catch((error) =>
            error instanceof RedisReplyError
              ? Effect.die(error)
              : logWithLoggerEffect(
                  logger,
                  'error',
                  'daemon_control_broker_handler_failed',
                  errorLogContext(error),
                ),
          ),
        );
    }
  });
}

function brokerResultToEffect(
  result: BrokerCommandResult,
): Effect.Effect<void, DaemonControlDeliveryError> {
  switch (result.outcome) {
    case 'accepted':
      return Effect.void;
    case 'rejected':
      return Effect.fail(
        new ControlCommandRejected({
          daemonId: result.daemonId,
          commandId: result.commandId,
          reason: result.reason ?? 'daemon_rejected',
        }),
      );
    case 'stale':
      return Effect.fail(
        new StaleDaemonPresence({
          daemonId: result.daemonId,
          presenceId: result.presenceId,
          claimSeq: result.claimSeq,
        }),
      );
    case 'timeout':
      return Effect.fail(
        new ControlDeliveryTimeout({
          daemonId: result.daemonId,
          commandId: result.commandId,
        }),
      );
    case 'backpressure':
      return Effect.fail(
        new ControlBackpressure({
          daemonId: result.daemonId,
          connectionId: 'remote',
        }),
      );
    case 'unavailable':
      return Effect.fail(
        new DaemonUnavailable({
          daemonId: result.daemonId,
          reason: result.reason ?? 'remote_owner_unavailable',
        }),
      );
  }
}

function createBrokerCommandResult(
  request: BrokerCommandRequest,
  delivery: Result.Result<void, RedisError | DaemonControlDeliveryError>,
): BrokerCommandResult {
  let outcome: BrokerCommandOutcome = 'accepted';
  let reason: string | null = null;
  if (Result.isFailure(delivery)) {
    const error = delivery.failure;
    if (error instanceof ControlCommandRejected) {
      outcome = 'rejected';
      reason = error.reason;
    } else if (error instanceof StaleDaemonPresence) {
      outcome = 'stale';
    } else if (error instanceof ControlDeliveryTimeout) {
      outcome = 'timeout';
    } else if (error instanceof ControlBackpressure) {
      outcome = 'backpressure';
    } else {
      outcome = 'unavailable';
      reason = error instanceof DaemonUnavailable ? error.reason : 'coordination_unavailable';
    }
  }
  return {
    type: 'command_result',
    version: BROKER_PROTOCOL_VERSION,
    requesterInstanceId: request.requesterInstanceId,
    ownerInstanceId: request.requesterInstanceId,
    daemonId: request.daemonId,
    presenceId: request.presenceId,
    claimSeq: request.claimSeq,
    commandId: request.command.commandId,
    outcome,
    reason,
  };
}

function parseBrokerEnvelope(frame: string): BrokerEnvelope | null {
  if (UTF8_ENCODER.encode(frame).byteLength > MAX_BROKER_FRAME_BYTES) return null;
  const value = parseJsonRecord(frame);
  if (
    value === null ||
    value.version !== BROKER_PROTOCOL_VERSION ||
    typeof value.type !== 'string'
  ) {
    return null;
  }
  if (value.type === 'command_request') return parseBrokerCommandRequest(value);
  if (value.type === 'command_result') return parseBrokerCommandResult(value);
  if (value.type === 'superseded') return parseBrokerSuperseded(value);
  if (value.type === 'delegation_revocation_retry') {
    return parseBrokerDelegationRevocationRetry(value);
  }
  if (value.type === 'revocation_generation') {
    return parseBrokerRevocationGeneration(value);
  }
  return null;
}

function parseBrokerRevocationGeneration(
  value: Record<string, unknown>,
): BrokerRevocationGeneration | null {
  if (!hasExactKeys(value, ['type', 'version', 'userId', 'generation'])) {
    return null;
  }
  const userId = readIdentifier(value.userId);
  const generation = value.generation;
  if (
    userId === null ||
    typeof generation !== 'number' ||
    !Number.isSafeInteger(generation) ||
    generation < 0
  ) {
    return null;
  }
  return {
    type: 'revocation_generation',
    version: BROKER_PROTOCOL_VERSION,
    userId,
    generation,
  };
}

function parseBrokerCommandRequest(value: Record<string, unknown>): BrokerCommandRequest | null {
  if (
    !hasExactKeys(value, [
      'type',
      'version',
      'requesterInstanceId',
      'ownerInstanceId',
      'daemonId',
      'userId',
      'connectionId',
      'presenceId',
      'claimSeq',
      'trace',
      'command',
    ])
  ) {
    return null;
  }
  const requesterInstanceId = readIdentifier(value.requesterInstanceId);
  const ownerInstanceId = readIdentifier(value.ownerInstanceId);
  const daemonId = readIdentifier(value.daemonId);
  const userId = readIdentifier(value.userId);
  const connectionId = readIdentifier(value.connectionId);
  const presenceId = readIdentifier(value.presenceId);
  const claimSeq = readPositiveInteger(value.claimSeq);
  const trace = readBrokerTraceContext(value.trace);
  const command = parseDaemonControlServerMessage(value.command);
  if (
    requesterInstanceId === null ||
    ownerInstanceId === null ||
    daemonId === null ||
    userId === null ||
    connectionId === null ||
    presenceId === null ||
    claimSeq === null ||
    trace === null ||
    command === null ||
    (command.type !== 'session_start' &&
      command.type !== 'session_cancel' &&
      command.type !== 'delegation_revoke')
  ) {
    return null;
  }
  return {
    type: 'command_request',
    version: BROKER_PROTOCOL_VERSION,
    requesterInstanceId,
    ownerInstanceId,
    daemonId,
    userId,
    connectionId,
    presenceId,
    claimSeq,
    trace,
    command,
  };
}

function parseBrokerCommandResult(value: Record<string, unknown>): BrokerCommandResult | null {
  if (
    !hasExactKeys(value, [
      'type',
      'version',
      'requesterInstanceId',
      'ownerInstanceId',
      'daemonId',
      'presenceId',
      'claimSeq',
      'commandId',
      'outcome',
      'reason',
    ])
  ) {
    return null;
  }
  const requesterInstanceId = readIdentifier(value.requesterInstanceId);
  const ownerInstanceId = readIdentifier(value.ownerInstanceId);
  const daemonId = readIdentifier(value.daemonId);
  const presenceId = readIdentifier(value.presenceId);
  const claimSeq = readPositiveInteger(value.claimSeq);
  const commandId = readIdentifier(value.commandId);
  const outcome = readBrokerCommandOutcome(value.outcome);
  const reason =
    value.reason === null
      ? null
      : typeof value.reason === 'string' && value.reason.length > 0 && value.reason.length <= 128
        ? value.reason
        : undefined;
  if (
    requesterInstanceId === null ||
    ownerInstanceId === null ||
    daemonId === null ||
    presenceId === null ||
    claimSeq === null ||
    commandId === null ||
    outcome === null ||
    reason === undefined
  ) {
    return null;
  }
  return {
    type: 'command_result',
    version: BROKER_PROTOCOL_VERSION,
    requesterInstanceId,
    ownerInstanceId,
    daemonId,
    presenceId,
    claimSeq,
    commandId,
    outcome,
    reason,
  };
}

function parseBrokerSuperseded(value: Record<string, unknown>): BrokerSuperseded | null {
  if (
    !hasExactKeys(value, [
      'type',
      'version',
      'ownerInstanceId',
      'daemonId',
      'connectionId',
      'presenceId',
      'claimSeq',
    ])
  ) {
    return null;
  }
  const ownerInstanceId = readIdentifier(value.ownerInstanceId);
  const daemonId = readIdentifier(value.daemonId);
  const connectionId = readIdentifier(value.connectionId);
  const presenceId = readIdentifier(value.presenceId);
  const claimSeq = readPositiveInteger(value.claimSeq);
  if (
    ownerInstanceId === null ||
    daemonId === null ||
    connectionId === null ||
    presenceId === null ||
    claimSeq === null
  ) {
    return null;
  }
  return {
    type: 'superseded',
    version: BROKER_PROTOCOL_VERSION,
    ownerInstanceId,
    daemonId,
    connectionId,
    presenceId,
    claimSeq,
  };
}

function parseBrokerDelegationRevocationRetry(
  value: Record<string, unknown>,
): BrokerDelegationRevocationRetry | null {
  if (
    !hasExactKeys(value, [
      'type',
      'version',
      'ownerInstanceId',
      'daemonId',
      'connectionId',
      'presenceId',
      'claimSeq',
    ])
  ) {
    return null;
  }
  const ownerInstanceId = readIdentifier(value.ownerInstanceId);
  const daemonId = readIdentifier(value.daemonId);
  const connectionId = readIdentifier(value.connectionId);
  const presenceId = readIdentifier(value.presenceId);
  const claimSeq = readPositiveInteger(value.claimSeq);
  if (
    ownerInstanceId === null ||
    daemonId === null ||
    connectionId === null ||
    presenceId === null ||
    claimSeq === null
  ) {
    return null;
  }
  return {
    type: 'delegation_revocation_retry',
    version: BROKER_PROTOCOL_VERSION,
    ownerInstanceId,
    daemonId,
    connectionId,
    presenceId,
    claimSeq,
  };
}

function readBrokerCommandOutcome(value: unknown): BrokerCommandOutcome | null {
  return value === 'accepted' ||
    value === 'rejected' ||
    value === 'unavailable' ||
    value === 'stale' ||
    value === 'timeout' ||
    value === 'backpressure'
    ? value
    : null;
}

function parseJsonRecord(frame: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(frame);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function readIdentifier(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 ? value : null;
}

function readPositiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function readBrokerTraceContext(value: unknown): BrokerTraceContext | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['traceId', 'spanId', 'sampled']) ||
    typeof value.traceId !== 'string' ||
    !/^[0-9a-f]{32}$/.test(value.traceId) ||
    typeof value.spanId !== 'string' ||
    !/^[0-9a-f]{16}$/.test(value.spanId) ||
    typeof value.sampled !== 'boolean'
  ) {
    return null;
  }
  return {
    traceId: value.traceId,
    spanId: value.spanId,
    sampled: value.sampled,
  };
}

/**
 * Lease identity: the part of a presence that survives a reattach.
 *
 * `connectionId` and `ownerInstanceId` are deliberately excluded. They identify
 * the carrier, not the lease, and both change when a daemon resumes onto a new
 * socket or a new replica. Fencing *delivery* on them would fail a command
 * prepared before a blip and delivered after a healthy resume — the exact churn
 * this design exists to remove.
 *
 * Where the subject really is one specific connection — acknowledgement
 * validation and broker retirement — the full identity is compared inline,
 * including `connectionId` and `ownerInstanceId`.
 */
function isSamePresenceLease(left: DaemonPresence, right: DaemonPresence): boolean {
  return (
    left.daemonId === right.daemonId &&
    left.userId === right.userId &&
    left.presenceId === right.presenceId &&
    left.claimSeq === right.claimSeq
  );
}

function brokerChannelForInstance(instanceId: string): string {
  return `${BROKER_CHANNEL_PREFIX}${instanceId}`;
}

function closeSocket(connection: ControlConnection, code: number, reason: string): void {
  try {
    connection.socket.close(code, reason);
  } catch {
    // The peer may already have closed while the retirement effect was running.
  }
}

function createDelegationRevocationOutbox(db: Kysely<DatabaseSchema>): DelegationRevocationOutbox {
  return {
    listPending(daemonId) {
      return Effect.tryPromise({
        try: async () => {
          const rows = await db
            .selectFrom('delegation_revocation_outbox')
            .select(['command_id', 'actor_certificate_json', 'revocation_json'])
            .where('daemon_id', '=', daemonId)
            .where('acknowledged_at', 'is', null)
            .orderBy('created_at', 'asc')
            .orderBy('sequence', 'asc')
            .execute();
          return rows.flatMap((row): PendingDelegationRevocation[] =>
            row.command_id === null
              ? []
              : [
                  {
                    commandId: row.command_id,
                    actorCertificateJson: row.actor_certificate_json,
                    revocationJson: row.revocation_json,
                  },
                ],
          );
        },
        catch: infrastructureError('daemon-control', 'list-pending-delegation-revocations'),
      });
    },
    markAcknowledged(commandId, acknowledgedAt) {
      return Effect.tryPromise({
        try: async () => {
          await db
            .updateTable('delegation_revocation_outbox')
            .set({ acknowledged_at: acknowledgedAt, rejected_reason: null })
            .where('command_id', '=', commandId)
            .where('acknowledged_at', 'is', null)
            .execute();
        },
        catch: infrastructureError('daemon-control', 'acknowledge-delegation-revocation'),
      });
    },
    markRejected(commandId, reason) {
      return Effect.tryPromise({
        try: async () => {
          await db
            .updateTable('delegation_revocation_outbox')
            .set({ rejected_reason: reason })
            .where('command_id', '=', commandId)
            .where('acknowledged_at', 'is', null)
            .execute();
        },
        catch: infrastructureError('daemon-control', 'reject-delegation-revocation'),
      });
    },
  };
}
