//! Measures FEC encode/decode latency for the display batch shape used in
//! production: up to 4 data shards of 100..=1200 bytes, 2 recovery shards.
//!
//! Compares `merkur_fec` (hand-rolled Cauchy GF(2^8)) against the XOR-only
//! baseline that we used before adding multi-shard recovery.

use criterion::{BenchmarkId, Criterion, Throughput, criterion_group, criterion_main};
use merkur_fec::FEC_MAX_RECOVERY;
use std::hint::black_box;

const SHARD_SIZES: [usize; 4] = [100, 400, 800, 1200];
const DATA_COUNTS: [usize; 3] = [2, 3, 4];

fn make_payload(size: usize, seed: u64) -> Vec<u8> {
    let mut buf = vec![0u8; size];
    let mut state = seed;
    for byte in &mut buf {
        state = state
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        *byte = (state >> 33) as u8;
    }
    buf
}

fn bench_encode(c: &mut Criterion) {
    let mut group = c.benchmark_group("fec_gf256_encode");
    for &shard_size in &SHARD_SIZES {
        for &data_count in &DATA_COUNTS {
            group.throughput(Throughput::Bytes((data_count * shard_size) as u64));
            group.bench_with_input(
                BenchmarkId::new(format!("d{data_count}_r{FEC_MAX_RECOVERY}"), shard_size),
                &(data_count, shard_size),
                |b, &(data_count, shard_size)| {
                    let payloads: Vec<Vec<u8>> = (0..data_count)
                        .map(|i| make_payload(shard_size, i as u64 + 1))
                        .collect();
                    let data_refs: Vec<&[u8]> = payloads.iter().map(Vec::as_slice).collect();
                    let mut recovery: Vec<Vec<u8>> = (0..FEC_MAX_RECOVERY)
                        .map(|_| vec![0u8; shard_size])
                        .collect();
                    b.iter(|| {
                        let mut recovery_refs: Vec<&mut [u8]> =
                            recovery.iter_mut().map(Vec::as_mut_slice).collect();
                        merkur_fec::encode(&data_refs, &mut recovery_refs).unwrap();
                        black_box(recovery_refs[0][0]);
                    });
                },
            );
        }
    }
    group.finish();
}

fn bench_decode_lose_one(c: &mut Criterion) {
    let mut group = c.benchmark_group("fec_gf256_decode_lose1");
    for &shard_size in &SHARD_SIZES {
        for &data_count in &DATA_COUNTS {
            group.throughput(Throughput::Bytes((data_count * shard_size) as u64));
            group.bench_with_input(
                BenchmarkId::new(format!("d{data_count}_r{FEC_MAX_RECOVERY}"), shard_size),
                &(data_count, shard_size),
                |b, &(data_count, shard_size)| {
                    let payloads: Vec<Vec<u8>> = (0..data_count)
                        .map(|i| make_payload(shard_size, i as u64 + 1))
                        .collect();
                    let data_refs: Vec<&[u8]> = payloads.iter().map(Vec::as_slice).collect();
                    let mut recovery: Vec<Vec<u8>> = (0..FEC_MAX_RECOVERY)
                        .map(|_| vec![0u8; shard_size])
                        .collect();
                    {
                        let mut recovery_refs: Vec<&mut [u8]> =
                            recovery.iter_mut().map(Vec::as_mut_slice).collect();
                        merkur_fec::encode(&data_refs, &mut recovery_refs).unwrap();
                    }
                    let recovery_refs: Vec<&[u8]> = recovery.iter().map(Vec::as_slice).collect();
                    let zero = vec![0u8; shard_size];
                    let received_data: Vec<&[u8]> = (0..data_count)
                        .map(|i| {
                            if i == 0 {
                                zero.as_slice()
                            } else {
                                payloads[i].as_slice()
                            }
                        })
                        .collect();
                    let received_data_mask = ((1u32 << data_count) - 1) & !1u32;
                    let mut output: Vec<Vec<u8>> =
                        (0..data_count).map(|_| vec![0u8; shard_size]).collect();
                    b.iter(|| {
                        let mut output_refs: Vec<&mut [u8]> =
                            output.iter_mut().map(Vec::as_mut_slice).collect();
                        let restored = merkur_fec::decode(
                            received_data_mask,
                            0b01,
                            &received_data,
                            &recovery_refs,
                            &mut output_refs,
                        );
                        black_box(restored);
                    });
                },
            );
        }
    }
    group.finish();
}

fn bench_decode_lose_two(c: &mut Criterion) {
    let mut group = c.benchmark_group("fec_gf256_decode_lose2");
    for &shard_size in &SHARD_SIZES {
        // lose-2 requires data_count >= 2.
        for &data_count in &DATA_COUNTS {
            group.throughput(Throughput::Bytes((data_count * shard_size) as u64));
            group.bench_with_input(
                BenchmarkId::new(format!("d{data_count}_r{FEC_MAX_RECOVERY}"), shard_size),
                &(data_count, shard_size),
                |b, &(data_count, shard_size)| {
                    let payloads: Vec<Vec<u8>> = (0..data_count)
                        .map(|i| make_payload(shard_size, i as u64 + 1))
                        .collect();
                    let data_refs: Vec<&[u8]> = payloads.iter().map(Vec::as_slice).collect();
                    let mut recovery: Vec<Vec<u8>> = (0..FEC_MAX_RECOVERY)
                        .map(|_| vec![0u8; shard_size])
                        .collect();
                    {
                        let mut recovery_refs: Vec<&mut [u8]> =
                            recovery.iter_mut().map(Vec::as_mut_slice).collect();
                        merkur_fec::encode(&data_refs, &mut recovery_refs).unwrap();
                    }
                    let recovery_refs: Vec<&[u8]> = recovery.iter().map(Vec::as_slice).collect();
                    let zero = vec![0u8; shard_size];
                    // Lose shards 0 and 1.
                    let received_data: Vec<&[u8]> = (0..data_count)
                        .map(|i| {
                            if i < 2 {
                                zero.as_slice()
                            } else {
                                payloads[i].as_slice()
                            }
                        })
                        .collect();
                    let received_data_mask = ((1u32 << data_count) - 1) & !0b11u32;
                    let mut output: Vec<Vec<u8>> =
                        (0..data_count).map(|_| vec![0u8; shard_size]).collect();
                    b.iter(|| {
                        let mut output_refs: Vec<&mut [u8]> =
                            output.iter_mut().map(Vec::as_mut_slice).collect();
                        let restored = merkur_fec::decode(
                            received_data_mask,
                            0b11,
                            &received_data,
                            &recovery_refs,
                            &mut output_refs,
                        );
                        black_box(restored);
                    });
                },
            );
        }
    }
    group.finish();
}

fn bench_xor_baseline(c: &mut Criterion) {
    // XOR-only single-parity reference: bytes/sec for the simplest possible
    // FEC. Useful as a "what is this hardware's memcpy-class throughput?"
    // baseline for the encode benches above.
    let mut group = c.benchmark_group("fec_xor_encode_baseline");
    for &shard_size in &SHARD_SIZES {
        for &data_count in &DATA_COUNTS {
            group.throughput(Throughput::Bytes((data_count * shard_size) as u64));
            group.bench_with_input(
                BenchmarkId::new(format!("d{data_count}_r1"), shard_size),
                &(data_count, shard_size),
                |b, &(data_count, shard_size)| {
                    let payloads: Vec<Vec<u8>> = (0..data_count)
                        .map(|i| make_payload(shard_size, i as u64 + 1))
                        .collect();
                    let mut repair = vec![0u8; shard_size];
                    b.iter(|| {
                        repair.fill(0);
                        for payload in &payloads {
                            for (i, &b) in payload.iter().enumerate() {
                                repair[i] ^= b;
                            }
                        }
                        black_box(repair[0]);
                    });
                },
            );
        }
    }
    group.finish();
}

criterion_group!(
    benches,
    bench_encode,
    bench_decode_lose_one,
    bench_decode_lose_two,
    bench_xor_baseline,
);
criterion_main!(benches);
