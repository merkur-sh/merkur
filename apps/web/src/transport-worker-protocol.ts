// Messages crossing the main ↔ transport-worker boundary are typed here, without
// DOM-host coupling. Both ends are one build: the worker's hashed URL is embedded
// in the main bundle, so the types are the whole contract and nothing is checked
// at run time.
//
// The worker hosts the Rust Session sans-IO owner and native WebTransport,
// timer and SAB adapters. Main owns UI/input capture, access-token-gated HTTPS
// calls, DOM network hints and the lifecycle/metrics projection.
// Opened terminal ingress uses the frame SAB; captured input uses the input SAB.
// Canonical Rust Viewer outputs travel directly on the peer port to Session.
// Native/task wake edges and frame-space credit also stay between the workers.
// This channel carries initialization, server RPCs and cold host intents.

import type { DisplayLinkDefinition, TerminalUiEffect } from '@merkur/protocol';
import type { BrowserUpgradeReport, RecoveryOutcome, SignalingStatus } from '@merkur/shared';
import type { DaemonBinding } from '@merkur/shared/user-authorization';
import type { DirectDialOutcome } from './session/direct-dial-admission';
import type { LinkState } from './session/session-state';
import type { TerminalDisplayRingWakeMode } from './terminal/runtime-policy';
import type { LinkActivitySnapshot } from './transport/link-activity';

/** Path label projected to the UI; mirrors session-state `LinkPath`. */
export type TransportPathType = 'direct' | 'relay' | 'unknown';

/** The transport-hint knob computed by the main-side autotuner. */
export interface TransportHintParams {
  readonly profile: number;
  readonly chunkBytes: number;
  readonly snapshotBytes: number;
}

/** Result of the main-held `api.requestSession` call, replied to the worker. */
export interface RequestSessionResult {
  readonly daemonId: string;
  /** Daemon-owned ML-DSA-87 identity key authenticated by the account session. */
  readonly daemonIdentityPublicKey: string;
  readonly daemonIdentityP256PublicKey: string;
  /** Permanent user-root authorization of this daemon identity. */
  readonly daemonBinding: DaemonBinding;
  readonly sessionToken: string;
  /** Server-clock lifetime, converted to a monotonic deadline by edge signaling. */
  readonly sessionTokenExpiresInMs: number;
  readonly sessionTokenExpiresAtMs: number;
  readonly sessionId: string;
  /**
   * Anycast edge WebTransport URL — the required bootstrap and baseline relay
   * path. Carried verbatim from `SessionRequestResponse`; the worker dials the
   * edge with the SAME session_id (routing preface).
   */
  readonly edgeWtUrl: string;
  /** All accepted hashes during a certificate rotation overlap. */
  readonly edgeCertHashes: readonly string[];
  /**
   * The attach ticket every edge lane of this session presents, for the rest
   * of the session including rebinds: it binds the session and daemon and
   * carries no expiry.
   */
  readonly edgeAttachTicket: string;
}

export interface RenewSessionRequest {
  readonly daemonId: string;
  readonly browserNodeId: string;
  readonly sessionId: string;
  readonly commitment: string;
  /** The edge the session's attachments dial, whose hashes the answer states. */
  readonly edgeWtUrl: string;
}

export interface RenewSessionResult {
  readonly sessionToken: string;
  /** Scheduling hint only. The daemon enforces the signed expiry. */
  readonly sessionTokenExpiresInMs: number;
  /**
   * The named edge's certificate hashes as its registration states them now,
   * or null while the registry holds no live registration for it. The session
   * pins them for every later dial.
   */
  readonly edgeCertHashes: readonly string[] | null;
}

export type SessionIssuanceErrorCode =
  | 'request_rejected'
  | 'invalid_session_response'
  | 'session_issuance_cancelled'
  | 'session_issuance_conflict'
  | 'session_issuance_expired'
  | 'authorization_rejected'
  | 'daemon_unlinked';

/**
 * The input ring's task wake, main → transport worker: posted on every
 * readable edge where the reader parks on a task, and at every resume beside
 * the native recovery notify. A bare number, not a message: nothing is cloned
 * into the worker for a keystroke. The ring's contents
 * and the session's fences remain authoritative, so a stale or duplicate edge
 * is inert.
 */
export const INPUT_AVAILABLE_EDGE = 0;

/** main → transport worker */
export type MainToTransport =
  | {
      kind: 'renew_session_result';
      startId: number;
      requestId: number;
      result: RenewSessionResult;
      error?: never;
      errorCode?: never;
    }
  | {
      kind: 'renew_session_result';
      startId: number;
      requestId: number;
      error: string;
      errorCode?: SessionIssuanceErrorCode;
      result?: never;
    }
  | { kind: 'direct_dial_result'; startId: number; requestId: number; allowed: boolean }
  | {
      // First message, once per worker lifetime. Hands over every SAB the
      // worker needs. The shared buffers outlive session restarts:
      //   - frameRing: the worker is the SOLE producer; the terminal worker reads.
      //   - viewerOutputRing: the terminal worker writes what its viewer asks the
      //     session to send (display ACKs, and the rarer requests); the worker
      //     reads each into the session.
      //   - inputRing: main writes keystrokes (seq + bytes); the worker reads and
      //     feeds the relocated outbox; the worker publishes unackedBytes back.
      //   - predictionAdmission: fixed seq/lineage slots resolved by the terminal
      //     worker after exact WASM admission and consumed before input is sent.
      kind: 'init';
      frameRing: SharedArrayBuffer;
      viewerOutputRing: SharedArrayBuffer;
      inputRing: SharedArrayBuffer;
      predictionAdmission: SharedArrayBuffer;
      /**
       * The terminal worker's live claim about its grid. Read — never written —
       * here, to build `display_resume` without a request/reply round trip that
       * could hand this worker a claim the grid has already moved past.
       */
      presentationCadence: SharedArrayBuffer;
      /** Latest fused receiver-cost posterior, written by terminal worker. */
      displayReceiverProfile: SharedArrayBuffer;
      /** This worker's profiling ring; drained by the telemetry worker. */
      perfRing: SharedArrayBuffer;
      perfEnabled: boolean;
      /** Non-zero browser recorder lineage for daemon timing. */
      perfObservationEpoch: number;
      /**
       * This worker's end of the worker-to-worker wake channel, transferred.
       * In `'task'` mode this worker posts a frame-ring edge on it and the
       * terminal worker posts a viewer-output edge back. In both modes each
       * worker posts the edge for room in a ring that had refused an entry,
       * and a quantized display-period change crosses so transport can refresh
       * its hint.
       */
      ringWakePort: MessagePort;
      /**
       * Resolved once on main; decides how this worker's viewer-output and
       * input readers park, and whether the frame writer carries a task edge
       * at all.
       */
      displayRingWakeMode: TerminalDisplayRingWakeMode;
    }
  | {
      // Begin (or restart) a session against `daemonId`. NO access token — the
      // worker requests the session by RPC and main answers using the token it
      // holds. `browserPeerId` is generated on main per session so the
      // predictive-echo lineage and the worker agree on identity from the first
      // keystroke; it is the Noise prologue identity label only (the daemon never
      // dials it). `startId` is the main-owned invocation lineage: every
      // session-scoped worker event echoes it so a late completion from a
      // superseded start cannot settle or mutate its replacement.
      kind: 'start';
      startId: number;
      daemonId: string;
      browserPeerId: string;
      userId: string;
      delegationId: string;
      perfEnabled: boolean;
      perfObservationEpoch: number;
    }
  | {
      /** Fence a recorder reset without restarting the terminal session. */
      kind: 'perf_observation_epoch';
      perfObservationEpoch: number;
    }
  | {
      kind: 'request_session_result';
      startId: number;
      requestId: number;
      result: RequestSessionResult;
      error?: never;
      errorCode?: never;
    }
  | {
      kind: 'request_session_result';
      startId: number;
      requestId: number;
      result?: never;
      error: string;
      errorCode?: SessionIssuanceErrorCode;
    }
  | {
      // Idempotent DOM-sourced hints. `offline` tears the direct path down;
      // `network_change` is an `online` edge, the one hint that clears the
      // direct-WebTransport abandonment before probing; `wake` is a clock jump,
      // which nudges the daemon and probes the same way but leaves abandonment
      // standing (see `probeTransports`); `visibility_resume` maps to
      // notifyResumed(); `persist_on_hide` flushes the in-memory snapshot.
      kind: 'hint';
      hint: 'wake' | 'network_change' | 'offline' | 'visibility_resume' | 'persist_on_hide';
    }
  /**
   * The page was frozen (Page Lifecycle) and has resumed after `suspendedMs`.
   *
   * Deliberately NOT folded into the `hint` alphabet: the duration IS the
   * signal, and every existing hint discards it. `visibility_resume` would drop
   * it, and `network_change` would additionally clear the direct-WebTransport
   * abandon budget — which `probeTransports` documents must never happen on a
   * bare resume, or a frequently-waking mobile PWA resets that budget forever.
   */
  | { kind: 'page_resumed'; suspendedMs: number }
  | { kind: 'resize'; cols: number; rows: number; cellWidth: number; cellHeight: number }
  // `columns`: the widest visible waveform (1..LINK_ACTIVITY_COLUMNS), the
  // horizon a burst scrolls out over before the worker parks; 0 when disabled.
  | { kind: 'observe_link'; subscriptionId: number; enabled: boolean; columns: number }
  | { kind: 'link_tick_ack'; subscriptionId: number; sequence: number }
  | { kind: 'take_geometry_control' }
  // Whether this window is the focused one, from the same focus/blur edges the
  // input controller reports to the daemon. The focused window owns the shared
  // geometry: it claims on its own layout changes and on becoming focused, and
  // an unfocused window never claims, so a background tab cannot resize the
  // shell someone is using elsewhere.
  | { kind: 'window_focus'; focused: boolean }
  | { kind: 'request_snapshot' }
  | { kind: 'transport_hint'; hint: TransportHintParams }
  | {
      // Graceful end of the current session without terminating the worker (a
      // reconnect drives a fresh `start`). `preserveInput` keeps the unacked
      // outbox for replay; false resets it.
      kind: 'stop_session';
      preserveInput: boolean;
    }
  | { kind: 'shutdown' };

/** transport worker → main */
export type TransportToMain =
  | {
      kind: 'recovery_event';
      startId: number;
      outcome: RecoveryOutcome;
      ended: boolean;
      atMs: number;
    }
  | { kind: 'abandon_issuance'; issuanceId: string }
  | ({ kind: 'renew_session'; startId: number; requestId: number } & RenewSessionRequest)
  | { kind: 'direct_dial'; startId: number; requestId: number; endpoint: string }
  | {
      kind: 'direct_dial_settle';
      startId: number;
      requestId: number;
      outcome: DirectDialOutcome;
    }
  // The committed signaling carrier's proven address, as the edge validated
  // it. Main keys the page's network visit by it.
  | { kind: 'observed_path'; startId: number; address: string }
  | { kind: 'ready' }
  | {
      // RPC to the main-held access token: main calls
      // api.requestSession(token, daemonId, browserNodeId), lazily refreshing
      // the token for the reconnect path, and replies with
      // request_session_result carrying the same startId + requestId ownership.
      kind: 'request_session';
      startId: number;
      requestId: number;
      daemonId: string;
      browserNodeId: string;
      issuanceId: string;
      supersedesIssuanceId?: string;
      clientNonce: string;
      encapsulationKey: string;
    }
  | { kind: 'input_ready'; startId: number }
  | {
      kind: 'connected';
      startId: number;
      preserveDisplay: boolean;
      displayRingFenceToken: number;
      // Server-issued Merkur session id, carried so main can emit the
      // `session_bound` profiling row that makes perf rows joinable to spans.
      sessionId: string;
    }
  | { kind: 'disconnected'; startId: number; reason: string }
  | {
      // Per-heartbeat projection of the worker's session-state store: the
      // autotuner input (rtt/path/bitrate) AND the LinkStatus mirror fields
      // (byte totals + degraded + link state). Main holds no session-state of its
      // own; this is the sole source for the connection-quality widget.
      kind: 'metrics';
      startId: number;
      rttMs: number | null;
      pathType: TransportPathType;
      availableOutgoingBitrateMbps: number | null;
      networkRttMs: number | null;
      /**
       * EWMA of keystroke-emit to daemon-acknowledgement. Distinct from the
       * heartbeat round trips above: it measures the path an actual input takes,
       * so it reflects queueing the heartbeat never sees. `null` until the first
       * acknowledgement lands.
       */
      inputAckRttMs: number | null;
      inputAckMs: number | null;
      inputAckSeq: number;
      resyncCount: number;
      txBytes: number;
      rxBytes: number;
      degraded: boolean;
      linkState: LinkState;
    }
  | ({ kind: 'link_tick'; startId: number } & LinkActivitySnapshot)
  | { kind: 'signaling_status'; startId: number; status: SignalingStatus }
  | { kind: 'dormant'; startId: number; isDormant: boolean }
  // One direct-upgrade attempt. The worker measures it but holds no access
  // token, so main posts it on the authenticated telemetry route.
  | { kind: 'upgrade_outcome'; startId: number; report: BrowserUpgradeReport }
  // OSC 8 link definitions from the daemon's control lane. Main owns them
  // because a click opens the link synchronously inside its own handler.
  | {
      kind: 'display_link_table';
      startId: number;
      reset: boolean;
      links: readonly DisplayLinkDefinition[];
    }
  // A program in the terminal asked to open this URL; main opens or offers it.
  // `(epoch, seq)` names the request, which the daemon may deliver again.
  | { kind: 'terminal_ui'; startId: number; effect: TerminalUiEffect }
  | { kind: 'open_url'; startId: number; epoch: number; seq: number; url: string }
  // Posted once the worker has finished its shutdown handler (sendPeerDisconnect,
  // dispose, PSK zeroing). Main waits for it — with a bounded timeout — before
  // terminate(), so those handlers actually run instead of being discarded.
  | { kind: 'shutdown_complete' };
