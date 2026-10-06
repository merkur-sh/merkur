//! Exhaustive round-trip: for every batch shape (k, m) and every loss pattern
//! recoverable with m recovery shards, encode → drop → decode → assert equality.

use merkur_fec::{
    EncodeError, FEC_MAX_DATA, FEC_MAX_RECOVERY, FEC_MAX_SHARD_BYTES, decode, encode,
};

struct Rng(u64);
impl Rng {
    fn new(seed: u64) -> Self {
        Self(seed)
    }
    fn next_byte(&mut self) -> u8 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        (self.0 >> 33) as u8
    }
    fn fill(&mut self, buf: &mut [u8]) {
        for b in buf.iter_mut() {
            *b = self.next_byte();
        }
    }
}

fn run_one(k: usize, m: usize, shard_len: usize, drop_data_mask: u32, drop_recovery_mask: u32) {
    assert!(k <= FEC_MAX_DATA && m <= FEC_MAX_RECOVERY);
    let mut rng =
        Rng::new(0xa5f1_b3d7_2c80_4e51 ^ (k as u64) << 24 ^ (m as u64) << 16 ^ shard_len as u64);

    // Allocate originals.
    let mut originals: Vec<Vec<u8>> = (0..k)
        .map(|_| {
            let mut v = vec![0u8; shard_len];
            rng.fill(&mut v);
            v
        })
        .collect();

    let data_refs: Vec<&[u8]> = originals.iter().map(|v| v.as_slice()).collect();

    // Encode recovery.
    let mut recovery_storage: Vec<Vec<u8>> = (0..m).map(|_| vec![0u8; shard_len]).collect();
    {
        let mut recovery_refs: Vec<&mut [u8]> = recovery_storage
            .iter_mut()
            .map(|v| v.as_mut_slice())
            .collect();
        encode(&data_refs, &mut recovery_refs).unwrap();
    }

    // Construct "received" set by dropping selected shards.
    let received_data_mask = ((1u32 << k) - 1) & !drop_data_mask;
    let received_recovery_mask = ((1u32 << m) - 1) & !drop_recovery_mask;

    // Original-data slices: include all k; the decoder only reads those at bits set in mask.
    // We want to actually scrub the dropped slots so we can't accidentally
    // "cheat" by reading them — replace with an unrelated zero slice.
    let zero_slice = vec![0u8; shard_len];
    let received_data_refs: Vec<&[u8]> = (0..k)
        .map(|i| {
            if received_data_mask & (1 << i) != 0 {
                originals[i].as_slice()
            } else {
                zero_slice.as_slice()
            }
        })
        .collect();
    let recovery_refs: Vec<&[u8]> = (0..m)
        .map(|j| {
            if received_recovery_mask & (1 << j) != 0 {
                recovery_storage[j].as_slice()
            } else {
                zero_slice.as_slice()
            }
        })
        .collect();

    // Output buffer (same per-slot allocation as originals).
    let mut output_storage: Vec<Vec<u8>> = (0..k).map(|_| vec![0u8; shard_len]).collect();
    let restored_mask;
    {
        let mut output_refs: Vec<&mut [u8]> = output_storage
            .iter_mut()
            .map(|v| v.as_mut_slice())
            .collect();
        restored_mask = decode(
            received_data_mask,
            received_recovery_mask,
            &received_data_refs,
            &recovery_refs,
            &mut output_refs,
        );
    }

    let missing_mask = ((1u32 << k) - 1) & !received_data_mask;
    let recovery_count_received = received_recovery_mask.count_ones() as usize;
    let missing_count = missing_mask.count_ones() as usize;

    if missing_count == 0 {
        assert_eq!(restored_mask, 0, "no missing → no restoration expected");
        return;
    }
    if recovery_count_received < missing_count {
        assert_eq!(
            restored_mask, 0,
            "not enough recovery shards to recover {missing_count} missing"
        );
        return;
    }

    assert_eq!(
        restored_mask, missing_mask,
        "k={k} m={m} drop_data={drop_data_mask:04b} drop_rec={drop_recovery_mask:02b}"
    );

    // Compare restored slots to originals.
    let mut bits = restored_mask;
    while bits != 0 {
        let i = bits.trailing_zeros() as usize;
        assert_eq!(
            output_storage[i], originals[i],
            "restored shard {i} mismatch: k={k} m={m} drop_data={drop_data_mask:04b}"
        );
        bits &= bits - 1;
    }

    // Preserve originals reference (suppress "unused mut" warning on Rng future-proofing).
    let _ = &mut originals;
}

#[test]
fn all_loss_patterns_round_trip() {
    let shard_lens = [1usize, 7, 16, 100, 257, 1199, 1200, 1300];
    for k in 1..=FEC_MAX_DATA {
        for m in 1..=FEC_MAX_RECOVERY {
            for &shard_len in &shard_lens {
                let data_full = (1u32 << k) - 1;
                let recovery_full = (1u32 << m) - 1;
                // Enumerate every subset of data to drop (including empty).
                for drop_data in 0..=data_full {
                    // For every subset of recovery to drop.
                    for drop_recovery in 0..=recovery_full {
                        run_one(k, m, shard_len, drop_data, drop_recovery);
                    }
                }
            }
        }
    }
}

/// Data shards shorter than the recovery shards encode as if zero-padded, so
/// the display sender hands `encode` its datagrams as they went on the wire.
/// Every shape and loss pattern, with sources ending inside the final vector
/// chunk, inside an earlier one, before the first vector, and at zero bytes.
#[test]
fn ragged_data_shards_encode_as_zero_padded() {
    let shard_lens = [5usize, 16, 33, 542, 1084, 1300];
    for k in 1..=FEC_MAX_DATA {
        for m in 1..=FEC_MAX_RECOVERY {
            for &shard_len in &shard_lens {
                let mut rng = Rng::new(0x5eed ^ (k as u64) << 20 ^ (m as u64) << 12 ^ shard_len as u64);
                let lengths: Vec<usize> = (0..k)
                    .map(|i| match i {
                        0 => shard_len,
                        1 => shard_len - shard_len.min(3),
                        2 => shard_len.min(11),
                        _ => 0,
                    })
                    .collect();
                let originals: Vec<Vec<u8>> = lengths
                    .iter()
                    .map(|&len| {
                        let mut bytes = vec![0u8; len];
                        rng.fill(&mut bytes);
                        bytes
                    })
                    .collect();
                let padded: Vec<Vec<u8>> = originals
                    .iter()
                    .map(|bytes| {
                        let mut shard = bytes.clone();
                        shard.resize(shard_len, 0);
                        shard
                    })
                    .collect();

                let mut from_ragged: Vec<Vec<u8>> =
                    (0..m).map(|_| vec![0xa5u8; shard_len]).collect();
                let mut from_padded: Vec<Vec<u8>> = (0..m).map(|_| vec![0u8; shard_len]).collect();
                {
                    let ragged_refs: Vec<&[u8]> = originals.iter().map(Vec::as_slice).collect();
                    let mut refs: Vec<&mut [u8]> =
                        from_ragged.iter_mut().map(Vec::as_mut_slice).collect();
                    encode(&ragged_refs, &mut refs).expect("ragged data shards");
                    let padded_refs: Vec<&[u8]> = padded.iter().map(Vec::as_slice).collect();
                    let mut refs: Vec<&mut [u8]> =
                        from_padded.iter_mut().map(Vec::as_mut_slice).collect();
                    encode(&padded_refs, &mut refs).expect("padded data shards");
                }
                assert_eq!(from_ragged, from_padded, "k={k} m={m} lengths={lengths:?}");

                let data_full = (1u32 << k) - 1;
                for drop_data in 1..=data_full {
                    if drop_data.count_ones() as usize > m {
                        continue;
                    }
                    let received_mask = data_full & !drop_data;
                    let received: Vec<&[u8]> = padded.iter().map(Vec::as_slice).collect();
                    let recovery: Vec<&[u8]> = from_ragged.iter().map(Vec::as_slice).collect();
                    let mut output: Vec<Vec<u8>> = (0..k).map(|_| vec![0u8; shard_len]).collect();
                    let restored = {
                        let mut refs: Vec<&mut [u8]> =
                            output.iter_mut().map(Vec::as_mut_slice).collect();
                        decode(received_mask, (1u32 << m) - 1, &received, &recovery, &mut refs)
                    };
                    assert_eq!(restored, drop_data, "k={k} m={m} drop={drop_data:04b}");
                    for i in 0..k {
                        if drop_data & (1 << i) != 0 {
                            assert_eq!(output[i], padded[i], "k={k} m={m} shard {i}");
                        }
                    }
                }
            }
        }
    }
}

#[test]
fn rejects_oversized_shard() {
    let originals: [Vec<u8>; 2] = [vec![1u8; 8192], vec![2u8; 8192]];
    let data_refs: Vec<&[u8]> = originals.iter().map(|v| v.as_slice()).collect();
    let mut rec0 = vec![0u8; 8192];
    let mut rec1 = vec![0u8; 8192];
    {
        let mut recovery_refs: Vec<&mut [u8]> = vec![rec0.as_mut_slice(), rec1.as_mut_slice()];
        assert_eq!(
            encode(&data_refs, &mut recovery_refs),
            Err(EncodeError::InvalidShardLength)
        );
    }
    let zero = vec![0u8; 8192];
    let received_data: Vec<&[u8]> = vec![zero.as_slice(), originals[1].as_slice()];
    let recovery_refs: Vec<&[u8]> = vec![rec0.as_slice(), rec1.as_slice()];
    let mut output: [Vec<u8>; 2] = [vec![0u8; 8192], vec![0u8; 8192]];
    let mut output_refs: Vec<&mut [u8]> = output.iter_mut().map(|v| v.as_mut_slice()).collect();
    let restored = decode(0b10, 0b11, &received_data, &recovery_refs, &mut output_refs);
    assert_eq!(
        restored, 0,
        "shard_len > FEC_MAX_SHARD_BYTES must fail cleanly"
    );
}

#[test]
fn encode_rejects_every_invalid_shape_without_panicking_or_mutating_output() {
    let shard = [0x11u8; 8];
    let mut recovery = [0xa5u8; 8];

    let mut no_data_recovery = [&mut recovery[..]];
    assert_eq!(
        encode(&[], &mut no_data_recovery),
        Err(EncodeError::InvalidDataShardCount)
    );
    assert_eq!(recovery, [0xa5; 8]);

    let data_too_many = [&shard[..]; FEC_MAX_DATA + 1];
    let mut one_recovery = [&mut recovery[..]];
    assert_eq!(
        encode(&data_too_many, &mut one_recovery),
        Err(EncodeError::InvalidDataShardCount)
    );
    assert_eq!(recovery, [0xa5; 8]);

    let data = [&shard[..]];
    assert_eq!(
        encode(&data, &mut []),
        Err(EncodeError::InvalidRecoveryShardCount)
    );

    let mut r0 = [0xa5u8; 8];
    let mut r1 = [0xa5u8; 8];
    let mut r2 = [0xa5u8; 8];
    let mut too_many_recovery = [&mut r0[..], &mut r1[..], &mut r2[..]];
    assert_eq!(
        encode(&data, &mut too_many_recovery),
        Err(EncodeError::InvalidRecoveryShardCount)
    );
    assert_eq!(r0, [0xa5; 8]);
    assert_eq!(r1, [0xa5; 8]);
    assert_eq!(r2, [0xa5; 8]);

    let long = [0x33u8; 9];
    let mismatched_data = [&shard[..], &long[..]];
    let mut one_recovery = [&mut recovery[..]];
    assert_eq!(
        encode(&mismatched_data, &mut one_recovery),
        Err(EncodeError::ShardLengthMismatch)
    );
    assert_eq!(recovery, [0xa5; 8]);

    let mut short_recovery = [0xa5u8; 7];
    let mut mismatched_recovery = [&mut short_recovery[..]];
    assert_eq!(
        encode(&data, &mut mismatched_recovery),
        Err(EncodeError::ShardLengthMismatch)
    );
    assert_eq!(short_recovery, [0xa5; 7]);

    let empty = [];
    let mut empty_recovery = [];
    let empty_data = [&empty[..]];
    let mut empty_recovery_refs = [&mut empty_recovery[..]];
    assert_eq!(
        encode(&empty_data, &mut empty_recovery_refs),
        Err(EncodeError::InvalidShardLength)
    );

    let oversized = vec![0x33u8; FEC_MAX_SHARD_BYTES + 1];
    let mut oversized_recovery = vec![0xa5u8; oversized.len()];
    let oversized_data = [&oversized[..]];
    let mut oversized_recovery_refs = [&mut oversized_recovery[..]];
    assert_eq!(
        encode(&oversized_data, &mut oversized_recovery_refs),
        Err(EncodeError::InvalidShardLength)
    );
    assert!(oversized_recovery.iter().all(|&byte| byte == 0xa5));
}
