//! Per-heartbeat cost of registration publication.
//!
//! Drives the real `EdgePublisher::publish` against a loopback HTTP sink on a
//! current-thread runtime, so the request build, the authentication tag, the
//! reqwest/hyper exchange and the connection task all run on the measured
//! thread. The sink either keeps the connection alive or closes it after every
//! answer, bracketing a server that keeps the 30-second heartbeat connection
//! and one that does not. No telemetry pipeline is installed here; the
//! `edge.register.publish` span's own cost is the span line in the telemetry
//! profile.
//!
//! ```sh
//! cargo test --release --locked -p merkur-edge \
//!   register::profile::edge_registration_heartbeat_profile -- --ignored --exact --nocapture --test-threads=1
//! ```

use std::hint::black_box;
use std::time::Instant;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;

use super::{EdgePublisher, REGISTRATION_KEY_BYTES, RegisterBody};
use crate::profile_support::{Tally, http_sink, measured, percentile};

const ACTIVE_HASH: &str = "Qr4ZuCBq6NiQejuKBH9LF4gS6GICM00rGduNd31OVXw=";
const NEXT_HASH: &str = "QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=";

fn pinned() -> [String; 2] {
    [ACTIVE_HASH.to_string(), NEXT_HASH.to_string()]
}
const REGISTER_PATH: &str = "/api/edge/register";

fn publisher(sink: std::net::SocketAddr) -> EdgePublisher {
    EdgePublisher::new(
        format!("http://{sink}{REGISTER_PATH}"),
        URL_SAFE_NO_PAD.encode([0x41_u8; REGISTRATION_KEY_BYTES]),
        "iad-1".into(),
        "iad".into(),
        "https://iad-1.edge.example:4433/".into(),
    )
    .expect("publisher")
}

fn report(name: &str, mut samples: Vec<f64>, tally: Tally, operations: usize) {
    samples.sort_by(f64::total_cmp);
    println!(
        "{:<40} {:>10.2} {:>10.2} {:>9.1} {:>9.1}",
        name,
        percentile(&samples, 0.5),
        percentile(&samples, 0.95),
        tally.allocations as f64 / operations as f64,
        tally.bytes as f64 / operations as f64,
    );
}

#[test]
#[ignore = "profiling harness; run explicitly with --ignored --nocapture"]
fn edge_registration_heartbeat_profile() {
    crate::install_crypto_provider();
    let heartbeats: usize = std::env::var("EDGE_PROFILE_HEARTBEATS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(400);
    println!("registration heartbeat: {heartbeats} publications per row, loopback sink");
    println!(
        "{:<40} {:>10} {:>10} {:>9} {:>9}",
        "operation", "p50 us", "p95 us", "allocs", "bytes"
    );

    // The local half of `publish`: canonical body plus authentication.
    {
        let (sink, _) = http_sink(false, REGISTER_PATH);
        let publisher = publisher(sink);
        let mut samples = Vec::with_capacity(heartbeats);
        let mut total = Tally::default();
        for _ in 0..heartbeats {
            let accepted = pinned();
            let started = Instant::now();
            let (auth, tally) = measured(|| {
                let body = RegisterBody {
                    edge_id: &publisher.edge_id,
                    edge_region: &publisher.edge_region,
                    edge_wt_url: &publisher.edge_wt_url,
                    cert_hash: ACTIVE_HASH,
                    cert_hashes: &accepted,
                };
                let encoded = serde_json::to_vec(&body).expect("body");
                let auth = publisher.authenticate_payload(&encoded).expect("auth");
                (encoded, auth)
            });
            samples.push(started.elapsed().as_nanos() as f64 / 1_000.0);
            black_box(auth);
            total.allocations += tally.allocations;
            total.bytes += tally.bytes;
        }
        report("body + authentication tag", samples, total, heartbeats);
    }

    for (name, close) in [
        ("publish, kept-alive connection", false),
        ("publish, connection closed each time", true),
    ] {
        let (sink, received) = http_sink(close, REGISTER_PATH);
        let publisher = publisher(sink);
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        let accepted = pinned();
        for _ in 0..8 {
            runtime
                .block_on(publisher.publish(&accepted))
                .expect("warm-up publish");
        }
        let mut samples = Vec::with_capacity(heartbeats);
        let mut total = Tally::default();
        for _ in 0..heartbeats {
            let started = Instant::now();
            let (result, tally) = measured(|| runtime.block_on(publisher.publish(&accepted)));
            samples.push(started.elapsed().as_nanos() as f64 / 1_000.0);
            result.expect("publish");
            total.allocations += tally.allocations;
            total.bytes += tally.bytes;
        }
        report(name, samples, total, heartbeats);
        assert_eq!(
            received.load(std::sync::atomic::Ordering::Acquire),
            heartbeats + 8
        );
    }
}
