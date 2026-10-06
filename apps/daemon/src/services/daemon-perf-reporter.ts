import { treaty } from '@elysia/eden';
import type { App } from '@merkur/server';
import { type Duration, Effect } from 'effect';
import type { DaemonConfig } from '../config';
import { logEffect } from '../logger';
import { createDaemonFetch } from './daemon-fetch';
import {
  type DaemonHealthServiceTag,
  type DaemonMetricSnapshot,
  daemonObservabilitySnapshot,
  drainControlPingRtt,
  drainSuspensionGapMsMax,
} from './daemon-metrics';
import type { DaemonProofSigner } from './daemon-proof-signer';

const DEFAULT_REPORT_INTERVAL = '60 seconds';

/**
 * One reporting window, expressed as deltas against the previous window.
 *
 * Deltas rather than cumulative totals because the daemon's Effect counters
 * reset with its process: shipping cumulative values would make the
 * corresponding server counters run backwards after every daemon restart.
 */
export interface DaemonPerfReport {
  readonly windowMs: number;
  readonly controlPingPonged: number;
  readonly controlPingTimeout: number;
  readonly controlPingSendFailed: number;
  readonly controlPingSuspended: number;
  readonly controlReconnects: number;
  readonly registrationFailures: number;
  readonly dataplaneRestarts: number;
  readonly dataplaneAckTimeouts: number;
  readonly dataplaneReady: number;
  readonly suspensionGapMsMax: number;
  readonly pingRttCount: number;
  readonly pingRttP50Ms: number;
  readonly pingRttP95Ms: number;
  readonly pingRttMaxMs: number;
  /**
   * Inbound connections that reached the direct-WebTransport listener in this
   * window, split by whether an offer recently named the source address, and how
   * many completed the authenticated upgrade.
   *
   * These exist because the browser's upgrade report cannot answer the question
   * that decides the direct path's future: a browser that dialled a candidate
   * and heard nothing cannot tell a firewall from a daemon that was not
   * listening. Only the daemon can.
   *
   * The split is what makes the answer legible. A single arrival count is
   * dominated by internet background scanning of a public UDP port — roughly
   * 300,000 arrivals a day against about a hundred upgrade attempts — so the
   * intended reading was never available. Browsers dialling while
   * `directWtIncomingExpected` stays zero is a firewall verdict; expected
   * connections arriving that are never admitted is a Merkur bug.
   */
  readonly directWtIncomingExpected: number;
  readonly directWtIncomingUnexpected: number;
  readonly directWtAdmitted: number;
  readonly natKeepalivesSent: number;
  readonly natPunchBurstsSent: number;
  readonly natPunchRefusedNotGlobal: number;
  readonly natPunchRefusedRateLimited: number;
  readonly natSideChannelSendFailures: number;
  /**
   * The carrier-rebind slice.
   *
   * A rebind recovers a session without a server round trip; a refused one
   * costs a full re-authentication and about two seconds of covered terminal.
   * Both were invisible off-machine — the dataplane's own registry only leaves
   * the host when an operator has configured a daemon-side OTLP endpoint — so a
   * fleet-wide reconnect regression could only be inferred from the browser's
   * side, which cannot see WHY a rebind was refused.
   *
   * `requests` is every attempt that reached the flow; `envelopesRejected` is
   * the ones dropped before it. `committed` is the only one that actually
   * recovered a session. `eventsSuppressed` keeps a flood observable even when
   * per-attempt diagnostics hit their emission bound.
   */
  readonly rebindRequests: number;
  readonly rebindAccepted: number;
  readonly rebindRefused: number;
  readonly rebindCommitted: number;
  readonly rebindEnvelopesRejected: number;
  readonly rebindEventsSuppressed: number;
  /**
   * The display-waste slice, and the reason it is worth a place in a 60-second
   * window that is otherwise about the control plane.
   *
   * These four counters answer "how much of what this daemon put on the wire
   * rendered nothing", and the dataplane has computed them all along — they
   * were folded into the daemon's own Effect registry and then never left the
   * machine, because that registry is only exported when an operator has
   * configured a daemon-side OTLP endpoint. So the fleet had no view of the
   * quantity that decides whether a full-screen change settles in one round
   * trip or in a second, and diagnosing it meant reconstructing the ratio from
   * browser-side frame sizes.
   *
   * `rowVersionsSent` is the denominator: without it the other three are counts
   * that cannot be turned into a rate, and a rate is the only form in which
   * they mean anything.
   */
  readonly rowVersionsSent: number;
  readonly rowVersionsSupersededUnapplied: number;
  readonly rowResendsIdentical: number;
  readonly resyncRowsRequested: number;
  readonly fecRepairsSent: number;
  readonly fecRepairsRefused: number;
  /**
   * Receiver-classified display-datagram outcomes, split by sole carrier.
   *
   * For either path, `received + recoveredByFec + declaredLost` is the
   * classified denominator. Pre-repair erasure is `(recoveredByFec +
   * declaredLost) / classified`; residual loss is `declaredLost / classified`.
   * Unknown is excluded and reports how much evidence was censored by the
   * bounded provenance window. Reliable, refused and dual-sent frames enter no
   * bucket.
   */
  readonly directDisplayDatagramsReceived: number;
  readonly directDisplayDatagramsRecoveredByFec: number;
  readonly directDisplayDatagramsDeclaredLost: number;
  readonly directDisplayDatagramsOutcomeUnknown: number;
  readonly edgeDisplayDatagramsReceived: number;
  readonly edgeDisplayDatagramsRecoveredByFec: number;
  readonly edgeDisplayDatagramsDeclaredLost: number;
  readonly edgeDisplayDatagramsOutcomeUnknown: number;
  readonly rowsDeclaredLost: number;
}

/** The previous window's cumulative readings. */
export interface DaemonPerfCursor {
  readonly pingOutcomes: Readonly<Record<string, number>>;
  readonly reconnectOutcomes: Readonly<Record<string, number>>;
  readonly registrationOutcomes: Readonly<Record<string, number>>;
  readonly dataplaneRestartOutcomes: Readonly<Record<string, number>>;
  readonly dataplaneAckTimeouts: number;
  readonly directWtIncomingExpected: number;
  readonly directWtIncomingUnexpected: number;
  readonly directWtAdmitted: number;
  readonly natKeepalivesSent: number;
  readonly natPunchBurstsSent: number;
  readonly natPunchRefusedNotGlobal: number;
  readonly natPunchRefusedRateLimited: number;
  readonly natSideChannelSendFailures: number;
  readonly rebindRequests: number;
  readonly rebindAccepted: number;
  readonly rebindRefused: number;
  readonly rebindCommitted: number;
  readonly rebindEnvelopesRejected: number;
  readonly rebindEventsSuppressed: number;
  readonly rowVersionsSent: number;
  readonly rowVersionsSupersededUnapplied: number;
  readonly rowResendsIdentical: number;
  readonly resyncRowsRequested: number;
  readonly fecRepairsSent: number;
  readonly fecRepairsRefused: number;
  readonly directDisplayDatagramsReceived: number;
  readonly directDisplayDatagramsRecoveredByFec: number;
  readonly directDisplayDatagramsDeclaredLost: number;
  readonly directDisplayDatagramsOutcomeUnknown: number;
  readonly edgeDisplayDatagramsReceived: number;
  readonly edgeDisplayDatagramsRecoveredByFec: number;
  readonly edgeDisplayDatagramsDeclaredLost: number;
  readonly edgeDisplayDatagramsOutcomeUnknown: number;
  readonly rowsDeclaredLost: number;
}

export const EMPTY_DAEMON_PERF_CURSOR: DaemonPerfCursor = {
  pingOutcomes: {},
  reconnectOutcomes: {},
  registrationOutcomes: {},
  dataplaneRestartOutcomes: {},
  dataplaneAckTimeouts: 0,
  directWtIncomingExpected: 0,
  directWtIncomingUnexpected: 0,
  directWtAdmitted: 0,
  natKeepalivesSent: 0,
  natPunchBurstsSent: 0,
  natPunchRefusedNotGlobal: 0,
  natPunchRefusedRateLimited: 0,
  natSideChannelSendFailures: 0,
  rebindRequests: 0,
  rebindAccepted: 0,
  rebindRefused: 0,
  rebindCommitted: 0,
  rebindEnvelopesRejected: 0,
  rebindEventsSuppressed: 0,
  rowVersionsSent: 0,
  rowVersionsSupersededUnapplied: 0,
  rowResendsIdentical: 0,
  resyncRowsRequested: 0,
  directDisplayDatagramsReceived: 0,
  directDisplayDatagramsRecoveredByFec: 0,
  directDisplayDatagramsDeclaredLost: 0,
  directDisplayDatagramsOutcomeUnknown: 0,
  edgeDisplayDatagramsReceived: 0,
  edgeDisplayDatagramsRecoveredByFec: 0,
  edgeDisplayDatagramsDeclaredLost: 0,
  edgeDisplayDatagramsOutcomeUnknown: 0,
  rowsDeclaredLost: 0,
  fecRepairsSent: 0,
  fecRepairsRefused: 0,
};

export function daemonPerfCursor(metrics: DaemonMetricSnapshot): DaemonPerfCursor {
  return {
    pingOutcomes: metrics.controlPingOutcomes,
    reconnectOutcomes: metrics.controlReconnectOutcomes,
    registrationOutcomes: metrics.controlRegistrationOutcomes,
    dataplaneRestartOutcomes: metrics.dataplaneRestartOutcomes,
    dataplaneAckTimeouts: metrics.dataplaneAckTimeouts,
    directWtIncomingExpected: metrics.dataplaneTransport.directWtIncomingExpected,
    directWtIncomingUnexpected: metrics.dataplaneTransport.directWtIncomingUnexpected,
    directWtAdmitted: metrics.dataplaneTransport.directWtAdmitted,
    natKeepalivesSent: metrics.dataplaneTransport.natKeepalivesSent,
    natPunchBurstsSent: metrics.dataplaneTransport.natPunchBurstsSent,
    natPunchRefusedNotGlobal: metrics.dataplaneTransport.natPunchRefusedNotGlobal,
    natPunchRefusedRateLimited: metrics.dataplaneTransport.natPunchRefusedRateLimited,
    natSideChannelSendFailures: metrics.dataplaneTransport.natSideChannelSendFailures,
    rebindRequests: metrics.dataplaneTransport.rebindRequests,
    rebindAccepted: metrics.dataplaneTransport.rebindAccepted,
    rebindRefused: metrics.dataplaneTransport.rebindRefused,
    rebindCommitted: metrics.dataplaneTransport.rebindCommitted,
    rebindEnvelopesRejected: metrics.dataplaneTransport.rebindEnvelopesRejected,
    rebindEventsSuppressed: metrics.dataplaneTransport.rebindEventsSuppressed,
    rowVersionsSent: metrics.dataplaneTransport.rowVersionsSent,
    rowVersionsSupersededUnapplied: metrics.dataplaneTransport.rowVersionsSupersededUnapplied,
    rowResendsIdentical: metrics.dataplaneTransport.rowResendsIdentical,
    resyncRowsRequested: metrics.dataplaneTransport.resyncRowsRequested,
    fecRepairsSent: metrics.dataplaneTransport.fecRepairsSent,
    fecRepairsRefused: metrics.dataplaneTransport.fecRepairsRefused,
    directDisplayDatagramsReceived: metrics.dataplaneTransport.directDisplayDatagramsReceived,
    directDisplayDatagramsRecoveredByFec:
      metrics.dataplaneTransport.directDisplayDatagramsRecoveredByFec,
    directDisplayDatagramsDeclaredLost:
      metrics.dataplaneTransport.directDisplayDatagramsDeclaredLost,
    directDisplayDatagramsOutcomeUnknown:
      metrics.dataplaneTransport.directDisplayDatagramsOutcomeUnknown,
    edgeDisplayDatagramsReceived: metrics.dataplaneTransport.edgeDisplayDatagramsReceived,
    edgeDisplayDatagramsRecoveredByFec:
      metrics.dataplaneTransport.edgeDisplayDatagramsRecoveredByFec,
    edgeDisplayDatagramsDeclaredLost: metrics.dataplaneTransport.edgeDisplayDatagramsDeclaredLost,
    edgeDisplayDatagramsOutcomeUnknown:
      metrics.dataplaneTransport.edgeDisplayDatagramsOutcomeUnknown,
    rowsDeclaredLost: metrics.dataplaneTransport.rowsDeclaredLost,
  };
}

/**
 * A negative delta means the daemon's metric registry restarted underneath the
 * cursor, so the current absolute value *is* the window's activity.
 */
function delta(previous: number | undefined, current: number): number {
  const before = previous ?? 0;
  return current < before ? current : current - before;
}

function sumValues(record: Readonly<Record<string, number>>): number {
  let total = 0;
  for (const value of Object.values(record)) total += value;
  return total;
}

function outcomeDelta(
  previous: Readonly<Record<string, number>>,
  current: Readonly<Record<string, number>>,
  key: string,
): number {
  return delta(previous[key], current[key] ?? 0);
}

export function buildDaemonPerfReport(
  previous: DaemonPerfCursor,
  metrics: DaemonMetricSnapshot,
  windowMs: number,
  pingRtt: { count: number; p50Ms: number; p95Ms: number; maxMs: number },
  suspensionGapMsMax: number,
): DaemonPerfReport {
  const ping = metrics.controlPingOutcomes;
  const previousPing = previous.pingOutcomes;

  return {
    windowMs,
    controlPingPonged: outcomeDelta(previousPing, ping, 'pong'),
    controlPingTimeout: outcomeDelta(previousPing, ping, 'timeout'),
    controlPingSendFailed: outcomeDelta(previousPing, ping, 'send_failed'),
    controlPingSuspended: outcomeDelta(previousPing, ping, 'suspended'),
    controlReconnects: delta(
      sumValues(previous.reconnectOutcomes),
      sumValues(metrics.controlReconnectOutcomes),
    ),
    registrationFailures: delta(
      sumValues(previous.registrationOutcomes),
      sumValues(metrics.controlRegistrationOutcomes),
    ),
    dataplaneRestarts: delta(
      sumValues(previous.dataplaneRestartOutcomes),
      sumValues(metrics.dataplaneRestartOutcomes),
    ),
    dataplaneAckTimeouts: delta(previous.dataplaneAckTimeouts, metrics.dataplaneAckTimeouts),
    dataplaneReady: metrics.dataplaneReady === 1 ? 1 : 0,
    suspensionGapMsMax: Math.max(0, Math.round(suspensionGapMsMax)),
    pingRttCount: pingRtt.count,
    pingRttP50Ms: pingRtt.p50Ms,
    pingRttP95Ms: pingRtt.p95Ms,
    pingRttMaxMs: pingRtt.maxMs,
    directWtIncomingExpected: delta(
      previous.directWtIncomingExpected,
      metrics.dataplaneTransport.directWtIncomingExpected,
    ),
    directWtIncomingUnexpected: delta(
      previous.directWtIncomingUnexpected,
      metrics.dataplaneTransport.directWtIncomingUnexpected,
    ),
    directWtAdmitted: delta(previous.directWtAdmitted, metrics.dataplaneTransport.directWtAdmitted),
    natKeepalivesSent: delta(
      previous.natKeepalivesSent,
      metrics.dataplaneTransport.natKeepalivesSent,
    ),
    natPunchBurstsSent: delta(
      previous.natPunchBurstsSent,
      metrics.dataplaneTransport.natPunchBurstsSent,
    ),
    natPunchRefusedNotGlobal: delta(
      previous.natPunchRefusedNotGlobal,
      metrics.dataplaneTransport.natPunchRefusedNotGlobal,
    ),
    natPunchRefusedRateLimited: delta(
      previous.natPunchRefusedRateLimited,
      metrics.dataplaneTransport.natPunchRefusedRateLimited,
    ),
    natSideChannelSendFailures: delta(
      previous.natSideChannelSendFailures,
      metrics.dataplaneTransport.natSideChannelSendFailures,
    ),
    rebindRequests: delta(previous.rebindRequests, metrics.dataplaneTransport.rebindRequests),
    rebindAccepted: delta(previous.rebindAccepted, metrics.dataplaneTransport.rebindAccepted),
    rebindRefused: delta(previous.rebindRefused, metrics.dataplaneTransport.rebindRefused),
    rebindCommitted: delta(previous.rebindCommitted, metrics.dataplaneTransport.rebindCommitted),
    rebindEnvelopesRejected: delta(
      previous.rebindEnvelopesRejected,
      metrics.dataplaneTransport.rebindEnvelopesRejected,
    ),
    rebindEventsSuppressed: delta(
      previous.rebindEventsSuppressed,
      metrics.dataplaneTransport.rebindEventsSuppressed,
    ),
    rowVersionsSent: delta(previous.rowVersionsSent, metrics.dataplaneTransport.rowVersionsSent),
    rowVersionsSupersededUnapplied: delta(
      previous.rowVersionsSupersededUnapplied,
      metrics.dataplaneTransport.rowVersionsSupersededUnapplied,
    ),
    rowResendsIdentical: delta(
      previous.rowResendsIdentical,
      metrics.dataplaneTransport.rowResendsIdentical,
    ),
    resyncRowsRequested: delta(
      previous.resyncRowsRequested,
      metrics.dataplaneTransport.resyncRowsRequested,
    ),
    fecRepairsSent: delta(previous.fecRepairsSent, metrics.dataplaneTransport.fecRepairsSent),
    fecRepairsRefused: delta(
      previous.fecRepairsRefused,
      metrics.dataplaneTransport.fecRepairsRefused,
    ),
    directDisplayDatagramsReceived: delta(
      previous.directDisplayDatagramsReceived,
      metrics.dataplaneTransport.directDisplayDatagramsReceived,
    ),
    directDisplayDatagramsRecoveredByFec: delta(
      previous.directDisplayDatagramsRecoveredByFec,
      metrics.dataplaneTransport.directDisplayDatagramsRecoveredByFec,
    ),
    directDisplayDatagramsDeclaredLost: delta(
      previous.directDisplayDatagramsDeclaredLost,
      metrics.dataplaneTransport.directDisplayDatagramsDeclaredLost,
    ),
    directDisplayDatagramsOutcomeUnknown: delta(
      previous.directDisplayDatagramsOutcomeUnknown,
      metrics.dataplaneTransport.directDisplayDatagramsOutcomeUnknown,
    ),
    edgeDisplayDatagramsReceived: delta(
      previous.edgeDisplayDatagramsReceived,
      metrics.dataplaneTransport.edgeDisplayDatagramsReceived,
    ),
    edgeDisplayDatagramsRecoveredByFec: delta(
      previous.edgeDisplayDatagramsRecoveredByFec,
      metrics.dataplaneTransport.edgeDisplayDatagramsRecoveredByFec,
    ),
    edgeDisplayDatagramsDeclaredLost: delta(
      previous.edgeDisplayDatagramsDeclaredLost,
      metrics.dataplaneTransport.edgeDisplayDatagramsDeclaredLost,
    ),
    edgeDisplayDatagramsOutcomeUnknown: delta(
      previous.edgeDisplayDatagramsOutcomeUnknown,
      metrics.dataplaneTransport.edgeDisplayDatagramsOutcomeUnknown,
    ),
    rowsDeclaredLost: delta(previous.rowsDeclaredLost, metrics.dataplaneTransport.rowsDeclaredLost),
  };
}

export type DaemonPerfSender = (report: DaemonPerfReport) => Effect.Effect<void>;

/**
 * Periodically post one performance window to the application server.
 *
 * Deliberately over HTTP rather than the daemon control WebSocket. That socket's
 * inbound mailbox is bounded and sized for command acknowledgements alone —
 * liveness rides on transport-level ping frames that never enter it — with an
 * overflow policy that destroys the socket. Adding a telemetry message class
 * would introduce a new way for observational volume to trip that teardown and
 * drop a real session command. Telemetry must never be able to do that.
 *
 * Skips entirely unless the control state is `registered`: a daemon in backoff
 * has nothing meaningful to report and would add noise at exactly the moment
 * the server is already unhappy. One attempt per window with no retry — a
 * retried window is worse than a missing one, because it double-counts.
 */
export function runDaemonPerfReporterEffect(
  send: DaemonPerfSender,
  interval: Duration.Input = DEFAULT_REPORT_INTERVAL,
): Effect.Effect<never, never, DaemonHealthServiceTag> {
  return Effect.gen(function* () {
    let cursor = EMPTY_DAEMON_PERF_CURSOR;
    let windowStartedAtMs = yield* Effect.clockWith((clock) => clock.currentTimeMillis);

    while (true) {
      yield* Effect.sleep(interval);

      const snapshot = yield* daemonObservabilitySnapshot;
      const nowMs = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
      const windowMs = Math.max(0, Math.round(nowMs - windowStartedAtMs));
      windowStartedAtMs = nowMs;

      // Drain unconditionally so a window spent unregistered does not leak its
      // samples into the next report.
      const pingRtt = drainControlPingRtt();
      const suspensionGapMsMax = drainSuspensionGapMsMax();

      if (snapshot.health.control.state !== 'registered') {
        cursor = daemonPerfCursor(snapshot.metrics);
        continue;
      }

      const report = buildDaemonPerfReport(
        cursor,
        snapshot.metrics,
        windowMs,
        pingRtt,
        suspensionGapMsMax,
      );
      cursor = daemonPerfCursor(snapshot.metrics);
      yield* send(report);
    }
  });
}

export function createDaemonPerfSender(
  config: DaemonConfig,
  signer: DaemonProofSigner,
): DaemonPerfSender {
  const api = treaty<App>(config.server_origin, { fetcher: createDaemonFetch(config, signer) });

  const post = (report: DaemonPerfReport, signal: AbortSignal) =>
    api.api.daemon.perf.post(report, {
      fetch: { signal },
    });

  type PostResponse = Awaited<ReturnType<typeof post>>;
  type PostResult =
    | { readonly _tag: 'Response'; readonly response: PostResponse }
    | { readonly _tag: 'TransportError'; readonly error: unknown };

  return (report) =>
    Effect.acquireUseRelease(
      Effect.sync(() => new AbortController()),
      (controller) =>
        Effect.callback<PostResult>((resume) => {
          try {
            void post(report, controller.signal).then(
              (response) => resume(Effect.succeed({ _tag: 'Response', response })),
              (error) => resume(Effect.succeed({ _tag: 'TransportError', error })),
            );
          } catch (error) {
            resume(Effect.succeed({ _tag: 'TransportError', error }));
          }
        }),
      // The AbortController is an Effect resource, so the deadline and daemon
      // scope interruption both abort the in-flight request.
      (controller) => Effect.sync(() => controller.abort()),
    ).pipe(
      Effect.timeout('5 seconds'),
      Effect.tap((result) =>
        result._tag === 'TransportError'
          ? logEffect('warn', 'daemon', 'daemon_perf_report_error', {
              error: String(result.error),
            })
          : result.response.error !== null
            ? logEffect('warn', 'daemon', 'daemon_perf_report_rejected', {
                status: result.response.error.status,
              })
            : Effect.void,
      ),
      // A failed or timed-out window is dropped, never retried: observability
      // must not consume the budget of the thing it observes.
      Effect.catch(() => Effect.void),
      Effect.asVoid,
    );
}
