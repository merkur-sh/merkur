//! The adaptive coder. Every coded value is a 16-ary symbol in a context whose
//! CDF adapts as it codes; a byte is its high nibble in the context's high
//! table, then its low nibble in the low table that high nibble names. Each
//! frame's tables start from the prior the frame names and adapt only within
//! the frame, so nothing the coder learns has to be kept in step between the
//! ends.
//!
//! The encoder runs the model forward, recording each symbol's range, then
//! codes the ranges into rANS in reverse; the decoder runs the model forward
//! with the stream.

use super::model::{KEYS, Prior};

/// Probability precision of every table.
pub(super) const PROB_BITS: u32 = 15;
pub(super) const PROB_SCALE: u32 = 1 << PROB_BITS;
/// The lower bound of a normalized rANS state.
pub(super) const RANS_L: u32 = 1 << 23;

/// A 16-symbol adaptive CDF: `c[s]` is the cumulative frequency below symbol
/// `s`, `c[0]` is zero, and the total `PROB_SCALE` is implicit. Every symbol
/// keeps a frequency of at least 1: the update moves each lane toward a target
/// whose gaps are at least 1, with a flooring shift, which never closes a gap
/// below the smaller of its own and the target's.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(C, align(16))]
pub struct Cdf {
    c: [i16; 16],
}

/// The update target of lanes above the coded symbol: `PROB_SCALE - 16 + lane`,
/// which is `i16::MAX - 15 + lane`.
const HIGH_TARGET: i16 = i16::MAX - 15;
const _: () = assert!(HIGH_TARGET as u32 == PROB_SCALE - 16);

impl Cdf {
    /// The CDF of `freqs`, which sum to `PROB_SCALE`, each at least 1.
    pub(super) fn from_freqs(freqs: &[u16; 16]) -> Self {
        let mut c = [0i16; 16];
        let mut cum = 0i16;
        // The first fifteen sum to at most `PROB_SCALE - 1`, which an `i16`
        // holds; the sixteenth's end is the implicit `PROB_SCALE`.
        for (lane, &freq) in c.iter_mut().skip(1).zip(freqs) {
            cum = cum.saturating_add_unsigned(freq);
            *lane = cum;
        }
        Self { c }
    }

    /// The frequency of each symbol.
    pub(super) fn freqs(&self) -> [u16; 16] {
        core::array::from_fn(|s| u16::try_from(self.start_freq(s).1).unwrap_or(u16::MAX))
    }

    /// Symbol `s`'s cumulative start and frequency. The top symbol's end wraps
    /// through `c[0]`, which is zero, to `PROB_SCALE`.
    #[inline(always)]
    #[expect(clippy::indexing_slicing, reason = "both lanes are masked below the CDF's 16")]
    pub(super) fn start_freq(&self, s: usize) -> (u32, u32) {
        let start = u32::from(self.c[s & 15].cast_unsigned());
        let end = u32::from(self.c[(s + 1) & 15].cast_unsigned());
        (start, end.wrapping_sub(start) & (PROB_SCALE - 1))
    }

    /// The symbol whose range holds `slot`: one less than how many lanes are
    /// at most `slot` (lane 0 always is).
    #[inline(always)]
    pub(super) fn find(&self, slot: u32) -> usize {
        // A slot is below `PROB_SCALE`, so it is an `i16`.
        let slot = i16::try_from(slot).unwrap_or(i16::MAX);
        #[cfg(any(target_arch = "wasm32", target_arch = "aarch64", target_arch = "x86_64"))]
        // SAFETY: the vector extension `simd` names is enabled for the whole
        // build: SIMD128 by the WASM build's flags, NEON and SSE2 by their
        // targets' baselines.
        let symbol = unsafe { simd::find(&self.c, slot) };
        #[cfg(not(any(target_arch = "wasm32", target_arch = "aarch64", target_arch = "x86_64")))]
        let symbol = self.c.iter().map(|&lane| usize::from(lane <= slot)).sum::<usize>() - 1;
        symbol
    }

    /// Move the CDF toward symbol `s` by `1 >> rate` of the distance.
    #[inline(always)]
    pub(super) fn update(&mut self, s: usize, rate: u32) {
        // A symbol is below 16 and a rate below 16.
        let (s, rate) = (i16::try_from(s).unwrap_or(15), i16::try_from(rate).unwrap_or(15));
        #[cfg(any(target_arch = "wasm32", target_arch = "aarch64", target_arch = "x86_64"))]
        // SAFETY: as in `find`.
        unsafe {
            simd::update(&mut self.c, s, rate);
        }
        #[cfg(not(any(target_arch = "wasm32", target_arch = "aarch64", target_arch = "x86_64")))]
        update_lanes(&mut self.c, s, rate);
    }

    /// The portable statement of `update`, which every vector arm must equal.
    #[cfg(test)]
    fn update_scalar(&mut self, s: usize, rate: u32) {
        update_lanes(&mut self.c, i16::try_from(s).unwrap_or(15), i16::try_from(rate).unwrap_or(15));
    }

    /// The portable statement of `find`.
    #[cfg(test)]
    fn find_scalar(&self, slot: u32) -> usize {
        let slot = i16::try_from(slot).unwrap_or(i16::MAX);
        self.c.iter().map(|&lane| usize::from(lane <= slot)).sum::<usize>() - 1
    }
}

/// Every lane toward its target: `lane` at or below `s`, `HIGH_TARGET +
/// lane` above it, by a flooring shift of `rate`.
#[cfg(any(test, not(any(target_arch = "wasm32", target_arch = "aarch64", target_arch = "x86_64"))))]
fn update_lanes(c: &mut [i16; 16], s: i16, rate: i16) {
    for (lane, c) in (0i16..).zip(c.iter_mut()) {
        let target = if lane <= s { i32::from(lane) } else { i32::from(HIGH_TARGET) + i32::from(lane) };
        let value = i32::from(*c);
        // Lanes stay within `0..PROB_SCALE`, so the result is an `i16`.
        *c = i16::try_from(value + ((target - value) >> rate)).unwrap_or(i16::MAX);
    }
}

/// The CDF's two vector operations, in the extension each target builds with.
#[cfg(target_arch = "aarch64")]
mod simd {
    use super::HIGH_TARGET;
    use core::arch::aarch64::{
        int16x8_t, vaddq_s16, vaddq_u16, vaddvq_u16, vandq_s16, vcgtq_s16, vcleq_s16, vdupq_n_s16, vld1q_s16,
        vreinterpretq_s16_u16, vshlq_s16, vshrq_n_u16, vst1q_s16, vsubq_s16,
    };

    const INDEX: [i16; 16] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

    #[inline]
    #[target_feature(enable = "neon")]
    fn load(lanes: &[i16]) -> int16x8_t {
        debug_assert!(lanes.len() >= 8);
        // SAFETY: every caller passes a half of a 16-lane array: eight lanes.
        unsafe { vld1q_s16(lanes.as_ptr()) }
    }

    #[inline]
    #[target_feature(enable = "neon")]
    pub(super) fn find(c: &[i16; 16], slot: i16) -> usize {
        let (low, high) = c.split_at(8);
        let slot = vdupq_n_s16(slot);
        let low = vshrq_n_u16::<15>(vcleq_s16(load(low), slot));
        let high = vshrq_n_u16::<15>(vcleq_s16(load(high), slot));
        usize::from(vaddvq_u16(vaddq_u16(low, high))) - 1
    }

    #[inline]
    #[target_feature(enable = "neon")]
    pub(super) fn update(c: &mut [i16; 16], s: i16, rate: i16) {
        let s = vdupq_n_s16(s);
        let high = vdupq_n_s16(HIGH_TARGET);
        let shift = vdupq_n_s16(-rate);
        let (index_low, index_high) = INDEX.split_at(8);
        let (low, high_half) = c.split_at_mut(8);
        for (lanes, index) in [(low, index_low), (high_half, index_high)] {
            let index = load(index);
            let value = load(lanes);
            let above = vreinterpretq_s16_u16(vcgtq_s16(index, s));
            let target = vaddq_s16(index, vandq_s16(above, high));
            let next = vaddq_s16(value, vshlq_s16(vsubq_s16(target, value), shift));
            // SAFETY: `lanes` is a half of the 16-lane array: eight lanes.
            unsafe { vst1q_s16(lanes.as_mut_ptr(), next) };
        }
    }
}

#[cfg(target_arch = "x86_64")]
mod simd {
    use super::HIGH_TARGET;
    use core::arch::x86_64::{
        __m128i, _mm_add_epi16, _mm_and_si128, _mm_cmpgt_epi16, _mm_cvtsi32_si128, _mm_loadu_si128,
        _mm_movemask_epi8, _mm_set1_epi16, _mm_setr_epi16, _mm_sra_epi16, _mm_storeu_si128, _mm_sub_epi16,
    };

    #[inline]
    #[target_feature(enable = "sse2")]
    fn load(lanes: &[i16]) -> __m128i {
        debug_assert!(lanes.len() >= 8);
        // SAFETY: every caller passes a half of a 16-lane array: eight lanes.
        unsafe { _mm_loadu_si128(lanes.as_ptr().cast()) }
    }

    #[inline]
    #[target_feature(enable = "sse2")]
    pub(super) fn find(c: &[i16; 16], slot: i16) -> usize {
        let (low, high) = c.split_at(8);
        let slot = _mm_set1_epi16(slot);
        // Lanes above the slot, two mask bits each; the rest are at most it.
        let above = _mm_movemask_epi8(_mm_cmpgt_epi16(load(low), slot)).count_ones()
            + _mm_movemask_epi8(_mm_cmpgt_epi16(load(high), slot)).count_ones();
        15 - usize::try_from(above / 2).unwrap_or(15)
    }

    #[inline]
    #[target_feature(enable = "sse2")]
    pub(super) fn update(c: &mut [i16; 16], s: i16, rate: i16) {
        let s = _mm_set1_epi16(s);
        let high = _mm_set1_epi16(HIGH_TARGET);
        let shift = _mm_cvtsi32_si128(i32::from(rate));
        let (low, high_half) = c.split_at_mut(8);
        for (lanes, index) in [
            (low, _mm_setr_epi16(0, 1, 2, 3, 4, 5, 6, 7)),
            (high_half, _mm_setr_epi16(8, 9, 10, 11, 12, 13, 14, 15)),
        ] {
            let value = load(lanes);
            let target = _mm_add_epi16(index, _mm_and_si128(_mm_cmpgt_epi16(index, s), high));
            let next = _mm_add_epi16(value, _mm_sra_epi16(_mm_sub_epi16(target, value), shift));
            // SAFETY: `lanes` is a half of the 16-lane array: eight lanes.
            unsafe { _mm_storeu_si128(lanes.as_mut_ptr().cast(), next) };
        }
    }
}

#[cfg(target_arch = "wasm32")]
mod simd {
    use super::HIGH_TARGET;
    use core::arch::wasm32::{
        i16x8, i16x8_add, i16x8_bitmask, i16x8_gt, i16x8_le, i16x8_shr, i16x8_splat, i16x8_sub, v128, v128_and,
        v128_load, v128_store,
    };

    #[inline]
    #[target_feature(enable = "simd128")]
    fn load(lanes: &[i16]) -> v128 {
        debug_assert!(lanes.len() >= 8);
        // SAFETY: every caller passes a half of a 16-lane array: eight lanes,
        // and `v128_load` takes any alignment.
        unsafe { v128_load(lanes.as_ptr().cast()) }
    }

    #[inline]
    #[target_feature(enable = "simd128")]
    pub(super) fn find(c: &[i16; 16], slot: i16) -> usize {
        let (low, high) = c.split_at(8);
        let slot = i16x8_splat(slot);
        let low = i16x8_bitmask(i16x8_le(load(low), slot));
        let high = i16x8_bitmask(i16x8_le(load(high), slot));
        usize::try_from((u32::from(low) | u32::from(high) << 8).count_ones()).unwrap_or(16) - 1
    }

    #[inline]
    #[target_feature(enable = "simd128")]
    pub(super) fn update(c: &mut [i16; 16], s: i16, rate: i16) {
        let s = i16x8_splat(s);
        let high = i16x8_splat(HIGH_TARGET);
        let rate = rate.cast_unsigned().into();
        let (low, high_half) = c.split_at_mut(8);
        for (lanes, index) in [
            (low, i16x8(0, 1, 2, 3, 4, 5, 6, 7)),
            (high_half, i16x8(8, 9, 10, 11, 12, 13, 14, 15)),
        ] {
            let value = load(lanes);
            let target = i16x8_add(index, v128_and(i16x8_gt(index, s), high));
            let next = i16x8_add(value, i16x8_shr(i16x8_sub(target, value), rate));
            // SAFETY: `lanes` is a half of the 16-lane array: eight lanes, and
            // `v128_store` takes any alignment.
            unsafe { v128_store(lanes.as_mut_ptr().cast(), next) };
        }
    }
}

/// `log2(1 + m / 128)` in 1/256 bit, for each 7-bit mantissa `m`.
#[expect(
    clippy::indexing_slicing,
    clippy::cast_possible_truncation,
    reason = "a compile-time table: `m` walks its 128 entries and each is below 256"
)]
static LOG2_MANTISSA: [u16; 128] = {
    let mut table = [0u16; 128];
    // Integer series for log2(1 + x): built once at compile time from
    // repeated squaring, exact to the table's 1/256-bit resolution.
    let mut m = 0;
    while m < 128 {
        // x in Q16: 1 + m/128.
        let mut x: u64 = 65_536 + (m as u64) * 512;
        let mut result: u64 = 0;
        let mut bit = 128u64;
        while bit > 0 {
            x = (x * x) >> 16;
            if x >= 131_072 {
                x >>= 1;
                result += bit;
            }
            bit >>= 1;
        }
        table[m] = result as u16;
        m += 1;
    }
    table
};

/// What coding `freq` of `PROB_SCALE` costs, in 1/256 bit: the encoder's
/// price for a choice, never a coded value.
#[inline]
pub(super) fn cost(freq: u32) -> u32 {
    // CDF frequencies are bounded by the probability precision. Include the
    // full-scale endpoint as well as every adaptive CDF gap.
    // SAFETY: a CDF gap is at most PROB_SCALE, including the full-scale
    // endpoint tested below. Recorded ranges retain the same gap.
    u32::from(unsafe { *SYMBOL_PRICES.get_unchecked(freq as usize) })
}

/// Exact integer symbol prices for every representable CDF frequency.
static SYMBOL_PRICES: [u16; PROB_SCALE as usize + 1] = {
    let mut prices = [0; PROB_SCALE as usize + 1];
    let mut frequency = 0usize;
    while frequency < prices.len() {
        let freq = if frequency == 0 { 1 } else { frequency as u32 };
        let log = 31 - freq.leading_zeros();
        let mantissa = ((freq << (31 - log)) >> 24) & 0x7f;
        prices[frequency] =
            ((PROB_BITS - log) * 256 - LOG2_MANTISSA[mantissa as usize] as u32) as u16;
        frequency += 1;
    }
    prices
};

/// The lookup preserves the integer price definition at every frequency.
#[test]
fn symbol_price_lookup_matches_the_integer_definition_for_every_frequency() {
    for freq in 0..=PROB_SCALE {
        let log = 31 - freq.max(1).leading_zeros();
        let mantissa = ((freq << (31 - log)) >> 24) & 0x7f;
        assert_eq!(
            cost(freq),
            (PROB_BITS - log) * 256 - u32::from(LOG2_MANTISSA[mantissa as usize])
        );
    }
}

/// One key's working tables within a frame.
#[derive(Clone, Copy)]
struct Work {
    hi: Cdf,
    /// The index in `Tables::lo` of each high nibble's low table.
    lo_at: [u16; 16],
    lo_ready: u16,
    rate: u8,
    key: u32,
}

/// A frame's working tables, copied from the prior on first use and reused
/// across frames, so a frame allocates nothing once warm.
pub(super) struct Tables {
    /// Per key: `generation << 16 | index into work`.
    slot: Box<[u32]>,
    work: Vec<Work>,
    lo: Vec<Cdf>,
    generation: u32,
}

impl Default for Tables {
    fn default() -> Self {
        Self {
            slot: vec![0; KEYS].into_boxed_slice(),
            work: Vec::new(),
            lo: Vec::new(),
            generation: 0,
        }
    }
}

#[expect(
    clippy::indexing_slicing,
    clippy::cast_possible_truncation,
    reason = "`at` is a position `work` returned and `lo_at` holds positions `lo` \
              returned; a frame's tables number at most its coded symbols, far below \
              2^16, so a slot's index and a low table's position fit 16 bits"
)]
impl Tables {
    /// Start a frame: every key's tables come from the prior again.
    pub(super) fn begin(&mut self) {
        self.generation = (self.generation + 1) & 0xffff;
        if self.generation == 0 {
            self.slot.fill(0);
            self.generation = 1;
        }
        self.work.clear();
        self.lo.clear();
    }

    #[inline(always)]
    fn work(&mut self, prior: &impl Prior, key: u32) -> usize {
        // SAFETY: every key is `key(field, aux)` with a field below `FIELDS`
        // and `aux` masked, so it indexes the `KEYS` slots.
        let slot = unsafe { self.slot.get_unchecked_mut(key as usize) };
        if *slot >> 16 == self.generation {
            return (*slot & 0xffff) as usize;
        }
        let at = self.work.len();
        *slot = self.generation << 16 | at as u32;
        self.work.push(Work {
            hi: *prior.hi(key),
            lo_at: [0; 16],
            lo_ready: 0,
            rate: prior.rate(key),
            key,
        });
        at
    }

    #[inline(always)]
    fn lo(&mut self, prior: &impl Prior, at: usize, h: usize) -> usize {
        let work = &mut self.work[at];
        if work.lo_ready & 1 << h == 0 {
            work.lo_ready |= 1 << h;
            work.lo_at[h] = self.lo.len() as u16;
            self.lo.push(*prior.lo(work.key, h));
        }
        usize::from(work.lo_at[h])
    }
}

/// The encoder's forward pass: the model as the decoder will run it, with
/// each symbol's range recorded for the reverse rANS pass.
pub(super) struct Coder<'p, P: Prior> {
    pub(super) prior: &'p P,
    pub(super) tables: &'p mut Tables,
    /// `start | freq << 16` of every coded symbol, in order.
    pub(super) coded: &'p mut Vec<u32>,
    /// What the coded symbols cost, in 1/256 bit.
    pub(super) bits: u64,
}

#[expect(
    clippy::indexing_slicing,
    reason = "every `at` is a position `Tables::work` returned and every `lo` one \
              `Tables::lo` returned"
)]
impl<P: Prior> Coder<'_, P> {
    #[inline(always)]
    fn range(cdf: &mut Cdf, s: usize, rate: u32, bits: &mut u64) -> u32 {
        let (start, freq) = cdf.start_freq(s);
        if P::PRICE_ENCODE {
            *bits += u64::from(cost(freq));
        }
        cdf.update(s, rate);
        start | freq << 16
    }

    /// Code `v` (below 16) in `key`'s high table.
    #[inline]
    pub(super) fn nibble(&mut self, key: u32, v: u8) {
        let at = self.tables.work(self.prior, key);
        let work = &mut self.tables.work[at];
        let rate = u32::from(work.rate);
        let range = Self::range(&mut work.hi, usize::from(v & 15), rate, &mut self.bits);
        self.coded.push(range);
    }

    /// Code byte `v` in `key`'s tables.
    #[inline]
    pub(super) fn byte(&mut self, key: u32, v: u8) {
        let (h, l) = (usize::from(v >> 4), usize::from(v & 15));
        let at = self.tables.work(self.prior, key);
        let rate = u32::from(self.tables.work[at].rate);
        let high = Self::range(&mut self.tables.work[at].hi, h, rate, &mut self.bits);
        let lo = self.tables.lo(self.prior, at, h);
        let low = Self::range(&mut self.tables.lo[lo], l, rate, &mut self.bits);
        // One reservation and contiguous write for the byte's two ranges.
        self.coded.extend_from_slice(&[high, low]);
    }

    /// What coding `v` in `key`'s high table would cost now, without coding it.
    #[inline]
    pub(super) fn nibble_cost(&mut self, key: u32, v: u8) -> u32 {
        let at = self.tables.work(self.prior, key);
        cost(self.tables.work[at].hi.start_freq(usize::from(v & 15)).1)
    }

    /// What coding byte `v` in `key`'s tables would cost now.
    #[inline]
    pub(super) fn byte_cost(&mut self, key: u32, v: u8) -> u32 {
        let h = usize::from(v >> 4);
        let at = self.tables.work(self.prior, key);
        let high = cost(self.tables.work[at].hi.start_freq(h).1);
        let lo = self.tables.lo(self.prior, at, h);
        high + cost(self.tables.lo[lo].start_freq(usize::from(v & 15)).1)
    }
}

/// What `trace`, a frame's coded symbols, costs from `prior`'s tables, in
/// 1/256 bit: the frame's forward model pass without its rANS.
#[expect(
    clippy::indexing_slicing,
    reason = "every `at` is a position `Tables::work` returned and every `lo` one \
              `Tables::lo` returned"
)]
pub(super) fn price(prior: &impl Prior, tables: &mut Tables, trace: &[u32]) -> u64 {
    tables.begin();
    let mut bits = 0u64;
    for &entry in trace {
        let key = entry >> 9;
        let (low, h, s) = (entry >> 8 & 1 == 1, (entry >> 4 & 15) as usize, (entry & 15) as usize);
        let at = tables.work(prior, key);
        let rate = u32::from(tables.work[at].rate);
        let cdf = if low {
            let lo = tables.lo(prior, at, h);
            &mut tables.lo[lo]
        } else {
            &mut tables.work[at].hi
        };
        bits += u64::from(cost(cdf.start_freq(s).1));
        cdf.update(s, rate);
    }
    bits
}

/// Code the recorded ranges into rANS, `ways` interleaved states, appending
/// the final states (big-endian) and the renormalization bytes in the order
/// the decoder reads them.
pub(super) fn encode(coded: &[u32], ways: usize, scratch: &mut Vec<u8>, out: &mut Vec<u8>) {
    scratch.clear();
    let mut states = [RANS_L; 2];
    let way_mask = ways - 1;
    for (index, &range) in coded.iter().enumerate().rev() {
        let (start, freq) = (range & 0xffff, range >> 16);
        let [first, second] = &mut states;
        let state = if index & way_mask == 0 { first } else { second };
        let x_max = ((RANS_L >> PROB_BITS) << 8) * freq;
        while *state >= x_max {
            scratch.push(state.to_le_bytes()[0]);
            *state >>= 8;
        }
        *state = ((*state / freq) << PROB_BITS) + *state % freq + start;
    }
    for state in states.iter().take(ways) {
        out.extend_from_slice(&state.to_be_bytes());
    }
    out.extend(scratch.iter().rev());
}

/// The decoder: the same model, run forward with the stream.
pub(super) struct Decoder<'p, 'b, P: Prior> {
    pub(super) prior: &'p P,
    pub(super) tables: &'p mut Tables,
    states: [u32; 2],
    next: usize,
    way_mask: usize,
    ways: usize,
    buf: &'b [u8],
    at: usize,
}

#[expect(
    clippy::indexing_slicing,
    clippy::cast_possible_truncation,
    reason = "every `at` is a position `Tables::work` returned and every `lo` one \
              `Tables::lo` returned; a decoded symbol is below 16, so a nibble or a \
              byte of two fits its `u8`"
)]
impl<'p, 'b, P: Prior> Decoder<'p, 'b, P> {
    pub(super) fn new(prior: &'p P, tables: &'p mut Tables, buf: &'b [u8], ways: usize) -> Option<Self> {
        let state = |at: usize| {
            buf.get(at..at + 4)
                .and_then(|bytes| <[u8; 4]>::try_from(bytes).ok())
                .map(u32::from_be_bytes)
        };
        let first = state(0)?;
        let second = if ways == 2 { state(4)? } else { RANS_L };
        // A state below the bound never came from the encoder.
        if first < RANS_L || second < RANS_L {
            return None;
        }
        tables.begin();
        Some(Self {
            prior,
            tables,
            states: [first, second],
            next: 0,
            way_mask: ways - 1,
            ways,
            buf,
            at: 4 * ways,
        })
    }

    #[inline(always)]
    fn step(&mut self, cdf_at: Option<usize>, hi_at: usize, rate: u32) -> usize {
        let way = self.next & self.way_mask;
        self.next += 1;
        let cdf = match cdf_at {
            Some(lo) => &mut self.tables.lo[lo],
            None => &mut self.tables.work[hi_at].hi,
        };
        let [first, second] = &mut self.states;
        let state = if way == 0 { first } else { second };
        let slot = *state & (PROB_SCALE - 1);
        let s = cdf.find(slot);
        let (start, freq) = cdf.start_freq(s);
        *state = freq * (*state >> PROB_BITS) + slot - start;
        // A state at or above `RANS_L` leaves at least `RANS_L >> PROB_BITS`,
        // so two bytes always renormalize it. Past the payload's end it reads
        // zeros, and `finish` refuses the frame.
        if *state < RANS_L {
            let byte = |at: usize| u32::from(self.buf.get(at).copied().unwrap_or(0));
            *state = (*state << 8) | byte(self.at);
            self.at += 1;
            if *state < RANS_L {
                *state = (*state << 8) | byte(self.at);
                self.at += 1;
            }
        }
        cdf.update(s, rate);
        s
    }

    /// Decode a value below 16 from `key`'s high table.
    #[inline]
    pub(super) fn nibble(&mut self, key: u32) -> u8 {
        let at = self.tables.work(self.prior, key);
        let rate = u32::from(self.tables.work[at].rate);
        self.step(None, at, rate) as u8
    }

    /// Decode a byte from `key`'s tables.
    #[inline]
    pub(super) fn byte(&mut self, key: u32) -> u8 {
        let at = self.tables.work(self.prior, key);
        let rate = u32::from(self.tables.work[at].rate);
        let h = self.step(None, at, rate);
        let lo = self.tables.lo(self.prior, at, h);
        let l = self.step(Some(lo), at, rate);
        (h << 4 | l) as u8
    }

    /// Whether the decode ended exactly where the encoder began.
    pub(super) fn finish(&self) -> bool {
        self.at == self.buf.len() && self.states.iter().take(self.ways).all(|&state| state == RANS_L)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vector_arms_equal_the_portable_statement() {
        let mut rng = 0x2545_f491_4f6c_dd1du64;
        let mut vector = Cdf::from_freqs(&[2048; 16]);
        let mut scalar = vector;
        for _ in 0..200_000 {
            rng ^= rng << 13;
            rng ^= rng >> 7;
            rng ^= rng << 17;
            let s = (rng % 16) as usize;
            let rate = 1 + (rng >> 32) as u32 % 7;
            let slot = (rng >> 40) as u32 % PROB_SCALE;
            assert_eq!(vector.find(slot), scalar.find_scalar(slot));
            vector.update(s, rate);
            scalar.update_scalar(s, rate);
            assert_eq!(vector, scalar);
        }
    }

    #[test]
    fn integer_cost_tracks_log2() {
        for freq in [1u32, 2, 3, 100, 1000, 16_384, 32_767] {
            let exact = -(f64::from(freq) / f64::from(PROB_SCALE)).log2() * 256.0;
            assert!((f64::from(cost(freq)) - exact).abs() <= 2.0, "{freq}: {} vs {exact}", cost(freq));
        }
    }

    #[test]
    fn updates_keep_every_symbol_codable() {
        let mut cdf = Cdf::from_freqs(&[2048; 16]);
        let mut rng = 0x9e37_79b9_7f4a_7c15u64;
        for step in 0..100_000 {
            rng ^= rng << 13;
            rng ^= rng >> 7;
            rng ^= rng << 17;
            // Long runs of one symbol drive the others to their floor.
            let s = if step % 1000 < 900 { 3 } else { (rng % 16) as usize };
            cdf.update(s, 1 + (rng >> 60) as u32 % 7);
            let freqs = cdf.freqs();
            assert!(freqs.iter().all(|&f| f >= 1), "{freqs:?}");
            assert_eq!(freqs.iter().map(|&f| u32::from(f)).sum::<u32>(), PROB_SCALE);
        }
    }

    #[test]
    fn find_names_the_symbol_whose_range_holds_the_slot() {
        let mut freqs = [1u16; 16];
        freqs[0] = u16::try_from(PROB_SCALE - 15).expect("a frequency");
        for cdf in [Cdf::from_freqs(&[2048; 16]), Cdf::from_freqs(&freqs)] {
            for slot in (0..PROB_SCALE).step_by(7).chain([PROB_SCALE - 1]) {
                let s = cdf.find(slot);
                let (start, freq) = cdf.start_freq(s);
                assert!(start <= slot && slot < start + freq, "slot {slot} symbol {s}");
            }
        }
    }
}
