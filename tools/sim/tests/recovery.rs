//! Carrier recovery across an outage between the client and the edge.
//!
//! Inside the rebind window (`SessionPolicy::REBIND_WINDOW_MS`, 60 s) the
//! client rebinds in place on its own lineage: the daemon parks nothing and
//! redials the edge for the gap. Past it the daemon has parked the peer, the
//! edge answers the client's candidate that the counterpart is absent, and the
//! client must issue afresh, once: the 2026-09-22 loop retried the rebind
//! forever.

use std::time::Duration;

use merkur_sim::Summary;
use merkur_sim::scenario::{self, AtRepair, Recovered, assert_recovered, report};

/// The outage, once to observe and once more to prove the seed replays it.
fn replayed_outage(seed: u64, partition: Duration) -> (Summary, Recovered) {
    let (summary, recovered) = scenario::outage(seed, partition, AtRepair::Nothing);
    assert_eq!(
        scenario::outage(seed, partition, AtRepair::Nothing).0,
        summary,
        "seed {seed} replays"
    );
    (summary, recovered)
}

#[test]
fn a_short_outage_rebinds_on_its_own_lineage() {
    let (summary, recovered) = replayed_outage(21, Duration::from_secs(10));
    report("10 s outage", &summary, &recovered);
    assert_recovered(&recovered, Duration::ZERO);
    assert_eq!(recovered.issued, 1, "a rebind needs no issuance");
}

#[test]
fn an_outage_past_the_heartbeat_park_still_rebinds_inside_the_window() {
    let (summary, recovered) = replayed_outage(22, Duration::from_secs(45));
    report("45 s outage", &summary, &recovered);
    assert_recovered(&recovered, Duration::ZERO);
    assert_eq!(recovered.issued, 1, "a rebind needs no issuance");
}

#[test]
fn an_outage_past_the_rebind_window_issues_once_and_recovers() {
    let (summary, recovered) = replayed_outage(23, Duration::from_secs(75));
    report("75 s outage", &summary, &recovered);
    assert_recovered(&recovered, Duration::ZERO);
    assert_eq!(recovered.issued, 2, "exactly one fresh issuance");
}
