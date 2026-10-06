import { isUtf8 } from 'node:buffer';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';
import {
  isRecoveryOutcomeRow,
  spanAttributes,
  TRANSPORT_HEARTBEAT_INTERVAL_MS,
} from '@merkur/shared';
import { Effect, Metric, Redacted } from 'effect';
import { Elysia, status } from 'elysia';
import { ServerConfigService } from '../../config';
import { type Logger, logWithLoggerEffect } from '../../logger';
import {
  browserErrorCounter,
  browserErrorFrequency,
  browserInputAckRttP50Ms,
  browserInputAckRttP95Ms,
  browserLinkDegradedSampleCounter,
  browserLinkPathFrequency,
  browserLinkReportOutcomeFrequency,
  browserLinkRttP50Ms,
  browserLinkRttP95Ms,
  browserLinkRxBytesCounter,
  browserLinkSampleCounter,
  browserLinkStateFrequency,
  browserLinkTxBytesCounter,
  browserPerfIngestFrequency,
  browserPerfRowCounter,
  browserSessionQualityFrequency,
  browserTraceIngestFrequency,
  browserUpgradeAdmissionFrequency,
  browserUpgradeCandidateDispositionFrequency,
  browserUpgradeFrequency,
  browserUpgradeNatFrequency,
  browserUpgradeWinnerFrequency,
  daemonPerfReportOutcomeFrequency,
  daemonPingRttP50Ms,
  daemonPingRttP95Ms,
  daemonReportedDataplaneAckTimeoutCounter,
  daemonReportedDataplaneRestartCounter,
  daemonReportedDirectDisplayDatagramsDeclaredLostCounter,
  daemonReportedDirectDisplayDatagramsOutcomeUnknownCounter,
  daemonReportedDirectDisplayDatagramsReceivedCounter,
  daemonReportedDirectDisplayDatagramsRecoveredByFecCounter,
  daemonReportedDirectWtAdmittedCounter,
  daemonReportedDirectWtIncomingExpectedCounter,
  daemonReportedDirectWtIncomingUnexpectedCounter,
  daemonReportedEdgeDisplayDatagramsDeclaredLostCounter,
  daemonReportedEdgeDisplayDatagramsOutcomeUnknownCounter,
  daemonReportedEdgeDisplayDatagramsReceivedCounter,
  daemonReportedEdgeDisplayDatagramsRecoveredByFecCounter,
  daemonReportedFecRepairsRefusedCounter,
  daemonReportedFecRepairsSentCounter,
  daemonReportedNatKeepalivesCounter,
  daemonReportedNatPunchBurstsCounter,
  daemonReportedNatPunchRefusedNotGlobalCounter,
  daemonReportedNatPunchRefusedRateLimitedCounter,
  daemonReportedNatSideChannelSendFailuresCounter,
  daemonReportedPingOutcomeFrequency,
  daemonReportedRebindAcceptedCounter,
  daemonReportedRebindCommittedCounter,
  daemonReportedRebindEnvelopesRejectedCounter,
  daemonReportedRebindEventsSuppressedCounter,
  daemonReportedRebindRefusedCounter,
  daemonReportedRebindRequestsCounter,
  daemonReportedResyncRowsRequestedCounter,
  daemonReportedRowResendsIdenticalCounter,
  daemonReportedRowsDeclaredLostCounter,
  daemonReportedRowVersionsSentCounter,
  daemonReportedRowVersionsSupersededUnappliedCounter,
  daemonSuspensionGapMs,
  daemonTraceIngestFrequency,
} from '../../observability/metrics';
import { classifySessionQuality } from '../../observability/session-quality';
import type { runServerProgram } from '../../runtime';
import type { AuthenticatedBrowser } from '../../services/auth-service';
import { enforceRateLimit, RateLimitServiceTag } from '../../services/rate-limit-service';
import { ApiModels } from '../api-models';
import { authenticatedApiPlugin } from '../authenticated-api';
import {
  authorizeDaemonRequest,
  parseDaemonJsonBody,
  parseDaemonTextBody,
} from '../daemon-request-auth';
import { runRouteEffect } from '../effect-route';

type RunServerProgram = typeof runServerProgram;

const STATUS_NO_CONTENT = 204;
const STATUS_UNAUTHORIZED = 401;

/** Four times the intended 60-second cadence, so a retry or a clock skew is fine. */
const REPORT_RATE_LIMIT = { limit: 4, windowMs: 60_000 } as const;

/**
 * The browser link report streams at the transport heartbeat rather than on a
 * window, so its ceiling is a different order of magnitude from the daemon and
 * upgrade reports above.
 *
 * Four times the nominal rate, matching the headroom the others get. The
 * multiple, not the absolute number, is the reviewed decision: it absorbs a
 * burst after a send that was blocked behind a slow request without letting a
 * modified client stream unboundedly. Keyed per user, so several concurrent
 * terminal tabs share it — that is deliberate, since the cost being bounded is
 * the server's, not the tab's.
 */
const LINK_REPORT_RATE_LIMIT = {
  limit: Math.ceil((4 * 60_000) / TRANSPORT_HEARTBEAT_INTERVAL_MS),
  windowMs: 60_000,
} as const;

/**
 * Profiling batches arrive from the telemetry worker's drain timer, one per
 * ~2 s per session, each carrying up to a thousand rows.
 *
 * Generous because the browser already bounds itself with a byte budget and
 * stops when it is exhausted; this exists so a modified client cannot stream
 * without limit into a dataset with a monthly ingest allowance.
 */
const PERF_INGEST_RATE_LIMIT = { limit: 240, windowMs: 60_000 } as const;

/**
 * Daemon span batches, per daemon.
 *
 * Sized from the daemon tracer's 5-second export interval with headroom for a
 * burst, because the fleet's span volume is bounded by daemon count and nothing
 * else. This limit is the only thing standing between a misbehaving build and
 * the trace dataset, so it must exist before the first fleet deploy rather than
 * after.
 */
const DAEMON_TRACE_RATE_LIMIT = { limit: 30, windowMs: 60_000 } as const;

/** Axiom rejects a batch over 10,000 events; stay an order of magnitude under. */
const MAX_PERF_ROWS_PER_REQUEST = 1_000;
/** Bounded read so a hostile body cannot be buffered without limit. */
const MAX_PERF_BODY_BYTES = 4 * 1024 * 1024;

/**
 * How much of Axiom's rejection body is carried into the log line.
 *
 * Axiom answers a rejected ingest with a short JSON object naming the reason,
 * which is the whole diagnostic — "dataset not found" and "unauthorized" are
 * different operator actions. It is bounded anyway because the body is a remote
 * input and a log line is not the place to discover that it was not short.
 */
const MAX_PERF_FAILURE_DETAIL_CHARS = 200;

/**
 * Why the forward failed, as far as the server can tell.
 *
 * `status` is 0 for a transport-level failure, where no response existed to
 * have a status. That is the one case the previous boolean and an HTTP
 * rejection genuinely shared, and it is now distinguishable from both.
 */
type PerfForwardOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: number; readonly detail: string };

/**
 * Bounded read for a relayed OTLP body, matching the perf ingest bound.
 */
const MAX_TRACE_BODY_BYTES = 4 * 1024 * 1024;

/**
 * The complete set of span attributes these routes may set.
 *
 * Asserted in tests. This is an allow-list rather than an addition to the
 * sanitizer's deny-list because the deny-list exists to catch attributes the
 * OpenTelemetry ecosystem attaches for you, whereas everything here is set
 * deliberately — a positive list is both stronger and cheaper to review.
 *
 * Note the deliberate absence of `merkur.user_id`. The server already knows the
 * user from the authenticated cookie; repeating it inside a telemetry span only
 * creates a join key in a payload that also travels through logs, and browser
 * performance data is just as useful unattributed. This is a considered
 * departure from what the session routes do — do not "fix" it.
 */
export const TELEMETRY_SPAN_ATTRIBUTE_KEYS = [
  'merkur.window_ms',
  'merkur.daemon.id',
  'merkur.ping_rtt_p50_ms',
  'merkur.ping_rtt_p95_ms',
  'merkur.ping_rtt_max_ms',
  'merkur.dataplane_ready',
  'merkur.suspension_gap_ms_max',
  'merkur.control_reconnects',
  'merkur.sample_count',
  'merkur.rtt_p50_ms',
  'merkur.rtt_p95_ms',
  'merkur.rtt_max_ms',
  'merkur.input_ack_p50_ms',
  'merkur.degraded_samples',
  'merkur.upgrade_outcome',
  'merkur.upgrade_winner_kind',
  'merkur.upgrade_nat_type',
  'merkur.upgrade_nat_filtering',
] as const;

interface TelemetryRoutesOptions {
  readonly runServerProgram: RunServerProgram;
  readonly authorizeRequest: (request: Request) => Promise<AuthenticatedBrowser | null>;
  readonly logger: Logger;
}

const decompressPerfBody = promisify(gunzip);

/**
 * The decompressed NDJSON bytes, forwarded as they are.
 *
 * Validate recovery rows against their shared closed vocabulary, then forward
 * the original bytes. The browser uses JSON.stringify, so malformed JSON or
 * non-UTF-8 input cannot be a valid browser batch.
 */
async function readPerfBody(request: Request): Promise<Uint8Array<ArrayBuffer> | null> {
  if (request.headers.get('content-encoding') !== 'gzip') return null;
  try {
    const compressed = new Uint8Array(await request.arrayBuffer());
    if (compressed.byteLength === 0 || compressed.byteLength > MAX_PERF_BODY_BYTES) return null;
    // Bound expansion inside the decompressor, before it can allocate an
    // oversized output. Authentication and rate admission precede this work.
    const decoded = await decompressPerfBody(compressed, {
      maxOutputLength: MAX_PERF_BODY_BYTES,
    });
    if (!isUtf8(decoded)) return null;
    for (const line of decoded.toString('utf8').split('\n')) {
      if (line.length === 0) continue;
      const row: unknown = JSON.parse(line);
      if (
        typeof row === 'object' &&
        row !== null &&
        'kind' in row &&
        row.kind === 'recovery_outcome' &&
        !isRecoveryOutcomeRow(row)
      )
        return null;
    }
    return decoded;
  } catch {
    return null;
  }
}

const NEWLINE = 0x0a;

/** Non-empty `\n`-separated rows; `0x0a` never occurs inside a multi-byte sequence. */
function countNonEmptyRows(bytes: Uint8Array): number {
  let rows = 0;
  let start = 0;
  let newline = bytes.indexOf(NEWLINE, start);
  while (newline !== -1) {
    if (newline > start) rows += 1;
    start = newline + 1;
    newline = bytes.indexOf(NEWLINE, start);
  }
  return bytes.byteLength > start ? rows + 1 : rows;
}

export function telemetryRoutesPlugin({
  runServerProgram,
  authorizeRequest,
  logger,
}: TelemetryRoutesOptions) {
  return (
    new Elysia({ name: 'telemetry-routes' })
      .post(
        '/api/daemon/perf',
        {
          parse: parseDaemonJsonBody,
          body: ApiModels.DaemonPerfReportBody,
          response: {
            204: ApiModels.EmptyResponse,
            401: ApiModels.ErrorResponse,
          },
        },
        async ({ body, request }) => {
          const daemonIdentity = await authorizeDaemonRequest(runServerProgram, request, logger);
          if (daemonIdentity === null) {
            return status(STATUS_UNAUTHORIZED, { error: 'unauthorized' as const });
          }

          await runRouteEffect(
            runServerProgram,
            Effect.gen(function* () {
              const rateLimitService = yield* RateLimitServiceTag;
              const allowed = yield* enforceRateLimit(rateLimitService, [
                {
                  key: `daemon-perf:${daemonIdentity.daemonId}`,
                  ...REPORT_RATE_LIMIT,
                },
              ]).pipe(
                Effect.as(true),
                Effect.catchTag('RateLimitedError', () => Effect.succeed(false)),
              );
              if (!allowed) {
                yield* Metric.update(daemonPerfReportOutcomeFrequency, 'rejected_rate_limited');
                return;
              }

              yield* Effect.annotateCurrentSpan(
                spanAttributes({
                  'merkur.daemon.id': daemonIdentity.daemonId,
                  'merkur.window_ms': body.windowMs,
                  'merkur.ping_rtt_p50_ms': body.pingRttP50Ms,
                  'merkur.ping_rtt_p95_ms': body.pingRttP95Ms,
                  'merkur.ping_rtt_max_ms': body.pingRttMaxMs,
                  'merkur.dataplane_ready': body.dataplaneReady,
                  'merkur.suspension_gap_ms_max': body.suspensionGapMsMax,
                  'merkur.control_reconnects': body.controlReconnects,
                  'merkur.direct_wt_incoming_expected': body.directWtIncomingExpected,
                  'merkur.direct_wt_incoming_unexpected': body.directWtIncomingUnexpected,
                  'merkur.nat_keepalives_sent': body.natKeepalivesSent,
                  'merkur.nat_punch_bursts_sent': body.natPunchBurstsSent,
                  'merkur.nat_punch_refused_not_global': body.natPunchRefusedNotGlobal,
                  'merkur.nat_punch_refused_rate_limited': body.natPunchRefusedRateLimited,
                  'merkur.nat_side_channel_send_failures': body.natSideChannelSendFailures,
                  'merkur.rebind_accepted': body.rebindAccepted,
                  'merkur.rebind_refused': body.rebindRefused,
                  'merkur.rebind_committed': body.rebindCommitted,
                  'merkur.rebind_envelopes_rejected': body.rebindEnvelopesRejected,
                  'merkur.rebind_requests': body.rebindRequests,
                  'merkur.rebind_events_suppressed': body.rebindEventsSuppressed,
                  'merkur.direct_wt_admitted': body.directWtAdmitted,
                  'merkur.row_versions_sent': body.rowVersionsSent,
                  'merkur.row_versions_superseded_unapplied': body.rowVersionsSupersededUnapplied,
                  'merkur.row_resends_identical': body.rowResendsIdentical,
                  'merkur.resync_rows_requested': body.resyncRowsRequested,
                  'merkur.fec_repairs_sent': body.fecRepairsSent,
                  'merkur.fec_repairs_refused': body.fecRepairsRefused,
                  'merkur.direct_display_datagrams_received': body.directDisplayDatagramsReceived,
                  'merkur.direct_display_datagrams_recovered_by_fec':
                    body.directDisplayDatagramsRecoveredByFec,
                  'merkur.direct_display_datagrams_declared_lost':
                    body.directDisplayDatagramsDeclaredLost,
                  'merkur.direct_display_datagrams_outcome_unknown':
                    body.directDisplayDatagramsOutcomeUnknown,
                  'merkur.edge_display_datagrams_received': body.edgeDisplayDatagramsReceived,
                  'merkur.edge_display_datagrams_recovered_by_fec':
                    body.edgeDisplayDatagramsRecoveredByFec,
                  'merkur.edge_display_datagrams_declared_lost':
                    body.edgeDisplayDatagramsDeclaredLost,
                  'merkur.edge_display_datagrams_outcome_unknown':
                    body.edgeDisplayDatagramsOutcomeUnknown,
                  'merkur.rows_declared_lost': body.rowsDeclaredLost,
                }),
              );

              // Only record RTT percentiles when the window actually contained
              // pongs. A zero from an empty window would drag the fleet
              // distribution toward an impossible value.
              if (body.pingRttCount > 0) {
                yield* Metric.update(daemonPingRttP50Ms, body.pingRttP50Ms);
                yield* Metric.update(daemonPingRttP95Ms, body.pingRttP95Ms);
              }
              if (body.suspensionGapMsMax > 0) {
                yield* Metric.update(daemonSuspensionGapMs, body.suspensionGapMsMax);
              }
              yield* recordFrequencyCount(
                daemonReportedPingOutcomeFrequency,
                'pong',
                body.controlPingPonged,
              );
              yield* recordFrequencyCount(
                daemonReportedPingOutcomeFrequency,
                'timeout',
                body.controlPingTimeout,
              );
              yield* recordFrequencyCount(
                daemonReportedPingOutcomeFrequency,
                'send_failed',
                body.controlPingSendFailed,
              );
              yield* recordFrequencyCount(
                daemonReportedPingOutcomeFrequency,
                'suspended',
                body.controlPingSuspended,
              );
              yield* Metric.update(daemonReportedDataplaneRestartCounter, body.dataplaneRestarts);
              yield* Metric.update(
                daemonReportedDataplaneAckTimeoutCounter,
                body.dataplaneAckTimeouts,
              );
              yield* Metric.update(
                daemonReportedDirectWtIncomingExpectedCounter,
                body.directWtIncomingExpected,
              );
              yield* Metric.update(
                daemonReportedDirectWtIncomingUnexpectedCounter,
                body.directWtIncomingUnexpected,
              );
              yield* Metric.update(daemonReportedNatKeepalivesCounter, body.natKeepalivesSent);
              yield* Metric.update(daemonReportedNatPunchBurstsCounter, body.natPunchBurstsSent);
              yield* Metric.update(
                daemonReportedNatPunchRefusedNotGlobalCounter,
                body.natPunchRefusedNotGlobal,
              );
              yield* Metric.update(
                daemonReportedNatPunchRefusedRateLimitedCounter,
                body.natPunchRefusedRateLimited,
              );
              yield* Metric.update(
                daemonReportedNatSideChannelSendFailuresCounter,
                body.natSideChannelSendFailures,
              );
              yield* Metric.update(daemonReportedRebindAcceptedCounter, body.rebindAccepted);
              yield* Metric.update(daemonReportedRebindRequestsCounter, body.rebindRequests);
              yield* Metric.update(daemonReportedRebindRefusedCounter, body.rebindRefused);
              yield* Metric.update(daemonReportedRebindCommittedCounter, body.rebindCommitted);
              yield* Metric.update(
                daemonReportedRebindEnvelopesRejectedCounter,
                body.rebindEnvelopesRejected,
              );
              yield* Metric.update(
                daemonReportedRebindEventsSuppressedCounter,
                body.rebindEventsSuppressed,
              );
              yield* Metric.update(daemonReportedDirectWtAdmittedCounter, body.directWtAdmitted);
              yield* Metric.update(daemonReportedRowVersionsSentCounter, body.rowVersionsSent);
              yield* Metric.update(
                daemonReportedRowVersionsSupersededUnappliedCounter,
                body.rowVersionsSupersededUnapplied,
              );
              yield* Metric.update(
                daemonReportedRowResendsIdenticalCounter,
                body.rowResendsIdentical,
              );
              yield* Metric.update(
                daemonReportedResyncRowsRequestedCounter,
                body.resyncRowsRequested,
              );
              yield* Metric.update(daemonReportedFecRepairsSentCounter, body.fecRepairsSent);
              yield* Metric.update(daemonReportedFecRepairsRefusedCounter, body.fecRepairsRefused);
              yield* Metric.update(
                daemonReportedDirectDisplayDatagramsReceivedCounter,
                body.directDisplayDatagramsReceived,
              );
              yield* Metric.update(
                daemonReportedDirectDisplayDatagramsRecoveredByFecCounter,
                body.directDisplayDatagramsRecoveredByFec,
              );
              yield* Metric.update(
                daemonReportedDirectDisplayDatagramsDeclaredLostCounter,
                body.directDisplayDatagramsDeclaredLost,
              );
              yield* Metric.update(
                daemonReportedDirectDisplayDatagramsOutcomeUnknownCounter,
                body.directDisplayDatagramsOutcomeUnknown,
              );
              yield* Metric.update(
                daemonReportedEdgeDisplayDatagramsReceivedCounter,
                body.edgeDisplayDatagramsReceived,
              );
              yield* Metric.update(
                daemonReportedEdgeDisplayDatagramsRecoveredByFecCounter,
                body.edgeDisplayDatagramsRecoveredByFec,
              );
              yield* Metric.update(
                daemonReportedEdgeDisplayDatagramsDeclaredLostCounter,
                body.edgeDisplayDatagramsDeclaredLost,
              );
              yield* Metric.update(
                daemonReportedEdgeDisplayDatagramsOutcomeUnknownCounter,
                body.edgeDisplayDatagramsOutcomeUnknown,
              );
              yield* Metric.update(daemonReportedRowsDeclaredLostCounter, body.rowsDeclaredLost);
              yield* Metric.update(daemonPerfReportOutcomeFrequency, 'accepted');
            }),
            {
              logger,
              eventName: 'daemon_perf_report_failed',
              request,
              signal: request.signal,
            },
          );

          return status(STATUS_NO_CONTENT, undefined);
        },
      )
      /**
       * Daemon span relay.
       *
       * Daemons run an OTLP tracer pointed here, not at the vendor. The argument
       * is the one `docs/observability.md` already makes for browser profiling
       * rows: the server holds the Axiom token, and it must never reach a client.
       * A daemon runs on a user's machine, so shipping it an ingest token would
       * put a fleet-wide write credential on every laptop, and add a second
       * outbound destination to a process whose whole network surface is
       * otherwise the server and the edge.
       *
       * The body is relayed verbatim. Parsing OTLP here would mean re-serialising
       * it, and the server has no reason to look inside — the spans a daemon may
       * emit are constrained where they are created, and `check:span-attributes`
       * gates that at build time rather than at ingest.
       */
      .post(
        '/api/daemon/traces',
        {
          // Relayed verbatim, so it is read as text rather than shaped by a
          // schema the server would only have to re-serialise.
          parse: parseDaemonTextBody,
          response: {
            204: ApiModels.EmptyResponse,
            401: ApiModels.ErrorResponse,
          },
        },
        async ({ body, request }) => {
          const daemonIdentity = await authorizeDaemonRequest(runServerProgram, request, logger);
          if (daemonIdentity === null) {
            return status(STATUS_UNAUTHORIZED, { error: 'unauthorized' as const });
          }

          const spans = typeof body === 'string' ? body : '';

          await runRouteEffect(
            runServerProgram,
            Effect.gen(function* () {
              const rateLimitService = yield* RateLimitServiceTag;
              const allowed = yield* enforceRateLimit(rateLimitService, [
                {
                  key: `daemon-traces:${daemonIdentity.daemonId}`,
                  ...DAEMON_TRACE_RATE_LIMIT,
                },
              ]).pipe(
                Effect.as(true),
                Effect.catchTag('RateLimitedError', () => Effect.succeed(false)),
              );
              if (!allowed) {
                yield* Metric.update(daemonTraceIngestFrequency, 'rejected_rate_limited');
                return;
              }

              if (spans.length === 0 || spans.length > MAX_TRACE_BODY_BYTES) {
                yield* Metric.update(daemonTraceIngestFrequency, 'rejected_invalid');
                return;
              }

              yield* Effect.annotateCurrentSpan(
                spanAttributes({
                  'merkur.daemon.id': daemonIdentity.daemonId,
                }),
              );

              const config = yield* ServerConfigService;
              const telemetry = config.telemetry;
              if (telemetry === undefined) {
                // Accepted and discarded, exactly as the browser perf route does:
                // a developer running without Axiom credentials must not see
                // daemon export failures.
                yield* Metric.update(daemonTraceIngestFrequency, 'discarded_unconfigured');
                return;
              }

              const outcome: PerfForwardOutcome = yield* Effect.tryPromise({
                try: (signal) =>
                  fetch(`${telemetry.axiomEndpoint}/v1/traces`, {
                    method: 'POST',
                    headers: {
                      'content-type': 'application/json',
                      authorization: `Bearer ${Redacted.value(telemetry.axiomToken)}`,
                      'x-axiom-dataset': telemetry.axiomDataset,
                    },
                    body: spans,
                    signal,
                  }),
                catch: (cause) => new Error(String(cause)),
              }).pipe(
                Effect.flatMap((response) =>
                  response.ok
                    ? Effect.succeed<PerfForwardOutcome>({ ok: true })
                    : Effect.map(
                        Effect.promise(() => response.text().catch(() => '')),
                        (body_): PerfForwardOutcome => ({
                          ok: false,
                          status: response.status,
                          detail: body_.slice(0, MAX_PERF_FAILURE_DETAIL_CHARS),
                        }),
                      ),
                ),
                // Dropped, never retried, for the same reason every other
                // telemetry send here is: a retried batch double-counts, and
                // observability must not consume the budget of what it observes.
                Effect.catch((cause) =>
                  Effect.succeed<PerfForwardOutcome>({
                    ok: false,
                    status: 0,
                    detail: cause.message.slice(0, MAX_PERF_FAILURE_DETAIL_CHARS),
                  }),
                ),
              );

              if (!outcome.ok) {
                yield* Metric.update(daemonTraceIngestFrequency, 'forward_failed');
                yield* logWithLoggerEffect(logger, 'warn', 'daemon_trace_forward_failed', {
                  status: outcome.status,
                  dataset: telemetry.axiomDataset,
                  bytes: spans.length,
                  detail: outcome.detail,
                });
                return;
              }
              yield* Metric.update(daemonTraceIngestFrequency, 'accepted');
            }),
            {
              logger,
              eventName: 'daemon_trace_relay_failed',
              request,
              signal: request.signal,
            },
          );

          return status(STATUS_NO_CONTENT, undefined);
        },
      )
      .group('/api/telemetry', (api) =>
        api
          .use(authenticatedApiPlugin({ authorizeRequest }))
          .post(
            '/link',
            {
              body: ApiModels.BrowserLinkReportBody,
              response: {
                204: ApiModels.EmptyResponse,
                401: ApiModels.ErrorResponse,
              },
            },
            async ({ body, request, userId }) => {
              await runRouteEffect(
                runServerProgram,
                Effect.gen(function* () {
                  const rateLimitService = yield* RateLimitServiceTag;
                  const allowed = yield* enforceRateLimit(rateLimitService, [
                    {
                      // Keyed on the authenticated user, never on a client address:
                      // these routes deliberately never call `resolveClientIp`.
                      key: `telemetry-link:user:${userId}`,
                      ...LINK_REPORT_RATE_LIMIT,
                    },
                  ]).pipe(
                    Effect.as(true),
                    Effect.catchTag('RateLimitedError', () => Effect.succeed(false)),
                  );
                  if (!allowed) {
                    yield* Metric.update(
                      browserLinkReportOutcomeFrequency,
                      'rejected_rate_limited',
                    );
                    return;
                  }

                  // Classified from fields the report already carries, so adding
                  // this needed no wire-contract change and no client release.
                  const verdict = classifySessionQuality(body);

                  yield* Effect.annotateCurrentSpan(
                    spanAttributes({
                      'merkur.window_ms': body.windowMs,
                      'merkur.sample_count': body.sampleCount,
                      'merkur.rtt_p50_ms': body.rttP50Ms,
                      'merkur.rtt_p95_ms': body.rttP95Ms,
                      'merkur.rtt_max_ms': body.rttMaxMs,
                      'merkur.input_ack_p50_ms': body.inputAckP50Ms,
                      'merkur.degraded_samples': body.degradedSampleCount,
                      // The verdict rides the span too, so a bad window can be
                      // opened and read field by field rather than only counted.
                      'merkur.session_quality': verdict,
                    }),
                  );

                  // The browser uses zero for a missing RTT observation; even a
                  // measured 0ms RTT occupies its first positive bucket. A link
                  // sample alone does not prove either latency was measured.
                  if (body.sampleCount > 0) {
                    if (body.rttP50Ms > 0) {
                      yield* Metric.update(browserLinkRttP50Ms, body.rttP50Ms);
                    }
                    if (body.rttP95Ms > 0) {
                      yield* Metric.update(browserLinkRttP95Ms, body.rttP95Ms);
                    }
                    if (body.inputAckP50Ms > 0) {
                      yield* Metric.update(browserInputAckRttP50Ms, body.inputAckP50Ms);
                    }
                    if (body.inputAckP95Ms > 0) {
                      yield* Metric.update(browserInputAckRttP95Ms, body.inputAckP95Ms);
                    }
                  }

                  yield* Metric.update(browserLinkSampleCounter, body.sampleCount);
                  yield* Metric.update(browserLinkDegradedSampleCounter, body.degradedSampleCount);
                  yield* Metric.update(browserLinkTxBytesCounter, body.txBytes);
                  yield* Metric.update(browserLinkRxBytesCounter, body.rxBytes);

                  yield* recordFrequencyCount(browserLinkPathFrequency, 'direct', body.pathDirect);
                  yield* recordFrequencyCount(browserLinkPathFrequency, 'relay', body.pathRelay);
                  yield* recordFrequencyCount(
                    browserLinkPathFrequency,
                    'unknown',
                    body.pathUnknown,
                  );
                  yield* recordFrequencyCount(
                    browserLinkStateFrequency,
                    'connecting',
                    body.stateConnecting,
                  );
                  yield* recordFrequencyCount(browserLinkStateFrequency, 'ready', body.stateReady);
                  yield* recordFrequencyCount(
                    browserLinkStateFrequency,
                    'reconnecting',
                    body.stateReconnecting,
                  );
                  yield* recordFrequencyCount(
                    browserLinkStateFrequency,
                    'dormant',
                    body.stateDormant,
                  );
                  yield* recordFrequencyCount(
                    browserLinkStateFrequency,
                    'closed',
                    body.stateClosed,
                  );

                  yield* Metric.update(browserSessionQualityFrequency, verdict);
                  yield* Metric.update(browserLinkReportOutcomeFrequency, 'accepted');
                }),
                {
                  logger,
                  eventName: 'browser_link_report_failed',
                  request,
                  signal: request.signal,
                },
              );

              return status(STATUS_NO_CONTENT, undefined);
            },
          )
          /**
           * Profiling rows, forwarded verbatim to Axiom's native ingest API.
           *
           * Not OTLP, and not the metric registry. These rows are per-render and
           * per-keystroke: wrapping each in a span envelope would multiply the
           * bytes for no query benefit, and putting that cardinality into the
           * Effect metric registry would pin one datapoint per distinct attribute
           * set for the life of the process, since it has no eviction path.
           *
           * The body is gzip-compressed NDJSON produced by the telemetry worker.
           * The server decompresses without parsing or re-shaping the rows. This
           * bounded, authenticated relay holds the Axiom token, which must never
           * reach a browser.
           */
          .post(
            '/perf',
            {
              // Authenticate and rate-limit before reading compressed bytes.
              parse: 'none',
              response: {
                204: ApiModels.EmptyResponse,
                401: ApiModels.ErrorResponse,
              },
            },
            async ({ request, userId }) => {
              await runRouteEffect(
                runServerProgram,
                Effect.gen(function* () {
                  const rateLimitService = yield* RateLimitServiceTag;
                  const allowed = yield* enforceRateLimit(rateLimitService, [
                    { key: `telemetry-perf:user:${userId}`, ...PERF_INGEST_RATE_LIMIT },
                  ]).pipe(
                    Effect.as(true),
                    Effect.catchTag('RateLimitedError', () => Effect.succeed(false)),
                  );
                  if (!allowed) {
                    yield* Metric.update(browserPerfIngestFrequency, 'rejected_rate_limited');
                    return;
                  }

                  const rows = yield* Effect.promise(() => readPerfBody(request));
                  if (rows === null || rows.byteLength === 0) {
                    yield* Metric.update(browserPerfIngestFrequency, 'rejected_invalid');
                    return;
                  }
                  const lineCount = countNonEmptyRows(rows);
                  if (lineCount === 0 || lineCount > MAX_PERF_ROWS_PER_REQUEST) {
                    yield* Metric.update(browserPerfIngestFrequency, 'rejected_invalid');
                    return;
                  }

                  const config = yield* ServerConfigService;
                  const telemetry = config.telemetry;
                  if (telemetry === undefined) {
                    // Export is not configured. Accepting and discarding is
                    // correct: a developer running without Axiom credentials
                    // should not see profiling failures in the browser.
                    yield* Metric.update(browserPerfIngestFrequency, 'discarded_unconfigured');
                    return;
                  }

                  const outcome: PerfForwardOutcome = yield* Effect.tryPromise({
                    try: (signal) =>
                      fetch(`${telemetry.axiomEndpoint}/v1/ingest/${telemetry.axiomPerfDataset}`, {
                        method: 'POST',
                        headers: {
                          'content-type': 'application/x-ndjson',
                          authorization: `Bearer ${Redacted.value(telemetry.axiomToken)}`,
                        },
                        body: rows,
                        signal,
                      }),
                    catch: (cause) => new Error(String(cause)),
                  }).pipe(
                    Effect.flatMap((response) =>
                      response.ok
                        ? Effect.succeed<PerfForwardOutcome>({ ok: true })
                        : Effect.map(
                            Effect.promise(() => response.text().catch(() => '')),
                            (body): PerfForwardOutcome => ({
                              ok: false,
                              status: response.status,
                              detail: body.slice(0, MAX_PERF_FAILURE_DETAIL_CHARS),
                            }),
                          ),
                    ),
                    // A failed forward is still dropped, never retried: a retried
                    // batch double-counts, and telemetry must not consume the
                    // budget of the thing it observes. What is no longer dropped
                    // is the *reason*. This used to collapse to `response.ok`, so
                    // a missing dataset, a rejected token and a network failure
                    // were one indistinguishable `false` — which is how the perf
                    // dataset came to receive nothing at all for as long as it
                    // did while every gate here reported success.
                    Effect.catch((cause) =>
                      Effect.succeed<PerfForwardOutcome>({
                        ok: false,
                        status: 0,
                        detail: cause.message.slice(0, MAX_PERF_FAILURE_DETAIL_CHARS),
                      }),
                    ),
                  );

                  if (!outcome.ok) {
                    yield* Metric.update(browserPerfIngestFrequency, 'forward_failed');
                    // Logged through the Effect-native path rather than a direct
                    // logger call, because direct calls are stdout-only: a fault
                    // in the telemetry pipeline has to be visible in the very
                    // dataset an operator is looking at when they notice it.
                    // The label stays 'forward_failed' — the status belongs on
                    // the log, where cardinality is free, and never in a metric
                    // whose registry has no eviction path.
                    yield* logWithLoggerEffect(logger, 'warn', 'browser_perf_forward_failed', {
                      status: outcome.status,
                      dataset: telemetry.axiomPerfDataset,
                      rows: lineCount,
                      detail: outcome.detail,
                    });
                    return;
                  }
                  yield* Metric.update(browserPerfRowCounter, lineCount);
                  yield* Metric.update(browserPerfIngestFrequency, 'accepted');
                }),
                {
                  logger,
                  eventName: 'browser_perf_ingest_failed',
                  request,
                  signal: request.signal,
                },
              );

              return status(STATUS_NO_CONTENT, undefined);
            },
          )
          /**
           * Browser failure reports.
           *
           * The one signal that says a session *died* rather than merely performed badly.
           * Every other browser surface here measures a working session and goes quiet
           * exactly when things break.
           *
           * The body carries two closed unions and a count — no message, no stack, no free
           * text — so it is safe to ship from a client whose process memory contains
           * terminal bytes. The detail stays in the DevTools console.
           */
          .post(
            '/error',
            {
              body: ApiModels.BrowserErrorReportBody,
              response: {
                204: ApiModels.EmptyResponse,
                401: ApiModels.ErrorResponse,
              },
            },
            async ({ body, request, userId }) => {
              await runRouteEffect(
                runServerProgram,
                Effect.gen(function* () {
                  const rateLimitService = yield* RateLimitServiceTag;
                  const allowed = yield* enforceRateLimit(rateLimitService, [
                    { key: `telemetry-error:user:${userId}`, ...REPORT_RATE_LIMIT },
                  ]).pipe(
                    Effect.as(true),
                    Effect.catchTag('RateLimitedError', () => Effect.succeed(false)),
                  );
                  if (!allowed) return;

                  yield* Effect.annotateCurrentSpan(
                    spanAttributes({
                      'merkur.error_source': body.source,
                      'merkur.error_kind': body.kind,
                      'merkur.sample_count': body.count,
                    }),
                  );

                  // Labelled once per report, and counted by occurrence separately: a
                  // coalescing window means one report can stand for many failures, and
                  // conflating the two would understate a storm.
                  yield* Metric.update(browserErrorFrequency, `${body.source}:${body.kind}`);
                  yield* Metric.update(browserErrorCounter, body.count);
                }),
                {
                  logger,
                  eventName: 'browser_error_report_failed',
                  request,
                  signal: request.signal,
                },
              );

              return status(STATUS_NO_CONTENT, undefined);
            },
          )
          /**
           * Browser bootstrap-span relay.
           *
           * The browser holds no vendor token — the same rule as the daemon, for the same
           * reason: a browser *is* a user's machine. It posts OTLP spans here and the
           * server, which holds the Axiom token, forwards them.
           *
           * The bodies are per-session and tiny (about ten spans for one connect), so this
           * shares the perf route's rate limit shape rather than needing its own ladder.
           */
          .post(
            '/traces',
            {
              // Relayed verbatim, so it is read as text rather than shaped by a schema the
              // server would only have to re-serialise.
              parse: 'text',
              response: {
                204: ApiModels.EmptyResponse,
                401: ApiModels.ErrorResponse,
              },
            },
            async ({ body, request, userId }) => {
              const spans = typeof body === 'string' ? body : '';
              await runRouteEffect(
                runServerProgram,
                Effect.gen(function* () {
                  const rateLimitService = yield* RateLimitServiceTag;
                  const allowed = yield* enforceRateLimit(rateLimitService, [
                    { key: `telemetry-traces:user:${userId}`, ...PERF_INGEST_RATE_LIMIT },
                  ]).pipe(
                    Effect.as(true),
                    Effect.catchTag('RateLimitedError', () => Effect.succeed(false)),
                  );
                  if (!allowed) {
                    yield* Metric.update(browserTraceIngestFrequency, 'rejected_rate_limited');
                    return;
                  }

                  if (spans.length === 0 || spans.length > MAX_TRACE_BODY_BYTES) {
                    yield* Metric.update(browserTraceIngestFrequency, 'rejected_invalid');
                    return;
                  }

                  const config = yield* ServerConfigService;
                  const telemetry = config.telemetry;
                  if (telemetry === undefined) {
                    yield* Metric.update(browserTraceIngestFrequency, 'discarded_unconfigured');
                    return;
                  }

                  const outcome: PerfForwardOutcome = yield* Effect.tryPromise({
                    try: (signal) =>
                      fetch(`${telemetry.axiomEndpoint}/v1/traces`, {
                        method: 'POST',
                        headers: {
                          'content-type': 'application/json',
                          authorization: `Bearer ${Redacted.value(telemetry.axiomToken)}`,
                          'x-axiom-dataset': telemetry.axiomDataset,
                        },
                        body: spans,
                        signal,
                      }),
                    catch: (cause) => new Error(String(cause)),
                  }).pipe(
                    Effect.flatMap((response) =>
                      response.ok
                        ? Effect.succeed<PerfForwardOutcome>({ ok: true })
                        : Effect.map(
                            Effect.promise(() => response.text().catch(() => '')),
                            (detail): PerfForwardOutcome => ({
                              ok: false,
                              status: response.status,
                              detail: detail.slice(0, MAX_PERF_FAILURE_DETAIL_CHARS),
                            }),
                          ),
                    ),
                    Effect.catch((cause) =>
                      Effect.succeed<PerfForwardOutcome>({
                        ok: false,
                        status: 0,
                        detail: cause.message.slice(0, MAX_PERF_FAILURE_DETAIL_CHARS),
                      }),
                    ),
                  );

                  if (!outcome.ok) {
                    yield* Metric.update(browserTraceIngestFrequency, 'forward_failed');
                    yield* logWithLoggerEffect(logger, 'warn', 'browser_trace_forward_failed', {
                      status: outcome.status,
                      dataset: telemetry.axiomDataset,
                      bytes: spans.length,
                      detail: outcome.detail,
                    });
                    return;
                  }
                  yield* Metric.update(browserTraceIngestFrequency, 'accepted');
                }),
                {
                  logger,
                  eventName: 'browser_trace_relay_failed',
                  request,
                  signal: request.signal,
                },
              );

              return status(STATUS_NO_CONTENT, undefined);
            },
          )
          .post(
            '/upgrade',
            {
              body: ApiModels.BrowserUpgradeReportBody,
              response: {
                204: ApiModels.EmptyResponse,
                401: ApiModels.ErrorResponse,
              },
            },
            async ({ body, request, userId }) => {
              await runRouteEffect(
                runServerProgram,
                Effect.gen(function* () {
                  const rateLimitService = yield* RateLimitServiceTag;
                  const allowed = yield* enforceRateLimit(rateLimitService, [
                    {
                      key: `telemetry-upgrade:user:${userId}`,
                      ...REPORT_RATE_LIMIT,
                    },
                  ]).pipe(
                    Effect.as(true),
                    Effect.catchTag('RateLimitedError', () => Effect.succeed(false)),
                  );
                  if (!allowed) {
                    return;
                  }

                  yield* Effect.annotateCurrentSpan(
                    spanAttributes({
                      'merkur.upgrade_outcome': body.outcome,
                      'merkur.upgrade_winner_kind': body.winnerKind,
                      'merkur.upgrade_nat_type': body.natType,
                      'merkur.upgrade_nat_filtering': body.natFiltering,
                      'merkur.upgrade_admission_stage': body.admissionStage,
                      'merkur.upgrade_admission_reason': body.admissionReason,
                    }),
                  );

                  yield* Metric.update(browserUpgradeFrequency, body.outcome);
                  yield* Metric.update(browserUpgradeWinnerFrequency, body.winnerKind);
                  yield* Metric.update(browserUpgradeNatFrequency, body.natType);
                  // A `none:none` admission bucket would dominate and say nothing;
                  // this metric answers "when a candidate connected, where did OUR
                  // handshake fail", so only a real failure belongs in it.
                  if (body.admissionStage !== 'none') {
                    yield* Metric.update(
                      browserUpgradeAdmissionFrequency,
                      `${body.admissionStage}:${body.admissionReason}`,
                    );
                  }
                  // Bounded by the request schema's offer ceiling, and every
                  // member of both fields is a re-validated closed union.
                  yield* Effect.forEach(
                    body.candidates,
                    (candidate) =>
                      Metric.update(
                        browserUpgradeCandidateDispositionFrequency,
                        `${candidate.kind}:${candidate.disposition}`,
                      ),
                    { discard: true },
                  );
                }),
                {
                  logger,
                  eventName: 'browser_upgrade_report_failed',
                  request,
                  signal: request.signal,
                },
              );

              return status(STATUS_NO_CONTENT, undefined);
            },
          ),
      )
  );
}

/**
 * Record `count` occurrences of one closed-set frequency label.
 *
 * Effect frequencies count occurrences one at a time, and the reports carry
 * pre-aggregated counts. The counts are bounded by the request schema, so this
 * loop cannot be driven unboundedly by a client.
 */
function recordFrequencyCount(
  frequency: Metric.Metric<string, Metric.FrequencyState>,
  label: string,
  count: number,
): Effect.Effect<void> {
  if (count <= 0) {
    return Effect.void;
  }
  // `Metric.update` is `contextWith` + `updateUnsafe`; applying the same updates
  // in one step avoids an array of `count` labels and an effect per occurrence.
  return Effect.contextWith((context) =>
    Effect.sync(() => {
      for (let occurrence = 0; occurrence < count; occurrence += 1) {
        frequency.updateUnsafe(label, context);
      }
    }),
  );
}
