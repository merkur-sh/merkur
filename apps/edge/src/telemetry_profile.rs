//! Steady-state cost of the edge's telemetry under the production pipeline.
//!
//! `telemetry::init` runs exactly as `main` runs it, exporting to a loopback
//! sink, so every measurement below goes through the real subscriber stack
//! (env filter, fmt, tracing-opentelemetry, the OTLP log bridge) and the real
//! SDK meter provider. Measured on the calling thread only:
//!
//! - each `metrics::record_*` the relay calls, warmed, and again right after a
//!   forced collection, because a collection is where a delta pipeline would
//!   drop its trackers and the next call would allocate them again;
//! - one poll of a future instrumented with the `edge.session.splice` span,
//!   which is what every wake of `run_spliced_session` pays, against the same
//!   future uninstrumented (paired, alternating order);
//! - a disabled `debug!` callsite, span creation, and one `info!` event.
//!
//! ```sh
//! cargo test --release --locked -p merkur-edge \
//!   telemetry::profile::edge_telemetry_hot_path_profile -- --ignored --exact --nocapture --test-threads=1
//! ```

use std::future::Future;
use std::hint::black_box;
use std::pin::Pin;
use std::task::{Context, Poll, Waker};
use std::time::Instant;

use tracing::Instrument;
use wtransport::quinn::ConnectionStats;

use super::{init, telemetry_config_from_values};
use crate::metrics;
use crate::profile_support::{http_sink, measured, percentile};
use crate::splice::Role;

/// A named telemetry call, timed as a black box.
type Call<'a> = (&'static str, Box<dyn FnMut() + 'a>);

/// Pending `remaining` times, then ready.
struct Yields {
    remaining: usize,
}

impl Future for Yields {
    type Output = ();
    fn poll(mut self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<()> {
        if self.remaining == 0 {
            return Poll::Ready(());
        }
        self.remaining -= 1;
        Poll::Pending
    }
}

fn poll_times<F: Future<Output = ()>>(future: F, polls: usize) -> f64 {
    let mut future = std::pin::pin!(future);
    let mut context = Context::from_waker(Waker::noop());
    let started = Instant::now();
    for _ in 0..polls {
        let _ = black_box(future.as_mut().poll(&mut context));
    }
    started.elapsed().as_nanos() as f64 / polls as f64
}

fn session_span(session_id: &str, role: Role) -> tracing::Span {
    // Exactly the span `accept_loop` wraps every session in.
    tracing::info_span!(
        "edge.session.splice",
        "merkur.session.id" = %session_id,
        "merkur.peer.role" = ?role,
    )
}

fn report_call(name: &str, iterations: usize, mut call: impl FnMut()) {
    call();
    let mut samples = Vec::with_capacity(21);
    let mut allocations = 0;
    let mut bytes = 0;
    for _ in 0..21 {
        let started = Instant::now();
        let ((), tally) = measured(|| {
            for _ in 0..iterations {
                call();
            }
        });
        samples.push(started.elapsed().as_nanos() as f64 / iterations as f64);
        allocations += tally.allocations;
        bytes += tally.bytes;
    }
    samples.sort_by(f64::total_cmp);
    let calls = (21 * iterations) as f64;
    println!(
        "{:<52} {:>8.1} {:>8.1} {:>9.3} {:>9.1}",
        name,
        percentile(&samples, 0.5),
        percentile(&samples, 0.95),
        allocations as f64 / calls,
        bytes as f64 / calls,
    );
}

#[test]
#[ignore = "profiling harness; run explicitly with --ignored --nocapture"]
fn edge_telemetry_hot_path_profile() {
    crate::install_crypto_provider();
    let (sink, metric_exports) = http_sink(false, "/v1/metrics");
    let config = telemetry_config_from_values(
        [
            Some(format!("http://{sink}")),
            Some("xaat-profile".to_string()),
            Some("traces".to_string()),
            Some("metrics".to_string()),
        ],
        "iad-1",
        "iad",
        None,
    )
    .expect("valid config")
    .expect("configured");
    let telemetry = init(Some(config)).expect("init").expect("pipelines");
    let meter = telemetry.meter.as_ref().expect("metrics pipeline");
    // `metrics` binds its instruments to the global meter of its first
    // `record_*` and keeps them for the life of the process. A test earlier in
    // this binary that recorded (a registration publish does) leaves them on the
    // no-op meter, where every row below would time nothing. A collection that
    // reaches the sink proves they record into this pipeline.
    metrics::record_attach("browser", "ok");
    meter.force_flush().expect("collect and export metrics");
    assert!(
        metric_exports.load(std::sync::atomic::Ordering::Acquire) >= 1,
        "metrics must export through the SDK pipeline; run this profile alone with --exact"
    );

    println!("edge telemetry, production pipeline, loopback OTLP sink; per call on this thread");
    println!(
        "{:<52} {:>8} {:>8} {:>9} {:>9}",
        "operation", "p50 ns", "p95 ns", "allocs", "bytes"
    );

    let stats = ConnectionStats::default();
    let mut calls: Vec<Call<'_>> = vec![
        (
            "metrics::record_datagram_egress_drop (per drop)",
            Box::new(metrics::record_datagram_egress_drop),
        ),
        (
            "metrics::route_drop_counter + fetch_add (per drop)",
            Box::new(|| {
                metrics::route_drop_counter(black_box(Role::Browser))
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            }),
        ),
        (
            "metrics::record_attach (per attach)",
            Box::new(|| metrics::record_attach("browser", "ok")),
        ),
        (
            "metrics::record_handshake_failure (per failure)",
            Box::new(|| metrics::record_handshake_failure("timeout")),
        ),
        (
            "metrics::record_session_quic_stats (per teardown)",
            Box::new(|| metrics::record_session_quic_stats("browser", &stats)),
        ),
        (
            "metrics::record_session_duration (per teardown)",
            Box::new(|| metrics::record_session_duration("browser", "connection", 12.5)),
        ),
    ];
    for (name, call) in calls.iter_mut() {
        report_call(name, 10_000, &mut **call);
    }
    meter.force_flush().expect("collect and export metrics");
    for (name, call) in calls.iter_mut() {
        let ((), tally) = measured(&mut **call);
        println!(
            "{:<52} {:>8} {:>8} {:>9} {:>9}",
            format!("  after collection: {name}"),
            "-",
            "-",
            tally.allocations,
            tally.bytes
        );
    }

    report_call("disabled debug! callsite", 100_000, || {
        tracing::debug!(session_id = %"profile", "edge: displaced stale same-role peer");
    });

    // Session future wakes: paired, alternating which arm runs first.
    let polls = 20_000;
    let mut plain = Vec::new();
    let mut instrumented = Vec::new();
    let mut instrumented_allocations = 0;
    let span = session_span("0123456789abcdef0123456789abcdef", Role::Browser);
    for round in 0..40 {
        let run_plain = |samples: &mut Vec<f64>| {
            samples.push(poll_times(Yields { remaining: polls }, polls));
        };
        if round % 2 == 0 {
            run_plain(&mut plain);
        }
        let (ns, tally) =
            measured(|| poll_times(Yields { remaining: polls }.instrument(span.clone()), polls));
        instrumented.push(ns);
        instrumented_allocations += tally.allocations;
        if round % 2 == 1 {
            run_plain(&mut plain);
        }
    }
    plain.sort_by(f64::total_cmp);
    instrumented.sort_by(f64::total_cmp);
    println!(
        "{:<52} {:>8.1} {:>8.1} {:>9} {:>9}",
        "session future poll, uninstrumented",
        percentile(&plain, 0.5),
        percentile(&plain, 0.95),
        "-",
        "-"
    );
    println!(
        "{:<52} {:>8.1} {:>8.1} {:>9.3} {:>9}",
        "session future poll, edge.session.splice span",
        percentile(&instrumented, 0.5),
        percentile(&instrumented, 0.95),
        instrumented_allocations as f64 / (40 * polls) as f64,
        "-"
    );
    drop(span);

    // 21 x 64 + 1 closed spans stay under the 2,048-span export queue, so no
    // sample is cheapened by the processor dropping spans once it is full.
    report_call("edge.session.splice span create + close", 64, || {
        drop(session_span(
            black_box("0123456789abcdef0123456789abcdef"),
            Role::Daemon,
        ));
    });
    let span = session_span("0123456789abcdef0123456789abcdef", Role::Browser);
    let ((), event) = measured(|| {
        let _entered = span.enter();
        tracing::info!(
            session_id = %"0123456789abcdef0123456789abcdef",
            "edge: splice complete (browser <-> daemon paired)"
        );
    });
    drop(span);
    println!(
        "{:<52} {:>8} {:>8} {:>9} {:>9}",
        "one info! event inside the session span", "-", "-", event.allocations, event.bytes
    );
    meter.force_flush().expect("final metric export");
    println!(
        "sink received {} metric exports",
        metric_exports.load(std::sync::atomic::Ordering::Acquire)
    );
    drop(telemetry);
}
