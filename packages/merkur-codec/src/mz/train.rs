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
use std::collections::BTreeMap;

/// Every rate accepted by the unchanged model reader.
const RATES: std::ops::RangeInclusive<u8> = 1..=8;
/// A table's frame boundary, outside its sixteen-symbol alphabet.
const RESET: u8 = 16;
/// High table first, then the sixteen low tables.
const TABLES: usize = 17;

struct Samples {
    symbols: [Vec<u8>; TABLES],
    last_frame: [usize; TABLES],
}

impl Default for Samples {
    fn default() -> Self {
        Self {
            symbols: core::array::from_fn(|_| Vec::new()),
            last_frame: [usize::MAX; TABLES],
        }
    }
}

/// Symbol traces gathered from frames.
#[derive(Default)]
pub struct MzTrainer {
    frames: Vec<Vec<u32>>,
}

/// Quantize a smoothed distribution to the coder's exact frequency scale.
fn normalize(counts: &[f64; 16], prior: Option<&Cdf>) -> Cdf {
    let base = prior.map_or([2048; 16], Cdf::freqs);
    let weights: [f64; 16] =
        core::array::from_fn(|s| counts[s] + f64::from(base[s]) / f64::from(PROB_SCALE) * 16.0);
    let sum: f64 = weights.iter().sum();
    let spare = f64::from(PROB_SCALE - 16);
    let mut freqs = [0u16; 16];
    let mut have = 0u32;
    for (freq, weight) in freqs.iter_mut().zip(weights) {
        *freq = 1 + (weight / sum * spare).floor() as u16;
        have += u32::from(*freq);
    }
    let top = (0..16)
        .max_by(|&a, &b| weights[a].total_cmp(&weights[b]).then(b.cmp(&a)))
        .unwrap_or(0);
    freqs[top] += (PROB_SCALE - have) as u16;
    Cdf::from_freqs(&freqs)
}

fn table_cost(symbols: &[u8], initial: Cdf, rate: u8) -> f64 {
    let mut table = initial;
    let mut bits = 0.0;
    for &s in symbols {
        if s == RESET {
            table = initial;
        } else {
            bits += f64::from(super::nibble::PROB_BITS)
                - f64::from(table.start_freq(usize::from(s)).1).log2();
            table.update(usize::from(s), u32::from(rate));
        }
    }
    bits
}

/// Compare the frame average with counts weighted by the prior's remaining
/// influence after each update. Resets are per context and per nibble table.
fn fit(samples: &[&Samples], rate: u8, prior: Option<&TableSet>) -> ([Cdf; TABLES], [f64; TABLES]) {
    let mut tables = [Cdf::from_freqs(&[2048; 16]); TABLES];
    let mut costs = [0.0; TABLES];
    let decay = 1.0 - 1.0 / f64::from(1u32 << rate);
    for t in 0..TABLES {
        let mut average = [0.0; 16];
        let mut early = [0.0; 16];
        for sample in samples {
            let mut weight = 1.0;
            for &s in &sample.symbols[t] {
                if s == RESET {
                    weight = 1.0;
                } else {
                    average[usize::from(s)] += 1.0;
                    early[usize::from(s)] += weight;
                    weight *= decay;
                }
            }
        }
        let base = prior.map(|set| {
            if t == 0 {
                set.hi
            } else {
                set.lo[t - 1].expect("field low")
            }
        });
        let mut best = (f64::INFINITY, tables[t]);
        for counts in [&average, &early] {
            let initial = normalize(counts, base.as_ref());
            let bits = samples
                .iter()
                .map(|sample| table_cost(&sample.symbols[t], initial, rate))
                .sum();
            if bits < best.0 {
                best = (bits, initial);
            }
        }
        // A context may retain its field's initial high table while choosing
        // its own rate or low tables.
        if let Some(initial) = base {
            let bits = samples
                .iter()
                .map(|sample| table_cost(&sample.symbols[t], initial, rate))
                .sum();
            if bits < best.0 {
                best = (bits, initial);
            }
        }
        // Attribute each coded probability to the fraction still supplied by
        // the initial table, then refit that table. The integer CDF update
        // prices every candidate; only a measured improvement is retained.
        let mut initial = best.1;
        for _ in 0..8 {
            let initial_freqs = initial.freqs();
            let mut expected = [0.0; 16];
            for sample in samples {
                let mut table = initial;
                let mut weight = 1.0;
                for &s in &sample.symbols[t] {
                    if s == RESET {
                        table = initial;
                        weight = 1.0;
                    } else {
                        let s = usize::from(s);
                        expected[s] +=
                            weight * f64::from(initial_freqs[s]) / f64::from(table.start_freq(s).1);
                        table.update(s, u32::from(rate));
                        weight *= decay;
                    }
                }
            }
            initial = normalize(&expected, base.as_ref());
            let bits = samples
                .iter()
                .map(|sample| table_cost(&sample.symbols[t], initial, rate))
                .sum();
            if bits < best.0 {
                best = (bits, initial);
            }
        }
        tables[t] = best.1;
        costs[t] = best.0;
    }
    (tables, costs)
}

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
        let mut per_key: BTreeMap<u32, Samples> = BTreeMap::new();
        for (frame_index, frame) in self.frames.iter().enumerate() {
            for &entry in frame {
                let key = entry >> 9;
                if key as usize >= KEYS {
                    continue;
                }
                let t = if entry >> 8 & 1 == 0 {
                    0
                } else {
                    1 + (entry >> 4 & 15) as usize
                };
                let sample = per_key.entry(key).or_default();
                if sample.last_frame[t] != frame_index {
                    sample.last_frame[t] = frame_index;
                    sample.symbols[t].push(RESET);
                }
                sample.symbols[t].push((entry & 15) as u8);
            }
        }
        let mut fields = Vec::with_capacity(FIELDS);
        for f in 0..FIELDS {
            let samples: Vec<_> = per_key
                .iter()
                .filter(|(key, _)| field_of(**key) == f)
                .map(|(_, sample)| sample)
                .collect();
            let mut best = (
                f64::INFINITY,
                TableSet {
                    rate: 4,
                    hi: Cdf::from_freqs(&[2048; 16]),
                    lo: [Some(Cdf::from_freqs(&[2048; 16])); 16],
                },
            );
            for rate in RATES {
                let (tables, costs) = fit(&samples, rate, None);
                let bits: f64 = costs.iter().sum();
                if bits < best.0 {
                    best = (
                        bits,
                        TableSet {
                            rate,
                            hi: tables[0],
                            lo: core::array::from_fn(|h| Some(tables[h + 1])),
                        },
                    );
                }
            }
            fields.push(best.1);
        }
        // Savings include the exact adaptive updates, with missing low
        // tables initialized from the field at the context's chosen rate.
        let mut ranked = Vec::new();
        for (&key, sample) in &per_key {
            let field = &fields[field_of(key)];
            let field_table = |t: usize| {
                if t == 0 {
                    field.hi
                } else {
                    field.lo[t - 1].expect("field low")
                }
            };
            let baseline: f64 = (0..TABLES)
                .map(|t| table_cost(&sample.symbols[t], field_table(t), field.rate))
                .sum();
            let mut best = (
                0.0,
                TableSet {
                    lo: [None; 16],
                    ..*field
                },
            );
            for rate in RATES {
                let (tables, costs) = fit(&[sample], rate, Some(field));
                let mut bits = costs[0];
                let mut lo = [None; 16];
                for h in 0..16 {
                    let base_cost = table_cost(&sample.symbols[h + 1], field_table(h + 1), rate);
                    if base_cost - costs[h + 1] > 32.0 * 8.0 {
                        lo[h] = Some(tables[h + 1]);
                        bits += costs[h + 1];
                    } else {
                        bits += base_cost;
                    }
                }
                let set = TableSet {
                    rate,
                    hi: tables[0],
                    lo,
                };
                let saved = baseline - bits;
                // Maximize the training bits saved after paying for the set.
                if saved - (set_bytes(&set) * 8) as f64 > best.0 - (set_bytes(&best.1) * 8) as f64 {
                    best = (saved, set);
                }
            }
            let bytes = set_bytes(&best.1);
            if best.0 > (bytes * 8) as f64 {
                ranked.push((best.0 / bytes as f64, key, best.1));
            }
        }
        ranked.sort_by(|a, b| b.0.total_cmp(&a.0).then(a.1.cmp(&b.1)));
        let mut used = 0usize;
        let mut contexts = Vec::new();
        for (_, key, set) in ranked {
            let bytes = set_bytes(&set);
            if used + bytes <= budget {
                used += bytes;
                contexts.push((key, set));
            }
        }
        contexts.sort_by_key(|&(key, _)| key);
        // Field rates serve only keys without a context set; selected keys
        // still borrow the field's low distributions, at their own rate.
        for (f, field) in fields.iter_mut().enumerate() {
            let samples: Vec<_> = per_key
                .iter()
                .filter(|(key, _)| {
                    field_of(**key) == f
                        && contexts.binary_search_by_key(key, |(key, _)| key).is_err()
                })
                .map(|(_, sample)| sample)
                .collect();
            field.rate = RATES
                .min_by(|&a, &b| {
                    let price = |rate| {
                        samples
                            .iter()
                            .map(|sample| {
                                (0..TABLES)
                                    .map(|t| {
                                        table_cost(
                                            &sample.symbols[t],
                                            if t == 0 {
                                                field.hi
                                            } else {
                                                field.lo[t - 1].expect("field low")
                                            },
                                            rate,
                                        )
                                    })
                                    .sum::<f64>()
                            })
                            .sum::<f64>()
                    };
                    price(a).total_cmp(&price(b))
                })
                .unwrap_or(4);
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
