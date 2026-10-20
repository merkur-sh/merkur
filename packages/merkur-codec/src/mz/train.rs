//! Building the static model from row traffic. Nothing on a display path runs
//! this: `mz_train_model` in the dataplane's simulator replays recorded
//! sessions through the production daemon and writes `model_data.rs` with it.
#![expect(
    clippy::indexing_slicing,
    clippy::cast_possible_truncation,
    clippy::expect_used,
    clippy::too_many_lines,
    reason = "an offline training run over its own counts, whose tables fit the model \
              format by construction; a defect stops the run, never a session"
)]

use super::frame::{MzReference, Sink, entries};
use super::model::{AUX, ESC, FIELDS, PROB_BITS, field_of};

/// Symbol counts gathered from frames, in one dense row per context.
pub struct MzTrainer {
    contexts: Vec<Option<Box<[u64; ESC + 1]>>>,
    fields: Vec<[u64; 256]>,
}

impl Default for MzTrainer {
    fn default() -> Self {
        Self {
            contexts: (0..FIELDS * AUX).map(|_| None).collect(),
            fields: vec![[0; 256]; FIELDS],
        }
    }
}

impl Sink for MzTrainer {
    fn put(&mut self, key: u32, symbol: u8) {
        self.contexts[key as usize].get_or_insert_with(|| Box::new([0; ESC + 1]))
            [usize::from(symbol)] += 1;
        self.fields[field_of(key)][usize::from(symbol)] += 1;
    }
}

/// Normalize `counts` to frequencies summing to `1 << bits`, every counted
/// symbol at least 1.
fn normalize(counts: &[u64], bits: u32) -> Vec<u32> {
    let scale = 1u64 << bits;
    let total: u64 = counts.iter().sum();
    let mut freqs: Vec<u32> = counts
        .iter()
        .map(|&count| {
            if count == 0 {
                0
            } else {
                ((count * scale + total / 2) / total).max(1) as u32
            }
        })
        .collect();
    let mut sum: u64 = freqs.iter().map(|&freq| u64::from(freq)).sum();
    // Take the excess from, or give the shortfall to, the most frequent
    // symbols first, never below 1.
    let mut order: Vec<usize> = (0..counts.len()).filter(|&i| freqs[i] > 0).collect();
    order.sort_unstable_by(|&a, &b| counts[b].cmp(&counts[a]).then(a.cmp(&b)));
    let mut turn = 0usize;
    while sum > scale {
        let symbol = order[turn % order.len()];
        let take = (sum - scale)
            .min(u64::from(freqs[symbol] - 1))
            .min(u64::from((freqs[symbol] / 4).max(1)));
        freqs[symbol] -= take as u32;
        sum -= take;
        turn += 1;
        assert!(
            turn < 64 * order.len(),
            "a table cannot fit its symbols at {bits} bits"
        );
    }
    if sum < scale {
        freqs[order[0]] += (scale - sum) as u32;
    }
    freqs
}

fn table_cost(counts: &[u64], freqs: &[u32], bits: u32) -> f64 {
    counts
        .iter()
        .zip(freqs)
        .filter(|(count, _)| **count > 0)
        .map(|(&count, &freq)| count as f64 * (f64::from(bits) - f64::from(freq).log2()))
        .sum()
}

/// One context's escape reserve: what it never saw still has to be codable.
fn with_escape(row: &[u64; ESC + 1]) -> [u64; ESC + 1] {
    let mut counts = *row;
    let distinct = counts[..ESC].iter().filter(|&&count| count > 0).count() as u64;
    counts[ESC] = counts[ESC].max(1).max(distinct / 2);
    counts
}

/// Bytes a decode table of `bits` precision occupies.
fn table_bytes(bits: u32) -> usize {
    (1usize << bits) * 4
}

impl MzTrainer {
    /// Count one frame's `row_count` row-layout entries, each `references[i]`
    /// counted in place of its literal. False when the rows do not parse.
    pub fn add_rows(
        &mut self,
        rows: &[u8],
        row_count: u16,
        references: &[Option<MzReference>],
    ) -> bool {
        let mut walk = super::frame::Walk::new();
        for (index, entry) in entries(rows, row_count).enumerate() {
            let Some(entry @ &[row_high, row_low, ..]) = entry else {
                return false;
            };
            let row = u16::from_be_bytes([row_high, row_low]);
            match references.get(index).copied().flatten() {
                Some(reference) => super::frame::put_reference(&mut walk, self, row, &reference),
                None => {
                    if super::frame::put_literal(&mut walk, self, entry).is_none() {
                        return false;
                    }
                }
            }
        }
        true
    }

    /// The model data for `model_data.rs`: field tables at full precision,
    /// smoothed so every byte is codable, and the contexts that save the most
    /// bits per table byte within `budget` bytes of decode tables. Each context
    /// picks its own precision, under one Lagrange multiplier.
    pub fn model_data(&self, budget: usize) -> Vec<u8> {
        let field_tables: Vec<Vec<u32>> = self
            .fields
            .iter()
            .map(|counts| {
                let smoothed: Vec<u64> = counts.iter().map(|&count| count * 16 + 1).collect();
                normalize(&smoothed, PROB_BITS)
            })
            .collect();
        let field_bits: Vec<Vec<f64>> = field_tables
            .iter()
            .map(|freqs| {
                freqs
                    .iter()
                    .map(|&freq| f64::from(PROB_BITS) - f64::from(freq).log2())
                    .collect()
            })
            .collect();
        struct Candidate {
            key: u32,
            options: Vec<(f64, usize, u32)>,
        }
        let mut candidates = Vec::new();
        for (key, row) in self.contexts.iter().enumerate() {
            let Some(row) = row else {
                continue;
            };
            let total: u64 = row[..ESC].iter().sum();
            if total < 16 {
                continue;
            }
            let counts = with_escape(row);
            let distinct = counts.iter().filter(|&&count| count > 0).count();
            let field = &field_bits[field_of(key as u32)];
            let base: f64 = (0..ESC)
                .map(|symbol| row[symbol] as f64 * field[symbol])
                .sum();
            let options = (6..=PROB_BITS)
                .filter(|&bits| (1usize << bits) >= distinct)
                .filter_map(|bits| {
                    let freqs = normalize(&counts, bits);
                    let gain = base - table_cost(&counts, &freqs, bits);
                    (gain > 0.0).then_some((gain, table_bytes(bits), bits))
                })
                .collect::<Vec<_>>();
            if !options.is_empty() {
                candidates.push(Candidate {
                    key: key as u32,
                    options,
                });
            }
        }
        let pick = |lambda: f64| {
            let mut used = 0usize;
            let mut chosen = Vec::new();
            for candidate in &candidates {
                let best = candidate
                    .options
                    .iter()
                    .map(|&(gain, bytes, bits)| (gain - lambda * bytes as f64, bytes, bits))
                    .filter(|option| option.0 > 0.0)
                    .max_by(|a, b| a.0.total_cmp(&b.0));
                if let Some((_, bytes, bits)) = best {
                    used += bytes;
                    chosen.push((candidate.key, bits));
                }
            }
            (used, chosen)
        };
        let (mut low, mut high) = (0.0f64, 1e9f64);
        for _ in 0..80 {
            let middle = (low + high) / 2.0;
            if pick(middle).0 > budget {
                low = middle;
            } else {
                high = middle;
            }
        }
        let (_, chosen) = pick(high);
        let mut data = Vec::new();
        for freqs in &field_tables {
            for &freq in freqs {
                data.extend_from_slice(&(freq as u16).to_le_bytes());
            }
        }
        data.extend_from_slice(&(chosen.len() as u32).to_le_bytes());
        for (key, bits) in chosen {
            let counts = with_escape(self.contexts[key as usize].as_ref().expect("chosen"));
            let freqs = normalize(&counts, bits);
            data.extend_from_slice(&key.to_le_bytes());
            data.push(bits as u8);
            let symbols: Vec<(usize, u32)> = freqs
                .iter()
                .enumerate()
                .filter(|(_, freq)| **freq > 0)
                .map(|(symbol, &freq)| (symbol, freq))
                .collect();
            data.extend_from_slice(&(symbols.len() as u16).to_le_bytes());
            for (symbol, freq) in symbols {
                data.extend_from_slice(&(symbol as u16).to_le_bytes());
                data.extend_from_slice(&(freq as u16).to_le_bytes());
            }
        }
        data
    }

    /// Render model data as the `model_data.rs` source.
    pub fn model_source(data: &[u8]) -> String {
        let mut source = String::from(
            "// Generated by `mz_train_model` in apps/daemon/dataplane/src/display/sim.rs; do not edit.\n\
             //\n\
             // The static MZ model: 16 field tables of 256 little-endian u16 frequencies at\n\
             // `PROB_BITS`, then a u32 context count and, for each context in key order, its u32 key,\n\
             // its u8 precision and a u16 count of (u16 symbol, u16 frequency) pairs.\n\n\
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
