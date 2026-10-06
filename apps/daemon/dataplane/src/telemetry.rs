//! Periodic transport/display statistics, emitted to the daemon over IPC.
//!
//! # Why this costs nothing on the hot path
//!
//! Every value here comes from one of three places, none of which adds work to
//! a per-frame or per-keystroke path:
//!
//! 1. **State the owner loop already maintains.** `PathHealth`,
//!    `DisplayWasteCounters` and `AdaptiveTransportState`
//!    and `sent_datagrams` are written on the hot path *today*; reading them
//!    later is a plain field load from an owner-loop-owned struct. In
//!    particular `DisplayWasteCounters` was already being maintained at full
//!    hot-path cost and then discarded unless `MERKUR_PERF_LOG=1` — shipping
//!    it is free.
//! 2. **Process-global atomics that already exist**, read `Relaxed` at 0.1 Hz.
//! 3. **quinn `ConnectionStats`**, which quinn accumulates whether or not
//!    anyone reads it. `stats()` takes the per-connection state mutex the QUIC
//!    driver holds during packet I/O, which is precisely why it is called once
//!    per peer per ten seconds and never on a frame path.
//!
//! # Shape
//!
//! The payload is a fixed set of unsigned integers whose size does not depend
//! on peer count: per-transport values are aggregated with `max` or `sum`. That
//! removes the multi-peer growth problem by construction, and keeps peer
//! identity off the wire so nothing downstream can turn it into an unbounded
//! metric label.

use crate::connection::{DisplayDatagramOutcomeCounters, PeerDisplayState, PeerMap, PeerTransport};
use crate::display::planner::CarrierDeliveryQuote;
use crate::ipc::events::{EVT_TRANSPORT_STATS, EventSink, PathStatsEvt, TransportStatsEvt};
use crate::session::policy::SessionPolicy;
use crate::session::resume::ParkedPeers;
use crate::webtransport::WebTransportState;
use std::sync::Arc;
use tokio::sync::RwLock;

pub(crate) fn delivery_quote(state: wtransport::quinn::DeliveryState) -> CarrierDeliveryQuote {
    let sent = state.sent_packets as f64;
    let lost = state.lost_packets as f64;
    // Jeffreys-style bounded cold prior and a one-sided normal upper bound.
    // This is deliberately uncertainty-bearing; a zero-loss short session is
    // not treated as proof of a lossless path.
    let loss_mean = (lost + 0.5) / (sent + 1.0);
    let loss_variance = loss_mean * (1.0 - loss_mean) / (sent + 2.0);
    CarrierDeliveryQuote {
        one_way_us: state.rtt.as_secs_f64() * 500_000.0,
        jitter_upper_us: 0.0,
        congestion_window_bytes: state.cwnd,
        bytes_in_flight: state
            .bytes_in_flight
            .saturating_sub(state.image_bytes_in_flight),
        send_buffer_occupied_bytes: crate::webtransport::DATAGRAM_SEND_BUFFER_BYTES
            .saturating_sub(state.datagram_send_buffer_space),
        mtu_bytes: usize::from(state.current_mtu),
        pacing_rate_bps: state.pacing_rate.unwrap_or(0),
        loss_upper: (loss_mean + 1.645 * loss_variance.sqrt()).clamp(0.0, 1.0),
        serial_hops: None,
    }
}

pub(crate) fn edge_downstream_quote(
    state: crate::edge_tunnel::EdgeDownstreamDeliveryQuote,
) -> CarrierDeliveryQuote {
    let sent = state.sent_packets as f64;
    let lost = state.lost_packets as f64;
    let loss_mean = (lost + 0.5) / (sent + 1.0);
    let loss_variance = loss_mean * (1.0 - loss_mean) / (sent + 2.0);
    CarrierDeliveryQuote {
        one_way_us: state.rtt_us as f64 * 0.5,
        jitter_upper_us: 0.0,
        congestion_window_bytes: state.congestion_window_bytes,
        bytes_in_flight: state.bytes_in_flight,
        send_buffer_occupied_bytes: usize::try_from(state.send_buffer_occupied_bytes)
            .unwrap_or(usize::MAX),
        mtu_bytes: usize::from(state.mtu_bytes),
        pacing_rate_bps: state.pacing_rate_bps,
        loss_upper: (loss_mean + 1.645 * loss_variance.sqrt()).clamp(0.0, 1.0),
        serial_hops: None,
    }
}

pub(crate) fn serial_delivery_quote(
    upstream: CarrierDeliveryQuote,
    downstream: CarrierDeliveryQuote,
) -> CarrierDeliveryQuote {
    CarrierDeliveryQuote::serial(upstream, downstream)
}
use tracing::warn;
use wtransport::quinn::ConnectionStats;

/// Emit one sample every this many heartbeat ticks.
///
/// The heartbeat timer is 2 s, so this is a 10 s cadence. Two seconds would be
/// five times the IPC frames for a delta window too short to produce a
/// meaningful loss ratio on a keystroke workload; thirty seconds would average
/// a transient loss burst away entirely inside one daemon health snapshot.
pub(crate) const STATS_TICKS_PER_SAMPLE: u32 = 5;

/// Cumulative QUIC counters captured at the previous sample, per transport.
#[derive(Debug, Default, Clone, Copy)]
struct QuicCursor {
    /// The connection these readings came from (`stable_id`). A direct
    /// redial or an edge re-attach replaces it under a surviving peer, and the
    /// replacement's counters start again at zero.
    connection: Option<usize>,
    sent_packets: u64,
    lost_packets: u64,
    lost_bytes: u64,
    spurious_lost_packets: u64,
    spurious_lost_bytes: u64,
    congestion_events: u64,
    black_holes: u64,
    datagrams_tx: u64,
    datagrams_rx: u64,
    udp_tx_bytes: u64,
    udp_rx_bytes: u64,
}

impl QuicCursor {
    /// Fold a reading from `connection` into `out`, advancing the cursor.
    fn advance(&mut self, connection: usize, stats: &ConnectionStats, out: &mut PathStatsEvt) {
        if self.connection != Some(connection) {
            *self = Self {
                connection: Some(connection),
                ..Self::default()
            };
        }
        // Every counter only rises within one connection. Saturating keeps a
        // diagnostic from ever panicking the dataplane.
        fn delta(previous: &mut u64, current: u64) -> u64 {
            let value = current.saturating_sub(*previous);
            *previous = current;
            value
        }

        out.quic_sent_packets = delta(&mut self.sent_packets, stats.path.sent_packets);
        // Losses the peer later acknowledged were reordering. Each counter is
        // monotonic on its own; a proof that lands in the interval after its
        // declaration leaves that earlier interval counted.
        out.quic_lost_packets = delta(&mut self.lost_packets, stats.path.lost_packets)
            .saturating_sub(delta(
                &mut self.spurious_lost_packets,
                stats.path.spurious_lost_packets,
            ));
        out.quic_lost_bytes = delta(&mut self.lost_bytes, stats.path.lost_bytes).saturating_sub(
            delta(&mut self.spurious_lost_bytes, stats.path.spurious_lost_bytes),
        );
        out.quic_congestion_events =
            delta(&mut self.congestion_events, stats.path.congestion_events);
        out.quic_black_holes = delta(&mut self.black_holes, stats.path.black_holes_detected);
        out.quic_datagrams_tx = delta(&mut self.datagrams_tx, stats.frame_tx.datagram);
        out.quic_datagrams_rx = delta(&mut self.datagrams_rx, stats.frame_rx.datagram);
        out.quic_udp_tx_bytes = delta(&mut self.udp_tx_bytes, stats.udp_tx.bytes);
        out.quic_udp_rx_bytes = delta(&mut self.udp_rx_bytes, stats.udp_rx.bytes);

        out.quic_mtu_min = min_positive(out.quic_mtu_min, u32::from(stats.path.current_mtu));
        out.quic_cwnd_bytes_min = min_positive_u64(out.quic_cwnd_bytes_min, stats.path.cwnd);
        out.quic_rtt_us_max = out.quic_rtt_us_max.max(duration_to_us_u32(stats.path.rtt));
    }
}

/// Cumulative display-waste counters captured at the previous sample.
#[derive(Debug, Default, Clone, Copy)]
struct WasteCursor {
    row_versions_sent: u64,
    row_versions_superseded_unapplied: u64,
    row_versions_superseded_applied: u64,
    row_resends_identical: u64,
    stale_prepared_flushes_sent: u64,
    bursts_abandoned: u64,
    bursts_unsafe_to_rewind: u64,
    datagram_send_failures: u64,
    fec_repairs_sent: u64,
    fec_repairs_refused: u64,
    resync_rows_requested: u64,
    rows_declared_lost: u64,
}

/// Per-peer previous-interval readings. Pruned with the peer that owns it.
#[derive(Debug, Default, Clone, Copy)]
pub(crate) struct PeerTelemetryCursor {
    webtransport: QuicCursor,
    edge: QuicCursor,
    webtransport_display: DisplayDatagramOutcomeCounters,
    edge_display: DisplayDatagramOutcomeCounters,
    waste: WasteCursor,
}

fn counter_delta(previous: &mut u64, current: u64) -> u64 {
    // Display counters are monotonic for the life of a peer. Guard a reset
    // anyway rather than underflowing into a nonsense interval spike.
    let value = current.saturating_sub(*previous);
    *previous = current;
    value
}

/// Clamp a millisecond `f64` EWMA to integer microseconds.
///
/// Non-finite and negative inputs collapse to zero rather than propagating. A
/// `NaN` would serialize as JSON `null`, which the TypeScript validator rejects,
/// and an invalid event payload is fatal on the daemon side — a diagnostic must
/// never be able to kill the dataplane.
fn ms_to_us_u32(value: f64) -> u32 {
    if value.is_finite() && value > 0.0 {
        (value * 1_000.0).min(f64::from(u32::MAX)) as u32
    } else {
        0
    }
}

/// Clamp a millisecond `f64` to whole milliseconds.
fn ms_to_u32(value: f64) -> u32 {
    if value.is_finite() && value > 0.0 {
        value.min(f64::from(u32::MAX)) as u32
    } else {
        0
    }
}

fn duration_to_us_u32(value: std::time::Duration) -> u32 {
    u32::try_from(value.as_micros()).unwrap_or(u32::MAX)
}

/// `min` that treats zero as "unset", so the first real reading wins.
fn min_positive(current: u32, candidate: u32) -> u32 {
    if candidate == 0 {
        return current;
    }
    if current == 0 {
        candidate
    } else {
        current.min(candidate)
    }
}

fn min_positive_u64(current: u64, candidate: u64) -> u64 {
    if candidate == 0 {
        return current;
    }
    if current == 0 {
        candidate
    } else {
        current.min(candidate)
    }
}

/// Fold one peer's path health for `transport` into the per-transport aggregate.
fn accumulate_path_health(
    peer: &PeerDisplayState,
    transport: PeerTransport,
    now_ms: f64,
    out: &mut PathStatsEvt,
) {
    let health = match transport {
        PeerTransport::WebTransport => &peer.paths.webtransport,
        PeerTransport::Edge => &peer.paths.edge,
    };

    if health.available {
        out.paths_available += 1;
    }
    if health.is_live(now_ms, SessionPolicy::PATH_STALE_THRESHOLD_MS) {
        out.paths_live += 1;
    }
    out.rtt_ewma_us_max = out.rtt_ewma_us_max.max(ms_to_us_u32(health.rtt_ewma_ms));
    out.network_rtt_ewma_us_max = out
        .network_rtt_ewma_us_max
        .max(ms_to_us_u32(health.network_rtt_ewma_ms));
    out.jitter_ewma_us_max = out
        .jitter_ewma_us_max
        .max(ms_to_us_u32(health.jitter_ewma_ms));
    out.send_failures_max = out.send_failures_max.max(health.consecutive_send_failures);
    if health.last_ack_at_ms > 0.0 {
        out.last_ack_age_ms_max = out
            .last_ack_age_ms_max
            .max(ms_to_u32(now_ms - health.last_ack_at_ms));
    }
}

/// Fold one peer's display-waste deltas into the sample.
fn accumulate_waste(peer: &mut PeerDisplayState, out: &mut TransportStatsEvt) {
    let waste = peer.display_cache.waste;
    let cursor = &mut peer.telemetry_cursor.waste;

    out.row_versions_sent += counter_delta(&mut cursor.row_versions_sent, waste.row_versions_sent);
    out.row_versions_superseded_unapplied += counter_delta(
        &mut cursor.row_versions_superseded_unapplied,
        waste.row_versions_superseded_unapplied,
    );
    out.row_versions_superseded_applied += counter_delta(
        &mut cursor.row_versions_superseded_applied,
        waste.row_versions_superseded_applied,
    );
    out.row_resends_identical += counter_delta(
        &mut cursor.row_resends_identical,
        waste.row_resends_identical,
    );
    out.stale_prepared_flushes_sent += counter_delta(
        &mut cursor.stale_prepared_flushes_sent,
        waste.stale_prepared_flushes_sent,
    );
    out.bursts_abandoned += counter_delta(&mut cursor.bursts_abandoned, waste.bursts_abandoned);
    out.bursts_unsafe_to_rewind += counter_delta(
        &mut cursor.bursts_unsafe_to_rewind,
        waste.bursts_unsafe_to_rewind,
    );
    out.datagram_send_failures += counter_delta(
        &mut cursor.datagram_send_failures,
        waste.datagram_send_failures,
    );
    out.fec_repairs_sent += counter_delta(&mut cursor.fec_repairs_sent, waste.fec_repairs_sent);
    out.fec_repairs_refused +=
        counter_delta(&mut cursor.fec_repairs_refused, waste.fec_repairs_refused);
    out.resync_rows_requested += counter_delta(
        &mut cursor.resync_rows_requested,
        waste.resync_rows_requested,
    );
    out.rows_declared_lost +=
        counter_delta(&mut cursor.rows_declared_lost, waste.rows_declared_lost);
}

fn accumulate_datagram_outcomes(
    peer: &mut PeerDisplayState,
    transport: PeerTransport,
    out: &mut PathStatsEvt,
) {
    let current = peer.display_cache.datagram_outcomes.get(transport);
    let cursor = match transport {
        PeerTransport::WebTransport => &mut peer.telemetry_cursor.webtransport_display,
        PeerTransport::Edge => &mut peer.telemetry_cursor.edge_display,
    };
    out.display_datagrams_received += counter_delta(&mut cursor.received, current.received);
    out.display_datagrams_recovered_by_fec +=
        counter_delta(&mut cursor.recovered_by_fec, current.recovered_by_fec);
    out.display_datagrams_declared_lost +=
        counter_delta(&mut cursor.declared_lost, current.declared_lost);
    out.display_datagrams_outcome_unknown +=
        counter_delta(&mut cursor.outcome_unknown, current.outcome_unknown);
}

/// Build one statistics sample from current owner-loop state.
///
/// Split out from [`emit_transport_stats`] so the payload can be exercised in
/// tests without an `EventSink` or a live QUIC connection.
pub(crate) async fn build_transport_stats(
    peers: &mut PeerMap,
    parked: &ParkedPeers,
    wt_state: &Option<Arc<RwLock<WebTransportState>>>,
    now_ms: f64,
    window_ms: u32,
    stats_events_dropped: u64,
    rebind: crate::session::rebind_flow::RebindTallies,
) -> TransportStatsEvt {
    let mut sample = TransportStatsEvt {
        window_ms,
        peers: u32::try_from(peers.len()).unwrap_or(u32::MAX),
        parked_peers: u32::try_from(parked.len()).unwrap_or(u32::MAX),
        stats_events_dropped,
        ..TransportStatsEvt::default()
    };

    for peer in peers.values_mut() {
        accumulate_path_health(
            peer,
            PeerTransport::WebTransport,
            now_ms,
            &mut sample.webtransport,
        );
        accumulate_path_health(peer, PeerTransport::Edge, now_ms, &mut sample.edge);
        accumulate_datagram_outcomes(peer, PeerTransport::WebTransport, &mut sample.webtransport);
        accumulate_datagram_outcomes(peer, PeerTransport::Edge, &mut sample.edge);
        accumulate_waste(peer, &mut sample);

        sample.unacked_datagrams_max = sample
            .unacked_datagrams_max
            .max(u32::try_from(peer.display_cache.sent_datagrams.len()).unwrap_or(u32::MAX));
        if let Some(tunnel) = peer.edge_tunnel.as_ref() {
            sample.edge_reliable_queued_bytes_max = sample
                .edge_reliable_queued_bytes_max
                .max(u32::try_from(tunnel.reliable_queued_bytes()).unwrap_or(u32::MAX));
            if let (Some(state), Some((connection, stats))) =
                (tunnel.quic_delivery_state(), tunnel.quic_stats())
            {
                peer.telemetry_cursor
                    .edge
                    .advance(connection, &stats, &mut sample.edge);
                if let Some(downstream) = tunnel.downstream_delivery_quote() {
                    peer.display_planning.observe_carrier_quote(
                        1,
                        serial_delivery_quote(
                            delivery_quote(state),
                            edge_downstream_quote(downstream),
                        ),
                    );
                }
            }
        }
        if let Some(tunnel) = peer.edge_tunnel_bulk.as_ref() {
            sample.edge_reliable_queued_bytes_max = sample
                .edge_reliable_queued_bytes_max
                .max(u32::try_from(tunnel.reliable_queued_bytes()).unwrap_or(u32::MAX));
        }

        // The report is the one locked read, at ten-second cadence; the quote
        // reads the delivery view like every flush does.
        if let Some((connection, stats, state)) = peer.open_direct_session().map(|session| {
            let quic = session.quic_connection();
            (quic.stable_id(), quic.stats(), session.delivery_state())
        }) {
            peer.telemetry_cursor
                .webtransport
                .advance(connection, &stats, &mut sample.webtransport);
            peer.display_planning
                .observe_carrier_quote(0, delivery_quote(state));
        }
    }

    sample.inbound_datagram_drops_wt = crate::webtransport::inbound_datagram_queue_drops();
    sample.inbound_datagram_drops_edge = crate::edge_tunnel::inbound_datagram_queue_drops();
    sample.over_capacity_session_rejections =
        crate::webtransport::over_capacity_session_rejections();
    sample.rebind_requests = rebind.requests;
    sample.rebind_accepted = rebind.accepted;
    sample.rebind_committed = rebind.committed;
    sample.rebind_refused = rebind.refused;
    sample.rebind_envelopes_rejected = rebind.envelopes_rejected;
    sample.rebind_events_suppressed = rebind.events_suppressed;
    sample.direct_wt_incoming_expected = crate::webtransport::direct_wt_incoming_expected();
    sample.direct_wt_incoming_unexpected = crate::webtransport::direct_wt_incoming_unexpected();
    sample.direct_wt_admitted = crate::webtransport::direct_wt_admitted();

    // Zero when the socket clone failed at startup, which is the same shape the
    // rest of this function reports for an absent path: no side channel means no
    // keepalives and no punches, which is exactly what the counters say.
    if let Some(state) = wt_state {
        let nat = state
            .read()
            .await
            .side_channel
            .as_ref()
            .map(|channel| channel.stats().snapshot())
            .unwrap_or_default();
        sample.nat_keepalives_sent = nat.keepalives_sent;
        sample.nat_punch_bursts_sent = nat.bursts_sent;
        sample.nat_punch_refused_not_global = nat.refused_not_global;
        sample.nat_punch_refused_rate_limited = nat.refused_rate_limited;
        sample.nat_side_channel_send_failed = nat.send_failed;
        sample.nat_side_channel_would_block = nat.send_would_block;
    }

    sample
}

/// Emit one sample, unless the interval was genuinely idle.
///
/// Returns the new dropped-frame total: the sink deliberately drops rather than
/// poisons for this event kind, and a gap in the series must be visible rather
/// than silent, so the count rides along in the next successful payload.
pub(crate) async fn emit_transport_stats(
    peers: &mut PeerMap,
    parked: &ParkedPeers,
    wt_state: &Option<Arc<RwLock<WebTransportState>>>,
    event_tx: &EventSink,
    now_ms: f64,
    window_ms: u32,
    stats_events_dropped: u64,
    rebind: crate::session::rebind_flow::RebindTallies,
) -> u64 {
    emit_transport_stats_sample(
        peers,
        parked,
        wt_state,
        event_tx,
        now_ms,
        window_ms,
        stats_events_dropped,
        rebind,
        false,
    )
    .await
    .0
}

/// Emit the final partial-window sample even after every session has detached.
/// The boolean is true only when the complete diagnostic frame entered the
/// FIFO event sink; callers must acknowledge the capture command afterwards.
pub(crate) async fn emit_final_transport_stats(
    peers: &mut PeerMap,
    parked: &ParkedPeers,
    wt_state: &Option<Arc<RwLock<WebTransportState>>>,
    event_tx: &EventSink,
    now_ms: f64,
    window_ms: u32,
    stats_events_dropped: u64,
    rebind: crate::session::rebind_flow::RebindTallies,
) -> (u64, bool) {
    emit_transport_stats_sample(
        peers,
        parked,
        wt_state,
        event_tx,
        now_ms,
        window_ms,
        stats_events_dropped,
        rebind,
        true,
    )
    .await
}

async fn emit_transport_stats_sample(
    peers: &mut PeerMap,
    parked: &ParkedPeers,
    wt_state: &Option<Arc<RwLock<WebTransportState>>>,
    event_tx: &EventSink,
    now_ms: f64,
    window_ms: u32,
    stats_events_dropped: u64,
    rebind: crate::session::rebind_flow::RebindTallies,
    force: bool,
) -> (u64, bool) {
    // With no peer attached and none parked there is no path, no display is
    // being sent, and none of the drop counters can advance. An idle daemon
    // emits nothing at all rather than a stream of zeroes.
    if !force && peers.is_empty() && parked.len() == 0 {
        return (stats_events_dropped, false);
    }

    let sample = build_transport_stats(
        peers,
        parked,
        wt_state,
        now_ms,
        window_ms,
        stats_events_dropped,
        rebind,
    )
    .await;

    match event_tx.send_diagnostic_json(EVT_TRANSPORT_STATS, &sample) {
        Ok(()) => (stats_events_dropped, true),
        Err(failure) => {
            let dropped = stats_events_dropped.saturating_add(1);
            // Power-of-two rate limiting: overload stays visible without turning
            // a stalled stdout into a logging flood.
            if dropped.is_power_of_two() {
                warn!("transport stats frame dropped: {failure} (dropped={dropped} since start)");
            }
            (dropped, false)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::events::{test_capturing_event_sink, test_event_sink};

    fn planner_quote(
        one_way_us: f64,
        cwnd: u64,
        debt: u64,
        pacing_rate_bps: u64,
    ) -> CarrierDeliveryQuote {
        CarrierDeliveryQuote {
            one_way_us,
            jitter_upper_us: one_way_us / 10.0,
            congestion_window_bytes: cwnd,
            bytes_in_flight: debt,
            send_buffer_occupied_bytes: 0,
            mtu_bytes: 1_200,
            pacing_rate_bps,
            loss_upper: 0.0,
            serial_hops: None,
        }
    }

    #[test]
    fn serial_delivery_quote_sums_each_hops_queue_and_serialization_cost() {
        for (upstream, downstream) in [
            (
                planner_quote(5_000.0, 12_000, 0, 16_000_000),
                planner_quote(20_000.0, 24_000, 0, 4_000_000),
            ),
            (
                planner_quote(5_000.0, 12_000, 48_000, 16_000_000),
                planner_quote(20_000.0, 24_000, 96_000, 4_000_000),
            ),
            (
                planner_quote(40_000.0, 64_000, 80_000, 2_000_000),
                planner_quote(2_000.0, 8_000, 0, 32_000_000),
            ),
        ] {
            let serial = serial_delivery_quote(upstream, downstream);
            assert_eq!(
                serial.fixed_delivery_us(),
                upstream.fixed_delivery_us() + downstream.fixed_delivery_us(),
            );
            assert_eq!(
                serial.serialization_us(4_096),
                upstream.serialization_us(4_096) + downstream.serialization_us(4_096),
            );
            assert_eq!(
                serial.earliest_delivery_us(4_096, 4),
                upstream.earliest_delivery_us(4_096, 4) + downstream.earliest_delivery_us(4_096, 4),
                "a serial path has two cwnds and two serialization stages",
            );
        }
    }

    #[test]
    fn non_finite_and_negative_values_clamp_to_zero() {
        for value in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, -1.0, 0.0] {
            assert_eq!(ms_to_us_u32(value), 0, "ms_to_us_u32({value})");
            assert_eq!(ms_to_u32(value), 0, "ms_to_u32({value})");
        }
        assert_eq!(ms_to_us_u32(1.5), 1_500);
        assert_eq!(ms_to_u32(1.5), 1);
    }

    #[test]
    fn oversized_values_saturate_instead_of_wrapping() {
        assert_eq!(ms_to_us_u32(f64::MAX), u32::MAX);
        assert_eq!(duration_to_us_u32(std::time::Duration::MAX), u32::MAX);
    }

    #[test]
    fn min_positive_treats_zero_as_unset() {
        assert_eq!(min_positive(0, 1_200), 1_200);
        assert_eq!(min_positive(1_200, 0), 1_200);
        assert_eq!(min_positive(1_200, 900), 900);
        assert_eq!(min_positive_u64(0, 42), 42);
        assert_eq!(min_positive_u64(42, 0), 42);
    }

    #[test]
    fn a_replaced_connection_starts_its_counters_from_zero() {
        let mut cursor = QuicCursor::default();
        let mut stats = ConnectionStats::default();
        stats.path.sent_packets = 1_000;
        cursor.advance(1, &stats, &mut PathStatsEvt::default());

        // A redial replaces the connection under a surviving peer, and the
        // replacement has already passed its predecessor's count by the sample.
        stats.path.sent_packets = 1_500;
        let mut out = PathStatsEvt::default();
        cursor.advance(2, &stats, &mut out);
        assert_eq!(out.quic_sent_packets, 1_500);

        stats.path.sent_packets = 1_600;
        let mut next = PathStatsEvt::default();
        cursor.advance(2, &stats, &mut next);
        assert_eq!(next.quic_sent_packets, 100);
    }

    #[test]
    fn deltas_are_per_interval_not_cumulative() {
        let mut cursor = QuicCursor::default();
        let mut stats = ConnectionStats::default();

        stats.path.sent_packets = 100;
        let mut first = PathStatsEvt::default();
        cursor.advance(7, &stats, &mut first);
        assert_eq!(first.quic_sent_packets, 100);

        stats.path.sent_packets = 175;
        let mut second = PathStatsEvt::default();
        cursor.advance(7, &stats, &mut second);
        assert_eq!(second.quic_sent_packets, 75);
    }

    #[test]
    fn display_datagram_outcomes_are_per_path_interval_deltas() {
        let mut peer = PeerDisplayState::new("browser-1".into(), PeerTransport::Edge);
        peer.display_cache.datagram_outcomes.edge = DisplayDatagramOutcomeCounters {
            received: 90,
            recovered_by_fec: 7,
            declared_lost: 3,
            outcome_unknown: 2,
        };
        peer.display_cache.datagram_outcomes.webtransport = DisplayDatagramOutcomeCounters {
            received: 40,
            recovered_by_fec: 1,
            declared_lost: 0,
            outcome_unknown: 4,
        };

        let mut edge = PathStatsEvt::default();
        accumulate_datagram_outcomes(&mut peer, PeerTransport::Edge, &mut edge);
        assert_eq!(edge.display_datagrams_received, 90);
        assert_eq!(edge.display_datagrams_recovered_by_fec, 7);
        assert_eq!(edge.display_datagrams_declared_lost, 3);
        assert_eq!(edge.display_datagrams_outcome_unknown, 2);
        assert_eq!(
            edge.display_datagrams_received
                + edge.display_datagrams_recovered_by_fec
                + edge.display_datagrams_declared_lost,
            100,
            "classified denominator excludes unknown outcomes"
        );

        let mut second = PathStatsEvt::default();
        accumulate_datagram_outcomes(&mut peer, PeerTransport::Edge, &mut second);
        assert_eq!(second.display_datagrams_received, 0);
        assert_eq!(second.display_datagrams_recovered_by_fec, 0);
        assert_eq!(second.display_datagrams_declared_lost, 0);
        assert_eq!(second.display_datagrams_outcome_unknown, 0);

        let mut direct = PathStatsEvt::default();
        accumulate_datagram_outcomes(&mut peer, PeerTransport::WebTransport, &mut direct);
        assert_eq!(direct.display_datagrams_received, 40);
        assert_eq!(direct.display_datagrams_recovered_by_fec, 1);
        assert_eq!(direct.display_datagrams_declared_lost, 0);
        assert_eq!(direct.display_datagrams_outcome_unknown, 4);
    }

    #[tokio::test]
    async fn final_capture_emits_an_idle_fixed_shape_sample() {
        let (sink, mut output) = test_event_sink();
        let mut peers = PeerMap::new();
        let parked = ParkedPeers::new();
        let wt_state = None;

        let periodic = emit_transport_stats(
            &mut peers,
            &parked,
            &wt_state,
            &sink,
            1.0,
            1,
            0,
            crate::session::rebind_flow::RebindTallies::default(),
        )
        .await;
        assert_eq!(periodic, 0, "periodic idle elision remains unchanged");

        let (dropped, emitted) = emit_final_transport_stats(
            &mut peers,
            &parked,
            &wt_state,
            &sink,
            2.0,
            1,
            periodic,
            crate::session::rebind_flow::RebindTallies::default(),
        )
        .await;
        assert_eq!(dropped, 0);
        assert!(
            emitted,
            "final capture must not disappear on an idle daemon"
        );
        output.shutdown().await.expect("flush test event");
    }

    #[tokio::test]
    async fn final_capture_preserves_unsampled_live_peer_counters() {
        let (sink, mut output, captured) = test_capturing_event_sink();
        let mut peers = PeerMap::new();
        let mut peer = PeerDisplayState::new("browser-1".into(), PeerTransport::Edge);
        peer.display_cache.waste.row_versions_sent = 17;
        peers.insert(peer.peer_id.clone(), peer);

        let (dropped, emitted) = emit_final_transport_stats(
            &mut peers,
            &ParkedPeers::new(),
            &None,
            &sink,
            12.0,
            7,
            0,
            crate::session::rebind_flow::RebindTallies::default(),
        )
        .await;
        assert_eq!(dropped, 0);
        assert!(emitted);
        output.shutdown().await.expect("flush capture event");

        let bytes = captured.lock().unwrap().clone();
        let (_, payload) = crate::ipc::read_frame(&mut std::io::Cursor::new(bytes))
            .expect("valid event frame")
            .expect("transport event");
        let value: serde_json::Value = serde_json::from_slice(&payload).expect("transport JSON");
        assert_eq!(value["peers"], 1);
        assert_eq!(value["window_ms"], 7);
        assert_eq!(
            value["row_versions_sent"], 17,
            "capture before page teardown must retain the live peer's unsampled delta"
        );
    }
}
