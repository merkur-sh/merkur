//! Bounded delivery-order exploration against the production client state machine.
//! The in-process daemon fixture creates genuine Noise, ML-KEM and MACed answers;
//! these tests do not model cryptography as a boolean acceptance oracle.

use merkur_e2e::RebindKeeper;
use merkur_wire::signaling::DaemonSignal;

use super::{Lineage, RebindFlight, Reconcile};
use crate::auth::{Delegation, PendingAuth};
use crate::issuance::RenewalCapability;
use crate::renewal::Renewal;
use crate::test_support::{
    BROWSER_NODE_ID, Counter, DaemonLineage, account, answer, delegate, issuance,
    prepare_renewal, sign,
};

fn start_lineage(entropy: &mut Counter) -> (RebindKeeper, DaemonLineage, Delegation) {
    let (delegation, daemon, binding) = account();
    let (bound, auth) = sign(
        PendingAuth::new(entropy)
            .bind(&issuance(&daemon, binding), &delegation, BROWSER_NODE_ID)
            .unwrap(),
        &delegation,
    )
    .unwrap();
    let (ready, _, lineage) = answer(&daemon, &auth, delegate().public_key());
    (bound.complete(&ready).unwrap().rebind, lineage, delegation)
}

fn names(daemon: &DaemonLineage) -> Lineage<'_> {
    Lineage {
        session_id: &daemon.session_id,
        browser_node_id: BROWSER_NODE_ID,
        daemon_id: daemon.daemon_id,
    }
}

#[test]
fn a_delayed_incumbent_reconciliation_cannot_cancel_a_different_attempt() {
    let mut entropy = Counter(0);
    let (mut keeper, daemon, _) = start_lineage(&mut entropy);
    let (mut first, request) =
        RebindFlight::new(&keeper, names(&daemon), &[1; 32], &mut entropy).unwrap();
    let (ready, _) = daemon.answer(&request, 1);
    first.complete(&mut keeper, &ready).unwrap().unwrap();
    let old = Reconcile::new(&keeper, names(&daemon), &mut entropy).unwrap();
    let delayed_answer = daemon.reconcile(&old.flight);

    // The first attempt was abandoned before its answer arrived. A different
    // valid attempt now holds the same predecessor generation and secret.
    keeper.abandon();
    let (mut second, request) =
        RebindFlight::new(&keeper, names(&daemon), &[2; 32], &mut entropy).unwrap();
    let (ready, _) = daemon.answer(&request, 1);
    second.complete(&mut keeper, &ready).unwrap().unwrap();
    let pending = *keeper.pending_attempt_digest().unwrap();

    assert_eq!(old.answer(&mut keeper, &delayed_answer), None);
    assert_eq!(keeper.pending_attempt_digest(), Some(&pending));
    assert_eq!(keeper.counter(), 0);
    let current = Reconcile::new(&keeper, names(&daemon), &mut entropy).unwrap();
    let answer = daemon.reconcile(&current.flight);
    assert_eq!(current.answer(&mut keeper, &answer), Some(false));
}

#[derive(Clone, Copy, Debug)]
enum Event {
    DuplicateReady,
    ForgedReconciliation,
    RenewalAnswer,
    ReconciliationAnswer,
}

fn explore_order(order: [Event; 4], commit_final: bool) {
    let mut entropy = Counter(0);
    let (mut keeper, mut daemon, delegation) = start_lineage(&mut entropy);
    let (mut renewal, _) =
        Renewal::new(
            &keeper,
            names(&daemon),
            "delegation-1",
            "https://edge.example:4433",
            &mut entropy,
        )
        .unwrap();
    assert!(prepare_renewal(
        &mut renewal,
        RenewalCapability {
            session_token: "renewal-capability".into(),
            session_token_expires_in_ms: 300_000,
            edge_cert_hashes: None,
        },
        &delegation,
    ));
    let sent = renewal.flight(&keeper, names(&daemon)).unwrap();
    let renewed = daemon.renew(&sent, delegate().public_key(), 1_800_000_300_000);

    let (mut flight, request) =
        RebindFlight::new(&keeper, names(&daemon), &[3; 32], &mut entropy).unwrap();
    let (ready, in_flight) = daemon.answer(&request, 1);
    let successor = flight.complete(&mut keeper, &ready).unwrap().unwrap();
    let mut daemon_transport =
        commit_final.then(|| daemon.commit(in_flight, &successor.final_flight));
    let reconcile = Reconcile::new(&keeper, names(&daemon), &mut entropy).unwrap();
    let reconciled = daemon.reconcile(&reconcile.flight);
    let mut forged = reconciled.clone();
    let DaemonSignal::SessionRebindReconciled { mac, .. } = &mut forged else {
        unreachable!()
    };
    *mac = merkur_authorization::encode(&[0; 64]);
    let mut resolved = false;
    for event in order {
        match event {
            Event::DuplicateReady => {
                assert!(flight.complete(&mut keeper, &ready).unwrap().is_none());
            }
            Event::ForgedReconciliation => {
                assert_eq!(reconcile.answer(&mut keeper, &forged), None);
            }
            Event::RenewalAnswer => {
                assert_eq!(
                    renewal.answer(&keeper, &renewed).is_some(),
                    !resolved || !commit_final,
                    "the predecessor MAC must stop verifying after its key is retired"
                );
            }
            Event::ReconciliationAnswer => {
                assert_eq!(
                    reconcile.answer(&mut keeper, &reconciled),
                    Some(commit_final)
                );
                resolved = true;
            }
        }
        assert_eq!(keeper.counter(), u64::from(resolved && commit_final));
        assert_eq!(keeper.has_pending(), !resolved);
    }
    assert_eq!(keeper.counter(), daemon.counter);
    assert_eq!(
        reconcile.answer(&mut keeper, &reconciled),
        None,
        "spent answer"
    );
    if let Some(transport) = daemon_transport.as_mut() {
        let mut client = successor.transport;
        let lane = merkur_e2e::lane_for_channel(merkur_wire::protocol::CHANNEL_PTY).unwrap();
        let input = client.seal_datagram(lane, b"after reconciliation").unwrap();
        assert_eq!(
            transport.open_datagram(lane, &input).unwrap(),
            b"after reconciliation"
        );
    }
}

#[test]
fn every_delivery_order_preserves_lost_commit_and_renewal_invariants() {
    let events = [
        Event::DuplicateReady,
        Event::ForgedReconciliation,
        Event::RenewalAnswer,
        Event::ReconciliationAnswer,
    ];
    let mut orders = 0;
    for a in 0..4 {
        for b in 0..4 {
            for c in 0..4 {
                for d in 0..4 {
                    let indices = [a, b, c, d];
                    if (0..4).any(|i| (i + 1..4).any(|j| indices[i] == indices[j])) {
                        continue;
                    }
                    let order = indices.map(|i| events[i]);
                    explore_order(order, false);
                    explore_order(order, true);
                    orders += 1;
                }
            }
        }
    }
    assert_eq!(orders, 24);
}
