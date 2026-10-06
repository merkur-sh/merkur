//! Recovery against the in-process daemon lineage: a candidate rebinds while
//! the incumbent serves, and only the daemon's authenticated commit
//! acknowledgement publishes it.

use merkur_edge_protocol::SpliceControlEvent;
use merkur_wire::signaling::{RebindFinal, SessionRebind};

use super::*;
use crate::test_support::answer_signatures;

/// The candidate dial in `actions`, and its routing nonce.
fn candidate_dial(actions: &[Action]) -> (ConnId, String) {
    actions
        .iter()
        .find_map(|action| match action {
            Action::Dial {
                conn,
                lane: EdgeLane::Signaling,
                preface: bytes,
                candidate: true,
                ..
            } => {
                let preface = preface(bytes);
                assert_eq!(
                    preface.session_id,
                    EdgeLane::Signaling.routing_id("session-1")
                );
                let RoutingAttachment::Candidate { nonce } = preface.attachment else {
                    panic!("a candidate attachment");
                };
                Some((*conn, nonce))
            }
            _ => None,
        })
        .unwrap_or_else(|| panic!("a candidate dial in {actions:?}"))
}

pub(super) fn proofs(actions: &[Action], candidate: ConnId) -> Vec<ClientSignal> {
    actions
        .iter()
        .filter_map(|action| match action {
            Action::SendProof { conn, payload } => {
                assert_eq!(*conn, candidate);
                Some(ClientSignal::parse(payload).expect("a valid proof record"))
            }
            _ => None,
        })
        .collect()
}

pub(super) fn deliver_proof(
    harness: &mut Harness,
    now_ms: u64,
    candidate: ConnId,
    signal: &DaemonSignal,
) {
    let json = signal.to_json();
    harness.session.handle(
        now_ms,
        Event::Proof {
            conn: candidate,
            payload: json.as_bytes(),
        },
        &mut harness.entropy,
    );
}

/// The lapse of the first pong deadline starts one candidate.
pub(super) fn escalate(harness: &mut Harness) -> ConnId {
    harness
        .session
        .handle_timeout(NOW + 1_030, &mut harness.entropy);
    let actions = drain(&mut harness.session);
    assert!(
        !actions
            .iter()
            .any(|action| matches!(action, Action::Close { .. } | Action::Status(_))),
        "a lapse evicts nothing: {actions:?}"
    );
    candidate_dial(&actions).0
}

/// Candidate attached, `session_rebind` sent: the daemon's answer and hold.
pub(super) fn rebind(
    harness: &mut Harness,
    candidate: ConnId,
    now_ms: u64,
) -> (DaemonSignal, crate::test_support::RebindInFlight) {
    harness
        .session
        .handle(now_ms, Event::Connected(candidate), &mut harness.entropy);
    let sent = proofs(&drain(&mut harness.session), candidate);
    let [request @ ClientSignal::SessionRebind(_)] = &sent[..] else {
        panic!("session_rebind alone: {sent:?}");
    };
    harness.lineage.answer(request, 7)
}

#[test]
fn a_candidate_publishes_only_on_the_commit_acknowledgement() {
    let (mut harness, mut incumbent) = ready();
    // Typed on the incumbent, painted by its model, and never acknowledged.
    harness
        .session
        .send_input(NOW + 31, 1, build::press('z'), true);
    let sent = drain(&mut harness.session);
    assert_eq!(
        received_runs(&mut incumbent, &sent),
        vec![
            (true, 1, vec![(build::press('z'), true)]),
            (false, 1, vec![(build::press('z'), true)])
        ]
    );

    let candidate = escalate(&mut harness);
    let (rebound, in_flight) = rebind(&mut harness, candidate, NOW + 1_040);
    deliver_proof(&mut harness, NOW + 1_050, candidate, &rebound);
    let sent = proofs(&drain(&mut harness.session), candidate);
    let [
        final_flight @ ClientSignal::RebindFinal(RebindFinal { .. }),
        reconcile,
    ] = &sent[..]
    else {
        panic!("the final and the reconcile leave together: {sent:?}");
    };
    let mut daemon = harness.lineage.commit(in_flight, final_flight);
    // Nothing is published before the acknowledgement.
    assert!(harness.session.is_ready());

    let acknowledgement = harness.lineage.reconcile(reconcile);
    deliver_proof(&mut harness, NOW + 1_060, candidate, &acknowledgement);
    let actions = drain(&mut harness.session);
    for conn in [harness.signaling, harness.interactive, harness.bulk] {
        assert!(actions.contains(&Action::Close { conn }), "{actions:?}");
    }
    // The successor is the session's next display lineage: the viewer claims
    // its grid to the daemon, which waits for that claim.
    assert!(actions.contains(&Action::DisplayFence(DisplayFence { lineage: 2 })));
    let dials: Vec<(ConnId, EdgeLane)> = actions
        .iter()
        .filter_map(|action| match action {
            Action::Dial {
                conn,
                lane,
                preface: bytes,
                candidate: false,
                ..
            } => {
                assert_eq!(preface(bytes).attachment, RoutingAttachment::Primary);
                Some((*conn, *lane))
            }
            _ => None,
        })
        .collect();
    let [(interactive, EdgeLane::Interactive), (bulk, EdgeLane::Bulk)] = dials[..] else {
        panic!("fresh data attachments: {actions:?}");
    };
    assert!(!harness.session.is_ready());
    harness.signaling = candidate;
    harness.interactive = interactive;
    harness.bulk = bulk;
    // Asked for between carriers: it waits for the new one.
    harness.session.request_display_snapshot(NOW + 50);
    assert!(drain(&mut harness.session).is_empty());

    // The data claim rides the published candidate, the HELLO the new lane.
    harness.session.handle(
        NOW + 1_070,
        Event::Connected(interactive),
        &mut harness.entropy,
    );
    let actions = drain(&mut harness.session);
    assert!(matches!(
        signal(&actions[0]),
        ClientSignal::DataAttach(DataClaim {
            lane: DataLane::Interactive,
            ..
        })
    ));
    let Action::SendReliable {
        conn,
        channel: CHANNEL_DATA_HELLO,
        payload,
    } = &actions[1]
    else {
        panic!("{actions:?}");
    };
    assert_eq!(*conn, interactive);
    let (_, nonce) = decode_data_handshake_frame(payload).unwrap();
    let actions = ack_hello(&mut harness, &nonce);
    assert!(actions.contains(&Action::Status(Status::Ready)));
    // The unacknowledged keystroke replays, same sequence, under the
    // successor keys, and no longer claims the model the rebind replaced.
    let replayed: Vec<_> = actions
        .iter()
        .filter(|action| {
            matches!(
                action,
                Action::SendDatagram { .. }
                    | Action::SendInputDatagram { .. }
                    | Action::SendReliable {
                        channel: CHANNEL_PTY,
                        ..
                    }
            )
        })
        .cloned()
        .collect();
    assert_eq!(
        received_runs(&mut daemon, &replayed),
        vec![
            (true, 1, vec![(build::press('z'), false)]),
            (false, 1, vec![(build::press('z'), false)])
        ]
    );
    let lane = merkur_e2e::lane_for_channel(CHANNEL_CTRL).unwrap();
    let control: Vec<Vec<u8>> = actions
        .iter()
        .filter_map(|action| match action {
            Action::SendReliable {
                channel: CHANNEL_CTRL,
                payload,
                ..
            } => Some(daemon.open_stream(lane, payload).unwrap()),
            _ => None,
        })
        .collect();
    assert!(
        control
            .iter()
            .any(|frame| decode_proto_frame(frame)
                == Some((MSG_TYPE_DISPLAY_SNAPSHOT_REQUEST, &[][..]))),
        "the owed snapshot request rides the new carrier"
    );
}

#[test]
fn incumbent_progress_before_the_final_retires_the_candidate() {
    let (mut harness, mut incumbent) = ready();
    let candidate = escalate(&mut harness);
    let token = (NOW + 30) * 1_000;
    let mut pong = token.to_be_bytes().to_vec();
    pong.extend_from_slice(&1u64.to_be_bytes());
    let lane = merkur_e2e::lane_for_channel(CHANNEL_CTRL).unwrap();
    let sealed = incumbent
        .seal_stream(lane, &encode_proto_frame(MSG_TYPE_HEARTBEAT_PONG, &pong))
        .unwrap();
    harness.session.handle(
        NOW + 1_035,
        Event::Reliable {
            conn: harness.interactive,
            source: DAEMON_ATTACHMENT,
            channel: CHANNEL_CTRL,
            payload: &sealed,
        },
        &mut harness.entropy,
    );
    assert_eq!(
        drain(&mut harness.session),
        vec![Action::Close { conn: candidate }]
    );
    assert!(harness.session.is_ready());
}

#[test]
fn a_candidate_lost_after_its_final_is_reconciled_on_the_next() {
    let (mut harness, _) = ready();
    let first = escalate(&mut harness);
    let (rebound, in_flight) = rebind(&mut harness, first, NOW + 1_040);
    deliver_proof(&mut harness, NOW + 1_050, first, &rebound);
    let sent = proofs(&drain(&mut harness.session), first);
    // The daemon commits, and the carrier dies before its acknowledgement.
    harness.lineage.commit(in_flight, &sent[0]);
    harness
        .session
        .handle(NOW + 1_060, closed(first), &mut harness.entropy);
    assert_eq!(
        drain(&mut harness.session),
        vec![Action::Close { conn: first }]
    );

    // The strike (one RTO after the lapse) starts the next candidate.
    harness
        .session
        .handle_timeout(NOW + 2_030, &mut harness.entropy);
    let actions = drain(&mut harness.session);
    assert!(actions.contains(&Action::Status(Status::Reconnecting)));
    let second = candidate_dial(&actions).0;
    harness
        .session
        .handle(NOW + 2_040, Event::Connected(second), &mut harness.entropy);
    let sent = proofs(&drain(&mut harness.session), second);
    let [reconcile @ ClientSignal::SessionRebindReconcile(_)] = &sent[..] else {
        panic!("the uncertain commit is settled first: {sent:?}");
    };
    let answer = harness.lineage.reconcile(reconcile);
    deliver_proof(&mut harness, NOW + 2_050, second, &answer);
    // Promoted: the next rebind is generation 1, and the daemon admits it.
    let sent = proofs(&drain(&mut harness.session), second);
    let [
        request @ ClientSignal::SessionRebind(SessionRebind {
            rebind_counter: 1, ..
        }),
    ] = &sent[..]
    else {
        panic!("{sent:?}");
    };
    harness.lineage.answer(request, 7);
}

#[test]
fn incumbent_progress_cannot_publish_ready_while_a_final_is_unresolved() {
    for lose_candidate in [false, true] {
        let (mut harness, mut incumbent) = ready();
        let candidate = escalate(&mut harness);
        let (rebound, _in_flight) = rebind(&mut harness, candidate, NOW + 1_040);
        deliver_proof(&mut harness, NOW + 1_050, candidate, &rebound);
        drain(&mut harness.session);
        harness
            .session
            .handle_timeout(NOW + 2_030, &mut harness.entropy);
        assert!(drain(&mut harness.session).contains(&Action::Status(Status::Reconnecting)));
        if lose_candidate {
            harness
                .session
                .handle(NOW + 2_031, closed(candidate), &mut harness.entropy);
            drain(&mut harness.session);
        }
        let mut pong = ((NOW + 30) * 1_000).to_be_bytes().to_vec();
        pong.extend_from_slice(&1u64.to_be_bytes());
        let sealed = incumbent
            .seal_stream(
                merkur_e2e::lane_for_channel(CHANNEL_CTRL).unwrap(),
                &encode_proto_frame(MSG_TYPE_HEARTBEAT_PONG, &pong),
            )
            .unwrap();
        harness.session.handle(
            NOW + 2_032,
            Event::Reliable {
                conn: harness.interactive,
                source: DAEMON_ATTACHMENT,
                channel: CHANNEL_CTRL,
                payload: &sealed,
            },
            &mut harness.entropy,
        );
        let actions = drain(&mut harness.session);
        assert!(
            !actions.contains(&Action::Status(Status::Ready)),
            "{actions:?}"
        );
        assert!(harness.session.incumbent_lost);
    }
}

#[test]
fn an_uncertain_final_retries_despite_incumbent_progress_and_a_failed_dial() {
    for committed in [false, true] {
        for progress_before_close in [false, true] {
            let (mut harness, mut incumbent) = ready();
            let first = escalate(&mut harness);
            let (rebound, in_flight) = rebind(&mut harness, first, NOW + 1_040);
            deliver_proof(&mut harness, NOW + 1_050, first, &rebound);
            let sent = proofs(&drain(&mut harness.session), first);
            if committed {
                harness.lineage.commit(in_flight, &sent[0]);
            }
            // A delayed predecessor pong can settle the ladder before or after
            // the candidate closes; it cannot decide whether its final arrived.
            let mut pong = ((NOW + 30) * 1_000).to_be_bytes().to_vec();
            pong.extend_from_slice(&1u64.to_be_bytes());
            let sealed = incumbent
                .seal_stream(
                    merkur_e2e::lane_for_channel(CHANNEL_CTRL).unwrap(),
                    &encode_proto_frame(MSG_TYPE_HEARTBEAT_PONG, &pong),
                )
                .unwrap();
            if !progress_before_close {
                harness
                    .session
                    .handle(NOW + 1_060, closed(first), &mut harness.entropy);
            }
            harness.session.handle(
                NOW + 1_061,
                Event::Reliable {
                    conn: harness.interactive,
                    source: DAEMON_ATTACHMENT,
                    channel: CHANNEL_CTRL,
                    payload: &sealed,
                },
                &mut harness.entropy,
            );
            if progress_before_close {
                harness
                    .session
                    .handle(NOW + 1_062, closed(first), &mut harness.entropy);
            }
            drain(&mut harness.session);
            assert!(!harness.session.incumbent_lost);
            assert!(harness.session.final_unresolved());
            let retry = harness
                .session
                .retry_at_ms
                .expect("an uncertain final owns reconciliation even with incumbent progress");
            harness.session.handle_timeout(retry, &mut harness.entropy);
            let second = candidate_dial(&drain(&mut harness.session)).0;
            // Even a failed reconciliation dial must retain the retry owner.
            harness
                .session
                .handle(retry + 1, closed(second), &mut harness.entropy);
            drain(&mut harness.session);
            let retry = harness
                .session
                .retry_at_ms
                .expect("a failed dial cannot abandon an unresolved final");
            harness.session.handle_timeout(retry, &mut harness.entropy);
            let third = candidate_dial(&drain(&mut harness.session)).0;
            harness
                .session
                .handle(retry + 1, Event::Connected(third), &mut harness.entropy);
            let sent = proofs(&drain(&mut harness.session), third);
            let [reconcile @ ClientSignal::SessionRebindReconcile(_)] = &sent[..] else {
                panic!("the uncertain final is reconciled first: {sent:?}");
            };
            let answer = harness.lineage.reconcile(reconcile);
            deliver_proof(&mut harness, retry + 2, third, &answer);
            let sent = proofs(&drain(&mut harness.session), third);
            let [request @ ClientSignal::SessionRebind(request_fields)] = &sent[..] else {
                panic!("reconciliation starts a rebind on the proven generation: {sent:?}");
            };
            assert_eq!(request_fields.rebind_counter, u64::from(committed));
            harness.lineage.answer(request, 7);
        }
    }
}

#[test]
fn an_authenticated_refusal_falls_back_to_a_fresh_issuance() {
    let (mut harness, _) = ready();
    let candidate = escalate(&mut harness);
    let (_, in_flight) = rebind(&mut harness, candidate, NOW + 1_040);
    let refusal = harness.lineage.refuse(&in_flight, "policy");
    deliver_proof(&mut harness, NOW + 1_050, candidate, &refusal);
    let actions = drain(&mut harness.session);
    assert_eq!(actions[0], Action::Close { conn: candidate });
    for conn in [harness.signaling, harness.interactive, harness.bulk] {
        assert!(actions.contains(&Action::Close { conn }), "{actions:?}");
    }
    assert!(actions.contains(&Action::Status(Status::Reconnecting)));
    let Some(Action::RequestIssuance(request)) = actions.last() else {
        panic!("{actions:?}");
    };
    let superseded = request.supersedes_issuance_id.as_ref().expect("supersedes");
    assert_ne!(*superseded, request.issuance_id);
}

#[test]
fn a_candidate_the_edge_holds_no_daemon_for_reissues() {
    let (mut harness, _) = ready();
    let candidate = escalate(&mut harness);
    harness.session.handle(
        NOW + 1_040,
        Event::Splice(
            candidate,
            SpliceControlEvent::CounterpartPresent {
                present: false,
                counterpart_attachment_id: None,
            },
        ),
        &mut harness.entropy,
    );
    let actions = drain(&mut harness.session);
    assert_eq!(actions[0], Action::Close { conn: candidate });
    assert!(matches!(actions.last(), Some(Action::RequestIssuance(_))));
}

#[test]
fn a_closed_incumbent_starts_a_candidate_at_once_and_retries_one_that_times_out() {
    let (mut harness, _) = ready();
    harness
        .session
        .handle(NOW + 100, closed(harness.signaling), &mut harness.entropy);
    let actions = drain(&mut harness.session);
    assert!(actions.contains(&Action::Status(Status::Reconnecting)));
    let first = candidate_dial(&actions).0;

    // No verdict in time: the attempt ends, and the retry follows within the
    // first backoff ceiling.
    harness
        .session
        .handle_timeout(NOW + 100 + AUTH_PHASE_WATCHDOG_MS, &mut harness.entropy);
    let actions = drain(&mut harness.session);
    assert!(actions.contains(&Action::Close { conn: first }));
    let retry = harness.session.next_deadline().unwrap();
    assert!(retry <= NOW + 100 + AUTH_PHASE_WATCHDOG_MS + RECONNECT_BASE_MS);
    harness.session.handle_timeout(retry, &mut harness.entropy);
    let second = candidate_dial(&drain(&mut harness.session)).0;
    assert_ne!(second, first);
}

/// The certificate hashes the dial for `conn` in `actions` pinned.
fn dial_pins(actions: &[Action], conn: ConnId) -> Vec<[u8; 32]> {
    actions
        .iter()
        .find_map(|action| match action {
            Action::Dial {
                conn: dialed,
                cert_hashes,
                ..
            } if *dialed == conn => Some(cert_hashes.clone()),
            _ => None,
        })
        .unwrap_or_else(|| panic!("a dial for {conn:?} in {actions:?}"))
}

#[test]
fn a_candidate_the_edge_does_not_take_repins_from_the_server_and_rebinds() {
    use base64::Engine;
    let (mut harness, _incumbent) = ready();
    harness
        .session
        .handle(NOW + 100, closed(harness.signaling), &mut harness.entropy);
    let actions = drain(&mut harness.session);
    let first = candidate_dial(&actions).0;
    let issued_pins = dial_pins(&actions, first);

    // The edge serves a certificate the issuance never pinned: the dial fails,
    // which a browser cannot tell from an unreachable edge. The server is asked.
    harness
        .session
        .handle(NOW + 120, Event::DialFailed(first), &mut harness.entropy);
    let actions = drain(&mut harness.session);
    let request = renewal_request(&actions);
    assert_eq!(request.session_id, "session-1");
    assert_eq!(request.edge_wt_url, "https://edge.merkur.example:4433");

    let rotated = [[0xc1; 32], [0xc2; 32]];
    let mut answer = capability();
    answer.edge_cert_hashes = Some(
        rotated
            .iter()
            .map(|hash| base64::engine::general_purpose::STANDARD.encode(hash))
            .collect(),
    );
    harness
        .session
        .handle(NOW + 140, Event::Renewed(Some(answer)), &mut harness.entropy);
    answer_signatures(&mut harness.session, NOW + 140, &mut harness.entropy);
    drain(&mut harness.session);

    // The retry pins what the edge serves now, and rebinds the same lineage.
    let retry = harness.session.next_deadline().unwrap();
    harness.session.handle_timeout(retry, &mut harness.entropy);
    let actions = drain(&mut harness.session);
    let second = candidate_dial(&actions).0;
    assert_ne!(second, first);
    assert_ne!(dial_pins(&actions, second), issued_pins);
    assert_eq!(dial_pins(&actions, second), rotated);
}

#[test]
fn an_answer_without_a_registration_keeps_the_pins() {
    let (mut harness, _incumbent) = ready();
    harness
        .session
        .handle(NOW + 100, closed(harness.signaling), &mut harness.entropy);
    let actions = drain(&mut harness.session);
    let first = candidate_dial(&actions).0;
    let issued_pins = dial_pins(&actions, first);
    harness
        .session
        .handle(NOW + 120, Event::DialFailed(first), &mut harness.entropy);
    drain(&mut harness.session);
    harness
        .session
        .handle(NOW + 140, Event::Renewed(Some(capability())), &mut harness.entropy);
    answer_signatures(&mut harness.session, NOW + 140, &mut harness.entropy);
    drain(&mut harness.session);
    let retry = harness.session.next_deadline().unwrap();
    harness.session.handle_timeout(retry, &mut harness.entropy);
    let actions = drain(&mut harness.session);
    let second = candidate_dial(&actions).0;
    assert_eq!(dial_pins(&actions, second), issued_pins);
}

fn capability() -> crate::issuance::RenewalCapability {
    crate::issuance::RenewalCapability {
        session_token: "renewal-capability".into(),
        session_token_expires_in_ms: 60_000,
        edge_cert_hashes: None,
    }
}

/// The one renewal request in `actions`.
fn renewal_request(actions: &[Action]) -> &crate::issuance::RenewalRequest {
    actions
        .iter()
        .find_map(|action| match action {
            Action::RequestRenewal(request) => Some(request),
            _ => None,
        })
        .unwrap_or_else(|| panic!("a renewal request in {actions:?}"))
}

#[test]
fn the_epoch_is_renewed_on_signaling_at_half_its_lifetime() {
    let (mut harness, mut incumbent) = ready();
    // A pong ends the first ping's deadline, so only the steady tick runs.
    let token = (NOW + 30) * 1_000;
    let mut pong = token.to_be_bytes().to_vec();
    pong.extend_from_slice(&1u64.to_be_bytes());
    let lane = merkur_e2e::lane_for_channel(CHANNEL_CTRL).unwrap();
    let sealed = incumbent
        .seal_stream(lane, &encode_proto_frame(MSG_TYPE_HEARTBEAT_PONG, &pong))
        .unwrap();
    harness.session.handle(
        NOW + 35,
        Event::Reliable {
            conn: harness.interactive,
            source: DAEMON_ATTACHMENT,
            channel: CHANNEL_CTRL,
            payload: &sealed,
        },
        &mut harness.entropy,
    );
    drain(&mut harness.session);

    // The issued capability lives 60 s; established at NOW + 20.
    let due = NOW + 20 + 30_000;
    harness.session.handle_timeout(due, &mut harness.entropy);
    let actions = drain(&mut harness.session);
    let request = renewal_request(&actions);
    assert_eq!(request.session_id, "session-1");
    assert_eq!(request.browser_node_id, BROWSER_NODE_ID);

    harness.session.handle(
        due + 10,
        Event::Renewed(Some(capability())),
        &mut harness.entropy,
    );
    // The host signs off the session's turn: nothing leaves until it answers.
    assert_eq!(drain(&mut harness.session), []);
    answer_signatures(&mut harness.session, due + 12, &mut harness.entropy);
    let actions = drain(&mut harness.session);
    let [flight] = &actions[..] else {
        panic!("{actions:?}");
    };
    assert!(matches!(
        action_conn(flight),
        Some(conn) if conn == harness.signaling
    ));
    let renew = signal(flight);
    let verdict = harness
        .lineage
        .renew(&renew, &harness.delegate_public_key, 1_900_000_000_000);
    let json = verdict.to_json();
    harness.session.handle(
        due + 20,
        Event::Reliable {
            conn: harness.signaling,
            source: DAEMON_ATTACHMENT,
            channel: CHANNEL_SIGNALING,
            payload: json.as_bytes(),
        },
        &mut harness.entropy,
    );
    assert!(drain(&mut harness.session).is_empty());
    // The next renewal is due at half of what remains of the new capability.
    assert!(harness.session.renewal.is_none());
    assert_eq!(harness.session.maintenance_ms, Some(due + 20 + 29_990));
}

#[test]
fn a_refusal_for_its_epoch_renews_on_the_candidate_then_rebinds() {
    let (mut harness, _) = ready();
    harness
        .session
        .handle_timeout(NOW + 1_030, &mut harness.entropy);
    let (candidate, routing_nonce) = candidate_dial(&drain(&mut harness.session));
    let (_, in_flight) = rebind(&mut harness, candidate, NOW + 1_040);
    let refusal = harness.lineage.refuse(&in_flight, "lineage_expired");
    deliver_proof(&mut harness, NOW + 1_050, candidate, &refusal);
    let actions = drain(&mut harness.session);
    assert!(
        !actions
            .iter()
            .any(|action| matches!(action, Action::Close { .. })),
        "a renewable refusal keeps the candidate: {actions:?}"
    );
    renewal_request(&actions);

    harness.session.handle(
        NOW + 1_100,
        Event::Renewed(Some(capability())),
        &mut harness.entropy,
    );
    answer_signatures(&mut harness.session, NOW + 1_101, &mut harness.entropy);
    let sent = proofs(&drain(&mut harness.session), candidate);
    let [renew @ ClientSignal::SessionRenew(_)] = &sent[..] else {
        panic!("the renewal rides the candidate: {sent:?}");
    };
    let verdict = harness
        .lineage
        .renew(renew, &harness.delegate_public_key, 1_900_000_000_000);
    deliver_proof(&mut harness, NOW + 1_110, candidate, &verdict);
    let sent = proofs(&drain(&mut harness.session), candidate);
    let [
        request @ ClientSignal::SessionRebind(SessionRebind {
            rebind_counter: 0,
            client_nonce,
            ..
        }),
    ] = &sent[..]
    else {
        panic!("a fresh rebind on the renewed epoch: {sent:?}");
    };
    // The same routing nonce: the edge bound it to this candidate.
    assert_eq!(*client_nonce, routing_nonce);
    harness.lineage.answer(request, 7);
}

fn action_conn(action: &Action) -> Option<ConnId> {
    match action {
        Action::SendReliable { conn, .. } | Action::SendProof { conn, .. } => Some(*conn),
        _ => None,
    }
}

#[test]
fn a_path_change_races_one_candidate_and_wakes_a_backoff() {
    let (mut harness, _) = ready();
    harness
        .session
        .connectivity_hint(NOW + 100, &mut harness.entropy);
    let actions = drain(&mut harness.session);
    let first = candidate_dial(&actions).0;
    assert!(
        !actions
            .iter()
            .any(|action| matches!(action, Action::Close { .. } | Action::Status(_))),
        "a hint displaces nothing: {actions:?}"
    );
    // Another hint during the attempt starts nothing new.
    harness
        .session
        .connectivity_hint(NOW + 110, &mut harness.entropy);
    assert!(
        !drain(&mut harness.session)
            .iter()
            .any(|action| matches!(action, Action::Dial { .. }))
    );

    // The incumbent goes; its candidate times out; the backoff is pending.
    harness
        .session
        .handle(NOW + 120, closed(harness.signaling), &mut harness.entropy);
    drain(&mut harness.session);
    harness
        .session
        .handle_timeout(NOW + 100 + AUTH_PHASE_WATCHDOG_MS, &mut harness.entropy);
    assert!(drain(&mut harness.session).contains(&Action::Close { conn: first }));
    assert!(harness.session.retry_at_ms.is_some());
    // A path change wakes it at once.
    harness
        .session
        .connectivity_hint(NOW + 101 + AUTH_PHASE_WATCHDOG_MS, &mut harness.entropy);
    let second = candidate_dial(&drain(&mut harness.session)).0;
    assert_ne!(second, first);
}

#[test]
fn a_candidate_that_heard_the_relay_pause_publishes_its_lanes_paused() {
    let (mut harness, _) = ready();
    let candidate = escalate(&mut harness);
    let (rebound, in_flight) = rebind(&mut harness, candidate, NOW + 1_040);
    harness.session.handle(
        NOW + 1_045,
        Event::Splice(
            candidate,
            SpliceControlEvent::RelayDataPaused { paused: true },
        ),
        &mut harness.entropy,
    );
    assert!(
        drain(&mut harness.session).is_empty(),
        "the incumbent's lanes are not the candidate's"
    );
    deliver_proof(&mut harness, NOW + 1_050, candidate, &rebound);
    let sent = proofs(&drain(&mut harness.session), candidate);
    let [final_flight, reconcile] = &sent[..] else {
        panic!("the final and the reconcile leave together: {sent:?}");
    };
    harness.lineage.commit(in_flight, final_flight);
    let acknowledgement = harness.lineage.reconcile(reconcile);
    deliver_proof(&mut harness, NOW + 1_060, candidate, &acknowledgement);
    let actions = drain(&mut harness.session);
    let dials = |actions: &[Action]| {
        actions
            .iter()
            .filter(|action| {
                matches!(
                    action,
                    Action::Dial {
                        candidate: false,
                        ..
                    }
                )
            })
            .count()
    };
    assert_eq!(dials(&actions), 0, "{actions:?}");
    assert!(actions.contains(&Action::Status(Status::RelayPaused)));

    // The published candidate is the signaling attachment that resumes it.
    harness.session.handle(
        NOW + 1_100,
        Event::Splice(
            candidate,
            SpliceControlEvent::RelayDataPaused { paused: false },
        ),
        &mut harness.entropy,
    );
    assert_eq!(dials(&drain(&mut harness.session)), 2);
}

#[test]
fn observed_path_is_published_only_by_the_authenticated_incumbent() {
    let (mut harness, _) = ready();
    let incumbent: std::net::IpAddr = "198.51.100.7".parse().unwrap();
    let successor: std::net::IpAddr = "198.51.100.8".parse().unwrap();
    harness.session.handle(
        NOW + 30,
        Event::Splice(
            harness.signaling,
            SpliceControlEvent::ObservedPath { address: incumbent },
        ),
        &mut harness.entropy,
    );
    assert_eq!(
        drain(&mut harness.session),
        vec![Action::ObservedPath(incumbent)]
    );
    let candidate = escalate(&mut harness);
    harness.session.handle(
        NOW + 1_031,
        Event::Splice(
            candidate,
            SpliceControlEvent::ObservedPath { address: successor },
        ),
        &mut harness.entropy,
    );
    assert!(drain(&mut harness.session).is_empty());
    let (rebound, in_flight) = rebind(&mut harness, candidate, NOW + 1_040);
    deliver_proof(&mut harness, NOW + 1_050, candidate, &rebound);
    let sent = proofs(&drain(&mut harness.session), candidate);
    let [final_flight @ ClientSignal::RebindFinal(_), reconcile] = &sent[..] else {
        panic!("final and reconcile: {sent:?}");
    };
    harness.lineage.commit(in_flight, final_flight);
    let acknowledgement = harness.lineage.reconcile(reconcile);
    deliver_proof(&mut harness, NOW + 1_060, candidate, &acknowledgement);
    let published = drain(&mut harness.session);
    assert_eq!(
        published
            .iter()
            .filter(|a| matches!(a, Action::ObservedPath(_)))
            .cloned()
            .collect::<Vec<_>>(),
        vec![Action::ObservedPath(successor)]
    );
    harness.session.handle(
        NOW + 1_061,
        Event::Splice(
            harness.signaling,
            SpliceControlEvent::ObservedPath { address: incumbent },
        ),
        &mut harness.entropy,
    );
    assert!(drain(&mut harness.session).is_empty());
}

#[test]
fn a_failed_candidate_never_publishes_its_observed_address() {
    let (mut harness, _) = ready();
    let candidate = escalate(&mut harness);
    let address: std::net::IpAddr = "198.51.100.8".parse().unwrap();
    harness.session.handle(
        NOW + 1_031,
        Event::Splice(candidate, SpliceControlEvent::ObservedPath { address }),
        &mut harness.entropy,
    );
    assert!(drain(&mut harness.session).is_empty());
    harness.session.handle(
        NOW + 1_032,
        Event::DialFailed(candidate),
        &mut harness.entropy,
    );
    assert!(
        !drain(&mut harness.session)
            .iter()
            .any(|a| matches!(a, Action::ObservedPath(_)))
    );
    harness.session.handle(
        NOW + 1_033,
        Event::Splice(candidate, SpliceControlEvent::ObservedPath { address }),
        &mut harness.entropy,
    );
    assert!(drain(&mut harness.session).is_empty());
    assert!(harness.session.is_ready());
}

#[test]
fn a_late_genesis_ack_cannot_publish_ready_over_an_unresolved_final() {
    let mut harness = authenticating();
    harness.session.handle(
        NOW + 6,
        Event::Connected(harness.interactive),
        &mut harness.entropy,
    );
    let (_, nonce, _) = deliver_ready(&mut harness, NOW + 20);
    harness
        .session
        .connectivity_hint(NOW + 30, &mut harness.entropy);
    let candidate = candidate_dial(&drain(&mut harness.session)).0;
    let (answer, _) = rebind(&mut harness, candidate, NOW + 40);
    deliver_proof(&mut harness, NOW + 50, candidate, &answer);
    drain(&mut harness.session);
    assert!(harness.session.final_unresolved());
    let ack = encode_data_handshake_frame(DataHandshakeKind::Ack, &nonce);
    harness.session.handle(
        NOW + 60,
        Event::Reliable {
            conn: harness.interactive,
            source: DAEMON_ATTACHMENT,
            channel: CHANNEL_DATA_HELLO,
            payload: &ack,
        },
        &mut harness.entropy,
    );
    assert!(
        !drain(&mut harness.session)
            .iter()
            .any(|action| matches!(action, Action::Status(Status::Ready)))
    );
    assert!(harness.session.final_unresolved());
}

#[test]
fn initial_signaling_dial_failure_recovers_without_owner_retry() {
    let mut harness = authenticating();
    harness.session.handle(
        NOW + 6,
        Event::DialFailed(harness.signaling),
        &mut harness.entropy,
    );
    let actions = drain(&mut harness.session);
    assert!(
        !harness.session.is_closed(),
        "initial carrier loss retired its owner: {actions:?}"
    );
    assert!(actions.contains(&Action::Status(Status::Reconnecting)));
    let retry_at = harness
        .session
        .next_deadline()
        .expect("one recovery deadline");
    harness
        .session
        .handle_timeout(retry_at, &mut harness.entropy);
    assert!(
        drain(&mut harness.session)
            .iter()
            .any(|action| matches!(action, Action::RequestIssuance(_)))
    );
    finish_initial_retry(&mut harness, retry_at + 1);
}

/// Complete a fresh issuance with the real signed daemon response, Noise final,
/// and data HELLO acknowledgement, then prove that input opens at the daemon.
fn finish_initial_retry(harness: &mut Harness, now_ms: u64) {
    let (_, daemon_identity, binding) = account();
    harness.session.handle(
        now_ms,
        Event::Issued(Some(issuance(&daemon_identity, binding))),
        &mut harness.entropy,
    );
    let dials = drain(&mut harness.session);
    let conns: Vec<_> = dials
        .iter()
        .filter_map(|action| match action {
            Action::Dial { conn, .. } => Some(*conn),
            _ => None,
        })
        .collect();
    assert_eq!(conns.len(), 3);
    (harness.signaling, harness.interactive, harness.bulk) = (conns[0], conns[1], conns[2]);
    harness.session.handle(
        now_ms + 1,
        Event::Connected(harness.signaling),
        &mut harness.entropy,
    );
    // Signaling is up before the delegate answered: flight 1 leaves with it.
    assert_eq!(drain(&mut harness.session), []);
    answer_signatures(&mut harness.session, now_ms + 1, &mut harness.entropy);
    let actions = drain(&mut harness.session);
    assert_eq!(actions[1], Action::Status(Status::Authenticating));
    let flight = signal(&actions[0]);
    let (ready, responder, lineage) =
        answer(&daemon_identity, &flight, &harness.delegate_public_key);
    harness.ready = ready;
    harness.responder = Some(responder);
    harness.lineage = lineage;
    harness.session.handle(
        now_ms + 2,
        Event::Connected(harness.interactive),
        &mut harness.entropy,
    );
    let (mut daemon, nonce, _) = deliver_ready(harness, now_ms + 3);
    ack_hello(harness, &nonce);
    assert!(harness.session.is_ready());
    harness
        .session
        .send_input(now_ms + 4, 1, build::press('q'), false);
    assert!(
        received_input(&mut daemon, &drain(&mut harness.session))
            .iter()
            .any(|(_, _, records)| records.contains(&build::press('q')))
    );
}

#[test]
fn initial_account_request_failure_recovers_with_fresh_authority() {
    let mut harness = authenticating();
    harness.session.connect("daemon-1", &mut harness.entropy);
    let first = drain(&mut harness.session)
        .into_iter()
        .find_map(|action| match action {
            Action::RequestIssuance(request) => Some(request),
            _ => None,
        })
        .expect("initial request");
    harness
        .session
        .handle(NOW + 1, Event::IssuanceFailed, &mut harness.entropy);
    let actions = drain(&mut harness.session);
    assert!(!harness.session.is_closed());
    assert!(actions.contains(&Action::Status(Status::Reconnecting)));
    let at = harness
        .session
        .next_deadline()
        .expect("recovery is scheduled");
    harness.session.handle_timeout(at, &mut harness.entropy);
    let next = drain(&mut harness.session)
        .into_iter()
        .find_map(|action| match action {
            Action::RequestIssuance(request) => Some(request),
            _ => None,
        })
        .expect("successor request");
    assert_eq!(next.supersedes_issuance_id, Some(first.issuance_id));
    assert_ne!(next.client_nonce, first.client_nonce);
    assert_ne!(next.encapsulation_key, first.encapsulation_key);
    finish_initial_retry(&mut harness, at + 1);
}

#[test]
fn initial_authority_or_invalid_response_failure_never_retries() {
    for (event, reason) in [
        (Event::AuthorizationDenied, CloseReason::AuthRejected),
        (Event::DaemonUnlinked, CloseReason::DaemonUnlinked),
        (Event::Issued(None), CloseReason::IssuanceFailed),
    ] {
        let mut harness = authenticating();
        harness.session.connect("daemon-1", &mut harness.entropy);
        drain(&mut harness.session);
        harness.session.handle(NOW + 1, event, &mut harness.entropy);
        assert!(harness.session.is_closed());
        assert!(drain(&mut harness.session).contains(&Action::Status(Status::Closed(reason))));
        assert_eq!(harness.session.next_deadline(), None);
        harness
            .session
            .handle_timeout(NOW + 100_000, &mut harness.entropy);
        assert!(drain(&mut harness.session).is_empty());
    }
}

#[test]
fn initial_invalid_binding_is_terminal_even_after_transport_recovery() {
    let mut harness = authenticating();
    harness.session.connect("daemon-1", &mut harness.entropy);
    drain(&mut harness.session);
    harness
        .session
        .handle(NOW + 1, Event::IssuanceFailed, &mut harness.entropy);
    drain(&mut harness.session);
    let at = harness.session.next_deadline().expect("retry");
    harness.session.handle_timeout(at, &mut harness.entropy);
    drain(&mut harness.session);
    let (_, daemon, mut binding) = account();
    binding.signature = "invalid".into();
    harness.session.handle(
        at + 1,
        Event::Issued(Some(issuance(&daemon, binding))),
        &mut harness.entropy,
    );
    assert!(harness.session.is_closed());
    assert!(
        drain(&mut harness.session)
            .iter()
            .any(|action| matches!(action, Action::Status(Status::Closed(CloseReason::Auth(_)))))
    );
    assert_eq!(harness.session.next_deadline(), None);
}
