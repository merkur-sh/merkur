use super::*;
use std::collections::HashSet;

#[test]
fn reordered_sources_retire_even_behind_a_live_front() {
    let mut state = MzPeerState {
        generation: 1,
        ..MzPeerState::default()
    };
    let line = cells(7, 24, true);
    let newest = MZ_REFERENCE_DATAGRAMS + 2;
    state.apply(applied(newest, 0, &line));
    state.apply(applied(1, 1, &line));
    assert!(
        !state.sources.contains_key(&(1, 1, 1)),
        "out-of-reach late ACK remains indexed behind newest ACK"
    );
}

#[test]
fn ledger_floor_retires_sources_without_another_ack() {
    let peer = PeerMz::default();
    peer.push(MzFact::Generation {
        generation: 1,
        previous_floor: None,
    });
    peer.push(applied(1, 0, &cells(7, 24, true)));
    assert_eq!(peer.lock().sources.len(), 1);
    peer.set_floor(Some(2));
    let state = peer.lock();
    assert!(
        state.sources.is_empty(),
        "floor changed before encoding but no retirement ran"
    );
    assert!(state.pairs.is_empty());
}

#[test]
fn idle_refusals_coalesce_before_the_next_encode() {
    let mut index = crate::display::references::ReferenceIndex::default();
    let peer = index.shared();
    for count in 1..=4096 {
        index.note_refusals(count);
    }
    let facts = peer.facts.lock().unwrap();
    assert!(facts.iter().all(|fact| matches!(fact, MzFact::Refused)));
    assert_eq!(
        facts.len(),
        1,
        "redundant refusals retain one queued fact per report while the encoder is idle"
    );
}

#[test]
fn inline_pair_sources_matches_occurrence_model() {
    for seed in [1, 0x1234_5678, u32::MAX] {
        let mut rng = seed;
        let mut actual = PairSources::default();
        let mut expected = VecDeque::new();
        for step in 0..10000 {
            let choice = random(&mut rng);
            let key = (choice % 2, choice % 3, (choice % 5) as u16);
            if choice % 4 == 0 {
                actual.remove_source(key);
                actual.remove_source(key);
                expected.retain(|&(held, _)| held != key);
            } else {
                let item = (choice >> 16) as u16;
                actual.push(key, item);
                expected.push_back((key, item));
                if expected.len() > PAIR_SOURCES {
                    expected.pop_front();
                }
            }
            assert_eq!(
                actual.iter().collect::<Vec<_>>(),
                expected.iter().copied().collect::<Vec<_>>(),
                "seed={seed} step={step}"
            );
            assert_eq!(
                actual.iter().rev().collect::<Vec<_>>(),
                expected.iter().rev().copied().collect::<Vec<_>>()
            );
            assert!(usize::from(actual.len) <= PAIR_SOURCES);
        }
    }
}

fn random(state: &mut u32) -> u32 {
    *state ^= *state << 13;
    *state ^= *state >> 17;
    *state ^= *state << 5;
    *state
}

fn cells(seed: u32, cols: usize, styled: bool) -> Arc<[CellRepr]> {
    let mut rng = 0x243f_6a88 ^ seed;
    (0..cols)
        .map(|_| {
            let value = random(&mut rng);
            let [red, green, blue, _] = value.to_le_bytes();
            CellRepr {
                codepoint: 33 + value % 90,
                fg: if styled {
                    [red, green, blue]
                } else {
                    CellRepr::BLANK.fg
                },
                ..CellRepr::BLANK
            }
        })
        .collect::<Vec<_>>()
        .into()
}

fn hashes(cells: &[CellRepr]) -> Vec<u64> {
    let mut entry = Vec::new();
    encode_full_row_entry(&mut entry, 0, cells);
    let mut items = Vec::new();
    let Some((first, mode)) = entry_items(&entry, &mut items) else {
        return Vec::new();
    };
    let row = MzRow {
        entry: &entry,
        first,
        mode,
        items: &items,
        hashes: &[],
    };
    (0..items.len())
        .map(|item| item_hash(item_bytes(&row, item).unwrap()))
        .collect()
}

fn applied(seq: u32, row: u16, cells: &Arc<[CellRepr]>) -> MzFact {
    MzFact::Applied {
        seq,
        rows: vec![(row, Arc::clone(cells))],
        coded: false,
        declared: None,
    }
}

#[derive(Default)]
struct Model {
    generation: u32,
    previous: u32,
    previous_floor: Option<u32>,
    newest: Option<u32>,
    sources: HashMap<SourceKey, Vec<u64>>,
    pairs: HashMap<u64, Vec<(SourceKey, u16)>>,
    order: VecDeque<SourceKey>,
    previous_order: VecDeque<SourceKey>,
}

impl Model {
    // The reference sweeps every list on removal, independent of the source's hashes.
    fn remove(&mut self, key: SourceKey) {
        self.sources.remove(&key);
        self.pairs.retain(|_, list| {
            list.retain(|&(held, _)| held != key);
            !list.is_empty()
        });
    }

    fn apply(&mut self, fact: &MzFact, floor: Option<u32>) {
        match fact {
            MzFact::Applied { seq, rows, .. } => {
                for (row, cells) in rows {
                    let key = (self.generation, *seq, *row);
                    self.remove(key);
                    self.order.retain(|held| *held != key);
                    self.previous_order.retain(|held| *held != key);
                    let hashes = hashes(cells);
                    for (item, pair) in hashes.windows(2).enumerate() {
                        let Ok(item) = u16::try_from(item) else { break };
                        let list = self.pairs.entry(pair_hash(pair[0], pair[1])).or_default();
                        list.push((key, item));
                        if list.len() > PAIR_SOURCES {
                            list.remove(0);
                        }
                    }
                    self.sources.insert(key, hashes);
                    self.order.push_back(key);
                    // Stable: a source lands after those of its own datagram.
                    self.order.make_contiguous().sort_by(|a, b| {
                        if older(a.1, b.1) {
                            std::cmp::Ordering::Less
                        } else if older(b.1, a.1) {
                            std::cmp::Ordering::Greater
                        } else {
                            std::cmp::Ordering::Equal
                        }
                    });
                }
                if self.newest.is_none_or(|newest| older(newest, *seq)) {
                    self.newest = Some(*seq);
                }
                // Every source out of reach or below the floor retires, wherever
                // its acknowledgement put it.
                let reach = self.newest.unwrap().wrapping_sub(MZ_REFERENCE_DATAGRAMS);
                let retired: Vec<_> = self
                    .order
                    .iter()
                    .copied()
                    .filter(|key| older(key.1, reach) || floor.is_some_and(|floor| older(key.1, floor)))
                    .collect();
                for key in retired {
                    self.order.retain(|held| *held != key);
                    self.remove(key);
                }
            }
            MzFact::Generation {
                generation,
                previous_floor,
            } => {
                while let Some(key) = self.previous_order.pop_front() {
                    self.remove(key);
                }
                self.previous = if previous_generation(*generation) == self.generation {
                    self.generation
                } else {
                    0
                };
                self.previous_floor = *previous_floor;
                self.previous_order = std::mem::take(&mut self.order);
                let discarded: Vec<_> = self
                    .previous_order
                    .iter()
                    .copied()
                    .filter(|key| {
                        self.previous == 0
                            || previous_floor.is_some_and(|floor| older(key.1, floor))
                    })
                    .collect();
                for key in discarded {
                    self.previous_order.retain(|held| *held != key);
                    self.remove(key);
                }
                self.generation = *generation;
                self.newest = None;
            }
            MzFact::Refused | MzFact::Cleared => {
                self.sources.clear();
                self.pairs.clear();
                self.order.clear();
                self.previous_order.clear();
            }
        }
    }

    fn name(
        &self,
        key: SourceKey,
        floor: Option<u32>,
        pid: u32,
        snapshot: bool,
    ) -> Option<(bool, u32)> {
        if key.0 == self.generation {
            if floor.is_some_and(|floor| older(key.1, floor)) {
                return None;
            }
            if snapshot {
                return Some((true, key.1));
            }
            let back = pid.wrapping_sub(key.1);
            (1..=MZ_REFERENCE_DATAGRAMS)
                .contains(&back)
                .then_some((false, back))
        } else {
            (key.0 == self.previous
                && self.previous != 0
                && self.previous_floor.is_none_or(|floor| !older(key.1, floor))
                && !snapshot)
                .then_some((true, key.1))
        }
    }

    fn check(&self, state: &MzPeerState) {
        assert_eq!(self.sources.len(), state.sources.len());
        assert_eq!(self.order, state.order);
        assert_eq!(self.previous_order, state.previous_order);
        let queued: HashSet<_> = state
            .order
            .iter()
            .chain(&state.previous_order)
            .copied()
            .collect();
        assert_eq!(queued.len(), state.order.len() + state.previous_order.len());
        assert_eq!(queued.len(), state.sources.len());
        for (key, source) in &state.sources {
            assert_eq!(&source.hashes, &self.sources[key]);
            assert!(queued.contains(key));
        }
        assert_eq!(self.pairs.len(), state.pairs.len());
        let mut entries = 0;
        for (&pair, list) in &state.pairs {
            assert!((1..=PAIR_SOURCES).contains(&usize::from(list.len)));
            let actual: Vec<_> = list.iter().collect();
            assert_eq!(&actual, &self.pairs[&pair]);
            entries += actual.len();
            for &(key, item) in &actual {
                let source = &state.sources[&key];
                let item = usize::from(item);
                assert_eq!(
                    pair_hash(source.hashes[item], source.hashes[item + 1]),
                    pair
                );
            }
            for (pid, snapshot) in [
                (state.newest.unwrap_or(0).wrapping_add(1), false),
                (0, false),
                (0, true),
            ] {
                let history = History {
                    state,
                    presentation_id: pid,
                    snapshot,
                };
                let mut actual = Vec::new();
                history.candidates(pair, |candidate, _| {
                    actual.push((
                        candidate.previous,
                        candidate.back,
                        candidate.row,
                        candidate.item,
                    ));
                    true
                });
                let expected: Vec<_> = self.pairs[&pair]
                    .iter()
                    .rev()
                    .filter_map(|&(key, item)| {
                        self.name(key, state.floor, pid, snapshot)
                            .map(|(previous, back)| (previous, back, key.2, item))
                    })
                    .collect();
                assert_eq!(actual, expected);
            }
        }
        assert!(
            entries
                <= state
                    .sources
                    .values()
                    .map(|s| s.hashes.len().saturating_sub(1))
                    .sum::<usize>()
        );
    }
}

#[test]
fn randomized_exact_retirement_matches_model() {
    let mut corpus: Vec<_> = (0..16)
        .map(|n| cells(n % 8, [0, 1, 2, 20, 384, 512][n as usize % 6], n % 2 == 0))
        .collect();
    corpus.push(
        (0..384)
            .map(|i| CellRepr {
                codepoint: 65 + i % 2,
                ..CellRepr::BLANK
            })
            .collect::<Vec<_>>()
            .into(),
    );
    for seed in [1, 0x1234_5678, 0xdead_beef, u32::MAX] {
        let mut rng = seed;
        let mut state = MzPeerState::default();
        let mut model = Model::default();
        let mut seq = 0u32;
        for step in 0..2500 {
            let choice = random(&mut rng) % 100;
            let fact = if choice < 88 {
                seq = seq.wrapping_add(random(&mut rng) % 48);
                let delivered = if choice.is_multiple_of(3) {
                    seq.saturating_sub(random(&mut rng) % 600)
                } else {
                    seq
                };
                let row = (random(&mut rng) % 4) as u16;
                let cells = &corpus[random(&mut rng) as usize % corpus.len()];
                let mut fact = applied(delivered, row, cells);
                if let MzFact::Applied { rows, .. } = &mut fact
                    && choice.is_multiple_of(7)
                {
                    rows.push((row, Arc::clone(&corpus[(step + 1) % corpus.len()])));
                }
                fact
            } else if choice < 95 {
                let generation =
                    state
                        .generation
                        .wrapping_add(if choice.is_multiple_of(3) { 2 } else { 1 });
                let previous_floor = (choice.is_multiple_of(2))
                    .then_some(seq.saturating_sub(random(&mut rng) % 600));
                seq = 0;
                MzFact::Generation {
                    generation,
                    previous_floor,
                }
            } else if choice < 98 {
                MzFact::Refused
            } else {
                MzFact::Cleared
            };
            if random(&mut rng).is_multiple_of(5) {
                state.floor = (!random(&mut rng).is_multiple_of(3))
                    .then_some(seq.saturating_sub(random(&mut rng) % 600));
            }
            model.apply(&fact, state.floor);
            state.apply(fact);
            model.check(&state);
        }
    }
}

#[test]
fn reused_key_retires_old_pairs_and_has_one_queue_entry() {
    let mut state = MzPeerState {
        generation: 1,
        ..MzPeerState::default()
    };
    let a = cells(1, 384, true);
    let b = cells(2, 384, true);
    state.apply(applied(0, 0, &a));
    let old_pairs: HashSet<_> = state.pairs.keys().copied().collect();
    state.apply(applied(0, 0, &b));
    assert_eq!(state.order, [(1, 0, 0)]);
    assert_eq!(state.sources.len(), 1);
    for pair in old_pairs {
        assert!(!state.pairs.contains_key(&pair));
    }
    state.apply(MzFact::Generation {
        generation: 2,
        previous_floor: None,
    });
    // Exercise replacement of a key in the frozen queue as well.
    state.add_source((1, 0, 0), &a);
    assert!(state.previous_order.is_empty());
    assert_eq!(state.order, [(1, 0, 0)]);
    state.clear_sources();
    assert!(state.sources.is_empty());
    assert!(state.pairs.is_empty());
    assert_eq!(state.spare.len(), 1);
}

#[test]
fn repeated_pair_retirement_preserves_other_sources_in_order() {
    let row: Arc<[CellRepr]> = (0..384)
        .map(|i| CellRepr {
            codepoint: 65 + i % 2,
            ..CellRepr::BLANK
        })
        .collect::<Vec<_>>()
        .into();
    let mut state = MzPeerState {
        generation: 1,
        ..MzPeerState::default()
    };
    state.add_source((1, 1, 0), &row);
    let source = &state.sources[&(1, 1, 0)];
    let repeated = pair_hash(source.hashes[0], source.hashes[1]);
    assert_eq!(usize::from(state.pairs[&repeated].len), PAIR_SOURCES);
    state.add_source((1, 2, 0), &row[..2]);
    assert_eq!(usize::from(state.pairs[&repeated].len), PAIR_SOURCES);
    state.remove_source((1, 1, 0));
    let remaining: Vec<_> = state.pairs[&repeated].iter().collect();
    assert_eq!(remaining, [((1, 2, 0), 0)]);
    state.remove_source((1, 2, 0));
    assert!(state.pairs.is_empty());
}

#[test]
fn warm_admission_and_retirement_allocate_nothing() {
    use crate::edge_tunnel::test_allocations::{begin_thread, end_thread};
    let corpus: Vec<_> = (0..768).map(|n| cells(n, 384, true)).collect();
    let mut state = MzPeerState {
        generation: 1,
        ..MzPeerState::default()
    };
    for seq in 0..4096 {
        state.add_source((1, seq, 0), &corpus[seq as usize % corpus.len()]);
        state.newest = Some(seq);
        state.retire();
    }
    begin_thread();
    for seq in 4096..8192 {
        state.add_source((1, seq, 0), &corpus[seq as usize % corpus.len()]);
        state.newest = Some(seq);
        state.retire();
    }
    let tally = end_thread();
    assert_eq!(tally.allocations, 0, "{tally:?}");
    assert_eq!(tally.allocated_bytes, 0, "{tally:?}");

    // Clears retain at most MAX_TERMINAL_ROWS buffers, so use a working set below it.
    state.clear_sources();
    for seq in 0..64 {
        state.add_source((1, seq, 0), &corpus[seq as usize]);
    }
    begin_thread();
    for seq in 0..64 {
        state.add_source((1, seq, 0), &corpus[seq as usize]);
    }
    state.apply(MzFact::Generation {
        generation: 2,
        previous_floor: Some(32),
    });
    state.apply(MzFact::Generation {
        generation: 3,
        previous_floor: None,
    });
    for seq in 0..64 {
        state.add_source((3, seq, 0), &corpus[seq as usize]);
    }
    state.apply(MzFact::Refused);
    for seq in 0..64 {
        state.add_source((3, seq, 0), &corpus[seq as usize]);
    }
    state.apply(MzFact::Cleared);
    let tally = end_thread();
    assert_eq!(tally.allocations, 0, "{tally:?}");
    assert_eq!(tally.allocated_bytes, 0, "{tally:?}");
}

#[test]
#[ignore = "fixed-fact source-index benchmark"]
fn fixed_fact_source_index_benchmark() {
    let corpus: Vec<_> = (0..768).map(|n| cells(n, 384, true)).collect();
    let mut samples = Vec::new();
    let mut counts = (0, 0, 0);
    for sample in 0..14 {
        let peer = PeerMz::default();
        {
            let mut state = peer.state.lock().unwrap();
            state.generation = 1;
            for (n, cells) in corpus[..512].iter().enumerate() {
                state.add_source((1, u32::try_from(n).unwrap() + 1, 0), cells);
            }
            state.newest = Some(512);
        }
        for (n, cells) in corpus[512..].iter().enumerate() {
            peer.push(applied(513 + u32::try_from(n).unwrap(), 0, cells));
        }
        let now = std::time::Instant::now();
        let state = peer.lock();
        let ns = u64::try_from(now.elapsed().as_nanos()).unwrap();
        if sample >= 2 {
            samples.push(ns);
        }
        counts = (
            state.sources.len(),
            state.pairs.len(),
            state.pairs.capacity(),
        );
    }
    println!(
        "{}",
        serde_json::json!({"experiment":"fixed-fact-source-index", "samples_ns":samples, "retained_sources":counts.0, "pair_keys":counts.1, "pair_capacity":counts.2})
    );
}
