import { waitForProcessSignal } from '@merkur/shared/node-signals';
import { Clock, type Deferred, Effect, Fiber, Metric, Queue, Redacted, type Scope } from 'effect';
import { ensureOpenUrlCommandsEffect } from '../cli/open';
import {
  type DaemonConfig,
  ensureShellTokenEffect,
  publicWebtransportEndpoint,
  shellTokenPath as shellTokenPathValue,
} from '../config';
import { type Logger, logEffect } from '../logger';
import {
  type DaemonControlPathSignal,
  type DaemonControlSuperseded,
  runDaemonControlClientEffect,
} from './daemon-control-client';
import {
  DaemonHealthServiceTag,
  daemonIpv6Reachability,
  daemonNatMappingOutcomes,
  daemonObservabilitySnapshot,
  runDaemonObservabilityReporterEffect,
} from './daemon-metrics';
import { createDaemonPerfSender, runDaemonPerfReporterEffect } from './daemon-perf-reporter';
import type { createDaemonProofSigner, DaemonProofSigningClient } from './daemon-proof-signer';
import {
  createDataplaneClientLayer,
  type DataplaneClient,
  DataplaneClientService,
  type DataplaneConfig,
  type DataplaneHandlers,
} from './dataplane-client';
import { serveProfileSocketScoped } from './profile-socket';
import { createTerminalBellReporterScoped } from './terminal-bell-reporter';

const FINAL_TRANSPORT_CAPTURE_TIMEOUT_MS = 5_000;
const FINAL_TRANSPORT_CAPTURE_POLL_MS = 5;

export interface DaemonRuntimeOptions {
  /** See `DaemonControlClientOptions.shutdownIntent`. */
  readonly shutdownIntent?: Deferred.Deferred<void>;
  /** Test-harness-only SIGUSR2 capture of one final owner-loop transport sample. */
  readonly enableFinalTransportCapture?: boolean;
  /**
   * Ends span export: its final flush, then no more. Run while the signer is still bound to the
   * dataplane, since every export is signed; afterwards an export could only fail and retry.
   */
  readonly retireTelemetry?: Effect.Effect<void>;
}

/**
 * Binds the proof signer to this dataplane for the scope's life. Span export ends first, while
 * an export can still be signed: its final flush is delivered, and nothing is left to retry
 * unsigned once the binding is released.
 */
export function bindDaemonSignerScoped(
  signer: ReturnType<typeof createDaemonProofSigner>,
  client: DaemonProofSigningClient,
  retireTelemetry: Effect.Effect<void>,
): Effect.Effect<void, never, Scope.Scope> {
  return Effect.asVoid(
    Effect.acquireRelease(
      Effect.sync(() => signer.bind(client)),
      (unbind) => retireTelemetry.pipe(Effect.andThen(Effect.sync(unbind))),
    ),
  );
}

export function runDaemonRuntimeEffect(
  config: DaemonConfig,
  logger: Logger,
  signer: ReturnType<typeof createDaemonProofSigner>,
  options: DaemonRuntimeOptions = {},
): Effect.Effect<never, Error, DaemonHealthServiceTag> {
  return Effect.scoped(
    Effect.gen(function* () {
      const daemonIdentityMaterial = Redacted.make(config.daemon_identity_seal.material);
      // Established before the dataplane starts, because the sidecar reads the
      // token once at startup to seed both the PTY environment and its OSC
      // verifier. Failure here costs the authenticated form of the prompt
      // boundary and nothing else, so it is logged and carried rather than
      // failing the daemon: a terminal that works without local echo is very
      // much better than no terminal.
      const shellTokenPath = yield* ensureShellTokenEffect().pipe(
        Effect.tapError((error) =>
          logEffect('warn', 'daemon', 'shell_token_unavailable', {
            error: String(error),
          }),
        ),
        Effect.as(shellTokenPathValue()),
        Effect.orElseSucceed(() => null),
      );
      // Same standing as the token: without the helper, `$BROWSER` inside the
      // terminal is simply unset, and everything else works.
      const openUrlBinDir = yield* ensureOpenUrlCommandsEffect().pipe(
        Effect.tapError((error) =>
          logEffect('warn', 'daemon', 'open_url_commands_unavailable', {
            error: String(error),
          }),
        ),
        Effect.orElseSucceed(() => null),
      );
      const health = yield* DaemonHealthServiceTag;
      const observabilityReporter = yield* runDaemonObservabilityReporterEffect(
        config.daemon_id,
      ).pipe(Effect.forkScoped({ startImmediately: true }));
      // The 30-second stdout health snapshot above is retained deliberately: it
      // is the daemon's only observability when the server is unreachable, which
      // is exactly when it matters most. This reporter is additive.
      const perfReporter = yield* runDaemonPerfReporterEffect(
        createDaemonPerfSender(config, signer),
      ).pipe(Effect.forkScoped({ startImmediately: true }));
      const outcome = yield* Effect.scoped(
        Effect.gen(function* () {
          const terminalBellReporter = yield* createTerminalBellReporterScoped(
            config,
            logger,
            signer,
          );
          // Process-lifetime, so a signal observed between carriers is not lost
          // with the connection scope that happened to be open at the time.
          const pathSignals = yield* Queue.sliding<DaemonControlPathSignal>(1);
          return yield* Effect.gen(function* () {
            const dataplaneClient = yield* DataplaneClientService;
            yield* bindDaemonSignerScoped(
              signer,
              dataplaneClient,
              options.retireTelemetry ?? Effect.void,
            );
            yield* serveProfileSocketScoped(config.daemon_id, dataplaneClient);
            if (options.enableFinalTransportCapture === true) {
              yield* Effect.forever(
                waitForProcessSignal(['SIGUSR2']).pipe(
                  Effect.flatMap(() =>
                    captureFinalTransportEvidence(config.daemon_id, dataplaneClient),
                  ),
                  Effect.catchCause((cause) =>
                    logEffect('error', 'daemon', 'daemon_transport_capture_failed', {
                      cause: String(cause),
                    }),
                  ),
                ),
              ).pipe(Effect.forkScoped({ startImmediately: true }));
            }
            // This is the critical owner fiber, not a detached background task:
            // defects and terminal dataplane failures fail the runtime, while
            // the typed superseded outcome closes the dataplane scope before
            // the process becomes dormant. Joining the reporter makes an
            // unexpected observability defect equally visible.
            return yield* superviseCriticalDaemonEffects(
              runDaemonControlClientEffect(config, dataplaneClient, {
                health,
                pathSignals,
                shutdownIntent: options.shutdownIntent,
              }),
              dataplaneClient.awaitCriticalFailure().pipe(
                Effect.tapError((error) =>
                  logEffect(
                    'error',
                    'daemon',
                    error.reason === 'identity_unsealable'
                      ? 'daemon_identity_unsealable'
                      : 'dataplane_terminal_failure',
                    {
                      ...(error.reason === 'identity_unsealable'
                        ? { hint: 're-link this machine' }
                        : {}),
                      reason: error.reason,
                    },
                  ),
                ),
              ),
              terminalBellReporter.awaitCriticalFailure().pipe(
                Effect.tapError((error) =>
                  logEffect('error', 'daemon', 'bell_reporter_terminal_failure', {
                    reason: error.reason,
                  }),
                ),
              ),
              Fiber.join(observabilityReporter),
              Fiber.join(perfReporter),
            );
          }).pipe(
            // Its own scope, inside the dataplane layer's: what this binds to the dataplane
            // (the signer, the final span flush) is released while the dataplane still runs.
            Effect.scoped,
            Effect.provide(
              createDataplaneClientLayer(
                dataplaneConfig(
                  config,
                  daemonIdentityMaterial,
                  shellTokenPath,
                  openUrlBinDir,
                  publicWebtransportEndpoint(),
                ),
                logger,
                dataplaneHandlers(logger, terminalBellReporter.reportBell, pathSignals),
                {
                  updateHealth: health.updateDataplane,
                },
              ),
            ),
          );
        }),
      );

      yield* Fiber.interrupt(observabilityReporter);
      yield* logEffect('warn', 'daemon', 'daemon_runtime_control_terminal', {
        outcome: outcome._tag,
      });
      // Stay alive so launchd/systemd cannot immediately restart this old
      // process and supersede the replacement connection in a loop. The outer
      // signal supervisor can still interrupt this dormant runtime normally.
      return yield* Effect.never;
    }),
  );
}

export function superviseCriticalDaemonEffects<E, E2>(
  control: Effect.Effect<DaemonControlSuperseded>,
  dataplaneCriticalFailure: Effect.Effect<never, E>,
  bellCriticalFailure: Effect.Effect<never, E2>,
  observabilityReporter: Effect.Effect<never>,
  perfReporter: Effect.Effect<never>,
): Effect.Effect<DaemonControlSuperseded, E | E2> {
  return Effect.raceFirst(
    Effect.raceFirst(
      Effect.raceFirst(Effect.raceFirst(control, dataplaneCriticalFailure), bellCriticalFailure),
      observabilityReporter,
    ),
    perfReporter,
  );
}

/**
 * Ask the Rust owner loop to close its current partial telemetry window, then
 * wait until the daemon's serialized metric worker has applied that exact
 * sample before logging the bounded final snapshot. The Rust event precedes
 * its correlated command acknowledgement on one FIFO event sink; polling here
 * only bridges the deliberately asynchronous metric worker.
 */
export function captureFinalTransportEvidence(
  daemonId: string,
  dataplaneClient: DataplaneClient,
): Effect.Effect<void, never, DaemonHealthServiceTag> {
  return Effect.gen(function* () {
    const captureRequestedAtMs = yield* Clock.currentTimeMillis;
    const commandId = `transport-final-${captureRequestedAtMs}`;
    const result = yield* dataplaneClient.captureTransportStatsEffect(commandId);
    if (result.status !== 'accepted') {
      yield* logEffect('error', 'daemon', 'daemon_transport_capture_failed', {
        captureRequestedAtMs,
        reason: result.reason,
      });
      return;
    }

    const deadlineAtMs = captureRequestedAtMs + FINAL_TRANSPORT_CAPTURE_TIMEOUT_MS;
    while (true) {
      const snapshot = yield* daemonObservabilitySnapshot;
      const transport = snapshot.metrics.latestDataplaneTransport;
      if (transport !== null && transport.observedAtMs >= captureRequestedAtMs) {
        const captureCompletedAtMs = yield* Clock.currentTimeMillis;
        yield* logEffect('info', 'daemon', 'daemon_transport_capture_complete', {
          daemonId,
          captureRequestedAtMs,
          captureCompletedAtMs,
          ...snapshot,
        });
        return;
      }
      if ((yield* Clock.currentTimeMillis) >= deadlineAtMs) {
        yield* logEffect('error', 'daemon', 'daemon_transport_capture_failed', {
          captureRequestedAtMs,
          reason: 'fresh_sample_timeout',
        });
        return;
      }
      yield* Effect.sleep(`${FINAL_TRANSPORT_CAPTURE_POLL_MS} millis`);
    }
  });
}

function dataplaneHandlers(
  logger: Logger,
  reportBell: () => void,
  pathSignals: Queue.Enqueue<DaemonControlPathSignal>,
): DataplaneHandlers {
  return {
    onNatMappingOutcome(outcome: string): void {
      // Fire-and-forget on the synchronous IPC frame handler, which must not
      // block. The label is already validated against a closed set by the
      // caller, so this cannot inflate metric cardinality.
      Effect.runFork(Metric.update(daemonNatMappingOutcomes, outcome));
    },
    onNetworkPathChanged(coalescedEvents: number): void {
      logger.info('network_path_changed', { coalescedEvents });
      // Sliding(1): `offerUnsafe` never blocks and never fails, and "the path
      // changed recently" is idempotent, so collapsing a burst is correct. This
      // runs on the synchronous IPC frame handler, which must not block.
      Queue.offerUnsafe(pathSignals, { coalescedEvents });
    },
    onSidecarExited(reason: string): void {
      logger.warn('dataplane_connection_state_reset', { reason });
    },
    onPtyReady(pid: number): void {
      logger.info('pty_ready', { pid });
    },
    onPtyClosed(exitCode: number, signal: number): void {
      logger.info('pty_closed', { exitCode, signal });
    },
    onBell: reportBell,
    onPeerDisconnected(peerNodeId: string, reason: string): void {
      logger.info('peer_disconnected', { peerNodeId, reason });
    },
    onError(message: string): void {
      logger.error('dataplane_error', { message });
    },
    onWebTransportReady(
      port: number,
      certHash: string,
      candidates: Array<{ addr: string; port: number; kind: string }>,
      ipv6Reachability: string,
    ): void {
      logger.info('webtransport_ready', {
        port,
        certHash,
        candidateCount: candidates.length,
        candidates,
        ipv6Reachability,
      });
      // Fire-and-forget on the synchronous IPC frame handler, which must not
      // block — the same shape as `onNatMappingOutcome`. The label comes from
      // `Ipv6Reachability::as_str`, a closed set, so this cannot inflate metric
      // cardinality.
      Effect.runFork(Metric.update(daemonIpv6Reachability, ipv6Reachability));
    },
    onPeerAuthenticated(peerNodeId: string, browserNodeId: string, sessionId: string): void {
      logger.info('peer_authenticated', {
        peerNodeId,
        browserNodeId,
        sessionId,
      });
    },
  };
}

function dataplaneConfig(
  config: DaemonConfig,
  daemonIdentityMaterial: Redacted.Redacted<string>,
  shellTokenPath: string | null,
  openUrlBinDir: string | null,
  publicWebtransportEndpoint: string | null,
): DataplaneConfig {
  return {
    session_token_verify_key: config.session_token_verify_key,
    webtransport_port: config.webtransport_port,
    daemon_id: config.daemon_id,
    daemon_identity_seal: {
      backend: config.daemon_identity_seal.backend,
      material: Redacted.value(daemonIdentityMaterial),
    },
    server_origin: config.server_origin,
    user_root_public_key: config.user_root_public_key,
    root_epoch: config.root_epoch,
    daemon_binding: config.daemon_binding,
    revoked_delegations: config.revoked_delegations,
    shell: config.shell,
    shell_token_path: shellTokenPath,
    open_url_bin_dir: openUrlBinDir,
    public_wt_endpoint: publicWebtransportEndpoint,
  };
}
