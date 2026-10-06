//! Renewal against the in-process daemon lineage, which verifies as
//! `session::renewal_flow` does.

use merkur_wire::signaling::DaemonSignal;

use super::*;
use crate::auth::PendingAuth;
use crate::rebind::RebindFlight;
use crate::test_support::{
    BROWSER_NODE_ID, Counter, DaemonLineage, account, answer, delegate, issuance,
    prepare_renewal, sign,
};

const EXPIRES_AT_MS: u64 = 1_800_000_300_000;

fn genesis(entropy: &mut Counter) -> (RebindKeeper, DaemonLineage, Delegation) {
    let (delegation, daemon, binding) = account();
    let issued = issuance(&daemon, binding);
    let (bound, flight) = sign(
        PendingAuth::new(entropy)
            .bind(&issued, &delegation, BROWSER_NODE_ID)
            .unwrap(),
        &delegation,
    )
    .unwrap();
    let (ready, _, lineage) = answer(&daemon, &flight, delegate().public_key());
    (bound.complete(&ready).unwrap().rebind, lineage, delegation)
}

fn names(daemon: &DaemonLineage) -> Lineage<'_> {
    Lineage {
        session_id: &daemon.session_id,
        browser_node_id: BROWSER_NODE_ID,
        daemon_id: daemon.daemon_id,
    }
}

fn capability() -> RenewalCapability {
    RenewalCapability {
        session_token: "renewal-capability".into(),
        session_token_expires_in_ms: 300_000,
        edge_cert_hashes: None,
    }
}

const EDGE_URL: &str = "https://edge.example:4433";

#[test]
fn a_renewal_the_daemon_verifies_opens_an_epoch_at_the_current_generation() {
    let mut entropy = Counter(0);
    let (keeper, mut daemon, delegation) = genesis(&mut entropy);
    let (mut renewal, request) =
        Renewal::new(&keeper, names(&daemon), "delegation-1", EDGE_URL, &mut entropy).unwrap();
    assert_eq!(request.session_id, daemon.session_id);
    assert_eq!(request.delegation_id, "delegation-1");
    assert_eq!(request.edge_wt_url, EDGE_URL);
    assert_eq!(request.commitment.len(), 86, "a 64-byte commitment");
    assert!(
        renewal.flight(&keeper, names(&daemon)).is_none(),
        "nothing leaves before the capability is signed over"
    );

    assert!(prepare_renewal(&mut renewal, capability(), &delegation));
    let flight = renewal.flight(&keeper, names(&daemon)).unwrap();
    assert!(flight.is_valid(), "the dataplane admits it");
    let verdict = daemon.renew(&flight, delegate().public_key(), EXPIRES_AT_MS);
    assert_eq!(
        renewal.answer(&keeper, &verdict),
        Some(Verdict {
            accepted: true,
            generation_base: 0,
            lifetime_ms: 300_000,
        })
    );

    // A verdict whose MAC does not cover these fields changes nothing.
    let DaemonSignal::SessionRenewed {
        client_nonce, mac, ..
    } = verdict
    else {
        unreachable!()
    };
    let forged = DaemonSignal::SessionRenewed {
        client_nonce,
        rebind_counter: 0,
        accepted: true,
        expires_at_ms: EXPIRES_AT_MS + 1,
        generation_base: 0,
        mac,
    };
    assert_eq!(renewal.answer(&keeper, &forged), None);
}

#[test]
fn a_lost_answer_is_retried_under_the_generation_a_key_cut_left() {
    let mut entropy = Counter(0);
    let (mut keeper, mut daemon, delegation) = genesis(&mut entropy);
    let (mut renewal, _) =
        Renewal::new(&keeper, names(&daemon), "delegation-1", EDGE_URL, &mut entropy).unwrap();
    assert!(prepare_renewal(&mut renewal, capability(), &delegation));
    let lost = renewal.flight(&keeper, names(&daemon)).unwrap();

    // A rebind commits before the answer arrives.
    let (mut flight, request) =
        RebindFlight::new(&keeper, names(&daemon), &[0x5a; 32], &mut entropy).unwrap();
    let (rebound, in_flight) = daemon.answer(&request, 1);
    let successor = flight.complete(&mut keeper, &rebound).unwrap().unwrap();
    daemon.commit(in_flight, &successor.final_flight);
    keeper.promote().unwrap();

    let retried = renewal.flight(&keeper, names(&daemon)).unwrap();
    let (ClientSignal::SessionRenew(lost), ClientSignal::SessionRenew(retried)) = (&lost, &retried)
    else {
        unreachable!()
    };
    assert_eq!(lost.rebind_counter, 0);
    assert_eq!(retried.rebind_counter, 1);
    assert_eq!(lost.client_nonce, retried.client_nonce, "the same intent");
    let verdict = daemon.renew(
        &ClientSignal::SessionRenew(retried.clone()),
        delegate().public_key(),
        EXPIRES_AT_MS,
    );
    assert_eq!(
        renewal
            .answer(&keeper, &verdict)
            .map(|verdict| verdict.generation_base),
        Some(1)
    );
}
