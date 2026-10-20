//! The static model: one frequency table per field, and context tables for the
//! (field, context) pairs that earn their bytes.

use std::sync::OnceLock;

/// Frequency precision of the field tables, and the most any context table
/// uses. Eleven bits is the most a packed decode slot can hold (below).
pub(super) const PROB_BITS: u32 = 11;
/// The escape symbol of a context table: the symbol is coded again with its
/// field's table.
pub(super) const ESC: usize = 256;
/// Bits of context per field. Every context a field takes fits twelve bits.
const AUX_BITS: u32 = 12;
/// Context values per field.
pub(super) const AUX: usize = 1 << AUX_BITS;

pub(super) const F_OP: u32 = 0;
pub(super) const F_ROW: u32 = 1;
pub(super) const F_LEFT: u32 = 2;
pub(super) const F_COUNT: u32 = 3;
pub(super) const F_MODE: u32 = 4;
pub(super) const F_LINK: u32 = 5;
pub(super) const F_TAG: u32 = 6;
pub(super) const F_CODEPOINT: u32 = 7;
pub(super) const F_FG: u32 = 8;
pub(super) const F_BG: u32 = 9;
pub(super) const F_RUN: u32 = 10;
/// A graphics row's section: its four length bytes, then its bytes.
pub(super) const F_GRAPHICS: u32 = 11;
pub(super) const F_SEQ: u32 = 12;
pub(super) const F_SOURCE: u32 = 13;
pub(super) const F_HASH: u32 = 14;
/// Whether a cell's colour repeats its slot's previous colour.
pub(super) const F_SAME_COLOR: u32 = 15;
pub(super) const FIELDS: usize = 16;

#[inline]
pub(super) const fn key(field: u32, aux: u32) -> u32 {
    field << AUX_BITS | (aux & ((1 << AUX_BITS) - 1))
}

#[inline]
pub(super) const fn field_of(key: u32) -> usize {
    (key >> AUX_BITS) as usize
}

/// Normalized frequencies of one table, as the model data stores them.
struct Frequencies {
    bits: u32,
    /// `(symbol, frequency)`, ascending by symbol, every frequency nonzero.
    symbols: Vec<(u16, u16)>,
}

/// Parse the model data. It is compiled in, so a malformed table is a build
/// defect and panics; `the_model_data_is_well_formed` runs this in the tests.
#[expect(
    clippy::indexing_slicing,
    clippy::expect_used,
    reason = "the model data is compiled in, and a malformed table is a build defect"
)]
fn parse(data: &[u8]) -> (Vec<Frequencies>, Vec<(u32, Frequencies)>) {
    let mut at = 0usize;
    let u16_at = |at: &mut usize| {
        let value = u16::from_le_bytes([data[*at], data[*at + 1]]);
        *at += 2;
        value
    };
    let mut fields = Vec::with_capacity(FIELDS);
    for _ in 0..FIELDS {
        let symbols = (0..256u16)
            .map(|symbol| (symbol, u16_at(&mut at)))
            .collect::<Vec<_>>();
        fields.push(Frequencies {
            bits: PROB_BITS,
            symbols,
        });
    }
    let count = u32::from_le_bytes(data[at..at + 4].try_into().expect("context count")) as usize;
    at += 4;
    let mut contexts = Vec::with_capacity(count);
    for _ in 0..count {
        let key = u32::from_le_bytes(data[at..at + 4].try_into().expect("context key"));
        let bits = u32::from(data[at + 4]);
        at += 5;
        let symbols = u16_at(&mut at);
        let symbols = (0..symbols)
            .map(|_| (u16_at(&mut at), u16_at(&mut at)))
            .collect();
        contexts.push((key, Frequencies { bits, symbols }));
    }
    assert_eq!(at, data.len(), "the model data has trailing bytes");
    for table in fields.iter().chain(contexts.iter().map(|(_, table)| table)) {
        let total: u32 = table.symbols.iter().map(|&(_, freq)| u32::from(freq)).sum();
        assert_eq!(
            total,
            1 << table.bits,
            "a model table does not sum to its scale"
        );
        assert!((6..=PROB_BITS).contains(&table.bits));
        assert!(
            table
                .symbols
                .iter()
                .all(|&(symbol, freq)| freq > 0 && usize::from(symbol) <= ESC)
        );
    }
    for window in contexts.windows(2) {
        assert!(
            window[0].0 < window[1].0,
            "model contexts are not in key order"
        );
    }
    for (key, table) in &contexts {
        assert!(field_of(*key) < FIELDS);
        assert!(
            table
                .symbols
                .iter()
                .any(|&(symbol, _)| usize::from(symbol) == ESC),
            "a context table cannot escape"
        );
    }
    (fields, contexts)
}

/// The decode model: every table's slots in one arena, so a decode step is
/// one dependent load from the context to its slot. `slot[state & mask]`
/// packs the symbol (9 bits), its frequency less one (11 bits) and the slot's
/// offset within the symbol's range (11 bits). A table is named by a handle,
/// `offset << 4 | bits`, which is never zero because `bits` is at least 6.
pub(super) struct DecodeModel {
    pub(super) slots: Box<[u32]>,
    /// The handle of each `key`'s context table, zero for none.
    index: Box<[u32]>,
    fields: [u32; FIELDS],
}

impl DecodeModel {
    #[expect(
        clippy::indexing_slicing,
        clippy::expect_used,
        clippy::cast_possible_truncation,
        reason = "`parse` checked the compiled-in tables: every symbol lies in its \
                  table's scale, every key below `FIELDS * AUX`, the arena far below 4 Gi"
    )]
    fn build() -> Self {
        let (fields, contexts) = parse(super::model_data::MODEL);
        let mut slots = Vec::new();
        let mut table = |frequencies: &Frequencies| {
            let offset = slots.len() as u32;
            let mut cum = 0u32;
            slots.resize(slots.len() + (1 << frequencies.bits), 0);
            for &(symbol, freq) in &frequencies.symbols {
                let freq = u32::from(freq);
                for at in 0..freq {
                    slots[(offset + cum + at) as usize] =
                        u32::from(symbol) | (freq - 1) << 9 | at << 20;
                }
                cum += freq;
            }
            offset << 4 | frequencies.bits
        };
        let fields: Vec<u32> = fields.iter().map(&mut table).collect();
        let mut index = vec![0u32; FIELDS * AUX].into_boxed_slice();
        for (key, frequencies) in &contexts {
            index[*key as usize] = table(frequencies);
        }
        Self {
            slots: slots.into_boxed_slice(),
            index,
            fields: fields.try_into().expect("a table per field"),
        }
    }

    /// The handle of `key`'s context table, zero when the model has none.
    #[inline(always)]
    pub(super) fn context(&self, key: u32) -> u32 {
        debug_assert!((key as usize) < self.index.len());
        // SAFETY: every key is `key(field, aux)` with a field below `FIELDS`
        // and `aux` masked to `AUX`, so it indexes the `FIELDS * AUX` index.
        unsafe { *self.index.get_unchecked(key as usize) }
    }

    #[inline(always)]
    #[expect(
        clippy::indexing_slicing,
        reason = "every key is `key(field, aux)` with a field below `FIELDS`"
    )]
    pub(super) fn field(&self, key: u32) -> u32 {
        self.fields[field_of(key)]
    }

    #[cfg(test)]
    pub(super) fn contexts(&self) -> usize {
        self.index.iter().filter(|&&handle| handle != 0).count()
    }
}

/// One symbol of one encode table, with what a reciprocal rANS step needs
/// (Giesen's `RansEncSymbol`): the state bound past which it renormalizes, and
/// the reciprocal that replaces the division. Absent symbols have `x_max` zero.
#[derive(Clone, Copy, Default)]
pub(super) struct EncodeSymbol {
    pub(super) x_max: u32,
    pub(super) rcp_freq: u32,
    pub(super) bias: u32,
    pub(super) cmpl_freq: u16,
    /// What coding the symbol costs, in 1/256 bit.
    pub(super) cost: u16,
    pub(super) rcp_shift: u32,
}

impl EncodeSymbol {
    #[expect(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "`freq` is in 1..scale with scale at most 2^11, so the reciprocal is \
                  below 2^32 and the complement and cost fit 16 bits"
    )]
    fn new(start: u32, freq: u32, bits: u32) -> Self {
        let scale = 1u32 << bits;
        let (rcp_freq, rcp_shift, bias) = if freq < 2 {
            // `x * !0 >> 32` is `x - 1`, which the bias's extra `scale - 1`
            // turns back into the exact step.
            (u32::MAX, 0, start + scale - 1)
        } else {
            let shift = 32 - (freq - 1).leading_zeros();
            let rcp = ((1u64 << (shift + 31)) + u64::from(freq) - 1) / u64::from(freq);
            (rcp as u32, shift - 1, start)
        };
        Self {
            x_max: ((super::rans::RANS_L >> bits) << 8) * freq,
            rcp_freq,
            bias,
            cmpl_freq: (scale - freq) as u16,
            cost: (-(f64::from(freq) / f64::from(scale)).log2() * 256.0).round() as u16,
            rcp_shift,
        }
    }
}

/// The encode model: every table's symbols in one arena of `ESC + 1` entries
/// a table, found from a key through one dense index.
pub(super) struct EncodeModel {
    pub(super) symbols: Box<[EncodeSymbol]>,
    /// One more than the arena table of each `key`'s context, zero for none.
    index: Box<[u32]>,
    fields: [u32; FIELDS],
}

impl EncodeModel {
    #[expect(
        clippy::indexing_slicing,
        clippy::expect_used,
        clippy::cast_possible_truncation,
        reason = "`parse` checked the compiled-in tables: every symbol is at most `ESC`, \
                  every key below `FIELDS * AUX`, the arena far below 4 Gi tables"
    )]
    fn build() -> Self {
        let (fields, contexts) = parse(super::model_data::MODEL);
        let mut symbols = Vec::new();
        let mut table = |frequencies: &Frequencies| {
            let first = symbols.len();
            symbols.resize(first + ESC + 1, EncodeSymbol::default());
            let mut cum = 0u32;
            for &(symbol, freq) in &frequencies.symbols {
                symbols[first + usize::from(symbol)] =
                    EncodeSymbol::new(cum, u32::from(freq), frequencies.bits);
                cum += u32::from(freq);
            }
            (first / (ESC + 1)) as u32
        };
        let fields: Vec<u32> = fields.iter().map(&mut table).collect();
        let mut index = vec![0u32; FIELDS * AUX].into_boxed_slice();
        for (key, frequencies) in &contexts {
            index[*key as usize] = table(frequencies) + 1;
        }
        Self {
            symbols: symbols.into_boxed_slice(),
            index,
            fields: fields.try_into().expect("a table per field"),
        }
    }

    /// The arena position of `symbol` in `key`'s context table, if the model
    /// has that table.
    #[inline(always)]
    pub(super) fn context(&self, key: u32, symbol: usize) -> Option<usize> {
        let table = *self.index.get(key as usize)?;
        (table != 0).then(|| (table as usize - 1) * (ESC + 1) + symbol)
    }

    #[inline(always)]
    #[expect(
        clippy::indexing_slicing,
        reason = "every key is `key(field, aux)` with a field below `FIELDS`"
    )]
    pub(super) fn field(&self, key: u32, symbol: usize) -> usize {
        self.fields[field_of(key)] as usize * (ESC + 1) + symbol
    }

    #[cfg(test)]
    pub(super) fn contexts(&self) -> usize {
        self.index.iter().filter(|&&table| table != 0).count()
    }
}

/// The decode model, built once per process from the compiled-in data.
pub(super) fn decode_model() -> &'static DecodeModel {
    static MODEL: OnceLock<DecodeModel> = OnceLock::new();
    MODEL.get_or_init(DecodeModel::build)
}

/// The encode model, built once per process from the compiled-in data.
pub(super) fn encode_model() -> &'static EncodeModel {
    static MODEL: OnceLock<EncodeModel> = OnceLock::new();
    MODEL.get_or_init(EncodeModel::build)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_model_data_is_well_formed() {
        let (fields, contexts) = parse(super::super::model_data::MODEL);
        assert_eq!(fields.len(), FIELDS);
        assert!(!contexts.is_empty());
        // Every byte value is codable in every field, so a literal never fails.
        for field in &fields {
            assert!(field.symbols.iter().all(|&(_, freq)| freq > 0));
        }
        let decode = decode_model();
        let encode = encode_model();
        assert_eq!(decode.contexts(), encode.contexts());
    }
}
