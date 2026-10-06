import type { Readable, Writable } from 'node:stream';
import type { DaemonIdentitySeal } from '@merkur/config';
import type { DaemonControlEdge } from '@merkur/daemon-control-protocol';
import {
  createNativePerfTraceValidator,
  hasExactKeys,
  isNativePerfTraceChunk,
  isRecord,
  type NativePerfTraceChunk,
} from '@merkur/shared';
import {
  createSidecarFrame,
  encodeSidecarCommand,
  isSidecarInputWritable,
  SidecarFrameReader,
  SidecarPayloadTooLargeError,
  spawnFramedSidecarProcess,
} from '@merkur/shared/node-sidecar';
import type {
  DaemonBinding,
  DelegationRevocationStatement,
  DelegationRevocationTarget,
  UserDelegationCertificate,
} from '@merkur/shared/user-authorization';
import { Cause, Context, Data, Deferred, Duration, Effect, Layer, Queue, type Scope } from 'effect';
import type { Logger } from '../logger';
import { type DataplaneMetricEvent, recordDataplaneMetricEvent } from './daemon-metrics';
import { resolveDataplaneBinaryPath } from './dataplane-binary';

const DEFAULT_DATAPLANE_RUST_LOG = 'warn,merkur_dataplane=info';

const RECONNECT_DELAY_MS = 250;
const RECONNECT_MAX_DELAY_MS = 30_000;
const SIDECAR_STABLE_UPTIME_MS = 10_000;
const SIDECAR_COMMAND_DRAIN_TIMEOUT_MS = 5_000;
const SIDECAR_COMMAND_ACK_TIMEOUT_MS = 5_000;
const SIDECAR_SHUTDOWN_GRACE_PERIOD_MS = 3_000;
const SIDECAR_SHUTDOWN_REAP_TIMEOUT_MS = 2_000;
const SIDECAR_READINESS_TIMEOUT_MS = 15_000;
const MAX_CONSECUTIVE_AMBIGUOUS_EXITS = 3;
// Includes the complete frame already accepted by a write(false) call until
// `drain`, so retained command memory cannot escape these admission bounds.
export const MAX_DATAPLANE_COMMAND_QUEUE_ENTRIES = 256;
export const MAX_DATAPLANE_COMMAND_QUEUE_BYTES = 8 * 1024 * 1024;
export const MAX_PENDING_DATAPLANE_COMMANDS = 256;

const CMD_CONFIGURE = 0x01;
const CMD_UPDATE_REVOCATION = 0x08;
const CMD_START_SESSION = 0x09;
const CMD_CANCEL_SESSION = 0x0a;
const CMD_REVOKE_DELEGATION = 0x0b;
const CMD_UPDATE_STUN = 0x0c;
const CMD_CAPTURE_TRANSPORT_STATS = 0x0d;
const CMD_CAPTURE_PERF_TRACE = 0x0e;
const CMD_SHUTDOWN = 0x0f;
const CMD_SIGN_DAEMON_PROOF = 0x10;
const CMD_UPDATE_EDGE_ADMISSION = 0x11;

const EVT_PTY_READY = 0x82;
const EVT_PTY_CLOSED = 0x83;
const EVT_BELL = 0x85;
const EVT_PEER_DISCONNECTED = 0x88;
const EVT_ERROR = 0x8a;
const EVT_NETWORK_PATH_CHANGED = 0x8c;
const EVT_NAT_MAPPING_OUTCOME = 0x91;
const EVT_WEBTRANSPORT_READY = 0x8d;
const EVT_PEER_AUTHENTICATED = 0x8e;
const EVT_COMMAND_ACK = 0x8f;
const EVT_TRANSPORT_STATS = 0x90;
const EVT_SESSION_REBIND = 0x92;
const EVT_PERF_TRACE = 0x93;
const EVT_DAEMON_PROOF = 0x94;

const UTF8_DECODER = new TextDecoder();

/** Per-transport slice of one dataplane telemetry sample. All values are integers. */
export interface DataplanePathStats {
  readonly pathsAvailable: number;
  readonly pathsLive: number;
  readonly rttEwmaUsMax: number;
  readonly networkRttEwmaUsMax: number;
  readonly jitterEwmaUsMax: number;
  readonly sendFailuresMax: number;
  readonly lastAckAgeMsMax: number;
  readonly displayDatagramsReceived: number;
  readonly displayDatagramsRecoveredByFec: number;
  readonly displayDatagramsDeclaredLost: number;
  readonly displayDatagramsOutcomeUnknown: number;
  readonly quicSentPackets: number;
  readonly quicLostPackets: number;
  readonly quicLostBytes: number;
  readonly quicCongestionEvents: number;
  readonly quicBlackHoles: number;
  readonly quicDatagramsTx: number;
  readonly quicDatagramsRx: number;
  readonly quicUdpTxBytes: number;
  readonly quicUdpRxBytes: number;
  readonly quicMtuMin: number;
  readonly quicCwndBytesMin: number;
  readonly quicRttUsMax: number;
}

/**
 * One periodic transport/display statistics sample from the Rust dataplane.
 *
 * The shape is fixed and its size does not depend on peer count: the dataplane
 * aggregates per-transport values with `max` or `sum` rather than emitting a
 * per-peer array. No peer identity crosses this boundary, which is what keeps
 * the downstream metrics free of unbounded label cardinality.
 */
export interface DataplaneTransportStats {
  readonly windowMs: number;
  readonly peers: number;
  readonly parkedPeers: number;
  readonly webtransport: DataplanePathStats;
  readonly edge: DataplanePathStats;
  readonly rowVersionsSent: number;
  readonly rowVersionsSupersededUnapplied: number;
  readonly rowVersionsSupersededApplied: number;
  readonly rowResendsIdentical: number;
  readonly stalePreparedFlushesSent: number;
  readonly burstsAbandoned: number;
  readonly burstsUnsafeToRewind: number;
  readonly datagramSendFailures: number;
  readonly fecRepairsSent: number;
  readonly fecRepairsRefused: number;
  readonly resyncRowsRequested: number;
  readonly rowsDeclaredLost: number;
  readonly unackedDatagramsMax: number;
  readonly edgeReliableQueuedBytesMax: number;
  readonly inboundDatagramDropsWt: number;
  readonly inboundDatagramDropsEdge: number;
  readonly overCapacitySessionRejections: number;
  /**
   * Inbound connections that reached the direct-WebTransport listener, split by
   * whether an offer recently named the source address, and how many completed
   * the authenticated upgrade.
   *
   * These are the daemon half of "was the direct path filtered". Browsers can
   * report dialling a candidate and hearing nothing, but cannot tell a firewall
   * from a daemon that was not listening; only this side can.
   *
   * The split is what makes that readable. An undifferentiated arrival count is
   * dominated by internet background scanning of a public UDP port — the fleet
   * recorded roughly 300,000 arrivals in a day against about a hundred upgrade
   * attempts — so "browsers dialled and this stayed zero" was never observable.
   * Read `directWtIncomingExpected` against the browser's `no_settle`
   * dispositions: zero expected arrivals is a filtering answer, while expected
   * arrivals without admissions is a Merkur bug.
   */
  readonly directWtIncomingExpected: number;
  readonly directWtIncomingUnexpected: number;
  readonly directWtAdmitted: number;
  /**
   * NAT side-channel activity: keepalives that hold the reflexive mapping open
   * against RFC 4787's idle timer, punch bursts that open filter state toward a
   * browser before it dials, and the refusals that mean neither happened.
   *
   * A non-zero `natPunchRefusedRateLimited` means the pinhole was not open when
   * the browser dialled, which is a direct and fixable cause of a candidate that
   * never settles. It was previously visible only in a local log line.
   */
  readonly natKeepalivesSent: number;
  readonly natPunchBurstsSent: number;
  readonly natPunchRefusedNotGlobal: number;
  readonly natPunchRefusedRateLimited: number;
  readonly natSideChannelSendFailed: number;
  readonly natSideChannelWouldBlock: number;
  readonly statsEventsDropped: number;
  /**
   * Carrier-rebind tallies since the dataplane started.
   *
   * `EVT_SESSION_REBIND` carries the per-attempt diagnosis but is rate-bounded,
   * so a flood would erase the evidence that a flood happened. These carry the
   * rate and survive it. `rebindRequests` is the denominator.
   */
  readonly rebindRequests: number;
  readonly rebindAccepted: number;
  readonly rebindCommitted: number;
  readonly rebindRefused: number;
  readonly rebindEnvelopesRejected: number;
  readonly rebindEventsSuppressed: number;
}

export interface DataplaneHandlers {
  onSidecarExited(reason: string): void;
  onPtyReady(pid: number): void;
  onPtyClosed(exitCode: number, signal: number): void;
  onBell(): void;
  onPeerDisconnected(peerNodeId: string, reason: string): void;
  onError(message: string): void;
  /**
   * One coalesced OS network-path transition. The daemon's control carrier is
   * almost certainly dead after this, so the control client stops waiting for a
   * pong deadline to tell it so.
   */
  onNetworkPathChanged(coalescedEvents: number): void;
  /** One completed port-mapping cycle, as a closed-set `<who>:<what>` label. */
  onNatMappingOutcome(outcome: string): void;
  onWebTransportReady(
    port: number,
    certHash: string,
    candidates: Array<{ addr: string; port: number; kind: string }>,
    /** `Ipv6Reachability::as_str` from the dataplane: `reachable` or `unknown`. */
    ipv6Reachability: string,
  ): void;
  onPeerAuthenticated(peerNodeId: string, browserNodeId: string, sessionId: string): void;
}

export interface DataplaneStunCredential {
  /** `host:port` vantage points; at least two, or NAT behaviour is unknowable. */
  readonly servers: readonly string[];
  /** Opaque to the daemon: forwarded verbatim, never interpreted. */
  readonly ticket: string;
  /** base64url of the per-ticket MESSAGE-INTEGRITY-SHA256 key. */
  readonly secret: string;
  /**
   * Validity as a duration. The dataplane stamps it against its own monotonic
   * clock on arrival and refuses to spend a probe on an expired credential —
   * the responder would answer with silence, and silence on the reprobe path
   * is indistinguishable from a network fault.
   *
   * Snake case because this object is serialized verbatim into the IPC frame,
   * like every other command payload here. `UpdateStunCmd` is
   * `deny_unknown_fields`, so a camelCase key is not a style slip — it makes
   * the sidecar reject the whole command and silently keep probing with no
   * credential at all.
   */
  readonly lifetime_ms: number;
}

export interface DataplaneConfig {
  readonly session_token_verify_key: string;
  readonly daemon_id: string;
  readonly daemon_identity_seal: DaemonIdentitySeal;
  readonly server_origin: string;
  readonly user_root_public_key: string;
  readonly root_epoch: number;
  readonly daemon_binding: DaemonBinding;
  readonly revoked_delegations: readonly DelegationRevocationTarget[];
  /** PTY executable selected before the sidecar reads its first IPC command. */
  readonly shell: string;
  /** Pinned UDP port for the direct WebTransport server. */
  readonly webtransport_port: number;
  /**
   * Path to the shell-integration token file, or `null` when the daemon could
   * not establish one.
   *
   * A process-start argument for the same reason as `shell`: the dataplane
   * reads the token once, before the PTY is spawned, because the same bytes
   * have to go into the child's environment AND into the OSC verifier.
   *
   * The PATH crosses the command line, never the token. The token is not a
   * secret against other local processes of this user, but publishing it to
   * every `ps` on the machine would be gratuitous.
   */
  readonly shell_token_path: string | null;
  /**
   * Directory holding the `merkur-open` helper (and, on Linux, the `xdg-open`
   * stand-in), or `null` when the daemon could not write it.
   *
   * A process-start argument like `shell`: the PTY environment that names the
   * helper as `$BROWSER` is fixed when the shell is spawned.
   */
  readonly open_url_bin_dir: string | null;
  /**
   * `host:port` an operator-installed port mapping publishes this daemon on,
   * or `null` when nothing has told it.
   *
   * A process-start argument like the three above, and for the same reason: the
   * WebTransport server gathers its candidate set during startup, so a value
   * arriving afterwards would be gathered too late to be offered.
   */
  readonly public_wt_endpoint: string | null;
}

/**
 * The subset of `DataplaneConfig` that crosses the IPC `configure` command.
 *
 * `shell`, `webtransport_port`, `shell_token_path`, `open_url_bin_dir`, and
 * `public_wt_endpoint` are excluded because all five are process-start arguments
 * (`--shell`, `--wt-port`, `--shell-token-path`, `--open-url-bin-dir`,
 * `--public-wt-endpoint`), not runtime
 * state: the PTY executable is chosen before
 * the sidecar reads its first command, the WebTransport server binds its port
 * during startup, and the token is read before the PTY exists. Sending any of
 * them would be inert at best,
 * and the Rust `ConfigurePayload` denies unknown fields, so it is not inert —
 * one extra key rejects the whole payload and leaves the dataplane with no
 * session-auth authority, which presents as every session hanging in SIGNALING
 * rather than as a config error.
 */
type DataplaneWireConfig = Omit<
  DataplaneConfig,
  'shell' | 'webtransport_port' | 'shell_token_path' | 'open_url_bin_dir' | 'public_wt_endpoint'
>;

export type DataplaneCommandResult =
  | { readonly status: 'accepted' }
  | { readonly status: 'rejected'; readonly reason: string };

export type DataplaneHealthState = 'down' | 'starting' | 'ready' | 'fatal';

export type DataplaneFatalReason =
  | 'identity_unsealable'
  | 'binary_not_found'
  | 'binary_permission_denied'
  | 'binary_not_executable'
  | 'command_schema_error'
  | 'invalid_event'
  | 'internal_defect'
  | 'sidecar_crash_loop'
  | 'sidecar_nonzero_exit'
  | 'sidecar_panic'
  | 'sidecar_reap_timeout'
  | 'protocol_error'
  | 'spawn_error';

export class DataplaneFatalError extends Data.TaggedError('DataplaneFatalError')<{
  readonly reason: DataplaneFatalReason;
  readonly cause?: unknown;
}> {}

export type DataplaneProof = { readonly signature: string; readonly p256Signature: string };
export type DataplaneProofResult =
  | ({ readonly status: 'accepted' } & DataplaneProof)
  | { readonly status: 'rejected'; readonly reason: string };

export interface DataplaneClient {
  signDaemonProofEffect(
    commandId: string,
    purpose: 'http' | 'control',
    transcript: Uint8Array,
  ): Effect.Effect<DataplaneProofResult>;
  start(): void;
  stop(): void;
  shutdown(): Effect.Effect<void>;
  awaitCriticalFailure(): Effect.Effect<never, DataplaneFatalError>;
  configure(config: DataplaneConfig): void;
  startSessionEffect(
    commandId: string,
    sessionId: string,
    browserNodeId: string,
    userId: string,
    delegationId: string,
    clientNonce: string,
    encapsulationKey: string,
    edgeWtUrl: string,
    edgeCertHashes: readonly string[],
  ): Effect.Effect<DataplaneCommandResult>;
  cancelSessionEffect(
    commandId: string,
    sessionId: string,
    browserNodeId: string,
  ): Effect.Effect<DataplaneCommandResult>;
  revokeDelegationEffect(
    commandId: string,
    actorCertificate: UserDelegationCertificate,
    revocation: DelegationRevocationStatement,
  ): Effect.Effect<DataplaneCommandResult>;
  /**
   * Ask the Rust owner loop for an immediate partial-window transport sample.
   * The acknowledgement follows that sample in the same event sink, so an
   * accepted result proves the complete sample was emitted before it.
   */
  captureTransportStatsEffect(commandId: string): Effect.Effect<DataplaneCommandResult>;
  /** Cold capture; accepted only after every exact FIFO chunk and the native acknowledgement. */
  capturePerfTraceEffect(
    commandId: string,
    onChunk: (chunk: NativePerfTraceChunk) => void,
  ): Effect.Effect<DataplaneCommandResult>;
  updateRevocation(generation: number): void;
  /**
   * Replace the STUN credential used for NAT discovery.
   *
   * Sent on registration and refreshed with every control lease. Retained so
   * a replacement sidecar is handed the current credential during replay,
   * exactly like the configure payload and revocation generation.
   */
  updateStunCredential(credential: DataplaneStunCredential): void;
  /**
   * Replace what every edge dial presents and pins: the attach ticket, and the
   * registry's edges with their certificate hashes.
   *
   * Sent on registration and refreshed with every control lease, and retained
   * for replay like the STUN credential, so a replacement sidecar states its
   * incarnation to every edge at once. The ticket is never checked for expiry
   * here: an edge refuses a stale one, which is the correct outcome for a daemon
   * that has lost its control connection for a ticket's lifetime.
   */
  updateEdgeAdmission(admission: DataplaneEdgeAdmission): void;
}

/** The edge part of a control lease, as the dataplane takes it. */
export interface DataplaneEdgeAdmission {
  readonly ticket: string;
  readonly edges: readonly DaemonControlEdge[];
}

export class DataplaneClientService extends Context.Service<
  DataplaneClientService,
  DataplaneClient
>()('DataplaneClientService') {}

export interface DataplaneSidecarProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}

export interface DataplaneClientDependencies {
  readonly resolveBinaryPath: () => string | null;
  readonly spawnSidecar: (
    ...args: Parameters<typeof spawnFramedSidecarProcess>
  ) => DataplaneSidecarProcess;
  readonly scheduleReconnect?: (delayMs: number, reconnect: () => void) => DataplaneTimerHandle;
  readonly scheduleTimer?: (delayMs: number, callback: () => void) => DataplaneTimerHandle;
  readonly stableUptimeMs?: number;
  readonly commandDrainTimeoutMs?: number;
  readonly commandAckTimeoutMs?: number;
  readonly shutdownGracePeriodMs?: number;
  readonly shutdownReapTimeoutMs?: number;
  readonly readinessTimeoutMs?: number;
  readonly maxConsecutiveCrashes?: number;
  readonly recordMetric?: (event: DataplaneMetricEvent) => void;
  readonly recordMetricEffect?: (event: DataplaneMetricEvent) => Effect.Effect<void>;
  readonly updateHealth?: (state: DataplaneHealthState) => Effect.Effect<void>;
}

export interface DataplaneTimerHandle {
  cancel(): void;
}

type SidecarCommandCoalesceKey = 'configure' | 'revocation' | 'stun' | 'edge_admission';

/** `UpdateEdgeAdmissionCmd` in `apps/daemon/dataplane/src/ipc/commands.rs`, key for key. */
export function edgeAdmissionCommand(admission: DataplaneEdgeAdmission): object {
  return {
    ticket: admission.ticket,
    edges: admission.edges.map((edge) => ({
      url: edge.edgeWtUrl,
      cert_hashes: edge.certHashes,
    })),
  };
}

interface QueuedSidecarCommand {
  readonly kind: number;
  readonly frame: Uint8Array;
  readonly coalesceKey: SidecarCommandCoalesceKey | null;
}

interface SidecarCommandWriter {
  readonly child: DataplaneSidecarProcess;
  readonly generation: number;
  readonly stdin: Writable;
  readonly queue: QueuedSidecarCommand[];
  readonly onDrain: () => void;
  queueStart: number;
  queuedBytes: number;
  headSubmitted: boolean;
  blocked: boolean;
  flushing: boolean;
  disposed: boolean;
  drainTimeoutHandle: DataplaneTimerHandle | null;
}

interface PendingDataplaneCommand {
  readonly daemonProof: {
    readonly onProof: (proof: DataplaneProof) => void;
    received: boolean;
  } | null;
  readonly deferred: Deferred.Deferred<DataplaneCommandResult>;
  readonly perfTrace: {
    readonly validator: ReturnType<typeof createNativePerfTraceValidator>;
    readonly onChunk: (chunk: NativePerfTraceChunk) => void;
  } | null;
  timer: DataplaneTimerHandle | null;
}

interface SidecarCloseSignal {
  readonly child: DataplaneSidecarProcess;
  readonly closed: Deferred.Deferred<void>;
  resolveFromClose(): void;
}

interface SidecarRestartTermination {
  readonly closeSignal: SidecarCloseSignal;
  readonly reason: string;
  phase: 'grace' | 'reap';
  timer: DataplaneTimerHandle | null;
}

type SidecarCommandAdmission = 'accepted' | 'unavailable' | 'backpressure' | 'invalid';

const defaultDataplaneClientDependencies: DataplaneClientDependencies = {
  resolveBinaryPath: resolveDataplaneBinaryPath,
  spawnSidecar: spawnFramedSidecarProcess,
};

export function createDataplaneClient(
  logger: Logger,
  handlers: DataplaneHandlers,
  dependencies: DataplaneClientDependencies = defaultDataplaneClientDependencies,
): DataplaneClient {
  return makeDataplaneClient(
    logger,
    handlers,
    dependencies,
    Deferred.makeUnsafe<never, DataplaneFatalError>(),
    () => {},
  );
}

function makeDataplaneClient(
  logger: Logger,
  handlers: DataplaneHandlers,
  dependencies: DataplaneClientDependencies,
  criticalFailure: Deferred.Deferred<never, DataplaneFatalError>,
  recordHealthState: (state: DataplaneHealthState) => void,
): DataplaneClient {
  // ChildProcess and stream callbacks are serialized by the JavaScript event
  // loop. Keep their generation, writer, and reap bookkeeping synchronous so
  // each callback can update those coupled invariants atomically. The scoped
  // constructor below owns all non-hot scheduling as Effect fibers and moves
  // acknowledgements, health, metrics, and terminal failures through Effect
  // Deferred/Queue primitives; wrapping this callback-local state in Ref would
  // require running an Effect between coupled mutations without adding
  // concurrency safety.
  let sidecar: DataplaneSidecarProcess | null = null;
  let activeSidecarGeneration = 0;
  // Generation whose readiness has already been published, so the first signal
  // wins and a later one cannot re-arm the stable-uptime timer.
  let readySignalledGeneration = 0;
  let nextSidecarGeneration = 1;
  let activeFrameReader: SidecarFrameReader | null = null;
  let activeCommandWriter: SidecarCommandWriter | null = null;
  let activeSidecarCloseSignal: SidecarCloseSignal | null = null;
  const unreapedSidecars = new Set<SidecarCloseSignal>();
  let restartTermination: SidecarRestartTermination | null = null;
  let fatalFailure: DataplaneFatalError | null = null;
  let stopped = false;
  let reconnectHandle: DataplaneTimerHandle | null = null;
  let stableUptimeHandle: DataplaneTimerHandle | null = null;
  let readinessWatchdogHandle: DataplaneTimerHandle | null = null;
  let reconnectScheduleGeneration = 0;
  let stableUptimeScheduleGeneration = 0;
  let readinessWatchdogGeneration = 0;
  let reconnectDelay = RECONNECT_DELAY_MS;
  let consecutiveAmbiguousExits = 0;
  let lastConfig: DataplaneConfig | null = null;
  let lastRevocationGeneration: number | null = null;
  let lastStunCredential: DataplaneStunCredential | null = null;
  /**
   * Monotonic instant the held credential arrived, so a replay after a sidecar
   * restart can hand over what is *left* of its lifetime rather than restarting
   * the clock on an already-spent ticket.
   */
  let lastStunCredentialAtMs = 0;
  let lastEdgeAdmission: DataplaneEdgeAdmission | null = null;
  const pendingCommands = new Map<string, PendingDataplaneCommand>();
  const scheduleReconnectTimer = dependencies.scheduleReconnect ?? scheduleTimeout;
  const scheduleGeneralTimer = dependencies.scheduleTimer ?? scheduleTimeout;
  const stableUptimeMs = dependencies.stableUptimeMs ?? SIDECAR_STABLE_UPTIME_MS;
  const configuredCommandDrainTimeoutMs =
    dependencies.commandDrainTimeoutMs ?? SIDECAR_COMMAND_DRAIN_TIMEOUT_MS;
  const commandDrainTimeoutMs =
    Number.isFinite(configuredCommandDrainTimeoutMs) && configuredCommandDrainTimeoutMs >= 0
      ? configuredCommandDrainTimeoutMs
      : SIDECAR_COMMAND_DRAIN_TIMEOUT_MS;
  const configuredCommandAckTimeoutMs =
    dependencies.commandAckTimeoutMs ?? SIDECAR_COMMAND_ACK_TIMEOUT_MS;
  const commandAckTimeoutMs =
    Number.isFinite(configuredCommandAckTimeoutMs) && configuredCommandAckTimeoutMs >= 0
      ? configuredCommandAckTimeoutMs
      : SIDECAR_COMMAND_ACK_TIMEOUT_MS;
  const configuredShutdownGracePeriodMs =
    dependencies.shutdownGracePeriodMs ?? SIDECAR_SHUTDOWN_GRACE_PERIOD_MS;
  const shutdownGracePeriodMs =
    Number.isFinite(configuredShutdownGracePeriodMs) && configuredShutdownGracePeriodMs >= 0
      ? configuredShutdownGracePeriodMs
      : SIDECAR_SHUTDOWN_GRACE_PERIOD_MS;
  const configuredShutdownReapTimeoutMs =
    dependencies.shutdownReapTimeoutMs ?? SIDECAR_SHUTDOWN_REAP_TIMEOUT_MS;
  const shutdownReapTimeoutMs =
    Number.isFinite(configuredShutdownReapTimeoutMs) && configuredShutdownReapTimeoutMs >= 0
      ? configuredShutdownReapTimeoutMs
      : SIDECAR_SHUTDOWN_REAP_TIMEOUT_MS;
  const configuredReadinessTimeoutMs =
    dependencies.readinessTimeoutMs ?? SIDECAR_READINESS_TIMEOUT_MS;
  const readinessTimeoutMs =
    Number.isFinite(configuredReadinessTimeoutMs) && configuredReadinessTimeoutMs >= 0
      ? configuredReadinessTimeoutMs
      : SIDECAR_READINESS_TIMEOUT_MS;
  const configuredMaxConsecutiveCrashes =
    dependencies.maxConsecutiveCrashes ?? MAX_CONSECUTIVE_AMBIGUOUS_EXITS;
  const maxConsecutiveCrashes =
    Number.isSafeInteger(configuredMaxConsecutiveCrashes) && configuredMaxConsecutiveCrashes > 0
      ? configuredMaxConsecutiveCrashes
      : MAX_CONSECUTIVE_AMBIGUOUS_EXITS;
  const recordMetricCallback = dependencies.recordMetric ?? (() => {});
  const recordMetric = (event: DataplaneMetricEvent): void => {
    try {
      recordMetricCallback(event);
    } catch {
      // Metrics must never escape a ChildProcess/stream callback boundary.
      // The scoped Effect workers own defect publication for the live service.
    }
  };

  return {
    start(): void {
      if (fatalFailure !== null) {
        logger.error('dataplane_start_after_terminal_failure', {
          reason: fatalFailure.reason,
        });
        return;
      }
      if (restartTermination !== null || unreapedSidecars.size > 0) {
        logger.warn('dataplane_start_waiting_for_prior_reap', {
          unreaped: unreapedSidecars.size,
        });
        return;
      }
      if (sidecar !== null) {
        return;
      }
      if (lastConfig === null) {
        logger.error('dataplane_start_before_configure');
        return;
      }
      stopped = false;
      reconnectDelay = RECONNECT_DELAY_MS;
      // A manual start is an immediate retry. Cancel a prior missing-binary /
      // spawn-failure timer first so it cannot later overwrite this child.
      clearReconnectTimer();
      spawnSidecar();
    },

    stop(): void {
      stopped = true;
      clearReconnectTimer();
      clearStableUptimeTimer();
      clearReadinessWatchdog();
      rejectAllPendingCommands('dataplane_unavailable');
      shutdownSidecar();
    },

    shutdown(): Effect.Effect<void> {
      return gracefulShutdownSidecar();
    },

    awaitCriticalFailure(): Effect.Effect<never, DataplaneFatalError> {
      return Deferred.await(criticalFailure);
    },

    configure(config): void {
      lastConfig = { ...config };
      // The wire configuration contains the daemon identity seed. It must
      // never be attached to diagnostics; the command writer logs metadata
      // (kind/size/generation) only.
      writeJsonCommand(CMD_CONFIGURE, toDataplaneWireConfig(lastConfig), 'configure');
    },

    startSessionEffect(
      commandId: string,
      sessionId: string,
      browserNodeId: string,
      userId: string,
      delegationId: string,
      clientNonce: string,
      encapsulationKey: string,
      edgeWtUrl: string,
      edgeCertHashes: readonly string[],
    ): Effect.Effect<DataplaneCommandResult> {
      return requestAcknowledgedCommandEffect(commandId, CMD_START_SESSION, {
        command_id: commandId,
        user_id: userId,
        delegation_id: delegationId,
        session_id: sessionId,
        browser_node_id: browserNodeId,
        client_nonce: clientNonce,
        encapsulation_key: encapsulationKey,
        edge_wt_url: edgeWtUrl,
        edge_cert_hashes: edgeCertHashes,
      });
    },

    cancelSessionEffect(
      commandId: string,
      sessionId: string,
      browserNodeId: string,
    ): Effect.Effect<DataplaneCommandResult> {
      return requestAcknowledgedCommandEffect(commandId, CMD_CANCEL_SESSION, {
        command_id: commandId,
        session_id: sessionId,
        browser_node_id: browserNodeId,
      });
    },

    revokeDelegationEffect(
      commandId: string,
      actorCertificate: UserDelegationCertificate,
      revocation: DelegationRevocationStatement,
    ): Effect.Effect<DataplaneCommandResult> {
      return requestAcknowledgedCommandEffect(commandId, CMD_REVOKE_DELEGATION, {
        command_id: commandId,
        actor_certificate: actorCertificate,
        revocation,
      });
    },

    captureTransportStatsEffect(commandId: string): Effect.Effect<DataplaneCommandResult> {
      return requestAcknowledgedCommandEffect(commandId, CMD_CAPTURE_TRANSPORT_STATS, {
        command_id: commandId,
      });
    },

    capturePerfTraceEffect(commandId, onChunk): Effect.Effect<DataplaneCommandResult> {
      return requestAcknowledgedCommandEffect(
        commandId,
        CMD_CAPTURE_PERF_TRACE,
        {
          command_id: commandId,
        },
        onChunk,
      );
    },

    signDaemonProofEffect(commandId, purpose, transcript) {
      return Effect.gen(function* () {
        const proof: { value: DataplaneProof | null } = { value: null };
        if (transcript.byteLength === 0 || transcript.byteLength > 16 * 1024)
          return { status: 'rejected' as const, reason: 'invalid_command' };
        const result = yield* requestAcknowledgedCommandEffect(
          commandId,
          CMD_SIGN_DAEMON_PROOF,
          {
            command_id: commandId,
            purpose,
            transcript: Buffer.from(transcript).toString('base64url'),
          },
          undefined,
          (value) => {
            proof.value = value;
          },
        );
        if (result.status === 'rejected') return result;
        return proof.value === null
          ? { status: 'rejected' as const, reason: 'incomplete_daemon_proof' }
          : { status: 'accepted' as const, ...proof.value };
      });
    },

    updateRevocation(generation: number): void {
      const normalizedGeneration = generation >>> 0;
      lastRevocationGeneration = normalizedGeneration;
      const payload = new Uint8Array(4);
      new DataView(payload.buffer).setUint32(0, normalizedGeneration, false);
      writeBinaryCommand(CMD_UPDATE_REVOCATION, payload, 'revocation');
    },

    updateStunCredential(credential: DataplaneStunCredential): void {
      // Every credential is forwarded. A replacement ticket rides each control
      // lease — once per renewal, not per liveness beat — so the sidecar parses
      // one command and rebuilds one HMAC key every twenty seconds, and the
      // server's renewal cadence alone decides how much lifetime is in hand.
      lastStunCredential = credential;
      lastStunCredentialAtMs = performance.now();
      writeJsonCommand(CMD_UPDATE_STUN, credential, 'stun');
    },

    updateEdgeAdmission(admission: DataplaneEdgeAdmission): void {
      lastEdgeAdmission = admission;
      writeJsonCommand(
        CMD_UPDATE_EDGE_ADMISSION,
        edgeAdmissionCommand(admission),
        'edge_admission',
      );
    },
  };

  function requestAcknowledgedCommandEffect(
    commandId: string,
    kind:
      | typeof CMD_START_SESSION
      | typeof CMD_CANCEL_SESSION
      | typeof CMD_REVOKE_DELEGATION
      | typeof CMD_CAPTURE_TRANSPORT_STATS
      | typeof CMD_CAPTURE_PERF_TRACE
      | typeof CMD_SIGN_DAEMON_PROOF,
    payload: object,
    onPerfTraceChunk?: (chunk: NativePerfTraceChunk) => void,
    onDaemonProof?: (proof: DataplaneProof) => void,
  ): Effect.Effect<DataplaneCommandResult> {
    return Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        if (pendingCommands.has(commandId)) {
          return rejectedDataplaneCommand('duplicate_command');
        }
        if (pendingCommands.size >= MAX_PENDING_DATAPLANE_COMMANDS) {
          return rejectedDataplaneCommand('dataplane_backpressure');
        }

        const deferred = yield* Deferred.make<DataplaneCommandResult>();
        const pending: PendingDataplaneCommand = {
          daemonProof:
            onDaemonProof === undefined ? null : { onProof: onDaemonProof, received: false },
          deferred,
          perfTrace:
            onPerfTraceChunk === undefined
              ? null
              : {
                  validator: createNativePerfTraceValidator(commandId),
                  onChunk: onPerfTraceChunk,
                },
          timer: null,
        };
        pendingCommands.set(commandId, pending);

        try {
          const timer = scheduleGeneralTimer(commandAckTimeoutMs, () => {
            if (pendingCommands.get(commandId) !== pending) return;
            pending.timer = null;
            recordMetric({ type: 'ack_timeout' });
            settlePendingCommand(commandId, {
              status: 'rejected',
              reason: 'dataplane_ack_timeout',
            });
          });
          if (pendingCommands.get(commandId) === pending) {
            pending.timer = timer;
          } else {
            timer.cancel();
          }
        } catch (error) {
          logger.error('dataplane_command_ack_watchdog_failed', {
            kind,
            error: String(error),
          });
          settlePendingCommand(commandId, {
            status: 'rejected',
            reason: 'dataplane_unavailable',
          });
          publishFatalFailure('internal_defect', error);
          return yield* Deferred.await(deferred);
        }

        if (pendingCommands.get(commandId) === pending) {
          const admission = writeJsonCommand(kind, payload, null, false);
          if (admission !== 'accepted') {
            settlePendingCommand(commandId, {
              status: 'rejected',
              reason:
                admission === 'backpressure'
                  ? 'dataplane_backpressure'
                  : admission === 'invalid'
                    ? 'invalid_command'
                    : 'dataplane_unavailable',
            });
          }
        }

        return yield* restore(Deferred.await(deferred)).pipe(
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              if (pendingCommands.get(commandId) !== pending) return;
              pendingCommands.delete(commandId);
              pending.timer?.cancel();
              pending.timer = null;
            }),
          ),
        );
      }),
    );
  }

  function writeJsonCommand(
    kind: number,
    payload: object,
    coalesceKey: SidecarCommandCoalesceKey | null = null,
    overflowIsFatal = true,
  ): SidecarCommandAdmission {
    const activeChild = sidecar;
    const generation = activeSidecarGeneration;
    if (!isSidecarInputWritable(activeChild)) {
      if (activeChild !== null && sidecar === activeChild) {
        handleUnexpectedSidecarExit(activeChild, 'stdin_unwritable');
      }
      return 'unavailable';
    }
    try {
      return enqueueSidecarCommand(
        activeChild,
        generation,
        kind,
        encodeSidecarCommand(kind, payload),
        coalesceKey,
        overflowIsFatal,
      );
    } catch (error) {
      handleCommandEncodingError(activeChild, generation, kind, error);
      return 'invalid';
    }
  }

  function writeBinaryCommand(
    kind: number,
    payload: Uint8Array,
    coalesceKey: SidecarCommandCoalesceKey | null = null,
  ): void {
    const activeChild = sidecar;
    const generation = activeSidecarGeneration;
    if (!isSidecarInputWritable(activeChild)) {
      if (activeChild !== null && sidecar === activeChild) {
        handleUnexpectedSidecarExit(activeChild, 'stdin_unwritable');
      }
      return;
    }
    try {
      enqueueSidecarCommand(
        activeChild,
        generation,
        kind,
        createSidecarFrame(kind, payload),
        coalesceKey,
        true,
      );
    } catch (error) {
      handleCommandEncodingError(activeChild, generation, kind, error);
    }
  }

  function handleCommandEncodingError(
    activeChild: DataplaneSidecarProcess,
    generation: number,
    kind: number,
    error: unknown,
  ): void {
    logger.error('dataplane_command_write_failed', { kind, error: String(error) });
    // Encoding failures happen before bytes reach Rust. Restarting cannot make
    // an invalid schema or oversized frame valid and would only create a crash
    // loop, so surface the defect to the daemon supervisor.
    if (sidecar === activeChild && activeSidecarGeneration === generation) {
      publishFatalFailure(
        'command_schema_error',
        error instanceof SidecarPayloadTooLargeError ? error : normalizeError(error),
      );
    }
  }

  function enqueueSidecarCommand(
    activeChild: DataplaneSidecarProcess,
    generation: number,
    kind: number,
    frame: Uint8Array,
    coalesceKey: SidecarCommandCoalesceKey | null,
    overflowIsFatal: boolean,
  ): SidecarCommandAdmission {
    const writer = activeCommandWriter;
    if (
      writer === null ||
      writer.disposed ||
      writer.child !== activeChild ||
      writer.generation !== generation
    ) {
      if (sidecar === activeChild && activeSidecarGeneration === generation) {
        logger.error('dataplane_command_writer_unavailable', { kind, generation });
        handleUnexpectedSidecarExit(activeChild, 'command_writer_unavailable');
      }
      return 'unavailable';
    }

    const queuedEntries = commandWriterQueueSize(writer);
    const tailIndex = writer.queue.length - 1;
    const tail = tailIndex >= writer.queueStart ? writer.queue[tailIndex] : undefined;
    const canCoalesce =
      coalesceKey !== null &&
      tail?.coalesceKey === coalesceKey &&
      !(tailIndex === writer.queueStart && writer.headSubmitted);
    const nextEntries = canCoalesce ? queuedEntries : queuedEntries + 1;
    const nextBytes =
      writer.queuedBytes -
      (canCoalesce && tail !== undefined ? tail.frame.byteLength : 0) +
      frame.byteLength;
    const overflowLimit =
      nextEntries > MAX_DATAPLANE_COMMAND_QUEUE_ENTRIES
        ? 'entries'
        : nextBytes > MAX_DATAPLANE_COMMAND_QUEUE_BYTES
          ? 'bytes'
          : null;

    if (overflowLimit !== null) {
      logger.warn('dataplane_command_queue_overflow', {
        kind,
        generation,
        limit: overflowLimit,
        queuedEntries,
        queuedBytes: writer.queuedBytes,
        frameBytes: frame.byteLength,
      });
      if (overflowIsFatal) {
        handleUnexpectedSidecarExit(activeChild, 'command_queue_overflow');
      }
      return 'backpressure';
    }

    const command: QueuedSidecarCommand = { kind, frame, coalesceKey };
    if (canCoalesce) {
      writer.queue[tailIndex] = command;
    } else {
      writer.queue.push(command);
    }
    writer.queuedBytes = nextBytes;
    flushCommandWriter(writer);
    return isActiveCommandWriter(writer) ? 'accepted' : 'unavailable';
  }

  function flushCommandWriter(writer: SidecarCommandWriter): void {
    if (writer.flushing || writer.blocked || !isActiveCommandWriter(writer)) return;
    writer.flushing = true;
    try {
      while (!writer.blocked && commandWriterQueueSize(writer) > 0) {
        if (!isActiveCommandWriter(writer)) return;
        if (!isSidecarInputWritable(writer.child)) {
          handleUnexpectedSidecarExit(writer.child, 'stdin_unwritable');
          return;
        }

        const command = writer.queue[writer.queueStart];
        if (command === undefined) {
          logger.error('dataplane_command_queue_corrupt', {
            generation: writer.generation,
            queueStart: writer.queueStart,
            queueLength: writer.queue.length,
          });
          publishFatalFailure(
            'internal_defect',
            new Error(`dataplane command queue corrupt in generation ${writer.generation}`),
          );
          return;
        }

        let acceptedWithoutBackpressure: boolean;
        try {
          acceptedWithoutBackpressure = writer.stdin.write(command.frame);
        } catch (error) {
          logger.error('dataplane_command_write_failed', {
            kind: command.kind,
            error: String(error),
          });
          if (isActiveCommandWriter(writer)) {
            handleUnexpectedSidecarExit(writer.child, 'command_write_failed');
          }
          return;
        }
        if (!isActiveCommandWriter(writer)) return;

        if (!acceptedWithoutBackpressure) {
          // Writable accepted the complete frame, but owns its bytes until
          // `drain`. Retain the submitted head in our accounting and do not
          // submit any later frame before that boundary. A one-shot watchdog
          // turns a permanently missing drain into a supervised sidecar
          // failure instead of wedging every later control command forever.
          writer.headSubmitted = true;
          writer.blocked = true;
          armCommandWriterDrainTimeout(writer);
          return;
        }
        removeCommandWriterHead(writer);
      }
    } finally {
      writer.flushing = false;
    }
  }

  function handleCommandWriterDrain(writer: SidecarCommandWriter): void {
    if (!isActiveCommandWriter(writer) || !writer.blocked || !writer.headSubmitted) return;
    clearCommandWriterDrainTimeout(writer);
    if (!isSidecarInputWritable(writer.child)) {
      handleUnexpectedSidecarExit(writer.child, 'stdin_unwritable');
      return;
    }
    writer.blocked = false;
    writer.headSubmitted = false;
    removeCommandWriterHead(writer);
    flushCommandWriter(writer);
  }

  function createCommandWriter(
    child: DataplaneSidecarProcess,
    generation: number,
  ): SidecarCommandWriter {
    const writer: SidecarCommandWriter = {
      child,
      generation,
      stdin: child.stdin,
      queue: [],
      onDrain(): void {
        handleCommandWriterDrain(writer);
      },
      queueStart: 0,
      queuedBytes: 0,
      headSubmitted: false,
      blocked: false,
      flushing: false,
      disposed: false,
      drainTimeoutHandle: null,
    };
    writer.stdin.on('drain', writer.onDrain);
    return writer;
  }

  function armCommandWriterDrainTimeout(writer: SidecarCommandWriter): void {
    clearCommandWriterDrainTimeout(writer);
    if (!isActiveCommandWriter(writer) || !writer.blocked || !writer.headSubmitted) return;

    const publication = createDataplaneTimerPublication();
    writer.drainTimeoutHandle = publication.handle;
    try {
      publication.install(scheduleGeneralTimer, commandDrainTimeoutMs, () => {
        if (
          !isActiveCommandWriter(writer) ||
          writer.drainTimeoutHandle !== publication.handle ||
          !writer.blocked ||
          !writer.headSubmitted
        ) {
          return;
        }
        writer.drainTimeoutHandle = null;
        publication.handle.cancel();
        logger.error('dataplane_command_drain_timeout', {
          generation: writer.generation,
          queuedEntries: commandWriterQueueSize(writer),
          queuedBytes: writer.queuedBytes,
        });
        handleUnexpectedSidecarExit(writer.child, 'command_drain_timeout');
      });
    } catch (error) {
      if (writer.drainTimeoutHandle === publication.handle) {
        writer.drainTimeoutHandle = null;
      }
      publication.handle.cancel();
      logger.error('dataplane_command_drain_watchdog_failed', {
        generation: writer.generation,
        error: String(error),
      });
      if (isActiveCommandWriter(writer)) {
        publishFatalFailure('internal_defect', error);
      }
    }
    if (writer.drainTimeoutHandle !== publication.handle) {
      publication.handle.cancel();
    }
  }

  function clearCommandWriterDrainTimeout(writer: SidecarCommandWriter): void {
    const handle = writer.drainTimeoutHandle;
    writer.drainTimeoutHandle = null;
    handle?.cancel();
  }

  function disposeCommandWriter(expectedChild: DataplaneSidecarProcess): void {
    const writer = activeCommandWriter;
    if (writer === null || writer.child !== expectedChild) return;
    activeCommandWriter = null;
    writer.disposed = true;
    writer.stdin.off('drain', writer.onDrain);
    clearCommandWriterDrainTimeout(writer);
    writer.queue.length = 0;
    writer.queueStart = 0;
    writer.queuedBytes = 0;
    writer.headSubmitted = false;
    writer.blocked = false;
  }

  function isActiveCommandWriter(writer: SidecarCommandWriter): boolean {
    return (
      !writer.disposed &&
      activeCommandWriter === writer &&
      sidecar === writer.child &&
      activeSidecarGeneration === writer.generation
    );
  }

  function commandWriterQueueSize(writer: SidecarCommandWriter): number {
    return writer.queue.length - writer.queueStart;
  }

  function removeCommandWriterHead(writer: SidecarCommandWriter): void {
    const command = writer.queue[writer.queueStart];
    if (command === undefined) return;
    writer.queueStart += 1;
    writer.queuedBytes = Math.max(0, writer.queuedBytes - command.frame.byteLength);
    writer.headSubmitted = false;
    if (writer.queueStart >= writer.queue.length) {
      writer.queue.length = 0;
      writer.queueStart = 0;
      return;
    }
    if (writer.queueStart >= 32 && writer.queueStart * 2 >= writer.queue.length) {
      writer.queue.copyWithin(0, writer.queueStart);
      writer.queue.length -= writer.queueStart;
      writer.queueStart = 0;
    }
  }

  function spawnSidecar(): void {
    if (stopped || sidecar !== null || restartTermination !== null || unreapedSidecars.size > 0) {
      return;
    }
    const config = lastConfig;
    if (config === null) {
      logger.error('dataplane_start_before_configure');
      return;
    }

    let binaryPath: string | null;
    try {
      binaryPath = dependencies.resolveBinaryPath();
    } catch (error) {
      logger.error('dataplane_binary_resolution_failed', { error: String(error) });
      handleSpawnFailure(error);
      return;
    }
    if (binaryPath === null) {
      logger.error('dataplane_binary_not_found');
      publishFatalFailure('binary_not_found');
      return;
    }

    const generation = nextSidecarGeneration;
    nextSidecarGeneration++;
    const frameReader = new SidecarFrameReader();
    let child: DataplaneSidecarProcess;
    try {
      child = dependencies.spawnSidecar(
        binaryPath,
        frameReader,
        (kind, payload) => {
          if (activeSidecarGeneration !== generation) return;
          handleFrame(kind, payload);
        },
        {
          args: [
            '--shell',
            config.shell,
            '--wt-port',
            String(config.webtransport_port),
            ...(config.shell_token_path === null
              ? []
              : ['--shell-token-path', config.shell_token_path]),
            ...(config.open_url_bin_dir === null
              ? []
              : ['--open-url-bin-dir', config.open_url_bin_dir]),
            ...(config.public_wt_endpoint === null
              ? []
              : ['--public-wt-endpoint', config.public_wt_endpoint]),
          ],
          defaultRustLog: DEFAULT_DATAPLANE_RUST_LOG,
          stderrEvent: 'dataplane_stderr',
          logInfo: (eventName, metadata) => logger.info(eventName, metadata),
          onFrameError(error): void {
            logger.error('dataplane_frame_error', { error: String(error) });
            const activeChild = sidecar;
            if (activeChild !== null && activeSidecarGeneration === generation) {
              publishFatalFailure('protocol_error', error);
            }
          },
        },
      );
    } catch (error) {
      logger.error('dataplane_spawn_error', { error: String(error) });
      handleSpawnFailure(error);
      return;
    }

    const closeSignal = createSidecarCloseSignal(child);
    unreapedSidecars.add(closeSignal);
    sidecar = child;
    activeSidecarGeneration = generation;
    activeFrameReader = frameReader;
    activeSidecarCloseSignal = closeSignal;

    try {
      child.on('close', (code, signal) => {
        handleSidecarClose(closeSignal, code, signal);
      });
      child.on('error', (error) => {
        if (sidecar !== child) return;
        logger.error('dataplane_spawn_error', { error: String(error) });
        handleSpawnFailure(error, child);
      });
      child.stdin.on('error', (error) => {
        if (sidecar !== child || activeSidecarGeneration !== generation) return;
        logger.error('dataplane_stdin_error', { error: String(error) });
        handleUnexpectedSidecarExit(child, 'stdin_error');
      });
      activeCommandWriter = createCommandWriter(child, generation);
      emitHealthState('starting');
      replaySidecarState();
      if (sidecar === child && activeSidecarGeneration === generation) {
        armReadinessWatchdog(child, generation);
      }
    } catch (error) {
      publishFatalFailure('internal_defect', error);
    }
  }

  function scheduleReconnect(): void {
    if (stopped || reconnectHandle !== null) {
      return;
    }

    const delayMs = reconnectDelay;
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_DELAY_MS);
    const scheduleGeneration = reconnectScheduleGeneration + 1;
    reconnectScheduleGeneration = scheduleGeneration;
    logger.info('dataplane_scheduling_reconnect', { delayMs });
    const publication = createDataplaneTimerPublication();
    reconnectHandle = publication.handle;
    try {
      publication.install(scheduleReconnectTimer, delayMs, () => {
        if (stopped || reconnectScheduleGeneration !== scheduleGeneration) return;
        reconnectScheduleGeneration += 1;
        if (reconnectHandle === publication.handle) {
          reconnectHandle = null;
        }
        spawnSidecar();
      });
    } catch (error) {
      if (reconnectHandle === publication.handle) {
        reconnectHandle = null;
      }
      publication.handle.cancel();
      publishFatalFailure('internal_defect', error);
    }
    if (reconnectHandle !== publication.handle) {
      publication.handle.cancel();
    }
  }

  function clearReconnectTimer(): void {
    reconnectScheduleGeneration += 1;
    const handle = reconnectHandle;
    reconnectHandle = null;
    if (handle !== null) {
      handle.cancel();
    }
  }

  function clearStableUptimeTimer(): void {
    stableUptimeScheduleGeneration += 1;
    const handle = stableUptimeHandle;
    stableUptimeHandle = null;
    if (handle !== null) {
      handle.cancel();
    }
  }

  function armReadinessWatchdog(child: DataplaneSidecarProcess, generation: number): void {
    clearReadinessWatchdog();
    const watchdogGeneration = readinessWatchdogGeneration + 1;
    readinessWatchdogGeneration = watchdogGeneration;
    const publication = createDataplaneTimerPublication();
    readinessWatchdogHandle = publication.handle;
    try {
      publication.install(scheduleGeneralTimer, readinessTimeoutMs, () => {
        if (
          stopped ||
          readinessWatchdogGeneration !== watchdogGeneration ||
          readinessWatchdogHandle !== publication.handle ||
          sidecar !== child ||
          activeSidecarGeneration !== generation
        ) {
          return;
        }
        readinessWatchdogHandle = null;
        publication.handle.cancel();
        logger.error('dataplane_readiness_timeout', {
          generation,
          timeoutMs: readinessTimeoutMs,
        });
        handleBudgetedSidecarFailure(child, 'readiness_timeout');
      });
    } catch (error) {
      if (readinessWatchdogHandle === publication.handle) {
        readinessWatchdogHandle = null;
      }
      publication.handle.cancel();
      publishFatalFailure('internal_defect', error);
    }
    if (readinessWatchdogHandle !== publication.handle) {
      publication.handle.cancel();
    }
  }

  /**
   * The sidecar reached operational state.
   *
   * Readiness used to be published only from `webtransport_ready`, which the
   * dataplane emits after direct-WebTransport NAT discovery (UPnP/NAT-PMP/PCP
   * plus STUN) resolves. That is the optional upgrade path: terminal traffic
   * runs over the blind edge relay, which needs none of it. On any network
   * where discovery is slow or simply has nowhere to go — containers, CGNAT,
   * firewalled or gateway-less hosts — the watchdog then reaped a dataplane
   * that had already authenticated peers and was serving a live terminal, and
   * did it again every 15 s. `pty_ready` is the honest signal: the shell is
   * spawned and the PTY is serving. A dataplane that never gets there still
   * never publishes readiness, so the watchdog keeps catching a real hang.
   */
  function markSidecarReady(): void {
    if (activeSidecarGeneration === 0 || readySignalledGeneration === activeSidecarGeneration) {
      return;
    }
    readySignalledGeneration = activeSidecarGeneration;
    clearReadinessWatchdog();
    armStableUptimeReset();
    recordMetric({ type: 'state', state: 'ready' });
    emitHealthState('ready');
  }

  function clearReadinessWatchdog(): void {
    readinessWatchdogGeneration += 1;
    const handle = readinessWatchdogHandle;
    readinessWatchdogHandle = null;
    handle?.cancel();
  }

  function shutdownSidecar(): void {
    const activeChild = sidecar;
    const writer = activeCommandWriter;
    if (
      isSidecarInputWritable(activeChild) &&
      writer !== null &&
      isActiveCommandWriter(writer) &&
      !writer.blocked &&
      commandWriterQueueSize(writer) === 0
    ) {
      try {
        // Do not append shutdown behind a write(false) boundary. Cleanup below
        // kills a backpressured child directly; an idle child gets one complete
        // best-effort shutdown frame.
        activeChild.stdin.write(createSidecarFrame(CMD_SHUTDOWN));
      } catch {
        // best-effort shutdown
      }
    }
    cleanupSidecar();
  }

  function gracefulShutdownSidecar(): Effect.Effect<void> {
    return Effect.uninterruptible(
      Effect.gen(function* () {
        stopped = true;
        clearReconnectTimer();
        clearStableUptimeTimer();
        clearReadinessWatchdog();
        const ordinaryTermination = restartTermination;
        if (ordinaryTermination !== null) {
          ordinaryTermination.timer?.cancel();
          ordinaryTermination.timer = null;
          restartTermination = null;
        }
        rejectAllPendingCommands('dataplane_unavailable');

        const activeChild = sidecar;
        const closeSignal =
          activeSidecarCloseSignal?.child === activeChild ? activeSidecarCloseSignal : null;

        if (activeChild !== null && closeSignal !== null) {
          const writer = activeCommandWriter;
          const commandLaneAvailable =
            isSidecarInputWritable(activeChild) &&
            writer !== null &&
            isActiveCommandWriter(writer) &&
            !writer.blocked &&
            commandWriterQueueSize(writer) === 0;

          if (commandLaneAvailable) {
            let shutdownWritten = false;
            try {
              activeChild.stdin.write(createSidecarFrame(CMD_SHUTDOWN));
              shutdownWritten = true;
            } catch {
              logger.warn('dataplane_shutdown_force_kill', {
                reason: 'shutdown_write_failed',
              });
            }

            if (shutdownWritten) {
              const closedGracefully = yield* awaitSidecarClose(closeSignal, shutdownGracePeriodMs);
              if (!closedGracefully) {
                logger.warn('dataplane_shutdown_force_kill', {
                  reason: 'grace_period_expired',
                  timeoutMs: shutdownGracePeriodMs,
                });
              }
            }
          } else {
            logger.warn('dataplane_shutdown_force_kill', {
              reason: 'command_lane_unavailable',
            });
          }
        }

        // A child can emit `error` while the graceful timer is running. That
        // event detaches the command lane but is not process termination. Only
        // the child's `close` event completes its Deferred, so every still
        // unreaped generation is force-killed and then observed here.
        const pendingReaps = Array.from(unreapedSidecars);
        if (pendingReaps.length === 0) {
          return;
        }

        yield* Effect.sync(() => {
          for (const pending of pendingReaps) {
            if (sidecar === pending.child) {
              cleanupSidecar(pending.child, true);
            } else {
              forceKillSidecar(pending.child);
            }
          }
        });

        const reaped = yield* awaitAllSidecarCloses(pendingReaps, shutdownReapTimeoutMs);
        if (!reaped) {
          logger.error('dataplane_shutdown_reap_timeout', {
            timeoutMs: shutdownReapTimeoutMs,
            remaining: pendingReaps.filter((pending) => unreapedSidecars.has(pending)).length,
          });
        }
      }),
    );
  }

  function handleSidecarClose(
    closeSignal: SidecarCloseSignal,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    const child = closeSignal.child;
    const termination = restartTermination?.closeSignal === closeSignal ? restartTermination : null;
    const wasActive = sidecar === child;

    unreapedSidecars.delete(closeSignal);
    if (termination !== null) {
      termination.timer?.cancel();
      termination.timer = null;
      restartTermination = null;
    }
    if (wasActive) {
      // Keep the Node callback's local teardown atomic, but publish observable
      // state only after the close Deferred has completed below.
      detachSidecarState(child, false);
    }
    destroySidecarStreams(child);
    // Complete before logging or invoking callbacks. An Effect shutdown waiter
    // must observe fully-cleaned state even if completion resumes synchronously.
    closeSignal.resolveFromClose();
    if (wasActive) {
      publishDataplaneDownState();
    }

    if (termination !== null) {
      logger.warn('dataplane_exited', { code, signal, reason: termination.reason });
      if (!stopped && fatalFailure === null) {
        // An earlier transient symptom (for example an IPC error) must not
        // hide the process's terminal exit status. SIGKILL is our bounded reap
        // policy, so only that signal remains classified by the initiating
        // transient reason.
        const terminalReason = signal === 'SIGKILL' ? null : classifyTerminalClose(code, signal);
        if (terminalReason !== null) {
          publishFatalFailure(terminalReason, sidecarCloseError(code, signal));
          return;
        }
        notifyUnexpectedSidecarExit(termination.reason);
        recordMetric({ type: 'restart', reason: termination.reason });
        scheduleReconnect();
      }
      return;
    }
    if (!wasActive) return;

    logger.warn('dataplane_exited', { code, signal });
    if (stopped || fatalFailure !== null) return;
    const terminalReason = classifyTerminalClose(code, signal);
    if (terminalReason !== null) {
      publishFatalFailure(terminalReason, sidecarCloseError(code, signal));
      return;
    }
    if (!consumeAmbiguousCrashBudget('process_closed', sidecarCloseError(code, signal))) {
      return;
    }
    notifyUnexpectedSidecarExit('process_closed');
    recordMetric({ type: 'restart', reason: 'process_closed' });
    scheduleReconnect();
  }

  function handleUnexpectedSidecarExit(child: DataplaneSidecarProcess, reason: string): void {
    if (sidecar !== child || stopped || fatalFailure !== null) return;
    beginRestartTermination(child, reason);
  }

  function handleBudgetedSidecarFailure(child: DataplaneSidecarProcess, reason: string): void {
    if (!consumeAmbiguousCrashBudget(reason, new Error(reason))) return;
    beginRestartTermination(child, reason);
  }

  function beginRestartTermination(child: DataplaneSidecarProcess, reason: string): void {
    if (sidecar !== child || restartTermination !== null || stopped || fatalFailure !== null) {
      return;
    }
    const closeSignal = activeSidecarCloseSignal?.child === child ? activeSidecarCloseSignal : null;
    if (closeSignal === null) {
      publishFatalFailure(
        'internal_defect',
        new Error('active dataplane child has no close signal'),
      );
      return;
    }

    clearReadinessWatchdog();
    clearStableUptimeTimer();
    const writer = activeCommandWriter;
    const canRequestGracefulShutdown =
      (reason === 'readiness_timeout' || reason === 'spawn_error') &&
      isSidecarInputWritable(child) &&
      writer !== null &&
      isActiveCommandWriter(writer) &&
      !writer.blocked &&
      commandWriterQueueSize(writer) === 0;
    const termination: SidecarRestartTermination = {
      closeSignal,
      reason,
      phase: canRequestGracefulShutdown ? 'grace' : 'reap',
      timer: null,
    };
    restartTermination = termination;
    detachSidecarState(child);

    if (canRequestGracefulShutdown) {
      try {
        child.stdin.write(createSidecarFrame(CMD_SHUTDOWN));
        if (restartTermination === termination) {
          armRestartTerminationGrace(termination);
        }
        return;
      } catch (error) {
        logger.warn('dataplane_restart_graceful_write_failed', {
          reason,
          error: String(error),
        });
      }
    }
    forceKillAndArmReap(termination);
  }

  function armRestartTerminationGrace(termination: SidecarRestartTermination): void {
    armRestartTerminationTimer(termination, shutdownGracePeriodMs, () => {
      if (restartTermination !== termination || termination.phase !== 'grace') return;
      logger.warn('dataplane_restart_force_kill', {
        reason: termination.reason,
        timeoutMs: shutdownGracePeriodMs,
      });
      forceKillAndArmReap(termination);
    });
  }

  function forceKillAndArmReap(termination: SidecarRestartTermination): void {
    if (restartTermination !== termination) return;
    termination.timer?.cancel();
    termination.timer = null;
    termination.phase = 'reap';
    destroySidecarStreams(termination.closeSignal.child);
    if (restartTermination !== termination) return;
    forceKillSidecar(termination.closeSignal.child);
    if (restartTermination !== termination) return;
    armRestartTerminationTimer(termination, shutdownReapTimeoutMs, () => {
      if (restartTermination !== termination || termination.phase !== 'reap') return;
      termination.timer = null;
      if (stopped) {
        logger.error('dataplane_restart_reap_timeout_during_stop', {
          timeoutMs: shutdownReapTimeoutMs,
        });
        return;
      }
      publishFatalFailure(
        'sidecar_reap_timeout',
        new Error(`dataplane child did not close within ${shutdownReapTimeoutMs}ms after SIGKILL`),
      );
    });
  }

  function armRestartTerminationTimer(
    termination: SidecarRestartTermination,
    delayMs: number,
    callback: () => void,
  ): void {
    if (restartTermination !== termination) return;
    const publication = createDataplaneTimerPublication();
    termination.timer = publication.handle;
    try {
      publication.install(scheduleGeneralTimer, delayMs, () => {
        if (restartTermination !== termination || termination.timer !== publication.handle) {
          return;
        }
        termination.timer = null;
        callback();
      });
    } catch (error) {
      if (termination.timer === publication.handle) {
        termination.timer = null;
      }
      publication.handle.cancel();
      forceKillSidecar(termination.closeSignal.child);
      publishFatalFailure('internal_defect', error);
    }
    if (termination.timer !== publication.handle) {
      publication.handle.cancel();
    }
  }

  function consumeAmbiguousCrashBudget(reason: string, cause: Error): boolean {
    consecutiveAmbiguousExits += 1;
    if (consecutiveAmbiguousExits < maxConsecutiveCrashes) {
      return true;
    }
    publishFatalFailure(
      'sidecar_crash_loop',
      new Error(
        `dataplane failed ${consecutiveAmbiguousExits} consecutive times (${reason}): ${cause.message}`,
      ),
    );
    return false;
  }

  function handleSpawnFailure(error: unknown, child?: DataplaneSidecarProcess): void {
    const classification = classifySpawnFailure(error);
    if (classification !== 'transient') {
      publishFatalFailure(classification, error);
      return;
    }
    if (child !== undefined) {
      handleUnexpectedSidecarExit(child, 'spawn_error');
      return;
    }
    notifyUnexpectedSidecarExit('spawn_error');
    if (!stopped) {
      recordMetric({ type: 'restart', reason: 'spawn_error' });
      scheduleReconnect();
    }
  }

  function publishFatalFailure(reason: DataplaneFatalReason, cause?: unknown): void {
    if (fatalFailure !== null) return;
    const failure = new DataplaneFatalError(
      cause === undefined ? { reason } : { reason, cause: normalizeError(cause) },
    );
    fatalFailure = failure;
    stopped = true;
    clearReconnectTimer();
    clearStableUptimeTimer();
    clearReadinessWatchdog();
    const terminating = restartTermination;
    if (terminating !== null) {
      terminating.timer?.cancel();
      terminating.timer = null;
      restartTermination = null;
      destroySidecarStreams(terminating.closeSignal.child);
      forceKillSidecar(terminating.closeSignal.child);
    }
    rejectAllPendingCommands('dataplane_unavailable');
    const activeChild = sidecar;
    if (activeChild !== null) {
      cleanupSidecar(activeChild);
    }
    emitHealthState('fatal');
    notifyUnexpectedSidecarExit(reason);
    Deferred.doneUnsafe(criticalFailure, Effect.fail(failure));
  }

  function emitHealthState(state: DataplaneHealthState): void {
    try {
      recordHealthState(state);
    } catch (error) {
      if (state === 'fatal' || fatalFailure !== null) {
        logger.error('dataplane_health_update_failed', {
          state,
          error: String(error),
        });
        return;
      }
      publishFatalFailure('internal_defect', error);
    }
  }

  function notifyUnexpectedSidecarExit(reason: string): void {
    try {
      handlers.onSidecarExited(reason);
    } catch (error) {
      logger.error('dataplane_exit_handler_failed', { error: String(error) });
    }
  }

  function cleanupSidecar(
    expectedChild: DataplaneSidecarProcess | null = sidecar,
    forceKill = false,
    processAlreadyClosed = false,
  ): void {
    if (expectedChild === null || sidecar !== expectedChild) {
      return;
    }
    detachSidecarState(expectedChild);
    destroySidecarStreams(expectedChild);
    if (!processAlreadyClosed) {
      if (forceKill) {
        forceKillSidecar(expectedChild);
      } else {
        try {
          expectedChild.kill();
        } catch {
          // best-effort cleanup
        }
      }
    }
  }

  function detachSidecarState(
    expectedChild: DataplaneSidecarProcess,
    publishDownState = true,
  ): void {
    if (sidecar !== expectedChild) return;
    disposeCommandWriter(expectedChild);
    sidecar = null;
    activeSidecarGeneration = 0;
    clearStableUptimeTimer();
    clearReadinessWatchdog();
    rejectAllPendingCommands('dataplane_unavailable');
    activeFrameReader?.clear();
    activeFrameReader = null;
    if (activeSidecarCloseSignal?.child === expectedChild) {
      activeSidecarCloseSignal = null;
    }
    if (publishDownState) {
      publishDataplaneDownState();
    }
  }

  function publishDataplaneDownState(): void {
    recordMetric({ type: 'state', state: 'down' });
    emitHealthState('down');
  }

  function destroySidecarStreams(child: DataplaneSidecarProcess): void {
    try {
      child.stdin.destroy();
    } catch {
      // best-effort cleanup
    }
    try {
      child.stdout.destroy();
    } catch {
      // best-effort cleanup
    }
    try {
      child.stderr.destroy();
    } catch {
      // best-effort cleanup
    }
  }

  function forceKillSidecar(child: DataplaneSidecarProcess): void {
    try {
      child.kill('SIGKILL');
    } catch {
      // Reaping still waits for `close`; a thrown kill cannot be treated as a
      // process exit.
    }
  }

  function replaySidecarState(): void {
    if (lastConfig !== null) {
      // Keep this frame out of logs: it contains sealed identity material (the seed for explicit software custody).
      writeJsonCommand(CMD_CONFIGURE, toDataplaneWireConfig(lastConfig), 'configure');
    }
    if (lastStunCredential !== null) {
      // Replayed like the configure payload: a replacement sidecar that came up
      // without a credential could not probe until the next lease, and the
      // startup probe is the one that matters.
      //
      // The lifetime is re-stated as what remains, not as what was issued. The
      // sidecar stamps the duration against its own clock on arrival, so
      // replaying the original figure would hand a ticket that is nearly spent
      // — or wholly spent — a full fresh validity and send the probe anyway. A
      // credential with nothing left is dropped instead; the next lease is at
      // most one renewal away and brings a real one.
      const remainingMs = Math.round(
        lastStunCredential.lifetime_ms - (performance.now() - lastStunCredentialAtMs),
      );
      if (remainingMs > 0) {
        writeJsonCommand(
          CMD_UPDATE_STUN,
          { ...lastStunCredential, lifetime_ms: remainingMs },
          'stun',
        );
      }
    }
    if (lastEdgeAdmission !== null) {
      // Replayed as held: a replacement sidecar needs a ticket before its first
      // edge dial, and whether this one is still inside its lifetime is the
      // edge's to decide. The edges it names are where the replacement states
      // its incarnation at once, so every session the crashed process held is
      // retired there instead of waiting out its tunnel's idle timeout. The
      // next lease replaces it either way.
      writeJsonCommand(
        CMD_UPDATE_EDGE_ADMISSION,
        edgeAdmissionCommand(lastEdgeAdmission),
        'edge_admission',
      );
    }
    if (lastRevocationGeneration !== null) {
      const payload = new Uint8Array(4);
      new DataView(payload.buffer).setUint32(0, lastRevocationGeneration, false);
      writeBinaryCommand(CMD_UPDATE_REVOCATION, payload, 'revocation');
    }
  }

  function handleFrame(kind: number, payload: Uint8Array): void {
    const json = payload.length > 0 ? parseJsonPayload(payload) : null;
    let valid = true;

    switch (kind) {
      case EVT_PTY_READY:
        valid = handlePtyReady(json);
        break;
      case EVT_PTY_CLOSED:
        valid = handlePtyClosed(json);
        break;
      case EVT_BELL:
        valid = payload.byteLength === 0;
        if (valid) handlers.onBell();
        break;
      case EVT_PEER_DISCONNECTED:
        valid = handlePeerDisconnected(json);
        break;
      case EVT_ERROR:
        valid = handleError(json);
        break;
      case EVT_NAT_MAPPING_OUTCOME:
        valid = handleNatMappingOutcome(json);
        break;
      case EVT_NETWORK_PATH_CHANGED:
        valid = handleNetworkPathChanged(json);
        break;
      case EVT_WEBTRANSPORT_READY:
        valid = handleWebTransportReady(json);
        break;
      case EVT_PEER_AUTHENTICATED:
        valid = handlePeerAuthenticated(json);
        break;
      case EVT_DAEMON_PROOF:
        valid = handleDaemonProof(json);
        break;
      case EVT_COMMAND_ACK:
        valid = handleCommandAck(json);
        break;
      case EVT_TRANSPORT_STATS:
        valid = handleTransportStats(json);
        break;
      case EVT_SESSION_REBIND:
        valid = handleSessionRebind(json);
        break;
      case EVT_PERF_TRACE:
        handlePerfTraceChunk(json);
        break;
      default:
        logger.error('dataplane_unknown_event', { kind });
        publishFatalFailure('protocol_error', new Error(`unknown dataplane event kind ${kind}`));
        return;
    }

    if (!valid) {
      logger.error('dataplane_invalid_event', { kind });
      const activeChild = sidecar;
      if (activeChild !== null) {
        publishFatalFailure(
          'invalid_event',
          new Error(`invalid dataplane event payload for kind ${kind}`),
        );
      }
    }
  }

  function armStableUptimeReset(): void {
    clearStableUptimeTimer();
    const readyGeneration = activeSidecarGeneration;
    const scheduleGeneration = stableUptimeScheduleGeneration + 1;
    stableUptimeScheduleGeneration = scheduleGeneration;
    const publication = createDataplaneTimerPublication();
    stableUptimeHandle = publication.handle;
    try {
      publication.install(scheduleGeneralTimer, stableUptimeMs, () => {
        if (stableUptimeScheduleGeneration !== scheduleGeneration) {
          return;
        }
        stableUptimeScheduleGeneration += 1;
        if (stableUptimeHandle === publication.handle) {
          stableUptimeHandle = null;
        }
        if (!stopped && sidecar !== null && activeSidecarGeneration === readyGeneration) {
          reconnectDelay = RECONNECT_DELAY_MS;
          consecutiveAmbiguousExits = 0;
        }
      });
    } catch (error) {
      if (stableUptimeHandle === publication.handle) {
        stableUptimeHandle = null;
      }
      publication.handle.cancel();
      publishFatalFailure('internal_defect', error);
    }
    if (stableUptimeHandle !== publication.handle) {
      publication.handle.cancel();
    }
  }

  function handlePtyReady(json: unknown): boolean {
    if (!hasExactKeys(json, ['pid']) || !isIntegerInRange(json.pid, 1, 0xffff_ffff)) {
      return false;
    }
    markSidecarReady();
    handlers.onPtyReady(json.pid);
    return true;
  }

  function handlePtyClosed(json: unknown): boolean {
    if (
      !hasExactKeys(json, ['exit_code', 'signal']) ||
      !isIntegerInRange(json.exit_code, -0x8000_0000, 0x7fff_ffff) ||
      !isIntegerInRange(json.signal, -0x8000_0000, 0x7fff_ffff)
    ) {
      return false;
    }
    handlers.onPtyClosed(json.exit_code, json.signal);
    return true;
  }

  function handleError(json: unknown): boolean {
    if (!hasExactKeys(json, ['message'])) return false;
    const message = readNonEmptyString(json.message);
    if (message === null) return false;
    handlers.onError(message);
    return true;
  }

  function handlePeerDisconnected(json: unknown): boolean {
    if (!hasExactKeys(json, ['peer_node_id', 'reason'])) return false;
    const peerNodeId = readNonEmptyString(json.peer_node_id);
    const reason = readNonEmptyString(json.reason);
    if (peerNodeId === null || reason === null) return false;
    handlers.onPeerDisconnected(peerNodeId, reason);
    return true;
  }

  function handleTransportStats(json: unknown): boolean {
    if (!hasExactKeys(json, TRANSPORT_STATS_KEYS)) return false;

    const webtransport = readPathStats(json.webtransport);
    const edge = readPathStats(json.edge);
    if (webtransport === null || edge === null) return false;

    // Read each scalar through the type predicate so the object literal below
    // needs no casts. Every field is an unsigned integer by construction on the
    // Rust side; a float or null here means the wire contract drifted, which is
    // a protocol error rather than something to coerce past.
    if (!isUnsignedInteger(json.window_ms)) return false;
    if (!isUnsignedInteger(json.peers)) return false;
    if (!isUnsignedInteger(json.parked_peers)) return false;
    if (!isUnsignedInteger(json.row_versions_sent)) return false;
    if (!isUnsignedInteger(json.row_versions_superseded_unapplied)) return false;
    if (!isUnsignedInteger(json.row_versions_superseded_applied)) return false;
    if (!isUnsignedInteger(json.row_resends_identical)) return false;
    if (!isUnsignedInteger(json.stale_prepared_flushes_sent)) return false;
    if (!isUnsignedInteger(json.bursts_abandoned)) return false;
    if (!isUnsignedInteger(json.bursts_unsafe_to_rewind)) return false;
    if (!isUnsignedInteger(json.datagram_send_failures)) return false;
    if (!isUnsignedInteger(json.fec_repairs_sent)) return false;
    if (!isUnsignedInteger(json.fec_repairs_refused)) return false;
    if (!isUnsignedInteger(json.resync_rows_requested)) return false;
    if (!isUnsignedInteger(json.rows_declared_lost)) return false;
    if (!isUnsignedInteger(json.unacked_datagrams_max)) return false;
    if (!isUnsignedInteger(json.edge_reliable_queued_bytes_max)) return false;
    if (!isUnsignedInteger(json.inbound_datagram_drops_wt)) return false;
    if (!isUnsignedInteger(json.inbound_datagram_drops_edge)) return false;
    if (!isUnsignedInteger(json.over_capacity_session_rejections)) return false;
    if (!isUnsignedInteger(json.direct_wt_incoming_expected)) return false;
    if (!isUnsignedInteger(json.direct_wt_incoming_unexpected)) return false;
    if (!isUnsignedInteger(json.direct_wt_admitted)) return false;
    if (!isUnsignedInteger(json.nat_keepalives_sent)) return false;
    if (!isUnsignedInteger(json.nat_punch_bursts_sent)) return false;
    if (!isUnsignedInteger(json.nat_punch_refused_not_global)) return false;
    if (!isUnsignedInteger(json.nat_punch_refused_rate_limited)) return false;
    if (!isUnsignedInteger(json.nat_side_channel_send_failed)) return false;
    if (!isUnsignedInteger(json.nat_side_channel_would_block)) return false;
    if (!isUnsignedInteger(json.stats_events_dropped)) return false;
    if (!isUnsignedInteger(json.rebind_requests)) return false;
    if (!isUnsignedInteger(json.rebind_accepted)) return false;
    if (!isUnsignedInteger(json.rebind_committed)) return false;
    if (!isUnsignedInteger(json.rebind_refused)) return false;
    if (!isUnsignedInteger(json.rebind_envelopes_rejected)) return false;
    if (!isUnsignedInteger(json.rebind_events_suppressed)) return false;

    // Routed through the existing bounded metric queue rather than a handler
    // callback: this is observational data with exactly one consumer (the daemon
    // metric snapshot), and the queue already isolates it from the synchronous
    // IPC frame path.
    recordMetric({
      type: 'transport_stats',
      stats: {
        windowMs: json.window_ms,
        peers: json.peers,
        parkedPeers: json.parked_peers,
        webtransport,
        edge,
        rowVersionsSent: json.row_versions_sent,
        rowVersionsSupersededUnapplied: json.row_versions_superseded_unapplied,
        rowVersionsSupersededApplied: json.row_versions_superseded_applied,
        rowResendsIdentical: json.row_resends_identical,
        stalePreparedFlushesSent: json.stale_prepared_flushes_sent,
        burstsAbandoned: json.bursts_abandoned,
        burstsUnsafeToRewind: json.bursts_unsafe_to_rewind,
        datagramSendFailures: json.datagram_send_failures,
        fecRepairsSent: json.fec_repairs_sent,
        fecRepairsRefused: json.fec_repairs_refused,
        resyncRowsRequested: json.resync_rows_requested,
        rowsDeclaredLost: json.rows_declared_lost,
        unackedDatagramsMax: json.unacked_datagrams_max,
        edgeReliableQueuedBytesMax: json.edge_reliable_queued_bytes_max,
        inboundDatagramDropsWt: json.inbound_datagram_drops_wt,
        inboundDatagramDropsEdge: json.inbound_datagram_drops_edge,
        overCapacitySessionRejections: json.over_capacity_session_rejections,
        directWtIncomingExpected: json.direct_wt_incoming_expected,
        directWtIncomingUnexpected: json.direct_wt_incoming_unexpected,
        directWtAdmitted: json.direct_wt_admitted,
        natKeepalivesSent: json.nat_keepalives_sent,
        natPunchBurstsSent: json.nat_punch_bursts_sent,
        natPunchRefusedNotGlobal: json.nat_punch_refused_not_global,
        natPunchRefusedRateLimited: json.nat_punch_refused_rate_limited,
        natSideChannelSendFailed: json.nat_side_channel_send_failed,
        natSideChannelWouldBlock: json.nat_side_channel_would_block,
        statsEventsDropped: json.stats_events_dropped,
        rebindRequests: json.rebind_requests,
        rebindAccepted: json.rebind_accepted,
        rebindCommitted: json.rebind_committed,
        rebindRefused: json.rebind_refused,
        rebindEnvelopesRejected: json.rebind_envelopes_rejected,
        rebindEventsSuppressed: json.rebind_events_suppressed,
      },
    });
    return true;
  }

  /**
   * Outcome of one port-mapping cycle.
   *
   * Validated against a closed set rather than accepted as free text, for two
   * reasons that point the same way: it becomes a `Metric.frequency` label, and
   * `docs/observability.md` forbids an unbounded dimension in a registry with
   * no eviction path; and a typo on the Rust side should fail loudly here
   * rather than silently create a new series nobody is watching.
   *
   * The `skipped:*` values are the point of the whole event. Their predecessor
   * reported three booleans, so "no gateway was ever addressed" and "the
   * gateway refused" were the same `false` — and thirty days of that ambiguity
   * was read as a verdict on the protocols rather than on the routing.
   */
  function handleNatMappingOutcome(json: unknown): boolean {
    if (!hasExactKeys(json, ['outcome'])) return false;
    const outcome = readNonEmptyString(json.outcome);
    if (outcome === null || !NAT_MAPPING_OUTCOMES.has(outcome)) return false;
    logger.info('dataplane_nat_mapping_outcome', { outcome });
    handlers.onNatMappingOutcome(outcome);
    return true;
  }

  /**
   * One carrier-rebind attempt outcome from the Rust dataplane.
   *
   * A refused rebind is silence on the wire by design, so this is the ONLY
   * place a refusal is observable at all — and 32 distinct refusal paths with
   * no outcome leaving the dataplane is what made a production reconnect
   * failure diagnosable only from the browser's side.
   *
   * `session_id` reaches the span and the log; only `outcome` is ever handed to
   * a metric. Effect's metric registry has no eviction path, so a per-session
   * label would leak a registry entry for the life of the daemon.
   */
  function handleSessionRebind(json: unknown): boolean {
    if (
      !hasExactKeys(json, [
        'session_id',
        'outcome',
        'generation',
        'attempt_ms',
        'events_suppressed',
      ])
    ) {
      return false;
    }
    const sessionId = readNonEmptyString(json.session_id);
    if (sessionId === null) return false;
    const outcome = readNonEmptyString(json.outcome);
    if (outcome === null || !REBIND_OUTCOMES.has(outcome)) return false;
    if (!isUnsignedInteger(json.generation)) return false;
    if (!isUnsignedInteger(json.attempt_ms)) return false;
    if (!isUnsignedInteger(json.events_suppressed)) return false;
    logger.info('dataplane_session_rebind', {
      outcome,
      sessionId,
      generation: json.generation,
      attemptMs: json.attempt_ms,
      eventsSuppressed: json.events_suppressed,
    });
    // Through the metric QUEUE, not a handler callback: the queue's worker
    // fiber runs under the provided layers and therefore has the tracer, while
    // `Effect.runFork` on the synchronous frame handler uses the default
    // runtime, where a span is created and never exported.
    recordMetric({
      type: 'session_rebind',
      outcome,
      sessionId,
      generation: json.generation,
      attemptMs: json.attempt_ms,
    });
    return true;
  }

  function handleNetworkPathChanged(json: unknown): boolean {
    if (!hasExactKeys(json, ['coalesced_events'])) return false;
    if (!isIntegerInRange(json.coalesced_events, 1, 0xffff_ffff)) return false;
    handlers.onNetworkPathChanged(json.coalesced_events);
    return true;
  }

  function handleWebTransportReady(json: unknown): boolean {
    if (!hasExactKeys(json, ['port', 'cert_hash', 'candidates', 'ipv6_reachability'])) {
      return false;
    }
    if (!isIntegerInRange(json.port, 1, 0xffff)) return false;
    const ipv6Reachability = readNonEmptyString(json.ipv6_reachability);
    if (ipv6Reachability === null) return false;
    const certHash = readNonEmptyString(json.cert_hash);
    if (certHash === null || !Array.isArray(json.candidates)) return false;
    const candidates: Array<{ addr: string; port: number; kind: string }> = [];
    for (const candidate of json.candidates) {
      if (!hasExactKeys(candidate, ['addr', 'port', 'kind'])) return false;
      const addr = readNonEmptyString(candidate.addr);
      if (
        addr === null ||
        !isIntegerInRange(candidate.port, 1, 0xffff) ||
        !isWebTransportCandidateKind(candidate.kind)
      ) {
        return false;
      }
      candidates.push({ addr, port: candidate.port, kind: candidate.kind });
    }
    markSidecarReady();
    // Logged AND forwarded. `host6` is one of only two candidate kinds that
    // have won a direct upgrade in production, and whether the rest are
    // firewall-filtered is the open question — it is what decides whether a v6
    // pinhole is worth building. It used to stop at this log line, which meant
    // answering that question required an SSH session per host; it is now also
    // a metric, so the fleet-wide ratio is one query.
    logger.info('dataplane_nat_reachability', { ipv6Reachability });
    handlers.onWebTransportReady(json.port, certHash, candidates, ipv6Reachability);
    return true;
  }

  function handlePeerAuthenticated(json: unknown): boolean {
    if (!hasExactKeys(json, ['peer_node_id', 'browser_node_id', 'session_id'])) return false;
    const peerNodeId = readNonEmptyString(json.peer_node_id);
    const browserNodeId = readNonEmptyString(json.browser_node_id);
    const sessionId = readNonEmptyString(json.session_id);
    if (peerNodeId === null || browserNodeId === null || sessionId === null) return false;
    handlers.onPeerAuthenticated(peerNodeId, browserNodeId, sessionId);
    return true;
  }

  function handlePerfTraceChunk(json: unknown): void {
    const commandId = isRecord(json) ? readNonEmptyString(json.command_id) : null;
    const pending = commandId === null ? undefined : pendingCommands.get(commandId);
    // Late/unsolicited diagnostics never affect terminal lifecycle or retain data.
    if (commandId === null || pending?.perfTrace == null) return;
    if (!isNativePerfTraceChunk(json) || !pending.perfTrace.validator.accept(json)) {
      settlePendingCommand(commandId, { status: 'rejected', reason: 'invalid_perf_trace' });
      return;
    }
    try {
      pending.perfTrace.onChunk(json);
    } catch {
      settlePendingCommand(commandId, { status: 'rejected', reason: 'perf_trace_consumer_failed' });
    }
  }

  function handleDaemonProof(json: unknown): boolean {
    if (!isRecord(json) || !hasExactKeys(json, ['command_id', 'signature', 'p256_signature']))
      return false;
    const commandId = readNonEmptyString(json.command_id);
    if (
      commandId === null ||
      !isCanonicalProofSignature(json.signature, 4627) ||
      !isCanonicalProofSignature(json.p256_signature, 64)
    )
      return false;
    const pending = pendingCommands.get(commandId);
    if (pending === undefined) return true;
    const proof = pending.daemonProof;
    if (proof === null || proof.received) return false;
    proof.received = true;
    proof.onProof({ signature: json.signature, p256Signature: json.p256_signature });
    return true;
  }

  function handleCommandAck(json: unknown): boolean {
    if (!isRecord(json)) return false;
    const commandId = readNonEmptyString(json.command_id);
    if (commandId === null) return false;

    if (json.status === 'accepted' && hasExactKeys(json, ['command_id', 'status'])) {
      const pending = pendingCommands.get(commandId);
      if (pending?.daemonProof != null && !pending.daemonProof.received) {
        settlePendingCommand(commandId, { status: 'rejected', reason: 'incomplete_daemon_proof' });
        return true;
      }
      const trace = pending?.perfTrace;
      settlePendingCommand(
        commandId,
        trace != null && !trace.validator.complete
          ? { status: 'rejected', reason: 'incomplete_perf_trace' }
          : { status: 'accepted' },
      );
      return true;
    }
    if (json.status === 'rejected' && hasExactKeys(json, ['command_id', 'status', 'reason'])) {
      const reason = readNonEmptyString(json.reason);
      if (reason === null || Buffer.byteLength(reason, 'utf8') > 64) return false;
      settlePendingCommand(commandId, { status: 'rejected', reason });
      return true;
    }
    return false;
  }

  function settlePendingCommand(commandId: string, result: DataplaneCommandResult): void {
    const pending = pendingCommands.get(commandId);
    if (pending === undefined) {
      logger.warn('dataplane_stale_command_ack', { commandId });
      return;
    }
    pendingCommands.delete(commandId);
    pending.timer?.cancel();
    pending.timer = null;
    Deferred.doneUnsafe(pending.deferred, Effect.succeed(result));
  }

  function rejectAllPendingCommands(reason: string): void {
    for (const [commandId, pending] of pendingCommands) {
      pendingCommands.delete(commandId);
      pending.timer?.cancel();
      pending.timer = null;
      Deferred.doneUnsafe(pending.deferred, Effect.succeed({ status: 'rejected', reason }));
    }
  }

  function parseJsonPayload(payload: Uint8Array): unknown {
    try {
      return JSON.parse(UTF8_DECODER.decode(payload));
    } catch {
      return null;
    }
  }
}

/**
 * Owns the sidecar for the enclosing Effect scope. Normal scope closure first
 * asks Rust to drain and shut down, then enforces the bounded force-kill
 * deadline implemented by `DataplaneClient.shutdown`.
 */
export function createDataplaneClientScoped(
  config: DataplaneConfig,
  logger: Logger,
  handlers: DataplaneHandlers,
  dependencies: Partial<DataplaneClientDependencies> = {},
): Effect.Effect<DataplaneClient, never, Scope.Scope> {
  return Effect.gen(function* () {
    const scopedDependencies: DataplaneClientDependencies = {
      ...defaultDataplaneClientDependencies,
      ...dependencies,
    };
    const scope = yield* Effect.scope;
    const runtimeContext = yield* Effect.context<never>();
    const scheduleInScope = createScopedEffectTimerScheduler(runtimeContext, scope);
    const criticalFailure = yield* Deferred.make<never, DataplaneFatalError>();
    const metricEvents = yield* Queue.dropping<DataplaneMetricEvent>(64);
    const stateEvents = yield* Queue.sliding<'ready' | 'down'>(1);
    const healthEvents = yield* Queue.sliding<DataplaneHealthState>(1);
    const recordMetricEffect = scopedDependencies.recordMetricEffect ?? recordDataplaneMetricEvent;
    const updateHealth = scopedDependencies.updateHealth ?? (() => Effect.void);

    const publishWorkerFailure = (
      worker: 'metric' | 'state' | 'health',
      cause: Cause.Cause<unknown>,
    ): void => {
      const failure = new DataplaneFatalError({
        reason: 'internal_defect',
        cause: new Error(`dataplane ${worker} worker failed: ${Cause.pretty(cause)}`),
      });
      Queue.offerUnsafe(healthEvents, 'fatal');
      Deferred.doneUnsafe(criticalFailure, Effect.fail(failure));
    };
    const superviseWorker = (
      worker: 'metric' | 'state' | 'health',
      effect: Effect.Effect<never>,
    ): Effect.Effect<void> =>
      Effect.catchCause(effect, (cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.sync(() => publishWorkerFailure(worker, cause)),
      );

    const metricWorker = Effect.gen(function* () {
      while (true) {
        yield* recordMetricEffect(yield* Queue.take(metricEvents));
      }
    });
    const stateWorker = Effect.gen(function* () {
      while (true) {
        yield* recordMetricEffect({
          type: 'state',
          state: yield* Queue.take(stateEvents),
        });
      }
    });
    const healthWorker = Effect.gen(function* () {
      while (true) {
        yield* updateHealth(yield* Queue.take(healthEvents));
      }
    });
    yield* superviseWorker('metric', metricWorker).pipe(
      Effect.forkScoped({ startImmediately: true }),
    );
    yield* superviseWorker('state', stateWorker).pipe(
      Effect.forkScoped({ startImmediately: true }),
    );
    yield* superviseWorker('health', healthWorker).pipe(
      Effect.forkScoped({ startImmediately: true }),
    );
    Queue.offerUnsafe(stateEvents, 'down');
    Queue.offerUnsafe(healthEvents, 'down');

    const client = yield* Effect.acquireRelease(
      Effect.sync(() => {
        return makeDataplaneClient(
          logger,
          handlers,
          {
            ...scopedDependencies,
            scheduleReconnect: scopedDependencies.scheduleReconnect ?? scheduleInScope,
            scheduleTimer: scopedDependencies.scheduleTimer ?? scheduleInScope,
            recordMetric(event): void {
              if (event.type === 'state') {
                Queue.offerUnsafe(stateEvents, event.state);
              } else {
                Queue.offerUnsafe(metricEvents, event);
              }
            },
          },
          criticalFailure,
          (state) => {
            Queue.offerUnsafe(healthEvents, state);
          },
        );
      }),
      (client) =>
        client.shutdown().pipe(
          Effect.ensuring(
            Effect.catchCause(recordMetricEffect({ type: 'state', state: 'down' }), (cause) =>
              Effect.sync(() =>
                logger.error('dataplane_final_metric_update_failed', {
                  cause: Cause.pretty(cause),
                }),
              ),
            ),
          ),
          Effect.ensuring(
            Effect.catchCause(updateHealth('down'), (cause) =>
              Effect.sync(() =>
                logger.error('dataplane_final_health_update_failed', {
                  cause: Cause.pretty(cause),
                }),
              ),
            ),
          ),
        ),
    );

    // The release is now installed before configuration/start callbacks run,
    // so any synchronous defect after spawning still owns bounded cleanup.
    yield* Effect.sync(() => {
      client.configure(config);
      client.start();
    });
    return client;
  });
}

export function createDataplaneClientLayer(
  config: DataplaneConfig,
  logger: Logger,
  handlers: DataplaneHandlers,
  dependencies: Partial<DataplaneClientDependencies> = {},
) {
  // Effect v4's `Layer.effect` builds the acquisition inside the layer scope
  // and removes `Scope` from its requirements.
  return Layer.effect(
    DataplaneClientService,
    createDataplaneClientScoped(config, logger, handlers, dependencies),
  );
}

function createScopedEffectTimerScheduler(
  context: Context.Context<never>,
  scope: Scope.Scope,
): (delayMs: number, callback: () => void) => DataplaneTimerHandle {
  const runSync = Effect.runSyncWith(context);
  return (delayMs, callback) => {
    let cancelled = false;
    // `yieldNow` guarantees the callback cannot run before the cancellable
    // handle is published, including zero-duration TestClock schedules.
    const timerFiber = runSync(
      Effect.yieldNow.pipe(
        Effect.andThen(Effect.sleep(Duration.millis(delayMs))),
        Effect.andThen(
          Effect.sync(() => {
            if (!cancelled) callback();
          }),
        ),
        Effect.forkIn(scope, { startImmediately: true }),
      ),
    );
    return {
      cancel(): void {
        if (cancelled) return;
        cancelled = true;
        timerFiber.interruptUnsafe();
      },
    };
  };
}

function createSidecarCloseSignal(child: DataplaneSidecarProcess): SidecarCloseSignal {
  const closed = Deferred.makeUnsafe<void>();
  return {
    child,
    closed,
    resolveFromClose(): void {
      Deferred.doneUnsafe(closed, Effect.void);
    },
  };
}

function awaitSidecarClose(signal: SidecarCloseSignal, timeoutMs: number): Effect.Effect<boolean> {
  return Effect.raceFirst(
    Deferred.await(signal.closed).pipe(Effect.as(true)),
    Effect.sleep(Duration.millis(timeoutMs)).pipe(Effect.as(false)),
  );
}

function awaitAllSidecarCloses(
  signals: readonly SidecarCloseSignal[],
  timeoutMs: number,
): Effect.Effect<boolean> {
  const awaitAll = Effect.all(
    signals.map((signal) => Deferred.await(signal.closed)),
    { concurrency: 'unbounded' },
  ).pipe(Effect.as(true));
  return Effect.raceFirst(
    awaitAll,
    Effect.sleep(Duration.millis(timeoutMs)).pipe(Effect.as(false)),
  );
}

function classifySpawnFailure(error: unknown): DataplaneFatalReason | 'transient' {
  const code = isRecord(error) && typeof error.code === 'string' ? error.code.toUpperCase() : null;
  switch (code) {
    case 'ENOENT':
      return 'binary_not_found';
    case 'EACCES':
    case 'EPERM':
      return 'binary_permission_denied';
    case 'ENOEXEC':
      return 'binary_not_executable';
    case 'EAGAIN':
    case 'EPIPE':
    case 'EMFILE':
    case 'ENFILE':
    case 'ENOMEM':
      return 'transient';
    default:
      return 'spawn_error';
  }
}

function classifyTerminalClose(
  code: number | null,
  signal: NodeJS.Signals | null,
): DataplaneFatalReason | null {
  if (
    signal === 'SIGABRT' ||
    signal === 'SIGBUS' ||
    signal === 'SIGFPE' ||
    signal === 'SIGILL' ||
    signal === 'SIGSEGV'
  ) {
    return 'sidecar_panic';
  }
  if (code === 3) return 'identity_unsealable';
  if (code === 101) {
    return 'sidecar_panic';
  }
  if (code !== null && code !== 0) {
    return 'sidecar_nonzero_exit';
  }
  return null;
}

function sidecarCloseError(code: number | null, signal: NodeJS.Signals | null): Error {
  return new Error(`dataplane exited with code=${String(code)} signal=${String(signal)}`);
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function rejectedDataplaneCommand(reason: string): DataplaneCommandResult {
  return { status: 'rejected', reason };
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function isIntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return (
    Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum
  );
}

/**
 * Every value in a transport-stats payload is a non-negative integer. Interval
 * deltas over ten seconds and process-lifetime drop counts are many orders of
 * magnitude below `Number.MAX_SAFE_INTEGER`, so a value outside this range means
 * the wire contract drifted rather than that a counter legitimately grew.
 */
function isUnsignedInteger(value: unknown): value is number {
  return isIntegerInRange(value, 0, Number.MAX_SAFE_INTEGER);
}

const TRANSPORT_STATS_PATH_KEYS = [
  'paths_available',
  'paths_live',
  'rtt_ewma_us_max',
  'network_rtt_ewma_us_max',
  'jitter_ewma_us_max',
  'send_failures_max',
  'last_ack_age_ms_max',
  'display_datagrams_received',
  'display_datagrams_recovered_by_fec',
  'display_datagrams_declared_lost',
  'display_datagrams_outcome_unknown',
  'quic_sent_packets',
  'quic_lost_packets',
  'quic_lost_bytes',
  'quic_congestion_events',
  'quic_black_holes',
  'quic_datagrams_tx',
  'quic_datagrams_rx',
  'quic_udp_tx_bytes',
  'quic_udp_rx_bytes',
  'quic_mtu_min',
  'quic_cwnd_bytes_min',
  'quic_rtt_us_max',
] as const;

/**
 * Every port-mapping outcome the dataplane can report, as a closed set.
 *
 * `<who>:<what>`. The `who` is the protocol that produced a lease (`pcp`,
 * `natpmp`, `upnp`) or an IPv6 pinhole (`pcp6`, `upnp6`), or `gateway` /
 * `gateway6` when one was addressed and refused, or `skipped` when no request
 * was sent at all. A mapping cycle emits two of these — one for the v4 lease,
 * one for the v6 pinhole — because they are independent leases on independent
 * paths. Sixteen values, which keeps this usable as a metric dimension under
 * the cardinality rule in `docs/observability.md`.
 *
 * Moves in lockstep with `portmap::METRIC_KEYS` in the Rust dataplane;
 * `packages/shared/src/ipc-wire-conformance.test.ts` asserts the two lists are
 * identical.
 */
const NAT_MAPPING_OUTCOMES = new Set([
  'pcp:mapped',
  'pcp:renewed',
  'natpmp:mapped',
  'natpmp:renewed',
  'upnp:mapped',
  'upnp:renewed',
  'gateway:unsupported',
  'gateway:inner_nat',
  'skipped:no_gateway',
  'skipped:no_egress_path',
  'skipped:no_reflexive',
  'pcp6:pinholed',
  'pcp6:renewed',
  'upnp6:pinholed',
  'upnp6:renewed',
  'gateway6:unsupported',
  'skipped:no_v6_path',
  'skipped:no_v6_gateway',
]);

/**
 * Every carrier-rebind outcome the dataplane can report, as a closed set.
 *
 * Moves in lockstep with `RebindRefusal::metric_key` and
 * `REBIND_LIFECYCLE_OUTCOMES` in `apps/daemon/dataplane/src/session/rebind_flow.rs`,
 * which has a test asserting this exact list. An outcome missing here is not a
 * dropped label — `handleSessionRebind` returns false, which the caller treats
 * as an invalid event payload and a fatal protocol error. Both sides move in
 * one commit.
 *
 * 34 values, all bounded and free of identity, which keeps this usable as a
 * metric dimension under the cardinality rule in `docs/observability.md`.
 */
const REBIND_OUTCOMES = new Set([
  // Lifecycle ends.
  'accepted',
  'accepted_held',
  'accepted_replay',
  'committed',
  'attempt_expired',
  'response_flushed',
  'envelope_rejected',
  // Refusals.
  'unknown_peer',
  'not_rebinding',
  'session_mismatch',
  'peer_mismatch',
  'stale_generation',
  'forged_generation',
  'bad_proof',
  'lineage_expired',
  'generation_budget_exhausted',
  'control_link_stale',
  // Crypto failures, named by stage. One variant used to absorb all fourteen.
  'crypto:identity',
  'crypto:request_transcript',
  'crypto:msg1_bind',
  'crypto:request_digest',
  'crypto:nonce',
  'crypto:encaps_randomness',
  'crypto:encapsulation',
  'crypto:response_transcript',
  'crypto:combiner',
  'crypto:prologue_digest',
  'crypto:responder_prepare',
  'crypto:hybrid_combiner',
  'crypto:psk_install',
  'crypto:answer_transcript',
  'crypto:response_mac',
]);

const TRANSPORT_STATS_KEYS = [
  'window_ms',
  'peers',
  'parked_peers',
  'webtransport',
  'edge',
  'row_versions_sent',
  'row_versions_superseded_unapplied',
  'row_versions_superseded_applied',
  'row_resends_identical',
  'stale_prepared_flushes_sent',
  'bursts_abandoned',
  'bursts_unsafe_to_rewind',
  'datagram_send_failures',
  'fec_repairs_sent',
  'fec_repairs_refused',
  'resync_rows_requested',
  'rows_declared_lost',
  'unacked_datagrams_max',
  'edge_reliable_queued_bytes_max',
  'inbound_datagram_drops_wt',
  'inbound_datagram_drops_edge',
  'over_capacity_session_rejections',
  'direct_wt_incoming_expected',
  'direct_wt_incoming_unexpected',
  'direct_wt_admitted',
  'nat_keepalives_sent',
  'nat_punch_bursts_sent',
  'nat_punch_refused_not_global',
  'nat_punch_refused_rate_limited',
  'nat_side_channel_send_failed',
  'nat_side_channel_would_block',
  'stats_events_dropped',
  'rebind_requests',
  'rebind_accepted',
  'rebind_committed',
  'rebind_refused',
  'rebind_envelopes_rejected',
  'rebind_events_suppressed',
] as const;

function readPathStats(value: unknown): DataplanePathStats | null {
  if (!hasExactKeys(value, TRANSPORT_STATS_PATH_KEYS)) return null;
  if (!isUnsignedInteger(value.paths_available)) return null;
  if (!isUnsignedInteger(value.paths_live)) return null;
  if (!isUnsignedInteger(value.rtt_ewma_us_max)) return null;
  if (!isUnsignedInteger(value.network_rtt_ewma_us_max)) return null;
  if (!isUnsignedInteger(value.jitter_ewma_us_max)) return null;
  if (!isUnsignedInteger(value.send_failures_max)) return null;
  if (!isUnsignedInteger(value.last_ack_age_ms_max)) return null;
  if (!isUnsignedInteger(value.display_datagrams_received)) return null;
  if (!isUnsignedInteger(value.display_datagrams_recovered_by_fec)) return null;
  if (!isUnsignedInteger(value.display_datagrams_declared_lost)) return null;
  if (!isUnsignedInteger(value.display_datagrams_outcome_unknown)) return null;
  if (!isUnsignedInteger(value.quic_sent_packets)) return null;
  if (!isUnsignedInteger(value.quic_lost_packets)) return null;
  if (!isUnsignedInteger(value.quic_lost_bytes)) return null;
  if (!isUnsignedInteger(value.quic_congestion_events)) return null;
  if (!isUnsignedInteger(value.quic_black_holes)) return null;
  if (!isUnsignedInteger(value.quic_datagrams_tx)) return null;
  if (!isUnsignedInteger(value.quic_datagrams_rx)) return null;
  if (!isUnsignedInteger(value.quic_udp_tx_bytes)) return null;
  if (!isUnsignedInteger(value.quic_udp_rx_bytes)) return null;
  if (!isUnsignedInteger(value.quic_mtu_min)) return null;
  if (!isUnsignedInteger(value.quic_cwnd_bytes_min)) return null;
  if (!isUnsignedInteger(value.quic_rtt_us_max)) return null;

  return {
    pathsAvailable: value.paths_available,
    pathsLive: value.paths_live,
    rttEwmaUsMax: value.rtt_ewma_us_max,
    networkRttEwmaUsMax: value.network_rtt_ewma_us_max,
    jitterEwmaUsMax: value.jitter_ewma_us_max,
    sendFailuresMax: value.send_failures_max,
    lastAckAgeMsMax: value.last_ack_age_ms_max,
    displayDatagramsReceived: value.display_datagrams_received,
    displayDatagramsRecoveredByFec: value.display_datagrams_recovered_by_fec,
    displayDatagramsDeclaredLost: value.display_datagrams_declared_lost,
    displayDatagramsOutcomeUnknown: value.display_datagrams_outcome_unknown,
    quicSentPackets: value.quic_sent_packets,
    quicLostPackets: value.quic_lost_packets,
    quicLostBytes: value.quic_lost_bytes,
    quicCongestionEvents: value.quic_congestion_events,
    quicBlackHoles: value.quic_black_holes,
    quicDatagramsTx: value.quic_datagrams_tx,
    quicDatagramsRx: value.quic_datagrams_rx,
    quicUdpTxBytes: value.quic_udp_tx_bytes,
    quicUdpRxBytes: value.quic_udp_rx_bytes,
    quicMtuMin: value.quic_mtu_min,
    quicCwndBytesMin: value.quic_cwnd_bytes_min,
    quicRttUsMax: value.quic_rtt_us_max,
  };
}

function isWebTransportCandidateKind(value: unknown): value is string {
  return (
    value === 'srflx' ||
    value === 'nat_map' ||
    value === 'host4' ||
    value === 'host6' ||
    value === 'loopback'
  );
}

function toDataplaneWireConfig(config: DataplaneConfig): DataplaneWireConfig {
  const {
    shell: _shell,
    webtransport_port: _webtransportPort,
    shell_token_path: _shellTokenPath,
    open_url_bin_dir: _openUrlBinDir,
    public_wt_endpoint: _publicWtEndpoint,
    ...wireConfig
  } = config;
  return wireConfig;
}

function scheduleTimeout(delayMs: number, callback: () => void): DataplaneTimerHandle {
  const timer = setTimeout(callback, delayMs);
  return {
    cancel(): void {
      clearTimeout(timer);
    },
  };
}

/**
 * Publish a cancellable identity before calling an injected scheduler. If that
 * scheduler fires inline, normalize the impossible "delay elapsed before
 * schedule returned" ordering through the native timer queue. This prevents a
 * fired handle from being reinstalled and avoids recursive restart storms.
 */
function createDataplaneTimerPublication(): {
  readonly handle: DataplaneTimerHandle;
  install(
    schedule: (delayMs: number, callback: () => void) => DataplaneTimerHandle,
    delayMs: number,
    callback: () => void,
  ): void;
} {
  let installedHandle: DataplaneTimerHandle | null = null;
  let cancelled = false;
  const handle: DataplaneTimerHandle = {
    cancel(): void {
      if (cancelled) return;
      cancelled = true;
      installedHandle?.cancel();
    },
  };

  return {
    handle,
    install(schedule, delayMs, callback): void {
      let scheduling = true;
      let firedSynchronously = false;
      const scheduledHandle = schedule(delayMs, () => {
        if (scheduling) {
          firedSynchronously = true;
          return;
        }
        callback();
      });
      scheduling = false;
      if (firedSynchronously) {
        scheduledHandle.cancel();
        installedHandle = scheduleTimeout(delayMs, callback);
      } else {
        installedHandle = scheduledHandle;
      }
      if (cancelled) {
        installedHandle.cancel();
      }
    },
  };
}

function isCanonicalProofSignature(value: unknown, bytes: number): value is string {
  if (
    typeof value !== 'string' ||
    value.length !== Math.ceil((bytes * 4) / 3) ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  )
    return false;
  const decoded = Buffer.from(value, 'base64url');
  return decoded.length === bytes && decoded.toString('base64url') === value;
}
