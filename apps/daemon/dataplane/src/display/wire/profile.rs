//! Profiling harness for the sealed-datagram `WirePool`. Parity encoding has
//! its own profile in `display::fec::profile`.
//!
//! `seal_display_wire` takes one pooled owner per sealed display datagram,
//! recycles a clone immediately, and hands the owner to a carrier queue. The
//! burst profile replays that exact pool protocol with the carrier holding
//! every owner until the burst drains, the way a cwnd-clipped redraw queues.
//!
//! Run alone in release (the allocation counter is process-wide):
//!
//! ```sh
//! cargo test --release --locked -p merkur-dataplane \
//!   display::wire::profile::wire_pool_burst_profile \
//!   -- --ignored --exact --nocapture --test-threads=1
//! ```

use std::time::Instant;

use bytes::Bytes;

use crate::display::policy::DisplayPolicy;
use crate::display::wire::WirePool;
use crate::edge_tunnel::test_allocations;

fn samples() -> usize {
    std::env::var("BENCH_SAMPLES")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(200)
        .max(20)
}

/// `seal_display_wire`'s pool protocol, without the AEAD: take the rounded
/// owner, write it, freeze, recycle a clone, truncate the queued owner.
fn seal(pool: &mut WirePool, plaintext_len: usize) -> Bytes {
    let required = 1 + plaintext_len + crate::e2e::FRAME_OVERHEAD;
    let mut wire = pool.take(required);
    wire[0] = 1;
    let mut wire = wire.freeze();
    pool.recycle(wire.clone());
    wire.truncate(required);
    wire
}

fn percentile(sorted: &[f64], percentile: f64) -> f64 {
    let rank = (percentile * sorted.len() as f64).ceil().max(1.0) as usize - 1;
    sorted[rank.min(sorted.len() - 1)]
}

/// Bursts of sealed datagrams whose owners stay queued until the burst ends
/// (the carrier drains after sealing), then are released together. Reports
/// the pool CPU per sealed datagram and allocations per burst.
#[test]
#[ignore = "production send-helper workload; the counting allocator is process-wide"]
fn wire_pool_burst_profile() {
    let samples = samples();
    for burst in [1usize, 4, 32, 113, 256] {
        for (label, plaintext_len) in [
            ("full", DisplayPolicy::DATAGRAM_MAX_PAYLOAD_BYTES),
            ("mixed", 0),
        ] {
            let mut pool = WirePool::default();
            let mut queued: Vec<Bytes> = Vec::with_capacity(burst);
            let length = |index: usize| {
                if plaintext_len == 0 {
                    // Datagram payloads between a cursor-row delta and a full
                    // protected record, cycling through distinct size classes.
                    [96, 180, 420, 760, 1_084, 1_100][index % 6]
                } else {
                    plaintext_len
                }
            };
            let mut per_seal_ns = Vec::with_capacity(samples);
            let mut allocations = Vec::with_capacity(samples);
            for round in 0..samples + 10 {
                test_allocations::begin();
                let started = Instant::now();
                for index in 0..burst {
                    queued.push(seal(&mut pool, length(index)));
                }
                let ns = started.elapsed().as_nanos() as f64;
                let tally = test_allocations::end();
                std::hint::black_box(&queued);
                queued.clear();
                if round >= 10 {
                    per_seal_ns.push(ns / burst as f64);
                    allocations.push(tally.allocations as f64);
                }
            }
            per_seal_ns.sort_by(f64::total_cmp);
            allocations.sort_by(f64::total_cmp);
            eprintln!(
                "WIRE_POOL burst={burst} sizes={label} samples={samples} seal_pool_p50_ns={:.1} seal_pool_p95_ns={:.1} allocations_per_burst_p50={} allocations_per_burst_max={} retained_bytes={}",
                percentile(&per_seal_ns, 0.50),
                percentile(&per_seal_ns, 0.95),
                percentile(&allocations, 0.50),
                allocations.last().copied().unwrap_or(0.0),
                pool.retained_bytes(),
            );
        }
    }
}
