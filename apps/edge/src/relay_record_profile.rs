//! Per-record profile of `RecordHead`, the only relay framing step outside
//! `relay.rs`: every reliable record's header passes through `push` before the
//! destination write.
//!
//! Receive chunks are built the way Quinn hands them over: slices of a frozen,
//! already-shared packet buffer, so each `split_to` is a reference-count step
//! rather than a promotion. Chunks are prepared before the timed loop and moved
//! into `push` one by one, exactly as `read_reliable_head` receives them.
//!
//! ```sh
//! cargo test --release --locked -p merkur-edge \
//!   relay::record::profile::record_head_push_profile -- --ignored --exact --nocapture --test-threads=1
//! ```

use std::hint::black_box;
use std::time::Instant;

use bytes::{BufMut, Bytes, BytesMut};

use super::RecordHead;
use crate::profile_support::{Tally, measured, percentile};

/// One QUIC-packet-sized shared buffer holding `payload`, sliced at `cuts`.
fn shared_chunks(payload: &[u8], cuts: &[usize]) -> Vec<Bytes> {
    let mut arena = BytesMut::with_capacity(payload.len() + 64);
    arena.put_slice(payload);
    // `split_to` moves the vector-backed buffer to shared storage, as Quinn's
    // receive path does before it slices STREAM frames out of a datagram.
    let packet = arena.split_to(payload.len()).freeze();
    let mut chunks = Vec::with_capacity(cuts.len() + 1);
    let mut start = 0;
    for &end in cuts.iter().chain(std::iter::once(&payload.len())) {
        chunks.push(packet.slice(start..end));
        start = end;
    }
    chunks
}

fn record(body_len: usize) -> Vec<u8> {
    let mut wire = Vec::with_capacity(4 + body_len);
    wire.extend_from_slice(&(body_len as u32).to_be_bytes());
    wire.resize(4 + body_len, 0x5a);
    wire
}

struct Workload {
    name: &'static str,
    /// Records completed per prepared stream.
    records: usize,
    /// The receive chunks of one prepared stream, in arrival order.
    chunks: Vec<Bytes>,
}

fn workloads() -> Vec<Workload> {
    let small = record(57);
    let large = record(1_100);
    let mut packed = Vec::new();
    for _ in 0..16 {
        packed.extend_from_slice(&small);
    }
    let bulk = record(16_384);
    vec![
        Workload {
            name: "57 B record, own chunk",
            records: 1,
            chunks: shared_chunks(&small, &[]),
        },
        Workload {
            name: "1100 B record, own chunk",
            records: 1,
            chunks: shared_chunks(&large, &[]),
        },
        Workload {
            name: "16 x 57 B records, one chunk",
            records: 16,
            chunks: shared_chunks(&packed, &[]),
        },
        Workload {
            name: "57 B record, header split 1+3",
            records: 1,
            chunks: shared_chunks(&small, &[1]),
        },
        Workload {
            name: "57 B record, header split 1+1+1+1",
            records: 1,
            chunks: shared_chunks(&small, &[1, 2, 3]),
        },
        Workload {
            name: "16 KiB record, 1200 B first chunk",
            records: 1,
            chunks: shared_chunks(&bulk[..1_200], &[]),
        },
    ]
}

/// The production header loop of `read_reliable_head`, fed from `chunks`.
fn drive(chunks: &mut std::vec::IntoIter<Bytes>, records: usize) -> usize {
    let mut pending = Bytes::new();
    let mut forwarded = 0;
    for _ in 0..records {
        let mut chunk = if pending.is_empty() {
            chunks.next().expect("chunk")
        } else {
            std::mem::take(&mut pending)
        };
        let mut head = RecordHead::new();
        while !head.push(&mut chunk).expect("valid header") {
            chunk = chunks.next().expect("header continuation");
        }
        pending = chunk;
        forwarded += head.chunks_mut().iter().map(Bytes::len).sum::<usize>();
        black_box(head.remaining());
        black_box(&mut head);
    }
    forwarded
}

#[test]
#[ignore = "profiling harness; run explicitly with --ignored --nocapture"]
fn record_head_push_profile() {
    let streams: usize = std::env::var("EDGE_PROFILE_STREAMS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(4_096);
    let samples: usize = std::env::var("EDGE_PROFILE_SAMPLES")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(31);
    println!("RecordHead::push: {samples} samples x {streams} prepared streams per workload");
    println!(
        "{:<36} {:>9} {:>9} {:>11} {:>10}",
        "workload", "p50 ns", "p95 ns", "allocs/rec", "bytes/rec"
    );
    for workload in workloads() {
        let mut per_record = Vec::with_capacity(samples);
        let mut total = Tally::default();
        for sample in 0..=samples {
            // Every stream gets its own references to the shared packet, so the
            // timed loop only moves chunks, as the receive path does.
            let prepared: Vec<Vec<Bytes>> = (0..streams).map(|_| workload.chunks.clone()).collect();
            let mut iterators: Vec<std::vec::IntoIter<Bytes>> =
                prepared.into_iter().map(Vec::into_iter).collect();
            let started = Instant::now();
            let (forwarded, tally) = measured(|| {
                let mut forwarded = 0;
                for chunks in iterators.iter_mut() {
                    forwarded += drive(chunks, workload.records);
                }
                forwarded
            });
            let elapsed = started.elapsed().as_nanos() as f64;
            drop(iterators);
            black_box(forwarded);
            // Sample zero is warm-up.
            if sample > 0 {
                per_record.push(elapsed / (streams * workload.records) as f64);
                total.allocations += tally.allocations;
                total.bytes += tally.bytes;
            }
        }
        per_record.sort_by(f64::total_cmp);
        let records = (samples * streams * workload.records) as f64;
        println!(
            "{:<36} {:>9.1} {:>9.1} {:>11.4} {:>10.2}",
            workload.name,
            percentile(&per_record, 0.5),
            percentile(&per_record, 0.95),
            total.allocations as f64 / records,
            total.bytes as f64 / records,
        );
    }
}
