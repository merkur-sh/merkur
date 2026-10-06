//! Edge counters and gauges, exported over OTLP when telemetry is configured.
//!
//! Gauges are backed by plain atomics that `splice.rs` bumps inside the
//! critical sections it already holds. The observable-gauge callback runs on
//! the exporter's own thread and reads only atomics, taking neither the cold
//! registry lock nor the session-local datagram routing lock.
//!
//! Naming matches the server's `merkur_*` convention in
//! `apps/server/src/observability/metrics.ts`.
//!
//! # Cardinality rules
//!
//! Every attribute value here is a `&'static str` drawn from a closed set, and
//! that is enforced structurally: each `record_*` function takes `&'static str`
//! parameters only, so a runtime `String` cannot reach an attribute. The closed
//! sets are `role` (2 values, from [`Role::as_metric_label`]), `direction` (2),
//! `exit` (from the relay's `SessionExit`), plus the pre-existing `outcome` and
//! `reason` sets.
//!
//! Never an attribute: session id, attachment id, remote socket address, or any
//! measured value. Measured values are the *value*, never the *key*. Per-session
//! identity belongs on the `edge.session.splice` span, which already carries
//! `merkur.session.id` — traces are the high-cardinality store, metrics are not.

use std::sync::LazyLock;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};

use opentelemetry::metrics::{Counter, Histogram, Meter};
use opentelemetry::{KeyValue, global};
// Re-exported by `wtransport` under its `quinn` feature, which this crate
// already enables. Taking it from there rather than as a direct dependency
// keeps the version locked to whatever `wtransport` links.
use wtransport::quinn::ConnectionStats;

use crate::splice::Role;

// Monthly NIC accounting is updated only by the budget owner.
static EGRESS_MONTH_BYTES: AtomicU64 = AtomicU64::new(0);
static EGRESS_RESERVED_BYTES: AtomicU64 = AtomicU64::new(0);
static EGRESS_BUDGET_STATE: AtomicU64 = AtomicU64::new(0);

/// Sessions with at least one attached peer.
pub static ACTIVE_SESSIONS: AtomicI64 = AtomicI64::new(0);
/// Sessions with both browser and daemon attached.
pub static PAIRED_SESSIONS: AtomicI64 = AtomicI64::new(0);

/// Datagrams dropped because the destination peer's bounded mailbox was full,
/// counted per source role.
///
/// These are bumped from inside `DatagramRoute::route` while holding that
/// session's read lock, so they stay raw atomics. An OTLP `Counter::add` builds
/// attributes and takes SDK-internal locks; the observable-counter callbacks
/// below read these atomics on the exporter thread instead, exactly as the
/// session gauges already do.
///
/// Only the mailbox-full branch increments; the success path gains no
/// instructions at all, and an unpaired counterpart is deliberately not counted
/// as a drop.
pub static BROWSER_ROUTE_DROPS: AtomicU64 = AtomicU64::new(0);
pub static DAEMON_ROUTE_DROPS: AtomicU64 = AtomicU64::new(0);

/// The counter a mailbox-full drop from `from_role` should bump.
pub fn route_drop_counter(from_role: Role) -> &'static AtomicU64 {
    match from_role {
        Role::Browser => &BROWSER_ROUTE_DROPS,
        Role::Daemon => &DAEMON_ROUTE_DROPS,
    }
}

struct EdgeInstruments {
    egress_ledger_initialized_total: Counter<u64>,
    attach_total: Counter<u64>,
    handshake_failures_total: Counter<u64>,
    datagram_egress_drops_total: Counter<u64>,
    datagrams_superseded_total: Counter<u64>,
    contained_stream_drop_panics_total: Counter<u64>,
    reliable_write_timeouts_total: Counter<u64>,
    pump_settle_timeouts_total: Counter<u64>,
    unpaired_pruned_total: Counter<u64>,
    cert_rotations_total: Counter<u64>,
    registration_publish_total: Counter<u64>,
    quic_datagrams_total: Counter<u64>,
    quic_packets_sent_total: Counter<u64>,
    quic_packets_lost_total: Counter<u64>,
    quic_congestion_events_total: Counter<u64>,
    quic_black_holes_total: Counter<u64>,
    quic_udp_bytes_total: Counter<u64>,
    session_rtt_ms: Histogram<f64>,
    session_mtu_bytes: Histogram<u64>,
    session_duration_ms: Histogram<f64>,
}

static INSTRUMENTS: LazyLock<EdgeInstruments> = LazyLock::new(|| {
    let meter: Meter = global::meter("merkur-edge");

    meter
        .i64_observable_gauge("merkur_edge_sessions_active")
        .with_description("Splice sessions with at least one attached peer")
        .with_callback(|observer| observer.observe(ACTIVE_SESSIONS.load(Ordering::Relaxed), &[]))
        .build();
    meter
        .i64_observable_gauge("merkur_edge_sessions_paired")
        .with_description("Splice sessions with both browser and daemon attached")
        .with_callback(|observer| observer.observe(PAIRED_SESSIONS.load(Ordering::Relaxed), &[]))
        .build();
    meter
        .u64_observable_counter("merkur_edge_route_mailbox_drops_total")
        .with_description("Datagrams dropped because the destination peer mailbox was full")
        .with_callback(|observer| {
            observer.observe(
                BROWSER_ROUTE_DROPS.load(Ordering::Relaxed),
                &[KeyValue::new("role", "browser")],
            );
            observer.observe(
                DAEMON_ROUTE_DROPS.load(Ordering::Relaxed),
                &[KeyValue::new("role", "daemon")],
            );
        })
        .build();

    for (name, value) in [
        ("merkur_edge_egress_month_bytes", &EGRESS_MONTH_BYTES),
        ("merkur_edge_egress_reserved_bytes", &EGRESS_RESERVED_BYTES),
        ("merkur_edge_egress_budget_state", &EGRESS_BUDGET_STATE),
    ] {
        meter
            .u64_observable_gauge(name)
            .with_callback(move |observer| observer.observe(value.load(Ordering::Relaxed), &[]))
            .build();
    }

    EdgeInstruments {
        egress_ledger_initialized_total: meter
            .u64_counter("merkur_edge_egress_ledger_initialized_total")
            .build(),
        attach_total: meter
            .u64_counter("merkur_edge_session_attach_total")
            .with_description("Peer attach attempts by role and outcome")
            .build(),
        handshake_failures_total: meter
            .u64_counter("merkur_edge_handshake_failures_total")
            .with_description("Sessions rejected before splice admission")
            .build(),
        datagram_egress_drops_total: meter
            .u64_counter("merkur_edge_datagram_egress_drops_total")
            .with_description("Datagrams dropped at egress under backpressure")
            .build(),
        datagrams_superseded_total: meter
            .u64_counter("merkur_edge_datagrams_superseded_total")
            .with_description(
                "Unsent datagrams discarded when a browser leg blocked: only probes could \
                 leave, so every queued frame could only go stale",
            )
            .build(),
        contained_stream_drop_panics_total: meter
            .u64_counter("merkur_edge_contained_stream_drop_panics_total")
            .with_description(
                "Panics contained while closing a QUIC stream. Non-zero means quinn's \
                 connection mutex was poisoned by an earlier unreported panic, and that \
                 each of these would have aborted the process",
            )
            .build(),
        reliable_write_timeouts_total: meter
            .u64_counter("merkur_edge_reliable_write_timeouts_total")
            .with_description(
                "Persistent-lane setup or in-progress record operations abandoned after deadline",
            )
            .build(),
        pump_settle_timeouts_total: meter
            .u64_counter("merkur_edge_pump_settle_timeouts_total")
            .with_description(
                "Session pumps aborted because they did not exit within the shutdown timeout",
            )
            .build(),
        unpaired_pruned_total: meter
            .u64_counter("merkur_edge_unpaired_pruned_total")
            .with_description("Half-paired sessions retired by the expiry sweep")
            .build(),
        cert_rotations_total: meter
            .u64_counter("merkur_edge_cert_rotations_total")
            .with_description("Certificate rotations by outcome")
            .build(),
        registration_publish_total: meter
            .u64_counter("merkur_edge_registration_publish_total")
            .with_description("Registration publish attempts by outcome")
            .build(),
        quic_datagrams_total: meter
            .u64_counter("merkur_edge_quic_datagrams_total")
            .with_description(
                "QUIC DATAGRAM frames received from and sent to a peer. This is the \
                 denominator that makes the egress and mailbox drop counters a ratio.",
            )
            .build(),
        quic_packets_sent_total: meter
            .u64_counter("merkur_edge_quic_packets_sent_total")
            .with_description("QUIC packets sent on a peer connection")
            .build(),
        quic_packets_lost_total: meter
            .u64_counter("merkur_edge_quic_packets_lost_total")
            .with_description("QUIC packets declared lost on a peer connection")
            .build(),
        quic_congestion_events_total: meter
            .u64_counter("merkur_edge_quic_congestion_events_total")
            .with_description("QUIC congestion events, distinguishing congestion from random loss")
            .build(),
        quic_black_holes_total: meter
            .u64_counter("merkur_edge_quic_black_holes_total")
            .with_description("QUIC black holes detected on a peer connection")
            .build(),
        quic_udp_bytes_total: meter
            .u64_counter("merkur_edge_quic_udp_bytes_total")
            .with_description("UDP payload bytes on a peer connection, including retransmits")
            .with_unit("By")
            .build(),
        session_rtt_ms: meter
            .f64_histogram("merkur_edge_session_rtt_ms")
            .with_description("Final QUIC path RTT observed for a peer connection at teardown")
            .with_unit("ms")
            .build(),
        session_mtu_bytes: meter
            .u64_histogram("merkur_edge_session_mtu_bytes")
            .with_description("Final QUIC path MTU observed for a peer connection at teardown")
            .with_unit("By")
            .build(),
        session_duration_ms: meter
            .f64_histogram("merkur_edge_session_duration_ms")
            .with_description("Peer attachment lifetime, by role and exit reason")
            .with_unit("ms")
            .build(),
    }
});

pub fn record_attach(role: &'static str, outcome: &'static str) {
    INSTRUMENTS.attach_total.add(
        1,
        &[
            KeyValue::new("role", role),
            KeyValue::new("outcome", outcome),
        ],
    );
}

pub fn record_handshake_failure(reason: &'static str) {
    INSTRUMENTS
        .handshake_failures_total
        .add(1, &[KeyValue::new("reason", reason)]);
}

pub fn record_datagram_egress_drop() {
    INSTRUMENTS.datagram_egress_drops_total.add(1, &[]);
}

/// Queued datagrams a blocked browser leg could only have delivered stale.
pub fn record_datagrams_superseded(count: u64) {
    INSTRUMENTS.datagrams_superseded_total.add(count, &[]);
}

/// A stream destructor panicked and was contained instead of aborting the
/// process. Every increment is one whole-replica outage that did not happen.
pub fn record_contained_stream_drop_panic() {
    INSTRUMENTS.contained_stream_drop_panics_total.add(1, &[]);
}

pub fn record_reliable_write_timeout() {
    INSTRUMENTS.reliable_write_timeouts_total.add(1, &[]);
}

/// A session pump had to be aborted rather than exiting on its own.
///
/// `settle_session_pump` calls itself "only a safety valve for a transport
/// implementation that fails to wake a closed accept/read future", and an
/// assertion like that is worth nothing unless something counts it. Each
/// increment is one teardown that held its accepted-session admission slot for
/// the full shutdown timeout, and one pump that did not wake on a connection
/// close the way it is supposed to.
///
/// Labelled by which pump, because "which future failed to wake" is the entire
/// question and the three have nothing in common: the outbound lane waits on a
/// mailbox, the datagram pump on `receive_datagram`, the stream pump on
/// `accept_uni`.
pub fn record_pump_settle_timeout(pump: &'static str) {
    INSTRUMENTS
        .pump_settle_timeouts_total
        .add(1, &[KeyValue::new("pump", pump)]);
}

pub fn record_unpaired_pruned(count: u64) {
    if count > 0 {
        INSTRUMENTS.unpaired_pruned_total.add(count, &[]);
    }
}

pub fn record_cert_rotation(outcome: &'static str) {
    INSTRUMENTS
        .cert_rotations_total
        .add(1, &[KeyValue::new("outcome", outcome)]);
}

pub fn record_registration_publish(outcome: &'static str) {
    INSTRUMENTS
        .registration_publish_total
        .add(1, &[KeyValue::new("outcome", outcome)]);
}

/// Fold one peer connection's final QUIC counters into the fleet totals.
///
/// Called exactly once per peer, at session teardown, from the task that owns
/// the connection. `quinn::Connection::stats()` takes the same per-connection
/// state mutex the QUIC driver holds during packet I/O, so it must never be
/// called on a frame path — once per session on a connection that is already
/// winding down costs nothing.
///
/// Every value here is a lifetime total for this connection, so summing across
/// sessions gives correct fleet totals. `frame_rx.datagram` / `frame_tx.datagram`
/// count DATAGRAM frames that actually reached the wire, which is strictly
/// better than an application-side accept counter: the send buffer silently
/// evicts under pressure, so an accept counter would over-report delivery.
pub fn record_session_quic_stats(role: &'static str, stats: &ConnectionStats) {
    let role_attr = [KeyValue::new("role", role)];

    INSTRUMENTS.quic_datagrams_total.add(
        stats.frame_rx.datagram,
        &[
            KeyValue::new("role", role),
            KeyValue::new("direction", "rx"),
        ],
    );
    INSTRUMENTS.quic_datagrams_total.add(
        stats.frame_tx.datagram,
        &[
            KeyValue::new("role", role),
            KeyValue::new("direction", "tx"),
        ],
    );
    INSTRUMENTS.quic_udp_bytes_total.add(
        stats.udp_rx.bytes,
        &[
            KeyValue::new("role", role),
            KeyValue::new("direction", "rx"),
        ],
    );
    INSTRUMENTS.quic_udp_bytes_total.add(
        stats.udp_tx.bytes,
        &[
            KeyValue::new("role", role),
            KeyValue::new("direction", "tx"),
        ],
    );

    INSTRUMENTS
        .quic_packets_sent_total
        .add(stats.path.sent_packets, &role_attr);
    INSTRUMENTS
        .quic_packets_lost_total
        .add(
            stats.path.lost_packets - stats.path.spurious_lost_packets,
            &role_attr,
        );
    INSTRUMENTS
        .quic_congestion_events_total
        .add(stats.path.congestion_events, &role_attr);
    INSTRUMENTS
        .quic_black_holes_total
        .add(stats.path.black_holes_detected, &role_attr);

    INSTRUMENTS
        .session_rtt_ms
        .record(stats.path.rtt.as_secs_f64() * 1_000.0, &role_attr);
    INSTRUMENTS
        .session_mtu_bytes
        .record(u64::from(stats.path.current_mtu), &role_attr);
}

/// Record how long a peer stayed attached, and why it left.
pub fn record_session_duration(role: &'static str, exit: &'static str, duration_ms: f64) {
    INSTRUMENTS.session_duration_ms.record(
        duration_ms,
        &[KeyValue::new("role", role), KeyValue::new("exit", exit)],
    );
}

pub fn publish_egress(used: u64, reserved: u64, state: u64) {
    LazyLock::force(&INSTRUMENTS);
    EGRESS_MONTH_BYTES.store(used, Ordering::Relaxed);
    EGRESS_RESERVED_BYTES.store(reserved, Ordering::Relaxed);
    EGRESS_BUDGET_STATE.store(state, Ordering::Relaxed);
}

pub fn record_egress_ledger_initialized() {
    INSTRUMENTS.egress_ledger_initialized_total.add(1, &[]);
}
