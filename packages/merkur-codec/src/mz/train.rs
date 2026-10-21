//! Building the prior from row traffic. Nothing on a display path runs this:
//! `mz_train_model` in the dataplane's simulator replays recorded sessions
//! through the production daemon and hands every frame's symbol trace here.
#![expect(
    clippy::indexing_slicing,
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    clippy::cast_sign_loss,
    clippy::too_many_lines,
    clippy::expect_used,
    reason = "an offline training run over its own counts, whose tables fit the model \
              format by construction; a defect stops the run, never a session"
)]

use super::model::{FIELDS, KEYS, StaticModel, TableSet, field_of};
use super::nibble::{Cdf, PROB_SCALE};
use std::collections::HashMap;

/// Rates a table may adapt at.
const RATES: std::ops::RangeInclusive<u8> = 1..=7;

/// One key's (or field's) symbol counts.
#[derive(Clone, Default)]
struct Counts {
    hi: [u64; 16],
    lo: [[u64; 16]; 16],
}

impl Counts {
    fn add(&mut self, low: bool, h: usize, s: usize) {
        if low {
            self.lo[h][s] += 1;
        } else {
            self.hi[s] += 1;
        }
    }

    fn total(&self) -> u64 {
        self.hi.iter().sum::<u64>() + self.lo.iter().flatten().sum::<u64>()
    }
}

/// Symbol traces gathered from frames.
#[derive(Default)]
pub struct MzTrainer {
    frames: Vec<Vec<u32>>,
}

/// Frequencies of `counts` summing to `PROB_SCALE`, every symbol at least 1,
/// with `prior` blended in as pseudo-counts so a sparse table stays near it.
fn normalize(counts: &[u64; 16], prior: Option<&[u16; 16]>) -> [u16; 16] {
    let mut weights = [0f64; 16];
    let total: u64 = counts.iter().sum();
    for (s, weight) in weights.iter_mut().enumerate() {
        let pseudo = prior.map_or(1.0, |prior| f64::from(prior[s]) / f64::from(PROB_SCALE) * 16.0);
        *weight = counts[s] as f64 + pseudo + if total == 0 { 1.0 } else { 0.0 };
    }
    let sum: f64 = weights.iter().sum();
    let spare = f64::from(PROB_SCALE - 16);
    let mut freqs = [0u16; 16];
    let mut have = 0u32;
    for (freq, weight) in freqs.iter_mut().zip(weights) {
        *freq = 1 + (weight / sum * spare).floor() as u16;
        have += u32::from(*freq);
    }
    let top = (0..16).max_by(|&a, &b| weights[a].total_cmp(&weights[b]).then(b.cmp(&a))).unwrap_or(0);
    freqs[top] += (PROB_SCALE - have) as u16;
    freqs
}

fn cost(counts: &[u64; 16], freqs: &[u16; 16]) -> f64 {
    counts
        .iter()
        .zip(freqs)
        .filter(|(count, _)| **count > 0)
        .map(|(&count, &freq)| count as f64 * (f64::from(PROB_BITS_F) - f64::from(freq).log2()))
        .sum()
}

const PROB_BITS_F: u32 = super::nibble::PROB_BITS;

fn set_bytes(set: &TableSet) -> usize {
    4 + 1 + 32 + 2 + 32 * set.lo.iter().flatten().count()
}

impl MzTrainer {
    /// Add one frame's symbol trace.
    pub fn add_trace(&mut self, trace: &[u32]) {
        if !trace.is_empty() {
            self.frames.push(trace.to_vec());
        }
    }

    /// The model data for `model_data.rs`, its contexts within `budget` bytes.
    pub fn model_data(&self, budget: usize) -> Vec<u8> {
        let mut per_key: HashMap<u32, Counts> = HashMap::new();
        let mut per_field = vec![Counts::default(); FIELDS];
        for frame in &self.frames {
            for &entry in frame {
                let key = entry >> 9;
                if key as usize >= KEYS {
                    continue;
                }
                let (low, h, s) = (entry >> 8 & 1 == 1, (entry >> 4 & 15) as usize, (entry & 15) as usize);
                per_key.entry(key).or_default().add(low, h, s);
                per_field[field_of(key)].add(low, h, s);
            }
        }
        // Field sets: every table, from the field's counts.
        let mut fields: Vec<TableSet> = per_field
            .iter()
            .map(|counts| TableSet {
                rate: 4,
                hi: Cdf::from_freqs(&normalize(&counts.hi, None)),
                lo: core::array::from_fn(|h| Some(Cdf::from_freqs(&normalize(&counts.lo[h], None)))),
            })
            .collect();
        // Context sets: the tables of a key that beat its field's, ranked by
        // bits saved per byte of table.
        let mut ranked: Vec<(f64, u32, TableSet)> = Vec::new();
        for (&key, counts) in &per_key {
            let field = &fields[field_of(key)];
            let field_hi = field.hi.freqs();
            let hi = normalize(&counts.hi, Some(&field_hi));
            let mut saved = cost(&counts.hi, &field_hi) - cost(&counts.hi, &hi);
            let mut lo = [None; 16];
            for ((slot, field_table), lo_counts) in lo.iter_mut().zip(&field.lo).zip(&counts.lo) {
                if lo_counts.iter().sum::<u64>() == 0 {
                    continue;
                }
                let field_lo = field_table.map(|cdf| cdf.freqs()).unwrap_or([2048; 16]);
                let own = normalize(lo_counts, Some(&field_lo));
                let gain = cost(lo_counts, &field_lo) - cost(lo_counts, &own);
                // A low table pays for its 32 bytes or stays the field's.
                if gain > 32.0 * 8.0 {
                    saved += gain;
                    *slot = Some(Cdf::from_freqs(&own));
                }
            }
            let set = TableSet { rate: 4, hi: Cdf::from_freqs(&hi), lo };
            let bytes = set_bytes(&set);
            if saved > (bytes * 8) as f64 && counts.total() > 0 {
                ranked.push((saved / bytes as f64, key, set));
            }
        }
        ranked.sort_by(|a, b| b.0.total_cmp(&a.0).then(a.1.cmp(&b.1)));
        let mut used = 0usize;
        let mut contexts: Vec<(u32, TableSet)> = Vec::new();
        for (_, key, set) in ranked {
            let bytes = set_bytes(&set);
            if used + bytes > budget {
                continue;
            }
            used += bytes;
            contexts.push((key, set));
        }
        contexts.sort_by_key(|&(key, _)| key);
        // Rates: each set's rate is the one whose adaptive coding of every
        // frame, from these tables, costs least.
        let model = StaticModel::parse(&StaticModel::write(&fields, &contexts)).expect("a model it wrote");
        let mut set_of = vec![usize::MAX; KEYS];
        for (index, (key, _)) in contexts.iter().enumerate() {
            set_of[*key as usize] = FIELDS + index;
        }
        let sets = FIELDS + contexts.len();
        let mut rate_cost = vec![[0f64; 8]; sets];
        for rate in RATES {
            let mut work: HashMap<u32, (Cdf, [Option<Cdf>; 16])> = HashMap::new();
            for frame in &self.frames {
                work.clear();
                for &entry in frame {
                    let key = entry >> 9;
                    if key as usize >= KEYS {
                        continue;
                    }
                    let (low, h, s) = (entry >> 8 & 1 == 1, (entry >> 4 & 15) as usize, (entry & 15) as usize);
                    let set = match set_of[key as usize] {
                        usize::MAX => field_of(key),
                        set => set,
                    };
                    use super::model::Prior;
                    let tables = work.entry(key).or_insert_with(|| (*model.hi(key), [None; 16]));
                    let cdf = if low {
                        tables.1[h].get_or_insert_with(|| *model.lo(key, h))
                    } else {
                        &mut tables.0
                    };
                    let (_, freq) = cdf.start_freq(s);
                    rate_cost[set][usize::from(rate)] += f64::from(PROB_BITS_F) - f64::from(freq).log2();
                    cdf.update(s, u32::from(rate));
                }
            }
        }
        let best_rate = |set: usize| {
            RATES
                .min_by(|&a, &b| rate_cost[set][usize::from(a)].total_cmp(&rate_cost[set][usize::from(b)]))
                .unwrap_or(4)
        };
        for (index, field) in fields.iter_mut().enumerate() {
            field.rate = best_rate(index);
        }
        for (index, (_, set)) in contexts.iter_mut().enumerate() {
            set.rate = best_rate(FIELDS + index);
        }
        StaticModel::write(&fields, &contexts)
    }

    /// `model_data.rs` for `data`.
    pub fn model_source(data: &[u8]) -> String {
        let mut source = String::from(
            "// Generated by `mz_train_model` in apps/daemon/dataplane/src/display/sim.rs; do not edit.\n\
             //\n\
             // The MZ prior: a u32 context count, the field table sets, then each context's u32 key and\n\
             // table set in key order. A table set is its u8 rate, its high table's 16 little-endian u16\n\
             // frequencies, a u16 mask of the low tables it has, and each such low table's 16.\n\n\
             pub(super) static MODEL: &[u8] = b\"\\\n",
        );
        for chunk in data.chunks(32) {
            for byte in chunk {
                source.push_str(&format!("\\x{byte:02x}"));
            }
            source.push_str("\\\n");
        }
        source.push_str("\";\n");
        source
    }
}
