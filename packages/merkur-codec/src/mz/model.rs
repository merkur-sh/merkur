//! The trained prior every frame's tables start from: one table set per field,
//! and table sets for the contexts that earn their bytes. A table set is a
//! high-nibble CDF, a low-nibble CDF per high nibble, and the rate the context
//! adapts at.

use super::nibble::Cdf;
use std::sync::OnceLock;

/// Bits of context per field. Every context a field takes fits twelve bits.
const AUX_BITS: u32 = 12;
/// Context values per field.
pub(super) const AUX: usize = 1 << AUX_BITS;

pub(super) const F_ROW: u32 = 0;
pub(super) const F_LEFT: u32 = 1;
pub(super) const F_COUNT: u32 = 2;
pub(super) const F_MODE: u32 = 3;
pub(super) const F_LINK: u32 = 4;
pub(super) const F_SEG: u32 = 5;
pub(super) const F_SRC_KIND: u32 = 6;
pub(super) const F_BACK: u32 = 7;
pub(super) const F_SEQ: u32 = 8;
pub(super) const F_SRC_ROW: u32 = 9;
pub(super) const F_SRC_ITEM: u32 = 10;
pub(super) const F_ITEMS: u32 = 11;
pub(super) const F_TAG: u32 = 12;
/// Whether a character stays in its predecessor's 128-character block.
pub(super) const F_SAME_BLOCK: u32 = 13;
/// A character's low seven bits.
pub(super) const F_LOW7: u32 = 14;
/// A new block's position in the recent blocks, or a miss.
pub(super) const F_BLOCK_MTF: u32 = 15;
/// A missed block, as a varint.
pub(super) const F_BLOCK: u32 = 16;
/// A colour's position in its slot's recent colours, or the kind of miss.
pub(super) const F_COLOR_MTF: u32 = 17;
/// A missed palette colour.
pub(super) const F_PALETTE: u32 = 18;
/// A missed 24-bit colour, channel by channel, against the slot's last one.
pub(super) const F_DCOLOR: u32 = 19;
pub(super) const F_RUN: u32 = 20;
/// A graphics row's section: its four length bytes, then its bytes.
pub(super) const F_GRAPHICS: u32 = 21;
pub(super) const FIELDS: usize = 22;
/// Every key a walk codes in.
pub(super) const KEYS: usize = FIELDS * AUX;

#[inline]
pub(super) const fn key(field: u32, aux: u32) -> u32 {
    field << AUX_BITS | (aux & ((1 << AUX_BITS) - 1))
}

#[inline]
pub(super) const fn field_of(key: u32) -> usize {
    (key >> AUX_BITS) as usize
}

/// Where a frame's tables start.
pub(super) trait Prior {
    fn hi(&self, key: u32) -> &Cdf;
    fn lo(&self, key: u32, h: usize) -> &Cdf;
    fn rate(&self, key: u32) -> u8;
}

/// One table set: what a context starts each frame with.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct TableSet {
    pub(super) rate: u8,
    pub(super) hi: Cdf,
    /// The low tables, those the context has; the rest are its field's.
    pub(super) lo: [Option<Cdf>; 16],
}

/// The compiled-in prior.
pub(super) struct StaticModel {
    /// Field table sets first, every low table present, then the contexts'.
    sets: Vec<TableSet>,
    /// The table set of each key.
    index: Box<[u32]>,
}

impl Prior for StaticModel {
    #[inline(always)]
    fn hi(&self, key: u32) -> &Cdf {
        &self.set(key).hi
    }

    #[inline(always)]
    #[expect(
        clippy::indexing_slicing,
        clippy::expect_used,
        reason = "field table sets hold every low table, checked when parsed"
    )]
    fn lo(&self, key: u32, h: usize) -> &Cdf {
        match &self.set(key).lo[h & 15] {
            Some(lo) => lo,
            None => self.sets[field_of(key)].lo[h & 15]
                .as_ref()
                .expect("a field holds every low table"),
        }
    }

    #[inline(always)]
    fn rate(&self, key: u32) -> u8 {
        self.set(key).rate
    }
}

impl StaticModel {
    #[inline(always)]
    fn set(&self, key: u32) -> &TableSet {
        // SAFETY: every key is `key(field, aux)` with a field below `FIELDS`
        // and `aux` masked, so it indexes the `KEYS` index.
        let at = unsafe { *self.index.get_unchecked(key as usize) };
        // SAFETY: every index entry is a table set `parse` built.
        unsafe { self.sets.get_unchecked(at as usize) }
    }

    /// The model the data describes; `None` for data the format does not
    /// allow, which for the compiled-in data is a build defect.
    pub(super) fn parse(data: &[u8]) -> Option<Self> {
        let mut at = 0usize;
        let u16_at = |at: &mut usize| -> Option<u16> {
            let value = u16::from_le_bytes(data.get(*at..*at + 2)?.try_into().ok()?);
            *at += 2;
            Some(value)
        };
        let count = u32::from(u16_at(&mut at)?) | u32::from(u16_at(&mut at)?) << 16;
        let table = |at: &mut usize| -> Option<Cdf> {
            let mut freqs = [0u16; 16];
            for freq in &mut freqs {
                *freq = u16_at(at)?;
            }
            let sum: u32 = freqs.iter().map(|&f| u32::from(f)).sum();
            (sum == super::nibble::PROB_SCALE && freqs.iter().all(|&f| f > 0))
                .then(|| Cdf::from_freqs(&freqs))
        };
        let set = |at: &mut usize| -> Option<TableSet> {
            let rate = *data.get(*at)?;
            *at += 1;
            if !(1..=8).contains(&rate) {
                return None;
            }
            let hi = table(at)?;
            let mask = u16::from_le_bytes(data.get(*at..*at + 2)?.try_into().ok()?);
            *at += 2;
            let mut lo = [None; 16];
            for (h, slot) in lo.iter_mut().enumerate() {
                if mask & 1 << h != 0 {
                    *slot = Some(table(at)?);
                }
            }
            Some(TableSet { rate, hi, lo })
        };
        let mut sets = Vec::with_capacity(FIELDS + count as usize);
        for _ in 0..FIELDS {
            let field = set(&mut at)?;
            if field.lo.iter().any(Option::is_none) {
                return None;
            }
            sets.push(field);
        }
        let keys = u32::try_from(KEYS).ok()?;
        let mut index = (0..keys)
            .map(|key| u32::try_from(field_of(key)).ok())
            .collect::<Option<Box<[u32]>>>()?;
        let mut previous = None;
        for _ in 0..count {
            let key = u32::from_le_bytes(data.get(at..at + 4)?.try_into().ok()?);
            at += 4;
            if key as usize >= KEYS || previous.is_some_and(|previous| previous >= key) {
                return None;
            }
            previous = Some(key);
            *index.get_mut(key as usize)? = u32::try_from(sets.len()).ok()?;
            sets.push(set(&mut at)?);
        }
        (at == data.len()).then_some(Self { sets, index })
    }

    /// The bytes [`Self::parse`] reads: field sets, then `(key, set)` in key
    /// order.
    pub(super) fn write(fields: &[TableSet], contexts: &[(u32, TableSet)]) -> Vec<u8> {
        let mut out = Vec::new();
        let count = u32::try_from(contexts.len()).unwrap_or(u32::MAX);
        out.extend_from_slice(&count.to_le_bytes());
        let write_set = |out: &mut Vec<u8>, set: &TableSet| {
            out.push(set.rate);
            for freq in set.hi.freqs() {
                out.extend_from_slice(&freq.to_le_bytes());
            }
            let mask = set
                .lo
                .iter()
                .enumerate()
                .filter(|(_, lo)| lo.is_some())
                .fold(0u16, |mask, (h, _)| mask | 1 << h);
            out.extend_from_slice(&mask.to_le_bytes());
            for lo in set.lo.iter().flatten() {
                for freq in lo.freqs() {
                    out.extend_from_slice(&freq.to_le_bytes());
                }
            }
        };
        for field in fields {
            write_set(&mut out, field);
        }
        for (key, set) in contexts {
            out.extend_from_slice(&key.to_le_bytes());
            write_set(&mut out, set);
        }
        out
    }

    /// Every context key the model has a table set for.
    #[cfg(test)]
    pub(super) fn contexts(&self) -> usize {
        self.sets.len() - FIELDS
    }
}

/// The compiled-in prior, parsed once per process.
#[expect(clippy::expect_used, reason = "the model data is compiled in; a malformed one is a build defect")]
pub(super) fn static_model() -> &'static StaticModel {
    static MODEL: OnceLock<StaticModel> = OnceLock::new();
    MODEL.get_or_init(|| StaticModel::parse(super::model_data::MODEL).expect("the compiled-in MZ model"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_model_data_is_well_formed() {
        let model = StaticModel::parse(super::super::model_data::MODEL).expect("model data");
        assert!(model.sets.len() >= FIELDS);
        let _ = model.contexts();
    }
}
