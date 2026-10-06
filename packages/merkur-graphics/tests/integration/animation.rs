use merkur_graphics::animation::{Entry, MAX_FRAMES, Manifest, Mode, Playback, Sample};
use merkur_graphics::budget::{Budget, Lease, Usage};

fn budget() -> Budget {
    Budget::new(Usage {
        bytes: 2 * 1024 * 1024,
        objects: 32,
    })
}
/// Exactly the storage a `count`-frame manifest takes, admitted from `budget`.
fn admitted(budget: &Budget, count: usize) -> Lease {
    budget.reserve(Manifest::charge(count).unwrap()).unwrap()
}
fn playback(mode: Mode) -> Playback {
    Playback {
        mode,
        anchor_us: 100_000,
        frame: 0,
        loops: 0,
        completed: 0,
        elapsed_us: 0,
    }
}
fn entries(gaps: &[u32]) -> Vec<Entry> {
    gaps.iter()
        .enumerate()
        .map(|(i, gap)| Entry {
            root: [i as u8; 32],
            gap_ms: *gap,
        })
        .collect()
}

#[test]
fn elapsed_selection_skips_gapless_frames_and_seeks_without_tick_history() {
    let state = playback(Mode::Loop);
    let manifest = Manifest::new(
        10,
        20,
        1,
        state,
        &entries(&[0, 10, 20, 0]),
        &mut admitted(&budget(), 4),
    )
    .unwrap();
    for (elapsed, frame, completed, offset, next) in [
        (0, 1, 0, 0, 10_000),
        (9_999, 1, 0, 9_999, 10_000),
        (10_000, 2, 0, 0, 30_000),
        (30_000, 1, 1, 0, 40_000),
        (3_000_010_001, 2, 100_000, 1, 3_000_030_000),
    ] {
        assert_eq!(
            manifest.sample(state.anchor_us + elapsed),
            Sample {
                frame,
                completed,
                elapsed_us: offset,
                next_us: Some(state.anchor_us + next),
                ended: false
            }
        );
    }
    assert_eq!(manifest.sample(0), manifest.sample(state.anchor_us));
}

fn slow_sample(state: Playback, gaps: &[u32], now: u64) -> Sample {
    if state.mode == Mode::Stopped || gaps.iter().all(|gap| *gap == 0) {
        return Sample {
            frame: state.frame,
            completed: state.completed,
            elapsed_us: state.elapsed_us,
            next_us: None,
            ended: false,
        };
    }
    let mut frame = state.frame as usize;
    let mut elapsed = now.saturating_sub(state.anchor_us) + state.elapsed_us;
    let mut completed = state.completed;
    loop {
        let gap = u64::from(gaps[frame]) * 1000;
        if elapsed < gap {
            return Sample {
                frame: frame as u32,
                completed,
                elapsed_us: elapsed,
                next_us: Some(now.max(state.anchor_us) + gap - elapsed),
                ended: false,
            };
        }
        elapsed -= gap;
        frame += 1;
        if frame == gaps.len() {
            if state.mode == Mode::Loop {
                completed += 1;
            }
            if state.mode == Mode::Loading
                || (state.loops != 0 && completed == u64::from(state.loops))
            {
                let last = gaps.iter().rposition(|gap| *gap != 0).unwrap();
                return Sample {
                    frame: last as u32,
                    completed,
                    elapsed_us: u64::from(gaps[last]) * 1000,
                    next_us: None,
                    ended: true,
                };
            }
            frame = 0;
        }
    }
}

#[test]
fn binary_seek_matches_independent_frame_walk_for_every_small_timeline() {
    let budget = budget();
    for mut code in 0..81 {
        let mut gaps = [0; 4];
        for gap in &mut gaps {
            *gap = code % 3;
            code /= 3;
        }
        for mode in [Mode::Stopped, Mode::Loading, Mode::Loop] {
            for frame in 0..4 {
                for loops in 0..=3 {
                    let mut state = playback(mode);
                    state.frame = frame;
                    state.loops = loops;
                    state.elapsed_us = u64::from(gaps[frame as usize]) * 500;
                    let manifest =
                        Manifest::new(1, 1, 1, state, &entries(&gaps), &mut admitted(&budget, 4))
                            .unwrap();
                    for elapsed in [0, 1, 499, 999, 1000, 1001, 4000, 8000, 27_000] {
                        let now = state.anchor_us + elapsed;
                        assert_eq!(
                            manifest.sample(now),
                            slow_sample(state, &gaps, now),
                            "{state:?}, {gaps:?}, {elapsed}"
                        );
                    }
                }
            }
        }
    }
    assert_eq!(
        budget.used(),
        Some(Usage {
            bytes: 0,
            objects: 0
        })
    );
}

#[test]
fn loading_tail_and_finite_loops_have_no_playback_deadline() {
    for mode in [Mode::Loading, Mode::Loop] {
        let mut state = playback(mode);
        state.loops = 2;
        let manifest = Manifest::new(
            1,
            1,
            1,
            state,
            &entries(&[0, 10, 20, 0]),
            &mut admitted(&budget(), 4),
        )
        .unwrap();
        let sample = manifest.sample(u64::MAX);
        assert_eq!(sample.frame, 2);
        assert_eq!(sample.next_us, None);
        assert!(sample.ended);
        assert_eq!(sample.completed, if mode == Mode::Loop { 2 } else { 0 });
    }
    let mut state = playback(Mode::Loop);
    state.anchor_us = u64::MAX;
    state.completed = u64::MAX;
    let manifest = Manifest::new(
        1,
        1,
        1,
        state,
        &entries(&[1, 1]),
        &mut admitted(&budget(), 2),
    )
    .unwrap();
    assert_eq!(manifest.sample(u64::MAX).next_us, None);
    state.anchor_us = 0;
    let manifest = Manifest::new(
        1,
        1,
        1,
        state,
        &entries(&[1, 1]),
        &mut admitted(&budget(), 2),
    )
    .unwrap();
    assert_eq!(manifest.sample(u64::MAX).completed, u64::MAX);
}

#[test]
fn manifest_is_canonical_bounded_and_retains_exact_admission() {
    let budget = budget();
    let frames = entries(&[0, 40, 25]);
    // Construction splits exactly its charge from the admitted batch, and only
    // once the batch holds all of it.
    let charge = Manifest::charge(frames.len()).unwrap();
    let mut short = budget
        .reserve(Usage {
            bytes: charge.bytes - 1,
            objects: charge.objects,
        })
        .unwrap();
    assert!(Manifest::new(2, 3, 7, playback(Mode::Loop), &frames, &mut short).is_none());
    assert_eq!(short.charge().bytes, charge.bytes - 1);
    drop(short);
    let mut batch = admitted(&budget, frames.len());
    let manifest = Manifest::new(2, 3, 7, playback(Mode::Loop), &frames, &mut batch).unwrap();
    assert_eq!(
        batch.charge(),
        Usage {
            bytes: 0,
            objects: 0
        }
    );
    assert_eq!(
        manifest.root(),
        [
            0xbf, 0x7b, 0xe3, 0xae, 0x14, 0x2f, 0x2c, 0x0a, 0x05, 0x21, 0x01, 0x2e, 0xc7, 0x8f,
            0x50, 0xc1, 0x5c, 0xfd, 0x9a, 0xff, 0xff, 0x98, 0xe8, 0x09, 0x31, 0x6d, 0x1d, 0x9d,
            0x01, 0xad, 0x5b, 0x03
        ]
    );
    assert_eq!(budget.used(), Manifest::charge(frames.len()));
    assert_eq!(
        (manifest.width(), manifest.height(), manifest.revision()),
        (2, 3, 7)
    );
    let decoded = Manifest::decode(manifest.bytes(), &budget).unwrap();
    assert_eq!(decoded.root(), manifest.root());
    assert_eq!(decoded.bytes(), manifest.bytes());
    assert_eq!(decoded.entries().collect::<Vec<_>>(), frames);
    assert_eq!(decoded.entry(3), None);
    assert_ne!(manifest.root(), *blake3::hash(manifest.bytes()).as_bytes());
    for end in 0..manifest.bytes().len() {
        assert!(Manifest::decode(&manifest.bytes()[..end], &budget).is_none());
    }
    for (offset, value) in [
        (3, 0),
        (11, 0),
        (15, 0),
        (23, 0),
        (35, 3),
        (56, 1),
        (64 + 36 + 32, 128),
    ] {
        let mut bytes = manifest.bytes().to_vec();
        bytes[offset] = value;
        assert!(
            Manifest::decode(&bytes, &budget).is_none(),
            "offset {offset}"
        );
    }
    let mut trailing = manifest.bytes().to_vec();
    trailing.push(0);
    assert!(Manifest::decode(&trailing, &budget).is_none());
    assert!(Manifest::charge(0).is_none());
    assert!(Manifest::charge(usize::MAX).is_none());
    assert!(Manifest::charge(MAX_FRAMES + 1).is_none());
    let refused = Budget::new(Usage {
        bytes: 0,
        objects: 0,
    });
    assert!(Manifest::decode(manifest.bytes(), &refused).is_none());
    drop((decoded, manifest));
    assert_eq!(
        budget.used(),
        Some(Usage {
            bytes: 0,
            objects: 0
        })
    );
}
