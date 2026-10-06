//! Systematic Cauchy Reed-Solomon over GF(2^8) for small batches.
//!
//! Sized for the display-FEC use case: at most `FEC_MAX_DATA` data shards and
//! `FEC_MAX_RECOVERY` recovery shards.
//!
//! Construction: parity matrix `P[j][i] = inv(x_j ⊕ y_i)` with
//! `x_j = j` and `y_i = FEC_MAX_RECOVERY + i`. The x and y sets are disjoint
//! so every (j, i) entry is well-defined, and every square submatrix of `P`
//! is invertible (MDS property of Cauchy matrices) — so any subset of received
//! shards totalling the data count uniquely determines the missing shards.

use crate::field;
use crate::simd::{MAX_OUTPUTS, MAX_SOURCES, NibbleTable, combine};

pub const FEC_MAX_DATA: usize = 4;
pub const FEC_MAX_RECOVERY: usize = 2;

/// Hard upper bound on shard byte length.
///
/// Sized for the wire-format limit (`DATAGRAM_MAX_PAYLOAD_BYTES = 1200`) plus
/// headroom.
pub const FEC_MAX_SHARD_BYTES: usize = 1300;

/// Why a recovery-shard encode request was rejected.
///
/// Validation happens before any recovery shard is modified, so callers may
/// safely reuse their output buffers after an error.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EncodeError {
    InvalidDataShardCount,
    InvalidRecoveryShardCount,
    InvalidShardLength,
    ShardLengthMismatch,
}

/// Cauchy parity matrix, computed at compile time.
///
/// `PARITY[j][i]` is the coefficient applied to data shard `i` when computing
/// recovery shard `j`. Submatrices at `[..m][..k]` retain the MDS property
/// for any `k ≤ FEC_MAX_DATA` and `m ≤ FEC_MAX_RECOVERY`.
pub const PARITY: [[u8; FEC_MAX_DATA]; FEC_MAX_RECOVERY] = compute_parity();

const _: () = assert!(FEC_MAX_DATA == MAX_SOURCES && FEC_MAX_RECOVERY == MAX_OUTPUTS);

/// Nibble tables of every `PARITY` coefficient, built at compile time so an
/// encode never rebuilds them.
const PARITY_TABLES: [[NibbleTable; FEC_MAX_DATA]; FEC_MAX_RECOVERY] = compute_parity_tables();

const fn compute_parity_tables() -> [[NibbleTable; FEC_MAX_DATA]; FEC_MAX_RECOVERY] {
    let mut tables = [[([0u8; 16], [0u8; 16]); FEC_MAX_DATA]; FEC_MAX_RECOVERY];
    let mut j = 0;
    while j < FEC_MAX_RECOVERY {
        let mut i = 0;
        while i < FEC_MAX_DATA {
            tables[j][i] = field::nibble_tables(PARITY[j][i]);
            i += 1;
        }
        j += 1;
    }
    tables
}

const fn compute_parity() -> [[u8; FEC_MAX_DATA]; FEC_MAX_RECOVERY] {
    let mut p = [[0u8; FEC_MAX_DATA]; FEC_MAX_RECOVERY];
    let mut j = 0;
    while j < FEC_MAX_RECOVERY {
        let mut i = 0;
        while i < FEC_MAX_DATA {
            let diff = (j as u8) ^ ((FEC_MAX_RECOVERY + i) as u8);
            // diff is non-zero because {0..FEC_MAX_RECOVERY} and
            // {FEC_MAX_RECOVERY..FEC_MAX_RECOVERY+FEC_MAX_DATA} are disjoint.
            p[j][i] = field::inv(diff);
            i += 1;
        }
        j += 1;
    }
    p
}

/// Compute `recovery.len()` recovery shards from `data.len()` data shards.
///
/// Every recovery shard must have the same byte length, which is the shard
/// length. A data shard may be shorter: it is encoded as if zero-padded to the
/// shard length, which is how the receiver pads it before decoding, so callers
/// never stage padded copies. `data.len()` must be ≤ `FEC_MAX_DATA`;
/// `recovery.len()` must be ≤ `FEC_MAX_RECOVERY`.
///
/// On exit each `recovery[j]` holds `⊕_i (PARITY[j][i] · data[i])`.
pub fn encode(data: &[&[u8]], recovery: &mut [&mut [u8]]) -> Result<(), EncodeError> {
    let k = data.len();
    let m = recovery.len();
    if k == 0 || k > FEC_MAX_DATA {
        return Err(EncodeError::InvalidDataShardCount);
    }
    if m == 0 || m > FEC_MAX_RECOVERY {
        return Err(EncodeError::InvalidRecoveryShardCount);
    }
    let shard_len = recovery[0].len();
    if shard_len == 0 || shard_len > FEC_MAX_SHARD_BYTES {
        return Err(EncodeError::InvalidShardLength);
    }
    if data.iter().any(|shard| shard.len() > shard_len)
        || recovery.iter().any(|shard| shard.len() != shard_len)
    {
        return Err(EncodeError::ShardLengthMismatch);
    }

    combine(data, &PARITY_TABLES[..m], recovery, shard_len);
    Ok(())
}

/// Recover missing data shards from a partial set of received originals plus
/// recovery shards.
///
/// * `received_data[i]` is read iff bit `i` of `received_data_mask` is set.
/// * `recovery[j]` is read iff bit `j` of `received_recovery_mask` is set.
/// * `output[i]` is written for every `i` ∈ `0..received_data.len()` that is
///   **not** in `received_data_mask`. Other `output` slots are left untouched.
///
/// Returns a bitmask of the data shard indices that were restored. Returns 0
/// if recovery is impossible (not enough received shards, shard length over
/// `FEC_MAX_SHARD_BYTES`, etc.).
pub fn decode(
    received_data_mask: u32,
    received_recovery_mask: u32,
    received_data: &[&[u8]],
    recovery: &[&[u8]],
    output: &mut [&mut [u8]],
) -> u32 {
    let k = received_data.len();
    let m = recovery.len();
    if k == 0 || k > FEC_MAX_DATA || m == 0 || m > FEC_MAX_RECOVERY {
        return 0;
    }
    if output.len() != k {
        return 0;
    }
    let data_mask_bits = if k == 32 { u32::MAX } else { (1u32 << k) - 1 };
    let recovery_mask_bits = if m == 32 { u32::MAX } else { (1u32 << m) - 1 };
    let received_data_mask = received_data_mask & data_mask_bits;
    let received_recovery_mask = received_recovery_mask & recovery_mask_bits;

    let missing_mask = data_mask_bits & !received_data_mask;
    if missing_mask == 0 {
        return 0;
    }
    let missing_count = missing_mask.count_ones() as usize;
    let recovery_avail = received_recovery_mask.count_ones() as usize;
    if recovery_avail < missing_count {
        return 0;
    }

    // Infer shard length from the first received shard we can find. Validate
    // that every shard we will read has the same length.
    let shard_len = find_shard_len(
        received_data_mask,
        received_data,
        received_recovery_mask,
        recovery,
    );
    let Some(shard_len) = shard_len else { return 0 };
    if shard_len == 0 || shard_len > FEC_MAX_SHARD_BYTES {
        return 0;
    }
    if !validate_lens(
        shard_len,
        received_data_mask,
        received_data,
        received_recovery_mask,
        recovery,
    ) {
        return 0;
    }
    // Output slots for missing indices must be at least `shard_len` long.
    let mut bits = missing_mask;
    while bits != 0 {
        let i = bits.trailing_zeros() as usize;
        if output[i].len() < shard_len {
            return 0;
        }
        bits &= bits - 1;
    }

    // Enumerate the q = missing_count recovery shards we will actually use,
    // in ascending j order. Cauchy submatrices are invertible regardless of
    // which rows/cols we pick, so the lowest q is fine.
    let mut used_recovery: [usize; FEC_MAX_RECOVERY] = [0; FEC_MAX_RECOVERY];
    {
        let mut bits = received_recovery_mask;
        let mut n = 0;
        while bits != 0 && n < missing_count {
            used_recovery[n] = bits.trailing_zeros() as usize;
            n += 1;
            bits &= bits - 1;
        }
    }
    let mut missing: [usize; FEC_MAX_DATA] = [0; FEC_MAX_DATA];
    {
        let mut bits = missing_mask;
        let mut n = 0;
        while bits != 0 {
            missing[n] = bits.trailing_zeros() as usize;
            n += 1;
            bits &= bits - 1;
        }
    }

    // Solve A · x = r with A[a][b] = PARITY[used_recovery[a]][missing[b]] and
    // r[a] = recovery[used_recovery[a]] ⊕ ⊕_{i received} PARITY[used_recovery[a]][i] · data[i].
    // With M = A⁻¹, every missing shard is one linear combination of the used
    // recovery shards and the received data shards:
    //   x[b] = ⊕_a M[b][a] · recovery[used_recovery[a]]
    //        ⊕ ⊕_{i received} (⊕_a M[b][a] · PARITY[used_recovery[a]][i]) · data[i].
    // That is `missing_count` recovery sources plus `k - missing_count` data
    // sources, never more than `FEC_MAX_DATA`, so one fused pass writes each
    // rebuilt byte once with no residual scratch.
    let mut inverse = [[0u8; FEC_MAX_RECOVERY]; FEC_MAX_RECOVERY];
    if missing_count == 1 {
        inverse[0][0] = field::inv(PARITY[used_recovery[0]][missing[0]]);
    } else {
        let a = PARITY[used_recovery[0]][missing[0]];
        let b = PARITY[used_recovery[0]][missing[1]];
        let c = PARITY[used_recovery[1]][missing[0]];
        let d = PARITY[used_recovery[1]][missing[1]];
        // Determinant a·d ⊕ b·c. Cauchy guarantees this is non-zero.
        let det = field::mul(a, d) ^ field::mul(b, c);
        if det == 0 {
            return 0;
        }
        let det_inv = field::inv(det);
        // Inverse of [[a, b], [c, d]] is (1/det) · [[d, b], [c, a]] in characteristic-2.
        inverse = [
            [field::mul(det_inv, d), field::mul(det_inv, b)],
            [field::mul(det_inv, c), field::mul(det_inv, a)],
        ];
    }

    let mut sources: [&[u8]; FEC_MAX_DATA] = [&[]; FEC_MAX_DATA];
    let mut tables = [[([0u8; 16], [0u8; 16]); FEC_MAX_DATA]; FEC_MAX_RECOVERY];
    let mut source_count = 0;
    for a in 0..missing_count {
        sources[source_count] = &recovery[used_recovery[a]][..shard_len];
        for b in 0..missing_count {
            tables[b][source_count] = field::nibble_tables(inverse[b][a]);
        }
        source_count += 1;
    }
    let mut bits = received_data_mask;
    while bits != 0 {
        let i = bits.trailing_zeros() as usize;
        sources[source_count] = &received_data[i][..shard_len];
        for b in 0..missing_count {
            let mut coefficient = 0u8;
            for a in 0..missing_count {
                coefficient ^= field::mul(inverse[b][a], PARITY[used_recovery[a]][i]);
            }
            tables[b][source_count] = field::nibble_tables(coefficient);
        }
        source_count += 1;
        bits &= bits - 1;
    }

    if missing_count == 1 {
        let mut targets = [&mut output[missing[0]][..shard_len]];
        combine(
            &sources[..source_count],
            &tables[..1],
            &mut targets,
            shard_len,
        );
        return 1u32 << missing[0];
    }
    let (head, tail) = output.split_at_mut(missing[1]);
    let mut targets = [&mut head[missing[0]][..shard_len], &mut tail[0][..shard_len]];
    combine(&sources[..source_count], &tables, &mut targets, shard_len);
    (1u32 << missing[0]) | (1u32 << missing[1])
}

fn find_shard_len(
    received_data_mask: u32,
    received_data: &[&[u8]],
    received_recovery_mask: u32,
    recovery: &[&[u8]],
) -> Option<usize> {
    if received_data_mask != 0 {
        let i = received_data_mask.trailing_zeros() as usize;
        return Some(received_data[i].len());
    }
    if received_recovery_mask != 0 {
        let j = received_recovery_mask.trailing_zeros() as usize;
        return Some(recovery[j].len());
    }
    None
}

fn validate_lens(
    shard_len: usize,
    received_data_mask: u32,
    received_data: &[&[u8]],
    received_recovery_mask: u32,
    recovery: &[&[u8]],
) -> bool {
    let mut bits = received_data_mask;
    while bits != 0 {
        let i = bits.trailing_zeros() as usize;
        if received_data[i].len() != shard_len {
            return false;
        }
        bits &= bits - 1;
    }
    let mut bits = received_recovery_mask;
    while bits != 0 {
        let j = bits.trailing_zeros() as usize;
        if recovery[j].len() != shard_len {
            return false;
        }
        bits &= bits - 1;
    }
    true
}
