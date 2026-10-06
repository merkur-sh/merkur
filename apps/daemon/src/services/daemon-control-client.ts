import { daemonControlTranscript, parseDaemonChallenge } from '@merkur/auth';
import {
  createDaemonControlCommandAckMessage,
  type DaemonControlCommandMessage,
  type DaemonControlRegisteredMessage,
  encodeDaemonControlMessage,
  MAX_DAEMON_CONTROL_FRAME_BYTES,
  parseDaemonControlServerMessage,
} from '@merkur/daemon-control-protocol';
import { merkurVersion, parseTraceparent, spanAttributes } from '@merkur/shared';
import type { DelegationRevocationTarget } from '@merkur/shared/user-authorization';
import {
  Cause,
  Data,
  Deferred,
  Effect,
  FiberHandle,
  Option,
  Queue,
  Ref,
  type Scope,
  Semaphore,
  Tracer,
} from 'effect';

import { type DaemonConfig, saveDaemonConfigEffect } from '../config';
import { logEffect } from '../logger';
import {
  type DaemonHealthService,
  recordControlPingOutcome,
  recordControlPingRttMs,
  recordControlReconnectOutcome,
  recordControlRegistrationOutcome,
  recordSuspensionGapMs,
} from './daemon-metrics';
import type { DataplaneClient, DataplaneCommandResult } from './dataplane-client';

const DAEMON_CONTROL_PATH = '/api/daemon/control';
const DAEMON_ID_HEADER = 'x-merkur-daemon-id';
const DAEMON_VERSION_HEADER = 'x-merkur-version';
const DAEMON_RESUME_PRESENCE_HEADER = 'x-merkur-resume-presence';
/**
 * How long an applied command's outcome is remembered.
 *
 * Bounded by time rather than by count, and that is what makes replay safe by
 * construction. The server only replays commands still pending on its side, and
 * it drops a pending entry after its own command timeout (5s today). A TTL an
 * order of magnitude beyond that means every entry this memo expires is one the
 * server can no longer replay — so an expired entry can never be needed.
 */
const APPLIED_COMMAND_MEMO_TTL_MS = 60_000;
/**
 * Memory backstop only, never expected to bind. The server admits at most 64
 * concurrent commands per presence and resolves each within ~5s, so a daemon —
 * which holds exactly one control presence — cannot complete more than roughly
 * 768 commands inside one TTL window. Reaching this cap would mean the server is
 * misbehaving; it exists so that could not grow the map without bound.
 */
const APPLIED_COMMAND_MEMO_CAP = 4_096;
/**
 * Wall-clock overshoot beyond an intended sleep that can only be explained by
 * this process not running: OS suspend/resume, SIGSTOP, or a hypervisor pause.
 *
 * An absolute value, not a multiple of the ping interval, so the server cannot
 * move it by dictating a long interval.
 */
const SUSPENSION_GAP_THRESHOLD_MS = 5_000;
/**
 * How many ping intervals past the server's silence window a pong may be late
 * before this side declares the carrier dead. The server owns the hard timeout
 * and tears the lease's carrier down on its own schedule; this deadline only
 * has to notice a server that has vanished without closing the socket.
 */
const PONG_TIMEOUT_INTERVALS = 3;
const INITIAL_RECONNECT_DELAY_MS = 250;
const MAX_RECONNECT_DELAY_MS = 30_000;
const SOCKET_OPEN_TIMEOUT_MS = 10_000;
const REGISTRATION_TIMEOUT_MS = 10_000;
const STABLE_CONNECTION_UPTIME_MS = 10_000;
const MAX_CONTROL_BUFFERED_BYTES = 64 * 1024;
export const DAEMON_CONTROL_EVENT_QUEUE_CAPACITY = 64;
const NORMAL_CLOSE_CODE = 1_000;
const PROTOCOL_ERROR_CLOSE_CODE = 1_002;
/**
 * Sent only when this process is deliberately stopping. The server maps it to
 * an immediate lease release: the PTYs are gone, so there is nothing for the
 * resume grace window to preserve, and the device reads offline at once.
 */
export const DAEMON_SHUTDOWN_CLOSE_CODE = 4_004;
/** How long to wait for the close handshake before terminating the socket. */
const SHUTDOWN_CLOSE_GRACE_MS = 250;

export type DaemonControlHealthReporter = Pick<DaemonHealthService, 'updateControl'>;

/** One coalesced OS network-path transition, observed by the dataplane. */
export interface DaemonControlPathSignal {
  readonly coalescedEvents: number;
}

export interface DaemonControlClientOptions {
  readonly dependencies?: DaemonControlClientDependencies;
  readonly health?: DaemonControlHealthReporter;
  readonly pathSignals?: Queue.Dequeue<DaemonControlPathSignal>;
  readonly persistConfig?: (config: DaemonConfig) => Effect.Effect<void, Error>;
  /**
   * Completed by the process-signal handler before it interrupts the runtime.
   * The connection finalizer reads it to decide between a graceful
   * `DAEMON_SHUTDOWN_CLOSE_CODE` close and a bare termination: every other
   * teardown — a timeout, a path change, an overflow — must look like a lost
   * carrier so the server holds the lease through its resume grace window.
   */
  readonly shutdownIntent?: Deferred.Deferred<void>;
}

const NOOP_HEALTH_REPORTER: DaemonControlHealthReporter = {
  updateControl: () => Effect.void,
};

export interface DaemonControlSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  /** Fired for every pong control frame the peer answers a ping with. */
  onpong: (() => void) | null;
  send(data: string): void;
  /** Sends a ping control frame; the peer answers at the transport layer. */
  ping(): void;
  close(code?: number, reason?: string): void;
  terminate?(): void;
}

export interface DaemonControlClientDependencies {
  readonly createSocket: (
    url: string,
    headers: Readonly<Record<string, string>>,
  ) => DaemonControlSocket;
  readonly random: () => number;
  /**
   * Wall-clock reader for suspension detection.
   *
   * Deliberately not `Clock.currentTimeMillis`: TestClock advances to each
   * sleeper's exact deadline before waking it, so a Clock-based measurement of
   * "how much longer than `d` did `sleep(d)` take" is identically zero under
   * test and cannot express a suspend/resume gap at all.
   */
  readonly now: () => number;
  readonly initialReconnectDelayMs: number;
  readonly maxReconnectDelayMs: number;
  readonly eventQueueCapacity: number;
  readonly socketOpenTimeoutMs: number;
  readonly registrationTimeoutMs: number;
  readonly stableConnectionUptimeMs: number;
}

/** Why a connection ended, when the reason should change what happens next. */
type ControlEndCause = 'process_suspended' | 'network_path_changed' | null;

interface ConnectionOutcome {
  readonly registered: boolean;
  readonly superseded: boolean;
  readonly stable: boolean;
  readonly cause: ControlEndCause;
  /**
   * The lease this connection held, or null if it never registered. The owning
   * loop offers it back on the next attempt so the server can reattach rather
   * than supersede.
   */
  readonly presenceId: string | null;
}

/**
 * Outcomes of commands already applied by this process, keyed by `commandId`.
 * Lives above the connection scope because the server replays across reconnects,
 * which is exactly when it is needed.
 */
interface AppliedCommandMemo {
  readonly result: (commandId: string) => Effect.Effect<DataplaneCommandResult | undefined>;
  readonly remember: (commandId: string, result: DataplaneCommandResult) => Effect.Effect<void>;
}

export interface DaemonControlSuperseded {
  readonly _tag: 'DaemonControlSuperseded';
}

type ControlEvent =
  | { readonly type: 'socket_open' }
  | { readonly type: 'socket_message'; readonly data: unknown }
  | { readonly type: 'socket_error' }
  | { readonly type: 'socket_closed'; readonly code: number }
  | { readonly type: 'socket_pong' }
  | { readonly type: 'ping_due' }
  | { readonly type: 'pong_deadline'; readonly epoch: number; readonly timeoutMs: number }
  | {
      readonly type: 'connection_watchdog_expired';
      readonly phase: 'socket_open' | 'registration';
      readonly timeoutMs: number;
    }
  | { readonly type: 'stable_uptime_elapsed' }
  | { readonly type: 'process_resumed'; readonly gapMs: number }
  | { readonly type: 'network_path_changed'; readonly coalescedEvents: number }
  | {
      readonly type: 'command_completed';
      readonly commandId: string;
      readonly result: DataplaneCommandResult;
    }
  | { readonly type: 'event_queue_overflow' };

interface ControlSocketAdapter {
  readonly socket: DaemonControlSocket;
  active: boolean;
}

class DaemonControlConnectionError extends Data.TaggedError('DaemonControlConnectionError')<{
  readonly reason: 'socket_create_failed';
}> {}

class DaemonControlSocketSendError extends Data.TaggedError('DaemonControlSocketSendError')<{
  readonly reason: 'socket_not_open' | 'encode_failed' | 'outbound_backpressure' | 'send_failed';
}> {}

class DaemonControlWatchdogExpired extends Data.TaggedError('DaemonControlWatchdogExpired')<{
  readonly phase: 'socket_open' | 'registration';
  readonly timeoutMs: number;
}> {}

/**
 * Bun's client socket exposes `ping()` and delivers pongs only through
 * `addEventListener('pong')`, which its type declarations omit. This adapter
 * is the one place that knows that; everything above it sees the narrow
 * `on*`-shaped interface the fake socket in tests implements too.
 */
class BunControlSocket implements DaemonControlSocket {
  onpong: (() => void) | null = null;

  constructor(private readonly raw: WebSocket & { ping(): void; terminate(): void }) {
    raw.addEventListener('pong', () => {
      this.onpong?.();
    });
  }

  get readyState(): number {
    return this.raw.readyState;
  }
  get bufferedAmount(): number {
    return this.raw.bufferedAmount;
  }
  get onopen(): ((event: Event) => void) | null {
    return this.raw.onopen;
  }
  set onopen(handler: ((event: Event) => void) | null) {
    this.raw.onopen = handler;
  }
  get onmessage(): ((event: MessageEvent) => void) | null {
    return this.raw.onmessage;
  }
  set onmessage(handler: ((event: MessageEvent) => void) | null) {
    this.raw.onmessage = handler;
  }
  get onerror(): ((event: Event) => void) | null {
    return this.raw.onerror;
  }
  set onerror(handler: ((event: Event) => void) | null) {
    this.raw.onerror = handler;
  }
  get onclose(): ((event: CloseEvent) => void) | null {
    return this.raw.onclose;
  }
  set onclose(handler: ((event: CloseEvent) => void) | null) {
    this.raw.onclose = handler;
  }
  send(data: string): void {
    this.raw.send(data);
  }
  ping(): void {
    this.raw.ping();
  }
  close(code?: number, reason?: string): void {
    this.raw.close(code, reason);
  }
  terminate(): void {
    this.raw.terminate();
  }
}

const defaultDependencies: DaemonControlClientDependencies = {
  createSocket(url, headers) {
    // `bun-types` defers to lib.dom's constructor when both are loaded, which
    // hides Bun's runtime-supported header overload and its ping/terminate
    // methods. Keep the assertion at this one external boundary; all code after
    // construction uses the narrow socket interface.
    const BunWebSocket = WebSocket as typeof WebSocket & {
      new (
        socketUrl: string,
        options: Bun.WebSocketOptions,
      ): WebSocket & { ping(): void; terminate(): void };
    };
    return new BunControlSocket(
      new BunWebSocket(url, {
        headers,
        perMessageDeflate: false,
      }),
    );
  },
  random: Math.random,
  now: Date.now,
  initialReconnectDelayMs: INITIAL_RECONNECT_DELAY_MS,
  maxReconnectDelayMs: MAX_RECONNECT_DELAY_MS,
  eventQueueCapacity: DAEMON_CONTROL_EVENT_QUEUE_CAPACITY,
  socketOpenTimeoutMs: SOCKET_OPEN_TIMEOUT_MS,
  registrationTimeoutMs: REGISTRATION_TIMEOUT_MS,
  stableConnectionUptimeMs: STABLE_CONNECTION_UPTIME_MS,
};

export function daemonControlWebSocketUrl(serverOrigin: string): string {
  const url = new URL(DAEMON_CONTROL_PATH, serverOrigin);
  if (url.protocol === 'https:') {
    url.protocol = 'wss:';
  } else if (url.protocol === 'http:' && isLoopbackHostname(url.hostname)) {
    url.protocol = 'ws:';
  } else {
    throw new Error('Daemon control requires HTTPS, except for explicit loopback development');
  }
  return url.toString();
}

export function runDaemonControlClientEffect(
  config: DaemonConfig,
  dataplane: Pick<
    DataplaneClient,
    | 'signDaemonProofEffect'
    | 'startSessionEffect'
    | 'cancelSessionEffect'
    | 'revokeDelegationEffect'
    | 'updateRevocation'
    | 'updateStunCredential'
    | 'updateEdgeAdmission'
  >,
  options: DaemonControlClientOptions = {},
): Effect.Effect<DaemonControlSuperseded, never> {
  const dependencies = options.dependencies ?? defaultDependencies;
  const health = options.health ?? NOOP_HEALTH_REPORTER;
  const controlUrl = daemonControlWebSocketUrl(config.server_origin);
  const baseHeaders = {
    [DAEMON_ID_HEADER]: config.daemon_id,
    [DAEMON_VERSION_HEADER]: merkurVersion(),
  };

  return Effect.gen(function* () {
    const currentConfig = yield* Ref.make(config);
    /**
     * The presence this process currently holds, offered back on reconnect so
     * the server can reattach the same lease instead of superseding it.
     *
     * Process lifetime, in memory only, and deliberately never persisted: a
     * daemon restart loses its dataplane and PTYs, so it must NOT inherit the
     * sessions fenced by that lease. Not holding it on disk is what enforces
     * that, rather than a check that could be forgotten.
     */
    const resumePresenceId = yield* Ref.make<string | null>(null);
    /**
     * Outcomes of commands this process already applied, as expiring tombstones.
     *
     * The server re-sends anything it has not seen acknowledged, so without this
     * a reconnect would execute a command a second time. Entries expire rather
     * than being counted out, which is what removes the "applied but forgotten"
     * case entirely: see `APPLIED_COMMAND_MEMO_TTL_MS`.
     *
     * Same shape as `CancelledSessions` in the Rust dataplane — a TTL'd
     * "already handled this id" set, pruned on every access instead of by a
     * timer, with a capacity backstop that evicts the oldest entry.
     */
    const appliedResults = new Map<
      string,
      { result: DataplaneCommandResult; expiresAtMs: number }
    >();
    const pruneAppliedCommands = (nowMs: number): void => {
      for (const [commandId, entry] of appliedResults) {
        if (entry.expiresAtMs <= nowMs) appliedResults.delete(commandId);
      }
    };
    const appliedCommands: AppliedCommandMemo = {
      result: (commandId) =>
        Effect.sync(() => {
          pruneAppliedCommands(dependencies.now());
          return appliedResults.get(commandId)?.result;
        }),
      remember: (commandId, result) =>
        Effect.sync(() => {
          const nowMs = dependencies.now();
          pruneAppliedCommands(nowMs);
          // Delete first so a repeat re-enters at the end of insertion order,
          // keeping the capacity eviction below a true oldest-first.
          appliedResults.delete(commandId);
          appliedResults.set(commandId, {
            result,
            expiresAtMs: nowMs + APPLIED_COMMAND_MEMO_TTL_MS,
          });
          while (appliedResults.size > APPLIED_COMMAND_MEMO_CAP) {
            const oldest = appliedResults.keys().next().value;
            if (oldest === undefined) break;
            appliedResults.delete(oldest);
          }
        }),
    };
    const configPersistence = yield* Semaphore.make(1);
    const persistRevocations = (
      targets: readonly DelegationRevocationTarget[],
    ): Effect.Effect<DataplaneCommandResult> =>
      configPersistence.withPermit(
        Effect.gen(function* () {
          const before = yield* Ref.get(currentConfig);
          const merged = new Map(
            before.revoked_delegations.map((target) => [target.delegationId, target.expiresAt]),
          );
          for (const target of targets) {
            merged.set(
              target.delegationId,
              Math.max(merged.get(target.delegationId) ?? 0, target.expiresAt),
            );
          }
          const revokedDelegations = [...merged]
            .map(([delegationId, expiresAt]) => ({ delegationId, expiresAt }))
            .sort((left, right) =>
              left.delegationId < right.delegationId
                ? -1
                : left.delegationId > right.delegationId
                  ? 1
                  : 0,
            );
          const next = { ...before, revoked_delegations: revokedDelegations };
          const result = yield* (options.persistConfig ?? saveDaemonConfigEffect)(next).pipe(
            Effect.as({ status: 'accepted' } as const),
            Effect.catch(() =>
              Effect.succeed({
                status: 'rejected',
                reason: 'revocation_persistence_failed',
              } as const),
            ),
          );
          if (result.status === 'accepted') {
            yield* Ref.set(currentConfig, next);
          }
          return result;
        }),
      );
    let reconnectDelayMs = dependencies.initialReconnectDelayMs;
    const lastPushedRevocationGeneration = yield* Ref.make(-1);
    const pushRevocationGeneration = (generation: number): Effect.Effect<void> =>
      Ref.modify(lastPushedRevocationGeneration, (current): readonly [boolean, number] =>
        generation > current ? [true, generation] : [false, current],
      ).pipe(
        Effect.flatMap((shouldPush) =>
          shouldPush
            ? Effect.sync(() => {
                dataplane.updateRevocation(generation);
              })
            : Effect.void,
        ),
      );

    while (true) {
      yield* health.updateControl({
        state: 'connecting',
      });
      // Rebuilt per attempt: the lease to reclaim changes as connections come
      // and go, so the header cannot be hoisted out of the loop.
      const resumable = yield* Ref.get(resumePresenceId);
      const headers =
        resumable === null
          ? baseHeaders
          : { ...baseHeaders, [DAEMON_RESUME_PRESENCE_HEADER]: resumable };
      const outcome = yield* runControlConnection(
        controlUrl,
        headers,
        config,
        dataplane,
        persistRevocations,
        pushRevocationGeneration,
        appliedCommands,
        options.pathSignals,
        options.shutdownIntent,
        dependencies,
        health,
      ).pipe(
        Effect.withSpan('daemon.control.connection', {
          attributes: spanAttributes({
            'merkur.daemon.id': config.daemon_id,
          }),
        }),
        Effect.catchTag('DaemonControlConnectionError', (error) =>
          Effect.gen(function* () {
            yield* recordControlRegistrationOutcome(error.reason);
            yield* health.updateControl({
              state: 'connecting',
              lastFailure: error.reason,
            });
            yield* logEffect('warn', 'daemon', 'daemon_control_connection_failed', {
              reason: error.reason,
            });
            return {
              registered: false,
              superseded: false,
              stable: false,
              cause: null,
              presenceId: null,
            } satisfies ConnectionOutcome;
          }),
        ),
      );

      // Only overwrite when this attempt actually learned a lease. An attempt
      // that never registered leaves the previous one in place, because it may
      // still be suspended and reclaimable.
      if (outcome.presenceId !== null) {
        yield* Ref.set(resumePresenceId, outcome.presenceId);
      }

      if (outcome.superseded) {
        yield* health.updateControl({
          state: 'superseded',
          lastFailure: null,
        });
        yield* logEffect('warn', 'daemon', 'daemon_control_superseded');
        return { _tag: 'DaemonControlSuperseded' };
      }

      if (outcome.cause === 'process_suspended') {
        // The previous carrier is definitively dead — the server evicted this
        // presence long ago — and someone is looking at the screen right now.
        // Backing off would only add latency to a reconnect we already know is
        // required.
        //
        // This cannot storm: emitting `process_resumed` requires observing
        // SUSPENSION_GAP_THRESHOLD_MS of overshoot on a sleep that itself takes
        // `intervalMs`, so it recurs no faster than once per ~10s of real time.
        // Any other failure on the resumed connection re-enters the ladder,
        // because this resets its position rather than disabling it.
        reconnectDelayMs = dependencies.initialReconnectDelayMs;
        yield* recordControlReconnectOutcome('process_suspended');
        yield* logEffect('info', 'daemon', 'daemon_control_resume_reconnect');
        continue;
      }

      if (outcome.stable) {
        reconnectDelayMs = dependencies.initialReconnectDelayMs;
      }
      const delayMs = jitteredDelay(reconnectDelayMs, dependencies.random());
      yield* recordControlReconnectOutcome(
        outcome.stable
          ? 'stable_connection'
          : outcome.registered
            ? 'unstable_registered_connection'
            : 'unregistered_connection',
      );
      yield* health.updateControl({
        state: 'backoff',
        reconnectDelayMs: delayMs,
      });
      yield* logEffect('info', 'daemon', 'daemon_control_reconnect_scheduled', {
        delayMs,
        wasRegistered: outcome.registered,
        wasStable: outcome.stable,
      });
      const delay = Effect.sleep(`${delayMs} millis`);
      // The old path's retry deadline says nothing about a newly observed OS
      // path. Consume that edge while no socket exists, then dial immediately;
      // racing cancels the losing queue take before the next carrier owns it.
      // Keep the ladder's position so a failed retry still backs off normally.
      yield* options.pathSignals === undefined
        ? delay
        : Effect.raceFirst(delay, Queue.take(options.pathSignals).pipe(Effect.asVoid));
      reconnectDelayMs = Math.min(reconnectDelayMs * 2, dependencies.maxReconnectDelayMs);
    }
  });
}

function runControlConnection(
  controlUrl: string,
  headers: Readonly<Record<string, string>>,
  config: DaemonConfig,
  dataplane: Pick<
    DataplaneClient,
    | 'signDaemonProofEffect'
    | 'startSessionEffect'
    | 'cancelSessionEffect'
    | 'revokeDelegationEffect'
    | 'updateRevocation'
    | 'updateStunCredential'
    | 'updateEdgeAdmission'
  >,
  persistRevocations: (
    targets: readonly DelegationRevocationTarget[],
  ) => Effect.Effect<DataplaneCommandResult>,
  pushRevocationGeneration: (generation: number) => Effect.Effect<void>,
  appliedCommands: AppliedCommandMemo,
  pathSignals: Queue.Dequeue<DaemonControlPathSignal> | undefined,
  shutdownIntent: Deferred.Deferred<void> | undefined,
  dependencies: DaemonControlClientDependencies,
  health: DaemonControlHealthReporter,
): Effect.Effect<ConnectionOutcome, DaemonControlConnectionError> {
  return Effect.scoped(
    Effect.gen(function* () {
      const eventQueueCapacity = normalizeEventQueueCapacity(dependencies.eventQueueCapacity);
      const events = yield* Queue.dropping<ControlEvent>(eventQueueCapacity);
      const fatal = yield* Deferred.make<ControlEvent>();
      const childFailure = yield* Deferred.make<never>();
      const socketOpened = yield* Deferred.make<void>();
      const registered = yield* Deferred.make<void>();
      if (pathSignals !== undefined) {
        // A change observed while no carrier existed is already reflected in the
        // socket about to be created. Only changes that outlive this carrier are
        // actionable. Drained before creation rather than after: losing a real
        // signal is worse than one extra reconnect, and the Rust side is
        // edge-triggered, so a dropped edge is never re-sent.
        yield* Queue.clear(pathSignals).pipe(Effect.asVoid);
      }
      const adapter = yield* Effect.acquireRelease(
        Effect.try({
          try: (): ControlSocketAdapter => {
            const resource: ControlSocketAdapter = {
              socket: dependencies.createSocket(controlUrl, headers),
              active: true,
            };
            // Callback ownership must be installed in the same synchronous
            // acquire step as construction. A native socket is allowed to open
            // before the Effect fiber next resumes.
            installControlSocketHandlers(resource, events, fatal);
            return resource;
          },
          catch: () =>
            new DaemonControlConnectionError({
              reason: 'socket_create_failed',
            }),
        }),
        (resource) => releaseControlSocket(resource, events, shutdownIntent),
      );
      yield* runConnectionWatchdog(
        socketOpened,
        registered,
        events,
        fatal,
        dependencies.socketOpenTimeoutMs,
        dependencies.registrationTimeoutMs,
      ).pipe(
        (effect) => linkControlChild(effect, childFailure),
        Effect.forkScoped({ startImmediately: true }),
      );
      if (pathSignals !== undefined) {
        yield* runControlPathSignalConsumer(pathSignals, events, fatal).pipe(
          (effect) => linkControlChild(effect, childFailure),
          Effect.forkScoped({ startImmediately: true }),
        );
      }
      const pongDeadline = yield* FiberHandle.make<void, never>();

      return yield* Effect.raceFirst(
        runControlEventLoop(
          adapter.socket,
          events,
          fatal,
          childFailure,
          socketOpened,
          registered,
          pongDeadline,
          eventQueueCapacity,
          dependencies.stableConnectionUptimeMs,
          dataplane,
          persistRevocations,
          pushRevocationGeneration,
          appliedCommands,
          dependencies.now,
          health,
          config,
          headers,
        ),
        Deferred.await(childFailure),
      );
    }),
  );
}

function runControlEventLoop(
  socket: DaemonControlSocket,
  events: Queue.Queue<ControlEvent>,
  fatal: Deferred.Deferred<ControlEvent>,
  childFailure: Deferred.Deferred<never>,
  socketOpened: Deferred.Deferred<void>,
  registered: Deferred.Deferred<void>,
  pongDeadline: FiberHandle.FiberHandle<void, never>,
  maxPendingCommands: number,
  stableConnectionUptimeMs: number,
  dataplane: Pick<
    DataplaneClient,
    | 'signDaemonProofEffect'
    | 'startSessionEffect'
    | 'cancelSessionEffect'
    | 'revokeDelegationEffect'
    | 'updateRevocation'
    | 'updateStunCredential'
    | 'updateEdgeAdmission'
  >,
  persistRevocations: (
    targets: readonly DelegationRevocationTarget[],
  ) => Effect.Effect<DataplaneCommandResult>,
  pushRevocationGeneration: (generation: number) => Effect.Effect<void>,
  appliedCommands: AppliedCommandMemo,
  now: () => number,
  health: DaemonControlHealthReporter,
  config: DaemonConfig,
  headers: Readonly<Record<string, string>>,
): Effect.Effect<ConnectionOutcome, never, Scope.Scope> {
  return Effect.gen(function* () {
    let registration = Option.none<DaemonControlRegisteredMessage>();
    let pongDeadlineEpoch = 0;
    /** Send time of the ping awaiting a pong, for the RTT window. */
    let pingSentAtMs: number | null = null;
    let stableConnection = false;
    let stableUptimeElapsed = false;
    let observedSocketOpen = false;
    let proofSent = false;
    const pendingCommands = new Set<string>();

    const finish = (superseded: boolean, cause: ControlEndCause = null): ConnectionOutcome => ({
      registered: Option.isSome(registration),
      superseded,
      stable: stableConnection,
      cause,
      presenceId: Option.isSome(registration) ? registration.value.presenceId : null,
    });
    const send = (
      message: Parameters<typeof encodeDaemonControlMessage>[0],
    ): Effect.Effect<boolean> =>
      sendControlMessage(socket, message).pipe(
        Effect.as(true),
        Effect.catchTag('DaemonControlSocketSendError', (error) =>
          Effect.gen(function* () {
            yield* health.updateControl({
              state: 'connecting',
              lastFailure: error.reason,
            });
            yield* logEffect(
              'warn',
              'daemon',
              error.reason === 'outbound_backpressure'
                ? 'daemon_control_backpressure'
                : 'daemon_control_send_failed',
              { reason: error.reason },
            );
            return false;
          }),
        ),
      );
    const protocolViolation = Effect.gen(function* () {
      yield* health.updateControl({
        state: 'connecting',
        lastFailure: 'protocol_error',
      });
      yield* logEffect('warn', 'daemon', 'daemon_control_protocol_error');
      yield* closeControlSocket(socket, PROTOCOL_ERROR_CLOSE_CODE, 'protocol error');
      return finish(false);
    });
    const markStableAfterPong = Effect.gen(function* () {
      if (stableConnection || !stableUptimeElapsed) {
        return;
      }
      stableConnection = true;
      yield* health.updateControl({
        state: 'registered',
        stable: true,
        connectionId: Option.isSome(registration) ? registration.value.connectionId : null,
        lastFailure: null,
      });
      yield* logEffect('info', 'daemon', 'daemon_control_connection_stable', {
        stableUptimeMs: normalizePositiveDuration(
          stableConnectionUptimeMs,
          STABLE_CONNECTION_UPTIME_MS,
        ),
        pongObserved: true,
      });
    });
    const sendPing = Effect.try({
      try: () => {
        if (socket.readyState !== 1) throw new Error('socket not open');
        socket.ping();
      },
      catch: () => undefined,
    }).pipe(
      Effect.as(true),
      Effect.catch(() =>
        Effect.gen(function* () {
          yield* recordControlPingOutcome('send_failed');
          yield* health.updateControl({
            state: 'connecting',
            lastFailure: 'ping_send_failed',
          });
          yield* logEffect('warn', 'daemon', 'daemon_control_ping_send_failed');
          return false;
        }),
      ),
    );

    while (true) {
      const event = yield* Effect.raceFirst(Queue.take(events), Deferred.await(fatal));

      if (event.type === 'socket_open') {
        if (observedSocketOpen) continue;
        observedSocketOpen = true;
        yield* Deferred.succeed(socketOpened, undefined).pipe(Effect.asVoid);
        yield* health.updateControl({
          state: 'registering',
        });
        yield* logEffect('info', 'daemon', 'daemon_control_socket_open');
        continue;
      }
      if (event.type === 'socket_error') {
        if (Option.isNone(registration)) {
          yield* recordControlRegistrationOutcome('socket_error_before_registration');
        }
        yield* health.updateControl({
          state: 'connecting',
          lastFailure: 'socket_error',
        });
        yield* logEffect('warn', 'daemon', 'daemon_control_socket_error');
        return finish(false);
      }
      if (event.type === 'socket_closed') {
        if (Option.isNone(registration)) {
          yield* recordControlRegistrationOutcome('socket_closed_before_registration');
        }
        yield* health.updateControl({
          state: 'connecting',
          lastFailure: `socket_closed_${event.code}`,
        });
        yield* logEffect('warn', 'daemon', 'daemon_control_socket_closed', {
          code: event.code,
        });
        return finish(false);
      }
      if (event.type === 'event_queue_overflow') {
        yield* health.updateControl({
          state: 'connecting',
          lastFailure: 'event_backpressure',
        });
        yield* logEffect('warn', 'daemon', 'daemon_control_event_backpressure');
        return finish(false);
      }
      if (event.type === 'connection_watchdog_expired') {
        yield* recordControlRegistrationOutcome(`${event.phase}_timeout`);
        yield* health.updateControl({
          state: 'connecting',
          lastFailure: `${event.phase}_timeout`,
        });
        yield* logEffect(
          'warn',
          'daemon',
          event.phase === 'socket_open'
            ? 'daemon_control_socket_open_timeout'
            : 'daemon_control_registration_timeout',
          { timeoutMs: event.timeoutMs },
        );
        return finish(false);
      }
      if (event.type === 'stable_uptime_elapsed') {
        stableUptimeElapsed = true;
        continue;
      }
      if (event.type === 'process_resumed') {
        // Distinct from a pong timeout on purpose: conflating them is what made
        // `controlPingOutcomes.timeout` unreadable, since a sleeping laptop and
        // a broken network landed in the same bucket.
        yield* recordControlPingOutcome('suspended');
        yield* health.updateControl({
          state: 'connecting',
          lastFailure: 'process_suspended',
        });
        yield* logEffect('warn', 'daemon', 'daemon_control_process_resumed', {
          gapMs: event.gapMs,
        });
        return finish(false, 'process_suspended');
      }
      if (event.type === 'network_path_changed') {
        // No special backoff, deliberately. The existing ladder already does the
        // right thing: a change on a long-lived stable carrier resets it and
        // reconnects in ~250ms, while a flapping interface never reaches stable
        // and therefore backs off geometrically to the 30s cap.
        yield* health.updateControl({
          state: 'connecting',
          lastFailure: 'network_path_changed',
        });
        yield* logEffect('info', 'daemon', 'daemon_control_network_path_changed', {
          coalescedEvents: event.coalescedEvents,
        });
        return finish(false, 'network_path_changed');
      }
      if (event.type === 'pong_deadline') {
        if (event.epoch !== pongDeadlineEpoch) continue;
        yield* recordControlPingOutcome('timeout');
        yield* health.updateControl({
          state: 'connecting',
          lastFailure: 'ping_timeout',
        });
        yield* logEffect('warn', 'daemon', 'daemon_control_ping_timeout', {
          pongTimeoutMs: event.timeoutMs,
        });
        return finish(false);
      }
      if (event.type === 'ping_due') {
        if (Option.isNone(registration)) continue;
        if (!(yield* sendPing)) {
          return finish(false);
        }
        // `now()`, not `Clock.currentTimeMillis`, for the reason documented on
        // the dependency: TestClock advances straight to each sleeper's
        // deadline, so a Clock-based round-trip measurement is identically zero
        // under test and would silently report a perfect link.
        pingSentAtMs = now();
        continue;
      }
      if (event.type === 'socket_pong') {
        if (Option.isNone(registration)) continue;
        yield* recordControlPingOutcome('pong');
        if (pingSentAtMs !== null) {
          recordControlPingRttMs(now() - pingSentAtMs);
          pingSentAtMs = null;
        }
        yield* markStableAfterPong;
        pongDeadlineEpoch += 1;
        yield* armPongDeadline(
          pongDeadline,
          events,
          fatal,
          childFailure,
          pongDeadlineEpoch,
          pongTimeoutMs(registration.value),
        );
        continue;
      }
      if (event.type === 'command_completed') {
        if (!pendingCommands.delete(event.commandId)) {
          yield* logEffect('warn', 'daemon', 'daemon_control_unmatched_command_completion', {
            commandId: event.commandId,
          });
          continue;
        }
        if (
          event.result.status === 'rejected' &&
          event.result.reason === 'revocation_persistence_failed'
        ) {
          yield* health.updateControl({
            state: 'connecting',
            lastFailure: 'revocation_persistence_failed',
          });
          yield* logEffect('warn', 'daemon', 'daemon_control_revocation_persistence_failed', {
            commandId: event.commandId,
          });
          return finish(false);
        }
        // Only an accepted command is memoized, and the distinction is
        // load-bearing rather than an optimization. The memo exists to stop a
        // replay from applying the same command twice; a rejected command
        // applied nothing, so a replay has to actually run it again. The
        // revocation outbox reuses one commandId until it is acknowledged, so
        // memoizing a transient rejection — an unwritable or restarting
        // dataplane, an ack timeout, backpressure — would answer every later
        // retry from cache without ever reaching the dataplane, and the
        // revocation would sit unapplied for the life of the entry.
        //
        // Record before acknowledging. If the socket dies between the two, the
        // server replays and the memo answers — which is the whole point.
        if (event.result.status === 'accepted') {
          yield* appliedCommands.remember(event.commandId, event.result);
        }
        if (!(yield* send(createDaemonControlCommandAckMessage(event.commandId, event.result)))) {
          return finish(false);
        }
        continue;
      }

      if (!proofSent) {
        const nonce = parseDaemonChallenge(event.data);
        if (nonce === null) return yield* protocolViolation;
        const transcript = daemonControlTranscript(
          config.daemon_id,
          new URL(DAEMON_CONTROL_PATH, config.server_origin).href,
          headers[DAEMON_VERSION_HEADER] ?? '',
          headers[DAEMON_RESUME_PRESENCE_HEADER] ?? null,
          nonce,
        );
        const proof = yield* dataplane.signDaemonProofEffect(
          crypto.randomUUID(),
          'control',
          transcript,
        );
        if (proof.status === 'rejected') return finish(false);
        const sent = yield* Effect.try({
          try: () =>
            socket.send(
              JSON.stringify({
                type: 'auth_proof',
                signature: proof.signature,
                p256_signature: proof.p256Signature,
              }),
            ),
          catch: () => undefined,
        }).pipe(
          Effect.as(true),
          Effect.catch(() => Effect.succeed(false)),
        );
        if (!sent) return yield* protocolViolation;
        proofSent = true;
        continue;
      }
      const message = parseDaemonControlServerMessage(event.data);
      if (message === null) {
        return yield* protocolViolation;
      }
      if (message.type === 'superseded') {
        yield* recordControlRegistrationOutcome('superseded');
        yield* health.updateControl({
          state: 'superseded',
          lastFailure: null,
        });
        yield* logEffect('warn', 'daemon', 'daemon_control_superseded_received');
        yield* closeControlSocket(socket, NORMAL_CLOSE_CODE, 'superseded');
        return finish(true);
      }
      if (message.type === 'registered') {
        if (Option.isSome(registration) || message.silentAfterMs <= message.pingIntervalMs) {
          return yield* protocolViolation;
        }
        registration = Option.some(message);
        yield* recordControlRegistrationOutcome('registered');
        yield* Deferred.succeed(registered, undefined).pipe(Effect.asVoid);
        yield* health.updateControl({
          state: 'registered',
          connectionId: message.connectionId,
          lastFailure: null,
        });
        yield* logEffect('info', 'daemon', 'daemon_control_registered', {
          connectionId: message.connectionId,
          presenceId: message.presenceId,
          claimSeq: message.claimSeq,
        });
        yield* pushRevocationGeneration(message.revocationGeneration);
        // Unconditional rather than deduplicated: every ticket is distinct by
        // construction, and the dataplane treats the first credential as the
        // signal to reprobe while later ones only swap the ticket in place.
        dataplane.updateStunCredential({
          servers: message.stunServers,
          ticket: message.stunTicket,
          secret: message.stunTicketSecret,
          lifetime_ms: message.stunTicketLifetimeMs,
        });
        // Before any session_start can arrive on this connection, so the first
        // edge dial already holds a ticket and current pins, and a dataplane
        // that just started states its incarnation to every edge.
        dataplane.updateEdgeAdmission({ ticket: message.edgeAttachTicket, edges: message.edges });
        // The first ping goes out immediately: the server's silence window
        // starts at registration, and the producer below only fires after a
        // full interval.
        if (!(yield* sendPing)) {
          return finish(false);
        }
        pingSentAtMs = now();

        pongDeadlineEpoch += 1;
        yield* armPongDeadline(
          pongDeadline,
          events,
          fatal,
          childFailure,
          pongDeadlineEpoch,
          pongTimeoutMs(message),
        );
        yield* runPingProducer(events, fatal, message.pingIntervalMs, now).pipe(
          (effect) => linkControlChild(effect, childFailure),
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* runStableConnectionTimer(events, fatal, stableConnectionUptimeMs).pipe(
          (effect) => linkControlChild(effect, childFailure),
          Effect.forkScoped({ startImmediately: true }),
        );
        continue;
      }
      if (Option.isNone(registration)) {
        return yield* protocolViolation;
      }
      if (message.type === 'lease') {
        yield* pushRevocationGeneration(message.revocationGeneration);
        // The servers do not change between leases, so the registered list is
        // reused; only the ticket and its key are replaced.
        dataplane.updateStunCredential({
          servers: registration.value.stunServers,
          ticket: message.stunTicket,
          secret: message.stunTicketSecret,
          lifetime_ms: message.stunTicketLifetimeMs,
        });
        dataplane.updateEdgeAdmission({ ticket: message.edgeAttachTicket, edges: message.edges });
        continue;
      }
      if (message.type === 'revocation') {
        yield* pushRevocationGeneration(message.revocationGeneration);
        continue;
      }

      // A replayed command is the ordinary case after a reconnect: the server
      // re-sends whatever it never saw acknowledged. Re-executing would be a
      // correctness bug rather than a wasted round — replaying a `session_start`
      // the daemon already completed tears down a working edge dial and
      // restarts it. Answer from the memo instead.
      //
      // There is no "applied but forgotten" branch, and there cannot be: the
      // memo expires entries only long after the server has stopped replaying
      // them. See `APPLIED_COMMAND_MEMO_TTL_MS`.
      const applied = yield* appliedCommands.result(message.commandId);
      if (applied !== undefined) {
        if (!(yield* send(createDaemonControlCommandAckMessage(message.commandId, applied)))) {
          return finish(false);
        }
        continue;
      }

      if (pendingCommands.has(message.commandId)) {
        if (
          !(yield* send(
            createDaemonControlCommandAckMessage(message.commandId, {
              status: 'rejected',
              reason: 'duplicate_command',
            }),
          ))
        ) {
          return finish(false);
        }
        continue;
      }
      if (pendingCommands.size >= maxPendingCommands) {
        if (
          !(yield* send(
            createDaemonControlCommandAckMessage(message.commandId, {
              status: 'rejected',
              reason: 'control_backpressure',
            }),
          ))
        ) {
          return finish(false);
        }
        continue;
      }

      pendingCommands.add(message.commandId);
      yield* logEffect(
        'info',
        'daemon',
        message.type === 'session_start'
          ? 'session_start_received'
          : message.type === 'session_cancel'
            ? 'session_cancel_received'
            : 'delegation_revoke_received',
        message.type === 'delegation_revoke' ? {} : { sessionId: message.sessionId },
      );
      yield* runDataplaneCommand(message, dataplane, persistRevocations, events, fatal).pipe(
        (effect) => linkControlChild(effect, childFailure),
        Effect.forkScoped({ startImmediately: true }),
      );
    }
  });
}

function installControlSocketHandlers(
  adapter: ControlSocketAdapter,
  events: Queue.Queue<ControlEvent>,
  fatal: Deferred.Deferred<ControlEvent>,
): void {
  const offer = (event: ControlEvent): void => {
    if (!adapter.active) return;
    if (Queue.offerUnsafe(events, event)) return;

    adapter.active = false;
    Deferred.doneUnsafe(fatal, Effect.succeed<ControlEvent>({ type: 'event_queue_overflow' }));
    terminateControlSocketImmediately(adapter.socket);
  };

  adapter.socket.onopen = () => {
    offer({ type: 'socket_open' });
  };
  adapter.socket.onmessage = (event) => {
    offer({ type: 'socket_message', data: event.data });
  };
  adapter.socket.onerror = () => {
    offer({ type: 'socket_error' });
  };
  adapter.socket.onclose = (event) => {
    offer({ type: 'socket_closed', code: event.code });
  };
  adapter.socket.onpong = () => {
    offer({ type: 'socket_pong' });
  };
  // A test adapter or an unusually fast native implementation may already be
  // open by the time callback ownership is installed. Publish that state
  // through the same bounded queue so registration cannot outrun its watchdog.
  if (adapter.socket.readyState === 1) {
    offer({ type: 'socket_open' });
  }
}

function releaseControlSocket(
  adapter: ControlSocketAdapter,
  events: Queue.Queue<ControlEvent>,
  shutdownIntent: Deferred.Deferred<void> | undefined,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    // Stop feeding the event queue first; the socket may still fire callbacks
    // during the graceful close below and none of them is actionable now.
    adapter.active = false;
    // This finalizer runs on every attempt teardown, so the close code is gated
    // on explicit intent: a timeout, a path change or an overflow must reach the
    // server as a lost carrier, never as a deliberate stop.
    const graceful =
      shutdownIntent !== undefined &&
      (yield* Deferred.isDone(shutdownIntent)) &&
      adapter.socket.readyState === 1;
    if (graceful) {
      // `terminate()` straight after `close()` aborts the stream before the
      // close frame is flushed and the server sees 1006. Keep `onclose` wired
      // and wait, briefly, for the handshake to complete.
      const closed = yield* Deferred.make<void>();
      adapter.socket.onclose = () => {
        Deferred.doneUnsafe(closed, Effect.void);
      };
      yield* closeControlSocket(adapter.socket, DAEMON_SHUTDOWN_CLOSE_CODE, 'daemon_shutdown');
      yield* Deferred.await(closed).pipe(
        Effect.timeout(`${SHUTDOWN_CLOSE_GRACE_MS} millis`),
        Effect.ignore,
      );
    }
    yield* Effect.sync(() => {
      adapter.socket.onopen = null;
      adapter.socket.onmessage = null;
      adapter.socket.onerror = null;
      adapter.socket.onclose = null;
      adapter.socket.onpong = null;
    });
    yield* Queue.shutdown(events).pipe(Effect.asVoid);
    yield* Effect.sync(() => {
      terminateControlSocketImmediately(adapter.socket);
    });
  });
}

function terminateControlSocketImmediately(socket: DaemonControlSocket): void {
  if (socket.readyState === 3) return;
  const terminate = socket.terminate;
  if (terminate !== undefined) {
    try {
      terminate.call(socket);
    } catch {
      // Best-effort termination at the native WebSocket boundary.
    }
  }
  if (socket.readyState < 2) {
    try {
      socket.close();
    } catch {
      // The Effect scope has already detached every callback.
    }
  }
}

function closeControlSocket(
  socket: DaemonControlSocket,
  code: number,
  reason: string,
): Effect.Effect<void> {
  return Effect.try({
    try: () => {
      socket.close(code, reason);
    },
    catch: () => undefined,
  }).pipe(Effect.ignore);
}

function sendControlMessage(
  socket: DaemonControlSocket,
  message: Parameters<typeof encodeDaemonControlMessage>[0],
): Effect.Effect<void, DaemonControlSocketSendError> {
  return Effect.gen(function* () {
    if (socket.readyState !== 1) {
      return yield* new DaemonControlSocketSendError({ reason: 'socket_not_open' });
    }
    const encoded = yield* Effect.try({
      try: () => encodeDaemonControlMessage(message),
      catch: () => new DaemonControlSocketSendError({ reason: 'encode_failed' }),
    });
    const encodedBytes = Buffer.byteLength(encoded, 'utf8');
    if (
      encodedBytes > MAX_DAEMON_CONTROL_FRAME_BYTES ||
      socket.bufferedAmount + encodedBytes > MAX_CONTROL_BUFFERED_BYTES
    ) {
      return yield* new DaemonControlSocketSendError({ reason: 'outbound_backpressure' });
    }
    return yield* Effect.try({
      try: () => {
        socket.send(encoded);
      },
      catch: () => new DaemonControlSocketSendError({ reason: 'send_failed' }),
    });
  });
}

/**
 * How long this side waits for a pong before declaring the carrier dead: the
 * server's own silence window plus a few intervals of slack, so the server —
 * which owns the lease — always notices first.
 */
function pongTimeoutMs(registration: DaemonControlRegisteredMessage): number {
  return registration.silentAfterMs + PONG_TIMEOUT_INTERVALS * registration.pingIntervalMs;
}

function armPongDeadline(
  handle: FiberHandle.FiberHandle<void, never>,
  events: Queue.Queue<ControlEvent>,
  fatal: Deferred.Deferred<ControlEvent>,
  childFailure: Deferred.Deferred<never>,
  epoch: number,
  timeoutMs: number,
): Effect.Effect<void> {
  return FiberHandle.run(
    handle,
    linkControlChild(
      Effect.sleep(`${timeoutMs} millis`).pipe(
        Effect.andThen(
          offerControlEvent(events, fatal, {
            type: 'pong_deadline',
            epoch,
            timeoutMs,
          }),
        ),
        Effect.asVoid,
      ),
      childFailure,
    ),
  ).pipe(Effect.asVoid);
}

function runPingProducer(
  events: Queue.Queue<ControlEvent>,
  fatal: Deferred.Deferred<ControlEvent>,
  intervalMs: number,
  now: () => number,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    while (true) {
      const startedAtMs = now();
      yield* Effect.sleep(`${intervalMs} millis`);
      // This fiber is the only one running on a cadence shorter than the pong
      // deadline, which makes it the earliest place a resume can be noticed —
      // and it is forked exactly when the pathology becomes possible.
      const gapMs = now() - startedAtMs - intervalMs;
      const suspended = gapMs >= SUSPENSION_GAP_THRESHOLD_MS;
      if (suspended) recordSuspensionGapMs(gapMs);
      const offered = yield* offerControlEvent(
        events,
        fatal,
        suspended ? { type: 'process_resumed', gapMs } : { type: 'ping_due' },
      );
      // Stop after a resume rather than queueing a ping behind the event that
      // is about to tear this connection down.
      if (!offered || suspended) return;
    }
  });
}

/**
 * Bridges the process-lifetime path signal into this connection's bounded event
 * queue.
 *
 * Deliberately shaped like `runPingProducer` rather than added as a third
 * racer in the main loop: the loop's `raceFirst(take, fatal)` is what gives
 * fatal events priority over queued ones, and the queue's dropping policy is
 * what escalates overflow. Both stay untouched this way.
 */
function runControlPathSignalConsumer(
  signals: Queue.Dequeue<DaemonControlPathSignal>,
  events: Queue.Queue<ControlEvent>,
  fatal: Deferred.Deferred<ControlEvent>,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    while (true) {
      const signal = yield* Queue.take(signals);
      const offered = yield* offerControlEvent(events, fatal, {
        type: 'network_path_changed',
        coalescedEvents: signal.coalescedEvents,
      });
      if (!offered) return;
    }
  });
}

function runConnectionWatchdog(
  socketOpened: Deferred.Deferred<void>,
  registered: Deferred.Deferred<void>,
  events: Queue.Queue<ControlEvent>,
  fatal: Deferred.Deferred<ControlEvent>,
  configuredSocketOpenTimeoutMs: number,
  configuredRegistrationTimeoutMs: number,
): Effect.Effect<void> {
  const socketOpenTimeoutMs = normalizePositiveDuration(
    configuredSocketOpenTimeoutMs,
    SOCKET_OPEN_TIMEOUT_MS,
  );
  const registrationTimeoutMs = normalizePositiveDuration(
    configuredRegistrationTimeoutMs,
    REGISTRATION_TIMEOUT_MS,
  );

  return Deferred.await(socketOpened).pipe(
    Effect.timeoutOrElse({
      duration: `${socketOpenTimeoutMs} millis`,
      orElse: () =>
        Effect.fail(
          new DaemonControlWatchdogExpired({
            phase: 'socket_open',
            timeoutMs: socketOpenTimeoutMs,
          }),
        ),
    }),
    Effect.andThen(
      Deferred.await(registered).pipe(
        Effect.timeoutOrElse({
          duration: `${registrationTimeoutMs} millis`,
          orElse: () =>
            Effect.fail(
              new DaemonControlWatchdogExpired({
                phase: 'registration',
                timeoutMs: registrationTimeoutMs,
              }),
            ),
        }),
      ),
    ),
    Effect.catchTag('DaemonControlWatchdogExpired', (error) =>
      offerControlEvent(events, fatal, {
        type: 'connection_watchdog_expired',
        phase: error.phase,
        timeoutMs: error.timeoutMs,
      }).pipe(Effect.asVoid),
    ),
  );
}

function runStableConnectionTimer(
  events: Queue.Queue<ControlEvent>,
  fatal: Deferred.Deferred<ControlEvent>,
  configuredUptimeMs: number,
): Effect.Effect<void> {
  const uptimeMs = normalizePositiveDuration(configuredUptimeMs, STABLE_CONNECTION_UPTIME_MS);
  return Effect.sleep(`${uptimeMs} millis`).pipe(
    Effect.andThen(offerControlEvent(events, fatal, { type: 'stable_uptime_elapsed' })),
    Effect.asVoid,
  );
}

function runDataplaneCommand(
  command: DaemonControlCommandMessage,
  dataplane: Pick<
    DataplaneClient,
    'startSessionEffect' | 'cancelSessionEffect' | 'revokeDelegationEffect'
  >,
  persistRevocations: (
    targets: readonly DelegationRevocationTarget[],
  ) => Effect.Effect<DataplaneCommandResult>,
  events: Queue.Queue<ControlEvent>,
  fatal: Deferred.Deferred<ControlEvent>,
): Effect.Effect<void> {
  const admission = (
    command.type === 'session_start'
      ? dataplane.startSessionEffect(
          command.commandId,
          command.sessionId,
          command.browserNodeId,
          command.offer.userId,
          command.offer.delegationId,
          command.offer.clientNonce,
          command.offer.encapsulationKey,
          command.offer.edgeWtUrl,
          command.offer.edgeCertHashes,
        )
      : command.type === 'session_cancel'
        ? dataplane.cancelSessionEffect(command.commandId, command.sessionId, command.browserNodeId)
        : dataplane.revokeDelegationEffect(
            command.commandId,
            command.actorCertificate,
            command.revocation,
          )
  ).pipe(
    Effect.map(normalizeCommandResult),
    Effect.flatMap((result) =>
      command.type === 'delegation_revoke' && result.status === 'accepted'
        ? persistRevocations(command.revocation.targets)
        : Effect.succeed(result),
    ),
  );

  return admission.pipe(
    Effect.flatMap((result) =>
      offerControlEvent(events, fatal, {
        type: 'command_completed',
        commandId: command.commandId,
        result,
      }),
    ),
    Effect.asVoid,
    Effect.withSpan('daemon.control.command_admission', commandSpanOptions(command)),
  );
}

/**
 * Span options for one admitted command.
 *
 * The parent is the command's own trace context, not the control connection's.
 * That socket was opened long before this command and lives for hours, so
 * parenting there would put every command a daemon ever handles under a single
 * span — the same shape that once fused 12.7 hours of server requests into one
 * trace. An absent or malformed `traceparent` roots a new trace, which is what
 * a daemon acting on its own should do.
 */
function commandSpanOptions(command: DaemonControlCommandMessage) {
  const parent = parseTraceparent(command.traceparent);
  return {
    kind: 'consumer' as const,
    ...(parent === null ? {} : { parent: Tracer.externalSpan(parent) }),
    attributes: spanAttributes({
      'merkur.command.id': command.commandId,
      'merkur.command.type': command.type,
      'merkur.session.id': command.type === 'delegation_revoke' ? '' : command.sessionId,
    }),
  };
}

function offerControlEvent(
  events: Queue.Queue<ControlEvent>,
  fatal: Deferred.Deferred<ControlEvent>,
  event: ControlEvent,
): Effect.Effect<boolean> {
  return Queue.offer(events, event).pipe(
    Effect.tap((offered) =>
      offered
        ? Effect.void
        : Deferred.succeed(fatal, { type: 'event_queue_overflow' }).pipe(Effect.asVoid),
    ),
  );
}

function linkControlChild<A, R>(
  effect: Effect.Effect<A, never, R>,
  childFailure: Deferred.Deferred<never>,
): Effect.Effect<A, never, R> {
  return effect.pipe(
    Effect.onError((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.void
        : Deferred.failCause(childFailure, cause).pipe(Effect.asVoid),
    ),
  );
}

function normalizeEventQueueCapacity(value: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : DAEMON_CONTROL_EVENT_QUEUE_CAPACITY;
}

function normalizePositiveDuration(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function jitteredDelay(baseDelayMs: number, randomValue: number): number {
  const boundedRandom = Number.isFinite(randomValue) ? Math.min(1, Math.max(0, randomValue)) : 0.5;
  return Math.max(0, Math.round(baseDelayMs * (0.5 + boundedRandom)));
}

function normalizeRejectionReason(reason: string): string {
  return /^[a-z][a-z0-9_]*$/u.test(reason) && Buffer.byteLength(reason, 'utf8') <= 64
    ? reason
    : 'dataplane_rejected';
}

function normalizeCommandResult(result: DataplaneCommandResult): DataplaneCommandResult {
  return result.status === 'accepted'
    ? { status: 'accepted' }
    : {
        status: 'rejected',
        reason: normalizeRejectionReason(result.reason),
      };
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized === 'localhost' || normalized === '[::1]' || normalized === '::1') {
    return true;
  }
  const octets = normalized.split('.');
  if (octets.length !== 4 || octets[0] !== '127') {
    return false;
  }
  return octets.every((octet) => {
    if (!/^\d{1,3}$/u.test(octet)) return false;
    const value = Number(octet);
    return value >= 0 && value <= 255 && String(value) === octet;
  });
}
