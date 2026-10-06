import type { TerminalUiEffect } from '@merkur/protocol';
import type { RecoveryOutcome } from '@merkur/shared';
// Thin main-side TerminalSession. The transport + session orchestration lives
// entirely in the transport worker (transport-worker.ts); this is the proxy the
// app controller, the reconnect controller, the input controller, and the
// LinkStatus widget talk to.
//
// It owns four main-thread-only responsibilities:
//   - spawning the transport worker and handing it the shared data-plane SABs;
//   - the input-ring WRITER + a synchronous monotonic input-seq counter + the
//     MAX_UNACKED budget gate (predictive echo needs the seq the instant a key is
//     captured, so sendKeystroke stays synchronous and returns the seq);
//   - answering the worker's access-token-gated server RPCs by calling api.ts
//     (the access token never enters the worker realm);
//   - mirroring the worker's lifecycle/metrics/status/dormant projection onto the
//     existing TerminalSession callbacks + the connection-quality/throughput
//     surface LinkStatus reads.
//
// The DOM network/wake/visibility hints are owned here too (they read
// navigator/document) and forwarded to the worker as idempotent hints.

import { SESSION_ISSUANCE_REQUEST_TIMEOUT_MS } from '@merkur/config/reconnect-policy';
import { createLogger } from '@merkur/logger';
import type { DisplayLinkDefinition } from '@merkur/protocol';
import type { BrowserUpgradeReport, SignalingStatus } from '@merkur/shared';
import { Effect } from 'effect';
import { isApiError } from './lib/api-error';
import type { LinkQualitySample } from './perf/link-quality-aggregator';
import { mainPerfInterner, mainPerfWriter } from './perf/main-perf-writer';
import {
  browserEffectiveType,
  browserNetworkType,
  emitInputQueued,
  emitRecoveryOutcome,
  emitSessionBound,
  emitSessionStart,
  emitTransportState,
} from './perf/perf-event-codec';
import {
  isTerminalPerfRecording,
  onTerminalPerfObservationReset,
  terminalPerfNowMs,
  terminalPerfObservationEpoch,
} from './perf/terminal-latency';
import { createDirectDialAdmission, type DirectDialClaim } from './session/direct-dial-admission';
import { createNetworkMonitor, type NetworkMonitor } from './session/network-monitor';
import type { ConnectionQuality, LinkState } from './session/session-state';
import { createWakeDetector, type WakeDetector } from './session/wake-detector';
import type { TerminalDisplayRingWakeMode } from './terminal/runtime-policy';
import { wakeFrameRingReader } from './terminal/shared-ring';
import {
  createInputRingWriter,
  type InputRingWriter,
  MAX_BUFFERED_INPUT_BYTES,
  MAX_BUFFERED_INPUT_ENTRIES,
  wakeInputRingReader,
} from './transport/input-ring';
import type { LinkActivitySnapshot } from './transport/link-activity';
import {
  INPUT_AVAILABLE_EDGE,
  type MainToTransport,
  type RenewSessionRequest,
  type RenewSessionResult,
  type RequestSessionResult,
  type SessionIssuanceErrorCode,
  type TransportHintParams,
  type TransportPathType,
  type TransportToMain,
} from './transport-worker-protocol';

const logger = createLogger('transport-worker-client');
const directDialAdmission = createDirectDialAdmission();

const MAX_INPUT_SEQ = 0xffff_ffff;

/** Input a user waits to see: sent now, and the start of an `input_queued` latency. */
export const INPUT_AWAITED = 0;
/** Input the application receives but nobody watches for (a reported release): sent now. */
export const INPUT_UNAWAITED = 1;
/**
 * Input that encodes to nothing under the terminal's current modes: held in the
 * input ring and sent with the next input, or when `releaseDeferredInput` runs.
 */
export const INPUT_DEFERRED = 2;
export type InputDelivery = typeof INPUT_AWAITED | typeof INPUT_UNAWAITED | typeof INPUT_DEFERRED;
// Upper bound on how long close() waits for the worker's shutdown handler
// (sendPeerDisconnect goodbye, dispose, PSK zeroing) to run before force
// terminating. A local worker settles in well under this; the timeout only
// backstops a wedged worker so close() never hangs.
const WORKER_SHUTDOWN_GRACE_MS = 500;
export interface TerminalSessionCallbacks {
  onConnected(preserveDisplay: boolean, displayRingFenceToken: number): void;
  onDisconnected(reason: string): void;
  onWorkerFailure?(): void;
  onMetrics(
    rttMs: number | null,
    pathType: TransportPathType,
    availableOutgoingBitrateMbps: number | null,
    networkRttMs: number | null,
    /**
     * The rest of the heartbeat projection, carried so a consumer can summarise
     * link quality without a second subscription. Everything here is already
     * being computed for the LinkStatus mirror above.
     */
    linkSample: LinkQualitySample,
  ): void;
  onSignalingStatus?(status: SignalingStatus): void;
  onDormant?(isDormant: boolean): void;
  /**
   * One direct-upgrade attempt finished. Reported here rather than from the
   * worker because posting it needs the access token, which main owns.
   */
  onUpgradeOutcome?(report: BrowserUpgradeReport): void;
  /**
   * Recovery only — a resume or a clock jump: re-release the terminal worker's
   * frame reader through main, beside the native notifies `wakeSabPumps`
   * already issued. The per-frame edge never comes this way; the transport
   * worker wakes the terminal worker on the ring itself or over their port.
   */
  onRecoverDisplayReader?(): void;
  /** DOM/network evidence that should preempt a pending reconnect backoff. */
  /**
   * The worker will now admit input for the active start.
   *
   * This is the exact edge the input buffer used to wait for on a timer. It is
   * already filtered by `startId`, so a late `input_ready` from a superseded
   * start cannot release a buffer that belongs to its replacement.
   */
  onInputReady?(): void;
  /** OSC 8 link definitions for the active start. */
  onDisplayLinkTable?(reset: boolean, links: readonly DisplayLinkDefinition[]): void;
  /** A program in the active start's terminal asked to open a URL. */
  onTerminalUi?(effect: TerminalUiEffect): void;
  onOpenUrl?(epoch: number, seq: number, url: string): void;
}

export interface TerminalSession {
  start(daemonId: string, signal?: AbortSignal): Promise<void>;
  /**
   * Whether `sendKeystroke` can currently admit input.
   *
   * False from a disconnect until the worker republishes `input_ready` for the
   * next start — a whole reconnect ladder, up to a minute. The input buffer
   * reads it to choose a retry cadence: transient ring backpressure clears in
   * single-digit milliseconds and deserves a tight retry, while waiting out a
   * reconnect at that rate would be thousands of pointless main-thread wakeups
   * on a phone that is already struggling.
   */
  isAcceptingInput(): boolean;
  /**
   * Only `INPUT_AWAITED` input is an `input_queued` event: input-to-presentation
   * latency is measured over input a user waits to see. `INPUT_DEFERRED` input
   * takes its sequence and its place in order now, and leaves with the next
   * input rather than on a datagram of its own.
   */
  sendKeystroke(
    input: Uint8Array,
    inputAtMs?: number,
    classifyShadowModelled?: (inputSeq: number) => boolean,
    delivery?: InputDelivery,
  ): number | null;
  /**
   * Send every deferred input now: the terminal started reporting input of a
   * kind that was being held.
   */
  releaseDeferredInput(): void;
  sendResize(cols: number, rows: number, cellWidth: number, cellHeight: number): void;
  takeGeometryControl(): void;
  /**
   * This window's focus, from the same edges the daemon's focus records ride.
   * The focused window owns the shared geometry, so the shell fits the window
   * being typed into without anyone asking it to.
   */
  setWindowFocused(focused: boolean): void;
  requestDisplaySnapshot(): void;
  notifyResumed(): void;
  sendTransportHint(hint: TransportHintParams): void;
  getConnectionQuality(): ConnectionQuality;
  onConnectionQualityChange(listener: () => void): () => void;
  getThroughput(): { readonly txBytes: number; readonly rxBytes: number };
  /**
   * Subscribe a visible waveform of `columns` visible 60 ms columns. The worker
   * publishes only while terminal traffic is on the strip; the widest subscriber
   * decides when a burst has scrolled off.
   */
  onTransportActivity(
    listener: (snapshot: LinkActivitySnapshot) => void,
    columns: number,
  ): () => void;
  close(): void;
}

/** The access-token-gated server call, resolved on main per RPC. */
export interface TransportServerBridge {
  renewSession(request: RenewSessionRequest, signal: AbortSignal): Promise<RenewSessionResult>;
  getBrowserAuthorization(): {
    readonly userId: string;
    readonly delegationId: string;
  };
  requestSession(
    daemonId: string,
    browserNodeId: string,
    issuanceId: string,
    supersedesIssuanceId: string | undefined,
    clientNonce: string,
    encapsulationKey: string,
    signal: AbortSignal,
  ): Promise<RequestSessionResult>;
  cancelSessionRequest(issuanceId: string): Promise<void>;
}

export interface TransportSessionRings {
  readonly frameRing: SharedArrayBuffer;
  /** What the terminal worker's viewer asks the session to send; this worker reads it. */
  readonly viewerOutputRing: SharedArrayBuffer;
  readonly inputRing: SharedArrayBuffer;
  readonly predictionAdmission: SharedArrayBuffer;
  /** The terminal worker's live grid claim; this worker only reads it. */
  readonly presentationCadence: SharedArrayBuffer;
  readonly displayReceiverProfile: SharedArrayBuffer;
  /** The transport worker's profiling ring; drained by the telemetry worker. */
  readonly transportPerfRing: SharedArrayBuffer;
  /** The transport worker's end of the worker-to-worker wake channel. */
  readonly transportRingWakePort: MessagePort;
  /** Resolved once on main; every ring reader in the bundle parks this way. */
  readonly displayRingWakeMode: TerminalDisplayRingWakeMode;
}

export function createTransportSession(
  callbacks: TerminalSessionCallbacks,
  rings: TransportSessionRings,
  server: TransportServerBridge,
  runtimeOptions: {
    readonly sessionRequestTimeoutMs?: number;
    /**
     * A worker crash, classified and counted by the caller.
     *
     * A worker's `error` event fires on the `Worker` object, never on `window`, so the
     * global handlers cannot see it. Without this hook a crashed worker is invisible to
     * everything but the console.
     */
    readonly onWorkerError?: (error: unknown) => void;
  } = {},
): TerminalSession {
  // Keep the URL expression directly inside Worker(): Vite fingerprints this
  // dependency and embeds the exact content-hashed asset in the equally hashed
  // main bundle. An already-open old main can therefore never instantiate a
  // newly deployed worker with an incompatible message/SAB ABI.
  const worker = new Worker(new URL('./transport-worker.ts', import.meta.url), {
    type: 'module',
  });

  // The input ring's task edge exists only where its reader parks on a task.
  // In 'native' mode the worker parks on the ring's own word and a keystroke
  // posts nothing.
  const writer: InputRingWriter = createInputRingWriter(
    rings.inputRing,
    rings.predictionAdmission,
    rings.displayRingWakeMode === 'task' ? postInputAvailable : undefined,
  );
  const configuredSessionRequestTimeoutMs = runtimeOptions.sessionRequestTimeoutMs;
  const sessionRequestTimeoutMs =
    configuredSessionRequestTimeoutMs !== undefined &&
    Number.isFinite(configuredSessionRequestTimeoutMs) &&
    configuredSessionRequestTimeoutMs > 0
      ? Math.trunc(configuredSessionRequestTimeoutMs)
      : SESSION_ISSUANCE_REQUEST_TIMEOUT_MS;
  let nextInputSeq = 1;
  let acceptingInput = false;

  // A start promise is an owned invocation, not a shared resolver slot. The
  // worker echoes this id on every session-scoped event, preventing an older
  // worker completion from settling or mutating its replacement.
  let nextStartId = 1;
  const directDialClaims = new Map<number, { startId: number; claim: DirectDialClaim }>();
  let activeStartId: number | null = null;
  let pendingStart: {
    readonly startId: number;
    readonly resolve: () => void;
    readonly reject: (error: Error) => void;
  } | null = null;
  let workerFailure: Error | null = null;
  const sessionRequestControllers = new Map<
    number,
    { readonly startId: number; readonly issuanceId: string; readonly controller: AbortController }
  >();
  const knownSessionIssuanceIds = new Set<string>();
  const renewalControllers = new Map<number, AbortController>();
  const issuanceSessions = new Map<string, string>();
  const owedSessionCancellations = new Set<string>();
  const cancellationRequestsInFlight = new Set<string>();
  let cancellationRecoveryListenersAttached = false;

  function abortSessionRequests(): void {
    for (const controller of renewalControllers.values()) controller.abort();
    renewalControllers.clear();
    for (const request of sessionRequestControllers.values()) {
      request.controller.abort();
    }
    sessionRequestControllers.clear();
  }

  function updateCancellationRecoveryListeners(): void {
    const shouldAttach = owedSessionCancellations.size > 0;
    if (shouldAttach === cancellationRecoveryListenersAttached) return;
    cancellationRecoveryListenersAttached = shouldAttach;
    if (shouldAttach) {
      window.addEventListener('online', flushOwedSessionCancellations);
      document.addEventListener('visibilitychange', flushOwedSessionCancellations);
    } else {
      window.removeEventListener('online', flushOwedSessionCancellations);
      document.removeEventListener('visibilitychange', flushOwedSessionCancellations);
    }
  }

  function flushOwedSessionCancellations(): void {
    updateCancellationRecoveryListeners();
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    for (const issuanceId of owedSessionCancellations) {
      if (cancellationRequestsInFlight.has(issuanceId)) continue;
      cancellationRequestsInFlight.add(issuanceId);
      void server
        .cancelSessionRequest(issuanceId)
        .then(() => {
          owedSessionCancellations.delete(issuanceId);
        })
        .catch((error) => {
          logger.warn('session_issuance_cancel_failed', {
            issuanceId,
            error: String(error),
          });
        })
        .finally(() => {
          cancellationRequestsInFlight.delete(issuanceId);
          updateCancellationRecoveryListeners();
        });
    }
  }

  function abandonSessionIssuances(): void {
    // Connectivity events retry obligations; they never create them. A live
    // session belongs to the worker and is closed over its authenticated channel.
    for (const issuanceId of knownSessionIssuanceIds) {
      owedSessionCancellations.add(issuanceId);
    }
    knownSessionIssuanceIds.clear();
    issuanceSessions.clear();
    flushOwedSessionCancellations();
  }

  // ── Main-side mirrors of the worker's quality/throughput projection ─────────
  // LinkStatus reads getConnectionQuality/onConnectionQualityChange and
  // getThroughput/onTransportActivity. The worker owns the session-state store;
  // main keeps a small mirror updated from the lifecycle/metrics messages.
  let quality: ConnectionQuality = {
    rttMs: null,
    rttFloorMs: null,
    inputAckMs: null,
    inputAckSeq: 0,
    path: 'unknown',
    state: 'closed',
    degraded: false,
    resyncCount: 0,
    seq: 0,
  };
  let txBytes = 0;
  let rxBytes = 0;
  const qualityListeners = new Set<() => void>();
  // The visible waveform owns the fast feed. No observer means no worker timer
  // or activity publications; keystrokes never invoke these listeners.
  const activityListeners: Array<{
    readonly listener: (snapshot: LinkActivitySnapshot) => void;
    readonly columns: number;
  }> = [];
  let linkSubscriptionId = 0;
  let linkSubscription = { enabled: false, columns: 0 };
  const throughput = { txBytes: 0, rxBytes: 0 };

  /**
   * Post the worker's view of the observers when it changes: whether anyone is
   * watching, and the widest strip, which sets the horizon a burst scrolls off
   * over. A second observer no wider than the first changes nothing the worker
   * needs, so the subscription (and the id that fences its deliveries) stands.
   */
  function updateLinkSubscription(): void {
    let columns = 0;
    for (const { columns: observed } of activityListeners) columns = Math.max(columns, observed);
    const enabled = activityListeners.length > 0;
    if (enabled === linkSubscription.enabled && columns === linkSubscription.columns) return;
    linkSubscription = { enabled, columns };
    linkSubscriptionId += 1;
    post({ kind: 'observe_link', subscriptionId: linkSubscriptionId, enabled, columns });
  }

  // Quality changes stay independent of the fast traffic feed.
  function emitQualityChanged(): void {
    for (const listener of qualityListeners) listener();
  }

  function emitActivity(snapshot: LinkActivitySnapshot): void {
    for (let index = 0; index < activityListeners.length; index += 1) {
      const subscriber = activityListeners[index];
      if (subscriber !== undefined) subscriber.listener(snapshot);
    }
  }

  function setQualityState(state: LinkState): void {
    if (quality.state === state) return;
    quality = { ...quality, state };
    emitQualityChanged();
  }

  function post(message: MainToTransport): void {
    if (terminated) return;
    worker.postMessage(message);
  }

  /** The input ring's task wake: a number, so a keystroke clones no message. */
  function postInputAvailable(): void {
    if (terminated) return;
    worker.postMessage(INPUT_AVAILABLE_EDGE);
  }

  // Graceful-shutdown handshake: close() posts stop_session + shutdown and waits
  // (bounded) for the worker's shutdown_complete before terminate(), so the
  // worker's cleanup actually runs instead of being discarded.
  let shutdownTimer: ReturnType<typeof setTimeout> | null = null;
  let terminated = false;
  let closing = false;
  const stopPerfObservationReset = onTerminalPerfObservationReset((perfObservationEpoch) => {
    if (closing || terminated) return;
    post({ kind: 'perf_observation_epoch', perfObservationEpoch });
  });
  function finishShutdown(): void {
    if (terminated) return;
    terminated = true;
    stopPerfObservationReset();
    abortSessionRequests();
    if (shutdownTimer !== null) {
      clearTimeout(shutdownTimer);
      shutdownTimer = null;
    }
    worker.terminate();
    // A handshake the worker took down with it cost a handshake: it stays
    // spent for this visit, like any other that never answered.
    for (const { claim } of directDialClaims.values()) claim.settle('failed');
    directDialClaims.clear();
  }

  let observedRecovery: { outcome: RecoveryOutcome; atMs: number; startId: number } | null = null;
  const completedRecoveryAttempts = new Map<string, number>();
  function recordRecovery(outcome: RecoveryOutcome, atMs: number): void {
    const completed = completedRecoveryAttempts.get(outcome.ownerId) ?? 0;
    if (outcome.attemptId <= completed) return;
    completedRecoveryAttempts.set(outcome.ownerId, outcome.attemptId);
    if (!isTerminalPerfRecording()) return;
    const writer = mainPerfWriter();
    if (writer !== null) emitRecoveryOutcome(writer, atMs, outcome);
  }

  worker.onmessage = (event: MessageEvent<TransportToMain>): void => {
    if (terminated) return;
    const data = event.data;
    if (closing && data.kind !== 'shutdown_complete' && data.kind !== 'recovery_event') return;
    void handleWorkerMessage(data);
  };
  worker.onerror = (event: ErrorEvent): void => {
    event.preventDefault();
    // Reported before failing: a worker error event never reaches the window handlers, so
    // without this a crashed worker is invisible to everything but the console.
    runtimeOptions.onWorkerError?.(event.error ?? new Error(event.message));
    failWorker(`Transport worker crashed: ${event.message || 'unknown worker error'}`);
  };
  worker.onmessageerror = (): void => {
    failWorker('Transport worker failed to deserialize a message');
  };

  /**
   * A worker failure is fatal to exactly the start owned by this worker
   * instance. Revoke ownership before notifying application code so a queued
   * error from a closing/replaced worker cannot settle or mutate a newer start.
   */
  function failWorker(reason: string): void {
    if (terminated) return;
    if (closing) {
      // close() already revoked this worker's session ownership. An error queued
      // before terminate must only accelerate that old worker's shutdown.
      finishShutdown();
      return;
    }
    if (workerFailure !== null) return;

    const failure = new Error(reason);
    workerFailure = failure;
    if (observedRecovery !== null) {
      const { outcome, atMs } = observedRecovery;
      const now = terminalPerfNowMs();
      recordRecovery(
        {
          ...outcome,
          endReason: 'worker_failed',
          cancellationInitiator: 'worker',
          durationMs: outcome.durationMs + Math.max(0, now - atMs),
        },
        now,
      );
      observedRecovery = null;
    }
    closing = true;
    acceptingInput = false;
    const failedStartId = activeStartId;
    activeStartId = null;
    abortSessionRequests();
    abandonSessionIssuances();
    const ownedPendingStart = pendingStart?.startId === failedStartId ? pendingStart : null;
    if (ownedPendingStart !== null) pendingStart = null;
    setQualityState('closed');
    detachHintSources();
    finishShutdown();
    ownedPendingStart?.reject(failure);
    if (failedStartId !== null) {
      callbacks.onDisconnected(reason);
      callbacks.onWorkerFailure?.();
    }
  }

  function deliverTerminalMetadata(
    message: Extract<TransportToMain, { kind: 'terminal_ui' | 'open_url' }>,
  ): void {
    if (message.startId !== activeStartId) return;
    if (message.kind === 'terminal_ui') callbacks.onTerminalUi?.(message.effect);
    else callbacks.onOpenUrl?.(message.epoch, message.seq, message.url);
  }

  async function handleWorkerMessage(message: TransportToMain): Promise<void> {
    switch (message.kind) {
      case 'renew_session': {
        if (closing || message.startId !== activeStartId) return;
        const controller = new AbortController();
        renewalControllers.set(message.requestId, controller);
        try {
          const result = await server.renewSession(
            {
              daemonId: message.daemonId,
              browserNodeId: message.browserNodeId,
              sessionId: message.sessionId,
              commitment: message.commitment,
              edgeWtUrl: message.edgeWtUrl,
            },
            AbortSignal.any([controller.signal, AbortSignal.timeout(sessionRequestTimeoutMs)]),
          );
          if (controller.signal.aborted || message.startId !== activeStartId) return;
          post({
            kind: 'renew_session_result',
            startId: message.startId,
            requestId: message.requestId,
            result,
          });
        } catch (error) {
          if (controller.signal.aborted || message.startId !== activeStartId) return;
          post({
            kind: 'renew_session_result',
            startId: message.startId,
            requestId: message.requestId,
            error: error instanceof Error ? error.message : String(error),
            ...sessionRpcErrorFields(error),
          });
        } finally {
          if (renewalControllers.get(message.requestId) === controller)
            renewalControllers.delete(message.requestId);
        }
        return;
      }
      case 'direct_dial': {
        if (closing || message.startId !== activeStartId) return;
        const claim = directDialAdmission.claim(message.endpoint);
        if (claim !== null) {
          directDialClaims.set(message.requestId, { startId: message.startId, claim });
        }
        post({
          kind: 'direct_dial_result',
          startId: message.startId,
          requestId: message.requestId,
          allowed: claim !== null,
        });
        return;
      }
      case 'direct_dial_settle': {
        const owned = directDialClaims.get(message.requestId);
        if (owned?.startId === message.startId) {
          owned.claim.settle(message.outcome);
          directDialClaims.delete(message.requestId);
        }
        return;
      }
      case 'observed_path':
        // Only the active session's committed carrier names the page's network.
        if (!closing && message.startId === activeStartId) {
          directDialAdmission.observePath(message.address);
        }
        return;
      case 'ready':
        return;
      case 'recovery_event': {
        const { outcome, atMs, ended, startId } = message;
        const sameAttempt =
          observedRecovery?.outcome.ownerId === outcome.ownerId &&
          observedRecovery.outcome.attemptId === outcome.attemptId;
        if (ended) {
          if (!sameAttempt && startId !== activeStartId) return;
          recordRecovery(outcome, atMs);
          if (sameAttempt) observedRecovery = null;
        } else if (
          !closing &&
          startId === activeStartId &&
          outcome.attemptId > (completedRecoveryAttempts.get(outcome.ownerId) ?? 0)
        ) {
          observedRecovery = { outcome, atMs, startId };
        }
        return;
      }
      case 'abandon_issuance': {
        if (!knownSessionIssuanceIds.delete(message.issuanceId)) return;
        issuanceSessions.delete(message.issuanceId);
        for (const [requestId, request] of sessionRequestControllers) {
          if (request.issuanceId !== message.issuanceId) continue;
          request.controller.abort(new Error('Issuance abandoned'));
          sessionRequestControllers.delete(requestId);
        }
        owedSessionCancellations.add(message.issuanceId);
        flushOwedSessionCancellations();
        return;
      }
      case 'request_session': {
        if (closing || message.startId !== activeStartId) return;
        knownSessionIssuanceIds.add(message.issuanceId);
        const controller = new AbortController();
        sessionRequestControllers.set(message.requestId, {
          startId: message.startId,
          issuanceId: message.issuanceId,
          controller,
        });
        try {
          const result = await Effect.runPromise(
            Effect.tryPromise({
              try: (effectSignal) =>
                server.requestSession(
                  message.daemonId,
                  message.browserNodeId,
                  message.issuanceId,
                  message.supersedesIssuanceId,
                  message.clientNonce,
                  message.encapsulationKey,
                  AbortSignal.any([controller.signal, effectSignal]),
                ),
              catch: (error) => (error instanceof Error ? error : new Error(String(error))),
            }).pipe(
              Effect.timeoutOrElse({
                duration: sessionRequestTimeoutMs,
                orElse: () =>
                  Effect.fail(
                    new Error(`Session request timed out after ${sessionRequestTimeoutMs} ms`),
                  ),
              }),
            ),
          );
          if (controller.signal.aborted || message.startId !== activeStartId) return;
          issuanceSessions.set(message.issuanceId, result.sessionId);
          if (message.supersedesIssuanceId !== undefined) {
            knownSessionIssuanceIds.delete(message.supersedesIssuanceId);
            issuanceSessions.delete(message.supersedesIssuanceId);
            updateCancellationRecoveryListeners();
          }
          post({
            kind: 'request_session_result',
            startId: message.startId,
            requestId: message.requestId,
            result,
          });
        } catch (error) {
          if (controller.signal.aborted || message.startId !== activeStartId) return;
          post({
            kind: 'request_session_result',
            startId: message.startId,
            requestId: message.requestId,
            error: String(error),
            ...sessionRpcErrorFields(error),
          });
        } finally {
          const owned = sessionRequestControllers.get(message.requestId);
          if (owned?.controller === controller) {
            sessionRequestControllers.delete(message.requestId);
          }
        }
        return;
      }
      case 'input_ready':
        if (message.startId === activeStartId) {
          acceptingInput = true;
          // Release anything the main-thread input buffer parked while the
          // session was closed, on the edge itself. Polling for this was the
          // last timer standing in for a signal the worker already sends.
          callbacks.onInputReady?.();
        }
        return;
      case 'connected': {
        if (message.startId !== activeStartId) {
          return;
        }
        for (const [issuanceId, sessionId] of issuanceSessions) {
          if (sessionId !== message.sessionId) continue;
          knownSessionIssuanceIds.delete(issuanceId);
          issuanceSessions.delete(issuanceId);
        }
        if (isTerminalPerfRecording()) {
          emitTransportStateEvent('connected', undefined);
          // Announce the server-issued session id for the namespace opened by
          // `session_start`. The telemetry worker stamps it onto every row it
          // ships, which is what makes profiling rows joinable to spans; before
          // this they matched 0 of 521 trace sessions over 48 hours.
          if (message.sessionId.length > 0) {
            const writer = mainPerfWriter();
            const interner = mainPerfInterner();
            if (writer !== null && interner !== null) {
              // The network class rides the same row, read once per bound
              // session: it is what lets a stalled session be grouped by the
              // kind of network it was on.
              const connection = (
                navigator as Navigator & {
                  readonly connection?: {
                    readonly type?: unknown;
                    readonly effectiveType?: unknown;
                  };
                }
              ).connection;
              emitSessionBound(
                writer,
                terminalPerfNowMs(),
                interner.intern(message.sessionId),
                browserNetworkType(connection?.type),
                browserEffectiveType(connection?.effectiveType),
              );
            }
          }
        }
        setQualityState('ready');
        if (pendingStart?.startId === message.startId) {
          const { resolve } = pendingStart;
          pendingStart = null;
          resolve();
        }
        callbacks.onConnected(message.preserveDisplay, message.displayRingFenceToken);
        return;
      }
      case 'disconnected': {
        if (message.startId !== activeStartId) {
          return;
        }
        if (isTerminalPerfRecording()) {
          emitTransportStateEvent('disconnected', message.reason);
        }
        if (pendingStart?.startId === message.startId) {
          const { reject } = pendingStart;
          pendingStart = null;
          reject(new Error(message.reason));
        }
        acceptingInput = false;
        abortSessionRequests();
        activeStartId = null;
        setQualityState('closed');
        callbacks.onDisconnected(message.reason);
        return;
      }
      case 'display_link_table':
        if (message.startId === activeStartId)
          callbacks.onDisplayLinkTable?.(message.reset, message.links);
        return;
      case 'terminal_ui':
      case 'open_url':
        deliverTerminalMetadata(message);
        return;
      case 'link_tick': {
        if (
          message.startId !== activeStartId ||
          message.subscriptionId !== linkSubscriptionId ||
          activityListeners.length === 0
        )
          return;
        txBytes = message.txBytes;
        rxBytes = message.rxBytes;
        try {
          emitActivity(message);
        } finally {
          post({
            kind: 'link_tick_ack',
            subscriptionId: message.subscriptionId,
            sequence: message.sequence,
          });
        }
        return;
      }
      case 'metrics': {
        if (message.startId !== activeStartId) {
          return;
        }
        // The worker owns the session-state store; these are its authoritative
        // figures (wire-level byte totals settle here every heartbeat too).
        txBytes = message.txBytes;
        rxBytes = message.rxBytes;
        quality = {
          ...quality,
          // Preserve the current heartbeat sample alongside its diagnostic floor.
          inputAckMs: message.inputAckMs,
          inputAckSeq: message.inputAckSeq,
          resyncCount: message.resyncCount,
          rttMs: message.rttMs,
          rttFloorMs: message.networkRttMs,
          path: message.pathType,
          degraded: message.degraded,
          state: message.linkState,
          seq: message.rttMs === null ? quality.seq : quality.seq + 1,
        };
        emitQualityChanged();
        callbacks.onMetrics(
          message.rttMs,
          message.pathType,
          message.availableOutgoingBitrateMbps,
          message.networkRttMs,
          {
            rttMs: message.networkRttMs ?? message.rttMs,
            inputAckRttMs: message.inputAckRttMs,
            path: message.pathType,
            linkState: message.linkState,
            degraded: message.degraded,
            txBytes: message.txBytes,
            rxBytes: message.rxBytes,
          },
        );
        return;
      }
      case 'signaling_status': {
        if (message.startId !== activeStartId) {
          return;
        }
        if (isTerminalPerfRecording()) {
          emitTransportStateEvent(
            message.status === 'reconnecting' ? 'signaling_reconnecting' : 'signaling_connected',
            undefined,
          );
        }
        if (message.status === 'reconnecting') setQualityState('reconnecting');
        callbacks.onSignalingStatus?.(message.status);
        return;
      }
      case 'dormant': {
        if (message.startId !== activeStartId) {
          return;
        }
        setQualityState(message.isDormant ? 'dormant' : 'ready');
        callbacks.onDormant?.(message.isDormant);
        return;
      }
      case 'upgrade_outcome':
        if (message.startId !== activeStartId) {
          return;
        }
        callbacks.onUpgradeOutcome?.(message.report);
        return;
      case 'shutdown_complete':
        finishShutdown();
        return;
    }
  }

  // SABs are shared, not transferred. The wake port is transferred: it is the
  // transport worker's end of the worker-to-worker channel, and a port has
  // exactly one owner realm.
  worker.postMessage(
    {
      kind: 'init',
      frameRing: rings.frameRing,
      viewerOutputRing: rings.viewerOutputRing,
      inputRing: rings.inputRing,
      predictionAdmission: rings.predictionAdmission,
      presentationCadence: rings.presentationCadence,
      displayReceiverProfile: rings.displayReceiverProfile,
      perfRing: rings.transportPerfRing,
      perfEnabled: isTerminalPerfRecording(),
      perfObservationEpoch: terminalPerfObservationEpoch(),
      ringWakePort: rings.transportRingWakePort,
      displayRingWakeMode: rings.displayRingWakeMode,
    } satisfies MainToTransport,
    [rings.transportRingWakePort],
  );

  // Three call sites need the same writer/interner lookup and the same null
  // handling, so the lookup lives here rather than being repeated.
  function emitTransportStateEvent(
    state: 'connected' | 'disconnected' | 'signaling_connected' | 'signaling_reconnecting',
    reason: string | undefined,
  ): void {
    const writer = mainPerfWriter();
    const interner = mainPerfInterner();
    if (writer === null || interner === null) return;
    emitTransportState(writer, terminalPerfNowMs(), state, interner.intern(reason));
  }

  // ── DOM hint sources (network / wake / visibility) live on main ────────────
  let networkMon: NetworkMonitor | null = null;
  let wakeDetector: WakeDetector | null = null;
  let persistListenersAttached = false;

  // Recovery, unconditional on every engine: WebKit may drop an Atomics
  // notification while workers are suspended, so every parked SAB pump gets
  // its native notify and its task hint here, whichever arm it is on.
  function wakeSabPumps(): void {
    wakeInputRingReader(rings.inputRing);
    wakeFrameRingReader(rings.frameRing);
    postInputAvailable();
    callbacks.onRecoverDisplayReader?.();
  }

  const onPersistVisibilityChange = (): void => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      post({ kind: 'hint', hint: 'persist_on_hide' });
    }
  };
  const onPersistPageHide = (): void => {
    post({ kind: 'hint', hint: 'persist_on_hide' });
  };

  /**
   * Page Lifecycle freeze/resume.
   *
   * The gap this closes is the frozen -> hidden transition, where no
   * `visibilitychange` fires and the wake detector cannot help: it polls on a
   * timer that does not advance while the process is frozen, and it refuses to
   * act on a hidden document anyway. So a PWA that was frozen for ten minutes
   * comes back believing it is still inside a 60 s rebind window the edge and
   * daemon retired long ago, and spends the whole silent-attempt budget proving
   * otherwise.
   *
   * `Date.now()` on purpose: this measures wall time across an interval in
   * which the process was not running, which is exactly what a monotonic clock
   * is specified not to include.
   *
   * `freeze` posts nothing — it can only be entered from `hidden`, so
   * `onPersistVisibilityChange` has already flushed the snapshot, and a second
   * post would duplicate that write for no new coverage.
   */
  let frozenAtMs: number | null = null;
  const onPageFreeze = (): void => {
    frozenAtMs = Date.now();
  };
  const onPageResume = (): void => {
    const frozenAt = frozenAtMs;
    frozenAtMs = null;
    if (frozenAt === null) return;
    const suspendedMs = Date.now() - frozenAt;
    if (!Number.isFinite(suspendedMs) || suspendedMs < 0) return;
    post({ kind: 'page_resumed', suspendedMs });
  };

  function attachHintSources(): void {
    networkMon = createNetworkMonitor((event) => {
      if (event.kind === 'offline') {
        post({ kind: 'hint', hint: 'offline' });
        return;
      }
      post({ kind: 'hint', hint: 'network_change' });
    });
    wakeDetector = createWakeDetector(() => {
      wakeSabPumps();
      post({ kind: 'hint', hint: 'wake' });
    });
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onPersistVisibilityChange);
      window.addEventListener('pagehide', onPersistPageHide);
      document.addEventListener('freeze', onPageFreeze);
      document.addEventListener('resume', onPageResume);
      persistListenersAttached = true;
    }
  }

  function detachHintSources(): void {
    networkMon?.destroy();
    networkMon = null;
    wakeDetector?.destroy();
    wakeDetector = null;
    if (persistListenersAttached && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onPersistVisibilityChange);
      window.removeEventListener('pagehide', onPersistPageHide);
      document.removeEventListener('freeze', onPageFreeze);
      document.removeEventListener('resume', onPageResume);
    }
    frozenAtMs = null;
    persistListenersAttached = false;
  }

  return {
    start(daemonId: string, signal?: AbortSignal): Promise<void> {
      if (workerFailure !== null) return Promise.reject(workerFailure);
      if (closing || terminated) return Promise.reject(new Error('Transport worker is closed'));
      if (signal?.aborted === true) {
        return Promise.reject(
          signal.reason instanceof Error ? signal.reason : new Error('Session start cancelled'),
        );
      }
      detachHintSources();
      attachHintSources();
      setQualityState('connecting');
      if (pendingStart !== null) {
        const superseded = pendingStart;
        pendingStart = null;
        superseded.reject(new Error('Session start superseded by a newer start'));
      }
      abortSessionRequests();
      const startId = nextStartId;
      nextStartId = nextStartId >= Number.MAX_SAFE_INTEGER ? 1 : nextStartId + 1;
      activeStartId = startId;
      const browserPeerId = crypto.randomUUID();
      const browserAuthorization = server.getBrowserAuthorization();
      if (
        browserAuthorization.userId.length === 0 ||
        browserAuthorization.delegationId.length === 0
      ) {
        return Promise.reject(new Error('Browser delegation is unavailable'));
      }
      if (isTerminalPerfRecording()) {
        const writer = mainPerfWriter();
        const interner = mainPerfInterner();
        if (writer !== null && interner !== null) {
          emitSessionStart(writer, terminalPerfNowMs());
        }
      }
      // Pause the SAB producer until the worker has synchronously fenced any
      // displaced start and explicitly publishes input_ready for this id.
      acceptingInput = false;
      // Prediction grants are authenticated-lineage scoped. Rotate before the
      // worker can accept any input for this start; old terminal-worker grants
      // and queued reconnect input therefore fail closed automatically.
      writer.beginPredictionLineage();
      return new Promise<void>((resolve, reject) => {
        const cleanupAbort = (): void => {
          signal?.removeEventListener('abort', abortStart);
        };
        const resolveOwned = (): void => {
          cleanupAbort();
          resolve();
        };
        const rejectOwned = (error: Error): void => {
          cleanupAbort();
          reject(error);
        };
        const abortStart = (): void => {
          if (pendingStart?.startId !== startId || activeStartId !== startId) return;
          const owned = pendingStart;
          pendingStart = null;
          activeStartId = null;
          acceptingInput = false;
          abortSessionRequests();
          setQualityState('closed');
          // Preserve input and any pre-adoption issuance identity. The next
          // Effect retry fences this stop with a newer startId and either
          // retries the unknown request idempotently or supersedes an adopted
          // dead rendezvous.
          post({ kind: 'stop_session', preserveInput: true });
          owned.reject(
            signal?.reason instanceof Error ? signal.reason : new Error('Session start cancelled'),
          );
        };
        // Publish ownership before postMessage. Real workers are asynchronous,
        // but this ordering also makes synchronous worker test doubles and
        // future in-process adapters unable to beat resolver installation.
        pendingStart = { startId, resolve: resolveOwned, reject: rejectOwned };
        signal?.addEventListener('abort', abortStart, { once: true });
        post({
          kind: 'start',
          startId,
          daemonId,
          browserPeerId,
          userId: browserAuthorization.userId,
          delegationId: browserAuthorization.delegationId,
          perfEnabled: isTerminalPerfRecording(),
          perfObservationEpoch: terminalPerfObservationEpoch(),
        });
      });
    },

    isAcceptingInput(): boolean {
      return acceptingInput;
    },
    sendKeystroke(
      input: Uint8Array,
      inputAtMs = terminalPerfNowMs(),
      classifyShadowModelled?: (inputSeq: number) => boolean,
      delivery: InputDelivery = INPUT_AWAITED,
    ): number | null {
      if (!acceptingInput) return null;
      // Synchronous end-to-end admission includes both entries already in the
      // worker outbox and entries still resident in this ring. A separate entry
      // cap prevents one-byte keypresses from defeating the byte bound through
      // per-frame object overhead. A refusal releases deferred input: held
      // entries are only freed by the acknowledgement their sending earns.
      if (
        writer.bufferedBytes() + input.byteLength > MAX_BUFFERED_INPUT_BYTES ||
        writer.bufferedEntries() >= MAX_BUFFERED_INPUT_ENTRIES
      ) {
        writer.releaseDeferred();
        return null;
      }
      if (nextInputSeq > MAX_INPUT_SEQ) return null;
      const seq = nextInputSeq++;
      if (!writer.write(seq, input, classifyShadowModelled, delivery === INPUT_DEFERRED)) {
        // Ring full while the budget gate hasn't caught up: roll the seq back so
        // we don't leave a gap, and skip the prediction (the worker's overflow
        // disconnect is the real backstop under sustained backpressure).
        nextInputSeq = seq;
        writer.releaseDeferred();
        return null;
      }
      // Sole producer of `input_queued`. Admission time here is the start of
      // user-perceived input latency; the transport worker sees the same
      // keystroke only after it drains the ring, so emitting there too recorded
      // one fact twice under one identity and left the analyzer to discard the
      // later copy. Its `input_sent` already marks the wire moment.
      if (delivery === INPUT_AWAITED && isTerminalPerfRecording()) {
        const writer = mainPerfWriter();
        if (writer !== null) {
          emitInputQueued(writer, inputAtMs, terminalPerfNowMs(), seq, input.byteLength);
        }
      }
      return seq;
    },

    releaseDeferredInput(): void {
      writer.releaseDeferred();
    },

    sendResize(cols: number, rows: number, cellWidth: number, cellHeight: number): void {
      post({ kind: 'resize', cols, rows, cellWidth, cellHeight });
    },

    takeGeometryControl(): void {
      post({ kind: 'take_geometry_control' });
    },

    setWindowFocused(focused: boolean): void {
      post({ kind: 'window_focus', focused });
    },

    requestDisplaySnapshot(): void {
      post({ kind: 'request_snapshot' });
    },

    notifyResumed(): void {
      // WebKit may drop an Atomics notification while workers are suspended.
      // Wake every parked SAB pump directly before sending the semantic hint;
      // the coarse ring watchdog remains only a last-resort backstop.
      wakeSabPumps();
      post({ kind: 'hint', hint: 'visibility_resume' });
    },

    sendTransportHint(hint: TransportHintParams): void {
      // Main's tuple is incomplete: receive capacity and display cadence live
      // in the transport/terminal workers. Forward equal ~2s observations and
      // let transport deduplicate only after sampling those two atomic values.
      post({ kind: 'transport_hint', hint });
    },

    getConnectionQuality(): ConnectionQuality {
      return quality;
    },

    onConnectionQualityChange(listener: () => void): () => void {
      qualityListeners.add(listener);
      return () => {
        qualityListeners.delete(listener);
      };
    },

    getThroughput(): { readonly txBytes: number; readonly rxBytes: number } {
      throughput.txBytes = txBytes;
      throughput.rxBytes = rxBytes;
      return throughput;
    },

    onTransportActivity(
      listener: (snapshot: LinkActivitySnapshot) => void,
      columns: number,
    ): () => void {
      const subscriber = { listener, columns };
      activityListeners.push(subscriber);
      updateLinkSubscription();
      return () => {
        const index = activityListeners.indexOf(subscriber);
        if (index < 0) return;
        activityListeners.splice(index, 1);
        updateLinkSubscription();
      };
    },

    close(): void {
      detachHintSources();
      if (closing || terminated) return;
      closing = true;
      if (observedRecovery !== null) {
        const { outcome, atMs } = observedRecovery;
        const now = terminalPerfNowMs();
        recordRecovery(
          {
            ...outcome,
            endReason: 'owner_cancelled',
            cancellationInitiator: 'owner',
            durationMs: outcome.durationMs + Math.max(0, now - atMs),
          },
          now,
        );
        observedRecovery = null;
      }
      activityListeners.length = 0;
      updateLinkSubscription();
      activeStartId = null;
      abortSessionRequests();
      abandonSessionIssuances();
      acceptingInput = false;
      if (pendingStart !== null) {
        const { reject } = pendingStart;
        pendingStart = null;
        reject(new Error('Session closed'));
      }
      setQualityState('closed');
      post({ kind: 'stop_session', preserveInput: false });
      post({ kind: 'shutdown' });
      // Terminate on the worker's shutdown_complete ack (handleWorkerMessage →
      // finishShutdown), or after the grace timeout if it never arrives.
      shutdownTimer = setTimeout(finishShutdown, WORKER_SHUTDOWN_GRACE_MS);
    },
  };
}

function readSessionIssuanceErrorCode(error: unknown): SessionIssuanceErrorCode | undefined {
  if (!isApiError(error)) return undefined;
  if (error.status === 401 || error.status === 403) return 'authorization_rejected';
  if (error.status === 404) return 'daemon_unlinked';
  if (
    error.code === 'invalid_session_response' ||
    error.code === 'session_issuance_cancelled' ||
    error.code === 'session_issuance_conflict' ||
    error.code === 'session_issuance_expired'
  ) {
    return error.code;
  }
  if (error.status !== 0 && error.status !== 408 && error.status !== 429 && error.status < 500)
    return 'request_rejected';
  return undefined;
}

function sessionRpcErrorFields(error: unknown): { errorCode?: SessionIssuanceErrorCode } {
  const errorCode = readSessionIssuanceErrorCode(error);
  return errorCode === undefined ? {} : { errorCode };
}
