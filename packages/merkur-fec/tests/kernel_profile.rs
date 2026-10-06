//! Ignored profiles for the display FEC kernels.
//!
//! Every workload calls the production `encode`, `decode` and
//! `repair::recover_batch_into` over the shapes the daemon planner can emit
//! (`fec_recovery_shard_count`): two recovery shards while two shards fit one
//! 1,100-byte datagram after the 16-byte repair header (at most 542 bytes),
//! one recovery shard up to 1,084 bytes, and two to four data shards.
//! Each profile reports exact allocator requests (the crate promises none) and
//! per-call wall time as the median and p95 of many batched samples. Output is
//! checked against a scalar GF(2^8) oracle first, so a faster kernel that
//! changes a single parity byte fails here before it is timed.
//!
//! Run with:
//! `cargo test --release --locked -p merkur-fec --test kernel_profile -- --ignored --nocapture --test-threads=1`

use std::alloc::{GlobalAlloc, Layout, System};
use std::hint::black_box;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Instant;

use merkur_fec::repair::{RepairHeader, recover_batch_into};
use merkur_fec::{FEC_MAX_DATA, FEC_MAX_RECOVERY, PARITY, decode, encode};

struct CountingAllocator;

static COUNTING: AtomicBool = AtomicBool::new(false);
static ALLOCATIONS: AtomicUsize = AtomicUsize::new(0);
static ALLOCATED_BYTES: AtomicUsize = AtomicUsize::new(0);

#[global_allocator]
static ALLOCATOR: CountingAllocator = CountingAllocator;

// SAFETY: every method forwards the caller's layout and pointer unchanged to
// the system allocator; counting touches only atomics.
unsafe impl GlobalAlloc for CountingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        record(layout.size());
        // SAFETY: the caller's `layout` reaches `System` unchanged, so the
        // caller's obligations are exactly `System`'s.
        unsafe { System.alloc(layout) }
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        record(layout.size());
        // SAFETY: the caller's `layout` reaches `System` unchanged, so the
        // caller's obligations are exactly `System`'s.
        unsafe { System.alloc_zeroed(layout) }
    }
    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        // SAFETY: every block this allocator hands out is `System`'s, so
        // `pointer` and `layout` name a block `System` allocated.
        unsafe { System.dealloc(pointer, layout) }
    }
    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        record(size);
        // SAFETY: `pointer` and `layout` name a block `System` allocated, and
        // the caller's new size reaches it unchanged.
        unsafe { System.realloc(pointer, layout, size) }
    }
}

fn record(bytes: usize) {
    if COUNTING.load(Ordering::Relaxed) {
        ALLOCATIONS.fetch_add(1, Ordering::Relaxed);
        ALLOCATED_BYTES.fetch_add(bytes, Ordering::Relaxed);
    }
}

/// Allocator requests and requested bytes made by `run`.
fn count_allocations(run: impl FnOnce()) -> (usize, usize) {
    ALLOCATIONS.store(0, Ordering::Relaxed);
    ALLOCATED_BYTES.store(0, Ordering::Relaxed);
    COUNTING.store(true, Ordering::SeqCst);
    run();
    COUNTING.store(false, Ordering::SeqCst);
    (
        ALLOCATIONS.load(Ordering::Relaxed),
        ALLOCATED_BYTES.load(Ordering::Relaxed),
    )
}

fn payload(len: usize, seed: u64) -> Vec<u8> {
    let mut state = seed ^ 0x9e37_79b9_7f4a_7c15;
    (0..len)
        .map(|_| {
            state = state
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (state >> 33) as u8
        })
        .collect()
}

/// Scalar GF(2^8) multiply over 0x11D, independent of the crate's tables.
fn gf_mul(mut a: u8, mut b: u8) -> u8 {
    let mut product = 0u8;
    while b != 0 {
        if b & 1 != 0 {
            product ^= a;
        }
        let carry = a & 0x80 != 0;
        a <<= 1;
        if carry {
            a ^= 0x1d;
        }
        b >>= 1;
    }
    product
}

fn oracle_parity(data: &[&[u8]], j: usize, shard_len: usize) -> Vec<u8> {
    let mut parity = vec![0u8; shard_len];
    for (i, shard) in data.iter().enumerate() {
        for (byte, source) in parity.iter_mut().zip(shard.iter()) {
            *byte ^= gf_mul(PARITY[j][i], *source);
        }
    }
    parity
}

/// Median and p95 nanoseconds per call over `samples` batches of `batch` calls.
fn time_per_call(samples: usize, batch: usize, mut run: impl FnMut()) -> (f64, f64) {
    for _ in 0..batch * 4 {
        run();
    }
    let mut per_call: Vec<f64> = (0..samples)
        .map(|_| {
            let start = Instant::now();
            for _ in 0..batch {
                run();
            }
            start.elapsed().as_nanos() as f64 / batch as f64
        })
        .collect();
    per_call.sort_by(f64::total_cmp);
    let median = per_call[per_call.len() / 2];
    let p95 = per_call[(per_call.len() * 95) / 100];
    (median, p95)
}

/// (data shards, recovery shards, shard bytes) the planner can emit, plus the
/// Criterion bench's 1,200-byte two-recovery corner.
const SHAPES: [(usize, usize, usize); 9] = [
    (2, 2, 128),
    (2, 2, 542),
    (3, 2, 542),
    (4, 2, 542),
    (2, 1, 1084),
    (3, 1, 1084),
    (4, 1, 1084),
    (4, 2, 64),
    (4, 2, 1200),
];
const SAMPLES: usize = 301;
const BATCH: usize = 200;

struct Fixture {
    data: Vec<Vec<u8>>,
    recovery: Vec<Vec<u8>>,
    shard_len: usize,
}

impl Fixture {
    fn new(k: usize, m: usize, shard_len: usize) -> Self {
        let data: Vec<Vec<u8>> = (0..k)
            .map(|i| payload(shard_len, (k * 131 + m * 17 + shard_len + i) as u64))
            .collect();
        let mut recovery: Vec<Vec<u8>> = (0..m).map(|_| vec![0u8; shard_len]).collect();
        {
            let refs: Vec<&[u8]> = data.iter().map(Vec::as_slice).collect();
            let mut recovery_refs: Vec<&mut [u8]> =
                recovery.iter_mut().map(Vec::as_mut_slice).collect();
            encode(&refs, &mut recovery_refs).expect("encode");
        }
        for (j, parity) in recovery.iter().enumerate() {
            let refs: Vec<&[u8]> = data.iter().map(Vec::as_slice).collect();
            assert_eq!(
                parity,
                &oracle_parity(&refs, j, shard_len),
                "production parity {j} diverges from the scalar oracle"
            );
        }
        Self {
            data,
            recovery,
            shard_len,
        }
    }
}

#[test]
#[ignore = "profile; run explicitly with --ignored --nocapture"]
fn fec_encode_profile() {
    println!("fec_encode_profile: production merkur_fec::encode, {SAMPLES}x{BATCH} calls");
    println!("shape            allocs  bytes  median_ns  p95_ns  ns_per_input_byte");
    for (k, m, shard_len) in SHAPES {
        let fixture = Fixture::new(k, m, shard_len);
        let data: [&[u8]; FEC_MAX_DATA] =
            std::array::from_fn(|i| fixture.data.get(i).map_or(&[][..], Vec::as_slice));
        let mut recovery = fixture.recovery.clone();
        let (allocations, bytes) = count_allocations(|| {
            let (first, rest) = recovery.split_at_mut(1);
            let mut refs: [&mut [u8]; FEC_MAX_RECOVERY] = [&mut first[0][..], &mut []];
            if let Some(second) = rest.first_mut() {
                refs[1] = &mut second[..];
            }
            encode(&data[..k], &mut refs[..m]).expect("encode");
        });
        let (median, p95) = time_per_call(SAMPLES, BATCH, || {
            let (first, rest) = recovery.split_at_mut(1);
            let mut refs: [&mut [u8]; FEC_MAX_RECOVERY] = [&mut first[0][..], &mut []];
            if let Some(second) = rest.first_mut() {
                refs[1] = &mut second[..];
            }
            encode(black_box(&data[..k]), &mut refs[..m]).expect("encode");
            black_box(&recovery);
        });
        assert_eq!(recovery, fixture.recovery);
        println!(
            "k{k} m{m} s{shard_len:<5}   {allocations:>6} {bytes:>6} {median:>10.1} {p95:>7.1} {:>18.4}",
            median / (k * shard_len) as f64
        );
    }
}

/// Lose `lost_data` data shards (lowest indices first) and rebuild them with
/// the first `lost_data` recovery shards.
fn decode_case(fixture: &Fixture, k: usize, m: usize, lost_data: u32) -> (usize, usize, f64, f64) {
    let shard_len = fixture.shard_len;
    let missing_mask = (1u32 << lost_data) - 1;
    let received_mask = ((1u32 << k) - 1) & !missing_mask;
    let recovery_mask = (1u32 << m) - 1;
    let zero = vec![0u8; shard_len];
    let received: Vec<&[u8]> = (0..k)
        .map(|i| {
            if received_mask & (1 << i) != 0 {
                fixture.data[i].as_slice()
            } else {
                zero.as_slice()
            }
        })
        .collect();
    let recovery: Vec<&[u8]> = fixture.recovery.iter().map(Vec::as_slice).collect();
    let mut output: Vec<Vec<u8>> = (0..k).map(|_| vec![0u8; shard_len]).collect();
    let run = |output: &mut Vec<Vec<u8>>| {
        let mut slots: [&mut [u8]; FEC_MAX_DATA] = Default::default();
        for (slot, shard) in slots.iter_mut().zip(output.iter_mut()) {
            *slot = shard.as_mut_slice();
        }
        decode(
            received_mask,
            recovery_mask,
            black_box(&received),
            &recovery,
            &mut slots[..k],
        )
    };
    let mut restored = 0;
    let (allocations, bytes) = count_allocations(|| restored = run(&mut output));
    assert_eq!(restored, missing_mask);
    for (i, (rebuilt, original)) in output.iter().zip(&fixture.data).enumerate() {
        if i < lost_data as usize {
            assert_eq!(rebuilt, original, "rebuilt shard {i}");
        }
    }
    let (median, p95) = time_per_call(SAMPLES, BATCH, || {
        black_box(run(&mut output));
    });
    (allocations, bytes, median, p95)
}

#[test]
#[ignore = "profile; run explicitly with --ignored --nocapture"]
fn fec_decode_profile() {
    println!("fec_decode_profile: production merkur_fec::decode, {SAMPLES}x{BATCH} calls");
    println!("shape            lost  allocs  bytes  median_ns  p95_ns");
    for (k, m, shard_len) in SHAPES {
        let fixture = Fixture::new(k, m, shard_len);
        for lost in 1..=m as u32 {
            let (allocations, bytes, median, p95) = decode_case(&fixture, k, m, lost);
            println!(
                "k{k} m{m} s{shard_len:<5}   {lost:>4} {allocations:>7} {bytes:>6} {median:>10.1} {p95:>7.1}"
            );
        }
    }
}

/// The fixed per-call cost of `decode` shows up as the intercept of time
/// against shard length. A one-byte shard does one byte of GF work per pass,
/// so what remains is validation plus any work that does not scale with the
/// shard.
#[test]
#[ignore = "profile; run explicitly with --ignored --nocapture"]
fn fec_decode_fixed_cost_profile() {
    println!("fec_decode_fixed_cost_profile: k4 m2, lose 1 and 2, time vs shard bytes");
    println!("shard_bytes  lose1_median_ns  lose2_median_ns");
    for shard_len in [1usize, 16, 64, 128, 256, 542, 1084] {
        let fixture = Fixture::new(4, 2, shard_len);
        let (_, _, one, _) = decode_case(&fixture, 4, 2, 1);
        let (_, _, two, _) = decode_case(&fixture, 4, 2, 2);
        println!("{shard_len:>11} {one:>16.1} {two:>16.1}");
    }
}

/// `recover_batch_into` pads every received shard into caller scratch before
/// decoding. Only harness transcripts call it today; the browser stages
/// padded shards itself and calls `decode` through `term-wasm`.
#[test]
#[ignore = "profile; run explicitly with --ignored --nocapture"]
fn fec_recover_batch_profile() {
    println!("fec_recover_batch_profile: production repair::recover_batch_into, lose 1");
    println!("shape            allocs  bytes  median_ns  p95_ns");
    for (k, m, shard_len) in SHAPES {
        let fixture = Fixture::new(k, m, shard_len);
        let header = RepairHeader {
            batch_start_seq: 1,
            data_shards: k as u8,
            recovery_shards: m as u8,
            shard_size: shard_len as u16,
            generation: 1,
        };
        let body: Vec<u8> = fixture.recovery.concat();
        let received: Vec<Option<&[u8]>> = (0..k)
            .map(|i| (i != 0).then(|| fixture.data[i].as_slice()))
            .collect();
        let mut padded = vec![0u8; k * shard_len];
        let mut output = vec![0u8; k * shard_len];
        let mut restored = 0;
        let (allocations, bytes) = count_allocations(|| {
            restored = recover_batch_into(&header, &received, &body, &mut padded, &mut output);
        });
        assert_eq!(restored, 1);
        assert_eq!(&output[..shard_len], fixture.data[0].as_slice());
        let (median, p95) = time_per_call(SAMPLES, BATCH, || {
            black_box(recover_batch_into(
                &header,
                black_box(&received),
                &body,
                &mut padded,
                &mut output,
            ));
        });
        println!(
            "k{k} m{m} s{shard_len:<5}   {allocations:>6} {bytes:>6} {median:>10.1} {p95:>7.1}"
        );
    }
}
