//! The complete finite domain of recoverable shard masks, solved at compile time.

use crate::codec::{FEC_MAX_DATA, FEC_MAX_RECOVERY, PARITY};
use crate::field;
use crate::simd::NibbleTable;

/// Wire fact: one mask bit per data shard.
const DATA_MASKS: usize = 1 << FEC_MAX_DATA;
/// Wire fact: one mask bit per recovery shard.
const RECOVERY_MASKS: usize = 1 << FEC_MAX_RECOVERY;
/// Wire fact: each k has 2*k single-loss plans and k*(k-1)/2 double-loss plans.
const PLAN_COUNT: usize = FEC_MAX_DATA * (FEC_MAX_DATA + 1) * (FEC_MAX_DATA + 5) / 6;
const _: () = assert!(FEC_MAX_DATA == 4 && FEC_MAX_RECOVERY == 2);

#[derive(Clone, Copy)]
pub(crate) struct DecodePlan {
    pub(crate) tables: [[NibbleTable; FEC_MAX_DATA]; FEC_MAX_RECOVERY],
    /// Indices below FEC_MAX_DATA name data; remaining indices name recovery shards.
    pub(crate) sources: [usize; FEC_MAX_DATA],
    pub(crate) missing: [usize; FEC_MAX_RECOVERY],
}

impl DecodePlan {
    const EMPTY: Self = Self {
        tables: [[([0; 16], [0; 16]); FEC_MAX_DATA]; FEC_MAX_RECOVERY],
        sources: [0; FEC_MAX_DATA],
        missing: [0; FEC_MAX_RECOVERY],
    };
}

struct Plans {
    indices: [[[u8; RECOVERY_MASKS]; DATA_MASKS]; FEC_MAX_DATA],
    plans: [DecodePlan; PLAN_COUNT],
}

static PLANS: Plans = build_plans();

/// Call only after validating k, nonempty missing mask, and enough recovery shards.
pub(crate) fn get(k: usize, missing_mask: u32, recovery_mask: u32) -> Option<&'static DecodePlan> {
    let indices = PLANS
        .indices
        .get(k.checked_sub(1)?)?
        .get(missing_mask as usize)?;
    PLANS
        .plans
        .get(usize::from(*indices.get(recovery_mask as usize)?))
}

#[expect(
    clippy::indexing_slicing,
    reason = "evaluated only in static PLANS initialization; an invalid index rejects compilation"
)]
const fn build_plans() -> Plans {
    let mut result = Plans {
        indices: [[[0; RECOVERY_MASKS]; DATA_MASKS]; FEC_MAX_DATA],
        plans: [DecodePlan::EMPTY; PLAN_COUNT],
    };
    let mut count = 0u8;
    let mut k = 1;
    while k <= FEC_MAX_DATA {
        let mut missing = 1usize;
        while missing < 1 << k {
            let lost = missing.count_ones() as usize;
            let mut recovery = 1usize;
            while recovery < RECOVERY_MASKS {
                if lost <= FEC_MAX_RECOVERY && recovery.count_ones() as usize == lost {
                    result.indices[k - 1][missing][recovery] = count;
                    result.plans[count as usize] = solve(k, missing, recovery);
                    count += 1;
                }
                recovery += 1;
            }
            if lost == 1 {
                // With both repairs received, the decoder uses the lowest one.
                result.indices[k - 1][missing][3] = result.indices[k - 1][missing][1];
            }
            missing += 1;
        }
        k += 1;
    }
    assert!(count as usize == PLAN_COUNT);
    result
}

// For missing x and received data d, A*x = repair XOR B*d. Invert the
// one- or two-row Cauchy submatrix A, then expand A^-1 and A^-1*B for SIMD.
#[expect(
    clippy::indexing_slicing,
    reason = "evaluated only by build_plans at compile time; an invalid index rejects compilation"
)]
const fn solve(k: usize, missing_mask: usize, recovery_mask: usize) -> DecodePlan {
    let mut plan = DecodePlan::EMPTY;
    let count = missing_mask.count_ones() as usize;
    let mut bits = missing_mask;
    let mut b = 0;
    while bits != 0 {
        plan.missing[b] = bits.trailing_zeros() as usize;
        bits &= bits - 1;
        b += 1;
    }
    let mut used = [0; FEC_MAX_RECOVERY];
    bits = recovery_mask;
    let mut a = 0;
    while bits != 0 {
        used[a] = bits.trailing_zeros() as usize;
        plan.sources[a] = FEC_MAX_DATA + used[a];
        bits &= bits - 1;
        a += 1;
    }
    let mut inverse = [[0; FEC_MAX_RECOVERY]; FEC_MAX_RECOVERY];
    if count == 1 {
        inverse[0][0] = field::inv(PARITY[used[0]][plan.missing[0]]);
    } else {
        let a = PARITY[used[0]][plan.missing[0]];
        let b = PARITY[used[0]][plan.missing[1]];
        let c = PARITY[used[1]][plan.missing[0]];
        let d = PARITY[used[1]][plan.missing[1]];
        let det = field::mul(a, d) ^ field::mul(b, c);
        assert!(det != 0);
        let inv = field::inv(det);
        inverse = [
            [field::mul(inv, d), field::mul(inv, b)],
            [field::mul(inv, c), field::mul(inv, a)],
        ];
    }
    b = 0;
    while b < count {
        a = 0;
        while a < count {
            plan.tables[b][a] = field::nibble_tables(inverse[b][a]);
            a += 1;
        }
        b += 1;
    }
    let mut source = count;
    let mut i = 0;
    while i < k {
        if missing_mask & (1 << i) == 0 {
            plan.sources[source] = i;
            b = 0;
            while b < count {
                let mut coefficient = 0;
                a = 0;
                while a < count {
                    coefficient ^= field::mul(inverse[b][a], PARITY[used[a]][i]);
                    a += 1;
                }
                plan.tables[b][source] = field::nibble_tables(coefficient);
                b += 1;
            }
            source += 1;
        }
        i += 1;
    }
    assert!(source == k);
    plan
}
