//! The direct path against the in-process daemon: the manifest's race, the
//! punch a punched candidate waits for, the grace window, the authenticated
//! upgrade, and what a lost path, a new network and a rebind do to it.

use std::net::SocketAddr;

use base64::Engine;
use merkur_edge_protocol::SpliceControlEvent;
use merkur_wire::protocol::MSG_TYPE_WEBTRANSPORT_UPGRADE_ACK;
use merkur_wire::signaling::{
    CandidateKind, CandidateOutcome, CandidateScope, DirectCandidate, NatFiltering, NatSignature,
    NatType, PunchOutcome, PunchState, WebtransportOutcome, WebtransportUpgradeInit,
    WebtransportUpgradeProof, webtransport_upgrade_proof_payload,
};

use super::recovery::{deliver_proof, escalate, proofs, rebind};
use super::*;

const CERT_HASH: [u8; 32] = [0xab; 32];
/// Where the edge saw this client: an IPv4 client, toward which srflx is the
/// punched kind.
const CLIENT: &str = "198.51.100.7";
const MOVED: &str = "198.51.100.8";
const SRFLX: &str = "203.0.113.5:4443";
const HOST4: &str = "192.168.1.10:4443";
const LOOPBACK: &str = "127.0.0.1:4443";
const NONCE: &str = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
const TEMP_PEER: &str = "wt-pending-3";
const UPGRADE_ACK: [u8; 4] = [MSG_TYPE_WEBTRANSPORT_UPGRADE_ACK, 0, 0, 0];

fn addr(text: &str) -> SocketAddr {
    text.parse().unwrap()
}

fn candidate(at: &str, kind: CandidateKind, scope: CandidateScope) -> DirectCandidate {
    let at = addr(at);
    DirectCandidate {
        addr: at.ip(),
        port: at.port(),
        kind,
        scope,
        admission: 0,
    }
}

fn srflx() -> DirectCandidate {
    candidate(SRFLX, CandidateKind::Srflx, CandidateScope::Public)
}

fn host4() -> DirectCandidate {
    candidate(HOST4, CandidateKind::Host4, CandidateScope::Local)
}

fn manifest(
    generation: u64,
    candidates: Vec<DirectCandidate>,
    browser_address: &str,
    punch: PunchState,
) -> DaemonSignal {
    DaemonSignal::WebtransportManifest {
        generation,
        cert_hash: base64::engine::general_purpose::STANDARD.encode(CERT_HASH),
        candidates,
        nat: NatSignature {
            public_ip: Some("203.0.113.5".into()),
            nat_type: NatType::EndpointIndependent,
            hairpin: false,
            nat_filtering: NatFiltering::PortDependent,
        },
        browser_address: browser_address.parse().unwrap(),
        punch,
        admission_pending: false,
    }
}

fn deliver_signal(harness: &mut Harness, now_ms: u64, signal: &DaemonSignal) -> Vec<Action> {
    let json = signal.to_json();
    harness.session.handle(
        now_ms,
        Event::Reliable {
            conn: harness.signaling,
            source: DAEMON_ATTACHMENT,
            channel: CHANNEL_SIGNALING,
            payload: json.as_bytes(),
        },
        &mut harness.entropy,
    );
    drain(&mut harness.session)
}

/// The edge proved this client at `address` on its signaling attachment.
fn observed(harness: &mut Harness, now_ms: u64, address: &str) -> Vec<Action> {
    harness.session.handle(
        now_ms,
        Event::Splice(
            harness.signaling,
            SpliceControlEvent::ObservedPath {
                address: address.parse().unwrap(),
            },
        ),
        &mut harness.entropy,
    );
    drain(&mut harness.session)
}

fn dials(actions: &[Action]) -> Vec<(ConnId, SocketAddr)> {
    actions
        .iter()
        .filter_map(|action| match action {
            Action::DialDirect {
                conn,
                addr,
                cert_hash,
                binding: _,
                admission: _,
            } => {
                assert_eq!(
                    *cert_hash, CERT_HASH,
                    "pinned to the manifest's certificate"
                );
                Some((*conn, *addr))
            }
            _ => None,
        })
        .collect()
}

fn publish_native(harness: &mut Harness, generation: u64) -> u32 {
    harness.session.enable_native_traversal();
    let lineage = harness.session.native_traversal_epoch().unwrap();
    assert!(harness.session.publish_native_candidates(
        lineage,
        merkur_wire::traversal::Snapshot {
            generation,
            bindings: vec![merkur_wire::traversal::Binding {
                id: 7,
                family: 4,
                candidates: Vec::new()
            }],
            mac: String::new(),
        }
    ));
    let actions = drain(&mut harness.session);
    assert!(actions.iter().any(
        |action| matches!(action, Action::SendReliable { payload, .. }
        if matches!(ClientSignal::parse(payload), Some(ClientSignal::WebtransportCandidates(_))))
    ));
    lineage
}

fn native_offer(
    harness: &Harness,
    client_generation: u64,
    generation: u64,
) -> merkur_wire::traversal::Offer {
    let key = harness.session.native_traversal_setup().unwrap().key;
    let mut offer = merkur_wire::traversal::Offer {
        client_generation,
        generation,
        cert_hash: base64::engine::general_purpose::STANDARD.encode(CERT_HASH),
        candidates: vec![srflx()],
        mac: String::new(),
    };
    offer.mac =
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(key.mac(true, &offer.transcript()));
    offer
}

#[test]
fn native_dials_require_a_current_authenticated_check_and_exact_binding() {
    let (mut harness, _) = ready();
    harness.session.enable_native_traversal();
    let ordinary = deliver_signal(
        &mut harness,
        NOW + 40,
        &manifest(1, vec![srflx()], CLIENT, PunchState::None),
    );
    assert!(
        dials(&ordinary).is_empty(),
        "native sockets never use browser punch admission"
    );
    let lineage = publish_native(&mut harness, 1);
    let offer = native_offer(&harness, 1, 2);
    let actions = deliver_signal(
        &mut harness,
        NOW + 50,
        &DaemonSignal::WebtransportTraversalOffer(offer),
    );
    assert!(
        dials(&actions).is_empty(),
        "an offer is not connectivity evidence"
    );
    assert!(
        !harness
            .session
            .native_pair_checked(NOW + 60, lineage + 1, 1, 2, 7, addr(SRFLX))
    );
    assert!(
        !harness
            .session
            .native_pair_checked(NOW + 60, lineage, 2, 2, 7, addr(SRFLX))
    );
    assert!(
        !harness
            .session
            .native_pair_checked(NOW + 60, lineage, 1, 1, 7, addr(SRFLX))
    );
    assert!(
        !harness
            .session
            .native_pair_checked(NOW + 60, lineage, 1, 2, 0, addr(SRFLX))
    );
    assert!(
        harness
            .session
            .native_pair_checked(NOW + 60, lineage, 1, 2, 7, addr(SRFLX))
    );
    let actions = drain(&mut harness.session);
    assert!(
        matches!(&actions[..], [Action::DialDirect { addr: endpoint, cert_hash: CERT_HASH, binding: 7, .. }] if *endpoint == addr(SRFLX))
    );
    assert!(
        !harness
            .session
            .native_pair_checked(NOW + 61, lineage, 1, 2, 7, addr(SRFLX)),
        "duplicate check completion cannot redial"
    );
}

#[test]
fn native_offer_authentication_and_candidate_generation_fence_old_work() {
    let (mut harness, _) = ready();
    let lineage = publish_native(&mut harness, 1);
    let mut forged = native_offer(&harness, 1, 2);
    forged.candidates[0].port += 1;
    deliver_signal(
        &mut harness,
        NOW + 40,
        &DaemonSignal::WebtransportTraversalOffer(forged),
    );
    assert!(harness.session.native_traversal_offer().is_none());
    let valid = native_offer(&harness, 1, 2);
    deliver_signal(
        &mut harness,
        NOW + 50,
        &DaemonSignal::WebtransportTraversalOffer(valid.clone()),
    );
    assert!(harness.session.native_traversal_offer().is_some());
    publish_native(&mut harness, 2);
    deliver_signal(
        &mut harness,
        NOW + 60,
        &DaemonSignal::WebtransportTraversalOffer(valid),
    );
    assert!(
        harness.session.native_traversal_offer().is_none(),
        "old snapshot cannot reopen checks"
    );
    assert!(
        !harness
            .session
            .native_pair_checked(NOW + 60, lineage, 1, 2, 7, addr(SRFLX))
    );
    assert!(dials(&drain(&mut harness.session)).is_empty());
}

#[test]
fn native_direct_loss_requests_fresh_discovery_without_a_network_change() {
    let (mut harness, _) = ready();
    let lineage = publish_native(&mut harness, 1);
    let offer = native_offer(&harness, 1, 2);
    deliver_signal(
        &mut harness,
        NOW + 40,
        &DaemonSignal::WebtransportTraversalOffer(offer),
    );
    assert!(
        harness
            .session
            .native_pair_checked(NOW + 50, lineage, 1, 2, 7, addr(SRFLX))
    );
    let [(conn, _)] = dials(&drain(&mut harness.session))[..] else {
        panic!("one checked dial")
    };
    harness
        .session
        .handle(NOW + 60, Event::Connected(conn), &mut harness.entropy);
    let raced = drain(&mut harness.session);
    upgrade(&mut harness, NOW + 70, conn, &raced);
    assert!(harness.session.native_direct_live());
    let before = harness.session.native_traversal_recovery_generation();
    harness
        .session
        .handle(NOW + 90_100, closed(conn), &mut harness.entropy);
    assert_eq!(harness.session.native_traversal_epoch(), Some(lineage));
    assert_eq!(
        harness.session.native_traversal_recovery_generation(),
        before + 1
    );
    assert!(harness.session.native_traversal_offer().is_none());
    assert!(!harness.session.native_direct_live());
    assert!(
        !harness
            .session
            .native_pair_checked(NOW + 90_110, lineage, 1, 2, 7, addr(SRFLX))
    );
}

fn dialed(actions: &[Action]) -> Vec<SocketAddr> {
    dials(actions).into_iter().map(|(_, at)| at).collect()
}

/// A ready session at `CLIENT` whose first manifest offers `candidates`, and
/// what the manifest set off at `NOW + 100`.
fn offered(
    candidates: Vec<DirectCandidate>,
    punch: PunchState,
) -> (Harness, NoiseTransport, Vec<Action>) {
    let (mut harness, daemon) = ready();
    assert_eq!(
        observed(&mut harness, NOW + 40, CLIENT),
        vec![Action::ObservedPath(CLIENT.parse().unwrap())]
    );
    let actions = deliver_signal(
        &mut harness,
        NOW + 100,
        &manifest(1, candidates, CLIENT, punch),
    );
    (harness, daemon, actions)
}

/// A control record from the daemon on a direct attachment.
fn direct_control(harness: &mut Harness, now_ms: u64, conn: ConnId, payload: &[u8]) -> Vec<Action> {
    harness.session.handle(
        now_ms,
        Event::Reliable {
            conn,
            source: 0,
            channel: CHANNEL_CTRL,
            payload,
        },
        &mut harness.entropy,
    );
    drain(&mut harness.session)
}

/// The one plaintext upgrade record `actions` sends on `conn`.
fn upgrade_record(actions: &[Action], conn: ConnId) -> ClientSignal {
    let mut records: Vec<ClientSignal> = actions
        .iter()
        .filter_map(|action| match action {
            Action::SendReliable {
                conn: to,
                channel: CHANNEL_CTRL,
                payload,
            } if *to == conn => Some(ClientSignal::parse(payload).expect("an upgrade record")),
            _ => None,
        })
        .collect();
    assert_eq!(
        records.len(),
        1,
        "one upgrade record on {conn:?}: {actions:?}"
    );
    records.remove(0)
}

fn challenge() -> Vec<u8> {
    DaemonSignal::WebtransportUpgradeChallenge {
        nonce_hex: NONCE.into(),
        temp_peer_id: TEMP_PEER.into(),
    }
    .to_json()
    .into_bytes()
}

/// The proof the daemon checks, under the current generation's upgrade key.
fn expected_proof(harness: &Harness) -> String {
    let payload = webtransport_upgrade_proof_payload(
        NONCE,
        "session-1",
        BROWSER_NODE_ID,
        harness.lineage.daemon_id,
        TEMP_PEER,
    );
    hex(
        &merkur_e2e::hmac_sha512(&harness.lineage.direct_upgrade_secret, payload.as_bytes())
            .unwrap(),
    )
}

/// The upgrade on `conn` from the init in `raced` to the daemon's ack; what
/// the ack set off.
fn upgrade(harness: &mut Harness, now_ms: u64, conn: ConnId, raced: &[Action]) -> Vec<Action> {
    assert_eq!(
        upgrade_record(raced, conn),
        ClientSignal::WebtransportUpgradeInit(WebtransportUpgradeInit {
            browser_node_id: BROWSER_NODE_ID.into(),
        })
    );
    let actions = direct_control(harness, now_ms, conn, &challenge());
    let ClientSignal::WebtransportUpgradeProof(WebtransportUpgradeProof { proof_hex }) =
        upgrade_record(&actions, conn)
    else {
        panic!("the challenge is answered with the proof: {actions:?}");
    };
    assert_eq!(proof_hex, expected_proof(harness));
    direct_control(harness, now_ms + 5, conn, &UPGRADE_ACK)
}

/// The one outcome report in `actions`.
fn report(actions: &[Action]) -> WebtransportOutcome {
    let mut reports: Vec<WebtransportOutcome> = actions
        .iter()
        .filter_map(|action| match action {
            Action::SendReliable {
                channel: CHANNEL_SIGNALING,
                ..
            } => match signal(action) {
                ClientSignal::WebtransportOutcome(outcome) => Some(outcome),
                _ => None,
            },
            _ => None,
        })
        .collect();
    assert_eq!(reports.len(), 1, "one outcome report: {actions:?}");
    reports.remove(0)
}

fn outcomes(entries: &[(&str, &str)]) -> Vec<CandidateOutcome> {
    entries
        .iter()
        .map(|(kind, disposition)| CandidateOutcome {
            kind: (*kind).into(),
            disposition: (*disposition).into(),
        })
        .collect()
}

/// Srflx dialled at `NOW + 100`, host4 at `NOW + 130`; srflx's handshake
/// lands in 40 ms, host4's in 25 ms and wins. The winner's init is in the
/// actions returned.
fn raced() -> (Harness, NoiseTransport, ConnId, ConnId, Vec<Action>) {
    let (mut harness, daemon, actions) = offered(vec![srflx(), host4()], PunchState::None);
    let [(public, at)] = dials(&actions)[..] else {
        panic!("one dial at a time: {actions:?}");
    };
    assert_eq!(at, addr(SRFLX));
    harness
        .session
        .handle_timeout(NOW + 130, &mut harness.entropy);
    let [(local, at)] = dials(&drain(&mut harness.session))[..] else {
        panic!("host4 after the interleave");
    };
    assert_eq!(at, addr(HOST4));

    // The first handshake opens the grace window: host4, dialled 30 ms later,
    // may still beat 40 ms until `NOW + 170`.
    harness
        .session
        .handle(NOW + 140, Event::Connected(public), &mut harness.entropy);
    assert!(drain(&mut harness.session).is_empty());
    assert_eq!(harness.session.next_deadline(), Some(NOW + 170));

    harness
        .session
        .handle(NOW + 155, Event::Connected(local), &mut harness.entropy);
    let actions = drain(&mut harness.session);
    assert!(
        actions.contains(&Action::Close { conn: public }),
        "the slower handshake closes: {actions:?}"
    );
    (harness, daemon, public, local, actions)
}

/// [`raced`], then host4's upgrade, adopted at `NOW + 165`.
fn measured_providers(
    harness: &mut Harness,
    daemon: &mut NoiseTransport,
    actions: &[Action],
    relay_ms: u64,
    direct_ms: u64,
) -> Vec<Action> {
    let lane = merkur_e2e::lane_for_channel(CHANNEL_CTRL).unwrap();
    let mut pongs = Vec::new();
    for action in actions {
        if let Action::SendReliable {
            conn,
            channel: CHANNEL_CTRL,
            payload,
        } = action
        {
            let frame = daemon.open_stream(lane, payload).unwrap();
            if let Some((MSG_TYPE_HEARTBEAT_PING, token)) = decode_proto_frame(&frame) {
                let sent_at = u64::from_be_bytes(token.try_into().unwrap()) / 1_000;
                let rtt = if *conn == harness.interactive {
                    relay_ms
                } else {
                    direct_ms
                };
                let mut body = token.to_vec();
                body.extend_from_slice(&((sent_at + rtt) * 1_000).to_be_bytes());
                pongs.push((
                    sent_at + rtt,
                    *conn,
                    encode_proto_frame(MSG_TYPE_HEARTBEAT_PONG, &body),
                ));
            }
        }
    }
    assert_eq!(pongs.len(), 2, "each authenticated provider is probed");
    pongs.sort_by_key(|(at, _, _)| *at);
    for (at, conn, pong) in pongs {
        let mut payload = vec![CHANNEL_CTRL];
        payload.extend_from_slice(&daemon.seal_datagram(lane, &pong).unwrap());
        harness.session.handle(
            at,
            Event::Datagram {
                conn,
                payload: &payload,
            },
            &mut harness.entropy,
        );
    }
    drain(&mut harness.session)
}

/// The pings the session's next heartbeat sends, each provider's copy with
/// its token, and when they left.
fn next_pings(harness: &mut Harness, daemon: &mut NoiseTransport) -> (u64, Vec<(ConnId, u64)>) {
    let lane = merkur_e2e::lane_for_channel(CHANNEL_CTRL).unwrap();
    for _ in 0..8 {
        let at = harness
            .session
            .next_deadline()
            .expect("a heartbeat deadline");
        harness.session.handle_timeout(at, &mut harness.entropy);
        let pings: Vec<(ConnId, u64)> = drain(&mut harness.session)
            .iter()
            .filter_map(|action| {
                let Action::SendReliable {
                    conn,
                    channel: CHANNEL_CTRL,
                    payload,
                } = action
                else {
                    return None;
                };
                let frame = daemon.open_stream(lane, payload).unwrap();
                let (MSG_TYPE_HEARTBEAT_PING, token) = decode_proto_frame(&frame)? else {
                    return None;
                };
                Some((*conn, u64::from_be_bytes(token.try_into().unwrap())))
            })
            .collect();
        if !pings.is_empty() {
            return (at, pings);
        }
    }
    panic!("no heartbeat ping");
}

/// The daemon's pong datagram for `token`, arriving on `conn` at `at`.
fn pong(
    harness: &mut Harness,
    daemon: &mut NoiseTransport,
    at: u64,
    conn: ConnId,
    token: u64,
) -> Vec<Action> {
    let lane = merkur_e2e::lane_for_channel(CHANNEL_CTRL).unwrap();
    let mut body = token.to_be_bytes().to_vec();
    body.extend_from_slice(&(at * 1_000).to_be_bytes());
    let mut payload = vec![CHANNEL_CTRL];
    payload.extend_from_slice(
        &daemon
            .seal_datagram(lane, &encode_proto_frame(MSG_TYPE_HEARTBEAT_PONG, &body))
            .unwrap(),
    );
    harness.session.handle(
        at,
        Event::Datagram {
            conn,
            payload: &payload,
        },
        &mut harness.entropy,
    );
    drain(&mut harness.session)
}

/// The attachments `actions` tell the daemon were retired.
fn direct_lost(actions: &[Action]) -> Vec<String> {
    actions
        .iter()
        .filter_map(|action| {
            let Action::SendReliable {
                channel: CHANNEL_SIGNALING,
                ..
            } = action
            else {
                return None;
            };
            let ClientSignal::WebtransportDirectLost { temp_peer_id } = signal(action) else {
                return None;
            };
            Some(temp_peer_id)
        })
        .collect()
}

fn adopted() -> (Harness, NoiseTransport, ConnId) {
    let (mut harness, mut daemon, _, local, actions) = raced();
    let actions = upgrade(&mut harness, NOW + 160, local, &actions);
    assert_eq!(harness.session.primary_path(), Some(PathKind::Relay));
    let measured = measured_providers(&mut harness, &mut daemon, &actions, 4, 3);
    assert!(measured.contains(&Action::Path(PathKind::Direct)));
    (harness, daemon, local)
}

#[test]
fn a_manifest_races_public_candidates_first_one_every_thirty_ms() {
    let loopback = candidate(LOOPBACK, CandidateKind::Loopback, CandidateScope::Local);
    let (mut harness, _, actions) = offered(vec![host4(), loopback, srflx()], PunchState::None);
    assert_eq!(dialed(&actions), vec![addr(SRFLX)]);
    assert_eq!(harness.session.next_deadline(), Some(NOW + 130));
    harness
        .session
        .handle_timeout(NOW + 130, &mut harness.entropy);
    assert_eq!(dialed(&drain(&mut harness.session)), vec![addr(HOST4)]);
    harness
        .session
        .handle_timeout(NOW + 160, &mut harness.entropy);
    assert_eq!(dialed(&drain(&mut harness.session)), vec![addr(LOOPBACK)]);

    // A newer manifest naming the same endpoints dials none of them twice.
    let again = manifest(2, vec![srflx(), host4()], CLIENT, PunchState::None);
    assert!(dials(&deliver_signal(&mut harness, NOW + 170, &again)).is_empty());
}

#[test]
fn a_punched_candidate_waits_for_its_manifests_punch() {
    let (mut harness, _, actions) = offered(vec![srflx(), host4()], PunchState::Pending);
    assert_eq!(
        dialed(&actions),
        vec![addr(HOST4)],
        "srflx is punched toward an IPv4 client"
    );
    let punch = |generation, outcome| DaemonSignal::WebtransportPunch {
        generation,
        outcome,
    };
    let other = deliver_signal(&mut harness, NOW + 110, &punch(0, PunchOutcome::Dispatched));
    assert!(dials(&other).is_empty(), "another manifest's punch");
    let superseded = deliver_signal(&mut harness, NOW + 120, &punch(1, PunchOutcome::Superseded));
    assert!(dials(&superseded).is_empty());
    let dispatched = deliver_signal(&mut harness, NOW + 125, &punch(1, PunchOutcome::Dispatched));
    assert_eq!(dialed(&dispatched), vec![addr(SRFLX)]);
}

#[test]
fn the_fastest_handshake_in_the_grace_window_wins_and_its_upgrade_adopts_the_path() {
    let (mut harness, mut daemon, _, local, actions) = raced();
    let actions = upgrade(&mut harness, NOW + 160, local, &actions);
    assert_eq!(harness.session.primary_path(), Some(PathKind::Relay));
    assert_eq!(
        report(&actions),
        WebtransportOutcome {
            outcome: "selected".into(),
            admission_stage: "none".into(),
            admission_reason: "none".into(),
            nat_type: "endpoint_independent".into(),
            winner_kind: Some("host4".into()),
            candidates: outcomes(&[("srflx", "ready_lost_race"), ("host4", "won")]),
        }
    );
    assert!(harness.session.is_ready());

    let measured = measured_providers(&mut harness, &mut daemon, &actions, 4, 3);
    assert!(measured.contains(&Action::Path(PathKind::Direct)));

    // Every sealed frame now rides the direct path.
    harness
        .session
        .send_input(NOW + 170, 1, build::press('d'), false);
    let sent = drain(&mut harness.session);
    assert!(
        sent.iter().filter(|action| matches!(action, Action::SendInputDatagram { .. } | Action::SendReliable { channel: CHANNEL_PTY, .. })).all(|action| matches!(
            action,
            Action::SendInputDatagram { conn, .. } | Action::SendReliable { conn, .. } if *conn == local
        )),
        "{sent:?}"
    );
    assert_eq!(
        received_input(&mut daemon, &sent),
        vec![
            (true, 1, vec![build::press('d')]),
            (false, 1, vec![build::press('d')])
        ]
    );
}

#[test]
fn a_lost_direct_path_hands_input_back_to_the_relay_and_races_again() {
    let (mut harness, mut daemon, local) = adopted();
    harness
        .session
        .send_input(NOW + 170, 1, build::press('e'), false);
    assert_eq!(
        received_input(&mut daemon, &drain(&mut harness.session)).len(),
        2
    );

    harness
        .session
        .handle(NOW + 200, closed(local), &mut harness.entropy);
    let actions = drain(&mut harness.session);
    assert_eq!(actions.first(), Some(&Action::Path(PathKind::Relay)));
    let lost = report(&actions);
    assert_eq!(
        (lost.outcome.as_str(), lost.winner_kind.as_deref()),
        ("lost", Some("host4"))
    );
    assert_eq!(direct_lost(&actions), vec![TEMP_PEER.to_string()]);
    // The unacknowledged keystroke goes out again on the relay, whole.
    let relayed: Vec<Action> = actions
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
    assert!(relayed.iter().all(|action| matches!(
        action,
        Action::SendDatagram { conn, .. } | Action::SendInputDatagram { conn, .. } | Action::SendReliable { conn, .. } if *conn == harness.interactive
    )));
    assert_eq!(
        received_input(&mut daemon, &relayed),
        vec![
            (true, 1, vec![build::press('e')]),
            (false, 1, vec![build::press('e')])
        ]
    );
    // Nothing this network offers is spent: it races again.
    assert_eq!(dialed(&actions), vec![addr(SRFLX)]);
}

#[test]
fn a_silent_direct_path_is_retired_an_rto_after_the_relay_answers_its_ping() {
    let (mut harness, mut daemon, local) = adopted();
    let relay = harness.interactive;

    // A path that answers the ping the relay answered keeps the session.
    let (at, pings) = next_pings(&mut harness, &mut daemon);
    let [(_, token), (_, also)] = pings[..] else {
        panic!("both providers carry the ping: {pings:?}");
    };
    assert_eq!(token, also);
    assert!(pings.iter().any(|(conn, _)| *conn == local));
    let rto = harness.session.heartbeat.rto_ceil_ms();
    pong(&mut harness, &mut daemon, at + 4, relay, token);
    assert!(direct_lost(&pong(&mut harness, &mut daemon, at + 9, local, token)).is_empty());
    harness
        .session
        .handle_timeout(at + 4 + rto + 1, &mut harness.entropy);
    assert!(!drain(&mut harness.session).contains(&Action::Close { conn: local }));
    assert_eq!(harness.session.direct.path(), Some(local));

    // The relay answers, the direct copy never does: one RTO later the path
    // is retired, closed, and named to the daemon.
    let (at, pings) = next_pings(&mut harness, &mut daemon);
    let token = pings[0].1;
    let rto = harness.session.heartbeat.rto_ceil_ms();
    assert!(direct_lost(&pong(&mut harness, &mut daemon, at + 4, relay, token)).is_empty());
    harness
        .session
        .handle_timeout(at + 4 + rto - 1, &mut harness.entropy);
    assert!(direct_lost(&drain(&mut harness.session)).is_empty());
    harness
        .session
        .handle_timeout(at + 4 + rto, &mut harness.entropy);
    let retired = drain(&mut harness.session);
    assert_eq!(retired.first(), Some(&Action::Path(PathKind::Relay)));
    assert!(retired.contains(&Action::Close { conn: local }));
    assert_eq!(direct_lost(&retired), vec![TEMP_PEER.to_string()]);
    assert_eq!(report(&retired).outcome, "lost");
    assert_eq!(harness.session.direct.path(), None);
}

#[test]
fn a_failed_upgrade_spends_its_endpoint_and_races_what_is_left() {
    let (mut harness, _, _, local, _) = raced();
    let actions = direct_control(&mut harness, NOW + 160, local, b"{\"type\":\"nonsense\"}");
    assert!(actions.contains(&Action::Close { conn: local }));
    assert_eq!(
        report(&actions),
        WebtransportOutcome {
            outcome: "failed".into(),
            admission_stage: "challenge".into(),
            admission_reason: "invalid".into(),
            nat_type: "endpoint_independent".into(),
            winner_kind: None,
            candidates: outcomes(&[
                ("srflx", "ready_lost_race"),
                ("host4", "ready_upgrade_failed")
            ]),
        }
    );
    let [(public, at)] = dials(&actions)[..] else {
        panic!("srflx races again, host4 is spent: {actions:?}");
    };
    assert_eq!(at, addr(SRFLX));

    // Alone in its race, srflx upgrades at once; its ack never comes.
    harness
        .session
        .handle(NOW + 200, Event::Connected(public), &mut harness.entropy);
    let actions = drain(&mut harness.session);
    upgrade_record(&actions, public);
    let actions = direct_control(&mut harness, NOW + 210, public, &challenge());
    upgrade_record(&actions, public);
    harness
        .session
        .handle_timeout(NOW + 2_210, &mut harness.entropy);
    let actions = drain(&mut harness.session);
    assert!(actions.contains(&Action::Close { conn: public }));
    let failed = report(&actions);
    assert_eq!(
        (
            failed.admission_stage.as_str(),
            failed.admission_reason.as_str()
        ),
        ("ack", "timeout")
    );
    assert!(dials(&actions).is_empty(), "both endpoints are spent here");
}

#[test]
fn a_browser_queued_handshake_can_authenticate_after_the_old_race_deadline() {
    let (mut harness, _, actions) = offered(vec![host4()], PunchState::None);
    let [(conn, _)] = dials(&actions)[..] else {
        panic!("one direct dial");
    };
    harness
        .session
        .handle_timeout(NOW + 3_000, &mut harness.entropy);
    let pending = drain(&mut harness.session);
    assert!(
        !pending.contains(&Action::Close { conn }),
        "elapsed scheduling time cannot establish a native handshake failure"
    );
    harness
        .session
        .handle(NOW + 3_010, Event::Connected(conn), &mut harness.entropy);
    let connected = drain(&mut harness.session);
    let adopted = upgrade(&mut harness, NOW + 3_020, conn, &connected);
    assert_eq!(report(&adopted).outcome, "selected");
    assert_eq!(harness.session.direct.path(), Some(conn));
}

#[test]
fn an_unanswered_handshake_is_spent_until_the_network_changes() {
    let (mut harness, _, actions) = offered(vec![host4()], PunchState::None);
    let [(local, _)] = dials(&actions)[..] else {
        panic!("{actions:?}");
    };
    harness
        .session
        .handle(NOW + 150, Event::DialFailed(local), &mut harness.entropy);
    let actions = drain(&mut harness.session);
    let failed = report(&actions);
    assert_eq!(
        (failed.outcome.as_str(), failed.candidates),
        ("failed", outcomes(&[("host4", "other")]))
    );
    assert!(dials(&actions).is_empty());
    let again = manifest(2, vec![host4()], CLIENT, PunchState::None);
    assert!(dials(&deliver_signal(&mut harness, NOW + 200, &again)).is_empty());

    // Nothing spent on the last network is spent on this one.
    assert_eq!(
        dialed(&observed(&mut harness, NOW + 300, MOVED)),
        vec![addr(HOST4)]
    );
}

#[test]
fn a_new_network_revokes_the_race_and_its_punched_candidate_waits_for_a_manifest() {
    let (mut harness, _, actions) = offered(vec![srflx(), host4()], PunchState::None);
    let [(public, _)] = dials(&actions)[..] else {
        panic!("{actions:?}");
    };
    let actions = observed(&mut harness, NOW + 110, MOVED);
    assert!(actions.contains(&Action::Close { conn: public }));
    assert_eq!(
        dialed(&actions),
        vec![addr(HOST4)],
        "srflx waits for a manifest built for the new address"
    );
    let rebuilt = manifest(2, vec![srflx(), host4()], MOVED, PunchState::None);
    assert_eq!(
        dialed(&deliver_signal(&mut harness, NOW + 120, &rebuilt)),
        vec![addr(SRFLX)]
    );
}

#[test]
fn the_first_proof_of_the_manifests_network_leaves_its_race_standing() {
    let (mut harness, _) = ready();
    // The manifest can land a round trip before the edge's proof of the
    // carrier's address; a browser host admits one dial per endpoint, so a
    // revoke here would refuse the redial and spend every candidate.
    let offer = manifest(1, vec![srflx(), host4()], CLIENT, PunchState::None);
    let actions = deliver_signal(&mut harness, NOW + 100, &offer);
    let [(public, at)] = dials(&actions)[..] else {
        panic!("{actions:?}");
    };
    assert_eq!(at, addr(SRFLX));
    assert_eq!(
        observed(&mut harness, NOW + 110, CLIENT),
        vec![Action::ObservedPath(CLIENT.parse().unwrap())],
        "nothing is revoked or dialled again"
    );
    assert!(harness.session.direct.owns(public));
    harness
        .session
        .handle_timeout(NOW + 130, &mut harness.entropy);
    assert_eq!(dialed(&drain(&mut harness.session)), vec![addr(HOST4)]);
}

#[test]
fn relay_only_never_races_the_direct_path() {
    let (mut harness, _) = ready();
    harness.session.config.relay_only = true;
    observed(&mut harness, NOW + 40, CLIENT);
    let offer = manifest(1, vec![srflx(), host4()], CLIENT, PunchState::None);
    let actions = deliver_signal(&mut harness, NOW + 100, &offer);
    assert!(dials(&actions).is_empty(), "{actions:?}");
    assert_eq!(harness.session.next_deadline(), Some(NOW + 1_030));
}

#[test]
fn a_rebind_retires_the_direct_path_and_upgrades_under_the_successors_key() {
    let (mut harness, _, local) = adopted();
    // The upgrade's measured pongs ended the initial ladder. Arm a fresh
    // authenticated probe whose actual RTO lapses at the shared fixture edge.
    let start = NOW + 1_030 - harness.session.heartbeat.rto_ms().ceil() as u64;
    let (heartbeat, mut link) = harness.session.liveness();
    heartbeat.send_immediate_ping(start, &mut link);
    drain(&mut harness.session);
    let candidate = escalate(&mut harness);
    let (rebound, in_flight) = rebind(&mut harness, candidate, NOW + 1_040);
    // The daemon offers the successor its direct path on the candidate; it
    // waits for the commit.
    let offer = manifest(5, vec![host4()], CLIENT, PunchState::None);
    deliver_proof(&mut harness, NOW + 1_045, candidate, &offer);
    assert!(drain(&mut harness.session).is_empty());
    deliver_proof(&mut harness, NOW + 1_050, candidate, &rebound);
    let sent = proofs(&drain(&mut harness.session), candidate);
    let [final_flight @ ClientSignal::RebindFinal(_), reconcile] = &sent[..] else {
        panic!("the final and the reconcile: {sent:?}");
    };
    harness.lineage.commit(in_flight, final_flight);
    let acknowledgement = harness.lineage.reconcile(reconcile);
    deliver_proof(&mut harness, NOW + 1_060, candidate, &acknowledgement);
    let actions = drain(&mut harness.session);
    assert!(actions.contains(&Action::Close { conn: local }));
    assert!(actions.contains(&Action::Path(PathKind::Relay)));
    // The network carried over the rebind, so the offer races at once.
    let [(redial, at)] = dials(&actions)[..] else {
        panic!("{actions:?}");
    };
    assert_eq!(at, addr(HOST4));
    harness.signaling = candidate;

    harness
        .session
        .handle(NOW + 1_080, Event::Connected(redial), &mut harness.entropy);
    let actions = drain(&mut harness.session);
    let _actions = upgrade(&mut harness, NOW + 1_090, redial, &actions);
    assert_eq!(harness.session.direct.path(), Some(redial));
    assert!(harness.session.is_ready());
}

#[test]
fn authenticated_provider_floors_choose_the_primary_without_retiring_the_alternate() {
    for (relay_ms, direct_ms, expected) in [
        (10, 21, PathKind::Relay),
        (21, 10, PathKind::Direct),
        (15, 15, PathKind::Direct),
    ] {
        let (mut harness, mut daemon, _, local, raced) = raced();
        let actions = upgrade(&mut harness, NOW + 160, local, &raced);
        let lineage = harness.session.display_lineage();
        let measured = measured_providers(&mut harness, &mut daemon, &actions, relay_ms, direct_ms);
        assert_eq!(harness.session.primary_path(), Some(expected));
        assert_eq!(
            harness.session.network_rtt_ms(),
            Some(if expected == PathKind::Relay {
                relay_ms
            } else {
                direct_ms
            } as f64)
        );
        assert_eq!(harness.session.display_lineage(), lineage);
        assert_eq!(harness.session.direct.path(), Some(local));
        assert!(
            !measured
                .iter()
                .any(|action| matches!(action, Action::Close { .. } | Action::DisplayFence(_)))
        );
        harness
            .session
            .send_input(NOW + 200, 1, build::press('p'), false);
        let sent = drain(&mut harness.session);
        let primary = if expected == PathKind::Relay {
            harness.interactive
        } else {
            local
        };
        assert!(sent.iter().filter(|action| matches!(action, Action::SendInputDatagram { .. } | Action::SendReliable { channel: CHANNEL_PTY, .. })).all(|action| matches!(action, Action::SendInputDatagram { conn, .. } | Action::SendReliable { conn, .. } if *conn == primary)));
        assert_eq!(received_input(&mut daemon, &sent).len(), 2);
    }
}

#[test]
fn stalled_reliable_counter_custody_survives_primary_switch_and_more_than_a_replay_window() {
    for retire in [false, true] {
        let (mut h, mut daemon, _, local, raced) = raced();
        let probes = upgrade(&mut h, NOW + 160, local, &raced);
        let hint = encode_proto_frame(merkur_wire::protocol::MSG_TYPE_TRANSPORT_HINT, &[0; 11]);
        assert!(h.session.send_host_observation(&hint));
        let Some(Action::SendReliable {
            conn,
            channel: CHANNEL_CTRL,
            payload: pending,
        }) = h.session.poll_available_io_action()
        else {
            panic!("initial reliable record");
        };
        assert_eq!(conn, h.interactive);
        h.session
            .set_reliable_blocked(NOW + 161, conn, CHANNEL_CTRL, true);
        measured_providers(&mut h, &mut daemon, &probes, 21, 10);
        assert_eq!(h.session.primary_path(), Some(PathKind::Direct));
        let mut overtaking = 0;
        for seq in 0u16..2048 {
            let mut body = [0; 11];
            body[1..3].copy_from_slice(&seq.to_be_bytes());
            assert!(h.session.send_host_observation(&encode_proto_frame(
                merkur_wire::protocol::MSG_TYPE_TRANSPORT_HINT,
                &body
            )));
            while let Some(action) = h.session.poll_available_io_action() {
                let Action::SendReliable {
                    channel: CHANNEL_CTRL,
                    payload,
                    ..
                } = action
                else {
                    panic!("only reliable CTRL could escape this producer");
                };
                // Reproduce replay-window exhaustion against the authenticated peer,
                // rather than inspecting or inventing a counter estimate.
                daemon
                    .open_stream(
                        merkur_e2e::lane_for_channel(CHANNEL_CTRL).unwrap(),
                        &payload,
                    )
                    .unwrap();
                overtaking += 1;
            }
            assert!(h.session.host_observation_owed.iter().flatten().count() <= 1);
        }
        // The independently keyed input datagram and authenticated ACK still run.
        h.session.send_input(NOW + 200, 1, build::press('x'), true);
        let sent: Vec<_> = std::iter::from_fn(|| h.session.poll_available_io_action()).collect();
        assert_eq!(received_input(&mut daemon, &sent).len(), 2);
        let lane = merkur_e2e::lane_for_channel(CHANNEL_CTRL).unwrap();
        let mut ack = vec![CHANNEL_CTRL];
        ack.extend(
            daemon
                .seal_datagram(
                    lane,
                    &encode_proto_frame(MSG_TYPE_INPUT_ACK, &1u32.to_be_bytes()),
                )
                .unwrap(),
        );
        h.session.handle(
            NOW + 201,
            Event::Datagram {
                conn: local,
                payload: &ack,
            },
            &mut h.entropy,
        );
        assert_eq!(h.session.outbox.len(), 0);
        if retire {
            h.session.actions.push_back(Action::SendReliable {
                conn,
                channel: CHANNEL_CTRL,
                payload: pending,
            });
            h.session.actions.push_back(Action::Close { conn });
            assert_eq!(
                h.session.poll_close_action(NOW + 202),
                Some(Action::Close { conn })
            );
        } else {
            let opened = daemon.open_stream(lane, &pending).unwrap();
            assert_eq!(opened, hint);
            assert!(
                daemon.open_stream(lane, &pending).is_err(),
                "accepted exactly once"
            );
            h.session
                .set_reliable_blocked(NOW + 202, conn, CHANNEL_CTRL, false);
        }
        assert_eq!(
            overtaking, 0,
            "unfinished reliable ciphertext cannot be overtaken"
        );
        assert!(h.session.has_reliable_capacity(CHANNEL_CTRL));
        // The switch the blocked writer owed the daemon leaves first, on the new primary.
        let Some(owed) = h.session.poll_available_io_action() else {
            panic!("owed carrier announcement");
        };
        let announcement = super::announced(&mut daemon, &owed, local);
        assert!(announcement.direct, "{announcement:?}");
        assert_eq!(announcement.direct_floor_us, 10_000);
        assert_eq!(announcement.relay_floor_us, 21_000);
        let Some(Action::SendReliable {
            conn: next,
            channel: CHANNEL_CTRL,
            payload,
        }) = h.session.poll_available_io_action()
        else {
            panic!("retained latest fact");
        };
        assert_eq!(next, local);
        let opened = daemon.open_stream(lane, &payload).unwrap();
        let (kind, body) = decode_proto_frame(&opened).unwrap();
        assert_eq!(kind, merkur_wire::protocol::MSG_TYPE_TRANSPORT_HINT);
        assert_eq!(&body[1..3], &2047u16.to_be_bytes());
        assert!(h.session.poll_available_io_action().is_none());
    }
}

#[test]
fn allocation_observation_cannot_hold_other_paths_and_a_new_tuple_gets_one_attempt() {
    let (mut h, _) = ready();
    observed(&mut h, NOW + 40, CLIENT);
    let old = candidate(
        "203.0.113.5:49152",
        CandidateKind::Sip,
        CandidateScope::Public,
    );
    let mut pending = manifest(1, vec![old, srflx()], CLIENT, PunchState::None);
    if let DaemonSignal::WebtransportManifest {
        admission_pending, ..
    } = &mut pending
    {
        *admission_pending = true;
    }
    let mut actions = deliver_signal(&mut h, NOW + 100, &pending);
    let old_conn = dials(&actions)
        .iter()
        .find(|(_, at)| *at == addr("203.0.113.5:49152"))
        .unwrap()
        .0;
    h.session
        .handle(NOW + 110, Event::DialFailed(old_conn), &mut h.entropy);
    actions.extend(drain(&mut h.session));
    h.session.handle_timeout(NOW + 200, &mut h.entropy);
    actions.extend(drain(&mut h.session));
    assert!(
        dials(&actions).iter().any(|(_, at)| *at == addr(SRFLX)),
        "quote observation cannot block the reflexive path"
    );
    let updated = candidate(
        "203.0.113.5:49154",
        CandidateKind::Sip,
        CandidateScope::Public,
    );
    if let DaemonSignal::WebtransportManifest { candidates, .. } = &mut pending {
        candidates[0] = updated;
    }
    let actions = deliver_signal(&mut h, NOW + 210, &pending);
    assert!(
        dials(&actions)
            .iter()
            .any(|(_, at)| *at == addr("203.0.113.5:49154"))
    );
    assert!(
        dials(&actions)
            .iter()
            .all(|(_, at)| *at != addr("203.0.113.5:49152"))
    );
    assert!(dials(&deliver_signal(&mut h, NOW + 220, &pending)).is_empty());
}

#[test]
fn router_preparation_completes_before_a_reflexive_constructor_and_never_retries_failed_urls() {
    let (mut h, _) = ready();
    observed(&mut h, NOW + 40, CLIENT);
    let mut pending = manifest(1, vec![srflx()], CLIENT, PunchState::None);
    if let DaemonSignal::WebtransportManifest {
        admission_pending, ..
    } = &mut pending
    {
        *admission_pending = true;
    }
    assert!(dials(&deliver_signal(&mut h, NOW + 100, &pending)).is_empty());
    let prepared = manifest(
        1,
        vec![
            candidate(
                "203.0.113.5:49152",
                CandidateKind::Tftp,
                CandidateScope::Public,
            ),
            srflx(),
        ],
        CLIENT,
        PunchState::None,
    );
    let actions = deliver_signal(&mut h, NOW + 110, &prepared);
    let [(conn, at)] = dials(&actions)[..] else {
        panic!("one prepared dial");
    };
    assert_eq!(at, addr("203.0.113.5:49152"));
    h.session
        .handle(NOW + 120, Event::DialFailed(conn), &mut h.entropy);
    drain(&mut h.session);
    assert!(
        dials(&deliver_signal(&mut h, NOW + 125, &pending)).is_empty(),
        "late pending cannot reopen completion"
    );
    assert!(
        dials(&deliver_signal(&mut h, NOW + 126, &prepared)).is_empty(),
        "completion cannot replay a constructor"
    );
}

#[test]
fn a_superseding_manifest_retires_pending_dials_and_stale_completion_cannot_revive_them() {
    let (mut h, _, actions) = offered(vec![host4()], PunchState::None);
    let [(old, _)] = dials(&actions)[..] else {
        panic!("old dial");
    };
    let actions = deliver_signal(
        &mut h,
        NOW + 110,
        &manifest(
            2,
            vec![candidate(
                "203.0.113.5:49154",
                CandidateKind::Sip,
                CandidateScope::Public,
            )],
            CLIENT,
            PunchState::None,
        ),
    );
    assert!(actions.contains(&Action::Close { conn: old }));
    assert_eq!(dialed(&actions), [addr("203.0.113.5:49154")]);
    assert!(
        dials(&deliver_signal(
            &mut h,
            NOW + 120,
            &manifest(1, vec![srflx()], CLIENT, PunchState::None)
        ))
        .is_empty()
    );
    h.session
        .handle(NOW + 125, Event::Connected(old), &mut h.entropy);
    assert!(
        drain(&mut h.session).is_empty(),
        "old constructor cannot become the winner"
    );
}

#[test]
fn a_superseding_manifest_keeps_a_pending_dial_it_still_offers() {
    let (mut h, _, actions) = offered(vec![host4()], PunchState::None);
    let [(local, _)] = dials(&actions)[..] else {
        panic!("host4 dial");
    };
    let sip = candidate(
        "203.0.113.5:49154",
        CandidateKind::Sip,
        CandidateScope::Public,
    );
    let actions = deliver_signal(
        &mut h,
        NOW + 110,
        &manifest(2, vec![host4(), sip], CLIENT, PunchState::None),
    );
    assert!(
        !actions.contains(&Action::Close { conn: local }),
        "the same endpoint under the same certificate is the same attempt: {actions:?}"
    );
    assert_eq!(dialed(&actions), [addr("203.0.113.5:49154")]);
    h.session
        .handle(NOW + 125, Event::Connected(local), &mut h.entropy);
    h.session.handle_timeout(NOW + 400, &mut h.entropy);
    let finished = drain(&mut h.session);
    assert_eq!(
        upgrade_record(&finished, local),
        ClientSignal::WebtransportUpgradeInit(WebtransportUpgradeInit {
            browser_node_id: BROWSER_NODE_ID.into(),
        }),
        "the kept dial wins the race: {finished:?}"
    );
}

#[test]
fn an_old_punch_outcome_cannot_replace_the_current_generations_result() {
    let (mut harness, _, _) = offered(Vec::new(), PunchState::Pending);
    harness
        .session
        .on_direct_punch(NOW + 110, 2, PunchOutcome::Dispatched);
    drain(&mut harness.session);
    harness
        .session
        .on_direct_punch(NOW + 120, 1, PunchOutcome::Superseded);
    let actions = deliver_signal(
        &mut harness,
        NOW + 130,
        &manifest(2, vec![srflx()], CLIENT, PunchState::Pending),
    );
    assert_eq!(dialed(&actions), vec![addr(SRFLX)]);
}

#[test]
fn a_network_move_does_not_redial_helper_claims_prepared_for_the_previous_address() {
    let tftp = candidate(
        "203.0.113.5:45001",
        CandidateKind::Tftp,
        CandidateScope::Public,
    );
    let sip = candidate(
        "203.0.113.5:45002",
        CandidateKind::Sip,
        CandidateScope::Public,
    );
    let (mut harness, _, actions) = offered(vec![tftp.clone(), sip.clone()], PunchState::None);
    assert_eq!(dials(&actions).len(), 1);
    let moved = observed(&mut harness, NOW + 110, "198.51.100.8");
    assert!(
        dials(&moved).is_empty(),
        "old helper grants belong to the old public address"
    );
    let fresh = deliver_signal(
        &mut harness,
        NOW + 120,
        &manifest(2, vec![tftp, sip], "198.51.100.8", PunchState::None),
    );
    assert_eq!(dials(&fresh).len(), 1, "a matching fresh claim can race");
}

#[test]
fn ipv6_helpers_require_the_current_observed_family_and_exact_address() {
    for kind in [CandidateKind::Tftp, CandidateKind::Sip] {
        let (mut harness, _) = ready();
        let here = "2001:db8::7";
        observed(&mut harness, NOW + 40, here);
        let helper = candidate("[2001:db8::5]:45002", kind, CandidateScope::Public);
        let actions = deliver_signal(
            &mut harness,
            NOW + 100,
            &manifest(1, vec![helper.clone()], here, PunchState::None),
        );
        assert_eq!(dialed(&actions), [addr("[2001:db8::5]:45002")]);
        assert!(
            dials(&deliver_signal(
                &mut harness,
                NOW + 105,
                &manifest(1, vec![helper.clone()], here, PunchState::None)
            ))
            .is_empty()
        );
        let moved = observed(&mut harness, NOW + 110, "2001:db8::8");
        assert!(
            dials(&moved).is_empty(),
            "an old helper cannot serve a new address"
        );
        assert!(
            dials(&deliver_signal(
                &mut harness,
                NOW + 115,
                &manifest(2, vec![helper.clone()], here, PunchState::None)
            ))
            .is_empty()
        );
        let fresh = deliver_signal(
            &mut harness,
            NOW + 120,
            &manifest(3, vec![helper], "2001:db8::8", PunchState::None),
        );
        assert_eq!(dialed(&fresh), [addr("[2001:db8::5]:45002")]);
    }
}

#[test]
fn a_helper_of_the_other_family_does_not_spend_a_constructor() {
    for kind in [CandidateKind::Tftp, CandidateKind::Sip] {
        for (here, next, at) in [
            ("2001:db8::7", CLIENT, "203.0.113.5:45002"),
            (CLIENT, "2001:db8::7", "[2001:db8::5]:45002"),
        ] {
            let (mut harness, _) = ready();
            observed(&mut harness, NOW + 40, here);
            let helper = candidate(at, kind, CandidateScope::Public);
            let actions = deliver_signal(
                &mut harness,
                NOW + 100,
                &manifest(1, vec![helper.clone()], here, PunchState::None),
            );
            assert!(dials(&actions).is_empty(), "a helper belongs to one family");
            assert!(dials(&observed(&mut harness, NOW + 110, next)).is_empty());
            let fresh = deliver_signal(
                &mut harness,
                NOW + 120,
                &manifest(2, vec![helper], next, PunchState::None),
            );
            assert_eq!(dialed(&fresh), [addr(at)]);
        }
    }
}

#[test]
fn completed_router_preparation_retries_the_same_failed_tuple_once() {
    let endpoint = candidate(SRFLX, CandidateKind::Sip, CandidateScope::Public);
    let (mut harness, _) = ready();
    observed(&mut harness, NOW + 40, CLIENT);
    let mut pending = manifest(1, vec![endpoint.clone()], CLIENT, PunchState::None);
    if let DaemonSignal::WebtransportManifest {
        admission_pending, ..
    } = &mut pending
    {
        *admission_pending = true;
    }
    let actions = deliver_signal(&mut harness, NOW + 50, &pending);
    let [(first, _)] = dials(&actions)[..] else {
        panic!("one initial dial")
    };
    harness
        .session
        .handle(NOW + 100, Event::DialFailed(first), &mut harness.entropy);
    drain(&mut harness.session);
    let mut prepared = endpoint;
    prepared.admission = 41;
    let signal = manifest(1, vec![prepared], CLIENT, PunchState::None);
    let retried = deliver_signal(&mut harness, NOW + 110, &signal);
    let [(second, address)] = dials(&retried)[..] else {
        panic!("new allocation evidence rearms the same tuple")
    };
    assert_eq!(address, addr(SRFLX));
    assert_ne!(first, second);
    harness
        .session
        .handle(NOW + 120, Event::DialFailed(second), &mut harness.entropy);
    drain(&mut harness.session);
    assert!(dials(&deliver_signal(&mut harness, NOW + 130, &signal)).is_empty());
}

#[test]
fn completed_preparation_waits_for_the_same_tuples_native_outcome() {
    let endpoint = candidate(SRFLX, CandidateKind::Sip, CandidateScope::Public);
    let (mut harness, _, actions) = offered(vec![endpoint.clone(), host4()], PunchState::None);
    let [(first, _)] = dials(&actions)[..] else {
        panic!("initial dial")
    };
    harness
        .session
        .handle_timeout(NOW + 30, &mut harness.entropy);
    drain(&mut harness.session);
    let mut prepared = endpoint;
    prepared.admission = 42;
    let signal = manifest(2, vec![prepared, host4()], CLIENT, PunchState::None);
    assert!(dials(&deliver_signal(&mut harness, NOW + 40, &signal)).is_empty());
    harness
        .session
        .handle(NOW + 100, Event::DialFailed(first), &mut harness.entropy);
    let next = drain(&mut harness.session);
    let [(second, address)] = dials(&next)[..] else {
        panic!("prepared tuple need not wait for an unrelated pending handshake")
    };
    assert_ne!(first, second);
    assert_eq!(address, addr(SRFLX));
}

#[test]
fn a_prepared_tuple_supersedes_a_duplicate_hint_even_after_failure() {
    let hint = candidate(SRFLX, CandidateKind::Sip, CandidateScope::Public);
    let mut prepared = hint.clone();
    prepared.admission = 43;
    let (mut harness, _, actions) = offered(vec![hint, prepared.clone()], PunchState::None);
    let [(conn, _)] = dials(&actions)[..] else {
        panic!("one physical constructor")
    };
    assert!(
        actions
            .iter()
            .any(|action| matches!(action, Action::DialDirect { admission: 43, .. }))
    );
    harness
        .session
        .handle(NOW + 110, Event::DialFailed(conn), &mut harness.entropy);
    assert!(
        dials(&drain(&mut harness.session)).is_empty(),
        "the older hint cannot rearm the failed preparation"
    );
    let next = manifest(2, vec![prepared], CLIENT, PunchState::None);
    assert!(dials(&deliver_signal(&mut harness, NOW + 120, &next)).is_empty());
}
