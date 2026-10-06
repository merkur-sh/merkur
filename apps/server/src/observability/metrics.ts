import { Effect, Metric } from 'effect';

// OTLP derives metric units from these static metric attributes. They are not
// span attributes and never carry request or session dimensions.
const MILLISECOND_METRIC_ATTRIBUTES = { unit: 'ms' } satisfies Metric.Metric.Attributes;
const BYTE_METRIC_ATTRIBUTES = { unit: 'By' } satisfies Metric.Metric.Attributes;

export const serverReadyGauge = Metric.gauge('merkur_server_ready', {
  description: 'Whether this server replica is ready to receive traffic (1 ready, 0 not ready)',
});

export const daemonControlActiveConnectionsGauge = Metric.gauge(
  'merkur_daemon_control_active_connections',
  {
    description: 'Current daemon control WebSocket connections owned by this replica',
  },
);

export const daemonControlInboundOverflowCounter = Metric.counter(
  'merkur_daemon_control_inbound_overflow_total',
  {
    description: 'Daemon control sockets closed because their bounded inbound mailbox overflowed',
    incremental: true,
  },
);

export const daemonControlPingTimeoutCounter = Metric.counter(
  'merkur_daemon_control_ping_timeout_total',
  {
    description: 'Daemon control connections retired after missing their ping deadline',
    incremental: true,
  },
);

export const daemonControlSilentTransitionFrequency = Metric.frequency(
  'merkur_daemon_control_silent_transition_total',
  {
    description:
      'Daemon control connections marked silent after missed pings, and recovered on the next one',
  },
);

export const daemonControlDeliveryOutcomeFrequency = Metric.frequency(
  'merkur_daemon_control_delivery_outcome_total',
  {
    description: 'Daemon control command delivery outcomes',
  },
);

/**
 * Deliberately not the 1-2-5 ladder used elsewhere in Merkur. That convention
 * suits latencies spanning orders of magnitude; this one does not. Command
 * acknowledgement is a single internet round trip plus one Redis presence read,
 * and the observed distribution is unimodal inside one decade — a week of
 * production traffic put min at 18.5 ms, p50 at 71.4, p95 at 131.9, p99 at
 * 248.8 and max at 467.
 *
 * The previous `[1, 2, 5, 10, 20, 50, 100, 250, 500, 1_000, 2_500, 5_000]`
 * ladder left seven buckets permanently empty and put p50, p75 and p90 all
 * inside `(50, 100]` and both p95 and p99 inside `(100, 250]`, so those
 * quantiles were identical by construction and the histogram could not
 * distinguish a healthy link from a degrading one.
 *
 * The 10 ms steps from 30 to 100 are where the entire live distribution sits.
 * The top finite boundary is `DAEMON_CONTROL_COMMAND_TIMEOUT_MS`, so `+Inf`
 * means "hit the deadline" rather than an arbitrary cutoff.
 */
export const DAEMON_CONTROL_DELIVERY_LATENCY_BOUNDARIES = [
  5, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 125, 150, 200, 300, 500, 1_000, 5_000,
] as const;

export const daemonControlDeliveryLatencyMs = Metric.histogram(
  'merkur_daemon_control_delivery_latency_ms',
  {
    attributes: MILLISECOND_METRIC_ATTRIBUTES,
    description: 'End-to-end daemon control command acknowledgement latency',
    boundaries: [...DAEMON_CONTROL_DELIVERY_LATENCY_BOUNDARIES],
  },
);

/**
 * Shared ladder for every round-trip-time histogram fed by a daemon or browser
 * report. These cover a full internet path rather than one server hop, so they
 * keep the wide 1-2-5-ish shape the delivery histogram above deliberately
 * abandons: a direct WebTransport link on a LAN and a relayed link on mobile
 * genuinely differ by two orders of magnitude.
 */
export const TELEMETRY_RTT_BOUNDARIES = [
  1, 2, 5, 10, 20, 30, 40, 50, 60, 80, 100, 150, 200, 300, 500, 1_000,
] as const;

export const redisOperationTimeoutCounter = Metric.counter('merkur_redis_operation_timeout_total', {
  description: 'Redis operations that exceeded Merkur’s bounded operation deadline',
  incremental: true,
});

export const backgroundWorkerFailureFrequency = Metric.frequency(
  'merkur_background_worker_failure_total',
  {
    description: 'Unexpected failures of named long-lived Effect fibers',
  },
);

// ── Reported telemetry (daemon and browser) ──────────────────────────────────
//
// Cardinality rule for everything below: no unbounded dimension may appear in a
// metric attribute or a frequency label. Effect's registry is keyed by
// (metric, attributes) with no eviction path, and the OTLP exporter uses
// cumulative temporality, so one datapoint per distinct attribute set is
// re-serialised into every 30-second export for the life of the process. A
// `daemon_id` or `user_id` label is therefore a permanent leak, and
// `Metric.frequency`'s per-label `key=` attribute is the same leak in a
// different shape.
//
// Per-entity detail belongs on spans, which are the high-cardinality store by
// design. See `docs/observability.md`.

export const daemonPerfReportOutcomeFrequency = Metric.frequency(
  'merkur_daemon_perf_reports_total',
  {
    description: 'Daemon performance report ingestion outcomes',
  },
);

/**
 * Distributions *of per-daemon percentiles*, not global percentiles.
 *
 * Each observation is one daemon's p50 (or p95) over its own 60-second window,
 * so `count` is the number of contributing daemon-windows rather than the number
 * of pings. Aggregating true global percentiles would require the daemon to
 * ship bucket counts and the server to agree on boundaries; that is worth doing
 * when a real fleet exists, and is over-engineering before then.
 */
export const daemonPingRttP50Ms = Metric.histogram('merkur_daemon_ping_rtt_p50_ms', {
  attributes: MILLISECOND_METRIC_ATTRIBUTES,
  description: 'Per-daemon p50 control ping round-trip time over one report window',
  boundaries: [...TELEMETRY_RTT_BOUNDARIES],
});

export const daemonPingRttP95Ms = Metric.histogram('merkur_daemon_ping_rtt_p95_ms', {
  attributes: MILLISECOND_METRIC_ATTRIBUTES,
  description: 'Per-daemon p95 control ping round-trip time over one report window',
  boundaries: [...TELEMETRY_RTT_BOUNDARIES],
});

export const daemonReportedPingOutcomeFrequency = Metric.frequency(
  'merkur_daemon_reported_ping_outcome_total',
  {
    description: 'Fleet rollup of daemon-observed ping outcomes',
  },
);

export const daemonReportedDataplaneRestartCounter = Metric.counter(
  'merkur_daemon_reported_dataplane_restarts_total',
  {
    description: 'Dataplane restarts reported by daemons',
    incremental: true,
  },
);

export const daemonReportedDataplaneAckTimeoutCounter = Metric.counter(
  'merkur_daemon_reported_dataplane_ack_timeouts_total',
  {
    description: 'Dataplane acknowledgement timeouts reported by daemons',
    incremental: true,
  },
);

/**
 * The laptop-sleep detector. A daemon has reported `registered` after 38.6
 * hours of suspension, so the top boundary is deliberately a full day.
 */
export const daemonSuspensionGapMs = Metric.histogram('merkur_daemon_suspension_gap_ms', {
  attributes: MILLISECOND_METRIC_ATTRIBUTES,
  description: 'Largest wall-clock gap a daemon observed in one report window',
  boundaries: [1_000, 5_000, 30_000, 300_000, 3_600_000, 86_400_000],
});

export const browserLinkReportOutcomeFrequency = Metric.frequency(
  'merkur_browser_link_reports_total',
  {
    description: 'Browser link-quality report ingestion outcomes',
  },
);

/**
 * Profiling-row ingestion outcomes.
 *
 * The rows themselves go to a separate Axiom dataset by native ingest, not
 * through the metric registry — they are per-render and per-keystroke, which is
 * exactly the unbounded cardinality that registry has no eviction path for.
 * What belongs here is only whether ingestion is working.
 */
export const browserPerfIngestFrequency = Metric.frequency('merkur_browser_perf_ingest_total', {
  description: 'Browser profiling batch ingestion outcomes',
});

/**
 * Daemon span relay outcomes.
 *
 * Daemons hold no vendor token — they export OTLP to this server, which
 * forwards. `forward_failed` is therefore the only signal that daemon traces
 * are being dropped, and it is deliberately unlabelled by daemon: the reason
 * belongs on the log, where cardinality is free.
 */
export const daemonTraceIngestFrequency = Metric.frequency('merkur_daemon_trace_ingest_total', {
  description: 'Daemon span batch relay outcomes',
});

/**
 * Tail-sampling decisions, one per finished trace.
 *
 * Observability of the observability: without this, a trace missing from the backend is
 * indistinguishable from one that was never created. `evicted` is the one to watch — it
 * means a trace's root never ended and its spans were dropped to bound memory, which is a
 * defect rather than a sampling outcome.
 */
export const traceSamplingFrequency = Metric.frequency('merkur_trace_sampling_total', {
  description: 'Tail-sampling decision per finished trace',
});

/**
 * Browser bootstrap-span relay outcomes.
 *
 * Same contract as the daemon relay: the browser holds no vendor token, so its spans reach
 * Axiom only by way of this server.
 */
/**
 * Browser failures by origin and class, labelled `<source>:<kind>`.
 *
 * Composite because the useful question is *which* surface is failing and how — five
 * sources by eleven kinds, a closed 55-label set. This is the only signal that a session
 * died rather than merely performed badly; every other browser metric requires the thing it
 * measures to still be working.
 */
export const browserErrorFrequency = Metric.frequency('merkur_browser_error_total', {
  description: 'Browser failures by source and class',
});

export const browserErrorCounter = Metric.counter('merkur_browser_errors_total', {
  description: 'Total browser failures reported, including repeats within a coalescing window',
  incremental: true,
});

export const browserTraceIngestFrequency = Metric.frequency('merkur_browser_trace_ingest_total', {
  description: 'Browser bootstrap span batch relay outcomes',
});

export const browserPerfRowCounter = Metric.counter('merkur_browser_perf_rows_total', {
  description: 'Profiling rows forwarded to the perf dataset',
  incremental: true,
});

export const browserLinkRttP50Ms = Metric.histogram('merkur_browser_link_rtt_p50_ms', {
  attributes: MILLISECOND_METRIC_ATTRIBUTES,
  description: 'Per-report p50 heartbeat round-trip time over one report window',
  boundaries: [...TELEMETRY_RTT_BOUNDARIES],
});

export const browserLinkRttP95Ms = Metric.histogram('merkur_browser_link_rtt_p95_ms', {
  attributes: MILLISECOND_METRIC_ATTRIBUTES,
  description: 'Per-report p95 heartbeat round-trip time over one report window',
  boundaries: [...TELEMETRY_RTT_BOUNDARIES],
});

export const browserInputAckRttP50Ms = Metric.histogram('merkur_browser_input_ack_rtt_p50_ms', {
  attributes: MILLISECOND_METRIC_ATTRIBUTES,
  description: 'Per-report p50 keystroke-to-daemon-acknowledgement time over one window',
  boundaries: [...TELEMETRY_RTT_BOUNDARIES],
});

export const browserInputAckRttP95Ms = Metric.histogram('merkur_browser_input_ack_rtt_p95_ms', {
  attributes: MILLISECOND_METRIC_ATTRIBUTES,
  description: 'Per-report p95 keystroke-to-daemon-acknowledgement time over one window',
  boundaries: [...TELEMETRY_RTT_BOUNDARIES],
});

/**
 * Which transport browsers actually ended up on. Nothing measured this before,
 * so "is the direct WebTransport upgrade landing in the field?" was unanswerable.
 */
export const browserLinkPathFrequency = Metric.frequency('merkur_browser_link_path_total', {
  description: 'Browser transport path samples by kind (direct, relay, unknown)',
});

export const browserLinkStateFrequency = Metric.frequency('merkur_browser_link_state_total', {
  description: 'Browser link-state samples across the five presentation states',
});

/**
 * Direct-upgrade attempts by outcome. Every browser is offered the daemon's
 * whole candidate manifest, so there is no selection to label them by; which
 * candidate kinds fail is `browserUpgradeCandidateDispositionFrequency`.
 */
export const browserUpgradeFrequency = Metric.frequency('merkur_browser_upgrade_total', {
  description: 'Direct WebTransport upgrade attempts by outcome',
});

/**
 * Which candidate kind actually carried the session, or `none` when the whole
 * race failed. This is the number that has been zero in every observed log.
 */
export const browserUpgradeWinnerFrequency = Metric.frequency(
  'merkur_browser_upgrade_winner_total',
  { description: 'Candidate kind that won the direct upgrade race, or none' },
);

/**
 * Inbound connections that reached a daemon's direct-WebTransport listener, and
 * how many completed the authenticated upgrade.
 *
 * The daemon-side half of the direct-path question, and the only half that can
 * prove a negative. The browser can report that it dialled a candidate and
 * heard nothing back, but from the browser a firewall and a daemon that was
 * never listening look identical. Compared against
 * `merkur_browser_upgrade_candidate_disposition_total{disposition="no_settle"}`,
 * these separate them: dials without arrivals is filtering, arrivals without
 * admissions is a Merkur bug.
 *
 * The expected/unexpected split is what makes that reading possible at all. The
 * first version of this metric was a single arrival count, and the fleet
 * recorded roughly 300,000 arrivals in a day against about a hundred upgrade
 * attempts: a public UDP port is scanned continuously, so background noise
 * outweighed browsers by four orders of magnitude and the intended comparison
 * was never observable. The daemon now classifies each arrival against the
 * browser addresses its own recent offers named.
 *
 * `_expected` is a lower bound by construction — a browser whose source address
 * no offer named is counted as unexpected — which keeps the metric from
 * inventing arrivals that did not happen. `_unexpected` is kept rather than
 * dropped so the two still sum to every connection that reached the listener,
 * and so a collapse in the noise floor reads as an instrument change rather
 * than as a NAT result.
 */
export const daemonReportedDirectWtIncomingExpectedCounter = Metric.counter(
  'merkur_daemon_direct_wt_incoming_expected_total',
  {
    incremental: true,
    description:
      "Inbound connections reaching daemons' direct WebTransport listeners from an offered address",
  },
);

export const daemonReportedDirectWtIncomingUnexpectedCounter = Metric.counter(
  'merkur_daemon_direct_wt_incoming_unexpected_total',
  {
    incremental: true,
    description:
      "Inbound connections reaching daemons' direct WebTransport listeners from an unoffered global address",
  },
);

/**
 * NAT side-channel activity, reported by daemons.
 *
 * The side channel holds the reflexive mapping open against RFC 4787's idle
 * timer and opens filter state toward a browser before it dials. Both are
 * preconditions for a reflexive candidate to be dialable at all, and until now
 * both were visible only in a daemon-local log line — so a candidate that never
 * settled could not be told apart from one whose pinhole was never opened.
 *
 * The two refusal reasons are separate counters rather than one labelled metric
 * because they mean opposite things. `not_global` is the correct outcome for a
 * same-NAT browser, where a LAN host candidate already wins, and it is the
 * common case; `rate_limited` means the token bucket or per-destination
 * cooldown suppressed a punch that should have fired, which is a defect. Summed
 * together the benign reason would bury the one worth alerting on.
 */
/**
 * Carrier-rebind outcomes reported by daemons, summed across the fleet.
 *
 * Six counters rather than one labelled metric, because the six mean
 * different things and a summed view buries the one that matters. A rebind
 * recovers a session in about one relay round trip; a refusal costs a full
 * server-mediated re-authentication and roughly two seconds of covered
 * terminal. `refused` rising against `accepted` is a reconnect regression, and
 * it was previously invisible off-machine: the dataplane's own registry only
 * leaves the host when an operator has configured a daemon-side OTLP endpoint,
 * so a fleet-wide rebind failure could only be inferred from the browser side,
 * which cannot see why a rebind was refused.
 *
 * `committed` below `accepted` means the daemon answered and the browser never
 * completed the successor handshake — a different fault from either.
 * `envelopesRejected` counts rebind frames dropped before the flow saw them.
 * Per-reason detail lives on the `daemon.session.rebind` span, not here, to
 * keep this dimensionless.
 */
export const daemonReportedRebindAcceptedCounter = Metric.counter(
  'merkur_daemon_rebind_accepted_total',
  { incremental: true, description: 'Carrier-rebind requests answered by daemons' },
);

export const daemonReportedRebindRequestsCounter = Metric.counter(
  'merkur_daemon_rebind_requests_total',
  { incremental: true, description: 'Carrier-rebind requests reaching daemon flow validation' },
);

export const daemonReportedRebindRefusedCounter = Metric.counter(
  'merkur_daemon_rebind_refused_total',
  { incremental: true, description: 'Carrier-rebind requests refused by daemons' },
);

export const daemonReportedRebindCommittedCounter = Metric.counter(
  'merkur_daemon_rebind_committed_total',
  { incremental: true, description: 'Carrier rebinds whose successor handshake completed' },
);

export const daemonReportedRebindEnvelopesRejectedCounter = Metric.counter(
  'merkur_daemon_rebind_envelopes_rejected_total',
  {
    incremental: true,
    description: 'Rebind frames rejected by the daemon signaling envelope validator',
  },
);

export const daemonReportedRebindEventsSuppressedCounter = Metric.counter(
  'merkur_daemon_rebind_events_suppressed_total',
  {
    incremental: true,
    description: 'Per-attempt rebind diagnostics suppressed by daemon emission bounds',
  },
);

export const daemonReportedNatKeepalivesCounter = Metric.counter(
  'merkur_daemon_nat_keepalives_total',
  { incremental: true, description: 'NAT side-channel keepalives sent by daemons' },
);

export const daemonReportedNatPunchBurstsCounter = Metric.counter(
  'merkur_daemon_nat_punch_bursts_total',
  { incremental: true, description: 'NAT side-channel punch bursts sent by daemons' },
);

export const daemonReportedNatPunchRefusedNotGlobalCounter = Metric.counter(
  'merkur_daemon_nat_punch_refused_not_global_total',
  { incremental: true, description: 'NAT punches skipped because the browser was not off-network' },
);

export const daemonReportedNatPunchRefusedRateLimitedCounter = Metric.counter(
  'merkur_daemon_nat_punch_refused_rate_limited_total',
  {
    incremental: true,
    description: 'NAT punches dropped by the token bucket or per-destination cooldown',
  },
);

export const daemonReportedNatSideChannelSendFailuresCounter = Metric.counter(
  'merkur_daemon_nat_side_channel_send_failures_total',
  {
    incremental: true,
    description: 'NAT side-channel datagrams the socket refused or could not accept',
  },
);

export const daemonReportedDirectWtAdmittedCounter = Metric.counter(
  'merkur_daemon_direct_wt_admitted_total',
  { incremental: true, description: 'Direct WebTransport upgrades admitted by daemons' },
);

/**
 * Display waste, reported by daemons.
 *
 * The dataplane has always counted these; until now they stopped at the
 * daemon's local metric registry, which only reaches an exporter when an
 * operator configures one. That left the fleet unable to see how much of what
 * it sent rendered nothing — the ratio that separates a full-screen change
 * settling in one round trip from one settling in a second.
 *
 * Read every one of them against `merkur_daemon_row_versions_sent_total`. The
 * absolute counts scale with how much output the fleet happened to produce and
 * say nothing on their own.
 */
export const daemonReportedRowVersionsSentCounter = Metric.counter(
  'merkur_daemon_row_versions_sent_total',
  {
    incremental: true,
    description: 'Row versions daemons put on the wire — the display-waste denominator',
  },
);

export const daemonReportedRowVersionsSupersededUnappliedCounter = Metric.counter(
  'merkur_daemon_row_versions_superseded_unapplied_total',
  {
    incremental: true,
    description: 'Row versions superseded before the daemon received their application ACK',
  },
);

export const daemonReportedRowResendsIdenticalCounter = Metric.counter(
  'merkur_daemon_row_resends_identical_total',
  {
    incremental: true,
    description: 'Re-sends of byte-identical row content, paced by the row re-send deadline',
  },
);

export const daemonReportedResyncRowsRequestedCounter = Metric.counter(
  'merkur_daemon_resync_rows_requested_total',
  {
    incremental: true,
    description:
      'Rows browsers asked to be resynchronised; separate from selective-ACK datagram loss',
  },
);

export const daemonReportedDirectDisplayDatagramsReceivedCounter = Metric.counter(
  'merkur_daemon_direct_display_datagrams_received_total',
  {
    incremental: true,
    description:
      'Sole-path direct display datagrams applied without FEC — the direct classified-loss denominator received bucket',
  },
);

export const daemonReportedDirectDisplayDatagramsRecoveredByFecCounter = Metric.counter(
  'merkur_daemon_direct_display_datagrams_recovered_by_fec_total',
  {
    incremental: true,
    description: 'Sole-path direct display datagrams applied after FEC reconstruction',
  },
);

export const daemonReportedDirectDisplayDatagramsDeclaredLostCounter = Metric.counter(
  'merkur_daemon_direct_display_datagrams_declared_lost_total',
  {
    incremental: true,
    description: 'Sole-path direct display datagrams a selective ACK classified Lost',
  },
);

export const daemonReportedDirectDisplayDatagramsOutcomeUnknownCounter = Metric.counter(
  'merkur_daemon_direct_display_datagrams_outcome_unknown_total',
  {
    incremental: true,
    description: 'Sole-path direct display datagrams whose bounded outcome evidence was censored',
  },
);

export const daemonReportedEdgeDisplayDatagramsReceivedCounter = Metric.counter(
  'merkur_daemon_edge_display_datagrams_received_total',
  {
    incremental: true,
    description:
      'Sole-path edge display datagrams applied without FEC — the edge classified-loss denominator received bucket',
  },
);

export const daemonReportedEdgeDisplayDatagramsRecoveredByFecCounter = Metric.counter(
  'merkur_daemon_edge_display_datagrams_recovered_by_fec_total',
  {
    incremental: true,
    description: 'Sole-path edge display datagrams applied after FEC reconstruction',
  },
);

export const daemonReportedEdgeDisplayDatagramsDeclaredLostCounter = Metric.counter(
  'merkur_daemon_edge_display_datagrams_declared_lost_total',
  {
    incremental: true,
    description: 'Sole-path edge display datagrams a selective ACK classified Lost',
  },
);

export const daemonReportedEdgeDisplayDatagramsOutcomeUnknownCounter = Metric.counter(
  'merkur_daemon_edge_display_datagrams_outcome_unknown_total',
  {
    incremental: true,
    description: 'Sole-path edge display datagrams whose bounded outcome evidence was censored',
  },
);

export const daemonReportedRowsDeclaredLostCounter = Metric.counter(
  'merkur_daemon_rows_declared_lost_total',
  {
    incremental: true,
    description: 'Rows disowned because the display datagram carrying them was declared lost',
  },
);

export const daemonReportedFecRepairsSentCounter = Metric.counter(
  'merkur_daemon_fec_repairs_sent_total',
  {
    incremental: true,
    description: 'FEC repair datagrams the transport accepted',
  },
);

export const daemonReportedFecRepairsRefusedCounter = Metric.counter(
  'merkur_daemon_fec_repairs_refused_total',
  {
    incremental: true,
    description: 'FEC repair datagrams refused at transport admission',
  },
);

/**
 * What became of each offered candidate, labelled `<kind>:<disposition>`.
 *
 * Composite for the same reason as `browserUpgradeFrequency`, and it is the
 * whole point of this metric. Its two predecessors counted offered kinds and
 * observed failure classes as separate frequencies, so a report saying "srflx
 * and host6 were offered; something timed out and something was refused" left
 * no way to say WHICH kind hit which wall. That is why the fleet could report
 * "srflx offered 225, won 0" and still not separate a NAT problem from a
 * firewall problem from a Merkur bug.
 *
 * Five kinds times nine dispositions is 45 values, closed and bounded, and the
 * array itself is capped at the offer ceiling. The dispositions that earn their
 * keep are `no_settle` (dialled and never answered — a filtered path) against
 * `not_dialled` (never asked), and `ready_upgrade_failed` (connected, and our
 * own admission failed) against everything the network decided.
 */
export const browserUpgradeCandidateDispositionFrequency = Metric.frequency(
  'merkur_browser_upgrade_candidate_disposition_total',
  { description: 'Offered candidate kind and what became of it, per report' },
);

/**
 * Where Merkur's own admission handshake failed, labelled `<stage>:<reason>`.
 *
 * Only updated when a candidate actually connected and admission then failed —
 * a `none:none` bucket would dominate and say nothing. This separates "the
 * network would not carry it" from "we could not complete our own handshake
 * over a working connection", which no previous metric could.
 */
export const browserUpgradeAdmissionFrequency = Metric.frequency(
  'merkur_browser_upgrade_admission_total',
  { description: 'Stage and reason of a failed direct-upgrade admission' },
);

export const browserUpgradeNatFrequency = Metric.frequency('merkur_browser_upgrade_nat_total', {
  description: 'Daemon-reported NAT mapping class at the time of a direct upgrade attempt',
});

export const browserLinkSampleCounter = Metric.counter('merkur_browser_link_samples_total', {
  description: 'Browser link-quality samples observed. Denominator for the degraded ratio.',
  incremental: true,
});

/**
 * Numerator for the degraded ratio. Stored as a separate counter rather than a
 * precomputed ratio: a ratio in a cumulative counter cannot be averaged or
 * summed across replicas, so the division belongs in the dashboard.
 */
export const browserLinkDegradedSampleCounter = Metric.counter(
  'merkur_browser_link_degraded_samples_total',
  {
    description: 'Browser link-quality samples flagged as degraded',
    incremental: true,
  },
);

export const browserLinkTxBytesCounter = Metric.counter('merkur_browser_link_tx_bytes_total', {
  attributes: BYTE_METRIC_ATTRIBUTES,
  description: 'Wire bytes sent, as observed by browsers',
  incremental: true,
});

export const browserLinkRxBytesCounter = Metric.counter('merkur_browser_link_rx_bytes_total', {
  attributes: BYTE_METRIC_ATTRIBUTES,
  description: 'Wire bytes received, as observed by browsers',
  incremental: true,
});

/**
 * Apdex-shaped verdict per browser heartbeat report: `good`, `degraded`, `bad`.
 * The good fraction is report-weighted among opted-in browsers. Backpressure
 * coarsens the usual ~2s cadence; this is neither user-minutes nor sessions.
 * Thresholds live in `session-quality.ts`.
 */
export const browserSessionQualityFrequency = Metric.frequency(
  'merkur_browser_session_quality_total',
  {
    description:
      'Per-heartbeat-report experience verdict (good/degraded/bad), weighted by reports.',
  },
);

export const merkurMetricsSnapshot = Metric.snapshot.pipe(
  Effect.map((snapshots) =>
    snapshots.map((snapshot) => ({
      id: snapshot.id,
      type: snapshot.type,
      ...(snapshot.description === undefined ? {} : { description: snapshot.description }),
      ...(snapshot.attributes === undefined ? {} : { attributes: snapshot.attributes }),
      state: metricJsonValue(snapshot.state),
    })),
  ),
);

export type MetricJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly MetricJsonValue[]
  | MetricJsonObject;

export interface MetricJsonObject {
  readonly [key: string]: MetricJsonValue;
}

function metricJsonValue(value: unknown): MetricJsonValue {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'number' ||
    typeof value === 'string'
  ) {
    return value;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value.map(metricJsonValue);
  }
  if (value instanceof Map) {
    return Object.fromEntries(
      Array.from(value, ([key, entry]) => [String(key), metricJsonValue(entry)]),
    );
  }
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .map(([key, entry]) => [key, metricJsonValue(entry)]),
    );
  }
  return String(value);
}
