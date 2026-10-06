//! The rebind flights against the in-process daemon lineage, which answers as
//! `session::rebind_flow` and `session::reconcile_flow` do.

use merkur_e2e::NoiseTransport;
use merkur_wire::signaling::{ClientSignal, DaemonSignal};

use super::*;
use crate::auth::PendingAuth;
use crate::test_support::{
    BROWSER_NODE_ID, Counter, DaemonLineage, account, answer, delegate, issuance, sign,
};

const NONCE: [u8; 32] = [0x5a; 32];

/// A genesis session: the client's keeper and the daemon's lineage.
fn genesis(entropy: &mut Counter) -> (RebindKeeper, DaemonLineage) {
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
    (bound.complete(&ready).unwrap().rebind, lineage)
}

fn names(daemon: &DaemonLineage) -> Lineage<'_> {
    Lineage {
        session_id: &daemon.session_id,
        browser_node_id: BROWSER_NODE_ID,
        daemon_id: daemon.daemon_id,
    }
}

fn talk(client: &mut NoiseTransport, daemon: &mut NoiseTransport) {
    let lane = merkur_e2e::lane_for_channel(merkur_wire::protocol::CHANNEL_PTY).unwrap();
    let sealed = client.seal_datagram(lane, b"keystroke").unwrap();
    assert_eq!(daemon.open_datagram(lane, &sealed).unwrap(), b"keystroke");
    let echo = daemon.seal_stream(lane, b"echo").unwrap();
    assert_eq!(client.open_stream(lane, &echo).unwrap(), b"echo");
}

#[test]
fn a_rebind_commits_only_on_the_successor_acknowledgement() {
    let mut entropy = Counter(0);
    let (mut keeper, mut daemon) = genesis(&mut entropy);
    let (mut flight, request) =
        RebindFlight::new(&keeper, names(&daemon), &NONCE, &mut entropy).unwrap();
    assert!(request.is_valid(), "the dataplane admits it");
    let ClientSignal::SessionRebind(sent) = &request else {
        unreachable!()
    };
    assert_eq!(sent.client_nonce, encode(&NONCE), "the routing nonce");
    assert_eq!(sent.rebind_counter, 0);

    let (rebound, in_flight) = daemon.answer(&request, 9);
    let mut successor = flight.complete(&mut keeper, &rebound).unwrap().unwrap();
    assert_eq!(successor.next_expected_input_seq, 9);
    assert!(
        keeper.has_pending(),
        "tentative until the daemon proves commit"
    );
    assert_eq!(keeper.counter(), 0);

    let mut daemon_transport = daemon.commit(in_flight, &successor.final_flight);
    talk(&mut successor.transport, &mut daemon_transport);

    let reconcile = Reconcile::new(&keeper, names(&daemon), &mut entropy).unwrap();
    let acknowledgement = daemon.reconcile(&reconcile.flight);
    assert_eq!(reconcile.answer(&mut keeper, &acknowledgement), Some(true));
    assert!(!keeper.has_pending());
    assert_eq!(keeper.counter(), 1);

    // The next generation rebinds from the promoted secret.
    let (_, request) = RebindFlight::new(&keeper, names(&daemon), &NONCE, &mut entropy).unwrap();
    daemon.answer(&request, 9);
}

#[test]
fn a_spoofed_answer_changes_nothing_and_the_real_one_still_completes() {
    let mut entropy = Counter(0);
    let (mut keeper, daemon) = genesis(&mut entropy);
    let (mut flight, request) =
        RebindFlight::new(&keeper, names(&daemon), &NONCE, &mut entropy).unwrap();
    let (rebound, _) = daemon.answer(&request, 9);
    let DaemonSignal::SessionRebound {
        daemon_nonce,
        ciphertext,
        mac,
        noise_msg2,
        ..
    } = rebound.clone()
    else {
        unreachable!()
    };
    // Another input watermark than the one the daemon MACed.
    let forged = DaemonSignal::SessionRebound {
        daemon_nonce,
        ciphertext,
        next_expected_input_seq: 10,
        mac,
        noise_msg2,
    };
    assert!(flight.complete(&mut keeper, &forged).unwrap().is_none());
    assert!(!keeper.has_pending());
    assert!(flight.complete(&mut keeper, &rebound).unwrap().is_some());
}

#[test]
fn only_an_authenticated_refusal_of_this_request_is_read() {
    let mut entropy = Counter(0);
    let (keeper, daemon) = genesis(&mut entropy);
    let (flight, request) =
        RebindFlight::new(&keeper, names(&daemon), &NONCE, &mut entropy).unwrap();
    let (_, in_flight) = daemon.answer(&request, 9);
    let refused = daemon.refuse(&in_flight, "lineage_expired");
    assert_eq!(flight.refusal(&keeper, &refused), Some("lineage_expired"));

    let DaemonSignal::SessionRebindRefused { mac, .. } = refused else {
        unreachable!()
    };
    let relabelled = DaemonSignal::SessionRebindRefused {
        reason: "policy".into(),
        mac,
    };
    assert_eq!(flight.refusal(&keeper, &relabelled), None);

    // A refusal of another request under the same lineage is not this one's.
    let (other, other_request) =
        RebindFlight::new(&keeper, names(&daemon), &[0x5b; 32], &mut entropy).unwrap();
    let (_, other_in_flight) = daemon.answer(&other_request, 9);
    let refused_other = daemon.refuse(&other_in_flight, "policy");
    assert_eq!(flight.refusal(&keeper, &refused_other), None);
    assert_eq!(other.refusal(&keeper, &refused_other), Some("policy"));
}

#[test]
fn a_lost_final_is_reconciled_back_to_the_current_generation() {
    let mut entropy = Counter(0);
    let (mut keeper, daemon) = genesis(&mut entropy);
    let (mut flight, request) =
        RebindFlight::new(&keeper, names(&daemon), &NONCE, &mut entropy).unwrap();
    let (rebound, _) = daemon.answer(&request, 9);
    flight.complete(&mut keeper, &rebound).unwrap().unwrap();
    // The final never arrived: the daemon still holds generation 0.
    let reconcile = Reconcile::new(&keeper, names(&daemon), &mut entropy).unwrap();
    let answer = daemon.reconcile(&reconcile.flight);
    let DaemonSignal::SessionRebindReconciled {
        client_nonce, mac, ..
    } = answer.clone()
    else {
        unreachable!()
    };
    // A replay under a claimed successor generation does not verify.
    let lie = DaemonSignal::SessionRebindReconciled {
        client_nonce,
        rebind_counter: 1,
        mac,
    };
    assert_eq!(reconcile.answer(&mut keeper, &lie), None);
    assert_eq!(reconcile.answer(&mut keeper, &answer), Some(false));
    assert!(!keeper.has_pending());
    assert_eq!(keeper.counter(), 0);
    assert!(Reconcile::new(&keeper, names(&daemon), &mut entropy).is_none());
}
