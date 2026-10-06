import { spanAttributes } from '@merkur/shared';
import {
  Clock,
  Context,
  type Duration,
  Effect,
  Layer,
  Metric,
  Option,
  Stream,
  SubscriptionRef,
} from 'effect';

import { logEffect } from '../logger';
import type { DataplanePathStats, DataplaneTransportStats } from './dataplane-client';

const DEFAULT_HEALTH_LOG_INTERVAL = '30 seconds';

export type DaemonControlHealthState =
  | 'starting'
  | 'connecting'
  | 'registering'
  | 'registered'
  | 'backoff'
  | 'superseded';

export type DaemonDataplaneHealthState = 'starting' | 'ready' | 'down' | 'fatal';

export interface DaemonControlHealth {
  readonly state: DaemonControlHealthState;
  readonly stable: boolean;
  readonly connectionId: string | null;
  readonly reconnectDelayMs: number | null;
  readonly lastFailure: string | null;
  readonly updatedAt: number;
}

export interface DaemonDataplaneHealth {
  readonly state: DaemonDataplaneHealthState;
  readonly updatedAt: number;
}

export interface DaemonHealthSnapshot {
  readonly status: 'ready' | 'not_ready';
  readonly ready: boolean;
  readonly checkedAt: number;
  readonly control: DaemonControlHealth;
  readonly dataplane: DaemonDataplaneHealth;
}

export interface DaemonHealthState {
  readonly control: DaemonControlHealth;
  readonly dataplane: DaemonDataplaneHealth;
}

export interface DaemonControlHealthUpdate {
  readonly state: DaemonControlHealthState;
  readonly stable?: boolean;
  readonly connectionId?: string | null;
  readonly reconnectDelayMs?: number | null;
  readonly lastFailure?: string | null;
}

export interface DaemonHealthService {
  readonly updateControl: (update: DaemonControlHealthUpdate) => Effect.Effect<void>;
  readonly updateDataplane: (state: DaemonDataplaneHealthState) => Effect.Effect<void>;
  readonly snapshot: Effect.Effect<DaemonHealthSnapshot>;
  readonly changes: Stream.Stream<DaemonHealthSnapshot>;
}

export class DaemonHealthServiceTag extends Context.Service<
  DaemonHealthServiceTag,
  DaemonHealthService
>()('DaemonHealthService') {}

export const daemonControlReconnectOutcomes = Metric.frequency(
  'merkur_daemon_control_reconnect_outcomes',
  {
    description: 'Daemon control reconnects grouped by the preceding connection outcome',
  },
);

export const daemonControlRegistrationOutcomes = Metric.frequency(
  'merkur_daemon_control_registration_outcomes',
  {
    description: 'Daemon control registration and pre-registration outcomes',
  },
);

/**
 * Port-mapping cycles by outcome, labelled `<who>:<what>`.
 *
 * The label set is closed and small — at most seven values — and is validated
 * against `NAT_MAPPING_OUTCOMES` before it reaches here, because
 * `docs/observability.md` forbids an unbounded dimension in a registry with no
 * eviction path.
 *
 * The `skipped:*` half is why this exists rather than a plain success counter.
 * Its predecessor reported three booleans, so "no gateway was addressed" and
 * "the gateway refused" were the same `false`. Thirty days of zeroes then read
 * as a verdict on UPnP/NAT-PMP/PCP and got the whole stack deleted, when the
 * daemon may simply never have had a first hop to ask.
 */
export const daemonNatMappingOutcomes = Metric.frequency('merkur_daemon_nat_mapping_outcomes', {
  description: 'Port-mapping cycles grouped by protocol and outcome',
});

/**
 * Carrier-rebind attempts grouped by outcome.
 *
 * A refused rebind is silence on the wire by design, so this and the
 * `daemon.session.rebind` span are the only places one is observable at all.
 * The label is validated against `REBIND_OUTCOMES` in `dataplane-client.ts`
 * before it reaches here — 34 bounded values, none carrying identity — because
 * `docs/observability.md` forbids an unbounded dimension in a registry with no
 * eviction path. The session id deliberately reaches the span and the log and
 * never this.
 *
 * `not_rebinding` dominating means the peer survived without an authenticated
 * rebind lineage; `unknown_peer` dominating means it was parked before the
 * browser came back. Those two were indistinguishable from each other, and from
 * success, until this existed.
 */
export const daemonRebindOutcomes = Metric.frequency('merkur_daemon_rebind_outcomes', {
  description: 'Carrier-rebind attempts grouped by outcome',
});

/**
 * Cumulative rebind tallies from the dataplane's periodic sample.
 *
 * The per-attempt outcomes above are rate-bounded at the emitter, so a flood
 * would erase the evidence that a flood happened. These are computed in the
 * dataplane and ride the stats frame, so they survive it.
 */
export const dataplaneRebindRequests = Metric.gauge('merkur_dataplane_rebind_requests', {
  description: 'Absolute carrier-rebind requests seen since dataplane start',
});

export const dataplaneRebindAccepted = Metric.gauge('merkur_dataplane_rebind_accepted', {
  description: 'Absolute carrier-rebind requests answered since dataplane start',
});

export const dataplaneRebindCommitted = Metric.gauge('merkur_dataplane_rebind_committed', {
  description: 'Absolute carrier rebinds committed since dataplane start',
});

export const dataplaneRebindRefused = Metric.gauge('merkur_dataplane_rebind_refused', {
  description: 'Absolute carrier-rebind requests refused since dataplane start',
});

export const dataplaneRebindEnvelopesRejected = Metric.gauge(
  'merkur_dataplane_rebind_envelopes_rejected',
  {
    description: 'Absolute rebind frames rejected by the envelope validator since dataplane start',
  },
);

export const dataplaneRebindEventsSuppressed = Metric.gauge(
  'merkur_dataplane_rebind_events_suppressed',
  {
    description: 'Absolute rebind outcome events suppressed since dataplane start',
  },
);

/**
 * Whether an unsolicited inbound IPv6 datagram reached the daemon's pinned port.
 *
 * Exported rather than only logged because it is the measurement that decides
 * whether a v6 pinhole is worth building. `host6` is one of only two candidate
 * kinds that have ever won a direct upgrade in production, and it loses the
 * overwhelming majority of the races it enters — but a log line on each daemon
 * cannot say whether those losses are firewall filtering or something else, and
 * reading it means an SSH session per host. As a metric the question is one
 * query.
 *
 * A frequency rather than a counter: the answer is a small closed set
 * (`reachable` / `unknown`, from `Ipv6Reachability::as_str`), and what matters
 * is the ratio between them across the fleet.
 */
export const daemonIpv6Reachability = Metric.frequency('merkur_daemon_ipv6_reachability', {
  description: 'WebTransport startup probes grouped by whether unsolicited inbound IPv6 arrived',
});

export const daemonControlPingOutcomes = Metric.frequency('merkur_daemon_control_ping_outcomes', {
  description: 'Daemon control ping pongs, timeouts, and send failures',
});

export const daemonDataplaneRestartOutcomes = Metric.frequency(
  'merkur_daemon_dataplane_restart_outcomes',
  {
    description: 'Dataplane restart requests grouped by the triggering reason',
  },
);

export const daemonDataplaneAckTimeouts = Metric.counter(
  'merkur_daemon_dataplane_ack_timeouts_total',
  {
    description: 'Dataplane commands rejected because the Rust acknowledgement deadline elapsed',
    incremental: true,
  },
);

export const daemonDataplaneReady = Metric.gauge('merkur_daemon_dataplane_ready', {
  description: 'Current Rust dataplane readiness (1 ready, 0 down or starting)',
});

// ── Dataplane transport/display telemetry ────────────────────────────────────
// Fed by the periodic `EVT_TRANSPORT_STATS` sample. Counters receive the
// sample's interval delta; gauges receive its instantaneous value.

export const dataplaneRowVersionsSent = Metric.counter('merkur_dataplane_row_versions_sent', {
  description: 'Row versions put on the wire. The denominator for display waste ratios.',
  incremental: true,
});

export const dataplaneRowVersionsSupersededUnapplied = Metric.counter(
  'merkur_dataplane_row_versions_superseded_unapplied',
  {
    description:
      'Row versions replaced before the browser reported applying them — bandwidth that rendered nothing',
    incremental: true,
  },
);

export const dataplaneRowResendsIdentical = Metric.counter(
  'merkur_dataplane_row_resends_identical',
  {
    description:
      'Re-sends of byte-identical row content, paced by the resend deadline that replaced the NACK signal',
    incremental: true,
  },
);

export const dataplaneFecRepairsSent = Metric.counter('merkur_dataplane_fec_repairs_sent', {
  description: 'FEC repair frames the transport accepted, once per protected group',
  incremental: true,
});

export const dataplaneFecRepairsRefused = Metric.counter('merkur_dataplane_fec_repairs_refused', {
  description: 'FEC repair frames the transport refused, leaving that group unprotected',
  incremental: true,
});

/**
 * Inbound connections that reached the direct-WebTransport listener, split by
 * whether an offer recently named the source address, and how many completed
 * the authenticated upgrade.
 *
 * `incremental: false` because the dataplane reports these cumulatively since
 * process start, exactly like the display counters above; the reporter takes
 * the window delta.
 *
 * The expected/unexpected split exists because the undifferentiated count could
 * not answer the question it was added for: a public UDP port is scanned
 * continuously, and background noise outweighed real dials by four orders of
 * magnitude.
 */
export const dataplaneDirectWtIncomingExpected = Metric.counter(
  'merkur_dataplane_direct_wt_incoming_expected',
  {
    description: 'Inbound direct WebTransport connections from an address a recent offer named',
    incremental: true,
  },
);

export const dataplaneDirectWtIncomingUnexpected = Metric.counter(
  'merkur_dataplane_direct_wt_incoming_unexpected',
  {
    description:
      'Inbound direct WebTransport connections from an unoffered global address (scanning)',
    incremental: true,
  },
);

export const dataplaneDirectWtAdmitted = Metric.counter('merkur_dataplane_direct_wt_admitted', {
  description: 'Direct WebTransport peers that completed the authenticated upgrade',
  incremental: true,
});

/**
 * NAT side-channel activity.
 *
 * `natPunchRefusedRateLimited` is the load-bearing one: a punch that never fired
 * means the daemon's filter state was not open when the browser dialled, which
 * produces a candidate that never settles and is indistinguishable from a
 * firewall without this counter.
 */
export const dataplaneNatKeepalivesSent = Metric.counter('merkur_dataplane_nat_keepalives_sent', {
  description: 'NAT side-channel keepalives sent to hold the reflexive mapping open',
  incremental: true,
});

export const dataplaneNatPunchBurstsSent = Metric.counter(
  'merkur_dataplane_nat_punch_bursts_sent',
  {
    description: 'NAT side-channel punch bursts sent toward a browser address',
    incremental: true,
  },
);

/**
 * Kept apart from `dataplaneNatPunchRefusedRateLimited` rather than summed into
 * one "refused" counter. A punch refused because the browser address is not
 * globally routable is the *correct* outcome — that is the same-NAT case, where
 * a LAN host candidate already wins — and it is the common one. Summing the two
 * would let the benign reason bury the defect signal.
 */
export const dataplaneNatPunchRefusedNotGlobal = Metric.counter(
  'merkur_dataplane_nat_punch_refused_not_global',
  {
    description: 'NAT side-channel punches skipped because the browser is not off-network',
    incremental: true,
  },
);

export const dataplaneNatPunchRefusedRateLimited = Metric.counter(
  'merkur_dataplane_nat_punch_refused_rate_limited',
  {
    description: 'NAT side-channel punches dropped by the token bucket or per-destination cooldown',
    incremental: true,
  },
);

export const dataplaneNatSideChannelSendFailures = Metric.counter(
  'merkur_dataplane_nat_side_channel_send_failures',
  {
    description: 'NAT side-channel datagrams the socket refused or could not accept',
    incremental: true,
  },
);

export const dataplaneResyncRowsRequested = Metric.counter(
  'merkur_dataplane_resync_rows_requested',
  {
    description:
      'Rows the browser asked to be resynchronised — the only direct loss signal the display protocol retains',
    incremental: true,
  },
);

export const dataplaneDirectDisplayDatagramsReceived = Metric.counter(
  'merkur_dataplane_direct_display_datagrams_received',
  {
    description:
      'Sole-path direct display datagrams applied without FEC — the direct loss denominator received bucket',
    incremental: true,
  },
);

export const dataplaneDirectDisplayDatagramsRecoveredByFec = Metric.counter(
  'merkur_dataplane_direct_display_datagrams_recovered_by_fec',
  {
    description: 'Sole-path direct display datagrams applied after FEC reconstruction',
    incremental: true,
  },
);

export const dataplaneDirectDisplayDatagramsDeclaredLost = Metric.counter(
  'merkur_dataplane_direct_display_datagrams_declared_lost',
  {
    description: 'Sole-path direct display datagrams a selective ACK classified Lost',
    incremental: true,
  },
);

export const dataplaneDirectDisplayDatagramsOutcomeUnknown = Metric.counter(
  'merkur_dataplane_direct_display_datagrams_outcome_unknown',
  {
    description: 'Sole-path direct display datagrams whose bounded outcome evidence was censored',
    incremental: true,
  },
);

export const dataplaneEdgeDisplayDatagramsReceived = Metric.counter(
  'merkur_dataplane_edge_display_datagrams_received',
  {
    description:
      'Sole-path edge display datagrams applied without FEC — the edge loss denominator received bucket',
    incremental: true,
  },
);

export const dataplaneEdgeDisplayDatagramsRecoveredByFec = Metric.counter(
  'merkur_dataplane_edge_display_datagrams_recovered_by_fec',
  {
    description: 'Sole-path edge display datagrams applied after FEC reconstruction',
    incremental: true,
  },
);

export const dataplaneEdgeDisplayDatagramsDeclaredLost = Metric.counter(
  'merkur_dataplane_edge_display_datagrams_declared_lost',
  {
    description: 'Sole-path edge display datagrams a selective ACK classified Lost',
    incremental: true,
  },
);

export const dataplaneEdgeDisplayDatagramsOutcomeUnknown = Metric.counter(
  'merkur_dataplane_edge_display_datagrams_outcome_unknown',
  {
    description: 'Sole-path edge display datagrams whose bounded outcome evidence was censored',
    incremental: true,
  },
);

export const dataplaneRowsDeclaredLost = Metric.counter('merkur_dataplane_rows_declared_lost', {
  description: 'Rows disowned because their carrying display datagram was declared lost',
  incremental: true,
});

export const dataplaneDatagramSendFailures = Metric.counter(
  'merkur_dataplane_datagram_send_failures',
  {
    description: 'Display datagram sends the transport refused',
    incremental: true,
  },
);

export const dataplaneQuicPacketsSent = Metric.counter('merkur_dataplane_quic_packets_sent', {
  description: 'QUIC packets sent across both transports',
  incremental: true,
});

export const dataplaneQuicPacketsLost = Metric.counter('merkur_dataplane_quic_packets_lost', {
  description: 'QUIC packets declared lost across both transports — true packet loss',
  incremental: true,
});

export const dataplaneStatsEventsDropped = Metric.gauge('merkur_dataplane_stats_events_dropped', {
  description:
    'Telemetry frames the dataplane dropped rather than poisoning its event sink. Non-zero means the series has gaps.',
});

export const dataplaneUnackedDatagramsMax = Metric.gauge('merkur_dataplane_unacked_datagrams_max', {
  description: 'Largest unacknowledged sent-datagram backlog across peers',
});

export const dataplaneWebtransportRttUs = Metric.gauge('merkur_dataplane_webtransport_rtt_us', {
  description:
    'Worst heartbeat-only round-trip EWMA on the direct WebTransport path, in microseconds',
});

export const dataplaneEdgeRttUs = Metric.gauge('merkur_dataplane_edge_rtt_us', {
  description: 'Worst heartbeat-only round-trip EWMA on the edge path, in microseconds',
});

export const DaemonHealthServiceLive = Layer.effect(
  DaemonHealthServiceTag,
  Effect.gen(function* () {
    const state = yield* SubscriptionRef.make<DaemonHealthState>(initialHealthState());

    return {
      updateControl: (update) =>
        Effect.gen(function* () {
          const updatedAt = yield* Clock.currentTimeMillis;
          yield* SubscriptionRef.update(state, (current) => ({
            ...current,
            control: {
              state: update.state,
              stable: update.stable ?? false,
              connectionId: update.connectionId ?? null,
              reconnectDelayMs: update.reconnectDelayMs ?? null,
              lastFailure:
                update.lastFailure === undefined ? current.control.lastFailure : update.lastFailure,
              updatedAt,
            },
          }));
        }),
      updateDataplane: (nextState) =>
        Effect.gen(function* () {
          const updatedAt = yield* Clock.currentTimeMillis;
          yield* SubscriptionRef.updateSome(state, (current) =>
            current.dataplane.state === nextState
              ? Option.none()
              : Option.some({
                  ...current,
                  dataplane: {
                    state: nextState,
                    updatedAt,
                  },
                }),
          );
        }),
      snapshot: Effect.gen(function* () {
        const health = yield* SubscriptionRef.get(state);
        const checkedAt = yield* Clock.currentTimeMillis;
        return healthSnapshot(health, checkedAt);
      }),
      changes: SubscriptionRef.changes(state).pipe(
        Stream.mapEffect((health) =>
          Clock.currentTimeMillis.pipe(
            Effect.map((checkedAt) => healthSnapshot(health, checkedAt)),
          ),
        ),
      ),
    };
  }),
);

export interface DaemonMetricSnapshot {
  readonly controlReconnectOutcomes: Readonly<Record<string, number>>;
  readonly controlRegistrationOutcomes: Readonly<Record<string, number>>;
  readonly controlPingOutcomes: Readonly<Record<string, number>>;
  readonly dataplaneRestartOutcomes: Readonly<Record<string, number>>;
  readonly dataplaneAckTimeouts: number;
  readonly dataplaneReady: number;
  readonly dataplaneTransport: DaemonDataplaneTransportMetrics;
  /**
   * Latest complete fixed-shape sample validated at the dataplane IPC boundary.
   * It retains the per-carrier counters that the fleet metrics intentionally
   * aggregate away. No peer/session identity is present, and exactly one
   * sample is retained, so health logging stays redacted and bounded.
   */
  readonly latestDataplaneTransport: DaemonDataplaneTransportSample | null;
}

export interface DaemonDataplaneTransportSample {
  /** Daemon clock time when every metric update for `latest` completed. */
  readonly observedAtMs: number;
  readonly sampleCount: number;
  /**
   * The newest interval counters plus instantaneous gauges. Periodic samples
   * cover ten seconds; an explicit final capture closes the current positive,
   * at-most-ten-second partial interval.
   */
  readonly latest: DataplaneTransportStats;
  /**
   * Process-lifetime bounded aggregate of every validated sample. Interval
   * counters are summed, maxima remain maxima, MTU/cwnd retain the lowest
   * non-zero observation, and process-lifetime counters retain their maximum.
   * `windowMs` is therefore the exact sampled duration represented here.
   */
  readonly aggregate: DataplaneTransportStats;
}

/**
 * The transport/display slice of the daemon metric snapshot, sourced from the
 * dataplane's periodic telemetry sample.
 *
 * `statsEventsDropped` is deliberately part of the payload: the dataplane drops
 * telemetry frames rather than poisoning its event sink, so a consumer needs to
 * be able to tell "nothing happened" from "the sample never arrived".
 */
export interface DaemonDataplaneTransportMetrics {
  readonly rowVersionsSent: number;
  readonly rowVersionsSupersededUnapplied: number;
  readonly rowResendsIdentical: number;
  readonly fecRepairsSent: number;
  readonly fecRepairsRefused: number;
  readonly resyncRowsRequested: number;
  readonly directDisplayDatagramsReceived: number;
  readonly directDisplayDatagramsRecoveredByFec: number;
  readonly directDisplayDatagramsDeclaredLost: number;
  readonly directDisplayDatagramsOutcomeUnknown: number;
  readonly edgeDisplayDatagramsReceived: number;
  readonly edgeDisplayDatagramsRecoveredByFec: number;
  readonly edgeDisplayDatagramsDeclaredLost: number;
  readonly edgeDisplayDatagramsOutcomeUnknown: number;
  readonly rowsDeclaredLost: number;
  readonly directWtIncomingExpected: number;
  readonly directWtIncomingUnexpected: number;
  readonly directWtAdmitted: number;
  readonly natKeepalivesSent: number;
  readonly natPunchBurstsSent: number;
  readonly natPunchRefusedNotGlobal: number;
  readonly natPunchRefusedRateLimited: number;
  readonly natSideChannelSendFailures: number;
  readonly datagramSendFailures: number;
  readonly quicPacketsSent: number;
  readonly quicPacketsLost: number;
  readonly unackedDatagramsMax: number;
  readonly webtransportRttUs: number;
  readonly edgeRttUs: number;
  readonly statsEventsDropped: number;
  /**
   * Carrier-rebind tallies. `rebindEventsSuppressed` is here for the same
   * reason as `statsEventsDropped` above: the per-attempt outcome events are
   * rate-bounded, so a consumer needs to tell "no rebinds happened" from "the
   * detail was dropped".
   */
  readonly rebindRequests: number;
  readonly rebindAccepted: number;
  readonly rebindCommitted: number;
  readonly rebindRefused: number;
  readonly rebindEnvelopesRejected: number;
  readonly rebindEventsSuppressed: number;
}

export interface DaemonObservabilitySnapshot {
  readonly health: DaemonHealthSnapshot;
  readonly metrics: DaemonMetricSnapshot;
}

let latestDataplaneTransport: DaemonDataplaneTransportSample | null = null;

export const daemonObservabilitySnapshot: Effect.Effect<
  DaemonObservabilitySnapshot,
  never,
  DaemonHealthServiceTag
> = Effect.gen(function* () {
  const healthService = yield* DaemonHealthServiceTag;
  const [
    health,
    reconnect,
    registration,
    ping,
    dataplaneRestart,
    dataplaneAckTimeouts,
    dataplaneReady,
    rowVersionsSent,
    rowVersionsSupersededUnapplied,
    rowResendsIdentical,
    fecRepairsSent,
    fecRepairsRefused,
    resyncRowsRequested,
    directDisplayDatagramsReceived,
    directDisplayDatagramsRecoveredByFec,
    directDisplayDatagramsDeclaredLost,
    directDisplayDatagramsOutcomeUnknown,
    edgeDisplayDatagramsReceived,
    edgeDisplayDatagramsRecoveredByFec,
    edgeDisplayDatagramsDeclaredLost,
    edgeDisplayDatagramsOutcomeUnknown,
    rowsDeclaredLost,
    directWtIncomingExpected,
    directWtIncomingUnexpected,
    directWtAdmitted,
    natKeepalivesSent,
    natPunchBurstsSent,
    natPunchRefusedNotGlobal,
    natPunchRefusedRateLimited,
    natSideChannelSendFailures,
    datagramSendFailures,
    quicPacketsSent,
    quicPacketsLost,
    unackedDatagramsMax,
    webtransportRttUs,
    edgeRttUs,
    statsEventsDropped,
    rebindRequests,
    rebindAccepted,
    rebindCommitted,
    rebindRefused,
    rebindEnvelopesRejected,
    rebindEventsSuppressed,
  ] = yield* Effect.all([
    healthService.snapshot,
    Metric.value(daemonControlReconnectOutcomes),
    Metric.value(daemonControlRegistrationOutcomes),
    Metric.value(daemonControlPingOutcomes),
    Metric.value(daemonDataplaneRestartOutcomes),
    Metric.value(daemonDataplaneAckTimeouts),
    Metric.value(daemonDataplaneReady),
    Metric.value(dataplaneRowVersionsSent),
    Metric.value(dataplaneRowVersionsSupersededUnapplied),
    Metric.value(dataplaneRowResendsIdentical),
    Metric.value(dataplaneFecRepairsSent),
    Metric.value(dataplaneFecRepairsRefused),
    Metric.value(dataplaneResyncRowsRequested),
    Metric.value(dataplaneDirectDisplayDatagramsReceived),
    Metric.value(dataplaneDirectDisplayDatagramsRecoveredByFec),
    Metric.value(dataplaneDirectDisplayDatagramsDeclaredLost),
    Metric.value(dataplaneDirectDisplayDatagramsOutcomeUnknown),
    Metric.value(dataplaneEdgeDisplayDatagramsReceived),
    Metric.value(dataplaneEdgeDisplayDatagramsRecoveredByFec),
    Metric.value(dataplaneEdgeDisplayDatagramsDeclaredLost),
    Metric.value(dataplaneEdgeDisplayDatagramsOutcomeUnknown),
    Metric.value(dataplaneRowsDeclaredLost),
    Metric.value(dataplaneDirectWtIncomingExpected),
    Metric.value(dataplaneDirectWtIncomingUnexpected),
    Metric.value(dataplaneDirectWtAdmitted),
    Metric.value(dataplaneNatKeepalivesSent),
    Metric.value(dataplaneNatPunchBurstsSent),
    Metric.value(dataplaneNatPunchRefusedNotGlobal),
    Metric.value(dataplaneNatPunchRefusedRateLimited),
    Metric.value(dataplaneNatSideChannelSendFailures),
    Metric.value(dataplaneDatagramSendFailures),
    Metric.value(dataplaneQuicPacketsSent),
    Metric.value(dataplaneQuicPacketsLost),
    Metric.value(dataplaneUnackedDatagramsMax),
    Metric.value(dataplaneWebtransportRttUs),
    Metric.value(dataplaneEdgeRttUs),
    Metric.value(dataplaneStatsEventsDropped),
    Metric.value(dataplaneRebindRequests),
    Metric.value(dataplaneRebindAccepted),
    Metric.value(dataplaneRebindCommitted),
    Metric.value(dataplaneRebindRefused),
    Metric.value(dataplaneRebindEnvelopesRejected),
    Metric.value(dataplaneRebindEventsSuppressed),
  ] as const);

  return {
    health,
    metrics: {
      controlReconnectOutcomes: frequencyRecord(reconnect.occurrences),
      controlRegistrationOutcomes: frequencyRecord(registration.occurrences),
      controlPingOutcomes: frequencyRecord(ping.occurrences),
      dataplaneRestartOutcomes: frequencyRecord(dataplaneRestart.occurrences),
      dataplaneAckTimeouts: Number(dataplaneAckTimeouts.count),
      dataplaneReady: Number(dataplaneReady.value),
      dataplaneTransport: {
        rowVersionsSent: Number(rowVersionsSent.count),
        rowVersionsSupersededUnapplied: Number(rowVersionsSupersededUnapplied.count),
        rowResendsIdentical: Number(rowResendsIdentical.count),
        fecRepairsSent: Number(fecRepairsSent.count),
        fecRepairsRefused: Number(fecRepairsRefused.count),
        resyncRowsRequested: Number(resyncRowsRequested.count),
        directDisplayDatagramsReceived: Number(directDisplayDatagramsReceived.count),
        directDisplayDatagramsRecoveredByFec: Number(directDisplayDatagramsRecoveredByFec.count),
        directDisplayDatagramsDeclaredLost: Number(directDisplayDatagramsDeclaredLost.count),
        directDisplayDatagramsOutcomeUnknown: Number(directDisplayDatagramsOutcomeUnknown.count),
        edgeDisplayDatagramsReceived: Number(edgeDisplayDatagramsReceived.count),
        edgeDisplayDatagramsRecoveredByFec: Number(edgeDisplayDatagramsRecoveredByFec.count),
        edgeDisplayDatagramsDeclaredLost: Number(edgeDisplayDatagramsDeclaredLost.count),
        edgeDisplayDatagramsOutcomeUnknown: Number(edgeDisplayDatagramsOutcomeUnknown.count),
        rowsDeclaredLost: Number(rowsDeclaredLost.count),
        directWtIncomingExpected: Number(directWtIncomingExpected.count),
        directWtIncomingUnexpected: Number(directWtIncomingUnexpected.count),
        directWtAdmitted: Number(directWtAdmitted.count),
        natKeepalivesSent: Number(natKeepalivesSent.count),
        natPunchBurstsSent: Number(natPunchBurstsSent.count),
        natPunchRefusedNotGlobal: Number(natPunchRefusedNotGlobal.count),
        natPunchRefusedRateLimited: Number(natPunchRefusedRateLimited.count),
        natSideChannelSendFailures: Number(natSideChannelSendFailures.count),
        datagramSendFailures: Number(datagramSendFailures.count),
        quicPacketsSent: Number(quicPacketsSent.count),
        quicPacketsLost: Number(quicPacketsLost.count),
        unackedDatagramsMax: Number(unackedDatagramsMax.value),
        webtransportRttUs: Number(webtransportRttUs.value),
        edgeRttUs: Number(edgeRttUs.value),
        statsEventsDropped: Number(statsEventsDropped.value),
        rebindRequests: Number(rebindRequests.value),
        rebindAccepted: Number(rebindAccepted.value),
        rebindCommitted: Number(rebindCommitted.value),
        rebindRefused: Number(rebindRefused.value),
        rebindEnvelopesRejected: Number(rebindEnvelopesRejected.value),
        rebindEventsSuppressed: Number(rebindEventsSuppressed.value),
      },
      latestDataplaneTransport,
    },
  };
});

export function runDaemonObservabilityReporterEffect(
  daemonId: string,
  interval: Duration.Input = DEFAULT_HEALTH_LOG_INTERVAL,
): Effect.Effect<never, never, DaemonHealthServiceTag> {
  return Effect.gen(function* () {
    while (true) {
      yield* Effect.gen(function* () {
        const snapshot = yield* daemonObservabilitySnapshot;
        yield* logEffect('info', 'daemon', 'daemon_health_snapshot', {
          daemonId,
          ...snapshot,
        });
      }).pipe(
        Effect.withLogSpan('daemon.health.snapshot'),
        Effect.withSpan('daemon.health.snapshot'),
      );
      yield* Effect.sleep(interval);
    }
  });
}

export type DataplaneMetricEvent =
  | { readonly type: 'restart'; readonly reason: string }
  | { readonly type: 'ack_timeout' }
  | { readonly type: 'state'; readonly state: 'ready' | 'down' }
  | { readonly type: 'transport_stats'; readonly stats: DataplaneTransportStats }
  | {
      readonly type: 'session_rebind';
      readonly outcome: string;
      readonly sessionId: string;
      readonly generation: number;
      readonly attemptMs: number;
    };

export function recordControlReconnectOutcome(outcome: string): Effect.Effect<void> {
  return Metric.update(daemonControlReconnectOutcomes, outcome);
}

export function recordControlRegistrationOutcome(outcome: string): Effect.Effect<void> {
  return Metric.update(daemonControlRegistrationOutcomes, outcome);
}

export function recordControlPingOutcome(outcome: string): Effect.Effect<void> {
  return Metric.update(daemonControlPingOutcomes, outcome);
}

/**
 * Rolling window of control-ping round-trip times, in milliseconds.
 *
 * The daemon's own view of the round trip the server measures as
 * `merkur_daemon_control_delivery_latency_ms`. Having both sides is what turns
 * a single end-to-end number into an attributed one: the gap between them is
 * the server's inbound queueing plus its Redis presence work.
 *
 * A fixed `Float64Array` rather than a growing array: one subtraction and one
 * store per pong, every two seconds, with no allocation after startup.
 */
const PING_RTT_CAPACITY = 64;
const pingRttMs = new Float64Array(PING_RTT_CAPACITY);
let pingRttWrite = 0;
let pingRttCount = 0;

export function recordControlPingRttMs(rttMs: number): void {
  if (!Number.isFinite(rttMs) || rttMs < 0) return;
  pingRttMs[pingRttWrite] = rttMs;
  pingRttWrite = (pingRttWrite + 1) % PING_RTT_CAPACITY;
  if (pingRttCount < PING_RTT_CAPACITY) pingRttCount += 1;
}

export interface PingRttSummary {
  readonly count: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly maxMs: number;
}

let suspensionGapMsMax = 0;

/**
 * The ping producer overslept its cadence by more than the suspension threshold:
 * the process was suspended and has resumed. Only the largest gap in a window is
 * kept, which is what the fleet histogram asks for.
 */
export function recordSuspensionGapMs(gapMs: number): void {
  if (!Number.isFinite(gapMs) || gapMs <= suspensionGapMsMax) return;
  suspensionGapMsMax = gapMs;
}

/** The largest gap since the previous drain, then zero: each report covers one window. */
export function drainSuspensionGapMsMax(): number {
  const max = suspensionGapMsMax;
  suspensionGapMsMax = 0;
  return max;
}

/**
 * Summarise and clear the ping-RTT window.
 *
 * Draining is deliberate: each report covers one window, so a window with no
 * pongs must report `count: 0` rather than restating the previous one.
 */
export function drainControlPingRtt(): PingRttSummary {
  if (pingRttCount === 0) {
    return { count: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 };
  }
  const samples = Array.from(pingRttMs.subarray(0, pingRttCount)).sort((a, b) => a - b);
  const count = samples.length;
  pingRttWrite = 0;
  pingRttCount = 0;
  return {
    count,
    p50Ms: Math.round(nearestRank(samples, 0.5)),
    p95Ms: Math.round(nearestRank(samples, 0.95)),
    maxMs: Math.round(samples[count - 1] ?? 0),
  };
}

/** Nearest-rank percentile over an ascending array, matching the browser recorder. */
function nearestRank(sorted: readonly number[], ratio: number): number {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index] ?? 0;
}

export function recordDataplaneMetricEvent(event: DataplaneMetricEvent): Effect.Effect<void> {
  switch (event.type) {
    case 'restart':
      return Metric.update(daemonDataplaneRestartOutcomes, event.reason);
    case 'ack_timeout':
      return Metric.update(daemonDataplaneAckTimeouts, 1);
    case 'state':
      return Effect.all(
        [
          Metric.update(daemonDataplaneReady, event.state === 'ready' ? 1 : 0),
          Effect.sync(() => {
            if (event.state === 'down') latestDataplaneTransport = null;
          }),
        ],
        { discard: true },
      );
    case 'transport_stats':
      return recordTransportStats(event.stats);
    case 'session_rebind':
      return recordSessionRebind(event);
  }
}

/**
 * One carrier-rebind outcome: a metric label and a span.
 *
 * The split is the whole design. `outcome` is a closed 34-value set and is safe
 * to aggregate on; `sessionId` is unbounded and reaches only the span, where it
 * is what joins this to the browser's own `carrier_recovery` rows in
 * `merkur-perf`. Effect's metric registry has no eviction path, so a session
 * id on the metric would leak a registry entry for the life of the daemon.
 *
 * This runs on the bounded metric queue's worker fiber, which is under the
 * provided layers and therefore has the tracer. Creating the span on the
 * synchronous IPC frame handler instead would use the default runtime, where it
 * is created and never exported.
 */
function recordSessionRebind(event: {
  readonly outcome: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly attemptMs: number;
}): Effect.Effect<void> {
  return Metric.update(daemonRebindOutcomes, event.outcome).pipe(
    Effect.withSpan('daemon.session.rebind', {
      attributes: spanAttributes({
        'merkur.session.id': event.sessionId,
        'merkur.rebind_outcome': event.outcome,
        'merkur.rebind_generation': event.generation,
        'merkur.rebind_attempt_ms': event.attemptMs,
      }),
    }),
  );
}

function addBounded(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right);
}

function minimumNonZero(left: number, right: number): number {
  if (left === 0) return right;
  if (right === 0) return left;
  return Math.min(left, right);
}

/** Fold one ten-second carrier window into process-lifetime matrix evidence. */
function aggregateTransportPath(
  previous: DataplanePathStats,
  current: DataplanePathStats,
): DataplanePathStats {
  return {
    pathsAvailable: Math.max(previous.pathsAvailable, current.pathsAvailable),
    pathsLive: Math.max(previous.pathsLive, current.pathsLive),
    rttEwmaUsMax: Math.max(previous.rttEwmaUsMax, current.rttEwmaUsMax),
    networkRttEwmaUsMax: Math.max(previous.networkRttEwmaUsMax, current.networkRttEwmaUsMax),
    jitterEwmaUsMax: Math.max(previous.jitterEwmaUsMax, current.jitterEwmaUsMax),
    sendFailuresMax: Math.max(previous.sendFailuresMax, current.sendFailuresMax),
    lastAckAgeMsMax: Math.max(previous.lastAckAgeMsMax, current.lastAckAgeMsMax),
    displayDatagramsReceived: addBounded(
      previous.displayDatagramsReceived,
      current.displayDatagramsReceived,
    ),
    displayDatagramsRecoveredByFec: addBounded(
      previous.displayDatagramsRecoveredByFec,
      current.displayDatagramsRecoveredByFec,
    ),
    displayDatagramsDeclaredLost: addBounded(
      previous.displayDatagramsDeclaredLost,
      current.displayDatagramsDeclaredLost,
    ),
    displayDatagramsOutcomeUnknown: addBounded(
      previous.displayDatagramsOutcomeUnknown,
      current.displayDatagramsOutcomeUnknown,
    ),
    quicSentPackets: addBounded(previous.quicSentPackets, current.quicSentPackets),
    quicLostPackets: addBounded(previous.quicLostPackets, current.quicLostPackets),
    quicLostBytes: addBounded(previous.quicLostBytes, current.quicLostBytes),
    quicCongestionEvents: addBounded(previous.quicCongestionEvents, current.quicCongestionEvents),
    quicBlackHoles: addBounded(previous.quicBlackHoles, current.quicBlackHoles),
    quicDatagramsTx: addBounded(previous.quicDatagramsTx, current.quicDatagramsTx),
    quicDatagramsRx: addBounded(previous.quicDatagramsRx, current.quicDatagramsRx),
    quicUdpTxBytes: addBounded(previous.quicUdpTxBytes, current.quicUdpTxBytes),
    quicUdpRxBytes: addBounded(previous.quicUdpRxBytes, current.quicUdpRxBytes),
    quicMtuMin: minimumNonZero(previous.quicMtuMin, current.quicMtuMin),
    quicCwndBytesMin: minimumNonZero(previous.quicCwndBytesMin, current.quicCwndBytesMin),
    quicRttUsMax: Math.max(previous.quicRttUsMax, current.quicRttUsMax),
  };
}

function aggregateTransportStats(
  previous: DataplaneTransportStats,
  current: DataplaneTransportStats,
): DataplaneTransportStats {
  return {
    windowMs: addBounded(previous.windowMs, current.windowMs),
    peers: Math.max(previous.peers, current.peers),
    parkedPeers: Math.max(previous.parkedPeers, current.parkedPeers),
    webtransport: aggregateTransportPath(previous.webtransport, current.webtransport),
    edge: aggregateTransportPath(previous.edge, current.edge),
    rowVersionsSent: addBounded(previous.rowVersionsSent, current.rowVersionsSent),
    rowVersionsSupersededUnapplied: addBounded(
      previous.rowVersionsSupersededUnapplied,
      current.rowVersionsSupersededUnapplied,
    ),
    rowVersionsSupersededApplied: addBounded(
      previous.rowVersionsSupersededApplied,
      current.rowVersionsSupersededApplied,
    ),
    rowResendsIdentical: addBounded(previous.rowResendsIdentical, current.rowResendsIdentical),
    stalePreparedFlushesSent: addBounded(
      previous.stalePreparedFlushesSent,
      current.stalePreparedFlushesSent,
    ),
    burstsAbandoned: addBounded(previous.burstsAbandoned, current.burstsAbandoned),
    burstsUnsafeToRewind: addBounded(previous.burstsUnsafeToRewind, current.burstsUnsafeToRewind),
    datagramSendFailures: addBounded(previous.datagramSendFailures, current.datagramSendFailures),
    fecRepairsSent: addBounded(previous.fecRepairsSent, current.fecRepairsSent),
    fecRepairsRefused: addBounded(previous.fecRepairsRefused, current.fecRepairsRefused),
    resyncRowsRequested: addBounded(previous.resyncRowsRequested, current.resyncRowsRequested),
    rowsDeclaredLost: addBounded(previous.rowsDeclaredLost, current.rowsDeclaredLost),
    unackedDatagramsMax: Math.max(previous.unackedDatagramsMax, current.unackedDatagramsMax),
    edgeReliableQueuedBytesMax: Math.max(
      previous.edgeReliableQueuedBytesMax,
      current.edgeReliableQueuedBytesMax,
    ),
    // The remaining counters are already process-lifetime values in the Rust
    // sample. Retain their maximum instead of summing repeated observations.
    inboundDatagramDropsWt: Math.max(
      previous.inboundDatagramDropsWt,
      current.inboundDatagramDropsWt,
    ),
    inboundDatagramDropsEdge: Math.max(
      previous.inboundDatagramDropsEdge,
      current.inboundDatagramDropsEdge,
    ),
    overCapacitySessionRejections: Math.max(
      previous.overCapacitySessionRejections,
      current.overCapacitySessionRejections,
    ),
    directWtIncomingExpected: Math.max(
      previous.directWtIncomingExpected,
      current.directWtIncomingExpected,
    ),
    directWtIncomingUnexpected: Math.max(
      previous.directWtIncomingUnexpected,
      current.directWtIncomingUnexpected,
    ),
    directWtAdmitted: Math.max(previous.directWtAdmitted, current.directWtAdmitted),
    natKeepalivesSent: Math.max(previous.natKeepalivesSent, current.natKeepalivesSent),
    natPunchBurstsSent: Math.max(previous.natPunchBurstsSent, current.natPunchBurstsSent),
    natPunchRefusedNotGlobal: Math.max(
      previous.natPunchRefusedNotGlobal,
      current.natPunchRefusedNotGlobal,
    ),
    natPunchRefusedRateLimited: Math.max(
      previous.natPunchRefusedRateLimited,
      current.natPunchRefusedRateLimited,
    ),
    natSideChannelSendFailed: Math.max(
      previous.natSideChannelSendFailed,
      current.natSideChannelSendFailed,
    ),
    natSideChannelWouldBlock: Math.max(
      previous.natSideChannelWouldBlock,
      current.natSideChannelWouldBlock,
    ),
    statsEventsDropped: Math.max(previous.statsEventsDropped, current.statsEventsDropped),
    rebindRequests: Math.max(previous.rebindRequests, current.rebindRequests),
    rebindAccepted: Math.max(previous.rebindAccepted, current.rebindAccepted),
    rebindCommitted: Math.max(previous.rebindCommitted, current.rebindCommitted),
    rebindRefused: Math.max(previous.rebindRefused, current.rebindRefused),
    rebindEnvelopesRejected: Math.max(
      previous.rebindEnvelopesRejected,
      current.rebindEnvelopesRejected,
    ),
    rebindEventsSuppressed: Math.max(
      previous.rebindEventsSuppressed,
      current.rebindEventsSuppressed,
    ),
  };
}

/**
 * Fold one dataplane telemetry sample into the daemon's Effect metrics.
 *
 * Counters take the sample's interval delta directly; gauges take the sample's
 * instantaneous value. Nothing here is tagged per peer or per transport beyond
 * the fixed `webtransport`/`edge` split already baked into the metric names,
 * because Effect's metric registry has no eviction path and a per-entity
 * attribute would leak a registry entry for the life of the process.
 */
function recordTransportStats(stats: DataplaneTransportStats): Effect.Effect<void> {
  return Effect.gen(function* () {
    // These native counters are process-lifetime readings, unlike the display
    // and QUIC interval deltas. Add only new observations to Effect counters;
    // adding the absolute value on each heartbeat invented connection churn.
    // A dataplane-down event clears this cursor; a lower reading also denotes
    // a native reset, whose current reading is all the newly observed activity.
    const previous = latestDataplaneTransport?.latest;
    yield* Effect.all(
      [
        Metric.update(dataplaneRowVersionsSent, stats.rowVersionsSent),
        Metric.update(
          dataplaneRowVersionsSupersededUnapplied,
          stats.rowVersionsSupersededUnapplied,
        ),
        Metric.update(dataplaneRowResendsIdentical, stats.rowResendsIdentical),
        Metric.update(dataplaneFecRepairsSent, stats.fecRepairsSent),
        Metric.update(dataplaneFecRepairsRefused, stats.fecRepairsRefused),
        Metric.update(dataplaneResyncRowsRequested, stats.resyncRowsRequested),
        Metric.update(
          dataplaneDirectDisplayDatagramsReceived,
          stats.webtransport.displayDatagramsReceived,
        ),
        Metric.update(
          dataplaneDirectDisplayDatagramsRecoveredByFec,
          stats.webtransport.displayDatagramsRecoveredByFec,
        ),
        Metric.update(
          dataplaneDirectDisplayDatagramsDeclaredLost,
          stats.webtransport.displayDatagramsDeclaredLost,
        ),
        Metric.update(
          dataplaneDirectDisplayDatagramsOutcomeUnknown,
          stats.webtransport.displayDatagramsOutcomeUnknown,
        ),
        Metric.update(dataplaneEdgeDisplayDatagramsReceived, stats.edge.displayDatagramsReceived),
        Metric.update(
          dataplaneEdgeDisplayDatagramsRecoveredByFec,
          stats.edge.displayDatagramsRecoveredByFec,
        ),
        Metric.update(
          dataplaneEdgeDisplayDatagramsDeclaredLost,
          stats.edge.displayDatagramsDeclaredLost,
        ),
        Metric.update(
          dataplaneEdgeDisplayDatagramsOutcomeUnknown,
          stats.edge.displayDatagramsOutcomeUnknown,
        ),
        Metric.update(dataplaneRowsDeclaredLost, stats.rowsDeclaredLost),
        Metric.update(
          dataplaneDirectWtIncomingExpected,
          nativeCounterDelta(stats.directWtIncomingExpected, previous?.directWtIncomingExpected),
        ),
        Metric.update(
          dataplaneDirectWtIncomingUnexpected,
          nativeCounterDelta(
            stats.directWtIncomingUnexpected,
            previous?.directWtIncomingUnexpected,
          ),
        ),
        Metric.update(
          dataplaneDirectWtAdmitted,
          nativeCounterDelta(stats.directWtAdmitted, previous?.directWtAdmitted),
        ),
        Metric.update(dataplaneRebindRequests, stats.rebindRequests),
        Metric.update(dataplaneRebindAccepted, stats.rebindAccepted),
        Metric.update(dataplaneRebindCommitted, stats.rebindCommitted),
        Metric.update(dataplaneRebindRefused, stats.rebindRefused),
        Metric.update(dataplaneRebindEnvelopesRejected, stats.rebindEnvelopesRejected),
        Metric.update(dataplaneRebindEventsSuppressed, stats.rebindEventsSuppressed),
        Metric.update(
          dataplaneNatKeepalivesSent,
          nativeCounterDelta(stats.natKeepalivesSent, previous?.natKeepalivesSent),
        ),
        Metric.update(
          dataplaneNatPunchBurstsSent,
          nativeCounterDelta(stats.natPunchBurstsSent, previous?.natPunchBurstsSent),
        ),
        Metric.update(
          dataplaneNatPunchRefusedNotGlobal,
          nativeCounterDelta(stats.natPunchRefusedNotGlobal, previous?.natPunchRefusedNotGlobal),
        ),
        Metric.update(
          dataplaneNatPunchRefusedRateLimited,
          nativeCounterDelta(
            stats.natPunchRefusedRateLimited,
            previous?.natPunchRefusedRateLimited,
          ),
        ),
        Metric.update(
          dataplaneNatSideChannelSendFailures,
          nativeCounterDelta(stats.natSideChannelSendFailed, previous?.natSideChannelSendFailed) +
            nativeCounterDelta(stats.natSideChannelWouldBlock, previous?.natSideChannelWouldBlock),
        ),
        Metric.update(dataplaneDatagramSendFailures, stats.datagramSendFailures),
        Metric.update(
          dataplaneQuicPacketsSent,
          stats.webtransport.quicSentPackets + stats.edge.quicSentPackets,
        ),
        Metric.update(
          dataplaneQuicPacketsLost,
          stats.webtransport.quicLostPackets + stats.edge.quicLostPackets,
        ),
        Metric.update(dataplaneUnackedDatagramsMax, stats.unackedDatagramsMax),
        Metric.update(dataplaneWebtransportRttUs, stats.webtransport.networkRttEwmaUsMax),
        Metric.update(dataplaneEdgeRttUs, stats.edge.networkRttEwmaUsMax),
        Metric.update(dataplaneStatsEventsDropped, stats.statsEventsDropped),
      ],
      { discard: true },
    );
    const observedAtMs = yield* Clock.currentTimeMillis;
    // Assignment follows every metric update, so a health reporter can never
    // expose a newer raw sample beside older aggregate counters. The validated
    // IPC object is immutable after dispatch and fixed-size by protocol.
    latestDataplaneTransport = {
      observedAtMs,
      sampleCount: addBounded(latestDataplaneTransport?.sampleCount ?? 0, 1),
      latest: stats,
      aggregate:
        latestDataplaneTransport === null
          ? stats
          : aggregateTransportStats(latestDataplaneTransport.aggregate, stats),
    };
  });
}

function nativeCounterDelta(current: number, previous = 0): number {
  return current < previous ? current : current - previous;
}

function initialHealthState(): DaemonHealthState {
  const startingAt = 0;
  return {
    control: {
      state: 'starting',
      stable: false,
      connectionId: null,
      reconnectDelayMs: null,
      lastFailure: null,
      updatedAt: startingAt,
    },
    dataplane: {
      state: 'starting',
      updatedAt: startingAt,
    },
  };
}

function healthSnapshot(health: DaemonHealthState, checkedAt: number): DaemonHealthSnapshot {
  const ready = health.control.state === 'registered' && health.dataplane.state === 'ready';
  return {
    status: ready ? 'ready' : 'not_ready',
    ready,
    checkedAt,
    ...health,
  };
}

function frequencyRecord(
  occurrences: ReadonlyMap<string, number>,
): Readonly<Record<string, number>> {
  return Object.fromEntries(occurrences);
}
