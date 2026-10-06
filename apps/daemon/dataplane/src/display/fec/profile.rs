//! Ignored profile of display parity encoding as the send path runs it.
//!
//! `FecEncoder::encode_borrowed_group_into` is what both parity producers call
//! for every protected datagram group, over borrowed datagrams of unequal
//! length, into a pooled repair frame. This profile times that production
//! wrapper beside the bare `merkur_fec::encode` over the same group padded
//! once outside the timed region, so the difference is everything the wrapper
//! does besides GF arithmetic (padding, staging and copies), and counts
//! steady-state allocator requests on the calling thread.
//!
//! Run with:
//! `cargo test --release --locked -p merkur-dataplane display::fec::profile -- --ignored --nocapture --test-threads=1`

use std::hint::black_box;
use std::time::Instant;

use crate::display::fec::FecEncoder;
use crate::display::policy::DisplayPolicy;
use crate::edge_tunnel::test_allocations;

/// Datagram lengths of one protected group and its recovery shard count, as
/// `fec_recovery_shard_count` assigns it: two shards up to 542 bytes, one up
/// to 1,084. The last member of a frame's group is usually short.
const GROUPS: [(&str, &[usize], usize); 6] = [
    ("bulk k4 m1", &[1084, 1084, 1084, 612], 1),
    ("bulk k3 m1", &[1084, 1084, 377], 1),
    ("bulk k2 m1", &[1084, 400], 1),
    ("mid k4 m2", &[542, 542, 542, 542], 2),
    ("mid k3 m2", &[542, 542, 300], 2),
    ("small k2 m2", &[180, 96], 2),
];
const SAMPLES: usize = 301;
const BATCH: usize = 200;

fn datagram(len: usize, seed: u64) -> Vec<u8> {
    let mut state = seed ^ 0x2545_f491_4f6c_dd1d;
    (0..len)
        .map(|_| {
            state = state
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (state >> 33) as u8
        })
        .collect()
}

fn time_per_call(mut run: impl FnMut()) -> (f64, f64) {
    for _ in 0..BATCH * 4 {
        run();
    }
    let mut per_call: Vec<f64> = (0..SAMPLES)
        .map(|_| {
            let start = Instant::now();
            for _ in 0..BATCH {
                run();
            }
            start.elapsed().as_nanos() as f64 / BATCH as f64
        })
        .collect();
    per_call.sort_by(f64::total_cmp);
    (
        per_call[per_call.len() / 2],
        per_call[(per_call.len() * 95) / 100],
    )
}

#[test]
#[ignore = "profile; run explicitly with --ignored --nocapture"]
fn fec_group_encode_profile() {
    println!(
        "fec_group_encode_profile: production FecEncoder::encode_borrowed_group_into vs bare \
         merkur_fec::encode, {SAMPLES}x{BATCH} calls"
    );
    println!(
        "group          shard  steady_allocs  wrapper_median  wrapper_p95  kernel_median  \
         kernel_p95  wrapper_share"
    );
    for (label, lengths, recovery_count) in GROUPS {
        assert!(recovery_count <= DisplayPolicy::FEC_RECOVERY_SHARD_COUNT);
        let datagrams: Vec<Vec<u8>> = lengths
            .iter()
            .enumerate()
            .map(|(index, len)| datagram(*len, (index * 7 + len) as u64))
            .collect();
        let payloads: Vec<&[u8]> = datagrams.iter().map(Vec::as_slice).collect();
        let shard = lengths.iter().copied().max().expect("group");

        let mut encoder = FecEncoder::new();
        // The pooled frame the send path hands in has already carried a repair.
        let mut out = Vec::new();
        assert!(encoder.encode_borrowed_group_into(7, 11, &payloads, recovery_count, &mut out));
        let expected = out.clone();

        test_allocations::begin_thread();
        assert!(encoder.encode_borrowed_group_into(7, 11, &payloads, recovery_count, &mut out));
        let steady = test_allocations::end_thread();
        assert_eq!(out, expected);

        let (wrapper_median, wrapper_p95) = time_per_call(|| {
            black_box(encoder.encode_borrowed_group_into(
                7,
                11,
                black_box(&payloads),
                recovery_count,
                &mut out,
            ));
        });
        assert_eq!(out, expected);

        // The same parity over shards padded once, outside the timed region.
        let padded: Vec<Vec<u8>> = datagrams
            .iter()
            .map(|payload| {
                let mut shard_bytes = payload.clone();
                shard_bytes.resize(shard, 0);
                shard_bytes
            })
            .collect();
        let padded_refs: Vec<&[u8]> = padded.iter().map(Vec::as_slice).collect();
        let mut recovery = vec![0u8; recovery_count * shard];
        let (kernel_median, kernel_p95) = time_per_call(|| {
            let (first, second) = recovery.split_at_mut(shard);
            let mut refs = [first, second];
            merkur_fec::encode(black_box(&padded_refs), &mut refs[..recovery_count])
                .expect("encode");
        });
        assert_eq!(
            &expected[merkur_codec::DISPLAY_FEC_HEADER_BYTES..],
            &recovery[..recovery_count * shard]
        );

        // `wrapper_share` is the fraction of the production call spent
        // outside the GF kernel over pre-padded shards: staging and copies.
        println!(
            "{label:<14} {shard:>5} {:>14} {wrapper_median:>15.1} {wrapper_p95:>12.1} \
             {kernel_median:>14.1} {kernel_p95:>11.1} {:>13.2}",
            steady.allocations,
            (wrapper_median - kernel_median) / wrapper_median
        );
        assert_eq!(steady.allocations, 0, "steady parity allocated");
    }
}
