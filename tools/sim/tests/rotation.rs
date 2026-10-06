//! The edge rotates its certificate in place while a session lives, and the
//! session's carrier is lost afterwards.
//!
//! The edge publishes the certificate it will serve next alongside the one it
//! serves, and a rotation serves that published one. A session issued since
//! the last rotation pinned both, so it rebinds across one rotation without
//! the server. Across two, its pins name nothing the edge serves: the
//! candidate's dial fails, the client asks the server through a renewal, whose
//! answer carries the hashes the edge serves now, and the lineage rebinds. The
//! daemon's tunnels ride through every rotation on their established
//! connections. Neither needs a fresh issuance.

use std::time::Duration;

use merkur_sim::scenario::{self, assert_recovered, report};

/// Past the incumbent's 30 s idle timeout, inside the daemon's 60 s rebind
/// window: the carrier is lost, and only a candidate can rebind the lineage.
const OUTAGE: Duration = Duration::from_secs(45);

#[test]
fn a_session_rebinds_across_a_rotation_on_the_pins_its_issuance_carried() {
    let (summary, recovered) = scenario::outage_after_rotations(31, 1, OUTAGE);
    report("one rotation, then a 45 s outage", &summary, &recovered);
    assert_recovered(&recovered, Duration::ZERO);
    assert_eq!(recovered.issued, 1, "a rebind needs no issuance");
}

#[test]
fn a_session_its_edge_rotated_past_asks_the_server_and_rebinds() {
    let (summary, recovered) = scenario::outage_after_rotations(32, 2, OUTAGE);
    report("two rotations, then a 45 s outage", &summary, &recovered);
    assert_recovered(&recovered, Duration::ZERO);
    assert_eq!(recovered.issued, 1, "the lineage rebinds once it pins anew");
    assert!(
        recovered.renewed >= 1,
        "a renewal carried the hashes: {recovered:?}"
    );
}
