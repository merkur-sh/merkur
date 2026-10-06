//! `combine`: fused GF(2^8) linear combinations over byte shards.
//!
//! `outputs[j][..len] = ⊕_i c[j][i] · sources[i]` for at most four sources and
//! two outputs. Each 16-byte chunk of every source is loaded once and
//! multiplied into every output in registers, and each output byte is stored
//! once: no clear, no read-modify-write pass per coefficient, no residual
//! scratch. A source shorter than `len` reads as zero past its end, which is
//! exactly the padding the sender applies, so callers never stage padded
//! copies. Encoding and every decode pattern are one call each.
//!
//! One lane per target, fixed at compile time, all using the nibble split
//! `b · c = low[b & 15] ⊕ high[b >> 4]`:
//! * AArch64 NEON: `vqtbl1q_u8`.
//! * x86_64 SSSE3: `_mm_shuffle_epi8`. The workspace `.cargo/config.toml`
//!   enables SSSE3 for every x86_64 target, and a build without it fails here
//!   rather than silently running a byte-at-a-time lane.
//! * WASM `simd128`: `i8x16.swizzle`.
//! * Portable: the same tables one byte at a time, for any other target.

pub(crate) const MAX_SOURCES: usize = 4;
pub(crate) const MAX_OUTPUTS: usize = 2;

/// `(low, high)` with `low[i] = i · c` and `high[i] = (i << 4) · c`, so
/// `b · c = low[b & 15] ⊕ high[b >> 4]`. See `field::nibble_tables`.
pub(crate) type NibbleTable = ([u8; 16], [u8; 16]);

const ZERO_TABLE: NibbleTable = ([0; 16], [0; 16]);

#[cfg(all(target_arch = "x86_64", not(target_feature = "ssse3")))]
compile_error!(
    "merkur-fec's x86_64 lane needs SSSE3; the workspace .cargo/config.toml enables it"
);

/// One target's 16-byte GF(2^8) lane operations.
trait Lane {
    type V: Copy;
    /// A coefficient's nibble tables in registers, loaded once per call.
    type Table: Copy;
    fn table(nibbles: &NibbleTable) -> Self::Table;
    /// # Safety
    /// `pointer` must be valid for 16 byte reads.
    unsafe fn load(pointer: *const u8) -> Self::V;
    /// # Safety
    /// `pointer` must be valid for 16 byte writes.
    unsafe fn store(pointer: *mut u8, value: Self::V);
    fn zero() -> Self::V;
    fn xor(a: Self::V, b: Self::V) -> Self::V;
    /// The low and high nibble of every byte, split once per source chunk and
    /// reused by every output's coefficient.
    fn split(value: Self::V) -> (Self::V, Self::V);
    fn product(table: &Self::Table, low: Self::V, high: Self::V) -> Self::V;
}

#[cfg(target_arch = "aarch64")]
struct Neon;

#[cfg(target_arch = "aarch64")]
impl Lane for Neon {
    type V = core::arch::aarch64::uint8x16_t;
    type Table = (Self::V, Self::V);

    #[inline(always)]
    fn table(nibbles: &NibbleTable) -> Self::Table {
        use core::arch::aarch64::vld1q_u8;
        // SAFETY: `nibbles.0` is a `[u8; 16]`, exactly the 16 initialized bytes
        // the load reads; NEON byte loads need no alignment.
        let low = unsafe { vld1q_u8(nibbles.0.as_ptr()) };
        // SAFETY: `nibbles.1` is a `[u8; 16]` as well, read the same way.
        let high = unsafe { vld1q_u8(nibbles.1.as_ptr()) };
        (low, high)
    }
    #[inline(always)]
    unsafe fn load(pointer: *const u8) -> Self::V {
        // SAFETY: the caller guarantees 16 readable bytes; NEON byte loads
        // need no alignment.
        unsafe { core::arch::aarch64::vld1q_u8(pointer) }
    }
    #[inline(always)]
    unsafe fn store(pointer: *mut u8, value: Self::V) {
        // SAFETY: the caller guarantees 16 writable bytes.
        unsafe { core::arch::aarch64::vst1q_u8(pointer, value) }
    }
    #[inline(always)]
    fn zero() -> Self::V {
        // SAFETY: NEON is mandatory on AArch64.
        unsafe { core::arch::aarch64::vdupq_n_u8(0) }
    }
    #[inline(always)]
    fn xor(a: Self::V, b: Self::V) -> Self::V {
        // SAFETY: NEON is mandatory on AArch64.
        unsafe { core::arch::aarch64::veorq_u8(a, b) }
    }
    #[inline(always)]
    fn split(value: Self::V) -> (Self::V, Self::V) {
        use core::arch::aarch64::{vandq_u8, vdupq_n_u8, vshrq_n_u8};
        // SAFETY: NEON is mandatory on AArch64; the splat reads no memory.
        let mask = unsafe { vdupq_n_u8(0x0f) };
        // SAFETY: NEON is mandatory on AArch64; a register-to-register AND.
        let low = unsafe { vandq_u8(value, mask) };
        // SAFETY: NEON is mandatory on AArch64; the shift count 4 is below the
        // 8-bit lane width the intrinsic requires.
        let high = unsafe { vshrq_n_u8::<4>(value) };
        (low, high)
    }
    #[inline(always)]
    fn product(table: &Self::Table, low: Self::V, high: Self::V) -> Self::V {
        use core::arch::aarch64::{veorq_u8, vqtbl1q_u8};
        // SAFETY: NEON is mandatory on AArch64. `low` is masked into 0..=15 by
        // `split`, so every index names one of the table's 16 bytes.
        let low = unsafe { vqtbl1q_u8(table.0, low) };
        // SAFETY: NEON is mandatory on AArch64. `high` is a byte shifted right
        // by four in `split`, so every index is in 0..=15.
        let high = unsafe { vqtbl1q_u8(table.1, high) };
        // SAFETY: NEON is mandatory on AArch64; a register-to-register XOR.
        unsafe { veorq_u8(low, high) }
    }
}

#[cfg(all(target_arch = "x86_64", target_feature = "ssse3"))]
struct Ssse3;

#[cfg(all(target_arch = "x86_64", target_feature = "ssse3"))]
impl Lane for Ssse3 {
    type V = core::arch::x86_64::__m128i;
    type Table = (Self::V, Self::V);

    #[inline(always)]
    fn table(nibbles: &NibbleTable) -> Self::Table {
        use core::arch::x86_64::_mm_loadu_si128;
        // SAFETY: `nibbles.0` is a `[u8; 16]`, exactly the 16 initialized bytes
        // the unaligned load reads.
        let low = unsafe { _mm_loadu_si128(nibbles.0.as_ptr().cast()) };
        // SAFETY: `nibbles.1` is a `[u8; 16]` as well, read the same way.
        let high = unsafe { _mm_loadu_si128(nibbles.1.as_ptr().cast()) };
        (low, high)
    }
    #[inline(always)]
    unsafe fn load(pointer: *const u8) -> Self::V {
        // SAFETY: the caller guarantees 16 readable bytes; unaligned load.
        unsafe { core::arch::x86_64::_mm_loadu_si128(pointer.cast()) }
    }
    #[inline(always)]
    unsafe fn store(pointer: *mut u8, value: Self::V) {
        // SAFETY: the caller guarantees 16 writable bytes; unaligned store.
        unsafe { core::arch::x86_64::_mm_storeu_si128(pointer.cast(), value) }
    }
    #[inline(always)]
    fn zero() -> Self::V {
        // SAFETY: SSE2 is baseline on x86_64.
        unsafe { core::arch::x86_64::_mm_setzero_si128() }
    }
    #[inline(always)]
    fn xor(a: Self::V, b: Self::V) -> Self::V {
        // SAFETY: SSE2 is baseline on x86_64.
        unsafe { core::arch::x86_64::_mm_xor_si128(a, b) }
    }
    #[inline(always)]
    fn split(value: Self::V) -> (Self::V, Self::V) {
        use core::arch::x86_64::{_mm_and_si128, _mm_set1_epi8, _mm_srli_epi16};
        // SAFETY: SSE2 is baseline on x86_64; the splat reads no memory.
        let mask = unsafe { _mm_set1_epi8(0x0f) };
        // SAFETY: SSE2 is baseline on x86_64; a register-to-register AND.
        let low = unsafe { _mm_and_si128(value, mask) };
        // There is no byte shift: shift 16-bit lanes and mask off the bits the
        // neighbouring byte shifted in.
        // SAFETY: SSE2 is baseline on x86_64; the shift count 4 is a constant
        // below the 16-bit lane width.
        let shifted = unsafe { _mm_srli_epi16::<4>(value) };
        // SAFETY: SSE2 is baseline on x86_64; a register-to-register AND.
        let high = unsafe { _mm_and_si128(shifted, mask) };
        (low, high)
    }
    #[inline(always)]
    fn product(table: &Self::Table, low: Self::V, high: Self::V) -> Self::V {
        use core::arch::x86_64::{_mm_shuffle_epi8, _mm_xor_si128};
        // SAFETY: this lane only compiles with SSSE3 enabled. `low` is masked
        // into 0..=15 by `split`, so no lane has its high bit set and the
        // shuffle is a plain 16-entry table lookup.
        let low = unsafe { _mm_shuffle_epi8(table.0, low) };
        // SAFETY: this lane only compiles with SSSE3 enabled. `high` is masked
        // into 0..=15 by `split` after its shift, so the shuffle is the same
        // plain table lookup.
        let high = unsafe { _mm_shuffle_epi8(table.1, high) };
        // SAFETY: SSE2 is baseline on x86_64; a register-to-register XOR.
        unsafe { _mm_xor_si128(low, high) }
    }
}

#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
struct Simd128;

#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
impl Lane for Simd128 {
    type V = core::arch::wasm32::v128;
    type Table = (Self::V, Self::V);

    #[inline(always)]
    fn table(nibbles: &NibbleTable) -> Self::Table {
        use core::arch::wasm32::v128_load;
        // SAFETY: `nibbles.0` is a `[u8; 16]`, exactly the 16 initialized bytes
        // the load reads; v128 loads need no alignment.
        let low = unsafe { v128_load(nibbles.0.as_ptr().cast()) };
        // SAFETY: `nibbles.1` is a `[u8; 16]` as well, read the same way.
        let high = unsafe { v128_load(nibbles.1.as_ptr().cast()) };
        (low, high)
    }
    #[inline(always)]
    unsafe fn load(pointer: *const u8) -> Self::V {
        // SAFETY: the caller guarantees 16 readable bytes.
        unsafe { core::arch::wasm32::v128_load(pointer.cast()) }
    }
    #[inline(always)]
    unsafe fn store(pointer: *mut u8, value: Self::V) {
        // SAFETY: the caller guarantees 16 writable bytes.
        unsafe { core::arch::wasm32::v128_store(pointer.cast(), value) }
    }
    #[inline(always)]
    fn zero() -> Self::V {
        core::arch::wasm32::u8x16_splat(0)
    }
    #[inline(always)]
    fn xor(a: Self::V, b: Self::V) -> Self::V {
        core::arch::wasm32::v128_xor(a, b)
    }
    #[inline(always)]
    fn split(value: Self::V) -> (Self::V, Self::V) {
        use core::arch::wasm32::{u8x16_shr, u8x16_splat, v128_and};
        (v128_and(value, u8x16_splat(0x0f)), u8x16_shr(value, 4))
    }
    #[inline(always)]
    fn product(table: &Self::Table, low: Self::V, high: Self::V) -> Self::V {
        use core::arch::wasm32::{i8x16_swizzle, v128_xor};
        // Indices are masked or shifted into 0..=15.
        v128_xor(i8x16_swizzle(table.0, low), i8x16_swizzle(table.1, high))
    }
}

/// The nibble tables one byte at a time. The lane of any target without a
/// vector lane above, and checked against the vector lanes in tests.
#[cfg(any(
    test,
    not(any(
        target_arch = "aarch64",
        target_arch = "x86_64",
        all(target_arch = "wasm32", target_feature = "simd128")
    ))
))]
struct Portable;

#[cfg(any(
    test,
    not(any(
        target_arch = "aarch64",
        target_arch = "x86_64",
        all(target_arch = "wasm32", target_feature = "simd128")
    ))
))]
impl Lane for Portable {
    type V = [u8; 16];
    type Table = NibbleTable;

    #[inline(always)]
    fn table(nibbles: &NibbleTable) -> Self::Table {
        *nibbles
    }
    #[inline(always)]
    unsafe fn load(pointer: *const u8) -> Self::V {
        // SAFETY: the caller guarantees 16 readable bytes.
        unsafe { pointer.cast::<[u8; 16]>().read_unaligned() }
    }
    #[inline(always)]
    unsafe fn store(pointer: *mut u8, value: Self::V) {
        // SAFETY: the caller guarantees 16 writable bytes.
        unsafe { pointer.cast::<[u8; 16]>().write_unaligned(value) }
    }
    #[inline(always)]
    fn zero() -> Self::V {
        [0; 16]
    }
    #[inline(always)]
    fn xor(a: Self::V, b: Self::V) -> Self::V {
        core::array::from_fn(|index| a[index] ^ b[index])
    }
    #[inline(always)]
    fn split(value: Self::V) -> (Self::V, Self::V) {
        (value.map(|byte| byte & 15), value.map(|byte| byte >> 4))
    }
    #[inline(always)]
    fn product(table: &Self::Table, low: Self::V, high: Self::V) -> Self::V {
        core::array::from_fn(|index| {
            table.0[usize::from(low[index] & 15)] ^ table.1[usize::from(high[index] & 15)]
        })
    }
}

#[cfg(target_arch = "aarch64")]
type Target = Neon;
#[cfg(all(target_arch = "x86_64", target_feature = "ssse3"))]
type Target = Ssse3;
#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
type Target = Simd128;
#[cfg(not(any(
    target_arch = "aarch64",
    target_arch = "x86_64",
    all(target_arch = "wasm32", target_feature = "simd128")
)))]
type Target = Portable;

/// Write `outputs[j][..len] = ⊕_i c[j][i] · sources[i]`, where
/// `coefficients[j][i]` holds the nibble tables of `c[j][i]` and bytes past a
/// source's end read as zero.
///
/// Callers validate the shapes (at most `MAX_SOURCES` sources, one coefficient
/// row per output, at most `MAX_OUTPUTS` outputs, sources no longer than `len`
/// and outputs at least `len`); these are debug assertions. A violation that
/// reaches a release build panics on a slice bound or is ignored (an output
/// count outside 1..=2), never touches memory outside the slices.
pub(crate) fn combine(
    sources: &[&[u8]],
    coefficients: &[[NibbleTable; MAX_SOURCES]],
    outputs: &mut [&mut [u8]],
    len: usize,
) {
    combine_with::<Target>(sources, coefficients, outputs, len);
}

#[inline(always)]
#[expect(
    clippy::debug_assert_with_mut_call,
    reason = "the output-length check only reads; its `&mut [u8]` elements are what the lint sees"
)]
fn combine_with<L: Lane>(
    sources: &[&[u8]],
    coefficients: &[[NibbleTable; MAX_SOURCES]],
    outputs: &mut [&mut [u8]],
    len: usize,
) {
    debug_assert!(sources.len() <= MAX_SOURCES);
    debug_assert!(outputs.len() == coefficients.len() && outputs.len() <= MAX_OUTPUTS);
    debug_assert!(sources.iter().all(|source| source.len() <= len));
    debug_assert!(outputs.iter().all(|output| output.len() >= len));
    match outputs {
        [first] => combine_into::<L, 1>(sources, coefficients, [&mut first[..len]], len),
        [first, second] => combine_into::<L, 2>(
            sources,
            coefficients,
            [&mut first[..len], &mut second[..len]],
            len,
        ),
        _ => {}
    }
}

#[inline(always)]
fn combine_into<L: Lane, const M: usize>(
    sources: &[&[u8]],
    coefficients: &[[NibbleTable; MAX_SOURCES]],
    outputs: [&mut [u8]; M],
    len: usize,
) {
    let count = sources.len();
    // Longest first, so the sources still holding bytes at any offset are a
    // prefix and the shard splits into one segment per distinct length.
    let mut order = [0usize, 1, 2, 3];
    for next in 1..count {
        let mut at = next;
        while at > 0 && sources[order[at - 1]].len() < sources[order[at]].len() {
            order.swap(at - 1, at);
            at -= 1;
        }
    }
    let source: [&[u8]; MAX_SOURCES] = core::array::from_fn(|rank| {
        if rank < count {
            let bytes = sources[order[rank]];
            &bytes[..bytes.len().min(len)]
        } else {
            &[]
        }
    });
    let tables: [[L::Table; MAX_SOURCES]; M] = core::array::from_fn(|j| {
        core::array::from_fn(|rank| {
            L::table(if rank < count {
                &coefficients[j][order[rank]]
            } else {
                &ZERO_TABLE
            })
        })
    });
    // Every output is exactly `len` bytes; all writes below go through these.
    let output: [*mut u8; M] = outputs.map(|bytes| bytes.as_mut_ptr());

    let aligned = len & !15;
    let mut offset = 0;
    let mut active = count;
    while offset < aligned {
        while active > 0 && source[active - 1].len() <= offset {
            active -= 1;
        }
        if active == 0 {
            // No source reaches this far: the rest of every output is zero.
            for pointer in output {
                // SAFETY: `offset < len` and `pointer` is the start of an
                // output of exactly `len` bytes, so the result is inside it.
                let rest = unsafe { pointer.add(offset) };
                // SAFETY: `rest` is `offset` bytes into that `len`-byte output,
                // borrowed mutably for this call, so `len - offset` bytes from
                // it are writable.
                unsafe { core::ptr::write_bytes(rest, 0, len - offset) };
            }
            return;
        }
        // Every active source holds at least `end` bytes, and `end <= aligned`.
        let end = source[active - 1].len() & !15;
        if end > offset {
            match active {
                1 => full_chunks::<L, 1, M>(&source, &tables, &output, offset, end),
                2 => full_chunks::<L, 2, M>(&source, &tables, &output, offset, end),
                3 => full_chunks::<L, 3, M>(&source, &tables, &output, offset, end),
                _ => full_chunks::<L, 4, M>(&source, &tables, &output, offset, end),
            }
            offset = end;
        } else {
            // The shortest active source ends inside this chunk.
            let value = chunk::<L, M>(&source, active, &tables, offset);
            for (pointer, value) in output.iter().zip(value) {
                // SAFETY: the loop holds `offset < aligned <= len`, and each
                // output is `len` bytes, so the result is inside it.
                let chunk = unsafe { pointer.add(offset) };
                // SAFETY: `offset` and `aligned` are multiples of 16, so
                // `offset + 16 <= aligned <= len`: 16 writable bytes follow.
                unsafe { L::store(chunk, value) };
            }
            offset += 16;
        }
    }
    if offset == len {
        return;
    }
    if len >= 16 {
        // The ragged tail is the last 16 bytes, recomputed over every source
        // that reaches into them. Outputs are written, never accumulated, so
        // restoring the bytes the loop already stored is harmless, and the
        // whole tail is one vector store instead of a padded copy.
        let at = len - 16;
        let reaching = source.iter().take(count).filter(|bytes| bytes.len() > at).count();
        let value = chunk::<L, M>(&source, reaching, &tables, at);
        for (pointer, value) in output.iter().zip(value) {
            // SAFETY: `at = len - 16` with `len >= 16`, and each output is
            // `len` bytes, so the result is inside it.
            let tail = unsafe { pointer.add(at) };
            // SAFETY: `at + 16 == len`: exactly the output's last 16 bytes.
            unsafe { L::store(tail, value) };
        }
    } else {
        // A shard shorter than one vector: every source is padded.
        let value = chunk::<L, M>(&source, count, &tables, 0);
        for (pointer, value) in output.iter().zip(value) {
            let mut bytes = [0u8; 16];
            // SAFETY: `bytes` is 16 bytes.
            unsafe { L::store(bytes.as_mut_ptr(), value) };
            // SAFETY: each output holds `len < 16` bytes.
            unsafe { core::ptr::copy_nonoverlapping(bytes.as_ptr(), *pointer, len) };
        }
    }
}

/// Full 16-byte chunks over `[start, end)` from the first `N` sources, each
/// of which holds at least `end` bytes; `end` never exceeds the outputs.
#[inline(always)]
fn full_chunks<L: Lane, const N: usize, const M: usize>(
    source: &[&[u8]; MAX_SOURCES],
    tables: &[[L::Table; MAX_SOURCES]; M],
    output: &[*mut u8; M],
    start: usize,
    end: usize,
) {
    let base: [*const u8; N] = core::array::from_fn(|rank| source[rank].as_ptr());
    let mut offset = start;
    while offset < end {
        let mut accumulator = [L::zero(); M];
        for rank in 0..N {
            // SAFETY: `offset < end <= source[rank].len()`, the caller's
            // contract for the first `N` sources, so the result is inside
            // that source.
            let chunk = unsafe { base[rank].add(offset) };
            // SAFETY: `start` and `end` are multiples of 16, so
            // `offset + 16 <= end <= source[rank].len()`: 16 readable bytes.
            let (low, high) = L::split(unsafe { L::load(chunk) });
            for j in 0..M {
                accumulator[j] = L::xor(accumulator[j], L::product(&tables[j][rank], low, high));
            }
        }
        for j in 0..M {
            // SAFETY: `offset < end`, and `end` never exceeds an output, so
            // the result is inside output `j`.
            let chunk = unsafe { output[j].add(offset) };
            // SAFETY: `offset + 16 <= end`, which is within every output: 16
            // writable bytes.
            unsafe { L::store(chunk, accumulator[j]) };
        }
        offset += 16;
    }
}

/// The 16 bytes at `at` of every output, over the first `count` sources, each
/// of which holds at least `at` bytes and reads as zero past its end.
///
/// Out of line on purpose: it runs at most twice per call, and inlining its
/// padded path at all three sites made the WASM decode 5-20% slower under
/// JSC than this call costs.
#[inline(never)]
fn chunk<L: Lane, const M: usize>(
    source: &[&[u8]; MAX_SOURCES],
    count: usize,
    tables: &[[L::Table; MAX_SOURCES]; M],
    at: usize,
) -> [L::V; M] {
    let mut accumulator = [L::zero(); M];
    for rank in 0..count {
        let rest = &source[rank][at..];
        let value = if rest.len() >= 16 {
            // SAFETY: 16 bytes remain in this source.
            unsafe { L::load(rest.as_ptr()) }
        } else {
            let mut padded = [0u8; 16];
            padded[..rest.len()].copy_from_slice(rest);
            // SAFETY: `padded` is 16 bytes.
            unsafe { L::load(padded.as_ptr()) }
        };
        let (low, high) = L::split(value);
        for j in 0..M {
            accumulator[j] = L::xor(accumulator[j], L::product(&tables[j][rank], low, high));
        }
    }
    accumulator
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::field;
    use alloc::vec;
    use alloc::vec::Vec;

    /// `combine_with::<L>` against naive GF(2^8) arithmetic for every source
    /// and output count, shard lengths around every vector boundary, and
    /// sources that end inside the final chunk, inside an earlier one, or
    /// before the first vector.
    fn matches_naive<L: Lane>() {
        let mut rng_state: u64 = 0x_dead_beef_cafe_babe;
        let mut next = || {
            rng_state = rng_state
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (rng_state >> 33) as u8
        };
        for &len in &[
            0usize, 1, 7, 15, 16, 17, 31, 32, 33, 100, 542, 612, 1084, 1300,
        ] {
            for n in 0..=MAX_SOURCES {
                for m in 1..=MAX_OUTPUTS {
                    for trial in 0..48 {
                        let sources: Vec<Vec<u8>> = (0..n)
                            .map(|i| {
                                let short = match (trial + i) % 4 {
                                    0 => len,
                                    1 => len.saturating_sub(trial % 16 + 1),
                                    2 => (trial * 7) % 16 % (len + 1),
                                    _ => (trial * 37) % (len + 1),
                                };
                                (0..short).map(|_| next()).collect()
                            })
                            .collect();
                        let bytes: Vec<[u8; MAX_SOURCES]> = (0..m)
                            .map(|_| core::array::from_fn(|_| next()))
                            .collect();
                        let coefficients: Vec<[NibbleTable; MAX_SOURCES]> = bytes
                            .iter()
                            .map(|row| row.map(field::nibble_tables))
                            .collect();
                        let refs: Vec<&[u8]> = sources.iter().map(Vec::as_slice).collect();
                        let mut outputs: Vec<Vec<u8>> =
                            (0..m).map(|_| (0..len + 3).map(|_| next()).collect()).collect();
                        let tails: Vec<Vec<u8>> =
                            outputs.iter().map(|output| output[len..].to_vec()).collect();
                        {
                            let mut output_refs: Vec<&mut [u8]> =
                                outputs.iter_mut().map(Vec::as_mut_slice).collect();
                            combine_with::<L>(&refs, &coefficients, &mut output_refs, len);
                        }
                        for j in 0..m {
                            let mut expected = vec![0u8; len];
                            for (i, source) in sources.iter().enumerate() {
                                for (byte, value) in expected.iter_mut().zip(source) {
                                    *byte ^= field::mul(bytes[j][i], *value);
                                }
                            }
                            let lengths: Vec<usize> = sources.iter().map(Vec::len).collect();
                            assert_eq!(
                                &outputs[j][..len],
                                &expected[..],
                                "len={len} m={m} sources={lengths:?}"
                            );
                            assert_eq!(&outputs[j][len..], &tails[j][..], "wrote past len");
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn target_lane_matches_naive_for_every_shape_and_ragged_source() {
        matches_naive::<Target>();
    }

    #[test]
    fn portable_lane_matches_naive_for_every_shape_and_ragged_source() {
        matches_naive::<Portable>();
    }
}
