//! Random outages, and every seed a sweep has found failing.
//!
//! Each seed derives one outage: which way the link is cut, for how long (1 to
//! 90 s), and whether the recovery is then cut at a packet boundary as well.
//! Every recovery invariant must hold (`scenario::assert_recovered`).
//!
//! `bun run test:sim:sweep N` runs [`sweep`] over N seeds from a random start,
//! and the runner appends each failing seed to `tools/sim/regressions.json`.
//! Every `test:sim` replays them all
//! ([`the_recorded_regressions_still_recover`]), so a seed a sweep found fails
//! the suite until its fix lands, and guards that fix from then on.

use std::panic::AssertUnwindSafe;
use std::time::Duration;

use merkur_sim::scenario::{self, ATTEMPT_WATCHDOG, AtRepair, Direction, assert_recovered, report};
use serde::{Deserialize, Serialize};

/// One seed's outage.
#[derive(Clone, Copy, Debug)]
struct Outage {
    direction: Direction,
    partition: Duration,
    at_repair: AtRepair,
    /// How long an attempt in flight can be held silent past the heal: one the
    /// outage caught, until its watchdog, and one the cut at repair catches.
    blackout: Duration,
}

impl Outage {
    fn of(seed: u64) -> Self {
        let mut state = seed;
        let mut next = || splitmix64(&mut state);
        let direction = match next() % 3 {
            0 => Direction::Both,
            1 => Direction::Uplink,
            _ => Direction::Downlink,
        };
        let partition = Duration::from_secs(1 + next() % 90);
        let (at_repair, hold) = if next() % 2 == 0 {
            (AtRepair::Nothing, Duration::ZERO)
        } else {
            let hold = Duration::from_secs(1 + next() % 5);
            let after = next() % 40;
            (AtRepair::Cut { after, hold }, hold)
        };
        let blackout = partition.min(ATTEMPT_WATCHDOG) + hold;
        Self {
            direction,
            partition,
            at_repair,
            blackout,
        }
    }
}

fn splitmix64(state: &mut u64) -> u64 {
    *state = state.wrapping_add(0x9e37_79b9_7f4a_7c15);
    let mut z = *state;
    z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    z ^ (z >> 31)
}

/// Runs `seed`'s outage against every invariant, and says how it broke one.
fn check(seed: u64) -> Result<(), String> {
    let outage = Outage::of(seed);
    std::panic::catch_unwind(AssertUnwindSafe(|| {
        let (summary, recovered) =
            scenario::outage_in(seed, outage.direction, outage.partition, outage.at_repair);
        report(&format!("seed {seed}, {outage:?}"), &summary, &recovered);
        assert_recovered(&recovered, outage.blackout);
    }))
    .map_err(|panic| {
        let message = panic
            .downcast_ref::<String>()
            .map(String::as_str)
            .or_else(|| panic.downcast_ref::<&str>().copied())
            .unwrap_or("a non-string panic");
        format!("{outage:?}: {message}")
    })
}

#[derive(Serialize, Deserialize)]
struct Failure {
    seed: u64,
    failure: String,
}

#[test]
#[ignore = "run by `bun run test:sim:sweep`"]
fn sweep() {
    let range = std::env::var("MERKUR_SIM_SWEEP").expect("MERKUR_SIM_SWEEP=<start>,<count>");
    let (start, count) = range.split_once(',').expect("<start>,<count>");
    let start: u64 = start.parse().expect("a start seed");
    let count: u64 = count.parse().expect("a seed count");
    let failures: Vec<Failure> = (start..start + count)
        .filter_map(|seed| check(seed).err().map(|failure| Failure { seed, failure }))
        .collect();
    let out = std::env::var("MERKUR_SIM_SWEEP_FAILURES").expect("MERKUR_SIM_SWEEP_FAILURES");
    std::fs::write(
        out,
        serde_json::to_string(&failures).expect("failures serialize"),
    )
    .expect("the failures file is writable");
    eprintln!(
        "swept seeds {start}..{}: {} failed",
        start + count,
        failures.len()
    );
}

#[test]
fn the_recorded_regressions_still_recover() {
    let regressions: Vec<Failure> =
        serde_json::from_str(include_str!("../regressions.json")).expect("regressions.json parses");
    let failed: Vec<_> = regressions
        .iter()
        .filter_map(|regression| {
            check(regression.seed)
                .err()
                .map(|failure| (regression.seed, failure))
        })
        .collect();
    assert!(failed.is_empty(), "{failed:#?}");
}
