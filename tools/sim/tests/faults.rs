//! A carrier killed at every packet boundary of a first connection and of a
//! recovery.
//!
//! A first connection dials the three lanes and authenticates. After an outage
//! the client recovers by a rebind (inside the window) or a fresh issuance
//! (past it). For every k from 0 to the datagrams the exchange sends unfaulted,
//! the client's datagrams after its k-th are lost for 3 s, so the exchange dies
//! at each of its boundaries in turn: before a dial, mid-handshake, between
//! authentication flights, after the final flight. Every one must still connect
//! or recover with every recovery invariant intact.

use std::time::Duration;

use merkur_sim::Summary;
use merkur_sim::scenario::{self, AtRepair, Recovered, assert_recovered};

const HOLD: Duration = Duration::from_secs(3);

/// Kills the exchange `run` drives at every packet boundary.
fn sweep(name: &str, run: impl Fn(AtRepair) -> (Summary, Recovered)) {
    let (_, unfaulted) = run(AtRepair::Count);
    assert_recovered(&unfaulted, Duration::ZERO);
    let boundaries = unfaulted.counted;
    assert!(
        boundaries > 0,
        "the exchange sends datagrams: {unfaulted:?}"
    );
    let runs: Vec<_> = (0..=boundaries)
        .map(|after| {
            let (_, recovered) = run(AtRepair::Cut { after, hold: HOLD });
            (after, recovered)
        })
        .collect();
    eprintln!("{name}: {boundaries} boundaries swept");
    for (after, recovered) in &runs {
        eprintln!(
            "  cut after {after:>3}: healed in {:?}, issued {}, statuses {:?}",
            recovered.after_heal, recovered.issued, recovered.statuses
        );
    }
    for (after, recovered) in &runs {
        eprintln!("checking the cut after datagram {after}");
        assert_recovered(recovered, HOLD);
    }
}

#[test]
fn a_first_connection_killed_at_any_packet_still_connects() {
    sweep("first connection", |at_start| {
        scenario::first_connect(33, at_start)
    });
}

#[test]
fn a_rebind_killed_at_any_packet_still_recovers() {
    let partition = Duration::from_secs(10);
    sweep("10 s outage", |at_repair| {
        scenario::outage(31, partition, at_repair)
    });
}

#[test]
fn a_fresh_issuance_killed_at_any_packet_still_recovers() {
    let partition = Duration::from_secs(75);
    sweep("75 s outage", |at_repair| {
        scenario::outage(32, partition, at_repair)
    });
}
